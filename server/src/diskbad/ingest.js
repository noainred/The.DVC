/**
 * diskbad/ingest.js — 엣지가 올린 점검 결과를 **정제**한다(순수, v3.8.0).
 *
 * 루트 CLAUDE.md '엣지가 보낸 것은 정제한다': 아는 필드만 · 객체만 · 상한 · 문자열 수치는 수로 · 이름은 인증된 agent ·
 * 엣지 시각은 수신 시각으로 자른다. 모르는 필드는 버린다. 자격증명은 애초에 싣지 않는다(scan.js 결과 모양).
 */
import { numOrNull } from '../util/numOrNull.js';
import { REASON } from './scan.js';

export const PUSH_PROTOCOL = 1;
export const SERVERS_MAX = 2_000;     // 한 묶음 서버 상한(엣지는 25대씩 보낸다)
export const RECORDS_MAX = 5_000;
export const DRIVES_MAX = 64;
const REASONS = new Set(Object.values(REASON).filter(Boolean));
const ORDERS = new Set(['desc', 'asc', 'unknown']);
const STOPS = new Set(['', 'budget', 'max', 'skip', 'short', 'empty']);
const PATHS = new Set(['std', 'legacy']);
export const TOP_MAX = 8;
export const PROBE_MAX_BYTES = 16_000;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const s = (v, n) => (typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, n) : '');
const b = (v) => (v === true ? true : (v === false ? false : null));

/** 시각: 수로 읽고, 미래(수신 시각 + 5분 초과)는 수신 시각으로 자른다. 2000년 이전은 버린다. */
export function clampTime(v, now) {
  const n = numOrNull(v);
  if (n == null || n < 946_684_800_000) return null;
  return Math.min(n, now + 300_000);
}

function cleanLog(L, now) {
  if (!isObj(L)) return null;
  const total = numOrNull(L.total);
  const read = numOrNull(L.read);
  return {
    order: ORDERS.has(L.order) ? L.order : 'unknown',
    total: total != null && total >= 0 ? Math.floor(total) : null,
    read: read != null && read >= 0 ? Math.floor(read) : null,
    undated: Math.max(0, Math.floor(numOrNull(L.undated) ?? 0)),
    newestId: s(L.newestId, 64), newestCreated: clampTime(L.newestCreated, now),
    oldestRead: clampTime(L.oldestRead, now), cursorCreated: clampTime(L.cursorCreated, now),
    reachedEnd: L.reachedEnd === true, foundCursor: L.foundCursor === true, cursorUsed: L.cursorUsed === true,
    stopped: STOPS.has(L.stopped) ? L.stopped : '',
    // v3.8.2 읽기 진단(판정에 쓰지 않는다 — 화면이 '무엇을 읽었는지' 를 밝힌다). 모르는 판의 엣지는 보내지 않는다(null).
    pages: cnt(L.pages), ms: cnt(L.ms), distinct: cnt(L.distinct), firstLen: cnt(L.firstLen),
    hasNext: b(L.hasNext), path: PATHS.has(L.path) ? L.path : '', oldestCode: s(L.oldestCode, 16),
    // 건수를 못 읽은 항목은 0 으로 두지 않고 버린다.
    top: Array.isArray(L.top) ? L.top.slice(0, TOP_MAX).map((x) => (isObj(x) ? { code: s(x.code, 16), n: cnt(x.n) } : null)).filter((x) => x && x.code && x.n != null) : null,
  };
}

/** 0 이상의 정수(못 읽으면 null — 0 이 아니다). */
function cnt(v) { const n = numOrNull(v); return n != null && n >= 0 ? Math.floor(n) : null; }

/**
 * 장비 진단(probe.js)을 다시 자른다 — 글자 · 수 · 불리언만, 깊이 4 · 객체 60키 · 배열 60개 · 글자 200자 · 전체 16KB(UTF-8 바이트).
 * ⚠ 의도한 예외: 다른 엣지 수신(아는 필드만)과 달리 **모양을 정하지 않은 절단**이다 — 진단은 '장비가 무엇을 주는지 모른다' 가 전제라
 *   필드를 미리 정할 수 없다. 그래서 판정 · 집계에 쓰지 않고(화면에 관리자 판본으로만 보인다) 크기 · 깊이 · 타입만 묶는다.
 */
