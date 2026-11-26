import { fetchJson } from '../../api.js';

/**
 * 무거운 CVP 조회(링크 품질 · 회수 · 예측 · GBIC 추세 · 토폴로지 · 이중화 · 전후 비교 · 전 스위치 여유) 공용 호출 — v3.42 버그 점검 3회차 A5-F1.
 *  · 서버가 이 조회들을 동시 상한 안에서 줄 세운다(server/src/cvp/heavyGate.js). 그래서 **자동 재시도를 끄고**(기본 2회 — 시한에 걸리면 같은 계산이 또 줄을 선다)
 *    시한을 길게 둔다(기본 20초면 줄에서 기다리다 끊긴다).
 *  · 화면이 버린 요청(기간 · CVP 변경 · 탭 이동 · 새로고침 거듭 누르기)은 **취소**한다 — effect 정리에서 `ac.abort()`. 취소하지 않으면 버린 요청이 서버 줄을 끝까지 차지한다.
 */
export const HEAVY_TIMEOUT_MS = 150_000;
export const fetchHeavy = (path, params = {}, signal) => fetchJson(path, params, signal, { timeoutMs: HEAVY_TIMEOUT_MS, retries: 0 });
