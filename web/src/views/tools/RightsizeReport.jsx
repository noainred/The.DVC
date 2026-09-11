/**
 * RightsizeReport.jsx — VM 자원 축소 **근거 리포트** 모달(v2.445).
 *
 * 사용자 요구: "CPU·메모리를 줄여도 되는 구체적 근거 — 설정한 주기마다 점검한 사용률 추이를 차트로,
 * 기간별로, 구체적 설명과 근거자료(벌룬·스왑 포함, VMware best practice 와 공식 문서)".
 * 판정·문구·인용은 서버 순수 모듈(tools/rightsize.js)이 만들고 여기서는 표시만 한다.
 * 데이터는 vCenter 가 자체 보관하는 성능 롤업을 이 창을 열 때 조회한다(평소 수집 없음).
 */
import React, { useEffect, useRef, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine, Legend } from 'recharts';
import { fetchJson } from '../../api.js';
import EscClose from '../../components/EscClose.jsx';
import { STable } from '../../components/STable.jsx';
import { exportFileName, saveElementAsJpg, saveDocAsPdf } from './reportExport.js';

const DAYS = [7, 30, 90, 180, 365];
// 90일 초과는 vCenter 'year' 롤업(86400초=1일 샘플, 1년 보관)에서 조회한다 — 6개월·1년 검토 지원.
const dayLabel = (d) => (d === 365 ? '1년' : d === 180 ? '6개월' : `${d}일`);
const tip = { background: '#0f172a', border: '1px solid #334155', borderRadius: 8, fontSize: 12 };
const gb = (mb) => (mb == null ? '—' : `${(mb / 1024).toFixed(1)} GB`);
const ghz = (mhz) => (mhz == null ? '—' : `${(mhz / 1000).toFixed(2)} GHz`);
const n1 = (x, unit = '') => (x == null ? '—' : `${x}${unit}`);
const tick = (t, days) => { const d = new Date(t); return days <= 7 ? `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}시` : `${d.getMonth() + 1}/${d.getDate()}`; };
const STATE = {
  reduce: { color: 'var(--green)', badge: 'green', icon: '✅' },
  hold: { color: '#fbbf24', badge: 'amber', icon: '⚠️' },
  insufficient: { color: '#f87171', badge: 'red', icon: '⛔' },
  keep: { color: 'var(--muted)', badge: 'gray', icon: 'ℹ️' },
};

// 이력 통계(null 가능) + 실시간 폴백 → 표시 셀. 이력이 있으면 그대로, 이력이 비고(레벨 낮아 롤업
// 미수집) 실시간 현재값(최근 1시간)이 있으면 그것을 참고값으로 채운다(p95 는 실시간에 없어 '—').
function memCell(s, rtc) {
  const has = s && (s.avg != null || s.max != null);
  if (has) return { avg: gb(s.avg), p95: gb(s.p95), max: gb(s.max), isRt: false };
  if (rtc) return { avg: gb(rtc.avg), p95: '—', max: gb(rtc.max), isRt: true };
  return { avg: '—', p95: '—', max: '—', isRt: false };
}
const RT_TAG = <span title="vCenter 실시간(최근 1시간) 구간에서 조회한 현재값 — 이력 통계 레벨과 무관"
  style={{ background: '#0ea5e9', color: '#fff', fontSize: 9, marginLeft: 4, padding: '0 4px', borderRadius: 4, verticalAlign: 'middle' }}>실시간</span>;

