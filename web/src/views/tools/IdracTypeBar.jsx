// IdracTypeBar.jsx — iDRAC 통합 추이 › 서버 종류 선택(v2.687 — 구성: GPU 있음 · CPU 만 × 형태: 가상화 · 베어메탈).
// 판정·개수는 idracTrendText.js(typeCounts — vitest)가 한다. 두 보기(서버 추이·서버 표)가 같은 선택을 쓴다.
import React from 'react';
import { GPU_TYPES, KIND_TYPES, typeCounts } from './idracTrendText.js';

const chip = (on) => ({ flex: 'none', padding: '3px 10px', marginTop: 0, fontSize: 12, whiteSpace: 'nowrap' });

export function IdracTypeBar({ servers, value, onChange }) {
  const c = typeCounts(servers, value);
  const group = (label, opts, key, counts, title) => (
    <span className="flex wrap" style={{ gap: 4, alignItems: 'center' }} role="group" aria-label={label} title={title}>
      <span className="muted" style={{ fontSize: 13 }}>{label}</span>
      {opts.map((o) => (
        <button key={o.k || 'all'} type="button" className={value[key] === o.k ? 'login-btn' : 'tab'} style={chip()} aria-pressed={value[key] === o.k}
          disabled={!counts[o.k] && value[key] !== o.k} onClick={() => onChange({ ...value, [key]: o.k })}>
          {o.label} ({counts[o.k] ?? 0})
        </button>
      ))}
    </span>
  );
  return (
    <div className="flex wrap" style={{ gap: 14, alignItems: 'center' }}>
      {group('구성', GPU_TYPES, 'gpu', c.gpu, 'GPU 있음 = GPU 온도·iDRAC 인벤토리 GPU·매칭 ESXi 호스트 GPU 중 하나라도 확인 · CPU 만 = GPU 0 장으로 읽은 서버만')}
      {group('형태', KIND_TYPES, 'kind', c.kind, '가상화 = 이름·서비스태그로 ESXi 호스트와 매칭된 서버 · 베어메탈 = 매칭되지 않은 서버')}
      {c.unknown > 0 && <span className="muted" style={{ fontSize: 11 }}>GPU 유무를 확인하지 못한 서버 {c.unknown}대는 'GPU 있음'·'CPU 만' 어느 쪽에도 넣지 않았습니다.</span>}
    </div>
  );
}
