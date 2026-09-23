/**
 * GuestDiskDetailModal.jsx — 게스트 디스크 회수 리포트의 **추이 상세 팝업**(v2.468).
 *
 * 사용자 요구: "추이 버튼을 누르면 팝업으로, 정보를 최대한 많이, PDF/JPG export, 구간(최근 N일) 검색".
 * 자원 축소 근거 리포트(RightsizeReport)와 동일한 모달 규약(modal-overlay + EscClose + sheetRef +
 * PDF/JPG + 기간 버튼)을 따른다. 판정·추이는 서버(guestdisk/*)가 만들고 여기서는 표시만 한다.
 *
 * 데이터: GET /tools/guest-disk/vm/:id?days=N — N일 구간의 diff-저장 추이(전체는 days 미지정).
 * 게스트 파티션 추이는 변경분만 저장하므로(diff) 점 간격이 불규칙하고, 짧은 구간은 표본이 없을 수
 * 있다(그때는 '근거 부족'을 정직하게 표시하고 더 긴 구간을 권한다 — 추정하지 않는다).
 */
import React, { useEffect, useRef, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine, Legend } from 'recharts';
import { fetchJson } from '../../api.js';
import EscClose from '../../components/EscClose.jsx';
import { STable } from '../../components/STable.jsx';
import { safeFileName, saveElementAsJpg, saveDocAsPdf } from './reportExport.js';

const DAYS = [[7, '7일'], [30, '30일'], [90, '90일'], [180, '180일'], [365, '365일'], [0, '전체']];
const UNIT_OPTS = [['auto', '자동'], ['GB', 'GB'], ['TB', 'TB'], ['PB', 'PB']];
export const UNIT_DIV = { GB: 1, TB: 1024, PB: 1024 * 1024 };
const TREND = {
  growing: { label: '증가', color: '#f87171' },
  flat: { label: '평탄', color: '#93c5fd' },
  shrinking: { label: '감소', color: '#4ade80' },
};
export const trendLabel = (t) => (t && TREND[t] ? TREND[t] : { label: '근거 부족', color: '#9ca3af' });

/** 표시 단위 결정(auto 면 값 크기로) + 라벨. */
export function resolveUnit(unit, maxGB) {
  if (unit && unit !== 'auto') return unit;
  const abs = Math.abs(maxGB || 0);
  return abs >= 1024 * 1024 ? 'PB' : abs >= 1024 ? 'TB' : 'GB';
}
export function fmtSize(gb, unit = 'auto') {
  if (gb == null || Number.isNaN(gb)) return '—';
  const u = resolveUnit(unit, gb);
  const v = gb / UNIT_DIV[u];
  const dec = u === 'GB' ? (Math.abs(v) >= 100 ? 0 : 1) : 2;
  return `${v.toLocaleString(undefined, { maximumFractionDigits: dec })} ${u}`;
}
const pct = (x) => (x == null ? '—' : `${x}%`);
const dt = (t, days) => { const d = new Date(t); return (days > 0 && days <= 7) ? `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}시` : `${d.getMonth() + 1}/${d.getDate()}`; };
const tipStyle = { background: '#0f172a', border: '1px solid #334155', borderRadius: 8, fontSize: 12 };

function Stat({ k, v, sub, color }) {
  return (
    <div style={{ minWidth: 96 }}>
      <div className="muted" style={{ fontSize: 11 }}>{k}</div>
      <div style={{ fontWeight: 700, color: color || 'inherit' }}>{v}</div>
      {sub && <div className="muted" style={{ fontSize: 10.5 }}>{sub}</div>}
    </div>
  );
}

