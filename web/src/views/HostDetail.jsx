// views/HostDetail.jsx — ESXi 호스트 상세 **전체 페이지**(#/hosts/<id>, v2.803 — 승인 시안 https://claude.ai/artifact/EFh5K3UDzuGpUpqVyqXPf1 ② · 사용자 선택 '전체 페이지').
//
// 화면을 복제하지 않는다 — 기존 호스트 상세 모달(components/EntityDetail.jsx)의 구성요소(HostBasicRows · HostCfgSection · PerfcSection ·
//   ClusterCfgSection · HostHbaTable · HostGpuPanel · HostPowerPanel · HostMetricButton · IdracTrendLinkButton · HostVmsModal)를 그대로 쓰고,
//   엑셀 '호스트 시트' 에만 있던 묶음(네트워크 NIC·스위치 · 스토리지 경로·데이터스토어 · 최근 재부팅 · VM 표)을 더한다.
// 데이터: /hosts/:id(호스트 한 대 — 새로고침·북마크) · /hosts/checks?vcenterId&q(이 호스트의 점검 한 줄) · /vms?host(VM 표). 폴링하지 않는다(열 때 1회 + 버튼).
//   늦게 온 이전 응답은 버린다(seq). 못 읽은 값은 '—'.
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { fetchJson, canCsv, toolAllowed } from '../api.js';
import { DataTable, UsageCell, StateBadge, Loading, ErrorBox } from '../components/ui.jsx';
import { HostBasicRows, HostCfgSection, PerfcSection, ClusterCfgSection, HostHbaTable, HostVmsModal, VmLink } from '../components/EntityDetail.jsx';
import { STable } from '../components/STable.jsx';
import { hostUsagePct } from './vcdOverview.js';
import { REBOOT_KIND } from './hostcfg/hostCfgText.js';
import { secCountsOf, secText, secTone, reasonBadges, bootCell, veeamCell, hwCell, uptimeDays, gbText, kwText, ratioText, nicLinkDownOf, uplinkDownOf } from './hostChecksText.js';

const HostPowerPanel = React.lazy(() => import('../components/HostPowerPanel.jsx'));
const HostGpuPanel = React.lazy(() => import('../components/HostGpuPanel.jsx'));
const HostMetricButton = React.lazy(() => import('../components/VmMetrics.jsx').then((m) => ({ default: m.HostMetricButton })));
const IdracTrendLinkButton = React.lazy(() => import('../components/IdracTrendLinkButton.jsx'));
const HostExportDialog = React.lazy(() => import('./HostExportDialog.jsx'));
const Lazy = ({ children }) => <React.Suspense fallback={null}>{children}</React.Suspense>;

const SECTIONS = [
  ['basic', '기본', '#3b82f6'], ['sec', '구성·보안', '#ef4444'], ['perfc', '경합·지연', '#f59e0b'], ['cluster', '클러스터', '#22d3ee'],
  ['net', '네트워크', '#60a5fa'], ['st', '스토리지', '#fb923c'], ['gpu', 'GPU', '#a78bfa'], ['idrac', '전력 · iDRAC', '#f59e0b'], ['boot', '재부팅', '#94a3b8'], ['vm', 'VM', '#22c55e'],
];
const timeText = (t) => (Number.isFinite(t) ? new Date(t).toLocaleString('ko-KR') : '—');
const numText = (v) => (Number.isFinite(v) ? v.toLocaleString('en-US') : '—');
const Card = ({ id, title, color, sub, children, flat = false }) => (
  <section id={`hd-${id}`} className="card hd-card">
    {title && <div className="hd-card-h"><b><i className="ht-gdot" style={{ background: color }} aria-hidden="true" />{title}</b>{sub ? <span className="muted">{sub}</span> : null}</div>}
    <div className={flat ? 'hd-flat' : ''}>{children}</div>
  </section>
);

