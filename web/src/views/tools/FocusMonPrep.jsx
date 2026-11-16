/**
 * FocusMonPrep.jsx — 대상 · 키 탭의 **접속 자동 준비**(v3.18.0 · 사용자 "집중 모니터링을 하려면 SSH 로그인 정보를 추가해야 하는데, 지금 엣지에서 root 로
 * ssh 접근이 되니까 자동으로 설치하는 기능 만들어줘" · 시안 ⑲ · docs/design/focus-mon/README.md §22 · '진행해' = 컨펌 15항목 괄호 값).
 *
 *  · 값 · 판정은 응답 `/tools/focus-mon/prep`(서버가 서버마다 준비 계정 · 설치 계정을 해석 — 비밀 없음) 그대로 · 판정 코어는 `focusMonPrepText.prepRowState`.
 *  · 시작은 본인 OTP 코드와 함께(서버 reauth 가 마지막 게이트) · 진행은 `audit/jobs`(5초 — 작업이 있는 동안만) · 끝나면 다시 읽고 대상 표도 새로 읽는다.
 *  · 손으로 넣는 길(대상 · 키 탭의 복사용 명령)은 그대로 둔다.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { postJson } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { Seg } from './FocusMonBulk.jsx';
import { usePoll } from './focusMonPoll.js';
import { nodeText, whenText } from './focusMonAuditText.js';
import { DASH, prepCredText, loginText, prepRowState, prepResultText, keyLinePreview } from './focusMonPrepText.js';

const errText = (e) => e?.body?.reason || e?.body?.detail || e?.message || '요청 실패';
const corpLabel = (r) => (r.demo ? '데모' : r.corp?.name || '법인 없음');
const jobText = (j) => (j.state === 'running' ? `준비 중${j.phase ? ` — ${j.phase}` : ''}` : j.node ? (j.delivered ? `엣지 ${j.node} 에 보냄` : `엣지 ${j.node} 가 받아 가기를 기다림`) : '차례를 기다림');

export function PrepPanel({ setMsg, onDone }) {
  const q = usePoll('/tools/focus-mon/prep', null, 0);
  const d = q.data;
  const hasJobs = !!d && d.rows.some((r) => r.job);
  const jq = usePoll('/tools/focus-mon/audit/jobs', null, 5000, hasJobs);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState([]);
  const [picks, setPicks] = useState({});
  const [confirm, setConfirm] = useState(false);
  const [withAudit, setWithAudit] = useState(true);
  const [from, setFrom] = useState(false);
  const [age, setAge] = useState('never');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  // 작업 수가 줄면(끝난 작업이 있으면) 다시 읽고, 대상 표(키 로그인 칸)도 새로 읽는다
  const prevJobs = useRef(null);
  useEffect(() => {
    const n = jq.data?.jobs?.length;
    if (n == null) return;
    if (prevJobs.current != null && n < prevJobs.current) { q.reload(); onDone?.(); }
    prevJobs.current = n;
  }, [jq.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const jobsNow = useMemo(() => new Map((jq.fresh && jq.data?.jobs ? jq.data.jobs : []).map((j) => [j.id, j])), [jq.data, jq.fresh]);
  const rows = useMemo(() => (d ? d.rows.map((r) => (jobsNow.has(r.id) ? { ...r, job: jobsNow.get(r.id) } : r)) : []), [d, jobsNow]);
  const info = useMemo(() => new Map(rows.map((r) => [r.id, prepRowState(r, picks[r.id] || null)])), [rows, picks]);
  if (!d) return null; // 대상 · 키 탭의 나머지를 막지 않는다(조회 실패는 아래 안내 없이 숨김 — 대상 표가 등록부 오류를 따로 말한다)
  const now = Date.now();
  const nOk = rows.filter((r) => info.get(r.id)?.settled).length;
  const nCan = rows.filter((r) => info.get(r.id)?.can).length;
  const nNo = rows.length - nOk - nCan;
  const toggle = (id) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const chosen = rows.filter((r) => picked.includes(r.id));
  const todo = chosen.filter((r) => info.get(r.id)?.can);
  const skipped = chosen.filter((r) => !info.get(r.id)?.can);
  const nAud = withAudit ? todo.filter((r) => info.get(r.id)?.audit.can).length : 0;
  const auditDirBad = d.auditDir === null;
  const start = async () => {
    if (!todo.length) return;
    setBusy(true);
    try {
      const accounts = Object.fromEntries(todo.filter((r) => picks[r.id]).map((r) => [r.id, picks[r.id]]));
      const r = await postJson('/tools/focus-mon/prep', { ids: todo.map((x) => x.id), accounts, withAudit: withAudit && !auditDirBad, from, age, otp });
      if (!r || r.ok !== true) { setMsg?.({ tone: 'bad', text: r?.reason || '접속 준비를 시작하지 못했습니다.' }); return; }
      const bad = (r.results || []).filter((x) => !x.ok);
      setMsg?.({ tone: bad.length && !r.started ? 'bad' : 'ok', text: `접속 자동 준비: 시작 ${r.started ?? 0}대${bad.length ? ` · 시작하지 않음 ${bad.length}대(${[...new Set(bad.map((x) => x.reason))].slice(0, 2).join(' / ')})` : ''}` });
      setOtp(''); setConfirm(false); setPicked([]);
      q.reload();
    } catch (e) { setMsg?.({ tone: 'bad', text: errText(e) }); } finally { setBusy(false); }
  };
  return (
    <div className="fm-card fm-col fm-prep">
      <div className="fm-row fm-between fm-pad-x fm-pad-t">
        <div className="fm-row"><h3 className="fm-h3">접속 자동 준비 — 수집 계정 · 공개키</h3>
          <span className="fm-badge ok">연결됨 {nOk}</span><span className="fm-badge live">할 수 있음 {nCan}</span>{nNo ? <span className="fm-badge warn">못 함 {nNo}</span> : null}</div>
        <div className="fm-row">
          {open ? <>
            <span className="fm-lbl">고른 서버 {picked.length}대</span>
            <button type="button" className="fm-btn" disabled={!nCan} onClick={() => setPicked(rows.filter((r) => info.get(r.id)?.can).map((r) => r.id))}>준비할 수 있는 서버 모두 고르기({nCan})</button>
            <button type="button" className="fm-btn pri" disabled={!picked.length || busy} onClick={() => setConfirm(true)}>고른 서버 접속 준비</button>
          </> : null}
          <button type="button" className="fm-btn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '접기' : '서버별로 보기'}</button>
        </div>
      </div>
      <div className="fm-dim fm-pad-x">키 로그인이 안 되는 서버를 고르면, 그 서버를 맡은 노드가 SSH 공용 접속의 root 키(‘집중 모니터링 접속 준비(root)’ 를 직접 켠 키만)로 들어가
        수집 계정이 없으면 만들고 그 노드의 공개키 한 줄을 넣은 뒤 연결 시험까지 합니다. 엣지에서 root 로 쓰는 키는 <b>그 엣지 포탈의 SSH 공용 접속에 한 번</b> 등록하세요(포탈은 OS 의 ~root/.ssh 를 읽지 못합니다).</div>
      {open ? (
        <>
          <STable className="fm-table fm-itable" minWidth={1060}>
            <thead><tr><th data-nosort /><th>서버 · 수집 계정</th><th>법인 · 담당 노드</th><th>키 로그인(지금)</th><th>준비에 쓸 계정(root)</th><th>자동 준비</th><th>디스크 점검 함께</th><th data-nosort /></tr></thead>
            <tbody>{rows.map((r) => {
              const s = info.get(r.id); const c = r.cred || { state: 'error' }; const ct = prepCredText(c); const lt = loginText(r.login); const lr = prepResultText(r.lastPrep);
              return (
                <tr key={r.id} className={picked.includes(r.id) ? 'fm-sel' : ''}>
                  <td data-nosort><input type="checkbox" checked={picked.includes(r.id)} disabled={s.settled} aria-label={`${r.name} 고르기`} onChange={() => toggle(r.id)} /></td>
                  <td data-sort={r.name}><span className="fm-st"><b className="fm-mono">{r.name}</b><small className="fm-mono">{r.host} · {r.username || DASH}</small></span></td>
                  <td data-sort={corpLabel(r)}><span className="fm-st"><span>{corpLabel(r)}</span><small>{nodeText(r.agent)}</small></span></td>
                  <td data-sort={lt.label} className="fm-stcol" title={lt.sub}><span className="fm-st"><span className={`fm-badge ${lt.tone}`}>{lt.label}</span><small>{r.login?.at ? whenText(r.login.at, now) : lt.sub}</small></span></td>
                  <td data-sort={c.acct || ''}>
                    {c.state === 'ambig' ? (
                      <Select sort={false} className="fm-input fm-sel-sm" aria-label={`${r.name} 준비 계정 고르기`} value={picks[r.id] || ''} onChange={(e) => setPicks({ ...picks, [r.id]: e.target.value })}>
                        <option value="">계정 고르기</option>
                        {(c.choices || []).map((x) => <option key={x.id} value={x.id}>{x.name} — {x.acct} · 키 {x.key}</option>)}
                      </Select>
                    ) : <span className="fm-st"><span>{c.acct || DASH}</span><small>{c.key ? `키 ${c.key}` : ''}{c.src ? ` · ${c.src === 'server' ? '서버 항목' : '법인 공통'}` : r.agent && !c.acct ? '엣지가 고름' : ''}</small></span>}
                  </td>
                  <td data-sort={s.settled ? '0' : s.can ? '1' : '2'} className="fm-stcol" title={[ct.hint, lr?.sub].filter(Boolean).join(' · ')}>
                    <span className="fm-st">
                      {r.job ? <span className="fm-badge live">{jobText(r.job)}</span>
                        : <span className={`fm-badge ${s.settled ? '' : s.can ? 'ok' : 'warn'}`}>{s.settled ? '할 일 없음' : s.can ? '할 수 있음' : `못 함 — ${s.why}`}</span>}
                      <small>{lr ? `${lr.label} · ${whenText(r.lastPrep.at, now)}` : s.can ? (r.login?.kind ? '공개키를 넣습니다(계정이 없으면 만듭니다)' : '계정이 없으면 만들고 공개키를 넣습니다') : ''}</small>
                    </span>
                  </td>
                  <td data-sort={s.audit.can ? '0' : '1'} className="fm-stcol"><span className="fm-st">{!s.can ? <span className="fm-dim">{DASH}</span> : s.audit.can ? <span className="fm-badge live">함께 설치할 수 있음</span> : <span className="fm-badge">접속 준비만</span>}<small>{s.can && !s.audit.can ? s.audit.why : ''}</small></span></td>
                  <td data-nosort className="fm-r"><button type="button" className={`fm-btn sm ${s.can ? 'pri' : ''}`} disabled={!s.can || busy} onClick={() => { setPicked([r.id]); setConfirm(true); }}>{s.settled ? '준비됨' : '준비'}</button></td>
                </tr>
              );
            })}</tbody>
          </STable>
          <div className="fm-dim fm-pad-x">‘수집 계정’ 은 평소 집중 모니터링이 접속하는 일반 계정(등록할 때 적은 이름)이고, ‘준비에 쓸 계정’ 은 이번 한 번 root 로 계정 · 공개키를 넣는 데 쓰는 계정입니다.
            sshd 설정이 막고 있으면(AllowUsers · DenyUsers · 공개키 로그인 꺼짐 등) 아무것도 바꾸지 않고 멈춥니다. 실패한 서버는 자동으로 다시 시도하지 않습니다.</div>
        </>
      ) : null}
      {confirm ? (
        <div className="fm-pad fm-col fm-confirm">
          <div className="fm-row"><h3 className="fm-h3">확인 — 고른 서버에 계정 · 공개키를 넣습니다</h3><span className="fm-badge live">접속 준비 {todo.length}대</span>{skipped.length ? <span className="fm-badge warn">건너뜀 {skipped.length}대</span> : null}</div>
          {todo.length ? (
            <STable className="fm-table" minWidth={760}>
              <thead><tr><th>서버</th><th>담당 노드</th><th>준비에 쓸 계정(root)</th><th>수집 계정</th><th>넣을 공개키(지문)</th><th>디스크 점검</th></tr></thead>
              <tbody>{todo.map((r) => { const c = r.cred || {}; const ch = c.state === 'ambig' ? (c.choices || []).find((x) => x.id === picks[r.id]) : null; const a = info.get(r.id).audit; return (
                <tr key={r.id}><td className="fm-mono">{r.name}</td><td>{nodeText(r.agent)}</td>
                  <td>{ch ? `${ch.acct} · 키 ${ch.key}` : c.acct ? `${c.acct}${c.key ? ` · 키 ${c.key}` : ''}` : r.agent ? '엣지가 고름' : DASH}</td>
                  <td className="fm-mono">{r.username || DASH}</td><td className="fm-mono fm-brk">{r.keyFp || '노드 키 모름'}</td>
                  <td>{!withAudit ? '하지 않음' : auditDirBad ? '못 함 — 설치 디렉터리 설정을 읽지 못함' : a.can ? '이어서 설치' : `건너뜀 — ${a.why}`}</td></tr>
              ); })}</tbody>
            </STable>
          ) : <div className="fm-dim">준비할 수 있는 서버가 없습니다.</div>}
          {skipped.length ? <ul className="fm-list">{skipped.map((r) => <li key={r.id}><span className="fm-mono">{r.name}</span> — {info.get(r.id).settled ? '이미 키 로그인이 됩니다' : info.get(r.id).why}</li>)}</ul> : null}
          <dl className="fm-kv">
            <dt>디스크 점검 프로그램</dt><dd><label className="fm-row"><input type="checkbox" checked={withAudit} onChange={(e) => setWithAudit(e.target.checked)} /><span>디스크 점검 프로그램도 설치</span>
              <span className="fm-dim">{withAudit ? (auditDirBad ? '설치 디렉터리 설정을 읽지 못해 접속 준비만 합니다' : `${nAud}대는 키 로그인 확인 뒤 이어서 설치 · 나머지는 건너뜀`) : '접속 준비만 — 설치는 나중에 디스크 점검 탭에서'}</span></label></dd>
            <dt>접속 주소 제한</dt><dd className="fm-row"><Seg label="접속 주소 제한" value={from ? 'on' : 'off'} onChange={(v) => setFrom(v === 'on')} options={[['off', '제한 없음'], ['on', '이 노드 주소로 제한']]} />
              <span className="fm-dim">{from ? '대상 서버가 본 그 노드의 주소에서만 이 키를 받습니다 — 노드 주소가 바뀌면 키 로그인이 거부됩니다' : '손으로 넣는 안내와 같은 줄입니다'}</span></dd>
            <dt>만든 계정의 만료</dt><dd className="fm-row"><Seg label="만든 계정의 비밀번호 만료" value={age} onChange={setAge} options={[['never', '만료 없음'], ['default', '서버 기본값']]} />
              <span className="fm-dim">{age === 'never' ? '포탈이 만든 계정에만 — 비밀번호 만료가 오면 PAM 이 키 로그인을 막습니다(이 개발 환경 sshd 로 확인)' : '서버의 만료 정책을 따릅니다 — 만료 뒤 키 로그인이 거부될 수 있습니다'}</span></dd>
            <dt>넣는 줄(한 줄)</dt><dd className="fm-mono fm-brk">{keyLinePreview(from)}</dd>
            <dt>서버에 생기는 것</dt><dd>수집 계정이 없던 서버에 계정 하나(홈 · 비밀번호 칸 ‘*’{age === 'never' ? ' · 만료 없음' : ''}) · 그 계정의 ~/.ssh(700) · authorized_keys(600)에 위의 한 줄. 같은 키가 이미 있으면 넣지 않습니다.</dd>
            <dt>건드리지 않는 것</dt><dd>sshd 설정 · 방화벽 · 패키지 · 다른 계정 · 그 계정에 이미 있던 줄. 이미 있는 계정의 셸 · 그룹 · 비밀번호도 바꾸지 않습니다.</dd>
          </dl>
          <div className="fm-row">
            <label className="fm-row"><span className="fm-lbl">본인 OTP</span><input className="fm-input fm-mono" style={{ width: 110 }} inputMode="numeric" maxLength={8} autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value)} /></label>
            <button type="button" className="fm-btn pri" disabled={!todo.length || busy} onClick={start}>준비 시작</button>
            <button type="button" className="fm-btn" onClick={() => { setConfirm(false); setOtp(''); }}>취소</button>
            <span className="fm-dim">노드마다 한 번에 {d.limits.concurrency}대 · 서버당 {d.limits.timeoutSec}초(디스크 점검 설치는 따로). 누가 · 어느 서버에 · 어떤 선택으로 했는지 감사 기록에 남습니다.</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
