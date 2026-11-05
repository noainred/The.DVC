/**
 * views/vcd/InventoryTabs.jsx — vCenter › 데이터 센터 · 확장 프로그램 · 사용 권한 · 연결된 vCenter Server 시스템 · 업데이트
 * (승인 시안 ④⑤⑥ · 기본값 1). v2.897: 권한 목록 · 연결된 vCenter · vCenter 업데이트 · vLCM 준수는 vcinfo 캐시(VcInfoParts.jsx)로 채웠다.
 */
import React, { useMemo, useState } from 'react';
import { toolAllowed } from '../../api.js';
import { ErrorBox, Loading, StateBadge, UsageCell, SearchBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { useOnce, toolDenied } from './useOnce.js';
import { Card, KV, Note, ToolLink } from './VcdParts.jsx';
import { EventRows } from './SummaryTab.jsx';
import { VcPermsCard, VcLinkedCard, VcUpdatesCard, VcVlcmCard } from './VcInfoParts.jsx'; // v2.897
import { clusterAvgPct } from '../vcdOverview.js';
import { groupByDatacenter, extensionsState, extensionVendor, fleetKeyStats, esxiVersionRows, versionNewer, PERM_CATEGORY } from './vcdTabs.js';

/* ── 데이터 센터 ─────────────────────────────────────────────────────────── */
export function DatacenterTab({ hosts, hostsOk, gate, hostVmCount, onOpenCluster }) {
  const g = useMemo(() => groupByDatacenter(hostsOk ? hosts : [], (h) => hostVmCount(h)), [hosts, hostsOk, hostVmCount]);
  if (!hostsOk) return <div style={{ marginTop: 10 }}>{gate}</div>;
  const clusterRows = (clusters) => (
    <STable className="v3-table" minWidth={720}>
      <thead><tr><th>클러스터</th><th>호스트</th><th>VM</th><th>CPU 평균</th><th>메모리 평균</th><th data-nosort="">열기</th></tr></thead>
      <tbody>
        {clusters.map((c) => {
          const vmN = c.hosts.reduce((a, h) => a + (hostVmCount(h) || 0), 0);
          return (
            <tr key={c.name}>
              <td><b>{c.name === 'standalone' ? '클러스터 밖(독립 호스트)' : c.name}</b></td>
              <td>{c.hosts.length}</td>
              <td>{vmN}</td>
              <td data-sort={String(clusterAvgPct(c.hosts, 'cpuUsagePct') ?? '')}><UsageCell pct={clusterAvgPct(c.hosts, 'cpuUsagePct')} /></td>
              <td data-sort={String(clusterAvgPct(c.hosts, 'memUsagePct') ?? '')}><UsageCell pct={clusterAvgPct(c.hosts, 'memUsagePct')} /></td>
              <td><button type="button" className="vcd-more" onClick={() => onOpenCluster(c.name)}>호스트 및 클러스터 →</button></td>
            </tr>
          );
        })}
      </tbody>
    </STable>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10, minWidth: 0 }}>
      {!g.datacenters.length && !g.unknown && <div className="card muted" style={{ padding: 14 }}>이 vCenter 에서 받은 호스트가 없습니다.</div>}
      {g.datacenters.map((dc) => (
        <Card key={dc.name} title={dc.name} sub={`vSphere 데이터센터 · 클러스터 ${dc.clusters.length} · 호스트 ${dc.hostCount} · VM ${dc.vmCount ?? '—'}`}>
          {clusterRows(dc.clusters)}
        </Card>
      ))}
      {g.unknown && (
        <Card title="데이터센터 확인 필요" badge={<span className="badge gray">{g.unknown.hostCount}대</span>} sub="수집기가 데이터센터를 따라가지 못한 호스트(주로 클러스터 밖 독립 호스트)">
          <STable className="v3-table" minWidth={560}>
            <thead><tr><th>호스트</th><th>상태</th><th>클러스터</th><th>VM</th></tr></thead>
            <tbody>
              {g.unknown.hosts.map((h) => (
                <tr key={h.id}><td><b>{h.name}</b></td><td><StateBadge state={h.connectionState} /></td><td>{h.cluster && h.cluster !== 'standalone' ? h.cluster : '—'}</td><td>{hostVmCount(h) ?? '—'}</td></tr>
              ))}
            </tbody>
          </STable>
          <Note>어느 데이터센터에도 더하지 않았습니다(지어내지 않습니다).</Note>
        </Card>
      )}
      <Note>vSphere 데이터센터 이름은 수집기가 클러스터의 부모를 따라 찾은 값입니다 — 포탈의 ‘DataCenter’(법인 묶음)와 다른 개념입니다. VM 수 · 사용률은 호스트 및 클러스터 탭과 같은 계산(‘Off VM 포함’ 설정을 따름)입니다.</Note>
    </div>
  );
}

