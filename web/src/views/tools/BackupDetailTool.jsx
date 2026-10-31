/**
 * 백업 세부내용 — 특수 기능 `backup-detail`(v2.779, 사용자 요청 '1개 vcenter 를 선택하면 VM 백업 전체 현황 · veeam 백업과 snapshot 둘다' +
 *   시안: vCenter › 폴더 › 하위 폴더 › VM 표). 메뉴: 서버 › Veeam → 화면 위 Summary | Detail 탭(v2.787 — 예전 'Veeam 현황 › Detail' · 도구 키 그대로). 값은 서버(GET /api/tools/backup-detail — veeam/backupStatus.js).
 * ⚠ 폴링하지 않는다(vCenter 를 고를 때·새로고침 · 서버 60초 캐시) · 늦게 온 이전 응답은 버린다 · 훅은 전부 조기 return 위.
 * ⚠ VM 의 Veeam 키가 없으면 '모름'(서버가 못 읽음), null 이면 '없음' — 둘을 섞지 않는다.
 * v2.835(사용자 요청 '백업 메뉴 개편 1차' + 시안 ②): 백업 정책(사람이 정한 값 — Veeam · Bareos · SSH · 백업 안함 · 확인 필요)과 실제 백업(포탈이 읽은
 *   Veeam 대조 · Bareos 잡)을 다른 열로 · 정책≠실제 · RPO · 마지막 성공 · 다음 예정 · 최근 24시간 실패 · 백업 안 된 VM 찾기. 판정은 서버(veeam/backupPolicy.js)가
 *   행에 실은 필드(p · a · mm · lok · e · nx)이고 화면은 그리며 창(N 일) 비교만 한다. 스냅샷·Clone 문구와 기능은 이 화면에서 뺐다(사용자 요청 — 서버 값·내보내기는 그대로).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, downloadFile, canCsv, putJson, hasRole, toolAllowed } from '../../api.js';
import { saveHandoff } from './backupRunText.js';   // v2.818 고른 VM 을 '백업 실행' 탭으로 넘긴다
import { Loading, ErrorBox } from '../../components/ui.jsx';
import Select from '../../components/Select.jsx';
import { fmtNum, pctOf, veeamStateOf, filterCounts, buildTree, flattenTree, initialOpen, veeamCell, shortTs, vmClass, loadOpts, saveOpts, scopeQuery, scopeNote, runningCell, CRIT, critOf, MEMO_MAX, marksLine, marksNotice, filterCountText, detailLoadKey, toggleAllVisible, invertVisible, visibleVmIds, folderVmIdMap, folderCheckState, filterLabel, methodOf, bareosCell, methodKeyOf, METHOD_KEYS_MAP, fmtGb, NOT_VEEAM_GAP,
  POLICIES, CHIP_GROUPS, rpoCell, mismatchCell, lastOkText, nextText, nextOf, errText, policyGbTotals, folderRpoPct, saveBareosGroupHandoff } from './backupViewText.js';
import StaleFinder from './BackupStaleFinder.jsx';   // v2.835 백업 안 된 VM 찾기
import { CritIcon, NeedIcon, NEED_COLOR, MethodBadge } from './BackupMarkIcons.jsx';
import BackupOptions from './BackupOptions.jsx';
import { saveBareosHandoff, HANDOFF_MAX as BAREOS_HANDOFF_MAX, lvText } from './bareosViewText.js';
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
  // v2.828 Bareos 칸(주황 — 백업 방식 칩과 같은 계열)
  bareos: { color: '#fdba74', background: 'rgba(251,146,60,.14)' },
  bareosWarn: { color: '#fcd34d', background: 'rgba(245,158,11,.16)' },
  bareosBad: { color: '#fca5a5', background: 'rgba(239,68,68,.14)' },
  bareosNone: { color: '#fdba74', background: 'transparent', border: '1px dashed rgba(251,146,60,.55)' },
  // v2.835 정책≠실제 · RPO 칸
  bad: { color: '#fca5a5', background: 'rgba(239,68,68,.14)' },
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
// v2.814: 전원 다음 '용량'(디스크 사용 GB) 열
// v2.835(시안 ②): 폴더›VM · 전원 · 용량 · 백업 정책 · 실제 백업 · 정책≠실제 · RPO · 복원 지점 · 마지막 성공·다음 예정 · 최근 실패(24h).
//   옆 상세 칸은 VM 을 골랐을 때만 연다 — 고르지 않으면 표가 1440 본문을 다 쓴다(열 11개가 가로 스크롤 없이 들어간다)
//   Chromium 판독(1440 · 상세 칸 열림): VM 이름이 잘려 이름 칸을 넓히고 '복원 지점' 머리가 두 줄이라 그 칸도 넓혔다 — 최소 칸 합 1074
const GRID = 'minmax(230px, 2fr) 46px 74px minmax(150px, 1.2fr) minmax(150px, 1.2fr) 86px 86px 58px minmax(118px, 1fr) 76px';
const GRID_MIN = 1080;
/** 폴더 막대 한 줄 — 'n/전체' + 막대 + 이름(색만으로 구분하지 않게 글자도). */
function PolBar({ n, of, color, label }) {
  const p = pctOf(n, of) || 0;
  return (
    <div className="flex gap" style={{ alignItems: 'center', minWidth: 0, gap: 6 }}>
      <span style={{ fontWeight: 700, color, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', minWidth: 46, fontSize: 12 }}>{n}/{of}</span>
      <div style={{ flex: 1, minWidth: 24, height: 5, borderRadius: 3, background: 'var(--panel-deep)' }}><div style={{ height: 5, borderRadius: 3, background: color, width: `${n > 0 ? Math.max(2, p) : 0}%` }} /></div>
      <span style={{ color, fontSize: 11, whiteSpace: 'nowrap' }}>{label}</span>
    </div>
  );
}
/** 정책 아이콘(선 그림 — 색과 글자를 함께 쓴다). 모양은 표로(조기 return 이 없게 — 화면 테스트의 '훅은 조기 return 위' 판정). */
const POLICY_SHAPES = {
  veeam: <circle cx="8" cy="8" r="6" />,
  bareos: <rect x="2.5" y="2.5" width="11" height="11" rx="2" />,
  ssh: <path d="M3 4l4 4-4 4M8 12h5" />,
  none: <><circle cx="8" cy="8" r="6" /><path d="M4 12L12 4" /></>,
  check: <><circle cx="8" cy="8" r="6" /><path d="M6.3 6.5a1.7 1.7 0 1 1 2.4 1.6c-.5.3-.7.6-.7 1.1M8 11.3v.2" /></>,
};
function PolicyIcon({ k, size = 13 }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{POLICY_SHAPES[k] || POLICY_SHAPES.check}</svg>;
}
const POLICY_SHORT = Object.fromEntries(Object.entries(METHOD_KEYS_MAP).map(([key, v]) => [v, key.toUpperCase()]));
const ACT_COLOR = { v: '#86efac', b: '#fdba74', none: '#94a3b8', unk: 'var(--text-dim)' };

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
  const gbTot = useMemo(() => policyGbTotals(vms, { marksUnreadable: marksUnknown }), [vms, marksUnknown]);   // v2.814 · v2.835 백업 정책별 용량 합
  const bareosUnknown = !!data?.bareosUnreadable;
  const veeamUnknown = !!data && data.row?.veeam == null && data.row?.veeamState !== 'unlinked';   // Veeam 을 읽지 못함 — 실제 Veeam 수는 '—'
  const cnt = (k) => filterCountText(k, counts, marksUnknown, bareosUnknown, veeamUnknown);
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
      if (selVm.p !== method || (selVm.m?.method || '') !== method) saveMarks([selVm.id], { method });
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

  return (
    <div data-backup-detail="" style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0, '--bk-head': `${headH}px`, '--bk-bulk': `${bulkH ? bulkH + 8 : 0}px` }}>
      <VeeamHeader active="detail" desc="법인(vCenter) 하나 — 폴더 › VM 마다 백업 정책(사람이 정한 값)과 실제 백업(Veeam · Bareos)을 나란히 봅니다."
        actions={<>
          <label className="muted" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>법인(vCenter)
            <Select className="input" value={vcId} onChange={(e) => setVcId(e.target.value)} style={{ minWidth: 200, fontWeight: 700 }}>
              {(vcs || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </Select>
          </label>
          {canCsv() && <button type="button" className="tab" disabled={!vcId || !data} onClick={() => setExportOpen(true)} style={{ padding: '6px 14px' }}
            title="지금 화면의 VM(보기·검색 반영) 또는 고른 폴더를 CSV·엑셀로 — Veeam·백업 표시·메모·태그에서 필요한 항목만 고르고 내 계정에 저장해 둘 수 있습니다">CSV · 엑셀…</button>}
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
              Veeam {vs.text}{(data.servers || []).length ? ` · 서버 ${(data.servers || []).map((x) => x.name).join(', ')}` : ''} · Bareos 원장 {bareosUnknown ? '못 읽음' : '읽음'} · 기준 {shortTs(data.at)}{error ? ' · 최근 새로고침 실패 — 이전 값' : ''}
            </div>
          </div>
          <div className="flex wrap" style={{ gap: '10px 24px', marginLeft: 'auto' }}>
            <Kpi label="VM" value={fmtNum(r.vm)} />
            <Kpi label="실제 Veeam" color="#86efac" value={fmtNum(cnt('act-veeam'))} onClick={() => setFilter(filter === 'act-veeam' ? 'all' : 'act-veeam')} on={filter === 'act-veeam'} />
            <Kpi label="실제 Bareos" color="#fdba74" value={fmtNum(cnt('act-bareos'))} onClick={() => setFilter(filter === 'act-bareos' ? 'all' : 'act-bareos')} on={filter === 'act-bareos'} />
            <Kpi label="실제 백업 없음" value={fmtNum(cnt('act-none'))} onClick={() => setFilter(filter === 'act-none' ? 'all' : 'act-none')} on={filter === 'act-none'} />
            <Kpi label="정책≠실제" color="#fca5a5" value={fmtNum(cnt('mismatch'))} onClick={() => setFilter(filter === 'mismatch' ? 'all' : 'mismatch')} on={filter === 'mismatch'} />
            {/* v2.781(점검 G3 B-B1): 마지막 읽기가 실패·오래된 서버가 있으면(runningStale) 수는 하한 — 0 은 '—', 그 밖은 '≥N'(서머리 표와 같은 runningCell). */}
            <div title={runningCell(r).title}><div style={{ fontSize: 12, color: '#fcd34d' }}>지금 백업 중</div><div style={{ fontSize: 22, fontWeight: 800, color: '#fbbf24' }}>{runningCell(r).text}<span style={{ fontSize: 13, marginLeft: 6 }}>대기 {runningCell({ running: r.pending, runningStale: r.runningStale }).text}</span></div></div>
            <Kpi label={`RPO 미달(${opts.rpoDays}일)`} color="#fdba74" value={fmtNum(cnt('rpo-miss'))} onClick={() => setFilter(filter === 'rpo-miss' ? 'all' : 'rpo-miss')} on={filter === 'rpo-miss'} />
            <div><div style={{ fontSize: 12, color: '#fca5a5' }}>실패·경고(Veeam)</div><div style={{ fontSize: 22, fontWeight: 800, color: r.results ? '#f87171' : 'var(--text-dim)' }}>{r.results ? `${r.results.failed} · ${r.results.warning}` : '—'}</div></div>
          </div>
          {/* v2.784: 사람이 정한 표시의 수(같은 범위) — 누르면 그 보기 · v2.785(GR R-B2): 표시 파일을 못 읽었으면 수는 '—' */}
          {marksLine(r.marks, data.marksUnreadable) && (() => { const m = marksLine(r.marks, data.marksUnreadable); return (
            <div data-backup-marks="" className="flex wrap" style={{ flexBasis: '100%', gap: '8px 10px', alignItems: 'center', fontSize: 13, borderTop: '1px solid var(--border-soft)', paddingTop: 10 }}>
              <span className="muted" style={{ fontSize: 12 }}>업무 중요도</span>
              {CRIT.map((c) => <button key={c.key} type="button" className={`tab${filter === `crit-${c.key}` ? ' active' : ''}`} aria-pressed={filter === `crit-${c.key}`} disabled={!!m.unknown} onClick={() => setFilter(filter === `crit-${c.key}` ? 'all' : `crit-${c.key}`)} title={`${c.label} VM 만 보기`} style={{ padding: '3px 10px', display: 'inline-flex', alignItems: 'center', gap: 6 }}><CritIcon crit={c.key} withText plainText={filter === `crit-${c.key}`} /><b style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtNum(m[c.key])}</b></button>)}
              <span style={{ width: 1, height: 20, background: 'var(--border)' }} aria-hidden="true" />
              <button type="button" className={`tab${filter === 'need' ? ' active' : ''}`} aria-pressed={filter === 'need'} disabled={!!m.unknown} onClick={() => setFilter(filter === 'need' ? 'all' : 'need')} style={{ padding: '3px 10px', display: 'inline-flex', alignItems: 'center', gap: 6 }}><NeedIcon /><span style={filter === 'need' ? undefined : { color: NEED_COLOR }}>백업 필요</span><b>{fmtNum(m.need)}</b></button>
              {m.need > 0 && <button type="button" className={`tab${filter === 'needgap' ? ' active' : ''}`} aria-pressed={filter === 'needgap'} onClick={() => setFilter(filter === 'needgap' ? 'all' : 'needgap')} title="백업 필요로 표시했는데 Veeam 백업 대상이 아닌 VM" style={{ padding: '3px 10px', color: m.needGap ? '#fca5a5' : undefined }}>그중 Veeam 백업 안 보임 <b>{m.needGap == null ? '모름' : fmtNum(m.needGap)}</b></button>}
              {/* v2.835 백업 정책 5범주 수(정하지 않음·예전 값은 '확인 필요') — 누르면 그 VM 만 */}
              <span data-backup-policies="" className="flex wrap" style={{ flexBasis: '100%', gap: '8px 10px', alignItems: 'center' }}>
                <span className="muted" style={{ fontSize: 12 }}>백업 정책</span>
                {POLICIES.map((x) => { const k = `policy-${x.key}`; const on = filter === k; return <button key={x.key} type="button" className={`tab${on ? ' active' : ''}`} aria-pressed={on} disabled={!!m.unknown} onClick={() => setFilter(on ? 'all' : k)} title={`백업 정책 ${x.text} VM 만 보기`} style={{ padding: '3px 10px', display: 'inline-flex', alignItems: 'center', gap: 6 }}><MethodBadge method={x.key} plain={on} /><b style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtNum(cnt(k))}</b></button>; })}
              </span>
            </div>
          ); })()}
          {/* v2.814 디스크 용량 합(이 vCenter 전체 — 보기 필터와 무관) · v2.835 백업 정책별(0 은 생략) · 용량을 모르는 VM 은 따로 센다 */}
          {vms.length > 0 && (
            <div data-backup-capacity="" className="flex wrap" style={{ flexBasis: '100%', gap: '6px 12px', alignItems: 'center', fontSize: 13 }}>
              <span className="muted" style={{ fontSize: 12 }}>용량 합계</span>
              <b style={{ fontVariantNumeric: 'tabular-nums' }} title="VM 스토리지 사용(GB, vCenter 인벤토리)의 합">{fmtGb(gbTot.all)}</b>
              {POLICIES.filter((x) => gbTot[x.key] > 0).map((x) => <span key={x.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><MethodBadge method={x.key} small /><span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtGb(gbTot[x.key])}</span></span>)}
              {gbTot.unknown > 0 && <span className="muted" title="인벤토리에 디스크 용량이 없는 VM — 합계에 넣지 않았습니다">용량 모름 {fmtNum(gbTot.unknown)}대</span>}
            </div>
          )}
          {marksNotice(data) && <div style={{ flexBasis: '100%', fontSize: 12, color: marksNotice(data).tone === 'bad' ? '#fca5a5' : '#fcd34d' }}>{marksNotice(data).text}</div>}
          {/* v2.782(점검 K4 B-B3): 이 vCenter 의 Veeam 서버 중 첫 수집 전·한 번도 읽지 못한 서버가 있으면 맞지 않은 VM 은 '없음' 이 아니라 '모름' — 이유를 밝힌다. */}
          {r.veeam != null && r.veeamAbsentUnknown && <div style={{ flexBasis: '100%', fontSize: 12, color: '#fcd34d' }}>이 vCenter 를 맡은 Veeam 서버 중 아직 첫 수집 전이거나 한 번도 읽지 못한 서버가 있어, 백업 목록에 없는 VM 의 Veeam 칸은 ‘없음’ 이 아니라 ‘모름’ 입니다 — 그 서버를 읽으면 바로잡힙니다.</div>}
          {veeamUnknown && <div style={{ flexBasis: '100%', fontSize: 12, color: '#fcd34d' }}>Veeam 쪽을 읽지 못해({vs.text}) 실제 백업의 Veeam 칸·정책≠실제·RPO 는 ‘모름’ 입니다 — 설정 › Veeam 백업 서버에서 상태를 확인하세요.</div>}
          {bareosUnknown && <div style={{ flexBasis: '100%', fontSize: 12, color: '#fcd34d' }}>Bareos 원장을 읽지 못해 실제 백업의 Bareos 칸·정책≠실제·RPO 는 ‘모름’ 입니다(0 이 아님) — Bareos › 설정에서 원장 상태를 확인하세요.</div>}
          {Array.isArray(data.aliasHosts) && data.aliasHosts.length > 0 && <div className="muted" style={{ flexBasis: '100%', fontSize: 12 }}>Veeam 이 이 vCenter 를 {data.aliasHosts.map((h) => `‘${h}’`).join(', ')} 로 적었습니다 — VM 의 moref·이름이 맞아 같은 vCenter 로 맞췄습니다.</div>}
        </div>
      )}

      {data && (<>
      {/* v2.835 백업 안 된 VM 찾기(사용자 요청 '지정한 시간만큼 백업되지 않은 VM') — 고른 VM 은 아래 도구 줄(정책·등록)로 이어진다 */}
      <StaleFinder vms={vms} now={now} checked={checked} setChecked={setChecked} writable={writable} onOpen={(id) => setSel(id)} />

      {/* v2.835 도구 줄(시안 ② — 선택·중요도 → 백업 정책 → 백업 방식(실제) 거르기 → 백업 등록). 편집 가능하면 스크롤해도 머리 아래에 붙는다(v2.810). */}
      <div ref={writable ? bulkRef : undefined} className={`card${writable ? ' bk-bulk' : ''}`} data-backup-bulk="" style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12, minWidth: 0 }}>
        {writable && (
          <div className="flex wrap" style={{ alignItems: 'center', gap: '6px 10px' }}>
            <b style={{ fontSize: 13 }}>{checked.size ? `${fmtNum(checked.size)}대 선택` : '선택 없음'}</b>
            <button type="button" className="tab" onClick={() => setChecked((cur) => toggleAllVisible(cur, visibleIds))} disabled={!visibleIds.length} style={{ padding: '3px 10px', fontSize: 12 }}>
              {visibleIds.length && visibleIds.every((id) => checked.has(id)) ? '보이는 VM 선택 해제' : `보이는 VM 전체 선택(${fmtNum(visibleIds.length)})`}
            </button>
            <button type="button" className="tab" onClick={() => setChecked((cur) => invertVisible(cur, visibleIds))} disabled={!visibleIds.length} title="보이는 VM 중 고른 것은 풀고 안 고른 것은 고릅니다(필터·검색 밖 VM 의 선택은 그대로)" style={{ padding: '3px 10px', fontSize: 12 }}>선택 반전</button>
            {checked.size > 0 && <button type="button" className="tab" onClick={() => setChecked(new Set())} style={{ padding: '3px 10px', fontSize: 12 }}>선택 해제</button>}
            <span style={{ width: 1, height: 18, background: 'var(--border)' }} aria-hidden="true" />
            {/* v2.803(Chromium 판독): 라벨과 그 버튼을 한 묶음으로 — 줄이 꺾일 때 라벨만 홀로 남지 않게 */}
            <span className="flex" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0, maxWidth: '100%' }}>
              <span className="muted" style={{ whiteSpace: 'nowrap' }}>중요도</span>
              {CRIT.map((c) => <button key={c.key} type="button" className="tab" disabled={!checked.size || saving} onClick={() => saveMarks([...checked], { crit: c.key })} style={{ padding: '3px 9px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}><CritIcon crit={c.key} withText /></button>)}
              <button type="button" className="tab" disabled={!checked.size || saving} onClick={() => saveMarks([...checked], { crit: '' })} style={{ padding: '3px 9px', fontSize: 12 }}>지움</button>
            </span>
            <span className="flex" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0, maxWidth: '100%' }}>
              <span className="muted" style={{ whiteSpace: 'nowrap' }}>백업 필요</span>
              <button type="button" className="tab" disabled={!checked.size || saving} onClick={() => saveMarks([...checked], { need: true })} style={{ padding: '3px 9px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}><NeedIcon size={13} />표시</button>
              <button type="button" className="tab" disabled={!checked.size || saving} onClick={() => saveMarks([...checked], { need: false })} style={{ padding: '3px 9px', fontSize: 12 }}>해제</button>
            </span>
          </div>
        )}
        {writable && (
          <div role="group" aria-label="백업 정책 적용" data-backup-policy-bar="" className="flex wrap" style={{ alignItems: 'center', gap: '6px 8px', padding: '7px 10px', border: '1px solid rgba(34,211,238,.45)', borderRadius: 10, background: 'rgba(34,211,238,.06)' }}>
            <b style={{ color: '#67e8f9', fontSize: 12.5 }}>백업 정책</b>
            <span className="muted">{checked.size ? `고른 VM ${fmtNum(checked.size)}대에 — 누르면 바로 저장` : 'VM 을 고르거나(체크·폴더 체크) 표에서 VM 을 누른 뒤'}</span>
            {POLICIES.map((x) => (
              <button key={x.key} type="button" className="tab" disabled={!checked.size || saving} onClick={() => saveMarks([...checked], { method: x.key })} aria-label={`고른 VM 의 백업 정책을 ${x.text} 으로`}
                title={`단축키 ${POLICY_SHORT[x.key] || ''}(VM 하나를 눌러 고른 상태)`} style={{ padding: '3px 10px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, color: x.color, borderColor: x.color }}>
                <PolicyIcon k={x.key} />{x.text}
              </button>
            ))}
            <span className="muted" style={{ marginLeft: 'auto', fontSize: 11.5 }}>단축키 V · B · S · N · K</span>
          </div>
        )}
        <div className="flex wrap" role="group" aria-label="보기" style={{ alignItems: 'center', gap: '6px 8px' }}>
          <span className="muted" style={{ whiteSpace: 'nowrap' }}>백업 방식(실제로 도는 백업) 거르기</span>
          {CHIP_GROUPS.map(([label, keys], gi) => (
            <span key={label} className="flex wrap" style={{ gap: 6, alignItems: 'center', minWidth: 0 }}>
              {gi > 0 && <span style={{ width: 1, height: 18, background: 'var(--border)' }} aria-hidden="true" />}
              {gi > 0 && <span className="muted" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>{label}</span>}
              {keys.map((k) => <button key={k} type="button" className={`tab${filter === k ? ' active' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(filter === k && k !== 'all' ? 'all' : k)} style={{ padding: '4px 11px', fontSize: 12 }}>{filterLabel(k)}{k === 'rpo-miss' ? `(${opts.rpoDays}일)` : ''} {cnt(k)}</button>)}
            </span>
          ))}
          {(filter.startsWith('crit-') || filter.startsWith('policy-')) && filter !== 'policy-check' && <button type="button" className="tab active" aria-pressed="true" onClick={() => setFilter('all')} title="중요도·백업 정책 보기 끄기" style={{ padding: '4px 11px', fontSize: 12 }}>{filterLabel(filter)} {cnt(filter)} ✕</button>}
          <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: '0 1 260px' }}>
            <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>검색</span>
            <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="VM · 폴더 이름" style={{ flex: 1, minWidth: 0 }} />
          </label>
        </div>
        {writable && (hasRole('admin') && (toolAllowed('backup-run') || toolAllowed('bareos-backup'))) && (
          <div className="flex wrap" role="group" aria-label="백업 등록" data-backup-register="" style={{ alignItems: 'center', gap: '6px 10px' }}>
            <span className="muted" style={{ whiteSpace: 'nowrap' }}>백업 등록</span>
            {/* v2.818: 고른 VM 을 백업 실행 탭으로(관리자 — 실행은 그 화면에서 미리보기·OTP 를 거친다) */}
            {toolAllowed('backup-run') && <button type="button" className="tab" disabled={!checked.size} onClick={() => { saveHandoff(vcId, [...checked]); window.location.hash = '#/tools/backup-run'; }} title="고른 VM 을 백업 실행 화면으로 가져갑니다 — 거기서 미리보기·OTP 확인 뒤 Veeam 으로 보냅니다" style={{ padding: '3px 10px', fontSize: 12, color: '#86efac' }}>Veeam 백업 실행 →</button>}
            <button type="button" className="tab" disabled title="SSH 백업 기능은 아직 없습니다 — 지금은 백업 정책 값(SSH)만 정할 수 있습니다" style={{ padding: '3px 10px', fontSize: 12, color: '#93c5fd' }}>SSH 스크립트 등록(준비 중)</button>
            {/* v2.828: 고른 VM 을 Bareos 백업 대상 추가 창으로(관리자 — 등록은 그 화면에서. 200대까지 — 넘으면 앞 200대이고 그렇다고 말한다) */}
            {toolAllowed('bareos-backup') && (
              <button type="button" className="tab" disabled={!checked.size} onClick={() => { saveBareosHandoff(vcId, [...checked]); window.location.hash = '#/tools/bareos-backup/targets'; }}
                title={`고른 VM 을 Bareos 백업 대상 추가 창으로 가져갑니다 — 거기서 레벨을 고르고 등록합니다${checked.size > BAREOS_HANDOFF_MAX ? `(앞 ${BAREOS_HANDOFF_MAX}대만)` : ''}`} style={{ padding: '3px 10px', fontSize: 12, color: '#fdba74' }}>
                Bareos 대상 등록{checked.size > BAREOS_HANDOFF_MAX ? `(앞 ${BAREOS_HANDOFF_MAX}대)` : ''} →
              </button>
            )}
            {/* v2.835: 고른 VM 을 Bareos › 백업 그룹의 새 그룹 창으로(이름·요일·시각·보관은 그 화면에서 — 저장은 그 화면의 규칙 그대로) */}
            {toolAllowed('bareos-backup') && (
              <button type="button" className="tab" disabled={!checked.size} onClick={() => { saveBareosGroupHandoff(vcId, [...checked]); window.location.hash = '#/tools/bareos-backup/groups'; }}
                title={`고른 VM 으로 Bareos 백업 그룹을 만듭니다 — 그룹 창에서 이름·스케줄·보관 개수를 정하고 저장합니다${checked.size > BAREOS_HANDOFF_MAX ? `(앞 ${BAREOS_HANDOFF_MAX}대만)` : ''}`} style={{ padding: '3px 10px', fontSize: 12, color: '#fdba74' }}>
                Bareos 그룹 등록{checked.size > BAREOS_HANDOFF_MAX ? `(앞 ${BAREOS_HANDOFF_MAX}대)` : ''} →
              </button>
            )}
          </div>
        )}
        {saving && <span className="muted">저장 중…</span>}
        {saveErr && <span style={{ color: '#fca5a5', overflowWrap: 'anywhere', minWidth: 0 }}>저장 실패 — {saveErr?.status === 403 ? '수정 권한이 없습니다.' : String(saveErr.message || saveErr)}</span>}
      </div>

      <div className="flex wrap" style={{ gap: 14, alignItems: 'flex-start' }}>
        <div className="card" style={{ flex: '999 1 640px', minWidth: 0, padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <div role="treegrid" aria-label="폴더 › VM 백업" style={{ minWidth: GRID_MIN, fontSize: 13 }}>
              <div role="row" style={{ display: 'grid', gridTemplateColumns: GRID, gap: 0, background: 'var(--panel-deep)', color: 'var(--text-dim)', fontSize: 12, fontWeight: 600 }}>
                <div role="columnheader" style={{ padding: '9px 14px' }}>vCenter › 폴더 › VM</div>
                <div role="columnheader" style={{ padding: '9px 6px' }}>전원</div>
                <div role="columnheader" style={{ padding: '9px 10px 9px 6px', textAlign: 'right' }} title="VM 스토리지 사용(GB, vCenter 인벤토리) · 폴더 = 그 아래 VM 합">용량</div>
                <div role="columnheader" style={{ padding: '9px 6px', color: '#67e8f9' }} title="사람이 정한 값 — 위 '백업 정책' 아이콘으로 정합니다">백업 정책</div>
                <div role="columnheader" style={{ padding: '9px 6px' }} title="포탈이 읽은 것 — Veeam 대조 · Bareos 잡">실제 백업</div>
                <div role="columnheader" style={{ padding: '9px 6px' }}>정책≠실제</div>
                <div role="columnheader" style={{ padding: '9px 6px' }} title={`최근 ${opts.rpoDays}일 안에 성공한 백업이 있나(백업 안함은 대상 아님)`}>RPO {opts.rpoDays}일</div>
                <div role="columnheader" style={{ padding: '9px 6px', textAlign: 'right', whiteSpace: 'nowrap' }} title="Veeam 복원 지점">복원 지점</div>
                <div role="columnheader" style={{ padding: '9px 6px' }}>마지막 성공 · 다음</div>
                <div role="columnheader" style={{ padding: '9px 14px 9px 6px' }} title="최근 24시간 실패·경고">실패 24h</div>
              </div>
              {rows.length === 0 && <div className="muted" style={{ padding: '14px' }}>{data ? '조건에 맞는 VM 이 없습니다.' : ''}</div>}
              {rows.map((row) => {
                const pad = 14 + row.depth * 20;
                if (row.kind === 'folder') {
                  const a = row.node.agg;
                  const rp = folderRpoPct(a);
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
                      <div role="gridcell" style={{ padding: '0 10px 0 6px', textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums', lineHeight: 1.3 }} title={a.gbUnknown ? `용량을 모르는 VM ${a.gbUnknown}대는 합에 넣지 않았습니다` : undefined}>
                        <b>{a.n > a.gbUnknown ? fmtGb(a.gb) : '—'}</b>{a.gbUnknown ? <div className="muted" style={{ fontSize: 11 }}>+모름 {a.gbUnknown}</div> : null}
                      </div>
                      <div role="gridcell" style={{ padding: '5px 6px', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                        {marksUnknown ? <span className="muted" style={{ fontSize: 12 }}>정책 모름</span> : POLICIES.map((x) => <PolBar key={x.key} n={a.pol[x.key]} of={a.n} color={x.color} label={x.text} />)}
                      </div>
                      <div role="gridcell" style={{ padding: '5px 6px', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                        {veeamUnknown ? <span className="muted" style={{ fontSize: 12 }}>Veeam 모름</span> : <PolBar n={a.act.v} of={a.n} color={ACT_COLOR.v} label="Veeam" />}
                        {bareosUnknown ? <span className="muted" style={{ fontSize: 12 }}>Bareos 모름</span> : <PolBar n={a.act.b} of={a.n} color={ACT_COLOR.b} label="Bareos" />}
                        <PolBar n={a.act.none} of={a.n} color={ACT_COLOR.none} label="없음" />
                        {a.run ? <span style={{ color: '#fbbf24', fontWeight: 700, fontSize: 12 }}>백업 중·대기 {a.run}</span> : null}
                      </div>
                      <div role="gridcell" style={{ padding: '0 6px', fontSize: 12.5, fontWeight: 700, color: a.mm ? '#fca5a5' : 'var(--text-dim)' }}>{marksUnknown ? '—' : a.mm ? `${fmtNum(a.mm)}대` : '0'}</div>
                      <div role="gridcell" style={{ padding: '0 6px', fontSize: 12.5 }}>{rp == null ? <span className="muted">—</span> : <><b style={{ color: rp >= 95 ? '#86efac' : rp >= 80 ? '#fcd34d' : '#fca5a5' }}>{rp}%</b>{a.rpoMiss ? <div className="muted" style={{ fontSize: 11 }}>미달 {a.rpoMiss}</div> : null}</>}</div>
                      <div role="gridcell" />
                      <div role="gridcell" style={{ padding: '0 6px', fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.45, whiteSpace: 'nowrap' }}>{shortTs(a.lok)}{a.nx != null && <div className="muted">다음 {shortTs(a.nx)}</div>}</div>
                      <div role="gridcell" style={{ padding: '0 14px 0 6px', fontSize: 12.5, fontWeight: 700, color: a.err ? '#fca5a5' : 'var(--text-dim)' }}>{a.err ? `${fmtNum(a.err)}대` : '—'}</div>
                    </div>
                  );
                }
                const vm = row.vm;
                const isSel = sel === vm.id;
                const vc0 = vm.a?.v === true ? veeamCell(vm) : null;
                const bk = vm.b?.job === true ? bareosCell(vm) : null;
                const mm = mismatchCell(vm);
                const rc = rpoCell(vm, vopts);
                const legacy = vm.m?.method && !POLICIES.some((x) => x.key === vm.m.method) ? methodOf(vm.m.method) : null;
                return (
                  <div role="row" key={row.key} aria-selected={isSel} style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', borderTop: '1px solid var(--border-soft)', background: isSel ? 'rgba(59,130,246,.12)' : undefined }}>
                    <div role="gridcell" style={{ minWidth: 0, display: 'flex', alignItems: 'center', paddingLeft: writable ? pad : pad + 20 }}>
                      {/* v2.784: 일괄 적용용 체크(편집 가능할 때만) · 이름 앞 중요도·백업 필요 아이콘 */}
                      {writable && <input type="checkbox" aria-label={`${vm.name} 선택`} checked={checked.has(vm.id)} onChange={() => toggleCheck(vm.id)} style={{ width: 15, height: 15, margin: '0 5px 0 0', flex: 'none' }} />}
                      <button type="button" onClick={() => setSel(isSel ? null : vm.id)} title={`${vm.name}${vm.m?.memo ? ` — 메모: ${vm.m.memo.slice(0, 200)}` : ' — 누르면 오른쪽에 상세 · 백업 정책'}`} style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, minHeight: 38, padding: '0 8px 0 0', background: 'none', border: 0, color: 'var(--text)', font: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ color: 'var(--text-dim)', flex: 'none' }}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8" /></svg>
                        <CritIcon crit={vm.m?.crit} size={14} />
                        {vm.m?.need && <NeedIcon size={14} />}
                        <span style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{vm.name}</span>
                        {(vm.os === 'windows' || vm.os === 'linux') && <span style={{ flex: 'none', fontSize: 10.5, fontWeight: 700, padding: '0 6px', borderRadius: 999, color: vm.os === 'windows' ? '#93c5fd' : '#5eead4', background: vm.os === 'windows' ? 'rgba(59,130,246,.18)' : 'rgba(20,184,166,.18)' }}>{vm.os === 'windows' ? 'Windows' : 'Linux'}</span>}
                        {vm.m?.memo && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-label="메모 있음" style={{ color: 'var(--text-dim)', flex: 'none' }}><path d="M4 4h16v12H8l-4 4z" /></svg>}
                      </button>
                    </div>
                    <div role="gridcell" style={{ padding: '0 6px', fontSize: 12, color: vm.power === 'POWERED_ON' ? '#86efac' : 'var(--text-dim)' }}>{vm.power === 'POWERED_ON' ? '켜짐' : vm.power ? '꺼짐' : '—'}</div>
                    <div role="gridcell" style={{ padding: '0 10px 0 6px', textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: vm.gb == null ? 'var(--text-dim)' : undefined }}>{fmtGb(vm.gb)}</div>
                    <div role="gridcell" style={{ padding: '0 6px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
                      {vm.p ? <MethodBadge method={vm.p} /> : <span className="muted">모름</span>}
                      {legacy && <span className="muted" style={{ fontSize: 10.5 }} title="예전 백업 방식 값 — 화면에서는 '확인 필요' 로 셉니다. 위 아이콘으로 새 정책을 정하면 바뀝니다">저장값 {legacy.text}</span>}
                    </div>
                    <div role="gridcell" style={{ padding: '2px 6px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
                      {vc0 && <Chip c={vc0} />}
                      {bk && <Chip c={bk} />}
                      {!vc0 && !bk && (vm.a?.v === false && vm.a?.b === false ? <span className="muted" style={{ fontSize: 12 }}>없음</span> : vm.b?.job === false ? <Chip c={bareosCell(vm)} /> : <span className="muted" style={{ fontSize: 12 }}>모름</span>)}
                    </div>
                    <div role="gridcell" style={{ padding: '0 6px', minWidth: 0, fontSize: 12 }} title={mm.why || undefined}>
                      <b style={{ color: mm.tone === 'bad' ? '#fca5a5' : mm.tone === 'ok' ? '#86efac' : 'var(--text-dim)' }}>{mm.text}</b>
                      {mm.tone === 'bad' && <div className="muted" style={{ fontSize: 10.5, lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{mm.short}</div>}
                    </div>
                    <div role="gridcell" style={{ padding: '0 6px', minWidth: 0 }}><Chip c={rc} /></div>
                    <div role="gridcell" style={{ padding: '0 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{vm.v && Number.isFinite(vm.v.rp) && vm.v.rp >= 0 ? vm.v.rp : '—'}</div>
                    <div role="gridcell" style={{ padding: '0 6px', fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.45, whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <span style={{ color: lastOkText(vm) === '모름' ? 'var(--text-dim)' : undefined }}>{lastOkText(vm)}</span>
                      {nextOf(vm, data?.at) && <div className="muted" title={nextOf(vm, data?.at).title}>다음 {nextText(vm, data?.at)}</div>}
                    </div>
                    <div role="gridcell" style={{ padding: '0 14px 0 6px', fontSize: 11.5, color: '#fca5a5', fontWeight: 700, lineHeight: 1.3 }}>{errText(vm) || <span className="muted" style={{ fontWeight: 400 }}>—</span>}</div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="muted" style={{ padding: '8px 14px', fontSize: 12, borderTop: '1px solid var(--border-soft)', lineHeight: 1.65 }}>
            <b style={{ color: '#67e8f9' }}>백업 정책</b> = 사람이 정한 값(Veeam · Bareos · SSH · 백업 안함 · 확인 필요 — 정하지 않음·예전 값 Clone·Config 백업은 ‘확인 필요’ 로 셉니다) · <b style={{ color: 'var(--text)' }}>실제 백업</b> = 포탈이 읽은 것(Veeam 대조 · Bareos 잡 — SSH 는 아직 읽지 않습니다) · <b style={{ color: '#fca5a5' }}>정책≠실제</b> = 정책이 Veeam·Bareos 인데 그 백업이 없거나, 정책이 백업 안함·확인 필요인데 백업이 돕니다 · RPO = 기준 일수 안에 성공한 백업(Veeam 완료 · Bareos 성공)이 있나(백업 안함은 대상 아님) · 다음 = Bareos 그룹 예약(Veeam 잡 일정은 다음 단계) · ‘모름’ 은 그쪽을 읽지 못함(백업 안 됨이 아님) · 폴더 막대 = 그 아래 VM 수 / 전체 · 폴더를 누르면 펼치고 접습니다 · VM 을 누르면 오른쪽에 상세
          </div>
        </div>

        {/* VM 을 골랐을 때만 — 긴 트리를 내려가도 상세가 보이게(넓은 화면) · 좁은 화면에서는 표 아래로. v2.810: top 은 .bk-side(도구 줄 아래) */}
        {selVm && (
        <div className="bk-side" style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12, alignSelf: 'flex-start' }}>
          <div className="card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
            {(() => {
              const c = vmClass(selVm, vopts); const v = selVm.v; const mm = mismatchCell(selVm);
              const legacy = selVm.m?.method && !POLICIES.some((x) => x.key === selVm.m.method) ? methodOf(selVm.m.method) : null;
              return (
                <>
                  <div className="flex" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <div className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere', minWidth: 0 }}>{selVm.folder || '—'}</div>
                    <button type="button" className="tab" onClick={() => setSel(null)} aria-label="상세 닫기" style={{ padding: '1px 9px', fontSize: 12, flex: 'none' }}>닫기</button>
                  </div>
                  <div style={{ fontSize: 17, fontWeight: 800, overflowWrap: 'anywhere' }}>{selVm.name}</div>
                  <div className="flex gap wrap" style={{ rowGap: 6 }}>{selVm.p && <MethodBadge method={selVm.p} />}<Chip c={veeamCell(selVm)} />{bareosCell(selVm) && <Chip c={bareosCell(selVm)} />}</div>
                  {v && v.state === 'run' && Number.isFinite(v.pg) && (
                    <div>
                      <div className="flex" style={{ justifyContent: 'space-between', fontSize: 12 }}><span>이 VM 진행률</span><b style={{ color: '#fbbf24' }}>{v.pg}%</b></div>
                      <div style={{ height: 7, borderRadius: 4, background: 'var(--panel-deep)', marginTop: 4 }}><div style={{ height: 7, borderRadius: 4, background: '#f59e0b', width: `${v.pg}%` }} /></div>
                    </div>
                  )}
                  <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '6px 12px', fontSize: 13 }}>
                    <dt className="muted">디스크 용량</dt><dd style={{ margin: 0 }}>{fmtGb(selVm.gb)}{selVm.gb == null ? ' (인벤토리에 값 없음)' : ''}</dd>
                    <dt className="muted">정책≠실제</dt><dd style={{ margin: 0, color: mm.tone === 'bad' ? '#fca5a5' : undefined, overflowWrap: 'anywhere' }}>{mm.text}{mm.why ? ` — ${mm.why}` : ''}</dd>
                    <dt className="muted">마지막 성공</dt><dd style={{ margin: 0 }}>{lastOkText(selVm)}</dd>
                    <dt className="muted">RPO {opts.rpoDays}일</dt><dd style={{ margin: 0 }}>{rpoCell(selVm, vopts).text}</dd>
                    <dt className="muted">Veeam 작업</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{v?.jobs?.length ? v.jobs.join(', ') : (c.vKnown ? '—' : '모름')}</dd>
                    <dt className="muted">Veeam 마지막 완료</dt><dd style={{ margin: 0 }}>{shortTs(v?.lb)}{v?.lbSrc === 'rp' ? ' (복원 지점 생성 시각)' : ''}</dd>
                    <dt className="muted">Veeam 마지막 결과</dt><dd style={{ margin: 0, overflowWrap: 'anywhere', color: c.fail ? '#fca5a5' : undefined }}>{v?.lr ? `이 VM ${v.lr}${v.lastResult && v.lastResult !== v.lr ? ` · 작업 ${v.lastResult}` : ''}` : (v?.lastResult ? `작업 ${v.lastResult}` : '—')}</dd>
                    <dt className="muted">복원 지점</dt><dd style={{ margin: 0 }}>{v && Number.isFinite(v.rp) && v.rp >= 0 ? `${v.rp}개` : v?.rp === -1 ? '있음(개수 모름)' : '—'}</dd>
                    {selVm.b?.job && <><dt className="muted" style={{ color: '#fdba74' }}>Bareos 마지막 성공</dt><dd style={{ margin: 0 }}>{shortTs(selVm.b.ok)}{selVm.b.lv ? ` · 마지막 실행 ${lvText(selVm.b.lv)}` : ''}</dd></>}
                    {selVm.b && selVm.b.job === false && <><dt className="muted" style={{ color: '#fdba74' }}>Bareos</dt><dd style={{ margin: 0, color: '#fcd34d' }}>백업 정책은 Bareos 인데 백업 대상(잡)에 없습니다</dd></>}
                    {selVm.nx && <><dt className="muted">다음 예정</dt><dd style={{ margin: 0 }}>{shortTs(selVm.nx.at)} · Bareos 그룹 ‘{selVm.nx.g}’ · {selVm.nx.lv}</dd></>}
                    {errText(selVm) && <><dt className="muted">최근 24시간</dt><dd style={{ margin: 0, color: '#fca5a5' }}>{errText(selVm)}</dd></>}
                  </dl>
                  {/* v2.784: 백업 표시 — 편집 가능하면 바로 저장(중요도·백업 필요·정책), 메모는 저장 버튼 */}
                  <div data-backup-mark-edit="" style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
                    <b style={{ fontSize: 13 }}>백업 표시</b>
                    <div className="flex" style={{ gap: 6, alignItems: 'flex-start' }}>
                      <span className="muted" style={{ fontSize: 12, minWidth: 56, paddingTop: 4 }}>업무 중요도</span>
                      <span className="flex wrap" style={{ gap: 6, alignItems: 'center', flex: '1 1 0', minWidth: 0 }}>{/* v2.803: 버튼이 꺾여도 라벨 칸 아래로 내려가지 않게 */}
                      {writable ? [...CRIT, { key: '', text: '없음' }].map((c2) => {
                        const on = (selVm.m?.crit || '') === c2.key;
                        return <button key={c2.key || 'none'} type="button" className={`tab${on ? ' active' : ''}`} aria-pressed={on} disabled={saving} onClick={() => !on && saveMarks([selVm.id], { crit: c2.key })} style={{ padding: '3px 9px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>{c2.key ? <CritIcon crit={c2.key} withText plainText={on} /> : '없음'}</button>;
                      }) : (critOf(selVm.m?.crit) ? <CritIcon crit={selVm.m.crit} withText /> : <span className="muted">—</span>)}
                      </span>
                    </div>
                    {/* v2.835 백업 정책 5범주(사람이 정한 값) — 업무 중요도 다음 */}
                    <div className="flex" style={{ gap: 6, alignItems: 'flex-start' }} data-backup-method-edit="">
                      <span className="muted" style={{ fontSize: 12, minWidth: 56, paddingTop: 4 }}>백업 정책</span>
                      <span className="flex wrap" style={{ gap: 6, alignItems: 'center', flex: '1 1 0', minWidth: 0 }}>
                      {writable ? POLICIES.map((x) => {
                        const on = selVm.p === x.key && (selVm.m?.method || '') === x.key;
                        return <button key={x.key} type="button" className={`tab${on ? ' active' : ''}`} aria-pressed={on} disabled={saving} onClick={() => !on && saveMarks([selVm.id], { method: x.key })} title={`단축키 ${POLICY_SHORT[x.key] || ''}`} style={{ padding: '3px 8px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4, color: on ? undefined : x.color }}><PolicyIcon k={x.key} />{x.text}</button>;
                      }) : (selVm.p ? <MethodBadge method={selVm.p} /> : <span className="muted">—</span>)}
                      </span>
                    </div>
                    {legacy && <span className="muted" style={{ fontSize: 11.5, paddingLeft: 62 }}>저장된 예전 값 ‘{legacy.text}’ — 화면에서는 ‘확인 필요’ 로 셉니다. 위에서 새 정책을 고르면 바뀝니다.</span>}
                    {!legacy && !selVm.m?.method && selVm.p === 'check' && <span className="muted" style={{ fontSize: 11.5, paddingLeft: 62 }}>아직 정하지 않음 — ‘확인 필요’ 로 셉니다.</span>}
                    {writable && <span className="muted" data-method-keys="" style={{ fontSize: 11.5, paddingLeft: 62 }}>단축키 V Veeam · B Bareos · S SSH · N 백업 안함 · K 확인 필요</span>}
                    <div className="flex wrap" style={{ gap: 6, alignItems: 'center' }}>
                      <span className="muted" style={{ fontSize: 12, minWidth: 56 }}>백업 필요</span>
                      {writable ? (
                        <button type="button" className={`tab${selVm.m?.need ? ' active' : ''}`} aria-pressed={!!selVm.m?.need} disabled={saving} onClick={() => saveMarks([selVm.id], { need: !selVm.m?.need })} style={{ padding: '3px 10px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}><NeedIcon size={13} />{selVm.m?.need ? '표시됨 — 누르면 해제' : '표시'}</button>
                      ) : (selVm.m?.need ? <span className="flex" style={{ gap: 4, alignItems: 'center' }}><NeedIcon size={13} />표시됨</span> : <span className="muted">—</span>)}
                      {selVm.m?.need && c.vKnown && !c.veeam && !NOT_VEEAM_GAP.includes(c.method) && <span style={{ fontSize: 12, color: '#fca5a5' }}>Veeam 백업 대상이 아닙니다</span>}
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
        </div>
        )}
      </div>
      </>)}
    </div>
  );
}

/** 위 숫자 줄 한 칸 — 누르면 그 보기(같은 칩을 다시 누르면 전체). */
function Kpi({ label, value, color, onClick, on = false }) {
  const body = (<><div style={{ fontSize: 12, color: color || 'var(--text-dim)' }}>{label}</div><div style={{ fontSize: 22, fontWeight: 800, color: value === '—' ? 'var(--text-dim)' : color ? undefined : 'var(--text)' }}>{value}</div></>);
  if (!onClick) return <div>{body}</div>;
  return <button type="button" onClick={onClick} aria-pressed={on} style={{ background: on ? 'rgba(59,130,246,.14)' : 'none', border: 0, borderRadius: 8, padding: '2px 6px', margin: '-2px -6px', textAlign: 'left', color: 'inherit', font: 'inherit', cursor: 'pointer' }}>{body}</button>;
}
