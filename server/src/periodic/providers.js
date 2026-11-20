/**
 * periodic/providers.js — 라우트 안에만 있는 조립(백업 Summary · 미보호 VM · VM DNS)을 정기 점검 리더가 **그대로** 쓰게 하는 등록부.
 *
 * 왜: 그 조립은 라우트 파일 안의 함수(요청 객체를 받는 summaryData 등)라 리더가 복제하면 판정이 두 벌이 된다('판정 코어는 하나').
 * 그렇다고 리더가 routes/ 를 import 하면 의존 방향이 거꾸로 된다(routes/ 는 index.js 만 import — docs/rules/common.md).
 * 그래서 라우트가 등록할 때 시스템 계정(전체 범위 · 관리자 판본)으로 부르는 함수를 여기에 등록하고, 리더는 이름으로 꺼낸다
 * (veeam/staleAlert.js setStaleProvider 와 같은 방식). 등록이 없으면(라우트를 싣지 않은 테스트 · 엣지) 리더는 '확인 불가'.
 */
const _p = new Map();

/** @param {string} name @param {Function|null} fn */
export function setPeriodicProvider(name, fn) {
  if (typeof fn === 'function') _p.set(String(name), fn); else _p.delete(String(name));
}
export function periodicProvider(name) { return _p.get(String(name)) || null; }
/** 시스템 계정 요청 모양 — 라우트 함수에 넘긴다(staleAlert 공급자와 같은 계정). */
export const SYSTEM_REQ = Object.freeze({ user: Object.freeze({ username: 'system', role: 'admin' }), query: Object.freeze({}) });
