/**
 * central/tokenApplyJob.js — 엣지 **개별 central 토큰 자동 적용** 작업(v2.776 — 사용자 요청 "이걸 자동으로 수정하는 기능 만들어줘,
 *   진행할 때 세부 진행 내용 보여주는 화면과 로그 저장 기능"). 실서버 사례: 엣지 AZ-IRS 가 공유 토큰이라 Veeam 위임(veeam-config)이 403.
 *
 * 단계(작업 기록 steps 에 그대로 남는다):
 *  1 사전 점검     — 수집 서버 등록·수집 토큰·이미 개별 토큰이 있는지(있으면 멈춘다 — 다시 발급하면 기존 토큰이 즉시 폐기된다)
 *  2 개별 토큰 발급 — agentTokens.issueAgentToken(평문은 이 작업의 메모리에만 — 기록에는 지문만)
 *  3 엣지에 전달(수집 토큰 통로) — POST <엣지>/api/collector/central-token. 엣지가 기록·메모리 반영 후 새 토큰으로 중앙을 확인한다
 *    (실패면 엣지가 스스로 되돌린다 — agent/centralTokenApply.js)
 *  4 엣지에 전달(SSH 통로) — 3이 안 될 때만(옛 판 엣지 404·접속 실패·엣지가 파일을 못 씀·수집 토큰 불일치). 배포 기록의 SSH 계정으로
 *    portal.env 를 고치고 재시작(사본 → 실패면 되돌림 — agent/deploy.js forceAgentCentralToken)
 *  5 중앙에서 확인 — 그 토큰이 실제로 쓰였는가(agentTokens lastUsedAt ≥ 발급 시각)
 *  6 배포 기록 맞춤 — 배포 기록(agent-deploy-targets.json)의 central 토큰을 새 값으로, 수집 토큰을 등록값으로(다시 배포해도 되돌아가지 않게)
 *  7 정리          — 엣지가 새 토큰을 **확실히 쓰지 않을 때만** 발급을 취소(공유 토큰 상태로 원복). 쓰고 있을 수 있으면 취소하지 않고 그 사실을 남긴다.
 * ⚠ 토큰 평문은 기록·응답·콘솔·감사 어디에도 싣지 않는다(tokenFingerprintParts.short 만).
 * ⚠ 엣지 확인(3)이 '중앙이 새 토큰을 거절' 로 끝나면 SSH 로 넘어가지 않는다 — 같은 엣지→중앙 경로라 결과가 같다.
 *
 * v2.826(실서버 agent-WA · 엣지 판 2.775.0 — '엣지 응답 HTTP 401' 로 실패):
 *  · 옛 판 엣지에는 `/api/collector/central-token` 이 없어 요청이 `/api` 로그인 인증으로 떨어져 **401** 이 온다(404 가 아니다). 401 도
 *    '엣지에 이 기능이 없음' 으로 읽고(확정 — 엣지는 아무것도 받지 않았다) 발급을 취소한다.
 *  · 사전 점검이 엣지 판을 **다시 당겨**(refreshStatus — pull 상태가 오래됐을 수 있다) 2.776.0 미만이면 그 사실을 말하고, 전달할 통로
 *    (SSH 배포 기록)도 없으면 **발급하지 않고** 멈춘다(발급→취소 공회전 없음) · 기록에 `hint:'upgrade'` 를 남겨 화면이 다음 수단을 단다.
 *  · 옵션 `upgradeFirst`(화면 '엣지 업그레이드 뒤 자동 적용'): 판이 낮으면 **0 엣지 업그레이드** 단계 — 중앙 번들을 그 엣지에 push 하고
 *    (collector/upgradePush — 수집 토큰 통로, 옛 판에도 있다) 엣지가 2.776.0 이상으로 다시 올라올 때까지 기다린 뒤 발급한다.
 *    엣지 포탈이 재시작되므로 사용자가 고른 때만 한다. 판이 이미 충분하면 건너뛴다. 번들이 없거나 push 가 실패하면 발급 전에 멈춘다.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';
import { tokenFingerprintParts, sameToken } from '../util/tokenFingerprint.js';
import { cmpVersion } from '../util/cmpVersion.js';
import { capStr } from '../util/capStr.js';
import { sameHostName } from '../util/sameHostName.js';

export const LOG_FILE_NAME = 'edge-token-apply-log.json';
registerStateFile(LOG_FILE_NAME);
const KEEP = 50;
export const MIN_EDGE_API_VERSION = '2.776.0';
export const VERIFY_WAIT_MS = 180_000;
/** 엣지 업그레이드 뒤 새 판으로 다시 올라올 때까지 기다리는 상한(엣지 재시작 + 중앙 pull 반영). */
export const UPGRADE_WAIT_MS = 300_000;
const UPGRADE_POLL_MS = 10_000;
const DETAIL_MAX = 400;

export const STEP_LABEL = Object.freeze({
  precheck: '사전 점검', upgrade: '엣지 업그레이드', issue: '개별 토큰 발급', 'edge-api': '엣지에 전달(수집 토큰 통로)', ssh: '엣지에 전달(SSH 통로)',
  verify: '중앙에서 확인', 'deploy-record': '배포 기록 맞춤', cleanup: '정리',
});

