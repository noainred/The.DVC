/**
 * dirusage/scheduler.js — 폴더 사용량 스캔 주기 실행 + 메일 발송 (v2.454).
 *
 * 흐름: 주기 도래 판정 → RMA 잡(`du-top`) 큐에 등록 → 엣지가 롱폴로 가져가 실행 → 결과 수거
 *       → 파싱·Top-N 산출 → DB 저장 → (설정 시) 메일 발송.
 *
 * RMA 잡큐를 그대로 쓰는 이유: 개별 토큰 바인딩·서명·인스턴스 배정·오프라인 페일오버가 이미 있다.
 * 새 채널을 파면 그 보안 경계를 처음부터 다시 만들어야 한다.
 *
 * 저장소 규칙(되돌리지 말 것):
 *  - **재진입 가드** — 이전 틱이 끝나기 전에 다음 틱이 겹치지 않게 한다(CLAUDE.md 폴러 규칙).
 *    수동 실행 API 도 같은 가드를 공유한다(net/monitor.runMonitorNow 패턴).
 *  - 설정은 **매 틱 다시 읽는다** — 모듈 로드 시 상수로 굳히면 설정 변경이 재시작해야 먹는다.
 *  - du 는 최대 15분이 걸릴 수 있어 결과를 **다음 틱들에서 수거**한다(한 틱을 붙잡지 않는다).
 *    잡 결과 보존은 RMA 의 DONE_TTL(30분)이므로 그 안에 반드시 가져와야 한다.
 */
import { enqueueJob, getJob, onlineInstances, DONE_TTL } from '../rma/jobs.js';
import { signJob } from '../rma/signing.js';
import { rmaPasswordFor } from '../rma/agentSecrets.js';
import { load as loadSettings } from './settings.js';
import { parseDuOutput, buildScanRecord } from './scan.js';
import { renderReport, renderSubject } from './report.js';
import { getDb } from './db.js';
import { clampIntervalMs } from '../config.js';
import { sendPortalMail } from '../mail/service.js';   // 공용 메일 발송(설정 › 메일 발송)

/** 틱 주기 — 주기 자체는 시간 단위라 1분 간격으로 도래만 확인하면 충분하다. */
// v2.606 LEFT2606-04: 2^31 초과면 setInterval 이 1ms 루프가 됐다 — clampIntervalMs 로 [30초, MAX_TIMER_MS].
const TICK_MS = clampIntervalMs(Number(process.env.DIRUSAGE_TICK_MS) || 60_000, 60_000, 30_000);
/** 잡 타임아웃(엣지가 이 안에 회신해야 한다). du 는 대용량에서 느리다. */
const JOB_TIMEOUT_MS = Math.max(60_000, Number(process.env.DIRUSAGE_JOB_TIMEOUT_MS) || 900_000);

let timer = null;
let running = false;                 // ★ 재진입 가드 — 수동 실행과 공유한다
const pending = new Map();           // targetId -> { reqId, agent, root, topN, at }
const lastRunAt = new Map();         // targetId -> ms (프로세스 메모리; 재시작하면 DB 의 마지막 스캔으로 복원)
let lastTickAt = 0;
let lastError = null;
const recent = [];                   // 최근 활동 로그(메모리, 최신 우선)

/**
 * 잡 등록 — 서명은 routes/api/rma.js 와 **같은 규약**으로 붙인다(법인 비밀번호가 있으면 HMAC).
 * 비밀번호 자체는 선로에 싣지 않는다(서명만) — server/CLAUDE.md RMA 불변조건.
 */
function enqueueScan(t, label, now) {
  const issuedAt = Date.now();
  const secret = rmaPasswordFor(t.agent);
  const spec = { cmd: 'du-top', args: { path: t.path }, timeoutMs: JOB_TIMEOUT_MS, label, issuedAt };
  return enqueueJob(t.agent, spec, {
    user: 'system:dirusage', timeoutMs: JOB_TIMEOUT_MS, instance: t.instance || '', now,
    sign: secret ? (reqId) => signJob(secret, { reqId, agent: t.agent, cmd: spec.cmd, args: spec.args, timeoutMs: spec.timeoutMs, issuedAt }) : null,
  });
}

function note(level, msg) {
  recent.unshift({ at: Date.now(), level, msg: String(msg).slice(0, 300) });
  if (recent.length > 100) recent.pop();
  if (level === 'error') console.warn(`[dirusage] ${msg}`);
}

/**
 * 이 대상이 지금 실행되어야 하는가 (순수 — 테스트로 고정).
 * @param {object} t 대상 설정
 * @param {number|null} lastAt 마지막 실행 시각(ms) — 없으면 '한 번도 안 함'
 * @param {number} now
 */
export function isDue(t, lastAt, now = Date.now()) {
  if (!t || t.enabled === false) return false;
  const iv = Math.max(1, Number(t.intervalHours) || 24) * 3600_000;
  if (!lastAt) return true;                       // 첫 실행은 즉시
  return now - lastAt >= iv;
}

