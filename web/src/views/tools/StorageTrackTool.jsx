// 스토리지 사용량 추이(v2.350) — 데이터스토어 용량·사용량을 'VM 수량 추이'와 같은 00시·12시
// 슬롯으로 추적해 스토리지 관점으로 보여주는 독립 화면.
//
// 데이터는 v2.348 에서 이미 쌓고 있는 vm-track.db 를 그대로 읽는다(같은 스냅샷·같은 슬롯):
//   GET /tools/vm-track           → 슬롯별 dsCount/dsCapGB/dsUsedGB/dsUsagePct + bySlotVc(vCenter 분해)
//   GET /tools/vm-track/ds-changes → 그 슬롯에 사용량이 변한 DS·연결/해제 상세
// 별도 수집을 새로 돌리지 않으므로 vCenter 부하가 늘지 않고, VM 추이 화면과 수치가 항상 일치한다.
//
// VM 추이 화면과 다른 점(스토리지 관점 지표):
//   · vCenter별 현재 사용량/용량/사용률 + 기간 증감 표(정렬)  · 일평균 증가량(GB/일)
//   · 선형 추정 '용량 소진 예상' — 추정임을 화면에 명시(가정: 최근 기간 증가 속도 유지)
import React, { useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, ComposedChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend, ReferenceLine } from 'recharts';
import { fetchJson, postJson } from '../../api.js';
import { Loading, ErrorBox, Kpi } from '../../components/ui.jsx';
import EscClose from '../../components/EscClose.jsx';
import { fmtAgo } from '../../util/fmt.js';
import { tb, gbTb, perVcSummary, growth, hasDsData } from './storageTrack.js';
import DsTrendModal from './DsTrendModal.jsx'; // 개별 DS 추이 모달(v2.354) — 변경 이력 칩/행 클릭용

const DAY_OPTS = [7, 30, 90, 365];
const slotLabel = (slot) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(00|12)$/.exec(String(slot || ''));
  return m ? `${Number(m[2])}/${Number(m[3])} ${m[4]}시` : String(slot || '');
};
const pctColor = (p) => (p >= 90 ? 'var(--red)' : p >= 75 ? 'var(--amber)' : 'var(--green)');

