/**
 * 특수 기능 › 서비스 인벤토리(도구 키 svc-inventory, v2.887) — VM + 베어메탈을 서비스 단위로 통합 관리.
 *   설계: docs/design/service-map/README.md · 사용자 선택 '시안 2'(서비스별 전 법인 · 카탈로그 + 커버리지 매트릭스) + 1·2단계 전부.
 *
 * 두 축: [서비스별(전 법인)] 전역 카탈로그 · 매트릭스 · 법인별 투입 자원  ↔  [법인별 인프라] 법인 › 폴더 › 서비스 트리 · 큐 · 규칙.
 * ⚠ 소속 판정·합산은 서버(servicemap/*)가 한다. 이 파일은 조립과 쓰기 요청만 — 문구는 svcInventoryText.js.
 * ⚠ 폴링하지 않는다(마운트 1회 + 새로고침 + 쓰기 뒤 재조회). 늦게 온 이전 응답은 버린다.
 * ⚠ 훅은 전부 조기 return 위(React #310 사고 규약).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, canCsv, downloadFile } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import BoldText from '../../components/boldText.jsx';
import { Card } from './shared.jsx';
import { TierBadge, UsagePair, MemberCount, FaultCell, BackupCell, SrcCell, MembersPanel } from './svcInventory/parts.jsx';
import { UnassignedView, UnmappedView, ReviewView, RulesView } from './svcInventory/Queues.jsx';
import GlobalAxis from './svcInventory/GlobalAxis.jsx';
import PinModal from './svcInventory/PinModal.jsx';
import { folderTreeOf, opErrorText, TIER_TEXT, csvNameOf, FAULT_REASON, filterServices, reviewSummary } from './svcInventoryText.js';
import { numOrNull } from '../../numOrNull.js';

const AXIS_KEY = 'svcinv.axis';
const btn = { padding: '6px 12px', flex: 'none' };
const readAxis = () => { try { return localStorage.getItem(AXIS_KEY) === 'corp' ? 'corp' : 'svc'; } catch { return 'svc'; } };

const INTRO = 'VM(vCenter)과 베어메탈(iDRAC)을 **서비스 단위**로 묶어 봅니다. ESXi 호스트는 구성원이 아니라 **그 서비스 VM 이 올라간 호스트로 파생**됩니다. '
  + '소속은 **고정 → vCenter 폴더 규칙 → 스캔 엔트리 라벨 → 태그(선택) → 이름 규칙(선택)** 순이고, 어디에도 안 걸리면 **(미지정)** 으로 따로 셉니다. 서비스는 사람이 만들고 자동 규칙은 기존 서비스에만 붙습니다.';

export default function SvcInventory() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [axis, setAxisState] = useState(readAxis);
  const [sel, setSel] = useState({ type: 'all' });
  const [view, setView] = useState('svc');
  const [selRow, setSelRow] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const [form, setForm] = useState('');
  const [fv, setFv] = useState({});
  const [pin, setPin] = useState(null);
  const [gsel, setGsel] = useState('');
  const [gcorp, setGcorp] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [flt, setFlt] = useState({ q: '', tier1: false, noOwner: false });   // 서비스별 현황 표 검색·필터(5차 M8)
  const [regions, setRegions] = useState(() => new Map());
  const seq = useRef(0);

  // load → 이 응답을 화면에 실었는가(늦게 와서 버린 응답은 false — 2차 반증 2: 예전에는 버리고도 true 라 '다시 읽었습니다' 가 떴다).
  // fresh 는 재시도하지 않는다(429 를 일시 오류로 보고 두 번 더 물으면 늦게 와 문구를 덮는다). 실패는 던진다 — 부르는 쪽이 나눈다.
  const load = useCallback(async (fresh = false) => {
    const my = ++seq.current;
    try { const r = await fetchJson('/tools/svc-inventory', fresh ? { fresh: '1' } : {}, undefined, fresh ? { retries: 0 } : {}); if (my !== seq.current) return false; setD(r); setErr(null); return true; }
    catch (e) {
      if (my !== seq.current) return false;
      if (fresh) throw e;
      setErr(e); return false;
    }
  }, []);
  // '입력 다시 읽기' — 진행 중·상한 시간 동안 잠근다(서버 meta.limits.freshMinMs · 429 의 waitSec). 숫자를 박지 않는다.
  const [freshBusy, setFreshBusy] = useState(false);
  const [freshUntil, setFreshUntil] = useState(0);
  useEffect(() => {
    if (!freshUntil) return undefined;
    const tm = setTimeout(() => setFreshUntil(0), Math.max(0, freshUntil - Date.now()));
    return () => clearTimeout(tm);
  }, [freshUntil]);
  const readFresh = useCallback(async () => {
    setFreshBusy(true); setNote(null);
    try {
      if (await load(true)) { setReloadKey((k) => k + 1); setNote({ ok: true, text: '입력을 다시 읽었습니다.' }); }
      setFreshUntil(Date.now() + (numOrNull(d?.meta?.limits?.freshMinMs) || 0));
    } catch (e) {
      if (e?.status === 429) {
        // 상한은 포탈 전체에 하나 — 다른 사용자가 방금 읽은 입력을 일반 새로고침으로 받는다(2차 반증 2·3)
        const wait = numOrNull(e?.body?.waitSec); const ago = numOrNull(e?.body?.agoSec);
        if (wait != null) setFreshUntil(Date.now() + wait * 1000);
        const applied = await load();
        setReloadKey((k) => k + 1);
        setNote(applied && ago != null && wait != null
          ? { ok: true, text: `입력은 ${ago}초 전에 이미 다시 읽었습니다(다른 사용자일 수 있습니다) — 화면을 그 입력으로 새로 고쳤습니다. ${wait}초 뒤에 다시 읽을 수 있습니다.` }
          : { ok: false, text: opErrorText(e) });
      } else setNote({ ok: false, text: opErrorText(e) });   // 권한 403 등 — 보던 데이터는 그대로 둔다
    } finally { setFreshBusy(false); }
  }, [load, d]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {   // 지역 이름(매트릭스 열 묶음) — vCenter 목록에서 한 번
    fetchJson('/vcenters').then((r) => {
      const list = Array.isArray(r) ? r : (r?.items || r?.vcenters || []);
      setRegions(new Map(list.map((v) => [v.id, v.location?.region || v.region || ''])));
    }).catch(() => {});
  }, []);
  const setAxis = (a) => { setAxisState(a); try { localStorage.setItem(AXIS_KEY, a); } catch { /* 저장 안 돼도 화면은 동작 */ } };

  const op = useCallback(async (body, okText) => {
    setBusy(true); setNote(null);
    try {
      const r = await postJson('/tools/svc-inventory/op', body);
      if (!r || r.ok === false) throw new Error(r?.reason || '요청을 처리하지 못했습니다.');
      setNote({ ok: true, text: okText || '저장했습니다.' });
      await load(); setReloadKey((k) => k + 1);
      return r;
    } catch (e) { setNote({ ok: false, text: opErrorText(e) }); return null; }
    finally { setBusy(false); }
  }, [load]);

  const corps = useMemo(() => d?.corps || [], [d]);
  const services = useMemo(() => d?.services || [], [d]);
  const corpName = useCallback((id) => corps.find((c) => c.vcenterId === id)?.name || id || '(법인 미지정)', [corps]);
  const writableOf = useCallback((id) => !!corps.find((c) => c.vcenterId === id)?.writable, [corps]);
  const servicesOf = useCallback((id) => services.filter((s) => s.corp === id).sort((a, b) => `${a.path}\\${a.name}`.localeCompare(`${b.path}\\${b.name}`, 'ko')), [services]);
  const svcName = useCallback((id) => services.find((s) => s.id === id)?.name || '?', [services]);
  const regionOf = useCallback((id) => regions.get(id) || '', [regions]);
  const selCorp = sel.type === 'all' ? '' : sel.corp;
  const selSvc = sel.type === 'svc' ? services.find((s) => s.id === sel.id) : null;
  const shown = useMemo(() => services.filter((s) => {
    if (sel.type === 'all') return true;
    if (s.corp !== sel.corp) return false;
    if (sel.type === 'folder') return s.path === sel.path || s.path.startsWith(`${sel.path}\\`);
    if (sel.type === 'svc') return s.id === sel.id;
    return sel.type === 'corp';
  }), [services, sel]);

  if (err && !d) {
    const corrupt = err?.status === 503 || /registryUnreadable|저장소를 읽지 못/.test(String(err?.message || ''));
    return (
      <div className="card" style={{ padding: 16 }}>
        <ErrorBox error={err} />
        {corrupt ? <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>서비스 인벤토리 저장소 파일이 손상돼 빈 트리로 시작하지 않았습니다. 백업에서 복원하거나, 전체 범위 관리자가 초기화(손상본은 보존)할 수 있습니다.
          {/* 초기화 버튼은 서버가 허락한 계정에만(canReset — 전체 범위 관리자 · 5차 R17: 예전에는 누구에게나 보이고 누르면 403) */}
          {err?.body?.canReset === true ? <div style={{ marginTop: 8 }}><button type="button" className="logout-btn" onClick={async () => { const r = await postJson('/tools/svc-inventory/op', { op: 'store.reset' }).catch((e) => ({ ok: false, reason: opErrorText(e) })); if (r?.ok) load(); else setNote({ ok: false, text: r?.reason || '초기화하지 못했습니다.' }); }}>초기화(손상본 보존)</button></div>
            : <div style={{ marginTop: 8 }}>초기화는 전체 범위 관리자만 할 수 있습니다.</div>}
          {note ? <div style={{ marginTop: 6, color: 'var(--red)' }}>{note.text}</div> : null}
        </div> : null}
      </div>
    );
  }
  if (!d) return <Loading />;

  // 큐 숫자는 지금 고른 범위 기준 — 법인을 골랐으면 그 법인 것만(전 법인 합계를 법인 화면 탭에 붙이면 KPI 와 숫자가 어긋난다 · 1440 실측).
  const q = selCorp ? (d.queuesByCorp?.[selCorp] || { unassigned: 0, unmapped: 0, drift: 0, ghosts: 0, ghostsHeld: 0, mismatch: 0 }) : (d.queues || {});
  const review = reviewSummary(q);   // 수에 들어가는 것을 부제에 전부(5차 R17)
  const reviewN = review.n;
  // 서비스·폴더를 골랐을 때 앞 두 KPI 는 그 서비스 기준, 뒤 셋은 법인 기준이다 — 섞인 것을 밝힌다(5차 R16)
  const corpBasis = sel.type === 'svc' || sel.type === 'folder' ? `${corpName(selCorp)} 법인 기준 · ` : '';
  const listed = filterServices(shown, { ...flt, corpName });
  const filtering = !!(flt.q.trim() || flt.tier1 || flt.noOwner);
  const totals = shown.reduce((a, s) => ({ vm: a.vm + s.stat.n.vm, bm: a.bm + s.stat.n.bm }), { vm: 0, bm: 0 });
  const unassignedHere = (sel.type === 'all' ? corps : corps.filter((c) => c.vcenterId === selCorp)).reduce((a, c) => a + (c.unassigned?.n?.total || 0), 0) + (sel.type === 'all' && d.noCorp ? d.noCorp.n.total : 0);
  const crumb = [<b key="a">전체 법인</b>];
  if (sel.type !== 'all') crumb.push(<span key="c">{corpName(sel.corp)}</span>);
  if (sel.type === 'folder') sel.path.split('\\').forEach((p, i) => crumb.push(<span key={`f${i}`}>{p}</span>));
  if (sel.type === 'svc' && selSvc) { if (selSvc.path) selSvc.path.split('\\').forEach((p, i) => crumb.push(<span key={`p${i}`}>{p}</span>)); crumb.push(<b key="s">{selSvc.name}</b>); }
  if (sel.type === 'un') crumb.push(<b key="u" style={{ color: 'var(--amber)' }}>(미지정)</b>);
  const canWriteHere = selCorp && writableOf(selCorp);
  const selCorpRow = selCorp ? corps.find((c) => c.vcenterId === selCorp) : null;
  const orphanOf = (vc) => !!corps.find((c) => c.vcenterId === vc)?.orphan;
  const folderOptions = selCorp ? [...new Set([...(corps.find((c) => c.vcenterId === selCorp)?.folders || []), ...servicesOf(selCorp).map((s) => s.path).filter(Boolean)])].sort() : [];
  const membersQuery = selRow ? (selRow.startsWith('un:') ? { corp: selRow.slice(3), unassigned: '1' } : { service: selRow }) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div className="card" style={{ padding: '10px 14px', borderLeft: '3px solid var(--accent-2)' }}>
        <div className="flex wrap gap" style={{ alignItems: 'center', marginBottom: 6 }}>
          <div className="tabs" style={{ marginLeft: 0 }}>
            <button type="button" className={`tab${axis === 'svc' ? ' active' : ''}`} onClick={() => setAxis('svc')}>서비스별(전 법인)</button>
            <button type="button" className={`tab${axis === 'corp' ? ' active' : ''}`} onClick={() => setAxis('corp')}>법인별 인프라</button>
          </div>
          <span style={{ flex: 1 }} />
          <button type="button" className="logout-btn" style={btn} onClick={() => { load(); setReloadKey((k) => k + 1); }}>새로고침</button>
          {d.canWrite ? (
            <button type="button" className="logout-btn" style={btn} disabled={busy || freshBusy || freshUntil > 0}
              title={`등록부 법인 귀속 · 스캔 엔트리 라벨 · 부품 장애 · Bareos 원장을 지금 다시 읽습니다(포탈 전체에서 ${Math.round((d.meta?.limits?.freshMinMs || 0) / 1000)}초에 한 번). 그냥 새로고침은 다음 수집 주기까지 같은 입력을 씁니다.`}
              onClick={readFresh}>{freshBusy ? '다시 읽는 중…' : '입력 다시 읽기'}</button>
          ) : null}
          {canCsv() ? <button type="button" className="logout-btn" style={btn} onClick={() => downloadFile('/tools/svc-inventory.csv', csvNameOf()).catch((e) => setNote({ ok: false, text: opErrorText(e) }))}>CSV</button> : null}
        </div>
        <div style={{ fontSize: 13 }}><BoldText text={INTRO} /></div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {d.meta?.inputsAt ? `입력 읽은 시각 ${new Date(d.meta.inputsAt).toLocaleTimeString()}${d.meta?.snapAt ? ` · 인벤토리 스냅샷 ${new Date(d.meta.snapAt).toLocaleTimeString()}` : ''}. ` : ''}{d.scoped ? '범위가 지정된 계정이라 자기 법인만 보입니다. ' : ''}쓰기 범위가 있는 법인만 바꿀 수 있습니다. 전역 서비스·태그 카테고리는 전체 범위 관리자가 정합니다. 못 읽은 값은 ‘—’ 이고 합계에서 빠집니다.
          {!d.meta?.faults?.available ? ` ${FAULT_REASON[d.meta?.faults?.reason] || ''}.` : ''}
        </div>
      </div>
      {note ? <div className="card" style={{ padding: '8px 12px', borderLeft: `3px solid ${note.ok ? 'var(--green)' : 'var(--red)'}`, fontSize: 13 }}>{note.ok ? '✓ ' : '⚠ '}{note.text}</div> : null}
      {d.meta?.unreadCorps?.length ? <div className="card" style={{ padding: '8px 12px', borderLeft: '3px solid var(--amber)', fontSize: 13 }}>⚠ 지금 읽지 못하는 법인 {d.meta.unreadCorps.length}곳({d.meta.unreadCorps.slice(0, 5).map(corpName).join(', ')}) — 그 법인의 사용률은 지금 값이 아니라 ‘오래됨’ 으로 빠지고, 그 법인의 고정은 유령으로 보지 않습니다(판정 보류).</div> : null}

      {axis === 'svc' ? (
        <GlobalAxis d={d} regionOf={regionOf} corpName={corpName} writableOf={writableOf} op={op} busy={busy} gsel={gsel} setGsel={setGsel} gcorp={gcorp} setGcorp={setGcorp} reloadKey={reloadKey} />
      ) : (
        <>
          <div className="kpis" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
            <Card label="서비스" value={shown.length} meta={`등급1 ${shown.filter((s) => s.tier === 1).length} · 법인 ${new Set(shown.map((s) => s.corp)).size}`} onClick={() => setView('svc')} active={view === 'svc'} />
            <Card label="구성원(소속)" value={totals.vm + totals.bm} meta={`VM ${totals.vm} · 베어메탈 ${totals.bm}`} onClick={() => setView('svc')} />
            <Card label="(미지정)" value={unassignedHere} accent={unassignedHere ? 'var(--amber)' : 'var(--green)'} meta={`${corpBasis}출처별로 묶어 연결합니다`} onClick={() => setView('un')} active={view === 'un'} />
            <Card label="매핑 안 된 값" value={q.unmapped || 0} accent={q.unmapped ? 'var(--amber)' : 'var(--green)'} meta={`${corpBasis}규칙 값에 맞는 서비스 없음`} onClick={() => setView('unmapped')} active={view === 'unmapped'} />
            <Card label="검토 필요" value={reviewN} accent={reviewN ? 'var(--red)' : 'var(--green)'} meta={`${corpBasis}${review.meta}`} onClick={() => setView('review')} active={view === 'review'} />
          </div>
          <div className="svcinv-layout">
            <CorpTree corps={corps} servicesOf={servicesOf} noCorp={d.noCorp} sel={sel} open={open}
              onSel={(x) => { setSel(x); setSelRow(x.type === 'svc' ? x.id : x.type === 'un' ? `un:${x.corp}` : ''); if (x.type === 'un') setView('un'); else if (x.type === 'svc') setView('svc'); setForm(''); }}
              onToggle={(k) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
              <div className="card" style={{ minWidth: 0 }}>
                <div className="flex wrap gap" style={{ padding: '10px 14px', alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>{crumb.map((c, i) => <React.Fragment key={i}>{i ? <span className="muted">›</span> : null}{c}</React.Fragment>)}</span>
                  <span style={{ flex: 1 }} />
                  <div className="tabs" style={{ marginLeft: 0 }}>
                    {[['svc', '서비스별'], ['un', `미지정 ${q.unassigned || 0}`], ['unmapped', `매핑 안 된 값 ${q.unmapped || 0}`], ['review', `검토 ${reviewN}`], ['rules', '소속 규칙']].map(([k, l]) => (
                      <button key={k} type="button" className={`tab${view === k ? ' active' : ''}`} onClick={() => setView(k)}>{l}</button>
                    ))}
                  </div>
                </div>
                <div className="flex wrap gap" style={{ padding: '8px 14px', alignItems: 'center' }}>
                  {!selCorp ? <span className="muted" style={{ fontSize: 12 }}>왼쪽 트리에서 법인을 고르면 폴더·서비스를 만들고 바꿀 수 있습니다.</span> : selCorpRow?.orphan ? (
                    <OrphanBar corp={selCorp} corpName={corpName} canFleet={d.canFleet} busy={busy} op={op} onPurged={() => { setSel({ type: 'all' }); setSelRow(''); }} />
                  ) : !canWriteHere ? <span className="muted" style={{ fontSize: 12 }}>이 법인은 조회 전용입니다.</span> : (
                    <>
                      <button type="button" className="logout-btn" style={btn} disabled={busy} onClick={() => { setForm(form === 'folder' ? '' : 'folder'); setFv({ path: sel.type === 'folder' ? `${sel.path}\\` : '' }); }}>＋ 폴더</button>
                      <button type="button" className="logout-btn" style={btn} disabled={busy} onClick={() => { setForm(form === 'svc' ? '' : 'svc'); setFv({ path: sel.type === 'folder' ? sel.path : '', name: '', tier: '2', owner: '' }); }}>＋ 서비스</button>
                      <button type="button" className="logout-btn" style={btn} disabled={busy} onClick={() => setPin({ corp: selCorp, service: sel.type === 'svc' ? sel.id : '' })}>⊕ 한 대씩 고정</button>
                    </>
                  )}
                </div>
                {form === 'folder' && canWriteHere ? (
                  <div className="flex wrap gap" style={{ padding: '8px 14px', background: 'var(--panel-2)', alignItems: 'center' }}>
                    <span className="muted" style={{ fontSize: 12 }}>새 폴더(구분자 \ · 최대 10단계)</span>
                    <input className="input" value={fv.path || ''} onChange={(e) => setFv({ ...fv, path: e.target.value })} placeholder="업무시스템\개발" style={{ maxWidth: 260 }} />
                    <button type="button" className="login-btn" style={btn} disabled={busy || !String(fv.path || '').trim()} onClick={async () => { const r = await op({ op: 'folder.add', corp: selCorp, path: fv.path }, `폴더 ‘${fv.path}’ 을 만들었습니다.`); if (r) setForm(''); }}>만들기</button>
                  </div>
                ) : null}
                {form === 'svc' && canWriteHere ? (
                  <div className="flex wrap gap" style={{ padding: '8px 14px', background: 'var(--panel-2)', alignItems: 'center' }}>
                    <span className="muted" style={{ fontSize: 12 }}>새 서비스</span>
                    <Select className="select" value={fv.path || ''} onChange={(e) => setFv({ ...fv, path: e.target.value })} style={{ maxWidth: 200 }} aria-label="폴더"><option value="">(루트)</option>{folderOptions.map((p) => <option key={p} value={p}>{p}</option>)}</Select>
                    <input className="input" value={fv.name || ''} onChange={(e) => setFv({ ...fv, name: e.target.value })} placeholder="서비스명(1~64자)" style={{ maxWidth: 180 }} />
                    <Select className="select" sort={false} value={fv.tier || '2'} onChange={(e) => setFv({ ...fv, tier: e.target.value })} style={{ maxWidth: 100 }} aria-label="등급"><option value="1">등급 1</option><option value="2">등급 2</option><option value="3">등급 3</option></Select>
                    <input className="input" value={fv.owner || ''} onChange={(e) => setFv({ ...fv, owner: e.target.value })} placeholder="담당자(메일·채널)" style={{ maxWidth: 180 }} />
                    <button type="button" className="login-btn" style={btn} disabled={busy || !String(fv.name || '').trim()} onClick={async () => { const r = await op({ op: 'service.add', corp: selCorp, name: fv.name, path: fv.path, tier: Number(fv.tier), owner: fv.owner }, `서비스 ‘${fv.name}’ 을 만들었습니다 — 미지정 탭에서 폴더·엔트리를 연결하거나 한 대씩 고정합니다.`); if (r) setForm(''); }}>만들기</button>
                  </div>
                ) : null}
              </div>

              {view === 'svc' ? (
                <>
                  {selSvc ? <AttrCard key={selSvc.id} s={selSvc} d={d} writable={writableOf(selSvc.corp)} op={op} busy={busy} folderOptions={folderOptions} onDeleted={() => { setSel({ type: 'corp', corp: selSvc.corp }); setSelRow(''); }} /> : null}
                  <div className="card" style={{ minWidth: 0 }}>
                    <div className="flex wrap gap" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
                      <b>서비스별 현황</b><span className="muted" style={{ fontSize: 12 }}>{filtering ? `${listed.length}개 / ${shown.length}개` : `${shown.length}개`} · 행을 누르면 아래 구성원·영향 호스트</span>
                    </div>
                    {shown.length > 1 || filtering ? (
                      <div className="flex wrap gap" style={{ padding: '8px 14px', alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
                        <input className="input" type="search" value={flt.q} onChange={(e) => setFlt({ ...flt, q: e.target.value })} placeholder="서비스 · 폴더 · 담당자 · 법인 찾기" aria-label="서비스 찾기" style={{ minWidth: 0, flex: '1 1 220px', maxWidth: 320 }} />
                        <label style={{ fontSize: 12, display: 'inline-flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={flt.tier1} onChange={(e) => setFlt({ ...flt, tier1: e.target.checked })} /> 등급 1만</label>
                        <label style={{ fontSize: 12, display: 'inline-flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={flt.noOwner} onChange={(e) => setFlt({ ...flt, noOwner: e.target.checked })} /> 담당자 미지정만</label>
                        {filtering ? <button type="button" className="logout-btn" style={btn} onClick={() => setFlt({ q: '', tier1: false, noOwner: false })}>지우기</button> : null}
                        {filtering ? <span className="muted" style={{ fontSize: 12 }}>찾는 동안 (미지정) 행은 숨깁니다</span> : null}
                      </div>
                    ) : null}
                    {!shown.length && sel.type !== 'all' && !corps.find((c) => c.vcenterId === selCorp)?.unassigned ? <div className="muted" style={{ padding: 16 }}>서비스가 없습니다{canWriteHere ? ' — ＋ 서비스로 만듭니다' : ''}.</div> : (
                      <STable className="table svcinv-t" minWidth={sel.type === 'all' ? 760 : 680}>
                        <thead><tr><th>서비스</th><th>등급</th>{sel.type === 'all' ? <th>법인</th> : null}<th title="VM·베어메탈 · 호스트 = 구성원 VM 이 올라간 ESXi 호스트 수(파생)">구성원</th><th title="Σ(사용률×용량)÷Σ용량">사용률</th><th>부품 장애</th><th>백업 24h</th><th>소속 근거</th></tr></thead>
                        <tbody>
                          {listed.map((s) => <ServiceRow key={s.id} s={s} d={d} corpName={corpName} showCorp={sel.type === 'all'} orphanOf={orphanOf} on={selRow === s.id} onClick={() => setSelRow(selRow === s.id ? '' : s.id)} />)}
                          {(sel.type === 'all' ? corps : corps.filter((c) => c.vcenterId === selCorp)).filter((c) => c.unassigned && sel.type !== 'svc' && sel.type !== 'folder' && !filtering).map((c) => (
                            <ServiceRow key={`un:${c.vcenterId}`} s={{ id: `un:${c.vcenterId}`, name: '(미지정)', path: '', corp: c.vcenterId, tier: null, stat: c.unassigned, unassigned: true }} d={d} corpName={corpName} showCorp={sel.type === 'all'} orphanOf={orphanOf} on={selRow === `un:${c.vcenterId}`} onClick={() => setSelRow(selRow === `un:${c.vcenterId}` ? '' : `un:${c.vcenterId}`)} />
                          ))}
                        </tbody>
                      </STable>
                    )}
                    <div className="muted" style={{ padding: '8px 14px', fontSize: 12 }}>CPU·메모리 = Σ(사용률×용량)÷Σ용량 · 꺼진 VM·못 읽은 서버는 합산에서 빠집니다 · 부품 장애 = 구성원 장애(+영향 호스트 장애, 다른 서비스와 공유) · 백업 = 그 법인 Bareos 최근 24시간</div>
                  </div>
                  {membersQuery ? <MembersPanel title={selRow.startsWith('un:') ? `(미지정) · ${corpName(selRow.slice(3))}` : svcName(selRow)} sub={selRow.startsWith('un:') ? '미지정 구성원' : '구성원'} query={membersQuery} reloadKey={reloadKey} showReason={selRow.startsWith('un:')} /> : null}
                </>
              ) : null}
              {view === 'un' ? <UnassignedView corp={selCorp} reloadKey={reloadKey} servicesOf={servicesOf} writableOf={writableOf} op={op} busy={busy} corpName={corpName} onPinGroup={(g) => setPin({ corp: g.corp, service: '' })} /> : null}
              {view === 'unmapped' ? <UnmappedView corp={selCorp} reloadKey={reloadKey} servicesOf={servicesOf} writableOf={writableOf} op={op} busy={busy} corpName={corpName} /> : null}
              {view === 'review' ? <ReviewView corp={selCorp} reloadKey={reloadKey} svcName={svcName} writableOf={writableOf} op={op} busy={busy} corpName={corpName} /> : null}
              {view === 'rules' ? <RulesView corp={selCorp} corpRow={corps.find((c) => c.vcenterId === selCorp)} servicesOf={servicesOf} writable={!!canWriteHere} op={op} busy={busy} canFleet={d.canFleet} tagCategory={d.settings?.tagCategory} corpName={corpName} /> : null}
            </div>
          </div>
        </>
      )}
      {pin ? <PinModal corp={pin.corp} defaultService={pin.service} corps={corps} servicesOf={servicesOf} writableOf={writableOf} op={op} busy={busy} corpName={corpName} scoped={!!d?.scoped} onClose={() => setPin(null)} /> : null}
    </div>
  );
}

function ServiceRow({ s, d, corpName, showCorp, on, onClick, orphanOf }) {
  const st = s.stat;
  const stale = (d.meta?.unreadCorps || []).includes(s.corp);
  const sub = s.unassigned ? '어느 규칙에도 안 걸린 구성원' : [s.path || '(루트)', s.owner || '담당자 미지정'].join(' · ');
  return (
    <tr onClick={onClick} style={{ cursor: 'pointer', background: on ? 'rgba(59,130,246,.10)' : s.unassigned ? 'rgba(245,158,11,.05)' : undefined }}>
      <td data-sort={s.unassigned ? '\uffff' : s.name}>
        <b>{s.name}</b>{s.unassigned ? <span className="badge amber" style={{ marginLeft: 4 }}>규칙 없음</span> : null}
        <div className="svcinv-sub" style={!s.unassigned && !s.owner ? { color: 'var(--text-faint)' } : undefined}>{sub}</div>
      </td>
      <td data-sort={s.tier ?? 9}>{s.tier ? <TierBadge tier={s.tier} /> : <span className="muted">—</span>}</td>
      {showCorp ? <td data-sort={corpName(s.corp)}>{corpName(s.corp).replace(/^vcenter-/, '')}{orphanOf?.(s.corp) ? <div><span className="badge gray" title="등록 해제된 vCenter — 서비스·규칙·고정만 남아 있습니다">등록 해제</span></div> : null}</td> : null}
      <td data-sort={st.n.total}><MemberCount st={st} /></td>
      <td data-sort={st.usage.cpu ?? ''}><UsagePair cpu={st.usage.cpu} mem={st.usage.mem} missing={st.usage.unread + st.usage.stale} /></td>
      <td><FaultCell f={st.faults} meta={d.meta?.faults} stale={stale} /></td>
      <td><BackupCell b={st.backup} meta={d.meta?.backup} /></td>
      <td><SrcCell src={st.src} />{st.drift ? <div><span className="badge red" title="고정과 자동 판정이 다름 — 검토 탭">드리프트 {st.drift}</span></div> : null}</td>
    </tr>
  );
}

/** 서비스 속성 — 등급 · 담당자 · 메모 · 폴더 이동 · 전역 연결 · 삭제. */
function AttrCard({ s, d, writable, op, busy, folderOptions, onDeleted }) {
  const [v, setV] = useState({ tier: String(s.tier), owner: s.owner || '', note: s.note || '', path: s.path || '', globalId: s.globalId || '', name: s.name });
  const [ask, setAsk] = useState(null);   // 개명 확인(5차 반증 R3) — { kinds, n }
  const globals = d.global?.globals || [];
  const byName = s.stat?.byName || {};
  const renamed = v.name.trim() && v.name.trim().toLowerCase() !== s.name.toLowerCase();
  const save = (keepAlias) => {
    setAsk(null);
    const kept = (keepAlias || []).map((k) => (k === 'scan' ? '스캔 라벨' : '태그 값')).join('·');
    return op({ op: 'service.update', corp: s.corp, id: s.id, name: v.name, tier: Number(v.tier), owner: v.owner, note: v.note, path: v.path, globalId: v.globalId, ...(keepAlias ? { keepAlias } : {}) },
      `‘${v.name}’ 속성을 저장했습니다${kept ? ` — 옛 이름 ‘${s.name}’ 을(를) ${kept} 별칭으로 남겼습니다` : ''}.`);
  };
  const onSave = () => {
    const kinds = ['scan', 'tag'].filter((k) => byName[k] > 0);
    if (renamed && kinds.length) { setAsk({ kinds, n: kinds.reduce((a, k) => a + byName[k], 0) }); return; }
    save(null);
  };
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div className="flex wrap gap" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
        <b>서비스 속성 — {s.name}</b><span className="muted" style={{ fontSize: 12 }}>{writable ? '법인 관리자가 바꿉니다 · 감사 로그' : '조회 전용'}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '6px 10px', padding: '10px 14px', alignItems: 'center', fontSize: 13 }}>
        <span className="muted">이름</span><input className="input" value={v.name} disabled={!writable} onChange={(e) => setV({ ...v, name: e.target.value })} style={{ maxWidth: 260 }} />
        <span className="muted">등급</span><Select className="select" sort={false} value={v.tier} disabled={!writable} onChange={(e) => setV({ ...v, tier: e.target.value })} style={{ maxWidth: 360 }} aria-label="등급">{[1, 2, 3].map((n) => <option key={n} value={String(n)}>{TIER_TEXT[n]}</option>)}</Select>
        <span className="muted">담당자</span><input className="input" value={v.owner} disabled={!writable} onChange={(e) => setV({ ...v, owner: e.target.value })} placeholder="메일 또는 채널 — 후속: 서비스별 알림 라우팅" style={{ maxWidth: 360 }} />
        <span className="muted">메모</span><input className="input" value={v.note} disabled={!writable} onChange={(e) => setV({ ...v, note: e.target.value })} placeholder="예: 2026-12 DB 서버 교체 예정" style={{ maxWidth: 420 }} />
        <span className="muted">폴더</span><Select className="select" value={v.path} disabled={!writable} onChange={(e) => setV({ ...v, path: e.target.value })} style={{ maxWidth: 260 }} aria-label="폴더"><option value="">(루트)</option>{folderOptions.map((p) => <option key={p} value={p}>{p}</option>)}</Select>
        <span className="muted">전역 서비스</span><Select className="select" value={v.globalId} disabled={!writable} onChange={(e) => setV({ ...v, globalId: e.target.value })} style={{ maxWidth: 260 }} aria-label="전역 서비스"><option value="">(연결 없음 — 이 법인 전용)</option>{globals.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select>
      </div>
      {ask ? (
        <div style={{ margin: '0 14px 10px', padding: '10px 12px', border: '1px solid var(--amber)', borderRadius: 8, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <div>이름을 <b>‘{v.name.trim()}’</b> 로 바꿉니다. {ask.kinds.map((k) => `${k === 'scan' ? '스캔 라벨' : '태그 값'} ‘${s.name}’ 로 ${byName[k]}대`).join(' · ')}가 이 서비스 이름으로 소속돼 있습니다. 옛 이름을 별칭으로 남기면 그대로 유지됩니다.</div>
          <div className="flex wrap gap" style={{ alignItems: 'center' }}>
            <button type="button" className="login-btn" style={btn} disabled={busy} onClick={() => save(ask.kinds)}>별칭 남기고 저장</button>
            <button type="button" className="logout-btn" style={btn} disabled={busy} onClick={() => save(null)}>별칭 없이 저장({ask.n}대가 미지정으로)</button>
            <button type="button" className="logout-btn" style={btn} disabled={busy} onClick={() => setAsk(null)}>취소</button>
          </div>
        </div>
      ) : null}
      {writable ? (
        <div className="flex wrap gap" style={{ padding: '0 14px 10px' }}>
          <button type="button" className="login-btn" style={btn} disabled={busy || !v.name.trim() || !!ask} onClick={onSave}>저장</button>
          <button type="button" className="logout-btn" style={{ ...btn, color: 'var(--red)' }} disabled={busy} onClick={async () => {
            if (!window.confirm(`서비스 ‘${s.name}’ 을 지웁니다. 이 서비스를 가리키는 폴더 규칙·별칭·이름 규칙·고정도 함께 지워지고, 구성원 ${s.stat.n.total}대는 미지정(또는 다른 규칙)으로 돌아갑니다. 계속할까요?`)) return;
            const r = await op({ op: 'service.remove', corp: s.corp, id: s.id }, `서비스 ‘${s.name}’ 을 지웠습니다.`); if (r) onDeleted();
          }}>서비스 삭제</button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 등록 해제된 vCenter 의 법인 행(5차 반증 R2) — 법인 쓰기는 전부 막히고(서버 404), 전체 범위 관리자만 '법인 항목 정리' 로 지운다.
 * 먼저 지울 개수를 받아(dry) 보여 주고, 두 번째 누름으로 지운다.
 */
function OrphanBar({ corp, corpName, canFleet, busy, op, onPurged }) {
  const [plan, setPlan] = useState(null);
  const [err, setErr] = useState('');
  const cur = useRef(corp);
  useEffect(() => { cur.current = corp; setPlan(null); setErr(''); }, [corp]);
  const c = plan?.counts;
  return (
    <span className="flex wrap gap" style={{ alignItems: 'center', fontSize: 12, minWidth: 0 }}>
      <span className="muted">이 vCenter 는 등록이 해제됐습니다 — 서비스·규칙·고정만 남아 있어 바꿀 수 없습니다.</span>
      {!canFleet ? <span className="muted">정리는 전체 범위 관리자가 합니다.</span> : !plan ? (
        <button type="button" className="logout-btn" style={btn} disabled={busy} onClick={async () => {
          setErr('');
          const asked = corp;   // 늦게 온 응답은 버린다 — 응답 전에 다른 법인을 고르면 그 법인 화면에 이 개수를 띄우지 않는다(5차 1차 반증 7)
          try { const r = await postJson('/tools/svc-inventory/op', { op: 'corp.purge', corp: asked, dry: true }); if (cur.current !== asked) return; if (r?.ok) setPlan(r.result); else setErr(r?.reason || '개수를 읽지 못했습니다.'); }
          catch (e) { if (cur.current === asked) setErr(opErrorText(e)); }
        }}>법인 항목 정리…</button>
      ) : (
        <>
          <span>서비스 {c.services} · 폴더 {c.folders} · 폴더 규칙 {c.folderRules} · 별칭 {c.aliases} · 이름 규칙 {c.nameRules} · 고정 {c.pins} 를 지웁니다. 되돌릴 수 없습니다(서비스·규칙은 설정 변경 백업에 남고, 고정은 남지 않을 수 있습니다).</span>
          <button type="button" className="logout-btn" style={{ ...btn, color: 'var(--red)' }} disabled={busy || plan.corp !== corp} onClick={async () => { const r = await op({ op: 'corp.purge', corp, expect: plan.counts }, `${corpName(corp)} 의 법인 항목을 정리했습니다.`); if (r) onPurged(); }}>지우기</button>
          <button type="button" className="logout-btn" style={btn} disabled={busy} onClick={() => setPlan(null)}>취소</button>
        </>
      )}
      {err ? <span style={{ color: 'var(--red)' }}>{err}</span> : null}
    </span>
  );
}

/** 법인 › 폴더 › 서비스 트리. */
function CorpTree({ corps, servicesOf, noCorp, sel, open, onSel, onToggle }) {
  const [tq, setTq] = useState('');   // 트리 찾기(5차 M8) — 법인 이름 · 서비스 이름 · 폴더
  const needle = tq.trim().toLowerCase();
  const isOn = (x) => sel.type === x.type && (x.type === 'all' || (sel.corp === x.corp && (x.type === 'folder' ? sel.path === x.path : x.type === 'svc' ? sel.id === x.id : true)));
  const rows = [];
  const total = corps.reduce((a, c) => a + servicesOf(c.vcenterId).reduce((b, s) => b + s.stat.n.total, 0) + (c.unassigned?.n?.total || 0), 0) + (noCorp?.n?.total || 0);
  rows.push({ key: 'all', depth: 0, icon: '🌐', name: '전체 법인', n: total, x: { type: 'all' } });
  for (const c of corps) {
    if (needle) {   // 찾는 중 — 맞는 법인·서비스만 평평하게(폴더 열림 상태와 무관)
      const corpHit = String(c.name || '').toLowerCase().includes(needle);
      const hits = servicesOf(c.vcenterId).filter((s) => `${s.name}\u0000${s.path || ''}`.toLowerCase().includes(needle));
      if (!corpHit && !hits.length) continue;
      rows.push({ key: `c:${c.vcenterId}`, depth: 0, icon: '🏢', name: c.name.replace(/^vcenter-/, ''), n: servicesOf(c.vcenterId).reduce((a, s) => a + s.stat.n.total, 0) + (c.unassigned?.n?.total || 0), x: { type: 'corp', corp: c.vcenterId }, orphan: !!c.orphan });
      for (const s of hits) rows.push({ key: `s:${s.id}`, depth: 1, icon: '🧩', name: s.name, sub: s.path ? s.path.replace(/\\/g, ' › ') : '', n: s.stat.n.total, tier: s.tier, x: { type: 'svc', corp: c.vcenterId, id: s.id } });
      continue;
    }
    const k = `c:${c.vcenterId}`; const op = open.has(k);
    const tree = folderTreeOf(c, servicesOf(c.vcenterId));
    rows.push({ key: k, depth: 0, icon: '🏢', tw: op ? '▾' : '▸', name: c.name.replace(/^vcenter-/, ''), n: tree.n + (c.unassigned?.n?.total || 0), x: { type: 'corp', corp: c.vcenterId }, toggle: k, orphan: !!c.orphan });
    if (!op) continue;
    const walk = (node, depth) => {
      for (const ch of node.children) {
        const fk = `f:${c.vcenterId}:${ch.path}`; const fo = open.has(fk);
        rows.push({ key: fk, depth, icon: '📁', tw: fo ? '▾' : '▸', name: ch.name, n: ch.n, empty: !ch.n && !ch.services.length && !ch.children.length, x: { type: 'folder', corp: c.vcenterId, path: ch.path }, toggle: fk });
        if (fo) walk(ch, depth + 1);
      }
      for (const s of node.services) rows.push({ key: `s:${s.id}`, depth, icon: '🧩', name: s.name, n: s.stat.n.total, tier: s.tier, x: { type: 'svc', corp: c.vcenterId, id: s.id } });
    };
    walk(tree, 1);
    if (c.unassigned?.n?.total) rows.push({ key: `u:${c.vcenterId}`, depth: 1, icon: '⚠', name: '(미지정)', n: c.unassigned.n.total, un: true, x: { type: 'un', corp: c.vcenterId } });
  }
  if (noCorp?.n?.total && !needle) rows.push({ key: 'nocorp', depth: 0, icon: '❔', name: '(법인 미지정)', n: noCorp.n.total, un: true, x: { type: 'un', corp: '' } });
  return (
    <div className="card" style={{ alignSelf: 'start', minWidth: 0 }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}><b>법인 › 폴더 › 서비스</b></div>
      <div style={{ padding: '8px 10px 4px' }}>
        <input className="input" type="search" value={tq} onChange={(e) => setTq(e.target.value)} placeholder="법인·서비스 찾기" title="법인 이름 · 서비스 이름 · 폴더에서 찾습니다" aria-label="트리 찾기" style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }} />
        {needle && rows.length <= 1 ? <div className="muted" style={{ fontSize: 12, padding: '6px 2px 0' }}>맞는 법인·서비스가 없습니다.</div> : null}
      </div>
      <div style={{ padding: '6px 2px', maxHeight: '70vh', overflowY: 'auto' }}>
        {rows.map((r) => (
          <div key={r.key} className={`svcinv-tn${isOn(r.x) ? ' on' : ''}`} style={{ paddingLeft: 6 + r.depth * 10 }}
            onClick={() => { if (r.toggle && (isOn(r.x) || !open.has(r.toggle))) onToggle(r.toggle); onSel(r.x); }}>
            <span style={{ width: 10, color: 'var(--text-faint)', fontSize: 10 }}>{r.tw || ''}</span>
            <span>{r.icon}</span>
            <span className="nm" title={r.sub ? `${r.sub} › ${r.name}` : r.name} style={r.un ? { color: 'var(--amber)' } : undefined}>{r.name}{r.sub ? <span className="muted" style={{ fontSize: 11 }}> · {r.sub}</span> : null}{r.empty ? <span className="muted"> (빈)</span> : null}</span>
            {r.orphan ? <span className="badge gray" style={{ flex: 'none' }} title="등록 해제된 vCenter — 서비스·규칙·고정만 남아 있습니다">해제</span> : null}
            {r.tier ? <TierBadge tier={r.tier} /> : null}
            <span className="cnt">{r.n}</span>
          </div>
        ))}
      </div>
      <div className="muted" style={{ padding: '8px 14px', fontSize: 11, borderTop: '1px solid var(--border)' }}>폴더 경로 구분자 \ · 최대 10단계 · 같은 노드를 다시 누르면 접습니다</div>
    </div>
  );
}
