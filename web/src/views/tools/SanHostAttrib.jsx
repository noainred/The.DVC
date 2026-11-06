// SAN 스위치 도구 ‘호스트 귀속’ 보기(v2.915 — 시안 D-③ SanAttrib). 법인 칩(창 안에서 바꾼다 — DcStoragePerf 와 같은 이유) · 기간 · ‘확정만’ ·
//   KPI 5 · 스토리지별 호스트 스택 바(확정/추정) · 신뢰도 규칙 · 호스트 × 스토리지 표(STable) · 조닝만(트래픽 없음) 표.
//   무거운 집계(전 스위치 포트 바이트)라 마운트 1회 + 조건 변경으로만 받는다 · 90초 · 재시도 없음 · 늦게 온 이전 응답은 버린다.
import React, { useEffect, useState } from 'react';
import { fetchJson } from '../../api.js';
import { ErrorBox, SearchBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { CONF, RANGES, bytesText, rwText, attribKpis, storageBars, sortRows, filterRows, rowTotalText, attribStateText } from './sanHostAttribText.js';
import { PERF_TABLE_PAGE, limitRows } from './sanSwitchPerfText.js';
import { agoText } from './relTime.js';

const NONE_DC = '__none__';
const confBadge = (k) => { const c = CONF[k] || CONF.none; return <span className={`badge ${c.tone}`} title={c.note}>{c.glyph} {c.label}</span>; };

export default function SanHostAttrib({ datacenterIds = [], datacenters = [], dcNameOf = (id) => id }) {
  const [dcSet, setDcSet] = useState(() => new Set(datacenterIds));
  const [hours, setHours] = useState(24);
  const [confirmedOnly, setConfirmedOnly] = useState(false);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState({ key: 'total', dir: 'desc' });
  const [tableMax, setTableMax] = useState(PERF_TABLE_PAGE);
  const [got, setGot] = useState(null); const [errGot, setErrGot] = useState(null);
  const dcParam = [...dcSet].join(',');
  const key = JSON.stringify([dcParam, hours]);
  useEffect(() => {
    const ac = new AbortController();
    setGot(null); setErrGot(null); setTableMax(PERF_TABLE_PAGE);
    fetchJson('/tools/sanswitch/attribution', { datacenterId: dcParam, hours }, ac.signal, { timeoutMs: 90_000, retries: 0 })
      .then((d) => { if (!ac.signal.aborted) setGot({ key, d }); })
      .catch((e) => { if (!ac.signal.aborted) setErrGot({ key, e }); });
    return () => ac.abort();
  }, [dcParam, hours]); // eslint-disable-line react-hooks/exhaustive-deps
  const data = got && got.key === key ? got.d : null;
  const error = errGot && errGot.key === key ? errGot.e : null;
  const toggle = (id) => setDcSet((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const rows = data ? sortRows(filterRows(data.rows, { q, confirmedOnly }), sort.key, sort.dir) : [];
  const lim = limitRows(rows, tableMax);
  const bars = storageBars(data?.storages || [], 10);
  const th = (k, label, style) => (
    <th style={{ cursor: 'pointer', ...style }} data-nosort onClick={() => setSort((s) => ({ key: k, dir: s.key === k && s.dir === 'desc' ? 'asc' : 'desc' }))} title="클릭하면 정렬">{label}{sort.key === k ? (sort.dir === 'desc' ? ' ▾' : ' ▴') : ''}</th>
  );
  return (
    <div className="san-attrib">
      <div className="flex wrap" style={{ gap: 10, alignItems: 'center', marginBottom: 8 }}>
        <div className="flex wrap" style={{ gap: 6, alignItems: 'center', flex: '1 1 320px', minWidth: 0 }}>
          <span className="muted" style={{ fontSize: 12 }}>법인</span>
          <button type="button" className={dcSet.size === 0 ? 'login-btn' : 'tab'} style={{ padding: '2px 10px' }} onClick={() => setDcSet(new Set())}>전체</button>
          {datacenters.map((dc) => <button key={dc.id} type="button" className={dcSet.has(dc.id) ? 'login-btn' : 'tab'} style={{ padding: '2px 10px' }} onClick={() => toggle(dc.id)}>{dc.name || dcNameOf(dc.id)}</button>)}
        </div>
        <div className="san2-seg" role="group" aria-label="조회 기간">
          {RANGES.map(([h, l]) => <button key={h} type="button" className={hours === h ? 'on' : ''} aria-pressed={hours === h} onClick={() => setHours(h)}>{l}</button>)}
        </div>
        <label className="muted" style={{ fontSize: 12, display: 'inline-flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={confirmedOnly} onChange={(e) => setConfirmedOnly(e.target.checked)} /> 확정만</label>
        <SearchBox className="input" style={{ maxWidth: 220, minWidth: 140 }} value={q} onChange={setQ} placeholder="호스트·스토리지 찾기" />
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>
        호스트 HBA WWN → 스위치 포트 · zone · 네임서버 역할 → 등록 스토리지(시리얼) 로 귀속합니다. {CONF.confirmed.glyph} 확정 = 닿을 수 있는 스토리지 1개 + 타깃 역할 네임서버 확정(또는 멀티패스 살아 있는 타깃으로 좁힘) ·
        {' '}{CONF.estimated.glyph} 추정 = 후보 2개 이상을 같은 스위치 타깃 포트 바이트 비율로 분배 · 확정분과 추정분은 합치지 않고, 측정 없음은 0 이 아니라 —.
      </div>
      {error ? <ErrorBox error={error} /> : !data ? (
        <div className="san2-loading-alert" role="status">전 스위치 포트 사용량을 합치는 중입니다 — <b>최소 1분 이상</b> 기다려야 할 수 있습니다.</div>
      ) : (
        <>
          {attribStateText(data) && <div className="muted" style={{ marginBottom: 8 }}>{attribStateText(data)}</div>}
          <div className="hd-kpis" style={{ marginBottom: 12 }}>
            {attribKpis(data).map((k) => <div key={k.l} className="ht-kpi"><span className="ht-kpi-l">{k.l}</span><span className="ht-kpi-v" style={{ fontSize: 16 }}>{k.v}</span><span className="ht-kpi-s" title={k.s}>{k.s || ' '}</span></div>)}
          </div>
          {bars.rows.length > 0 && (
            <div className="card" style={{ padding: '10px 12px', marginBottom: 12 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>스토리지별 귀속 바이트 · 상위 {bars.rows.length}{bars.omitted ? ` (외 ${bars.omitted})` : ''} · 막대 폭은 전체 귀속 합 기준 · 진한 색 = 확정 · 연한 색 = 추정</div>
              {bars.rows.map((b) => (
                <div key={b.id} className="flex wrap" style={{ gap: '4px 10px', alignItems: 'center', fontSize: 12, marginBottom: 4, minWidth: 0 }}>
                  <span style={{ flex: '0 1 180px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.name}><b>{b.name}</b>{b.registered ? <span className="badge blue" style={{ marginLeft: 4, fontSize: 10 }}>등록</span> : null}</span>
                  <span style={{ flex: '1 1 140px', height: 10, background: 'var(--panel-deep)', borderRadius: 5, overflow: 'hidden', display: 'flex', minWidth: 60 }}>
                    <i style={{ width: `${b.pctC}%`, background: '#2dd4bf', display: 'block' }} title={`확정 ${bytesText(b.confirmed)}`} />
                    <i style={{ width: `${b.pctE}%`, background: 'rgba(45,212,191,.4)', display: 'block' }} title={`추정 ${bytesText(b.estimated)}`} />
                  </span>
                  {/* 400px 에서는 줄을 바꿔 숫자가 잘리지 않게(flex wrap — 1440 에서는 한 줄) */}
                  <span className="muted" style={{ flex: '0 1 auto', minWidth: 0, fontFamily: 'var(--mono)', fontSize: 11, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{CONF.confirmed.glyph} {bytesText(b.confirmed)} · {CONF.estimated.glyph} {bytesText(b.estimated)} · 호스트 {b.hosts}{b.unmeasuredHosts ? ` · 측정 없음 ${b.unmeasuredHosts}` : ''}</span>
                </div>
              ))}
            </div>
          )}
          <div className="muted" style={{ fontSize: 12, margin: '4px 0 6px' }}>호스트 × 스토리지 — {rows.length}행{rows.length !== (data.rows || []).length ? ` (전체 ${(data.rows || []).length})` : ''} · 제목 클릭 정렬</div>
          <div className="table-wrap" style={{ maxHeight: '44vh' }}>
            <STable minWidth={980}>
              <thead><tr>{th('host', '호스트')}{th('corp', '법인')}{th('storage', '스토리지')}{th('conf', '귀속')}{th('confirmed', '확정분', { textAlign: 'right' })}{th('estimated', '추정분', { textAlign: 'right' })}{th('total', '합(참고)', { textAlign: 'right' })}<th data-nosort style={{ textAlign: 'right' }}>지금 읽기 / 쓰기(확정)</th><th data-nosort>포트</th></tr></thead>
              <tbody>
                {lim.rows.map((r) => (
                  <tr key={`${r.hostId}|${r.storageId}`}>
                    <td><a href={`#/hosts/${encodeURIComponent(r.hostId)}`} title="호스트 상세 열기"><b>{r.hostName}</b></a><div className="muted" style={{ fontSize: 11 }}>{r.vcenterName}</div></td>
                    <td>{r.datacenterName}</td>
                    <td>{r.storageName}{r.registered ? <span className="badge blue" style={{ marginLeft: 4, fontSize: 10 }}>등록</span> : <span className="muted" style={{ fontSize: 11 }}> · {r.kind === 'array' ? '미등록' : '어레이 미확인'}</span>}</td>
                    <td>{confBadge(r.conf)}</td>
                    <td style={{ textAlign: 'right' }}>{r.confirmedBytes != null ? bytesText(r.confirmedBytes) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>{r.estimatedBytes != null ? `≈ ${bytesText(r.estimatedBytes)}` : '—'}</td>
                    <td style={{ textAlign: 'right' }} className="muted" title="확정분 + 추정분 — 정렬·비교용 참고값이며 확정값이 아닙니다">{rowTotalText(r)}</td>
                    <td style={{ textAlign: 'right' }}>{rwText(r.nowRead, r.nowWrite)}</td>
                    <td className="muted" style={{ fontSize: 11 }}>{CONF.confirmed.glyph}{r.ports?.confirmed ?? 0} {CONF.estimated.glyph}{r.ports?.estimated ?? 0}{r.ports?.unsplit ? ` —${r.ports.unsplit}` : ''}{r.ports?.unmeasured ? ` 측정없음${r.ports.unmeasured}` : ''}</td>
                  </tr>
                ))}
                {!lim.rows.length && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>{(data.rows || []).length ? '검색·확정만 조건에 맞는 행이 없습니다.' : '귀속된 호스트 × 스토리지 쌍이 없습니다.'}</td></tr>}
              </tbody>
            </STable>
          </div>
          {lim.omitted > 0 && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>상위 {lim.rows.length}행만 그렸습니다(나머지 {lim.omitted}행). <button type="button" className="tab" style={{ padding: '0 8px' }} onClick={() => setTableMax((m) => m + PERF_TABLE_PAGE)}>더 보기</button></div>}
          {data.zonedOnly?.length > 0 && (
            <>
              <div className="muted" style={{ fontSize: 12, margin: '12px 0 6px' }}>조닝만 있고 트래픽이 없는 쌍 — {data.zonedOnly.length} · 통계에 넣지 않습니다(정리 후보)</div>
              <div className="table-wrap" style={{ maxHeight: '24vh' }}>
                {/* 상한은 STable 의 limit(정렬 뒤 자르기 — BUG-19) 으로 */}
                <STable minWidth={640} limit={200}>
                  <thead><tr><th>호스트</th><th>법인</th><th>스토리지</th><th>Zone</th><th>포트</th></tr></thead>
                  <tbody>
                    {data.zonedOnly.map((r) => (
                      <tr key={`${r.hostId}|${r.storageId}`}>
                        <td><a href={`#/hosts/${encodeURIComponent(r.hostId)}`}>{r.hostName}</a></td><td>{r.datacenterName}</td><td>{r.storageName}</td>
                        <td className="muted" style={{ fontSize: 11 }}>{(r.zones || []).join(', ') || '—'}</td>
                        <td className="muted" style={{ fontSize: 11 }}>조닝만 {r.ports?.zonedOnly ?? 0}{r.ports?.unmeasured ? ` · 측정 없음 ${r.ports.unmeasured}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </STable>
              </div>
            </>
          )}
          <div className="muted hd-note">
            스위치 {(data.fabrics || []).length}대{data.fabrics?.length ? ` — ${data.fabrics.slice(0, 6).map((f) => `${f.name}(zone ${f.zoneCount}${f.nsKnown ? '' : ' · 역할 추정'})`).join(', ')}${data.fabrics.length > 6 ? ` 외 ${data.fabrics.length - 6}` : ''}` : ''}
            {' · '}기간 바이트 출처 {data.source?.kind === 'rollup' ? '집계 표 + 원본 자투리' : data.source?.kind === 'demo' ? '데모 수식' : data.source?.kind === 'raw' ? '원본' : '—'} · 계산 {agoText(data.computedAt)}
            {data.datacenterIds?.includes(NONE_DC) ? ' · 법인 미지정 스위치 포함' : ''}
          </div>
        </>
      )}
    </div>
  );
}
