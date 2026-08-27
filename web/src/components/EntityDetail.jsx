// EntityDetail.jsx — ui.jsx(구 633줄)에서 분리(v2.295). 본문은 원본 192~606행 그대로 이동.
//
// ⚠ 이 파일의 컴포넌트들(DRow·VmIpPing·HostVmsModal·DsBrowseSection·EntityDetail·VmLink)은
// 상호 재귀 클러스터다: VmLink → EntityDetail → HostVmsModal → VmLink (3자 순환 렌더).
// **절대 파일 단위로 더 쪼개지 말 것** — '컴포넌트당 1파일' 기계 분할은 즉시 순환 import 를
// 만든다(2차 감사 HIGH 리스크). 한 파일 안에서는 함수 호이스팅으로 안전하다.
//
// 분리 이유: 최근 기능 커밋(v2.240 상세 통일·v2.276 DS 브라우즈·v2.277 타임아웃·v2.281 서비스
// 태그)이 전부 이 클러스터에 집중되는데, 같은 파일이 Loading/ErrorBox(86개 파일 소비)의
// 수출원이라 기능 커밋마다 최다 소비 공유 파일이 diff 에 걸렸다 — 다중 세션 병합 충돌 표면 축소.
import React, { useState, useEffect } from 'react';
import HostPowerPanel from './HostPowerPanel.jsx';
import { VmMetricButton, HostMetricButton } from './VmMetrics.jsx';
import { VmConsoleButton } from './VmConsole.jsx';
import { VmRemoteButton } from './VmRemote.jsx';
import { VmReconfigButton } from './VmReconfig.jsx';
import { fetchJson, postJson } from '../api.js';
import { Modal } from './Modal.jsx';
import { GpuBadge, UsageCell, StateBadge, Loading, ErrorBox } from './primitives.jsx';

function DRow({ label, children, full = false, nowrap = false }) {
  return (
    <div className="flex between" style={{ padding: '8px 0', borderBottom: '1px solid rgba(36,48,73,.4)', gap: 16, gridColumn: full ? '1 / -1' : 'auto' }}>
      <span className="muted" style={{ whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ textAlign: 'right', wordBreak: nowrap ? 'keep-all' : 'break-all', whiteSpace: nowrap ? 'nowrap' : 'normal' }}>{children}</span>
    </div>
  );
}

const gb = (mb) => `${Math.round((mb || 0) / 1024).toLocaleString()} GB`;
const tb = (g) => (g >= 1024 ? `${(g / 1024).toFixed(1)} TB` : `${g} GB`);

// Backing-storage category badge for a datastore (로컬/SAN/NAS/vSAN/vVol).
const DS_KIND = { local: ['로컬 디스크', 'green'], san: ['SAN', 'blue'], nas: ['NAS', 'amber'], vsan: ['vSAN', 'purple'], vvol: ['vVol', 'amber'], other: ['기타', 'gray'] };
function dsStorageLabel(item) {
  const [label, cls] = DS_KIND[item.storageType] || DS_KIND.other;
  return <span className={`badge ${cls}`}>{label}{item.ssd ? ' · SSD' : ''}</span>;
}

/** Detail popup for a host / VM / datastore. */
/**
 * VM IP별 도달성(녹/적) — 중앙은 사설 IP에 직접 못 가므로 해당 vCenter 담당 에이전트가
 * ping을 대행한다. 마운트 시 ping 요청을 큐잉하고 결과를 주기적으로 폴링한다.
 */
// 색/설명 매핑: 엣지 에이전트가 사설 IP까지 ping을 대행하므로 그 결과로 도달성을 표시.
const PING_COLOR = { up: 'var(--green,#22c55e)', down: 'var(--red,#ef4444)', pending: '', unknown: '', error: 'var(--red,#ef4444)' };
const pingTip = (ip, r) => {
  if (r.state === 'up') return `${ip} — 엣지 에이전트에서 ping 응답함${r.rttMs != null ? ` (${r.rttMs}ms)` : ''} · 도달 가능`;
  if (r.state === 'down') return `${ip} — 이 vCenter 담당(중앙/엣지)에서 ping 무응답 · 도달 불가. 이 IP가 다른 망이면 그 망 엣지 포탈에서는 닿을 수 있습니다(한 곳이라도 응답하면 녹색 유지).`;
  if (r.state === 'error') return `${ip} — ping 확인 실패(${r.error || '에이전트 오류'})`;
  return `${ip} — ping 확인 중…(해당 vCenter 담당 엣지 에이전트가 대행)`;
};