/** 직전 스캔과 Top 목록이 실질적으로 같은가 — `onlyOnChange` 판정(순수). */
export function sameTop(a, b) {
  const ea = a?.entries || [];
  const eb = b?.entries || [];
  if (ea.length !== eb.length) return false;
  for (let i = 0; i < ea.length; i++) {
    if (ea[i].name !== eb[i].name || ea[i].bytes !== eb[i].bytes) return false;
  }
  return true;
}

/** 대상의 마지막 실행 시각 — 메모리에 없으면 DB 의 마지막 스캔으로 복원(재시작 후 폭주 방지). */
async function lastRunOf(targetId) {
  if (lastRunAt.has(targetId)) return lastRunAt.get(targetId);
  const db = await getDb();
  const last = db?.last(targetId) || null;
  const ts = last?.ts || null;
  lastRunAt.set(targetId, ts);
  return ts;
}

/** 대기 중인 잡의 결과를 수거한다. 완료된 것만 처리하고 미완은 다음 틱으로 넘긴다. */
async function collectPending(cfg, now) {
  for (const [targetId, p] of [...pending]) {
    const j = getJob(p.reqId);
    if (j.state === 'pending' || j.state === 'running') {
      // 잡이 DONE_TTL 안에 안 끝나면 포기한다 — 안 그러면 pending 이 영원히 남아 다음 주기가 막힌다.
      if (now - p.at > JOB_TIMEOUT_MS + DONE_TTL) {
        pending.delete(targetId);
        lastRunAt.set(targetId, now);   // 다음 주기까지 쉰다(같은 대상에 잡을 쌓지 않는다)
        note('error', `${p.root}: 엣지가 시간 안에 회신하지 않아 이번 회차를 건너뜁니다(RMA 폴링 상태 확인).`);
      }
      continue;
    }
    pending.delete(targetId);
    if (j.state !== 'done') {
      note('error', `${p.root}: 잡 상태를 확인할 수 없습니다(${j.state}) — 결과 보존 시간이 지났을 수 있습니다.`);
      continue;
    }
    const r = j.result || {};
    if (!r.ok) {
      note('error', `${p.root}: 스캔 실패 — ${r.reason || `종료코드 ${r.exitCode}`}`);
      continue;
    }
    try {
      await ingest(cfg, targetId, p, r.stdout || r.output || '', now);
    } catch (e) {
      note('error', `${p.root}: 결과 처리 실패 — ${e.message}`);
    }
  }
}

/** 표준출력을 파싱해 저장하고 필요하면 메일을 보낸다. */
async function ingest(cfg, targetId, p, stdout, now) {
  const parsed = parseDuOutput(stdout, p.root);
  if (!parsed.entries.length && parsed.totalBytes == null) {
    note('error', `${p.root}: du 출력을 해석하지 못했습니다(빈 결과) — 경로·권한을 확인하세요.`);
    return;
  }
  const rec = buildScanRecord({ targetId, root: p.root, agent: p.agent, ts: now, parsed, topN: p.topN });
  const db = await getDb();
  if (!db) { note('error', '이력 DB 를 열 수 없어 저장하지 못했습니다(node:sqlite).'); return; }
  const prev = db.last(targetId);           // 저장 **전** 마지막 = 직전 회차
  const id = db.insertScan(rec);
  note('info', `${p.root}: 하위 폴더 ${rec.count}개 · 전체 ${rec.totalBytes ?? rec.sumBytes} bytes 수집`);

  const mail = cfg.mail || {};
  if (!mail.enabled) return;
  if (mail.onlyOnChange && prev && sameTop(rec, prev)) {
    db.markMailed(id, 0, '직전과 동일해 발송 생략(변경 시에만 발송)');
    return;
  }
  const { html, text } = renderReport(rec, prev);
  const subject = renderSubject(mail.subject, { root: rec.root, agent: rec.agent, ts: rec.ts, topN: rec.entries.length });
  // sendPortalMail 은 throw 하지 않는다 — 수신자·SMTP 미설정은 skipped 로, 실제 실패만 failed 로 온다.
  // 수신자를 비워 두면 공용 설정(설정 › 메일 발송)의 종류별/기본 수신자로 간다.
  const res = await sendPortalMail({
    kind: 'dirusage', subject, html, text,
    to: (mail.to || []).length ? mail.to : null,
    cc: (mail.cc || []).length ? mail.cc : null,
  });
  if (res.ok) {
    db.markMailed(id, 1, `${res.accepted.length}명 수신`);
    note('info', `${p.root}: 메일 발송 완료(${res.accepted.length}명)`);
  } else if (res.skipped) {
    db.markMailed(id, 0, res.reason);
    note('info', `${p.root}: 메일 미발송 — ${res.reason}`);
  } else {
    db.markMailed(id, 2, res.reason);
    note('error', `${p.root}: 메일 발송 실패 — ${res.reason}`);
  }
}

