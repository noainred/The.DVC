/**
 * 규칙(이름 · 자동 규칙)이 보는 베어메탈 이름 — **가린 뒤 이름**(판정 코어 하나).
 *   · 이름 속 서비스 태그는 NUL 로 걷어 낸다(규칙 값에는 제어 문자가 들어갈 수 없다 — 걷어 낸 자리를 건너 맞지 않는다)
 *   · 관리 주소처럼 보이는 이름(nameIsAddr)은 '' — 어떤 규칙에도 걸리지 않는다
 * 쓰는 곳: 물리서버 폴더 자동 규칙(`bmfolders/build.js ruleFor` — v2.987) · 서비스 인벤토리 이름 규칙(`servicemap/resolve.js` 베어메탈 — v2.989).
 * 이유: 원문 이름으로 맞추면 쓰기 계정이 규칙 값을 바꿔 가며 소속 변화로 가린 태그 · 주소를 맞혀 볼 수 있다(물리서버 폴더 1차 반증 5 · servicemap 4차 반증 4 — 재현 204회).
 * 판정은 판본(관리자 · 범위 계정)마다 바꾸지 않는다 — 모든 계정에 같은 '가린 뒤 이름'. 정규식 없이 선형(외부 입력).
 */
const lc = (s) => String(s ?? '').trim().toLowerCase();
export function ruleNameOf(m) {
  if (!m || m.nameIsAddr) return '';
  const n = lc(m.name).slice(0, 256);
  const tg = lc(m.serviceTag);
  if (!tg || tg.length < 2) return n;
  let out = ''; let i = 0;
  for (let j = n.indexOf(tg); j >= 0; j = n.indexOf(tg, i)) { out += `${n.slice(i, j)}\u0000`; i = j + tg.length; }
  return out + n.slice(i);
}
