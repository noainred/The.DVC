// views/insight/MapSize.jsx — 지도 크기 조절 줄과 설정 상자(v3.21.0 · 설계 docs/design/host-insight §10 · 고침 ‘설정은 누를 때만’). VM · Hypervisor 분석이 같이 쓴다.
//   조절 줄: ‘설정 · 520px ▾’ 단추 하나(aria-expanded). 크기를 고르는 것(미리 정한 크기 · 높이 · 폭)은 전부 상자 안 — 상자는 단추를 누를 때만 열리고 ‘닫기’ 로 닫는다(처음 닫힘).
//   v3.22.1(사용자 지시 2026-11-18 21:04 — ‘크기 조정하는 메뉴가 항상 보여 · 설정 버튼을 누를 때만 보이고 평소에는 안 보여야 돼’): 조절 줄에 늘 보이던 ‘지도 크기’ 자동 · 보통 · 크게 · 아주 크게 칸을 뺐다(상자 안에 같은 칸이 있다).
//   상자: 높이(− · 슬라이더 · ＋ — 300 ~ 1,200px · 20px · 슬라이더는 키보드 ← → 로도 20px) · 미리 정한 크기 · 폭(기본 · 전체 폭 — 좁은 화면에서는 숨김) · 기본값으로 · 닫기.
//   값 계산 · 기억은 insightPrefs.js(순수 · try/catch) — useMapPrefs 가 화면별 키로 읽고 쓴다.
import React, { useState } from 'react';
import { MAP_SIZE_KEYS, MAP_H_MIN, MAP_H_MAX, MAP_H_STEP, DEFAULT_MAP_PREFS, loadMapPrefs, saveMapPrefs, pickMapSize, setMapH, mapHeightOf, normMapPrefs } from './insightPrefs.js';
import './insight.css';

/** 화면별 지도 설정 — [prefs, update(next)]. 저장은 try/catch(실패해도 화면은 그대로). */
export function useMapPrefs(storageKey) {
  const [prefs, setPrefs] = useState(() => loadMapPrefs(storageKey));
  const update = (next) => { const p = normMapPrefs(next); setPrefs(p); saveMapPrefs(storageKey, p); };
  return [prefs, update];
}

/** 조절 줄의 설정 단추 하나(v3.22.1 — 크기 칸은 상자 안에만). open/onOpen 은 호출부가 든다(상자는 조절 줄 아래 자리에 MapSizeBox 로). onPrefs 는 예전 호출 모양을 위해 받기만 한다. */
export function MapSizeSeg({ prefs, onPrefs, maxTiles, open, onOpen }) {
  const p = normMapPrefs(prefs);
  const h = mapHeightOf(p, maxTiles);
  return (
    <button type="button" className={`ins-btn${open ? ' on' : ''}`} aria-expanded={!!open} title="지도 크기 설정 — 누르면 열리고 ‘닫기’ 로 닫습니다"
      onClick={() => onOpen(!open)}>설정 · {h}px {open ? '▴' : '▾'}</button>
  );
}

/** 설정 상자 — 열렸을 때만 호출부가 그린다. narrow 면 폭 선택을 숨긴다(이미 한 열). screenName 은 안내 글(‘VM · Hypervisor’ 마다 따로 기억). */
export function MapSizeBox({ prefs, onPrefs, maxTiles, onClose, narrow = false, autoNote = '' }) {
  const p = normMapPrefs(prefs);
  const h = mapHeightOf(p, maxTiles);
  return (
    <div className="ins-cfg" role="group" aria-label="지도 크기 설정">
      <div className="ins-cfgh">
        <b>지도 크기 설정</b>
        <span className="hint">칸이 많아 작아질 때 지도를 키웁니다 — 정한 크기는 이 브라우저에 화면마다 따로 기억합니다</span>
        <button type="button" className="ins-btn" onClick={onClose}>닫기 ✕</button>
      </div>
      <div className="ins-cfgr">
        <span className="cl">높이</span>
        <button type="button" className="stp" aria-label={`${MAP_H_STEP}px 줄이기`} onClick={() => onPrefs(setMapH(p, h - MAP_H_STEP))} disabled={h <= MAP_H_MIN}>−</button>
        <input className="rng" type="range" min={MAP_H_MIN} max={MAP_H_MAX} step={MAP_H_STEP} value={h} aria-label="지도 높이" aria-valuetext={`${h}px`}
          onChange={(e) => onPrefs(setMapH(p, e.target.value))} />
        <button type="button" className="stp" aria-label={`${MAP_H_STEP}px 늘리기`} onClick={() => onPrefs(setMapH(p, h + MAP_H_STEP))} disabled={h >= MAP_H_MAX}>＋</button>
        <b className="val">{h}px</b>
        <span className="hint">{MAP_H_MIN.toLocaleString('en-US')} ~ {MAP_H_MAX.toLocaleString('en-US')}px · {MAP_H_STEP}px 단위</span>
      </div>
      <div className="ins-cfgr">
        <span className="cl">미리 정한 크기</span>
        <span className="ins-seg" role="group" aria-label="미리 정한 크기">
          {MAP_SIZE_KEYS.map(([k, label]) => (
            <button key={k} type="button" className={p.size === k ? 'on' : ''} aria-pressed={p.size === k} onClick={() => onPrefs(pickMapSize(p, k, maxTiles))}>{label}</button>
          ))}
        </span>
        {autoNote && <span className="hint">{autoNote}</span>}
      </div>
      {!narrow && (
        <div className="ins-cfgr">
          <span className="cl">폭</span>
          <span className="ins-seg" role="group" aria-label="지도 폭">
            {[[false, '기본 폭'], [true, '전체 폭']].map(([w, label]) => (
              <button key={label} type="button" className={p.wide === w ? 'on' : ''} aria-pressed={p.wide === w} onClick={() => onPrefs({ ...p, wide: w })}>{label}</button>
            ))}
          </span>
          <span className="hint">전체 폭 = 옆 패널을 아래로 내리고 지도를 화면 폭 전체로 씁니다</span>
        </div>
      )}
      <div className="ins-cfgr">
        <span className="cl">기억</span>
        <span className="hint">브라우저마다 · 화면마다 따로 기억합니다</span>
        <button type="button" className="ins-btn" onClick={() => onPrefs({ ...DEFAULT_MAP_PREFS })}>기본값으로</button>
      </div>
    </div>
  );
}
