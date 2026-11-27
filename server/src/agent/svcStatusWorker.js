/**
 * agent/svcStatusWorker.js — 포탈 서비스 상태 모니터링의 **엣지 측정**(v3.54).
 *
 * 현지 수집 vCenter · 담당 엣지가 지정된 CVP · 스토리지는 중앙에서 닿지 않는 주소일 수 있다 — 중앙이 재면 늘 '끊김' 이라는 거짓이 된다.
 * 그래서 그 법인 엣지가 **중앙이 계산해 준 대상만**(`GET /api/central/svc-status-config` — 자기 몫 · 토큰 없음) 같은 측정 함수(svcstatus/probe.js)로 재고
 * 결과를 올린다(`POST /api/central/svc-status`). 엣지가 등록부 사본으로 스스로 대상을 만들지 않는다(중앙에서 바꾼 설정이 그 법인에 안 먹는 사고 — edge.md).
 *
 * ⚠ 무음 실패 금지 — `_last`(svcStatusWorkerStatus · 엣지 로그 화면) + 콘솔. **0건 · 꺼짐이어도 보고한다**(note 와 함께 — v2.554 규약, 조기 return 금지).
 * ⚠ 주기 · 동시성 · 시한은 중앙 값을 엣지가 다시 자른다(85회차 I1 — 옛 중앙 · 손상 설정이 1초 주기를 내려도 그대로 돌지 않게).
 * ⚠ 엣지 시각을 보내지 않는다 — 행마다 '측정 뒤 지난 ms'(a)를 보낸다(중앙이 수신 시각에서 뺀다 — 시계 차가 끼지 않는다).
 * ⚠ 스토리지 REST 포트는 그 노드 env 로 정해진다 — 엣지 env 의 포트가 중앙이 준 포트와 다르면 그 값(lp)도 실어 화면이 말하게 한다(측정은 중앙이 준 포트로).
 */
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { config, currentVersion } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { readJsonCapped, EDGE_RESPONSE_MAX_BYTES } from '../util/readCapped.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { poolSettled } from '../util/pool.js';
import { classifyCentral404 } from './central404.js';
import { agentHeaders, withAgentQuery } from './agentNameCarry.js';
import { probeTcp } from '../svcstatus/probe.js';
import { storageEndpointOf } from '../storage/endpoint.js';

const gzipAsync = promisify(gzip);
// 중앙 저장 범위(svcstatus/settings.js LIMITS)와 같은 값 — 엣지가 중앙 설정 모듈을 끌어오지 않게 상수로 둔다(시험이 대조한다).
export const SVC_INTERVAL_MIN_MS = 30_000;
export const SVC_INTERVAL_MAX_MS = 3_600_000;
export const SVC_CONCURRENCY_MAX = 64;
export const SVC_TIMEOUT_MIN_MS = 500;
export const SVC_TIMEOUT_MAX_MS = 15_000;
export const SVC_TARGETS_MAX = 5_000;
const FALLBACK_MS = 60_000;
let _timer = null;
let _running = false;
let _last = null;
let _intervalMs = FALLBACK_MS;

export function svcStatusWorkerStatus() { return { running: _running, intervalMs: _intervalMs, last: _last }; }

const headers = () => ({ Accept: 'application/json', ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) });
const clampInt = (v, lo, hi, def) => { const x = Math.round(Number(v)); return Number.isFinite(x) && x > 0 ? Math.min(hi, Math.max(lo, x)) : def; };

