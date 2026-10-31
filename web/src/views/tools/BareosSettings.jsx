import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import BoldText from '../../components/boldText.jsx';
import { requireChanged } from '../changeResult.js';
import { droppedSecretNote } from '../droppedSecretText.js';
import {
  diagView, directorPrepBlock, fdIniTemplate, PREP_CHECKLIST, autoSetupDirectorText, autoSetupFdText, thumbprintText,
  outcomeUnknown, missingText, preflightView, preflightSummary, autoSetupFdPluginText, fillEmptyMapping, directorFormPatch, withRelayWait, secText, relayKindLabel, SETTINGS_READ_ONLY,
  VMWARE_POOL_FULL, VMWARE_SCHEDULE, WEEKDAYS, WEEKDAY_LABEL, MAPPING_FIELDS, newMappingRow, vcSlug,
} from './bareosText.js';

/**
 * Bareos VM 백업 › 설정(v2.823 법인별 Director — 전체 범위 관리자).
 * 법인마다 Bareos 서버(Director·SD·FD 한 대)를 등록하고 그 법인 vCenter 를 묶는다. 초기 설치만 된 서버는 편집 화면의 자동 설정 5단계
 * (사전 점검 → Director 리소스 · Pool · Schedule → FD 플러그인 → 매핑 채움·저장 → FD INI · 지문)로 포탈이 설정한다(서버 bareos/autoSetup.js).
 * v2.823 검토(W3): FD INI 는 저장된 매핑의 vcserver·INI 경로를 쓰므로 매핑 채움이 그 앞이다(예전 순서 4·5 는 번호대로 하면 실패했다).
 * SSH·vCenter 비밀번호는 서버에 저장하지 않는다 · 쓰기 단계는 본인 OTP · 포탈이 만들지 않은 파일은 덮어쓰지 않는다(예외: 3단계 myself.conf — 사본을 남기고 제자리 수정).
 * 문구·판정은 bareosText.js 하나(백틱 금지 · 값이 없으면 '—').
 */
