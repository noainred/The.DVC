/**
 * storage/collectors/restCommon.js — REST 수집기 공용 HTTP 헬퍼(v2.309).
 * PowerStore/Unity 수집기가 공유한다(isilon.js 의 get/getAny 와 동일 철학 — 포트·헤더만 다름).
 * 자체서명 장비 한정 로컬 TLS 디스패처(전역 오염 금지 — server/CLAUDE.md). 401 은 명시 오류로
 * 던져 수집기가 즉시 중단하게 한다(장비 계정 잠금 예방 — isilon 과 동일 규칙).
 */
import { Agent } from 'undici';
import { withSsrfLookup } from '../../util/ssrfLookup.js';
import { deviceTlsConnect } from '../../security/tlsTrust.js'; // 2026-10-09 S-02: CA 체인 또는 승인 지문 — 자격증명 전에 판정
import { reqTimeoutMs } from '../../agent/envTimeout.js';
// v2.513: 전송 계층 실패(`fetch failed`·`aborted`)를 행동 가능한 사유로 바꾼다 — 순수 모듈.
import { describeFetchError, isTransportError } from './netError.js';
import { NO_REDIRECT, refuseRedirect } from '../../util/noRedirect.js';

// 2026-10-09 S-02(사용자 승인 기본값 전환): 미설정 = CA 체인(시스템 루트 + 사설 CA 번들) 또는 장비별 승인 지문 —
// 예전 기본(자체서명 허용 · M-4 의 'STORAGE_TLS_VERIFY=true 일 때만 검증')은 어레이 관리자 자격증명을 상대 확인 없이 보냈다.
// STORAGE_TLS_VERIFY=true 는 CA 체인만(엄격), =false 는 명시적 예외(예전처럼 어떤 인증서든 — 상태에 드러난다).
// v2.537: DNS 리바인딩(TOCTOU) 차단 — util/ssrfLookup.js 머리말. v2.506 배선(11곳)에서 빠져 있던 dispatcher.
const dispatcher = new Agent({ connect: deviceTlsConnect({ subsystem: 'storage', envKey: 'STORAGE_TLS_VERIFY', envRaw: process.env.STORAGE_TLS_VERIFY, tls: withSsrfLookup({}) }) });
// v2.605(감사 TIM2605-04): 음수·2^32 이상은 AbortSignal.timeout 이 RangeError(모든 REST 요청 실패), 3e9 는 1ms abort — [1초, 10분].
const TIMEOUT_MS = reqTimeoutMs(process.env.STORAGE_HTTP_TIMEOUT_MS, 15_000);
/** 요청 signal(v2.421): 호출자 취소(signal) + 요청 타임아웃을 합친다 — 연결 테스트가 끝난 뒤 수집기가 백그라운드에서 계속
 *  요청을 이어가지 않게(라우팅 불가 주소면 요청마다 15초 × 20여 회 = 수 분간 세션이 남았다 — CI 에서 실제 관측). */
const reqSignal = (signal) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS));

/**
 * fetch 래퍼(v2.513) — 전송 계층 실패를 **어느 장비의 무슨 문제인지** 말하는 오류로 바꾼다.
 * undici 는 연결 거부·타임아웃·인증서 실패를 전부 `TypeError: fetch failed` 하나로 던지고
 * 진짜 코드는 `err.cause` 에 숨긴다 — 그대로 두면 화면에 'fetch failed' 만 남는다(실제 신고).
 * HTTP 응답을 받은 오류(4xx/5xx·401)는 이미 사유가 있으므로 건드리지 않는다.
 */
async function fetchOrExplain(url, init, { host, port, signal }) {
  try {
    // v2.620 SEC2620-01: 세션 토큰 헤더(EMC-CSRF-TOKEN·DELL-EMC-TOKEN)·로그인 본문을 3xx 로 따라 보내지 않는다.
    return refuseRedirect(await fetch(url, { ...init, redirect: NO_REDIRECT }), host || '장비');
  } catch (e) {
    if (!isTransportError(e)) throw e;
    // cause 를 유지한다 — 화면에는 한 줄 사유만 가지만 서버 로그·디버깅에서 원문 사슬을 잃지 않는다.
    throw new Error(describeFetchError(e, { host, port, timeoutMs: TIMEOUT_MS, cancelled: !!signal?.aborted }), { cause: e });
  }
}

