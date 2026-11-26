/**
 * idrac/eventSub.js — 물리서버 **장애 바로 받기**(Redfish 이벤트 구독 · v3.52 · 설계 docs/design/bm-feature-proposals ⑬). 기본 **꺼짐**.
 *
 *  · 노드마다(중앙 · 법인 엣지) **자기 등록부의 iDRAC** 에만 구독을 건다 — 장비가 그 노드로 이벤트를 보낸다(백업 · 수집처럼 법인 로컬).
 *    이벤트를 받으면 그 노드가 부품 장애 점검을 **바로** 한 번 돈다(중앙 = 판정 · 엣지 = 중앙으로 push) — 주기를 기다리지 않는다.
 *    이벤트 글자 자체로 장애를 판정하지 않는다(판정은 지금처럼 부품 장애 점검이 한다 — 이벤트는 ‘지금 다시 보라’ 는 신호).
 *  · 받는 주소는 사용자 인증이 없다(장비가 우리 세션을 가질 수 없다). 그래서
 *      ① 주소에 노드 비밀(32바이트 · timingSafeEqual)을 넣고 · ② 구독의 Context 에 서버 id 와 그 HMAC 을 넣어 받은 이벤트의 서버를 확인하고 ·
 *      ③ 꺼져 있거나 비밀이 틀리면 404(있는지 밝히지 않는다) · ④ 본문 64KB · 한 번에 이벤트 32건 · 글자 상한 · 제어 문자 제거 ·
 *      ⑤ 점검은 30초에 한 번으로 묶는다(이벤트 폭주가 점검 폭주가 되지 않게) · ⑥ 받은 것은 메모리 고리(최근 200건)에만 — 파일에 쓰지 않는다.
 *    비밀이 새면 누구나 ‘다시 보라’ 신호만 보낼 수 있다(장애를 지어낼 수 없다 — 판정은 장비를 다시 읽는다). 비밀은 설정에서 바꿀 수 있다(바꾸면 다시 구독).
 *  · 구독 걸기 · 지우기는 장비 설정을 바꾼다 — 전체 범위 관리자 + 본인 OTP · 감사(라우트). 장비마다 시한 30초 · 동시 4대 · 인증 실패로 멈춘 서버는 건너뛴다 ·
 *    같은 받는 주소 꼴(…/api/bm-events/in/)의 옛 구독은 지우고 하나만 둔다(다시 걸어도 쌓이지 않게).
 *  · 장비 응답 꼴(iDRAC 9 · iLO 의 EventService)은 실장비로 확인하지 못했다 — 장비가 거절하면 그 사유를 그대로 보인다.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { makeJsonFileLoader } from '../util/jsonFileLoad.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { numOrNull } from '../util/numOrNull.js';
import { sealSecret, openSecret } from '../security/secretVault.js';
import { pushAll } from '../util/pushAll.js';
import { poolSettled } from '../util/pool.js';

const FILE = () => path.join(config.configDir, 'bm-events.json');
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
export const EVT_PATH = '/api/bm-events/in/';
export const EVT_BODY_MAX = 64 * 1024;
export const EVT_PER_POST = 32;
export const EVT_RING = 200;
export const EVT_DEBOUNCE_MS = 30_000;
export const SUB_TIMEOUT_MS = 30_000;
export const SUB_CONCURRENCY = 4;
export const EVT_BATCH_MAX = 500;   // 한 번 ‘바로 점검’ 에서 다시 읽는 서버 상한(넘친 것은 정규 주기 — deferred 로 센다)
export const SUB_SERVERS_MAX = 2000;
// 글자 · 수만(객체 · 배열은 '' — String({toString:1}) 이 던지던 길 · 반증 A6)
const t = (v, n) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, n);
const newSecret = () => crypto.randomBytes(32).toString('base64url');

/**
 * 받는 주소의 앞(장비가 닿을 수 있는 이 노드의 주소) — https · 호스트(글자 · 숫자 · 점 · 하이픈 또는 IPv4) · 포트 선택 · 경로 · 질의 · 조각 없음 · 200자.
 * 반환: { ok, value } 또는 { ok:false, reason }.
 */