function san(v, depth) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v.slice(0, 200);
  if (depth >= 4 || typeof v !== 'object') return null;
  if (Array.isArray(v)) return v.slice(0, 60).map((x) => san(x, depth + 1));
  const o = {};
  let n = 0;
  for (const [k, x] of Object.entries(v)) {
    if (n >= 60) break;
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    o[String(k).slice(0, 64)] = san(x, depth + 1);
    n += 1;
  }
  return o;
}
export function cleanProbe(p) {
  if (!isObj(p)) return null;
  const o = san(p, 0);
  return Buffer.byteLength(JSON.stringify(o), 'utf8') > PROBE_MAX_BYTES ? { v: typeof o.v === 'number' ? o.v : 0, error: '진단 결과가 상한보다 커서 버렸습니다.' } : o;
}

function cleanRecord(r, now) {
  if (!isObj(r)) return null;
  const created = clampTime(r.created, now);
  if (created == null) return null;
  // 반증 #10: 자른 시각은 표시 · 판정용이다. 중복 거르기 키에는 **장비가 준 원래 시각**(정수)을 쓴다 — 자른 값을 키에 넣으면
  //   시계가 빠른 iDRAC 의 같은 항목이 읽을 때마다 다른 키(수신 시각 + 5분)가 되어 새 행 · '새 기록' 메일이 된다(원본은 따로).
  const raw = Math.floor(numOrNull(r.created));
  return { entryId: s(r.entryId, 64), created, createdRaw: raw, clockAhead: raw > created, messageId: s(r.messageId, 64), severity: s(r.severity, 16), message: s(r.message, 300), code: s(r.code, 12) };
}

// 과거 기록 읽기 1단계(README §22) — 디스크 값 · SEL. 모르는 판의 엣지는 보내지 않는다(null — 중앙은 지난 값을 그대로 둔다).
export const VALS_STATUS = Object.freeze(['ok', 'empty', 'absent', 'forbidden', 'error', 'timeout', 'auth']);
export const SEL_STATUS = VALS_STATUS;
const VALS_SET = new Set(VALS_STATUS);
const SRC_SET = new Set(['telemetry', 'metrics', '']);
const PART_SET = new Set(['ok', 'empty', 'absent', 'forbidden', 'error', '']);
const SEL_STOPS = new Set(['', 'budget', 'max', 'skip', 'short', 'error', 'timeout']);
/** 제어 문자는 빈칸으로(반증 F2 — JSON 으로 저장하면 한 글자가 6글자(\\uXXXX)로 불어 저장 크기가 예측을 넘었다). 길이는 먼저 자른다. */
const plain = (v, n) => s(v, n).replace(/[\u0000-\u001f\u007f]/g, ' ');
const KIND_SET = new Set(['removed', 'installed', 'fault', 'predictive', 'other']);
export const VALS_DRIVES_MAX = 64;
export const SEL_EVENTS_MAX = 100;
/** 0 이상의 수(소수 허용 — 가동 시간). 못 읽으면 null. */
const nn = (v) => { const n = numOrNull(v); return n != null && n >= 0 ? n : null; };

export function cleanVals(v, now) {
  if (!isObj(v)) return null;
  const status = VALS_SET.has(v.status) ? v.status : 'error';
  const drives = Array.isArray(v.drives) ? v.drives.slice(0, VALS_DRIVES_MAX).map((d) => {
    if (!isObj(d)) return null;
    const id = plain(d.id, 200).trim();
    if (!id) return null;
    const o = { id, realloc: cnt(d.realloc), pending: cnt(d.pending), uncorrectable: cnt(d.uncorrectable), powerOnHours: nn(d.powerOnHours), src: SRC_SET.has(d.src) ? d.src : '' };
    return [o.realloc, o.pending, o.uncorrectable, o.powerOnHours].some((x) => x != null) ? o : null;
  }).filter(Boolean) : [];
  return {
    at: clampTime(v.at, now) ?? now, status: status === 'ok' && !drives.length ? 'empty' : status,
    telemetry: PART_SET.has(v.telemetry) ? v.telemetry : '', metrics: PART_SET.has(v.metrics) ? v.metrics : '',
    reportAt: clampTime(v.reportAt, now), seen: Array.isArray(v.seen) ? v.seen.slice(0, 40).map((x) => plain(x, 64)).filter(Boolean) : [],
    drives,
  };
}

