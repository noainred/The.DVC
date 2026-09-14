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
// v2.481: 디스크 섹션에 게스트 디스크 사용량(guest.disk 수집·추이)을 함께 보인다(사용자 요청) — 표기는 게스트 디스크 상세와 동일 유틸.
import { fmtSize, resolveUnit, UNIT_DIV, trendLabel, toRows, TrendChart } from './GuestDiskDetailModal.jsx';
// v2.510: 'Local + vCenter' 템플릿 — 포탈 실시간(20초) 스파이크 수집 섹션. 기존 템플릿은 'vCenter Only' 로 이름만 붙고 수치·산정은 불변.
import RightsizeLocal from './RightsizeLocal.jsx';
import { TEMPLATES, localPhaseText, fmtSec, coverageText } from '../vmSeriesText.js';

/** 게스트 디스크 응답을 PDF 블록으로(게스트 디스크 상세 PDF 와 같은 구성, 파티션별 차트는 생략). */
function guestDiskBlocks(gd, days) {
  if (!gd) return [];
  const maxGB = Math.max(gd.allocGB || 0, ...(gd.partitions || []).map((p) => p.capGB || 0));
  const u = resolveUnit('auto', maxGB); const div = UNIT_DIV[u]; const size = (g) => fmtSize(g, u);
  const vt = gd.vmTrend;
  return [
    { type: 'kvrow', items: [
      { k: '게스트 할당', v: size(gd.allocGB) }, { k: '게스트 사용', v: size(gd.usedGB) }, { k: '회수 가능(여유)', v: size(gd.freeGB), color: 'green' },
      { k: '사용률', v: gd.ratioPct == null ? '—' : `${gd.ratioPct}%`, sub: '사용 / 할당' }, { k: '파티션 수', v: String((gd.partitions || []).length) },
      { k: '전체 사용량 추이', v: `${trendLabel(vt?.trend).label}${vt?.growthGBPerDay != null ? ` (${vt.growthGBPerDay > 0 ? '+' : ''}${vt.growthGBPerDay} GB/일)` : ''}`, sub: vt?.spanDays ? `관측 ${vt.spanDays}일` : '표본 부족' },
    ] },
    { type: 'linechart', title: `게스트 총 사용량 추이 (최근 ${days}일)`, unitLabel: u, refY: gd.allocGB != null ? gd.allocGB / div : null, refLabel: '할당', points: (gd.vmTrendSeries || []).map((p) => ({ t: p.ts, v: p.usedGB / div })) },
    { type: 'table', columns: [
      { label: '파티션', w: 2.6 }, { label: '할당', align: 'right', w: 1 }, { label: '사용', align: 'right', w: 1 }, { label: '여유', align: 'right', w: 1 },
      { label: '사용률', align: 'right', w: 0.9 }, { label: '증가율(GB/일)', align: 'right', w: 1.2 }, { label: '관측기간', align: 'right', w: 0.9 }, { label: '추이', w: 0.8 }, { label: '판정', w: 1.6 },
    ], rows: (gd.partitions || []).map((p) => {
      const rp = p.capGB > 0 ? Math.round((p.usedGB / p.capGB) * 1000) / 10 : null;
      return [{ text: p.path }, { text: size(p.capGB), align: 'right' }, { text: size(p.usedGB), align: 'right' }, { text: size(p.freeGB), align: 'right', color: 'green' },
        { text: rp == null ? '—' : `${rp}%`, align: 'right' }, { text: p.trend?.growthGBPerDay == null ? '—' : String(p.trend.growthGBPerDay), align: 'right' },
        { text: p.trend?.spanDays ? `${p.trend.spanDays}일` : '—', align: 'right' }, { text: trendLabel(p.trend?.trend).label }, { text: p.advice?.label || '—' }];
    }) },
    { type: 'note', text: `게스트 디스크는 VMware Tools guest.disk 를 엣지가 주기 수집한 값(최신 ${gd.ts ? new Date(gd.ts).toLocaleString('ko-KR') : '—'})입니다. 여유(회수 가능)는 게스트 관점의 회수 상한이며 실제 회수는 디스크 축소(shrink)+UNMAP 이 필요합니다. 추이는 변경분만 저장하므로 표본 2점 미만이면 증가율을 계산하지 않습니다.` },
  ];
}

