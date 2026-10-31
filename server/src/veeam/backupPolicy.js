/**
 * veeam/backupPolicy.js — 백업 정책 · 실제 백업 · 정책≠실제 · 마지막 성공 · 최근 실패 판정(순수 · v2.835 — 사용자 요청 '백업 메뉴 개편 1차' + 시안).
 *   쓰는 곳: routes/api/veeam.js detailData(Backup › Detail 응답의 VM 행에 결과 필드 p · a · mm · lok · e 를 싣는다) · CSV 보기 필터(backupStatus.vmViewMatches).
 *   웹은 받은 필드를 그리고, '백업 안 된 VM 찾기' 의 창(N 시간·일) 비교만 한다 — staleOf 는 웹 backupViewText.staleOf 와 한 쌍(테스트가 같은 입력으로 대조).
 *
 * 두 축을 섞지 않는다(사용자 요청 '정책으로 설정하는 백업 방식과 실제로 동작하는 백업을 구분해서'):
 *   · 정책(p) = 사람이 정한 값(veeam/backupMarks method) — 수집값으로 추정하지 않는다.
 *   · 실제(a) = 포탈이 읽은 것 — Veeam 대조(v) · Bareos 원장 잡(b). SSH 백업은 아직 읽는 기능이 없다(정책 값만 — 사용자 결정 D3).
 * 못 읽은 값은 0·없음이 아니라 모름(null)이다 — 한쪽을 모르면 불일치·한 번도 없음으로 단정하지 않는다.
 */

const DAY = 86_400_000;
const isFin = (v) => typeof v === 'number' && Number.isFinite(v);

/** 정책 5범주(화면 순서). 사용자 결정(2026-10-31): Veeam · Bareos · SSH · 백업 안함 · 확인 필요. */
export const POLICY_KEYS = Object.freeze(['veeam', 'bareos', 'ssh', 'none', 'check']);
/**
 * 저장된 백업 방식 → 정책 범주. 정하지 않음('') · 예전 값 clone · config 는 '확인 필요'(사용자 결정 D1·D2 — 저장값은 그대로 두고 화면 범주만).
 * @param {string} method backupMarks 의 method
 */
export const policyOf = (method) => (POLICY_KEYS.includes(method) ? method : 'check');

/**
 * 실제 백업 — { v, b }: true(있음) · false(없다고 확인) · null(모름).
 *   v = Veeam 대조(행의 v — 키 없음·undefined 는 모름, null 은 없음) · b = Bareos 잡(원장을 읽었을 때만 — b.job).
 * @param {object} row vmBackupView 행(+ withBareos 의 b)
 * @param {{bareosKnown?:boolean}} o 이 vCenter 의 Bareos 원장을 읽었나
 */
export function actualOf(row, { bareosKnown = true } = {}) {
  const v = row && 'v' in row && row.v !== undefined ? !!row.v : null;
  const b = bareosKnown && row?.b !== null ? row?.b?.job === true : null;
  return { v, b };
}

/**
 * 정책≠실제(사용자 결정 D4) — true(불일치) · false(일치) · null(모름).
 *   · 정책 Veeam 인데 Veeam 대조에 없음 · 정책 Bareos 인데 잡 없음(Bareos 화면의 '미등록')
 *   · 정책 백업 안함·확인 필요인데 Veeam 대조나 Bareos 잡이 있음
 *   · 정책 SSH 는 실제를 읽지 못하므로 불일치로 세지 않는다(false · D3)
 *   정책을 모르면(표시 파일 손상 — p null) 모름. 판단에 필요한 쪽을 모르면 모름.
 */
export function mismatchOf(p, a) {
  if (!p) return null;
  const v = a?.v ?? null; const b = a?.b ?? null;
  if (p === 'veeam') return v == null ? null : !v;
  if (p === 'bareos') return b == null ? null : !b;
  if (p === 'ssh') return false;
  if (v === true || b === true) return true;
  return v == null || b == null ? null : false;
}

/**
 * 마지막 성공(사용자 결정 D5) — { at, never, v, b, vk, bk }.
 *   v  = Veeam 마지막 백업 완료(lb) — 대조에 없으면(v null) 없음, 대상인데 완료 시각을 모르면 복원 지점 0 일 때만 없음(그 밖 모름)
 *   b  = Bareos 마지막 성공(T·W — 원장 lastOkAt) — 잡이 없으면 없음, 원장을 못 읽으면 모름
 *   at = 아는 성공 시각 중 가장 늦은 것 · never = 둘 다 '없음' 으로 확인됐을 때만 true, 한쪽이라도 모르면 null(미달로 단정하지 않는다)
 *   지금 도는 실행은 성공으로 치지 않는다(완료 시각만 본다).
 */
