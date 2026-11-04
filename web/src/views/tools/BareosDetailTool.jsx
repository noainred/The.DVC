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
import { Note, ReadGuide, Stat, STAT_GRID, Dot, ResultBar, FilterChip } from './BareosBits.jsx';
import { snapshotChip, SNAPSHOT_TITLE } from './bareosRestoreText.js';
import { BareosHealthCard } from './BareosHealth.jsx';   // v2.886 사전 점검(관리자 — 403 이면 카드를 그리지 않는다)   // v2.861 남은 스냅샷 칩
import {
  bareosClass, directorStateOf, directorLineText, resultsUnknownText, numText, shortTs, fmtGb, stText, ST_TONE, runLine, bytesText,
  DETAIL_FILTERS, DETAIL_FILTERS_MAIN, DETAIL_FILTERS_MORE, detailFilterCounts, lvText, buildBareosTree, flattenBareosTree, initialBareosOpen, BAREOS_RPO_DAYS, BAREOS_DETAIL_VC_KEY,
  resultBar, corpAttention, saveTargetFocus,
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
  const [moreChips, setMoreChips] = useState(false);
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
      <VeeamHeader active="bareos" desc="Bareos — 법인 하나의 Bareos 방식 VM 과 Bareos 잡이 있는 VM 을 폴더 › VM 으로 봅니다(다른 방식 VM 은 Detail 탭)." />
      <BareosTabs active="detail" right={(
        <div className="flex gap wrap" style={{ marginLeft: 'auto', alignItems: 'center', rowGap: 6 }}>
          {data && <span className="muted" style={{ fontSize: 12 }}>기준 {shortTs(data.at)}{error ? ' · 최근 새로고침 실패 — 이전 값' : ''}</span>}
          {canCsv() && <button type="button" className="tab" disabled={!data} onClick={csv} style={{ padding: '6px 14px' }}>CSV</button>}
          <button type="button" className="tab" disabled={loading || !vcId} onClick={load} style={{ padding: '6px 14px' }}>{loading ? '읽는 중…' : '새로고침'}</button>
        </div>
      )} />
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
  const corpIdx = corps.findIndex((v) => v.id === vcId);
  const attn = corpAttention(c);
  return (
    <div data-bareos-detail="" style={WRAP}>
      {head}
      {data.demo && <Note>데모 Director 입니다 — 실제 Bareos 에 접속하지 않은 합성 결과입니다(백업 방식 표시는 실제 파일).</Note>}
      {data.marksUnreadable && <Note tone="bad">백업 표시 파일(backup-marks.json)을 읽지 못해 백업 방식을 모릅니다 — 잡이 있는 VM 만 보이고 미등록·방식 불일치는 셀 수 없습니다(—).</Note>}
      {data.registryUnreadable && <Note tone="bad">Bareos 백업 대상 원장을 읽지 못해 잡·결과를 모릅니다(—) — 손상본은 설정 폴더에 보존돼 있습니다.</Note>}
      {unknownNote && <Note>{unknownNote}</Note>}
      {csvErr && <Note tone="bad">CSV 내보내기 실패 — {csvErr?.status === 403 ? 'CSV 권한이 없습니다.' : String(csvErr.message || csvErr)}</Note>}

      <div className="card" data-bareos-corps="" style={{ padding: '12px 16px', display: 'flex', flexWrap: 'wrap', gap: '10px 18px', alignItems: 'center', minWidth: 0 }}>
        <div className="flex" style={{ gap: 6, alignItems: 'center', minWidth: 0, maxWidth: '100%' }}>
          <button type="button" className="tab" aria-label="이전 법인" disabled={corpIdx <= 0} onClick={() => pickVc(corps[corpIdx - 1].id)} style={{ padding: '4px 10px' }}>‹</button>
          <Select className="input" value={vcId} onChange={(e) => pickVc(e.target.value)} aria-label="법인(vCenter)" style={{ fontSize: 14, fontWeight: 800, padding: '5px 10px', minWidth: 0, width: 'auto', maxWidth: 'min(100%, 340px)' }}>
            {corps.map((v) => <option key={v.id} value={v.id}>{v.name}{v.state ? ` — ${directorStateOf(v.state).text}` : ''}</option>)}
          </Select>
          <button type="button" className="tab" aria-label="다음 법인" disabled={corpIdx < 0 || corpIdx >= corps.length - 1} onClick={() => pickVc(corps[corpIdx + 1].id)} style={{ padding: '4px 10px' }}>›</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, minWidth: 0, flex: '1 1 360px' }}>
          <Dot color={directorStateOf(dir.state).color} unknown={dir.state === 'unset'} />
          <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{directorLineText(dir)}{(dir.schedule || dir.pool) ? <span className="muted"> · {[dir.schedule && `기본 스케줄 ${dir.schedule}`, dir.pool && `풀 ${dir.pool}`].filter(Boolean).join(' · ')}</span> : null}</span>
        </div>
        <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>이 법인 VM {numText(data.vm)} (템플릿·vCLS 제외)</span>
      </div>

      {vcId && <BareosHealthCard key={vcId} vcId={vcId} />}

      <div data-bareos-stats="" style={STAT_GRID}>
        <Stat label="Bareos 방식 VM" value={numText(c.bareosMethod)}
          sub={<>{data.vm && Number.isFinite(c.bareosMethod) ? <span>전체 {numText(data.vm)} 중 {Math.round((c.bareosMethod / data.vm) * 100)}%</span> : null}<span>용량 {c.rows ? fmtGb(c.gb) : '—'}{c.gbUnknown ? ` · 모름 ${c.gbUnknown}대 제외` : ''}</span></>} />
        <Stat label="잡 등록" value={numText(c.jobs)} sub={<><span>켜짐 {numText(c.on)} · 꺼짐 {numText(c.off)}</span>{c.mismatch ? <span>방식 불일치 {numText(c.mismatch)}</span> : null}</>} />
        <Stat label={`마지막 결과 (잡 ${numText(c.jobs)})`}
          sub={c.ok == null ? <span>모름(잡 {numText(c.unknown)})</span> : <><span style={{ color: TONE.ok }}>성공 {c.ok}</span><span style={{ color: TONE.warn }}>경고 {c.warn}</span><span style={{ color: TONE.bad }}>실패 {c.fail}</span>{c.cancel ? <span className="muted">취소 {c.cancel}</span> : null}<span style={{ color: TONE.run }}>진행 {c.run}</span></>}>
          {resultBar(c) ? <ResultBar b={resultBar(c)} label={`성공 ${c.ok} · 경고 ${c.warn} · 실패 ${c.fail}${c.cancel ? ` · 취소 ${c.cancel}` : ''} · 진행 ${c.run}`} /> : <span className="muted" style={{ fontSize: 12 }}>{c.jobs ? '모름' : '잡 없음'}</span>}
        </Stat>
        <Stat label="확인 필요" value={numText(attn.n)} tone={attn.n ? 'bad' : undefined}
          sub={<><span>실패 {numText(attn.parts.fail)}</span><span>미등록 {numText(attn.parts.missing)}</span><span>오래됨({data.rpoDays}일+) {numText(attn.parts.old)}</span><span>백업 없음 {numText(attn.parts.never)}</span></>} />
      </div>

      <div className="flex gap wrap" style={{ alignItems: 'center', rowGap: 8 }}>
        <div className="flex gap wrap" role="group" aria-label="보기" style={{ rowGap: 6, alignItems: 'center' }}>
          {[...DETAIL_FILTERS_MAIN, ...(moreChips || DETAIL_FILTERS_MORE.includes(filter) ? DETAIL_FILTERS_MORE : [])].map((k) => {
            const label = DETAIL_FILTERS.find((x) => x[0] === k)?.[1] || k;
            return (
              <FilterChip key={k} on={filter === k} onClick={() => setFilter(k)}>
                {label}{k === 'old' ? `(${data.rpoDays}일)` : ''} {k === 'all' ? rows.length : numText(counts[k])}
              </FilterChip>
            );
          })}
          {!DETAIL_FILTERS_MORE.includes(filter) && (
            <button type="button" className="tab" aria-expanded={moreChips} onClick={() => setMoreChips((v) => !v)} style={{ padding: '4px 10px', fontSize: 12 }}>
              {moreChips ? '접기 ▴' : `더 보기 ▾ ${DETAIL_FILTERS_MORE.map((k) => `${DETAIL_FILTERS.find((x) => x[0] === k)?.[1]} ${numText(counts[k])}`).join(' · ')}`}
            </button>
          )}
        </div>
        <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: '0 1 260px' }}>
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
                  const den = Math.max(tot, a.ok + a.warn + a.fail + (a.cancel || 0) + a.run);   // 버그 점검 W3 — 성공 + 지금 진행이 겹쳐도 100% 를 넘지 않게
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
                          <div role="img" aria-label={`성공 ${a.ok} · 경고 ${a.warn} · 실패 ${a.fail}${a.cancel ? ` · 취소 ${a.cancel}` : ''} · 진행 ${a.run}`} style={{ display: 'flex', flex: 1, minWidth: 50, maxWidth: 160, height: 6, borderRadius: 3, overflow: 'hidden', background: 'var(--panel-deep)' }}>
                            <div style={{ width: p(a.ok), background: '#22c55e' }} /><div style={{ width: p(a.warn), background: '#f59e0b' }} /><div style={{ width: p(a.fail), background: '#ef4444' }} /><div style={{ width: p(a.cancel || 0), background: '#94a3b8' }} /><div style={{ width: p(a.run), background: '#3b82f6' }} />
                          </div>
                        ) : null}
                        {/* U-13(v2.846): 결과를 모르는 법인(인증 정지·조회 실패)은 막대처럼 '실패 N' 도 그리지 않는다(마지막으로 읽은 값 — KPI·칩은 '—') */}
                        {known && a.fail ? <span style={{ color: TONE.bad, whiteSpace: 'nowrap' }}>실패 {a.fail}</span> : null}
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
                        {snapshotChip(r.snaps) && <span className="badge amber" style={{ fontSize: 10, flex: 'none' }} title={SNAPSHOT_TITLE}>{snapshotChip(r.snaps)}</span>}
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
        </div>

        <div style={{ flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12, alignSelf: 'flex-start' }}>
          <div className="card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
            {!selRow ? <div className="muted" style={{ fontSize: 13 }}>VM 을 누르면 여기에 Bareos 백업 상세가 보입니다.</div> : (
              <>
                <div className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{selRow.folder || '—'}</div>
                <div className="flex" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 16, overflowWrap: 'anywhere' }}>{selRow.name}</b><MethodBadge method={selRow.method || ''} small />
                </div>
                {snapshotChip(selRow.snaps) && <Note tone="warn">{snapshotChip(selRow.snaps)} — {SNAPSHOT_TITLE}</Note>}
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
                {manage && selRow.job && (
                  <div className="flex gap wrap" style={{ rowGap: 6 }}>
                    <a className="tab active" href="#/tools/bareos-backup/targets" onClick={() => saveTargetFocus(vcId, selRow.id)} style={{ padding: '5px 12px', fontSize: 12, textDecoration: 'none' }}>운영에서 열기 — 실행 · 결과 · 복원 →</a>
                  </div>
                )}
                {manage && !selRow.job && selRow.b?.job === false && (
                  <div className="muted" style={{ fontSize: 12 }}>잡이 없습니다 — 운영 › 백업 대상의 ‘+ 백업 대상 추가’ 로 등록합니다.</div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      <ReadGuide note="백업 방식은 사람이 정한 값(Backup › Detail)이고 잡은 포탈 원장입니다 — 둘이 어긋나면 ‘미등록’ · ‘방식 불일치’ 로 따로 셉니다.">
        <div><b style={{ color: TONE.ok }}>성공</b> · <b style={{ color: TONE.warn }}>경고</b> · <b style={{ color: TONE.bad }}>실패</b> 그 잡의 마지막으로 끝난 실행(폴러가 반영한 Director 카탈로그 값)</div>
        <div><b style={{ color: TONE.bareos }}>미등록</b> 백업 방식은 Bareos 로 정했는데 잡이 없음 — 등록 전까지 백업되지 않습니다</div>
        <div><b style={{ color: '#fb923c' }}>{data.rpoDays}일+</b> 마지막 백업이 기준(현황의 ‘오래된 백업 기준’)보다 오래됨</div>
        <div><b>방식 불일치</b> 잡은 있는데 백업 방식이 Bareos 가 아님 — Detail 탭에서 방식을 맞추세요</div>
        <div>폴더 줄 = 그 아래 Bareos 관련 VM 중 잡이 있는 수 / 전체 · 막대 = 잡의 마지막 결과 · 마지막 백업 = 백업이 만들어진(성공·경고) 마지막 실행 · 인벤토리에 없는 잡은 등록 때 위치에 보입니다</div>
        <div className="muted">— 는 없음, ‘모름’ 은 그쪽을 읽지 못함(백업 안 됨이 아님)</div>
      </ReadGuide>
    </div>
  );
}
