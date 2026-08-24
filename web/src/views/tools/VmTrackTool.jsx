// VM 수량 추이(v2.345, 사용자 요구) — vCenter별 매일 00/12시 스냅샷을 차트·표로 본다.
// · 전체 합계 라인 + vCenter 선택(단위 vCenter 추이)
// · 증감(+N/-N) 숫자를 누르면 그 슬롯에 생성/삭제된 VM 과 위치(클러스터·호스트·데이터스토어)
// 데이터는 서버 전용 DB(vm-track.db)에서 오고, 사용자 데이터 범위(scope)는 서버가 강제한다.
import React, { useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend, ReferenceLine } from 'recharts';
import { fetchJson, postJson } from '../../api.js';
import { Loading, ErrorBox, Kpi } from '../../components/ui.jsx';
import EscClose from '../../components/EscClose.jsx';
import { fmtAgo } from '../../util/fmt.js';

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

  const load = () => fetchJson('/tools/vm-track', { days, vcenterId })
    .then((d) => { setData(d); setError(null); })
    .catch((e) => setError(e.message));
  // load 는 매 렌더 재생성되므로 deps 에 넣으면 무한 루프 — 조회 파라미터만 의존한다(기존 뷰 관례).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [days, vcenterId]);

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const points = data.points || [];
  const chart = points.map((p) => ({
    ...p,
    label: slotLabel(p.slot),
    delta: (p.added || 0) - (p.removed || 0),
    // 꺼짐 수 — 서버가 offCount 를 주지만 구버전 응답 호환으로 total-on 폴백.
    offCount: p.offCount ?? (p.total - p.onCount),
  }));
  const last = points[points.length - 1] || null;
  const first = points[0] || null;
  const netRange = last && first ? last.total - first.total : 0;
  const sumAdded = points.reduce((a, p) => a + (p.added || 0), 0);
  const sumRemoved = points.reduce((a, p) => a + (p.removed || 0), 0);
  const sumOn = points.reduce((a, p) => a + (p.poweredOn || 0), 0);
  const sumOff = points.reduce((a, p) => a + (p.poweredOff || 0), 0);
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
