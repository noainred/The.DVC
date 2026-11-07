import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { usePolling, fetchJson, canCsv } from '../api.js';
import { DataTable, UsageCell, StateBadge, Loading, ErrorBox } from '../components/ui.jsx';
import IpmsMatches from '../components/IpmsMatches.jsx';
import Select from '../components/Select.jsx';
import { cpuModelCell } from '../components/cpuModelText.js';
import { hashSegments } from '../hooks/hashTab.js';
// v2.915 가상화 플랫폼 허브(설계 docs/design/virt-platform-menu 시안 A ③): 이 화면은 허브의 '호스트 탭' 본문이다 — 제목은 허브가, 여기는 탭 줄(호스트별 · 법인별 ‖ 호스트 도구 4 ‖ 상태 · 메모 · IPMS) 부터.
//   호스트 이름 = 개체 보기(브레드크럼 · 전체 페이지 상세는 그 안의 버튼) · VM 수 = VM 탭을 그 호스트 범위로 · 점검 집계 · 엑셀 버튼은 표 머리로.
import HubTabs, { toolsFor } from './platform/HubTabs.jsx';
import { HOST_TOOLS } from './platform/platformText.js';
import { vcHash } from './vcd/vcdRoute.js';
import { hostUsagePct } from './vcdOverview.js'; // v2.606 WEB2606-02: 끊긴·무응답 호스트의 0% 는 '못 읽음'(—)
// v2.764: 시안 B '이상 우선' 배치 — 확인 대상·CPU 구간·클러스터 타일 판정은 hostTriage.js 하나(카드 숫자와 표 필터가 같은 판정).
import { CPU_ATTENTION_PCT, CPU_BUCKETS, hostReasons, triageCounts, cpuDistribution, clusterTiles } from './hostTriage.js';
// v2.805: 엑셀 수준 상세(승인 시안 https://claude.ai/artifact/EFh5K3UDzuGpUpqVyqXPf1 ①) — 열 묶음 9개 · 요약 8칸 · 확인 칩 · 점검 열 글자는 hostChecksText.js 하나.
//   iDRAC 부품 · 최근 재부팅 · Veeam 은 서버 /hosts/checks(무거운 집계 — 마운트 1회 + 필터 변경 + 버튼, 15초 폴링 금지).
import {
  COL_GROUPS, FIXED_GROUP, readColPrefs, writeColPrefs, visibleColumns, secCountsOf, secText, secTone, uplinkDownOf, nicLinkDownOf, deadPathsOf, lunsOf,
  uptimeDays, coresText, gbText, kwText, ratioText, hwCell, bootCell, veeamCell, hostKpis, chipCounts, filterHostsExt, focusLabelExt,
  readHostsView, writeHostsView,   // v2.811 보기(호스트별 · 법인별) 기억
} from './hostChecksText.js';

const HostDetail = React.lazy(() => import('./HostDetail.jsx'));          // v2.805 전체 페이지 상세(#/hosts/<id>)
const HostExportDialog = React.lazy(() => import('./HostExportDialog.jsx')); // v2.802 호스트 · 클러스터 엑셀(vCenter 단위)
const HostsCorp = React.lazy(() => import('./HostsCorp.jsx'));               // v2.811 '법인별' 보기(승인 시안 B https://claude.ai/artifact/JGykMmoG7kAyNsa5y4uG1x)

const TILE_LIMIT = 12; // 처음엔 '먼저 볼' 클러스터만 — 나머지는 '모두 보기'
const TILE_LIMIT_NARROW = 4; // 720px 이하는 4개(styles.css .ht-tiles) — 12개가 세로로 쌓이면 표까지 스크롤이 너무 길다(Chromium 400px 판독)
const REASON_BADGE = { maint: 'amber', down: 'red', cpu: 'red' };
const KPI_COLOR = { text: 'var(--text)', accent: 'var(--accent)', cyan: 'var(--accent-2)', green: 'var(--green)', amber: 'var(--amber)' };
const hostIdOf = (hash) => { const s = hashSegments(hash); return s[0] === 'hosts' && s[1] ? decodeURIComponent(s[1]) : ''; };
const numText = (v) => (Number.isFinite(v) ? v.toLocaleString('en-US') : '—');
const numTone = (v) => (Number.isFinite(v) && v > 0 ? 'var(--red)' : undefined);