const logFile = () => path.join(config.configDir, LOG_FILE_NAME);
let _jobs = null;          // 최신이 앞
const _running = new Map(); // agent(lower) → jobId

function loadJobs() {
  if (_jobs) return _jobs;
  const f = logFile();
  _jobs = [];
  try {
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      _jobs = Array.isArray(j?.jobs) ? j.jobs.filter((x) => x && typeof x === 'object').slice(0, KEEP) : [];
    }
  } catch { preserveCorrupt(f); _jobs = []; }
  // 포탈이 진행 중에 멈췄던 작업 — '진행 중' 으로 영원히 남기지 않는다
  for (const j of _jobs) if (j.state === 'running') { j.state = 'failed'; j.endedAt = j.endedAt || Date.now(); j.summary = '포탈이 다시 시작돼 작업이 중단됐습니다 — 엣지 상태를 확인한 뒤 다시 실행하세요.'; }
  return _jobs;
}
function saveJobs() {
  try { atomicWriteFileSync(logFile(), JSON.stringify({ jobs: loadJobs().slice(0, KEEP) }, null, 2), { mode: 0o600 }); }
  catch (e) { console.warn(`[token-apply] 작업 기록을 저장하지 못했습니다(작업은 계속): ${String(e?.message || e).slice(0, 160)}`); }
}
// 상주 기록 글자는 capStr(평탄화 — 원문을 붙잡지 않는다 · audit2607b TIM2607-01). 오류 객체는 message 만.
const cut = (v) => capStr((typeof v === 'string' ? v : (v instanceof Error ? v.message : (v == null ? '' : `${v}`))).replace(/[\r\n]+/g, ' '), DETAIL_MAX);

/** 화면용 사본(그대로 — 기록에는 비밀이 없다). agent 를 주면 그 엣지 것만. */
export function listJobs({ agent = '', limit = 20 } = {}) {
  const want = String(agent || '').toLowerCase();
  const mine = loadJobs().filter((j) => !want || `${j.agent}`.toLowerCase() === want);
  const n = Math.max(1, Math.min(KEEP, limit));
  return mine.slice(0, n).map((j) => structuredClone(j));
}
export function getJob(id) { const j = loadJobs().find((x) => x.id === id); return j ? structuredClone(j) : null; }
export function runningJobFor(agent) { return _running.get(String(agent || '').toLowerCase()) || null; }

/**
 * 시작 — 검증 가능한 실패(사전 점검)도 기록을 남긴다. 작업은 백그라운드로 돌고 즉시 기록을 돌려준다.
 * @param {string} agent
 * @param {{ by?:string, deps:object, wait?:boolean, upgradeFirst?:boolean }} o  deps: issue·revoke·listTokens·tokensLoadError·findCollector·statusOf·deployTargets·saveTarget·pushEdge·sshApply·sleep·now
 *   · refreshStatus(name)(선택 — 그 엣지만 즉시 pull) · upgradeEdge(col)(선택 — 중앙 번들 push, `{ok, version, reason}`)
 *   · upgradeFirst: 엣지 판이 낮으면 먼저 업그레이드한다(엣지 재시작 — 사용자가 고른 때만)
 * @returns {{ ok:boolean, job?:object, reason?:string }}
 */
export function startTokenApply(agent, { by = '', deps, wait = false, upgradeFirst = false } = {}) {
  const name = String(agent || '').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) return { ok: false, reason: '엣지 이름 형식이 올바르지 않습니다.' };
  if (_running.has(name.toLowerCase())) return { ok: false, reason: '이 엣지에 이미 진행 중인 작업이 있습니다.', jobId: _running.get(name.toLowerCase()) };
  const now = deps.now ? deps.now() : Date.now();
  // v2.826: edgeVersion = 사전 점검 때(다시 당긴) 엣지 판 · hint = 실패 뒤 화면이 달 다음 수단('upgrade' — 엣지 업그레이드 뒤 적용) · upgradeFirst = 요청 옵션
  const job = { id: `tok_${now.toString(36)}_${crypto.randomBytes(3).toString('hex')}`, agent: name, by: capStr(cut(by), 64), startedAt: now, endedAt: null, state: 'running', path: null, fp: '', edgeHost: '', edgeVersion: '', hint: '', upgradeFirst: upgradeFirst === true, summary: '', steps: [] };
  loadJobs().unshift(job);
  if (_jobs.length > KEEP) _jobs.length = KEEP;
  _running.set(name.toLowerCase(), job.id);
  saveJobs();
  const p = runJob(job, deps, { upgradeFirst: upgradeFirst === true }).catch((e) => finish(job, 'failed', `예상하지 못한 오류로 멈췄습니다: ${cut(e?.message || e)}`, deps))
    .finally(() => { _running.delete(name.toLowerCase()); });
  if (wait) return p.then(() => ({ ok: true, job: getJob(job.id) }));
  return { ok: true, job: structuredClone(job) };
}

