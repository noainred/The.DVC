import React, { useEffect, useMemo, useState } from 'react';
import BoldText from '../../components/boldText.jsx';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { NOTE, MONO, ROW, GRID1, LINKBTN, Seg, Tiles, CvpSelect, Pill } from './CvpNetParts.jsx';
import { LAYER_DEFS, LINK_DEFS, FIELD_LABEL, fieldValue, linkCheckState, layoutNodes, TOPO_NOTE, MISMATCH_NOTE, speedText, TONE } from './cvpNetText.js';

/**
 * CVP › 토폴로지(v3.38 ⑥ 자동 지도 · ⑦ 양끝 불일치). `/tools/cvp/topology` 마운트 1회 + 새로고침(폴링 없음).
 * 판정(링크 종류 · 층 · 불일치)은 서버 cvp/topology.js — 이 화면은 그리기만 한다.
 */
const W = 1100; const BOX_W = 104; const BOX_H = 36;
// v3.42(버그 점검 1회차 D9): 한 줄 대수는 상자 폭 + 틈으로 계산한다 — 10대면 간격 100px < 상자 104px 라 테두리가 겹쳤다.
const PER_ROW = Math.max(1, Math.floor(W / (BOX_W + 8)) - 1);
const CHECK_DEFS = { diff: { label: '다름', color: TONE.red }, na: { label: '비교 못 함', color: TONE.amber }, ok: { label: '같음', color: TONE.green }, none: { label: '비교 안 함', color: 'var(--text-dim)' } };

