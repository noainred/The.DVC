/**
 * views/sidebar/sidebarIcons.jsx — 사이드바 아이콘(인라인 SVG 경로, v2.726 시안 ICON 맵).
 * 이모지가 아니라 선 아이콘을 쓴다 — 아이콘 레일(64px)에서 글자 없이 구분돼야 한다. 그룹 id → 아이콘 이름 표는 여기 하나.
 */
import React from 'react';

export const ICON_PATH = Object.freeze({
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  chart: 'M4 19h16M7 16V9M12 16V5M17 16v-5',
  server: 'M4 5h16v5H4zM4 14h16v5H4zM7 7.5h.01M7 16.5h.01',
  db: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3v12c0 1.7-3.6 3-8 3s-8-1.3-8-3zM4 6c0 1.7 3.6 3 8 3s8-1.3 8-3M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  net: 'M5 5h4v4H5zM15 5h4v4h-4zM10 15h4v4h-4zM7 9v3h10V9M12 12v3',
  cpu: 'M7 7h10v10H7zM10 10h4v4h-4zM9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4',
  gauge: 'M4 19a8 8 0 1 1 16 0M12 19l4-6',
  wrench: 'M14.5 6.5a4 4 0 0 0 5 5L10 21l-3-3 7.5-7.5zM21 3l-3.5 3.5',
  msg: 'M4 5h16v11H8l-4 4z',
  cog: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  folder: 'M3 6h6l2 2h10v11H3z',
  edit: 'M4 20h4l10-10-4-4L4 16zM13 7l4 4',
  menu: 'M4 7h16M4 12h16M4 17h16',
  chevronLeft: 'M15 6l-6 6 6 6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  close: 'M6 6l12 12M18 6L6 18',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
});

/** 그룹 id → 아이콘 이름. 사용자 그룹(custom-…)·모르는 id 는 folder. */
export const GROUP_ICON = Object.freeze({
  overview: 'home', summary: 'chart', server: 'server', storage: 'db', network: 'net', resource: 'cpu', optimize: 'gauge',
  tools: 'wrench', board: 'msg', settings: 'cog',
});

export function iconNameOf(groupId) { return GROUP_ICON[groupId] || 'folder'; }

export function Icon({ name, size = 18, stroke = 'currentColor', className = '', title }) {
  const d = ICON_PATH[name] || ICON_PATH.folder;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d={d} />
    </svg>
  );
}
