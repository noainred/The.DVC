// IpamCore.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useEffect, useState, useMemo, useRef } from 'react';
import { fetchJson, usePolling, getToken } from '../../api.js';
import { DataTable, Loading, ErrorBox, StateBadge, EntityDetail, Modal, ResultCount, SearchBox, VmLink } from '../../components/ui.jsx';
import { VmRemoteButton } from '../../components/VmRemote.jsx';
import { DEVTYPE_LABEL, DiscoveryBadge, MGMT, MgmtBadge } from './ipamShared.jsx';
import { IpamNetMap, IpamRanges, RangePolicies } from './IpamNet.jsx';
import { IpScanSettings, IpmsSettings, MemoEditor, OverrideEditor, ScanStatusModal } from './IpamSettings.jsx';
import { Card, useTool } from './shared.jsx';


/**
 * 상단 'IP관리' 탭 진입용 단독 래퍼(v2.274 — 특수 기능 카드에서 승격). ToolPanel 밖이라
 * vCenter 범위 선택자를 자체 제공한다. App.jsx 가 lazy named import 로 가져간다
 * (Ipam 본체·하위 컴포넌트가 이 파일의 헬퍼들에 얽혀 있어 코드 이동 대신 래퍼 export).
 */
export function IpamStandalone() {
  const [scope, setScope] = useState('');
  const { data: vcList } = usePolling('/vcenters', {}, 60_000);
  return (
    <>
      <div className="flex wrap" style={{ marginBottom: 12, alignItems: 'center', gap: 12 }}>
        <div className="section-title" style={{ margin: 0 }}>📒 센터별 IP 관리대장</div>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
          <span className="muted">범위</span>
          <select className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">전체 vCenter</option>
            {(vcList || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
      </div>
      <Ipam scope={scope} onScope={setScope} />
    </>
  );
}

function Ipam({ scope, onScope }) {
  const [reload, setReload] = useState(0);
  const { loading, data, error } = useTool('/tools/ipam', { ...(scope ? { vcenterId: scope } : {}), _r: reload });
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const [db, setDb] = useState(null);
  const [rowFilter, setRowFilter] = useState(''); // '' | duplicate | multihomed | public | private
  const [editMemo, setEditMemo] = useState(null); // { ip, memo, tags } for the editor
  const [histIp, setHistIp] = useState(null); // IP 사용 이력 모달 대상
  const [scanStatusOpen, setScanStatusOpen] = useState(false); // 스캔 상태(진행/이력) 모달
  const [view, setView] = useState('list'); // list | sheet
  const [subnets, setSubnets] = useState([]);
  const [base, setBase] = useState('');
  const [sheet, setSheet] = useState(null);
  const [stFilter, setStFilter] = useState(''); // '' = 전체 | used | multihomed | duplicate | empty
  const [reconFilter, setReconFilter] = useState(''); // '' | vcenter | scan | both | manual | managed
  const [editOv, setEditOv] = useState(null); // IP 관리상태(override) 편집 대상 row
  const [canManage, setCanManage] = useState(false); // operator/admin → 관리상태 편집 가능
  useEffect(() => { fetchJson('/admin/ipam/db-info').then(setDb).catch(() => setDb(null)); }, []);
  useEffect(() => { fetchJson('/auth/me').then((r) => setCanManage(['admin', 'operator'].includes(r.user?.role))).catch(() => {}); }, []);

  const sp = scope ? `?vcenterId=${encodeURIComponent(scope)}` : '';
  const sheetGen = useRef(0); // 세대 가드 — 칩 A→B 연타 시 늦은 A 응답이 B 시트를 덮어쓰지 않게(고RTT)
  const pickBase = async (b, vc = scope) => {
    const gen = ++sheetGen.current;
    setBase(b);
    const r = await fetchJson(`/tools/ipam/sheet?base=${b}${vc ? `&vcenterId=${encodeURIComponent(vc)}` : ''}`).catch(() => null);
    if (gen === sheetGen.current) setSheet(r);
  };
  const openSheets = async (vc = scope) => {
    setView('sheet');
    const q = vc ? `?vcenterId=${encodeURIComponent(vc)}` : '';
    const r = await fetchJson(`/tools/ipam/subnets${q}`).catch(() => ({ subnets: [] }));
    setSubnets(r.subnets); if (r.subnets[0]) pickBase(r.subnets[0].base, vc);
  };
  const blobDownload = async (path, name) => {
    const res = await fetch(`/api${path}`, { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} });
    const blob = await res.blob(); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
  };
  const downloadXlsx = () => blobDownload(`/tools/ipam.xlsx${sp}`, `ip-ledger-${new Date().toISOString().slice(0, 10)}.xlsx`);

  const [canIpms, setCanIpms] = useState(false);
  const [ipms, setIpms] = useState(false); // IPMS settings modal open
  const [scanOpen, setScanOpen] = useState(false); // IP 스캔 설정 모달
  useEffect(() => { fetchJson('/admin/ipam/settings').then(() => setCanIpms(true)).catch(() => setCanIpms(false)); }, []);

  // Always keep the subnet list in sync with the vCenter scope (for counts/chips).
  useEffect(() => {
    const q = scope ? `?vcenterId=${encodeURIComponent(scope)}` : '';
    fetchJson(`/tools/ipam/subnets${q}`).then((r) => { setSubnets(r.subnets); if (view === 'sheet' && r.subnets[0]) pickBase(r.subnets[0].base, scope); }).catch(() => setSubnets([]));
    // eslint-disable-next-line
  }, [scope]);

  const c10 = subnets.filter((s) => s.base.startsWith('10.')).length;
  const c192 = subnets.filter((s) => s.base.startsWith('192.')).length;
  const c172 = subnets.filter((s) => s.base.startsWith('172.')).length;

  // reconcile/관리 집계 + 행 필터를 메모이즈 — 수천 행에서 무관한 리렌더 시 재계산을 피한다(렌더 성능).
  const term = q.trim().toLowerCase();
  const recon = useMemo(() => {
    const c = { vcenter: 0, scan: 0, both: 0, manual: 0, conflict: 0, managed: 0, unmanaged: 0, reserved: 0 };
    for (const r of (data?.rows || [])) {
      if (c[r.reconcile] !== undefined) c[r.reconcile]++;
      if (r.managed) c.managed++; else c.unmanaged++;
      if (r.reservedExpired || r.reservedExpiringSoon) c.reserved++;
    }
    return c;
  }, [data]);
  const rows = useMemo(() => (data?.rows || []).filter((r) => {
    if (rowFilter === 'duplicate' && !r.duplicate) return false;
    if (rowFilter === 'multihomed' && !r.multiHomed) return false;
    if (rowFilter === 'public' && r.scope !== 'public') return false;
    if (rowFilter === 'private' && r.scope !== 'private') return false;
    if (reconFilter === 'managed' && !r.managed) return false;
    if (reconFilter === 'unmanaged' && r.managed) return false;
    if (reconFilter === 'reserved' && !(r.reservedExpired || r.reservedExpiringSoon)) return false;
    if (reconFilter && !['managed', 'unmanaged', 'reserved'].includes(reconFilter) && r.reconcile !== reconFilter) return false;
    if (term && !(r.ip.includes(term) || (r.ownerName || '').toLowerCase().includes(term) || (r.hostName || '').toLowerCase().includes(term) || (r.label || '').toLowerCase().includes(term) || (r.owner_ || '').toLowerCase().includes(term) || (r.note || '').toLowerCase().includes(term))) return false;
    return true;
  }), [data, term, rowFilter, reconFilter]);

  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;

  const ROWBG = { used: 'rgba(34,197,94,.12)', multihomed: 'rgba(59,130,246,.14)', duplicate: 'rgba(239,68,68,.14)', network: 'rgba(148,163,184,.14)', released: 'rgba(245,158,11,.13)', scanned: 'rgba(20,184,166,.14)', empty: 'transparent' };
  const STLAB = { used: '사용', multihomed: '멀티홈', duplicate: '중복', network: 'Network ID', released: '해제(이력)', scanned: '스캔 확인', empty: '' };

  const toggleRowFilter = (k) => { setRowFilter((cur) => (cur === k ? '' : k)); setView('list'); };
  const toggleRecon = (k) => { setReconFilter((cur) => (cur === k ? '' : k)); setView('list'); };

  const downloadCsv = async () => {
    const res = await fetch(`/api/tools/ipam.csv${scope ? `?vcenterId=${encodeURIComponent(scope)}` : ''}`,
      { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `ipam-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const link = { background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', padding: 0, font: 'inherit' };
  const cols = [
    { key: 'ip', label: 'IP 주소', sortValue: (r) => r.ipNum ?? Infinity, render: (r) => (
      <button style={link} onClick={() => setSel(r)}>
        <b>{r.ip}</b>
        {r.reconcile === 'conflict' && <span className="badge red" style={{ marginLeft: 6 }} title={`교차 vCenter 충돌 — 같은 IP를 주장: ${(r.conflictVcenters || []).join(', ')}`}>⚠ 충돌</span>}
        {r.duplicate && <span className="badge red" style={{ marginLeft: 6 }}>중복</span>}
        {r.multiHomed && <span className="badge amber" style={{ marginLeft: 4 }}>멀티홈</span>}
        {r.reservedExpired && <span className="badge amber" style={{ marginLeft: 4 }} title="예약 만료일이 지났습니다">⏳ 예약만료</span>}
        {!r.reservedExpired && r.reservedExpiringSoon && <span className="badge amber" style={{ marginLeft: 4 }} title={`예약 만료 임박: ${r.reservedUntil ? new Date(r.reservedUntil).toLocaleDateString() : ''}`}>⏳ 임박</span>}
      </button>
    ) },
    { key: 'scope', label: '분류', sortValue: (r) => r.scope || '', render: (r) => (
      <span className={`badge ${r.scope === 'public' ? 'amber' : 'green'}`}>{r.scope === 'public' ? '공인' : '사설'}</span>
    ) },
    { key: 'vcenterName', label: '센터(vCenter)' },
    { key: 'serverType', label: '서버종류', sortValue: (r) => r.serverType || '', render: (r) => <span className={`badge ${r.serverType === 'BareMetal' ? 'amber' : r.serverType === 'Scanned' ? 'teal' : 'blue'}`} title={r.serverType === 'Scanned' ? 'vCenter가 모르는 IP를 능동 스캔으로 확인' : undefined}>{r.serverType === 'BareMetal' ? '베어메탈' : r.serverType === 'Scanned' ? '🛰 스캔 확인' : 'VM'}</span> },
    { key: 'discovery', label: '확인 방식', sortValue: (r) => r.discovery || '', render: (r) => <DiscoveryBadge d={r.discovery} /> },
    { key: 'mgmt', label: '관리상태', sortValue: (r) => r.mgmtStatus || (r.managed ? 'zz' : 'zzz'), render: (r) => (
      <span className="flex gap" style={{ alignItems: 'center', gap: 5 }}>
        {r.mgmtStatus ? <MgmtBadge s={r.mgmtStatus} /> : <span className="muted" style={{ fontSize: 11 }}>—</span>}
        {r.appliedBy === 'range-policy' && <span className="badge purple" style={{ fontSize: 9 }} title={`대역 정책 적용: ${r.rangePolicySpec || ''}`}>정책</span>}
        {r.appliedBy === 'override' && r.managed && <span className="badge teal" style={{ fontSize: 9 }} title="IP 단위 수동 지정">IP수동</span>}
        {r.deviceType && <span className="badge gray" style={{ fontSize: 10 }}>{DEVTYPE_LABEL[r.deviceType] || r.deviceType}</span>}
        {r.reservedUntil && <span className="muted" style={{ fontSize: 10 }} title={`예약 만료: ${new Date(r.reservedUntil).toLocaleString()}`}>⏳</span>}
        {canManage && <button className="tab" style={{ padding: '1px 7px', fontSize: 11 }} title="IP 관리상태 편집(담당자·예약·디바이스 종류 등)" onClick={() => setEditOv(r)}>{r.managed ? '✎' : '+'}</button>}
      </span>
    ) },
    // 소유 자원 — v2.253 응답 다이어트로 VM 행은 owner 본문 대신 hasOwner 플래그만 온다.
    // owner 가 있거나(hasOwner VM 행이면 IpOwnerDetail 이 지연 조회) 클릭 가능하게 한다(v2.277).
    { key: 'ownerName', label: '소유 자원', sortValue: (r) => r.displayName || r.ownerName || '', render: (r) => ((r.owner || (r.hasOwner && r.ownerType === 'vm')) ? <button className="cell-link" onClick={() => setSel(r)}>{r.label || r.ownerName}</button> : <span>{r.label || r.ownerName}{r.owner_ ? <span className="muted" style={{ fontSize: 11 }}> · 👤{r.owner_}</span> : ''}{(r.services || []).length ? <span className="muted" style={{ fontSize: 11 }}> · {(r.services || []).join(',')}</span> : ''}</span>) },
    { key: 'powerState', label: '전원', render: (r) => <StateBadge state={r.powerState} /> },
    { key: 'osName', label: 'OS 종류', sortValue: (r) => r.osName || '', render: (r) => r.osName || <span className="muted">—</span> },
    { key: 'osVersion', label: 'OS 버전', sortValue: (r) => r.osVersion || '', render: (r) => r.osVersion || <span className="muted">—</span> },
    { key: 'hostName', label: 'ESXi 호스트' },
  ];

  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="총 IP" value={data.total.toLocaleString()} meta={`센터 ${data.byVcenter.length} · 서브넷 ${subnets.length}`} />
        <Card label="서브넷(/24) 대역" value={subnets.length} meta={`10.x ${c10} · 172.x ${c172} · 192.x ${c192}`} />
        <Card label="공인 / 사설 IP" value={`${(data.publicIps ?? 0).toLocaleString()} / ${(data.privateIps ?? 0).toLocaleString()}`}
          meta={rowFilter === 'public' ? '공인만 보기 ✓' : rowFilter === 'private' ? '사설만 보기 ✓' : '클릭: 공인/사설 필터'}
          active={rowFilter === 'public' || rowFilter === 'private'}
          onClick={() => toggleRowFilter(rowFilter === 'public' ? 'private' : rowFilter === 'private' ? '' : 'public')} />
        <Card label="중복 IP" value={data.duplicateIps} accent={data.duplicateIps ? 'var(--red)' : undefined}
          meta={rowFilter === 'duplicate' ? '중복만 보기 ✓' : '클릭하여 중복만'} active={rowFilter === 'duplicate'} onClick={() => toggleRowFilter('duplicate')} />
        <Card label="멀티홈 IP" value={data.multiHomed}
          meta={rowFilter === 'multihomed' ? '멀티홈만 보기 ✓' : '클릭하여 멀티홈만'} active={rowFilter === 'multihomed'} onClick={() => toggleRowFilter('multihomed')} />
        <Card label="교차 vCenter 충돌" value={recon.conflict} accent={recon.conflict ? 'var(--red)' : undefined}
          meta={reconFilter === 'conflict' ? '충돌만 보기 ✓' : (recon.conflict ? '클릭: 충돌 IP만' : '둘 이상 vCenter가 같은 IP 주장')}
          active={reconFilter === 'conflict'} onClick={() => toggleRecon('conflict')} />
        <Card label="관리상태 지정" value={recon.managed} meta={reconFilter === 'managed' ? '관리 IP만 보기 ✓' : '운영자 수동 관리 IP'}
          active={reconFilter === 'managed'} onClick={() => toggleRecon('managed')} />
        <Card label="예약 만료/임박" value={recon.reserved} accent={recon.reserved ? 'var(--amber,#f59e0b)' : undefined}
          meta={reconFilter === 'reserved' ? '예약 만료/임박만 ✓' : (recon.reserved ? '클릭: 예약 정리 대상' : '14일 내 만료 예약 없음')}
          active={reconFilter === 'reserved'} onClick={() => toggleRecon('reserved')} />
        {db && <Card label="공유 DB 레코드" value={db.count.toLocaleString()} meta={db.kind.toUpperCase()} />}
      </div>
      {rowFilter && view === 'list' && (
        <div className="flex gap" style={{ marginBottom: 8, alignItems: 'center' }}>
          <span className="badge blue" style={{ fontSize: 12 }}>
            {rowFilter === 'duplicate' ? '중복 IP만' : rowFilter === 'multihomed' ? '멀티홈 IP만' : rowFilter === 'public' ? '공인 IP만' : '사설 IP만'} 표시 중
          </span>
          <button className="tab" style={{ padding: '4px 10px' }} onClick={() => setRowFilter('')}>필터 해제</button>
        </div>
      )}
      <div className="flex gap wrap" style={{ marginBottom: 10 }}>
        {data.byVcenter.map((v) => (
          <span key={v.vcenterId || '__scan__'} className={`badge ${v.scanned ? 'teal' : 'gray'}`}
            title={v.scanned ? '어떤 vCenter에도 속하지 않고 IP 능동 스캔으로만 확인된 IP입니다. 서브넷 대장의 “스캔 확인” 필터로 볼 수 있습니다.' : '이 vCenter의 서브넷 대장 보기'}
            style={{ fontSize: 12, padding: '4px 10px', cursor: 'pointer', border: scope === v.vcenterId ? '1px solid var(--accent,#2563eb)' : undefined }}
            onClick={() => { onScope?.(v.vcenterId); openSheets(v.vcenterId); }}>{v.scanned ? '🛰 네트워크 스캔' : v.vcenterName} · {v.count}</span>
        ))}
      </div>
      <div className="flex between wrap gap" style={{ marginBottom: 8, alignItems: 'center' }}>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <button className={view === 'list' ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView('list')}>목록</button>
          <button className={view === 'sheet' ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={openSheets}>서브넷 대장(엑셀형)</button>
          <button className={view === 'insights' ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView('insights')} title="유명 IPAM 솔루션 대표 기능 30선을 수집 데이터로 계산">🧠 추천 기능 30선</button>
          <button className={view === 'ranges' ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView('ranges')} title="vCenter별 IP 대역을 저장하고 주기적으로 스캔 + 결과 다운로드">🗂️ 대역·스캔</button>
          <button className={view === 'netmap' ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView('netmap')} title="대역 선택 → OS별·시간대별 사용/미사용 네트워크 맵">🗺️ 네트워크 맵</button>
          <button className={view === 'policies' ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView('policies')} title="대역(/24 등) 단위로 관리상태(예약·DHCP풀·폐기 등)를 일괄 지정 — IP override보다 낮은 우선순위의 '기본값'">🧩 대역 정책</button>
          {/* 검색창 강조 — 사용자 요청: 대장에서 가장 많이 쓰는 입력인데 다른 버튼들 사이에 묻혀
              눈에 안 띔. 빨간 테두리 + 은은한 글로우로 시선 유도(값 입력과 무관한 정적 스타일). */}
          {view === 'list' && <SearchBox className="input" style={{ maxWidth: 260, border: '2px solid #ef4444', boxShadow: '0 0 6px rgba(239,68,68,.45)', borderRadius: 8 }} placeholder="🔍 IP / VM / 호스트 검색" value={q} onChange={setQ} />}
        </div>
        <div className="flex gap">
          {canIpms && <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={() => setScanStatusOpen(true)} title="진행 중인 IP 스캔 + 완료된 스캔 이력 보기">📊 스캔 상태</button>}
          {canIpms && <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={() => setIpms(true)}>⚙ IPMS 설정</button>}
          {canIpms && <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={() => setScanOpen(true)}>🛰️ IP 스캔</button>}
          <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={downloadCsv}>CSV</button>
          <button className="login-btn" style={{ flex: 'none', padding: '9px 14px' }} onClick={downloadXlsx}>엑셀 대장(.xlsx)</button>
        </div>
      </div>

      {view === 'ranges' ? (
        <IpamRanges />
      ) : view === 'netmap' ? (
        <IpamNetMap />
      ) : view === 'policies' ? (
        <RangePolicies scope={scope} canManage={canManage} vcenters={data.byVcenter} onChanged={() => setReload((n) => n + 1)} />
      ) : view === 'insights' ? (
        <IpamInsights scope={scope} />
      ) : view === 'sheet' ? (
        <>
          <div className="flex gap wrap" style={{ marginBottom: 8, alignItems: 'center' }}>
            {subnets.map((s) => (
              <span key={s.base} className="badge gray" title="이 서브넷 보기"
                style={{ fontSize: 12, padding: '4px 10px', cursor: 'pointer', border: base === s.base ? '1px solid var(--accent,#2563eb)' : undefined }}
                onClick={() => pickBase(s.base)}>{s.subnet} · {s.used}</span>
            ))}
          </div>
          <div className="flex gap wrap" style={{ marginBottom: 8, alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12 }}>서브넷</span>
            <select className="select" style={{ maxWidth: 280 }} value={base} onChange={(e) => pickBase(e.target.value)}>
              {subnets.map((s) => <option key={s.base} value={s.base}>{s.subnet} · 사용 {s.used}</option>)}
            </select>
          </div>
          {sheet && (() => {
            // '사용중'에는 스캔으로 확인된 IP(scanned)도 포함(실제 사용 중인 IP이므로).
            const USED = ['used', 'multihomed', 'duplicate', 'scanned'];
            const cnt = (st) => sheet.rows.filter((r) => (st === 'used' ? USED.includes(r.status) : r.status === st)).length;
            const FILTERS = [
              ['', `전체 (${sheet.rows.length})`, 'gray'],
              ['used', `사용중 (${cnt('used')})`, 'green'],
              ['multihomed', `멀티홈 (${cnt('multihomed')})`, 'blue'],
              ['duplicate', `중복 (${cnt('duplicate')})`, 'red'],
              ['scanned', `스캔 확인 (${cnt('scanned')})`, 'teal'],
              ['released', `해제(이력) (${cnt('released')})`, 'amber'],
              ['empty', `미사용 (${cnt('empty')})`, 'gray'],
            ];
            // '사용중' = 실제 점유(사용/멀티홈/중복/스캔확인) 전부, 나머지는 정확히 해당 상태.
            const shown = sheet.rows.filter((r) => {
              if (!stFilter) return true;
              if (stFilter === 'used') return USED.includes(r.status);
              return r.status === stFilter;
            });
            return (
              <>
                <div className="flex gap wrap" style={{ marginBottom: 8, alignItems: 'center' }}>
                  {FILTERS.map(([k, label]) => (
                    <button key={k} className={stFilter === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '6px 12px', fontSize: 12 }} onClick={() => setStFilter(k)}>{label}</button>
                  ))}
                  <span className="muted" style={{ fontSize: 12, marginLeft: 4 }}>🟩 사용 · 🟦 멀티홈 · 🟥 중복 · 🟦 스캔 확인 · 🟧 해제(이력) · ⬜ 미사용</span>
                </div>
                {(sheet.policies || []).length > 0 && (
                  <div className="flex gap wrap" style={{ marginBottom: 8, alignItems: 'center' }}>
                    <span className="muted" style={{ fontSize: 12 }}>🧩 이 대역 적용 정책:</span>
                    {sheet.policies.map((p) => (
                      <span key={p.id} className="badge purple" style={{ fontSize: 11 }} title={`priority ${p.priority}`}>{p.spec} · {MGMT[p.status]?.[0] || p.status || '필드'}{p.label ? ` (${p.label})` : ''}</span>
                    ))}
                  </div>
                )}
                <div className="table-wrap" style={{ maxHeight: '62vh' }}>
                  <table>
                    <thead><tr><th>{base}.X</th><th>Purpose</th><th>Hostname</th><th>서버종류</th><th>확인 방식</th><th>OS</th><th>메모(Notes)</th><th>전원</th><th>분류</th><th>상태</th><th>사용이력</th><th>메모 · 태그</th></tr></thead>
                    <tbody>
                      {shown.length === 0 && <tr><td colSpan={12} className="center muted" style={{ padding: 22 }}>해당 상태의 IP가 없습니다.</td></tr>}
                      {shown.map((r) => (
                        <tr key={r.ip} style={{ background: ROWBG[r.status] }}>
                          <td><button className="cell-link" title="클릭: 확인 시점·호스트명·사용/미사용 기간 + VM 정보/원격 접속" onClick={() => setHistIp(r)}><b>{r.ip}</b></button></td>
                          <td>{r.purpose}</td>
                          <td>{r.hostname ? <VmLink ip={r.ip} vcenterId={scope} label={r.hostname} /> : ''}</td>
                          <td className="muted" style={{ fontSize: 12 }}>{r.serverType || ''}</td>
                          <td style={{ fontSize: 12 }}><DiscoveryBadge d={r.discovery} /></td>
                          <td className="muted" style={{ fontSize: 12 }}>{r.os || ''}</td>
                          <td className="muted" style={{ fontSize: 12 }}>{r.notes}</td>
                          <td>{r.power}</td>
                          <td className="muted" style={{ fontSize: 12 }}>{r.scope}</td>
                          <td className="muted" style={{ fontSize: 12 }}>
                            {r.status === 'released' ? <span className="badge amber">해제</span> : r.status === 'scanned' ? <span className="badge teal" title="vCenter가 모르는 IP를 능동 스캔으로 확인">🛰 스캔 확인</span> : STLAB[r.status]}
                            {r.mgmtStatus && <MgmtBadge s={r.mgmtStatus} />}
                            {r.appliedBy === 'range-policy' && <span className="badge purple" style={{ fontSize: 9, marginLeft: 3 }} title={`대역 정책: ${r.rangePolicySpec || ''}`}>정책</span>}
                          </td>
                          <td style={{ fontSize: 11 }}>
                            {r.usageStatus
                              ? <button className="tab" style={{ padding: '2px 8px', fontSize: 11 }} title={`최초 발견: ${r.firstSeen ? new Date(r.firstSeen).toLocaleString() : '—'}\n마지막 확인: ${r.lastSeen ? new Date(r.lastSeen).toLocaleString() : '—'}\n현재: ${r.usageStatus === 'up' ? '사용 중' : '해제됨'}`}
                                  onClick={() => setHistIp(r)}>🕒 이력</button>
                              : <span className="muted">—</span>}
                          </td>
                          <td style={{ fontSize: 12 }}>
                            {r.memo && <div style={{ marginBottom: 3 }}>{r.memo}</div>}
                            {(r.tags || []).map((t) => <span key={t} className="badge blue" style={{ marginRight: 4, fontSize: 10 }}>{t}</span>)}
                            <button className="tab" style={{ padding: '2px 8px', fontSize: 11, marginLeft: (r.tags || []).length ? 4 : 0 }}
                              onClick={() => setEditMemo({ ip: r.ip, memo: r.memo || '', tags: (r.tags || []).join(', ') })}>
                              {r.memo || (r.tags || []).length ? '✎ 편집' : '+ 추가'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            );
          })()}
        </>
      ) : (
        <>
          {/* 출처 대조(reconcile) 필터 — vCenter 수집 IP와 스캔/수동 IP를 분리해 본다 */}
          <div className="flex gap wrap" style={{ marginBottom: 8, alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12 }}>출처 대조</span>
            {[['', `전체 (${data.rows.length})`, 'gray'],
              ['vcenter', `vCenter만 (${recon.vcenter})`, 'blue'],
              ['both', `vCenter+스캔 (${recon.both})`, 'green'],
              ['scan', `스캔만(수동확인) (${recon.scan})`, 'teal'],
              ['manual', `수동등록 (${recon.manual})`, 'purple'],
              ['conflict', `⚠ 충돌 (${recon.conflict})`, 'red'],
              ['managed', `관리상태 지정됨 (${recon.managed})`, 'amber'],
              ['unmanaged', `미관리 (${recon.unmanaged})`, 'gray'],
              ['reserved', `⏳ 예약 만료/임박 (${recon.reserved})`, 'amber']].map(([k, label]) => (
              <button key={k} className={reconFilter === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '5px 11px', fontSize: 12 }} onClick={() => k ? toggleRecon(k) : setReconFilter('')}>{label}</button>
            ))}
            {canManage && <button className="logout-btn" style={{ flex: 'none', padding: '5px 11px', fontSize: 12 }} title="수동으로 IP를 등록하거나 한 대역을 일괄 관리(예약 등)" onClick={() => setEditOv({ ip: '', __new: true })}>＋ IP 수동 등록 / 일괄 관리</button>}
          </div>
          <ResultCount total={data.rows.length} shown={rows.length} label="IP" filtered={!!term || !!reconFilter} />
          <DataTable columns={cols} rows={rows} initialSort={{ key: 'ip', dir: 'asc' }} />
        </>
      )}
      {db && (
        <div className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.7 }}>
          타 프로그램 공유용 DB: <code>{db.path}</code> ({db.kind === 'sqlite' ? 'SQLite · 테이블 ip_records' : 'NDJSON'})
          {' · '}갱신 {db.updatedAt ? new Date(db.updatedAt).toLocaleString() : '—'} · 수집 주기마다 자동 갱신됩니다.
        </div>
      )}
      {sel && <IpOwnerDetail row={sel} onClose={() => setSel(null)} />}
      {ipms && <IpmsSettings onClose={() => setIpms(false)} />}
      {scanOpen && <IpScanSettings onClose={() => setScanOpen(false)} />}
      {editMemo && <MemoEditor init={editMemo} onClose={() => setEditMemo(null)} onSaved={() => { setEditMemo(null); pickBase(base); }} />}
      {editOv && <OverrideEditor row={editOv} vcenters={data.byVcenter} onClose={() => setEditOv(null)} onSaved={() => { setEditOv(null); setReload((n) => n + 1); }} />}
      {histIp && <IpHistoryModal row={histIp} scope={scope} onClose={() => setHistIp(null)} />}
      {scanStatusOpen && <ScanStatusModal onClose={() => setScanStatusOpen(false)} />}
    </>
  );
}

/** IP 사용 이력 — 스캔으로 관측된 사용 시작(up)/해제(down) 전이 + 사용/미사용 구간. */
/**
 * IPAM 목록에서 IP/소유 자원 클릭 시 여는 상세 래퍼(v2.277 확정 버그 수정).
 * 배경: v2.253 목록 응답 다이어트로 /tools/ipam 의 VM 행은 owner 본문 없이 hasOwner 플래그만
 * 온다. 종전 코드는 <EntityDetail item={sel.owner}> 를 곧장 렌더해 item=undefined 로
 * ui.jsx `${item.name}` 에서 TypeError → ErrorBoundary 가 IP관리 탭 전체를 오류 화면으로
 * 갈아치웠다(스캔/수동 행의 owner=null 도 동일 크래시). IpHistoryModal 의 짝 수정과 같은
 * 패턴으로 — 모달을 연 시점에 /vms/lookup 으로 1건만 지연 조회한다(목록 비대화 방지 유지).
 */
function IpOwnerDetail({ row, onClose }) {
  const [owner, setOwner] = useState(row.owner || null);
  // ready=상세 표시 가능 · loading=지연 조회 중 · none=연결 자원 없음/조회 실패(크래시 대신 안내)
  const [state, setState] = useState(row.owner ? 'ready' : (row.hasOwner && row.ownerType === 'vm' ? 'loading' : 'none'));
  useEffect(() => {
    if (row.owner || !(row.hasOwner && row.ownerType === 'vm')) return undefined;
    let dead = false;
    // VM 이름(ownerName)도 함께 넘긴다(v2.287, 확정 버그 #16). 같은 vCenter 안에서 같은 IP 를
    // 여러 VM 이 주장하는 '중복 IP' 행은 ip 만으로 조회하면 스냅샷 순서상 첫 VM 이 와서, 클릭한
    // 행과 다른 VM 상세가 뜬다. 서버가 ip+name 을 함께 받으면 그 이름의 VM 을 우선 반환한다.
    const nm = row.ownerName || row.label || '';
    fetchJson(`/vms/lookup?ip=${encodeURIComponent(row.ip || '')}${nm ? `&name=${encodeURIComponent(nm)}` : ''}${row.vcenterId ? `&vcenterId=${encodeURIComponent(row.vcenterId)}` : ''}`)
      .then((r) => { if (!dead) { if (r?.vm) { setOwner(r.vm); setState('ready'); } else setState('none'); } })
      .catch(() => { if (!dead) setState('none'); });
    return () => { dead = true; };
  }, [row]);
  if (state === 'ready' && owner) return <EntityDetail type={row.ownerType || 'vm'} item={owner} onClose={onClose} />;
  return (
    <Modal title={`IP ${row.ip || ''} — 소유 자원`} onClose={onClose} width={440}>
      <div className="muted" style={{ fontSize: 13, lineHeight: 1.9 }}>
        {state === 'loading' ? '소유 자원 정보를 조회 중…' : '이 IP에 연결된 자원 상세를 열 수 없습니다(미귀속 IP이거나 조회 실패).'}
        <div style={{ marginTop: 8 }}>
          {row.ownerName && <div>소유 자원: <b>{row.label || row.ownerName}</b></div>}
          {row.vcenterName && <div>센터: {row.vcenterName}</div>}
          {row.hostname && <div>호스트명: {row.hostname}</div>}
        </div>
      </div>
    </Modal>
  );
}

function IpHistoryModal({ row, scope, onClose }) {
  const ip = row.ip;
  const hostname = row.hostname;
  const [h, setH] = useState(undefined);
  const [showDetail, setShowDetail] = useState(false);
  // 목록(/tools/ipam) 응답 다이어트로 VM 행의 owner 는 목록에 실리지 않는다(hasOwner 플래그만).
  // 모달을 연 시점에 /vms/lookup 으로 1건만 지연 조회 — 목록이 수십 MB로 커지던 것의 짝 수정.
  const [owner, setOwner] = useState(row.owner || null);
  useEffect(() => {
    if (!row.owner && row.hasOwner && row.ownerType === 'vm') {
      fetchJson(`/vms/lookup?ip=${encodeURIComponent(ip)}${row.vcenterId ? `&vcenterId=${encodeURIComponent(row.vcenterId)}` : ''}`)
        .then((r) => { if (r?.vm) setOwner(r.vm); })
        .catch(() => { /* 실패 시 상세 버튼만 미표시 — 원격 접속은 IP 폴백으로 동작 */ });
    }
  }, [ip]); // eslint-disable-line react-hooks/exhaustive-deps
  // VM/호스트 소유 IP면 그 자원으로, 스캔 IP면 IP만으로 원격 접속 대상 구성.
  const remoteItem = owner || { name: hostname || ip, ipAddresses: [ip], vcenterId: row.vcenterId || scope || '' };
  useEffect(() => { fetchJson(`/tools/ipam/history?ip=${encodeURIComponent(ip)}`).then((r) => setH(r.history || null)).catch(() => setH(null)); }, [ip]);
  const fmt = (t) => (t ? new Date(t).toLocaleString() : '—');
  const dur = (ms) => { if (ms < 0) ms = 0; const d = Math.floor(ms / 86400000), hh = Math.floor((ms % 86400000) / 3600000), mm = Math.floor((ms % 3600000) / 60000); return d ? `${d}일 ${hh}시간` : (hh ? `${hh}시간 ${mm}분` : `${mm}분`); };
  // 이벤트(오래된→최신)로 사용(up)/미사용(down) 구간을 만든다. 마지막 구간은 현재까지.
  const evs = (h?.events) || [];
  const now = Date.now();
  const segs = evs.map((e, i) => ({ type: e.type, start: e.ts, end: i + 1 < evs.length ? evs[i + 1].ts : now, hostname: e.hostname }))
    .map((s) => ({ ...s, ms: Math.max(0, s.end - s.start) }));
  const usedMs = segs.filter((s) => s.type === 'up').reduce((a, s) => a + s.ms, 0);
  const idleMs = segs.filter((s) => s.type === 'down').reduce((a, s) => a + s.ms, 0);
  // 확인된 호스트명: 가장 최근 'up' 이벤트의 호스트명(없으면 전달받은 값).
  const lastUpHost = [...evs].reverse().find((e) => e.type === 'up' && e.hostname)?.hostname;
  const confirmedHost = lastUpHost || hostname || '—';
  return (
    <Modal title={`IP 사용 이력 — ${ip}`} onClose={onClose} width={640} resizable minWidth={440} minHeight={380}>
      {h === undefined ? <Loading /> : !h ? (
        <div style={{ padding: 8 }}>
          <div className="flex gap wrap" style={{ marginBottom: 10 }}>
            <div style={{ minWidth: 160 }}><div className="muted" style={{ fontSize: 12 }}>확인된 호스트명</div><div style={{ fontSize: 13, marginTop: 2 }}>{hostname || '—'}</div></div>
          </div>
          <div className="muted" style={{ fontSize: 13 }}>이 IP의 스캔 이력이 아직 없습니다. IP 능동 스캔이 이 대역을 한 번 이상 관측하면, 확인 시점·호스트명·사용/미사용 기간이 여기에 쌓입니다.</div>
        </div>
      ) : (
        <>
          <div className="flex gap wrap" style={{ marginBottom: 12 }}>
            {[['현재 상태', h.status === 'up' ? <span className="badge green">사용 중</span> : <span className="badge amber">미사용(해제)</span>],
              ['확인 방식', <DiscoveryBadge d={row.discovery} />],
              ['확인된 호스트명', confirmedHost],
              ['최초 확인', fmt(h.firstSeen)], ['마지막 확인', fmt(h.lastSeen)],
              ['총 사용 기간', dur(usedMs)], ['총 미사용 기간', dur(idleMs)]].map(([k, v], i) => (
              <div key={i} style={{ minWidth: 150 }}><div className="muted" style={{ fontSize: 12 }}>{k}</div><div style={{ fontSize: 13, marginTop: 2 }}>{v}</div></div>
            ))}
          </div>

          <div className="muted" style={{ fontSize: 12, margin: '4px 0 6px' }}>사용 / 미사용 구간</div>
          <div className="table-wrap" style={{ marginBottom: 14 }}>
            <table>
              <thead><tr><th>구간</th><th>시작</th><th>종료</th><th style={{ textAlign: 'right' }}>기간</th></tr></thead>
              <tbody>
                {[...segs].reverse().map((s, i) => (
                  <tr key={i}>
                    <td>{s.type === 'up' ? <span className="badge green">사용</span> : <span className="badge amber">미사용</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmt(s.start)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{s.end >= now - 1000 ? '현재' : fmt(s.end)}</td>
                    <td style={{ textAlign: 'right' }} className="muted">{dur(s.ms)}</td>
                  </tr>
                ))}
                {!segs.length && <tr><td colSpan={4} className="center muted" style={{ padding: 16 }}>구간 정보가 없습니다.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="muted" style={{ fontSize: 12, margin: '4px 0 6px' }}>전이 기록(확인 시점별)</div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>시각</th><th>전이</th><th>호스트명</th><th>포트</th></tr></thead>
              <tbody>
                {[...(h.events || [])].reverse().map((e, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmt(e.ts)}</td>
                    <td>{e.type === 'up' ? <span className="badge green">사용 시작</span> : <span className="badge amber">해제</span>}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{e.hostname || '—'}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{(e.ports || []).join(', ') || '—'}</td>
                  </tr>
                ))}
                {!(h.events || []).length && <tr><td colSpan={4} className="center muted" style={{ padding: 18 }}>기록된 전이가 없습니다.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>※ 일정 시간(스캔 주기의 3배 또는 최소 3시간) 동안 응답이 없으면 '해제'로 기록됩니다.</div>
        </>
      )}
      {/* 하단: VM 정보 보기(소유 자원이 있을 때) + 원격 접속(SSH/RDP) — 기존 기능 재사용 */}
      <div className="flex gap" style={{ marginTop: 14, borderTop: '1px solid rgba(255,255,255,.08)', paddingTop: 12, alignItems: 'center' }}>
        {owner && <button className="logout-btn" style={{ padding: '8px 14px' }} onClick={() => setShowDetail(true)}>🖥 VM 정보 보기</button>}
        <VmRemoteButton item={remoteItem} />
        {!owner && !row.hasOwner && <span className="muted" style={{ fontSize: 12 }}>스캔으로 확인된 IP — 원격 접속은 IP로 직접 연결합니다.</span>}
      </div>
      {showDetail && owner && <EntityDetail type={row.ownerType} item={owner} onClose={() => setShowDetail(false)} />}
    </Modal>
  );
}

/**
 * IPAM 추천 기능 30선 — 유명 IPAM 솔루션(phpIPAM·NetBox·SolarWinds·Infoblox 등)의 대표
 * 기능을 수집 데이터로 계산해 카드로 보여준다. 각 카드 클릭 시 상세 항목 펼침.
 */
function IpamInsights({ scope }) {
  const { loading, data, error } = useTool('/tools/ipam/insights', scope ? { vcenterId: scope } : {});
  const [open, setOpen] = useState(null); // 펼친 카드 key
  const [q, setQ] = useState('');
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const fmt = (n) => Number(n || 0).toLocaleString();
  const sevColor = { warn: 'var(--amber)', info: 'var(--accent-2, #38bdf8)' };
  const t = data.totals || {};
  const term = q.trim().toLowerCase();
  const feats = (data.features || []).filter((f) => !term || f.title.toLowerCase().includes(term) || (f.tool || '').toLowerCase().includes(term) || (f.detail || '').toLowerCase().includes(term));
  return (
    <>
      <div className="flex gap wrap" style={{ marginBottom: 12, alignItems: 'center' }}>
        <Card label="IP" value={fmt(t.ips)} meta={`서브넷 ${fmt(t.subnets)}개`} />
        <Card label="전체 사용률" value={`${t.overallUtil || 0}%`} meta={`사용 ${fmt(t.used)} / 용량 ${fmt(t.capacity)}`} accent="var(--amber)" />
        <Card label="스캔 커버리지" value={`${t.scannedCoverage || 0}%`} meta="vCenter 인식 중 스캔 확인" accent="var(--green)" />
        <SearchBox className="input" style={{ maxWidth: 240, alignSelf: 'center' }} placeholder="기능/솔루션 검색" value={q} onChange={setQ} />
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        업계 표준 IPAM 솔루션(phpIPAM · NetBox · SolarWinds IPAM · Infoblox · Device42 · ManageEngine OpUtils)의 대표 기능 <b>30선</b>을
        수집된 IP 대장으로 실시간 계산했습니다. 카드를 누르면 상세 항목이 펼쳐집니다.
      </div>
      <div className="vc-grid">
        {feats.map((f) => (
          <div key={f.key} className="card" style={{ cursor: f.items?.length ? 'pointer' : 'default', borderColor: f.severity === 'warn' ? 'var(--amber)' : undefined }}
            onClick={() => f.items?.length && setOpen((o) => (o === f.key ? null : f.key))}>
            <div className="flex between" style={{ alignItems: 'baseline' }}>
              <b style={{ fontSize: 14 }}><span className="muted" style={{ fontSize: 12 }}>{String(f.n).padStart(2, '0')}.</span> {f.title}</b>
              <span style={{ fontSize: 15, fontWeight: 700, color: sevColor[f.severity] || 'var(--text)' }}>{f.value}</span>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 5, lineHeight: 1.5 }}>{f.detail}</div>
            <div className="vc-foot"><span className="muted" style={{ fontSize: 11 }}>📚 {f.tool}</span>{f.items?.length ? <span className="muted" style={{ fontSize: 11 }}>{open === f.key ? '▲ 닫기' : `▼ 상세 ${f.items.length}`}</span> : <span />}</div>
            {open === f.key && f.items?.length > 0 && (
              <div style={{ marginTop: 8, borderTop: '1px solid rgba(36,48,73,.5)', paddingTop: 8, maxHeight: 220, overflowY: 'auto' }}>
                {f.items.map((it, i) => (
                  <div key={i} className="flex between" style={{ fontSize: 12, padding: '3px 0' }}>
                    <span style={{ fontFamily: 'monospace' }}>{it.label}</span>
                    <span className="muted">{it.value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
