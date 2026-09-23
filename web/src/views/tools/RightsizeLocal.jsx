/**
 * RightsizeLocal.jsx — 자원 축소 근거 리포트의 **Local(포탈 실시간 20초 수집)** 섹션(v2.510).
 *
 * 'Local + vCenter' 템플릿에서만 그린다. vCenter 롤업(평균·p95·곡선)은 기존 섹션이 맡고, 여기는
 * 롤업이 파괴하는 값 — **20초 최대 · 임계 이상 순간 · 스파이크 횟수/지속 · 커버리지** — 만 보인다.
 * 산정(권고 vCPU/메모리)에는 쓰지 않는다(문구로 명시). 판정·문구는 views/vmSeriesText.js(순수)가 만든다.
 *
 * 정직 규약: 미측정 시간은 막대 0 이 아니라 회색 음영, 표본 0 은 '스파이크 없음' 이 아니라 '표본 없음',
 * 데모(mock)는 배지. 주기·임계·버퍼 숫자는 서버 응답 값으로만.
 */
import React from 'react';
import { ResponsiveContainer, ComposedChart, BarChart, Bar, Line, Scatter, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine, Legend } from 'recharts';
import { localPhase, localPhaseText, coverageText, coverageCells, thresholdText, historicalIntervalText, peakNote, fmtSec } from '../vmSeriesText.js';

const tip = { background: '#0f172a', border: '1px solid #334155', borderRadius: 8, fontSize: 12 };
const ghz = (mhz) => (mhz == null ? '—' : `${(mhz / 1000).toFixed(2)} GHz`);
const gb = (mb) => (mb == null ? '—' : `${(mb / 1024).toFixed(1)} GB`);
const pc = (x) => (x == null ? '—' : `${x}%`);
const when = (t) => (t ? new Date(t).toLocaleString('ko-KR') : '');
const tick = (t, days) => { const d = new Date(t); return days <= 7 ? `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}시` : `${d.getMonth() + 1}/${d.getDate()}`; };

function Stat({ k, v, sub, color }) {
  return <div style={{ minWidth: 118 }}><div className="muted" style={{ fontSize: 11 }}>{k}</div><div style={{ fontWeight: 700, color }}>{v}</div>{sub && <div className="muted" style={{ fontSize: 10.5, whiteSpace: 'normal' }}>{sub}</div>}</div>;
}

const LOCAL_BADGE = <span className="badge blue" style={{ fontSize: 10 }}>Local · 20초</span>;
// 스파이크 순간 점 — recharts 기본 원(반지름 ~4.5px)은 수백 점에서 선을 덮어 버린다(Chromium 확인). 작은 점 + 반투명.
const Dot = (p) => (p.cx == null || p.cy == null ? null : <circle cx={p.cx} cy={p.cy} r={1.8} fill="#f97316" fillOpacity={0.75} />);

/** 커버리지 띠 — 시간(7일) 또는 일(그 이상) 셀. 0% 는 회색(미측정). */
function CoverageStrip({ hours, days }) {
  const cells = coverageCells(hours, days);
  if (!cells.length) return null;
  return (
    <div style={{ display: 'flex', gap: 1, height: 10, marginTop: 4 }} title="커버리지 띠 — 회색은 관측 표본이 없던 구간(스파이크 0 이 아니라 미측정)">
      {cells.map((c) => (
        <div key={c.t} title={`${new Date(c.t).toLocaleString('ko-KR')} · 커버리지 ${c.pct}%`}
          style={{ flex: 1, minWidth: 1, background: c.pct >= 90 ? '#22c55e' : c.pct > 0 ? '#eab308' : 'rgba(148,163,184,.25)', borderRadius: 1 }} />
      ))}
    </div>
  );
}