export default function StorageTrackTool() {
  const [days, setDays] = useState(30);
  const [vcenterId, setVcenterId] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [detail, setDetail] = useState(null); // 사용량 변화 DS 상세
  const [dsTrend, setDsTrend] = useState(null); // 변경 이력 칩/행 클릭 → 개별 DS 추이 모달(v2.355)
  const [sort, setSort] = useState({ key: 'usedGB', dir: 'desc' }); // vCenter 표 정렬

  const refresh = () => fetchJson('/tools/vm-track', { days, vcenterId })
    .then((d) => { setData(d); setError(null); })
    .catch((e) => setError(e.message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { refresh(); const t = setInterval(refresh, 30_000); return () => clearInterval(t); }, [days, vcenterId]);

  // points 를 밖에서 만들면 매 렌더 새 배열이라 useMemo 가 무의미해진다 — 콜백 안에서 언팩한다.
  // v2.348 이전 버전에서 만들어진 스냅샷 행은 ds 열이 0 — 0 으로 그리면 라인이 바닥으로 꺼지고
  // 다음 슬롯과의 증감이 '전체 사용량'으로 잡힌다(실제 발생). 데이터 없는 슬롯은 null(차트 공백),
  // 그 직후 슬롯은 기준선(증감 0)으로 둔다 — VM 수량 추이의 baseline 처리와 같은 원칙.
  const chart = useMemo(() => (data?.points || []).map((p, i, arr) => {
    const has = hasDsData(p);
    const prevHas = i > 0 && hasDsData(arr[i - 1]);
    return {
      label: slotLabel(p.slot),
      slot: p.slot,
      snapId: p.snapId,
      hasDs: has,
      dsCount: p.dsCount || 0,
      dsCapTB: has ? tb(p.dsCapGB) : null,
      dsUsedTB: has ? tb(p.dsUsedGB) : null,
      dsFreeTB: has ? tb((p.dsCapGB || 0) - (p.dsUsedGB || 0)) : null,
      dsUsagePct: has ? (p.dsUsagePct ?? 0) : null,
      dsUsedGB: p.dsUsedGB || 0,
      dsCapGB: p.dsCapGB || 0,
      deltaGB: has && prevHas ? Math.round(((p.dsUsedGB || 0) - (arr[i - 1].dsUsedGB || 0)) * 10) / 10 : 0,
      collectedAt: p.collectedAt,
      baseline: p.baseline,
    };
  }), [data]);

  // vCenter별 현재/증감 — 순수 계산은 storageTrack.js(테스트 대상).
  const perVc = useMemo(() => perVcSummary(data?.bySlotVc || {}), [data]);

  const sortedVc = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...perVc].sort((a, b) => {
      const x = a[sort.key], y = b[sort.key];
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
    });
  }, [perVc, sort]);

  if (error && !data) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  // KPI 는 DS 데이터가 있는 마지막 스냅샷 기준(전부 구버전 행이면 null → '—').
  const last = [...chart].reverse().find((p) => p.hasDs) || null;
  // 기간 증감·일평균·소진 예상(선형) — 순수 계산은 storageTrack.js(구버전 행은 내부에서 제외).
  const { spanDays, netGB, perDayGB, freeGB, fullDays } = growth(chart);

  const snapshotNow = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/tools/vm-track/snapshot', {});
      setMsg(r.ok
        ? `스냅샷 완료 — ${r.slot} · DS ${r.dsCount ?? 0}개 · 사용 ${gbTb(r.dsUsedGB)} / 용량 ${gbTb(r.dsCapGB)}${r.baseline ? ' · 기준선(증감은 다음 슬롯부터)' : ''}`
        : (r.reason || '실패'));
      await refresh();
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };
  const openDetail = (row, vc) => setDetail({
    title: `${slotLabel(row.slot)} 데이터스토어 사용량 변화${vc ? ` — ${vc}` : (vcenterId ? ` — ${vcenterId}` : ' — 전체 vCenter')}`,
    slot: (vc || vcenterId) ? null : row.slot,
    snapId: vc ? row.snapId : (vcenterId ? row.snapId : null),
  });
  const th = (key, label, align = 'right') => (
    <th style={{ textAlign: align, cursor: 'pointer' }} onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}>
      {label}{sort.key === key ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : ''}
    </th>
  );

  return (
    <div>
      <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 12 }}>
        <div>
          <div className="section-title" style={{ margin: 0 }}>💾 스토리지 사용량 추이</div>
          <div className="muted" style={{ fontSize: 12 }}>
            vCenter 에 연결된 데이터스토어의 용량·사용량을 매일 <b>00시·12시</b> 스냅샷으로 추적합니다.
            'VM 수량 추이'와 <b>같은 스냅샷·같은 DB</b>를 읽으므로 수치가 일치하고, 추가 수집 부하가 없습니다.
          </div>
        </div>
        <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="input" value={vcenterId} onChange={(e) => setVcenterId(e.target.value)} style={{ padding: '6px 10px', fontSize: 12.5 }}>
            <option value="">전체 vCenter(합계)</option>
            {(data.vcenterList || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          <span className="flex gap">
            {DAY_OPTS.map((d) => (
              <button key={d} className={days === d ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '6px 11px', fontSize: 12 }} onClick={() => setDays(d)}>{d}일</button>
            ))}
          </span>
          <button className="logout-btn" style={{ padding: '7px 13px' }} disabled={busy} onClick={snapshotNow} title="지금 즉시 스냅샷(같은 슬롯이면 최신 값으로 갱신)">⚡ 지금 스냅샷</button>
        </div>
      </div>
      {msg && <div className="muted" style={{ fontSize: 12.5, marginBottom: 8, color: '#93c5fd' }}>{msg}</div>}
      {error && <div className="muted" style={{ fontSize: 12, marginBottom: 8, color: 'var(--amber)' }}>⚠ 일시 조회 오류: {error}</div>}
      {data.status && !data.status.available && (
        <div className="card" style={{ padding: 10, marginBottom: 10, borderLeft: '3px solid var(--red)', fontSize: 12.5 }}>
          ⚠ 추적 DB를 열 수 없어 기능이 비활성입니다{data.status.error ? ` — ${data.status.error}` : ''}. (경로: {data.status.dbPath})
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 14 }}>
        <Kpi label="총 용량" value={last ? `${last.dsCapTB.toLocaleString()} TB` : '—'} meta={last ? `데이터스토어 ${last.dsCount.toLocaleString()}개` : '스냅샷 없음'} />
        <Kpi label="사용량" value={last ? `${last.dsUsedTB.toLocaleString()} TB` : '—'} pct={last ? Math.round(last.dsUsagePct) : undefined} />
        <Kpi label="가용" value={last ? `${last.dsFreeTB.toLocaleString()} TB` : '—'}
          accent={last && last.dsUsagePct >= 90 ? 'var(--red)' : last && last.dsUsagePct >= 75 ? 'var(--amber)' : undefined} />
        <Kpi label={`${days}일 증감`} value={`${netGB >= 0 ? '+' : ''}${gbTb(netGB)}`}
          accent={netGB > 0 ? 'var(--amber)' : netGB < 0 ? 'var(--green)' : undefined}
          meta={spanDays ? `실측 ${spanDays.toFixed(1)}일` : ''} />
        <Kpi label="일평균 증가" value={`${perDayGB >= 0 ? '+' : ''}${gbTb(perDayGB)}/일`}
          meta={fullDays != null ? `이 속도면 가용 소진 ~${fullDays.toLocaleString()}일` : '증가 추세 아님'} />
      </div>

      {chart.length === 0 ? (
        <div className="card" style={{ padding: 16, fontSize: 13 }}>
          <b>아직 스냅샷이 없습니다.</b>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.7 }}>
            폴러가 다음 00시 또는 12시에 첫 스냅샷(기준선)을 만듭니다. 지금 시작하려면 <b>⚡ 지금 스냅샷</b>을 누르세요.
            첫 스냅샷은 기준선이라 증감이 0이고, 다음 슬롯부터 사용량 변화가 집계됩니다.
          </div>
        </div>
      ) : (
        <>
          <div className="card" style={{ padding: 12, marginBottom: 12 }}>
            <b style={{ fontSize: 13 }}>용량 / 사용량 / 사용률 {vcenterId ? `— ${vcenterId}` : '— 전체 vCenter 합계'}</b>
            {/* 사용자 요구 형태(v2.352): 총 용량은 상단 한도선(라인), 슬롯별 사용량은 바닥에서
                올라오는 막대 — 사용량이 용량선에 다가가는 정도가 한눈에 보인다. 막대라 축은 0부터. */}
            <div style={{ width: '100%', height: 270, marginTop: 8 }}>
              <ResponsiveContainer>
                <ComposedChart data={chart} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,.18)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="tb" tick={{ fontSize: 11 }} domain={[0, 'auto']} />
                  <YAxis yAxisId="pct" orientation="right" tick={{ fontSize: 11 }} domain={[0, 100]} unit="%" />
                  <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(148,163,184,.3)', fontSize: 12 }}
                    formatter={(v, n) => [n === 'dsUsagePct' ? `${v}%` : `${Number(v).toLocaleString()} TB`,
                      n === 'dsCapTB' ? '총 용량' : n === 'dsUsedTB' ? '사용량' : '사용률']} />
                  <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => (v === 'dsCapTB' ? '총 용량(TB)' : v === 'dsUsedTB' ? '사용량(TB)' : '사용률(%)')} />
                  <Bar yAxisId="tb" dataKey="dsUsedTB" fill="#f59e0b" fillOpacity={0.85} maxBarSize={26} />
                  <Line yAxisId="tb" type="monotone" dataKey="dsCapTB" stroke="#60a5fa" strokeWidth={2} dot={false} />
                  <Line yAxisId="pct" type="monotone" dataKey="dsUsagePct" stroke="#a78bfa" strokeWidth={1.2} strokeDasharray="2 2" dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="card" style={{ padding: 12, marginBottom: 12 }}>
            <b style={{ fontSize: 13 }}>슬롯별 사용량 증감(GB)</b>
            <span className="muted" style={{ fontSize: 11.5, marginLeft: 8 }}>아래 표에서 증감을 누르면 어떤 데이터스토어가 늘거나 줄었는지 봅니다</span>
            <div style={{ width: '100%', height: 190, marginTop: 8 }}>
              <ResponsiveContainer>
                <BarChart data={chart} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,.18)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(148,163,184,.3)', fontSize: 12 }}
                    formatter={(v) => [`${Number(v).toLocaleString()} GB`, '사용량 증감']} />
                  <ReferenceLine y={0} stroke="rgba(148,163,184,.4)" />
                  <Bar dataKey="deltaGB" fill="#f59e0b" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* vCenter별 현재 상태 + 기간 증감 — 전체 보기에서만(단일 vCenter 선택 시 중복) */}
          {!vcenterId && sortedVc.length > 0 && (
            <div className="card" style={{ padding: 12, marginBottom: 12 }}>
              <b style={{ fontSize: 13 }}>vCenter별 현재 사용량 · {days}일 증감</b>
              <span className="muted" style={{ fontSize: 11.5, marginLeft: 8 }}>헤더 클릭으로 정렬 · 증감을 누르면 그 vCenter 의 최근 변화 상세</span>
              <div className="table-wrap" style={{ maxHeight: '40vh', marginTop: 8 }}>
                <table>
                  <thead>
                    <tr>
                      {th('vcenterId', 'vCenter', 'left')}
                      {th('dsCount', 'DS')}
                      {th('usedGB', '사용량')}
                      {th('capGB', '총 용량')}
                      {th('freeGB', '가용')}
                      {th('usagePct', '사용률')}
                      {th('deltaGB', `${days}일 증감`)}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedVc.map((v) => (
                      <tr key={v.vcenterId}>
                        <td><b>{v.vcenterId}</b></td>
                        <td style={{ textAlign: 'right' }} className="muted">{v.dsCount.toLocaleString()}</td>
                        <td style={{ textAlign: 'right' }}>{tb(v.usedGB).toLocaleString()} TB</td>
                        <td style={{ textAlign: 'right' }} className="muted">{tb(v.capGB).toLocaleString()} TB</td>
                        <td style={{ textAlign: 'right' }} className="muted">{tb(v.freeGB).toLocaleString()} TB</td>
                        <td style={{ textAlign: 'right', color: pctColor(v.usagePct) }}><b>{v.usagePct}%</b></td>
                        <td style={{ textAlign: 'right' }}>
                          {v.deltaGB ? (
                            <button className="tab" style={{ padding: '2px 8px', fontSize: 12, color: v.deltaGB > 0 ? 'var(--amber)' : 'var(--green)' }}
                              title="이 vCenter 의 최근 슬롯 변화 상세"
                              onClick={() => openDetail({ slot: last?.slot, snapId: v.snapId }, v.vcenterId)}>
                              {v.deltaGB > 0 ? '+' : ''}{gbTb(v.deltaGB)}
                            </button>
                          ) : <span className="muted">0</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 데이터스토어별 증감 추이(v2.353, 사용자 요구) */}
          <DsPerStore days={days} vcenterId={vcenterId} />

          {/* 선택 vCenter 의 전체 DS 각각의 추이 차트(v2.354, 사용자 요구) */}
          <DsAllGrid days={days} vcenterId={vcenterId} />

          {/* 스토리지 변경 이력(v2.355, 목업 확정 C) — A 시각별 / B DS별 전환 */}
          <DsChangeHistory days={days} vcenterId={vcenterId} onPick={(it) => setDsTrend(it)} onSlot={(g) => setDetail({
            title: `${slotLabel(g.slot)} 데이터스토어 사용량 변화${vcenterId ? ` — ${vcenterId}` : ' — 전체 vCenter'}`,
            slot: g.slot, snapId: null,
          })} />

          {/* 슬롯 이력 */}
          <div className="card" style={{ padding: 12 }}>
            <b style={{ fontSize: 13 }}>스냅샷 이력 <span className="muted" style={{ fontWeight: 400, fontSize: 11.5 }}>(증감을 누르면 변화한 데이터스토어 목록)</span></b>
            <div className="table-wrap" style={{ maxHeight: '46vh', marginTop: 8 }}>
              <table>
                <thead>
                  <tr>
                    <th>시각</th><th style={{ textAlign: 'right' }}>DS</th>
                    <th style={{ textAlign: 'right' }}>사용량</th><th style={{ textAlign: 'right' }}>총 용량</th>
                    <th style={{ textAlign: 'right' }}>가용</th><th style={{ textAlign: 'right' }}>사용률</th>
                    <th style={{ textAlign: 'right' }}>증감</th><th>수집</th>
                  </tr>
                </thead>
                <tbody>
                  {[...chart].reverse().map((r) => (
                    <tr key={r.slot}>
                      <td><b>{slotLabel(r.slot)}</b>{r.baseline && <span className="badge gray" style={{ marginLeft: 6, fontSize: 10 }}>기준선</span>}</td>
                      <td style={{ textAlign: 'right' }} className="muted">{r.hasDs ? r.dsCount.toLocaleString() : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{r.hasDs ? `${r.dsUsedTB.toLocaleString()} TB` : '—'}</td>
                      <td style={{ textAlign: 'right' }} className="muted">{r.hasDs ? `${r.dsCapTB.toLocaleString()} TB` : '—'}</td>
                      <td style={{ textAlign: 'right' }} className="muted">{r.hasDs ? `${r.dsFreeTB.toLocaleString()} TB` : '—'}</td>
                      <td style={{ textAlign: 'right', color: pctColor(r.dsUsagePct || 0) }}>{r.hasDs ? `${r.dsUsagePct}%` : '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        {r.deltaGB ? (
                          <button className="tab" style={{ padding: '2px 8px', fontSize: 12, color: r.deltaGB > 0 ? 'var(--amber)' : 'var(--green)' }}
                            onClick={() => openDetail(r, null)}>
                            {r.deltaGB > 0 ? '+' : ''}{gbTb(r.deltaGB)}
                          </button>
                        ) : <span className="muted">0</span>}
                      </td>
                      <td className="muted" style={{ fontSize: 11.5 }}>{fmtAgo(r.collectedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.7 }}>
              '일평균 증가'와 '가용 소진 ~N일'은 <b>실측 기간의 평균 증가 속도가 유지된다고 가정한 선형 추정</b>입니다(예측 모델이 아님).
              사용량 변화 상세는 1GB 이상 바뀐 데이터스토어만 나열합니다 — 합계 차트는 임계와 무관하게 정확합니다.
            </div>
          </div>
        </>
      )}

      {detail && <DsDetail {...detail} onClose={() => setDetail(null)} />}
      {dsTrend && <DsTrendModal dsId={dsTrend.dsId} name={dsTrend.name} vcenterId={dsTrend.vcenterId}
        type={dsTrend.type} onClose={() => setDsTrend(null)} />}
    </div>
  );
}

/** 증감 값 배지 색 — 증가 주황(용량 소모) / 감소 초록(회수). */
const deltaColor = (gb) => (gb > 0 ? 'var(--amber)' : gb < 0 ? 'var(--green)' : undefined);

/**
 * 스토리지 변경 이력(v2.355, 목업 확정 C) — 두 보기를 전환한다:
 *  · 시각별(A): 행 = 00/12시 슬롯, 그 슬롯에 사용량이 변한 DS 를 칩으로 나열(첨부 표의
 *    'VCENTER별 증감' 칩과 같은 문법). 칩 클릭 → 그 DS 추이 모달, 시각 클릭 → 슬롯 전체 상세.
 *  · DS별(B): 행 = 데이터스토어, 열 = 최근 6개 슬롯의 증감 + 기간 누적(피벗).
 * 데이터는 diff-압축 저장(ds_changes/ds_series) — 무변화 DS 는 행이 없어 전체 vCenter 도 가볍다.
 */
function DsChangeHistory({ days, vcenterId, onPick, onSlot }) {
  const [view, setView] = useState('slots'); // 'slots'(A 시각별) | 'ds'(B DS별)
  const [log, setLog] = useState(null);
  const [pivot, setPivot] = useState(null);
  const [q, setQ] = useState('');
  const [changedOnly, setChangedOnly] = useState(true);
  const [page, setPage] = useState(0);
  const [err, setErr] = useState(null);
  const LIMIT = 20;

  useEffect(() => { setPage(0); }, [vcenterId, days, q, changedOnly, view]);
  useEffect(() => {
    if (view !== 'slots') return;
    fetchJson('/tools/vm-track/ds-change-log', { days, vcenterId })
      .then((d) => { setLog(d); setErr(null); })
      .catch((e) => setErr(e.message));
  }, [view, days, vcenterId]);
  useEffect(() => {
    if (view !== 'ds') return;
    fetchJson('/tools/vm-track/ds-pivot', { days, vcenterId, q, changedOnly: changedOnly ? 1 : 0, offset: page * LIMIT, limit: LIMIT })
      .then((d) => { setPivot(d); setErr(null); })
      .catch((e) => setErr(e.message));
  }, [view, days, vcenterId, q, changedOnly, page]);

  const chip = (it) => (
    <button key={`${it.dsId}`} className="tab" onClick={() => onPick(it)}
      title={`${it.name} · ${it.vcenterId} · 클릭하면 추이 차트`}
      style={{ flex: 'none', padding: '2px 8px', fontSize: 11.5, color: it.kind === 'ds_added' ? 'var(--green)' : it.kind === 'ds_removed' ? 'var(--red)' : deltaColor(it.deltaGB || 0) }}>
      {it.name} {it.kind === 'ds_added' ? `신규 ${gbTb(it.usedGB)}` : it.kind === 'ds_removed' ? '해제' : `${(it.deltaGB || 0) > 0 ? '+' : ''}${gbTb(it.deltaGB)}`}
    </button>
  );

  const total = pivot?.total || 0;
  const pages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <div className="card" style={{ padding: 12, marginBottom: 12 }}>
      <div className="flex between wrap" style={{ alignItems: 'center' }}>
        <div>
          <b style={{ fontSize: 13 }}>스토리지 변경 이력 {vcenterId ? `— ${vcenterId}` : '— 전체 vCenter'}</b>
          <span className="muted" style={{ fontSize: 11.5, marginLeft: 8 }}>
            {view === 'slots' ? '시각별 — 그 슬롯에 변화한 데이터스토어(칩 클릭 → 추이 차트)' : 'DS별 — 최근 슬롯 증감 피벗(행 클릭 → 추이 차트)'}
          </span>
        </div>
        <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          {view === 'ds' && (
            <>
              <input className="input" placeholder="데이터스토어/유형 검색" value={q} onChange={(e) => setQ(e.target.value)}
                style={{ maxWidth: 180, padding: '5px 10px', fontSize: 12.5 }} />
              <label className="muted" style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={changedOnly} onChange={(e) => setChangedOnly(e.target.checked)} />변화 있는 DS 만
              </label>
              <span className="flex gap" style={{ alignItems: 'center' }}>
                <button className="tab" style={{ flex: 'none', padding: '4px 9px', fontSize: 12 }} disabled={page <= 0} onClick={() => setPage((x) => Math.max(0, x - 1))}>◀</button>
                <span className="muted" style={{ fontSize: 12 }}>{page + 1}/{pages}</span>
                <button className="tab" style={{ flex: 'none', padding: '4px 9px', fontSize: 12 }} disabled={page + 1 >= pages} onClick={() => setPage((x) => x + 1)}>▶</button>
              </span>
            </>
          )}
          <span className="flex gap">
            <button className={view === 'slots' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 11px', fontSize: 12 }} onClick={() => setView('slots')}>시각별</button>
            <button className={view === 'ds' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 11px', fontSize: 12 }} onClick={() => setView('ds')}>DS별</button>
          </span>
        </div>
      </div>
      {err && <div className="muted" style={{ fontSize: 12, marginTop: 6, color: 'var(--amber)' }}>⚠ {err}</div>}

      {view === 'slots' && (
        !log ? <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>불러오는 중…</div>
        : (log.slots || []).length === 0 ? (
          <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
            이 기간에 사용량이 변한 데이터스토어가 없습니다(1GB 미만 변화는 기록하지 않음 · 개별 추적은 v2.353 이후).
          </div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: '46vh', marginTop: 8 }}>
            <table>
              <thead>
                <tr><th>시각</th><th style={{ textAlign: 'right' }}>변화 DS</th><th style={{ textAlign: 'right' }}>합계 증감</th><th>DS별 증감(|증감| 큰 순)</th></tr>
              </thead>
              <tbody>
                {(log.slots || []).map((g) => (
                  <tr key={g.slot}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="cell-link" title="이 슬롯의 변화 전체 상세" onClick={() => onSlot(g)}><b>{slotLabel(g.slot)}</b></button>
                    </td>
                    <td style={{ textAlign: 'right' }} className="muted">{(g.items.length + (g.more || 0)).toLocaleString()}</td>
                    <td style={{ textAlign: 'right', color: deltaColor(g.sumDeltaGB) }}><b>{g.sumDeltaGB > 0 ? '+' : ''}{gbTb(g.sumDeltaGB)}</b></td>
                    <td>
                      <span className="flex wrap" style={{ gap: 4 }}>
                        {g.items.map(chip)}
                        {g.more > 0 && (
                          <button className="tab" style={{ flex: 'none', padding: '2px 8px', fontSize: 11.5 }} onClick={() => onSlot(g)}>…외 {g.more}개 더보기</button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {view === 'ds' && (
        !pivot ? <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>불러오는 중…</div>
        : (pivot.items || []).length === 0 ? (
          <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>표시할 데이터스토어가 없습니다{changedOnly ? " — '변화 있는 DS 만' 을 해제하면 전체가 보입니다." : '.'}</div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: '52vh', marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th>데이터스토어</th>{!vcenterId && <th>vCenter</th>}<th>유형</th>
                  <th style={{ textAlign: 'right' }}>사용/용량</th><th style={{ textAlign: 'right' }}>사용률</th>
                  {(pivot.slotCols || []).map((c) => <th key={c.slot} style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{slotLabel(c.slot)}</th>)}
                  <th style={{ textAlign: 'right' }}>{days}일 누적</th>
                </tr>
              </thead>
              <tbody>
                {(pivot.items || []).map((d) => (
                  <tr key={d.dsId} onClick={() => onPick(d)} style={{ cursor: 'pointer' }} title="클릭하면 추이 차트">
                    <td><b>💾 {d.name}</b></td>
                    {!vcenterId && <td className="muted" style={{ fontSize: 11.5 }}>{d.vcenterId}</td>}
                    <td className="muted" style={{ fontSize: 11.5 }}>{d.type || '—'}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{gbTb(d.usedGB)} / {gbTb(d.capGB)}</td>
                    <td style={{ textAlign: 'right', color: pctColor(d.usagePct || 0) }}>{d.usagePct}%</td>
                    {(pivot.slotCols || []).map((c) => {
                      const cell = d.slots?.[c.slot];
                      if (cell == null) return <td key={c.slot} style={{ textAlign: 'right' }} className="muted">—</td>;
                      if (cell.kind === 'ds_added') return <td key={c.slot} style={{ textAlign: 'right', color: 'var(--green)', fontSize: 12 }}>신규</td>;
                      if (cell.kind === 'ds_removed') return <td key={c.slot} style={{ textAlign: 'right', color: 'var(--red)', fontSize: 12 }}>해제</td>;
                      const v = cell.deltaGB || 0;
                      return <td key={c.slot} style={{ textAlign: 'right', color: deltaColor(v) }}>{v ? `${v > 0 ? '+' : ''}${gbTb(v)}` : <span className="muted">0</span>}</td>;
                    })}
                    <td style={{ textAlign: 'right', color: deltaColor(d.cumGB) }}><b>{d.cumGB ? `${d.cumGB > 0 ? '+' : ''}${gbTb(d.cumGB)}` : 0}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
        1GB 미만의 변화는 기록하지 않습니다(합계 차트는 임계와 무관하게 정확). '—' = 그 DS 관측 이전 슬롯.
      </div>
    </div>
  );
}

/**
 * 선택 vCenter 의 전체 데이터스토어 각각의 추이 그리드(v2.354, 사용자 요구:
 * "모든 데이터스토어별로 각각" + "선택한 vCenter 의 데이터스토어만"). 카드마다 합계 차트와
 * 같은 형식(총 용량 한도선 + 슬롯별 사용량 막대). 전체 vCenter(1,000개+ DS)를 한 번에
 * 그리면 응답 수 MB·렌더 폭주라 vCenter 선택 시에만 표시하고 12개씩 페이지로 넘긴다.
 */
function DsAllGrid({ days, vcenterId }) {
  const LIMIT = 12;
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('used');
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { setPage(0); }, [vcenterId, q, sort, days]);
  useEffect(() => {
    if (!vcenterId) { setData(null); return; }
    fetchJson('/tools/vm-track/ds-series-all', { vcenterId, days, q, sort, offset: page * LIMIT, limit: LIMIT })
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr(e.message));
  }, [vcenterId, days, q, sort, page]);

  if (!vcenterId) {
    return (
      <div className="card" style={{ padding: 12, marginBottom: 12 }}>
        <b style={{ fontSize: 13 }}>데이터스토어별 추이(전체)</b>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
          상단에서 <b>vCenter 를 선택</b>하면 그 vCenter 에 연결된 데이터스토어 <b>각각의 추이 차트</b>가 여기에 표시됩니다.
          (전체 vCenter 일괄 표시는 데이터스토어가 1,000개를 넘어 지원하지 않습니다 — vCenter 단위로 보세요.)
        </div>
      </div>
    );
  }
  const items = data?.items || [];
  const total = data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / LIMIT));
  return (
    <div className="card" style={{ padding: 12, marginBottom: 12 }}>
      <div className="flex between wrap" style={{ alignItems: 'center' }}>
        <div>
          <b style={{ fontSize: 13 }}>데이터스토어별 추이 — {vcenterId}</b>
          <span className="muted" style={{ fontSize: 11.5, marginLeft: 8 }}>
            {total.toLocaleString()}개 중 {total ? page * LIMIT + 1 : 0}–{Math.min(total, (page + 1) * LIMIT)} · 카드마다 총 용량 한도선 + 사용량 막대
          </span>
        </div>
        <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="input" placeholder="데이터스토어/유형 검색" value={q} onChange={(e) => setQ(e.target.value)}
            style={{ maxWidth: 190, padding: '6px 10px', fontSize: 12.5 }} />
          <select className="input" value={sort} onChange={(e) => setSort(e.target.value)} style={{ padding: '6px 10px', fontSize: 12.5 }}>
            <option value="used">사용량 큰 순</option>
            <option value="delta">{days}일 증감 큰 순</option>
            <option value="name">이름 순</option>
          </select>
          <span className="flex gap" style={{ alignItems: 'center' }}>
            <button className="tab" style={{ flex: 'none', padding: '5px 10px', fontSize: 12 }} disabled={page <= 0} onClick={() => setPage((x) => Math.max(0, x - 1))}>◀ 이전</button>
            <span className="muted" style={{ fontSize: 12 }}>{page + 1}/{pages}</span>
            <button className="tab" style={{ flex: 'none', padding: '5px 10px', fontSize: 12 }} disabled={page + 1 >= pages} onClick={() => setPage((x) => x + 1)}>다음 ▶</button>
          </span>
        </div>
      </div>
      {err && <div className="muted" style={{ fontSize: 12, marginTop: 6, color: 'var(--amber)' }}>⚠ {err}</div>}
      {!data && !err && <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>불러오는 중…</div>}
      {data && items.length === 0 && <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>표시할 데이터스토어가 없습니다.</div>}
      {items.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 10, marginTop: 10 }}>
          {items.map((it) => <DsMiniChart key={it.dsId} item={it} days={days} />)}
        </div>
      )}
    </div>
  );
}

/** 그리드 셀 1개 — 미니 추이 차트(합계 차트와 같은 형식, 축 단위는 DS 규모에 따라 GB/TB 자동). */
function DsMiniChart({ item, days }) {
  const pts = item.points || [];
  const maxCap = pts.reduce((m, p) => Math.max(m, p.capGB || 0), 0);
  const useTb = maxCap >= 10_240;
  const unit = useTb ? 'TB' : 'GB';
  const u = (gb) => (gb == null ? null : (useTb ? tb(gb) : Math.round(gb * 10) / 10));
  const chart = pts.map((p) => ({ label: slotLabel(p.slot), cap: u(p.capGB), used: u(p.usedGB) }));
  const observed = pts.some((p) => p.usedGB != null);
  return (
    <div style={{ border: '1px solid rgba(148,163,184,.15)', borderRadius: 8, padding: 10 }}>
      <div className="flex between" style={{ alignItems: 'baseline' }}>
        <b style={{ fontSize: 12.5 }}>💾 {item.name}</b>
        <span className="muted" style={{ fontSize: 11 }}>{item.type || '—'}</span>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
        사용 {gbTb(item.usedGB)} / {gbTb(item.capGB)} · <b style={{ color: pctColor(item.usagePct || 0) }}>{item.usagePct}%</b>
        {' · '}{days}일 증감 {item.deltaGB
          ? <b style={{ color: item.deltaGB > 0 ? 'var(--amber)' : 'var(--green)' }}>{item.deltaGB > 0 ? '+' : ''}{gbTb(item.deltaGB)}</b>
          : <span>0</span>}
      </div>
      {!observed ? (
        <div className="muted" style={{ fontSize: 11.5, height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          관측 스냅샷 없음 — 다음 00시·12시 스냅샷부터 쌓입니다
        </div>
      ) : (
        <div style={{ width: '100%', height: 140, marginTop: 6 }}>
          <ResponsiveContainer>
            <ComposedChart data={chart} margin={{ top: 4, right: 8, bottom: 0, left: -14 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,.12)" />
              <XAxis dataKey="label" tick={{ fontSize: 9.5 }} />
              <YAxis tick={{ fontSize: 9.5 }} domain={[0, 'auto']} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(148,163,184,.3)', fontSize: 12 }}
                formatter={(v, n) => [`${Number(v).toLocaleString()} ${unit}`, n === 'cap' ? '총 용량' : '사용량']} />
              <Bar dataKey="used" fill="#f59e0b" fillOpacity={0.85} maxBarSize={18} />
              <Line type="monotone" dataKey="cap" stroke="#60a5fa" strokeWidth={1.5} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

/**
 * 데이터스토어별 증감 추이(v2.353) — 개별 DS 를 골라 총 용량 한도선 + 슬롯별 사용량 막대
 * (상단 합계 차트와 같은 형식)로 본다. '기간 증감 상위' 표에서 행을 눌러도 선택된다.
 * 서버가 diff-압축 시계열(ds_series)을 슬롯 축 위에 step 으로 펼쳐 주므로(첫 관측 전 null)
 * 화면은 받은 points 를 그대로 그린다.
 */
function DsPerStore({ days, vcenterId }) {
  const [list, setList] = useState(null);   // 선택 목록(로스터)
  const [top, setTop] = useState(null);     // 기간 증감 상위
  const [sel, setSel] = useState('');       // 선택된 dsId
  const [q, setQ] = useState('');
  const [series, setSeries] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => { setSel(''); }, [vcenterId]); // 범위가 바뀌면 선택 해제(다른 vCenter 의 DS 잔류 방지)
  useEffect(() => {
    fetchJson('/tools/vm-track/ds-list', { vcenterId })
      .then((d) => { setList(d.items || []); setErr(null); })
      .catch((e) => setErr(e.message));
  }, [vcenterId]);
  useEffect(() => {
    fetchJson('/tools/vm-track/ds-top', { days, vcenterId, limit: 15 })
      .then((d) => { setTop(d); setErr(null); })
      .catch((e) => setErr(e.message));
  }, [days, vcenterId]);
  useEffect(() => {
    if (!sel) { setSeries(null); return; }
    fetchJson('/tools/vm-track/ds-series', { dsId: sel, days })
      .then((d) => { setSeries(d); setErr(null); })
      .catch((e) => setErr(e.message));
  }, [sel, days]);

  const ql = q.trim().toLowerCase();
  const filtered = (list || []).filter((d) => !ql
    || d.name.toLowerCase().includes(ql) || d.vcenterId.toLowerCase().includes(ql) || (d.type || '').toLowerCase().includes(ql));
  const selMeta = (list || []).find((d) => d.dsId === sel) || null;

  // 개별 DS 는 용량이 수백 GB~수천 TB 로 편차가 커 축 단위를 자동 선택(10TB 이상이면 TB).
  const pts = series?.points || [];
  const maxCap = pts.reduce((m, p) => Math.max(m, p.capGB || 0), 0);
  const useTb = maxCap >= 10_240;
  const u = (gb) => (gb == null ? null : (useTb ? tb(gb) : Math.round(gb * 10) / 10));
  const unit = useTb ? 'TB' : 'GB';
  const dsChart = pts.map((p) => ({
    label: slotLabel(p.slot), cap: u(p.capGB), used: u(p.usedGB), pct: p.usagePct,
  }));
  const dsFirst = pts.find((p) => p.usedGB != null) || null;
  const dsLast = [...pts].reverse().find((p) => p.usedGB != null) || null;
  const dsDelta = dsFirst && dsLast ? Math.round(((dsLast.usedGB || 0) - (dsFirst.usedGB || 0)) * 10) / 10 : 0;

  return (
    <div className="card" style={{ padding: 12, marginBottom: 12 }}>
      <div className="flex between wrap" style={{ alignItems: 'center' }}>
        <div>
          <b style={{ fontSize: 13 }}>데이터스토어별 증감 추이</b>
          <span className="muted" style={{ fontSize: 11.5, marginLeft: 8 }}>
            개별 데이터스토어의 용량 한도선·사용량 막대 · 아래 표(기간 증감 상위)에서 행을 눌러도 선택됩니다
          </span>
        </div>
        <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="input" placeholder="데이터스토어/유형/vCenter 검색" value={q} onChange={(e) => setQ(e.target.value)}
            style={{ maxWidth: 210, padding: '6px 10px', fontSize: 12.5 }} />
          <select className="input" value={sel} onChange={(e) => setSel(e.target.value)} style={{ padding: '6px 10px', fontSize: 12.5, maxWidth: 340 }}>
            <option value="">데이터스토어 선택{list ? ` (${filtered.length}개)` : ''}</option>
            {filtered.map((d) => (
              <option key={d.dsId} value={d.dsId}>
                {d.name} · {d.vcenterId} · {gbTb(d.usedGB)}/{gbTb(d.capGB)} ({d.usagePct}%)
              </option>
            ))}
          </select>
        </div>
      </div>
      {err && <div className="muted" style={{ fontSize: 12, marginTop: 6, color: 'var(--amber)' }}>⚠ {err}</div>}

      {sel && series && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12.5 }}>
            <b>{selMeta?.name || sel}</b>
            <span className="muted"> · {series.vcenterId || selMeta?.vcenterId} · {selMeta?.type || '—'}</span>
            {dsLast && (
              <span style={{ marginLeft: 10 }}>
                현재 {gbTb(dsLast.usedGB)} / {gbTb(dsLast.capGB)}
                <span className="muted"> · {days}일 증감 </span>
                <b style={{ color: dsDelta > 0 ? 'var(--amber)' : dsDelta < 0 ? 'var(--green)' : undefined }}>
                  {dsDelta > 0 ? '+' : ''}{gbTb(dsDelta)}
                </b>
              </span>
            )}
          </div>
          {dsChart.length === 0 ? (
            <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>이 기간에 관측된 스냅샷이 없습니다.</div>
          ) : (
            <div style={{ width: '100%', height: 230, marginTop: 8 }}>
              <ResponsiveContainer>
                <ComposedChart data={dsChart} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,.18)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="v" tick={{ fontSize: 11 }} domain={[0, 'auto']} />
                  <YAxis yAxisId="pct" orientation="right" tick={{ fontSize: 11 }} domain={[0, 100]} unit="%" />
                  <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(148,163,184,.3)', fontSize: 12 }}
                    formatter={(v, n) => [n === 'pct' ? `${v}%` : `${Number(v).toLocaleString()} ${unit}`,
                      n === 'cap' ? '총 용량' : n === 'used' ? '사용량' : '사용률']} />
                  <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => (v === 'cap' ? `총 용량(${unit})` : v === 'used' ? `사용량(${unit})` : '사용률(%)')} />
                  <Bar yAxisId="v" dataKey="used" fill="#f59e0b" fillOpacity={0.85} maxBarSize={26} />
                  <Line yAxisId="v" type="monotone" dataKey="cap" stroke="#60a5fa" strokeWidth={2} dot={false} />
                  <Line yAxisId="pct" type="monotone" dataKey="pct" stroke="#a78bfa" strokeWidth={1.2} strokeDasharray="2 2" dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        <b style={{ fontSize: 12.5 }}>기간 증감 상위 {top ? `(변화 ${top.changedCount ?? 0}/${top.total ?? 0}개)` : ''}</b>
        {!top ? <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>불러오는 중…</div> : (top.items || []).length === 0 ? (
          <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>표시할 데이터스토어가 없습니다(첫 스냅샷 이후부터 집계).</div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: '36vh', marginTop: 6 }}>
            <table>
              <thead>
                <tr>
                  <th>데이터스토어</th><th>vCenter</th><th>유형</th>
                  <th style={{ textAlign: 'right' }}>현재 사용</th><th style={{ textAlign: 'right' }}>총 용량</th>
                  <th style={{ textAlign: 'right' }}>사용률</th><th style={{ textAlign: 'right' }}>{days}일 증감</th>
                </tr>
              </thead>
              <tbody>
                {(top.items || []).map((d) => (
                  <tr key={d.dsId} onClick={() => setSel(d.dsId)}
                    style={{ cursor: 'pointer', ...(sel === d.dsId ? { background: 'rgba(96,165,250,.08)' } : {}) }}
                    title="클릭하면 위 차트에 이 데이터스토어의 추이를 표시">
                    <td><b>{d.name}</b></td>
                    <td className="muted" style={{ fontSize: 11.5 }}>{d.vcenterId}</td>
                    <td className="muted" style={{ fontSize: 11.5 }}>{d.type || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{gbTb(d.usedGB)}</td>
                    <td style={{ textAlign: 'right' }} className="muted">{gbTb(d.capGB)}</td>
                    <td style={{ textAlign: 'right', color: pctColor(d.usagePct || 0) }}>{d.usagePct}%</td>
                    <td style={{ textAlign: 'right', color: d.deltaGB > 0 ? 'var(--amber)' : d.deltaGB < 0 ? 'var(--green)' : undefined }}>
                      <b>{d.deltaGB > 0 ? '+' : ''}{gbTb(d.deltaGB)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const DS_KIND = {
  ds_changed: { label: '사용량 변화', badge: 'amber' },
  ds_added: { label: '연결 추가', badge: 'green' },
  ds_removed: { label: '연결 해제', badge: 'red' },
};

/** 사용량 변화 데이터스토어 상세 — VM 추이 화면과 같은 엔드포인트를 쓴다(단일 진실). */
function DsDetail({ title, snapId = null, slot = null, onClose }) {
  const [items, setItems] = useState(null);
  const [err, setErr] = useState(null);
  const [kind, setKind] = useState('all');
  useEffect(() => {
    fetchJson('/tools/vm-track/ds-changes', { ...(snapId != null ? { snapId } : {}), ...(slot ? { slot } : {}) })
      .then((d) => setItems(d.items || []))
      .catch((e) => setErr(e.message));
  }, [snapId, slot]);

  const shown = useMemo(() => (items || []).filter((r) => kind === 'all' || r.kind === kind), [items, kind]);
  const countOf = (k) => (items || []).filter((r) => r.kind === k).length;
  const sumDelta = (items || []).reduce((a, r) => a + (r.deltaGB || 0), 0);

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <EscClose onClose={onClose} />
      <div className="modal card" style={{ maxWidth: 1000 }}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        {err && <div style={{ color: 'var(--red)', fontSize: 12.5 }}>⚠ {err}</div>}
        {!items && !err && <Loading />}
        {items && (
          <>
            <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 8, fontSize: 12.5 }}>
              <button className={kind === 'all' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 11px', fontSize: 12 }} onClick={() => setKind('all')}>전체 {items.length}</button>
              {Object.entries(DS_KIND).map(([k, m]) => (
                <button key={k} className={kind === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 11px', fontSize: 12 }} onClick={() => setKind(k)}>{m.label} {countOf(k)}</button>
              ))}
              <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>합계 증감 <b style={{ color: sumDelta > 0 ? 'var(--amber)' : sumDelta < 0 ? 'var(--green)' : 'var(--text)' }}>{sumDelta > 0 ? '+' : ''}{gbTb(sumDelta)}</b></span>
            </div>
            {shown.length === 0 ? <div className="muted" style={{ fontSize: 13 }}>해당 항목이 없습니다.</div> : (
              <div className="table-wrap" style={{ maxHeight: '56vh' }}>
                <table>
                  <thead>
                    <tr>
                      <th>구분</th><th>데이터스토어</th>{items.some((r) => r.vcenterId) && <th>vCenter</th>}<th>유형</th>
                      <th style={{ textAlign: 'right' }}>증감</th><th style={{ textAlign: 'right' }}>이전 사용</th>
                      <th style={{ textAlign: 'right' }}>현재 사용</th><th style={{ textAlign: 'right' }}>총 용량</th>
                      <th style={{ textAlign: 'right' }}>가용</th><th style={{ textAlign: 'right' }}>사용률</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r, i) => (
                      <tr key={`${r.dsId}:${i}`}>
                        <td><span className={`badge ${(DS_KIND[r.kind] || {}).badge || 'gray'}`}>{(DS_KIND[r.kind] || {}).label || r.kind}</span></td>
                        <td><b>{r.name || r.dsId}</b></td>
                        {items.some((x) => x.vcenterId) && <td className="muted" style={{ fontSize: 11.5 }}>{r.vcenterId || '—'}</td>}
                        <td className="muted" style={{ fontSize: 11.5 }}>{r.type || '—'}</td>
                        <td style={{ textAlign: 'right', color: (r.deltaGB || 0) > 0 ? 'var(--amber)' : (r.deltaGB || 0) < 0 ? 'var(--green)' : undefined }}>
                          {r.deltaGB == null ? '—' : `${r.deltaGB > 0 ? '+' : ''}${gbTb(r.deltaGB)}`}
                        </td>
                        <td style={{ textAlign: 'right' }} className="muted">{gbTb(r.prevUsedGB)}</td>
                        <td style={{ textAlign: 'right' }}>{gbTb(r.usedGB)}</td>
                        <td style={{ textAlign: 'right' }} className="muted">{gbTb(r.capGB)}</td>
                        <td style={{ textAlign: 'right' }} className="muted">{gbTb(r.freeGB)}</td>
                        <td style={{ textAlign: 'right', color: pctColor(r.usagePct || 0) }}>{r.usagePct == null ? '—' : `${r.usagePct}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        <div className="flex gap" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          <button className="login-btn" style={{ padding: '8px 18px' }} onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
}
