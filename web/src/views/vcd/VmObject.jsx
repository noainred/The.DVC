/**
 * views/vcd/VmObject.jsx — VM '개체 보기'(v2.895 — 승인 시안 ⑧⑩⑪ · 기본값 8~10). vSphere Client 의 VM 개체 탭 8개.
 *   값은 /vms 한 행 + 캐시(vmcfg cfg · dev · perfc) + 온디맨드(파티션 · 이벤트 · 메트릭 — 열 때 1회)만.
 *   v2.898: 네트워크 어댑터(dev.nics) · 스냅샷 트리(snapshotTree) — 주기 수집이 이미 받던 장치 · 스냅샷 XML 을 넓혀 읽은 값(새 vCenter 호출 없음).
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
import { numOrNull } from '../../numOrNull.js';
import ObjectShell from './ObjectShell.jsx';
import { Card, KV, Note } from './VcdParts.jsx';
import { VcAlarmsCard, VcTasksCard, VcPermsCard } from './VcInfoParts.jsx';
import { useOnce, toolDenied } from './useOnce.js';
import { EventRows } from './SummaryTab.jsx';
import { vmDiskRows, vmDatastoreRows, vmSnapshotFacts, toolsStatusBadge, snapTreeRows, vmNicRows } from './objTabs.js';
import { gbText, PERM_CATEGORY } from './vcdTabs.js';
// v2.909(가상화 서버 허브 시안 ⑨): 요약 탭 4/5/3 — 사용률 게이지 · 24시간 추이(열 때 1회) · 신호(서버 판정) · 스냅샷 · 최근 변경.
import { useDaySeries, Spark } from '../vms/vmSeries.jsx';
import { signalText, usageTone, TONE_COLOR, TONE_TEXT, barW, pctText } from '../vms/vmHubText.js';
import '../vms/vmHub.css';

const VmMetricButton = React.lazy(() => import('../../components/VmMetrics.jsx').then((m) => ({ default: m.VmMetricButton })));
const VmPerfView = React.lazy(() => import('../../components/vmperf/VmPerfView.jsx')); // v2.911 성능 — 모니터 탭 첫 섹션(시안 docs/design/vm-perf ②)
const Lazy = ({ children }) => <React.Suspense fallback={null}>{children}</React.Suspense>;
const GRID = 'vcd-obj-grid';
/** 포탈 VM · 호스트 id('<vcenterId>:<moref>')의 moref — vCenter id 에 콜론이 있어도 vcenterId 앞머리로 자른다. */
export const vmRef = (o) => (o?.id && o?.vcenterId && String(o.id).startsWith(`${o.vcenterId}:`) ? String(o.id).slice(String(o.vcenterId).length + 1) : null);
const tsText = (t) => (Number.isFinite(t) && t > 0 ? new Date(t).toLocaleString('ko-KR') : '—');

