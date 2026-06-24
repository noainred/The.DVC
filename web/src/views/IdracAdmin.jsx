import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import EscClose from '../components/EscClose.jsx';

const EMPTY = { id: '', name: '', host: '', username: 'root', password: '', serviceTag: '', vcenterId: '', hostNames: '', enabled: true, type: 'idrac' };

export default function IdracAdmin() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [importMsg, setImportMsg] = useState(null);
  const [replaceMode, setReplaceMode] = useState(false);
  const [csvText, setCsvText] = useState(null);   // null = closed
  const [bulk, setBulk] = useState(null);          // null = closed
  const [bulkPreview, setBulkPreview] = useState(null);
  const [scanResult, setScanResult] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [scanAgent, setScanAgent] = useState('__local__'); // 스캔 수행 주체(로컬 또는 에이전트 이름)
  const [agents, setAgents] = useState({ agents: [], centralEnabled: false });
  const [scanProgress, setScanProgress] = useState(null); // 위임 스캔 진행 안내문
  const [scanPct, setScanPct] = useState(null); // { scanned, total } 진행률 바
  const [vcenters, setVcenters] = useState([]);           // vCenter 목록(소속 지정용)
  const [assignVc, setAssignVc] = useState('');           // 일괄 지정 대상 vCenter
  const fileRef = useRef(null);

  const load = async () => {
    try { setData(await fetchJson('/admin/idrac')); setError(null); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => {
    load();
    fetchJson('/admin/idrac/scan-agents').then(setAgents).catch(() => {});
    fetchJson('/admin/vcenters').then((d) => setVcenters(d.vcenters || d || [])).catch(() => fetchJson('/vcenters').then((d) => setVcenters(d || [])).catch(() => {}));
    const t = setInterval(load, 30_000); // refresh current power/poller status
    return () => clearInterval(t);
  }, []);

  const assignAllVcenter = async () => {
    setBusy(true); setImportMsg(null);
    try {
      const r = await postJson('/admin/idrac/assign-vcenter', { all: true, vcenterId: assignVc });
      setImportMsg(r.ok ? { ok: true, text: `${r.updated}대의 소속 vCenter를 ${assignVc ? `'${assignVc}'(으)로 지정` : '해제'}했습니다. (총 ${r.total})` } : { ok: false, text: r.reason });
      if (r.ok) await load();
    } catch (e) { setImportMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const openAdd = () => { setEditing(false); setForm({ ...EMPTY }); setMsg(null); };
  const openEdit = (s) => {
    setEditing(true);
    setForm({ ...EMPTY, ...s, password: '', hostNames: (s.hostNames || []).join(', ') });
    setMsg(null);
  };
  const close = () => { setForm(null); setMsg(null); };
  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const payload = { ...form, hostNames: form.hostNames };
      const r = editing ? await putJson(`/admin/idrac/${encodeURIComponent(form.id)}`, payload) : await postJson('/admin/idrac', payload);
      if (r.ok) { await load(); close(); }
      else setMsg({ ok: false, text: r.reason });
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  const test = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/admin/idrac/test', form);
      const inv = r.info?.system, fw = r.info?.idrac;
      const extra = inv ? `${inv.hostName ? ` · 호스트 ${inv.hostName}` : ''}${inv.biosVersion ? ` · BIOS ${inv.biosVersion}` : ''}${fw?.firmwareVersion ? ` · iDRAC ${fw.firmwareVersion}` : ''}${fw?.ipmiVersion ? ` · IPMI ${fw.ipmiVersion}` : ''}` : '';
      setMsg(r.ok
        ? { ok: true, text: r.type === 'ome'
            ? `OME 연결 성공 (${r.ms}ms · ${r.auth}) · 장비 ${r.devices}대${r.watts != null ? ` · 샘플 ${r.watts} W` : ' · 전력값 없음(플러그인 확인)'}`
            : `연결 성공 (${r.ms}ms) · 현재 ${r.watts != null ? `${r.watts} W` : '—'}${r.model ? ` · ${r.model}` : ''}${r.serviceTag ? ` · ${r.serviceTag}` : ''}${extra}` }
        : { ok: false, text: `연결 실패: ${r.reason}${r.hint ? ` (${r.hint})` : ''}` });
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  const remove = async (s) => {
    if (!window.confirm(`'${s.name}' (${s.id}) 을(를) 삭제할까요?`)) return;
    try { await delJson(`/admin/idrac/${encodeURIComponent(s.id)}`); await load(); }
    catch (e) { setError(e.message); }
  };

  const pollNow = async () => {
    setBusy(true);
    try { await postJson('/admin/idrac/poll', {}); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const onImportFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImportMsg(null);
    try {
      const text = await file.text();
      let body;
      if (file.name.endsWith('.csv')) body = { csv: text, mode: replaceMode ? 'replace' : 'merge' };
      else {
        const json = JSON.parse(text);
        const servers = Array.isArray(json) ? json : json.servers;
        if (!Array.isArray(servers)) throw new Error('servers 배열이 없습니다.');
        body = { servers, mode: replaceMode ? 'replace' : 'merge' };
      }
      const r = await postJson('/admin/idrac/import', body);
      setImportMsg(r.ok
        ? { ok: true, text: `불러오기 완료 — 추가 ${r.added}, 갱신 ${r.updated}, 건너뜀 ${r.skipped.length} (총 ${r.total})`, skipped: r.skipped }
        : { ok: false, text: r.reason });
      await load();
    } catch (err) { setImportMsg({ ok: false, text: `불러오기 실패: ${err.message}` }); }
  };

  const submitCsv = async () => {
    setBusy(true); setImportMsg(null);
    try {
      const r = await postJson('/admin/idrac/import', { csv: csvText || '', mode: replaceMode ? 'replace' : 'merge' });
      setImportMsg(r.ok
        ? { ok: true, text: `불러오기 완료 — 추가 ${r.added}, 갱신 ${r.updated}, 건너뜀 ${r.skipped.length} (총 ${r.total})`, skipped: r.skipped }
        : { ok: false, text: r.reason });
      if (r.ok) { await load(); setCsvText(null); }
    } catch (e) { setImportMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  const previewBulk = async (ipsText) => {
    try {
      const r = await postJson('/admin/idrac/expand-ips', { ips: ipsText });
      setBulkPreview(r);
    } catch (e) { setBulkPreview({ count: 0, errors: [e.message], sample: [] }); }
  };

  const scanIdracs = async () => {
    setBusy(true); setScanResult(null); setImportMsg(null); setScanProgress(null); setScanPct(null);
    try {
      const r = await postJson('/admin/idrac/scan', { ips: bulk.ips, username: bulk.username, password: bulk.password, agent: scanAgent, vcenterId: bulk.vcenterId || '' });
      if (!r.ok) { setImportMsg({ ok: false, text: r.reason }); return; }
      if (!r.delegated) {
        setScanResult({ ...r, delegated: false });
        setSelected(new Set(r.found.map((f) => f.ip)));
        return;
      }
      // 위임 스캔: reqId로 결과를 폴링(에이전트가 현지 스캔→현지 등록 후 회신).
      setScanProgress(`에이전트 '${r.agent}'에 스캔 요청을 전달했습니다. 현지 스캔 결과를 기다리는 중…`);
      const reqId = r.reqId;
      const deadline = Date.now() + 180_000; // 최대 3분 대기
      // eslint-disable-next-line no-await-in-loop
      while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 2500));
        // eslint-disable-next-line no-await-in-loop
        const s = await fetchJson(`/admin/idrac/scan-result?reqId=${encodeURIComponent(reqId)}`).catch(() => null);
        if (!s) continue;
        if (s.state === 'done' || s.state === 'error') {
          setScanProgress(null); setScanPct(null);
          if (s.state === 'error') { setImportMsg({ ok: false, text: `에이전트 스캔 오류: ${s.error || '알 수 없음'}` }); return; }
          setScanResult({ ...s, delegated: true });
          setSelected(new Set()); // 위임 스캔은 현지 자동등록되므로 중앙 재등록 불필요
          await load();
          return;
        }
        if (s.state === 'unknown') { setImportMsg({ ok: false, text: '스캔 잡을 찾을 수 없습니다(만료되었거나 에이전트 미응답).' }); return; }
        if (s.progress && s.progress.total > 0) setScanPct({ scanned: s.progress.scanned || 0, total: s.progress.total });
        setScanProgress(s.state === 'running'
          ? `에이전트 '${r.agent}'가 스캔 중입니다…`
          : `에이전트 '${r.agent}'가 잡을 인출하기를 기다리는 중… (에이전트가 실행/연결되어 있는지 확인)`);
      }
      setScanProgress(null);
      setImportMsg({ ok: false, text: '에이전트 스캔이 3분 내 완료되지 않았습니다. 에이전트 상태를 확인하세요(대역이 크면 더 걸릴 수 있음).' });
    } catch (e) { setScanProgress(null); setScanPct(null); setImportMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  const toggleSel = (ip) => setSelected((s) => { const n = new Set(s); n.has(ip) ? n.delete(ip) : n.add(ip); return n; });

  const registerScanned = async () => {
    const found = (scanResult?.found || []).filter((f) => selected.has(f.ip));
    if (!found.length) return;
    setBusy(true); setImportMsg(null);
    try {
      const r = await postJson('/admin/idrac/register-scanned', { found, username: bulk.username, password: bulk.password, mode: replaceMode ? 'replace' : 'merge', vcenterId: bulk.vcenterId || '' });
      setImportMsg(r.ok
        ? { ok: true, text: `iDRAC ${found.length}대 등록 — 추가 ${r.added}, 갱신 ${r.updated} (총 ${r.total})`, skipped: r.skipped }
        : { ok: false, text: r.reason });
      if (r.ok) { await load(); setBulk(null); setBulkPreview(null); setScanResult(null); }
    } catch (e) { setImportMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  const submitBulk = async () => {
    setBusy(true); setImportMsg(null);
    try {
      const r = await postJson('/admin/idrac/bulk-add', { ...bulk, mode: replaceMode ? 'replace' : 'merge' });
      if (r.ok) {
        setImportMsg({ ok: true, skipped: r.skipped,
          text: `IP ${r.expanded}개 → 추가 ${r.added}, 갱신 ${r.updated} (총 ${r.total})${r.truncated ? ' · 상한 4096 적용됨' : ''}${r.ipErrors?.length ? ` · 무시된 항목 ${r.ipErrors.length}` : ''}` });
        await load(); setBulk(null); setBulkPreview(null);
      } else setImportMsg({ ok: false, text: r.reason + (r.ipErrors?.length ? ` (${r.ipErrors.slice(0, 3).join('; ')})` : '') });
    } catch (e) { setImportMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  const list = data.servers || [];
  const poller = data.poller || {};
  const lastResults = poller.lastRun?.results || [];
  const wattsById = Object.fromEntries(lastResults.map((r) => [r.id, r]));
  const fmtW = (w) => (w != null ? `${(w / 1000).toFixed(2)} kW (${w} W)` : '—');

  return (
    <>
      <div className="flex between wrap gap" style={{ marginBottom: 6 }}>
        <div className="section-title" style={{ margin: '6px 0' }}>전력 수집 — Dell iDRAC (관리자)</div>
        <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12 }} title="체크 시 기존 목록을 모두 교체">
            <input type="checkbox" checked={replaceMode} onChange={(e) => setReplaceMode(e.target.checked)} /> 전체 교체
          </label>
          <span className="muted" style={{ fontSize: 12, borderLeft: '1px solid rgba(148,163,184,.25)', paddingLeft: 10 }} title="목록의 모든 iDRAC 서버 소속 vCenter를 한 번에 지정합니다(ESXi 호스트가 아니어도 전력이 그 vCenter로 귀속).">전체 소속 vCenter:</span>
          <select className="input" style={{ padding: '7px 10px', maxWidth: 200 }} value={assignVc} onChange={(e) => setAssignVc(e.target.value)}>
            <option value="">(지정 해제)</option>
            {vcenters.map((v) => <option key={v.id} value={v.id}>{v.name || v.id}</option>)}
          </select>
          <button className="logout-btn" style={{ padding: '9px 14px' }} disabled={busy} onClick={assignAllVcenter} title="목록 전체에 적용">전체 적용</button>
          <input ref={fileRef} type="file" accept=".json,.csv,application/json,text/csv" style={{ display: 'none' }} onChange={onImportFile} />
          <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={() => fileRef.current?.click()}>파일 업로드(JSON/CSV)</button>
          <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={() => { setCsvText(''); }}>CSV 붙여넣기</button>
          <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={() => { setBulk({ ips: '', username: 'root', password: '', namePrefix: '' }); setBulkPreview(null); setScanResult(null); }}>IP 일괄 등록</button>
          <button className="logout-btn" style={{ padding: '9px 14px' }} disabled={busy} onClick={pollNow}>지금 수집</button>
          <button className="login-btn" style={{ flex: 'none', padding: '9px 16px' }} onClick={openAdd}>+ 서버 추가</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12, padding: '10px 14px' }}>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.7 }}>
          Dell 서버의 iDRAC(Redfish)에 접속해 <b>실시간 소비전력(W)</b>을 {Math.round((poller.intervalMs || 60000) / 1000)}초마다 수집해 DB에 저장합니다.
          <b>호스트 이름</b>(ESXi 호스트명)을 입력하면 호스트 클릭 시 해당 서버 전력이 표시됩니다.
          {poller.lastRun && <> · 최근 수집: {new Date(poller.lastRun.at).toLocaleString('ko-KR')} (성공 {poller.lastRun.ok}/{poller.lastRun.ok + poller.lastRun.failed})</>}
        </div>
      </div>

      {importMsg && (
        <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13,
          background: importMsg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
          color: importMsg.ok ? '#4ade80' : '#f87171' }}>
          {importMsg.text}
          {importMsg.skipped?.length > 0 && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: 'var(--amber)' }}>
              {importMsg.skipped.slice(0, 8).map((s, i) => <li key={i}>{s.id}: {s.reason}</li>)}
            </ul>
          )}
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead><tr>
            <th>ID</th><th>유형</th><th>이름</th><th>주소</th><th>계정</th><th>매핑/장비</th><th>현재 전력</th><th>상태</th><th className="right">작업</th>
          </tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={9} className="center muted" style={{ padding: 28 }}>등록된 서버가 없습니다. “+ 서버 추가”로 등록하세요.</td></tr>}
            {list.map((s) => {
              const r = wattsById[s.id];
              const isOme = s.type === 'ome';
              return (
                <tr key={s.id}>
                  <td><b>{s.id}</b></td>
                  <td>{isOme ? <span className="badge blue">OME</span> : <span className="badge gray">iDRAC</span>}</td>
                  <td>{s.name}</td>
                  <td className="muted">{s.host?.replace(/^https?:\/\//, '')}</td>
                  <td className="muted">{s.username}</td>
                  <td className="muted">
                    {s.vcenterId && <div><span className="badge teal" title="소속 vCenter로 명시 지정됨">vC: {s.vcenterId}</span></div>}
                    {isOme ? (r?.devices != null ? `장비 ${r.devices}대${r.measured != null ? ` · 측정 ${r.measured}` : ''}` : <span className="badge gray">자동 발견</span>) : ((s.hostNames || []).join(', ') || (!s.vcenterId && <span className="badge gray">미지정</span>))}
                  </td>
                  <td className="tabular">{isOme ? (r?.error ? <span className="badge red" title={r.error}>오류</span> : (r?.metric ? <span className="muted">{r.metric === 'powermanager' ? 'Power Mgr' : '인벤토리'}</span> : '—')) : (r?.watts != null ? fmtW(r.watts) : (r?.error ? <span className="badge red" title={r.error}>오류</span> : '—'))}</td>
                  <td>{s.enabled === false ? <span className="badge gray">중지</span> : <span className="badge green">수집</span>}</td>
                  <td className="right nowrap">
                    <button className="tab" onClick={() => openEdit(s)}>수정</button>
                    <button className="tab" style={{ color: 'var(--red)' }} onClick={() => remove(s)}>삭제</button>
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
              <b style={{ fontSize: 15 }}>{editing ? `서버 수정 — ${form.id}` : '새 Dell 서버 등록'}</b>
              <button className="logout-btn" onClick={close}>닫기</button>
            </div>
            <div className="spec-grid">
              <label>소스 유형
                <select className="select" value={form.type || 'idrac'} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))} disabled={editing}>
                  <option value="idrac">iDRAC 직접 (서버 1대)</option>
                  <option value="ome">OME (전체 자동 발견)</option>
                </select>
              </label>
              <label>ID *<input className="input" value={form.id} onChange={setF('id')} disabled={editing} placeholder={form.type === 'ome' ? 'ome-hq' : 'srv-seoul-01'} /></label>
              <label>{form.type === 'ome' ? 'OME 이름 *' : '서버 이름 *'}<input className="input" value={form.name} onChange={setF('name')} placeholder={form.type === 'ome' ? 'OME-HQ' : 'ESXi-SEOUL-01'} /></label>
              <label style={{ gridColumn: '1 / -1' }}>{form.type === 'ome' ? 'OME 주소 *' : 'iDRAC 주소 *'}<input className="input" value={form.host} onChange={setF('host')} placeholder={form.type === 'ome' ? 'https://ome.corp.local  또는  10.0.0.10' : '10.0.0.21  또는  https://idrac-seoul-01.corp.local'} /></label>
              <label>계정 *<input className="input" value={form.username} onChange={setF('username')} placeholder={form.type === 'ome' ? 'admin' : 'root'} /></label>
              <label>비밀번호 {editing && <span className="muted">(비우면 유지)</span>}<input className="input" type="password" value={form.password} onChange={setF('password')} placeholder={editing ? '••••••' : ''} /></label>
              <label>수집 여부
                <select className="select" value={form.enabled ? '1' : '0'} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.value === '1' }))}>
                  <option value="1">수집</option>
                  <option value="0">중지</option>
                </select>
              </label>
              {form.type !== 'ome' && (
                <>
                  <label>서비스 태그<input className="input" value={form.serviceTag} onChange={setF('serviceTag')} placeholder="(선택) 자동 조회됨" /></label>
                  <label>소속 vCenter
                    <select className="input" value={form.vcenterId || ''} onChange={setF('vcenterId')}
                      title="지정 시 이 서버 전력을 해당 vCenter로 귀속(이름·태그 매칭보다 우선). ESXi 호스트가 아니어도 됩니다.">
                      <option value="">(자동: 이름·태그 매칭)</option>
                      {vcenters.map((v) => <option key={v.id} value={v.id}>{v.name || v.id}</option>)}
                    </select>
                  </label>
                  <label style={{ gridColumn: '1 / -1' }}>매핑 ESXi 호스트 이름 (쉼표로 여러 개)
                    <input className="input" value={form.hostNames} onChange={setF('hostNames')} placeholder="esxi-seoul-01.corp.local, 10.0.0.21" />
                  </label>
                </>
              )}
              {form.type === 'ome' && (
                <div className="muted" style={{ gridColumn: '1 / -1', fontSize: 12 }}>
                  OME에 등록된 <b>모든 서버를 자동 발견</b>하여 전력을 수집합니다. ESXi 호스트는 서비스태그/장비명으로 자동 매칭됩니다.
                </div>
              )}
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
              <button className="logout-btn" style={{ padding: '10px 18px' }} disabled={busy} onClick={test}>연결/전력 테스트</button>
            </div>
            <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
              매핑 호스트 이름은 대시보드의 ESXi 호스트 이름과 일치해야 합니다(대소문자 무시). 자격증명은 서버
              <code> $CONFIG_DIR/idrac.json</code>(0600)에만 저장됩니다.
            </div>
          </div>
        </div>
      )}

      {csvText != null && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setCsvText(null); }}>
          <EscClose onClose={() => setCsvText(null)} />
          <div className="modal card" style={{ maxWidth: 720 }}>
            <div className="flex between" style={{ marginBottom: 10 }}>
              <b style={{ fontSize: 15 }}>CSV 붙여넣기로 서버 등록</b>
              <button className="logout-btn" onClick={() => setCsvText(null)}>닫기</button>
            </div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 8, lineHeight: 1.7 }}>
              첫 줄은 헤더입니다. 컬럼: <code>name,host,username,password,serviceTag,hostNames</code>
              (hostNames 는 <code>;</code> 로 여러 개). 쉼표(,)로 구분합니다.
            </div>
            <textarea className="input" style={{ width: '100%', minHeight: 220, fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
              value={csvText} onChange={(e) => setCsvText(e.target.value)}
              placeholder={'name,host,username,password,serviceTag,hostNames\nESXi-SEOUL-01,10.0.0.21,root,P@ss,,esxi-seoul-01.corp.local\nESXi-SEOUL-02,10.0.0.22,root,P@ss,,esxi-seoul-02.corp.local'} />
            <div className="flex gap" style={{ marginTop: 12, alignItems: 'center' }}>
              <button className="login-btn" style={{ flex: 'none', padding: '10px 18px' }} disabled={busy || !csvText.trim()} onClick={submitCsv}>
                {busy ? '등록 중…' : '등록'}
              </button>
              <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12 }}>
                <input type="checkbox" checked={replaceMode} onChange={(e) => setReplaceMode(e.target.checked)} /> 전체 교체
              </label>
            </div>
          </div>
        </div>
      )}

      {bulk != null && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) { setBulk(null); setBulkPreview(null); } }}>
          <EscClose onClose={() => { setBulk(null); setBulkPreview(null); }} />
          <div className="modal card" style={{ maxWidth: 720 }}>
            <div className="flex between" style={{ marginBottom: 10 }}>
              <b style={{ fontSize: 15 }}>IP 일괄 등록 (동일 계정/비밀번호)</b>
              <button className="logout-btn" onClick={() => { setBulk(null); setBulkPreview(null); }}>닫기</button>
            </div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 8, lineHeight: 1.7 }}>
              IP를 한 줄에 하나씩. 범위 <code>10.0.0.1 - 10.0.0.20</code>, CIDR <code>10.0.0.0/24</code>,
              짧은 범위 <code>10.0.0.1-20</code> 모두 가능합니다. (<code>#</code> 뒤는 주석, 최대 4096개)
            </div>
            <textarea className="input" style={{ width: '100%', minHeight: 180, fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
              value={bulk.ips}
              onChange={(e) => { const v = e.target.value; setBulk((b) => ({ ...b, ips: v })); }}
              onBlur={() => bulk.ips.trim() && previewBulk(bulk.ips)}
              placeholder={'10.0.0.21\n10.0.0.30 - 10.0.0.45\n10.0.1.0/24\n# 주석'} />
            <div className="spec-grid" style={{ marginTop: 10 }}>
              <label>iDRAC 계정 *<input className="input" value={bulk.username} onChange={(e) => setBulk((b) => ({ ...b, username: e.target.value }))} placeholder="root" /></label>
              <label>iDRAC 비밀번호 *<input className="input" type="password" value={bulk.password} onChange={(e) => setBulk((b) => ({ ...b, password: e.target.value }))} /></label>
              <label>이름 접두어<input className="input" value={bulk.namePrefix} onChange={(e) => setBulk((b) => ({ ...b, namePrefix: e.target.value }))} placeholder="(선택) 예: SEOUL-" /></label>
              <label>스캔 수행 Agent
                <select className="input" value={scanAgent} onChange={(e) => setScanAgent(e.target.value)}
                  title="원격 사이트 iDRAC는 중앙에서 직접 못 닿으므로, 그 사이트의 현장 에이전트가 스캔을 대행합니다.">
                  <option value="__local__">이 포탈에서 직접</option>
                  {(agents.agents || []).map((a) => <option key={a} value={a}>에이전트: {a}</option>)}
                </select>
              </label>
              <label>소속 vCenter
                <select className="input" value={bulk.vcenterId || ''} onChange={(e) => setBulk((b) => ({ ...b, vcenterId: e.target.value }))}
                  title="이 배치의 서버 전력을 지정한 vCenter로 귀속합니다(ESXi 호스트가 아니어도 됨). 비우면 호스트명·서비스태그 매칭을 따릅니다.">
                  <option value="">(자동: 이름·태그 매칭)</option>
                  {vcenters.map((v) => <option key={v.id} value={v.id}>{v.name || v.id}</option>)}
                </select>
              </label>
            </div>
            {scanAgent !== '__local__' && (
              <div className="muted" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.6 }}>
                위임 스캔: 에이전트 <b>{scanAgent}</b>가 현지에서 Redfish 스캔 후 <b>현지에 자동 등록</b>해 전력 수집을 시작합니다.
                발견 목록은 아래에 표시되며, 전력은 중앙이 수집서버(collector)에서 취합합니다(중앙 재등록 불필요).
              </div>
            )}
            {!agents.centralEnabled && (
              <div className="muted" style={{ fontSize: 11, marginTop: 4, color: 'var(--amber)' }}>
                ※ 이 포탈은 중앙(CENTRAL_TOKEN)이 설정되지 않아 에이전트 위임 스캔을 받을 수 없습니다. 로컬 스캔만 가능합니다.
              </div>
            )}
            <div className="flex gap" style={{ marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="login-btn" style={{ flex: 'none', padding: '10px 18px' }}
                disabled={busy || !bulk.ips.trim() || !bulk.username.trim() || !bulk.password} onClick={scanIdracs}>
                {busy ? '스캔 중…' : '🔍 스캔하여 iDRAC만 찾기'}
              </button>
              <button className="logout-btn" style={{ padding: '10px 16px' }} disabled={!bulk.ips.trim()} onClick={() => previewBulk(bulk.ips)}>IP 미리보기</button>
              <button className="logout-btn" style={{ padding: '10px 16px' }}
                disabled={busy || !bulk.ips.trim() || !bulk.username.trim() || !bulk.password} onClick={submitBulk} title="스캔 없이 입력한 모든 IP를 그대로 등록">
                스캔없이 전체 등록
              </button>
              <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12 }}>
                <input type="checkbox" checked={replaceMode} onChange={(e) => setReplaceMode(e.target.checked)} /> 전체 교체
              </label>
              {bulkPreview && (
                <span className="muted" style={{ fontSize: 12 }}>
                  → <b style={{ color: 'var(--text)' }}>{bulkPreview.count}</b>개 IP
                  {bulkPreview.truncated && ' (상한 4096)'}
                  {bulkPreview.errors?.length > 0 && <span style={{ color: 'var(--amber)' }}> · 무시 {bulkPreview.errors.length}</span>}
                </span>
              )}
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              “스캔”은 각 IP의 Redfish에 접속해 <b>Dell iDRAC만</b> 골라냅니다(미응답/타 장비/인증실패 제외). 대역이 크면 다소 걸립니다.
            </div>

            {scanProgress && (
              <div className="card" style={{ marginTop: 12, padding: '10px 14px', borderLeft: '3px solid var(--accent-2)', fontSize: 13 }}>
                ⏳ {scanProgress}
                {scanPct && scanPct.total > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div className="flex between" style={{ fontSize: 12, marginBottom: 4 }}>
                      <span className="muted">{scanPct.scanned.toLocaleString()} / {scanPct.total.toLocaleString()} IP</span>
                      <b>{Math.min(100, Math.round((scanPct.scanned / scanPct.total) * 100))}%</b>
                    </div>
                    <div style={{ height: 8, borderRadius: 6, background: 'rgba(36,48,73,.8)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${Math.min(100, Math.round((scanPct.scanned / scanPct.total) * 100))}%`, background: 'var(--accent)', transition: 'width .4s ease', borderRadius: 6 }} />
                    </div>
                  </div>
                )}
              </div>
            )}

            {scanResult && (
              <div style={{ marginTop: 12, borderTop: '1px solid rgba(36,48,73,.6)', paddingTop: 10 }}>
                <div className="flex between wrap" style={{ marginBottom: 8 }}>
                  <b style={{ fontSize: 13 }}>
                    {scanResult.delegated && <span className="badge teal" style={{ marginRight: 6 }}>에이전트 {scanResult.agent}</span>}
                    스캔 {scanResult.scanned}개 → iDRAC <span style={{ color: 'var(--green)' }}>{scanResult.foundCount}</span>대 발견
                    {scanResult.delegated && scanResult.registered != null && <span className="muted" style={{ fontWeight: 400 }}> · 현지 등록 {scanResult.registered}대</span>}
                  </b>
                  <span className="muted" style={{ fontSize: 12 }}>
                    미응답 {scanResult.unreachable} · 타장비 {scanResult.notIdrac} · 인증실패 {scanResult.authFailed}{scanResult.truncated ? ' · 상한 적용' : ''}
                  </span>
                </div>
                {scanResult.found.length === 0 ? (
                  <div className="muted" style={{ fontSize: 12, padding: 8 }}>발견된 iDRAC가 없습니다. 계정/비번 또는 대역을 확인하세요.</div>
                ) : (
                  <>
                    <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid rgba(36,48,73,.5)', borderRadius: 8 }}>
                      <table>
                        <thead><tr>
                          {!scanResult.delegated && <th style={{ width: 32 }}><input type="checkbox" checked={selected.size === scanResult.found.length}
                            onChange={(e) => setSelected(e.target.checked ? new Set(scanResult.found.map((f) => f.ip)) : new Set())} /></th>}
                          <th>IP</th><th>서비스태그</th><th>호스트명</th><th>모델</th>
                        </tr></thead>
                        <tbody>
                          {scanResult.found.map((f) => (
                            <tr key={f.ip} style={{ cursor: scanResult.delegated ? 'default' : 'pointer' }} onClick={() => !scanResult.delegated && toggleSel(f.ip)}>
                              {!scanResult.delegated && <td><input type="checkbox" checked={selected.has(f.ip)} onChange={() => toggleSel(f.ip)} onClick={(e) => e.stopPropagation()} /></td>}
                              <td><b>{f.ip}</b></td>
                              <td className="muted">{f.serviceTag || '—'}</td>
                              <td className="muted">{f.hostName || '—'}</td>
                              <td className="muted">{[f.manufacturer, f.model].filter(Boolean).join(' ') || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {scanResult.delegated ? (
                      <div className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.6 }}>
                        ✅ 위 iDRAC는 에이전트 <b>{scanResult.agent}</b>의 현지 레지스트리에 등록되어 전력 수집이 시작되었습니다.
                        중앙에서는 별도 등록 없이 수집서버(collector) 취합으로 전력이 반영됩니다.
                      </div>
                    ) : (
                      <div className="flex gap" style={{ marginTop: 10, alignItems: 'center' }}>
                        <button className="login-btn" style={{ flex: 'none', padding: '10px 18px' }} disabled={busy || selected.size === 0} onClick={registerScanned}>
                          {busy ? '등록 중…' : `선택한 iDRAC ${selected.size}대 등록`}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
