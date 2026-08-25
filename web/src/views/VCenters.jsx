import React, { useEffect, useRef, useState } from 'react';
import { usePolling, fetchJson } from '../api.js';
import { growth, hasDsData, tb, gbTb } from './tools/storageTrack.js'; // 추이 KPI(v2.358) 계산 재사용
import { Loading, ErrorBox, StateBadge, usageColor, SearchBox } from '../components/ui.jsx';
import VCenterDetail from './VCenterDetail.jsx';

/** 미니 스파크라인(v2.358) — recharts 를 끌어오지 않는 순수 SVG(Platform 은 차트 벤더 청크 미로드). */
function Spark({ points, color }) {
  const vals = (points || []).filter((v) => v != null && Number.isFinite(Number(v)));
  if (vals.length < 2) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const W = 130;
  const H = 28;
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * W).toFixed(1)},${(H - ((v - min) / span) * (H - 4) - 2).toFixed(1)}`).join(' ');
  return (
    <svg width={W} height={H} style={{ display: 'block', marginTop: 6, opacity: 0.9 }} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

/**
 * Platform 상단 추이 KPI 2장(v2.358, 사용자 요구) — VM 수·스토리지 사용량의 30일 증가 추이.
 * 데이터는 vm-track 의 00/12시 스냅샷(GET /tools/vm-track, scope 서버 강제)을 5분 주기로 읽는다.
 * tools 권한이 없거나 추적 DB 불가면 카드 자체를 숨긴다(대시보드 소음 방지). 클릭 → 해당 추이 화면.
 */
function TrendKpis() {
  const [d, setD] = useState(null);
  const [dead, setDead] = useState(false);
  useEffect(() => {
    let on = true;
    const load = () => fetchJson('/tools/vm-track', { days: 30 })
      .then((r) => { if (on) { setD(r); setDead(false); } })
      .catch(() => { if (on) setDead(true); });
    load();
    const t = setInterval(load, 300_000);
    return () => { on = false; clearInterval(t); };
  }, []);
  if (dead || !d) return null;
  const pts = d.points || [];
  const vmFirst = pts[0] || null;
  const vmLast = pts[pts.length - 1] || null;
  const vmNet = vmFirst && vmLast ? vmLast.total - vmFirst.total : 0;
  const sumAdded = pts.reduce((a, p) => a + (p.added || 0), 0);
  const sumRemoved = pts.reduce((a, p) => a + (p.removed || 0), 0);
  const g = growth(pts); // 스토리지 순증감 — 구버전(ds 열 0) 행은 내부에서 기준 제외(v2.351 원칙)
  const dsLast = [...pts].reverse().find(hasDsData) || null;
  const go = (h) => { window.location.hash = h; };
  return (
    <>
      <div className="card kpi" onClick={() => go('#/tools/vm-track')} style={{ cursor: 'pointer' }} title="클릭 — VM 수량 추이 화면">
        <div className="label">VM 증가 추이(30일)</div>
        <div className="value" style={{ color: vmNet > 0 ? 'var(--green)' : vmNet < 0 ? 'var(--red)' : undefined }}>
          {vmLast ? `${vmNet > 0 ? '+' : ''}${vmNet.toLocaleString()}` : '—'}
        </div>
        <div className="meta">{vmLast ? `생성 +${sumAdded.toLocaleString()} · 삭제 −${sumRemoved.toLocaleString()}` : '스냅샷 없음(매일 00·12시 자동)'}</div>
        <Spark points={pts.map((p) => p.total)} color="#60a5fa" />
      </div>
      <div className="card kpi" onClick={() => go('#/tools/storage-track')} style={{ cursor: 'pointer' }} title="클릭 — 스토리지 사용량 추이 화면">
        <div className="label">스토리지 증가 추이(30일)</div>
        <div className="value" style={{ color: g.netGB > 0 ? 'var(--amber)' : g.netGB < 0 ? 'var(--green)' : undefined }}>
          {dsLast ? `${g.netGB > 0 ? '+' : ''}${gbTb(g.netGB)}` : '—'}
        </div>
        <div className="meta">{dsLast ? `사용 ${tb(dsLast.dsUsedGB).toLocaleString()} / ${tb(dsLast.dsCapGB).toLocaleString()} TB (${Math.round(dsLast.dsUsagePct || 0)}%)` : '관측 전(다음 00·12시부터)'}</div>
        <Spark points={pts.map((p) => (hasDsData(p) ? p.dsUsedGB : null))} color="#f59e0b" />
      </div>
    </>
  );
}

/* 메모리 사용/전체 병기 — 1TB 이상이면 TB로, 아니면 GB로(자릿수 폭주 방지). 값 없으면 미표기. */
function fmtMem(usedGB, totalGB) {
  if (usedGB == null || !totalGB) return undefined;
  if (totalGB >= 1024) return `${(usedGB / 1024).toFixed(1)}/${(totalGB / 1024).toFixed(1)} TB`;
  return `${usedGB}/${totalGB} GB`;
}

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
  // 다빈치/IRS 분류(사용자 요구): vCenter 이름에 'IRS'(단어, 대소문자 무시 — 예: AZ-IRS·GM1-IRS)가
  // 들어가면 IRS, 나머지(AZ·GM1 등)는 다빈치. 하이픈은 단어 경계라 '-IRS' 접미가 매칭된다.
  // VM(v2.323)·호스트(v2.324) 두 KPI 가 같은 규칙을 쓰므로 지표별 합산 헬퍼로 공용화.
  const isIrs = (s) => /\birs\b/i.test(s.name || '');
  const irsSum = (metric) => sites.reduce((a, s) => a + (isIrs(s) ? (s.metrics?.[metric] || 0) : 0), 0);
  const irsVms = irsSum('vms');
  const davinciVms = totalVms - irsVms;
  const irsHosts = irsSum('hosts');
  const davinciHosts = totalHosts - irsHosts;
  const totalAlarms = sites.reduce((a, s) => a + (s.metrics?.alarmsCritical || 0) + (s.metrics?.alarmsWarning || 0), 0);

  return (
    <>
      {error && <div className="card" style={{ marginBottom: 8, padding: '8px 12px', color: 'var(--red)', fontSize: 12 }}>일시적 갱신 오류: {String(error.message || error)} — 직전 데이터를 표시 중입니다.</div>}
      <div className="kpis" style={{ marginBottom: 18 }}>
        <div className="card kpi"><div className="label">전체 vCenter</div><div className="value">{sites.length}</div><div className="meta">연결됨 {connected} · 불가 {sites.length - connected}</div></div>
        <div className="card kpi"><div className="label">전체 호스트</div><div className="value">{totalHosts.toLocaleString()}</div><div className="meta">다빈치 {davinciHosts.toLocaleString()}개 · IRS {irsHosts.toLocaleString()}개</div></div>
        <div className="card kpi"><div className="label">전체 VM</div><div className="value">{totalVms.toLocaleString()}</div><div className="meta">다빈치 {davinciVms.toLocaleString()}개 · IRS {irsVms.toLocaleString()}개</div></div>
        <div className="card kpi"><div className="label">활성 알람</div><div className="value" style={{ color: totalAlarms ? 'var(--amber)' : undefined }}>{totalAlarms}</div></div>
        <TrendKpis />
      </div>

      {sites.length > 0 && (
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
          {/* 빠른 찾기 — 바로가기 박스 우측에 배치. 무결과여도 박스가 남아야 입력을 지울 수 있다. */}
          <SearchBox className="input" style={{ marginLeft: 'auto', maxWidth: 240, minWidth: 170 }}
            value={query} onChange={setQuery} placeholder="vCenter 빠른 찾기" />
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
                  <Bar label="CPU" pct={m.cpuUsagePct || 0} detail={m.cpuTotalGhz ? `${m.cpuUsedGhz}/${m.cpuTotalGhz} GHz` : undefined} />
                  <Bar label="메모리" pct={m.memUsagePct || 0} detail={fmtMem(m.memUsedGB, m.memTotalGB)} />
                  <Bar label="스토리지" pct={m.storageUsagePct || 0} detail={m.storageUsedTB != null ? `${m.storageUsedTB}/${m.storageTotalTB} TB` : `${m.storageTotalTB || 0} TB`} />
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
