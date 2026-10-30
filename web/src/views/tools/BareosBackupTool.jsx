import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, patchJson, delJson, usePolling, getCurrentUser } from '../../api.js';
import { Loading, ErrorBox, SearchBox, Modal } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import BoldText from '../../components/boldText.jsx';
import ScopeOmitBanner from '../ScopeOmitBanner.jsx';
import { useHashTab } from '../../hooks/useHashTab.js';
import { requireChanged } from '../changeResult.js';
import { droppedSecretNote } from '../droppedSecretText.js';
import VeeamHeader from './VeeamHeader.jsx';
import {
  stateBadge, levelLabel, bytesText, whenText, runCell, directorLine, RESTORE_MODE_LABEL, restoreLine, candidateSummary, driftText, restorePointsNote,
  folderOptions, inFolder, pickCap, bulkSummary, diagView,
  directorPrepBlock, fdIniTemplate, PREP_CHECKLIST, autoSetupDirectorText, autoSetupFdText, thumbprintText,
  directorPatch, outcomeUnknown, missingText,
  parseJobReport, reportCards, REPORT_KEYS, issueHint, storeRatio, reportText, reportBytes, reportValue,
} from './bareosText.js';

/**
 * 특수 기능 › Bareos VM 백업(v2.820, 도구 키 bareos-backup — admin 전용).
 * 포탈에서 고른 VM 을 Bareos VMware 플러그인으로 백업·복원한다. 포탈은 Director 콘솔(TLS-PSK · JSON)로 잡을 만들고 실행·조회하며,
 * 백업 데이터는 사이트 FD → SD 안에서만 흐른다. vCenter 비밀번호는 포탈이 갖지 않는다(사이트 FD 의 INI).
 * 문구·판정은 bareosText.js 하나(백틱 금지 · 값이 없으면 '—').
 */
const BASE = '/tools/bareos-backup';
const TABS = [['targets', '백업 대상'], ['history', '실행 현황 · 이력'], ['settings', '설정']];
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' };
const NOTE = { padding: '8px 12px', marginBottom: 10, fontSize: 12.5, lineHeight: 1.6 };
const BTN = { padding: '4px 9px', fontSize: 12 };
const WRAP = { display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 };
// 전역 .input 의 min-width 220px 이 격자 칸·표 칸 입력을 밀어낸다(styles.css 1267 의 v2.636 사례) — 칸 안 입력은 이것으로.
const INP = { minWidth: 0, width: '100%', boxSizing: 'border-box' };
const enc = encodeURIComponent;
// W2(v2.822): Director 를 거치는 조회는 자동 재시도하지 않는다(502·시한마다 Director 인증을 다시 시도하고, 서버는 앞 요청을 계속 돌린다 — 규약 '자동 재시도 금지')
const DIRECTOR_GET = { retries: 0, timeoutMs: 60_000 };
const RESTORE_POINTS_SHOWN = 30;   // 창 높이 때문에 보이는 개수 — 잘리면 문구가 밝힌다(restorePointsNote)

