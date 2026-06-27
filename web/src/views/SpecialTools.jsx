import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson, usePolling, getToken } from '../api.js';
import { DataTable, Loading, ErrorBox, StateBadge, UsageCell, EntityDetail, Modal, ResultCount, SearchBox, VmLink } from '../components/ui.jsx';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Brush } from 'recharts';
import { VmRemoteButton } from '../components/VmRemote.jsx';
import Topology3D from './Topology3D.jsx';
import { ServiceCheck, NetworkCheck, VmwareConfigBackup } from './DavinciChecks.jsx';
import NetTrafficAnalysis from './NetTrafficAnalysis.jsx';
import DeepSearch from './DeepSearch.jsx';
import { IdracDetailModal } from './IdracAdmin.jsx';
import VmProvision from './VmProvision.jsx';

// IP 확인 출처 배지: vCenter 인식 / Ping(TCP)스캔 / 둘 다
const DISCOVERY = { vcenter: ['vCenter', 'blue'], scan: ['Ping스캔', 'teal'], both: ['vCenter+스캔', 'green'], manual: ['수동등록', 'purple'] };
function DiscoveryBadge({ d }) {
  const m = DISCOVERY[d];
  if (!m) return <span className="muted">—</span>;
  const tip = d === 'both' ? 'vCenter 인벤토리 + 능동 스캔 양쪽에서 확인' : d === 'scan' ? '능동 스캔(Ping/TCP)으로만 확인'
    : d === 'manual' ? '운영자가 직접 등록한 IP(자동 발견 없음)' : 'vCenter 인벤토리에서 확인';
  return <span className={`badge ${m[1]}`} title={tip}>{m[0]}</span>;
}

// IP 수동 관리상태(override) 라벨/색 — 백엔드 overrides.js STATUSES와 일치.
const MGMT = {
  active: ['사용중(확정)', 'green'], reserved: ['예약', 'blue'], deprecated: ['폐기예정', 'gray'],
  dhcp: ['DHCP', 'amber'], static: ['고정할당', 'teal'], ignored: ['숨김', 'gray'],
};
function MgmtBadge({ s }) {
  const m = MGMT[s];
  if (!m) return null;
  return <span className={`badge ${m[1]}`} title="운영자가 지정한 IP 관리상태">{m[0]}</span>;
}
const DEVTYPE_LABEL = {
  vm: 'VM', host: 'ESXi', switch: '스위치', router: '라우터', firewall: '방화벽', storage: '스토리지',
  idrac: 'iDRAC', printer: '프린터', server: '서버', loadbalancer: 'LB', appliance: '어플라이언스', other: '기타',
};

const TOOLS = [
  { k: 'aisearch', icon: '🔎', label: 'AI 검색 (자연어)', desc: '자연어로 VM/호스트/IP 검색 · 로컬 LLM' },
  { k: 'insights', icon: '🧠', label: '운영 인사이트', desc: 'VM 라이트사이징 · 클러스터 N+1 여력 · 알람 핫스팟 · GPU 유휴' },
  { k: 'threats', icon: '🛡️', label: '위협 탐지', desc: '마이닝 의심 · 위험 포트 노출 · EOL OS · 신규 rogue IP · NSX IDS' },
  { k: 'vmfinder', icon: '🧭', label: 'VM 정밀 검색 / 유휴 VM', desc: '다수 vCenter·폴더·클러스터·풀 + 조건 · 1일/1주 평균 CPU로 미사용 VM' },
  { k: 'deepsearch', icon: '🔭', label: '심층 검색', desc: '게이트웨이·서브넷·GPU·OS 등 다조건 + 게스트 탐침(GPU드라이버·프로세스) · 전체/복수 vCenter' },
  { k: 'capacity', icon: '📈', label: '용량 리포트', desc: '클러스터별 여유·오버커밋·수용여력 · 전체/법인별' },
  { k: 'waste', icon: '♻️', label: '낭비 리소스', desc: '정지 VM·스냅샷·thin 회수가능·Tools 미설치' },
  { k: 'esxitemp', icon: '🌡️', label: 'ESXi 온도', desc: '호스트/클러스터/법인별 현재 온도 + 최근 5년 추이' },
  { k: 'forecast', icon: '🔮', label: '용량 추세/예측', desc: '데이터스토어 증가율·가득 찰 예상일' },
  { k: 'guestos', icon: '🐧', label: 'Guest OS 종류/버전', desc: 'OS·버전별 VM 수 · 전체/법인별 · 검색' },
  { k: 'real-os', icon: '🔎', label: '실제 OS 확인(게스트)', desc: '게스트 OS에서 실제 설치 OS(/etc/os-release 등) 읽기 · ESXi 보고와 불일치 탐지 · 주기 스캔 · CSV' },
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
  { k: 'powermap', icon: '⚡', label: '전력 분석 (법인/모델별)', desc: '측정된 모든 서버 소비전력을 법인(vCenter)·모델·지역별로 분해 · 미매핑 포함 · CSV' },
  { k: 'hba', icon: '🔌', label: 'HBA 카드 속도', desc: '호스트 FC/iSCSI 어댑터 속도' },
  { k: 'gpu', icon: '🎮', label: 'GPU 인벤토리', desc: '호스트/모델별 GPU + 사용률 최근 5년 추이' },
  { k: 'serveranalysis', icon: '🔬', label: '서버 분석', desc: 'iDRAC 수집 하드웨어 분석 · GPU 찾기(모델별 장수)' },
  { k: 'topo3d', icon: '🌐', label: '구성도 (3D)', desc: '설정된 구성을 3D 네트워크로 — 줌인/아웃·회전·VM 펼치기' },
  { k: 'davinci-svc', icon: '🩺', label: '다빈치 서비스 점검', desc: '포탈 내부 서비스/수집기(vCenter·NSX·전력·지표·GPU·알림·백업·에이전트) 상태 한눈에' },
  { k: 'net-check', icon: '📡', label: '글로벌 네트워크 점검', desc: '전세계 vCenter·NSX 제어플레인 도달성·RTT + 네트워크 객체 요약' },
  { k: 'net-traffic', icon: '🔬', label: '네트워크 트래픽 분석', desc: '두 서버 간 tcpdump 캡처·분석(핸드셰이크·재전송·RST) + 로그 자체 장애 탐지' },
  { k: 'vmware-backup', icon: '🗃️', label: 'VMware 구성 백업', desc: '사이트의 수집 구성(호스트·VM·DS·네트워크·NSX) 스냅샷 내보내기' },
  { k: 'portaldb', icon: '🗄️', label: '포탈 DB', desc: '사용 중 모든 DB/데이터 파일의 경로·파일명·용도·크기·증가 추이' },
  { k: 'diskadd', icon: '🧩', label: '디스크 추가 자동화', desc: 'VM 디스크 추가 할당 자동화 (준비 중)', disabled: true, comingSoon: true },
  { k: 'backup', icon: '💾', label: '백업', desc: '설정 백업/복원 (준비 중)', disabled: true, comingSoon: true },
  { k: 'massdeploy', icon: '🚀', label: '대용량 배포', desc: '대량 배포 (준비 중)', disabled: true, comingSoon: true },
  { k: 'shutdown', icon: '🛑', label: '긴급중단', desc: '모든 수집 즉시 정지 — 관리자 2명 OTP(2인 승인) 필요', danger: true },
  { k: 'vmprovision', icon: '🆕', label: 'VM 생성', desc: '템플릿/사양 지정으로 신규 VM 생성 (관리자)', adminOnly: true },
];

const tb = (gb) => (gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb} GB`);

// 응답을 파일로 저장. 서버가 Content-Disposition으로 준 파일명을 우선 사용(>1MB면 .zip).
async function saveResponseAsFile(res, fallbackName) {
  const cd = res.headers.get('content-disposition') || '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  const name = m ? decodeURIComponent(m[1]) : fallbackName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

// URL 해시(#/tools/<기능키>)에서 현재 도구 키를 읽는다(바로가기/북마크 지원).
const toolFromHash = () => {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/');
  const k = parts[0] === 'tools' ? parts[1] : '';
  return TOOLS.some((t) => t.k === k) ? k : null;
};

export default function SpecialTools() {
  const [tool, setTool] = useState(() => toolFromHash());
  const [menuQ, setMenuQ] = useState(''); // 메뉴 빠른 찾기
  const [isAdmin, setIsAdmin] = useState(false); // 관리자 전용 도구(VM 생성 등) 노출 제어
  const openTool = (k) => { setTool(k); window.location.hash = k ? `#/tools/${k}` : '#/tools'; };
  // 뒤로/앞으로 가기 및 외부에서 바로가기로 진입할 때 동기화.
  useEffect(() => {
    const onHash = () => setTool(toolFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => { fetchJson('/auth/me').then((r) => setIsAdmin(r.user?.role === 'admin')).catch(() => {}); }, []);
  if (tool) return <ToolPanel tool={tool} isAdmin={isAdmin} onBack={() => openTool(null)} />;
  const base = TOOLS.filter((t) => !t.adminOnly || isAdmin); // 관리자 전용은 admin에게만 노출
  const ql = menuQ.trim().toLowerCase();
  const shown = ql
    ? base.filter((t) => t.label.toLowerCase().startsWith(ql) || t.label.toLowerCase().includes(ql) || (t.desc || '').toLowerCase().includes(ql))
    : base;
  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>🛠️ 특수 기능</div>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 14 }}>
        <div className="muted" style={{ fontSize: 13 }}>아래 기능을 클릭하면 해당 진단을 실행해 보여줍니다.</div>
        <SearchBox className="input" style={{ maxWidth: 280 }} placeholder="메뉴 빠른 찾기 (예: G, GPU, IP)" value={menuQ} onChange={setMenuQ} />
      </div>
      <div className="vc-grid">
        {shown.length === 0 && <div className="muted" style={{ gridColumn: '1 / -1', padding: 24 }}>“{menuQ}”에 해당하는 메뉴가 없습니다.</div>}
        {shown.map((t) => (
          <div key={t.k} className="card vc-card"
            style={{
              cursor: t.disabled ? 'not-allowed' : 'pointer',
              opacity: t.disabled ? 0.5 : 1,
              ...(t.danger && !t.disabled ? { borderColor: 'var(--red)' } : {}),
            }}
            onClick={t.disabled ? undefined : () => openTool(t.k)}
            title={t.disabled ? (t.comingSoon ? '준비 중 (곧 제공)' : '비활성화됨 (관리자 전용)') : `바로가기: #/tools/${t.k}`}>
            <div style={{ fontSize: 30, filter: t.disabled ? 'grayscale(1)' : 'none' }}>{t.icon}</div>
            <div className="vc-name" style={{ marginTop: 8, ...(t.danger && !t.disabled ? { color: 'var(--red)' } : {}) }}>{t.label}</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{t.desc}</div>
            <div className="vc-foot"><span className="muted">{t.disabled ? (t.comingSoon ? '준비 중' : '비활성화됨') : '클릭하여 실행'}</span><span className="muted">{t.disabled ? '' : '→'}</span></div>
          </div>
        ))}
      </div>
    </>
  );
}

