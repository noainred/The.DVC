/**
 * storage/collectors/restCommon.js — REST 수집기 공용 HTTP 헬퍼(v2.309).
 * PowerStore/Unity 수집기가 공유한다(isilon.js 의 get/getAny 와 동일 철학 — 포트·헤더만 다름).
 * 자체서명 장비 한정 로컬 TLS 디스패처(전역 오염 금지 — server/CLAUDE.md). 401 은 명시 오류로
 * 던져 수집기가 즉시 중단하게 한다(장비 계정 잠금 예방 — isilon 과 동일 규칙).
 */
import { Agent } from 'undici';

const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
const TIMEOUT_MS = Number(process.env.STORAGE_HTTP_TIMEOUT_MS) || 15_000;

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

export function makeGetter(device, { port = 443, headers = {} } = {}) {
  assertHeaderSafe(headers); // 값 미포함 오류로 즉시 차단(아래 머리말 참조 — 유출 방지)
  const auth = Buffer.from(`${device.username}:${device.password || ''}`).toString('base64');
  return async (apiPath) => {
    const res = await fetch(`https://${device.host}:${port}${apiPath}`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', ...headers },
      dispatcher, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) throw new Error('인증 실패(401) — 계정/비밀번호 확인');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
}

/**
 * GET + 응답 헤더까지 필요한 경우(v2.404). PowerStore 는 POST 에 CSRF 토큰(DELL-EMC-TOKEN)을
 * 요구하는데, 그 값을 앞선 GET 의 **응답 헤더**로 내려준다 — makeGetter 는 본문만 주므로 별도.
 */
export function makeRawGetter(device, { port = 443, headers = {} } = {}) {
  assertHeaderSafe(headers);
  const auth = Buffer.from(`${device.username}:${device.password || ''}`).toString('base64');
  return async (apiPath) => {
    const res = await fetch(`https://${device.host}:${port}${apiPath}`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', ...headers },
      dispatcher, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) throw new Error('인증 실패(401) — 계정/비밀번호 확인');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { body: await res.json(), headers: res.headers };
  };
}

/**
 * POST(JSON) 헬퍼(v2.404) — **조회성 리소스 생성**에만 쓴다(PowerStore 의 metrics/generate 는
 * 이름과 달리 통계를 '계산해 돌려주는' 읽기 동작이라 장비 상태를 바꾸지 않는다).
 * ⚠ 실제 구성을 바꾸는 POST 를 이 헬퍼로 추가하지 말 것 — 스토리지 모니터링은 조회 전용이며,
 *   쓰기 경로가 생기면 감사/권한 설계를 다시 해야 한다.
 */
export function makePoster(device, { port = 443, headers = {} } = {}) {
  assertHeaderSafe(headers);
  const auth = Buffer.from(`${device.username}:${device.password || ''}`).toString('base64');
  return async (apiPath, body, extraHeaders = {}) => {
    assertHeaderSafe(extraHeaders);
    const res = await fetch(`https://${device.host}:${port}${apiPath}`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json', ...headers, ...extraHeaders },
      body: JSON.stringify(body ?? {}),
      dispatcher, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) throw new Error('인증 실패(401) — 계정/비밀번호 확인');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
}

/** 후보 경로 순차 시도(버전차 폴백) — 전부 실패 시 마지막 오류 throw. */
export async function tryAny(get, paths) {
  let err;
  for (const p of paths) { try { return await get(p); } catch (e) { err = e; if (/401/.test(e.message)) throw e; } }
  throw err;
}