export default function VmObject({ site, vcenterId, vm, vmsOk, gate, datastores, hosts, networks, tab, onTab, onBack, onOpenHost, extraTabs, extra, sigCounts = null }) {
  const disks = useMemo(() => (vm ? vmDiskRows(vm, datastores) : null), [vm, datastores]);
  const nics = useMemo(() => (vm ? vmNicRows(vm, networks) : null), [vm, networks]);
  const dsRows = useMemo(() => vmDatastoreRows(disks), [disks]);
  // v2.909: 24시간 추이 — 요약 탭을 볼 때만 · 켜진 VM 만(훅은 조기 return 위 — React #310).
  const series = useDaySeries(vm?.id, !!vm && vm.powerState === 'POWERED_ON' && tab === 'summary');
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
  const sigDays = numOrNull(sigCounts?.snapAgeDays);
  const sigs = Array.isArray(vm.signals) ? vm.signals : null;
  const sto = numOrNull(vm.storageGB);
  const unc = numOrNull(vm.uncommittedGB);
  const diskPct = sto != null && unc != null && sto + unc > 0 ? Math.round((sto / (sto + unc)) * 100) : null;
  const cpuPct = powered ? numOrNull(vm.cpuUsagePct) : null;
  const memPct = powered ? numOrNull(vm.memUsagePct) : null;

  return (
    <ObjectShell type="vm" crumbs={crumbs} onBack={onBack} backLabel="VM 및 폴더" title={vm.name}
      badges={<><StateBadge state={vm.powerState} /><StateBadge state={vm.toolsStatus} />{vm.template && <span className="badge gray">템플릿</span>}{vm.connectionState && vm.connectionState !== 'connected' && <span className="badge amber">{vm.connectionState}</span>}
        {(vm.signals || []).map((k) => { const x = signalText(k, { days: sigDays }); return <span key={k} className={`vmh-badge ${x.badge}`} title={x.desc}>{x.short}</span>; })}</>}
      sub={`${vm.guestOS || '—'} · 호스트 ${vm.host || '—'} · 클러스터 ${vm.cluster || '—'}${vm.resourcePool ? ` · 리소스 풀 ${vm.resourcePool}` : ''}${ips[0] ? ` · ${ips[0]}` : ''}`}
      actions={<><VmReconfigButton vm={vm} /><VmConsoleButton vmId={vm.id} vmName={vm.name} /><VmRemoteButton item={vm} /><Lazy><VmMetricButton vmId={vm.id} vmName={vm.name} vcenterId={vm.vcenterId} /></Lazy></>}
      tab={tab} onTab={onTab} extraTabs={extraTabs}>

      {tab === 'summary' && (
        <>
          {/* v2.909(시안 ⑨): 4 / 5 / 3 세 열 — 왼쪽 구성(하드웨어 · 관련 개체 · 태그), 가운데 상태(사용률 · 경합 · 게스트), 오른쪽 할 일(신호 · 스냅샷 · 변경).
              예전 2열 격자는 1440 에서 '사용률' 카드 옆 두 칸이 비었다(캡처). 1280 미만은 두 열 · 760 미만은 한 열(vmHub.css .vmo-grid). */}
          <div className="vmo-grid">
            <div className="vmo-col">
              <Card title="VM 하드웨어" sub="/vms · vmcfg">
                <KV rows={[
                  ['CPU', `${vm.cpuCount ?? '—'} vCPU${cfg ? ` · 핫애드 ${cfg.cpuHotAdd === true ? '켜짐' : cfg.cpuHotAdd === false ? '꺼짐' : '—'}` : ''}`],
                  ['메모리', vm.memMB != null ? `${gbText(vm.memMB / 1024)}${cfg ? ` · 핫애드 ${cfg.memHotAdd === true ? '켜짐' : cfg.memHotAdd === false ? '꺼짐' : '—'}` : ''}` : '—'],
                  ['하드 디스크', disks ? `${disks.length}개 · ${gbText(capSum)}${disks.some((d) => d.rdm) ? ` · RDM ${disks.filter((d) => d.rdm).length}` : ''}` : <span className="muted" key="d">아직 읽지 않음</span>],
                  ['디스크 사용', `${gbText(vm.storageGB)}${vm.uncommittedGB ? ` · 미할당 ${gbText(vm.uncommittedGB)}(씬)` : ''}`],
                  ['CD/DVD', Array.isArray(vm.dev?.cdroms) ? `${vm.dev.cdroms.length}개 · 연결 ${vm.dev.cdroms.filter((c) => c.connected).length}` : '—'],
                  ['네트워크 어댑터', nics ? `${nics.length}개 · 연결 ${nics.filter((n) => n.connected).length}${nics[0]?.adapter ? ` · ${[...new Set(nics.map((n) => n.adapter).filter(Boolean))].join(' · ')}` : ''}` : <span className="muted" key="n">아직 읽지 않음 · IP {ips.length}개(게스트 보고)</span>],
                  ['GPU', vm.gpu ? <GpuBadge key="g" gpu={vm.gpu} /> : <span className="muted" key="g">없음</span>],
                  ['호환성', vm.hwVersion || '—'],
                  ['펌웨어', cfg?.firmware ? (cfg.firmware === 'efi' ? 'EFI' : cfg.firmware === 'bios' ? 'BIOS' : cfg.firmware) : '—'],
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
                  ['네트워크', nics ? ([...new Set(nics.map((n) => n.net || n.netRef).filter(Boolean))].join(' · ') || '—') : <span className="muted" key="pg">아직 읽지 않음</span>],
                  ['관리 솔루션', cfg?.managedBy ? [cfg.managedBy.extensionKey, cfg.managedBy.type].filter(Boolean).join(' · ') : '없음'],
                ]} />
              </Card>
              <Card title="태그 · 메모"><div style={{ padding: '0 14px 12px' }}><VmTagsSection vm={vm} /><KV rows={[['메모', vm.notes ? <span key="m" style={{ whiteSpace: 'pre-wrap' }}>{vm.notes}</span> : '—']]} /></div></Card>
            </div>
            <div className="vmo-col">
              <Card title="사용률" sub={powered ? 'quickStats · 24시간 추이는 이 탭을 열 때 1회 조회(저장 안 함)' : '꺼진 VM — 사용률이 없습니다'}>
                <div className="vmo-gauges">
                  {[['CPU', cpuPct, vm.cpuCount != null ? `${vm.cpuCount} vCPU` : 'vCPU 모름'], ['메모리', memPct, vm.memMB != null ? gbText(vm.memMB / 1024) : '할당 모름'], ['디스크', diskPct, `${gbText(vm.storageGB)} 사용 · 프로비저닝 대비`]].map(([label, v, sub]) => {
                    const tone = label === '디스크' ? (v == null ? 'none' : 'ok') : usageTone(v);
                    const color = label === '디스크' ? 'var(--accent-2)' : TONE_COLOR[tone];
                    return (
                      <div key={label} className="vmo-gauge">
                        <div className="vmo-ring" role="img" aria-label={`${label} ${pctText(v)}`} style={{ background: `conic-gradient(${color} ${barW(v)}%, var(--panel-deep) 0)` }}>
                          <i /><b style={{ color: label === '디스크' ? undefined : TONE_TEXT[tone] }}>{v == null ? '—' : <>{v}<small>%</small></>}</b>
                        </div>
                        <span className="gl">{label}</span><span className="gs">{sub}</span>
                      </div>
                    );
                  })}
                </div>
                {powered && (
                  <div className="vmo-sparks">
                    <div className="vmo-srow"><span className="muted">CPU 24h</span><span className="vmo-sp"><Spark series={series.cpu} color="var(--red)" /></span></div>
                    <div className="vmo-srow"><span className="muted">메모리 24h</span><span className="vmo-sp"><Spark series={series.mem} color="var(--amber)" /></span></div>
                  </div>
                )}
              </Card>
              <Card title="경합 · 최근 창" sub="perfc · vCPU 당 % · 판정은 평균"><div style={{ padding: '0 14px 12px' }}><PerfcSection item={vm} isVm /></div></Card>
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
            </div>
            <div className="vmo-col">
              <Card title={`신호 ${sigs ? sigs.length : '—'}`} sub="서버 판정">
                <div style={{ padding: '8px 14px 12px' }}>
                  {!sigs ? <span className="muted" style={{ fontSize: 12 }}>이 목록은 신호를 함께 받지 않았습니다.</span>
                    : !sigs.length ? <span className="muted" style={{ fontSize: 12 }}>신호 없음 — 과부하 · 사용률 미수집 · Tools 업그레이드 · 오래된 스냅샷 모두 해당하지 않습니다.</span>
                      : (
                        <div className="vmh-sigrows">
                          {sigs.map((k) => {
                            const x = signalText(k, { days: sigDays });
                            return (
                              <div key={k} className="vmh-sigrow">
                                <span className="vmh-dot" style={{ background: x.tone === 'crit' ? 'var(--red)' : x.tone === 'warn' ? 'var(--amber)' : 'var(--text-faint)' }} aria-hidden="true" />
                                <div className="t"><b>{x.label}</b><span>{x.desc}</span></div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                </div>
              </Card>
              <Card title="스냅샷" badge={snap.count ? <span className={`badge ${snap.oldestDays != null && sigDays != null && snap.oldestDays >= sigDays ? 'amber' : 'blue'}`}>{snap.count}개</span> : null}>
                <KV rows={[
                  ['개수 · 크기', snap.count == null ? '—' : `${snap.count}개 · ${gbText(snap.sizeGB)}`],
                  ['가장 오래된 것', snap.oldestTs ? `${dayStamp(snap.oldestTs)} · ${snap.oldestDays}일` : '—'],
                  ['이름', snap.names.length ? snap.names.slice(0, 3).join(' · ') + (snap.names.length > 3 ? ` 외 ${snap.names.length - 3}` : '') : '—'],
                ]} />
                <div style={{ padding: '0 14px 12px' }}><button type="button" className="vcd-more" onClick={() => onTab('snapshots')}>스냅샷 트리 보기 →</button></div>
              </Card>
              <Card title="최근 변경 · 이동"><div style={{ padding: '0 14px 12px' }}>{toolAllowed('vm-changes') ? <VmChangesSection vm={vm} /> : <ErrorBox error={toolDenied('VM 이동·구성 변경 이력')} />}</div></Card>
            </div>
          </div>
          <Card title="구성 점검 · 클러스터"><div style={{ padding: '0 14px 12px' }}><VmCfgSection vm={vm} /><ClusterCfgSection item={vm} isVm /></div></Card>
        </>
      )}

      {tab === 'monitor' && (
        <>
          {/* v2.911(시안 docs/design/vm-perf ②): 성능은 모달이 아니라 이 탭의 첫 섹션 — 4지표 1회 조회 · 과거 창 · 구간 요약. */}
          <Lazy><VmPerfView entityType="vm" id={vm.id} name={vm.name} vcenterId={vm.vcenterId} powered={powered} /></Lazy>
        <div className={GRID}>
          {/* 성능 카드가 빠져 혼자 남은 줄 — 한 줄을 다 쓴다(v2.911 Chromium 확인: 3열 격자에 혼자 좁게 남았다). */}
          <Card title="이벤트 · 이동" style={{ gridColumn: '1 / -1' }}><div style={{ padding: '0 14px 12px' }}>{toolAllowed('vm-changes') ? <VmChangesSection vm={vm} /> : <ErrorBox error={toolDenied('VM 이동·구성 변경 이력')} />}</div></Card>
          <VcAlarmsCard vcenterId={vcenterId} entityType="VirtualMachine" entity={vmRef(vm)} wide />
          <VcTasksCard vcenterId={vcenterId} entityType="VirtualMachine" entity={vmRef(vm)} wide />
        </div>
        </>
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
                  {(nics || []).map((n, i) => (
                    <tr key={`nic-${i}`}><td><b>{n.label}</b></td><td>{n.adapter || '—'}</td><td className="mono">{n.net || n.netRef || '—'}</td><td>{n.connected == null ? '—' : n.connected ? '연결됨' : '연결 안 됨'}</td><td>—</td></tr>
                  ))}
                </tbody>
              </STable>
            )}
            <Note>{nics ? '' : '네트워크 어댑터는 아직 이 판의 수집기가 읽지 않았습니다(장치를 다시 읽으면 채워집니다). '}USB {vm.dev?.usb ?? '—'} · 직렬 {vm.dev?.serial ?? '—'} · 병렬 {vm.dev?.parallel ?? '—'}.</Note>
          </Card>
          <Card title="설정 점검"><div style={{ padding: '0 14px 12px' }}><VmCfgSection vm={vm} /></div></Card>
        </>
      )}

      {tab === 'perms' && <PermPane vcenterId={vcenterId} entity={vm.name} what="이 VM" objType="VirtualMachine" objRef={vmRef(vm)} />}

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
          <VmNicCard vm={vm} nics={nics} />
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
          <SnapTreeCard vm={vm} />
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

/** v2.898: 네트워크 어댑터 표(vm.dev.nics — 장치 XML). 분산 포트그룹 이름 · VLAN 은 /networks 에서 찾는다. */
function VmNicCard({ vm, nics }) {
  return (
    <Card style={{ gridColumn: '1 / -1' }} title={`네트워크 어댑터${nics ? ` ${nics.length}` : ''}`} sub={vm.dev?.at ? `vmcfg 장치 · 읽은 시각 ${tsText(vm.dev.at)}` : 'vmcfg 장치'}>
      {!nics ? <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>{vm.dev ? '이 VM 의 장치는 이전 판 수집기가 읽어 어댑터 정보가 없습니다 — 장치를 다시 읽으면 채워집니다(오래된 VM 부터 나눠 읽습니다).' : 'vmcfg 가 아직 이 VM 의 장치를 읽지 않았습니다 — 빈 표가 아닙니다.'}</div>
        : !nics.length ? <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>네트워크 어댑터가 없습니다.</div> : (
          <STable className="v3-table" minWidth={720}>
            <thead><tr><th>어댑터</th><th>유형</th><th>네트워크</th><th>종류</th><th>VLAN</th><th>MAC</th><th>연결</th><th>시작 시 연결</th></tr></thead>
            <tbody>
              {nics.map((n, i) => (
                <tr key={`${n.label}-${i}`}>
                  <td><b>{n.label}</b></td><td>{n.adapter || '—'}</td>
                  <td className="mono" style={{ overflowWrap: 'anywhere' }}>{n.net || (n.netRef ? <span className="muted">{n.netRef}</span> : '—')}</td>
                  <td>{n.backing}</td><td data-sort={n.vlan == null ? '' : String(n.vlan)}>{n.vlan ?? '—'}</td>
                  <td className="mono">{n.mac || '—'}</td>
                  <td>{n.connected == null ? '—' : <span className={`badge ${n.connected ? 'green' : 'amber'}`}>{n.connected ? '연결됨' : '연결 안 됨'}</span>}</td>
                  <td>{n.startConnected == null ? '—' : n.startConnected ? '예' : '아니요'}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        )}
      <Note>장치 설정 기준입니다(vCenter 가 보고한 구성 — 게스트 안의 링크 상태가 아닙니다). 분산 포트그룹 이름 · VLAN 은 이 vCenter 의 네트워크 목록에서 찾은 값이고, 못 찾으면 참조(dvportgroup-…)만 보입니다.</Note>
    </Card>
  );
}

/** v2.898: 스냅샷 트리(vm.snapshotTree — 전위 순서 · d=깊이). 동작(되돌리기 · 삭제)은 두지 않는다. */
function SnapTreeCard({ vm }) {
  const t = snapTreeRows(vm);
  // 개수를 못 읽었으면(REST 폴백 등 — 키 없음) '스냅샷 없음' 이 아니라 모른다(반증 하-1 · vmSnapshotFacts 와 같은 numOrNull 판정).
  const count = numOrNull(vm.snapshotCount);
  return (
    <Card title="스냅샷 트리" sub="주기 수집 · snapshot 속성" badge={t?.rows.length ? <span className="badge blue">{t.rows.length}개</span> : null}>
      {count == null && !t?.rows.length ? <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>이 VM 의 스냅샷 정보를 받지 못했습니다(‘없음’ 이 아닙니다).</div>
        : count === 0 && !t?.rows.length ? <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>스냅샷이 없습니다.</div>
        : !t ? <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>이 VM 의 스냅샷 트리는 아직 이 판의 수집기가 읽지 않았습니다(다음 수집 주기에 채워집니다). 개수 · 이름은 위 카드에 있습니다.</div>
          : (
            <div role="tree" aria-label="스냅샷 트리" style={{ padding: '6px 14px 10px', display: 'grid', gap: 2 }}>
              {t.rows.map((r, i) => (
                // 들여쓰기는 6단까지만 키운다(400px 에서 이름 칸이 사라지지 않게 — 깊이 자체는 aria-level 에 그대로).
                <div key={i} role="treeitem" aria-level={r.d + 1} aria-current={r.current ? 'true' : undefined}
                  style={{ marginLeft: Math.min(r.d, 6) * 16, padding: r.d ? '5px 0 5px 10px' : '5px 0', borderLeft: r.d ? '2px solid var(--border)' : 'none', minWidth: 0 }}>
                  <div className="vcd-line" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <b style={{ overflowWrap: 'anywhere' }}>{r.name || '(이름 없음)'}</b>
                    {r.current && <span className="badge green">현재 위치</span>}
                    {r.days != null && r.days > 7 && <span className="badge amber">{r.days}일</span>}
                  </div>
                  <div className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
                    {[r.ts ? `${dayStamp(r.ts)}${r.days != null ? ` · ${r.days}일 전` : ''}` : '생성 시각 —', r.state ? `상태 ${r.state}` : null, r.quiesced ? `정지(quiesce) ${r.quiesced}` : null].filter(Boolean).join(' · ')}
                  </div>
                  {r.desc && <div style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>{r.desc}</div>}
                </div>
              ))}
            </div>
          )}
      {t?.partial && <Note>{`트리에 ${t.rows.length}개만 보입니다(전체 ${t.count}개) — 수집 상한을 넘었거나 일부 노드를 읽지 못했습니다.`}</Note>}
      <Note>위에서 아래로 만든 순서이고, 들여쓴 것이 그 위 스냅샷의 자식입니다. ‘현재 위치’ 는 VM 이 지금 딛고 있는 스냅샷입니다. 되돌리기 · 삭제는 두지 않습니다(조회 전용).</Note>
    </Card>
  );
}

/** 사용 권한 탭(VM · 호스트 공용) — 이 개체가 대상인 권한 · 역할 변경 이벤트(최근 90일) + 권한 목록은 수집하지 않음. */
export function PermPane({ vcenterId, entity, what, objType = null, objRef = null }) {
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
      <VcPermsCard vcenterId={vcenterId} entityType={objType} entity={objRef} what={what} wide />
    </div>
  );
}
