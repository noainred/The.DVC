import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, canCsv, CSV_DENIED_NOTE } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import DataList from '../../components/DataList.jsx';
import BoldText from '../../components/boldText.jsx';
import { call, filesText } from './BareosCorp.jsx';
import {
  matrixCell, matrixTotals, mergeBulkRows, sameBulkJob, BULK_LABEL, bulkEligible, RESULT_TEXT, RESULT_CLS, bulkCounts, bulkSummaryText, passwordCsv, maskPw, pwPairIssue, nameIssue, profileOptions, DEFAULT_PROFILE, sshSourceText, noSshNeeded,
} from './bareosCorpText.js';

/**
 * 중앙 계정 통합(v2.845 · 설정 탭 — 전 법인 범위 관리자만). 사용자 요청: '중앙에서 bareos 백업 계정 통합관리'.
 * 매트릭스: 행 = 계정 이름 · 열 = 법인(Director) — 값은 각 법인 Director 에서 읽은 것(콘솔 조회 · 비밀번호 없음).
 * 일괄: 고른 법인마다 그 법인 쪽(엣지 대행 · 중앙 직접)이 적용 · 부분 성공을 숨기지 않는다(성공 · 실패 · 보내지 않음 · 결과 모름).
 * 생성 비밀번호는 법인마다 다른 값 — 결과 표에 한 번 · CSV 한 번(닫으면 사라진다 · 포탈은 저장하지 않는다).
 */
const PA = '/tools/bareos-backup/settings/accounts';
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' };
const BTN = { padding: '4px 10px', fontSize: 12 };
const INP = { minWidth: 0, width: '100%', boxSizing: 'border-box' };
const FIELD = { fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 };
const GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(170px, 100%), 1fr))', gap: 10, marginTop: 8, alignItems: 'end' };
const CARD = { padding: 14, marginTop: 10, minWidth: 0 };
const DEEP = { padding: 12, marginTop: 10, minWidth: 0, background: 'var(--panel-deep)' };
const WRAP = { whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 0 };
// 전 법인 조회(법인마다 엣지 대행 · 동시 4) — 서버 요청 시한(600초)까지 한 번만 기다린다(재시도하면 법인마다 Director 로그인이 되풀이된다 — v2.846 U-1)
const GET = { retries: 0, timeoutMs: 600_000 };
const CELL_CLS = { has: 'green', none: 'gray', unknown: 'amber', locked: 'blue' };