function stepStart(job, key, deps) {
  const s = { key, label: STEP_LABEL[key] || key, state: 'running', at: deps.now ? deps.now() : Date.now(), endAt: null, detail: '' };
  job.steps.push(s); saveJobs();
  return s;
}
function stepEnd(s, state, detail, deps) { s.state = state; s.detail = cut(detail); s.endAt = deps.now ? deps.now() : Date.now(); saveJobs(); }
function finish(job, state, summary, deps) {
  job.state = state; job.summary = cut(summary); job.endedAt = deps.now ? deps.now() : Date.now();
  saveJobs();
  console.log(`[token-apply] ${job.agent} — ${state === 'ok' ? '완료' : state === 'warn' ? '완료(확인 필요)' : '실패'}: ${job.summary}`);
}

/** 이 엣지 이름의 토큰 항목(대소문자 무시). */
const tokenOf = (deps, name) => (deps.listTokens() || []).find((t) => String(t.agent || '').toLowerCase() === name.toLowerCase()) || null;
/**
 * 반증 F4: '중앙이 그 엣지의 요청을 **받아들였는가**'. lastUsedAt 은 이름 바인딩 검사 **전에** 찍혀(resolveAgentByToken) 이름이 달라 403 인
 *   요청도 '사용' 으로 보였다. 받아들인 GET 은 pullStats 에 남는다 — 그것을 본다(없으면 lastUsedAt 로 폴백).
 * v2.781(점검 G2 A-B1): 행의 `verified`(한 번 켜지면 영구)와 엔드포인트 `lastOkAt`(같은 이름의 **공유 토큰** pull 도 올린다)을 합쳐 읽지 않는다 —
 *   그러면 앞서 개별 토큰 요청이 한 번 성공한 이름은 이후 공유 pull 하나로 '받아들임' 이 됐다(결과 모르는 push 실패를 '적용됨' 으로 · 회수 누락).
 *   **그 요청이** 개별 토큰으로 검증되고 성공한 시각(`lastVerifiedOkAt`)만 본다. 필드가 없는 행(옛 형태·가짜 행)은 0 — '받아들이지 않음'.
 */
function acceptedSince(deps, name, since) {
  if (typeof deps.pullStats === 'function') {
    // 행 키는 대소문자를 가린다(공유 pull 이 주장한 'az-irs' 와 개별 토큰의 'AZ-IRS' 가 따로 있을 수 있다) — 같은 이름 행 전부의 최댓값.
    let okAt = 0;
    for (const r of ((deps.pullStats() || {}).rows || [])) {
      if (!r || String(r.agent || '').toLowerCase() !== name.toLowerCase()) continue;
      const v = Number(r.lastVerifiedOkAt);
      if (Number.isFinite(v) && v > okAt) okAt = v;
    }
    return okAt && okAt >= since ? okAt : null;
  }
  const t = tokenOf(deps, name);
  return t && Number(t.lastUsedAt) >= since ? Number(t.lastUsedAt) : null;
}
const audit = (deps, action, job, detail) => { try { if (deps.audit) deps.audit({ action, target: job.agent, detail: `작업 ${job.id}${detail ? ` · ${detail}` : ''}` }); } catch { /* 감사 실패는 작업을 멈추지 않는다 */ } };

/** 엣지 판이 수집 토큰 통로(MIN_EDGE_API_VERSION) 이상인가 — 모르면 null(낮다고 보지 않는다). */
export function edgeApiVersionState(ver) {
  const c = cmpVersion(ver, MIN_EDGE_API_VERSION);
  return c == null ? null : c >= 0;
}
/** 그 엣지만 즉시 pull(있으면) — 실패·없음은 조용히(이전 상태로 판단한다). */
async function refreshEdge(deps, name) {
  if (typeof deps.refreshStatus !== 'function') return false;
  try { return (await deps.refreshStatus(name)) === true; } catch { return false; }
}
const nowOf = (deps) => (deps.now ? deps.now() : Date.now());
const sleepOf = (deps, ms) => (deps.sleep ? deps.sleep(ms) : new Promise((ok) => setTimeout(ok, ms)));

