/**
 * hooks/useTreeDnd.js — 트리 드래그앤드롭 상태 기계(v2.319, 모듈화 감사 #10).
 *
 * SvcMonitor.jsx 안에 있던 DnD 의 **기계적 부분**(드래그 항목/호버 존 상태, 커서 Y→존 판정,
 * HTML5 DnD 이벤트 핸들러 세트)을 훅으로 추출한다. 도메인 규칙(무엇을 어디에 놓을 수 있고,
 * 놓으면 서버에 뭘 호출하는지)은 콜백으로 주입받는다 — 훅은 재사용 가능, 뷰는 규칙만 소유.
 *
 * 반환 핸들러 계약(기존 SvcMonitor dnd 객체와 동일 — 소비부 무변):
 *   start(e, item)·end()·onOver(e, id, isFolder, forceZone?)·onLeave(id)·onDrop(e, id, isFolder, forceZone?)
 *   over: {id, zone}|null(드롭 표시용) · active: 드래그 중 여부
 *
 * @param {{canDrop:(item,id,zone,isFolder)=>boolean, onPerformDrop:(item,id,zone,isFolder)=>void}} opts
 *   canDrop: 존 하이라이트/drop 허용 판정(순수 — 훅이 onOver·onDrop 양쪽에서 호출).
 *   onPerformDrop: 실제 이동 수행(서버 호출 — 뷰 소유. 훅이 상태를 먼저 비우고 호출).
 */
import { useState } from 'react';

/**
 * 커서 Y 위치 → 드롭 존(순수 — useTreeDnd.test.js 고정).
 * 폴더: 상 30%=before / 중 40%=inside / 하 30%=after · 리프: 상/하 50%=before/after.
 */
export function dropZone(offsetY, height, isFolder) {
  const h = height || 1;
  return isFolder
    ? (offsetY < h * 0.3 ? 'before' : offsetY > h * 0.7 ? 'after' : 'inside')
    : (offsetY < h * 0.5 ? 'before' : 'after');
}

export function useTreeDnd({ canDrop, onPerformDrop }) {
  const [dragItem, setDragItem] = useState(null);
  const [dragOver, setDragOver] = useState(null); // { id, zone:'before'|'inside'|'after' } · id='' = Root
  const clear = () => { setDragItem(null); setDragOver(null); };
  const zoneOf = (e, isFolder, forceZone) => {
    if (forceZone) return forceZone;
    const r = e.currentTarget.getBoundingClientRect();
    return dropZone(e.clientY - r.top, r.height, isFolder);
  };
  return {
    item: dragItem,
    over: dragOver,
    active: !!dragItem,
    clear,
    start: (e, item) => {
      setDragItem(item);
      // dataTransfer 설정은 일부 브라우저에서 필수(없으면 드래그 자체가 시작 안 됨) — 실패 무해.
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', item.path || item.id || ''); } catch { /* noop */ }
    },
    end: clear,
    onOver: (e, id, isFolder, forceZone) => {
      const zone = zoneOf(e, isFolder, forceZone);
      if (!canDrop(dragItem, id, zone, isFolder)) return; // preventDefault 안 함 = 브라우저가 drop 금지 커서 표시
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch { /* noop */ }
      setDragOver((cur) => (cur?.id !== id || cur?.zone !== zone ? { id, zone } : cur));
    },
    onLeave: (id) => setDragOver((cur) => (cur && cur.id === id ? null : cur)),
    onDrop: (e, id, isFolder, forceZone) => {
      e.preventDefault(); e.stopPropagation();
      const zone = zoneOf(e, isFolder, forceZone);
      const item = dragItem;
      clear(); // 상태를 먼저 비운다(수행 실패해도 고스트 하이라이트가 안 남게 — 기존 doDrop 순서 보존)
      if (!item || !canDrop(item, id, zone, isFolder)) return;
      onPerformDrop(item, id, zone, isFolder);
    },
  };
}