export function normalizeBase(v) {
  const s = String(v ?? '').trim().replace(/\/$/, '');
  if (!s) return { ok: true, value: '' };
  if (s.length > 200) return { ok: false, reason: '받는 주소가 너무 깁니다(200자까지).' };
  const m = /^https:\/\/([A-Za-z0-9.-]{1,190})(?::(\d{1,5}))?$/.exec(s);
  if (!m) return { ok: false, reason: '받는 주소는 https://호스트[:포트] 꼴이어야 합니다(경로 · 질의 없이 — 장비가 닿을 수 있는 이 노드의 주소).' };
  if (m[2] && (Number(m[2]) < 1 || Number(m[2]) > 65535)) return { ok: false, reason: '포트는 1~65535 입니다.' };
  if (/^\.|\.\.|\.$|^-|-$/.test(m[1])) return { ok: false, reason: '호스트 이름이 틀렸습니다.' };
  return { ok: true, value: `https://${m[1].toLowerCase()}${m[2] ? `:${Number(m[2])}` : ''}` };
}
export const emptyEventSub = () => ({ v: 1, enabled: false, base: '', secret: '', ctxKey: '', prevCtxKey: '', at: null, by: '' });
const KEY_RE = /^[A-Za-z0-9_-]{32,64}$/;
// 비밀 둘: secret(받는 주소 — 장비가 평문으로 갖는다) · ctxKey(Context HMAC 열쇠 — 장비에 주지 않는다: 장비 하나가 다른 서버 Context 를 만들지 못하게 · 반증 A9).
//   파일에는 비밀 금고 정책대로 봉인해 쓴다(sealSecret — 반증 A16). 못 열거나 꼴이 아니면 '' → 꺼짐.
const keyOf = (v) => { const x = typeof v === 'string' ? openSecret(v) : ''; return typeof x === 'string' && KEY_RE.test(x) ? x : ''; };
const shape = (d) => {
  if (!isObj(d)) return emptyEventSub();
  const b = normalizeBase(d.base);
  const secret = keyOf(d.secret); const ctxKey = keyOf(d.ctxKey); const prevCtxKey = keyOf(d.prevCtxKey);
  return { v: 1, enabled: d.enabled === true && b.ok && !!b.value && !!secret && !!ctxKey, base: b.ok ? b.value : '', secret, ctxKey, prevCtxKey, at: numOrNull(d.at), by: typeof d.by === 'string' ? d.by.slice(0, 80) : '' };
};
const parse = (text) => { const v = JSON.parse(text); if (!isObj(v)) throw new Error('형식이 아닙니다(객체여야 합니다)'); if (v.v !== undefined && v.v !== 1) throw new Error('이 판이 모르는 파일 판 번호입니다'); return v; };
const _file = makeJsonFileLoader(FILE, { label: '물리서버 이벤트 구독 설정', tag: 'bm-events', parse, confirm: () => eventSubStore._confirm() });
let _cache = null;
export const eventSubStore = {
  get() {
    if (_cache && !_file.recheckDue()) return _cache;
    const r = _file.load();
    if (r.kind === 'read-error') return emptyEventSub();
    _cache = r.kind === 'ok' ? shape(r.value) : emptyEventSub();
    return _cache;
  },
  loadError: () => { eventSubStore.get(); return _file.loadError(); },
  refusal: () => { eventSubStore.get(); return _file.refusal('물리서버 이벤트 구독 설정'); },
  /** 저장 — enabled · base · rotate(비밀 새로). 켜려면 받는 주소가 있어야 한다. 비밀은 처음 저장 · rotate 때 만든다. */
  save({ enabled, base, rotate = false } = {}, { by = '', now = Date.now() } = {}) {
    const refused = eventSubStore.refusal();
    if (refused) return { ok: false, status: 409, ...refused };
    if (typeof enabled !== 'boolean' || (rotate !== undefined && typeof rotate !== 'boolean')) return { ok: false, status: 400, reason: 'enabled · rotate 는 참/거짓이어야 합니다.' };
    const b = normalizeBase(base);
    if (!b.ok) return { ok: false, status: 400, reason: b.reason };
    if (enabled && !b.value) return { ok: false, status: 400, reason: '켜려면 받는 주소가 있어야 합니다.' };
    const cur = eventSubStore.get();
    const fresh = rotate || !cur.secret || !cur.ctxKey;
    // 비밀을 새로 만들면 Context 열쇠도 새로 만든다(구독 한 벌에 둘이 함께 있어 함께 샌다 — 옛 Context 를 받지 않게).
    //   직전 열쇠(prevCtxKey)는 구독 걸기 · 지우기의 ‘이 포탈 것’ 판정에만 쓴다 — 받는 주소 · 비밀을 한 번에 바꾼 뒤에도 옛 구독을 지울 수 있게(디버깅 3회차 보안 #3 · 4회차 설계 보완).
    const rotating = fresh && !!cur.ctxKey;
    const next = { v: 1, enabled, base: b.value, secret: fresh ? newSecret() : cur.secret, ctxKey: fresh ? newSecret() : cur.ctxKey, prevCtxKey: rotating ? cur.ctxKey : (cur.prevCtxKey || ''), at: now, by: String(by).slice(0, 80) };
    try {
      fs.mkdirSync(path.dirname(FILE()), { recursive: true });
      atomicWriteFileSync(FILE(), JSON.stringify({ ...next, secret: sealSecret(next.secret), ctxKey: sealSecret(next.ctxKey), prevCtxKey: next.prevCtxKey ? sealSecret(next.prevCtxKey) : '' }, null, 2), { mode: 0o600 });
    } catch (e) { return { ok: false, status: 500, reason: `설정 파일을 쓰지 못했습니다 — ${String(e?.code || e?.message || e).slice(0, 120)}` }; }
    _cache = shape(next); _file.saved();
    return { ok: true, value: _cache, rotated: !!cur.secret && next.secret !== cur.secret };   // 처음 만든 비밀은 ‘새로 만듦’ 이 아니다(다시 구독하라고 하지 않게)
  },
  _confirm() { atomicWriteFileSync(FILE(), JSON.stringify(emptyEventSub(), null, 2)); _cache = null; _file.saved(); },
  _resetForTest() { _cache = null; _file.resetRetry(); },
};
/** 화면용(비밀은 싣지 않는다 — 있는지만). */
export const eventSubPublic = (s = eventSubStore.get()) => ({ enabled: s.enabled, base: s.base, hasSecret: !!s.secret, at: s.at, by: s.by });

