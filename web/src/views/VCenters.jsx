import React, { useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { usePolling, fetchJson, toolAllowed, can } from '../api.js';
// v2.915 가상화 플랫폼 허브(설계 docs/design/virt-platform-menu 시안 A ② · ⑨): 이 화면은 허브의 'vCenter 탭' 본문이다 — 제목 · 전체 vCenter/호스트/VM 카드 · 바로가기는
//   허브(views/platform/PlatformHub.jsx)가 그리고, 여기는 카드 | 표 보기 ‖ vCenter 도구 줄 · 백업 KPI · 추이 · 카드/표만 남는다. 범위(리전 · vCenter · 검색)는 App 의 공용 바.
import HubTabs, { toolsFor } from './platform/HubTabs.jsx';
import { VC_TOOLS, VC_VIEWS, loadVcView, saveVcView } from './platform/platformText.js';
const VcTable = lazy(() => import('./platform/VcTable.jsx'));
import { growth, hasDsData, gbTb } from './tools/storageTrack.js'; // 추이 KPI(v2.358) 계산 재사용
import { Loading, ErrorBox, StateBadge, usageColor } from '../components/ui.jsx';
// v2.596(감사 PERFWEB-04): 상세는 recharts 를 쓴다 — 목록 화면이 그 청크를 받지 않게 상세를 열 때만 받는다.
const VCenterDetail = lazy(() => import('./VCenterDetail.jsx'));
// v2.671: VM 이름 검색 결과를 누르면 여는 상세 — 목록 화면이 그 청크를 받지 않게 열 때만 받는다.
const EntityDetail = lazy(() => import('../components/EntityDetail.jsx').then((m) => ({ default: m.EntityDetail })));
import { vcCardState, storageBarInfo, staleSinceText } from './vcCardText.js';   // v2.915: 바로가기 칩(vcQuickDot)은 허브(PlatformHub)가 그린다
import { dsTrendMeta } from './dsTrendKpiText.js'; // v2.631(감사 WEB2631-09)
import BoldText from '../components/boldText.jsx';
import { alarmsUnknown, restFallbackBadge } from './restFallbackText.js'; // v2.607 WEB2607-06
import STable from '../components/STable.jsx';
import { vmSearchTerm, vmSearchSummary, vcNameOf, powerLabel, memText, VM_SEARCH_LIMIT } from './vcVmSearchText.js';
import { countableTotals } from './corpSiteStatus.js'; // v2.741(WEB-01) 법인 표와 같은 '셀 수 있는 vCenter' 판정(v2.915: 전체 VM 수 — 백업 KPI 의 분모)
import { hostCapShort, hostCapFootnote, hostCapTotal } from './hostCapacityText.js'; // v2.742(LEFT-06): 용량 모름 호스트는 총량에서 빠졌다
import { parseVcRoute, vcHash, currentHash, goHash, onHashChange } from './vcd/vcdRoute.js'; // v2.895: 상세 · 개체 보기 주소(#/vcenters/<id>[/vm|host/<id>])
import { backupPairCell, backupTotals } from './veeamBadge.js'; // v2.757 카드의 VM 백업 수량 · v2.778.1 veeam/snapshot 두 수 · v2.915 표기는 Veeam / Bareos(스냅샷 제외 — 사용자 지시)

const lsSafe = () => { try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; } };

/**
 * v2.915 카드 · KPI 의 백업 칸 'veeam / bareos'(사용자 지시 2026-11-07 — 스냅샷 제외). Veeam 수는 v2.778.1 판정(backupPairCell — 못 읽으면 '—' · 부분이면 *)의 앞 수 그대로,
 * Bareos 수는 Bareos 백업 현황(/tools/bareos-summary — 도구 권한이 있을 때만 읽는다)의 법인 줄 counts.jobs(잡이 등록된 VM — 등록부를 못 읽으면 null → '—').
 * @returns {null|{ text:string, label:string, title:string, tone:string, sort:number|null }}
 */
