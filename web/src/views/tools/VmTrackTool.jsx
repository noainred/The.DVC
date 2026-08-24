// VM 수량 추이(v2.345, 사용자 요구) — vCenter별 매일 00/12시 스냅샷을 차트·표로 본다.
// · 전체 합계 라인 + vCenter 선택(단위 vCenter 추이)
// · 증감(+N/-N) 숫자를 누르면 그 슬롯에 생성/삭제된 VM 과 위치(클러스터·호스트·데이터스토어)
// 데이터는 서버 전용 DB(vm-track.db)에서 오고, 사용자 데이터 범위(scope)는 서버가 강제한다.
import React, { useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, ComposedChart, LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend, ReferenceLine } from 'recharts';
import { fetchJson, postJson } from '../../api.js';
import { Loading, ErrorBox, Kpi } from '../../components/ui.jsx';
import EscClose from '../../components/EscClose.jsx';
import { fmtAgo } from '../../util/fmt.js';
import { hasDsData } from './storageTrack.js';

const DAY_OPTS = [7, 30, 90, 365];
// 슬롯 라벨: '8/21 00시' — 하루 2점이라 날짜만으로는 구분이 안 된다.
const slotLabel = (slot) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(00|12)$/.exec(String(slot || ''));
  return m ? `${Number(m[2])}/${Number(m[3])} ${m[4]}시` : String(slot || '');
};