const DAYS = [7, 30, 90, 180, 365];
// 90일 초과는 vCenter 'year' 롤업(86400초=1일 샘플, 1년 보관)에서 조회한다. 탭 이름은 조회 일수 그대로(180일·365일, v2.481 사용자 요청).
const dayLabel = (d) => `${d}일`;
// 관측 기간 부제 — 실제 데이터 범위(표본 구간 포함)와 첫~마지막 롤업 시각. 요청 창보다 짧으면 최신 롤업 미발행·보관 경계 때문이다.
const dataRange = (w, fmt) => (w?.firstTs ? `데이터 ${w.coverageDays ?? 0}일 · ${fmt(w.firstTs)} ~ ${fmt(w.lastTs)}` : '데이터 없음');
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
// v2.510: 'Local + vCenter' 템플릿에서 두 출처를 구분하는 배지 — vCenter 섹션은 이 배지, Local 섹션은 자기 배지.
const VC_BADGE = <span className="badge gray" style={{ fontSize: 10, marginLeft: 6, verticalAlign: 'middle' }} title="vCenter 가 보관하는 롤업 통계(각 점 = 간격 평균)">vCenter 롤업</span>;

/** PDF 용 Local 섹션 블록(v2.510) — 표시 값만(산정 미반영). */
function localBlocks(local, r) {
  if (!local) return [];
  const t = localPhaseText(local, { settings: local.settings });
  const blocks = [{ type: 'heading', text: `Local — 포탈 실시간 20초 수집 (${t.short})${local.synthesized ? ' · 데모(mock) 합성' : ''}` }];
  if (local.available === false || local.empty) { blocks.push({ type: 'note', text: t.long }); return blocks; }
  const p = local.peak || {}; const c = local.coverage || {};
  const g = (mhz) => (mhz == null ? '—' : `${(mhz / 1000).toFixed(2)} GHz`); const m = (mb) => (mb == null ? '—' : `${(mb / 1024).toFixed(1)} GB`);
  blocks.push({ type: 'kvrow', items: [
    { k: '20초 최대 CPU', v: g(p.cpuUsageMhz?.v), sub: p.cpuUsagePct ? `${p.cpuUsagePct.v}%` : '' },
    { k: '스파이크 횟수', v: `${local.runs?.count ?? 0}회`, sub: `하루 평균 ${local.runs?.perDay ?? 0}회` },
    { k: '최장 지속', v: fmtSec(local.runs?.maxSec), sub: `합계 ${fmtSec(local.runs?.totalSec)}` },
    { k: 'Ready 최대(vCPU당)', v: p.cpuReadyPct ? `${p.cpuReadyPct.v}%` : '—' },
    { k: '20초 최대 Active', v: m(p.memActiveMB?.v) },
    { k: '커버리지', v: `${c.pct ?? 0}%`, sub: `관측 ${c.measuredHours ?? 0}/${c.expectedHours ?? 0}시간` },
  ] });
  const freq = (local.freq || []).map((f) => ({ t: f.t, v: f.measured ? f.runs : null })).filter((f) => f.v != null);
  if (freq.length) blocks.push({ type: 'linechart', title: `스파이크 빈도 (${local.bucketMs >= 86_400_000 ? '일' : '시간'}당 run 횟수 · 미측정 구간 제외)`, unitLabel: '회', points: freq });
  blocks.push({ type: 'note', text: `${coverageText(c)} 저장 기준은 임계 이상 순간만이며 각 표본은 20초 평균입니다. 권고 vCPU/메모리 산정은 vCenter 롤업 기준이고 이 섹션은 표시·경고용입니다.${r?.cpu?.used?.max != null && p.cpuUsageMhz?.v != null ? ` 20초 최대는 롤업 최대(${g(r.cpu.used.max)})의 ${(p.cpuUsageMhz.v / r.cpu.used.max).toFixed(2)}배입니다.` : ''}` });
  return blocks;
}

