/**
 * approval/store.js — **두 사람 승인**(요청 → 다른 설정 소유자의 승인 → 실행) 공용 저장소(v3.10.0 · 설계 docs/design/ssh-access §8 S10).
 *
 * 쓰는 곳: SSH 공용 접속(키 등록 · 교체 · 삭제 · 사용 중지 해제 · 키 저장소 다시 읽기 · 보호 장치 끄기) · 서버 스크립트(등록 승인 — 다음 단계).
 * 이 모듈은 **무엇을 실행하는지 모른다** — 요청의 종류(kind) · 대상 · 본문(payload)을 보관하고 ‘누가 요청했고 누가 승인했나’ 만 강제한다.
 * 실행은 승인한 호출부(`sshaccess/twoPerson.js` 등)가 한다.
 *
 * 파일 `CONFIG_DIR/approvals.json`(0600 · 원자적 쓰기 · 손상 보존):
 *   { requests: [ { id, kind, title, target, corp, payload, digest, requestedBy, requestedAt, expiresAt,
 *                   status: 'pending'|'approved'|'rejected'|'cancelled'|'expired'|'executed'|'failed',
 *                   decidedBy, decidedAt, note, result } ] }
 *
 * 불변조건(되돌리지 말 것):
 *  · **요청한 사람은 승인할 수 없다**(서버가 강제 — 화면 게이트가 아니다). 이름 비교는 소문자.
 *  · **본문에 비밀을 싣지 않는다** — 개인키 · 비밀번호가 필요한 요청은 대상을 ‘승인 대기’ 상태로 먼저 저장하고(키 저장소의 pending 키) 여기에는 id · 지문만 둔다.
 *  · 승인은 **요청 내용의 지문(digest)** 에 묶인다 — 승인하는 화면이 본 digest 를 돌려보내고, 다르면 거절(그 사이 파일이 바뀐 경우).
 *  · 요청에는 시한(기본 24시간) — 지나면 ‘expired’ 로 확정하고 승인할 수 없다(무한 대기 금지).
 *  · 파일을 못 읽으면(손상 · 모양 틀림) **새 요청 · 승인을 모두 거절**한다(fail-closed) — 손상 한 번으로 승인 대기가 ‘승인됨’ 으로 읽히지 않게.
 *  · 백업 복원에서 뺀다(`backup/stagedRestore.js RESTORE_EXCLUDE`) — 되돌리면 지난 요청이 다시 승인 대기가 된다.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { makeLoadError } from '../util/registryCore.js';

export const APPROVALS_FILE_NAME = 'approvals.json';
const FILE = () => path.join(config.configDir, 'approvals.json');   // = APPROVALS_FILE_NAME(문서 생성기가 글자 그대로 찾는다)
export const REQUEST_TTL_MS = 24 * 3600_000;
export const MAX_PENDING = 200;
export const MAX_HISTORY = 300;
export const MAX_PENDING_PER_USER = 30;
const MAX_PAYLOAD_BYTES = 4096;
const OPEN = 'pending';
const STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'expired', 'executed', 'failed'];
const ID_RE = /^ap_[0-9a-f]{12}$/;
const KIND_RE = /^[a-z][a-z0-9-]{1,39}$/;

const t = (v, max = 256) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max).trim();
const lc = (v) => t(v, 128).toLowerCase();
/**
 * 신원 비교용 글자 — 소문자 · AD 도메인 접두(`CORP\\alice`) · 접미(`alice@corp.local`)를 뗀다(점검 A2).
 * AD 로그인은 세 꼴을 모두 받고 입력한 글자를 그대로 username 으로 쓴다 — 글자만 비교하면 같은 사람이 별칭으로 자기 요청을 승인할 수 있었다.
 */
export function identityKey(name) {
  let s = lc(name);
  const bs = s.lastIndexOf('\\'); if (bs >= 0) s = s.slice(bs + 1);
  const at = s.indexOf('@'); if (at > 0) s = s.slice(0, at);
  return s;
}
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

let cache = null;
const loadErr = makeLoadError();

/** 요청 내용의 지문 — 종류 · 대상 · 본문(키 정렬). 승인 화면이 본 것과 실행할 것이 같은지 본다. */
export function digestOf(kind, target, payload) {
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  return crypto.createHash('sha256').update(JSON.stringify([String(kind), String(target), canon(payload || {})])).digest('hex').slice(0, 32);
}

