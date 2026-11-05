/**
 * views/vcd/VcdParts.jsx — vCenter 상세 탭들이 함께 쓰는 작은 화면 조각(카드 머리 · 키-값 · 하위 칸 목록 · 도구 열기 링크).
 * 판정·문구는 vcdTabs.js(순수). 여기에는 모양만 둔다.
 */
import React from 'react';
import { toolAllowed } from '../../api.js';

export function Card({ title, sub, more, children, style, badge }) {
  return (
    <section className="card vcd-card" style={{ padding: 0, minWidth: 0, display: 'flex', flexDirection: 'column', ...style }} aria-label={typeof title === 'string' ? title : undefined}>
      <div className="vcd-card-h">
        <b style={{ fontSize: 13.5 }}>{title}</b>
        {badge}
        {sub && <span className="muted" style={{ fontSize: 11.5 }}>{sub}</span>}
        {more && <span style={{ marginLeft: 'auto', fontSize: 12 }}>{more}</span>}
      </div>
      {children}
    </section>
  );
}

/** 키-값 격자 — 값이 긴 문자열이면 줄바꿈(overflow-wrap). */
export function KV({ rows }) {
  return (
    <div className="vcd-kv">
      {rows.filter(Boolean).map(([k, v], i) => (
        <React.Fragment key={`${k}-${i}`}>
          <span className="muted">{k}</span>
          <div>{v}</div>
        </React.Fragment>
      ))}
    </div>
  );
}

export function Note({ children }) {
  return <div className="vcd-note muted">{children}</div>;
}

/** 특수 기능 화면으로 가는 링크 — 그 도구 권한이 없으면 그리지 않는다(눌러도 403 이라). */
export function ToolLink({ tool, children }) {
  if (!tool || !toolAllowed(tool)) return null;
  return <a href={`#/tools/${tool}`} className="vcd-more">{children || '도구에서 열기 →'}</a>;
}

/** 왼쪽 하위 칸 목록(모니터 · 구성). items: [{k,label,group?,n?}] — 400px 에서는 위쪽 가로 줄로 접힌다(CSS). */
export function SubNav({ items, value, onChange, label }) {
  let lastGroup = null;
  return (
    <nav className="vcd-sub" aria-label={label}>
      {items.map((it) => {
        const head = it.group && it.group !== lastGroup ? it.group : null;
        lastGroup = it.group || lastGroup;
        return (
          <React.Fragment key={it.k}>
            {head && <span className="vcd-sub-h">{head}</span>}
            <button type="button" className={value === it.k ? 'on' : ''} aria-current={value === it.k ? 'true' : undefined} onClick={() => onChange(it.k)}>
              <span>{it.label}</span>
              {it.n != null && <span className="vcd-n">{it.n}</span>}
            </button>
          </React.Fragment>
        );
      })}
    </nav>
  );
}

/** 수집하지 않는 칸 — 빈 표나 0 대신 그 사실을 말한다. */
export function NotCollected({ title, children }) {
  return (
    <div className="vcd-nc">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b>{title}</b>
        <span className="badge gray">수집하지 않음</span>
        <span className="badge purple">2차 · 수집 추가 필요</span>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}
