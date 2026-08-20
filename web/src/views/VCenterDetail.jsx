import React, { useMemo, useState } from 'react';
import { usePolling } from '../api.js';
import { Loading, ErrorBox, StateBadge, UsageCell, EntityDetail, DataTable, SearchBox } from '../components/ui.jsx';
import EscClose from '../components/EscClose.jsx';
// 검색 로직(다단어 OR·메모 매칭·자원 합계)은 순수 모듈로 분리 — vitest 단위테스트 대상(v2.293).
import { parseTokens, entityMatches, notesSnippet, sumVmResources, fmtGb } from './vcdSearch.js';
// 가상화율(할당 vCPU/RAM ÷ 물리) 집계도 순수 모듈 — 'Off VM 포함' 필터가 그대로 반영된다(v2.334).
import { allocByHost, virtSum as virtSumOf } from './vcdVirt.js';

const VIEWS = [
  { k: 'hosts', label: '호스트 및 클러스터', icon: '🖥️' },
  { k: 'vms', label: 'VM 및 폴더', icon: '🧊' },
  { k: 'storage', label: '데이터스토어', icon: '💾' },
  { k: 'network', label: '네트워크', icon: '🌐' },
];

// Backing-storage categories for the datastore view filter.
const STORAGE_KINDS = [
  { k: '', label: '전체', icon: '💾' },
  { k: 'local', label: '로컬 디스크', icon: '🟢' },
  { k: 'san', label: 'SAN', icon: '🔵' },
  { k: 'nas', label: 'NAS', icon: '🟡' },
  { k: 'vsan', label: 'vSAN', icon: '🟣' },
  { k: 'vvol', label: 'vVol', icon: '🟠' },
  { k: 'other', label: '기타', icon: '⚪' },
];
const STORAGE_LABEL = Object.fromEntries(STORAGE_KINDS.map((s) => [s.k, s.label]));
const STORAGE_BADGE = { local: 'green', san: 'blue', nas: 'amber', vsan: 'purple', vvol: 'amber', other: 'gray' };