function ToolPanel({ tool, onBack, isAdmin }) {
  const meta = TOOLS.find((t) => t.k === tool);
  const [scope, setScope] = useState('');
  const { data: vcList } = usePolling('/vcenters', {}, 60_000);
  const scoped = ['ipam', 'dupip', 'vmtools', 'snapshots', 'hba', 'gpu', 'licenses', 'esxi', 'hardware', 'powermap', 'guestos', 'real-os', 'thinvms', 'capacity', 'waste', 'esxitemp', 'forecast'].includes(tool);

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
      {tool === 'insights' && <Insights scope={scope} />}
      {tool === 'threats' && <Threats scope={scope} />}
      {tool === 'vmfinder' && <VmFinder />}
      {tool === 'capacity' && <Capacity scope={scope} />}
      {tool === 'waste' && <Waste scope={scope} />}
      {tool === 'esxitemp' && <EsxiTemp scope={scope} />}
      {tool === 'forecast' && <Forecast scope={scope} />}
      {tool === 'guestos' && <GuestOs scope={scope} />}
      {tool === 'real-os' && <RealOs scope={scope} />}
      {tool === 'thinvms' && <ThinVms scope={scope} />}
      {tool === 'ipam' && <Ipam scope={scope} onScope={setScope} />}
      {tool === 'dupip' && <DupIp scope={scope} />}
      {tool === 'vmtools' && <VmTools scope={scope} />}
      {tool === 'snapshots' && <Snapshots scope={scope} />}
      {tool === 'solutions' && <Solutions />}
      {tool === 'licenses' && <Licenses scope={scope} />}
      {tool === 'hba' && <Hba scope={scope} />}
      {tool === 'gpu' && <Gpu scope={scope} />}
      {tool === 'serveranalysis' && <ServerAnalysis />}
      {tool === 'hardware' && <Hardware scope={scope} />}
      {tool === 'powermap' && <PowerMap scope={scope} />}
      {tool === 'esxi' && <Esxi scope={scope} />}
      {tool === 'vcversion' && <VcVersion />}
      {tool === 'nsx' && <Nsx />}
      {tool === 'topo3d' && <Topology3D />}
      {tool === 'davinci-svc' && <ServiceCheck />}
      {tool === 'net-check' && <NetworkCheck />}
      {tool === 'net-traffic' && <NetTrafficAnalysis />}
      {tool === 'deepsearch' && <DeepSearch />}
      {tool === 'vmware-backup' && <VmwareConfigBackup />}
      {tool === 'portaldb' && <PortalDb />}
      {tool === 'shutdown' && <Shutdown />}
      {tool === 'vmprovision' && (isAdmin ? <VmProvision /> : <div className="card"><span className="muted">관리자 전용 기능입니다.</span></div>)}
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

  const ROWBG = { used: 'rgba(34,197,94,.12)', multihomed: 'rgba(59,130,246,.14)', duplicate: 'rgba(239,68,68,.14)', network: 'rgba(148,163,184,.14)', released: 'rgba(245,158,11,.13)', scanned: 'rgba(20,184,166,.14)', empty: 'transparent' };
  const STLAB = { used: '사용', multihomed: '멀티홈', duplicate: '중복', network: 'Network ID', released: '해제(이력)', scanned: '스캔 확인', empty: '' };

  // reconcile(출처 대조) 집계 — vCenter 수집 IP와 스캔/수동 IP를 한눈에 대조.
  const recon = { vcenter: 0, scan: 0, both: 0, manual: 0, conflict: 0, managed: 0 };
  for (const r of data.rows) {
    if (recon[r.reconcile] !== undefined) recon[r.reconcile]++;
    if (r.managed) recon.managed++;
  }

  const term = q.trim().toLowerCase();
  const rows = data.rows.filter((r) => {
    if (rowFilter === 'duplicate' && !r.duplicate) return false;
    if (rowFilter === 'multihomed' && !r.multiHomed) return false;
    if (rowFilter === 'public' && r.scope !== 'public') return false;
    if (rowFilter === 'private' && r.scope !== 'private') return false;
    if (reconFilter === 'managed' && !r.managed) return false;
    if (reconFilter && reconFilter !== 'managed' && r.reconcile !== reconFilter) return false;
    if (term && !(r.ip.includes(term) || (r.ownerName || '').toLowerCase().includes(term) || (r.hostName || '').toLowerCase().includes(term) || (r.label || '').toLowerCase().includes(term) || (r.owner_ || '').toLowerCase().includes(term) || (r.note || '').toLowerCase().includes(term))) return false;
    return true;
  });
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
        {r.deviceType && <span className="badge gray" style={{ fontSize: 10 }}>{DEVTYPE_LABEL[r.deviceType] || r.deviceType}</span>}
        {r.reservedUntil && <span className="muted" style={{ fontSize: 10 }} title={`예약 만료: ${new Date(r.reservedUntil).toLocaleString()}`}>⏳</span>}
        {canManage && <button className="tab" style={{ padding: '1px 7px', fontSize: 11 }} title="IP 관리상태 편집(담당자·예약·디바이스 종류 등)" onClick={() => setEditOv(r)}>{r.managed ? '✎' : '+'}</button>}
      </span>
    ) },
    { key: 'ownerName', label: '소유 자원', sortValue: (r) => r.displayName || r.ownerName || '', render: (r) => (r.owner ? <button className="cell-link" onClick={() => setSel({ ownerType: r.ownerType, owner: r.owner })}>{r.label || r.ownerName}</button> : <span>{r.label || r.ownerName}{r.owner_ ? <span className="muted" style={{ fontSize: 11 }}> · 👤{r.owner_}</span> : ''}{(r.services || []).length ? <span className="muted" style={{ fontSize: 11 }}> · {(r.services || []).join(',')}</span> : ''}</span>) },
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
          {view === 'list' && <SearchBox className="input" style={{ maxWidth: 260 }} placeholder="IP / VM / 호스트 검색" value={q} onChange={setQ} />}
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
                          <td className="muted" style={{ fontSize: 12 }}>{r.status === 'released' ? <span className="badge amber">해제</span> : r.status === 'scanned' ? <span className="badge teal" title="vCenter가 모르는 IP를 능동 스캔으로 확인">🛰 스캔 확인</span> : STLAB[r.status]}</td>
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
              ['managed', `관리상태 지정됨 (${recon.managed})`, 'amber']].map(([k, label]) => (
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
      {sel && <EntityDetail type={sel.ownerType} item={sel.owner} onClose={() => setSel(null)} />}
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
function IpHistoryModal({ row, scope, onClose }) {
  const ip = row.ip;
  const hostname = row.hostname;
  const [h, setH] = useState(undefined);
  const [showDetail, setShowDetail] = useState(false);
  // VM/호스트 소유 IP면 그 자원으로, 스캔 IP면 IP만으로 원격 접속 대상 구성.
  const remoteItem = row.owner || { name: hostname || ip, ipAddresses: [ip], vcenterId: row.vcenterId || scope || '' };
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
        {row.owner && <button className="logout-btn" style={{ padding: '8px 14px' }} onClick={() => setShowDetail(true)}>🖥 VM 정보 보기</button>}
        <VmRemoteButton item={remoteItem} />
        {!row.owner && <span className="muted" style={{ fontSize: 12 }}>스캔으로 확인된 IP — 원격 접속은 IP로 직접 연결합니다.</span>}
      </div>
      {showDetail && row.owner && <EntityDetail type={row.ownerType} item={row.owner} onClose={() => setShowDetail(false)} />}
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

/** vCenter별 IP 대역 저장 + 주기 스캔 + 스캔결과(첨부) 다운로드. */
function IpamRanges() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [vc, setVc] = useState('');
  const [ranges, setRanges] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const authHdr = () => (getToken() ? { Authorization: `Bearer ${getToken()}` } : {});
  const load = async () => { try { setData(await fetchJson('/tools/ipam/vc-ranges')); setError(null); } catch (e) { setError(e.message); } };
  const loadStatus = () => fetchJson('/admin/ipam/scan/status').then(setStatus).catch(() => setStatus(null));
  useEffect(() => { load(); loadStatus(); const t = setInterval(loadStatus, 3000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!data) return;
    const e = (data.ranges || []).find((x) => x.vcenterId === vc);
    setRanges(e ? (e.ranges || []).join('\n') : ''); setEnabled(e ? e.enabled !== false : true);
  }, [vc, data]);
  const save = async () => {
    if (!vc) { setMsg({ ok: false, text: 'vCenter를 선택하세요.' }); return; }
    setBusy(true); setMsg(null);
    try { const r = await putJson('/admin/ipam/vc-ranges', { vcenterId: vc, ranges, enabled }); setMsg(r.ok ? { ok: true, text: `저장됨 — 대역 ${(r.ranges || []).length}개` } : { ok: false, text: r.reason }); if (r.ok) await load(); }
    catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  const scanNow = async () => {
    setBusy(true); setMsg(null);
    try { const r = await postJson('/admin/ipam/vc-ranges/scan', {}); setMsg(r.ok ? { ok: true, text: '스캔을 시작했습니다(백그라운드). 잠시 후 결과가 갱신됩니다.' } : { ok: false, text: r.reason }); loadStatus(); }
    catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  const removeVc = async (id) => {
    if (!window.confirm(`'${id}' 대역을 삭제할까요?`)) return;
    try { await fetch(`/api/admin/ipam/vc-ranges/${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHdr() }); await load(); } catch (e) { setMsg({ ok: false, text: e.message }); }
  };
  const downloadReport = async () => {
    const res = await fetch('/api/tools/ipam/scan-report.csv', { headers: authHdr() });
    const blob = await res.blob(); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `ip-scan-report-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url);
  };
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  const fmtDt = (t) => (t ? new Date(t).toLocaleString('ko-KR') : '—');
  const list = data.ranges || [];
  const runs = status?.runs || [];
  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <b style={{ fontSize: 14 }}>vCenter별 스캔 대역</b>
        <div className="muted" style={{ fontSize: 12, margin: '4px 0 10px' }}>vCenter(법인)에 IP 대역을 저장하면 주기 스캔이 이 대역들을 함께 스캔해 사용 현황을 갱신합니다. 형식: CIDR(10.0.0.0/24)·범위(10.0.0.1-50)·단일 IP, 한 줄에 하나.</div>
        <div className="flex gap wrap" style={{ alignItems: 'flex-start' }}>
          <label style={{ minWidth: 200 }}>vCenter
            <select className="input" value={vc} onChange={(e) => setVc(e.target.value)}>
              <option value="">(선택)</option>
              {(data.vcenters || []).map((v) => <option key={v.id} value={v.id}>{v.name || v.id}</option>)}
            </select>
          </label>
          <label style={{ flex: 1, minWidth: 280 }}>대역 (한 줄에 하나)
            <textarea className="input" style={{ width: '100%', minHeight: 110, fontFamily: 'monospace', fontSize: 12 }} value={ranges} onChange={(e) => setRanges(e.target.value)} placeholder={'10.0.0.0/24\n192.168.1.1-192.168.1.50'} />
          </label>
        </div>
        <div className="flex gap" style={{ marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> 주기 스캔 포함</label>
          <button className="login-btn" style={{ flex: 'none', padding: '9px 16px' }} disabled={busy || !vc} onClick={save}>저장</button>
          <button className="logout-btn" style={{ padding: '9px 14px' }} disabled={busy || status?.running} onClick={scanNow}>🛰️ 지금 스캔(전체)</button>
          <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={downloadReport} title="현재 스캔 결과를 CSV 첨부파일로 내려받기">⬇ 스캔 결과(CSV)</button>
        </div>
        {status?.running && <div style={{ marginTop: 10 }}><ScanProgressBar progress={status.progress} /></div>}
        {msg && <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, fontSize: 13, background: msg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)', color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.text}</div>}
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <b style={{ fontSize: 14 }}>저장된 대역 ({list.length})</b>
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table><thead><tr><th>vCenter</th><th>대역</th><th className="right">IP 수</th><th>주기</th><th>수정시각</th><th className="right">작업</th></tr></thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={6} className="center muted" style={{ padding: 18 }}>등록된 대역이 없습니다.</td></tr>}
              {list.map((e) => (
                <tr key={e.vcenterId}>
                  <td><b>{e.vcenterName}</b></td>
                  <td className="muted" style={{ fontFamily: 'monospace', fontSize: 12 }}>{(e.ranges || []).join(', ')}</td>
                  <td className="right">{(e.ipCount || 0).toLocaleString()}</td>
                  <td>{e.enabled ? <span className="badge green">포함</span> : <span className="badge gray">제외</span>}</td>
                  <td className="muted">{fmtDt(e.updatedAt)}</td>
                  <td className="right nowrap">
                    <button className="tab" onClick={() => setVc(e.vcenterId)}>수정</button>
                    <button className="tab" style={{ color: 'var(--red)' }} onClick={() => removeVc(e.vcenterId)}>삭제</button>
                  </td>
                </tr>
              ))}
            </tbody></table>
        </div>
      </div>

      <div className="card">
        <div className="flex between wrap" style={{ alignItems: 'center' }}>
          <b style={{ fontSize: 14 }}>완료된 스캔 (첨부)</b>
          <button className="logout-btn" style={{ padding: '7px 12px' }} onClick={downloadReport}>⬇ 전체 결과 CSV</button>
        </div>
        <div className="table-wrap" style={{ marginTop: 8, maxHeight: '40vh' }}>
          <table><thead><tr><th>완료시각</th><th>에이전트</th><th className="right">스캔/응답</th><th className="right">소요</th></tr></thead>
            <tbody>
              {runs.length === 0 && <tr><td colSpan={4} className="center muted" style={{ padding: 18 }}>완료된 스캔 기록이 없습니다. ‘지금 스캔’으로 실행하세요.</td></tr>}
              {runs.map((r, i) => (
                <tr key={i}>
                  <td className="muted">{fmtDt(r.at)}</td>
                  <td>{r.agent === '__local__' ? '이 포탈' : r.agent}</td>
                  <td className="right">{(r.scanned || 0).toLocaleString()} / <b style={{ color: 'var(--green)' }}>{(r.alive || 0).toLocaleString()}</b></td>
                  <td className="right muted">{r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}</td>
                </tr>
              ))}
            </tbody></table>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>스캔 결과는 ‘⬇ 스캔 결과(CSV)’로 첨부파일처럼 내려받을 수 있습니다(IP·호스트명·상태·포트·서비스·최초/최근 관측).</div>
      </div>
    </>
  );
}

/** 네트워크 맵 — 대역(/24) 선택 시 OS별(색) × 시간대별(타임 슬라이더) 사용/미사용 격자. */
function IpamNetMap() {
  const [vcs, setVcs] = useState([]);
  const [vc, setVc] = useState('');
  const [base, setBase] = useState('');
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [bucket, setBucket] = useState(null); // null = 최신
  const [sel, setSel] = useState(null);
  useEffect(() => { fetchJson('/tools/ipam/vc-ranges').then((d) => setVcs(d.vcenters || [])).catch(() => {}); }, []);
  useEffect(() => {
    const qs = new URLSearchParams();
    if (vc) qs.set('vcenterId', vc); if (base) qs.set('base', base); qs.set('days', String(days)); qs.set('buckets', '32');
    fetchJson(`/tools/ipam/netmap?${qs.toString()}`).then((d) => { setData(d); setError(null); setSel(null); if (!base && d.base) setBase(d.base); }).catch((e) => setError(e.message));
    // eslint-disable-next-line
  }, [vc, base, days]);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  const N = data.buckets?.length || 0;
  const bi = bucket == null ? Math.max(0, N - 1) : Math.min(bucket, N - 1);
  const fmtDt = (t) => (t ? new Date(t).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  const cellStyle = (cell) => {
    const st = cell.states?.[bi];
    if (!cell.present) return { background: 'rgba(148,163,184,.07)', border: '1px solid rgba(148,163,184,.13)' };
    const c = cell.color || '#64748b';
    if (st === 1) return { background: c, border: `1px solid ${c}` };
    if (st === 0) return { background: `${c}44`, border: `1px solid ${c}77` };
    return { background: 'transparent', border: `1px ${cell.guessed ? 'dashed' : 'solid'} ${c}66` };
  };
  const s = data.summary || {};
  return (
    <>
      <div className="flex gap wrap" style={{ marginBottom: 10, alignItems: 'center' }}>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}><span className="muted">vCenter</span>
          <select className="select" value={vc} onChange={(e) => { setVc(e.target.value); setBase(''); }}>
            <option value="">전체</option>
            {vcs.map((v) => <option key={v.id} value={v.id}>{v.name || v.id}</option>)}
          </select>
        </label>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}><span className="muted">대역(/24)</span>
          <select className="select" value={base} onChange={(e) => setBase(e.target.value)}>
            {(data.bases || []).map((b) => <option key={b} value={b}>{b}.0/24</option>)}
            {(!data.bases || data.bases.length === 0) && <option value="">(대역 없음)</option>}
          </select>
        </label>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}><span className="muted">기간</span>
          <select className="select" value={days} onChange={(e) => { setDays(Number(e.target.value)); setBucket(null); }}>
            {[7, 30, 90, 180, 365].map((d) => <option key={d} value={d}>최근 {d}일</option>)}
          </select>
        </label>
      </div>

      {!data.base ? (
        <div className="card"><span className="muted">표시할 대역이 없습니다. ‘🗂️ 대역·스캔’에서 vCenter 대역을 등록하거나 스캔을 실행하세요.</span></div>
      ) : (
        <>
          <div className="flex gap wrap" style={{ marginBottom: 10 }}>
            <Card label="대역" value={data.cidr} meta={`${s.total}개 주소`} />
            <Card label="사용 이력 IP" value={(s.everUsed || 0).toLocaleString()} meta={`현재 응답 ${s.currentlyUp || 0}`} accent="var(--green)" />
            <Card label="빈 IP" value={(s.neverSeen || 0).toLocaleString()} meta="미관측" />
          </div>

          {/* 타임 슬라이더 */}
          <div className="card" style={{ marginBottom: 10, padding: '10px 14px' }}>
            <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 6 }}>
              <b style={{ fontSize: 13 }}>⏱ 시점: {fmtDt(data.buckets[bi])} {bucket == null && <span className="muted">(최신)</span>}</b>
              <div className="flex gap">
                <button className="tab" disabled={bi <= 0} onClick={() => setBucket(Math.max(0, bi - 1))}>◀</button>
                <button className="tab" disabled={bi >= N - 1} onClick={() => setBucket(Math.min(N - 1, bi + 1))}>▶</button>
                <button className="tab" onClick={() => setBucket(null)}>최신</button>
              </div>
            </div>
            <input type="range" min={0} max={Math.max(0, N - 1)} value={bi} onChange={(e) => setBucket(Number(e.target.value))} style={{ width: '100%' }} />
            <div className="flex between" style={{ fontSize: 11 }}><span className="muted">{fmtDt(data.buckets[0])}</span><span className="muted">{fmtDt(data.buckets[N - 1])}</span></div>
          </div>

          {/* 범례 */}
          <div className="flex gap wrap" style={{ marginBottom: 8, fontSize: 12, alignItems: 'center' }}>
            <span className="muted">OS:</span>
            {(data.osLegend || []).map((o) => <span key={o.key} className="flex gap" style={{ alignItems: 'center' }}><span style={{ width: 12, height: 12, borderRadius: 3, background: o.color, display: 'inline-block' }} /> {o.key} {o.count}</span>)}
            <span className="muted" style={{ marginLeft: 8 }}>· 상태:</span>
            <span className="flex gap" style={{ alignItems: 'center' }}><span style={{ width: 12, height: 12, borderRadius: 3, background: '#16a34a', display: 'inline-block' }} /> 사용</span>
            <span className="flex gap" style={{ alignItems: 'center' }}><span style={{ width: 12, height: 12, borderRadius: 3, background: '#16a34a44', display: 'inline-block' }} /> 미사용</span>
            <span className="flex gap" style={{ alignItems: 'center' }}><span style={{ width: 12, height: 12, borderRadius: 3, border: '1px dashed #16a34a66', display: 'inline-block' }} /> 미관측</span>
          </div>

          {/* 격자 (.1 ~ .254) */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(22px, 1fr))', gap: 3, marginBottom: 12 }}>
            {data.cells.map((cell) => (
              <div key={cell.ip} onClick={() => setSel(cell)} title={`${cell.ip}${cell.host ? ` · ${cell.host}` : ''}${cell.os ? ` · ${cell.os}` : ''} · ${cell.present ? (cell.states[bi] === 1 ? '사용' : cell.states[bi] === 0 ? '미사용' : '미관측') : '빈 IP'}`}
                style={{ aspectRatio: '1 / 1', borderRadius: 4, cursor: 'pointer', ...cellStyle(cell), outline: sel?.ip === cell.ip ? '2px solid var(--text)' : 'none', fontSize: 9, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                {cell.present && cell.states[bi] === 1 ? Number(cell.ip.split('.')[3]) : ''}
              </div>
            ))}
          </div>

          {sel && (
            <div className="card" style={{ marginBottom: 10 }}>
              <div className="flex between"><b>{sel.ip}</b><button className="logout-btn" onClick={() => setSel(null)}>닫기</button></div>
              <div className="spec-grid" style={{ marginTop: 8, fontSize: 13 }}>
                <div><span className="muted">호스트명</span><div>{sel.host || '—'}</div></div>
                <div><span className="muted">OS</span><div>{sel.os || '—'} {sel.guessed && <span className="badge gray">추정</span>}</div></div>
                <div><span className="muted">vCenter</span><div>{sel.vcenterName || '—'}</div></div>
                <div><span className="muted">상태</span><div>{sel.status || '—'}</div></div>
                <div><span className="muted">최초 관측</span><div>{fmtDt(sel.firstSeen)}</div></div>
                <div><span className="muted">최근 관측</span><div>{fmtDt(sel.lastSeen)}</div></div>
              </div>
              {/* 미니 타임라인(전체 버킷 사용/미사용 스트립) */}
              <div style={{ marginTop: 10 }}>
                <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>사용 추이(왼쪽=과거 → 오른쪽=현재)</div>
                <div style={{ display: 'flex', gap: 2 }}>
                  {sel.states.map((st, i) => <div key={i} title={fmtDt(data.buckets[i])} style={{ flex: 1, height: 18, borderRadius: 2, background: st === 1 ? (sel.color || '#16a34a') : st === 0 ? `${sel.color || '#16a34a'}44` : 'rgba(148,163,184,.12)', outline: i === bi ? '1px solid var(--text)' : 'none' }} />)}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </>
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

/**
 * IP 수동 관리(override) 편집기 — vCenter/스캔으로 자동 발견되는 정보와 별개로, 운영자가
 * IP 단위로 관리상태(예약/폐기/고정 등)·담당자·라벨·디바이스 종류·예약 만료·vCenter 귀속을
 * 지정한다. 신규(빈 IP)면 IP 직접 입력 + 콤마/줄바꿈으로 여러 IP 일괄 적용도 가능.
 */
function OverrideEditor({ row, vcenters = [], onClose, onSaved }) {
  const isNew = !!row.__new;
  const [ip, setIp] = useState(row.ip || '');
  const [meta, setMeta] = useState(null);
  const [status, setStatus] = useState(row.mgmtStatus || '');
  const [owner, setOwner] = useState(row.owner_ || '');
  const [label, setLabel] = useState(row.label || '');
  const [deviceType, setDeviceType] = useState(row.deviceType || '');
  const [hostnameOverride, setHostnameOverride] = useState((row.managed && row.hostName) || '');
  const [claimedVcenterId, setClaimedVcenterId] = useState(row.vcenterId || '');
  const [reservedUntil, setReservedUntil] = useState(row.reservedUntil ? String(row.reservedUntil).slice(0, 10) : '');
  const [note, setNote] = useState(row.note || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { fetchJson('/tools/ipam/manage-meta').then(setMeta).catch(() => setMeta({ statuses: Object.keys(MGMT), deviceTypes: Object.keys(DEVTYPE_LABEL) })); }, []);
  // 기존 IP면 서버에서 현재 override를 한 번 더 정확히 불러와 폼을 채운다(목록값 보강).
  useEffect(() => {
    if (isNew || !row.ip) return;
    fetchJson(`/tools/ipam/ip/${encodeURIComponent(row.ip)}`).then((r) => {
      const o = r.override; if (!o) return;
      setStatus(o.status || ''); setOwner(o.owner || ''); setLabel(o.label || '');
      setDeviceType(o.deviceType || ''); setHostnameOverride(o.hostnameOverride || '');
      setClaimedVcenterId(o.claimedVcenterId || ''); setNote(o.note || '');
      setReservedUntil(o.reservedUntil ? String(o.reservedUntil).slice(0, 10) : '');
    }).catch(() => {});
  }, [row.ip, isNew]);

  const ipList = String(ip).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const bulk = ipList.length > 1;
  const fields = { status, owner, label, deviceType, hostnameOverride, claimedVcenterId, note, reservedUntil: reservedUntil || null };
  const save = async () => {
    if (!ipList.length) { setErr('IP를 입력하세요.'); return; }
    setBusy(true); setErr(null);
    let r;
    if (bulk) r = await postJson('/tools/ipam/bulk', { ips: ipList, ...fields }).catch((e) => ({ ok: false, reason: e.message }));
    else r = await putJson(`/tools/ipam/ip/${encodeURIComponent(ipList[0])}`, fields).catch((e) => ({ ok: false, reason: e.message }));
    setBusy(false);
    if (r.ok) onSaved(); else setErr(r.reason || '저장 실패');
  };
  const remove = async () => {
    if (!ipList.length || bulk) return;
    setBusy(true); setErr(null);
    const r = await fetch(`/api/tools/ipam/ip/${encodeURIComponent(ipList[0])}`, { method: 'DELETE', headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} }).then((x) => x.json()).catch((e) => ({ ok: false, reason: e.message }));
    setBusy(false);
    if (r.ok) onSaved(); else setErr(r.reason || '삭제 실패');
  };

  const L = { fontWeight: 600, paddingTop: 9, whiteSpace: 'nowrap' };
  const statuses = meta?.statuses || Object.keys(MGMT);
  const devTypes = meta?.deviceTypes || Object.keys(DEVTYPE_LABEL);
  return (
    <Modal title={isNew ? 'IP 수동 등록 / 일괄 관리' : `IP 관리상태 — ${row.ip}`} onClose={onClose} width={760} resizable minWidth={520} minHeight={440}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        vCenter 수집·스캔으로 자동 채워지는 값과 <b>별개로</b> 운영자가 직접 지정하는 관리 정보입니다(수집 갱신에도 유지).
        {isNew && ' 여러 IP를 콤마/줄바꿈으로 넣으면 한 번에 같은 상태로 일괄 적용됩니다.'}
      </div>
      {err && <div className="login-error" style={{ marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 16, rowGap: 14, alignItems: 'start' }}>
        <label style={L}>IP{isNew && <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}> (여러 개 가능)</span>}</label>
        {isNew
          ? <textarea className="input" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="예: 10.20.0.5  또는  10.20.0.5, 10.20.0.6" style={{ resize: 'vertical', minHeight: 56, width: '100%', boxSizing: 'border-box' }} />
          : <input className="input" value={ip} disabled style={{ width: '100%', boxSizing: 'border-box', opacity: .8 }} />}

        <label style={L}>관리상태</label>
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: '100%' }}>
          <option value="">— 미지정 —</option>
          {statuses.map((s) => <option key={s} value={s}>{(MGMT[s]?.[0]) || s}</option>)}
        </select>

        <label style={L}>디바이스 종류</label>
        <select className="select" value={deviceType} onChange={(e) => setDeviceType(e.target.value)} style={{ width: '100%' }}>
          <option value="">— 미지정 —</option>
          {devTypes.map((d) => <option key={d} value={d}>{DEVTYPE_LABEL[d] || d}</option>)}
        </select>

        <label style={L}>담당자/팀</label>
        <input className="input" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="예: 인프라팀 / 홍길동" style={{ width: '100%', boxSizing: 'border-box' }} />

        <label style={L}>라벨(표시명)</label>
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="자동 호스트명 대신 표시할 이름" style={{ width: '100%', boxSizing: 'border-box' }} />

        <label style={L}>호스트명 override</label>
        <input className="input" value={hostnameOverride} onChange={(e) => setHostnameOverride(e.target.value)} placeholder="자동 수집 호스트명을 덮어쓸 이름(선택)" style={{ width: '100%', boxSizing: 'border-box' }} />

        <label style={L}>vCenter 귀속</label>
        <select className="select" value={claimedVcenterId} onChange={(e) => setClaimedVcenterId(e.target.value)} style={{ width: '100%' }}>
          <option value="">— 없음(네트워크) —</option>
          {vcenters.filter((v) => v.vcenterId).map((v) => <option key={v.vcenterId} value={v.vcenterId}>{v.vcenterName}</option>)}
        </select>

        <label style={L}>예약 만료일</label>
        <input className="input" type="date" value={reservedUntil} onChange={(e) => setReservedUntil(e.target.value)} style={{ width: 200, boxSizing: 'border-box' }} />

        <label style={L}>비고</label>
        <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="상태 관련 한 줄 메모(상세 메모/태그는 목록의 '메모·태그' 사용)" style={{ resize: 'vertical', minHeight: 56, width: '100%', boxSizing: 'border-box' }} />

        <div />
        <div className="flex gap" style={{ marginTop: 4, alignItems: 'center' }}>
          <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={busy} onClick={save}>{busy ? '저장 중…' : (bulk ? `일괄 적용 (${ipList.length}개)` : '저장')}</button>
          <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={onClose}>취소</button>
          {!isNew && row.managed && <button className="logout-btn" style={{ padding: '9px 14px', marginLeft: 'auto', color: 'var(--red)' }} disabled={busy} onClick={remove} title="관리상태 삭제(자동 발견 상태로 되돌림)">관리상태 삭제</button>}
        </div>
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 12, lineHeight: 1.7 }}>
        ※ 관리상태를 <b>숨김</b>으로 두면 대장 목록에서 해당 IP가 제외됩니다(오탐/사용 안 함 IP 정리용).
      </div>
    </Modal>
  );
}

function IpmsSettings({ onClose }) {
  const [s, setS] = useState(null);
  const [vcs, setVcs] = useState([]);
  const [vc, setVc] = useState('');
  const [msg, setMsg] = useState(null);
  // vCenter별 스캔 대역(사전 정리 + 주기 스캔) — rangeStore(/vc-ranges) 백엔드 재사용.
  const [vcRanges, setVcRanges] = useState(null);
  const [scanText, setScanText] = useState('');
  const [scanEnabled, setScanEnabled] = useState(true);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanMsg, setScanMsg] = useState(null);
  const loadVcRanges = () => fetchJson('/tools/ipam/vc-ranges').then(setVcRanges).catch(() => {});
  useEffect(() => {
    fetchJson('/admin/ipam/settings').then((r) => setS(r.settings)).catch((e) => setMsg(e.message));
    fetchJson('/vcenters').then((list) => { setVcs(list); if (list[0]) setVc(list[0].id); }).catch(() => {});
    loadVcRanges();
  }, []);
  // 선택한 vCenter의 저장된 스캔 대역을 폼에 채운다.
  useEffect(() => {
    if (!vcRanges) return;
    const e = (vcRanges.ranges || []).find((x) => x.vcenterId === vc);
    setScanText(e ? (e.ranges || []).join('\n') : '');
    setScanEnabled(e ? e.enabled !== false : true);
  }, [vc, vcRanges]);
  const saveScanRanges = async () => {
    if (!vc) return;
    setScanBusy(true); setScanMsg(null);
    try {
      const r = await putJson('/admin/ipam/vc-ranges', { vcenterId: vc, ranges: scanText, enabled: scanEnabled });
      setScanMsg(r.ok ? { ok: true, text: `저장됨 — 대역 ${(r.ranges || []).length}개` } : { ok: false, text: r.reason });
      if (r.ok) await loadVcRanges();
    } catch (e) { setScanMsg({ ok: false, text: e.message }); } finally { setScanBusy(false); }
  };
  const scanNow = async () => {
    setScanBusy(true); setScanMsg(null);
    try { const r = await postJson('/admin/ipam/vc-ranges/scan', {}); setScanMsg(r.ok ? { ok: true, text: '스캔을 시작했습니다(백그라운드).' } : { ok: false, text: r.reason }); }
    catch (e) { setScanMsg({ ok: false, text: e.message }); } finally { setScanBusy(false); }
  };
  if (!s) return <Modal title="IPMS 설정" onClose={onClose}>{msg ? <ErrorBox message={msg} /> : <Loading />}</Modal>;
  const vcRangeEntry = (vcRanges?.ranges || []).find((x) => x.vcenterId === vc);

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
    <Modal title="IPMS 설정 — 무시 대역 · vCenter 스캔 대역" onClose={onClose} width={560}>
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

      {/* vCenter별 스캔 대역 — 사전 정리 + 주기 스캔(rangeStore) */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,.08)', paddingTop: 10, marginTop: 12 }}>
        <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 6 }}>
          <b style={{ fontSize: 13 }}>vCenter별 스캔 대역 (주기 스캔)</b>
          <span className="muted" style={{ fontSize: 11 }}>대상: <b>{vcs.find((v) => v.id === vc)?.name || vc}</b>{vcRangeEntry ? ` · 약 ${(vcRangeEntry.ipCount || 0).toLocaleString()} IP` : ''}</span>
        </div>
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>여기 정리한 대역은 주기 IP 스캔이 함께 스캔해 사용 현황(네트워크 맵·관리대장)을 자동 갱신합니다. 위 vCenter 선택기와 연동됩니다. 형식: CIDR·범위·단일 IP, 한 줄에 하나.</div>
        <textarea className="input" rows={5} value={scanText} onChange={(e) => setScanText(e.target.value)} placeholder={'10.94.42.0/24\n10.94.43.1-10.94.43.200'} style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }} />
        <div className="flex gap" style={{ marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12 }}><input type="checkbox" checked={scanEnabled} onChange={(e) => setScanEnabled(e.target.checked)} /> 주기 스캔 포함</label>
          <button className="login-btn" style={{ flex: 'none', padding: '7px 14px' }} disabled={scanBusy || !vc} onClick={saveScanRanges}>대역 저장</button>
          <button className="logout-btn" style={{ padding: '7px 12px' }} disabled={scanBusy} onClick={scanNow}>🛰️ 지금 스캔</button>
          <span className="muted" style={{ fontSize: 11 }}>스캔 주기는 ‘IP 스캔’ 설정의 간격을 따릅니다.</span>
        </div>
        {scanMsg && <div style={{ marginTop: 8, padding: '7px 10px', borderRadius: 8, fontSize: 12, background: scanMsg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)', color: scanMsg.ok ? '#4ade80' : '#f87171' }}>{scanMsg.text}</div>}
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
  useEffect(() => { load(agent, true); const t = setInterval(() => load(agent, false), 2000); return () => clearInterval(t); /* eslint-disable-next-line */ }, [agent]);
  if (!s) return <Modal title="IP 스캔" onClose={onClose}>{msg ? <ErrorBox message={msg} /> : <Loading />}</Modal>;

  const isLocal = agent === LOCAL_AGENT;
  const agentLabel = (a) => (a === LOCAL_AGENT ? '이 포탈에서 직접' : a);
  const switchAgent = (a) => { setS(null); setMsg(null); setAgent(a); };
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await putJson('/admin/ipam/scan/settings', { ...s, agent });
      setS(r.settings); setStatus(r.status);
      const cfg = r.settings || s;
      const mins = Math.max(1, Math.round((cfg.intervalMs || 3_600_000) / 60000));
      const nextAt = new Date(Date.now() + (cfg.intervalMs || 3_600_000)).toLocaleString('ko-KR');
      const hasRanges = (cfg.ranges || []).filter(Boolean).length > 0;
      if (isLocal) {
        // 저장 후 '지금 스캔?' 확인 — 아니오면 설정된 주기/다음 스캔 시각 안내.
        if (hasRanges && window.confirm('설정을 저장했습니다.\n지금 바로 스캔할까요?\n\n[취소]를 누르면 설정된 주기에 따라 자동 스캔됩니다.')) {
          await runNow();
        } else if (cfg.enabled && hasRanges) {
          setMsg(`저장됨 · 자동 스캔 켜짐(주기 ${mins}분). 다음 자동 스캔 예정: 약 ${nextAt}. 지금 바로 하려면 '지금 스캔(포탈)'을 누르세요.`);
        } else {
          setMsg(`저장됨 · 자동 스캔이 꺼져 있습니다('주기적으로 스캔' 체크 후 저장하거나 '지금 스캔(포탈)'을 누르세요).`);
        }
      } else {
        // 원격 에이전트는 중앙에서 즉시 실행 불가 — 다음 주기에 스스로 읽어가 스캔.
        setMsg(cfg.enabled
          ? `저장됨 · '${agent}' 에이전트가 주기 ${mins}분마다 이 설정을 읽어가 스캔합니다. 다음 스캔: 최대 ${mins}분 이내(에이전트 다음 주기). 중앙에서 즉시 실행은 불가합니다.`
          : `저장됨 · '${agent}' 자동 스캔이 꺼져 있습니다('주기적으로 스캔' 체크 후 저장하세요).`);
      }
    } catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(false); }
  };
  const runNow = async () => {
    const nRanges = (s.ranges || []).map((x) => String(x).trim()).filter(Boolean).length;
    setBusy(true); setMsg(`입력한 대역(${nRanges}개)을 저장하고 스캔을 시작하는 중…`);
    try {
      // 입력한 대역을 먼저 저장한 뒤 스캔(미저장 입력이 무시되어 첫 대역만 스캔되던 문제 방지).
      const sv = await putJson('/admin/ipam/scan/settings', { ...s, agent });
      if (sv?.settings) setS(sv.settings);
      const r = await postJson('/admin/ipam/scan/run', {});
      if (r.status) setStatus(r.status); if (r.info) setInfo(r.info);
      setMsg(r.ok ? `대역 ${nRanges}개 스캔을 백그라운드에서 시작했습니다(전체 IP는 진행 막대에 표시). 창을 닫아도 계속 실행됩니다.` : `시작 실패: ${r.reason}`);
    } catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(false); load(agent, false); }
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
        <label style={{ fontWeight: 600, paddingTop: 9 }}>스캔 대역 <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>(한 줄에 하나)</span></label>
        <div>
          <textarea className="input" value={(s.ranges || []).join('\n')} onChange={(e) => setS({ ...s, ranges: e.target.value.split(/\n/) })}
            placeholder={'10.0.0.0/24\n192.168.1.1-192.168.1.50\n172.16.5.10'} style={{ resize: 'vertical', minHeight: 96, fontFamily: 'monospace', fontSize: 12, width: '100%', boxSizing: 'border-box', display: 'block' }} />
          <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>등록 대역 <b>{(s.ranges || []).map((x) => String(x).trim()).filter(Boolean).length}</b>개 — 모든 줄을 스캔합니다. <b>지금 스캔</b>은 입력값을 자동 저장 후 실행합니다.</div>
        </div>
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
        <ScanProgressBar progress={status?.progress} />
      </div>

      <div className="flex gap" style={{ marginTop: 14 }}>
        <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={busy} onClick={save}>저장</button>
        <button className="logout-btn" style={{ padding: '9px 14px' }} disabled={busy || status?.running || !isLocal} title={isLocal ? '' : '원격 에이전트는 자체 주기로 스캔합니다'} onClick={runNow}>지금 스캔(포탈)</button>
        <button className="logout-btn" style={{ padding: '9px 14px', marginLeft: 'auto' }} onClick={onClose}>닫기</button>
      </div>
    </Modal>
  );
}

