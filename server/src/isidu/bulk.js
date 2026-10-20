/**
 * 아이실론 디렉터리 사용량 — 수집 대상 일괄 변경(v2.739, 사용자 요청 "설정에서 바꿀 수 있는 모든 기능을 등록된 아이템에서 일괄적으로").
 *
 *  · 판정은 서버가 한다(웹은 미리보기 결과를 그대로 보여 준다 — 판정을 두 벌 두지 않는다).
 *  · 고른 대상마다 저장값 위에 바꿀 항목만 얹고 **같은 정규화(normalizeTarget)** 를 거친다 — 개별 저장과 다른 규칙이 생기지 않게.
 *  · 대상에 맞지 않는 항목은 그 대상에서만 빼고 사유를 남긴다(notApplied). 예: DataCenter 는 직접 입력 대상만(등록부 장비는 등록부가 정한다),
 *    '장비 담당 노드 따름'·'등록부 계정' 인증은 등록부 장비만, 빈 계정은 직접 입력 대상에 쓸 수 없다.
 *  · 정규화가 거절한 대상(예: 다른 엣지에서 등록부 계정 인증)은 **그 대상만** 바꾸지 않고 사유를 남긴다(skipped) — 나머지는 바꾼다.
 *  · 숫자는 범위를 벗어나면 400 이다(조용히 자르지 않는다 — 고른 값과 다른 값이 저장되면 거짓이다). 빈 값은 '그대로'.
 */
import crypto from 'node:crypto';
import { RANGES, AUTH_MODES, MAX_TARGETS, normalizeTarget } from './settings.js';
import { SIZE_MODES } from './parse.js';
import { normalizeMailList, MAIL_LIST_MAX, TARGET_MAIL_WHEN, mailDaysOf, isMailTime, targetMailOf } from './mailRules.js';
import { numOrNull } from '../util/numOrNull.js';

/** 실행 노드 '장비 담당 노드 따름' 표지(웹 isiduText.RUN_FOLLOW 와 같은 값). */
export const RUN_FOLLOW = '__device__';
export const MAIL_TO_MODES = Object.freeze(['add', 'remove', 'replace', 'clear']);
const BOOL_KEYS = Object.freeze(['enabled', 'detach', 'mailExcludeCommon', 'mailOnlyOnChange', 'mailOnFailure', 'mailSkipIfNoNew']);
const NUM_KEYS = Object.freeze(['intervalHours', 'timeoutMin', 'topN', 'port']);
// v2.745: 결과 메일 보내는 때(mailWhen 'scan'|'schedule') · 요일(mailDays — 요일 배열) · 시각(mailTime 'HH:MM'). 웹 계약 대조가 세 목록만 읽으므로 여기에 둔다.
const STR_KEYS = Object.freeze(['sizeMode', 'auth', 'runNode', 'datacenterId', 'username', 'mailWhen', 'mailDays', 'mailTime']);
/** 바꿀 수 있는 항목 전부(웹 BULK_FIELDS 키와 1:1 — 웹 테스트가 이 소스와 대조한다). */
export const BULK_KEYS = Object.freeze([...BOOL_KEYS, ...NUM_KEYS, ...STR_KEYS, 'mailTo']);
/** 대상에 맞지 않아 그 대상에서 뺀 사유 코드(웹 NOT_APPLIED_TEXT 와 1:1). */
export const NOT_APPLIED_CODES = Object.freeze(['dc-from-registry', 'follow-needs-registry', 'device-auth-needs-registry', 'direct-needs-user']);

const t = (v) => (v == null ? '' : String(v).trim());

/** 설정 목록의 판(rev) — 화면이 읽은 뒤 다른 사람이 바꿨는지 본다(일괄 적용이 그 변경을 덮지 않게). */
export function settingsRev(targets) {
  return crypto.createHash('sha1').update(JSON.stringify(Array.isArray(targets) ? targets : [])).digest('hex').slice(0, 16);
}