/** vSphere-client-like inventory view for a single vCenter. */
export default function VCenterDetail({ site, onBack }) {
  const vcenterId = site.id;
  const [view, setView] = useState('hosts');
  const [sel, setSel] = useState(null);     // { type, item } for the detail popup
  const [open, setOpen] = useState({});      // expanded tree nodes
  const [q, setQ] = useState('');            // VM name search (hosts/vms views)
  const [inclNotes, setInclNotes] = useState(false); // 검색 시 VM 메모(vSphere annotation) 포함 여부(v2.293)
  const [inclPoweredOff, setInclPoweredOff] = useState(true); // 트리·검색에 Off VM 포함 여부(기본 포함=기존 동작 유지)
  const [dsKind, setDsKind] = useState('');  // datastore storage filter
  const [comparing, setComparing] = useState(false); // vCenter 2개 비교 모드
  const toggle = (k) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  const { data: hostsD } = usePolling('/hosts', { vcenterId }, 20_000);
  // VM 복제(백업) 잡 대상 vmId 집합(v2.299) — 트리 VM 행에 'Clone' 배지 표시(사용자 요구).
  // 60초 폴링(잡 등록은 드묾), scope 제한 계정은 서버가 빈 목록을 준다.
  const { data: cloneBadgeD } = usePolling('/tools/vm-clone/badges', { vcenterId }, 60_000);
  const cloneSet = useMemo(() => new Set(cloneBadgeD?.vmIds || []), [cloneBadgeD]);
  const { data: vmsD } = usePolling('/vms', { vcenterId, limit: 5000 }, 20_000);
  const { data: dsD } = usePolling('/datastores', { vcenterId }, 30_000);
  const { data: netD } = usePolling('/networks', { vcenterId }, 30_000);

  const hosts = hostsD?.items || [];
  const vms = vmsD?.items || [];
  // 표시용 VM 목록 — 'Off VM 포함' 해제 시 POWERED_OFF 를 숨긴다. 트리·검색뿐 아니라
  // CPU·MEM 가상화율(할당 vCPU/RAM 합계)도 이 목록을 기준으로 계산한다(v2.334, 사용자 요구 —
  // '꺼진 VM 제외하고 실제로 켜진 부하만 보는' 용도. 전체 기준으로 보려면 체크박스를 켠다).
  const visibleVms = useMemo(
    () => (inclPoweredOff ? vms : vms.filter((v) => v.powerState !== 'POWERED_OFF')),
    [vms, inclPoweredOff]
  );
  const datastores = dsD?.items || [];
  const networks = netD?.items || [];
  const m = site.metrics || {};

  // cluster -> hosts ; host -> vms
  const clusters = useMemo(() => {
    const map = new Map();
    for (const h of hosts) {
      const c = h.cluster || 'standalone';
      if (!map.has(c)) map.set(c, []);
      map.get(c).push(h);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [hosts]);
  const vmsByHost = useMemo(() => {
    const map = new Map();
    for (const v of visibleVms) { const k = v.host || ''; if (!map.has(k)) map.set(k, []); map.get(k).push(v); }
    return map;
  }, [visibleVms]);
  // 호스트별 할당 vCPU·메모리(MB) 합계. CPU 가상화율=할당 vCPU÷물리코어, MEM 가상화율=할당 VM RAM÷물리 RAM.
  // VM은 host=호스트명으로 매핑. 합산 대상은 visibleVms — 'Off VM 포함' 해제 시 꺼진 VM 의 할당이
  // 빠져 가상화율도 함께 내려간다(v2.334). 산술은 vcdVirt.js 순수 함수(vitest 단위테스트 대상).
  const { vcpu: vcpuByHost, vmem: vmemByHost } = useMemo(() => allocByHost(visibleVms), [visibleVms]);
  // 호스트 묶음(클러스터·DC)의 할당 vCPU·물리 코어 + 할당 메모리·물리 메모리(MB) 합계.
  const virtSum = (list) => virtSumOf(list, vcpuByHost, vmemByHost);

  // folder path -> vms (vSphere "VMs and Templates")
  const folderTree = useMemo(() => buildFolderTree(visibleVms), [visibleVms]);

  // VM 검색(v2.293 확장) — 다단어 OR: 공백으로 나눈 각 토큰이 **하나라도** 포함되면 일치
  // (예: "NTP WA" → 'NTP' 포함 VM + 'WA' 포함 VM 전부). '메모 포함' 체크 시 vm.notes
  // (vSphere annotation, 서버가 config.annotation 에서 수집)도 검색 대상. 대소문자 무시.
  // 표시 상한(SEARCH_CAP)은 넓은 질의에도 렌더가 버티게 하는 것이고, 아래 자원 합계는
  // 상한과 무관하게 **전체 일치 VM** 기준으로 계산한다(잘린 합계는 오답).
  const SEARCH_CAP = 500;
  const query = q.trim().toLowerCase();
  const tokens = useMemo(() => parseTokens(query), [query]);
  // matches: [{ v, viaNotes, token }] — viaNotes(이름이 아니라 메모로 걸림)면 결과 행에
  // 메모 스니펫을 함께 보여줘 '왜 걸렸는지'를 바로 알 수 있게 한다.
  const matches = useMemo(() => {
    if (!tokens.length) return [];
    const out = [];
    for (const v of visibleVms) {
      const r = entityMatches(v.name, v.notes, tokens, inclNotes);
      if (r.hit) out.push({ v, viaNotes: r.viaNotes, token: r.token });
    }
    return out;
  }, [visibleVms, tokens, inclNotes]);
  // 일치 VM 자원 총합 — vCPU·메모리·디스크(사용=committed / 할당=+uncommitted).
  const matchSum = useMemo(() => sumVmResources(matches.map((m) => m.v)), [matches]);
  // '호스트 및 클러스터' 탭 검색은 호스트 이름도 매칭한다(예: '26' → leshesxpma26). VM만 되던 버그 수정.
  // 호스트도 다단어 OR 적용(호스트에는 메모 필드가 없어 이름만).
  const hostMatches = useMemo(() => {
    if (!tokens.length) return [];
    return hosts.filter((h) => entityMatches(h.name, '', tokens, false).hit);
  }, [hosts, tokens]);

  // Datastore storage-type filter + per-kind counts.
  const dsCounts = useMemo(() => {
    const c = {};
    for (const d of datastores) c[d.storageType || 'other'] = (c[d.storageType || 'other'] || 0) + 1;
    return c;
  }, [datastores]);
  const dsRows = dsKind ? datastores.filter((d) => (d.storageType || 'other') === dsKind) : datastores;

  return (
    <div className="vcd">
      <div className="flex between wrap" style={{ marginBottom: 12, alignItems: 'center' }}>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <button className="tab" onClick={onBack}>← 목록</button>
          <div>
            <div className="section-title" style={{ margin: 0 }}>🗄️ {site.name}</div>
            <div className="muted" style={{ fontSize: 12 }}>{site.location?.city}, {site.location?.country} · v{site.version || '—'} · {vcenterId}</div>
          </div>
          <StateBadge state={site.status} />
        </div>
        <div className="flex gap" style={{ fontSize: 12, alignItems: 'center' }}>
          <span className="muted">호스트 <b style={{ color: 'var(--text)' }}>{m.hosts ?? hosts.length}</b></span>
          <span className="muted">VM <b style={{ color: 'var(--text)' }}>{m.vms ?? vms.length}</b></span>
          <span className="muted">CPU <b style={{ color: 'var(--text)' }}>{m.cpuUsagePct ?? 0}%</b></span>
          <span className="muted">메모리 <b style={{ color: 'var(--text)' }}>{m.memUsagePct ?? 0}%</b></span>
          <button className="login-btn" style={{ flex: 'none', padding: '6px 14px', marginLeft: 6 }} onClick={() => setComparing(true)}>⇄ 비교하기</button>
        </div>
      </div>

      {comparing && <VCenterCompare site={site} onClose={() => setComparing(false)} />}

      <div className="vcd-views">
        {VIEWS.map((v) => (
          <button key={v.k} className={view === v.k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 13px' }} onClick={() => setView(v.k)}>
            {v.icon} {v.label}
          </button>
        ))}
      </div>

      {(view === 'hosts' || view === 'vms') && (
        <>
          <div className="flex gap" style={{ alignItems: 'center', margin: '10px 0' }}>
            <SearchBox value={q} onChange={setQ} placeholder={view === 'hosts' ? '🔍 호스트·VM 검색 — 여러 단어는 공백 구분(각 단어 포함 항목 모두 표시, OR)' : '🔍 VM 검색 — 여러 단어는 공백 구분(예: "NTP WA" → NTP 포함 + WA 포함 모두)'}
              style={{ flex: 1, maxWidth: 420 }} />
            {/* 메모 포함(v2.293) — vSphere VM 메모(annotation)도 검색 대상에 넣는다. 메모로만 걸린
                결과 행에는 📝 스니펫이 함께 표시돼 왜 걸렸는지 바로 보인다. */}
            <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12, flex: 'none', cursor: 'pointer' }}
              title="체크하면 VM 메모(vSphere 노트)에 검색어가 포함된 VM도 함께 찾습니다">
              <input type="checkbox" checked={inclNotes} onChange={(e) => setInclNotes(e.target.checked)} /> 메모 포함
            </label>
            {/* Off VM 포함 — 해제하면 트리·검색 결과에서 전원 꺼진(POWERED_OFF) VM 을 숨기고,
                CPU·MEM 가상화율도 켜진 VM 의 할당만으로 다시 계산한다(v2.334). 호스트 VM 수는
                서버(vCenter) 집계값이라 전원 상태와 무관하게 전체 기준으로 남는다. */}
            <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12, flex: 'none', cursor: 'pointer' }}
              title="해제하면 전원이 꺼진(Power Off) VM을 트리·검색에서 숨기고, CPU·MEM 가상화율도 켜진 VM 기준으로 계산합니다">
              <input type="checkbox" checked={inclPoweredOff} onChange={(e) => setInclPoweredOff(e.target.checked)} /> Off VM 포함
            </label>
            {query && <span className="muted" style={{ fontSize: 12 }}>{view === 'hosts' && hostMatches.length ? `호스트 ${hostMatches.length} · ` : ''}{matches.length} VM 일치{matches.length > SEARCH_CAP ? ` (처음 ${SEARCH_CAP}개 표시)` : ''}</span>}
            {q && <button className="tab" style={{ flex: 'none', padding: '6px 10px' }} onClick={() => setQ('')}>지우기</button>}
          </div>
          {/* 일치 VM 자원 총합(v2.293) — 표시 상한(500)과 무관하게 전체 일치 기준. 디스크는
              사용(committed)과 할당(+thin 미기록분)을 구분해 보여준다(합쳐 보이면 씬 환경에서 오해). */}
          {query && matches.length > 0 && (
            <div className="card" style={{ margin: '0 0 10px', padding: '8px 14px', fontSize: 12.5, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
              <b style={{ fontSize: 12 }}>Σ 일치 {matches.length} VM 자원 합계</b>
              <span className="muted">vCPU <b style={{ color: 'var(--text)' }}>{matchSum.vcpu.toLocaleString()}</b></span>
              <span className="muted">메모리 <b style={{ color: 'var(--text)' }}>{fmtGb(matchSum.memGB)}</b></span>
              <span className="muted" title="사용 = vSphere committed(실제 기록된 디스크) · 할당 = committed+uncommitted(씬 프로비저닝 미기록분 포함)">
                디스크 사용 <b style={{ color: 'var(--text)' }}>{fmtGb(matchSum.diskUsedGB)}</b> / 할당 <b style={{ color: 'var(--text)' }}>{fmtGb(matchSum.diskProvGB)}</b>
              </span>
            </div>
          )}
        </>
      )}

      {view === 'storage' && (
        <div className="flex gap wrap" style={{ alignItems: 'center', margin: '10px 0' }}>
          {STORAGE_KINDS.map((s) => {
            const n = s.k ? (dsCounts[s.k] || 0) : datastores.length;
            return (
              <button key={s.k || 'all'} className={dsKind === s.k ? 'login-btn' : 'tab'}
                style={{ flex: 'none', padding: '6px 11px' }} onClick={() => setDsKind(s.k)}>
                {s.icon} {s.label} <b style={{ opacity: 0.7 }}>{n}</b>
              </button>
            );
          })}
        </div>
      )}

      <div className="vcd-tree card">
        {(view === 'hosts' || view === 'vms') && query && (() => {
          const hm = view === 'hosts' ? hostMatches : [];
          const empty = hm.length === 0 && matches.length === 0;
          return (
            <Node label="🔍 검색 결과" defaultOpen sub={view === 'hosts' ? `${hm.length} 호스트 · ${matches.length} VM` : `${matches.length} VM`}>
              {empty && <div className="vcd-node vcd-leaf"><span className="vcd-caret" /><span className="muted">일치하는 항목이 없습니다</span></div>}
              {hm.slice(0, SEARCH_CAP).map((h) => (
                <Leaf key={`h:${h.id}`} icon="🖥️" onClick={() => setSel({ type: 'host', item: h })}
                  label={<Highlight text={h.name} tokens={tokens} />} badge={<StateBadge state={h.connectionState} />}
                  sub={`🧩 ${h.cluster || 'standalone'} · CPU ${h.cpuUsagePct ?? '-'}% · MEM ${h.memUsagePct ?? '-'}% · VM ${h.vmCount ?? '-'}`} />
              ))}
              {matches.slice(0, SEARCH_CAP).map(({ v: vm, viaNotes, token }) => (
                <Leaf key={vm.id} icon="🧊" onClick={() => setSel({ type: 'vm', item: vm })}
                  label={<Highlight text={vm.name} tokens={tokens} />} badge={<StateBadge state={vm.powerState} />}
                  sub={<>
                    {`🧩 ${vm.cluster || '—'} · 🖥️ ${vm.host || '—'} · 📁 ${vm.folder || 'vm'} · ${vm.cpuCount || 0}vCPU · ${Math.round((vm.memMB || 0) / 1024)}GB · 💾 ${fmtGb(vm.storageGB || 0)}`}
                    {/* 메모로만 걸린 결과 — 어떤 메모 문구에 걸렸는지 스니펫으로 표시(하이라이트 포함) */}
                    {viaNotes && <span style={{ color: 'var(--amber)' }}> · 📝 <Highlight text={notesSnippet(vm.notes, token)} tokens={tokens} /></span>}
                    <VmBadges vm={vm} cloneSet={cloneSet} />
                  </>} />
              ))}
            </Node>
          );
        })()}

        {view === 'hosts' && !query && (() => { const dc = virtSum(hosts); return (
          <Node label={`🗄️ ${site.name}`} defaultOpen
            sub={<UsageBars lead={<span className="muted">{hosts.length} 호스트 · VM {dc.vmc}</span>} cpu={m.cpuUsagePct} mem={m.memUsagePct}
              tail={<span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}><VirtBadge alloc={dc.alloc} base={dc.cores} kind="cpu" /><VirtBadge alloc={dc.memAlloc} base={dc.memPhys} kind="mem" /></span>} />}>
            {clusters.map(([cl, chosts]) => {
              const n = chosts.length || 1;
              const avgCpu = Math.round(chosts.reduce((a, h) => a + (h.cpuUsagePct || 0), 0) / n);
              const avgMem = Math.round(chosts.reduce((a, h) => a + (h.memUsagePct || 0), 0) / n);
              const cv = virtSum(chosts);
              return (
              <Tree key={cl} k={`cl:${cl}`} open={open} toggle={toggle} icon="🧩" label={cl}
                sub={<UsageBars lead={<span className="muted">{chosts.length} 호스트 · VM {cv.vmc}</span>} cpu={avgCpu} mem={avgMem}
                  tail={<span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}><VirtBadge alloc={cv.alloc} base={cv.cores} kind="cpu" /><VirtBadge alloc={cv.memAlloc} base={cv.memPhys} kind="mem" /></span>} />}>
                {chosts.map((h) => (
                  <Tree key={h.id} k={`h:${h.id}`} open={open} toggle={toggle} icon="🖥️"
                    label={<span className="vcd-link" onClick={(e) => { e.stopPropagation(); setSel({ type: 'host', item: h }); }}>{h.name}</span>}
                    sub={<UsageBars lead={<StateBadge state={h.connectionState} />} cpu={h.cpuUsagePct} mem={h.memUsagePct} tail={<span className="muted" style={{ fontSize: 12, display: 'inline-flex', gap: 10, alignItems: 'center' }}><span>VM {h.vmCount}</span><VirtBadge alloc={vcpuByHost.get(h.name) || 0} base={h.cpuCores} kind="cpu" /><VirtBadge alloc={vmemByHost.get(h.name) || 0} base={h.memTotalMB} kind="mem" /></span>} />}>
                    {(vmsByHost.get(h.name) || []).map((vm) => (
                      <Leaf key={vm.id} icon="🧊" onClick={() => setSel({ type: 'vm', item: vm })}
                        label={vm.name} badge={<StateBadge state={vm.powerState} />}
                        sub={<>{`${vm.guestOS} · ${vm.cpuCount}vCPU · ${Math.round(vm.memMB / 1024)}GB`}<VmBadges vm={vm} cloneSet={cloneSet} /></>} />
                    ))}
                  </Tree>
                ))}
              </Tree>
              );
            })}
          </Node>
          ); })()}

        {view === 'vms' && !query && (
          <Node label={`📁 ${site.name} / vm`} defaultOpen sub={`${visibleVms.length} VM`}>
            <FolderNodes node={folderTree} path="" open={open} toggle={toggle} cloneSet={cloneSet} onSelect={(vm) => setSel({ type: 'vm', item: vm })} />
          </Node>
        )}

        {view === 'storage' && (
          <DataTable
            columns={[
              { key: 'name', label: '데이터스토어', render: (d) => <button className="cell-link" onClick={() => setSel({ type: 'datastore', item: d })}>💾 {d.name}</button> },
              { key: 'storageType', label: '스토리지', render: (d) => (
                <span className={`badge ${STORAGE_BADGE[d.storageType] || 'gray'}`}>
                  {STORAGE_LABEL[d.storageType] || '기타'}{d.ssd ? ' · SSD' : ''}{d.remoteHost ? ` · ${d.remoteHost}` : ''}
                </span>
              ) },
              { key: 'type', label: '유형', render: (d) => <span className="badge blue">{d.type}</span> },
              { key: 'capacityGB', label: '용량', align: 'right', render: (d) => tb(d.capacityGB) },
              { key: 'usedGB', label: '사용', align: 'right', render: (d) => tb(d.usedGB) },
              { key: 'usagePct', label: '사용률', render: (d) => <UsageCell pct={d.usagePct} /> },
            ]}
            rows={dsRows} initialSort={{ key: 'usagePct', dir: 'desc' }}
            emptyText={dsKind ? `${STORAGE_LABEL[dsKind]} 데이터스토어 없음` : '데이터스토어 없음'} />
        )}

        {view === 'network' && (
          <DataTable
            columns={[
              { key: 'name', label: '네트워크', render: (n) => <b>🌐 {n.name}</b> },
              { key: 'type', label: '유형', render: (n) => <span className="badge gray">{n.type}</span> },
              { key: 'hostCount', label: '호스트', align: 'right', render: (n) => n.hostCount ?? '—' },
            ]}
            rows={networks} initialSort={{ key: 'name', dir: 'asc' }} emptyText="네트워크 없음" />
        )}
      </div>

      {sel && <EntityDetail type={sel.type} item={sel.item} onClose={() => setSel(null)} />}
    </div>
  );
}