/** 진행 중 스캔 진행률 막대(스캔한 IP 수 / 전체 + %). progress 없으면 렌더 안 함. */
function ScanProgressBar({ progress }) {
  if (!progress || !progress.total) return null;
  const pct = progress.pct ?? Math.round((progress.done / progress.total) * 100);
  const elapsed = progress.startedAt ? Math.round((Date.now() - progress.startedAt) / 1000) : 0;
  return (
    <div style={{ marginTop: 10 }}>
      <div className="flex between" style={{ fontSize: 12, marginBottom: 4 }}>
        <span className="muted">진행 {progress.done.toLocaleString()} / {progress.total.toLocaleString()} · 응답 <b style={{ color: 'var(--green)' }}>{progress.alive}</b> · {elapsed}초 경과</span>
        <b className="tabular" style={{ color: 'var(--amber)' }}>{pct}%</b>
      </div>
      <div className="usage-bar" style={{ height: 10 }}><span style={{ width: `${Math.min(pct, 100)}%`, background: 'var(--amber)' }} /></div>
    </div>
  );
}

/** 대장 상단 '스캔 상태' 버튼이 여는 모달: 진행 중 스캔 + 완료된 스캔 이력. */
function ScanStatusModal({ onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => fetchJson('/admin/ipam/scan/status').then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); const t = setInterval(load, 2000); return () => clearInterval(t); }, []);
  const fmt = (t) => (t ? new Date(t).toLocaleString('ko-KR') : '—');
  const dur = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}초`);
  const st = d?.status; const runs = d?.runs || [];
  return (
    <Modal title="🛰️ IP 스캔 상태 — 진행 중 · 이력" onClose={onClose} width={720} resizable minWidth={480} minHeight={400}>
      {err && <ErrorBox message={err} />}
      {!d ? <Loading /> : (
        <>
          <div className="card" style={{ padding: 12, marginBottom: 14 }}>
            <div className="flex between" style={{ alignItems: 'center' }}>
              <b style={{ fontSize: 14 }}>{st?.running ? '🔄 스캔 진행 중' : '대기 중(진행 중인 스캔 없음)'}</b>
              <span className="muted" style={{ fontSize: 12 }}>저장된 결과 {d.info?.count ?? 0}개</span>
            </div>
            {st?.running && <ScanProgressBar progress={st.progress} />}
            {!st?.running && st?.lastRun && !st.lastRun.error && !st.lastRun.skipped && (
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>최근(포탈): {st.lastRun.scanned}개 중 {st.lastRun.alive}개 응답 · {dur(st.lastRun.durationMs)} · {fmt(st.lastRun.at)}</div>
            )}
          </div>

          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>완료된 스캔 이력 (최근 {runs.length}건 · 포탈/에이전트 통합)</div>
          <div className="table-wrap" style={{ maxHeight: '46vh' }}>
            <table>
              <thead><tr><th>완료 시각</th><th>에이전트</th><th style={{ textAlign: 'right' }}>스캔 / 응답</th><th style={{ textAlign: 'right' }}>소요</th></tr></thead>
              <tbody>
                {runs.length === 0 && <tr><td colSpan={4} className="center muted" style={{ padding: 20 }}>완료된 스캔 이력이 없습니다.</td></tr>}
                {runs.map((r, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmt(r.at)}</td>
                    <td><b>{r.agent === LOCAL_AGENT ? '이 포탈' : r.agent}</b></td>
                    <td style={{ textAlign: 'right' }} className="tabular">{(r.scanned ?? 0).toLocaleString()} / <b style={{ color: 'var(--green)' }}>{(r.alive ?? 0).toLocaleString()}</b></td>
                    <td style={{ textAlign: 'right' }} className="muted">{dur(r.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

/** 운영 인사이트 — 라이트사이징 · 클러스터 N+1 · 알람 핫스팟 · GPU 유휴 (기존 스냅샷 기반). */
function Insights({ scope }) {
  const { loading, data, error } = useTool('/tools/insights', scope ? { vcenterId: scope } : {});
  const [sec, setSec] = useState('rightsizing');
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const rs = data.rightsizing, cl = data.clusters || [], ah = data.alarmHotspot, gw = data.gpuWaste;
  const n1Bad = cl.filter((c) => !c.n1Ok).length;
  const SECS = [
    ['rightsizing', `♻ VM 라이트사이징`],
    ['n1', `🛡 클러스터 N+1 (위험 ${n1Bad})`],
    ['alarms', `🚨 알람 핫스팟 (${ah.total})`],
    ['gpu', `🎮 GPU 유휴 (${gw.idleGpus})`],
  ];
  const vmRows = (arr) => (
    <div className="table-wrap" style={{ maxHeight: '52vh' }}>
      <table><thead><tr><th>VM</th><th>법인</th><th>호스트</th><th style={{ textAlign: 'right' }}>vCPU</th><th style={{ textAlign: 'right' }}>RAM</th><th>CPU%</th><th>MEM%</th></tr></thead>
        <tbody>
          {arr.length === 0 && <tr><td colSpan={7} className="center muted" style={{ padding: 18 }}>해당 VM이 없습니다.</td></tr>}
          {arr.map((v) => (
            <tr key={`${v.vcenterId}:${v.name}`}>
              <td><b>{v.name}</b></td><td className="muted">{v.vcenterId}</td><td className="muted" style={{ fontSize: 12 }}>{v.host}</td>
              <td style={{ textAlign: 'right' }}>{v.vcpu}</td><td style={{ textAlign: 'right' }}>{v.ramGB} GB</td>
              <td>{v.cpuPct == null ? '—' : <UsageCell pct={v.cpuPct} />}</td><td>{v.memPct == null ? '—' : <UsageCell pct={v.memPct} />}</td>
            </tr>
          ))}
        </tbody></table>
    </div>
  );
  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="유휴 VM" value={rs.idleCount} accent="var(--amber)" meta="전원 ON·CPU<5%·MEM<20%" />
        <Card label="회수 가능(추정)" value={`${rs.reclaimableVcpu} vCPU`} meta={`${rs.reclaimableRamGB} GB RAM`} />
        <Card label="N+1 위험 클러스터" value={n1Bad} accent={n1Bad ? 'var(--red)' : 'var(--green)'} meta={`전체 ${cl.length} 클러스터`} />
        <Card label="유휴 GPU" value={gw.idleGpus} accent="var(--amber)" meta={`GPU 호스트 ${gw.totalGpuHosts} · 미보고 ${gw.unreporting}`} />
        <Card label="알람" value={ah.total} accent={ah.bySeverity.critical ? 'var(--red)' : 'var(--text)'} meta={`위험 ${ah.bySeverity.critical || 0} · 경고 ${ah.bySeverity.warning || 0}`} />
      </div>
      <div className="flex gap wrap" style={{ marginBottom: 10 }}>
        {SECS.map(([k, l]) => <button key={k} className={sec === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setSec(k)}>{l}</button>)}
      </div>

      {sec === 'rightsizing' && (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>실사용률 기준. <b>유휴</b>(회수 후보) · <b>과대</b>(vCPU≥4·CPU&lt;10%) · <b>과소</b>(CPU&gt;85% 또는 MEM&gt;90%, 증설 필요).</div>
          <div className="section-title" style={{ fontSize: 14 }}>유휴 VM ({rs.idleCount})</div>{vmRows(rs.idle)}
          <div className="section-title" style={{ fontSize: 14, marginTop: 14 }}>과대 할당 VM ({rs.oversizedCount})</div>{vmRows(rs.oversized)}
          <div className="section-title" style={{ fontSize: 14, marginTop: 14 }}>과소(증설 필요) VM ({rs.undersizedCount})</div>{vmRows(rs.undersized)}
        </>
      )}
      {sec === 'n1' && (
        <div className="table-wrap" style={{ maxHeight: '64vh' }}>
          <div className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>호스트 1대(가장 큰 호스트) 장애 시 잔여 용량으로 현재 사용량을 수용할 수 있는지. 90% 초과·단일 호스트면 위험.</div>
          <table><thead><tr><th>법인</th><th>클러스터</th><th style={{ textAlign: 'right' }}>호스트</th><th>현재 CPU</th><th>현재 MEM</th><th>1대 장애 후 CPU</th><th>1대 장애 후 MEM</th><th>N+1</th></tr></thead>
            <tbody>
              {cl.map((c) => (
                <tr key={`${c.vcenterId}:${c.cluster}`} style={{ background: c.n1Ok ? undefined : 'rgba(239,68,68,.10)' }}>
                  <td className="muted">{c.vcenterId}</td><td><b>{c.cluster}</b></td><td style={{ textAlign: 'right' }}>{c.hosts}</td>
                  <td><UsageCell pct={c.cpuUsagePct} /></td><td><UsageCell pct={c.memUsagePct} /></td>
                  <td>{c.cpuAfterFailPct > 200 ? '—' : <UsageCell pct={Math.min(c.cpuAfterFailPct, 100)} />}</td>
                  <td>{c.memAfterFailPct > 200 ? '—' : <UsageCell pct={Math.min(c.memAfterFailPct, 100)} />}</td>
                  <td>{c.n1Ok ? <span className="badge green">여유</span> : <span className="badge red">위험</span>}</td>
                </tr>
              ))}
            </tbody></table>
        </div>
      )}
      {sec === 'alarms' && (
        <div className="grid2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div><div className="section-title" style={{ fontSize: 14 }}>알람 많은 엔티티</div>
            <div className="table-wrap" style={{ maxHeight: '52vh' }}><table><thead><tr><th>엔티티</th><th style={{ textAlign: 'right' }}>알람 수</th></tr></thead>
              <tbody>{ah.topEntities.length === 0 && <tr><td colSpan={2} className="center muted" style={{ padding: 18 }}>알람 없음</td></tr>}
                {ah.topEntities.map((e) => <tr key={e.entity}><td>{e.entity}</td><td style={{ textAlign: 'right' }}><b>{e.count}</b></td></tr>)}</tbody></table></div></div>
          <div><div className="section-title" style={{ fontSize: 14 }}>센터별 알람</div>
            <div className="table-wrap" style={{ maxHeight: '52vh' }}><table><thead><tr><th>vCenter</th><th style={{ textAlign: 'right' }}>알람 수</th></tr></thead>
              <tbody>{ah.byVcenter.map((e) => <tr key={e.vcenterId || '_'}><td>{e.vcenterId || '—'}</td><td style={{ textAlign: 'right' }}><b>{e.count}</b></td></tr>)}</tbody></table></div></div>
        </div>
      )}
      {sec === 'gpu' && (
        <div className="table-wrap" style={{ maxHeight: '64vh' }}>
          <div className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>ESXi 보고 사용률 &lt;10% GPU 호스트(유휴/낭비 후보). 미보고({gw.unreporting})는 패스쓰루로 사용률 미관측.</div>
          <table><thead><tr><th>호스트</th><th>법인</th><th>GPU 모델</th><th style={{ textAlign: 'right' }}>개수</th><th>사용률</th><th style={{ textAlign: 'right' }}>할당 VM</th></tr></thead>
            <tbody>
              {gw.list.length === 0 && <tr><td colSpan={6} className="center muted" style={{ padding: 18 }}>유휴 GPU 호스트가 없습니다.</td></tr>}
              {gw.list.map((g) => (
                <tr key={g.host}><td><b>{g.host}</b></td><td className="muted">{g.vcenterId}</td><td>{g.model}</td>
                  <td style={{ textAlign: 'right' }}>{g.count}</td><td><UsageCell pct={g.util} /></td><td style={{ textAlign: 'right' }}>{g.assignedVms}</td></tr>
              ))}
            </tbody></table>
        </div>
      )}
    </>
  );
}

/** 위협 탐지 — 텔레메트리 기반(마이닝/위험포트/EOL/rogue) + NSX 분산 IDS 이벤트. 방어 목적. */
function Threats({ scope }) {
  const { loading, data, error } = useTool('/tools/threats', scope ? { vcenterId: scope } : {});
  const [sec, setSec] = useState('mining');
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const s = data.summary;
  const fmt = (t) => (t ? new Date(t).toLocaleString('ko-KR') : '—');
  const SECS = [
    ['mining', `⛏ 마이닝 의심 (${s.mining})`],
    ['risky', `🚪 위험 포트 (${s.riskyTotal})`],
    ['eol', `🧟 EOL OS (${s.eol})`],
    ['rogue', `👻 신규 rogue IP (${s.rogue})`],
    ['ids', `🛡 NSX IDS (${s.idsEvents})`],
  ];
  return (
    <>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>자사 인프라 <b>방어적 위협 탐지</b>입니다. 텔레메트리·스캔·NSX IDS 신호 기반이며, 확정 판정이 아닌 <b>점검 후보</b>를 제시합니다.</div>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="마이닝 의심(고CPU)" value={s.mining} accent={s.mining ? 'var(--amber)' : 'var(--green)'} meta="전원ON·CPU≥90%" />
        <Card label="위험 포트 노출" value={s.riskyTotal} accent={s.riskyPublic ? 'var(--red)' : 'var(--amber)'} meta={`공인 노출 ${s.riskyPublic}`} />
        <Card label="EOL/취약 OS" value={s.eol} accent={s.eol ? 'var(--amber)' : 'var(--green)'} meta="지원종료 추정" />
        <Card label="신규 rogue IP" value={s.rogue} accent={s.rogue ? 'var(--amber)' : 'var(--green)'} meta="7일 내 첫 관측" />
        <Card label="NSX IDS 이벤트" value={s.idsEvents} accent={s.idsCritical ? 'var(--red)' : 'var(--text)'} meta={`위험 ${s.idsCritical}`} />
      </div>
      <div className="flex gap wrap" style={{ marginBottom: 10 }}>
        {SECS.map(([k, l]) => <button key={k} className={sec === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setSec(k)}>{l}</button>)}
      </div>

      {sec === 'mining' && (
        <div className="table-wrap" style={{ maxHeight: '64vh' }}>
          <div className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>전원 ON·CPU ≥ 90%. 지속 고부하는 크립토마이닝/폭주 프로세스 신호일 수 있습니다(확정 아님).</div>
          <table><thead><tr><th>VM</th><th>법인</th><th>호스트</th><th>CPU%</th><th>MEM%</th></tr></thead>
            <tbody>{data.mining.length === 0 && <tr><td colSpan={5} className="center muted" style={{ padding: 18 }}>해당 없음</td></tr>}
              {data.mining.map((v) => <tr key={`${v.vcenterId}:${v.name}`}><td><b>{v.name}</b></td><td className="muted">{v.vcenterId}</td><td className="muted" style={{ fontSize: 12 }}>{v.host}</td><td><UsageCell pct={v.cpuPct} /></td><td>{v.memPct == null ? '—' : <UsageCell pct={v.memPct} />}</td></tr>)}</tbody></table>
        </div>
      )}
      {sec === 'risky' && (
        <div className="table-wrap" style={{ maxHeight: '64vh' }}>
          <div className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>스캔에서 확인된 위험 서비스 포트(Telnet/SMB/RDP/DB 등). <b>공인 IP 노출</b>은 즉시 점검 권장.</div>
          <table><thead><tr><th>IP</th><th>호스트명</th><th>위험 포트</th><th>분류</th><th>위험도</th></tr></thead>
            <tbody>{data.risky.length === 0 && <tr><td colSpan={5} className="center muted" style={{ padding: 18 }}>해당 없음</td></tr>}
              {data.risky.map((r) => <tr key={r.ip} style={{ background: r.public ? 'rgba(239,68,68,.10)' : undefined }}><td><b>{r.ip}</b></td><td className="muted">{r.hostname || '—'}</td><td>{r.ports.map((p) => <span key={p} className="badge amber" style={{ marginRight: 4 }}>{p}</span>)}</td><td>{r.public ? <span className="badge red">공인</span> : <span className="badge gray">사설</span>}</td><td>{r.severity === 'high' ? <span className="badge red">높음</span> : <span className="badge amber">보통</span>}</td></tr>)}</tbody></table>
        </div>
      )}
      {sec === 'eol' && (
        <div className="table-wrap" style={{ maxHeight: '64vh' }}>
          <table><thead><tr><th>VM</th><th>법인</th><th>OS</th><th>사유</th></tr></thead>
            <tbody>{data.eol.length === 0 && <tr><td colSpan={4} className="center muted" style={{ padding: 18 }}>해당 없음</td></tr>}
              {data.eol.map((v) => <tr key={`${v.vcenterId}:${v.name}`}><td><b>{v.name}</b></td><td className="muted">{v.vcenterId}</td><td>{v.os}</td><td><span className="badge amber">{v.reason}</span></td></tr>)}</tbody></table>
        </div>
      )}
      {sec === 'rogue' && (
        <div className="table-wrap" style={{ maxHeight: '64vh' }}>
          <div className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>vCenter가 모르는데 최근 7일 내 처음 스캔된 IP — 미등록 장비/침입 가능성 점검.</div>
          <table><thead><tr><th>IP</th><th>호스트명</th><th>최초 관측</th><th>포트</th></tr></thead>
            <tbody>{data.rogue.length === 0 && <tr><td colSpan={4} className="center muted" style={{ padding: 18 }}>해당 없음</td></tr>}
              {data.rogue.map((r) => <tr key={r.ip}><td><b>{r.ip}</b></td><td className="muted">{r.hostname || '—'}</td><td className="muted" style={{ fontSize: 12 }}>{fmt(r.firstSeen)}</td><td className="muted" style={{ fontSize: 12 }}>{(r.ports || []).join(', ')}</td></tr>)}</tbody></table>
        </div>
      )}
      {sec === 'ids' && (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>NSX 분산 IDS/IPS. {data.ids.managers.map((m) => `${m.name}: ${m.enabled === true ? '활성' : m.enabled === false ? '비활성' : '미상'}(프로파일 ${m.profiles})`).join(' · ') || 'NSX 매니저 없음'}</div>
          <div className="table-wrap" style={{ maxHeight: '60vh' }}>
            <table><thead><tr><th>시각</th><th>시그니처</th><th>심각도</th><th>출발지</th><th>목적지</th><th>조치</th><th style={{ textAlign: 'right' }}>횟수</th></tr></thead>
              <tbody>{data.ids.events.length === 0 && <tr><td colSpan={7} className="center muted" style={{ padding: 18 }}>IDS 이벤트가 없습니다(미활성 또는 NSX 버전/NAPP 미지원일 수 있음).</td></tr>}
                {data.ids.events.map((e) => <tr key={e.id}><td className="muted" style={{ fontSize: 12 }}>{fmt(e.at)}</td><td>{e.signature}</td><td>{/crit|high/.test(e.severity) ? <span className="badge red">{e.severity}</span> : <span className="badge amber">{e.severity}</span>}</td><td className="muted">{e.src || '—'}</td><td className="muted">{e.dst || '—'}</td><td>{e.action || '—'}</td><td style={{ textAlign: 'right' }}>{e.count}</td></tr>)}</tbody></table>
          </div>
        </>
      )}
    </>
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

/** 서버 분석 — iDRAC가 수집한 하드웨어 정보 분석. vCenter(법인)별 필터 + 서버 클릭 상세 공용. */
function ServerAnalysis() {
  const [sub, setSub] = useState('gpu'); // 향후 분석 추가 여지
  const [vc, setVc] = useState(''); // '' 전체 | vCenterId | __unmapped__
  const [vcs, setVcs] = useState([]);
  const [detail, setDetail] = useState(null); // { id, name } → iDRAC 상세 모달
  useEffect(() => { fetchJson('/vcenters').then((d) => setVcs(d || [])).catch(() => fetchJson('/admin/vcenters').then((d) => setVcs(d.vcenters || [])).catch(() => {})); }, []);
  const onServer = (s) => setDetail({ id: s.id || s.serverId, name: s.name || s.server });
  const sp = { vc, onServer };
  return (
    <div>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 12 }}>
        <div className="flex gap wrap">
          <button className={sub === 'gpu' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 16px' }} onClick={() => setSub('gpu')}>🎮 GPU 찾기</button>
          <button className={sub === 'fw' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 16px' }} onClick={() => setSub('fw')}>🏷 펌웨어 보기</button>
          <button className={sub === 'temp' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 16px' }} onClick={() => setSub('temp')}>🌡 온도 보기</button>
          <button className={sub === 'psu' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 16px' }} onClick={() => setSub('psu')}>🔌 전력(PSU)</button>
          <button className={sub === 'issues' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 16px', ...(sub === 'issues' ? {} : { borderColor: 'var(--red)', color: 'var(--red)' }) }} onClick={() => setSub('issues')}>⚠ 이상만</button>
        </div>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }} title="iDRAC 서버에 지정된 소속 vCenter(법인) 기준. '미지정'은 소속이 지정 안 된 서버.">
          <span className="muted">법인/vCenter</span>
          <select className="select" value={vc} onChange={(e) => setVc(e.target.value)} style={{ minWidth: 180 }}>
            <option value="">전체</option>
            {vcs.map((v) => <option key={v.id} value={v.id}>{v.name || v.id}</option>)}
            <option value="__unmapped__">⚠ 미지정(소속 없음)</option>
          </select>
        </label>
      </div>
      {sub === 'gpu' && <ServerGpuFinder {...sp} />}
      {sub === 'fw' && <ServerFirmwareFinder {...sp} />}
      {sub === 'temp' && <ServerTempFinder {...sp} />}
      {sub === 'psu' && <ServerPsuFinder {...sp} />}
      {sub === 'issues' && <ServerHealthIssues {...sp} />}
      {detail && <IdracDetailModal server={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

const vcQS = (vc) => (vc ? `?vcenterId=${encodeURIComponent(vc)}` : '');

/** 전력(PSU) — 전체 서버의 설치된 PSU를 용량/출력/입력전압/상태로 정렬해 본다. */
function ServerPsuFinder({ vc, onServer }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [cap, setCap] = useState(''); // 용량 필터(W)
  const [badOnly, setBadOnly] = useState(false);
  const load = () => fetchJson(`/admin/idrac/psu-inventory${vcQS(vc)}`).then((r) => { setD(r); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { setD(null); load(); const t = setInterval(load, 30_000); return () => clearInterval(t); /* eslint-disable-next-line */ }, [vc]);
  if (err) return <ErrorBox message={err} />;
  if (!d) return <Loading />;
  const ql = q.trim().toLowerCase();
  const rows = (d.rows || []).filter((r) =>
    (!cap || String(r.capacityWatts) === cap)
    && (!badOnly || (r.health && !/^ok$/i.test(r.health)))
    && (!ql || [r.server, r.model, r.name, r.vcenterId, r.serviceTag].some((x) => String(x || '').toLowerCase().includes(ql))),
  );
  return (
    <div>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 12 }}>
        <div className="muted" style={{ fontSize: 13 }}>
          PSU <b style={{ color: 'var(--accent)' }}>{d.totalPsus}</b>개 · 서버 {d.collectedServers}/{d.totalServers} · 총 출력 {Math.round(d.totalOutputW).toLocaleString()}W
          {d.missing > 0 && <span className="badge amber" style={{ marginLeft: 8 }}>미수집 {d.missing}대</span>}
        </div>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <select className="select select-sm" value={cap} onChange={(e) => setCap(e.target.value)} style={{ minWidth: 120 }}>
            <option value="">용량 전체</option>
            {(d.byCapacity || []).map((c) => <option key={c.capacityWatts} value={String(c.capacityWatts)}>{c.capacityWatts ? `${c.capacityWatts}W` : '미상'} ({c.count})</option>)}
          </select>
          <label className="flex gap muted" style={{ alignItems: 'center', fontSize: 12 }}><input type="checkbox" checked={badOnly} onChange={(e) => setBadOnly(e.target.checked)} /> OK 아닌것만</label>
          <SearchBox className="input" style={{ maxWidth: 220 }} placeholder="서버/모델/서비스태그 검색" value={q} onChange={setQ} />
          <button className="logout-btn" style={{ padding: '7px 12px' }} onClick={load}>↻</button>
        </div>
      </div>
      {(d.byCapacity || []).length > 0 && (
        <div className="flex gap wrap" style={{ marginBottom: 12 }}>
          {d.byCapacity.map((c) => (
            <span key={c.capacityWatts} className={`badge ${String(c.capacityWatts) === cap ? 'blue' : 'gray'}`} style={{ cursor: 'pointer' }} onClick={() => setCap(String(c.capacityWatts) === cap ? '' : String(c.capacityWatts))}>
              {c.capacityWatts ? `${c.capacityWatts}W` : '미상'} × <b>{c.count}</b>
            </span>
          ))}
        </div>
      )}
      {rows.length === 0 ? (
        <div className="card" style={{ padding: 16 }}><span className="muted">표시할 PSU가 없습니다(iDRAC 인벤토리 30분 갱신).</span></div>
      ) : (
        <DataTable
          rows={rows}
          initialSort={{ key: 'capacityWatts', dir: 'desc' }}
          columns={[
            { key: 'server', label: '서버', render: (r) => <span><button className="cell-link" onClick={() => onServer(r)}>{r.server}</button>{r.serviceTag && <div className="muted" style={{ fontSize: 11 }}>{r.serviceTag}</div>}</span> },
            { key: 'name', label: 'PSU', render: (r) => <span>{r.name}<div className="muted" style={{ fontSize: 11 }}>{r.model}</div></span> },
            { key: 'capacityWatts', label: '용량', align: 'right', render: (r) => r.capacityWatts != null ? <b>{r.capacityWatts}W</b> : '—' },
            { key: 'outputWatts', label: '출력', align: 'right', render: (r) => r.outputWatts != null ? `${r.outputWatts}W` : '—' },
            { key: 'voltage', label: '입력', align: 'right', render: (r) => r.voltage != null ? <span>{r.voltage}V{r.inputWatts != null ? <span className="muted"> · {r.inputWatts}W</span> : ''}</span> : '—' },
            { key: 'health', label: '상태', render: (r) => <span className={`badge ${/ok/i.test(r.health) ? 'green' : r.health ? 'amber' : 'gray'}`}>{r.health || '—'}</span> },
          ]} />
      )}
    </div>
  );
}

/** 이상만 — 전체 iDRAC에서 'OK가 아닌' 구성요소(헬스·디스크·PSU·메모리·GPU·NIC)만 모아 보여준다. */
function ServerHealthIssues({ vc, onServer }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const load = () => fetchJson(`/admin/idrac/health-issues${vcQS(vc)}`).then((r) => { setD(r); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { setD(null); load(); const t = setInterval(load, 30_000); return () => clearInterval(t); /* eslint-disable-next-line */ }, [vc]);
  if (err) return <ErrorBox message={err} />;
  if (!d) return <Loading />;
  const ql = q.trim().toLowerCase();
  const rows = (d.issues || []).filter((r) => !ql || [r.server, r.category, r.item, r.status, r.vcenterId, r.serviceTag].some((x) => String(x || '').toLowerCase().includes(ql)));
  return (
    <div>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 12 }}>
        <div className="muted" style={{ fontSize: 13 }}>
          서버 {d.collectedServers}/{d.totalServers} 수집 · <b style={{ color: d.issueServers ? 'var(--red)' : 'var(--green)' }}>이상 {d.issueServers}대</b> · 정상 {d.okServers}대 · 문제 항목 <b style={{ color: 'var(--red)' }}>{d.issues.length}</b>건
        </div>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <SearchBox className="input" style={{ maxWidth: 240 }} placeholder="서버/서비스태그/항목 검색" value={q} onChange={setQ} />
          <button className="logout-btn" style={{ padding: '7px 12px' }} onClick={load}>↻ 새로고침</button>
        </div>
      </div>
      {d.issues.length === 0 ? (
        <div className="card" style={{ padding: 24, textAlign: 'center', borderColor: 'var(--green)' }}>
          <div style={{ fontSize: 36 }}>✅</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--green)', marginTop: 8 }}>모든 서버 정상 — OK 아닌 항목이 없습니다</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>iDRAC 인벤토리(30분 갱신) 기준. 갱신이 필요하면 전력 수집 › 상세 › 즉시 재수집.</div>
        </div>
      ) : (
        <DataTable
          rows={rows}
          initialSort={{ key: 'category', dir: 'asc' }}
          columns={[
            { key: 'server', label: '서버', render: (r) => <span><button className="cell-link" onClick={() => onServer(r)}>{r.server}</button>{r.serviceTag && <div className="muted" style={{ fontSize: 11 }}>{r.serviceTag}</div>}</span> },
            { key: 'vcenterId', label: 'vCenter', render: (r) => <span className="muted">{r.vcenterId || '—'}</span> },
            { key: 'category', label: '구분', render: (r) => <span className="badge gray">{r.category}</span> },
            { key: 'item', label: '항목', render: (r) => <span>{r.item}{r.detail && <span className="muted" style={{ fontSize: 11 }}> · {r.detail}</span>}</span> },
            { key: 'status', label: '상태', render: (r) => <span className={`badge ${/예측|fail|crit|critical/i.test(r.status) ? 'red' : 'amber'}`}>{r.status}</span> },
          ]} />
      )}
    </div>
  );
}

const TEMP_KINDS = [['', '전체 센서'], ['cpu', 'CPU'], ['gpu', 'GPU'], ['inlet', 'Inlet/흡기'], ['exhaust', 'Exhaust/배기'], ['board', 'System Board']];
const tempKindMatch = (kind, name) => {
  const n = String(name).toLowerCase();
  if (kind === 'cpu') return /cpu|proc/.test(n);
  if (kind === 'gpu') return /gpu|video|accel/.test(n);
  if (kind === 'inlet') return /inlet|intake|ambient/.test(n);
  if (kind === 'exhaust') return /exhaust|outlet/.test(n);
  if (kind === 'board') return /board|system|planar|mb\b/.test(n);
  return true;
};

/** 온도 보기 — 전체 서버의 최신 온도센서(CPU/GPU/Inlet/Exhaust 등)를 한 표에 모아 정렬. */
function ServerTempFinder({ vc, onServer }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const load = () => fetchJson(`/admin/idrac/temps${vcQS(vc)}`).then((r) => { setD(r); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { setD(null); load(); const t = setInterval(load, 30_000); return () => clearInterval(t); /* eslint-disable-next-line */ }, [vc]);
  if (err) return <ErrorBox message={err} />;
  if (!d) return <Loading />;
  const ql = q.trim().toLowerCase();
  const rows = (d.rows || []).filter((r) =>
    tempKindMatch(kind, r.sensor)
    && (!ql || [r.sensor, r.server, r.vcenterId, r.serviceTag].some((x) => String(x || '').toLowerCase().includes(ql))),
  );
  const avg = rows.length ? Math.round(rows.reduce((a, b) => a + b.celsius, 0) / rows.length) : null;
  return (
    <div>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 12 }}>
        <div className="muted" style={{ fontSize: 13 }}>
          서버 {d.sampledServers}/{d.totalServers} · 센서 <b style={{ color: 'var(--accent)' }}>{rows.length}</b>개
          {d.maxCelsius != null && <> · 최고 <b style={{ color: tempColor(d.maxCelsius) }}>{d.maxCelsius}℃</b></>}
          {avg != null && <> · 평균 {avg}℃</>}
          {d.missing > 0 && <span className="badge amber" style={{ marginLeft: 8 }}>미수집 {d.missing}대</span>}
        </div>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <select className="select select-sm" value={kind} onChange={(e) => setKind(e.target.value)} style={{ minWidth: 130 }}>
            {TEMP_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <SearchBox className="input" style={{ maxWidth: 240 }} placeholder="서버/센서/서비스태그 검색" value={q} onChange={setQ} />
          <button className="logout-btn" style={{ padding: '7px 12px' }} onClick={load}>↻</button>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="card" style={{ padding: 16 }}><span className="muted">표시할 온도 데이터가 없습니다. 온도는 1분마다 수집되며, 등록된 iDRAC 서버가 켜져 있어야 합니다.</span></div>
      ) : (
        <DataTable
          rows={rows}
          initialSort={{ key: 'celsius', dir: 'desc' }}
          columns={[
            { key: 'server', label: '서버', render: (r) => <span><button className="cell-link" onClick={() => onServer(r)}>{r.server}</button>{r.serviceTag && <div className="muted" style={{ fontSize: 11 }}>{r.serviceTag}</div>}</span> },
            { key: 'vcenterId', label: 'vCenter', render: (r) => <span className="muted">{r.vcenterId || '—'}</span> },
            { key: 'sensor', label: '센서' },
            { key: 'celsius', label: '온도', align: 'right', render: (r) => <b style={{ color: tempColor(r.celsius) }}>{r.celsius}℃</b> },
            { key: 'at', label: '수집', sortValue: (r) => r.at, render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.at ? new Date(r.at).toLocaleTimeString('ko-KR', { hour12: false }) : '—'}</span> },
          ]} />
      )}
    </div>
  );
}

const FW_CAT_COLOR = { iDRAC: 'blue', BIOS: 'teal', NIC: 'green', HBA: 'amber', Storage: 'amber', GPU: 'green', PSU: 'gray', CPLD: 'gray', Disk: 'gray', Driver: 'gray', 기타: 'gray' };

/** 펌웨어 보기 — 서버 모델(R760/R770…) 클릭 → iDRAC·BIOS·NIC·HBA 등 버전별 설치 서버 수. */
function ServerFirmwareFinder({ vc }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [model, setModel] = useState(null);
  const load = () => fetchJson(`/admin/idrac/firmware-inventory${vcQS(vc)}`).then((r) => { setD(r); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { setD(null); load(); /* eslint-disable-next-line */ }, [vc]);
  if (err) return <ErrorBox message={err} />;
  if (!d) return <Loading />;
  const sel = model && d.models.find((m) => m.model === model);
  return (
    <div>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 12 }}>
        <div className="muted" style={{ fontSize: 13 }}>
          서버 모델 <b style={{ color: 'var(--accent)' }}>{d.models.length}</b>종 · 서버 {d.collectedServers}/{d.totalServers} 수집됨 · <b>모델을 클릭</b>하면 iDRAC/BIOS/NIC/HBA 드라이버 버전별 설치 대수를 봅니다.
          {d.missing?.length > 0 && <span className="badge amber" style={{ marginLeft: 8 }} title={d.missing.map((x) => x.name).join(', ')}>미수집 {d.missing.length}대</span>}
        </div>
        <button className="logout-btn" style={{ padding: '7px 12px' }} onClick={load}>↻ 새로고침</button>
      </div>

      {d.models.length === 0 ? (
        <div className="card" style={{ padding: 16 }}><span className="muted">수집된 iDRAC 인벤토리가 없습니다(30분마다 갱신). 전력 수집 › 상세 › 하드웨어/버전에서 “↻ 즉시 재수집”으로 채울 수 있습니다.</span></div>
      ) : (
        <>
          <div className="vc-grid" style={{ marginBottom: 16 }}>
            {d.models.map((m) => (
              <div key={m.model} className="card" style={{ cursor: 'pointer', borderColor: model === m.model ? 'var(--accent)' : undefined }} onClick={() => setModel(model === m.model ? null : m.model)}>
                <div style={{ fontSize: 26 }}>🖥</div>
                <div className="vc-name" style={{ marginTop: 6, fontSize: 14 }}>{m.model}</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--accent)', margin: '4px 0' }}>{m.serverCount}<span style={{ fontSize: 13, fontWeight: 400 }} className="muted"> 대</span></div>
                <div className="vc-foot"><span className="muted">{m.categories.length}개 구성요소</span><span className="muted">{model === m.model ? '▲' : '▼'}</span></div>
              </div>
            ))}
          </div>

          {sel && (
            <div className="card" style={{ padding: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10 }}>🖥 {sel.model} — {sel.serverCount}대</div>
              {sel.categories.map((c) => (
                <div key={c.category} style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
                    <span className={`badge ${FW_CAT_COLOR[c.category] || 'gray'}`}>{c.category}</span>
                    <span className="muted" style={{ fontWeight: 400, marginLeft: 6 }}>{c.versions.length}개 버전</span>
                  </div>
                  <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
                    <thead><tr><th style={{ textAlign: 'left' }}>버전</th><th style={{ textAlign: 'right', width: 110 }}>설치 서버</th><th style={{ textAlign: 'left' }}>서버 목록</th></tr></thead>
                    <tbody>{c.versions.map((v) => (
                      <tr key={v.version}>
                        <td className="tabular"><b>{v.version}</b></td>
                        <td style={{ textAlign: 'right' }}><b style={{ color: 'var(--accent)' }}>{v.count}</b>대</td>
                        <td className="muted" style={{ fontSize: 12 }} title={v.servers.join(', ')}>{v.servers.slice(0, 8).join(', ')}{v.servers.length > 8 ? ` 외 ${v.servers.length - 8}대` : ''}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** GPU 찾기 — iDRAC 수집 GPU를 모델별로 집계(어떤 모델 몇 장, 어느 서버). */
function ServerGpuFinder({ vc, onServer }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null); // 펼친 모델
  const load = () => fetchJson(`/admin/idrac/gpu-inventory${vcQS(vc)}`).then((r) => { setD(r); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { setD(null); load(); /* eslint-disable-next-line */ }, [vc]);
  if (err) return <ErrorBox message={err} />;
  if (!d) return <Loading />;
  const ql = q.trim().toLowerCase();
  const models = ql ? d.models.filter((m) => m.model.toLowerCase().includes(ql)
    || (m.servers || []).some((s) => (s.serviceTag || '').toLowerCase().includes(ql) || (s.name || '').toLowerCase().includes(ql))) : d.models;
  return (
    <div>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 12 }}>
        <div className="muted" style={{ fontSize: 13 }}>
GPU <b style={{ color: 'var(--accent)' }}>{d.totalGpus}</b>장 · <b>{d.models.length}</b>종 · iDRAC {d.collectedServers}/{d.totalServers}{d.physicalServers ? ` · 물리 ${d.physicalServers}대` : ''}
          {d.missing?.length > 0 && <span className="badge amber" style={{ marginLeft: 8 }} title={d.missing.map((x) => x.name).join(', ')}>미수집 {d.missing.length}대</span>}
        </div>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <SearchBox className="input" style={{ maxWidth: 260 }} placeholder="GPU 모델 / 서비스태그 검색" value={q} onChange={setQ} />
          <button className="logout-btn" style={{ padding: '7px 12px' }} onClick={load}>↻ 새로고침</button>
        </div>
      </div>

      {d.totalGpus === 0 ? (
        <div className="card" style={{ padding: 16 }}>
          <span className="muted">iDRAC에서 수집된 GPU가 없습니다. iDRAC 인벤토리는 30분마다 갱신되며, 각 서버의 <b>전력 수집 › 상세 › GPU 수집 확인</b>에서 즉시 확인할 수 있습니다. (패스쓰루로 게스트에 직접 할당된 GPU는 iDRAC에 안 보일 수 있습니다.)</span>
        </div>
      ) : (
        <>
          <div className="vc-grid" style={{ marginBottom: 16 }}>
            {models.map((m) => (
              <div key={m.model} className="card" style={{ cursor: 'pointer', borderColor: open === m.model ? 'var(--accent)' : undefined }} onClick={() => setOpen(open === m.model ? null : m.model)}>
                <div style={{ fontSize: 28 }}>🎮</div>
                <div className="vc-name" style={{ marginTop: 6, fontSize: 14 }}>{m.model}</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--accent)', margin: '4px 0' }}>{m.count}<span style={{ fontSize: 13, fontWeight: 400 }} className="muted"> 장</span></div>
                <div className="vc-foot"><span className="muted">서버 {m.serverCount}대</span><span className="muted">{open === m.model ? '▲' : '▼'}</span></div>
              </div>
            ))}
          </div>
          {open && (() => {
            const m = d.models.find((x) => x.model === open);
            if (!m) return null;
            return (
              <div className="card" style={{ padding: 14, marginBottom: 14 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>🎮 {m.model} — {m.count}장 / {m.serverCount}대 서버</div>
                <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
                  <thead><tr><th style={{ textAlign: 'left' }}>서버</th><th style={{ textAlign: 'left' }}>서비스태그</th><th style={{ textAlign: 'left' }}>소속 vCenter</th><th style={{ textAlign: 'right' }}>장수</th></tr></thead>
                  <tbody>{m.servers.map((s) => (
                    <tr key={s.id + (s.source || '')}><td>{s.source === 'physical' ? <span>{s.name} <span className="badge gray" style={{ fontSize: 10 }}>물리</span></span> : <button className="cell-link" onClick={() => onServer(s)}>{s.name}</button>} <span className="muted" style={{ fontSize: 11 }}>({s.host || s.id})</span></td>
                      <td className="tabular">{s.serviceTag || '—'}</td>
                      <td className="muted">{s.vcenterId || '—'}</td>
                      <td style={{ textAlign: 'right' }}><b>{s.count}</b></td></tr>
                  ))}</tbody>
                </table>
              </div>
            );
          })()}
          <DataTable
            rows={models}
            initialSort={{ key: 'count', dir: 'desc' }}
            columns={[
              { key: 'model', label: 'GPU 모델', render: (r) => <button className="cell-link" onClick={() => setOpen(open === r.model ? null : r.model)}>{r.model}</button> },
              { key: 'count', label: '장수', align: 'right', render: (r) => <b style={{ color: 'var(--accent)' }}>{r.count}</b> },
              { key: 'serverCount', label: '서버 수', align: 'right' },
              { key: 'servers', label: '서버', sortValue: (r) => r.serverCount, render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.servers.slice(0, 6).map((s) => `${s.name}${s.count > 1 ? `×${s.count}` : ''}`).join(', ')}{r.servers.length > 6 ? ` 외 ${r.servers.length - 6}대` : ''}</span> },
            ]} />
        </>
      )}
    </div>
  );
}

// 바이트를 사람이 읽는 단위로.
function fmtBytes(b) {
  if (b == null || !Number.isFinite(Number(b))) return '—';
  const n = Number(b);
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

const DB_TYPE_BADGE = { sqlite: 'blue', json: 'green', ndjson: 'amber', file: 'gray' };
const DB_TYPE_LABEL = { sqlite: 'SQLite', json: 'JSON', ndjson: 'ndjson', file: '파일' };

// 증가 추이 미니 스파크라인(크기 샘플). 값이 1개 이하면 '—'.
function Sparkline({ samples, w = 110, h = 26 }) {
  const pts = (samples || []).map((s) => s.bytes);
  if (pts.length < 2) return <span className="muted" style={{ fontSize: 12 }}>표본 부족</span>;
  const min = Math.min(...pts); const max = Math.max(...pts);
  const span = max - min || 1;
  const step = w / (pts.length - 1);
  const path = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`).join(' ');
  const up = pts[pts.length - 1] >= pts[0];
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <path d={path} fill="none" stroke={up ? 'var(--green)' : 'var(--red)'} strokeWidth="1.5" />
    </svg>
  );
}

