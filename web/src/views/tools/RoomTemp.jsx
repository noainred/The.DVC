// RoomTemp.jsx — 특수 기능 '법인 전산실 운영 온도'(v2.381).
// 모든 법인의 흡기(inlet)·배기(exhaust)·CPU 온도 범위를 카드로 한 페이지에 종합한다.
import React from 'react';
import { fetchJson, usePolling } from '../../api.js';
import { Loading, ErrorBox, Modal } from '../../components/ui.jsx';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { Card } from './shared.jsx';
import { STable } from '../../components/STable.jsx';
import { SORTS, VIEWS, sortGroups, matrixStats, heat, tileData, boardCounts, sparkPath } from './roomTempView.js'; // v2.534 시안 적용(순수 판정)

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


/* ══════════════════════════════════════════════════════════════════════════════
 * 시안 적용(v2.534) — 클로드 디자인 캔버스 '온도 시각화 10안' 의 적용안 `2a`.
 * 보기 전환(범위 플롯 / 매트릭스 / 상황실 월보드)으로 세 시각화를 한 페이지에서 쓴다.
 * 정직성 규칙은 `views/tools/roomTempView.js` 머리말 참조(판정은 흡기 최고값만, 배기·CPU 는
 * 임계 없이 열 내 상대 농도, 확인 못 한 법인을 정상으로 칠하지 않음).
 * ══════════════════════════════════════════════════════════════════════════════ */

const TONE = { hot: '#f87171', warn: '#fbbf24', ok: '#4ade80', lowok: '#38bdf8', cold: '#60a5fa' };
const statusColor = (s) => TONE[s] || '#64748b';

/** 상태 배지 — 흡기 데이터가 없으면 '판정 불가'(회색)다. 초록으로 칠하면 거짓이다. */
function StatusBadge({ status, small }) {
  const st = status ? STATUS[status] : null;
  const c = statusColor(status);
  return (
    <span className="badge" style={{ background: `${c}22`, color: c, fontSize: small ? 10 : 11, whiteSpace: 'nowrap' }}
      title={st ? st.desc : '흡기 센서 값을 읽지 못해 판정할 수 없습니다(정상이라는 뜻이 아닙니다)'}>
      {st ? st.label : '판정 불가'}
    </span>
  );
}

/** 클릭 가능한 텍스트 — 표 안에서는 링크 파랑을 쓰지 않는다(v2.527 사용자 신고). */
function LinkText({ onClick, title, children }) {
  return (
    <span role="button" tabIndex={0} title={title}
      style={{ color: 'inherit', cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3 }}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } }}>
      {children}
    </span>
  );
}

/* ── ① 범위 플롯 ─────────────────────────────────────────────────────────────── */

