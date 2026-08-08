import React, { useState } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts';
import { usePolling } from '../api.js';
import { Loading, ErrorBox, Kpi, usageColor } from '../components/ui.jsx';

/**
 * 리소스 적정성 진단(Capacity Advisor) — 포탈이 도는 서버(중앙 + 엣지 에이전트)의
 * CPU/메모리/네트워크/디스크/이벤트루프를 상시 실측한 시계열로, 1일/1주/1달 창별 상태를 보고
 * 증설/감축을 실측 근거(p50/p95/max·표본 수)와 함께 권고한다.
 *
 * 모든 훅은 최상단(조기 return 위) — React #310 회귀 방지. 판정·권고는 전부 서버
 * (capacity/evaluate.js)가 내리고 화면은 렌더만 한다(임계값을 화면에 복사하지 않는다).
 */

const WINDOW_TABS = [
  { key: 'day', label: '1일' },
  { key: 'week', label: '1주' },
  { key: 'month', label: '1달' },
];

const LEVEL_BADGE = {
  scale_up: { cls: 'red', label: '증설 필요' },
  watch: { cls: 'amber', label: '경계' },
  ok: { cls: 'green', label: '적정' },
  scale_down: { cls: 'blue', label: '감축 검토' },
  measuring: { cls: 'gray', label: '측정 중' },
  info: { cls: 'gray', label: '정보' },
};

const GROUP_LABEL = { cpu: 'CPU', memory: '메모리', network: '네트워크', disk: '디스크', runtime: '런타임' };

const tipStyle = { background: '#0b1220', border: '1px solid #1e293b', borderRadius: 8, fontSize: 12 };

function fmtVal(v, unit) {
  if (v == null) return '—';
  if (unit === 'pct') return `${Number(v).toFixed(1)}%`;
  if (unit === 'ms') return `${Number(v).toFixed(0)}ms`;
  if (unit === 'mb') return v >= 1024 ? `${(v / 1024).toFixed(1)}GB` : `${Number(v).toFixed(0)}MB`;
  if (unit === 'ratio') return Number(v).toFixed(2);
  if (unit === 'bps') {
    if (v >= 1e9) return `${(v / 1e9).toFixed(2)}Gbps`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}Mbps`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(0)}Kbps`;
    return `${Number(v).toFixed(0)}bps`;
  }
  return String(v);
}

const fmtAgo = (ts) => {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return `${s}초 전`;
  if (s < 5400) return `${Math.round(s / 60)}분 전`;
  return `${Math.round(s / 3600)}시간 전`;
};

