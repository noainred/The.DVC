/**
 * V4App — 신규 포탈(version_4) 셸(v2.508). 설정 › 신규 포탈 보기 › V4 버튼 또는 해시 #/v4/<page> 로 진입한다.
 *
 * v2.490 의 V3App(6화면)을 승격해 UI 개편 시안(Design/uiredesign/ 아트보드 8장)을 구현했다.
 *   · 화면 9개 — 전사 현황 · 법인 비교 · 전력/비용 · 컴퓨트 · 스토리지 · 네트워크 · 설비 · 알람 · 기능 찾기
 *   · 좌측 내비는 시안 ⑧의 IA 11그룹(tree.js) — 도구 79개 + 개발 포탈 탭 14개가 전부 트리에 있다(미분류 0)
 *   · 상단 '경영 보기 ↔ 엔지니어 보기' 모드 토글(mode.js) — **보기 설정이지 권한이 아니다**
 *   · ⌘K / Ctrl+K 커맨드 팔레트(palette.js)
 *
 * 데이터는 실 API 만 쓴다. 수집 API 가 없는 항목(계약 전력 대비 · 백본 회선 · 펌웨어 기준선 ·
 * SLA/가용률 · 자원의 금액 환산)은 **그리지 않는다** — 자세한 이유는 각 화면의 '넣지 않은 것' 패널에.
 *
 * 폴링: 여러 화면·내비 카운트·도메인 타일이 같은 원본을 읽으므로 여기서 한 번만 돌리고(8개),
 * 화면 전용 데이터는 각 페이지가 마운트될 때만 폴링한다. 무거운 API(capacity-forecast 실측 1.5초,
 * orphan-vmdk 는 실행마다 vCenter SOAP 왕복)는 60초 이상 주기이거나 버튼 실행이다.
 * 권한상 호출하지 않을 API 는 path 를 null 로 넘겨 403 을 만들지 않는다.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { usePolling, toolAllowed, can, getCurrentUser } from '../api.js';
import ErrorBoundary from '../components/ErrorBoundary.jsx';
import { hashSegments } from '../hooks/hashTab.js';
import { TOOLS } from '../views/specialToolsList.js';
import './v4.css';
import { PAGE_IDS, PAGE_META, GROUP_TILE } from './nav.js';
import { visibleTree, groupLabelOfTool } from './tree.js';
import { toolHidden } from '../views/toolVisibility.js';
import { MODE_LABEL, MODE_KEY, resolveMode, modeSpec, viewFromHash } from './mode.js';
import { loadPhase, loadText, collectProgress, liveText, shouldBanner } from './loadState.js';
import { buildDomainTiles, severityCounts, siteRows, fmtInt, levelBar } from './data.js';
import Palette from './Palette.jsx';
import Overview from './pages/Overview.jsx';
import Compare from './pages/Compare.jsx';
import Power from './pages/Power.jsx';
import Compute from './pages/Compute.jsx';
import Storage from './pages/Storage.jsx';
import Network from './pages/Network.jsx';
import Facility from './pages/Facility.jsx';
import Alarms from './pages/Alarms.jsx';
import Tools from './pages/Tools.jsx';

export const V4_HASH = '#/v4';
export const isV4Hash = (hash) => hashSegments(hash)[0] === 'v4';
export const pageFromHash = (hash) => {
  const s = hashSegments(String(hash || '').split('?')[0]);
  return s[0] === 'v4' && PAGE_IDS.includes(s[1]) ? s[1] : 'overview';
};

const PAGES = { overview: Overview, compare: Compare, power: Power, compute: Compute, storage: Storage, network: Network, facility: Facility, alarms: Alarms, tools: Tools };

/** localStorage 는 프라이빗 창·차단 설정에서 throw 한다 — 읽기·쓰기를 모두 감싼다. */
const readStored = () => { try { return window.localStorage.getItem(MODE_KEY); } catch { return null; } };
const writeStored = (v) => { try { window.localStorage.setItem(MODE_KEY, v); } catch { /* 저장 실패는 기능을 막지 않는다 */ } };

