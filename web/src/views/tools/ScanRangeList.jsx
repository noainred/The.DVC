/**
 * ScanRangeList.jsx — IP관리 › 스캔 대역·설정 › ① 등록된 스캔 대역(v2.692, 사용자 요청 "등록된 Scan 대역을 보여주고 수정/삭제 버튼").
 *
 * 대역 1줄 = 1행(사용자 선택). 데이터는 부모가 GET /admin/ipam/scan/ranges 로 받아 넘긴다(② 와 같은 응답을 쓴다 — 두 번 부르지 않게).
 * 수정·삭제·추가는 POST /admin/ipam/scan/ranges/line 이 **그 한 줄만** 바꾼다(같은 에이전트의 다른 줄·설정은 그대로).
 *  · 서버는 `old` 가 지금 값과 다르면 409 — 그 사이 다른 관리자가 바꿨다. 목록을 새로 읽고 그 사실을 말한다.
 *  · 삭제 확인은 행 안에서 한 번 더(브라우저 confirm 대화상자를 쓰지 않는다).
 *  · iDRAC·VM 가져오기는 그 에이전트의 설정 편집기(②)에서 연다 — 겹침 판정·중복 대역 칸이 거기에 있다(판정 사본 금지).
 */
import React, { useMemo, useState } from 'react';
import { postJson } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { checkRangeSpec, serverInvalidText } from './ipmsRangeText.js';
import { CLS_BADGE, CLS_LABEL, agentName, rangeRowCheck } from './scanRangeImportText.js';
import Select from '../../components/Select.jsx';

const TONE = { green: 'var(--green)', amber: 'var(--amber)', red: 'var(--red)', gray: 'var(--text-dim)' };
const BTN = { flex: 'none', padding: '4px 10px', fontSize: 12 };

