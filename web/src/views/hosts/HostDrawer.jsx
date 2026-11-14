// views/hosts/HostDrawer.jsx — ESXi 호스트 상세 드로어(v2.975 · 시안 docs/design/host-drawer · 사용자 컨펌 '기본값대로').
//   예전 640px 가운데 모달(EntityDetail type='host')을 바꾼 것 — VM 드로어(views/vms/VmDrawer.jsx)와 같은 뼈대(.vmh-drawer)다.
//   **모달의 기능은 빠짐없이 옮긴다**: 값 16~17개(이름 · 상태는 머리, 사용률 · 전력은 타일, 나머지는 '하드웨어 · 배치') · 구성·보안 · 경합 · 클러스터 ·
//   HBA 표 · GPU · 전력 패널 · 단추 4개(개체 보기 · VM 보기 · 성능 그래프 · 통합 성능 모니터링) + 아래 줄의 '전체 페이지 상세'. 섹션은 EntityDetail.jsx 에서 **꺼내 재사용**(복제 금지).
//   달라진 것: 목록이 뒤에 남는다 · ‹ › 와 ↑↓ 로 목록 순서대로 이전/다음 호스트 · 사유(호스트 표와 같은 reasonBadges)를 위에 ·
//   24시간 추이(CPU·메모리)는 **열 때 1회**(/hosts/:id/metrics interval=day — 폴링 없음 · 넘기는 동안은 잠깐 기다렸다 조회) ·
//   점검 묶음(/hosts/checks — iDRAC 부품 · 재부팅 · Veeam)은 vCenter 마다 1회(같은 vCenter 의 다른 호스트로 넘길 때 다시 묻지 않는다).
//   못 받은 묶음은 '이상 없음' 으로 세지 않고 따로 말한다. 끊긴 호스트는 사용률 · 추이 · 구성 판정을 그리지 않는다.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import EscClose from '../../components/EscClose.jsx';
import { StateBadge } from '../../components/primitives.jsx';
import { HostCfgSection, PerfcSection, ClusterCfgSection, HostHbaTable, HostVmsModal, ObjectViewButton } from '../../components/EntityDetail.jsx';
import { cpuModelCell } from '../../components/cpuModelText.js';
import { vcHash } from '../vcd/vcdRoute.js';
import { HOST_OBJ_TABS } from '../vcd/objTabs.js';
import { secCountsOf, secText, secTone } from '../hostChecksText.js';
import { neighborOf, usageTone, TONE_COLOR, TONE_TEXT } from '../vms/vmHubText.js';
import { useDaySeries, Spark } from '../vms/vmSeries.jsx';
import { numOrNull } from '../../numOrNull.js';
import { hostDot, hostDown, hostSignalRows, checksGap, hostTiles, hostKvRows } from './hostDrawerText.js';
import '../vms/vmHub.css';

const HostMetricButton = React.lazy(() => import('../../components/VmMetrics.jsx').then((m) => ({ default: m.HostMetricButton })));
const IdracTrendLinkButton = React.lazy(() => import('../../components/IdracTrendLinkButton.jsx'));
const HostPowerPanel = React.lazy(() => import('../../components/HostPowerPanel.jsx'));
const HostGpuPanel = React.lazy(() => import('../../components/HostGpuPanel.jsx'));
const Lazy = ({ children }) => <React.Suspense fallback={null}>{children}</React.Suspense>;
const SERIES_DELAY_MS = 400;   // ‹ › 로 넘기는 동안은 추이를 묻지 않는다(지나친 호스트마다 vCenter 로그인이 생기지 않게)
const DOT_OF = { crit: 'var(--red)', warn: 'var(--amber)' };

/**
 * 점검 묶음 — vCenter 마다 1회(드로어가 열려 있는 동안 기억). enabled=false(호출부가 이미 가진 값을 넘김)면 묻지 않는다.
 *   무거운 집계라 폴링하지 않는다(서버 60초 캐시). 응답은 자기 vCenter 키에만 넣으므로 늦게 와도 다른 호스트에 섞이지 않는다.
 */
