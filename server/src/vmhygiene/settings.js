/**
 * vmhygiene/settings.js — VM 구성 점검·스냅샷 정책 설정(`vm-hygiene.json`, v2.698). 사람이 정하는 **설정** 파일이다
 * (백업 '설정 변경' 감시 대상 · 비밀 없음). 손상이면 보존하고 기본값으로 시작한다(조용한 빈값 금지 — v2.580 규약).
 *
 * 모양: { snapAgeDays, snapCount, snapSizeGB, uptimeDays, exceptions:[문자열], creatorExclude:[계정], notify:{ enabled, hour } }
 *  · 숫자 칸의 빈 값·글자는 **미지정**(이전 값 유지) — `Number('')===0` 이 '0일 넘은 스냅샷 = 전부' 가 되지 않게(v2.583 규약).
 *  · exceptions: VM 이름·메모에 이 글자가 들어 있으면 스냅샷 정책 판정에서 뺀다(뺀 개수는 화면이 밝힌다). 대소문자 무시.
 *  · creatorExclude(v3.30.4): ‘스냅샷’ 화면 ‘만든 계정’ 에서 뺄 백업 · 자동화 계정(Bareos · Rubrik · Commvault 등 — 포탈이 그 계정을 알 길이 없어 사람이 적는다).
 *    판정 대상이 아니라 표시에서만 뺀다(Veeam 계정 목록과 따로 — 거기 섞으면 Veeam 스냅샷 판정이 바뀐다). 계정 이름이라 응답은 관리자 판본에만 원문.
 *  · notify: 하루 한 번(한국 시각 hour 시 이후 첫 확인) 스냅샷 정책 위반 요약을 알림 채널로 보낸다. 기본 꺼짐.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, safeLoadText } from '../util/atomicWrite.js';
import { makeJsonFileReader } from '../util/jsonFileLoad.js';   // 결정(56~75 남긴 것) 71
import { numOrNull } from '../util/numOrNull.js';
import { activeHoldMap, onHoldsChange, holdsUnreadable } from './holds.js';

export const SETTINGS_FILE_NAME = 'vm-hygiene.json';
const FILE = () => path.join(config.configDir, 'vm-hygiene.json');
export const DEFAULTS = Object.freeze({ snapAgeDays: 7, snapCount: 3, snapSizeGB: 100, uptimeDays: 365, exceptions: [], creatorExclude: [], notify: { enabled: false, hour: 9 } });
export const RANGES = Object.freeze({ snapAgeDays: [1, 3650], snapCount: [1, 100], snapSizeGB: [1, 100_000], uptimeDays: [7, 3650] });
export const EXCEPTIONS_MAX = 200;
const EXC_LEN_MAX = 64;
export const CREATOR_EXCLUDE_MAX = 50;
const ACCT_LEN_MAX = 128;

let cache = null;
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const revOf = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 10);

function clampNum(raw, key, prev) {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return prev;
  const n = numOrNull(raw);
  if (n == null) return prev;
  const [lo, hi] = RANGES[key];
  return Math.min(hi, Math.max(lo, Math.round(n)));
}
function normExceptions(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().slice(0, EXC_LEN_MAX);
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length >= EXCEPTIONS_MAX) break;
  }
  return out;
}

/** 백업 계정 목록 — 글자만 · 앞뒤 공백 제거 · 제어 문자 · 128자 초과는 버림 · 대소문자 무시 중복 제거 · 50개 상한. 배열이 아니면 null(바꾸지 않음). */
function normAccounts(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim();
    if (!t || t.length > ACCT_LEN_MAX || /[\x00-\x1f\x7f]/.test(t)) continue;   // eslint-disable-line no-control-regex
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length >= CREATOR_EXCLUDE_MAX) break;
  }
  return out;
}

/** 패치 적용(순수) — 모르는 키는 버리고, 빈 숫자 칸은 이전 값. */
export function applyPatch(cur, body = {}) {
  const b = isObj(body) ? body : {};
  const next = { ...cur, notify: { ...cur.notify } };
  for (const k of Object.keys(RANGES)) if (Object.hasOwn(b, k)) next[k] = clampNum(b[k], k, cur[k]);
  if (Object.hasOwn(b, 'exceptions')) { const e = normExceptions(b.exceptions); if (e) next.exceptions = e; }
  if (Object.hasOwn(b, 'creatorExclude')) { const a = normAccounts(b.creatorExclude); if (a) next.creatorExclude = a; }
  if (isObj(b.notify)) {
    if (typeof b.notify.enabled === 'boolean') next.notify.enabled = b.notify.enabled;
    if (Object.hasOwn(b.notify, 'hour')) {
      const h = numOrNull(b.notify.hour);
      if (h != null && h >= 0 && h <= 23) next.notify.hour = Math.trunc(h);
    }
  }
  return next;
}

