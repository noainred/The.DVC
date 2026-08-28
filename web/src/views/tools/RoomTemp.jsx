// RoomTemp.jsx — 특수 기능 '법인 전산실 운영 온도'(v2.381).
// 모든 법인의 흡기(inlet)·배기(exhaust)·CPU 온도 범위를 카드로 한 페이지에 종합한다.
import React from 'react';
import { fetchJson, usePolling } from '../../api.js';
import { Loading, ErrorBox, Modal } from '../../components/ui.jsx';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
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


/** 정렬 옵션(v2.384) — 알파벳(법인명) · 흡기/배기/CPU 높은순·낮은순. */
const SORTS = [
  ['name-asc', '법인명 A→Z'],
  ['name-desc', '법인명 Z→A'],
  ['inlet-desc', '흡기 높은순'],
  ['inlet-asc', '흡기 낮은순'],
  ['exhaust-desc', '배기 높은순'],
  ['exhaust-asc', '배기 낮은순'],
  ['cpu-desc', 'CPU 높은순'],
  ['cpu-asc', 'CPU 낮은순'],
];
/**
 * 정렬 적용 — 온도 정렬은 그 종류의 **최고값** 기준이고, 값이 없는 법인(null)은 방향과
 * 무관하게 항상 뒤로 보낸다(데이터 없는 카드가 위로 올라와 실제 현황을 가리지 않게).
 */
function sortGroups(groups, sort) {
  const [key, dir] = String(sort || 'inlet-desc').split('-');
  const sign = dir === 'asc' ? 1 : -1;
  const arr = [...(groups || [])];
  if (key === 'name') return arr.sort((a, b) => String(a.name).localeCompare(String(b.name)) * sign);
  return arr.sort((a, b) => {
    const x = a[key]?.max; const y = b[key]?.max;
    if (x == null && y == null) return String(a.name).localeCompare(String(b.name));
    if (x == null) return 1;
    if (y == null) return -1;
    return (x - y) * sign || String(a.name).localeCompare(String(b.name));
  });
}

/**
 * 버킷 크기 표기(v2.387) — 이전 인라인 식은 30분 버킷에서 Math.round(0.5)=1 이 truthy 가 되어
 * "집계 단위 1 평균"(단위 없음)으로 표시됐다. 일→시간→분 순으로 분기한다.
 */
function fmtBucket(ms) {
  const n = Number(ms) || 0;
  if (n >= 86_400_000) return `${Math.round(n / 86_400_000)}일`;
  if (n >= 3_600_000) return `${Math.round(n / 3_600_000)}시간`;
  return `${Math.max(1, Math.round(n / 60_000))}분`;
}

const TREND_RANGES = [['1d', '최근 1일'], ['7d', '1주'], ['30d', '1달'], ['90d', '3개월'], ['180d', '6개월'], ['365d', '1년']];
const KIND_LABEL = { inlet: '흡기(Inlet)', exhaust: '배기(Exhaust)', cpu: 'CPU' };
const KIND_COLOR = { inlet: '#60a5fa', exhaust: '#fb923c', cpu: '#f87171' };

/**
 * 온도 추이 모달(v2.384) — 흡기/배기/CPU 라벨을 누르면 열린다.
 * 평균(실선)과 최고(점선)를 함께 그려 '평균은 괜찮은데 특정 서버가 뜨거운' 상황을 구분한다.
 * 데이터는 v2.384 적재 시점부터만 있으므로 수집 시작 시각을 함께 표기한다.
 */
