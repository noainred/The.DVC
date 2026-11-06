// 호스트 상세 ‘SAN 경로·트래픽’ 묶음(v2.915 — 시안 D-① HostSan · docs/design/san-cvp-traffic/README.md).
//   HBA ↔ 스위치 포트 ↔ zone ↔ 스토리지 귀속 + 기간 바이트(확정분/추정분 분리) + 24h 추이. 판정은 서버(sanswitch/attribution.js) 하나이고
//   문구는 hostSanText.js(순수). 마운트 1회 + 기간 버튼으로만 다시 받는다(무거운 집계 — 15초 폴링 금지). 늦게 온 이전 응답은 버린다.
import React, { useEffect, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { fetchJson } from '../api.js';
import { ErrorBox } from '../components/ui.jsx';
import { STable } from '../components/STable.jsx';
import { CONF, STATUS_LABEL, bytesText, rwText, confOf, confText, sanStateText, sanKpis, hbaTargetsText, storageNoteText, seriesRows, sanFootText } from './hostSanText.js';
import { agoText } from './tools/relTime.js';

const RANGES = [[24, '24시간'], [24 * 7, '7일']];
const hhmm = (ts) => new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
const Badge = ({ k }) => { const c = confOf(k); return <span className={`badge ${c.tone}`} title={c.note}>{c.glyph} {c.label}</span>; };

export default function HostSanSection({ hostId, onData }) {
  const [hours, setHours] = useState(24);
  const [got, setGot] = useState(null);      // { key, d }
  const [err, setErr] = useState(null);      // { key, e }
  const key = `${hostId}|${hours}`;
  useEffect(() => {
    const ac = new AbortController();
    setGot(null); setErr(null);
    fetchJson(`/hosts/${encodeURIComponent(hostId)}/san-attribution`, { hours }, ac.signal, { timeoutMs: 90_000, retries: 0 })
      .then((d) => { if (!ac.signal.aborted) { setGot({ key, d }); onData?.(d); } })
      .catch((e) => { if (!ac.signal.aborted) setErr({ key, e }); });
    return () => ac.abort();
  }, [hostId, hours]); // eslint-disable-line react-hooks/exhaustive-deps
  const d = got && got.key === key ? got.d : null;
  const error = err && err.key === key ? err.e : null;

  const seg = (
    <div className="san2-seg" role="group" aria-label="조회 기간">
      {RANGES.map(([h, l]) => <button key={h} type="button" className={hours === h ? 'on' : ''} aria-pressed={hours === h} onClick={() => setHours(h)}>{l}</button>)}
    </div>
  );
  if (error) return <><div className="flex" style={{ justifyContent: 'flex-end', marginBottom: 8 }}>{seg}</div><ErrorBox error={error} /></>;
  if (!d) return <div className="muted">SAN 귀속을 계산하는 중… (스위치 수에 따라 수십 초가 걸릴 수 있습니다)</div>;
  const state = sanStateText(d);
  const rows = seriesRows(d.series);
  const hasLine = rows.some((r) => r.gbps != null);
  return (
    <div className="hd-san">
      <div className="flex wrap" style={{ alignItems: 'center', gap: 8, justifyContent: 'space-between', marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 11.5 }}>{CONF.confirmed.glyph} 확정 · {CONF.estimated.glyph} 추정 · 확정분과 추정분은 합치지 않습니다 · 기간 바이트는 읽기+쓰기 합(방향 없음) · 지금 값만 읽기/쓰기</span>
        {seg}
      </div>
      {state && <div className="muted" style={{ marginBottom: 10 }}>{state}</div>}
      <div className="hd-kpis" style={{ marginBottom: 12 }}>
        {sanKpis(d).map((k) => <div key={k.l} className="ht-kpi"><span className="ht-kpi-l">{k.l}</span><span className="ht-kpi-v hd-kpi-v" style={{ fontSize: 16 }}>{k.v}</span><span className="ht-kpi-s" title={k.s}>{k.s || ' '}</span></div>)}
      </div>
      {d.hbas?.length > 0 && (
        <div className="table-wrap" style={{ maxHeight: '36vh' }}>
          <STable minWidth={900}>
            <thead><tr><th>어댑터</th><th>WWN</th><th>스위치 · 포트</th><th>로그인 · 역할</th><th>Zone</th><th>연결 스토리지</th><th>귀속</th><th style={{ textAlign: 'right' }}>지금 읽기 / 쓰기</th><th style={{ textAlign: 'right' }}>기간 전송</th></tr></thead>
            <tbody>
              {d.hbas.map((r, i) => (
                <tr key={`${r.hba}-${r.switch?.deviceId || ''}-${i}`}>
                  <td><b>{r.hba || '—'}</b>{r.model ? <div className="muted" style={{ fontSize: 11 }}>{r.model}{r.speedGbps ? ` · ${r.speedGbps} Gb` : ''}</div> : null}</td>
                  <td className="muted" style={{ fontSize: 11, fontFamily: 'var(--mono)' }}>{r.wwn || '—'}</td>
                  <td>{r.switch ? <>{r.switch.name}{r.port ? <span className="muted"> {r.port.slotPort ?? r.port.index}</span> : null}{r.switch.agent ? <div className="muted" style={{ fontSize: 11 }}>엣지 {r.switch.agent} · {agoText(r.switch.collectedAt)}</div> : <div className="muted" style={{ fontSize: 11 }}>{agoText(r.switch.collectedAt)}</div>}</> : <span className="muted">—</span>}</td>
                  <td data-sort={STATUS_LABEL[r.status] || ''}>
                    {r.status === 'logged-in' ? <span className="badge green">로그인</span> : <span className="badge gray">{STATUS_LABEL[r.status] || r.status}</span>}
                    {r.role ? <div className="muted" style={{ fontSize: 11 }} title={r.role.basis}>{r.role.side}{r.role.confidence === 'confirmed' ? ' · 네임서버' : ' · 추정'}</div> : null}
                  </td>
                  <td data-sort={r.zoneCount ?? 0}>{r.zoneCount ? <span title={(r.zones || []).join(', ')}>{r.zones?.slice(0, 2).join(', ')}{r.zoneCount > 2 ? ` 외 ${r.zoneCount - 2}` : ''}</span> : <span className="muted">—</span>}</td>
                  <td>{hbaTargetsText(r)}{r.narrowed ? <span className="muted" style={{ fontSize: 11 }}> · 멀티패스로 좁힘</span> : null}</td>
                  <td data-sort={r.conf || ''} title={r.basis}>{r.status === 'unseen' || r.status === 'no-wwn' ? <span className="muted">—</span> : <Badge k={r.conf} />}</td>
                  <td style={{ textAlign: 'right' }} data-sort={r.nowRead ?? ''}>{rwText(r.nowRead, r.nowWrite)}</td>
                  <td style={{ textAlign: 'right' }} data-sort={r.bytes ?? ''}>{r.measured ? bytesText(r.bytes) : <span className="muted" title="첫 수집·수집 공백·DB 없음 — 0 이 아니라 측정 없음">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        </div>
      )}
      {d.storages?.length > 0 && (
        <>
          <div className="muted" style={{ fontSize: 12, margin: '12px 0 6px' }}>스토리지별 귀속 — {d.storages.length}개 · 확정분과 추정분을 따로 적습니다</div>
          <div className="table-wrap" style={{ maxHeight: '30vh' }}>
            <STable minWidth={760}>
              <thead><tr><th>스토리지</th><th style={{ textAlign: 'right' }}>확정분</th><th style={{ textAlign: 'right' }}>추정분</th><th style={{ textAlign: 'right' }}>지금 읽기 / 쓰기(확정)</th><th>HBA 포트</th><th>타깃 포트</th><th>비고</th></tr></thead>
              <tbody>
                {d.storages.map((s) => (
                  <tr key={s.id}>
                    <td><b>{s.name}</b>{s.registered ? <span className="badge blue" style={{ marginLeft: 6 }}>등록</span> : null}<div className="muted" style={{ fontSize: 11 }}>{(s.zones || []).slice(0, 3).join(', ')}{s.zones?.length > 3 ? ` 외 ${s.zones.length - 3}` : ''}</div></td>
                    <td style={{ textAlign: 'right' }} data-sort={s.confirmedBytes ?? ''}>{s.confirmedBytes != null ? <><span title={CONF.confirmed.note}>{CONF.confirmed.glyph}</span> {bytesText(s.confirmedBytes)}</> : '—'}</td>
                    <td style={{ textAlign: 'right' }} data-sort={s.estimatedBytes ?? ''}>{s.estimatedBytes != null ? <><span title={CONF.estimated.note}>{CONF.estimated.glyph}</span> ≈ {bytesText(s.estimatedBytes)}</> : '—'}</td>
                    <td style={{ textAlign: 'right' }} data-sort={s.nowRead ?? ''}>{rwText(s.nowRead, s.nowWrite)}{s.nowReadEst != null || s.nowWriteEst != null ? <div className="muted" style={{ fontSize: 11 }}>≈ {rwText(s.nowReadEst, s.nowWriteEst)} 추정</div> : null}</td>
                    <td className="muted" style={{ fontSize: 11 }}>{[...(s.confirmedPorts || []).map((p) => `${CONF.confirmed.glyph} ${p}`), ...(s.estimatedPorts || []).map((p) => `${CONF.estimated.glyph} ${p}`), ...(s.unsplitPorts || []).map((p) => `— ${p}`), ...(s.zonedOnlyPorts || []).map((p) => `○ ${p}`)].join(' · ') || '—'}</td>
                    <td className="muted" style={{ fontSize: 11 }}>{(s.targetPorts || []).slice(0, 4).map((t) => `${t.switch} ${t.slotPort ?? t.port}`).join(' · ')}{s.targetPorts?.length > 4 ? ` 외 ${s.targetPorts.length - 4}` : ''}</td>
                    <td className="muted" style={{ fontSize: 11 }}>{storageNoteText(s)}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          </div>
        </>
      )}
      {rows.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>HBA 포트 처리량 합 · {hours === 24 ? '24시간' : `${hours / 24}일`} · 버킷 {d.bucketMs ? `${Math.round(d.bucketMs / 60000)}분` : '—'} 평균 · 읽기+쓰기 합</div>
          {hasLine ? (
            <div style={{ width: '100%', height: 160 }}>
              <ResponsiveContainer>
                <LineChart data={rows} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis dataKey="ts" tickFormatter={hhmm} stroke="var(--text-dim)" fontSize={11} minTickGap={40} />
                  <YAxis stroke="var(--text-dim)" fontSize={11} width={44} tickFormatter={(v) => `${v}G`} />
                  <Tooltip labelFormatter={(v) => new Date(v).toLocaleString('ko-KR')} formatter={(v) => [v == null ? '—' : `${v} Gbps`, '합']} contentStyle={{ background: 'var(--panel)', border: '1px solid var(--border)', fontSize: 12 }} />
                  <Line type="monotone" dataKey="gbps" stroke="#2dd4bf" dot={false} strokeWidth={1.6} connectNulls={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : <div className="muted">이 기간에 그릴 표본이 없습니다(측정 없음).</div>}
        </div>
      )}
      <div className="muted hd-note">{sanFootText(d)}{d.fabrics?.length ? ` · 스위치 ${d.fabrics.length}대${d.hbas?.some((r) => r.switch) ? ` — 로그인한 스위치 ${[...new Set(d.hbas.filter((r) => r.switch && r.status === 'logged-in').map((r) => `${r.switch.name}(zone ${d.fabrics.find((f) => f.deviceId === r.switch.deviceId)?.zoneCount ?? '—'})`))].slice(0, 8).join(', ')}${new Set(d.hbas.filter((r) => r.switch && r.status === 'logged-in').map((r) => r.switch.deviceId)).size > 8 ? ' 외' : ''}` : ''}` : ''}</div>
      <div className="muted" style={{ fontSize: 11, marginTop: 4 }} title={Object.values(CONF).map((c) => `${c.glyph} ${c.label}: ${c.note}`).join('\n')}>신뢰도 규칙은 배지에 마우스를 올리면 보입니다 · {confText('confirmed')} 는 ‘닿을 수 있는 스토리지 1개 + 네임서버 확정’ 일 때만</div>
    </div>
  );
}