function Badge({ cls, children }) { return <span className={`badge ${cls}`} style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{children}</span>; }
function Msg({ m }) {
  if (!m) return null;
  return <div className={`banner ${m.ok === false ? 'bad' : m.ok === 'warn' ? 'warn' : 'ok'}`} role={m.ok === false ? 'alert' : 'status'} style={{ marginTop: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}><BoldText text={m.text} /></div>;
}

export default function BareosAccountsPanel({ writable = true }) {
  const [m, setM] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [q, setQ] = useState('');
  const [result, setResult] = useState(null);   // { action, account, results, at }
  const gen = useRef(0);
  const load = (refresh = false) => {
    const g = ++gen.current;
    setBusy(true);
    return fetchJson(PA, refresh ? { refresh: 1 } : {}, undefined, GET).then((r) => { if (g === gen.current) { setM(r); setErr(null); } })
      .catch((e) => { if (g === gen.current) setErr(e); }).finally(() => { if (g === gen.current) setBusy(false); });
  };
  useEffect(() => { load(false); }, []);
  const names = useMemo(() => (m?.names || []).filter((n) => !q || n.toLowerCase().includes(q.toLowerCase())), [m, q]);
  if (err && !m) return <ErrorBox error={err} />;
  if (!m) return <Loading />;
  const dirs = m.directors || [];
  const failed = dirs.filter((d) => !d.ok);
  return (
    <div style={{ minWidth: 0 }}>
      <div className="card" style={CARD}>
        <div style={ROW}>
          <div style={{ flex: '1 1 420px', minWidth: 0 }}>
            <b>WebUI 계정 통합 관리 — 전 법인 {dirs.length}곳</b>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>법인마다 Director 에서 읽은 WebUI 계정(Console)을 한 표로 봅니다. 바꾸는 작업은 법인마다 그 법인 쪽(담당 엣지 또는 중앙 직접)이 적용하고 중앙은 결과만 모읍니다. 비밀번호는 포탈에 저장하지 않고 화면 · 로그 · 감사에 남기지 않습니다.</div>
          </div>
          <button type="button" className="logout-btn" style={BTN} disabled={busy} onClick={() => load(true)}>{busy ? '읽는 중…' : '전 법인 다시 읽기'}</button>
        </div>
        {m.demo && <div className="banner warn" style={{ marginTop: 8 }}>데모 모드 — 메모리의 데모 설정입니다(장비 · 엣지에 닿지 않음).</div>}
        {err && <div className="banner bad" style={{ marginTop: 8 }}>다시 읽지 못했습니다 — {String(err.message || err).slice(0, 200)}(아래는 마지막으로 받은 값)</div>}
        {failed.length > 0 && <div className="banner warn" style={{ marginTop: 8 }}>{failed.length}곳은 계정 목록을 읽지 못했습니다(‘확인 불가’) — {failed.map((d) => `${d.name}: ${String(d.error || '').slice(0, 80)}`).join(' · ')}</div>}
        <div style={{ ...ROW, marginTop: 10 }}>
          <label className="muted" style={{ ...FIELD, flex: '0 1 260px' }}>계정 이름 찾기<input className="input" style={INP} value={q} onChange={(e) => setQ(e.target.value)} aria-label="계정 이름 찾기" /></label>
          <span className="muted" style={{ fontSize: 12 }}>‘잠김’ = 포탈 전용 콘솔 · 패키지 콘솔(바꾸지 않음). 사람이 만든 파일인지는 실행 때 서버가 확인합니다(그 법인은 실패로 남고 바뀌지 않습니다).</span>
        </div>
        <div style={{ overflowX: 'auto', marginTop: 10 }}>
          <STable className="table" limit={500} minWidth={Math.max(640, 220 + dirs.length * 130)}>
            <thead><tr><th data-pin>계정 이름</th>{dirs.map((d) => <th key={d.id} style={WRAP}>{d.name}{d.agent ? <div className="muted" style={{ fontSize: 10.5 }}>엣지 {d.agent}</div> : <div className="muted" style={{ fontSize: 10.5 }}>중앙 직접</div>}</th>)}<th data-sort="num">합계</th></tr></thead>
            <tbody>{names.map((n) => {
              const t = matrixTotals(dirs, n);
              return (
                <tr key={n}>
                  <td data-pin><b>{n}</b></td>
                  {dirs.map((d) => { const c = matrixCell(d, n); return <td key={d.id} data-sort={c.kind}><Badge cls={CELL_CLS[c.kind]}>{c.text}</Badge></td>; })}
                  <td data-sort={t.has}>{t.text}</td>
                </tr>
              );
            })}</tbody>
          </STable>
        </div>
        {!names.length && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{q ? '찾는 이름의 계정이 없습니다.' : 'WebUI 계정이 없습니다(포탈 전용 · 패키지 콘솔 제외).'}</div>}
        <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>정렬은 제목 클릭. ‘확인 불가’ 는 그 법인의 조회 실패이고 ‘없음’ 이 아닙니다.</div>
      </div>
      <Msg m={msg} />
      {!result && <BulkForm dirs={dirs} m={m} writable={writable} say={setMsg} onDone={(r) => { setResult(r); load(true); }} />}
      {result && <BulkResult r={result} say={setMsg} onClose={() => setResult(null)} onRetry={(ids) => setResult((x) => ({ ...x, retry: ids }))} />}
      {/* v2.846 U-6: 다시 시도 결과는 앞 결과에 합친다(첫 실행의 성공 법인 비밀번호를 지우지 않는다) */}
      {result?.retry && <BulkForm dirs={dirs} m={m} writable={writable} say={setMsg} preset={{ action: result.action, name: result.account, profile: result.profile, ids: result.retry }} onDone={(r) => { setResult((prev) => (sameBulkJob(prev, r) ? { ...r, results: mergeBulkRows(prev?.results || [], r.results) } : r)); load(true); }} />}
    </div>
  );
}

function BulkForm({ dirs, m, writable, say, onDone, preset = null }) {
  const profiles = useMemo(() => {
    const s = new Set(); for (const d of dirs) for (const p of d.profiles || []) s.add(p);
    return profileOptions([...s].map((name) => ({ name })));
  }, [dirs]);
  const [f, setF] = useState({ action: preset?.action || 'console.add', name: preset?.name || '', profile: preset?.profile || (profiles.some((p) => p.value === DEFAULT_PROFILE) ? DEFAULT_PROFILE : profiles[0]?.value || ''), mode: 'generate', pw: '', pw2: '', otp: '' });
  const [pick, setPick] = useState(() => Object.fromEntries((preset?.ids || []).map((id) => [id, true])));
  const [ssh, setSsh] = useState({});   // directorId → { host, sshPort, username, password } (입력 출처 법인만 · 실행 뒤 비움)
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const elig = bulkEligible(dirs, f.action, f.name);
  const okIds = new Set(elig.filter((e) => e.ok).map((e) => e.id));
  const chosen = dirs.filter((d) => pick[d.id] && okIds.has(d.id));
  const needPw = f.action !== 'console.delete';
  const inputDirs = chosen.filter((d) => !noSshNeeded(d.ssh));
  const noSsh = inputDirs.filter((d) => !ssh[d.id]?.password);
  const issue = nameIssue(f.name, '계정 이름') || (f.action === 'console.add' && !f.profile ? '권한(Profile)을 고르세요.' : '') || (!chosen.length ? '대상 법인을 하나 이상 고르세요.' : '')
    || (needPw && f.mode === 'input' ? pwPairIssue(f.pw, f.pw2) : '') || (m.otpRequired && !/^\d{6}$/.test(f.otp) ? '본인 OTP 6자리를 입력하세요.' : '');
  const pickAll = (fn) => setPick(Object.fromEntries(dirs.filter((d) => okIds.has(d.id) && fn(d)).map((d) => [d.id, true])));
  const go = async () => {
    setBusy(true); say(null);
    try {
      const body = {
        action: f.action, name: f.name, profile: f.profile, directorIds: chosen.map((d) => d.id), otp: f.otp,
        ...(needPw ? (f.mode === 'generate' ? { generate: true } : { accountPassword: f.pw }) : {}),
        ssh: Object.fromEntries(inputDirs.filter((d) => ssh[d.id]?.password).map((d) => [d.id, { host: ssh[d.id].host || '', sshPort: ssh[d.id].sshPort || '22', username: ssh[d.id].username || 'root', password: ssh[d.id].password }])),
      };
      const r = await call(`${PA}/bulk`, body, { timeoutMs: 600_000 });
      onDone({ action: f.action, account: f.name, profile: f.profile, results: r.results, at: Date.now(), passwordMode: r.passwordMode });
    } catch (e) { say({ ok: false, text: `실패: ${e.message}` }); } finally {
      setBusy(false); setF((x) => ({ ...x, pw: '', pw2: '', otp: '' }));
      setSsh((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { ...v, password: '' }])));   // 사용자 결정 '그때마다 SSH 비밀번호 입력'
    }
  };
  return (
    <div className="card" style={CARD}>
      <b>{preset ? '다시 시도 — ' : ''}일괄 작업</b>
      <div style={{ ...ROW, marginTop: 8 }} role="tablist" aria-label="일괄 작업 종류">
        {/* v2.847 U2-4: 다시 시도는 같은 작업 · 같은 계정만(이름을 바꾸면 앞 결과의 생성 비밀번호가 새 이름으로 CSV 에 실렸다) */}
        {Object.entries(BULK_LABEL).map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={f.action === k} disabled={!!preset && k !== f.action} className={`tab${f.action === k ? ' active' : ''}`} onClick={() => { set('action', k); setPick({}); }}>{l}</button>)}
      </div>
      <div style={GRID}>
        <label className="muted" style={FIELD}>계정 이름<input className="input" style={INP} list="bareos-acc-names" value={f.name} readOnly={!!preset} disabled={!!preset} onChange={(e) => { set('name', e.target.value.trim()); setPick({}); }} aria-label="계정 이름" /></label>
        <DataList id="bareos-acc-names">{(m.names || []).map((n) => <option key={n} value={n} />)}</DataList>
        {f.action === 'console.add' && <label className="muted" style={FIELD}>권한 Profile<Select className="input" style={INP} value={f.profile} disabled={!!preset} onChange={(e) => { const v = e.target.value; set('profile', v); }} aria-label="권한 Profile">{(profiles).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></label>}
        {needPw && <label className="muted" style={FIELD}>비밀번호<Select className="input" style={INP} sort={false} value={f.mode} onChange={(e) => { const v = e.target.value; set('mode', v); }} aria-label="비밀번호 방식">{([{ value: 'generate', label: '법인마다 다른 생성 비밀번호(결과에서 한 번)' }, { value: 'input', label: '모든 법인 같은 비밀번호(2번 입력)' }]).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></label>}
        {needPw && f.mode === 'input' && <label className="muted" style={FIELD}>새 비밀번호(12자 이상)<input className="input" style={INP} type="password" autoComplete="new-password" value={f.pw} onChange={(e) => set('pw', e.target.value)} aria-label="새 비밀번호" /></label>}
        {needPw && f.mode === 'input' && <label className="muted" style={FIELD}>한 번 더<input className="input" style={INP} type="password" autoComplete="new-password" value={f.pw2} onChange={(e) => set('pw2', e.target.value)} aria-label="새 비밀번호 확인" /></label>}
        {m.otpRequired && <label className="muted" style={FIELD}>본인 OTP(6자리 · 한 번)<input className="input" style={INP} inputMode="numeric" autoComplete="one-time-code" value={f.otp} onChange={(e) => set('otp', e.target.value.replace(/\D/g, '').slice(0, 6))} aria-label="OTP" /></label>}
      </div>
      <div style={{ ...ROW, marginTop: 10 }}>
        <span className="muted" style={{ fontSize: 12 }}>대상 법인 — {chosen.length}곳 고름</span>
        <button type="button" className="logout-btn" style={BTN} disabled={!f.name} onClick={() => pickAll(() => true)}>{f.action === 'console.add' ? '계정 없는 법인 모두' : '계정 있는 법인 모두'}</button>
        <button type="button" className="logout-btn" style={BTN} onClick={() => setPick({})}>비우기</button>
      </div>
      <div style={{ ...ROW, marginTop: 6 }}>
        {dirs.map((d) => {
          const e = elig.find((x) => x.id === d.id);
          return (
            <label key={d.id} className="badge gray" style={{ fontSize: 12, display: 'inline-flex', gap: 6, alignItems: 'center', opacity: e.ok ? 1 : 0.55 }} title={e.why || undefined}>
              <input type="checkbox" disabled={!e.ok} checked={!!pick[d.id] && e.ok} onChange={(ev) => setPick((p) => ({ ...p, [d.id]: ev.target.checked }))} aria-label={`${d.name} 고르기`} />
              {d.name}{e.why ? ` — ${e.why}` : ''}
            </label>
          );
        })}
      </div>
      {inputDirs.length > 0 && (
        <div className="card" style={DEEP}>
          <b>SSH 비밀번호가 필요한 법인 — {inputDirs.length}곳</b>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>배포 등록부에 그 서버의 SSH 계정이 없는 법인입니다. 비밀번호를 비워 두면 그 법인은 ‘보내지 않음’ 으로 결과에만 남습니다(저장하지 않습니다 — 실행 뒤 비움).</div>
          {inputDirs.map((d) => {
            const v = ssh[d.id] || { host: d.ssh?.host || '', sshPort: String(d.ssh?.port || 22), username: d.ssh?.username || 'root', password: '' };
            const up = (k, val) => setSsh((s) => ({ ...s, [d.id]: { ...v, [k]: val } }));
            return (
              <div key={d.id} style={GRID}>
                <div style={{ ...FIELD, justifyContent: 'center' }}><b>{d.name}</b><span className="muted">{sshSourceText(d.ssh)}</span></div>
                <label className="muted" style={FIELD}>SSH 주소<input className="input" style={INP} value={v.host} onChange={(e) => up('host', e.target.value.trim())} aria-label={`${d.name} SSH 주소`} /></label>
                <label className="muted" style={FIELD}>계정<input className="input" style={INP} value={v.username} onChange={(e) => up('username', e.target.value.trim())} aria-label={`${d.name} SSH 계정`} /></label>
                <label className="muted" style={FIELD}>SSH 비밀번호<input className="input" style={INP} type="password" autoComplete="off" value={v.password} onChange={(e) => up('password', e.target.value)} aria-label={`${d.name} SSH 비밀번호`} /></label>
              </div>
            );
          })}
        </div>
      )}
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>법인마다 bareos-dir.d/console/{f.name || '…'}.conf(포탈 표지 파일)를 {f.action === 'console.delete' ? '지우고' : '쓰고'} bareos-dir -t → reload{f.action !== 'console.delete' ? ' → 새 비밀번호로 접속 확인' : ''}. 실패한 법인은 그 법인만 되돌리고 다른 법인에는 영향이 없습니다. 감사 로그에는 법인별 결과만(비밀번호 없음).</div>
      <div style={{ ...ROW, marginTop: 10 }}>
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '6px 14px' }} disabled={!writable || !!issue || busy} onClick={go}>{busy ? '보내는 중…' : `${chosen.length}개 법인에 ${BULK_LABEL[f.action].replace('일괄 ', '')}`}</button>
        <span className="muted" style={{ fontSize: 12 }}>{issue ? `필요: ${issue}` : noSsh.length ? `SSH 비밀번호가 없는 ${noSsh.length}곳은 보내지 않습니다.` : ''}</span>
      </div>
    </div>
  );
}