/** 포탈 DB — 포탈이 사용하는 모든 데이터 파일(SQLite·JSON·ndjson)의 경로·용도·크기·증가 추이. */
function PortalDb() {
  const { data, error } = usePolling('/admin/portal-db', {}, 30_000);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  const files = data.files || [];
  const existing = files.filter((f) => f.exists);
  const sqliteN = existing.filter((f) => f.type === 'sqlite').length;
  const cols = [
    { key: 'file', label: '파일명', render: (f) => <b style={{ opacity: f.exists ? 1 : 0.5 }}>{f.file}</b> },
    { key: 'type', label: '종류', sortValue: (f) => f.type, render: (f) => <span className={`badge ${DB_TYPE_BADGE[f.type] || 'gray'}`}>{DB_TYPE_LABEL[f.type] || f.type}</span> },
    { key: 'purpose', label: '용도', render: (f) => <span style={{ fontSize: 13 }}>{f.purpose}</span> },
    { key: 'sizeBytes', label: '크기', align: 'right', sortValue: (f) => f.sizeBytes || -1, render: (f) => (f.exists ? <span>{fmtBytes(f.sizeBytes)}</span> : <span className="badge gray">미생성</span>) },
    { key: 'growth', label: '증가/일(추정)', align: 'right', sortValue: (f) => f.trend?.perDayBytes || 0, render: (f) => {
      const g = f.trend?.perDayBytes || 0;
      if (!f.exists || (f.trend?.samples?.length || 0) < 2) return <span className="muted">—</span>;
      if (g === 0) return <span className="muted">변화 없음</span>;
      return <span style={{ color: g > 0 ? 'var(--green)' : 'var(--red)' }}>{g > 0 ? '+' : ''}{fmtBytes(g)}/일</span>;
    } },
    { key: 'trend', label: '추이', render: (f) => <Sparkline samples={f.trend?.samples} /> },
    { key: 'path', label: '경로', render: (f) => <code style={{ fontSize: 11, color: 'var(--muted)' }}>{f.path}</code> },
  ];
  return (
    <>
      <div className="flex gap wrap" style={{ marginBottom: 14 }}>
        <Card label="데이터 파일" value={existing.length} meta={`정의 ${files.length}개`} />
        <Card label="SQLite DB" value={sqliteN} accent="var(--blue,#2563eb)" />
        <Card label="총 용량" value={fmtBytes(data.totalBytes)} accent="var(--green)" />
        <Card label="설정 디렉터리" value={<code style={{ fontSize: 12 }}>{data.configDir}</code>} meta={`추이 샘플 ${Math.round((data.sampleIntervalMs || 0) / 60000)}분 간격`} />
      </div>
      <DataTable columns={cols} rows={files} initialSort={{ key: 'sizeBytes', dir: 'desc' }} />
      <div className="muted" style={{ marginTop: 10, fontSize: 12, lineHeight: 1.7 }}>
        · <b>증가 추이</b>는 서버 기동 후 {Math.round((data.sampleIntervalMs || 0) / 60000)}분 간격으로 측정한 크기 표본으로 추정합니다(재시작 시 표본 초기화).
        · SQLite는 <code>-wal</code>/<code>-shm</code> 사이드카 크기를 합산해 표시합니다.
        · <code>미생성</code>은 해당 기능을 아직 쓰지 않아 파일이 만들어지지 않은 상태입니다.
      </div>
    </>
  );
}

