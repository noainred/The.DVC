/**
 * agent/centralStatusOnly.js — 엣지 '상태 전용' push 공용(v2.613 EDGE2613-04).
 *
 * v2.517·v2.554 규약("엣지는 0건이어도 상태를 올린다 — 그게 신고된 상태다")을 storage(v2.581)에만 두고 그 능력
 * 프로브(`centralStatusOnlySupport`)가 storage/push.js 지역 함수였다 — sanswitch·pdu 가 같은 것을 하려면 또 복사해야 했다.
 * 여기 하나로 올리고 세 push 가 쓴다.
 *
 * ⚠ 중앙이 `statusOnly` 를 **모르는 버전**이면 `devices:[]`·`snapshots:[]` 를 그 엣지 목록의 **교체**로 받아 중앙 목록을
 *   비운다(v2.602 EDGE2602-03 — 엣지가 중앙보다 먼저 올라간 현장). 경로마다 아는 첫 버전이 다르다:
 *   · `/storage-data`  : v2.581.0(STATUS_ONLY_MIN_CENTRAL)
 *   · `/sanswitch-data`·`/pdu-data` : v2.613.0(DEVICE_STATUS_ONLY_MIN_CENTRAL) — 이 릴리스에 수신이 생겼다.
 *   그래서 프로브는 **필요 버전을 인자로** 받고 버전별로 캐시한다. 모르는 것(프로브 실패·버전 형식 불명)은
 *   **지원하지 않는 쪽**이다(보내지 않고 사유를 남긴다 — 조용히 목록을 비우는 것보다 낫다).
 */
import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { cmpVersion } from '../util/cmpVersion.js';

/** `/storage-data` 가 statusOnly 를 아는 첫 중앙 버전(v2.581 BUG-D). */
export const STATUS_ONLY_MIN_CENTRAL = '2.581.0';
/** `/sanswitch-data`·`/pdu-data` 가 statusOnly 를 아는 첫 중앙 버전(v2.613 EDGE2613-04). */
export const DEVICE_STATUS_ONLY_MIN_CENTRAL = '2.613.0';
const CAP_TTL_MS = 60 * 60_000;
const CAP_FAIL_TTL_MS = 5 * 60_000;
const _caps = new Map(); // minVersion → { at, ok, reason, version, text }

/**
 * 중앙이 statusOnly 를 아는가(v2.602 EDGE2602-03) — 경량 `/api/central/health-probe`(v2.552 이상, 응답에 version)로 본다.
 * 성공은 1시간, 실패는 5분 캐시(주기 push 마다 두드리지 않게).
 * @param {{minVersion?:string, now?:number, fetchImpl?:Function}} [o]
 * @returns {Promise<{ok:boolean, reason:string, version?:string, text:string}>}
 */
export async function centralStatusOnlySupport({ minVersion = STATUS_ONLY_MIN_CENTRAL, now = Date.now(), fetchImpl = resilientFetch } = {}) {
  const cached = _caps.get(minVersion);
  if (cached && now - cached.at < (cached.ok ? CAP_TTL_MS : CAP_FAIL_TTL_MS)) return cached;
  let out;
  try {
    const res = await fetchImpl(`${config.agent.centralUrl}/api/central/health-probe`, {
      headers: { Accept: 'application/json', 'X-Central-Token': config.agent.centralToken }, timeoutMs: 10_000, retries: 0,
    });
    if (!res.ok) out = { ok: false, reason: 'central-version-unknown', text: `중앙 버전 확인 실패(health-probe HTTP ${res.status}) — 구버전 중앙이면 목록을 비울 수 있어 상태 보고를 보내지 않습니다` };
    else {
      const j = await res.json().catch(() => null);
      const v = typeof j?.version === 'string' ? j.version.slice(0, 32) : '';
      const c = v ? cmpVersion(v, minVersion) : null;
      if (c == null) out = { ok: false, reason: 'central-version-unknown', version: v, text: `중앙 버전을 읽지 못했습니다(${v || '응답에 없음'}) — 상태 보고를 보내지 않습니다` };
      else if (c < 0) out = { ok: false, reason: 'central-too-old', version: v, text: `중앙 v${v} 는 이 경로의 상태 전용 보고를 모릅니다(v${minVersion} 이상 필요 — 보내면 중앙의 이 엣지 장비 목록이 비워집니다). 중앙을 업그레이드하세요` };
      else out = { ok: true, reason: '', version: v, text: '' };
    }
  } catch (e) {
    out = { ok: false, reason: 'central-version-unknown', text: `중앙 버전 확인 실패(${String(e?.message || e).slice(0, 120)}) — 상태 보고를 보내지 않습니다` };
  }
  const rec = { at: now, ...out };
  _caps.set(minVersion, rec);
  return rec;
}
export function _resetStatusOnlyCapForTest() { _caps.clear(); }

/**
 * 상태 전용 push(v2.581) — 목록 필드(`devices:[]`·`snapshots:[]`)에 `statusOnly:true` 를 붙인다. 중앙은 보관 중인 장비
 * 목록을 **건드리지 않고** 상태만 기록한다(빈 목록으로 덮으면 엣지 재시작 직후 한 주기 동안 중앙 화면이 빈다).
 * ⚠ 호출 전에 `centralStatusOnlySupport` 로 중앙 버전을 확인할 것(위 머리말).
 * @param {string} route  `/api/central/…` 경로(예: '/api/central/sanswitch-data')
 * @param {object} status  { reason, registered, … } — 아는 키만 담긴다(중앙이 자른다)
 * @param {object} [extra]  본문에 함께 실을 필드(예: `{ devices: [] }` · `{ snapshots: [], chunk: 0, chunks: 1 }`)
 * @returns {Promise<{ok:true}|{ok:false, reason:string}>}
 */
export async function sendStatusOnly(route, status, extra = {}) {
  try {
    const json = JSON.stringify({ agent: config.agent.name, ...extra, statusOnly: true, status: { ...status, at: Date.now() } });
    const hdrs = { 'Content-Type': 'application/json', 'X-Agent-Name': config.agent.name, 'X-Central-Token': config.agent.centralToken };
    const res = await resilientFetch(`${config.agent.centralUrl}${route}`, { method: 'POST', headers: hdrs, body: json, timeoutMs: 20_000, retries: 1 });
    if (!res.ok) return { ok: false, reason: `${route.replace(/^\/api\/central\//, '')} <- ${res.status}` };
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}