export function VmIpPing({ vcenterId, ips }) {
  const [res, setRes] = useState({}); // ip -> { state, rttMs }
  const [run, setRun] = useState(0);
  const [denied, setDenied] = useState(false); // viewer 403 — 영구 '확인 중…' 대신 권한 안내
  useEffect(() => {
    if (!vcenterId || !ips.length) return;
    let alive = true;
    const qs = `vcenterId=${encodeURIComponent(vcenterId)}&ips=${encodeURIComponent(ips.join(','))}`;
    // ping 트리거는 admin/operator 전용 — viewer의 403은 '권한 필요' 상태로 종결해
    // 영구 '확인 중…' 점멸을 막는다(결과 폴링은 읽기라 계속 동작).
    postJson('/tools/ip-ping', { vcenterId, ips }).catch((e) => { if (/403|forbidden/i.test(String(e.message))) setDenied(true); });
    const poll = () => fetchJson(`/tools/ip-ping?${qs}`).then((d) => { if (alive) setRes(d.results || {}); }).catch(() => {});
    poll();
    const t = setInterval(poll, 3000);
    const stop = setTimeout(() => clearInterval(t), 33000); // ~30초 후 폴링 종료
    return () => { alive = false; clearInterval(t); clearTimeout(stop); };
  }, [vcenterId, ips.join(','), run]);
  const dot = (state) => {
    const c = state === 'up' ? 'var(--green,#22c55e)' : (state === 'down' || state === 'error') ? 'var(--red,#ef4444)' : '#9ca3af';
    return <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: c,
      boxShadow: state === 'up' ? '0 0 6px var(--green,#22c55e)' : 'none', marginRight: 6, flex: '0 0 auto',
      animation: state === 'pending' || state === 'unknown' ? 'pulse 1.2s infinite' : 'none' }} />;
  };
  if (denied) {
    return <span className="muted" style={{ fontSize: 12 }}>IP ping 확인은 operator/admin 권한이 필요합니다. IP: {ips.join(', ')}</span>;
  }
  // 정렬: 도달(up) → 확인중(pending/unknown) → 실패(error/down) 순, 같은 상태면 RTT 오름차순.
  const ORDER = { up: 0, pending: 1, unknown: 1, error: 2, down: 3 };
  const sorted = [...ips].sort((a, b) => {
    const ra = res[a] || { state: 'pending' }, rb = res[b] || { state: 'pending' };
    const d = (ORDER[ra.state] ?? 1) - (ORDER[rb.state] ?? 1);
    if (d) return d;
    return (ra.rttMs ?? 1e9) - (rb.rttMs ?? 1e9);
  });
  return (
    <>
      <div style={{ display: 'inline-grid', gridTemplateColumns: 'auto auto auto', columnGap: 8, rowGap: 3, alignItems: 'center' }}>
        {sorted.map((ip, i) => {
          const r = res[ip] || { state: 'pending' };
          const color = PING_COLOR[r.state] || '';
          const strong = r.state === 'up' || r.state === 'down';
          return (
            <React.Fragment key={i}>
              <span title={pingTip(ip, r)} style={{ display: 'inline-flex', cursor: 'help' }}>{dot(r.state)}</span>
              <span title={pingTip(ip, r)} style={{ fontFamily: 'ui-monospace, monospace', color: color || 'inherit', fontWeight: strong ? 600 : 400, cursor: 'help' }}>{ip}</span>
              <span style={{ fontSize: 11, textAlign: 'right', fontFamily: 'ui-monospace, monospace',
                color: r.state === 'down' ? 'var(--red,#ef4444)' : 'var(--text-dim,#9ca3af)' }}>
                {r.state === 'up' ? (r.rttMs != null ? `${r.rttMs}ms` : '응답') : r.state === 'down' ? '무응답' : r.state === 'error' ? '오류' : '확인 중…'}
              </span>
            </React.Fragment>
          );
        })}
      </div>
      <div><button className="tab" style={{ marginTop: 4, padding: '2px 8px', fontSize: 11 }} title="엣지 에이전트로 다시 ping" onClick={() => setRun((n) => n + 1)}>↻ ping 재시도</button></div>
    </>
  );
}