const BASE = '/tools/bareos-backup';
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' };
const NOTE = { padding: '8px 12px', marginBottom: 10, fontSize: 12.5, lineHeight: 1.6 };
const BTN = { padding: '4px 9px', fontSize: 12 };
// 전역 .input 의 min-width 220px 이 격자 칸·표 칸 입력을 밀어낸다 — 칸 안 입력은 이것으로.
const INP = { minWidth: 0, width: '100%', boxSizing: 'border-box' };
const FIELD = { fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 };
// 칸 라벨이 줄바꿈되어도(예: '콘솔 비밀번호 저장됨') 입력칸 아래끝을 맞춘다(Chromium 1440 확인 — 한 칸만 한 줄 내려가 있었다)
const GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginTop: 8, alignItems: 'end' };
const enc = encodeURIComponent;
// W2(v2.822): Director 를 거치는 조회는 자동 재시도하지 않는다(규약 '자동 재시도 금지')
const DIRECTOR_GET = { retries: 0, timeoutMs: 60_000 };
// v2.823 검토(W15): 카드 안 격자 — 400px 에서 칸 최소폭이 카드 내폭보다 커 가로로 넘쳤다
const CARDS = (min) => ({ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))`, gap: 12, alignItems: 'start' });
const hostOf = (v) => String(v?.host || '').replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
/** 클립보드 복사 + 결과 안내(W13 — 실패를 삼키지 않는다). */
const copyWith = (say) => (text) => {
  const fail = () => say({ ok: false, text: '복사하지 못했습니다 — 글을 직접 선택해 복사하세요.' });
  try { navigator.clipboard.writeText(text).then(() => say({ ok: true, text: '복사했습니다.' }), fail); } catch { fail(); }
};

function Msg({ m }) {
  if (!m) return null;
  return <div className={`banner ${m.ok === false ? 'bad' : m.ok === 'warn' ? 'warn' : 'ok'}`} role={m.ok === false ? 'alert' : 'status'} style={{ marginTop: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}><BoldText text={m.text} /></div>;
}

export function DiagStages({ stages }) {
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

/* ───────────────────────── 설정 탭 ───────────────────────── */
export default function SettingsTab({ onSaved, writable = true }) {
  const [s, setS] = useState(null);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState('');
  const [msg, setMsg] = useState(null);
  const [adding, setAdding] = useState(false);
  const [defs, setDefs] = useState(null);
  const [busy, setBusy] = useState(false);
  const gen = useRef(0);
  // W14: 늦게 온 이전 응답은 버린다 · keepDefs: 저장하지 않은 공통 기본값 편집은 버리지 않는다
  const load = (keepDefs = true) => {
    const g = ++gen.current;
    return fetchJson(`${BASE}/settings`).then((r) => {
      if (g !== gen.current) return;
      setS(r); setErr(null);
      setDefs((f) => (keepDefs && f ? f : { ...r.defaults }));
    }).catch((e) => { if (g === gen.current) setErr(e); });
  };
  useEffect(() => { load(false); }, []);
  if (err && !s) return <ErrorBox error={err} />;
  if (!s || !defs) return <Loading />;
  const vcName = (id) => s.vcenters.find((v) => v.id === id)?.name || id;
  const unbound = s.vcenters.filter((v) => !s.sites.some((x) => x.vcenterId === v.id));
  const dir = s.directors.find((d) => d.id === sel) || null;

  const saveDefaults = async () => {
    setBusy(true); setMsg(null);
    try {
      // P4: 읽은 설정 세대를 함께 보낸다 — 그사이 다른 화면이 저장했으면 409(덮지 않는다)
      const r = await putJson(`${BASE}/settings`, { rev: s.rev, defaults: { ...defs, pollIntervalSec: Number(defs.pollIntervalSec) || undefined } });
      requireChanged(r);
      setMsg({ ok: true, text: '공통 기본값을 저장했습니다.' });
      await load(false); onSaved();
    } catch (e) {
      setMsg({ ok: false, text: `저장 실패: ${e.message}` });
      if (e?.body?.code === 'stale') await load(true);
    } finally { setBusy(false); }
  };
  const copy = copyWith(setMsg);

  return (
    <div>
      {s.demo && <div className="card" style={{ ...NOTE, borderLeft: '3px solid var(--amber)' }}>데모 모드 — 아래 값은 메모리의 데모 설정입니다(지역마다 데모 Director · 편집·저장 안 됨). 실제 Director 를 추가하면 데모가 꺼지고 그쪽 설정으로 바뀝니다.</div>}
      {s.loadError && <div className="banner bad" style={{ marginBottom: 10 }}>설정 파일을 읽지 못했습니다(손상본 보존) — {s.loadError.reason}</div>}
      {/* v2.825.1 버그 점검(G12): 쓰기 범위가 지정된 계정은 서버(fullWriteOnly)가 403 으로 막는다 — 화면이 미리 잠그고 사유를 말한다 */}
      {!writable && <div className="banner warn" style={{ marginBottom: 10 }}>{SETTINGS_READ_ONLY}</div>}
      {err && <div className="banner bad" role="alert" style={{ marginBottom: 10 }}>설정을 다시 읽지 못했습니다({String(err.message || err).slice(0, 160)}) — 화면 값이 최신이 아닐 수 있어 저장을 잠갔습니다. <button type="button" className="logout-btn" style={BTN} onClick={() => load(true)}>다시 읽기</button></div>}
      <Msg m={msg} />

      <div className="card" style={{ padding: 14, marginTop: 10, marginBottom: 12, minWidth: 0 }}>
        <div style={ROW}>
          <div style={{ minWidth: 0, flex: '1 1 420px' }}>
            <b>법인별 Director</b>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>법인마다 Bareos 서버(Director · SD · FD 한 대)를 등록하고 그 법인의 vCenter 를 묶습니다. 초기 설치만 된 서버는 편집 화면의 자동 설정 5단계로 포탈이 설정합니다.</div>
          </div>
          <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={!!err || !writable} title={!writable ? SETTINGS_READ_ONLY : err ? '설정을 다시 읽지 못해 잠갔습니다' : undefined} onClick={() => setAdding((x) => !x)}>{adding ? '닫기' : '+ Director 추가'}</button>
        </div>
        {adding && <AddDirectorForm agents={s.agents || []} withToken={s.agentsWithToken} onDone={async (r) => { setAdding(false); setMsg({ ok: true, text: `‘${r.director.name}’ Director 를 추가했습니다 — 편집에서 vCenter 를 묶고 자동 설정을 진행하세요.` }); await load(true); setSel(r.director.id); onSaved(); }} />}
        <div className="table-wrap" style={{ marginTop: 10, maxHeight: '46vh' }}>
          <STable minWidth={1060}>
            <thead><tr><th>법인</th><th>Director 주소 · 콘솔</th><th>담당</th><th>비밀번호</th><th>법인 vCenter</th><th className="right">백업 대상</th><th data-nosort>동작</th></tr></thead>
            <tbody>
              {s.directors.length === 0 && <tr><td colSpan={7} className="center muted" style={{ padding: 18 }}>등록한 Director 가 없습니다 — ‘+ Director 추가’ 로 법인 Bareos 서버를 등록하세요.</td></tr>}
              {s.directors.map((d) => {
                const vcs = s.sites.filter((x) => x.directorId === d.id).map((x) => vcName(x.vcenterId));
                return (
                  <tr key={d.id} style={sel === d.id ? { background: 'var(--hover)' } : undefined}>
                    <td data-sort={d.name}><b>{d.name}</b></td>
                    <td data-sort={d.host || ''} style={{ fontSize: 12.5 }}><span style={{ fontFamily: 'var(--font-mono)' }}>{d.host ? `${d.host}:${d.port}` : '—'}</span><div className="muted" style={{ fontSize: 11.5 }}>콘솔 {d.consoleName || '—'} · {d.tlsMax || '—'}</div></td>
                    <td data-sort={d.agent || ''} style={{ fontSize: 12.5 }}>{d.agent ? <span className="badge blue">엣지 {d.agent}</span> : <span className="muted">중앙 직접</span>}</td>
                    <td>{d.hasPassword ? <span className="badge green">저장됨</span> : <span className="badge gray">없음</span>}</td>
                    <td data-sort={vcs.length} style={{ fontSize: 12.5 }}><div style={{ maxWidth: 320, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{vcs.length ? `${vcs.length} · ${vcs.join(' · ')}` : '—'}</div></td>
                    <td className="right" data-sort={d.jobs ?? 0}>{d.jobs ?? 0}</td>
                    <td><button type="button" className="logout-btn" style={BTN} onClick={() => setSel(sel === d.id ? '' : d.id)}>{sel === d.id ? '닫기' : '편집'}</button></td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        </div>
        {unbound.length > 0 && s.directors.length > 0 && (
          <div className="banner warn" style={{ marginTop: 10 }}>Director 에 묶이지 않은 vCenter {unbound.length}개 — {unbound.slice(0, 8).map((v) => v.name).join(' · ')}{unbound.length > 8 ? ` 외 ${unbound.length - 8}` : ''}. 묶기 전에는 그 vCenter 의 VM 을 백업 대상으로 등록할 수 없습니다(Director 편집에서 묶습니다).</div>
        )}
      </div>

      {dir && <DirectorEditor key={dir.id} s={s} dir={dir} locked={!!err || !writable}
        onReload={() => load(true)} onSaved={onSaved} onClose={() => setSel('')}
        onDeleted={async (name) => { setSel(''); setMsg({ ok: true, text: `‘${name}’ Director 를 포탈 설정에서 지웠습니다(Bareos 서버는 그대로).` }); await load(true); onSaved(); }} />}

      <div style={CARDS(340)}>
        <div className="card" style={{ padding: 14, minWidth: 0 }}>
          <b>공통 기본값 — 모든 Director</b>
          <div style={GRID}>
            {[['jobDefs', 'JobDefs'], ['fileSet', 'FileSet(범용)'], ['restoreJob', '복원 잡']].map(([k, l]) => (
              <label key={k} className="muted" style={FIELD}>{l}<input className="input" id={`bareos-def-${k}`} style={INP} value={defs[k] || ''} onChange={(e) => setDefs({ ...defs, [k]: e.target.value.trim() })} /></label>
            ))}
            <label className="muted" style={FIELD}>기본 레벨
              <Select className="input" id="bareos-def-level" sort={false} style={INP} value={defs.level} onChange={(e) => setDefs({ ...defs, level: e.target.value })}>
                <option value="Incremental">Incremental</option><option value="Differential">Differential</option><option value="Full">Full</option>
              </Select>
            </label>
            <label className="muted" style={FIELD}>상태 조회 주기(초)<input className="input" id="bareos-def-poll" style={INP} inputMode="numeric" value={defs.pollIntervalSec} onChange={(e) => setDefs({ ...defs, pollIntervalSec: e.target.value.replace(/\D/g, '').slice(0, 4) })} /></label>
          </div>
          {/* v2.839 Director 정책 수집(하루 1회 · 읽기 전용 명령) — 공통 기본값과 함께 저장(policy 묶음째) */}
          <div data-bareos-policy-settings="" style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border-soft)', fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <b style={{ fontSize: 13 }}>Director 정책 수집 — 하루 한 번</b>
            {(() => {
              const pol = { enabled: true, time: '06:10', optional: { schedules: true, jobdefs: true, filesets: true }, off: [], ...(defs.policy || {}) };
              const set = (patch) => setDefs({ ...defs, policy: { ...pol, ...patch } });
              const opt = { schedules: true, jobdefs: true, filesets: true, ...(pol.optional || {}) };
              const off = new Set(pol.off || []);
              return (<>
                <div style={ROW}>
                  <label className="flex" style={{ alignItems: 'center', gap: 5 }}><input type="checkbox" checked={pol.enabled !== false} onChange={(e) => set({ enabled: e.target.checked })} /> 켜기</label>
                  <label className="flex muted" style={{ alignItems: 'center', gap: 6 }}>매일<input className="input" type="time" aria-label="정책 수집 시각" value={pol.time || '06:10'} onChange={(e) => set({ time: e.target.value })} style={{ width: 132, minWidth: 0 }} />(포탈 시각)</label>
                </div>
                <div style={ROW}>
                  <span className="muted">선택 명령(show — 포탈 콘솔 Profile 에 show 가 있어야 합니다)</span>
                  {[['schedules', 'Run 줄'], ['jobdefs', 'JobDefs'], ['filesets', 'FileSet']].map(([k, l]) => (
                    <label key={k} className="flex" style={{ alignItems: 'center', gap: 5 }}><input type="checkbox" checked={opt[k] !== false} onChange={(e) => set({ optional: { ...opt, [k]: e.target.checked } })} /> {l}</label>
                  ))}
                </div>
                {(s.directors || []).length > 0 && (
                  <div style={ROW}>
                    <span className="muted">수집할 Director</span>
                    {(s.directors || []).map((d) => (
                      <label key={d.id} className="flex" style={{ alignItems: 'center', gap: 5 }}><input type="checkbox" checked={!off.has(d.id)} onChange={(e) => { const n = new Set(off); if (e.target.checked) n.delete(d.id); else n.add(d.id); set({ off: [...n] }); }} /> {d.name}</label>
                    ))}
                  </div>
                )}
                <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
                  읽기 전용 명령만 보냅니다(status scheduler · llist pools · list volumes · show schedules/jobdefs/filesets) · Director 마다 시한 · 실패하면 30분 뒤 다시(하루 3번까지) ·
                  결과는 Bareos › 정책 · 일정 과 Backup › Summary 의 풀 · 스케줄 칸에 쓰입니다. 이미 자동 설정한 Director 는 Profile 의 Command ACL 에 show 를 직접 더해야 show 명령이 됩니다.
                </div>
              </>);
            })()}
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.6 }}>
            이름은 자동 설정 2단계가 만드는 리소스 이름과 같아야 합니다. 상태 조회는 Director 마다 따로(병렬 · Director 별 시한) 하므로 느린 법인 하나가 나머지를 막지 않습니다.
            주기 범위는 {s.limits?.pollIntervalSec ? `${s.limits.pollIntervalSec.min}~${s.limits.pollIntervalSec.max}초` : '—'}.
          </div>
          <div style={{ ...ROW, marginTop: 10 }}>
            <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy || !!err || s.demo || !writable} title={!writable ? SETTINGS_READ_ONLY : undefined} onClick={saveDefaults}>{busy ? '저장 중…' : '공통 기본값 저장'}</button>
          </div>
        </div>
        <div className="card" style={{ padding: 14, minWidth: 0 }}>
          <b>법인 서버 사전 준비 — 패키지 설치만</b>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7 }}>
            <li>Rocky · RHEL 9 서버 한 대에 bareos-director · bareos-storage · bareos-filedaemon · bareos-vmware-plugin(+ python3 FD 플러그인)을 설치하고 서비스를 켭니다.</li>
            <li>포탈 서버에서 그 서버의 Director 9101 과 SSH 22(root 비밀번호 로그인)가 열려 있어야 합니다.</li>
            {PREP_CHECKLIST.map((t) => <li key={t}>{t}</li>)}
          </ul>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>나머지(콘솔 · Profile · FileSet · JobDefs · 복원 잡 · Pool · Schedule · FD 플러그인 · 매핑 · FD INI)는 Director 편집 화면의 자동 설정 5단계가 합니다. 손으로 넣으려면 그 화면 2단계의 ‘사전 준비 블록 복사’ 를 쓰세요.</div>
          <div style={{ ...ROW, marginTop: 8 }}><button type="button" className="logout-btn" style={BTN} onClick={() => copy(fdIniTemplate({}))}>FD INI 틀 복사</button></div>
        </div>
      </div>
    </div>
  );
}

/**
 * v2.824 담당 — 중앙 직접('') 또는 그 법인 엣지(중앙이 아는 엣지 이름만 — 서버도 같은 목록으로 거른다).
 * 검토 W11: 저장된 값은 목록에 없어도 늘 선택지로 남기고 '목록에 없음' 을 붙인다(다른 값으로 바꿨다가 되돌릴 수 있게) ·
 * 대행 작업 인출은 엣지별 개별 토큰 전용이라 토큰이 없는 이름에 '개별 토큰 없음 — 대행 불가' 를 붙인다(withToken 을 못 받으면 붙이지 않는다).
 */
function agentIssue(a, agents, withToken) {
  if (!a) return '';
  if (!(agents || []).includes(a)) return 'gone';
  const tok = Array.isArray(withToken) ? new Set(withToken.map((x) => String(x).toLowerCase())) : null;
  return tok && !tok.has(a.toLowerCase()) ? 'token' : '';
}
function AgentSelect({ agents, value, onChange, saved = '', withToken = null }) {
  const list = [...new Set([...(saved ? [saved] : []), ...(value ? [value] : []), ...(agents || [])])];
  // Chromium 확인: 좁은 칸에서 닫힌 선택 상자는 뒤가 잘린다 — 표지는 짧게, 고른 값의 문제는 격자 밖 한 줄(AgentIssueLine)에 풀어 쓴다
  const label = (a) => { const i = agentIssue(a, agents, withToken); return `엣지 ${a}${i === 'gone' ? ' (목록에 없음)' : i === 'token' ? ' (토큰 없음)' : ''}`; };
  return (
    <label className="muted" style={FIELD}>담당(접속 주체)
      <Select className="input" style={INP} value={value || ''} onChange={(e) => onChange(e.target.value)} aria-label="담당 엣지">
        <option value="">중앙 직접</option>
        {list.map((a) => <option key={a} value={a}>{label(a)}</option>)}
      </Select>
    </label>
  );
}
/** 고른 담당의 문제(목록에 없음·개별 토큰 없음) — 격자 밖 전체 폭(칸 안에 두면 같은 줄 다른 칸이 밀렸다 · Chromium 1440). 없으면 아무것도 그리지 않는다. */
function AgentIssueLine({ value, agents, withToken }) {
  const why = agentIssue(value, agents, withToken);
  if (!why) return null;
  return (
    <div style={{ fontSize: 11.5, lineHeight: 1.6, marginTop: 6, color: 'var(--amber)' }}>{why === 'gone'
      ? `담당 ‘${value}’ 는 중앙이 아는 엣지 목록에 없습니다 — 엣지 이름이 바뀌었거나 등록에서 빠졌을 수 있습니다.`
      : `담당 ‘${value}’ 엣지에 개별 토큰이 없어 대행 작업을 가져가지 못합니다 — 중앙 설정 › 수집 서버에서 개별 토큰을 발급하세요.`}</div>
  );
}

/** Director 추가 — 이름·주소·포트·콘솔 이름·비밀번호(자동 설정을 쓸 거면 비밀번호는 비워 둔다 — 2단계가 만든다). */
function AddDirectorForm({ agents, withToken, onDone }) {
  const [f, setF] = useState({ name: '', host: '', port: '9101', consoleName: '', password: '', agent: '' });
  const [busy, setBusy] = useState(false);
  const [m, setM] = useState(null);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const submit = async () => {
    setBusy(true); setM(null);
    try {
      const r = await postJson(`${BASE}/settings/directors`, { ...f, port: Number(f.port) || 9101 });
      requireChanged(r);
      await onDone(r);
    } catch (e) { setM({ ok: false, text: `추가 실패: ${e.message}` }); } finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ padding: 12, marginTop: 10, background: 'var(--panel-deep)', minWidth: 0 }}>
      <div style={GRID}>
        <label className="muted" style={FIELD}>법인 이름<input className="input" id="bareos-new-name" style={INP} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="폴란드 법인" /></label>
        <label className="muted" style={FIELD}>Director 주소<input className="input" id="bareos-new-host" style={INP} value={f.host} onChange={(e) => set('host', e.target.value.trim())} placeholder="bareos.pl.corp" /></label>
        <label className="muted" style={FIELD}>포트<input className="input" style={INP} inputMode="numeric" value={f.port} onChange={(e) => set('port', e.target.value.replace(/\D/g, '').slice(0, 5))} aria-label="Director 포트" /></label>
        <label className="muted" style={FIELD}>콘솔 이름(있으면)<input className="input" style={INP} value={f.consoleName} onChange={(e) => set('consoleName', e.target.value)} placeholder="자동 설정이 만듭니다" aria-label="콘솔 이름" /></label>
        <label className="muted" style={FIELD}>콘솔 비밀번호(있으면)<input className="input" style={INP} type="password" autoComplete="new-password" value={f.password} onChange={(e) => set('password', e.target.value)} placeholder="자동 설정이 만듭니다" aria-label="콘솔 비밀번호" /></label>
        <AgentSelect agents={agents} withToken={withToken} value={f.agent} onChange={(v) => set('agent', v)} />
      </div>
      <AgentIssueLine value={f.agent} agents={agents} withToken={withToken} />
      <div style={{ ...ROW, marginTop: 10 }}>
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={busy || !f.name.trim() || !f.host} onClick={submit}>{busy ? '추가 중…' : '추가'}</button>
        <span className="muted" style={{ fontSize: 11.5 }}>{missingText([[f.name.trim(), '법인 이름'], [f.host, 'Director 주소']]) || '초기 설치만 된 서버면 콘솔은 비워 두고 추가한 뒤 자동 설정을 쓰세요.'}</span>
      </div>
      <Msg m={m} />
    </div>
  );
}

/* ───────────────────────── Director 편집 ───────────────────────── */
function DirectorEditor({ s, dir, locked, onReload, onSaved, onClose, onDeleted }) {
  const toForm = (d) => ({ name: d.name, host: d.host, port: d.port, consoleName: d.consoleName, password: '', timeoutMs: d.timeoutMs, tlsMax: d.tlsMax, agent: d.agent || '' });
  const [form, setForm] = useState(() => toForm(dir));
  const mine = useMemo(() => s.sites.filter((x) => x.directorId === dir.id).map((x) => ({ ...x })), [s.sites, dir.id]);
  const [rows, setRows] = useState(mine);
  const [cat, setCat] = useState(null);
  const [catErr, setCatErr] = useState(null);
  const [diag, setDiag] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [mapMsg, setMapMsg] = useState(null);
  const catGen = useRef(0);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // 서버가 Director 를 바꿨으면(자동 설정 — 콘솔·비밀번호) 접속 폼을 새 값으로(입력 중인 비밀번호는 비운다)
  useEffect(() => { setForm(toForm(dir)); }, [dir.host, dir.port, dir.consoleName, dir.hasPassword, dir.name, dir.agent]);
  const vcName = (id) => s.vcenters.find((v) => v.id === id)?.name || id;
  const canConnect = !!(dir.host && dir.consoleName && dir.hasPassword) || s.demo;
  const loadCat = (refresh) => {
    const g = ++catGen.current;
    setCatErr(null);
    fetchJson(`${BASE}/settings/directors/${enc(dir.id)}/catalog`, refresh ? { refresh: 1 } : {}, undefined, withRelayWait(DIRECTOR_GET, dir, s.relayLimits, 'catalog'))
      .then((r) => { if (g === catGen.current) setCat(r); }).catch((e) => { if (g === catGen.current) setCatErr(e); });
  };
  useEffect(() => { if (canConnect) loadCat(false); }, [dir.id, canConnect]);
  const unsaved = JSON.stringify(rows) !== JSON.stringify(mine);
  const jobsOn = (vc) => Number(s.jobsByVcenter?.[vc] || 0);
  const lockedRow = (vc) => jobsOn(vc) > 0 && mine.some((x) => x.vcenterId === vc);
  const close = () => { if (!unsaved || window.confirm('저장하지 않은 매핑 변경이 있습니다 — 버리고 닫을까요?')) onClose(); };   // W17

  const saveConn = async () => {
    const patch = directorFormPatch(form, dir);
    if (!patch) { setMsg({ ok: true, text: '바뀐 칸이 없습니다.' }); return; }
    setBusy('conn'); setMsg(null);
    try {
      const r = await putJson(`${BASE}/settings/directors/${enc(dir.id)}`, patch);
      requireChanged(r);
      const dropped = droppedSecretNote(r);
      setMsg({ ok: true, text: `저장했습니다.${dropped ? ` ${dropped}` : ''}` });
      // W5: 저장한 비밀번호를 칸에 남기지 않는다(그대로 두면 다음 저장·시험이 그 값을 새 주소로 보낸다)
      setForm((x) => ({ ...x, password: '' }));
      await onReload(); onSaved();
      // W16: 콘솔 접속값이 갖춰졌을 때만 카탈로그를 다시 읽는다(없으면 '읽지 않습니다' 와 빨간 오류가 함께 떴다)
      const nd = r.director || {};
      if (nd.host && nd.consoleName && nd.hasPassword) loadCat(true);
    } catch (e) { setMsg({ ok: false, text: `저장 실패: ${e.message}` }); } finally { setBusy(''); }
  };
  const test = async () => {
    setBusy('test'); setMsg(null); setDiag(null);
    try {
      const r = await postJson(`${BASE}/settings/directors/${enc(dir.id)}/test`, form.password ? { ...form } : {}, withRelayWait({}, dir, s.relayLimits, 'probe'));
      requireChanged(r);
      setDiag(r.stages || null);
      // W2: 엣지 대행이면 그 엣지가 시험했다고 밝힌다(엣지는 작업의 접속값 표지로 중앙 저장값과 같은 사본인지 확인한 뒤 시험한다)
      setMsg({ ok: true, text: `연결 성공 — Director ‘${r.director || '?'}’ ${r.version || ''} · ${r.tls ? `${r.tls.protocol} ${r.tls.cipher}` : '암호화 없음'} · 클라이언트 ${r.clients ? `${r.clients.length}개` : '—'}${form.password ? '' : ` (저장된 주소·비밀번호로 시험${r.relay ? ` — 법인 엣지 ‘${r.relay}’ 가 접속` : ''})`}` });
    } catch (e) {
      setDiag(Array.isArray(e?.body?.stages) ? e.body.stages : null);
      setMsg({ ok: false, text: `연결 실패: ${e.message}` });
    } finally { setBusy(''); }
  };
  const remove = async () => {
    if (!window.confirm(`‘${dir.name}’ Director 를 포탈 설정에서 지울까요?\nBareos 서버의 설정·백업 데이터는 그대로입니다. 묶인 vCenter 나 백업 대상이 있으면 지우지 않습니다.`)) return;
    setBusy('del'); setMsg(null);
    try { const r = await delJson(`${BASE}/settings/directors/${enc(dir.id)}`); requireChanged(r); await onDeleted(dir.name); } catch (e) { setMsg({ ok: false, text: `삭제 실패: ${e.message}` }); setBusy(''); }
  };

  // vCenter 묶기 — 표의 행이 곧 매핑이다(체크하면 빈 매핑 행을 만든다 · 저장은 아래 '매핑 저장')
  const bound = new Set(rows.map((x) => x.vcenterId));
  // W2·W17: 새로 묶으면 vcserver(등록부 주소)·INI 경로를 미리 채우고, 저장된 vCenter 를 껐다 켜면 저장본을 되살린다
  const toggleVc = (vc, on) => {
    if (on) {
      const saved = mine.find((x) => x.vcenterId === vc);
      setRows((r) => [...r, saved ? { ...saved } : newMappingRow(vc, dir.id, hostOf(s.vcenters.find((v) => v.id === vc)), [...s.sites, ...r].map((x) => x.configFile))]);
    } else setRows((r) => r.filter((x) => x.vcenterId !== vc));
  };
  const setRow = (vc, k, v) => setRows((r) => r.map((x) => (x.vcenterId === vc ? { ...x, [k]: v } : x)));
  const saveMap = async () => {
    setBusy('map'); setMapMsg(null);
    try {
      const sites = [...s.sites.filter((x) => x.directorId !== dir.id), ...rows];
      // P4·W17: 읽은 설정 세대(rev)를 함께 — 그사이 다른 화면(다른 Director 편집)이 저장했으면 409 로 다시 읽게 한다(조용히 덮지 않는다)
      const r = await putJson(`${BASE}/settings`, { rev: s.rev, sites });
      requireChanged(r);
      setMapMsg({ ok: true, text: `매핑을 저장했습니다(이 Director ${rows.length}개 vCenter). 이미 만든 Bareos 잡은 바뀌지 않습니다 — 새로 등록하는 대상부터 적용됩니다.` });
      await onReload(); onSaved();
    } catch (e) {
      setMapMsg({ ok: false, text: `저장 실패: ${e.message}${e?.body?.code === 'stale' ? ' — 최신 설정을 다시 읽었습니다. 표의 변경은 그대로 두었으니 확인한 뒤 다시 저장하세요.' : ''}` });
      if (e?.body?.code === 'stale') await onReload();
    } finally { setBusy(''); }
  };
  const fillMap = async () => {
    setBusy('suggest'); setMapMsg(null);
    try {
      const r = await fetchJson(`${BASE}/settings/directors/${enc(dir.id)}/suggest`, {}, undefined, withRelayWait(DIRECTOR_GET, dir, s.relayLimits, 'catalog'));
      const out = fillEmptyMapping(rowsRef.current, r.suggestions, vcName);   // W10: 기다리는 동안 고친 칸을 요청 때 사본으로 덮지 않는다
      setRows(out.sites);
      setMapMsg({ ok: true, text: `빈 칸 ${out.filled}개를 채웠습니다(저장 전입니다 — 확인한 뒤 ‘매핑 저장’ 을 누르세요).${out.left.length ? ` 제안이 없어 남은 칸: ${out.left.slice(0, 6).join(', ')}${out.left.length > 6 ? ` 외 ${out.left.length - 6}` : ''}.` : ''}` });
      return out.filled;
    } catch (e) { setMapMsg({ ok: false, text: `매핑 채움 실패: ${e.message}` }); return null; } finally { setBusy(''); }
  };
  const opts = (k, cur) => { const list = cat?.[k] || []; return [...new Set([...(cur ? [cur] : []), ...list])]; };
  const set = (k, v) => setForm((x) => ({ ...x, [k]: v }));

  return (
    <div className="card" style={{ padding: 14, marginBottom: 12, minWidth: 0, borderColor: 'var(--accent)' }}>
      <div style={ROW}>
        <b style={{ fontSize: 15 }}>{dir.name}</b>
        <span className="badge gray">{dir.hasPassword ? '콘솔 비밀번호 저장됨' : '콘솔 비밀번호 없음'}</span>
        <span className="badge gray">백업 대상 {dir.jobs ?? 0}</span>
        <div style={{ flexGrow: 1 }} />
        <button type="button" className="logout-btn" style={BTN} onClick={close}>닫기</button>
        <button type="button" className="logout-btn" style={{ ...BTN, color: 'var(--red)' }} disabled={!!busy || s.demo || locked} onClick={remove}>Director 삭제</button>
      </div>

      <div style={{ ...CARDS(340), marginTop: 10 }}>
        <div className="card" style={{ padding: 12, minWidth: 0, background: 'var(--panel-deep)' }}>
          <b>연결</b>
          <div style={GRID}>
            <label className="muted" style={FIELD}>법인 이름<input className="input" style={INP} value={form.name} onChange={(e) => set('name', e.target.value)} aria-label="법인 이름" /></label>
            <label className="muted" style={FIELD}>Director 주소<input className="input" id="bareos-dir-host" style={INP} value={form.host} onChange={(e) => set('host', e.target.value.trim())} aria-label="Director 주소" /></label>
            <label className="muted" style={FIELD}>포트<input className="input" style={INP} inputMode="numeric" value={form.port} onChange={(e) => set('port', e.target.value.replace(/\D/g, '').slice(0, 5))} aria-label="Director 포트" /></label>
            <label className="muted" style={FIELD}>콘솔 이름<input className="input" style={INP} value={form.consoleName} onChange={(e) => set('consoleName', e.target.value)} aria-label="콘솔 이름" /></label>
            <label className="muted" style={FIELD}>콘솔 비밀번호 {dir.hasPassword ? <span style={{ color: 'var(--green)' }}>저장됨</span> : <span style={{ color: 'var(--red)' }}>없음</span>}
              <input className="input" id="bareos-dir-pw" style={INP} type="password" autoComplete="new-password" value={form.password} onChange={(e) => set('password', e.target.value)} placeholder="바꿀 때만 입력" />
            </label>
            <label className="muted" style={FIELD}>명령 시한(초)<input className="input" style={INP} inputMode="numeric" value={Math.round((Number(form.timeoutMs) || 0) / 1000) || ''} onChange={(e) => set('timeoutMs', (Number(e.target.value.replace(/\D/g, '')) || 0) * 1000)} aria-label="명령 시한" /></label>
            <label className="muted" style={FIELD}>TLS 최고 버전
              <Select className="input" sort={false} style={INP} value={form.tlsMax} onChange={(e) => set('tlsMax', e.target.value)} aria-label="TLS 최고 버전">
                <option value="TLSv1.3">TLS 1.3(기본)</option><option value="TLSv1.2">TLS 1.2</option>
              </Select>
            </label>
            <AgentSelect agents={s.agents || []} withToken={s.agentsWithToken} saved={dir.agent || ''} value={form.agent} onChange={(v) => set('agent', v)} />
          </div>
          <AgentIssueLine value={form.agent} agents={s.agents || []} withToken={s.agentsWithToken} />
          {/* W8: 지금 동작은 저장된 담당 기준이다 — 고르기만 하고 저장하지 않았으면 그렇게 말한다 · W9: 주기 숫자를 박지 않는다 */}
          {(form.agent || '') !== (dir.agent || '') && <div className="banner warn" style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6 }}>담당을 바꿨습니다(저장 전) — 지금 연결 시험·자동 설정은 저장된 담당({dir.agent ? `법인 엣지 ‘${dir.agent}’` : '중앙 직접'})으로 실행합니다. ‘연결 저장’ 을 누르면 {form.agent ? `법인 엣지 ‘${form.agent}’ 가` : '중앙이 직접'} 접속합니다.</div>}
          {dir.agent && <div className="banner" style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6 }}>법인 엣지 ‘{dir.agent}’ 가 이 Director 에 대신 접속합니다(중앙은 접속하지 않습니다). 엣지는 저장된 접속값으로 접속합니다 — 엣지 사본이 다르면 작업 전에 배정을 다시 받습니다. 새 비밀번호는 저장한 뒤 시험하세요. 자동 설정도 그 엣지가 SSH 로 실행하고, 처음 접속하는 서버의 SSH 호스트키 승인은 <b>그 엣지 포탈</b>(설정 › 장비 신뢰)에서 합니다.</div>}
          {dir.agent && (s.relayPending || []).some((o) => o.directorId === dir.id) && (
            <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>엣지 대행 작업(이 화면을 연 때 기준): {(s.relayPending || []).filter((o) => o.directorId === dir.id).slice(0, 6).map((o) => `${relayKindLabel(o.kind)} ${o.status === 'queued' ? '인출 대기' : '엣지 실행 중'} ${secText(o.ageMs)}`).join(' · ')}</div>
          )}
          <div className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.6 }}>주소·포트·콘솔 이름을 바꾸면 이 Director 의 저장 비밀번호는 승계하지 않습니다. 저장된 비밀번호로 하는 연결 시험은 저장된 주소로만 접속합니다.</div>
          <div style={{ ...ROW, marginTop: 10 }}>
            <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={!!busy || locked || s.demo} onClick={saveConn}>{busy === 'conn' ? '저장 중…' : '연결 저장'}</button>
            <button type="button" className="logout-btn" style={{ padding: '7px 14px' }} disabled={!!busy} onClick={test}>{busy === 'test' ? '시험 중…' : '연결 시험'}</button>
          </div>
          {diag && <DiagStages stages={diag} />}
          <Msg m={msg} />
        </div>

        <div className="card" style={{ padding: 12, minWidth: 0, background: 'var(--panel-deep)' }}>
          <b>이 Director 에 묶는 vCenter</b>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8, maxHeight: 260, overflow: 'auto' }}>
            {s.vcenters.map((v) => {
              const other = s.sites.find((x) => x.vcenterId === v.id && x.directorId !== dir.id);
              const otherName = other ? s.directors.find((d) => d.id === other.directorId)?.name || other.directorId : '';
              const on = bound.has(v.id);
              const lockedVc = on && lockedRow(v.id);
              return (
                <label key={v.id} style={{ ...ROW, justifyContent: 'space-between', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--panel)', opacity: other ? 0.6 : 1, cursor: other || lockedVc ? 'default' : 'pointer' }}>
                  <span style={{ ...ROW, gap: 8 }}><input type="checkbox" checked={on} disabled={!!other || lockedVc || busy === 'suggest'} onChange={(e) => toggleVc(v.id, e.target.checked)} /><span>{v.name}</span></span>
                  <span className="muted" style={{ fontSize: 11.5 }}>{other ? `${otherName} 에 묶임` : lockedVc ? `백업 대상 ${jobsOn(v.id)} — 대상을 지워야 뺄 수 있습니다` : on ? (mine.some((x) => x.vcenterId === v.id) ? '묶임' : '저장 전') : '—'}</span>
                </label>
              );
            })}
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.6 }}>vCenter 하나는 Director 하나에만 묶습니다. 백업 대상이 있는 vCenter 는 다른 Director 로 옮길 수 없습니다(잡은 지금 Director 의 설정에 있습니다).</div>
        </div>
      </div>

      <AutoSetupPanel s={s} dir={dir} rows={mine} editCount={rows.length} cat={cat} unsaved={unsaved} locked={locked}
        onDirectorDone={async () => { await onReload(); onSaved(); loadCat(true); }} onMaybeChanged={onReload} onFill={fillMap} busyOuter={busy} />

      <div style={{ ...ROW, marginTop: 14, marginBottom: 6 }}>
        <b>이 Director 의 vCenter 매핑</b>
        <span className="muted" style={{ fontSize: 12 }}>vCenter 마다 백업 데이터가 머무는 FD · SD · 풀(같은 법인 서버)</span>
        <div style={{ flexGrow: 1 }} />
        <button type="button" className="logout-btn" style={BTN} disabled={!canConnect || !!busy} onClick={() => loadCat(true)}>카탈로그 새로 고침</button>
        <button type="button" className="logout-btn" style={BTN} disabled={!canConnect || !rows.length || !!busy} onClick={fillMap}>{busy === 'suggest' ? '채우는 중…' : '빈 칸 채우기(4단계)'}</button>
      </div>
      {catErr && <div className="muted" style={{ fontSize: 12, color: 'var(--red)', marginBottom: 6 }}>카탈로그를 읽지 못했습니다: {catErr.message} — 이름을 직접 적으세요.</div>}
      {cat?.errors && Object.keys(cat.errors).length > 0 && <div className="muted" style={{ fontSize: 12, color: 'var(--amber)', marginBottom: 6 }}>카탈로그 일부를 읽지 못했습니다({Object.keys(cat.errors).join(' · ')}) — 그 칸은 이름을 직접 적으세요.</div>}
      {!canConnect && <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>콘솔 접속값이 아직 없어 카탈로그를 읽지 않습니다 — 자동 설정 2단계를 끝내면 드롭다운이 채워집니다.</div>}
      <div className="table-wrap" style={{ maxHeight: '44vh' }}>
        {/* Chromium 1440 확인: '작업' 열이 표 오른쪽 밖(안쪽 가로 스크롤)이라 빼기 버튼이 보이지 않았다 — 버튼을 첫 열(vCenter) 아래로 옮겼다 */}
        {/* 칸 입력은 고정폭 대신 최소폭 + 100% — 1440 에서 마지막 'FD INI 경로' 칸이 45px 잘렸다(Chromium r2) */}
        <STable minWidth={1000} sortable={false}>
          <thead><tr><th>vCenter</th>{MAPPING_FIELDS.map(([k, l]) => <th key={k}>{l}</th>)}</tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={7} className="center muted" style={{ padding: 16 }}>묶은 vCenter 가 없습니다 — 위에서 이 법인의 vCenter 를 체크하세요.</td></tr>}
            {rows.map((x) => { const gone = !s.vcenters.some((v) => v.id === x.vcenterId); return (
              <tr key={x.vcenterId}>
                <td style={{ minWidth: 150 }}>
                  <b>{vcName(x.vcenterId)}</b><div className="muted" style={{ fontSize: 11 }}>{x.vcenterId}{gone ? ' · 인벤토리에 없음' : ''}</div>
                  <div style={{ ...ROW, gap: 6, marginTop: 4 }}>
                    <button type="button" className="logout-btn" style={{ ...BTN, padding: '2px 7px', fontSize: 11 }} onClick={() => copyWith(setMapMsg)(fdIniTemplate(x))}>INI 복사</button>
                    {/* W1: 인벤토리에서 빠진 vCenter 의 행도 여기서 뺄 수 있다(체크 목록에는 없다 — 남으면 모든 매핑 저장이 400) */}
                    <button type="button" className="logout-btn" style={{ ...BTN, padding: '2px 7px', fontSize: 11 }} disabled={lockedRow(x.vcenterId) || busy === 'suggest'} title={lockedRow(x.vcenterId) ? '백업 대상이 있어 뺄 수 없습니다 — 대상을 먼저 지우세요' : undefined} onClick={() => toggleVc(x.vcenterId, false)}>빼기</button>
                  </div>
                </td>
                <td><input className="input" aria-label="vcserver" value={x.vcserver} onChange={(e) => setRow(x.vcenterId, 'vcserver', e.target.value.trim())} style={{ ...INP, minWidth: 130 }} placeholder={s.vcenters.find((v) => v.id === x.vcenterId)?.host || 'vCenter 주소'} /></td>
                {[['client', 'clients'], ['storage', 'storages'], ['pool', 'pools'], ['schedule', 'schedules']].map(([k, ck]) => (
                  <td key={k}>{cat?.[ck] ? (
                    <Select className="input" aria-label={k} value={x[k]} onChange={(e) => setRow(x.vcenterId, k, e.target.value)} style={{ ...INP, minWidth: 110 }}>
                      <option value="">{k === 'schedule' ? '— (수동)' : '선택…'}</option>
                      {opts(ck, x[k]).map((n) => <option key={n} value={n}>{n}</option>)}
                    </Select>
                  ) : <input className="input" aria-label={k} value={x[k]} onChange={(e) => setRow(x.vcenterId, k, e.target.value.trim())} style={{ ...INP, minWidth: 100 }} />}</td>
                ))}
                <td><input className="input" aria-label="INI 경로" value={x.configFile} onChange={(e) => setRow(x.vcenterId, 'configFile', e.target.value.trim())} style={{ ...INP, minWidth: 170 }} placeholder={`/etc/bareos/vmware/${vcSlug(x.vcenterId)}.ini`} /></td>
              </tr>
            ); })}
          </tbody>
        </STable>
      </div>
      <div style={{ ...ROW, marginTop: 10 }}>
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={!!busy || locked || !unsaved || s.demo} onClick={saveMap}>{busy === 'map' ? '저장 중…' : '매핑 저장'}</button>
        <span className="muted" style={{ fontSize: 12 }}>{unsaved ? '저장하지 않은 변경이 있습니다.' : '저장된 상태입니다.'} 빈 칸이 있는 vCenter 의 VM 은 등록할 수 없습니다(사유가 등록 화면에 나옵니다).</span>
      </div>
      <Msg m={mapMsg} />
    </div>
  );
}

/* ───────────────────────── 자동 설정 5단계 ───────────────────────── */
const STEP_NAMES = ['사전 점검', 'Director 리소스', 'FD 플러그인 켜기', '매핑 채움 · 저장', 'FD INI · 지문'];

/**
 * 자동 설정 5단계(v2.823 — Director 하나). SSH 접속값·OTP 는 위 한 곳에서 넣는다(비밀번호는 저장하지 않는다 · OTP 는 쓰기 단계마다 새 코드).
 * 단계 상태는 **이 화면에서 실행한 결과**다(다시 열면 비어 있다 — 서버에 단계 기록을 두지 않는다).
 */
function AutoSetupPanel({ s, dir, rows, editCount, cat, unsaved, locked, onDirectorDone, onMaybeChanged, onFill, busyOuter }) {
  const [ssh, setSsh] = useState({ host: dir.host || '', sshPort: '22', username: 'root', password: '', otp: '' });
  // W6: 손대지 않은 SSH 주소·Director 포트는 연결 저장을 따라간다(옛 값으로 2단계를 돌리면 Director 연결을 옛 주소로 되돌렸다)
  const touched = useRef({});
  const [st, setSt] = useState({});          // 단계 번호 → { ok, at, text }
  const [pf, setPf] = useState(null);        // 사전 점검 결과
  const [copyMsg, setCopyMsg] = useState(null);
  const [busy, setBusy] = useState('');
  const [d, setD] = useState({ directorPort: String(dir.port || 9101), consoleName: dir.consoleName || 'portal', restoreClient: '', restoreStorage: '', restorePool: '',
    usePools: true, fullDays: '90', incrDays: '30', maxVolumeGB: '50', useSchedule: true, fullDay: 'sun', time: '02:00' });
  const [f, setF] = useState({ vcenterId: rows[0]?.vcenterId || '', fdHost: '', vcuser: '', vcpass: '', vcthumbprint: '' });
  const mark = (n, ok, text) => setSt((x) => ({ ...x, [n]: { ok, at: Date.now(), text } }));
  const unmark = (n) => setSt((x) => { if (!x[n]) return x; const y = { ...x }; delete y[n]; return y; });
  useEffect(() => { if (!touched.current.host) setSsh((x) => ({ ...x, host: dir.host || '' })); }, [dir.host]);
  useEffect(() => { if (!touched.current.directorPort) setD((x) => ({ ...x, directorPort: String(dir.port || 9101) })); }, [dir.port]);
  // W12: FD 주소를 비워 SSH 주소를 쓰는 동안 SSH 주소가 바뀌면 읽어 둔 지문·5단계 결과는 그 서버의 것이 아니다
  const setS2 = (k, v) => {
    if (k === 'host') { touched.current.host = true; if (!f.fdHost && v !== ssh.host) { setF((x) => ({ ...x, vcthumbprint: '' })); unmark(5); } }
    setSsh((x) => ({ ...x, [k]: v }));
  };
  const setDk = (k, v) => {
    if (k === 'directorPort') touched.current.directorPort = true;
    setD((x) => {
      const y = { ...x, [k]: v };
      // W8: 전용 Pool 을 끄면 그 Pool 을 가리키던 복원 풀은 비운다(정의 없는 풀을 참조하면 bareos-dir -t 가 거부한다)
      if (k === 'usePools' && !v && x.restorePool === VMWARE_POOL_FULL && !(cat?.pools || []).includes(VMWARE_POOL_FULL) && !(pf?.resources?.pool || []).includes(VMWARE_POOL_FULL)) y.restorePool = '';
      return y;
    });
  };
  // W2-3·W12: 대상 vCenter·FD 주소가 바뀌면 읽어 둔 지문과 그 결과 배너는 그 대상의 것이 아니다 — 비운다
  const setFk = (k, v) => {
    if ((k === 'vcenterId' || k === 'fdHost') && f[k] !== v) unmark(5);
    setF((x) => ({ ...x, [k]: v, ...((k === 'vcenterId' || k === 'fdHost') && x[k] !== v ? { vcthumbprint: '' } : {}) }));
  };
  const sshBody = { host: ssh.host, sshPort: Number(ssh.sshPort) || 22, username: ssh.username, password: ssh.password };
  const otpOk = /^\d{6}$/.test(ssh.otp);
  const sshOk = !!(ssh.host && ssh.password);
  const res = pf?.resources || {};
  const pick = (catKey, pfKey) => [...new Set([...(cat?.[catKey] || []), ...(res[pfKey] || []), ...(catKey === 'pools' && d.usePools ? [VMWARE_POOL_FULL] : [])])];
  const site = rows.find((x) => x.vcenterId === f.vcenterId);
  // 실패 공통 — SSH 인증 실패면 비밀번호를 비운다(같은 인증을 되풀이하지 않게 — 자동 재시도 금지) · OTP 는 쓰기 단계마다 비운다
  const onFail = (n, e, label, write) => {
    const unknown = outcomeUnknown(e);
    mark(n, false, unknown ? `${label} 결과를 확인하지 못했습니다(${e.message}) — 서버에서는 계속 진행됐을 수 있습니다(감사 로그 확인).` : `${label} 실패: ${e.message}`);
    setSsh((x) => ({ ...x, ...(write ? { otp: '' } : {}), ...(e?.body?.code === 'ssh-auth' ? { password: '' } : {}) }));
    if (unknown && n === 2) onMaybeChanged?.();
  };
  const url = (p) => `${BASE}/settings/directors/${enc(dir.id)}/auto-setup/${p}`;

  const runPreflight = async () => {
    setBusy('1');
    try {
      const r = await postJson(url('preflight'), sshBody, withRelayWait({}, dir, s.relayLimits, 'setup.preflight', { setup: true }));
      requireChanged(r);
      setPf(r);
      const rr = r.resources || {};
      setD((x) => ({ ...x, restoreClient: x.restoreClient || (rr.client || [])[0] || '', restoreStorage: x.restoreStorage || (rr.storage || [])[0] || '', restorePool: x.restorePool || (x.usePools ? VMWARE_POOL_FULL : (rr.pool || [])[0] || '') }));
      // W11: 못 읽음(unknown)·주의(warn)가 있으면 '완료' 가 아니라 '확인 필요'
      mark(1, r.items.some((x) => x.status === 'missing') ? false : r.items.some((x) => x.status === 'warn' || x.status === 'unknown') ? 'warn' : true, preflightSummary(r));
    } catch (e) { onFail(1, e, '사전 점검', false); } finally { setBusy(''); }
  };
  const runDirector = async () => {
    setBusy('2');
    try {
      const body = { ...sshBody, otp: ssh.otp, directorPort: Number(d.directorPort) || 9101, consoleName: d.consoleName, restoreClient: d.restoreClient, restoreStorage: d.restoreStorage, restorePool: d.restorePool,
        ...(d.usePools ? { pools: { fullDays: Number(d.fullDays), incrDays: Number(d.incrDays), maxVolumeGB: Number(d.maxVolumeGB) } } : {}),
        ...(d.useSchedule ? { schedule: { fullDay: d.fullDay, time: d.time } } : {}) };
      const r = await postJson(url('director'), body, withRelayWait({}, dir, s.relayLimits, 'setup.director', { setup: true }));
      requireChanged(r);
      mark(2, true, autoSetupDirectorText(r));
      setSsh((x) => ({ ...x, otp: '' }));
      await onDirectorDone();
    } catch (e) { onFail(2, e, 'Director 자동 설정', true); } finally { setBusy(''); }
  };
  const runPlugin = async () => {
    setBusy('3');
    try {
      const r = await postJson(url('fd-plugin'), { ...sshBody, otp: ssh.otp }, withRelayWait({}, dir, s.relayLimits, 'setup.fdPlugin', { setup: true }));
      requireChanged(r);
      mark(3, true, autoSetupFdPluginText(r));
      setSsh((x) => ({ ...x, otp: '' }));
    } catch (e) { onFail(3, e, 'FD 플러그인 켜기', true); } finally { setBusy(''); }
  };
  const fdBody = () => ({ ...sshBody, host: f.fdHost || ssh.host, vcenterId: f.vcenterId });
  const readThumb = async () => {
    setBusy('4t');
    const want = { vcenterId: f.vcenterId, fdHost: f.fdHost };
    try {
      const r = await postJson(url('fd-thumbprint'), fdBody(), withRelayWait({}, dir, s.relayLimits, 'setup.thumbprint', { setup: true }));
      requireChanged(r);
      if (r.vcenterId && r.vcenterId !== want.vcenterId) throw new Error('응답이 고른 vCenter 의 것이 아닙니다 — 다시 읽으세요.');
      setF((x) => (x.vcenterId === want.vcenterId && x.fdHost === want.fdHost ? { ...x, vcthumbprint: r.thumbprint } : x));
      mark(5, null, thumbprintText(r));
    } catch (e) { onFail(5, e, '지문 읽기', false); } finally { setBusy(''); }
  };
  const runFd = async () => {
    setBusy('5');   // v2.825.1 버그 점검(G11): 4단계(빈 칸 채우기)와 같은 표지를 써서 서로의 버튼이 '채우는 중…'·'쓰는 중…' 으로 보였다
    try {
      const r = await postJson(url('fd'), { ...fdBody(), otp: ssh.otp, vcuser: f.vcuser, vcpass: f.vcpass, vcthumbprint: f.vcthumbprint }, withRelayWait({}, dir, s.relayLimits, 'setup.fdIni', { setup: true }));
      requireChanged(r);
      mark(5, true, autoSetupFdText(r));
      setF((x) => ({ ...x, vcpass: '' }));
      setSsh((x) => ({ ...x, otp: '' }));
    } catch (e) { onFail(5, e, 'FD INI 자동 설정', true); } finally { setBusy(''); }
  };
  const runFill = async () => {
    setBusy('4');
    const n = await onFill();
    if (n !== null) mark(4, null, `매핑 빈 칸 ${n}개를 채웠습니다 — 아래 표에서 확인하고 ‘매핑 저장’ 을 누르세요(저장해야 5단계가 그 값을 씁니다).`);
    else mark(4, false, '매핑 채움 실패 — 아래 표의 안내를 보세요.');
    setBusy('');
  };

  const any = !!busy || !!busyOuter || locked || s.demo;
  const dReady = sshOk && otpOk && d.restoreClient && d.restoreStorage && d.restorePool && !any;
  const dMissing = missingText([[sshOk, 'SSH 주소·비밀번호'], [d.restoreClient && d.restoreStorage && d.restorePool, '복원 잡 FD·스토리지·풀'], [otpOk, 'OTP 6자리']]);
  // W3: FD INI 는 저장된 매핑의 vcserver·INI 경로를 쓴다 — 비어 있으면 4단계(채움 → 저장)가 먼저다
  const siteReady = !!(site && site.vcserver && site.configFile);
  const fReady = sshOk && siteReady && f.vcuser && f.vcpass && f.vcthumbprint && otpOk && !unsaved && !any;
  const fMissing = missingText([[site, '저장된 매핑의 vCenter'], [!site || siteReady, '매핑의 vcserver·INI 경로(4단계 채움 → 저장)'], [!unsaved, '매핑 저장(표에 저장하지 않은 변경)'], [sshOk, 'SSH 주소·비밀번호'], [f.vcuser && f.vcpass, 'vCenter 계정·비밀번호'], [f.vcthumbprint, '지문'], [otpOk, 'OTP 6자리']]);
  const prep = directorPrepBlock({ defaults: s.defaults, consoleName: d.consoleName, anyClient: d.restoreClient || 'bareos-fd', anyStorage: d.restoreStorage || 'File', anyPool: d.restorePool || 'Full',
    pools: d.usePools ? { fullDays: Number(d.fullDays) || 90, incrDays: Number(d.incrDays) || 30, maxVolumeGB: Number(d.maxVolumeGB) || 50 } : null,
    schedule: d.useSchedule ? { fullDay: d.fullDay, time: d.time } : null });

  return (
    <div className="card" style={{ padding: 12, marginTop: 12, minWidth: 0, background: 'var(--panel-deep)' }}>
      <div style={ROW}>
        <div style={{ minWidth: 0, flex: '1 1 420px' }}>
          <b>자동 설정 — 초기 설치만 된 서버를 포탈이 설정합니다</b>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 2, lineHeight: 1.6 }}>SSH root 비밀번호는 서버에 저장하지 않습니다(이 편집 화면을 닫으면 지워집니다) · 본인 OTP 는 쓰기 단계마다 새 코드. 쓰기 단계는 포탈이 만든 파일만 덮어쓰고(예외: 3단계는 패키지의 myself.conf 를 사본을 남기고 제자리에서 고칩니다), 실패하면 되돌립니다. 처음 접속하는 서버는 SSH 호스트키 승인(설정 › 장비 신뢰)이 먼저 필요할 수 있습니다.</div>
        </div>
      </div>
      {s.demo && <div className="banner warn" style={{ marginTop: 8 }}>데모 모드에서는 자동 설정을 실행하지 않습니다(실제 서버에 접속하는 작업).</div>}
      {dir.agent && !s.demo && <div className="banner" style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6 }}>법인 엣지 ‘{dir.agent}’ 가 대행합니다 — 아래 SSH 접속·Director 확인은 그 엣지에서 실행합니다. 입력한 SSH·vCenter 비밀번호는 이 요청 한 번에만 엣지로 전달하고 어디에도 저장하지 않습니다(중앙 대기열의 사본은 엣지가 가져가는 즉시 지우고, 요청을 처리하는 동안에만 중앙 메모리에 있습니다). 엣지가 {s.relayLimits?.secretPickupMs ? secText(s.relayLimits.secretPickupMs) : '정해진 시간'} 안에 가져가지 않으면 보내지 않은 것으로 끝납니다.</div>}
      <div style={GRID}>
        <label className="muted" style={FIELD}>SSH 주소(Director 서버)<input className="input" id="bareos-auto-host" style={INP} value={ssh.host} onChange={(e) => setS2('host', e.target.value.trim())} placeholder={dir.host || 'bareos.corp'} /></label>
        <label className="muted" style={FIELD}>SSH 포트<input className="input" style={INP} inputMode="numeric" value={ssh.sshPort} onChange={(e) => setS2('sshPort', e.target.value.replace(/\D/g, '').slice(0, 5))} aria-label="SSH 포트" /></label>
        <label className="muted" style={FIELD}>SSH 계정(root)<input className="input" style={INP} value={ssh.username} onChange={(e) => setS2('username', e.target.value.trim())} aria-label="SSH 계정" /></label>
        <label className="muted" style={FIELD}>root 비밀번호<input className="input" id="bareos-auto-pw" style={INP} type="password" autoComplete="new-password" value={ssh.password} onChange={(e) => setS2('password', e.target.value)} placeholder="저장하지 않습니다" /></label>
        <label className="muted" style={FIELD}>OTP(본인 · 쓰기 단계)<input className="input" id="bareos-auto-otp" style={INP} inputMode="numeric" autoComplete="one-time-code" value={ssh.otp} onChange={(e) => setS2('otp', e.target.value.replace(/\D/g, '').slice(0, 6))} /></label>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        {STEP_NAMES.map((name, i) => {
          const r = st[i + 1];
          const tone = !r ? 'gray' : r.ok === true ? 'green' : r.ok === false ? 'red' : r.ok === 'warn' ? 'amber' : 'blue';
          return (
            <div key={name} style={{ flex: '1 1 150px', minWidth: 0, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--panel)' }}>
              <div className="muted" style={{ fontSize: 11 }}>{i + 1}단계</div>
              <div style={{ fontWeight: 600, fontSize: 12.5 }}>{name}</div>
              <span className={`badge ${tone}`} style={{ fontSize: 10.5, marginTop: 4 }}>{!r ? '실행 전' : r.ok === true ? '완료' : r.ok === false ? '실패' : r.ok === 'warn' ? '확인 필요' : '진행'}</span>
            </div>
          );
        })}
      </div>

      {/* 1 사전 점검 */}
      <div style={{ marginTop: 14 }}>
        <div style={ROW}><b>1 사전 점검</b><span className="muted" style={{ fontSize: 11.5 }}>쓰기 없음 · OTP 없음 — 패키지 · 서비스 · Python · pyVmomi · VDDK · FD 플러그인 줄 · 설정 구성 · 기본 리소스</span><div style={{ flexGrow: 1 }} />
          <button type="button" className="logout-btn" style={{ padding: '7px 14px' }} disabled={!sshOk || any} onClick={runPreflight}>{busy === '1' ? '점검 중…' : '사전 점검'}</button></div>
        {st[1] && <Msg m={st[1]} />}
        {pf && (
          <div className="table-wrap" style={{ marginTop: 8, maxHeight: 300 }}>
            <STable minWidth={640}>
              <thead><tr><th>항목</th><th>결과</th><th>상세</th><th>조치</th></tr></thead>
              <tbody>
                {pf.items.map((x) => { const v = preflightView(x.status); return (
                  <tr key={x.key}><td>{x.label}</td><td data-sort={x.status}><span className={`badge ${v.cls}`}>{v.mark}</span></td><td style={{ fontSize: 12, overflowWrap: 'anywhere', whiteSpace: 'normal' }}>{x.detail || '—'}</td><td className="muted" style={{ fontSize: 12, whiteSpace: 'normal' }}>{x.hint || '—'}</td></tr>
                ); })}
              </tbody>
            </STable>
          </div>
        )}
      </div>

      {/* 2 Director 리소스 */}
      <div style={{ marginTop: 14 }}>
        <div style={ROW}><b>2 Director 리소스</b><span className="muted" style={{ fontSize: 11.5 }}>콘솔 · Profile · FileSet · JobDefs · 복원 잡 (+ Pool · Schedule) → bareos-dir -t → reload → 새 콘솔로 접속 확인 → 성공하면 이 Director 의 연결을 저장합니다(주소 = 위 SSH 주소 · 포트 = 아래 Director 포트 · 그 콘솔)</span></div>
        <div style={GRID}>
          <label className="muted" style={FIELD}>Director 포트<input className="input" style={INP} inputMode="numeric" value={d.directorPort} onChange={(e) => setDk('directorPort', e.target.value.replace(/\D/g, '').slice(0, 5))} aria-label="Director 포트" /></label>
          <label className="muted" style={FIELD}>만들 콘솔 이름<input className="input" style={INP} value={d.consoleName} onChange={(e) => setDk('consoleName', e.target.value.trim())} aria-label="만들 콘솔 이름" /></label>
          {[['restoreClient', 'clients', 'client', '복원 잡 FD'], ['restoreStorage', 'storages', 'storage', '복원 잡 스토리지'], ['restorePool', 'pools', 'pool', '복원 잡 풀']].map(([k, ck, pk, label]) => {
            const list = pick(ck, pk);
            return (
              <label key={k} className="muted" style={FIELD}>{label}
                {list.length ? (
                  <Select className="input" style={INP} value={d[k]} onChange={(e) => setDk(k, e.target.value)} aria-label={label}>
                    <option value="">선택…</option>
                    {[...new Set([...(d[k] ? [d[k]] : []), ...list])].map((n) => <option key={n} value={n}>{n}</option>)}
                  </Select>
                ) : <input className="input" style={INP} value={d[k]} onChange={(e) => setDk(k, e.target.value.trim())} aria-label={label} placeholder="사전 점검이 채웁니다" />}
              </label>
            );
          })}
        </div>
        <div style={{ ...CARDS(280), gap: 10, marginTop: 10 }}>
          <div style={{ padding: 10, borderRadius: 8, border: '1px solid var(--border)', minWidth: 0 }}>
            <label style={{ ...ROW, fontSize: 12.5 }}><input type="checkbox" checked={d.usePools} onChange={(e) => setDk('usePools', e.target.checked)} /> VMware 전용 Pool 만들기({VMWARE_POOL_FULL} · Incr)</label>
            {d.usePools && <div style={GRID}>
              <label className="muted" style={FIELD}>Full 보존(일)<input className="input" style={INP} inputMode="numeric" value={d.fullDays} onChange={(e) => setDk('fullDays', e.target.value.replace(/\D/g, '').slice(0, 4))} aria-label="Full 보존 일수" /></label>
              <label className="muted" style={FIELD}>증분 보존(일)<input className="input" style={INP} inputMode="numeric" value={d.incrDays} onChange={(e) => setDk('incrDays', e.target.value.replace(/\D/g, '').slice(0, 4))} aria-label="증분 보존 일수" /></label>
              <label className="muted" style={FIELD}>볼륨 최대(GB)<input className="input" style={INP} inputMode="numeric" value={d.maxVolumeGB} onChange={(e) => setDk('maxVolumeGB', e.target.value.replace(/\D/g, '').slice(0, 4))} aria-label="볼륨 최대 크기" /></label>
            </div>}
          </div>
          <div style={{ padding: 10, borderRadius: 8, border: '1px solid var(--border)', minWidth: 0 }}>
            <label style={{ ...ROW, fontSize: 12.5 }}><input type="checkbox" checked={d.useSchedule} onChange={(e) => setDk('useSchedule', e.target.checked)} /> 야간 Schedule 만들기({VMWARE_SCHEDULE})</label>
            {d.useSchedule && <div style={GRID}>
              <label className="muted" style={FIELD}>전체 백업 요일
                <Select className="input" sort={false} style={INP} value={d.fullDay} onChange={(e) => setDk('fullDay', e.target.value)} aria-label="전체 백업 요일">
                  {WEEKDAYS.map((w) => <option key={w} value={w}>{WEEKDAY_LABEL[w]}</option>)}
                </Select>
              </label>
              <label className="muted" style={FIELD}>시각(나머지 요일은 증분)<input className="input" style={INP} value={d.time} onChange={(e) => setDk('time', e.target.value.replace(/[^\d:]/g, '').slice(0, 5))} aria-label="백업 시각" placeholder="02:00" /></label>
            </div>}
          </div>
        </div>
        <details style={{ marginTop: 8 }}>
          <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>사전 준비 블록 보기(손으로 넣을 때 · 자동 설정이 넣는 글과 같습니다)</summary>
          <pre style={{ margin: '8px 0 0', padding: 10, maxHeight: 260, overflow: 'auto', fontSize: 11.5, lineHeight: 1.55, background: 'var(--panel)', borderRadius: 8 }}>{prep}</pre>
          <div style={{ ...ROW, marginTop: 6 }}><button type="button" className="logout-btn" style={BTN} onClick={() => copyWith(setCopyMsg)(prep)}>사전 준비 블록 복사</button></div>
          <Msg m={copyMsg} />
        </details>
        <div style={{ ...ROW, marginTop: 10 }}>
          <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={!dReady} onClick={runDirector}>{busy === '2' ? '설정 중…' : 'Director 자동 설정'}</button>
          <span className="muted" style={{ fontSize: 11.5 }}>{any ? '' : dMissing || 'root 로 접속합니다 · 비밀번호는 저장하지 않습니다'}</span>
        </div>
        {st[2] && <Msg m={st[2]} />}
      </div>

      {/* 3 FD 플러그인 */}
      <div style={{ marginTop: 14 }}>
        <div style={ROW}><b>3 FD 플러그인 켜기</b><span className="muted" style={{ fontSize: 11.5 }}>bareos-fd.d/client/myself.conf 에 Plugin Directory · Plugin Names = python3 (없는 줄만 · 다른 값이면 거부 · 쓰기 전 사본 · bareos-fd -t · 재시작)</span><div style={{ flexGrow: 1 }} />
          <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={!sshOk || !otpOk || any} onClick={runPlugin}>{busy === '3' ? '켜는 중…' : 'FD 플러그인 켜기'}</button></div>
        {!any && (!sshOk || !otpOk) && <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>{missingText([[sshOk, 'SSH 주소·비밀번호'], [otpOk, 'OTP 6자리']])}</div>}
        {st[3] && <Msg m={st[3]} />}
      </div>

      {/* 4 매핑 채움 · 저장 */}
      <div style={{ marginTop: 14 }}>
        <div style={ROW}><b>4 매핑 채움 · 저장</b><span className="muted" style={{ fontSize: 11.5 }}>이 Director 의 카탈로그(FD · SD · 풀 · 스케줄)와 vCenter 등록부 주소로 아래 매핑 표의 빈 칸만 채웁니다(쓰기 없음 — 확인한 뒤 표 아래 ‘매핑 저장’ · 5단계가 저장된 값을 씁니다)</span><div style={{ flexGrow: 1 }} />
          <button type="button" className="logout-btn" style={{ padding: '7px 14px' }} disabled={!editCount || any || !(dir.hasPassword || s.demo)} title={!editCount ? '이 Director 에 묶은 vCenter 가 없습니다' : !(dir.hasPassword || s.demo) ? '콘솔 비밀번호가 없어 Director 카탈로그를 읽을 수 없습니다 — 2단계(또는 연결 저장)를 먼저 하세요' : undefined} onClick={runFill}>{busy === '4' ? '채우는 중…' : '빈 칸 채우기'}</button></div>
        {st[4] && <Msg m={st[4]} />}
      </div>
      {/* 5 FD INI · 지문 — 저장된 매핑의 vcserver·INI 경로를 쓴다(W3) */}
      <div style={{ marginTop: 14 }}>
        <div style={ROW}><b>5 FD INI · vCenter 지문</b><span className="muted" style={{ fontSize: 11.5 }}>저장된 매핑의 INI 경로에 vCenter 자격증명 INI(bareos 소유 0600) — vCenter 비밀번호는 이 요청에서만 FD 로 전달하고 저장하지 않습니다</span></div>
        {unsaved && <div className="muted" style={{ fontSize: 11.5, marginTop: 4, color: 'var(--amber)' }}>매핑 표에 저장하지 않은 변경이 있습니다 — 이 단계는 저장된 매핑을 씁니다(먼저 저장하세요).</div>}
        <div style={GRID}>
          <label className="muted" style={FIELD}>vCenter(이 Director 매핑)
            <Select className="input" style={INP} value={f.vcenterId} onChange={(e) => setFk('vcenterId', e.target.value)} aria-label="매핑된 vCenter">
              <option value="">선택…</option>
              {rows.map((x) => <option key={x.vcenterId} value={x.vcenterId}>{s.vcenters.find((v) => v.id === x.vcenterId)?.name || x.vcenterId}</option>)}
            </Select>
          </label>
          <label className="muted" style={FIELD}>FD 서버 주소<input className="input" style={INP} value={f.fdHost} onChange={(e) => setFk('fdHost', e.target.value.trim())} placeholder={`같은 서버(${ssh.host || '—'})`} aria-label="FD 서버 주소" /></label>
          <label className="muted" style={FIELD}>vCenter 계정<input className="input" style={INP} value={f.vcuser} onChange={(e) => setFk('vcuser', e.target.value)} placeholder="backup@vsphere.local" aria-label="vCenter 계정" /></label>
          <label className="muted" style={FIELD}>vCenter 비밀번호<input className="input" style={INP} type="password" autoComplete="new-password" value={f.vcpass} onChange={(e) => setFk('vcpass', e.target.value)} placeholder="저장하지 않습니다" aria-label="vCenter 비밀번호" /></label>
          <label className="muted" style={{ ...FIELD, gridColumn: '1 / -1' }}>vCenter 인증서 SHA1 지문<input className="input" style={INP} value={f.vcthumbprint} onChange={(e) => setFk('vcthumbprint', e.target.value.trim())} placeholder="16진 40자(콜론 있어도 됨)" aria-label="vCenter 인증서 지문" /></label>
        </div>
        {site && <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>쓸 경로 ‘{site.configFile || '—'}’ · FD 가 볼 vCenter ‘{site.vcserver || '—'}’</div>}
        <div style={{ ...ROW, marginTop: 10 }}>
          <button type="button" className="logout-btn" style={{ padding: '7px 14px' }} disabled={!sshOk || !site || any} onClick={readThumb}>{busy === '4t' ? '읽는 중…' : 'FD 에서 지문 읽기'}</button>
          <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={!fReady} onClick={runFd}>{busy === '5' ? '쓰는 중…' : 'FD INI 자동 설정'}</button>
          {!any && fMissing && <span className="muted" style={{ fontSize: 11.5 }}>{fMissing}</span>}
        </div>
        {st[5] && <Msg m={st[5]} />}
      </div>

    </div>
  );
}