export default function Hosts({ filters, cond = null, nameFocus = '', onNameFocus = null, onGoVms = null }) {
  const { data, error, loading } = usePolling('/hosts', filters, 15_000);
  const [tab, setTab] = useState(null); // null = 확인 대상이 있으면 그 탭, 없으면 전체
  const [focus, setFocus] = useState(null);
  const [allTiles, setAllTiles] = useState(false);
  const [off, setOff] = useState(() => readColPrefs());
  const [hostId, setHostId] = useState(() => hostIdOf(window.location.hash));
  const [checks, setChecks] = useState(null);
  const [checksErr, setChecksErr] = useState(null);
  const [checksBusy, setChecksBusy] = useState(false);
  const checksSeq = useRef(0);
  const [exportVc, setExportVc] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const [exportPick, setExportPick] = useState(false);
  const [view, setViewState] = useState(readHostsView);
  const setView = (v) => { setViewState(v); writeHostsView(v); };
  const filtersKey = JSON.stringify(filters || {});

  useEffect(() => {
    const on = () => setHostId(hostIdOf(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  // 점검 집계 — 마운트 1회 + 필터가 바뀔 때 + 버튼. 늦게 온 이전 응답은 버린다.
  const loadChecks = useCallback(() => {
    const seq = ++checksSeq.current;
    setChecksBusy(true);
    fetchJson('/hosts/checks', JSON.parse(filtersKey))
      .then((r) => { if (seq === checksSeq.current) { setChecks(r); setChecksErr(null); } })
      .catch((e) => { if (seq === checksSeq.current) setChecksErr(e?.message || String(e)); })
      .finally(() => { if (seq === checksSeq.current) setChecksBusy(false); });
  }, [filtersKey]);
  // 점검 집계는 호스트별 보기에서만 읽는다(법인별 보기는 /hosts/corp 를 쓴다 — 무거운 집계를 쓸데없이 부르지 않게).
  useEffect(() => { if (!hostId && view === 'host') loadChecks(); }, [loadChecks, hostId, view]);

  const rows = useMemo(() => data?.items || [], [data]);
  // 구성·보안 판정은 호스트당 한 번(표·칩·거르기가 같은 결과를 쓴다). 폴링마다 다시 센다.
  const secMap = useMemo(() => { const now = Date.now(); return new Map(rows.map((h) => [h.id, secCountsOf(h, now)])); }, [rows]);
  const secOf = useCallback((h) => secMap.get(h.id) ?? null, [secMap]);

  if (hostId) {
    return (
      <React.Suspense fallback={<div className="muted" style={{ padding: 24 }}>로딩 중…</div>}>
        <HostDetail id={hostId} />
      </React.Suspense>
    );
  }
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />; // 데이터 보유 중 일시 폴링 오류는 화면 유지

  const now = Date.now();
  const counts = triageCounts(rows);
  const dist = cpuDistribution(rows);
  const tiles = clusterTiles(rows);
  const curTab = tab || (counts.attention > 0 ? 'attention' : 'all');
  const byId = checks?.byId || null;
  const access = checks?.access || null;
  // v2.915: VM 표의 호스트 이름에서 넘어온 '그 호스트만'(nameFocus — 이름 정확 일치 · 칩으로 해제)은 탭 · 조건 위에 겹쳐 건다.
  const shown0 = filterHostsExt(rows, { tab: curTab, focus }, { secOf, checks: byId });
  const shown = nameFocus ? shown0.filter((h) => h.name === nameFocus) : shown0;
  // 카드·구간·타일·칩을 누르면 그 조건으로 걸러 표를 본다. 같은 것을 다시 누르면 해제.
  const pick = (f, nextTab) => {
    const same = focus && f && focus.kind === f.kind && focus.value === f.value;
    setFocus(same ? null : f);
    if (nextTab) setTab(nextTab);
  };
  const isFocus = (kind, value) => !!focus && focus.kind === kind && focus.value === value;
  const toggleGroup = (k) => { if (k === FIXED_GROUP) return; const next = { ...off, [k]: !off[k] }; setOff(next); writeColPrefs(next); };

  const s = data.summary;
  const fmt = (n) => (n ?? 0).toLocaleString('en-US');
  const pctText = (v) => (v == null ? '—' : `${v}%`);
  const visibleTiles = allTiles ? tiles : tiles.slice(0, TILE_LIMIT);
  const filtered = Object.keys(filters || {}).length > 0;
  const kpis = hostKpis(s, rows, now);
  const chips = chipCounts(rows, { secOf, checks: byId, access });
  const vcIds = [...new Set(rows.map((h) => h.vcenterId))].sort();
  const csvOk = canCsv();
  const openExport = () => {
    if (filters?.vcenterId) { setExportVc(filters.vcenterId); setExportOpen(true); return; }
    if (vcIds.length === 1) { setExportVc(vcIds[0]); setExportOpen(true); return; }
    setExportPick((v) => !v);
  };

  // 법인별 보기 → 호스트별 보기의 그 클러스터(hostTriage.clusterKey 와 같은 키)로 내려간다.
  const openCluster = (vc, cluster) => { setView('host'); setTab('all'); setFocus({ kind: 'cluster', value: `${vc}\t${cluster || 'standalone'}` }); window.scrollTo({ top: 0 }); };

  const cards = [
    { kind: 'maint', n: counts.maint, title: '점검(Maintenance) 모드', sub: '유지보수 상태 호스트', tone: 'amber' },
    // v2.766(점검 R1-A3-02): 서버 경보(high-cpu)는 점검 호스트에 경보를 만들지 않지만 이 카드는 점검 호스트도 센다(판정은 그대로 — 사실만 말한다).
    { kind: 'cpu', n: counts.cpu, title: `CPU ${CPU_ATTENTION_PCT}% 초과`, sub: `서버 경보와 같은 임계값(${CPU_ATTENTION_PCT}% 초과) · 점검 중 호스트 포함`, tone: 'red' },
    { kind: 'down', n: counts.down, title: '끊김 · 무응답', sub: '사용률을 읽지 못한 호스트', tone: 'red' },
  ];

  // 열 — 엑셀 '호스트 목록' 시트와 같은 묶음(hostChecksText.COLUMNS). 묶음을 끄면 그 열이 빠진다(사용자별 localStorage).
  const dot = (g) => <i className="ht-gdot" style={{ background: g.color }} aria-hidden="true" />;
  const groupOf = (c) => COL_GROUPS.find((g) => g.key === c.group);
  const tone = (t) => ({ green: 'green', amber: 'amber', red: 'red', gray: 'gray' }[t] || 'gray');
  const vmOf = (h) => byId?.[h.id]?.vm || null;
  const R = {
    // v2.915(상세 한 규칙): 이름 = 개체 보기(#/vcenters/<vc>/host/<id> — 브레드크럼). 전체 페이지 상세(#/hosts/<id>)는 그 안의 '전체 페이지 상세 →' 버튼(주소는 그대로 산다).
    name: { render: (h) => <a className="cell-link ht-link" href={vcHash(h.vcenterId, { type: 'host', id: h.id })} title="개체 보기(요약 · 모니터 · 구성 …) — 전체 페이지 상세는 그 안에서">{h.name}</a> },
    vcenterId: { render: (h) => <span className="muted">{h.vcenterId}</span> },
    cluster: { render: (h) => h.cluster || '—' },
    connectionState: { render: (h) => <StateBadge state={h.connectionState} /> },
    model: { sortValue: (h) => [h.vendor, h.model].filter(Boolean).join(' '), render: (h) => [h.vendor, h.model].filter(Boolean).join(' ') || '—' },
    serviceTag: { render: (h) => (h.serviceTag ? <span className="tabular" style={{ letterSpacing: 0.5 }}>{h.serviceTag}</span> : '—') },
    cpuModel: { sortValue: (h) => cpuModelCell(h.cpuModel).text, render: (h) => { const c = cpuModelCell(h.cpuModel); return <span title={c.title || undefined}>{c.text}</span>; } },
    cpuCores: { render: (h) => <span className="tabular">{coresText(h)}</span> },
    memTotalMB: { render: (h) => gbText(h.memTotalMB) }, // REST 폴백 수집엔 메모리 정보 없음 — 'NaN GB' 방지
    version: { sortValue: (h) => `${h.version || ''} ${h.build || ''}`, render: (h) => (h.version ? <span>{h.version}{h.build ? <span className="muted"> · {h.build}</span> : null}</span> : '—') },
    mgmtIp: { render: (h) => <span className="tabular">{h.mgmtIp || '—'}</span> },
    uptime: { sortValue: (h) => uptimeDays(h, now), render: (h) => { const d = uptimeDays(h, now); return d == null ? '—' : `${d}일`; } },
    cpuUsagePct: { sortValue: (h) => hostUsagePct(h, 'cpuUsagePct'), render: (h) => <UsageCell pct={hostUsagePct(h, 'cpuUsagePct')} /> },
    memUsagePct: { sortValue: (h) => hostUsagePct(h, 'memUsagePct'), render: (h) => <UsageCell pct={hostUsagePct(h, 'memUsagePct')} /> },
    powerWatts: { sortValue: (h) => (h.powerWatts > 0 ? h.powerWatts : null), render: (h) => kwText(h.powerWatts) },
    tempC: { sortValue: (h) => (Number.isFinite(h.tempC) ? h.tempC : null), render: (h) => (Number.isFinite(h.tempC) ? `${h.tempC}℃` : '—') },
    // v2.915 교차 링크: VM 수를 누르면 VM 탭을 그 호스트 범위로(서버 /vms?host — 이름으로 거른다). 0 이거나 모르면 글자만.
    vmCount: { render: (h) => (onGoVms && Number.isFinite(h.vmCount) && h.vmCount > 0
      ? <button type="button" className="cell-link tabular" onClick={() => onGoVms(h.name)} title="VM 탭을 이 호스트의 VM 으로">{numText(h.vmCount)} →</button>
      : numText(h.vmCount)) },
    // VM 묶음 — 호스트 객체에는 VM 할당 합이 없다. /hosts/checks 의 vm(템플릿 제외 · 못 읽은 VM 은 unknown)을 쓰고, 아직 안 읽었으면 '—'.
    vcpu: { sortValue: (h) => vmOf(h)?.vcpu ?? null, render: (h) => { const v = vmOf(h); return v ? <span title={v.vcpuUnknown ? `vCPU 를 못 읽은 VM ${v.vcpuUnknown}` : undefined}>{numText(v.vcpu)}{v.vcpuUnknown ? <span className="muted">+?</span> : null}</span> : '—'; } },
    vcpuRatio: { sortValue: (h) => { const v = vmOf(h); return v && h.cpuCores > 0 ? v.vcpu / h.cpuCores : null; }, render: (h) => { const v = vmOf(h); return v ? ratioText(v.vcpu, h.cpuCores) : '—'; } },
    vmMemGB: { sortValue: (h) => vmOf(h)?.memMB ?? null, render: (h) => { const v = vmOf(h); return v ? <span title={v.memUnknown ? `메모리를 못 읽은 VM ${v.memUnknown}` : undefined}>{gbText(v.memMB)}{v.memUnknown ? <span className="muted">+?</span> : null}</span> : '—'; } },
    nics: { sortValue: (h) => (Array.isArray(h.nics) ? h.nics.length : null), render: (h) => (Array.isArray(h.nics) && h.nics.length ? h.nics.length : '—') },
    nicDown: { sortValue: (h) => nicLinkDownOf(h), render: (h) => { const v = nicLinkDownOf(h); return <span style={{ color: numTone(v) }}>{numText(v)}</span>; } },
    uplinkDown: { sortValue: (h) => uplinkDownOf(h, secOf(h)), render: (h) => { const v = uplinkDownOf(h, secOf(h)); return <span style={{ color: numTone(v) }}>{numText(v)}</span>; } },
    hbas: { sortValue: (h) => (Array.isArray(h.hbas) ? h.hbas.length : null), render: (h) => (Array.isArray(h.hbas) && h.hbas.length ? h.hbas.length : '—') },
    deadPaths: { sortValue: (h) => deadPathsOf(h), render: (h) => { const v = deadPathsOf(h); return <span style={{ color: numTone(v) }}>{numText(v)}</span>; } },
    luns: { sortValue: (h) => lunsOf(h), render: (h) => numText(lunsOf(h)) },
    sec: {
      sortValue: (h) => { const c = secOf(h); return c ? c.crit * 100 + c.warn * 10 + c.info : null; },
      render: (h) => { const c = secOf(h); return c ? <span className={`badge ${tone(secTone(c))}`}>{secText(c)}</span> : <span className="muted" title="구성을 아직 읽지 않았거나 연결이 끊긴 호스트">{h.connectionState === 'DISCONNECTED' ? '—' : '수집 안 됨'}</span>; },
    },
    idrac: { sortValue: (h) => hwCell(byId?.[h.id]).text, render: (h) => { const c = hwCell(byId?.[h.id]); return <span className={`badge ${tone(c.tone)}`} title={c.title || undefined}>{c.text}</span>; } },
    boot: { sortValue: (h) => bootCell(byId?.[h.id], h, checks?.bootDays).text, render: (h) => { const c = bootCell(byId?.[h.id], h, checks?.bootDays); return c.tone === 'gray' && !byId?.[h.id]?.boot ? <span className="muted" title={c.title || undefined}>{c.text}</span> : <span className={`badge ${tone(c.tone)}`} title={c.title || undefined}>{c.text}</span>; } },
    veeam: { sortValue: (h) => { const v = byId?.[h.id]?.veeam; return v ? v.n : null; }, render: (h) => { const c = veeamCell(byId?.[h.id]); return c.tone === 'gray' ? <span className="muted" title={c.title || undefined}>{c.text}</span> : <span className={`badge ${tone(c.tone)}`} title={c.title || undefined}>{c.text}</span>; } },
  };
  const columns = [
    ...(curTab === 'attention' ? [{
      key: 'reason', label: '사유', sortValue: (h) => hostReasons(h).map((r) => r.label).join(','),
      render: (h) => (
        <span className="ht-reasons">
          {hostReasons(h).map((r) => <span key={r.kind} className={`badge ${REASON_BADGE[r.kind]}`}>{r.label}</span>)}
        </span>
      ),
    }] : []),
    ...visibleColumns(off, { hw: access ? access.hw === true : true }).map((c) => ({
      key: c.key, align: c.align, label: <span className="ht-col">{dot(groupOf(c))}{c.label}</span>, ...(R[c.key] || {}),
    })),
  ];

  return (
    <>
      {/* 폴링 지속 실패 시 낡은 데이터를 무경고로 표시하지 않고 배너로 알린다(v2.287, #20). */}
      {error && <div className="badge red" style={{ display: 'block', marginBottom: 10, padding: '6px 10px' }}>⚠ 갱신 실패 — 직전 데이터를 표시 중입니다({error}).</div>}

      {/* v2.915: 제목 줄 대신 허브 탭 줄 — 호스트별 · 법인별(이 화면 안의 보기) ‖ 호스트 성격의 특수 기능 4 ‖ 오른쪽 = 이 탭 고유 조건(공용 범위 바에서 내려온 상태 · 메모 · IPMS) */}
      <div style={{ marginBottom: 12 }}>
        <HubTabs label="호스트 보기 · 도구" active={view} tools={toolsFor(HOST_TOOLS)}
          views={[
            { k: 'host', label: '호스트별', onClick: () => setView('host') },
            { k: 'corp', label: '법인별', onClick: () => setView('corp') },
          ]}
          right={cond ? (
            <>
              {cond.menuFilter && (
                <Select sort={false} className="select" value={cond.menuFilter.value} onChange={(e) => cond.menuFilter.onChange(e.target.value)} aria-label="상태">
                  {cond.menuFilter.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </Select>
              )}
              <label title="메모 포함 — 체크하면 검색에 메모(Notes) 내용도 포함합니다. (기본: 미포함)"><input type="checkbox" checked={cond.qNotes} onChange={(e) => cond.setQNotes(e.target.checked)} /> 메모</label>
              <label title="IPMS 포함 — 체크하면 IP로 검색할 때 IPMS(IP 스캔) 자료의 해당 대역 IP도 함께 보여줍니다."><input type="checkbox" checked={cond.qIpms} onChange={(e) => cond.setQIpms(e.target.checked)} /> IPMS</label>
            </>
          ) : null} />
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>vCenter {fmt(vcIds.length)} · 호스트 {fmt(rows.length)}{data.generatedAt ? ` · 인벤토리 ${new Date(data.generatedAt).toLocaleTimeString('ko-KR')}` : ''}</div>
      {exportPick && !filters?.vcenterId && vcIds.length > 1 && (
        <div className="ht-pick">
          <span className="muted">엑셀은 vCenter 단위입니다 — 내보낼 vCenter 를 고르세요.</span>
          <Select className="select" value={exportVc} onChange={(e) => setExportVc(e.target.value)} aria-label="내보낼 vCenter">
            <option value="">vCenter 선택…</option>
            {vcIds.map((id) => <option key={id} value={id}>{id}</option>)}
          </Select>
          <button type="button" className="btn" disabled={!exportVc} onClick={() => { setExportOpen(true); setExportPick(false); }}>열기</button>
        </div>
      )}
      {view === 'host' && checksErr && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>점검 집계를 읽지 못했습니다({checksErr}) — iDRAC · 재부팅 · Veeam 열은 ‘—’ 로 둡니다.</div>}
      {view === 'corp' && (
        <React.Suspense fallback={<Loading />}>
          {csvOk && <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}><button type="button" className="btn primary" onClick={openExport}>⤓ 호스트·클러스터 엑셀…</button></div>}
          <HostsCorp filters={filters} rows={rows} onOpenCluster={openCluster} />
        </React.Suspense>
      )}
      {view === 'host' && (
        <>

        {s && (
          <div className="ht-kpis" aria-label="글로벌 호스트 요약">
            {kpis.map((k) => (
              <div key={k.key} className="ht-kpi">
                <span className="ht-kpi-l">{k.label}</span>
                <span className="ht-kpi-v"><b style={{ color: KPI_COLOR[k.tone] || 'var(--text)' }}>{k.value}</b>{k.unit ? <small>{k.unit}</small> : null}</span>
                <span className="ht-kpi-bar"><i style={{ width: `${Math.round(Math.max(0, Math.min(1, k.bar || 0)) * 100)}%`, background: KPI_COLOR[k.tone] || 'var(--text-dim)' }} /></span>
                {k.key === 'ver' && k.versions?.length ? (
                  <span className="ht-kpi-s ht-kpi-ver" title={k.versions.map((v) => `${v.version} · ${v.count}`).join(' / ')}>{k.versions.slice(0, 3).map((v) => <span key={v.version} className="badge blue" title={`${v.count} 호스트`}>{v.version} · {v.count}</span>)}{k.versions.length > 3 ? <span className="muted">+{k.versions.length - 3}</span> : null}</span>
                ) : <span className="ht-kpi-s" title={k.sub}>{k.sub}</span>}
              </div>
            ))}
          </div>
        )}

        <section className="card ht-checks" aria-label="지금 확인할 것">
          <div className="ht-head">
            <b>지금 확인할 것</b>
            <span className="muted">엑셀 ‘요약’ 시트의 확인 목록과 같은 판정 · 누르면 아래 목록이 그 호스트만 보입니다 · 확인 대상 <b style={{ color: 'var(--text)' }}>{fmt(counts.attention)}</b> / {fmt(rows.length)}</span>
          </div>
          <div className="ht-cards">
            {cards.map((c) => (
              <button
                key={c.kind}
                type="button"
                className={`ht-card${c.n > 0 ? ` ht-card-${c.tone}` : ''}${isFocus(c.kind, undefined) ? ' ht-on' : ''}`}
                onClick={() => pick({ kind: c.kind }, 'attention')}
                disabled={c.n === 0}
                aria-pressed={isFocus(c.kind, undefined)}
                title={c.n > 0 ? '눌러서 이 호스트만 보기(다시 누르면 해제)' : '해당 호스트 없음'}
              >
                <span className="ht-card-n">{fmt(c.n)}</span>
                <span className="ht-card-t"><b>{c.title}</b><span className="muted">{c.sub}</span></span>
              </button>
            ))}
          </div>
          <div className="ht-chips">
            {chips.map((c) => (
              <button
                key={c.kind}
                type="button"
                className={`ht-chipbtn${isFocus(c.kind, undefined) ? ' ht-on' : ''}`}
                onClick={() => pick({ kind: c.kind }, 'all')}
                disabled={!c.n}
                aria-pressed={isFocus(c.kind, undefined)}
                title={c.n == null ? `셀 수 없음 — ${c.why}` : c.n > 0 ? '눌러서 이 호스트만 보기(다시 누르면 해제)' : '해당 호스트 없음'}
              >
                <i className="ht-gdot" style={{ background: c.tone === 'red' ? 'var(--red)' : c.tone === 'amber' ? 'var(--amber)' : 'var(--text-dim)' }} aria-hidden="true" />
                <span>{c.label}</span>
                <b className="tabular" style={{ color: c.n ? (c.tone === 'red' ? '#f87171' : '#fbbf24') : 'var(--text-dim)' }}>{c.n == null ? '—' : fmt(c.n)}</b>
              </button>
            ))}
          </div>
        </section>

        <div className="ht-panels">
          <section className="card ht-heat" aria-label="클러스터별 호스트 CPU">
            <div className="ht-head">
              <b>클러스터별 호스트 CPU</b>
              <span className="ht-legend">
                {CPU_BUCKETS.map((b) => <span key={b.key}><i className={`ht-cell ht-b-${b.key}`} />{b.label}</span>)}
              </span>
            </div>
            {tiles.length === 0 && <div className="muted">호스트가 없습니다.</div>}
            <div className={`ht-tiles${allTiles ? ' ht-all' : ''}`}>
              {visibleTiles.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={`ht-tile${t.attention > 0 ? ' ht-tile-hot' : ''}${isFocus('cluster', t.key) ? ' ht-on' : ''}`}
                  onClick={() => pick({ kind: 'cluster', value: t.key }, 'all')}
                  aria-pressed={isFocus('cluster', t.key)}
                >
                  <span className="ht-tile-h">
                    <span className="ht-tile-name" title={`${t.vcenterId} · ${t.cluster}`}><span className="muted">{t.vcenterId} · </span>{t.cluster}</span>
                    <span className="muted tabular">{fmt(t.count)}</span>
                  </span>
                  <span className="ht-cells" aria-hidden="true">
                    {t.cells.map((c, i) => <i key={`${c.name}-${i}`} className={`ht-cell ht-b-${c.bucket}`} title={`${c.name} — CPU ${pctText(c.pct)}`} />)}
                  </span>
                  <span className="muted tabular ht-tile-f">
                    평균 {pctText(t.avg)} · 최대 {pctText(t.max)}
                    {t.attention > 0 && <span className="badge red">확인 {t.attention}</span>}
                  </span>
                </button>
              ))}
            </div>
            {tiles.length > TILE_LIMIT_NARROW && (
              <button type="button" className={`btn ht-more${tiles.length <= TILE_LIMIT ? ' ht-more-narrow' : ''}`} onClick={() => setAllTiles((v) => !v)}>
                {allTiles ? '먼저 볼 클러스터만' : `모두 보기 (${fmt(tiles.length)}개 클러스터)`}
              </button>
            )}
          </section>

          <section className="card ht-dist" aria-label="CPU 사용률 분포">
            <div className="ht-head"><b>CPU 사용률 분포</b><span className="muted">호스트 수</span></div>
            {dist.map((b) => (
              <button
                key={b.key}
                type="button"
                className={`ht-bar-row${isFocus('bucket', b.key) ? ' ht-on' : ''}`}
                onClick={() => pick({ kind: 'bucket', value: b.key }, 'all')}
                disabled={b.count === 0}
                aria-pressed={isFocus('bucket', b.key)}
              >
                <span className="muted">{b.label}</span>
                <span className="ht-bar"><i className={`ht-b-${b.key}`} style={{ width: `${Math.round(b.share * 100)}%` }} /></span>
                <span className="tabular">{fmt(b.count)}</span>
              </button>
            ))}
            <div className="muted ht-note">막대를 누르면 아래 목록이 그 구간으로 걸러집니다. 사용률을 못 읽은 호스트는 0% 가 아니라 '미수집' 으로 따로 셉니다. CPU % 는 정격 용량 대비라 100% 를 넘을 수 있습니다.</div>
          </section>
        </div>

        <div className="ht-tablebar">
          <div className="ht-tabs" role="group" aria-label="목록 범위">
            <button type="button" className={`btn${curTab === 'attention' ? ' ht-tab-on' : ''}`} aria-pressed={curTab === 'attention'} onClick={() => setTab('attention')}>확인 대상 <span className="tabular">{fmt(counts.attention)}</span></button>
            <button type="button" className={`btn${curTab === 'all' ? ' ht-tab-on' : ''}`} aria-pressed={curTab === 'all'} onClick={() => setTab('all')}>전체 <span className="tabular">{fmt(rows.length)}</span></button>
          </div>
          {focus && (
            <span className="badge blue ht-chip">
              {focusLabelExt(focus)}
              <button type="button" className="ht-chip-x" onClick={() => setFocus(null)} aria-label="조건 해제">✕</button>
            </span>
          )}
          {nameFocus && (
            <span className="badge blue ht-chip" title="VM 표에서 넘어온 호스트 — 이 호스트 한 대만 보입니다">
              호스트 {nameFocus}
              <button type="button" className="ht-chip-x" onClick={() => onNameFocus && onNameFocus('')} aria-label="호스트 조건 해제">✕</button>
            </span>
          )}
          <span className="muted result-count">
            표시 <b style={{ color: 'var(--text)' }}>{fmt(shown.length)}</b> / 총 {fmt(rows.length)}개 호스트
            {filtered && <span className="badge blue" style={{ marginLeft: 8 }}>필터 적용 중</span>}
          </span>
          {/* v2.915: 점검 집계 · 엑셀 버튼은 표 머리(제목 줄은 허브로 올라갔다) */}
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn" onClick={loadChecks} disabled={checksBusy} title="iDRAC 부품 · 최근 재부팅 · Veeam 집계를 다시 읽습니다(무거운 집계라 자동 갱신하지 않습니다)">
              {checksBusy ? '점검 집계 읽는 중…' : `점검 집계 다시 읽기${checks?.at ? ` (${new Date(checks.at).toLocaleTimeString('ko-KR')})` : ''}`}
            </button>
            {csvOk && <button type="button" className="btn primary" onClick={openExport}>⤓ 호스트·클러스터 엑셀…</button>}
          </span>
        </div>
        <div className="ht-groups" role="group" aria-label="열 묶음">
          <span className="muted">열 묶음</span>
          {COL_GROUPS.map((g) => {
            const on = !off[g.key];
            const fixed = g.key === FIXED_GROUP;
            return (
              <button key={g.key} type="button" className={`ht-group${on ? ' ht-group-on' : ''}`} onClick={() => toggleGroup(g.key)} disabled={fixed} aria-pressed={on}
                title={fixed ? '기본 묶음은 끌 수 없습니다' : on ? '누르면 이 묶음의 열을 숨깁니다(이 브라우저에 기억)' : '누르면 이 묶음의 열을 보입니다'}>
                {dot(g)}{g.label}
              </button>
            );
          })}
          <span className="muted ht-groups-note">엑셀 ‘호스트 목록’ 시트와 같은 열 순서 · ‘—’ 는 못 읽은 값(0 이 아님){access && !access.hw ? ' · iDRAC 열은 관리자 판본에만' : ''}</span>
        </div>
        <DataTable
          className="ht-table"
          columns={columns}
          rows={shown}
          initialSort={{ key: 'cpuUsagePct', dir: 'desc' }}
          emptyText={curTab === 'attention' && !focus ? '확인할 호스트가 없습니다.' : '조건에 맞는 호스트가 없습니다.'}
        />
        <IpmsMatches filters={filters} />
        </>
      )}
      {exportOpen && exportVc && (
        <React.Suspense fallback={null}><HostExportDialog vcenterId={exportVc} vcName={exportVc} onClose={() => setExportOpen(false)} /></React.Suspense>
      )}
    </>
  );
}
