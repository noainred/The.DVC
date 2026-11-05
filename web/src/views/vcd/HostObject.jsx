/**
 * views/vcd/HostObject.jsx — ESXi 호스트 '개체 보기'(v2.895 — 승인 시안 ⑨⑩ · 기본값 8~10). vSphere Client 의 호스트 개체 탭 9개.
 *   값은 /hosts 한 행 + 캐시(hcfg · perfc) + /vms(이 호스트 위) + 온디맨드(이벤트 · 메트릭)만 — 새 수집 없음.
 *   섹션은 호스트 상세 창 · 전체 페이지(#/hosts/<id>)의 것을 그대로 쓴다(복제 금지). 더 자세한 표(NIC · 스토리지 경로 · 재부팅 · iDRAC)는 전체 페이지로 보낸다.
 */
import React, { useMemo } from 'react';
import { toolAllowed } from '../../api.js';
import { ErrorBox, Loading, StateBadge, UsageCell } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { HostBasicRows, HostCfgSection, PerfcSection, ClusterCfgSection, HostHbaTable } from '../../components/EntityDetail.jsx';
import { hostUsagePct } from '../vcdOverview.js';
import ObjectShell from './ObjectShell.jsx';
import { Card, KV, Note, NotCollected } from './VcdParts.jsx';
import { useOnce, toolDenied } from './useOnce.js';
import { EventRows } from './SummaryTab.jsx';
import { PermPane, vmRef } from './VmObject.jsx';
import { VcAlarmsCard, VcTasksCard, HostVlcmCard } from './VcInfoParts.jsx';
import { vmsOnHost, resourcePoolRows, hostDatastoresFromVms, sameBuildCount } from './objTabs.js';
import { gbText } from './vcdTabs.js';

const HostMetricButton = React.lazy(() => import('../../components/VmMetrics.jsx').then((m) => ({ default: m.HostMetricButton })));
const Lazy = ({ children }) => <React.Suspense fallback={null}>{children}</React.Suspense>;
const GRID = 'vcd-obj-grid';

