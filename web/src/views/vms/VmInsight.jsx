// views/vms/VmInsight.jsx — VM 탭 ‘분석’ 보기(v3.21.0 · 설계 docs/design/vm-insight · 시안 VmInsight.dc.html — 사용자 확정 기본값).
//   순서: 요약 6장 / 확인할 것 한 줄 / 묶음 접기 — 지금 볼 것(‘VM 현황’ 지도 + 지역별 분포 · 지금 볼 VM) · 용량과 정리 · 성능 · 구성 점검 · 분포.
//   값: GET /api/vms/insight(법인마다 한 줄 + 법인마다 상위 N · 30초 폴링 — 범위 리전만 싣는다) → 바로가기에서 고른 법인의 줄을 화면이 더한다(insight/insightCore.js).
//     오래됨 · 모름 법인은 합에 섞지 않고 따로 밝힌다. 특수 기능 요약 패널은 insight-tools(다른 컴포넌트 — 마운트 1회 + ‘다시 받기’)가 그린다.
//   새 판정 없음 — 신호 · 기준값은 응답의 thresholds, 도구 패널은 각 도구 판정. 도구 권한이 없으면 그 패널 · ‘과할당’ 칸을 숨긴다(canHubTool — 허브 도구 칸과 같은 판정).
//   mode='over' 면 ‘과할당’ 보기(VmOverView — Optimization 요약)를 같은 응답의 법인 줄로 그린다.
import React, { useEffect, useMemo, useState } from 'react';
import { usePolling, toolAllowed } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { useNarrowScreen } from '../../components/useNarrowScreen.js';
import { numOrNull } from '../../numOrNull.js';
import { scopeIdsOf, normScopeIds, toggleScopeId } from '../platform/platformText.js';
import { vcHash } from '../vcd/vcdRoute.js';
import { pickRows, toolIdsOf, fmtN, fmtU, gbText, shareText, barPct } from '../insight/insightCore.js';
import { treemapLayout, maxTilesInCol, fillStep, tileColors, scaleLegend, RAMP, CRIT_BG, NONE_BG } from '../insight/treemap.js';
import { mapHeightOf, autoMapHeight } from '../insight/insightPrefs.js';
import { maxTilesPacked, worstMember, groupCountsText } from '../insight/tilePack.js'; // v3.23.0 지도 칸 글자(설계 docs/design/insight-tiles)
import { useFolded, useLazyJson } from '../insight/useInsight.js';
import Treemap from '../insight/Treemap.jsx';
import { useMapPrefs, MapSizeSeg, MapSizeBox } from '../insight/MapSize.jsx';
import { NumTile, CheckLine, PanelHead, StackBar, RankBars, KvRows, Histogram, Hero, MiniStats, FoldGroup } from '../insight/InsightParts.jsx';
import {
  sumVmRows, mergedTops, kpiView, checkBase, fillDefs, SIZE_DEFS, mapGroups, regionRows, osRows, sizeBinRows, hwRows, snapBands,
  hostAvgMemGB, hostsEquivalent, mbToGb, wasteSum, corpName, arrangeChecks, regionName, VM_FOLD_GROUPS, VM_FOLD_KEYS, VM_MAP_PREF_KEY, VM_FOLD_PREF_KEY,
} from './vmInsightText.js';
import { canHubTool } from './VmHubTabs.jsx';
import VmToolPanels from './insight-tools/VmToolPanels.jsx';
import VmOverView from './insight-tools/VmOverView.jsx';
import { checkItems } from './insight-tools/vmToolChecks.js';
import { useToolSummary } from './insight-tools/useToolSummary.js';
import { toolLabel } from './insight-tools/toolSumText.js';
import { buildSnapHash } from '../tools/snapshots/snapText.js';
import '../insight/insight.css';

const C = Object.freeze({ blue: '#3987e5', orange: '#d95926', gray: '#4b5873', amber: '#f59e0b', serious: '#ec835a', red: '#ef4444', none: NONE_BG, faint: '#8b9bb4' });
const FAMILY_BG = Object.freeze({ linux: C.blue, windows: C.orange, other: C.faint });

/**
 * @param {object} p
 * @param {'insight'|'over'} [p.mode]
 * @param {object} p.filters            App 의 허브 범위 쿼리(hubScopeQuery 결과 + 검색어 등) — scopeIds 가 없을 때 고른 법인을 여기서 읽는다
 * @param {string[]|null} [p.scopeIds]  바로가기에서 고른 법인(App 허브 칸 vcenterIds)
 * @param {string} [p.scopeRegion]      허브 범위 리전
 * @param {(ids:string[])=>void} [p.onScopeIds]  고른 법인 목록을 바꾼다(App patchFilter({ vcenterIds })) — 지도 칸 · 지역 줄
 * @param {(hub:{sc:object})=>void} [p.onHub]    보기 줄의 ‘조치 필요’ 배지 · 드로어 기준 일수
 */
