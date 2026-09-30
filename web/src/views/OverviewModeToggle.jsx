/**
 * OverviewModeToggle.jsx — Overview '경영 보기 ↔ 엔지니어 보기' 전환(v2.670).
 * 모드는 **보기 설정이지 권한이 아니다**(version_4/mode.js) — 두 보기의 권한·데이터 범위·임계값은 같다.
 */
import React from 'react';
import { MODES, MODE_LABEL } from '../version_4/mode.js';

export default function OverviewModeToggle({ mode, onChange }) {
  return (
    <div className="xov-mode" role="group" aria-label="보기 모드">
      {MODES.map((m) => (
        <button key={m} type="button" className={m === mode ? 'on' : ''} aria-pressed={m === mode} onClick={() => onChange?.(m)}>{MODE_LABEL[m]}</button>
      ))}
    </div>
  );
}