export function cleanSel(v, now) {
  if (!isObj(v)) return null;
  const events = Array.isArray(v.events) ? v.events.slice(0, SEL_EVENTS_MAX).map((e) => {
    if (!isObj(e)) return null;
    const disk = cnt(e.disk); const bp = cnt(e.bp);
    const slotKey = s(e.slotKey, 24);
    const created = clampTime(e.created, now);
    // 반증 F3: 자른 시각(수신 + 5분)은 표시용이다. 중복 거르기 키에는 **장비가 준 원래 시각**을 쓰고(db.js mergeSel), 시계가 빠른 장비의
    //   항목은 판정에 쓰지 않는다(verdict.js — 날짜를 믿을 수 없으면 '기록 뒤 빠짐' 을 말할 수 없다). LC 기록의 반증 #10 과 같은 선.
    const raw = numOrNull(e.created);
    return {
      created, createdRaw: created != null && raw != null ? Math.floor(raw) : null, clockAhead: created != null && raw != null && raw > created,
      kind: KIND_SET.has(e.kind) ? e.kind : 'other', disk, bp,
      // 위치 키는 이 꼴만(엣지가 만든 글자를 그대로 믿지 않는다 — 위치 번호와도 맞아야 한다).
      slotKey: disk != null && bp != null && slotKey === `bp${bp}:d${disk}` ? slotKey : '',
      messageId: plain(e.messageId, 64), message: plain(e.message, 300), severity: plain(e.severity, 16), sensor: plain(e.sensor, 40),
    };
  }).filter(Boolean) : [];
  const kinds = {};
  if (isObj(v.kinds)) for (const k of KIND_SET) { const n = cnt(v.kinds[k]); if (n != null) kinds[k] = n; }
  return {
    at: clampTime(v.at, now) ?? now, status: VALS_SET.has(v.status) ? v.status : 'error',
    read: cnt(v.read), total: cnt(v.total), pages: cnt(v.pages), stopped: SEL_STOPS.has(v.stopped) ? v.stopped : '',
    oldest: clampTime(v.oldest, now), newest: clampTime(v.newest, now), kinds, events,
  };
}

function cleanDrive(d) {
  if (!isObj(d)) return null;
  const cap = numOrNull(d.capacityGB);
  return {
    id: s(d.id, 200), name: s(d.name, 128), model: s(d.model, 80), serial: s(d.serial, 64),
    capacityGB: cap != null && cap >= 0 ? cap : null, media: s(d.media, 16), health: s(d.health, 16), state: s(d.state, 24),
    predictive: b(d.predictive), inVolume: b(d.inVolume),
  };
}

/** 서버 결과 하나. id 가 없으면 버린다. */
export function cleanServer(x, now) {
  if (!isObj(x)) return null;
  const id = s(x.id, 128).trim();
  if (!id) return null;
  const ok = x.ok === true;
  const reason = ok ? '' : (REASONS.has(x.reason) ? x.reason : REASON.error);
  const records = ok && Array.isArray(x.records) ? x.records.slice(0, RECORDS_MAX).map((r) => cleanRecord(r, now)).filter(Boolean) : [];
  const drives = Array.isArray(x.drives) ? x.drives.slice(0, DRIVES_MAX).map(cleanDrive).filter(Boolean) : null;
  return {
    id, name: s(x.name, 128), host: s(x.host, 256), serviceTag: s(x.serviceTag, 32),
    ok, reason, reasonText: ok ? '' : s(x.reasonText, 200),
    log: ok ? cleanLog(x.log, now) : null,
    records, recordsCapped: x.recordsCapped === true || (Array.isArray(x.records) && x.records.length > RECORDS_MAX),
    drives, invAt: clampTime(x.invAt, now), synthesized: x.synthesized === true,
    probe: cleanProbe(x.probe),
    vals: cleanVals(x.vals, now), sel: cleanSel(x.sel, now),
  };
}

/**
 * 묶음 본문 정제.
 * @returns {{ok:true, jobId:string, seq:number, final:boolean, total:number|null, done:number|null, failed:number|null, version:string, servers:Array, omitted:number}|{ok:false, reason:string}}
 */
export function cleanPush(body, { now = Date.now() } = {}) {
  if (!isObj(body)) return { ok: false, reason: '본문이 객체가 아닙니다.' };
  if (Number(body.v) !== PUSH_PROTOCOL) return { ok: false, reason: `모르는 프로토콜(${s(body.v, 8) || '없음'}) — 중앙 · 엣지 판을 맞추세요.` };
  const list = Array.isArray(body.servers) ? body.servers : [];
  const servers = list.slice(0, SERVERS_MAX).map((x) => cleanServer(x, now)).filter(Boolean);
  const n = (v) => { const k = numOrNull(v); return k != null && k >= 0 ? Math.floor(k) : null; };
  return {
    ok: true, jobId: s(body.jobId, 64), seq: n(body.seq) ?? 0, final: body.final === true,
    total: n(body.total), done: n(body.done), failed: n(body.failed), excluded: n(body.excluded),
    version: s(body.version, 32), servers, omitted: Math.max(0, list.length - servers.length),
  };
}