/** 한 법인의 흡기 범위 막대 — 한 축(lo~hi)에 전 법인을 그려 눈으로 비교되게 한다. */
function PlotRow({ g, lo, hi, dtMax, onPick, onHover }) {
  const a = g.inlet || {};
  const pct = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  const has = a.min != null && a.max != null;
  const left = has ? pct(a.min) : 0;
  const width = has ? Math.max(1.5, pct(a.max) - left) : 0;
  const dt = g.deltaAvg;
  return (
    <tr onMouseEnter={() => onHover(g)} onMouseLeave={() => onHover(null)}>
      <td style={{ whiteSpace: 'nowrap', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        <LinkText onClick={() => onPick(g)} title={`${g.name} — 매트릭스에서 서버별로 보기`}>{g.name}</LinkText>
      </td>
      <td><StatusBadge status={g.status} small /></td>
      <td style={{ minWidth: 220 }}>
        {has ? (
          <div style={{ position: 'relative', height: 10, background: 'rgba(148,163,184,.15)', borderRadius: 5 }}
            title={`최저 ${a.min}℃ · 평균 ${a.avg ?? '—'}℃ · 최고 ${a.max}℃ · ${a.servers}대`}>
            {/* ASHRAE A1 권장 급기 18~27℃ */}
            <div style={{ position: 'absolute', left: `${pct(18)}%`, width: `${pct(27) - pct(18)}%`, top: 0, bottom: 0, background: 'rgba(74,222,128,.13)', borderLeft: '1px dashed rgba(74,222,128,.45)', borderRight: '1px dashed rgba(74,222,128,.45)' }} />
            {/* 32℃ 위험선 */}
            <div style={{ position: 'absolute', left: `${pct(32)}%`, top: -2, bottom: -2, width: 0, borderLeft: '1px dashed rgba(248,113,113,.7)' }} />
            <div style={{ position: 'absolute', left: `${left}%`, width: `${width}%`, top: 0, bottom: 0, background: statusColor(g.status), borderRadius: 5 }} />
            {a.avg != null && <div style={{ position: 'absolute', left: `${pct(a.avg)}%`, top: -2, bottom: -2, width: 2, background: '#fff', opacity: 0.9 }} />}
          </div>
        ) : <span className="muted" style={{ fontSize: 11.5 }}>흡기 센서 값 없음</span>}
      </td>
      <td className="right" style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
        {has ? <>{a.min}~{a.max}<span className="muted" style={{ fontSize: 10.5 }}>℃</span></> : '—'}
      </td>
      <td style={{ minWidth: 90 }}>
        {dt == null ? <span className="muted">—</span> : (
          <div style={{ position: 'relative', height: 8, background: 'rgba(148,163,184,.15)', borderRadius: 4 }}
            title={`배기−흡기 평균 ${dt}℃${dt >= 20 ? ' — 풍량·부하 점검 권장' : ''}`}>
            <div style={{ position: 'absolute', left: 0, width: `${Math.max(2, Math.min(100, (dt / dtMax) * 100))}%`, top: 0, bottom: 0, background: '#fb923c', borderRadius: 4 }} />
          </div>
        )}
      </td>
      <td className="right" style={{ whiteSpace: 'nowrap' }}>{dt == null ? '—' : `${dt}℃`}</td>
      <td className="right" style={{ whiteSpace: 'nowrap' }}>{C(g.exhaust?.max)}</td>
      <td className="right" style={{ whiteSpace: 'nowrap' }}>{C(g.cpu?.max)}</td>
    </tr>
  );
}

function RangePlot({ groups, onPick }) {
  const [hover, setHover] = React.useState(null);
  // 한 축을 쓰므로 스케일은 **전 법인 공통**이다 — 법인마다 다르면 막대 길이를 비교할 수 없다.
  const vals = groups.flatMap((g) => [g.inlet?.min, g.inlet?.max]).filter((v) => v != null);
  const lo = vals.length ? Math.min(12, Math.floor(Math.min(...vals) - 1)) : 12;
  const hi = vals.length ? Math.max(35, Math.ceil(Math.max(...vals) + 1)) : 35;
  const dtMax = Math.max(20, ...groups.map((g) => g.deltaAvg ?? 0));
  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="flex between wrap" style={{ alignItems: 'baseline', marginBottom: 6, gap: 8 }}>
        <b style={{ fontSize: 13 }}>흡기 범위 — 법인 {groups.length}곳 한 축</b>
        <span className="muted" style={{ fontSize: 11.5 }}>막대 = 최저~최고 · 흰 선 = 평균 · 초록 띠 = 권장 18~27℃ · 빨간 점선 = 32℃ · ΔT 막대는 0~{dtMax}℃</span>
      </div>
      <div className="table-wrap">
        <STable>
          <thead><tr>
            <th>법인</th><th>상태</th><th data-nosort>흡기 범위</th><th className="right">최저~최고</th>
            <th data-nosort>ΔT</th><th className="right">ΔT 평균</th><th className="right">배기 최고</th><th className="right">CPU 최고</th>
          </tr></thead>
          <tbody>
            {groups.map((g) => <PlotRow key={g.id || '_none'} g={g} lo={lo} hi={hi} dtMax={dtMax} onPick={onPick} onHover={setHover} />)}
          </tbody>
        </STable>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 6, minHeight: 20, lineHeight: 1.6 }}>
        {hover ? (
          <>
            <b style={{ color: 'var(--text)' }}>{hover.name}</b> · 흡기측정 {hover.inlet?.servers ?? 0}대
            {hover.exhaust?.min != null ? ` · 배기 ${hover.exhaust.min}~${hover.exhaust.max}℃` : ' · 배기 센서 없음'}
            {hover.cpu?.min != null ? ` · CPU ${hover.cpu.min}~${hover.cpu.max}℃` : ' · CPU 센서 없음'}
            {hover.noSensorCount ? ` · 미수집 ${hover.noSensorCount}대` : ''}
            {hover.staleCount ? ` · 미갱신 ${hover.staleCount}대` : ''}
          </>
        ) : '행에 마우스를 올리면 배기·CPU 범위와 서버 수를 여기에 표시합니다.'}
      </div>
    </div>
  );
}

