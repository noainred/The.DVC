/**
 * diskbad/edge.js — **엣지** 워커: 중앙이 낸 점검 작업을 가져가(claim) 그 법인 서버의 Lifecycle 로그를 읽고 25대씩 올린다(v3.8.0).
 *
 * 법인 로컬 실행 규칙(루트 CLAUDE.md 2026-11-01): 읽기는 법인 안에서, 중앙은 결과만 받는다. 6시간 자동 점검도 중앙이 작업을 내고
 * 엣지가 가져가는 같은 길을 탄다(엣지에 설정 · 시계가 따로 있지 않다 — 한 곳에서 켜고 끈다).
 *
 * 규약:
 *  · gzip · 중앙 `BIG_JSON` 등록(index.js) · 413 은 사유로 남긴다(v2.503 · v2.517).
 *  · **0대여도 보고한다**(final 묶음) — 중앙이 '읽었는데 없음' 과 '안 돌았음' 을 가른다.
 *  · 무음 실패 금지 — `_last` + 콘솔 + `edgelog/spec.js` 등재.
 *  · 중앙이 이 기능이 없는 판(404)이면 1시간에 한 줄만 남기고 조용히 기다린다(구버전 중앙).
 */
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { config, currentVersion } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { agentHeaders, withAgentQuery } from '../agent/agentNameCarry.js';
import { scanServers, localServers } from './scan.js';
import { PUSH_PROTOCOL } from './ingest.js';

const gzipAsync = promisify(zlib.gzip);
const POLL_MS = 60_000;
/** 진행 보고 간격 — 서버 한 대가 오래 걸려도(첫 전량 읽기) 중앙이 '응답 없음'(jobs.js STALL_TIMEOUT_MS)으로 닫지 않게(반증 #2). 테스트가 산수를 고정한다. */
export const HEARTBEAT_MS = 2 * 60_000;
let _timer = null;
let _busy = false;
let _last = null;
let _missingWarnAt = 0;

const headers = () => ({ 'Content-Type': 'application/json', 'X-Central-Token': config.agent.centralToken, ...agentHeaders(config.agent.name) });

async function postChunk(job, batch, stat, seq) {
  const payload = { v: PUSH_PROTOCOL, agent: config.agent.name, version: currentVersion(), jobId: job.id, seq, final: !!stat.final,
    total: stat.total, done: stat.done, failed: stat.failed, excluded: stat.excluded, servers: batch };
  const json = JSON.stringify(payload);
  const hdrs = headers();
  let body = json;
  try { body = await gzipAsync(json); hdrs['Content-Encoding'] = 'gzip'; } catch { body = json; }
  const res = await resilientFetch(withAgentQuery(`${config.agent.centralUrl}/api/central/disk-bad`, config.agent.name), { method: 'POST', headers: hdrs, body, timeoutMs: 60_000, retries: 2 });
  if (res.status === 413) throw Object.assign(new Error(`중앙이 본문 크기를 거부(413) — 서버 ${batch.length}대 · ${Math.round(json.length / 1024)}KB. 중앙 BIG_JSON 등록을 확인하세요.`), { status: 413 });
  let ack = null;
  try { ack = await res.json(); } catch { ack = null; }
  if (!res.ok) throw Object.assign(new Error(`disk-bad <- ${res.status}${ack?.reason ? ` (${ack.reason})` : ''}`), { status: res.status });
  return ack || {};
}

