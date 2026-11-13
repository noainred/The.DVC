/**
 * IP 관리 › IP 스캔 › 물리서버 OS 주소 제안(v2.992 · 설계 docs/design/bm-folders §13 ②).
 * iDRAC 이 읽은 호스트 이름과 **같은 이름**(대소문자 무시 · 도메인 뒤를 뗀 짧은 이름)을 가진 IP 를 같은 법인의 스캔 결과에서 찾아 보여 주고,
 * 사람이 확인해 OS 주소로 등록한다. 주소만 넣는다(계정 · 비밀번호 없음) — 계정을 넣기 전에는 어떤 수집도 접속하지 않는다.
 * 판정은 서버(`bmfolders/osSuggest.js`) — 화면은 그리기 · 고르기만.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { STATE_TEXT, VIA_TEXT, suggestRowsOf, applyResultText, pickableOf, initialFilter } from './bmOsSuggestText.js';

const FILTERS = [['suggest', '제안 있음'], ['pick', '고르기 필요'], ['none', '못 찾음'], ['differs', '등록된 주소와 다름'], ['all', '전체']];
const STACK = [['registered', '#22c55e'], ['suggest', '#3b82f6'], ['pick', '#f59e0b'], ['none', '#8b9bb4']];

export function BmOsSuggest() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [filter, setFilter] = useState('suggest');
  const [chosen, setChosen] = useState(() => new Map());   // key → ip(고른 IP)
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const seq = useRef(0);
  const first = useRef(true);
  const load = () => {
    const my = ++seq.current;
    setErr(null);
    fetchJson('/admin/ipam/scan/bm-os-suggest').then((r) => {
      if (my !== seq.current) return;
      // 처음 열 때만 — 제안이 0건이면 빈 화면 대신 개수가 있는 거르기(고르기 필요 → 전체)
      setFilter((f) => (first.current ? initialFilter(r?.counts) : f));
      first.current = false;
      setD(r);
    }).catch((e) => { if (my === seq.current) setErr(e); });
  };
  useEffect(load, []);
  const rows = useMemo(() => suggestRowsOf(d?.rows || [], filter), [d, filter]);
  if (err) return <ErrorBox error={err} />;
  if (!d) return <Loading />;
  const c = d.counts || {};
  const total = d.total || 0;
  const pickable = rows.filter((r) => pickableOf(r));
  const toggle = (r, on) => setChosen((m) => { const n = new Map(m); if (on) n.set(r.key, r.state === 'suggest' ? r.cands.find((x) => x.ssh)?.ip : (n.get(r.key) || '')); else n.delete(r.key); return n; });
  const setIp = (r, ip) => setChosen((m) => { const n = new Map(m); if (ip) n.set(r.key, ip); else n.delete(r.key); return n; });
  const ready = [...chosen.entries()].filter(([, ip]) => ip);
  const apply = async (items) => {
    if (!items.length || busy) return;
    if (!window.confirm(`${items.length}대의 OS 주소를 등록합니다 — 주소만 넣고 계정 · 비밀번호는 넣지 않습니다. 계정을 넣기 전에는 접속하지 않습니다. 계속할까요?`)) return;
    setBusy(true); setMsg('');
    try {
      const r = await postJson('/admin/ipam/scan/bm-os-suggest/apply', { items: items.map(([key, ip]) => ({ key, ip })) });
      setMsg(applyResultText(r)); setChosen(new Map()); load();
    } catch (e) { setMsg(`등록하지 못했습니다 — ${e?.message || e}`); } finally { setBusy(false); }
  };
  return (
    <div>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 10 }}>
        <div><div style={{ fontSize: 22, fontWeight: 800 }}>{total}</div><div className="muted" style={{ fontSize: 12 }}>물리서버</div></div>
        <div style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div role="img" aria-label={STACK.map(([k]) => `${STATE_TEXT[k][0]} ${c[k] || 0}`).join(', ')} style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', background: 'var(--border)' }}>
            {total ? STACK.map(([k, col]) => (c[k] ? <i key={k} style={{ width: `${(c[k] / total) * 100}%`, background: col }} /> : null)) : null}
          </div>
          <div className="flex gap wrap" style={{ fontSize: 12 }}>
            {STACK.map(([k, col]) => <span key={k} style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}><i style={{ width: 10, height: 10, borderRadius: 3, background: col, display: 'inline-block' }} />{STATE_TEXT[k][0]} <b>{c[k] || 0}</b></span>)}
            {['differs', 'closed', 'noname', 'ambiguous'].filter((k) => c[k]).map((k) => <span key={k} className="muted">{STATE_TEXT[k][0]} {c[k]}</span>)}
          </div>
        </div>
        <span className="muted" style={{ fontSize: 12, maxWidth: 380 }}>iDRAC 이 읽은 서버의 호스트 이름과 <b>같은 이름</b>을 가진 IP 를 같은 법인의 스캔 결과에서 찾습니다. 대소문자는 무시하고, 도메인 뒤는 떼고 견줍니다.</span>
      </div>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
        {ready.length ? <span className="flex gap" style={{ alignItems: 'center' }}><b style={{ fontSize: 12 }}>{ready.length}건 고름</b><button type="button" className="login-btn" style={{ flex: 'none', padding: '5px 12px', fontSize: 12 }} disabled={busy} onClick={() => apply(ready)}>고른 제안을 OS 주소로 등록</button></span> : null}
        {FILTERS.map(([k, lb]) => (
          <button key={k} type="button" className={`bmf-chip${filter === k ? ' on' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>{lb} {k === 'all' ? total : k === 'none' ? (c.none || 0) + (c.noname || 0) + (c.closed || 0) : c[k] || 0}</button>
        ))}
        <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>주소만 넣습니다 — 계정 · 비밀번호는 넣지 않고, 등록 전에는 접속을 시도하지 않습니다</span>
      </div>
      {msg ? <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{msg}</div> : null}
      {!rows.length ? <div className="muted" style={{ padding: 14 }}>{total ? '이 거르기에 맞는 서버가 없습니다.' : '물리서버가 없습니다(iDRAC 으로 찾은 서버가 이 목록의 대상입니다).'}</div> : (
        <div className="table-wrap" style={{ maxHeight: '62vh' }}>
          <STable minWidth={980} limit={500}>
            <thead><tr>
              <th data-nosort style={{ width: 30 }}><input type="checkbox" aria-label="보이는 제안 전체 선택" disabled={!pickable.length} checked={pickable.length > 0 && pickable.every((r) => chosen.has(r.key))} onChange={(e) => pickable.forEach((r) => toggle(r, e.target.checked))} /></th>
              <th>물리서버 · iDRAC 이 읽은 호스트 이름</th><th>찾은 IP</th><th>어떻게 찾았나</th><th>SSH(22)</th><th>상태</th><th data-nosort>할 일</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const st = STATE_TEXT[r.state] || [r.state, 'gray', ''];
                const on = chosen.has(r.key);
                const canPick = pickableOf(r);
                const sshC = r.cands.filter((x) => x.ssh);
                return (
                  <tr key={r.key} style={r.state === 'registered' ? { color: 'var(--text-dim)' } : undefined}>
                    <td><input type="checkbox" aria-label={`${r.name} 제안 선택`} disabled={!canPick} checked={on} onChange={(e) => toggle(r, e.target.checked)} /></td>
                    <td data-sort={r.name}><b>{r.name || '(이름 없음)'}</b><div className="muted" style={{ fontSize: 11.5 }}>{[r.serviceTag, r.mgmtHost ? `iDRAC ${r.mgmtHost}` : ''].filter(Boolean).join(' · ')}</div></td>
                    <td data-sort={r.cands[0]?.ip || ''} style={{ fontFamily: 'var(--mono, monospace)', fontSize: 12 }}>
                      {r.cands.length ? r.cands.map((x) => <div key={x.ip}>{x.ip}</div>) : <span className="muted">—</span>}
                      {r.reg && r.state === 'differs' ? <div className="muted" style={{ fontSize: 11.5 }}>등록된 주소 {r.reg.host}</div> : null}
                    </td>
                    <td style={{ fontSize: 12 }}>{r.cands.length ? [...new Set(r.cands.flatMap((x) => x.vias || []))].map((v) => <span key={v} className={`badge ${v === 'fwd' ? 'blue' : 'gray'}`} style={{ marginRight: 4 }}>{VIA_TEXT[v] || v}</span>) : <span className="muted">—</span>}</td>
                    <td style={{ fontSize: 12 }}>{r.cands.length ? (sshC.length === r.cands.length ? <span className="badge green">{r.cands.length > 1 ? '모두 열림' : '열림'}</span> : sshC.length ? <span className="badge amber">{sshC.length}/{r.cands.length} 열림</span> : <span className="badge red">닫힘</span>) : <span className="muted">—</span>}</td>
                    <td data-sort={r.state}><span className={`badge ${st[1]}`}>{st[0]}</span> <span className="muted" style={{ fontSize: 12 }}>{st[2]}{r.state === 'registered' && r.reg?.addrOnly ? ' · 주소만(계정 없음)' : ''}</span></td>
                    <td>
                      {r.state === 'suggest' ? <button type="button" className="logout-btn" style={{ flex: 'none', padding: '4px 10px', fontSize: 12 }} disabled={busy} onClick={() => apply([[r.key, sshC[0]?.ip]])}>등록</button>
                        : r.state === 'pick' ? (
                          <Select sort={false} className="input" aria-label={`${r.name} 의 IP 고르기`} value={chosen.get(r.key) || ''} onChange={(e) => setIp(r, e.target.value)} style={{ fontSize: 12, padding: '3px 6px' }}>
                            <option value="">IP 고르기</option>
                            {sshC.map((x) => <option key={x.ip} value={x.ip}>{x.ip}</option>)}
                          </Select>
                        ) : <span className="muted">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        </div>
      )}
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        같은 법인의 스캔 대역 안에서만 찾습니다 · 등록된 주소와 다르면 자동으로 바꾸지 않습니다 · 등록한 주소는 ‘베어메탈 스토리지 › 서버’ 에 비활성으로 들어가며, 그 항목에 계정을 넣으면 사용률 수집이 OS 를 읽기 시작합니다.
        {d.omitted ? ` · ${d.omitted}대는 표시 상한으로 빠졌습니다.` : ''}
      </div>
    </div>
  );
}