export function ScanRangeList({ data, err, agentFilter, setAgentFilter, onReload, onOpenEditor, onImport }) {
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null);   // { agent, index, value }
  const [confirmDel, setConfirmDel] = useState(null); // `${agent}|${index}`
  const [addAgent, setAddAgent] = useState('');
  const [addValue, setAddValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const rows = useMemo(() => data?.rows || [], [data]);
  const agents = useMemo(() => data?.agents || [], [data]);
  const sources = useMemo(() => [{ key: 'global', label: '전체(모든 vCenter)' }, ...Object.entries(data?.vcName || {}).map(([id, n]) => ({ key: `vc:${id}`, label: `vCenter ${n}` }))], [data]);
  const counts = useMemo(() => { const m = new Map(); for (const r of rows) m.set(r.agent, (m.get(r.agent) || 0) + 1); return m; }, [rows]);
  const chipAgents = useMemo(() => [...new Set([...agents.map((a) => a.name), ...rows.map((r) => r.agent)])], [agents, rows]);
  const ql = q.trim().toLowerCase();
  const shown = rows.filter((r) => (!agentFilter || r.agent === agentFilter) && (!ql || `${r.range} ${agentName(r.agent)} ${r.datacenterName}`.toLowerCase().includes(ql)));
  const targetAgent = addAgent || agentFilter || chipAgents[0] || '__local__';

  const send = async (body, okText) => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/admin/ipam/scan/ranges/line', body);
      if (r && r.ok === false) {
        const list = (r.invalid || []).map((x) => serverInvalidText(x));
        setMsg({ ok: false, text: r.reason || '서버가 거부했습니다', list });
        if (r.code === 'stale') { setEditing(null); setConfirmDel(null); onReload?.(); }
        return false;
      }
      setMsg({ ok: true, text: `${okText}${(r.warnings || []).length ? ` · 경고 ${r.warnings.length}줄(스캔 상한 등)` : ''}` });
      setEditing(null); setConfirmDel(null); onReload?.(body.agent);
      return true;
    } catch (e) { setMsg({ ok: false, text: e.message }); return false; } finally { setBusy(false); }
  };
  const editCheck = editing ? checkRangeSpec(editing.value, { reversed: 'error' }) : null;
  const addCheck = addValue.trim() ? checkRangeSpec(addValue.trim(), { reversed: 'error' }) : null;

  return (
    <div>
      {err && <div className="banner warn" role="status" style={{ whiteSpace: 'normal', marginBottom: 8 }}>등록된 스캔 대역을 읽지 못했습니다({err}).</div>}
      <div className="flex gap wrap" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="flex gap wrap" role="group" aria-label="에이전트 필터" style={{ alignItems: 'center' }}>
          <button type="button" className={`tab${!agentFilter ? ' active' : ''}`} aria-pressed={!agentFilter} style={BTN} onClick={() => setAgentFilter('')}>전체 {rows.length}</button>
          {chipAgents.map((a) => (
            <button key={a} type="button" className={`tab${agentFilter === a ? ' active' : ''}`} aria-pressed={agentFilter === a} style={BTN} onClick={() => setAgentFilter(a)}>{agentName(a)} {counts.get(a) || 0}</button>
          ))}
        </div>
        <input className="input" style={{ width: 200, maxWidth: '100%', minWidth: 0 }} placeholder="대역·에이전트 검색" value={q} onChange={(e) => setQ(e.target.value)} aria-label="대역 검색" />
      </div>

      <div className="card" style={{ padding: 10, marginTop: 10, minWidth: 0 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <b style={{ fontSize: 12.5 }}>대역 추가</b>
          <Select className="select" value={targetAgent} onChange={(e) => setAddAgent(e.target.value)} aria-label="추가할 에이전트" style={{ maxWidth: '100%', minWidth: 0 }}>
            {chipAgents.map((a) => <option key={a} value={a}>{agentName(a)}</option>)}
          </Select>
          <input className="input" style={{ width: 210, maxWidth: '100%', minWidth: 0, fontFamily: 'monospace' }} placeholder="10.0.0.0/24 · 10.0.0.1-50 · IP" value={addValue} onChange={(e) => setAddValue(e.target.value)} aria-label="추가할 대역" />
          <button className="login-btn" style={{ ...BTN, padding: '5px 12px' }} disabled={busy || !addCheck?.ok}
            onClick={async () => { const v = addValue.trim(); if (await send({ agent: targetAgent, op: 'add', value: v }, `${agentName(targetAgent)} 에 ${v} 를 추가했습니다.`)) setAddValue(''); }}>＋ 추가</button>
          <button className="logout-btn" style={BTN} title="그 에이전트의 설정 편집기에서 DataCenter 의 iDRAC 스캔 대역 서비스 1개를 골라 /24 로 가져옵니다" onClick={() => onImport?.('idrac', targetAgent)}>🖥️ iDRAC 대역 가져오기</button>
          <button className="logout-btn" style={BTN} title="그 에이전트의 설정 편집기에서 vCenter VM 주소를 /24 로 가져옵니다" onClick={() => onImport?.('vm', targetAgent)}>🧩 VM 대역 가져오기</button>
        </div>
        {addCheck && !addCheck.ok && <div style={{ fontSize: 11, marginTop: 4, color: 'var(--red)' }}>✕ {addCheck.reason}</div>}
        {addCheck?.warn && <div style={{ fontSize: 11, marginTop: 4, color: 'var(--amber)' }}>△ {addCheck.warn}</div>}
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>추가·수정·삭제는 그 한 줄만 바로 저장합니다. 가져오기는 그 에이전트의 ‘② 에이전트별 대역·보고 현황’ 편집기에서 열립니다(겹침 검사·중복 대역 칸이 거기에 있습니다).</div>
      </div>

      {msg && (
        <div style={{ fontSize: 12, marginTop: 8, color: msg.ok ? 'var(--green)' : 'var(--red)', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
          {msg.text}
          {msg.list?.length > 0 && <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{msg.list.slice(0, 10).map((t, i) => <li key={i}>{t}</li>)}</ul>}
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        <STable className="v3-table" minWidth={1040}>
          <thead><tr><th>대역</th><th style={{ textAlign: 'right' }}>IP 수</th><th>에이전트</th><th>데이터센터</th><th>분류</th><th>스캔</th><th>검사</th><th style={{ textAlign: 'right' }}>응답 IP</th><th data-nosort>작업</th></tr></thead>
          <tbody>
            {shown.map((r) => {
              const key = `${r.agent}|${r.index}`;
              const isEdit = editing && editing.agent === r.agent && editing.index === r.index;
              const chk = rangeRowCheck(r, sources);
              return (
                <tr key={key} style={isEdit ? { background: 'rgba(59,130,246,.08)' } : undefined}>
                  <td style={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }} data-sort={r.range}>
                    {isEdit ? (
                      <div>
                        <input className="input" autoFocus value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} aria-label="대역 수정" style={{ width: 190, maxWidth: '100%', minWidth: 0, fontFamily: 'monospace' }}
                          onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }} />
                        {editCheck && !editCheck.ok && <div style={{ fontSize: 11, color: 'var(--red)', whiteSpace: 'normal' }}>✕ {editCheck.reason}</div>}
                      </div>
                    ) : r.range}
                  </td>
                  <td style={{ textAlign: 'right' }} data-sort={r.size ?? ''}>{r.size == null ? '—' : r.size.toLocaleString()}</td>
                  <td><button type="button" style={{ background: 'none', border: 0, padding: 0, color: 'inherit', font: 'inherit', cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3 }} onClick={() => onOpenEditor?.(r.agent)} title="이 에이전트의 설정 편집기를 엽니다">{agentName(r.agent)}</button></td>
                  <td>{r.datacenterName || <span className="muted">—</span>}</td>
                  <td data-sort={r.cls || ''}>{r.cls ? <span className={`badge ${CLS_BADGE[r.cls] || 'gray'}`}>{CLS_LABEL[r.cls] || r.cls}</span> : <span className="muted">—</span>}</td>
                  <td><span className={`badge ${r.agentEnabled ? 'green' : 'gray'}`} title={r.agentEnabled ? '그 에이전트의 주기 스캔이 켜져 있습니다' : '그 에이전트의 주기 스캔이 꺼져 있어 이 줄도 스캔하지 않습니다'}>{r.agentEnabled ? '켜짐' : '꺼짐(에이전트)'}</span></td>
                  <td style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 160, color: TONE[chk.tone], fontSize: 12 }} data-sort={chk.tone}>{chk.text}</td>
                  <td style={{ textAlign: 'right' }} data-sort={r.alive}>{r.alive.toLocaleString()}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {isEdit ? (
                      <>
                        <button className="login-btn" style={BTN} disabled={busy || !editCheck?.ok || editing.value.trim() === r.range}
                          onClick={() => send({ agent: r.agent, op: 'edit', index: r.index, old: r.range, value: editing.value.trim() }, `${r.range} → ${editing.value.trim()} 로 바꿨습니다.`)}>저장</button>{' '}
                        <button className="logout-btn" style={BTN} onClick={() => setEditing(null)}>취소</button>
                      </>
                    ) : confirmDel === key ? (
                      <>
                        <span style={{ fontSize: 11, color: 'var(--red)' }}>이 줄을 지울까요? </span>
                        <button className="logout-btn" style={{ ...BTN, color: 'var(--red)' }} disabled={busy} onClick={() => send({ agent: r.agent, op: 'delete', index: r.index, old: r.range }, `${agentName(r.agent)} 의 ${r.range} 를 지웠습니다.`)}>지우기</button>{' '}
                        <button className="logout-btn" style={BTN} onClick={() => setConfirmDel(null)}>취소</button>
                      </>
                    ) : (
                      <>
                        <button className="logout-btn" style={BTN} disabled={busy} onClick={() => { setConfirmDel(null); setEditing({ agent: r.agent, index: r.index, value: r.range }); }}>수정</button>{' '}
                        <button className="logout-btn" style={{ ...BTN, color: 'var(--red)' }} disabled={busy} onClick={() => { setEditing(null); setConfirmDel(key); }}>삭제</button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </STable>
      </div>
      {data && shown.length === 0 && <div className="muted" style={{ marginTop: 8 }}>{rows.length ? '조건에 맞는 대역이 없습니다.' : '등록된 스캔 대역이 없습니다 — 위에서 추가하거나 가져오세요.'}</div>}
      <div className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>
        분류는 IPMS 설정 ③ 공인/사설 기준입니다. 검사 칸은 형식 오류·IPMS 무시 대역(전체 + 그 에이전트가 수집하는 vCenter)·다른 에이전트와의 겹침을 봅니다.
        응답 IP 는 그 에이전트가 보고한 스캔 결과 중 그 줄 안에 드는 개수입니다(줄끼리 겹치면 각 줄에 셉니다).
      </div>
    </div>
  );
}
