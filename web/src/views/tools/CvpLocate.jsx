import React, { useRef, useState } from 'react';
import BoldText from '../../components/boldText.jsx';
import { fetchJson } from '../../api.js';
import { ErrorBox, Loading } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { NOTE, MONO, ROW, GRID1, LINKBTN, Pill } from './CvpNetParts.jsx';
import { LOCATE_EXAMPLES, LOCATE_NOTE, macText, sourceText, transitBasis, numText, dateText, TONE } from './cvpNetText.js';

/**
 * CVP › 위치 찾기(v3.38 ①) — MAC · IP · 이름을 넣으면 그 장비가 붙은 스위치 포트. 검색 버튼을 누를 때만 부른다(폴링 없음).
 * 판정(가장자리 / 지나는 곳)은 서버 cvp/locate.js. 늦게 온 이전 응답은 버린다.
 */
const KIND = { mac: 'MAC', ip: 'IP', name: '이름' };

export default function CvpLocateView({ onOpen }) {
  const [q, setQ] = useState('');
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const run = async (text) => {
    const v = String(text ?? q).trim();
    if (!v) return;
    const my = ++seq.current;
    setBusy(true); setErr(null);
    try { const x = await fetchJson('/tools/cvp/locate', { q: v }); if (my === seq.current) setR(x); }
    catch (e) { if (my === seq.current) { setErr(e); setR(null); } }
    finally { if (my === seq.current) setBusy(false); }
  };
  const l2 = r?.l2 || {};
  return (
    <div style={GRID1}>
      <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <b style={{ fontSize: 15 }}>위치 찾기</b>
        <form style={ROW} onSubmit={(e) => { e.preventDefault(); run(); }}>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="MAC · IP · VM/호스트 이름" aria-label="찾을 MAC · IP · 이름" style={{ flex: '1 1 240px', minWidth: 0, maxWidth: 420 }} />
          <button type="submit" className="btn" disabled={busy || !q.trim()}>{busy ? '찾는 중…' : '찾기'}</button>
        </form>
        <div style={ROW}>
          <span style={NOTE}>예</span>
          {LOCATE_EXAMPLES.map((x) => <button key={x} type="button" className="tab" onClick={() => { setQ(x); run(x); }} style={MONO}>{x}</button>)}
        </div>
        <div style={NOTE}><BoldText text={LOCATE_NOTE} /></div>
      </div>
      {err && <ErrorBox error={err} />}
      {busy && !r && <Loading />}
      {r && (<>
        <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={ROW}>
            <span style={NOTE}>{KIND[r.query?.kind] || ''}</span><b style={MONO}>{r.query?.kind === 'mac' ? macText(r.query.value) : r.query?.value}</b>
            <span style={NOTE}>· 찾은 MAC {r.macs?.length ?? 0}개 · 가장자리 포트 {r.edge?.length ?? 0}곳 · 지나는 곳 {r.transit?.length ?? 0}곳</span>
          </div>
          {Array.isArray(r.subjects) && r.subjects.length > 0 && (
            <STable className="v3-table" minWidth={760}>
              <thead><tr><th>종류</th><th>이름</th><th>vCenter</th><th>호스트</th><th>IP</th><th>MAC</th></tr></thead>
              <tbody>
                {r.subjects.map((s) => (
                  <tr key={`${s.type}|${s.id}`}>
                    <td>{s.type === 'vm' ? 'VM' : '호스트'}</td>
                    <td style={MONO}>{s.name}</td>
                    <td>{s.vcenterName || '—'}</td>
                    <td style={MONO}>{s.host || '—'}</td>
                    <td style={{ ...MONO, whiteSpace: 'normal' }}>{(s.ips || []).join(', ') || '—'}</td>
                    <td style={{ ...MONO, whiteSpace: 'normal' }}>{(s.macs || []).map(macText).join(', ') || <span style={{ color: TONE.amber }}>MAC 없음(인벤토리)</span>}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          )}
          {r.query?.kind !== 'mac' && !(r.subjects || []).length && <div className="banner">vCenter 인벤토리에서 맞는 VM · 호스트를 찾지 못했습니다. MAC 을 알면 MAC 으로 찾아 보세요(스위치 ARP 표는 수집하지 않아 IP 만으로는 스위치에서 찾을 수 없습니다).</div>}
          {r.subjectsTruncated && <div style={NOTE}>⚠ 맞는 VM · 호스트가 많아 앞부분만 썼습니다 — 더 구체적인 이름을 넣으세요.</div>}
        </div>
        <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <b>붙어 있는 곳(가장자리 포트)</b>
          <STable className="v3-table" minWidth={900}>
            <thead><tr><th>법인</th><th>스위치</th><th>포트</th><th>VLAN</th><th>MAC</th><th>근거</th><th>본 시각</th></tr></thead>
            <tbody>
              {(r.edge || []).map((x, i) => (
                <tr key={`${x.cvpId}|${x.key}|${x.port}|${x.mac}|${i}`}>
                  <td>{x.corpName || '법인 미지정'}</td>
                  <td data-sort={x.hostname}><button type="button" style={LINKBTN} onClick={() => onOpen && onOpen({ cvpId: x.cvpId, key: x.key, hostname: x.hostname })}>{x.hostname}</button></td>
                  <td style={MONO}>{x.port}</td>
                  <td data-sort={x.vlan ?? ''} style={MONO}>{x.vlan ?? '—'}</td>
                  <td style={MONO}>{macText(x.mac)}</td>
                  <td><Pill color={x.sources?.length > 1 ? TONE.green : TONE.blue}>{sourceText(x.sources)}</Pill>{x.basis === 'nolldp' ? <span style={{ ...NOTE, marginLeft: 6 }}>(그 장비 LLDP 못 읽음 — 업링크가 아니라고 단정 못 함)</span> : null}</td>
                  <td data-sort={x.at ?? ''}>{x.at ? dateText(x.at) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </STable>
          {!(r.edge || []).length && <div className="banner">가장자리 포트에서 찾지 못했습니다 — 없다는 뜻은 아닙니다. MAC 테이블을 읽은 장비 {numText(l2.fdbDevices)} / {numText(l2.devices)}대{l2.fdbFailing ? ` · 마지막 읽기 실패 ${l2.fdbFailing}대` : ''}{l2.lastAt ? ` · 최근 ${dateText(l2.lastAt)}` : ''}.</div>}
          {(r.transit || []).length > 0 && (<>
            <b>지나는 곳(스위치 사이 포트)</b>
            <STable className="v3-table" minWidth={820}>
              <thead><tr><th>스위치</th><th>포트</th><th>VLAN</th><th>MAC</th><th data-nosort>업링크로 본 근거</th></tr></thead>
              <tbody>
                {r.transit.map((x, i) => (
                  <tr key={`t|${x.cvpId}|${x.key}|${x.port}|${x.mac}|${i}`}>
                    <td style={MONO}>{x.hostname}</td><td style={MONO}>{x.port}</td><td style={MONO}>{x.vlan ?? '—'}</td><td style={MONO}>{macText(x.mac)}</td>
                    <td style={{ whiteSpace: 'normal', fontSize: 12.5 }}>{transitBasis(x, r.manyMacs)}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          </>)}
          {r.fdbTruncated && <div style={NOTE}>⚠ MAC 테이블 결과가 상한을 넘어 일부만 봤습니다.</div>}
        </div>
      </>)}
    </div>
  );
}