/* ── ② 매트릭스 ─────────────────────────────────────────────────────────────── */

/** 열 내 상대 농도 셀. ⚠ 임계가 아니라 **비교** 다 — 색이 진하다고 이상이라는 뜻이 아니다. */
function HeatCell({ v, stats }) {
  const t = heat(v, stats);
  return (
    <td className="right" data-sort={String(v ?? '')}
      style={{ whiteSpace: 'nowrap', background: t == null ? undefined : `rgba(251,146,60,${(0.06 + t * 0.34).toFixed(3)})` }}>
      {C(v)}
    </td>
  );
}

function MatrixRow({ g, stats, expanded, onToggle, onTrend }) {
  const inlet = g.inlet || {};
  const cell = (v) => (
    <td className="right" data-sort={String(v ?? '')} style={{ whiteSpace: 'nowrap', color: v == null ? undefined : statusColor(inletToneOf(v)) }}>{C(v)}</td>
  );
  return (
    <>
      <tr>
        <td style={{ whiteSpace: 'nowrap', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }} title={g.name}>
          <LinkText onClick={() => onToggle(g.id)} title={`${g.name} — 흡기 높은 서버 펼치기`}>{g.name}</LinkText>
        </td>
        <td><StatusBadge status={g.status} small /></td>
        <td className="right">{inlet.servers ?? 0}</td>
        {cell(inlet.min)}{cell(inlet.avg)}{cell(inlet.max)}
        <HeatCell v={g.exhaust?.avg} stats={stats.get('exAvg')} />
        <HeatCell v={g.exhaust?.max} stats={stats.get('exMax')} />
        <HeatCell v={g.cpu?.avg} stats={stats.get('cpuAvg')} />
        <HeatCell v={g.cpu?.max} stats={stats.get('cpuMax')} />
        <HeatCell v={g.deltaAvg} stats={stats.get('dt')} />
        <td className="right" data-sort={String((g.noSensorCount || 0) + (g.staleCount || 0))}>
          {(g.noSensorCount || 0) + (g.staleCount || 0) || <span className="muted">—</span>}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={12} style={{ background: 'rgba(148,163,184,.05)' }}>
            <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 6, gap: 8 }}>
              <b style={{ fontSize: 12 }}>흡기 높은 서버 {Math.min(6, g.hosts?.length || 0)}대</b>
              {(g.hosts?.length || 0) > 6 && <span className="muted" style={{ fontSize: 11 }}>(전체 {g.hosts.length}대 중 상위 6대만)</span>}
              <span style={{ flex: 1 }} />
              {Object.keys(KIND_LABEL).map((x) => (
                <button key={x} className="tab" style={{ padding: '3px 9px', fontSize: 11 }} onClick={() => onTrend(g, x)}>{KIND_LABEL[x]} 추이 📈</button>
              ))}
            </div>
            {/* ⚠ maxHeight 는 상한(6대)이 **전부 보이는** 높이여야 한다 — 240px 에서는 6번째 행이
                잘려 '6대' 라고 해 놓고 5행만 보였다(v2.534 스크린샷 판독에서 발견한 결함). */}
            {(g.hosts || []).length === 0 ? (
              <div className="muted" style={{ fontSize: 12 }}>이 법인에서 온도를 읽은 서버가 없습니다.</div>
            ) : (
              <div className="table-wrap" style={{ maxHeight: 320 }}>
                <STable>
                  <thead><tr>
                    <th>서버</th><th>서비스태그</th><th className="right">흡기</th><th className="right">배기</th><th className="right">CPU</th><th className="right">ΔT</th>
                  </tr></thead>
                  <tbody>
                    {g.hosts.slice(0, 6).map((h) => (
                      <tr key={h.id}>
                        <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={h.name}>{h.name}</td>
                        <td className="muted" style={{ fontSize: 11.5 }}>{h.serviceTag || '—'}{h.remote ? ' · 위임' : ''}</td>
                        <td className="right" style={{ color: h.inlet != null ? statusColor(inletToneOf(h.inlet)) : undefined }}>{C(h.inlet)}</td>
                        <td className="right">{C(h.exhaust)}</td>
                        <td className="right">{C(h.cpu)}</td>
                        <td className="right muted">{h.deltaT == null ? '—' : `${h.deltaT}℃`}</td>
                      </tr>
                    ))}
                  </tbody>
                </STable>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/** 흡기 값 하나의 상태(서버 셀·매트릭스 흡기 열 색). 서버 규칙(roomTemp.js inletStatus)과 같다. */
function inletToneOf(c) {
  if (c == null) return null;
  if (c < 15) return 'cold';
  if (c <= 18) return 'lowok';
  if (c <= 27) return 'ok';
  if (c <= 32) return 'warn';
  return 'hot';
}

function Matrix({ groups, open, onToggle, onTrend }) {
  const stats = matrixStats(groups);
  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="flex between wrap" style={{ alignItems: 'baseline', marginBottom: 6, gap: 8 }}>
        <b style={{ fontSize: 13 }}>법인 × 센서 매트릭스</b>
        <span className="muted" style={{ fontSize: 11.5 }}>흡기 열 = ASHRAE 상태색(판정) · 배기·CPU·ΔT 열 = 열 안에서의 상대 농도(임계 없음)</span>
      </div>
      <div className="table-wrap">
        <STable>
          <thead><tr>
            <th>법인</th><th>상태</th><th className="right">서버</th>
            <th className="right">흡기 최저</th><th className="right">흡기 평균</th><th className="right">흡기 최고</th>
            <th className="right">배기 평균</th><th className="right">배기 최고</th>
            <th className="right">CPU 평균</th><th className="right">CPU 최고</th>
            <th className="right">ΔT 평균</th><th className="right">미수집</th>
          </tr></thead>
          <tbody>
            {groups.map((g) => (
              <MatrixRow key={g.id || '_none'} g={g} stats={stats} expanded={!!open[g.id]} onToggle={onToggle} onTrend={onTrend} />
            ))}
          </tbody>
        </STable>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.7 }}>
        법인명을 누르면 그 법인의 <b>흡기 높은 서버 상위 6대</b>가 펼쳐집니다. '미수집' 은 센서를 못 받았거나 15분 이상 갱신되지 않아 <b>집계에서 뺀</b> 서버 수입니다.
      </div>
    </div>
  );
}

