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
import {
  stateBadge, levelLabel, bytesText, whenText, runCell, directorLine, RESTORE_MODE_LABEL, restoreLine, candidateSummary,
  directorPrepBlock, fdIniTemplate, PREP_CHECKLIST,
} from './bareosText.js';

/**
 * 특수 기능 › Bareos VM 백업(v2.747, 도구 키 bareos-backup — admin 전용).
 * 포탈에서 고른 VM 을 Bareos VMware 플러그인으로 백업·복원한다. 포탈은 Director 콘솔(TLS-PSK · JSON)로 잡을 만들고 실행·조회하며,
 * 백업 데이터는 사이트 FD → SD 안에서만 흐른다. vCenter 비밀번호는 포탈이 갖지 않는다(사이트 FD 의 INI).
 * 문구·판정은 bareosText.js 하나(백틱 금지 · 값이 없으면 '—').
 */
const BASE = '/tools/bareos-backup';
const TABS = [['targets', '백업 대상'], ['history', '실행 현황 · 이력'], ['settings', '설정']];
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' };
const NOTE = { padding: '8px 12px', marginBottom: 10, fontSize: 12.5, lineHeight: 1.6 };
const BTN = { padding: '4px 9px', fontSize: 12 };
// 전역 .input 의 min-width 220px 이 격자 칸·표 칸 입력을 밀어낸다(styles.css 1267 의 v2.636 사례) — 칸 안 입력은 이것으로.
const INP = { minWidth: 0, width: '100%', boxSizing: 'border-box' };
const enc = encodeURIComponent;

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

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  return (
    <div>
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
    </div>
  );
}