/** 긴급중단 — 모든 수집을 즉시 정지. 관리자 2명이 각자 OTP로 인증해야(2인 승인) 실행/해제된다. */
function Shutdown() {
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(null); // 'stop' | 'resume' | null
  const load = () => fetchJson('/admin/emergency-stop').then(setStatus).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, []);
  const active = !!status?.active;
  return (
    <>
      <div className="card" style={{ borderColor: active ? 'var(--red)' : 'var(--accent)', padding: 28 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 44 }}>{active ? '🛑' : '🟢'}</div>
          <div style={{ fontSize: 18, fontWeight: 800, margin: '10px 0', color: active ? 'var(--red)' : 'var(--green)' }}>
            {active ? '긴급중단 상태 — 모든 수집 정지됨' : '정상 — 수집 동작 중'}
          </div>
          {active && status?.by?.length === 2 && (
            <div className="muted" style={{ fontSize: 13 }}>승인: <b>{status.by[0]}</b> + <b>{status.by[1]}</b>{status.at ? ` · ${new Date(status.at).toLocaleString('ko-KR')}` : ''}</div>
          )}
          <div className="muted" style={{ fontSize: 13, margin: '14px auto 18px', maxWidth: 560, lineHeight: 1.6 }}>
            긴급중단을 켜면 <b>vCenter 폴링·GPU 게스트 수집·iDRAC 전력 수집</b> 등 모든 백그라운드 수집이 다음 주기부터 즉시 멈춥니다(이미 수집된 화면 데이터는 그대로 유지). <b>관리자 2명이 각각 OTP로 인증</b>해야 실행/해제됩니다(2인 승인).
          </div>
          {!active ? (
            <button className="login-btn" style={{ flex: 'none', padding: '12px 28px', background: 'var(--red)', borderColor: 'var(--red)' }} onClick={() => setOpen('stop')}>
              🛑 긴급중단 실행 (관리자 2명 OTP)
            </button>
          ) : (
            <button className="login-btn" style={{ flex: 'none', padding: '12px 28px' }} onClick={() => setOpen('resume')}>
              ▶ 긴급중단 해제 (관리자 2명 OTP)
            </button>
          )}
        </div>
      </div>
      {open && <DualOtpModal action={open} onClose={() => setOpen(null)} onDone={(s) => { setStatus(s); setOpen(null); }} />}
    </>
  );
}

