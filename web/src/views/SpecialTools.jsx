import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson, usePolling, getToken } from '../api.js';
import { DataTable, Loading, ErrorBox, StateBadge, UsageCell, EntityDetail, Modal, ResultCount, SearchBox, VmLink } from '../components/ui.jsx';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';

const TOOLS = [
  { k: 'aisearch', icon: '🔎', label: 'AI 검색 (자연어)', desc: '자연어로 VM/호스트/IP 검색 · 로컬 LLM' },
  { k: 'vmfinder', icon: '🧭', label: 'VM 정밀 검색 / 유휴 VM', desc: '다수 vCenter·폴더·클러스터·풀 + 조건 · 1일/1주 평균 CPU로 미사용 VM' },
  { k: 'capacity', icon: '📈', label: '용량 리포트', desc: '클러스터별 여유·오버커밋·수용여력 · 전체/법인별' },
  { k: 'waste', icon: '♻️', label: '낭비 리소스', desc: '정지 VM·스냅샷·thin 회수가능·Tools 미설치' },
  { k: 'esxitemp', icon: '🌡️', label: 'ESXi 온도', desc: '호스트/클러스터/법인별 현재 온도 + 최근 5년 추이' },
  { k: 'forecast', icon: '🔮', label: '용량 추세/예측', desc: '데이터스토어 증가율·가득 찰 예상일' },
  { k: 'guestos', icon: '🐧', label: 'Guest OS 종류/버전', desc: 'OS·버전별 VM 수 · 전체/법인별 · 검색' },
  { k: 'thinvms', icon: '💧', label: 'Thin VM 찾기', desc: 'Thin 프로비저닝 VM · 회수 가능 용량(추정)' },
  { k: 'ipam', icon: '📒', label: '센터별 IP 관리대장', desc: 'vCenter 수집 IP 전체 · 클릭 시 상세 · DB/CSV' },
  { k: 'dupip', icon: '🔁', label: '중복 IP 찾기', desc: '둘 이상 VM이 같은 IPv4를 쓰는 경우' },
  { k: 'vmtools', icon: '🧩', label: 'VMware Tools 버전', desc: '버전별 집계 + 업그레이드' },
  { k: 'snapshots', icon: '📸', label: '스냅샷 있는 VM', desc: 'vCenter/용량/개수별 정렬' },
  { k: 'solutions', icon: '🧱', label: 'VMware 솔루션 / NSX', desc: 'vCenter별 설치 버전' },
  { k: 'licenses', icon: '🔑', label: '라이선스 한눈에', desc: '제품별 할당/사용/만료' },
  { k: 'esxi', icon: '🖳', label: 'ESXi 버전별', desc: '호스트 ESXi 버전 분포/목록' },
  { k: 'vcversion', icon: '🏛️', label: 'vCenter 버전별', desc: 'vCenter 버전 분포' },
  { k: 'nsx', icon: '🛡️', label: 'NSX 관리', desc: 'NSX 배포 현황 / 버전' },
  { k: 'hardware', icon: '🏷️', label: '벤더/모델 서머리', desc: '법인별 호스트 벤더·모델 수량' },
  { k: 'hba', icon: '🔌', label: 'HBA 카드 속도', desc: '호스트 FC/iSCSI 어댑터 속도' },
  { k: 'gpu', icon: '🎮', label: 'GPU 인벤토리', desc: '호스트/모델별 GPU + 사용률 최근 5년 추이' },
  { k: 'shutdown', icon: '🛑', label: '긴급 ShutDown', desc: '비상 정지 (관리자 전용)', danger: true, disabled: true },
];

