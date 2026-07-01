import { useEffect, useRef } from 'react';

// 열려 있는 모달 스택. ESC는 '가장 위(마지막에 열린)' 모달 하나만 닫는다 —
// 중첩 모달(예: 호스트 상세 → 호스트 VM 목록)에서 ESC 한 번에 둘 다 닫히던 버그 방지.
const stack = [];

/**
 * Renders nothing; while mounted, pressing ESC calls onClose. Drop this inside
 * any modal/popup so the Escape key closes it. Mounts/unmounts with the modal,
 * so the listener is active only while the popup is open. 중첩 시 최상단만 반응.
 */
export default function EscClose({ onClose }) {
  // onClose를 ref로 최신값 유지 — effect는 '마운트당 1회'만 돌아 stack 순서가 안정적이다.
  // (deps에 onClose를 넣으면 인라인 onClose를 쓴 배경 모달이 리렌더될 때 token이 stack
  //  끝으로 재삽입돼 ESC 대상이 실제 최상단에서 배경 모달로 잘못 넘어간다.)
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const token = {};
    stack.push(token);
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (stack[stack.length - 1] !== token) return; // 최상단 모달이 아니면 무시
      e.stopPropagation();
      onCloseRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const i = stack.indexOf(token);
      if (i >= 0) stack.splice(i, 1);
    };
  }, []);
  return null;
}
