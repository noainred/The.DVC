/**
 * idrac/power.js — 물리서버 **원격 전원 조작 · 위치 LED 켜기/끄기**(v3.52 · 설계 docs/design/bm-feature-proposals ⑦ · ⑥). 장비 상태를 바꾼다.
 *
 *  · 그 서버를 **수집하는 노드**가 장비에 보낸다(이 노드 서버는 이 노드 · 엣지 서버는 그 엣지 — 중앙이 법인 iDRAC 에 WAN 으로 직접 붙지 않는다).
 *  · 전원: Redfish `ComputerSystem.Reset`(POST — ResetType). 장비가 알려 준 허용 값(`ResetType@Redfish.AllowableValues`)에 없으면 보내지 않는다.
 *    LED: System 자원에 `LocationIndicatorActive`(새 표준)가 있으면 그것을, 없으면 `IndicatorLED`(Lit · Blinking · Off — 옛 표준)를 PATCH.
 *  · **다시 보내지 않는다**(전원 동작을 두 번 일으키지 않게). 장비가 받았다(2xx) = ‘요청을 받음’ 이지 ‘끝남’ 이 아니다 — 실제 상태는 다음 수집에서 본다.
 *  · 주 iDRAC 폴러가 인증 실패로 멈춘 서버는 장비에 묻지 않는다(계정 잠금 방지 — hwLog 와 같은 판정).
 *  · 같은 서버는 POWER_GAP_MS 안에 한 번만(진행 중이면 거절) — 연타 · 두 사람이 동시에 누른 경우.
 *  · 장비 시한 30초(세션을 끊는다 — withDeadline + signal).
 */
import { numOrNull } from '../util/numOrNull.js';
import { reqTimeoutMs } from '../util/envTimeout.js';

export const POWER_ACTIONS = Object.freeze({
  on: { reset: ['On'], label: '켜기', force: false },
  shutdown: { reset: ['GracefulShutdown'], label: '정상 종료', force: false },
  restart: { reset: ['GracefulRestart'], label: '정상 재시작', force: false },
  forceRestart: { reset: ['ForceRestart', 'PowerCycle'], label: '강제 재시작', force: true },
  forceOff: { reset: ['ForceOff'], label: '강제 끄기', force: true },
});
export const LED_WANTS = Object.freeze(['on', 'blink', 'off']);
const KNOWN_RESETS = Object.freeze([...new Set(Object.values(POWER_ACTIONS).flatMap((a) => a.reset))]);
export const POWER_GAP_MS = 60_000;
// 장비 시한 — 5~30초(env BM_POWER_DEVICE_TIMEOUT_MS). 중앙 당김 시한(45초 · 최소 35초 — central/bmPowerPull.js)보다 늘 짧게(엣지가 끊고 ‘시한 초과’ 를 답할 시간)
export const POWER_TIMEOUT_MS = reqTimeoutMs(process.env.BM_POWER_DEVICE_TIMEOUT_MS, 30_000, { min: 5_000, max: 30_000 });   // 공용 해석(범위 닫힘 — 99회차 스윕)
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const t = (v, n = 200) => String(v ?? '').slice(0, n);

/** 장비가 알려 준 허용 값 가운데 이 동작에 쓸 ResetType(순서대로 첫 것). 허용 값 목록이 없으면 첫 후보(장비가 목록을 안 주는 판 — 그대로 보낸다). 맞는 것이 없으면 ''. */
export function resetTypeFor(action, allowable) {
  const a = Object.hasOwn(POWER_ACTIONS, action) ? POWER_ACTIONS[action] : null;
  if (!a) return '';
  if (!Array.isArray(allowable) || !allowable.length) return a.reset[0];
  return a.reset.find((r) => allowable.includes(r)) || '';
}
/** 장비 오류 본문에서 메시지 한 줄(Redfish @Message.ExtendedInfo · error.message). 못 읽으면 ''. 길이를 먼저 자른다. */
export function redfishErrorText(text) {
  let j = null; try { j = JSON.parse(String(text ?? '').slice(0, 16_384)); } catch { return ''; }
  const e = isObj(j?.error) ? j.error : null;
  const ext = Array.isArray(e?.['@Message.ExtendedInfo']) ? e['@Message.ExtendedInfo'] : [];
  return t(ext.find((x) => isObj(x) && x.Message)?.Message || e?.message || '', 200).replace(/[\u0000-\u001f]+/g, ' ');
}

