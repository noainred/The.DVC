/**
 * Backup › Summary '법인 › 폴더 › VM' 트리 표(v2.836 — 사용자 요청 '1의 폴더 구조도 같은 모양으로' · 'BackedUp · 백업 안함 · 확인 필요' ·
 *   '폴더를 클릭하면 VM list' + 시안 ①) → v2.837 시안에 맞춤: 체크박스(법인 · 폴더 · VM — 선택은 한 법인 안에서만) · 법인 줄 배지 ·
 *   VM 행 = 이름 옆 정책 배지 · 백업 칸 = 실제 백업(마지막 결과) · 상태 점 · 다음 예정(그룹 회차 + Veeam 잡) · 펼친 법인 안의 폴더 · VM 찾기.
 *   · 법인 줄 = 서버 법인 집계(GET /tools/backup-summary 의 rows[].pa — Detail 과 같은 VM 행을 센 값)
 *   · 법인을 펼치면 그 법인의 Detail 응답(GET /tools/backup-detail — 서버 60초 캐시)을 읽어 backupViewText.buildTree 로 폴더 › VM 을 그린다(판정 코어 하나)
 *   · 무거운 읽기라 폴링하지 않는다(펼칠 때 1회 · 위 새로고침 · 범위 옵션이 바뀌면 열린 법인만 다시) · 늦게 온 이전 응답은 버린다 · 훅은 조기 return 위.
 *   ⚠ 못 읽은 값은 '—'(0 이 아니다) · 정책을 모르면 묶음을 그리지 않는다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { SearchBox } from '../../components/ui.jsx';
import { MethodBadge } from './BackupMarkIcons.jsx';
import { fmtNum, fmtGb, pctOf, shortTs, buildTree, flattenTree, folderRpoPct, rpoCell, lastOkText, nextOf, errText, scopeQuery, matchSite, folderVmIdMap, folderCheckState, veeamCell, bareosCell } from './backupViewText.js';
import { BUNDLES, BACKED_UP_KEYS, bundlesOf, siteRpo, rpoColor, sortSites, siteNote, siteBadges } from './backupSummaryText.js';

// 첫 열을 넓게(VM 행 = 체크 · 상태 점 · 이름 · OS · 정책 칩 — 1440 에서 이름이 잘리지 않게 · Chromium 확인)
const GRID = 'minmax(330px, 2.4fr) 56px 76px minmax(200px, 1.3fr) 84px 58px 96px 96px 52px';
export const SUMMARY_GRID_MIN = 1060;
const TONE = { ok: '#86efac', bad: '#fca5a5', unknown: 'var(--text-dim)', none: 'var(--text-dim)' };
const DOT = { ok: '#22c55e', bad: '#ef4444', unknown: '#64748b', none: '#475569' };
const BADGE = { warn: { color: '#fcd34d', background: 'rgba(245,158,11,.16)' }, bad: { color: '#fca5a5', background: 'rgba(239,68,68,.16)' }, info: { color: '#93c5fd', background: 'rgba(59,130,246,.16)' }, muted: { color: 'var(--text-dim)', background: 'var(--panel-deep)' } };
const ACT = { ok: '#86efac', run: '#fbbf24', wait: '#fbbf24', bareos: '#fdba74', bareosWarn: '#fcd34d', bareosBad: '#fca5a5', bareosNone: 'var(--text-dim)', none: 'var(--text-dim)', unknown: 'var(--text-dim)' };

function Bar({ n, of, color, label, title }) {
  const p = pctOf(n, of) || 0;
  return (
    <div className="flex" title={title} style={{ alignItems: 'center', minWidth: 0, gap: 6 }}>
      <span style={{ fontWeight: 700, color, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', minWidth: 52, fontSize: 12 }}>{fmtNum(n)}/{fmtNum(of)}</span>
      <div style={{ flex: 1, minWidth: 24, height: 5, borderRadius: 3, background: 'var(--panel-deep)' }}><div style={{ height: 5, borderRadius: 3, background: color, width: `${n > 0 ? Math.max(2, p) : 0}%` }} /></div>
      <span style={{ color, fontSize: 11, whiteSpace: 'nowrap' }}>{label}</span>
    </div>
  );
}
function Bundles({ a }) {
  const b = bundlesOf(a);
  if (!b) return <span className="muted" style={{ fontSize: 12 }}>정책 모름</span>;
  return <>{BUNDLES.map((x) => <Bar key={x.key} n={b[x.key]} of={b.n} color={x.color} label={x.text} title={x.title} />)}{b.unk ? <span className="muted" style={{ fontSize: 11 }}>정책 모름 {fmtNum(b.unk)}</span> : null}</>;
}
const Folder = ({ top }) => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={top ? '#22d3ee' : '#fbbf24'} strokeWidth="2" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
const Building = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#a5b4fc" strokeWidth="2" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}><path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 9h2a2 2 0 0 1 2 2v10M3 21h18M8 7h4M8 11h4M8 15h4" /></svg>;
const cellBtn = { display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, minHeight: 40, padding: '0 8px 0 0', background: 'none', border: 0, color: 'var(--text)', font: 'inherit', cursor: 'pointer', textAlign: 'left' };
const box = { width: 15, height: 15, margin: '0 6px 0 0', flex: 'none' };

/** 체크박스(전부 · 일부 · 없음) — 일부면 indeterminate. */
function Check({ state, disabled, onChange, label, title }) {
  return <input type="checkbox" aria-label={label} title={title} checked={state === 'all'} ref={(el) => { if (el) el.indeterminate = state === 'some'; }} disabled={disabled} onChange={onChange} style={box} />;
}

