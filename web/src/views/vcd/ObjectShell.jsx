/**
 * views/vcd/ObjectShell.jsx — 개체 보기의 공통 틀(v2.895 — 승인 시안 ⑧⑨): 경로 줄(← 돌아가기) · 개체 머리 · 탭 줄.
 * 새 셸이 아니다 — vCenter 상세 화면 안에서 탭 자리를 대신한다(기본값 8). 탭 줄은 vCenter 탭과 같은 모양(한 줄 · 넘치면 그 줄만 가로 스크롤).
 */
import React from 'react';
import { objTabsOf } from './objTabs.js';

export default function ObjectShell({ type, crumbs, onBack, backLabel, title, badges, sub, actions, tab, onTab, extraTabs = [], children }) {
  const base = objTabsOf(type);
  return (
    <div className="vcd-obj" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10, minWidth: 0 }}>
      {/* v2.915(가상화 플랫폼 · 브레드크럼 3단): 가상화 플랫폼 › vCenter › <vCenter 이름 · 누르면 vCenter 탭으로> › 클러스터/폴더 › <이름>. '← 돌아가기' 는 줄 끝에 남긴다. */}
      <nav className="vcd-crumb" aria-label="경로">
        <a href="#/vcenters" style={{ color: 'var(--text-dim)', fontWeight: 600, textDecoration: 'none' }}>가상화 플랫폼</a>
        <span aria-hidden="true">›</span>
        <a href="#/vcenters" style={{ color: 'var(--text-dim)', fontWeight: 600, textDecoration: 'none' }}>vCenter</a>
        {crumbs.filter(Boolean).map((c, i) => (
          <React.Fragment key={`${c}-${i}`}><span aria-hidden="true">›</span>{i === 0 ? <button type="button" className="vcd-more" style={{ textDecoration: 'none', color: 'var(--text-dim)', fontWeight: 600 }} onClick={onBack} title={`${backLabel} 탭으로`}>{c}</button> : <span>{c}</span>}</React.Fragment>
        ))}
        <span aria-hidden="true">›</span><b>{title}</b>
        <button type="button" className="vcd-more" style={{ marginLeft: 'auto' }} onClick={onBack}>← {backLabel}</button>
      </nav>
      <div className="card vcd-obj-head">
        <div style={{ minWidth: 0 }}>
          <div className="vcd-line" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 17, fontWeight: 800, overflowWrap: 'anywhere' }}>{title}</span>
            {badges}
          </div>
          {sub && <div className="muted" style={{ fontSize: 12, marginTop: 2, overflowWrap: 'anywhere' }}>{sub}</div>}
        </div>
        {actions && <div className="flex gap" style={{ flexWrap: 'wrap', rowGap: 8, justifyContent: 'flex-end' }}>{actions}</div>}
      </div>
      <nav className="vcd-views" role="tablist" aria-label={type === 'host' ? '호스트 보기' : 'VM 보기'}>
        {[...base, ...(extraTabs.length ? [{ sep: true }] : []), ...extraTabs].map((t, i) => (t.sep
          ? <span key={`sep-${i}`} aria-hidden="true" style={{ flex: 'none', width: 1, alignSelf: 'stretch', margin: '4px 4px', background: 'var(--border)' }} />
          : (
            <button key={t.k} type="button" role="tab" aria-selected={tab === t.k} className={tab === t.k ? 'login-btn' : 'tab'}
              style={{ flex: 'none', padding: '6px 10px', fontSize: 13 }} onClick={() => onTab(t.k)}>{t.label}{t.n != null ? <span className="vcd-n" style={{ marginLeft: 6 }}>{t.n}</span> : null}</button>
          )))}
      </nav>
      {children}
    </div>
  );
}