/* ── ③ 상황실 월보드 ─────────────────────────────────────────────────────────── */

function Tile({ t, spark, onPick, big }) {
  const c = statusColor(t.status);
  const path = sparkPath(spark, { w: 120, h: 22 });
  return (
    <div className="card" role="button" tabIndex={0}
      onClick={() => onPick(t.id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(t.id); } }}
      style={{ padding: big ? '14px 16px' : '12px 14px', borderColor: `${c}66`, cursor: 'pointer', minWidth: 0 }}>
      <div className="flex between" style={{ alignItems: 'center', gap: 6 }}>
        <b style={{ fontSize: big ? 15 : 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.name}>{t.name}</b>
        <StatusBadge status={t.status === 'unknown' ? null : t.status} small />
      </div>
      <div style={{ fontSize: big ? 44 : 32, fontWeight: 800, lineHeight: 1.05, color: c, textAlign: 'center', margin: '6px 0 2px', fontVariantNumeric: 'tabular-nums' }}>
        {/* ⚠ 값이 없으면 단위를 붙이지 않는다 — '— ℃' 는 0℃ 처럼 읽힌다(v2.534 스크린샷 판독에서 발견). */}
        {t.inletMax == null ? '—' : <>{t.inletMax}<span style={{ fontSize: big ? 18 : 14, fontWeight: 600 }}>℃</span></>}
      </div>
      <div className="muted" style={{ fontSize: 11, textAlign: 'center' }}>
        흡기 최고 · 평균 {t.inletAvg == null ? '—' : `${t.inletAvg}℃`} · 서버 {t.servers}대
      </div>
      {/* 24시간 흡기 평균. 수집이 없던 시간은 **선을 잇지 않는다**(sparkPath 가 subpath 를 끊는다). */}
      <div style={{ height: 24, marginTop: 4 }}>
        {path ? (
          <svg width="100%" height="24" viewBox="0 0 120 24" preserveAspectRatio="none" role="img"
            aria-label={`최근 24시간 흡기 평균 ${path.lo}~${path.hi}℃`}>
            <path d={path.d} fill="none" stroke={c} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </svg>
        ) : <div className="muted" style={{ fontSize: 10, textAlign: 'center', lineHeight: '24px' }}>24시간 추이 없음(수집 시작 대기)</div>}
      </div>
      <div className="muted flex between" style={{ fontSize: 10.5, marginTop: 2, gap: 6 }}>
        <span>배기 {C(t.exMax)}</span><span>CPU {C(t.cpuMax)}</span><span>ΔT {t.dt == null ? '—' : `${t.dt}℃`}</span>
      </div>
      {t.missing > 0 && <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>집계 제외 {t.missing}대</div>}
    </div>
  );
}