// 401 — 계정이 틀렸을 수도, 세션 만료 · Digest nonce 재사용일 수도 있다(원인을 단정하지 않는다 — 반증 A15)
const AUTH_MSG = 'iDRAC 인증에 실패했습니다(401 — 등록 계정 또는 장비 세션 문제일 수 있습니다). 다시 보내지 않았습니다 — 상태를 확인한 뒤 다시 하십시오.';
const _last = new Map();   // 서버 열쇠 → { at, busy }
/** 같은 서버 간격 · 진행 중(순수에 가까움 — 지도만 바꾼다). @returns '' 또는 거절 사유 */
export function powerGapIssue(key, now = Date.now()) {
  const x = _last.get(key);
  if (x?.busy) return '이 서버에 보낸 요청이 아직 끝나지 않았습니다.';
  if (x && now - x.at < POWER_GAP_MS) return `같은 서버에는 ${Math.round(POWER_GAP_MS / 1000)}초에 한 번만 보냅니다 — 잠시 뒤 다시 누르십시오.`;
  return '';
}
export function _resetPowerGapForTest() { _last.clear(); }

/**
 * 장비에 보낸다(전원 또는 LED 한 번). 던지지 않는다 — 상태로 돌려준다.
 * @param {{id:string, host:string, username:string, password:string}} entry  이 노드 iDRAC 등록부 항목
 * @param {{ kind:'power'|'led', action:string, getJson?:Function, send?:Function, authStopped?:Function, now?:Function, timeoutMs?:number }} o
 * @returns {Promise<{ ok:boolean, status:'accepted'|'not-allowed'|'auth'|'auth-stopped'|'busy'|'timeout'|'error'|'bad-args', http?:number, reset?:string, prop?:string, before?:string, message?:string }>}
 */