/**
 * 특정 ESXi 호스트에서 구동/등록된 VM 목록 모달.
 * 호스트 상세에서 호스트명을 클릭하면 열린다. VM 행 클릭 → VM 상세.
 */
export function HostVmsModal({ host, vcenterId, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  // 열 헤더 클릭 정렬(v2.372). 훅은 조기 return 위에 선언 — 뒤에 추가하면 렌더 간 훅 개수가
  // 달라져 React #310 으로 화면이 크래시한다(CLAUDE.md 프론트 회귀 방지).
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  useEffect(() => {
    const qs = new URLSearchParams({ host, ...(vcenterId ? { vcenterId } : {}), limit: '5000', sortBy: 'name', order: 'asc' }).toString();
    fetchJson(`/vms?${qs}`).then(setD).catch((e) => setErr(e.message));
  }, [host, vcenterId]);
  const all = d?.items || [];
  const ql = q.trim().toLowerCase();
  const filtered = ql ? all.filter((v) => [v.name, v.guestOS, v.ipAddress].some((x) => String(x || '').toLowerCase().includes(ql))) : all;
  const onN = all.filter((v) => v.powerState === 'POWERED_ON').length;
  const gbv = (mb) => (mb != null ? `${Math.round(mb / 1024)}GB` : '—');
  // 열별 정렬값 — 숫자 열은 숫자로(문자 비교하면 10 < 9), 없는 값(null)은 방향과 무관하게
  // 항상 뒤로 보낸다('—' 가 위로 몰려 실제 데이터를 가리는 것 방지).
  const firstIp = (v) => (v.ipAddresses?.length ? v.ipAddresses[0] : (v.ipAddress || ''));
  // IP 는 문자열 비교하면 10.93.124.9 > 10.93.124.10 이 되므로 옥텟을 정수로 접어 비교한다.
  const ipNum = (ip) => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
    if (!m) return null;
    return ((+m[1] * 256 + +m[2]) * 256 + +m[3]) * 256 + +m[4];
  };
  const SORT_VAL = {
    name: (v) => String(v.name || '').toLowerCase(),
    power: (v) => (v.powerState === 'POWERED_ON' ? 0 : 1),   // On 먼저
    guestOS: (v) => String(v.guestOS || '').toLowerCase(),
    cpu: (v) => (v.cpuCount != null ? Number(v.cpuCount) : null),
    ram: (v) => (v.memMB != null ? Number(v.memMB) : null),
    ip: (v) => ipNum(firstIp(v)),
  };
  const rows = React.useMemo(() => {
    const get = SORT_VAL[sort.key] || SORT_VAL.name;
    const sign = sort.dir === 'desc' ? -1 : 1;
    return [...filtered].sort((a, b) => {
      const x = get(a); const y = get(b);
      const xe = x == null || x === ''; const ye = y == null || y === '';
      if (xe && ye) return String(a.name || '').localeCompare(String(b.name || ''));
      if (xe) return 1;                    // 값 없는 행은 항상 뒤
      if (ye) return -1;
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      // 같은 값이면 이름으로 안정 정렬(행 순서가 렌더마다 흔들리지 않게).
      return (c !== 0 ? c * sign : String(a.name || '').localeCompare(String(b.name || '')));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sort.key, sort.dir]);
  // 같은 열 재클릭 = 방향 토글, 다른 열 = 그 열 asc(숫자 열은 큰 값부터 보는 게 유용해 desc).
  const clickSort = (key) => setSort((cur) => (cur.key === key
    ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: ['cpu', 'ram'].includes(key) ? 'desc' : 'asc' }));
  const arrow = (key) => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');
  const sortTh = (key, label, align = 'left') => (
    <th style={{ textAlign: align, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
      title={`${label} 기준 정렬`} onClick={() => clickSort(key)}>{label}{arrow(key)}</th>
  );
  return (
    <Modal title={`호스트 VM — ${host}`} onClose={onClose} width={860} resizable minWidth={560} minHeight={360} bodyScroll={false}>
      {err ? <ErrorBox message={err} /> : !d ? <Loading /> : (
        <>
          <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 10, flex: '0 0 auto' }}>
            <span className="muted" style={{ fontSize: 13 }}>
              VM <b style={{ color: 'var(--accent)' }}>{all.length}</b>대 · 구동중 <b style={{ color: 'var(--green)' }}>{onN}</b> · 정지 {all.length - onN}
              {ql ? <> · {rows.length} 표시</> : null}
              <span style={{ marginLeft: 6 }}>· VM 행을 클릭하면 상세를 봅니다.</span>
            </span>
            <input className="input" placeholder="VM/OS/IP 검색" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 200 }} />
          </div>
          {/* 모달 본문이 스크롤하지 않으므로(bodyScroll=false) 표가 남은 높이를 채우고 여기서만 스크롤한다. */}
          <div className="table-wrap" style={{ flex: '0 1 auto', minHeight: 0 }}>
            <table>
              <thead><tr>
                {sortTh('name', 'VM')}{sortTh('power', '전원', 'center')}{sortTh('guestOS', 'Guest OS')}
                {sortTh('cpu', 'vCPU', 'right')}{sortTh('ram', 'RAM', 'right')}{sortTh('ip', 'IP')}
              </tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={6} className="muted" style={{ padding: 14 }}>표시할 VM이 없습니다.</td></tr>}
                {rows.map((v) => (
                  <tr key={v.id}>
                    <td><VmLink item={v} name={v.name} vcenterId={v.vcenterId} label={v.name} /></td>
                    <td>{v.powerState === 'POWERED_ON' ? <span className="badge green">On</span> : <span className="badge gray">Off</span>}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{v.guestOS || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{v.cpuCount != null ? v.cpuCount : '—'}</td>
                    <td style={{ textAlign: 'right' }}>{gbv(v.memMB)}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{(v.ipAddresses?.length ? v.ipAddresses : (v.ipAddress ? [v.ipAddress] : [])).join(' ') || '—'}</td>
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

/**
 * 데이터스토어 상세의 브라우즈 섹션(v2.276) — 이 데이터스토어에 ① 할당된 VM 과 ② 실제
 * 파일 목록(크기·유형·수정시각)을 라이브로 조회해 보여준다. 서버가 60초 캐시하므로
 * 재클릭 연타가 vCenter 태스크를 쌓지 않는다. 조회 실패(권한·엣지 수집 vCenter 등)는
 * 사유 배너로 표시(추측 데이터 없음).
 */
const DS_FILE_TYPE = { VmDisk: ['디스크(vmdk)', 'blue'], VmConfig: ['구성(vmx)', 'green'], VmLog: ['로그', 'gray'], VmSnapshot: ['스냅샷', 'purple'], IsoImage: ['ISO', 'amber'], Folder: ['폴더', 'gray'], VmNvram: ['NVRAM', 'gray'], File: ['파일', 'gray'] };
function DsBrowseSection({ item }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [view, setView] = useState('vms'); // vms | files
  useEffect(() => {
    let dead = false;
    setD(null); setErr(null); setQ('');
    // 서버는 vCenter 탐색 태스크를 최대 90초 기다린다(dsBrowse.js TASK_TIMEOUT_MS=90s).
    // 기본 fetchJson(20초 타임아웃×3회)으로는 61초 이상 걸리는 대형 데이터스토어가 '항상'
    // 실패했고, 재시도는 서버 60초 캐시의 같은 진행중 프라미스에 합류만 해 결과를 영영 못
    // 받았다(v2.277 확정 버그 — 그 사이 vCenter 에는 고비용 탐색 태스크만 반복 생성).
    // 브라우즈만 150초(서버 90초 + 로그인/조회 오버헤드 여유) 단일 호출로 기다린다.
    fetchJson(`/datastores/${encodeURIComponent(item.id)}/browse`, {}, undefined, { timeoutMs: 150_000, retries: 0 })
      .then((r) => { if (!dead) setD(r); })
      .catch((e) => { if (!dead) setErr(e.message); });
    return () => { dead = true; };
  }, [item.id]);
  const fmtSize = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil((b || 0) / 1024)} KB`);
  if (err) return <div className="card" style={{ marginTop: 14, borderColor: 'var(--amber,#f59e0b)' }}><span style={{ fontSize: 13 }}>⚠ 파일/할당 VM 조회 실패 — {err}</span></div>;
  if (!d) return <div className="muted" style={{ marginTop: 14, fontSize: 13 }}>⏳ 파일·할당 VM 조회 중… (파일이 많은 데이터스토어는 최대 2분까지 걸릴 수 있습니다)</div>;
  if (d.mock) return <div className="muted" style={{ marginTop: 14, fontSize: 13 }}>{d.reason}</div>;
  const files = q ? d.files.filter((f) => (`${f.folder}${f.name}`).toLowerCase().includes(q.toLowerCase())) : d.files;
  return (
    <div style={{ marginTop: 14 }}>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
        <button className={`tab ${view === 'vms' ? 'active' : ''}`} onClick={() => setView('vms')}>
          할당 VM {d.vms.length}{d.unknownVmCount ? ` (+미수집 ${d.unknownVmCount})` : ''}
        </button>
        <button className={`tab ${view === 'files' ? 'active' : ''}`} onClick={() => setView('files')}>
          파일 {d.files.length.toLocaleString()}{d.truncated ? '+' : ''}
        </button>
        {view === 'files' && d.files.length > 0 && (
          <input className="input" placeholder="파일/폴더 검색…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 180 }} />
        )}
      </div>
      {view === 'vms' && (d.vms.length === 0
        ? <div className="muted" style={{ fontSize: 13 }}>이 데이터스토어에 할당된 VM 이 없습니다.{d.unknownVmCount ? ` (수집 스냅샷에 아직 없는 VM ${d.unknownVmCount}대 별도)` : ''}</div>
        : (
          <div className="table-wrap" style={{ maxHeight: '32vh' }}>
            <table>
              <thead><tr><th>VM</th><th>전원</th><th>호스트</th><th>클러스터</th><th>Guest OS</th><th style={{ textAlign: 'right' }}>사용(GB)</th></tr></thead>
              <tbody>
                {d.vms.map((v) => (
                  <tr key={v.id}>
                    <td><b>{v.name}</b></td>
                    <td><StateBadge state={v.powerState} /></td>
                    <td className="muted" style={{ fontSize: 12 }}>{v.host || '—'}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{v.cluster || '—'}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{v.guestOS || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{v.storageGB ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      {view === 'files' && (
        <>
          {d.filesError && <div className="card" style={{ borderColor: 'var(--amber,#f59e0b)', marginBottom: 8 }}><span style={{ fontSize: 13 }}>⚠ 파일 목록 조회 실패 — {d.filesError}</span></div>}
          {d.truncated && <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>⚠ 파일이 많아 <b>크기순 상위 10,000개</b>만 표시합니다(서버가 전체를 정렬한 뒤 자름 — v2.277).</div>}
          {files.length === 0 && !d.filesError && <div className="muted" style={{ fontSize: 13 }}>{q ? '검색 결과 없음' : '파일 없음'}</div>}
          {files.length > 0 && (
            <div className="table-wrap" style={{ maxHeight: '32vh' }}>
              <table>
                <thead><tr><th>폴더</th><th>파일</th><th>유형</th><th style={{ textAlign: 'right' }}>크기</th><th>수정</th></tr></thead>
                <tbody>
                  {files.slice(0, 2000).map((f, i) => {
                    const [tl, tc] = DS_FILE_TYPE[f.type] || [f.type, 'gray'];
                    return (
                      <tr key={i}>
                        <td className="muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>{f.folder}</td>
                        <td style={{ wordBreak: 'break-all' }}><b>{f.name}</b></td>
                        <td><span className={`badge ${tc}`}>{tl}</span></td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtSize(f.sizeBytes)}</td>
                        <td className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{f.modified ? f.modified.slice(0, 16).replace('T', ' ') : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {files.length > 2000 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>화면에는 2,000개까지 표시 — 검색으로 좁혀 보세요.</div>}
        </>
      )}
    </div>
  );
}

export function EntityDetail({ type, item, onClose }) {
  const titles = { vm: 'VM', host: '호스트', datastore: '데이터스토어' };
  const [showHostVms, setShowHostVms] = useState(false);
  return (
    <Modal title={`${titles[type] || ''} 상세 — ${item.name}`} onClose={onClose} width={640}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 24px' }}>
        {type === 'vm' && (
          <>
            <DRow label="이름"><b>{item.name}</b></DRow>
            <DRow label="전원"><StateBadge state={item.powerState} /></DRow>
            <DRow label="vCenter">{item.vcenterId}</DRow>
            <DRow label="호스트">{item.host || '—'}</DRow>
            <DRow label="클러스터">{item.cluster || '—'}</DRow>
            <DRow label="Guest OS">{item.guestOS}</DRow>
            <DRow label={`IP${item.ipAddresses?.length > 1 ? ` (${item.ipAddresses.length})` : ''}`}>
              {(() => {
                const ips = item.ipAddresses?.length ? item.ipAddresses : (item.ipAddress ? [item.ipAddress] : []);
                if (!ips.length) return '—';
                return <VmIpPing vcenterId={item.vcenterId} ips={ips} />;
              })()}
            </DRow>
            <DRow label="VMware Tools"><StateBadge state={item.toolsStatus} /></DRow>
            <DRow label="vCPU">{item.cpuCount != null ? `${item.cpuCount} 코어` : '—'}</DRow>
            <DRow label="RAM">{item.memMB != null ? <>{gb(item.memMB)} ({item.memMB.toLocaleString()} MB)</> : '—'}</DRow>
            <DRow label="디스크">{item.storageGB != null ? `${item.storageGB} GB` : '—'}</DRow>
            <DRow label="CPU 사용률"><UsageCell pct={item.cpuUsagePct} /></DRow>
            <DRow label="메모리 사용률"><UsageCell pct={item.memUsagePct} /></DRow>
            <DRow label="Tools 버전">{item.toolsVersion || '—'}</DRow>
            <DRow label="스냅샷">{item.snapshotCount ? `${item.snapshotCount}개 · ${item.snapshotSizeGB || 0} GB` : '없음'}</DRow>
            <DRow label="GPU">{item.gpu ? <GpuBadge gpu={item.gpu} /> : <span className="muted">없음</span>}</DRow>
            <DRow label="vCenter ID">{item.id}</DRow>
            <DRow label="태그">{item.tags?.length ? item.tags.map((t) => <span key={t} className="badge blue" style={{ marginLeft: 4 }}>{t}</span>) : '—'}</DRow>
            <DRow label="메모">{item.notes || '—'}</DRow>
          </>
        )}
        {type === 'host' && (
          <>
            <DRow label="이름">
              <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 6 }}>
                <b className="cell-link" style={{ cursor: 'pointer', wordBreak: 'break-all' }} title="이 호스트의 VM 목록 보기" onClick={() => setShowHostVms(true)}>{item.name}</b>
                {/* 저대비 텍스트 링크 → 버튼형 배지(테두리+배경)로 가독성 강화 */}
                <button type="button" title="이 호스트의 VM 목록 보기" onClick={() => setShowHostVms(true)}
                  style={{ fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', padding: '3px 10px', borderRadius: 999,
                    color: '#7dd3fc', background: 'rgba(56,189,248,.12)', border: '1px solid rgba(56,189,248,.45)', lineHeight: 1.4 }}>
                  🖥️ VM {item.vmCount ?? 0}대 보기 ›
                </button>
              </span>
            </DRow>
            <DRow label="상태"><StateBadge state={item.connectionState} /></DRow>
            <DRow label="vCenter">{item.vcenterId}</DRow>
            <DRow label="클러스터">{item.cluster || '—'}</DRow>
            <DRow label="전원">{item.powerState === 'POWERED_ON' ? 'On' : (item.powerState ? 'Off' : '—')}</DRow>
            <DRow label="제조사 / 모델">{[item.vendor, item.model].filter(Boolean).join(' / ') || '—'}</DRow>
            {/* 장비 서비스 태그(Dell Service Tag 등) — vCenter 가 수집한 하드웨어 식별자
                (summary.hardware.otherIdentifyingInfo). 서버 교체·A/S·자산 대조용. 없으면 '—'. */}
            <DRow label="서비스 태그">{item.serviceTag ? <b style={{ letterSpacing: 0.5 }}>{item.serviceTag}</b> : '—'}</DRow>
            <DRow label="ESXi 버전">{item.version ? `${item.version}${item.build ? ` (build ${item.build})` : ''}` : '—'}</DRow>
            <DRow label="CPU">{item.cpuCores}코어{item.cpuThreads ? ` / ${item.cpuThreads}스레드` : ''}{item.cpuTotalMhz ? ` · ${(item.cpuTotalMhz / 1000).toFixed(1)}GHz` : ''}</DRow>
            <DRow label="CPU 사용률"><UsageCell pct={item.cpuUsagePct} /></DRow>
            <DRow label="메모리">{gb(item.memTotalMB)}{item.memUsageMB ? ` · 사용 ${gb(item.memUsageMB)}` : ''}</DRow>
            <DRow label="메모리 사용률"><UsageCell pct={item.memUsagePct} /></DRow>
            {item.powerWatts > 0 && <DRow label="소비전력" full nowrap>{(item.powerWatts / 1000).toFixed(2)} kW ({item.powerWatts} W){item.powerSource === 'idrac' ? ' · iDRAC' : (item.idracBacked ? ' · vCenter 추정' : '')}</DRow>}
            {item.idracBacked && item.powerWattsIdrac > 0 && <DRow label="iDRAC 실측" full nowrap>{(item.powerWattsIdrac / 1000).toFixed(2)} kW ({item.powerWattsIdrac} W) <span className="muted" style={{ fontSize: 11 }}>· iDRAC 서버 등록 메뉴 집계</span></DRow>}
            <DRow label="VM 수">{item.vmCount}</DRow>
            <DRow label="HBA / GPU">{(item.hbas?.length || 0)}개 / {(item.gpus?.length || 0)}개</DRow>
          </>
        )}
        {type === 'datastore' && (
          <>
            <DRow label="이름"><b>{item.name}</b></DRow>
            <DRow label="스토리지">{dsStorageLabel(item)}</DRow>
            <DRow label="유형"><span className="badge blue">{item.type}</span></DRow>
            {item.remoteHost && <DRow label="원격 호스트">{item.remoteHost}</DRow>}
            <DRow label="vCenter">{item.vcenterId}</DRow>
            <DRow label="총 용량">{tb(item.capacityGB)}</DRow>
            <DRow label="사용">{tb(item.usedGB)}</DRow>
            <DRow label="여유">{tb(item.freeGB)}</DRow>
            <DRow label="사용률"><UsageCell pct={item.usagePct} /></DRow>
          </>
        )}
      </div>
      {type === 'datastore' && <DsBrowseSection item={item} />}
      {type === 'host' && item.hbas?.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>스토리지 어댑터 (HBA) — {item.hbas.length}</div>
          <div className="table-wrap" style={{ maxHeight: '28vh' }}>
            <table>
              <thead><tr><th>어댑터</th><th>유형</th><th>모델</th><th style={{ textAlign: 'right' }}>속도</th><th>WWN</th></tr></thead>
              <tbody>
                {item.hbas.map((h, i) => (
                  <tr key={i}>
                    <td><b>{h.name || '—'}</b></td>
                    <td><span className="badge blue">{h.type}</span></td>
                    <td className="muted" style={{ fontSize: 12 }}>{h.model || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{h.speedGbps ? `${h.speedGbps} Gb` : '—'}</td>
                    <td className="muted" style={{ fontSize: 11 }}>{h.wwn || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {type === 'host' && item.gpus?.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>GPU — {item.gpus.length}</div>
          <div className="flex gap wrap">
            {item.gpus.map((g, i) => <span key={i} className="badge gray" style={{ fontSize: 12 }}>{g.model}{g.memGB ? ` · ${g.memGB}GB` : ''}{g.vgpuMode ? ' · vGPU' : ''}</span>)}
          </div>
        </div>
      )}
      {type === 'host' && <HostPowerPanel hostName={item.name} serviceTag={item.serviceTag} />}
      {type === 'host' && (
        <div className="flex gap" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
          <HostMetricButton hostId={item.id} hostName={item.name} />
        </div>
      )}
      {type === 'vm' && (
        <div className="flex gap" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
          {/* 사양 변경은 4개 VM 상세 화면 중 '가상머신' 탭에만 있어 화면마다 기능이 달랐다(v2.240 통일).
              권한(vm.reconfig)이 없으면 버튼이 스스로 렌더되지 않는다 — 서버도 requirePerm 으로 강제. */}
          <VmReconfigButton vm={item} />
          <VmConsoleButton vmId={item.id} vmName={item.name} />
          <VmRemoteButton item={item} />
          <VmMetricButton vmId={item.id} vmName={item.name} />
        </div>
      )}
      {type === 'host' && showHostVms && (
        <HostVmsModal host={item.name} vcenterId={item.vcenterId} onClose={() => setShowHostVms(false)} />
      )}
    </Modal>
  );
}

/**
 * 어디서나 VM 이름/IP/호스트명을 클릭하면 VM 상세(EntityDetail) 팝업을 띄우는 공용 링크.
 * 스냅샷에서 단건 조회(/vms/lookup) 후 모달을 연다. 못 찾으면 안내 모달.
 */
export function VmLink({ name, ip, vcenterId, label, item, className = 'cell-link', style }) {
  const [vm, setVm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const open = async (e) => {
    e?.stopPropagation?.();
    setBusy(true); setMsg(null);
    // 가진 정보(item)가 있으면 즉시 상세를 띄워(무반응 방지), 이후 lookup으로 전체 정보 보강.
    const seed = item || (name || ip ? { name: name || ip, vcenterId, ipAddress: ip } : null);
    if (seed) setVm(seed);
    try {
      const params = {};
      if (name) params.name = name;
      if (ip) params.ip = ip;
      if (vcenterId) params.vcenterId = vcenterId;
      const r = await fetchJson('/vms/lookup', params);
      // seed로 이미 열렸는데 cur가 null이면 사용자가 닫은 것 — 늦은 응답이 모달을 다시 열지 않게 한다.
      // (seed가 없던 경우엔 아직 안 열린 상태이므로 정상적으로 연다.)
      if (r.vm) setVm((cur) => (cur ? { ...cur, ...r.vm } : (seed ? cur : { ...r.vm })));

      else if (!seed) setMsg(`해당 VM을 찾을 수 없습니다 (${label || name || ip}).`);
    } catch (err) { if (!seed) setMsg(err.message); }
    finally { setBusy(false); }
  };
  return (
    <>
      <button className={className} style={style} disabled={busy} onClick={open} title="클릭하면 VM 상세 보기">{label ?? name ?? ip}</button>
      {vm && <EntityDetail type="vm" item={vm} onClose={() => setVm(null)} />}
      {msg && <Modal title="VM 조회" onClose={() => setMsg(null)} width={380}><div className="muted" style={{ padding: 4 }}>{msg}</div></Modal>}
    </>
  );
}