/* ───────────────────────── 백업 대상 ───────────────────────── */
function TargetsTab({ d, reload }) {
  const [vc, setVc] = useState('');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [logOf, setLogOf] = useState(null);       // { job, jobid }
  const [restoreOf, setRestoreOf] = useState(null); // job
  const vcs = useMemo(() => [...new Set(d.jobs.map((j) => j.vcenterId))].sort(), [d.jobs]);
  const rows = d.jobs.filter((j) => (!vc || j.vcenterId === vc) && (!q || `${j.vmName} ${j.folder} ${j.bareosJob}`.toLowerCase().includes(q.toLowerCase())));

  const act = async (fn, okText) => {
    setBusy(true); setMsg(null);
    try { const r = await fn(); requireChanged(r); setMsg({ ok: true, text: okText(r) }); reload(); }
    catch (e) { setMsg({ ok: false, text: `오류: ${e.message}` }); }
    finally { setBusy(false); }
  };
  const run = (j) => act(() => postJson(`${BASE}/jobs/${enc(j.id)}/run`, {}), (r) => `‘${j.vmName}’ 백업을 시작했습니다(jobid ${r.jobid}). 진행은 이 표와 실행 현황 탭에서 보입니다.`);
  const cancel = (j) => { if (window.confirm(`‘${j.vmName}’ 의 실행 중 백업을 취소할까요?`)) act(() => postJson(`${BASE}/jobs/${enc(j.id)}/cancel`, {}), () => '취소를 요청했습니다(Director 가 멈추기까지 시간이 걸릴 수 있습니다).'); };
  const toggle = (j) => act(() => patchJson(`${BASE}/jobs/${enc(j.id)}`, { enabled: !j.enabled }), () => (j.enabled ? '비활성화했습니다 — Bareos 스케줄도 이 잡을 돌리지 않습니다.' : '활성화했습니다.'));
  const remove = (j) => {
    if (!window.confirm(`‘${j.vmName}’ 을(를) 백업 대상에서 지울까요?\nDirector 의 잡은 비활성화되고 정의 파일은 남습니다. 백업 데이터는 지우지 않습니다.`)) return;
    act(() => delJson(`${BASE}/jobs/${enc(j.id)}`), (r) => r.note || '지웠습니다.');
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
      {adding && <AddForm d={d} onClose={() => setAdding(false)} onDone={(t) => { setAdding(false); setMsg({ ok: true, text: t }); reload(); }} />}
      <ScopeOmitBanner data={d} unit="백업 대상" counter="개" why="조회 범위 밖 vCenter 의" />

      <div className="table-wrap" style={{ maxHeight: '58vh' }}>
        <STable minWidth={1040}>
          <thead><tr>
            <th>VM</th><th>vCenter</th><th>데이터센터 · 폴더</th><th>사이트 FD · 레벨 · 스케줄</th>
            <th>최근 실행</th><th className="right">용량</th><th data-nosort>작업</th>
          </tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={7} className="center muted" style={{ padding: 22 }}>{d.jobs.length ? '조건에 맞는 대상이 없습니다.' : '백업 대상이 없습니다 — ‘+ 백업 대상 추가’ 로 vCenter 의 VM 을 고르세요.'}</td></tr>}
            {rows.map((j) => {
              const c = runCell(j);
              const running = !!j.pending?.jobid;
              return (
                <tr key={j.id} style={{ opacity: j.enabled ? 1 : 0.6 }}>
                  <td data-sort={j.vmName}><b>{j.vmName}</b>{!j.enabled && <span className="badge gray" style={{ marginLeft: 6 }}>비활성</span>}{j.missingInDirector && <span className="badge red" style={{ marginLeft: 6 }} title="Director 의 잡 목록에 없습니다(누가 정의 파일을 지웠을 수 있습니다)">Director 에 없음</span>}{j.demo && <span className="badge amber" style={{ marginLeft: 6 }}>데모</span>}</td>
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
                        ? <button type="button" className="logout-btn" style={{ ...BTN, color: 'var(--red)' }} disabled={busy} onClick={() => cancel(j)}>취소</button>
                        : <button type="button" className="logout-btn" style={BTN} disabled={busy || !j.enabled} onClick={() => run(j)}>실행</button>}
                      <button type="button" className="logout-btn" style={BTN} disabled={!c.jobid} onClick={() => setLogOf({ job: j, jobid: c.jobid })}>로그</button>
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
        대상 VM 은 vCenter 상세(서버 › vCenter)의 VM 행에 <span className="badge blue" style={{ fontSize: 10 }}>Bareos</span> 배지로 표시됩니다.
      </div>
      {logOf && <LogModal job={logOf.job} jobid={logOf.jobid} onClose={() => setLogOf(null)} />}
      {restoreOf && <RestoreModal job={restoreOf} onClose={() => setRestoreOf(null)} onDone={(t) => { setRestoreOf(null); setMsg({ ok: true, text: t }); reload(); }} />}
    </div>
  );
}

/** 대상 추가 — vCenter → 등록 후보(서버가 가능 여부·사유를 준다) → 레벨 → 등록. */
function AddForm({ d, onClose, onDone }) {
  const [vcs, setVcs] = useState(null);
  const [vcErr, setVcErr] = useState(null);
  const [vc, setVc] = useState('');
  const [cand, setCand] = useState(null);
  const [candErr, setCandErr] = useState(null);
  const [q, setQ] = useState('');
  const [vmId, setVmId] = useState('');
  const [level, setLevel] = useState(d.defaults?.level || 'Incremental');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const gen = useRef(0);
  useEffect(() => { fetchJson('/vcenters').then((r) => setVcs(Array.isArray(r) ? r : [])).catch(setVcErr); }, []);
  useEffect(() => {
    const g = ++gen.current;
    setCand(null); setCandErr(null); setVmId('');
    if (!vc) return;
    fetchJson(`${BASE}/vm-candidates`, { vcenterId: vc }).then((r) => { if (g === gen.current) setCand(r); }).catch((e) => { if (g === gen.current) setCandErr(e); });
  }, [vc]);
  const items = (cand?.items || []).filter((x) => !q || x.name.toLowerCase().includes(q.toLowerCase()));
  const pick = (cand?.items || []).find((x) => x.id === vmId);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await postJson(`${BASE}/jobs`, { vcenterId: vc, vmId, level });
      requireChanged(r);
      onDone(`‘${r.job.vmName}’ 을(를) 백업 대상으로 등록했습니다 — Director 잡 ‘${r.job.bareosJob}’.`);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ padding: 14, marginBottom: 12 }}>
      <div style={{ ...ROW, marginBottom: 8 }}>
        <b>백업 대상 추가</b>
        <div style={{ flexGrow: 1 }} />
        <button type="button" className="logout-btn" style={BTN} onClick={onClose}>닫기</button>
      </div>
      {vcErr && <ErrorBox error={vcErr} />}
      <div style={{ ...ROW, marginBottom: 8 }}>
        <label htmlFor="bareos-add-vc" className="muted" style={{ fontSize: 12 }}>vCenter</label>
        <Select id="bareos-add-vc" className="input" value={vc} onChange={(e) => setVc(e.target.value)} style={{ minWidth: 200 }}>
          <option value="">선택…</option>
          {(vcs || []).map((v) => <option key={v.id} value={v.id}>{v.name ? `${v.name} (${v.id})` : v.id}</option>)}
        </Select>
        {vc && <SearchBox value={q} onChange={setQ} placeholder="VM 이름" style={{ width: 200, maxWidth: '100%' }} />}
        <label htmlFor="bareos-add-level" className="muted" style={{ fontSize: 12 }}>기본 레벨</label>
        <Select id="bareos-add-level" className="input" sort={false} value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="Incremental">Incremental</option><option value="Differential">Differential</option><option value="Full">Full</option>
        </Select>
      </div>
      {candErr && <ErrorBox error={candErr} />}
      {vc && !cand && !candErr && <Loading />}
      {cand && (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{candidateSummary(cand)}{!cand.mapped ? ' · 이 vCenter 의 사이트 매핑이 없습니다(설정 탭)' : ''}{!cand.writable ? ' · 조회 전용 범위라 등록할 수 없습니다' : ''}</div>
          <div className="table-wrap" style={{ maxHeight: '32vh' }}>
            <STable minWidth={640} limit={500}>
              <thead><tr><th data-nosort>선택</th><th>VM</th><th>데이터센터 · 폴더</th><th>상태</th><th>등록 가능</th></tr></thead>
              <tbody>
                {items.length === 0 && <tr><td colSpan={5} className="center muted" style={{ padding: 14 }}>조건에 맞는 VM 이 없습니다.</td></tr>}
                {items.map((x) => (
                  <tr key={x.id} style={{ opacity: x.eligible && !x.registered ? 1 : 0.6 }}>
                    <td><input type="radio" name="bareos-pick" id={`bareos-pick-${x.id}`} aria-label={`${x.name} 선택`} disabled={!x.eligible || x.registered || !cand.writable} checked={vmId === x.id} onChange={() => setVmId(x.id)} /></td>
                    <td><label htmlFor={`bareos-pick-${x.id}`}>{x.name}</label></td>
                    <td className="muted" style={{ fontSize: 12 }}>{x.dc ?? '—'} · {x.folder ?? '—'}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{x.template ? '템플릿' : x.powerState === 'POWERED_ON' ? '켜짐' : x.powerState === 'POWERED_OFF' ? '꺼짐' : '—'}</td>
                    <td style={{ fontSize: 12 }}>{x.registered ? <span className="badge blue">이미 대상</span> : x.eligible ? <span className="badge green">가능</span> : <span className="muted">{x.reason}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          </div>
        </>
      )}
      {err && <div className="banner bad" style={{ marginTop: 8 }}>{err}</div>}
      <div style={{ ...ROW, marginTop: 10 }}>
        <span className="muted" style={{ fontSize: 12 }}>{pick ? `‘${pick.name}’ — Director 에 잡을 만들고(configure add job) 사이트 매핑의 스케줄을 배정합니다.` : 'VM 을 고르세요.'}</span>
        <div style={{ flexGrow: 1 }} />
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={!vmId || busy} onClick={submit}>{busy ? '등록 중…' : '등록'}</button>
      </div>
    </div>
  );
}

/** 작업 로그 — 서버가 이 대상의 jobid 인지 확인한다. */
function LogModal({ job, jobid, onClose }) {
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { fetchJson(`${BASE}/jobs/${enc(job.id)}/log`, { jobid }).then(setR).catch(setErr); }, [job.id, jobid]);
  return (
    <Modal title={`작업 로그 — jobid ${jobid} · ${job.vmName}`} onClose={onClose} width={920}>
      {err && <ErrorBox error={err} />}
      {!r && !err && <Loading />}
      {r && (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{r.truncated ? `전체 ${r.total}줄 중 마지막 ${r.lines.length}줄` : `${r.total}줄`}</div>
          <pre style={{ margin: 0, padding: 12, maxHeight: '60vh', overflow: 'auto', fontSize: 12, lineHeight: 1.6, background: 'var(--panel-deep)', borderRadius: 8, whiteSpace: 'pre' }}>{r.lines.join('\n') || '로그가 없습니다.'}</pre>
        </>
      )}
    </Modal>
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
    fetchJson(`${BASE}/jobs/${enc(job.id)}/restore-points`).then((r) => { setPts(r); if (r.items?.length) setJobid(r.items[0].jobid); }).catch(setPtsErr);
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
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const ready = jobid && /^\d{6}$/.test(otp) && (mode !== 'original' || confirmName === job.vmName) && (mode !== 'newVm' || nv.name.trim());
  return (
    <Modal title={`복원 — ${job.vmName}`} onClose={onClose} width={760}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>{job.vcenterId} · {job.dc} · {job.folder} · 사이트 FD ‘{job.client}’ · 원래 vCenter 로만 복원합니다(Bareos 플러그인 제약).</div>
      {pts?.restorePending && <div className="banner bad" style={{ marginBottom: 10 }}>이 대상의 다른 복원이 진행 중입니다 — 끝난 뒤 다시 시도하세요.</div>}
      <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px', minWidth: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 6 }}>1. 복원 지점 <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>(성공한 백업 — 체인은 서버가 Director 카탈로그로 계산)</span></legend>
        {ptsErr && <ErrorBox error={ptsErr} />}
        {!pts && !ptsErr && <Loading />}
        {pts && !pts.items.length && <div className="muted">성공한 백업이 없습니다.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 180, overflow: 'auto' }}>
          {(pts?.items || []).slice(0, 30).map((p) => (
            <label key={p.jobid} htmlFor={`bareos-rp-${p.jobid}`} style={{ ...ROW, padding: '6px 10px', border: `1px solid ${jobid === p.jobid ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 8, cursor: 'pointer' }}>
              <input type="radio" name="bareos-rp" id={`bareos-rp-${p.jobid}`} checked={jobid === p.jobid} onChange={() => setJobid(p.jobid)} />
              <b>{whenText(p.startedAt)}</b><span>{levelLabel(p.level)} · jobid {p.jobid}</span>
              <span className={`badge ${stateBadge(p.state, p.status).cls}`}>{stateBadge(p.state, p.status).label}</span>
              <span className="muted" style={{ fontSize: 12 }}>{bytesText(p.bytes)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px', minWidth: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 6 }}>2. 복원 방식</legend>
        {Object.entries(RESTORE_MODE_LABEL).map(([k, l]) => (
          <label key={k} htmlFor={`bareos-mode-${k}`} style={{ ...ROW, padding: '4px 0', cursor: 'pointer' }}>
            <input type="radio" name="bareos-mode" id={`bareos-mode-${k}`} checked={mode === k} onChange={() => setMode(k)} />
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
  const job = d.jobs.find((j) => j.id === sel);
  const load = () => {
    const g = ++gen.current;
    setHist(null); setErr(null);
    if (!sel) return;
    fetchJson(`${BASE}/jobs/${enc(sel)}/history`).then((r) => { if (g === gen.current) setHist(r.items || []); }).catch((e) => { if (g === gen.current) setErr(e); });
  };
  useEffect(load, [sel]);
  const running = d.jobs.filter((j) => j.pending?.jobid);
  const restores = d.jobs.flatMap((j) => (j.restores || []).map((r) => ({ ...r, job: j }))).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 50);
  return (
    <div>
      <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>포탈이 시작한 실행 중 백업 {running.length}건</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 10, marginBottom: 14 }}>
        {running.length === 0 && <div className="muted" style={{ fontSize: 12.5, gridColumn: '1 / -1' }}>없음 — Bareos 스케줄이 돌린 실행은 대상 표의 ‘최근 실행’ 에 반영됩니다(대조 주기마다).</div>}
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
        <span className="muted" style={{ fontSize: 12 }}>Director 카탈로그 최근 30건 · 상태 코드 T 성공 · W 경고 · E·f 오류 · A 취소 · R 실행 중 · C 대기</span>
      </div>
      {err && <ErrorBox error={err} />}
      {sel && !hist && !err && <Loading />}
      {hist && (
        <div className="table-wrap" style={{ maxHeight: '40vh', marginBottom: 14 }}>
          <STable minWidth={820}>
            <thead><tr><th>jobid</th><th>레벨</th><th>시작</th><th>종료</th><th className="right">바이트</th><th className="right">파일</th><th>상태</th><th data-nosort>로그</th></tr></thead>
            <tbody>
              {hist.length === 0 && <tr><td colSpan={8} className="center muted" style={{ padding: 16 }}>실행 이력이 없습니다.</td></tr>}
              {hist.map((r) => { const b = stateBadge(r.state, r.status); return (
                <tr key={r.jobid}>
                  <td data-sort={r.jobid}>{r.jobid}</td><td>{levelLabel(r.level)}</td>
                  <td data-sort={r.startedAt ?? ''}>{whenText(r.startedAt)}</td><td data-sort={r.endedAt ?? ''}>{whenText(r.endedAt)}</td>
                  <td className="right" data-sort={r.bytes ?? ''}>{bytesText(r.bytes)}</td><td className="right" data-sort={r.files ?? ''}>{r.files ?? '—'}</td>
                  <td><span className={`badge ${b.cls}`}>{b.label}</span></td>
                  <td><button type="button" className="logout-btn" style={BTN} onClick={() => setLogOf({ job, jobid: r.jobid })}>보기</button></td>
                </tr>
              ); })}
            </tbody>
          </STable>
        </div>
      )}

      <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>복원 이력(대상별 최근 20건)</div>
      <div className="table-wrap" style={{ maxHeight: '30vh' }}>
        <STable minWidth={760}>
          <thead><tr><th>복원 jobid</th><th>VM</th><th>방식 · 대상</th><th>요청</th><th>상태</th><th data-nosort>로그</th></tr></thead>
          <tbody>
            {restores.length === 0 && <tr><td colSpan={6} className="center muted" style={{ padding: 14 }}>복원 이력이 없습니다.</td></tr>}
            {restores.map((r) => { const b = stateBadge(r.state, r.status); return (
              <tr key={`${r.job.id}-${r.jobid}`}>
                <td data-sort={r.jobid}>{r.jobid}</td><td>{r.job.vmName}</td>
                <td style={{ fontSize: 12 }}>{restoreLine(r)}</td><td data-sort={r.at ?? ''}>{whenText(r.at)}</td>
                <td><span className={`badge ${b.cls}`}>{b.label}</span></td>
                <td><button type="button" className="logout-btn" style={BTN} onClick={() => setLogOf({ job: r.job, jobid: r.jobid })}>보기</button></td>
              </tr>
            ); })}
          </tbody>
        </STable>
      </div>
      {logOf && <LogModal job={logOf.job} jobid={logOf.jobid} onClose={() => setLogOf(null)} />}
    </div>
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
  const load = () => fetchJson(`${BASE}/settings`).then((r) => {
    setS(r); setErr(null);
    setForm({ director: { host: r.director.host, port: r.director.port, consoleName: r.director.consoleName, password: '', timeoutMs: r.director.timeoutMs, tlsMax: r.director.tlsMax }, defaults: { ...r.defaults }, sites: r.sites.map((x) => ({ ...x })) });
  }).catch(setErr);
  const loadCat = (refresh) => { setCatErr(null); fetchJson(`${BASE}/catalog`, refresh ? { refresh: 1 } : {}).then(setCat).catch(setCatErr); };
  useEffect(() => { load(); loadCat(false); }, []);
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
      const body = { director: { ...form.director, port: Number(form.director.port) || 9101, timeoutMs: Number(form.director.timeoutMs) || undefined }, defaults: { ...form.defaults, pollIntervalSec: Number(form.defaults.pollIntervalSec) || undefined }, sites: form.sites };
      if (!body.director.password) delete body.director.password;
      const r = await putJson(`${BASE}/settings`, body);
      requireChanged(r);
      const dropped = droppedSecretNote(r);
      setMsg({ ok: true, text: `저장했습니다.${dropped ? ` ${dropped}` : ''}` });
      await load(); loadCat(true); onSaved();
    } catch (e) { setMsg({ ok: false, text: `저장 실패: ${e.message}` }); } finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true); setMsg(null);
    try {
      const body = form.director.password ? { director: { ...form.director } } : {};
      const r = await postJson(`${BASE}/settings/test`, body);
      requireChanged(r);
      setMsg({ ok: true, text: `연결 성공 — Director ‘${r.director || '?'}’ ${r.version || ''} · ${r.tls ? `${r.tls.protocol} ${r.tls.cipher}` : '암호화 없음'} · 클라이언트 ${r.clients ? `${r.clients.length}개` : `조회 실패(${r.clientsError})`}${form.director.password ? '' : ' (저장된 주소·비밀번호로 시험)'}` });
    } catch (e) { setMsg({ ok: false, text: `연결 실패: ${e.message}` }); } finally { setBusy(false); }
  };
  const copy = (text) => { try { navigator.clipboard.writeText(text).then(() => setMsg({ ok: true, text: '복사했습니다.' }), () => setMsg({ ok: false, text: '복사하지 못했습니다 — 글을 직접 선택해 복사하세요.' })); } catch { setMsg({ ok: false, text: '복사하지 못했습니다 — 글을 직접 선택해 복사하세요.' }); } };
  const field = { fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 };

  return (
    <div>
      {s.demo && <div className="card" style={{ ...NOTE, borderLeft: '3px solid var(--amber)' }}>데모 모드 — 아래 값은 메모리의 데모 설정입니다. 실제 Director 를 저장하면 그쪽으로 접속합니다.</div>}
      {s.loadError && <div className="banner bad" style={{ marginBottom: 10 }}>설정 파일을 읽지 못했습니다(손상본 보존) — {s.loadError.reason}</div>}
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
            <button type="button" className="logout-btn" style={{ padding: '7px 14px' }} disabled={busy} onClick={test}>연결 시험</button>
          </div>
        </div>
        <div className="card" style={{ padding: 14, minWidth: 0 }}>
          <div style={ROW}><b>기본값</b><span className="muted" style={{ fontSize: 12 }}>Director 카탈로그에서 고릅니다</span><div style={{ flexGrow: 1 }} /><button type="button" className="logout-btn" style={BTN} onClick={() => loadCat(true)}>카탈로그 새로 고침</button></div>
          {catErr && <div className="muted" style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>카탈로그를 읽지 못했습니다: {catErr.message} — 이름을 직접 확인하세요.</div>}
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
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
        <span className="muted" style={{ fontSize: 12 }}>매핑을 바꿔도 이미 만든 Director 잡은 바뀌지 않습니다(새로 등록하는 대상부터 적용).</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 12 }}>
        <div className="card" style={{ padding: 14, minWidth: 0 }}>
          <div style={ROW}><b>사전 준비 — Director 에 1회 넣을 블록</b><div style={{ flexGrow: 1 }} /><button type="button" className="logout-btn" style={BTN} onClick={() => copy(directorPrepBlock({ defaults: form.defaults, consoleName: form.director.consoleName, anyClient: form.sites[0]?.client || 'kr-fd', anyPool: form.sites[0]?.pool || 'VMwarePool' }))}>복사</button></div>
          <pre style={{ margin: '8px 0 0', padding: 10, maxHeight: 280, overflow: 'auto', fontSize: 11.5, lineHeight: 1.55, background: 'var(--panel-deep)', borderRadius: 8 }}>{directorPrepBlock({ defaults: form.defaults, consoleName: form.director.consoleName, anyClient: form.sites[0]?.client || 'kr-fd', anyPool: form.sites[0]?.pool || 'VMwarePool' })}</pre>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>Profile 의 ACL 지시어 이름은 설치한 Director 버전 문서로 한 번 확인하세요. 넣은 뒤 Director 를 reload 합니다.</div>
        </div>
        <div className="card" style={{ padding: 14, minWidth: 0 }}>
          <b>사전 준비 체크리스트</b>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7 }}>
            {PREP_CHECKLIST.map((t) => <li key={t}>{t}</li>)}
          </ul>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>vCenter 비밀번호는 포탈에 저장하지 않습니다 — 각 사이트 FD 의 INI 파일에 직접 넣으세요(행의 ‘INI 내용 복사’).</div>
        </div>
      </div>
    </div>
  );
}