/* ---- tree primitives ---- */
function Node({ label, sub, children, defaultOpen }) {
  const [o, setO] = useState(defaultOpen);
  return (
    <div>
      <div className="vcd-node vcd-root" onClick={() => setO((v) => !v)}>
        <span className="vcd-caret">{o ? '▾' : '▸'}</span><b>{label}</b>{sub && <span className="muted vcd-sub">{sub}</span>}
      </div>
      {o && <div className="vcd-children">{children}</div>}
    </div>
  );
}
function Tree({ k, open, toggle, icon, label, sub, children }) {
  const o = open[k];
  const hasKids = React.Children.count(children) > 0;
  return (
    <div>
      <div className="vcd-node" onClick={() => toggle(k)}>
        <span className="vcd-caret">{hasKids ? (o ? '▾' : '▸') : ''}</span>
        <span>{icon}</span> <span className="vcd-nlabel">{label}</span> {sub && <span className="vcd-sub">{sub}</span>}
      </div>
      {o && hasKids && <div className="vcd-children">{children}</div>}
    </div>
  );
}
function Leaf({ icon, label, sub, badge, onClick }) {
  return (
    <div className="vcd-node vcd-leaf" onClick={onClick}>
      <span className="vcd-caret" /><span>{icon}</span> <span className="vcd-link">{label}</span> {badge} {sub && <span className="vcd-sub">{sub}</span>}
    </div>
  );
}

