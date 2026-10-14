/**
 * central/isiduEdge.js — 엣지가 보낸 아이실론 디렉터리 사용량 결과의 정제·상태 보관(v2.736).
 *
 * 규약(v2.598 CENTRAL · v2.682 R3S-01 · v2.548 F5):
 *  · 원소는 **객체·아는 필드만** 담는다 — 엣지가 보낸 원소 하나가 중앙 적재를 롤백시키거나 화면을 죽이지 않게.
 *  · 대상은 **그 엣지에 배정된 것만** 받는다(남의 대상 id 는 버리고 개수를 밝힌다). 이름은 인증된 agent 다(본문 agent 를 믿지 않는다).
 *  · 엣지 시각이 중앙 수신 시각보다 5분 넘게 앞서면 수신 시각으로 자르고 원본은 `edgeTs` 로 남긴다(미래 시각은 '가장 최근' 판정을 영원히 이긴다).
 *  · 상태 보관은 인메모리(엣지 수 상한) — 진실의 원천은 DB 다. 공개키는 비밀이 아니므로 화면이 보여 준다(엣지 법인 아이실론에 등록할 값).
 */
import { MAX_ENTRIES } from '../isidu/parse.js';
import { capStr } from '../util/capStr.js';
import { numOrNull } from '../util/numOrNull.js';
import { setIsiduBaseResolver } from '../isidu/collectRequests.js';

const FUTURE_SKEW_MS = 5 * 60_000;
const AGENT_MAX = 256;
const SCANS_PER_POST = 50;
// 상주 저장소에 들어가는 문자열은 capStr(자르고 평탄화 — v2.607 TIM2607-01: slice 는 원문을 붙잡는다). 문자열만 받는다.
const str = (v, max) => (typeof v === 'string' ? capStr(v, max) : '');
const num = numOrNull; // 숫자·숫자 문자열만, 그 밖은 null(util/numOrNull — 사본을 두지 않는다)

/**
 * 본문 → 정제된 스캔 목록. owned: 이 엣지에 배정된 대상 id 집합.
 * @returns {{scans:object[], dropped:{notOwned:number, bad:number, entries:number, futureClamped:number}}}
 */
export function sanitizeIsiduScans(body, owned, now = Date.now()) {
  const dropped = { notOwned: 0, bad: 0, entries: 0, futureClamped: 0 };
  const list = Array.isArray(body?.scans) ? body.scans.slice(0, SCANS_PER_POST) : [];
  const scans = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { dropped.bad++; continue; }
    const targetId = str(raw.targetId, 64);
    if (!targetId) { dropped.bad++; continue; }
    if (!owned.has(targetId)) { dropped.notOwned++; continue; }
    let ts = num(raw.ts);
    if (ts == null || ts <= 0) { dropped.bad++; continue; }
    let edgeTs = null;
    if (ts > now + FUTURE_SKEW_MS) { edgeTs = ts; ts = now; dropped.futureClamped++; }
    const ok = raw.ok === true;
    const entries = [];
    if (ok && Array.isArray(raw.entries)) {
      for (const e of raw.entries) {
        if (entries.length >= MAX_ENTRIES) { dropped.entries++; continue; }
        // 전송 모양: [name, bytes, res] — 객체도 받는다(구버전 대비).
        const name = Array.isArray(e) ? e[0] : e?.name;
        const bytes = num(Array.isArray(e) ? e[1] : e?.bytes);
        const res = num(Array.isArray(e) ? e[2] : e?.res);
        if (typeof name !== 'string' || !name || name.length > 512 || name.includes('/') || bytes == null || bytes < 0) { dropped.entries++; continue; }
        entries.push({ name, bytes: Math.round(bytes), res: Math.max(1, Math.round(res ?? 1)) });
      }
    }
    const total = raw.total && typeof raw.total === 'object' && num(raw.total.bytes) != null ? { bytes: num(raw.total.bytes), res: num(raw.total.res) ?? 1 } : null;
    scans.push({
      targetId, ts: Math.round(ts), ...(edgeTs != null ? { edgeTs } : {}), ok,
      path: str(raw.path, 1024), host: str(raw.host, 256), sizeMode: raw.sizeMode === 'k' ? 'k' : 'h',
      durationMs: num(raw.durationMs), total, sumBytes: num(raw.sumBytes), sumRes: num(raw.sumRes), count: ok ? entries.length : null,
      skipped: num(raw.skipped), errLines: num(raw.errLines),
      errSample: Array.isArray(raw.errSample) ? raw.errSample.filter((x) => typeof x === 'string').slice(0, 5).map((x) => capStr(x, 200)) : [],
      truncated: raw.truncated === true, kind: str(raw.kind, 32), error: str(raw.error, 600), trig: str(raw.trig, 16),
      edgeScanId: num(raw.id ?? raw.edgeScanId), entries,
    });
  }
  return { scans, dropped };
}