/** 2인 승인 모달 — 관리자 2명의 로그인 창을 동시에 띄워 각자 ID+OTP로 인증. */
function DualOtpModal({ action, onClose, onDone }) {
  const [a, setA] = useState({ username: '', code: '' });
  const [b, setB] = useState({ username: '', code: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const stop = action === 'stop';
  const ready = a.username.trim() && b.username.trim() && /^\d{6}$/.test(a.code.trim()) && /^\d{6}$/.test(b.code.trim())
    && a.username.trim().toLowerCase() !== b.username.trim().toLowerCase();
  const submit = async () => {
    setBusy(true); setErr(null);
    const r = await postJson('/admin/emergency-stop', {
      action,
      approvals: [{ username: a.username.trim(), code: a.code.trim() }, { username: b.username.trim(), code: b.code.trim() }],
    }).catch((e) => ({ ok: false, reason: e.message }));
    setBusy(false);
    if (r.ok) onDone(r); else setErr(r.reason || '인증 실패');
  };
  const panel = (label, v, setV) => (
    <div className="card" style={{ padding: 16, flex: 1, minWidth: 220, borderColor: 'var(--accent)' }}>
      <div style={{ fontWeight: 700, marginBottom: 10 }}>🔐 {label}</div>
      <label className="muted" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>관리자 ID</label>
      <input className="input" autoComplete="off" value={v.username} placeholder="admin 계정" onChange={(e) => setV({ ...v, username: e.target.value })} />
      <label className="muted" style={{ fontSize: 12, display: 'block', margin: '10px 0 4px' }}>OTP 코드(6자리)</label>
      <input className="input" inputMode="numeric" maxLength={6} autoComplete="off" value={v.code}
        placeholder="000000" style={{ letterSpacing: 4, fontFamily: 'monospace', fontSize: 18 }}
        onChange={(e) => setV({ ...v, code: e.target.value.replace(/\D/g, '').slice(0, 6) })} />
    </div>
  );
  return (
    <Modal title={stop ? '🛑 긴급중단 — 2인 승인' : '▶ 긴급중단 해제 — 2인 승인'} onClose={onClose} width={640}>
      <div className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
        서로 다른 <b>관리자 2명</b>이 각자 ID와 <b>OTP 코드</b>를 입력해야 {stop ? '긴급중단이 실행' : '긴급중단이 해제'}됩니다. (둘 다 admin 권한 · OTP 등록 필수)
      </div>
      <div className="flex gap wrap" style={{ alignItems: 'stretch' }}>
        {panel('관리자 ①', a, setA)}
        {panel('관리자 ②', b, setB)}
      </div>
      {err && <div className="badge red" style={{ display: 'block', marginTop: 14, padding: '8px 12px', fontSize: 13 }}>⚠ {err}</div>}
      <div className="flex gap" style={{ marginTop: 18, justifyContent: 'flex-end' }}>
        <button className="logout-btn" style={{ padding: '9px 16px' }} onClick={onClose}>취소</button>
        <button className="login-btn" style={{ flex: 'none', padding: '9px 22px', ...(stop ? { background: 'var(--red)', borderColor: 'var(--red)' } : {}) }}
          disabled={!ready || busy} onClick={submit}>{busy ? '인증 중…' : (stop ? '🛑 긴급중단 실행' : '▶ 해제')}</button>
      </div>
    </Modal>
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

// 추이 차트 x축: 선택 범위(일수)에 맞춰 단위 라벨 — 1일=시간, 1주=요일, 1달=일, 1년=달, 5년=년/월.
function fmtTrendTick(ts, days) {
  const d = new Date(ts);
  if (days <= 1) return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });          // 시간
  if (days <= 7) return d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' }); // 요일
  if (days <= 31) return d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });             // 일
  if (days <= 366) return d.toLocaleDateString('ko-KR', { year: '2-digit', month: 'short' });             // 달
  return d.toLocaleDateString('ko-KR', { year: '2-digit', month: '2-digit' });                             // 년/월
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
              <>
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={(hist.points || []).map((p) => ({ t: fmtTrendTick(p.ts, days), avg: p.avg, max: p.max }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" />
                    <XAxis dataKey="t" tick={{ fontSize: 11 }} minTickGap={40} />
                    <YAxis tick={{ fontSize: 11 }} unit="℃" domain={['auto', 'auto']} />
                    <Tooltip contentStyle={{ background: '#0b1220', border: '1px solid #243049', fontSize: 12 }} />
                    <Line type="monotone" dataKey="avg" stroke="#22d3ee" dot={false} name="평균" isAnimationActive={false} />
                    <Line type="monotone" dataKey="max" stroke="#f87171" dot={false} name="최고" isAnimationActive={false} />
                    <Brush dataKey="t" height={22} stroke="#6366f1" travellerWidth={8} tickFormatter={() => ''} />
                  </LineChart>
                </ResponsiveContainer>
                <div className="muted" style={{ fontSize: 11, marginTop: 4, textAlign: 'center' }}>아래 막대를 드래그하면 구간을 좁혀 스크롤·확대해 볼 수 있습니다.</div>
              </>
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
  const [q, setQ] = useState('');
  const [view, setView] = useState('os'); // os | family
  const [power, setPower] = useState('all'); // all | on | off
  const [kind, setKind] = useState('all');   // all | vm | template
  const [vmList, setVmList] = useState(null); // { label, q:{os|family} }
  const params = { ...(scope ? { vcenterId: scope } : {}), ...(power !== 'all' ? { power } : {}), ...(kind !== 'all' ? { kind } : {}) };
  const { loading, data, error } = useTool('/tools/guest-os', params);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const term = q.trim().toLowerCase();
  const rows = (view === 'os' ? data.items : data.families).filter((r) => !term || (r.os || r.family).toLowerCase().includes(term));
  const countCell = (r, label, qq) => <button className="cell-link" title="대상 VM 보기 / CSV" onClick={() => setVmList({ label, q: qq })}>{r.total}</button>;
  const osCols = [
    { key: 'os', label: 'Guest OS (종류·버전)', render: (r) => <b>{r.os}</b> },
    { key: 'family', label: '계열', render: (r) => <span className="badge gray">{r.family}</span> },
    { key: 'total', label: 'VM 수', align: 'right', render: (r) => countCell(r, r.os, { os: r.os }) },
    { key: 'on', label: 'On', align: 'right', render: (r) => <span className="badge green">{r.on}</span> },
    { key: 'off', label: 'Off', align: 'right', render: (r) => <span className="badge gray">{r.off}</span> },
  ];
  const famCols = [
    { key: 'family', label: 'OS 계열', render: (r) => <b>{r.family}</b> },
    { key: 'total', label: 'VM 수', align: 'right', render: (r) => countCell(r, r.family, { family: r.family }) },
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
        <span style={{ width: 8 }} />
        <span className="muted" style={{ fontSize: 12 }}>전원</span>
        {[['all', '전체'], ['on', '켜짐'], ['off', '꺼짐']].map(([k, l]) => (
          <button key={k} className={power === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '6px 11px', fontSize: 12 }} onClick={() => setPower(k)}>{l}</button>
        ))}
        <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>종류</span>
        {[['all', '전체'], ['vm', 'VM'], ['template', '템플릿']].map(([k, l]) => (
          <button key={k} className={kind === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '6px 11px', fontSize: 12 }} onClick={() => setKind(k)}>{l}</button>
        ))}
      </div>
      <DataTable columns={view === 'os' ? osCols : famCols} rows={rows} initialSort={{ key: 'total', dir: 'desc' }} />
      {vmList && <GuestOsVmsModal label={vmList.label} params={{ ...params, ...vmList.q }} onClose={() => setVmList(null)} />}
    </>
  );
}

function GuestOsVmsModal({ label, params, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    const qs = new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v)).toString();
    fetchJson(`/tools/guest-os/vms${qs ? `?${qs}` : ''}`).then(setD).catch((e) => setErr(e.message));
  }, []);
  const exportCsv = () => {
    const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ['vm', 'vcenter', 'cluster', 'host', 'cpu', 'memory_gb', 'disk_gb', 'ip', 'power'];
    const lines = [head.join(',')];
    for (const r of (d?.items || [])) lines.push([r.name, r.vcenterId, r.cluster, r.host, r.cpu, r.memGB, r.diskGB, r.ip, r.powerState === 'POWERED_ON' ? 'On' : 'Off'].map(esc).join(','));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `guestos-${String(label).replace(/[^a-zA-Z0-9._-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url);
  };
  const cols = [
    { key: 'name', label: 'VM', render: (r) => <VmLink name={r.name} vcenterId={r.vcenterId} label={r.name} /> },
    { key: 'vcenterId', label: 'vCenter', render: (r) => <span className="muted">{r.vcenterId}</span> },
    { key: 'cluster', label: '클러스터', render: (r) => <span style={{ fontSize: 12 }}>{r.cluster || '—'}</span> },
    { key: 'host', label: '호스트', render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.host || '—'}</span> },
    { key: 'cpu', label: 'CPU', align: 'right', render: (r) => `${r.cpu}` },
    { key: 'memGB', label: 'MEM(GB)', align: 'right' },
    { key: 'diskGB', label: 'DISK(GB)', align: 'right' },
    { key: 'ip', label: 'IP', render: (r) => <span style={{ fontSize: 12 }}>{r.ip || '—'}</span> },
    { key: 'powerState', label: '전원', render: (r) => (r.powerState === 'POWERED_ON' ? <span className="badge green">On</span> : <span className="badge gray">Off</span>) },
  ];
  return (
    <Modal title={`대상 VM — ${label}`} onClose={onClose} width={1040} resizable minWidth={620} minHeight={380}>
      {err ? <ErrorBox message={err} /> : !d ? <Loading /> : (
        <>
          <div className="flex between" style={{ alignItems: 'center', marginBottom: 10 }}>
            <span className="muted" style={{ fontSize: 13 }}>대상 VM <b>{d.total.toLocaleString()}</b>개{d.total > (d.items?.length || 0) ? ` (상위 ${d.items.length} 표시)` : ''}</span>
            <button className="logout-btn" style={{ flex: 'none', padding: '7px 14px' }} disabled={!d.items?.length} onClick={exportCsv}>⬇ CSV 내보내기</button>
          </div>
          <DataTable columns={cols} rows={d.items || []} initialSort={{ key: 'name', dir: 'asc' }} />
        </>
      )}
    </Modal>
  );
}

function RealOs({ scope }) {
  const [st, setSt] = useState(null);     // /admin/os-scan status+settings
  const [rows, setRows] = useState(null);
  const [mm, setMm] = useState(false);    // 불일치만
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);

  const loadStatus = () => fetchJson('/admin/os-scan').then((r) => { setSt((cur) => ({ ...(cur || {}), ...r, settings: cur?.dirty ? cur.settings : r.settings })); setErr(null); }).catch((e) => setErr(e.message));
  const loadResults = () => fetchJson(`/admin/os-scan/results?${new URLSearchParams({ ...(scope ? { vcenterId: scope } : {}), ...(mm ? { mismatch: '1' } : {}) })}`).then((r) => setRows(r.items || [])).catch(() => setRows([]));
  useEffect(() => { loadStatus(); /* eslint-disable-next-line */ }, []);
  useEffect(() => { loadResults(); /* eslint-disable-next-line */ }, [scope, mm]);

  if (err) return <ErrorBox message={err} />;
  if (!st) return <Loading />;
  const s = st.settings || {};
  const setS = (patch) => setSt((cur) => ({ ...cur, dirty: true, settings: { ...cur.settings, ...patch } }));

  const saveSettings = async () => { setBusy('save'); setMsg(null); try { const r = await putJson('/admin/os-scan/settings', s); setSt((c) => ({ ...c, ...r, dirty: false })); setMsg('저장됨'); } catch (e) { setMsg(e.message); } finally { setBusy(''); } };
  const runNow = async () => { setBusy('run'); setMsg(null); try { const r = await postJson('/admin/os-scan/run', scope ? { vcenterId: scope } : {}); setMsg(r.ok ? `스캔 완료 — 탐지 ${r.found ?? 0}건` : `오류: ${r.reason || '실패'}`); await loadStatus(); await loadResults(); } catch (e) { setMsg(e.message); } finally { setBusy(''); } };
  const exportCsv = async () => {
    const qs = new URLSearchParams({ ...(scope ? { vcenterId: scope } : {}), ...(mm ? { mismatch: '1' } : {}) }).toString();
    const res = await fetch(`/api/admin/os-scan/results.csv${qs ? `?${qs}` : ''}`, { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} });
    const blob = await res.blob(); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `real-os-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  const sum = st.summary || {};
  const cols = [
    { key: 'vmName', label: 'VM', render: (r) => <VmLink name={r.vmName} vcenterId={r.vcenterId} label={r.vmName} /> },
    { key: 'vcenterId', label: 'vCenter', render: (r) => <span className="muted">{r.vcenterId}</span> },
    { key: 'host', label: '호스트', render: (r) => <span className="muted" style={{ fontSize: 12, maxWidth: 160, display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }} title={r.host}>{r.host || '—'}</span> },
    { key: 'esxiGuestOS', label: 'ESXi 보고', render: (r) => <span style={{ fontSize: 12 }}>{r.esxiGuestOS || '—'}</span> },
    { key: 'os', label: '실제 OS', render: (r) => (r.os ? <b>{r.os}</b> : <span className="badge red" title={r.error}>실패</span>) },
    { key: 'osVersion', label: '버전', render: (r) => r.osVersion || '—' },
    { key: 'family', label: '계열', render: (r) => r.family ? <span className="badge gray">{r.family}</span> : '—' },
    { key: 'mismatch', label: '불일치', sortValue: (r) => (r.mismatch ? 1 : 0), render: (r) => (r.mismatch ? <span className="badge amber">불일치</span> : (r.os ? <span className="badge green">일치</span> : '—')) },
    { key: 'at', label: '스캔', render: (r) => <span className="muted" style={{ fontSize: 11 }}>{r.at ? new Date(r.at).toLocaleString('ko-KR') : '—'}</span> },
  ];

  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="스캔된 VM" value={(sum.scanned ?? 0).toLocaleString()} meta={st.lastRun ? `마지막 ${new Date(st.lastRun).toLocaleString('ko-KR')}` : '아직 실행 안 함'} />
        <Card label="불일치(ESXi≠실제)" value={sum.mismatches ?? 0} accent={sum.mismatches ? 'var(--amber)' : ''} meta="ESXi 보고와 실제 설치 OS 차이" />
        <Card label="탐지 실패" value={sum.errors ?? 0} accent={sum.errors ? 'var(--red)' : ''} meta="계정/Tools/권한 등" />
        <Card label="계열 분포" value={(sum.byFamily || []).length} meta={(sum.byFamily || []).slice(0, 3).map((f) => `${f.family} ${f.count}`).join(' · ')} />
      </div>

      <div className="card" style={{ padding: 14, marginBottom: 12 }}>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>게스트 OS에서 <code>/etc/os-release</code>·<code>/etc/redhat-release</code>(Linux)·<code>Win32_OperatingSystem</code>(Windows)를 직접 읽어 <b>실제 설치 OS</b>를 확인합니다(ESXi 보고값과 별개). 계정은 <b>설정 › GPU 게스트 수집</b>의 OS별 계정을 사용합니다. 상단 <b>vCenter 선택</b>이 스캔 범위입니다.</p>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 14 }}>
          <label className="flex gap" style={{ alignItems: 'center', cursor: 'pointer' }}><input type="checkbox" checked={!!s.enabled} onChange={(e) => setS({ enabled: e.target.checked })} /> <b>주기 스캔</b></label>
          <span className="muted">주기</span><input className="input" type="number" min={5} style={{ width: 90 }} value={s.intervalMin} onChange={(e) => setS({ intervalMin: e.target.value })} /><span className="muted">분</span>
          <span className="muted">최대</span><input className="input" type="number" min={1} style={{ width: 80 }} value={s.maxVms} onChange={(e) => setS({ maxVms: e.target.value })} /><span className="muted">대/회</span>
          <span className="muted">재스캔</span><input className="input" type="number" min={0} style={{ width: 70 }} value={s.rescanDays} onChange={(e) => setS({ rescanDays: e.target.value })} /><span className="muted">일(0=안함)</span>
          <span className="muted">동시</span><input className="input" type="number" min={1} max={16} style={{ width: 56 }} value={s.concurrency} onChange={(e) => setS({ concurrency: e.target.value })} />
        </div>
        <div className="flex gap" style={{ marginTop: 12, alignItems: 'center' }}>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={busy === 'save'} onClick={saveSettings}>설정 저장</button>
          <button className="logout-btn" style={{ padding: '8px 16px' }} disabled={busy === 'run'} onClick={runNow}>{busy === 'run' ? '스캔 중…' : `지금 스캔 (${scope || '전체 vCenter'})`}</button>
          {st.lastErr ? <span className="muted" style={{ fontSize: 12, color: 'var(--amber)' }}>최근 오류: {st.lastErr.slice(0, 60)}</span> : null}
          {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
        </div>
      </div>

      <div className="flex gap wrap" style={{ marginBottom: 8, alignItems: 'center' }}>
        <button className={mm ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setMm((v) => !v)}>{mm ? '불일치만 ✓' : '불일치만 보기'}</button>
        <span className="muted" style={{ fontSize: 12 }}>{rows ? `${rows.length}건` : ''}</span>
        <button className="logout-btn" style={{ flex: 'none', padding: '7px 14px', marginLeft: 'auto' }} disabled={!rows?.length} onClick={exportCsv}>⬇ CSV 내보내기</button>
      </div>
      {!rows ? <Loading /> : rows.length === 0 ? <div className="card"><span className="muted">{mm ? '불일치 VM이 없습니다.' : '스캔 결과가 없습니다. ‘지금 스캔’을 실행하세요(계정은 GPU 게스트 수집 설정 사용).'}</span></div>
        : <DataTable columns={cols} rows={rows} initialSort={{ key: 'mismatch', dir: 'desc' }} />}
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

// 전력 단위: 1,000 넘으면 상위 단위(kW→MW→GW).
const pdec1 = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });
function fmtWatts(w) {
  if (w == null || !Number.isFinite(Number(w))) return '—';
  const a = Math.abs(w);
  if (a >= 1e9) return `${pdec1(w / 1e9)} GW`;
  if (a >= 1e6) return `${pdec1(w / 1e6)} MW`;
  if (a >= 1e3) return `${pdec1(w / 1e3)} kW`;
  return `${Math.round(w).toLocaleString()} W`;
}
function fmtKwh(kwh) {
  if (kwh == null || !Number.isFinite(Number(kwh))) return '—';
  const a = Math.abs(kwh);
  if (a >= 1e6) return `${pdec1(kwh / 1e6)} GWh`;
  if (a >= 1e3) return `${pdec1(kwh / 1e3)} MWh`;
  return `${pdec1(kwh)} kWh`;
}

