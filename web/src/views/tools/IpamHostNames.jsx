// IpamHostNames.jsx — IP 관리 › IP 주소 › '호스트명 대조'(v3.6.0 재설계 묶음 다 — 시안 ⑮ HostNames.dc.html · 설계 §3.5).
// 장비 한 대(ESXi · VM · 물리 서버)마다 iDRAC · vCenter · OS · DNS 에 설정된 이름이 같은지. 판정은 서버(GET /tools/ipam/hostnames —
// ipam/serverView.js compareNames: 첫 마디 · 소문자 · 15자, 기준 없음 — 여럿과 다른 곳 표시). 무거운 집계라 폴링하지 않는다(열 때 1회 + 새로고침).
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { NAME_SOURCES, VERDICT, cellText, topOdd, verdictText } from './ipamServerText.js';
import { IpamServerModal } from './IpamServerModal.jsx';

const KINDS = [['', '전체'], ['esxi', 'ESXi'], ['vm', 'VM'], ['bm', '물리 서버']];

function NameCell({ c, odd }) {
  const cls = odd ? 'ipam-name-cell odd' : c?.state === 'ok' || c?.state === 'addr' ? 'ipam-name-cell' : 'ipam-name-cell dim';
  return (
    <span className={cls} title={c?.note || undefined}>
      <span>{odd ? '△ ' : ''}{cellText(c)}</span>
      {c?.note && c.state !== 'ok' ? <span className="muted" style={{ fontSize: 10.5, fontWeight: 400 }}>{c.note}</span> : null}
    </span>
  );
}