class ShapeError extends Error {}
function normReq(r) {
  if (!isObj(r)) throw new ShapeError('요청이 객체가 아닙니다');
  const id = t(r.id, 20); const kind = t(r.kind, 40);
  if (!ID_RE.test(id) || !KIND_RE.test(kind)) throw new ShapeError('요청 id · 종류가 올바르지 않습니다');
  if (!STATUSES.includes(r.status)) throw new ShapeError(`모르는 상태(${t(r.status, 20)})`);
  if (r.payload !== undefined && !isObj(r.payload)) throw new ShapeError('본문이 객체가 아닙니다');
  const payload = r.payload || {};
  const target = t(r.target, 200);
  return {
    id, kind, title: t(r.title, 200), target, corp: t(r.corp, 128), payload, digest: digestOf(kind, target, payload),
    requestedBy: t(r.requestedBy, 64), requestedAt: num(r.requestedAt), expiresAt: num(r.expiresAt), status: r.status,
    decidedBy: t(r.decidedBy, 64), decidedAt: num(r.decidedAt), note: t(r.note, 300),
    result: isObj(r.result) ? { ok: r.result.ok === true, code: t(r.result.code, 40), reason: t(r.result.reason, 300) } : null,
  };
}
function norm(j) {
  if (!isObj(j)) throw new ShapeError('승인 파일이 객체가 아닙니다');
  if (j.requests !== undefined && !Array.isArray(j.requests)) throw new ShapeError('requests 가 배열이 아닙니다');
  return { requests: (j.requests || []).map(normReq) };
}
function load() {
  if (cache) return cache;
  let text = null;
  try { if (fs.existsSync(FILE())) text = fs.readFileSync(FILE(), 'utf8'); }
  catch (e) { loadErr.set(`읽기 실패(${String(e?.code || e?.message || e).slice(0, 40)})`); return null; }
  if (text == null) {
    loadErr.checkCorruptOnly(FILE());
    if (loadErr.get()) return null;
    cache = { requests: [] };
    return cache;
  }
  try { cache = norm(JSON.parse(text)); loadErr.clear(); }
  catch (e) { preserveCorrupt(FILE(), e?.message); loadErr.set(e); cache = null; return null; }
  return cache;
}
export function _resetApprovalsForTest() { cache = null; loadErr.clear(); }
export function approvalsLoadError() { load(); return loadErr.get(); }
const unreadable = () => {
  load();
  return loadErr.get() ? { ok: false, code: 'approvals-unreadable', status: 503, reason: `승인 기록 파일(${APPROVALS_FILE_NAME})을 읽지 못해 요청 · 승인을 받지 않습니다 — 손상 보존본(${APPROVALS_FILE_NAME}.corrupt.*)을 확인하세요.` } : null;
};
function commit(next) {
  // 끝난 요청은 최근 MAX_HISTORY 개만(대기 중인 것은 버리지 않는다).
  const open = next.requests.filter((r) => r.status === OPEN);
  // 자르는 순서는 **끝난 시각**(decidedAt) — 오래 기다린 요청을 지금 결정하면 그 기록이 바로 잘리던 것(점검 C-9 — 요청 시각 순이었다).
  const done = next.requests.filter((r) => r.status !== OPEN).sort((a, b) => (a.decidedAt || a.requestedAt) - (b.decidedAt || b.requestedAt)).slice(-MAX_HISTORY);
  const out = { requests: [...done, ...open].sort((a, b) => a.requestedAt - b.requestedAt) };
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    atomicWriteFileSync(FILE(), JSON.stringify(out), { mode: 0o600 });
  } catch (e) { return { ok: false, code: 'write-failed', status: 500, reason: `승인 기록을 쓰지 못했습니다(${String(e?.code || e?.message || e).slice(0, 60)}).` }; }
  cache = out; loadErr.clear();
  return { ok: true };
}
const draft = () => ({ requests: load().requests.map((r) => ({ ...r, payload: { ...r.payload } })) });
const view = (r) => ({ ...r, payload: { ...r.payload } });