/**
 * 헤더 값 사전 검증(v2.311 적대적 검증 확정 결함 수정 — 자격증명 유출 차단).
 * undici 는 헤더 값에 제어문자(CR/LF/NUL)가 있으면 TypeError 를 던지는데 그 메시지에
 * **값 전문이 그대로 포함**된다(Node v24 실측: '"secret\nX" is an invalid header value').
 * vplex v1 처럼 password 를 커스텀 헤더로 싣는 수집기에서 이 메시지가 섹션 오류 →
 * putSnapshot → UI/중앙 push 로 흐르면 장비 비밀번호가 유출된다. 값을 절대 되울리지 않는
 * 일반화 메시지로 생성 시점에 차단한다(허용: TAB·프린터블 ASCII·Latin-1 상위 영역).
 */
const RE_HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/; // eslint-disable-line no-control-regex
function assertHeaderSafe(headers) {
  for (const [k, v] of Object.entries(headers)) {
    if (!RE_HEADER_VALUE.test(String(v))) {
      throw new Error(`요청 헤더 '${k}' 값에 사용 불가 문자(개행 등 제어문자) — 자격증명 붙여넣기 확인`);
    }
  }
}

/**
 * HTTP 실패 → 사유 문자열(v2.422, 사용자 요구 'PowerStore 접속은 되는데 수집이 안 됨'). 예전에는 `HTTP 422` 만
 * 남아 **왜** 거부됐는지 알 수 없었다. PowerStore/Unity 는 오류 본문에 `messages[].message_l10n`(또는 code) 로
 * 사유를 주므로 그것을 뽑고, 아니면 본문 앞 200자를 붙인다. 장비 비밀번호가 본문에 되울려도 마스킹한다.
 */
export async function httpFailMessage(res, device = null) {
  let text = '';
  try { text = await res.text(); } catch { text = ''; }
  let detail = '';
  try {
    const j = JSON.parse(text);
    const msgs = Array.isArray(j?.messages) ? j.messages : (Array.isArray(j) ? j : []);
    detail = msgs.map((m) => m?.message_l10n || m?.message || m?.code || '').filter(Boolean).join(' / ');
    if (!detail && (j?.message || j?.error || j?.errorCode)) detail = String(j.message || j.error || j.errorCode);
  } catch { /* JSON 아님 */ }
  if (!detail) detail = String(text || '').replace(/[\x00-\x1f]+/g, ' ').trim().slice(0, 200);
  if (device?.password && detail.includes(device.password)) detail = detail.split(device.password).join('***');
  return `HTTP ${res.status}${detail ? ` — ${detail}` : ''}`;
}

/**
 * 401(자격증명 거부) 오류 — v2.742(감사 DEV-03). 오류 객체에 `authFailed`·`status` 를 싣는다.
 * 예전에는 문구만 있어 수집기 약 25곳이 `/401/.test(e.message)` 로 '자격증명 거부인가' 를 판정했다. 그런데 오류 문구에는
 * 장비 주소(`netError.describeFetchError` 의 `<host>:<port>`)·응답 본문 앞 200자(`httpFailMessage`)·SID 가 그대로 실린다 —
 * 호스트명 `vmax-401.corp` 의 시한 초과, 본문 `Symmetrix 000197601401 …` 의 HTTP 500, 경로 `pool_401` 의 404 가 전부
 * '401' 로 읽혀 **섹션 오류 하나가 그 주기 수집 전체를 실패시키고** 후보 경로 폴백(tryAny·tryPaths)도 다음 후보를 시도하지
 * 않았다. 그래서 판정은 문구가 아니라 이 표지로 한다(`isCredReject`).
 */
export const CRED_REJECT_MESSAGE = '인증 실패(401) — 계정/비밀번호 확인';
export function credRejectError(message = CRED_REJECT_MESSAGE) {
  const e = new Error(message);
  e.authFailed = true;
  e.status = 401;
  return e;
}

