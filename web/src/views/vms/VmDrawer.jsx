// views/vms/VmDrawer.jsx — 가상화 서버에서 VM 을 누르면 열리는 상세 드로어(v2.909 · 시안 docs/design/vm-screen ⑦·⑧).
//   예전 640px 가운데 모달(EntityDetail type='vm')을 바꾼 것 — **모달의 기능은 빠짐없이 옮긴다**:
//   KV 17항목(이름·전원은 머리, CPU·메모리 사용률은 타일, IP 는 네트워크 칸) · 게스트 파티션 · 구성 점검 · 경합 · 클러스터 · 태그 · 최근 변경 ·
//   버튼 6개(사양 변경 · 콘솔 · 원격 접속 · 메트릭 · 축소 근거 리포트 · 개체 보기). 섹션은 EntityDetail.jsx 에서 **꺼내 재사용**(복제 금지).
//   달라진 것: 목록이 뒤에 남는다(오른쪽 드로어 — 720 미만은 전체 화면 시트) · ‹ › 와 ↑↓ 로 목록 순서대로 이전/다음 VM ·
//   신호(서버 판정 inventory/vmSignals.js)를 위에 · 24시간 추이(CPU·메모리)는 **열 때 1회**(/vms/:id/metrics interval=day — 폴링 없음,
//   VM 을 넘기면 이전 VM 의 늦은 응답은 버린다 — AbortController + id 확인).
import React, { useEffect, useRef, useState } from 'react';
import { toolAllowed } from '../../api.js';
import EscClose from '../../components/EscClose.jsx';
import { StateBadge, GpuBadge } from '../../components/primitives.jsx';
import {
  VmIpPing, VmPartitionsSection, VmCfgSection, PerfcSection, ClusterCfgSection, VmTagsSection, VmChangesSection, ObjectViewButton,
} from '../../components/EntityDetail.jsx';
import { VmConsoleButton } from '../../components/VmConsole.jsx';
import { VmRemoteButton } from '../../components/VmRemote.jsx';
import { VmReconfigButton } from '../../components/VmReconfig.jsx';
import { vcHash } from '../vcd/vcdRoute.js';
import { VM_OBJ_TABS, toolsStatusBadge } from '../vcd/objTabs.js';
import { neighborOf, signalText, usageTone, pctText, fmtN, TONE_COLOR, TONE_TEXT } from './vmHubText.js';
import { useDaySeries, Spark } from './vmSeries.jsx';
import { numOrNull } from '../../numOrNull.js';
import './vmHub.css';

const VmMetricButton = React.lazy(() => import('../../components/VmMetrics.jsx').then((m) => ({ default: m.VmMetricButton })));
const RightsizeReport = React.lazy(() => import('../tools/RightsizeReport.jsx'));
const Lazy = ({ children }) => <React.Suspense fallback={null}>{children}</React.Suspense>;
const DAY = 86_400_000;
const POWER_DOT = { POWERED_ON: ['var(--green)', '켜짐'], POWERED_OFF: ['var(--text-faint)', '꺼짐'], SUSPENDED: ['var(--amber)', '일시 정지'] };

function KV({ label, children, full = false }) {
  return <div className={full ? 'full' : undefined}><span>{label}</span><b>{children}</b></div>;
}

/** 신호 한 줄의 근거 글자(판정은 서버 — 여기서는 값만 보여 준다). */
function signalFact(k, vm, now) {
  if (k === 'overload') return `CPU ${pctText(numOrNull(vm.cpuUsagePct))} · 메모리 ${pctText(numOrNull(vm.memUsagePct))}`;
  if (k === 'usageUnknown') return `CPU ${pctText(numOrNull(vm.cpuUsagePct))} · 메모리 ${pctText(numOrNull(vm.memUsagePct))} — 못 읽은 값은 0 도 100 도 아닙니다`;
  if (k === 'toolsOld') return `Tools ${vm.toolsVersion || '버전 모름'} · 상태 ‘${toolsStatusBadge(vm.toolsVersionStatus)[1]}’`;
  if (k === 'snapOld') {
    const ts = numOrNull(vm.snapshotOldestTs);
    return `스냅샷 ${fmtN(vm.snapshotCount)}개 · ${fmtN(vm.snapshotSizeGB)} GB${ts ? ` · 가장 오래된 것 ${Math.max(0, Math.floor((now - ts) / DAY))}일` : ''}`;
  }
  return '';
}