/** 벡터 PDF 문서 모델 — 화면(recharts)과 같은 내용을 글자·도형으로 그린다(reportExport.saveDocAsPdf). */
function buildGuestDoc(d, vm, days, u, div) {
  const size = (gb) => fmtSize(gb, u);
  const vt = d.vmTrend;
  const blocks = [];
  blocks.push({ type: 'kvrow', items: [
    { k: '할당(게스트 인식)', v: size(d.allocGB) },
    { k: '사용', v: size(d.usedGB) },
    { k: '회수 가능(여유)', v: size(d.freeGB), color: 'green', sub: Number(d.usageFactor) > 0 && Number(d.usageFactor) !== 1 ? `배율 ×${d.usageFactor}` : undefined },
    { k: '사용률', v: d.ratioPct == null ? '—' : `${d.ratioPct}%`, sub: '사용 / 할당' },
    { k: '파티션 수', v: String((d.partitions || []).length) },
    { k: '전체 사용량 추이', v: `${trendLabel(vt?.trend).label}${vt?.growthGBPerDay != null ? ` (${vt.growthGBPerDay > 0 ? '+' : ''}${vt.growthGBPerDay} GB/일)` : ''}`, sub: vt?.spanDays ? `관측 ${vt.spanDays}일` : '표본 부족' },
  ] });
  blocks.push({ type: 'heading', text: `게스트 총 사용량 추이 ${days > 0 ? `(최근 ${days}일)` : '(전체 기간)'}` });
  blocks.push({ type: 'linechart', unitLabel: u, refY: d.allocGB != null ? d.allocGB / div : null, refLabel: '할당', points: (d.vmTrendSeries || []).map((p) => ({ t: p.ts, v: p.usedGB / div })) });
  blocks.push({ type: 'heading', text: '파티션별 할당·사용·추이' });
  blocks.push({ type: 'table', columns: [
    { label: '파티션', w: 2.6 }, { label: '할당', align: 'right', w: 1 }, { label: '사용', align: 'right', w: 1 },
    { label: '여유', align: 'right', w: 1 }, { label: '사용률', align: 'right', w: 0.9 }, { label: '증가율(GB/일)', align: 'right', w: 1.2 },
    { label: '관측기간', align: 'right', w: 0.9 }, { label: '추이', w: 0.8 }, { label: '판정', w: 1.6 },
  ], rows: (d.partitions || []).map((p) => {
    const rp = p.capGB > 0 ? Math.round((p.usedGB / p.capGB) * 1000) / 10 : null;
    return [
      { text: p.path }, { text: size(p.capGB), align: 'right' }, { text: size(p.usedGB), align: 'right' },
      { text: size(p.freeGB), align: 'right', color: 'green' }, { text: rp == null ? '—' : `${rp}%`, align: 'right' },
      { text: p.trend?.growthGBPerDay == null ? '—' : String(p.trend.growthGBPerDay), align: 'right' },
      { text: p.trend?.spanDays ? `${p.trend.spanDays}일` : '—', align: 'right' },
      { text: trendLabel(p.trend?.trend).label }, { text: p.advice?.label || '—' },
    ];
  }) });
  for (const p of (d.partitions || [])) {
    blocks.push({ type: 'linechart', title: `${p.path} — 사용 ${size(p.usedGB)} / 할당 ${size(p.capGB)} · 여유 ${size(p.freeGB)}`, unitLabel: u, refY: p.capGB != null ? p.capGB / div : null, refLabel: '할당', points: (p.trend?.points || []).map((pt) => ({ t: pt.ts, v: pt.usedGB / div })) });
  }
  blocks.push({ type: 'note', text: '여유(회수 가능)는 게스트 관점의 회수 상한이며 실제 회수는 디스크 축소(shrink)+UNMAP 이 필요하고 OS·정렬에 따라 전량을 못 줄일 수 있습니다. 추이는 관측 시작 이후만 표시하고 표본 2점 미만이면 증가율을 계산하지 않습니다(변경분만 저장).' });
  return {
    title: `게스트 디스크 추이 상세 — ${vm.name}`,
    subtitle: `${d.corpName ? d.corpName + ' · ' : ''}${d.vcenterName || d.vcenterId}${d.cluster && d.cluster !== '(미지정)' ? ' · ' + d.cluster : ''}`,
    meta: `${days > 0 ? `최근 ${days}일` : '전체 기간'}${d.ts ? ` · 최신 수집 ${new Date(d.ts).toLocaleString()}` : ''}`,
    blocks,
  };
}

/** 한 시계열([{ts,usedGB,capGB?}])을 recharts 행으로. 값은 표시 단위로 나눈다. */
export function toRows(points, div) {
  return (points || [])
    .filter((p) => p && Number.isFinite(Number(p.ts)))
    .map((p) => ({ t: Number(p.ts), used: p.usedGB == null ? null : p.usedGB / div, cap: p.capGB == null ? null : p.capGB / div }))
    .sort((a, b) => a.t - b.t);
}

