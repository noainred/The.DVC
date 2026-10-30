/**
 * Bareos 관리 도구의 '백업 그룹' 탭(v2.830 · 사용자 요청 '전체 VM 이 보이고, 고른 VM 을 그룹으로 만들어 백업 — 이름·스케줄·스토리지 지정, 나중에 수정').
 *   법인(vCenter) 하나의 **전체 VM** 을 폴더 트리로 보이고(시스템 VM 제외), 체크한 VM 으로 그룹을 만들거나 기존 그룹에 더한다.
 *   스케줄은 포탈이 돌린다(서버 bareos/groupRunner.js — Bareos 에는 잡 스케줄 수정 명령이 없다). 잡 없는 VM 은 저장할 때 Director 스케줄 없이 등록된다.
 *   값은 GET /api/tools/bareos-backup/groups/tree(원장·표시·인벤토리 — Director 에 접속하지 않는다). 판정·문구는 bareosGroupText.js.
 * ⚠ 훅은 조기 return 위 · 늦게 온 이전 법인의 응답은 버린다 · 조회 실패 상태로 저장 버튼을 열지 않는다 · 무거운 조회는 마운트 1회 + 버튼(실행 중일 때만 다시 읽는다).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../../api.js';
import { Loading, ErrorBox, Modal } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import DataList from '../../components/DataList.jsx';
import BoldText from '../../components/boldText.jsx';
import { MethodBadge } from './BackupMarkIcons.jsx';
import { fmtGb, flattenBareosTree, initialBareosOpen, shortTs } from './bareosViewText.js';
import { relayWaitMs, outcomeUnknown, unknownOutcomeText } from './bareosText.js';
import {
  DAY_NAMES, LEVELS, NEW_SCHEDULE, scheduleText, draftIssues, toggleDay, GROUP_FILTERS, groupFilterCounts, pickable, buildGroupTree, checkState,
  FIRE_STATE_TEXT, FIRE_STATE_TONE, fireText, fireTone, nextText, storageText,
} from './bareosGroupText.js';

const BASE = '/tools/bareos-backup';
const enc = encodeURIComponent;
const VC_KEY = 'bareos-groups-vc';
const ROW = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 };
const BTN = { padding: '4px 10px', fontSize: 12 };
const WRAP = { whiteSpace: 'normal', overflowWrap: 'anywhere' };   // 표 셀 기본은 한 줄 — 긴 글이 표를 카드 밖으로 밀었다(v2.830 Chromium 1440 확인)
const TONE = { ok: '#86efac', warn: '#fcd34d', bad: '#fca5a5', muted: 'var(--text-dim)' };
const GRID = '34px minmax(220px, 2.2fr) 52px 76px 86px minmax(170px, 1.4fr) minmax(110px, 1fr)';
const loadVc = () => { try { return localStorage.getItem(VC_KEY) || ''; } catch { return ''; } };
const saveVc = (v) => { try { localStorage.setItem(VC_KEY, v); } catch { /* 저장 못 해도 동작 */ } };
const errText = (e) => e?.body?.reason || e?.message || String(e);
const MISSED_REASON = { down: '포탈이 꺼져 있었음', edited: '돌 차례에 스케줄을 고쳐 돌리지 않음' };
const missedReason = (m) => MISSED_REASON[m?.reason] || MISSED_REASON.down;

/** 폴더 체크박스 — 일부만 고르면 가운데 상태(indeterminate). */
function TriCheck({ state, disabled, onChange, label }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = state === 'some'; }, [state]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={state === 'all'} disabled={disabled} onChange={onChange} />;
}