export async function runDiskBadEdgeOnce() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return null;
  if (_busy) return null;
  _busy = true;
  const t0 = Date.now();
  try {
    const r = await resilientFetch(withAgentQuery(`${config.agent.centralUrl}/api/central/disk-bad-job`, config.agent.name), { headers: headers(), timeoutMs: 15_000, retries: 1 });
    if (r.status === 404) {
      if (Date.now() - _missingWarnAt > 3_600_000) { _missingWarnAt = Date.now(); console.log('[diskbad-edge] 중앙에 이 기능이 없습니다(구버전 중앙) — 중앙을 올리면 작업을 가져갑니다.'); }
      _last = { at: Date.now(), ok: true, idle: true, note: '중앙이 이 기능이 없는 판' };
      return null;
    }
    if (!r.ok) {
      _last = { at: Date.now(), ok: false, phase: 'claim', httpStatus: r.status, error: r.status === 403 ? '중앙이 토큰을 거부했습니다(403).' : `중앙 응답 HTTP ${r.status}` };
      console.warn(`[diskbad-edge] 작업 가져오기 실패: ${_last.error}`);
      return null;
    }
    const { job } = await r.json();
    if (!job || !job.id) { _last = { ...(_last || {}), at: Date.now(), ok: true, idle: true }; return null; }
    console.log(`[diskbad-edge] 작업 ${job.id.slice(0, 8)} 시작 — ${job.mode === 'full' ? '처음부터' : '새 로그만'}${Array.isArray(job.serverIds) ? ` · 서버 ${job.serverIds.length}대 지정` : ''}`);
    let seq = 0; let stop = false; let sent = 0; let newRecords = 0; const failures = [];
    let progress = { total: Array.isArray(job.serverIds) ? job.serverIds.length : null, done: 0, failed: 0, excluded: 0 };
    // 진행 보고(서버 0대) — 묶음이 25대마다라 첫 보고가 늦을 수 있다. 실패는 다음 간격에 다시 보낸다(기록만).
    const hb = setInterval(() => {
      postChunk(job, [], { ...progress, final: false }, seq++).then((ack) => { if (ack.stop || ack.stored === false) stop = true; }).catch(() => {});
    }, HEARTBEAT_MS);
    hb.unref?.();
    let stat;
    try {
      stat = await scanServers(await localServers(), {
        mode: job.mode, manual: job.manual === true, serverIds: job.serverIds || null,
        shouldStop: () => stop,
        onProgress: (p) => { progress = p; },
        // 저장됐다는 답(stored !== false)을 받은 묶음만 true — scan.js 가 그 서버의 커서만 앞으로 보낸다(반증 #1).
        onChunk: async (batch, st) => {
          try {
            const ack = await postChunk(job, batch, st, seq++);
            newRecords += Number(ack.newRecords) || 0;
            if (ack.stop) stop = true;
            if (ack.stored === false) {
              // 중앙이 이 작업을 더 받지 않는다(재시작 · 닫힌 작업 · 다른 엣지 몫) — 더 읽어도 버려지므로 멈춘다.
              stop = true;
              failures.push(ack.reason || '중앙이 보고를 보관하지 않았습니다.');
              return false;
            }
            sent += batch.length;
            return true;
          } catch (e) { failures.push(String(e?.message || e).slice(0, 200)); return false; }
        },
      });
    } finally { clearInterval(hb); }
    _last = { at: Date.now(), ms: Date.now() - t0, ok: failures.length === 0, jobId: job.id, mode: job.mode, total: stat.total, done: stat.done, failed: stat.failed, excluded: stat.excluded,
      sent, unsaved: stat.unsaved || 0, newRecords, stopped: stop, ...(failures.length ? { failures: failures.slice(0, 5) } : {}) };
    console.log(`[diskbad-edge] 작업 ${job.id.slice(0, 8)} ${stop ? '중단됨' : '끝'} — 서버 ${stat.done}/${stat.total} · 실패 ${stat.failed} · 제외 ${stat.excluded} · 보낸 ${sent}대${failures.length ? ` · 보고 실패 ${failures.length}건(그 서버들은 다음 점검에서 다시 읽음): ${failures[0]}` : ''}`);
    return _last;
  } catch (e) {
    _last = { at: Date.now(), ms: Date.now() - t0, ok: false, phase: 'run', error: String(e?.message || e).slice(0, 300) };
    console.warn(`[diskbad-edge] 실패: ${_last.error}`);
    return null;
  } finally { _busy = false; }
}

export function startDiskBadEdge() {
  if (_timer) return;
  if (!config.agent.centralUrl || !config.agent.centralToken) return;
  _timer = setInterval(() => { runDiskBadEdgeOnce().catch(() => {}); }, POLL_MS);
  _timer.unref?.();
  console.log(`[diskbad-edge] started — 중앙 작업을 ${POLL_MS / 1000}초마다 확인합니다`);
}

/** 엣지 로그 · 진행상태 표(edgelog/spec.js)가 읽는 상태. */
export function diskBadEdgeStatus() {
  return { configured: !!(config.agent.centralUrl && config.agent.centralToken), agent: config.agent.name, intervalMs: POLL_MS, busy: _busy, last: _last };
}