/**
 * 바꿀 항목 정규화(순수). 빈 값('' · null)은 '그대로' 라 뺀다. 모르는 키·범위 밖 값은 오류(조용히 버리지 않는다).
 * @returns {{patch:object} | {error:string, field:string}}
 */
export function normalizeBulkPatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: '바꿀 항목(patch)이 필요합니다.', field: 'patch' };
  const patch = {};
  for (const k of Object.keys(raw)) {
    if (!BULK_KEYS.includes(k)) return { error: `모르는 항목입니다: ${String(k).slice(0, 40)}`, field: k };
  }
  for (const k of BOOL_KEYS) {
    const v = raw[k];
    if (v == null || v === '') continue;
    if (v !== true && v !== false) return { error: `${k} 는 켜기/끄기 중 하나여야 합니다.`, field: k };
    patch[k] = v;
  }
  for (const k of NUM_KEYS) {
    const v = raw[k];
    if (v == null || v === '') continue;
    const n = numOrNull(v);
    const r = RANGES[k];
    if (n == null || !Number.isInteger(n)) return { error: `${k} 는 정수여야 합니다.`, field: k };
    if (n < r.min || n > r.max) return { error: `${k} 는 ${r.min}~${r.max} 사이여야 합니다(입력 ${n}).`, field: k };
    patch[k] = n;
  }
  if (raw.sizeMode != null && raw.sizeMode !== '') {
    if (!SIZE_MODES.includes(raw.sizeMode)) return { error: '크기 표기는 h 또는 k 입니다.', field: 'sizeMode' };
    patch.sizeMode = raw.sizeMode;
  }
  if (raw.auth != null && raw.auth !== '') {
    if (!AUTH_MODES.includes(raw.auth)) return { error: '인증은 key 또는 device 입니다.', field: 'auth' };
    patch.auth = raw.auth;
  }
  // runNode: RUN_FOLLOW | '' 가 아닌 엣지 이름 | 메인은 '__main__'(빈 값은 '그대로' 이므로 메인을 따로 적는다)
  if (raw.runNode != null && raw.runNode !== '') {
    const v = t(raw.runNode);
    if (v.length > 128) return { error: '실행 노드 이름이 너무 깁니다.', field: 'runNode' };
    patch.runNode = v;
  }
  if (raw.datacenterId != null && raw.datacenterId !== '') {
    const v = t(raw.datacenterId);
    if (v.length > 128) return { error: 'DataCenter 값이 너무 깁니다.', field: 'datacenterId' };
    patch.datacenterId = v === '__none__' ? '' : v;   // '__none__' = 지정 안 함으로 바꾸기
  }
  if (raw.username != null && raw.username !== '') {
    const v = t(raw.username);
    if (v.length > 64) return { error: '계정 이름이 너무 깁니다.', field: 'username' };
    patch.username = v === '__registry__' ? '' : v;   // '__registry__' = 등록부 계정으로 되돌리기(등록부 장비만)
  }
  // v2.745 결과 메일 보내는 때 — 잘못된 값은 고치지 않고 400(고른 값과 다른 값이 저장되면 거짓이다).
  if (raw.mailWhen != null && raw.mailWhen !== '') {
    if (!TARGET_MAIL_WHEN.includes(raw.mailWhen)) return { error: "결과 메일 보내는 때는 '조사가 끝날 때마다'(scan) 또는 '정한 요일·시각'(schedule) 입니다.", field: 'mailWhen' };
    patch.mailWhen = raw.mailWhen;
  }
  if (raw.mailDays != null && raw.mailDays !== '') {
    const v = raw.mailDays;
    const isDay = (x) => (typeof x === 'number' || (typeof x === 'string' && /^\s*\d\s*$/.test(x))) && Number.isInteger(Number(x)) && Number(x) >= 0 && Number(x) <= 6;
    if (!Array.isArray(v) || !v.length || v.length > 50 || !v.every(isDay)) return { error: '결과 메일 요일은 0(일)~6(토) 사이 요일을 하나 이상 고르세요.', field: 'mailDays' };
    patch.mailDays = mailDaysOf(v.map(Number));
  }
  if (raw.mailTime != null && raw.mailTime !== '') {
    if (!isMailTime(raw.mailTime)) return { error: '결과 메일 보내는 시각은 00:00~23:59 형식이어야 합니다.', field: 'mailTime' };
    patch.mailTime = String(raw.mailTime).trim();
  }
  if (raw.mailTo != null && raw.mailTo !== '') {
    const m = raw.mailTo;
    if (!m || typeof m !== 'object' || !MAIL_TO_MODES.includes(m.mode)) return { error: '받는 사람 변경 방식(add·remove·replace·clear)을 고르세요.', field: 'mailTo' };
    if (m.mode === 'clear') patch.mailTo = { mode: 'clear', list: [] };
    else {
      const n = normalizeMailList(m.list);
      if (n.invalid.length) return { error: `메일 주소 형식이 잘못됐습니다: ${n.invalid.slice(0, 3).join(', ')}${n.invalid.length > 3 ? ` 외 ${n.invalid.length - 3}개` : ''}`, field: 'mailTo' };
      if (!n.list.length) return { error: '받는 사람 주소를 입력하세요.', field: 'mailTo' };
      patch.mailTo = { mode: m.mode, list: n.list };
    }
  }
  if (!Object.keys(patch).length) return { error: '바꿀 항목을 하나 이상 고르세요.', field: 'patch' };
  return { patch };
}

