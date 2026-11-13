/**
 * diskbad/ingest.js — 엣지가 올린 점검 결과를 **정제**한다(순수, v2.915).
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
const STOPS = new Set(['', 'budget', 'max']);

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
  };
}

function cleanRecord(r, now) {
  if (!isObj(r)) return null;
  const created = clampTime(r.created, now);
  if (created == null) return null;
  return { entryId: s(r.entryId, 64), created, messageId: s(r.messageId, 64), severity: s(r.severity, 16), message: s(r.message, 300), code: s(r.code, 12) };
}

function cleanDrive(d) {
  if (!isObj(d)) return null;
  const cap = numOrNull(d.capacityGB);
  return {
    id: s(d.id, 200), name: s(d.name, 128), model: s(d.model, 80), serial: s(d.serial, 64),
    capacityGB: cap != null && cap >= 0 ? cap : null, media: s(d.media, 16), health: s(d.health, 16),
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
