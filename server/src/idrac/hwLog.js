/**
 * idrac/hwLog.js — 물리서버 **하드웨어 이벤트 로그(SEL)** 보기(v3.49 · 설계 docs/design/bm-feature-proposals ⑤).
 *
 *  · 드로어를 열 때 1회 — 그 서버를 **수집하는 노드**가 읽는다(이 노드 서버는 이 노드가 · 엣지 서버는 엣지가 `GET /api/collector/bm-hwlog` 로).
 *    백업 데이터처럼 법인 쪽에서 읽고 결과만 중앙으로 — 중앙이 법인 iDRAC 에 WAN 으로 직접 붙지 않는다(루트 CLAUDE.md ‘작업 하나를 법인 쪽에’).
 *  · 읽기는 디스크 배드 섹터 분석의 SEL 읽기(`diskbad/sel.js readSel` — `$skip` 쪽 넘기기 · 쪽 · 시간 상한 · `$skip` 무시 장비 감지)를 그대로 쓰고,
 *    고르기만 **모든 항목**으로 바꾼다. GET 만 · 장비 상태를 바꾸지 않는다. 장비 시한은 세션을 실제로 끊는다(withDeadline + signal).
 *  · 이번 판은 SEL(시스템 이벤트)만 — 수명주기(Lifecycle) 로그는 수천 건 · 정렬 방향을 장비마다 몰라(`diskbad/lclog.js` 머리말) 최근 N건을
 *    빠르게 보여 줄 방법을 확인하지 못했다(다음 판 후보 — 화면이 밝힌다).
 *  · 내용 글자는 장비가 준 원문이다 — 길이를 먼저 자르고 제어 문자를 지운다. 주소 · 서비스 태그 가림은 중앙 라우트가 판본에 따라 한다(maskHwLogText).
 */
import { numOrNull } from '../util/numOrNull.js';
import { clampEdgeTs } from '../util/clampEdgeTs.js';

export const HWLOG_EVENTS_MAX = 300;     // 화면에 싣는 항목 수(가장 새 것부터)
export const HWLOG_PAGES_MAX = 20;       // 50건 × 20쪽 = 1,000건까지 읽는다(넘으면 ‘일부만 읽음’)
export const HWLOG_BUDGET_MS = 20_000;   // 쪽 사이에서 보는 예산
export const HWLOG_TIMEOUT_MS = 30_000;  // 장비 시한(세션을 끊는다)
export const HWLOG_MSG_MAX = 300;
export const HWLOG_SEVS = Object.freeze(['critical', 'warning', 'ok']);
const MIN_VALID_TIME = Date.UTC(2000, 0, 1);
const clean = (v, n) => String(v ?? '').slice(0, n).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();   // 길이를 먼저 자른 뒤 · 문자 클래스 한 번(선형)

/** Redfish Severity → critical · warning · ok · ''(모름). */
export function sevOf(v) {
  const k = clean(v, 16).toLowerCase();
  return k === 'critical' ? 'critical' : k === 'warning' ? 'warning' : k === 'ok' ? 'ok' : '';
}
/** SEL 항목 하나 → 화면 줄(순수). 글자가 아니거나 객체가 아니면 null. */
export function hwLogRow(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  const c = Date.parse(clean(e.Created, 40));
  const at = Number.isFinite(c) && c >= MIN_VALID_TIME ? c : null;
  // created = readSel 이 가장 새 것부터 고를 때 쓰는 열쇠(결과에서는 뺀다 — at 하나만 싣는다)
  return { at, created: at, sev: sevOf(e.Severity), code: clean(e.MessageId, 64), sensor: clean(e.SensorType, 40), msg: clean(e.Message, HWLOG_MSG_MAX), kind: 'any' };
}
/** 등급별 수(모름은 other). */
export function countsOf(rows) {
  const c = { critical: 0, warning: 0, ok: 0, other: 0 };
  for (const r of Array.isArray(rows) ? rows : []) { const k = HWLOG_SEVS.includes(r?.sev) ? r.sev : 'other'; c[k] += 1; }
  return c;
}

/**
 * 이 노드에 등록된 서버 한 대의 SEL 을 읽는다. 401 은 던지지 않고 상태로 돌려준다(화면이 ‘인증 실패’ 를 말한다 — 자동 재시도 없음).
 * @param {{host:string, username:string, password:string}} entry 등록부 항목
 * @returns {Promise<{ ok:true, at:number, status:string, read:number, total:number|null, pages:number, stopped:string, rows:Array, counts:object }>}
 *   status: ok · empty · absent(경로 없음) · forbidden · auth(인증 실패) · auth-stopped(주 폴러가 인증 실패로 멈춤 — 장비에 묻지 않음) · timeout · error
 */