function TopoMap({ nodes, links, sel, onSel, problemsOnly }) {
  const lay = useMemo(() => layoutNodes(nodes, { width: W, perRow: PER_ROW }), [nodes]);
  const [focusId, setFocusId] = useState(null);   // v3.42(2회차 A5 추정): 키보드 포커스 표시(SVG g 는 브라우저 기본 외곽선이 없을 수 있다)
  const ids = new Set(nodes.map((n) => n.id));
  const shown = links.filter((l) => ids.has(l.a) && ids.has(l.b));
  // v3.42(2회차 F8): 키보드 Tab 순서 = 화면 순서(위 층부터 · 왼쪽부터) — 서버 순서로 그리면 스파인이 위인데 Tab 은 이름 순으로 돌았다.
  const drawOrder = useMemo(() => [...nodes].filter((n) => lay.pos.get(n.id)).sort((x, y) => lay.pos.get(x.id).y - lay.pos.get(y.id).y || lay.pos.get(x.id).x - lay.pos.get(y.id).x), [nodes, lay]);
  return (
    <div style={{ overflowX: 'auto', minWidth: 0 }}>
      <svg width="100%" viewBox={`0 0 ${W} ${lay.height}`} role="group" aria-label="스위치 연결 지도 — 장비 상자에서 Enter 로 선택" style={{ display: 'block', minWidth: 720, background: 'var(--panel-deep, #0f1626)', borderRadius: 10 }}>
        {lay.bands.map((b) => (
          <text key={b.layer} x="10" y={b.y - 8} fill="#8ea0bd" fontSize="12">{LAYER_DEFS[b.layer]?.label || b.layer}</text>
        ))}
        {shown.map((l, i) => {
          const a = lay.pos.get(l.a); const b = lay.pos.get(l.b);
          if (!a || !b) return null;
          const st = linkCheckState(l);
          const hot = sel && (l.a === sel || l.b === sel);
          const dim = (problemsOnly && st !== 'diff') || (sel && !hot);
          const def = LINK_DEFS[l.kind] || LINK_DEFS.one;
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={st === 'diff' ? '#f87171' : def.color} strokeWidth={hot || st === 'diff' ? 2.2 : 1.3} strokeDasharray={def.dash || undefined} opacity={dim ? 0.15 : 0.9} />;
        })}
        {drawOrder.map((n) => {
          const p = lay.pos.get(n.id);
          if (!p) return null;
          const on = sel === n.id;
          const name = n.hostname.length > 15 ? `${n.hostname.slice(0, 14)}…` : n.hostname;
          return (
            <g key={n.id} transform={`translate(${p.x - BOX_W / 2}, ${p.y - BOX_H / 2})`} onClick={() => onSel(on ? null : n.id)}
              role="button" tabIndex={0} aria-pressed={on} aria-label={`${n.hostname} — ${LAYER_DEFS[n.layer]?.label || n.layer}`}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSel(on ? null : n.id); } }}
              onFocus={() => setFocusId(n.id)} onBlur={() => setFocusId((x) => (x === n.id ? null : x))} style={{ cursor: 'pointer', outline: 'none' }}>
              <title>{`${n.hostname} — ${LAYER_DEFS[n.layer]?.label || n.layer} · 스위치 이웃 ${n.switchNeighbors}${n.esxi + n.otherNeighbors ? ` · 서버 등 ${n.esxi + n.otherNeighbors}` : ''}${n.lldpRead ? '' : ' · LLDP 못 읽음'}${n.lldpFailing ? ' · LLDP 마지막 읽기 실패 — 이전 이웃으로 그렸습니다' : ''}${n.lldpAt ? ` · LLDP 읽은 시각 ${new Date(n.lldpAt).toLocaleString()}` : ''}`}</title>
              <rect width={BOX_W} height={BOX_H} rx="6" fill={on ? '#1e3a8a' : '#16213a'} stroke={on ? '#93c5fd' : n.lldpRead && !n.lldpFailing ? '#3b4b6b' : '#b45309'} strokeDasharray={n.lldpRead && !n.lldpFailing ? undefined : '4 3'} strokeWidth={on ? 2 : 1} />
              {focusId === n.id ? <rect x={-3} y={-3} width={BOX_W + 6} height={BOX_H + 6} rx="8" fill="none" stroke="#fbbf24" strokeWidth="2" /> : null}
              <text x={BOX_W / 2} y="15" textAnchor="middle" fill="#e5edf9" fontSize="11" fontFamily="var(--mono)">{name}</text>
              <text x={BOX_W / 2} y="29" textAnchor="middle" fill="#8ea0bd" fontSize="9.5">{n.esxi || n.otherNeighbors ? `ESXi ${n.esxi} · 기타 ${n.otherNeighbors}` : n.lldpRead ? `이웃 ${n.switchNeighbors}` : 'LLDP 못 읽음'}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function LinkTable({ links, onlyCheck }) {
  const rows = onlyCheck ? links.filter((l) => ['diff', 'na'].includes(linkCheckState(l))) : links;
  return (
    <>
      <STable className="v3-table" minWidth={1040}>
        <thead><tr><th>스위치 A</th><th>포트</th><th>스위치 B</th><th>포트</th><th>종류</th><th>속도</th><th>양끝 비교</th><th data-nosort>다른 값 · 비교 못 함</th></tr></thead>
        <tbody>
          {rows.map((l, i) => {
            const st = linkCheckState(l);
            const items = (l.items || []).filter((x) => x.state === 'diff' || x.state === 'na');
            return (
              <tr key={`${l.a}|${l.aPort}|${l.b}|${l.bPort}|${i}`}>
                <td style={MONO}>{l.aName}</td><td style={MONO}>{l.aPort}</td>
                <td style={MONO}>{l.bName}</td><td style={MONO}>{l.bPort || '—'}</td>
                <td><span style={{ color: LINK_DEFS[l.kind]?.color }}>{LINK_DEFS[l.kind]?.label || l.kind}</span>{l.kind === 'one' && !l.bLldpRead ? <span style={{ ...NOTE, marginLeft: 6 }}>(상대 LLDP 못 읽음)</span> : null}</td>
                <td data-sort={l.speedBps ?? ''}>{speedText(l.speedBps)}</td>
                <td data-sort={['diff', 'na', 'ok', 'none'].indexOf(st)}><Pill color={CHECK_DEFS[st].color}>{CHECK_DEFS[st].label}</Pill></td>
                <td style={{ whiteSpace: 'normal', minWidth: 240, fontSize: 12.5 }}>
                  {items.length ? items.map((x, k) => (
                    <div key={k} style={{ color: x.state === 'diff' ? '#fca5a5' : '#fcd34d' }}>{FIELD_LABEL[x.field] || x.field}: {fieldValue(x.field, x.a)} ↔ {fieldValue(x.field, x.b)}</div>
                  )) : st === 'none' ? <span style={NOTE}>{l.kind === 'desc' ? '설명으로만 찾은 링크 — 상대 포트 모름' : '상대 포트 모름'}</span> : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </STable>
      {!rows.length && <div style={NOTE}>{onlyCheck ? '다르거나 비교 못 한 링크가 없습니다.' : '링크가 없습니다.'}</div>}
    </>
  );
}

export default function CvpTopologyView({ servers = [], onOpen }) {
  const [cvpId, setCvpId] = useState('');
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  const [reload, setReload] = useState(0);
  const [view, setView] = useState('map');
  const [corp, setCorp] = useState(null);
  const [sel, setSel] = useState(null);
  const [problemsOnly, setProblemsOnly] = useState(false);
  useEffect(() => {
    let active = true;
    setErr(null); setR(null); setSel(null);
    fetchJson('/tools/cvp/topology', cvpId ? { cvpId } : {}).then((x) => { if (active) setR(x); }).catch((e) => { if (active) setErr(e); });
    return () => { active = false; };
  }, [cvpId, reload]);
  const nodesAll = useMemo(() => (r && Array.isArray(r.nodes) ? r.nodes : []), [r]);
  const corps = useMemo(() => {
    const m = new Map();
    for (const n of nodesAll) m.set(n.corpName || '', (m.get(n.corpName || '') || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [nodesAll]);
  // 지도는 법인 하나씩(전체를 한 장에 그리면 읽을 수 없다) — 기본은 스위치가 가장 많은 법인.
  // v3.42(D3): 고른 법인이 새 응답(다른 CVP)에 없으면 기본값으로 — 그대로 두면 장비 0대 지도에 갇혔다(법인 하나면 칩 줄이 숨어 되돌릴 수 없었다).
  const corpOk = corp != null && (corp === '__all' || corps.some(([name]) => name === corp));
  const corpSel = corpOk ? corp : (corps.length > 1 ? corps[0][0] : '__all');
  const nodes = corpSel === '__all' ? nodesAll : nodesAll.filter((n) => (n.corpName || '') === corpSel);
  const ids = new Set(nodes.map((n) => n.id));
  const links = (r && Array.isArray(r.links) ? r.links : []).filter((l) => ids.has(l.a) || ids.has(l.b));
  const c = r?.counts || {};
  const selNode = sel ? nodes.find((n) => n.id === sel) : null;
  const selLinks = selNode ? links.filter((l) => l.a === sel || l.b === sel) : [];
  return (
    <div style={GRID1}>
      <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={ROW}>
          <b style={{ fontSize: 15 }}>토폴로지</b>
          <Seg label="보기" value={view} onChange={setView} items={[['map', '지도'], ['links', '링크 표'], ['mismatch', '양끝 불일치']]} />
          <CvpSelect servers={servers} value={cvpId} onChange={setCvpId} />
          <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={() => setReload((x) => x + 1)}>새로고침</button>
        </div>
        <div style={NOTE}><BoldText text={view === 'mismatch' ? MISMATCH_NOTE : TOPO_NOTE} /></div>
        {corps.length > 1 && (
          <div style={ROW}>
            <span style={NOTE}>법인</span>
            {corps.map(([name, n]) => <button key={name || '-'} type="button" className={`tab${corpSel === name ? ' active' : ''}`} onClick={() => { setCorp(name); setSel(null); }}>{name || '법인 미지정'} <b style={MONO}>{n}</b></button>)}
            <button type="button" className={`tab${corpSel === '__all' ? ' active' : ''}`} onClick={() => { setCorp('__all'); setSel(null); }}>전체 <b style={MONO}>{nodesAll.length}</b></button>
          </div>
        )}
      </div>
      {err && <ErrorBox error={err} />}
      {!r && !err && <Loading />}
      {r && (<>
        <Tiles tiles={[
          ['스위치', `${nodes.length}대`, `LLDP 를 읽은 장비 ${nodes.filter((n) => n.lldpRead).length}대`, 'var(--text)'],
          ['양쪽 확인 링크', links.filter((l) => l.kind === 'both').length, '서로 이웃으로 본 링크', LINK_DEFS.both.color],
          ['추정 링크', links.filter((l) => l.kind !== 'both').length, '한쪽만 · 설명만', LINK_DEFS.one.color],
          ['양끝 다름', links.filter((l) => linkCheckState(l) === 'diff').length, '속도 · MTU · Duplex · 관리 상태 · 채널 · 설명', TONE.red],
          ['비교 못 함', links.filter((l) => linkCheckState(l) === 'na').length, '한쪽 값을 못 읽음', TONE.amber],
        ]} />
        <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {view === 'map' && (<>
            <div style={{ ...ROW, gap: '6px 16px', fontSize: 12 }}>
              {Object.entries(LINK_DEFS).map(([k, d]) => <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><svg width="26" height="8" aria-hidden="true"><line x1="0" x2="26" y1="4" y2="4" stroke={d.color} strokeWidth="2" strokeDasharray={d.dash || undefined} /></svg>{d.label}</span>)}
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><svg width="26" height="8" aria-hidden="true"><line x1="0" x2="26" y1="4" y2="4" stroke="#f87171" strokeWidth="2.2" /></svg>양끝 다름</span>
              <button type="button" className={`tab${problemsOnly ? ' active' : ''}`} aria-pressed={problemsOnly} onClick={() => setProblemsOnly((x) => !x)} style={{ marginLeft: 'auto' }}>문제 링크만 강조</button>
            </div>
            {nodes.length ? <TopoMap nodes={nodes} links={links} sel={sel} onSel={setSel} problemsOnly={problemsOnly} /> : <div style={NOTE}>스위치가 없습니다.</div>}
            {selNode ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={ROW}>
                  <b style={MONO}>{selNode.hostname}</b><span style={NOTE}>{selNode.model} · {LAYER_DEFS[selNode.layer]?.label} · 스위치 이웃 {selNode.switchNeighbors} · ESXi {selNode.esxi} · 기타 {selNode.otherNeighbors}{selNode.lldpRead ? '' : ' · LLDP 못 읽음'}</span>
                  <button type="button" className="btn" onClick={() => onOpen && onOpen({ cvpId: selNode.cvpId, key: selNode.key, hostname: selNode.hostname })}>장비 상세</button>
                </div>
                <LinkTable links={selLinks} onlyCheck={false} />
              </div>
            ) : <div style={NOTE}>장비를 누르면 그 장비의 링크와 양끝 비교가 아래에 나옵니다. 점선 테두리 = 그 장비의 LLDP 를 못 읽었거나 마지막 읽기가 실패함(이전 이웃으로 그림).</div>}
          </>)}
          {view === 'links' && <LinkTable links={links} onlyCheck={false} />}
          {view === 'mismatch' && <LinkTable links={links} onlyCheck />}
          <div style={NOTE}>전체 링크 {c.both + c.one + c.desc || 0}개(양쪽 {c.both ?? 0} · 한쪽 {c.one ?? 0} · 설명 {c.desc ?? 0}){r.lldpTruncated ? ' · ⚠ LLDP 행이 상한을 넘어 일부만 봤습니다' : ''}{r.truncated ? ' · ⚠ 포트 행이 상한을 넘어 일부만 봤습니다' : ''}{r.portsUnread ? ` · 포트 목록을 못 읽은 장비 ${r.portsUnread}대는 양끝 값이 없어 ‘비교 못 함’ 이고 설명 링크를 그리지 않습니다` : ''}</div>
        </div>
      </>)}
    </div>
  );
}
