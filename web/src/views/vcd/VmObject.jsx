/**
 * views/vcd/VmObject.jsx — VM '개체 보기'(v2.896 — 승인 시안 ⑧⑩⑪ · 기본값 8~10). vSphere Client 의 VM 개체 탭 8개.
 *   값은 /vms 한 행 + 캐시(vmcfg cfg · dev · perfc) + 온디맨드(파티션 · 이벤트 · 메트릭 — 열 때 1회)만 — 새 수집 없음.
 *   섹션은 지금 VM 상세 창(components/EntityDetail.jsx)의 것을 그대로 쓴다(복제 금지). 상태를 바꾸는 동작은 지금 버튼(권한 · 쓰기 범위) 그대로.
 */
import React, { useMemo } from 'react';
import { toolAllowed } from '../../api.js';
import { ErrorBox, Loading, StateBadge, UsageCell, GpuBadge } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { VmIpPing, VmCfgSection, VmPartitionsSection, VmTagsSection, VmChangesSection, PerfcSection, ClusterCfgSection } from '../../components/EntityDetail.jsx';
import { VmConsoleButton } from '../../components/VmConsole.jsx';
import { VmRemoteButton } from '../../components/VmRemote.jsx';
import { VmReconfigButton } from '../../components/VmReconfig.jsx';
import { dayStamp } from '../../dayStamp.js';
import ObjectShell from './ObjectShell.jsx';
import { Card, KV, Note, NotCollected } from './VcdParts.jsx';
import { useOnce, toolDenied } from './useOnce.js';
import { EventRows } from './SummaryTab.jsx';
import { vmDiskRows, vmDatastoreRows, vmSnapshotFacts, toolsStatusBadge } from './objTabs.js';
import { gbText, PERM_CATEGORY } from './vcdTabs.js';

const VmMetricButton = React.lazy(() => import('../../components/VmMetrics.jsx').then((m) => ({ default: m.VmMetricButton })));
const Lazy = ({ children }) => <React.Suspense fallback={null}>{children}</React.Suspense>;
const GRID = 'vcd-obj-grid';
const tsText = (t) => (Number.isFinite(t) && t > 0 ? new Date(t).toLocaleString('ko-KR') : '—');

