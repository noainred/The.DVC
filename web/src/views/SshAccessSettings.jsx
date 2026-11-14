/**
 * SshAccessSettings.jsx — 설정 › 보안 › SSH 공용 접속(v3.9.0 · 설계 docs/design/ssh-access · 시안 Ssh · SshKeys · SshPick · SshUse · SshSec).
 *
 * 7b SSH 키 저장소(키 + 법인 공통 계정)와 OS 계정 등록부(서버) 위에 얹은 화면이다 — 새 저장소가 아니다.
 *  · 탭: 법인 · 서버 / 키 폴더 / 쓰는 기능 / 키 보안. 판정(이 서버에 쓸 수 있는 키 · 키 점검 등급)은 서버가 한다 — 화면은 그린다.
 *  · 조회는 설정 소유자 등급, 바꾸는 것은 본인 OTP 까지(서버가 다시 막는다). 개인키 · passphrase · 비밀번호는 보내기만 하고 다시 받지 않는다(보낸 뒤 비운다).
 *  · ⚠ postJson 은 409 를, putJson · delJson 은 400 · 409 를 던지지 않는다(api.js) — 쓰기 결과는 전부 `must()` 로 `ok:false` 를 오류로 바꾼다
 *    (5축 점검 E-H1: 키 고르기 실패 · 폴더 충돌 · 승인 거절을 성공으로 그리던 결함).
 *  · 무거운 API 는 폴링하지 않는다(마운트 1회 + 버튼). 늦게 온 이전 응답은 버린다(gen). 다시 읽기가 실패하면 이전 화면을 두고 오류를 띠로 보인다.
 *  · v3.10.0(2단계 · 시안 ③ SshKey · ⑤ SshSec): 키 로그인 설정 창 · 승인 대기(두 사람 승인) · 보호 장치 · 서버에서 키 거두기 · 키 교체 / 삭제.
 *    - 쓰기는 202 `pending`(다른 설정 소유자의 승인 대기)으로 올 수 있다 — 성공 문구 대신 대기 문구를 보인다(`pendingText`).
 *    - 키 작업(키 로그인 설정 · 거두기)의 진행만 2초마다 묻는다 — **작업이 도는 동안에만**(`useKeyJob` — 끝나면 · 화면을 떠나면 멈춘다).
 *    - 승인은 화면에서 본 요청 지문(digest)을 돌려보낸다. 요청한 본인은 승인 단추가 잠긴다(서버도 403 으로 막는다).
 *    - 1회 비밀번호 · OTP 는 보낸 뒤 성공 · 실패와 무관하게 비운다. 서버 쪽 제한은 보호 장치 설정이다(요청마다 고르지 않는다 — 창은 읽기 전용으로 보인다).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, sendJson, getCurrentUser } from '../api.js';
import { ErrorBox } from '../components/ui.jsx';
import { STable } from '../components/STable.jsx';
import Select from '../components/Select.jsx';
import BoldText from '../components/boldText.jsx';
import { toneVar } from './tools/toneVar.js';
import { unitText } from './unitText.js';
import {
  LEVEL_TEXT, LEVEL_TONE, KEY_MODE_TEXT, ISSUE_TEXT, INBOX_CODE_TEXT, EVENT_TEXT, USE_CODE_TEXT, UNUSUAL_TEXT,
  shortFp, dateTime, ageDays, featuresText, folderTree, keysInFolder, inboxInFolder, sortedCheck, suggestKeyName, serverStatus, auditTime, COLLECT_FEATURES,
  APPROVAL_STATUS_TEXT, APPROVAL_STATUS_TONE, GUARD_KEYS, GUARD_TEXT, splitApprovals, approvalRemaining, isOwnRequest, pendingText, pendingTone,
  folderText, keyOptionLabel, guardDiff, guardSaveText, approvalDetail, approvalOutcome, rotateDoneText, eventDetail, restrictLineText,
  keyLoginRow, keyRevokeRow, tallyText, keyLoginSelectable, keyLoginKeyOptions, corpKeyOptions, rotateTargetOptions, defaultKeyChoice, savedAuthHints, pendingKeyRequest,
  HIDDEN_EVENT_KINDS, guardFailText, rotatePartialText, recordFailedText, stopDoneText, jobHeadText, jobLostText, revokeStartText, revokeOnceWarn,
} from './sshAccessText.js';
import './sshAccess.css';

/**
 * 오류 글자 — 서버 reason 그대로. 두 사람 승인이 켜져 있는데 승인할 사람이 없어 요청을 만들지 않은 경우(409 no-approver)는
 * 서버 사유가 ‘보호 장치’ 를 가리키므로 그 스위치가 어디 있는지만 덧붙인다.
 */
const errText = (e) => {
  const base = e?.body?.reason || e?.message || String(e);
  return e?.body?.code === 'no-approver' ? `${base} (보호 장치는 키 보안 탭에 있습니다.)` : base;
};
/** 쓰기 응답 — ok:false(400 · 409 를 던지지 않는 api.js 경로)를 오류로 바꾼다. */
function must(r) {
  if (r && r.ok === false) { const e = new Error(r.reason || r.code || '실패했습니다'); e.body = r; throw e; }
  return r;
}
const TABS = [['servers', '법인 · 서버'], ['folders', '키 폴더'], ['features', '쓰는 기능'], ['security', '키 보안']];

function useLoad(path) {
  const [st, setSt] = useState({ loading: true, resp: null, err: null });
  const gen = useRef(0);
  const load = async () => {
    if (!path) return;
    const g = ++gen.current;
    setSt((p) => ({ ...p, loading: true, err: null }));
    // 다시 읽기가 실패해도 이전 자료는 둔다(동작 뒤 재조회 실패로 화면 전체가 오류 상자로 바뀌지 않게) — 오류는 따로 보인다.
    try { const r = await fetchJson(path, {}, undefined, { timeoutMs: 60_000 }); if (g === gen.current) setSt({ loading: false, resp: r, err: null }); }
    catch (e) { if (g === gen.current) setSt((p) => ({ loading: false, resp: p.resp, err: e })); }
  };
  useEffect(() => { load(); }, [path]);   // eslint-disable-line react-hooks/exhaustive-deps -- load 는 path 만 본다(gen 으로 늦은 응답 버림)
  return [st, load];
}
const Chip = ({ tone = 'muted', children, title }) => <span className="ssa-chip" style={{ color: toneVar(tone), borderColor: 'currentColor' }} title={title}>{children}</span>;
const Otp = ({ value, onChange }) => (
  <label className="ssa-otp">본인 OTP <input className="input" inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value)} maxLength={8} autoComplete="one-time-code" /></label>
);
/**
 * 쓸 수 있는 기능 고르기 — 렌더 밖 컴포넌트(안에서 정의하면 누를 때마다 다시 마운트돼 포커스를 잃는다 · E-L1).
 * allowAll: ‘제한 없음(예전 방식)’ 칸을 보인다(값 null). 예전 키를 편집 폼에서 저장만 해도 기능이 비는 사고를 막는다(E-H3).
 */
function FeaturePicker({ catalog, value, onChange, allowAll = false }) {
  const all = value == null;
  const list = Array.isArray(value) ? value : [];
  return (
    <div className="ssa-feats" role="group" aria-label="쓸 수 있는 기능">
      {allowAll && <label><input type="checkbox" checked={all} onChange={() => onChange(all ? [] : null)} /> 제한 없음(예전 방식 — 모든 기능)</label>}
      {(catalog || []).map((f) => (
        <label key={f.id}><input type="checkbox" disabled={all} checked={all || list.includes(f.id)} onChange={() => onChange(list.includes(f.id) ? list.filter((x) => x !== f.id) : [...list, f.id])} /> {f.label}{f.ready === false ? ' (다음 단계)' : ''}</label>
      ))}
    </div>
  );
}
const featuresChosen = (v) => v == null || (Array.isArray(v) && v.length > 0);

const JOB_POLL_MS = 2000;
const JOB_POLL_MAX_FAILS = 5;
/**
 * 키 작업(키 로그인 설정 · 키 거두기) 진행 — **작업이 도는 동안에만** 2초마다 묻는다. 끝나면 멈추고, 화면을 떠나면 멈추고, 늦게 온 이전 응답은 버린다(gen).
 * 작업을 못 찾거나(404 — 끝난 지 오래 · 포탈 재시작) 연달아 못 물으면 멈추고 그 사실을 보인다(끝나지 않는 폴링 금지 — 작업 자체는 서버에서 계속된다).
 * onDone(job, { wasRunning }) 은 작업이 끝난 것을 처음 본 때 한 번 부른다(ref — 부모가 다시 그려져도 폴링을 다시 시작하지 않는다).
 * wasRunning = 이 화면이 그 작업이 도는 것을 봤거나 직접 시작했다 — 이미 끝난 작업에 다시 붙은 것(탭을 다시 엶 · v.jobs)이면 false(화면을 또 다시 읽지 않게).
 */
function useKeyJob(onDone) {
  const [st, setSt] = useState({ id: '', job: null, skipped: [], err: null, stopped: false });
  const gen = useRef(0);
  const timer = useRef(null);
  const fails = useRef(0);
  const sawRunning = useRef(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => () => { gen.current += 1; clearTimeout(timer.current); }, []);
  const ask = useCallback(async (id, g) => {
    try {
      const r = await fetchJson(`/settings/ssh-access/jobs/${encodeURIComponent(id)}`, {}, undefined, { timeoutMs: 15_000, retries: 0 });
      if (g !== gen.current) return;
      fails.current = 0;
      setSt((p) => ({ ...p, job: r.job || null, err: null }));
      if (r.job?.running) { sawRunning.current = true; timer.current = setTimeout(() => ask(id, g), JOB_POLL_MS); }
      else doneRef.current?.(r.job || null, { wasRunning: sawRunning.current });
    } catch (e) {
      if (g !== gen.current) return;
      fails.current += 1;
      const stop = e?.status === 404 || e?.status === 403 || fails.current >= JOB_POLL_MAX_FAILS;
      setSt((p) => ({ ...p, err: e, stopped: stop }));
      if (!stop) timer.current = setTimeout(() => ask(id, g), JOB_POLL_MS);
    }
  }, []);
  /** own = 이 화면이 방금 시작한 작업(끝난 것을 처음 봐도 wasRunning) · false = 이미 있는 작업에 다시 붙음. */
  const start = useCallback((id, skipped = [], { own = true } = {}) => {
    const g = ++gen.current; clearTimeout(timer.current); fails.current = 0; sawRunning.current = !!own;
    setSt({ id, job: null, skipped: Array.isArray(skipped) ? skipped : [], err: null, stopped: false });
    ask(id, g);
  }, [ask]);
  const id = st.id;
  const resume = useCallback(() => {
    if (!id) return;
    const g = ++gen.current; clearTimeout(timer.current); fails.current = 0;
    setSt((p) => ({ ...p, err: null, stopped: false }));
    ask(id, g);
  }, [ask, id]);
  const clear = useCallback(() => { gen.current += 1; clearTimeout(timer.current); setSt({ id: '', job: null, skipped: [], err: null, stopped: false }); }, []);
  // 진행 중 = 작업을 시작했고, 아직 첫 답을 못 받았거나 서버가 ‘도는 중’ 이라고 한 동안(더 묻지 못하게 된 때는 진행 중으로 붙잡지 않는다).
  const running = !!st.id && !st.stopped && (!st.job || st.job.running === true);
  return { ...st, running, start, resume, clear };
}

/**
 * 키 작업 결과 — 서버마다 한 줄(키 로그인 설정 · 키 거두기 공용). 글자 · 톤은 sshAccessText(서버 ok · code 그대로 — 화면이 성공을 다시 판정하지 않는다).
 * 도는 동안 ‘멈추기’(OTP 없음 — 줄이는 방향) — 지금 처리 중인 서버는 끝까지 하고(줄 넣기 · 확인 · 되돌리기를 끊지 않는다) 남은 서버는 하지 않는다.
 * 호출부는 key={kj.id} 로 그린다(작업이 바뀌면 멈추기 문구가 남지 않게).
 */