export default function V4App({ user, health, healthError, onExit }) {
  const [page, setPageState] = useState(() => pageFromHash(window.location.hash));
  const [mode, setModeState] = useState(() => resolveMode({ query: viewFromHash(window.location.hash), stored: readStored(), role: user?.role }));
  const [q, setQ] = useState('');
  const [region, setRegion] = useState('');
  const [focusVc, setFocusVc] = useState('');
  const [paletteOn, setPaletteOn] = useState(false);
  useEffect(() => {
    const on = () => {
      if (!isV4Hash(window.location.hash)) return;
      setPageState(pageFromHash(window.location.hash));
      // ?view= 는 그 이동에만 적용하고 저장하지 않는다(남에게 보낸 링크가 내 설정을 바꾸면 안 된다).
      const v = viewFromHash(window.location.hash);
      if (v) setModeState(v);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const go = useCallback((p, opts = {}) => {
    if (opts.vcenterId !== undefined) setFocusVc(opts.vcenterId || '');
    setPageState(p);
    window.location.hash = `${V4_HASH}/${p}`;
    window.scrollTo(0, 0);
  }, []);
  const setMode = (m) => { setModeState(m); writeStored(m); };
  /** 팔레트·트리에서 고른 항목으로 이동. V4 화면이면 내부 이동, 아니면 개발 포탈로 나간다. */
  const goAnywhere = useCallback((hash) => {
    setPaletteOn(false);
    const segs = hashSegments(hash);
    if (segs[0] === 'v4' && PAGE_IDS.includes(segs[1])) { go(segs[1]); return; }
    onExit(hash);
  }, [go, onExit]);

  // ⌘K / Ctrl+K — 입력 중에도 열린다(브라우저 기본 동작을 막는다). Esc 는 팔레트가 처리한다.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k') { e.preventDefault(); setPaletteOn((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const isAdmin = user?.role === 'admin';
  const ov = usePolling('/overview', {}, 15_000);
  const al = usePolling('/alarms', {}, 15_000);
  const nsx = usePolling('/nsx', {}, 30_000);
  // svcmon 은 기능 권한 게이트(v2.506) 아래다 — 권한 없는 역할에 폴링을 걸면 30초마다 403 이고
  // usePolling 이 폴링을 끊은 뒤에도 타일이 '점검 상태 대기'(거짓 원인)로 남는다.
  const canSvcmon = can('svcmon');
  const svc = usePolling(canSvcmon ? '/svcmon/state' : null, { limit: 1 }, 30_000);
  const ds = usePolling('/datastores', {}, 60_000);
  const canStorage = toolAllowed('storage-mon'), canPdu = toolAllowed('pdu');
  const stor = usePolling(canStorage ? '/tools/storage' : null, {}, 60_000);
  const pdu = usePolling(canPdu ? '/tools/pdu' : null, {}, 60_000);
  const idrac = usePolling(isAdmin ? '/admin/idrac' : null, {}, 60_000);

  const global = ov.data?.global || null;
  const sitesAll = useMemo(() => siteRows(ov.data?.sites), [ov.data]);
  const vcRegion = useMemo(() => Object.fromEntries(sitesAll.map((s) => [s.id, s.region])), [sitesAll]);
  const regions = useMemo(() => [...new Set(sitesAll.map((s) => s.region))].sort(), [sitesAll]);
  const inScope = (vcId) => (!region || vcRegion[vcId] === region) && (!focusVc || vcId === focusVc);
  const scope = useMemo(() => ({ q, region, focusVc, vcRegion, inScope, scoped: (list, key = 'vcenterId') => (list || []).filter((x) => inScope(x[key])) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q, region, focusVc, vcRegion]);

  const alarmsAll = useMemo(() => al.data?.items || [], [al.data]);
  const dsOver = ds.data ? ds.data.items.filter((d) => d.usagePct >= 90).length : null;
  const tiles = useMemo(() => buildDomainTiles({
    global, alarms: alarmsAll, nsx: nsx.data, svcmon: svc.data, pdu: pdu.data, idracPoller: idrac.data?.poller || null,
    dsOver, storageDevices: stor.data ? stor.data.devices.length : null,
    permission: { idrac: isAdmin, pdu: canPdu, svcmon: canSvcmon },
  }), [global, alarmsAll, nsx.data, svc.data, pdu.data, idrac.data, dsOver, stor.data, isAdmin, canPdu, canSvcmon]);
  const sev = severityCounts(alarmsAll);
  const spec = modeSpec(mode);

  const counts = {
    hosts: fmtInt(global?.hosts), datastores: fmtInt(global?.datastores), networks: fmtInt(global?.networks),
    powerReporting: fmtInt(global?.powerReporting), alarms: al.data ? fmtInt(sev.total) : '',
  };
  const PAGE_COUNT = { compute: 'hosts', storage: 'datastores', network: 'networks', facility: 'powerReporting', alarms: 'alarms' };
  const groupLevel = (gid) => {
    const idx = GROUP_TILE[gid];
    if (!idx) return null;
    const lv = idx.map((i) => tiles[i]?.level).filter((v) => v != null);
    if (gid === 'monitoring') lv.push(sev.critical ? 2 : sev.warning ? 1 : 0);
    return lv.length ? Math.max(...lv) : null;
  };
  // 트리는 관리자 전용 도구만 숨긴다 — 잠긴 도구는 숨기지 않고 회색으로 보여주는 것이 기존 정책이다.
  // v2.555: 허용 목록 모드면 목록 밖 도구를 내비에서 **숨긴다**(사용자 선택 '아예 숨긴다').
  // ⚠ 의존성 키를 `join(',')` 으로 만들지 말 것 — 빈 배열(전면 차단)과 null(재정의 없음)이
  //   둘 다 빈 문자열이 되어 **전면 차단 설정이 조용히 '제한 없음' 으로 읽힌다**.
  const allowKey = JSON.stringify(getCurrentUser()?.toolsAllowed ?? null);
  const groups = useMemo(() => {
    const allow = JSON.parse(allowKey);
    return visibleTree(TOOLS, { isAdmin, toolShown: (t) => !toolHidden(t, { isAdmin, toolsAllowed: allow, hideAdminOnly: true }) });
  }, [isAdmin, allowKey]);
  const byKey = useMemo(() => new Map(TOOLS.map((t) => [t.k, t])), []);

  const meta = PAGE_META[page] || PAGE_META.overview;
  const Page = PAGES[page] || Overview;
  const updated = health?.generatedAt ? new Date(health.generatedAt).toLocaleTimeString('ko-KR') : '—';
  // 화면이 비어 있을 때 **왜** 비었는지(v2.509). 셸에서 한 번만 판정해 9화면이 공유한다 —
  // 각 화면이 따로 판정하면 같은 상황을 다르게 말하게 된다. 기준은 셸의 대표 폴(/overview)이다.
  const phase = loadPhase({ health, healthError, poll: ov });
  const phaseText = loadText(phase, { health, pollError: ov.error });
  const progress = collectProgress(health);
  const overviewSub = global ? `${fmtInt(sitesAll.length)}개 vCenter · 물리 서버 ${fmtInt(ov.data?.physical?.servers || global.hosts)} · VM ${fmtInt(global.vms)} · 15초 수집` : phaseText.short;
  const pageProps = {
    user, isAdmin, scope, go, goAnywhere, global, ov: ov.data, sitesAll, alarmsAll, tiles, mode, spec, phase, phaseText, health, progress,
    polls: { ov, al, nsx, svc, ds, stor, pdu, idrac }, perms: { storage: canStorage, pdu: canPdu, idrac: isAdmin, svcmon: canSvcmon },
  };
  const powerKw = global?.powerReporting ? `${fmtInt(global.powerKw)} kW` : '—';

  return (
    <div className="v3 v4">
      <aside className="v3-side">
        <div className="v3-brand">
          <div className="v3-logo">V</div>
          <div><div className="v3-brand-title">The Davinci</div><div className="v3-brand-sub">GLOBAL OPS CONSOLE</div></div>
        </div>
        <nav className="v3-nav">
          {groups.map((g) => (
            <div className="v3-nav-group" key={g.id}>
              <div className="v3-nav-label"><span>{g.label}</span><i className="v3-dot" style={{ background: levelBar(groupLevel(g.id)) }} /></div>
              {g.items.map((it) => {
                if (it.kind === 'page') {
                  const c = PAGE_COUNT[it.id];
                  return (
                    <button key={`p:${it.id}`} type="button" className={`v3-nav-item${page === it.id ? ' active' : ''}`} onClick={() => go(it.id)}>
                      <span className="v3-nav-name">{PAGE_META[it.id]?.title || it.id}</span>
                      {c && <span className="v3-nav-count">{counts[c]}</span>}
                    </button>
                  );
                }
                if (it.kind === 'tab') {
                  return (
                    <button key={`t:${it.id}`} type="button" className="v3-nav-item ext" title={`개발 포탈 ${it.hash} 로 이동`} onClick={() => onExit(it.hash)}>
                      <span className="v3-nav-name">{it.name}</span><span className="v3-nav-count">↗</span>
                    </button>
                  );
                }
                const t = byKey.get(it.k);
                return (
                  <button key={`k:${g.id}:${it.k}`} type="button" className="v3-nav-item ext" title={`개발 포탈 #/tools/${it.k} 로 이동${it.alias ? ` · 주소속: ${groupLabelOfTool(it.k)}` : ''}`} onClick={() => onExit(`#/tools/${it.k}`)}>
                    <span className="v3-nav-name">{t?.icon} {t?.label}</span>
                    <span className="v3-nav-count">{it.alias ? '별칭' : '↗'}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="v3-foot">
          <div className="v3-foot-row"><span>SERVERS</span><b>{fmtInt(ov.data?.physical?.servers || global?.hosts)}</b></div>
          <div className="v3-foot-row"><span>VMS</span><b>{fmtInt(global?.vms)}</b></div>
          <div className="v3-foot-row"><span>POWER</span><b style={{ color: '#b45309' }}>{powerKw}</b></div>
          <div className="v3-foot-row"><span>ALARMS</span><b style={{ color: sev.critical ? '#dc2626' : '#1a2130' }}>{al.data ? fmtInt(sev.total) : '—'}</b></div>
          <div className="v3-foot-row"><span>VERSION</span><b>{health?.version ? `v${health.version}` : '—'}</b></div>
        </div>
      </aside>

      <div className="v3-main">
        <div className="v3-top">
          <div className="v4-modes" role="group" aria-label="보기 모드">
            {['exec', 'eng'].map((m) => (
              <button key={m} type="button" className={`v4-mode${mode === m ? ' on' : ''}`} onClick={() => setMode(m)}
                title="보기 설정입니다 — 권한·데이터 범위·임계값은 두 모드가 같습니다">{MODE_LABEL[m]}</button>
            ))}
          </div>
          <button type="button" className="v4-cmdk" onClick={() => setPaletteOn(true)} title="기능·화면 찾기 (⌘K / Ctrl+K)">
            <span className="v3-mono">⌕</span> 기능 찾기 <span className="v3-kbd">⌘K</span>
          </button>
          <label className="v3-search">
            <span className="v3-mono">⌕</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="이 화면의 표·목록 필터 (호스트 / VM / IP / 시리얼)" />
            {q ? <button type="button" className="v3-kbd" style={{ cursor: 'pointer' }} onClick={() => setQ('')}>지움</button> : <span className="v3-kbd">필터</span>}
          </label>
          <label className="v3-chip"><span>리전</span>
            <select value={region} onChange={(e) => { setRegion(e.target.value); setFocusVc(''); }}>
              <option value="">전체</option>
              {regions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label className="v3-chip"><span>vCenter</span>
            <select value={focusVc} onChange={(e) => setFocusVc(e.target.value)}>
              <option value="">{sitesAll.length ? `전체 ${sitesAll.length}` : '전체'}</option>
              {sitesAll.filter((s) => !region || s.region === region).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <span style={{ flex: 1 }} />
          <div className={`v3-live${health ? (progress?.pending || progress?.unreachable ? ' warn' : '') : ' down'}`}
            title={phaseText.long}>
            <i />{liveText(health, updated)}
          </div>
          <div className="v3-user">
            <div className="v3-avatar" title={user?.name}>{(user?.name || 'U').slice(0, 1).toUpperCase()}</div>
            <div><div className="v3-user-name">{user?.name}</div><div className="v3-user-role">{user?.role}</div></div>
          </div>
          <button type="button" className="v3-exit" onClick={() => onExit()} title="기존 개발 포탈 화면으로 돌아갑니다">개발 포탈 ↗</button>
        </div>

        <div className="v3-body">
          <div className="v3-head">
            <div>
              <div className="v3-crumb">{meta.crumb}</div>
              <div className="v3-title">{meta.title}</div>
            </div>
            <div className="v3-head-sub">
              {page === 'overview' ? overviewSub : meta.sub}
              {(region || focusVc) && <span> · 표·목록 범위: <b style={{ color: '#2563eb' }}>{focusVc ? (sitesAll.find((s) => s.id === focusVc)?.name || focusVc) : region}</b> (KPI·타일은 전사 기준)</span>}
            </div>
          </div>
          {shouldBanner(phase) && (
            <div className={`v3-banner${phase === 'first-collect' ? ' info' : ''}`}>
              {phase === 'first-collect' && progress && (
                <b className="v3-num" style={{ marginRight: 8 }}>{progress.done}/{progress.total} ({progress.pct}%)</b>
              )}
              {phaseText.long}
            </div>
          )}
          {ov.error && ov.data && <div className="v3-banner">갱신 실패(직전 데이터 표시 중): {ov.error}</div>}
          <ErrorBoundary key={page} fallback={<div className="v3-banner">이 화면을 표시하는 중 오류가 발생했습니다.</div>}>
            <Page {...pageProps} />
          </ErrorBoundary>
        </div>
      </div>
      {paletteOn && <Palette onClose={() => setPaletteOn(false)} onPick={goAnywhere} isAdmin={isAdmin} toolsAllowed={JSON.parse(allowKey)} />}
    </div>
  );
}