/** 벡터 PDF 문서 모델 — 화면과 같은 내용을 글자·도형으로(reportExport.saveDocAsPdf). */
function buildRightsizeDoc(r, vm, days) {
  const mMB = (mb) => (mb == null ? '—' : `${(mb / 1024).toFixed(1)} GB`);
  const mGHz = (mhz) => (mhz == null ? '—' : `${(mhz / 1000).toFixed(2)} GHz`);
  const pc = (x) => (x == null ? '—' : `${x}%`);
  const rt = r.realtime || {};
  const w = r.window || {}; const cpu = r.cpu || {}; const mem = r.mem || {};
  const blocks = [];
  blocks.push({ type: 'heading', text: `판정 — ${r.verdict?.title || ''}` });
  if (r.verdict?.summary) blocks.push({ type: 'note', text: r.verdict.summary });
  for (const rs of (r.evidence?.reasons || [])) blocks.push({ type: 'note', text: `• ${rs}` });
  blocks.push({ type: 'kvrow', items: [
    { k: '관측 기간', v: `${w.coverageDays ?? 0}일`, sub: w.firstTs ? `${new Date(w.firstTs).toLocaleDateString()} ~ ${new Date(w.lastTs).toLocaleDateString()}` : '' },
    { k: '샘플', v: `${w.samples ?? 0} / ${w.expectedSamples ?? 0}`, sub: `커버리지 ${pc(w.coveragePct)} · 간격 ${w.intervalSec}초` },
    { k: '정책', v: `여유 ${r.policy?.headroomPct}% · 상한 ${r.policy?.capReductionPct}%`, sub: `최소 ${r.policy?.minDays}일 · 커버리지 ${r.policy?.minCoveragePct}%` },
  ] });
  blocks.push({ type: 'heading', text: `CPU — vCPU ${cpu.vcpu}${cpu.allocMhz ? ` (${mGHz(cpu.allocMhz)} 할당)` : ''}${cpu.recommendedVcpu != null ? ` · 권장 ${cpu.recommendedVcpu}${cpu.reductionVcpu > 0 ? ` (−${cpu.reductionVcpu}, ${cpu.reductionPct}%)` : ' (변경 없음)'}${cpu.capped ? ' · 50% 상한' : ''}` : ''}` });
  blocks.push({ type: 'kvrow', items: [
    { k: '사용 MHz 평균', v: mGHz(cpu.used?.avg) },
    { k: '사용 MHz p95', v: mGHz(cpu.used?.p95), sub: '산정 기준' },
    { k: '사용 MHz 최대', v: mGHz(cpu.used?.max) },
    { k: '사용률 p95/최대', v: `${pc(cpu.usagePct?.p95)} / ${pc(cpu.usagePct?.max)}` },
    { k: 'CPU Ready p95', v: pc(cpu.readyPct?.p95), sub: `경고선 ${r.policy?.readyWarnPct}%` },
  ] });
  const cpuPts = (r.series?.cpuUsageMhz || []).map((p) => ({ t: Date.parse(p.t), v: p.v == null ? null : p.v / 1000 })).filter((p) => Number.isFinite(p.t) && p.v != null);
  blocks.push({ type: 'linechart', title: '사용 MHz 추이', unitLabel: 'GHz', refY: cpu.used?.p95 != null ? cpu.used.p95 / 1000 : null, refLabel: 'p95', axisMax: cpu.allocMhz != null ? cpu.allocMhz / 1000 : null, points: cpuPts });
  blocks.push({ type: 'heading', text: `메모리 — ${mMB(mem.allocMB)} 할당${mem.recommendedMB != null ? ` · 권장 ${mMB(mem.recommendedMB)}${mem.reductionPct > 0 ? ` (${mem.reductionPct}%)` : ' (변경 없음)'}` : ''}` });
  const memCell = (s, rtc) => { const has = s && (s.avg != null || s.max != null); if (has) return { avg: mMB(s.avg), p95: mMB(s.p95), max: mMB(s.max), rt: false }; if (rtc) return { avg: mMB(rtc.avg), p95: '—', max: mMB(rtc.max), rt: true }; return { avg: '—', p95: '—', max: '—', rt: false }; };
  const memRow = (label, mean, s, rtc, note) => { const c = memCell(s, rtc); return [
    { text: label }, { text: mean }, { text: c.avg + (c.rt ? ' (실시간)' : ''), align: 'right', color: c.rt ? 'blue' : 'text' }, { text: c.p95, align: 'right' }, { text: c.max, align: 'right' }, { text: c.rt ? '이력 없음 · 실시간(최근 1시간) 현재값' : note },
  ]; };
  blocks.push({ type: 'table', columns: [
    { label: '계열', w: 1 }, { label: '의미', w: 2.5 }, { label: '평균', align: 'right', w: 1 }, { label: 'p95', align: 'right', w: 1 }, { label: '최대', align: 'right', w: 1 }, { label: '해석', w: 2.4 },
  ], rows: [
    memRow('Active', '게스트가 실제로 만지는 메모리(워킹셋)', mem.active, rt.memActiveMB, '감축 하한 후보 ①'),
    memRow('Consumed', '호스트가 배정한 메모리(캐시 포함)', mem.consumed, rt.memConsumedMB, '감축 하한 후보 ②'),
    memRow('Balloon', '벌룬 회수(>0=호스트 압박)', mem.balloon, rt.memBalloonMB, mem.balloon?.samplesAbove0 ? `${mem.balloon.pctTime}% 에서 0 초과 → 보류` : '관측 없음 → 정상'),
    memRow('Swapped', '호스트 스왑(>0=심각한 압박)', mem.swapped, rt.memSwappedMB, mem.swapped?.samplesAbove0 ? `${mem.swapped.pctTime}% 에서 0 초과 → 금지` : '관측 없음 → 정상'),
    [{ text: 'Usage %' }, { text: 'vCenter 사용률(active÷할당)' }, { text: pc(mem.usagePct?.avg), align: 'right' }, { text: pc(mem.usagePct?.p95), align: 'right' }, { text: pc(mem.usagePct?.max), align: 'right' }, { text: '참고' }],
  ] });
  const memPts = (r.series?.memConsumedMB || []).map((p) => ({ t: Date.parse(p.t), v: p.v == null ? null : p.v / 1024 })).filter((p) => Number.isFinite(p.t) && p.v != null);
  blocks.push({ type: 'linechart', title: 'Consumed 메모리 추이', unitLabel: 'GB', refY: mem.allocMB != null ? mem.allocMB / 1024 : null, refLabel: '할당', points: memPts });
  if (mem.basisNote) blocks.push({ type: 'note', text: `메모리 산정: ${mem.basisNote}` });
  blocks.push({ type: 'note', text: '이 리포트는 vCenter 롤업 통계(각 점=간격 평균)를 근거로 합니다. 순간 피크는 이보다 높을 수 있으므로 감축은 여유를 두고 적용 후 재확인하세요. 실시간 표시 값은 참고용 현재값이며 다일 감축 하한 계산에는 반영하지 않습니다.' });
  return {
    title: `자원 축소 근거 리포트 — ${vm.name}`,
    subtitle: `${vm.vcenterId} · ${vm.host || ''} · ${vm.guestOS || ''}`,
    meta: `최근 ${dayLabel(days)} · 롤업 ${w.intervalSec}초${r.cached ? ' · 5분 캐시' : ''}${r.synthesized ? ' · 데모(mock)' : ''}`,
    blocks,
  };
}