/** 벡터 PDF 문서 모델 — 화면과 같은 내용을 글자·도형으로(reportExport.saveDocAsPdf). */
function buildRightsizeDoc(r, vm, days, gd = null, local = null, template = 'vcenter') {
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
    { k: '관측 기간', v: `${w.days ?? days}일`, sub: dataRange(w, (t) => new Date(t).toLocaleDateString()) },
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
  if (template === 'both') blocks.push(...localBlocks(local, r));
  blocks.push({ type: 'heading', text: `메모리 — ${mMB(mem.allocMB)} 할당${mem.recommendedMB != null ? ` · 권장 ${mMB(mem.recommendedMB)}${mem.reductionPct > 0 ? ` (${mem.reductionPct}%)` : ' (변경 없음)'}` : ''}` });
  const memCell = (s, rtc) => { const has = s && (s.avg != null || s.max != null); if (has) return { avg: mMB(s.avg), p95: mMB(s.p95), max: mMB(s.max), rt: false }; if (rtc) return { avg: mMB(rtc.avg), p95: '—', max: mMB(rtc.max), rt: true }; return { avg: '—', p95: '—', max: '—', rt: false }; };
  const memRow = (label, mean, s, rtc, note) => { const c = memCell(s, rtc); return [
    { text: label }, { text: mean }, { text: c.avg + (c.rt ? ' (실시간)' : ''), align: 'right', color: c.rt ? 'blue' : 'text' }, { text: c.p95, align: 'right' }, { text: c.max, align: 'right' }, { text: c.rt ? '이력 없음 · 실시간(최근 1시간) 현재값' : note },
  ]; };
  blocks.push({ type: 'table', columns: [
    { label: '계열', w: 1 }, { label: '의미', w: 2.5 }, { label: '평균', align: 'right', w: 1 }, { label: 'p95', align: 'right', w: 1 }, { label: '최대', align: 'right', w: 1 }, { label: '해석', w: 2.4 },
  ], rows: [
    memRow('Active', '게스트가 실제로 만지는 메모리(워킹셋)', mem.active, rt.memActiveMB, mem.memBasis === 'consumed' ? '감축 하한 후보 ①' : '산정 기준(워킹셋 최대 × 여유)'),
    memRow('Consumed', '호스트가 배정한 메모리(캐시 포함)', mem.consumed, rt.memConsumedMB, mem.memBasis === 'consumed' ? '감축 하한 후보 ②' : '참고 — 회수 안 된 과거 터치 페이지, 필요량 근거 아님'),
    memRow('Balloon', '벌룬 회수(>0=호스트 압박)', mem.balloon, rt.memBalloonMB, mem.balloon?.samplesAbove0 ? `${mem.balloon.pctTime}% 에서 0 초과 → 보류` : '관측 없음 → 정상'),
    memRow('Swapped', '호스트 스왑(>0=심각한 압박)', mem.swapped, rt.memSwappedMB, mem.swapped?.samplesAbove0 ? `${mem.swapped.pctTime}% 에서 0 초과 → 금지` : '관측 없음 → 정상'),
    [{ text: 'Usage %' }, { text: 'vCenter 사용률(active÷할당)' }, { text: pc(mem.usagePct?.avg), align: 'right' }, { text: pc(mem.usagePct?.p95), align: 'right' }, { text: pc(mem.usagePct?.max), align: 'right' }, { text: String(mem.workingSetSource || '').startsWith('usagePct') ? '워킹셋 복원 출처(최대 × 할당)' : '참고' }],
  ] });
  const memPts = (r.series?.memConsumedMB || []).map((p) => ({ t: Date.parse(p.t), v: p.v == null ? null : p.v / 1024 })).filter((p) => Number.isFinite(p.t) && p.v != null);
  blocks.push({ type: 'linechart', title: 'Consumed 메모리 추이', unitLabel: 'GB', refY: mem.allocMB != null ? mem.allocMB / 1024 : null, refLabel: '할당', points: memPts });
  if (mem.basisNote) blocks.push({ type: 'note', text: `메모리 산정: ${mem.basisNote}` });
  if (mem.skipReason) blocks.push({ type: 'note', text: `• ${mem.skipReason}` });
  if (mem.consumedNote) blocks.push({ type: 'note', text: `• ${mem.consumedNote}` });
  blocks.push({ type: 'heading', text: '디스크' });
  blocks.push({ type: 'kvrow', items: [
    { k: '커밋(실사용) 용량', v: r.disk?.storageGB != null ? `${r.disk.storageGB} GB` : '—' },
    { k: '미커밋(thin 여유)', v: r.disk?.uncommittedGB != null ? `${r.disk.uncommittedGB} GB` : '—', sub: r.disk?.thin ? 'thin 디스크' : 'thick' },
    { k: 'VMware Tools', v: r.disk?.toolsStatus || '—' },
  ] });
  if (gd) blocks.push(...guestDiskBlocks(gd, days));
  else if (r.disk?.note) blocks.push({ type: 'note', text: r.disk.note });
  blocks.push({ type: 'note', text: '이 리포트는 vCenter 롤업 통계(각 점=간격 평균)를 근거로 합니다. 순간 피크는 이보다 높을 수 있으므로 감축은 여유를 두고 적용 후 재확인하세요. 실시간 표시 값은 참고용 현재값이며 다일 감축 하한 계산에는 반영하지 않습니다.' });
  return {
    title: `자원 축소 근거 리포트 — ${vm.name}`,
    subtitle: `${vm.vcenterId} · ${vm.host || ''} · ${vm.guestOS || ''}`,
    meta: `${TEMPLATES.find((t) => t.k === template)?.label || 'vCenter Only'} · 최근 ${dayLabel(days)} · 롤업 ${w.intervalSec}초${r.cached ? ' · 5분 캐시' : ''}${r.synthesized ? ' · 데모(mock)' : ''}`,
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
  // v2.496(사용자 요구): 기본 30일. 기간 선택은 버튼 5개 대신 콤보 박스 — 툴바 공간을 줄이고 줄바꿈 넘침도 예방.
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const sheetRef = useRef(null);          // PDF/JPG 로 저장할 영역(모달 본문 전체)
  const [saving, setSaving] = useState(''); // '' | 'pdf' | 'jpg'
  const [saveErr, setSaveErr] = useState('');
  // v2.481: 게스트 디스크 사용량(guest.disk 수집) — 같은 기간으로 병행 조회. 404 = 이 VM 은 수집 대상 아님(정직하게 '수집 없음').
  const [gd, setGd] = useState({ data: null, none: false, error: '' });
  // v2.510: 템플릿 — 'vcenter'(vCenter Only, 기존 리포트 그대로) | 'both'(Local + vCenter). 로컬 20초 수집은 both 에서만 조회한다.
  const [template, setTemplate] = useState('vcenter');
  const [local, setLocal] = useState({ data: null, error: '' });
  useEffect(() => {
    if (template !== 'both') { setLocal({ data: null, error: '' }); return undefined; }
    let alive = true;
    setLocal({ data: null, error: '' });
    fetchJson(`/tools/vmseries/local?vmId=${encodeURIComponent(vm.id)}&days=${days}`)
      .then((d) => { if (alive) setLocal({ data: d, error: '' }); })
      .catch((e) => { if (alive) setLocal({ data: null, error: e?.message || String(e) }); });
    return () => { alive = false; };
  }, [vm.id, days, template]);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    fetchJson(`/tools/rightsize?vmId=${encodeURIComponent(vm.id)}&days=${days}`)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    setGd({ data: null, none: false, error: '' });
    fetchJson(`/tools/guest-disk/vm/${encodeURIComponent(vm.id)}?days=${days}`)
      .then((d) => { if (alive) setGd({ data: d, none: false, error: '' }); })
      .catch((e) => { if (alive) setGd({ data: null, none: e?.status === 404, error: e?.status === 404 ? '' : (e?.message || String(e)) }); });
    return () => { alive = false; };
  }, [vm.id, days]);

  const r = data;
  const rt = r?.realtime || {};   // 이력 롤업에 안 잡힌 level-2 mem 카운터의 실시간 현재값(참고)
  const st = r ? STATE[r.verdict?.state] || STATE.keep : null;
  const cpuRows = r ? merge(r.series, ['cpuUsageMhz']).map((e) => ({ ...e, alloc: r.cpu.allocMhz })) : [];
  const memRows = r ? merge(r.series, ['memActiveMB', 'memConsumedMB', 'memBalloonMB', 'memSwappedMB']) : [];
  // 게스트 디스크 표시 단위(이 VM 의 최대 할당값 기준, 게스트 디스크 상세와 동일 규칙)
  const gdd = gd.data;
  const gdUnit = gdd ? resolveUnit('auto', Math.max(gdd.allocGB || 0, ...(gdd.partitions || []).map((p) => p.capGB || 0))) : 'GB';
  const gdDiv = UNIT_DIV[gdUnit];
  const gdRows = gdd ? toRows((gdd.vmTrendSeries || []).map((p) => ({ ts: p.ts, usedGB: p.usedGB, capGB: p.allocGB })), gdDiv) : [];
  const gdVt = gdd?.vmTrend;
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
      if (kind === 'pdf') { if (!r) return; await saveDocAsPdf(buildRightsizeDoc(r, vm, days, gd.data, local.data, template), name); }
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
      <div ref={sheetRef} className="modal card" style={{ maxWidth: 1100, width: '96vw', maxHeight: '92vh', overflowY: 'auto', overflowX: 'hidden' }}>
        {/* v2.496: 툴바는 줄바꿈된다. v2.481 에서 기간 버튼이 5개로 늘며 이 줄이 모달 폭을 넘쳐 가로 스크롤이
            생겼고, 그러면 아래 모든 문장이 그 넓은 폭 기준으로 배치되어 '줄바꿈이 안 되는' 것처럼 잘려 보였다
            (v2.475 의 표 셀·섹션 제목 줄바꿈 수정은 이 줄을 다루지 않았다). minWidth:0 은 제목이 길어도 flex 자식이
            내용 폭을 고집하지 않게 하는 표준 처방. */}
        <div className="flex between" style={{ marginBottom: 8, alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
            <b style={{ fontSize: 15 }}>📊 자원 축소 근거 리포트 — {vm.name}</b>
            <span className={`badge ${template === 'both' ? 'blue' : 'gray'}`} style={{ marginLeft: 8, fontSize: 10, verticalAlign: 'middle' }}>{TEMPLATES.find((t) => t.k === template)?.label}</span>
            <div className="muted" style={{ fontSize: 11.5 }}>{vm.vcenterId} · {vm.host} · {vm.guestOS || ''}</div>
          </div>
          {/* data-export-hide: 저장 결과물에는 버튼이 남지 않게 캡처에서 제외한다. */}
          <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }} data-export-hide>
            <button className="tab" style={{ padding: '5px 12px', fontSize: 12 }} disabled={!r || !!saving}
              title="이 리포트 전체를 A4 여러 장 PDF 로 저장합니다(스크롤로 가려진 부분까지 포함)."
              onClick={() => save('pdf')}>{saving === 'pdf' ? '저장 중…' : '⬇ PDF'}</button>
            <button className="tab" style={{ padding: '5px 12px', fontSize: 12 }} disabled={!r || !!saving}
              title="이 리포트 전체를 JPG 이미지 한 장으로 저장합니다."
              onClick={() => save('jpg')}>{saving === 'jpg' ? '저장 중…' : '⬇ JPG'}</button>
            <span style={{ width: 1, height: 18, background: 'rgba(255,255,255,.14)' }} />
            <label className="flex gap" style={{ alignItems: 'center', fontSize: 12 }} title={TEMPLATES.map((t) => `${t.label}: ${t.desc}`).join('\n')}>
              <span className="muted">템플릿</span>
              <select className="select" style={{ padding: '4px 8px', fontSize: 12 }} value={template} onChange={(e) => setTemplate(e.target.value)}>
                {TEMPLATES.map((t) => <option key={t.k} value={t.k}>{t.label}</option>)}
              </select>
            </label>
            <label className="flex gap" style={{ alignItems: 'center', fontSize: 12 }} title="관측 기간 — vCenter 성능 롤업에서 이 기간의 표본을 가져옵니다">
              <span className="muted">관측 기간</span>
              <select className="select" style={{ padding: '4px 8px', fontSize: 12 }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {DAYS.map((d) => <option key={d} value={d}>최근 {dayLabel(d)}</option>)}
              </select>
            </label>
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
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6, color: r.evidence.sufficient ? 'var(--muted)' : '#f87171', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                  {r.evidence.reasons.map((x, i) => <li key={i}>{x}</li>)}
                </ul>
              )}
              <div className="flex gap wrap" style={{ marginTop: 8, gap: 18 }}>
                <Stat k="관측 기간" v={`${r.window.days ?? days}일`} sub={dataRange(r.window, (t) => new Date(t).toLocaleString('ko-KR'))} />
                <Stat k="샘플" v={`${r.window.samples} / ${r.window.expectedSamples}`} sub={`커버리지 ${n1(r.window.coveragePct, '%')} · 간격 ${r.window.intervalSec}초`} />
                <Stat k="정책" v={`여유 ${r.policy.headroomPct}% · 상한 ${r.policy.capReductionPct}%`} sub={`최소 ${r.policy.minDays}일 · 커버리지 ${r.policy.minCoveragePct}% · Ready ${r.policy.readyWarnPct}%`} />
                {r.synthesized && <span className="badge gray" style={{ alignSelf: 'center' }}>데모(mock) 합성 데이터</span>}
                {r.cached && <span className="badge gray" style={{ alignSelf: 'center', fontSize: 10 }}>5분 캐시</span>}
              </div>
            </div>

            {/* CPU */}
            <div className="card" style={{ marginBottom: 10 }}>
              <div className="flex between" style={{ alignItems: 'center', marginBottom: 6, flexWrap: 'wrap', gap: 6 }}>
                <b>CPU — vCPU {r.cpu.vcpu}{r.cpu.allocMhz ? ` (${ghz(r.cpu.allocMhz)} 할당)` : ''}{template === 'both' && VC_BADGE}</b>
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
              {r.cpu.blockers.map((b, i) => <div key={i} style={{ color: '#fbbf24', fontSize: 12.5, marginBottom: 4, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>⚠ {b}</div>)}
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

            {/* v2.510: Local(포탈 실시간 20초) 섹션 — 'Local + vCenter' 템플릿에서만. CPU Ready 차트 바로 아래에 스파이크 빈도를 둔다(사용자 요청 위치). */}
            {template === 'both' && <RightsizeLocal local={local.data} localError={local.error} r={r} days={days} />}

            {/* 메모리 */}
            <div className="card" style={{ marginBottom: 10 }}>
              <div className="flex between" style={{ alignItems: 'center', marginBottom: 6, flexWrap: 'wrap', gap: 6 }}>
                <b>메모리 — {gb(r.mem.allocMB)} 할당{template === 'both' && VC_BADGE}</b>
                {r.mem.recommendedMB != null && (
                  <span className={`badge ${r.mem.ok ? 'green' : r.mem.blockers.length ? 'amber' : 'gray'}`}>
                    권장 {gb(r.mem.recommendedMB)}{r.mem.reductionMB > 0 ? ` (−${gb(r.mem.reductionMB)}, ${r.mem.reductionPct}%)` : ' (변경 없음)'}{r.mem.capped ? ' · 50% 상한 적용' : ''}
                  </span>
                )}
              </div>
              <div className="table-wrap" style={{ marginBottom: 8 }}>
                <STable className="rpt-wrap">
                  <thead><tr><th>계열</th><th>의미</th><th className="right">평균</th><th className="right">p95</th><th className="right">최대</th><th>해석</th></tr></thead>
                  <tbody>
                    {(() => { const c = memCell(r.mem.active, rt.memActiveMB); return (
                      <tr style={c.isRt ? { background: 'rgba(14,165,233,.08)' } : undefined}>
                        <td><b>Active</b></td><td className="muted">게스트가 실제로 만지는 메모리(워킹셋 추정)</td>
                        <td className="right">{c.avg}{c.isRt && RT_TAG}</td><td className="right">{c.p95}</td><td className="right">{c.max}</td>
                        <td className="muted">{c.isRt ? `이력 롤업엔 표본 없음 · 실시간(최근 1시간) 현재값${String(r.mem.workingSetSource || '').includes('realtime') ? ' — 워킹셋 산정에 반영' : ''} — vCenter 통계 레벨 ↑ 시 이력도 쌓임` : r.mem.memBasis === 'consumed' ? '감축 하한 후보 ①' : '산정 기준 — 워킹셋 최대 × 여유'}</td>
                      </tr>); })()}
                    {(() => { const c = memCell(r.mem.consumed, rt.memConsumedMB); return (
                      <tr style={c.isRt ? { background: 'rgba(14,165,233,.08)' } : undefined}>
                        <td><b>Consumed</b></td><td className="muted">호스트가 이 VM 에 실제 배정한 메모리(캐시 포함)</td>
                        <td className="right">{c.avg}{c.isRt && RT_TAG}</td><td className="right">{c.p95}</td><td className="right">{c.max}</td>
                        <td className="muted">{c.isRt ? '이력 롤업엔 표본 없음 · 실시간 현재값' : r.mem.memBasis === 'consumed' ? '감축 하한 후보 ② — active 만 보면 캐시를 빼앗음' : '참고 — ESXi 가 회수하지 않은 과거 터치 페이지(캐시 포함). 필요량 근거 아님'}</td>
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
                    <tr><td><b>Usage %</b></td><td className="muted">vCenter 표시 사용률(active ÷ 할당)</td><td className="right">{n1(r.mem.usagePct.avg, '%')}</td><td className="right">{n1(r.mem.usagePct.p95, '%')}</td><td className="right">{n1(r.mem.usagePct.max, '%')}</td><td className="muted">{String(r.mem.workingSetSource || '').startsWith('usagePct') ? '워킹셋 복원 출처 — active 이력이 없어 최대 × 할당으로 산정' : '참고'}</td></tr>
                  </tbody>
                </STable>
              </div>
              {r.mem.basisMB != null && <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>산정 근거: {r.mem.basisNote} = <b style={{ color: 'var(--text)' }}>{gb(r.mem.basisMB)}</b> → {r.policy.memStepMB} MB 단위 올림 → 권장 <b style={{ color: 'var(--text)' }}>{gb(r.mem.recommendedMB)}</b></div>}
              {r.mem.skipReason && <div className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>ℹ {r.mem.skipReason}</div>}
              {r.mem.consumedNote && <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>ℹ {r.mem.consumedNote}</div>}
              {r.mem.blockers.map((b, i) => <div key={i} style={{ color: '#fbbf24', fontSize: 12.5, marginBottom: 4, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>⚠ {b}</div>)}
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
              {/* v2.481: 게스트 디스크 사용량(guest.disk 수집·추이) — 있으면 붙이고, 없으면 예전처럼 한계를 정직하게 표시 */}
              {gdd ? (
                <div style={{ marginTop: 10 }}>
                  <div className="flex between" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
                    <b style={{ fontSize: 13 }}>게스트 디스크 사용량 (VMware Tools guest.disk · 최근 {days}일)</b>
                    <span className="muted" style={{ fontSize: 11 }}>단위 {gdUnit}{gdd.ts ? ` · 최신 수집 ${new Date(gdd.ts).toLocaleString('ko-KR')}` : ''}</span>
                  </div>
                  <div className="flex gap wrap" style={{ gap: 18, marginTop: 6 }}>
                    <Stat k="게스트 할당" v={fmtSize(gdd.allocGB, gdUnit)} />
                    <Stat k="게스트 사용" v={fmtSize(gdd.usedGB, gdUnit)} />
                    <Stat k="회수 가능(여유)" v={<span style={{ color: '#4ade80' }}>{fmtSize(gdd.freeGB, gdUnit)}</span>} sub="게스트 관점 회수 상한" />
                    <Stat k="사용률" v={gdd.ratioPct == null ? '—' : `${gdd.ratioPct}%`} sub="사용 / 할당" />
                    <Stat k="파티션 수" v={(gdd.partitions || []).length} />
                    <Stat k="전체 사용량 추이"
                      v={<span style={{ color: trendLabel(gdVt?.trend).color }}>{trendLabel(gdVt?.trend).label}{gdVt?.growthGBPerDay != null ? ` (${gdVt.growthGBPerDay > 0 ? '+' : ''}${gdVt.growthGBPerDay} GB/일)` : ''}</span>}
                      sub={gdVt?.spanDays ? `관측 ${gdVt.spanDays}일 · 점 ${gdRows.length}개` : '표본 부족'} />
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <TrendChart rows={gdRows} unitLabel={gdUnit} days={days} capGB={gdd.allocGB != null ? gdd.allocGB / gdDiv : null} height={200} />
                  </div>
                  <div className="table-wrap" style={{ marginTop: 8 }}>
                    <STable className="gd-table rpt-wrap">
                      <thead><tr>
                        <th>파티션</th><th className="gd-num">할당</th><th className="gd-num">사용</th><th className="gd-num">여유</th>
                        <th className="gd-num">사용률</th><th className="gd-num">증가율(GB/일)</th><th className="gd-num">관측기간</th><th>추이</th><th data-nosort>판정</th>
                      </tr></thead>
                      <tbody>
                        {(gdd.partitions || []).map((p) => {
                          const rp = p.capGB > 0 ? Math.round((p.usedGB / p.capGB) * 1000) / 10 : null;
                          return (
                            <tr key={p.path}>
                              <td>{p.path}</td>
                              <td data-sort={p.capGB} className="gd-num">{fmtSize(p.capGB, gdUnit)}</td>
                              <td data-sort={p.usedGB} className="gd-num">{fmtSize(p.usedGB, gdUnit)}</td>
                              <td data-sort={p.freeGB} className="gd-num" style={{ color: '#4ade80' }}>{fmtSize(p.freeGB, gdUnit)}</td>
                              <td data-sort={rp == null ? -1 : rp} className="gd-num">{rp == null ? '—' : `${rp}%`}</td>
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
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.6 }}>
                    여유(회수 가능)는 <b>게스트 관점의 회수 상한</b>입니다. 실제 회수는 디스크 축소(shrink)+UNMAP 이 필요하며 OS·정렬에 따라 전량을 못 줄일 수 있습니다.
                    추이는 변경분만 저장하므로 점 간격이 불규칙하고 표본 2점 미만이면 증가율을 계산하지 않습니다(더 긴 기간 탭으로 확인).
                  </div>
                </div>
              ) : (
                <div className="muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.6 }}>
                  {r.disk.note}
                  {gd.none && <> 이 VM 은 게스트 디스크 수집 데이터가 없습니다(수집 대상 아님·아직 미수집·Tools 미실행). 특수 기능 › 게스트 디스크 회수에서 수집 상태를 확인하세요.</>}
                  {gd.error && <> 게스트 디스크 조회 실패: {gd.error}</>}
                </div>
              )}
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