export default function HostDetail({ id }) {
  const [st, setSt] = useState({ data: null, error: null });
  const [checks, setChecks] = useState(null);
  const [vms, setVms] = useState(null);
  const [showVms, setShowVms] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const my = ++seq.current;
    setSt({ data: null, error: null }); setChecks(null); setVms(null);
    fetchJson(`/hosts/${encodeURIComponent(id)}`)
      .then((d) => {
        if (my !== seq.current) return;
        setSt({ data: d, error: null });
        const h = d.item;
        fetchJson('/hosts/checks', { vcenterId: h.vcenterId, q: h.name }).then((c) => { if (my === seq.current) setChecks(c); }).catch(() => { if (my === seq.current) setChecks({ error: true }); });
        fetchJson('/vms', { host: h.name, vcenterId: h.vcenterId, limit: 5000, sortBy: 'name', order: 'asc' }).then((v) => { if (my === seq.current) setVms(v); }).catch((e) => { if (my === seq.current) setVms({ error: e?.message || String(e) }); });
      })
      .catch((e) => { if (my === seq.current) setSt({ data: null, error: e }); });
  }, [id]);

  const h = st.data?.item || null;
  const now = Date.now();
  const sec = useMemo(() => (h ? secCountsOf(h, now) : null), [h]); // eslint-disable-line react-hooks/exhaustive-deps
  const vmList = useMemo(() => (Array.isArray(vms?.items) ? vms.items : []), [vms]);
  const dsUse = useMemo(() => {
    // 이 호스트 VM 이 쓰는 데이터스토어(VM 장치 캐시 — 없으면 셀 수 없다)
    const m = new Map(); let noDev = 0;
    for (const v of vmList) {
      const disks = v?.dev?.disks;
      if (!Array.isArray(disks)) { noDev += 1; continue; }
      for (const n of new Set(disks.map((d) => d.datastore).filter(Boolean))) m.set(n, (m.get(n) || 0) + 1);
    }
    return { rows: [...m.entries()].map(([name, n]) => ({ name, vms: n })).sort((a, b) => b.vms - a.vms || a.name.localeCompare(b.name)), noDev };
  }, [vmList]);

  if (st.error) return <div><a href="#/hosts" className="hd-back">‹ 호스트 목록</a><ErrorBox error={st.error} /></div>;
  if (!h) return <Loading />;

  const vc = st.data.vcenter;
  const c = checks?.byId?.[h.id] || null;
  const bc = checks && !checks.error ? bootCell(c, h, checks.bootDays) : null;
  const vcell = checks && !checks.error ? veeamCell(c) : null;
  const hcell = checks && !checks.error && c && 'hw' in c ? hwCell(c) : null;
  const badges = reasonBadges(h, { sec, checks: checks?.byId || null });
  const up = uptimeDays(h, now);
  const vmOn = vmList.filter((v) => v.powerState === 'POWERED_ON').length;
  const vmSum = c?.vm || null;
  const net = h.hcfg?.net || null;
  const mp = h.hcfg?.mp || null;
  const nicDown = nicLinkDownOf(h);
  const upDown = uplinkDownOf(h, sec);
  const kpis = [
    { l: 'CPU 사용률', v: <UsageCell pct={hostUsagePct(h, 'cpuUsagePct')} />, s: Number.isFinite(h.cpuUsageMhz) && Number.isFinite(h.cpuTotalMhz) ? `${numText(h.cpuUsageMhz)} / ${numText(h.cpuTotalMhz)} MHz` : '' },
    { l: '메모리 사용률', v: <UsageCell pct={hostUsagePct(h, 'memUsagePct')} />, s: `${gbText(h.memUsageMB)} / ${gbText(h.memTotalMB)}` },
    { l: 'VM', v: numText(h.vmCount), s: vms ? `켜짐 ${numText(vmOn)} · 꺼짐 ${numText(vmList.length - vmOn)}` : '목록 읽는 중…' },
    { l: '할당 vCPU', v: vmSum ? numText(vmSum.vcpu) : '—', s: vmSum ? `vCPU:코어 ${ratioText(vmSum.vcpu, h.cpuCores)}${vmSum.vcpuUnknown ? ` · 못 읽은 VM ${vmSum.vcpuUnknown}` : ''}` : '' },
    { l: '할당 메모리', v: vmSum ? gbText(vmSum.memMB) : '—', s: vmSum && h.memTotalMB > 0 ? `물리 대비 ${ratioText(vmSum.memMB, h.memTotalMB)}` : '' },
    { l: '소비전력', v: kwText(h.powerWatts), s: h.powerSource === 'idrac' ? 'iDRAC 실측' : h.idracBacked ? 'vCenter 추정' : h.powerWatts > 0 ? 'vCenter' : '' },
    { l: '온도', v: Number.isFinite(h.tempC) ? `${h.tempC}℃` : '—', s: Number.isFinite(h.tempMaxC) ? `최고 ${h.tempMaxC}℃${Array.isArray(h.temps) ? ` · 센서 ${h.temps.length}개` : ''}` : '' },
    { l: '업타임', v: up == null ? '—' : `${up}일`, s: Number.isFinite(h.bootTime) ? `부팅 ${timeText(h.bootTime)}` : '부팅 시각 못 읽음' },
  ];
  const vmCols = [
    { key: 'name', label: 'VM', render: (v) => <VmLink item={v} name={v.name} vcenterId={v.vcenterId} label={v.name} /> },
    { key: 'powerState', label: '전원', render: (v) => <StateBadge state={v.powerState} /> },
    { key: 'cpuCount', label: 'vCPU', align: 'right', render: (v) => numText(v.cpuCount) },
    { key: 'memMB', label: 'RAM', align: 'right', render: (v) => gbText(v.memMB) },
    { key: 'cpuUsagePct', label: 'CPU', render: (v) => (v.powerState === 'POWERED_ON' ? <UsageCell pct={v.cpuUsagePct} /> : <span className="muted">—</span>) },
    { key: 'memUsagePct', label: '메모리 %', render: (v) => (v.powerState === 'POWERED_ON' ? <UsageCell pct={v.memUsagePct} /> : <span className="muted">—</span>) },
    { key: 'storageGB', label: '스토리지', align: 'right', render: (v) => (Number.isFinite(v.storageGB) ? `${numText(v.storageGB)} GB` : '—') },
    { key: 'ds', label: '데이터스토어', sortValue: (v) => (Array.isArray(v.dev?.disks) ? [...new Set(v.dev.disks.map((d) => d.datastore).filter(Boolean))].join(', ') : null), render: (v) => (Array.isArray(v.dev?.disks) ? <span className="muted">{[...new Set(v.dev.disks.map((d) => d.datastore).filter(Boolean))].join(', ') || '—'}</span> : <span className="muted" title="VM 장치 캐시를 아직 읽지 않았습니다">—</span>) },
    { key: 'guestOS', label: 'Guest OS', render: (v) => <span className="muted">{v.guestOS || '—'}</span> },
    { key: 'ipAddress', label: 'IP', render: (v) => <span className="tabular">{v.ipAddress || '—'}</span> },
    { key: 'toolsStatus', label: 'Tools', render: (v) => (v.toolsStatus ? <StateBadge state={v.toolsStatus} /> : '—') },
  ];

  return (
    <div className="hd">
      <div className="hd-top">
        <div className="hd-title">
          <a href="#/hosts" className="hd-back">‹ 호스트 목록</a>
          <div className="hd-name">
            <b>{h.name}</b>
            <StateBadge state={h.connectionState} />
            <span className={`badge ${h.powerState === 'POWERED_ON' ? 'green' : 'gray'}`}>전원 {h.powerState === 'POWERED_ON' ? 'On' : h.powerState ? 'Off' : '—'}</span>
            {sec && <span className={`badge ${secTone(sec)}`}>구성·보안 {secText(sec)}</span>}
            {hcell && <span className={`badge ${hcell.tone}`} title={hcell.title || undefined}>iDRAC {hcell.text}</span>}
            {badges.filter((b) => !['maint', 'down'].includes(b.kind)).map((b) => <span key={b.kind} className={`badge ${b.tone}`}>{b.label}</span>)}
          </div>
          <span className="muted hd-sub">
            vCenter {vc ? `${vc.name}${vc.location?.city ? `(${[vc.location.city, vc.location.country].filter(Boolean).join(', ')})` : ''}${vc.version ? ` · ${vc.version}` : ''}` : h.vcenterId}
            {h.vcDatacenter ? ` › 데이터센터 ${h.vcDatacenter}` : ''} › 클러스터 {h.cluster || '독립 호스트'}
            {' · '}vCenter ID {h.id}
            {st.data.generatedAt ? ` · 인벤토리 ${timeText(Date.parse(st.data.generatedAt))}` : ''}
            {Number.isFinite(h.hcfg?.at) ? ` · 구성 ${timeText(h.hcfg.at)}` : ' · 구성 아직 안 읽음'}
          </span>
        </div>
        <div className="hd-actions">
          <button type="button" className="hd-vmbtn" onClick={() => setShowVms(true)} title="이 호스트의 VM 목록(창)">VM {numText(h.vmCount)}대 보기 ›</button>
          <Lazy><HostMetricButton hostId={h.id} hostName={h.name} /></Lazy>
          <Lazy><IdracTrendLinkButton hostId={h.id} hostName={h.name} /></Lazy>
          {toolAllowed('host-hygiene') && <a className="btn" href="#/tools/host-hygiene" style={{ textDecoration: 'none' }}>구성 점검 열기</a>}
          {canCsv() && <button type="button" className="btn primary" onClick={() => setExportOpen(true)} title="이 vCenter 의 호스트·클러스터 엑셀(창에서 클러스터를 고를 수 있습니다)">⤓ 호스트·클러스터 엑셀…</button>}
        </div>
      </div>
      <nav className="hd-nav" aria-label="묶음 이동">
        {SECTIONS.filter(([k]) => k !== 'gpu' || h.gpus?.length > 0).map(([k, label, color]) => <a key={k} href={`#hd-${k}`} onClick={(e) => { e.preventDefault(); document.getElementById(`hd-${k}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}><i className="ht-gdot" style={{ background: color }} aria-hidden="true" />{label}</a>)}
      </nav>

      <div className="hd-kpis">
        {kpis.map((k) => (
          <div key={k.l} className="ht-kpi"><span className="ht-kpi-l">{k.l}</span><span className="ht-kpi-v hd-kpi-v">{k.v}</span><span className="ht-kpi-s" title={k.s}>{k.s || ' '}</span></div>
        ))}
      </div>

      <div className="hd-grid">
        <div className="hd-col">
          <Card id="basic" title="기본 정보" color="#3b82f6" sub="인벤토리 · 호스트 상세 창과 같은 행">
            <div className="hd-rows"><HostBasicRows item={h} onShowVms={() => setShowVms(true)} /></div>
          </Card>
          <Card id="sec" color="#ef4444" flat><HostCfgSection host={h} /></Card>
          <Card id="perfc" color="#f59e0b" flat><PerfcSection item={h} isVm={false} /></Card>
          <Card id="cluster" color="#22d3ee" flat><ClusterCfgSection item={h} isVm={false} /></Card>
          <Card id="boot" title="최근 재부팅" color="#94a3b8" sub={checks?.bootDays ? `부팅 시각 + vCenter 이벤트(최근 ${checks.bootDays}일) · 원인을 단정하지 않음` : '부팅 시각 + vCenter 이벤트 · 원인을 단정하지 않음'}>
            {!checks ? <div className="muted">읽는 중…</div> : checks.error ? <div className="muted">점검 집계를 읽지 못했습니다.</div> : !bc ? null : (
              <div className="hd-boot">
                <span>{timeText(c?.boot?.bootTime ?? h.bootTime)}</span>
                {c?.boot ? <span className={`badge ${bc.tone}`}>{bc.text.split(' · ')[0]}</span> : <span className="muted">{bc.text}</span>}
                <span className="muted">{c?.boot ? (REBOOT_KIND[c.boot.kind]?.note || '') : bc.title}{up != null ? ` · 업타임 ${up}일` : ''}</span>
              </div>
            )}
          </Card>
        </div>
        <div className="hd-col">
          <Card id="net" title="네트워크" color="#60a5fa" sub={`물리 NIC ${Array.isArray(h.nics) ? h.nics.length : '—'} · 링크 끊김 ${nicDown == null ? '—' : nicDown} · 쓰는 업링크 끊김 ${upDown == null ? '—' : upDown}${net ? ` · 가상 스위치 ${(net.switches || []).length} · 포트그룹 ${Number.isFinite(net.pgsTotal) ? net.pgsTotal : (net.pgs || []).length}` : ''}${h.mgmtIp ? ` · 관리 IP ${h.mgmtIp}` : ''}`}>
            {Array.isArray(h.nics) && h.nics.length ? (
              <div className="table-wrap" style={{ maxHeight: '32vh' }}>
                <STable>
                  <thead><tr><th>장치</th><th>모델</th><th style={{ textAlign: 'right' }}>속도</th><th>링크</th><th>스위치</th><th>MAC</th><th>드라이버</th></tr></thead>
                  <tbody>
                    {h.nics.map((n, i) => {
                      const sw = (net?.switches || []).find((x) => Array.isArray(x.uplinks) && x.uplinks.includes(n.device));
                      return (
                        <tr key={`${n.device || 'nic'}-${i}`}>
                          <td><b>{n.device || '—'}</b></td>
                          <td className="muted" style={{ fontSize: 12 }}>{[n.vendor, n.model].filter(Boolean).join(' ') || '—'}</td>
                          <td style={{ textAlign: 'right' }} data-sort={Number.isFinite(n.speedMb) ? n.speedMb : ''}>{Number.isFinite(n.speedMb) && n.speedMb > 0 ? `${n.speedMb >= 1000 ? `${n.speedMb / 1000} Gb` : `${n.speedMb} Mb`}` : '—'}{Number.isFinite(n.maxSpeedMb) && n.maxSpeedMb > 0 && n.maxSpeedMb !== n.speedMb ? <span className="muted"> / {n.maxSpeedMb >= 1000 ? `${n.maxSpeedMb / 1000} Gb` : `${n.maxSpeedMb} Mb`}</span> : null}</td>
                          <td>{n.link === true ? <span className="badge green">Up</span> : n.link === false ? <span className="badge red">Down</span> : <span className="muted">—</span>}</td>
                          <td>{sw ? `${sw.name}${sw.kind === 'dvs' ? '(분산)' : '(표준)'}` : <span className="muted">{net ? '안 씀' : '—'}</span>}</td>
                          <td className="muted" style={{ fontSize: 11 }}>{n.mac || '—'}</td>
                          <td className="muted" style={{ fontSize: 12 }}>{n.driver || '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </STable>
              </div>
            ) : <div className="muted">물리 NIC 정보가 인벤토리에 없습니다(REST 폴백 수집이거나 아직 읽지 않음).</div>}
            {net && (
              <div className="muted hd-note">
                {(net.switches || []).map((x) => `${x.name}(${x.kind === 'dvs' ? '분산' : '표준'} · 업링크 ${(x.uplinks || []).length ? x.uplinks.join('+') : '없음'} · 포트그룹 ${Number.isFinite(x.pgs) ? x.pgs : '—'})`).join(' · ') || '가상 스위치 없음'}
                {Array.isArray(net.pgs) && net.pgs.some((p) => p.promisc === true) ? ` · 무차별 모드 켜진 포트그룹 ${net.pgs.filter((p) => p.promisc === true).length}` : ''}
                {' · 포트그룹 전체는 ‘구성 점검 열기’ 에서'}
              </div>
            )}
          </Card>
          <Card id="st" title="스토리지" color="#fb923c" sub={`HBA ${Array.isArray(h.hbas) ? h.hbas.length : '—'}${mp ? ` · LUN ${mp.luns}(공유 ${mp.shared}) · 경로 ${mp.paths} · 죽은 경로 ${mp.dead}` : ' · 경로 정보 아직 안 읽음'}${h.hcfg?.vsan ? ` · vSAN ${h.hcfg.vsan.enabled === true ? '참여' : h.hcfg.vsan.enabled === false ? '참여 안 함' : '—'}` : ''}`}>
            <div style={{ marginTop: -14 }}><HostHbaTable item={h} /></div>
            {!(h.hbas?.length > 0) && <div className="muted">스토리지 어댑터(HBA) 정보가 인벤토리에 없습니다.</div>}
            <div className="muted" style={{ fontSize: 12, margin: '12px 0 6px' }}>이 호스트 VM 이 쓰는 데이터스토어 — {vms ? (dsUse.rows.length ? `${dsUse.rows.length}개` : '셀 수 없음') : '읽는 중…'}{dsUse.noDev ? ` · 장치를 못 읽은 VM ${dsUse.noDev}` : ''}</div>
            {dsUse.rows.length > 0 && (
              <div className="flex gap wrap">
                {dsUse.rows.map((d) => <span key={d.name} className="badge blue" title={`이 호스트 VM ${d.vms}대가 씁니다`}>{d.name} · {d.vms}</span>)}
              </div>
            )}
          </Card>
          {h.gpus?.length > 0 && (
            <Card id="gpu" title={`GPU — ${h.gpus.length}`} color="#a78bfa">
              <div className="flex gap wrap">
                {h.gpus.map((g, i) => <span key={i} className="badge gray" style={{ fontSize: 12 }}>{g.model}{g.memGB ? ` · ${g.memGB}GB` : ''}{g.vgpuMode ? ' · vGPU' : ''}</span>)}
              </div>
              <Lazy><HostGpuPanel hostId={h.id} hostName={h.name} /></Lazy>
            </Card>
          )}
          <Card id="idrac" color="#f59e0b" flat>
            <div style={{ marginTop: -16 }}><Lazy><HostPowerPanel hostName={h.name} serviceTag={h.serviceTag} /></Lazy></div>
          </Card>
        </div>
      </div>

      <Card id="vm" title={`이 호스트의 VM ${numText(h.vmCount)}대`} color="#22c55e" sub={vms && !vms.error ? `목록 ${numText(vmList.length)} · 켜짐 ${numText(vmOn)}${vmSum ? ` · 템플릿 ${numText(vmSum.templates)} · vCPU ${numText(vmSum.vcpu)} · 메모리 ${gbText(vmSum.memMB)}(할당)` : ''}${vcell ? ` · Veeam 최근 백업 ${vcell.text}` : ''}` : ''}>
        {!vms ? <div className="muted">VM 목록 읽는 중…</div> : vms.error ? <div className="muted">VM 목록을 읽지 못했습니다({vms.error}).</div> : (
          <DataTable className="ht-table" columns={vmCols} rows={vmList} initialSort={{ key: 'name', dir: 'asc' }} emptyText="이 호스트에 VM 이 없습니다." maxHeight="56vh" />
        )}
      </Card>

      {showVms && <HostVmsModal host={h.name} vcenterId={h.vcenterId} onClose={() => setShowVms(false)} />}
      {exportOpen && <React.Suspense fallback={null}><HostExportDialog vcenterId={h.vcenterId} vcName={vc?.name || h.vcenterId} onClose={() => setExportOpen(false)} /></React.Suspense>}
    </div>
  );
}