export function IpamHostNames() {
  const [kind, setKind] = useState('');
  const [verdict, setVerdict] = useState('');
  const [q, setQ] = useState('');
  const [qSent, setQSent] = useState('');
  const [limit, setLimit] = useState(300);
  const [nonce, setNonce] = useState(0);
  const [d, setD] = useState(undefined);
  const [err, setErr] = useState(null);
  const [pick, setPick] = useState(null);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current; // 늦게 온 이전 조건의 응답은 버린다
    setErr(null);
    fetchJson('/tools/ipam/hostnames', { kind, verdict, q: qSent, limit })
      .then((r) => { if (my === seq.current) setD(r); })
      .catch((e) => { if (my === seq.current) setErr(e); });
  }, [kind, verdict, qSent, limit, nonce]);
  const sm = d?.summary;
  const top = topOdd(sm);
  const kpi = (k, label, n, sub) => (
    <button type="button" className="card" aria-pressed={verdict === k} onClick={() => setVerdict((v) => (v === k ? '' : k))}>
      <span className="muted" style={{ fontSize: 12 }}>{label}</span><b>{n == null ? '—' : n.toLocaleString()}</b>
      {sub ? <span className="muted" style={{ fontSize: 11 }}>{sub}</span> : null}
    </button>
  );
  return (
    <section className="card" style={{ padding: 14, minWidth: 0 }} aria-label="호스트명 대조">
      <div className="flex between" style={{ alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <div style={{ minWidth: 0 }}>
          <b style={{ fontSize: 15 }}>호스트명 대조</b>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>장비마다 iDRAC · vCenter · OS · DNS 에 설정된 이름이 같은지 봅니다. 여럿과 다른 곳을 △ 로 표시합니다(어느 쪽이 맞는지는 정하지 않습니다).</div>
        </div>
        <button className="logout-btn" style={{ padding: '6px 12px', fontSize: 12 }} onClick={() => setNonce((n) => n + 1)}>새로고침</button>
      </div>
      <div className="ipam-names-kpis">
        <div className="card" style={{ cursor: 'default' }}><span className="muted" style={{ fontSize: 12 }}>대조한 장비</span><b>{sm ? sm.total.toLocaleString() : '—'}</b>
          {sm ? <span className="muted" style={{ fontSize: 11 }}>ESXi {sm.byKind.esxi} · VM {sm.byKind.vm}{d?.bareMetal ? ` · 물리 ${sm.byKind.bm}` : ''}</span> : null}</div>
        {kpi('same', '모두 같음', sm?.same, sm?.partial ? `그중 일부만 읽음 ${sm.partial}` : '')}
        {kpi('diff', '서로 다름', sm?.diff, '')}
        {kpi('cmp-none', '비교할 수 없음', sm?.cmpNone, '읽은 이름이 2곳 미만')}
        <div className="card" style={{ cursor: 'default' }}><span className="muted" style={{ fontSize: 12 }}>가장 많이 어긋나는 곳</span><b>{top ? top.label : '—'}</b>
          {top ? <span className="muted" style={{ fontSize: 11 }}>△ {top.n.toLocaleString()}건</span> : <span className="muted" style={{ fontSize: 11 }}>{sm ? '어긋난 곳 없음' : ''}</span>}</div>
      </div>
      <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        {KINDS.map(([k, l]) => <button key={k || 'all'} type="button" className={`tab${kind === k ? ' active' : ''}`} aria-pressed={kind === k} style={{ flex: 'none', padding: '4px 11px', fontSize: 12 }} onClick={() => setKind(k)}>{l}</button>)}
        <form className="flex gap" style={{ alignItems: 'center', minWidth: 0, flex: '1 1 220px' }} onSubmit={(e) => { e.preventDefault(); setQSent(q.trim()); }}>
          <input className="input" type="search" aria-label="장비 · 이름 · IP 찾기" placeholder="장비 · 이름 · IP 찾기(Enter)" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 0, flex: '1 1 auto', maxWidth: 320 }} />
        </form>
        {verdict && <span className="muted" style={{ fontSize: 12 }}>판정: {VERDICT[verdict]?.label} <button type="button" className="tab" style={{ padding: '1px 7px', fontSize: 11 }} onClick={() => setVerdict('')}>해제</button></span>}
      </div>
      {(d?.notes || []).map((n) => <div key={n} style={{ fontSize: 12, color: 'var(--amber)', margin: '4px 0' }}>{n}</div>)}
      {d && !d.admin && <div className="muted" style={{ fontSize: 12, margin: '4px 0' }}>iDRAC 칸 · 물리 서버는 관리자에게만 보입니다.</div>}
      {d?.scoped && <div className="muted" style={{ fontSize: 12, margin: '4px 0' }}>범위 계정에는 스캔이 찾은 이름(DNS)이 보이지 않아 DNS 칸이 ‘가림’ 입니다.</div>}
      {err ? <ErrorBox message={err} /> : d === undefined ? <Loading /> : (
        <>
          <STable className="v3-table" minWidth={820}>
            <thead><tr><th>장비</th><th>종류</th>{NAME_SOURCES.map(([k, l]) => <th key={k}>{l}</th>)}<th>판정</th></tr></thead>
            <tbody>
              {(d.rows || []).map((r) => (
                <tr key={`${r.kind}|${r.key}|${r.name}|${r.ip}`}>
                  <td data-sort={r.name} style={{ minWidth: 140, maxWidth: 240, whiteSpace: 'normal' }}>
                    <button type="button" className="ipam-link" style={{ marginLeft: 0, fontSize: 13, fontWeight: 600, textAlign: 'left', overflowWrap: 'anywhere' }} title="서버 보기" onClick={() => setPick(r)}>{r.name}</button>
                    <div className="muted mono" style={{ fontSize: 11 }}>{r.ip || '주소 없음'}{r.host ? ` · ${r.host}` : ''}</div>
                  </td>
                  <td data-sort={r.kind}>{r.kind === 'vm' ? 'VM' : r.kind === 'esxi' ? 'ESXi' : '물리'}</td>
                  {NAME_SOURCES.map(([k]) => <td key={k} data-sort={r.cells?.[k]?.v || ''} style={{ whiteSpace: 'normal', minWidth: 110, maxWidth: 230 }}><NameCell c={r.cells?.[k]} odd={(r.odd || []).includes(k)} /></td>)}
                  <td data-sort={r.verdict}><span className={`badge ${VERDICT[r.verdict]?.tone || 'gray'}`}>{verdictText(r)}</span></td>
                </tr>
              ))}
              {!(d.rows || []).length && <tr><td colSpan={7} className="center muted" style={{ padding: 18 }}>조건에 맞는 장비가 없습니다.</td></tr>}
            </tbody>
          </STable>
          <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap', marginTop: 8, fontSize: 12 }}>
            <span className="muted">{d.matched.toLocaleString()}대 중 {Math.min(d.matched, (d.rows || []).length).toLocaleString()}대 표시 — 서로 다름 → 비교할 수 없음 → 모두 같음 순</span>
            {d.truncated && d.limit < 2000 && <button type="button" className="tab" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => setLimit(2000)}>2,000대까지 보기</button>}
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.6 }}>
            비교 규칙: 이름의 첫 마디만 · 대소문자 무시 · 15자까지(NetBIOS 이름은 15자에서 잘림). ‘해당 없음’(VM 의 iDRAC · 물리 서버의 vCenter) · ‘못 읽음’ · ‘가림’ 은 다름으로 세지 않습니다.
            DNS 는 대표 주소(ESXi 관리 주소 · VM 첫 주소 · 물리 서버 OS 주소)의 역DNS 이름이고, 스캔 대역 밖 주소는 ‘못 읽음’ 입니다.
          </div>
        </>
      )}
      {pick && <IpamServerModal ip={pick.ip || ''} serverKey={pick.ip ? '' : pick.key} onClose={() => setPick(null)} />}
    </section>
  );
}
