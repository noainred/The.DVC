/**
 * 주문형 vCenter 성능 조회가 **인증 실패 정지로 조회하지 않았다** 는 사실을 말하는 문구(v2.733 점검 3회차 C3-01) — 순수 모듈.
 *
 * 서버(`server/src/vcenter/authStopGate.js`)는 주 폴러가 인증 실패로 멈춘 vCenter 에는 로그인하지 않고 그 결과를 비운다(null).
 * 응답 모양은 둘이다 — 여러 vCenter 를 도는 경로(스파크라인·VM 트리 기간 사용률·유휴 VM 평균)는 `authStopped: { [vcenterId]: info }`,
 * vCenter 하나짜리(호스트·클러스터 추이)는 `authStopped: info`. info = `{ since, at, attempts, reason }`.
 * 여기서 '—'(이력 없음)와 구분해 말한다 — 둘을 같은 모양으로 두면 사용자가 vCenter 에 이력이 없다고 오해한다.
 * 문구 규칙: `**강조**` 만(BoldText), 백틱 금지, 값 인용은 ‘ ’.
 */

/** 맵 → 정렬된 목록 `[{ vcenterId, attempts }]`(시도 수가 없거나 읽지 못한 값이면 attempts null). */
export function authStoppedList(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  return Object.keys(map).sort().map((vcenterId) => {
    const n = Number(map[vcenterId]?.attempts);
    return { vcenterId, attempts: Number.isFinite(n) && n > 0 ? n : null };
  });
}

const triesText = (n) => (n == null ? '' : ` 실패 ${n}회`);
const HOW = '비밀번호를 고치거나 설정 › vCenter 연결 테스트가 성공하면 다시 조회합니다.';

/** 여러 vCenter 응답의 각주 한 줄. 정지가 없으면 빈 문자열. 이름은 5곳까지 적고 나머지는 개수로 밝힌다. */
export function authStopNote(map) {
  const list = authStoppedList(map);
  if (!list.length) return '';
  const names = list.slice(0, 5).map((x) => `‘${x.vcenterId}’${triesText(x.attempts)}`).join(' · ');
  const more = list.length > 5 ? ` 외 ${list.length - 5}곳` : '';
  return `**인증 실패로 멈춘 vCenter** ${list.length}곳(${names}${more})은 조회하지 않았습니다 — 계정 잠금을 막으려고 로그인하지 않습니다. ${HOW}`;
}

/** 표의 한 칸(정지된 vCenter 의 행). 이력이 없는 '—' 와 구분되는 짧은 글자 + 툴팁. */
export function authStopCell(info) {
  const n = Number(info?.attempts);
  const tries = Number.isFinite(n) && n > 0 ? `(실패 ${n}회)` : '';
  return { text: '인증 정지', title: `vCenter 인증 실패로 멈춰 있어 조회하지 않았습니다${tries}. ${HOW}` };
}

/** vCenter 하나짜리 응답(호스트·클러스터 추이)의 안내 한 줄. 정지가 아니면 빈 문자열. */
export function authStopSingleText(info) {
  if (!info || typeof info !== 'object') return '';
  const n = Number(info.attempts);
  const tries = Number.isFinite(n) && n > 0 ? `(실패 ${n}회)` : '';
  return `**vCenter 인증 실패로 조회를 멈췄습니다**${tries} — 계정 잠금을 막으려고 로그인하지 않습니다. ${HOW}`;
}

/** 툴팁(title)용 — 강조 표지를 뺀 평문(title 은 BoldText 를 거치지 않는다). */
export const plainText = (t) => String(t || '').replace(/\*\*/g, '');