export function lastOkOf(row, { bareosKnown = true } = {}) {
  let v = null; let vk = false;
  if (row && 'v' in row && row.v !== undefined) {
    if (!row.v) vk = true;
    else if (isFin(row.v.lb) && row.v.lb > 0) { v = row.v.lb; vk = true; } else vk = row.v.rp === 0;
  }
  let b = null; let bk = false;
  if (bareosKnown && row?.b !== null) {
    bk = true;
    if (row?.b?.job === true && isFin(row.b.ok) && row.b.ok > 0) b = row.b.ok;
  }
  const at = v != null || b != null ? Math.max(v ?? 0, b ?? 0) : null;
  return { at, never: at != null ? false : (vk && bk ? true : null), v, b, vk, bk };
}

/**
 * 최근 24시간 실패·경고(사용자 결정 D7) — [{ s:'veeam'|'bareos', r:'fail'|'warn', at }].
 *   Veeam = 그 VM 의 마지막 task 결과(lr)와 끝난 시각(lrt) · Bareos = 마지막으로 끝난 실행(st · at — 취소는 실패로 센다).
 *   시각을 모르는 결과는 넣지 않는다(24시간 안인지 모른다).
 */
export function recentErrorsOf(row, now = Date.now()) {
  const out = [];
  const lr = row?.v ? String(row.v.lr || '') : '';
  if (/^(fail|warn)/i.test(lr) && isFin(row.v.lrt) && now - row.v.lrt <= DAY) out.push({ s: 'veeam', r: /^fail/i.test(lr) ? 'fail' : 'warn', at: row.v.lrt });
  const b = row?.b;
  if (b?.job === true && ['error', 'canceled', 'warning'].includes(b.st) && isFin(b.at) && now - b.at <= DAY) out.push({ s: 'bareos', r: b.st === 'warning' ? 'warn' : 'fail', at: b.at });
  return out;
}

/**
 * Detail 행에 싣는 결과 필드 — { p, a, mm, lok, e? }(e 는 있을 때만).
 * @param {{marksKnown?:boolean, bareosKnown?:boolean, now?:number}} o marksKnown = 표시 파일을 읽었나(못 읽었으면 정책 모름)
 */
export function policyFields(row, { marksKnown = true, bareosKnown = true, now = Date.now() } = {}) {
  const p = marksKnown ? policyOf(row?.m?.method || '') : null;
  const a = actualOf(row, { bareosKnown });
  const e = recentErrorsOf(row, now);
  return { p, a, mm: mismatchOf(p, a), lok: lastOkOf(row, { bareosKnown }), ...(e.length ? { e } : {}) };
}

/** 찾기 기준 — 실제 백업 전부 · Veeam 만 · Bareos 만 · 정책에 맞는 백업만(v2.837 시안 — 정책 Veeam 이면 Veeam 결과만, Bareos 면 Bareos 결과만, 그 밖은 전부). */
export const STALE_SOURCES = Object.freeze(['all', 'veeam', 'bareos', 'policy']);
/** 'policy' 를 그 VM 의 기준으로 푼다(SSH 는 결과를 읽지 못해 전부로 본다). */
export const staleSrcOf = (src, p) => (src === 'policy' ? (p === 'veeam' ? 'veeam' : p === 'bareos' ? 'bareos' : 'all') : (STALE_SOURCES.includes(src) ? src : 'all'));

/**
 * '백업 안 된 VM 찾기'(사용자 요청 '지정한 시간만큼 백업되지 않은 VM 찾기') — 한 VM 의 판정. 웹 backupViewText.staleOf 와 한 쌍.
 *   반환: null(찾기 대상 아님 — 범위 밖 · 창 안에 성공 있음) | { kind:'never'|'old'|'unknown', last:number|null }
 *     never   = 고른 기준의 실제 백업이 한 번도 없다고 확인됨 · old = 마지막 성공이 창보다 오래됨 · unknown = 판단에 필요한 쪽을 모름(따로 센다)
 *   창 안에 아는 성공이 하나라도 있으면 다른 쪽을 몰라도 대상이 아니다(이미 백업됐다).
 * @param {object} vm Detail 행(policyFields 를 실은 것)
 * @param {{windowMs:number, now?:number, src?:'all'|'veeam'|'bareos', excludeNone?:boolean, onlyOn?:boolean, includeNever?:boolean}} o
 */
export function staleOf(vm, { windowMs, now = Date.now(), src = 'all', excludeNone = true, onlyOn = true, includeNever = true } = {}) {
  if (!vm || !isFin(windowMs) || windowMs <= 0) return null;
  if (excludeNone && vm.p === 'none') return null;
  if (onlyOn && vm.power !== 'POWERED_ON') return null;
  const lok = vm.lok || {};
  const s = staleSrcOf(src, vm.p);
  const parts = [];
  if (s !== 'bareos') parts.push({ t: isFin(lok.v) ? lok.v : null, k: lok.vk === true });
  if (s !== 'veeam') parts.push({ t: isFin(lok.b) ? lok.b : null, k: lok.bk === true });
  const times = parts.filter((x) => x.t != null).map((x) => x.t);
  const last = times.length ? Math.max(...times) : null;
  if (last != null && now - last <= windowMs) return null;
  if (parts.some((x) => !x.k)) return { kind: 'unknown', last };
  if (last == null) return includeNever ? { kind: 'never', last: null } : null;
  return { kind: 'old', last };
}