export function backupVbCell(veeamEntry, bareosRow, vmTotal, now = Date.now(), { refreshError = '', bareosAllowed = true } = {}) {
  const pair = backupPairCell(veeamEntry, vmTotal, now, { refreshError });
  const v = pair ? pair.text.split('/')[0] : '—';
  const bN = bareosRow && bareosRow.counts && Number.isFinite(bareosRow.counts.jobs) ? bareosRow.counts.jobs : null;
  const b = bN == null ? '—' : String(bN);
  if (!pair && bN == null) return null;
  const veeamPara = pair ? pair.title.split('\n\n[스냅샷]')[0] : 'Veeam 서버와 연동되지 않았습니다 — 설정 › 백업 › Veeam 백업 서버에서 등록하면 Veeam 기준 수가 나옵니다.';
  const bareosPara = !bareosAllowed ? 'Bareos 백업 현황 도구 권한이 없어 Bareos 수를 읽지 않았습니다.'
    : bN == null ? 'Bareos: 이 법인의 Bareos 등록부를 아직 읽지 못했거나(Director 미등록 · 수집 전) 도구가 응답하지 않았습니다 — 0대가 아닙니다.'
      : `Bareos: 잡이 등록된 VM ${bN}대(Bareos 백업 현황 › 법인 줄과 같은 수 · 성공 여부는 그 화면에서).`;
  const vNum = pair && /^\d/.test(v) ? Number(v.replace('*', '')) : null;
  return {
    text: `${v}/${b}`, label: 'veeam/bareos', tone: pair ? pair.tone : 'none',
    title: `veeam/bareos — Veeam 백업 대상 ${v} / Bareos 잡 등록 ${b}${Number.isFinite(vmTotal) ? ` (VM ${vmTotal}대 중)` : ''}\n\n${veeamPara.replace(/^veeam\/snapshot[^\n]*\n\n/, '')}\n\n${bareosPara}`,
    sort: vNum == null && bN == null ? null : (vNum || 0) + (bN || 0),
    ...(pair?.refreshFailed ? { refreshFailed: true } : {}),
  };
}

/** 열린 vCenter 의 앞 · 뒤(상세 브레드크럼의 ‹ 이전 · 다음 ›) — 목록 순서 그대로. 없으면 null. */
export function siblingsOf(sites, id) {
  const list = Array.isArray(sites) ? sites : [];
  const i = list.findIndex((s) => s && s.id === id);
  if (i < 0) return { prev: null, next: null, index: -1, total: list.length };
  return { prev: list[i - 1] || null, next: list[i + 1] || null, index: i, total: list.length };
}

/**
 * v2.732(점검 2회차 B2-01 후속, 그룹 i3): 위임(site) vCenter 의 담당 엣지 push 가 끊겨 값이 낡으면 서버는 status 를 엣지가 마지막으로 보낸
 * 'connected' 그대로 두고 `stale` 만 붙인다(헤더 N/M 계약 — 리드 결정). 카드 본문·바로가기 점은 vcCardState 로 이미 호박색인데 카드 머리의
 * 상태 배지만 초록 'Connected' 로 남아 한 카드가 정상과 낡음을 동시에 말했다. 판정은 vcCardState().stale 하나다(복제 금지).
 */
export function VcStateBadge({ s, cs = null, now = Date.now() }) {
  const st = cs || vcCardState(s, now);
  if (st.stale) {
    const since = staleSinceText(s, now);
    return (
      <span className="badge amber" data-vc-stale=""
        title={`상태 ‘${s?.status || '—'}’ 는 담당 엣지가 마지막으로 보낸 값입니다 — ${since ? `마지막 수신 ${since}` : '마지막 수신 시각을 모릅니다'}(지금 값이 아닙니다)`}>낡은 값</span>
    );
  }
  return <StateBadge state={s?.status} />;
}

/** 상단 KPI '전체 vCenter' 의 메타 — 연결됨 수는 그대로(헤더 N/M 계약)이고 그중 낡은 값 개수를 함께 말한다. `{ text, title }`. */
export function vcCountMeta(sites, now = Date.now()) {
  const list = Array.isArray(sites) ? sites : [];
  const connected = list.filter((s) => s?.status === 'connected').length;
  const stale = list.filter((s) => vcCardState(s, now).stale).length;
  return {
    text: `연결됨 ${connected}${stale ? `(낡은 값 ${stale} 포함)` : ''} · 불가 ${list.length - connected}`,
    title: stale ? '낡은 값 — 위임 vCenter 의 담당 엣지가 인벤토리를 보내지 않아 마지막으로 받은 값을 보이는 중입니다(상태는 엣지가 마지막으로 보낸 값)' : undefined,
  };
}

