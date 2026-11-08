/**
 * 함대 보기 ‘전력 · 온도’(리눅스 성능 8b단계 ㉒ · 설계 PROFILES §20 · 아트보드 Power).
 * ⚠ 합계 · 피크 · 여유 · 걸림 · 미측정 사유는 서버(bmusage/powerAgg.js)가 계산 — 여기는 그리기 · 거르기만(웹이 다시 합하지 않는다).
 * ⚠ 조회는 보기를 고를 때 1회 + ‘다시 읽기’(폴링 없음 — 서버가 함대 계산을 60초 공유). 랙을 누르면 그 랙 서버(한 번 더 조회).
 */
import React, { useState } from 'react';
import { fetchJson } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { toneVar } from './toneVar.js';
import { unitText } from '../unitText.js';
import { OpsError, useOpsLoad } from './BmTuningTab.jsx';
import { powerCards, kwText, kwhText, wText, cText, marginText, capText, capTitle, fanText, trendPath, hourText, unmeasuredText, POWER_HONEST, UNMEASURED_TEXT, judgeTitle, hasNoJudge, noJudgeText } from './bmPowerText.js';

/** 알림 판정 노드가 없으면 칸 아래 한 줄(이유는 마우스 설명 — 반증 n2 F4). */
const NoJudge = ({ x }) => (hasNoJudge(x) ? <div className="bmo-sub" title={judgeTitle(x)} style={{ color: 'var(--amber)' }}>알림 판정 없음</div> : null);
import './bmOps.css';
import './bmMaint.css';

function Trend({ trend, label }) {
  const p = trendPath(trend);
  if (!p.line && !p.partial.length) return <p className="bmo-note">시간 롤업이 없습니다(0 으로 그리지 않습니다).</p>;
  return (
    <div className="bmc-chart">
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label={label} style={{ width: '100%', height: 90 }}>
        <path d={p.line} fill="none" stroke="var(--accent-2)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        {p.partial.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="3" fill="none" stroke="var(--text-faint)" vectorEffect="non-scaling-stroke"><title>부분 시간(측정 서버 일부만 — 피크에서 뺌)</title></circle>)}
      </svg>
      <div className="bmc-axis"><span>{hourText(trend?.[0]?.t)}</span><span>최대 {kwText(p.max)} · 최소 {kwText(p.min)} · 빈 원 = 부분 시간</span><span>{hourText(trend?.at?.(-1)?.t)}</span></div>
    </div>
  );
}