export default function HostObject({ site, vcenterId, host, hostsOk, gate, hosts, vms, vmsOk, datastores, tab, onTab, onBack, onOpenVm, extraTabs, extra }) {
  const onHost = useMemo(() => (host ? vmsOnHost(vms, host) : []), [vms, host]);
  const pools = useMemo(() => resourcePoolRows(onHost), [onHost]);
  const dsFromVms = useMemo(() => hostDatastoresFromVms(onHost, datastores), [onHost, datastores]);
  if (!host) {
    return (
      <div style={{ marginTop: 10 }}>
        <button type="button" className="vcd-more" onClick={onBack}>← 호스트 및 클러스터</button>
        <div style={{ marginTop: 10 }}>{hostsOk ? <div className="card muted" style={{ padding: 14 }}>이 vCenter 의 호스트 목록에 이 호스트가 없습니다 — 제거됐거나 다시 등록됐을 수 있습니다.</div> : gate}</div>
      </div>
    );
  }
  const sb = sameBuildCount(hosts, host);
  const hc = host.hcfg && !host.hcfg.error ? host.hcfg : null;
  const tabs = (extraTabs || []);
  const crumbs = [site?.name || vcenterId, host.vcDatacenter || null, host.cluster && host.cluster !== 'standalone' ? host.cluster : null];

  return (
    <ObjectShell type="host" crumbs={crumbs} onBack={onBack} backLabel="호스트 및 클러스터" title={host.name}
      badges={<><StateBadge state={host.connectionState} />{host.powerState && <span className={`badge ${host.powerState === 'POWERED_ON' ? 'green' : 'gray'}`}>{host.powerState === 'POWERED_ON' ? '전원 켜짐' : '전원 꺼짐'}</span>}</>}
      sub={`${host.version ? `ESXi ${host.version}${host.build ? ` build-${host.build}` : ''}` : 'ESXi —'} · ${[host.vendor, host.model].filter(Boolean).join(' ') || '모델 —'}${host.serviceTag ? ` · 서비스 태그 ${host.serviceTag}` : ''}`}
      actions={<><Lazy><HostMetricButton hostId={host.id} hostName={host.name} /></Lazy><a className="tab" style={{ flex: 'none', padding: '8px 14px' }} href={`#/hosts/${encodeURIComponent(host.id)}`}>전체 페이지 상세 →</a></>}
      tab={tab} onTab={onTab} extraTabs={tabs}>

      {tab === 'summary' && (
        <>
          <Card title="하드웨어 · 상태" sub="/hosts">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: '0 24px', padding: '8px 14px 12px' }}>
              <HostBasicRows item={host} onShowVms={() => onTab('vms')} />
            </div>
          </Card>
          <div className={GRID}>
            <Card title="사용률" sub="quickStats · 경합은 최근 창(perfc)">
              <div style={{ padding: '12px 14px', display: 'grid', gap: 9 }}>
                <div className="vcd-line"><span className="muted" style={{ width: 64 }}>CPU</span><UsageCell pct={hostUsagePct(host, 'cpuUsagePct')} /></div>
                <div className="vcd-line"><span className="muted" style={{ width: 64 }}>메모리</span><UsageCell pct={hostUsagePct(host, 'memUsagePct')} /></div>
              </div>
              <div style={{ padding: '0 14px 12px' }}><PerfcSection item={host} isVm={false} /></div>
            </Card>
            <Card title="클러스터"><div style={{ padding: '0 14px 12px' }}><ClusterCfgSection item={host} isVm={false} /></div></Card>
          </div>
        </>
      )}

      {tab === 'monitor' && (
        <div className={GRID}>
          <Card title="성능" sub="vCenter 성능 롤업 · 누를 때 조회">
            <div style={{ padding: 14, display: 'grid', gap: 10 }}>
              <div className="muted" style={{ fontSize: 12.5 }}>CPU · 메모리 · 디스크 · 네트워크를 실시간 ~ 1년 기간으로 봅니다.</div>
              <div><Lazy><HostMetricButton hostId={host.id} hostName={host.name} /></Lazy></div>
            </div>
          </Card>
          <HostEvents vcenterId={vcenterId} host={host} />
          <VcAlarmsCard vcenterId={vcenterId} entityType="HostSystem" entity={vmRef(host)} wide />
          <VcTasksCard vcenterId={vcenterId} entityType="HostSystem" entity={vmRef(host)} wide />
        </div>
      )}

      {tab === 'configure' && (
        <>
          <Card title="구성 · 보안"><div style={{ padding: '0 14px 12px' }}><HostCfgSection host={host} /></div></Card>
          <Card title="스토리지 어댑터(HBA)"><div style={{ padding: '0 14px 12px' }}><HostHbaTable item={host} /></div></Card>
        </>
      )}

      {tab === 'perms' && <PermPane vcenterId={vcenterId} entity={host.name} what="이 호스트" objType="HostSystem" objRef={vmRef(host)} />}

      {tab === 'vms' && (
        <Card title={`VM ${vmsOk ? onHost.length : '—'}`} sub="이 호스트 위(수집기가 VM 행에 실은 호스트 이름으로 대조)">
          {!vmsOk ? <div style={{ padding: 12 }}>{gate}</div> : onHost.length ? (
            <STable className="v3-table" minWidth={820}>
              <thead><tr><th>이름</th><th>전원</th><th>vCPU</th><th>메모리</th><th>CPU</th><th>메모리 사용</th><th>리소스 풀</th><th data-nosort="">열기</th></tr></thead>
              <tbody>
                {onHost.map((v) => {
                  const on = v.powerState === 'POWERED_ON';
                  return (
                    <tr key={v.id}>
                      <td><b>{v.name}</b></td>
                      <td><StateBadge state={v.powerState} /></td>
                      <td>{v.cpuCount ?? '—'}</td>
                      <td data-sort={String(v.memMB ?? '')}>{v.memMB != null ? gbText(v.memMB / 1024) : '—'}</td>
                      <td data-sort={on ? String(v.cpuUsagePct ?? '') : ''}>{on ? <UsageCell pct={v.cpuUsagePct} /> : <span className="muted">—</span>}</td>
                      <td data-sort={on ? String(v.memUsagePct ?? '') : ''}>{on ? <UsageCell pct={v.memUsagePct} /> : <span className="muted">—</span>}</td>
                      <td>{v.resourcePool || '—'}</td>
                      <td><button type="button" className="vcd-more" onClick={() => onOpenVm(v.id)}>개체 →</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>이 호스트 위에 VM 이 없습니다.</div>}
          <Note>꺼진 VM 의 사용률은 ‘—’ 입니다. ‘Off VM 포함’ 설정과 무관하게 이 호스트의 VM 전부입니다.</Note>
        </Card>
      )}

      {tab === 'pools' && (
        <div className={GRID}>
          <Card title="리소스 풀" sub="VM 의 리소스 풀 이름으로 묶은 합">
            {!vmsOk ? <div style={{ padding: 12 }}>{gate}</div> : pools.length ? (
              <STable className="v3-table" minWidth={520}>
                <thead><tr><th>풀</th><th>VM</th><th>켜짐</th><th>vCPU 합</th><th>메모리 합</th></tr></thead>
                <tbody>
                  {pools.map((p) => (
                    <tr key={p.pool || '-'}><td><b>{p.pool || '—'}</b></td><td>{p.vms}</td><td>{p.on}</td><td>{p.vcpu}</td><td data-sort={String(p.memMB)}>{gbText(p.memMB / 1024)}</td></tr>
                  ))}
                </tbody>
              </STable>
            ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>이 호스트 위에 VM 이 없습니다.</div>}
          </Card>
          <div className="card" style={{ padding: 14 }}><NotCollected title="리소스 풀 속성">풀 자체의 예약 · 제한 · 공유 값(ResourcePool.config)은 수집하지 않습니다 — 지금은 VM 쪽 이름으로만 묶습니다.</NotCollected></div>
        </div>
      )}

      {tab === 'datastores' && (
        <div className={GRID}>
          <Card title="VM 디스크로 역산한 데이터스토어" sub="이 호스트 VM 의 디스크가 놓인 곳(vmcfg)">
            {!vmsOk ? <div style={{ padding: 12 }}>{gate}</div> : dsFromVms.rows.length ? (
              <STable className="v3-table" minWidth={560}>
                <thead><tr><th>데이터스토어</th><th>유형</th><th>VM</th><th>디스크</th><th>사용률</th></tr></thead>
                <tbody>
                  {dsFromVms.rows.map((d) => (
                    <tr key={d.datastore}><td className="mono"><b>{d.datastore}</b></td><td>{d.type || '—'}</td><td>{d.vms}</td><td>{d.disks}</td><td data-sort={d.usagePct == null ? '' : String(d.usagePct)}><UsageCell pct={d.usagePct} /></td></tr>
                  ))}
                </tbody>
              </STable>
            ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>디스크를 읽은 VM 이 없습니다.</div>}
            {dsFromVms.unread > 0 && <Note>vmcfg 가 아직 디스크를 읽지 않은 VM {dsFromVms.unread}대는 빠졌습니다 — 그 VM 의 데이터스토어가 이 목록에 없을 수 있습니다.</Note>}
          </Card>
          <div className="card" style={{ padding: 14 }}><NotCollected title="호스트별 데이터스토어 마운트">호스트가 마운트한 데이터스토어 목록 · 경로(활성/대기)는 이 화면이 직접 읽지 않습니다. 경로 상태는 ‘전체 페이지 상세’ 와 특수 기능 ‘데이터스토어 · 경로 점검’ 에 있습니다.</NotCollected></div>
        </div>
      )}

      {tab === 'network' && (
        <div className={GRID}>
          <Card title="물리 NIC" sub="pnic + pciDevice">
            {(host.nics || []).length ? (
              <STable className="v3-table" minWidth={560}>
                <thead><tr><th>장치</th><th>모델</th><th>드라이버</th><th>링크</th><th>속도</th></tr></thead>
                <tbody>
                  {host.nics.map((n) => (
                    <tr key={n.device}><td className="mono"><b>{n.device}</b></td><td>{n.model || '—'}</td><td>{n.driver || '—'}</td><td><span className={`badge ${n.link ? 'green' : 'gray'}`}>{n.link ? 'up' : 'down'}</span></td><td data-sort={String(n.speedMb || n.maxSpeedMb || '')}>{n.speedMb ? `${n.speedMb / 1000} GbE` : n.maxSpeedMb ? `— (정격 ${n.maxSpeedMb / 1000} GbE)` : '—'}</td></tr>
                  ))}
                </tbody>
              </STable>
            ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>물리 NIC 를 보고하지 않았습니다(이 vCenter 가 주지 않았거나 아직 읽지 않음).</div>}
          </Card>
          <HostNetCards host={host} />
          <div className="card" style={{ padding: 14 }}><NotCollected title="팀 구성">NIC 팀 구성(LACP · 액티브/스탠바이 · 부하 분산 정책)은 수집하지 않습니다. 가상 스위치 · 포트그룹은 위 표(ESXi 호스트 구성 점검 수집 — hcfg)입니다.</NotCollected></div>
        </div>
      )}

      {tab === 'updates' && (
        <div className={GRID}>
          <Card title="업데이트" sub="지금 아는 것">
            <KV rows={[
              ['ESXi', host.version ? `${host.version}${host.build ? ` · build ${host.build}` : ''}` : '—'],
              ['이 vCenter 안 같은 빌드', sb ? `${sb.same} / ${sb.total} 호스트` : '—'],
              ['vCenter', site?.version ? `${site.version}${site.build ? ` · ${site.build}` : ''}` : '—'],
              ['재부팅 필요', hc ? (hc.rebootRequired === true ? <span className="badge amber" key="r">예</span> : hc.rebootRequired === false ? '아니오' : '—') : <span className="muted" key="r">아직 읽지 않음</span>],
            ]} />
          </Card>
          <HostVlcmCard vcenterId={vcenterId} host={host} hostRef={vmRef(host)} />
        </div>
      )}

      {extra}
    </ObjectShell>
  );
}

function HostEvents({ vcenterId, host }) {
  const ok = toolAllowed('change-history');
  const q = useOnce('/tools/report/changes', { vcenterId, days: 7, entity: host.name, limit: 300 }, ok);
  return (
    <Card title="이벤트" sub="이 호스트 · 최근 7일 · 구성 변경 이력과 같은 출처">
      {!ok ? <div style={{ padding: 12 }}><ErrorBox error={toolDenied('구성 변경 이력')} /></div>
        : q.error && !q.data ? <div style={{ padding: 12 }}><ErrorBox error={q.error} /></div>
          : !q.data ? <Loading label="이벤트" /> : <EventRows data={q.data} vcenterId={vcenterId} empty="최근 7일에 이 호스트가 대상인 변경 이벤트가 없습니다." />}
      <Note>대상 이름에 호스트 이름이 들어간 이벤트입니다(부분 일치).</Note>
    </Card>
  );
}

/**
 * v2.898 정정: 호스트 가상 스위치 · 포트그룹은 v2.701(A10)부터 ESXi 호스트 구성 점검 수집(hcfg.net)이 이미 읽고 있었다 — v2.895 가 '수집하지 않음' 이라고
 * 잘못 적었다. hcfg 를 아직 읽지 않았으면 그 사실을, net 이 null 이면 '받지 못함' 을 말한다(원인을 단정하지 않는다).
 */
function HostNetCards({ host }) {
  const hc = host.hcfg && typeof host.hcfg === 'object' && !host.hcfg.error ? host.hcfg : null;
  const net = hc ? hc.net : undefined;
  if (!hc || net == null) {
    return (
      <Card title="가상 스위치 · 포트그룹" sub="ESXi 호스트 구성 점검 수집(hcfg)">
        <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>{!hc ? '아직 이 호스트의 구성을 읽지 않았습니다(오래된 호스트부터 나눠 읽습니다).' : '이 호스트의 가상 스위치 · 포트그룹 값을 받지 못했습니다.'}</div>
      </Card>
    );
  }
  const sws = Array.isArray(net.switches) ? net.switches : [];
  const pgs = Array.isArray(net.pgs) ? net.pgs : [];
  return (
    <>
      <Card title={`가상 스위치 ${sws.length}`} sub="hcfg.net · 표준(vSS) · 분산(vDS)">
        {sws.length ? (
          <STable className="v3-table" minWidth={520}>
            <thead><tr><th>이름</th><th>종류</th><th>업링크</th><th>포트그룹</th></tr></thead>
            <tbody>
              {sws.map((w, i) => (
                <tr key={`${w.name}-${i}`}><td><b>{w.name}</b></td><td>{w.kind === 'dvs' ? '분산(vDS)' : '표준(vSS)'}</td><td className="mono" style={{ whiteSpace: 'normal' }}>{(w.uplinks || []).join(' · ') || '—'}</td><td data-sort={w.pgs == null ? '' : String(w.pgs)}>{w.pgs == null ? '—' : w.pgs}</td></tr>
              ))}
            </tbody>
          </STable>
        ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>가상 스위치가 없다고 보고했습니다.</div>}
      </Card>
      <Card title={`포트그룹 ${net.pgsTotal != null ? net.pgsTotal : pgs.length}`} sub="표준 스위치 포트그룹(hcfg.net) · 분산 포트그룹은 vCenter › 네트워크 탭">
        {pgs.length ? (
          <STable className="v3-table" minWidth={520} limit={200}>
            <thead><tr><th>이름</th><th>VLAN</th><th>vSwitch</th><th>무차별 모드</th></tr></thead>
            <tbody>
              {pgs.map((g, i) => (
                <tr key={`${g.name}-${i}`}><td><b>{g.name}</b></td><td data-sort={g.vlan == null ? '' : String(g.vlan)}>{g.vlan == null ? '—' : g.vlan}</td><td>{g.sw || '—'}</td><td>{g.promisc === true ? <span className="badge amber">허용</span> : g.promisc === false ? '거부' : '—'}</td></tr>
              ))}
            </tbody>
          </STable>
        ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>표준 스위치 포트그룹이 없다고 보고했습니다.</div>}
        {net.pgsTotal != null && net.pgsTotal > pgs.length && <Note>포트그룹 {net.pgsTotal}개 중 {pgs.length}개만 받았습니다(수집 상한).</Note>}
      </Card>
    </>
  );
}