export async function runDeviceAction(entry, { kind, action, getJson = null, send = null, authStopped = null, now = Date.now, timeoutMs = POWER_TIMEOUT_MS, expectTag = undefined } = {}) {
  if (kind === 'power' ? !Object.hasOwn(POWER_ACTIONS, action) : !(kind === 'led' && LED_WANTS.includes(action))) return { ok: false, status: 'bad-args', message: '모르는 동작입니다.' };
  const key = `${kind}|${String(entry?.id ?? entry?.host ?? '')}`;   // 전원과 LED 는 따로 센다(LED 를 켠 직후 전원을 막지 않게)
  const gap = powerGapIssue(key, now());
  if (gap) return { ok: false, status: 'busy', message: gap };
  // 간격 확인 바로 뒤 · 첫 await 앞에서 ‘진행 중’ 을 세운다 — 같은 틱의 두 호출이 둘 다 보내지 않게(반증 A10)
  const prev = _last.get(key);
  _last.set(key, { at: now(), busy: true });
  let stopped = false;
  try { stopped = typeof authStopped === 'function' ? !!(await authStopped(entry)) : !!(await import('./poller.js')).idracAuthStopFor(entry); } catch { stopped = false; }
  if (stopped) {
    if (prev) _last.set(key, prev); else _last.delete(key);   // 보내지 않았다 — 간격을 세지 않는다
    return { ok: false, status: 'auth-stopped', message: 'iDRAC 인증 실패로 이 서버의 주기 수집이 멈춰 있어 장비에 보내지 않았습니다(등록 계정을 고친 뒤 다시).' };
  }
  const want = String(expectTag === undefined ? entry?.serviceTag ?? '' : expectTag ?? '').trim().toUpperCase().slice(0, 64);
  let sending = false;   // 장비에 상태를 바꾸는 요청을 내보내기 시작했는가 — 그 뒤의 끊김 · 오류는 ‘모름’(반증 A3)
  const [{ withDeadline }, rf] = await Promise.all([import('../util/deadline.js'), import('./redfish.js')]);
  const G = getJson || rf.redfishGetCapped;
  const S = send || rf.redfishSend;
  try {
    const out = await withDeadline(timeoutMs, async (signal) => {
      const systems = await G(entry, '/redfish/v1/Systems', { signal });
      const sysPath = t((Array.isArray(systems?.Members) ? systems.Members : [])[0]?.['@odata.id'], 300);
      // 끝 슬래시를 받는다(HPE iLO 꼴 ‘/redfish/v1/Systems/1/’ — 반증 A4)
      if (!/^\/redfish\/v1\/Systems\/[A-Za-z0-9._-]{1,128}\/?$/.test(sysPath)) return { ok: false, status: 'error', message: '장비의 System 자원을 찾지 못했습니다.' };
      const sys = await G(entry, sysPath, { signal });
      const before = t(sys?.PowerState, 32);
      // 등록의 서비스 태그와 장비가 말하는 태그(Dell SKU · HPE SerialNumber)가 다르면 보내지 않는다 — 주소가 다른 서버로 재배정된 경우(반증 A5).
      //   장비가 태그를 주지 않거나 등록에 태그가 없으면 대조하지 못한다(그대로 보낸다 — tagChecked:false).
      const got = [sys?.SKU, sys?.SerialNumber].map((v) => (typeof v === 'string' ? v.trim().toUpperCase() : '')).filter(Boolean);
      // 문구에 태그를 넣지 않는다(다른 서버의 태그가 범위 판본에 드러나지 않게 — 디버깅 1회차 보안 #4) · 장비 태그는 따로(라우트가 관리자 판본에만)
      if (want && got.length && !got.includes(want)) return { ok: false, status: 'tag-mismatch', before, gotTag: got[0].slice(0, 32), message: '장비가 알려 준 서비스 태그가 등록과 다릅니다 — 다른 서버일 수 있어 보내지 않았습니다.' };
      const tagChecked = !!(want && got.length);
      if (kind === 'power') {
        const act = isObj(sys?.Actions) ? sys.Actions['#ComputerSystem.Reset'] : null;
        const target = t(act?.target, 300);
        if (!/^\/redfish\/v1\/Systems\/[A-Za-z0-9._-]{1,128}\/Actions\/ComputerSystem\.Reset\/?$/.test(target)) return { ok: false, status: 'not-allowed', before, message: '장비가 전원 동작(ComputerSystem.Reset)을 알려 주지 않았습니다.' };
        const reset = resetTypeFor(action, act['ResetType@Redfish.AllowableValues']);
        if (!reset) return { ok: false, status: 'not-allowed', before, message: `장비가 이 동작을 허용하지 않습니다(허용: ${(act['ResetType@Redfish.AllowableValues'] || []).slice(0, 8).join(', ')}).` };
        sending = true;
        const r = await S(entry, 'POST', target, { ResetType: reset }, { signal });
        if (r.status === 401) return { ok: false, status: 'auth', http: 401, reset, before, message: AUTH_MSG };
        if (!r.ok) return { ok: false, status: 'error', http: r.status, reset, before, message: redfishErrorText(r.text) || `장비가 거절했습니다(${r.status}).` };
        return { ok: true, status: 'accepted', http: r.status, reset, before, tagChecked };
      }
      // LED — 새 표준(LocationIndicatorActive)이 있으면 그것(깜빡임은 표현할 수 없어 켜짐으로)
      const useNew = Object.hasOwn(sys || {}, 'LocationIndicatorActive');
      const prop = useNew ? 'LocationIndicatorActive' : 'IndicatorLED';
      const val = useNew ? action !== 'off' : action === 'on' ? 'Lit' : action === 'blink' ? 'Blinking' : 'Off';
      sending = true;
      const r = await S(entry, 'PATCH', sysPath, { [prop]: val }, { signal, headers: sys?.['@odata.etag'] ? { 'If-Match': t(sys['@odata.etag'], 200) } : {} });
      if (r.status === 401) return { ok: false, status: 'auth', http: 401, prop, message: AUTH_MSG };
      if (!r.ok) return { ok: false, status: 'error', http: r.status, prop, message: redfishErrorText(r.text) || `장비가 거절했습니다(${r.status}).` };
      return { ok: true, status: 'accepted', http: r.status, prop, tagChecked, ...(useNew && action === 'blink' ? { message: '이 장비는 깜빡임을 고를 수 없어 켜짐으로 보냈습니다.' } : {}) };
    }, '장비 요청 시한 초과');
    return { ...out, sent: sending };   // 장비에 상태를 바꾸는 요청을 내보냈는가(엣지 상한 · 중앙 ‘보내지 않음’ 판정 — 디버깅 1회차 엣지 #3 · #4)
  } catch (e) {
    const msg = String(e?.message || e);
    if (!sending && (e?.status === 401 || e?.authFailed)) return { ok: false, status: 'auth', http: 401, message: AUTH_MSG, sent: false };
    // 시한 · 끊김 — 장비가 받았는지 모른다(다시 보내지 않는다 · 화면이 다음 수집에서 보라고 말한다).
    //   상태를 바꾸는 요청을 내보낸 뒤의 오류는 원인과 관계없이 ‘모름’ 이다 — 받은 뒤 연결이 끊긴 경우를 ‘보내지 못함’ 으로 단정하지 않는다(반증 A3)
    if (sending || /시한 초과|timeout|abort/i.test(msg)) return { ok: false, status: 'timeout', message: '장비가 시한 안에 답하지 않았습니다 — 요청이 장비에 닿았는지 모릅니다(다시 보내지 않았습니다). 다음 수집에서 상태를 확인하십시오.', sent: sending };
    return { ok: false, status: 'error', message: `장비에 보내지 못했습니다 — ${t(msg, 160)}`, sent: false };
  } finally {
    // 장비에 보내지 않고 끝났으면(태그 다름 · 허용 안 함 · 경로 없음) 간격을 세지 않는다 — 다음 요청이 ‘60초에 한 번’ 으로 막히지 않게(디버깅 1회차 판정 #8)
    if (sending) _last.set(key, { at: now(), busy: false }); else if (prev) _last.set(key, prev); else _last.delete(key);
  }
}