// 결정(56~75 남긴 것) 71: 읽기 오류 뒤 다시 읽기는 공용 리더의 재읽기 간격(30초) — 요청마다 동기로 다시 읽지 않는다(cost/settings.js 와 같은 판단).
const _reader = makeJsonFileReader(FILE, { parse: (t) => { const p = JSON.parse(t); if (!isObj(p)) throw new Error('객체가 아닙니다'); return p; }, tag: 'vm-hygiene' });
/**
 * v3.28.0: 스냅샷 보류(holds.js)를 **열거되지 않는 속성** holds 로 붙인다 — 판정(hygieneFindings)은 보고, 저장 · 응답 · rev 에는 섞이지 않는다.
 * 보류를 바꾸면 캐시를 버린다(onHoldsChange). 기한은 판정이 지금 시각으로 다시 본다.
 */
const withHolds = (o) => { try { Object.defineProperty(o, 'holds', { value: activeHoldMap(), enumerable: false, configurable: true }); } catch { /* 얼린 객체 — 보류 없이 */ } return o; };
onHoldsChange(() => { cache = null; });
// 153회차(재현): 보류 파일을 **읽지 못한 채** 만든 캐시는 그때의 목록(직전 목록 — 기동 직후면 빈 목록)을 굳히지 않는다. 예전에는 기동 때 읽기 오류였으면
//   파일이 다시 읽혀도 캐시의 빈 Map 이 그대로라(보류 쓰기 · 설정 저장 · 재시작 전까지) 보류한 VM 이 위반으로 판정되고 알림에 실렸다.
//   읽기 오류 동안만 호출마다 다시 붙인다 — 디스크는 공용 리더의 재읽기 간격(30초)으로만 본다(간격 안이면 직전 목록으로 Map 만 다시 만든다).
let cacheHoldsUnread = false;
export function loadVmHygieneSettings() {
  if (cache) {
    if (cacheHoldsUnread) { withHolds(cache); cacheHoldsUnread = holdsUnreadable(); }
    return cache;
  }
  let base = { ...DEFAULTS, notify: { ...DEFAULTS.notify } };
  // 69회차 F4(재현 — cost/settings.js 와 같은 꼴): 읽기 오류는 손상이 아니다 — 원본을 옮기지 않고 기본값을 캐시하지 않으며(71: 간격이 지난 다음 호출에서 다시 읽는다)
  //   unreadable 로 밝힌다. 저장은 거절하고 알림은 보내지 않는다(예전에는 원본을 .corrupt 로 옮겨 알림 · 예외 · 기준이 영구히 기본값으로 돌아갔다).
  const r = _reader.read();
  if (r.kind === 'read-error') {
    const { updatedAt: _a, updatedBy: _b, ...core0 } = base;
    return withHolds({ ...core0, updatedAt: null, updatedBy: null, unreadable: true, rev: 'unreadable' });
  }
  if (r.kind === 'ok') {
    const p = r.value;
    base = applyPatch(base, p);
    if (typeof p.updatedAt === 'number') base.updatedAt = p.updatedAt;
    if (typeof p.updatedBy === 'string') base.updatedBy = p.updatedBy.slice(0, 128);
  } else if (r.kind === 'corrupt') {
    console.warn(`[vm-hygiene] 설정 파일을 읽지 못했습니다 — 원본을 .corrupt 로 보존하고 기본값으로 시작합니다: ${safeLoadText(r.error) || '사유 미상'}`);
  }
  const { updatedAt = null, updatedBy = null, ...core } = base;
  cache = withHolds({ ...core, updatedAt, updatedBy, rev: revOf(core) });
  cacheHoldsUnread = holdsUnreadable();
  return cache;
}

export function saveVmHygieneSettings(body, user) {
  const cur = loadVmHygieneSettings();
  if (cur.unreadable) throw new Error('VM 구성 점검 설정 파일을 읽지 못해 저장하지 않습니다 — 파일을 확인한 뒤 다시 저장하세요(읽지 못한 값 위에 덮어쓰지 않습니다)');
  const { rev, updatedAt, updatedBy, unreadable, ...core } = cur;
  const next = applyPatch(core, body);
  const out = { ...next, updatedAt: Date.now(), updatedBy: user ? String(user).slice(0, 128) : null };
  atomicWriteFileSync(FILE(), JSON.stringify(out, null, 2));
  cache = null; _reader.reset();
  return loadVmHygieneSettings();
}

export function _resetVmHygieneSettings() { cache = null; }