export default function CapacityAdvisor() {
  const [hostKey, setHostKey] = useState('local');
  const [win, setWin] = useState('day');
  const [chartMetric, setChartMetric] = useState('cpu_system');

  const { data: summary, error: sumErr } = usePolling('/capacity/summary', {}, 30_000);
  const { data: host, error: hostErr } = usePolling('/capacity/host', { k: hostKey }, 30_000);
  const { data: hist } = usePolling('/capacity/history', { k: hostKey, metric: chartMetric, window: win }, 60_000);

  if (sumErr && !summary) return <ErrorBox message={sumErr} />;
  if (!summary) return <Loading />;

  const hosts = summary.hosts || [];
  const cur = hosts.find((h) => h.k === hostKey) || null;
  const winData = host?.windows?.[win];
  const chartMeta = (summary.collectors || []).find((c) => c.key === chartMetric);
  const points = (hist?.points || []).map((p) => ({ ...p, t: new Date(p.ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) }));

  return (
    <div className="flex col gap">
      {(sumErr || hostErr) && (
        <div className="badge red" style={{ alignSelf: 'flex-start' }}>갱신 실패(직전 데이터 표시 중) — {sumErr || hostErr}</div>
      )}

      {/* 호스트 선택 — 중앙(local) + 보고 중인 엣지 */}
      <div className="card" style={{ padding: 12 }}>
        <div className="flex between wrap gap" style={{ alignItems: 'center' }}>
          <div className="flex wrap gap">
            {hosts.length === 0 && <span className="muted">아직 보고된 호스트가 없습니다 — 샘플러가 첫 측정을 수집 중입니다.</span>}
            {hosts.map((h) => {
              const worst = ['scale_up', 'watch', 'scale_down'].find((lv) => Object.values(h.groups || {}).includes(lv));
              const b = worst ? LEVEL_BADGE[worst] : LEVEL_BADGE.ok;
              return (
                <button key={h.k} className={`tab${hostKey === h.k ? ' active' : ''}`} onClick={() => setHostKey(h.k)}>
                  {h.k === 'local' ? '🏠 중앙(이 서버)' : `🛰️ ${h.k}`}
                  {' '}<span className={`badge ${h.fresh ? b.cls : 'gray'}`} style={{ fontSize: 10 }}>
                    {h.fresh ? b.label : `무보고 ${fmtAgo(h.lastTs)}`}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex gap">
            {WINDOW_TABS.map((w) => (
              <button key={w.key} className={`tab${win === w.key ? ' active' : ''}`} onClick={() => setWin(w.key)}>{w.label}</button>
            ))}
          </div>
        </div>
        {cur?.meta && (
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            {cur.meta.hostname} · {cur.meta.platform} · CPU {cur.meta.cores}코어 · 메모리 {cur.meta.totalMemMB ? `${Math.round(cur.meta.totalMemMB / 1024)}GB` : '—'}
            {' '}· Node {cur.meta.nodeVersion} · 역할 {cur.meta.role || '—'} · 마지막 보고 {fmtAgo(cur.lastTs)}
            {cur.meta.platform && cur.meta.platform !== 'linux' && (
              <span className="badge amber" style={{ marginLeft: 8, fontSize: 10 }}>네트워크 처리량은 리눅스에서만 측정</span>
            )}
          </div>
        )}
      </div>

      {!host && !hostErr && <Loading />}

      {/* 권고 — 서버가 실측 근거와 함께 내린 문장 그대로 */}
      {host?.advice?.length > 0 && (
        <div className="card" style={{ padding: 14 }}>
          <div className="section-title" style={{ marginBottom: 8 }}>인프라 확장/감축 조언 <span className="muted" style={{ fontSize: 11 }}>(1달 창 기준 · 급성 악화는 1일 창 우선)</span></div>
          <div className="flex col" style={{ gap: 6 }}>
            {host.advice.map((a, i) => {
              const b = LEVEL_BADGE[a.level] || LEVEL_BADGE.info;
              return (
                <div key={i} className="flex gap" style={{ alignItems: 'flex-start' }}>
                  <span className={`badge ${b.cls}`} style={{ flex: 'none', marginTop: 1 }}>{b.label}</span>
                  <span style={{ fontSize: 13 }}>{a.text}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 지표 카드 — 선택한 창의 p95 게이지 + 판정 */}
      {winData && (
        <>
          <div className="kpis" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
            {Object.entries(winData.metrics).map(([key, m]) => {
              const b = LEVEL_BADGE[m.verdict] || LEVEL_BADGE.info;
              const isPct = m.unit === 'pct';
              return (
                <div key={key} className={`card kpi${chartMetric === key ? ' kpi-click' : ''}`}
                  onClick={() => setChartMetric(key)} role="button" tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') setChartMetric(key); }}
                  style={{ cursor: 'pointer', outline: chartMetric === key ? '1px solid var(--accent)' : 'none' }}
                  title="클릭하면 아래 추세 차트가 이 지표로 바뀝니다">
                  <div className="label">{m.label} <span className={`badge ${b.cls}`} style={{ fontSize: 10 }}>{b.label}</span></div>
                  <div className="value">{m.stats ? fmtVal(m.stats.p95, m.unit) : '—'}<small> p95</small></div>
                  {isPct && m.stats && (
                    <div className="usage-bar"><span style={{ width: `${Math.min(m.stats.p95 || 0, 100)}%`, background: usageColor(m.stats.p95 || 0) }} /></div>
                  )}
                  <div className="meta">
                    {m.stats
                      ? <>평균 {fmtVal(m.stats.avg, m.unit)} · 최대 {fmtVal(m.stats.max, m.unit)} · 표본 {m.stats.n.toLocaleString()}{m.stats.approx ? ' · 롤업 근사' : ''}</>
                      : '데이터 없음 — 측정 중'}
                  </div>
                </div>
              );
            })}
          </div>

          {/* 추세 차트 — 클릭한 지표 × 선택한 창 */}
          <div className="card" style={{ padding: 14 }}>
            <div className="section-title" style={{ marginBottom: 4 }}>
              {chartMeta?.label || chartMetric} 추이 <span className="muted" style={{ fontSize: 11 }}>({WINDOW_TABS.find((w) => w.key === win)?.label} 창)</span>
            </div>
            {points.length === 0 ? (
              <div className="muted center" style={{ padding: 24 }}>이 창에 표시할 데이터가 아직 없습니다.</div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="capFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                  <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#94a3b8' }} minTickGap={40} />
                  <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} width={54}
                    domain={chartMeta?.unit === 'pct' ? [0, 100] : ['auto', 'auto']}
                    tickFormatter={(v) => fmtVal(v, chartMeta?.unit || 'pct')} />
                  <Tooltip contentStyle={tipStyle} formatter={(v, name) => [fmtVal(v, chartMeta?.unit || 'pct'), name === 'avg' ? '평균' : name === 'max' ? '최대' : name]} />
                  {chartMeta?.warn != null && <ReferenceLine y={chartMeta.warn} stroke="var(--amber)" strokeDasharray="4 4" label={{ value: '경고', fontSize: 10, fill: 'var(--amber)', position: 'insideTopRight' }} />}
                  {chartMeta?.bad != null && <ReferenceLine y={chartMeta.bad} stroke="var(--red)" strokeDasharray="4 4" label={{ value: '위험', fontSize: 10, fill: 'var(--red)', position: 'insideTopRight' }} />}
                  <Area type="monotone" dataKey="max" stroke="#475569" fill="none" strokeWidth={1} name="max" />
                  <Area type="monotone" dataKey="avg" stroke="var(--accent)" fill="url(#capFill)" strokeWidth={2} name="avg" />
                </AreaChart>
              </ResponsiveContainer>
            )}
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              실선 = 구간 평균 · 회색 = 구간 최대. 점선은 경고/위험 임계값{win !== 'day' ? ' · 1주/1달 창은 시간당 롤업 집계' : ''}.
            </div>
          </div>
        </>
      )}

      {/* 측정 방식 설명 — 판정을 신뢰할 수 있게 근거를 공개 */}
      <div className="card" style={{ padding: 12 }}>
        <div className="muted" style={{ fontSize: 12 }}>
          <b>측정 방식</b> — 운영 중인 포탈 프로세스 안에서 {Math.round((summary.sampler?.intervalMs || 30000) / 1000)}초마다
          자기 호스트를 실측합니다(별도 벤치마크 없음). 원본은 {summary.sampler ? '72시간' : ''} 보존하고 시간당
          롤업으로 1달 이상을 봅니다. 판정: <b>증설 필요</b> = 창의 p95 ≥ 위험 임계 · <b>경계</b> = p95 ≥ 경고 임계 ·
          <b> 감축 검토</b> = 1달 피크(max)조차 경고 임계의 절반 미만(짧은 창의 한가함으로는 감축을 권하지 않습니다) ·
          표본이 부족하면 판정하지 않고 <b>측정 중</b>으로 표시합니다. 엣지 에이전트는 자기 리소스를 1분마다 중앙으로
          보고합니다(개별 토큰 인증).
        </div>
      </div>
    </div>
  );
}
