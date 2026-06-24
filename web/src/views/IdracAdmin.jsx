import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import EscClose from '../components/EscClose.jsx';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';

const EMPTY = { id: '', name: '', host: '', username: 'root', password: '', serviceTag: '', vcenterId: '', hostNames: '', enabled: true, type: 'idrac' };

export default function IdracAdmin() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [editing, setEditing] = useState(false);
  const [detail, setDetail] = useState(null); // { id, name } → 상세/센서 모달
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
                    {!isOme && <button className="tab" onClick={() => setDetail({ id: s.id, name: s.name })} title="iDRAC/BIOS/드라이버 버전 · 온도센서·CPU 사용량 차트">상세</button>}
                    <button className="tab" onClick={() => openEdit(s)}>수정</button>
                    <button className="tab" style={{ color: 'var(--red)' }} onClick={() => remove(s)}>삭제</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {detail && <IdracDetailModal server={detail} onClose={() => setDetail(null)} />}

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

const LINE_COLORS = ['#60a5fa', '#f87171', '#34d399', '#fbbf24', '#a78bfa', '#f472b6', '#22d3ee', '#fb923c', '#4ade80', '#e879f9', '#94a3b8', '#fca5a5'];
const FW_TYPE_ORDER = ['iDRAC', 'BIOS', 'NIC', 'Storage', 'GPU', 'PSU', 'Disk', 'CPLD', 'Driver', '기타'];

