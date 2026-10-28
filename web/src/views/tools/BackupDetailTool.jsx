/**
 * 백업 세부내용 — 특수 기능 `backup-detail`(v2.779, 사용자 요청 '1개 vcenter 를 선택하면 VM 백업 전체 현황 · veeam 백업과 snapshot 둘다' +
 *   시안: vCenter › 폴더 › 하위 폴더 › VM 표). 메뉴: 서버 › Veeam → 화면 위 Summary | Detail 탭(v2.787 — 예전 'Veeam 현황 › Detail' · 도구 키 그대로). 값은 서버(GET /api/tools/backup-detail — veeam/backupStatus.js).
 * ⚠ 폴링하지 않는다(vCenter 를 고를 때·새로고침 · 서버 60초 캐시) · 늦게 온 이전 응답은 버린다 · 훅은 전부 조기 return 위.
 * ⚠ VM 의 Veeam 키가 없으면 '모름'(서버가 못 읽음), null 이면 '없음' — 둘을 섞지 않는다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, downloadFile, canCsv, putJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import Select from '../../components/Select.jsx';
import { fmtNum, pctOf, veeamStateOf, snapReasonText, FILTERS, filterCounts, buildTree, flattenTree, initialOpen, veeamCell, snapCell, shortTs, vmClass, loadOpts, saveOpts, scopeQuery, scopeNote, runningCell, CRIT, critOf, MEMO_MAX, marksLine, marksNotice, filterCountText, detailLoadKey, toggleAllVisible, invertVisible, visibleVmIds, folderVmIdMap, folderCheckState, filterLabel, METHODS, methodOf, backupCell, cloneCell, methodKeyOf, METHOD_KEYS_MAP } from './backupViewText.js';
import { CritIcon, NeedIcon, NEED_COLOR, MethodBadge } from './BackupMarkIcons.jsx';
import BackupOptions from './BackupOptions.jsx';
import VeeamHeader from './VeeamHeader.jsx';
import { DETAIL_VC_KEY } from './BackupSummaryTool.jsx';
import VmListExportDialog from '../VmListExportDialog.jsx';   // v2.800 'CSV' 버튼 = 백업 내보내기 창(필요한 항목만 · CSV/엑셀 · 내 저장값)
import { backupScreenRequest } from '../vmListExportText.js';
import { VM_LIST_MAX_IDS } from '../vcdVmList.js';
import { downloadFailText } from '../downloadFailText.js';
import { useStickyHeadH, useBoxHeight } from '../../hooks/useStickyOffset.js';

const CHIP = {
  ok: { color: '#86efac', background: 'rgba(34,197,94,.14)' },
  run: { color: '#fcd34d', background: 'rgba(245,158,11,.16)' },
  wait: { color: '#93c5fd', background: 'rgba(59,130,246,.16)' },
  none: { color: 'var(--text-dim)', background: 'transparent', border: '1px solid var(--border)' },
  unknown: { color: 'var(--text-dim)', background: 'transparent', border: '1px dashed var(--border)' },
  now: { color: '#e9d5ff', background: 'rgba(168,85,247,.24)' },
  ev: { color: '#d8b4fe', background: 'transparent', border: '1px dashed #7e4bc0' },
  stale: { color: '#fca5a5', background: 'rgba(239,68,68,.14)', border: '1px dashed #b91c1c' },
  // v2.803 Clone 칸
  clone: { color: '#67e8f9', background: 'rgba(103,232,249,.14)' },
  cloneBad: { color: '#fca5a5', background: 'rgba(239,68,68,.14)' },
  cloneNone: { color: '#67e8f9', background: 'transparent', border: '1px dashed rgba(103,232,249,.5)' },
};
function Chip({ c }) {
  return <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', ...(CHIP[c.tone] || CHIP.none) }}>{c.text}</span>;
}
function AggBar({ n, of, color }) {
  const p = pctOf(n, of) || 0;
  return (
    <div className="flex gap" style={{ alignItems: 'center', minWidth: 0 }}>
      <span style={{ fontWeight: 700, color, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{n}/{of}</span>
      <div style={{ flex: 1, minWidth: 40, height: 5, borderRadius: 3, background: 'var(--panel-deep)' }}><div style={{ height: 5, borderRadius: 3, background: color, width: `${p}%` }} /></div>
    </div>
  );
}

const readSavedVc = () => { try { return localStorage.getItem(DETAIL_VC_KEY) || ''; } catch { return ''; } };
// 1440px 에서 옆 상세 칸(280px)과 함께 가로 스크롤 없이 들어가는 폭(약 790px) — 좁으면 표만 가로로 스크롤한다
// v2.803(사용자 요청): '작업' 열을 지우고 'Clone' 열 · 'Veeam 백업'·'스냅샷' 두 열을 '백업' 한 열로(Veeam 이 있으면 Veeam, 없으면 그 자리에 스냅샷)
const GRID = 'minmax(220px, 2fr) 52px minmax(150px, 1.3fr) minmax(140px, 1.1fr) 64px 104px';

export default function BackupDetailTool({ scope }) {
  const [vcs, setVcs] = useState(null);
  const [vcId, setVcId] = useState(() => scope || readSavedVc());
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [sel, setSel] = useState(null);
  const [opts, setOpts] = useState(() => loadOpts());   // 서머리와 함께 기억(전원·제외는 서버가 세고, 오래된 백업 기준은 화면이 고른다)
  const [csvErr, setCsvErr] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);   // v2.800 백업 내보내기 창
  // v2.784 백업 표시 — 체크한 VM(일괄 적용) · 저장 중 · 저장 오류 · 메모 초안(고른 VM 이 바뀔 때만 다시 채운다)
  const [checked, setChecked] = useState(() => new Set());
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  const [memo, setMemo] = useState('');
  const gen = useRef(0);
  // v2.810(사용자 요청 '스크롤 내리면 선택 바가 계속 보이게'): 일괄 표시 바는 셸 머리 아래에 붙는다 — 머리·바의 실제 높이를 재서
  //   CSS 변수로 넘긴다(.bk-bulk · .bk-side — 숫자를 박지 않는다). 바가 없으면(편집 불가) 높이 0 이라 옆 상세 칸이 머리 바로 아래에 붙는다.
  const headH = useStickyHeadH();
  const [bulkRef, bulkH] = useBoxHeight();

  useEffect(() => {
    let on = true;
    fetchJson('/vcenters').then((r) => { if (on) setVcs(Array.isArray(r) ? r.map((v) => ({ id: v.id, name: v.name || v.id })) : []); }).catch(() => { if (on) setVcs([]); });
    return () => { on = false; };
  }, []);
  // 고른 vCenter 가 없거나 목록에 없으면 이름 순 첫 vCenter
  useEffect(() => {
    if (!vcs || !vcs.length) return;
    if (!vcId || !vcs.some((v) => v.id === vcId)) setVcId([...vcs].sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))[0].id);
  }, [vcs, vcId]);
  // keep: 표시를 저장한 뒤 다시 읽을 때는 펼침·고른 VM·체크를 그대로 둔다
  const load = useCallback((keep = false) => {
    if (!vcId) return;
    const my = ++gen.current;
    setLoading(true); setError(null);
    fetchJson('/tools/backup-detail', { vcenterId: vcId, ...scopeQuery(opts) })
      .then((r) => { if (my === gen.current) { setData(r); if (keep !== true) { setOpen(null); setSel(null); setChecked(new Set()); } } })
      .catch((e) => { if (my === gen.current) setError(e); })
      .finally(() => { if (my === gen.current) setLoading(false); });
  }, [vcId, opts.power, opts.excl]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); try { if (vcId) localStorage.setItem(DETAIL_VC_KEY, vcId); } catch { /* */ } }, [vcId, load]);
  // vCenter 를 바꾸면 이전 vCenter 의 표를 지운다(전원·제외만 바꾸면 다시 읽는 동안 이전 표를 둔다)
  useEffect(() => { setData(null); }, [vcId]);
  // v2.785(GR R-B3): 저장 직후 재조회가 쓸 '지금' 조건과 최신 load — 렌더 시점 클로저로 다시 읽으면 저장 중 vCenter·옵션을 바꾼 뒤
  //   이전 조건의 응답이 새 선택 아래 덮였다(늦게 온 이전 응답 · 그 뒤 저장은 400). 조건이 바뀌었으면 그 조건의 load 가 이미 돈다.
  const keyRef = useRef('');
  keyRef.current = detailLoadKey(vcId, opts);
  const reloadRef = useRef(null);
  reloadRef.current = () => load(true);   // 펼침·고른 VM·체크를 그대로 둔 채 지금 조건으로 다시 읽기
  const changeOpts = useCallback((o) => { setOpts(o); saveOpts(o); }, []);
  const csv = useCallback(async () => {
    setCsvErr(null);
    const qs = new URLSearchParams({ vcenterId: vcId, ...scopeQuery(opts), filter, rpoDays: String(opts.rpoDays) });
    try { await downloadFile(`/tools/backup-detail.csv?${qs}`); } catch (e) { setCsvErr(e); }
  }, [vcId, opts, filter]);

  const vms = useMemo(() => (Array.isArray(data?.vms) ? data.vms : []), [data]);
  const now = data?.at || 0;
  const vopts = useMemo(() => ({ rpoDays: opts.rpoDays, now: now || Date.now() }), [opts.rpoDays, now]);
  const counts = useMemo(() => filterCounts(vms, vopts), [vms, vopts]);
  const tree = useMemo(() => buildTree(vms, { filter, q, ...vopts }), [vms, filter, q, vopts]);
  const openSet = useMemo(() => open || initialOpen(buildTree(vms)), [open, vms]);
  const forceOpen = filter !== 'all' || !!q.trim();
  const rows = useMemo(() => flattenTree(tree, openSet, { forceOpen }), [tree, openSet, forceOpen]);
  const folderIds = useMemo(() => folderVmIdMap(tree), [tree]);   // v2.812 폴더 체크 → 그 아래 보이는 VM 전부
  const selVm = useMemo(() => vms.find((v) => v.id === sel) || null, [vms, sel]);
  const writable = data?.writable === true && !data?.marksUnreadable;
  const marksUnknown = data?.marksUnreadable === true;   // v2.785(GR R-B2): 표시 수·칩은 '—'
  const visibleIds = useMemo(() => visibleVmIds(vms, { filter, q, ...vopts }), [vms, filter, q, vopts]);
  useEffect(() => { setMemo(selVm?.m?.memo || ''); setSaveErr(null); }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveMarks = useCallback(async (ids, patch) => {
    if (!ids.length) return;
    const savedKey = detailLoadKey(vcId, opts);
    setSaving(true); setSaveErr(null);
    // api.js sendJson 은 400·409 를 throw 하지 않고 본문(ok:false)을 돌려준다 — 그 사유를 성공으로 삼키지 않는다(v2.727 E-01 규약)
    try {
      const r = await putJson('/tools/backup-detail/marks', { vcenterId: vcId, vmIds: ids, ...patch });
      if (r?.ok === false) setSaveErr(new Error(r.reason || '저장하지 못했습니다.'));
      // 거부돼도 다시 읽는다(화면이 저장된 값과 같게) — 단 지금 고른 조건이 저장한 조건과 같을 때만(v2.785 GR R-B3)
      if (savedKey === keyRef.current) reloadRef.current();
    } catch (e) { setSaveErr(e); }
    finally { setSaving(false); }
  }, [vcId, opts]);
  // v2.806 백업 방식 단축키(V·C·G·N) — VM 을 고른 상태 · 편집 가능 · 저장 중 아님 · 지금 값과 다를 때만. 입력 칸·조합키는 methodKeyOf 가 거른다.
  useEffect(() => {
    if (!selVm || !writable) return undefined;
    const onKey = (e) => {
      const method = methodKeyOf(e);
      if (!method || saving) return;
      e.preventDefault();
      if ((selVm.m?.method || '') !== method) saveMarks([selVm.id], { method });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selVm, writable, saving, saveMarks]);
  const toggleCheck = (id) => setChecked((cur) => { const s = new Set(cur); if (s.has(id)) s.delete(id); else s.add(id); return s; });

  const toggle = (key) => setOpen((cur) => { const s = new Set(cur || openSet); if (s.has(key)) s.delete(key); else s.add(key); return s; });

  if (vcs && !vcs.length) return <div className="muted">볼 수 있는 vCenter 가 없습니다.</div>;
  // v2.785(GV C-B4): 로딩·오류로 조기 return 하지 않는다 — 머리(vCenter 선택·옵션·새로고침)는 늘 그리고 본문 자리에 로딩·오류 상자를 둔다.
  //   예전에는 조회가 실패하면 선택 상자까지 사라져(그 vCenter id 는 저장돼 다시 들어와도 같은 곳) 다른 vCenter 로 옮길 수 없었다.

  const r = data?.row || {};
  const vs = veeamStateOf(r.veeamState);
  const days = data?.snapDays || 7;

  return (
    <div data-backup-detail="" style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0, '--bk-head': `${headH}px`, '--bk-bulk': `${bulkH ? bulkH + 8 : 0}px` }}>
      <VeeamHeader active="detail" desc="vCenter 하나를 골라 폴더 › VM 마다 Veeam 백업과 스냅샷 흔적을 봅니다."
        actions={<>
          <label className="muted" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>vCenter
            <Select className="input" value={vcId} onChange={(e) => setVcId(e.target.value)} style={{ minWidth: 200, fontWeight: 700 }}>
              {(vcs || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </Select>
          </label>
          {canCsv() && <button type="button" className="tab" disabled={!vcId || !data} onClick={() => setExportOpen(true)} style={{ padding: '6px 14px' }}
            title="지금 화면의 VM(보기·검색 반영) 또는 고른 폴더를 CSV·엑셀로 — Veeam·스냅샷·백업 표시·메모·태그에서 필요한 항목만 고르고 내 계정에 저장해 둘 수 있습니다">CSV · 엑셀…</button>}
          <button type="button" className="tab" disabled={loading || !vcId} onClick={load} style={{ padding: '6px 14px' }}>{loading ? '읽는 중…' : '새로고침'}</button>
        </>} />
      <div className="flex gap wrap" style={{ alignItems: 'center', rowGap: 6 }}>
        <BackupOptions opts={opts} onChange={changeOpts} disabled={loading} />
        {data && scopeNote(data.scope, data.row) && <span className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere', minWidth: 0 }}>{scopeNote(data.scope, data.row)}</span>}
      </div>
      {exportOpen && data && (
        <VmListExportDialog vcenterId={vcId} vcName={data.vcenter?.name || vcId} vms={vms}
          screenReq={backupScreenRequest(visibleIds, VM_LIST_MAX_IDS)}
          screenText={`지금 화면의 VM(${filterLabel(filter)}${q.trim() ? ' · 검색' : ''})`}
          downloadFailText={downloadFailText} onLegacyCsv={csv} onClose={() => setExportOpen(false)} />
      )}
      {csvErr && <div className="card" style={{ padding: '8px 12px', color: '#fca5a5', fontSize: 12 }}>CSV 내보내기 실패 — {csvErr?.status === 403 ? 'CSV 권한이 없습니다.' : String(csvErr.message || csvErr)}</div>}
      {!data && error && <ErrorBox error={error} />}
      {!data && !error && loading && <Loading />}

      {data && (
        <div className="card" style={{ padding: '14px 16px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px 28px', minWidth: 0 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 800 }}>{data.vcenter?.name}</div>
            <div className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
              Veeam {vs.text}{(data.servers || []).length ? ` · 서버 ${(data.servers || []).map((s) => s.name).join(', ')}` : ''} · 기준 {shortTs(data.at)}{error ? ' · 최근 새로고침 실패 — 이전 값' : ''}
            </div>
          </div>
          <div className="flex wrap" style={{ gap: '10px 24px', marginLeft: 'auto' }}>
            <div><div className="muted" style={{ fontSize: 12 }}>VM</div><div style={{ fontSize: 22, fontWeight: 800 }}>{fmtNum(r.vm)}</div></div>
            <div><div style={{ fontSize: 12, color: '#86efac' }}>Veeam 백업</div><div style={{ fontSize: 22, fontWeight: 800, color: r.veeam == null ? 'var(--text-dim)' : '#4ade80' }}>{fmtNum(r.veeam)}{pctOf(r.veeam, r.vm) != null && <span style={{ fontSize: 13, marginLeft: 6 }}>{pctOf(r.veeam, r.vm)}%</span>}</div></div>
            <div title={r.snap == null ? snapReasonText(r.snapReason) : undefined}><div style={{ fontSize: 12, color: '#d8b4fe' }}>스냅샷 기준</div><div style={{ fontSize: 22, fontWeight: 800, color: r.snap == null ? 'var(--text-dim)' : '#c084fc' }}>{fmtNum(r.snap)}{pctOf(r.snap, r.vm) != null && <span style={{ fontSize: 13, marginLeft: 6 }}>{pctOf(r.snap, r.vm)}%</span>}</div></div>
            <div><div className="muted" style={{ fontSize: 12 }}>확인 안 됨</div><div style={{ fontSize: 22, fontWeight: 800 }}>{r.split ? fmtNum(r.split.none) : '—'}</div></div>
            {/* v2.781(점검 G3 B-B1): 마지막 읽기가 실패·오래된 서버가 있으면(runningStale) 수는 하한 — 0 은 '—', 그 밖은 '≥N'(서머리 표와 같은 runningCell). */}
            <div title={runningCell(r).title}><div style={{ fontSize: 12, color: '#fcd34d' }}>지금 백업 중</div><div style={{ fontSize: 22, fontWeight: 800, color: '#fbbf24' }}>{runningCell(r).text}<span style={{ fontSize: 13, marginLeft: 6 }}>대기 {runningCell({ running: r.pending, runningStale: r.runningStale }).text}</span></div></div>
            <div title={r.rpo?.unknown ? `마지막 백업 시각 모름 ${r.rpo.unknown}대` : undefined}><div style={{ fontSize: 12, color: '#fdba74' }}>오래된 백업({opts.rpoDays}일 초과)</div><div style={{ fontSize: 22, fontWeight: 800, color: r.rpo ? '#fb923c' : 'var(--text-dim)' }}>{fmtNum(r.rpo?.[`d${opts.rpoDays}`])}</div></div>
            <div><div style={{ fontSize: 12, color: '#fca5a5' }}>실패·경고</div><div style={{ fontSize: 22, fontWeight: 800, color: r.results ? '#f87171' : 'var(--text-dim)' }}>{r.results ? `${r.results.failed} · ${r.results.warning}` : '—'}</div></div>
          </div>
          {/* v2.784: 사람이 정한 표시의 수(같은 범위) — 누르면 그 보기 */}
          {/* v2.785(GR R-B2): 표시 파일을 못 읽었으면 수는 '—' — 0 으로 보이면 '표시 없음' 으로 읽힌다 */}
          {marksLine(r.marks, data.marksUnreadable) && (() => { const m = marksLine(r.marks, data.marksUnreadable); return (
            <div data-backup-marks="" className="flex wrap" style={{ flexBasis: '100%', gap: '8px 10px', alignItems: 'center', fontSize: 13, borderTop: '1px solid var(--border-soft)', paddingTop: 10 }}>
              <span className="muted" style={{ fontSize: 12 }}>업무 중요도</span>
              {CRIT.map((c) => <button key={c.key} type="button" className={`tab${filter === `crit-${c.key}` ? ' active' : ''}`} aria-pressed={filter === `crit-${c.key}`} disabled={!!m.unknown} onClick={() => setFilter(filter === `crit-${c.key}` ? 'all' : `crit-${c.key}`)} title={`${c.label} VM 만 보기`} style={{ padding: '3px 10px', display: 'inline-flex', alignItems: 'center', gap: 6 }}><CritIcon crit={c.key} withText plainText={filter === `crit-${c.key}`} /><b style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtNum(m[c.key])}</b></button>)}
              <span style={{ width: 1, height: 20, background: 'var(--border)' }} aria-hidden="true" />
              <button type="button" className={`tab${filter === 'need' ? ' active' : ''}`} aria-pressed={filter === 'need'} disabled={!!m.unknown} onClick={() => setFilter(filter === 'need' ? 'all' : 'need')} style={{ padding: '3px 10px', display: 'inline-flex', alignItems: 'center', gap: 6 }}><NeedIcon /><span style={filter === 'need' ? undefined : { color: NEED_COLOR }}>백업 필요</span><b>{fmtNum(m.need)}</b></button>
              {m.need > 0 && <button type="button" className={`tab${filter === 'needgap' ? ' active' : ''}`} aria-pressed={filter === 'needgap'} onClick={() => setFilter(filter === 'needgap' ? 'all' : 'needgap')} title="백업 필요로 표시했는데 Veeam 백업 대상이 아닌 VM" style={{ padding: '3px 10px', color: m.needGap ? '#fca5a5' : undefined }}>그중 Veeam 백업 안 보임 <b>{m.needGap == null ? '모름' : fmtNum(m.needGap)}</b></button>}
              {/* v2.803 백업 방식(사람이 정한 값) 수 — 누르면 그 VM 만 */}
              <span data-backup-methods="" className="flex wrap" style={{ flexBasis: '100%', gap: '8px 10px', alignItems: 'center' }}>
                <span className="muted" style={{ fontSize: 12 }}>백업 방식</span>
                {METHODS.map((x) => { const k = `method-${x.key}`; const on = filter === k; return <button key={x.key} type="button" className={`tab${on ? ' active' : ''}`} aria-pressed={on} disabled={!!m.unknown} onClick={() => setFilter(on ? 'all' : k)} title={`백업 방식 ${x.text} VM 만 보기`} style={{ padding: '3px 10px', display: 'inline-flex', alignItems: 'center', gap: 6 }}><MethodBadge method={x.key} plain={on} /><b style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtNum(m.method?.[x.key])}</b></button>; })}
                <button type="button" className={`tab${filter === 'method-unset' ? ' active' : ''}`} aria-pressed={filter === 'method-unset'} disabled={!!m.unknown} onClick={() => setFilter(filter === 'method-unset' ? 'all' : 'method-unset')} title="백업 방식을 정하지 않은 VM 만 보기" style={{ padding: '3px 10px' }}>미지정 <b style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtNum(m.method?.unset)}</b></button>
              </span>
            </div>
          ); })()}
          {marksNotice(data) && <div style={{ flexBasis: '100%', fontSize: 12, color: marksNotice(data).tone === 'bad' ? '#fca5a5' : '#fcd34d' }}>{marksNotice(data).text}</div>}
          {/* v2.782(점검 K4 B-B3): 이 vCenter 의 Veeam 서버 중 첫 수집 전·한 번도 읽지 못한 서버가 있으면 맞지 않은 VM 은 '없음' 이 아니라 '모름' — 이유를 밝힌다. */}
          {r.veeam != null && r.veeamAbsentUnknown && <div style={{ flexBasis: '100%', fontSize: 12, color: '#fcd34d' }}>이 vCenter 를 맡은 Veeam 서버 중 아직 첫 수집 전이거나 한 번도 읽지 못한 서버가 있어, 백업 목록에 없는 VM 의 Veeam 칸은 ‘없음’ 이 아니라 ‘모름’ 입니다 — 그 서버를 읽으면 바로잡힙니다.</div>}
          {(r.veeam == null && r.veeamState !== 'unlinked') && <div style={{ flexBasis: '100%', fontSize: 12, color: '#fcd34d' }}>Veeam 쪽을 읽지 못해({vs.text}) VM 의 Veeam 칸은 ‘모름’ 입니다 — 설정 › Veeam 백업 서버에서 상태를 확인하세요. 스냅샷 칸은 그대로 보입니다.</div>}
          {r.snap == null && <div style={{ flexBasis: '100%', fontSize: 12, color: '#fcd34d' }}>스냅샷 기준을 낼 수 없습니다({snapReasonText(r.snapReason) || '모름'}) — VM 의 스냅샷 칸은 지금 임시 스냅샷만 보입니다.</div>}
          {Array.isArray(data.aliasHosts) && data.aliasHosts.length > 0 && <div className="muted" style={{ flexBasis: '100%', fontSize: 12 }}>Veeam 이 이 vCenter 를 {data.aliasHosts.map((h) => `‘${h}’`).join(', ')} 로 적었습니다 — VM 의 moref·이름이 맞아 같은 vCenter 로 맞췄습니다.</div>}
        </div>
      )}

      {data && (<>
      <div className="flex gap wrap" style={{ alignItems: 'center', rowGap: 8 }}>
        <div className="flex gap wrap" role="group" aria-label="보기" style={{ rowGap: 6 }}>
          {FILTERS.map(([k, label]) => <button key={k} type="button" className={`tab${filter === k ? ' active' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)} style={{ padding: '5px 12px', fontSize: 12 }}>{label}{k === 'rpo' ? `(${opts.rpoDays}일)` : ''} {filterCountText(k, counts, marksUnknown)}</button>)}
          {(filter.startsWith('crit-') || filter.startsWith('method-')) && <button type="button" className="tab active" aria-pressed="true" onClick={() => setFilter('all')} title="중요도·백업 방식 보기 끄기" style={{ padding: '5px 12px', fontSize: 12 }}>{filterLabel(filter)} {filterCountText(filter, counts, marksUnknown)} ✕</button>}
        </div>
        <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: '0 1 280px' }}>
          <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>검색</span>
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="VM · 폴더 이름" style={{ flex: 1, minWidth: 0 }} />
        </label>
      </div>

      {writable && (
        <div ref={bulkRef} className="card bk-bulk" data-backup-bulk="" style={{ padding: '8px 12px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px', fontSize: 12, minWidth: 0 }}>
          <b style={{ fontSize: 13 }}>{checked.size ? `${fmtNum(checked.size)}대 선택` : '선택 없음'}</b>
          <button type="button" className="tab" onClick={() => setChecked((cur) => toggleAllVisible(cur, visibleIds))} disabled={!visibleIds.length} style={{ padding: '3px 10px', fontSize: 12 }}>
            {visibleIds.length && visibleIds.every((id) => checked.has(id)) ? '보이는 VM 선택 해제' : `보이는 VM 전체 선택(${fmtNum(visibleIds.length)})`}
          </button>
          <button type="button" className="tab" onClick={() => setChecked((cur) => invertVisible(cur, visibleIds))} disabled={!visibleIds.length} title="보이는 VM 중 고른 것은 풀고 안 고른 것은 고릅니다(필터·검색 밖 VM 의 선택은 그대로)" style={{ padding: '3px 10px', fontSize: 12 }}>선택 반전</button>
          {checked.size > 0 && <button type="button" className="tab" onClick={() => setChecked(new Set())} style={{ padding: '3px 10px', fontSize: 12 }}>선택 해제</button>}
          <span style={{ width: 1, height: 18, background: 'var(--border)' }} aria-hidden="true" />
          {/* v2.803(Chromium 판독): 라벨과 그 버튼을 한 묶음으로 — 줄이 꺾일 때 라벨만 홀로 남지 않게 */}
          <span className="flex" style={{ gap: 6, alignItems: 'flex-start', flexWrap: 'nowrap', minWidth: 0, maxWidth: '100%' }}>
          <span className="muted" style={{ paddingTop: 4, whiteSpace: 'nowrap' }}>중요도</span>
          <span className="flex" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
          {CRIT.map((c) => <button key={c.key} type="button" className="tab" disabled={!checked.size || saving} onClick={() => saveMarks([...checked], { crit: c.key })} style={{ padding: '3px 9px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}><CritIcon crit={c.key} withText /></button>)}
          <button type="button" className="tab" disabled={!checked.size || saving} onClick={() => saveMarks([...checked], { crit: '' })} style={{ padding: '3px 9px', fontSize: 12 }}>지움</button>
          </span></span>
          <span className="flex" style={{ gap: 6, alignItems: 'flex-start', flexWrap: 'nowrap', minWidth: 0, maxWidth: '100%' }}>
          <span className="muted" style={{ paddingTop: 4, whiteSpace: 'nowrap' }}>백업 방식</span>
          <span className="flex" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
          {METHODS.map((x) => <button key={x.key} type="button" className="tab" disabled={!checked.size || saving} onClick={() => saveMarks([...checked], { method: x.key })} style={{ padding: '3px 7px', fontSize: 12 }}><MethodBadge method={x.key} small /></button>)}
          <button type="button" className="tab" disabled={!checked.size || saving} onClick={() => saveMarks([...checked], { method: '' })} style={{ padding: '3px 9px', fontSize: 12 }}>지움</button>
          </span></span>
          <span className="flex" style={{ gap: 6, alignItems: 'flex-start', flexWrap: 'nowrap', minWidth: 0, maxWidth: '100%' }}>
          <span className="muted" style={{ paddingTop: 4, whiteSpace: 'nowrap' }}>백업 필요</span>
          <span className="flex" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
          <button type="button" className="tab" disabled={!checked.size || saving} onClick={() => saveMarks([...checked], { need: true })} style={{ padding: '3px 9px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}><NeedIcon size={13} />표시</button>
          <button type="button" className="tab" disabled={!checked.size || saving} onClick={() => saveMarks([...checked], { need: false })} style={{ padding: '3px 9px', fontSize: 12 }}>해제</button>
          </span></span>
          {saving && <span className="muted">저장 중…</span>}
          {saveErr && <span style={{ color: '#fca5a5', overflowWrap: 'anywhere', minWidth: 0 }}>저장 실패 — {saveErr?.status === 403 ? '수정 권한이 없습니다.' : String(saveErr.message || saveErr)}</span>}
        </div>
      )}

      <div className="flex wrap" style={{ gap: 14, alignItems: 'flex-start' }}>
        <div className="card" style={{ flex: '999 1 640px', minWidth: 0, padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <div role="treegrid" aria-label="폴더 › VM 백업" style={{ minWidth: 790, fontSize: 13 }}>
              <div role="row" style={{ display: 'grid', gridTemplateColumns: GRID, gap: 0, background: 'var(--panel-deep)', color: 'var(--text-dim)', fontSize: 12, fontWeight: 600 }}>
                <div role="columnheader" style={{ padding: '9px 14px' }}>vCenter › 폴더 › VM</div>
                <div role="columnheader" style={{ padding: '9px 6px' }}>전원</div>
                <div role="columnheader" style={{ padding: '9px 6px' }}>백업 <span style={{ fontWeight: 400 }}>(Veeam · 스냅샷)</span></div>
                <div role="columnheader" style={{ padding: '9px 6px' }}>Clone</div>
                <div role="columnheader" style={{ padding: '9px 6px', textAlign: 'right' }}>복원 지점</div>
                <div role="columnheader" style={{ padding: '9px 14px 9px 6px' }}>마지막 백업</div>
              </div>
              {rows.length === 0 && <div className="muted" style={{ padding: '14px' }}>{data ? '조건에 맞는 VM 이 없습니다.' : ''}</div>}
              {rows.map((row) => {
                const pad = 14 + row.depth * 20;
                if (row.kind === 'folder') {
                  const a = row.node.agg;
                  return (
                    <div role="row" key={row.key} aria-expanded={row.open} style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', borderTop: '1px solid var(--border-soft)', background: row.depth === 0 ? 'rgba(59,130,246,.06)' : undefined }}>
                      <div role="gridcell" style={{ minWidth: 0, display: 'flex', alignItems: 'center', paddingLeft: pad }}>
                        {/* v2.812: 폴더 체크 — 그 폴더 아래(하위 폴더 · 접힌 폴더 포함) 보이는 VM 을 모두 고르거나 모두 푼다. 일부만 골랐으면 '－'(indeterminate). */}
                        {writable && (() => {
                          const ids = folderIds.get(row.key) || [];
                          const st = folderCheckState(checked, ids);
                          return <input type="checkbox" aria-label={`${row.node.name} 폴더의 VM ${ids.length}대 ${st === 'all' ? '선택 해제' : '모두 선택'}`} title={`이 폴더 아래 보이는 VM ${fmtNum(ids.length)}대 ${st === 'all' ? '선택 해제' : '모두 선택'}`}
                            checked={st === 'all'} ref={(el) => { if (el) el.indeterminate = st === 'some'; }} disabled={!ids.length}
                            onChange={() => setChecked((cur) => toggleAllVisible(cur, ids))} style={{ width: 15, height: 15, margin: '0 5px 0 0', flex: 'none' }} />;
                        })()}
                        <button type="button" onClick={() => toggle(row.key)} disabled={forceOpen} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, minHeight: 40, padding: '0 8px 0 0', background: 'none', border: 0, color: 'var(--text)', font: 'inherit', cursor: forceOpen ? 'default' : 'pointer', textAlign: 'left' }}>
                          <span className="muted" style={{ width: 12 }}>{row.open ? '▾' : '▸'}</span>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={row.depth === 0 ? '#22d3ee' : '#fbbf24'} strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                          <b title={row.node.name} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.node.name}</b>
                          <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{a.n} VM{forceOpen && row.node.hit !== a.n ? ` · 해당 ${row.node.hit}` : ''}</span>
                        </button>
                      </div>
                      <div role="gridcell" />
                      <div role="gridcell" style={{ padding: '4px 6px', display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                        {r.veeam != null ? <AggBar n={a.veeam} of={a.n} color="#22c55e" /> : <span className="muted" style={{ fontSize: 12 }}>Veeam —</span>}
                        {r.snap != null ? <AggBar n={a.snap} of={a.n} color="#a855f7" /> : <span className="muted" style={{ fontSize: 12 }}>스냅샷 —</span>}
                        {a.run ? <span style={{ color: '#fbbf24', fontWeight: 700, fontSize: 12 }}>백업 중·대기 {a.run}</span> : null}
                      </div>
                      <div role="gridcell" style={{ padding: '0 6px', fontSize: 12 }}>{a.clone ? <span style={{ color: '#67e8f9', fontWeight: 700 }}>Clone {a.clone}</span> : null}</div>
                      <div role="gridcell" />
                      <div role="gridcell" />
                    </div>
                  );
                }
                const vm = row.vm; const bc = backupCell(vm, days); const cc = cloneCell(vm);
                const isSel = sel === vm.id;
                return (
                  <div role="row" key={row.key} aria-selected={isSel} style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', borderTop: '1px solid var(--border-soft)', background: isSel ? 'rgba(59,130,246,.12)' : undefined }}>
                    <div role="gridcell" style={{ minWidth: 0, display: 'flex', alignItems: 'center', paddingLeft: writable ? pad : pad + 20 }}>
                      {/* v2.784: 일괄 적용용 체크(편집 가능할 때만) · 이름 앞 중요도·백업 필요 아이콘(열을 늘리지 않는다 — 1440 폭 유지) */}
                      {writable && <input type="checkbox" aria-label={`${vm.name} 선택`} checked={checked.has(vm.id)} onChange={() => toggleCheck(vm.id)} style={{ width: 15, height: 15, margin: '0 5px 0 0', flex: 'none' }} />}
                      <button type="button" onClick={() => setSel(isSel ? null : vm.id)} title={vm.m?.memo ? `메모: ${vm.m.memo.slice(0, 200)}` : undefined} style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, minHeight: 38, padding: '0 8px 0 0', background: 'none', border: 0, color: 'var(--text)', font: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ color: 'var(--text-dim)', flex: 'none' }}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8" /></svg>
                        <CritIcon crit={vm.m?.crit} size={14} />
                        {vm.m?.need && <NeedIcon size={14} />}
                        <span style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{vm.name}</span>
                        <MethodBadge method={vm.m?.method} small />
                        {vm.m?.memo && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-label="메모 있음" style={{ color: 'var(--text-dim)', flex: 'none' }}><path d="M4 4h16v12H8l-4 4z" /></svg>}
                      </button>
                    </div>
                    <div role="gridcell" style={{ padding: '0 6px', fontSize: 12, color: vm.power === 'POWERED_ON' ? '#86efac' : 'var(--text-dim)' }}>{vm.power === 'POWERED_ON' ? '켜짐' : vm.power ? '꺼짐' : '—'}</div>
                    <div role="gridcell" style={{ padding: '0 6px', minWidth: 0 }} title={bc.src === 'snap' ? 'Veeam 백업이 없어 스냅샷 흔적을 보입니다' : bc.src === 'veeam' ? 'Veeam 백업이 있어 스냅샷 칸은 숨깁니다(오른쪽 상세에 있습니다)' : undefined}><Chip c={bc} /></div>
                    <div role="gridcell" style={{ padding: '0 6px', minWidth: 0 }}>{cc ? <Chip c={cc} /> : <span className="muted">—</span>}</div>
                    <div role="gridcell" style={{ padding: '0 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{vm.v && Number.isFinite(vm.v.rp) && vm.v.rp >= 0 ? vm.v.rp : '—'}</div>
                    <div role="gridcell" style={{ padding: '0 14px 0 6px', fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{shortTs(vm.v?.lb)}</div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="muted" style={{ padding: '8px 14px', fontSize: 12, borderTop: '1px solid var(--border-soft)' }}>폴더 줄의 수 = 그 아래 VM 중 Veeam(위)·스냅샷(아래)이 보이는 수 / 전체 · Clone N = 백업 방식을 Clone 으로 정한 VM 수 · 폴더를 누르면 펼치고 접습니다(검색·보기 필터 중에는 모두 펼침) · VM 을 누르면 오른쪽에 상세</div>
        </div>

        {/* 긴 트리를 내려가도 고른 VM 의 상세가 보이게(넓은 화면) — 좁은 화면에서는 표 아래로 내려간다. v2.810: top 은 .bk-side(일괄 표시 바 아래) */}
        <div className="bk-side" style={{ flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12, alignSelf: 'flex-start' }}>
          <div className="card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
            {!selVm ? <div className="muted" style={{ fontSize: 13 }}>VM 을 누르면 여기에 백업 상세가 보입니다.</div> : (() => {
              const c = vmClass(selVm, vopts); const v = selVm.v;
              return (
                <>
                  <div className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{selVm.folder || '—'}</div>
                  <div style={{ fontSize: 17, fontWeight: 800, overflowWrap: 'anywhere' }}>{selVm.name}</div>
                  <div className="flex gap wrap" style={{ rowGap: 6 }}><Chip c={veeamCell(selVm)} /><Chip c={snapCell(selVm, days)} />{cloneCell(selVm) && <Chip c={cloneCell(selVm)} />}</div>
                  {v && v.state === 'run' && Number.isFinite(v.pg) && (
                    <div>
                      <div className="flex" style={{ justifyContent: 'space-between', fontSize: 12 }}><span>이 VM 진행률</span><b style={{ color: '#fbbf24' }}>{v.pg}%</b></div>
                      <div style={{ height: 7, borderRadius: 4, background: 'var(--panel-deep)', marginTop: 4 }}><div style={{ height: 7, borderRadius: 4, background: '#f59e0b', width: `${v.pg}%` }} /></div>
                    </div>
                  )}
                  <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '6px 12px', fontSize: 13 }}>
                    <dt className="muted">Veeam 작업</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{v?.jobs?.length ? v.jobs.join(', ') : (c.vKnown ? '—' : '모름')}</dd>
                    <dt className="muted">마지막 백업 완료</dt><dd style={{ margin: 0 }}>{shortTs(v?.lb)}{v?.lbSrc === 'rp' ? ' (복원 지점 생성 시각)' : ''}</dd>
                    <dt className="muted">마지막 결과</dt><dd style={{ margin: 0, overflowWrap: 'anywhere', color: c.fail ? '#fca5a5' : undefined }}>{v?.lr ? `이 VM ${v.lr}${v.lastResult && v.lastResult !== v.lr ? ` · 작업 ${v.lastResult}` : ''}` : (v?.lastResult ? `작업 ${v.lastResult}` : '—')}</dd>
                    {c.old && <><dt className="muted">오래된 백업</dt><dd style={{ margin: 0, color: '#fdba74' }}>마지막 백업이 {opts.rpoDays}일을 넘었습니다</dd></>}
                    <dt className="muted">복원 지점</dt><dd style={{ margin: 0 }}>{v && Number.isFinite(v.rp) && v.rp >= 0 ? `${v.rp}개` : v?.rp === -1 ? '있음(개수 모름)' : '—'}</dd>
                    <dt className="muted">스냅샷 흔적</dt><dd style={{ margin: 0 }}>{selVm.s?.ev ? `최근 ${days}일 ${selVm.s.ev.n ?? '?'}회 · 마지막 ${shortTs(selVm.s.ev.ts)}` : ('ev' in (selVm.s || {}) ? '없음' : '모름')}</dd>
                    <dt className="muted">지금 스냅샷</dt><dd style={{ margin: 0 }}>{selVm.s?.now ? `${selVm.s.now.n}개 · 생성 ${shortTs(selVm.s.now.ts)}${selVm.s.now.stale ? ' — 하루 넘게 남음(정리 실패 의심)' : ''}` : '없음'}</dd>
                    {cloneCell(selVm) && <><dt className="muted" style={{ color: '#67e8f9' }}>복제 잡</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{cloneCell(selVm).text.replace(/^Clone ?·? ?/, '') || '—'}</dd></>}
                  </dl>
                  {/* v2.784: 백업 표시 — 편집 가능하면 바로 저장(중요도·백업 필요), 메모는 저장 버튼 */}
                  <div data-backup-mark-edit="" style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
                    <b style={{ fontSize: 13 }}>백업 표시</b>
                    <div className="flex" style={{ gap: 6, alignItems: 'flex-start' }}>
                      <span className="muted" style={{ fontSize: 12, minWidth: 56, paddingTop: 4 }}>업무 중요도</span>
                      <span className="flex wrap" style={{ gap: 6, alignItems: 'center', flex: '1 1 0', minWidth: 0 }}>{/* v2.803: 버튼이 꺾여도 라벨 칸 아래로 내려가지 않게 */}
                      {writable ? [...CRIT, { key: '', text: '없음' }].map((c) => {
                        const on = (selVm.m?.crit || '') === c.key;
                        return <button key={c.key || 'none'} type="button" className={`tab${on ? ' active' : ''}`} aria-pressed={on} disabled={saving} onClick={() => !on && saveMarks([selVm.id], { crit: c.key })} style={{ padding: '3px 9px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>{c.key ? <CritIcon crit={c.key} withText plainText={on} /> : '없음'}</button>;
                      }) : (critOf(selVm.m?.crit) ? <CritIcon crit={selVm.m.crit} withText /> : <span className="muted">—</span>)}
                      </span>
                    </div>
                    {/* v2.803 백업 방식(사람이 정한 값) — 업무 중요도 다음 */}
                    <div className="flex" style={{ gap: 6, alignItems: 'flex-start' }} data-backup-method-edit="">
                      <span className="muted" style={{ fontSize: 12, minWidth: 56, paddingTop: 4 }}>백업 방식</span>
                      <span className="flex wrap" style={{ gap: 6, alignItems: 'center', flex: '1 1 0', minWidth: 0 }}>
                      {writable ? [...METHODS, { key: '', text: '없음' }].map((x) => {
                        const on = (selVm.m?.method || '') === x.key;
                        return <button key={x.key || 'none'} type="button" className={`tab${on ? ' active' : ''}`} aria-pressed={on} disabled={saving} onClick={() => !on && saveMarks([selVm.id], { method: x.key })} title={x.key ? `단축키 ${Object.entries(METHOD_KEYS_MAP).find(([, v]) => v === x.key)?.[0]?.toUpperCase()}` : undefined} style={{ padding: '3px 7px', fontSize: 12, display: 'inline-flex', alignItems: 'center' }}>{x.key ? <MethodBadge method={x.key} plain={on} small /> : '없음'}</button>;
                      }) : (methodOf(selVm.m?.method) ? <MethodBadge method={selVm.m.method} /> : <span className="muted">—</span>)}
                      </span>
                    </div>
                    {writable && <span className="muted" data-method-keys="" style={{ fontSize: 11.5, paddingLeft: 62 }}>단축키 V Veeam · C Clone · G Config 백업 · N 백업 안함</span>}
                    <div className="flex wrap" style={{ gap: 6, alignItems: 'center' }}>
                      <span className="muted" style={{ fontSize: 12, minWidth: 56 }}>백업 필요</span>
                      {writable ? (
                        <button type="button" className={`tab${selVm.m?.need ? ' active' : ''}`} aria-pressed={!!selVm.m?.need} disabled={saving} onClick={() => saveMarks([selVm.id], { need: !selVm.m?.need })} style={{ padding: '3px 10px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}><NeedIcon size={13} />{selVm.m?.need ? '표시됨 — 누르면 해제' : '표시'}</button>
                      ) : (selVm.m?.need ? <span className="flex" style={{ gap: 4, alignItems: 'center' }}><NeedIcon size={13} />표시됨</span> : <span className="muted">—</span>)}
                      {selVm.m?.need && c.vKnown && !c.veeam && c.method !== 'none' && c.method !== 'clone' && <span style={{ fontSize: 12, color: '#fca5a5' }}>Veeam 백업 대상이 아닙니다</span>}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span className="muted" style={{ fontSize: 12 }} id="backup-memo-label">백업 메모</span>
                      {writable ? (
                        <>
                          <textarea className="input" aria-labelledby="backup-memo-label" value={memo} maxLength={MEMO_MAX} rows={4} onChange={(e) => setMemo(e.target.value)} placeholder="예: 매일 22시 전체 백업 필요 · 담당자 · 복원 절차" style={{ minWidth: 0, width: '100%', resize: 'vertical', fontSize: 13 }} />
                          <span className="flex" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                            <span className="muted" style={{ fontSize: 11 }}>{memo.length}/{MEMO_MAX}</span>
                            <button type="button" className="tab" disabled={saving || memo === (selVm.m?.memo || '')} onClick={() => saveMarks([selVm.id], { memo })} style={{ padding: '3px 12px', fontSize: 12 }}>{saving ? '저장 중…' : '메모 저장'}</button>
                          </span>
                        </>
                      ) : <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{selVm.m?.memo || <span className="muted">—</span>}</span>}
                    </div>
                    {selVm.m?.at && <span className="muted" style={{ fontSize: 11 }}>마지막 수정 {selVm.m.by || '—'} · {shortTs(Date.parse(selVm.m.at))}</span>}
                    {saveErr && <span style={{ fontSize: 12, color: '#fca5a5', overflowWrap: 'anywhere' }}>저장 실패 — {saveErr?.status === 403 ? '수정 권한이 없습니다.' : String(saveErr.message || saveErr)}</span>}
                  </div>
                </>
              );
            })()}
          </div>
          <div className="card" style={{ padding: '12px 14px', fontSize: 12, lineHeight: 1.7 }}>
            <b style={{ display: 'block', marginBottom: 2 }}>칸 읽는 법</b>
            <div><b style={{ color: '#86efac' }}>Veeam 월-일 시:분</b> 백업 대상 · 마지막 완료 시각</div>
            <div><b style={{ color: '#fcd34d' }}>백업 중 N%</b> 그 VM 의 진행률 · <b style={{ color: '#93c5fd' }}>대기</b> 차례 기다림</div>
            <div><b style={{ color: '#d8b4fe' }}>{days}일 N회</b> Veeam 이 없는 VM 의 스냅샷 흔적(Veeam 이 있으면 숨김) · <b style={{ color: '#fca5a5' }}>잔존</b> 하루 넘게 남은 임시 스냅샷</div>
            <div><b style={{ color: '#67e8f9' }}>Clone 월-일 시:분</b> 백업 방식이 Clone 인 VM 의 포탈 복제 잡 마지막 실행(실패 빨강 · <b style={{ color: '#67e8f9' }}>잡 없음</b> = 복제 잡이 없음 · 모름 = 실행 노드 보고 없음)</div>
            <div className="flex" style={{ gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>{METHODS.map((x) => <MethodBadge key={x.key} method={x.key} small />)} 백업 방식(사람이 정한 값)</div>
            <div className="flex" style={{ gap: 4, alignItems: 'center', flexWrap: 'wrap' }}><CritIcon crit="high" size={13} /><CritIcon crit="mid" size={13} /><CritIcon crit="low" size={13} /> 업무 중요도 상·중·하 · <NeedIcon size={13} /> 백업 필요(사람이 정한 표시)</div>
            <div className="muted">— 는 없음, ‘모름’ 은 그쪽을 읽지 못함(백업 안 됨이 아님)</div>
          </div>
        </div>
      </div>
      </>)}
    </div>
  );
}