// 사용률 색상 임계값(승인): 초록 <60% · 주황 60~85% · 빨강 ≥85%.
const usageColor = (p) => (p >= 85 ? 'var(--red)' : p >= 60 ? 'var(--amber)' : 'var(--green)');

// 한 지표(CPU/MEM)의 인라인 미니 바 + 수치. 트리 한 줄에 들어가도록 inline-flex.
function MiniBar({ label, pct }) {
  const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  const c = usageColor(p);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, verticalAlign: 'middle' }} title={`${label} ${p}%`}>
      <span className="muted" style={{ fontSize: 11 }}>{label}</span>
      <span style={{ display: 'inline-block', position: 'relative', width: 92, height: 7, borderRadius: 5, background: 'rgba(148,163,184,.15)', overflow: 'hidden', verticalAlign: 'middle' }}>
        <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${p}%`, background: c, borderRadius: 5 }} />
      </span>
      <b style={{ fontSize: 12, color: c, minWidth: 34, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{p}%</b>
    </span>
  );
}

// 가상화율 배지 — CPU(할당 vCPU:물리코어)·MEM(할당 VM RAM:물리 RAM) 공용. 과커밋 수준에 따라 색상.
// base/alloc 이 없으면 미표시. kind='cpu'|'mem'. 메모리는 MB 로 받아 툴팁에서 GB 로 표기(비율은 동일).
function VirtBadge({ alloc, base, kind = 'cpu' }) {
  if (!base || !alloc) return null;
  const isMem = kind === 'mem';
  const r = alloc / base;
  // CPU: >4:1 위험·2.5~4 주의 / MEM: >1.5:1 위험(물리 크게 초과)·1.0~1.5 주의(초과 할당)·이하 정상
  const [warn, danger] = isMem ? [1.0, 1.5] : [2.5, 4];
  const color = r >= danger ? '#ef4444' : r >= warn ? '#f59e0b' : '#22c55e';
  const txt = (Math.round(r * 10) / 10).toFixed(1);
  const label = isMem ? 'MEM 가상화' : 'CPU 가상화';
  const title = isMem
    ? `메모리 가상화율 = 할당 VM RAM ${Math.round(alloc / 1024).toLocaleString()}GB ÷ 물리 RAM ${Math.round(base / 1024).toLocaleString()}GB = ${txt}:1 (1.0 초과 = 오버커밋)`
    : `CPU 가상화율 = 할당 vCPU ${alloc.toLocaleString()} ÷ 물리 코어 ${base.toLocaleString()} = ${txt}:1`;
  return (
    <span className="muted" style={{ fontSize: 12 }} title={title}>
      {label} <b style={{ color, fontVariantNumeric: 'tabular-nums' }}>{txt}:1</b>
    </span>
  );
}

// 호스트/클러스터/vCenter 행의 CPU·MEM 1줄 차트. lead=앞 배지/텍스트, tail=뒤 텍스트(VM 수 등).
function UsageBars({ cpu, mem, lead, tail }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      {lead}
      <MiniBar label="CPU" pct={cpu} />
      <MiniBar label="MEM" pct={mem} />
      {tail}
    </span>
  );
}

// 매칭 토큰 하이라이트(v2.293 다단어 대응) — 여러 토큰의 모든 출현을 <mark> 처리한다.
// 정규식 특수문자는 이스케이프(VM 이름에 '.'·'-' 흔함), 대소문자 무시. split 의 캡처 그룹으로
// 매칭 조각이 배열에 홀수 인덱스로 끼어 나오는 표준 패턴을 쓴다.
function Highlight({ text, tokens }) {
  const s = String(text || '');
  const list = (tokens || []).filter(Boolean);
  if (!list.length) return <>{s}</>;
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let parts;
  try { parts = s.split(new RegExp(`(${list.map(esc).join('|')})`, 'ig')); }
  catch { return <>{s}</>; } // 방어적 폴백 — 정규식 조립 실패 시 하이라이트 없이 원문 표시
  const lower = new Set(list.map((t) => t.toLowerCase()));
  return (
    <>{parts.map((p, i) => (lower.has(p.toLowerCase())
      ? <mark key={i} style={{ background: 'rgba(245,158,11,.35)', color: 'inherit', padding: 0 }}>{p}</mark>
      : <React.Fragment key={i}>{p}</React.Fragment>))}</>
  );
}

function FolderNodes({ node, path, open, toggle, onSelect, cloneSet }) {
  const childFolders = Object.keys(node.folders).sort();
  return (
    <>
      {childFolders.map((name) => {
        const key = `f:${path}/${name}`;
        const f = node.folders[name];
        return (
          <Tree key={key} k={key} open={open} toggle={toggle} icon="📁" label={name} sub={`${f.count} VM`}>
            <FolderNodes node={f} path={`${path}/${name}`} open={open} toggle={toggle} cloneSet={cloneSet} onSelect={onSelect} />
            {f.vms.map((vm) => (
              <Leaf key={vm.id} icon="🧊" onClick={() => onSelect(vm)} label={vm.name} badge={<StateBadge state={vm.powerState} />}
                sub={<>{`${vm.guestOS} · ${vm.cpuCount}vCPU · ${Math.round(vm.memMB / 1024)}GB`}<VmBadges vm={vm} cloneSet={cloneSet} /></>} />
            ))}
          </Tree>
        );
      })}
    </>
  );
}

function buildFolderTree(vms) {
  const root = { folders: {}, vms: [], count: 0 };
  for (const vm of vms) {
    const parts = String(vm.folder || 'vm').split('/').filter((p) => p && p !== 'vm');
    let node = root; root.count++;
    for (const part of parts) {
      if (!node.folders[part]) node.folders[part] = { folders: {}, vms: [], count: 0 };
      node = node.folders[part];
      node.count++;
    }
    node.vms.push(vm);
  }
  return root;
}

const tb = (gb) => (gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb} GB`);

