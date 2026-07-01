import { useEffect } from 'react';

// 열려 있는 모달 스택. ESC는 '가장 위(마지막에 열린)' 모달 하나만 닫는다 —
// 중첩 모달(예: 호스트 상세 → 호스트 VM 목록)에서 ESC 한 번에 둘 다 닫히던 버그 방지.
const stack = [];

/**
 * Renders nothing; while mounted, pressing ESC calls onClose. Drop this inside
 * any modal/popup so the Escape key closes it. Mounts/unmounts with the modal,
 * so the listener is active only while the popup is open. 중첩 시 최상단만 반응.
 */
export default function EscClose({ onClose }) {
  useEffect(() => {
    const token = {};
    stack.push(token);
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (stack[stack.length - 1] !== token) return; // 최상단 모달이 아니면 무시
      e.stopPropagation();
      onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const i = stack.indexOf(token);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [onClose]);
  return null;
}