/** 엣지 상태(공개 정보만) 정제. */
export function sanitizeIsiduStatus(st) {
  const s = st && typeof st === 'object' ? st : {};
  const key = s.key && typeof s.key === 'object' ? s.key : null;
  const poller = s.poller && typeof s.poller === 'object' ? s.poller : null;
  return {
    key: key ? {
      present: key.present === true, usable: key.usable === true, type: str(key.type, 40) || null,
      fingerprint: str(key.fingerprint, 80) || null,
      publicKey: typeof key.publicKey === 'string' && /^[a-z0-9-]+ [A-Za-z0-9+/=]+( [\x20-\x7e]{0,80})?$/.test(key.publicKey) && key.publicKey.length <= 1200 ? key.publicKey : null,
      error: str(key.error, 200) || null, source: str(key.source, 16) || null,
    } : null,
    poller: poller ? {
      lastTick: num(poller.lastTick), concurrency: num(poller.concurrency),
      running: Array.isArray(poller.running) ? poller.running.filter((r) => r && typeof r === 'object').slice(0, 20).map((r) => ({ targetId: str(r.targetId, 64), since: num(r.since), trigger: str(r.trigger, 16) })) : [],
      lastError: poller.lastError && typeof poller.lastError === 'object' ? { at: num(poller.lastError.at), message: str(poller.lastError.message, 300) } : null,
    } : null,
    targets: num(s.targets),
    version: str(s.version, 32) || null,
  };
}

const _status = new Map(); // agent(소문자) → { agent, at, status, lastPush }

export function saveIsiduEdgeStatus(agent, status, push = null) {
  const k = String(agent || '').toLowerCase();
  if (!k) return;
  if (!_status.has(k) && _status.size >= AGENT_MAX) {
    // 가장 오래 보고하지 않은 엣지를 밀어낸다(정상 규모는 28곳).
    let oldK = null; let oldAt = Infinity;
    for (const [kk, v] of _status) if (v.at < oldAt) { oldAt = v.at; oldK = kk; }
    if (oldK) _status.delete(oldK);
  }
  _status.set(k, { agent: String(agent), at: Date.now(), status: sanitizeIsiduStatus(status), ...(push ? { lastPush: push } : {}) });
}
export function isiduEdgeStatus(agent) { return _status.get(String(agent || '').toLowerCase()) || null; }
export function allIsiduEdgeStatus() { return [..._status.values()]; }

// 대상별 마지막 수신 스캔 시각(엣지 시각) — '지금 수집' 요청의 기준선(collectRequests baseOf).
const _lastTs = new Map();
export function noteIsiduScanTs(targetId, ts) { const v = Math.max(Number(ts) || 0, _lastTs.get(targetId) || 0); _lastTs.set(targetId, v); if (_lastTs.size > 4096) _lastTs.delete(_lastTs.keys().next().value); }
export function lastIsiduScanTs(targetId) { return _lastTs.get(targetId) ?? null; }
// '지금 수집' 큐의 기준선 — 인출 시점에 그 대상의 마지막 엣지 스캔 시각(엣지 시계끼리만 비교한다 — v2.591 R-Q1).
setIsiduBaseResolver(lastIsiduScanTs);

export function _resetForTest() { _status.clear(); _lastTs.clear(); }
