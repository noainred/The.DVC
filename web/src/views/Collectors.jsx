import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson, downloadFile } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import EscClose from '../components/EscClose.jsx';

const EMPTY = { id: '', name: '', datacenter: '', url: 'http://', token: '', enabled: true };

export default function Collectors() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState(null);
  const [upgFails, setUpgFails] = useState(null); // 모두 업그레이드 실패 엣지별 원인 [{name, reason}]
  const [central, setCentral] = useState(null);
  const [sort, setSort] = useState({ key: 'id', dir: 'asc' });
  const [ingest, setIngest] = useState(null); // 에이전트별 수신 트래픽 진단
  const [showToken, setShowToken] = useState(false); // 토큰 입력칸 표시/가리기
  const [pwForm, setPwForm] = useState(null);   // 엣지 비번 일괄 변경 폼 | null
  const [pwResult, setPwResult] = useState(null); // 일괄 변경 결과 { total, succeeded, results, central }
  const [pwBusy, setPwBusy] = useState(false);
  const [dcs, setDcs] = useState([]); // 데이터센터(법인) 목록 — 등록 폼 콤보박스용
  const [csvModal, setCsvModal] = useState(null); // 'export' | 'import' | null — CSV 일괄 관리(v2.338)

  const load = async () => {
    try { setData(await fetchJson('/admin/collectors')); setError(null); }
    catch (e) { setError(e.message); }
  };
  const loadIngest = () => fetchJson('/admin/central/ingest-stats').then(setIngest).catch(() => {});
  // 엣지별 개별 central 토큰 — 공유 토큰 1개의 광역 스코프를 좁힌다(발급/회수/이관 현황).
  const [agentTok, setAgentTok] = useState(null);   // { tokens[], auth{} }
  const [newTok, setNewTok] = useState(null);       // 발급 직후 1회 표시되는 평문 토큰
  const [tokAgent, setTokAgent] = useState('');
  const loadAgentTok = () => fetchJson('/admin/central/agent-tokens').then(setAgentTok).catch(() => setAgentTok(null));
  const issueTok = async () => {
    const name = tokAgent.trim();
    if (!name) { setBanner({ ok: false, text: '토큰을 발급할 엣지(에이전트) 이름을 입력하세요.' }); return; }
    if (!window.confirm(`'${name}' 엣지의 개별 central 토큰을 발급할까요?\n\n· 기존 토큰이 있으면 교체(회전)됩니다 — 그 엣지의 CENTRAL_TOKEN을 새 값으로 바꿔야 통신이 이어집니다.\n· 평문 토큰은 지금 한 번만 표시됩니다.`)) return;
    setBusy(true); setBanner(null);
    try {
      const r = await postJson('/admin/central/agent-tokens', { agent: name });
      if (r.ok) { setNewTok({ agent: r.agent, token: r.token }); setTokAgent(''); await loadAgentTok(); }
      else setBanner({ ok: false, text: r.reason });
    } catch (e) { setBanner({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };
  const revokeTok = async (agent) => {
    if (!window.confirm(`'${agent}' 개별 토큰을 회수할까요? 그 엣지는 공유 CENTRAL_TOKEN으로만 접속할 수 있게 됩니다.`)) return;
    try { await delJson(`/admin/central/agent-tokens/${encodeURIComponent(agent)}`); await loadAgentTok(); }
    catch (e) { setBanner({ ok: false, text: e.message }); }
  };
  const resetIngest = async () => {
    if (!window.confirm('수신 트래픽 통계를 초기화할까요? (다시 0부터 집계)')) return;
    try { await postJson('/admin/central/ingest-stats/reset', {}); await loadIngest(); } catch { /* */ }
  };
  const reloadTimer = useRef(null); // 업그레이드 후 지연 재조회 타이머(언마운트 시 정리)
  useEffect(() => {
    load(); loadIngest(); loadAgentTok();
    fetchJson('/health').then((h) => setCentral(h.version)).catch(() => {});
    fetchJson('/admin/datacenters').then((d) => setDcs(d.datacenters || [])).catch(() => {}); // 데이터센터 콤보박스 옵션

    const t = setInterval(() => { load(); loadIngest(); }, 15_000);
    return () => { clearInterval(t); if (reloadTimer.current) clearTimeout(reloadTimer.current); };
  }, []);

  const upgrade = async (id) => {
    const who = id ? `'${id}' 에이전트` : '모든 수집 에이전트';
    if (!window.confirm(`${who}를 중앙 포탈 버전(v${central || '?'})으로 업그레이드하고 재시작할까요?`)) return;
    setBusy(true); setBanner(null); setUpgFails(null);
    try {
      const r = await postJson('/admin/collectors/upgrade', id ? { id } : {});
      // 실패한 엣지별 원인(403 토큰/연결불가/구버전 등)을 목록으로 노출 — 'X/Y 성공'만으론
      // 어디를 점검할지 알 수 없다. 중앙→엣지 방향 문제 진단의 핵심.
      const fails = (r.results || []).filter((x) => !x.ok)
        .map((x) => ({ name: x.name || x.id, reason: x.reason || `HTTP ${x.status || '?'}` }));
      setUpgFails(fails.length ? fails : null);
      setBanner(r.ok
        ? { ok: r.succeeded === r.pushed, text: `업그레이드 푸시: ${r.succeeded}/${r.pushed} 성공 (v${r.version}, ${r.source})${r.succeeded < r.pushed ? ' — 실패 원인은 아래 참고' : ''}` }
        : { ok: false, text: r.reason });
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(load, 5000);
    } catch (e) { setBanner({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  // 데이터 보유 중 일시 폴링 오류(고RTT WAN·업그레이드 직후 502)로 화면 전체를 오류로
  // 갈아치우지 않는다 — 데이터가 없을 때만 전체 오류, 그 외엔 아래 배너로 표시(깜빡임 방지).
  if (error && !data) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const openAdd = () => { setEditing(false); setForm({ ...EMPTY }); setMsg(null); setShowToken(false); };
  const openEdit = (c) => { setEditing(true); setForm({ ...EMPTY, ...c, token: '' }); setMsg(null); setShowToken(false); };
  const close = () => { setForm(null); setMsg(null); setShowToken(false); };
  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // 안전한 랜덤 COLLECTOR_TOKEN 자동 생성(브라우저 CSPRNG). 24바이트 → URL-safe base64(약 32자).
  // 생성 즉시 필드에 채우고 표시로 전환, 가능하면 클립보드에도 복사한다(에이전트에 동일 토큰 설정용).
  const genToken = () => {
    const rng = (typeof window !== 'undefined' && (window.crypto || window.msCrypto));
    if (!rng || !rng.getRandomValues) { setMsg({ ok: false, text: '이 브라우저에서 보안 난수를 생성할 수 없습니다.' }); return; }
    const bytes = new Uint8Array(24);
    rng.getRandomValues(bytes);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const tok = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    setForm((f) => ({ ...f, token: tok }));
    setShowToken(true);
    const done = (copied) => setMsg({ ok: true, text: `토큰을 생성했습니다${copied ? ' · 클립보드에 복사됨' : ''}. 에이전트를 COLLECTOR_TOKEN=${tok} 로 실행하세요(값은 위 칸에서 확인).` });
    try {
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(tok).then(() => done(true)).catch(() => done(false));
      else done(false);
    } catch { done(false); }
  };

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = editing ? await putJson(`/admin/collectors/${encodeURIComponent(form.id)}`, form) : await postJson('/admin/collectors', form);
      if (r.ok) { await load(); close(); } else setMsg({ ok: false, text: r.reason });
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  const test = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/admin/collectors/test', form);
      const retryNote = r.retried ? ` · 재시도 ${r.retried}회` : '';
      setMsg(r.ok
        ? { ok: true, text: `연결 성공 (${r.ms}ms${retryNote}) · 호스트 ${r.hosts ?? '—'}대 · v${r.version || '?'}${r.datacenter ? ` · ${r.datacenter}` : ''}` }
        : { ok: false, text: `연결 실패: ${r.reason}${r.retried ? ` (재시도 ${r.retried}회 후)` : ''}` });
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  // 토큰 강제 동기화 — 연결 테스트 403(토큰 불일치) 시, 이 화면의 토큰(비우면 저장된 토큰)을
  // 'Edge 노드 포탈 설치'의 저장된 SSH 대상으로 엣지 portal.env에 강제 반영 + 서비스 재시작.
  const forceToken = async () => {
    if (!editing) return;
    if (!window.confirm(`'${form.id}' 엣지(${form.url})의 COLLECTOR_TOKEN을 이 화면의 토큰으로 강제 교체하고 서비스를 재시작할까요?\n\n· 저장된 'Edge 노드 포탈 설치' SSH 대상을 사용합니다.\n· 중앙 저장 토큰도 같은 값으로 고정(🔒)됩니다.`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await postJson(`/admin/collectors/${encodeURIComponent(form.id)}/force-token`, { token: form.token || undefined, url: form.url || undefined });
      setMsg(r.ok
        ? { ok: true, text: `토큰 강제 동기화 완료 — ${r.host} (SSH 대상: ${r.sshTarget}${r.unit && r.unit !== 'vmware-portal' ? ` · 인스턴스 ${r.unit}` : ''}) · 서비스 ${r.active}${r.note ? ` · ${r.note}` : ''}${r.verified ? ' · 연결 재검증 성공 ✅' : ` · 재검증 실패(${r.verifyReason || '?'}) — 잠시 후 '연결 테스트'를 다시 실행하세요`}` }
        : { ok: false, text: `토큰 강제 동기화 실패: ${r.reason}` });
      if (r.ok) await load();
    } catch (e) { setMsg({ ok: false, text: `토큰 강제 동기화 실패: ${e.message}` }); }
    finally { setBusy(false); }
  };

  const remove = async (c) => {
    if (!window.confirm(`'${c.name}' (${c.id}) 수집 서버를 삭제할까요?`)) return;
    try { await delJson(`/admin/collectors/${encodeURIComponent(c.id)}`); await load(); }
    catch (e) { setError(e.message); }
  };

  // 엣지 비번 일괄 변경 실행. ids를 주면 그 대상만(실패분 재시도용).
  const bulkSetPassword = async (ids) => {
    const f = pwForm;
    if (!f) return;
    if (!String(f.username || '').trim()) { setMsg({ ok: false, text: '계정명을 입력하세요.' }); return; }
    if ((f.password || '').length < 8) { setMsg({ ok: false, text: '비밀번호는 8자 이상이어야 합니다.' }); return; }
    if (f.password !== f.confirm) { setMsg({ ok: false, text: '비밀번호 확인이 일치하지 않습니다.' }); return; }
    if (!window.confirm(`${Array.isArray(ids) && ids.length ? `엣지 ${ids.length}대` : '활성 엣지 전체'}의 '${f.username.trim()}' 비밀번호를 변경할까요?${f.includeCentral ? '\n(이 중앙 포탈의 같은 계정도 함께 변경됩니다)' : ''}`)) return;
    setPwBusy(true); setMsg(null);
    try {
      const body = { username: f.username.trim(), password: f.password, includeCentral: !!f.includeCentral };
      if (Array.isArray(ids) && ids.length) body.ids = ids;
      const r = await postJson('/admin/collectors/set-password', body);
      setPwResult(r);
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setPwBusy(false); }
  };

  // 상태가 '오류'(status.ok === false)인 수집 서버를 일괄 삭제.
  const removeErrored = async () => {
    const st = data.status || {}; const cols = data.collectors || [];
    const ids = cols.filter((c) => st[c.id] && st[c.id].ok === false).map((c) => c.id);
    if (!ids.length) { setBanner({ ok: false, text: '오류 상태인 수집 서버가 없습니다.' }); return; }
    if (!window.confirm(`오류 상태 수집 서버 ${ids.length}대를 일괄 삭제할까요?\n${ids.join(', ')}`)) return;
    setBusy(true);
    try { let n = 0; for (const id of ids) { try { await delJson(`/admin/collectors/${encodeURIComponent(id)}`); n++; } catch { /* */ } } await load(); setBanner({ ok: true, text: `오류 수집 서버 ${n}대 삭제 완료` }); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const pullNow = async () => {
    setBusy(true);
    try { await postJson('/admin/collectors/pull', {}); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const list = data.collectors || [];
  const status = data.status || {};
  const totalHosts = Object.values(status).reduce((a, s) => a + (s.ok ? (s.hosts || 0) : 0), 0);
  const erroredCount = list.filter((c) => status[c.id] && status[c.id].ok === false).length;
  // 등록된 에이전트 수량 통계(상태별).
  const registeredCount = list.length;
  const onlineCount = list.filter((c) => { const s = status[c.id]; return s && s.ok && !s.degraded; }).length;
  const degradedCount = list.filter((c) => { const s = status[c.id]; return s && s.ok && s.degraded; }).length;
  const pendingCount = list.filter((c) => !status[c.id]).length;
  const enabledCount = list.filter((c) => c.enabled !== false).length;

  // 정렬 — 헤더 클릭으로 키/방향 토글. status 파생 컬럼(상태·호스트·버전·동기화)도 지원.
  const sortVal = (c) => {
    const s = status[c.id] || {};
    switch (sort.key) {
      case 'name': return c.name || '';
      case 'datacenter': return c.datacenter || '';
      case 'url': return c.url || '';
      case 'state': return s.ok ? (s.degraded ? 1.5 : 2) : (s.ok === false ? 0 : 1); // 오류<대기<저하<정상
      case 'hosts': return s.ok ? (s.hosts || 0) : -1;
      case 'version': return s.version || '';
      case 'sync': return s.at || 0;
      case 'enabled': return c.enabled === false ? 0 : 1;
      default: return c.id || '';
    }
  };
  const sortedList = [...list].sort((a, b) => {
    const va = sortVal(a), vb = sortVal(b);
    const r = (typeof va === 'number' && typeof vb === 'number') ? va - vb : String(va).localeCompare(String(vb));
    return sort.dir === 'asc' ? r : -r;
  });
  const arrow = (k) => (sort.key === k ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');
  const th = (k, label, extra = {}) => (
    <th {...extra} style={{ cursor: 'pointer', userSelect: 'none', ...(extra.style || {}) }}
      onClick={() => setSort((s) => ({ key: k, dir: s.key === k && s.dir === 'asc' ? 'desc' : 'asc' }))}>{label}{arrow(k)}</th>
  );

  return (
    <>
      {error && <div className="card" style={{ marginBottom: 8, padding: '8px 12px', color: 'var(--red)', fontSize: 12 }}>일시적 갱신 오류: {String(error.message || error)} — 직전 데이터를 표시 중입니다.</div>}
      <div className="flex between wrap gap" style={{ marginBottom: 6 }}>
        <div className="section-title" style={{ margin: '6px 0', display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          수집 서버 — 분산 수집 (관리자)
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent, #60a5fa)' }} title="등록된 수집 에이전트 총 수량">등록 {registeredCount}대</span>
          <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
            (정상 {onlineCount}
            {degradedCount ? ` · 저하 ${degradedCount}` : ''}
            {erroredCount ? ` · 오류 ${erroredCount}` : ''}
            {pendingCount ? ` · 대기 ${pendingCount}` : ''}
            {' · 수집 ON '}{enabledCount})
          </span>
        </div>
        <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          {central && <span className="muted" style={{ fontSize: 12 }}>중앙 버전 <b style={{ color: 'var(--text)' }}>v{central}</b></span>}
          <button className="logout-btn" style={{ padding: '9px 14px' }} disabled={busy} onClick={pullNow}>지금 동기화</button>
          <button className="logout-btn" style={{ padding: '9px 14px' }} disabled={busy} onClick={() => upgrade(null)}>모두 업그레이드</button>
          <button className="logout-btn" style={{ padding: '9px 14px' }} disabled={busy || !enabledCount} title="모든(또는 선택한) 엣지 포탈의 로컬 계정 비밀번호를 한 번에 변경" onClick={() => { setPwForm({ username: 'admin', password: '', confirm: '', includeCentral: false }); setPwResult(null); }}>🔑 엣지 비번 일괄 변경</button>
          <button className="logout-btn" style={{ padding: '9px 14px', color: 'var(--red)', borderColor: erroredCount ? 'var(--red)' : undefined }} disabled={busy || !erroredCount} title="상태가 '오류'인 수집 서버를 일괄 삭제" onClick={removeErrored}>오류 서버 일괄 삭제{erroredCount ? ` (${erroredCount})` : ''}</button>
          <button className="logout-btn" style={{ padding: '9px 14px' }} title="등록 수집 서버 목록을 CSV 로 내려받기(기본 토큰 제외)" onClick={() => setCsvModal('export')}>⤓ CSV</button>
          <button className="logout-btn" style={{ padding: '9px 14px' }} title="CSV 로 수집 서버 일괄 등록/수정 — 검증(드라이런) 후 덮어쓰기 확인" onClick={() => setCsvModal('import')}>⤒ CSV 가져오기</button>
          <button className="login-btn" style={{ flex: 'none', padding: '9px 16px' }} onClick={openAdd}>+ 수집 서버 추가</button>
        </div>
      </div>

      {csvModal === 'export' && <CollectorsCsvExportModal onClose={() => setCsvModal(null)} />}
      {csvModal === 'import' && <CollectorsCsvImportModal onClose={() => setCsvModal(null)} onDone={() => { setCsvModal(null); load(); }} />}

      {banner && (
        <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13,
          background: banner.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
          color: banner.ok ? '#4ade80' : '#f87171' }}>{banner.text}</div>
      )}

      {upgFails && upgFails.length > 0 && (
        <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, fontSize: 12.5,
          background: 'rgba(245,158,11,.10)', border: '1px solid rgba(245,158,11,.25)' }}>
          <div style={{ color: '#fbbf24', fontWeight: 600, marginBottom: 6 }}>
            업그레이드 실패 {upgFails.length}대 — 엣지별 원인 (중앙→엣지 방향 점검)
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            {upgFails.map((f, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={{ color: '#e5e7eb', fontWeight: 600, minWidth: 90 }}>{f.name}</span>
                <span style={{ color: '#cbd5e1' }}>{f.reason}</span>
              </div>
            ))}
          </div>
          <div style={{ color: '#94a3b8', marginTop: 6, fontSize: 11.5 }}>
            토큰(403): 엣지 COLLECTOR_TOKEN과 동일하게 저장 · 연결불가: NAT/포트포워딩·포탈 기동 확인 · 구버전(404): 엣지가 자체 원격 소스로 자동 업그레이드될 때까지 대기
          </div>
        </div>
      )}

      <IngestStats data={ingest} onReset={resetIngest} />

      {/* 엣지별 개별 central 토큰 — 공유 토큰 1개면 엣지 1대 침해로 전 사이트 자격증명이 노출된다. */}
      <details className="card" style={{ marginBottom: 12, padding: '10px 14px' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
          🔑 엣지별 개별 central 토큰 ({(agentTok?.tokens || []).length}개 발급
          {agentTok?.auth?.uses ? ` · 공유 토큰 사용 ${agentTok.auth.uses}회` : ''})
        </summary>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.8, marginTop: 8 }}>
          공유 <code>CENTRAL_TOKEN</code> 하나만 쓰면, 엣지 1대가 침해되거나 토큰이 유출될 때 <b>다른 모든 사이트</b>의
          iDRAC 비밀번호·게스트 계정·사용자 해시를 <code>?agent=</code> 이름만 바꿔 전부 인출할 수 있습니다.
          엣지별 개별 토큰을 발급하면 그 토큰은 <b>자기 엣지 데이터만</b> 조회할 수 있습니다(남의 이름은 403).
          <br />이관 방법: 아래에서 발급 → 표시된 값을 그 엣지의 <code>CENTRAL_TOKEN</code>(또는 <code>EDGE_TOKEN</code>)에 넣고 재시작.
          엣지 코드 변경은 필요 없고, 이관하지 않은 엣지는 공유 토큰으로 계속 동작합니다(무중단).
          {agentTok?.auth?.lastAt && (
            <><br />마지막 공유 토큰 사용: <b>{agentTok.auth.lastAgent || '(unknown)'}</b> · {agentTok.auth.lastPath} · {new Date(agentTok.auth.lastAt).toLocaleString('ko-KR')} — 이 엣지가 아직 미이관입니다.</>
          )}
          {agentTok?.auth?.requireAgentToken && <><br />🔒 강화 모드(CENTRAL_REQUIRE_AGENT_TOKEN=true) — 공유 토큰은 거부됩니다.</>}
        </div>

        {newTok && (
          <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, background: 'rgba(34,197,94,.12)', border: '1px solid var(--green)' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#4ade80' }}>'{newTok.agent}' 토큰이 발급되었습니다 — 지금만 표시됩니다</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
              <input className="input" readOnly value={newTok.token} style={{ flex: 1, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} onFocus={(e) => e.target.select()} />
              <button className="logout-btn" style={{ padding: '6px 12px', whiteSpace: 'nowrap' }}
                onClick={() => { try { navigator.clipboard?.writeText(newTok.token); } catch { /* */ } }}>복사</button>
              <button className="logout-btn" style={{ padding: '6px 12px' }} onClick={() => setNewTok(null)}>닫기</button>
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              그 엣지에 <code>CENTRAL_TOKEN={newTok.token.slice(0, 6)}…</code> 로 설정(리눅스: /etc/vmware-portal/portal.env) 후 <code>systemctl restart vmware-portal</code>.
            </div>
          </div>
        )}

        {(agentTok?.tokens || []).length > 0 && (
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table>
              <thead><tr><th>엣지(에이전트)</th><th>발급</th><th>마지막 사용</th><th className="right">작업</th></tr></thead>
              <tbody>
                {agentTok.tokens.map((t) => (
                  <tr key={t.agent}>
                    <td><b>{t.agent}</b></td>
                    <td className="muted">{t.createdAt ? new Date(t.createdAt).toLocaleString('ko-KR') : '—'}</td>
                    <td className="muted">{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString('ko-KR') : <span style={{ color: 'var(--amber)' }}>미사용(엣지 설정 대기)</span>}</td>
                    <td className="right nowrap">
                      <button className="tab" disabled={busy} onClick={() => { setTokAgent(t.agent); }}>재발급(회전)</button>{' '}
                      <button className="tab" style={{ color: 'var(--red)' }} onClick={() => revokeTok(t.agent)}>회수</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex gap" style={{ marginTop: 10, alignItems: 'center' }}>
          <input className="input" style={{ maxWidth: 260 }} list="collector-agent-list" value={tokAgent} onChange={(e) => setTokAgent(e.target.value)} placeholder="엣지 이름(예: OC2)" />
          <datalist id="collector-agent-list">
            {(data.collectors || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </datalist>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={busy || !tokAgent.trim()} onClick={issueTok}>토큰 발급</button>
        </div>
      </details>

      <div className="card" style={{ marginBottom: 12, padding: '10px 14px' }}>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.8 }}>
          각 데이터센터에 포탈을 <b>수집 에이전트</b>로 설치하면(<code>COLLECTOR_TOKEN</code>·<code>COLLECTOR_DATACENTER</code> 설정),
          그 서버가 로컬 iDRAC/OME 전력을 수집합니다. 중앙 포탈은 여기에 등록된 수집 서버들을 주기적으로
          당겨와(<code>/api/collector/export</code>) 호스트 전력에 병합합니다. 1천대+·13개 DC 같은 대규모 환경에 적합합니다.
          {' '}등록된 수집 에이전트: <b style={{ color: 'var(--text)' }}>{registeredCount}</b>대(정상 {onlineCount}대)
          {' · '}현재 병합된 호스트: <b style={{ color: 'var(--text)' }}>{totalHosts.toLocaleString()}</b>대.
          <br />🔄 <b>자동 업그레이드</b>: 중앙 포탈이 새 버전으로 업그레이드되면 등록된 모든 에이전트로 자동 푸시됩니다.
          수동으로는 “모두 업그레이드”(또는 행별 “업그레이드”)로 즉시 동일 버전으로 맞출 수 있습니다.
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead><tr>
            {th('id', 'ID')}{th('name', '이름')}{th('datacenter', '데이터센터')}{th('url', 'URL')}{th('state', '상태')}{th('hosts', '호스트')}{th('version', '버전')}{th('sync', '최근 동기화')}{th('enabled', '수집')}<th className="right">작업</th>
          </tr></thead>
          <tbody>
            {sortedList.length === 0 && <tr><td colSpan={10} className="center muted" style={{ padding: 28 }}>등록된 수집 서버가 없습니다. “+ 수집 서버 추가”로 등록하세요.</td></tr>}
            {sortedList.map((c) => {
              const s = status[c.id];
              return (
                <tr key={c.id}>
                  <td><b>{c.id}</b></td>
                  <td>{c.name}</td>
                  <td>{c.datacenter ? <span className="badge blue">{c.datacenter}</span> : <span className="muted">—</span>}</td>
                  <td className="muted">{c.url}
                    {c.managed && <span className="badge gray" style={{ marginLeft: 6 }} title="관리자가 수동 수정한 항목 — 엣지 자기등록이 URL/토큰을 덮어쓰지 않습니다">🔒 고정</span>}
                  </td>
                  <td>{!s ? <span className="badge gray">대기</span>
                    : (s.ok && s.degraded) ? <span className="badge amber" title={`일시적 연결 오류: ${s.error || ''} — 직전 데이터·온라인 유지 중(연속 실패 ${s.fails || 1}회). 한 번 더 실패하면 '오류'로 내려갑니다.`}>저하</span>
                      : s.ok ? <span className="badge green">정상</span>
                        : <span className="badge red" title={s.error}>오류</span>}
                    {s?.authDeny?.count > 0 && (
                      <span className="badge amber" style={{ marginLeft: 4, fontSize: 10 }}
                        title={`엣지에서 인증 거부 ${s.authDeny.count}건(기동 후 누적) — 마지막: ${s.authDeny.lastWhy || ''}${s.authDeny.lastAt ? ` · ${new Date(s.authDeny.lastAt).toLocaleString('ko-KR')}` : ''} (${s.authDeny.lastEndpoint || ''}). 다른 중앙/구버전 토큰이 이 엣지를 두드리고 있을 수 있습니다.`}>
                        거부 {s.authDeny.count}
                      </span>
                    )}</td>
                  <td className="tabular">{s?.ok ? (s.hosts ?? 0).toLocaleString() : '—'}</td>
                  <td className="muted">
                    {s?.version ? <>v{s.version}{central && s.version !== central && <span className="badge amber" style={{ marginLeft: 6 }} title={`중앙 v${central}`}>구버전</span>}</> : '—'}
                    {s?.upgrade && <div className="muted" style={{ fontSize: 11, color: s.upgrade.ok ? 'var(--green)' : 'var(--red)' }}>{s.upgrade.ok ? `업그레이드 v${s.upgrade.version || ''} 적용` : `업그레이드 실패`}</div>}
                  </td>
                  <td className="muted">{s?.at ? new Date(s.at).toLocaleTimeString('ko-KR') : '—'}</td>
                  <td>{c.enabled === false ? <span className="badge gray">중지</span> : <span className="badge green">on</span>}</td>
                  <td className="right nowrap">
                    <button className="tab" disabled={busy} onClick={() => upgrade(c.id)}>업그레이드</button>
                    <button className="tab" onClick={() => openEdit(c)}>수정</button>
                    <button className="tab" style={{ color: 'var(--red)' }} onClick={() => remove(c)}>삭제</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {form && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
          <EscClose onClose={close} />
          <div className="modal card">
            <div className="flex between" style={{ marginBottom: 12 }}>
              <b style={{ fontSize: 15 }}>{editing ? `수집 서버 수정 — ${form.id}` : '새 수집 서버 등록'}</b>
              <button className="logout-btn" onClick={close}>닫기</button>
            </div>
            <div className="spec-grid">
              <label>ID *<input className="input" value={form.id} onChange={setF('id')} disabled={editing} placeholder="dc-seoul" /></label>
              <label>표시 이름 *<input className="input" value={form.name} onChange={setF('name')} placeholder="서울 수집서버" /></label>
              <label>데이터센터
                {/* 콤보박스: 등록된 법인 목록에서 선택하거나 직접 입력(datalist). */}
                <input className="input" list="collector-dc-list" value={form.datacenter} onChange={setF('datacenter')} placeholder="목록에서 선택 또는 입력" autoComplete="off" />
                <datalist id="collector-dc-list">
                  {dcs.map((d) => <option key={d.id} value={d.id}>{d.name && d.name !== d.id ? `${d.name}${d.region ? ` · ${d.region}` : ''}` : (d.region || '')}</option>)}
                </datalist>
              </label>
              <label>수집 여부
                <select className="select" value={form.enabled ? '1' : '0'} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.value === '1' }))}>
                  <option value="1">수집</option>
                  <option value="0">중지</option>
                </select>
              </label>
              <label style={{ gridColumn: '1 / -1' }}>수집 서버 URL *<input className="input" value={form.url} onChange={setF('url')} placeholder="http://10.10.0.5:4000" /></label>
              <label style={{ gridColumn: '1 / -1' }}>토큰 (COLLECTOR_TOKEN) {editing && <span className="muted">(비우면 유지)</span>}
                <div className="flex gap" style={{ alignItems: 'stretch' }}>
                  <input className="input" style={{ flex: 1 }} type={showToken ? 'text' : 'password'} value={form.token} onChange={setF('token')} placeholder={editing ? '••••••' : '에이전트의 COLLECTOR_TOKEN'} />
                  <button type="button" className="logout-btn" style={{ flex: 'none', padding: '0 12px' }} onClick={() => setShowToken((v) => !v)} title={showToken ? '가리기' : '표시'}>{showToken ? '🙈' : '👁'}</button>
                  <button type="button" className="logout-btn" style={{ flex: 'none', padding: '0 12px', whiteSpace: 'nowrap' }} onClick={genToken} title="안전한 랜덤 토큰을 자동 생성해 채웁니다">🎲 자동 생성</button>
                </div>
              </label>
            </div>

            <div className="muted" style={{ marginTop: 8, fontSize: 12, color: '#94a3b8' }}>
              🔒 저장하면 이 항목은 <b>관리자 고정</b>이 되어, 엣지 자기등록이 URL/토큰을 덮어쓰지 않습니다(저장 값이 원복되지 않음).
            </div>

            {msg && (
              <div style={{ marginTop: 12, padding: '9px 12px', borderRadius: 8, fontSize: 13,
                background: msg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
                color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.text}</div>
            )}

            <div className="flex gap" style={{ marginTop: 16 }}>
              <button className="login-btn" style={{ flex: 'none', padding: '10px 18px' }} disabled={busy} onClick={save}>
                {busy ? '저장 중…' : (editing ? '저장' : '등록')}
              </button>
              <button className="logout-btn" style={{ padding: '10px 18px' }} disabled={busy} onClick={test}>연결 테스트</button>
              {editing && (
                <button className="logout-btn" style={{ padding: '10px 18px', whiteSpace: 'nowrap' }} disabled={busy} onClick={forceToken}
                  title="토큰 불일치(403) 시: 저장된 SSH 배포 대상으로 엣지 portal.env의 COLLECTOR_TOKEN을 이 화면의 토큰으로 교체하고 서비스를 재시작합니다.">
                  🔧 토큰 강제 동기화
                </button>
              )}
            </div>
            <div className="muted" style={{ marginTop: 10, fontSize: 12, lineHeight: 1.7 }}>
              에이전트 서버는 다음으로 실행합니다: <code>COLLECTOR_TOKEN=&lt;토큰&gt; COLLECTOR_DATACENTER=Seoul-DC1</code>.
              그 서버의 ‘전력 수집’ 메뉴에서 로컬 iDRAC/OME를 등록하세요. 토큰은 <code>$CONFIG_DIR/collectors.json</code>(0600)에만 저장됩니다.
              {editing && <><br />🔧 <b>토큰 강제 동기화</b>: 연결 테스트가 403(토큰 불일치)일 때, 이 화면의 토큰(비우면 저장된 토큰)을
                ‘원격 법인(DC)에 Edge 노드 포탈 설치’에 저장된 SSH 대상으로 엣지에 직접 반영하고 서비스를 재시작한 뒤 재검증합니다.</>}
            </div>
          </div>
        </div>
      )}

      {pwForm && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !pwBusy) setPwForm(null); }}>
          <EscClose onClose={() => { if (!pwBusy) setPwForm(null); }} />
          <div className="modal card" style={{ maxWidth: 640 }}>
            <div className="flex between" style={{ marginBottom: 12 }}>
              <b style={{ fontSize: 15 }}>🔑 엣지 포탈 비밀번호 일괄 변경</b>
              <button className="logout-btn" disabled={pwBusy} onClick={() => setPwForm(null)}>닫기</button>
            </div>
            {!pwResult ? (
              <>
                <div className="muted" style={{ fontSize: 12, lineHeight: 1.7, marginBottom: 12 }}>
                  등록된 <b>활성 수집 서버 {enabledCount}대</b>의 로컬 계정 비밀번호를 한 번에 변경합니다
                  (기본 설치 비번 교체용). 엣지의 <code>COLLECTOR_TOKEN</code>으로 인증하므로 토큰이 저장된
                  서버만 대상이 되며, v2.107 미만 엣지는 먼저 업그레이드가 필요합니다.
                  OTP를 등록한 계정은 로그인에 OTP가 계속 우선됩니다(비번은 폴백).
                </div>
                <div className="spec-grid">
                  <label>계정<input className="input" value={pwForm.username} onChange={(e) => setPwForm((f) => ({ ...f, username: e.target.value }))} placeholder="admin" /></label>
                  <label>새 비밀번호 (8자 이상)<input className="input" type="password" value={pwForm.password} onChange={(e) => setPwForm((f) => ({ ...f, password: e.target.value }))} autoComplete="new-password" /></label>
                  <label>새 비밀번호 확인<input className="input" type="password" value={pwForm.confirm} onChange={(e) => setPwForm((f) => ({ ...f, confirm: e.target.value }))} autoComplete="new-password" /></label>
                  <label className="flex gap" style={{ alignItems: 'center', alignSelf: 'end', cursor: 'pointer', fontSize: 13 }}>
                    <input type="checkbox" checked={pwForm.includeCentral} onChange={(e) => setPwForm((f) => ({ ...f, includeCentral: e.target.checked }))} />
                    이 중앙 포탈의 같은 계정도 함께 변경
                  </label>
                </div>
                {msg && pwForm && (
                  <div style={{ marginTop: 12, padding: '9px 12px', borderRadius: 8, fontSize: 13, background: 'rgba(239,68,68,.12)', color: '#f87171' }}>{msg.text}</div>
                )}
                <div className="flex gap" style={{ marginTop: 16 }}>
                  <button className="login-btn" style={{ flex: 'none', padding: '10px 18px' }} disabled={pwBusy} onClick={bulkSetPassword}>
                    {pwBusy ? '변경 중…' : `${enabledCount}대 일괄 변경`}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ marginBottom: 10, padding: '9px 12px', borderRadius: 8, fontSize: 13,
                  background: pwResult.succeeded === pwResult.total ? 'rgba(34,197,94,.12)' : 'rgba(245,158,11,.12)',
                  color: pwResult.succeeded === pwResult.total ? '#4ade80' : '#fbbf24' }}>
                  완료 — 엣지 {pwResult.succeeded}/{pwResult.total}대 성공
                  {pwResult.central && ` · 중앙 포탈 ${pwResult.central.ok ? '변경됨' : `실패(${pwResult.central.reason})`}`}
                </div>
                <div className="table-wrap" style={{ maxHeight: '40vh' }}>
                  <table>
                    <thead><tr><th>엣지</th><th>결과</th><th>비고</th></tr></thead>
                    <tbody>
                      {(pwResult.results || []).map((r) => (
                        <tr key={r.id}>
                          <td><b>{r.name}</b> <span className="muted">({r.id})</span></td>
                          <td>{r.ok ? <span className="badge green">성공</span> : <span className="badge red">실패</span>}</td>
                          <td className="muted" style={{ fontSize: 12 }}>{r.ok ? `${r.edgeVersion ? `v${r.edgeVersion}` : ''}${r.totpEnabled ? ' · OTP 계정(로그인엔 OTP 우선)' : ''}` : r.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex gap" style={{ marginTop: 14 }}>
                  <button className="logout-btn" style={{ padding: '10px 18px' }} onClick={() => setPwForm(null)}>닫기</button>
                  {pwResult.succeeded < pwResult.total && (
                    <button className="login-btn" style={{ flex: 'none', padding: '10px 18px' }} disabled={pwBusy}
                      onClick={() => bulkSetPassword((pwResult.results || []).filter((r) => !r.ok).map((r) => r.id))}>
                      실패한 {pwResult.total - pwResult.succeeded}대만 재시도
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ---- 에이전트 수신 트래픽 진단 ---------------------------------------------
// 누가(어느 에이전트) 무엇을(엔드포인트·페이로드) 얼마나(와이어 바이트·빈도) 중앙에 보내는지.
// iftop에서 특정 에이전트 트래픽이 비정상적으로 높을 때, 원인이 '큰 페이로드'인지 '잦은 push'인지 짚어낸다.
function IngestStats({ data, onReset }) {
  const rows = data?.rows || [];
  const fmtB = (n) => (n == null ? '—' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`);
  const fmtRate = (bps) => (bps == null ? '—' : `${fmtB(bps)}/s`);
  const ago = (ts) => { if (!ts) return ''; const s = Math.floor((Date.now() - ts) / 1000); return s >= 60 ? `${Math.floor(s / 60)}분 전` : `${s}초 전`; };
  // 상위 에이전트가 평균의 몇 배인지로 '비정상' 강조.
  const avgRate = rows.length ? rows.reduce((a, r) => a + (r.bytesPerSec || 0), 0) / rows.length : 0;
  const ep = (e) => (e || '').replace(/^\//, '');

  return (
    <div className="card" style={{ marginBottom: 12, padding: '12px 16px', borderLeft: '3px solid var(--accent, #60a5fa)' }}>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 8 }}>
        <b style={{ fontSize: 13 }}>에이전트 수신 트래픽 진단 {data?.since ? <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>(집계 시작 {ago(data.since)})</span> : null}</b>
        <button className="logout-btn" style={{ padding: '6px 12px', fontSize: 12 }} onClick={onReset}>통계 초기화</button>
      </div>
      <div className="muted" style={{ fontSize: 12, lineHeight: 1.7, marginBottom: 8 }}>
        에이전트→중앙 push의 <b>와이어 바이트</b>(압축 포함)와 페이로드 규모(vCenter·호스트·VM)·push 빈도를 집계합니다.
        트래픽은 <b>호스트 수가 아니라 VM 수·페이로드 크기 × push 빈도</b>에 비례합니다. 한 에이전트가 유독 높으면 아래에서 원인(큰 페이로드 vs 잦은 push)을 확인하세요.
      </div>
      {rows.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>아직 수신된 push가 없습니다(사이트 위임 에이전트가 push하면 집계됩니다).</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>에이전트</th><th className="right">총 수신</th><th className="right">push 수</th><th className="right">평균 크기</th>
              <th className="right">평균 간격</th><th className="right">평균 수신율</th><th>최근 페이로드</th><th className="right">최근</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const hot = avgRate > 0 && (r.bytesPerSec || 0) > avgRate * 3; // 평균의 3배↑ = 비정상 강조
                return (
                  <tr key={r.agent} style={{ background: hot ? 'rgba(245,158,11,.10)' : undefined }}>
                    <td><b>{r.agent}</b>{hot && <span style={{ color: 'var(--amber)' }} title="평균 대비 비정상적으로 높음"> ⚠</span>}</td>
                    <td className="right tabular"><b>{fmtB(r.wireBytes)}</b></td>
                    <td className="right tabular">{r.pushes}</td>
                    <td className="right tabular">{fmtB(r.avgBytes)}</td>
                    <td className="right tabular">{r.intervalSec != null ? `${r.intervalSec}s` : '—'}</td>
                    <td className="right tabular" style={{ color: hot ? 'var(--amber)' : undefined }}>{fmtRate(r.bytesPerSec)}</td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {r.last ? <>{ep(r.last.endpoint)}{r.last.vcenterId ? ` · ${r.last.vcenterId}` : ''}{r.last.vms != null ? ` · 호스트 ${r.last.hosts}·VM ${r.last.vms}` : ''}{r.last.gzip ? ' · gzip' : ' · 무압축'}</> : '—'}
                    </td>
                    <td className="right muted" style={{ fontSize: 11.5 }}>{ago(r.lastAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.7 }}>
        <b>해석</b> — <b>평균 크기</b>가 크면 그 사이트 인벤토리(특히 VM 수)가 많은 것 ·
        <b>평균 간격</b>이 짧으면(예: 수초) push 주기가 과도(<code>AGENT_INVENTORY_INTERVAL_MS</code> 확인) ·
        <b>무압축</b>이면 에이전트가 구버전(gzip 미적용 → 업그레이드 시 ~1/10). ⚠는 평균 대비 3배↑.
      </div>
    </div>
  );
}

/**
 * 수집 서버 CSV 내보내기 모달(v2.338) — 기본은 토큰 제외. '토큰 포함'은 자격증명 일괄 덤프라
 * 설정 소유자(settingsOwners)만 서버가 허용하고 감사로그가 남는다(스토리지 비밀번호 포함과 동일 규칙).
 */
function CollectorsCsvExportModal({ onClose }) {
  const [withTok, setWithTok] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const run = async () => {
    setBusy(true); setErr(null);
    try { await downloadFile(`/admin/collectors/export.csv${withTok ? '?tokens=1' : ''}`); onClose(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <EscClose onClose={onClose} />
      <div className="modal card" style={{ maxWidth: 520 }}>
        <h3 style={{ marginTop: 0 }}>수집 서버 CSV 내보내기</h3>
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
          등록된 수집 서버(id·표시명·URL·법인·vCenter 매핑·활성)를 CSV 로 내려받습니다.
          기본은 <b>토큰 제외</b>(빈 컬럼)이며, 가져오기에서 토큰을 비우면 기존 값이 유지되므로
          왕복 편집에 토큰이 필요 없습니다.
        </div>
        <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12.5, margin: '12px 0', cursor: 'pointer' }}>
          <input type="checkbox" checked={withTok} onChange={(e) => setWithTok(e.target.checked)} />
          토큰 포함 — <b style={{ color: 'var(--amber)' }}>자격증명 평문 덤프</b>(설정 소유자만 가능 · 감사로그 기록 · 파일을 자격증명과 동급으로 보관)
        </label>
        {err && <div style={{ color: 'var(--red)', fontSize: 12.5, marginBottom: 8 }}>⚠ {err}</div>}
        <div className="flex gap" style={{ justifyContent: 'flex-end' }}>
          <button className="tab" style={{ padding: '8px 16px' }} onClick={onClose}>닫기</button>
          <button className="login-btn" style={{ padding: '8px 18px' }} disabled={busy} onClick={run}>{busy ? '내려받는 중…' : '⤓ 내려받기'}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * 수집 서버 CSV 가져오기 모달(v2.338) — 2단계: ① 검증(드라이런 — 문법·필수값·URL/SSRF·파일 내
 * 중복을 실제 저장과 같은 규칙으로 판정) ② 실행. 기존 id 와 겹치는 행은 '덮어쓰기'로 표시되고,
 * 아래 체크박스로 명시 허용해야만 적용된다(미허용 시 해당 행은 건너뜀 — 사용자 요구).
 */
function CollectorsCsvImportModal({ onClose, onDone }) {
  const fileRef = useRef(null);
  const [text, setText] = useState('');
  const [check, setCheck] = useState(null);        // 드라이런 결과 { report, summary, total }
  const [checkedText, setCheckedText] = useState(null); // 검증 시점 본문(변경 감지)
  const [allowOverwrite, setAllowOverwrite] = useState(false);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { setText(String(r.result || '')); setCheck(null); setCheckedText(null); setResult(null); };
    r.readAsText(f);
  };
  const verify = async () => {
    setBusy(true); setErr(null); setResult(null); setCheck(null); setAllowOverwrite(false);
    try {
      const r = await postJson('/admin/collectors/import', { csv: text, dryRun: true });
      if (r.ok === false) setErr(r.reason);
      else { setCheck(r); setCheckedText(text); }
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const run = async () => {
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await postJson('/admin/collectors/import', { csv: text, overwrite: allowOverwrite });
      if (r.ok === false) setErr(r.reason);
      else setResult(r);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const verified = check && checkedText === text; // 검증 후 내용이 바뀌면 재검증 요구
  const actLabel = { add: '추가', overwrite: '덮어쓰기', error: '오류' };
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <EscClose onClose={() => { if (!busy) onClose(); }} />
      <div className="modal card" style={{ maxWidth: 780 }}>
        <h3 style={{ marginTop: 0 }}>수집 서버 CSV 가져오기</h3>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          헤더 행 필수(<code>id</code>·<code>url</code>은 필수, name 비우면 id 사용). <b>id</b>(대소문자 무시)가
          같은 수집 서버는 <b>덮어쓰기</b>로 판정되며 아래에서 명시적으로 허용해야 적용됩니다.
          token 열은 값이 있으면 교체, 비우면 기존 값을 유지합니다. 양식은 <b>📄 샘플 CSV</b>로 받으세요.
        </div>
        <div className="flex gap wrap" style={{ marginBottom: 8 }}>
          <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={onFile} />
          <button className="tab" style={{ padding: '6px 12px', fontSize: 12 }} onClick={() => fileRef.current?.click()}>📁 CSV 파일 선택</button>
          <button className="tab" style={{ padding: '6px 12px', fontSize: 12 }}
            onClick={() => downloadFile('/admin/collectors/sample.csv').catch((e) => setErr(e.message))}>📄 샘플 CSV</button>
        </div>
        <textarea className="input" style={{ width: '100%', minHeight: 130, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          value={text} onChange={(e) => { setText(e.target.value); setResult(null); }} placeholder="여기에 CSV 를 붙여넣거나 위에서 파일을 선택하세요." />
        {err && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 8 }}>⚠ {err}</div>}

        {/* 검증(드라이런) 결과 — 행별 추가/덮어쓰기/오류 판정 표 */}
        {check && (
          <div className="card" style={{ padding: 10, marginTop: 10, fontSize: 12.5 }}>
            <div style={{ marginBottom: 6 }}>
              검증 결과: 총 {check.total}행 — <span style={{ color: 'var(--green)' }}>추가 {check.summary.add}</span>
              {' · '}<span style={{ color: 'var(--amber)' }}>덮어쓰기 {check.summary.overwrite}</span>
              {' · '}<span style={{ color: check.summary.error ? 'var(--red)' : 'var(--text-dim)' }}>오류 {check.summary.error}</span>
              {' · '}토큰 교체 {check.summary.withToken}건
              {!verified && <b style={{ color: 'var(--amber)', marginLeft: 8 }}>⚠ 내용이 변경됨 — 재검증 필요</b>}
            </div>
            <div className="table-wrap" style={{ maxHeight: '26vh' }}>
              <table>
                <thead><tr><th style={{ textAlign: 'right' }}>행</th><th>id</th><th>URL</th><th>동작</th><th>토큰</th><th>문제</th></tr></thead>
                <tbody>
                  {check.report.map((r, i) => (
                    <tr key={i}>
                      <td style={{ textAlign: 'right' }} className="muted">{r.line}</td>
                      <td><b>{r.id}</b></td>
                      <td className="muted" style={{ fontSize: 11.5 }}>{r.url}</td>
                      <td><span className={`badge ${r.action === 'add' ? 'green' : r.action === 'overwrite' ? 'amber' : 'red'}`}>{actLabel[r.action] || r.action}</span></td>
                      <td className="muted" style={{ fontSize: 11.5 }}>{r.hasToken ? '교체' : '유지'}</td>
                      <td style={{ color: 'var(--red)', fontSize: 11.5 }}>{r.reason || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* 덮어쓰기 확인(사용자 요구) — 명시 체크 없이는 기존 항목을 건드리지 않는다. */}
            {verified && check.summary.overwrite > 0 && !result && (
              <label className="flex gap" style={{ alignItems: 'center', fontSize: 12.5, marginTop: 8, cursor: 'pointer', color: 'var(--amber)' }}>
                <input type="checkbox" checked={allowOverwrite} onChange={(e) => setAllowOverwrite(e.target.checked)} />
                기존 수집 서버 <b>{check.summary.overwrite}건 덮어쓰기 허용</b> — 체크하지 않으면 해당 행은 건너뜁니다(URL·법인·매핑이 CSV 값으로 교체됨)
              </label>
            )}
          </div>
        )}

        {result && (
          <div className="card" style={{ padding: 10, marginTop: 10, fontSize: 12.5 }}>
            <div>총 {result.total}행 — <span style={{ color: 'var(--green)' }}>추가 {result.added}</span>
              {' · '}<span style={{ color: 'var(--amber)' }}>덮어쓰기 {result.overwritten}</span>
              {result.skipped?.length ? <> · <span className="muted">건너뜀 {result.skipped.length}</span></> : ''}
              {result.failed?.length ? <> · <span style={{ color: 'var(--red)' }}>실패 {result.failed.length}</span></> : ''}</div>
            {result.skipped?.length > 0 && (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }} className="muted">
                {result.skipped.map((f, i) => <li key={i}>행 {f.line} ({f.id}): {f.reason}</li>)}
              </ul>
            )}
            {result.failed?.length > 0 && (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: 'var(--red)' }}>
                {result.failed.map((f, i) => <li key={i}>행 {f.line} ({f.id}): {f.reason}</li>)}
              </ul>
            )}
          </div>
        )}
        <div className="flex gap" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          {result
            ? <button className="login-btn" style={{ padding: '8px 18px' }} onClick={onDone}>완료(목록 새로고침)</button>
            : <>
              <button className="tab" style={{ padding: '8px 16px' }} disabled={busy || !text.trim()} onClick={verify}>{busy ? '검사 중…' : '1) 검증(드라이런)'}</button>
              <button className="login-btn" style={{ padding: '8px 18px' }} disabled={busy || !verified}
                title={verified ? (check.summary.error ? '오류 행은 건너뛰고 정상 행만 처리됩니다' : '') : '먼저 검증을 통과하세요'}
                onClick={run}>{busy ? '가져오는 중…' : '2) 가져오기 실행'}</button>
            </>}
        </div>
      </div>
    </div>
  );
}
