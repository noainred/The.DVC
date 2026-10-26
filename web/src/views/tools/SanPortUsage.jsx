import React, { useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import BoldText from '../../components/boldText.jsx';
import { fetchJson, canCsv, downloadFile } from '../../api.js';
import { Loading, ErrorBox, Kpi } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { shortDeviceName, stateLabel } from './sanSwitchPorts.js';
import {
  UNITS, LEVELS, GAP_BG, cellInfo, cellTitle, usageKpis, prevKpiMeta, prevCompareNote, usageChartRows, navInfo, colLabels, rowHasData,
  imbalanceText, idleSummary, USAGE_NOTES, usageParams, rateText, pctText, timeText, dayText,
} from './sanPortUsageText.js';

/**
 * 📊 포트 사용량(v2.748 — 시안 A안 개정 2, 사용자 요구 '개별 포트의 피크·평균을 1일/7일/1달로, 이전 기록까지 ·
 * 같은 스토리지로 가는 포트를 모아서 · 포트별/스토리지별 히스토리').
 * 서버(GET /tools/sanswitch/devices/:id/port-usage)가 기간 경계·칸·합산·편중·유휴를 판정하고, 여기는 그린다.
 * 조건을 바꾸면 이전 요청을 끊는다(AbortController — 서버가 아무도 안 볼 집계를 멈춘다). 폴링하지 않는다(무거운 조회 — 버튼으로 새로).
 */
const SEG = () => ({ flex: 'none', padding: '4px 12px' });
const CELL_H = 14;

function Seg({ items, value, onPick, title }) {
  return (
    <div className="flex gap" style={{ flexWrap: 'wrap' }} title={title}>
      {items.map(([k, label]) => (
        <button key={k} className={value === k ? 'login-btn' : 'tab'} style={SEG()} onClick={() => onPick(k)}>{label}</button>
      ))}
    </div>
  );
}

function Cell({ info, title, onClick, selected }) {
  const st = info.kind === 'future'
    ? { border: '1px dashed rgba(148,163,184,.35)', background: 'transparent' }
    : info.kind === 'gap' ? { background: GAP_BG } : { background: info.color };
  return <div title={title} onClick={onClick} style={{ height: CELL_H, minWidth: 0, borderRadius: 2, cursor: onClick ? 'pointer' : 'default', outline: selected ? '1px solid #f8fafc' : 'none', ...st }} />;
}

function Legend2() {
  return (
    <div className="flex gap" style={{ flexWrap: 'wrap', fontSize: 11, alignItems: 'center' }}>
      {LEVELS.map((l) => (
        <span key={l.min} className="flex gap" style={{ alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 10, background: l.color, borderRadius: 2, display: 'inline-block' }} />{l.label}</span>
      ))}
      <span className="flex gap" style={{ alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 10, background: GAP_BG, display: 'inline-block' }} />값 없음</span>
      <span className="flex gap" style={{ alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 10, border: '1px dashed rgba(148,163,184,.6)', display: 'inline-block' }} />아직</span>
      <span className="muted">· 속도를 모르는 포트는 회색</span>
    </div>
  );
}

function HeatRow({ label, sub, cells, capBps, metric, r, starts, onClick, selected, indent }) {
  const labels = colLabels(r);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `minmax(120px, 190px) repeat(${cells.length}, minmax(9px, 1fr))`, gap: 2, alignItems: 'center', marginBottom: 2 }}>
      <div onClick={onClick} title={sub ? `${label} · ${sub}` : label}
        style={{ fontSize: 11, cursor: onClick ? 'pointer' : 'default', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingLeft: indent ? 12 : 0, fontWeight: selected ? 700 : 400, color: selected ? 'var(--accent, #22d3ee)' : undefined }}>
        {label}{sub ? <span className="muted"> {sub}</span> : null}
      </div>
      {cells.map((c, i) => {
        const info = cellInfo(c, { capBps, metric, start: starts[i], now: r.now });
        return <Cell key={i} info={info} onClick={onClick} selected={false}
          title={cellTitle(info, { label: `${label} · ${r.unit === 'd' ? `${labels[i]}시` : labels[i]}`, metric, colMs: r.colMs })} />;
      })}
    </div>
  );
}