/** 가로 막대(비중 표시) — recharts 없이 CSS만으로. */
function Bar({ frac, color = 'var(--accent-2,#22d3ee)' }) {
  return (
    <div style={{ background: 'rgba(148,163,184,.14)', borderRadius: 4, height: 8, overflow: 'hidden', minWidth: 60 }}>
      <div style={{ width: `${Math.max(2, Math.round((frac || 0) * 100))}%`, height: '100%', background: color, borderRadius: 4 }} />
    </div>
  );
}

function PowerMap({ scope }) {
  const { loading, data, error } = useTool('/insights/power-breakdown', scope ? { vcenterId: scope } : {});
  const [view, setView] = useState('vcenter'); // vcenter | model | region | server
  const [q, setQ] = useState('');
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  if (!data) return null;
  const cur = data.config?.currency || '₩';
  const won = (v) => `${cur}${Number(v || 0).toLocaleString()}`;
  const maxW = Math.max(1, ...(data.byVcenter || []).map((r) => r.watts), ...(data.byModel || []).map((r) => r.watts));

  const csv = () => {
    const head = ['서버', '모델', '서비스태그', 'vCenter', '지역', '수집원', 'W', '매핑'];
    const rows = (data.servers || []).map((s) => [s.name, s.model, s.serviceTag, s.vcenterId, s.region, s.source, s.watts, s.mapped ? 'O' : 'X']);
    const body = [head, ...rows].map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `power-breakdown-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const term = q.trim().toLowerCase();
  const servers = (data.servers || []).filter((s) => !term
    || s.name.toLowerCase().includes(term) || (s.model || '').toLowerCase().includes(term)
    || (s.serviceTag || '').toLowerCase().includes(term) || (s.vcenterId || '').toLowerCase().includes(term));

  const TABS = [['vcenter', `법인별 (${(data.byVcenter || []).length})`], ['model', `모델별 (${(data.byModel || []).length})`], ['region', `지역별 (${(data.byRegion || []).length})`], ['server', `서버 (${data.totalServers})`]];

  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="총 측정 전력" value={fmtWatts(data.totals.watts)} accent="var(--amber)" meta={`서버 ${data.totalServers}대 측정`} />
        <Card label="월 에너지 / 요금" value={fmtKwh(data.totals.kwhMonth)} meta={`월 ${won(data.totals.costMonth)} · PUE ${data.config.pue}`} />
        <Card label="연 전기요금(추정)" value={won(data.totals.costYear)} accent="#fbbf24" meta={`연 CO₂ ${Number(data.totals.co2YearKg || 0).toLocaleString()} kg`} />
        <Card label="법인 매핑" value={`${data.mappedServers} / ${data.totalServers}`} accent={data.unmappedServers ? 'var(--red)' : 'var(--green)'}
          meta={data.unmappedServers ? `미매핑 ${data.unmappedServers}대(${fmtWatts(data.unmappedWatts)})` : '전부 vCenter 매핑됨'} />
      </div>
      {data.unmappedServers > 0 && (
        <div className="card" style={{ padding: '10px 14px', marginBottom: 12, borderLeft: '3px solid var(--amber)' }}>
          <div style={{ fontSize: 13 }}>⚠ {data.unmappedServers}대({fmtWatts(data.unmappedWatts)})는 ESXi 호스트와 매핑되지 않아 <b>'(미매핑)'</b>으로 집계됩니다. 측정 전력 합계에는 포함됩니다.</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>자동 매핑은 ① iDRAC 호스트명 = ESXi 호스트명, ② Dell 서비스태그 일치로 시도합니다. 설정 → 수집(iDRAC)에서 서버의 <b>hostNames</b>에 해당 ESXi 호스트명을 넣으면 그 법인으로 귀속됩니다.</div>
        </div>
      )}
      <div className="flex between wrap gap" style={{ marginBottom: 10, alignItems: 'center' }}>
        <div className="flex gap" style={{ flexWrap: 'wrap' }}>
          {TABS.map(([k, label]) => (
            <button key={k} className={view === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView(k)}>{label}</button>
          ))}
        </div>
        <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={csv}>CSV</button>
      </div>

      {view === 'vcenter' && (
        <div className="table-wrap" style={{ maxHeight: '60vh' }}>
          <table>
            <thead><tr><th>법인(vCenter)</th><th>지역</th><th style={{ textAlign: 'right' }}>서버</th><th style={{ textAlign: 'right' }}>현재 전력</th><th style={{ width: 160 }}>비중</th><th style={{ textAlign: 'right' }}>월 요금</th><th style={{ textAlign: 'right' }}>연 요금</th></tr></thead>
            <tbody>
              {data.byVcenter.map((r) => (
                <tr key={r.vcId}>
                  <td><b>{r.vcId}</b></td><td className="muted">{r.region}</td>
                  <td style={{ textAlign: 'right' }}>{r.servers}</td>
                  <td style={{ textAlign: 'right' }}><b>{fmtWatts(r.watts)}</b></td>
                  <td><Bar frac={r.watts / maxW} color={r.vcId === '(미매핑)' ? 'var(--red)' : undefined} /></td>
                  <td style={{ textAlign: 'right' }}>{won(r.costMonth)}</td>
                  <td style={{ textAlign: 'right' }} className="muted">{won(r.costYear)}</td>
                </tr>
              ))}
              {!data.byVcenter.length && <tr><td colSpan={7} className="center muted" style={{ padding: 20 }}>측정된 전력이 없습니다.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {view === 'model' && (
        <div className="table-wrap" style={{ maxHeight: '60vh' }}>
          <table>
            <thead><tr><th>모델</th><th style={{ textAlign: 'right' }}>서버</th><th style={{ textAlign: 'right' }}>현재 전력</th><th style={{ width: 160 }}>비중</th><th style={{ textAlign: 'right' }}>대당 평균</th><th style={{ textAlign: 'right' }}>연 요금</th></tr></thead>
            <tbody>
              {data.byModel.map((r) => (
                <tr key={r.model}>
                  <td><b>{r.model}</b></td>
                  <td style={{ textAlign: 'right' }}>{r.servers}</td>
                  <td style={{ textAlign: 'right' }}><b>{fmtWatts(r.watts)}</b></td>
                  <td><Bar frac={r.watts / maxW} color="var(--green)" /></td>
                  <td style={{ textAlign: 'right' }} className="muted">{fmtWatts(r.watts / r.servers)}</td>
                  <td style={{ textAlign: 'right' }} className="muted">{won(r.costYear)}</td>
                </tr>
              ))}
              {!data.byModel.length && <tr><td colSpan={6} className="center muted" style={{ padding: 20 }}>모델 정보가 없습니다.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {view === 'region' && (
        <div className="table-wrap" style={{ maxHeight: '60vh' }}>
          <table>
            <thead><tr><th>지역</th><th style={{ textAlign: 'right' }}>vCenter</th><th style={{ textAlign: 'right' }}>서버</th><th style={{ textAlign: 'right' }}>현재 전력</th><th style={{ textAlign: 'right' }}>연 요금</th></tr></thead>
            <tbody>
              {data.byRegion.map((r) => (
                <tr key={r.region}>
                  <td><b>{r.region}</b></td><td style={{ textAlign: 'right' }}>{r.vcenters}</td>
                  <td style={{ textAlign: 'right' }}>{r.servers}</td>
                  <td style={{ textAlign: 'right' }}><b>{fmtWatts(r.watts)}</b></td>
                  <td style={{ textAlign: 'right' }} className="muted">{won(r.costYear)}</td>
                </tr>
              ))}
              {!data.byRegion.length && <tr><td colSpan={5} className="center muted" style={{ padding: 20 }}>—</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {view === 'server' && (
        <>
          <div className="flex" style={{ marginBottom: 8 }}>
            <SearchBox className="input" style={{ maxWidth: 320 }} placeholder="서버/모델/서비스태그/vCenter 검색" value={q} onChange={setQ} />
          </div>
          <ResultCount total={(data.servers || []).length} shown={servers.length} label="서버" filtered={!!term} />
          <div className="table-wrap" style={{ maxHeight: '60vh' }}>
            <table>
              <thead><tr><th>서버</th><th>모델</th><th>서비스태그</th><th>법인(vCenter)</th><th>수집</th><th style={{ textAlign: 'right' }}>현재 전력</th></tr></thead>
              <tbody>
                {servers.map((s, i) => (
                  <tr key={`${s.name}-${i}`}>
                    <td><b>{s.name}</b></td>
                    <td className="muted" style={{ fontSize: 12 }}>{s.model}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{s.serviceTag || '—'}</td>
                    <td>{s.mapped ? s.vcenterId : <span className="badge red">미매핑</span>}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{s.source}</td>
                    <td style={{ textAlign: 'right' }}>{fmtWatts(s.watts)}</td>
                  </tr>
                ))}
                {!servers.length && <tr><td colSpan={6} className="center muted" style={{ padding: 20 }}>표시할 서버가 없습니다.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.7 }}>
        측정된 모든 전력원(iDRAC 직접 · OME · 원격 수집서버)을 서버 단위로 집계합니다. 모델·서비스태그는 iDRAC Redfish 인벤토리에서 읽으므로 ESXi 매핑이 없어도 모델별 분석이 가능합니다.
      </div>
    </>
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

/** VM의 GPU 사용 방식 배지(혼합이면 vGPU/패스쓰루 장수 분리 표기). */
function VmGpuModeBadge({ gpu }) {
  if (!gpu) return <span className="muted">—</span>;
  if (gpu.type === 'mixed') return <span><span className="badge green">vGPU {gpu.vgpu}</span> <span className="badge amber" style={{ marginLeft: 4 }}>패스쓰루 {gpu.passthrough}</span></span>;
  const [l, c] = GPU_MODE[gpu.type] || ['—', 'gray'];
  return <span className={`badge ${c}`}>{l}</span>;
}

/** GPU가 할당된 VM 목록 모달 — 어떤 VM이 어떤 방식·프로파일로 GPU를 쓰는지. */
function GpuVmsModal({ title, params, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    const qs = new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v)).toString();
    fetchJson(`/tools/gpu/vms${qs ? `?${qs}` : ''}`).then(setD).catch((e) => setErr(e.message));
  }, []);
  return (
    <Modal title={title} onClose={onClose} width={1000} resizable minWidth={560} minHeight={380}>
      {err ? <ErrorBox message={err} /> : !d ? <Loading /> : (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>GPU 할당 VM <b>{d.total}</b>개 · 어떤 VM이 어떤 방식/프로파일로 GPU를 사용하는지 보여줍니다. <span style={{ opacity: 0.8 }}>사용률·메모리는 게스트 OS(nvidia-smi) 수집값 — 전원 ON·VMware Tools·GPU 게스트 수집 계정이 있어야 표시됩니다(패스쓰루·vGPU 공통).</span></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>VM</th><th>법인</th><th>호스트</th><th>GPU 모델</th><th>사용 방식</th><th>프로파일</th><th style={{ textAlign: 'right' }}>장수</th><th style={{ textAlign: 'right' }}>사용률</th><th style={{ textAlign: 'right' }}>메모리</th><th>전원</th></tr></thead>
              <tbody>
                {d.vms.length === 0 && <tr><td colSpan={10} className="center muted" style={{ padding: 20 }}>GPU 할당 VM이 없습니다.</td></tr>}
                {d.vms.map((v) => (
                  <tr key={v.id}>
                    <td><VmLink name={v.name} vcenterId={v.vcenterId} label={v.name} /></td>
                    <td className="muted">{v.vcenterId}</td>
                    <td className="muted" style={{ fontSize: 12, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.host || ''}>{v.host || '—'}</td>
                    <td style={{ fontSize: 12 }}>{v.model || '—'}</td>
                    <td><VmGpuModeBadge gpu={v.gpu} /></td>
                    <td className="muted" style={{ fontSize: 12 }}>{v.gpu?.profile || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{v.gpu?.count ?? '—'}</td>
                    <td style={{ textAlign: 'right' }}>{v.guestUtilPct == null ? <span className="muted" title={v.powerState === 'POWERED_ON' ? 'GPU 게스트 수집 미설정/미수집 — 설정 › GPU 게스트 수집에서 해당 VM 계정 등록 후 수집됩니다' : '전원 OFF — 게스트에서 사용률 수집 불가'}>—</span> : <UsageCell pct={v.guestUtilPct} />}</td>
                    <td style={{ textAlign: 'right' }}>{v.guestMemPct == null ? <span className="muted" title={v.powerState === 'POWERED_ON' ? 'GPU 게스트 수집 미설정/미수집 — 설정 › GPU 게스트 수집에서 계정 등록 후 수집됩니다' : '전원 OFF — 수집 불가'}>—</span> : <UsageCell pct={v.guestMemPct} />}</td>
                    <td>{v.powerState === 'POWERED_ON' ? <span className="badge green">On</span> : <span className="badge gray">Off</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

function Gpu({ scope }) {
  const [bust, setBust] = useState(0);       // '지금 수집' 후 재조회 트리거
  const [collecting, setCollecting] = useState(false);
  const { loading, data, error } = useTool('/tools/gpu', { ...(scope ? { vcenterId: scope } : {}), _b: bust });
  const collectNow = async () => {
    setCollecting(true);
    try { await postJson('/admin/gpu/collect-util', {}); } catch { /* best effort */ }
    setCollecting(false); setBust((b) => b + 1);
  };
  const [exportOpen, setExportOpen] = useState(false);
  // 현재 상태(스냅샷) CSV·JSON 내려받기(vCenter 스코프 반영, zip 인식).
  const exportGpu = async (fmt, vcId) => {
    const vc = vcId ?? scope;
    const q = vc ? `?vcenterId=${encodeURIComponent(vc)}` : '';
    const res = await fetch(`/api/tools/gpu.${fmt}${q}`, { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} });
    await saveResponseAsFile(res, `gpu-${new Date().toISOString().slice(0, 10)}.${fmt}`);
  };
  const [view, setView] = useState('host'); // host | cluster | vc | model
  const [hist, setHist] = useState(null);   // { level, key, days, points, synthesized }
  const [vmList, setVmList] = useState(null); // { title, params } for GpuVmsModal
  const [days, setDays] = useState(7);
  const openHist = async (level, key) => {
    setHist({ level, key, loading: true });
    const r = await fetchJson(`/tools/gpu/history?level=${level}&key=${encodeURIComponent(key)}&days=${days}`).catch(() => null);
    setHist(r ? { ...r } : { error: true });
  };
  const [mode, setMode] = useState(''); // '' | vgpu | passthrough | vsga
  const [modelFilter, setModelFilter] = useState(''); // '' = 전체 모델, 아니면 특정 GPU 모델
  const [power, setPower] = useState(''); // '' | on(켜진 VM 있는 호스트) | off(꺼진 VM 있는 호스트)
  useEffect(() => { if (hist && hist.key) openHist(hist.level, hist.key); /* eslint-disable-next-line */ }, [days]);
  // 선택한 사용 방식(mode) 필터에 해당하는 GPU가 0개면 '전체'로 자동 복구(빈 표 혼란 방지).
  useEffect(() => { if (data && mode && (data.byMode?.[mode] ?? 0) === 0) setMode(''); }, [data, mode]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;

  let items = mode ? data.items.filter((h) => h.mode === mode) : data.items;
  if (modelFilter) items = items.filter((h) => h.model === modelFilter);
  // 전원 필터: 켜진/꺼진 GPU 할당 VM이 있는 호스트만.
  if (power === 'on') items = items.filter((h) => (h.assignedVmsOn || 0) > 0);
  else if (power === 'off') items = items.filter((h) => (h.assignedVmsOff || 0) > 0);

  // Aggregate by cluster / vCenter from per-host items. 사용률 미보고(패스쓰루) 호스트도
  // GPU 장수·할당 VM·방식 집계에는 포함하고, 평균/최고 사용률만 보고 호스트로 계산한다.
  const aggregate = (keyFn, labelFn) => {
    const m = new Map();
    for (const h of items) {
      const k = keyFn(h);
      const g = m.get(k) || { key: k, name: labelFn(h), hosts: 0, sum: 0, util: 0, max: 0, gpus: 0, assignedVms: 0, modes: {}, models: {} };
      g.hosts++; g.gpus += h.count; g.assignedVms += h.assignedVms || 0;
      g.models[h.model] = (g.models[h.model] || 0) + h.count;
      for (const [md, n] of Object.entries(h.modes || {})) g.modes[md] = (g.modes[md] || 0) + n;
      if (h.utilPct != null) { g.util++; g.sum += h.utilPct; g.max = Math.max(g.max, h.utilPct); }
      m.set(k, g);
    }
    return [...m.values()].map((g) => ({
      key: g.key, name: g.name, hosts: g.hosts, gpus: g.gpus, assignedVms: g.assignedVms, modes: g.modes, models: g.models,
      sub: `${g.hosts} 호스트 · GPU ${g.gpus}`, avg: g.util ? Math.round(g.sum / g.util) : null, max: g.max, level: view,
    }));
  };

  const hostRows = items.map((h) => ({
    key: h.id, name: h.host, vcenterId: h.vcenterId, sub: `${h.vcenterId} / ${h.cluster || '-'} · ${h.model}`,
    model: h.model, count: h.count, memGB: h.memGB, mode: h.mode, modes: h.modes, utilSource: h.utilSource, avg: h.utilPct, max: h.utilPct, util: h.utilPct, assignedVms: h.assignedVms || 0, assignedVmsOn: h.assignedVmsOn || 0, assignedVmsOff: h.assignedVmsOff || 0, assignedVmNames: h.assignedVmNames || [], level: 'host',
  }));
  // 법인 × GPU 모델별 수량 집계: 어떤 법인에 어떤 GPU 카드가 몇 장 설치됐는지.
  const modelAgg = () => {
    const m = new Map();
    for (const h of items) {
      const k = `${h.vcenterId}|${h.model}`;
      const g = m.get(k) || { key: k, vcenterId: h.vcenterId, model: h.model, gpus: 0, hosts: 0, assignedVms: 0, memGB: h.memGB || 0, modeSet: new Set() };
      g.gpus += h.count; g.hosts++; g.assignedVms += h.assignedVms || 0; if (h.mode) g.modeSet.add(h.mode); g.memGB = Math.max(g.memGB, h.memGB || 0); m.set(k, g);
    }
    return [...m.values()].map((g) => ({ ...g, modes: [...g.modeSet] }));
  };

  const rows = view === 'host' ? hostRows
    : view === 'cluster' ? aggregate((h) => `${h.vcenterId}|${h.cluster || 'standalone'}`, (h) => `${h.vcenterId} / ${h.cluster || 'standalone'}`)
      : view === 'model' ? modelAgg()
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
    { key: 'assignedVms', label: '할당 VM', sortValue: (r) => r.assignedVms, render: (r) => (r.assignedVms ? (
      <div style={{ minWidth: 160 }}>
        <button className="cell-link" onClick={() => setVmList({ title: `GPU 할당 VM — ${r.name}`, params: { host: r.name } })}>{r.assignedVms}대</button>
        <span className="muted" style={{ fontSize: 11, marginLeft: 6 }} title="GPU 할당 VM의 전원 상태">🟢{r.assignedVmsOn || 0} ⚫{r.assignedVmsOff || 0}</span>
        {(r.assignedVmNames || []).length > 0 && (
          <div className="muted" style={{ fontSize: 11, marginTop: 2, lineHeight: 1.5, whiteSpace: 'normal', wordBreak: 'break-all' }} title={(r.assignedVmNames || []).map((x) => `${x.name || x} ${(x.on ?? true) ? '(On)' : '(Off)'}`).join(', ')}>
            {(r.assignedVmNames || []).slice(0, 6).map((x, i) => {
              const nm = x.name || x; const on = x.on ?? true;
              return (
                <span key={i}>{i > 0 && ', '}<span title={on ? 'On' : 'Off'} style={{ color: on ? 'var(--green)' : 'var(--text-faint)' }}>{on ? '🟢' : '⚫'}</span> <VmLink name={nm} vcenterId={r.vcenterId} label={nm} /></span>
              );
            })}
            {(r.assignedVmNames || []).length > 6 && <span> 외 {(r.assignedVmNames || []).length - 6}대</span>}
          </div>
        )}
      </div>
    ) : <span className="muted">0</span>) },
    { key: 'hist', label: '추이', render: (r) => <button className="tab" onClick={() => openHist('host', r.key)}>5년 추이</button> },
  ];
  const aggCols = [
    { key: 'name', label: '클러스터', render: (r) => <button className="cell-link" onClick={() => openHist(r.level, r.key)}>{r.name}</button> },
    { key: 'sub', label: '구분', render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.sub}</span> },
    { key: 'avg', label: '평균 사용률', render: (r) => (r.avg == null ? <span className="muted">—</span> : <UsageCell pct={r.avg} />) },
    { key: 'max', label: '최고 %', align: 'right', render: (r) => <b>{r.max}%</b> },
    { key: 'hist', label: '추이', render: (r) => <button className="tab" onClick={() => openHist(r.level, r.key)}>5년 추이</button> },
  ];
  // 법인별: 법인에 GPU가 몇 장·어떤 방식·할당 VM 몇 개.
  const vcCols = [
    { key: 'name', label: '법인(vCenter)', render: (r) => <button className="cell-link" onClick={() => openHist(r.level, r.key)}>{r.name}</button> },
    { key: 'gpus', label: 'GPU 장수', align: 'right', render: (r) => <b style={{ color: 'var(--accent)' }}>{r.gpus}</b> },
    { key: 'models', label: 'GPU 종류(장수)', sortValue: (r) => Object.keys(r.models || {}).length, render: (r) => Object.entries(r.models || {}).sort((a, b) => b[1] - a[1]).map(([md, n]) => <span key={md} className="badge gray" style={{ marginRight: 4, marginBottom: 2, display: 'inline-block' }}>{md} <b style={{ color: 'var(--accent)' }}>×{n}</b></span>) },
    { key: 'hosts', label: '호스트', align: 'right' },
    { key: 'modes', label: '사용 방식', sortValue: (r) => Object.keys(r.modes || {}).join(','), render: (r) => Object.entries(r.modes || {}).map(([m, n]) => <span key={m} className={`badge ${GPU_MODE[m]?.[1] || 'gray'}`} style={{ marginRight: 4 }}>{GPU_MODE[m]?.[0] || m} {n}</span>) },
    { key: 'assignedVms', label: '할당 VM', align: 'right', render: (r) => (r.assignedVms ? <button className="cell-link" onClick={() => setVmList({ title: `GPU 할당 VM — ${r.name}`, params: { vcenterId: r.key } })}>{r.assignedVms}</button> : <span className="muted">0</span>) },
    { key: 'avg', label: '평균 사용률', render: (r) => (r.avg == null ? <span className="muted">—</span> : <UsageCell pct={r.avg} />) },
  ];
  // 법인·모델별: 어떤 법인에 어떤 GPU 카드가 몇 장·할당 VM 몇 개.
  const modelCols = [
    { key: 'vcenterId', label: '법인(vCenter)', render: (r) => <b>{r.vcenterId}</b> },
    { key: 'model', label: 'GPU 모델' },
    { key: 'gpus', label: 'GPU 장수', align: 'right', render: (r) => <b style={{ color: 'var(--accent)' }}>{r.gpus}</b> },
    { key: 'hosts', label: '호스트 수', align: 'right' },
    { key: 'memGB', label: 'VRAM', align: 'right', render: (r) => `${r.memGB} GB` },
    { key: 'modes', label: '사용 방식', sortValue: (r) => (r.modes || []).join(','), render: (r) => (r.modes || []).map((m) => <GpuModeBadge key={m} mode={m} />) },
    { key: 'assignedVms', label: '할당 VM', align: 'right', render: (r) => (r.assignedVms ? <button className="cell-link" onClick={() => setVmList({ title: `GPU 할당 VM — ${r.vcenterId} · ${r.model}`, params: { vcenterId: r.vcenterId, model: r.model } })}>{r.assignedVms}</button> : <span className="muted">0</span>) },
  ];

  return (
    <>
      {/* 상단 요약 — 선택 범위에서 몇 개 호스트의 몇 개 VM이 GPU를 사용하는지 한눈에 */}
      <div className="card" style={{ padding: '12px 16px', marginBottom: 14, borderLeft: '3px solid var(--accent,#2563eb)' }}>
        <span style={{ fontSize: 15 }}>
          <b style={{ color: 'var(--accent)' }}>{scope || '전체'}</b> 범위 —
          GPU 호스트 <b>{data.hostsWithGpu}</b>대에서 VM <b>{data.gpuVmCount ?? 0}</b>대가 GPU 사용 중
          <span className="muted" style={{ fontSize: 13 }}>{' '}(총 GPU {data.totalGpus}장 · vGPU {data.byMode?.vgpu ?? 0} · 패스쓰루 {data.byMode?.passthrough ?? 0})</span>
        </span>
      </div>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label={`${scope || '전체'} 범위 · 총 GPU`} value={data.totalGpus} accent="var(--accent)" meta={`설치된 GPU 장수`} />
        <Card label="GPU 호스트" value={data.hostsWithGpu} accent="var(--accent-2)" meta="GPU 설치 ESXi 호스트" />
        <Card label="GPU 사용 VM" value={data.gpuVmCount ?? 0} accent="var(--green)" meta="GPU 할당된 VM 수" />
        <Card label="평균 GPU 사용률" value={data.avgUtilPct == null ? '—' : `${data.avgUtilPct}%`} meta={data.utilReporting ? `${data.utilReporting} 호스트 보고` : '사용률 미보고'} />
        <Card label="vGPU" value={data.byMode?.vgpu ?? 0} accent="var(--green)" meta="공유 다이렉트(GRID)" />
        <Card label="패스쓰루" value={data.byMode?.passthrough ?? 0} accent="var(--amber)" meta="DirectPath I/O" />
        {(data.byMode?.vsga ?? 0) > 0 && <Card label="vSGA" value={data.byMode.vsga} meta="공유(소프트)" />}
      </div>
      {/* GPU 모델(종류)별 총 장수 합계 — 클릭하면 그 GPU가 설치된 호스트만 표시 */}
      {(data.byModel || []).length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>GPU 모델별 합계 (총 {data.totalGpus}장 · {data.byModel.length}종) <span style={{ opacity: 0.8 }}>— 박스를 클릭하면 해당 GPU 설치 호스트만 봅니다</span></div>
          <div className="flex gap wrap">
            {data.byModel.map((m) => {
              const active = view === 'host' && modelFilter === m.model;
              const pick = () => { if (active) { setModelFilter(''); } else { setView('host'); setModelFilter(m.model); } };
              return (
                <div key={m.model} role="button" tabIndex={0} onClick={pick}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } }}
                  className="card" title={active ? '필터 해제' : `${m.model} 설치 호스트만 보기`}
                  style={{ padding: '8px 14px', minWidth: 120, flex: 'none', cursor: 'pointer',
                    outline: active ? '2px solid var(--accent)' : 'none', outlineOffset: -1 }}>
                  <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>{m.model}{active && ' ✕'}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--accent)' }}>{m.count}<small style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-dim)' }}> 장</small></div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>※ vGPU/vSGA는 ESXi가 사용률을 보고하지만, <b>패스쓰루(DirectPath I/O)</b>는 게스트 OS가 GPU를 직접 소유해 ESXi에서 사용률을 볼 수 없습니다(설정 › GPU 게스트 수집에서 게스트 OS 수집을 켜면 표시). 이름을 클릭하면 최근 5년 추이를 봅니다.</div>
      {data.items.length === 0 ? <div className="card"><span className="muted">GPU가 설치된 호스트가 없습니다.</span></div> : (
        <>
          <div className="flex gap wrap" style={{ marginBottom: 8 }}>
            {[['host', '호스트별'], ['cluster', '클러스터별'], ['vc', '법인별'], ['model', '법인·모델별']].map(([k, l]) => (
              <button key={k} className={view === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView(k)}>{l}</button>
            ))}
            <span style={{ width: 12 }} />
            {[['', '전체'], ['vgpu', 'vGPU'], ['passthrough', '패스쓰루'], ['vsga', 'vSGA']].map(([k, l]) => {
              const cnt = k ? (data.byMode?.[k] ?? 0) : data.totalGpus;
              const off = !!k && cnt === 0;
              return (
                <button key={k || 'all'} className={mode === k ? 'login-btn' : 'tab'} disabled={off}
                  style={{ flex: 'none', padding: '7px 12px', opacity: off ? 0.45 : 1, cursor: off ? 'not-allowed' : 'pointer' }}
                  title={off ? `${l} GPU가 없습니다` : ''} onClick={() => { if (!off) setMode(k); }}>
                  {l} <b style={{ opacity: 0.7 }}>{cnt}</b>
                </button>
              );
            })}
            <span style={{ width: 8 }} />
            <select className="select" style={{ flex: 'none', maxWidth: 240 }} value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} title="GPU 종류(모델)별로 보기">
              <option value="">GPU 종류: 전체</option>
              {(data.byModel || []).map((m) => <option key={m.model} value={m.model}>{m.model} (×{m.count})</option>)}
            </select>
            <select className="select" style={{ flex: 'none', maxWidth: 220 }} value={power} onChange={(e) => setPower(e.target.value)} title="GPU 할당 VM의 전원 상태로 호스트 필터">
              <option value="">전원: 전체</option>
              <option value="on">🟢 켜진 VM 있는 호스트</option>
              <option value="off">⚫ 꺼진 VM 있는 호스트</option>
            </select>
            <button className="logout-btn" style={{ flex: 'none', padding: '7px 12px', marginLeft: 'auto' }} disabled={collecting}
              onClick={collectNow} title="vCenter 성능 카운터(gpu.utilization)로 지금 사용률을 즉시 수집합니다(설정 주기 무시).">{collecting ? '수집 중…' : '⟳ 지금 수집'}</button>
            <button className="logout-btn" style={{ flex: 'none', padding: '7px 12px' }}
              onClick={() => setVmList({ title: `GPU 할당 VM${modelFilter ? ` — ${modelFilter}` : ' 전체'}`, params: { ...(scope ? { vcenterId: scope } : {}), ...(mode ? { mode } : {}), ...(modelFilter ? { model: modelFilter } : {}) } })}>🎮 GPU 할당 VM 보기</button>
            <button className="logout-btn" style={{ flex: 'none', padding: '7px 12px' }} onClick={() => setExportOpen(true)} title="수집된 GPU 사용률 데이터(전체/기간)를 CSV·JSON으로 내려받기.">⬇ 내보내기</button>
          </div>
          {view === 'model' && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>법인별로 설치된 GPU 카드 모델·장수·할당 VM 수입니다(같은 법인·같은 모델은 합산). <b>할당 VM</b> 숫자를 클릭하면 해당 VM 목록과 사용 방식을 봅니다.</div>}
          {view === 'vc' && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>법인별 GPU 장수·사용 방식·할당 VM 수입니다. <b>할당 VM</b> 숫자를 클릭하면 VM별 사용 방식을 봅니다.</div>}
          {rows.length === 0 && data.items.length > 0 ? (
            <div className="card" style={{ padding: 16 }}>
              <span className="muted">현재 필터에 해당하는 GPU 호스트가 없습니다{mode ? ` (사용 방식: ${{ vgpu: 'vGPU', passthrough: '패스쓰루', vsga: 'vSGA' }[mode] || mode})` : ''}{modelFilter ? ` (모델: ${modelFilter})` : ''}. GPU는 총 {data.totalGpus}장 있습니다.</span>
              <button className="tab" style={{ marginLeft: 10, padding: '4px 10px' }} onClick={() => { setMode(''); setModelFilter(''); setPower(''); }}>필터 초기화</button>
            </div>
          ) : (
            <DataTable
              columns={view === 'host' ? hostCols : view === 'model' ? modelCols : view === 'vc' ? vcCols : aggCols}
              rows={rows}
              initialSort={{ key: (view === 'host' || view === 'model' || view === 'vc') ? (view === 'host' ? 'count' : 'gpus') : 'avg', dir: 'desc' }} />
          )}
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
              <>
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={(hist.points || []).map((p) => ({ t: fmtTrendTick(p.ts, days), avg: p.avg, max: p.max }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" />
                    <XAxis dataKey="t" tick={{ fontSize: 11 }} minTickGap={40} />
                    <YAxis tick={{ fontSize: 11 }} unit="%" domain={[0, 100]} allowDataOverflow />
                    <Tooltip contentStyle={{ background: '#0b1220', border: '1px solid #243049', fontSize: 12 }} />
                    <Line type="monotone" dataKey="avg" stroke="#a78bfa" dot={false} name="평균" isAnimationActive={false} />
                    <Line type="monotone" dataKey="max" stroke="#f59e0b" dot={false} name="최고" isAnimationActive={false} />
                    <Brush dataKey="t" height={22} stroke="#6366f1" travellerWidth={8} tickFormatter={() => ''} />
                  </LineChart>
                </ResponsiveContainer>
                <div className="muted" style={{ fontSize: 11, marginTop: 4, textAlign: 'center' }}>아래 막대를 드래그하면 구간을 좁혀 스크롤·확대해 볼 수 있습니다.</div>
              </>
            )}
        </Modal>
      )}
      {vmList && <GpuVmsModal title={vmList.title} params={vmList.params} onClose={() => setVmList(null)} />}
      {exportOpen && <GpuExportModal scope={scope} onClose={() => setExportOpen(false)} onSnapshot={exportGpu} />}
    </>
  );
}

/** GPU 데이터 내보내기 — 수집 시작 일시 안내 + 전체/기간 선택 + CSV/JSON. */
function GpuExportModal({ scope, onClose, onSnapshot }) {
  const [meta, setMeta] = useState(null);   // { collectedSince, latestAt, sampleCount }
  const [range, setRange] = useState('all'); // all | days
  const [days, setDays] = useState(30);
  const [vc, setVc] = useState(scope || ''); // 내보낼 vCenter(빈값=전체)
  const [vcs, setVcs] = useState([]);
  useEffect(() => { fetchJson('/vcenters').then((d) => setVcs(d || [])).catch(() => {}); }, []);
  useEffect(() => {
    const q = vc ? `?vcenterId=${encodeURIComponent(vc)}` : '';
    fetchJson(`/tools/gpu/series-meta${q}`).then(setMeta).catch(() => setMeta({ collectedSince: null, sampleCount: 0 }));
  }, [vc]);
  const fmtTs = (ts) => (ts ? new Date(ts).toLocaleString('ko-KR') : null);
  const sinceTxt = meta && meta.collectedSince
    ? `${fmtTs(meta.collectedSince)} 부터 데이터가 쌓여 있습니다`
    : (meta ? '아직 수집된 GPU 사용률 이력이 없습니다(샘플러가 한 주기 이상 돌면 생성됩니다)' : '확인 중…');
  const daysSince = meta && meta.collectedSince ? Math.max(1, Math.round((Date.now() - meta.collectedSince) / 86_400_000)) : null;
  const download = async (fmt) => {
    const params = new URLSearchParams();
    if (vc) params.set('vcenterId', vc);
    params.set('range', range);
    if (range === 'days') params.set('days', String(days));
    const res = await fetch(`/api/tools/gpu/export.${fmt}?${params.toString()}`, { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} });
    await saveResponseAsFile(res, `gpu-history-${range}-${new Date().toISOString().slice(0, 10)}.${fmt}`);
  };
  return (
    <Modal title="GPU 데이터 내보내기" onClose={onClose} width={560}>
      <div className="card" style={{ padding: 12, marginBottom: 14, borderLeft: '3px solid var(--accent,#2563eb)' }}>
        <div style={{ fontSize: 13 }}>📅 <b>수집 시작</b>: {sinceTxt}</div>
        {meta && meta.collectedSince && (
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            총 {daysSince}일 누적 · 샘플 {meta.sampleCount?.toLocaleString?.() ?? meta.sampleCount}개{meta.latestAt ? ` · 마지막 ${fmtTs(meta.latestAt)}` : ''}
          </div>
        )}
      </div>

      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>법인(vCenter) 선택</div>
      <select className="select" value={vc} onChange={(e) => setVc(e.target.value)} style={{ minWidth: 220, marginBottom: 12 }}>
        <option value="">전체 vCenter</option>
        {vcs.map((v) => <option key={v.id} value={v.id}>{v.name || v.id}</option>)}
      </select>

      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>내보낼 범위</div>
      <label className="flex gap" style={{ alignItems: 'center', marginBottom: 6, cursor: 'pointer' }}>
        <input type="radio" name="gpuexp" checked={range === 'all'} onChange={() => setRange('all')} />
        <span><b>전체 수집 데이터</b> — 수집 시작일부터 현재까지 모두</span>
      </label>
      <label className="flex gap" style={{ alignItems: 'center', marginBottom: 6, cursor: 'pointer' }}>
        <input type="radio" name="gpuexp" checked={range === 'days'} onChange={() => setRange('days')} />
        <span>기간 지정 — 최근
          <input className="input" type="number" min={1} max={1830} value={days} disabled={range !== 'days'}
            onChange={(e) => setDays(Math.max(1, Number(e.target.value) || 30))} style={{ width: 80, margin: '0 6px' }} /> 일
        </span>
      </label>

      <div className="flex gap" style={{ marginTop: 16, alignItems: 'center' }}>
        <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={() => download('csv')}>⬇ CSV 내보내기</button>
        <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={() => download('json')}>⬇ JSON 내보내기</button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 12, borderTop: '1px solid rgba(255,255,255,.08)', paddingTop: 10 }}>
        시계열(샘플마다 한 행)로 내보냅니다. 현재 상태(호스트별 1행 스냅샷)만 필요하면&nbsp;
        <button className="cell-link" onClick={() => onSnapshot('csv', vc)}>스냅샷 CSV</button> ·&nbsp;
        <button className="cell-link" onClick={() => onSnapshot('json', vc)}>스냅샷 JSON</button>
        <div style={{ marginTop: 6 }}>💡 파일 용량이 1MB를 넘으면 자동으로 <b>zip</b>으로 압축해 내려받습니다. · <b>gpu_util_pct</b>=GPU 사용률(0~100%) · <b>epoch_ms</b>=Unix 밀리초(엑셀은 지수표기로 보일 수 있음).</div>
      </div>
    </Modal>
  );
}
