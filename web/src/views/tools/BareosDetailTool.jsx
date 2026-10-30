/**
 * Bareos 법인별 현황 — 특수 기능 `bareos-detail`(v2.828, 사용자 요청 'bareos 카테고리에 포함된 vm 들은 별도의 VM 폴더를 볼 수 있는 화면 · vcenter 처럼
 *   법인마다 따로' + 시안 ②④ · 권장안 A 조회 전용 키).
 *   법인(vCenter) 하나에서 **백업 방식이 Bareos 인 VM ∪ Bareos 잡이 있는 VM** 만 폴더 › VM 으로 본다(다른 방식 VM 은 Backup › Detail).
 *   값은 서버 GET /api/tools/bareos-detail(routes/api/bareosViews.js — Director 에 접속하지 않는다). 판정·문구는 bareosViewText.js.
 *   지금 백업·복원·등록은 관리 화면(bareos-backup — 관리자 · OTP)으로 보낸다(이 화면에는 쓰기가 없다).
 * ⚠ 훅은 조기 return 위 · 늦게 온 이전 법인의 응답은 버린다 · 못 읽은 값은 '—' · 결과를 모르는 법인은 결과 기준 필터 수가 '—'.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, usePolling, downloadFile, canCsv, hasRole, toolAllowed } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import Select from '../../components/Select.jsx';
import { STable } from '../../components/STable.jsx';
import VeeamHeader from './VeeamHeader.jsx';
import BareosTabs from './BareosTabs.jsx';
import { CritIcon, MethodBadge } from './BackupMarkIcons.jsx';
import {
  bareosClass, directorStateOf, directorLineText, resultsUnknownText, numText, shortTs, fmtGb, stText, ST_TONE, runLine, bytesText,
  DETAIL_FILTERS, detailFilterCounts, lvText, buildBareosTree, flattenBareosTree, initialBareosOpen, BAREOS_RPO_DAYS, BAREOS_DETAIL_VC_KEY,
} from './bareosViewText.js';

const TONE = { ok: '#86efac', warn: '#fcd34d', bad: '#fca5a5', run: '#93c5fd', muted: 'var(--text-dim)', bareos: '#fdba74' };
const CHIP = {
  ok: { color: '#86efac', background: 'rgba(34,197,94,.14)' }, warn: { color: '#fcd34d', background: 'rgba(245,158,11,.16)' },
  bad: { color: '#fca5a5', background: 'rgba(239,68,68,.14)' }, run: { color: '#93c5fd', background: 'rgba(59,130,246,.16)' },
  none: { color: '#fdba74', background: 'transparent', border: '1px dashed rgba(251,146,60,.55)' }, muted: { color: 'var(--text-dim)', background: 'transparent', border: '1px solid var(--border)' },
};
const GRID = 'minmax(220px, 2.2fr) 52px 80px minmax(220px, 1.8fr) 110px minmax(130px, 1fr)';
const RPO_KEY = 'bareos-summary-rpo';   // 통합 현황과 같은 기준(이 브라우저에만)
const loadRpo = () => { try { const v = Number(localStorage.getItem(RPO_KEY)); return BAREOS_RPO_DAYS.includes(v) ? v : 1; } catch { return 1; } };

function Chip({ tone, children }) {
  return <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', ...(CHIP[tone] || CHIP.muted) }}>{children}</span>;
}
function Kpi({ label, value, sub, color, border }) {
  return (
    <div className="card" style={{ padding: '10px 12px', minWidth: 0, border: `1px solid ${border || 'var(--border)'}` }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: color || 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, marginTop: 2, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 11.5, marginTop: 2, overflowWrap: 'anywhere' }}>{sub}</div>}
    </div>
  );
}
/** 마지막 실행 칸 — 결과 칩 + 끝난 시각 + 레벨·바이트. 미등록·모름·아직 실행 안 함은 글로. */
function RunCell({ b, known }) {
  if (b === null) return <Chip tone="muted">모름</Chip>;
  if (!b) return <span className="muted">—</span>;
  if (!b.job) return <Chip tone="none">미등록 — 잡 없음</Chip>;
  const extra = runLine(b);
  return (
    <span className="flex" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
      {b.st ? <Chip tone={known ? ST_TONE[b.st] : 'muted'}>{stText(b.st)}</Chip> : <Chip tone="muted">아직 실행 안 함</Chip>}
      {b.at != null && <span style={{ fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{shortTs(b.at)}</span>}
      {extra && <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{extra}</span>}
      {b.run && <Chip tone="run">진행 중</Chip>}
    </span>
  );
}
function stateText(r) {
  const k = bareosClass(r.b);
  if (r.b === null) return '모름';
  if (k.gone) return '인벤토리에 없음';
  if (k.missing) return '미등록';
  if (k.off) return '잡 꺼짐';
  if (k.job && !k.gone && r.method != null && r.method !== 'bareos') return '방식 불일치';
  return k.job ? '잡 켜짐' : '—';
}

export default function BareosDetailTool() {
  const [vcs, setVcs] = useState(null);
  const [vcErr, setVcErr] = useState(null);
  const [vcId, setVcId] = useState(() => { try { return localStorage.getItem(BAREOS_DETAIL_VC_KEY) || ''; } catch { return ''; } });
  const [tick, setTick] = useState(0);
  const [rpoDays] = useState(loadRpo);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [sel, setSel] = useState(null);
  const [csvErr, setCsvErr] = useState(null);
  useEffect(() => { fetchJson('/vcenters').then((r) => setVcs(Array.isArray(r) ? r : [])).catch(setVcErr); }, []);
  // 저장해 둔 법인이 목록에 없으면(범위가 바뀜·지워짐) 첫 법인
  useEffect(() => {
    if (!vcs || !vcs.length) return;
    if (!vcs.some((v) => v.id === vcId)) setVcId(vcs[0].id);
  }, [vcs, vcId]);
  // 공용 usePolling(60초 · 403 이면 멈춤 · 늦은 응답 버림 — WEB2613-09). 법인을 바꾸면 이전 법인의 값은 버리고(다른 법인의 VM 이 새 법인처럼 보이지 않게),
  //   같은 법인의 새로고침(_r)은 새 값이 올 때까지 직전 값을 들고 있는다.
  const { data: polled, error, loading } = usePolling(vcId ? '/tools/bareos-detail' : null, { vcenterId: vcId, rpoDays, _r: tick }, 60_000);
  const lastRef = useRef(null);
  if (polled) lastRef.current = polled;
  const data = polled || (lastRef.current?.vcenter?.id === vcId ? lastRef.current : null);
  const load = () => setTick((t) => t + 1);
  useEffect(() => { setSel(null); setOpen(null); }, [vcId]);
  const pickVc = (id) => { setVcId(id); try { localStorage.setItem(BAREOS_DETAIL_VC_KEY, id); } catch { /* 이 브라우저에만 */ } };
  const known = data?.director?.resultsKnown !== false;
  const fopts = useMemo(() => ({ rpoDays, now: data?.at || Date.now(), resultsKnown: known, marksKnown: !data?.marksUnreadable, registryKnown: !data?.registryUnreadable }), [rpoDays, data, known]);
  const rows = useMemo(() => (Array.isArray(data?.rows) ? data.rows : []), [data]);
  const counts = useMemo(() => detailFilterCounts(rows, fopts), [rows, fopts]);
  const tree = useMemo(() => buildBareosTree(rows, { filter, q, ...fopts }), [rows, filter, q, fopts]);
  const openSet = useMemo(() => open || initialBareosOpen(tree), [open, tree]);
  const forceOpen = filter !== 'all' || !!q.trim();
  const flat = useMemo(() => flattenBareosTree(tree, openSet, forceOpen), [tree, openSet, forceOpen]);
  const selRow = sel ? rows.find((r) => r.id === sel) || null : null;
  const toggle = (key) => setOpen((cur) => { const s = new Set(cur || openSet); if (s.has(key)) s.delete(key); else s.add(key); return s; });
  const csv = async () => {
    setCsvErr(null);
    try { await downloadFile(`/tools/bareos-detail.csv?${new URLSearchParams({ vcenterId: vcId, rpoDays: String(rpoDays) })}`); } catch (e) { setCsvErr(e); }
  };
  const manage = hasRole('admin') && toolAllowed('bareos-backup');

  const corps = data?.corps || (vcs || []).map((v) => ({ id: v.id, name: v.name || v.id, state: '' }));
  const head = (
    <>
      <VeeamHeader active="bareos" desc="법인 하나에서 백업 방식이 Bareos 인 VM 과 Bareos 잡이 있는 VM 만 폴더 › VM 으로 봅니다(다른 방식 VM 은 Detail 탭)."
        actions={<>
          {data && <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>기준 {shortTs(data.at)}{error ? ' · 최근 새로고침 실패 — 이전 값' : ''}</span>}
          <Select className="input" value={vcId} onChange={(e) => pickVc(e.target.value)} aria-label="법인(vCenter)" style={{ fontSize: 12, padding: '4px 8px', minWidth: 140, width: 'auto', maxWidth: '100%' }}>
            {(vcs || []).map((v) => <option key={v.id} value={v.id}>{v.name || v.id}</option>)}
          </Select>
          {canCsv() && <button type="button" className="tab" disabled={!data} onClick={csv} style={{ padding: '6px 14px' }}>CSV</button>}
          <button type="button" className="tab" disabled={loading || !vcId} onClick={load} style={{ padding: '6px 14px' }}>{loading ? '읽는 중…' : '새로고침'}</button>
        </>} />
      <BareosTabs active="detail" />
    </>
  );
  const WRAP = { display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 };
  if (vcErr) return <div style={WRAP}>{head}<ErrorBox error={vcErr} /></div>;
  if (vcs && !vcs.length) return <div style={WRAP}>{head}<div className="muted">볼 수 있는 vCenter 가 없습니다.</div></div>;
  if (!data && error) return <div style={WRAP}>{head}<ErrorBox error={error} /></div>;
  if (!data) return <div style={WRAP}>{head}<Loading /></div>;

  const c = data.counts || {};
  const dir = data.director || {};
  const unknownNote = resultsUnknownText(dir);
  return (
    <div data-bareos-detail="" style={WRAP}>
      {head}
      {corps.length > 1 && (
        <div className="vc-quicknav" data-bareos-corps="" style={{ marginBottom: 0 }}>
          <span className="qn-label">법인</span>
          {corps.map((v) => (
            <button key={v.id} type="button" className="qn-btn" aria-pressed={v.id === vcId} onClick={() => pickVc(v.id)}
              title={v.state ? `Director ${directorStateOf(v.state).text}` : undefined} style={v.id === vcId ? { borderColor: 'var(--accent)', background: 'rgba(59,130,246,.18)', color: '#fff' } : undefined}>
              {v.state && <span className="qn-dot" style={{ background: directorStateOf(v.state).color }} />}{v.name}
            </button>
          ))}
        </div>
      )}
      {data.demo && <div className="banner warn">데모 Director 입니다 — 실제 Bareos 에 접속하지 않은 합성 결과입니다(백업 방식 표시는 실제 파일).</div>}
      {data.marksUnreadable && <div className="banner bad">백업 표시 파일(backup-marks.json)을 읽지 못해 백업 방식을 모릅니다 — 잡이 있는 VM 만 보이고 미등록·방식 불일치는 셀 수 없습니다(—).</div>}
      {data.registryUnreadable && <div className="banner bad">Bareos 백업 대상 원장을 읽지 못해 잡·결과를 모릅니다(—) — 손상본은 설정 폴더에 보존돼 있습니다.</div>}
      {unknownNote && <div className="banner warn">{unknownNote}</div>}
      {csvErr && <div className="banner bad">CSV 내보내기 실패 — {csvErr?.status === 403 ? 'CSV 권한이 없습니다.' : String(csvErr.message || csvErr)}</div>}

      <div className="card" style={{ padding: '12px 16px', display: 'flex', flexWrap: 'wrap', gap: '8px 24px', alignItems: 'flex-start', minWidth: 0 }}>
        <div style={{ flex: '1 1 300px', minWidth: 0 }}>
          <div className="flex" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <b style={{ fontSize: 19 }}>{data.vcenter?.name}</b>
            <span className="flex" style={{ gap: 6, alignItems: 'center', fontSize: 12 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: directorStateOf(dir.state).color }} aria-hidden="true" />{directorStateOf(dir.state).text}</span>
          </div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 2, overflowWrap: 'anywhere' }}>{directorLineText(dir)}</div>
          {(dir.schedule || dir.pool) && <div className="muted" style={{ fontSize: 12, marginTop: 2, overflowWrap: 'anywhere' }}>{[dir.schedule && `기본 스케줄 ${dir.schedule}`, dir.pool && `풀 ${dir.pool}`].filter(Boolean).join(' · ')}</div>}
        </div>
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '4px 12px', fontSize: 12.5, flex: '1 1 300px', minWidth: 0 }}>
          <dt className="muted">이 법인 VM</dt><dd style={{ margin: 0 }}>{numText(data.vm)} <span className="muted">(템플릿·vCLS 제외)</span></dd>
          <dt className="muted">백업 방식 Bareos</dt><dd style={{ margin: 0 }}><b style={{ color: TONE.bareos }}>{numText(c.bareosMethod)}</b> <span className="muted">· 잡 등록 {numText(c.jobs)} · 미등록 {numText(c.missing)}</span></dd>
          <dt className="muted">방식 불일치</dt><dd style={{ margin: 0 }}>{numText(c.mismatch)} <span className="muted">(잡은 있는데 방식이 Bareos 가 아닌 VM)</span></dd>
          <dt className="muted">마지막 결과</dt><dd style={{ margin: 0 }}>{c.ok == null ? <span className="muted">모름(잡 {numText(c.unknown)})</span> : <><span style={{ color: TONE.ok }}>성공 {c.ok}</span> · <span style={{ color: TONE.warn }}>경고 {c.warn}</span> · <span style={{ color: TONE.bad }}>실패 {c.fail}</span> · <span style={{ color: TONE.run }}>진행 {c.run}</span></>}</dd>
        </dl>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        <Kpi label="Bareos 방식 VM" value={numText(c.bareosMethod)} color={TONE.bareos} border="#6b3d17" sub={data.vm ? `전체 ${numText(data.vm)} 중` : undefined} />
        <Kpi label="잡 등록" value={numText(c.jobs)} sub={`켜짐 ${numText(c.on)} · 꺼짐 ${numText(c.off)}`} />
        <Kpi label="미등록" value={numText(c.missing)} color={TONE.warn} border="#5c4513" sub="방식은 Bareos · 잡 없음" />
        <Kpi label="마지막 결과" value={c.ok == null ? '—' : `${c.ok} · ${c.warn} · ${c.fail}`} sub="성공 · 경고 · 실패" />
        <Kpi label="지금 백업 중" value={numText(c.run)} color={TONE.run} border="#1e3a5f" />
        <Kpi label={`오래된 백업(${data.rpoDays}일 초과)`} value={numText(c.old)} color="#fb923c" border="#5c3413" sub={`백업 없음 ${numText(c.never)}`} />
        <Kpi label="용량" value={c.rows ? fmtGb(c.gb) : '—'} sub={c.gbUnknown ? `용량 모름 ${c.gbUnknown}대 제외` : 'Bareos 관련 VM 디스크 사용 합'} />
      </div>

      <div className="flex gap wrap" style={{ alignItems: 'center', rowGap: 8 }}>
        <div className="flex gap wrap" role="group" aria-label="보기" style={{ rowGap: 6 }}>
          {DETAIL_FILTERS.map(([k, label]) => (
            <button key={k} type="button" className={`tab${filter === k ? ' active' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)} style={{ padding: '5px 12px', fontSize: 12 }}>
              {label}{k === 'old' ? `(${data.rpoDays}일)` : ''} {k === 'all' ? rows.length : numText(counts[k])}
            </button>
          ))}
        </div>
        <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: '0 1 280px' }}>
          <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>검색</span>
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="VM · 폴더 이름" style={{ flex: 1, minWidth: 0 }} />
        </label>
      </div>

      <div className="flex wrap" style={{ gap: 14, alignItems: 'flex-start' }}>
        <div className="card" style={{ flex: '999 1 640px', minWidth: 0, padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <div role="treegrid" aria-label="폴더 › VM Bareos 백업" style={{ minWidth: 820, fontSize: 13 }}>
              <div role="row" style={{ display: 'grid', gridTemplateColumns: GRID, background: 'var(--panel-deep)', color: 'var(--text-dim)', fontSize: 12, fontWeight: 600 }}>
                <div role="columnheader" style={{ padding: '9px 14px' }}>vCenter › 폴더 › VM</div>
                <div role="columnheader" style={{ padding: '9px 6px' }}>전원</div>
                <div role="columnheader" style={{ padding: '9px 10px 9px 6px', textAlign: 'right' }}>용량</div>
                <div role="columnheader" style={{ padding: '9px 6px' }}>마지막 실행 (결과 · 레벨 · 바이트)</div>
                <div role="columnheader" style={{ padding: '9px 6px' }}>마지막 백업</div>
                <div role="columnheader" style={{ padding: '9px 14px 9px 6px' }}>잡 · 상태</div>
              </div>
              {flat.length === 0 && <div className="muted" style={{ padding: 14 }}>{rows.length ? '조건에 맞는 VM 이 없습니다.' : '이 법인에는 백업 방식이 Bareos 인 VM 도, Bareos 잡도 없습니다 — Detail 탭에서 백업 방식을 Bareos 로 정하거나 백업 대상 탭에서 등록하세요.'}</div>}
              {flat.map((row) => {
                const pad = 14 + row.depth * 20;
                if (row.kind === 'folder') {
                  const a = row.node.agg;
                  const tot = a.job || 0;
                  const den = Math.max(tot, a.ok + a.warn + a.fail + a.run);   // 버그 점검 W3 — 성공 + 지금 진행이 겹쳐도 100% 를 넘지 않게
                  const p = (n) => (den ? `${(n / den) * 100}%` : '0%');
                  return (
                    <div role="row" key={row.key} aria-expanded={row.open} style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', borderTop: '1px solid var(--border-soft)', background: row.depth === 0 ? 'rgba(251,146,60,.06)' : undefined }}>
                      <div role="gridcell" style={{ minWidth: 0, paddingLeft: pad }}>
                        <button type="button" onClick={() => toggle(row.node.key)} disabled={forceOpen} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 38, padding: '0 8px 0 0', background: 'none', border: 0, color: 'var(--text)', font: 'inherit', cursor: forceOpen ? 'default' : 'pointer', textAlign: 'left' }}>
                          <span className="muted" style={{ width: 12 }}>{row.open ? '▾' : '▸'}</span>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                          <b title={row.node.name} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.node.name}</b>
                          <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{a.n} VM</span>
                        </button>
                      </div>
                      <div role="gridcell" />
                      <div role="gridcell" style={{ padding: '0 10px 0 6px', textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}><b>{fmtGb(a.gb)}</b></div>
                      <div role="gridcell" style={{ padding: '4px 6px', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, fontSize: 12 }}>
                        <span style={{ color: TONE.bareos, fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{a.job}/{a.n}</span>
                        {known && tot > 0 ? (
                          <div role="img" aria-label={`성공 ${a.ok} · 경고 ${a.warn} · 실패 ${a.fail} · 진행 ${a.run}`} style={{ display: 'flex', flex: 1, minWidth: 50, maxWidth: 160, height: 6, borderRadius: 3, overflow: 'hidden', background: 'var(--panel-deep)' }}>
                            <div style={{ width: p(a.ok), background: '#22c55e' }} /><div style={{ width: p(a.warn), background: '#f59e0b' }} /><div style={{ width: p(a.fail), background: '#ef4444' }} /><div style={{ width: p(a.run), background: '#3b82f6' }} />
                          </div>
                        ) : null}
                        {a.fail ? <span style={{ color: TONE.bad, whiteSpace: 'nowrap' }}>실패 {a.fail}</span> : null}
                        {a.missing ? <span style={{ color: TONE.warn, whiteSpace: 'nowrap' }}>미등록 {a.missing}</span> : null}
                      </div>
                      <div role="gridcell" />
                      <div role="gridcell" />
                    </div>
                  );
                }
                const r = row.row; const isSel = sel === r.id; const k = bareosClass(r.b, fopts);
                return (
                  <div role="row" key={row.key} aria-selected={isSel} style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', borderTop: '1px solid var(--border-soft)', background: isSel ? 'rgba(59,130,246,.12)' : undefined }}>
                    <div role="gridcell" style={{ minWidth: 0, paddingLeft: pad + 20 }}>
                      <button type="button" onClick={() => setSel(isSel ? null : r.id)} style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', minHeight: 36, padding: '0 8px 0 0', background: 'none', border: 0, color: 'var(--text)', font: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ color: 'var(--text-dim)', flex: 'none' }}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8" /></svg>
                        <CritIcon crit={r.crit} size={14} />
                        <span style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: r.gone ? 'var(--text-dim)' : undefined }}>{r.name}</span>
                        <MethodBadge method={r.method || ''} small />
                      </button>
                    </div>
                    <div role="gridcell" style={{ padding: '0 6px', fontSize: 12, color: r.power === 'POWERED_ON' ? '#86efac' : 'var(--text-dim)' }}>{r.power === 'POWERED_ON' ? '켜짐' : r.power ? '꺼짐' : '—'}</div>
                    <div role="gridcell" style={{ padding: '0 10px 0 6px', textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmtGb(r.gb)}</div>
                    <div role="gridcell" style={{ padding: '4px 6px', minWidth: 0 }}><RunCell b={r.b} known={known} /></div>
                    <div role="gridcell" style={{ padding: '0 6px', fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap', color: known && k.old ? '#fb923c' : undefined }}>{r.b?.job ? shortTs(r.b.ok) : '—'}{known && k.old ? ` · ${data.rpoDays}일+` : ''}</div>
                    <div role="gridcell" style={{ padding: '0 14px 0 6px', fontSize: 12, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: k.missing || k.off || r.gone ? TONE.warn : 'var(--text-dim)' }}>{stateText(r)}</div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="muted" style={{ padding: '8px 14px', fontSize: 12, borderTop: '1px solid var(--border-soft)' }}>폴더 줄 = 그 아래 Bareos 관련 VM 중 잡이 있는 수 / 전체 · 막대 = 잡의 마지막 결과(성공 · 경고 · 실패 · 진행) · 마지막 백업 = 백업이 만들어진(성공·경고) 마지막 실행 · 인벤토리에 없는 잡은 등록 때 위치에 보입니다</div>
        </div>

        <div style={{ flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12, alignSelf: 'flex-start' }}>
          <div className="card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
            {!selRow ? <div className="muted" style={{ fontSize: 13 }}>VM 을 누르면 여기에 Bareos 백업 상세가 보입니다.</div> : (
              <>
                <div className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{selRow.folder || '—'}</div>
                <div className="flex" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 16, overflowWrap: 'anywhere' }}>{selRow.name}</b><MethodBadge method={selRow.method || ''} small />
                </div>
                <RunCell b={selRow.b} known={known} />
                <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '5px 12px', fontSize: 12.5 }}>
                  <dt className="muted">잡</dt><dd style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: 12, overflowWrap: 'anywhere' }}>{selRow.job?.name || (selRow.b?.job === false ? '없음(미등록)' : '—')}</dd>
                  <dt className="muted">상태</dt><dd style={{ margin: 0 }}>{stateText(selRow)}{selRow.b?.missing ? ' · Director 에 잡이 없음(누가 설정을 지웠을 수 있음)' : ''}</dd>
                  {selRow.job && <><dt className="muted">스케줄 · 레벨</dt><dd style={{ margin: 0 }}>{selRow.job.schedule || '—'} · {selRow.job.level || '—'}</dd></>}
                  <dt className="muted">마지막 백업</dt><dd style={{ margin: 0 }}>{selRow.b?.job ? shortTs(selRow.b.ok) : '—'}</dd>
                  {Number.isFinite(selRow.b?.by) && <><dt className="muted">마지막 실행 바이트</dt><dd style={{ margin: 0 }}>{bytesText(selRow.b.by)}</dd></>}
                  <dt className="muted">디스크 용량</dt><dd style={{ margin: 0 }}>{fmtGb(selRow.gb)}</dd>
                  {selRow.crit && <><dt className="muted">업무 중요도</dt><dd style={{ margin: 0 }}><CritIcon crit={selRow.crit} withText /></dd></>}
                  {selRow.job && <><dt className="muted">등록</dt><dd style={{ margin: 0 }}>{shortTs(selRow.job.at)}{selRow.job.by ? ` · ${selRow.job.by}` : ''}</dd></>}
                </dl>
                {Array.isArray(selRow.runs) && selRow.runs.length > 0 && (
                  <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 8 }}>
                    <b style={{ fontSize: 12.5 }}>최근 끝난 실행 {selRow.runs.length}건</b>
                    <STable style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 4 }}>
                      <thead>
                        <tr style={{ textAlign: 'left', color: 'var(--text-dim)' }}>
                          <th style={{ padding: '4px 4px 4px 0', fontWeight: 600 }}>끝난 시각</th>
                          <th style={{ padding: 4, fontWeight: 600 }}>레벨</th>
                          <th style={{ padding: '4px 0 4px 4px', fontWeight: 600, textAlign: 'right' }}>결과</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selRow.runs.map((x) => (
                          <tr key={x.jobid} style={{ borderTop: '1px solid var(--border-soft)' }}>
                            <td data-sort={x.at || ''} style={{ padding: '4px 4px 4px 0', fontFamily: 'var(--mono)', whiteSpace: 'nowrap' }}>{shortTs(x.at)}</td>
                            <td style={{ padding: 4 }}>{lvText(x.lv)}</td>
                            <td style={{ padding: '4px 0 4px 4px', textAlign: 'right' }}><Chip tone={ST_TONE[x.st] || 'muted'}>{stText(x.st)}</Chip></td>
                          </tr>
                        ))}
                      </tbody>
                    </STable>
                  </div>
                )}
                {manage && (
                  <div className="flex gap wrap" style={{ rowGap: 6 }}>
                    <a className="tab" href="#/tools/bareos-backup/targets" style={{ padding: '4px 12px', fontSize: 12, textDecoration: 'none' }}>백업 대상에서 실행·복원 →</a>
                  </div>
                )}
              </>
            )}
          </div>
          <div className="card" style={{ padding: '12px 14px', fontSize: 12, lineHeight: 1.7 }}>
            <b style={{ display: 'block', marginBottom: 2 }}>칸 읽는 법</b>
            <div><b style={{ color: TONE.ok }}>성공</b> · <b style={{ color: TONE.warn }}>경고</b> · <b style={{ color: TONE.bad }}>실패</b> 그 잡의 마지막으로 끝난 실행(폴러가 반영한 Director 카탈로그 값)</div>
            <div><b style={{ color: TONE.bareos }}>미등록</b> 백업 방식은 Bareos 로 정했는데 잡이 없음 — 등록 전까지 백업되지 않습니다</div>
            <div><b style={{ color: '#fb923c' }}>{data.rpoDays}일+</b> 마지막 백업이 기준(통합 현황의 ‘오래된 백업 기준’)보다 오래됨</div>
            <div><b>방식 불일치</b> 잡은 있는데 백업 방식이 Bareos 가 아님 — Detail 탭에서 방식을 맞추세요</div>
            <div className="muted">— 는 없음, ‘모름’ 은 그쪽을 읽지 못함(백업 안 됨이 아님)</div>
          </div>
        </div>
      </div>
    </div>
  );
}
