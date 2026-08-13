// IdracAdmin.jsx — iDRAC 서버 등록/스캔 관리 뷰(설정 › iDRAC 서버 등록).
//
// v2.292 구조 정리(모듈화 감사 1순위 — 구 1,309줄 → 셸 ~190줄 + views/idrac/ 4파일):
// 1) 죽은 코드 ~250줄 제거: v2.69.1(6407ab3 '스캔 중심으로 단순화')에서 렌더 JSX 만 지우고
//    핸들러·상태가 남아 있던 레거시(단건 등록 openAdd/save/test/remove, CSV/JSON 가져오기,
//    IP 일괄 등록·스캔 모달 플로우 scanIdracs/registerScanned/submitBulk, 소속 일괄지정/삭제,
//    수동 폴 pollNow, 전력 정리 purgeStale + 관련 상태 18개·ref 3개·effect 2개). 렌더(아래
//    return)와 살아있는 핸들러 어디서도 참조하지 않음을 감사(1·2차)와 grep 으로 확인했다.
//    ⚠ 해당 기능이 필요하면 git 이력(v2.291 이전 이 파일)에서 복원할 것 — 서버 API 는 남아 있다.
// 2) 컴포넌트 분리(순수 이동): IdracDetailModal(HardwareTools 전용 — 이 뷰는 렌더하지 않았음)·
//    ScanJobLogModal·IdracScanJobs·IdracScanRanges → ./idrac/*.jsx. IdracDetailModal 분리로
//    Settings·SpecialTools 청크가 이 뷰 모듈을 공유 의존하던 번들 결합도 함께 해소.
//
// ⚠ 유지 필수(감사 검증자가 지목한 과잉 삭제 함정): data/error/load 와 아래 조기 return 은
//    렌더에 data 가 직접 안 쓰여 죽은 코드처럼 보이지만, 마운트 fetch 1회 실패 시 화면 전체가
//    영구 Loading/ErrorBox 가 되는 것을 막는 로딩/오류 게이트다(주석 참조). 지우면 안 된다.
import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import { IdracScanJobs } from './idrac/IdracScanJobs.jsx';
import { IdracScanRanges } from './idrac/IdracScanRanges.jsx';