export default function VmDrawer({ vm, rows, onClose, onMove, days = null }) {
  const rootRef = useRef(null);
  const backRef = useRef(null);
  const [showReport, setShowReport] = useState(false);
  const on = vm?.powerState === 'POWERED_ON';
  const series = useDaySeries(vm?.id, on);
  // 열 때 포커스를 드로어로(키보드 ↑↓·Esc) · 닫을 때 원래 자리로.
  useEffect(() => {
    backRef.current = typeof document !== 'undefined' ? document.activeElement : null;
    rootRef.current?.focus({ preventScroll: true });
    return () => { try { backRef.current?.focus?.({ preventScroll: true }); } catch { /* 사라진 요소 */ } };
  }, []);
  useEffect(() => { setShowReport(false); }, [vm?.id]);
  if (!vm) return null;

  const nb = neighborOf(rows, vm.id);
  const now = Date.now();
  const [dotColor, dotLabel] = POWER_DOT[vm.powerState] || ['var(--text-faint)', vm.powerState || '전원 모름'];
  const sigs = Array.isArray(vm.signals) ? vm.signals : null;
  const ips = vm.ipAddresses?.length ? vm.ipAddresses : (vm.ipAddress ? [vm.ipAddress] : []);
  const cpu = on ? numOrNull(vm.cpuUsagePct) : null;
  const mem = on ? numOrNull(vm.memUsagePct) : null;
  const sto = numOrNull(vm.storageGB);
  const unc = numOrNull(vm.uncommittedGB);
  const diskPct = sto != null && unc != null && sto + unc > 0 ? Math.round((sto / (sto + unc)) * 100) : null;
  const gb = (mb) => `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB`;
  const [tb, tt] = toolsStatusBadge(vm.toolsVersionStatus);
  const onKey = (e) => {
    const tag = String(e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key === 'ArrowDown' && nb.next) { e.preventDefault(); onMove(nb.next); }
    else if (e.key === 'ArrowUp' && nb.prev) { e.preventDefault(); onMove(nb.prev); }
  };

  return (
    <>
      <div className="vmh-drawer-overlay" onClick={onClose} aria-hidden="true" />
      <aside ref={rootRef} className="vmh-drawer" role="dialog" aria-modal="true" aria-label={`VM 상세 — ${vm.name}`} tabIndex={-1} onKeyDown={onKey}>
        <EscClose onClose={onClose} />
        <div className="vmh-dh">
          <div className="ttl">
            <span className="vmh-dot" style={{ background: dotColor }} title={dotLabel} aria-hidden="true" />
            <h2 title={vm.name}>{vm.name}</h2>
            {(sigs || []).map((k) => { const s = signalText(k, { days }); return <span key={k} className={`vmh-badge ${s.badge}`} title={s.desc}>{s.short}</span>; })}
            <span className="grow" />
            <button type="button" className="vmh-icon-btn" aria-label="이전 VM" title="이전 VM(↑)" disabled={!nb.prev} onClick={() => nb.prev && onMove(nb.prev)}>‹</button>
            <button type="button" className="vmh-icon-btn" aria-label="다음 VM" title="다음 VM(↓)" disabled={!nb.next} onClick={() => nb.next && onMove(nb.next)}>›</button>
            <button type="button" className="vmh-icon-btn" aria-label="닫기" title="닫기(Esc)" onClick={onClose}>×</button>
          </div>
          <div className="vmh-crumb">
            <StateBadge state={vm.powerState} />
            <a href={vcHash(vm.vcenterId)}>{vm.vcenterId}</a>
            {vm.cluster && <><span aria-hidden="true">›</span><span>{vm.cluster}</span></>}
            {vm.host && <><span aria-hidden="true">›</span><span>{vm.host}</span></>}
            {vm.resourcePool && <><span aria-hidden="true">·</span><span>리소스 풀 {vm.resourcePool}</span></>}
            {vm.folder && <><span aria-hidden="true">·</span><span>폴더 {vm.folder}</span></>}
            {nb.index >= 0 && <span className="pos">목록 {nb.index + 1}/{nb.total}</span>}
          </div>
        </div>
        <div className="vmh-acts">
          <ObjectViewButton type="vm" item={vm} onClose={onClose} />
          <VmConsoleButton vmId={vm.id} vmName={vm.name} />
          <VmRemoteButton item={vm} />
          <VmReconfigButton vm={vm} />
          <Lazy><VmMetricButton vmId={vm.id} vmName={vm.name} /></Lazy>
          <button type="button" className="logout-btn" style={{ flex: 'none', padding: '8px 14px', whiteSpace: 'nowrap' }}
            onClick={() => setShowReport(true)} title="이 VM 의 CPU·메모리를 줄여도 되는지 기간별 추이·근거로 확인합니다">📊 축소 근거 리포트</button>
        </div>

        <div className="vmh-db">
          <section className="vmh-sec" aria-label="한눈에">
            <div className="sh"><h3>한눈에{on ? ' · 24시간 추이는 열 때 1회 조회' : ' · 꺼진 VM 은 사용률이 없습니다'}</h3></div>
            <div className="vmh-dtiles">
              <div className="vmh-dtile">
                <span className="lb">CPU</span>
                <span className="v" style={{ color: TONE_TEXT[usageTone(cpu)] }}>{cpu == null ? '—' : <>{cpu}<small>%</small></>}</span>
                {on ? <Spark series={series.cpu} color={TONE_COLOR[usageTone(cpu)] === 'var(--text-faint)' ? 'var(--accent)' : TONE_COLOR[usageTone(cpu)]} /> : null}
                <span className="s">{vm.cpuCount != null ? `${vm.cpuCount} vCPU` : 'vCPU 모름'}</span>
              </div>
              <div className="vmh-dtile">
                <span className="lb">메모리</span>
                <span className="v" style={{ color: TONE_TEXT[usageTone(mem)] }}>{mem == null ? '—' : <>{mem}<small>%</small></>}</span>
                {on ? <Spark series={series.mem} color={TONE_COLOR[usageTone(mem)] === 'var(--text-faint)' ? 'var(--purple)' : TONE_COLOR[usageTone(mem)]} /> : null}
                <span className="s">{vm.memMB != null ? `${gb(vm.memMB)} 할당` : '할당 모름'}</span>
              </div>
              <div className="vmh-dtile">
                <span className="lb">디스크</span>
                <span className="v">{diskPct == null ? '—' : <>{diskPct}<small>%</small></>}</span>
                <span className="vmh-bar" aria-hidden="true"><i style={{ width: `${diskPct ?? 0}%`, background: 'var(--accent-2)' }} /></span>
                <span className="s">{sto != null ? `사용 ${fmtN(Math.round(sto))} GB${unc != null ? ` / ${fmtN(Math.round(sto + unc))} GB` : ''}` : '용량 모름'} · 프로비저닝 대비</span>
              </div>
              <div className="vmh-dtile">
                <span className="lb">네트워크 · 게스트</span>
                <span className="v">{ips.length}<small>IP</small></span>
                <span className="s tabular">{ips[0] || 'IP 없음'}</span>
                <span className="s">Tools {vm.toolsVersion || '—'}</span>
              </div>
            </div>
          </section>

          <section className="vmh-sec" aria-label="신호">
            <div className="sh"><h3>신호 {sigs ? sigs.length : '—'} — 봐야 할 것</h3><a href={vcHash(vm.vcenterId, { type: 'vm', id: vm.id, tab: 'monitor' })} onClick={onClose}>개체 보기 › 모니터</a></div>
            {!sigs ? <div className="muted" style={{ fontSize: 12 }}>이 목록은 신호를 함께 받지 않았습니다.</div>
              : !sigs.length ? <div className="muted" style={{ fontSize: 12 }}>신호 없음 — 과부하 · 사용률 미수집 · Tools 업그레이드 · 오래된 스냅샷 모두 해당하지 않습니다. 구성 점검 · 경합 · 클러스터 항목은 아래에 있습니다.</div>
                : (
                  <div className="vmh-sigrows">
                    {sigs.map((k) => {
                      const s = signalText(k, { days });
                      return (
                        <div key={k} className="vmh-sigrow">
                          <span className="vmh-dot" style={{ background: s.tone === 'crit' ? 'var(--red)' : s.tone === 'warn' ? 'var(--amber)' : 'var(--text-faint)' }} aria-hidden="true" />
                          <div className="t"><b>{s.label}</b><span>{signalFact(k, vm, now)}</span><span>{s.desc}</span></div>
                          {k === 'toolsOld' && toolAllowed('vmtools') && <a className="tab" style={{ flex: 'none', padding: '5px 10px' }} href="#/tools/vmtools">Tools</a>}
                          {k === 'snapOld' && <a className="tab" style={{ flex: 'none', padding: '5px 10px' }} href={vcHash(vm.vcenterId, { type: 'vm', id: vm.id, tab: 'snapshots' })} onClick={onClose}>스냅샷</a>}
                        </div>
                      );
                    })}
                  </div>
                )}
          </section>

          <section className="vmh-sec" aria-label="구성 · 배치">
            <div className="sh"><h3>구성 · 배치</h3></div>
            <div className="vmh-kv">
              <KV label="Guest OS">{vm.guestOS || '—'}</KV>
              <KV label="VMware Tools"><StateBadge state={vm.toolsStatus} /> <span className={`badge ${tb}`}>{tt}</span></KV>
              <KV label="vCPU">{vm.cpuCount != null ? `${vm.cpuCount} 코어` : '—'}</KV>
              <KV label="RAM">{vm.memMB != null ? `${gb(vm.memMB)} (${vm.memMB.toLocaleString('en-US')} MB)` : '—'}</KV>
              <KV label="디스크">{sto != null ? `${vm.storageGB} GB` : '—'}</KV>
              <KV label="GPU">{vm.gpu ? <GpuBadge gpu={vm.gpu} /> : <span className="muted">없음</span>}</KV>
              <KV label="Tools 버전">{vm.toolsVersion || '—'}</KV>
              <KV label="스냅샷">{vm.snapshotCount ? `${vm.snapshotCount}개 · ${vm.snapshotSizeGB || 0} GB` : '없음'}</KV>
              <KV label="호스트">{vm.host || '—'}</KV>
              <KV label="클러스터">{vm.cluster || '—'}</KV>
              <KV label="vCenter">{vm.vcenterId || '—'}</KV>
              <KV label="vCenter ID">{vm.id}</KV>
              <KV label="태그" full>{vm.tags?.length ? vm.tags.map((t) => <span key={t} className="badge blue" style={{ marginLeft: 4 }}>{t}</span>) : '—'}</KV>
              <KV label="메모" full><span style={{ whiteSpace: 'pre-wrap', textAlign: 'left' }}>{vm.notes || '—'}</span></KV>
            </div>
          </section>

          <section className="vmh-sec" aria-label="네트워크">
            <div className="sh"><h3>IP{ips.length > 1 ? ` (${ips.length})` : ''} · 핑</h3></div>
            {ips.length ? <VmIpPing vcenterId={vm.vcenterId} ips={ips} /> : <div className="muted" style={{ fontSize: 12 }}>게스트가 보고한 IPv4 가 없습니다.</div>}
          </section>

          <section className="vmh-sec" aria-label="최근 변경 · 이동"><VmChangesSection vm={vm} /></section>
          <section className="vmh-sec" aria-label="게스트 파티션"><VmPartitionsSection vm={vm} /></section>
          <section className="vmh-sec" aria-label="구성 점검"><VmCfgSection vm={vm} /></section>
          <section className="vmh-sec" aria-label="경합"><PerfcSection item={vm} isVm /></section>
          <section className="vmh-sec" aria-label="클러스터"><ClusterCfgSection item={vm} isVm /></section>
          <section className="vmh-sec" aria-label="태그"><VmTagsSection vm={vm} /></section>
        </div>

        <nav className="vmh-df" aria-label="개체 보기 탭으로 바로 가기">
          <span className="muted">개체 보기:</span>
          {VM_OBJ_TABS.map((t) => <a key={t.k} href={vcHash(vm.vcenterId, { type: 'vm', id: vm.id, tab: t.k })} onClick={onClose}>{t.label}</a>)}
          <span className="muted-key">Esc 닫기 · ↑↓ 이전/다음 VM</span>
        </nav>
        {showReport && <Lazy><RightsizeReport vm={vm} onClose={() => setShowReport(false)} /></Lazy>}
      </aside>
    </>
  );
}
