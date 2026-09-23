/**
 * perf/requestId.js — 요청 ID(v2.583). 사용자 요청: "'불러오는 중…' 이 나올 때 누가 이 지연을
 * 발생시켰는지 ID 도 같이 보여줘."
 *
 * 브라우저는 응답을 받기 전에는 서버가 붙인 헤더를 볼 수 없다. 그래서 **브라우저가 ID 를 만들어
 * `X-Request-Id` 로 보내고**, 서버는 형식이 맞으면 그 값을 그대로 쓴다(아니면 서버가 만든다).
 * 같은 ID 가 ① 로딩 화면 ② 서버 성능 측정의 느린 요청·hang 기록 ③ 라이브 로그 한 줄에 함께
 * 찍혀 세 곳을 눈으로 대조할 수 있다.
 *
 * 형식을 좁히는 이유: 이 값은 인증보다 앞(요청 계측 미들웨어)에서 읽혀 로그·NDJSON 에 남는다.
 * 임의 문자열을 받으면 로그 한 줄 위조(개행)·길이 증폭이 된다. 영숫자로 시작하는 4~40자
 * `[A-Za-z0-9._-]` 만 받는다. ID 는 **식별용**이지 권한 근거가 아니다 — 남의 ID 를 보내도
 * 상태 조회는 소유자(로그인 계정)로 거른다(`monitor.requestStatus`).
 */

const RID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{3,39}$/;

/** 형식이 맞으면 그대로, 아니면 빈 문자열. */
export function sanitizeRid(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return RID_RE.test(s) ? s : '';
}

// 부팅마다 달라지는 접두 — 재시작 뒤 같은 번호가 다른 요청을 가리키지 않게 한다.
const BOOT = `s${Date.now().toString(36).slice(-5)}`;
let seq = 0;

/** 서버가 만드는 ID(브라우저가 보내지 않은 요청 — curl·엣지·구버전 화면). */
export function newRid() {
  seq = (seq + 1) % 2_000_000_000;
  return `${BOOT}-${seq.toString(36)}`;
}