export async function readHwLog(entry, { getJson = null, now = Date.now, timeoutMs = HWLOG_TIMEOUT_MS, budgetMs = HWLOG_BUDGET_MS, authStopped = null } = {}) {
  // 주 iDRAC 폴러가 인증 실패로 멈춘 서버는 장비에 묻지 않는다 — 틀린 비밀번호로 ‘기록 읽기’ 마다 로그인을 보내지 않게(계정 잠금 · authGuard 규칙.
  //   디스크 배드 섹터 분석 수동 점검과 같은 판정 — v3.49 반증 A13). 판정을 못 하면(모듈 없음) 막지 않는다.
  let stopped = false;
  try {
    stopped = typeof authStopped === 'function' ? !!(await authStopped(entry)) : !!(await import('./poller.js')).idracAuthStopFor(entry);
  } catch { stopped = false; }
  if (stopped) return { ok: true, at: now(), status: 'auth-stopped', read: 0, total: null, pages: 0, stopped: '', gap: 0, rows: [], counts: countsOf([]) };
  const [{ readSel }, { safeMgrPath }, { withDeadline }, rf] = await Promise.all([
    import('../diskbad/sel.js'), import('../diskbad/lclog.js'), import('../util/deadline.js'), import('./redfish.js'),
  ]);
  const G = getJson || rf.redfishGetCapped;
  const at = now();
  try {
    const sel = await withDeadline(timeoutMs, async (signal) => {
      const mgrs = await G(entry, '/redfish/v1/Managers', { signal });
      const mgr = safeMgrPath((Array.isArray(mgrs?.Members) ? mgrs.Members : [])[0]?.['@odata.id']);
      return readSel(entry, { mgr, signal, getJson: G, now, budgetMs, pick: hwLogRow, eventsMax: HWLOG_EVENTS_MAX, pagesMax: HWLOG_PAGES_MAX, tailFirst: true });
    }, '하드웨어 이벤트 로그 읽기 시한 초과');
    const rows = (sel.events || []).map(({ created: _c, kind: _k, ...r }) => r);   // readSel 이 created(= at)로 가장 새 것부터 골랐다
    return { ok: true, at, status: sel.status, read: sel.read, total: sel.total, pages: sel.pages, stopped: sel.stopped || '', gap: sel.gap || 0, rows, counts: countsOf(rows) };
  } catch (e) {
    const status = e?.status === 401 || e?.authFailed === true ? 'auth' : /시한 초과|timeout|abort/i.test(String(e?.message || '')) ? 'timeout' : e?.status === 404 ? 'absent' : e?.status === 403 ? 'forbidden' : 'error';
    return { ok: true, at, status, read: 0, total: null, pages: 0, stopped: '', rows: [], counts: countsOf([]) };
  }
}

/** 엣지 응답 정제(중앙 — 순수). 아는 필드만 · 수는 numOrNull · 등급은 아는 값만 · 글자는 자르고 · 시각은 수신 시각으로 자른다. */
export function sanitizeHwLog(b, now = Date.now()) {
  if (!b || typeof b !== 'object' || Array.isArray(b) || b.ok !== true || !Array.isArray(b.rows)) return null;
  const rows = [];
  for (const r of b.rows.slice(0, HWLOG_EVENTS_MAX)) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const a = numOrNull(r.at);
    rows.push({ at: a != null && a >= MIN_VALID_TIME ? clampEdgeTs(a, now) : null, sev: HWLOG_SEVS.includes(r.sev) ? r.sev : '', code: clean(r.code, 64), sensor: clean(r.sensor, 40), msg: clean(r.msg, HWLOG_MSG_MAX) });
  }
  const STATUSES = ['ok', 'empty', 'absent', 'forbidden', 'auth', 'auth-stopped', 'timeout', 'error'];
  const cnt = (v) => { const x = numOrNull(v); return x != null && x >= 0 && x <= 10_000_000 ? Math.floor(x) : null; };
  return {
    ok: true, at: clampEdgeTs(numOrNull(b.at), now), status: STATUSES.includes(b.status) ? b.status : 'error',
    read: cnt(b.read) ?? rows.length, total: cnt(b.total), pages: cnt(b.pages) ?? 0, gap: cnt(b.gap) ?? 0,
    stopped: ['', 'budget', 'max', 'skip', 'short', 'timeout', 'error'].includes(b.stopped) ? b.stopped : '', rows, counts: countsOf(rows),
  };
}

