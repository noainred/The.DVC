import React, { useEffect, useRef, useState } from 'react';
import { usePolling } from '../api.js';
import { Loading, ErrorBox, StateBadge, usageColor, SearchBox } from '../components/ui.jsx';
import VCenterDetail from './VCenterDetail.jsx';

function Bar({ label, pct, detail }) {
  return (
    <div className="vc-metric">
      <div className="vc-mlabel"><span>{label}</span><b>{pct}%{detail ? ` · ${detail}` : ''}</b></div>
      <div className="usage-bar"><span style={{ width: `${Math.min(pct, 100)}%`, background: usageColor(pct) }} /></div>
    </div>
  );
}

export default function VCenters({ onSelectSite, resetSignal }) {
  const { data, error, loading } = usePolling('/vcenters', {}, 15_000);
  const [openId, setOpenId] = useState(null);
  // 빠른 찾기(특수 기능의 '메뉴 빠른 찾기'와 동일 UX) — 훅은 조기 return 위에 선언(React #310).
  const [query, setQuery] = useState('');
  // 상단메뉴 Platform 재클릭(resetSignal 증가) 시 vCenter 상세 드릴다운을 닫고 전체 목록으로 복귀.
  useEffect(() => { setOpenId(null); }, [resetSignal]);
  const cardRefs = useRef({}); // vCenter id → 카드 DOM(바로가기 스크롤/반짝용)
  // 바로가기 버튼 클릭: 해당 카드로 스크롤 이동 + 반짝 하이라이트.
  const gotoCard = (id) => {
    const el = cardRefs.current[id];
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth; // 리플로우로 애니메이션 재시작 보장
    el.classList.add('flash');
    // 제거 타이머는 CSS 애니메이션(vcFlash 3s)보다 살짝 길게 — 먼저 지우면 반짝임이 잘린다.
    setTimeout(() => el.classList.remove('flash'), 3200);
  };
  if (loading && !data) return <Loading />;
  // 데이터 보유 중 일시 폴링 오류로 전체 화면을 갈아치우지 않는다(고RTT 깜빡임 방지).
  if (error && !data) return <ErrorBox message={error} />;

  const sites = data || [];
  const openSite = sites.find((s) => s.id === openId);
  if (openSite) return <VCenterDetail site={openSite} onBack={() => setOpenId(null)} />;
  // 공백 구분 다중 키워드 AND — 이름·id·도시·국가·리전·버전에서 검색(허브 검색과 같은 규칙).
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = keywords.length === 0 ? sites : sites.filter((s) => {
    const hay = [s.name, s.id, s.location?.city, s.location?.country, s.location?.region, s.version]
      .filter(Boolean).join(' ').toLowerCase();
    return keywords.every((kw) => hay.includes(kw));
  });
  const connected = sites.filter((s) => s.status === 'connected').length;
  const totalHosts = sites.reduce((a, s) => a + (s.metrics?.hosts || 0), 0);
  const totalVms = sites.reduce((a, s) => a + (s.metrics?.vms || 0), 0);
  const totalAlarms = sites.reduce((a, s) => a + (s.metrics?.alarmsCritical || 0) + (s.metrics?.alarmsWarning || 0), 0);

  return (
    <>
      {error && <div className="card" style={{ marginBottom: 8, padding: '8px 12px', color: 'var(--red)', fontSize: 12 }}>일시적 갱신 오류: {String(error.message || error)} — 직전 데이터를 표시 중입니다.</div>}
      <div className="kpis" style={{ marginBottom: 18 }}>
        <div className="card kpi"><div className="label">전체 vCenter</div><div className="value">{sites.length}</div><div className="meta">연결됨 {connected} · 불가 {sites.length - connected}</div></div>
        <div className="card kpi"><div className="label">전체 호스트</div><div className="value">{totalHosts.toLocaleString()}</div></div>
        <div className="card kpi"><div className="label">전체 VM</div><div className="value">{totalVms.toLocaleString()}</div></div>
        <div className="card kpi"><div className="label">활성 알람</div><div className="value" style={{ color: totalAlarms ? 'var(--amber)' : undefined }}>{totalAlarms}</div></div>
      </div>

      {sites.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <SearchBox className="input" style={{ maxWidth: 280 }} value={query} onChange={setQuery}
            placeholder="vCenter 빠른 찾기 (예: eu, seoul, 8.0)" />
        </div>
      )}

      {shown.length > 0 && (
        <div className="vc-quicknav">
          <span className="qn-label">⚡ 바로가기</span>
          {shown.map((s) => {
            const m = s.metrics || {};
            const down = s.status !== 'connected';
            const alarms = (m.alarmsCritical || 0) + (m.alarmsWarning || 0);
            const dot = down ? 'var(--red)' : alarms ? 'var(--amber)' : 'var(--green)';
            return (
              <button key={s.id} className={`qn-btn${down ? ' down' : ''}`} title={`${s.name} 카드로 이동`} onClick={() => gotoCard(s.id)}>
                <span className="qn-dot" style={{ background: dot }} />{s.id}
              </button>
            );
          })}
        </div>
      )}

      {keywords.length > 0 && shown.length === 0 && (
        <div className="card" style={{ padding: '18px 16px', color: 'var(--text-dim)' }}>
          "{query}" 와 일치하는 vCenter가 없습니다 — 이름·id·도시·국가·리전·버전에서 검색합니다.
        </div>
      )}

      <div className="vc-grid">
        {shown.map((s) => {
          const m = s.metrics || {};
          const down = s.status !== 'connected';
          return (
            <div className="card vc-card" key={s.id} ref={(el) => { cardRefs.current[s.id] = el; }} onClick={() => setOpenId(s.id)}>
              <div className="vc-head">
                <div>
                  <div className="vc-name">{s.name}</div>
                  <div className="vc-loc">📍 {s.location?.city}, {s.location?.country} · {s.location?.region}</div>
                </div>
                <StateBadge state={s.status} />
              </div>

              {down ? (
                <div style={{ padding: '12px 0' }}>
                  <div className="muted" style={{ marginBottom: 6 }}>이 vCenter에 연결할 수 없습니다.</div>
                  {s.error && <div className="diag-err-msg" style={{ fontSize: 12 }}>{s.error}</div>}
                  {s.hint && <div className="diag-err-hint" style={{ fontSize: 12 }}>💡 {s.hint}</div>}
                </div>
              ) : (
                <>
                  <div className="vc-counts">
                    <div className="vc-count"><b>{m.hosts}</b><span>호스트</span></div>
                    <div className="vc-count"><b>{m.vms}</b><span>VM ({m.vmsPoweredOn} on)</span></div>
                    <div className="vc-count"><b style={{ color: m.alarmsCritical ? 'var(--red)' : m.alarmsWarning ? 'var(--amber)' : 'var(--green)' }}>{(m.alarmsCritical || 0) + (m.alarmsWarning || 0)}</b><span>알람</span></div>
                  </div>
                  <Bar label="CPU" pct={m.cpuUsagePct || 0} />
                  <Bar label="메모리" pct={m.memUsagePct || 0} />
                  <Bar label="스토리지" pct={m.storageUsagePct || 0} detail={`${m.storageTotalTB || 0} TB`} />
                </>
              )}

              <div className="vc-foot">
                <span className="muted">v{s.version || '—'}{s.build ? ` · build ${s.build}` : ''}</span>
                <span className="muted">{s.id} →</span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