export default function VmTrackTool() {
  const [days, setDays] = useState(30);
  const [vcenterId, setVcenterId] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [detail, setDetail] = useState(null); // { title, snapId?, slot? } — 증감 클릭 상세 모달
  const [dsDetail, setDsDetail] = useState(null); // 데이터스토어 사용량 변경 상세(v2.348)

  const load = () => fetchJson('/tools/vm-track', { days, vcenterId })
    .then((d) => { setData(d); setError(null); })
    .catch((e) => setError(e.message));
  // load 는 매 렌더 재생성되므로 deps 에 넣으면 무한 루프 — 조회 파라미터만 의존한다(기존 뷰 관례).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [days, vcenterId]);

  if (error && !data) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const points = data.points || [];
  const chart = points.map((p, i, arr) => ({
    ...p,
    label: slotLabel(p.slot),
    delta: (p.added || 0) - (p.removed || 0),
    // 꺼짐 수 — 서버가 offCount 를 주지만 구버전 응답 호환으로 total-on 폴백.
    offCount: p.offCount ?? (p.total - p.onCount),
    // 데이터스토어(v2.348): 차트는 TB 로 그린다(수백 TB 규모라 GB 축은 읽기 어렵다).
    // v2.348 이전 버전에서 만들어진 행은 ds 열이 0 — 0 으로 그리면 라인이 바닥으로 꺼지고
    // 다음 슬롯 증감이 '전체 사용량'으로 잡힌다(실제 발생). null(차트 공백) + 증감 0 처리.
    dsCapTB: hasDsData(p) ? Math.round(((p.dsCapGB || 0) / 1024) * 10) / 10 : null,
    dsUsedTB: hasDsData(p) ? Math.round(((p.dsUsedGB || 0) / 1024) * 10) / 10 : null,
    dsUsagePct: hasDsData(p) ? (p.dsUsagePct ?? 0) : null,
    // 슬롯 간 사용량 증감(GB) — 첫 점(또는 직전이 구버전 행)은 기준이 없어 0.
    dsDeltaGB: hasDsData(p) && i > 0 && hasDsData(arr[i - 1])
      ? Math.round(((p.dsUsedGB || 0) - (arr[i - 1].dsUsedGB || 0)) * 10) / 10 : 0,
  }));
  const last = points[points.length - 1] || null;
  const first = points[0] || null;
  const netRange = last && first ? last.total - first.total : 0;
  const sumAdded = points.reduce((a, p) => a + (p.added || 0), 0);
  const sumRemoved = points.reduce((a, p) => a + (p.removed || 0), 0);
  const sumOn = points.reduce((a, p) => a + (p.poweredOn || 0), 0);
  const sumOff = points.reduce((a, p) => a + (p.poweredOff || 0), 0);
  // 데이터스토어(v2.348): TB 환산은 화면에서만(저장은 GB REAL). 기간 사용량 증감 = 마지막 - 처음.
  const tb = (gb) => Math.round(((Number(gb) || 0) / 1024) * 10) / 10;
  // 기간 증감의 기준은 DS 데이터가 있는 첫 스냅샷 — 구버전(ds 열 0) 행을 기준으로 잡으면
  // '0 → 현재 사용량' 전체가 증가로 계산돼 +2만 TB 로 표시됐다(v2.351 수정).
  const dsFirst = points.find(hasDsData) || null;
  const dsLast = [...points].reverse().find(hasDsData) || null;
  const dsNet = dsLast && dsFirst ? Math.round(((dsLast.dsUsedGB || 0) - (dsFirst.dsUsedGB || 0)) * 10) / 10 : 0;
  const bySlotVc = data.bySlotVc || {};

  const snapshotNow = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/tools/vm-track/snapshot', {});
      setMsg(r.ok
        ? `스냅샷 완료 — ${r.slot} · vCenter ${r.vcenters} · 총 ${r.total}대 (+${r.added}/-${r.removed})${r.baseline ? ' · 기준선(증감은 다음 슬롯부터)' : ''}`
        : (r.reason || '실패'));
      await load();
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 12 }}>
        <div>
          <div className="section-title" style={{ margin: 0 }}>📈 VM 수량 추이</div>
          <div className="muted" style={{ fontSize: 12 }}>
            매일 <b>00시·12시</b> 기준 vCenter별 VM 수를 전용 DB에 스냅샷하고 증감을 추적합니다.
            증감(+N/−N)을 누르면 그 시각에 <b>생성·삭제된 VM</b>과 클러스터·호스트·데이터스토어를 봅니다.
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
        <Kpi label={vcenterId ? '현재 VM(선택 vCenter)' : '현재 VM(전체)'} value={last ? last.total.toLocaleString() : '—'}
          meta={last ? `켜짐 ${last.onCount.toLocaleString()} · ${fmtAgo(last.collectedAt)}` : '스냅샷 없음'} />
        <Kpi label={`${days}일 순증감`} value={`${netRange >= 0 ? '+' : ''}${netRange.toLocaleString()}`}
          accent={netRange > 0 ? 'var(--green)' : netRange < 0 ? 'var(--red)' : undefined} />
        <Kpi label={`${days}일 생성/삭제`} value={`+${sumAdded.toLocaleString()} / -${sumRemoved.toLocaleString()}`} />
        <Kpi label="현재 켜짐/꺼짐" value={last ? `${last.onCount.toLocaleString()} / ${(last.offCount ?? (last.total - last.onCount)).toLocaleString()}` : '—'}
          meta={last ? `켜짐 ${last.total ? Math.round((last.onCount / last.total) * 100) : 0}%` : ''} />
        <Kpi label={`${days}일 전원 On/Off 전환`} value={`↑${sumOn.toLocaleString()} / ↓${sumOff.toLocaleString()}`}
          meta={data.poller?.lastResult ? `최근 스냅샷 ${fmtAgo(data.poller.lastResult.at)}` : `스냅샷 ${(data.meta?.n || 0).toLocaleString()}건`} />
        {/* 데이터스토어 사용량(v2.348) — DS 데이터가 있는 마지막 스냅샷 기준(구버전 행 제외) */}
        <Kpi label="데이터스토어 사용량" value={dsLast ? `${tb(dsLast.dsUsedGB)} / ${tb(dsLast.dsCapGB)} TB` : '—'}
          pct={dsLast ? Math.round(dsLast.dsUsagePct || 0) : undefined}
          meta={dsLast ? `${(dsLast.dsCount || 0).toLocaleString()}개 · 가용 ${tb((dsLast.dsCapGB || 0) - (dsLast.dsUsedGB || 0))} TB` : '스냅샷 없음'} />
        <Kpi label={`${days}일 사용량 증감`} value={`${dsNet >= 0 ? '+' : ''}${tb(dsNet)} TB`}
          accent={dsNet > 0 ? 'var(--amber)' : dsNet < 0 ? 'var(--green)' : undefined}
          meta={`${dsNet >= 0 ? '+' : ''}${dsNet.toLocaleString()} GB`} />
      </div>

      {points.length === 0 ? (
        <div className="card" style={{ padding: 16, fontSize: 13 }}>
          <b>아직 스냅샷이 없습니다.</b>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.7 }}>
            폴러가 다음 00시 또는 12시에 첫 스냅샷(기준선)을 만듭니다. 지금 바로 시작하려면 <b>⚡ 지금 스냅샷</b>을 누르세요.
            첫 스냅샷은 기준선이라 증감이 0이고, 그 다음 슬롯부터 생성·삭제가 집계됩니다.
          </div>
        </div>
      ) : (
        <>
          {/* 총량 추이 — 전체 또는 선택 vCenter */}
          <div className="card" style={{ padding: 12, marginBottom: 12 }}>
            <b style={{ fontSize: 13 }}>총 VM 수 추이 {vcenterId ? `— ${vcenterId}` : '— 전체 vCenter 합계'}</b>
            <div style={{ width: '100%', height: 260, marginTop: 8 }}>
              <ResponsiveContainer>
                <LineChart data={chart} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,.18)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
                  <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(148,163,184,.3)', fontSize: 12 }}
                    formatter={(v, n) => [Number(v).toLocaleString(), n === 'total' ? '총 VM' : '켜짐']} />
                  <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => (v === 'total' ? '총 VM' : '켜짐')} />
                  <Line type="monotone" dataKey="total" stroke="#60a5fa" strokeWidth={2} dot={{ r: 2 }} />
                  <Line type="monotone" dataKey="onCount" stroke="#22c55e" strokeWidth={1.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* 켜짐/꺼짐 수량 추이(v2.347, 사용자 요구) — 총량과 별개로 전원 상태별 규모 변화 */}
          <div className="card" style={{ padding: 12, marginBottom: 12 }}>
            <b style={{ fontSize: 13 }}>켜진 VM / 꺼진 VM 수량 추이</b>
            <div style={{ width: '100%', height: 240, marginTop: 8 }}>
              <ResponsiveContainer>
                <LineChart data={chart} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,.18)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
                  <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(148,163,184,.3)', fontSize: 12 }}
                    formatter={(v, n) => [Number(v).toLocaleString(), n === 'onCount' ? '켜짐' : '꺼짐']} />
                  <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => (v === 'onCount' ? '켜짐(Powered On)' : '꺼짐(Powered Off)')} />
                  <Line type="monotone" dataKey="onCount" stroke="#22c55e" strokeWidth={2} dot={{ r: 2 }} />
                  <Line type="monotone" dataKey="offCount" stroke="#f59e0b" strokeWidth={2} dot={{ r: 2 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* 슬롯별 전원 전환 — 어떤 VM 이 켜졌/꺼졌는지는 표에서 클릭 */}
          <div className="card" style={{ padding: 12, marginBottom: 12 }}>
            <b style={{ fontSize: 13 }}>슬롯별 전원 전환(Off→On / On→Off)</b>
            <span className="muted" style={{ fontSize: 11.5, marginLeft: 8 }}>신규 생성·삭제는 여기 포함되지 않습니다(아래 생성/삭제 차트에 집계)</span>
            <div style={{ width: '100%', height: 190, marginTop: 8 }}>
              <ResponsiveContainer>
                <BarChart data={chart} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,.18)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(148,163,184,.3)', fontSize: 12 }}
                    formatter={(v, n) => [Number(v).toLocaleString(), n === 'poweredOn' ? '전원 켜짐' : '전원 꺼짐']} />
                  <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => (v === 'poweredOn' ? '전원 켜짐(Off→On)' : '전원 꺼짐(On→Off)')} />
                  <ReferenceLine y={0} stroke="rgba(148,163,184,.4)" />
                  <Bar dataKey="poweredOn" fill="#22c55e" />
                  <Bar dataKey="poweredOff" fill="#f59e0b" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* 데이터스토어 용량/사용량 추이(v2.348, 사용자 요구) — vCenter 에 연결된 DS 합계 */}
          <div className="card" style={{ padding: 12, marginBottom: 12 }}>
            <b style={{ fontSize: 13 }}>데이터스토어 용량/사용량 추이 {vcenterId ? `— ${vcenterId}` : '— 전체 vCenter 합계'}</b>
            <span className="muted" style={{ fontSize: 11.5, marginLeft: 8 }}>vCenter 에 연결된 데이터스토어 기준(TB) · 오른쪽 축은 사용률(%)</span>
            {/* 사용자 요구 형태(v2.352): 총 용량 = 상단 한도선(라인), 슬롯별 사용량 = 막대(축 0부터). */}
            <div style={{ width: '100%', height: 250, marginTop: 8 }}>
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
                  <Line yAxisId="pct" type="monotone" dataKey="dsUsagePct" stroke="#a78bfa" strokeWidth={1.2} strokeDasharray="4 3" dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* 슬롯별 데이터스토어 사용량 증감(GB) */}
          <div className="card" style={{ padding: 12, marginBottom: 12 }}>
            <b style={{ fontSize: 13 }}>슬롯별 데이터스토어 사용량 증감(GB)</b>
            <span className="muted" style={{ fontSize: 11.5, marginLeft: 8 }}>표에서 증감을 누르면 어떤 데이터스토어가 늘거나 줄었는지 봅니다</span>
            <div style={{ width: '100%', height: 190, marginTop: 8 }}>
              <ResponsiveContainer>
                <BarChart data={chart} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,.18)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(148,163,184,.3)', fontSize: 12 }}
                    formatter={(v) => [`${Number(v).toLocaleString()} GB`, '사용량 증감']} />
                  <ReferenceLine y={0} stroke="rgba(148,163,184,.4)" />
                  <Bar dataKey="dsDeltaGB" fill="#f59e0b" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* 슬롯별 증감 — 막대(생성 +, 삭제 −) */}
          <div className="card" style={{ padding: 12, marginBottom: 12 }}>
            <b style={{ fontSize: 13 }}>슬롯별 증감(생성/삭제)</b>
            <div style={{ width: '100%', height: 200, marginTop: 8 }}>
              <ResponsiveContainer>
                <BarChart data={chart} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,.18)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(148,163,184,.3)', fontSize: 12 }}
                    formatter={(v, n) => [Number(v).toLocaleString(), n === 'added' ? '생성' : '삭제']} />
                  <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => (v === 'added' ? '생성' : '삭제')} />
                  <ReferenceLine y={0} stroke="rgba(148,163,184,.4)" />
                  <Bar dataKey="added" fill="#22c55e" />
                  <Bar dataKey="removed" fill="#ef4444" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* 스냅샷 표 — 증감 클릭 → 상세 */}
          <div className="card" style={{ padding: 12 }}>
            <b style={{ fontSize: 13 }}>스냅샷 이력 <span className="muted" style={{ fontWeight: 400, fontSize: 11.5 }}>(증감 숫자를 누르면 어떤 VM 인지 봅니다)</span></b>
            <div className="table-wrap" style={{ maxHeight: '46vh', marginTop: 8 }}>
              <table>
                <thead>
                  <tr>
                    <th>시각</th><th style={{ textAlign: 'right' }}>총 VM</th>
                    <th style={{ textAlign: 'right' }}>켜짐</th><th style={{ textAlign: 'right' }}>꺼짐</th>
                    <th style={{ textAlign: 'right' }}>생성</th><th style={{ textAlign: 'right' }}>삭제</th>
                    <th style={{ textAlign: 'right' }}>전원↑</th><th style={{ textAlign: 'right' }}>전원↓</th>
                    <th style={{ textAlign: 'right' }}>순증감</th>
                    <th style={{ textAlign: 'right' }}>DS 사용/용량</th>
                    <th style={{ textAlign: 'right' }}>DS 사용률</th>
                    <th style={{ textAlign: 'right' }}>DS 증감</th>
                    {!vcenterId && <th>vCenter별 증감</th>}
                    <th>수집</th>
                  </tr>
                </thead>
                <tbody>
                  {[...points].reverse().map((p) => {
                    const net = (p.added || 0) - (p.removed || 0);
                    const off = p.offCount ?? (p.total - p.onCount);
                    // 상세 모달은 같은 슬롯 데이터를 열고 kind 로 초기 필터만 다르게 준다.
                    const open = (focus) => setDetail({
                      title: `${slotLabel(p.slot)} 변경 내역${vcenterId ? ` — ${vcenterId}` : ' — 전체 vCenter'}`,
                      slot: vcenterId ? null : p.slot, snapId: vcenterId ? p.snapId : null, focus,
                    });
                    return (
                      <tr key={p.slot}>
                        <td><b>{slotLabel(p.slot)}</b>{p.baseline && <span className="badge gray" style={{ marginLeft: 6, fontSize: 10 }}>기준선</span>}</td>
                        <td style={{ textAlign: 'right' }}>{p.total.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', color: 'var(--green)' }}>{p.onCount.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', color: 'var(--amber)' }}>{off.toLocaleString()}</td>
                        <td style={{ textAlign: 'right' }}>
                          {p.added ? <button className="tab" style={{ padding: '2px 8px', fontSize: 12, color: 'var(--green)' }} onClick={() => open('added')} title="생성된 VM 보기">+{p.added}</button> : <span className="muted">0</span>}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {p.removed ? <button className="tab" style={{ padding: '2px 8px', fontSize: 12, color: 'var(--red)' }} onClick={() => open('removed')} title="삭제된 VM 보기">-{p.removed}</button> : <span className="muted">0</span>}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {p.poweredOn ? <button className="tab" style={{ padding: '2px 8px', fontSize: 12, color: 'var(--green)' }} onClick={() => open('powered_on')} title="전원이 켜진(Off→On) VM 보기">↑{p.poweredOn}</button> : <span className="muted">0</span>}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {p.poweredOff ? <button className="tab" style={{ padding: '2px 8px', fontSize: 12, color: 'var(--amber)' }} onClick={() => open('powered_off')} title="전원이 꺼진(On→Off) VM 보기">↓{p.poweredOff}</button> : <span className="muted">0</span>}
                        </td>
                        <td style={{ textAlign: 'right', color: net > 0 ? 'var(--green)' : net < 0 ? 'var(--red)' : undefined }}>{net > 0 ? `+${net}` : net}</td>
                        {/* 데이터스토어(v2.348) — 사용/용량(TB), 사용률, 직전 슬롯 대비 사용량 증감(GB, 클릭 시 상세) */}
                        <td style={{ textAlign: 'right', fontSize: 12 }}>
                          {p.dsCount ? <>{tb(p.dsUsedGB)} / {tb(p.dsCapGB)} TB <span className="muted" style={{ fontSize: 11 }}>({p.dsCount})</span></> : <span className="muted">—</span>}
                        </td>
                        <td style={{ textAlign: 'right', fontSize: 12, color: (p.dsUsagePct || 0) >= 90 ? 'var(--red)' : (p.dsUsagePct || 0) >= 75 ? 'var(--amber)' : undefined }}>
                          {p.dsCount ? `${p.dsUsagePct ?? 0}%` : '—'}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {(() => {
                            const row = chart.find((c) => c.slot === p.slot);
                            const d = row?.dsDeltaGB || 0;
                            if (!d) return <span className="muted">0</span>;
                            return (
                              <button className="tab" style={{ padding: '2px 8px', fontSize: 12, color: d > 0 ? 'var(--amber)' : 'var(--green)' }}
                                title="사용량이 늘거나 줄어든 데이터스토어 보기"
                                onClick={() => setDsDetail({
                                  title: `${slotLabel(p.slot)} 데이터스토어 사용량 변화${vcenterId ? ` — ${vcenterId}` : ' — 전체 vCenter'}`,
                                  slot: vcenterId ? null : p.slot, snapId: vcenterId ? p.snapId : null,
                                })}>
                                {d > 0 ? `+${d.toLocaleString()}` : d.toLocaleString()} GB
                              </button>
                            );
                          })()}
                        </td>
                        {!vcenterId && (
                          <td style={{ fontSize: 11.5 }}>
                            {(bySlotVc[p.slot] || []).filter((v) => v.added || v.removed || v.poweredOn || v.poweredOff).map((v) => (
                              <button key={v.vcenterId} className="tab" style={{ padding: '1px 7px', fontSize: 11, marginRight: 4, marginBottom: 2 }}
                                title={`${v.vcenterId} — 생성 ${v.added} · 삭제 ${v.removed} · 전원↑ ${v.poweredOn || 0} · 전원↓ ${v.poweredOff || 0} (누르면 상세)`}
                                onClick={() => setDetail({ title: `${slotLabel(p.slot)} — ${v.vcenterId}`, snapId: v.snapId })}>
                                {v.vcenterId}
                                {v.added ? <b style={{ color: 'var(--green)' }}> +{v.added}</b> : null}
                                {v.removed ? <b style={{ color: 'var(--red)' }}> -{v.removed}</b> : null}
                                {v.poweredOn ? <b style={{ color: 'var(--green)' }}> ↑{v.poweredOn}</b> : null}
                                {v.poweredOff ? <b style={{ color: 'var(--amber)' }}> ↓{v.poweredOff}</b> : null}
                              </button>
                            )) }
                            {!(bySlotVc[p.slot] || []).some((v) => v.added || v.removed || v.poweredOn || v.poweredOff) && <span className="muted">변화 없음</span>}
                          </td>
                        )}
                        <td className="muted" style={{ fontSize: 11.5 }}>{fmtAgo(p.collectedAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {detail && <ChangeDetail {...detail} onClose={() => setDetail(null)} />}
      {dsDetail && <DsChangeDetail {...dsDetail} onClose={() => setDsDetail(null)} />}
    </div>
  );
}

const DS_KIND_META = {
  ds_changed: { label: '사용량 변화', badge: 'amber' },
  ds_added: { label: '연결 추가', badge: 'green' },
  ds_removed: { label: '연결 해제', badge: 'red' },
};

/**
 * 데이터스토어 사용량 변화 상세(v2.348) — 어떤 DS 가 얼마나 늘거나 줄었는지 + 연결/해제.
 * 사용량 변화는 임계(기본 1GB) 이상만 기록되므로, 미세 변동은 목록에 나오지 않는다(화면에 명시).
 */
function DsChangeDetail({ title, snapId = null, slot = null, onClose }) {
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
  const gbTb = (gb) => (gb == null ? '—' : (Math.abs(gb) >= 1024 ? `${(gb / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} TB` : `${Math.round(gb).toLocaleString()} GB`));
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
              {Object.entries(DS_KIND_META).map(([k, m]) => (
                <button key={k} className={kind === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 11px', fontSize: 12 }} onClick={() => setKind(k)}>
                  {m.label} {countOf(k)}
                </button>
              ))}
              <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>합계 증감 <b style={{ color: sumDelta > 0 ? 'var(--amber)' : sumDelta < 0 ? 'var(--green)' : 'var(--text)' }}>{sumDelta > 0 ? '+' : ''}{gbTb(sumDelta)}</b></span>
            </div>
            {shown.length === 0 ? <div className="muted" style={{ fontSize: 13 }}>해당 항목이 없습니다.</div> : (
              <div className="table-wrap" style={{ maxHeight: '56vh' }}>
                <table>
                  <thead>
                    <tr>
                      <th>구분</th><th>데이터스토어</th>{items.some((r) => r.vcenterId) && <th>vCenter</th>}
                      <th>유형</th>
                      <th style={{ textAlign: 'right' }}>증감</th>
                      <th style={{ textAlign: 'right' }}>이전 사용</th><th style={{ textAlign: 'right' }}>현재 사용</th>
                      <th style={{ textAlign: 'right' }}>총 용량</th><th style={{ textAlign: 'right' }}>가용</th>
                      <th style={{ textAlign: 'right' }}>사용률</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r, i) => (
                      <tr key={`${r.dsId}:${i}`}>
                        <td><span className={`badge ${(DS_KIND_META[r.kind] || {}).badge || 'gray'}`}>{(DS_KIND_META[r.kind] || {}).label || r.kind}</span></td>
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
                        <td style={{ textAlign: 'right', color: (r.usagePct || 0) >= 90 ? 'var(--red)' : (r.usagePct || 0) >= 75 ? 'var(--amber)' : undefined }}>
                          {r.usagePct == null ? '—' : `${r.usagePct}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.7 }}>
              사용량 변화는 <b>1GB 이상 바뀐 데이터스토어</b>만 기록합니다(미세 변동은 목록에 없지만 상단 차트의 합계 추이에는 정확히 반영됩니다 — 임계는 <code>VMTRACK_DS_DELTA_MIN_GB</code>).
              '연결 해제'된 DS 의 수치는 사라지기 직전 관측치입니다.
            </div>
          </>
        )}
        <div className="flex gap" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          <button className="login-btn" style={{ padding: '8px 18px' }} onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
}

// 변경 종류 메타 — 라벨·배지색을 한 곳에서 관리(표·필터·모달 공용).
const KIND_META = {
  added: { label: '생성', badge: 'green' },
  removed: { label: '삭제', badge: 'red' },
  powered_on: { label: '전원 켜짐', badge: 'green' },
  powered_off: { label: '전원 꺼짐', badge: 'amber' },
};

/** 변경 상세 — 생성/삭제/전원 전환 VM + 클러스터·호스트·데이터스토어(사용자 요구). */
function ChangeDetail({ title, snapId = null, slot = null, focus = 'all', onClose }) {
  const [items, setItems] = useState(null);
  const [err, setErr] = useState(null);
  const [kind, setKind] = useState(focus || 'all');
  useEffect(() => {
    fetchJson('/tools/vm-track/changes', { ...(snapId != null ? { snapId } : {}), ...(slot ? { slot } : {}) })
      .then((d) => setItems(d.items || []))
      .catch((e) => setErr(e.message));
  }, [snapId, slot]);

  const shown = useMemo(() => (items || []).filter((r) => kind === 'all' || r.kind === kind), [items, kind]);
  const countOf = (k) => (items || []).filter((r) => r.kind === k).length;
  const gb = (mb) => (mb == null ? '—' : `${Math.round(mb / 1024)}GB`);

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
              {Object.entries(KIND_META).map(([k, m]) => (
                <button key={k} className={kind === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 11px', fontSize: 12 }} onClick={() => setKind(k)}>
                  {m.label} {countOf(k)}
                </button>
              ))}
            </div>
            {shown.length === 0 ? <div className="muted" style={{ fontSize: 13 }}>해당 항목이 없습니다.</div> : (
              <div className="table-wrap" style={{ maxHeight: '56vh' }}>
                <table>
                  <thead>
                    <tr>
                      <th>구분</th><th>VM</th>{items.some((r) => r.vcenterId) && <th>vCenter</th>}
                      <th>클러스터</th><th>호스트</th><th>데이터스토어</th>
                      <th style={{ textAlign: 'right' }}>vCPU</th><th style={{ textAlign: 'right' }}>메모리</th>
                      <th style={{ textAlign: 'right' }}>디스크</th><th>전원</th><th>Guest OS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r, i) => (
                      <tr key={`${r.vmId}:${i}`}>
                        <td><span className={`badge ${(KIND_META[r.kind] || {}).badge || 'gray'}`}>{(KIND_META[r.kind] || {}).label || r.kind}</span></td>
                        <td><b>{r.name || r.vmId}</b></td>
                        {items.some((x) => x.vcenterId) && <td className="muted" style={{ fontSize: 11.5 }}>{r.vcenterId || '—'}</td>}
                        <td className="muted" style={{ fontSize: 12 }}>{r.cluster || '—'}</td>
                        <td className="muted" style={{ fontSize: 12 }}>{r.host || '—'}</td>
                        <td className="muted" style={{ fontSize: 12 }}>{r.datastore || '—'}</td>
                        <td style={{ textAlign: 'right' }}>{r.cpu ?? '—'}</td>
                        <td style={{ textAlign: 'right' }}>{gb(r.memMB)}</td>
                        <td style={{ textAlign: 'right' }}>{r.storageGB != null ? `${Math.round(r.storageGB)}GB` : '—'}</td>
                        <td className="muted" style={{ fontSize: 11.5 }}>{r.powerState === 'POWERED_ON' ? 'On' : r.powerState ? 'Off' : '—'}</td>
                        <td className="muted" style={{ fontSize: 11.5 }}>{r.guestOS || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.7 }}>
              삭제된 VM 의 위치 정보는 <b>사라지기 직전 스냅샷에 기록된 값</b>입니다(현재 조회 불가하므로 추적 DB 의 마지막 관측치).
              생성·전원 전환 VM 은 그 슬롯 수집 시점의 클러스터·호스트·데이터스토어입니다.
              전원 전환은 <b>두 스냅샷에 모두 있던 VM</b>만 집계하므로, 새로 만들어져 켜진 VM 은 '생성'에만 잡힙니다(중복 없음).
            </div>
          </>
        )}
        <div className="flex gap" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          <button className="login-btn" style={{ padding: '8px 18px' }} onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
}
