import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, usePolling, getToken } from '../api.js';
import { DataTable, Loading, ErrorBox, StateBadge, UsageCell, EntityDetail, Modal, ResultCount } from '../components/ui.jsx';
import RemoteAccess from './RemoteAccess.jsx';

const TOOLS = [
  { k: 'aisearch', icon: '🔎', label: 'AI 검색 (자연어)', desc: '자연어로 VM/호스트/IP 검색 · 로컬 LLM' },
  { k: 'remote', icon: '🖥️', label: '원격 접속 (SSH/RDP)', desc: '프록시(HAProxy) 경유 브라우저 SSH·RDP' },
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
  { k: 'gpu', icon: '🎮', label: 'GPU 인벤토리', desc: '호스트/모델별 GPU 종합' },
  { k: 'shutdown', icon: '🛑', label: '긴급 ShutDown', desc: '비상 정지 (관리자 전용)', danger: true, disabled: true },
];

const tb = (gb) => (gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb} GB`);

export default function SpecialTools() {
  const [tool, setTool] = useState(null);
  if (tool) return <ToolPanel tool={tool} onBack={() => setTool(null)} />;
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
            onClick={t.disabled ? undefined : () => setTool(t.k)}
            title={t.disabled ? '비활성화됨 (관리자 전용)' : undefined}>
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
  const scoped = ['ipam', 'dupip', 'vmtools', 'snapshots', 'hba', 'gpu', 'licenses', 'esxi', 'hardware'].includes(tool);

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
      {tool === 'remote' && <RemoteAccess />}
      {tool === 'ipam' && <Ipam scope={scope} />}
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

function Ipam({ scope }) {
  const { loading, data, error } = useTool('/tools/ipam', scope ? { vcenterId: scope } : {});
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const [db, setDb] = useState(null);
  const [view, setView] = useState('list'); // list | sheet
  const [subnets, setSubnets] = useState([]);
  const [base, setBase] = useState('');
  const [sheet, setSheet] = useState(null);
  useEffect(() => { fetchJson('/admin/ipam/db-info').then(setDb).catch(() => setDb(null)); }, []);

  const sp = scope ? `?vcenterId=${encodeURIComponent(scope)}` : '';
  const pickBase = async (b) => { setBase(b); setSheet(await fetchJson(`/tools/ipam/sheet?base=${b}${scope ? `&vcenterId=${encodeURIComponent(scope)}` : ''}`).catch(() => null)); };
  const openSheets = async () => {
    setView('sheet');
    const r = await fetchJson(`/tools/ipam/subnets${sp}`).catch(() => ({ subnets: [] }));
    setSubnets(r.subnets); if (r.subnets[0]) pickBase(r.subnets[0].base);
  };
  const blobDownload = async (path, name) => {
    const res = await fetch(`/api${path}`, { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} });
    const blob = await res.blob(); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
  };
  const downloadXlsx = () => blobDownload(`/tools/ipam.xlsx${sp}`, `ip-ledger-${new Date().toISOString().slice(0, 10)}.xlsx`);

  // Reload the subnet list (and first sheet) when the vCenter scope changes.
  useEffect(() => { if (view === 'sheet') openSheets(); /* eslint-disable-next-line */ }, [scope]);

  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;

  const ROWBG = { used: 'rgba(34,197,94,.12)', multihomed: 'rgba(59,130,246,.14)', duplicate: 'rgba(239,68,68,.14)', network: 'rgba(148,163,184,.14)', empty: 'transparent' };
  const STLAB = { used: '사용', multihomed: '멀티홈', duplicate: '중복', network: 'Network ID', empty: '' };

  const term = q.trim().toLowerCase();
  const rows = term
    ? data.rows.filter((r) => r.ip.includes(term) || (r.ownerName || '').toLowerCase().includes(term) || (r.hostName || '').toLowerCase().includes(term))
    : data.rows;

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
    { key: 'vcenterName', label: '센터(vCenter)' },
    { key: 'ownerName', label: '소유 자원', render: (r) => <><span className="badge blue">{r.ownerType === 'vm' ? 'VM' : '호스트'}</span> {r.ownerName}</> },
    { key: 'powerState', label: '전원', render: (r) => <StateBadge state={r.powerState} /> },
    { key: 'guestOS', label: 'OS / 게스트' },
    { key: 'hostName', label: 'ESXi 호스트' },
  ];

  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="총 IP" value={data.total.toLocaleString()} meta={`센터 ${data.byVcenter.length}`} />
        <Card label="중복 IP" value={data.duplicateIps} accent={data.duplicateIps ? 'var(--red)' : undefined} />
        <Card label="멀티홈 IP" value={data.multiHomed} />
        {db && <Card label="공유 DB 레코드" value={db.count.toLocaleString()} meta={db.kind.toUpperCase()} />}
      </div>
      <div className="flex gap wrap" style={{ marginBottom: 10 }}>
        {data.byVcenter.map((v) => <span key={v.vcenterId} className="badge gray" style={{ fontSize: 12, padding: '4px 10px' }}>{v.vcenterName} · {v.count}</span>)}
      </div>
      <div className="flex between wrap gap" style={{ marginBottom: 8, alignItems: 'center' }}>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <button className={view === 'list' ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView('list')}>목록</button>
          <button className={view === 'sheet' ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={openSheets}>서브넷 대장(엑셀형)</button>
          {view === 'list' && <input className="input" style={{ maxWidth: 260 }} placeholder="IP / VM / 호스트 검색" value={q} onChange={(e) => setQ(e.target.value)} />}
        </div>
        <div className="flex gap">
          <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={downloadCsv}>CSV</button>
          <button className="login-btn" style={{ flex: 'none', padding: '9px 14px' }} onClick={downloadXlsx}>엑셀 대장(.xlsx)</button>
        </div>
      </div>

      {view === 'sheet' ? (
        <>
          <div className="flex gap wrap" style={{ marginBottom: 8, alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12 }}>서브넷</span>
            <select className="select" style={{ maxWidth: 280 }} value={base} onChange={(e) => pickBase(e.target.value)}>
              {subnets.map((s) => <option key={s.base} value={s.base}>{s.subnet} · 사용 {s.used}</option>)}
            </select>
            <span className="muted" style={{ fontSize: 12 }}>🟩 사용 · 🟦 멀티홈 · 🟥 중복 · ⬜ 미사용</span>
          </div>
          {sheet && (
            <div className="table-wrap" style={{ maxHeight: '62vh' }}>
              <table>
                <thead><tr><th>{base}.X</th><th>Purpose</th><th>Hostname</th><th>메모(Notes)</th><th>전원</th><th>상태</th></tr></thead>
                <tbody>
                  {sheet.rows.map((r) => (
                    <tr key={r.ip} style={{ background: ROWBG[r.status] }}>
                      <td><b>{r.ip}</b></td>
                      <td>{r.purpose}</td>
                      <td>{r.hostname}</td>
                      <td className="muted" style={{ fontSize: 12 }}>{r.notes}</td>
                      <td>{r.power}</td>
                      <td className="muted" style={{ fontSize: 12 }}>{STLAB[r.status]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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

function Card({ label, value, meta, accent }) {
  return <div className="card kpi"><div className="label">{label}</div><div className="value" style={{ fontSize: 24, ...(accent ? { color: accent } : {}) }}>{value}</div>{meta && <div className="meta">{meta}</div>}</div>;
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

function Gpu({ scope }) {
  const { loading, data, error } = useTool('/tools/gpu', scope ? { vcenterId: scope } : {});
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const cols = [
    { key: 'host', label: '호스트', render: (h) => <b>{h.host}</b> },
    { key: 'vcenterId', label: 'vCenter', render: (h) => <span className="muted">{h.vcenterId}</span> },
    { key: 'model', label: 'GPU 모델' },
    { key: 'count', label: '개수', align: 'right' },
    { key: 'memGB', label: 'VRAM', align: 'right', render: (h) => `${h.memGB} GB` },
    { key: 'vgpu', label: 'vGPU', sortValue: (h) => (h.vgpu ? 1 : 0), render: (h) => (h.vgpu ? <span className="badge green">vGPU</span> : <span className="badge gray">Passthrough</span>) },
  ];
  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="총 GPU" value={data.totalGpus} accent="var(--accent)" meta={`GPU 호스트 ${data.hostsWithGpu}`} />
        {data.byModel.slice(0, 4).map((m) => <Card key={m.model} label={m.model} value={m.count} />)}
      </div>
      {data.items.length === 0 ? <div className="card"><span className="muted">GPU가 설치된 호스트가 없습니다.</span></div>
        : <DataTable columns={cols} rows={data.items} initialSort={{ key: 'count', dir: 'desc' }} />}
    </>
  );
}