function WallBoard({ groups, sparks, onPick, full, setFull }) {
  const counts = boardCounts(groups);
  const tiles = groups.map(tileData);
  const body = (
    <>
      <div className="flex between wrap" style={{ alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div className="flex gap wrap" style={{ gap: 8, alignItems: 'center' }}>
          <b style={{ fontSize: full ? 16 : 13 }}>상황실 월보드</b>
          <span className="badge" style={{ background: '#f8717122', color: '#f87171' }}>위험 {counts.hot}</span>
          <span className="badge" style={{ background: '#fbbf2422', color: '#fbbf24' }}>주의 {counts.warn}</span>
          <span className="badge" style={{ background: '#4ade8022', color: '#4ade80' }}>정상 {counts.ok}</span>
          {counts.cold > 0 && <span className="badge" style={{ background: '#60a5fa22', color: '#60a5fa' }}>과냉 {counts.cold}</span>}
          {/* ⚠ '판정 불가' 를 정상에 섞지 않는다 — 확인 못 한 것을 이상 없음으로 칠하면 거짓이다. */}
          {counts.unknown > 0 && <span className="badge" style={{ background: '#64748b22', color: '#94a3b8' }} title="흡기 센서 값을 읽지 못한 법인 — 정상이라는 뜻이 아닙니다">판정 불가 {counts.unknown}</span>}
        </div>
        <button className="tab" style={{ padding: '4px 12px', fontSize: 12 }} onClick={() => setFull(!full)}>
          {full ? '닫기 (Esc)' : '전체 화면으로 열기'}
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${full ? 230 : 200}px, 1fr))`, gap: 10 }}>
        {tiles.map((t) => <Tile key={t.id || '_none'} t={t} spark={sparks?.groups?.[t.id]} onPick={onPick} big={full} />)}
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.7 }}>
        큰 숫자는 <b>흡기 최고</b>(가장 보수적인 값), 타일 색은 상태, 아래 선은 <b>최근 24시간 흡기 평균</b>입니다. 타일을 누르면 매트릭스에서 그 법인의 서버가 펼쳐집니다.
      </div>
    </>
  );
  if (!full) return <div className="card" style={{ padding: 12 }}>{body}</div>;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'var(--bg, #0a0e17)', padding: 20, overflow: 'auto' }}>{body}</div>
  );
}

/* ── 화면 ────────────────────────────────────────────────────────────────────── */

/**
 * 법인 전산실 운영 온도 — 보기 전환(범위 플롯 / 매트릭스 / 상황실 월보드).
 * 데이터는 서버 분석 › 법인별 온도와 동일한 iDRAC 센서 수집값이다(추가 조회 없음).
 */
export function RoomTemp() {
  // ⚠ 훅은 전부 조기 return 위에서 선언(CLAUDE.md — React #310 방지).
  const { data, error } = usePolling('/admin/room-temp', {}, 30_000);
  const [sort, setSort] = React.useState('inlet-desc');
  const [view, setView] = React.useState('range');
  const [open, setOpen] = React.useState({});
  const [trend, setTrend] = React.useState(null);
  const [sparks, setSparks] = React.useState(null);
  const [full, setFull] = React.useState(false);

  const groups = React.useMemo(() => data?.groups || [], [data]);
  const sorted = React.useMemo(() => sortGroups(groups, sort), [groups, sort]);
  // 스파크라인 조회 키 — 폴링 틱마다 재조회하지 않도록 **법인 집합이 바뀔 때만** 바뀐다.
  const groupKey = React.useMemo(() => groups.map((g) => g.id).join(','), [groups]);

  // 월보드를 열었을 때만 24시간 추이를 **1회** 조회한다(폴링 금지 — 타일 16개 × 폴링이면 낭비다).
  React.useEffect(() => {
    if (view !== 'board' || !groupKey) return undefined;
    let dead = false;
    fetchJson('/admin/room-temp/spark', { kind: 'inlet', hours: 24, groups: groupKey })
      .then((r) => { if (!dead) setSparks(r); })
      .catch(() => { /* 추이가 없어도 타일은 그린다 — 타일이 '추이 없음' 이라고 말한다 */ });
    return () => { dead = true; };
  }, [view, groupKey]);

  // 전체 화면은 Esc 로 닫는다(버튼만 두면 키보드 사용자가 갇힌다).
  React.useEffect(() => {
    if (!full) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setFull(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  const toggle = React.useCallback((id) => setOpen((c) => ({ ...c, [id]: !c[id] })), []);
  const pick = React.useCallback((g) => {
    const id = typeof g === 'string' ? g : g?.id;
    setView('matrix'); setFull(false);
    setOpen((c) => ({ ...c, [id]: true }));
  }, []);
  const openTrend = React.useCallback((g, kind) => setTrend({ group: g, kind }), []);

  // 폴링 오류 1회로 화면을 갈아치우지 않는다(데이터 없을 때만 전체 오류 — CLAUDE.md).
  if (error && !data) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  const t = data.totals || {};

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
        <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>보기</span>
        <div className="flex" style={{ gap: 2 }}>
          {VIEWS.map(([v, l]) => (
            <button key={v} className={view === v ? 'login-btn' : 'tab'} style={{ padding: '5px 12px', fontSize: 12, flex: 'none' }}
              onClick={() => setView(v)}>{l}</button>
          ))}
        </div>
        <span className="muted" style={{ fontSize: 11.5 }}>· 플롯·월보드에서 법인을 누르면 매트릭스로 넘어가 서버가 펼쳐집니다</span>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.7 }}>
        초록 띠는 <b>ASHRAE A1 권장 급기 18~27℃</b>, 흰 선은 평균, 빨간 점선은 32℃ 위험선입니다. 상태 배지는 <b>흡기 최고값</b>으로 보수적으로 판정합니다.
        배기·CPU 는 장비·부하에 따라 정상 범위가 달라 <b>임계를 정하지 않고</b> 값과 열 안에서의 상대 농도만 표시합니다.
      </div>

      {sorted.length === 0 ? (
        <div className="card" style={{ padding: 24, textAlign: 'center' }}>
          <div className="muted" style={{ fontSize: 13, lineHeight: 1.8 }}>
            표시할 데이터가 없습니다.<br />
            iDRAC 온도 수집이 1회 이상 완료되어야 표시됩니다.<br />
            같은 데이터를 <b>특수 기능 › 서버 분석 › 법인별 온도</b>에서도 확인할 수 있습니다(동일 소스).
          </div>
        </div>
      ) : view === 'range' ? <RangePlot groups={sorted} onPick={pick} />
        : view === 'matrix' ? <Matrix groups={sorted} open={open} onToggle={toggle} onTrend={openTrend} />
          : <WallBoard groups={sorted} sparks={sparks} onPick={pick} full={full} setFull={setFull} />}

      {trend && (
        <TrendModal groupId={trend.group.id} groupName={trend.group.name} kind={trend.kind} onClose={() => setTrend(null)} />
      )}

      <div className="muted" style={{ fontSize: 11.5, marginTop: 12, lineHeight: 1.7 }}>
        · 데이터 출처는 <b>서버 분석 › 법인별 온도와 동일한 iDRAC 센서 수집</b>입니다(중앙 로컬 + 위임 엣지 병합, 추가 조회 없음).<br />
        · 센서 분류는 이름 기준입니다 — 흡기(Inlet/Intake/Ambient/Front) · 배기(Exhaust/Outlet/Exit/Rear) · CPU(CPU/CPU1/Proc/Package/Die).
        그 외 센서(메모리·PSU·보드 등)는 성격이 달라 집계에서 제외합니다.<br />
        · 한 서버에 같은 종류 센서가 여러 개면(CPU1·CPU2 등) <b>가장 높은 값</b>을 그 서버의 대표값으로 씁니다.<br />
        · 법인(DataCenter) 귀속이 1순위이고, 없으면 vCenter, 둘 다 없으면 <b>(미지정)</b> 으로 묶습니다 — 임의 배정하지 않습니다.<br />
        · 흡기 값을 읽지 못한 법인은 <b>정상이 아니라 '판정 불가'</b> 로 표시합니다.
      </div>
    </>
  );
}
