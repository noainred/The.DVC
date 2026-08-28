// RoomTemp.jsx — 특수 기능 '법인 전산실 운영 온도'(v2.381).
// 모든 법인의 흡기(inlet)·배기(exhaust)·CPU 온도 범위를 카드로 한 페이지에 종합한다.
import React from 'react';
import { usePolling } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { Card } from './shared.jsx';

const C = (v) => (v == null ? '—' : `${v}℃`);

/**
 * 상태 색 — ASHRAE A1 권장 급기 18~27℃ 기준. 흡기(inlet)에만 의미가 있어 카드 테두리·배지에만 쓴다.
 * (배기·CPU 는 장비/부하에 따라 정상 범위가 크게 달라 임계를 임의로 정하지 않는다 — 값만 보여준다.)
 */
const STATUS = {
  cold: { label: '과냉', color: '#60a5fa', desc: '15℃ 미만 — 냉방 과다(에너지 낭비)' },
  lowok: { label: '낮음', color: '#38bdf8', desc: '권장 하단(18℃) 근접' },
  ok: { label: '정상', color: '#4ade80', desc: 'ASHRAE A1 권장 18~27℃' },
  warn: { label: '주의', color: '#fbbf24', desc: '27℃ 초과 — 개선 필요' },
  hot: { label: '위험', color: '#f87171', desc: '32℃ 초과 — 즉시 조치' },
};

/** 온도 범위 바 — min~max 를 18~40℃ 스케일 위에 그려 법인 간 비교가 눈으로 되게 한다. */
function RangeBar({ min, max, avg, color = '#4ade80', lo = 10, hi = 45 }) {
  if (min == null || max == null) return <div className="muted" style={{ fontSize: 11.5 }}>데이터 없음</div>;
  const pct = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  const left = pct(min);
  const width = Math.max(1.5, pct(max) - left);   // 최소 폭 — min==max 여도 보이게
  return (
    <div style={{ position: 'relative', height: 8, background: 'rgba(148,163,184,.15)', borderRadius: 4, margin: '4px 0 2px' }}
      title={`최저 ${min}℃ · 평균 ${avg ?? '—'}℃ · 최고 ${max}℃`}>
      {/* 권장 대역(18~27℃) 참조 — 흡기 비교의 기준선 */}
      <div style={{ position: 'absolute', left: `${pct(18)}%`, width: `${pct(27) - pct(18)}%`, top: 0, bottom: 0, background: 'rgba(74,222,128,.12)', borderLeft: '1px dashed rgba(74,222,128,.4)', borderRight: '1px dashed rgba(74,222,128,.4)' }} />
      <div style={{ position: 'absolute', left: `${left}%`, width: `${width}%`, top: 0, bottom: 0, background: color, borderRadius: 4 }} />
      {avg != null && <div style={{ position: 'absolute', left: `${pct(avg)}%`, top: -2, bottom: -2, width: 2, background: '#fff', opacity: 0.85 }} />}
    </div>
  );
}

/** 한 종류(흡기/배기/CPU)의 범위 표시 블록. */
function Metric({ label, agg, color, unitNote }) {
  return (
    <div style={{ flex: 1, minWidth: 150 }}>
      <div className="flex between" style={{ alignItems: 'baseline' }}>
        <span className="muted" style={{ fontSize: 11.5 }}>{label}</span>
        <span style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
          {agg?.min == null ? <span className="muted">—</span> : <>
            <b style={{ color }}>{C(agg.min)}</b>
            <span className="muted"> ~ </span>
            <b style={{ color }}>{C(agg.max)}</b>
          </>}
        </span>
      </div>
      <RangeBar min={agg?.min} max={agg?.max} avg={agg?.avg} color={color} />
      <div className="muted" style={{ fontSize: 11 }}>
        {agg?.min == null ? (unitNote || '센서 없음')
          : <>평균 {C(agg.avg)} · 폭 {agg.range}℃ · {agg.servers}대</>}
      </div>
    </div>
  );
}