/** 열 머리 — 정렬 가능한 열은 버튼(aria-sort). */
function Head({ k, sort, onSort, children, style, title }) {
  const on = sort.key === k;
  return (
    <div role="columnheader" aria-sort={k ? (on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined} title={title} style={{ padding: '9px 6px', whiteSpace: 'nowrap', ...style }}>
      {k ? <button type="button" onClick={() => onSort(k)} style={{ background: 'none', border: 0, padding: 0, color: on ? 'var(--text)' : 'inherit', font: 'inherit', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>{children}{on ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button> : children}
    </div>
  );
}

/** VM 행의 실제 백업 칸 — Veeam · Bareos 마지막 결과(Detail 과 같은 문구). 둘 다 없으면 '없음', 모르면 '모름'. */
function actualCells(vm) {
  const out = [];
  if (vm?.a?.v === true) out.push(veeamCell(vm));
  if (vm?.b?.job === true || vm?.b?.job === false) out.push(bareosCell(vm));
  return out;
}

export default function BackupSummaryTree({ rows, opts, reloadKey, onOpenDetail, sel, onPick }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const [open, setOpen] = useState(() => new Set());   // 펼친 법인
  const [sites, setSites] = useState(() => new Map());   // vcId → { status:'loading'|'ok'|'error', data?, error? }
  const [fopen, setFopen] = useState(() => new Map());   // vcId → 펼친 폴더 key 집합(없으면 첫 단계만)
  const gens = useRef(new Map());
  const openRef = useRef(open); openRef.current = open;
  const loadSite = useCallback((id) => {
    const my = (gens.current.get(id) || 0) + 1; gens.current.set(id, my);
    setSites((m) => new Map(m).set(id, { status: 'loading' }));
    fetchJson('/tools/backup-detail', { vcenterId: id, ...scopeQuery(opts) })
      .then((r) => { if (gens.current.get(id) === my) setSites((m) => new Map(m).set(id, { status: 'ok', data: r })); })
      .catch((e) => { if (gens.current.get(id) === my) setSites((m) => new Map(m).set(id, { status: 'error', error: e })); });
  }, [opts.power, opts.excl]); // eslint-disable-line react-hooks/exhaustive-deps
  // 범위 옵션(전원·제외)이나 위 새로고침이 바뀌면 받아 둔 법인 자료를 버리고 열린 법인만 다시 읽는다(첫 그리기는 건너뛴다 — 아직 연 법인이 없다)
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return undefined; }
    for (const k of gens.current.keys()) gens.current.set(k, gens.current.get(k) + 1);
    setSites(new Map());
    for (const id of openRef.current) loadSite(id);
    return undefined;
  }, [loadSite, reloadKey]);
  useEffect(() => () => { for (const k of gens.current.keys()) gens.current.set(k, gens.current.get(k) + 1); }, []);

  const needle = q.trim();
  // 펼친(읽어 둔) 법인의 트리 — 법인 이름이 찾는 말과 맞지 않으면 폴더 · VM 으로 거른다(시안 '법인 · 폴더 · VM' 찾기 — 읽지 않은 법인은 이름만 본다)
  const trees = useMemo(() => {
    const m = new Map();
    for (const [id, s] of sites) {
      if (s.status !== 'ok' || !Array.isArray(s.data?.vms)) continue;
      const nameHit = matchSite({ name: s.data?.vcenter?.name || id }, needle);
      const tree = buildTree(s.data.vms, { rpoDays: opts.rpoDays, now: s.data.at, q: nameHit ? '' : needle });
      m.set(id, { tree, ids: folderVmIdMap(tree), all: tree.agg.n ? s.data.vms.map((v) => v.id) : [], filtered: !nameHit && !!needle });
    }
    return m;
  }, [sites, opts.rpoDays, needle]);
  const shown = useMemo(() => sortSites((Array.isArray(rows) ? rows : []).filter((r) => matchSite(r, needle) || (needle && (trees.get(r.id)?.tree?.hit || 0) > 0)), sort.key, sort.dir, { rpoDays: opts.rpoDays }),
    [rows, needle, trees, sort, opts.rpoDays]);

  const onSort = (k) => setSort((cur) => (cur.key === k ? { key: k, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: k === 'name' ? 'asc' : 'desc' }));
  const toggleSite = (id) => {
    const was = open.has(id);
    setOpen((cur) => { const s = new Set(cur); if (s.has(id)) s.delete(id); else s.add(id); return s; });
    if (!was && (!sites.has(id) || sites.get(id).status === 'error')) loadSite(id);
  };
  // 처음엔 접힌 채(사용자 요청 '폴더를 클릭하면 VM list') — 맨 위가 데이터센터 하나뿐이면 그것만 열어 폴더 목록을 보인다
  const firstOpen = (id) => { const c = trees.get(id)?.tree?.children || []; return c.length === 1 ? [c[0].key] : []; };
  const folderSet = (id) => fopen.get(id) || new Set(firstOpen(id));
  const toggleFolder = (id, key) => setFopen((m) => { const s = new Set(m.get(id) || firstOpen(id)); if (s.has(key)) s.delete(key); else s.add(key); return new Map(m).set(id, s); });
  const allOpen = shown.length > 0 && shown.every((r) => open.has(r.id));
  // 선택은 한 법인 안에서만 — 다른 법인이 골라져 있으면 이 법인 칸은 막는다
  const selIds = sel?.ids || new Set();
  const lockedFor = (vc) => !!(sel?.vc && sel.vc !== vc && selIds.size);
  const lockTitle = '다른 법인의 VM 이 골라져 있습니다 — 위 도구 줄에서 선택 해제 뒤 고르세요(선택은 한 법인 안에서만)';
  const checkIds = (vc, ids) => { const st = folderCheckState(sel?.vc === vc ? selIds : null, ids); onPick?.(vc, ids, st !== 'all'); };

  const msgRow = (key, depth, text, extra) => (
    <div role="row" key={key} style={{ display: 'grid', gridTemplateColumns: GRID, borderTop: '1px solid var(--border-soft)' }}>
      <div role="gridcell" style={{ gridColumn: '1 / -1', padding: `9px 14px 9px ${34 + depth * 20}px`, fontSize: 12.5 }} className="muted">{text}{extra}</div>
    </div>
  );

  return (
    <section className="card" aria-label="법인 › 폴더 › VM 백업 현황" data-backup-tree="" style={{ padding: 0, overflow: 'hidden', minWidth: 0 }}>
      <div className="flex wrap" style={{ alignItems: 'center', gap: '6px 12px', padding: '12px 14px' }}>
        <div style={{ minWidth: 0 }}>
          <b style={{ fontSize: 15 }}>vCenter 폴더 구조 — 전체 백업 현황</b>
          <div className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{fmtNum(rows?.length)}개 법인 › 폴더 › VM · Detail 과 같은 트리 표(폴더마다 BackedUp · 백업 안함 · 확인 필요 세 묶음 막대 · 폴더를 누르면 VM 목록)</div>
        </div>
        <div className="flex wrap" style={{ marginLeft: 'auto', gap: 8, alignItems: 'center' }}>
          <button type="button" className="tab" disabled={!shown.length} onClick={() => { if (allOpen) setOpen(new Set()); else { setOpen(new Set(shown.map((r) => r.id))); for (const r of shown) if (!sites.has(r.id) || sites.get(r.id).status === 'error') loadSite(r.id); } }}
            title={allOpen ? '모든 법인 접기' : '보이는 법인을 모두 펼칩니다 — 법인마다 Detail 자료를 읽습니다'} style={{ padding: '4px 12px', fontSize: 12 }}>{allOpen ? '모두 접기' : '모두 펼치기'}</button>
          <SearchBox className="input" style={{ maxWidth: 230, minWidth: 160 }} value={q} onChange={setQ} placeholder="법인 · 폴더 · VM" title="법인 이름 · 펼친 법인 안의 폴더 · VM 이름" />
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <div role="treegrid" aria-label="법인 › 폴더 › VM 백업" aria-multiselectable="true" style={{ minWidth: SUMMARY_GRID_MIN, fontSize: 13 }}>
          <div role="row" style={{ display: 'grid', gridTemplateColumns: GRID, background: 'var(--panel-deep)', color: 'var(--text-dim)', fontSize: 12, fontWeight: 600 }}>
            <Head k="name" sort={sort} onSort={onSort} style={{ padding: '9px 14px' }}>법인 › 폴더 › VM</Head>
            <Head sort={sort} onSort={onSort}>전원</Head>
            <Head k="gb" sort={sort} onSort={onSort} style={{ textAlign: 'right', padding: '9px 10px 9px 6px' }} title="VM 스토리지 사용(vCenter 인벤토리) · 법인·폴더 = 그 아래 VM 합">용량</Head>
            <Head k="backed" sort={sort} onSort={onSort} style={{ color: '#67e8f9' }} title="법인·폴더 = 사람이 정한 백업 정책 세 묶음(합 = VM 수) · VM = 실제 백업(마지막 결과)">백업(BackedUp · 백업 안함 · 확인 필요)</Head>
            <Head k="rpo" sort={sort} onSort={onSort} title={`최근 ${opts.rpoDays === 1 ? '24시간' : `${opts.rpoDays}일`} 안에 성공한 백업(Veeam · Bareos)이 있는 VM 비율 — 백업 안함은 빼고 · 결과를 모르는 VM 은 따로`}>RPO</Head>
            <Head sort={sort} onSort={onSort} style={{ textAlign: 'right' }} title="Veeam 복원 지점">복원 지점</Head>
            <Head k="lok" sort={sort} onSort={onSort} title="마지막 성공(Veeam · Bareos 중 늦은 것)">마지막 백업</Head>
            <Head k="nx" sort={sort} onSort={onSort} title="Veeam 잡 다음 실행 · Bareos 그룹 예약 다음 회차 · Director 스케줄(정책 수집본) 중 이른 것">다음 예정</Head>
            <Head k="err" sort={sort} onSort={onSort} style={{ padding: '9px 14px 9px 6px' }} title="최근 24시간 실패·경고가 있는 VM 수">에러</Head>
          </div>
          {shown.length === 0 && msgRow('empty', 0, rows?.length ? '맞는 법인 · 폴더 · VM 이 없습니다(폴더 · VM 은 펼친 법인에서만 찾습니다).' : '법인이 없습니다.')}
          {shown.map((r) => {
            const pa = r.pa || null;
            const t = trees.get(r.id);
            const isOpen = open.has(r.id) || !!(t?.filtered && t.tree.hit > 0);
            const rp = siteRpo(pa, opts.rpoDays);
            const note = siteNote(r);
            const st = sites.get(r.id);
            const locked = lockedFor(r.id);
            const siteIds = t?.all || [];
            const out = [(
              <div role="row" key={`site:${r.id}`} data-vc-row={r.id} aria-expanded={isOpen} style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', borderTop: '1px solid var(--border)', background: 'rgba(99,102,241,.08)' }}>
                <div role="gridcell" style={{ minWidth: 0, display: 'flex', alignItems: 'center', paddingLeft: 14, gap: 4 }}>
                  <Check state={folderCheckState(sel?.vc === r.id ? selIds : null, siteIds)} disabled={locked || !siteIds.length} onChange={() => checkIds(r.id, siteIds)}
                    label={`${r.name} 의 VM 모두 선택`} title={locked ? lockTitle : siteIds.length ? `이 법인의 VM ${fmtNum(siteIds.length)}대 모두 선택` : '법인을 펼치면 고를 수 있습니다'} />
                  <button type="button" onClick={() => toggleSite(r.id)} aria-label={`${r.name} ${isOpen ? '접기' : '폴더 펼치기'}`} style={cellBtn}>
                    <span className="muted" style={{ width: 12 }}>{isOpen ? '▾' : '▸'}</span>
                    <Building />
                    <span style={{ minWidth: 0 }}>
                      <b style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.name}>{r.name}</b>
                      <span className="muted" style={{ display: 'block', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={note || undefined}>{fmtNum(pa?.n)} VM{note ? ` · ${note}` : ''}</span>
                    </span>
                  </button>
                  <span className="flex wrap" style={{ gap: 4, flex: 'none', maxWidth: 130, justifyContent: 'flex-end' }}>
                    {siteBadges(r).map((x) => <span key={x.key} style={{ ...BADGE[x.tone], padding: '1px 7px', borderRadius: 999, fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap' }}>{x.text}</span>)}
                  </span>
                  <button type="button" className="tab" onClick={() => onOpenDetail?.(r.id)} title={`${r.name} Detail 로 — 백업 정책 저장 · 백업 등록`} style={{ padding: '1px 8px', fontSize: 11, margin: '0 6px 0 4px', flex: 'none' }}>Detail ›</button>
                </div>
                <div role="gridcell" style={{ padding: '0 6px', fontSize: 11.5 }} className="muted">켜짐 {fmtNum(pa?.on)}</div>
                <div role="gridcell" style={{ padding: '0 10px 0 6px', textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums', lineHeight: 1.3 }}>
                  <b>{pa && pa.n > pa.gbUnk ? fmtGb(pa.gb) : '—'}</b>{pa?.gbUnk ? <div className="muted" style={{ fontSize: 11 }}>+모름 {fmtNum(pa.gbUnk)}</div> : null}
                </div>
                <div role="gridcell" style={{ padding: '5px 6px', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}><Bundles a={pa} /></div>
                <div role="gridcell" style={{ padding: '0 6px', fontSize: 12.5, lineHeight: 1.3 }}>
                  {rp?.pct == null ? <span className="muted">—</span> : <b style={{ color: rpoColor(rp.pct) }}>{rp.pct}%</b>}
                  {rp?.miss ? <div className="muted" style={{ fontSize: 11 }}>미달 {fmtNum(rp.miss)}</div> : null}
                  {rp?.unk ? <div className="muted" style={{ fontSize: 11 }}>모름 {fmtNum(rp.unk)}</div> : null}
                </div>
                <div role="gridcell" style={{ padding: '0 6px', textAlign: 'right' }} className="muted">—</div>
                <div role="gridcell" style={{ padding: '0 6px', fontFamily: 'var(--mono)', fontSize: 11.5, whiteSpace: 'nowrap' }}>{shortTs(pa?.lok)}</div>
                <div role="gridcell" style={{ padding: '0 6px', fontFamily: 'var(--mono)', fontSize: 11.5, whiteSpace: 'nowrap' }} className={pa?.nx ? undefined : 'muted'}>{shortTs(pa?.nx)}</div>
                <div role="gridcell" style={{ padding: '0 14px 0 6px', fontSize: 12.5, fontWeight: 700, color: pa?.err?.vms ? '#fca5a5' : 'var(--text-dim)' }}>{pa?.err?.vms ? fmtNum(pa.err.vms) : '—'}</div>
              </div>
            )];
            if (!isOpen) return out;
            if (!st || st.status === 'loading') { out.push(msgRow(`ld:${r.id}`, 0, '폴더 · VM 을 읽는 중…')); return out; }
            if (st.status === 'error') {
              const denied = st.error?.status === 403;
              out.push(msgRow(`er:${r.id}`, 0, denied ? '이 계정은 Detail 화면이 허용되지 않아 폴더 · VM 을 볼 수 없습니다(관리자가 정한 도구별 접근).' : `읽지 못했습니다 — ${String(st.error?.message || st.error || '').slice(0, 160)}`,
                denied ? null : <button type="button" className="tab" onClick={() => loadSite(r.id)} style={{ marginLeft: 10, padding: '1px 10px', fontSize: 12 }}>다시 읽기</button>));
              return out;
            }
            const data = st.data;
            if (!t || (!t.tree.children.length && !t.tree.vms.length)) { out.push(msgRow(`em:${r.id}`, 0, t?.filtered ? '이 법인에는 맞는 폴더 · VM 이 없습니다.' : '이 범위에 VM 이 없습니다.')); return out; }
            const marksUnknown = !!data?.marksUnreadable;
            for (const row of flattenTree(t.tree, folderSet(r.id), { forceOpen: t.filtered })) {
              const depth = row.depth + 1;
              const pad = 14 + depth * 20;
              if (row.kind === 'folder') {
                const a = row.node.agg;
                const fp = folderRpoPct(a);
                const ids = t.ids.get(row.key) || [];
                out.push(
                  <div role="row" key={`f:${r.id}:${row.key}`} aria-expanded={row.open} style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', borderTop: '1px solid var(--border-soft)' }}>
                    <div role="gridcell" style={{ minWidth: 0, display: 'flex', alignItems: 'center', paddingLeft: pad }}>
                      <Check state={folderCheckState(sel?.vc === r.id ? selIds : null, ids)} disabled={locked || !ids.length} onChange={() => checkIds(r.id, ids)}
                        label={`${row.node.name} 폴더의 VM ${ids.length}대 선택`} title={locked ? lockTitle : `이 폴더 아래 VM ${fmtNum(ids.length)}대`} />
                      <button type="button" onClick={() => toggleFolder(r.id, row.key)} disabled={t.filtered} aria-label={`${row.node.name} 폴더 ${row.open ? '접기' : 'VM 목록 펼치기'}`} style={cellBtn}>
                        <span className="muted" style={{ width: 12 }}>{row.open ? '▾' : '▸'}</span>
                        <Folder top={row.depth === 0} />
                        <b title={row.node.name} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.node.name}</b>
                        <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{a.n} VM{t.filtered && row.node.hit !== a.n ? ` · 맞음 ${row.node.hit}` : ''}</span>
                      </button>
                    </div>
                    <div role="gridcell" />
                    <div role="gridcell" style={{ padding: '0 10px 0 6px', textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums', lineHeight: 1.3 }} title={a.gbUnknown ? `용량을 모르는 VM ${a.gbUnknown}대는 합에 넣지 않았습니다` : undefined}>
                      <b>{a.n > a.gbUnknown ? fmtGb(a.gb) : '—'}</b>{a.gbUnknown ? <div className="muted" style={{ fontSize: 11 }}>+모름 {a.gbUnknown}</div> : null}
                    </div>
                    <div role="gridcell" style={{ padding: '5px 6px', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>{marksUnknown ? <span className="muted" style={{ fontSize: 12 }}>정책 모름</span> : <Bundles a={a} />}</div>
                    <div role="gridcell" style={{ padding: '0 6px', fontSize: 12.5, lineHeight: 1.3 }}>{fp == null ? <span className="muted">—</span> : <><b style={{ color: rpoColor(fp) }}>{fp}%</b>{a.rpoMiss ? <div className="muted" style={{ fontSize: 11 }}>미달 {a.rpoMiss}</div> : null}</>}</div>
                    <div role="gridcell" />
                    <div role="gridcell" style={{ padding: '0 6px', fontFamily: 'var(--mono)', fontSize: 11.5, whiteSpace: 'nowrap' }}>{shortTs(a.lok)}</div>
                    <div role="gridcell" style={{ padding: '0 6px', fontFamily: 'var(--mono)', fontSize: 11.5, whiteSpace: 'nowrap' }} className={a.nx != null ? undefined : 'muted'}>{shortTs(a.nx)}</div>
                    <div role="gridcell" style={{ padding: '0 14px 0 6px', fontSize: 12.5, fontWeight: 700, color: a.err ? '#fca5a5' : 'var(--text-dim)' }}>{a.err ? fmtNum(a.err) : '—'}</div>
                  </div>,
                );
                continue;
              }
              const vm = row.vm;
              const rc = rpoCell(vm, { rpoDays: opts.rpoDays, now: data.at });
              const backed = BACKED_UP_KEYS.includes(vm.p);
              const nx = nextOf(vm, data.at);
              const act = actualCells(vm);
              const picked = sel?.vc === r.id && selIds.has(vm.id);
              out.push(
                <div role="row" key={`v:${r.id}:${vm.id}`} aria-selected={picked} style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', borderTop: '1px solid var(--border-soft)', background: picked ? 'rgba(59,130,246,.10)' : undefined }}>
                  <div role="gridcell" style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, paddingLeft: pad + 20, minHeight: 36 }}>
                    <input type="checkbox" aria-label={`${vm.name} 선택`} checked={picked} disabled={locked} title={locked ? lockTitle : undefined} onChange={() => onPick?.(r.id, [vm.id], !picked)} style={{ ...box, margin: 0 }} />
                    <span aria-hidden="true" title={`RPO ${rc.text}`} style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: DOT[rc.tone] || DOT.unknown }} />
                    <span title={vm.name} style={{ fontWeight: 600, minWidth: 48, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{vm.name}</span>
                    {(vm.os === 'windows' || vm.os === 'linux') && <span style={{ flex: 'none', fontSize: 10.5, fontWeight: 700, padding: '0 6px', borderRadius: 999, color: vm.os === 'windows' ? '#93c5fd' : '#5eead4', background: vm.os === 'windows' ? 'rgba(59,130,246,.18)' : 'rgba(20,184,166,.18)' }}>{vm.os === 'windows' ? 'Windows' : 'Linux'}</span>}
                    {backed
                      ? <span title={`백업 정책 ${vm.p === 'veeam' ? 'Veeam' : vm.p === 'bareos' ? 'Bareos' : 'SSH'}(BackedUp)`} style={{ flex: 'none', fontSize: 10.5, fontWeight: 700, padding: '0 6px', borderRadius: 999, color: BUNDLES[0].color, border: `1px solid ${BUNDLES[0].color}`, whiteSpace: 'nowrap' }}>BackedUp <span style={{ fontWeight: 600, color: 'var(--text-dim)' }}>{vm.p === 'veeam' ? 'Veeam' : vm.p === 'bareos' ? 'Bareos' : 'SSH'}</span></span>
                      : vm.p ? <span style={{ flex: 'none' }}><MethodBadge method={vm.p} small /></span> : <span className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>정책 모름</span>}
                  </div>
                  <div role="gridcell" style={{ padding: '0 6px', fontSize: 12, color: vm.power === 'POWERED_ON' ? '#86efac' : 'var(--text-dim)' }}>{vm.power === 'POWERED_ON' ? '켜짐' : vm.power ? '꺼짐' : '—'}</div>
                  <div role="gridcell" style={{ padding: '0 10px 0 6px', textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: vm.gb == null ? 'var(--text-dim)' : undefined }}>{fmtGb(vm.gb)}</div>
                  <div role="gridcell" style={{ padding: '2px 6px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1, fontSize: 12 }}>
                    {act.length ? act.map((c, i) => <span key={i} style={{ color: ACT[c.tone] || 'var(--text)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.text}>{c.text}{i === 0 && vm.v?.jobs?.[0] && vm.a?.v === true ? <span className="muted" style={{ fontWeight: 400 }}> · {vm.v.jobs[0]}</span> : null}</span>)
                      : vm.p === 'none' ? <span className="muted">— 대상 아님</span> : vm.a?.v === false && vm.a?.b !== null ? <span className="muted">없음{vm.p === 'check' ? ' — 정책 미정' : ''}</span> : <span className="muted">모름</span>}
                  </div>
                  <div role="gridcell" style={{ padding: '0 6px', fontSize: 12, fontWeight: 700, color: TONE[rc.tone] || 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={rc.text}>{rc.text}</div>
                  <div role="gridcell" style={{ padding: '0 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>{vm.v && Number.isFinite(vm.v.rp) && vm.v.rp >= 0 ? vm.v.rp : '—'}</div>
                  <div role="gridcell" style={{ padding: '0 6px', fontFamily: 'var(--mono)', fontSize: 11.5, whiteSpace: 'nowrap', color: lastOkText(vm) === '모름' ? 'var(--text-dim)' : undefined }}>{lastOkText(vm)}</div>
                  <div role="gridcell" style={{ padding: '0 6px', fontFamily: 'var(--mono)', fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={nx?.title} className={nx ? undefined : 'muted'}>{nx ? shortTs(nx.at) : '—'}</div>
                  <div role="gridcell" style={{ padding: '0 14px 0 6px', fontSize: 11, color: '#fca5a5', fontWeight: 700, lineHeight: 1.3 }}>{errText(vm) || <span className="muted" style={{ fontWeight: 400 }}>—</span>}</div>
                </div>,
              );
            }
            return out;
          })}
        </div>
      </div>
      <div className="muted" style={{ padding: '8px 14px', fontSize: 11.5, borderTop: '1px solid var(--border-soft)', lineHeight: 1.6 }}>
        제목을 누르면 법인 줄을 정렬합니다 · 법인 이름을 누르면 폴더, 폴더를 누르면 그 아래 VM 이 펼쳐집니다(법인마다 Detail 과 같은 자료를 읽습니다) · 체크한 VM 은 위 도구 줄의 백업 정책 · 백업 등록으로 넘깁니다(한 법인 안에서만) ·
        막대 = 사람이 정한 백업 정책 세 묶음(합 = VM 수) · VM 줄의 백업 칸 = 실제 백업(마지막 결과) · RPO 는 백업 안함 정책을 빼고 계산하고 결과를 모르는 VM 은 ‘모름’ 으로 따로 셉니다 · ‘—’ 는 못 읽은 값입니다(0 이 아닙니다).
      </div>
    </section>
  );
}
