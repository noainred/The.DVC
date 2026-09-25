import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, downloadFile } from '../api.js';
import { agoText } from './tools/relTime.js';
import { STable } from '../components/STable.jsx';

/**
 * Edge 노드 **대량 배포**(v2.432, 사용자 요구 '엣지노드 배포를 대용량으로 할 수 있게 import export text 방식과
 * 입력 전에 배포하는 기능').
 *
 * 기존 흐름과의 차이: '에이전트 추가/변경'은 한 대씩 폼에 입력해 저장(등록)한 뒤 배포한다. 여기서는
 * 엑셀/위키 표를 **그대로 붙여넣어 등록 없이 바로 설치**하고, 성공한 노드만 선택적으로 저장·수집 서버 등록한다.
 * 진행은 runId 폴링(설치는 노드당 수 분이라 요청 하나로 기다릴 수 없다).
 */
const ST = {
  queued: ['대기', 'gray'], running: ['설치 중', 'blue'], ok: ['성공', 'green'],
  fail: ['실패', 'red'], cancelled: ['취소', 'amber'],
};
const EMPTY_DEFAULTS = {
  username: 'root', password: '', privateKey: '', passphrase: '', port: '22',
  centralUrl: '', centralToken: '', collectorToken: '', portalPort: '4000', installerPath: '',
  autoUpgrade: true, pushInventory: false,
};
const dur = (ms) => (!ms ? '—' : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}초` : `${Math.floor(ms / 60_000)}분 ${Math.round((ms % 60_000) / 1000)}초`);
// v2.613 DEPS2613-11: 상대시각은 공용 코어 relTime.agoText 하나다(로컬 ago 사본 제거).

export default function BulkDeploy() {
  // ⚠ 훅은 전부 조기 return 위에(React #310 회귀 방지).
  const [text, setText] = useState('');
  const [d, setD] = useState(EMPTY_DEFAULTS);
  const [preview, setPreview] = useState(null);
  const [run, setRun] = useState(null);
  const [runs, setRuns] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [opts, setOpts] = useState({ saveTargets: true, registerCollector: true });
  const [openLog, setOpenLog] = useState(null);
  const [defaultsFromServer, setDefaultsFromServer] = useState(null);
  const [presets, setPresets] = useState([]);           // 열 순서 프리셋(서버 정의)
  const [columns, setColumns] = useState('host-name-user-pass');
  const [autoTok, setAutoTok] = useState({ autoCentralToken: true, autoCollectorToken: true });
  const [tokenInfo, setTokenInfo] = useState({ hasToken: false });
  const pollRef = useRef(null);

  const loadRuns = async () => { try { const r = await fetchJson('/admin/agent-deploy/bulk'); setRuns(r.runs || []); } catch { /* 목록 실패는 무시 */ } };
  useEffect(() => {
    loadRuns();
    fetchJson('/admin/agent-deploy/defaults')
      .then((r) => { setDefaultsFromServer(r); setD((p) => ({ ...p, centralUrl: p.centralUrl || r.centralUrl || '' })); })
      .catch(() => {});
    fetchJson('/admin/agent-deploy/bulk/presets')
      .then((r) => { setPresets(r.presets || []); setColumns((c) => c || r.defaultPreset); setTokenInfo((t) => ({ ...t, hasToken: !!r.hasCentralToken })); })
      .catch(() => {});
    // 중앙 토큰은 설정 소유자만 조회할 수 있다 — 실패해도 화면은 그대로 동작(자동 채움만 꺼진다).
    fetchJson('/admin/central-token').then((r) => setTokenInfo(r || { hasToken: false })).catch(() => {});
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // 진행 중 실행 폴링 — 끝나면 자동 정지.
  useEffect(() => {
    if (!run?.runId || run.status !== 'running') return undefined;
    const t = setInterval(async () => {
      try {
        const r = await fetchJson(`/admin/agent-deploy/bulk/${run.runId}`);
        setRun(r);
        if (r.status !== 'running') { clearInterval(t); loadRuns(); }
      } catch { /* 일시 오류는 다음 틱에 재시도 */ }
    }, 2000);
    pollRef.current = t;
    return () => clearInterval(t);
  }, [run?.runId, run?.status]);

  const set = (k, v) => setD((p) => ({ ...p, [k]: v }));
  const call = async (label, fn) => {
    setBusy(true); setMsg(null);
    try { const r = await fn(); if (r && r.ok === false) setMsg(`${label} 실패: ${r.reason || ''}`); return r; }
    catch (e) { setMsg(`${label} 실패: ${e.message}`); return null; }
    finally { setBusy(false); }
  };
  const doPreview = () => call('미리보기', async () => {
    const r = await postJson('/admin/agent-deploy/bulk/preview', { text, defaults: d, columns, ...autoTok });
    if (r.ok) { setPreview(r); setMsg(`인식 ${r.total}행 — 배포 가능 ${r.summary.ready} · 오류 ${r.summary.error}${r.skipped.length ? ` · 건너뜀 ${r.skipped.length}줄` : ''}`); }
    else setPreview(null);
    return r;
  });
  const doRun = () => {
    const n = preview?.summary?.ready || 0;
    if (!n) { setMsg('배포 가능한 행이 없습니다. 먼저 미리보기로 확인하세요.'); return; }
    if (!window.confirm(`${n}대에 Edge 포탈을 설치합니다.\n\n각 노드에 SSH 로 접속해 패키지를 전송하고 install.sh 를 실행합니다(노드당 수 분).\n${opts.saveTargets ? '성공한 노드는 배포 대상으로 저장됩니다.' : '대상 저장 없이 설치만 합니다.'}\n\n계속할까요?`)) return;
    call('배포 시작', async () => {
      const r = await postJson('/admin/agent-deploy/bulk/run', { text, defaults: d, columns, ...autoTok, ...opts });
      if (r.ok) { setRun({ runId: r.runId, status: 'running', items: [], counts: {}, total: r.total }); setMsg(`배포 시작 — ${r.total}대${r.skippedErrors ? ` (오류 ${r.skippedErrors}행 제외)` : ''}`); }
      return r;
    });
  };
  const doCancel = () => run?.runId && call('취소', async () => {
    const r = await postJson(`/admin/agent-deploy/bulk/${run.runId}/cancel`, {});
    if (r.ok) setMsg('취소 요청 — 진행 중인 노드의 SSH 세션을 끊습니다.');
    return r;
  });
  const openRun = (runId) => call('실행 조회', async () => { const r = await fetchJson(`/admin/agent-deploy/bulk/${runId}`); setRun(r); return r; });
  const genCentralToken = () => call('중앙 토큰 생성', async () => {
    const r = await postJson('/admin/central-token/generate', { force: false });
    if (r?.token) { setTokenInfo({ hasToken: true, token: r.token }); setMsg('중앙 토큰이 준비되었습니다 — 배포 시 각 노드에 자동으로 들어갑니다.'); }
    return r;
  });
  const onFile = (e) => { const f = e.target.files?.[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => setText(String(rd.result || '')); rd.readAsText(f); e.target.value = ''; };

  const rep = preview?.report || [];
  const items = run?.items || [];
  const done = (run?.counts?.ok || 0) + (run?.counts?.fail || 0) + (run?.counts?.cancelled || 0);
  const pct = run?.total ? Math.round((done / run.total) * 100) : 0;

  return (
    <>
      <div className="card" style={{ marginBottom: 12, fontSize: 13, lineHeight: 1.7 }}>
        <b>대량 배포 — 붙여넣고 바로 설치</b><br />
        엑셀·위키의 서버 목록을 <b>그대로 붙여넣으면</b> 대상을 하나씩 등록하지 않아도 바로 설치합니다. 계정·비밀번호·중앙 URL 처럼 모든 노드가 같은 값은
        아래 <b>공통 자격증명/기본값</b>에 한 번만 넣고, 다른 노드만 표에 열을 추가하면 됩니다(행 값이 우선).
        <div className="muted" style={{ marginTop: 4 }}>
          정직한 한계: 설치는 노드당 수 분(패키지 SFTP 전송 + install.sh)이라 동시 실행 수를 낮게 잡습니다(<code>AGENT_DEPLOY_CONCURRENCY</code> 기본 2).
          <b>SSH 개인키는 행별로 넣을 수 없습니다</b>(여러 줄) — 공통 기본값의 키를 쓰거나 예외 노드는 '에이전트 추가/변경'에서 개별 등록하세요.
          공백으로 열을 나눌 때는 비밀번호에 공백을 쓸 수 없습니다(탭·쉼표 구분이나 공통 비밀번호를 쓰세요). install.sh 는 root 권한이 필요합니다.
        </div>
      </div>

      {/* 1) 목록 입력 */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 6 }}>
          <b style={{ fontSize: 14 }}>① 서버 목록 (붙여넣기 · 파일 · 내보내기)</b>
          <span style={{ flex: 1 }} />
          <input type="file" accept=".txt,.tsv,.csv,text/plain" onChange={onFile} style={{ fontSize: 12 }} title="CSV·TSV·TXT 파일을 올리면 아래 입력칸에 그대로 들어갑니다(쉼표·탭 자동 인식)" />
          <button className="tab" disabled={busy} onClick={() => call('샘플', () => downloadFile('/admin/agent-deploy/targets/sample.txt'))} title="붙여넣기 형식 안내(텍스트)">📄 샘플 TXT</button>
          <button className="tab" disabled={busy} onClick={() => call('샘플', () => downloadFile('/admin/agent-deploy/targets/sample.txt?format=csv'))} title="엑셀에서 열어 채운 뒤 그대로 올리면 됩니다">📄 샘플 CSV</button>
          <button className="tab" disabled={busy} onClick={() => call('내보내기', () => downloadFile('/admin/agent-deploy/targets/export.txt'))} title="저장된 배포 대상을 이 입력칸 형식(탭 구분)으로 내려받기 — 비밀 제외">⤓ TXT 내보내기</button>
          <button className="tab" disabled={busy} onClick={() => call('내보내기', () => downloadFile('/admin/agent-deploy/targets/export.txt?format=csv'))} title="저장된 배포 대상을 CSV(엑셀)로 내려받기 — 비밀 제외">⤓ CSV 내보내기</button>
        </div>

        {/* 열 순서 — 3열 표는 'host 이름 계정' 과 'host 계정 비밀번호' 를 값만 보고 구분할 수 없어 추측하지 않는다. */}
        <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 6, fontSize: 12 }}>
          <b>열 순서</b>
          <select className="input" style={{ minWidth: 300 }} value={columns} onChange={(e) => { setColumns(e.target.value); setPreview(null); }}>
            {(presets.length ? presets : [{ key: 'host-name-user-pass', label: 'host · 이름/법인 · 계정 · 비밀번호' }]).map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          <span className="muted">
            현재 <code>{(presets.find((p) => p.key === columns)?.columns || ['host']).map((c) => ({ host: 'host', agentName: '이름/법인', username: '계정', password: '비밀번호' }[c] || c)).join(' → ')}</code>
            {' '}· <b>헤더 행</b>을 적으면 이 선택보다 헤더가 우선합니다 · <code>root@10.1.1.1</code> 처럼 계정을 host 에 붙여 써도 됩니다.
          </span>
        </div>
        <textarea className="input" rows={9} style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
          value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }}
          placeholder={'10.112.158.221\tAZ\n10.113.158.221\tGM1\n10.114.158.221:2222\tGM2\n\n# 또는 헤더를 적어 열 순서를 자유롭게:\n# host\tagentName\tportalPort\n# 10.115.158.221\tHD\t4000'} />
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          위 <b>열 순서</b>대로 읽습니다(예: <code>10.1.1.1{'\t'}root{'\t'}Passw0rd!</code> 는 'host · 계정 · 비밀번호'). <code>#</code> 로 시작하는 줄과 빈 줄은 건너뜁니다.
          구분자는 탭 &gt; 쉼표(CSV) &gt; 공백 순으로 자동 인식하며, <b>CSV 파일을 그대로 올려도</b> 됩니다. 헤더를 적으면 열 순서가 자유롭고 별칭(ip·계정·법인·포탈포트·수집토큰 …)도 인식합니다.
        </div>
      </div>

      {/* 2) 공통 기본값 */}
      <div className="card" style={{ marginBottom: 12 }}>
        <b style={{ fontSize: 14 }}>② 공통 자격증명 / 기본값</b>
        <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>목록의 각 행에 값이 없을 때 사용합니다.</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginTop: 8, fontSize: 12 }}>
          <label>SSH 계정<input className="input" style={{ width: '100%', minWidth: 0 }} value={d.username} onChange={(e) => set('username', e.target.value)} placeholder="root" autoComplete="off" /></label>
          <label>SSH 포트<input className="input" type="number" style={{ width: '100%', minWidth: 0 }} value={d.port} onChange={(e) => set('port', e.target.value)} /></label>
          <label>SSH 비밀번호<input className="input" type="password" style={{ width: '100%', minWidth: 0 }} value={d.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" /></label>
          <label>키 패스프레이즈<input className="input" type="password" style={{ width: '100%', minWidth: 0 }} value={d.passphrase} onChange={(e) => set('passphrase', e.target.value)} autoComplete="new-password" /></label>
          <label>중앙 URL<input className="input" style={{ width: '100%', minWidth: 0 }} value={d.centralUrl} onChange={(e) => set('centralUrl', e.target.value)} placeholder={defaultsFromServer?.centralUrl || 'http://중앙:4000'} /></label>
          <label>엣지 포탈 포트<input className="input" type="number" style={{ width: '100%', minWidth: 0 }} value={d.portalPort} onChange={(e) => set('portalPort', e.target.value)} /></label>
          <label>중앙 토큰 {autoTok.autoCentralToken && <span className="badge green">자동</span>}
            <input className="input" type="password" style={{ width: '100%', minWidth: 0 }} value={d.centralToken} onChange={(e) => set('centralToken', e.target.value)} placeholder={autoTok.autoCentralToken ? (tokenInfo.hasToken ? '이 포탈의 중앙 토큰을 자동 사용' : '중앙 토큰 없음 — 생성 필요') : ''} autoComplete="new-password" disabled={autoTok.autoCentralToken} /></label>
          <label>수집 토큰 {autoTok.autoCollectorToken && <span className="badge green">노드별 자동</span>}
            <input className="input" type="password" style={{ width: '100%', minWidth: 0 }} value={d.collectorToken} onChange={(e) => set('collectorToken', e.target.value)} placeholder={autoTok.autoCollectorToken ? '노드마다 새 난수를 생성' : ''} autoComplete="new-password" disabled={autoTok.autoCollectorToken} /></label>
          <label>설치 패키지 경로<input className="input" style={{ width: '100%', minWidth: 0 }} value={d.installerPath} onChange={(e) => set('installerPath', e.target.value)} placeholder="비우면 중앙 기본 패키지" /></label>
        </div>
        <label style={{ fontSize: 12, display: 'block', marginTop: 8 }}>SSH 개인키 (PEM/OpenSSH) — 비밀번호 대신 전 노드 공통으로 사용
          <textarea className="input" rows={3} style={{ width: '100%', fontFamily: 'monospace', fontSize: 11 }} value={d.privateKey} onChange={(e) => set('privateKey', e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
        </label>
        <div className="flex gap wrap" style={{ fontSize: 12, marginTop: 6, alignItems: 'center' }}>
          <label className="flex gap" style={{ alignItems: 'center' }}><input type="checkbox" checked={d.autoUpgrade} onChange={(e) => set('autoUpgrade', e.target.checked)} />자동 업그레이드</label>
          <label className="flex gap" style={{ alignItems: 'center' }}><input type="checkbox" checked={d.pushInventory} onChange={(e) => set('pushInventory', e.target.checked)} />인벤토리 push</label>
          <span style={{ opacity: .4 }}>|</span>
          <label className="flex gap" style={{ alignItems: 'center' }} title="이 포탈에 저장된 중앙 토큰(CENTRAL_TOKEN)을 각 노드에 자동으로 넣습니다.">
            <input type="checkbox" checked={autoTok.autoCentralToken} onChange={(e) => setAutoTok((p) => ({ ...p, autoCentralToken: e.target.checked }))} />중앙 토큰 자동
            {autoTok.autoCentralToken && (tokenInfo.hasToken
              ? <span className="badge green">준비됨</span>
              : <button className="tab" type="button" disabled={busy} onClick={genCentralToken} style={{ padding: '2px 8px' }}>생성</button>)}
          </label>
          <label className="flex gap" style={{ alignItems: 'center' }} title="수집 토큰은 중앙이 각 엣지를 당겨갈 때 쓰는 비밀입니다. 한 값을 전 노드가 공유하면 한 대만 털려도 전 사이트 수집 데이터가 열리므로, 노드마다 다른 난수를 만듭니다.">
            <input type="checkbox" checked={autoTok.autoCollectorToken} onChange={(e) => setAutoTok((p) => ({ ...p, autoCollectorToken: e.target.checked }))} />수집 토큰 노드별 자동 생성
          </label>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          토큰 자동을 켜면 표·공통값에 토큰을 적지 않아도 됩니다(표에 값을 적으면 그 값이 우선). 수집 토큰은 <b>노드마다 다른 값</b>으로 만들고, 배포 성공 시 그 값으로 수집 서버에 자동 등록됩니다.
        </div>
      </div>

      {/* 3) 미리보기 → 배포 */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <b style={{ fontSize: 14 }}>③ 확인 후 배포</b>
          <span style={{ flex: 1 }} />
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 12 }}><input type="checkbox" checked={opts.saveTargets} onChange={(e) => setOpts((p) => ({ ...p, saveTargets: e.target.checked }))} />성공한 노드를 배포 대상으로 저장</label>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 12 }}><input type="checkbox" checked={opts.registerCollector} onChange={(e) => setOpts((p) => ({ ...p, registerCollector: e.target.checked }))} />수집 서버 자동 등록(수집 토큰 필요)</label>
          <button className="tab" disabled={busy || !text.trim()} onClick={doPreview}>미리보기</button>
          <button className="login-btn" style={{ flex: 'none', padding: '6px 16px' }} disabled={busy || !preview?.summary?.ready || run?.status === 'running'} onClick={doRun}>
            {run?.status === 'running' ? '배포 진행 중…' : `배포 시작${preview?.summary?.ready ? ` (${preview.summary.ready}대)` : ''}`}
          </button>
        </div>
        {msg && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{msg}</div>}

        {preview && (
          <>
            <div className="flex gap wrap" style={{ fontSize: 12, margin: '8px 0 4px' }}>
              <span className="badge green">배포 가능 {preview.summary.ready}</span>
              <span className={`badge ${preview.summary.error ? 'red' : 'gray'}`}>오류 {preview.summary.error}</span>
              <span className="badge blue">신규 {preview.summary.new}</span>
              <span className="badge">기존 대상 {preview.summary.known}</span>
              {preview.header && <span className="badge purple">헤더 인식됨</span>}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <STable style={{ fontSize: 12 }}>
                <thead><tr><th>줄</th><th>host</th><th>SSH</th><th>계정</th><th>이름/법인</th><th>포탈</th><th>인증</th><th>중앙 토큰</th><th>수집 토큰</th><th>상태</th><th>사유</th></tr></thead>
                <tbody>{rep.map((r) => (
                  <tr key={r.line}>
                    <td>{r.line}</td><td><b>{r.host}</b></td><td>{r.port}</td><td>{r.username}</td>
                    <td>{r.agentName}{r.collectorDatacenter && r.collectorDatacenter !== r.agentName ? ` / ${r.collectorDatacenter}` : ''}</td>
                    <td>{r.portalPort || '기본'}</td>
                    <td>{r.auth === 'key' ? <span className="badge blue">키</span> : r.auth === 'password' ? <span className="badge">비밀번호</span> : <span className="badge red">없음</span>}</td>
                    <td>{r.centralToken === 'auto' ? <span className="badge green">자동</span> : r.centralToken === 'set' ? <span className="badge">입력</span> : <span className="badge gray">없음</span>}</td>
                    <td>{r.collectorToken === 'auto' ? <span className="badge green">자동 생성</span> : r.collectorToken === 'set' ? <span className="badge">입력</span> : <span className="badge gray">없음</span>}</td>
                    <td>{r.action === 'deploy' ? <span className={`badge ${r.existing ? 'teal' : 'green'}`}>{r.existing ? '배포(기존 대상)' : '배포(신규)'}</span> : <span className="badge red">오류</span>}</td>
                    <td className="muted">{r.reason || ''}</td>
                  </tr>))}</tbody>
              </STable>
            </div>
            {preview.skipped?.length > 0 && (
              <details style={{ marginTop: 6 }}>
                <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>건너뛴 줄 {preview.skipped.length}개</summary>
                <pre style={{ fontSize: 11, maxHeight: 140, overflow: 'auto' }}>{preview.skipped.map((s) => `${s.line}: ${s.reason} — ${s.text}`).join('\n')}</pre>
              </details>
            )}
          </>
        )}
      </div>

      {/* 4) 진행 상황 */}
      {run && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="flex gap wrap" style={{ alignItems: 'center' }}>
            <b style={{ fontSize: 14 }}>배포 진행 — {run.runId}</b>
            <span className={`badge ${run.status === 'running' ? 'blue' : run.status === 'cancelled' ? 'amber' : 'green'}`}>{run.status === 'running' ? '진행 중' : run.status === 'cancelled' ? '취소됨' : '완료'}</span>
            <span className="muted" style={{ fontSize: 12 }}>{agoText(run.at)} 시작 · {done}/{run.total} ({pct}%)</span>
            <span style={{ flex: 1 }} />
            {run.status === 'running' && <button className="logout-btn" style={{ flex: 'none', padding: '6px 14px' }} disabled={busy} onClick={doCancel}>취소</button>}
          </div>
          <div style={{ height: 8, borderRadius: 4, background: 'rgba(255,255,255,.08)', margin: '8px 0', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width .3s' }} />
          </div>
          <div className="flex gap wrap" style={{ fontSize: 12, marginBottom: 6 }}>
            <span className="badge green">성공 {run.counts?.ok || 0}</span>
            <span className={`badge ${run.counts?.fail ? 'red' : 'gray'}`}>실패 {run.counts?.fail || 0}</span>
            <span className="badge blue">설치 중 {run.counts?.running || 0}</span>
            <span className="badge">대기 {run.counts?.queued || 0}</span>
            {!!run.counts?.cancelled && <span className="badge amber">취소 {run.counts.cancelled}</span>}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <STable style={{ fontSize: 12 }}>
              <thead><tr><th>host</th><th>이름/법인</th><th>계정</th><th>상태</th><th>서비스</th><th>소요</th><th>저장</th><th>수집 등록</th><th>사유</th><th data-nosort>로그</th></tr></thead>
              <tbody>{items.map((it) => (
                <tr key={`${it.line}-${it.host}`}>
                  <td><b>{it.host}</b>{it.port !== 22 ? `:${it.port}` : ''}</td>
                  <td>{it.agentName}{it.collectorDatacenter && it.collectorDatacenter !== it.agentName ? ` / ${it.collectorDatacenter}` : ''}</td>
                  <td>{it.username}</td>
                  <td><span className={`badge ${ST[it.status]?.[1] || 'gray'}`}>{ST[it.status]?.[0] || it.status}</span></td>
                  <td>{it.active || '—'}</td>
                  <td data-sort={it.ms || 0}>{dur(it.ms)}</td>
                  <td>{it.saved ? (it.saved.saved ? <span className="badge green">{it.saved.updated ? '갱신' : '저장'}</span> : <span className="badge red" title={it.saved.reason}>실패</span>) : '—'}</td>
                  <td>{it.collector ? (it.collector.registered ? <span className="badge green" title={it.collector.url}>{it.collector.updated ? '갱신' : '등록'}</span> : <span className="badge amber" title={it.collector.reason}>미등록</span>) : '—'}</td>
                  <td className="muted" style={{ maxWidth: 320 }}>{it.reason || ''}</td>
                  <td>{it.log ? <button className="tab" onClick={() => setOpenLog(openLog === it.host ? null : it.host)}>{openLog === it.host ? '닫기' : '보기'}</button> : '—'}</td>
                </tr>))}</tbody>
            </STable>
          </div>
          {openLog && items.find((i) => i.host === openLog)?.log && (
            <pre style={{ fontSize: 11, maxHeight: 320, overflow: 'auto', marginTop: 6 }}>{items.find((i) => i.host === openLog).log}</pre>
          )}
        </div>
      )}

      {runs.length > 0 && (
        <div className="card">
          <b style={{ fontSize: 14 }}>최근 실행</b> <span className="muted" style={{ fontSize: 12 }}>(최근 5회만 보관 — 서버 재시작 시 사라집니다)</span>
          <STable style={{ marginTop: 6, fontSize: 12 }}>
            <thead><tr><th>실행</th><th>상태</th><th>대상</th><th>성공</th><th>실패</th><th>시작</th><th>실행자</th><th data-nosort>보기</th></tr></thead>
            <tbody>{runs.map((r) => (
              <tr key={r.runId}>
                <td style={{ fontFamily: 'monospace' }}>{r.runId}</td>
                <td><span className={`badge ${r.status === 'running' ? 'blue' : r.status === 'cancelled' ? 'amber' : 'green'}`}>{r.status}</span></td>
                <td>{r.total}</td><td>{r.ok}</td><td>{r.fail}</td>
                <td data-sort={r.at}>{agoText(r.at)}</td><td>{r.by || '—'}</td>
                <td><button className="tab" disabled={busy} onClick={() => openRun(r.runId)}>열기</button></td>
              </tr>))}</tbody>
          </STable>
        </div>
      )}
    </>
  );
}
