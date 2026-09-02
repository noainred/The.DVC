/**
 * Dell EMC Unity(Unisphere) REST 클라이언트 — 장비 등록 시 연결 테스트 + 용량/상태 조회.
 *
 * 보안 불변조건(server/CLAUDE.md) 준수:
 *  - **전역 TLS 디스패처 금지**: setGlobalDispatcher / NODE_TLS_REJECT_UNAUTHORIZED 로
 *    프로세스 전체 검증을 끄지 않는다(과거 vCenter용 전역 설정이 업그레이드 번들·NSX까지 오염).
 *    Unisphere 는 자가서명 인증서가 기본이라 검증 완화가 필요하지만, 그 범위를 이 모듈 전용
 *    `unityDispatcher` 안으로만 가둔다(vcenter/restClient.js vcDispatcher 와 동일 패턴).
 *    UNITY_TLS_STRICT=true 로 검증을 켤 수 있다.
 *
 * 리다이렉트를 자동 추종하지 않는 이유(실측):
 *   Unity 가 아닌 대상(예: CAS 등 SSO 뒤의 웹 서비스)에 요청하면 302 로 로그인 페이지로
 *   튕긴다. 자동 추종하면 HTML 본문이 돌아와 'JSON 파싱 오류'로만 보여 원인 파악이 불가능하다.
 *   redirect:'manual' 로 302 를 직접 잡아 "이 주소는 Unity REST 가 아니다"라고 알려준다.
 */

import { Agent } from 'undici';

// Unity 전용 TLS 정책(전역 오염 금지). 기본은 자가서명 허용, UNITY_TLS_STRICT=true 로 검증 ON.
const unityConnect = { rejectUnauthorized: process.env.UNITY_TLS_STRICT === 'true' };

export const unityDispatcher = new Agent({
  connect: unityConnect,
  connectTimeout: 15_000,
  keepAliveTimeout: 4_000,
  keepAliveMaxTimeout: 10_000,
  pipelining: 1,
});

/** Unisphere 필수 헤더 — X-EMC-REST-CLIENT 가 없으면 CSRF 방어에 걸려 거부된다. */
function authHeaders(entry) {
  const auth = `Basic ${Buffer.from(`${entry.username}:${entry.password}`).toString('base64')}`;
  return { 'X-EMC-REST-CLIENT': 'true', Accept: 'application/json', Authorization: auth };
}

/** 오류에 code 를 달아 호출부가 단계·원인별 안내를 만들 수 있게 한다. */
function fail(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Unisphere GET 1회.
 * @param {object} entry - { host, username, password }
 * @param {string} pathname - '/api/types/...' 절대 경로
 * @param {{authed?:boolean, timeoutMs?:number}} opts - authed=false 면 무인증(도달성 확인용)
 */
async function get(entry, pathname, { authed = true, timeoutMs = 10_000 } = {}) {
  const base = String(entry.host || '').replace(/\/+$/, '');
  const res = await fetch(base + pathname, {
    method: 'GET',
    headers: authed ? authHeaders(entry) : { 'X-EMC-REST-CLIENT': 'true', Accept: 'application/json' },
    redirect: 'manual', // 302(SSO 로그인)를 직접 잡는다 — 위 주석 참고
    dispatcher: unityDispatcher, // Unity 전용 TLS 정책(전역 오염 금지)
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') || '';
    throw fail(
      /\/cas\/login|\/login/i.test(loc)
        ? `SSO 로그인 페이지로 리다이렉트됨(${loc.slice(0, 120)}) — 이 주소는 Unity Unisphere REST 가 아니거나 앞단에 SSO 게이트웨이가 있습니다.`
        : `예상치 못한 리다이렉트(${res.status} → ${loc.slice(0, 120)})`,
      'REDIRECT',
    );
  }
  if (res.status === 401) throw fail('인증 실패 — 계정/비밀번호를 확인하세요.', '401');
  if (res.status === 403) throw fail('권한 부족 — 이 계정에 조회 권한이 없습니다.', '403');
  if (!res.ok) throw fail(`HTTP ${res.status} ${res.statusText}`, String(res.status));

  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    throw fail('JSON 이 아닌 응답(HTML) — Unity REST 가 아닌 웹 페이지로 보입니다.', 'NOT_JSON');
  }
  return res.json();
}

const firstEntry = (j) => j?.entries?.[0]?.content || null;
const allEntries = (j) => (j?.entries || []).map((x) => x.content);

/** 무인증 도달성 + OE/API 버전 — 네트워크·TLS·대상이 Unity 인지 확인. */
export const getBasicInfo = (entry) =>
  get(entry, '/api/types/basicSystemInfo/instances', { authed: false }).then(firstEntry);

/** 인증 확인 + 장비 식별(모델/시리얼). */
export const getSystem = (entry) =>
  get(entry, '/api/types/system/instances?fields=name,model,serialNumber').then(firstEntry);

/** 수집 대상 — 스토리지 풀 용량/상태. */
export const getPools = (entry) =>
  get(entry, '/api/types/pool/instances?fields=name,sizeTotal,sizeUsed,sizeFree,health').then(allEntries);
