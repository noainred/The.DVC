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

export const LOG_FILE_NAME = 'edge-token-apply-log.json';
registerStateFile(LOG_FILE_NAME);
const KEEP = 50;
export const MIN_EDGE_API_VERSION = '2.776.0';
export const VERIFY_WAIT_MS = 180_000;
const DETAIL_MAX = 400;

export const STEP_LABEL = Object.freeze({
  precheck: '사전 점검', issue: '개별 토큰 발급', 'edge-api': '엣지에 전달(수집 토큰 통로)', ssh: '엣지에 전달(SSH 통로)',
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
 * @param {{ by?:string, deps:object, wait?:boolean }} o  deps: issue·revoke·listTokens·tokensLoadError·collectors·statusOf·deployTargets·saveTarget·pushEdge·sshApply·sleep·now
 * @returns {{ ok:boolean, job?:object, reason?:string }}
 */
export function startTokenApply(agent, { by = '', deps, wait = false } = {}) {
  const name = String(agent || '').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) return { ok: false, reason: '엣지 이름 형식이 올바르지 않습니다.' };
  if (_running.has(name.toLowerCase())) return { ok: false, reason: '이 엣지에 이미 진행 중인 작업이 있습니다.', jobId: _running.get(name.toLowerCase()) };
  const now = deps.now ? deps.now() : Date.now();
  const job = { id: `tok_${now.toString(36)}_${crypto.randomBytes(3).toString('hex')}`, agent: name, by: capStr(cut(by), 64), startedAt: now, endedAt: null, state: 'running', path: null, fp: '', summary: '', steps: [] };
  loadJobs().unshift(job);
  if (_jobs.length > KEEP) _jobs.length = KEEP;
  _running.set(name.toLowerCase(), job.id);
  saveJobs();
  const p = runJob(job, deps).catch((e) => finish(job, 'failed', `예상하지 못한 오류로 멈췄습니다: ${cut(e?.message || e)}`, deps))
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

async function runJob(job, deps) {
  const name = job.agent;
  /* 1 사전 점검 */
  let s = stepStart(job, 'precheck', deps);
  if (deps.tokensLoadError && deps.tokensLoadError()) { stepEnd(s, 'bad', '중앙 개별 토큰 파일을 읽지 못했습니다 — 발급하지 않습니다.', deps); return finish(job, 'failed', '중앙 개별 토큰 파일을 읽지 못했습니다.', deps); }
  const found = deps.findCollector(name);   // 수집 서버 이름 조회는 registry.findCollectorByName 하나(audit2613c EDGE2613-08)
  const col = found && found.enabled !== false ? found : null;
  if (!col || !col.url) { stepEnd(s, 'bad', `수집 서버 등록부에 켜진 '${name}' 이 없습니다.`, deps); return finish(job, 'failed', '수집 서버 등록이 없습니다.', deps); }
  const existing = (deps.listTokens() || []).find((t) => String(t.agent || '').toLowerCase() === name.toLowerCase());
  if (existing) { stepEnd(s, 'bad', '이미 개별 토큰이 발급돼 있습니다 — 다시 발급하면 엣지가 쓰는 기존 토큰이 즉시 폐기되므로 자동 적용은 공유 토큰 엣지만 합니다.', deps); return finish(job, 'failed', '이미 개별 토큰이 있습니다.', deps); }
  const st = deps.statusOf(col.id) || {};
  const ver = typeof st.version === 'string' ? st.version : '';
  const targets = (deps.deployTargets() || []).filter((t) => String(t.agentName || '').toLowerCase() === name.toLowerCase());
  const target = targets.length === 1 ? targets[0] : null;
  stepEnd(s, 'ok', `수집 서버 ${col.url} · 엣지 판 ${ver || '모름'} · 배포 기록 ${targets.length ? (target ? '있음(SSH 통로 가능)' : `${targets.length}개 — 어느 것인지 몰라 SSH 통로를 쓰지 않습니다`) : '없음(SSH 통로 불가)'}`, deps);

  /* 2 발급 */
  s = stepStart(job, 'issue', deps);
  const issued = deps.issue(name, { note: `자동 적용 ${job.id}` });
  if (!issued || !issued.ok || !issued.token) { stepEnd(s, 'bad', `발급 실패: ${issued?.reason || '사유 미상'}`, deps); return finish(job, 'failed', '토큰을 발급하지 못했습니다.', deps); }
  const token = issued.token;
  const issuedAt = deps.now ? deps.now() : Date.now();
  job.fp = tokenFingerprintParts(token).short || '';
  stepEnd(s, 'ok', `발급 · 지문 ${job.fp}`, deps);

  // 엣지가 새 토큰을 '확실히 쓰지 않는' 실패에서만 취소한다.
  const revokeIssued = (why) => {
    const c = stepStart(job, 'cleanup', deps);
    try { deps.revoke(name); stepEnd(c, 'ok', `발급을 취소했습니다(${why}) — 엣지는 예전처럼 공유 토큰으로 동작합니다.`, deps); }
    catch (e) { stepEnd(c, 'bad', `발급 취소 실패: ${cut(e?.message || e)} — 설정 › 수집 서버의 개별 토큰 목록에서 '${name}' 을 회수하세요.`, deps); }
  };

  /* 3 수집 토큰 통로 */
  s = stepStart(job, 'edge-api', deps);
  const r = await deps.pushEdge(col, token);
  let applied = false; let viaSsh = false; let sshReason = '';
  if (r.ok && r.body && r.body.ok === true) {
    applied = true; job.path = 'edge-api';
    const pd = (r.body.steps || []).map((x) => `${x.ok ? '✓' : '✗'} ${x.detail}`).join(' / ');
    stepEnd(s, 'ok', `엣지 적용·확인 성공 — ${pd}`, deps);
  } else if (r.ok && r.body && r.body.reverted) {
    const pd = (r.body.steps || []).map((x) => `${x.ok ? '✓' : '✗'} ${x.detail}`).join(' / ');
    stepEnd(s, 'bad', `엣지가 새 토큰으로 중앙 확인에 실패해 되돌렸습니다 — ${pd}`, deps);
    revokeIssued('엣지가 되돌림');
    return finish(job, 'failed', `엣지에서 새 토큰으로 중앙 확인에 실패했습니다(${r.body.probe?.reason || '사유 미상'}). 같은 경로라 SSH 로도 같습니다 — 엣지→중앙 통신을 먼저 확인하세요.`, deps);
  } else {
    sshReason = r.status === 404 ? `엣지에 이 기능이 없습니다(HTTP 404 — 판 ${ver || '모름'}, ${MIN_EDGE_API_VERSION} 이상 필요)`
      : r.status === 403 ? '수집 토큰이 맞지 않습니다(HTTP 403)'
        : r.body?.reason === 'persist-failed' ? '엣지가 portal.env 에 쓰지 못했습니다(서비스 계정 권한)'
          : r.body?.reason === 'busy' ? '엣지에서 다른 적용이 진행 중입니다'
            : r.error ? `엣지에 닿지 못했습니다: ${r.error}` : `엣지 응답 HTTP ${r.status ?? '—'}${r.body?.reason ? ` · ${r.body.reason}` : ''}`;
    stepEnd(s, 'bad', `${sshReason}${target ? ' — SSH 통로로 넘어갑니다' : ''}`, deps);
    if (r.body?.reason === 'busy') { revokeIssued('엣지 사용 중'); return finish(job, 'failed', '엣지에서 다른 적용이 진행 중입니다 — 잠시 뒤 다시 실행하세요.', deps); }
  }

  /* 4 SSH 통로 */
  if (!applied) {
    s = stepStart(job, 'ssh', deps);
    if (!target) {
      stepEnd(s, 'skip', targets.length ? '배포 기록이 여러 개라 어느 호스트인지 정할 수 없습니다.' : '배포 기록(SSH 계정)이 없어 SSH 로 적용할 수 없습니다 — 설정 › 수집 서버 › 원격 법인(DC)에 Edge 노드 포탈 설치에 이 엣지를 등록하세요.', deps);
      revokeIssued('엣지에 전달하지 못함');
      return finish(job, 'failed', `엣지에 전달하지 못했습니다: ${sshReason}`, deps);
    }
    const replaceCentral = !(ver && (cmpVersion(ver, MIN_EDGE_API_VERSION) ?? -1) >= 0);
    const sub = []; let wrote = false;
    const sr = await deps.sshApply(target, token, { urlPort: Number(target.portalPort) || 4000, replaceCentral, onStep: (k, ok, d) => { if (k === 'write' && ok) wrote = true; sub.push(`${ok ? '✓' : '✗'} ${d}`); } });
    if (sr && sr.ok) {
      applied = true; viaSsh = true; job.path = 'ssh';
      stepEnd(s, 'ok', `${sub.join(' / ')}${replaceCentral ? ' — 옛 판(또는 판 모름) 엣지라 CENTRAL_TOKEN 도 바꿨습니다: 그 엣지의 /api/central 받는 문도 이 토큰이 됩니다' : ''}`, deps);
    } else {
      const certainNotUsing = !wrote || !!sr?.reverted;   // 쓰기 전에 멈췄거나, 썼어도 사본으로 되돌렸으면 엣지는 새 토큰을 쓰지 않는다
      stepEnd(s, 'bad', `${sub.join(' / ')}${sub.length ? ' — ' : ''}${sr?.reason || 'SSH 적용 실패'}`, deps);
      if (certainNotUsing) revokeIssued('SSH 적용 실패 · 되돌림');
      else { const c = stepStart(job, 'cleanup', deps); stepEnd(c, 'warn', '엣지 portal.env 에 새 토큰이 기록됐을 수 있어 발급을 취소하지 않았습니다 — 엣지 상태를 확인하세요.', deps); }
      return finish(job, 'failed', `SSH 로도 적용하지 못했습니다: ${sr?.reason || '사유 미상'}`, deps);
    }
  }

  /* 5 중앙에서 확인 — 그 토큰이 실제로 쓰였는가 */
  s = stepStart(job, 'verify', deps);
  const deadline = (deps.now ? deps.now() : Date.now()) + (viaSsh ? (deps.verifyWaitMs ?? VERIFY_WAIT_MS) : 5_000);
  let usedAt = null;
  for (;;) {
    const t = (deps.listTokens() || []).find((x) => String(x.agent || '').toLowerCase() === name.toLowerCase());
    if (t && Number(t.lastUsedAt) >= issuedAt) { usedAt = Number(t.lastUsedAt); break; }
    if ((deps.now ? deps.now() : Date.now()) >= deadline) break;
    await (deps.sleep ? deps.sleep(viaSsh ? 5_000 : 500) : new Promise((ok) => setTimeout(ok, viaSsh ? 5_000 : 500)));
  }
  if (usedAt) stepEnd(s, 'ok', `엣지가 새 토큰으로 중앙에 접속했습니다(중앙 기록 ${new Date(usedAt).toISOString()})`, deps);
  else stepEnd(s, 'warn', viaSsh ? '재시작한 엣지가 아직 새 토큰으로 중앙에 접속하지 않았습니다 — 몇 분 뒤 Veeam 진행 상태의 개별 토큰 단계를 다시 확인하세요.' : '중앙 사용 기록이 아직 없습니다.', deps);

  /* 6 배포 기록 맞춤 */
  s = stepStart(job, 'deploy-record', deps);
  if (!target) stepEnd(s, 'skip', '배포 기록이 없습니다.', deps);
  else {
    const colDiff = sameToken(target.collectorToken, col.token) === false;
    const r6 = deps.saveTarget({ id: target.id, host: target.host, port: target.port, username: target.username, centralToken: token, ...(colDiff && col.token ? { collectorToken: col.token } : {}) });
    if (r6 && r6.ok !== false) stepEnd(s, 'ok', `배포 기록의 central 토큰을 새 값으로${colDiff ? ' · 수집 토큰을 등록값으로(등록값과 다름 해소)' : ''} 맞췄습니다 — 다시 배포해도 되돌아가지 않습니다.`, deps);
    else stepEnd(s, 'warn', `배포 기록을 고치지 못했습니다: ${r6?.reason || '사유 미상'} — 다시 배포하기 전에 배포 기록의 토큰을 고치세요.`, deps);
  }

  return finish(job, usedAt ? 'ok' : 'warn', usedAt
    ? `개별 토큰 적용 완료(${viaSsh ? 'SSH 통로' : '수집 토큰 통로'}) — Veeam 진행 상태에서 개별 토큰·배정 받기 단계가 바뀌는지 확인하세요.`
    : `엣지에 적용했지만 중앙 사용 기록이 아직 없습니다(${viaSsh ? 'SSH 통로' : '수집 토큰 통로'}).`, deps);
}

export function _resetForTest() { _jobs = null; _running.clear(); }