async function runJob(job, deps, { upgradeFirst = false } = {}) {
  const name = job.agent;
  /* 1 사전 점검 */
  let s = stepStart(job, 'precheck', deps);
  if (deps.tokensLoadError && deps.tokensLoadError()) { stepEnd(s, 'bad', '중앙 개별 토큰 파일을 읽지 못했습니다 — 발급하지 않습니다.', deps); return finish(job, 'failed', '중앙 개별 토큰 파일을 읽지 못했습니다.', deps); }
  const found = deps.findCollector(name);   // 수집 서버 이름 조회는 registry.findCollectorByName 하나(audit2613c EDGE2613-08)
  const col = found && found.enabled !== false ? found : null;
  if (!col || !col.url) { stepEnd(s, 'bad', `수집 서버 등록부에 켜진 '${name}' 이 없습니다.`, deps); return finish(job, 'failed', '수집 서버 등록이 없습니다.', deps); }
  const existing = tokenOf(deps, name);
  if (existing) {
    const unused = !(Number(existing.lastUsedAt) > 0);
    stepEnd(s, 'bad', unused
      ? '이미 발급됐지만 한 번도 쓰이지 않은 개별 토큰이 있습니다(이전 작업이 중단됐을 수 있습니다) — 설정 › 수집 서버의 엣지별 개별 central 토큰에서 회수한 뒤 다시 실행하세요.'
      : '이미 개별 토큰이 발급돼 있습니다 — 다시 발급하면 엣지가 쓰는 기존 토큰이 즉시 폐기되므로 자동 적용은 공유 토큰 엣지만 합니다.', deps);
    return finish(job, 'failed', '이미 개별 토큰이 있습니다.', deps);
  }
  // v2.826: pull 상태의 엣지 판은 마지막 주기 것이다 — 판이 낮게 보이면 그 엣지만 다시 당겨 확인한다(업그레이드 직후·오래된 상태로 잘못 안내하지 않게).
  let st = deps.statusOf(col.id) || {};
  let ver = typeof st.version === 'string' ? st.version : '';
  let refreshed = false;
  if (edgeApiVersionState(ver) !== true) {
    refreshed = await refreshEdge(deps, name);
    st = deps.statusOf(col.id) || {};
    ver = typeof st.version === 'string' ? st.version : '';
  }
  job.edgeVersion = capStr(ver, 32);
  // 반증 F4: 엣지가 보고한 이름(AGENT_NAME — pull 응답)이 발급할 이름과 다르면 중앙은 그 토큰의 요청을 403 으로 막는다 — 발급하지 않는다.
  const reported = typeof st.agent === 'string' ? st.agent.trim() : '';
  // v2.777(사용자 요청 '엣지에서 보고하는 호스트네임을 기록해서 검증'): pull 로 받은 엣지의 호스트 이름을 작업 기록에 남기고, 토큰을 받은 장비(수집 토큰 통로 응답·SSH 접속)와 대조한다.
  const reportedHost = typeof st.hostname === 'string' ? capStr(st.hostname.trim(), 128) : '';
  job.edgeHost = reportedHost;
  if (reported && reported.toLowerCase() !== name.toLowerCase()) {
    stepEnd(s, 'bad', `이 수집 서버가 보고한 엣지 이름은 '${reported}' 입니다 — '${name}' 으로 발급하면 중앙이 그 엣지의 요청을 이름 불일치로 막습니다. Veeam 서버의 읽는 곳(또는 엣지 AGENT_NAME)을 맞춘 뒤 다시 실행하세요.`, deps);
    return finish(job, 'failed', '엣지 이름이 다릅니다.', deps);
  }
  const targets = (deps.deployTargets() || []).filter((t) => String(t.agentName || '').toLowerCase() === name.toLowerCase());
  const target = targets.length === 1 ? targets[0] : null;
  let verState = edgeApiVersionState(ver);   // true 충분 · false 낮음 · null 모름
  let edgeNew = verState === true;
  const verText = () => `엣지 판 ${ver || '모름'}${verState === false ? `(수집 토큰 통로는 ${MIN_EDGE_API_VERSION} 이상 — 이 판에는 없습니다${refreshed ? ' · 방금 다시 당겨 확인' : ''})` : verState === null ? '(판을 몰라 통로를 직접 시도합니다)' : ''}`;
  const targetText = targets.length ? (target ? '있음(SSH 통로 가능)' : `${targets.length}개 — 어느 것인지 몰라 SSH 통로를 쓰지 않습니다`) : '없음(SSH 통로 불가)';
  const canUpgrade = typeof deps.upgradeEdge === 'function';
  // 판이 낮고 SSH 통로도 없고 업그레이드도 고르지 않았으면 토큰을 전달할 길이 없다 — 발급하지 않는다(발급→취소 공회전·기록 오염 없음).
  if (verState === false && !target && !upgradeFirst) {
    job.hint = canUpgrade ? 'upgrade' : '';
    stepEnd(s, 'bad', `수집 서버 ${col.url} · ${verText()}${reported ? ` · 보고 이름 ${reported}` : ''} · 보고 호스트 ${reportedHost || '모름'} · 배포 기록 ${targetText} — 토큰을 전달할 통로가 없어 발급하지 않았습니다.`, deps);
    return finish(job, 'failed', `엣지 판 ${ver} 에는 수집 토큰 통로(${MIN_EDGE_API_VERSION} 이상)가 없고 배포 기록(SSH 계정)도 없어 토큰을 전달할 수 없습니다(발급하지 않음). `
      + (canUpgrade ? `'엣지 업그레이드 뒤 자동 적용' 으로 엣지를 중앙 판으로 올린 뒤 적용하거나(엣지 포탈이 재시작됩니다), ` : '엣지를 먼저 업그레이드하거나(설정 › 수집 서버 › 업그레이드), ')
      + '설정 › 수집 서버 › 원격 법인(DC)에 Edge 노드 포탈 설치에 이 엣지를 등록해 SSH 통로를 여세요.', deps);
  }
  stepEnd(s, 'ok', `수집 서버 ${col.url} · ${verText()}${reported ? ` · 보고 이름 ${reported}` : ''} · 보고 호스트 ${reportedHost || '모름(이름으로만 확인)'} · 배포 기록 ${targetText}`, deps);

  /* 0 엣지 업그레이드(옵션 — 판이 낮을 때만) */
  if (upgradeFirst) {
    s = stepStart(job, 'upgrade', deps);
    if (verState === true) stepEnd(s, 'skip', `엣지 판 ${ver} 은 이미 ${MIN_EDGE_API_VERSION} 이상입니다 — 업그레이드하지 않습니다.`, deps);
    else if (verState === null) stepEnd(s, 'warn', '엣지 판을 몰라(pull 상태 없음) 업그레이드하지 않고 전달을 시도합니다 — 판이 낮으면 아래 단계가 그 사실을 말합니다.', deps);
    else if (!canUpgrade) { stepEnd(s, 'bad', '이 중앙에는 엣지 업그레이드 push 가 연결돼 있지 않습니다.', deps); return finish(job, 'failed', '엣지 업그레이드를 할 수 없습니다(발급하지 않음).', deps); }
    else {
      const sub = [];
      let up = null;
      try { up = await deps.upgradeEdge(col); } catch (e) { up = { ok: false, reason: cut(e) }; }
      if (!up || !up.ok) {
        stepEnd(s, 'bad', `번들 push 실패: ${up?.reason || '사유 미상'}`, deps);
        audit(deps, '엣지 개별 central 토큰 자동 적용 실패', job, '엣지 업그레이드 push 실패');
        return finish(job, 'failed', `엣지 업그레이드 번들을 보내지 못했습니다(${up?.reason || '사유 미상'}) — 토큰은 발급하지 않았습니다. 설정 › 수집 서버 › 업그레이드에서 번들·수집 토큰을 확인하세요.`, deps);
      }
      sub.push(`✓ 번들 v${up.version || '?'} 전달 — 엣지가 설치·재시작합니다`);
      audit(deps, '엣지 업그레이드 push(개별 토큰 자동 적용)', job, `v${up.version || '?'}`);
      // 엣지가 새 판으로 다시 올라올 때까지(그 엣지만 즉시 pull + 주기 pull 반영) — 상한 UPGRADE_WAIT_MS
      const deadline = nowOf(deps) + (deps.upgradeWaitMs ?? UPGRADE_WAIT_MS);
      let polls = 0;
      for (;;) {
        await sleepOf(deps, deps.upgradePollMs ?? UPGRADE_POLL_MS);
        polls += 1;
        await refreshEdge(deps, name);
        st = deps.statusOf(col.id) || {};
        ver = typeof st.version === 'string' ? st.version : '';
        verState = edgeApiVersionState(ver);
        const reached = verState === true && (!up.version || (cmpVersion(ver, up.version) ?? 1) >= 0);
        if (reached || nowOf(deps) >= deadline) break;
      }
      job.edgeVersion = capStr(ver, 32);
      edgeNew = verState === true;
      if (!edgeNew) {
        stepEnd(s, 'bad', `${sub.join(' / ')} / ✗ ${Math.round((deps.upgradeWaitMs ?? UPGRADE_WAIT_MS) / 1000)}초 안에 엣지가 새 판으로 올라오지 않았습니다(지금 보이는 판 ${ver || '모름'} · 확인 ${polls}회)`, deps);
        audit(deps, '엣지 개별 central 토큰 자동 적용 실패', job, '업그레이드 뒤 엣지 판 미확인');
        return finish(job, 'failed', `엣지에 업그레이드 번들을 보냈지만 새 판(${MIN_EDGE_API_VERSION} 이상)으로 올라온 것을 확인하지 못했습니다(지금 ${ver || '모름'}) — 토큰은 발급하지 않았습니다. 엣지 포탈이 다시 떴는지 확인한 뒤 자동 적용을 다시 실행하세요.`, deps);
      }
      // 업그레이드로 엣지가 보고하는 호스트 이름이 생겼을 수 있다 — 대조 기준을 새 상태로
      if (!reportedHost && typeof st.hostname === 'string' && st.hostname.trim()) job.edgeHost = capStr(st.hostname.trim(), 128);
      stepEnd(s, 'ok', `${sub.join(' / ')} / ✓ 엣지 판 ${ver} 확인(${polls}회 당김)`, deps);
    }
  }

  /* 2 발급 */
  s = stepStart(job, 'issue', deps);
  const issued = deps.issue(name, { note: `자동 적용 ${job.id}` });
  if (!issued || !issued.ok || !issued.token) { stepEnd(s, 'bad', `발급 실패: ${issued?.reason || '사유 미상'}`, deps); return finish(job, 'failed', '토큰을 발급하지 못했습니다.', deps); }
  const token = issued.token;
  const issuedAt = deps.now ? deps.now() : Date.now();
  const issuedCreatedAt = tokenOf(deps, name)?.createdAt ?? null;   // 반증 F8: 정리 때 '이 작업이 발급한 것' 인지 이것으로 가린다
  let acceptFrom = issuedAt;   // '중앙이 새 토큰의 요청을 받아들였는가' 의 기준 시각
  job.fp = tokenFingerprintParts(token).short || '';
  stepEnd(s, 'ok', `발급 · 지문 ${job.fp}`, deps);
  audit(deps, '엣지 개별 central 토큰 발급(자동 적용)', job, `지문 ${job.fp}`);

  /**
   * 발급 취소 — 엣지가 새 토큰을 **확실히 쓰지 않을 때만** 부른다.
   * 반증 F1: `definite`(엣지가 '바꾼 것 없음' 이라고 답했거나 SSH 가 쓰기 전에 멈췄거나 되돌렸다)가 아니면, 취소 직전에 그 토큰의 요청을 중앙이
   *   받아들였는지 다시 본다 — 받아들였으면 엣지가 쓰고 있을 수 있으므로 취소하지 않는다(취소하면 엣지가 잠긴다).
   * 반증 F8: 지금 항목이 이 작업이 발급한 것(createdAt 같음)일 때만 취소한다 — 그 사이 사람이 다시 발급했으면 건드리지 않는다.
   */
  const revokeIssued = (why, { definite = false } = {}) => {
    const c = stepStart(job, 'cleanup', deps);
    if (!definite && acceptedSince(deps, name, acceptFrom)) { stepEnd(c, 'warn', '새 토큰의 요청을 중앙이 이미 받아들였습니다 — 엣지가 쓰고 있을 수 있어 발급을 취소하지 않았습니다. Veeam 진행 상태에서 개별 토큰 단계를 확인하세요.', deps); return false; }
    const cur = tokenOf(deps, name);
    if (!cur) { stepEnd(c, 'ok', '취소할 토큰이 이미 없습니다.', deps); return true; }
    if (issuedCreatedAt != null && cur.createdAt !== issuedCreatedAt) { stepEnd(c, 'warn', '그 사이 이 엣지의 개별 토큰이 다시 발급돼 이 작업은 취소하지 않았습니다.', deps); return false; }
    try { deps.revoke(name); stepEnd(c, 'ok', `발급을 취소했습니다(${why}) — 엣지는 예전처럼 공유 토큰으로 동작합니다.`, deps); audit(deps, '엣지 개별 central 토큰 회수(자동 적용 정리)', job, why); return true; }
    catch (e) { stepEnd(c, 'bad', `발급 취소 실패: ${cut(e)} — 설정 › 수집 서버의 개별 토큰 목록에서 '${name}' 을 회수하세요.`, deps); return false; }
  };
  const fail = (summary) => { audit(deps, '엣지 개별 central 토큰 자동 적용 실패', job, summary); return finish(job, 'failed', summary, deps); };

  /* 3 수집 토큰 통로 — 판이 낮은 것이 확인됐으면(다시 당겨서) 보내지 않는다: 옛 판은 이 주소가 로그인 인증으로 떨어져 401 이고 아무것도 받지 않는다 */
  s = stepStart(job, 'edge-api', deps);
  const hostOf = job.edgeHost || reportedHost;
  const r = verState === false
    ? { ok: false, status: null, body: null, skipped: true }
    : await deps.pushEdge(col, token);
  const b = r.body && typeof r.body === 'object' ? r.body : null;
  // v2.781(점검 G2 A-B1 이중 방어): 엣지의 확정 답 '바뀐 것 없음'(applied:false — 파일·메모리 모두 그대로, centralTokenApply.js) — 이후 SSH 도 쓰지 않았으면 회수는 확정이다.
  const edgeUnchanged = !!(b && b.applied === false);
  // 엣지가 '바뀐 것 없음' 을 확정으로 답하면 그 확인 요청(health-probe)은 '엣지가 새 토큰을 쓴다' 의 근거가 아니다 — 이후 판정 기준 시각을 응답 뒤로 옮긴다.
  if (b && b.applied === false) acceptFrom = (deps.now ? deps.now() : Date.now()) + 1;
  const pd = b ? (b.steps || []).map((x) => `${x.ok ? '✓' : '✗'} ${x.detail}`).join(' / ') : '';
  let applied = false; let viaSsh = false; let sshReason = ''; let hostWarn = false;
  if (r.skipped) {
    sshReason = `엣지 판 ${ver} 에는 수집 토큰 통로가 없습니다(${MIN_EDGE_API_VERSION} 이상 필요)`;
    stepEnd(s, 'skip', `${sshReason} — 보내지 않고 SSH 통로로 갑니다`, deps);
  } else if (r.ok && b && b.applied === true) {
    applied = true; job.path = 'edge-api';
    // 엣지 이름은 엣지의 중앙 확인이 이미 맞췄다(다르면 applied:false). 호스트 이름이 보고값과 다르면 같은 이름을 쓰는 다른 장비일 수 있다 — 알린다(되돌리지는 않는다).
    const hostSame = sameHostName(b.hostname, hostOf);
    if (hostSame === false) hostWarn = true;
    if (hostSame === false) stepEnd(s, 'warn', `엣지 적용·확인 성공 — 그러나 토큰을 받은 장비의 호스트 이름 '${b.hostname}' 이 이 엣지가 보고한 '${hostOf}' 과 다릅니다. 같은 엣지 이름(AGENT_NAME)을 쓰는 다른 장비일 수 있으니 수집 서버 주소·포워딩을 확인하세요 — ${pd}`, deps);
    else stepEnd(s, 'ok', `엣지 적용·확인 성공 · 받은 장비 호스트 ${b.hostname || '모름'}${hostSame ? '(보고값과 같음)' : ''} — ${pd}`, deps);
  } else if (b && b.applied === false && b.reason === 'probe-failed') {
    // 확정 답: 엣지는 아무것도 바꾸지 않았다 — 같은 엣지→중앙 경로라 SSH 로도 같다
    stepEnd(s, 'bad', `엣지가 새 토큰으로 중앙 확인에 실패했습니다(바뀐 것 없음) — ${pd}`, deps);
    revokeIssued('엣지 확인 실패 · 바뀐 것 없음', { definite: true });
    return fail(`엣지에서 새 토큰으로 중앙 확인에 실패했습니다(${b.probe?.reason || '사유 미상'}). 같은 경로라 SSH 로도 같습니다 — 엣지→중앙 통신을 먼저 확인하세요.`);
  } else if (b && b.applied === false && b.reason === 'busy') {
    stepEnd(s, 'bad', '엣지에서 다른 적용이 진행 중입니다(바뀐 것 없음).', deps);
    revokeIssued('엣지 사용 중', { definite: true });
    return fail('엣지에서 다른 적용이 진행 중입니다 — 잠시 뒤 다시 실행하세요.');
  } else {
    // v2.826: 401 = 옛 판 엣지(라우트 없음 → /api 로그인 인증) — 404 와 같이 '기능 없음' 이고 엣지는 아무것도 받지 않았다(확정).
    const noRoute = r.status === 404 || r.status === 401;
    const definite = (b && b.applied === false) || noRoute || r.status === 403;
    // 반증 F1: 결과를 모르는 실패(시한·끊김·중계 5xx·본문 없음)에서는 엣지 확인이 이미 받아들여졌는지 본다 — 받아들여졌으면 엣지는 기록했을 수 있다
    if (!definite && acceptedSince(deps, name, acceptFrom)) {
      applied = true; job.path = 'edge-api';
      stepEnd(s, 'warn', `엣지 응답을 받지 못했지만(${r.error || `HTTP ${r.status ?? '—'}`}) 새 토큰의 요청을 중앙이 받아들였습니다 — 적용된 것으로 보고 확인을 이어 갑니다.`, deps);
    } else {
      sshReason = noRoute ? `엣지에 이 기능이 없습니다(HTTP ${r.status}${r.status === 401 ? ' — 옛 판 엣지는 이 주소가 로그인 인증으로 떨어집니다' : ''} · 판 ${ver || '모름'}, ${MIN_EDGE_API_VERSION} 이상 필요)`
        : r.status === 403 ? '수집 토큰이 맞지 않습니다(HTTP 403)'
          // v2.781(점검 G2 A-I1): persist-failed 는 권한 말고도 '다음 기동이 읽지 않는 env 파일'(Windows 옛 start-portal.bat)일 수 있다 — 엣지가 남긴 단계 문구를 싣는다.
          : b?.reason === 'persist-failed' ? `엣지가 portal.env 에 쓰지 못했습니다(서비스 계정 권한 등 — 바뀐 것 없음)${pd ? ` · ${pd}` : ''}`
            : r.error ? `엣지에 닿지 못했습니다: ${r.error}` : `엣지 응답 HTTP ${r.status ?? '—'}${b?.reason ? ` · ${b.reason}` : ''}`;
      stepEnd(s, 'bad', `${sshReason}${target ? ' — SSH 통로로 넘어갑니다' : ''}`, deps);
      if (noRoute && !target && typeof deps.upgradeEdge === 'function') job.hint = 'upgrade';   // 화면이 '엣지 업그레이드 뒤 자동 적용' 을 단다
    }
  }

  /* 4 SSH 통로 */
  if (!applied) {
    s = stepStart(job, 'ssh', deps);
    if (!target) {
      stepEnd(s, 'skip', targets.length ? '배포 기록이 여러 개라 어느 호스트인지 정할 수 없습니다.' : '배포 기록(SSH 계정)이 없어 SSH 로 적용할 수 없습니다 — 설정 › 수집 서버 › 원격 법인(DC)에 Edge 노드 포탈 설치에 이 엣지를 등록하세요.', deps);
      // 옛 판 엣지(401·404)는 아무것도 받지 않았다 — 확정 취소. 다른 실패는 예전 판정 그대로.
      revokeIssued('엣지에 전달하지 못함', { definite: edgeUnchanged || !!r.skipped || r.status === 404 || r.status === 401 });
      return fail(`엣지에 전달하지 못했습니다: ${sshReason}${job.hint === 'upgrade' ? " — '엣지 업그레이드 뒤 자동 적용' 으로 엣지를 중앙 판으로 올린 뒤 적용할 수 있습니다(엣지 포탈이 재시작됩니다)." : ''}`);
    }
    const sub = []; let wrote = false;
    const sr = await deps.sshApply(target, token, { urlPort: Number(target.portalPort) || 4000, edgeNew, agent: name, expectHostname: hostOf, onStep: (k, ok, d) => { if (k === 'write' && ok) wrote = true; sub.push(`${ok ? '✓' : '✗'} ${d}`); } });
    if (sr && sr.ok) {
      applied = true; viaSsh = true; job.path = 'ssh';
      stepEnd(s, 'ok', sub.join(' / '), deps);
    } else {
      stepEnd(s, 'bad', `${sub.join(' / ')}${sub.length ? ' — ' : ''}${sr?.reason || 'SSH 적용 실패'}`, deps);
      // 쓰기 전에 멈췄거나, 썼어도 사본으로 **되돌렸으면**(종료 코드 확인 — 반증 F5) 엣지는 새 토큰을 쓰지 않는다
      // v2.781(점검 G2): 엣지가 applied:false 로 답했고 SSH 가 **쓰지 않았으면** 어느 통로로도 토큰이 엣지에 닿지 않았다 — definite.
      //   썼다가 되돌린 경우(재시작 뒤 실패 → 사본 복구 → 다시 재시작)는 확정으로 보지 않는다 — 그 사이 재시작한 엣지가 새 토큰을 썼을 수 있고
      //   두 번째 재시작은 결과를 보지 않는다(deploy.js) — 받아들인 기록이 있으면 회수하지 않는 예전 판정을 유지한다.
      if (!sr?.restoreFailed && (!wrote || sr?.reverted)) revokeIssued('SSH 적용 실패 · 바뀐 것 없음', { definite: edgeUnchanged && !wrote });
      else { const c = stepStart(job, 'cleanup', deps); stepEnd(c, 'warn', `엣지 portal.env 에 새 토큰이 남아 있을 수 있어 발급을 취소하지 않았습니다${sr?.restoreFailed ? ` — 사본(${sr.backup || '—'})으로 직접 복구하세요` : ''}.`, deps); }
      return fail(`SSH 로도 적용하지 못했습니다: ${sr?.reason || '사유 미상'}`);
    }
  }

  /* 5 중앙에서 확인 — 그 토큰의 요청을 중앙이 받아들였는가(반증 F4) */
  s = stepStart(job, 'verify', deps);
  const deadline = (deps.now ? deps.now() : Date.now()) + (viaSsh ? (deps.verifyWaitMs ?? VERIFY_WAIT_MS) : 5_000);
  let usedAt = null;
  for (;;) {
    usedAt = acceptedSince(deps, name, acceptFrom);
    if (usedAt) break;
    if ((deps.now ? deps.now() : Date.now()) >= deadline) break;
    await (deps.sleep ? deps.sleep(viaSsh ? 5_000 : 500) : new Promise((ok) => setTimeout(ok, viaSsh ? 5_000 : 500)));
  }
  if (usedAt) stepEnd(s, 'ok', `중앙이 새 토큰의 요청을 받아들였습니다(${new Date(usedAt).toISOString()})`, deps);
  else stepEnd(s, 'warn', viaSsh ? '재시작한 엣지의 요청을 새 토큰으로 아직 받지 못했습니다 — 몇 분 뒤 Veeam 진행 상태의 개별 토큰 단계를 다시 확인하세요.' : '중앙이 새 토큰의 요청을 아직 받지 못했습니다.', deps);

  /* 6 배포 기록 맞춤 */
  s = stepStart(job, 'deploy-record', deps);
  if (!target) stepEnd(s, 'skip', '배포 기록이 없습니다.', deps);
  else {
    const colDiff = sameToken(target.collectorToken, col.token) === false;
    const r6 = deps.saveTarget({ id: target.id, host: target.host, port: target.port, username: target.username, centralToken: token, ...(colDiff && col.token ? { collectorToken: col.token } : {}) });
    if (r6 && r6.ok !== false) stepEnd(s, 'ok', `배포 기록의 central 토큰을 새 값으로${colDiff ? ' · 수집 토큰을 등록값으로(등록값과 다름 해소)' : ''} 맞췄습니다 — 다시 배포해도 되돌아가지 않습니다.`, deps);
    else stepEnd(s, 'warn', `배포 기록을 고치지 못했습니다: ${r6?.reason || '사유 미상'} — 다시 배포하기 전에 배포 기록의 토큰을 고치세요.`, deps);
  }

  const summary = (usedAt
    ? `개별 토큰 적용 완료(${viaSsh ? 'SSH 통로' : '수집 토큰 통로'}) — Veeam 진행 상태에서 개별 토큰·배정 받기 단계가 바뀌는지 확인하세요.`
    : `엣지에 적용했지만 중앙이 새 토큰의 요청을 아직 받지 못했습니다(${viaSsh ? 'SSH 통로' : '수집 토큰 통로'}).`)
    + (hostWarn ? ' 토큰을 받은 장비의 호스트 이름이 이 엣지가 보고한 값과 달랐습니다 — 엣지 전달 단계를 확인하세요.' : '');
  audit(deps, usedAt ? '엣지 개별 central 토큰 자동 적용 완료' : '엣지 개별 central 토큰 자동 적용 완료(확인 필요)', job, `${viaSsh ? 'SSH' : '수집 토큰'} 통로`);
  return finish(job, usedAt && !hostWarn ? 'ok' : 'warn', summary, deps);
}

export function _resetForTest() { _jobs = null; _running.clear(); }