export function PowerFleetView({ resp, onOpen, onReload, loading = false }) {
  const [rack, setRack] = useState(null);
  const [rs, setRs] = useState(null);
  const f = resp?.fleet || {};
  const cfg = resp?.cfg || {};
  const openRack = async (r) => {
    const id = `${r.vcenterId}|${r.rack}`;
    setRack(id); setRs({ loading: true });
    try { const x = await fetchJson('/tools/bm-usage/power', { rack: id }, undefined, { timeoutMs: 60_000 }); setRs({ rows: x?.rackServers?.rows || [], notTarget: x?.rackServers?.notTarget || 0 }); }
    catch (e) { setRs({ err: e?.message || '읽지 못했습니다' }); }
  };
  const binMax = Math.max(1, ...(resp?.bins || []).map((b) => b.n));
  return (
    <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <div className="bmo-kpis">
        {powerCards(f, cfg).map((c) => (
          <div key={c.k} className="bmo-kpi"><div className="bmo-k">{c.label}</div><div className="bmo-kv">{c.value}</div><div className="bmo-sub">{c.sub}</div></div>
        ))}
      </div>
      {resp?.addressHidden && <p className="bmo-sub">관리자 판본이 아닙니다 — 주소인 서버 이름은 가림 토큰으로 보입니다.</p>}
      {noJudgeText(f.noJudge) ? <p className="bmo-sub" style={{ color: 'var(--amber)' }}>{noJudgeText(f.noJudge)}</p> : null}
      {resp?.capOldEdge ? <p className="bmo-sub">엣지 위임 서버 {resp.capOldEdge}대의 PowerCap 은 확인할 수 없습니다 — 그 엣지가 서버별 상한을 싣기 전 판입니다{resp.capMinEdgeVersion ? `(엣지 v${resp.capMinEdgeVersion} 이상)` : ''}. 그 서버의 걸림은 판정하지 않습니다.</p> : null}
      <section className="bmo-card">
        <h5 className="bmo-h">법인별 — 측정분 합 <span className="bmo-sub">(함대 원천 모으기 {unitText(resp?.gatherMs, 'ms')} · 60초 공유)</span></h5>
        <div className="bmo-bar"><button className="btn btn-sm" onClick={onReload} disabled={loading}>{loading ? '읽는 중…' : '다시 읽기'}</button></div>
        <STable minWidth={980} className="bmo-t" style={{ fontSize: 12 }}>
          <thead><tr><th>법인</th><th className="right">서버</th><th className="right">지금</th><th className="right">24h 평균</th><th className="right">24h 피크</th><th className="right">24h kWh</th><th className="right">월 누적</th><th>미측정</th><th className="right">흡기 평균/최대</th><th className="right">팬 경고</th></tr></thead>
          <tbody>{(resp?.corps || []).map((c) => (
            <tr key={c.vcenterId}>
              <td data-sort={c.vcenterId}>{c.vcenterId || '—'}</td><td className="right" data-sort={c.servers}>{c.servers}</td>
              <td className="right" data-sort={c.nowKw ?? ''}>{kwText(c.nowKw)}</td><td className="right" data-sort={c.avg24Kw ?? ''}>{kwText(c.avg24Kw)}</td>
              <td className="right" data-sort={c.peak24Kw ?? ''} title={c.peak24At ? hourText(c.peak24At) : ''}>{kwText(c.peak24Kw)}</td>
              <td className="right" data-sort={c.kwh24 ?? ''}>{kwhText(c.kwh24)}</td><td className="right" data-sort={c.kwhMonth ?? ''}>{kwhText(c.kwhMonth)}</td>
              <td className="bmo-wrap" data-sort={c.unmeasuredN}>{c.unmeasuredN ? unmeasuredText(c.unmeasured) : '—'}</td>
              <td className="right" data-sort={c.inletMax ?? ''}>{c.inletAvg == null ? '—' : `${c.inletAvg} / ${c.inletMax}`}</td>
              <td className="right" data-sort={c.fanWarn}>{c.fanWarn || '—'}</td>
            </tr>))}</tbody>
        </STable>
      </section>
      <section className="bmo-card">
        <h5 className="bmo-h">랙별 — 여유 적은 순 <span className="bmo-sub">(랙 {resp?.racksConfigured ?? 0}개 설정 · 랙을 누르면 서버)</span></h5>
        <STable minWidth={1040} className="bmo-t" style={{ fontSize: 12 }}>
          <thead><tr><th>랙</th><th>법인</th><th className="right">서버</th><th className="right">지금</th><th className="right">24h 평균</th><th className="right">24h 피크</th><th className="right">상한(설정)</th><th className="right">여유</th><th className="right">흡기 평균/최대</th><th className="right">팬</th></tr></thead>
          <tbody>{(resp?.racks || []).map((r) => (
            <tr key={`${r.vcenterId}|${r.rack}`} className={rack === `${r.vcenterId}|${r.rack}` ? 'bmc-sel' : ''}>
              <td data-sort={r.unmapped ? 'zzz' : r.rack}><span className="bmp-link" role="button" tabIndex={0} onClick={() => openRack(r)} onKeyDown={(e) => { if (e.key === 'Enter') openRack(r); }}>{r.unmapped ? '미매핑' : r.rack}</span>{r.capKw != null ? <NoJudge x={r} /> : null}</td>
              <td data-sort={r.vcenterId}>{r.vcenterId || '—'}</td><td className="right" data-sort={r.servers}>{r.servers}{r.unmeasuredN ? <span className="bmo-sub"> (미측정 {r.unmeasuredN})</span> : null}</td>
              <td className="right" data-sort={r.nowKw ?? ''}>{kwText(r.nowKw)}</td><td className="right" data-sort={r.avg24Kw ?? ''}>{kwText(r.avg24Kw)}</td><td className="right" data-sort={r.peak24Kw ?? ''}>{kwText(r.peak24Kw)}</td>
              <td className="right" data-sort={r.capKw ?? ''}>{r.capKw == null ? (r.unmapped ? '—' : '미설정') : kwText(r.capKw)}</td>
              <td className="right" data-sort={r.marginPct ?? ''} style={{ color: toneVar(r.low === true ? 'bad' : 'idle') }} title={r.marginPartial ? '미측정 서버가 있어 부분 합으로 여유를 판정하지 않습니다' : undefined}>{marginText(r)}</td>
              <td className="right" data-sort={r.inletMax ?? ''}>{r.inletAvg == null ? '—' : `${r.inletAvg} / ${r.inletMax}`}</td>
              <td className="right" data-sort={r.fanWarn}>{r.fanWarn || '—'}</td>
            </tr>))}</tbody>
        </STable>
        {rack && (
          <div className="bmo-band" style={{ marginTop: 8 }}>
            <div className="bmo-k">{rack.split('|').slice(1).join('|') || '미매핑'} — 서버(U 순 · 전력 · 온도)</div>
            {rs?.loading && <p className="bmo-note">읽는 중…</p>}
            {rs?.err && <p className="bmo-note" style={{ color: toneVar('bad') }}>{rs.err}</p>}
            {rs?.notTarget ? <p className="bmo-note">배치에는 있으나 대상 목록에 없는 서버 {rs.notTarget}대(이름 생략 — 미측정으로 세어 이 랙은 일부만 측정)</p> : null}
            {rs?.rows && (
              <STable minWidth={860} className="bmo-t" style={{ fontSize: 12 }}>
                <thead><tr><th>서버</th><th className="right">U</th><th className="right">지금 W</th><th className="right">24h 평균</th><th className="right">흡기</th><th className="right">최대(CPU/배기)</th><th>상한</th><th>팬</th></tr></thead>
                <tbody>{rs.rows.map((s) => (
                  <tr key={s.key}>
                    <td data-sort={s.name}><span className="bmp-link" role="button" tabIndex={0} onClick={() => onOpen?.(s.key, s.vcenterId)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen?.(s.key, s.vcenterId); }}>{s.name}</span><NoJudge x={s} /></td>
                    <td className="right" data-sort={s.u ?? ''}>{s.u ?? '—'}</td>
                    <td className="right" data-sort={s.w ?? ''}>{s.w == null ? (UNMEASURED_TEXT[s.unmeasured] || '—') : wText(s.w)}</td>
                    <td className="right" data-sort={s.avg24W ?? ''}>{wText(s.avg24W)}</td>
                    <td className="right" data-sort={s.inletC ?? ''}>{cText(s.inletC)}</td><td className="right" data-sort={s.maxC ?? ''}>{cText(s.maxC)}</td>
                    <td data-sort={s.capPct ?? ''} title={capTitle(s)}>{capText(s, cfg, resp?.capMinEdgeVersion)}</td><td data-sort={fanText(s)}>{fanText(s)}</td>
                  </tr>))}</tbody>
              </STable>
            )}
          </div>
        )}
      </section>
      <section className="bmo-card">
        <h5 className="bmo-h">24h 전력 추이 — 보이는 범위 합(시간 평균)</h5>
        <Trend trend={f.trend || []} label="24시간 전력 추이" />
      </section>
      <section className="bmo-card">
        <h5 className="bmo-h">흡기 온도 분포 — {f.inletServers ?? 0}대(지금 값)</h5>
        <div className="bmw-bins">
          {f.inletBelow ? <div className="bmw-bin"><div className="bmw-bar" style={{ height: `${(f.inletBelow / Math.max(binMax, f.inletBelow)) * 60}px` }} /><span>&lt;18 · {f.inletBelow}</span></div> : null}
          {(resp?.bins || []).map((b) => <div key={b.lo} className="bmw-bin"><div className="bmw-bar" style={{ height: `${(b.n / binMax) * 60}px`, background: b.lo >= (cfg.inletWarnC ?? 27) ? 'var(--amber)' : undefined }} /><span>{b.lo}{b.hi == null ? '+' : ''} · {b.n}</span></div>)}
        </div>
      </section>
      <section className="bmo-card">
        <h5 className="bmo-h">더운 서버 · 상한 걸림 — 흡기 ≥ {cfg.inletWarnC ?? 27} °C 또는 PowerCap 걸림(≥ {cfg.capHitPct ?? 98}%)</h5>
        <STable minWidth={940} className="bmo-t" style={{ fontSize: 12 }} limit={200}>
          <thead><tr><th>서버</th><th>랙 · U</th><th className="right">흡기</th><th className="right">최대(CPU/배기)</th><th>팬</th><th className="right">전력 W</th><th>전력 상한</th></tr></thead>
          <tbody>{(resp?.hot || []).map((s) => (
            <tr key={`${s.vcenterId}|${s.key}`}>
              <td data-sort={s.name}><span className="bmp-link" role="button" tabIndex={0} onClick={() => onOpen?.(s.key, s.vcenterId)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen?.(s.key, s.vcenterId); }}>{s.name}</span><div className="bmo-sub">{s.vcenterId}</div><NoJudge x={s} /></td>
              <td data-sort={s.rack || 'zzz'}>{s.rack ? `${s.rack}${s.u != null ? ` · ${s.u}` : ''}` : '미매핑'}</td>
              <td className="right" data-sort={s.inletC ?? ''} style={{ color: toneVar(s.inletC != null && s.inletC >= (cfg.inletWarnC ?? 27) ? 'warn' : 'idle') }}>{cText(s.inletC)}</td>
              <td className="right" data-sort={s.maxC ?? ''}>{cText(s.maxC)}</td><td data-sort={fanText(s)}>{fanText(s)}</td>
              <td className="right" data-sort={s.w ?? ''}>{s.w == null ? (UNMEASURED_TEXT[s.unmeasured] || '—') : wText(s.w)}</td>
              <td data-sort={s.capPct ?? ''} style={{ color: toneVar(s.capHit ? 'bad' : 'idle') }} title={capTitle(s)}>{capText(s, cfg, resp?.capMinEdgeVersion)}</td>
            </tr>))}</tbody>
        </STable>
        {!(resp?.hot || []).length && <p className="bmo-note">기준을 넘은 서버가 없습니다(온도를 못 읽은 서버는 여기 없습니다 — 법인 표의 흡기 칸 · 미측정 수를 보세요).</p>}
      </section>
      {POWER_HONEST.map((x, i) => <p key={i} className="bmo-note"><BoldText text={x} /></p>)}
    </div>
  );
}

export default function BmPowerFleet({ onOpen }) {
  const st = useOpsLoad(() => '/tools/bm-usage/power', 'fleet');
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <OpsError err={st.err} />
      {!st.resp && !st.err && <p className="bmo-note">전력 · 온도를 불러오는 중…</p>}
      {st.resp && <PowerFleetView resp={st.resp} onOpen={onOpen} onReload={st.reload} loading={st.loading} />}
    </div>
  );
}