/** 저장된 대상 → 정규화 입력(같은 모양). mail 은 목록 사본. */
function asInput(x) {
  const mail = x.mail ? { ...x.mail, to: Array.isArray(x.mail.to) ? [...x.mail.to] : [] } : { to: [], excludeCommon: false, onlyOnChange: false, onFailure: false };
  return { ...x, mail };
}

const lo = (s) => String(s || '').toLowerCase();

function mergeMailTo(cur, op) {
  const list = Array.isArray(cur) ? cur : [];
  if (op.mode === 'clear') return [];
  if (op.mode === 'replace') return [...op.list];
  if (op.mode === 'remove') { const rm = new Set(op.list.map(lo)); return list.filter((a) => !rm.has(lo(a))); }
  const have = new Set(list.map(lo));
  return [...list, ...op.list.filter((a) => !have.has(lo(a)))];
}

/** 객체 비교용(키 순서 무관) 직렬화. */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/**
 * 일괄 변경 적용(순수 — 저장하지 않는다). 고르지 않은 대상은 그대로.
 * @param {object[]} targets 저장된 대상(정규화된 모양)
 * @param {string[]} ids 고른 대상 id
 * @param {object} patch normalizeBulkPatch 의 결과
 * @param {object} ctx normalizeTarget 의 ctx
 * @returns {{targets:object[], changed:{id:string,keys:string[]}[], unchanged:string[], skipped:{id:string,reason:string,field:string|null}[], notApplied:{id:string,key:string,reason:string}[], notFound:string[]}}
 */