/**
 * 요청을 만든다. 같은 종류 · 같은 대상의 대기 중 요청이 있으면 거절(중복 요청으로 승인자를 헷갈리게 하지 않는다).
 * @param {{kind:string, title:string, target:string, corp?:string, payload?:object, by:string, ttlMs?:number}} o
 */
export function createRequest({ kind, title, target, corp = '', payload = {}, by, ttlMs = REQUEST_TTL_MS } = {}, { now = Date.now() } = {}) {
  const u = unreadable(); if (u) return u;
  const k = t(kind, 40); const who = t(by, 64); const tg = t(target, 200);
  if (!KIND_RE.test(k)) return { ok: false, code: 'bad-kind', reason: '요청 종류가 올바르지 않습니다.' };
  if (!who) return { ok: false, code: 'no-user', status: 403, reason: '요청한 계정을 알 수 없습니다.' };
  if (!isObj(payload)) return { ok: false, code: 'bad-payload', reason: '요청 본문이 올바르지 않습니다.' };
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) return { ok: false, code: 'bad-payload', reason: '요청 본문이 너무 큽니다.' };
  const d = draft();
  const open = d.requests.filter((r) => r.status === OPEN && r.expiresAt > now);
  if (open.length >= MAX_PENDING) return { ok: false, code: 'too-many', status: 409, reason: '승인 대기 요청이 너무 많습니다 — 먼저 처리하세요.' };
  // 요청자마다 상한(2회차 A2 — 한 사람이 대기 상한을 다 채워 다른 사람의 승인 요청을 막았다).
  if (open.filter((r) => identityKey(r.requestedBy) === identityKey(who)).length >= MAX_PENDING_PER_USER) return { ok: false, code: 'too-many', status: 409, reason: `내가 만든 승인 대기 요청이 ${MAX_PENDING_PER_USER}건입니다 — 먼저 처리하거나 취소하세요.` };
  const dup = open.find((r) => r.kind === k && r.target === tg);
  if (dup) return { ok: false, code: 'dup-request', status: 409, reason: `같은 요청이 이미 승인을 기다리고 있습니다(${dup.requestedBy} · ${new Date(dup.requestedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC).`, request: view(dup) };
  const req = normReq({
    id: `ap_${crypto.randomBytes(6).toString('hex')}`, kind: k, title: t(title, 200), target: tg, corp: t(corp, 128), payload,
    requestedBy: who, requestedAt: now, expiresAt: now + Math.max(60_000, Math.min(7 * 24 * 3600_000, Number(ttlMs) || REQUEST_TTL_MS)), status: OPEN,
  });
  d.requests.push(req);
  const c = commit(d); if (!c.ok) return c;
  return { ok: true, request: view(req) };
}

/** 목록(최신 먼저). 시한이 지난 대기 요청은 ‘expired’ 로 보인다(파일은 expireDue 가 바꾼다). */
export function listRequests({ kinds = null, includeDone = true, limit = 200 } = {}, { now = Date.now() } = {}) {
  const d = load();
  if (!d) return [];
  return d.requests
    .filter((r) => (!kinds || kinds.includes(r.kind)) && (includeDone || r.status === OPEN))
    .map((r) => (r.status === OPEN && r.expiresAt <= now ? { ...view(r), status: 'expired' } : view(r)))
    .filter((r) => includeDone || r.status === OPEN)
    .sort((a, b) => b.requestedAt - a.requestedAt).slice(0, Math.max(1, Math.min(500, limit)));
}
/** 화면용 — 대기 중인 요청은 **전부**(상한 MAX_PENDING), 끝난 요청은 최근 doneLimit 개(점검 E-1 — 합쳐서 자르면 대기 요청이 끝난 요청에 밀려 보이지 않았다). */
export function listForView({ kinds = null, doneLimit = 60 } = {}, { now = Date.now() } = {}) {
  const all = listRequests({ kinds, includeDone: true, limit: 500 }, { now });
  const open = all.filter((r) => r.status === OPEN);
  const done = all.filter((r) => r.status !== OPEN).slice(0, Math.max(0, doneLimit));
  return [...open, ...done];
}
export function getRequest(id) { const r = load()?.requests.find((x) => x.id === t(id, 20)); return r ? view(r) : null; }