/**
 * 내용 글자의 장비 주소 · 계정 단서를 가린다(판본에 따라 — 화면은 전체 범위 관리자 판본만 원문, 접수 자료 묶음은 늘 가린다).
 * 가리는 꼴(v3.49 반증 A3 · A9 로 넓힘): IPv4(앞뒤가 낱말 글자여도) · IPv6 · MAC(콜론 · 대시) · 점 둘 이상의 호스트 이름(FQDN — 글자가 든 것만,
 * ‘2.19.1’ 같은 버전은 그대로) · ‘for/using/user 계정 from’ 꼴의 계정 이름(Dell 로그인 기록 꼴) · 이 서버의 서비스 태그(대소문자 무시).
 * 모든 꼴을 보장하지는 않는다(알려진 꼴만 — 문서에 그렇게 적는다). 길이는 먼저 HWLOG_MSG_MAX 로 자르고, 정규식은 낱말 하나 · 길이가 정해진 반복만 쓴다(선형).
 */
const MASK = '•••';
// 옥텟은 0~255 · 앞자리 0 없음 — ‘7.00.00.00’ 같은 펌웨어 판 번호는 가리지 않는다(‘2.10.0.1’ 같은 꼴은 주소와 구별할 수 없어 가린다)
const OCT = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_IN = new RegExp(`(?<![\\d.])${OCT}(?:\\.${OCT}){3}(?![\\d])`, 'g');
const HEXCOLON = /^[0-9a-f:.%]+$/i;
const MAC_DASH = /^[0-9a-f]{2}(?:-[0-9a-f]{2}){5}$/i;
const FQDN = /^[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){2,8}\.?$/i;
const ACCOUNT = /\b(for|using|user|username|account)(\s{1,4})([^\s,]{1,64})(?=,?\s{1,4}from\b)/gi;
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function maskToken(tok0) {
  // 대괄호 IPv6(‘[2001:db8::1]:443’) — 괄호 안만 먼저
  const tok = tok0.includes('[') ? tok0.replace(/\[([0-9a-f:.]{2,64})(%[\w.-]{1,32})?\]/gi, (x, a) => (a.split(':').length >= 3 ? `[${MASK}]` : x)) : tok0;
  // IPv6 · 콜론 MAC — 콜론이 둘 이상이고 16진 · 콜론 · 점(IPv4 꼬리) · %(영역)만으로 된 낱말. ‘12:34’ 같은 시각(콜론 1개)은 그대로 — ‘12:34:56’ 시각도 콜론 2개라 가린다(과하게 가리는 쪽)
  const bare = tok.replace(/^[[(]+|[\]).,;:]+$/g, '');
  if (bare.split(':').length >= 3 && HEXCOLON.test(bare.replace(/%[\w.-]{1,32}$/, ''))) return tok.replace(bare, MASK);
  if (MAC_DASH.test(bare)) return tok.replace(bare, MASK);
  if (FQDN.test(bare) && /[a-z]/i.test(bare.replace(/\.$/, '').split('.').pop())) return tok.replace(bare, MASK);
  return tok.replace(IPV4_IN, MASK);
}
export function maskHwLogText(msg, { tag = '' } = {}) {
  let s = String(msg ?? '').slice(0, HWLOG_MSG_MAX);
  s = s.replace(ACCOUNT, (_, w, sp) => `${w}${sp}${MASK}`);
  s = s.replace(/[^\s"'<>]{1,300}/g, maskToken);
  const tg = String(tag || '').trim().slice(0, 64);
  // 태그는 원문 위에서 대소문자 무시로 찾는다 — toLowerCase 로 길이가 바뀌는 글자(İ 등)가 앞에 있어도 위치가 어긋나지 않게(반증 A9)
  if (tg.length >= 4) s = s.replace(new RegExp(escRe(tg), 'gi'), MASK);
  return s;
}

/** 데모(mock) 모드 — 장비 없이 화면을 볼 수 있게 키로 정해지는 합성 기록(실제 장비 문구가 아니다 — 화면이 ‘데모’ 를 밝힌다). */
export function demoHwLog(key, now = Date.now()) {
  let h = 0; for (const ch of String(key || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const MSGS = [
    ['critical', 'PSU0003', 'Power Supply', 'Power supply 2 lost input power (demo).'],
    ['ok', 'PSU0001', 'Power Supply', 'Power supply 2 input power restored (demo).'],
    ['warning', 'PDR1016', 'Drive Slot', 'Drive 4 in disk drive bay 1 predictive failure (demo).'],
    ['ok', 'SUP0516', 'Firmware', 'Firmware update completed (demo).'],
    ['warning', 'MEM8000', 'Memory', 'Correctable memory error rate exceeded for DIMM B3 (demo).'],
    ['ok', 'SYS1003', 'System Event', 'System CPU resetting (demo).'],
  ];
  const n = 6 + (h % 20);
  const rows = Array.from({ length: n }, (_, i) => { const m = MSGS[(h + i) % MSGS.length]; return { at: now - (i + 1) * 3_600_000 * (3 + ((h >> i) % 7)), sev: m[0], code: m[1], sensor: m[2], msg: m[3] }; });
  return { ok: true, at: now, status: 'ok', read: n, total: n, pages: 1, stopped: '', rows, counts: countsOf(rows), demo: true };
}
