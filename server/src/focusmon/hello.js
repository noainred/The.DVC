/**
 * focusmon/hello.js — 연결 시험 결과의 정제 코어(엣지가 올린 시험 결과 · v3.18.0 접속 준비 결과가 같이 쓴다).
 * central/focusMonEdge.js 에 있던 것을 옮겼다(순환 import 없이 audit/service 도 쓰게) — 그쪽은 다시 내보낸다.
 */
import { numOrNull } from '../util/numOrNull.js';
import { strOf } from '../util/coercionTrap.js';

/** 연결 시험 결과 종류(collector.testTarget · runner.test 가 내는 것 — 웹 TEST_TEXT 와 같다). */
export const LOGIN_KINDS = Object.freeze(['ok', 'os-unverified', 'no-key', 'auth', 'auth-stopped', 'hostkey', 'timeout', 'unreachable', 'unsupported-os', 'bad-output']);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const n = numOrNull;

export function cleanHello(h) {
  if (!isObj(h)) return null;
  return {
    kernel: strOf(h.kernel, 120), isLinux: h.isLinux === true, release: strOf(h.release, 120),
    rhelMajor: typeof h.rhelMajor === 'string' && /^\d{1,2}\.\d{1,2}$/.test(h.rhelMajor) ? h.rhelMajor : null,
    tck: n(h.tck), page: n(h.page), ncpu: n(h.ncpu), hidepid: h.hidepid === true ? true : h.hidepid === false ? false : null,
    dacct: h.dacct === true ? true : h.dacct === false ? false : null, // v2.981 지연 집계(디스크 대기)
    hostname: strOf(h.hostname, 64).replace(/[^A-Za-z0-9._-]/g, ''),
  };
}