/**
 * 승인 · 돌려보내기. 승인은 **요청한 사람이 아닌 계정**만, 본 digest 가 같을 때만, 시한 안에서만.
 * @returns {{ok:true, request:object} | {ok:false, code:string, status?:number, reason:string}}
 */
export function decide(id, { by, approve, digest = '', note = '' } = {}, { now = Date.now() } = {}) {
  const u = unreadable(); if (u) return u;
  const who = t(by, 64);
  if (!who) return { ok: false, code: 'no-user', status: 403, reason: '승인하는 계정을 알 수 없습니다.' };
  const d = draft();
  const r = d.requests.find((x) => x.id === t(id, 20));
  if (!r) return { ok: false, code: 'not-found', status: 404, reason: '요청을 찾을 수 없습니다.' };
  if (r.status !== OPEN) return { ok: false, code: 'not-pending', status: 409, reason: '이미 처리된 요청입니다.' };
  if (r.expiresAt <= now) return { ok: false, code: 'expired', status: 409, reason: '요청의 시한(24시간)이 지났습니다 — 다시 요청하세요.' };
  if (approve) {
    if (identityKey(who) === identityKey(r.requestedBy)) return { ok: false, code: 'self-approve', status: 403, reason: '요청한 사람은 승인할 수 없습니다 — 다른 설정 소유자가 승인해야 합니다.' };
    if (t(digest, 64) !== r.digest) return { ok: false, code: 'digest-mismatch', status: 409, reason: '화면에서 본 요청 내용과 다릅니다 — 다시 읽은 뒤 승인하세요.' };
  }
  r.status = approve ? 'approved' : (identityKey(who) === identityKey(r.requestedBy) ? 'cancelled' : 'rejected');
  r.decidedBy = who; r.decidedAt = now; r.note = t(note, 300);
  const c = commit(d); if (!c.ok) return c;
  return { ok: true, request: view(r) };
}

/** 승인된 요청의 실행 결과를 적는다(approved → executed | failed). */
export function markExecuted(id, result = {}, { now = Date.now() } = {}) {
  const u = unreadable(); if (u) return u;
  const d = draft();
  const r = d.requests.find((x) => x.id === t(id, 20));
  if (!r || r.status !== 'approved') return { ok: false, code: 'not-approved', status: 409, reason: '승인된 요청이 아닙니다.' };
  r.status = result.ok === true ? 'executed' : 'failed';
  r.result = { ok: result.ok === true, code: t(result.code, 40), reason: t(result.reason, 300) };
  r.decidedAt = r.decidedAt || now;
  return commit(d);
}

/** 시한이 지난 대기 요청을 ‘expired’ 로 확정하고 그 목록을 돌려준다(호출부가 뒷정리 — 예: 승인 대기 키 삭제). 바뀐 것이 없으면 쓰지 않는다. */
export const INTERRUPTED_MS = 10 * 60_000;
export function expireDue({ now = Date.now() } = {}) {
  if (unreadable()) return [];
  const d = draft();
  const due = d.requests.filter((r) => r.status === OPEN && r.expiresAt <= now);
  // 승인은 됐지만 실행 결과가 적히지 않은 요청(실행 중 포탈이 멈춤) — 10분이 지나면 ‘failed(중단)’ 로 확정한다(영원히 ‘승인됨’ 으로 남아 승인 대기 키가 갇히지 않게).
  const stuck = d.requests.filter((r) => r.status === 'approved' && r.decidedAt && r.decidedAt + INTERRUPTED_MS <= now);
  if (!due.length && !stuck.length) return [];
  for (const r of due) { r.status = 'expired'; r.decidedAt = now; }
  // 실행이 됐는지 모른다(실행 뒤 기록 쓰기만 실패했을 수도 있다 — 점검 C-8) — ‘실행 여부 모름’ 으로 적고, 호출부는 이것을 만료와 다르게 다룬다(interrupted 표지).
  for (const r of stuck) { r.status = 'failed'; r.result = { ok: false, code: 'interrupted', reason: '승인 뒤 실행 결과가 적히지 않았습니다(실행 중 포탈이 멈췄거나 결과 기록을 쓰지 못함) — 실행됐는지 확인한 뒤 필요하면 다시 요청하세요.' }; }
  return commit(d).ok ? [...due.map(view), ...stuck.map((r) => ({ ...view(r), interrupted: true }))] : [];
}
