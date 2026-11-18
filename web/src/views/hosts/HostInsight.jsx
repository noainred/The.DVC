// views/hosts/HostInsight.jsx — Hypervisor 탭 ‘분석’ 보기(v3.22.0 · 설계 docs/design/host-insight · 시안 HostInsight.dc.html — 사용자 확정 기본값).
//   순서: 요약 6장 / 확인할 것 한 줄(S1) / ‘가상화 호스트 현황’ 지도 + 지역별 분포 / 묶음 접기 — 성능 · 구성 점검 · 용량 · 분포 / 지금 볼 호스트.
//   값: GET /api/hosts/insight(법인마다 한 줄 · 클러스터마다 한 줄 · 법인마다 상위 N · 30초 폴링 — 범위 리전만 싣는다) → 바로가기에서 고른 법인의 줄을 화면이 더한다.
//     오래됨 · 모름 법인은 합에 섞지 않고 따로 밝힌다. 특수 기능 요약 패널은 insight-tools(마운트 1회 + ‘다시 받기’)가 그린다.
//   공용 부품(views/insight/ — 묶음 지도 · 타일 · 막대 줄 · 히스토그램 · 묶음 접기 · 지도 크기 설정)을 그대로 쓴다 — 호스트 전용 사본을 만들지 않는다.
//   새 판정 없음 — 과부하 · 확인 대상 · 하드웨어 · 재부팅 · N+1 · HA · 수용 제어 · DRS 는 서버 값 · 기준값은 응답의 thresholds · 권한이 없는 칸은 숨긴다.
import { unitText } from '../unitText.js'; // v3.22.0: 값이 없으면 단위 없는 ‘—’(BUG-20)
import React, { useMemo, useState } from 'react';
import { usePolling, toolAllowed } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { useNarrowScreen } from '../../components/useNarrowScreen.js';
import { numOrNull } from '../../numOrNull.js';
import { scopeIdsOf, normScopeIds, toggleScopeId } from '../platform/platformText.js';
import { toolsFor } from '../platform/HubTabs.jsx';
import { vcHash } from '../vcd/vcdRoute.js';
import { pickRows, toolIdsOf, fmtN, fmtU, gbText, shareText, barPct } from '../insight/insightCore.js';
import { treemapLayout, maxTilesInCol, fillStep } from '../insight/treemap.js';
import { mapHeightOf, autoMapHeight } from '../insight/insightPrefs.js';
import { useFolded } from '../insight/useInsight.js';
import Treemap from '../insight/Treemap.jsx';
import { useMapPrefs, MapSizeSeg, MapSizeBox } from '../insight/MapSize.jsx';
import { NumTile, CheckLine, PanelHead, StackBar, RankBars, KvRows, Histogram, MiniStats, FoldGroup } from '../insight/InsightParts.jsx';
import {
  sumHostRows, kpiView, checkItems, fillDefs, SIZE_DEFS, mapGroups, regionRows, mergedTops, esxiView, modelView, densityRows, safetyView,
  hostAvgMemGB, hostsEquivalent, hostTileColors, hostScale, n1FailOf, n1PctText, corpName, regionName, mbToGb, histCritFrom, groupShownOf, allocMarks,
  HOST_FOLD_GROUPS, HOST_FOLD_KEYS, HOST_MAP_PREF_KEY, HOST_FOLD_PREF_KEY,
} from './hostInsightText.js';
import HostToolPanels from './insight-tools/HostToolPanels.jsx';
import '../insight/insight.css';

const pct0 = (v) => (numOrNull(v) == null ? '—' : `${Math.round(v)}%`);