/** 사용량 추이 라인차트(용량 기준선 포함). rows: [{t, used, cap?}] */
export function TrendChart({ rows, unitLabel, days, capGB, height = 220 }) {
  if (!rows || rows.length < 2) {
    return <div className="gd-spark-empty">추이 표본 부족 — 이 구간에 관측점이 2개 미만입니다(변경분만 저장). 더 긴 구간(90일/365일/전체)을 눌러 보세요.</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={rows} margin={{ top: 8, right: 16, left: 4, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,.18)" />
        <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} scale="time"
          tickFormatter={(t) => dt(t, days)} tick={{ fontSize: 11, fill: '#94a3b8' }} />
        {/* Y축 상단을 할당 용량(capGB)까지 — 사용량 대비 여유가 한눈에 보이게(사용자 요구). 데이터가 더 크면 확장. */}
        <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} width={54} domain={[0, (max) => Math.max(max, capGB || 0)]}
          tickFormatter={(v) => `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}`} />
        <Tooltip contentStyle={tipStyle} labelFormatter={(t) => new Date(t).toLocaleString()}
          formatter={(v, n) => [`${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unitLabel}`, n === 'used' ? '사용' : '할당']} />
        <Legend formatter={(n) => (n === 'used' ? '사용' : '할당')} />
        {capGB != null && <ReferenceLine y={capGB} stroke="#fbbf24" strokeDasharray="4 4" label={{ value: `할당 ${capGB.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unitLabel}`, position: 'insideTopRight', fill: '#fbbf24', fontSize: 10 }} />}
        <Line type="monotone" dataKey="used" stroke="#60a5fa" strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} name="used" connectNulls />
      </LineChart>
    </ResponsiveContainer>
  );
}