/** 주기가 된 대상에 잡을 건다. */
async function dispatchDue(cfg, now) {
  for (const t of cfg.targets || []) {
    if (pending.has(t.id)) continue;                       // 이미 진행 중
    const last = await lastRunOf(t.id);
    if (!isDue(t, last, now)) continue;
    if (!onlineInstances(t.agent, now).length) {
      note('error', `${t.path}: 엣지 '${t.agent}' 의 RMA 가 온라인이 아닙니다 — 이번 회차를 건너뜁니다.`);
      lastRunAt.set(t.id, now);                            // 오프라인 대상에 잡을 쌓지 않는다
      continue;
    }
    try {
      const { reqId } = enqueueScan(t, '폴더 사용량 스캔', now);
      pending.set(t.id, { reqId, agent: t.agent, root: t.path, topN: t.topN, at: now });
      lastRunAt.set(t.id, now);
      note('info', `${t.path}: 스캔 요청(엣지 ${t.agent})`);
    } catch (e) {
      note('error', `${t.path}: 잡 등록 실패 — ${e.message}`);
    }
  }
}

/** 한 틱. 재진입 가드는 호출부(tick/runNow)가 공유한다. */
async function tickOnce() {
  const cfg = loadSettings();                  // ★ 매 틱 조회 — 설정 변경 즉시 반영
  const now = Date.now();
  lastTickAt = now;
  await collectPending(cfg, now);              // 결과 수거를 먼저 — 같은 틱에 다음 잡을 걸 수 있다
  if (cfg.enabled) await dispatchDue(cfg, now);
  // 이력 prune(설정 보존일). 청크 삭제라 이벤트 루프를 막지 않는다.
  if (now % (6 * 3600_000) < TICK_MS) {
    const db = await getDb();
    if (db) await db.prune(now - Math.max(1, cfg.retentionDays || 365) * 86_400_000).catch(() => {});
  }
}

/** 폴러 진입점 — 재진입 가드. 진행 중이면 이번 틱을 건너뛴다. */
async function tick() {
  if (running) return;
  running = true;
  try { await tickOnce(); } catch (e) { lastError = e.message; note('error', `틱 실패: ${e.message}`); }
  finally { running = false; }
}

/**
 * 수동 실행 — 특정 대상(또는 전체)을 지금 스캔한다.
 * 폴러와 **같은 가드를 공유**한다(동시 실행 금지 — CLAUDE.md 규칙).
 */
export async function runNow(targetId = '') {
  if (running) return { ok: false, reason: '이미 실행 중입니다 — 잠시 후 다시 시도하세요.' };
  running = true;
  try {
    const cfg = loadSettings();
    const now = Date.now();
    const targets = (cfg.targets || []).filter((t) => (!targetId || t.id === targetId) && t.enabled !== false);
    if (!targets.length) return { ok: false, reason: '실행할 대상이 없습니다(비활성이거나 존재하지 않음).' };
    await collectPending(cfg, now);
    const queued = [];
    for (const t of targets) {
      if (pending.has(t.id)) { queued.push({ id: t.id, path: t.path, state: '이미 진행 중' }); continue; }
      if (!onlineInstances(t.agent, now).length) { queued.push({ id: t.id, path: t.path, state: `엣지 '${t.agent}' 오프라인` }); continue; }
      try {
        const { reqId } = enqueueScan(t, '폴더 사용량 스캔(수동)', now);
        pending.set(t.id, { reqId, agent: t.agent, root: t.path, topN: t.topN, at: now });
        lastRunAt.set(t.id, now);
        queued.push({ id: t.id, path: t.path, state: '요청됨', reqId });
      } catch (e) {
        queued.push({ id: t.id, path: t.path, state: `실패: ${e.message}` });
      }
    }
    return { ok: true, queued, note: 'du 는 대용량에서 수 분이 걸립니다. 결과는 완료되는 대로 이 화면에 나타납니다.' };
  } finally { running = false; }
}

export function schedulerStatus() {
  const cfg = loadSettings();
  return {
    enabled: !!cfg.enabled,
    running,
    lastTickAt,
    lastError,
    pending: [...pending].map(([id, p]) => ({ targetId: id, root: p.root, agent: p.agent, since: p.at })),
    recent: recent.slice(0, 30),
    tickMs: TICK_MS,
    jobTimeoutMs: JOB_TIMEOUT_MS,
  };
}

export function startDirUsageScheduler() {
  if (timer) return;
  // setInterval 은 콜백이 늦어도 겹쳐 부르므로 위 재진입 가드가 반드시 필요하다.
  timer = setInterval(() => { tick(); }, TICK_MS);
  timer.unref?.();
  console.log(`[dirusage] 폴더 사용량 스케줄러 시작 (틱 ${Math.round(TICK_MS / 1000)}초)`);
}

export function _resetDirUsage() { pending.clear(); lastRunAt.clear(); recent.length = 0; running = false; }