/**
 * VM 행 배지(v2.299): Clone = 이 포탈의 복제(백업) 잡 대상 · veeamed = Veeam 백업 흔적.
 * veeamed 는 **휴리스틱**이다 — Veeam 이 기본 설정에서 백업 시각을 VM 메모(vSphere notes)에
 * 기록하는 동작을 근거로 vm.notes 의 'veeam' 문자열을 탐지한다. Veeam 쪽에서 메모 기록을
 * 꺼둔 환경에서는 표시되지 않는다(정직 표기 — 툴팁에 명시).
 */
function VmBadges({ vm, cloneSet }) {
  const cloned = cloneSet?.has(vm.id);
  const veeamed = /veeam/i.test(vm.notes || '');
  if (!cloned && !veeamed) return null;
  return (
    <>
      {cloned && <span className="badge blue" style={{ fontSize: 10, marginLeft: 4 }} title="이 포탈의 VM 복제(백업) 잡 대상 — 특수기능 › VM 복제(백업)">Clone</span>}
      {veeamed && <span className="badge green" style={{ fontSize: 10, marginLeft: 4 }} title="VM 메모에 Veeam 백업 기록이 있습니다(휴리스틱 — Veeam 이 메모 기록을 끈 환경에선 표시되지 않음)">veeamed</span>}
    </>
  );
}