async function pushReport(base, agent, { results = [], note = '', disabled = false } = {}) {
  const json = JSON.stringify({ at: Date.now(), version: currentVersion(), results, note, disabled });
  const hdrs = { ...headers(), 'Content-Type': 'application/json', ...agentHeaders(agent) };
  let payload = json;
  try { payload = await gzipAsync(json); hdrs['Content-Encoding'] = 'gzip'; } catch { payload = json; }
  // 재전송하지 않는다(retries 0) — 다음 주기가 그 주기의 측정을 다시 올린다(중앙 503 동안 같은 본문을 세 번 올리지 않게 · v2.682).
  const post = await resilientFetch(withAgentQuery(`${base}/api/central/svc-status`, agent), { method: 'POST', headers: hdrs, body: payload, timeoutMs: 30_000, retries: 0 });
  if (post.status === 413) console.warn(`[svc-status-worker] 중앙이 본문 크기를 거부(413) — ${results.length}건. 중앙의 BIG_JSON 등록을 확인하세요.`);
  if (!post.ok) {
    console.warn(`[svc-status-worker] 보고 실패: HTTP ${post.status}${post.status === 403 ? ' — 이 엣지의 개별 토큰(설정 > 엣지 토큰)이 필요합니다.' : ''}`);
    const body = post.status === 503 ? await post.json().catch(() => null) : null;
    if (body?.dbUnavailable) console.warn('[svc-status-worker] 중앙이 측정 DB 를 쓸 수 없어 이번 측정이 저장되지 않았습니다(중앙 svc-status.db 확인).');
    return { ok: false, httpStatus: post.status, ...(body?.dbUnavailable ? { dbUnavailable: true } : {}), ...(body?.registryUnreadable ? { registryUnreadable: true } : {}) };
  }
  return await post.json().catch(() => ({}));
}
const ackFields = (ack) => ({
  stored: ack?.stored ?? null, rejected: ack?.rejected ?? null, omitted: ack?.omitted ?? null, notAssigned: ack?.notAssigned ?? null,
  reportPosted: ack?.ok === true, reportHttpStatus: ack?.httpStatus ?? null,
  ...(ack?.dbUnavailable ? { centralDbUnavailable: true } : {}),
});

