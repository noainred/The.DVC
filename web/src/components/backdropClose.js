/**
 * 모달 배경(오버레이)을 눌러 닫기 — **누름과 뗌이 모두 배경**일 때만 닫는다(전체 점검 95회차 — Chromium 재현).
 *
 * 왜: 브라우저는 누름(mousedown)과 뗌(mouseup) 대상이 다르면 click 을 **두 대상의 공통 조상**에 보낸다. 창 안에서 글을 끌어 고르거나
 *   (resizable 창의) 모서리를 끌다가 배경 위에서 떼면 click 의 target 이 배경이 되어, `e.target === e.currentTarget` 만 보던 판정이
 *   창을 닫았다 — 입력하던 값 · 펼친 상태가 사라졌다(Playwright Chromium: 안에서 끌어 배경에서 떼기 → 닫힘 1회 실측).
 * 상태는 배경 요소의 data 속성에 둔다 — 훅을 쓰지 않으므로 조기 return 이 있는 컴포넌트에서도 안전하다(React #310 무관).
 *
 * 쓰는 법: `<div className="modal-overlay" {...backdropClose(onClose)}>` · 진행 중에 막으려면 `backdropClose(onClose, { disabled: busy })`.
 * @param {(e?: any) => void} onClose
 * @param {{ disabled?: boolean | (() => boolean) }} [opt]
 * @returns {{ onMouseDown: (e: any) => void, onClick: (e: any) => void }}
 */
export function backdropClose(onClose, { disabled = false } = {}) {
  return {
    onMouseDown: (e) => {
      const el = e?.currentTarget;
      if (el && el.dataset) el.dataset.downOnBackdrop = e.target === el ? '1' : '';
    },
    onClick: (e) => {
      const el = e?.currentTarget;
      const down = !!(el && el.dataset && el.dataset.downOnBackdrop === '1');
      if (el && el.dataset) el.dataset.downOnBackdrop = '';
      if (!el || e.target !== el || !down) return;
      const off = typeof disabled === 'function' ? disabled() : disabled;
      if (!off && typeof onClose === 'function') onClose(e);
    },
  };
}