export function useHostChecks(vcenterId, enabled) {
  const [cache, setCache] = useState({});
  const asked = useRef(new Set());
  const alive = useRef(true);
  const acs = useRef([]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; for (const ac of acs.current) ac.abort(); acs.current = []; asked.current = new Set(); }; }, []);
  useEffect(() => {
    if (!enabled || !vcenterId || asked.current.has(vcenterId)) return;
    asked.current.add(vcenterId);
    const ac = new AbortController();
    acs.current.push(ac);
    fetchJson('/hosts/checks', { vcenterId }, ac.signal, { retries: 0, timeoutMs: 30_000 })
      .then((d) => { if (alive.current) setCache((p) => ({ ...p, [vcenterId]: { byId: d?.byId && typeof d.byId === 'object' ? d.byId : {} } })); })
      .catch((e) => { if (alive.current && e?.name !== 'AbortError') setCache((p) => ({ ...p, [vcenterId]: { error: e?.message || String(e) } })); });
  }, [vcenterId, enabled]);
  if (!enabled) return null;
  if (!vcenterId) return { error: 'vCenter 를 모릅니다' };
  return cache[vcenterId] || { loading: true };
}

/**
 * @param host    /hosts 한 행
 * @param rows    ‹ › 순서(연 곳의 목록 — 트리 · 표). 없으면 ‹ › 가 잠긴다.
 * @param checks  호출부가 이미 가진 /hosts/checks 의 byId(호스트 표) — 주면 다시 묻지 않는다. null 이면 드로어가 vCenter 마다 1회 묻는다.
 */
