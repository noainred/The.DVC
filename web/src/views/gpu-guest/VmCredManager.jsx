// gpu-guest/VmCredManager.jsx — GpuGuestSettings.jsx(구 891줄)에서 분리(v2.295, 1차 감사 확정 #8).
// 본문은 원본 288~669행 그대로(SortTh·TestResult 동봉 — VmCredManager 전용 소품이라 함께 이동).
// 분리 이유: 이 파일의 역대 기능 커밋 최다 지점(정렬 v2.168·IP지정 v2.166·pwless·로그콘솔 등) —
// 격리해 향후 수정 diff 를 절반 이하로. ⚠ bumpToAuto 조건·isPwless 3상태 판정은 동작이 미묘함
// (1차 감사 MEDIUM) — 수정 시 반드시 해당 주석을 먼저 읽을 것. 이동은 문자 단위 순수 이동.
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, putJson, postJson } from '../../api.js';
import { VmLink } from '../../components/ui.jsx';
import { fmtAgo } from './shared.jsx';

/** 클릭하면 정렬되는 테이블 헤더(오름/내림 토글 + 방향 화살표). */
function SortTh({ k, sort, onSort, children }) {
  const active = sort.key === k;
  return (
    <th style={{ textAlign: 'left', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
      onClick={() => onSort(k)} title="클릭하여 정렬(다시 클릭 시 방향 전환)">
      {children}<span style={{ marginLeft: 4, opacity: active ? 1 : 0.25, fontSize: 10 }}>{active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
    </th>
  );
}

/** VM별 계정 관리 — 법인 선택 → 패스쓰루 GPU VM 조회 → 공용/별도 선택 + 로그인/읽기 테스트(개별·일괄).
 * deployAgent 지정 시: 저장이 로컬이 아니라 '그 엣지 앞 배포 설정'으로 가고, 테스트는 비활성(중앙이
 * 원격 VM에 도달 못 하므로). VM 목록/저장 표시는 배포 설정 기준. */
export function VmCredManager({ vcs, vcenters, collectMethod, onSavedShared, deployAgent = '' }) {
  const [selVc, setSelVc] = useState('');
  const [rows, setRows] = useState(null);   // null=미조회, []=없음
  const [osFilter, setOsFilter] = useState('all'); // all | linux | windows
  const [powerFilter, setPowerFilter] = useState('all'); // all | on | off
  const [sort, setSort] = useState({ key: '', dir: 'asc' }); // 헤더 클릭 정렬(빈 key=원래 순서=이름)
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [testProg, setTestProg] = useState(null); // { done, total } 테스트 진행률(부분 갱신)
  const [selected, setSelected] = useState(() => new Set()); // 선택 테스트 대상 VM id
  const [testMethod, setTestMethod] = useState(''); // '' = 저장된 설정 방식 | guestops | ssh | auto
  const [revealCreds, setRevealCreds] = useState(false); // 디버그: 실행 로그에 실제 id/pw 평문
  const [logLines, setLogLines] = useState([]);   // 실행 로그 콘솔(명령/단계별)
  const [showLog, setShowLog] = useState(true);
  const logRef = useRef(null);
  const appendLog = (lines) => setLogLines((prev) => {
    const next = [...prev, ...lines];
    return next.length > 4000 ? next.slice(-4000) : next; // 상한(메모리 보호)
  });
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [logLines]);

  const loadVms = async (vcId) => {
    if (!vcId) { setRows(null); return; }
    setLoading(true); setMsg(null);
    try {
      const r = await fetchJson(`/admin/gpu-guest/vms?vcenterId=${encodeURIComponent(vcId)}${deployAgent ? `&agent=${encodeURIComponent(deployAgent)}` : ''}`);
      setRows((r.vms || []).map((v) => ({
        ...v,
        mode: v.hasOwnCred ? 'own' : 'shared',   // 'shared'=공용 | 'own'=별도
        username: v.ownUsername || '',
        password: '',
        hadOwn: !!v.hasOwnCred,
        pwless: v.ownPwless ? true : undefined,  // true/false=명시 · undefined=자동(별도+id만+비번빈칸+저장없음)
        ipOverride: v.ipOverride || '',          // SSH 접속 고정 IP('' = 자동/모든 IP)
        hadIp: !!v.ipOverride,
        test: null,                              // {login,read,error,sample} | {pending}
      })));
    } catch (e) { setMsg(`오류: ${e.message}`); setRows([]); }
    finally { setLoading(false); }
  };

  // passwordless = 비번 없는 계정(빈 비번 인증). 별도 + 계정명 입력 + 비번 빈칸일 때:
  //   명시 토글(pwless=true) 또는 저장된 비번이 없으면(신규) 자동 인식.
  const isPwless = (r) => {
    if (r.mode !== 'own' || !(r.username || '').trim() || r.password) return false;
    if (r.pwless === true) return true;
    if (r.pwless === false) return false;
    return !r.hadOwn; // 자동: 저장된 비번 없는 신규 별도 계정
  };

  const pickVc = (vcId) => { setSelVc(vcId); setRows(null); loadVms(vcId); };
  const setRow = (id, patch) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  // 배포 대상(로컬↔엣지)이 바뀌면 저장 표시 기준이 달라지므로 조회된 VM 목록을 다시 불러온다.
  useEffect(() => { if (selVc) loadVms(selVc); /* eslint-disable-next-line */ }, [deployAgent]);

  const runTest = async (subset) => {
    const targets = subset || rows;
    if (!targets || !targets.length) return;
    // 도달 불가/느린 VM이 전체를 막지 않도록 작은 청크로 나눠 순차 처리하고, 끝나는 대로 행을 즉시 갱신한다.
    // 청크당 1 요청이라 길이가 짧아 프록시 유휴 끊김도 방지되고, 진행률로 멈춘 듯 보이지 않게 한다.
    const CHUNK = 4; // 서버 동시성(기본 4)에 맞춤 — 청크당 대략 1 웨이브
    const nameOf = (id) => (rows.find((r) => r.id === id)?.name) || id;
    const fmtT = (t) => { const d = new Date(t); return d.toLocaleTimeString('ko-KR', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0'); };
    const ids = new Set(targets.map((t) => t.id));
    setRows((rs) => rs.map((r) => (ids.has(r.id) ? { ...r, test: { pending: true } } : r)));
    setLogLines([]); setShowLog(true);
    setTestProg({ done: 0, total: targets.length });
    const nChunks = Math.ceil(targets.length / CHUNK);
    let done = 0;
    for (let off = 0; off < targets.length; off += CHUNK) {
      const chunk = targets.slice(off, off + CHUNK);
      const ci = Math.floor(off / CHUNK) + 1;
      appendLog([{ t: Date.now(), line: `━━━ 묶음 ${ci}/${nChunks} 시작 — ${chunk.map((r) => r.name).join(', ')}` }]);
      const items = chunk.map((r) => ({ vmId: r.id, useShared: r.mode === 'shared', username: r.mode === 'own' ? r.username : '', password: r.mode === 'own' ? r.password : '', passwordless: isPwless(r), ip: r.ipOverride || '' }));
      try {
        const res = await postJson('/admin/gpu-guest/test', { vcenterId: selVc, items, ...(testMethod ? { method: testMethod } : {}), revealCreds });
        const byId = new Map((res.results || []).map((x) => [x.vmId, x]));
        setRows((rs) => rs.map((r) => (byId.has(r.id) ? { ...r, test: byId.get(r.id), _mock: res.mock } : r)));
        // 단계별 trace를 실행 로그에 누적(명령·다운로드·결과 등).
        const newLines = [];
        for (const x of res.results || []) {
          const nm = nameOf(x.vmId);
          for (const e of x.trace || []) newLines.push({ t: e.t, line: `${fmtT(e.t)} [${nm}] ${e.msg}` });
          const verdict = x.login && x.read ? '✅ 수집 준비 완료' : x.login ? `⚠ 로그인 OK / 읽기 실패 — ${x.error || ''}` : `❌ ${x.error || '실패'}`;
          newLines.push({ t: x.trace?.[x.trace.length - 1]?.t || Date.now(), line: `${fmtT(Date.now())} [${nm}] = ${verdict}` });
        }
        appendLog(newLines);
      } catch (e) {
        const cids = new Set(chunk.map((r) => r.id));
        setRows((rs) => rs.map((r) => (cids.has(r.id) ? { ...r, test: { error: e.message } } : r)));
        appendLog([{ t: Date.now(), line: `${fmtT(Date.now())} ✗ 묶음 ${ci} 요청 실패: ${e.message}` }]);
      }
      done += chunk.length;
      setTestProg({ done, total: targets.length });
    }
    appendLog([{ t: Date.now(), line: `━━━ 전체 완료 (${targets.length}대)` }]);
    setTestProg(null);
  };

  const saveCreds = async () => {
    if (!rows) return;
    setBusy(true); setMsg(null);
    try {
      const vms = {};
      const vmIps = {}; // VM별 SSH 고정 IP(자격증명과 독립 — 공용 계정 VM도 지정 가능)
      for (const r of rows) {
        if (r.mode === 'own') {
          if (r.username) {
            vms[r.id] = isPwless(r)
              ? { username: r.username, passwordless: true }   // 비번없음 계정으로 저장
              : { username: r.username, ...(r.password ? { password: r.password } : {}) };
          }
        } else if (r.hadOwn) {
          vms[r.id] = null; // 공용으로 전환 → override 제거
        }
        // IP 고정: 지정됐거나(저장), 지웠으면(빈 값으로 삭제). 변경 없는 행은 전송 생략.
        if (r.ipOverride) vmIps[r.id] = r.ipOverride;
        else if (r.hadIp) vmIps[r.id] = '';
      }
      // SSH/auto로 테스트해 성공했는데 실제 수집 방식이 'VMware Tools만(guestops)'이면, 폴러는
      // SSH를 절대 시도하지 않아 "테스트는 되는데 수집은 안 됨"이 된다. 이때 수집 방식을 'auto'로
      // 올려 SSH 폴백을 켠다(게스트작업이 잘 되는 VM은 그대로, 막힌 VM만 SSH). 'ssh'로 강제하면
      // 게스트작업으로 잘 수집되던 VM이 끊길 수 있어 안전한 'auto'를 쓴다.
      const bumpToAuto = !deployAgent && (testMethod === 'ssh' || testMethod === 'auto') && collectMethod === 'guestops';
      const url = deployAgent ? `/admin/gpu-guest/deploy/${encodeURIComponent(deployAgent)}` : '/admin/gpu-guest/settings';
      await putJson(url, {
        vcenters: { [selVc]: { vms, vmIps } },
        ...(bumpToAuto ? { collectMethod: 'auto' } : {}),
      });
      setMsg(deployAgent
        ? `원격 엣지 [${deployAgent}]로 VM별 계정/IP 배포 저장됨 — 엣지가 다음 pull 주기에 가져가 적용합니다.`
        : (bumpToAuto
          ? "VM별 계정 저장 완료 — 수집 방식이 'VMware Tools만'이라 SSH 수집이 안 되던 걸 'auto(자동 폴백)'로 바꿔 켰습니다. 다음 주기부터 SSH로 수집됩니다."
          : 'VM별 계정을 저장했습니다. (수집 방식이 SSH/auto인지 위 설정에서 확인하세요)'));
      if (bumpToAuto) onSavedShared?.();
      await loadVms(selVc);
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };

  const vcShared = vcenters[selVc] || {};
  const isWin = (r) => /windows/i.test(r.guestOS || '');
  const isOn = (r) => r.powerState === 'POWERED_ON';
  // 헤더 클릭 정렬: 열별 정렬 키 추출값. 문자열은 소문자, 상태/수집은 숫자 순위.
  const sortVal = (r, key) => {
    switch (key) {
      case 'name': return String(r.name || '').toLowerCase();
      case 'host': return String(r.host || '').toLowerCase();
      case 'state': return (isOn(r) ? 0 : 1) * 10 + (r.toolsStatus === 'RUNNING' ? 0 : 1); // On·ToolsOK 먼저
      case 'collected': return r.collected && r.collected.utilPct != null ? r.collected.utilPct : -1; // 미수집=-1(끝)
      case 'mode': return String(r.mode || '');       // own/shared
      case 'ip': return String(r.ipOverride || '');    // 지정 IP(빈값=자동)
      default: return '';
    }
  };
  const toggleSort = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  let shown = rows ? rows.filter((r) =>
    (osFilter === 'all' ? true : osFilter === 'windows' ? isWin(r) : !isWin(r))
    && (powerFilter === 'all' ? true : powerFilter === 'on' ? isOn(r) : !isOn(r)),
  ) : rows;
  if (shown && sort.key) {
    const dir = sort.dir === 'desc' ? -1 : 1;
    shown = [...shown].sort((a, b) => {
      const av = sortVal(a, sort.key), bv = sortVal(b, sort.key);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return String(a.name || '').localeCompare(String(b.name || '')); // 동률은 이름순(안정)
    });
  }
  const ownCount = shown ? shown.filter((r) => r.mode === 'own').length : 0;
  const onCount = rows ? rows.filter(isOn).length : 0;

  return (
    <div className="card" style={{ padding: 16, marginTop: 14 }}>
      <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 8, gap: 8 }}>
        <b>VM별 계정 (계정이 VM마다 다를 때)</b>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <select className="select" value={osFilter} onChange={(e) => setOsFilter(e.target.value)} style={{ minWidth: 110 }} title="OS별로 구분해 보기">
            <option value="all">전체 OS</option>
            <option value="linux">🐧 Linux</option>
            <option value="windows">🪟 Windows</option>
          </select>
          <select className="select" value={powerFilter} onChange={(e) => setPowerFilter(e.target.value)} style={{ minWidth: 120 }} title="전원 상태로 구분해 보기 — 꺼진 VM은 수집 대상이 아닙니다.">
            <option value="all">전체 전원</option>
            <option value="on">🟢 켜짐</option>
            <option value="off">⚫ 꺼짐</option>
          </select>
          <select className="select" value={selVc} onChange={(e) => pickVc(e.target.value)} style={{ minWidth: 200 }}>
            <option value="">법인(vCenter) 선택…</option>
            {vcs.map((vc) => <option key={vc.id} value={vc.id}>{vc.name || vc.id}</option>)}
          </select>
          <button className="logout-btn" style={{ padding: '7px 12px' }} disabled={!selVc || loading} onClick={() => loadVms(selVc)}>{loading ? '조회 중…' : '↻ VM 조회'}</button>
        </div>
      </div>

      {!selVc && <div className="muted" style={{ fontSize: 13 }}>법인을 선택하면 그 법인에서 <b>GPU(패스쓰루·vGPU)</b>를 쓰는 VM 목록을 불러옵니다.</div>}
      {selVc && rows && rows.length === 0 && !loading && <div className="muted" style={{ fontSize: 13 }}>이 법인에 GPU 할당 VM이 없습니다.</div>}

      {selVc && rows && rows.length > 0 && (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            공용 계정 — 🐧Linux <b>{vcShared.username || '(미설정)'}</b>{vcShared.hasPassword ? '·비번O' : ''} · 🪟Windows <b>{vcShared.winUsername || '(Linux로 폴백)'}</b>{vcShared.hasWinPassword ? '·비번O' : ''} · {(osFilter === 'all' && powerFilter === 'all') ? `VM ${rows.length}개` : `표시 ${shown.length}/${rows.length}개`} · 🟢켜짐 {onCount} · ⚫꺼짐 {rows.length - onCount} · 별도 계정 {ownCount}개
          </div>
          <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
            <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
              <thead><tr>
                <th style={{ textAlign: 'center', width: 28 }}>
                  <input type="checkbox" title="표시된 VM 전체 선택/해제"
                    checked={shown.length > 0 && shown.every((r) => selected.has(r.id))}
                    onChange={(e) => setSelected(() => (e.target.checked ? new Set(shown.map((r) => r.id)) : new Set()))} />
                </th>
                <SortTh k="name" sort={sort} onSort={toggleSort}>VM</SortTh>
                <SortTh k="host" sort={sort} onSort={toggleSort}>호스트</SortTh>
                <SortTh k="state" sort={sort} onSort={toggleSort}>상태</SortTh>
                <SortTh k="collected" sort={sort} onSort={toggleSort}>수집(읽기)</SortTh>
                <SortTh k="mode" sort={sort} onSort={toggleSort}>계정 방식</SortTh>
                <th style={{ textAlign: 'left' }}>계정 / 비밀번호</th>
                <SortTh k="ip" sort={sort} onSort={toggleSort}>SSH 접속 IP</SortTh>
                <th style={{ textAlign: 'left' }}>테스트</th>
              </tr></thead>
              <tbody>
                {shown.length === 0 && <tr><td colSpan={9} className="muted" style={{ padding: 14, textAlign: 'center' }}>해당 OS({osFilter})의 VM이 없습니다.</td></tr>}
                {shown.map((r) => {
                  const ready = r.powerState === 'POWERED_ON' && r.toolsStatus === 'RUNNING';
                  return (
                    <tr key={r.id} style={selected.has(r.id) ? { background: 'rgba(34,211,238,.06)' } : undefined}>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={selected.has(r.id)}
                          onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })} />
                      </td>
                      <td><VmLink name={r.name} vcenterId={selVc} label={r.name} item={r} /><div className="muted" style={{ fontSize: 11 }}>{r.guestOS || ''}</div></td>
                      <td className="muted" style={{ fontSize: 12, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.host}>{r.host}</td>
                      <td style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                        <span className={`badge ${r.powerState === 'POWERED_ON' ? 'green' : 'gray'}`}>{r.powerState === 'POWERED_ON' ? 'On' : 'Off'}</span>{' '}
                        <span className={`badge ${r.toolsStatus === 'RUNNING' ? 'green' : 'amber'}`}>Tools {r.toolsStatus === 'RUNNING' ? 'OK' : (r.toolsStatus || '—')}</span>
                      </td>
                      <td style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                        {r.collected
                          ? <span className="badge green" title={`마지막 수집 ${fmtAgo(r.collected.at)}`}>● {r.collected.utilPct}% <span style={{ opacity: 0.7 }}>{fmtAgo(r.collected.at)}</span></span>
                          : <span className="badge gray" title="아직 게스트에서 사용률을 읽어오지 못함">미수집</span>}
                      </td>
                      <td>
                        <select className="select" value={r.mode} onChange={(e) => setRow(r.id, { mode: e.target.value })} style={{ width: 84 }}>
                          <option value="shared">공용</option>
                          <option value="own">별도</option>
                        </select>
                      </td>
                      <td>
                        {r.mode === 'own' ? (
                          <div className="flex gap" style={{ gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                            <input className="input" style={{ width: 104 }} placeholder="계정(root 등)" value={r.username} onChange={(e) => setRow(r.id, { username: e.target.value })} />
                            <input className="input" type="password" style={{ width: 120 }} disabled={isPwless(r)}
                              placeholder={isPwless(r) ? '비번없음' : (r.hadOwn ? '저장됨 · 변경시 입력' : '비밀번호 (비우면 비번없음)')}
                              title={r.hadOwn ? '저장된 비밀번호가 있습니다. 새 비밀번호로 테스트/저장하려면 여기에 입력하세요(비워두면 저장된 값 사용).' : '이 VM 계정의 비밀번호(비우면 passwordless로 인증)'}
                              value={isPwless(r) ? '' : r.password} onChange={(e) => setRow(r.id, { password: e.target.value })} />
                            <label className="flex gap" style={{ alignItems: 'center', fontSize: 11, whiteSpace: 'nowrap' }}
                              title="비번 없는 계정(빈 비밀번호로 인증). 저장된 비번으로 폴백하지 않습니다.">
                              <input type="checkbox" checked={isPwless(r)} onChange={(e) => setRow(r.id, { pwless: e.target.checked, ...(e.target.checked ? { password: '' } : {}) })} />
                              <span style={{ color: isPwless(r) ? 'var(--accent-2,#22d3ee)' : 'var(--muted,#8b9bb4)' }}>🔓 비번없음</span>
                            </label>
                          </div>
                        ) : <span className="muted" style={{ fontSize: 12 }}>공용 계정</span>}
                      </td>
                      <td>
                        {(r.ipAddresses || []).length > 0 ? (
                          <select className="select" style={{ width: 148 }} value={r.ipOverride || ''}
                            onChange={(e) => setRow(r.id, { ipOverride: e.target.value })}
                            title="SSH 접속에 사용할 IP를 고정합니다. 다중 NIC VM에서 도달 가능한 IP를 직접 지정하세요. '자동'이면 보고된 모든 IP를 순차 시도합니다.">
                            <option value="">자동(모든 IP)</option>
                            {(r.ipAddresses || []).map((ip) => <option key={ip} value={ip}>{ip}</option>)}
                            {r.ipOverride && !(r.ipAddresses || []).includes(r.ipOverride) && <option value={r.ipOverride}>{r.ipOverride} (미보고)</option>}
                          </select>
                        ) : <span className="muted" style={{ fontSize: 11 }} title="VMware Tools가 IP를 보고하지 않아 선택할 IP가 없습니다.">IP 없음</span>}
                      </td>
                      <td>
                        <div className="flex gap" style={{ alignItems: 'center', gap: 6 }}>
                          <button className="tab" style={{ padding: '4px 8px' }} disabled={!ready || !!deployAgent} title={deployAgent ? '원격 엣지 배포 모드 — 테스트는 엣지에서 수행됩니다(중앙은 원격 VM에 도달 못 함)' : (ready ? '' : '전원 On + Tools RUNNING 필요')} onClick={() => runTest([r])}>테스트</button>
                          <TestResult t={r.test} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex gap wrap" style={{ alignItems: 'center', marginTop: 12 }}>
            <button className="login-btn" style={{ flex: 'none', padding: '8px 14px' }} disabled={!!testProg || selected.size === 0 || !!deployAgent}
              title={deployAgent ? '원격 엣지 배포 모드 — 테스트는 엣지에서 수행됩니다' : (selected.size === 0 ? '체크박스로 VM을 선택하세요' : `선택한 ${selected.size}대만 테스트`)}
              onClick={() => runTest(rows.filter((r) => selected.has(r.id)))}>✅ 선택 테스트 ({selected.size})</button>
            <button className="logout-btn" style={{ padding: '8px 14px' }} disabled={!!testProg || !!deployAgent} title={deployAgent ? '원격 엣지 배포 모드 — 테스트는 엣지에서 수행됩니다' : ''} onClick={() => runTest(shown)}>⚡ {osFilter === 'all' ? '모두' : osFilter} 테스트</button>
            {selected.size > 0 && <button className="tab" style={{ padding: '6px 10px', fontSize: 12 }} onClick={() => setSelected(new Set())}>선택 해제</button>}
            <label className="flex gap" style={{ alignItems: 'center', fontSize: 12 }} title="테스트 수집 방식. SSH=게스트 IP로 직접 접속해 nvidia-smi(VMware Tools 게스트작업 인증이 막힐 때). auto=SSH 우선 실패 시 게스트작업.">
              <span className="muted">방식</span>
              <select className="select" style={{ width: 120 }} value={testMethod} onChange={(e) => setTestMethod(e.target.value)}>
                <option value="">설정값</option>
                <option value="auto">auto(자동 폴백)</option>
                <option value="guestops">VMware Tools</option>
                <option value="ssh">SSH 직접</option>
              </select>
            </label>
            <label className="flex gap" style={{ alignItems: 'center', fontSize: 12 }} title="실행 로그에 실제 전송되는 ID/비밀번호를 평문으로 표시(디버그). 이 응답에만 보이고 디스크/중앙에는 기록되지 않습니다.">
              <input type="checkbox" checked={revealCreds} onChange={(e) => setRevealCreds(e.target.checked)} /> 🔓 자격증명 평문(디버그)
            </label>
            <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy} onClick={saveCreds}>{busy ? '저장 중…' : 'VM별 계정 저장'}</button>
            {testProg && (
              <span className="badge teal" style={{ fontSize: 12 }}>
                테스트 중 {testProg.done}/{testProg.total} ({testProg.total ? Math.round((testProg.done / testProg.total) * 100) : 0}%) — 끝나는 대로 표시됩니다
              </span>
            )}
            {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            도달 불가/느린 VM은 한 대당 수십 초가 걸릴 수 있어, 작은 묶음으로 나눠 끝나는 대로 행을 갱신합니다(전체가 멈추지 않음). 한 대만 빠르게 보려면 행의 “테스트”를 누르세요.
          </div>

          {logLines.length > 0 && (
            <div className="card" style={{ marginTop: 12, padding: 0, overflow: 'hidden' }}>
              <div className="flex between" style={{ alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid rgba(36,48,73,.6)' }}>
                <b style={{ fontSize: 13 }}>🖥 실행 로그 <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>({logLines.length}줄 · 게스트 작업 명령/단계)</span></b>
                <div className="flex gap" style={{ alignItems: 'center' }}>
                  <button className="tab" style={{ padding: '4px 10px', fontSize: 12 }}
                    onClick={() => navigator.clipboard?.writeText(logLines.map((l) => l.line).join('\n')).catch(() => {})}>복사</button>
                  <button className="tab" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setLogLines([])}>지우기</button>
                  <button className="tab" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setShowLog((v) => !v)}>{showLog ? '접기' : '펼치기'}</button>
                </div>
              </div>
              {showLog && (
                <pre ref={logRef} style={{
                  margin: 0, padding: '10px 12px', maxHeight: 320, overflow: 'auto',
                  fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12, lineHeight: 1.55,
                  background: '#0a0f1a', color: '#cbd5e1', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                }}>
                  {logLines.map((l, i) => {
                    const ok = /✓|✅|성공|준비 완료/.test(l.line);
                    const bad = /✗|❌|실패|타임아웃|오류|건너뜀/.test(l.line);
                    const hdr = l.line.startsWith('━━━');
                    const color = hdr ? '#7dd3fc' : ok ? '#86efac' : bad ? '#fca5a5' : l.line.includes('명령:') ? '#fcd34d' : '#cbd5e1';
                    return <div key={i} style={{ color, fontWeight: hdr || l.line.includes('명령:') ? 600 : 400 }}>{l.line}</div>;
                  })}
                </pre>
              )}
            </div>
          )}
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            ※ <b>로그인</b>=게스트 계정 인증(명령 실행 안 함) · <b>읽기</b>=nvidia-smi로 GPU 사용률 실제 수집. 둘 다 ✅면 수집 준비 완료입니다.
            전원 Off/Tools 미동작 VM은 테스트 불가(수집 대상에서도 자동 제외).
          </div>
        </>
      )}
    </div>
  );
}

function TestResult({ t }) {
  if (!t) return <span className="muted" style={{ fontSize: 12 }}>—</span>;
  if (t.pending) return <span className="muted" style={{ fontSize: 12 }}>테스트 중…</span>;
  if (t.error && !t.login) return <span className="badge red" title={t.error} style={{ fontSize: 11 }}>실패: {t.error}</span>;
  return (
    <span className="flex gap" style={{ alignItems: 'center', gap: 4, fontSize: 11 }}>
      <span className={`badge ${t.login ? 'green' : 'red'}`}>로그인 {t.login ? '✓' : '✗'}</span>
      <span className={`badge ${t.read ? 'green' : (t.login ? 'amber' : 'gray')}`}>읽기 {t.read ? '✓' : '✗'}</span>
      {t.sample && <span className="muted">{t.sample.utilNA ? 'N/A(MIG)' : `${t.sample.utilPct}%`} · {t.sample.gpus}GPU</span>}
      {!t.read && t.error && <span className="muted" title={t.error}>({t.error})</span>}
    </span>
  );
}