/** 법인 카드 — 흡기·배기·CPU 3종 범위 + 상태 + 서버 수. */
function DcCard({ dc, expanded, onToggle }) {
  const st = dc.status ? STATUS[dc.status] : null;
  return (
    <div className="card" style={{ padding: 14, borderColor: st ? `${st.color}55` : undefined }}>
      <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 8, gap: 8 }}>
        <div className="flex gap" style={{ alignItems: 'center', gap: 8 }}>
          <b style={{ fontSize: 14 }}>🏢 {dc.name}</b>
          {st && <span className="badge" style={{ background: `${st.color}22`, color: st.color }} title={st.desc}>{st.label}</span>}
        </div>
        <span className="muted" style={{ fontSize: 11.5 }}>
          서버 {dc.serverCount}대
          {dc.inlet.servers ? ` · 측정 ${dc.inlet.servers}` : ''}
          {dc.staleCount ? ` · 미갱신 ${dc.staleCount}` : ''}
          {dc.noSensorCount ? ` · 센서없음 ${dc.noSensorCount}` : ''}
        </span>
      </div>

      <div className="flex gap wrap" style={{ gap: 14 }}>
        <Metric label="흡기(Inlet)" agg={dc.inlet} color="#60a5fa" unitNote="흡기 센서 없음" />
        <Metric label="배기(Exhaust)" agg={dc.exhaust} color="#fb923c" unitNote="배기 센서 없음" />
        <Metric label="CPU" agg={dc.cpu} color="#f87171" unitNote="CPU 센서 없음" />
      </div>

      <div className="flex between wrap" style={{ alignItems: 'center', marginTop: 8, gap: 8 }}>
        <span className="muted" style={{ fontSize: 11.5 }}>
          {dc.deltaAvg != null ? <>배기−흡기 평균 <b style={{ color: 'var(--text)' }}>{dc.deltaAvg}℃</b>{dc.deltaAvg >= 20 ? ' (풍량·부하 점검 권장)' : ''}</> : '흡기·배기 쌍이 있는 서버가 없어 ΔT 미산출'}
        </span>
        {dc.servers.length > 0 && (
          <button className="tab" style={{ padding: '4px 10px', fontSize: 11.5 }} onClick={() => onToggle(dc.id)}>
            {expanded ? '서버 접기' : `서버별 보기 (${dc.servers.length})`}
          </button>
        )}
      </div>

      {expanded && dc.servers.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 8, maxHeight: 260 }}>
          <table>
            <thead><tr>
              <th>서버</th><th style={{ textAlign: 'right' }}>흡기</th><th style={{ textAlign: 'right' }}>배기</th>
              <th style={{ textAlign: 'right' }}>CPU</th><th style={{ textAlign: 'right' }}>ΔT</th>
            </tr></thead>
            <tbody>
              {dc.servers.map((s) => (
                <tr key={s.id}>
                  <td><b style={{ fontSize: 12.5 }}>{s.name}</b><div className="muted" style={{ fontSize: 11 }}>{s.host}{s.vcenterId ? ` · ${s.vcenterId}` : ''}</div></td>
                  <td style={{ textAlign: 'right', color: s.inlet != null && s.inlet > 27 ? 'var(--amber)' : undefined }}>{C(s.inlet)}</td>
                  <td style={{ textAlign: 'right' }}>{C(s.exhaust)}</td>
                  <td style={{ textAlign: 'right' }}>{C(s.cpu)}</td>
                  <td style={{ textAlign: 'right' }} className="muted">{s.deltaT == null ? '—' : `${s.deltaT}℃`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * 법인 전산실 운영 온도 — 모든 법인의 흡기·배기·CPU 온도 범위를 카드로 종합(1페이지).
 * 데이터는 iDRAC Redfish Thermal 을 폴러가 수집한 값(추가 조회 없음)이며, 15분 이상 갱신되지
 * 않은 서버는 집계에서 제외하고 그 수를 카드에 표기한다(죽은 서버의 마지막 온도를 현재로
 * 보여주지 않기 위함).
 */
export function RoomTemp() {
  // ⚠ 훅은 조기 return 위에서 전부 선언(CLAUDE.md — React #310 방지).
  const { data, error } = usePolling('/admin/room-temp', {}, 30_000);
  const [open, setOpen] = React.useState({});
  const toggle = (id) => setOpen((c) => ({ ...c, [id]: !c[id] }));

  // 폴링 오류 1회로 화면을 갈아치우지 않는다(데이터 없을 때만 전체 오류 — CLAUDE.md).
  if (error && !data) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  const t = data.totals || {};
  const dcs = data.datacenters || [];

  return (
    <>
      {error && <div className="badge amber" style={{ marginBottom: 10, display: 'inline-block' }}>업데이트 실패(이전 데이터 표시 중)</div>}

      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="법인" value={t.datacenters ?? 0} meta={`측정 서버 ${t.withData ?? 0} / ${t.servers ?? 0}대`} />
        <Card label="흡기 범위(전체)" value={t.inlet?.min == null ? '—' : `${t.inlet.min}~${t.inlet.max}℃`}
          meta={t.inlet?.avg != null ? `평균 ${t.inlet.avg}℃` : '흡기 센서 없음'}
          accent={t.inlet?.max != null && t.inlet.max > 27 ? 'var(--amber)' : 'var(--green)'} />
        <Card label="배기 범위(전체)" value={t.exhaust?.min == null ? '—' : `${t.exhaust.min}~${t.exhaust.max}℃`}
          meta={t.exhaust?.avg != null ? `평균 ${t.exhaust.avg}℃` : '배기 센서 없음'} />
        <Card label="CPU 범위(전체)" value={t.cpu?.min == null ? '—' : `${t.cpu.min}~${t.cpu.max}℃`}
          meta={t.cpu?.avg != null ? `평균 ${t.cpu.avg}℃` : 'CPU 센서 없음'} />
        {t.stale ? <Card label="미갱신 서버" value={t.stale} meta={`${Math.round((data.staleMs || 0) / 60000)}분 이상 무응답 — 집계 제외`} accent="var(--amber)" /> : null}
      </div>

      <div className="muted" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.7 }}>
        범위 바의 연한 초록 구간은 <b>ASHRAE A1 권장 급기 18~27℃</b>이고, 흰 세로선은 평균입니다. 상태 배지는 <b>흡기 최고값</b>으로 보수적으로 판정합니다.
        배기·CPU 는 장비·부하에 따라 정상 범위가 달라 임계를 정하지 않고 값만 표시합니다.
      </div>

      {dcs.length === 0 ? (
        <div className="card" style={{ padding: 24, textAlign: 'center' }}>
          <div className="muted" style={{ fontSize: 13, lineHeight: 1.8 }}>
            표시할 데이터가 없습니다.<br />
            iDRAC 서버가 등록되어 있고 <b>온도 수집이 1회 이상 완료</b>되어야 표시됩니다(수집 주기 뒤 자동 표시).
          </div>
        </div>
      ) : (
        <div className="grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 12 }}>
          {dcs.map((dc) => <DcCard key={dc.id || '_none'} dc={dc} expanded={!!open[dc.id]} onToggle={toggle} />)}
        </div>
      )}

      <div className="muted" style={{ fontSize: 11.5, marginTop: 12, lineHeight: 1.7 }}>
        · 센서 분류는 이름 기준입니다 — 흡기(Inlet/Intake/Ambient) · 배기(Exhaust/Outlet/Exit) · CPU(CPU/Proc/Package/Die).
        그 외 센서(메모리·PSU·보드 등)는 성격이 달라 집계에서 제외합니다.<br />
        · 한 서버에 같은 종류 센서가 여러 개면(CPU1·CPU2 등) <b>가장 높은 값</b>을 그 서버의 대표값으로 씁니다.<br />
        · 법인 귀속이 지정되지 않은 서버는 <b>(미지정)</b> 카드로 따로 묶습니다 — 임의로 배정하지 않습니다.
      </div>
    </>
  );
}