/**
 * 이 오류가 자격증명 거부(401)인가 — 스토리지 REST 수집기의 '즉시 전체 중단(계정 잠금 예방)' 판정 **단일 소스**.
 *  · 표지(`authFailed`·`status === 401`)가 먼저다 — 위 `credRejectError` 와 각 getter 가 싣는다.
 *  · 표지가 없는 옛 오류(테스트·다른 모듈이 만든 `new Error('인증 실패(401) …')`)는 **문구가 그 말로 시작할 때만** 받는다.
 *    ⚠ 부분 문자열(`/401/`)로 되돌리지 말 것 — 주소·본문·SID 속 '401' 이 다시 수집 전체를 멈춘다. 접두 고정이라 안전하다:
 *    전송 오류는 `<host>:<port>` 로, HTTP 오류는 `HTTP <상태>` 로 시작한다.
 *  · 403 은 대상이 아니다(예전과 같다) — 역할 권한이 없는 엔드포인트 하나가 수집 전체를 멈추지 않게. 주기 정지 판정은
 *    `storage/authGuard.js isAuthFailure` 가 따로 한다(401·403 문맥형).
 */
export function isCredReject(e) {
  if (!e || typeof e !== 'object') return false;
  if (e.authFailed === true || e.status === 401) return true;
  return /^인증 실패\(401\)/.test(String(e.message || ''));
}

export function makeGetter(device, { port = 443, headers = {}, signal = null } = {}) {
  assertHeaderSafe(headers); // 값 미포함 오류로 즉시 차단(아래 머리말 참조 — 유출 방지)
  const auth = Buffer.from(`${device.username}:${device.password || ''}`).toString('base64');
  return async (apiPath) => {
    const res = await fetchOrExplain(`https://${device.host}:${port}${apiPath}`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', ...headers },
      dispatcher, signal: reqSignal(signal),
    }, { host: device.host, port, signal });
    if (res.status === 401) throw credRejectError();
    if (!res.ok) throw new Error(await httpFailMessage(res, device));
    return res.json();
  };
}

/**
 * GET + 응답 헤더까지 필요한 경우(v2.404). PowerStore 는 POST 에 CSRF 토큰(DELL-EMC-TOKEN)을
 * 요구하는데, 그 값을 앞선 GET 의 **응답 헤더**로 내려준다 — makeGetter 는 본문만 주므로 별도.
 */
export function makeRawGetter(device, { port = 443, headers = {}, signal = null } = {}) {
  assertHeaderSafe(headers);
  const auth = Buffer.from(`${device.username}:${device.password || ''}`).toString('base64');
  return async (apiPath) => {
    const res = await fetchOrExplain(`https://${device.host}:${port}${apiPath}`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', ...headers },
      dispatcher, signal: reqSignal(signal),
    }, { host: device.host, port, signal });
    if (res.status === 401) throw credRejectError();
    if (!res.ok) throw new Error(await httpFailMessage(res, device));
    return { body: await res.json(), headers: res.headers };
  };
}

/**
 * POST(JSON) 헬퍼(v2.404) — **조회성 리소스 생성**에만 쓴다(PowerStore 의 metrics/generate 는
 * 이름과 달리 통계를 '계산해 돌려주는' 읽기 동작이라 장비 상태를 바꾸지 않는다).
 * ⚠ 실제 구성을 바꾸는 POST 를 이 헬퍼로 추가하지 말 것 — 스토리지 모니터링은 조회 전용이며,
 *   쓰기 경로가 생기면 감사/권한 설계를 다시 해야 한다.
 */
export function makePoster(device, { port = 443, headers = {}, signal = null } = {}) {
  assertHeaderSafe(headers);
  const auth = Buffer.from(`${device.username}:${device.password || ''}`).toString('base64');
  return async (apiPath, body, extraHeaders = {}) => {
    assertHeaderSafe(extraHeaders);
    const res = await fetchOrExplain(`https://${device.host}:${port}${apiPath}`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json', ...headers, ...extraHeaders },
      body: JSON.stringify(body ?? {}),
      dispatcher, signal: reqSignal(signal),
    }, { host: device.host, port, signal });
    if (res.status === 401) throw credRejectError();
    if (!res.ok) throw new Error(await httpFailMessage(res, device));
    return res.json();
  };
}

/** 후보 경로 순차 시도(버전차 폴백) — 전부 실패 시 마지막 오류 throw. 자격증명 거부(401)만 즉시 던진다(계정 잠금 예방). */
export async function tryAny(get, paths) {
  let err;
  for (const p of paths) { try { return await get(p); } catch (e) { err = e; if (isCredReject(e)) throw e; } }
  throw err;
}
