/**
 * llm/limit.js — LLM(Ollama) 호출 동시 실행 상한(결정(56~75 남긴 것) 67).
 *
 * 왜: 자연어 검색(`POST /api/search/nl`)과 ChatOps(`POST /api/insights/chatops`)는 요청마다 Ollama 생성 1건(ChatOps 는 검색 + 답변 2건)을
 *   시한(기본 60초)까지 붙잡는다 — 로그인 사용자 몇 명이 연달아 누르면 Ollama 서버(대개 GPU 1장)와 이 포탈의 소켓 · 메모리가 함께 쌓였다.
 * 규칙: 동시에 LLM 을 쓰는 **요청** 수를 LLM_MAX_CONCURRENT(기본 2 · env · 1~16)로 묶는다. 자리가 없으면 기다리지 않고 바로 거절한다
 *   (라우트가 429 + 사유 '다른 질의 처리 중'). 한 요청 안의 여러 호출(ChatOps 의 검색 해석 + 답변)은 그 요청이 잡은 한 자리를 같이 쓴다.
 *   LLM 이 꺼져 있으면(규칙 기반 폴백) 자리를 잡지 않는다 — 폴백은 Ollama 를 부르지 않는다.
 */
import { envPositive } from '../util/envNumber.js';

export const LLM_CONCURRENT_MAX = 16;
export const LLM_MAX_CONCURRENT = envPositive(process.env.LLM_MAX_CONCURRENT, 2, { max: LLM_CONCURRENT_MAX });

let _inflight = 0;
let _refused = 0;

/** 자리 하나를 잡는다 — 잡으면 해제 함수(두 번 불러도 한 번만 푼다), 자리가 없으면 null. */
export function acquireLlmSlot(limit = LLM_MAX_CONCURRENT) {
  if (_inflight >= limit) { _refused += 1; return null; }
  _inflight += 1;
  let done = false;
  return () => { if (!done) { done = true; _inflight -= 1; } };
}

/** 자리가 없을 때 던지는 오류 — 라우트가 status 429 와 reason 을 그대로 싣는다. */
export function llmBusyError(limit = LLM_MAX_CONCURRENT) {
  const e = new Error(`다른 질의 처리 중입니다 — AI 질의는 동시에 ${limit}건까지입니다. 잠시 뒤 다시 시도하세요.`);
  e.status = 429; e.code = 'llm-busy';
  return e;
}

export function llmLimitStatus() { return { max: LLM_MAX_CONCURRENT, inflight: _inflight, refused: _refused }; }
export function _resetLlmLimitForTest() { _inflight = 0; _refused = 0; }