/* ── 확장 프로그램 ───────────────────────────────────────────────────────── */
export function ExtensionsTab({ vcenterId }) {
  const ok = toolAllowed('solutions');
  const q = useOnce('/tools/solutions', {}, ok);
  const [vendor, setVendor] = useState('');
  const [text, setText] = useState('');
  if (!ok) return <div style={{ marginTop: 10 }}><ErrorBox error={toolDenied('VMware 솔루션 / NSX')} /></div>;
  if (q.error && !q.data) return <div style={{ marginTop: 10 }}><ErrorBox error={q.error} /></div>;
  if (!q.data) return <Loading label="확장 프로그램" />;
  const row = (q.data.items || []).find((r) => r?.vcenterId === vcenterId) || null;
  const st = extensionsState(row);
  const fleet = fleetKeyStats(q.data.items);
  const fleetN = (q.data.items || []).length;
  const t = text.trim().toLowerCase();
  const items = st.items.filter((s) => (!vendor || extensionVendor(s) === vendor)
    && (!t || `${s.key} ${s.label} ${s.company}`.toLowerCase().includes(t)));
  const nV = st.items.filter((s) => extensionVendor(s) === 'vmware').length;
  return (
    <div style={{ marginTop: 10 }}>
      <Card title={`확장 프로그램${st.state === 'ok' ? ` ${st.items.length}` : ''}`} sub="ExtensionManager · 주기 수집"
        more={<ToolLink tool="solutions">솔루션 도구에서 열기 →</ToolLink>}>
        {st.state === 'unread' && (
          <div style={{ padding: 14 }}>
            <div className="badge amber" style={{ whiteSpace: 'normal' }}>이 vCenter 의 확장 목록을 읽지 못했습니다{st.why ? ` — ${st.why}` : ''}{st.error ? ` · ${st.error}` : ''}</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>‘확장 프로그램 없음(0개)’ 이 아니라 모르는 상태입니다. 다음 주기 수집이 다시 읽습니다.</div>
          </div>
        )}
        {st.state === 'missing' && <div className="muted" style={{ padding: 14, fontSize: 12.5 }}>이 vCenter 가 목록에 없습니다(범위 밖이거나 아직 수집 전).</div>}
        {st.state === 'ok' && (
          <>
            <div className="vcd-card-h" style={{ flexWrap: 'wrap', rowGap: 6, borderBottom: 0 }}>
              {[['', `전체 ${st.items.length}`], ['vmware', `VMware ${nV}`], ['other', `타사 ${st.items.length - nV}`]].map(([k, l]) => (
                <button key={k || 'all'} type="button" className={vendor === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 11px' }} onClick={() => setVendor(k)}>{l}</button>
              ))}
              <SearchBox value={text} onChange={setText} placeholder="🔍 key · 이름 · 회사" style={{ marginLeft: 'auto', maxWidth: 260, minWidth: 0, flex: '1 1 180px' }} />
            </div>
            {items.length ? (
              <STable className="v3-table" minWidth={860}>
                <thead><tr><th>이름</th><th>key</th><th>버전</th><th>회사</th><th>fleet 안 같은 key</th></tr></thead>
                <tbody>
                  {items.map((s) => {
                    const f = fleet.get(s.key);
                    return (
                      <tr key={s.key}>
                        <td><b>{s.label || s.key}</b></td>
                        <td className="mono" style={{ fontSize: 12 }}>{s.key}</td>
                        <td className="mono">{s.version || '—'}</td>
                        <td>{s.company || '—'}</td>
                        <td data-sort={String(f?.vcenters ?? '')}>{f ? `${f.vcenters} / ${fleetN} vCenter${f.versions > 1 ? ` · 버전 ${f.versions}종` : ''}` : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </STable>
            ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>{st.items.length ? '조건에 맞는 확장 프로그램이 없습니다.' : '이 vCenter 에 등록된 확장 프로그램이 없다고 vCenter 가 답했습니다.'}</div>}
          </>
        )}
        <Note>열은 수집하는 값(key · 버전 · 회사 · 이름)만입니다. ‘fleet 안 같은 key’ 는 조회 범위 안 vCenter 에서 같은 확장을 센 것 — 이 vCenter 만 버전이 다른 확장을 찾는 용도입니다. 설치 · 제거 같은 동작은 없습니다(조회 전용).</Note>
      </Card>
    </div>
  );
}

/* ── 사용 권한 ───────────────────────────────────────────────────────────── */
export function PermsTab({ vcenterId }) {
  const ok = toolAllowed('change-history');
  const q = useOnce('/tools/report/changes', { vcenterId, days: 90, category: PERM_CATEGORY, limit: 300 }, ok);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(460px, 100%), 1fr))', gap: 12, marginTop: 10, minWidth: 0 }}>
      <Card title="지금 아는 것" badge={<span className="badge blue">권한 · 역할 변경 이벤트</span>} sub="최근 90일 · 구성 변경 이력의 ‘권한’ 분류"
        more={<ToolLink tool="change-history">변경 이력에서 열기 →</ToolLink>}>
        {!ok ? <div style={{ padding: 12 }}><ErrorBox error={toolDenied('구성 변경 이력')} /></div>
          : q.error && !q.data ? <div style={{ padding: 12 }}><ErrorBox error={q.error} /></div>
            : !q.data ? <Loading label="권한 변경 이벤트" /> : <EventRows data={q.data} vcenterId={vcenterId} empty="최근 90일에 권한 · 역할 변경 이벤트가 없습니다." />}
        <Note>목록이 아니라 변경 기록입니다 — 지금 누가 어떤 역할인지는 이 표로 알 수 없습니다.</Note>
      </Card>
      <VcPermsCard vcenterId={vcenterId} />
    </div>
  );
}

/* ── 연결된 vCenter Server 시스템 ─────────────────────────────────────────── */
export function LinkedTab({ site, vcenterId }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(460px, 100%), 1fr))', gap: 12, marginTop: 10, minWidth: 0 }}>
      <Card title="지금 아는 것" badge={<span className="badge blue">이 vCenter</span>}>
        <KV rows={[
          ['이름', <b key="n">{site.name || vcenterId}</b>],
          ['포탈 vCenter id', <span className="mono" key="i">{vcenterId}</span>],
          ['상태', <StateBadge key="s" state={site.status} />],
        ]} />
        <Note>포탈 등록부의 다른 vCenter 는 Enhanced Linked Mode 연결 여부와 무관한 목록입니다 — 연결 여부는 오른쪽(vCenter 가 보고한 같은 SSO 도메인 구성원)으로만 말합니다.</Note>
      </Card>
      <VcLinkedCard vcenterId={vcenterId} />
    </div>
  );
}

/* ── 업데이트 ────────────────────────────────────────────────────────────── */
export function UpdatesTab({ site, vcenterId, hosts, hostsOk, gate }) {
  const esxi = useMemo(() => esxiVersionRows(hostsOk ? hosts : []), [hosts, hostsOk]);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(460px, 100%), 1fr))', gap: 12, marginTop: 10, minWidth: 0 }}>
      <Card title="지금 아는 것" badge={<span className="badge blue">버전 · 빌드</span>} more={<ToolLink tool="esxi">ESXi 버전별 →</ToolLink>}>
        <KV rows={[['vCenter', <>{site.version || '—'}{site.build ? <> · <span className="mono">{site.build}</span></> : ''}</>]]} />
        {!hostsOk ? <div style={{ padding: '0 12px 12px' }}>{gate}</div> : esxi.rows.length ? (
          <STable className="v3-table" minWidth={520}>
            <thead><tr><th>ESXi 버전</th><th>빌드</th><th>호스트</th><th data-nosort="">vCenter 와 비교</th></tr></thead>
            <tbody>
              {esxi.rows.map((r) => {
                const newer = versionNewer(r.version, site.version);
                return (
                  <tr key={`${r.version}|${r.build}`}>
                    <td><b>{r.version}</b></td>
                    <td className="mono">{r.build || '—'}</td>
                    <td>{r.count}</td>
                    <td>{newer == null ? '—' : newer ? <span className="badge amber">vCenter 보다 높음 — 지원 조합 확인</span> : <span className="muted">같거나 낮음</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>버전을 보고한 호스트가 없습니다.</div>}
        {hostsOk && esxi.unknown > 0 && <Note>버전을 보고하지 않은 호스트 {esxi.unknown}대(끊김 등)는 어느 행에도 세지 않았습니다.</Note>}
      </Card>
      <VcUpdatesCard vcenterId={vcenterId} />
      <VcVlcmCard vcenterId={vcenterId} />
    </div>
  );
}