/** 엣지 → 중앙 응답 정제(아는 필드만 · 상태는 아는 값만). */
export function sanitizeDeviceAction(b) {
  if (!isObj(b) || typeof b.ok !== 'boolean') return null;
  const STATUSES = ['accepted', 'not-allowed', 'auth', 'auth-stopped', 'busy', 'timeout', 'error', 'bad-args', 'disabled', 'tag-mismatch', 'force-off', 'rate'];
  const http = numOrNull(b.http);
  return { ok: b.ok === true && b.status === 'accepted', status: STATUSES.includes(b.status) ? b.status : 'error', ...(http != null && http >= 100 && http < 600 ? { http } : {}),
    // 아는 값만(엣지가 지어낸 값 · 제어 문자를 싣지 않는다 — 디버깅 1회차 엣지 #7)
    ...(KNOWN_RESETS.includes(b.reset) ? { reset: b.reset } : {}), ...(['LocationIndicatorActive', 'IndicatorLED'].includes(b.prop) ? { prop: b.prop } : {}), ...(typeof b.before === 'string' ? { before: t(b.before, 32).replace(/[^A-Za-z]/g, '') } : {}),
    ...(typeof b.sent === 'boolean' ? { sent: b.sent } : {}),
    ...(typeof b.message === 'string' ? { message: t(b.message, 300).replace(/[\u0000-\u001f]+/g, ' ') } : {}), ...(typeof b.tagChecked === 'boolean' ? { tagChecked: b.tagChecked } : {}), ...(typeof b.gotTag === 'string' ? { gotTag: t(b.gotTag, 32).replace(/[^A-Za-z0-9._-]/g, '') } : {}) };
}