// ───────── 받는 주소 · Context(순수) ─────────
/** 로그 · 성능 표에 싣는 경로에서 받는 주소의 비밀을 지운다(요청 기록 · 처리 안 된 오류 기록 — index.js). 대소문자 무시(express 라우팅과 같게). */
//   절대 꼴 요청 대상(‘POST http://host/api/bm-events/in/…’)도 지운다 — 앞에 고정하지 않는다(반증 A7).
//   빗금이 겹친 꼴(‘/api/bm-events//in/…’ · ‘/in//…’)도 — express 가 받는 꼴이면 기록에서도 지운다(디버깅 1회차 보안 #5).
// 겹친 빗금(//api//bm-events//in//…)도 지운다. 맞춤은 ‘api 바로 앞 빗금 하나’ 에서 시작한다 — 앞에 \/+ 를 두면 빗금만 긴 경로에서 시작점마다 되짚어 O(n²) 였다
//   (디버깅 2회차 보안 #3 · 엣지 #1: 빗금 16,000개에 110~134ms — 인증 전 모든 요청의 기록 단계). 길이도 먼저 자른다(기록에 4KB 넘는 경로를 싣지 않는다).
//   백슬래시 꼴(/api\bm-events\in\<비밀> — express 가 / 로 받는다)도 빗금으로 보고 지운다(디버깅 4회차 보안 #2)
export const scrubEventPath = (p) => String(p ?? '').slice(0, 4096).replace(/\\/g, '/').replace(/(\/api\/+bm-events\/+in\/+)[^/?#\s]*/gi, '$1…');
export const destinationOf = (s) => (s?.base && s?.secret ? `${s.base}${EVT_PATH}${s.secret}` : '');
const hmac = (key, id) => crypto.createHmac('sha256', String(key)).update(String(id)).digest('base64url').slice(0, 16);
/** 구독 Context — `dvc:<서버 id>:<HMAC(ctxKey)>`(장비가 이벤트마다 돌려준다). id 는 등록부 id(길이 상한). */
export const contextOf = (s, id) => `dvc:${String(id).slice(0, 128)}:${hmac(s.ctxKey, String(id).slice(0, 128))}`;
/** Context → 서버 id(HMAC 이 맞을 때만) · 아니면 ''. */
export function idOfContext(s, ctx) {
  const m = /^dvc:(.{1,128}):([A-Za-z0-9_-]{16})$/.exec(String(ctx ?? '').slice(0, 200));
  if (!m || !s?.ctxKey) return '';
  const want = Buffer.from(hmac(s.ctxKey, m[1])); const got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? m[1] : '';
}
/** 주소의 비밀이 맞는가(꺼져 있으면 늘 거짓 · 시간 일정). */
export function secretOk(s, given) {
  if (!s?.enabled || !s.secret) return false;
  const a = Buffer.from(String(s.secret)); const b = Buffer.from(String(given ?? '').slice(0, 128));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const SEV = { critical: 'critical', warning: 'warning', ok: 'ok' };
/**
 * 장비가 보낸 본문 → 정제한 이벤트(최대 EVT_PER_POST). Redfish Event: { Context, Events:[{ EventType, Severity|MessageSeverity, MessageId, Message, EventTimestamp, OriginOfCondition{@odata.id} }] }.
 * 반환: { context, events:[{ sev, msgId, msg, at, origin }], dropped } · 꼴이 아니면 null.
 */
export function parseEventBody(b, now = Date.now()) {
  if (!isObj(b) || !Array.isArray(b.Events)) return null;
  const list = b.Events.filter(isObj);
  const events = list.slice(0, EVT_PER_POST).map((e) => {
    const sv = t(e.MessageSeverity ?? e.Severity, 16).toLowerCase();   // 글자만(객체는 '' — 반증 A6)
    const ts = Date.parse(t(e.EventTimestamp, 40));
    const origin = isObj(e.OriginOfCondition) ? e.OriginOfCondition['@odata.id'] : e.OriginOfCondition;
    return { sev: Object.hasOwn(SEV, sv) ? SEV[sv] : '', msgId: t(e.MessageId, 80), msg: t(e.Message, 300), at: Number.isFinite(ts) ? ts : now, origin: t(origin, 200), type: t(e.EventType, 40) };
  });
  return { context: t(b.Context, 200), events, dropped: Math.max(0, list.length - events.length) };
}
/** 바로 점검할 신호인가 — 위험 · 주의만(정보 · 모름은 기록만). */
export const wantsCheck = (events) => events.some((e) => e.sev === 'critical' || e.sev === 'warning');

// ───────── 받은 기록(메모리) · 바로 점검 ─────────
const _ring = [];
const _stat = { received: 0, rejected: 0, dropped: 0, deferred: 0, checks: 0, rxAt: null, checkedAt: null, running: false };   // deferred — 바로 읽기 상한을 넘어 다음 정규 주기로 미룬 서버(P7)   // dropped — 한 번에 32건을 넘어 버린 수(반증 B13)
let _timer = null; let _pendingReason = ''; let _busyRetries = 0;
const _staleIds = new Set();   // 이번 묶음에서 다시 읽을 서버(위험 · 주의를 보낸 서버)
const _deferredIds = new Set(); // 묶음 상한을 넘어 정규 주기로 미룬 서버(다시 시작 전까지 한 대로 센다 · 상한 5,000)
const DEFAULT_DEPS = {
  now: () => Date.now(),
  debounceMs: EVT_DEBOUNCE_MS,
  /** 바로 점검 — ① 그 서버들의 인벤토리를 다음 폴링에서 다시 읽게 표시하고 ② iDRAC 폴링을 한 번 바로 돌려 **장비를 다시 읽은 뒤** ③ 부품 장애를 판정(중앙) · push(엣지).
   *  캐시만 다시 판정하면(최대 30분 묵은 인벤토리) 빨라지지 않는다(반증 A2). 폴링이 다른 주기로 진행 중이면 busy — 묶음을 다시 잡는다. */
  runCheck: async (reason, ids) => {
    // 강제 재읽기 표지는 **포기할 때만** 세운다(scheduleCheck — 다시 시도를 다 쓴 서버) — 미리 세우면 느린 장비의 인벤토리 읽기가 늘 정규 주기로 넘어갔다(디버깅 5회차 엣지 #3)
    const P = await import('./poller.js');
    // 그 서버들만 읽는다 — 함대 전체 주기를 돌리지 않는다(v3.52 디버깅 1회차 성능 P2: 이벤트 1건에 50대 전부 · 요청 368건이었다)
    const r = await P.pollNowForEvent(ids);
    if (r?.busy) return { busy: true };
    const retry = Array.isArray(r?.skipped) ? r.skipped : [];   // 정규 주기가 그때 읽고 있던 서버 — 그 서버만 다시 잡는다(5회차 엣지 #1)
    // 판정은 여기서 한 번 — 이벤트 읽기는 폴러의 파트 장애 훅을 부르지 않는다(성능 P5: 두 번 돌고 엣지는 WAN push 두 번이었다). 다시 읽은 것이 없으면 판정할 새 값이 없다
    if (!(Number(r?.invRefreshed) > 0)) return { busy: false, refreshed: 0, retry };
    if (config.agent.centralUrl) await (await import('../partfault/push.js')).pushPartFaultsNow({ reason });
    else await (await import('../partfault/poller.js')).runPartFaultsNow({ reason });
    return { busy: false, refreshed: Number(r.invRefreshed), retry };
  },
};
let _deps = DEFAULT_DEPS;
export function _setEventDepsForTest(d) { _deps = d ? { ...DEFAULT_DEPS, ...d } : DEFAULT_DEPS; }
export function _resetEventsForTest() { _ring.length = 0; _staleIds.clear(); _deferredIds.clear(); _busyRetries = 0; Object.assign(_stat, { received: 0, rejected: 0, dropped: 0, deferred: 0, checks: 0, rxAt: null, checkedAt: null, running: false }); if (_timer) clearTimeout(_timer); _timer = null; _pendingReason = ''; }
export const noteRejected = () => { _stat.rejected += 1; };
export const noteUnreadable = () => { _stat.unreadable = (_stat.unreadable || 0) + 1; };   // 설정 · 등록부를 못 읽어 503 으로 답한 수(거절과 따로)
const BUSY_RETRY_MAX = 5;
/**
 * 바로 점검 — 묶음 간격(debounceMs) 안에 여러 번 와도 한 번. 간격은 **앞 점검이 끝난 때부터** 잰다(점검이 길어도 쉬지 않고 연달아 돌지 않게 — 반증 A14).
 * 점검 중에 온 신호는 끝난 뒤 한 번 더로 묶는다. 폴링이 바빠 못 돌았으면 간격 뒤 다시(최대 BUSY_RETRY_MAX 번).
 */
function scheduleCheck(reason) {
  _pendingReason = reason;
  if (_timer || _stat.running) return false;
  const gap = _deps.debounceMs;
  const since = _stat.checkedAt == null ? Infinity : _deps.now() - _stat.checkedAt;
  const wait = since >= gap ? 0 : gap - since;
  _timer = setTimeout(() => {
    _timer = null; _stat.running = true; _stat.checks += 1;
    const ids = [..._staleIds]; _staleIds.clear();   // 미룬 서버 집합은 비우지 않는다 — 다음 묶음에서 또 넘쳐도 한 대로(화면 ‘미룬 서버 N대’ — 다시 시작하면 0 부터: 디버깅 3회차 화면 R3)
    Promise.resolve().then(() => _deps.runCheck(_pendingReason || 'event', ids)).then(async (r) => {
      const left = r?.busy ? ids : (Array.isArray(r?.retry) ? r.retry : []);
      if (left.length && _busyRetries < BUSY_RETRY_MAX) { _busyRetries += 1; for (const id of left) _staleIds.add(id); return true; }
      // 다시 시도를 다 썼다 — 그 서버들은 다음 정규 주기가 인벤토리를 다시 읽게 표시한다(잃지 않음 · urgent 표지)
      if (left.length) { try { const C = await import('./invCache.js'); for (const id of left) C.markInventoryStale(id, { event: true }); } catch { /* 표시 실패가 점검을 막지 않는다 */ } }
      _busyRetries = 0; return false;
    }, (e) => { console.warn(`[bm-events] 바로 점검 실패 — ${String(e?.message || e).slice(0, 160)}`); return false; }).then((again) => {
      _stat.running = false; _stat.checkedAt = _deps.now();
      if (again || _staleIds.size) scheduleCheck(_pendingReason || 'event');
    });
  }, wait);
  _timer.unref?.();
  return true;
}
/**
 * 받은 이벤트 처리(라우트가 비밀 · 본문 · 등록부를 확인한 뒤). 서버를 모르면(Context HMAC 틀림) 기록하지 않고 거절 수만 센다.
 * @returns {{ ok:boolean, accepted:number, check:boolean }}
 */
export function acceptEvents(s, parsed, { name = '' } = {}) {
  const id = idOfContext(s, parsed?.context);
  if (!id) { _stat.rejected += 1; return { ok: false, accepted: 0, check: false }; }
  const now = _deps.now();
  for (const e of parsed.events) {
    _ring.push({ id, name: String(name || id).slice(0, 128), ...e, rx: now });
    if (_ring.length > EVT_RING) _ring.splice(0, _ring.length - EVT_RING);
  }
  _stat.received += parsed.events.length; _stat.dropped += Math.max(0, Number(parsed.dropped) || 0); _stat.rxAt = now;
  const check = wantsCheck(parsed.events);
  if (check) {
    // 한 묶음에 바로 읽는 서버는 EVT_BATCH_MAX 대까지 — 넘친 서버는 버리지 않고 **다음 정규 주기(1분)** 가 인벤토리를 다시 읽게 표시하고 센다(v3.52 디버깅 1회차 성능 P7)
    if (_staleIds.has(id) || _staleIds.size < EVT_BATCH_MAX) _staleIds.add(id);
    else {
      // 같은 서버가 여러 번 보내도 한 대로 센다(디버깅 2회차 엣지 #10 — 화면이 ‘미룬 서버 N대’ 라고 말한다)
      if (!_deferredIds.has(id) && _deferredIds.size < 5000) { _deferredIds.add(id); _stat.deferred += 1; }
      import('./invCache.js').then((C) => C.markInventoryStale(id, { event: true }), () => {});
    }
    scheduleCheck('event');
  }
  return { ok: true, accepted: parsed.events.length, check };
}
/** 화면용 — 최근 받은 것(새 것부터) · 셈 · 고리 길이(상한 확인용). 서버 이름은 라우트가 판본에 맞게 가린다. */
export const eventStatus = () => ({ ..._stat, ringSize: _ring.length, recent: _ring.slice(-EVT_RING).reverse() });

// ───────── 구독 걸기 · 지우기(장비 설정을 바꾼다) ─────────
/**
 * 한 장비 — 같은 받는 주소 꼴의 옛 구독을 지우고(unsubscribe 면 지우기만) 새로 하나 건다.
 * @returns {Promise<{ id, status:'subscribed'|'removed'|'none'|'auth-stopped'|'auth'|'timeout'|'error'|'not-supported', removed:number, message?:string }>}
 */
/** 장비 오류 글자가 받는 주소를 되돌려 주면 비밀이 결과 · 화면에 실린다 — 지운다(반증 A8). */
export const scrubSecret = (msg, s) => { let m = String(msg ?? ''); for (const k of [s?.secret, s?.ctxKey, s?.prevCtxKey]) if (k) m = m.split(k).join('…'); return scrubEventPath(m); };
export async function syncOne(entry, s, { unsubscribe = false, getJson = null, send = null, authStopped = null, timeoutMs = SUB_TIMEOUT_MS } = {}) {
  const id = String(entry?.id ?? '');
  let stopped = false;
  try { stopped = typeof authStopped === 'function' ? !!(await authStopped(entry)) : !!(await import('./poller.js')).idracAuthStopFor(entry); } catch { stopped = false; }
  if (stopped) return { id, status: 'auth-stopped', removed: 0, message: 'iDRAC 인증 실패로 주기 수집이 멈춘 서버 — 장비에 묻지 않았습니다.' };
  const [{ withDeadline }, rf] = await Promise.all([import('../util/deadline.js'), import('./redfish.js')]);
  const G = getJson || rf.redfishGetCapped; const S = send || rf.redfishSend;
  try {
    return await withDeadline(timeoutMs, async (signal) => {
      let col;
      try { col = await G(entry, '/redfish/v1/EventService/Subscriptions', { signal }); } catch (e) {
        if (e?.status === 404) return { id, status: 'not-supported', removed: 0, message: '장비가 이벤트 구독(EventService)을 알려 주지 않았습니다.' };
        throw e;
      }
      const members = (Array.isArray(col?.Members) ? col.Members : []).map((m) => String(m?.['@odata.id'] ?? '')).filter((p) => /^\/redfish\/v1\/EventService\/Subscriptions\/[A-Za-z0-9._-]{1,128}\/?$/.test(p)).slice(0, 32);
      let removed = 0;
      for (const p of members) {
        // eslint-disable-next-line no-await-in-loop
        const sub = await G(entry, p, { signal }).catch(() => null);
        const dest = String(sub?.Destination ?? '');
        // 이 포탈이 건 것만 — 같은 받는 주소 앞이거나, 받는 주소를 바꾼 뒤의 옛 구독(Context 가 이 포탈의 열쇠로 맞는다 — 디버깅 2회차 보안 #4).
        //   다른 도구 · 다른 포탈의 구독은 건드리지 않는다(디버깅 1회차 보안 #6 — 다른 포탈은 Context 열쇠가 다르다)
        const ctxMine = idOfContext(s, sub?.Context) === String(id) || (!!s.prevCtxKey && idOfContext({ ctxKey: s.prevCtxKey }, sub?.Context) === String(id));
        const mine = (s.base && dest.startsWith(`${s.base}${EVT_PATH}`)) || (dest.includes(EVT_PATH) && ctxMine);
        if (!mine) continue;
        if (!unsubscribe && s.base && dest === destinationOf(s) && String(sub?.Context ?? '') === contextOf(s, id)) continue;   // 이미 같은 것 — 둔다
        // eslint-disable-next-line no-await-in-loop
        const r = await S(entry, 'DELETE', p, null, { signal });
        if (r.status === 401) return { id, status: 'auth', removed, message: 'iDRAC 인증 실패(401) — 다시 보내지 않았습니다.' };
        if (r.ok || r.status === 404) removed += 1;
      }
      if (unsubscribe) return { id, status: removed ? 'removed' : 'none', removed };
      // 이미 같은 구독이 남아 있으면 새로 걸지 않는다
      for (const p of members) {
        // eslint-disable-next-line no-await-in-loop
        const sub = await G(entry, p, { signal }).catch(() => null);
        if (sub && String(sub.Destination ?? '') === destinationOf(s) && String(sub.Context ?? '') === contextOf(s, id)) return { id, status: 'subscribed', removed, message: '이미 걸려 있습니다.' };
      }
      const body = { Destination: destinationOf(s), Protocol: 'Redfish', Context: contextOf(s, id), EventTypes: ['Alert'] };
      const r = await S(entry, 'POST', '/redfish/v1/EventService/Subscriptions', body, { signal });
      if (r.status === 401) return { id, status: 'auth', removed, message: 'iDRAC 인증 실패(401) — 다시 보내지 않았습니다.' };
      if (!r.ok) {
        const { redfishErrorText } = await import('./power.js');
        return { id, status: 'error', removed, message: redfishErrorText(r.text) || `장비가 거절했습니다(${r.status}).` };
      }
      return { id, status: 'subscribed', removed };
    }, '장비 요청 시한 초과');
  } catch (e) {
    const msg = String(e?.message || e);
    if (e?.status === 401 || e?.authFailed) return { id, status: 'auth', removed: 0, message: 'iDRAC 인증 실패(401) — 다시 보내지 않았습니다.' };
    if (/시한 초과|timeout|abort/i.test(msg)) return { id, status: 'timeout', removed: 0, message: '장비가 시한 안에 답하지 않았습니다.' };
    return { id, status: 'error', removed: 0, message: `장비에 보내지 못했습니다 — ${t(msg, 160)}` };
  }
}
let _syncBusy = false;
/** 이 노드 등록부의 켜진 iDRAC 전부(동시 SUB_CONCURRENCY). 진행 중이면 거절. */
export async function syncAll({ unsubscribe = false, entries = null, one = syncOne } = {}) {
  if (_syncBusy) return { ok: false, busy: true, reason: '구독 걸기 · 지우기가 이미 진행 중입니다.' };
  if (!entries && eventSubStore.loadError()) return { ok: false, reason: '구독 설정 파일(bm-events.json)을 읽지 못했습니다 — 이 포탈이 건 구독을 알아볼 수 없어 걸거나 지우지 않았습니다(서비스 점검에서 확인).' };
  const s = eventSubStore.get();
  if (!unsubscribe && (!s.enabled || !destinationOf(s))) return { ok: false, reason: '켜고 받는 주소를 저장한 뒤 구독을 거십시오.' };
  _syncBusy = true;
  try {
    let regList = entries;
    if (!regList) {
      const R = await import('./registry.js');
      if (R.registryLoadError()) return { ok: false, reason: 'iDRAC 등록부를 읽지 못했습니다 — 대상 서버를 모르는 채 걸지 않았습니다(서비스 점검에서 등록부를 확인).' };   // ‘대상 0대’ 로 끝내지 않는다(디버깅 2회차 엣지 #5)
      regList = R.loadRegistry();
    }
    const list = regList.filter((e) => e && e.enabled !== false && e.host).slice(0, SUB_SERVERS_MAX);
    // 데모(mock) — 장비에 보내지 않는다(합성 등록부의 주소로 나가지 않게 · 전원과 같은 규칙)
    if (!entries && (await import('../mock/demo/flags.js')).isMockMode()) return { ok: true, results: list.map((e) => ({ id: String(e.id), name: String(e.name || e.id).slice(0, 128), status: 'demo', removed: 0, message: '데모 — 장비에 보내지 않았습니다.' })) };
    // 동시 SUB_CONCURRENCY 대 — 묶음(4대씩 끝날 때까지 기다림)이 아니라 풀: 한 대가 시한까지 가도 나머지 자리가 놀지 않는다(v3.52 디버깅 1회차 성능 P6 · util/pool.js 하나)
    const settled = await poolSettled(list, SUB_CONCURRENCY, (e) => one(e, s, { unsubscribe }));
    const out = [];
    pushAll(out, settled.map((x, i) => {
      const e = list[i];
      const r = x.status === 'fulfilled' && x.value && typeof x.value === 'object' ? x.value : { id: String(e.id), status: 'error', removed: 0, message: String(x.reason?.message || x.reason || '알 수 없는 오류').slice(0, 300) };
      return { ...r, name: String(e.name || e.id).slice(0, 128), ...(r.message ? { message: scrubSecret(r.message, s) } : {}) };
    }));   // 인벤토리 규모 배열 — 펼침 push 금지(audit2603a)
    return { ok: true, results: out };
  } finally { _syncBusy = false; }
}

// ───────── 뒤에서 돌리기(장비가 많으면 수 분 — 요청을 붙잡지 않는다) ─────────
let _sync = null;   // { running, startedAt, doneAt, unsubscribe, by, results?, error? }
/** 구독 걸기 · 지우기를 뒤에서 시작. 진행 중이면 거절. onDone(결과) — 라우트가 감사를 남긴다. */
/** 시작 전 판정(라우트가 OTP 앞에서 부른다) — null 이면 시작할 수 있다. */
export function syncPrecheck({ unsubscribe = false } = {}) {
  if (_sync?.running || _syncBusy) return { busy: true, reason: '구독 걸기 · 지우기가 이미 진행 중입니다.' };
  // 설정을 못 읽으면 지우기도 시작하지 않는다 — 빈 설정으로는 이 포탈 구독을 알아보지 못해 ‘지울 것 없음’ 으로 끝나고 OTP · 장비 조회만 썼다(디버깅 4회차 엣지 #3)
  if (eventSubStore.loadError()) return { busy: false, reason: '구독 설정 파일(bm-events.json)을 읽지 못했습니다 — 이 포탈이 건 구독을 알아볼 수 없어 걸거나 지우지 않았습니다(서비스 점검에서 확인).' };
  const s = eventSubStore.get();
  if (!unsubscribe && (!s.enabled || !destinationOf(s))) return { busy: false, reason: '켜고 받는 주소를 저장한 뒤 구독을 거십시오.' };
  return null;
}
export function startSync({ unsubscribe = false, by = '', onDone = null, run = syncAll } = {}) {
  if (_sync?.running) return { ok: false, busy: true, reason: '구독 걸기 · 지우기가 이미 진행 중입니다.' };
  const s = eventSubStore.get();
  if (!unsubscribe && (!s.enabled || !destinationOf(s))) return { ok: false, reason: '켜고 받는 주소를 저장한 뒤 구독을 거십시오.' };
  _sync = { running: true, startedAt: Date.now(), doneAt: null, unsubscribe, by: String(by).slice(0, 80) };
  const me = _sync;
  Promise.resolve().then(() => run({ unsubscribe })).then((r) => {
    Object.assign(me, { running: false, doneAt: Date.now(), ...(r?.ok ? { results: r.results } : { error: String(r?.reason || '실패').slice(0, 200) }) });
    try { onDone?.(me); } catch { /* 감사 실패가 결과를 지우지 않게 */ }
  }, (e) => { Object.assign(me, { running: false, doneAt: Date.now(), error: String(e?.message || e).slice(0, 200) }); try { onDone?.(me); } catch { /* */ } });
  return { ok: true, started: true };
}
export const syncStatus = () => (_sync ? { ..._sync, results: (_sync.results || []).slice(0, SUB_SERVERS_MAX) } : null);
/** 비밀을 새로 만들면 지난 구독 결과는 옛 비밀의 것이다 — 지운다(진행 중이면 두고 · 반증 B9). */
export function clearSyncResults() { if (_sync && !_sync.running) _sync = null; }
export function _resetSyncForTest() { _sync = null; _syncBusy = false; }