export default function RightsizeLocal({ local, localError, r, days }) {
  const phase = localPhase(local);
  const txt = localPhaseText(local, { settings: local?.settings });
  const cpuRows = (r?.series?.cpuUsageMhz || []).map((p) => ({ t: Date.parse(p.t), vc: p.v })).filter((p) => Number.isFinite(p.t) && p.vc != null);
  const memRows = (r?.series?.memActiveMB || []).map((p) => ({ t: Date.parse(p.t), active: p.v })).filter((p) => Number.isFinite(p.t) && p.active != null);
  const pts = (local?.moments || []).map((m) => ({ t: m.t, mhz: m.cpuUsageMhz, cpuPct: m.cpuUsagePct, ready: m.cpuReadyPct, active: m.memActiveMB, memPct: m.memUsagePct })).filter((p) => p.mhz != null || p.active != null);
  const freq = (local?.freq || []).map((f) => ({ ...f, gap: f.measured ? 0 : 1 }));
  const maxRuns = Math.max(1, ...freq.map((f) => f.runs));
  const win = local?.window || {};
  const peak = local?.peak || {};
  const c = local?.coverage;

  return (
    <div className="card" style={{ marginBottom: 10, borderLeft: '4px solid #0ea5e9' }}>
      <div className="flex between" style={{ alignItems: 'center', marginBottom: 6, flexWrap: 'wrap', gap: 6 }}>
        <b>Local — 포탈 실시간 수집(20초 표본, 임계 이상 순간만 저장) {LOCAL_BADGE}</b>
        <span className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
          {local?.synthesized && <span className="badge gray">데모(mock) 합성 데이터</span>}
          <span className={`badge ${phase === 'ok' ? (local?.runs?.count ? 'amber' : 'green') : 'gray'}`}>{txt.short}</span>
        </span>
      </div>

      {localError && <div className="error-box" style={{ margin: '4px 0 8px' }}>로컬 수집 조회 실패: {localError}</div>}
      {!localError && phase !== 'ok' && (
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
          {phase === 'loading' ? '포탈 수집 데이터를 불러오는 중…' : txt.long}
          {phase === 'empty' && c && <div style={{ marginTop: 4 }}>{coverageText(c)}</div>}
        </div>
      )}

      {phase === 'ok' && (
        <>
          <div className="flex gap wrap" style={{ gap: 18, marginBottom: 6 }}>
            <Stat k="20초 최대 CPU" v={ghz(peak.cpuUsageMhz?.v)} sub={peak.cpuUsagePct ? `${pc(peak.cpuUsagePct.v)} · ${when(peak.cpuUsagePct.t)}` : ''} />
            <Stat k="스파이크 횟수" v={`${local.runs.count}회`} sub={`하루 평균 ${local.runs.perDay}회 · 순간 ${local.momentCount.toLocaleString()}개`} color={local.runs.count ? '#fbbf24' : undefined} />
            <Stat k="최장 지속" v={fmtSec(local.runs.maxSec)} sub={`합계 ${fmtSec(local.runs.totalSec)}`} />
            <Stat k="Ready 최대 (vCPU당)" v={pc(peak.cpuReadyPct?.v)} sub={peak.cpuReadyPct ? when(peak.cpuReadyPct.t) : '표본 없음'} color={peak.cpuReadyPct?.v > (r?.policy?.readyWarnPct ?? 5) ? '#f87171' : undefined} />
            <Stat k="20초 최대 Active 메모리" v={gb(peak.memActiveMB?.v)} sub={peak.memUsagePct ? `usage ${pc(peak.memUsagePct.v)}` : ''} />
            <Stat k="벌룬 / 스왑 최대" v={`${gb(peak.memBalloonMB?.v)} / ${gb(peak.memSwappedMB?.v)}`} color={(peak.memBalloonMB?.v > 0 || peak.memSwappedMB?.v > 0) ? '#f87171' : undefined} />
            <Stat k="커버리지" v={pc(c?.pct)} sub={`관측 ${c?.measuredHours ?? 0} / ${c?.expectedHours ?? 0}시간`} color={c?.unmeasuredHours > 0 ? '#fbbf24' : undefined} />
          </div>
          {peak.cpuUsageMhz?.v != null && r?.cpu?.used?.max != null && (
            <div className="muted" style={{ fontSize: 12, marginBottom: 6, whiteSpace: 'normal' }}>ℹ {peakNote(peak.cpuUsageMhz.v, r.cpu.used.max, r.window?.intervalSec)}</div>
          )}

          {/* CPU: vCenter 롤업 선 + 로컬 20초 순간 점 */}
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>사용 MHz — 파란 선 = vCenter 롤업({r?.window?.intervalSec == null ? '간격 미상' : `${r.window.intervalSec}초 평균`}) · 주황 점 = 로컬 20초 표본 중 임계 이상 순간{local.downsampled ? ` (점이 많아 구간별 최대만 ${local.moments.length}개 표시)` : ''}</div>
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={cpuRows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#243049" />
                <XAxis dataKey="t" type="number" domain={[win.start || 'dataMin', win.end || 'dataMax']} stroke="#8b9bb4" fontSize={11} minTickGap={50} tickFormatter={(t) => tick(t, days)} />
                <YAxis stroke="#8b9bb4" fontSize={11} width={60} domain={[0, (max) => Math.max(max, r?.cpu?.allocMhz || 0)]} tickFormatter={(v) => `${(v / 1000).toFixed(1)}G`} />
                <Tooltip contentStyle={tip} labelFormatter={(t) => when(t)} formatter={(v, k) => [ghz(v), k === 'vc' ? 'vCenter 롤업' : '로컬 20초']} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="vc" name="vCenter 롤업" stroke="#3b82f6" strokeWidth={1.4} dot={false} isAnimationActive={false} connectNulls />
                <Scatter data={pts} dataKey="mhz" name="로컬 20초 순간" fill="#f97316" shape={Dot} isAnimationActive={false} />
                {r?.cpu?.allocMhz && <ReferenceLine y={r.cpu.allocMhz} stroke="#64748b" strokeDasharray="4 4" label={{ value: `할당 ${ghz(r.cpu.allocMhz)}`, fill: '#94a3b8', fontSize: 11, position: 'insideTopRight' }} />}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* 스파이크 빈도 — 미측정 버킷은 회색 음영 */}
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>스파이크 빈도 — {local.bucketMs >= 86_400_000 ? '일' : '시간'}당 임계 이상 연속 구간(run) 횟수. 회색 = 그 구간에 관측 표본이 없었음(스파이크 0 이 아니라 미측정).</div>
          <div style={{ height: 130, marginTop: 2 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={freq} margin={{ top: 4, right: 16, left: 0, bottom: 0 }} barCategoryGap={1}>
                <CartesianGrid strokeDasharray="3 3" stroke="#243049" />
                <XAxis dataKey="t" stroke="#8b9bb4" fontSize={10} minTickGap={50} tickFormatter={(t) => tick(t, days)} />
                <YAxis stroke="#8b9bb4" fontSize={10} width={60} allowDecimals={false} domain={[0, maxRuns]} />
                <Tooltip contentStyle={tip} labelFormatter={(t) => when(t)} formatter={(v, k, p) => {
                  if (k === 'gap') return [p?.payload?.measured ? '' : '미측정', '관측'];
                  const f = p?.payload || {};
                  return [`${f.runs}회 · 순간 ${f.moments} · 최장 ${fmtSec(f.maxSec)} · CPU 최대 ${pc(f.maxCpuPct)}`, '스파이크'];
                }} />
                <Bar dataKey="gap" stackId="s" fill="rgba(148,163,184,.28)" isAnimationActive={false} />
                <Bar dataKey="runs" stackId="s" fill="#f97316" isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <CoverageStrip hours={c?.hours || []} days={days} />
          <div className="muted" style={{ fontSize: 11.5, marginTop: 4, whiteSpace: 'normal' }}>{coverageText(c)}</div>

          {/* 메모리: vCenter Active 선 + 로컬 순간 점 */}
          {(memRows.length > 0 || pts.some((p) => p.active != null)) && (
            <>
              <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>Active 메모리 — 청록 선 = vCenter 롤업(이력에 없으면 선 없음) · 주황 점 = 로컬 20초 순간의 mem.active</div>
              <div style={{ height: 180 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={memRows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#243049" />
                    <XAxis dataKey="t" type="number" domain={[win.start || 'dataMin', win.end || 'dataMax']} stroke="#8b9bb4" fontSize={11} minTickGap={50} tickFormatter={(t) => tick(t, days)} />
                    <YAxis stroke="#8b9bb4" fontSize={11} width={60} domain={[0, (max) => Math.max(max, r?.mem?.allocMB || 0)]} tickFormatter={(v) => `${(v / 1024).toFixed(0)}G`} />
                    <Tooltip contentStyle={tip} labelFormatter={(t) => when(t)} formatter={(v, k) => [gb(v), k === 'active' ? 'vCenter Active' : '로컬 Active']} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="active" name="vCenter Active" stroke="#22d3ee" strokeWidth={1.4} dot={false} isAnimationActive={false} connectNulls />
                    <Scatter data={pts.filter((p) => p.active != null)} dataKey="active" name="로컬 20초 Active" fill="#f97316" shape={Dot} isAnimationActive={false} />
                    {r?.mem?.allocMB > 0 && <ReferenceLine y={r.mem.allocMB} stroke="#64748b" strokeDasharray="4 4" label={{ value: `할당 ${gb(r.mem.allocMB)}`, fill: '#94a3b8', fontSize: 11, position: 'insideTopRight' }} />}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </>
      )}

      <div className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.6, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
        ※ 저장 기준: {thresholdText(local?.thresholds)} — 임계 미만 순간은 저장하지 않으므로 평균·p95 는 vCenter 롤업 섹션이 맡습니다. 각 표본은 <b>20초 평균</b>이라 그보다 짧은 스파이크는 희석됩니다(1초 100% 는 20초 표본에서 5%). 임계를 바꿔도 과거는 재계산되지 않습니다.
        {local?.settings && <> · 수집 주기 {local.settings.intervalMin}분 · 보존 {local.settings.retentionDays}일{local.lastPollAt ? ` · 마지막 수집 ${when(local.lastPollAt)}` : ''}</>}
        <br />{historicalIntervalText(local?.historicalInterval)}
      </div>
    </div>
  );
}