/**
 * @param {object} p
 * @param {object} p.filters            App 의 허브 범위 쿼리(hubScopeQuery 결과 + 검색어 등) — scopeIds 가 없을 때 고른 법인을 여기서 읽는다
 * @param {string[]|null} [p.scopeIds]  바로가기에서 고른 법인(App 허브 칸 vcenterIds)
 * @param {string} [p.scopeRegion]      허브 범위 리전
 * @param {(ids:string[])=>void} [p.onScopeIds]  고른 법인 목록을 바꾼다 — 지도 칸 · 지역 줄(없으면 누를 수 없다)
 * @param {(vcId:string)=>void} [p.onOpenCorp]   못 버티는 클러스터 이름 → ‘법인별’ 보기의 그 법인
 * @param {(id:string, ids:string[])=>boolean} [p.onQuickHost]  지금 볼 호스트 이름 → 빠른 확인(드로어). 거짓을 돌려주면(목록에 아직 없음) 개체 보기로 간다
 */
export default function HostInsight({ filters = {}, scopeIds = null, scopeRegion = null, onScopeIds = null, onOpenCorp = null, onQuickHost = null }) {
  const ids = useMemo(() => normScopeIds(Array.isArray(scopeIds) ? scopeIds : scopeIdsOf(filters)), [JSON.stringify(scopeIds), filters?.vcenterId, filters?.vcenterIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const region = String(scopeRegion ?? filters?.region ?? '');
  // 범위 리전만 싣는다 — 고른 법인은 싣지 않는다(서버는 범위 안 법인 줄을 다 주고 화면이 더한다).
  const { data, error, loading } = usePolling('/hosts/insight', region ? { region } : {}, 30_000);
  const narrow = useNarrowScreen('(max-width: 720px)');
  const [folded, toggleFold] = useFolded(HOST_FOLD_PREF_KEY, HOST_FOLD_KEYS);
  const [mapPrefs, setMapPrefs] = useMapPrefs(HOST_MAP_PREF_KEY);
  const [cfgOpen, setCfgOpen] = useState(false);
  const [fillKey, setFillKey] = useState(null);   // null = 처음 색(한 대 빠진 뒤 메모리 — 권한이 없으면 첫 기준)
  const [sizeKey, setSizeKey] = useState('hosts');
  const rows = useMemo(() => (Array.isArray(data?.rows) ? data.rows : []), [data]);
  const picked = useMemo(() => pickRows(rows, ids), [rows, ids]);
  const s = useMemo(() => sumHostRows(picked.used), [picked]);
  const th = data?.thresholds || {};
  const access = data?.access || {};
  const usedIds = useMemo(() => picked.used.map((r) => String(r.id)), [picked]);
  const tops = useMemo(() => mergedTops(data?.top, usedIds, numOrNull(th.topN) ?? 5), [data, usedIds, th.topN]);
  const nameOf = useMemo(() => new Map(rows.map((r) => [String(r.id), corpName(r)])), [rows]);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  // 도구 권한 — 허브 도구 칸과 같은 판정(toolsFor — 카탈로그 adminOnly 는 관리자만) + 서버 집행 축(toolAllowed). 없으면 묶음 · 패널을 숨기고 요청도 보내지 않는다.
  const canTool = (k) => toolsFor([[k, k]]).length > 0 && toolAllowed(k);
  // 도구 요약(?summary=1)은 리전을 모른다 — 리전만 고르고 법인을 고르지 않았으면 이 응답의 법인(그 리전)으로 좁힌다(VM 분석과 같은 규칙).
  //   dbg3221 2회차: 도구 패널도 본체 합과 같은 법인 집합(오래됨 · 모름 법인 제외 — toolIdsOf). null = 고른 법인이 모두 오래됨 · 모름 → 도구 패널을 그리지 않는다.
  const toolIdsRaw = toolIdsOf({ ids, region, rows, picked });
  const toolIds = toolIdsRaw ?? [];
  const toolCan = toolIdsRaw == null ? () => false : canTool;
  const setIds = (next) => { if (onScopeIds) onScopeIds(normScopeIds(next)); };
  const toggleId = (id) => setIds(toggleScopeId(ids, id));
  const totalHosts = numOrNull(s.hosts?.total);

  // ── 요약 · 확인할 것 ──
  const kpis = kpiView(s, picked.used.length);
  const checks = checkItems(s, access, th);

  // ── 가상화 호스트 현황(클러스터 지도) ──
  const fills = fillDefs(th, access);
  const fill = fills.find((f) => f.key === fillKey) || fills[0];
  const size = SIZE_DEFS.find((z) => z.key === sizeKey) || SIZE_DEFS[0];
  const layout = treemapLayout(mapGroups(data.clusters, picked.all, size));
  const maxTiles = maxTilesInCol(layout);
  const mapH = mapHeightOf(mapPrefs, maxTiles);
  const selSet = ids.length ? new Set(ids) : null;
  const tileView = (t) => {
    const c = t.cell; const r = t.row;
    const fv = fill.val(c);
    const col = hostTileColors(fillStep(fv, fill));
    const fail = n1FailOf(c);
    const n1 = access.cluster && !c.standalone
      ? ` · 한 대 빠지면 CPU ${n1PctText(c.n1Cpu)} · 메모리 ${n1PctText(c.n1Mem)}${fail ? ' — 버티지 못함' : c.n1Ok == null ? '(판정 밖)' : ''}`
      : '';
    return {
      title: t.label, line: `${fill.short} ${fill.key === 'n1mem' ? n1PctText(fv) : pct0(fv)} · ${size.text(t.size)}`, bg: col.bg, ink: col.ink, stale: r.stale === true,
      mark: fail ? '못 버팀' : null,
      tip: `${t.label} · ${corpName(r)}${r.city ? ` · ${r.city}` : ''}${r.stale ? ' · 값이 오래됨(합에 넣지 않음)' : ''} — 호스트 ${fmtU(c.hosts, '대')}(연결 ${fmtN(c.connected)} · 점검 ${fmtN(c.maint)} · 끊김 ${fmtN(c.down)}) · 코어 ${fmtN(c.cores)} · 메모리 ${gbText(c.memTotalGB)} · 평균 CPU ${pct0(c.cpuAvg)} · 가장 바쁜 호스트 ${pct0(c.busiestCpu)} · 평균 메모리 ${pct0(c.memAvg)}${n1}${(numOrNull(c.usageUnknown) ?? 0) > 0 ? ` · 사용률 모름 ${fmtU(c.usageUnknown, '대')}` : ''}${onScopeIds ? ' — 누르면 이 법인을 바로가기 선택에 켜고 끕니다' : ''}`,
    };
  };
  const scale = hostScale(fill);
  const clusterCells = layout.cols.flatMap((c) => c.tiles);
  const overN = fill.crit != null ? clusterCells.filter((t) => fillStep(fill.val(t.cell), fill).over).length : 0;
  const unknownN = clusterCells.filter((t) => fill.val(t.cell) == null).length;
  const scaleNote = `파랑 = 값의 크기 · 빨강 = ${unitText(fill.crit, '%')} 이상인 칸만 — 지금 ‘${fill.label}’ 기준으로 ${fmtU(overN, '칸')}입니다(${fmtU(clusterCells.length, '칸')} 중).`
    + (access.cluster ? ' ‘못 버팀’ 표는 색 기준과 상관없이 붙습니다.' : '')
    + (unknownN ? ` 값 모름(회색) ${fmtU(unknownN, '칸')}${fill.key === 'n1mem' ? ' — 독립 호스트 · 용량을 모르는 호스트가 있는 클러스터는 빠진 뒤 값이 없습니다' : ''}.` : '');
  const hiddenNote = layout.hidden.length ? ` 칸 없음 ${fmtU(layout.hidden.length, '개')}(크기 값 모름 또는 0): ${layout.hidden.slice(0, 6).map((t) => t.label).join(' · ')}${layout.hidden.length > 6 ? ' 외' : ''}` : '';
  const regions = regionRows(picked.used, totalHosts);
  const wide = !!mapPrefs.wide && !narrow;

  // ── 범위 안내(고른 법인 · 오래됨 · 모름) ──
  const scopeNote = [
    ids.length ? `법인 ${ids.length}곳을 골랐습니다 — 아래 수는 그 법인들의 합입니다.` : '',
    picked.stale.length ? `오래됨 ${picked.stale.length}곳(${picked.stale.map(corpName).join(' · ')}) — 값이 늦어 합에 넣지 않았습니다.` : '',
    picked.unknown.length ? `값 모름 ${picked.unknown.length}곳(${picked.unknown.map(corpName).join(' · ')}) — 호스트 수를 아직 몰라 합에 넣지 않았습니다.` : '',
    data.initial ? '첫 수집이 끝나지 않았습니다 — 수가 아직 모자랄 수 있습니다.' : '',
  ].filter(Boolean).join(' ');

  const groupShown = groupShownOf(toolCan);
  const esxi = esxiView(s.esxi);
  const foldSummary = {
    perf: 'CPU 경합 · 디스크 지연(특수 기능 요약)',
    config: 'ESXi 호스트 구성 점검(특수 기능 요약)',
    capacity: '데이터스토어 — 곧 가득 · 경로(특수 기능 요약)',
    dist: `ESXi ${fmtU(esxi.kinds, '개')} 버전 · 평균 CPU ${pct0(s.cpuAvg?.value)} · 메모리 ${pct0(s.memAvg?.value)} · vCPU : 코어 ${allocMarks(s).ratio}${access.cluster ? ` · 못 버티는 클러스터 ${fmtN(s.clusters?.n1Fail)}` : ''}`,
  };

  // ── 지금 볼 호스트(STable — 법인별 상위 N 을 합쳐 다시 N) ──
  const topRows = tops.cpuTop;
  const over = numOrNull(th.overloadPct);
  const usageCell = (v) => {
    const n = numOrNull(v);
    const crit = n != null && over != null && n > over;
    return <span className={`ins-ub${crit ? ' crit' : ''}`}><span className="ins-track"><i style={{ width: `${barPct(n, 100)}%` }} /></span><b>{n == null ? '—' : `${Math.round(n)}%`}</b></span>;
  };
  const openHost = (e, h) => {
    if (!onQuickHost) return;
    if (onQuickHost(h.id, topRows.map((x) => x.id))) e.preventDefault();
  };

  const mapPanel = (
    <section className="ins-panel" aria-label="가상화 호스트 현황">
      <PanelHead title="가상화 호스트 현황" hint={`칸 하나 = 클러스터(독립 호스트는 법인마다 한 칸) · 지역별로 묶음 · 넓이 = 크기 기준 · 색 = 색 기준${onScopeIds ? ' · 누르면 그 법인을 바로가기 선택에 켜고 끕니다' : ''}`} />
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
        autoNote={`자동 = 가장 긴 지역의 칸 수로 정합니다(지금 ${autoMapHeight(maxTiles)}px)`} />}
      {layout.cols.length
        ? <Treemap layout={layout} heightPx={mapH} tileView={tileView} selected={selSet} onToggle={onScopeIds ? toggleId : null} pickOf={(t) => t.pick}
          label="가상화 호스트 현황 — 클러스터 칸" colText={(c) => `${c.label} · ${size.text(c.total)}`} />
        : <div className="ins-note">그릴 클러스터 칸이 없습니다 — 범위 안 클러스터의 크기 값이 없거나 0 입니다.</div>}
      <div className="ins-scale">
        <span>{fill.label}</span>
        {scale.map((x) => <span key={x.text}><i style={{ background: x.bg }} />{x.text}</span>)}
        {access.cluster && <span><em className="ins-mk">못 버팀</em>한 대가 빠지면 버티지 못하는 클러스터</span>}
      </div>
      <div className="ins-note">{scaleNote}{hiddenNote}</div>
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
      <div className="ins-note">막대 = 지금 범위의 호스트 중 그 지역의 몫.</div>
    </section>
  );

  return (
    <div className="ins">
      {filters?.q && <div className="ins-note warn">검색어는 ‘목록’ 보기에 적용됩니다 — 분석 보기는 범위(리전 · 바로가기 법인)만 따릅니다. <a href="#/hosts/list">목록에서 검색 결과 보기 →</a></div>}
      {error && <div className="badge red" style={{ display: 'block', padding: '6px 10px', whiteSpace: 'normal' }}>⚠ 갱신 실패 — 직전 데이터를 표시 중입니다({error}).</div>}
      {scopeNote && <div className="ins-note">{scopeNote}</div>}
      <section className="ins-tiles" aria-label="요약">
        {kpis.map((k) => <NumTile key={k.key} label={k.label} value={k.value} sub={k.sub} meter={k.meter} tone={k.tone} tip={k.tip} />)}
      </section>
      <CheckLine items={checks} />
      <div className={`ins-row b${wide ? ' wide' : ''}`}>{mapPanel}{regionPanel}</div>

      {HOST_FOLD_GROUPS.filter(([k]) => groupShown[k]).map(([k, title]) => (
        <FoldGroup key={k} id={`host-${k}`} title={title} summary={folded[k] ? foldSummary[k] : null} folded={!!folded[k]} onToggle={() => toggleFold(k)}>
          {k === 'perf' && <HostToolPanels vcIds={toolIds} rows={rows} group="perf" canTool={toolCan} />}
          {k === 'config' && <HostToolPanels vcIds={toolIds} rows={rows} group="config" canTool={toolCan} />}
          {k === 'capacity' && <HostToolPanels vcIds={toolIds} rows={rows} group="capacity" canTool={toolCan} />}
          {k === 'dist' && <DistPanels s={s} used={picked.used} th={th} access={access} tops={tops} esxi={esxi} nameOf={nameOf} onOpenCorp={onOpenCorp} />}
        </FoldGroup>
      ))}

      <section className="ins-panel" aria-label="지금 볼 호스트">
        <PanelHead title="지금 볼 호스트" hint={`지금 범위에서 CPU 사용률이 높은 순${onQuickHost ? ' · 이름을 누르면 호스트 빠른 확인(드로어)이 열립니다' : ' · 이름을 누르면 호스트 개체 보기'}`} right={`${fmtU(topRows.length, '대')}`} />
        {topRows.length ? (
          <STable className="vmh-corp-table" minWidth={760}>
            <thead><tr><th>호스트</th><th>법인 · 클러스터</th><th>모델</th><th>VM</th><th>CPU</th><th>메모리</th></tr></thead>
            <tbody>
              {topRows.map((h) => (
                <tr key={h.id}>
                  <td data-sort={h.name}><a href={h.vcenterId && h.id ? vcHash(h.vcenterId, { type: 'host', id: h.id }) : undefined} onClick={(e) => openHost(e, h)}>{h.name}</a></td>
                  <td>{`${nameOf.get(String(h.vcenterId)) || h.vcenterId} · ${h.cluster || '독립 호스트'}`}</td>
                  <td>{[h.vendor, h.model].filter(Boolean).join(' ') || '—'}</td>
                  <td data-sort={numOrNull(h.vms) ?? ''}>{fmtN(h.vms)}</td>
                  <td data-sort={numOrNull(h.cpu) ?? ''}>{usageCell(h.cpu)}</td>
                  <td data-sort={numOrNull(h.mem) ?? ''}>{usageCell(h.mem)}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        ) : <div className="ins-note">CPU 사용률을 읽은 호스트가 이 범위에 없습니다.</div>}
      </section>
    </div>
  );
}

/** 분포 묶음 — ESXi 버전 · 서버 모델 · 클러스터 안전성 · 사용률 분포 · 통합 비율 · VM 밀도. */
function DistPanels({ s, used, th, access, tops, esxi, nameOf, onOpenCorp }) {
  const totalHosts = numOrNull(s.hosts?.total);
  const md = modelView(s.model, s.vendor, th.modelsShown);
  const safety = safetyView(s.clusters, access);
  const binPct = numOrNull(th.histBinPct) ?? 10;
  const crit = histCritFrom(th);
  const dens = densityRows(s.vmsPerHost, th.vmsPerHostEdges);
  const headGB = numOrNull(s.headroom?.gb);
  const avgGB = hostAvgMemGB(used);
  const eq = hostsEquivalent(headGB, avgGB);
  const am = allocMarks(s);   // 부분 합 표지(vCPU · 메모리 할당을 일부 VM 에서 못 읽었으면 ‘이상’ + 못 읽은 VM 수 — dbg3221 3회차)
  return (
    <>
      <div className="ins-row c">
        <section className="ins-panel" aria-label="ESXi 버전">
          <PanelHead title="ESXi 버전" right={`${fmtU(esxi.kinds, '개')} 버전`} />
          <StackBar segs={esxi.genSegs} total={totalHosts} />
          <RankBars small rows={esxi.rows.map((x) => ({ key: x.key, name: x.name, n: x.n, bg: x.bg, share: shareText(x.n, totalHosts), tip: `${x.name} · ${fmtU(x.n, '대')}` }))} />
          <div className="ins-note">새 버전이 위 · 세대 = 버전의 첫 숫자(지원 종료 판정은 ‘버전/패치 준수’ 도구).{(esxi.unread ?? 0) > 0 ? ` 버전을 못 읽은 호스트 ${fmtU(esxi.unread, '대')}.` : ''}</div>
        </section>
        <section className="ins-panel" aria-label="서버 모델">
          <PanelHead title="서버 모델" right={`${fmtU(md.kinds, '종')}`} />
          <RankBars rows={md.rows.map((x) => ({ key: x.key, name: x.name, n: x.n, share: shareText(x.n, totalHosts), tip: `${x.name} · ${fmtU(x.n, '대')}` }))} />
          {md.vendorText && <div className="ins-note">{md.vendorText}</div>}
          {(md.unread ?? 0) > 0 && <div className="ins-note">모델을 못 읽은 호스트 {fmtU(md.unread, '대')}</div>}
        </section>
        {safety && (
          <section className="ins-panel" aria-label="클러스터 안전성">
            <PanelHead title="클러스터 안전성" hint="호스트 한 대가 빠져도 버티는가" right={`클러스터 ${fmtU(safety.total, '개')}`} />
            <StackBar tall segs={safety.segs} />
            <KvRows rows={safety.kv} />
            <div className="ins-h3">한 대가 빠지면 버티지 못하는 클러스터</div>
            {tops.n1Fail.length ? tops.n1Fail.map((x) => (
              <div key={`${x.vcenterId}-${x.key}`} className="ins-kv" title={`${x.label || x.name} — 호스트 한 대가 빠진 뒤의 예상 사용률 · 호스트 ${fmtU(x.hosts, '대')}${x.ha === false ? ' · HA 꺼짐' : ''}`}>
                <span>
                  {onOpenCorp
                    ? <button type="button" className="ins-lnkbtn" onClick={() => onOpenCorp(x.vcenterId)} title="‘법인별’ 보기에서 이 법인을 엽니다">{`${x.label || x.name} · ${nameOf.get(String(x.vcenterId)) || x.vcenterId}`} →</button>
                    : `${x.label || x.name} · ${nameOf.get(String(x.vcenterId)) || x.vcenterId}`}
                </span>
                <b className="w">{`CPU ${n1PctText(x.cpuAfterFailPct)} · 메모리 ${n1PctText(x.memAfterFailPct)}`}</b>
              </div>
            )) : <div className="ins-note">이 범위에는 없습니다.</div>}
          </section>
        )}
      </div>
      <div className="ins-row b">
        <section className="ins-panel" aria-label="사용률 분포">
          <PanelHead title="사용률 분포" hint={`사용률을 읽은 호스트 · ${binPct}% 칸${crit != null ? ` · 빨강 = ${crit}% 이상 칸` : ''}`} />
          <div className="ins-two">
            <div style={{ minWidth: 0 }}>
              <div className="ins-ph"><span className="ins-h3">CPU</span><span className="rt">평균 {pct0(s.cpuAvg?.value)}</span></div>
              <Histogram bins={s.cpuHist || []} binPct={binPct} critFrom={crit} what="CPU" />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="ins-ph"><span className="ins-h3">메모리</span><span className="rt">평균 {pct0(s.memAvg?.value)}</span></div>
              <Histogram bins={s.memHist || []} binPct={binPct} critFrom={crit} what="메모리" />
            </div>
          </div>
          <div className="ins-note">
            {crit != null ? `${crit}% 초과 — CPU ${fmtU(s.over90?.cpu, '대')} · 메모리 ${fmtU(s.over90?.mem, '대')}. ` : ''}
            사용률 모름 — CPU {fmtU(s.usageUnknown?.cpu, '대')} · 메모리 {fmtU(s.usageUnknown?.mem, '대')}(끊김 · 못 읽음 — 평균 · 칸에 넣지 않음)
            {((numOrNull(s.histOut?.cpu) ?? 0) + (numOrNull(s.histOut?.mem) ?? 0)) > 0 ? ` · 칸 밖 값 CPU ${fmtN(s.histOut?.cpu)} · 메모리 ${fmtN(s.histOut?.mem)}` : ''}.
          </div>
        </section>
        <section className="ins-panel" aria-label="통합 비율과 VM 밀도">
          <PanelHead title="통합 비율 · VM 밀도" hint="호스트에 VM 을 얼마나 실었나(템플릿 제외)" />
          <MiniStats stats={[
            { key: 'r', value: am.ratioOne, text: `vCPU : 물리 코어${am.vcpuNote ? ` — ${am.vcpuNote}` : ''}`, tip: `VM 에 준 vCPU ${am.vcpuText} ÷ 물리 코어 ${fmtN(s.cores)}${(numOrNull(s.capUnknown) ?? 0) > 0 ? ' — 용량 모름 호스트가 있어 비율을 내지 않습니다' : ''}${am.vcpuNote ? ` — ${am.vcpuNote}(읽은 VM 만의 합 · 최소값)` : ''}` },
            { key: 'm', value: am.ram, text: `메모리 — VM 에 준 것 ÷ 호스트 총량${am.memNote ? ` — ${am.memNote}` : ''}`, tip: `VM 에 준 메모리 ${am.vmMemText} ÷ 호스트 메모리 ${gbText(mbToGb(s.memTotalMB))}${am.memNote ? ` — ${am.memNote}(읽은 VM 만의 합 · 최소값)` : ''}` },
            { key: 'h', value: gbText(headGB), text: `메모리 여유${eq != null ? ` — 호스트 약 ${eq}대분` : ''}`,
              tip: `‘법인별’ 보기의 여유(headroom — 정격 × ${unitText(th.headroomPct, '%')} − 사용 중) 합${avgGB != null ? ` ÷ 이 범위 호스트 한 대의 평균 메모리 ${gbText(avgGB)}` : ''}${(numOrNull(s.headroom?.excluded) ?? 0) > 0 ? ` · 여유 계산에서 뺀 호스트 ${fmtU(s.headroom.excluded, '대')}` : ''}` },
          ]} />
          {(numOrNull(s.headroom?.excluded) ?? 0) > 0 && <div className="ins-note">여유 계산에서 뺀 호스트(용량 · 사용률 모름) {fmtU(s.headroom.excluded, '대')} — 여유 합에 넣지 않았습니다.</div>}
          <div className="ins-h3">호스트 한 대의 VM 수</div>
          <RankBars small rows={dens.map((x) => ({ key: x.key, name: x.name, n: x.n, share: shareText(x.n, totalHosts), tip: `VM 을 ${x.name} 실은 호스트 ${fmtU(x.n, '대')}` }))} />
        </section>
      </div>
    </>
  );
}
