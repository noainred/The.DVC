// views/platform/PlatformHub.jsx — '서버 › 가상화 플랫폼' 허브 셸(v2.915 · 설계 docs/design/virt-platform-menu 시안 A ②③④⑥ · 컨펌 2026-11-07 '시안 A · 표준 검증').
//   App 이 vcenters · hosts · vms 탭 위에 그린다: 제목 · 엔티티 탭 3장(수 + '지금 볼 것' 배지 + 그 탭의 분해) · 바로가기 칩(vCenter 별 이 탭의 숫자 · 고른 법인은 파랗게 · 접기 기억).
//   숫자는 서버 /platform/summary 하나(30초 · 탭 배지를 위해 무거운 집계를 다시 부르지 않는다) — 응답 전 · 첫 수집 중은 '—'(0 금지). 화면은 글자만 만든다(platformText.js).
//   탭 id · 해시는 그대로(#/vcenters · #/hosts · #/vms) — 탭을 누르면 App 의 setTab, 칩을 누르면 허브 범위(위 필터 바의 vCenter)가 그 법인으로 바뀐다.
import React, { useState } from 'react';
import { usePolling } from '../../api.js';
import { vcQuickDot } from '../vcCardText.js';
import { entityTabs, chipCount, chipLegend, loadChipsCollapsed, saveChipsCollapsed } from './platformText.js';
import './platform.css';

const lsSafe = () => { try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; } };

const ICON = {
  vcenters: <svg className="ph-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 7h8M8 11h8M8 15h5" /></svg>,
  hosts: <svg className="ph-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="5" rx="1.5" /><rect x="3" y="14" width="18" height="5" rx="1.5" /><path d="M7 7.5h.01M7 16.5h.01" /></svg>,
  vms: <svg className="ph-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>,
};

/**
 * @param {object} p
 * @param {'vcenters'|'hosts'|'vms'} p.tab  열린 탭
 * @param {string[]} p.tabs                 이 사용자가 볼 수 있는 허브 탭(권한 — App visibleTabs)
 * @param {(t:string)=>void} p.onTab
 * @param {{region?:string,vcenterId?:string}} p.scope  허브 범위(위 필터 바) — 요약도 같은 범위로 센다
 * @param {object[]} p.vcenters             /vcenters 목록(App 폴링) — 칩 순서 · 상태 점
 * @param {string} p.vcenterId              고른 법인(없으면 '')
 * @param {(id:string)=>void} p.onPickVcenter  칩 클릭 — 같은 칩을 다시 누르면 전체
 */
export default function PlatformHub({ tab, tabs, onTab, scope, vcenters, vcenterId, onPickVcenter }) {
  const { data: summary } = usePolling('/platform/summary', scope || {}, 30_000);
  const [folded, setFolded] = useState(() => loadChipsCollapsed(lsSafe()));
  const toggleFold = () => { const n = !folded; setFolded(n); saveChipsCollapsed(lsSafe(), n); };
  const items = entityTabs(summary).filter((t) => tabs.includes(t.k));
  const byVc = new Map((summary?.byVc || []).map((r) => [r.id, r]));
  const sites = Array.isArray(vcenters) ? vcenters : [];
  const snap = summary?.generatedAt ? new Date(summary.generatedAt).toLocaleTimeString('ko-KR') : '';
  const cur = items.find((t) => t.k === tab) || null;
  return (
    <section className="ph" aria-label="가상화 플랫폼">
      <header className="ph-head">
        <h1>가상화 플랫폼</h1>
        <span className="ph-sub">법인 = vCenter = Bareos 한 단위 · vCenter 에서 호스트 · VM 으로 내려가고, 숫자를 누르면 그 범위로 탭이 바뀝니다</span>
        <span className="ph-note">마지막으로 본 탭을 기억합니다</span>
        {snap && <span className="ph-snap" title="이 숫자들의 기준(인벤토리 스냅샷 시각)">스냅샷 {snap}</span>}
      </header>

      <nav className="ph-tabs" role="tablist" aria-label="가상화 플랫폼 보기">
        {items.map((t) => {
          const on = t.k === tab;
          return (
            <a key={t.k} role="tab" aria-selected={on} href={`#/${t.k}`} className={`ph-tab${on ? ' on' : ''}`} onClick={(e) => { e.preventDefault(); onTab(t.k); }}>
              <span className="lb">{ICON[t.k]}{t.label}{t.sub ? <span className="sub">· {t.sub}</span> : null}{t.badge && <span className={`ph-badge ${t.badge.tone}`}>{t.badge.text}</span>}</span>
              <span className="val">{t.value}</span>
              <span className="parts">{t.parts.map((p) => <span key={p.text} title={p.title || undefined}><b className={p.tone || ''}>{p.text}</b>{p.note ? <small> {p.note}</small> : null}</span>)}</span>
            </a>
          );
        })}
      </nav>
      {/* 400px: 열린 탭의 분해를 탭 아래 한 줄로(탭 3장은 수 + 이름 + 배지만 — platform.css) */}
      {cur && cur.parts.length > 0 && <div className="ph-parts-narrow">{cur.parts.map((p) => <span key={p.text}><b className={p.tone || ''}>{p.text}</b>{p.note ? <small> {p.note}</small> : null}</span>)}</div>}

      {sites.length > 0 && (
        <div className={`vc-quicknav ph-chips${folded ? ' folded' : ''}`} aria-label="바로가기">
          <span className="qn-label">⚡ 바로가기</span>
          {sites.map((s) => {
            const { dot, down } = vcQuickDot(s);
            const c = chipCount(byVc.get(s.id), tab);
            const on = vcenterId === s.id;
            return (
              <button key={s.id} type="button" className={`qn-btn${down ? ' down' : ''}${on ? ' on' : ''}`} aria-pressed={on}
                title={`${s.name} — 허브 범위를 이 법인으로${c.title ? ` · ${c.title}` : ''}${on ? ' (다시 누르면 전체)' : ''}`}
                onClick={() => onPickVcenter(on ? '' : s.id)}>
                <span className="qn-dot" style={{ background: dot }} />{s.id}
                {c.n != null && c.n > 0 && <b className={`qn-n ${c.tone}`}>{c.n.toLocaleString('en-US')}</b>}
              </button>
            );
          })}
          <span className="ph-legend">{chipLegend(tab)}</span>
          <button type="button" className="tab ph-fold" style={{ flex: 'none', padding: '4px 10px', fontSize: 12 }} onClick={toggleFold} aria-expanded={!folded}>{folded ? '바로가기 펴기 ▾' : '접기 ▴'}</button>
        </div>
      )}
    </section>
  );
}