/**
 * 전체 vCenter VM 이름 조회(v2.671, 사용자 요청 "이 화면의 검색에서 전체 vcenter 를 검색해서 vm 이름으로 조회").
 * 입력이 멈추고 300ms 뒤 서버 /vms?nameOnly=1 을 한 번 부른다(폴링 안 함). 늦게 온 이전 응답은 버린다.
 * 범위(scope)는 서버가 강제하고, inv.vms 권한이 없으면 부르지 않고 그 사실을 말한다.
 */
function VmNameSearch({ term, sites }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState(null);
  const allowed = can('inv.vms');
  useEffect(() => {
    setData(null); setErr('');
    if (!term || !allowed) return undefined;
    let active = true;
    const t = setTimeout(() => {
      fetchJson('/vms', { q: term, nameOnly: '1', sortBy: 'name', order: 'asc', limit: VM_SEARCH_LIMIT })
        .then((r) => { if (active) setData(r); })
        .catch((e) => { if (active) setErr(e?.status === 403 ? 'VM 목록 조회 권한이 없습니다(설정 › 사용자 관리 › 권한).' : `VM 조회 실패: ${e?.message || e}`); });
    }, 300);
    return () => { active = false; clearTimeout(t); };
  }, [term, allowed]);
  if (!term) return null;
  const items = Array.isArray(data?.items) ? data.items : [];
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="flex between" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        <b>VM 이름 검색 — 전체 vCenter</b>
        <span className="muted" style={{ fontSize: 12 }}>{!allowed ? 'VM 목록 조회 권한이 없어 VM 은 찾지 않았습니다.' : err || vmSearchSummary(term, data)}</span>
      </div>
      {items.length > 0 && (
        <STable className="v3-table" minWidth={760}>
          <thead><tr><th>VM 이름</th><th>vCenter</th><th>호스트</th><th>전원</th><th>IP</th><th>vCPU</th><th>메모리</th><th>게스트 OS</th></tr></thead>
          <tbody>
            {items.map((v) => (
              <tr key={v.id} style={{ cursor: 'pointer' }} title="클릭 — VM 상세" onClick={() => setSel(v)}>
                <td><b>{v.name}</b></td>
                <td>{vcNameOf(sites, v.vcenterId)}</td>
                <td className="muted">{v.host || '—'}</td>
                <td data-sort={v.powerState || ''}>{powerLabel(v.powerState)}</td>
                <td className="muted">{v.ipAddress || '—'}</td>
                <td data-sort={v.cpuCount ?? ''}>{v.cpuCount ?? '—'}</td>
                <td data-sort={v.memMB ?? ''}>{memText(v.memMB)}</td>
                <td className="muted">{v.guestOS || '—'}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      )}
      {sel && <Suspense fallback={null}><EntityDetail type="vm" item={sel} onClose={() => setSel(null)} /></Suspense>}
    </div>
  );
}

/** 미니 스파크라인(v2.358) — recharts 를 끌어오지 않는 순수 SVG(Platform 은 차트 벤더 청크 미로드). */
function Spark({ points, color }) {
  const vals = (points || []).filter((v) => v != null && Number.isFinite(Number(v)));
  if (vals.length < 2) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const W = 130;
  const H = 28;
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * W).toFixed(1)},${(H - ((v - min) / span) * (H - 4) - 2).toFixed(1)}`).join(' ');
  return (
    <svg width={W} height={H} style={{ display: 'block', marginTop: 6, opacity: 0.9 }} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

/**
 * Platform 상단 추이 KPI 2장(v2.358, 사용자 요구) — VM 수·스토리지 사용량의 30일 증가 추이.
 * 데이터는 vm-track 의 00/12시 스냅샷(GET /tools/vm-track, scope 서버 강제)을 5분 주기로 읽는다.
 * tools 권한이 없거나 추적 DB 불가면 카드 자체를 숨긴다(대시보드 소음 방지). 클릭 → 해당 추이 화면.
 */
function TrendKpis() {
  const [d, setD] = useState(null);
  const [dead, setDead] = useState(false);
  // v2.616: 도구 권한이 없으면 부르지 않는다 — 예전에는 viewer 가 이 화면을 열 때마다(5분마다) 403 을 만들었다
  //   (주석은 '권한이 없으면 카드를 숨긴다' 였지만 숨기기 전에 먼저 호출했다). V5 전수 검증에서 발견.
  const allowed = toolAllowed('vm-track');
  useEffect(() => {
    if (!allowed) return undefined;
    let on = true;
    const load = () => fetchJson('/tools/vm-track', { days: 30 })
      .then((r) => { if (on) { setD(r); setDead(false); } })
      .catch(() => { if (on) setDead(true); });
    load();
    const t = setInterval(load, 300_000);
    return () => { on = false; clearInterval(t); };
  }, [allowed]);
  if (!allowed || dead || !d) return null;
  const pts = d.points || [];
  const vmFirst = pts[0] || null;
  const vmLast = pts[pts.length - 1] || null;
  const vmNet = vmFirst && vmLast ? vmLast.total - vmFirst.total : 0;
  const sumAdded = pts.reduce((a, p) => a + (p.added || 0), 0);
  const sumRemoved = pts.reduce((a, p) => a + (p.removed || 0), 0);
  const g = growth(pts); // 스토리지 순증감 — 구버전(ds 열 0) 행은 내부에서 기준 제외(v2.351 원칙)
  const dsLast = [...pts].reverse().find(hasDsData) || null;
  const go = (h) => { window.location.hash = h; };
  return (
    <>
      <div className="card kpi" onClick={() => go('#/tools/vm-track')} style={{ cursor: 'pointer' }} title="클릭 — VM 수량 추이 화면">
        <div className="label">VM 증가 추이(30일)</div>
        <div className="value" style={{ color: vmNet > 0 ? 'var(--green)' : vmNet < 0 ? 'var(--red)' : undefined }}>
          {vmLast ? `${vmNet > 0 ? '+' : ''}${vmNet.toLocaleString()}` : '—'}
        </div>
        <div className="meta">{vmLast ? `생성 +${sumAdded.toLocaleString()} · 삭제 −${sumRemoved.toLocaleString()}` : '스냅샷 없음(매일 00·12시 자동)'}</div>
        <Spark points={pts.map((p) => p.total)} color="#60a5fa" />
      </div>
      <div className="card kpi" onClick={() => go('#/tools/storage-track')} style={{ cursor: 'pointer' }} title="클릭 — 스토리지 사용량 추이 화면">
        <div className="label">스토리지 증가 추이(30일)</div>
        <div className="value" style={{ color: g.netGB > 0 ? 'var(--amber)' : g.netGB < 0 ? 'var(--green)' : undefined }}>
          {dsLast ? `${g.netGB > 0 ? '+' : ''}${gbTb(g.netGB)}` : '—'}
        </div>
        {/* v2.631(감사 WEB2631-09): 사용률 null 을 '(0%)' 로, 용량 0 슬롯을 '사용 0 / 0 TB' 로 그리지 않는다(dsTrendMeta). */}
        <div className="meta">{dsTrendMeta(dsLast)}</div>
        <Spark points={pts.map((p) => (hasDsData(p) ? p.dsUsedGB : null))} color="#f59e0b" />
      </div>
    </>
  );
}

/* 메모리 사용/전체 병기 — 1TB 이상이면 TB로, 아니면 GB로(자릿수 폭주 방지). 값 없으면 미표기. */
function fmtMem(usedGB, totalGB) {
  if (usedGB == null || !totalGB) return undefined;
  if (totalGB >= 1024) return `${(usedGB / 1024).toFixed(1)}/${(totalGB / 1024).toFixed(1)} TB`;
  return `${usedGB}/${totalGB} GB`;
}

function Bar({ label, pct, detail, title }) {
  return (
    <div className="vc-metric" title={title}>
      <div className="vc-mlabel"><span>{label}</span><b>{pct == null ? '—' : `${pct}%`}{detail ? ` · ${detail}` : ''}</b></div>
      <div className="usage-bar"><span style={{ width: `${pct == null ? 0 : Math.min(pct, 100)}%`, background: usageColor(pct ?? 0) }} /></div>
    </div>
  );
}

export default function VCenters({ onSelectSite, onGoVms, resetSignal, scope = {}, summary = null }) {
  const { data, error, loading } = usePolling('/vcenters', {}, 15_000);
  // v2.895: 연 vCenter 는 주소에서 읽는다(#/vcenters/<id> — 새로고침 · 공유 · 뒤로 가기). 열고 닫기는 주소를 바꾸고, hashchange 가 상태를 맞춘다.
  const [openId, setOpenIdState] = useState(() => parseVcRoute(currentHash()).vcId);
  const setOpenId = (id) => { goHash(vcHash(id || null)); setOpenIdState(id || null); };
  useEffect(() => onHashChange(() => {
    const h = currentHash();
    if (/^#\/?vcenters(\/|$)/.test(h)) setOpenIdState(parseVcRoute(h).vcId);
  }), []);
  // v2.757(사용자 요청): 카드의 'VM 백업 수량' — Veeam 연동이면 Veeam 기준, 아니면 스냅샷 기준. 60초마다(v2.759 — 상세를 연 동안은 멈춘다).
  //   실패해도 카드는 그대로 — 첫 응답 전 실패면 백업 칸만 그리지 않고, 받은 뒤의 갱신 실패는 칸에 '최근 갱신 실패' 표지(v2.763 V5-I1).
  //   v2.759: 서버는 전용 DB 에서 바로 답한다(응답 캐시 60초) — 고정 60초. 업그레이드 직후 '준비 중' 인 vCenter 도 1분 안에 채워진다.
  //   ⚠ 주기를 상태에 따라 바꾸지 말 것 — usePolling 은 주기가 바뀌면 데이터를 비우고 다시 묻는다('준비 중' ↔ 주기 전환이 무한 재요청이 됐다).
  const backupP = usePolling(openId ? null : '/veeam/backup-counts', {}, 60_000);
  const backupBy = backupP.data?.byVc || null;
  // v2.763(V5-I1): 받은 값이 있는데 최근 갱신이 실패했다 — 칸은 그리되 '최근 갱신 실패' 표지(backupCell refreshError).
  const backupRefreshErr = backupP.data && backupP.error ? String(backupP.error) : '';
  // v2.915: 찾기 칸은 App 의 공용 범위 바(세 탭 공용 — ⌘K '모두 보기' 검색어도 App 이 그 칸에 넣는다). 여기서는 받은 값으로만 거른다.
  const query = String(scope?.q || '');
  // v2.915 카드 | 표 보기(브라우저 기억) · Bareos 수(도구 권한이 있을 때만 · 상세를 연 동안은 멈춘다) — 훅은 조기 return 위에(React #310).
  const [vcView, setVcViewState] = useState(() => loadVcView(lsSafe()));
  const setVcView = (v) => { setVcViewState(v); saveVcView(lsSafe(), v); };
  const bareosOk = toolAllowed('bareos-summary');
  const bareosP = usePolling(openId || !bareosOk ? null : '/tools/bareos-summary', {}, 60_000);
  const bareosBy = useMemo(() => new Map((Array.isArray(bareosP.data?.rows) ? bareosP.data.rows : []).map((r) => [r.id, r])), [bareosP.data]);
  const byVc = useMemo(() => new Map((Array.isArray(summary?.byVc) ? summary.byVc : []).map((r) => [r.id, r])), [summary]);
  // 상단메뉴 Platform 재클릭(resetSignal 증가) 시 vCenter 상세 드릴다운을 닫고 전체 목록으로 복귀.
  // v2.895: 첫 렌더(주소로 바로 연 상세)에는 닫지 않는다 — 신호가 실제로 바뀐 뒤에만.
  const resetSeen = useRef(resetSignal);
  useEffect(() => {
    if (resetSeen.current === resetSignal) return;
    resetSeen.current = resetSignal;
    setOpenIdState(null);
    goHash('#/vcenters');
  }, [resetSignal]);
  const cardRefs = useRef({}); // vCenter id → 카드 DOM(v2.915: 바로가기 칩은 허브 범위를 바꾸므로 카드 스크롤 · 반짝(gotoCard)은 뺐다 — 고른 법인 카드만 남는다)
  if (loading && !data) return <Loading />;
  // 데이터 보유 중 일시 폴링 오류로 전체 화면을 갈아치우지 않는다(고RTT 깜빡임 방지).
  if (error && !data) return <ErrorBox message={error} />;

  const sites = data || [];
  const openSite = sites.find((s) => s.id === openId);
  // v2.915: 상세에 ‹ 이전 · 다음 › vCenter(목록 순서) — 브레드크럼 줄에서 법인을 옮겨 다닌다(시안 ⑤)
  if (openSite) return <Suspense fallback={<Loading />}><VCenterDetail site={openSite} onBack={() => setOpenId(null)} siblings={siblingsOf(sites, openId)} onOpen={(id) => setOpenId(id)} /></Suspense>;
  // v2.915 허브 범위(리전 · vCenter)로 먼저 거른다 — 세 탭이 같은 범위를 쓴다. 검색은 그 다음.
  const regSel = String(scope?.region || ''); const vcSel = String(scope?.vcenterId || '');
  const inScope = sites.filter((s) => (!vcSel || s.id === vcSel) && (!regSel || s.location?.region === regSel));
  // 공백 구분 다중 키워드 AND — 이름·id·도시·국가·리전·버전에서 검색(허브 검색과 같은 규칙).
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = keywords.length === 0 ? inScope : inScope.filter((s) => {
    const hay = [s.name, s.id, s.location?.city, s.location?.country, s.location?.region, s.version]
      .filter(Boolean).join(' ').toLowerCase();
    return keywords.every((kw) => hay.includes(kw));
  });
  // v2.732(그룹 i3) vcCountMeta(연결됨 수 + 낡은 값)는 v2.915 부터 허브의 엔티티 탭이 서버 요약으로 말한다(이 파일의 export 는 테스트 · 다른 화면이 쓴다).
  // 다빈치/IRS 분류(사용자 요구): vCenter 이름에 'IRS'(단어, 대소문자 무시 — 예: AZ-IRS·GM1-IRS)가
  // 들어가면 IRS, 나머지(AZ·GM1 등)는 다빈치. 하이픈은 단어 경계라 '-IRS' 접미가 매칭된다.
  // VM(v2.323)·호스트(v2.324) 두 KPI 가 같은 규칙을 쓴다.
  const isIrs = (s) => /\birs\b/i.test(s.name || '');
  // v2.741(WEB-01): 첫 수집 중·비활성·연결 실패 vCenter 의 hosts:0·vms:0 을 더하지 않는다(법인 표와 같은 corpSiteStatus 판정).
  //   뺀 곳이 있으면 KPI 가 '최소 · 미수집 N곳 제외' 를 말한다 — 부분 합을 합계처럼 보이지 않게.
  const tot = countableTotals(sites, { isIrs });
  const num = (v) => (v == null ? '—' : v.toLocaleString());
  // v2.778.1(사용자 결정 '알람 카드를 바꾼다'): 상단 '활성 알람' 자리에 VM 백업 — 전체 VM · Veeam 기준 · 스냅샷 기준(vCenter 카드와 같은 값의 합).
  //   알람 수는 vCenter 카드·알람 화면·상태바에 남는다.
  const bt = backupTotals(backupBy, sites.map((s) => s.id));
  const btUnknown = bt ? [bt.veeamUnknown ? `Veeam 확인 불가 ${bt.veeamUnknown}곳` : ''].filter(Boolean).join(' · ') : '';
  // v2.915 Bareos 합(도구 응답의 totals.jobs — 등록부를 못 읽은 법인이 있으면 partial) · 카드 · 표의 백업 칸 글자 하나(backupVbCell)
  const bTot = bareosP.data?.totals || null;
  const bareosSum = bTot && Number.isFinite(bTot.jobs) ? bTot.jobs : null;
  const backupTextOf = (s) => backupVbCell(backupBy?.[s.id], bareosBy.get(s.id) || null, Number.isFinite(s.metrics?.vms) ? s.metrics.vms : null, Date.now(), { refreshError: backupRefreshErr, bareosAllowed: bareosOk });
  // 허브 탭 줄: 카드 | 표 ‖ vCenter 성격의 특수 기능(권한 없는 도구는 숨김 — 도구 키 그대로)
  const vcTools = toolsFor(VC_TOOLS);

  return (
    <>
      {error && <div className="card" style={{ marginBottom: 8, padding: '8px 12px', color: 'var(--red)', fontSize: 12 }}>일시적 갱신 오류: {String(error.message || error)} — 직전 데이터를 표시 중입니다.</div>}
      {/* v2.915: 전체 vCenter · 호스트 · VM 카드 3장은 허브의 엔티티 탭이 대신한다 — 남은 KPI(백업 · 추이)만. 카드 폭이 넓어져 글자 축소 규칙은 그대로 둔다. */}
      <HubTabs label="vCenter 보기 · 도구" active={vcView} tools={vcTools}
        views={VC_VIEWS.map(([k, label]) => ({ k, label: k === 'table' ? `${label} · 법인별 비교` : label, onClick: () => setVcView(k) }))} />
      <div className="kpis kpis-1row ph-kpis" style={{ margin: '12px 0 18px' }}>
        <div className="card kpi" data-kpi-backup=""
          title={'VM 백업 — veeam/bareos\nVeeam: 연동된 Veeam 서버가 백업 대상으로 가진 VM 수(vCenter 카드의 앞 수 합)\nBareos: 각 법인 Bareos 에 잡이 등록된 VM 수(Bareos 백업 현황의 법인 줄 합 — 도구 권한이 있을 때만)\n못 읽은 vCenter 는 0 으로 더하지 않고 따로 셉니다' + (bt?.partial || bTot?.partial?.jobs ? '\n* 일부만 읽은 vCenter 가 있어 실제보다 적을 수 있습니다' : '')}>
          <div className="label">VM 백업 (Veeam / Bareos)</div>
          {(() => {
            const t = `${bt ? `${num(bt.veeam)}${bt.partial ? '*' : ''}` : '—'}/${bareosSum == null ? '—' : `${num(bareosSum)}${bTot?.partial?.jobs ? '*' : ''}`}`;
            // 실서버 규모(VM 5천+)면 '3,200/1,500' 처럼 길어진다 — 카드 폭을 넘지 않게 글자를 줄인다
            return <div className="value" style={{ color: 'var(--green)', whiteSpace: 'nowrap', ...(t.length > 9 ? { fontSize: t.length > 11 ? 18 : 22 } : {}) }}>{t}</div>;
          })()}
          <div className="meta">전체 VM {num(tot.vms)} · Veeam {bt ? num(bt.veeam) : '—'} · Bareos {bareosSum == null ? (bareosOk ? '—' : '권한 없음') : num(bareosSum)}</div>
          {btUnknown && <div className="meta" data-partial-note="">{btUnknown} 제외</div>}
        </div>
        <TrendKpis />
      </div>

      <VmNameSearch term={vmSearchTerm(query)} sites={sites} />

      {keywords.length > 0 && shown.length === 0 && (
        <div className="card" style={{ padding: '18px 16px', color: 'var(--text-dim)' }}>
          "{query}" 와 일치하는 vCenter가 없습니다 — vCenter 는 이름·id·도시·국가·리전·버전에서, VM 은 위 표에서 이름으로 찾습니다.
        </div>
      )}

      {/* v2.742(LEFT-06): 용량(코어·CPU·메모리 총량)을 못 읽은 호스트가 있는 카드는 짧은 표지만 달고, 이유는 여기서 한 번 말한다. */}
      {hostCapFootnote(hostCapTotal(shown)) && (
        <div className="muted" data-hostcap-note="" style={{ fontSize: 12, margin: '0 0 8px', whiteSpace: 'normal', lineHeight: 1.6 }}>ⓘ {hostCapFootnote(hostCapTotal(shown))}</div>
      )}
      {vcView === 'table' && (
        <Suspense fallback={<Loading />}>
          <VcTable sites={shown} byVc={byVc} backupText={backupTextOf} onOpen={(id) => setOpenId(id)} onGoHosts={(id) => onSelectSite && onSelectSite(id)} onGoVms={(id) => onGoVms && onGoVms(id)} />
        </Suspense>
      )}
      <div className="vc-grid" style={vcView === 'table' ? { display: 'none' } : undefined}>
        {shown.map((s) => {
          const m = s.metrics || {};
          const cs = vcCardState(s); // v2.583 #39: 상태별 본문(대기·점검·비활성·연결 실패를 나눈다)
          return (
            <div className="card vc-card" key={s.id} ref={(el) => { cardRefs.current[s.id] = el; }} onClick={() => setOpenId(s.id)}>
              <div className="vc-head">
                <div>
                  <div className="vc-name">{s.name}</div>
                  <div className="vc-loc">📍 {s.location?.city}, {s.location?.country} · {s.location?.region}</div>
                </div>
                <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {restFallbackBadge(s) && <span className="badge amber" title={restFallbackBadge(s).title}>{restFallbackBadge(s).label}</span>}
                  <VcStateBadge s={s} cs={cs} />
                </div>
              </div>

              {cs.text && cs.showMetrics && (
                <div className="muted" style={{ fontSize: 12, margin: '6px 0', color: cs.authStopped ? 'var(--red)' : 'var(--amber)' }}><BoldText text={cs.text} /></div>
              )}
              {!cs.showMetrics ? (
                <div style={{ padding: '12px 0' }}>
                  <div className="muted" style={{ marginBottom: 6 }}><BoldText text={cs.text} /></div>
                  {cs.showError && s.error && <div className="diag-err-msg" style={{ fontSize: 12 }}>{s.error}</div>}
                  {cs.showError && s.hint && <div className="diag-err-hint" style={{ fontSize: 12 }}>💡 {s.hint}</div>}
                </div>
              ) : (
                <>
                  <div className="vc-counts">
                    {/* v2.915: 숫자를 누르면 허브 범위를 이 법인으로 두고 호스트 · VM 탭으로(카드 클릭(상세)과 겹치지 않게 전파를 막는다) */}
                    <button type="button" className="vc-count vc-count-go" title="호스트 탭을 이 법인 범위로" onClick={(e) => { e.stopPropagation(); if (onSelectSite) onSelectSite(s.id); }}><b>{m.hosts}</b><span>호스트 →</span></button>
                    <button type="button" className="vc-count vc-count-go" title="VM 탭을 이 법인 범위로" onClick={(e) => { e.stopPropagation(); if (onGoVms) onGoVms(s.id); }}><b>{m.vms}</b><span>VM ({m.vmsPoweredOn} on) →</span></button>
                    {alarmsUnknown(s)
                      ? <div className="vc-count" title="REST 폴백 수집 — 경보를 조회하지 않았습니다(0건이 아닙니다)"><b style={{ color: 'var(--text-dim)' }}>—</b><span>알람(미조회)</span></div>
                      : <div className="vc-count"><b style={{ color: m.alarmsCritical ? 'var(--red)' : m.alarmsWarning ? 'var(--amber)' : 'var(--green)' }}>{(m.alarmsCritical || 0) + (m.alarmsWarning || 0)}</b><span>알람</span></div>}
                    {(() => {
                      const bk = backupTextOf(s);   // v2.915: veeam/bareos(스냅샷 제외) — Veeam 수는 v2.778.1 판정 그대로
                      return bk && <div className={`vc-count vc-bk ${bk.tone}`} data-backup={bk.tone} title={bk.title}><b>{bk.text}</b><span>{bk.label}</span></div>;
                    })()}
                  </div>
                  <Bar label="CPU" pct={m.cpuUsagePct ?? null} detail={m.cpuTotalGhz ? `${m.cpuUsedGhz}/${m.cpuTotalGhz} GHz${m.hostsUsageExcluded ? ' *' : ''}` : undefined}
                    title={m.hostsUsageExcluded ? `* 연결 끊긴 호스트 ${m.hostsUsageExcluded}대는 사용량을 알 수 없어 사용률(%) 계산에서 뺐습니다(GHz 합계에는 포함)` : undefined} />
                  <Bar label="메모리" pct={m.memUsagePct ?? null} detail={fmtMem(m.memUsedGB, m.memTotalGB)} />
                  {hostCapShort(m.hostsCapacityUnknown) && (
                    <div className="muted" data-hostcap="" style={{ fontSize: 11, margin: '-2px 0 4px', color: 'var(--amber)' }} title={hostCapFootnote(m.hostsCapacityUnknown)}>
                      ⓘ CPU·메모리 총량: {hostCapShort(m.hostsCapacityUnknown)}
                    </div>
                  )}
                  <Bar label="스토리지" {...storageBarInfo(m)} />
                </>
              )}

              <div className="vc-foot">
                <span className="muted">v{s.version || '—'}{s.build ? ` · build ${s.build}` : ''}</span>
                <span className="muted">{s.id} →</span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
