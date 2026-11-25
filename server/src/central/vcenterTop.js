/**
 * central/vcenterTop.js — 엣지가 인벤토리 push 로 보낸 vcenter 객체의 **최상위 필드를 아는 것만** 남긴다(v2.938, 점검 '엣지가 보낸 것은 정제한다').
 *
 * 왜: routes/central.js 의 /inventory 수신은 `{ ...b.vcenter }` 로 객체를 통째로 복사한 뒤 location·clusterCfg·tagInv·vcInfo·licenses·solutions 만
 *   따로 좁혔다. 그 밖의 키는 형식·길이 제한 없이 저장돼 스냅샷의 vCenter 객체로 남고 `/api/vcenters` 등으로 **로그인한 모든 사용자**에게 나갔다
 *   (vCenter 규칙 문서가 v2.701 부터 '기존 상태 — 별건' 으로 적어 둔 빈틈). 엣지 하나가 수 MB 문자열·임의 객체를 실으면 중앙 메모리·응답이 그대로 커진다.
 *
 * 규칙:
 *  - 여기 표에 없는 키는 버리고 개수를 센다(조용히 버리지 않는다 — 호출부가 dropped 로 콘솔에 남긴다).
 *  - 표의 값도 형식이 다르면 버린다(글자는 길이 상한, 불리언은 true 만, 수는 유한값만, 짧은 글자 배열은 개수·길이 상한).
 *  - 이미 따로 정제하는 키(location·clusterCfg·tagInv·licenses·solutions·…Error)는 **그대로 통과**시킨다 — 그 정제는 호출부 앞쪽이 한다(이중 정제 금지).
 *  - 새 vcenter 필드를 수집기(vcenter/soapClient.js·restClient.js·store.js merge)에 더하면 이 표에도 더할 것 — 안 더하면 위임 법인에서만 그 값이 사라진다.
 *    `server/test/vcenterTop2938.test.js` 가 수집기 소스의 키를 이 표와 대조한다.
 */

/** 호출부가 앞에서 따로 정제한 키 — 여기서는 값을 건드리지 않는다. */
export const PRE_SANITIZED = Object.freeze(['location', 'clusterCfg', 'tagInv', 'licenses', 'solutions', 'licensesError', 'solutionsError']);

/** 아는 최상위 키 → 형식. str:N = 글자(N 상한) · bool = true 만 · num = 유한수 · strs:N:M = 글자 배열(N개·각 M자) · obj = 아래 정제기. */
export const VC_TOP_FIELDS = Object.freeze({
  id: 'str:128', name: 'str:200', status: 'str:32', version: 'str:64', build: 'str:64', fullName: 'str:200', instanceUuid: 'str:64',
  collectSource: 'str:16', collectMethod: 'str:16', collectMode: 'str:16', collectedBy: 'str:128', note: 'str:300',
  error: 'str:600', hint: 'str:600', code: 'str:64', staleSince: 'time', receivedAt: 'time',
  stale: 'bool', edgeStale: 'bool', maintenance: 'bool', alarmsUnknown: 'bool', vmGpuUnknown: 'bool',
  vmGpuCarried: 'num',
  restUnknown: 'strs:32:32', auxSkipped: 'strs:32:64',
  invFetch: 'invFetch', authStopped: 'authStopped',
});

import { capStr } from '../util/capStr.js'; // 상주 문자열은 평탄화해 자른다(TIM2607-01 — .slice 는 원문을 붙잡는다)

const isStr = (v) => typeof v === 'string';
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function invFetchOf(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out = {};
  for (const k of ['mode', 'updatesError']) if (isStr(v[k])) out[k] = capStr(v[k], k === 'mode' ? 16 : 200);
  for (const k of ['at', 'changed', 'refetched', 'objects', 'pages']) if (finite(v[k])) out[k] = v[k];
  return Object.keys(out).length ? out : undefined;
}
function authStoppedOf(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out = {};
  for (const k of ['since', 'at']) if (finite(v[k]) || isStr(v[k])) out[k] = isStr(v[k]) ? capStr(v[k], 40) : v[k];
  if (finite(v.attempts)) out.attempts = v.attempts;
  if (isStr(v.reason)) out.reason = capStr(v.reason, 300);
  return Object.keys(out).length ? out : undefined;
}

/** 값 하나를 형식에 맞춘다 — 맞지 않으면 undefined(버린다). */
export function coerceTopValue(kind, v) {
  if (v == null) return undefined;
  if (kind.startsWith('str:')) return isStr(v) ? capStr(v, Number(kind.split(':')[1])) : undefined;
  if (kind === 'bool') return v === true ? true : v === false ? false : undefined;
  if (kind === 'num') return finite(v) ? v : undefined;
  if (kind === 'time') return finite(v) ? v : isStr(v) ? capStr(v, 40) : undefined;
  if (kind.startsWith('strs:')) {
    const [, n, m] = kind.split(':').map(Number);
    if (!Array.isArray(v)) return undefined;
    return v.filter(isStr).slice(0, n).map((x) => capStr(x, m));
  }
  if (kind === 'invFetch') return invFetchOf(v);
  if (kind === 'authStopped') return authStoppedOf(v);
  return undefined;
}

/**
 * vcenter 객체 → 아는 최상위 키만 남긴 새 객체.
 * @returns {{ value: object, droppedKeys: string[], coerced: number }} droppedKeys = 모르는 키(최대 20개 이름), coerced = 형식이 달라 버린 아는 키 수
 */
export function sanitizeVcenterTop(vcenter) {
  const src = vcenter && typeof vcenter === 'object' && !Array.isArray(vcenter) ? vcenter : {};
  const value = {}; const dropped = []; let coerced = 0;
  for (const k of Object.keys(src)) {
    if (PRE_SANITIZED.includes(k)) { value[k] = src[k]; continue; }
    const kind = Object.hasOwn(VC_TOP_FIELDS, k) ? VC_TOP_FIELDS[k] : null;   // 반증 A-1: constructor·__proto__ 같은 키가 프로토타입 값을 받아 던지지 않게
    if (!kind) { dropped.push(k); continue; }
    const v = coerceTopValue(kind, src[k]);
    if (v === undefined) { if (src[k] != null) coerced += 1; continue; }
    value[k] = v;
  }
  return { value, droppedKeys: dropped.slice(0, 20).map((k) => capStr(k, 64)), droppedCount: dropped.length, coerced };
}