/** iDRAC 서버 상세 — 버전(iDRAC/BIOS/드라이버) + 온도센서·CPU 사용량 1분 시계열 차트. */
export function IdracDetailModal({ server, onClose }) {
  const [inv, setInv] = useState(null);
  const [invErr, setInvErr] = useState(null);
  const [sensors, setSensors] = useState(null);
  const [tab, setTab] = useState('charts'); // charts | versions | gpu
  const [gpuProbe, setGpuProbe] = useState(null); // null | 'loading' | result
  const runGpuProbe = () => { setGpuProbe('loading'); fetchJson(`/admin/idrac/${encodeURIComponent(server.id)}/gpu-probe`).then(setGpuProbe).catch((e) => setGpuProbe({ ok: false, reason: e.message })); };
  const loadInv = (refresh) => fetchJson(`/admin/idrac/${encodeURIComponent(server.id)}/inventory${refresh ? '?refresh=1' : ''}`)
    .then((r) => { setInv(r.inventory); setInvErr(null); }).catch((e) => setInvErr(e.message));
  const loadSensors = () => fetchJson(`/admin/idrac/${encodeURIComponent(server.id)}/sensors?minutes=180`).then(setSensors).catch(() => {});
  useEffect(() => { loadInv(false); loadSensors(); const t = setInterval(loadSensors, 30_000); return () => clearInterval(t); /* eslint-disable-next-line */ }, [server.id]);

  const sensorNames = (sensors?.sensors || []).slice(0, 12);
  const fanNames = (sensors?.fanNames || []).slice(0, 12);
  const chartData = (sensors?.samples || []).map((s) => {
    const row = { t: new Date(s.t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }), cpu: s.cpu };
    for (const n of sensorNames) row[n] = s.temps?.[n] ?? null;
    for (const n of fanNames) row[`fan:${n}`] = s.fans?.[n] ?? null;
    return row;
  });
  const latest = sensors?.latest;
  const fwByType = {};
  for (const f of (inv?.firmware || [])) (fwByType[f.type] = fwByType[f.type] || []).push(f);
  const orderedTypes = Object.keys(fwByType).sort((a, b) => (FW_TYPE_ORDER.indexOf(a) + 1 || 99) - (FW_TYPE_ORDER.indexOf(b) + 1 || 99));

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <EscClose onClose={onClose} />
      <div className="modal card" style={{ maxWidth: 980, width: '94vw' }}>
        <div className="flex between" style={{ marginBottom: 10 }}>
          <b style={{ fontSize: 15 }}>🖥 {server.name} — iDRAC 상세 / 센서</b>
          <button className="logout-btn" onClick={onClose}>닫기</button>
        </div>
        <div className="flex gap" style={{ marginBottom: 12 }}>
          <button className={tab === 'charts' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '6px 14px' }} onClick={() => setTab('charts')}>📈 센서 차트(온도·CPU)</button>
          <button className={tab === 'versions' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '6px 14px' }} onClick={() => setTab('versions')}>🏷 하드웨어 / 버전</button>
          <button className={tab === 'gpu' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '6px 14px' }} onClick={() => { setTab('gpu'); if (!gpuProbe) runGpuProbe(); }}>🎮 GPU 수집 확인</button>
          {tab === 'versions' && <button className="tab" style={{ flex: 'none', padding: '6px 12px' }} onClick={() => { setInv(null); loadInv(true); }}>↻ 즉시 재수집</button>}
        </div>

        {tab === 'charts' && (
          <div>
            <div className="flex gap wrap" style={{ marginBottom: 10 }}>
              <span className="badge blue">CPU 사용량 {latest?.cpu != null ? `${latest.cpu}%` : '— (텔레메트리 미지원)'}</span>
              <span className="badge amber">최고 온도 {latest ? `${Math.max(...Object.values(latest.temps || { _: 0 }))}℃` : '—'}</span>
              <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>1분 간격 · 최근 {sensors?.count || 0}샘플 · 30초마다 갱신</span>
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, margin: '6px 0' }}>CPU 사용량 (%)</div>
            <div style={{ width: '100%', height: 180 }}>
              <ResponsiveContainer>
                <LineChart data={chartData} margin={{ top: 4, right: 12, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,.15)" />
                  <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#94a3b8' }} minTickGap={40} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#94a3b8' }} width={36} />
                  <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 12 }} />
                  <Line type="monotone" dataKey="cpu" name="CPU %" stroke="#60a5fa" dot={false} strokeWidth={2} isAnimationActive={false} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, margin: '12px 0 6px' }}>온도 센서 (℃) — {sensorNames.length}개</div>
            <div style={{ width: '100%', height: 240 }}>
              <ResponsiveContainer>
                <LineChart data={chartData} margin={{ top: 4, right: 12, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,.15)" />
                  <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#94a3b8' }} minTickGap={40} />
                  <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} width={36} unit="℃" />
                  <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {sensorNames.map((n, i) => (
                    <Line key={n} type="monotone" dataKey={n} stroke={LINE_COLORS[i % LINE_COLORS.length]} dot={false} strokeWidth={1.6} isAnimationActive={false} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
            {fanNames.length > 0 && (
              <>
                <div style={{ fontSize: 13, fontWeight: 700, margin: '12px 0 6px' }}>팬 속도 (RPM) — {fanNames.length}개</div>
                <div style={{ width: '100%', height: 200 }}>
                  <ResponsiveContainer>
                    <LineChart data={chartData} margin={{ top: 4, right: 12, left: -4, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,.15)" />
                      <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#94a3b8' }} minTickGap={40} />
                      <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} width={46} />
                      <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 12 }} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      {fanNames.map((n, i) => (
                        <Line key={n} type="monotone" dataKey={`fan:${n}`} name={n} stroke={LINE_COLORS[i % LINE_COLORS.length]} dot={false} strokeWidth={1.4} isAnimationActive={false} connectNulls />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}
            {(!sensors || !sensors.samples?.length) && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>아직 수집된 센서 샘플이 없습니다. 첫 수집(1분 주기) 후 표시됩니다.</div>}
          </div>
        )}

        {tab === 'versions' && (
          invErr ? <ErrorBox message={invErr} /> : !inv ? <Loading /> : (
            <div>
              <div className="flex gap wrap" style={{ marginBottom: 12 }}>
                {Object.entries({ 전체: inv.health?.overall, CPU: inv.health?.processor, 메모리: inv.health?.memory, 스토리지: inv.health?.storage, PSU: inv.health?.psu }).map(([k, v]) => v ? (
                  <span key={k} className={`badge ${/ok/i.test(v) ? 'green' : /warn/i.test(v) ? 'amber' : 'red'}`}>{k}: {v}</span>
                ) : null)}
              </div>
              <div className="spec-grid" style={{ marginBottom: 14 }}>
                <div><span className="muted">iDRAC 펌웨어</span><div><b>{inv.idrac?.firmwareVersion || '—'}</b> {inv.idrac?.model && <span className="muted">({inv.idrac.model})</span>}</div></div>
                <div><span className="muted">BIOS 버전</span><div><b>{inv.bios?.version || inv.system?.biosVersion || '—'}</b></div></div>
                <div><span className="muted">모델</span><div>{[inv.system?.manufacturer, inv.system?.model].filter(Boolean).join(' ') || '—'}</div></div>
                <div><span className="muted">서비스태그</span><div>{inv.system?.serviceTag || '—'}</div></div>
                <div><span className="muted">CPU</span><div>{inv.cpu?.model || '—'} {inv.cpu?.count ? <span className="muted">×{inv.cpu.count} · {inv.cpu.cores}C/{inv.cpu.threads}T</span> : ''}</div></div>
                <div><span className="muted">메모리</span><div>{inv.memory?.totalGiB ? `${inv.memory.totalGiB} GiB` : '—'}{inv.memoryDimms?.length ? <span className="muted"> · DIMM {inv.memoryDimms.length}</span> : ''}</div></div>
                {inv.powerCap?.limitWatts != null && <div><span className="muted">전력 한도</span><div>{inv.powerCap.limitWatts} W</div></div>}
              </div>

              {(inv.psus || []).length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, margin: '6px 0' }}>전원공급장치(PSU) {inv.psus.length}</div>
                  <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
                    <thead><tr><th style={{ textAlign: 'left' }}>이름</th><th style={{ textAlign: 'left' }}>모델</th><th style={{ textAlign: 'left' }}>용량/출력</th><th style={{ textAlign: 'left' }}>입력</th><th style={{ textAlign: 'left' }}>상태</th></tr></thead>
                    <tbody>{inv.psus.map((p, i) => (
                      <tr key={i}><td>{p.name}</td><td className="muted">{p.model || '—'}</td>
                        <td className="tabular">{p.capacityWatts ? `${p.capacityWatts}W` : '—'}{p.outputWatts != null ? ` / ${p.outputWatts}W` : ''}</td>
                        <td className="tabular">{p.lineInputVoltage != null ? `${p.lineInputVoltage}V` : '—'}{p.inputWatts != null ? ` · ${p.inputWatts}W` : ''}</td>
                        <td><span className={`badge ${/ok/i.test(p.health) ? 'green' : p.health ? 'amber' : 'gray'}`}>{p.health || p.state || '—'}</span></td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )}

              {(inv.disks || []).length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, margin: '6px 0' }}>물리 디스크 {inv.disks.length} {inv.disks.some((d) => d.predictiveFailure) && <span className="badge red" style={{ marginLeft: 6 }}>⚠ SMART 예측 실패</span>}</div>
                  <div style={{ maxHeight: 200, overflow: 'auto' }}>
                    <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
                      <thead><tr><th style={{ textAlign: 'left' }}>디스크</th><th style={{ textAlign: 'left' }}>용량</th><th style={{ textAlign: 'left' }}>미디어</th><th style={{ textAlign: 'left' }}>상태</th></tr></thead>
                      <tbody>{inv.disks.map((d, i) => (
                        <tr key={i}><td>{d.name}<div className="muted" style={{ fontSize: 11 }}>{d.model}</div></td>
                          <td className="tabular">{d.capacityGB != null ? `${d.capacityGB} GB` : '—'}</td>
                          <td className="muted">{d.media || '—'}{d.protocol ? ` · ${d.protocol}` : ''}</td>
                          <td>{d.predictiveFailure ? <span className="badge red">예측 실패</span> : <span className={`badge ${/ok/i.test(d.health) ? 'green' : d.health ? 'amber' : 'gray'}`}>{d.health || d.state || '—'}</span>}</td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                </div>
              )}

              {(inv.gpus || []).length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, margin: '6px 0' }}>GPU(iDRAC 인식) {inv.gpus.length}</div>
                  <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
                    <thead><tr><th style={{ textAlign: 'left' }}>이름</th><th style={{ textAlign: 'left' }}>모델</th><th style={{ textAlign: 'left' }}>상태</th></tr></thead>
                    <tbody>{inv.gpus.map((g, i) => (
                      <tr key={i}><td>{g.name}</td><td className="muted">{[g.manufacturer, g.model].filter(Boolean).join(' ') || '—'}</td>
                        <td><span className={`badge ${/ok/i.test(g.health) ? 'green' : g.health ? 'amber' : 'gray'}`}>{g.health || g.state || '—'}</span></td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )}

              {(inv.nics || []).length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, margin: '6px 0' }}>NIC 어댑터/포트 {inv.nics.length}</div>
                  <div style={{ maxHeight: 200, overflow: 'auto' }}>
                    {inv.nics.map((n, i) => (
                      <div key={i} style={{ marginBottom: 6 }}>
                        <div style={{ fontSize: 12, fontWeight: 600 }}>{n.model || n.name}</div>
                        <div className="flex gap wrap" style={{ marginTop: 2 }}>
                          {(n.ports || []).length === 0 ? <span className="muted" style={{ fontSize: 11 }}>포트 정보 없음</span> : n.ports.map((p, j) => (
                            <span key={j} className={`badge ${/up|enabled|linkup/i.test(p.link) ? 'green' : 'gray'}`} style={{ fontSize: 11 }}>
                              {p.id} {/up|enabled|linkup/i.test(p.link) ? '🔗' : '⛔'} {p.speedMbps ? `${p.speedMbps >= 1000 ? `${(p.speedMbps / 1000).toFixed(0)}G` : `${p.speedMbps}M`}` : ''}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(inv.licenses || []).length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, margin: '6px 0' }}>iDRAC 라이선스</div>
                  <div className="flex gap wrap">
                    {inv.licenses.map((l, i) => <span key={i} className="badge blue" title={l.entitlement}>{l.type || l.name}{l.expiry ? ` · ~${String(l.expiry).slice(0, 10)}` : ''}</span>)}
                  </div>
                </div>
              )}

              {(inv.idracUsers || []).length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, margin: '6px 0' }}>iDRAC 계정 {inv.idracUsers.length}</div>
                  <div className="flex gap wrap">
                    {inv.idracUsers.map((u, i) => <span key={i} className={`badge ${u.enabled ? 'gray' : 'red'}`}>{u.userName} · {u.role || '—'}{u.enabled ? '' : '(비활성)'}</span>)}
                  </div>
                </div>
              )}

              {inv.boot && (inv.boot.overrideTarget || inv.boot.bootOrderCount != null) && (
                <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
                  부팅: {inv.boot.bootOrderCount != null ? `순서 ${inv.boot.bootOrderCount}개` : ''}{inv.boot.overrideTarget && inv.boot.overrideTarget !== 'None' ? ` · 다음부팅 ${inv.boot.overrideTarget}(${inv.boot.overrideEnabled})` : ''}{inv.boot.mode ? ` · ${inv.boot.mode}` : ''}
                </div>
              )}

              {(inv.events || []).length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, margin: '6px 0' }}>최근 하드웨어 이벤트(Critical/Warning) {inv.events.length}</div>
                  <div style={{ maxHeight: 160, overflow: 'auto' }}>
                    {inv.events.map((e, i) => (
                      <div key={i} style={{ fontSize: 12, padding: '4px 0', borderBottom: '1px solid rgba(148,163,184,.12)' }}>
                        <span className={`badge ${/crit/i.test(e.severity) ? 'red' : 'amber'}`} style={{ marginRight: 6 }}>{e.severity}</span>
                        <span className="muted">{e.created ? new Date(e.created).toLocaleString('ko-KR') : ''}</span>
                        <div style={{ marginTop: 2 }}>{e.message}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ fontSize: 13, fontWeight: 700, margin: '6px 0' }}>펌웨어 / 드라이버 버전 ({(inv.firmware || []).length})</div>
              {(inv.firmware || []).length === 0 ? <div className="muted" style={{ fontSize: 13 }}>펌웨어 인벤토리를 읽지 못했습니다(모델/권한 확인). “↻ 즉시 재수집”을 눌러보세요.</div> : (
                <div style={{ maxHeight: 340, overflow: 'auto' }}>
                  <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
                    <thead><tr><th style={{ textAlign: 'left' }}>종류</th><th style={{ textAlign: 'left' }}>구성요소</th><th style={{ textAlign: 'left' }}>버전</th></tr></thead>
                    <tbody>
                      {orderedTypes.map((ty) => fwByType[ty].map((f, i) => (
                        <tr key={ty + i}>
                          <td>{i === 0 ? <span className="badge gray">{ty}</span> : ''}</td>
                          <td>{f.name}</td>
                          <td className="tabular"><b>{f.version}</b></td>
                        </tr>
                      )))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>인벤토리는 30분마다 자동 갱신됩니다. 방금 값을 보려면 “↻ 즉시 재수집”.</div>
            </div>
          )
        )}

        {tab === 'gpu' && (
          <div>
            <div className="flex gap" style={{ alignItems: 'center', marginBottom: 12 }}>
              <button className="logout-btn" style={{ padding: '7px 14px' }} disabled={gpuProbe === 'loading'} onClick={runGpuProbe}>{gpuProbe === 'loading' ? '확인 중…' : '↻ 다시 확인'}</button>
              <span className="muted" style={{ fontSize: 12 }}>iDRAC(Redfish)에서 이 서버의 GPU 사용률을 OOB로 수집할 수 있는지 실측합니다.</span>
            </div>
            {gpuProbe === 'loading' ? <Loading /> : !gpuProbe ? null : gpuProbe.ok === false ? <ErrorBox message={gpuProbe.reason} /> : (
              <div>
                <div className="card" style={{ padding: 14, marginBottom: 14, borderColor: gpuProbe.utilizationAvailable ? 'var(--green)' : 'var(--amber)' }}>
                  <div style={{ fontSize: 16, fontWeight: 800, color: gpuProbe.utilizationAvailable ? 'var(--green)' : 'var(--amber)' }}>
                    {gpuProbe.utilizationAvailable ? '✅ GPU 사용률 OOB 수집 가능' : '⚠ GPU 사용률 OOB 수집 불가/미확인'}
                  </div>
                  <div className="muted" style={{ fontSize: 13, marginTop: 6, lineHeight: 1.6 }}>
                    {gpuProbe.utilizationAvailable
                      ? 'iDRAC 텔레메트리/ProcessorMetrics에서 GPU 사용률 메트릭이 확인되었습니다. (게스트 nvidia-smi 없이도 수집 가능)'
                      : 'iDRAC에서 GPU 사용률 메트릭을 찾지 못했습니다. 보통 iDRAC9 + DataCenter 라이선스 + SMBPBI 지원 데이터센터 GPU + 텔레메트리 활성에서만 노출됩니다. 그 전까지는 게스트 OS의 nvidia-smi(설정 › GPU 게스트 수집)로 수집하세요.'}
                  </div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, margin: '6px 0' }}>iDRAC 인식 GPU {gpuProbe.gpus.length}</div>
                {gpuProbe.gpus.length === 0 ? <div className="muted" style={{ fontSize: 13 }}>iDRAC가 인식한 GPU가 없습니다(패스쓰루로 게스트에 직접 할당된 경우 안 보일 수 있음).</div> : (
                  <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
                    <thead><tr><th style={{ textAlign: 'left' }}>GPU</th><th style={{ textAlign: 'left' }}>사용률</th><th style={{ textAlign: 'left' }}>온도</th><th style={{ textAlign: 'left' }}>전력</th><th style={{ textAlign: 'left' }}>상태</th></tr></thead>
                    <tbody>{gpuProbe.gpus.map((g, i) => (
                      <tr key={i}>
                        <td>{g.name}<div className="muted" style={{ fontSize: 11 }}>{[g.manufacturer, g.model].filter(Boolean).join(' ')}</div></td>
                        <td className="tabular">{g.utilPct != null ? `${g.utilPct}%` : g.bandwidthPct != null ? `${g.bandwidthPct}% (대역폭)` : '—'}</td>
                        <td className="tabular">{g.tempC != null ? `${g.tempC}℃` : '—'}</td>
                        <td className="tabular">{g.powerW != null ? `${g.powerW}W` : '—'}</td>
                        <td><span className={`badge ${/ok/i.test(g.health) ? 'green' : g.health ? 'amber' : 'gray'}`}>{g.health || g.state || '—'}</span></td>
                      </tr>
                    ))}</tbody>
                  </table>
                )}
                <div style={{ fontSize: 13, fontWeight: 700, margin: '12px 0 6px' }}>텔레메트리</div>
                <div className="muted" style={{ fontSize: 13 }}>
                  TelemetryService: <b style={{ color: gpuProbe.telemetry.available ? 'var(--green)' : 'var(--text-faint)' }}>{gpuProbe.telemetry.available ? '있음' : '없음/비활성'}</b>
                  {gpuProbe.telemetry.gpuReports.length > 0 && <> · GPU 리포트 {gpuProbe.telemetry.gpuReports.map((r) => `${r.id}(${r.metrics}개${r.hasUtilization ? ', 사용률O' : ''})`).join(', ')}</>}
                </div>
                {(gpuProbe.notes || []).length > 0 && (
                  <ul className="muted" style={{ fontSize: 12, marginTop: 10, paddingLeft: 18 }}>
                    {gpuProbe.notes.map((n, i) => <li key={i}>{n}</li>)}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