export default function VmInsight({ mode = 'insight', filters = {}, scopeIds = null, scopeRegion = null, onScopeIds = null, onHub = null }) {
  const ids = useMemo(() => normScopeIds(Array.isArray(scopeIds) ? scopeIds : scopeIdsOf(filters)), [JSON.stringify(scopeIds), filters?.vcenterId, filters?.vcenterIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const region = String(scopeRegion ?? filters?.region ?? '');
  // 범위 리전만 싣는다 — 고른 법인은 싣지 않는다(서버는 범위 안 법인 줄을 다 주고 화면이 더한다 — 선택을 바꿀 때 서버 왕복이 없다).
  const { data, error, loading } = usePolling('/vms/insight', region ? { region } : {}, 30_000);
  const narrow = useNarrowScreen('(max-width: 720px)');
  const [folded, toggleFold] = useFolded(VM_FOLD_PREF_KEY, VM_FOLD_KEYS);
  const [mapPrefs, setMapPrefs] = useMapPrefs(VM_MAP_PREF_KEY);
  const [cfgOpen, setCfgOpen] = useState(false);
  const [mapW, setMapW] = useState(null);   // v3.23.0: 지도가 잰 폭(px) — 자동 높이를 여러 열 기준으로
  const [fillKey, setFillKey] = useState('att');
  const [sizeKey, setSizeKey] = useState('n');
  const rows = useMemo(() => (Array.isArray(data?.rows) ? data.rows : []), [data]);
  const th = data?.thresholds || {};
  // 도구 권한 — 허브 도구 칸과 같은 판정(canHubTool = toolsFor) + 서버 집행 축(toolAllowed — tools 권한 · 도구별 허용/거부)을 바닥으로(CATALOG2613-02 스윕).
  const canTool = (k) => canHubTool(k) && toolAllowed(k);
  // 리뷰 정정: 도구 요약(?summary=1)은 리전을 모른다(범위 안 법인 줄 전부) — 리전만 고르고 법인을 고르지 않았으면 이 응답의 법인(그 리전)으로 좁혀
  //   도구 패널 · ‘확인할 것’ 의 도구 칸이 위 수와 같은 범위를 더하게 한다(예전에는 리전과 무관하게 전 법인 합이었다).
  //   dbg3221 2회차: 도구 칸 · 패널도 본체 합과 같은 법인 집합(오래됨 · 모름 법인 제외 — toolIdsOf). null = 고른 법인이 모두 오래됨 · 모름이거나 응답에 고른 법인 줄이 0개(7회차) → 도구 칸 · 패널을 그리지 않는다.
  const picked = useMemo(() => pickRows(rows, ids), [rows, ids]);
  const toolIdsRaw = toolIdsOf({ ids, region, rows, picked, loaded: !!data });
  const toolIds = toolIdsRaw ?? [];
  const toolCan = toolIdsRaw == null ? () => false : canTool;
  // ‘과할당’ 보기에서는 확인할 것 · 지도를 그리지 않는다 — 캐시 없는 게스트 파티션 조회를 보내지 않는다.
  const insightOn = mode !== 'over';
  // 도구 쪽 ‘확인할 것’ 칸(디스크가 차 가는 VM · 꺼진 VM) — insight-tools 의 훅(checkItems = useVmToolChecks). 조기 return 위에서 늘 부른다.
  const toolChecks = checkItems({ vcIds: toolIds, canTool: insightOn ? toolCan : () => false });
  // 게스트 파티션 · Optimization 요약은 insight-tools 의 칸(useToolSummary — 경로 · 쿼리 · 옵션이 같으면 요청 한 번을 나눠 본다)을 같이 본다.
  //   지도 ‘디스크 초과 VM 비율’ · 회수 후보의 CPU · 메모리 후보 수가 이 값 — 따로 부르면 캐시 없는 게스트 파티션 조회가 두 번 나간다.
  const gpOk = insightOn && canTool('guest-partition');
  const gp = useToolSummary('/tools/guest-partition', null, { enabled: gpOk, timeoutMs: 60_000, retries: 0 });
  const waste = useToolSummary('/tools/waste', null, { enabled: canTool('waste') });
  // 분포 묶음을 펼쳤을 때만: 호스트 법인 요약(S2 환산 기준 — 고른 범위 호스트 한 대의 평균 메모리 · memo 30초)
  const distOpen = mode === 'insight' && !folded.dist;
  const hostCorp = useLazyJson('/hosts/corp', region ? { region } : {}, distOpen);

  const s = useMemo(() => sumVmRows(picked.used), [picked]);
  const usedIds = useMemo(() => picked.used.map((r) => String(r.id)), [picked]);
  const tops = useMemo(() => mergedTops(data?.top, usedIds, numOrNull(th.topN) ?? 5), [data, usedIds, th.topN]);
  const nameOf = useMemo(() => new Map(rows.map((r) => [String(r.id), corpName(r)])), [rows]);
  // 보기 줄의 ‘조치 필요’ 배지 · 드로어 기준 일수 — 새 응답 · 선택이 바뀔 때만 올린다.
  const sigKey = data ? JSON.stringify([s.signals, s.attention, th.snapAgeDays]) : '';
  useEffect(() => {
    if (data && onHub) onHub({ sc: { ...(s.signals || {}), any: s.attention ?? null, snapAgeDays: th.snapAgeDays ?? null } });
  }, [sigKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  if (mode === 'over') {
    if (!canTool('waste')) return <div className="ins-note">이 계정에는 ‘Optimization’ 도구 권한이 없어 과할당 요약을 볼 수 없습니다 — 관리자에게 요청하세요(설정 › 사용자 관리 › 특수 기능 도구별 접근).</div>;
    if (toolIdsRaw == null) return <div className="ins-note">고른 범위에 법인이 없거나, 고른 법인이 모두 값이 오래됐거나 아직 수집하지 못해 과할당 요약에 더할 법인이 없습니다.</div>;
    return <div className="ins"><VmOverView vcIds={toolIds} rows={rows} canTool={canTool} /></div>;
  }

  const setIds = (next) => { if (onScopeIds) onScopeIds(normScopeIds(next)); };
  const toggleId = (id) => setIds(toggleScopeId(ids, id));
  const total = numOrNull(s.total);
  const snapDays = numOrNull(th.snapAgeDays);

  // ── 요약 · 확인할 것 ──
  const kpis = kpiView(s, picked.used.length);
  const checks = arrangeChecks(checkBase(s, { snapAgeDays: snapDays, wasteHref: canTool('waste') ? '#/tools/waste' : null }), toolChecks);

  // ── VM 현황 지도 ──
  const gpMap = gpOk ? new Map((Array.isArray(gp.data?.rows) ? gp.data.rows : []).map((g) => [String(g.vcenterId), g])) : null;
  const fills = fillDefs(th, gpMap);
  const fill = fills.find((f) => f.key === fillKey) || fills[0];
  const size = SIZE_DEFS.find((z) => z.key === sizeKey) || SIZE_DEFS[0];
  const layout = treemapLayout(mapGroups(picked.all, size));
  // dbg3231: 좁은 화면(세로 띠)에서는 넓을 때 잰 옛 폭을 쓰지 않는다 — 자동 높이는 여러 열을 놓을 때만 실제 배치(가장 긴 작은 열) 기준.
  const packedAuto = !!mapW && !narrow;
  const maxTiles = packedAuto ? maxTilesPacked(layout, mapW) : maxTilesInCol(layout);
  const mapH = mapHeightOf(mapPrefs, maxTiles);
  const selSet = ids.length ? new Set(ids) : null;
  const pct0 = (v) => (v == null ? '—' : `${Math.round(v)}%`);
  const tileView = (t) => {
    const r = t.row;
    const fv = fill.val(r);
    const st = fillStep(fv, fill);
    const col = tileColors(st);
    return {
      title: corpName(r), line: `${size.text(t.size)} · ${fill.short} ${pct0(fv)}`, bg: col.bg, ink: col.ink, stale: r.stale === true,
      tip: `${corpName(r)}${r.city ? ` · ${r.city}` : ''}${r.stale ? ' · 값이 오래됨(합에 넣지 않음)' : ''} — VM ${fmtN(r.total)}(구동 ${fmtN(r.on)}) · 조치 필요 ${fmtN(r.attention)} · 평균 CPU ${pct0(numOrNull(r.cpuAvg?.value))} · 메모리 ${pct0(numOrNull(r.memAvg?.value))}${onScopeIds ? ' — 누르면 이 법인을 바로가기 선택에 켜고 끕니다' : ''}`,
    };
  };
  // v3.23.0: ‘그 밖 N개’ 칸 — 색은 구성원 중 가장 높은 값(나쁜 것이 묶음에 가려지지 않게) · 누르면 아래에 목록
  //   dbg3231: 대표 값은 오래되지 않은 법인에서 먼저(오래된 값이 묶음 칸을 지금 값처럼 칠하지 않게) · 오래됨 · 모름 구성원은 따로 센다 — 대표가 오래됐거나 모두 오래됐으면 빗금.
  const groupView = (members, g) => {
    const isStale = (m) => m.row?.stale === true;
    const { member, value } = worstMember(members, (m) => fill.val(m.row), isStale);
    const col = tileColors(fillStep(value, fill));
    const staleN = members.filter(isStale).length;
    const unknownN = members.filter((m) => numOrNull(fill.val(m.row)) == null).length;
    const repStale = !!member && isStale(member) && value != null;
    return {
      title: g.label, line: `가장 높은 ${fill.short} ${pct0(value)}${repStale ? '(오래됨)' : ''} · 합 ${size.text(g.size)}`, bg: col.bg, ink: col.ink,
      stale: repStale || (members.length > 0 && staleN === members.length),
      tip: `${g.label} — 칸이 너무 작아 한 칸으로 묶은 법인(${members.map((m) => corpName(m.row)).join(' · ')}) · ${member ? `색은 가장 높은 값(${corpName(member.row)}${repStale ? ' — 값이 오래됨' : ''})` : '색 = 값 모름(값이 있는 구성원 없음)'}${groupCountsText(staleN, unknownN, repStale)} · 누르면 아래에 목록이 열립니다`,
    };
  };
  const scale = [...scaleLegend(fill.steps, { crit: fill.crit }).map((text, i) => ({ text, bg: RAMP[i] })),
    ...(fill.crit != null ? [{ text: `${fill.crit}% 이상(경고)`, bg: CRIT_BG }] : []), { text: '값 모름', bg: NONE_BG }];
  const overN = fill.crit != null ? picked.all.filter((r) => r.unknown !== true && fillStep(fill.val(r), fill).over).length : 0;
  const scaleNote = fill.key === 'disk' && !gp.data
    ? (gp.loading ? '게스트 파티션 요약을 받는 중입니다 — 받기 전에는 칸이 회색(값 모름)입니다.' : `게스트 파티션 요약을 받지 못했습니다${gp.error ? `(${gp.error.message || gp.error})` : ''} — 칸이 회색(값 모름)입니다.`)
    : fill.crit != null
      ? `파랑 = 값의 크기 · 빨강 = ${fill.crit}% 이상인 법인만. 지금 ${fill.crit}% 를 넘는 법인은 ${overN}곳입니다.`
      : '이 색 기준에는 정해진 경계가 없어 경고색을 쓰지 않습니다(파랑 단계만). ‘평균 CPU’ · ‘평균 메모리’ 로 바꾸면 경계를 넘은 법인만 빨강이 됩니다.';
  const hiddenNote = layout.hidden.length ? `칸 없음 ${layout.hidden.length}곳(값 모름 또는 0): ${layout.hidden.map((t) => t.label).join(' · ')}` : '';
  const regions = regionRows(picked.used, total);
  const wide = !!mapPrefs.wide && !narrow;

  // ── 범위 안내(고른 법인 · 오래됨 · 모름) ──
  const scopeNote = [
    ids.length ? `법인 ${ids.length}곳을 골랐습니다 — 아래 수는 그 법인들의 합입니다.` : '',
    picked.stale.length ? `오래됨 ${picked.stale.length}곳(${picked.stale.map(corpName).join(' · ')}) — 값이 늦어 합에 넣지 않았습니다.` : '',
    picked.unknown.length ? `값 모름 ${picked.unknown.length}곳(${picked.unknown.map(corpName).join(' · ')}) — 아직 수집하지 못해 합에 넣지 않았습니다.` : '',
    data.initial ? '첫 수집이 끝나지 않았습니다 — 수가 아직 모자랄 수 있습니다.' : '',
  ].filter(Boolean).join(' ');

  // ── 묶음 접힘 요약(접었을 때 한 줄) ──
  const sig = s.signals || {};
  const foldSummary = {
    now: `법인 ${fmtU(picked.used.length, '곳')} · 지역 ${fmtU(regions.length, '곳')} · CPU 상위 VM ${fmtU(tops.cpuTop.length, '대')}`,
    capacity: `오래된 스냅샷 ${fmtU(sig.snapOld, '대')} · 정지 VM ${fmtU(s.reclaim?.offCount, '대')} · 특수 기능 요약(디스크 · 꺼진 VM · 추이)`,
    perf: 'CPU 경합 · 디스크 지연(특수 기능 요약)',
    config: 'VM 구성 점검(특수 기능 요약)',
    dist: `OS ${fmtU(s.os?.kinds?.length, '종')} · 구동 ${shareText(s.on, total)} · Tools 업그레이드 필요 ${fmtN(s.tools?.version?.needUpgrade)} · 회수 후보`,
  };
  const groupShown = { now: true, capacity: true, perf: toolCan('contention'), config: toolCan('vm-hygiene'), dist: true };

  // ── 지금 볼 VM(STable — 법인별 상위 N 을 합쳐 다시 N) ──
  const topRows = tops.cpuTop;
  const usageCell = (v) => {
    const n = numOrNull(v);
    const crit = n != null && numOrNull(th.overloadPct) != null && n >= th.overloadPct;
    return <span className={`ins-ub${crit ? ' crit' : ''}`}><span className="ins-track"><i style={{ width: `${barPct(n, 100)}%` }} /></span><b>{n == null ? '—' : `${Math.round(n)}%`}</b></span>;
  };

  const mapPanel = (
    <section className="ins-panel" aria-label="VM 현황">
      <PanelHead title="VM 현황" hint={`칸 하나 = 법인(vCenter) · 지역별로 묶음 · 넓이 = 크기 기준 · 색 = 색 기준${onScopeIds ? ' · 누르면 그 법인을 바로가기 선택에 켜고 끕니다' : ''}`} />
      <div className="ins-ctl">
        <span>색</span>
        <span className="ins-seg" role="group" aria-label="색 기준">
          {fills.map((f) => <button key={f.key} type="button" className={fill.key === f.key ? 'on' : ''} aria-pressed={fill.key === f.key} onClick={() => setFillKey(f.key)}>{f.label}</button>)}
        </span>
        <span>크기</span>
        <span className="ins-seg" role="group" aria-label="크기 기준">
          {SIZE_DEFS.map((z) => <button key={z.key} type="button" className={size.key === z.key ? 'on' : ''} aria-pressed={size.key === z.key} onClick={() => setSizeKey(z.key)}>{z.label}</button>)}
        </span>
        <MapSizeSeg prefs={mapPrefs} onPrefs={setMapPrefs} maxTiles={maxTiles} open={cfgOpen} onOpen={setCfgOpen} />
      </div>
      {cfgOpen && <MapSizeBox prefs={mapPrefs} onPrefs={setMapPrefs} maxTiles={maxTiles} onClose={() => setCfgOpen(false)} narrow={narrow}
        autoNote={packedAuto ? `자동 = 칸이 많은 지역을 여러 열로 나눈 뒤 가장 긴 열의 칸 수로 정합니다(지금 ${autoMapHeight(maxTiles)}px)` : `자동 = 가장 긴 지역의 칸 수로 정합니다(지금 ${autoMapHeight(maxTiles)}px)`} />}
      {layout.cols.length
        ? <Treemap layout={layout} heightPx={mapH} tileView={tileView} groupView={groupView} onWidth={setMapW} valOf={(t) => fill.val(t.row)} selected={selSet} onToggle={onScopeIds ? toggleId : null} label="VM 현황 — 법인 칸"
          colText={(c) => `${c.label} · ${size.text(c.total)}`} />
        : <div className="ins-note">그릴 법인 칸이 없습니다 — 범위 안 법인의 크기 값이 없거나 0 입니다.</div>}
      <div className="ins-scale">
        <span>{fill.label}</span>
        {scale.map((x) => <span key={x.text}><i style={{ background: x.bg }} />{x.text}</span>)}
      </div>
      <div className="ins-note">{scaleNote}{hiddenNote ? ` ${hiddenNote}` : ''}</div>
    </section>
  );
  const regionPanel = (
    <section className="ins-panel" aria-label="지역별 분포">
      <PanelHead title="지역별 분포" hint={onScopeIds ? '누르면 그 지역의 법인만 고릅니다' : null} />
      {regions.length ? regions.map((g) => (
        <button key={g.key} type="button" className="ins-reg" title={`${g.key} 의 법인만 고릅니다`} disabled={!onScopeIds}
          onClick={() => setIds(picked.all.filter((r) => regionName(r.region) === g.key).map((r) => String(r.id)))}>
          <span className="top"><span className="nm">{g.key}</span><span className="ct">{fmtN(g.n)}</span><span className="sh">{g.share}</span></span>
          <span className="ins-track"><i style={{ width: `${g.w}%` }} /></span>
          <span className="sub">{g.sub}</span>
          <span className="ci">{g.cities}</span>
        </button>
      )) : <div className="ins-note">합에 넣을 법인이 없습니다.</div>}
      <div className="ins-note">막대 = 지금 범위의 VM 중 그 지역의 몫.</div>
    </section>
  );

  return (
    <div className="ins">
      {filters?.q && <div className="ins-note warn">검색어는 ‘목록’ 보기에 적용됩니다 — 분석 보기는 범위(리전 · 바로가기 법인)만 따릅니다. <a href="#/vms/list">목록에서 검색 결과 보기 →</a></div>}
      {error && <div className="badge red" style={{ display: 'block', padding: '6px 10px', whiteSpace: 'normal' }}>⚠ 갱신 실패 — 직전 데이터를 표시 중입니다({error}).</div>}
      {scopeNote && <div className="ins-note">{scopeNote}</div>}
      <section className="ins-tiles" aria-label="요약">
        {kpis.map((k) => <NumTile key={k.key} label={k.label} value={k.value} sub={k.sub} meter={k.meter} tone={k.tone} tip={k.tip} />)}
      </section>
      <CheckLine items={checks} />

      {VM_FOLD_GROUPS.filter(([k]) => groupShown[k]).map(([k, title]) => (
        <FoldGroup key={k} id={`vm-${k}`} title={title} summary={folded[k] ? foldSummary[k] : null} folded={!!folded[k]} onToggle={() => toggleFold(k)}>
          {k === 'now' && (
            <>
              <div className={`ins-row b${wide ? ' wide' : ''}`}>{mapPanel}{regionPanel}</div>
              <section className="ins-panel" aria-label="지금 볼 VM">
                <PanelHead title="지금 볼 VM" hint="지금 범위에서 CPU 사용률이 높은 순 · 이름을 누르면 VM 개체 보기" right={`${fmtU(topRows.length, '대')}`} />
                {topRows.length ? (
                  <STable className="vmh-corp-table" minWidth={760}>
                    <thead><tr><th>VM</th><th>법인</th><th>OS</th><th>할당</th><th>CPU</th><th>메모리</th></tr></thead>
                    <tbody>
                      {topRows.map((v) => (
                        <tr key={v.id}>
                          <td data-sort={v.name}><a href={v.vcenterId && v.id ? vcHash(v.vcenterId, { type: 'vm', id: v.id }) : undefined}>{v.name}</a></td>
                          <td>{nameOf.get(String(v.vcenterId)) || v.vcenterId}</td>
                          <td>{v.guestOS || '—'}</td>
                          <td data-sort={numOrNull(v.vcpu) ?? ''}>{`${fmtN(v.vcpu)} vCPU · ${gbText(mbToGb(v.memMB))}`}</td>
                          <td data-sort={numOrNull(v.cpu) ?? ''}>{usageCell(v.cpu)}</td>
                          <td data-sort={numOrNull(v.mem) ?? ''}>{usageCell(v.mem)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </STable>
                ) : <div className="ins-note">CPU 사용률을 읽은 구동 VM 이 이 범위에 없습니다.</div>}
              </section>
            </>
          )}
          {k === 'capacity' && (
            <>
              {/* 시안 순서(§4-1 · §4-3 · §8 · §10): 디스크 → 오래된 스냅샷 → 꺼진 VM → 추이 */}
              <VmToolPanels vcIds={toolIds} rows={rows} group="capacity" canTool={toolCan} only={['disk']} />
              <SnapPanel s={s} th={th} tops={tops} nameOf={nameOf} canSnapTool={canTool('snapshots')} snapVcIds={ids.length || region ? toolIds : []} />
              <VmToolPanels vcIds={toolIds} rows={rows} group="capacity" canTool={toolCan} only={['off', 'trend']} />
            </>
          )}
          {k === 'perf' && <VmToolPanels vcIds={toolIds} rows={rows} group="perf" canTool={toolCan} />}
          {k === 'config' && <VmToolPanels vcIds={toolIds} rows={rows} group="config" canTool={toolCan} />}
          {k === 'dist' && <DistPanels s={s} th={th} ids={toolIds} canTool={toolCan} waste={waste} hostCorp={hostCorp} />}
        </FoldGroup>
      ))}
    </div>
  );
}

/** 오래된 스냅샷 — ‘조치 필요’ 의 snapOld 신호 그대로(서버 집계 reclaim · 법인별 상위 N 병합). */
function SnapPanel({ s, th, tops, nameOf, canSnapTool = false, snapVcIds = [] }) {
  const r = s.reclaim || {};
  const d = numOrNull(th.snapAgeDays);
  const bands = snapBands(r, th);
  const maxDays = tops.snapOldest.reduce((m, v) => Math.max(m, numOrNull(v.days) ?? 0), 0);
  const maxGB = tops.snapBiggest.reduce((m, v) => Math.max(m, numOrNull(v.snapGB) ?? 0), 0);
  const line = (v, big, w, bg) => (
    <div key={v.id} className="ins-pr" title={`${v.name} · ${nameOf.get(String(v.vcenterId)) || v.vcenterId}${v.oldestName ? ` · 가장 오래된 스냅샷 ‘${v.oldestName}’` : ''}`}>
      <span>
        <a className="nm" href={v.vcenterId && v.id ? vcHash(v.vcenterId, { type: 'vm', id: v.id }) : undefined}>{v.name}</a>
        <span className="ins-sb">{`${nameOf.get(String(v.vcenterId)) || v.vcenterId} · 스냅샷 ${fmtU(v.snapCount, '개')}${v.oldestName ? ` · ${v.oldestName}` : ''}${v.power === 'off' ? ' · 전원 꺼짐' : ''}`}</span>
      </span>
      <span><span className="ins-track"><i style={{ width: `${w}%`, background: bg }} /></span><span className="fr">{`${fmtU(v.days, '일')} · ${gbText(v.snapGB)}`}</span></span>
      <span className="big">{big}</span>
    </div>
  );
  const dayBg = (days) => { const n = numOrNull(days) ?? 0; const e = th.snapAgeEdgesDays || []; return n >= (e[1] ?? Infinity) ? C.red : n >= (e[0] ?? Infinity) ? C.serious : C.amber; };
  return (
    <section className="ins-panel" aria-label="오래된 스냅샷">
      <PanelHead title="오래된 스냅샷" hint="가장 오래된 스냅샷이 기준 일수를 넘긴 VM — ‘조치 필요’ 의 판정 그대로입니다"
        right={d != null ? `기준 ${d}일${th.hygieneUnreadable ? ' · 설정을 못 읽어 기본값' : ''}` : '기준 일수 설정 없음'} />
      <div className="ins-gp">
        <div className="ins-sum">
          <Hero value={fmtN(r.snapOld)} text={`기준을 넘긴 VM · 전체 VM 의 ${shareText(r.snapOld, s.total)}`} />
          <MiniStats stats={[
            { key: 'd90', value: fmtN(r.snapAge?.d90p), text: `${(th.snapAgeEdgesDays || [])[1] ?? '—'}일 넘게 둔 VM`, color: '#fca5a5' },
            { key: 'gb', value: gbText(r.snapOldGB), text: `이 VM 들의 스냅샷 크기${(numOrNull(r.snapOldGBUnknown) ?? 0) > 0 ? ` · 모름 ${fmtU(r.snapOldGBUnknown, '대')}` : ''}` },
            { key: 'n', value: fmtN(r.snapOldSnaps), text: '스냅샷 수' },
          ]} />
          <StackBar segs={bands} tall />
          {/* v3.23.2(사용자 요청): 스냅샷 도구로 가는 ‘모두 보기’ — 도구 권한이 있을 때만. v3.26.0: 받는 쪽(SnapshotTool)이 생겨 ‘사내 기준 넘김’ 보기 +
              고른 법인(본체 합과 같은 집합 toolIds — 오래됨 · 모름 법인 제외)을 주소에 싣는다(snapText.buildSnapHash) — 카드의 수와 도구 표의 대수가 같다. ‘조치 필요’ 길은 그대로 둔다. */}
          {canSnapTool && <a className="ins-link" href={buildSnapHash('old', snapVcIds)}>‘{toolLabel('snapshots')}’ 에서 모두 보기 →</a>}
          <a className="ins-link" href="#/vms/attention" style={canSnapTool ? { fontWeight: 500 } : undefined}>{canSnapTool ? '기준을 넘긴 VM 만 ‘조치 필요’ 에서 보기 →' : '‘조치 필요’ 에서 모두 보기 →'}</a>
          {canHubTool('vm-hygiene') && <a className="ins-link" href="#/tools/vm-hygiene" style={{ fontWeight: 500 }}>기준 일수와 예외 목록은 ‘VM 구성 점검’ 설정에서 →</a>}
        </div>
        <div className="ins-lst">
          <div className="ins-lh"><b>가장 오래된 VM</b><span>지난 일수가 많은 순</span></div>
          {tops.snapOldest.length ? tops.snapOldest.map((v) => line(v, `${fmtU(v.days, '일')}`, barPct(v.days, maxDays), dayBg(v.days))) : <div className="ins-note">이 범위에는 없습니다.</div>}
        </div>
        <div className="ins-lst">
          <div className="ins-lh"><b>스냅샷이 큰 VM</b><span>기준을 넘긴 VM 중 크기가 큰 순</span></div>
          {tops.snapBiggest.length ? tops.snapBiggest.map((v) => line(v, gbText(v.snapGB), barPct(v.snapGB, maxGB), dayBg(v.days))) : <div className="ins-note">이 범위에는 없습니다(크기를 읽은 VM 만).</div>}
        </div>
      </div>
    </section>
  );
}

/** 분포 묶음 — OS · 전원/연결 · Tools/하드웨어 버전 · 사용률 · 할당 크기 · 회수/정리 후보. */
function DistPanels({ s, th, ids, canTool, waste, hostCorp }) {
  const total = numOrNull(s.total);
  const fam = s.os?.family || {};
  const famSegs = [
    { key: 'linux', label: 'Linux', n: fam.linux, bg: FAMILY_BG.linux }, { key: 'windows', label: 'Windows', n: fam.windows, bg: FAMILY_BG.windows },
    { key: 'other', label: '기타', n: fam.other, bg: FAMILY_BG.other }, { key: 'unknown', label: '모름', n: fam.unknown, bg: C.none },
  ];
  const os = osRows(s.os, th.osKindsShown).map((o) => ({ ...o, share: shareText(o.n, total), bg: o.unknown ? C.none : o.rest ? C.gray : (FAMILY_BG[o.family] || C.faint), tip: `${o.name} ${fmtU(o.n, '대')}` }));
  const cx = s.connection || {};
  const tv = s.tools?.version || {};
  const ts = s.tools?.status || {};
  const toolSegs = [
    { key: 'current', label: '최신', n: tv.current, bg: C.blue }, { key: 'needUpgrade', label: '업그레이드 필요', n: tv.needUpgrade, bg: C.amber },
    { key: 'notInstalled', label: '미설치', n: tv.notInstalled, bg: C.serious }, { key: 'unmanaged', label: '관리 안 함', n: tv.unmanaged, bg: C.gray },
    { key: 'other', label: '그 밖', n: tv.other, bg: C.faint }, { key: 'unread', label: '모름', n: tv.unread, bg: C.none },
  ];
  const hw = hwRows(s.hw);
  const binPct = numOrNull(th.histBinPct) ?? 10;
  const crit = numOrNull(th.overloadPct);
  const vc = sizeBinRows(s.vcpuSize, th.vcpuSizes, 'vCPU');
  const mg = sizeBinRows(s.memSize, th.memSizesGB, 'GB');
  const r = s.reclaim || {};
  const w = canTool('waste') ? wasteSum(waste.data?.rows, ids) : null;
  const hostAvg = hostAvgMemGB(hostCorp.data?.corps, ids);
  const memIdleGB = mbToGb(w?.memIdleMB);
  const eq = hostsEquivalent(memIdleGB, hostAvg);
  const unk = (n, what = '') => ((numOrNull(n) ?? 0) > 0 ? ` · ${what}모름 ${fmtU(n, '대')}` : '');
  const reclaim = [
    { key: 'off', title: '정지 VM', big: `${fmtU(r.offCount, '대')}`, desc: `디스크 ${gbText(r.offDiskGB)} 를 잡고 있습니다(템플릿 제외${unk(r.offDiskUnknown, '디스크 ')}) — 오래 꺼 둔 VM 은 보관(백업 뒤 삭제) 후보입니다.` },
    { key: 'snap', title: '스냅샷', big: `${fmtU(r.snapVms, '대')}`, desc: `스냅샷 ${fmtU(r.snapCount, '개')} · 합 ${gbText(r.snapGB)}${unk(r.snapGBUnknown, '크기 ')} · 기준을 넘긴 VM ${fmtU(r.snapOld, '대')}.` },
    { key: 'orphan', title: '고아 · 접근 불가', big: `${fmtU(r.orphan, '대')}`, desc: `고아 ${fmtN(cx.orphaned)} · 접근 불가 ${fmtN(cx.inaccessible)} — 목록에서 지우거나 다시 등록할 대상입니다.` },
    ...(canTool('waste') ? [{
      key: 'waste', title: 'CPU · 메모리 과할당 후보',
      big: w ? `${fmtN(w.cpuCand)} · ${fmtU(w.memCand, '대')}` : (waste.loading ? '받는 중' : '—'),
      desc: w
        ? `특수 기능 ‘Optimization’ 의 판정 그대로 — CPU 후보 ${fmtU(w.cpuCand, '대')} · 메모리 후보 ${fmtU(w.memCand, '대')} · 할당 대비 미사용 메모리 ${gbText(memIdleGB)}${eq != null ? `(호스트 약 ${eq}대분 — 고른 범위 호스트 한 대의 평균 메모리 ${gbText(hostAvg)} 기준)` : ''}.`
        : (waste.error ? `Optimization 요약을 받지 못했습니다(${waste.error.message || waste.error}).` : waste.loading ? 'Optimization 요약을 받는 중입니다.' : '이 범위의 Optimization 줄이 없습니다.'),
      link: '#/tools/waste',
    }] : []),
  ];
  return (
    <>
      <div className="ins-row c">
        <section className="ins-panel" aria-label="OS 종류">
          <PanelHead title="OS 종류" right={`${fmtN(s.os?.kinds?.filter((k) => k.name != null).length)}종`} />
          <StackBar segs={famSegs} total={total} />
          <RankBars rows={os.map((o) => ({ key: o.key, name: o.name, n: o.n, share: o.share, bg: o.bg, tip: o.tip }))} />
        </section>
        <section className="ins-panel" aria-label="전원 · 연결 상태">
          <PanelHead title="전원 · 연결 상태" />
          <StackBar tall total={total} segs={[{ key: 'on', label: '구동', n: s.on, bg: C.blue }, { key: 'off', label: '정지(템플릿 포함)', n: s.off, bg: C.gray }]} />
          <div className="ins-h3">연결 상태</div>
          <KvRows rows={[
            { key: 'c', label: '연결됨(connected)', value: fmtN(cx.connected), tip: 'vCenter 가 VM 을 정상으로 보고 있습니다' },
            { key: 'o', label: '고아(orphaned)', value: fmtN(cx.orphaned), warn: (numOrNull(cx.orphaned) ?? 0) > 0, tip: 'vCenter 목록에는 있지만 호스트에 등록이 없는 VM' },
            { key: 'i', label: '접근 불가(inaccessible)', value: fmtN(cx.inaccessible), warn: (numOrNull(cx.inaccessible) ?? 0) > 0, tip: 'VM 파일(데이터스토어)에 닿지 못하는 VM' },
            ...((numOrNull(cx.other) ?? 0) > 0 ? [{ key: 'x', label: '그 밖', value: fmtN(cx.other) }] : []),
            ...((numOrNull(cx.unknown) ?? 0) > 0 ? [{ key: 'u', label: '모름', value: fmtN(cx.unknown) }] : []),
          ]} />
          <div className="ins-h3">그 밖</div>
          <KvRows rows={[{ key: 't', label: '템플릿', value: fmtN(s.templates) }, { key: 'g', label: 'GPU 를 쓰는 VM', value: fmtN(s.gpuVms) }]} />
        </section>
        <section className="ins-panel" aria-label="VMware Tools · 하드웨어 버전">
          <PanelHead title="VMware Tools · 하드웨어 버전" hint="Tools 는 템플릿 제외" />
          <div className="ins-h3">Tools 버전 상태</div>
          <StackBar segs={toolSegs} />
          <div className="ins-h3">Tools 실행 상태</div>
          <KvRows rows={[
            { key: 'r', label: '실행 중', value: fmtN(ts.running) }, { key: 'n', label: '실행 안 함', value: fmtN(ts.notRunning) },
            ...((numOrNull(ts.other) ?? 0) > 0 ? [{ key: 'o', label: '그 밖', value: fmtN(ts.other) }] : []),
            ...((numOrNull(ts.unread) ?? 0) > 0 ? [{ key: 'u', label: '모름', value: fmtN(ts.unread) }] : []),
          ]} />
          <div className="ins-h3">하드웨어 버전</div>
          <RankBars small rows={hw.rows.map((x) => ({ key: x.key, name: x.name, n: x.n, share: shareText(x.n, total), tip: `${x.name} ${fmtU(x.n, '대')}` }))} />
          {(hw.unread ?? 0) > 0 && <div className="ins-note">하드웨어 버전을 못 읽은 VM {fmtU(hw.unread, '대')}</div>}
        </section>
      </div>
      <div className="ins-row c">
        <section className="ins-panel" aria-label="사용률 분포">
          <PanelHead title="사용률 분포" hint={`구동 VM · ${binPct}% 칸${crit != null ? ` · 빨강 = ${crit}% 이상` : ''}`} />
          <div className="ins-two">
            <div style={{ minWidth: 0 }}>
              <div className="ins-ph"><span className="ins-h3">CPU</span><span className="rt">평균 {s.cpuAvg?.value == null ? '—' : `${s.cpuAvg.value}%`}</span></div>
              <Histogram bins={s.cpuHist || []} binPct={binPct} critFrom={crit} what="CPU" />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="ins-ph"><span className="ins-h3">메모리</span><span className="rt">평균 {s.memAvg?.value == null ? '—' : `${s.memAvg.value}%`}</span></div>
              <Histogram bins={s.memHist || []} binPct={binPct} critFrom={crit} what="메모리" />
            </div>
          </div>
          <div className="ins-note">
            {crit != null ? `${crit}% 이상 — CPU ${fmtU(s.over90?.cpu, '대')} · 메모리 ${fmtU(s.over90?.mem, '대')}. ` : ''}
            사용률 모름 — CPU {fmtU(s.usageUnknown?.cpu, '대')} · 메모리 {fmtU(s.usageUnknown?.mem, '대')}(평균 · 칸에 넣지 않음)
            {((numOrNull(s.histOut?.cpu) ?? 0) + (numOrNull(s.histOut?.mem) ?? 0)) > 0 ? ` · 칸 밖 값(음수) CPU ${fmtN(s.histOut?.cpu)} · 메모리 ${fmtN(s.histOut?.mem)}` : ''}.
          </div>
        </section>
        <section className="ins-panel" aria-label="할당 크기">
          <PanelHead title="할당 크기" hint="VM 한 대에 준 vCPU · 메모리(템플릿 포함)" />
          <div className="ins-h3">vCPU</div>
          <RankBars small rows={vc.rows.map((x) => ({ key: x.key, name: x.name, n: x.n, share: shareText(x.n, total) }))} />
          <div className="ins-h3">메모리</div>
          <RankBars small rows={mg.rows.map((x) => ({ key: x.key, name: x.name, n: x.n, share: shareText(x.n, total) }))} />
          {((vc.unknown ?? 0) > 0 || (mg.unknown ?? 0) > 0) && <div className="ins-note">못 읽음 — vCPU {fmtU(vc.unknown, '대')} · 메모리 {fmtU(mg.unknown, '대')}</div>}
        </section>
        <section className="ins-panel" aria-label="회수 · 정리 후보">
          <PanelHead title="회수 · 정리 후보" hint="돌려받을 수 있는 자원" />
          {reclaim.map((x) => (
            <div key={x.key} className="ins-rc">
              <span className="t">{x.link ? <a className="ins-link" href={x.link}>{x.title} →</a> : x.title}<b>{x.big}</b></span>
              <span className="d">{x.desc}</span>
            </div>
          ))}
          <div className="ins-note">정지 VM 비율 {shareText(r.offCount, total)} · 꺼진 지 며칠인지는 ‘용량과 정리’ 의 꺼진 VM 패널(Optimization 조사)에서 봅니다.</div>
        </section>
      </div>
    </>
  );
}

