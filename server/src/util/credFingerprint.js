/**
 * util/credFingerprint.js — 자격증명 '지문'(v2.528, 순수 모듈).
 *
 * 사용자 신고(2026-09-16): PowerStore `PS-HG-2`(엣지 HG 위임)가 `인증 실패(401)`. 장비 등록은
 * 됐고 중앙에서 CSV 로 내보내면 비밀번호가 정상으로 보이는데도 엣지 수집이 401 이다.
 *
 * ── 왜 필요한가 ────────────────────────────────────────────────────────────────
 * 엣지 위임 장비는 **중앙이 아니라 엣지가** 장비에 로그인한다. 그래서 401 이 났을 때 사용자가
 * 구분할 수 없는 두 가지가 겹친다:
 *   ⓐ 중앙→엣지 배포 과정에서 비밀번호가 상했다(잘림·인코딩·낡은 pull)
 *   ⓑ 배포는 온전한데 **장비에 설정된 비밀번호가 실제로 다르다**
 * 조치가 정반대인데 화면은 둘 다 "계정/비밀번호 확인" 이라고만 말한다. 이 지문은 **엣지가 실제로
 * 쓴 값**을 중앙 값과 눈으로 대조하게 해서 그 둘을 가른다.
 *
 * ── 정직성·보안 규칙 ───────────────────────────────────────────────────────────
 * 1. **평문은 어디에도 남기지 않는다.** 계정명 + 길이 + **비복원** 해시(djb2 하위 16비트)뿐이다.
 *    16비트라 역산으로 비밀번호를 복원할 수 없다(충돌이 흔하다) — '같은지 다른지' 비교 전용이다.
 * 2. 그래서 **'지문이 같다 = 비밀번호가 같다' 라고 단정하지 말 것.** 다르면 확실히 다르고,
 *    같으면 '같을 가능성이 높다' 다. 화면 문구도 그렇게 쓴다.
 * 3. **앞뒤 공백을 드러낸다** — 붙여넣기 사고의 최다 원인인데 화면에서는 보이지 않는다.
 *
 * ⚠ 이 구현은 `central/idracScanJobs.js` 가 v2.287 부터 쓰던 것을 그대로 옮긴 것이다(그 파일은
 *   이제 여기에 위임한다). 같은 기능을 두 벌 두면 표기가 갈라져 법인 간 대조가 불가능해진다.
 */

/**
 * djb2 변형 — 암호용이 아니다. 같은 입력 → 같은 4자리 16진수.
 *
 * ⚠ **하위 16비트를 쓴다**(v2.528 에 고친 v2.287 결함): 예전 구현은
 * `h.toString(16).slice(0, 4)` 로 **상위** 니블을 잘랐는데, djb2 는 뒤쪽 글자가 주로 하위
 * 비트를 바꾸므로 **끝 글자만 다른 비밀번호가 같은 지문**이 됐다(실측: `abc` 와 `abd` 가 둘 다
 * `#b873`). 이 지문의 존재 이유가 '바뀌었는지 대조' 인데 그 목적을 정면으로 깨는 결함이라
 * 고쳤다. 되돌리지 말 것 — 표기 형식(4자리 16진수)은 그대로다.
 */
function hash16(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return (h & 0xffff).toString(16).padStart(4, '0');
}

const hasEdgeSpace = (s) => /^\s|\s$/.test(s);

/**
 * 사람이 읽는 한 줄 지문. iDRAC 스캔 로그가 쓰던 표기를 그대로 유지한다(법인 간 대조용).
 * 예: `계정 'admin' · 비번 12자·#a3f9`
 */
export function credFingerprint(username, password) {
  const u = String(username ?? '');
  const p = String(password ?? '');
  const edge = hasEdgeSpace(p) ? ' · ⚠앞뒤공백' : '';
  return `계정 '${u}'${hasEdgeSpace(u) ? '(⚠공백)' : ''} · 비번 ${p.length}자·#${hash16(p)}${edge}`;
}

/**
 * 화면이 항목별로 쓰는 구조형. 문구를 만드는 쪽이 자유롭게 조합할 수 있게 값만 준다.
 * **비밀번호가 비어 있으면 `len:0`** 이고 그 사실 자체가 진단이다(배포가 비밀번호를 안 실어 왔다).
 * @returns {{user:string, userSpace:boolean, len:number, hash:string, space:boolean, empty:boolean, text:string}}
 */
export function credFingerprintParts(username, password) {
  const u = String(username ?? '');
  const p = String(password ?? '');
  return {
    user: u,
    userSpace: hasEdgeSpace(u),
    len: p.length,
    hash: hash16(p),
    space: hasEdgeSpace(p),
    empty: p.length === 0,
    text: credFingerprint(u, p),
  };
}