export default function GuestDiskDetailModal({ vm, initUnit = 'auto', usageFactor = 1, onClose }) {
  // ⚠ 훅은 전부 최상단(조기 return 위)에 — CLAUDE.md 프론트 회귀 방지(React #310).
  const [days, setDays] = useState(30);
  const [unit, setUnit] = useState(initUnit || 'auto');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const sheetRef = useRef(null);
  const [saving, setSaving] = useState('');   // '' | 'pdf' | 'jpg'
  const [saveErr, setSaveErr] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    const uf = Number(usageFactor) > 0 && Number(usageFactor) !== 1 ? Number(usageFactor) : 1;
    const q = `?days=${days > 0 ? days : 0}${uf !== 1 ? `&usageFactor=${uf}` : ''}`;   // v2.482: 목록과 같은 배율
    fetchJson(`/tools/guest-disk/vm/${encodeURIComponent(vm.id)}${q}`)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [vm.id, days, usageFactor]);

  const save = async (kind) => {
    const el = sheetRef.current;
    if (!el || saving) return;
    setSaving(kind); setSaveErr('');
    try {
      const now = new Date(); const p = (n) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
      const label = days > 0 ? `최근${days}일` : '전체';
      const name = `${safeFileName(`게스트디스크추이_${vm.name}_${label}_${stamp}`)}.${kind === 'pdf' ? 'pdf' : 'jpg'}`;
      // PDF 는 글자·도형(벡터) — 문서 모델을 jsPDF 로 직접 그린다(한글 임베드 폰트). JPG 는 화면 캡처.
      if (kind === 'pdf') { if (!d) return; await saveDocAsPdf(buildGuestDoc(d, vm, days, dispUnit, div), name); }
      else await saveElementAsJpg(el, name);
    } catch (e) { setSaveErr(e?.message || String(e)); }
    finally { setSaving(''); }
  };

  const d = data && !error ? data : null;
  // 표시 단위 — auto 면 이 VM 의 최대 할당값으로 결정(파티션·차트가 같은 단위를 쓰도록).
  const maxGB = d ? Math.max(d.allocGB || 0, ...(d.partitions || []).map((p) => p.capGB || 0)) : 0;
  const dispUnit = resolveUnit(unit, maxGB);
  const div = UNIT_DIV[dispUnit];
  const vmRows = d ? toRows((d.vmTrendSeries || []).map((p) => ({ ts: p.ts, usedGB: p.usedGB, capGB: p.allocGB })), div) : [];
  const vt = d?.vmTrend;

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <EscClose onClose={onClose} />
      <div ref={sheetRef} className="modal card" style={{ maxWidth: 1120, width: '96vw', maxHeight: '92vh', overflow: 'auto' }}>
        <div className="flex between" style={{ marginBottom: 8, alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <b style={{ fontSize: 15 }}>📊 게스트 디스크 추이 상세 — {vm.name}</b>
            {d && <div className="muted" style={{ fontSize: 11.5 }}>
              {d.corpName ? `${d.corpName} · ` : ''}{d.vcenterName || d.vcenterId}{d.cluster && d.cluster !== '(미지정)' ? ` · ${d.cluster}` : ''}
              {d.ts ? ` · 최신 수집 ${new Date(d.ts).toLocaleString()}` : ''}
            </div>}
          </div>
          {/* data-export-hide: 저장 결과물에 버튼·컨트롤이 남지 않게 캡처에서 제외. */}
          <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }} data-export-hide>
            <button className="tab" style={{ padding: '5px 12px', fontSize: 12 }} disabled={!d || !!saving}
              title="이 상세 전체를 A4 여러 장 PDF 로 저장합니다." onClick={() => save('pdf')}>{saving === 'pdf' ? '저장 중…' : '⬇ PDF'}</button>
            <button className="tab" style={{ padding: '5px 12px', fontSize: 12 }} disabled={!d || !!saving}
              title="이 상세 전체를 JPG 이미지로 저장합니다." onClick={() => save('jpg')}>{saving === 'jpg' ? '저장 중…' : '⬇ JPG'}</button>
            <span style={{ width: 1, height: 18, background: 'rgba(255,255,255,.14)' }} />
            <div className="gd-seg" role="tablist">
              {UNIT_OPTS.map(([k, l]) => (
                <button key={k} type="button" role="tab" aria-selected={unit === k}
                  className={`gd-seg-btn${unit === k ? ' active' : ''}`} onClick={() => setUnit(k)}>{l}</button>
              ))}
            </div>
            <span style={{ width: 1, height: 18, background: 'rgba(255,255,255,.14)' }} />
            {DAYS.map(([dv, l]) => <button key={dv} className={days === dv ? 'login-btn' : 'tab'} style={{ padding: '5px 12px', fontSize: 12 }} onClick={() => setDays(dv)}>{dv > 0 ? `최근 ${l}` : l}</button>)}
            <button className="logout-btn" onClick={onClose}>닫기</button>
          </div>
        </div>
        {saveErr && <div className="error-box" style={{ margin: '0 0 8px' }} data-export-hide>저장 실패: {saveErr}</div>}

        {loading && <div className="muted" style={{ padding: 40, textAlign: 'center' }}>추이를 불러오는 중…</div>}
        {error && <div className="error-box" style={{ margin: 8 }}>조회 실패: {error}</div>}
        {!loading && !error && d && (
          <>
            {/* 요약 */}
            <div className="card" style={{ marginBottom: 10 }}>
              <div className="flex gap wrap" style={{ gap: 18 }}>
                <Stat k="할당(게스트 인식)" v={fmtSize(d.allocGB, dispUnit)} />
                <Stat k="사용" v={fmtSize(d.usedGB, dispUnit)} />
                <Stat k="회수 가능(여유)" v={fmtSize(d.freeGB, dispUnit)} color="#4ade80" sub={Number(d.usageFactor) > 0 && Number(d.usageFactor) !== 1 ? `배율 ×${d.usageFactor}: 할당 − 사용×${d.usageFactor}` : undefined} />
                <Stat k="사용률" v={pct(d.ratioPct)} sub="사용 / 할당" />
                <Stat k="파티션 수" v={(d.partitions || []).length} />
                <Stat k="전체 사용량 추이"
                  v={<span style={{ color: trendLabel(vt?.trend).color }}>{trendLabel(vt?.trend).label}{vt?.growthGBPerDay != null ? ` (${vt.growthGBPerDay > 0 ? '+' : ''}${vt.growthGBPerDay} GB/일)` : ''}</span>}
                  sub={vt?.spanDays ? `관측 ${vt.spanDays}일 · 점 ${vmRows.length}개` : '표본 부족'} />
              </div>
              <p className="muted" style={{ fontSize: 11, marginTop: 8, marginBottom: 0 }}>
                여유(회수 가능)는 <b>게스트 관점의 회수 상한</b>입니다. 실제 회수는 디스크 축소(shrink)+UNMAP 이 필요하며 OS·정렬에 따라 전량을 못 줄일 수 있습니다.
                추이는 관측 시작 이후만 표시하고(그 이전 근거 없음), 표본 2점 미만이면 증가율을 계산하지 않습니다.
              </p>
            </div>

            {/* VM 전체 사용량 추이 */}
            <div className="card" style={{ marginBottom: 10 }}>
              <div className="flex between" style={{ alignItems: 'baseline', marginBottom: 6 }}>
                <b>게스트 총 사용량 추이 {days > 0 ? `(최근 ${days}일)` : '(전체 기간)'}</b>
                <span className="muted" style={{ fontSize: 11 }}>단위 {dispUnit} · 노란선 = 할당 용량</span>
              </div>
              <TrendChart rows={vmRows} unitLabel={dispUnit} days={days} capGB={d.allocGB != null ? d.allocGB / div : null} height={240} />
            </div>

            {/* 파티션 요약 표 */}
            <div className="card" style={{ marginBottom: 10 }}>
              <b>파티션별 할당·사용·추이</b>
              <STable className="gd-table rpt-wrap" style={{ marginTop: 6 }}>
                <thead><tr>
                  <th>파티션</th><th className="gd-num">할당</th><th className="gd-num">사용</th><th className="gd-num">여유</th>
                  <th className="gd-num">사용률</th><th className="gd-num">증가율(GB/일)</th><th className="gd-num">관측기간</th><th>추이</th><th data-nosort>판정</th>
                </tr></thead>
                <tbody>
                  {(d.partitions || []).map((p) => {
                    const rp = p.capGB > 0 ? Math.round((p.usedGB / p.capGB) * 1000) / 10 : null;
                    return (
                      <tr key={p.path} style={p.removed ? { opacity: 0.6 } : undefined}>
                        <td>{p.path}{p.removed && <span className="muted" style={{ fontSize: 11 }}> · 제거됨</span>}</td>
                        <td data-sort={p.capGB} className="gd-num">{fmtSize(p.capGB, dispUnit)}</td>
                        <td data-sort={p.usedGB} className="gd-num">{fmtSize(p.usedGB, dispUnit)}</td>
                        <td data-sort={p.freeGB} className="gd-num" style={{ color: '#4ade80' }}>{fmtSize(p.freeGB, dispUnit)}</td>
                        <td data-sort={rp == null ? -1 : rp} className="gd-num">{pct(rp)}</td>
                        <td data-sort={p.trend?.growthGBPerDay == null ? -9999 : p.trend.growthGBPerDay} className="gd-num">{p.trend?.growthGBPerDay == null ? '—' : p.trend.growthGBPerDay}</td>
                        <td data-sort={p.trend?.spanDays || 0} className="gd-num">{p.trend?.spanDays ? `${p.trend.spanDays}일` : '—'}</td>
                        <td><span style={{ color: trendLabel(p.trend?.trend).color }}>{trendLabel(p.trend?.trend).label}</span></td>
                        <td data-nosort>{p.advice?.label || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </STable>
            </div>

            {/* 파티션별 미니 추이 차트(정보 최대치) */}
            <div className="gd-part-grid">
              {(d.partitions || []).map((p) => (
                <div key={p.path} className="card gd-part-card">
                  <div className="flex between" style={{ alignItems: 'baseline', marginBottom: 4 }}>
                    <b style={{ fontSize: 12.5 }}>{p.path}{p.removed && <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}> · 제거됨(최근 수집에 없음)</span>}</b>
                    <span className="muted" style={{ fontSize: 11 }}>사용 {fmtSize(p.usedGB, dispUnit)} / 할당 {fmtSize(p.capGB, dispUnit)} · 여유 <b style={{ color: '#4ade80' }}>{fmtSize(p.freeGB, dispUnit)}</b></span>
                  </div>
                  <TrendChart rows={toRows(p.trend?.points, div)} unitLabel={dispUnit} days={days} capGB={p.capGB != null ? p.capGB / div : null} height={150} />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
