// Modal.jsx — ui.jsx(구 633줄)에서 분리(v2.295). 본문은 원본 164~190행 그대로.
// 단독 분리 이유: VmRemote/VmReconfig(EntityDetail 이 import)가 Modal 하나 때문에 ui.jsx 를
// 역참조하는 순환이 있었다(함수 선언 호이스팅으로만 동작하던 상태 — 2차 감사 확인). 이 파일을
// 직접 import 하게 바꿔 순환을 구조적으로 절단한다. ⚠ Modal 은 함수 선언 유지(const 화하면
// 남은 소비자의 모듈 평가 시점 참조에서 TDZ 크래시 위험 — 검증자 지적).
import React from 'react';
import EscClose from './EscClose.jsx';

/** Simple centered modal. Click the backdrop, press ESC, or 닫기 to close.
 *  bodyScroll=false: 본문 자체는 스크롤하지 않고 flex 컬럼이 된다 — 내부에 자기 스크롤을 갖는
 *  표(.table-wrap) 하나가 본문 전체를 채우는 모달에서 '스크롤바 두 개'가 겹치는 것을 막는다. */
export function Modal({ title, onClose, children, width = 560, resizable = false, minWidth = 360, minHeight = 240, bodyScroll = true }) {
  // Header stays pinned while the body scrolls, so long detail content (many
  // rows + action buttons) is always fully reachable by scrolling.
  // resizable=true: 사용자가 모서리를 드래그해 창 크기를 조절할 수 있다.
  const resizeStyle = resizable
    ? { width, maxWidth: '95vw', height: 'min(70vh, 560px)', maxHeight: '95vh', minWidth, minHeight, resize: 'both' }
    : { maxWidth: width, maxHeight: '88vh' };
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <EscClose onClose={onClose} />
      <div className="modal card" style={{ ...resizeStyle, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="flex between" style={{ marginBottom: 12, flex: '0 0 auto' }}>
          <b style={{ fontSize: 15 }}>{title}</b>
          <button className="logout-btn" onClick={onClose}>닫기</button>
        </div>
        <div style={bodyScroll
          ? { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden', paddingRight: 4, marginRight: -4 }
          : { flex: '1 1 auto', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {children}
        </div>
      </div>
    </div>
  );
}