export default function VmObject({ site, vcenterId, vm, vmsOk, gate, datastores, hosts, tab, onTab, onBack, onOpenHost, extraTabs, extra }) {
  const disks = useMemo(() => (vm ? vmDiskRows(vm, datastores) : null), [vm, datastores]);
  const dsRows = useMemo(() => vmDatastoreRows(disks), [disks]);
  if (!vm) {
    return (
      <div style={{ marginTop: 10 }}>
        <button type="button" className="vcd-more" onClick={onBack}>← VM 및 폴더</button>
        <div style={{ marginTop: 10 }}>{vmsOk ? <div className="card muted" style={{ padding: 14 }}>이 vCenter 의 VM 목록에 이 VM 이 없습니다 — 지워졌거나 이름이 바뀌어 다시 등록됐을 수 있습니다(주소의 id 로 찾았습니다).</div> : gate}</div>
      </div>
    );
  }
  const host = (hosts || []).find((h) => h.name === vm.host && h.vcenterId === vm.vcenterId) || null;
  const powered = vm.powerState === 'POWERED_ON';
  const ips = vm.ipAddresses?.length ? vm.ipAddresses : (vm.ipAddress ? [vm.ipAddress] : []);
  const cfg = vm.cfg && !vm.cfg.error ? vm.cfg : null;
  const snap = vmSnapshotFacts(vm);
  const [tb, tt] = toolsStatusBadge(vm.toolsVersionStatus);
  const capSum = disks ? disks.reduce((a, d) => a + (d.capacityGB ?? 0), 0) : null;
  const crumbs = [site?.name || vcenterId, vm.vcDcPath || null, vm.folder && vm.folder !== 'vm' ? vm.folder : null];

  return (
    <ObjectShell type="vm" crumbs={crumbs} onBack={onBack} backLabel="VM 및 폴더" title={vm.name}
      badges={<><StateBadge state={vm.powerState} /><StateBadge state={vm.toolsStatus} />{vm.template && <span className="badge gray">템플릿</span>}{vm.connectionState && vm.connectionState !== 'connected' && <span className="badge amber">{vm.connectionState}</span>}</>}
      sub={`${vm.guestOS || '—'} · 호스트 ${vm.host || '—'} · 클러스터 ${vm.cluster || '—'}${vm.resourcePool ? ` · 리소스 풀 ${vm.resourcePool}` : ''}${ips[0] ? ` · ${ips[0]}` : ''}`}
      actions={<><VmReconfigButton vm={vm} /><VmConsoleButton vmId={vm.id} vmName={vm.name} /><VmRemoteButton item={vm} /><Lazy><VmMetricButton vmId={vm.id} vmName={vm.name} /></Lazy></>}
      tab={tab} onTab={onTab} extraTabs={extraTabs}>

      {tab === 'summary' && (
        <>
          <div className={GRID}>
            <Card title="VM 하드웨어" sub="/vms · vmcfg">
              <KV rows={[
                ['CPU', `${vm.cpuCount ?? '—'} vCPU${cfg ? ` · 핫애드 ${cfg.cpuHotAdd === true ? '켜짐' : cfg.cpuHotAdd === false ? '꺼짐' : '—'}` : ''}`],
                ['메모리', vm.memMB != null ? `${gbText(vm.memMB / 1024)}${cfg ? ` · 핫애드 ${cfg.memHotAdd === true ? '켜짐' : cfg.memHotAdd === false ? '꺼짐' : '—'}` : ''}` : '—'],
                ['하드 디스크', disks ? `${disks.length}개 · ${gbText(capSum)}${disks.some((d) => d.rdm) ? ` · RDM ${disks.filter((d) => d.rdm).length}` : ''}` : <span className="muted" key="d">아직 읽지 않음</span>],
                ['디스크 사용', `${gbText(vm.storageGB)}${vm.uncommittedGB ? ` · 미할당 ${gbText(vm.uncommittedGB)}(씬)` : ''}`],
                ['CD/DVD', Array.isArray(vm.dev?.cdroms) ? `${vm.dev.cdroms.length}개 · 연결 ${vm.dev.cdroms.filter((c) => c.connected).length}` : '—'],
                ['네트워크 어댑터', <span className="muted" key="n">장치는 수집하지 않음 · IP {ips.length}개(게스트 보고)</span>],
                ['GPU', vm.gpu ? <GpuBadge key="g" gpu={vm.gpu} /> : <span className="muted" key="g">없음</span>],
                ['호환성', vm.hwVersion || '—'],
                ['펌웨어', cfg?.firmware ? (cfg.firmware === 'efi' ? 'EFI' : cfg.firmware === 'bios' ? 'BIOS' : cfg.firmware) : '—'],
              ]} />
            </Card>
            <Card title="게스트 OS" sub="VMware Tools 보고">
              <KV rows={[
                ['OS(설정)', cfg?.guestIdConfig || vm.guestOS || '—'],
                ['OS(Tools 보고)', cfg?.guestNameTools || cfg?.guestIdTools || '—'],
                ['호스트 이름', cfg?.guestHostName ? <span className="mono" key="h">{cfg.guestHostName}</span> : '—'],
                ['IP', ips.length ? <VmIpPing key="ip" vcenterId={vm.vcenterId} ips={ips} /> : '—'],
                ['게이트웨이', (vm.gateways || []).length ? <span className="mono" key="gw">{vm.gateways.join(' · ')}</span> : '—'],
                ['DNS', (vm.dns || []).length ? <span className="mono" key="dns">{vm.dns.join(' · ')}</span> : '—'],
                ['VMware Tools', <span key="t">{vm.toolsVersion || '—'} <span className={`badge ${tb}`}>{tt}</span></span>],
                ['부팅 시각', tsText(cfg?.bootTime)],
              ]} />
            </Card>
            <Card title="관련 개체">
              <KV rows={[
                ['vCenter', site?.name || vcenterId],
                ['데이터센터', vm.vcDcPath || '—'],
                ['클러스터', vm.cluster || '—'],
                ['호스트', host ? <button key="h" type="button" className="vcd-more" onClick={() => onOpenHost(host.id)}>{host.name} →</button> : (vm.host || '—')],
                ['리소스 풀', vm.resourcePool || '—'],
                ['폴더', vm.folder || '—'],
                ['데이터스토어', dsRows ? (dsRows.map((d) => d.datastore || '—').join(' · ') || '—') : <span className="muted" key="ds">아직 읽지 않음</span>],
                ['네트워크', <span className="muted" key="pg">포트그룹은 수집하지 않음</span>],
                ['관리 솔루션', cfg?.managedBy ? [cfg.managedBy.extensionKey, cfg.managedBy.type].filter(Boolean).join(' · ') : '없음'],
              ]} />
            </Card>
            <Card title="사용률" sub="quickStats · 경합은 최근 창(perfc)">
              <div style={{ padding: '12px 14px', display: 'grid', gap: 9 }}>
                <div className="vcd-line"><span className="muted" style={{ width: 64 }}>CPU</span>{powered ? <UsageCell pct={vm.cpuUsagePct} /> : <span className="muted">— (꺼짐)</span>}</div>
                <div className="vcd-line"><span className="muted" style={{ width: 64 }}>메모리</span>{powered ? <UsageCell pct={vm.memUsagePct} /> : <span className="muted">— (꺼짐)</span>}</div>
              </div>
              <div style={{ padding: '0 14px 12px' }}><PerfcSection item={vm} isVm /></div>
            </Card>
          </div>
          <Card title="구성 점검 · 클러스터"><div style={{ padding: '0 14px 12px' }}><VmCfgSection vm={vm} /><ClusterCfgSection item={vm} isVm /></div></Card>
          <div className={GRID}>
            <Card title="태그 · 메모"><div style={{ padding: '0 14px 12px' }}><VmTagsSection vm={vm} /><KV rows={[['메모', vm.notes ? <span key="m" style={{ whiteSpace: 'pre-wrap' }}>{vm.notes}</span> : '—']]} /></div></Card>
            <Card title="최근 변경 · 이동"><div style={{ padding: '0 14px 12px' }}>{toolAllowed('vm-changes') ? <VmChangesSection vm={vm} /> : <ErrorBox error={toolDenied('VM 이동·구성 변경 이력')} />}</div></Card>
          </div>
        </>
      )}

      {tab === 'monitor' && (
        <div className={GRID}>
          <Card title="성능" sub="vCenter 성능 롤업 · 열 때 조회(저장 안 함)">
            <div style={{ padding: 14, display: 'grid', gap: 10 }}>
              <div className="muted" style={{ fontSize: 12.5 }}>CPU · 메모리 · 디스크 · 네트워크를 실시간 ~ 1년 기간으로 봅니다. 포탈은 VM 별 시계열을 저장하지 않으므로 누를 때 vCenter 에 묻습니다.</div>
              <div><Lazy><VmMetricButton vmId={vm.id} vmName={vm.name} /></Lazy></div>
            </div>
          </Card>
          <Card title="이벤트 · 이동"><div style={{ padding: '0 14px 12px' }}>{toolAllowed('vm-changes') ? <VmChangesSection vm={vm} /> : <ErrorBox error={toolDenied('VM 이동·구성 변경 이력')} />}</div></Card>
          <div className="card" style={{ padding: 14 }}><NotCollected title="최근 작업">이 VM 을 대상으로 한 작업 목록(TaskManager)은 수집하지 않습니다.</NotCollected></div>
        </div>
      )}

      {tab === 'configure' && (
        <>
          <Card title="하드웨어 장치" sub={vm.dev?.at ? `vmcfg · 읽은 시각 ${tsText(vm.dev.at)}` : 'vmcfg'}>
            {!disks ? <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>vmcfg 가 아직 이 VM 의 장치를 읽지 않았습니다(오래된 VM 부터 나눠 읽습니다) — 빈 표가 아닙니다.</div> : (
              <STable className="v3-table" minWidth={680}>
                <thead><tr><th>장치</th><th>용량</th><th>데이터스토어</th><th>모드 / 공유</th><th>RDM</th></tr></thead>
                <tbody>
                  {disks.map((d, i) => (
                    <tr key={`${d.label}-${i}`}><td><b>{d.label}</b></td><td data-sort={d.capacityGB == null ? '' : String(d.capacityGB)}>{gbText(d.capacityGB)}</td><td className="mono">{d.datastore || '—'}</td><td>{d.mode || '—'} / {d.sharing || '—'}</td><td>{d.rdm ? (d.rdmMode || '예') : '—'}</td></tr>
                  ))}
                  {(vm.dev.cdroms || []).map((c, i) => (
                    <tr key={`cd-${i}`}><td><b>{c.label || 'CD/DVD'}</b></td><td>—</td><td className="mono">{c.file || (c.host ? '호스트 장치' : '—')}</td><td>{c.connected ? '연결됨' : '연결 안 됨'}</td><td>—</td></tr>
                  ))}
                </tbody>
              </STable>
            )}
            <Note>네트워크 어댑터 장치(유형 · 포트그룹 · 연결)는 수집하지 않습니다(2차). USB {vm.dev?.usb ?? '—'} · 직렬 {vm.dev?.serial ?? '—'} · 병렬 {vm.dev?.parallel ?? '—'}.</Note>
          </Card>
          <Card title="설정 점검"><div style={{ padding: '0 14px 12px' }}><VmCfgSection vm={vm} /></div></Card>
        </>
      )}

      {tab === 'perms' && <PermPane vcenterId={vcenterId} entity={vm.name} what="이 VM" />}

      {tab === 'datastores' && (
        <>
          <Card title="데이터스토어" sub="디스크별(vmcfg) · 사용률(/datastores)">
            {!dsRows ? <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>vmcfg 가 아직 이 VM 의 디스크를 읽지 않았습니다.</div> : (
              <STable className="v3-table" minWidth={620}>
                <thead><tr><th>데이터스토어</th><th>유형</th><th>이 VM 디스크</th><th>디스크 용량</th><th>DS 사용률</th></tr></thead>
                <tbody>
                  {dsRows.map((d) => (
                    <tr key={d.datastore || '-'}><td className="mono"><b>{d.datastore || '—'}</b></td><td>{d.dsType || '—'}</td><td>{d.disks}</td><td data-sort={d.capacityGB == null ? '' : String(d.capacityGB)}>{gbText(d.capacityGB)}</td><td data-sort={d.dsUsagePct == null ? '' : String(d.dsUsagePct)}>{d.dsKnown ? <UsageCell pct={d.dsUsagePct} /> : <span className="muted">목록에 없음</span>}</td></tr>
                  ))}
                </tbody>
              </STable>
            )}
          </Card>
          <Card title="게스트 파티션" sub="Tools 보고 · 열 때 1회"><div style={{ padding: '0 14px 12px' }}><VmPartitionsSection vm={vm} /></div></Card>
        </>
      )}

      {tab === 'network' && (
        <div className={GRID}>
          <Card title="네트워크" sub="게스트 보고(guest.net · ipStack)">
            <KV rows={[
              ['IP', ips.length ? <VmIpPing key="ip" vcenterId={vm.vcenterId} ips={ips} /> : '—'],
              ['게이트웨이', (vm.gateways || []).length ? vm.gateways.join(' · ') : '—'],
              ['DNS', (vm.dns || []).length ? vm.dns.join(' · ') : '—'],
              ['호스트 이름', cfg?.guestHostName || '—'],
            ]} />
            <Note>IP 는 VMware Tools 가 보고한 값입니다 — 꺼졌거나 Tools 가 없으면 비어 있습니다(‘IP 없음’ 이 아닙니다). 핑은 버튼을 누를 때만.</Note>
          </Card>
          <div className="card" style={{ padding: 14 }}><NotCollected title="네트워크 어댑터 · 포트그룹 · vSwitch">VM 장치의 백킹(어댑터 유형 vmxnet3/e1000 · 포트그룹 · 연결 상태)은 수집하지 않습니다. 추가하면 이 탭과 성능 튜닝의 구성 권장에 들어갑니다.</NotCollected></div>
        </div>
      )}

      {tab === 'snapshots' && (
        <div className={GRID}>
          <Card title="스냅샷" badge={snap.count ? <span className={`badge ${snap.oldestDays != null && snap.oldestDays > 7 ? 'amber' : 'blue'}`}>{snap.count}개</span> : null}>
            <KV rows={[
              ['개수 · 크기', snap.count == null ? '—' : `${snap.count}개 · ${gbText(snap.sizeGB)}`],
              ['가장 오래된 것', snap.oldestTs ? `${dayStamp(snap.oldestTs)} · ${snap.oldestDays}일` : '—'],
              ['이름', snap.names.length ? snap.names.join(' · ') : '—'],
              ['고아 델타', snap.orphanDeltaGB ? gbText(snap.orphanDeltaGB) : '없음'],
            ]} />
            <Note>스냅샷 삭제 · 되돌리기 같은 동작은 두지 않습니다(조회 전용). 나이 기준 목록은 특수 기능 ‘스냅샷 나이 감시’.</Note>
          </Card>
          <div className="card" style={{ padding: 14 }}><NotCollected title="스냅샷 트리">스냅샷의 부모 관계 · 설명 · 생성 시각별 트리(rootSnapshotList)는 수집하지 않습니다. 지금은 개수 · 크기 · 가장 오래된 것 · 이름만 압니다.</NotCollected></div>
        </div>
      )}

      {tab === 'updates' && (
        <div className={GRID}>
          <Card title="업데이트" sub="지금 아는 것">
            <KV rows={[
              ['VMware Tools', <span key="t">{vm.toolsVersion || '—'} <span className={`badge ${tb}`}>{tt}</span></span>],
              ['호환성(하드웨어 버전)', vm.hwVersion || '—'],
              ['호스트 ESXi', host ? `${host.version || '—'}${host.build ? ` · ${host.build}` : ''}` : '—'],
            ]} />
            <Note>Tools 업그레이드는 지금 도구(VMware Tools 버전 · 쓰기 범위)에서 합니다 — 이 탭은 조회 전용입니다.</Note>
          </Card>
        </div>
      )}

      {extra}
    </ObjectShell>
  );
}

