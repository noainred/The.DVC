import React, { useEffect, useMemo, useState } from 'react';
import BoldText from '../../components/boldText.jsx';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import {
  intfRows, statusBuckets, speedBuckets, xcvrBuckets, donutArcs, filterRows, descCell, deviceOptions, INTF_NOTE,
} from './cvpIntfText.js';

/**
 * CVP › 인터페이스 세부 정보(v2.649 — 사용자 요청 'CVP 의 Interfaces › Ethernet 화면을 똑같이').
 * 장비 1대를 골라 `/tools/cvp/device` 를 1회 부른다(폴링 금지 — 선택·새로고침 때만). 도넛 3개(상태·속도·트랜시버 종류) + 열별 필터 표.
 */
const NOTE = { fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 };
const R = 58; const SW = 18; const C = 2 * Math.PI * R;

function Donut({ title, buckets, total, emptyText }) {
  const arcs = buckets ? donutArcs(buckets, C) : [];
  return (
    <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <b>{title}</b>
      {buckets ? (
        <>
          <svg width="160" height="160" viewBox="0 0 160 160" role="img" aria-label={`${title} — ${total}개 인터페이스`}>
            <circle cx="80" cy="80" r={R} fill="none" stroke="var(--border)" strokeWidth={SW} />
            {arcs.map((a) => (
              <circle key={a.key} cx="80" cy="80" r={R} fill="none" stroke={a.color} strokeWidth={SW}
                strokeDasharray={`${Math.max(0, a.len - (arcs.length > 1 ? 1.5 : 0))} ${C}`} strokeDashoffset={-a.off}
                transform="rotate(-90 80 80)"><title>{`${a.label} ${a.count}`}</title></circle>
            ))}
            <text x="80" y="78" textAnchor="middle" fontSize="28" fill="var(--text)">{total}</text>
            <text x="80" y="98" textAnchor="middle" fontSize="12" fill="var(--text-dim)">인터페이스</text>
          </svg>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
            {buckets.map((b) => (
              <span key={b.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                <span style={{ background: b.color, color: '#fff', borderRadius: 9, padding: '0 7px', fontWeight: 700, flexShrink: 0 }}>{b.count}</span>
                {b.label}
              </span>
            ))}
          </div>
        </>
      ) : <div style={{ ...NOTE, padding: '40px 8px', textAlign: 'center' }}>{emptyText}</div>}
    </div>
  );
}

const COLS = [
  ['name', '인터페이스'], ['desc', '설명'], ['statusText', '상태'], ['duplex', 'Duplex'], ['fwdModel', '포워딩 모델'],
  ['mac', 'MAC 주소(Burned-in)'], ['mtu', 'MTU'], ['speed', '속도'], ['xcvr', '트랜시버 종류'],
];
const STATUS_COLOR = { connected: 'var(--green)', down: 'var(--red)', notconnect: 'var(--amber)', unknown: 'var(--text-dim)' };

export default function CvpInterfacesView({ devices = [], initial = null }) {
  const opts = useMemo(() => deviceOptions(devices), [devices]);
  const [sel, setSel] = useState(initial || '');
  const [q, setQ] = useState('');
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  const [reload, setReload] = useState(0);
  const [filters, setFilters] = useState({});
  useEffect(() => { if (initial) setSel(initial); }, [initial]);
  useEffect(() => { if (!sel && opts.length) setSel(opts[0].id); }, [opts, sel]);
  const cur = opts.find((o) => o.id === sel) || null;
  useEffect(() => {
    if (!cur) return undefined;
    let active = true;
    setErr(null); setR(null);
    fetchJson('/tools/cvp/device', { cvpId: cur.cvpId, key: cur.key })
      .then((x) => { if (active) setR(x); }).catch((e) => { if (active) setErr(e); });
    return () => { active = false; };
  }, [cur?.id, reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => (r ? intfRows(r.ports, r.parts) : null), [r]);
  const shownOpts = q.trim() ? opts.filter((o) => `${o.label} ${o.model} ${o.corp}`.toLowerCase().includes(q.trim().toLowerCase())) : opts;
  const shown = rows ? filterRows(rows, filters) : [];
  const d = r?.device || {};
  return (
    <div style={{ display: 'grid', gap: 14, minWidth: 0 }}>
      <div className="card" style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <b>인터페이스 세부 정보</b>
          <input className="input" placeholder="장비 검색(호스트명·모델·법인)" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 240, minWidth: 0 }} />
          <select className="input" value={sel} onChange={(e) => { setSel(e.target.value); setFilters({}); }} style={{ maxWidth: 360, minWidth: 0 }}>
            {!cur && <option value="">장비를 고르세요</option>}
            {cur && !shownOpts.some((o) => o.id === cur.id) && <option value={cur.id}>{cur.label}</option>}
            {shownOpts.map((o) => <option key={o.id} value={o.id}>{o.label}{o.model ? ` · ${o.model}` : ''}{o.corp ? ` · ${o.corp}` : ''}</option>)}
          </select>
          <button type="button" className="btn" onClick={() => setReload((x) => x + 1)} disabled={!cur}>새로고침</button>
        </div>
        {cur && r && (
          <div style={{ ...NOTE, marginTop: 6 }}>
            {[d.hostname || cur.label, d.model, d.eosVersion ? `EOS ${d.eosVersion}` : '', d.corpName ? `법인 ${d.corpName}` : '', r.cvpName ? `CVP ${r.cvpName}` : ''].filter(Boolean).join(' · ')}
          </div>
        )}
        <div style={{ ...NOTE, marginTop: 6 }}><BoldText text={INTF_NOTE} /></div>
      </div>

      {!opts.length && <div className="banner">수집된 CVP 장비가 없습니다.</div>}
      {err && <ErrorBox error={err} />}
      {cur && !r && !err && <Loading />}
      {r && rows == null && <div className="banner">이 장비의 포트 목록을 아직 읽지 못했습니다(텔레메트리 스트리밍·수집 경로를 ‘읽은 경로’ 에서 확인하세요).</div>}

      {rows && (<>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: 14, minWidth: 0 }}>
          <Donut title="이더넷 상태" buckets={statusBuckets(rows)} total={rows.length} />
          <Donut title="인터페이스 속도" buckets={speedBuckets(rows)} total={rows.length} />
          <Donut title="트랜시버 종류" buckets={xcvrBuckets(rows)} total={rows.length}
            emptyText="트랜시버 목록을 아직 읽지 못했습니다 — 부품 주기(기본 30분)마다 읽습니다. 없다는 뜻이 아닙니다." />
        </div>
        <div className="card" style={{ minWidth: 0 }}>
          <div style={{ ...NOTE, marginBottom: 6 }}>{shown.length === rows.length ? `${rows.length}개 인터페이스` : `${rows.length}개 중 ${shown.length}개 표시(필터)`}</div>
          <STable className="v3-table" minWidth={1180}>
            <thead>
              {/* 필터 입력은 머리글 칸 안에 둔다(STable 은 thead 마지막 행을 정렬 머리글로 쓴다) — 입력 클릭이 정렬을 누르지 않게 전파를 막는다. */}
              <tr>
                {COLS.map(([k, l]) => (
                  <th key={k} style={{ verticalAlign: 'top' }}>
                    <div>{l}</div>
                    <input className="input" placeholder="필터" aria-label={`${l} 필터`} value={filters[k] || ''}
                      style={{ width: '100%', minWidth: 0, marginTop: 4, padding: '2px 6px', fontSize: 12, fontWeight: 400 }}
                      onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
                      onChange={(e) => setFilters((f) => ({ ...f, [k]: e.target.value }))} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((x) => {
                const dc = descCell(x.desc);
                return (
                  <tr key={x.name}>
                    <td style={{ whiteSpace: 'nowrap' }}>{x.name}</td>
                    <td style={{ fontSize: 12, whiteSpace: 'normal', maxWidth: 280, overflowWrap: 'anywhere' }} title={dc.title}>{dc.text}</td>
                    <td style={{ color: STATUS_COLOR[x.status], whiteSpace: 'nowrap' }} title={x.operRaw ? `장비 원문: ${x.operRaw}` : '장비 원문 상태값 없음'}>{x.statusText}</td>
                    <td>{x.duplex || '—'}</td>
                    <td>{x.fwdModel || '—'}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{x.mac || '—'}</td>
                    <td data-sort={x.mtu ?? ''}>{x.mtu ?? '—'}</td>
                    <td data-sort={x.speedBps ?? ''} style={{ whiteSpace: 'nowrap' }}>{x.speed || '속도 모름'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{x.xcvr || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
          {!shown.length && <div style={{ ...NOTE, marginTop: 8 }}>필터에 맞는 인터페이스가 없습니다.</div>}
        </div>
      </>)}
    </div>
  );
}