export default function SanPortUsage({ deviceId, ports, focusPort, onPickPort }) {
  const [unit, setUnit] = useState('d');
  const [off, setOff] = useState(0);
  const [view, setView] = useState('port');
  const [metric, setMetric] = useState('peak');
  const [target, setTarget] = useState(focusPort ?? null);
  const [withPrev, setWithPrev] = useState(false);
  const [showEmpty, setShowEmpty] = useState(false);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [csvMsg, setCsvMsg] = useState('');
  // 응답에 요청 키를 붙여 두고 키가 맞을 때만 그린다(조건을 바꾼 직후 한 렌더에 이전 조건의 값이 새 조건처럼 보이지 않게).
  const reqKey = JSON.stringify([deviceId, unit, off, view, target, withPrev, reload]);
  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    const key = reqKey;
    fetchJson(`/tools/sanswitch/devices/${deviceId}/port-usage`, usageParams({ unit, off, view, target, prev: withPrev }), ac.signal, { timeoutMs: 90_000, retries: 0 })
      .then((d) => { if (!ac.signal.aborted) setData({ ...d, reqKey: key }); })
      .catch((e) => { if (!ac.signal.aborted) setError({ key, msg: e.message }); });
    return () => ac.abort();
  }, [reqKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const r = data && data.reqKey === reqKey ? data : null;
  const stale = data && !r ? data : null;   // 새 조건을 받는 동안 이전 결과를 흐리게 둔다
  const shown = r || stale;
  const errNow = error && error.key === reqKey ? error.msg : null;
  const t = shown?.target || null;
  const k = usageKpis(t?.chart, t?.capBps);
  // v2.782(점검 K3 I-B2): 진행 중 기간이면 서버가 앞 기간 KPI 를 같은 경과 구간으로 잘라 준다(sameElapsed) — 화면이 그 사실을 밝힌다.
  const kp = withPrev && t?.chart?.prev ? { avg: t.chart.prev.avgMean, peak: t.chart.prev.peakMax, sameElapsed: !!t.chart.prev.sameElapsed } : null;
  const chartRows = useMemo(() => usageChartRows(t?.chart, { capBps: t?.capBps, withPrev }), [t, withPrev]);
  const nav = navInfo(shown || { unit, off, minOff: 0 });
  const starts = shown ? Array.from({ length: shown.cols }, (_, i) => shown.start + i * shown.colMs) : [];
  const slotOf = useMemo(() => {
    const m = new Map((shown?.view === 'port' ? shown.rows : (shown?.rows || []).flatMap((x) => x.memberRows || [])).map((x) => [x.port, x.slotPort]));
    return (p) => m.get(p) ?? p;
  }, [shown]);
  // 조닝 상대 WWN → 이 스위치 포트(스냅샷의 연결 WWN). 없으면 다른 스위치·팹의 상대다.
  const portOfWwn = useMemo(() => {
    const m = new Map();
    for (const p of ports || []) for (const w of p.attached || []) m.set(String(w).toLowerCase(), p);
    return m;
  }, [ports]);
  const pickUnit = (u) => { setUnit(u); setOff(0); };
  const pickView = (v) => { setView(v); setTarget(null); };
  const pickTarget = (v, key) => { setView(v); setTarget(key); };

  const rows = (shown?.rows || []).filter((x) => showEmpty || x.kind === 'storage' || rowHasData(x));
  const hiddenEmpty = (shown?.rows || []).length - rows.length;
  const targetTitle = t ? (t.kind === 'storage' ? `${t.storage} (포트 ${t.members.length})` : `포트 ${t.slotPort}${t.name ? ` · ${shortDeviceName(t.name, 40)}` : ''}`) : '';
  const peakLabel = metric === 'peak' ? '피크' : '평균';

  const csv = () => {
    setCsvMsg('내려받는 중…');
    const q = new URLSearchParams(usageParams({ unit, off, view, target, prev: false })).toString();
    downloadFile(`/tools/sanswitch/devices/${deviceId}/port-usage.csv?${q}`).then((n) => setCsvMsg(`저장: ${n}`)).catch((e) => setCsvMsg(`실패: ${e.message}`));
  };

  return (
    <div style={{ marginBottom: 10, minWidth: 0 }}>
      {/* 도구 줄 — 단위·이전/다음·보기·기준 */}
      <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <Seg items={UNITS} value={unit} onPick={pickUnit} />
        <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="tab" style={SEG()} disabled={nav.prevDisabled} onClick={() => setOff((o) => o - 1)}
            title={nav.prevDisabled ? '1시간 집계 보관 기간의 처음입니다.' : '앞 기간'}>◀ 이전</button>
          <b style={{ fontSize: 13, minWidth: 120, textAlign: 'center' }}>{shown?.label || '…'}</b>
          <button className="tab" style={SEG()} disabled={nav.nextDisabled} onClick={() => setOff((o) => Math.min(0, o + 1))}>다음 ▶</button>
          <button className="tab" style={SEG()} disabled={off === 0} onClick={() => setOff(0)}>{nav.todayText}</button>
        </div>
        <Seg items={[['port', '포트별'], ['storage', '스토리지별']]} value={view} onPick={pickView}
          title="스토리지별은 같은 어레이(이름 앞 두 마디가 같은 연결 장비)로 가는 포트를 묶어 합산합니다." />
        <Seg items={[['peak', '피크'], ['avg', '평균']]} value={metric} onPick={setMetric} />
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 12, gap: 4 }}>
          <input type="checkbox" checked={withPrev} onChange={(e) => setWithPrev(e.target.checked)} />앞 기간 겹쳐 보기
        </label>
        <button className="tab" style={SEG()} onClick={() => setReload((x) => x + 1)} title="같은 조건으로 다시 조회합니다(자동 갱신하지 않습니다).">🔄 새로</button>
        {canCsv() && <button className="tab" style={SEG()} onClick={csv} title="지금 보기·단위·기간의 히스토리 칸을 CSV 로 받습니다. 값 없는 칸은 0 이 아니라 빈 값입니다.">⬇ CSV</button>}
        {csvMsg && <span className="muted" style={{ fontSize: 11.5 }}>{csvMsg}</span>}
      </div>

      {errNow && <ErrorBox message={errNow} />}
      {!errNow && !shown && <Loading />}
      {shown && (
        <div style={{ opacity: stale ? 0.55 : 1, transition: 'opacity .15s' }}>
          {shown.demo && <div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>데모(mock) 데이터 — 수식으로 만든 값입니다.</div>}
          {!t && <div className="card muted" style={{ fontSize: 13 }}>{view === 'storage' ? '이 스위치에서 스토리지(어레이)로 분류된 연결 장비가 없습니다 — 포트별로 보세요.' : '이 스위치의 포트 목록·사용량 데이터가 없습니다.'}</div>}
          {t && (
            <>
              <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 6 }}>
                <b style={{ fontSize: 14, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }} title={t.name}>{targetTitle}</b>
                <span className="muted" style={{ fontSize: 12 }}>
                  {t.kind === 'port' ? `속도 ${t.speed || '모름'}` : `회선 합 ${t.capBps == null ? '모름(속도 모르는 멤버 있음)' : rateText(t.capBps)}`}
                  {' · '}{shown.unit === 'd' ? (t.chart?.bucketMs === 900_000 ? '15분 칸' : '1시간 칸(15분 집계 보관 기간이 지난 날)') : '1시간 칸'}
                  {t.chart?.partial ? ` · 멤버 일부만 있는 칸 ${t.chart.partial}개는 비움` : ''}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 8 }}>
                <Kpi label="평균" value={rateText(k.avg)} meta={kp ? prevKpiMeta(k.avg, kp.avg, { sameElapsed: kp.sameElapsed }) : '칸 평균들의 평균'} />
                <Kpi label="피크" value={rateText(k.peak)} meta={kp ? prevKpiMeta(k.peak, kp.peak, { sameElapsed: kp.sameElapsed }) : '수집 시점들 중 최댓값'} />
                <Kpi label="피크 포화도" value={pctText(k.peakPct)} meta={t.capBps == null ? '속도를 몰라 판정하지 않습니다' : `회선 ${rateText(t.capBps)} 대비`}
                  accent={k.peakPct != null && k.peakPct >= 80 ? '#ea580c' : undefined} />
                <Kpi label="피크 시각" value={k.peakAt == null ? '—' : timeText(k.peakAt, shown.offsetMin)} meta={shown.label} />
              </div>
              {kp && prevCompareNote(t.chart.prev) && (
                <div className="muted" style={{ fontSize: 11.5, marginTop: -4, marginBottom: 8 }}><BoldText text={prevCompareNote(t.chart.prev)} /></div>
              )}
              <div className="card" style={{ padding: 8, marginBottom: 8, minWidth: 0 }}>
                <ResponsiveContainer width="100%" height={240}>
                  <ComposedChart data={chartRows} margin={{ top: 4, right: 12, bottom: 4, left: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                    <XAxis dataKey="ts" fontSize={11} minTickGap={28}
                      tickFormatter={(v) => (shown.unit === 'd' ? timeText(v, shown.offsetMin).slice(6) : dayText(v, shown.offsetMin))} />
                    <YAxis tickFormatter={(v) => rateText(v)} fontSize={11} width={78} />
                    <Tooltip labelFormatter={(v) => timeText(v, shown.offsetMin)} formatter={(v, n) => [rateText(v), n]} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Area type="monotone" dataKey="avg" name="평균" stroke="#22d3ee" fill="#22d3ee" fillOpacity={0.18} connectNulls={false} isAnimationActive={false} dot={false} />
                    <Line type="monotone" dataKey="peak" name="피크" stroke="#f59e0b" strokeWidth={1.4} dot={false} connectNulls={false} isAnimationActive={false} />
                    {t.capBps != null && <Line type="monotone" dataKey="cap" name="회선 속도" stroke="#ef4444" strokeDasharray="6 4" dot={false} isAnimationActive={false} />}
                    {withPrev && t.chart?.prev && <Line type="monotone" dataKey={metric === 'peak' ? 'prevPeak' : 'prevAvg'} name={`앞 기간 ${peakLabel}`} stroke="#94a3b8" strokeDasharray="3 3" dot={false} connectNulls={false} isAnimationActive={false} />}
                  </ComposedChart>
                </ResponsiveContainer>
                {withPrev && !t.chart?.prev && <div className="muted" style={{ fontSize: 11 }}>앞 기간이 보관 기간 밖이라 겹쳐 볼 값이 없습니다.</div>}
              </div>

              {t.kind === 'storage' && t.memberRows && (
                <div className="card" style={{ padding: 8, marginBottom: 8 }}>
                  <div className="muted" style={{ fontSize: 11.5, marginBottom: 4 }}>멤버 포트 몫 — 이 기간 평균 기준. 편중 = 묶음 평균의 {shown.rules?.imbalanceRatio}배 이상(묶음 평균이 {rateText(shown.rules?.imbalanceMinBps)} 이상일 때만)</div>
                  <STable minWidth={520}>
                    <thead><tr><th>포트</th><th>연결 장비</th><th>속도</th><th>평균</th><th>몫</th><th data-nosort>편중</th></tr></thead>
                    <tbody>
                      {t.memberRows.map((m) => (
                        <tr key={m.port} style={{ cursor: 'pointer' }} onClick={() => pickTarget('port', m.port)} title="이 포트만 보기">
                          <td data-sort={m.port}><b>{m.slotPort}</b></td>
                          <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.name}>{shortDeviceName(m.name, 40) || '—'}</td>
                          <td>{m.speed || '—'}</td>
                          <td data-sort={m.avg ?? ''}>{rateText(m.avg)}</td>
                          <td data-sort={m.share ?? ''}>{pctText(m.share)}</td>
                          <td>{m.skewed ? <span style={{ color: '#ea580c', fontWeight: 600 }}>편중</span> : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </STable>
                </div>
              )}

              {t.kind === 'port' && t.zones && (
                <div className="card" style={{ padding: 8, marginBottom: 8, fontSize: 12 }}>
                  <div className="muted" style={{ fontSize: 11.5, marginBottom: 4 }}>조닝 상대 — 조닝 설정(zoneshow)상 이 포트와 같은 존에 있는 상대입니다. 트래픽 몫이 아닙니다.</div>
                  {t.zones.note && <div className="muted">{t.zones.note}</div>}
                  {!t.zones.note && !t.zones.row?.zones?.length && <div className="muted">이 포트가 속한 존이 없습니다.</div>}
                  <div className="flex gap" style={{ flexWrap: 'wrap' }}>
                    {(t.zones.row?.zones || []).flatMap((z) => (z.partners || []).map((p) => ({ z: z.name, ...p }))).slice(0, 40).map((p, i) => {
                      const local = portOfWwn.get(String(p.wwn || '').toLowerCase());
                      return (
                        <button key={`${p.wwn}-${i}`} className="tab" style={{ flex: 'none', padding: '2px 8px', fontSize: 11.5 }}
                          disabled={!local} onClick={() => local && pickTarget('port', local.index)}
                          title={`${p.label || p.wwn}\n존 ${p.z}\n${local ? `이 스위치 포트 ${local.slotPort} 로 이동` : '이 스위치 포트가 아닙니다(다른 스위치·팹)'}`}>
                          {shortDeviceName(p.label || p.wwn, 28)}{local ? ` → ${local.slotPort}` : ''}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}

          {(shown.imbalance?.length > 0 || shown.idle) && (
            <div className="card" style={{ padding: 8, marginBottom: 8, fontSize: 12 }}>
              {shown.imbalance?.map((it) => (
                <div key={`${it.storage}-${it.port}`} style={{ color: '#ea580c', cursor: 'pointer' }} onClick={() => pickTarget('storage', it.storage)}>⚠ {imbalanceText(it, slotOf)}</div>
              ))}
              {shown.idle && (
                <div className="muted" style={{ marginTop: shown.imbalance?.length ? 6 : 0 }}>
                  💤 {idleSummary(shown.idle)}
                  {shown.idle.idle.length > 0 && (
                    <div className="flex gap" style={{ flexWrap: 'wrap', marginTop: 4 }}>
                      {shown.idle.idle.slice(0, 30).map((p) => (
                        <button key={p.port} className="tab" style={{ flex: 'none', padding: '2px 8px', fontSize: 11.5 }} onClick={() => pickTarget('port', p.port)}
                          title={`${p.name || ''}\n30일 피크 ${rateText(p.peak)} · 데이터 ${p.days}일`}>{p.slotPort}</button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 히트맵 A — 포트(또는 스토리지 합 + 멤버) × 시간(1일) / 날짜(7일·1달) */}
          <div className="card" style={{ padding: 8, marginBottom: 8, minWidth: 0 }}>
            <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 6 }}>
              <b style={{ fontSize: 13 }}>{shown.view === 'storage' ? '스토리지 × ' : '포트 × '}{shown.unit === 'd' ? '시간' : '날짜'}</b>
              <span className="muted" style={{ fontSize: 11.5 }}>{shown.label} · 칸 = {shown.unit === 'd' ? '1시간' : '하루'} · {metric === 'peak' ? '칸 안 최댓값' : '칸 평균'} ÷ 속도 · 행을 누르면 위 차트가 그 대상으로 바뀝니다</span>
              {shown.view === 'port' && hiddenEmpty > 0 && (
                <button className="tab" style={{ flex: 'none', padding: '2px 8px', fontSize: 11.5 }} onClick={() => setShowEmpty((v) => !v)}>
                  {showEmpty ? '값 없는 포트 접기' : `값 없는 포트 ${hiddenEmpty}개 펼치기`}
                </button>
              )}
            </div>
            <Legend2 />
            <div style={{ overflowX: 'auto', marginTop: 6 }}>
              <div style={{ minWidth: shown.cols > 12 ? 520 : 360 }}>
                <div style={{ display: 'grid', gridTemplateColumns: `minmax(120px, 190px) repeat(${shown.cols}, minmax(9px, 1fr))`, gap: 2, fontSize: 10 }} className="muted">
                  <div />
                  {colLabels(shown).map((l, i) => <div key={i} style={{ textAlign: 'center', overflow: 'hidden', whiteSpace: 'nowrap' }}>{shown.cols > 24 && i % 2 ? '' : (shown.unit === 'w' ? l.slice(3) : l)}</div>)}
                </div>
                {rows.map((row) => (
                  <React.Fragment key={row.key}>
                    <HeatRow r={shown} starts={starts} metric={metric} cells={row.cells} capBps={row.capBps}
                      label={row.kind === 'storage' ? `${row.storage} 합` : `${row.slotPort}`}
                      sub={row.kind === 'storage' ? `${row.members.length}포트${row.partial ? ` · 부분 ${row.partial}칸 비움` : ''}` : (row.name ? shortDeviceName(row.name, 22) : (row.state !== 'online' ? stateLabel(row.state) : ''))}
                      selected={t?.key === row.key} onClick={() => pickTarget(row.kind === 'storage' ? 'storage' : 'port', row.kind === 'storage' ? row.storage : row.port)} />
                    {row.kind === 'storage' && (row.memberRows || []).map((m) => (
                      <HeatRow key={m.key} r={shown} starts={starts} metric={metric} cells={m.cells} capBps={m.capBps} indent
                        label={`└ ${m.slotPort}`} sub={m.speed || ''} selected={false} onClick={() => pickTarget('port', m.port)} />
                    ))}
                  </React.Fragment>
                ))}
                {!rows.length && <div className="muted" style={{ fontSize: 12, padding: 8 }}>표시할 행이 없습니다.</div>}
              </div>
            </div>
          </div>

          {/* 히트맵 B — 대상의 날짜 × 시간 */}
          {t?.histB && (
            <div className="card" style={{ padding: 8, marginBottom: 8, minWidth: 0 }}>
              <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 6 }}>
                <b style={{ fontSize: 13 }}>{targetTitle} — 날짜 × 시간</b>
                <span className="muted" style={{ fontSize: 11.5 }}>{shown.unit === 'd' ? '고른 날 포함 지난 7일' : shown.label} · 칸 = 1시간 · {metric === 'peak' ? '최댓값' : '평균'} ÷ 속도</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <div style={{ minWidth: 520 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(70px, 90px) repeat(24, minmax(9px, 1fr))', gap: 2, fontSize: 10 }} className="muted">
                    <div />{Array.from({ length: 24 }, (_, h) => <div key={h} style={{ textAlign: 'center' }}>{h % 3 ? '' : String(h).padStart(2, '0')}</div>)}
                  </div>
                  {t.histB.rows.map((row) => (
                    <div key={row.day} style={{ display: 'grid', gridTemplateColumns: 'minmax(70px, 90px) repeat(24, minmax(9px, 1fr))', gap: 2, marginBottom: 2, alignItems: 'center' }}>
                      <div style={{ fontSize: 11 }}>{dayText(row.day, shown.offsetMin)}</div>
                      {row.cells.map((c, h) => {
                        const info = cellInfo(c, { capBps: t.capBps, metric, start: row.day + h * 3_600_000, now: shown.now });
                        return <Cell key={h} info={info} title={cellTitle(info, { label: `${dayText(row.day, shown.offsetMin)} ${String(h).padStart(2, '0')}시`, metric, colMs: 3_600_000 })} />;
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <ul className="muted" style={{ fontSize: 11.5, margin: '4px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
            {USAGE_NOTES.map((n) => <li key={n}><BoldText text={n} /></li>)}
          </ul>
          {onPickPort && t?.kind === 'port' && (
            <button className="tab" style={{ ...SEG(), marginTop: 6 }} onClick={() => onPickPort(t.port)}>🔲 포트 배치에서 이 포트 보기</button>
          )}
        </div>
      )}
    </div>
  );
}
