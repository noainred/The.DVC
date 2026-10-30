import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, patchJson, delJson, usePolling, getCurrentUser } from '../../api.js';
import { Loading, ErrorBox, SearchBox, Modal } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import BoldText from '../../components/boldText.jsx';
import ScopeOmitBanner from '../ScopeOmitBanner.jsx';
import { useHashTab } from '../../hooks/useHashTab.js';
import { requireChanged } from '../changeResult.js';
import VeeamHeader from './VeeamHeader.jsx';
import SettingsTab from './BareosSettings.jsx';
import {
  stateBadge, levelLabel, bytesText, whenText, runCell, directorLine, directorStatus, directorChipTitle, outcomeUnknown, unknownOutcomeText, withRelayWait, targetLocks, RESTORE_MODE_LABEL, restoreLine, candidateSummary, driftText, restorePointsNote,
  folderOptions, inFolder, pickCap, bulkSummary,
  parseJobReport, reportCards, REPORT_KEYS, issueHint, storeRatio, reportText, reportBytes, reportValue,
} from './bareosText.js';

/**
 * 특수 기능 › Bareos VM 백업(v2.820, 도구 키 bareos-backup — admin 전용 · v2.823 법인별 Director).
 * 포탈에서 고른 VM 을 Bareos VMware 플러그인으로 백업·복원한다. 포탈은 법인마다 둔 Director 콘솔(TLS-PSK · JSON)로 잡을 만들고 실행·조회하며,
 * 백업 데이터는 그 법인의 FD → SD 안에서만 흐른다. vCenter 비밀번호는 포탈이 갖지 않는다(FD 의 INI). 설정 탭은 BareosSettings.jsx.
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
      <div className="card" style={{ ...NOTE, borderLeft: `3px solid var(--${data.demo ? 'amber' : data.configured && data.poller?.ok !== false && !(data.directors || []).some((x) => x.authStopped) ? 'green' : 'red'})` }}>
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
      {tab === 'settings' && fullScope && <SettingsTab onSaved={reload} writable={data.settingsWritable !== false} />}
      {tab === 'settings' && !fullScope && <div className="muted" style={{ padding: 16 }}>Director 설정은 전체 범위 관리자만 볼 수 있습니다 — 백업 대상 탭을 쓰세요.</div>}
      </div>
    </div>
  );
}

/* ───────────────────────── 백업 대상 ───────────────────────── */
function TargetsTab({ d, reload }) {
  const [vc, setVc] = useState('');
  const [dirF, setDirF] = useState('');   // v2.823 법인 Director 필터(상단 칩)
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
  const dirs = useMemo(() => d.directors || [], [d.directors]);
  const dirName = (id) => dirs.find((x) => x.id === id)?.name || '—';
  useEffect(() => { if (dirF && !dirs.some((x) => x.id === dirF)) setDirF(''); }, [dirF, dirs]);
  const rows = d.jobs.filter((j) => (!vc || j.vcenterId === vc) && (!dirF || j.directorId === dirF) && (!q || `${j.vmName} ${j.folder} ${j.bareosJob}`.toLowerCase().includes(q.toLowerCase())));

  // v2.824 검토(W3·W5): 엣지 대행 Director 는 서버가 더 오래 기다린다(API 값) · 결과 모름(시한·504)은 실패로 단정하지 않는다
  const mut = (j, kind) => withRelayWait({}, dirs.find((x) => x.id === j.directorId), d.relayLimits, kind);
  const act = async (j, fn, okText, what = '요청') => {
    setBusyIds((b) => new Set(b).add(j.id)); setMsg(null);
    try { const r = await fn(); requireChanged(r); setMsg({ ok: true, text: okText(r) }); reload(); }
    // G14: 실패여도 목록을 다시 읽는다 — 서버가 거부하면서 원장을 바꿨을 수 있다(예: 이미 끝난 실행의 취소는 결과를 반영하고 400)
    catch (e) { setMsg({ ok: false, text: outcomeUnknown(e) ? `결과 모름: ${unknownOutcomeText(what, e)}` : `오류: ${e.message}` }); reload(); }
    finally { setBusyIds((b) => { const n = new Set(b); n.delete(j.id); return n; }); }
  };
  const run = (j) => { setRunFor(null); act(j, () => postJson(`${BASE}/jobs/${enc(j.id)}/run`, runLevel ? { level: runLevel } : {}, mut(j, 'runJob')), (r) => `‘${j.vmName}’ 백업을 시작했습니다(jobid ${r.jobid}). 진행은 이 표와 실행 현황 탭에서 보입니다.`, '백업 실행'); };
  const cancel = (j, jobid) => { if (window.confirm(`‘${j.vmName}’ 의 실행 중 백업(jobid ${jobid})을 취소할까요?`)) act(j, () => postJson(`${BASE}/jobs/${enc(j.id)}/cancel`, { jobid }, mut(j, 'cancel')), (r) => r.note || '취소를 요청했습니다(Director 가 멈추기까지 시간이 걸릴 수 있습니다).', '취소'); };
  const toggle = (j) => act(j, () => patchJson(`${BASE}/jobs/${enc(j.id)}`, { enabled: !j.enabled }, mut(j, 'setEnabled')), () => (j.enabled ? '비활성화했습니다 — Bareos 의 비활성화는 Director 를 reload·재시작하면 풀리므로 포탈이 상태 대조 때마다 다시 끕니다.' : '활성화했습니다.'), j.enabled ? '비활성화' : '활성화');
  const remove = (j) => {
    if (!window.confirm(`‘${j.vmName}’ 을(를) 백업 대상에서 지울까요?\nDirector 의 잡은 비활성화하고 정의 파일은 남습니다(Director 를 reload 하면 다시 켜지므로 포탈이 대조 때마다 다시 끕니다 — 영구히 멈추려면 정의 파일을 지우세요). 백업 데이터는 지우지 않습니다.`)) return;
    act(j, () => delJson(`${BASE}/jobs/${enc(j.id)}`, mut(j, 'disableJobs')), (r) => r.note || '지웠습니다.', '삭제');
  };

  return (
    <div>
      {dirs.length > 0 && (
        <div style={{ ...ROW, marginBottom: 10 }} aria-label="법인 Director 필터">
          <span className="muted" style={{ fontSize: 12 }}>법인 Director</span>
          <button type="button" className={`tab${!dirF ? ' active' : ''}`} style={{ padding: '4px 12px', fontSize: 12 }} onClick={() => setDirF('')}>전체 {d.jobs.length}</button>
          {dirs.map((x) => {
            const b = directorStatus(x);
            return (
              <button key={x.id} type="button" className={`tab${dirF === x.id ? ' active' : ''}`} style={{ padding: '4px 12px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                title={directorChipTitle(x)} onClick={() => setDirF(dirF === x.id ? '' : x.id)}>
                {/* Chromium 확인: 고른 칩(파란 바탕) 위의 파란·회색 배지가 흐려 읽히지 않았다 — 고른 칩에서는 배지 바탕을 어둡게 */}
                <span className={`badge ${b.cls}`} style={{ fontSize: 10, ...(dirF === x.id ? { background: 'rgba(15,23,42,.6)' } : {}) }}>{b.label}</span>{x.name} <span className="muted">{x.jobs ?? 0}</span>
              </button>
            );
          })}
        </div>
      )}
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
        <STable minWidth={1160} wrap={false}>
          <thead><tr>
            <th>VM</th><th>법인 Director</th><th>vCenter</th><th>데이터센터 · 폴더</th><th>FD · 레벨 · 스케줄</th>
            <th>최근 실행</th><th className="right">용량</th><th data-nosort>작업</th>
          </tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={8} className="center muted" style={{ padding: 22 }}>{d.jobs.length ? '조건에 맞는 대상이 없습니다.' : '백업 대상이 없습니다 — ‘+ 백업 대상 추가’ 로 vCenter 의 VM 을 고르세요.'}</td></tr>}
            {rows.map((j) => {
              const c = runCell(j);
              // W5: 포탈이 시작한 실행(pending)뿐 아니라 Bareos 스케줄이 돌리는 실행(대조가 넣은 lastRun)도 실행 중이다 — 대조 주기만큼 늦을 수 있다
              const liveJobid = j.pending?.jobid || (['running', 'queued', 'waiting'].includes(j.lastRun?.state) ? j.lastRun.jobid : null);
              const running = !!liveJobid;
              const busy = busyIds.has(j.id);
              const lk = targetLocks(j, { busy, running, hasRun: !!c.jobid });   // G12·G13: 잠긴 버튼은 사유를 말한다(쓰기 범위 밖 포함)
              return (
                <tr key={j.id} style={{ opacity: j.enabled ? 1 : 0.6 }}>
                  <td data-sort={j.vmName}><b>{j.vmName}</b>{!j.enabled && <span className="badge gray" style={{ marginLeft: 6 }}>비활성</span>}{j.missingInDirector && <span className="badge red" style={{ marginLeft: 6 }} title="Director 의 잡 목록에 없습니다(누가 정의 파일을 지웠을 수 있습니다)">Director 에 없음</span>}{j.demo && <span className="badge amber" style={{ marginLeft: 6 }}>데모</span>}{j.drift && <span className="badge amber" style={{ marginLeft: 6 }} title={driftText(j.drift)}>{j.drift === 'missing' ? '인벤토리에 없음' : '등록 뒤 바뀜'}</span>}</td>
                  <td data-sort={dirName(j.directorId)} style={{ fontSize: 12.5 }}>{dirName(j.directorId)}</td>
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
                        ? <button type="button" className="logout-btn" style={{ ...BTN, color: 'var(--red)' }} disabled={!!lk.cancel} title={lk.cancel || undefined} onClick={() => cancel(j, liveJobid)}>취소</button>
                        : runFor === j.id
                          ? <>
                            <Select className="input" sort={false} value={runLevel} onChange={(e) => setRunLevel(e.target.value)} style={{ minWidth: 0, width: 168, padding: '3px 6px', fontSize: 12 }} aria-label="실행 레벨">
                              <option value="">기본({levelLabel(j.level)})</option>
                              {['Full', 'Incremental', 'Differential'].map((l) => <option key={l} value={l}>{levelLabel(l)}</option>)}
                            </Select>
                            <button type="button" className="logout-btn" style={BTN} disabled={!!lk.run} title={lk.run || undefined} onClick={() => run(j)}>시작</button>
                            <button type="button" className="logout-btn" style={BTN} onClick={() => setRunFor(null)}>닫기</button>
                          </>
                          : <button type="button" className="logout-btn" style={BTN} disabled={!!lk.run} title={lk.run || undefined} onClick={() => { setRunLevel(''); setRunFor(j.id); }}>실행…</button>}
                      <button type="button" className="logout-btn" style={BTN} disabled={!!lk.view} title={lk.view || undefined} onClick={() => setLogOf({ job: j, jobid: c.jobid, view: 'summary' })}>결과</button>
                      <button type="button" className="logout-btn" style={BTN} disabled={!!lk.view} title={lk.view || undefined} onClick={() => setLogOf({ job: j, jobid: c.jobid, view: 'raw' })}>로그</button>
                      <button type="button" className="logout-btn" style={BTN} disabled={!!lk.restore} title={lk.restore || undefined} onClick={() => setRestoreOf(j)}>복원…</button>
                      <button type="button" className="logout-btn" style={BTN} disabled={!!lk.toggle} title={lk.toggle || undefined} onClick={() => toggle(j)}>{j.enabled ? '비활성' : '활성'}</button>
                      <button type="button" className="logout-btn" style={{ ...BTN, color: 'var(--red)' }} disabled={!!lk.remove} title={lk.remove || undefined} onClick={() => remove(j)}>삭제</button>
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
      {logOf && <LogModal job={logOf.job} jobid={logOf.jobid} view={logOf.view} onClose={() => setLogOf(null)} onStateChanged={reload} dir={dirs.find((x) => x.id === logOf.job.directorId)} limits={d.relayLimits} />}
      {restoreOf && <RestoreModal job={restoreOf} dir={dirs.find((x) => x.id === restoreOf.directorId)} limits={d.relayLimits} onClose={() => setRestoreOf(null)} onDone={(t) => { setRestoreOf(null); setMsg({ ok: true, text: t }); reload(); }} />}
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
  // G10: 법인 Director 콘솔 접속값이 덜 됐으면 등록이 409 로 끝난다 — 미리 잠근다(서버가 ready·missing 을 준다 · 옛 응답이면 막지 않는다)
  const dirNotReady = cand?.director && cand.director.ready === false;
  const pickable = (x) => !!cand?.writable && !dirNotReady && x.eligible && !x.registered;
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
      const dirOfVc = (d.directors || []).find((x) => (x.vcenters || []).includes(vc));
      const r = await postJson(`${BASE}/jobs/bulk`, { vcenterId: vc, vmIds: [...sel], level }, withRelayWait({}, dirOfVc, d.relayLimits, 'addJobs'));
      // G10: 409(확정 거부 — 예: Director 접속값 덜 됨)는 본문으로 온다 — 대상별 결과(results)가 없으면 사유를 그대로 보인다(예전엔 '0대' 만 보였다)
      if (r && r.ok === false && !Array.isArray(r.results)) requireChanged(r);
      setResult(r);
      if (r.created > 0) { setSel(new Set()); setRev((x) => x + 1); onChanged(); }
    } catch (e) {
      // W3: 결과 모름(시한·504)이면 Director 에 잡이 생겼을 수 있다 — 목록을 새로 읽고 확인하라고 말한다(실패로 단정하지 않는다)
      if (outcomeUnknown(e)) { setErr(unknownOutcomeText('등록', e)); setRev((x) => x + 1); onChanged(); } else setErr(e.message);
    } finally { setBusy(false); }
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
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{candidateSummary(cand)}{cand.director ? ` · 잡을 만들 법인 Director ‘${cand.director.name}’` : ' · 이 vCenter 는 어느 법인 Director 에도 묶여 있지 않습니다(설정 › 법인별 Director)'}{cand.director && cand.mappingMissing?.length ? ` · 매핑이 덜 됐습니다(${cand.mappingMissing.join('·')})` : ''}{!cand.writable ? ' · 조회 전용 범위라 등록할 수 없습니다' : ''}</div>
          {dirNotReady && <div className="banner warn" style={{ marginBottom: 8, fontSize: 12 }}>법인 Director ‘{cand.director.name}’ 의 콘솔 접속값이 덜 됐습니다({(cand.director.missing || []).join('·') || '접속값'}) — 등록할 수 없습니다. 설정 › 법인별 Director 에서 채우세요(주소·포트·콘솔 이름을 바꾸면 저장 비밀번호가 지워집니다).</div>}
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
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={!sel.size || busy} title={!sel.size ? '등록할 VM 을 고르세요' : undefined} onClick={submit}>{busy ? '등록 중…' : `${sel.size || ''}대 등록`}</button>
      </div>
    </div>
  );
}

/**
 * 작업 결과·로그 — 서버가 이 대상의 jobid 인지 확인한다. 요약은 같은 로그의 끝 보고 블록을 읽는다(bareosText.parseJobReport —
 * 서버 호출을 늘리지 않는다). 요약을 못 만들면(실행 중·보고 없음) 그렇다고 말하고 원문을 보게 한다.
 */
function LogModal({ job, jobid, view = 'raw', onClose, onStateChanged, dir = null, limits = null }) {
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  const [mode, setMode] = useState(view === 'summary' ? 'summary' : 'raw');
  // v2.822.5: 서버가 로그를 주면서 그 실행의 상태를 원장에 반영한다(stateChanged) — 바뀌었으면 목록을 바로 다시 읽는다(폴러 주기를 기다리지 않게).
  const changedRef = useRef(onStateChanged);
  changedRef.current = onStateChanged;
  const waitMs = withRelayWait(DIRECTOR_GET, dir, limits, 'log').timeoutMs;   // 숫자 — 목록을 다시 읽어도(새 객체) 다시 조회하지 않게
  useEffect(() => {
    fetchJson(`${BASE}/jobs/${enc(job.id)}/log`, { jobid }, undefined, { ...DIRECTOR_GET, timeoutMs: waitMs })
      .then((x) => { setR(x); if (x?.stateChanged) changedRef.current?.(); })
      .catch(setErr);
  }, [job.id, jobid, waitMs]);
  const rep = useMemo(() => (r ? parseJobReport(r.lines) : null), [r]);
  return (
    <Modal title={`${mode === 'summary' ? '작업 결과' : '작업 로그'} — jobid ${jobid} · ${job.vmName}`} onClose={onClose} width={920}>
      <div style={{ ...ROW, marginBottom: 8 }}>
        {[['summary', '요약'], ['raw', '원문 로그']].map(([k, l]) => (
          <button key={k} type="button" className={`tab${mode === k ? ' active' : ''}`} onClick={() => setMode(k)}>{l}</button>
        ))}
        {r && <span className="muted" style={{ fontSize: 12 }}>{r.truncated ? `전체 ${r.total}줄 중 마지막 ${r.lines.length}줄` : `${r.total}줄`}</span>}
        {r?.stateChanged && <span className="badge blue" style={{ fontSize: 11 }}>목록 상태를 갱신했습니다</span>}
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
function RestoreModal({ job, dir = null, limits = null, onClose, onDone }) {
  const ptsWaitMs = withRelayWait(DIRECTOR_GET, dir, limits, 'history').timeoutMs;
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
    fetchJson(`${BASE}/jobs/${enc(job.id)}/restore-points`, {}, undefined, { ...DIRECTOR_GET, timeoutMs: ptsWaitMs }).then((r) => { setPts(r); if (r.items?.length) setJobid(r.items[0].jobid); }).catch(setPtsErr);
    fetchJson('/datastores', { vcenterId: job.vcenterId, limit: 2000 }).then((r) => setDss((r.items || []).map((x) => x.name))).catch(() => setDss([]));
    fetchJson('/hosts', { vcenterId: job.vcenterId, limit: 2000 }).then((r) => setClusters([...new Set((r.items || []).map((x) => x.cluster).filter((c) => c && c !== 'standalone'))])).catch(() => setClusters([]));
  }, [job.id, job.vcenterId, ptsWaitMs]);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const body = { jobid, mode, otp, ...(mode === 'original' ? { confirmName } : {}), ...(mode === 'newVm' ? { newVm: { name: nv.name, datastore: nv.datastore || undefined, cluster: nv.cluster || undefined } } : {}) };
      const r = await postJson(`${BASE}/jobs/${enc(job.id)}/restore`, body, withRelayWait({}, dir, limits, 'restore'));
      requireChanged(r);
      onDone(`복원을 시작했습니다(jobid ${r.jobid} · 원본 ${r.fromJobids.join(',')}). 진행은 실행 현황 탭에서 보입니다.`);
    } catch (e) { setErr(outcomeUnknown(e) ? unknownOutcomeText('복원', e) : e.message); setOtp(''); } finally { setBusy(false); }   // W8: 쓴(또는 틀린) OTP 를 남기면 다시 누를 때 실패 횟수만 오른다 · W3: 결과 모름이면 다시 누르기 전에 확인하라고
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
  const histWaitMs = withRelayWait(DIRECTOR_GET, (d.directors || []).find((x) => x.id === job?.directorId), d.relayLimits, 'history').timeoutMs;
  // W10: 고른 대상이 지워지면 첫 대상으로(예전에는 job 이 없어 '보기' 가 화면 오류를 냈다)
  useEffect(() => { if (sel && !job) setSel(d.jobs[0]?.id || ''); }, [sel, job, d.jobs]);
  const load = () => {
    const g = ++gen.current;
    setHist(null); setErr(null);
    if (!sel) return;
    fetchJson(`${BASE}/jobs/${enc(sel)}/history`, {}, undefined, { ...DIRECTOR_GET, timeoutMs: histWaitMs }).then((r) => { if (g === gen.current) { setHist(r.items || []); setLimit(r.limit ?? null); } }).catch((e) => { if (g === gen.current) setErr(e); });
  };
  useEffect(load, [sel, histWaitMs]);
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
      {logOf && <LogModal job={logOf.job} jobid={logOf.jobid} view={logOf.view} onClose={() => setLogOf(null)} dir={(d.directors || []).find((x) => x.id === logOf.job.directorId)} limits={d.relayLimits} />}
    </div>
  );
}