function BulkResult({ r, say, onClose, onRetry }) {
  const [shown, setShown] = useState({});
  const [csvDone, setCsvDone] = useState(false);
  const [rows, setRows] = useState(r.results);
  useEffect(() => { setRows(r.results); setShown({}); setCsvDone(false); }, [r]);
  const c = bulkCounts(rows);
  const hasPw = rows.some((x) => x.generatedPassword);
  const download = () => {
    const csv = passwordCsv(rows, r.account);
    if (!csv) return;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `bareos-webui-${r.account}-passwords.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setCsvDone(true);
  };
  const close = () => { setRows((xs) => xs.map((x) => ({ ...x, generatedPassword: undefined }))); onClose(); };
  const failedIds = rows.filter((x) => x.status === 'failed').map((x) => x.directorId);
  const skippedIds = rows.filter((x) => x.status === 'skipped').map((x) => x.directorId);
  return (
    <div className="card" style={CARD}>
      <div style={ROW}>
        <b style={{ flex: 1 }}>{BULK_LABEL[r.action]} 결과 — ‘{r.account}’</b>
        <Badge cls="green">성공 {c.done}</Badge><Badge cls="red">실패 {c.failed}</Badge><Badge cls="gray">보내지 않음 {c.skipped}</Badge>{c.unknown > 0 && <Badge cls="amber">결과 모름 {c.unknown}</Badge>}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}><BoldText text={`${bulkSummaryText(rows)} — 성공한 법인은 이미 적용됐고 다시 보내지 않습니다. 실패한 법인은 그 법인만 되돌렸습니다. 보내지 않은 법인은 서버에 아무것도 하지 않았습니다.${c.unknown ? ' **결과 모름**은 법인 엣지가 시한 안에 회신하지 않은 것입니다(적용됐을 수 있습니다 — 매트릭스를 다시 읽어 확인하세요).' : ''}`} /></div>
      <div style={{ overflowX: 'auto', marginTop: 10 }}>
        <STable className="table" limit={200} minWidth={860}>
          <thead><tr><th>법인</th><th>결과</th><th>상세</th>{hasPw && <th data-nosort>생성 비밀번호 — 한 번만 표시</th>}</tr></thead>
          <tbody>{rows.map((x) => (
            <tr key={x.directorId}>
              <td><b>{x.name}</b>{x.relay ? <div className="muted" style={{ fontSize: 11 }}>엣지 {x.relay}</div> : null}</td>
              <td data-sort={x.status}><Badge cls={RESULT_CLS[x.status] || 'gray'}>{RESULT_TEXT[x.status] || x.status}</Badge></td>
              <td style={WRAP}>{x.ok ? filesText(x) : x.reason}</td>
              {hasPw && <td>{x.generatedPassword ? (<>{x.maybeApplied && <div className="muted" style={{ fontSize: 11 }}>결과 모름 — 적용됐을 수 있습니다(이 비밀번호로 로그인해 확인)</div>}
                <div style={ROW}>
                  <code>{shown[x.directorId] ? x.generatedPassword : maskPw(x.generatedPassword)}</code>
                  <button type="button" className="logout-btn" style={BTN} onClick={() => setShown((s) => ({ ...s, [x.directorId]: !s[x.directorId] }))}>{shown[x.directorId] ? '가리기' : '보기'}</button>
                  <button type="button" className="logout-btn" style={BTN} onClick={() => { try { navigator.clipboard.writeText(x.generatedPassword).then(() => say({ ok: true, text: `${x.name} 비밀번호를 복사했습니다.` })); } catch { say({ ok: false, text: '복사하지 못했습니다.' }); } }}>복사</button>
                </div></>
              ) : '—'}</td>}
            </tr>
          ))}</tbody>
        </STable>
      </div>
      <div style={{ ...ROW, marginTop: 10 }}>
        {failedIds.length > 0 && <button type="button" className="logout-btn" style={BTN} onClick={() => onRetry(failedIds)}>실패한 법인만 다시 시도({failedIds.length}곳)</button>}
        {skippedIds.length > 0 && <button type="button" className="logout-btn" style={BTN} onClick={() => onRetry(skippedIds)}>보내지 않은 법인 다시 시도({skippedIds.length}곳)</button>}
        {/* CSV 내려받기는 다른 CSV 버튼과 같이 data.csv 권한(canCsv)으로 잠근다(v2.643 — 보기 · 복사는 그대로) */}
        {hasPw && <button type="button" className="logout-btn" style={BTN} disabled={csvDone || !canCsv()} title={!canCsv() ? CSV_DENIED_NOTE : undefined} onClick={download}>{csvDone ? 'CSV 내려받음(1회)' : '생성 비밀번호 CSV 내려받기 — 1회'}</button>}
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '6px 14px' }} onClick={close}>닫기{hasPw ? '(비밀번호 지움)' : ''}</button>
      </div>
      {hasPw && <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>이 창을 닫으면 비밀번호 보기 · 복사 · 내려받기가 모두 불가능합니다. 포탈은 저장하지 않았습니다. 다시 시도는 OTP 를 다시 확인합니다.</div>}
    </div>
  );
}