export default function IdracAdmin() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [importMsg, setImportMsg] = useState(null);
  const [agents, setAgents] = useState({ agents: [], centralEnabled: false });
  const [vcenters, setVcenters] = useState([]);           // vCenter 목록(소속 지정용)
  const [datacenters, setDatacenters] = useState([]);     // DataCenter(법인) 목록(스캔 소속 선택용)
  const [scanRanges, setScanRanges] = useState({ ranges: [], status: null, centralEnabled: false }); // vCenter별 iDRAC 스캔 대역
  const [srForm, setSrForm] = useState(null); // 스캔 대역 편집 폼 { vcenterId, ranges, username, password, agent, enabled, mode } | null
  const [srMsg, setSrMsg] = useState(null); // 스캔 대역 폼 인라인 피드백 { ok, text }
  const [scanJobs, setScanJobs] = useState({ status: null, jobs: [], collectors: [], centralEnabled: false }); // 스캔 현황(주기+위임 잡)

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

  // 스캔 잡이 진행 중(주기 스캐너 running 또는 위임 잡 pending/running)이면 5초마다 현황 갱신.
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

  // data(/admin/idrac)는 렌더에 직접 쓰이지 않지만, 이 fetch가 마운트 시 1회 실패하면 스캔
  // 현황 화면 전체가 영구 ErrorBox가 되던 문제 → 데이터 없을 때만 전체 오류(그 외엔 계속 표시).
  if (error && !data) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  // ── 법인(DataCenter)별 iDRAC 장비 스캔 ──────────────────────────
  const dcNameOf = (id) => (datacenters.find((d) => d.id === id)?.name || id || '');
  const srOpenNew = () => { setSrMsg(null); setSrForm({ id: '', datacenterId: '', service: '', ranges: '', username: 'root', password: '', agent: '__local__', dispatch: 'poll', enabled: true, mode: 'merge', isNew: true }); };
  const srEdit = (e) => { setSrMsg(null); setSrForm({ id: e.id || '', datacenterId: e.datacenterId, service: e.service || '', ranges: (e.ranges || []).join('\n'), username: e.username || 'root', password: '', agent: e.agent || '__local__', dispatch: e.dispatch === 'push' ? 'push' : 'poll', enabled: e.enabled !== false, mode: e.mode || 'merge', hasPassword: e.hasPassword, isNew: false }); };
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
      const body = { id: f.id || undefined, datacenterId: f.datacenterId, service: f.service || '', ranges: f.ranges, username: f.username, agent: f.agent === '__local__' ? '' : f.agent, dispatch: f.agent !== '__local__' ? (f.dispatch === 'push' ? 'push' : 'poll') : 'poll', enabled: f.enabled, mode: f.mode };
      if ((f.password || '') !== '') body.password = f.password; // 빈 비번은 서버가 기존 유지, 그 외엔 원본 그대로 전송
      const r = await putJson('/admin/idrac/scan-ranges', body);
      if (r.ok) {
        const note = noPw ? ' · ⚠ 비밀번호 미설정 — 스캔하려면 비밀번호를 입력하세요' : '';
        const text = `스캔 대역 저장됨 — ${f.datacenterId}${f.service ? `/${f.service}` : ''} (대역 ${(r.ranges || []).length}개${r.enabled ? ', 주기 스캔 포함' : ', 비활성'})${note}`;
        setImportMsg({ ok: true, text }); // 상단 배너에도 표시
        setSrForm(null); setSrMsg(null);
        await loadScanRanges();
      } else {
        setSrMsg({ ok: false, text: r.reason || '저장 실패' });
      }
    } catch (e) { setSrMsg({ ok: false, text: `저장 실패: ${e.message}` }); }
    finally { setBusy(false); }
  };
  const srDelete = async (e) => {
    const label = `${dcNameOf(e.datacenterId)}${e.service ? ` / ${e.service}` : ''}`;
    if (!window.confirm(`'${label}' iDRAC 스캔 대역을 삭제할까요? (등록된 서버는 그대로 유지됩니다)`)) return;
    setBusy(true); setImportMsg(null);
    try {
      const r = await delJson(`/admin/idrac/scan-ranges/${encodeURIComponent(e.id)}`);
      setImportMsg(r.ok ? { ok: true, text: `스캔 대역 삭제됨 — ${label}` } : { ok: false, text: r.reason });
      await loadScanRanges();
    } catch (err) { setImportMsg({ ok: false, text: err.message }); }
    finally { setBusy(false); }
  };
  // e: 엔트리 객체(단건 스캔) | { datacenterId } (법인 전체) | undefined (전체)
  const srScanNow = async (e) => {
    setBusy(true); setImportMsg(null);
    const body = e?.id ? { id: e.id } : e?.datacenterId ? { datacenterId: e.datacenterId } : {};
    const label = e?.id ? `${dcNameOf(e.datacenterId)}${e.service ? ` / ${e.service}` : ''}` : e?.datacenterId ? `${dcNameOf(e.datacenterId)} 법인 전체` : '전체 대역';
    try {
      const r = await postJson('/admin/idrac/scan-ranges/scan', body);
      setImportMsg(r.ok ? { ok: true, text: `${label} 스캔을 시작했습니다(백그라운드).` } : { ok: false, text: r.reason });
      if (r.status) setScanRanges((s) => ({ ...s, status: r.status }));
      await loadScanRanges(); await loadScanJobs();
    } catch (err) { setImportMsg({ ok: false, text: err.message }); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="section-title" style={{ margin: '6px 0' }}>iDRAC 서버 등록 — Dell 베어메탈/물리 서버 (관리자)</div>

      {/* 스캔/삭제 등 결과 배너 — 이전에는 setImportMsg만 하고 렌더 JSX가 없어
          "비밀번호 미설정"·"이미 스캔 중" 같은 실패가 화면에 안 나오고 무음이었다. */}
      {importMsg && (
        <div className="card" style={{ marginBottom: 10, padding: '9px 13px', fontSize: 13, color: importMsg.ok ? 'var(--green)' : 'var(--red)' }}>
          {importMsg.text}
        </div>
      )}

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