export default function HostDrawer({ host, rows, onClose, onMove, checks = null }) {
  const rootRef = useRef(null);
  const backRef = useRef(null);
  const [showVms, setShowVms] = useState(false);
  const down = hostDown(host);
  const series = useDaySeries(host?.id, !!host && !down && host.powerState !== 'POWERED_OFF', { entity: 'host', delayMs: SERIES_DELAY_MS });
  const fetched = useHostChecks(host?.vcenterId, !!host && !checks);
  const sec = useMemo(() => (host ? secCountsOf(host) : null), [host]);
  // 열 때 포커스를 드로어로(키보드 ↑↓·Esc) · 닫을 때 원래 자리로.
  useEffect(() => {
    backRef.current = typeof document !== 'undefined' ? document.activeElement : null;
    rootRef.current?.focus({ preventScroll: true });
    return () => { try { backRef.current?.focus?.({ preventScroll: true }); } catch { /* 사라진 요소 */ } };
  }, []);
  useEffect(() => { setShowVms(false); }, [host?.id]);
  if (!host) return null;

  const st = checks ? { byId: checks } : fetched;
  const byId = st?.byId || null;
  const nb = neighborOf(rows, host.id);
  const [dotColor, dotLabel] = hostDot(host);
  const sigs = hostSignalRows(host, { sec, checks: byId });
  const gap = checksGap(st, host.id);
  const tiles = hostTiles(host, byId?.[host.id] || null);
  const kv = hostKvRows(host);
  const secLine = sec ? secText(sec) : '';
  const secBadge = sec && (sec.crit || sec.warn || sec.info) ? secTone(sec) : '';
  const tabHref = (k) => vcHash(host.vcenterId, { type: 'host', id: host.id, tab: k });
  const fullHref = `#/hosts/${encodeURIComponent(host.id)}`;
  const vmN = numOrNull(host.vmCount);
  const onKey = (e) => {
    const tag = String(e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key === 'ArrowDown' && nb.next) { e.preventDefault(); onMove(nb.next); }
    else if (e.key === 'ArrowUp' && nb.prev) { e.preventDefault(); onMove(nb.prev); }
  };
  const sparkColor = (tone, fallback) => (TONE_COLOR[tone] === 'var(--text-faint)' ? fallback : TONE_COLOR[tone]);
  const cpuTone = usageTone(tiles.cpu.pct);
  const memTone = usageTone(tiles.mem.pct);

  return (
    <>
      <div className="vmh-drawer-overlay" onClick={onClose} aria-hidden="true" />
      <aside ref={rootRef} className="vmh-drawer" role="dialog" aria-modal="true" aria-label={`호스트 상세 — ${host.name}`} tabIndex={-1} onKeyDown={onKey}>
        <EscClose onClose={onClose} />
        <div className="vmh-dh">
          <div className="ttl">
            <span className="vmh-dot" style={{ background: dotColor }} title={dotLabel} aria-hidden="true" />
            <h2 title={host.name}>{host.name}</h2>
            <span className="grow" />
            <button type="button" className="vmh-icon-btn" aria-label="이전 호스트" title="이전 호스트(↑)" disabled={!nb.prev} onClick={() => nb.prev && onMove(nb.prev)}>‹</button>
            <button type="button" className="vmh-icon-btn" aria-label="다음 호스트" title="다음 호스트(↓)" disabled={!nb.next} onClick={() => nb.next && onMove(nb.next)}>›</button>
            <button type="button" className="vmh-icon-btn" aria-label="닫기" title="닫기(Esc)" onClick={onClose}>×</button>
          </div>
          {(sigs.length > 0 || secBadge) && (
            <div className="vmh-sig">
              {sigs.map((s) => <span key={s.kind} className={`vmh-badge ${s.tone === 'warn' ? 'amber' : 'red'}`} title={s.desc || undefined}>{s.badge}</span>)}
              {secBadge && <span className={`vmh-badge ${secBadge}`} title="구성·보안 확인 항목 — 아래 ‘구성 · 보안’ 에 목록이 있습니다">구성·보안 {secLine}</span>}
            </div>
          )}
          <div className="vmh-crumb">
            <StateBadge state={host.connectionState} />
            {host.powerState && <span className={`badge ${host.powerState === 'POWERED_ON' ? 'green' : 'gray'}`}>전원 {host.powerState === 'POWERED_ON' ? 'On' : 'Off'}</span>}
            <a href={vcHash(host.vcenterId)} onClick={onClose}>{host.vcenterId}</a>
            {host.vcDatacenter && <><span aria-hidden="true">›</span><span>{host.vcDatacenter}</span></>}
            {host.cluster && <><span aria-hidden="true">›</span><span>{host.cluster}</span></>}
            {host.version && <><span aria-hidden="true">·</span><span>ESXi {host.version}</span></>}
            {nb.index >= 0 && <span className="pos">목록 {nb.index + 1}/{nb.total}</span>}
          </div>
        </div>
        <div className="vmh-acts">
          <ObjectViewButton type="host" item={host} onClose={onClose} />
          <button type="button" className="logout-btn" style={{ flex: 'none', padding: '8px 14px', whiteSpace: 'nowrap', fontSize: 13 }} onClick={() => setShowVms(true)}
            title="이 호스트의 VM 목록 보기">🖥️ VM {vmN == null ? '' : `${vmN}대 `}보기</button>
          <Lazy><HostMetricButton hostId={host.id} hostName={host.name} vcenterId={host.vcenterId} onBefore={onClose} /></Lazy>
          <Lazy><IdracTrendLinkButton hostId={host.id} hostName={host.name} onClose={onClose} /></Lazy>
        </div>

        <div className="vmh-db">
          <section className="vmh-sec" aria-label="한눈에">
            <div className="sh"><h3>한눈에{down ? ' · 끊긴 호스트는 사용률이 없습니다' : ' · 24시간 추이는 열 때 1회 조회'}</h3></div>
            <div className="vmh-dtiles">
              <div className="vmh-dtile">
                <span className="lb">CPU</span>
                <span className="v" style={{ color: TONE_TEXT[cpuTone] }}>{tiles.cpu.pct == null ? '—' : <>{tiles.cpu.pct}<small>%</small></>}</span>
                {!down ? <Spark series={series.cpu} color={sparkColor(cpuTone, 'var(--accent)')} /> : null}
                <span className="s">{tiles.cpu.sub}</span>
              </div>
              <div className="vmh-dtile">
                <span className="lb">메모리</span>
                <span className="v" style={{ color: TONE_TEXT[memTone] }}>{tiles.mem.pct == null ? '—' : <>{tiles.mem.pct}<small>%</small></>}</span>
                {!down ? <Spark series={series.mem} color={sparkColor(memTone, 'var(--purple)')} /> : null}
                <span className="s">{tiles.mem.sub}</span>
              </div>
              <div className="vmh-dtile">
                <span className="lb">VM</span>
                <span className="v">{tiles.vm.n == null ? '—' : <>{tiles.vm.n}<small>대</small></>}</span>
                {tiles.vm.subs.length ? tiles.vm.subs.map((t) => <span key={t} className="s">{t}</span>)
                  : <span className="s wrap">{st?.loading ? '켜짐 · 할당 확인 중…' : '켜짐 · 할당은 점검 묶음을 받지 못해 비웁니다'}</span>}
              </div>
              <div className="vmh-dtile">
                <span className="lb">전력 · 온도</span>
                <span className="v">{tiles.power.watts == null ? '—' : <>{tiles.power.watts.toLocaleString('en-US')}<small>W</small></>}</span>
                {tiles.power.src ? <span className="s">{tiles.power.src}</span> : null}
                <span className="s">{tiles.power.temp || '온도 —'}</span>
              </div>
            </div>
          </section>

          <section className="vmh-sec" aria-label="신호">
            <div className="sh">
              <h3>신호 {sigs.length} — 봐야 할 것{st?.loading ? ' · 점검 묶음 확인 중' : gap.length ? ` · 확인 못 한 묶음 ${gap.length}` : ''}</h3>
              <a href={tabHref('monitor')} onClick={onClose}>개체 보기 › 모니터</a>
            </div>
            {sigs.length > 0 && (
              <div className="vmh-sigrows">
                {sigs.map((s) => (
                  <div key={s.kind} className="vmh-sigrow">
                    <span className="vmh-dot" style={{ background: DOT_OF[s.tone] || 'var(--text-faint)' }} aria-hidden="true" />
                    <div className="t"><b>{s.label}</b>{s.fact ? <span>{s.fact}</span> : null}{s.desc ? <span>{s.desc}</span> : null}</div>
                    {s.tab && <a className="tab" style={{ flex: 'none', padding: '5px 10px' }} href={tabHref(s.tab[0])} onClick={onClose}>{s.tab[1]}</a>}
                  </div>
                ))}
              </div>
            )}
            {!sigs.length && !st?.loading && !gap.length && (
              <div className="muted" style={{ fontSize: 12 }}>신호 없음 — 점검 모드 · 끊김 · CPU 초과 · 업링크 · 인증서 · 스토리지 경로 · 재부팅 · 부품 · 백업 모두 해당하지 않습니다. 구성 · 경합 · 클러스터 항목은 아래에 있습니다.</div>
            )}
            {st?.loading && <div className="muted" style={{ fontSize: 12 }}>iDRAC 부품 · 재부팅 · Veeam 대조를 확인하는 중입니다…</div>}
            {gap.length > 0 && (
              <div className="muted" style={{ fontSize: 12 }}>
                {st?.error ? `점검 묶음을 읽지 못했습니다(${st.error}). ` : ''}받지 못한 묶음: {gap.join(' · ')} — 이상 없음이 아닙니다.
              </div>
            )}
          </section>

          <section className="vmh-sec" aria-label="하드웨어 · 배치">
            <div className="sh"><h3>하드웨어 · 배치</h3></div>
            <div className="vmh-kv">
              {kv.map((r) => {
                const c = r.cpuModel ? cpuModelCell(host.cpuModel) : null;
                return (
                  <div key={r.label} className={r.full ? 'full' : undefined}>
                    <span>{r.label}</span>
                    <b className={r.mono ? 'tabular' : undefined} title={c?.title || undefined}>{c ? c.text : r.value}</b>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="vmh-sec" aria-label="구성 · 보안"><HostCfgSection host={host} foldValues /></section>
          <section className="vmh-sec" aria-label="경합"><PerfcSection item={host} isVm={false} /></section>
          <section className="vmh-sec" aria-label="클러스터"><ClusterCfgSection item={host} isVm={false} /></section>
          {host.hbas?.length > 0 && <section className="vmh-sec" aria-label="스토리지 어댑터"><HostHbaTable item={host} /></section>}
          {host.gpus?.length > 0 && (
            <section className="vmh-sec" aria-label="GPU">
              <div className="sh"><h3>GPU — {host.gpus.length}</h3></div>
              <div className="flex gap wrap">
                {host.gpus.map((g, i) => <span key={i} className="badge gray" style={{ fontSize: 12 }}>{g.model}{g.memGB ? ` · ${g.memGB}GB` : ''}{g.vgpuMode ? ' · vGPU' : ''}</span>)}
              </div>
              <Lazy><HostGpuPanel hostId={host.id} hostName={host.name} /></Lazy>
            </section>
          )}
          <section className="vmh-sec" aria-label="서버 소비전력"><Lazy><HostPowerPanel hostName={host.name} serviceTag={host.serviceTag} /></Lazy></section>
        </div>

        <nav className="vmh-df" aria-label="개체 보기 탭으로 바로 가기">
          <span className="muted">개체 보기:</span>
          {HOST_OBJ_TABS.map((t) => <a key={t.k} href={tabHref(t.k)} onClick={onClose}>{t.label}</a>)}
          {/* 구분선과 링크는 한 덩어리로 줄바꿈한다(1440 에서 '|' 만 줄 끝에 남았다 — Chromium 확인). */}
          <span style={{ whiteSpace: 'nowrap' }}><span className="muted" aria-hidden="true">| </span><a href={fullHref} onClick={onClose} title="NIC · 스토리지 경로 · 재부팅 · SAN 까지 한 페이지로 봅니다">전체 페이지 상세</a></span>
          <span className="muted-key">Esc 닫기 · ↑↓ 이전/다음 호스트</span>
        </nav>
        {showVms && <HostVmsModal host={host.name} vcenterId={host.vcenterId} onClose={() => setShowVms(false)} />}
      </aside>
    </>
  );
}