const tb = (gb) => (gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb} GB`);

// URL 해시(#/tools/<기능키>)에서 현재 도구 키를 읽는다(바로가기/북마크 지원).
const toolFromHash = () => {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/');
  const k = parts[0] === 'tools' ? parts[1] : '';
  return TOOLS.some((t) => t.k === k) ? k : null;
};

export default function SpecialTools() {
  const [tool, setTool] = useState(() => toolFromHash());
  const openTool = (k) => { setTool(k); window.location.hash = k ? `#/tools/${k}` : '#/tools'; };
  // 뒤로/앞으로 가기 및 외부에서 바로가기로 진입할 때 동기화.
  useEffect(() => {
    const onHash = () => setTool(toolFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  if (tool) return <ToolPanel tool={tool} onBack={() => openTool(null)} />;
  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>🛠️ 특수 기능</div>
      <div className="muted" style={{ fontSize: 13, marginBottom: 14 }}>아래 기능을 클릭하면 해당 진단을 실행해 보여줍니다.</div>
      <div className="vc-grid">
        {TOOLS.map((t) => (
          <div key={t.k} className="card vc-card"
            style={{
              cursor: t.disabled ? 'not-allowed' : 'pointer',
              opacity: t.disabled ? 0.5 : 1,
              ...(t.danger && !t.disabled ? { borderColor: 'var(--red)' } : {}),
            }}
            onClick={t.disabled ? undefined : () => openTool(t.k)}
            title={t.disabled ? '비활성화됨 (관리자 전용)' : `바로가기: #/tools/${t.k}`}>
            <div style={{ fontSize: 30, filter: t.disabled ? 'grayscale(1)' : 'none' }}>{t.icon}</div>
            <div className="vc-name" style={{ marginTop: 8, ...(t.danger && !t.disabled ? { color: 'var(--red)' } : {}) }}>{t.label}</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{t.desc}</div>
            <div className="vc-foot"><span className="muted">{t.disabled ? '비활성화됨' : '클릭하여 실행'}</span><span className="muted">{t.disabled ? '' : '→'}</span></div>
          </div>
        ))}
      </div>
    </>
  );
}

function ToolPanel({ tool, onBack }) {
  const meta = TOOLS.find((t) => t.k === tool);
  const [scope, setScope] = useState('');
  const { data: vcList } = usePolling('/vcenters', {}, 60_000);
  const scoped = ['ipam', 'dupip', 'vmtools', 'snapshots', 'hba', 'gpu', 'licenses', 'esxi', 'hardware', 'guestos', 'thinvms', 'capacity', 'waste', 'esxitemp', 'forecast'].includes(tool);

  return (
    <>
      <div className="flex wrap" style={{ marginBottom: 12, alignItems: 'center', gap: 12 }}>
        <button className="tab" onClick={onBack}>← 특수 기능</button>
        <div className="section-title" style={{ margin: 0 }}>{meta.icon} {meta.label}</div>
        {scoped && (
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
            <span className="muted">범위</span>
            <select className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">전체 vCenter</option>
              {(vcList || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
        )}
      </div>
      {tool === 'aisearch' && <AiSearch />}
      {tool === 'vmfinder' && <VmFinder />}
      {tool === 'capacity' && <Capacity scope={scope} />}
      {tool === 'waste' && <Waste scope={scope} />}
      {tool === 'esxitemp' && <EsxiTemp scope={scope} />}
      {tool === 'forecast' && <Forecast scope={scope} />}
      {tool === 'guestos' && <GuestOs scope={scope} />}
      {tool === 'thinvms' && <ThinVms scope={scope} />}
      {tool === 'ipam' && <Ipam scope={scope} onScope={setScope} />}
      {tool === 'dupip' && <DupIp scope={scope} />}
      {tool === 'vmtools' && <VmTools scope={scope} />}
      {tool === 'snapshots' && <Snapshots scope={scope} />}
      {tool === 'solutions' && <Solutions />}
      {tool === 'licenses' && <Licenses scope={scope} />}
      {tool === 'hba' && <Hba scope={scope} />}
      {tool === 'gpu' && <Gpu scope={scope} />}
      {tool === 'hardware' && <Hardware scope={scope} />}
      {tool === 'esxi' && <Esxi scope={scope} />}
      {tool === 'vcversion' && <VcVersion />}
      {tool === 'nsx' && <Nsx />}
      {tool === 'shutdown' && <Shutdown />}
    </>
  );
}

const AICOLS = {
  vm: [
    { key: 'name', label: '이름', render: (r) => <b>{r.name}</b> },
    { key: 'vcenterId', label: 'vCenter' },
    { key: 'powerState', label: '전원', render: (r) => <StateBadge state={r.powerState} /> },
    { key: 'guestOS', label: 'OS' },
    { key: 'cpuUsagePct', label: 'CPU', render: (r) => <UsageCell pct={r.cpuUsagePct} /> },
    { key: 'memUsagePct', label: '메모리', render: (r) => <UsageCell pct={r.memUsagePct} /> },
    { key: 'ip', label: 'IP', render: (r) => (r.ipAddresses?.length ? r.ipAddresses.join(', ') : (r.ipAddress || '—')) },
  ],
  host: [
    { key: 'name', label: '이름', render: (r) => <b>{r.name}</b> },
    { key: 'vcenterId', label: 'vCenter' },
    { key: 'connectionState', label: '상태', render: (r) => <StateBadge state={r.connectionState} /> },
    { key: 'cpuUsagePct', label: 'CPU', render: (r) => <UsageCell pct={r.cpuUsagePct} /> },
    { key: 'memUsagePct', label: '메모리', render: (r) => <UsageCell pct={r.memUsagePct} /> },
    { key: 'version', label: 'ESXi' },
    { key: 'model', label: '모델', render: (r) => `${r.vendor || ''} ${r.model || ''}`.trim() || '—' },
    { key: 'vmCount', label: 'VM', align: 'right' },
  ],
  datastore: [
    { key: 'name', label: '이름', render: (r) => <b>{r.name}</b> },
    { key: 'vcenterId', label: 'vCenter' },
    { key: 'type', label: '유형', render: (r) => <span className="badge blue">{r.type}</span> },
    { key: 'capacityGB', label: '용량(GB)', align: 'right' },
    { key: 'freeGB', label: '여유(GB)', align: 'right' },
    { key: 'usagePct', label: '사용률', render: (r) => <UsageCell pct={r.usagePct} /> },
  ],
  network: [
    { key: 'name', label: '이름', render: (r) => <b>{r.name}</b> },
    { key: 'vcenterId', label: 'vCenter' },
    { key: 'type', label: '유형' },
    { key: 'vlan', label: 'VLAN' },
  ],
};

const AI_EXAMPLES = ['북미 메모리 90% 넘는 호스트', '스냅샷 있는 꺼진 가상머신', 'CPU 80% 넘는 호스트', 'Dell 호스트', '점검 중인 호스트', '사용률 85% 넘는 데이터스토어'];

function AiSearch() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const run = async (query) => {
    const text = (query ?? q).trim();
    if (!text) return;
    setQ(text); setBusy(true); setError(null);
    try { setRes(await postJson('/search/nl', { query: text })); }
    catch (e) { setError(e.message); setRes(null); }
    setBusy(false);
  };

  const cols = res ? (AICOLS[res.entity] || AICOLS.vm) : null;

  return (
    <>
      <div className="flex gap" style={{ marginBottom: 10 }}>
        <input className="input" style={{ flex: 1 }} value={q} autoFocus
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()}
          placeholder="예: 북미에서 메모리 90% 넘는 호스트, 스냅샷 있는 꺼진 VM" />
        <button className="login-btn" style={{ flex: 'none', padding: '9px 20px' }} disabled={busy || !q.trim()} onClick={() => run()}>{busy ? '검색 중…' : '검색'}</button>
      </div>
      <div className="flex gap wrap" style={{ marginBottom: 12 }}>
        {AI_EXAMPLES.map((ex) => <button key={ex} className="badge gray" style={{ cursor: 'pointer', fontSize: 12, padding: '4px 10px', border: 'none' }} onClick={() => run(ex)}>{ex}</button>)}
      </div>

      {error && <ErrorBox message={error} />}
      {res && (
        <>
          <div className="card" style={{ marginBottom: 12, padding: '10px 12px' }}>
            <div className="flex between wrap" style={{ alignItems: 'center' }}>
              <span style={{ fontSize: 13 }}><b>{res.summary}</b></span>
              <span className={`badge ${res.source === 'llm' ? 'green' : 'amber'}`} title={res.llmError || ''}>{res.source === 'llm' ? 'LLM 해석' : '규칙기반(폴백)'}</span>
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              해석: <b>{res.label || res.entity}</b>
              {(res.query?.filters || []).map((f, i) => <span key={i}> · {f.field} {f.op} {String(f.value)}</span>)}
              {res.query?.match === 'any' && <span> · (OR)</span>}
            </div>
            {res.llmError && <div className="muted" style={{ fontSize: 11, marginTop: 4, color: 'var(--amber)' }}>LLM 미사용/오류로 규칙기반 검색: {res.llmError}</div>}
          </div>
          <DataTable columns={cols} rows={res.results} />
        </>
      )}

      <div className="muted" style={{ fontSize: 12, marginTop: 12, lineHeight: 1.7 }}>
        로컬 LLM(Ollama)이 질문을 검색조건으로 해석하고, 실제 검색은 포탈 내부 데이터에서 수행됩니다(데이터 외부 유출 없음).
        LLM 미설정 시 규칙기반으로 동작합니다. 설정 → AI 검색에서 Ollama 주소/모델을 지정하세요.
      </div>
    </>
  );
}

function Ipam({ scope, onScope }) {
  const { loading, data, error } = useTool('/tools/ipam', scope ? { vcenterId: scope } : {});
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const [db, setDb] = useState(null);
  const [rowFilter, setRowFilter] = useState(''); // '' | duplicate | multihomed | public | private
  const [editMemo, setEditMemo] = useState(null); // { ip, memo, tags } for the editor
  const [histIp, setHistIp] = useState(null); // IP 사용 이력 모달 대상
  const [view, setView] = useState('list'); // list | sheet
  const [subnets, setSubnets] = useState([]);
  const [base, setBase] = useState('');
  const [sheet, setSheet] = useState(null);
  const [stFilter, setStFilter] = useState(''); // '' = 전체 | used | multihomed | duplicate | empty
  useEffect(() => { fetchJson('/admin/ipam/db-info').then(setDb).catch(() => setDb(null)); }, []);

  const sp = scope ? `?vcenterId=${encodeURIComponent(scope)}` : '';
  const pickBase = async (b, vc = scope) => { setBase(b); setSheet(await fetchJson(`/tools/ipam/sheet?base=${b}${vc ? `&vcenterId=${encodeURIComponent(vc)}` : ''}`).catch(() => null)); };
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

  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;

  const ROWBG = { used: 'rgba(34,197,94,.12)', multihomed: 'rgba(59,130,246,.14)', duplicate: 'rgba(239,68,68,.14)', network: 'rgba(148,163,184,.14)', released: 'rgba(245,158,11,.13)', empty: 'transparent' };
  const STLAB = { used: '사용', multihomed: '멀티홈', duplicate: '중복', network: 'Network ID', released: '해제(이력)', empty: '' };

  const term = q.trim().toLowerCase();
  const rows = data.rows.filter((r) => {
    if (rowFilter === 'duplicate' && !r.duplicate) return false;
    if (rowFilter === 'multihomed' && !r.multiHomed) return false;
    if (rowFilter === 'public' && r.scope !== 'public') return false;
    if (rowFilter === 'private' && r.scope !== 'private') return false;
    if (term && !(r.ip.includes(term) || (r.ownerName || '').toLowerCase().includes(term) || (r.hostName || '').toLowerCase().includes(term))) return false;
    return true;
  });
  const toggleRowFilter = (k) => { setRowFilter((cur) => (cur === k ? '' : k)); setView('list'); };

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
        {r.duplicate && <span className="badge red" style={{ marginLeft: 6 }}>중복</span>}
        {r.multiHomed && <span className="badge amber" style={{ marginLeft: 4 }}>멀티홈</span>}
      </button>
    ) },
    { key: 'scope', label: '분류', sortValue: (r) => r.scope || '', render: (r) => (
      <span className={`badge ${r.scope === 'public' ? 'amber' : 'green'}`}>{r.scope === 'public' ? '공인' : '사설'}</span>
    ) },
    { key: 'vcenterName', label: '센터(vCenter)' },
    { key: 'serverType', label: '서버종류', sortValue: (r) => r.serverType || '', render: (r) => <span className={`badge ${r.serverType === 'BareMetal' ? 'amber' : r.serverType === 'Scanned' ? 'purple' : 'blue'}`}>{r.serverType === 'BareMetal' ? '베어메탈' : r.serverType === 'Scanned' ? '스캔' : 'VM'}</span> },
    { key: 'ownerName', label: '소유 자원', render: (r) => (r.owner ? <button className="cell-link" onClick={() => setSel({ ownerType: r.ownerType, owner: r.owner })}>{r.ownerName}</button> : <span>{r.ownerName}{(r.services || []).length ? <span className="muted" style={{ fontSize: 11 }}> · {(r.services || []).join(',')}</span> : ''}</span>) },
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
          <span key={v.vcenterId} className="badge gray" title="이 vCenter의 서브넷 대장 보기"
            style={{ fontSize: 12, padding: '4px 10px', cursor: 'pointer', border: scope === v.vcenterId ? '1px solid var(--accent,#2563eb)' : undefined }}
            onClick={() => { onScope?.(v.vcenterId); openSheets(v.vcenterId); }}>{v.vcenterName} · {v.count}</span>
        ))}
      </div>
      <div className="flex between wrap gap" style={{ marginBottom: 8, alignItems: 'center' }}>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <button className={view === 'list' ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView('list')}>목록</button>
          <button className={view === 'sheet' ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={openSheets}>서브넷 대장(엑셀형)</button>
          {view === 'list' && <SearchBox className="input" style={{ maxWidth: 260 }} placeholder="IP / VM / 호스트 검색" value={q} onChange={setQ} />}
        </div>
        <div className="flex gap">
          {canIpms && <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={() => setIpms(true)}>⚙ IPMS 설정</button>}
          {canIpms && <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={() => setScanOpen(true)}>🛰️ IP 스캔</button>}
          <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={downloadCsv}>CSV</button>
          <button className="login-btn" style={{ flex: 'none', padding: '9px 14px' }} onClick={downloadXlsx}>엑셀 대장(.xlsx)</button>
        </div>
      </div>

      {view === 'sheet' ? (
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
            const cnt = (st) => sheet.rows.filter((r) => (st === 'used' ? (r.status === 'used' || r.status === 'multihomed' || r.status === 'duplicate') : r.status === st)).length;
            const FILTERS = [
              ['', `전체 (${sheet.rows.length})`, 'gray'],
              ['used', `사용중 (${cnt('used')})`, 'green'],
              ['multihomed', `멀티홈 (${cnt('multihomed')})`, 'blue'],
              ['duplicate', `중복 (${cnt('duplicate')})`, 'red'],
              ['released', `해제(이력) (${cnt('released')})`, 'amber'],
              ['empty', `미사용 (${cnt('empty')})`, 'gray'],
            ];
            // '사용중' = 실제 점유(사용/멀티홈/중복) 전부, 나머지는 정확히 해당 상태.
            const shown = sheet.rows.filter((r) => {
              if (!stFilter) return true;
              if (stFilter === 'used') return r.status === 'used' || r.status === 'multihomed' || r.status === 'duplicate';
              return r.status === stFilter;
            });
            return (
              <>
                <div className="flex gap wrap" style={{ marginBottom: 8, alignItems: 'center' }}>
                  {FILTERS.map(([k, label]) => (
                    <button key={k} className={stFilter === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '6px 12px', fontSize: 12 }} onClick={() => setStFilter(k)}>{label}</button>
                  ))}
                  <span className="muted" style={{ fontSize: 12, marginLeft: 4 }}>🟩 사용 · 🟦 멀티홈 · 🟥 중복 · 🟧 해제(이력) · ⬜ 미사용</span>
                </div>
                <div className="table-wrap" style={{ maxHeight: '62vh' }}>
                  <table>
                    <thead><tr><th>{base}.X</th><th>Purpose</th><th>Hostname</th><th>서버종류</th><th>OS</th><th>메모(Notes)</th><th>전원</th><th>분류</th><th>상태</th><th>사용이력</th><th>메모 · 태그</th></tr></thead>
                    <tbody>
                      {shown.length === 0 && <tr><td colSpan={11} className="center muted" style={{ padding: 22 }}>해당 상태의 IP가 없습니다.</td></tr>}
                      {shown.map((r) => (
                        <tr key={r.ip} style={{ background: ROWBG[r.status] }}>
                          <td><b>{r.ip}</b></td>
                          <td>{r.purpose}</td>
                          <td>{r.hostname ? <VmLink ip={r.ip} vcenterId={scope} label={r.hostname} /> : ''}</td>
                          <td className="muted" style={{ fontSize: 12 }}>{r.serverType || ''}</td>
                          <td className="muted" style={{ fontSize: 12 }}>{r.os || ''}</td>
                          <td className="muted" style={{ fontSize: 12 }}>{r.notes}</td>
                          <td>{r.power}</td>
                          <td className="muted" style={{ fontSize: 12 }}>{r.scope}</td>
                          <td className="muted" style={{ fontSize: 12 }}>{r.status === 'released' ? <span className="badge amber">해제</span> : STLAB[r.status]}</td>
                          <td style={{ fontSize: 11 }}>
                            {r.usageStatus
                              ? <button className="tab" style={{ padding: '2px 8px', fontSize: 11 }} title={`최초 발견: ${r.firstSeen ? new Date(r.firstSeen).toLocaleString() : '—'}\n마지막 확인: ${r.lastSeen ? new Date(r.lastSeen).toLocaleString() : '—'}\n현재: ${r.usageStatus === 'up' ? '사용 중' : '해제됨'}`}
                                  onClick={() => setHistIp(r.ip)}>🕒 이력</button>
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
          <ResultCount total={data.rows.length} shown={rows.length} label="IP" filtered={!!term} />
          <DataTable columns={cols} rows={rows} initialSort={{ key: 'ip', dir: 'asc' }} />
        </>
      )}
      {db && (
        <div className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.7 }}>
          타 프로그램 공유용 DB: <code>{db.path}</code> ({db.kind === 'sqlite' ? 'SQLite · 테이블 ip_records' : 'NDJSON'})
          {' · '}갱신 {db.updatedAt ? new Date(db.updatedAt).toLocaleString() : '—'} · 수집 주기마다 자동 갱신됩니다.
        </div>
      )}
      {sel && <EntityDetail type={sel.ownerType} item={sel.owner} onClose={() => setSel(null)} />}
      {ipms && <IpmsSettings onClose={() => setIpms(false)} />}
      {scanOpen && <IpScanSettings onClose={() => setScanOpen(false)} />}
      {editMemo && <MemoEditor init={editMemo} onClose={() => setEditMemo(null)} onSaved={() => { setEditMemo(null); pickBase(base); }} />}
      {histIp && <IpHistoryModal ip={histIp} onClose={() => setHistIp(null)} />}
    </>
  );
}

/** IP 사용 이력 — 스캔으로 관측된 사용 시작(up)/해제(down) 전이 타임라인. */
function IpHistoryModal({ ip, onClose }) {
  const [h, setH] = useState(undefined);
  useEffect(() => { fetchJson(`/tools/ipam/history?ip=${encodeURIComponent(ip)}`).then((r) => setH(r.history || null)).catch(() => setH(null)); }, [ip]);
  const fmt = (t) => (t ? new Date(t).toLocaleString() : '—');
  const dur = (ms) => { if (ms < 0) ms = 0; const d = Math.floor(ms / 86400000), hh = Math.floor((ms % 86400000) / 3600000), mm = Math.floor((ms % 3600000) / 60000); return d ? `${d}일 ${hh}시간` : (hh ? `${hh}시간 ${mm}분` : `${mm}분`); };
  return (
    <Modal title={`IP 사용 이력 — ${ip}`} onClose={onClose} width={620} resizable minWidth={420} minHeight={360}>
      {h === undefined ? <Loading /> : !h ? (
        <div className="muted" style={{ fontSize: 13, padding: 16 }}>이 IP의 스캔 이력이 없습니다. IP 능동 스캔이 이 대역을 한 번 이상 관측해야 이력이 쌓입니다.</div>
      ) : (
        <>
          <div className="flex gap wrap" style={{ marginBottom: 12 }}>
            {[['현재 상태', h.status === 'up' ? <span className="badge green">사용 중</span> : <span className="badge amber">해제됨</span>],
              ['최초 발견', fmt(h.firstSeen)], ['마지막 확인', fmt(h.lastSeen)], ['관측 기간', dur((h.lastSeen || 0) - (h.firstSeen || 0))]].map(([k, v], i) => (
              <div key={i} style={{ minWidth: 130 }}><div className="muted" style={{ fontSize: 12 }}>{k}</div><div style={{ fontSize: 13, marginTop: 2 }}>{v}</div></div>
            ))}
          </div>
          <div className="table-wrap" style={{ maxHeight: '52vh' }}>
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
    </Modal>
  );
}

/** Per-IP user memo + tags editor (separate from vCenter notes). */
function MemoEditor({ init, onClose, onSaved }) {
  const [memo, setMemo] = useState(init.memo || '');
  const [tags, setTags] = useState(init.tags || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const save = async () => {
    setBusy(true); setErr(null);
    const body = { ip: init.ip, memo, tags: String(tags).split(/[,\n]/).map((s) => s.trim()).filter(Boolean) };
    const r = await putJson('/tools/ipam/annotation', body).catch((e) => ({ ok: false, reason: e.message }));
    setBusy(false);
    if (r.ok) onSaved(); else setErr(r.reason || '저장 실패');
  };
  return (
    <Modal title={`메모 · 태그 — ${init.ip}`} onClose={onClose} width={720} resizable minWidth={460} minHeight={380}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 14 }}>vCenter 메모와 별개로, 이 IP에 직접 남기는 메모/태그입니다. (수집 갱신에도 유지)</div>
      {err && <div className="login-error" style={{ marginBottom: 8 }}>{err}</div>}
      {/* 2열 폼: 라벨(왼쪽 기준선) · 입력 박스(오른쪽 기준선)로 정렬 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 16, rowGap: 16, alignItems: 'start' }}>
        <label style={{ fontWeight: 600, paddingTop: 9, whiteSpace: 'nowrap' }}>메모</label>
        <textarea className="input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="예: 보안취약점 점검 대상, 담당 홍길동"
          style={{ resize: 'vertical', minHeight: 140, width: '100%', boxSizing: 'border-box', display: 'block' }} />
        <label style={{ fontWeight: 600, paddingTop: 9, whiteSpace: 'nowrap' }}>태그<span className="muted" style={{ fontWeight: 400, fontSize: 11 }}> (쉼표로 구분)</span></label>
        <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="예: 점검, IAM, 운영"
          style={{ width: '100%', boxSizing: 'border-box', display: 'block' }} />
        <div />
        <div className="flex gap" style={{ marginTop: 4 }}>
          <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={busy} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
          <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={onClose}>취소</button>
        </div>
      </div>
    </Modal>
  );
}

function IpmsSettings({ onClose }) {
  const [s, setS] = useState(null);
  const [vcs, setVcs] = useState([]);
  const [vc, setVc] = useState('');
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    fetchJson('/admin/ipam/settings').then((r) => setS(r.settings)).catch((e) => setMsg(e.message));
    fetchJson('/vcenters').then((list) => { setVcs(list); if (list[0]) setVc(list[0].id); }).catch(() => {});
  }, []);
  if (!s) return <Modal title="IPMS 설정" onClose={onClose}>{msg ? <ErrorBox message={msg} /> : <Loading />}</Modal>;

  const globalText = (s.global || []).join('\n');
  const vcText = (s.vcenters?.[vc] || []).join('\n');
  const publicText = (s.publicRanges || []).join('\n');
  const privateText = (s.privateRanges || []).join('\n');
  const setGlobal = (t) => setS({ ...s, global: t.split('\n') });
  const setVcText = (t) => setS({ ...s, vcenters: { ...(s.vcenters || {}), [vc]: t.split('\n') } });
  const setPublic = (t) => setS({ ...s, publicRanges: t.split('\n') });
  const setPrivate = (t) => setS({ ...s, privateRanges: t.split('\n') });
  const save = async () => {
    const r = await putJson('/admin/ipam/settings', s).catch((e) => ({ error: e.message }));
    if (r.ok) onClose(); else setMsg(r.error || '저장 실패');
  };

  return (
    <Modal title="IPMS 설정 — 무시할 IP 대역" onClose={onClose} width={560}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>여기 입력한 대역의 IP는 IP 관리대장/검색/공유DB에서 제외됩니다. 형식: CIDR(10.0.0.0/8), 범위(10.0.0.1-10.0.0.50), 단일 IP. 한 줄에 하나.</div>
      {msg && <div className="login-error" style={{ marginBottom: 8 }}>{msg}</div>}
      <label style={{ display: 'block', marginBottom: 12 }}>전체 무시 대역 (모든 vCenter)
        <textarea className="input" rows={5} value={globalText} onChange={(e) => setGlobal(e.target.value)} placeholder={'10.255.0.0/16\n8.8.8.8'} style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }} />
      </label>
      <div style={{ borderTop: '1px solid rgba(255,255,255,.08)', paddingTop: 10 }}>
        <div className="flex gap" style={{ alignItems: 'center', marginBottom: 6 }}>
          <b style={{ fontSize: 13 }}>vCenter별 무시 대역</b>
          <select className="select" value={vc} onChange={(e) => setVc(e.target.value)} style={{ maxWidth: 240 }}>
            {vcs.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </div>
        <textarea className="input" rows={5} value={vcText} onChange={(e) => setVcText(e.target.value)} placeholder={'172.16.0.0/12'} style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }} />
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>선택한 <b>{vcs.find((v) => v.id === vc)?.name || vc}</b> 에서만 위 대역을 숨깁니다.</div>
      </div>
      <div style={{ borderTop: '1px solid rgba(255,255,255,.08)', paddingTop: 10, marginTop: 12 }}>
        <b style={{ fontSize: 13 }}>공인 / 사설 IP 분류</b>
        <div className="muted" style={{ fontSize: 11, margin: '4px 0 10px' }}>관리대장의 <b>분류</b> 열에 사용됩니다. 명시한 대역이 우선이고, 둘 다 해당 없으면 RFC1918(10/8·172.16/12·192.168/16)은 <b>사설</b>, 그 외는 <b>공인</b>으로 자동 분류됩니다. 사설이 우선합니다.</div>
        <div className="flex gap wrap">
          <label style={{ flex: 1, minWidth: 220 }}>공인(Public) 대역
            <textarea className="input" rows={4} value={publicText} onChange={(e) => setPublic(e.target.value)} placeholder={'203.0.113.0/24\n8.8.8.8'} style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }} />
          </label>
          <label style={{ flex: 1, minWidth: 220 }}>사설(Private) 대역
            <textarea className="input" rows={4} value={privateText} onChange={(e) => setPrivate(e.target.value)} placeholder={'100.64.0.0/10\n10.0.0.0/8'} style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }} />
          </label>
        </div>
      </div>
      <div className="flex gap" style={{ marginTop: 14 }}>
        <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} onClick={save}>저장</button>
        <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={onClose}>취소</button>
      </div>
    </Modal>
  );
}

/** IP 능동 스캔(TCP 커넥트) 설정 + 수동 실행 + 결과. 물리/기타 서버 IP를 대장에 채운다. */
const LOCAL_AGENT = '__local__';
function IpScanSettings({ onClose }) {
  const [s, setS] = useState(null);
  const [agent, setAgent] = useState(LOCAL_AGENT);
  const [agents, setAgents] = useState([LOCAL_AGENT]);
  const [newAgent, setNewAgent] = useState('');
  const [status, setStatus] = useState(null);
  const [info, setInfo] = useState(null);
  const [reports, setReports] = useState({});
  const [centralEnabled, setCentralEnabled] = useState(true);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = async (ag, first = false) => {
    try {
      const r = await fetchJson('/admin/ipam/scan/settings', { agent: ag });
      if (first) setS(r.settings);
      if (r.agents) setAgents(r.agents);
      setStatus(r.status); setInfo(r.info); setReports(r.reports || {}); setCentralEnabled(r.centralEnabled !== false);
    } catch (e) { setMsg(e.message); }
  };
  useEffect(() => { load(agent, true); const t = setInterval(() => load(agent, false), 5000); return () => clearInterval(t); /* eslint-disable-next-line */ }, [agent]);
  if (!s) return <Modal title="IP 스캔" onClose={onClose}>{msg ? <ErrorBox message={msg} /> : <Loading />}</Modal>;

  const isLocal = agent === LOCAL_AGENT;
  const agentLabel = (a) => (a === LOCAL_AGENT ? '이 포탈에서 직접' : a);
  const switchAgent = (a) => { setS(null); setMsg(null); setAgent(a); };
  const save = async () => {
    setBusy(true); setMsg(null);
    try { const r = await putJson('/admin/ipam/scan/settings', { ...s, agent }); setS(r.settings); setStatus(r.status); setMsg(isLocal ? '저장되었습니다(이 포탈에 즉시 적용).' : `저장되었습니다. '${agent}' 에이전트가 다음 주기에 읽어가 스캔합니다.`); }
    catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(false); }
  };
  const runNow = async () => {
    setBusy(true); setMsg('스캔 실행 중…');
    try { const r = await postJson('/admin/ipam/scan/run', {}); setStatus(r.status); setInfo(r.info); setMsg(r.ok ? `완료: ${r.scanned}개 중 ${r.alive}개 응답 (${Math.round((r.durationMs || 0) / 1000)}초)` : `실패: ${r.reason}`); }
    catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(false); }
  };
  const last = status?.lastRun;

  return (
    <Modal title="🛰️ IP 능동 스캔 (TCP 커넥트)" onClose={onClose} width={680} resizable minWidth={460} minHeight={420}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        vCenter가 모르는 <b>물리서버·타 가상화·네트워크 장비</b> IP를 TCP 커넥트 스캔으로 찾아 IP 관리대장에 채웁니다.
        <b> 할당 에이전트</b>를 고르면 해당 에이전트가 이 설정을 읽어가 자기 사이트에서 스캔하고 결과를 포탈에 보고합니다.
        <span className="badge amber" style={{ marginLeft: 6 }}>승인된 대역만</span>
      </div>
      {msg && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{msg}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 16, rowGap: 14, alignItems: 'start' }}>
        <label style={{ fontWeight: 600, paddingTop: 9 }}>할당 에이전트</label>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <select className="select" value={agent} onChange={(e) => switchAgent(e.target.value)} style={{ maxWidth: 260 }}>
            {agents.map((a) => <option key={a} value={a}>{agentLabel(a)}</option>)}
          </select>
          <input className="input" style={{ width: 160 }} placeholder="새 에이전트 이름" value={newAgent} onChange={(e) => setNewAgent(e.target.value)} />
          <button className="tab" style={{ flex: 'none', padding: '6px 12px' }} disabled={!newAgent.trim()} onClick={() => { const a = newAgent.trim(); setNewAgent(''); if (a) switchAgent(a); }}>추가/선택</button>
        </div>
        <label style={{ fontWeight: 600, paddingTop: 9 }}>사용</label>
        <label className="flex gap" style={{ alignItems: 'center', paddingTop: 9 }}>
          <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> 주기적으로 스캔
        </label>
        <label style={{ fontWeight: 600, paddingTop: 9 }}>스캔 대역</label>
        <textarea className="input" value={(s.ranges || []).join('\n')} onChange={(e) => setS({ ...s, ranges: e.target.value.split(/\n/) })}
          placeholder={'10.0.0.0/24\n192.168.1.1-192.168.1.50\n172.16.5.10'} style={{ resize: 'vertical', minHeight: 96, fontFamily: 'monospace', fontSize: 12, width: '100%', boxSizing: 'border-box' }} />
        <label style={{ fontWeight: 600, paddingTop: 9 }}>포트</label>
        <input className="input" value={(s.ports || []).join(', ')} onChange={(e) => setS({ ...s, ports: e.target.value.split(/[\s,]+/).map(Number).filter(Boolean) })}
          style={{ width: '100%', boxSizing: 'border-box' }} />
        <label style={{ fontWeight: 600, paddingTop: 9 }}>주기 / 동시성 / 타임아웃</label>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <input className="input" type="number" min={1} style={{ width: 90 }} value={Math.round(s.intervalMs / 60000)} onChange={(e) => setS({ ...s, intervalMs: Math.max(1, Number(e.target.value) || 60) * 60000 })} /><span className="muted">분</span>
          <input className="input" type="number" min={1} max={1024} style={{ width: 80 }} value={s.concurrency} onChange={(e) => setS({ ...s, concurrency: Number(e.target.value) || 128 })} /><span className="muted">동시</span>
          <input className="input" type="number" min={100} max={10000} style={{ width: 90 }} value={s.timeoutMs} onChange={(e) => setS({ ...s, timeoutMs: Number(e.target.value) || 700 })} /><span className="muted">ms</span>
        </div>
        <label style={{ fontWeight: 600, paddingTop: 9 }}>역DNS / 보존</label>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <label className="flex gap" style={{ alignItems: 'center' }}><input type="checkbox" checked={s.reverseDns} onChange={(e) => setS({ ...s, reverseDns: e.target.checked })} /> 역DNS 호스트명</label>
          <input className="input" type="number" min={0} style={{ width: 80 }} value={s.retentionDays} onChange={(e) => setS({ ...s, retentionDays: Number(e.target.value) || 0 })} /><span className="muted">일 보존</span>
        </div>
      </div>

      {!isLocal && <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>※ 이 설정은 <b>{agent}</b> 에이전트(<code>AGENT_NAME={agent}</code>, <code>CENTRAL_URL</code> 설정 필요)가 다음 주기에 읽어가 자기 사이트에서 스캔하고 결과를 포탈로 보고합니다. '지금 스캔'은 이 포탈에서 직접 스캔할 때만 동작합니다.</div>}

      {/* 등록된 에이전트 없음 안내 */}
      {agents.filter((a) => a !== LOCAL_AGENT).length === 0 && (
        <div className="card" style={{ padding: 12, marginTop: 14, borderColor: 'var(--amber)', fontSize: 12.5, lineHeight: 1.7 }}>
          <b style={{ color: 'var(--amber)' }}>⚠ 등록된 에이전트가 없습니다.</b> 현재는 <b>이 포탈에서 직접</b>만 스캔할 수 있습니다.
          <div className="muted" style={{ marginTop: 6 }}>
            분산 에이전트가 목록에 뜨려면:
            <div>① <b>설정 › 에이전트 배포</b>로 에이전트를 배포하거나 <b>수집 서버</b>를 등록</div>
            <div>② 에이전트 측에 <code>AGENT_NAME</code>, <code>CENTRAL_URL</code>(이 포탈 주소), <code>CENTRAL_TOKEN</code> 설정</div>
            <div>③ <b>이 포탈에 <code>CENTRAL_TOKEN</code> 환경변수가 설정되어 있어야</b> 에이전트 보고가 허용됩니다 {centralEnabled ? <span className="badge green">설정됨</span> : <span className="badge red">미설정</span>}</div>
            <div style={{ marginTop: 4 }}>· 우측 <b>"새 에이전트 이름"</b>에 에이전트의 <code>AGENT_NAME</code>을 직접 입력해 미리 할당을 만들어 둘 수도 있습니다.</div>
          </div>
        </div>
      )}

      {/* 에이전트별 마지막 보고 현황 */}
      {Object.keys(reports).length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>에이전트별 보고 현황</div>
          <div className="table-wrap" style={{ maxHeight: '24vh' }}>
            <table>
              <thead><tr><th>에이전트</th><th>마지막 보고</th><th style={{ textAlign: 'right' }}>스캔 / 응답</th><th>상태</th></tr></thead>
              <tbody>
                {Object.entries(reports).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).map(([name, r]) => {
                  const ageMin = (Date.now() - (r.at || 0)) / 60000;
                  const fresh = ageMin < 90; // 90분 내 보고면 정상
                  return (
                    <tr key={name}>
                      <td><b>{name === LOCAL_AGENT ? '이 포탈' : name}</b></td>
                      <td className="muted" style={{ fontSize: 12 }}>{r.at ? new Date(r.at).toLocaleString('ko-KR') : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{(r.scanned ?? 0).toLocaleString()} / <b>{(r.alive ?? 0).toLocaleString()}</b></td>
                      <td><span className={`badge ${fresh ? 'green' : 'gray'}`}>{fresh ? '정상' : '오래됨'}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 12, marginTop: 14, fontSize: 13 }}>
        <span className="muted">이 포탈 상태 <b style={{ color: status?.running ? 'var(--amber)' : 'var(--text)' }}>{status?.running ? '스캔 중' : (status?.enabled ? '활성' : '비활성')}</b></span>{' · '}
        <span className="muted">저장된 결과 <b style={{ color: 'var(--text)' }}>{info?.count ?? 0}</b>개</span>
        {info?.byAgent && Object.keys(info.byAgent).length > 0 && <span className="muted"> ({Object.entries(info.byAgent).map(([a, n]) => `${a === LOCAL_AGENT ? '포탈' : a}:${n}`).join(', ')})</span>}
        {last && !last.skipped && !last.error && <span className="muted"> · 최근(포탈): {last.scanned}개 중 {last.alive}개 응답</span>}
        {last?.error && <span style={{ color: 'var(--red)' }}> · 오류: {last.error}</span>}
      </div>

      <div className="flex gap" style={{ marginTop: 14 }}>
        <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={busy} onClick={save}>저장</button>
        <button className="logout-btn" style={{ padding: '9px 14px' }} disabled={busy || status?.running || !isLocal} title={isLocal ? '' : '원격 에이전트는 자체 주기로 스캔합니다'} onClick={runNow}>지금 스캔(포탈)</button>
        <button className="logout-btn" style={{ padding: '9px 14px', marginLeft: 'auto' }} onClick={onClose}>닫기</button>
      </div>
    </Modal>
  );
}

function Hardware({ scope }) {
  const { loading, data, error } = useTool('/tools/hardware', scope ? { vcenterId: scope } : {});
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const cols = [
    { key: 'vcenterName', label: '법인(vCenter)', render: (r) => <b>{r.vcenterName}</b> },
    { key: 'vendor', label: '벤더', render: (r) => <span className="badge blue">{r.vendor}</span> },
    { key: 'model', label: '모델' },
    { key: 'count', label: '수량', align: 'right', render: (r) => <b>{r.count}</b> },
  ];
  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="호스트" value={data.hosts} meta={`벤더 ${data.byVendor.length} · 모델 ${data.byModel.length}`} />
        {data.byVendor.slice(0, 4).map((v) => <Card key={v.vendor} label={v.vendor} value={v.count} />)}
      </div>
      <div className="section-title" style={{ marginTop: 0 }}>모델별 합계</div>
      <div className="flex gap wrap" style={{ marginBottom: 14 }}>
        {data.byModel.slice(0, 12).map((m) => <span key={m.model} className="badge gray" style={{ fontSize: 12, padding: '4px 10px' }}>{m.model} · {m.count}</span>)}
      </div>
      <div className="section-title">법인 × 벤더 × 모델</div>
      <DataTable columns={cols} rows={data.items} initialSort={{ key: 'count', dir: 'desc' }} />
    </>
  );
}

function Esxi({ scope }) {
  const { loading, data, error } = useTool('/tools/esxi', scope ? { vcenterId: scope } : {});
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const cols = [
    { key: 'host', label: '호스트', render: (h) => <b>{h.host}</b> },
    { key: 'vcenterId', label: 'vCenter', render: (h) => <span className="muted">{h.vcenterId}</span> },
    { key: 'cluster', label: '클러스터' },
    { key: 'version', label: 'ESXi 버전', render: (h) => <span className="badge blue">{h.version}</span> },
    { key: 'build', label: '빌드', render: (h) => <span className="muted">{h.build || '—'}</span> },
    { key: 'connectionState', label: '상태', render: (h) => <StateBadge state={h.connectionState} /> },
  ];
  return (
    <>
      <div className="flex gap wrap" style={{ marginBottom: 14 }}>
        <Card label="호스트" value={data.scanned} meta={`버전 ${data.versions.length}종`} />
        {data.versions.map((v) => <span key={v.version} className="badge blue" style={{ alignSelf: 'center', fontSize: 13, padding: '4px 10px' }}>{v.version} · {v.count}</span>)}
      </div>
      <DataTable columns={cols} rows={data.items} initialSort={{ key: 'version', dir: 'desc' }} />
    </>
  );
}

function VcVersion() {
  const { loading, data, error } = useTool('/tools/solutions', {});
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const cols = [
    { key: 'name', label: 'vCenter', render: (v) => <b>{v.name}</b> },
    { key: 'version', label: '버전', render: (v) => <span className="badge blue">{v.version || '—'}</span> },
    { key: 'build', label: '빌드', render: (v) => <span className="muted">{v.build || '—'}</span> },
    { key: 'status', label: '상태', render: (v) => <StateBadge state={v.status} /> },
    { key: 'fullName', label: '제품', render: (v) => <span className="muted" style={{ fontSize: 12 }}>{v.fullName || '—'}</span> },
  ];
  return (
    <>
      <div className="flex gap wrap" style={{ marginBottom: 14 }}>
        <Card label="vCenter" value={data.items.length} meta={`버전 ${data.vcenterVersions.length}종`} />
        {data.vcenterVersions.map((v) => <span key={v.version} className="badge blue" style={{ alignSelf: 'center', fontSize: 13, padding: '4px 10px' }}>v{v.version} · {v.count}</span>)}
      </div>
      <DataTable columns={cols} rows={data.items} initialSort={{ key: 'version', dir: 'desc' }} />
    </>
  );
}

function Nsx() {
  const { loading, data, error } = useTool('/tools/solutions', {});
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const withNsx = data.items.filter((it) => it.nsx.length > 0);
  const cols = [
    { key: 'name', label: 'vCenter', render: (it) => <b>{it.name}</b> },
    { key: 'nsxVersion', label: 'NSX 버전', sortValue: (it) => it.nsx[0]?.version || '', render: (it) => it.nsx.map((s) => <span key={s.key} className="badge green" style={{ marginRight: 4 }}>{s.label} {s.version}</span>) },
    { key: 'status', label: 'vCenter 상태', render: (it) => <StateBadge state={it.status} /> },
  ];
  return (
    <>
      <div className="flex gap wrap" style={{ marginBottom: 14 }}>
        <Card label="NSX 적용 vCenter" value={withNsx.length} meta={`전체 ${data.items.length}`} accent="var(--green)" />
        {data.nsxVersions.map((n) => <span key={n.version} className="badge green" style={{ alignSelf: 'center', fontSize: 13, padding: '4px 10px' }}>NSX {n.version} · {n.count}</span>)}
        {data.nsxVersions.length === 0 && <span className="muted" style={{ alignSelf: 'center' }}>NSX 정보 없음</span>}
      </div>
      {withNsx.length > 0
        ? <DataTable columns={cols} rows={withNsx} initialSort={{ key: 'name', dir: 'asc' }} />
        : <div className="card"><span className="muted">NSX가 설치된 vCenter가 없습니다.</span></div>}
      <div className="card" style={{ marginTop: 14, borderColor: 'var(--border)' }}>
        <b>NSX 정책 관리</b>
        <div className="muted" style={{ fontSize: 13, marginTop: 6, lineHeight: 1.7 }}>
          세그먼트/방화벽 등 NSX 정책 관리는 NSX Manager API 연동이 필요합니다. 현재는 vCenter 등록 정보 기준
          <b> 배포 현황·버전</b>을 보여줍니다. NSX Manager 연동(주소·계정)을 추가하면 정책 조회/관리를 확장할 수 있습니다.
        </div>
      </div>
    </>
  );
}

function Shutdown() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="card" style={{ borderColor: 'var(--red)', textAlign: 'center', padding: 32 }}>
        <div style={{ fontSize: 44 }}>🛑</div>
        <div style={{ fontSize: 18, fontWeight: 800, margin: '12px 0', color: 'var(--red)' }}>긴급 ShutDown</div>
        <div className="muted" style={{ marginBottom: 20 }}>비상 시 인프라를 정지하는 기능입니다. 신중히 사용하세요.</div>
        <button className="login-btn" style={{ flex: 'none', padding: '12px 28px', background: 'var(--red)', borderColor: 'var(--red)' }} onClick={() => setOpen(true)}>
          🛑 긴급 ShutDown 실행
        </button>
      </div>
      {open && (
        <Modal title="긴급 ShutDown" onClose={() => setOpen(false)} width={460}>
          <div style={{ textAlign: 'center', padding: '12px 8px' }}>
            <div style={{ fontSize: 40 }}>⚠️</div>
            <div style={{ fontSize: 16, fontWeight: 700, margin: '14px 0 6px' }}>세부 내용은 관리자에게 문의하세요</div>
            <div className="muted" style={{ fontSize: 13 }}>This action requires administrator authorization.</div>
            <button className="login-btn" style={{ flex: 'none', padding: '10px 22px', marginTop: 18 }} onClick={() => setOpen(false)}>확인</button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Generic on-demand fetch hook (runs when params change). */
function useTool(path, params) {
  const [state, setState] = useState({ loading: true });
  const key = JSON.stringify(params);
  useEffect(() => {
    let active = true; setState({ loading: true });
    fetchJson(path, params).then((d) => active && setState({ loading: false, data: d })).catch((e) => active && setState({ loading: false, error: e.message }));
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key]);
  return state;
}

function tempColor(c) { return c == null ? 'var(--text-faint)' : c >= 40 ? 'var(--red)' : c >= 32 ? 'var(--amber)' : 'var(--green)'; }

// 집계 단위(bucketMs)에 맞춰 X축 라벨: 분/시간이면 시각, 일 이상이면 날짜.
function fmtTempTick(ts, bucketMs) {
  const d = new Date(ts);
  if (bucketMs && bucketMs <= 3_600_000) return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit' });
}

function EsxiTemp({ scope }) {
  const { loading, data, error } = useTool('/tools/esxi-temp', scope ? { vcenterId: scope } : {});
  const [view, setView] = useState('host'); // host | cluster | vc
  const [hist, setHist] = useState(null); // { level, key, days, points, synthesized }
  const [days, setDays] = useState(7);
  const [bucket, setBucket] = useState('auto'); // auto | minute | hour | day
  const openHist = async (level, key) => {
    setHist({ level, key, loading: true });
    const bq = bucket && bucket !== 'auto' ? `&bucket=${bucket}` : '';
    const r = await fetchJson(`/tools/esxi-temp/history?level=${level}&key=${encodeURIComponent(key)}&days=${days}${bq}`).catch(() => null);
    setHist(r ? { ...r } : { error: true });
  };
  useEffect(() => { if (hist && hist.key) openHist(hist.level, hist.key); /* eslint-disable-next-line */ }, [days, bucket]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;

  const rows = view === 'host'
    ? data.hosts.map((h) => ({ key: h.id, name: h.name, sub: `${h.vcenterId} / ${h.cluster || '-'}`, curC: h.curC, avg5C: h.avg5C, maxC: h.tempMaxC, level: 'host' }))
    : (view === 'cluster' ? data.clusters : data.vcenters).map((g) => ({ key: g.key, name: g.key.replace('|', ' / '), sub: `${g.hosts} 호스트`, curC: g.curC, avg5C: g.avg5C, maxC: g.maxC, level: view === 'cluster' ? 'cluster' : 'vc' }));

  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="온도 보고 호스트" value={`${data.reportingHosts}/${data.totalHosts}`} meta="센서 보고 호스트" />
        <Card label="평균 온도" value={data.hosts.length ? `${(data.hosts.reduce((a, h) => a + h.curC, 0) / data.hosts.length).toFixed(1)}℃` : '—'} />
        <Card label="최고 온도" value={data.hosts.length ? `${Math.max(...data.hosts.map((h) => h.tempMaxC))}℃` : '—'} accent="var(--red)" />
      </div>
      {data.reportingHosts === 0 && <div className="card" style={{ marginBottom: 12, borderColor: 'var(--amber)' }}><span className="muted">온도 센서를 보고하는 호스트가 없습니다(하드웨어/CIM 미지원이거나 nested ESXi). 라이브 수집 시 표시됩니다.</span></div>}
      <div className="flex gap" style={{ marginBottom: 8 }}>
        {[['host', '호스트별'], ['cluster', '클러스터별'], ['vc', '법인별']].map(([k, l]) => (
          <button key={k} className={view === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView(k)}>{l}</button>
        ))}
      </div>
      <DataTable rows={rows} initialSort={{ key: 'curC', dir: 'desc' }} columns={[
        { key: 'name', label: view === 'host' ? '호스트' : (view === 'cluster' ? '클러스터' : '법인'), render: (r) => <button className="cell-link" onClick={() => openHist(r.level, r.key)}>{r.name}</button> },
        { key: 'sub', label: '구분', render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.sub}</span> },
        { key: 'curC', label: '현재온도 ℃', align: 'right', render: (r) => <b style={{ color: tempColor(r.curC) }}>{r.curC ?? '—'}</b> },
        { key: 'avg5C', label: '5분 평균 ℃', align: 'right', render: (r) => <span style={{ color: tempColor(r.avg5C) }}>{r.avg5C ?? '—'}</span> },
        { key: 'maxC', label: '최대 온도 ℃', align: 'right', render: (r) => <span style={{ color: tempColor(r.maxC) }}>{r.maxC ?? '—'}</span> },
        { key: 'hist', label: '추이', render: (r) => <button className="tab" onClick={() => openHist(r.level, r.key)}>5년 추이</button> },
      ]} />

      {hist && (
        <Modal title={`온도 추이 — ${hist.key || ''}`} onClose={() => setHist(null)} width={760}>
          <div className="flex gap wrap" style={{ marginBottom: 8 }}>
            {[[1, '1일'], [7, '1주'], [30, '1달'], [365, '1년'], [1830, '5년']].map(([d, l]) => (
              <button key={d} className={days === d ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '6px 12px', fontSize: 12 }} onClick={() => setDays(d)}>{l}</button>
            ))}
            {hist.synthesized && <span className="badge amber" style={{ alignSelf: 'center' }}>데모 합성</span>}
          </div>
          <div className="flex gap wrap" style={{ marginBottom: 10, alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12 }}>집계 단위(기준)</span>
            {[['auto', '자동'], ['minute', '분'], ['hour', '시간'], ['day', '일']].map(([b, l]) => (
              <button key={b} className={bucket === b ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 11px', fontSize: 12 }} onClick={() => setBucket(b)}>{l}</button>
            ))}
            {hist.points?.length ? <span className="muted" style={{ fontSize: 11 }}>{hist.points.length}개 구간</span> : null}
          </div>
          {hist.loading ? <Loading /> : hist.error ? <ErrorBox message="이력을 불러오지 못했습니다." /> : (hist.points || []).length === 0
            ? <div className="muted">해당 기간 데이터가 없습니다(수집 누적 후 표시).</div>
            : (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={(hist.points || []).map((p) => ({ t: fmtTempTick(p.ts, hist.bucketMs), avg: p.avg, max: p.max }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" />
                  <XAxis dataKey="t" tick={{ fontSize: 11 }} minTickGap={40} />
                  <YAxis tick={{ fontSize: 11 }} unit="℃" domain={['auto', 'auto']} />
                  <Tooltip contentStyle={{ background: '#0b1220', border: '1px solid #243049', fontSize: 12 }} />
                  <Line type="monotone" dataKey="avg" stroke="#22d3ee" dot={false} name="평균" />
                  <Line type="monotone" dataKey="max" stroke="#f87171" dot={false} name="최고" />
                </LineChart>
              </ResponsiveContainer>
            )}
        </Modal>
      )}
    </>
  );
}

function Forecast({ scope }) {
  const { loading, data, error } = useTool('/tools/capacity-forecast', scope ? { vcenterId: scope } : {});
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const tb2 = (g) => (g >= 1024 ? `${(g / 1024).toFixed(1)} TB` : `${g} GB`);
  const dlabel = (d) => d == null ? '—' : d > 3650 ? '>10년' : d > 365 ? `${(d / 365).toFixed(1)}년` : `${d}일`;
  const soon = data.items.filter((x) => x.daysToFull != null && x.daysToFull <= 180).length;
  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="데이터스토어" value={data.items.length} />
        <Card label="180일 내 포화 예상" value={soon} accent={soon ? 'var(--red)' : 'var(--green)'} />
      </div>
      {data.mock && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>※ 데모: 증가율/예상일은 합성값입니다. 라이브는 수집 이력(ds_usedgb)이 쌓이면 선형회귀로 산출됩니다.</div>}
      <DataTable rows={data.items} initialSort={{ key: 'daysToFull', dir: 'asc' }} columns={[
        { key: 'name', label: '데이터스토어', render: (d) => <b>{d.name}</b> },
        { key: 'vcenterId', label: 'vCenter', render: (d) => <span className="muted">{d.vcenterId}</span> },
        { key: 'usagePct', label: '현재 사용', render: (d) => <UsageCell pct={d.usagePct} /> },
        { key: 'freeGB', label: '여유', align: 'right', render: (d) => tb2(d.freeGB) },
        { key: 'growthGBperDay', label: '증가율/일', align: 'right', render: (d) => d.growthGBperDay == null ? '—' : `${d.growthGBperDay} GB` },
        { key: 'daysToFull', label: '가득 찰 예상', align: 'right', render: (d) => <b style={{ color: d.daysToFull != null && d.daysToFull <= 180 ? 'var(--red)' : undefined }}>{dlabel(d.daysToFull)}</b> },
      ]} />
    </>
  );
}

function Capacity({ scope }) {
  const { loading, data, error } = useTool('/tools/capacity', scope ? { vcenterId: scope } : {});
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const t = data.totals;
  const cols = [
    { key: 'cluster', label: '클러스터', render: (c) => <b>{c.cluster}</b> },
    { key: 'vcenterId', label: 'vCenter', render: (c) => <span className="muted">{c.vcenterId}</span> },
    { key: 'hosts', label: '호스트', align: 'right' },
    { key: 'vmsOn', label: 'VM(On)', align: 'right', render: (c) => `${c.vmsOn}/${c.vms}` },
    { key: 'cores', label: '물리코어', align: 'right' },
    { key: 'vcpuAllocated', label: '할당 vCPU', align: 'right' },
    { key: 'vcpuPerCore', label: 'vCPU:코어', align: 'right', render: (c) => <span className={`badge ${c.vcpuPerCore >= 4 ? 'red' : c.vcpuPerCore >= 3 ? 'amber' : 'green'}`}>{c.vcpuPerCore}:1</span> },
    { key: 'ramOvercommitPct', label: 'RAM 오버커밋', align: 'right', render: (c) => <span className={`badge ${c.ramOvercommitPct >= 100 ? 'red' : c.ramOvercommitPct >= 85 ? 'amber' : 'green'}`}>{c.ramOvercommitPct}%</span> },
    { key: 'cpuUsedPct', label: 'CPU 사용', render: (c) => <UsageCell pct={c.cpuUsedPct} /> },
    { key: 'memUsedPct', label: '메모리 사용', render: (c) => <UsageCell pct={c.memUsedPct} /> },
    { key: 'ramHeadroomGB', label: 'RAM 여유', align: 'right', render: (c) => tb(c.ramHeadroomGB) },
  ];
  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="클러스터" value={t.clusters} meta={`호스트 ${t.hosts}`} />
        <Card label="물리코어 / 할당 vCPU" value={`${t.cores} / ${t.vcpuAllocated}`} meta={`${t.vcpuPerCore}:1 평균`} accent={t.vcpuPerCore >= 4 ? 'var(--red)' : undefined} />
        <Card label="메모리 / 할당" value={`${tb(t.memTotalGB)} / ${tb(t.ramAllocatedGB)}`} />
        <Card label="RAM 여유(헤드룸)" value={tb(t.ramHeadroomGB)} accent={t.ramHeadroomGB <= 0 ? 'var(--red)' : 'var(--green)'} />
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>오버커밋: vCPU:코어 ≥4 또는 RAM ≥100%면 과밀(빨강). RAM 여유 = 물리RAM − 할당(전원 On).</div>
      <DataTable columns={cols} rows={data.clusters} initialSort={{ key: 'ramOvercommitPct', dir: 'desc' }} />
    </>
  );
}

function Waste({ scope }) {
  const { loading, data, error } = useTool('/tools/waste', scope ? { vcenterId: scope } : {});
  const [tab, setTab] = useState('off');
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const tb2 = (g) => (g >= 1024 ? `${(g / 1024).toFixed(1)} TB` : `${g} GB`);
  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="전원 꺼진 VM" value={data.poweredOff.count} meta={`스토리지 ${tb2(data.poweredOff.storageGB)} 점유`} accent={data.poweredOff.count ? 'var(--amber)' : undefined} />
        <Card label="스냅샷 보유 VM" value={data.snapshots.count} meta={`${tb2(data.snapshots.sizeGB)} 사용`} accent={data.snapshots.count ? 'var(--amber)' : undefined} />
        <Card label="Thin 회수가능(추정)" value={tb2(data.thinReclaim.reclaimableGB)} meta={`${data.thinReclaim.count} VM`} />
        <Card label="Tools 미실행(On)" value={data.noTools.count} accent={data.noTools.count ? 'var(--amber)' : undefined} />
      </div>
      <div className="flex gap" style={{ marginBottom: 8 }}>
        {[['off', `전원 꺼짐 (${data.poweredOff.count})`], ['snap', `스냅샷 (${data.snapshots.count})`], ['tools', `Tools 미실행 (${data.noTools.count})`]].map(([k, l]) => (
          <button key={k} className={tab === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'off' && <DataTable rows={data.poweredOff.vms} initialSort={{ key: 'storageGB', dir: 'desc' }} columns={[
        { key: 'name', label: 'VM', render: (v) => <VmLink name={v.name} vcenterId={v.vcenterId} label={v.name} /> }, { key: 'vcenterId', label: 'vCenter', render: (v) => <span className="muted">{v.vcenterId}</span> },
        { key: 'guestOS', label: 'OS' }, { key: 'storageGB', label: '스토리지', align: 'right', render: (v) => tb2(v.storageGB) }]} />}
      {tab === 'snap' && <DataTable rows={data.snapshots.vms} initialSort={{ key: 'snapshotSizeGB', dir: 'desc' }} columns={[
        { key: 'name', label: 'VM', render: (v) => <VmLink name={v.name} vcenterId={v.vcenterId} label={v.name} /> }, { key: 'vcenterId', label: 'vCenter', render: (v) => <span className="muted">{v.vcenterId}</span> },
        { key: 'snapshotCount', label: '개수', align: 'right' }, { key: 'snapshotSizeGB', label: '크기', align: 'right', render: (v) => tb2(v.snapshotSizeGB) }]} />}
      {tab === 'tools' && <DataTable rows={data.noTools.vms} columns={[
        { key: 'name', label: 'VM', render: (v) => <VmLink name={v.name} vcenterId={v.vcenterId} label={v.name} /> }, { key: 'vcenterId', label: 'vCenter', render: (v) => <span className="muted">{v.vcenterId}</span> },
        { key: 'toolsStatus', label: 'Tools 상태', render: (v) => <span className="badge amber">{v.toolsStatus}</span> }]} />}
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>※ 고아 디스크(orphaned VMDK)는 데이터스토어 파일 스캔이 필요해 현재 미포함입니다.</div>
    </>
  );
}

function VmFinder() {
  const { data: vcenters } = usePolling('/vcenters', {}, 60_000);
  const [f, setF] = useState({ vcenterIds: [], folders: [], clusters: [], resourcePools: [], powerState: '', os: '', q: '', includeTemplates: false });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [idleThreshold, setIdleThreshold] = useState(5);

  const search = async (withAvg = false) => {
    setLoading(true);
    try { setData(await postJson('/tools/vm-finder', { ...f, withAvg, idleThreshold: Number(idleThreshold) || 5 })); }
    catch (e) { setData({ error: e.message, items: [], facets: { vcenters: [], folders: [], clusters: [], resourcePools: [] } }); }
    finally { setLoading(false); }
  };
  useEffect(() => { search(false); /* eslint-disable-next-line */ }, []);

  const toggle = (key, val) => setF((s) => ({ ...s, [key]: s[key].includes(val) ? s[key].filter((x) => x !== val) : [...s[key], val] }));
  const facets = data?.facets || { vcenters: [], folders: [], clusters: [], resourcePools: [] };
  const vcName = (id) => (vcenters || []).find((v) => v.id === id)?.name || id;
  // vCenter 칩을 설정에서 지정한 순서(/vcenters 응답 순서)대로 정렬.
  const vcOrder = (vcenters || []).map((v) => v.id);
  const orderedVcenters = [...(facets.vcenters || [])].sort((a, b) => {
    const ia = vcOrder.indexOf(a); const ib = vcOrder.indexOf(b);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
  });

  const Chips = ({ label, list, sel, onToggle, nameOf }) => (
    <div style={{ marginBottom: 8 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{label} {sel.length ? `(${sel.length})` : ''}</div>
      <div className="flex gap wrap" style={{ maxHeight: 92, overflowY: 'auto' }}>
        {list.length === 0 && <span className="muted" style={{ fontSize: 12 }}>—</span>}
        {list.map((x) => (
          <span key={x} className="badge gray" style={{ cursor: 'pointer', padding: '4px 10px', fontSize: 12, border: sel.includes(x) ? '1px solid var(--accent,#6366f1)' : undefined, color: sel.includes(x) ? '#c7d2fe' : undefined }}
            onClick={() => onToggle(x)}>{nameOf ? nameOf(x) : x}</span>
        ))}
      </div>
    </div>
  );

  const items = data?.items || [];
  const withAvg = data?.avgComputed;
  const cols = [
    { key: 'name', label: 'VM', render: (r) => <VmLink name={r.name} vcenterId={r.vcenterId} label={r.name} /> },
    { key: 'vcenterId', label: 'vCenter', render: (r) => <span className="muted">{vcName(r.vcenterId)}</span> },
    { key: 'folder', label: '폴더', render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.folder || '—'}</span> },
    { key: 'cluster', label: '클러스터', render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.cluster || '—'}</span> },
    { key: 'resourcePool', label: '리소스풀', render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.resourcePool || '—'}</span> },
    { key: 'powerState', label: '전원', render: (r) => <StateBadge state={r.powerState} /> },
    { key: 'cpuUsagePct', label: '현재 CPU', render: (r) => <UsageCell pct={r.cpuUsagePct} /> },
    ...(withAvg ? [
      { key: 'avgDayCpu', label: '1일 평균', align: 'right', render: (r) => (r.avgDayCpu == null ? '—' : `${r.avgDayCpu}%`) },
      { key: 'avgWeekCpu', label: '1주 평균', align: 'right', render: (r) => (r.avgWeekCpu == null ? '—' : `${r.avgWeekCpu}%`) },
      { key: 'idle', label: '유휴', render: (r) => (r.idle ? <span className="badge red">유휴</span> : (r.idle === false ? <span className="badge green">사용</span> : '—')) },
    ] : []),
  ];

  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <Chips label="vCenter (미선택=전체)" list={orderedVcenters} sel={f.vcenterIds} onToggle={(x) => toggle('vcenterIds', x)} nameOf={vcName} />
        <div className="flex gap wrap">
          <div style={{ flex: 1, minWidth: 220 }}><Chips label="폴더" list={facets.folders} sel={f.folders} onToggle={(x) => toggle('folders', x)} /></div>
          <div style={{ flex: 1, minWidth: 220 }}><Chips label="클러스터" list={facets.clusters} sel={f.clusters} onToggle={(x) => toggle('clusters', x)} /></div>
          <div style={{ flex: 1, minWidth: 220 }}><Chips label="리소스 풀" list={facets.resourcePools} sel={f.resourcePools} onToggle={(x) => toggle('resourcePools', x)} /></div>
        </div>
        <div className="flex gap wrap" style={{ alignItems: 'flex-end', marginTop: 6 }}>
          <label style={{ fontSize: 12 }}>전원
            <select className="select" value={f.powerState} onChange={(e) => setF({ ...f, powerState: e.target.value })}>
              <option value="">전체</option><option value="POWERED_ON">On</option><option value="POWERED_OFF">Off</option>
            </select>
          </label>
          <label style={{ fontSize: 12 }}>OS 포함<input className="input" value={f.os} onChange={(e) => setF({ ...f, os: e.target.value })} placeholder="예: Windows" /></label>
          <label style={{ fontSize: 12 }}>이름/IP<input className="input" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="검색" /></label>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 12 }}><input type="checkbox" checked={f.includeTemplates} onChange={(e) => setF({ ...f, includeTemplates: e.target.checked })} /> 템플릿 포함</label>
          <label style={{ fontSize: 12 }}>유휴 기준(평균 CPU ≤ %)<input className="input" type="number" style={{ maxWidth: 90 }} value={idleThreshold} onChange={(e) => setIdleThreshold(e.target.value)} /></label>
          <button className="login-btn" style={{ flex: 'none', padding: '9px 16px' }} disabled={loading} onClick={() => search(false)}>{loading ? '검색 중…' : '검색'}</button>
          <button className="logout-btn" style={{ padding: '9px 16px' }} disabled={loading} onClick={() => search(true)} title="필터 결과의 1일/1주 평균 CPU를 조회해 유휴 VM을 찾습니다(상위 일부)">유휴 VM 분석</button>
        </div>
      </div>

      {data?.error && <ErrorBox message={data.error} />}
      <div className="kpis" style={{ marginBottom: 12 }}>
        <Card label="검색 결과" value={items.length.toLocaleString()} meta="조건 일치 VM" />
        {withAvg && <Card label="유휴 VM" value={data.idleCount ?? 0} accent={(data.idleCount ?? 0) ? 'var(--red)' : 'var(--green)'} meta={`평균 CPU ≤ ${data.idleThreshold}%`} />}
        {withAvg && data.avgTruncated && <Card label="평균 분석 범위" value={`상위 ${data.avgCap}`} meta="성능부하 방지 상한" />}
      </div>
      {withAvg && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>※ 1일/1주 평균은 {data.avgTruncated ? `결과 상위 ${data.avgCap}대에 한해 ` : ''}vCenter 성능 데이터로 산출합니다(라이브). 평균이 기준 이하이고 전원 On인 VM을 ‘유휴(생성됐지만 미사용)’로 표시합니다.</div>}
      <DataTable columns={cols} rows={items} initialSort={withAvg ? { key: 'avgWeekCpu', dir: 'asc' } : { key: 'cpuUsagePct', dir: 'asc' }} />
    </>
  );
}

function ThinVms({ scope }) {
  const { loading, data, error } = useTool('/tools/thin-vms', scope ? { vcenterId: scope } : {});
  const [q, setQ] = useState('');
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const term = q.trim().toLowerCase();
  const rows = data.items.filter((r) => !term || r.name.toLowerCase().includes(term) || (r.guestOS || '').toLowerCase().includes(term) || (r.host || '').toLowerCase().includes(term));
  const cols = [
    { key: 'name', label: 'VM', render: (r) => <VmLink name={r.name} vcenterId={r.vcenterId} label={r.name} /> },
    { key: 'vcenterId', label: 'vCenter', render: (r) => <span className="muted">{r.vcenterId}</span> },
    { key: 'powerState', label: '전원', render: (r) => <StateBadge state={r.powerState} /> },
    { key: 'guestOS', label: 'Guest OS' },
    { key: 'committedGB', label: '사용(committed)', align: 'right', render: (r) => tb(r.committedGB) },
    { key: 'provisionedGB', label: '할당(provisioned)', align: 'right', render: (r) => tb(r.provisionedGB) },
    { key: 'uncommittedGB', label: '회수가능(추정)', align: 'right', render: (r) => <b style={{ color: 'var(--amber)' }}>{tb(r.uncommittedGB)}</b> },
    { key: 'host', label: 'ESXi 호스트', render: (r) => <span className="muted">{r.host}</span> },
  ];
  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="Thin VM" value={data.thinVms.toLocaleString()} meta={`전체 ${data.totalVms.toLocaleString()} 중 ${data.thinPct}%`} />
        <Card label="사용 합계" value={`${data.committedTB} TB`} meta="committed" />
        <Card label="할당 합계" value={`${data.provisionedTB} TB`} meta="provisioned" />
        <Card label="회수 가능(추정)" value={`${data.reclaimableTB} TB`} accent="var(--amber)" meta="uncommitted 합" />
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>※ Thin 판정은 vCenter의 uncommitted(여유) 기준 <b>추정</b>입니다. 회수 가능 용량은 정확한 값이 아니라 참고치입니다.</div>
      <div className="flex gap" style={{ marginBottom: 8 }}>
        <SearchBox className="input" style={{ maxWidth: 260 }} placeholder="VM / OS / 호스트 검색" value={q} onChange={setQ} />
      </div>
      <ResultCount total={data.items.length} shown={rows.length} label="Thin VM" filtered={!!term} />
      <DataTable columns={cols} rows={rows} initialSort={{ key: 'uncommittedGB', dir: 'desc' }} />
    </>
  );
}

function GuestOs({ scope }) {
  const { loading, data, error } = useTool('/tools/guest-os', scope ? { vcenterId: scope } : {});
  const [q, setQ] = useState('');
  const [view, setView] = useState('os'); // os | family
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const term = q.trim().toLowerCase();
  const rows = (view === 'os' ? data.items : data.families).filter((r) => !term || (r.os || r.family).toLowerCase().includes(term));
  const osCols = [
    { key: 'os', label: 'Guest OS (종류·버전)', render: (r) => <b>{r.os}</b> },
    { key: 'family', label: '계열', render: (r) => <span className="badge gray">{r.family}</span> },
    { key: 'total', label: 'VM 수', align: 'right' },
    { key: 'on', label: 'On', align: 'right', render: (r) => <span className="badge green">{r.on}</span> },
    { key: 'off', label: 'Off', align: 'right', render: (r) => <span className="badge gray">{r.off}</span> },
  ];
  const famCols = [
    { key: 'family', label: 'OS 계열', render: (r) => <b>{r.family}</b> },
    { key: 'total', label: 'VM 수', align: 'right' },
    { key: 'on', label: 'On', align: 'right', render: (r) => <span className="badge green">{r.on}</span> },
  ];
  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="총 VM" value={data.total.toLocaleString()} meta={scope ? '선택 법인' : '전체 법인'} />
        <Card label="OS 종류(버전 포함)" value={data.distinctOs} />
        <Card label="OS 계열" value={data.families.length} meta={data.families.slice(0, 3).map((f) => f.family).join(' · ')} />
      </div>
      <div className="flex gap wrap" style={{ marginBottom: 8, alignItems: 'center' }}>
        <button className={view === 'os' ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView('os')}>OS·버전별 ({data.items.length})</button>
        <button className={view === 'family' ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView('family')}>계열별 ({data.families.length})</button>
        <SearchBox className="input" style={{ maxWidth: 260 }} placeholder="OS 이름 검색 (예: Windows, Ubuntu 22)" value={q} onChange={setQ} />
      </div>
      <DataTable columns={view === 'os' ? osCols : famCols} rows={rows} initialSort={{ key: 'total', dir: 'desc' }} />
    </>
  );
}

function Card({ label, value, meta, accent, onClick, active }) {
  return (
    <div className="card kpi" onClick={onClick}
      style={{ ...(onClick ? { cursor: 'pointer' } : {}), ...(active ? { border: '1px solid var(--accent,#2563eb)', boxShadow: '0 0 0 1px var(--accent,#2563eb)' } : {}) }}
      title={onClick ? '클릭하여 필터' : undefined}>
      <div className="label">{label}</div>
      <div className="value" style={{ fontSize: 24, ...(accent ? { color: accent } : {}) }}>{value}</div>
      {meta && <div className="meta">{meta}</div>}
    </div>
  );
}

function DupIp({ scope }) {
  const { loading, data, error } = useTool('/tools/duplicate-ips', scope ? { vcenterId: scope } : {});
  const [detail, setDetail] = useState(null);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const cols = [
    { key: 'ip', label: 'IP 주소', render: (d) => <b style={{ color: 'var(--amber)' }}>{d.ip}</b> },
    { key: 'count', label: '중복', align: 'right', render: (d) => <span className="badge red">{d.count}</span> },
    { key: 'crossVcenter', label: '유형', sortValue: (d) => (d.crossVcenter ? 1 : 0), render: (d) => (d.crossVcenter ? <span className="badge amber">vCenter 간</span> : <span className="badge gray">동일</span>) },
    { key: 'vms', label: '사용 중인 VM', sortValue: (d) => d.count, render: (d) => d.vms.map((v, i) => <span key={v.id}>{i > 0 && ', '}<span className="vcd-link" onClick={() => setDetail(v)}>{v.name}</span></span>) },
  ];
  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="중복 IP" value={data.duplicateIps} accent={data.duplicateIps ? 'var(--red)' : 'var(--green)'} meta={`검사 VM ${data.scannedVms.toLocaleString()}`} />
        <Card label="영향 VM" value={data.affectedVms} />
      </div>
      {data.items.length === 0 ? <div className="card" style={{ borderColor: 'var(--green)' }}><b style={{ color: 'var(--green)' }}>✓ 중복 IP가 없습니다.</b></div>
        : <DataTable columns={cols} rows={data.items} initialSort={{ key: 'count', dir: 'desc' }} />}
      {detail && <EntityDetail type="vm" item={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

function VmTools({ scope }) {
  const { loading, data, error } = useTool('/tools/vmtools', scope ? { vcenterId: scope } : {});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;

  const upgrade = async (row) => {
    if (!window.confirm(`Tools 버전 '${row.version}' VM ${row.count}대를 업그레이드할까요? (재부팅이 필요할 수 있음)`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/vms/upgrade-tools', { ids: row.ids });
      setMsg({ ok: true, text: `업그레이드 요청: ${r.succeeded ?? r.requested}/${r.requested}건${r.mock ? ' (데모)' : ''}` });
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };

  const cols = [
    { key: 'version', label: 'Tools 버전', render: (r) => <b>{r.version}</b> },
    { key: 'count', label: 'VM 수', align: 'right' },
    { key: 'running', label: '정상', align: 'right' },
    { key: 'outdated', label: '오래됨', align: 'right', render: (r) => <span style={{ color: r.outdated ? 'var(--amber)' : undefined }}>{r.outdated}</span> },
    { key: 'act', label: '작업', sortable: false, render: (r) => <button className="tab" disabled={busy} onClick={() => upgrade(r)}>업그레이드</button> },
  ];
  return (
    <>
      {msg && <div style={{ marginBottom: 12, padding: '9px 12px', borderRadius: 8, fontSize: 13, background: msg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)', color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.text}</div>}
      <div className="muted" style={{ marginBottom: 10 }}>검사 VM <b style={{ color: 'var(--text)' }}>{data.scannedVms.toLocaleString()}</b> · 버전 {data.versions.length}종</div>
      <DataTable columns={cols} rows={data.versions} initialSort={{ key: 'count', dir: 'desc' }} />
    </>
  );
}

function Snapshots({ scope }) {
  const { loading, data, error } = useTool('/tools/snapshots', scope ? { vcenterId: scope } : {});
  const [detail, setDetail] = useState(null);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const cols = [
    { key: 'name', label: 'VM', render: (v) => <button className="cell-link" onClick={() => setDetail(v)}>{v.name}</button> },
    { key: 'vcenterId', label: 'vCenter', render: (v) => <span className="muted">{v.vcenterId}</span> },
    { key: 'host', label: '호스트', render: (v) => <span className="muted">{v.host}</span> },
    { key: 'snapshotCount', label: '개수', align: 'right' },
    { key: 'snapshotSizeGB', label: '용량', align: 'right', render: (v) => tb(v.snapshotSizeGB) },
    { key: 'powerState', label: '전원', render: (v) => <StateBadge state={v.powerState} /> },
  ];
  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="스냅샷 보유 VM" value={data.count} accent={data.count ? 'var(--amber)' : 'var(--green)'} />
        <Card label="총 스냅샷 용량" value={tb(data.totalSizeGB)} accent="var(--accent-2)" />
      </div>
      {data.items.length === 0 ? <div className="card" style={{ borderColor: 'var(--green)' }}><b style={{ color: 'var(--green)' }}>✓ 스냅샷이 있는 VM이 없습니다.</b></div>
        : <DataTable columns={cols} rows={data.items} initialSort={{ key: 'snapshotSizeGB', dir: 'desc' }} />}
      {detail && <EntityDetail type="vm" item={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

function Solutions() {
  const { loading, data, error } = useTool('/tools/solutions', {});
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>NSX 버전 분포</div>
      <div className="flex gap wrap" style={{ marginBottom: 14 }}>
        {data.nsxVersions.length === 0 && <span className="muted">NSX 정보 없음</span>}
        {data.nsxVersions.map((n) => <span key={n.version} className="badge blue" style={{ fontSize: 13, padding: '4px 10px' }}>NSX {n.version} · {n.count} vCenter</span>)}
      </div>
      <div className="section-title">vCenter별 설치 솔루션</div>
      <div className="grid cols-2">
        {data.items.map((it) => (
          <div className="card" key={it.vcenterId}>
            <div className="flex between" style={{ marginBottom: 8 }}>
              <b>{it.name}</b><span className="muted" style={{ fontSize: 12 }}>vCenter v{it.version || '—'}</span>
            </div>
            {it.nsx.length > 0 && <div style={{ marginBottom: 8 }}>{it.nsx.map((s) => <span key={s.key} className="badge green" style={{ marginRight: 6 }}>{s.label} {s.version}</span>)}</div>}
            <div className="table-wrap">
              <table>
                <thead><tr><th>솔루션</th><th>버전</th><th>공급사</th></tr></thead>
                <tbody>
                  {(it.solutions || []).slice(0, 30).map((s) => (
                    <tr key={s.key}><td>{/nsx/i.test(s.key + s.label) ? '🛡️ ' : ''}{s.label}</td><td className="tabular">{s.version || '—'}</td><td className="muted">{s.company || '—'}</td></tr>
                  ))}
                  {(it.solutions || []).length === 0 && <tr><td colSpan={3} className="muted center" style={{ padding: 14 }}>정보 없음</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function Licenses({ scope }) {
  const { loading, data, error } = useTool('/tools/licenses', scope ? { vcenterId: scope } : {});
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const cols = [
    { key: 'name', label: '라이선스', render: (l) => <b>{l.name}</b> },
    { key: 'vcenterName', label: 'vCenter', render: (l) => <span className="muted">{l.vcenterName}</span> },
    { key: 'productVersion', label: '버전' },
    { key: 'used', label: '사용', align: 'right' },
    { key: 'total', label: '총량', align: 'right' },
    { key: 'usePct', label: '사용률', sortValue: (l) => (l.total ? l.used / l.total : 0), render: (l) => <UsageCell pct={l.total ? Math.round((l.used / l.total) * 100) : 0} /> },
    { key: 'expires', label: '만료', render: (l) => <span style={{ color: isSoon(l.expires) ? 'var(--amber)' : undefined }}>{l.expires || '—'}</span> },
  ];
  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>제품별 합계</div>
      <div className="kpis" style={{ marginBottom: 14 }}>
        {data.byLicense.map((b) => <Card key={b.name} label={b.name} value={`${b.used}/${b.total}`} meta={b.productVersion ? `v${b.productVersion}` : ''} />)}
      </div>
      <DataTable columns={cols} rows={data.items} initialSort={{ key: 'used', dir: 'desc' }} />
    </>
  );
}
function isSoon(d) { if (!d) return false; const t = Date.parse(d); return t && t - Date.now() < 90 * 86400000; }

function Hba({ scope }) {
  const { loading, data, error } = useTool('/tools/hba', scope ? { vcenterId: scope } : {});
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const cols = [
    { key: 'host', label: '호스트', render: (h) => <b>{h.host}</b> },
    { key: 'vcenterId', label: 'vCenter', render: (h) => <span className="muted">{h.vcenterId}</span> },
    { key: 'name', label: '어댑터' },
    { key: 'type', label: '유형', render: (h) => <span className="badge gray">{h.type}</span> },
    { key: 'model', label: '모델', render: (h) => <span className="muted">{h.model}</span> },
    { key: 'speedGbps', label: '속도', align: 'right', render: (h) => <b style={{ color: h.speedGbps >= 32 ? 'var(--green)' : h.speedGbps >= 16 ? 'var(--text)' : 'var(--amber)' }}>{h.speedGbps} Gb</b> },
    { key: 'wwn', label: 'WWN', render: (h) => <span className="muted" style={{ fontSize: 11 }}>{h.wwn || '—'}</span> },
  ];
  return (
    <>
      <div className="flex gap wrap" style={{ marginBottom: 14 }}>
        <Card label="HBA 어댑터" value={data.adapters} meta={`호스트 ${data.hostsWithHba}`} />
        {data.speedDistribution.map((s) => <span key={s.speed} className="badge blue" style={{ alignSelf: 'center', fontSize: 13, padding: '4px 10px' }}>{s.speed} · {s.count}</span>)}
      </div>
      <DataTable columns={cols} rows={data.items} initialSort={{ key: 'speedGbps', dir: 'asc' }} />
    </>
  );
}

const GPU_MODE = { vgpu: ['vGPU', 'green'], passthrough: ['패스쓰루', 'amber'], vsga: ['vSGA', 'blue'] };
function GpuModeBadge({ mode, modes }) {
  const [label, cls] = GPU_MODE[mode] || ['—', 'gray'];
  // 한 호스트에 모드가 섞여 있으면 보조 표기.
  const extra = modes ? Object.entries(modes).filter(([k]) => k !== mode) : [];
  return (
    <span>
      <span className={`badge ${cls}`}>{label}</span>
      {extra.map(([k, n]) => <span key={k} className={`badge ${GPU_MODE[k]?.[1] || 'gray'}`} style={{ marginLeft: 4, opacity: 0.8 }}>{GPU_MODE[k]?.[0] || k} {n}</span>)}
    </span>
  );
}

function Gpu({ scope }) {
  const { loading, data, error } = useTool('/tools/gpu', scope ? { vcenterId: scope } : {});
  const [view, setView] = useState('host'); // host | cluster | vc
  const [hist, setHist] = useState(null);   // { level, key, days, points, synthesized }
  const [days, setDays] = useState(7);
  const openHist = async (level, key) => {
    setHist({ level, key, loading: true });
    const r = await fetchJson(`/tools/gpu/history?level=${level}&key=${encodeURIComponent(key)}&days=${days}`).catch(() => null);
    setHist(r ? { ...r } : { error: true });
  };
  const [mode, setMode] = useState(''); // '' | vgpu | passthrough | vsga
  useEffect(() => { if (hist && hist.key) openHist(hist.level, hist.key); /* eslint-disable-next-line */ }, [days]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;

  const items = mode ? data.items.filter((h) => h.mode === mode) : data.items;

  // Aggregate current utilization by cluster / vCenter from per-host items.
  const aggregate = (keyFn, labelFn) => {
    const m = new Map();
    for (const h of items) {
      if (h.utilPct == null) continue;
      const k = keyFn(h);
      const g = m.get(k) || { key: k, name: labelFn(h), hosts: 0, sum: 0, max: 0, gpus: 0 };
      g.hosts++; g.sum += h.utilPct; g.max = Math.max(g.max, h.utilPct); g.gpus += h.count; m.set(k, g);
    }
    return [...m.values()].map((g) => ({ key: g.key, name: g.name, sub: `${g.hosts} 호스트 · GPU ${g.gpus}`, avg: Math.round(g.sum / g.hosts), max: g.max, level: view }));
  };

  const hostRows = items.map((h) => ({
    key: h.id, name: h.host, vcenterId: h.vcenterId, sub: `${h.vcenterId} / ${h.cluster || '-'} · ${h.model}`,
    model: h.model, count: h.count, memGB: h.memGB, mode: h.mode, modes: h.modes, utilSource: h.utilSource, avg: h.utilPct, max: h.utilPct, util: h.utilPct, level: 'host',
  }));
  const rows = view === 'host' ? hostRows
    : view === 'cluster' ? aggregate((h) => `${h.vcenterId}|${h.cluster || 'standalone'}`, (h) => `${h.vcenterId} / ${h.cluster || 'standalone'}`)
      : aggregate((h) => h.vcenterId, (h) => h.vcenterId);

  const hostCols = [
    { key: 'name', label: '호스트', render: (r) => <button className="cell-link" onClick={() => openHist('host', r.key)}>{r.name}</button> },
    { key: 'vcenterId', label: 'vCenter', render: (r) => <span className="muted">{r.vcenterId}</span> },
    { key: 'model', label: 'GPU 모델' },
    { key: 'count', label: '개수', align: 'right' },
    { key: 'memGB', label: 'VRAM', align: 'right', render: (r) => `${r.memGB} GB` },
    { key: 'mode', label: '사용 방식', sortValue: (r) => r.mode, render: (r) => <GpuModeBadge mode={r.mode} modes={r.modes} /> },
    { key: 'util', label: '사용률', render: (r) => (r.util == null ? <span className="muted">—</span>
      : <span className="flex gap" style={{ alignItems: 'center' }}><UsageCell pct={r.util} />{r.utilSource === 'guest' && <span className="badge gray" style={{ fontSize: 10 }} title="게스트 OS에서 수집(패스쓰루)">게스트</span>}</span>) },
    { key: 'hist', label: '추이', render: (r) => <button className="tab" onClick={() => openHist('host', r.key)}>5년 추이</button> },
  ];
  const aggCols = [
    { key: 'name', label: view === 'cluster' ? '클러스터' : '법인', render: (r) => <button className="cell-link" onClick={() => openHist(r.level, r.key)}>{r.name}</button> },
    { key: 'sub', label: '구분', render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.sub}</span> },
    { key: 'avg', label: '평균 사용률', render: (r) => <UsageCell pct={r.avg} /> },
    { key: 'max', label: '최고 %', align: 'right', render: (r) => <b>{r.max}%</b> },
    { key: 'hist', label: '추이', render: (r) => <button className="tab" onClick={() => openHist(r.level, r.key)}>5년 추이</button> },
  ];

  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="총 GPU" value={data.totalGpus} accent="var(--accent)" meta={`GPU 호스트 ${data.hostsWithGpu}`} />
        <Card label="평균 GPU 사용률" value={data.avgUtilPct == null ? '—' : `${data.avgUtilPct}%`} meta={data.utilReporting ? `${data.utilReporting} 호스트 보고` : '사용률 미보고'} />
        <Card label="vGPU" value={data.byMode?.vgpu ?? 0} accent="var(--green)" meta="공유 다이렉트(GRID)" />
        <Card label="패스쓰루" value={data.byMode?.passthrough ?? 0} accent="var(--amber)" meta="DirectPath I/O" />
        {(data.byMode?.vsga ?? 0) > 0 && <Card label="vSGA" value={data.byMode.vsga} meta="공유(소프트)" />}
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>※ vGPU/vSGA는 ESXi가 사용률을 보고하지만, <b>패스쓰루(DirectPath I/O)</b>는 게스트 OS가 GPU를 직접 소유해 ESXi에서 사용률을 볼 수 없습니다(설정 › GPU 게스트 수집에서 게스트 OS 수집을 켜면 표시). 이름을 클릭하면 최근 5년 추이를 봅니다.</div>
      {data.items.length === 0 ? <div className="card"><span className="muted">GPU가 설치된 호스트가 없습니다.</span></div> : (
        <>
          <div className="flex gap wrap" style={{ marginBottom: 8 }}>
            {[['host', '호스트별'], ['cluster', '클러스터별'], ['vc', '법인별']].map(([k, l]) => (
              <button key={k} className={view === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView(k)}>{l}</button>
            ))}
            <span style={{ width: 12 }} />
            {[['', '전체'], ['vgpu', 'vGPU'], ['passthrough', '패스쓰루'], ['vsga', 'vSGA']].map(([k, l]) => (
              <button key={k || 'all'} className={mode === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 12px' }} onClick={() => setMode(k)}>
                {l} <b style={{ opacity: 0.7 }}>{k ? (data.byMode?.[k] ?? 0) : data.totalGpus}</b>
              </button>
            ))}
          </div>
          <DataTable columns={view === 'host' ? hostCols : aggCols} rows={rows} initialSort={{ key: view === 'host' ? 'count' : 'avg', dir: 'desc' }} />
        </>
      )}

      {hist && (
        <Modal title={`GPU 사용률 추이 — ${hist.key || ''}`} onClose={() => setHist(null)} width={760}>
          <div className="flex gap" style={{ marginBottom: 10 }}>
            {[[1, '1일'], [7, '1주'], [30, '1달'], [365, '1년'], [1830, '5년']].map(([d, l]) => (
              <button key={d} className={days === d ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '6px 12px', fontSize: 12 }} onClick={() => setDays(d)}>{l}</button>
            ))}
            {hist.synthesized && <span className="badge amber" style={{ alignSelf: 'center' }}>데모 합성</span>}
          </div>
          {hist.loading ? <Loading /> : hist.error ? <ErrorBox message="이력을 불러오지 못했습니다." /> : (hist.points || []).length === 0
            ? <div className="muted">해당 기간 데이터가 없습니다(수집 누적 후 표시).</div>
            : (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={(hist.points || []).map((p) => ({ t: new Date(p.ts).toLocaleDateString(), avg: p.avg, max: p.max }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" />
                  <XAxis dataKey="t" tick={{ fontSize: 11 }} minTickGap={40} />
                  <YAxis tick={{ fontSize: 11 }} unit="%" domain={[0, 100]} />
                  <Tooltip contentStyle={{ background: '#0b1220', border: '1px solid #243049', fontSize: 12 }} />
                  <Line type="monotone" dataKey="avg" stroke="#a78bfa" dot={false} name="평균" />
                  <Line type="monotone" dataKey="max" stroke="#f59e0b" dot={false} name="최고" />
                </LineChart>
              </ResponsiveContainer>
            )}
        </Modal>
      )}
    </>
  );
}