export function applyBulk(targets, ids, patch, ctx) {
  const list = Array.isArray(targets) ? targets : [];
  const want = new Set((Array.isArray(ids) ? ids : []).map(String));
  const known = new Set(list.map((x) => x.id));
  const out = { targets: [], changed: [], unchanged: [], skipped: [], notApplied: [], notFound: [...want].filter((id) => !known.has(id)) };
  for (const x of list) {
    if (!want.has(x.id)) { out.targets.push(x); continue; }
    const cand = asInput(x);
    const isReg = !!x.deviceId;
    const skipKey = (key, reason) => out.notApplied.push({ id: x.id, key, reason });
    for (const k of ['enabled', 'detach', 'intervalHours', 'timeoutMin', 'topN', 'port', 'sizeMode']) if (k in patch) cand[k] = patch[k];
    if ('auth' in patch) {
      if (patch.auth === 'device' && !isReg) skipKey('auth', 'device-auth-needs-registry');
      else cand.auth = patch.auth;
    }
    if ('runNode' in patch) {
      const v = patch.runNode;
      if (v === RUN_FOLLOW) {
        if (isReg) { cand.runVia = 'device'; cand.agent = ''; } else skipKey('runNode', 'follow-needs-registry');
      } else {
        const agent = v === '__main__' ? '' : v;
        if (isReg) { cand.runVia = 'node'; cand.agent = agent; } else cand.agent = agent;
      }
    }
    if ('datacenterId' in patch) {
      if (isReg) skipKey('datacenterId', 'dc-from-registry'); else cand.datacenterId = patch.datacenterId;
    }
    if ('username' in patch) {
      if (!isReg && !patch.username) skipKey('username', 'direct-needs-user'); else cand.username = patch.username;
    }
    if ('mailTo' in patch) cand.mail.to = mergeMailTo(cand.mail.to, patch.mailTo);
    if ('mailExcludeCommon' in patch) cand.mail.excludeCommon = patch.mailExcludeCommon;
    if ('mailOnlyOnChange' in patch) cand.mail.onlyOnChange = patch.mailOnlyOnChange;
    if ('mailOnFailure' in patch) cand.mail.onFailure = patch.mailOnFailure;
    // v2.745 보내는 때 — since 는 정규화(normalizeTargetMail)가 정한다(schedule 로 바꾸거나 요일·시각이 바뀌면 지금).
    if ('mailWhen' in patch) cand.mail.when = patch.mailWhen;
    if ('mailDays' in patch) cand.mail.days = [...patch.mailDays];
    if ('mailTime' in patch) cand.mail.time = patch.mailTime;
    if ('mailSkipIfNoNew' in patch) cand.mail.skipIfNoNew = patch.mailSkipIfNoNew;
    if (cand.mail.to.length > MAIL_LIST_MAX) { out.skipped.push({ id: x.id, reason: `대상별 수신자는 ${MAIL_LIST_MAX}명까지입니다(합치면 ${cand.mail.to.length}명).`, field: 'mailTo' }); out.targets.push(x); continue; }
    const r = normalizeTarget(cand, x, ctx);
    if (r.error) { out.skipped.push({ id: x.id, reason: r.error, field: r.field || null }); out.targets.push(x); continue; }
    // mail 은 정규화한 모양끼리 비교한다 — 옛 저장 모양(필드 일부)과 정규화 모양(전 필드)이 같은 값이면 바뀐 것이 아니다(v2.745).
    const cmp = (k, v) => (k === 'mail' ? canon(targetMailOf({ mail: v })) : canon(v));
    const keys = Object.keys({ ...x, ...r.target }).filter((k) => cmp(k, x[k]) !== cmp(k, r.target[k]));
    if (keys.length) out.changed.push({ id: x.id, keys }); else out.unchanged.push(x.id);
    out.targets.push(r.target);
  }
  return out;
}

/** 목록에서 고른 대상 빼기(순수). */
export function removeTargets(targets, ids) {
  const want = new Set((Array.isArray(ids) ? ids : []).map(String));
  const list = Array.isArray(targets) ? targets : [];
  return { targets: list.filter((x) => !want.has(x.id)), removed: list.filter((x) => want.has(x.id)).map((x) => x.id), notFound: [...want].filter((id) => !list.some((x) => x.id === id)) };
}

/** 요청의 id 목록 정리(문자열 · 중복 제거 · 상한). */
export function bulkIdsOf(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const v of raw) {
    const s = t(v);
    if (s && s.length <= 128 && !out.includes(s)) out.push(s);
    if (out.length >= MAX_TARGETS) break;
  }
  return out;
}