export default function BareosGroupsTab({ d }) {
  const [vcs, setVcs] = useState(null);
  const [vcErr, setVcErr] = useState(null);
  const [vc, setVc] = useState(loadVc);
  const [tree, setTree] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState(() => new Set());
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const [editor, setEditor] = useState(null);   // { group|null, vmIds }
  const [runOf, setRunOf] = useState(null);
  const [fireOf, setFireOf] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(() => new Set());
  const gen = useRef(0);
  const openedFor = useRef('');
  const vcRef = useRef(vc);   // v2.830 검토 L7: 늦게 온 실행·삭제·저장 응답의 안내를 법인을 바꾼 뒤의 화면에 띄우지 않는다
  vcRef.current = vc;

  useEffect(() => { fetchJson('/vcenters').then((r) => setVcs(Array.isArray(r) ? r : [])).catch(setVcErr); }, []);
  // 법인 = Director 에 묶인 vCenter(관리 도구 목록의 directors[].vcenters). 이름은 vCenter 목록에서.
  const options = useMemo(() => {
    const name = new Map((vcs || []).map((v) => [v.id, v.name || v.id]));
    const out = [];
    for (const dir of d?.directors || []) for (const id of dir.vcenters || []) if (!vcs || name.has(id)) out.push({ id, label: `${name.get(id) || id} · ${dir.name}` });
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }, [vcs, d?.directors]);
  useEffect(() => {   // 고른 법인이 목록에 없으면(범위·매핑이 바뀜) 첫 법인으로
    if (!vcs || !options.length) return;
    if (!options.some((o) => o.id === vc)) setVc(options[0].id);
  }, [options, vc, vcs]);

  const load = () => {
    const g = ++gen.current;
    if (!vc) { setTree(null); return; }
    setLoading(true); setErr(null);
    fetchJson(`${BASE}/groups/tree`, { vcenterId: vc })
      .then((r) => { if (g === gen.current) setTree(r); })
      .catch((e) => { if (g === gen.current) { setErr(e); setTree(null); } })
      .finally(() => { if (g === gen.current) setLoading(false); });
  };
  // 법인을 바꾸면 이전 법인의 창(편집·실행·결과)과 안내를 닫는다 — 열어 둔 채 바꾸면 새 법인의 트리 위에 이전 법인의 그룹이 다시 떴다
  useEffect(() => { saveVc(vc); setSel(new Set()); setTree(null); setEditor(null); setRunOf(null); setFireOf(null); setMsg(null); load(); }, [vc]);   // eslint-disable-line react-hooks/exhaustive-deps
  // 실행 중인 그룹이 있을 때만 다시 읽는다(결과 기록을 보려고) — 그 밖에는 버튼으로
  const running = !!tree?.groups?.some((x) => x.running);
  useEffect(() => {
    if (!running) return undefined;
    const t = setTimeout(load, 4000);
    return () => clearTimeout(t);
  }, [running, tree]);   // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => tree?.groups || [], [tree]);
  const groupName = useMemo(() => { const m = new Map(groups.map((g) => [g.id, g.name])); return (id) => m.get(id) || ''; }, [groups]);
  const vms = useMemo(() => tree?.vms || [], [tree]);
  const byId = useMemo(() => new Map(vms.map((v) => [v.id, v])), [vms]);
  const counts = useMemo(() => groupFilterCounts(vms), [vms]);
  const built = useMemo(() => (tree ? buildGroupTree(vms, { filter, q, groupName }) : null), [tree, vms, filter, q, groupName]);
  useEffect(() => {   // 처음 연 법인은 두 단계까지 펼친다
    if (built && openedFor.current !== vc) { openedFor.current = vc; setOpen(initialBareosOpen(built)); }
  }, [built, vc]);
  const forceOpen = !!q.trim() || filter !== 'all';
  const flat = useMemo(() => flattenBareosTree(built, open, forceOpen), [built, open, forceOpen]);
  // 고른 VM 중 지금 고를 수 없게 된 것(다른 그룹에 들어감·목록에서 사라짐)은 뺀다
  useEffect(() => {
    if (!tree) return;
    setSel((s) => { const n = new Set([...s].filter((id) => byId.has(id) && pickable(byId.get(id), { groupName }).ok)); return n.size === s.size ? s : n; });
  }, [tree, byId, groupName]);

  const writable = !!tree?.writable && !tree?.groupsLoadError && !tree?.registryLoadError;
  const toggleSel = (ids, on) => setSel((s) => { const n = new Set(s); for (const id of ids) { if (on) n.add(id); else n.delete(id); } return n; });
  const toggleOpen = (key) => setOpen((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const mark = (id, on) => setBusy((b) => { const n = new Set(b); if (on) n.add(id); else n.delete(id); return n; });

  const sameVc = (v0) => vcRef.current === v0;
  const remove = async (g) => {
    if (!window.confirm(`‘${g.name}’ 그룹을 지울까요?\n그룹만 지웁니다 — VM ${g.vmIds.length}대의 백업 대상(잡)과 백업 데이터는 그대로 남습니다.`)) return;
    const v0 = vc; mark(g.id, true); setMsg(null);
    try {
      const r = await delJson(`${BASE}/groups/${enc(g.id)}`);
      if (r?.ok === false) throw new Error(r.reason || '지우지 못했습니다.');
      if (sameVc(v0)) setMsg({ ok: true, text: `‘${g.name}’ 그룹을 지웠습니다(백업 대상은 남김).` });
    } catch (e) { if (sameVc(v0)) setMsg({ ok: false, text: `오류: ${errText(e)}` }); } finally { mark(g.id, false); if (sameVc(v0)) load(); }
  };
  const run = async (g, level) => {
    const v0 = vc; setRunOf(null); mark(g.id, true); setMsg(null);
    try {
      const r = await postJson(`${BASE}/groups/${enc(g.id)}/run`, level ? { level } : {});
      if (r?.ok === false) throw new Error(r.reason || '실행하지 못했습니다.');
      if (sameVc(v0)) setMsg({ ok: true, text: `‘${g.name}’ 그룹 실행을 보냈습니다 — 결과는 **마지막 실행** 칸에 곧 보입니다.` });
    } catch (e) { if (sameVc(v0)) setMsg({ ok: false, text: outcomeUnknown(e) ? `결과 모름: ${unknownOutcomeText('그룹 실행', e)}` : `오류: ${errText(e)}` }); } finally { mark(g.id, false); if (sameVc(v0)) load(); }
  };

  if (vcErr) return <ErrorBox error={vcErr} />;
  if (!vcs) return <Loading />;
  if (!options.length) {
    return <div className="card" style={{ padding: 14, fontSize: 13 }}>Director 에 묶인 법인(vCenter)이 없습니다 — <b>설정</b> 탭에서 법인별 Director 를 추가하고 vCenter 를 묶은 뒤 그룹을 만들 수 있습니다.</div>;
  }
  const sitesNote = tree && !tree.mapped ? `이 법인의 Director 매핑이 덜 됐습니다(${(tree.mappingMissing || []).join('·') || 'Director 없음'}) — 새 VM 은 등록되지 않습니다(설정 탭에서 채우세요).` : '';

  return (
    <div>
      <div style={{ ...ROW, marginBottom: 10 }}>
        <span className="muted" style={{ fontSize: 12 }}>법인</span>
        <Select className="input" value={vc} onChange={(e) => setVc(e.target.value)} style={{ minWidth: 0, maxWidth: 360 }} aria-label="법인 vCenter">
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </Select>
        <button type="button" className="logout-btn" style={BTN} disabled={loading} onClick={load}>{loading ? '읽는 중…' : '새로고침'}</button>
        {tree?.tz && <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>스케줄 시각은 포탈 서버 시각({tree.tz}) · 포탈이 실행합니다</span>}
      </div>
      {msg && <div className={`banner ${msg.ok ? 'ok' : 'bad'}`} style={{ marginBottom: 10 }}><BoldText text={msg.text} /></div>}
      {err && <ErrorBox error={err} />}
      {tree?.groupsLoadError && <div className="banner bad" style={{ marginBottom: 10 }}>백업 그룹 원장을 읽지 못했습니다(손상본 보존) — 그룹 저장과 예약 실행을 멈췄습니다. 서비스 점검에서 확인하세요.</div>}
      {tree?.registryLoadError && <div className="banner bad" style={{ marginBottom: 10 }}>백업 대상 원장을 읽지 못했습니다(손상본 보존) — 그룹 저장·실행을 멈췄습니다.</div>}
      {sitesNote && <div className="banner warn" style={{ marginBottom: 10 }}>{sitesNote}</div>}
      {tree && !tree.writable && <div className="banner warn" style={{ marginBottom: 10 }}>조회 전용 범위입니다 — 이 법인의 그룹은 볼 수만 있습니다(쓰기 범위가 필요합니다).</div>}
      {!tree && !err && <Loading />}

      {tree && (
        <>
          {/* ① 그룹 목록 */}
          <div className="card" style={{ padding: 0, marginBottom: 14, minWidth: 0 }}>
            <div style={{ ...ROW, padding: '10px 14px', borderBottom: '1px solid var(--border-soft)' }}>
              <b>백업 그룹 {groups.length}개</b>
              <span className="muted" style={{ fontSize: 12 }}>VM 하나는 그룹 하나에만 들어갑니다 · 포탈이 꺼져 있던 회차는 다시 켜졌을 때 {Math.round((tree.catchupMs || 0) / 3_600_000)}시간 안의 마지막 회차만 한 번 돌립니다</span>
            </div>
            {groups.length === 0 ? (
              <div className="muted" style={{ padding: 14, fontSize: 13 }}>아직 그룹이 없습니다 — 아래 트리에서 VM 을 고른 뒤 <b>새 그룹 만들기</b> 를 누르세요.</div>
            ) : (
              <STable minWidth={900}>
                <thead><tr><th>이름</th><th className="right">VM</th><th>스케줄</th><th>다음 실행</th><th>스토리지 · 풀</th><th>마지막 실행</th><th data-nosort>동작</th></tr></thead>
                <tbody>
                  {groups.map((g) => {
                    const b = busy.has(g.id) || g.running;
                    return (
                      <tr key={g.id}>
                        <td style={{ ...WRAP, minWidth: 140 }}><b>{g.name}</b>{g.running && <span className="badge blue" style={{ marginLeft: 6, fontSize: 11 }}>실행 중</span>}
                          <div className="muted" style={{ fontSize: 11.5 }}>{g.updatedBy || g.createdBy || '—'} · {shortTs(g.updatedAt)}</div></td>
                        <td className="right" data-sort={g.vmIds.length}>{g.vmIds.length}대</td>
                        <td style={{ ...WRAP, fontSize: 12.5, minWidth: 150 }}>{g.scheduleText}{g.missed && <div style={{ color: TONE.warn, fontSize: 11.5 }}>돌리지 않은 회차 {g.missed.key}({missedReason(g.missed)})</div>}</td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }} data-sort={g.next?.at ?? ''}>{g.next ? <>{shortTs(g.next.at)}<div className="muted" style={{ fontFamily: 'inherit' }}>{g.next.level}</div></> : nextText(null)}</td>
                        <td style={{ ...WRAP, fontSize: 12.5, minWidth: 130 }}>{storageText(g, tree.siteDefaults).split(' · ').map((x, i) => <div key={i} className={i ? 'muted' : undefined}>{x}</div>)}</td>
                        <td style={{ ...WRAP, fontSize: 12.5, minWidth: 150, color: TONE[fireTone(g.lastFire)] }} data-sort={g.lastFire?.at ?? ''}>
                          {g.sending && !g.running && <div style={{ color: TONE.warn, fontSize: 11.5 }}>{g.sending.key || '수동'} 실행을 보내는 도중 포탈이 재시작했습니다 — 일부 VM 은 보내지 않았을 수 있습니다(백업 대상 탭에서 확인).</div>}
                          {g.lastFire ? <button type="button" className="linklike" onClick={() => setFireOf(g)} style={{ color: 'inherit', background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left', font: 'inherit', textDecoration: 'underline dotted' }}>{fireText(g.lastFire)}</button> : '—'}
                        </td>
                        <td style={{ minWidth: 150 }}>
                          <div style={{ ...ROW, gap: 4 }}>
                            <button type="button" className="logout-btn" style={BTN} disabled={!writable || b} onClick={() => setRunOf(g)}>지금 실행</button>
                            <button type="button" className="logout-btn" style={BTN} disabled={!writable || b} onClick={() => setEditor({ group: g, vmIds: g.vmIds })}>수정</button>
                            <button type="button" className="logout-btn" style={{ ...BTN, color: '#fca5a5' }} disabled={!writable || b} onClick={() => remove(g)}>삭제</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </STable>
            )}
          </div>

          {/* ② 전체 VM 트리 + 선택 바 */}
          <div className="card" style={{ padding: 0, minWidth: 0, overflow: 'hidden' }}>
            <div style={{ ...ROW, padding: '10px 14px', borderBottom: '1px solid var(--border-soft)' }}>
              <b>{tree.vcName} 전체 VM {vms.length}대</b>
              <div className="flex wrap" role="group" aria-label="VM 필터" style={{ gap: 4 }}>
                {GROUP_FILTERS.map(([k, l]) => (
                  <button key={k} type="button" className={`tab${filter === k ? ' active' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)} style={{ padding: '4px 10px', fontSize: 12 }}>{l} {counts[k]}</button>
                ))}
              </div>
              <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="VM · 폴더 검색" aria-label="VM 검색" style={{ flex: '1 1 160px', minWidth: 0, maxWidth: 260 }} />
            </div>
            <div style={{ ...ROW, padding: '8px 14px', background: sel.size ? 'rgba(59,130,246,.10)' : 'var(--panel-deep)', borderBottom: '1px solid var(--border-soft)' }}>
              <b style={{ fontSize: 13 }}>{sel.size}대 선택</b>
              <button type="button" className="login-btn" style={{ flex: 'none', padding: '6px 14px' }} disabled={!writable || !sel.size} onClick={() => setEditor({ group: null, vmIds: [...sel] })}>새 그룹 만들기</button>
              {groups.length > 0 && (
                <Select className="input" sort={false} value="" disabled={!writable || !sel.size} aria-label="기존 그룹에 추가" style={{ minWidth: 0, width: 200, padding: '5px 8px', fontSize: 12 }}
                  onChange={(e) => { const g = groups.find((x) => x.id === e.target.value); if (g) setEditor({ group: g, vmIds: [...new Set([...g.vmIds, ...sel])] }); }}>
                  <option value="">기존 그룹에 추가 …</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}({g.vmIds.length}대)</option>)}
                </Select>
              )}
              {sel.size > 0 && <button type="button" className="logout-btn" style={BTN} onClick={() => setSel(new Set())}>선택 해제</button>}
              {!writable && <span className="muted" style={{ fontSize: 12 }}>저장할 수 없는 상태입니다(위 안내 참고).</span>}
            </div>
            {/* 트리는 자기 스크롤(세로 65vh) — VM 수백 대를 내려도 위의 선택 바(새 그룹 만들기)가 보인다 · 열 제목은 그 안에 고정 */}
            <div style={{ overflow: 'auto', maxHeight: '65vh' }}>
              <div role="treegrid" aria-label="폴더 › VM — 그룹에 넣을 VM 고르기" style={{ minWidth: 880, fontSize: 13 }}>
                <div role="row" style={{ display: 'grid', gridTemplateColumns: GRID, background: 'var(--panel-deep)', color: 'var(--text-dim)', fontSize: 12, fontWeight: 600, position: 'sticky', top: 0, zIndex: 1 }}>
                  <div role="columnheader" style={{ padding: '9px 0 9px 12px' }} aria-label="선택" />
                  <div role="columnheader" style={{ padding: '9px 6px' }}>vCenter › 폴더 › VM</div>
                  <div role="columnheader" style={{ padding: '9px 6px' }}>전원</div>
                  <div role="columnheader" style={{ padding: '9px 10px 9px 6px', textAlign: 'right' }}>용량</div>
                  <div role="columnheader" style={{ padding: '9px 6px' }}>백업 방식</div>
                  <div role="columnheader" style={{ padding: '9px 6px' }}>Bareos 잡</div>
                  <div role="columnheader" style={{ padding: '9px 14px 9px 6px' }}>그룹</div>
                </div>
                {flat.length === 0 && <div className="muted" style={{ padding: 14 }}>{vms.length ? '조건에 맞는 VM 이 없습니다.' : '이 법인의 인벤토리에 VM 이 없습니다.'}</div>}
                {flat.map((row) => {
                  const pad = 6 + row.depth * 20;
                  if (row.kind === 'folder') {
                    const ids = row.node.pickIds || [];
                    const st = checkState(ids, sel);
                    return (
                      <div role="row" key={row.key} aria-expanded={row.open} style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', borderTop: '1px solid var(--border-soft)', background: row.depth === 0 ? 'rgba(251,146,60,.06)' : undefined }}>
                        <div role="gridcell" style={{ paddingLeft: 12 }}><TriCheck state={st} disabled={!writable || !ids.length} label={`${row.node.name} 폴더의 VM ${ids.length}대 모두 고르기`} onChange={() => toggleSel(ids, st !== 'all')} /></div>
                        <div role="gridcell" style={{ minWidth: 0, paddingLeft: pad }}>
                          <button type="button" onClick={() => toggleOpen(row.node.key)} disabled={forceOpen} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 36, padding: '0 8px 0 0', background: 'none', border: 0, color: 'var(--text)', font: 'inherit', cursor: forceOpen ? 'default' : 'pointer', textAlign: 'left' }}>
                            <span className="muted" style={{ width: 12 }}>{row.open ? '▾' : '▸'}</span>
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                            <b title={row.node.name} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.node.name}</b>
                            <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{row.node.agg.n} VM</span>
                          </button>
                        </div>
                        <div role="gridcell" />
                        <div role="gridcell" style={{ padding: '0 10px 0 6px', textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}><b>{fmtGb(row.node.agg.gb)}</b></div>
                        <div role="gridcell" />
                        <div role="gridcell" style={{ padding: '0 6px', fontSize: 12, color: 'var(--text-dim)' }}>{row.node.agg.job ? `잡 ${row.node.agg.job}대` : ''}</div>
                        <div role="gridcell" style={{ padding: '0 14px 0 6px', fontSize: 12, color: 'var(--text-dim)' }}>{ids.length ? `고를 수 있음 ${ids.length}` : ''}</div>
                      </div>
                    );
                  }
                  const r = row.row;
                  const pk = pickable(r, { groupName });
                  const on = sel.has(r.id);
                  return (
                    <div role="row" key={row.key} aria-selected={on} style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', borderTop: '1px solid var(--border-soft)', background: on ? 'rgba(59,130,246,.12)' : undefined }}>
                      <div role="gridcell" style={{ paddingLeft: 12 }}><input type="checkbox" aria-label={`${r.name} 고르기`} checked={on} disabled={!writable || !pk.ok} title={pk.ok ? undefined : pk.why} onChange={() => toggleSel([r.id], !on)} /></div>
                      <div role="gridcell" style={{ minWidth: 0, paddingLeft: pad + 20, display: 'flex', alignItems: 'center', gap: 6, minHeight: 34 }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ color: 'var(--text-dim)', flex: 'none' }}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8" /></svg>
                        <span title={r.name} style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: r.gone ? 'var(--text-dim)' : undefined }}>{r.name}</span>
                        {r.gone && <span className="muted" style={{ fontSize: 11 }}>인벤토리에 없음</span>}
                      </div>
                      <div role="gridcell" style={{ padding: '0 6px', fontSize: 12, color: r.power === 'POWERED_ON' ? '#86efac' : 'var(--text-dim)' }}>{r.power === 'POWERED_ON' ? '켜짐' : r.power ? '꺼짐' : '—'}</div>
                      <div role="gridcell" style={{ padding: '0 10px 0 6px', textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmtGb(r.gb)}</div>
                      <div role="gridcell" style={{ padding: '0 6px' }}>{r.method == null ? <span className="muted" style={{ fontSize: 12 }}>모름</span> : <MethodBadge method={r.method || ''} small />}</div>
                      <div role="gridcell" style={{ padding: '0 6px', fontSize: 12, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={r.job ? undefined : (r.eligible ? undefined : r.reason)}>
                        {r.job
                          ? <span style={{ color: r.job.schedule ? TONE.warn : 'var(--text)' }}>잡 있음{r.job.enabled ? '' : '(꺼짐)'} · {r.job.schedule ? `Director 스케줄 ${r.job.schedule}` : '스케줄 없음'}</span>
                          : r.eligible ? <span className="muted">잡 없음 — 그룹 저장 때 등록</span> : <span style={{ color: TONE.bad }}>등록 불가 — {r.reason}</span>}
                      </div>
                      <div role="gridcell" style={{ padding: '0 14px 0 6px', fontSize: 12, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.groupId ? <span className="badge" style={{ fontSize: 11, background: 'rgba(251,146,60,.16)', color: '#fdba74' }}>{groupName(r.groupId) || '그룹'}</span> : <span className="muted">—</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="muted" style={{ padding: '8px 14px', fontSize: 12, borderTop: '1px solid var(--border-soft)' }}>
              시스템 VM(템플릿 · vCLS)은 백업할 수 없어 빼고 보입니다 · 다른 그룹의 VM 과 등록할 수 없는 VM 은 고를 수 없습니다(체크박스에 마우스를 올리면 사유) · 잡 없는 VM 은 그룹을 저장할 때 Director 스케줄 없이 등록됩니다.
            </div>
          </div>
        </>
      )}

      {editor && tree && (
        <GroupEditor tree={tree} group={editor.group} initialVmIds={editor.vmIds} byId={byId}
          onClose={() => setEditor(null)}
          onSaved={(text, ok = true) => { setEditor(null); setSel(new Set()); setMsg({ ok, text }); load(); }} />
      )}
      {runOf && <RunModal g={runOf} onClose={() => setRunOf(null)} onRun={(lv) => run(runOf, lv)} />}
      {fireOf && <FireModal g={groups.find((x) => x.id === fireOf.id) || fireOf} onClose={() => setFireOf(null)} />}
    </div>
  );
}

/** 저장 결과 → 한 줄 안내(BoldText — 값 인용은 ‘ ’). */
function savedText(r, isNew) {
  const g = r.group;
  const reg = (r.registered || []).filter((x) => x.ok).length;
  const parts = [`‘${g.name}’ 그룹을 ${isNew ? '만들었습니다' : '저장했습니다'} — VM ${g.vmIds.length}대 · ${g.scheduleText}`];
  if (reg) parts.push(`새로 등록한 백업 대상 ${reg}대(Director 스케줄 없음)`);
  if (r.excluded?.length) parts.push(`**등록하지 못해 뺀 VM ${r.excluded.length}대**`);
  if (r.doubleScheduled?.length) parts.push(`**Director 스케줄이 있는 잡 ${r.doubleScheduled.length}대 — 그룹 스케줄과 함께 두 번 돕니다**`);
  return parts.join(' · ');
}

function GroupEditor({ tree, group, initialVmIds, byId, onClose, onSaved }) {
  const [name, setName] = useState(group?.name || '');
  const [sched, setSched] = useState(() => (group ? { ...group.schedule } : { ...NEW_SCHEDULE }));
  const [storage, setStorage] = useState(group?.storage || '');
  const [pool, setPool] = useState(group?.pool || '');
  const [vmIds, setVmIds] = useState(() => initialVmIds.slice());
  const [opts, setOpts] = useState(null);
  const [optsErr, setOptsErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);   // 실패 응답(사유 · 등록 결과)
  useEffect(() => {
    let live = true;
    fetchJson(`${BASE}/groups/options`, { vcenterId: tree.vcenterId }, undefined, { timeoutMs: 360_000 })
      .then((r) => { if (live) setOpts(r); })
      .catch((e) => { if (live) setOptsErr(errText(e)); });
    return () => { live = false; };
  }, [tree.vcenterId]);
  const members = vmIds.map((id) => byId.get(id) || { id, name: id, folder: '', missing: true });
  const toRegister = members.filter((m) => !m.job && !m.missing).length;
  const doubled = sched.enabled ? members.filter((m) => m.job?.schedule) : [];
  const issues = draftIssues({ name, vmIds, schedule: sched }, { maxMembers: tree.limits?.maxMembers || 200 });
  // 새 VM 등록이 들어가면 Director 응답을 기다린다 — 서버가 기다리는 시간(인출 대기 + 등록 회신 시한, API 값)만큼(v2.830 검토 M3 — 숫자를 박지 않는다)
  const waitMs = toRegister > 0 ? relayWaitMs(tree.relayLimits, 'addJobs') : null;
  const save = async () => {
    setSaving(true); setResult(null);
    const body = { name, vmIds, schedule: sched, storage, pool, ...(group ? { updatedAt: group.updatedAt } : {}) };
    const opts = waitMs ? { timeoutMs: waitMs } : {};
    try {
      const r = group
        ? await putJson(`${BASE}/groups/${enc(group.id)}`, body, opts)
        : await postJson(`${BASE}/groups`, { ...body, vcenterId: tree.vcenterId }, opts);
      if (r?.ok) { onSaved(savedText(r, !group)); return; }
      setResult(r || { reason: '저장하지 못했습니다.' });
    } catch (e) {
      // 브라우저 시한·504 — 서버는 등록·저장을 끝냈을 수 있다(실패로 단정하지 않는다). 창을 닫고 목록을 새로 읽게 한다
      if (outcomeUnknown(e)) { onSaved(`결과 모름: ${unknownOutcomeText('그룹 저장', e)}`, false); return; }
      setResult({ reason: errText(e), ...(e?.body || {}) });
    } finally { setSaving(false); }
  };
  const dayBtn = (k, day, onState) => (
    <button key={`${k}${day}`} type="button" className={`tab${onState ? ' active' : ''}`} aria-pressed={onState}
      onClick={() => setSched((s) => toggleDay(s, day, k))} style={{ padding: '4px 10px', fontSize: 12, minWidth: 34 }}>{DAY_NAMES[day]}</button>
  );
  const nameOf = (id) => byId.get(id)?.name || id;
  return (
    <Modal title={group ? `백업 그룹 수정 — ${group.name}` : '새 백업 그룹'} onClose={saving ? () => {} : onClose} width={820}>
      <div style={{ display: 'grid', gap: 14 }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span className="muted" style={{ fontSize: 12 }}>그룹 이름</span>
          <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="예: 그룹웨어 DB" aria-label="그룹 이름" />
        </label>

        <div className="card" style={{ padding: 12, display: 'grid', gap: 10, minWidth: 0 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={sched.enabled} onChange={(e) => setSched((s) => ({ ...s, enabled: e.target.checked }))} />
            <b>스케줄 사용</b><span className="muted" style={{ fontSize: 12 }}>끄면 수동 실행만 합니다</span>
          </label>
          <div style={{ ...ROW, opacity: sched.enabled ? 1 : 0.55 }}>
            <span className="muted" style={{ fontSize: 12, width: 64 }}>요일</span>
            <div className="flex wrap" role="group" aria-label="실행 요일" style={{ gap: 4 }}>{[1, 2, 3, 4, 5, 6, 0].map((day) => dayBtn('days', day, sched.days.includes(day)))}</div>
            <button type="button" className="logout-btn" style={BTN} onClick={() => setSched((s) => ({ ...s, days: [0, 1, 2, 3, 4, 5, 6] }))}>매일</button>
            <button type="button" className="logout-btn" style={BTN} onClick={() => setSched((s) => ({ ...s, days: [1, 2, 3, 4, 5], fullDays: (s.fullDays || []).filter((x) => x >= 1 && x <= 5) }))}>평일</button>
          </div>
          <div style={{ ...ROW, opacity: sched.enabled ? 1 : 0.55 }}>
            <span className="muted" style={{ fontSize: 12, width: 64 }}>시각</span>
            <input className="input" type="time" step={60} value={sched.time} onChange={(e) => setSched((s) => ({ ...s, time: e.target.value }))} aria-label="실행 시각" style={{ width: 130 }} />
            <span className="muted" style={{ fontSize: 12 }}>레벨</span>
            <Select className="input" sort={false} value={sched.level} onChange={(e) => setSched((s) => ({ ...s, level: e.target.value, fullDays: e.target.value === 'Full' ? [] : s.fullDays }))} aria-label="기본 레벨" style={{ width: 160, minWidth: 0 }}>
              {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
            </Select>
          </div>
          {sched.level !== 'Full' && (
            <div style={{ ...ROW, opacity: sched.enabled ? 1 : 0.55 }}>
              <span className="muted" style={{ fontSize: 12, width: 64 }}>Full 요일</span>
              <div className="flex wrap" role="group" aria-label="Full 로 돌릴 요일" style={{ gap: 4 }}>{[1, 2, 3, 4, 5, 6, 0].filter((day) => sched.days.includes(day)).map((day) => dayBtn('fullDays', day, (sched.fullDays || []).includes(day)))}</div>
              <span className="muted" style={{ fontSize: 12 }}>고른 요일은 Full 로 돌립니다(실행 요일 안에서만)</span>
            </div>
          )}
          <div style={{ fontSize: 12.5 }}>미리 보기: <b>{scheduleText(sched)}</b> <span className="muted">· 시각은 포탈 서버 시각({tree.tz || '서버 현지'})</span></div>
        </div>

        <div className="card" style={{ padding: 12, display: 'grid', gap: 8, minWidth: 0 }}>
          <b style={{ fontSize: 13 }}>백업 스토리지</b>
          <div style={{ ...ROW }}>
            <label style={{ display: 'grid', gap: 4, flex: '1 1 200px', minWidth: 0 }}>
              <span className="muted" style={{ fontSize: 12 }}>스토리지(SD) — 비우면 잡 기본값{tree.siteDefaults?.storage ? `(${tree.siteDefaults.storage})` : ''}</span>
              <input className="input" list="bareos-group-storages" value={storage} onChange={(e) => setStorage(e.target.value.trim())} placeholder={tree.siteDefaults?.storage || '잡 기본값'} aria-label="스토리지" />
            </label>
            <label style={{ display: 'grid', gap: 4, flex: '1 1 200px', minWidth: 0 }}>
              <span className="muted" style={{ fontSize: 12 }}>풀 — 비우면 잡 기본값{tree.siteDefaults?.pool ? `(${tree.siteDefaults.pool})` : ''}</span>
              <input className="input" list="bareos-group-pools" value={pool} onChange={(e) => setPool(e.target.value.trim())} placeholder={tree.siteDefaults?.pool || '잡 기본값'} aria-label="풀" />
            </label>
          </div>
          <DataList id="bareos-group-storages">{(opts?.storages || []).map((s) => <option key={s} value={s} />)}</DataList>
          <DataList id="bareos-group-pools">{(opts?.pools || []).map((s) => <option key={s} value={s} />)}</DataList>
          <span className="muted" style={{ fontSize: 12 }}>
            {/* v2.830 검토 L5(추정 — 실환경 미확인): Job·JobDefs 의 레벨별 풀(Full·Incremental Backup Pool)이 run 의 pool 지정보다 먼저일 수 있다 */}
            {optsErr ? `Director 목록을 읽지 못했습니다(${optsErr}) — 이름을 직접 적을 수 있습니다.`
              : !opts ? 'Director 의 스토리지·풀 목록을 읽는 중…'
                : `Director 목록: 스토리지 ${opts.storages?.length ?? '—'}개 · 풀 ${opts.pools?.length ?? '—'}개 · 실행할 때마다 이 값으로 지정합니다(잡 정의는 바뀌지 않습니다).`}
          </span>
          <span className="muted" style={{ fontSize: 11.5 }}>풀 참고: 잡 정의(JobDefs)에 레벨별 풀(Full·Incremental Backup Pool)이 있으면 Bareos 가 그 풀을 먼저 쓸 수 있습니다(실환경 확인 전 — 첫 실행 뒤 실행 현황에서 풀을 확인하세요).</span>
        </div>

        <div className="card" style={{ padding: 12, display: 'grid', gap: 8, minWidth: 0 }}>
          <div style={{ ...ROW }}>
            <b style={{ fontSize: 13 }}>그룹 VM {vmIds.length}대</b>
            {toRegister > 0 && <span className="muted" style={{ fontSize: 12 }}>저장하면 {toRegister}대를 백업 대상으로 등록합니다(Director 스케줄 없이 — 그룹이 실행)</span>}
          </div>
          <div style={{ maxHeight: 220, overflow: 'auto', display: 'grid', gap: 2 }}>
            {members.map((m) => (
              <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '2px 0', minWidth: 0 }}>
                <span style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.name}>{m.name}</span>
                <span className="muted" style={{ fontSize: 11.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto' }} title={m.folder}>{m.folder}</span>
                <span style={{ fontSize: 11.5, whiteSpace: 'nowrap', color: m.missing ? TONE.bad : m.job?.schedule && sched.enabled ? TONE.warn : 'var(--text-dim)' }}>
                  {m.missing ? '목록에 없음' : m.job ? (m.job.schedule ? `Director 스케줄 ${m.job.schedule}` : '잡 있음') : '등록 예정'}
                </span>
                <button type="button" className="logout-btn" style={{ ...BTN, padding: '1px 8px' }} aria-label={`${m.name} 빼기`} onClick={() => setVmIds((v) => v.filter((x) => x !== m.id))}>빼기</button>
              </div>
            ))}
          </div>
          {doubled.length > 0 && (
            <div className="banner warn" style={{ fontSize: 12.5 }}>
              Director 스케줄이 있는 잡 {doubled.length}대({doubled.slice(0, 3).map((m) => m.name).join(', ')}{doubled.length > 3 ? ' …' : ''}) — 그룹 스케줄과 함께면 두 번 백업됩니다.
              Bareos 에는 잡의 스케줄을 바꾸는 콘솔 명령이 없어 포탈이 대신 고치지 않습니다. 이 VM 들을 빼거나, 그룹 스케줄을 끄고 수동 실행만 쓰거나, 백업 대상 탭에서 지운 뒤 그룹으로 다시 등록하세요.
            </div>
          )}
        </div>

        {result && (
          <div className="banner bad" style={{ fontSize: 12.5 }}>
            <div>{result.reason || '저장하지 못했습니다.'}</div>
            {(result.excluded || []).length > 0 && <div style={{ marginTop: 4 }}>등록하지 못한 VM: {result.excluded.slice(0, 10).map((x) => `${nameOf(x.vmId)}(${x.reason})`).join(' · ')}{result.excluded.length > 10 ? ` 외 ${result.excluded.length - 10}대` : ''}</div>}
          </div>
        )}
        {issues.length > 0 && <div className="muted" style={{ fontSize: 12 }}>{issues.join(' · ')}</div>}
        <div style={{ ...ROW, justifyContent: 'flex-end' }}>
          {saving && <span className="muted" style={{ fontSize: 12 }}>저장 중 — 새 VM 등록은 Director 응답을 기다립니다(엣지 대행 법인은 몇 분 걸릴 수 있습니다)</span>}
          <button type="button" className="logout-btn" disabled={saving} onClick={onClose}>취소</button>
          <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={saving || issues.length > 0} onClick={save}>{saving ? '저장 중…' : group ? '저장' : '그룹 만들기'}</button>
        </div>
      </div>
    </Modal>
  );
}

function RunModal({ g, onClose, onRun }) {
  const [level, setLevel] = useState('');
  return (
    <Modal title={`지금 실행 — ${g.name}`} onClose={onClose} width={460}>
      <div style={{ display: 'grid', gap: 12 }}>
        <div style={{ fontSize: 13 }}>그룹 VM {g.vmIds.length}대의 백업을 지금 보냅니다. 이미 실행 중인 VM 과 꺼진 대상은 건너뜁니다.</div>
        <label style={{ display: 'grid', gap: 4 }}>
          <span className="muted" style={{ fontSize: 12 }}>레벨</span>
          <Select className="input" sort={false} value={level} onChange={(e) => setLevel(e.target.value)} aria-label="실행 레벨">
            <option value="">그룹 기본({g.schedule?.level || 'Incremental'})</option>
            {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
          </Select>
        </label>
        <div style={{ ...ROW, justifyContent: 'flex-end' }}>
          <button type="button" className="logout-btn" onClick={onClose}>취소</button>
          <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} onClick={() => onRun(level)}>실행</button>
        </div>
      </div>
    </Modal>
  );
}

function FireModal({ g, onClose }) {
  const f = g.lastFire;
  return (
    <Modal title={`마지막 실행 — ${g.name}`} onClose={onClose} width={820}>
      {!f ? <div className="muted">실행 기록이 없습니다.</div> : (
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ fontSize: 13 }}>{fireText(f)} · 레벨 {f.level || '—'}{f.storage ? ` · 스토리지 ${f.storage}` : ''}{f.pool ? ` · 풀 ${f.pool}` : ''}{f.key ? ` · 회차 ${f.key}` : ''}{f.by ? ` · ${f.by}` : ''}</div>
          {f.error && <div className="banner bad" style={{ fontSize: 12.5 }}>{f.error}</div>}
          {(f.items || []).length > 0 && (
            <STable minWidth={600} limit={200}>
              <thead><tr><th>VM</th><th>결과</th><th className="right">jobid</th><th>사유</th></tr></thead>
              <tbody>
                {f.items.map((it) => (
                  <tr key={it.vmId}>
                    <td><b>{it.vmName}</b></td>
                    <td style={{ color: TONE[FIRE_STATE_TONE[it.state]] || TONE.muted, whiteSpace: 'nowrap' }}>{FIRE_STATE_TEXT[it.state] || it.state}</td>
                    <td className="right" style={{ fontFamily: 'var(--mono)' }} data-sort={it.jobid ?? ''}>{it.jobid ?? '—'}</td>
                    <td style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>{it.reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          )}
          <div className="muted" style={{ fontSize: 12 }}>시작한 실행의 결과(성공·실패)는 Director 상태 조회가 반영합니다 — 백업 대상 탭 · 실행 현황 탭에서 봅니다.</div>
        </div>
      )}
    </Modal>
  );
}
