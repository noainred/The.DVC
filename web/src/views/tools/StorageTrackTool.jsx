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
