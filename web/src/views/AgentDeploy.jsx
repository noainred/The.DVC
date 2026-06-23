import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../api.js';
import { Loading } from '../components/ui.jsx';

const EMPTY = {
  host: '', port: 22, username: 'root', password: '', privateKey: '',
  agentName: '', centralUrl: '', centralToken: '', collectorToken: '', collectorDatacenter: '',
  installerPath: '', portalPort: 4000, autoUpgrade: true, pushInventory: false, registerCollector: true,
};

/** 설정 → 에이전트 배포: 새 Rocky9 호스트에 SSH로 수집 에이전트 자동 설치. */
export default function AgentDeploy() {
  const [f, setF] = useState(EMPTY);
  const [installer, setInstaller] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [targets, setTargets] = useState([]);
  const [pkg, setPkg] = useState(null);
  const [dl, setDl] = useState({ kind: 'installer', version: '', busy: false });
  const [pkgCfg, setPkgCfg] = useState(null); // { baseUrl, dir } editable

  const loadInstaller = () => fetchJson('/admin/agent-deploy/installer').then(setInstaller).catch(() => setInstaller({ available: false }));
  const loadPkg = () => fetchJson('/admin/packages').then((p) => { setPkg(p); setPkgCfg({ baseUrl: p.baseUrl || '', dir: p.dir || '' }); }).catch(() => setPkg(null));
  const savePkgCfg = async () => {
    const r = await putJson('/admin/packages/settings', pkgCfg).catch((e) => ({ ok: false, reason: e.message }));
    setResult({ kind: 'pkgcfg', ok: !!r.ok, reason: r.reason });
    await loadPkg();
  };
  const loadTargets = () => fetchJson('/admin/agent-deploy/targets').then((d) => setTargets(d.targets)).catch(() => {});
  // 실행 중 서버의 중앙 토큰/기본값을 읽어 폼에 자동 입력.
  const [tokenInfo, setTokenInfo] = useState({ hasToken: false });
  const [defaults, setDefaults] = useState(null);
  const [genBusy, setGenBusy] = useState(false);
  const [fillBusy, setFillBusy] = useState(false);
  const loadToken = async () => {
    const r = await fetchJson('/admin/central-token').catch(() => null);
    if (r) { setTokenInfo(r); if (r.token) setF((s) => (s.centralToken ? s : { ...s, centralToken: r.token })); }
  };
  const loadDefaults = async () => {
    const d = await fetchJson('/admin/agent-deploy/defaults').catch(() => null);
    if (d) { setDefaults(d); setF((s) => ({ ...s, centralUrl: s.centralUrl || d.centralUrl || '', portalPort: s.portalPort || d.portalPort || 4000 })); }
  };
  const genToken = async () => {
    setGenBusy(true);
    const r = await postJson('/admin/central-token/generate', { force: false }).catch((e) => ({ ok: false, reason: e.message }));
    setGenBusy(false);
    if (r.ok && r.token) { setF((s) => ({ ...s, centralToken: r.token })); setTokenInfo({ hasToken: true, token: r.token }); setResult({ kind: 'token', ok: true, created: r.created }); }
    else setResult({ kind: 'token', ok: false, reason: r.reason });
  };
  // 24바이트 랜덤 hex(클라이언트 생성) — 전력수집 토큰 등 임의 비밀용.
  const randHex = () => Array.from(crypto.getRandomValues(new Uint8Array(24))).map((b) => b.toString(16).padStart(2, '0')).join('');
  const suggestName = (s, d) => {
    if (s.agentName) return s.agentName;
    if (s.host) return `${String(s.host).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}-agent`;
    return `agent-${Math.floor(Math.random() * 9000 + 1000)}`;
  };
  // 올인원 자동 채우기: 이 1대가 해당 DC의 모든 작업(인벤토리 위임 수집·전력·IP스캔·자동
  // 업그레이드)을 수행하도록 필요한 값/토큰을 모두 채우고 모든 역할 옵션을 켠다.
  const autofill = async () => {
    setFillBusy(true); setResult(null);
    const d = defaults || await fetchJson('/admin/agent-deploy/defaults').catch(() => null);
    let token = tokenInfo.token;
    if (!token) { const r = await postJson('/admin/central-token/generate', {}).catch(() => null); if (r?.token) { token = r.token; setTokenInfo({ hasToken: true, token }); } }
    setF((s) => {
      const name = suggestName(s, d);
      return {
        ...s,
        agentName: s.agentName || name,
        centralUrl: s.centralUrl || d?.centralUrl || '',
        centralToken: token || s.centralToken,
        collectorToken: s.collectorToken || randHex(),
        collectorDatacenter: s.collectorDatacenter || name,
        portalPort: s.portalPort || d?.portalPort || 4000,
        installerPath: s.installerPath, // 비워두면 자동 선택
        autoUpgrade: true,    // ⑦ 자동 업그레이드(소스=중앙)
        pushInventory: true,  // ① vCenter 인벤토리 위임 수집 → 중앙 push
      };
    });
    setFillBusy(false);
    setResult({ kind: 'autofill', ok: true });
  };
  useEffect(() => { loadInstaller(); loadTargets(); loadPkg(); loadToken(); loadDefaults(); }, []);

  const downloadPkg = async () => {
    setDl((d) => ({ ...d, busy: true })); setResult(null);
    const r = await postJson('/admin/packages/download', { kind: dl.kind, version: dl.version || undefined }).catch((e) => ({ ok: false, reason: e.message }));
    setResult({ kind: 'pkg', ...r });
    await loadPkg(); await loadInstaller();
    setDl((d) => ({ ...d, busy: false }));
  };
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const saveTarget = async () => {
    const r = await postJson('/admin/agent-deploy/targets', { id: f.id, ...f }).catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) { await loadTargets(); setResult({ kind: 'save', ok: true, reason: '대상을 저장했습니다.' }); }
    else setResult({ kind: 'save', ok: false, reason: r.reason });
  };
  const editTarget = (t) => setF({ ...EMPTY, ...t, password: '', privateKey: '' });
  const removeTarget = async (t) => { if (window.confirm(`'${t.host}' 대상을 삭제할까요?`)) { await delJson(`/admin/agent-deploy/targets/${t.id}`).catch(() => {}); await loadTargets(); } };
  const deployTarget = async (t) => {
    if (!window.confirm(`${t.host} 에 배포할까요?`)) return;
    setBusy(true); setResult(null);
    const r = await postJson(`/admin/agent-deploy/targets/${t.id}/deploy`, {}).catch((e) => ({ ok: false, reason: e.message }));
    setResult({ kind: 'deploy', ...r }); await loadTargets(); setBusy(false);
  };
  const checkStatus = async (t) => {
    setBusy(true); setResult(null);
    const r = await postJson(`/admin/agent-deploy/targets/${t.id}/status`, {}).catch((e) => ({ ok: false, reason: e.message }));
    setResult({ kind: 'status', ...r }); await loadTargets(); setBusy(false);
  };
  const deployAll = async () => {
    if (!window.confirm(`저장된 활성 대상 전체에 배포할까요? (순차 진행)`)) return;
    setBusy(true); setResult(null);
    const r = await postJson('/admin/agent-deploy/deploy-all', {}).catch((e) => ({ ok: false, reason: e.message }));
    setResult({ kind: 'deploy-all', ...r }); await loadTargets(); setBusy(false);
  };

  const test = async () => {
    setBusy(true); setResult(null);
    const r = await postJson('/admin/agent-deploy/test', f).catch((e) => ({ ok: false, reason: e.message }));
    setResult({ kind: 'test', ...r }); setBusy(false);
  };
  const deploy = async () => {
    if (!window.confirm(`${f.host} 에 수집 에이전트를 설치/재시작할까요? (root 권한 필요)`)) return;
    setBusy(true); setResult(null);
    const r = await postJson('/admin/agent-deploy', f).catch((e) => ({ ok: false, reason: e.message }));
    setResult({ kind: 'deploy', ...r }); setBusy(false);
  };

  if (!installer) return <Loading />;

  return (
    <>
      <div className="section-title" style={{ margin: '6px 0 10px' }}>에이전트 자동배포 (SSH 설치)</div>

      <div className="card" style={{ marginBottom: 12 }}>
        <b style={{ fontSize: 14 }}>설치 패키지 자동 다운로드</b>
        <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>
          저장소에서 패키지를 받아 저장 경로에 보관합니다(SHA-256 검증). 폐쇄망은 아래 <b>저장소 URL</b>을 사내 미러로 바꾸세요(웹에서 바로 수정 가능).
        </div>
        {pkgCfg && (
          <div className="card" style={{ margin: '0 0 10px', padding: '10px 12px', background: 'rgba(255,255,255,.02)' }}>
            <div className="flex gap wrap" style={{ alignItems: 'flex-end' }}>
              <label style={{ flex: 2, minWidth: 320, fontSize: 12 }}>저장소 URL (versions.json 위치)
                <input className="input" value={pkgCfg.baseUrl} onChange={(e) => setPkgCfg({ ...pkgCfg, baseUrl: e.target.value })} placeholder="https://mirror.corp/vmware-portal/download" />
              </label>
              <label style={{ flex: 1, minWidth: 220, fontSize: 12 }}>저장 경로
                <input className="input" value={pkgCfg.dir} onChange={(e) => setPkgCfg({ ...pkgCfg, dir: e.target.value })} placeholder="/etc/vmware-portal/packages" />
              </label>
              <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={savePkgCfg}>저장</button>
              <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={loadPkg}>새로고침</button>
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              비워두면 환경변수 기본값을 사용합니다(기본 URL: <code>{pkg?.settings?.defaults?.baseUrl}</code>). {pkg?.settings?.overridden?.baseUrl ? '· 현재 웹에서 지정한 URL 사용 중' : ''}
            </div>
          </div>
        )}
        <div className="flex gap wrap" style={{ alignItems: 'flex-end' }}>
          <label style={{ fontSize: 12 }}>종류
            <select className="select" value={dl.kind} onChange={(e) => setDl({ ...dl, kind: e.target.value })}>
              <option value="installer">설치 패키지(Rocky 9 offline)</option>
              <option value="installer_cent9">설치 패키지(CentOS Stream 9 offline)</option>
              <option value="bundle">업그레이드 번들(app)</option>
              <option value="windows">Windows zip</option>
            </select>
          </label>
          <label style={{ fontSize: 12 }}>버전(비우면 latest{pkg?.remote?.latest ? ` ${pkg.remote.latest}` : ''})
            <input className="input" value={dl.version} onChange={(e) => setDl({ ...dl, version: e.target.value })} placeholder={pkg?.remote?.latest || '1.x.y'} />
          </label>
          <button className="login-btn" style={{ flex: 'none', padding: '9px 16px' }} disabled={dl.busy} onClick={downloadPkg}>{dl.busy ? '다운로드 중…' : '다운로드'}</button>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          저장소: <code>{pkg?.baseUrl}</code>{pkg?.remote?.error ? ` · ⚠ 원격 조회 실패: ${pkg.remote.error}` : (pkg?.remote?.latest ? ` · 원격 latest ${pkg.remote.latest}` : '')}
        </div>
        {pkg?.local?.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>보유 패키지</div>
            {pkg.local.map((p) => <div key={p.name} style={{ fontSize: 12 }}><code>{p.name}</code> <span className="muted">({(p.sizeBytes / 1048576).toFixed(1)} MB)</span></div>)}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 12, borderColor: installer.available ? undefined : 'var(--red)' }}>
        {installer.available
          ? <span className="muted" style={{ fontSize: 13 }}>설치 패키지: <code>{installer.name}</code> ({(installer.sizeBytes / 1048576).toFixed(1)} MB) — 중앙 서버에서 SFTP 전송됩니다.</span>
          : <span style={{ color: 'var(--red)', fontSize: 13 }}>설치 패키지를 찾을 수 없습니다. 중앙 서버 <code>download/</code> 에 offline tarball을 두거나 아래 경로를 지정하세요.</span>}
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <b style={{ fontSize: 14 }}>대상 호스트 (SSH)</b>
        <div className="spec-grid" style={{ marginTop: 8 }}>
          <label>호스트(IP)<input className="input" value={f.host} onChange={set('host')} placeholder="10.30.0.21" /></label>
          <label>SSH 포트<input className="input" type="number" value={f.port} onChange={set('port')} /></label>
          <label>사용자(root 권장)<input className="input" value={f.username} onChange={set('username')} /></label>
          <label>비밀번호<input className="input" type="password" value={f.password} onChange={set('password')} placeholder="(키 사용 시 비움)" /></label>
          <label style={{ gridColumn: '1 / -1' }}>개인키(PEM, 선택)<textarea className="input" rows={2} value={f.privateKey} onChange={set('privateKey')} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 11 }} /></label>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="flex between" style={{ alignItems: 'center' }}>
          <b style={{ fontSize: 14 }}>에이전트 설정 (포탈 env에 주입) — 올인원 현장 서버</b>
          <button className="login-btn" type="button" style={{ flex: 'none', padding: '7px 14px' }} disabled={fillBusy} onClick={autofill}
            title="이 1대가 해당 DC의 모든 작업을 수행하도록 모든 값을 채우고 모든 역할을 켭니다: 에이전트 이름, 중앙 URL(이 포탈), 중앙 토큰(없으면 생성·저장), 전력수집 토큰(랜덤)+수집 DC명, 자동 업그레이드, 사이트 위임 수집(vCenter 인벤토리 push). 이미 입력한 칸은 보존됩니다.">
            {fillBusy ? '채우는 중…' : '🌐 올인원 자동 채우기'}
          </button>
        </div>
        <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>
          <b>이 1대(현장 서버)가 해당 데이터센터 대상으로 수행하는 작업:</b>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '2px 12px', marginTop: 4 }}>
            <span>① vCenter 인벤토리 수집 → 중앙 push <span className="muted">(사이트 위임)</span></span>
            <span>② 전력 수집(iDRAC/OME)</span>
            <span>③ 수집 서버(원격) export</span>
            <span>④ IP 스캔(로컬 대역)</span>
            <span>⑤ 지표·온도·GPU 게스트 수집 <span className="muted">(로컬 vCenter 등록 시 자동)</span></span>
            <span>⑥ 원격접속 중계 SSH/RDP <span className="muted">(포탈 내장)</span></span>
            <span>⑦ 자동 업그레이드 <span className="muted">(소스=중앙)</span></span>
          </div>
          <div style={{ marginTop: 6 }}>※ <b>🌐 올인원 자동 채우기</b>로 ①②③④⑦을 한 번에 켭니다. ⑤⑥은 자동입니다. <b>①을 쓰려면</b> 배포 후 이 현장 서버의 <code>vcenters.json</code>에 로컬 vCenter를 등록하고, 중앙 'vCenter 관리'에서 해당 vCenter를 <b>'사이트 위임'</b>으로 설정하세요.</div>
        </div>
        <div className="agent-grid">
          <label title="이 에이전트의 고유 식별 이름. IP 스캔 '할당 에이전트' 드롭다운과 중앙 할당 매칭(AGENT_NAME)에 사용됩니다. 사이트/DC가 드러나게 지으세요. 예: OC2-Agent, Seoul-DC1. 자동 채우기는 SSH 호스트 기반으로 제안합니다.">
            <span className="cap">에이전트 이름(AGENT_NAME)</span><input className="input" value={f.agentName} onChange={set('agentName')} placeholder="예: OC2-Agent / Seoul-DC1" /></label>
          <label title="에이전트가 접속할 '중앙 포탈' 주소. 에이전트 서버에서 도달 가능한 IP/호스트:포트여야 합니다(끝에 / 없이). 예: http://192.168.20.143:4000. 자동 채우기는 지금 접속한 포탈 주소로 채웁니다 — 에이전트 망에서 안 닿으면 외부 접근용 주소로 바꾸세요.">
            <span className="cap">중앙 URL(CENTRAL_URL)</span><input className="input" value={f.centralUrl} onChange={set('centralUrl')} placeholder="http://<포탈주소>:4000" /></label>
          <label title="중앙↔에이전트 공유 비밀. 중앙 포탈의 CENTRAL_TOKEN과 반드시 동일해야 하며 다르면 403. '생성'을 누르면 안전한 랜덤 토큰을 만들어 이 포탈(중앙) 환경(portal.env)에 저장하고 칸을 채웁니다(리붓해도 유지). 이미 있으면 자동 입력됩니다.">
            <span className="cap">중앙 토큰(CENTRAL_TOKEN)</span>
            <div className="flex gap" style={{ alignItems: 'center' }}>
              <input className="input" value={f.centralToken} onChange={set('centralToken')} placeholder={tokenInfo.hasToken ? '' : '미설정 — 생성 클릭'} />
              <button className="logout-btn" type="button" style={{ flex: 'none', padding: '7px 12px', whiteSpace: 'nowrap' }} disabled={genBusy} onClick={genToken}
                title="없으면 안전한 랜덤 토큰을 생성해 이 포탈(중앙) 환경에 저장하고 채웁니다">{genBusy ? '생성 중…' : (tokenInfo.hasToken ? '현재값' : '생성')}</button>
            </div>
            <span className="muted" style={{ fontSize: 11 }}>{tokenInfo.hasToken ? '✅ 중앙 토큰이 이 포탈에 설정됨(자동 입력됨)' : '⚠ 중앙 미설정 — 생성 시 portal.env에 저장(리붓 유지)'}</span>
          </label>
          <label title="(선택) 이 에이전트를 '전력/데이터 pull 대상'으로도 쓸 때만. 중앙이 이 에이전트의 /api/collector/export 를 당겨갈 때 쓰는 임의 비밀입니다. iDRAC/IP 스캔만 할 거면 비워두세요. 자동 채우기는 랜덤값을 넣습니다. 중앙 '설정 › 수집 서버' 등록 시 같은 값을 사용하세요.">
            <span className="cap">전력수집 토큰(COLLECTOR_TOKEN, 선택)</span><input className="input" value={f.collectorToken} onChange={set('collectorToken')} placeholder="(전력수집 시에만)" /></label>
          <label title="(선택) 전력수집 에이전트가 보고할 데이터센터 라벨. 수집 토큰을 쓸 때만 의미 있습니다. 예: OC2. 안 쓰면 비움. ※ 아래 '수집 서버 자동 등록'을 켜면 배포 후 중앙에 자동 등록됩니다.">
            <span className="cap">수집 DC명(COLLECTOR_DATACENTER, 선택)</span><input className="input" value={f.collectorDatacenter} onChange={set('collectorDatacenter')} placeholder="예: OC2" /></label>
          <label title="에이전트 인스턴스가 자기 서버에서 열 HTTP 포트(기본 4000). 그 호스트에서 포트 충돌이 없으면 그대로 두세요.">
            <span className="cap">포탈 포트</span><input className="input" type="number" value={f.portalPort} onChange={set('portalPort')} /></label>
          <label style={{ gridColumn: '1 / -1' }} title="보통 비워두세요 — 중앙이 download/의 el9 오프라인 패키지를 자동 선택해 SSH로 전송·설치합니다. 특정 tarball을 강제하려면 '중앙 서버' 상의 절대경로를 입력하세요.">
            <span className="cap">설치 패키지 경로(비우면 자동)</span><input className="input" value={f.installerPath} onChange={set('installerPath')} placeholder="(비우면 자동 선택)" /></label>
          <label className="agent-check" style={{ gridColumn: '1 / -1' }} title="켜면 이 에이전트가 '현재 포탈'을 업그레이드 소스로 사용합니다(UPGRADE_REMOTE_BASE = 중앙 URL + /dl). 중앙 포탈이 새 버전 번들을 download/에 올리면 에이전트가 주기적으로(기본 1시간) 확인해 자동 업그레이드합니다. 중앙 URL이 비어 있으면 무시됩니다.">
            <input type="checkbox" checked={!!f.autoUpgrade} onChange={(e) => setF((s) => ({ ...s, autoUpgrade: e.target.checked }))} />
            <span>자동 업그레이드 활성화 — 업그레이드 소스 = 현재 포탈(<code>중앙 URL/dl</code>)</span></label>
          <label className="agent-check" style={{ gridColumn: '1 / -1' }} title="켜면 이 현장 서버가 자기 로컬 vCenter 인벤토리(VM/호스트/데이터스토어/NSX/알람)를 수집해 중앙(OC2)으로 push 합니다(AGENT_PUSH_INVENTORY=true). 중앙은 그 vCenter를 직접 폴링하지 않아 고RTT 원격 사이트의 수집 지연이 사라집니다. ※ 중앙의 'vCenter 관리'에서 해당 vCenter의 수집 방식을 '사이트 위임'으로 설정해야 적용됩니다. 그리고 이 현장 서버의 vcenters.json에 로컬 vCenter를 등록해야 합니다.">
            <input type="checkbox" checked={!!f.pushInventory} onChange={(e) => setF((s) => ({ ...s, pushInventory: e.target.checked }))} />
            <span>사이트 위임 수집 — 이 현장 서버가 로컬 vCenter 수집 후 중앙으로 push(고RTT 사이트 권장)</span></label>
          <label className="agent-check" style={{ gridColumn: '1 / -1' }} title="켜면 배포·설치 성공 직후, 이 호스트(http://host:포탈포트)를 중앙 '설정 › 수집 서버'에 자동 등록합니다(전력수집 토큰 사용). 따로 수집 서버 화면에서 URL/토큰을 입력할 필요가 없습니다. 전력수집 토큰이 비어 있으면 무시됩니다.">
            <input type="checkbox" checked={!!f.registerCollector} onChange={(e) => setF((s) => ({ ...s, registerCollector: e.target.checked }))} />
            <span>수집 서버 자동 등록 — 설치 성공 시 중앙 '수집 서버'에 자동 등록(전력수집 토큰 필요)</span></label>
        </div>
      </div>

      <div className="flex gap wrap" style={{ marginBottom: 14 }}>
        <button className="logout-btn" style={{ padding: '9px 16px' }} disabled={busy || !f.host} onClick={test}>SSH 테스트</button>
        <button className="logout-btn" style={{ padding: '9px 16px' }} disabled={busy || !f.host} onClick={saveTarget}>{f.id ? '대상 수정' : '대상 저장'}</button>
        {f.id && <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={() => setF(EMPTY)}>새 대상</button>}
        <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={busy || !f.host || !installer.available} onClick={deploy}>{busy ? '진행 중…' : '배포 + 설치'}</button>
      </div>

      {targets.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
            <b style={{ fontSize: 14 }}>저장된 대상 ({targets.length})</b>
            <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={busy || !installer.available} onClick={deployAll}>전체 배포</button>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>호스트</th><th>에이전트</th><th>중앙</th><th>마지막 결과</th><th style={{ textAlign: 'right' }}>작업</th></tr></thead>
              <tbody>
                {targets.map((t) => (
                  <tr key={t.id}>
                    <td><b>{t.host}</b>:{t.port || 22} <span className="muted" style={{ fontSize: 11 }}>{t.username}</span></td>
                    <td>{t.agentName || '—'}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{t.centralUrl || '—'}</td>
                    <td>{t.lastResult ? <span className={`badge ${t.lastResult.ok ? 'green' : 'red'}`}>{t.lastResult.ok ? t.lastResult.active || 'ok' : '실패'}</span> : <span className="muted">—</span>}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="login-btn" style={{ flex: 'none', padding: '6px 12px' }} disabled={busy || !installer.available} onClick={() => deployTarget(t)}>배포</button>{' '}
                      <button className="logout-btn" style={{ padding: '6px 10px' }} disabled={busy} onClick={() => checkStatus(t)} title="재배포 없이 대상 서비스 상태를 SSH로 확인">상태 확인</button>{' '}
                      <button className="logout-btn" style={{ padding: '6px 10px' }} onClick={() => editTarget(t)}>편집</button>{' '}
                      <button className="logout-btn" style={{ padding: '6px 10px' }} onClick={() => removeTarget(t)}>삭제</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {result && (
        <div className="card" style={{ borderColor: result.ok ? 'var(--green)' : 'var(--red)' }}>
          <b style={{ color: result.ok ? 'var(--green)' : 'var(--red)' }}>
            {result.ok ? '성공' : '실패'} — {{ test: 'SSH 테스트', save: '대상 저장', 'deploy-all': '전체 배포', pkg: '패키지 다운로드', token: '중앙 토큰', autofill: '자동 채우기', pkgcfg: '패키지 설정', status: '서버 상태 확인' }[result.kind] || '배포'}
          </b>
          <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.7 }}>
            {result.reason && <div style={{ color: result.ok ? 'var(--green)' : 'var(--red)' }}>{result.reason}</div>}
            {result.os && <div>OS: {result.os} · root: {result.isRoot ? '예' : '아니오'} · systemd: {result.systemd ? '예' : '아니오'}{result.glibc ? ` · glibc: ${result.glibc} ${result.glibcOk === false ? '❌' : result.glibcOk ? '✅' : ''}` : ''}</div>}
            {result.warn && <div style={{ color: 'var(--amber)', marginTop: 4 }}>⚠ {result.warn}</div>}
            {result.glibc && result.kind !== 'test' && result.ok === false && <div style={{ color: 'var(--amber)', marginTop: 4 }}>glibc: {result.glibc}</div>}
            {result.active && <div>서비스 상태: <b style={{ color: result.ok ? 'var(--green)' : 'var(--red)' }}>{result.active}</b>{result.version ? ` · 버전 ${result.version}` : ''}{result.installer ? ` · 설치 패키지 ${result.installer}` : ''}{result.detail ? ` · ${result.detail}` : ''}</div>}
            {result.collector && (result.collector.registered
              ? <div style={{ color: 'var(--green)', marginTop: 4 }}>✅ 중앙 '수집 서버'에 {result.collector.updated ? '갱신' : '자동 등록'}됨 — id <code>{result.collector.id}</code> · <code>{result.collector.url}</code></div>
              : <div style={{ color: 'var(--amber)', marginTop: 4 }}>⚠ 수집 서버 자동 등록 건너뜀{result.collector.reason ? ` — ${result.collector.reason}` : ''}</div>)}
            {typeof result.log === 'string' && result.log.trim() && (
              <div style={{ marginTop: 8 }}>
                <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>대상 호스트 서비스 로그(journalctl/status)</div>
                <pre style={{ background: '#0b1220', border: '1px solid #243049', borderRadius: 8, padding: 10, fontSize: 11, lineHeight: 1.5, maxHeight: '36vh', overflow: 'auto', whiteSpace: 'pre-wrap' }}>{result.log}</pre>
              </div>
            )}
            {result.kind === 'pkg' && result.ok && <div>저장: <code>{result.file}</code> ({(result.sizeBytes / 1048576).toFixed(1)} MB) · v{result.version}{result.verified ? ' · SHA-256 검증됨' : ''}</div>}
            {result.kind === 'deploy-all' && <div>{result.deployed}/{result.total} 성공
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {(result.results || []).map((x) => <li key={x.id} style={{ color: x.ok ? 'var(--green)' : 'var(--red)' }}>{x.host} · {x.agentName || ''} — {x.ok ? (x.active || 'ok') : x.reason}</li>)}
              </ul>
            </div>}
          </div>
          {Array.isArray(result.log) && result.log.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>실행 로그 ({result.log.length})</summary>
              <pre style={{ fontSize: 11, maxHeight: 240, overflow: 'auto', background: '#0b1020', padding: 10, borderRadius: 6, marginTop: 6 }}>
                {result.log.map((l, i) => `$ ${l.command}\n${(l.stdout || '') + (l.stderr || '')}`.trim()).join('\n\n')}
              </pre>
            </details>
          )}
        </div>
      )}

      <div className="muted" style={{ fontSize: 12, marginTop: 12, lineHeight: 1.7 }}>
        동작: 중앙 서버의 오프라인 설치 패키지를 대상 호스트로 SFTP 전송 → <code>install.sh</code> 실행 →
        portal.env에 에이전트 설정 주입 → <code>vmware-portal</code> 서비스 재시작. 설치 후 설정 → 수집 서버/에이전트 작업에서 등록·확인하세요.
      </div>
    </>
  );
}
