/**
 * bmusage/idleConst.js — 8b단계 저활용(㉑) 열거(순수 · 의존 없음) — 계산(idle.js) · 중앙 정제(central/bmIdleSanitize.js) · 라우트가 같은 목록을 쓴다
 *   (정제 모듈이 계산 모듈의 의존 그래프(정비 창 · 용량 예측 · 설정)를 끌어오지 않게 따로 둔다).
 */
export const IDLE_STATUS = Object.freeze(['candidate', 'watch', 'active', 'periodic', 'excluded']);
/** 제외 사유 — insufficient(데이터 부족) · maint(지금 정비 창 안) · no-score(남은 가중 0) · dr(검토 상태 ‘대기 · DR’ — 라우트가 붙인다). */
export const IDLE_EXCLUDE = Object.freeze(['insufficient', 'maint', 'no-score', 'dr']);
export const IDLE_METRICS = Object.freeze(['cpu', 'mem', 'disk', 'net', 'power', 'act']);
/** 검토 상태(중앙 주석 저장소 auto 값 `idle:<상태>`) — clear 는 지우기(마지막 기록이 clear 면 상태 없음). */
export const IDLE_REVIEW = Object.freeze(['review', 'retire', 'keep', 'dr', 'clear']);