export default function BareosBackupTool() {
  const [tab, setTab] = useHashTab({ base: ['tools', 'bareos-backup'], valid: TABS.map(([k]) => k), fallback: 'targets' });
  const [tick, setTick] = useState(0);
  const { data: polled, error } = usePolling(BASE, { _r: tick }, 10_000);
  // 새로 고침(_r 변경) 때 usePolling 이 data 를 비운다 — 직전 응답을 유지해야 탭이 다시 마운트되지 않는다
  // (다시 마운트되면 '시작했습니다' 안내·추가 폼·필터가 사라진다 — Chromium 확인에서 실제로 그랬다).
  const lastRef = useRef(null);
  if (polled) lastRef.current = polled;
  const data = polled || lastRef.current;
  const reload = () => setTick((t) => t + 1);
  const me = getCurrentUser();
  const fullScope = !me?.scope || (!(me.scope.vcenters || []).length && !(me.scope.regions || []).length);

  // v2.822: Backup 상단 메뉴의 한 탭(Summary·Detail·EM·백업 실행 옆) — 머리는 불러오는 중·오류에도 보인다(탭으로 되돌아갈 수 있게).
  const head = <VeeamHeader active="bareos" desc="포탈에서 고른 VM 을 Bareos VMware 플러그인으로 백업·복원합니다(관리자)." />;
  if (error && !data) return <div style={WRAP}>{head}<ErrorBox error={error} /></div>;
  if (!data) return <div style={WRAP}>{head}<Loading /></div>;

  return (
    <div style={WRAP}>
      {head}
      <div>
      {error && <div className="banner warn" style={{ marginBottom: 10 }}>최근 새로 고침에 실패했습니다 — 아래는 마지막으로 받은 내용입니다({String(error.message || error).slice(0, 160)}).</div>}
      <div className="card" style={{ ...NOTE, borderLeft: `3px solid var(--${data.demo ? 'amber' : data.configured && data.poller?.ok !== false && !data.authStopped ? 'green' : 'red'})` }}>
        <BoldText text={directorLine(data)} />
      </div>
      {data.settingsLoadError && <div className="banner bad" style={{ marginBottom: 10 }}>설정 파일을 읽지 못했습니다(손상본 보존) — {data.settingsLoadError.reason}</div>}
      {data.registryLoadError && <div className="banner bad" style={{ marginBottom: 10 }}>백업 대상 원장을 읽지 못했습니다(손상본 보존 — 새 대상 추가를 막았습니다) — {data.registryLoadError.reason}</div>}
      <div style={{ ...ROW, marginBottom: 12 }}>
        {TABS.filter(([k]) => k !== 'settings' || fullScope).map(([k, l]) => (
          <button key={k} type="button" className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'targets' && <TargetsTab d={data} reload={reload} />}
      {tab === 'history' && <HistoryTab d={data} />}
      {tab === 'settings' && fullScope && <SettingsTab onSaved={reload} />}
      {tab === 'settings' && !fullScope && <div className="muted" style={{ padding: 16 }}>Director 설정은 전체 범위 관리자만 볼 수 있습니다 — 백업 대상 탭을 쓰세요.</div>}
      </div>
    </div>
  );
}

/* ───────────────────────── 백업 대상 ───────────────────────── */
function TargetsTab({ d, reload }) {
  const [vc, setVc] = useState('');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [busyIds, setBusyIds] = useState(() => new Set());   // W11: 처리 중 잠금은 그 대상만
  const [msg, setMsg] = useState(null);
  const [logOf, setLogOf] = useState(null);       // { job, jobid }
  const [restoreOf, setRestoreOf] = useState(null); // job
  const [runFor, setRunFor] = useState(null);     // W6: 레벨을 고르는 중인 대상 id
  const [runLevel, setRunLevel] = useState('');
  const vcs = useMemo(() => [...new Set(d.jobs.map((j) => j.vcenterId))].sort(), [d.jobs]);
  // W10: 고른 vCenter 의 마지막 대상이 사라지면 필터를 풀고(드롭다운은 '전체' 를 보이는데 상태만 남는 어긋남), 보던 대상이 지워지면 창을 닫는다
  useEffect(() => { if (vc && !vcs.includes(vc)) setVc(''); }, [vc, vcs]);
  useEffect(() => {
    const ids = new Set(d.jobs.map((j) => j.id));
    if (logOf && !ids.has(logOf.job.id)) setLogOf(null);
    if (restoreOf && !ids.has(restoreOf.id)) setRestoreOf(null);
    if (runFor && !ids.has(runFor)) setRunFor(null);
  }, [d.jobs, logOf, restoreOf, runFor]);
  const rows = d.jobs.filter((j) => (!vc || j.vcenterId === vc) && (!q || `${j.vmName} ${j.folder} ${j.bareosJob}`.toLowerCase().includes(q.toLowerCase())));

  const act = async (j, fn, okText) => {
    setBusyIds((b) => new Set(b).add(j.id)); setMsg(null);
    try { const r = await fn(); requireChanged(r); setMsg({ ok: true, text: okText(r) }); reload(); }
    catch (e) { setMsg({ ok: false, text: `오류: ${e.message}` }); }
    finally { setBusyIds((b) => { const n = new Set(b); n.delete(j.id); return n; }); }
  };
  const run = (j) => { setRunFor(null); act(j, () => postJson(`${BASE}/jobs/${enc(j.id)}/run`, runLevel ? { level: runLevel } : {}), (r) => `‘${j.vmName}’ 백업을 시작했습니다(jobid ${r.jobid}). 진행은 이 표와 실행 현황 탭에서 보입니다.`); };
  const cancel = (j, jobid) => { if (window.confirm(`‘${j.vmName}’ 의 실행 중 백업(jobid ${jobid})을 취소할까요?`)) act(j, () => postJson(`${BASE}/jobs/${enc(j.id)}/cancel`, { jobid }), (r) => r.note || '취소를 요청했습니다(Director 가 멈추기까지 시간이 걸릴 수 있습니다).'); };
  const toggle = (j) => act(j, () => patchJson(`${BASE}/jobs/${enc(j.id)}`, { enabled: !j.enabled }), () => (j.enabled ? '비활성화했습니다 — Bareos 의 비활성화는 Director 를 reload·재시작하면 풀리므로 포탈이 상태 대조 때마다 다시 끕니다.' : '활성화했습니다.'));
  const remove = (j) => {
    if (!window.confirm(`‘${j.vmName}’ 을(를) 백업 대상에서 지울까요?\nDirector 의 잡은 비활성화하고 정의 파일은 남습니다(Director 를 reload 하면 다시 켜지므로 포탈이 대조 때마다 다시 끕니다 — 영구히 멈추려면 정의 파일을 지우세요). 백업 데이터는 지우지 않습니다.`)) return;
    act(j, () => delJson(`${BASE}/jobs/${enc(j.id)}`), (r) => r.note || '지웠습니다.');
  };

  return (
    <div>
      <div style={{ ...ROW, marginBottom: 10 }}>
        <span className="muted" style={{ fontSize: 12 }}>vCenter</span>
        <Select className="input" value={vc} onChange={(e) => setVc(e.target.value)} style={{ minWidth: 160 }} aria-label="vCenter 필터">
          <option value="">전체 ({vcs.length})</option>
          {vcs.map((v) => <option key={v} value={v}>{v}</option>)}
        </Select>
        <SearchBox value={q} onChange={setQ} placeholder="VM · 폴더 · 잡 이름" style={{ width: 240, maxWidth: '100%' }} />
        <span className="muted" style={{ fontSize: 12 }}>백업 대상 {d.jobs.length}대</span>
        <div style={{ flexGrow: 1 }} />
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={!d.configured || !!d.registryLoadError} onClick={() => setAdding(true)}>+ 백업 대상 추가</button>
      </div>
      {msg && <div className={`banner ${msg.ok ? 'ok' : 'bad'}`} style={{ marginBottom: 10 }}><BoldText text={msg.text} /></div>}
      {adding && <AddForm d={d} onClose={() => setAdding(false)} onChanged={reload} />}
      <ScopeOmitBanner data={d} unit="백업 대상" counter="개" why="조회 범위 밖 vCenter 의" />

      <div className="table-wrap" style={{ maxHeight: '58vh' }}>
        <STable minWidth={1040} wrap={false}>
          <thead><tr>
            <th>VM</th><th>vCenter</th><th>데이터센터 · 폴더</th><th>사이트 FD · 레벨 · 스케줄</th>
            <th>최근 실행</th><th className="right">용량</th><th data-nosort>작업</th>
          </tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={7} className="center muted" style={{ padding: 22 }}>{d.jobs.length ? '조건에 맞는 대상이 없습니다.' : '백업 대상이 없습니다 — ‘+ 백업 대상 추가’ 로 vCenter 의 VM 을 고르세요.'}</td></tr>}
            {rows.map((j) => {
              const c = runCell(j);
              // W5: 포탈이 시작한 실행(pending)뿐 아니라 Bareos 스케줄이 돌리는 실행(대조가 넣은 lastRun)도 실행 중이다 — 대조 주기만큼 늦을 수 있다
              const liveJobid = j.pending?.jobid || (['running', 'queued', 'waiting'].includes(j.lastRun?.state) ? j.lastRun.jobid : null);
              const running = !!liveJobid;
              const busy = busyIds.has(j.id);
              return (
                <tr key={j.id} style={{ opacity: j.enabled ? 1 : 0.6 }}>
                  <td data-sort={j.vmName}><b>{j.vmName}</b>{!j.enabled && <span className="badge gray" style={{ marginLeft: 6 }}>비활성</span>}{j.missingInDirector && <span className="badge red" style={{ marginLeft: 6 }} title="Director 의 잡 목록에 없습니다(누가 정의 파일을 지웠을 수 있습니다)">Director 에 없음</span>}{j.demo && <span className="badge amber" style={{ marginLeft: 6 }}>데모</span>}{j.drift && <span className="badge amber" style={{ marginLeft: 6 }} title={driftText(j.drift)}>{j.drift === 'missing' ? '인벤토리에 없음' : '등록 뒤 바뀜'}</span>}</td>
                  <td className="muted">{j.vcenterId}</td>
                  <td className="muted" style={{ fontSize: 12 }}><div style={{ maxWidth: 220, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{j.dc} · {j.folder}</div></td>
                  <td data-sort={j.client} style={{ fontSize: 12.5 }}>{j.client}<div className="muted" style={{ fontSize: 11 }}>{levelLabel(j.level)} · {j.schedule || '수동'}</div></td>
                  <td data-sort={c.when === '—' ? '' : c.when} style={{ fontSize: 12 }}>
                    <span style={{ marginRight: 6 }}>{c.when}</span>
                    {c.badge ? <span className={`badge ${c.badge.cls}`}>{c.badge.label}</span> : null}
                    <div className="muted" style={{ fontSize: 11 }}>{c.note}</div>
                    {j.lastError && <div style={{ fontSize: 11, color: 'var(--red)' }}>{j.lastError.message}</div>}
                  </td>
                  <td className="right" data-sort={j.lastRun?.bytes ?? ''}>{c.bytes}</td>
                  <td style={{ minWidth: 236 }}>
                    <span style={{ ...ROW, gap: 6 }}>
                      {running
                        ? <button type="button" className="logout-btn" style={{ ...BTN, color: 'var(--red)' }} disabled={busy} onClick={() => cancel(j, liveJobid)}>취소</button>
                        : runFor === j.id
                          ? <>
                            <Select className="input" sort={false} value={runLevel} onChange={(e) => setRunLevel(e.target.value)} style={{ minWidth: 0, width: 168, padding: '3px 6px', fontSize: 12 }} aria-label="실행 레벨">
                              <option value="">기본({levelLabel(j.level)})</option>
                              {['Full', 'Incremental', 'Differential'].map((l) => <option key={l} value={l}>{levelLabel(l)}</option>)}
                            </Select>
                            <button type="button" className="logout-btn" style={BTN} disabled={busy} onClick={() => run(j)}>시작</button>
                            <button type="button" className="logout-btn" style={BTN} onClick={() => setRunFor(null)}>닫기</button>
                          </>
                          : <button type="button" className="logout-btn" style={BTN} disabled={busy || !j.enabled} onClick={() => { setRunLevel(''); setRunFor(j.id); }}>실행…</button>}
                      <button type="button" className="logout-btn" style={BTN} disabled={!c.jobid} onClick={() => setLogOf({ job: j, jobid: c.jobid, view: 'summary' })}>결과</button>
                      <button type="button" className="logout-btn" style={BTN} disabled={!c.jobid} onClick={() => setLogOf({ job: j, jobid: c.jobid, view: 'raw' })}>로그</button>
                      <button type="button" className="logout-btn" style={BTN} disabled={busy} onClick={() => setRestoreOf(j)}>복원…</button>
                      <button type="button" className="logout-btn" style={BTN} disabled={busy || running} onClick={() => toggle(j)}>{j.enabled ? '비활성' : '활성'}</button>
                      <button type="button" className="logout-btn" style={{ ...BTN, color: 'var(--red)' }} disabled={busy || running} onClick={() => remove(j)}>삭제</button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </STable>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.6 }}>
        스케줄은 Bareos 가 돌립니다(포탈이 꺼져 있어도 백업은 계속됩니다). 레벨·스케줄을 바꾸려면 대상을 지우고 다시 등록하세요 — Bareos 에는 잡 수정 명령이 없습니다.
        활성 대상 VM 은 vCenter 상세(서버 › vCenter)의 VM 행에 <span className="badge blue" style={{ fontSize: 10 }}>Bareos</span> 배지로 표시됩니다.
      </div>
      {logOf && <LogModal job={logOf.job} jobid={logOf.jobid} view={logOf.view} onClose={() => setLogOf(null)} />}
      {restoreOf && <RestoreModal job={restoreOf} onClose={() => setRestoreOf(null)} onDone={(t) => { setRestoreOf(null); setMsg({ ok: true, text: t }); reload(); }} />}
    </div>
  );
}

/** 대상 추가 — vCenter → 등록 후보(서버가 가능 여부·사유를 준다) → 레벨 → 등록. */
function AddForm({ d, onClose, onChanged }) {
  const [vcs, setVcs] = useState(null);
  const [vcErr, setVcErr] = useState(null);
  const [vc, setVc] = useState('');
  const [cand, setCand] = useState(null);
  const [candErr, setCandErr] = useState(null);
  const [q, setQ] = useState('');
  const [folder, setFolder] = useState('');
  const [sel, setSel] = useState(() => new Set());
  const [level, setLevel] = useState(d.defaults?.level || 'Incremental');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null);
  const [rev, setRev] = useState(0);
  const gen = useRef(0);
  useEffect(() => { fetchJson('/vcenters').then((r) => setVcs(Array.isArray(r) ? r : [])).catch(setVcErr); }, []);
  useEffect(() => {
    const g = ++gen.current;   // 늦게 온 이전 vCenter 의 응답은 버린다
    setCand(null); setCandErr(null);
    if (!vc) return;
    fetchJson(`${BASE}/vm-candidates`, { vcenterId: vc }).then((r) => { if (g === gen.current) setCand(r); }).catch((e) => { if (g === gen.current) setCandErr(e); });
  }, [vc, rev]);
  useEffect(() => { setSel(new Set()); setFolder(''); setResult(null); setErr(null); }, [vc]);
  const all = useMemo(() => cand?.items || [], [cand]);
  const folders = useMemo(() => folderOptions(all), [all]);
  const items = all.filter((x) => inFolder(x, folder) && (!q || x.name.toLowerCase().includes(q.toLowerCase())));
  const pickable = (x) => !!cand?.writable && x.eligible && !x.registered;
  const cap = pickCap(cand);
  const toggle = (x) => setSel((prev) => {
    const n = new Set(prev);
    if (n.has(x.id)) n.delete(x.id); else if (n.size < cap) n.add(x.id);
    return n;
  });
  const visiblePickable = items.filter(pickable);
  const pickVisible = () => setSel((prev) => {
    const n = new Set(prev);
    for (const x of visiblePickable) { if (n.size >= cap) break; n.add(x.id); }
    return n;
  });
  const submit = async () => {
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await postJson(`${BASE}/jobs/bulk`, { vcenterId: vc, vmIds: [...sel], level });
      setResult(r);
      if (r.created > 0) { setSel(new Set()); setRev((x) => x + 1); onChanged(); }
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const nameOf = new Map(all.map((x) => [x.id, x.name]));
  return (
    <div className="card" style={{ padding: 14, marginBottom: 12, minWidth: 0 }}>
      <div style={{ ...ROW, marginBottom: 8 }}>
        <b>백업 대상 추가</b>
        <span className="muted" style={{ fontSize: 12 }}>여러 VM 을 고르거나 폴더를 골라 한 번에 등록합니다</span>
        <div style={{ flexGrow: 1 }} />
        <button type="button" className="logout-btn" style={BTN} onClick={onClose}>닫기</button>
      </div>
      {vcErr && <ErrorBox error={vcErr} />}
      <div style={{ ...ROW, marginBottom: 8 }}>
        <label htmlFor="bareos-add-vc" className="muted" style={{ fontSize: 12 }}>vCenter</label>
        <Select id="bareos-add-vc" className="input" value={vc} onChange={(e) => setVc(e.target.value)} style={{ ...INP, width: 'auto', minWidth: 200, maxWidth: '100%' }}>
          <option value="">선택…</option>
          {(vcs || []).map((v) => <option key={v.id} value={v.id}>{v.name ? `${v.name} (${v.id})` : v.id}</option>)}
        </Select>
        {cand && (
          <>
            <label htmlFor="bareos-add-folder" className="muted" style={{ fontSize: 12 }}>폴더</label>
            <Select id="bareos-add-folder" className="input" sort={false} value={folder} onChange={(e) => setFolder(e.target.value)} style={{ ...INP, width: 'auto', minWidth: 160, maxWidth: '100%' }}>
              <option value="">전체 폴더</option>
              {folders.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </Select>
            <SearchBox value={q} onChange={setQ} placeholder="VM 이름" style={{ width: 200, maxWidth: '100%' }} />
          </>
        )}
        <label htmlFor="bareos-add-level" className="muted" style={{ fontSize: 12 }}>기본 레벨</label>
        <Select id="bareos-add-level" className="input" sort={false} value={level} onChange={(e) => setLevel(e.target.value)} style={{ ...INP, width: 'auto', minWidth: 140 }}>
          <option value="Incremental">Incremental</option><option value="Differential">Differential</option><option value="Full">Full</option>
        </Select>
      </div>
      {candErr && <ErrorBox error={candErr} />}
      {vc && !cand && !candErr && <Loading />}
      {cand && (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{candidateSummary(cand)}{!cand.mapped ? ' · 이 vCenter 의 사이트 매핑이 없습니다(설정 탭)' : ''}{!cand.writable ? ' · 조회 전용 범위라 등록할 수 없습니다' : ''}</div>
          <div style={{ ...ROW, marginBottom: 6 }}>
            <button type="button" className="logout-btn" style={BTN} disabled={!visiblePickable.length || sel.size >= cap} onClick={pickVisible}>보이는 등록 가능 VM 전체 선택({visiblePickable.length}대)</button>
            <button type="button" className="logout-btn" style={BTN} disabled={!sel.size} onClick={() => setSel(new Set())}>선택 해제</button>
            <span className="muted" style={{ fontSize: 12 }}>{sel.size}대 선택 · 한 번에 최대 {cap}대{cap < (cand.maxBulk || 0) ? `(원장 남은 자리 ${cand.jobsLeft}개)` : ''}</span>
          </div>
          <div className="table-wrap" style={{ maxHeight: '36vh' }}>
            <STable minWidth={640} limit={500} wrap={false}>
              <thead><tr><th data-nosort>선택</th><th>VM</th><th>데이터센터 · 폴더</th><th>상태</th><th>등록 가능</th></tr></thead>
              <tbody>
                {items.length === 0 && <tr><td colSpan={5} className="center muted" style={{ padding: 14 }}>조건에 맞는 VM 이 없습니다.</td></tr>}
                {items.map((x) => (
                  <tr key={x.id} style={{ opacity: pickable(x) ? 1 : 0.6 }}>
                    <td><input type="checkbox" id={`bareos-pick-${x.id}`} aria-label={`${x.name} 선택`} disabled={!pickable(x) || (!sel.has(x.id) && sel.size >= cap)} checked={sel.has(x.id)} onChange={() => toggle(x)} /></td>
                    <td><label htmlFor={`bareos-pick-${x.id}`}>{x.name}</label></td>
                    <td className="muted" style={{ fontSize: 12 }}>{x.dc ?? '—'} · {x.folder ?? '—'}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{x.template ? '템플릿' : x.powerState === 'POWERED_ON' ? '켜짐' : x.powerState === 'POWERED_OFF' ? '꺼짐' : '—'}</td>
                    <td style={{ fontSize: 12 }}>{x.registered ? <span className="badge blue">이미 대상</span> : x.eligible ? <span className="badge green">가능</span> : <span className="muted">{x.reason}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          </div>
          {items.length > 500 && <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>표에는 정렬 기준 앞 500대만 보입니다(조건에 맞는 VM {items.length}대) — 폴더·이름으로 좁히세요. 전체 선택은 보이는 표가 아니라 조건에 맞는 VM 전체에서 고릅니다.</div>}
        </>
      )}
      {err && <div className="banner bad" style={{ marginTop: 8 }}>{err}</div>}
      {result && (
        <div style={{ marginTop: 10 }}>
          <div className={`banner ${result.created > 0 ? (result.failed ? 'warn' : 'ok') : 'bad'}`} style={{ marginBottom: 6 }}>{bulkSummary(result)}</div>
          {result.failed > 0 && (
            <div className="table-wrap" style={{ maxHeight: '24vh' }}>
              <STable minWidth={520} wrap={false}>
                <thead><tr><th>VM</th><th>사유</th></tr></thead>
                <tbody>{(result.results || []).filter((x) => !x.ok).map((x) => <tr key={x.vmId}><td>{x.vmName || nameOf.get(x.vmId) || x.vmId}</td><td style={{ fontSize: 12 }}>{x.reason}</td></tr>)}</tbody>
              </STable>
            </div>
          )}
        </div>
      )}
      <div style={{ ...ROW, marginTop: 10 }}>
        <span className="muted" style={{ fontSize: 12 }}>{sel.size ? `${sel.size}대 — VM 마다 Director 에 잡을 만들고(configure add job) 사이트 매핑의 스케줄을 배정합니다. Director 접속은 한 번입니다.` : 'VM 을 고르세요.'}</span>
        <div style={{ flexGrow: 1 }} />
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={!sel.size || busy} onClick={submit}>{busy ? '등록 중…' : `${sel.size || ''}대 등록`}</button>
      </div>
    </div>
  );
}

/**
 * 작업 결과·로그 — 서버가 이 대상의 jobid 인지 확인한다. 요약은 같은 로그의 끝 보고 블록을 읽는다(bareosText.parseJobReport —
 * 서버 호출을 늘리지 않는다). 요약을 못 만들면(실행 중·보고 없음) 그렇다고 말하고 원문을 보게 한다.
 */
function LogModal({ job, jobid, view = 'raw', onClose }) {
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  const [mode, setMode] = useState(view === 'summary' ? 'summary' : 'raw');
  useEffect(() => { fetchJson(`${BASE}/jobs/${enc(job.id)}/log`, { jobid }, undefined, DIRECTOR_GET).then(setR).catch(setErr); }, [job.id, jobid]);
  const rep = useMemo(() => (r ? parseJobReport(r.lines) : null), [r]);
  return (
    <Modal title={`${mode === 'summary' ? '작업 결과' : '작업 로그'} — jobid ${jobid} · ${job.vmName}`} onClose={onClose} width={920}>
      <div style={{ ...ROW, marginBottom: 8 }}>
        {[['summary', '요약'], ['raw', '원문 로그']].map(([k, l]) => (
          <button key={k} type="button" className={`tab${mode === k ? ' active' : ''}`} onClick={() => setMode(k)}>{l}</button>
        ))}
        {r && <span className="muted" style={{ fontSize: 12 }}>{r.truncated ? `전체 ${r.total}줄 중 마지막 ${r.lines.length}줄` : `${r.total}줄`}</span>}
      </div>
      {err && <ErrorBox error={err} />}
      {!r && !err && <Loading />}
      {r && mode === 'raw' && (
        <pre style={{ margin: 0, padding: 12, maxHeight: '60vh', overflow: 'auto', fontSize: 12, lineHeight: 1.6, background: 'var(--panel-deep)', borderRadius: 8, whiteSpace: 'pre' }}>{r.lines.join('\n') || '로그가 없습니다.'}</pre>
      )}
      {r && mode === 'summary' && <JobReportView rep={rep} truncated={r.truncated} vmName={job.vmName} jobid={jobid} />}
    </Modal>
  );
}

/* 결과 색 — 배지와 같은 계열(styles.css .badge.*). 회색은 결과를 단정하지 못한 경우. */
const VERDICT_TONE = Object.freeze({
  green: { fg: '#4ade80', bg: 'rgba(34,197,94,.10)', line: 'rgba(34,197,94,.45)', mark: '✓' },
  amber: { fg: '#fbbf24', bg: 'rgba(245,158,11,.10)', line: 'rgba(245,158,11,.45)', mark: '!' },
  red: { fg: '#f87171', bg: 'rgba(239,68,68,.10)', line: 'rgba(239,68,68,.45)', mark: '✕' },
  gray: { fg: 'var(--text-dim)', bg: 'rgba(139,155,180,.08)', line: 'var(--border)', mark: '?' },
});
const SECTION = { fontSize: 12, fontWeight: 600, color: 'var(--text-dim)', margin: '14px 0 6px', letterSpacing: '.02em' };
const chip = (ok) => ({ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999, fontSize: 12,
  background: ok === null ? 'rgba(139,155,180,.12)' : ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
  color: ok === null ? 'var(--text-dim)' : ok ? '#4ade80' : '#f87171' });

/**
 * 요약 본문 — ① 결과 띠(크게) ② 핵심 수치 카드 + 저장 효율 막대 ③ 상태 칩(FD·SD 종료·오류 수) ④ 세부 ⑤ 경고·오류 줄(해석 붙임).
 * 값이 없으면 '—'(0 으로 보이지 않게) · 해석은 아는 줄에만(bareosText.issueHint).
 */
function JobReportView({ rep, truncated, vmName, jobid }) {
  const [copied, setCopied] = useState('');
  if (!rep?.found) {
    return (
      <div>
        <div className="card" style={{ ...NOTE, borderLeft: '3px solid var(--amber)' }}>
          아직 끝난 보고가 로그에 없습니다(실행 중이거나 보고 없이 끝났습니다{truncated ? ' · 로그가 길어 앞부분이 잘렸을 수 있습니다' : ''}). ‘원문 로그’ 에서 확인하세요.
        </div>
        {rep?.issues?.length ? <IssueList rep={rep} /> : null}
      </div>
    );
  }
  const f = rep.fields;
  const tone = VERDICT_TONE[rep.verdict.cls] || VERDICT_TONE.gray;
  const ratio = storeRatio(f);
  const errN = reportBytes;
  const fdErr = errN(f['Non-fatal FD errors'] ?? f['FD Errors']);
  const sdErr = errN(f['SD Errors']);
  const okStatus = (v) => (v === undefined ? null : /^OK/i.test(String(v)));
  const detail = ['Client', 'FileSet', 'Pool', 'Storage', 'FD Files Written', 'SD Files Written', 'Files Expected', 'Last Volume Bytes', 'Encryption', 'Job triggered by']
    .filter((k) => f[k] !== undefined);
  const copy = () => {
    const t = reportText(rep, { vmName, jobid });
    try { navigator.clipboard.writeText(t).then(() => setCopied('복사했습니다.'), () => setCopied('복사하지 못했습니다.')); } catch { setCopied('복사하지 못했습니다.'); }
  };
  return (
    <div style={{ maxHeight: '66vh', overflow: 'auto', paddingRight: 2 }}>
      {/* ① 결과 띠 */}
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', padding: '14px 16px', borderRadius: 10, background: tone.bg, border: `1px solid ${tone.line}` }}>
        <div aria-hidden style={{ width: 40, height: 40, flex: '0 0 40px', borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 20, fontWeight: 800, color: tone.fg, border: `2px solid ${tone.fg}` }}>{tone.mark}</div>
        <div style={{ minWidth: 0, flex: '1 1 260px' }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: tone.fg }}>{rep.verdict.label}</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 2, wordBreak: 'break-word' }}>
            {f.Termination} · {levelLabel(f['Backup Level']) !== '—' ? levelLabel(f['Backup Level']) : (f['Backup Level'] || '—')} · {f['Start time'] || '—'} → {f['End time'] || '—'}
          </div>
        </div>
        <span style={{ ...ROW, gap: 6 }}>
          <button type="button" className="logout-btn" style={BTN} onClick={copy}>요약 복사</button>
          {copied && <span className="muted" style={{ fontSize: 11.5 }}>{copied}</span>}
        </span>
      </div>

      {/* ② 핵심 수치 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginTop: 12 }}>
        {reportCards(f).map((c) => (
          <div key={c.k} style={{ padding: '10px 12px', minWidth: 0, borderRadius: 8, background: 'var(--panel-deep)', border: '1px solid var(--border-soft)' }}>
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{c.label}</div>
            <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4, wordBreak: 'break-word', fontVariantNumeric: 'tabular-nums' }}>{c.value}</div>
          </div>
        ))}
      </div>
      {ratio !== null && (
        <div style={{ marginTop: 10 }}>
          <div style={{ ...ROW, justifyContent: 'space-between', fontSize: 12, color: 'var(--text-dim)' }}>
            <span>저장 효율 — 읽은 양 대비 볼륨에 쓴 양</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{Math.round(ratio * 100)}% 저장 · {Math.round((1 - ratio) * 100)}% 절감</span>
          </div>
          <div style={{ height: 8, borderRadius: 99, background: 'var(--border-soft)', overflow: 'hidden', marginTop: 4 }}>
            <div style={{ width: `${Math.round(ratio * 100)}%`, height: '100%', borderRadius: 99, background: 'var(--accent)' }} />
          </div>
        </div>
      )}

      {/* ③ 상태 */}
      <div style={SECTION}>상태</div>
      <div style={{ ...ROW, gap: 6 }}>
        <span style={chip(okStatus(f['FD termination status']))}>FD 종료 {f['FD termination status'] || '—'}</span>
        <span style={chip(okStatus(f['SD termination status']))}>SD 종료 {f['SD termination status'] || '—'}</span>
        <span style={chip(fdErr === null ? null : fdErr === 0)}>FD 오류 {fdErr ?? '—'}</span>
        <span style={chip(sdErr === null ? null : sdErr === 0)}>SD 오류 {sdErr ?? '—'}</span>
      </div>

      {/* ④ 세부 */}
      {detail.length > 0 && (
        <>
          <div style={SECTION}>세부</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', columnGap: 18, rowGap: 6, fontSize: 12.5 }}>
            {detail.map((k) => (
              <div key={k} style={{ display: 'flex', gap: 10, minWidth: 0, paddingBottom: 4, borderBottom: '1px solid var(--border-soft)' }}>
                <span style={{ flex: '0 0 112px', color: 'var(--text-faint)' }}>{REPORT_KEYS[k]}</span>
                <span style={{ minWidth: 0, wordBreak: 'break-word' }}>{reportValue(f[k])}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ⑤ 경고·오류 */}
      <IssueList rep={rep} />
    </div>
  );
}

function IssueList({ rep }) {
  if (!rep.issues.length) return <><div style={SECTION}>경고·오류</div><div className="muted" style={{ fontSize: 12 }}>경고·오류 줄이 없습니다.</div></>;
  return (
    <>
      <div style={SECTION}>경고·오류 {rep.issues.length}종{rep.issuesMore ? ` (그 밖 ${rep.issuesMore}종은 원문 로그에서)` : ''}</div>
      <div style={{ display: 'grid', gap: 6 }}>
        {rep.issues.map((x) => {
          const hint = issueHint(x.text);
          const bad = /Fatal|Error/i.test(x.text) && !/^.{0,80}Warning/i.test(x.text);
          return (
            <div key={x.text} style={{ padding: '8px 10px', borderRadius: 8, background: 'var(--panel-deep)', borderLeft: `3px solid ${bad ? '#f87171' : '#fbbf24'}`, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.55, wordBreak: 'break-word' }}>
                {x.text}{x.count > 1 ? <span className="badge gray" style={{ marginLeft: 6, fontSize: 10.5 }}>×{x.count}</span> : null}
              </div>
              {hint && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>→ {hint}</div>}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** 복원 — 복원 지점 → 방식 → (덮어쓰기면 이름 재입력) → 본인 OTP. 서버가 전제와 체인을 다시 검사한다. */
function RestoreModal({ job, onClose, onDone }) {
  const [pts, setPts] = useState(null);
  const [ptsErr, setPtsErr] = useState(null);
  const [jobid, setJobid] = useState(null);
  const [mode, setMode] = useState('newVm');
  const [nv, setNv] = useState({ name: `${job.vmName}-restored`, datastore: '', cluster: '' });
  const [confirmName, setConfirmName] = useState('');
  const [otp, setOtp] = useState('');
  const [dss, setDss] = useState([]);
  const [clusters, setClusters] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => {
    fetchJson(`${BASE}/jobs/${enc(job.id)}/restore-points`, {}, undefined, DIRECTOR_GET).then((r) => { setPts(r); if (r.items?.length) setJobid(r.items[0].jobid); }).catch(setPtsErr);
    fetchJson('/datastores', { vcenterId: job.vcenterId, limit: 2000 }).then((r) => setDss((r.items || []).map((x) => x.name))).catch(() => setDss([]));
    fetchJson('/hosts', { vcenterId: job.vcenterId, limit: 2000 }).then((r) => setClusters([...new Set((r.items || []).map((x) => x.cluster).filter((c) => c && c !== 'standalone'))])).catch(() => setClusters([]));
  }, [job.id, job.vcenterId]);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const body = { jobid, mode, otp, ...(mode === 'original' ? { confirmName } : {}), ...(mode === 'newVm' ? { newVm: { name: nv.name, datastore: nv.datastore || undefined, cluster: nv.cluster || undefined } } : {}) };
      const r = await postJson(`${BASE}/jobs/${enc(job.id)}/restore`, body);
      requireChanged(r);
      onDone(`복원을 시작했습니다(jobid ${r.jobid} · 원본 ${r.fromJobids.join(',')}). 진행은 실행 현황 탭에서 보입니다.`);
    } catch (e) { setErr(e.message); setOtp(''); } finally { setBusy(false); }   // W8: 쓴(또는 틀린) OTP 를 남기면 다시 누를 때 실패 횟수만 오른다
  };
  const ready = jobid && /^\d{6}$/.test(otp) && (mode !== 'original' || confirmName === job.vmName) && (mode !== 'newVm' || nv.name.trim());
  return (
    <Modal title={`복원 — ${job.vmName}`} onClose={onClose} width={760}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>{job.vcenterId} · {job.dc} · {job.folder} · 복원 FD ‘{pts?.restoreClient || job.client}’{pts?.restoreClient && pts.restoreClient !== job.client ? `(등록 때 ‘${job.client}’ — 지금의 사이트 매핑으로 복원합니다)` : ''} · 원래 vCenter 로만 복원합니다(Bareos 플러그인 제약).</div>
      {job.drift && <div className="banner warn" style={{ marginBottom: 10 }}>{driftText(job.drift)}</div>}
      {/-r\d$/.test(job.bareosJob) && <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>이 대상은 다시 등록한 잡(‘{job.bareosJob}’)입니다 — 지우기 전 잡의 백업은 여기 나오지 않습니다(Director 에서 그 잡 이름으로 복원하세요).</div>}
      {pts?.restorePending && <div className="banner bad" style={{ marginBottom: 10 }}>이 대상의 다른 복원이 진행 중입니다 — 끝난 뒤 다시 시도하세요.</div>}
      <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px', minWidth: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 6 }}>1. 복원 지점 <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>(성공한 백업 — 체인은 서버가 Director 카탈로그로 계산)</span></legend>
        {ptsErr && <ErrorBox error={ptsErr} />}
        {!pts && !ptsErr && <Loading />}
        {pts && !pts.items.length && <div className="muted">성공한 백업이 없습니다.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 180, overflow: 'auto' }}>
          {(pts?.items || []).slice(0, RESTORE_POINTS_SHOWN).map((p) => (
            <label key={p.jobid} htmlFor={`bareos-rp-${p.jobid}`} style={{ ...ROW, padding: '6px 10px', border: `1px solid ${jobid === p.jobid ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 8, cursor: 'pointer' }}>
              <input type="radio" name="bareos-rp" id={`bareos-rp-${p.jobid}`} checked={jobid === p.jobid} onChange={() => setJobid(p.jobid)} />
              <b>{whenText(p.startedAt)}</b><span>{levelLabel(p.level)} · jobid {p.jobid}</span>
              <span className={`badge ${stateBadge(p.state, p.status).cls}`}>{stateBadge(p.state, p.status).label}</span>
              <span className="muted" style={{ fontSize: 12 }}>{bytesText(p.bytes)}</span>
            </label>
          ))}
        </div>
        {pts && <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>{restorePointsNote(pts, RESTORE_POINTS_SHOWN)}</div>}
      </fieldset>
      <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px', minWidth: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 6 }}>2. 복원 방식</legend>
        {Object.entries(RESTORE_MODE_LABEL).map(([k, l]) => (
          <label key={k} htmlFor={`bareos-mode-${k}`} style={{ ...ROW, padding: '4px 0', cursor: 'pointer' }}>
            <input type="radio" name="bareos-mode" id={`bareos-mode-${k}`} checked={mode === k} disabled={k === 'original' && !!job.drift} onChange={() => setMode(k)} />
            <span>{l}</span>
            <span className="muted" style={{ fontSize: 12 }}>
              {k === 'original' ? '— 파괴적: VM 이 꺼져 있고 스냅샷이 없어야 합니다(서버가 인벤토리로 확인)' : k === 'newVm' ? '— 새 MAC·UUID 로 만들고 꺼진 채로 둡니다(정적 IP 충돌 방지)' : '— FD 의 /tmp/bareos-restores/ 에 VMDK 로 풉니다(운영자용)'}
            </span>
          </label>
        ))}
        {mode === 'newVm' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, marginTop: 6 }}>
            <label className="muted" style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>새 VM 이름
              <input className="input" id="bareos-nv-name" style={INP} value={nv.name} onChange={(e) => setNv({ ...nv, name: e.target.value })} />
            </label>
            <label className="muted" style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>데이터스토어
              <Select className="input" id="bareos-nv-ds" style={INP} value={nv.datastore} onChange={(e) => setNv({ ...nv, datastore: e.target.value })}>
                <option value="">— (백업 당시 그대로)</option>
                {dss.map((x) => <option key={x} value={x}>{x}</option>)}
              </Select>
            </label>
            <label className="muted" style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>클러스터
              <Select className="input" id="bareos-nv-cl" style={INP} value={nv.cluster} onChange={(e) => setNv({ ...nv, cluster: e.target.value })}>
                <option value="">— (백업 당시 그대로)</option>
                {clusters.map((x) => <option key={x} value={x}>{x}</option>)}
              </Select>
            </label>
          </div>
        )}
        {mode === 'original' && (
          <label className="muted" style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6, maxWidth: 320 }}>덮어쓰기 확인 — VM 이름 ‘{job.vmName}’ 을 그대로 입력
            <input className="input" id="bareos-confirm" style={INP} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" />
          </label>
        )}
      </fieldset>
      <label className="muted" style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 220 }}>3. 본인 OTP(6자리)
        <input className="input" id="bareos-otp" style={INP} inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} />
      </label>
      {err && <div className="banner bad" style={{ marginTop: 10 }}>{err}</div>}
      <div style={{ ...ROW, marginTop: 12 }}>
        <span className="muted" style={{ fontSize: 12 }}>실행자·대상·원본 체인은 감사 로그에 남습니다.</span>
        <div style={{ flexGrow: 1 }} />
        <button type="button" className="logout-btn" style={{ padding: '7px 14px' }} onClick={onClose}>취소</button>
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={!ready || busy || pts?.restorePending} onClick={submit}>{busy ? '요청 중…' : '복원 시작'}</button>
      </div>
    </Modal>
  );
}

/* ───────────────────────── 실행 현황 · 이력 ───────────────────────── */
function HistoryTab({ d }) {
  const [sel, setSel] = useState(d.jobs[0]?.id || '');
  const [hist, setHist] = useState(null);
  const [err, setErr] = useState(null);
  const [logOf, setLogOf] = useState(null);
  const gen = useRef(0);
  const [limit, setLimit] = useState(null);
  const job = d.jobs.find((j) => j.id === sel);
  // W10: 고른 대상이 지워지면 첫 대상으로(예전에는 job 이 없어 '보기' 가 화면 오류를 냈다)
  useEffect(() => { if (sel && !job) setSel(d.jobs[0]?.id || ''); }, [sel, job, d.jobs]);
  const load = () => {
    const g = ++gen.current;
    setHist(null); setErr(null);
    if (!sel) return;
    fetchJson(`${BASE}/jobs/${enc(sel)}/history`, {}, undefined, DIRECTOR_GET).then((r) => { if (g === gen.current) { setHist(r.items || []); setLimit(r.limit ?? null); } }).catch((e) => { if (g === gen.current) setErr(e); });
  };
  useEffect(load, [sel]);
  // W5: 포탈이 시작한 실행 + Bareos 스케줄이 돌리는 실행(대조가 넣은 lastRun — 대조 주기만큼 늦을 수 있다)
  const running = d.jobs.filter((j) => j.pending?.jobid || ['running', 'queued', 'waiting'].includes(j.lastRun?.state));
  const restores = d.jobs.flatMap((j) => (j.restores || []).map((r) => ({ ...r, job: j }))).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 50);
  return (
    <div>
      <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>실행 중 백업 {running.length}건</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 10, marginBottom: 14 }}>
        {running.length === 0 && <div className="muted" style={{ fontSize: 12.5, gridColumn: '1 / -1' }}>없음 — Bareos 스케줄이 돌린 실행은 상태 대조 때 반영됩니다(대조 주기만큼 늦을 수 있습니다).</div>}
        {running.map((j) => { const c = runCell(j); return (
          <div key={j.id} className="card" style={{ padding: '10px 12px', minWidth: 0, borderLeft: '3px solid var(--accent-2)' }}>
            <div style={ROW}><b>{j.vmName}</b><span className="muted" style={{ fontSize: 12 }}>{j.vcenterId}</span>{c.badge && <span className={`badge ${c.badge.cls}`}>{c.badge.label}</span>}</div>
            <div className="muted" style={{ fontSize: 12 }}>{c.when} 시작 · {c.note} · FD ‘{j.client}’</div>
          </div>
        ); })}
      </div>

      <div style={{ ...ROW, marginBottom: 8 }}>
        <label htmlFor="bareos-hist-sel" className="muted" style={{ fontSize: 12 }}>대상</label>
        <Select id="bareos-hist-sel" className="input" value={sel} onChange={(e) => setSel(e.target.value)} style={{ minWidth: 220 }}>
          {d.jobs.length === 0 && <option value="">— 대상 없음</option>}
          {d.jobs.map((j) => <option key={j.id} value={j.id}>{j.vmName} · {j.vcenterId}</option>)}
        </Select>
        <button type="button" className="logout-btn" style={BTN} onClick={load} disabled={!sel}>새로 고침</button>
        <span className="muted" style={{ fontSize: 12 }}>Director 카탈로그 {Number.isInteger(limit) ? `최근 ${limit}건` : '최근 실행'} · 상태 코드 T 성공 · W 경고 · E·f 오류 · A 취소 · R 실행 중 · C 대기</span>
      </div>
      {err && <ErrorBox error={err} />}
      {sel && !hist && !err && <Loading />}
      {hist && (
        <div className="table-wrap" style={{ maxHeight: '40vh', marginBottom: 14 }}>
          <STable minWidth={820} wrap={false}>
            <thead><tr><th>jobid</th><th>레벨</th><th>시작</th><th>종료</th><th className="right">바이트</th><th className="right">파일</th><th>상태</th><th data-nosort>로그</th></tr></thead>
            <tbody>
              {hist.length === 0 && <tr><td colSpan={8} className="center muted" style={{ padding: 16 }}>실행 이력이 없습니다.</td></tr>}
              {hist.map((r) => { const b = stateBadge(r.state, r.status); return (
                <tr key={r.jobid}>
                  <td data-sort={r.jobid}>{r.jobid}</td><td>{levelLabel(r.level)}</td>
                  <td data-sort={r.startedAt ?? ''}>{whenText(r.startedAt)}</td><td data-sort={r.endedAt ?? ''}>{whenText(r.endedAt)}</td>
                  <td className="right" data-sort={r.bytes ?? ''}>{bytesText(r.bytes)}</td><td className="right" data-sort={r.files ?? ''}>{r.files ?? '—'}</td>
                  <td><span className={`badge ${b.cls}`}>{b.label}</span></td>
                  <td><button type="button" className="logout-btn" style={BTN} disabled={!job} onClick={() => job && setLogOf({ job, jobid: r.jobid, view: 'summary' })}>보기</button></td>
                </tr>
              ); })}
            </tbody>
          </STable>
        </div>
      )}

      <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>복원 이력(대상마다 최근 기록 — 전체는 Director 카탈로그)</div>
      <div className="table-wrap" style={{ maxHeight: '30vh' }}>
        <STable minWidth={760} wrap={false}>
          <thead><tr><th>복원 jobid</th><th>VM</th><th>방식 · 대상</th><th>요청</th><th>상태</th><th data-nosort>로그</th></tr></thead>
          <tbody>
            {restores.length === 0 && <tr><td colSpan={6} className="center muted" style={{ padding: 14 }}>복원 이력이 없습니다.</td></tr>}
            {restores.map((r) => { const b = stateBadge(r.state, r.status); return (
              <tr key={`${r.job.id}-${r.jobid}`}>
                <td data-sort={r.jobid}>{r.jobid}</td><td>{r.job.vmName}</td>
                <td style={{ fontSize: 12 }}>{restoreLine(r)}</td><td data-sort={r.at ?? ''}>{whenText(r.at)}</td>
                <td><span className={`badge ${b.cls}`}>{b.label}</span></td>
                <td><button type="button" className="logout-btn" style={BTN} onClick={() => setLogOf({ job: r.job, jobid: r.jobid, view: 'summary' })}>보기</button></td>
              </tr>
            ); })}
          </tbody>
        </STable>
      </div>
      {logOf && <LogModal job={logOf.job} jobid={logOf.jobid} view={logOf.view} onClose={() => setLogOf(null)} />}
    </div>
  );
}

/** v2.822 단계별 연결 진단 — 단계마다 ✓/✗/시도 안 함 · 걸린 시간 · 내용 · (실패면) 조치. 문구는 서버(console.diagnoseConsole)가 만든다. */
function DiagStages({ stages }) {
  return (
    <ol aria-label="연결 진단 단계" style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {stages.map((x) => {
        const v = diagView(x);
        return (
          <li key={x.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 17em) minmax(0, 1fr)', gap: 8, alignItems: 'baseline', fontSize: 12 }}>
            <span style={{ minWidth: 0, wordBreak: 'keep-all' }}><span className={`badge ${v.cls}`} style={{ fontSize: 10.5 }}>{v.mark}</span> {x.label}</span>
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              <span className={x.ok === false ? '' : 'muted'}>{x.detail || '—'}</span>{v.ms && <span className="muted"> · {v.ms}</span>}
              {x.hint && <div style={{ color: 'var(--amber)', marginTop: 2 }}>조치: {x.hint}</div>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* ───────────────────────── 설정(전체 범위 관리자) ───────────────────────── */
function SettingsTab({ onSaved }) {
  const [s, setS] = useState(null);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState(null);
  const [cat, setCat] = useState(null);
  const [catErr, setCatErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [addVc, setAddVc] = useState('');
  const [diag, setDiag] = useState(null);   // v2.822 단계별 연결 진단 결과(stages)
  // keepEdits: 자동 설정이 Director 연결만 바꿨을 때 — 저장하지 않은 기본값·사이트 표 편집은 버리지 않는다.
  const fetchSettings = (keepEdits) => fetchJson(`${BASE}/settings`).then((r) => {
    setS(r); setErr(null);
    const director = { host: r.director.host, port: r.director.port, consoleName: r.director.consoleName, password: '', timeoutMs: r.director.timeoutMs, tlsMax: r.director.tlsMax };
    setForm((f) => (keepEdits && f ? { ...f, director } : { director, defaults: { ...r.defaults }, sites: r.sites.map((x) => ({ ...x })) }));
  }).catch(setErr);
  const load = () => fetchSettings(false);
  const catGen = useRef(0);
  // W14: 늦게 온 이전 응답은 버린다(저장 직후 새로 읽기와 겹칠 때) · W2: 재시도 없음
  const loadCat = (refresh) => {
    const g = ++catGen.current;
    setCatErr(null);
    fetchJson(`${BASE}/catalog`, refresh ? { refresh: 1 } : {}, undefined, DIRECTOR_GET).then((r) => { if (g === catGen.current) setCat(r); }).catch((e) => { if (g === catGen.current) setCatErr(e); });
  };
  useEffect(() => { fetchSettings(false); loadCat(false); }, []);
  if (err && !s) return <ErrorBox error={err} />;
  if (!s || !form) return <Loading />;
  const setDir = (k, v) => setForm({ ...form, director: { ...form.director, [k]: v } });
  const setDef = (k, v) => setForm({ ...form, defaults: { ...form.defaults, [k]: v } });
  const setSite = (i, k, v) => setForm({ ...form, sites: form.sites.map((x, j) => (j === i ? { ...x, [k]: v } : x)) });
  const vcName = (id) => s.vcenters.find((v) => v.id === id)?.name || id;
  const unmapped = s.vcenters.filter((v) => !form.sites.some((x) => x.vcenterId === v.id));
  const opts = (k, cur) => { const list = cat?.[k] || []; return [...new Set([...(cur ? [cur] : []), ...list])]; };

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      // Director 연결은 읽어 온 값과 달라진 칸만(directorPatch — W2-1·P2-1: 옛 사본을 통째로 보내 새 콘솔 비밀번호를 폐기하던 것)
      const dir = directorPatch(form.director, s.director);
      const body = { ...(dir ? { director: dir } : {}), defaults: { ...form.defaults, pollIntervalSec: Number(form.defaults.pollIntervalSec) || undefined }, sites: form.sites };
      const r = await putJson(`${BASE}/settings`, body);
      requireChanged(r);
      const dropped = droppedSecretNote(r);
      setMsg({ ok: true, text: `저장했습니다.${dropped ? ` ${dropped}` : ''}` });
      await load(); loadCat(true); onSaved();
    } catch (e) { setMsg({ ok: false, text: `저장 실패: ${e.message}` }); } finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true); setMsg(null); setDiag(null);
    try {
      const body = form.director.password ? { director: { ...form.director } } : {};
      const r = await postJson(`${BASE}/settings/test`, body);
      requireChanged(r);
      setDiag(r.stages || null);
      setMsg({ ok: true, text: `연결 성공 — Director ‘${r.director || '?'}’ ${r.version || ''} · ${r.tls ? `${r.tls.protocol} ${r.tls.cipher}` : '암호화 없음'} · 클라이언트 ${r.clients ? `${r.clients.length}개` : `조회 실패(${r.clientsError})`}${form.director.password ? '' : ' (저장된 주소·비밀번호로 시험)'}` });
    } catch (e) {
      setDiag(Array.isArray(e?.body?.stages) ? e.body.stages : null);
      setMsg({ ok: false, text: `연결 실패: ${e.message}` });
    } finally { setBusy(false); }
  };
  const copy = (text) => { try { navigator.clipboard.writeText(text).then(() => setMsg({ ok: true, text: '복사했습니다.' }), () => setMsg({ ok: false, text: '복사하지 못했습니다 — 글을 직접 선택해 복사하세요.' })); } catch { setMsg({ ok: false, text: '복사하지 못했습니다 — 글을 직접 선택해 복사하세요.' }); } };
  const field = { fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 };

  return (
    <div>
      {s.demo && <div className="card" style={{ ...NOTE, borderLeft: '3px solid var(--amber)' }}>데모 모드 — 아래 값은 메모리의 데모 설정입니다. 실제 Director 를 저장하면 그쪽으로 접속합니다.</div>}
      {s.loadError && <div className="banner bad" style={{ marginBottom: 10 }}>설정 파일을 읽지 못했습니다(손상본 보존) — {s.loadError.reason}</div>}
      {err && <div className="banner bad" role="alert" style={{ marginBottom: 10 }}>설정을 다시 읽지 못했습니다({String(err.message || err).slice(0, 160)}) — 화면 값이 최신이 아닐 수 있어 저장을 잠갔습니다. <button type="button" className="logout-btn" style={BTN} onClick={load}>다시 읽기</button></div>}
      {msg && <div className={`banner ${msg.ok ? 'ok' : 'bad'}`} style={{ marginBottom: 10 }}><BoldText text={msg.text} /></div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 12, marginBottom: 12 }}>
        <div className="card" style={{ padding: 14, minWidth: 0 }}>
          <b>Director 연결</b>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginTop: 8 }}>
            <label className="muted" style={field}>호스트<input className="input" id="bareos-dir-host" style={INP} value={form.director.host} onChange={(e) => setDir('host', e.target.value.trim())} placeholder="bareos-dir.corp" /></label>
            <label className="muted" style={field}>포트<input className="input" id="bareos-dir-port" style={INP} inputMode="numeric" value={form.director.port} onChange={(e) => setDir('port', e.target.value.replace(/\D/g, '').slice(0, 5))} /></label>
            <label className="muted" style={field}>콘솔 이름<input className="input" id="bareos-dir-console" style={INP} value={form.director.consoleName} onChange={(e) => setDir('consoleName', e.target.value)} placeholder="portal" /></label>
            <label className="muted" style={field}>콘솔 비밀번호 {s.director.hasPassword ? <span style={{ color: 'var(--green)' }}>저장됨</span> : <span style={{ color: 'var(--red)' }}>없음</span>}
              <input className="input" id="bareos-dir-pw" style={INP} type="password" autoComplete="new-password" value={form.director.password} onChange={(e) => setDir('password', e.target.value)} placeholder="바꿀 때만 입력" />
            </label>
            <label className="muted" style={field}>명령 시한(초)<input className="input" id="bareos-dir-timeout" style={INP} inputMode="numeric" value={Math.round((Number(form.director.timeoutMs) || 0) / 1000) || ''} onChange={(e) => setDir('timeoutMs', (Number(e.target.value.replace(/\D/g, '')) || 0) * 1000)} /></label>
            <label className="muted" style={field}>TLS 최고 버전
              <Select className="input" id="bareos-dir-tls" sort={false} style={INP} value={form.director.tlsMax} onChange={(e) => setDir('tlsMax', e.target.value)}>
                <option value="TLSv1.3">TLS 1.3(기본)</option><option value="TLSv1.2">TLS 1.2</option>
              </Select>
            </label>
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.6 }}>
            전송은 TLS-PSK 로만 합니다(평문 하향 없음). 저장된 비밀번호로 시험하면 저장된 주소로만 접속합니다. 주소·포트·콘솔 이름을 바꾸면 저장된 비밀번호는 승계하지 않습니다.
          </div>
          <div style={{ ...ROW, marginTop: 10 }}>
            <button type="button" className="logout-btn" style={{ padding: '7px 14px' }} disabled={busy} onClick={test}>{busy ? '시험 중…' : '연결 시험'}</button>
            <span className="muted" style={{ fontSize: 11.5 }}>주소 → DNS → TCP → TLS-PSK → 인증 → JSON 모드 → 시험 명령을 차례로 봅니다</span>
          </div>
          {diag && <DiagStages stages={diag} />}
        </div>
        <div className="card" style={{ padding: 14, minWidth: 0 }}>
          <div style={ROW}><b>기본값</b><span className="muted" style={{ fontSize: 12 }}>Director 카탈로그에서 고릅니다</span><div style={{ flexGrow: 1 }} /><button type="button" className="logout-btn" style={BTN} onClick={() => loadCat(true)}>카탈로그 새로 고침</button></div>
          {catErr && <div className="muted" style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>카탈로그를 읽지 못했습니다: {catErr.message} — 이름을 직접 확인하세요.</div>}
          {cat?.errors && Object.keys(cat.errors).length > 0 && <div className="muted" style={{ fontSize: 12, color: 'var(--amber)', marginTop: 6 }}>일부 목록을 읽지 못했습니다(그 칸의 선택지가 비어 있을 수 있습니다): {Object.entries(cat.errors).map(([k, v]) => `${k} — ${String(v).slice(0, 120)}`).join(' · ')}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginTop: 8 }}>
            {[['jobDefs', 'JobDefs', 'jobdefs'], ['fileSet', 'FileSet(범용)', 'filesets'], ['restoreJob', '복원 잡', null]].map(([k, l, ck]) => (
              <label key={k} className="muted" style={field}>{l}
                {ck && cat?.[ck] ? (
                  <Select className="input" id={`bareos-def-${k}`} style={INP} value={form.defaults[k]} onChange={(e) => setDef(k, e.target.value)}>
                    {opts(ck, form.defaults[k]).map((x) => <option key={x} value={x}>{x}</option>)}
                  </Select>
                ) : <input className="input" id={`bareos-def-${k}`} style={INP} value={form.defaults[k]} onChange={(e) => setDef(k, e.target.value.trim())} />}
              </label>
            ))}
            <label className="muted" style={field}>기본 레벨
              <Select className="input" id="bareos-def-level" sort={false} style={INP} value={form.defaults.level} onChange={(e) => setDef('level', e.target.value)}>
                <option value="Incremental">Incremental</option><option value="Differential">Differential</option><option value="Full">Full</option>
              </Select>
            </label>
            <label className="muted" style={field}>상태 조회 주기(초)<input className="input" id="bareos-def-poll" style={INP} inputMode="numeric" value={form.defaults.pollIntervalSec} onChange={(e) => setDef('pollIntervalSec', e.target.value.replace(/\D/g, '').slice(0, 4))} /></label>
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>스케줄은 Bareos Schedule 리소스가 돌립니다 — 포탈은 잡에 스케줄 이름만 배정합니다. 조회 주기 범위는 {s.limits?.pollIntervalSec ? `${s.limits.pollIntervalSec.min}~${s.limits.pollIntervalSec.max}초` : '—'}.</div>
        </div>
      </div>

      <div style={{ ...ROW, marginBottom: 6 }}>
        <b>사이트 매핑</b><span className="muted" style={{ fontSize: 12 }}>vCenter 마다 백업 데이터가 머무는 사이트 FD · SD · 풀</span>
        <div style={{ flexGrow: 1 }} />
        <Select className="input" id="bareos-site-add" value={addVc} onChange={(e) => setAddVc(e.target.value)} style={{ minWidth: 180 }} aria-label="매핑을 추가할 vCenter">
          <option value="">vCenter 선택…</option>
          {unmapped.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.id})</option>)}
        </Select>
        <button type="button" className="logout-btn" style={BTN} disabled={!addVc} onClick={() => { const v = s.vcenters.find((x) => x.id === addVc); setForm({ ...form, sites: [...form.sites, { vcenterId: addVc, vcserver: v?.host || '', client: '', storage: '', pool: '', schedule: '', configFile: `/etc/bareos/vmware/${addVc.replace(/[^A-Za-z0-9._-]/g, '-')}.ini` }] }); setAddVc(''); }}>+ 매핑 추가</button>
      </div>
      <div className="table-wrap" style={{ maxHeight: '44vh', marginBottom: 10 }}>
        <STable minWidth={1120} sortable={false}>
          <thead><tr><th>vCenter</th><th>vcserver(FD 가 보는 주소)</th><th>FD client</th><th>SD storage</th><th>Pool</th><th>Schedule</th><th>FD INI 경로</th><th>작업</th></tr></thead>
          <tbody>
            {form.sites.length === 0 && <tr><td colSpan={8} className="center muted" style={{ padding: 16 }}>매핑이 없습니다 — 매핑이 없는 vCenter 의 VM 은 백업 대상으로 등록할 수 없습니다.</td></tr>}
            {form.sites.map((x, i) => (
              <tr key={x.vcenterId}>
                <td><b>{vcName(x.vcenterId)}</b><div className="muted" style={{ fontSize: 11 }}>{x.vcenterId}</div></td>
                <td><input className="input" aria-label="vcserver" value={x.vcserver} onChange={(e) => setSite(i, 'vcserver', e.target.value.trim())} style={{ ...INP, width: 170 }} /></td>
                {[['client', 'clients'], ['storage', 'storages'], ['pool', 'pools'], ['schedule', 'schedules']].map(([k, ck]) => (
                  <td key={k}>{cat?.[ck] ? (
                    <Select className="input" aria-label={k} value={x[k]} onChange={(e) => setSite(i, k, e.target.value)} style={{ ...INP, width: 130 }}>
                      <option value="">{k === 'schedule' ? '— (수동)' : '선택…'}</option>
                      {opts(ck, x[k]).map((n) => <option key={n} value={n}>{n}</option>)}
                    </Select>
                  ) : <input className="input" aria-label={k} value={x[k]} onChange={(e) => setSite(i, k, e.target.value.trim())} style={{ ...INP, width: 120 }} />}</td>
                ))}
                <td><input className="input" aria-label="INI 경로" value={x.configFile} onChange={(e) => setSite(i, 'configFile', e.target.value.trim())} style={{ ...INP, width: 220 }} /></td>
                <td><span style={{ ...ROW, gap: 6 }}>
                  <button type="button" className="logout-btn" style={BTN} onClick={() => copy(fdIniTemplate(x))}>INI 내용 복사</button>
                  <button type="button" className="logout-btn" style={{ ...BTN, color: 'var(--red)' }} onClick={() => setForm({ ...form, sites: form.sites.filter((_, j) => j !== i) })}>빼기</button>
                </span></td>
              </tr>
            ))}
          </tbody>
        </STable>
      </div>
      <div style={{ ...ROW, marginBottom: 14 }}>
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy || !!err} title={err ? '설정을 다시 읽은 뒤 저장할 수 있습니다' : undefined} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
        <span className="muted" style={{ fontSize: 12 }}>매핑을 바꿔도 이미 만든 Director 잡은 바뀌지 않습니다(새로 등록하는 대상부터 적용).</span>
      </div>

      <AutoSetupCards s={s} cat={cat} form={form} onDirectorDone={async () => { await fetchSettings(true); loadCat(true); onSaved(); }} onMaybeChanged={() => fetchSettings(true)} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 12 }}>
        <div className="card" style={{ padding: 14, minWidth: 0 }}>
          <div style={ROW}><b>사전 준비 — Director 에 1회 넣을 블록</b><div style={{ flexGrow: 1 }} /><button type="button" className="logout-btn" style={BTN} onClick={() => copy(directorPrepBlock({ defaults: form.defaults, consoleName: form.director.consoleName, anyClient: form.sites[0]?.client || 'kr-fd', anyStorage: form.sites[0]?.storage || 'File', anyPool: form.sites[0]?.pool || 'VMwarePool' }))}>복사</button></div>
          <pre style={{ margin: '8px 0 0', padding: 10, maxHeight: 280, overflow: 'auto', fontSize: 11.5, lineHeight: 1.55, background: 'var(--panel-deep)', borderRadius: 8 }}>{directorPrepBlock({ defaults: form.defaults, consoleName: form.director.consoleName, anyClient: form.sites[0]?.client || 'kr-fd', anyStorage: form.sites[0]?.storage || 'File', anyPool: form.sites[0]?.pool || 'VMwarePool' })}</pre>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>Profile 의 ACL 지시어 이름은 설치한 Director 버전 문서로 한 번 확인하세요. 넣은 뒤 Director 를 reload 합니다.</div>
        </div>
        <div className="card" style={{ padding: 14, minWidth: 0 }}>
          <b>사전 준비 체크리스트</b>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7 }}>
            {PREP_CHECKLIST.map((t) => <li key={t}>{t}</li>)}
          </ul>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>vCenter 비밀번호는 포탈에 저장하지 않습니다 — 각 사이트 FD 의 INI 파일에 직접 넣거나(행의 ‘INI 내용 복사’) 위 ‘FD INI 자동 설정’ 을 쓰세요(그 요청에서만 전달하고 저장하지 않습니다).</div>
        </div>
      </div>
    </div>
  );
}

/**
 * 자동 설정(v2.821) — Bareos 서버의 주소·SSH root 계정·비밀번호로 포탈이 사전 준비를 대신한다(서버 bareos/autoSetup.js).
 * SSH·vCenter 비밀번호는 요청 1회에만 쓰고 저장하지 않는다 · 쓰기는 본인 OTP · 포탈이 만들지 않은 파일은 덮어쓰지 않는다.
 * FD 쪽은 **저장된** 사이트 매핑(INI 경로·vcserver)을 쓴다 — 표에서 고친 뒤 저장하지 않은 값은 쓰지 않는다.
 */
function AutoSetupCards({ s, cat, form, onDirectorDone, onMaybeChanged }) {
  const first = s.sites[0] || {};
  const [d, setD] = useState({ host: s.director.host || '', sshPort: '22', username: 'root', password: '', directorPort: String(s.director.port || 9101), consoleName: 'portal', restoreClient: first.client || '', restoreStorage: first.storage || '', restorePool: first.pool || '', otp: '' });
  const [f, setF] = useState({ vcenterId: first.vcenterId || '', host: '', sshPort: '22', username: 'root', password: '', vcuser: '', vcpass: '', vcthumbprint: '', otp: '' });
  const [busy, setBusy] = useState('');
  const [dMsg, setDMsg] = useState(null);
  const [fMsg, setFMsg] = useState(null);
  const field = { fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 };
  const GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginTop: 8 };
  const setDk = (k, v) => setD((x) => ({ ...x, [k]: v }));
  // W2-3: 대상 vCenter·FD 주소가 바뀌면 읽어 둔 지문은 그 대상의 것이 아니다 — 비운다
  const setFk = (k, v) => setF((x) => ({ ...x, [k]: v, ...((k === 'vcenterId' || k === 'host') && x[k] !== v ? { vcthumbprint: '' } : {}) }));
  useEffect(() => { setFMsg(null); }, [f.vcenterId, f.host]);
  const vcLabel = (id) => s.vcenters.find((v) => v.id === id)?.name || id;
  const site = s.sites.find((x) => x.vcenterId === f.vcenterId);
  const unsaved = JSON.stringify(form.sites) !== JSON.stringify(s.sites);
  const nameSel = (k, list, label) => (
    <label className="muted" style={field}>{label}
      {list ? (
        <Select className="input" style={INP} value={d[k]} onChange={(e) => setDk(k, e.target.value)} aria-label={label}>
          <option value="">선택…</option>
          {[...new Set([...(d[k] ? [d[k]] : []), ...list])].map((n) => <option key={n} value={n}>{n}</option>)}
        </Select>
      ) : <input className="input" style={INP} value={d[k]} onChange={(e) => setDk(k, e.target.value.trim())} aria-label={label} />}
    </label>
  );
  const sshFields = (v, set, prefix, ph) => (
    <>
      <label className="muted" style={field}>서버 주소<input className="input" id={`${prefix}-host`} style={INP} value={v.host} onChange={(e) => set('host', e.target.value.trim())} placeholder={ph} /></label>
      <label className="muted" style={field}>SSH 포트<input className="input" style={INP} inputMode="numeric" value={v.sshPort} onChange={(e) => set('sshPort', e.target.value.replace(/\D/g, '').slice(0, 5))} aria-label="SSH 포트" /></label>
      <label className="muted" style={field}>SSH 계정(root)<input className="input" style={INP} value={v.username} onChange={(e) => set('username', e.target.value.trim())} aria-label="SSH 계정" /></label>
      <label className="muted" style={field}>SSH 비밀번호<input className="input" id={`${prefix}-pw`} style={INP} type="password" autoComplete="new-password" value={v.password} onChange={(e) => set('password', e.target.value)} placeholder="저장하지 않습니다" /></label>
    </>
  );
  const otpField = (v, set, id) => (
    <label className="muted" style={field}>OTP(본인)<input className="input" id={id} style={INP} inputMode="numeric" autoComplete="one-time-code" value={v.otp} onChange={(e) => set('otp', e.target.value.replace(/\D/g, '').slice(0, 6))} /></label>
  );

  const runDirector = async () => {
    setBusy('director'); setDMsg(null);
    try {
      const r = await postJson(`${BASE}/settings/auto-setup/director`, { ...d, sshPort: Number(d.sshPort) || 22, directorPort: Number(d.directorPort) || 9101 });
      requireChanged(r);
      setDMsg({ ok: true, text: autoSetupDirectorText(r) });
      setD((x) => ({ ...x, password: '', otp: '' }));
      await onDirectorDone();
    } catch (e) {
      if (outcomeUnknown(e)) {
        // 응답을 받지 못했다(연결 끊김·브라우저 시한) — 서버는 끝까지 돌아 연결을 바꿨을 수 있다(W2-2·P2-1). 단정하지 않고 설정을 다시 읽는다.
        setDMsg({ ok: false, text: `Director 자동 설정 결과를 확인하지 못했습니다(${e.message}) — 서버에서는 계속 진행됐을 수 있습니다. 잠시 뒤 설정을 다시 읽어 Director 연결을 확인하세요(감사 로그에 결과가 남습니다).` });
        onMaybeChanged?.();
      } else setDMsg({ ok: false, text: `Director 자동 설정 실패: ${e.message}` });
      setD((x) => ({ ...x, otp: '', ...(e?.body?.code === 'ssh-auth' ? { password: '' } : {}) }));   // W2-5: 틀린 비밀번호를 남겨 같은 인증을 되풀이하지 않게
    } finally { setBusy(''); }
  };
  const readThumb = async () => {
    setBusy('thumb'); setFMsg(null);
    const want = { vcenterId: f.vcenterId, host: f.host };
    try {
      const r = await postJson(`${BASE}/settings/auto-setup/fd-thumbprint`, { vcenterId: f.vcenterId, host: f.host, sshPort: Number(f.sshPort) || 22, username: f.username, password: f.password });
      requireChanged(r);
      // W2-3: 그사이 대상이 바뀌었거나 응답이 다른 vCenter 의 것이면 버린다(다른 vCenter 의 INI 에 엉뚱한 지문이 실리던 것)
      if (r.vcenterId && r.vcenterId !== want.vcenterId) throw new Error('응답이 고른 vCenter 의 것이 아닙니다 — 다시 읽으세요.');
      setF((x) => (x.vcenterId === want.vcenterId && x.host === want.host ? { ...x, vcthumbprint: r.thumbprint } : x));
      setFMsg({ ok: true, text: thumbprintText(r) });
    } catch (e) {
      setFMsg({ ok: false, text: `지문 읽기 실패: ${e.message}` });
      if (e?.body?.code === 'ssh-auth') setFk('password', '');
    } finally { setBusy(''); }
  };
  const runFd = async () => {
    setBusy('fd'); setFMsg(null);
    try {
      const r = await postJson(`${BASE}/settings/auto-setup/fd`, { ...f, sshPort: Number(f.sshPort) || 22 });
      requireChanged(r);
      setFMsg({ ok: true, text: autoSetupFdText(r) });
      setF((x) => ({ ...x, password: '', vcpass: '', otp: '' }));
    } catch (e) {
      setFMsg({ ok: false, text: outcomeUnknown(e) ? `FD INI 자동 설정 결과를 확인하지 못했습니다(${e.message}) — FD 에서 파일이 바뀌었을 수 있습니다(감사 로그 확인).` : `FD INI 자동 설정 실패: ${e.message}` });
      setF((x) => ({ ...x, otp: '', ...(e?.body?.code === 'ssh-auth' ? { password: '' } : {}) }));
    } finally { setBusy(''); }
  };
  const dReady = d.host && d.password && d.restoreClient && d.restoreStorage && d.restorePool && /^\d{6}$/.test(d.otp) && !busy;
  const sshReady = f.vcenterId && site && f.host && f.password && !busy;
  const fReady = sshReady && f.vcuser && f.vcpass && f.vcthumbprint && /^\d{6}$/.test(f.otp);
  // W2-8: 잠긴 버튼은 사유를 말한다
  const dMissing = busy ? '' : missingText([[d.host, '서버 주소'], [d.password, 'SSH 비밀번호'], [d.restoreClient && d.restoreStorage && d.restorePool, '복원 잡 FD·스토리지·풀'], [/^\d{6}$/.test(d.otp), 'OTP 6자리']]);
  const fMissing = busy ? '' : missingText([[f.vcenterId && site, '매핑된 vCenter'], [f.host, '서버 주소'], [f.password, 'SSH 비밀번호'], [f.vcuser && f.vcpass, 'vCenter 계정·비밀번호'], [f.vcthumbprint, '지문'], [/^\d{6}$/.test(f.otp), 'OTP 6자리']]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 12, marginBottom: 12 }}>
      <div className="card" style={{ padding: 14, minWidth: 0 }}>
        <b>Director 자동 설정</b>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 4, lineHeight: 1.6 }}>
          아래 ‘사전 준비’ 블록의 5개 리소스를 bareos-dir.d 에 넣고 설정 검사 → reload → 새 콘솔로 접속을 확인한 뒤, 포탈의 Director 연결을 그 콘솔로 바꿉니다.
          포탈이 만들지 않은 같은 이름의 파일이 있으면 아무것도 바꾸지 않고 멈추고, 검사가 실패하면 넣은 파일을 되돌립니다.
          처음 접속하는 서버는 SSH 호스트키 승인(설정 › 장비 신뢰)이 먼저 필요할 수 있습니다 — 거부되면 비밀번호는 보내지 않습니다.
        </div>
        <div style={GRID}>
          {sshFields(d, setDk, 'bareos-auto-dir', 'bareos-dir.corp')}
          <label className="muted" style={field}>Director 포트<input className="input" style={INP} inputMode="numeric" value={d.directorPort} onChange={(e) => setDk('directorPort', e.target.value.replace(/\D/g, '').slice(0, 5))} aria-label="Director 포트" /></label>
          <label className="muted" style={field}>만들 콘솔 이름<input className="input" style={INP} value={d.consoleName} onChange={(e) => setDk('consoleName', e.target.value.trim())} aria-label="만들 콘솔 이름" /></label>
          {nameSel('restoreClient', cat?.clients, '복원 잡 FD')}
          {nameSel('restoreStorage', cat?.storages, '복원 잡 스토리지')}
          {nameSel('restorePool', cat?.pools, '복원 잡 풀')}
          {otpField(d, setDk, 'bareos-auto-dir-otp')}
        </div>
        <div style={{ ...ROW, marginTop: 10 }}>
          <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={!dReady} onClick={runDirector}>{busy === 'director' ? '설정 중…' : 'Director 자동 설정'}</button>
          <span className="muted" style={{ fontSize: 11.5 }}>{dMissing || 'root 로 접속합니다 · 비밀번호는 저장하지 않습니다'}</span>
        </div>
        {dMsg && <div className={`banner ${dMsg.ok ? 'ok' : 'bad'}`} role={dMsg.ok ? 'status' : 'alert'} style={{ marginTop: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}><BoldText text={dMsg.text} /></div>}
      </div>

      <div className="card" style={{ padding: 14, minWidth: 0 }}>
        <b>FD INI 자동 설정</b>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 4, lineHeight: 1.6 }}>
          저장된 사이트 매핑의 INI 경로에 vCenter 자격증명 INI(bareos 소유 0600)를 씁니다. vCenter 비밀번호는 이 요청에서만 FD 로 전달하고 포탈에 저장하지 않습니다.
          지문은 ‘FD 에서 지문 읽기’ 로 채운 뒤 vCenter 의 실제 값과 대조하세요.
        </div>
        {unsaved && <div className="muted" style={{ fontSize: 11.5, marginTop: 6, color: 'var(--amber)' }}>사이트 매핑 표에 저장하지 않은 변경이 있습니다 — 여기서는 저장된 매핑을 씁니다.</div>}
        <div style={GRID}>
          <label className="muted" style={field}>vCenter(매핑)
            <Select className="input" style={INP} value={f.vcenterId} onChange={(e) => setFk('vcenterId', e.target.value)} aria-label="매핑된 vCenter">
              <option value="">선택…</option>
              {s.sites.map((x) => <option key={x.vcenterId} value={x.vcenterId}>{vcLabel(x.vcenterId)}</option>)}
            </Select>
          </label>
          {sshFields(f, setFk, 'bareos-auto-fd', '사이트 FD 서버 주소')}
          <label className="muted" style={field}>vCenter 계정<input className="input" style={INP} value={f.vcuser} onChange={(e) => setFk('vcuser', e.target.value)} placeholder="backup@vsphere.local" aria-label="vCenter 계정" /></label>
          <label className="muted" style={field}>vCenter 비밀번호<input className="input" style={INP} type="password" autoComplete="new-password" value={f.vcpass} onChange={(e) => setFk('vcpass', e.target.value)} placeholder="저장하지 않습니다" aria-label="vCenter 비밀번호" /></label>
          <label className="muted" style={{ ...field, gridColumn: '1 / -1' }}>vCenter 인증서 SHA1 지문<input className="input" style={INP} value={f.vcthumbprint} onChange={(e) => setFk('vcthumbprint', e.target.value.trim())} placeholder="16진 40자(콜론 있어도 됨)" aria-label="vCenter 인증서 지문" /></label>
          {otpField(f, setFk, 'bareos-auto-fd-otp')}
        </div>
        {site && <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>쓸 경로 ‘{site.configFile}’ · FD 가 볼 vCenter ‘{site.vcserver}’ · FD 클라이언트 ‘{site.client}’</div>}
        {!s.sites.length && <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>사이트 매핑이 없습니다 — 아래 표에서 매핑을 먼저 저장하세요.</div>}
        <div style={{ ...ROW, marginTop: 10 }}>
          <button type="button" className="logout-btn" style={{ padding: '7px 14px' }} disabled={!sshReady} onClick={readThumb}>{busy === 'thumb' ? '읽는 중…' : 'FD 에서 지문 읽기'}</button>
          <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={!fReady} onClick={runFd}>{busy === 'fd' ? '쓰는 중…' : 'FD INI 자동 설정'}</button>
          {fMissing && <span className="muted" style={{ fontSize: 11.5 }}>{fMissing}</span>}
        </div>
        {fMsg && <div className={`banner ${fMsg.ok ? 'ok' : 'bad'}`} role={fMsg.ok ? 'status' : 'alert'} style={{ marginTop: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}><BoldText text={fMsg.text} /></div>}
      </div>
    </div>
  );
}