export async function runSvcStatusWorkerOnce() {
  const base = config.agent.centralUrl;
  if (!base) return { ok: false, reason: 'CENTRAL_URL 없음(엣지 아님)' };
  if (_running) return { ok: false, reason: '이전 틱 진행 중' };
  _running = true;
  const t0 = Date.now();
  try {
    const agent = String(config.agent.name || '');
    const r = await resilientFetch(`${base}/api/central/svc-status-config?agent=${encodeURIComponent(agent)}`, { headers: headers(), timeoutMs: 15_000, retries: 1 });   // 통신 점검 워커와 같은 꼴(중앙이 토큰 이름과 대조)
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('중앙이 이 엣지를 거부했습니다(개별 토큰 · AGENT_NAME 확인)'), { status: r.status });
    if (r.status === 404) {
      const c = await classifyCentral404(r);
      if (c.kind !== 'no-endpoint') throw Object.assign(new Error(c.reason), { status: 404, kind: c.kind });
      _last = { at: Date.now(), ms: Date.now() - t0, ok: true, kind: c.kind, note: '중앙이 구버전입니다(포탈 서비스 상태 수신 경로 없음)', targets: 0 };
      return { ok: true, targets: 0 };
    }
    if (r.status === 503) {
      const b = await r.json().catch(() => null);
      if (b?.reason === 'settingsUnreadable' || b?.reason === 'registryUnreadable') {
        throw Object.assign(new Error(`중앙이 ${b.reason === 'settingsUnreadable' ? '설정 파일' : '등록부'}를 읽지 못했습니다 — ${String(b.detail || '').slice(0, 200)}`), { status: 503, kind: b.reason });
      }
    }
    if (!r.ok) throw Object.assign(new Error(`svc-status-config <- HTTP ${r.status}`), { status: r.status });
    // ⚠ 본문을 못 읽거나 모양이 다르면 실패로 끝낸다 — {} 로 넘기면 '중앙에서 꺼짐' 이라는 거짓 보고를 올렸다(점검 반증 #14).
    let cfg;
    try { cfg = await readJsonCapped(r, EDGE_RESPONSE_MAX_BYTES, 'svc-status-config 응답'); }
    catch (e) { throw Object.assign(new Error(`svc-status-config 응답 본문을 읽지 못했습니다 — ${String(e?.message || e).slice(0, 160)}`), { status: r.status, kind: 'bad-body' }); }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || cfg.ok !== true || typeof cfg.enabled !== 'boolean') {
      throw Object.assign(new Error('svc-status-config 응답 형식이 다릅니다(중앙이 아닌 서버에 닿았을 수 있습니다)'), { status: r.status, kind: 'bad-shape' });
    }
    _intervalMs = clampInt(cfg.intervalMs, SVC_INTERVAL_MIN_MS, SVC_INTERVAL_MAX_MS, _intervalMs);
    const heldEmpty = (Array.isArray(cfg.heldEmpty) ? cfg.heldEmpty : []).map((x) => String(x?.label || x?.kind || '').slice(0, 40)).filter(Boolean).slice(0, 8);
    const heldNote = heldEmpty.length ? `중앙이 등록부(${heldEmpty.join(' · ')})를 읽지 못해 그 종류는 이번 목록에서 빠졌습니다.` : '';
    if (cfg?.enabled !== true) {
      const note = '중앙에서 포탈 서비스 상태 측정이 꺼져 있습니다.';
      const ack = await pushReport(base, agent, { results: [], note, disabled: true });
      _last = { at: Date.now(), ms: Date.now() - t0, ok: true, disabled: true, note, targets: 0, ...ackFields(ack) };
      return { ok: true, disabled: true };
    }
    const targets = (Array.isArray(cfg.targets) ? cfg.targets : []).filter((x) => x && typeof x === 'object').slice(0, SVC_TARGETS_MAX);
    if (!targets.length) {
      // ⚠ 0건이어도 보고한다 — 조기 return 으로 되돌리지 말 것(중앙이 '첫 보고 대기' 로 영원히 기다린다).
      const note = heldNote || '이 엣지가 잴 대상이 없습니다(담당으로 지정된 vCenter · CVP · 스토리지가 없습니다).';
      const ack = await pushReport(base, agent, { results: [], note });
      _last = { at: Date.now(), ms: Date.now() - t0, ok: true, targets: 0, note, ...ackFields(ack) };
      return { ok: true, targets: 0 };
    }
    const conc = clampInt(cfg.concurrency, 1, SVC_CONCURRENCY_MAX, 8);
    const dnsTimeoutMs = clampInt(cfg.dnsTimeoutMs, 500, 10_000, 3_000);
    const settled = await poolSettled(targets, conc, async (tg) => {
      const timeoutMs = clampInt(tg.timeoutMs, SVC_TIMEOUT_MIN_MS, SVC_TIMEOUT_MAX_MS, 2_500);
      const res = await probeTcp({ host: tg.host, port: tg.port }, { timeoutMs, dnsTimeoutMs });
      const doneAt = Date.now();
      let lp;
      if (tg.kind === 'storage' && tg.type) {
        try { const ep = storageEndpointOf({ type: tg.type, collectMethod: tg.method, host: tg.host }); if (ep.method === 'api' && ep.port !== tg.port) lp = ep.port; } catch { /* 비교 없이 */ }
      }
      return { id: String(tg.id || ''), host: String(tg.host || ''), port: Number(tg.port), ok: res.ok, ms: res.ms, fk: res.fk, doneAt, ...(lp ? { lp } : {}) };
    });
    const sentAt = Date.now();
    const results = []; let skipped = 0; let failed = 0;
    for (const x of settled) {
      if (x.status !== 'fulfilled') { skipped += 1; continue; }
      const v = x.value;
      if (!v.ok) failed += 1;
      const { doneAt, ...rest } = v;
      results.push({ ...rest, a: Math.max(0, sentAt - doneAt) });
    }
    const ack = await pushReport(base, agent, { results, note: heldNote });
    _last = { at: Date.now(), ms: Date.now() - t0, ok: true, targets: targets.length, measured: results.length, failed, skipped, ...(heldNote ? { note: heldNote } : {}), ...ackFields(ack) };
    console.log(`[svc-status-worker] 대상 ${targets.length}개 측정 — 실패 ${failed} · 건너뜀 ${skipped} · ${Date.now() - t0}ms`);
    return { ok: true, measured: results.length, failed };
  } catch (e) {
    _last = { at: Date.now(), ms: Date.now() - t0, ok: false, httpStatus: e?.status || null, ...(e?.kind ? { kind: e.kind } : {}), error: String(e?.message || e).slice(0, 300) };
    console.warn(`[svc-status-worker] 실패: ${_last.error}`);
    return { ok: false, reason: _last.error };
  } finally { _running = false; }
}

export function startSvcStatusWorker() {
  if (!config.agent.centralUrl) return;          // 중앙 자신이면 svcstatus/poller.js 가 잰다
  if (String(process.env.AGENT_SVC_STATUS || '').toLowerCase() === 'false') {
    console.log('[svc-status-worker] 꺼짐(AGENT_SVC_STATUS=false).');
    return;
  }
  if (_timer) return _timer;
  _timer = startAdaptiveTimer(() => _intervalMs, () => runSvcStatusWorkerOnce(), { firstDelayMs: 45_000, name: 'svc-status-worker' });
  return _timer;
}
export function stopSvcStatusWorker() { _timer?.stop?.(); _timer = null; }
