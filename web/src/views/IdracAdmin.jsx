import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../api.js';
import { Loading, ErrorBox, Modal } from '../components/ui.jsx';
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
  const [bulkMode, setBulkMode] = useState('merge'); // IP 일괄 등록 교체 모드: merge|replace|replace-vcenter
  const [csvText, setCsvText] = useState(null);   // null = closed
  const [bulk, setBulk] = useState(null);          // null = closed
  const [bulkPreview, setBulkPreview] = useState(null);
  const [scanResult, setScanResult] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [scanAgent, setScanAgent] = useState('__local__'); // 스캔 수행 주체(로컬 또는 에이전트 이름)
  const [agents, setAgents] = useState({ agents: [], centralEnabled: false });
  const [scanProgress, setScanProgress] = useState(null); // 위임 스캔 진행 안내문
  const [scanPct, setScanPct] = useState(null); // { scanned, total, found } 진행률 바
  const [scanStartedAt, setScanStartedAt] = useState(null); // 진행 창 경과시간 기준
  const [scanTick, setScanTick] = useState(0); // 1초마다 증가(경과시간/애니메이션 갱신)
  const scanAbort = useRef(false); // 스캔/등록 대기 취소 플래그
  const [vcenters, setVcenters] = useState([]);           // vCenter 목록(소속 지정용)
  const [datacenters, setDatacenters] = useState([]);     // DataCenter(법인) 목록(스캔 소속 선택용)
  const [assignVc, setAssignVc] = useState('');           // 일괄 지정 대상 vCenter
  const fileRef = useRef(null);
  const pollAbort = useRef(false); // 위임 등록/스캔 폴링 취소 플래그
  const [scanRanges, setScanRanges] = useState({ ranges: [], status: null, centralEnabled: false }); // vCenter별 iDRAC 스캔 대역
  const [srForm, setSrForm] = useState(null); // 스캔 대역 편집 폼 { vcenterId, ranges, username, password, agent, enabled, mode } | null
  const [srMsg, setSrMsg] = useState(null); // 스캔 대역 폼 인라인 피드백 { ok, text }
  const [scanJobs, setScanJobs] = useState({ status: null, jobs: [], collectors: [], centralEnabled: false }); // 스캔 현황(주기+위임 잡)
  const [vcCheck, setVcCheck] = useState(null); // vCenter 전력 수집 점검 결과(모달) | null

  const load = async () => {
    try { setData(await fetchJson('/admin/idrac')); setError(null); }
    catch (e) { setError(e.message); }
  };
  const loadScanRanges = () => fetchJson('/admin/idrac/scan-ranges').then((d) => setScanRanges({ ranges: d.ranges || [], status: d.status || null, centralEnabled: !!d.centralEnabled })).catch(() => {});
  const loadScanJobs = () => fetchJson('/admin/idrac/scan-jobs').then((d) => setScanJobs({ status: d.status || null, jobs: d.jobs || [], collectors: d.collectors || [], centralEnabled: !!d.centralEnabled })).catch(() => {});
  useEffect(() => {
    load();
    fetchJson('/admin/idrac/scan-agents').then(setAgents).catch(() => {});
    fetchJson('/admin/vcenters').then((d) => setVcenters(d.vcenters || d || [])).catch(() => fetchJson('/vcenters').then((d) => setVcenters(d || [])).catch(() => {}));
    fetchJson('/admin/datacenters').then((d) => setDatacenters(d.datacenters || [])).catch(() => {});
    loadScanRanges();
    loadScanJobs();
    // 이 화면은 '스캔 현황 + 법인별 iDRAC 장비 스캔'만 노출 → 스캔 관련만 주기 갱신
    // (전력 대시보드/출처 진단 폴링 제거: 더는 표시하지 않으므로 불필요한 서버 부하 방지).
    const td = setInterval(() => { loadScanRanges(); loadScanJobs(); }, 30_000);
    return () => { clearInterval(td); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 진행 창이 떠 있는 동안 1초마다 틱 → 경과시간·애니메이션이 항상 움직여 '멈춤'처럼 보이지 않게.
  useEffect(() => {
    if (!scanProgress) return undefined;
    const iv = setInterval(() => setScanTick((t) => t + 1), 1000);
    return () => clearInterval(iv);
  }, [scanProgress]);

  // 언마운트(메뉴 이탈) 시 진행 중인 스캔/등록 폴링 루프를 중단(백그라운드 폴링·언마운트 후 setState 방지).
  useEffect(() => () => { scanAbort.current = true; pollAbort.current = true; }, []);

  // 스캔 잡이 진행 중(주기 스캐너 running 또는 위임 잡 pending/running)이면 3초마다 현황 갱신.
  const scanBusy = !!scanJobs.status?.running || (scanJobs.jobs || []).some((j) => j.state === 'pending' || j.state === 'running');
  useEffect(() => {
    if (!scanBusy) return undefined;
    const iv = setInterval(() => { loadScanJobs(); loadScanRanges(); }, 5_000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanBusy]);

  // 스캔 진행 중이면 상태를 주기(5s) 폴링해 진행률·결과를 갱신.
  useEffect(() => {
    if (!scanRanges.status?.running) return undefined;
    const iv = setInterval(() => {
      fetchJson('/admin/idrac/scan-ranges/status')
        .then((d) => { setScanRanges((s) => ({ ...s, status: d.status || s.status })); if (!d.status?.running) loadScanRanges(); })
        .catch(() => {});
    }, 5_000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanRanges.status?.running]);

  const assignAllVcenter = async () => {
    setBusy(true); setImportMsg(null);
    try {
      const r = await postJson('/admin/idrac/assign-vcenter', { all: true, vcenterId: assignVc });
      setImportMsg(r.ok ? { ok: true, text: `${r.updated}대의 소속 vCenter를 ${assignVc ? `'${assignVc}'(으)로 지정` : '해제'}했습니다. (총 ${r.total})` } : { ok: false, text: r.reason });
      if (r.ok) await load();
    } catch (e) { setImportMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  // 전체 삭제 / 소속 vCenter 삭제. by==='all' 전체, 그 외엔 assignVc(빈문자=미지정) 대상.
  const deleteServers = async (by) => {
    const isAll = by === 'all';
    const vcName = assignVc ? (vcenters.find((v) => v.id === assignVc)?.name || assignVc) : '미지정';
    const msg = isAll
      ? `등록된 iDRAC 서버를 전부 삭제할까요? 이 작업은 되돌릴 수 없습니다.`
      : `소속 vCenter '${vcName}'에 속한 iDRAC 서버를 모두 삭제할까요? (되돌릴 수 없음)`;
    if (!window.confirm(msg)) return;
    setBusy(true); setImportMsg(null);
    try {
      const r = await postJson('/admin/idrac/delete', isAll ? { all: true } : { vcenterId: assignVc });
      setImportMsg(r.ok ? { ok: true, text: `${r.removed}대를 삭제했습니다. (남은 ${r.total}대)` } : { ok: false, text: r.reason });
      if (r.ok) await load();
    } catch (e) { setImportMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  // 에이전트 이름 → 소속 vCenter 자동 매칭(같은 id 또는 이름). 위임 스캔 시 vCenter를 자동 선택.
  const vcForAgent = (agentName) => {
    const a = String(agentName || '').trim().toLowerCase();
    if (!a) return '';
    const v = vcenters.find((x) => String(x.id).toLowerCase() === a || String(x.name || '').toLowerCase() === a);
    return v ? v.id : '';
  };
  // 스캔 수행 Agent 변경: 위임이면 소속 vCenter를 자동 지정(드롭다운 숨김). 로컬이면 수동 선택 유지.
  const onChangeAgent = (val) => {
    setScanAgent(val);
    if (val !== '__local__') setBulk((b) => (b ? { ...b, vcenterId: vcForAgent(val) } : b));
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

  // 오류/고아 전력 데이터 정리.
  // mode='stale'(기본): 등록 해제된 OME/수집서버 잔여 + 고아 DB 행만 삭제(활성 소스 보존).
  // mode='all'(강제): 등록 여부 무관하게 OME 캐시·원격 호스트 전체 비우고 등록 iDRAC 외 DB 행 삭제.
  const purgeStale = async (mode = 'stale') => {
    const all = mode === 'all';
    const msg = all
      ? '⚠️ 강제 전체 초기화\n\n등록 여부와 무관하게 OME 자동발견 디바이스 캐시와 원격 수집 호스트를 모두 비우고, 등록된 iDRAC 외의 모든 전력 이력을 삭제합니다.\n\n※ 등록된 OME/수집서버가 있으면 다음 폴링에서 다시 채워집니다(= 그 수치는 실제 데이터). 영구 제거하려면 해당 OME 연결/수집서버 등록 자체를 삭제하세요.\n\n계속할까요?'
      : '등록/활성 소스에 속하지 않는 오류·고아 전력 데이터(제거된 OME·수집서버 잔여, 고아 이력)를 삭제할까요?\n현재 등록된 서버·활성 수집은 보존됩니다.';
    if (!window.confirm(msg)) return;
    setBusy(true); setImportMsg(null);
    try {
      const r = await postJson('/admin/idrac/power-purge', { mode });
      const delta = (r.beforeTotal != null && r.afterTotal != null) ? ` · 전력 보고 ${r.beforeTotal}→${r.afterTotal}대` : '';
      setImportMsg(r.ok
        ? { ok: true, text: `${all ? '강제 전체 초기화' : '정리'} 완료 — 고아 이력 ${r.dbRemoved}건 · OME 캐시 ${r.omeCleared}건 · 원격 잔여 ${r.remoteCleared}건 삭제${delta}. 잠시 후 집계가 갱신됩니다.` }
        : { ok: false, text: r.reason });
      await load();
    } catch (e) { setImportMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };


  // ── 법인(DataCenter)별 iDRAC 장비 스캔 ──────────────────────────
  const srOpenNew = () => { setSrMsg(null); setSrForm({ datacenterId: '', ranges: '', username: 'root', password: '', agent: '__local__', enabled: true, mode: 'merge', isNew: true }); };
  const srEdit = (e) => { setSrMsg(null); setSrForm({ datacenterId: e.datacenterId, ranges: (e.ranges || []).join('\n'), username: e.username || 'root', password: '', agent: e.agent || '__local__', enabled: e.enabled !== false, mode: e.mode || 'merge', hasPassword: e.hasPassword, isNew: false }); };
  const srSave = async () => {
    const f = srForm; if (!f) return;
    // 폼 바로 옆에 보이는 인라인 검증(상단 배너만 뜨면 폼에서 안 보여 '저장 안 됨'처럼 느껴짐).
    if (!f.datacenterId) { setSrMsg({ ok: false, text: '법인(DataCenter)을 선택하세요.' }); return; }
    if (!(f.ranges || '').trim()) { setSrMsg({ ok: false, text: 'IP 대역을 한 줄에 하나씩 입력하세요.' }); return; }
    if (!(f.username || '').trim()) { setSrMsg({ ok: false, text: 'iDRAC 계정을 입력하세요.' }); return; }
    // 비밀번호는 권장이지만 필수는 아님 — 없이도 저장(스캔은 비번 입력 시까지 보류). 저장이 막히지 않게.
    // '입력했는지' 판정은 빈 문자열 여부로만 한다(trim 금지) — 공백/특수문자로만 이뤄진 비밀번호도
    // 온전히 전송되게(과거 trim 판정으로 공백 비번이 조용히 누락됐다).
    const noPw = !f.hasPassword && (f.password || '') === '';
    setBusy(true); setSrMsg(null);
    try {
      const body = { datacenterId: f.datacenterId, ranges: f.ranges, username: f.username, agent: f.agent === '__local__' ? '' : f.agent, enabled: f.enabled, mode: f.mode };
      if ((f.password || '') !== '') body.password = f.password; // 빈 비번은 서버가 기존 유지, 그 외엔 원본 그대로 전송
      const r = await putJson('/admin/idrac/scan-ranges', body);
      if (r.ok) {
        const note = noPw ? ' · ⚠ 비밀번호 미설정 — 스캔하려면 비밀번호를 입력하세요' : '';
        const text = `스캔 대역 저장됨 — ${f.datacenterId} (대역 ${(r.ranges || []).length}개${r.enabled ? ', 주기 스캔 포함' : ', 비활성'})${note}`;
        setImportMsg({ ok: true, text }); // 상단 배너에도 표시
        setSrForm(null); setSrMsg(null);
        await loadScanRanges();
      } else {
        setSrMsg({ ok: false, text: r.reason || '저장 실패' });
      }
    } catch (e) { setSrMsg({ ok: false, text: `저장 실패: ${e.message}` }); }
    finally { setBusy(false); }
  };
  const srDelete = async (datacenterId) => {
    if (!window.confirm(`'${datacenterId}' 법인의 iDRAC 스캔 대역을 삭제할까요? (등록된 서버는 그대로 유지됩니다)`)) return;
    setBusy(true); setImportMsg(null);
    try {
      const r = await delJson(`/admin/idrac/scan-ranges/${encodeURIComponent(datacenterId)}`);
      setImportMsg(r.ok ? { ok: true, text: `스캔 대역 삭제됨 — ${datacenterId}` } : { ok: false, text: r.reason });
      await loadScanRanges();
    } catch (e) { setImportMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };
  const srScanNow = async (datacenterId) => {
    setBusy(true); setImportMsg(null);
    try {
      const r = await postJson('/admin/idrac/scan-ranges/scan', datacenterId ? { datacenterId } : {});
      setImportMsg(r.ok ? { ok: true, text: datacenterId ? `'${datacenterId}' 법인 대역 스캔을 시작했습니다(백그라운드).` : '전체 대역 스캔을 시작했습니다(백그라운드).' } : { ok: false, text: r.reason });
      if (r.status) setScanRanges((s) => ({ ...s, status: r.status }));
      await loadScanRanges(); await loadScanJobs();
    } catch (e) { setImportMsg({ ok: false, text: e.message }); }
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
    setBusy(true); setScanResult(null); setImportMsg(null); setScanPct(null);
    scanAbort.current = false;
    setScanStartedAt(Date.now());
    const delegated = scanAgent && scanAgent !== '__local__';
    // 로컬 스캔은 단일 요청(동기)이라 증분 진행률이 없다 → 경과시간·애니메이션으로 '진행 중'을 표시.
    setScanProgress(delegated ? '에이전트에 스캔 요청을 전송하는 중…' : '이 포탈에서 직접 스캔 중… (대역이 크면 다소 걸립니다)');
    try {
      const r = await postJson('/admin/idrac/scan', { ips: bulk.ips, username: bulk.username, password: bulk.password, agent: scanAgent, vcenterId: bulk.vcenterId || '' });
      if (!r.ok) { setScanProgress(null); setImportMsg({ ok: false, text: r.reason }); return; }
      if (!r.delegated) {
        setScanProgress(null); setScanPct(null);
        setScanResult({ ...r, delegated: false });
        setSelected(new Set(r.found.map((f) => f.ip)));
        return;
      }
      // 위임 스캔: reqId로 결과를 폴링(에이전트가 현지 스캔→현지 등록 후 회신).
      const reqId = r.reqId;
      setScanProgress(`에이전트 '${r.agent}'가 잡을 인출하기를 기다리는 중… (에이전트 실행/연결 확인)`);
      const start = Date.now();
      const ABS_MAX_MS = 30 * 60_000; // 절대 상한 30분(대역이 크고 미응답이 많아도 진행 중이면 유지)
      let lastScanned = -1, lastAdvance = Date.now();
      // eslint-disable-next-line no-await-in-loop
      while (!scanAbort.current) {
        if (Date.now() - start > ABS_MAX_MS) {
          setScanProgress(null); setScanPct(null);
          setImportMsg({ ok: false, text: '스캔이 30분 내 끝나지 않았습니다. 에이전트 상태/대역 크기를 확인하세요.' });
          return;
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((res) => setTimeout(res, 2000));
        if (scanAbort.current) break;
        // eslint-disable-next-line no-await-in-loop
        const s = await fetchJson(`/admin/idrac/scan-result?reqId=${encodeURIComponent(reqId)}`).catch(() => null);
        if (!s) continue;
        if (s.state === 'done' || s.state === 'error') {
          setScanProgress(null); setScanPct(null);
          if (s.state === 'error') { setImportMsg({ ok: false, text: `에이전트 스캔 오류: ${s.error || '알 수 없음'}` }); return; }
          setScanResult({ ...s, delegated: true });
          setSelected(new Set((s.found || []).map((f) => f.ip))); // 스캔만 한 상태 — 확인 후 '등록' 버튼으로 등록
          return;
        }
        if (s.state === 'unknown') { setScanProgress(null); setScanPct(null); setImportMsg({ ok: false, text: '스캔 잡을 찾을 수 없습니다(만료되었거나 에이전트 미응답).' }); return; }
        if (s.progress && s.progress.total > 0) {
          setScanPct({ scanned: s.progress.scanned || 0, total: s.progress.total, found: s.progress.found || 0 });
          if ((s.progress.scanned || 0) > lastScanned) { lastScanned = s.progress.scanned || 0; lastAdvance = Date.now(); }
        }
        const stalled = Date.now() - lastAdvance > 90_000; // 90초 무진행 → 미응답 IP 많음 안내(계속 대기)
        setScanProgress(s.state === 'running'
          ? `에이전트 '${r.agent}'가 스캔 중…${stalled ? ' (응답이 느립니다 — 미응답 IP가 많을 수 있어요)' : ''}`
          : `에이전트 '${r.agent}'가 잡을 인출하기를 기다리는 중… (에이전트 실행/연결 확인)`);
      }
      // 사용자 취소
      setScanProgress(null); setScanPct(null);
      setImportMsg({ ok: false, text: '스캔 대기를 취소했습니다. 에이전트에는 이미 전달됐을 수 있으니, 결과는 잠시 후 다시 스캔하거나 서버 목록에서 확인하세요.' });
    } catch (e) { setScanProgress(null); setScanPct(null); setImportMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  // 모달 닫기 — 진행 중인 스캔/등록 대기 폴링도 중단(닫은 뒤 백그라운드에서 계속 도는 것 방지).
  const closeBulk = () => {
    scanAbort.current = true; pollAbort.current = true;
    setScanProgress(null); setScanPct(null);
    setBulk(null); setBulkPreview(null); setScanResult(null);
  };

  const toggleSel = (ip) => setSelected((s) => { const n = new Set(s); n.has(ip) ? n.delete(ip) : n.add(ip); return n; });

  // 스캔 결과 등록(확인). 로컬은 중앙 등록, 위임은 에이전트 현지 등록(잡 폴링).
  const registerScanned = async () => {
    const found = (scanResult?.found || []).filter((f) => selected.has(f.ip));
    if (!found.length) return;
    setBusy(true); setImportMsg(null);
    try {
      const body = { found, username: bulk.username, password: bulk.password, mode: bulkMode, vcenterId: bulk.vcenterId || '' };
      if (scanResult.delegated) body.agent = scanResult.agent || scanAgent;
      const r = await postJson('/admin/idrac/register-scanned', body);
      // 위임 등록: 에이전트 잡 결과를 폴링.
      if (r.delegated && r.reqId) {
        setScanStartedAt(Date.now());
        setScanProgress(`에이전트 '${r.agent}'에 등록을 요청했습니다. 현지 등록 결과를 기다리는 중… (취소 가능)`);
        pollAbort.current = false; scanAbort.current = false;
        const deadline = Date.now() + 120_000;
        // eslint-disable-next-line no-await-in-loop
        while (Date.now() < deadline) {
          await new Promise((res) => setTimeout(res, 2000));
          if (pollAbort.current) { pollAbort.current = false; setScanProgress(null); setImportMsg({ ok: false, text: '등록 대기를 취소했습니다(에이전트에는 이미 전달됨 — 결과는 서버 목록에서 확인).' }); return; }
          // eslint-disable-next-line no-await-in-loop
          const s = await fetchJson(`/admin/idrac/scan-result?reqId=${encodeURIComponent(r.reqId)}`).catch(() => null);
          if (!s) continue;
          if (s.state === 'done' || s.state === 'error') {
            setScanProgress(null);
            if (s.state === 'error') setImportMsg({ ok: false, text: `에이전트 등록 오류: ${s.error || '알 수 없음'}` });
            else { setImportMsg({ ok: true, text: `에이전트 '${r.agent}'에 iDRAC ${s.registered || found.length}대 등록 완료.` }); await load(); setBulk(null); setBulkPreview(null); setScanResult(null); }
            return;
          }
          if (s.state === 'unknown') { setScanProgress(null); setImportMsg({ ok: false, text: '등록 잡을 찾을 수 없습니다(만료/에이전트 미응답).' }); return; }
        }
        setScanProgress(null); setImportMsg({ ok: false, text: '에이전트 등록이 2분 내 완료되지 않았습니다. 에이전트 상태를 확인하세요.' });
        return;
      }
      // 로컬 등록
      setImportMsg(r.ok
        ? { ok: true, text: `iDRAC ${found.length}대 등록 — 추가 ${r.added}, 갱신 ${r.updated} (총 ${r.total})`, skipped: r.skipped }
        : { ok: false, text: r.reason });
      if (r.ok) { await load(); setBulk(null); setBulkPreview(null); setScanResult(null); }
    } catch (e) { setScanProgress(null); setImportMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  // 스캔 결과 등록 취소 — 등록하지 않고 결과만 비운다(모달 유지, 재스캔 가능).
  const cancelScan = () => { setScanResult(null); setSelected(new Set()); };

  const submitBulk = async () => {
    setBusy(true); setImportMsg(null);
    try {
      const r = await postJson('/admin/idrac/bulk-add', { ...bulk, namePrefix: scanAgent !== '__local__' ? `${scanAgent}-` : '', mode: bulkMode });
      if (r.ok) {
        setImportMsg({ ok: true, skipped: r.skipped,
          text: `IP ${r.expanded}개 → 추가 ${r.added}, 갱신 ${r.updated} (총 ${r.total})${r.truncated ? ' · 상한 4096 적용됨' : ''}${r.ipErrors?.length ? ` · 무시된 항목 ${r.ipErrors.length}` : ''}` });
        await load(); setBulk(null); setBulkPreview(null);
      } else setImportMsg({ ok: false, text: r.reason + (r.ipErrors?.length ? ` (${r.ipErrors.slice(0, 3).join('; ')})` : '') });
    } catch (e) { setImportMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  const list = data.servers || [];

  return (
    <>
      <div className="section-title" style={{ margin: '6px 0' }}>iDRAC 서버 등록 — Dell 베어메탈/물리 서버 (관리자)</div>

      <IdracScanJobs data={scanJobs} vcenters={vcenters} datacenters={datacenters} busy={busy} onRefresh={loadScanJobs} onScanAll={() => srScanNow()} />

      <IdracScanRanges
        data={scanRanges} vcenters={vcenters} datacenters={datacenters} agents={agents} busy={busy}
        form={srForm} setForm={setSrForm} msg={srMsg} setMsg={setSrMsg}
        onNew={srOpenNew} onEdit={srEdit} onSave={srSave} onDelete={srDelete} onScan={srScanNow}
        onReload={loadScanRanges}
      />
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
  const [vh, setVh] = useState(null); // 서비스태그로 매칭된 vCenter 가상화 호스트
  const runGpuProbe = () => { setGpuProbe('loading'); fetchJson(`/admin/idrac/${encodeURIComponent(server.id)}/gpu-probe`).then(setGpuProbe).catch((e) => setGpuProbe({ ok: false, reason: e.message })); };
  const loadInv = (refresh) => fetchJson(`/admin/idrac/${encodeURIComponent(server.id)}/inventory${refresh ? '?refresh=1' : ''}`)
    .then((r) => { setInv(r.inventory); setInvErr(null); }).catch((e) => setInvErr(e.message));
  const loadSensors = () => fetchJson(`/admin/idrac/${encodeURIComponent(server.id)}/sensors?minutes=180`).then(setSensors).catch(() => {});
  useEffect(() => {
    loadInv(false); loadSensors();
    fetchJson(`/admin/idrac/${encodeURIComponent(server.id)}/vcenter-host`).then(setVh).catch(() => setVh(null));
    const t = setInterval(loadSensors, 30_000); return () => clearInterval(t); /* eslint-disable-next-line */
  }, [server.id]);

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

        {/* 물리 ↔ 가상화 브릿지: 서비스태그(= ESXi 일련번호)로 매칭된 vCenter 호스트 */}
        {vh && (
          <div className="card" style={{ padding: '10px 12px', marginBottom: 12, borderLeft: `3px solid ${vh.matched ? 'var(--accent, #60a5fa)' : 'rgba(148,163,184,.4)'}` }}>
            {vh.matched ? (
              <div className="flex between wrap gap" style={{ alignItems: 'center' }}>
                <div style={{ fontSize: 13 }}>
                  🖧 <b>연결된 vCenter 호스트</b>: <b style={{ color: 'var(--accent, #60a5fa)' }}>{vh.host.name}</b>
                  <span className="muted" style={{ marginLeft: 8 }}>
                    · vCenter <b>{vh.host.vcenterId || '—'}</b>
                    {vh.host.cluster ? <> · 클러스터 {vh.host.cluster}</> : null}
                    {vh.host.connectionState ? <> · {vh.host.connectionState}</> : null}
                  </span>
                  <span className="muted" style={{ marginLeft: 8, fontSize: 11 }}>(서비스태그 {vh.serviceTag} 일치)</span>
                </div>
                <div className="flex gap" style={{ fontSize: 12.5 }}>
                  <span className="muted">CPU <b style={{ color: 'var(--text)' }}>{vh.host.cpuUsagePct ?? '—'}%</b></span>
                  <span className="muted">MEM <b style={{ color: 'var(--text)' }}>{vh.host.memUsagePct ?? '—'}%</b></span>
                  <span className="muted">VM <b style={{ color: 'var(--text)' }}>{vh.host.vmCount ?? '—'}</b></span>
                </div>
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 12.5 }}>
                🔩 연결된 vCenter 호스트 없음 — 서비스태그 <b>{vh.serviceTag || '—'}</b>와 일치하는 ESXi 호스트가 없습니다(순수 베어메탈이거나 해당 vCenter 미수집).
              </div>
            )}
          </div>
        )}

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
              <span className="badge amber">최고 온도 {(() => { const t = Object.values(latest?.temps || {}); return t.length ? `${Math.max(...t)}℃` : '—'; })()}</span>
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

// ---- 스캔 잡 세부 로그창 ------------------------------------------------------
// '스캔 현황' 행의 [로그]를 누르면 열림. 잡의 이벤트 타임라인(생성→인출→진행→완료/오류) +
// 멈춤 진단(에이전트 폴링 두절/진행 보고 끊김)을 2.5초 주기로 갱신해 보여준다.
function ScanJobLogModal({ reqId, dcName, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let active = true;
    const load = () => fetchJson(`/admin/idrac/scan-job-log?reqId=${encodeURIComponent(reqId)}`)
      .then((r) => { if (active) { setD(r); setErr(null); } })
      .catch((e) => { if (active) setErr(e.message); });
    load();
    const t = setInterval(load, 2500);
    return () => { active = false; clearInterval(t); };
  }, [reqId]);
  const fmt = (ts) => (ts ? new Date(ts).toLocaleTimeString('ko-KR', { hour12: false }) : '—');
  const dur = (a, b) => (a && b ? `${Math.max(0, Math.round((b - a) / 1000))}초` : '—');
  const lvColor = { info: 'var(--text-dim, #8b9bb4)', warn: '#fbbf24', error: '#f87171' };
  const stateLabel = { pending: '대기(에이전트 인출 전)', running: '진행 중', done: '완료', error: '오류' };
  const now = Date.now();
  return (
    <Modal title={`스캔 세부 로그 — ${reqId}`} onClose={onClose} width={860} resizable minWidth={560} minHeight={380}>
      {err ? <ErrorBox message={err} /> : !d ? <Loading /> : (
        <>
          {/* 요약 헤더 */}
          <div className="flex gap wrap" style={{ fontSize: 12.5, marginBottom: 8, alignItems: 'center' }}>
            <span className="badge blue">{d.action === 'register' ? '등록' : '스캔'}</span>
            <span><b>{stateLabel[d.state] || d.state}</b></span>
            <span className="muted">에이전트 <b style={{ color: '#a78bfa' }}>{d.agent}</b></span>
            {d.datacenterId && <span className="muted">법인 <b>{dcName ? dcName(d.datacenterId) : d.datacenterId}</b></span>}
            {d.progress?.total ? <span className="muted">진행 <b>{d.progress.scanned}/{d.progress.total}</b>{d.progress.found ? ` · 발견 ${d.progress.found}` : ''}</span> : null}
            <span className="muted">경과 {dur(d.createdAt, d.doneAt || now)}</span>
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
            생성 {fmt(d.createdAt)} · 인출 {fmt(d.takenAt)}{d.doneAt ? ` · 종료 ${fmt(d.doneAt)}` : ''}
            {' '}· 에이전트 최근 폴링 {d.agentLastPoll ? `${Math.max(0, Math.round((now - d.agentLastPoll) / 1000))}초 전` : '기록 없음'}
            {' '}· 최근 진행보고 {d.progress?.at ? `${Math.max(0, Math.round((now - d.progress.at) / 1000))}초 전` : '—'}
            {d.ips ? <> · 대역 <span style={{ fontFamily: 'ui-monospace, monospace' }}>{String(d.ips).slice(0, 120)}</span></> : null}
          </div>
          {/* 멈춤 진단 */}
          {(d.hints || []).map((h, i) => (
            <div key={i} style={{ marginBottom: 6, padding: '7px 11px', borderRadius: 8, fontSize: 12.5,
              background: h.level === 'error' ? 'rgba(239,68,68,.14)' : h.level === 'warn' ? 'rgba(245,158,11,.14)' : 'rgba(96,165,250,.12)',
              color: h.level === 'error' ? '#f87171' : h.level === 'warn' ? '#fbbf24' : '#93c5fd' }}>
              {h.level === 'error' ? '⛔ ' : h.level === 'warn' ? '⚠ ' : 'ℹ️ '}{h.msg}
            </div>
          ))}
          {/* 이벤트 타임라인(최신 위) */}
          <div className="table-wrap" style={{ maxHeight: '46vh' }}>
            <table>
              <thead><tr><th style={{ width: 90 }}>시각</th><th>내용</th></tr></thead>
              <tbody>
                {(d.events || []).length === 0 && <tr><td colSpan={2} className="muted" style={{ padding: 14 }}>이벤트가 없습니다.</td></tr>}
                {[...(d.events || [])].reverse().map((e, i) => (
                  <tr key={i}>
                    <td className="muted" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>{fmt(e.ts)}</td>
                    <td style={{ fontSize: 12.5, color: lvColor[e.level] || undefined }}>{e.msg}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.result?.error && <div style={{ marginTop: 8, fontSize: 12.5, color: '#f87171' }}>오류: {d.result.error}</div>}
        </>
      )}
    </Modal>
  );
}

// ---- 스캔 현황(주기 스캐너 + 진행 중/최근 위임 잡) --------------------------
// iDRAC 스캔이 지금 어디까지 진행됐는지 어디서든 한눈에 확인. 주기 스캐너 상태 + 진행 중·최근
// 위임 잡(에이전트 대행)을 실시간으로 보여준다. /admin/idrac/scan-jobs 응답을 렌더.
function IdracScanJobs({ data, vcenters, datacenters = [], busy, onRefresh, onScanAll }) {
  const [logFor, setLogFor] = useState(null); // reqId → 세부 로그 모달
  const st = data?.status || {};
  const jobs = data?.jobs || [];
  const collectors = data?.collectors || [];
  const dcName = (id) => (datacenters.find((d) => d.id === id)?.name || id || '');
  const active = jobs.filter((j) => j.state === 'pending' || j.state === 'running');
  const recent = jobs.filter((j) => j.state === 'done' || j.state === 'error');

  // 위임 스캔 에이전트 → 수집 서버 매칭(id/datacenter/name, 대소문자 무시). 전력이 '원격 수집'으로
  // 반영되려면 그 에이전트가 수집 서버로 등록돼 있어야 한다.
  const norm = (s) => String(s || '').trim().toLowerCase();
  const collectorForAgent = (agent) => {
    const a = norm(agent);
    return collectors.find((c) => norm(c.id) === a || norm(c.datacenter) === a || norm(c.name) === a) || null;
  };
  // 등록(registered>0) 완료된 위임 잡 중 가장 최근 것으로 반영 상태 안내.
  const lastReg = recent.find((j) => j.agent && (j.result?.registered || 0) > 0);
  let advisory = null;
  if (lastReg) {
    const col = collectorForAgent(lastReg.agent);
    const reg = lastReg.result?.registered || 0;
    if (!col) {
      advisory = { ok: false, text: `에이전트 '${lastReg.agent}'가 ${reg}대를 현지 등록했지만, '${lastReg.agent}'가 '수집 서버(원격)'로 등록되어 있지 않습니다. 전력이 중앙에 반영되려면 설정 → 수집 서버(원격)에서 이 에이전트를 수집 서버로 등록하세요(소속 vCenter 매핑 권장).` };
    } else if (col.enabled === false) {
      advisory = { ok: false, text: `수집 서버 '${col.name || col.id}'가 비활성 상태입니다. 활성화하면 에이전트가 등록한 ${reg}대의 전력이 '원격 수집'으로 반영됩니다.` };
    } else if (col.ok === false) {
      advisory = { ok: false, text: `수집 서버 '${col.name || col.id}' 연결 오류(${col.error || '확인 필요'}). 해결되면 등록한 ${reg}대 전력이 반영됩니다.` };
    } else if (!col.hosts) {
      advisory = { ok: true, text: `에이전트 '${lastReg.agent}'에 ${reg}대 등록됨 — 에이전트가 전력을 수집하고 중앙이 당겨오는 중입니다(보통 1~2분). 잠시 후 '원격 수집'에 반영됩니다.` };
    } else {
      advisory = { ok: true, text: `'원격 수집'으로 반영 중 — 수집 서버 '${col.name || col.id}'에서 호스트 ${col.hosts}대 수신.` };
    }
  }
  const ago = (ts) => {
    if (!ts) return '';
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    return s >= 3600 ? `${Math.floor(s / 3600)}시간 전` : s >= 60 ? `${Math.floor(s / 60)}분 전` : `${s}초 전`;
  };
  const stateBadge = (s) => {
    const map = { pending: ['대기', 'gray'], running: ['진행 중', 'amber'], done: ['완료', 'green'], error: ['오류', 'red'], unknown: ['만료', 'gray'] };
    const [label, cls] = map[s] || [s, 'gray'];
    return <span className={`badge ${cls}`}>{label}</span>;
  };
  const Bar = ({ p }) => {
    if (!p || !p.total) return <span className="muted" style={{ fontSize: 11.5 }}>대기 중…</span>;
    const pct = Math.min(100, Math.round((p.scanned / p.total) * 100));
    return (
      <div style={{ minWidth: 160 }}>
        <div className="flex between" style={{ fontSize: 11, marginBottom: 2 }}>
          <span className="muted">{(p.scanned || 0).toLocaleString()}/{(p.total || 0).toLocaleString()}{p.found ? ` · 발견 ${p.found}` : ''}</span>
          <b>{pct}%</b>
        </div>
        <div style={{ height: 6, borderRadius: 4, background: 'rgba(36,48,73,.8)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', transition: 'width .4s', borderRadius: 4 }} />
        </div>
      </div>
    );
  };

  const pollerRunning = !!st.running;
  const anyActive = pollerRunning || active.length > 0;
  const borderColor = anyActive ? 'var(--amber)' : 'var(--green, #22c55e)';

  return (
    <div className="card" style={{ marginBottom: 12, padding: '12px 16px', borderLeft: `3px solid ${borderColor}` }}>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 8 }}>
        <b style={{ fontSize: 13 }}>스캔 현황 {anyActive ? <span style={{ color: 'var(--amber)' }}>· 진행 중</span> : <span className="muted" style={{ fontWeight: 400 }}>· 유휴</span>}</b>
        <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="muted" style={{ fontSize: 12 }}>
            주기 스캐너: {pollerRunning ? <span style={{ color: 'var(--amber)' }}>스캔 중</span> : '대기'}
            {' '}· 활성 {st.enabledDatacenters ?? 0} 법인
            {st.intervalMs ? ` · 주기 ${Math.round(st.intervalMs / 3600000 * 10) / 10}h` : ''}
          </span>
          <button className="logout-btn" style={{ padding: '7px 12px', fontSize: 12 }} disabled={busy} onClick={onRefresh}>새로고침</button>
          <button className="logout-btn" style={{ padding: '7px 12px', fontSize: 12 }} disabled={busy || pollerRunning} onClick={onScanAll} title="활성 법인 대역 전체를 지금 스캔">⚡ 지금 스캔(전체)</button>
        </div>
      </div>

      {/* 주기 스캐너 자체 진행률(중앙 직접 스캔 중) */}
      {pollerRunning && st.progress && (
        <div style={{ marginBottom: 8 }}>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 3 }}>
            중앙 직접 스캔: {dcName(st.progress.datacenterId)} ({(st.progress.idx ?? 0) + 1}/{st.progress.totalDatacenters})
            {st.progress.total ? ` — ${st.progress.done}/${st.progress.total} (${st.progress.pct ?? 0}%)` : ''}
            {st.progress.foundSoFar != null ? ` · 누적 발견 ${st.progress.foundSoFar}` : ''}
          </div>
          <div style={{ height: 6, borderRadius: 4, background: 'rgba(36,48,73,.8)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${st.progress.pct ?? 0}%`, background: 'var(--accent)', transition: 'width .4s', borderRadius: 4 }} />
          </div>
        </div>
      )}

      {jobs.length === 0 && !pollerRunning ? (
        <div className="muted" style={{ fontSize: 12 }}>
          진행 중인 스캔이 없습니다. 아래 ‘스캔 대역’에서 ‘스캔’을 누르거나, 주기 스캐너가 {st.intervalMs ? `${Math.round(st.intervalMs / 3600000 * 10) / 10}시간` : '설정 주기'}마다 자동 실행합니다.
          {data?.centralEnabled === false && <span style={{ color: 'var(--amber)' }}> (에이전트 위임 스캔은 중앙 토큰 설정 필요)</span>}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>상태</th><th>유형</th><th>대상</th><th>에이전트</th><th>진행/결과</th><th>시각</th><th>로그</th>
            </tr></thead>
            <tbody>
              {[...active, ...recent].map((j) => (
                <tr key={j.reqId}>
                  <td>{stateBadge(j.state)}</td>
                  <td className="muted">{j.action === 'register' ? '등록' : '스캔'}</td>
                  <td>{j.datacenterId ? <b>{dcName(j.datacenterId)}</b> : (j.vcenterId ? <b>{j.vcenterId}</b> : <span className="muted">—</span>)}</td>
                  <td>{j.agent ? <span className="badge" style={{ background: 'rgba(167,139,250,.2)', color: '#a78bfa' }}>{j.agent}</span> : <span className="muted">직접</span>}</td>
                  <td>
                    {(j.state === 'pending' || j.state === 'running') ? <Bar p={j.progress} />
                      : j.state === 'error' ? <span style={{ color: '#f87171', fontSize: 12 }} title={j.result?.error || ''}>오류: {(j.result?.error || '').slice(0, 60) || '알 수 없음'}</span>
                        : <span className="muted" style={{ fontSize: 12 }}>발견 {j.result?.foundCount ?? 0} · 등록 {j.result?.registered ?? 0}{j.result?.scanned != null ? ` · 스캔 ${j.result.scanned}` : ''}</span>}
                  </td>
                  <td className="muted" style={{ fontSize: 11.5 }}>{ago(j.doneAt || j.takenAt || j.createdAt)}</td>
                  <td><button className="tab" style={{ padding: '3px 10px', fontSize: 12 }} title="이벤트 타임라인 + 멈춤 진단" onClick={() => setLogFor(j.reqId)}>로그</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {advisory && (
        <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, fontSize: 12.5,
          background: advisory.ok ? 'rgba(96,165,250,.12)' : 'rgba(245,158,11,.14)',
          color: advisory.ok ? '#93c5fd' : '#fbbf24' }}>
          {advisory.ok ? 'ℹ️ ' : '⚠ '}{advisory.text}
        </div>
      )}

      {st.lastRun && !pollerRunning && (
        <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
          최근 주기 스캔: {st.lastRun.at ? new Date(st.lastRun.at).toLocaleString('ko-KR') : ''}
          {st.lastRun.vcenters != null ? ` — ${st.lastRun.vcenters} vCenter · 발견 ${st.lastRun.found ?? 0} · 등록 ${st.lastRun.registered ?? 0}${st.lastRun.delegated ? ` · 위임 ${st.lastRun.delegated}` : ''}` : ''}
          {st.lastRun.skipped ? ` — ${st.lastRun.skipped}` : ''}
        </div>
      )}

      {logFor && <ScanJobLogModal reqId={logFor} dcName={dcName} onClose={() => setLogFor(null)} />}
    </div>
  );
}

// ---- vCenter별 iDRAC 스캔 대역(주기 자동 발견) ------------------------------
// 각 vCenter에 iDRAC IP 대역 + 계정을 저장하면, 주기 스캐너가 그 대역을 돌며 Dell iDRAC을
// 발견해 해당 vCenter로 자동 등록한다(IPMS의 'vCenter별 스캔 대역'과 같은 흐름).
function IdracScanRanges({ data, vcenters, datacenters = [], agents, busy, form, setForm, msg, setMsg, onNew, onEdit, onSave, onDelete, onScan, onReload }) {
  const st = data?.status || {};
  const prog = st.progress;
  const dcName = (id) => (datacenters.find((d) => d.id === id)?.name || id);
  const [showPw, setShowPw] = useState(false); // 비밀번호 표시 토글 — 특수문자 입력을 눈으로 확인
  // 컬럼 정렬 — 헤더 클릭으로 asc/desc 토글. 기본은 법인명 오름차순.
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const SORT_VAL = {
    name: (e) => String(dcName(e.datacenterId) || '').toLowerCase(),
    ranges: (e) => (e.ranges || []).length,
    username: (e) => String(e.username || '').toLowerCase(),
    agent: (e) => String(e.agent || '').toLowerCase(), // 빈 값(직접)이 맨 앞/뒤
    enabled: (e) => (e.enabled ? 1 : 0),
    lastRun: (e) => e.lastRun?.at || 0,
  };
  const list = [...(data?.ranges || [])].sort((a, b) => {
    const f = SORT_VAL[sort.key] || SORT_VAL.name;
    const x = f(a); const y = f(b);
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return sort.dir === 'asc' ? c : -c;
  });
  const clickSort = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  const Th = ({ k, children, right }) => (
    <th className={right ? 'right' : undefined} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
      title="클릭하여 정렬" onClick={() => clickSort(k)}>
      {children}{sort.key === k ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : <span style={{ opacity: 0.35 }}> ↕</span>}
    </th>
  );
  const fmtRun = (r) => {
    if (!r) return <span className="muted">—</span>;
    const when = r.at ? new Date(r.at).toLocaleString('ko-KR') : '';
    if (r.error) return <span style={{ color: '#f87171' }} title={r.error}>오류 · {when}</span>;
    if (r.delegated) return <span style={{ color: '#a78bfa' }} title={`에이전트 ${r.agent || ''} 위임`}>위임{r.agent ? `(${r.agent})` : ''} · {when}</span>;
    return <span className="muted">발견 {r.found ?? 0} · 등록 {r.registered ?? 0}{r.scanned != null ? ` · 스캔 ${r.scanned}` : ''} · {when}</span>;
  };
  const intervalH = st.intervalMs != null ? Math.round(st.intervalMs / 3600000 * 10) / 10 : null;
  // 주기 설정(시간) — 저장 시 즉시 재적용(0=주기 끔, 수동 스캔만). 스캔 중지 버튼과 함께 헤더에 배치.
  const [ivEdit, setIvEdit] = useState(null); // null=보기 모드, 문자열=편집 중 값
  const [ivMsg, setIvMsg] = useState(null);
  const saveInterval = async () => {
    const hours = Number(ivEdit);
    if (!Number.isFinite(hours) || hours < 0) { setIvMsg('0 이상 숫자(시간)를 입력하세요.'); return; }
    try {
      const r = await putJson('/admin/idrac/scan-ranges/interval', { hours });
      // 서버가 하한(10분) 등으로 클램프할 수 있으므로 실제 적용된 값으로 안내한다.
      const appliedH = Number.isFinite(r?.intervalMs) ? Math.round(r.intervalMs / 3600000 * 10) / 10 : hours;
      setIvMsg(appliedH === 0 ? '주기 스캔을 껐습니다(수동만).' : `주기 ${appliedH}시간으로 저장됨${appliedH !== hours ? ` (입력 ${hours} → 하한/상한 적용)` : ''}`);
      setIvEdit(null);
      onReload?.(); // 버튼 라벨('주기 N시간')을 즉시 갱신 — 폴링 전까지 이전 값이 남아 저장 실패로 오인 방지
      setTimeout(() => setIvMsg(null), 4000);
    }
    catch (e) { setIvMsg(e.message); }
  };
  const stopScan = async () => {
    try {
      const r = await postJson('/admin/idrac/scan-ranges/stop', {});
      setIvMsg(`중지 요청됨 — 중앙 스캔 ${r.stoppingCentral ? '중단' : '없음'} · 대기 위임 잡 ${r.canceledJobs}건 취소(진행 중 위임 잡은 원격 중지 불가)`);
      setTimeout(() => setIvMsg(null), 6000);
    } catch (e) { setIvMsg(e.message); }
  };

  return (
    <div className="card" style={{ marginBottom: 12, padding: '12px 16px', borderLeft: '3px solid var(--accent, #60a5fa)' }}>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 8 }}>
        <b style={{ fontSize: 13 }}>법인별 iDRAC 장비 스캔</b>
        <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="muted" style={{ fontSize: 12 }}>
            활성 {st.enabledDatacenters ?? 0} 법인 · 대역 {st.totalRanges ?? 0}개
            {st.running && <span style={{ color: 'var(--amber)' }}> · 스캔 중…</span>}
          </span>
          {/* 주기 표시/설정 — 클릭해 편집, 시간 단위(0=끔) */}
          {ivEdit === null ? (
            <button className="tab" style={{ padding: '5px 10px', fontSize: 12 }} title="클릭하여 주기 변경(시간 단위, 0=주기 끔)"
              onClick={() => setIvEdit(String(intervalH ?? 6))}>
              주기 {intervalH === 0 ? '끔(수동만)' : `${intervalH}시간`} ✎
            </button>
          ) : (
            <span className="flex gap" style={{ alignItems: 'center' }}>
              <input className="input" type="number" min={0} max={720} step={0.5} value={ivEdit} onChange={(e) => setIvEdit(e.target.value)} style={{ width: 76, padding: '5px 8px', fontSize: 12 }} />
              <span className="muted" style={{ fontSize: 12 }}>시간</span>
              <button className="login-btn" style={{ flex: 'none', padding: '5px 12px', fontSize: 12 }} onClick={saveInterval}>저장</button>
              <button className="logout-btn" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => setIvEdit(null)}>취소</button>
            </span>
          )}
          <button className="logout-btn" style={{ padding: '8px 12px' }} disabled={busy || st.running} onClick={() => onScan()} title="활성화된 모든 법인 대역을 지금 스캔(백그라운드)">⚡ 지금 스캔(전체)</button>
          <button className="logout-btn" style={{ padding: '8px 12px', color: 'var(--red)' }} disabled={busy} onClick={stopScan}
            title="진행 중인 중앙 스캔을 중단하고, 대기 중인 위임 잡을 취소합니다(진행 중 위임 잡은 원격 중지 불가)">⏹ 스캔 중지</button>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 14px' }} disabled={busy} onClick={onNew}>+ 대역 추가</button>
        </div>
      </div>
      {ivMsg && <div className="muted" style={{ fontSize: 12, marginBottom: 6, color: '#93c5fd' }}>{ivMsg}</div>}

      <div className="muted" style={{ fontSize: 12, lineHeight: 1.7, marginBottom: 8 }}>
        <b>법인(DataCenter)별</b>로 iDRAC IP 대역과 계정을 저장하면, 주기 스캐너가 각 대역의 Redfish에 접속해 <b>Dell iDRAC만 골라</b>
        해당 <b>법인 DB로 자동 등록</b>합니다(vCenter와 독립). 형식: CIDR(10.0.0.0/24)·범위(10.0.0.1-50)·단일 IP, 한 줄에 하나.
        등록 모드는 기본 <b>병합</b>(기존 유지+추가/갱신)이며, 스캔이 일시적으로 0건이면 기존 등록을 지우지 않습니다.
        중앙이 못 닿는 사설망은 <b>스캔 수행 Agent</b>를 지정해 현장 에이전트가 대행합니다.
        {datacenters.length === 0 && <span style={{ color: 'var(--amber)' }}> · ⚠ 먼저 <b>설정 › DataCenter(법인)</b>에서 법인을 1개 이상 정의하세요.</span>}
      </div>

      {st.running && prog && (
        <div style={{ marginBottom: 8 }}>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 3 }}>
            스캔 진행: {dcName(prog.datacenterId)} ({(prog.idx ?? 0) + 1}/{prog.totalDatacenters})
            {prog.total ? ` — ${prog.done}/${prog.total} (${prog.pct ?? 0}%)` : ''}
            {prog.foundSoFar != null && ` · 누적 발견 ${prog.foundSoFar}`}
          </div>
          <div style={{ height: 6, borderRadius: 4, background: 'rgba(148,163,184,.2)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${prog.pct ?? 0}%`, background: 'var(--accent, #60a5fa)', transition: 'width .3s' }} />
          </div>
        </div>
      )}

      {form && (
        <div className="card" style={{ marginBottom: 10, padding: '12px 14px', background: 'rgba(96,165,250,.06)' }}>
          <div className="flex between" style={{ alignItems: 'center', marginBottom: 8 }}>
            <b style={{ fontSize: 13 }}>{form.isNew ? '스캔 대역 추가' : `스캔 대역 수정 — ${dcName(form.datacenterId)}`}</b>
            <button className="logout-btn" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => { setMsg && setMsg(null); setForm(null); }}>닫기</button>
          </div>
          <div className="flex gap wrap" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 220px', minWidth: 200 }}>
              <label className="muted" style={{ fontSize: 11.5 }}>법인(DataCenter) *</label>
              <select className="input" style={{ width: '100%', padding: '8px 10px' }} value={form.datacenterId}
                disabled={!form.isNew}
                onChange={(e) => setForm({ ...form, datacenterId: e.target.value })}>
                <option value="">(선택)</option>
                {datacenters.map((d) => <option key={d.id} value={d.id}>{d.name || d.id}{d.region ? ` · ${d.region}` : ''}</option>)}
              </select>
            </div>
            <div style={{ flex: '2 1 320px', minWidth: 260 }}>
              <label className="muted" style={{ fontSize: 11.5 }}>IP 대역 (한 줄에 하나) *</label>
              <textarea value={form.ranges} onChange={(e) => setForm({ ...form, ranges: e.target.value })}
                placeholder={'10.0.0.0/24\n10.0.1.1-10.0.1.50\n10.0.2.10'}
                style={{ width: '100%', minHeight: 84, padding: '8px 10px', fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }} />
            </div>
          </div>
          <div className="flex gap wrap" style={{ alignItems: 'flex-end', marginTop: 8 }}>
            <div style={{ flex: '1 1 150px' }}>
              <label className="muted" style={{ fontSize: 11.5 }}>iDRAC 계정 *</label>
              <input className="input" style={{ width: '100%', padding: '8px 10px' }} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="root" />
            </div>
            <div style={{ flex: '1 1 150px' }}>
              <label className="muted" style={{ fontSize: 11.5 }}>iDRAC 비밀번호 {form.hasPassword ? '(저장됨, 변경 시만 입력)' : '*'}</label>
              <div style={{ position: 'relative' }}>
                {/* 특수문자·공백 포함 비밀번호를 온전히 보존한다: 함수형 setState로 빠른 입력/조합 시 문자 유실 방지,
                    SHOW 토글로 마스킹된 특수문자를 눈으로 확인(입력이 안 된 것처럼 보이는 문제 해소). */}
                <input className="input" type={showPw ? 'text' : 'password'} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  style={{ width: '100%', padding: '8px 44px 8px 10px' }} value={form.password}
                  onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, password: v })); }}
                  placeholder={form.hasPassword ? '•••• (유지)' : ''} />
                <button type="button" onClick={() => setShowPw((v) => !v)} title={showPw ? '가리기' : '표시'}
                  style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, letterSpacing: '.05em', color: 'var(--muted, #94a3b8)', padding: '2px 4px' }}>
                  {showPw ? '가림' : '표시'}
                </button>
              </div>
            </div>
            <div style={{ flex: '1 1 160px' }}>
              <label className="muted" style={{ fontSize: 11.5 }}>스캔 수행 Agent</label>
              <select className="input" style={{ width: '100%', padding: '8px 10px' }} value={form.agent} onChange={(e) => setForm({ ...form, agent: e.target.value })}>
                <option value="__local__">이 포탈에서 직접</option>
                {(agents?.agents || []).map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div style={{ flex: '1 1 140px' }}>
              <label className="muted" style={{ fontSize: 11.5 }}>등록 모드</label>
              <select className="input" style={{ width: '100%', padding: '8px 10px' }} value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
                <option value="merge">병합(추가/갱신)</option>
                <option value="replace-datacenter">이 법인만 교체</option>
              </select>
            </div>
            <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12, padding: '8px 0' }} title="체크 시 주기 스캔에 포함">
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 주기 스캔 포함
            </label>
            <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={busy} onClick={onSave}>{busy ? '저장 중…' : '저장'}</button>
          </div>
          {msg && (
            <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, fontSize: 12.5,
              background: msg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
              color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.ok ? '✅ ' : '⚠ '}{msg.text}</div>
          )}
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead><tr>
            <Th k="name">법인(DataCenter)</Th><Th k="ranges">대역</Th><Th k="username">계정</Th><Th k="agent">스캔 주체</Th><Th k="enabled">주기</Th><Th k="lastRun">최근 결과</Th><th className="right">작업</th>
          </tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={7} className="center muted" style={{ padding: 24 }}>저장된 스캔 대역이 없습니다. “+ 대역 추가”로 등록하세요.</td></tr>}
            {list.map((e) => (
              <tr key={e.datacenterId} style={{ opacity: e.enabled ? 1 : 0.55 }}>
                <td><b>{dcName(e.datacenterId)}</b>{dcName(e.datacenterId) !== e.datacenterId && <span className="muted" style={{ fontSize: 11 }}> ({e.datacenterId})</span>}</td>
                <td className="muted" title={(e.ranges || []).join('\n')}>{(e.ranges || []).length}개</td>
                <td className="muted">{e.username || '—'}{e.hasPassword ? '' : <span style={{ color: 'var(--amber)' }} title="비밀번호 미설정 — 스캔 불가"> ⚠</span>}</td>
                <td>{e.agent ? <span className="badge" style={{ background: 'rgba(167,139,250,.2)', color: '#a78bfa' }}>{e.agent}</span> : <span className="muted">직접</span>}</td>
                <td>{e.enabled ? <span className="badge green">포함</span> : <span className="badge gray">제외</span>}</td>
                <td style={{ fontSize: 12 }}>{fmtRun(e.lastRun)}</td>
                <td className="right">
                  <button className="logout-btn" style={{ padding: '5px 9px', fontSize: 12 }} disabled={busy || st.running} onClick={() => onScan(e.datacenterId)} title="이 대역만 지금 스캔">스캔</button>
                  {' '}<button className="logout-btn" style={{ padding: '5px 9px', fontSize: 12 }} disabled={busy} onClick={() => onEdit(e)}>수정</button>
                  {' '}<button className="logout-btn" style={{ padding: '5px 9px', fontSize: 12, color: 'var(--red)' }} disabled={busy} onClick={() => onDelete(e.datacenterId)}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {st.lastRun && !st.running && (
        <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
          최근 전체 스캔: {st.lastRun.at ? new Date(st.lastRun.at).toLocaleString('ko-KR') : ''}
          {st.lastRun.vcenters != null && ` — ${st.lastRun.vcenters} vCenter · 발견 ${st.lastRun.found ?? 0} · 등록 ${st.lastRun.registered ?? 0}${st.lastRun.delegated ? ` · 위임 ${st.lastRun.delegated}` : ''}`}
          {st.lastRun.errors?.length ? <span style={{ color: '#f87171' }}> · 오류 {st.lastRun.errors.length}건</span> : ''}
          {st.lastRun.skipped && ` — ${st.lastRun.skipped}`}
        </div>
      )}
    </div>
  );
}

