/**
 * BmIoChart.jsx — 장비별 디스크 성능(평균 · 피크) 막대 비교 + 추이(실시간 · 트렌드) — v2.915(시안 docs/design/bm-san-compare 보드 ⑥).
 *
 * 데이터: GET /tools/bm-storage/io/series?range&metric&ids&rank=1[&datacenterId&types&to]
 *  · 실시간 1시간(최근 구간)만 30초마다 다시 읽는다(고른 ≤8 계열 — 가벼운 조회). 24시간 이상 · 과거 구간은 마운트 1회 + 버튼.
 *  · 늦게 온 이전 응답은 버린다(요청 키 대조). 숫자(격자 · 점 간격 · 보존)는 전부 응답 값으로 문장을 만든다.
 *  · 실선 = 평균(베어메탈은 카운터 차분 · SAN 은 5분 표본 평균) · 점선 = 피크(베어메탈은 2초 표본과 구간 평균 중 큰 값 · SAN 은 표본 최댓값 — 둘 다 하한 · v2.969). 결측은 끊긴 선(0 으로 그리지 않는다).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { usePolling } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import { fmtBps, kindTag, reasonText, reasonBadge } from './bmSanCompareText.js';
import {
  RANGES, METRICS, MAX_PICKS, LIVE_REFRESH_MS, rangeOf, bucketLabel, sampleText, basisText, seriesColors, toChartData, yDomain,
  timeTick, tipTime, maxBackOf, windowTo, windowLabel, defaultPicks, rankRows, pointsText, partialNote,
} from './bmIoChartText.js';

const tipStyle = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 12 };

export default function BmIoChart({ dcParam = '', types = '', dcNames = [], refreshKey = 0 }) {
  const [range, setRange] = useState('1h');
  const [metric, setMetric] = useState('total');
  const [picks, setPicks] = useState(null);          // null = 아직 기본 선택 전
  const [back, setBack] = useState(0);
  const [logY, setLogY] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [data, setData] = useState(null);           // 마지막으로 받은 응답(조건이 바뀌어 다시 읽는 동안도 유지 — 차트가 깜빡이지 않게)
  const [toTs, setToTs] = useState(null);           // 과거 구간의 창 끝(◀ 이전) — 누를 때의 시각으로 고정
  const [narrow, setNarrow] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < 720 : false));

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 720);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 범위 · 법인이 바뀌면 과거 구간 위치를 초기화한다(다른 보존 기간 · 다른 대상).
  useEffect(() => { setBack(0); }, [range, dcParam, types]);
  useEffect(() => { setToTs(windowTo(range, back, Date.now())); }, [range, back]);

  const idsParam = (picks || ['bm:all', 'san:all']).join(',');
  const live = rangeOf(range).live && back === 0;
  // 폴링은 공용 usePolling(403 이면 멈춤 · 숨은 탭이면 쉼 · ETag). 실시간 1시간 · 최근 구간만 30초, 그 밖은 사실상 마운트 1회 + 버튼(1시간 간격).
  const params = useMemo(() => ({ range, metric, ids: idsParam, rank: '1', datacenterId: dcParam, types, to: toTs ?? '', r: refreshKey }), [range, metric, idsParam, dcParam, types, toTs, refreshKey]);
  const polled = usePolling('/tools/bm-storage/io/series', params, live ? LIVE_REFRESH_MS : 3600_000, { timeoutMs: 60_000, retries: 0 });
  const loading = polled.loading;
  const error = polled.error;
  useEffect(() => {
    if (!polled.data) return;
    setData(polled.data);
    if (picks === null) setPicks(defaultPicks(polled.data.rank || []));
  }, [polled.data, picks]);

  const series = useMemo(() => data?.series || [], [data]);
  const colors = useMemo(() => seriesColors(series), [series]);
  const chartData = useMemo(() => toChartData(data?.buckets || [], series), [data, series]);
  const domain = useMemo(() => yDomain(series, { log: logY }), [series, logY]);
  const rank = useMemo(() => rankRows(data?.rank || [], { fold: 12 }), [data]);
  const maxBack = maxBackOf(range, data?.retention);
  const rangeDef = rangeOf(range);

  const togglePick = (id) => {
    setPicks((p) => {
      const cur = p || ['bm:all', 'san:all'];
      if (cur.includes(id)) return cur.filter((x) => x !== id);
      if (cur.length >= MAX_PICKS) return cur;
      return [...cur, id];
    });
  };
  const pickable = useMemo(() => {
    const list = [{ id: 'bm:all', kind: 'bm', name: dcNames.length ? `베어메탈 합(${dcNames.join(', ')})` : '베어메탈 전체' }, { id: 'san:all', kind: 'san', name: 'SAN 전체' }];
    for (const r of rank.rows) list.push({ id: r.id, kind: r.kind, name: r.name, type: r.type });
    return list;
  }, [rank, dcNames]);
  const pickSet = new Set(picks || ['bm:all', 'san:all']);
  const sampleBm = data?.sampleMs?.bm; const sampleSan = data?.sampleMs?.san;

  if (error && !data) return <ErrorBox error={error} />;
  return (
    <>
      {/* 구역 1 — 장비별 평균 · 피크 막대 비교 */}
      <div className="card bm2-card">
        <div className="flex between wrap" style={{ alignItems: 'center', gap: '8px 14px', marginBottom: 10 }}>
          <div className="bm2-label">▸ 장비별 디스크 성능 <span style={{ letterSpacing: 0 }}>· 평균(막대) · 피크(노란 표지) · 평균 높은 순 · {rank.rows.length}대{rank.unmeasured ? ` · 측정 없음 ${rank.unmeasured}` : ''}</span></div>
          <div className="flex wrap" style={{ alignItems: 'center', gap: '8px 14px' }}>
            <span className="muted" style={{ fontSize: 12 }}>범위</span>
            <span className="bmc-seg">{RANGES.map((r) => <button key={r.k} type="button" className={range === r.k ? 'on' : ''} onClick={() => setRange(r.k)}>{r.label}</button>)}</span>
            <span className="muted" style={{ fontSize: 12 }}>지표</span>
            <span className="bmc-seg">{METRICS.map((m) => <button key={m.k} type="button" className={metric === m.k ? 'on' : ''} onClick={() => setMetric(m.k)}>{m.label}</button>)}</span>
          </div>
        </div>
        {data && data.gran && (
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
            {bucketLabel(data.bucketMs)} · 베어메탈 {sampleText(sampleBm) || '점 간격 —'} · SAN {sampleText(sampleSan) || '점 간격 —'}{metric !== 'total' ? ' · SAN 은 읽기 · 쓰기를 나누지 않아 합계만 있습니다' : ''}
            {data.db && data.db.available === false ? <span style={{ color: 'var(--amber)' }}> · I/O 시계열 DB 를 열 수 없어 베어메탈 값이 비어 있습니다{data.db.error ? ` — ${data.db.error}` : ''}</span> : null}
          </div>
        )}
        {!data && loading && <div className="muted" style={{ fontSize: 12.5 }}>불러오는 중…</div>}
        {data && rank.rows.length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>비교할 장비가 없습니다 — 베어메탈 서버를 등록하거나 SAN 종류를 고르세요.</div>}
        {rank.rows.length > 0 && (
          <div className="bmc-bars">
            <div className="bmc-bars-h">장비</div><div className="bmc-bars-h">구분</div><div className="bmc-bars-h">평균 ■ · 피크 ▌ (최댓값 {fmtBps(rank.max)} = 100%)</div><div className="bmc-bars-h" style={{ textAlign: 'right' }}>평균 · 피크</div>
            {(showAll ? rank.rows : rank.shown).map((r) => {
              const tag = kindTag(r.kind === 'bm' ? 'bm' : r.type);
              const color = r.kind === 'bm' ? 'var(--mint)' : 'var(--accent)';
              const on = pickSet.has(r.id);
              return (
                <React.Fragment key={r.id}>
                  <button type="button" className={`bmc-name${on ? ' on' : ''}`} onClick={() => togglePick(r.id)} title={on ? '추이에서 빼기' : '추이에 더하기(최대 8)'}>
                    <b>{r.name}</b>
                    <small>{r.reason ? reasonText(r.reason) : `${pointsText(r, r.kind === 'bm' ? sampleBm : sampleSan)}${r.ports != null ? ` · 포트 ${r.ports}` : ''}`}</small>
                  </button>
                  <span><span className={`badge ${tag.cls}`}>{tag.label}</span></span>
                  <div className="bmc-track" aria-hidden="true">
                    {r.peakPct != null && <span className="bmc-peakline" style={{ width: `${r.peakPct}%` }} />}
                    <span className="bmc-avg" style={{ width: `${r.avgPct}%`, background: color }} />
                    {r.peakPct != null && <span className="bmc-peak" style={{ left: `${r.peakPct}%` }} />}
                  </div>
                  <div className="bmc-val">
                    {r.avgBps == null ? <span className="muted">—</span> : fmtBps(r.avgBps)}
                    <small style={r.reason ? { color: 'var(--amber)' } : undefined}>{r.reason ? reasonBadge(r.reason) : `피크 ${fmtBps(r.peakBps)}`}</small>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        )}
        {rank.hidden > 0 && (
          <button type="button" className="tab" style={{ marginTop: 10, padding: '5px 12px', fontSize: 12.5 }} onClick={() => setShowAll((v) => !v)}>
            {showAll ? '접기' : `+ ${rank.hidden}대 더 보기(평균 낮은 순)`}
          </button>
        )}
        <div className="bm2-foot">
          <b>평균</b>의 뜻 — 베어메탈은 <b>카운터 차분 평균</b>(수집 사이 구간 전체의 진짜 평균 — /proc/diskstats 누적값 차이 ÷ 시간), SAN 은 <b>포트 표본의 평균</b>(portperfshow 순간값). <b>피크</b>는 베어메탈은 <b>2초 표본과 구간 평균 중 큰 값</b>, SAN 은 <b>표본 중 최댓값</b>이라 양쪽 다 실제 순간 피크의 하한입니다.
        </div>
      </div>

      {/* 구역 2 — 추이 */}
      <div className="card bm2-card">
        <div className="flex between wrap" style={{ alignItems: 'center', gap: '8px 14px', marginBottom: 10 }}>
          <div className="bm2-label">▸ 추이 <span style={{ letterSpacing: 0 }}>· 실선 = 평균 · 점선 = 피크 · 고른 장비 {pickSet.size} (최대 {MAX_PICKS})</span></div>
          <div className="flex wrap" style={{ alignItems: 'center', gap: '8px 14px' }}>
            {live
              ? <span className="bmc-live"><i />{rangeDef.label} · {Math.round(LIVE_REFRESH_MS / 1000)}초마다 갱신{loading ? ' · 읽는 중' : ''}</span>
              : <span className="muted" style={{ fontSize: 12 }}>{windowLabel(range, back)}{loading ? ' · 읽는 중' : ''}</span>}
            {!rangeDef.live && (
              <span className="flex" style={{ gap: 6 }}>
                <button type="button" className="tab" style={{ padding: '4px 10px', fontSize: 12 }} disabled={back >= maxBack} onClick={() => setBack((b) => Math.min(maxBack, b + 1))} title={maxBack ? `보존 기간 안에서 ${maxBack}칸까지` : '보존 정보 없음'}>◀ 이전</button>
                <button type="button" className="tab" style={{ padding: '4px 10px', fontSize: 12 }} disabled={back === 0} onClick={() => setBack(0)}>최신</button>
              </span>
            )}
            <label className="muted" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={logY} onChange={(e) => setLogY(e.target.checked)} /> 로그 눈금
            </label>
          </div>
        </div>
        <div className="flex wrap" style={{ gap: 6, alignItems: 'center', marginBottom: 10 }}>
          <span className="muted" style={{ fontSize: 12 }}>장비</span>
          {pickable.slice(0, showAll ? pickable.length : 10).map((p) => {
            const on = pickSet.has(p.id);
            return (
              <button key={p.id} type="button" className={`bmc-pk${on ? ' on' : ''}`} aria-pressed={on} onClick={() => togglePick(p.id)} disabled={!on && pickSet.size >= MAX_PICKS}>
                <span className="bmc-ln" style={{ borderColor: on ? colors.get(p.id) || 'var(--text-dim)' : 'var(--text-faint)' }} />{p.name}
              </button>
            );
          })}
          {pickable.length > 10 && !showAll && <button type="button" className="bmc-pk" onClick={() => setShowAll(true)}>+ {pickable.length - 10}대 더…</button>}
          <span className="muted" style={{ fontSize: 11.5, marginLeft: 'auto' }}>막대 비교의 장비 이름을 눌러도 추이에 더해집니다</span>
        </div>
        {error && <div className="muted" style={{ fontSize: 12, color: 'var(--amber)', marginBottom: 6 }}>⚠ 일시 조회 오류: {String(error?.message || error)}</div>}
        <div className="bmc-chart">
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={narrow ? 240 : 300}>
              <LineChart data={chartData} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#243049" />
                <XAxis dataKey="t" stroke="#8b9bb4" fontSize={10.5} tickFormatter={(v) => timeTick(v, range)} minTickGap={narrow ? 48 : 36} />
                <YAxis stroke="#8b9bb4" fontSize={10.5} width={64} domain={domain} scale={logY ? 'log' : 'auto'} allowDataOverflow tickFormatter={(v) => fmtBps(v)} />
                <Tooltip contentStyle={tipStyle} labelFormatter={(v) => tipTime(v)} formatter={(v, name) => [fmtBps(v), name]} isAnimationActive={false} />
                {series.map((s) => (
                  <React.Fragment key={s.id}>
                    <Line type="monotone" dataKey={`${s.id}|peak`} name={`${s.name} · 피크`} stroke={colors.get(s.id)} strokeWidth={1.3} strokeDasharray="4 4" dot={false} connectNulls={false} isAnimationActive={false} strokeOpacity={0.8} />
                    <Line type="monotone" dataKey={`${s.id}|avg`} name={`${s.name} · 평균`} stroke={colors.get(s.id)} strokeWidth={2.4} dot={false} connectNulls={false} isAnimationActive={false} />
                  </React.Fragment>
                ))}
              </LineChart>
            </ResponsiveContainer>
          ) : <div className="muted" style={{ fontSize: 12.5, padding: 20 }}>{loading ? '불러오는 중…' : '그릴 값이 없습니다.'}</div>}
          <div className="bmc-legend">
            {series.map((s) => (
              <span key={s.id} title={s.reason ? reasonText(s.reason) : ''}>
                <i style={{ borderColor: colors.get(s.id) }} />{s.name}
                <span className="muted"> · {s.kind === 'bm' ? sampleText(s.sampleMs) : sampleText(s.sampleMs)}{s.avgTotal != null ? ` · 평균 ${fmtBps(s.avgTotal)} · 피크 ${fmtBps(s.peakTotal)}` : s.reason ? ` · ${reasonBadge(s.reason)}` : ' · 값 없음'}</span>
                {partialNote(s) ? <span className="muted" style={{ color: 'var(--amber)' }}> · {partialNote(s)}</span> : null}
              </span>
            ))}
          </div>
        </div>
        <div className="bm2-foot">
          {basisText('bm', series.find((s) => s.kind === 'bm')?.basis)} · {basisText('san')}. {data?.retention ? `◀ 이전은 보존 기간 안에서만 움직입니다(원시 ${data.retention.rawDays}일 · 15분 ${data.retention.r15Days}일 · 1시간 ${data.retention.r1hDays}일 — 설정값).` : ''}
        </div>
      </div>
    </>
  );
}
