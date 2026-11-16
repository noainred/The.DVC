/**
 * util/saveBlob.js — 만든 파일(Blob)을 사용자 PC 에 내려받게 한다 — **공용 하나**(v3.17.5 · 2차 공통 기능 점검 4회차).
 *
 * 왜: 화면 30여 곳이 `URL.createObjectURL → a.click() → revokeObjectURL` 을 손으로 적었고 세 가지로 갈라져 있었다 —
 *   ① 누르자마자 `revokeObjectURL` 을 부른 곳(13곳): 내려받기가 아직 그 주소를 읽기 전에 지워질 수 있다(Chrome 은 대개 괜찮지만 브라우저 · 상황에 따라 빈 파일 · 실패)
 *   ② `<a>` 를 문서에 붙이지 않고 누른 곳: 일부 브라우저는 문서 밖 요소의 click 으로 내려받지 않는다
 *   ③ 지우지 않은 곳: 내보내기마다 Blob 이 탭 메모리에 남는다.
 * 규칙: 문서에 붙여 누르고 바로 떼며, 주소는 1초 뒤 지운다(api.js downloadFile 과 같은 규약).
 */

/** Blob 을 파일 이름으로 내려받는다. 이름이 비면 'download'. */
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = String(name || 'download');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** 글(CSV · 마크다운 등)을 파일로. `bom` 이면 엑셀이 UTF-8 로 읽게 BOM 을 붙인다. */
export function saveText(text, name, { type = 'text/plain;charset=utf-8', bom = false } = {}) {
  saveBlob(new Blob([bom ? `﻿${text}` : String(text)], { type }), name);
}

export default saveBlob;
