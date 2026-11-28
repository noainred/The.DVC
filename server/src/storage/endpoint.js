/**
 * storage/endpoint.js — **스토리지 장비의 실제 수집 접속처(주소:포트) 판정 하나**(순수 · v3.54).
 *
 * 스토리지 등록부의 host 는 주소만 담는다(콜론 불가 — registry.js RE_HOST). 포트는
 *   · SSH 수집: 장비마다 등록한 `sshPort`(기본 22)
 *   · REST 수집: **그 노드의 env** 가 기종별로 정한다(아래 표 — 장비별 포트 칸은 없다)
 * 예전에는 이 표가 수집기 6개 파일에 흩어진 사본이었고, 설정 카탈로그(linkcheck/settingsLinks.js)는 REST 를 443 으로 고정해
 * PowerMax(8443) · Isilon REST(8080) 를 틀린 포트로 점검했다(v3.54 포탈 서비스 상태 모니터링 조사 · 등록부 보고 §6). 수집기 · 카탈로그 · 서비스 상태가
 * 모두 이 파일을 읽는다 — 새 기종 · 새 env 는 여기 한 곳에만 더한다(시험 `svcStatus354` 이 수집기 소스에 사본이 없는지 본다).
 */
import { normalizeCollectMethod } from './types.js';
import { envPort } from '../util/envNumber.js';

/** 기종 → [REST 포트 env 이름, 기본 포트]. */
export const REST_PORT_ENV = Object.freeze({
  isilon: Object.freeze(['STORAGE_ISILON_PORT', 8080]),
  powerstore: Object.freeze(['STORAGE_POWERSTORE_PORT', 443]),
  unity480: Object.freeze(['STORAGE_UNITY_PORT', 443]),
  xtremio: Object.freeze(['STORAGE_XMS_PORT', 443]),
  vmax: Object.freeze(['STORAGE_UNISPHERE_PORT', 8443]),
  powermax: Object.freeze(['STORAGE_UNISPHERE_PORT', 8443]),
  vplex: Object.freeze(['STORAGE_VPLEX_PORT', 443]),
  metronode: Object.freeze(['STORAGE_VPLEX_PORT', 443]),
});
export const SSH_DEFAULT_PORT = 22;

/** 기종의 REST 기본 포트(env 를 보지 않은 값). 모르는 기종은 443. */
export function restDefaultPortOf(type) { return REST_PORT_ENV[String(type || '')]?.[1] ?? 443; }

/** 기종의 REST 포트 — env(1~65535 정수)가 있으면 그 값, 아니면 기본. `env` 는 시험 · 엣지 대조용 주입. */
export function restPortOf(type, env = process.env) {
  const spec = REST_PORT_ENV[String(type || '')];
  if (!spec) return 443;
  return envPort(env?.[spec[0]], spec[1]);
}

/**
 * 장비 하나의 수집 접속처.
 * @param {{type:string, host:string, collectMethod?:string, sshPort?:number}} d 등록부 항목(비밀 제거본이면 충분)
 * @returns {{ host:string, port:number, method:'ssh'|'api', proto:'ssh'|'https', defaultPort:number }}
 *   defaultPort = 그 방식의 기본 포트(env 를 보지 않은 값) — 화면 '기본 포트 아님' 판정용.
 */
export function storageEndpointOf(d = {}, env = process.env) {
  const type = String(d?.type || '');
  const method = normalizeCollectMethod(type, String(d?.collectMethod || ''));
  const host = String(d?.host || '').trim();
  if (method === 'ssh') {
    const p = Number(d?.sshPort);
    return { host, port: Number.isInteger(p) && p >= 1 && p <= 65535 ? p : SSH_DEFAULT_PORT, method, proto: 'ssh', defaultPort: SSH_DEFAULT_PORT };
  }
  return { host, port: restPortOf(type, env), method, proto: 'https', defaultPort: restDefaultPortOf(type) };
}