/* ---- vCenter 2개 비교 ---- */
// 비교 지표 정의. higher: 'bad'=높을수록 나쁨(사용률), 'neutral'=단순 규모, 'good'=높을수록 좋음.
const CMP_METRICS = [
  { key: 'hosts', label: '호스트', higher: 'neutral' },
  { key: 'vms', label: 'VM', higher: 'neutral' },
  { key: 'vmsPoweredOn', label: 'VM(On)', higher: 'neutral' },
  { key: 'cpuUsagePct', label: 'CPU 사용률', unit: '%', higher: 'bad' },
  { key: 'memUsagePct', label: '메모리 사용률', unit: '%', higher: 'bad' },
  { key: 'storageUsagePct', label: '스토리지 사용률', unit: '%', higher: 'bad' },
  { key: 'storageTotalTB', label: '스토리지 총량', unit: ' TB', higher: 'neutral' },
  { key: 'alarmsCritical', label: '심각 알람', higher: 'bad' },
  { key: 'alarmsWarning', label: '경고 알람', higher: 'bad' },
  { key: 'powerKw', label: '소비전력', unit: ' kW', higher: 'neutral' },
];

function VCenterCompare({ site, onClose }) {
  const { data } = usePolling('/vcenters', {}, 30_000);
  const sites = (data || []).filter((s) => s.id !== site.id);
  const [otherId, setOtherId] = useState('');
  const other = sites.find((s) => s.id === otherId);
  const A = site.metrics || {};
  const B = other?.metrics || {};
  const num = (v) => (typeof v === 'number' ? v : 0);
  const fmt = (v, u) => (v == null ? '—' : `${typeof v === 'number' ? v.toLocaleString() : v}${u || ''}`);
  // 더 나은 쪽 색: bad 지표는 낮은 값이 초록, neutral은 강조만.
  const colorFor = (metric, a, b, side) => {
    if (metric.higher === 'neutral' || a === b) return undefined;
    const aWins = metric.higher === 'bad' ? a < b : a > b;
    const isWinner = side === 'A' ? aWins : !aWins;
    return isWinner ? 'var(--green)' : 'var(--amber)';
  };
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <EscClose onClose={onClose} />
      <div className="modal card" style={{ maxWidth: 720, width: '94vw' }}>
        <div className="flex between" style={{ marginBottom: 12, alignItems: 'center' }}>
          <b style={{ fontSize: 15 }}>⇄ vCenter 비교</b>
          <button className="logout-btn" onClick={onClose}>닫기</button>
        </div>
        <div className="flex gap" style={{ alignItems: 'center', marginBottom: 14 }}>
          <div className="card" style={{ padding: '8px 14px', flex: 1, borderColor: 'var(--accent)' }}>
            <div style={{ fontWeight: 700 }}>{site.name}</div>
            <div className="muted" style={{ fontSize: 12 }}>{site.location?.country || ''} · v{site.version || '—'}</div>
          </div>
          <span style={{ fontSize: 20 }} className="muted">⇄</span>
          <div className="card" style={{ padding: '8px 14px', flex: 1 }}>
            <select className="select" value={otherId} onChange={(e) => setOtherId(e.target.value)} style={{ width: '100%' }}>
              <option value="">비교할 vCenter 선택…</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.id})</option>)}
            </select>
            {other && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{other.location?.country || ''} · v{other.version || '—'} · <StateBadge state={other.status} /></div>}
          </div>
        </div>
        {!other ? (
          <div className="muted" style={{ fontSize: 13, padding: 12 }}>오른쪽에서 비교할 vCenter를 선택하세요.</div>
        ) : (
          <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
            <thead><tr><th style={{ textAlign: 'left' }}>지표</th><th style={{ textAlign: 'right' }}>{site.name}</th><th style={{ textAlign: 'right' }}>{other.name}</th><th style={{ textAlign: 'right' }}>차이</th></tr></thead>
            <tbody>
              {CMP_METRICS.map((mt) => {
                const a = num(A[mt.key]); const b = num(B[mt.key]);
                const diff = Math.round((a - b) * 10) / 10;
                return (
                  <tr key={mt.key}>
                    <td>{mt.label}</td>
                    <td style={{ textAlign: 'right', color: colorFor(mt, a, b, 'A'), fontWeight: 600 }}>{fmt(A[mt.key] ?? 0, mt.unit)}</td>
                    <td style={{ textAlign: 'right', color: colorFor(mt, a, b, 'B'), fontWeight: 600 }}>{fmt(B[mt.key] ?? 0, mt.unit)}</td>
                    <td style={{ textAlign: 'right' }} className="muted">{diff === 0 ? '=' : `${diff > 0 ? '+' : ''}${diff}${mt.unit || ''}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>초록=더 양호(사용률·알람이 낮은 쪽), 주황=상대적으로 높음. 규모 지표(호스트/VM/용량)는 색 없이 차이만 표시.</div>
      </div>
    </div>
  );
}