function TrendModal({ groupId, groupName, kind, onClose }) {
  const [range, setRange] = React.useState('7d');
  const [k, setK] = React.useState(kind || 'inlet');
  const [d, setD] = React.useState(null);
  const [err, setErr] = React.useState(null);
  React.useEffect(() => {
    let dead = false;
    setD(null); setErr(null);
    fetchJson('/admin/room-temp/history', { kind: k, group: groupId || '', range })
      .then((r) => { if (!dead) setD(r); })
      .catch((e) => { if (!dead) setErr(e.message); });
    return () => { dead = true; };
  }, [groupId, k, range]);

  const fmtTs = (ts) => {
    const dt = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    if (range === '1d') return `${p(dt.getHours())}:${p(dt.getMinutes())}`;
    if (range === '7d') return `${p(dt.getMonth() + 1)}.${p(dt.getDate())} ${p(dt.getHours())}시`;
    if (range === '365d') return `${String(dt.getFullYear()).slice(2)}.${p(dt.getMonth() + 1)}.${p(dt.getDate())}`;
    return `${p(dt.getMonth() + 1)}.${p(dt.getDate())}`;
  };
  const pts = (d?.points || []).map((x) => ({ ...x, t: fmtTs(x.ts) }));

  return (
    <Modal title={`온도 추이 — ${groupName} · ${KIND_LABEL[k]}`} onClose={onClose} width={900} resizable minWidth={560} minHeight={380}>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 10, gap: 6 }}>
        {Object.keys(KIND_LABEL).map((x) => (
          <button key={x} className={k === x ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '5px 12px', fontSize: 12 }} onClick={() => setK(x)}>{KIND_LABEL[x]}</button>
        ))}
        <span style={{ flex: 1 }} />
        {TREND_RANGES.map(([v, l]) => (
          <button key={v} className={range === v ? 'login-btn' : 'tab'} style={{ padding: '5px 10px', fontSize: 11.5 }} onClick={() => setRange(v)}>{l}</button>
        ))}
      </div>

      {err ? <ErrorBox message={err} />
        : !d ? <Loading />
          : pts.length < 2 ? (
            <div className="muted" style={{ fontSize: 13, padding: 24, textAlign: 'center', lineHeight: 1.8 }}>
              이 기간에 표시할 추이 데이터가 없습니다.<br />
              온도 추이는 <b>수집이 시작된 시점부터</b> 쌓입니다
              {d.collectedSince ? <> — 수집 시작: <b>{new Date(d.collectedSince).toLocaleString('ko-KR')}</b>. 더 긴 기간은 그만큼 시간이 지나야 채워집니다.</>
                : <>(이 기능 적용 직후에는 몇 시간 뒤부터 그래프가 보입니다).</>}
            </div>
          ) : (
            <>
              <div style={{ width: '100%', height: 300 }}>
                <ResponsiveContainer>
                  <LineChart data={pts} margin={{ top: 6, right: 14, bottom: 2, left: 0 }}>
                    <CartesianGrid stroke="rgba(148,163,184,.14)" />
                    <XAxis dataKey="t" tick={{ fontSize: 10.5 }} minTickGap={28} />
                    <YAxis tick={{ fontSize: 10.5 }} width={48} tickFormatter={(v) => `${v}℃`} domain={['auto', 'auto']} />
                    <Tooltip labelFormatter={(t) => t} formatter={(v) => `${v}℃`}
                      contentStyle={{ background: 'var(--panel)', border: '1px solid var(--border)', fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 11.5 }} />
                    {/* 권장 대역 상한(27℃) 참조선 — 흡기일 때만 의미가 있어 그때만 그린다 */}
                    {k === 'inlet' && <Line type="monotone" dataKey={() => 27} name="권장 상한 27℃" stroke="rgba(74,222,128,.5)" strokeDasharray="6 4" dot={false} legendType="plainline" />}
                    <Line type="monotone" dataKey="max" name="최고" stroke={KIND_COLOR[k]} strokeDasharray="4 3" dot={false} connectNulls={false} />
                    <Line type="monotone" dataKey="avg" name="평균" stroke={KIND_COLOR[k]} strokeWidth={1.8} dot={false} connectNulls={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.7 }}>
                실선 = 법인 평균, 점선 = 법인 내 최고값. 집계 단위 {fmtBucket(d.bucketMs)} 평균 · 표본 {pts.length}점
                {d.collectedSince ? ` · 수집 시작 ${new Date(d.collectedSince).toLocaleDateString('ko-KR')}` : ''}
              </div>
            </>
          )}
    </Modal>
  );
}

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
function Metric({ label, agg, color, unitNote, onTrend }) {
  return (
    <div style={{ flex: 1, minWidth: 150 }}>
      <div className="flex between" style={{ alignItems: 'baseline' }}>
        {onTrend
          ? <button className="cell-link" style={{ fontSize: 11.5, padding: 0 }} title={`${label} 추이 보기(1일~1년)`} onClick={onTrend}>{label} 📈</button>
          : <span className="muted" style={{ fontSize: 11.5 }}>{label}</span>}
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
function VcCard({ dc, expanded, onToggle, onTrend }) {
  const st = dc.status ? STATUS[dc.status] : null;
  return (
    <div className="card" style={{ padding: 14, borderColor: st ? `${st.color}55` : undefined }}>
      <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 8, gap: 8 }}>
        <div className="flex gap" style={{ alignItems: 'center', gap: 8 }}>
          <b style={{ fontSize: 14 }}>🏢 {dc.name}</b>
          {st && <span className="badge" style={{ background: `${st.color}22`, color: st.color }} title={st.desc}>{st.label}</span>}
        </div>
        <span className="muted" style={{ fontSize: 11.5 }}>
          서버 {dc.hostCount}대
          {dc.inlet.servers ? ` · 흡기측정 ${dc.inlet.servers}` : ''}
          {dc.noSensorCount ? ` · 미수집 ${dc.noSensorCount}` : ''}
          {dc.staleCount ? ` · 미갱신 ${dc.staleCount}` : ''}
          {dc.remoteCount ? ` · 위임 ${dc.remoteCount}` : ''}
        </span>
      </div>

      <div className="flex gap wrap" style={{ gap: 14 }}>
        <Metric label="흡기(Inlet)" agg={dc.inlet} color="#60a5fa" unitNote="흡기 센서 없음" onTrend={() => onTrend(dc, 'inlet')} />
        <Metric label="배기(Exhaust)" agg={dc.exhaust} color="#fb923c" unitNote="배기 센서 없음" onTrend={() => onTrend(dc, 'exhaust')} />
        <Metric label="CPU" agg={dc.cpu} color="#f87171" unitNote="CPU 센서 없음" onTrend={() => onTrend(dc, 'cpu')} />
      </div>

      <div className="flex between wrap" style={{ alignItems: 'center', marginTop: 8, gap: 8 }}>
        <span className="muted" style={{ fontSize: 11.5 }}>
          {dc.deltaAvg != null ? <>배기−흡기 평균 <b style={{ color: 'var(--text)' }}>{dc.deltaAvg}℃</b>{dc.deltaAvg >= 20 ? ' (풍량·부하 점검 권장)' : ''}</> : '흡기·배기 쌍이 있는 서버가 없어 ΔT 미산출'}
        </span>
        {dc.hosts.length > 0 && (
          <button className="tab" style={{ padding: '4px 10px', fontSize: 11.5 }} onClick={() => onToggle(dc.id)}>
            {expanded ? '서버 접기' : `서버별 보기 (${dc.hosts.length})`}
          </button>
        )}
      </div>

      {expanded && dc.hosts.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 8, maxHeight: 260 }}>
          <table>
            <thead><tr>
              <th>서버</th><th style={{ textAlign: 'right' }}>흡기</th><th style={{ textAlign: 'right' }}>배기</th>
              <th style={{ textAlign: 'right' }}>CPU</th><th style={{ textAlign: 'right' }}>ΔT</th>
            </tr></thead>
            <tbody>
              {dc.hosts.map((s) => (
                <tr key={s.id}>
                  <td><b style={{ fontSize: 12.5 }}>{s.name}</b><div className="muted" style={{ fontSize: 11 }}>{s.serviceTag}{s.remote ? ' · 위임 수집' : ''}</div></td>
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
 * 데이터는 서버 분석 › 법인별 온도와 동일한 iDRAC 센서 수집값이다(추가 조회 없음).
 * v2.387 부터 기본 15분 이상 갱신되지 않은 표본은 집계에서 제외하고 그 수를 표기한다
 * (v2.383~2.386 에는 이 코드가 없었는데 주석만 남아 있었다 — 실제 구현과 일치시킴).
 */
export function RoomTemp() {
  // ⚠ 훅은 조기 return 위에서 전부 선언(CLAUDE.md — React #310 방지).
  const { data, error } = usePolling('/admin/room-temp', {}, 30_000);
  const [open, setOpen] = React.useState({});
  const [sort, setSort] = React.useState('inlet-desc');   // 기본: 흡기 높은순(문제 있는 곳 먼저)
  const [trend, setTrend] = React.useState(null);          // { group, kind } — 추이 모달
  const toggle = (id) => setOpen((c) => ({ ...c, [id]: !c[id] }));
  const openTrend = (g, kind) => setTrend({ group: g, kind });

  // 폴링 오류 1회로 화면을 갈아치우지 않는다(데이터 없을 때만 전체 오류 — CLAUDE.md).
  if (error && !data) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  const t = data.totals || {};
  const dcs = data.groups || [];

  return (
    <>
      {error && <div className="badge amber" style={{ marginBottom: 10, display: 'inline-block' }}>업데이트 실패(이전 데이터 표시 중)</div>}

      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="법인" value={t.groups ?? 0} meta={`측정 서버 ${t.withData ?? 0} / ${t.servers ?? 0}대`} />
        <Card label="흡기 범위(전체)" value={t.inlet?.min == null ? '—' : `${t.inlet.min}~${t.inlet.max}℃`}
          meta={t.inlet?.avg != null ? `평균 ${t.inlet.avg}℃` : '흡기 센서 없음'}
          accent={t.inlet?.max != null && t.inlet.max > 27 ? 'var(--amber)' : 'var(--green)'} />
        <Card label="배기 범위(전체)" value={t.exhaust?.min == null ? '—' : `${t.exhaust.min}~${t.exhaust.max}℃`}
          meta={t.exhaust?.avg != null ? `평균 ${t.exhaust.avg}℃` : '배기 센서 없음'} />
        <Card label="CPU 범위(전체)" value={t.cpu?.min == null ? '—' : `${t.cpu.min}~${t.cpu.max}℃`}
          meta={t.cpu?.avg != null ? `평균 ${t.cpu.avg}℃` : 'CPU 센서 없음'} />
        {t.noSensor ? <Card label="센서 미수집 서버" value={t.noSensor} meta="온도 센서를 아직 못 받은 서버 — 집계 제외" /> : null}
        {t.stale ? <Card label="미갱신 서버" value={t.stale} accent="var(--amber)"
          meta={`${Math.round((data.staleMs || 0) / 60000)}분 이상 갱신 없음 — 집계 제외(동결값 방지)`} /> : null}
      </div>

      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 10, gap: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>정렬</span>
        <select className="select" value={sort} onChange={(e) => setSort(e.target.value)} style={{ minWidth: 150 }}>
          {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <span className="muted" style={{ fontSize: 11.5 }}>· 흡기·배기·CPU 라벨(📈)을 누르면 1일~1년 추이를 봅니다</span>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.7 }}>
        범위 바의 연한 초록 구간은 <b>ASHRAE A1 권장 급기 18~27℃</b>이고, 흰 세로선은 평균입니다. 상태 배지는 <b>흡기 최고값</b>으로 보수적으로 판정합니다.
        배기·CPU 는 장비·부하에 따라 정상 범위가 달라 임계를 정하지 않고 값만 표시합니다.
      </div>

      {dcs.length === 0 ? (
        <div className="card" style={{ padding: 24, textAlign: 'center' }}>
          <div className="muted" style={{ fontSize: 13, lineHeight: 1.8 }}>
            표시할 데이터가 없습니다.<br />
iDRAC 온도 수집이 1회 이상 완료되어야 표시됩니다.<br />
            같은 데이터를 <b>특수 기능 › 서버 분석 › 법인별 온도</b>에서도 확인할 수 있습니다(동일 소스).
          </div>
        </div>
      ) : (
        <div className="grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 12 }}>
          {sortGroups(dcs, sort).map((dc) => (
            <VcCard key={dc.id || '_none'} dc={dc} expanded={!!open[dc.id]} onToggle={toggle} onTrend={openTrend} />
          ))}
        </div>
      )}

      {trend && (
        <TrendModal groupId={trend.group.id} groupName={trend.group.name} kind={trend.kind} onClose={() => setTrend(null)} />
      )}

      <div className="muted" style={{ fontSize: 11.5, marginTop: 12, lineHeight: 1.7 }}>
        · 데이터 출처는 <b>서버 분석 › 법인별 온도와 동일한 iDRAC 센서 수집</b>입니다(중앙 로컬 + 위임 엣지 병합, 추가 조회 없음).<br />
        · 센서 분류는 이름 기준입니다 — 흡기(Inlet/Intake/Ambient/Front) · 배기(Exhaust/Outlet/Exit/Rear) · CPU(CPU/CPU1/Proc/Package/Die).
        그 외 센서(메모리·PSU·보드 등)는 성격이 달라 집계에서 제외합니다.<br />
        · 한 서버에 같은 종류 센서가 여러 개면(CPU1·CPU2 등) <b>가장 높은 값</b>을 그 서버의 대표값으로 씁니다.<br />
        · 법인(DataCenter) 귀속이 1순위이고, 없으면 vCenter, 둘 다 없으면 <b>(미지정)</b> 으로 묶습니다 — 임의 배정하지 않습니다.
      </div>
    </>
  );
}