function KeyJobResult({ kj, kind }) {
  const [cx, setCx] = useState({ busy: false, text: '', tone: 'muted' });
  if (!kj.id) return null;
  const job = kj.job;
  const meta = job?.meta || {};
  const toRow = kind === 'key-revoke' ? keyRevokeRow : (r) => keyLoginRow(r, meta);
  const skipped = (kj.skipped.length ? kj.skipped : meta.skipped) || [];
  const rows = [...(job?.results || []), ...skipped].map((r) => ({ r, x: toRow(r) }));
  const unreached = kind === 'key-revoke' && rows.some(({ x }) => x.tone === 'bad');
  const canCancel = !!job && job.running === true && !job.cancelled && !kj.stopped;
  const cancel = async () => {
    setCx({ busy: true, text: '', tone: 'muted' });
    try {
      must(await postJson(`/settings/ssh-access/jobs/${encodeURIComponent(kj.id)}/cancel`, {}));
      setCx({ busy: false, text: '멈추기를 요청했습니다 — 지금 처리 중인 서버는 끝까지 하고(줄 넣기 · 확인 · 되돌리기를 끊지 않습니다), 남은 서버는 하지 않고 ‘멈춤’ 으로 적습니다.', tone: 'warn' });
    } catch (e) { setCx({ busy: false, text: `멈추지 못했습니다 — ${errText(e)}`, tone: 'bad' }); }
  };
  const tally = !job || job.running ? '' : (tallyText(rows.map(({ x }) => x.label)) || '결과 없음');
  return (
    <div className="ssa-job">
      <div className="ssa-acts">
        <p className="ssa-note" role="status">
          {jobHeadText(job, { stopped: kj.stopped })}{tally ? ` — ${tally}` : ''}
          {meta.keyName ? ` · 키 ${meta.keyName}` : ''}{meta.replaceKeyName ? ` · 교체 — 확인되면 옛 키 ${meta.replaceKeyName} 줄도 지우기(지운 결과는 서버마다)` : ''}
          {job?.by ? ` · 시작 ${job.by}` : ''}
        </p>
        {canCancel && <button className="btn btn-sm danger" type="button" disabled={cx.busy} onClick={cancel} title="지금 처리 중인 서버는 끝까지 하고 남은 서버는 하지 않습니다(본인 OTP 없이 — 줄이는 방향).">{cx.busy ? '멈추는 중…' : '멈추기'}</button>}
      </div>
      {cx.text && <p className="ssa-note" role="status" style={{ color: toneVar(cx.tone) }}>{cx.text}</p>}
      {kj.err && (
        <p className="ssa-note" style={{ color: toneVar('bad') }}>
          {kj.stopped ? `${jobLostText(kj.err?.status, kj.err?.body?.reason || kj.err?.message, job)} ` : `진행을 묻지 못했습니다 — 다시 묻는 중(${errText(kj.err)}).`}
          {kj.stopped && kj.err?.status !== 404 && <button className="btn btn-sm" type="button" onClick={kj.resume}>진행 다시 묻기</button>}
        </p>
      )}
      <STable minWidth={560} className="ssa-t ssa-jobt">
        <thead><tr><th>결과</th><th>서버</th><th>내용</th></tr></thead>
        <tbody>
          {rows.map(({ r, x }, i) => (
            <tr key={`${r?.id || 'row'}-${i}`}>
              <td data-sort={x.label}><Chip tone={x.tone}>{x.label}</Chip>{x.rollback === 'done' && <Chip>되돌림</Chip>}{x.rollback === 'failed' && <Chip tone="bad">되돌리지 못함</Chip>}</td>
              <td data-sort={r?.name || ''}><b>{r?.name || r?.id || '—'}</b></td>
              <td>{x.parts.join(' · ') || '—'}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={3} className="ssa-sub">{kj.stopped ? '결과를 받지 못했습니다.' : job ? '아직 끝난 서버가 없습니다.' : '진행을 묻는 중입니다.'}</td></tr>}
        </tbody>
      </STable>
      {unreached && meta.keyId && <p className="ssa-note">못 닿았거나 · 결과를 모르거나 · 멈춤 · 상한으로 빠진 서버는 그 키 줄이 남아 있을 수 있습니다 — 서버에서 직접 확인해 지우세요(그 계정의 ~/.ssh/authorized_keys 에서 표식 ‘portal-ssh:{meta.keyId}’ 가 붙은 줄).</p>}
      {job && !job.running && <p className="ssa-note">작업이 끝나면 키 보안 › 키 변경 기록에 요약(대수 · 실패한 서버 일부)이 남습니다 — 포탈이 도중에 다시 시작하면 남지 않습니다.</p>}
    </div>
  );
}

/**
 * 키 로그인 설정 작업 — 창을 닫거나 화면을 다시 열어도 진행 · 결과를 이어 본다(점검 E-2 — 서버 v.jobs.install: 진행 중이거나 끝난 지 1시간 안 · 포탈 재시작 전까지).
 * 이미 끝난 작업에 다시 붙으면 한 번만 묻는다. 도는 것을 보다가 끝나면 서버 표를 다시 읽는다.
 */
function InstallJobPanel({ jobRef, reload }) {
  const kj = useKeyJob((_job, { wasRunning }) => { if (wasRunning) reload(); });
  const jobId = jobRef?.id || '';
  useEffect(() => { if (jobId && jobId !== kj.id && !kj.running) kj.start(jobId, [], { own: false }); }, [jobId]);   // eslint-disable-line react-hooks/exhaustive-deps -- 서버가 알려 준 작업 id 가 바뀔 때만 다시 붙는다
  if (!kj.id) return null;
  return (
    <section className="ssa-sec">
      <h4>키 로그인 설정 작업 — {kj.running ? '진행 중' : '최근 결과'}</h4>
      <KeyJobResult key={kj.id} kj={kj} kind="key-login" />
    </section>
  );
}

export default function SshAccessSettings() {
  const [st, load] = useLoad('/settings/ssh-access');
  const [tab, setTab] = useState('servers');
  const [msg, setMsg] = useState({ text: '', tone: 'muted' });
  const v = st.resp;
  const say = (text, tone = 'muted') => setMsg({ text, tone });
  // 내 계정 이름 — 내가 낸 승인 요청의 ‘승인’ 단추를 잠그는 데만 쓴다(판정은 서버 — 모르면 잠그지 않고 서버의 403 사유를 보인다).
  const me = getCurrentUser()?.username || '';
  const corpName = useMemo(() => { const m = new Map((v?.corps || []).map((c) => [c.id, c.name || c.id])); return (id) => (id ? (m.get(id) || id) : '미귀속'); }, [v]);
  if (st.err && !v) return <div className="ssa"><ErrorBox error={st.err} /></div>;
  if (!v) return <div className="ssa"><p className="ssa-note">읽는 중…</p></div>;
  const keyCount = (v.keys || []).filter((k) => k.status === 'active').length;
  const keyPending = (v.keys || []).filter((k) => k.status === 'pending').length;
  // 승인을 기다리는 요청 수 — 탭 이름에 붙인다(승인 기록을 못 읽었으면 세지 않는다 — 키 보안 탭이 그 사실을 띠로 보인다).
  const apprPending = v.approvalsUnreadable ? 0 : splitApprovals(v.approvals).pending.length;
  const srvKey =(v.servers || []).filter((s) => s.keyMode === 'pinned' || s.keyMode === 'corp-default').length;
  const srvPw = (v.servers || []).filter((s) => s.keyMode === 'password').length;
  const sum = v.check?.summary || {};
  const checkTone = sum.bad ? 'bad' : sum.warn ? 'warn' : sum.unknown ? 'muted' : 'ok';
  return (
    <div className="ssa">
      <div className="ssa-head">
        <div className="ssa-title">
          <p className="ssa-note"><BoldText text={'Linux 서버에 붙는 SSH 계정 · 키를 법인마다 한 곳에서 정합니다. **법인 공통 계정**(기본 키)을 그 법인 서버가 함께 쓰고, 다른 키가 필요한 서버만 키를 **이름으로 고정**합니다. 지금 이 접속을 쓰는 기능은 베어메탈 사용률 · 베어메탈 스토리지입니다.'} /></p>
        </div>
        <div className="ssa-acts"><button className="btn btn-sm" type="button" onClick={load} disabled={st.loading}>{st.loading ? '읽는 중…' : '다시 읽기'}</button></div>
      </div>
      {st.err && <p className="ssa-banner" style={{ color: toneVar('bad') }}>다시 읽지 못했습니다 — 아래는 이전에 읽은 화면입니다({errText(st.err)}).</p>}
      {v.policyMode === 'unavailable' && (
        <p className="ssa-banner" style={{ color: toneVar('bad') }}><BoldText text={'자격증명 저장 방식(secrets-policy.json)을 **읽지 못해 잠겨** 있습니다 — 새 로그인 키를 받지 않습니다. 설정 › 보안 › 자격증명 저장 방식을 확인하세요.'} /></p>
      )}
      {v.policyMode && v.policyMode !== 'encrypted' && v.policyMode !== 'unavailable' && (
        <p className="ssa-banner" style={{ color: toneVar('bad') }}><BoldText text={'자격증명 저장 방식이 **평문**입니다 — 새 로그인 키를 받지 않습니다. 설정 › 보안 › 자격증명 저장 방식에서 암호화로 바꾸면 저장된 키도 함께 암호화됩니다.'} /></p>
      )}
      {(v.storeUnreadable || v.registryUnreadable || v.stateUnreadable) && (
        <p className="ssa-banner" style={{ color: toneVar('bad') }}>
          {v.storeUnreadable ? 'SSH 키 저장소(ssh-keys.json)를 읽지 못했습니다. ' : ''}{v.registryUnreadable ? 'OS 계정 등록부(bm-storage.json)를 읽지 못했습니다. ' : ''}
          {v.stateUnreadable ? '상태 파일(ssh-access-state.json)을 읽지 못해 모든 키 접속을 멈췄습니다. ' : ''}손상 보존본(*.corrupt.*)을 확인하세요.
        </p>
      )}
      <div className="ssa-kpis">
        <div className="ssa-kpi"><span className="ssa-sub">법인 · OS 등록 서버</span><b>{(v.corps || []).length}곳 · {v.registryUnreadable ? '—' : `${(v.servers || []).length}대`}</b></div>
        <div className="ssa-kpi"><span className="ssa-sub">키로 접속하는 서버</span><b style={{ color: srvKey ? toneVar('ok') : undefined }}>{v.registryUnreadable ? '—' : `${srvKey}대`}</b></div>
        <div className="ssa-kpi"><span className="ssa-sub">비밀번호로 접속하는 서버</span><b style={{ color: srvPw ? toneVar('warn') : undefined }}>{v.registryUnreadable ? '—' : `${srvPw}대`}</b></div>
        <div className="ssa-kpi"><span className="ssa-sub">활성 키{keyPending ? ` · 승인 대기 ${keyPending}` : ''}</span><b>{v.storeUnreadable ? '—' : `${keyCount}개`}</b></div>
        <div className="ssa-kpi"><span className="ssa-sub">키 점검</span><b style={{ color: toneVar(checkTone) }}>위험 {sum.bad || 0} · 확인 {sum.warn || 0}{sum.unknown ? ` · 모름 ${sum.unknown}` : ''}</b></div>
      </div>
      <div className="ssa-tabs" role="tablist" aria-label="SSH 공용 접속 보기">
        {TABS.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`ssa-tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>{label}{k === 'security' && apprPending > 0 ? ` · 승인 대기 ${apprPending}` : ''}</button>)}
      </div>
      {msg.text && <p className="ssa-note" role="status" style={{ color: toneVar(msg.tone) }}>{msg.text}</p>}
      {tab === 'servers' && <ServersTab v={v} corpName={corpName} reload={load} say={say} />}
      {tab === 'folders' && <FoldersTab v={v} corpName={corpName} reload={load} say={say} />}
      {tab === 'features' && <FeaturesTab v={v} />}
      {tab === 'security' && <SecurityTab v={v} corpName={corpName} reload={load} say={say} me={me} />}
    </div>
  );
}

/* ── 법인 · 서버 ───────────────────────────────────────────────────── */
function ServersTab({ v, corpName, reload, say }) {
  const corpIds = useMemo(() => {
    const ids = (v.corps || []).map((c) => c.id);
    if ((v.servers || []).some((s) => !s.vcenterId)) ids.push('');
    return ids;
  }, [v]);
  const [corp, setCorp] = useState(() => corpIds.find((id) => (v.servers || []).some((s) => (s.vcenterId || '') === id)) ?? corpIds[0] ?? '');
  const [pick, setPick] = useState(null);
  const [busy, setBusy] = useState(() => new Set());
  const [sel, setSel] = useState(() => new Set());   // 키 로그인 설정에 고른 서버 id(이 법인 것만 쓴다)
  const [kl, setKl] = useState(null);                // 키 로그인 설정 창 — { servers }
  const servers = (v.servers || []).filter((s) => (s.vcenterId || '') === corp);
  // 고를 수 있는 서버 = 이 법인 · 엣지 위임 아님. 고른 것은 지금 보이는 목록과의 교집합만 쓴다(다시 읽어 사라진 서버 · 다른 법인 id 는 버린다).
  const pickable = servers.filter(keyLoginSelectable);
  const chosen = pickable.filter((s) => sel.has(s.id));
  const allOn = pickable.length > 0 && chosen.length === pickable.length;
  const toggle = (id) => setSel((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const accounts = (v.accounts || []).filter((a) => (a.corp || '') === corp || !a.corp);
  const edges = (v.edgeRows || []).filter((r) => (r.corp || '') === corp);
  const stop0 = (v.corps || []).find((c) => c.id === corp)?.stop;
  // 상태 파일을 못 읽으면 stop = { unreadable } — ‘중지 중’ 이 아니라 ‘모름’(그동안 모든 키 접속이 멈춰 있다 · 반증 지적).
  const stateUnknown = !!stop0?.unreadable;
  const stop = stateUnknown ? null : stop0;
  const keyName = (id) => (v.keys || []).find((k) => k.id === id)?.name || '';
  const setB = (id, on) => setBusy((p) => { const n = new Set(p); if (on) n.add(id); else n.delete(id); return n; });
  // 등록부 · 키 저장소를 못 읽었으면 수는 ‘—’, 빈 목록은 ‘못 읽음’ 으로(0 · ‘없습니다’ 로 지어내지 않는다 — 점검 E-11).
  const regBad = !!v.registryUnreadable;
  const storeBad = !!v.storeUnreadable;
  const test = async (s) => {
    setB(s.id, true);
    try {
      const r = must(await postJson(`/settings/ssh-access/servers/${encodeURIComponent(s.id)}/test`, {}));
      say(r.connected ? `${s.name} — 접속됨(${r.authKind === 'key' ? '키' : '비밀번호'}${r.os ? ` · ${r.os}` : ''})` : `${s.name} — ${r.reason || r.kind}`, r.connected ? 'ok' : 'bad');
    } catch (e) { say(`${s.name} — ${errText(e)}`, 'bad'); } finally { setB(s.id, false); }
  };
  return (
    <div className="ssa-main">
      <div className="ssa-acts">
        <label className="ssa-corp-pick">법인 <Select sort={false} className="select select-sm" value={corp} onChange={(e) => { setCorp(e.target.value); setSel(new Set()); }}>
          {corpIds.map((id) => {
            const c = (v.corps || []).find((x) => x.id === id);
            const n = regBad ? null : (v.servers || []).filter((s) => (s.vcenterId || '') === id).length;
            return <option key={id || '_none'} value={id}>{corpName(id)}{c?.dc ? ` (${c.dc})` : ''} — 서버 {unitText(n, '대')}{c?.stop?.unreadable ? ' · 상태 모름' : c?.stop ? ' · 키 사용 중지' : ''}</option>;
          })}
        </Select></label>
        <span className="ssa-sub">{regBad ? 'OS 계정 등록부를 읽지 못해 법인별 서버 수를 모릅니다' : `OS 등록 서버가 있는 법인 ${corpIds.filter((id) => (v.servers || []).some((s) => (s.vcenterId || '') === id)).length}곳`}</span>
      </div>
      {stateUnknown && <p className="ssa-banner" style={{ color: toneVar('bad') }}>상태 파일을 읽지 못해 이 노드의 모든 키 접속을 멈췄습니다(사용 중지 기록을 모름) — 키 보안 탭에서 파일을 확인한 뒤 다시 읽으세요.</p>}
      {stop && <p className="ssa-banner" style={{ color: toneVar('bad') }}>이 법인은 키 사용이 중지돼 있습니다 — {stop.by || '—'} · {dateTime(stop.at)}{stop.reason ? ` · ${stop.reason}` : ''}. 키 보안 탭에서 재개합니다.</p>}
      {!kl && v.jobs?.install?.id && <InstallJobPanel jobRef={v.jobs.install} reload={reload} />}
      <section className="ssa-sec">
        <h4>{corpName(corp)} — 법인 공통 계정</h4>
        {accounts.length ? (
          <STable minWidth={640} className="ssa-t">
            <thead><tr><th>이름</th><th>계정</th><th>기본 키</th><th>비밀번호</th><th className="right">쓰는 서버</th></tr></thead>
            <tbody>{accounts.map((a) => (
              <tr key={a.id}><td data-sort={a.name}><b>{a.name}</b>{!a.corp && <div className="ssa-sub">전 법인 공용</div>}</td><td><code>{a.username}</code></td>
                <td data-sort={keyName(a.keyRef)}>{a.keyRef ? keyName(a.keyRef) || <Chip tone="bad">키 없음</Chip> : '—'}</td>
                <td>{a.hasPassword ? '저장됨' : '—'}</td><td className="right" data-sort={a.servers ?? ''}>{a.servers ?? '—'}</td></tr>
            ))}</tbody>
          </STable>
        ) : <p className="ssa-note">{storeBad ? 'SSH 키 저장소를 읽지 못해 공통 계정을 보일 수 없습니다(없는 것이 아닙니다).' : corp ? '이 법인의 공통 계정이 없습니다.' : '미귀속 서버에는 법인 공통 계정이 없습니다.'}</p>}
        <p className="ssa-note">공통 계정 추가 · 수정은 지금처럼 베어메탈 사용률 › 서버 등록 › 법인 공통 계정에서 합니다(같은 저장소).</p>
      </section>
      <section className="ssa-sec">
        <h4>{corpName(corp)} — 서버 {unitText(regBad ? null : servers.length, '대')}</h4>
        <div className="ssa-acts">
          <button className="btn btn-sm" type="button" disabled={!chosen.length} onClick={() => setKl({ servers: chosen })}>선택한 서버 키 로그인 설정{chosen.length ? ` (${chosen.length}대)` : ''}</button>
          <span className="ssa-sub">서버에 공개키 한 줄을 넣어 비밀번호 없이 접속하게 합니다 — 엣지가 수집하는 서버는 그 엣지 포탈에서 합니다.</span>
        </div>
        <STable minWidth={980} className="ssa-t">
          <thead><tr>
            <th data-nosort><input type="checkbox" aria-label="이 법인 서버 모두 고르기" checked={allOn} disabled={!pickable.length} onChange={() => setSel(allOn ? new Set() : new Set(pickable.map((s) => s.id)))} /></th>
            <th>서버</th><th>계정</th><th>쓰는 키</th><th>상태</th><th>서버에 들어 있는 키</th><th data-nosort>동작</th>
          </tr></thead>
          <tbody>
            {servers.map((s) => {
              const stt = serverStatus(s, { tampered: v.tampered, stop: !!stop || stateUnknown, rsaMinBits: v.rsaMinBits });
              return (
                <tr key={s.id}>
                  <td data-nosort><input type="checkbox" aria-label={`${s.name} 고르기`} checked={sel.has(s.id) && !s.agent} disabled={!!s.agent} title={s.agent ? '엣지가 수집하는 서버 — 그 엣지 포탈에서 설정합니다.' : undefined} onChange={() => toggle(s.id)} /></td>
                  <td data-sort={s.name}><b>{s.name}</b><div className="ssa-sub"><code>{s.host}{s.port !== 22 ? `:${s.port}` : ''}</code>{s.agent ? ` · 엣지 ${s.agent}` : ''}</div></td>
                  <td data-sort={s.username}>{s.accountMissing ? <Chip tone="bad">공통 계정 없음</Chip> : s.accountName ? `공통 ${s.accountName}` : '단독'}<div className="ssa-sub"><code>{s.username}</code></div></td>
                  <td data-sort={s.keyName || s.keyMode}>
                    {KEY_MODE_TEXT[s.keyMode] || s.keyMode}
                    {s.keyName && <div className="ssa-sub"><code>{s.keyName}</code></div>}
                  </td>
                  <td data-sort={stt.label}><Chip tone={stt.tone} title={stt.title}>{stt.label}</Chip></td>
                  <td data-sort={s.installed?.at || 0}>
                    {s.installed ? (s.installed.error ? <span className="ssa-sub">{s.installed.error}</span>
                      : <span>{s.installed.count}줄{s.keyName ? (s.installed.hasKey ? ' · 쓰는 키 있음' : ' · 쓰는 키 없음') : ''}</span>) : <span className="ssa-sub">읽지 않음</span>}
                    {s.installed && <div className="ssa-sub">{dateTime(s.installed.at)}{s.installed.stale ? ' · 주소가 바뀜(다시 읽기)' : ''}</div>}
                    {/* 쓰는 키 줄의 서버 쪽 제한(from= · 포워딩 금지) — 읽은 적이 있고 그 줄이 있을 때만 말한다(null = 모름) */}
                    {s.installed?.hasKey && s.installed.keyHasOptions === false && <div><Chip tone="warn" title="마지막으로 읽은 authorized_keys 기준 — 이 키 줄에 출발지 제한 · 포워딩 금지가 없습니다. 포탈이 넣은 줄(표식)이면 서버 쪽 제한이 켜진 상태에서 ‘키 로그인 설정’ 을 다시 하면(그 키가 아닌 접속 — 저장 비밀번호 · 이번 한 번 비밀번호로) 제한 줄로 바꿉니다. 사람이 넣은 줄(표식 없음) · 관리자가 옵션을 바꾼 줄은 포탈이 바꾸지 않습니다 — 서버에서 직접 고치세요.">서버 쪽 제한 없음</Chip></div>}
                    {s.installed?.hasKey && s.installed.keyHasOptions === true && <div className="ssa-sub">서버 쪽 제한 있음</div>}
                  </td>
                  <td data-nosort>
                    <div className="ssa-acts">
                      <button className="btn btn-sm" type="button" disabled={!!s.agent || busy.has(s.id)} onClick={() => setPick(s)}>키 고르기</button>
                      <button className="btn btn-sm" type="button" disabled={!!s.agent || busy.has(s.id)} title={s.agent ? '엣지가 수집하는 서버 — 그 엣지 포탈에서 설정합니다.' : undefined} onClick={() => setKl({ servers: [s] })}>키 로그인 설정</button>
                      <button className="btn btn-sm" type="button" disabled={!!s.agent || busy.has(s.id)} onClick={() => test(s)}>{busy.has(s.id) ? '시험 중…' : '연결 시험'}</button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!servers.length && <tr><td colSpan={7} className="ssa-sub">{regBad ? 'OS 계정 등록부를 읽지 못해 서버 목록을 보일 수 없습니다(없는 것이 아닙니다).' : '이 법인으로 등록된 OS 서버가 없습니다(베어메탈 스토리지 · 서버 등록에서 법인을 지정한 서버만 여기 보입니다).'}</td></tr>}
          </tbody>
        </STable>
        <p className="ssa-note">계정을 정하는 순서: 서버에 이름으로 고정한 키 → 법인 공통 계정의 기본 키 → 비밀번호. 고정한 키가 사라지거나 다른 폴더로 가면 다른 키로 넘어가지 않고 멈춥니다.</p>
      </section>
      {edges.length > 0 && (
        <section className="ssa-sec">
          <h4>엣지가 수집하는 서버 {edges.length}대</h4>
          <p className="ssa-note">이 서버들의 키는 그 엣지 포탈의 SSH 공용 접속에서 고릅니다 — 키는 법인 밖으로 나가지 않고, 중앙에는 이름만 있습니다.</p>
          <STable minWidth={720} className="ssa-t">
            <thead><tr><th>서버</th><th>엣지</th><th>주소</th><th>공통 계정 · 키 이름</th></tr></thead>
            <tbody>{edges.map((r, i) => (
              <tr key={`${r.agent}-${r.name}-${i}`}><td data-sort={r.name}>{r.name}</td><td>{r.agent}</td><td><code>{r.osHost || '—'}</code></td><td>{[r.osCred, r.osKey].filter(Boolean).join(' · ') || '—'}</td></tr>
            ))}</tbody>
          </STable>
        </section>
      )}
      {pick && <KeyPicker server={pick} catalog={v.features} onClose={(changed) => { setPick(null); if (changed) reload(); }} say={say} />}
      {kl && <KeyLoginDialog servers={kl.servers} corp={corp} v={v} corpName={corpName} onClose={(changed) => { setKl(null); if (changed) { setSel(new Set()); reload(); } }} />}
    </div>
  );
}

/* ── 키 로그인 설정 창(시안 ③ SshKey — v3.10.0) ────────────────────────── */
/**
 * 서버의 ~/.ssh/authorized_keys 에 공개키 한 줄을 넣는 창. 판정(이 키를 이 서버에 넣어도 되는가 · 접속처가 그대로인가)은 서버가 한다 —
 * 화면은 후보를 보이고(한 대 = 후보 API · 여러 대 = 그 법인 공통 폴더의 활성 키) 화면에서 본 접속처(addr)를 그대로 돌려보낸다.
 * Esc · 바깥 누르기는 작업이 도는 동안 닫지 않는다(닫기 단추는 된다 — 작업은 서버에서 계속되고 결과는 키 변경 기록에 남는다).
 */
function KeyLoginDialog({ servers, corp, v, corpName, onClose }) {
  const [targets, setTargets] = useState(servers);
  const single = targets.length === 1 ? targets[0] : null;
  const [cand] = useLoad(single ? `/settings/ssh-access/servers/${encodeURIComponent(single.id)}/candidates` : '');
  const [keyId, setKeyId] = useState(null);   // null = 아직 기본값을 정하지 않음(후보를 읽은 뒤 한 번)
  const [pwMode, setPwMode] = useState('saved');
  const [once, setOnce] = useState('');
  const [removePw, setRemovePw] = useState(true);
  const [replaceId, setReplaceId] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState({ text: '', tone: 'muted' });
  const kj = useKeyJob();
  const started = useRef(false);   // 작업을 한 번이라도 시작했는가 — 닫을 때 부모가 서버 표를 다시 읽는다
  const boxRef = useRef(null);
  const candKeys = cand.resp?.keys;
  const options = useMemo(() => (single ? (candKeys || []).filter((k) => k.selectable) : keyLoginKeyOptions(v, corp)), [single, candKeys, v, corp]);
  const ready = !single || !!cand.resp;
  useEffect(() => {
    if (keyId !== null || !ready) return;
    setKeyId(defaultKeyChoice(options, single ? ((candKeys || []).find((k) => k.current)?.id || '') : ''));
  }, [keyId, ready, options, single, candKeys]);
  const locked = busy || kj.running;
  const lockedRef = useRef(locked); lockedRef.current = locked;
  const closeRef = useRef(null); closeRef.current = () => onClose(started.current);
  useEffect(() => {
    const prev = document.activeElement;
    const onKey = (e) => { if (e.key === 'Escape' && !lockedRef.current) closeRef.current(); };
    window.addEventListener('keydown', onKey);
    boxRef.current?.focus();
    // 닫으면 창을 연 단추로 초점을 돌려준다(그 단추가 아직 화면에 있을 때).
    return () => { window.removeEventListener('keydown', onKey); if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus(); };
  }, []);
  const key = options.find((k) => k.id === keyId) || null;
  const replaceOptions = corpKeyOptions(v, corp, { exclude: key?.id || '' });
  const submit = async () => {
    if (!key) return;
    const body = { servers: targets.map((s) => ({ id: s.id, addr: s.addr || '' })), keyId: key.id, removePassword: removePw, otp };
    if (pwMode === 'once' && once) body.oncePassword = once;
    if (replaceId && replaceId !== key.id) body.replaceKeyId = replaceId;
    // 1회 비밀번호 · OTP 는 보낸 뒤 성공 · 실패와 무관하게 비운다(입력 칸 위생 — 실패하면 다시 넣는다).
    setOnce(''); setOtp('');
    setBusy(true); setNote({ text: '', tone: 'muted' });
    try {
      const r = must(await postJson('/settings/ssh-access/key-login', body));
      started.current = true;
      kj.start(r.jobId, r.skipped);
    } catch (e) {
      const sk = e?.body?.skipped;
      // 409 busy(다른 키 로그인 설정 작업이 도는 중 — OTP 를 쓰기 전에 거절) — 그 작업은 창을 닫으면 법인 · 서버 탭에 보인다(닫을 때 화면을 다시 읽게 한다).
      const busyJob = e?.body?.code === 'busy' && e?.body?.jobId;
      if (busyJob) started.current = true;
      setNote({ text: `${errText(e)}${busyJob ? ' 진행 중인 작업은 이 창을 닫으면 법인 · 서버 탭에 보입니다(멈추기도 거기서).' : ''}${Array.isArray(sk) && sk.length ? ` — ${sk.slice(0, 8).map((x) => x.name).join(' · ')}${sk.length > 8 ? ` 외 ${sk.length - 8}` : ''}` : ''}`, tone: 'bad' });
    } finally { setBusy(false); }
  };
  // 끝난 뒤 실패한 서버만 다시(사람이 고른 재시도 — 포탈이 스스로 다시 시도하지는 않는다). 접속처가 바뀌어 건너뛴 서버는 화면을 다시 읽어야 한다.
  const failedIds = new Set((kj.job?.results || []).filter((r) => r && r.ok !== true && r.code !== 'edge-delegated').map((r) => r.id));
  const retryTargets = targets.filter((s) => failedIds.has(s.id));
  const retry = () => { setTargets(retryTargets); kj.clear(); setNote({ text: '', tone: 'muted' }); };
  const close = () => onClose(started.current);
  return (
    <div className="ssa-modal-back" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !locked) close(); }}>
      <div className="ssa-modal" role="dialog" aria-modal="true" aria-labelledby="ssa-kl-t" ref={boxRef} tabIndex={-1}>
        <div className="ssa-modal-h">
          <h4 id="ssa-kl-t">키 로그인 설정 — {corpName(corp)} · 서버 {targets.length}대</h4>
          <span className="ssa-sub">서버에 공개키 한 줄을 넣어, 다음부터 비밀번호 없이 접속하게 합니다.</span>
        </div>
        {!kj.id ? (
          <div className="ssa-modal-b">
            <div className="ssa-line"><span className="ssa-k">대상</span>
              <div className="ssa-v">
                <ul className="ssa-targets">{targets.map((s) => (
                  <li key={s.id}><b>{s.name}</b> <span className="ssa-sub"><code>{s.host}{s.port !== 22 ? `:${s.port}` : ''} · {s.username}</code></span></li>
                ))}</ul>
              </div>
            </div>
            <div className="ssa-line"><span className="ssa-k">넣을 키</span>
              <div className="ssa-v ssa-stack">
                {single && cand.err && !cand.resp ? <ErrorBox error={cand.err} />
                  : !ready ? <span className="ssa-sub">이 서버에 쓸 수 있는 키를 읽는 중…</span>
                  : options.length ? (
                    <>
                      <Select className="select select-sm" aria-label="넣을 키" value={key ? key.id : ''} onChange={(e) => setKeyId(e.target.value)}>
                        <option value="">선택</option>
                        {options.map((k) => <option key={k.id} value={k.id}>{keyOptionLabel(k, corpName)}</option>)}
                      </Select>
                      {key && <span className="ssa-sub">{key.algo}{key.bits ? ` ${key.bits}` : ''} · <code>{shortFp(key.fingerprint)}</code> · 키 폴더 ‘{folderText(key, corpName)}’{key.installed === true ? ' · 이 서버에 이미 들어 있음(마지막으로 읽은 내용 기준 — 줄이 있으면 더하지 않고 접속만 확인합니다. 서버 쪽 제한이 켜져 있고 그 줄이 제한 없는 포탈 줄이면 제한 줄로 바꿀 수 있습니다)' : ''}</span>}
                    </>
                  ) : v.storeUnreadable ? <span className="ssa-note" style={{ color: toneVar('bad') }}>SSH 키 저장소를 읽지 못해 넣을 키를 고를 수 없습니다(키가 없는 것이 아닙니다).</span>
                  : <span className="ssa-note" style={{ color: toneVar('warn') }}>{single ? '이 서버에 넣을 수 있는 키가 없습니다 — 키 폴더 탭에서 이 법인(공통) 또는 이 서버 폴더에 키를 등록하세요(승인 대기 · 퇴역 키는 넣지 않습니다).' : '이 법인 공통 폴더에 넣을 수 있는 키가 없습니다 — 키 폴더 탭에서 공통 폴더에 키를 등록하세요(승인 대기 · 퇴역 키는 넣지 않습니다).'}</span>}
                {!single && <span className="ssa-sub">여러 대에는 이 법인 공통 폴더의 키만 넣습니다 — 서버별 폴더의 키는 그 서버 한 대씩 설정합니다.</span>}
              </div>
            </div>
            <div className="ssa-line"><span className="ssa-k">등록에 쓸 비밀번호</span>
              <div className="ssa-v ssa-stack" role="radiogroup" aria-label="등록에 쓸 비밀번호">
                <label className="ssa-radio"><input type="radio" name="ssa-kl-pw" checked={pwMode === 'saved'} onChange={() => { setPwMode('saved'); setOnce(''); }} /><span>저장된 인증 사용 — 이 서버가 지금 쓰는 접속 수단(키로 설정돼 있으면 그 키, 아니면 저장된 비밀번호)</span></label>
                <label className="ssa-radio"><input type="radio" name="ssa-kl-pw" checked={pwMode === 'once'} onChange={() => setPwMode('once')} /><span>지금 입력 — 이번 한 번만 쓰고 저장하지 않습니다</span></label>
                <input className="input ssa-pw" type="password" aria-label="등록에 쓸 비밀번호" placeholder="비밀번호" disabled={pwMode !== 'once'} value={once} onChange={(e) => setOnce(e.target.value)} autoComplete="new-password" />
                {pwMode === 'saved' && savedAuthHints(targets, { keyId: key?.id || '', accounts: v.accounts }).map((t) => <span key={t} className="ssa-sub" style={{ color: toneVar('warn') }}>{t}</span>)}
                {!single && pwMode === 'once' && <span className="ssa-sub">고른 서버 {targets.length}대에 같은 비밀번호로 한 번씩 접속합니다 — 비밀번호가 다른 서버는 인증이 거부되고, 다시 시도하지 않습니다.</span>}
              </div>
            </div>
            <div className="ssa-line"><span className="ssa-k">하는 일</span>
              <div className="ssa-v"><ol className="ssa-steps">
                <li>{pwMode === 'once' ? '넣은 비밀번호로' : '저장된 인증으로'} 한 번 접속합니다.</li>
                <li><code>~/.ssh/authorized_keys</code> 끝에 공개키 한 줄을 더합니다 — 포탈이 넣은 줄임을 알 수 있게 표식을 붙입니다. 같은 키 줄이 이미 있으면 더하지 않습니다. 단, 서버 쪽 제한이 켜져 있고 포탈이 넣은 그 키 줄이 제한 없이(또는 다른 주소로) 있으면 그 줄을 제한 줄로 바꿉니다 — 이번 접속이 바로 그 키일 때는 되돌릴 길이 없어 바꾸지 않습니다. 사람이 넣은 줄 · 관리자가 옵션을 바꾼 줄은 손대지 않습니다.</li>
                <li>접속을 끊고 키로 다시 접속해 확인합니다.</li>
                <li>확인되면 이 서버가 그 키를 쓰도록 적습니다. 이미 그 키를 쓰는 서버(법인 기본 키를 따르는 서버 포함)는 설정을 그대로 둡니다.</li>
              </ol></div>
            </div>
            <div className="ssa-line"><span className="ssa-k">잘 안 되면</span><div className="ssa-v">키 접속이 확인되지 않으면 우리가 바꾼 것만 되돌립니다(더한 줄은 지우고, 바꾼 줄은 바꾸기 전 줄로). 비밀번호가 틀리면 다시 시도하지 않습니다(password 방식으로 한 번 — 계정 잠금 방지). 서버 쪽 제한 때문에 키 접속이 안 될 때도 제한을 자동으로 빼지 않고 사유를 적습니다. 바꾸는 명령을 보냈는데 답을 받지 못하면 ‘결과 모름’ 으로 적습니다 — 서버가 바뀌었을 수 있으니 확인하세요.</div></div>
            <div className="ssa-line"><span className="ssa-k">선택</span>
              <div className="ssa-v ssa-stack">
                <label className="ssa-radio"><input type="checkbox" checked={removePw} onChange={(e) => setRemovePw(e.target.checked)} /><span>키 로그인이 확인되면 저장된 비밀번호를 지웁니다</span></label>
                <span className="ssa-sub">이 서버 항목에 저장된 비밀번호만 지웁니다 — 법인 공통 계정의 비밀번호는 그대로입니다.</span>
                <span>서버 쪽 제한 <span className="ssa-sub">{restrictLineText(v.guards)}</span></span>
                <label className="ssa-stack">교체 — 확인되면 옛 키 줄 삭제
                  <Select className="select select-sm" aria-label="교체 — 확인되면 줄을 지울 옛 키" value={replaceId && replaceId !== key?.id ? replaceId : ''} onChange={(e) => setReplaceId(e.target.value)}>
                    <option value="">지우지 않음</option>
                    {replaceOptions.map((k) => <option key={k.id} value={k.id}>{keyOptionLabel(k, corpName)}</option>)}
                  </Select>
                </label>
                <span className="ssa-sub">새 키 접속을 확인한 뒤에만 옛 키 줄을 지웁니다 — 포탈이 넣은 줄(표식)만 지우고, 사람이 넣은 같은 키 줄은 수만 알려 줍니다.</span>
              </div>
            </div>
            <div className="ssa-line"><span className="ssa-k">바꾸지 않는 것</span><div className="ssa-v">sshd 설정(비밀번호 로그인 허용 여부 등) · sudoers · 다른 사람이 넣은 키 줄.</div></div>
            <div className="ssa-line"><span className="ssa-k">본인 확인</span>
              <div className="ssa-v ssa-stack"><Otp value={otp} onChange={setOtp} /><span className="ssa-sub">서버의 접속 경로를 바꾸는 작업이라 설정 소유자 등급에 더해 본인 OTP 가 필요합니다.</span></div>
            </div>
          </div>
        ) : (
          <div className="ssa-modal-b">
            <b>서버마다 한 줄</b>
            <KeyJobResult key={kj.id} kj={kj} kind="key-login" />
          </div>
        )}
        {note.text && <p className="ssa-note" role="status" style={{ color: toneVar(note.tone) }}>{note.text}</p>}
        {!kj.id ? (
          <div className="ssa-modal-f">
            <span className="ssa-sub">여러 대를 고르면 1대씩 차례로 합니다. 교체할 때도 같은 순서입니다.</span>
            <div className="ssa-acts">
              <button className="btn" type="button" disabled={busy} onClick={close}>취소</button>
              <button className="btn primary" type="button" disabled={busy || !key || (pwMode === 'once' && !once)} onClick={submit}>{busy ? '시작하는 중…' : '키 로그인 설정'}</button>
            </div>
          </div>
        ) : (
          <div className="ssa-modal-f">
            <span className="ssa-sub">{kj.running ? '창을 닫아도 작업은 서버에서 계속됩니다 — 진행 · 결과는 법인 · 서버 탭에서 이어 볼 수 있습니다(끝난 뒤 한동안 · 포탈이 다시 시작하기 전까지).' : '닫으면 서버 표를 다시 읽습니다.'}</span>
            <div className="ssa-acts">
              {!kj.running && retryTargets.length > 0 && <button className="btn" type="button" onClick={retry}>실패한 서버 {retryTargets.length}대만 다시 설정</button>}
              <button className="btn" type="button" onClick={close}>{kj.running ? '창 닫기(작업은 계속됩니다)' : '닫기'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── 키 고르기 창(시안 ⑥) ───────────────────────────────────────────── */
function KeyPicker({ server, catalog, onClose, say }) {
  const [st, load] = useLoad(`/settings/ssh-access/servers/${encodeURIComponent(server.id)}/candidates`);
  const [choice, setChoice] = useState(null);
  const [otp, setOtp] = useState('');
  const [once, setOnce] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState({ text: '', tone: 'muted' });
  const readDone = useRef(false);
  const firstRef = useRef(null);
  const c = st.resp;
  useEffect(() => {
    if (!c || choice !== null) return;
    const cur = (c.keys || []).find((k) => k.current);
    // 지금 설정 그대로를 미리 고른다 — 이름 고정이면 그 키, 법인 기본 키를 따르면 '', 그 밖(비밀번호 고정 등)은 고르지 않음(E-L11).
    setChoice(c.server.keyMode === 'pinned' && cur ? cur.id : (c.server.keyMode === 'corp-default' ? '' : null));
  }, [c, choice]);
  // 저장 · 읽기 중에는 Esc · 바깥 · 닫기로 닫지 않는다(점검 E-12 — 저장이 실패해 ‘되돌리기도 실패’ 경고가 나와야 할 때 창이 이미 닫혀 그 경고가 사라졌다).
  // 닫는 함수는 ref 로 — 부모가 인라인 함수를 넘겨 다시 그려질 때마다 효과가 다시 돌아 초점을 옮기지 않게(A-2). 닫으면 창을 연 단추로 초점을 돌려준다(A-1).
  const lockedRef = useRef(false); lockedRef.current = !!busy;
  const closeRef = useRef(null); closeRef.current = () => { if (!lockedRef.current) onClose(readDone.current); };
  useEffect(() => {
    const prev = document.activeElement;
    const onKey = (e) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    firstRef.current?.focus();
    return () => { window.removeEventListener('keydown', onKey); if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus(); };
  }, []);
  const read = async () => {
    setBusy('read');
    try {
      const r = must(await postJson(`/settings/ssh-access/servers/${encodeURIComponent(server.id)}/installed-keys`, once ? { oncePassword: once } : {}));
      readDone.current = true;
      setNote({ text: `서버에 들어 있는 키 ${(r.keys || []).length}줄을 읽었습니다${r.error ? ` — ${r.error}` : ''}${r.truncated ? ` · ${r.truncated}줄은 상한을 넘어 읽지 않음` : ''}.`, tone: 'ok' });
      load();
    } catch (e) { setNote({ text: errText(e), tone: 'bad' }); } finally { setOnce(''); setBusy(''); }
  };
  const save = async () => {
    setBusy('save');
    try {
      const r = must(await postJson(`/settings/ssh-access/servers/${encodeURIComponent(server.id)}/key`, { keyId: choice || '', expectAddr: server.addr || '', otp }));
      say(`${server.name} — 고른 키로 접속을 확인하고 저장했습니다(${r.test?.authKind === 'key' ? '키' : '비밀번호'}).`, 'ok');
      onClose(true);
    } catch (e) {
      const b = e?.body || {};
      const revertFail = b.code === 'test-failed' && b.reverted === false;
      setNote({ text: revertFail ? `${errText(e)} — ⚠ 되돌리기도 실패했습니다(${b.revertError || '사유 모름'}). 서버 설정을 다시 읽어 확인하세요.` : errText(e), tone: 'bad' });
      if (b.code === 'test-failed') readDone.current = true;   // 되돌렸어도 표를 다시 읽는다
    } finally { setOtp(''); setBusy(''); }
  };
  const groups = [['server', '서버별 폴더 — 이 서버 전용'], ['common', '공통 폴더 — 법인 공통'], ['none', '미분류 — 폴더가 없는 예전 키']];
  const chosenKey = (c?.keys || []).find((k) => k.id === choice);
  const noCollect = chosenKey && Array.isArray(chosenKey.features) && !COLLECT_FEATURES.some((f) => chosenKey.features.includes(f));
  return (
    <div className="ssa-modal-back" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) closeRef.current(); }}>
      <div className="ssa-modal" role="dialog" aria-modal="true" aria-labelledby="ssa-pick-t">
        <div className="ssa-modal-h">
          <h4 id="ssa-pick-t">{server.name} — 쓸 키 고르기</h4>
          <span className="ssa-sub"><code>{server.host} · {server.username}</code></span>
        </div>
        {st.err && <ErrorBox error={st.err} />}
        {!c ? (!st.err && <p className="ssa-note">읽는 중…</p>) : (
          <div className="ssa-modal-b">
            <div role="radiogroup" aria-label="쓸 키">
              {c.corpDefault && (
                <label className={`ssa-opt${choice === '' ? ' on' : ''}`}>
                  <input ref={firstRef} type="radio" name="ssa-key" checked={choice === ''} onChange={() => setChoice('')} />
                  <span><b>법인 기본 키를 따름</b><span className="ssa-sub"> — 공통 계정 {c.corpDefault.accountName}({c.corpDefault.username}) · 기본 키 {c.corpDefault.keyName || '없음(비밀번호)'}</span></span>
                </label>
              )}
              {groups.map(([g, label]) => {
                const list = (c.keys || []).filter((k) => k.folder === g);
                if (!list.length) return null;
                return (
                  <div key={g}>
                    <div className="ssa-grp">{label}</div>
                    {list.map((k) => (
                      <label key={k.id} className={`ssa-opt${choice === k.id ? ' on' : ''}${k.selectable ? '' : ' off'}`}>
                        <input type="radio" name="ssa-key" checked={choice === k.id} disabled={!k.selectable} onChange={() => setChoice(k.id)} />
                        <span>
                          <b><code>{k.name}</code></b>
                          {k.current && <Chip tone="ok">지금 쓰는 키</Chip>}
                          {k.installed === true && <Chip tone="ok">이 서버에 들어 있음</Chip>}
                          {k.installed === false && <Chip tone="warn">이 서버에 없음</Chip>}
                          {!k.selectable && <Chip tone="bad">{ISSUE_TEXT[k.issue] || k.issue}</Chip>}
                          <span className="ssa-sub"> {k.algo}{k.bits ? ` ${k.bits}` : ''} · {shortFp(k.fingerprint)} · 기능 {featuresText(k.features, catalog)}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                );
              })}
              {!(c.keys || []).length && !c.corpDefault && <p className="ssa-note">이 서버에 쓸 수 있는 키가 없습니다 — 키 폴더 탭에서 이 법인(공통) 또는 이 서버 폴더에 키를 등록하세요.</p>}
              {noCollect && <p className="ssa-note" style={{ color: toneVar('warn') }}>이 키는 베어메탈 사용률 · 스토리지 수집에 허용되지 않았습니다 — 저장해도(연결 시험은 통과해도) 주기 수집은 이 키로 접속하지 않습니다. 키 폴더 탭에서 기능을 더하세요.</p>}
            </div>
            <div className="ssa-installed">
              <div className="ssa-acts">
                <b>이 서버에 들어 있는 키</b>
                <span className="ssa-sub">{c.installed ? `${dateTime(c.installed.at)} 읽음${c.installed.stale ? ' · 주소가 바뀜' : ''}` : '아직 읽지 않음'}</span>
              </div>
              {c.installed && !c.installed.error && (
                <ul className="ssa-list">{c.installed.keys.map((k, i) => (
                  <li key={`${k.fingerprint}-${i}`}><code>{shortFp(k.fingerprint)}</code> <span className="ssa-sub">{k.comment || '설명 없음'}</span> {k.keyName ? <Chip tone="ok">폴더에 있음 — {k.keyName}</Chip> : <Chip>개인키가 폴더에 없음</Chip>}</li>
                ))}</ul>
              )}
              {c.installed?.error && <p className="ssa-note">{c.installed.error}</p>}
              <div className="ssa-acts">
                <label className="ssa-otp">이번 한 번만 쓸 비밀번호(선택) <input className="input" type="password" value={once} onChange={(e) => setOnce(e.target.value)} autoComplete="new-password" /></label>
                <button className="btn btn-sm" type="button" disabled={busy === 'read'} onClick={read}>{busy === 'read' ? '읽는 중…' : '다시 읽기'}</button>
              </div>
              <p className="ssa-note">서버 계정의 ~/.ssh/authorized_keys 에서 공개키 줄만 읽어 지문으로 맞춥니다. 비밀번호를 넣으면 이번 읽기에만 쓰고 저장하지 않습니다(password 방식으로 한 번만 보냅니다). 폴더의 키를 차례로 대 보지는 않습니다(계정 잠금 방지).</p>
            </div>
          </div>
        )}
        {note.text && <p className="ssa-note" role="status" style={{ color: toneVar(note.tone) }}>{note.text}</p>}
        <div className="ssa-modal-f">
          <Otp value={otp} onChange={setOtp} />
          <div className="ssa-acts">
            <button className="btn" type="button" disabled={!!busy} onClick={() => closeRef.current()} ref={c?.corpDefault ? undefined : firstRef}>닫기</button>
            <button className="btn primary" type="button" disabled={busy === 'save' || choice === null || !c} onClick={save}>{busy === 'save' ? '확인 중…' : '이 키 사용'}</button>
          </div>
        </div>
        <p className="ssa-note">저장하면 고른 키로 한 번 접속해 확인합니다(연결 시험 — 기능 허용과 무관). 안 되면 이전 설정으로 되돌리고 이유를 적습니다.</p>
      </div>
    </div>
  );
}

/* ── 키 폴더(시안 ②) ───────────────────────────────────────────────── */
async function copyText(text) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* 아래로 */ }
  window.prompt('공개키 — 직접 복사하세요(Ctrl+C)', text);   // 비보안 컨텍스트(HTTP)는 clipboard API 가 없다(E-L10)
  return false;
}
function FoldersTab({ v, corpName, reload, say }) {
  const tree = useMemo(() => folderTree(v), [v]);
  const [sel, setSel] = useState(() => tree.find((n) => n.kind === 'common' && tree.find((c) => c.id === `corp:${n.corp}`)?.count) || tree.find((n) => n.kind === 'common') || tree[0]);
  const node = tree.find((n) => n.id === sel?.id) || tree[0];
  const shown = tree.filter((n) => n.kind === 'corp' || n.kind === 'none' || n.corp === node?.corp);
  const keys = keysInFolder(v, node);
  const inbox = inboxInFolder(v, node);
  const blankAdd = { name: '', privateKey: '', passphrase: '', rotateAt: '', features: [], otp: '' };
  const [edit, setEdit] = useState(null);   // { key, folderCorp, folderServer, features(null = 제한 없음), otp }
  const [add, setAdd] = useState(blankAdd);
  const [appr, setAppr] = useState(null);   // { item, name, passphrase, features, otp }
  const [kact, setKact] = useState(null);   // 키 교체 · 삭제 — { kind: 'rotate' | 'delete', key, to, otp }
  const [disc, setDisc] = useState(null);   // 받은 키 파일 지우기 — { item, otp }(OTP 는 보통 입력 칸으로 — window.prompt 는 글자가 그대로 보였다 · 점검 E-16)
  const [busy, setBusy] = useState(false);
  const storeBad = !!v.storeUnreadable;   // 키 저장소를 못 읽으면 수는 ‘—’ · 빈 폴더는 ‘못 읽음’(점검 E-11)
  const canAdd = node && (node.kind === 'common' || node.kind === 'server');
  /**
   * 쓰기 하나 — 실패는 서버 사유 그대로(충돌 목록 포함). 성공 문구는 결과로 만든다.
   * v3.10.0: 202 `pending`(다른 설정 소유자의 승인 대기)이면 성공 톤으로 그리지 않는다 — 문구는 호출부가 `pendingText` 로 만든다.
   */
  const run = async (fn, okText) => {
    setBusy(true);
    try { const r = must(await fn()); say(typeof okText === 'function' ? okText(r) : okText, r.plaintextLeft ? 'bad' : r.pending ? pendingTone(r) : 'ok'); reload(); return true; }
    catch (e) {
      const cf = e?.body?.conflicts;
      // 키 교체가 중간에 실패하면 이미 옮긴 곳이 있다(partial — 점검 E-9). 실패로만 말하지 않고 그 사실을 붙이고, 표를 다시 읽는다.
      const part = rotatePartialText(e?.body?.partial);
      say(`${cf?.length ? `${errText(e)} — ${cf.slice(0, 8).map((x) => `${x.kind === 'account' ? '공통 계정' : '서버'} ${x.name}`).join(' · ')}${cf.length > 8 ? ` 외 ${cf.length - 8}` : ''}` : errText(e)}${part ? ` ${part}` : ''}`, 'bad');
      if (part) reload();
      return false;
    } finally { setBusy(false); }
  };
  const path = node?.kind === 'server' ? (v.servers || []).find((s) => s.vcenterId === node.corp && s.name.toLowerCase() === node.server.toLowerCase())?.inboxPath
    : node?.kind === 'common' || node?.kind === 'corp' ? (v.corps || []).find((c) => c.id === node.corp)?.inboxPath : '';
  return (
    <div className="ssa-split">
      <nav className="ssa-tree" aria-label="키 폴더">
        {shown.map((n) => (
          <button key={n.id} type="button" className={`ssa-node d${n.depth}${node?.id === n.id ? ' on' : ''}`} onClick={() => setSel(n)} aria-current={node?.id === n.id ? 'true' : undefined}>
            <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M3 6.5h6l2 2.5h10v9.5H3z" /></svg>
            <span className="ssa-node-l">{n.label}</span><span className="ssa-sub">{storeBad ? '—' : n.count}</span>
          </button>
        ))}
      </nav>
      <div className="ssa-main">
        <section className="ssa-sec">
          <h4>{node?.kind === 'none' ? '미분류' : `${corpName(node?.corp)} › ${node?.kind === 'server' ? `서버별 › ${node.server}` : node?.kind === 'servers' ? '서버별(전부)' : node?.kind === 'corp' ? '전부' : '공통'}`} — 키 {unitText(storeBad ? null : keys.length, '개')}</h4>
          {node?.kind === 'none' && <p className="ssa-note">폴더가 없는 키는 어느 법인 서버에든 쓰일 수 있습니다 — 법인(공통 · 서버별)을 정하세요.</p>}
          {path && <p className="ssa-note">서버에서 키 파일을 직접 넣는 곳: <code>{path}</code> — 넣은 파일은 아래 ‘받은 키’ 에 나타나고, 승인하기 전에는 쓰지 않습니다.</p>}
          <STable minWidth={620} className="ssa-t ssa-keys">
            <thead><tr><th>이름</th><th>지문</th><th>쓸 수 있는 기능</th><th>쓰는 곳 · 마지막 사용</th><th data-nosort>동작</th></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td data-sort={k.name}><b><code>{k.name}</code></b>{k.status === 'retired' && <Chip tone="muted">퇴역</Chip>}
                    {k.status === 'pending' && <Chip tone="warn" title="다른 설정 소유자의 승인을 기다립니다 — 승인되기 전에는 접속에 쓰지 않고, 서버에서 고를 수도 없습니다(키 보안 › 승인 대기).">승인 대기</Chip>}
                    {(v.tampered || []).includes(k.id) && <Chip tone="bad">포탈 밖에서 바뀜</Chip>}
                    <div className="ssa-sub">{k.folderServer ? `서버별 › ${k.folderServer}` : k.folderCorp ? '공통' : '미분류'} · {k.algo}{k.bits ? ` ${k.bits}` : ''}{k.hasPassphrase ? ' · passphrase' : ''} · {ageDays(k.createdAt) != null ? `${ageDays(k.createdAt)}일 전` : '—'}</div>
                    {k.rotateDue && <Chip tone="warn">회전 예정일 지남</Chip>}</td>
                  <td data-sort={k.fingerprint}><code title={`${k.fingerprint}\n${k.publicKey}`}>{shortFp(k.fingerprint)}</code></td>
                  <td data-sort={featuresText(k.features, v.features)}>{k.features == null ? <Chip tone="warn">모든 기능(예전 방식)</Chip> : k.features.length ? featuresText(k.features, v.features) : <Chip tone="bad">없음 — 어느 기능도 못 씀</Chip>}</td>
                  <td data-sort={k.servers ?? ''}>서버 {k.servers ?? '—'}{k.accountsUsing ? ` · 공통 계정 ${k.accountsUsing}` : ''}<div className="ssa-sub">{v.usageLoadFailed ? '사용 기록을 읽지 못함' : k.lastUse ? `${dateTime(k.lastUse.lastAt)} · ${k.lastUse.server}` : '쓴 기록 없음'}</div></td>
                  <td data-nosort>
                    <div className="ssa-acts">
                      <button className="btn btn-sm" type="button" disabled={busy || k.status !== 'active'} onClick={() => setEdit({ key: k, folderCorp: k.folderCorp, folderServer: k.folderServer, features: k.features == null ? null : [...k.features], otp: '' })}>폴더 · 기능</button>
                      <button className="btn btn-sm" type="button" disabled={busy || k.status !== 'active'} title={k.status === 'pending' ? '승인 대기 중인 키는 교체할 수 없습니다.' : k.status === 'retired' ? '이미 퇴역한 키입니다.' : undefined} onClick={() => setKact({ kind: 'rotate', key: k, to: '', otp: '' })}>교체…</button>
                      {/* 승인 대기 키 — 등록 요청이 살아 있으면 그 요청을 돌려보내야 지워진다. 요청이 없으면(뒷정리가 안 끝나 남은 키) 여기서 바로 지운다. 승인 기록을 못 읽었으면 어느 쪽인지 모르므로 잠근다. */}
                      <button className="btn btn-sm" type="button" disabled={busy || (k.status === 'pending' && (!!v.approvalsUnreadable || !!pendingKeyRequest(v, k.id)))}
                        title={k.status !== 'pending' ? undefined : v.approvalsUnreadable ? '승인 기록을 읽지 못해 이 키의 등록 요청이 살아 있는지 모릅니다 — 승인 기록 파일을 확인한 뒤 다시 읽으세요.'
                          : pendingKeyRequest(v, k.id) ? '승인 대기 중인 키입니다 — 키 보안 › 승인 대기에서 돌려보내면(요청 취소) 지워집니다.' : '등록 요청이 남아 있지 않은 승인 대기 키입니다 — 바로 지울 수 있습니다.'}
                        onClick={() => setKact({ kind: 'delete', key: k, to: '', otp: '' })}>삭제</button>
                      <button className="btn btn-sm" type="button" onClick={async () => { if (await copyText(k.publicKey)) say(`${k.name} 공개키를 복사했습니다.`, 'ok'); }}>공개키 복사</button>
                    </div>
                  </td>
                </tr>
              ))}
              {!keys.length && <tr><td colSpan={5} className="ssa-sub">{storeBad ? 'SSH 키 저장소를 읽지 못해 키를 보일 수 없습니다(없는 것이 아닙니다).' : '이 폴더에 키가 없습니다.'}</td></tr>}
            </tbody>
          </STable>
        </section>
        {edit && (
          <fieldset className="ssa-form">
            <legend>{edit.key.name} — 폴더 · 쓸 수 있는 기능</legend>
            <label>법인 <Select sort={false} className="select select-sm" value={edit.folderCorp} onChange={(e) => setEdit({ ...edit, folderCorp: e.target.value, folderServer: '' })}>
              <option value="">미분류(폴더 없음)</option>{(v.corps || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select></label>
            <label>서버(비우면 공통) <Select sort={false} className="select select-sm" value={edit.folderServer} disabled={!edit.folderCorp} onChange={(e) => setEdit({ ...edit, folderServer: e.target.value })}>
              <option value="">공통</option>{(v.servers || []).filter((s) => s.vcenterId === edit.folderCorp).map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
            </Select></label>
            <div className="ssa-wide"><span className="ssa-sub">쓸 수 있는 기능</span><FeaturePicker catalog={v.features} value={edit.features} onChange={(f) => setEdit({ ...edit, features: f })} allowAll={edit.key.features == null} /></div>
            {!featuresChosen(edit.features) && <p className="ssa-note" style={{ color: toneVar('warn') }}>기능을 하나 이상 고르세요 — 없으면 이 키로 어느 기능도 접속하지 않습니다(쓰는 서버 {unitText(edit.key.servers, '대')}의 수집이 멈춥니다).</p>}
            <Otp value={edit.otp} onChange={(x) => setEdit({ ...edit, otp: x })} />
            <div className="ssa-acts">
              <button className="btn primary" type="button" disabled={busy || !featuresChosen(edit.features)} onClick={async () => {
                const ok = await run(() => putJson(`/settings/ssh-access/keys/${encodeURIComponent(edit.key.id)}/placement`, { folderCorp: edit.folderCorp, folderServer: edit.folderServer, features: edit.features, otp: edit.otp }), `${edit.key.name} — 폴더 · 기능을 바꿨습니다.`);
                if (ok) setEdit(null); else setEdit((x) => ({ ...x, otp: '' }));
              }}>저장</button>
              <button className="btn" type="button" onClick={() => setEdit(null)}>닫기</button>
            </div>
            <p className="ssa-note">이 키를 쓰는 서버 · 공통 계정이 새 폴더 밖이 되면 저장하지 않고 목록을 보여 줍니다. 기능을 빼면 그 기능은 이 키로 접속하지 않습니다.</p>
          </fieldset>
        )}
        {kact?.kind === 'rotate' && (
          <fieldset className="ssa-form">
            <legend>{kact.key.name} — 새 키로 교체(회전)</legend>
            <label>새 키 <Select className="select select-sm" value={kact.to} onChange={(e) => setKact({ ...kact, to: e.target.value })}>
              <option value="">선택</option>{rotateTargetOptions(v, kact.key).map((k) => <option key={k.id} value={k.id}>{keyOptionLabel(k, corpName)}</option>)}
            </Select></label>
            <Otp value={kact.otp} onChange={(x) => setKact({ ...kact, otp: x })} />
            <div className="ssa-acts">
              <button className="btn primary" type="button" disabled={busy || !kact.to} onClick={async () => {
                const pair = `${kact.key.name} → ${(v.keys || []).find((k) => k.id === kact.to)?.name || '새 키'}`;
                const ok = await run(() => postJson('/settings/ssh-access/keys/rotate', { from: kact.key.id, to: kact.to, otp: kact.otp }),
                  (r) => (r.pending ? pendingText(r, { what: `${pair} 교체`, then: '교체됩니다' }) : `${pair} — ${rotateDoneText(r)}.`));
                if (ok) setKact(null); else setKact((x) => (x ? { ...x, otp: '' } : x));
              }}>교체</button>
              <button className="btn" type="button" onClick={() => setKact(null)}>닫기</button>
            </div>
            <p className="ssa-note">옛 키를 쓰는 서버 · 공통 계정이 새 키를 가리키게 바꾸고 옛 키를 퇴역시킵니다. 서버의 authorized_keys 는 바꾸지 않습니다 — 새 키가 서버에 들어 있지 않으면 그 서버의 키 접속이 끊깁니다. 먼저 법인 · 서버 탭의 ‘키 로그인 설정’ 으로 새 키를 넣고(교체 — 옛 키 줄 삭제) 접속을 확인한 뒤 하세요. 새 키의 폴더가 쓰는 곳을 덮지 못하면 바꾸지 않고 목록을 보여 줍니다.</p>
          </fieldset>
        )}
        {kact?.kind === 'delete' && (
          <fieldset className="ssa-form">
            <legend>{kact.key.name} — 키 삭제</legend>
            <p className="ssa-note">지문 <code>{shortFp(kact.key.fingerprint)}</code> · 쓰는 서버 {unitText(kact.key.servers, '대')} · 공통 계정 {unitText(kact.key.accountsUsing, '개')}. 쓰는 곳이 있으면 지우지 않습니다 — 먼저 교체로 참조를 옮기세요.</p>
            {kact.key.status === 'pending'
              ? <p className="ssa-note">승인 요청이 남아 있지 않은 승인 대기 키입니다(요청 뒷정리가 끝나지 않아 남은 것) — 한 번도 접속에 쓰인 적이 없어 승인 절차 없이 바로 지웁니다.</p>
              : <p className="ssa-note" style={{ color: toneVar('warn') }}>서버의 authorized_keys 에 남은 이 키의 줄은 함께 지워지지 않습니다. 키를 지운 뒤에는 포탈이 그 줄을 거둘 수 없으니, 필요하면 키 보안 › 서버에서 키 거두기를 먼저 하세요.</p>}
            <Otp value={kact.otp} onChange={(x) => setKact({ ...kact, otp: x })} />
            <div className="ssa-acts">
              <button className="btn danger" type="button" disabled={busy} onClick={async () => {
                // OTP 는 본문으로(주소 쿼리는 앞단 프록시 · 브라우저 기록에 남는다 — 서버 reauth 는 본문을 먼저 본다 · 점검 E-15)
                const ok = await run(() => sendJson(`/settings/ssh-access/keys/${encodeURIComponent(kact.key.id)}`, 'DELETE', { otp: kact.otp }),
                  (r) => (r.pending ? pendingText(r, { what: `${kact.key.name} 삭제`, then: '지워집니다' }) : `${kact.key.name} 을 지웠습니다.`));
                if (ok) setKact(null); else setKact((x) => (x ? { ...x, otp: '' } : x));
              }}>삭제</button>
              <button className="btn" type="button" onClick={() => setKact(null)}>닫기</button>
            </div>
          </fieldset>
        )}
        {(inbox.length > 0 || v.inbox?.truncated > 0) && (
          <section className="ssa-sec">
            <h4>받은 키 — 폴더에 직접 넣은 파일 {inbox.length}개</h4>
            {v.inbox?.truncated > 0 && <p className="ssa-note" style={{ color: toneVar('warn') }}>파일이 너무 많아 {v.inbox.truncated}개는 읽지 않았습니다.</p>}
            <STable minWidth={600} className="ssa-t">
              <thead><tr><th>파일</th><th>상태</th><th>종류 · 지문</th><th data-nosort>동작</th></tr></thead>
              <tbody>{inbox.map((it) => (
                <tr key={it.id}>
                  <td data-sort={it.relPath}><code>{it.file}</code><div className="ssa-sub">{it.server ? `서버별 › ${it.server}` : '공통'} · {dateTime(it.mtime)}{it.loosePerm ? ' · 다른 계정이 읽을 수 있음' : ''}</div></td>
                  <td data-sort={INBOX_CODE_TEXT[it.code] || it.code}><Chip tone={it.code === 'ready' || it.needPassphrase ? 'warn' : 'bad'}>{INBOX_CODE_TEXT[it.code] || it.code}</Chip></td>
                  <td data-sort={it.fingerprint || ''}>{it.algo ? `${it.algo}${it.bits ? ` ${it.bits}` : ''} · ` : ''}{it.fingerprint ? <code>{shortFp(it.fingerprint)}</code> : <span className="ssa-sub">{it.reason || '—'}</span>}</td>
                  <td data-nosort><div className="ssa-acts">
                    <button className="btn btn-sm" type="button" disabled={busy || !(it.code === 'ready' || it.needPassphrase)} onClick={() => setAppr({ item: it, name: suggestKeyName(it), passphrase: '', features: [], otp: '' })}>승인</button>
                    <button className="btn btn-sm" type="button" disabled={busy || !it.sha} title={it.sha ? undefined : '내용을 읽지 못한 파일(너무 큼 · 링크 등)은 서버에서 직접 지우세요.'} onClick={() => setDisc({ item: it, otp: '' })}>지우기</button>
                  </div></td>
                </tr>
              ))}</tbody>
            </STable>
          </section>
        )}
        {disc && (
          <fieldset className="ssa-form">
            <legend>{disc.item.file} — 받은 키 파일 지우기</legend>
            <p className="ssa-note"><code>{disc.item.relPath}</code> · {disc.item.server ? `서버별 › ${disc.item.server}` : '공통'} · {dateTime(disc.item.mtime)}. 승인하지 않고 받는 곳에서 파일을 지웁니다 — 화면에서 본 뒤 파일 내용이 바뀌었으면 지우지 않습니다.</p>
            <Otp value={disc.otp} onChange={(x) => setDisc({ ...disc, otp: x })} />
            <div className="ssa-acts">
              <button className="btn danger" type="button" disabled={busy} onClick={async () => {
                const { item, otp } = disc;
                setDisc((x) => (x ? { ...x, otp: '' } : x));   // OTP 는 보낸 뒤 성공 · 실패와 무관하게 비운다
                const ok = await run(() => postJson('/settings/ssh-access/inbox/discard', { relPath: item.relPath, sha: item.sha || '', otp }), `${item.file} 를 지웠습니다.`);
                if (ok) setDisc(null);
              }}>지우기</button>
              <button className="btn" type="button" onClick={() => setDisc(null)}>닫기</button>
            </div>
          </fieldset>
        )}
        {appr && (
          <fieldset className="ssa-form">
            <legend>{appr.item.file} 승인 — 암호화 저장소로 옮기고 평문 파일은 지웁니다</legend>
            <label>키 이름 <input className="input" value={appr.name} onChange={(e) => setAppr({ ...appr, name: e.target.value })} maxLength={64} /></label>
            {appr.item.needPassphrase && <label>passphrase <input className="input" type="password" value={appr.passphrase} onChange={(e) => setAppr({ ...appr, passphrase: e.target.value })} autoComplete="new-password" /></label>}
            <div className="ssa-wide"><span className="ssa-sub">쓸 수 있는 기능</span><FeaturePicker catalog={v.features} value={appr.features} onChange={(f) => setAppr({ ...appr, features: f })} /></div>
            {!featuresChosen(appr.features) && <p className="ssa-note" style={{ color: toneVar('warn') }}>기능을 하나 이상 고르세요.</p>}
            <Otp value={appr.otp} onChange={(x) => setAppr({ ...appr, otp: x })} />
            <div className="ssa-acts">
              <button className="btn primary" type="button" disabled={busy || !appr.name || !featuresChosen(appr.features)} onClick={async () => {
                const ok = await run(() => postJson('/settings/ssh-access/inbox/approve', { relPath: appr.item.relPath, fingerprint: appr.item.fingerprint || '', sha: appr.item.sha || '', name: appr.name, passphrase: appr.passphrase, features: appr.features, otp: appr.otp }),
                  // 202 = 저장소에 ‘승인 대기’ 로 넣고(봉인 저장) 다른 설정 소유자의 승인을 기다린다 — 평문 파일은 그때도 바로 지운다.
                  (r) => `${r.pending ? pendingText(r, { what: `${appr.name} 등록`, then: '쓰입니다' }) : `${appr.name} — 승인했습니다.`}${r.plaintextLeft ? ` ⚠ 평문 파일을 지우지 못했습니다(${r.removeError || '사유 모름'}) — 서버에서 직접 지우세요.` : ' 받는 곳의 평문 파일은 지웠습니다.'}`);
                if (ok) setAppr(null); else setAppr((x) => ({ ...x, otp: '', passphrase: '' }));
              }}>승인</button>
              <button className="btn" type="button" onClick={() => setAppr(null)}>닫기</button>
            </div>
            <p className="ssa-note">파일이 놓인 폴더(법인 · 서버)가 키의 폴더가 됩니다. 화면에서 본 뒤 파일 내용이 바뀌었으면 승인하지 않습니다.</p>
          </fieldset>
        )}
        {canAdd && (
          <fieldset className="ssa-form">
            <legend>이 폴더에 키 등록</legend>
            <label>이름 <input className="input" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} placeholder="kr-ops-ed25519" maxLength={64} /></label>
            <label>회전 예정일 <input className="input" type="date" value={add.rotateAt} onChange={(e) => setAdd({ ...add, rotateAt: e.target.value })} /></label>
            <label className="ssa-wide">개인키(OpenSSH · PEM) <textarea className="input" rows={4} value={add.privateKey} onChange={(e) => setAdd({ ...add, privateKey: e.target.value })} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellCheck={false} autoComplete="off" /></label>
            <label>passphrase <input className="input" type="password" value={add.passphrase} onChange={(e) => setAdd({ ...add, passphrase: e.target.value })} autoComplete="new-password" /></label>
            <div className="ssa-wide"><span className="ssa-sub">쓸 수 있는 기능</span><FeaturePicker catalog={v.features} value={add.features} onChange={(f) => setAdd({ ...add, features: f })} /></div>
            {!featuresChosen(add.features) && <p className="ssa-note">쓸 기능을 하나 이상 고르세요 — 고른 기능만 이 키로 접속합니다.</p>}
            <Otp value={add.otp} onChange={(x) => setAdd({ ...add, otp: x })} />
            <div className="ssa-acts"><button className="btn primary" type="button" disabled={busy || !add.name || !add.privateKey || !featuresChosen(add.features) || v.policyMode !== 'encrypted'} onClick={async () => {
              const body = { name: add.name, privateKey: add.privateKey, passphrase: add.passphrase, rotateAt: add.rotateAt || undefined, folderCorp: node.corp, folderServer: node.kind === 'server' ? node.server : '', features: add.features, otp: add.otp };
              // 개인키 · passphrase · OTP 는 보낸 뒤 성공 · 실패와 무관하게 비운다(입력 칸 위생 — 실패하면 다시 붙여 넣는다).
              setAdd((x) => ({ ...x, privateKey: '', passphrase: '', otp: '' }));
              const ok = await run(() => postJson('/settings/ssh-access/keys', body), (r) => (r.pending ? pendingText(r, { what: `${body.name} 등록`, then: '쓰입니다' }) : `${body.name} 을 등록했습니다.`));
              if (ok) setAdd(blankAdd);
            }}>등록</button></div>
            {v.guards?.twoPersonActive === true && <p className="ssa-note">두 사람 승인이 켜져 있습니다 — 등록하면 ‘승인 대기’ 로 들어가고, 다른 설정 소유자가 승인한 뒤에야 쓰입니다(그 전에는 서버에서 고를 수도 없습니다).</p>}
            <p className="ssa-note">ed25519 권장 · RSA {unitText(v.rsaMinBits || null, ' 비트')} 미만 · DSA 는 받지 않습니다. 개인키는 암호화해 저장하고 화면 · API · 백업에는 지문 · 공개키만 나갑니다.</p>
          </fieldset>
        )}
      </div>
    </div>
  );
}

/* ── 쓰는 기능(시안 ④) ─────────────────────────────────────────────── */
function FeaturesTab({ v }) {
  const keys = (v.keys || []).filter((k) => k.status === 'active');
  // 키 저장소를 못 읽었으면 허용한 키 수는 모른다(0 이 아니다 — 점검 E-11)
  const cnt = (n) => (v.storeUnreadable ? '—' : n);
  return (
    <section className="ssa-sec">
      <h4>SSH 공용 접속을 쓰는 기능</h4>
      <STable minWidth={760} className="ssa-t">
        <thead><tr><th>기능</th><th>무엇을 하나</th><th className="right">허용한 키</th><th className="right">예전 방식 키(모든 기능)</th></tr></thead>
        <tbody>{(v.features || []).map((f) => (
          <tr key={f.id}><td data-sort={f.label}><b>{f.label}</b>{f.ready === false && <div><Chip tone="muted">다음 단계 — 아직 접속하지 않음</Chip></div>}</td><td className="ssa-sub">{f.note}</td>
            <td className="right" data-sort={v.storeUnreadable ? '' : keys.filter((k) => (k.features || []).includes(f.id)).length}>{cnt(keys.filter((k) => (k.features || []).includes(f.id)).length)}</td>
            <td className="right" data-sort={v.storeUnreadable ? '' : keys.filter((k) => k.features == null).length}>{cnt(keys.filter((k) => k.features == null).length)}</td></tr>
        ))}</tbody>
      </STable>
      <p className="ssa-note">모든 기능이 같은 한 곳(서버 고정 키 → 법인 기본 키 → 비밀번호)에서 계정을 받습니다. 키마다 ‘쓸 수 있는 기능’ 에 없는 기능은 그 키로 접속하지 않습니다. 로그인이 거부되면 그 기능이 그 서버의 주기 접속을 멈춥니다(기능마다 따로 — 계정 잠금 방지).</p>
      <p className="ssa-note">GPU 게스트 수집 등 자체 계정을 쓰는 다른 기능을 이 공용 접속으로 옮기는 단추는 다음 단계에서 붙입니다.</p>
    </section>
  );
}

/* ── 키 보안(시안 ⑤) ───────────────────────────────────────────────── */
function SecurityTab({ v, corpName, reload, say, me = '' }) {
  const [use, loadUse] = useLoad('/settings/ssh-access/usage?limit=100');
  const [chg, loadChg] = useLoad('/settings/ssh-access/changes?limit=200');
  const [stopF, setStopF] = useState({ corp: '', reason: '', otp: '' });
  const [busy, setBusy] = useState(false);
  // v3.10.0 — 승인 대기(두 사람 승인) · 보호 장치 · 서버에서 키 거두기
  const [act, setAct] = useState(null);   // 승인 · 돌려보내기 창 — { id, approve, note, otp }(요청 본문은 항상 지금 읽은 목록에서 다시 찾는다)
  const g = v.guards || {};
  const guardsKnown = typeof g.twoPerson === 'boolean' && typeof g.serverRestrict === 'boolean' && !g.unreadable;
  const [gd, setGd] = useState({ twoPerson: g.twoPerson === true, serverRestrict: g.serverRestrict === true });
  const [gOtp, setGOtp] = useState('');
  // 다시 읽어 서버 값이 바뀌면 편집값을 그 값으로 맞춘다(저장 전 편집을 낡은 값 위에 두지 않는다).
  useEffect(() => { setGd({ twoPerson: g.twoPerson === true, serverRestrict: g.serverRestrict === true }); }, [g.twoPerson, g.serverRestrict]);
  const [rv, setRv] = useState({ corp: '', keyId: '', once: '', otp: '' });
  // 거두기 작업 — 도는 것을 보다가 끝나면 기록을 다시 읽는다(이미 끝난 작업에 다시 붙은 것이면 다시 읽지 않는다).
  const kj = useKeyJob((_job, { wasRunning }) => { if (wasRunning) { loadChg(); loadUse(); } });
  // 탭을 떠났다 오거나 화면을 다시 열어도 마지막 거두기 작업(진행 중 · 끝난 지 얼마 안 된 것)의 진행 · 결과를 이어 본다(점검 E-2 — 서버 v.jobs.revoke).
  const lastRevoke = v.jobs?.revoke?.id || '';
  useEffect(() => { if (lastRevoke && lastRevoke !== kj.id && !kj.running) kj.start(lastRevoke, [], { own: false }); }, [lastRevoke]);   // eslint-disable-line react-hooks/exhaustive-deps -- 서버가 알려 준 작업 id 가 바뀔 때만 다시 붙는다
  const { pending: apprPending, done: apprDone } = splitApprovals(v.approvals);
  const actReq = act ? apprPending.find((r) => r.id === act.id) || null : null;
  const actOwn = isOwnRequest(actReq, me);
  const decide = async () => {
    if (!actReq) return;
    const { approve } = act;
    setBusy(true);
    try {
      // 승인은 화면에서 본 요청 지문(digest)을 돌려보낸다 — 그 사이 요청이 달라졌으면 서버가 거절한다.
      const r = must(await postJson(`/settings/ssh-access/approvals/${encodeURIComponent(actReq.id)}/${approve ? 'approve' : 'reject'}`,
        approve ? { digest: actReq.digest, note: act.note, otp: act.otp } : { note: act.note, otp: act.otp }));
      // 실행은 됐는데 결과를 승인 기록에 적지 못했으면(recordFailed — 점검 C-8) 그 사실을 밝힌다(확인 톤).
      say(approve ? `${actReq.title || actReq.label || actReq.kind} — 승인했고 실행됐습니다.${actReq.kind === 'ssh-key-rotate' ? ` ${rotateDoneText(r.result)}.` : ''}${recordFailedText(r)}`
        : `${actReq.title || actReq.label || actReq.kind} — ${r.request?.status === 'cancelled' ? '요청을 취소했습니다.' : '돌려보냈습니다.'}`, approve && r.recordFailed ? 'warn' : 'ok');
      setAct(null);
    } catch (e) {
      // 승인은 기록됐는데 실행이 실패한 경우(요청은 ‘실행 실패’ 로 끝난다 — 서버가 실행 결과 result 를 함께 준다) — 승인 실패와 다르게 말한다.
      // 사전 검사 거절(자기 승인 403 · 지문 불일치 · 처리됨 409 · 승인 기록 못 읽음 503)은 실행 전이라 서버 사유만 보인다.
      const b = e?.body || {};
      const ran = b.request?.status === 'failed' || (!!b.result && typeof b.result === 'object');
      const part = rotatePartialText(b.result?.partial);
      say(ran ? `승인은 됐지만 실행하지 못했습니다 — ${errText(e)}${part ? ` ${part}` : ''}${b.recordFailed ? ' 실행 실패를 승인 기록에도 적지 못했습니다.' : ''} 다시 하려면 새로 요청해야 합니다.` : errText(e), 'bad');
      if (ran) setAct(null); else setAct((x) => (x ? { ...x, otp: '' } : x));
    } finally { setBusy(false); reload(); loadChg(); }
  };
  const gdiff = guardDiff(g, gd);
  const guardReq = apprPending.find((r) => r.kind === 'ssh-guard-change') || null;
  const saveGuards = async () => {
    const diff = guardDiff(g, gd);
    if (!diff.changed) return;
    // 바꾼 것만 보낸다(낡은 화면의 ‘그대로’ 값이 다른 사람의 변경을 되돌리지 않게).
    const patch = Object.fromEntries([...diff.on.map((k) => [k, true]), ...diff.off.map((k) => [k, false])]);
    setBusy(true);
    try {
      const r = must(await putJson('/settings/ssh-access/guards', { ...patch, otp: gOtp }));
      say(guardSaveText(r, diff), r.pending ? pendingTone(r) : 'ok');
      // 끄는 변경이 승인 대기로 갔으면 스위치는 지금 값(켬)으로 돌려 둔다 — 꺼진 것처럼 보이지 않게.
      if (r.pending) setGd((d) => ({ ...d, ...Object.fromEntries(diff.off.map((k) => [k, true])) }));
      reload(); loadChg();
    } catch (e) {
      // 켜는 것은 먼저 적용되고 끄는 쪽이 실패할 수 있다(partial.applied — 점검 E-7) — 켠 것은 켰다고 말하고 화면을 다시 읽는다.
      const applied = Array.isArray(e?.body?.partial?.applied) && e.body.partial.applied.length > 0;
      say(guardFailText(e?.body, errText(e)), applied ? 'warn' : 'bad');
      if (applied) { reload(); loadChg(); }
    } finally { setGOtp(''); setBusy(false); }
  };
  const doRevoke = async () => {
    const body = { keyId: rv.keyId, corp: rv.corp, otp: rv.otp };
    if (rv.once) body.oncePassword = rv.once;
    // 1회 비밀번호 · OTP 는 보낸 뒤 성공 · 실패와 무관하게 비운다.
    setRv((x) => ({ ...x, once: '', otp: '' }));
    setBusy(true);
    try {
      const r = must(await postJson('/settings/ssh-access/key-revoke', body));
      kj.start(r.jobId, r.skipped);
      say(revokeStartText(r), 'warn');
    } catch (e) {
      const sk = e?.body?.skipped;
      // 409 busy(다른 거두기 작업이 도는 중 — OTP 를 쓰기 전에 거절) — 그 작업의 진행을 아래에 붙여 보인다.
      const busyJob = e?.body?.code === 'busy' && e?.body?.jobId;
      if (busyJob) kj.start(e.body.jobId, [], { own: false });
      say(`${errText(e)}${busyJob ? ' 진행 중인 작업을 아래에 보입니다.' : ''}${Array.isArray(sk) && sk.length ? ` — ${sk.slice(0, 8).map((x) => x.name).join(' · ')}${sk.length > 8 ? ` 외 ${sk.length - 8}` : ''}` : ''}`, 'bad');
    } finally { setBusy(false); }
  };
  const items = sortedCheck(v.check?.items);
  const scan = async () => {
    setBusy(true);
    try { must(await postJson('/settings/ssh-access/scan', {})); say('점검을 시작했습니다 — 키가 많으면 몇십 초 걸립니다. 잠시 뒤 다시 읽기를 누르세요.', 'ok'); }
    catch (e) { say(errText(e), 'bad'); } finally { setBusy(false); }
  };
  const doStop = async (resume) => {
    setBusy(true);
    try {
      let r;
      // 재개 OTP 는 본문으로(주소 쿼리는 앞단 프록시 · 브라우저 기록에 남는다 — 점검 E-15)
      if (resume) r = must(await sendJson(`/settings/ssh-access/corps/${encodeURIComponent(stopF.corp)}/stop`, 'DELETE', { otp: stopF.otp }));
      else r = must(await postJson(`/settings/ssh-access/corps/${encodeURIComponent(stopF.corp)}/stop`, { reason: stopF.reason, otp: stopF.otp }));
      // 재개는 ‘다시 여는’ 방향 — 두 사람 승인이 켜져 있으면 202(승인 대기)로 온다. 그때는 재개했다고 말하지 않는다.
      // 중지는 엣지 서버 수 · 등록부를 못 읽어 법인으로만 걸렸는지를 그대로 알린다(stopDoneText — 점검 E-8).
      if (r?.pending) say(pendingText(r, { what: `${corpName(stopF.corp)} 키 사용 재개`, then: '재개됩니다' }), pendingTone(r));
      else if (resume) say(`${corpName(stopF.corp)} — 키 사용을 재개했습니다.`, 'ok');
      else say(stopDoneText(r, corpName(stopF.corp)), r?.registryUnreadable ? 'bad' : 'warn');
      setStopF({ corp: '', reason: '', otp: '' }); reload(); loadChg();
    } catch (e) { say(errText(e), 'bad'); setStopF((x) => ({ ...x, otp: '' })); } finally { setBusy(false); }
  };
  const [relOtp, setRelOtp] = useState('');
  // 다시 읽기 — 상태 파일(손상을 사람이 고친 뒤) · 키 저장소(포탈 밖 변경을 사람이 확인한 뒤). 둘 다 OTP · 감사.
  const outside = items.some((i) => i.code === 'tampered' || i.code === 'added-outside');
  const doReload = async (which) => {
    setBusy(true);
    try {
      const r = must(await postJson(`/settings/ssh-access/reload-${which}`, { otp: relOtp }));
      // 키 저장소 받아들이기는 두 사람 승인이 켜져 있으면 202(승인 대기)로 온다 — 아직 다시 읽지 않았다.
      if (r?.pending) say(pendingText(r, { what: '키 저장소 다시 읽기(포탈 밖 변경 받아들이기)', then: '디스크 내용이 새 기준이 됩니다' }), pendingTone(r));
      else say(which === 'state' ? '상태 파일을 다시 읽었습니다.' : `키 저장소를 다시 읽었습니다(키 ${unitText(r.keys, '개')}) — 디스크 내용이 새 기준입니다.`, 'ok');
      setRelOtp(''); reload(); loadChg();
    } catch (e) { say(errText(e), 'bad'); setRelOtp(''); } finally { setBusy(false); }
  };
  const stopSel = (v.corps || []).find((c) => c.id === stopF.corp)?.stop;
  const stopUnknown = !!stopSel?.unreadable;
  const stopped = stopUnknown ? null : stopSel;
  const changeRows = [
    ...(chg.resp?.events || []).filter((e) => !HIDDEN_EVENT_KINDS.includes(e.kind)).map((e) => ({ at: Number(e.at) || 0, what: EVENT_TEXT[e.kind] || e.kind, code: false, target: `${e.corp ? `${corpName(e.corp)} · ` : ''}${e.target || '—'}`, detail: eventDetail(e), who: e.by || '포탈' })),
    ...(chg.resp?.items || []).map((e) => ({ at: auditTime(e.at), what: e.action, code: true, target: e.target || '—', detail: '', who: e.user })),
  ].sort((a, b) => b.at - a.at);
  return (
    <div className="ssa-sec-wrap">
      <section className="ssa-sec">
        <div className="ssa-acts"><h4>키 점검</h4><span className="ssa-sub">마지막 {dateTime(v.check?.at)} · {v.scanEveryMinutes ? `${v.scanEveryMinutes}분마다` : '주기 모름'}</span><button className="btn btn-sm" type="button" disabled={busy} onClick={scan}>지금 점검</button><button className="btn btn-sm" type="button" onClick={() => { reload(); loadChg(); loadUse(); }}>다시 읽기</button></div>
        <ul className="ssa-check">{items.map((i, n) => (
          <li key={`${i.code}-${n}`}><Chip tone={LEVEL_TONE[i.level]}>{LEVEL_TEXT[i.level] || i.level}</Chip> <b>{i.title}</b>{i.detail ? <div className="ssa-sub">{i.detail}</div> : null}</li>
        ))}</ul>
      </section>
      <section className="ssa-sec">
        <div className="ssa-acts"><h4>승인 대기 — {v.approvalsUnreadable ? '읽지 못함' : `${apprPending.length}건`}</h4><span className="ssa-sub">두 사람 승인 — 요청한 사람이 아닌 설정 소유자가 본인 OTP 로 승인해야 실행됩니다 · 남은 시간은 화면을 읽은 시각({dateTime(v.at)}) 기준</span></div>
        {v.approvalsUnreadable && <p className="ssa-banner" style={{ color: toneVar('bad') }}>승인 기록 파일(approvals.json)을 읽지 못해 요청 · 승인을 받지 않습니다 — 손상 보존본(approvals.json.corrupt.*)을 확인하세요. 아래 목록은 비어 있는 것이 아니라 읽지 못한 것입니다.</p>}
        {!v.approvalsUnreadable && (
          <STable minWidth={920} className="ssa-t ssa-appr">
            <thead><tr><th>종류</th><th>대상</th><th>요청한 사람</th><th>요청 시각</th><th>남은 시간</th><th>상태</th><th data-nosort>동작</th></tr></thead>
            <tbody>
              {apprPending.map((r) => {
                const own = isOwnRequest(r, me);
                return (
                  <tr key={r.id}>
                    <td data-sort={r.label || r.kind}><b>{r.label || r.kind}</b></td>
                    <td data-sort={r.title || ''}>{r.title || '—'}{r.corp ? <div className="ssa-sub">{corpName(r.corp)}</div> : null}</td>
                    <td data-sort={r.requestedBy || ''}>{r.requestedBy || '—'}{own && <div><Chip>내 요청</Chip></div>}</td>
                    <td data-sort={r.requestedAt || ''}>{dateTime(r.requestedAt)}</td>
                    <td data-sort={r.expiresAt || ''}>{approvalRemaining(r.expiresAt, v.at)}</td>
                    <td data-sort={APPROVAL_STATUS_TEXT[r.status] || r.status}><Chip tone={APPROVAL_STATUS_TONE[r.status]}>{APPROVAL_STATUS_TEXT[r.status] || r.status}</Chip></td>
                    <td data-nosort>
                      <div className="ssa-acts">
                        <button className="btn btn-sm" type="button" disabled={busy || own} title={own ? '요청한 사람은 승인할 수 없습니다 — 다른 설정 소유자가 승인해야 합니다.' : undefined} onClick={() => setAct({ id: r.id, approve: true, note: '', otp: '' })}>승인</button>
                        <button className="btn btn-sm" type="button" disabled={busy} onClick={() => setAct({ id: r.id, approve: false, note: '', otp: '' })}>{own ? '요청 취소' : '돌려보내기'}</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!apprPending.length && <tr><td colSpan={7} className="ssa-sub">승인을 기다리는 요청이 없습니다.</td></tr>}
            </tbody>
          </STable>
        )}
        {act && actReq && (
          <fieldset className="ssa-form">
            <legend>{act.approve ? '승인' : actOwn ? '요청 취소' : '돌려보내기'} — {actReq.label || actReq.kind}</legend>
            <p className="ssa-note"><b>{actReq.title || '—'}</b> · 요청 {actReq.requestedBy || '—'} · {dateTime(actReq.requestedAt)} · 남은 시간 {approvalRemaining(actReq.expiresAt, v.at)}</p>
            {approvalDetail(actReq, corpName, v.features) && <p className="ssa-note">{approvalDetail(actReq, corpName, v.features)}</p>}
            <label>메모(선택) <input className="input" value={act.note} onChange={(e) => setAct({ ...act, note: e.target.value })} maxLength={300} /></label>
            <Otp value={act.otp} onChange={(x) => setAct({ ...act, otp: x })} />
            <div className="ssa-acts">
              <button className={`btn ${act.approve ? 'primary' : 'danger'}`} type="button" disabled={busy} onClick={decide}>{act.approve ? '승인하고 실행' : actOwn ? '요청 취소' : '돌려보내기'}</button>
              <button className="btn" type="button" onClick={() => setAct(null)}>닫기</button>
            </div>
            <p className="ssa-note">{act.approve ? '승인하면 바로 실행됩니다. 화면에서 본 요청 내용과 서버의 요청이 다르면 실행하지 않습니다 — 그때는 다시 읽은 뒤 승인하세요.'
              : actReq.kind === 'ssh-key-activate' ? '실행하지 않고 요청을 닫습니다 — 승인 대기 중인 키도 저장소에서 함께 지워집니다.' : '실행하지 않고 요청을 닫습니다.'}</p>
          </fieldset>
        )}
        {apprDone.length > 0 && (
          <>
            <div className="ssa-sub">끝난 요청 — 최근 {Math.min(10, apprDone.length)}건{apprDone.length > 10 ? `(읽어 온 ${apprDone.length}건 가운데 — 열을 눌러 정렬하면 그 순서의 앞 10건)` : ''}</div>
            <STable minWidth={920} className="ssa-t ssa-apprd" limit={10}>
              <thead><tr><th>종류</th><th>대상</th><th>요청</th><th>처리</th><th>상태</th><th>결과 · 메모</th></tr></thead>
              <tbody>{apprDone.map((r) => (
                <tr key={r.id}>
                  <td data-sort={r.label || r.kind}>{r.label || r.kind}</td>
                  <td data-sort={r.title || ''}>{r.title || '—'}</td>
                  <td data-sort={r.requestedAt || ''}>{r.requestedBy || '—'}<div className="ssa-sub">{dateTime(r.requestedAt)}</div></td>
                  <td data-sort={r.decidedAt || ''}>{r.decidedBy || '—'}<div className="ssa-sub">{dateTime(r.decidedAt)}</div></td>
                  <td data-sort={APPROVAL_STATUS_TEXT[r.status] || r.status}><Chip tone={APPROVAL_STATUS_TONE[r.status]}>{APPROVAL_STATUS_TEXT[r.status] || r.status}</Chip></td>
                  <td>{approvalOutcome(r) || '—'}</td>
                </tr>
              ))}</tbody>
            </STable>
          </>
        )}
      </section>
      <section className="ssa-sec">
        <div className="ssa-acts"><h4>보호 장치</h4><span className="ssa-sub">전 법인 공통 설정 · 바꾸려면 본인 OTP</span></div>
        {g.unreadable && <p className="ssa-banner" style={{ color: toneVar('bad') }}>상태 파일을 읽지 못해 보호 장치를 모두 켠 것으로 봅니다 — 지금은 바꿀 수 없습니다(먼저 아래에서 상태 파일을 다시 읽으세요).</p>}
        {!g.unreadable && !guardsKnown && <p className="ssa-banner" style={{ color: toneVar('bad') }}>보호 장치 설정을 받지 못했습니다 — 켬 · 끔을 모릅니다(다시 읽기를 누르세요).</p>}
        <ul className="ssa-guards">
          <li><span className="ssa-gs"><span className="ssa-lock">항상 켬</span></span><span className="ssa-gb"><b>개인키는 암호화 저장에서만 받음 · 내보내지 않음</b><span className="ssa-sub">자격증명 저장 방식이 암호화일 때만 새 로그인 키를 받습니다. 개인키는 화면 · 응답 · 로그 · 내려받기로 내보내지 않습니다(지문 · 공개키만).</span></span></li>
          <li><span className="ssa-gs"><span className="ssa-lock">항상 켬</span></span><span className="ssa-gb"><b>키 작업은 본인 OTP</b><span className="ssa-sub">등록 · 받은 키 승인 · 교체 · 삭제 · 서버에 넣기 · 거두기 · 요청 승인 · 이 화면의 설정 변경(진행 중인 키 작업 멈추기는 줄이는 방향이라 OTP 없이). 로그인(인증)을 끈 설치는 OTP 를 묻지 않고, OTP 를 쓰지 않는 계정(AD 등)은 설정 소유자이면 OTP 없이 통과합니다.</span></span></li>
          {GUARD_KEYS.map((k) => (
            <li key={k}>
              <span className="ssa-gs"><button type="button" role="switch" aria-checked={gd[k]} aria-label={GUARD_TEXT[k].label} className={`ssa-sw${gd[k] ? ' on' : ''}`} disabled={busy || !guardsKnown} onClick={() => setGd({ ...gd, [k]: !gd[k] })}><i /></button></span>
              <span className="ssa-gb">
                <span><b>{GUARD_TEXT[k].label}</b> {guardsKnown ? <Chip tone={g[k] ? 'ok' : 'warn'}>{g[k] ? '켬' : '끔'}</Chip> : <Chip>모름</Chip>}{guardsKnown && gd[k] !== g[k] && <Chip>저장 전 — {gd[k] ? '켬' : '끔'}으로 바꿈</Chip>}</span>
                <span className="ssa-sub">{GUARD_TEXT[k].note}</span>
                {k === 'twoPerson' && g.twoPerson === true && g.twoPersonActive === false && <span className="ssa-sub" style={{ color: toneVar('warn') }}>이 설치는 로그인(인증)을 꺼 두어 계정을 가를 수 없습니다 — 두 사람 승인이 적용되지 않고 본인 OTP 만으로 실행됩니다.</span>}
              </span>
            </li>
          ))}
        </ul>
        {gdiff.off.length > 0 && <p className="ssa-note" style={{ color: toneVar('warn') }}>두 사람 승인이 켜져 있으면 끄는 변경은 승인할 수 있는 다른 설정 소유자의 승인을 거쳐 꺼집니다(켜는 변경은 바로 적용됩니다). 설정 소유자 목록에 다른 계정이 있는데 지금 승인할 수 없는 상태(관리자 역할 · 전체 범위 · 로그인 수단이 필요)면 끄지 않고 사유를 보입니다 — 그 계정을 고치거나 목록에서 뺀 뒤 하세요. 다른 소유자가 아무도 없을 때만 본인 OTP 로 바로 꺼집니다.{gdiff.off.includes('twoPerson') ? ' 두 사람 승인을 끄면 키 등록 · 교체 · 삭제 · 사용 재개가 본인 OTP 만으로 실행됩니다.' : ''}{gdiff.off.includes('serverRestrict') ? ' 서버 쪽 제한을 끄면 앞으로 넣는 키 줄에 출발지 제한 · 포워딩 금지가 붙지 않습니다(이미 넣은 줄은 그대로).' : ''}</p>}
        {guardReq && <p className="ssa-note" style={{ color: toneVar('warn') }}>보호 장치 끄기 요청이 승인을 기다리고 있습니다 — {guardReq.title || '보호 장치 끄기'} · 요청 {guardReq.requestedBy || '—'}. 위 ‘승인 대기’ 에서 처리합니다.</p>}
        <div className="ssa-form ssa-inline">
          <Otp value={gOtp} onChange={setGOtp} />
          <div className="ssa-acts">
            <button className="btn primary" type="button" disabled={busy || !guardsKnown || !gdiff.changed} onClick={saveGuards}>보호 장치 저장</button>
            {gdiff.changed > 0 && <button className="btn" type="button" disabled={busy} onClick={() => setGd({ twoPerson: g.twoPerson === true, serverRestrict: g.serverRestrict === true })}>되돌리기</button>}
          </div>
        </div>
      </section>
      {(v.stateUnreadable || outside) && (
        <section className="ssa-sec">
          <h4>파일을 확인한 뒤 다시 읽기</h4>
          <p className="ssa-note">
            {v.stateUnreadable ? '상태 파일을 읽지 못해 모든 키 접속을 멈췄습니다. 손상 보존본(ssh-access-state.json.corrupt.*)을 보고 파일을 고친 뒤 다시 읽으세요. ' : ''}
            {outside ? '키 저장소 파일이 포탈 밖에서 바뀌었습니다. 누가 왜 바꿨는지 확인한 뒤에만 받아들이세요 — 받아들이면 디스크 내용이 새 기준이 되고, 바뀐 키도 다시 쓰입니다.' : ''}
          </p>
          <div className="ssa-form ssa-inline">
            <Otp value={relOtp} onChange={setRelOtp} />
            <div className="ssa-acts">
              {v.stateUnreadable && <button className="btn" type="button" disabled={busy} onClick={() => doReload('state')}>상태 파일 다시 읽기</button>}
              {outside && <button className="btn danger" type="button" disabled={busy} onClick={() => doReload('keystore')}>키 저장소 다시 읽기(받아들이기)</button>}
            </div>
          </div>
        </section>
      )}
      <section className="ssa-sec ssa-danger">
        <h4>긴급 조치 — 법인 키 사용 중지</h4>
        <p className="ssa-note">키가 샜다고 의심되면 그 법인의 키 접속을 바로 멈춥니다. 서버는 바꾸지 않습니다(이 노드가 그 법인 키로 접속하지 않을 뿐). 중지할 때 그 법인 서버 목록을 함께 적어 두므로 서버의 법인을 바꿔도 풀리지 않습니다. 비밀번호로 접속하는 서버는 멈추지 않고, 엣지가 수집하는 서버는 그 엣지의 키를 쓰므로 그 엣지 포탈에서 따로 중지합니다.</p>
        <div className="ssa-form ssa-inline">
          <label>법인 <Select sort={false} className="select select-sm" value={stopF.corp} onChange={(e) => setStopF({ ...stopF, corp: e.target.value })}>
            <option value="">선택</option>{(v.corps || []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.stop?.unreadable ? ' — 상태 모름' : c.stop ? ' — 중지 중' : ''}</option>)}
          </Select></label>
          {!stopped && <label>사유 <input className="input" value={stopF.reason} onChange={(e) => setStopF({ ...stopF, reason: e.target.value })} maxLength={200} /></label>}
          <Otp value={stopF.otp} onChange={(x) => setStopF({ ...stopF, otp: x })} />
          <div className="ssa-acts">
            {stopUnknown ? <span className="ssa-sub">상태 파일을 읽지 못해 중지 · 재개를 할 수 없습니다(먼저 위에서 상태 파일을 다시 읽으세요).</span>
              : stopped ? <button className="btn" type="button" disabled={busy || !stopF.corp} onClick={() => doStop(true)}>사용 재개</button>
              : <button className="btn danger" type="button" disabled={busy || !stopF.corp} onClick={() => doStop(false)}>이 법인 키 사용 중지</button>}
          </div>
        </div>
        <p className="ssa-note">중지는 멈추는 방향이라 본인 OTP 만으로 바로 실행합니다. 재개는 다시 여는 방향이라, 두 사람 승인이 켜져 있으면 다른 설정 소유자가 승인한 뒤에 풀립니다.</p>
      </section>
      <section className="ssa-sec ssa-danger">
        <h4>긴급 조치 — 서버에서 키 거두기</h4>
        <p className="ssa-note">그 법인 서버마다 포탈이 넣은 그 키의 줄(표식이 붙은 줄)을 authorized_keys 에서 지웁니다. 멈추는 방향이라 두 사람 승인 없이 본인 OTP 만으로 바로 실행합니다. 같은 키를 넣는 키 로그인 설정 작업이 돌고 있으면 그 작업을 멈춥니다. 닿지 못한 서버 · 결과를 모르는 서버 · 한 번에 거두는 상한을 넘어 빠진 서버는 사유와 함께 결과에 남깁니다 — 사람이 직접 지웁니다. authorized_keys 가 심볼릭 링크이거나 읽기 · 쓰기가 막혀 있으면 건드리지 않고 실패로 적습니다. 사람이 직접 넣은 같은 키 줄(표식 없음)은 지우지 않고 수만 알려 줍니다. 엣지가 수집하는 서버는 그 엣지 포탈에서 거둡니다.</p>
        <div className="ssa-form ssa-inline">
          <label>법인 <Select sort={false} className="select select-sm" value={rv.corp} onChange={(e) => setRv({ ...rv, corp: e.target.value, keyId: '' })}>
            <option value="">선택</option>{(v.corps || []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.stop?.unreadable ? ' — 상태 모름' : c.stop ? ' — 중지 중' : ''}</option>)}
          </Select></label>
          <label>거둘 키 <Select className="select select-sm" value={rv.keyId} disabled={!rv.corp} onChange={(e) => setRv({ ...rv, keyId: e.target.value })}>
            <option value="">선택</option>{corpKeyOptions(v, rv.corp).map((k) => <option key={k.id} value={k.id}>{keyOptionLabel(k, corpName)}</option>)}
          </Select></label>
          <label>이번 한 번만 쓸 비밀번호(선택) <input className="input" type="password" value={rv.once} onChange={(e) => setRv({ ...rv, once: e.target.value })} autoComplete="new-password" /></label>
          <Otp value={rv.otp} onChange={(x) => setRv({ ...rv, otp: x })} />
          <div className="ssa-acts">
            <button className="btn danger" type="button" disabled={busy || kj.running || !rv.corp || !rv.keyId} onClick={doRevoke}>{kj.running ? '거두는 중…' : '서버에서 키 거두기'}</button>
          </div>
          {rv.once && <p className="ssa-note" style={{ color: toneVar('warn') }}>{revokeOnceWarn(v.registryUnreadable || !rv.corp ? null : (v.servers || []).filter((s) => (s.vcenterId || '') === rv.corp && !s.agent).length)}</p>}
        </div>
        <p className="ssa-note">키는 그 법인 폴더 · 미분류 키만 보입니다(퇴역 키 포함). 비밀번호를 비우면 저장된 인증으로 접속합니다 — 법인 키 사용 중지 중에는 키로 접속하지 않으므로, 키로만 접속하던 서버는 이번 한 번만 쓸 비밀번호를 넣어야 닿습니다(저장하지 않습니다). 새 키로 바꾸려면 키 폴더 탭의 ‘교체…’ 를 씁니다.</p>
        <KeyJobResult key={kj.id} kj={kj} kind="key-revoke" />
      </section>
      <section className="ssa-sec">
        <div className="ssa-acts"><h4>키 사용 기록</h4><span className="ssa-sub">접속 결과 · {unitText(use.resp?.retainDays, '일')} 보관 · 주기 성공은 묶음 횟수로만</span><button className="btn btn-sm" type="button" onClick={loadUse}>다시 읽기</button></div>
        {use.err && <ErrorBox error={use.err} />}
        {use.resp?.loadFailed && <p className="ssa-note" style={{ color: toneVar('warn') }}>사용 기록 파일이 손상돼 보존본을 남기고 새로 시작했습니다 — 그 이전 기록은 이 화면에 없습니다.</p>}
        {use.resp && (
          <STable minWidth={860} className="ssa-t" limit={100}>
            <thead><tr><th>시각</th><th>키</th><th>서버</th><th>기능</th><th>시작</th><th>결과</th></tr></thead>
            <tbody>{(use.resp.recent || []).map((e, i) => (
              <tr key={`${e.at}-${i}`}><td data-sort={e.at}>{dateTime(e.at)}</td><td data-sort={e.keyName}><code>{e.keyName || shortFp(e.fingerprint)}</code></td><td>{e.server}</td><td>{e.feature}</td>
                <td>{e.by || (e.trigger === 'manual' ? '사람(수동)' : '주기')}</td>
                <td data-sort={USE_CODE_TEXT[e.code] || e.code}><Chip tone={e.ok ? 'ok' : 'bad'}>{USE_CODE_TEXT[e.code] || e.code}</Chip>{e.unusual ? <Chip tone="warn">{UNUSUAL_TEXT[e.unusual] || e.unusual}</Chip> : null}</td></tr>
            ))}{!(use.resp.recent || []).length && <tr><td colSpan={6} className="ssa-sub">기록이 없습니다.</td></tr>}</tbody>
          </STable>
        )}
        <p className="ssa-note">‘처음 쓰인 서버 · 기능’ 은 표시만 합니다(막지 않습니다). 이 기록은 이 노드가 키로 접속한 것만입니다 — 엣지가 수집하는 서버는 그 엣지 포탈에 있습니다.</p>
      </section>
      <section className="ssa-sec">
        <div className="ssa-acts"><h4>키 변경 기록</h4><span className="ssa-sub">감사 로그(화면에서 지울 수 없음 — 보관 상한을 넘으면 오래된 줄부터 정리됩니다) · 키 보안 사건(개수 상한 — 덜 중요한 것부터 밀려납니다) · 이 브라우저 시각</span><button className="btn btn-sm" type="button" onClick={loadChg}>다시 읽기</button></div>
        {chg.err && <ErrorBox error={chg.err} />}
        {chg.resp && (
          <STable minWidth={860} className="ssa-t ssa-chg" limit={300}>
            <thead><tr><th>시각</th><th>무엇</th><th>대상</th><th>누가</th></tr></thead>
            <tbody>
              {changeRows.map((e, i) => (<tr key={`c-${e.at}-${i}`}><td data-sort={e.at}>{dateTime(e.at)}</td><td data-sort={e.what}>{e.code ? <code>{e.what}</code> : e.what}</td><td data-sort={e.target}>{e.target}{e.detail ? <div className="ssa-sub">{e.detail}</div> : null}</td><td>{e.who}</td></tr>))}
              {!changeRows.length && <tr><td colSpan={4} className="ssa-sub">기록이 없습니다.</td></tr>}
            </tbody>
          </STable>
        )}
      </section>
      <section className="ssa-sec">
        <h4>이 보호가 막지 못하는 것</h4>
        <ul className="ssa-list">
          <li>키를 암호화하는 열쇠는 이 포탈 서버 안에 있습니다. 서버의 관리자 권한이 넘어가면 키도 함께 열립니다 — 저장 암호화는 백업 · 사본 · 디스크 유출을 막는 보호입니다.</li>
          <li>접속하는 동안에는 개인키가 포탈 프로세스 메모리에 풀려 있습니다.</li>
          <li>키 파일이 포탈 밖에서 바뀌었는지는 {v.scanEveryMinutes ? `${v.scanEveryMinutes}분` : '주기'}마다 확인합니다 — 그 사이의 변경은 다음 점검에서 잡힙니다. 키 원문과 지문을 함께 바꾼 경우는 ‘포탈이 마지막으로 쓴 내용과 다름’ 으로만 압니다 — 포탈이 그 사이 재시작하면 디스크 내용이 새 기준이 되어 잡히지 않습니다.</li>
          <li>두 사람 승인은 설정 소유자 계정이 둘 이상일 때만 뜻이 있습니다. 한 사람이 계정 둘을 가지면 우회됩니다 — 계정 관리의 문제로 남습니다.</li>
          <li>서버 쪽 제한은 서버의 SSH 가 그 표기를 지키는 한에서만 유효합니다. 서버 관리자가 키 줄에서 제한을 빼도 포탈은 서버를 주기적으로 읽지 않습니다 — 그 서버의 ‘서버에 들어 있는 키’ 를 다시 읽은 뒤에야 키 점검이 알립니다.</li>
          <li>이 포탈이 서버에 닿는 주소가 접속마다 다르면(NAT 등) 출발지 제한 때문에 키 접속이 막힐 수 있습니다. 키 로그인 설정의 확인 단계에서 막히면 넣은 줄을 지우고 사유를 적습니다(제한을 자동으로 빼지 않습니다). 설정한 뒤에 주소가 바뀌면 줄은 서버에 그대로 남고, 그 서버의 주기 수집이 인증 거부로 멈춥니다(계정 잠금 방지 — 자동 재시도 없음).</li>
          <li>출발지 제한은 서버가 본 주소 기준입니다 — 같은 NAT 뒤의 다른 장비에서 오는 접속은 가르지 못합니다.</li>
        </ul>
      </section>
    </div>
  );
}