/** 시계열 여러 개를 t 기준으로 합쳐 recharts 행으로. */
function merge(series, keys) {
  const byT = new Map();
  for (const k of keys) for (const p of series?.[k] || []) {
    const t = Date.parse(p.t); if (!Number.isFinite(t)) continue;
    let e = byT.get(t); if (!e) { e = { t }; byT.set(t, e); }
    e[k] = p.v;
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

function Stat({ k, v, sub }) {
  return <div style={{ minWidth: 120 }}><div className="muted" style={{ fontSize: 11 }}>{k}</div><div style={{ fontWeight: 700 }}>{v}</div>{sub && <div className="muted" style={{ fontSize: 10.5 }}>{sub}</div>}</div>;
}

export default function RightsizeReport({ vm, onClose }) {
  // ⚠ 훅은 전부 최상단(조기 return 위)에 — CLAUDE.md 프론트 회귀 방지(React #310).
  const [days, setDays] = useState(7);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const sheetRef = useRef(null);          // PDF/JPG 로 저장할 영역(모달 본문 전체)
  const [saving, setSaving] = useState(''); // '' | 'pdf' | 'jpg'
  const [saveErr, setSaveErr] = useState('');
  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    fetchJson(`/tools/rightsize?vmId=${encodeURIComponent(vm.id)}&days=${days}`)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [vm.id, days]);

  const r = data;
  const rt = r?.realtime || {};   // 이력 롤업에 안 잡힌 level-2 mem 카운터의 실시간 현재값(참고)
  const st = r ? STATE[r.verdict?.state] || STATE.keep : null;
  const cpuRows = r ? merge(r.series, ['cpuUsageMhz']).map((e) => ({ ...e, alloc: r.cpu.allocMhz })) : [];
  const memRows = r ? merge(r.series, ['memActiveMB', 'memConsumedMB', 'memBalloonMB', 'memSwappedMB']) : [];
  const readyRows = r ? (r.readyPctSeries || []).map((p) => ({ t: Date.parse(p.t), v: p.v })).filter((p) => Number.isFinite(p.t)) : [];

  // PDF/JPG 저장(v2.449) — 감축 결재 근거로 파일을 남길 수 있어야 한다는 사용자 요구.
  // 라이브러리는 클릭 시점에 동적 import 되므로(reportExport.js) 평소 번들에는 실리지 않는다.
  const save = async (kind) => {
    const el = sheetRef.current;
    if (!el || saving) return;
    setSaving(kind); setSaveErr('');
    try {
      const name = exportFileName(vm.name, days, kind === 'pdf' ? 'pdf' : 'jpg');
      // PDF 는 글자·도형(벡터) — 문서 모델을 jsPDF 로 직접 그린다(한글 임베드 폰트). JPG 는 화면 캡처.
      if (kind === 'pdf') { if (!r) return; await saveDocAsPdf(buildRightsizeDoc(r, vm, days), name); }
      else await saveElementAsJpg(el, name);
    } catch (e) {
      setSaveErr(e?.message || String(e));
    } finally {
      setSaving('');
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <EscClose onClose={onClose} />
      <div ref={sheetRef} className="modal card" style={{ maxWidth: 1100, width: '96vw', maxHeight: '92vh', overflow: 'auto' }}>
        <div className="flex between" style={{ marginBottom: 8, alignItems: 'center' }}>
          <div>
            <b style={{ fontSize: 15 }}>📊 자원 축소 근거 리포트 — {vm.name}</b>
            <div className="muted" style={{ fontSize: 11.5 }}>{vm.vcenterId} · {vm.host} · {vm.guestOS || ''}</div>
          </div>
          {/* data-export-hide: 저장 결과물에는 버튼이 남지 않게 캡처에서 제외한다. */}
          <div className="flex gap" style={{ alignItems: 'center' }} data-export-hide>
            <button className="tab" style={{ padding: '5px 12px', fontSize: 12 }} disabled={!r || !!saving}
              title="이 리포트 전체를 A4 여러 장 PDF 로 저장합니다(스크롤로 가려진 부분까지 포함)."
              onClick={() => save('pdf')}>{saving === 'pdf' ? '저장 중…' : '⬇ PDF'}</button>
            <button className="tab" style={{ padding: '5px 12px', fontSize: 12 }} disabled={!r || !!saving}
              title="이 리포트 전체를 JPG 이미지 한 장으로 저장합니다."
              onClick={() => save('jpg')}>{saving === 'jpg' ? '저장 중…' : '⬇ JPG'}</button>
            <span style={{ width: 1, height: 18, background: 'rgba(255,255,255,.14)' }} />
            {DAYS.map((d) => <button key={d} className={days === d ? 'login-btn' : 'tab'} style={{ padding: '5px 12px', fontSize: 12 }} onClick={() => setDays(d)}>최근 {dayLabel(d)}</button>)}
            <button className="logout-btn" onClick={onClose}>닫기</button>
          </div>
        </div>
        {saveErr && <div className="error-box" style={{ margin: '0 0 8px' }} data-export-hide>저장 실패: {saveErr}</div>}

        {loading && <div className="muted" style={{ padding: 40, textAlign: 'center' }}>vCenter 에서 {days}일 성능 이력을 불러오는 중… (고RTT 사이트는 수 초)</div>}
        {error && <div className="error-box" style={{ margin: 8 }}>조회 실패: {error}</div>}
        {!loading && !error && r && (
          <>
            {/* 판정 */}
            <div className="card" style={{ marginBottom: 10, borderLeft: `4px solid ${st.color}` }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{st.icon} {r.verdict.title}</div>
              <div style={{ marginTop: 4, lineHeight: 1.6 }}>{r.verdict.summary}</div>
              {r.evidence.reasons.length > 0 && (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6, color: r.evidence.sufficient ? 'var(--muted)' : '#f87171' }}>
                  {r.evidence.reasons.map((x, i) => <li key={i}>{x}</li>)}
                </ul>
              )}
              <div className="flex gap wrap" style={{ marginTop: 8, gap: 18 }}>
                <Stat k="관측 기간" v={`${r.window.coverageDays ?? 0}일`} sub={r.window.firstTs ? `${new Date(r.window.firstTs).toLocaleString('ko-KR')} ~ ${new Date(r.window.lastTs).toLocaleString('ko-KR')}` : '데이터 없음'} />
                <Stat k="샘플" v={`${r.window.samples} / ${r.window.expectedSamples}`} sub={`커버리지 ${n1(r.window.coveragePct, '%')} · 간격 ${r.window.intervalSec}초`} />
                <Stat k="정책" v={`여유 ${r.policy.headroomPct}% · 상한 ${r.policy.capReductionPct}%`} sub={`최소 ${r.policy.minDays}일 · 커버리지 ${r.policy.minCoveragePct}% · Ready ${r.policy.readyWarnPct}%`} />
                {r.synthesized && <span className="badge gray" style={{ alignSelf: 'center' }}>데모(mock) 합성 데이터</span>}
                {r.cached && <span className="badge gray" style={{ alignSelf: 'center', fontSize: 10 }}>5분 캐시</span>}
              </div>
            </div>

            {/* CPU */}
            <div className="card" style={{ marginBottom: 10 }}>
              <div className="flex between" style={{ alignItems: 'center', marginBottom: 6 }}>
                <b>CPU — vCPU {r.cpu.vcpu}{r.cpu.allocMhz ? ` (${ghz(r.cpu.allocMhz)} 할당)` : ''}</b>
                {r.cpu.recommendedVcpu != null && (
                  <span className={`badge ${r.cpu.ok ? 'green' : r.cpu.blockers.length ? 'amber' : 'gray'}`}>
                    권장 vCPU {r.cpu.recommendedVcpu}{r.cpu.reductionVcpu > 0 ? ` (−${r.cpu.reductionVcpu}, ${r.cpu.reductionPct}%)` : ' (변경 없음)'}{r.cpu.capped ? ' · 50% 상한 적용' : ''}
                  </span>
                )}
              </div>
              <div className="flex gap wrap" style={{ gap: 18, marginBottom: 8 }}>
                <Stat k="사용 MHz 평균" v={ghz(r.cpu.used.avg)} />
                <Stat k="사용 MHz p95" v={ghz(r.cpu.used.p95)} sub="산정 기준" />
                <Stat k="사용 MHz 최대" v={ghz(r.cpu.used.max)} />
                <Stat k="사용률 p95 / 최대" v={`${n1(r.cpu.usagePct.p95, '%')} / ${n1(r.cpu.usagePct.max, '%')}`} />
                <Stat k="CPU Ready p95 (vCPU당)" v={n1(r.cpu.readyPct.p95, '%')} sub={`경고선 ${r.policy.readyWarnPct}%`} />
                <Stat k="산정 근거" v={r.cpu.basisMhz != null ? ghz(r.cpu.basisMhz) : '—'} sub={r.cpu.basisNote || ''} />
              </div>
              {r.cpu.blockers.map((b, i) => <div key={i} style={{ color: '#fbbf24', fontSize: 12.5, marginBottom: 4 }}>⚠ {b}</div>)}
              <div style={{ height: 220 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={cpuRows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#243049" />
                    <XAxis dataKey="t" stroke="#8b9bb4" fontSize={11} minTickGap={50} tickFormatter={(t) => tick(t, days)} />
                    {/* Y축 상단을 할당 용량까지 — 사용량 대비 여유가 한눈에 보이게(사용자 요구). 데이터가 더 크면 확장. */}
                    <YAxis stroke="#8b9bb4" fontSize={11} width={60} domain={[0, (max) => Math.max(max, r.cpu.allocMhz || 0)]} tickFormatter={(v) => `${(v / 1000).toFixed(1)}G`} />
                    <Tooltip contentStyle={tip} labelFormatter={(t) => new Date(t).toLocaleString('ko-KR')} formatter={(v, k) => [ghz(v), k === 'cpuUsageMhz' ? '사용 MHz' : k]} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="cpuUsageMhz" name="사용 MHz" stroke="#3b82f6" strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
                    {r.cpu.allocMhz && <ReferenceLine y={r.cpu.allocMhz} stroke="#64748b" strokeDasharray="4 4" label={{ value: `할당 ${ghz(r.cpu.allocMhz)}`, fill: '#94a3b8', fontSize: 11, position: 'insideTopRight' }} />}
                    {r.cpu.used.p95 != null && <ReferenceLine y={r.cpu.used.p95} stroke="#f59e0b" strokeDasharray="2 2" label={{ value: 'p95', fill: '#f59e0b', fontSize: 11, position: 'insideBottomRight' }} />}
                    {r.cpu.recommendedVcpu != null && r.cpu.mhzPerCore && <ReferenceLine y={r.cpu.recommendedVcpu * r.cpu.mhzPerCore} stroke="#22c55e" strokeDasharray="6 3" label={{ value: `권장 ${r.cpu.recommendedVcpu} vCPU`, fill: '#22c55e', fontSize: 11, position: 'insideTopLeft' }} />}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              {readyRows.length > 0 && (
                <>
                  <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>CPU Ready %/vCPU 추이 — 값이 클수록 vCPU 가 물리 CPU 를 기다린 시간(경합). {r.policy.readyWarnPct}% 경고선을 넘으면 CPU 감축을 보류합니다.</div>
                  <div style={{ height: 128, marginTop: 2 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={readyRows} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#243049" />
                        <XAxis dataKey="t" stroke="#8b9bb4" fontSize={10} minTickGap={50} tickFormatter={(t) => tick(t, days)} />
                        <YAxis stroke="#8b9bb4" fontSize={10} width={60} domain={[0, (max) => Math.max(max, r.policy.readyWarnPct * 2)]} tickFormatter={(v) => `${v.toFixed(1)}%`} />
                        <Tooltip contentStyle={tip} labelFormatter={(t) => new Date(t).toLocaleString('ko-KR')} formatter={(v) => [`${v?.toFixed?.(2)}%`, 'CPU Ready/vCPU']} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Line type="monotone" dataKey="v" name="CPU Ready %/vCPU" stroke="#f97316" strokeWidth={1.4} dot={false} isAnimationActive={false} connectNulls />
                        <ReferenceLine y={r.policy.readyWarnPct} stroke="#ef4444" strokeDasharray="2 2" label={{ value: `경고선 ${r.policy.readyWarnPct}%`, fill: '#ef4444', fontSize: 10, position: 'insideTopRight' }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </>
              )}
            </div>

            {/* 메모리 */}
            <div className="card" style={{ marginBottom: 10 }}>
              <div className="flex between" style={{ alignItems: 'center', marginBottom: 6 }}>
                <b>메모리 — {gb(r.mem.allocMB)} 할당</b>
                {r.mem.recommendedMB != null && (
                  <span className={`badge ${r.mem.ok ? 'green' : r.mem.blockers.length ? 'amber' : 'gray'}`}>
                    권장 {gb(r.mem.recommendedMB)}{r.mem.reductionMB > 0 ? ` (−${gb(r.mem.reductionMB)}, ${r.mem.reductionPct}%)` : ' (변경 없음)'}{r.mem.capped ? ' · 50% 상한 적용' : ''}
                  </span>
                )}
              </div>
              <div className="table-wrap" style={{ marginBottom: 8 }}>
                <STable>
                  <thead><tr><th>계열</th><th>의미</th><th className="right">평균</th><th className="right">p95</th><th className="right">최대</th><th>해석</th></tr></thead>
                  <tbody>
                    {(() => { const c = memCell(r.mem.active, rt.memActiveMB); return (
                      <tr style={c.isRt ? { background: 'rgba(14,165,233,.08)' } : undefined}>
                        <td><b>Active</b></td><td className="muted">게스트가 실제로 만지는 메모리(워킹셋 추정)</td>
                        <td className="right">{c.avg}{c.isRt && RT_TAG}</td><td className="right">{c.p95}</td><td className="right">{c.max}</td>
                        <td className="muted">{c.isRt ? '이력 롤업엔 표본 없음 · 실시간(최근 1시간) 현재값 — vCenter 통계 레벨 ↑ 시 이력도 쌓임' : '감축 하한 후보 ①'}</td>
                      </tr>); })()}
                    {(() => { const c = memCell(r.mem.consumed, rt.memConsumedMB); return (
                      <tr style={c.isRt ? { background: 'rgba(14,165,233,.08)' } : undefined}>
                        <td><b>Consumed</b></td><td className="muted">호스트가 이 VM 에 실제 배정한 메모리(캐시 포함)</td>
                        <td className="right">{c.avg}{c.isRt && RT_TAG}</td><td className="right">{c.p95}</td><td className="right">{c.max}</td>
                        <td className="muted">{c.isRt ? '이력 롤업엔 표본 없음 · 실시간 현재값' : '감축 하한 후보 ② — active 만 보면 캐시를 빼앗음'}</td>
                      </tr>); })()}
                    {(() => { const c = memCell(r.mem.balloon, rt.memBalloonMB); const has = r.mem.balloon && (r.mem.balloon.avg != null || r.mem.balloon.max != null); return (
                      <tr style={r.mem.balloon.samplesAbove0 ? { color: '#fbbf24' } : c.isRt ? { background: 'rgba(14,165,233,.08)' } : undefined}>
                        <td><b>Balloon</b></td><td className="muted">ESXi 가 벌룬 드라이버로 회수한 양(&gt;0 = 호스트 압박)</td>
                        <td className="right">{c.avg}{c.isRt && RT_TAG}</td><td className="right">{c.p95}</td><td className="right">{c.max}</td>
                        <td>{has ? (r.mem.balloon.samplesAbove0 ? `관측 시간의 ${r.mem.balloon.pctTime}% 에서 0 초과 → 감축 보류` : '관측 없음 → 정상') : c.isRt ? '이력 없음 · 실시간 현재값' : '관측 없음'}</td>
                      </tr>); })()}
                    {(() => { const c = memCell(r.mem.swapped, rt.memSwappedMB); const has = r.mem.swapped && (r.mem.swapped.avg != null || r.mem.swapped.max != null); return (
                      <tr style={r.mem.swapped.samplesAbove0 ? { color: '#f87171' } : c.isRt ? { background: 'rgba(14,165,233,.08)' } : undefined}>
                        <td><b>Swapped</b></td><td className="muted">호스트 스왑으로 내려간 양(&gt;0 = 심각한 압박)</td>
                        <td className="right">{c.avg}{c.isRt && RT_TAG}</td><td className="right">{c.p95}</td><td className="right">{c.max}</td>
                        <td>{has ? (r.mem.swapped.samplesAbove0 ? `관측 시간의 ${r.mem.swapped.pctTime}% 에서 0 초과 → 감축 금지` : '관측 없음 → 정상') : c.isRt ? '이력 없음 · 실시간 현재값' : '관측 없음'}</td>
                      </tr>); })()}
                    <tr><td><b>Usage %</b></td><td className="muted">vCenter 표시 사용률(active ÷ 할당)</td><td className="right">{n1(r.mem.usagePct.avg, '%')}</td><td className="right">{n1(r.mem.usagePct.p95, '%')}</td><td className="right">{n1(r.mem.usagePct.max, '%')}</td><td className="muted">참고</td></tr>
                  </tbody>
                </STable>
              </div>
              {r.mem.basisMB != null && <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>산정 근거: {r.mem.basisNote} = <b style={{ color: 'var(--text)' }}>{gb(r.mem.basisMB)}</b> → {r.policy.memStepMB} MB 단위 올림 → 권장 <b style={{ color: 'var(--text)' }}>{gb(r.mem.recommendedMB)}</b></div>}
              {r.mem.blockers.map((b, i) => <div key={i} style={{ color: '#fbbf24', fontSize: 12.5, marginBottom: 4 }}>⚠ {b}</div>)}
              <div style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={memRows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#243049" />
                    <XAxis dataKey="t" stroke="#8b9bb4" fontSize={11} minTickGap={50} tickFormatter={(t) => tick(t, days)} />
                    {/* Y축 상단을 할당 용량까지(사용자 요구). 데이터가 더 크면 확장. */}
                    <YAxis stroke="#8b9bb4" fontSize={11} width={60} domain={[0, (max) => Math.max(max, r.mem.allocMB || 0)]} tickFormatter={(v) => `${(v / 1024).toFixed(0)}G`} />
                    <Tooltip contentStyle={tip} labelFormatter={(t) => new Date(t).toLocaleString('ko-KR')} formatter={(v, k) => [gb(v), { memActiveMB: 'Active', memConsumedMB: 'Consumed', memBalloonMB: 'Balloon', memSwappedMB: 'Swapped' }[k] || k]} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="memConsumedMB" name="Consumed" stroke="#a855f7" strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
                    <Line type="monotone" dataKey="memActiveMB" name="Active" stroke="#22d3ee" strokeWidth={1.4} dot={false} isAnimationActive={false} connectNulls />
                    <Line type="monotone" dataKey="memBalloonMB" name="Balloon" stroke="#fbbf24" strokeWidth={1.4} dot={false} isAnimationActive={false} connectNulls />
                    <Line type="monotone" dataKey="memSwappedMB" name="Swapped" stroke="#ef4444" strokeWidth={1.4} dot={false} isAnimationActive={false} connectNulls />
                    {r.mem.allocMB > 0 && <ReferenceLine y={r.mem.allocMB} stroke="#64748b" strokeDasharray="4 4" label={{ value: `할당 ${gb(r.mem.allocMB)}`, fill: '#94a3b8', fontSize: 11, position: 'insideTopRight' }} />}
                    {r.mem.recommendedMB != null && <ReferenceLine y={r.mem.recommendedMB} stroke="#22c55e" strokeDasharray="6 3" label={{ value: `권장 ${gb(r.mem.recommendedMB)}`, fill: '#22c55e', fontSize: 11, position: 'insideTopLeft' }} />}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* 디스크 — 정직하게 현재값만 */}
            <div className="card" style={{ marginBottom: 10 }}>
              <b>디스크</b>
              <div className="flex gap wrap" style={{ gap: 18, marginTop: 6 }}>
                <Stat k="커밋(실사용) 용량" v={r.disk.storageGB != null ? `${r.disk.storageGB} GB` : '—'} />
                <Stat k="미커밋(thin 여유)" v={r.disk.uncommittedGB != null ? `${r.disk.uncommittedGB} GB` : '—'} sub={r.disk.thin ? 'thin 디스크' : 'thick'} />
                <Stat k="VMware Tools" v={r.disk.toolsStatus || '—'} />
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.6 }}>{r.disk.note}</div>
            </div>

            {/* 방법론 + 참고 문서 */}
            <div className="card">
              <b>판정 방법 · 참고한 공식 문서</b>
              <ol style={{ margin: '6px 0 10px', paddingLeft: 20, fontSize: 12.5, lineHeight: 1.7 }}>
                {r.methodology.map((m, i) => <li key={i}>{m}</li>)}
              </ol>
              <div className="table-wrap">
                <STable>
                  <thead><tr><th>문서</th><th>이 리포트에서 쓴 곳</th></tr></thead>
                  <tbody>
                    {r.citations.map((c, i) => (
                      <tr key={i}>
                        <td style={{ whiteSpace: 'normal', lineHeight: 1.5 }}><a href={c.url} target="_blank" rel="noreferrer" style={{ color: '#93c5fd' }}>{c.title}</a></td>
                        <td className="muted" style={{ fontSize: 12, whiteSpace: 'normal', lineHeight: 1.5 }}>{c.usedFor}</td>
                      </tr>
                    ))}
                  </tbody>
                </STable>
              </div>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.6 }}>
                ※ 이 리포트는 vCenter 가 보관하는 롤업 통계(각 점 = 간격 평균)를 근거로 합니다. 순간 피크는 이보다 높을 수 있으므로 감축은 여유(headroom)를 두고, 적용 후 같은 리포트로 재확인하세요. 애플리케이션 요구(벤더 최소 사양·라이선스 vCPU 조건)는 여기 반영되지 않습니다. 참고 문서 링크는 Broadcom 이관 이후 주소가 바뀔 수 있으니 열리지 않으면 제목으로 검색하세요.
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