/** 사용 권한 탭(VM · 호스트 공용) — 이 개체가 대상인 권한 · 역할 변경 이벤트(최근 90일) + 권한 목록은 수집하지 않음. */
export function PermPane({ vcenterId, entity, what }) {
  const ok = toolAllowed('change-history');
  const q = useOnce('/tools/report/changes', { vcenterId, days: 90, category: PERM_CATEGORY, entity, limit: 300 }, ok && !!entity);
  return (
    <div className={GRID}>
      <Card title="지금 아는 것" badge={<span className="badge blue">권한 · 역할 변경 이벤트</span>} sub={`${what} · 최근 90일`}>
        {!ok ? <div style={{ padding: 12 }}><ErrorBox error={toolDenied('구성 변경 이력')} /></div>
          : q.error && !q.data ? <div style={{ padding: 12 }}><ErrorBox error={q.error} /></div>
            : !q.data ? <Loading label="권한 변경 이벤트" /> : <EventRows data={q.data} vcenterId={vcenterId} empty={`최근 90일에 ${what}을(를) 대상으로 한 권한 · 역할 변경 이벤트가 없습니다.`} />}
        <Note>대상 이름이 들어간 이벤트를 찾은 것입니다(부분 일치). 목록이 아니라 변경 기록이라, 지금 누가 어떤 역할인지는 알 수 없습니다.</Note>
      </Card>
      <div className="card" style={{ padding: 14 }}><NotCollected title="권한 목록">사용자/그룹 · 역할 · 정의 위치 · 전파(상속)는 수집하지 않습니다. 추가한다면 읽기 전용 · 탭을 열 때만 · 관리자 판본에서만 보입니다.</NotCollected></div>
    </div>
  );
}
