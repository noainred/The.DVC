/**
 * cpuModelText.js — CPU 모델명 표시 문구(순수, v2.556).
 *
 * 사용자 요청(2026-09-18): 호스트 상세에 **CPU 모델명**을 보이게 한다.
 *
 * 왜 다듬는가: vCenter 가 주는 `summary.hardware.cpuModel` 은 벤더가 채운 원문이라 군더더기가
 * 많다 — `Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz`. 좁은 2열 그리드에서 그대로 쓰면 줄이
 * 밀리고, 사람이 실제로 대조하는 것은 `Xeon Gold 6338` 부분이다.
 *
 * ⚠ **다듬은 값만 보여주고 원문을 버리지 않는다** — 다른 벤더·구형 CPU 에서 이 정리가 빗나갈
 * 수 있으므로 원문을 `title`(툴팁)로 함께 남긴다(v2.544 `versionRaw` 규약과 같은 판단).
 * ⚠ 값이 없으면 **'—'** 다. 코어 수·클럭으로 모델명을 **추측해 지어내지 않는다**.
 */

/** 표시용으로 다듬은 이름. 원문이 없으면 빈 문자열. */
export function cpuModelText(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  return s
    .replace(/\((?:R|TM|C)\)/gi, '')     // (R) (TM) (C)
    .replace(/\bCPU\b/gi, '')            // 'Xeon Gold 6338 CPU @ 2.00GHz' → '… @ 2.00GHz'
    .replace(/\bProcessor\b/gi, '')      // AMD 'EPYC 7763 64-Core Processor'
    .replace(/\s*@\s*/, ' @ ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 화면에 쓸 `{ text, title }`. `text` 는 '—' 를 포함한 최종 문구, `title` 은 원문(없으면 안내).
 * 다듬은 결과가 원문과 같으면 툴팁을 중복해 붙이지 않는다.
 */
export function cpuModelCell(raw) {
  const s = String(raw ?? '').trim();
  const t = cpuModelText(s);
  if (!t) {
    return {
      text: '—',
      title: 'vCenter 가 이 호스트의 CPU 모델명을 보고하지 않았습니다(구버전 엣지에서 수집된 호스트일 수 있습니다).',
    };
  }
  return { text: t, title: t === s ? '' : s };
}
