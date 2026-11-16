/**
 * FocusMonAuditInstall.jsx — 디스크 점검 탭의 **자동 설치 · 설치 디렉터리**(v3.17.0 · 사용자 "디스크 점검하는 프로그램을 자동으로 설치하는 기능 추가" ·
 * "설치 디렉터리를 사전에 사용자가 지정하는 기능 추가" · 시안 ⑱ · docs/design/focus-mon/README.md §21 · '진행해' = 컨펌 기본값).
 *
 *  · 값 · 판정은 응답 `/tools/focus-mon/audit` 의 `install`(서버가 서버마다 설치 계정을 해석 — 비밀 없음)과 행의 `ready.dir` · `lastInstall` 그대로.
 *  · 디렉터리 글자 검사는 입력하는 동안 바로(서버와 같은 규칙 — 시험 대조) · 저장 · 설치는 본인 OTP 코드와 함께(서버 reauth 가 마지막 게이트).
 *  · 진행은 디스크 점검 탭의 작업 줄(`audit/jobs` 5초)이 그대로 보여 준다 — 표의 ‘지금 상태’ 칸 · 끝나면 탭이 다시 읽는다.
 */
import React, { useMemo, useState } from 'react';
import { postJson, putJson } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { Seg } from './FocusMonBulk.jsx';
import { DASH, nodeText, corpText, rowStatus, whenText } from './focusMonAuditText.js';
import { dirIssue, DIR_ISSUE_TEXT, pathsPreview, dirLabel, credText, SRC_TEXT, installResultText, installRowState, skipReason } from './focusMonAuditInstallText.js';

const errText = (e) => e?.body?.reason || e?.body?.detail || e?.message || '요청 실패';

function DirCard({ ins, onSaved, setMsg }) {
  const cur = ins.settings?.dir;
  const [mode, setMode] = useState(cur ? 'custom' : 'default');
  const [dir, setDir] = useState(cur || '');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const want = mode === 'default' ? '' : dir;
  const issue = mode === 'custom' ? (dir === '' ? 'empty' : dirIssue(dir)) : null;
  const same = cur !== null && want === cur;
  const P = issue ? null : pathsPreview(want, ins.defaultPaths);
  const save = async () => {
    setBusy(true);
    try {
      // 응답을 버리지 않는다(audit2727e 스윕 — 200 에 ok:false 가 실려 와도 '저장했습니다' 라고 하지 않게) · 문구에는 서버가 실제로 저장한 값을 쓴다
      const r = await putJson('/tools/focus-mon/audit/install-dir', { dir: want, otp });
      if (!r || r.ok !== true || typeof r.dir !== 'string') { setMsg?.({ tone: 'bad', text: r?.reason || '설치 디렉터리를 저장하지 못했습니다 — 응답을 확인하지 못했습니다.' }); return; }
      setOtp(''); setMsg?.({ tone: 'ok', text: `설치 디렉터리를 ${dirLabel(r.dir)} 로 저장했습니다 — 이미 설치된 서버는 그대로 동작하고 ‘옛 디렉터리’ 로 보입니다.` });
      onSaved?.();
    } catch (e) { setMsg?.({ tone: 'bad', text: errText(e) }); } finally { setBusy(false); }
  };
  return (
    <div className="fm-card fm-pad fm-col">
      <div className="fm-row fm-between"><h3 className="fm-h3">설치 디렉터리 — 설치하기 전에 정해 둡니다</h3><span className="fm-dim">포탈 전체에 하나</span></div>
      {ins.settings?.error ? <div className="fm-ban w">설치 디렉터리 설정을 읽지 못했습니다({ins.settings.error}) — 자동 설치 · 설치 파일 받기를 막아 두었습니다. 손상 보존본을 확인하세요.</div> : null}
      <div className="fm-row"><Seg label="설치 디렉터리" value={mode} onChange={setMode} options={[['default', '기본 경로'], ['custom', '직접 지정']]} /><span className="fm-dim">지금: <span className="fm-mono">{dirLabel(cur)}</span></span></div>
      {mode === 'custom' ? (
        <label className="fm-col"><span className="fm-lbl">설치 디렉터리(절대 경로)</span>
          <input className="fm-input fm-mono" value={dir} maxLength={140} spellCheck={false} autoComplete="off" placeholder="예: /opt/dvc/disk-audit" onChange={(e) => setDir(e.target.value)} />
        </label>
      ) : null}
      {mode === 'custom' ? <div className={`fm-note ${issue ? 'bad' : 'ok'}`}>{issue === 'empty' ? '디렉터리를 적어 주세요.' : issue ? `저장할 수 없습니다 — ${DIR_ISSUE_TEXT[issue] || issue}` : '규칙에 맞습니다. 대상 서버에서는 소유자 · 권한 · 심링크 · 마운트를 다시 검사합니다.'}</div> : null}
      <dl className="fm-kv">
        <dt>점검 프로그램</dt><dd className="fm-mono">{P ? P.program : DASH}</dd>
        <dt>실행 파일</dt><dd className="fm-mono">{P ? P.wrapper : DASH}</dd>
        <dt>sudoers</dt><dd><span className="fm-mono">{ins.sudoers}</span> <span className="fm-dim">— 옮길 수 없습니다(sudo 가 읽는 곳)</span></dd>
      </dl>
      <div className="fm-row">
        <label className="fm-row"><span className="fm-lbl">본인 OTP</span><input className="fm-input fm-mono" style={{ width: 110 }} inputMode="numeric" maxLength={8} autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value)} /></label>
        <button type="button" className="fm-btn pri" disabled={busy || !!issue || same || !!ins.settings?.error} onClick={save}>저장</button>
        {same ? <span className="fm-dim">지금 설정과 같습니다.</span> : null}
      </div>
      <ul className="fm-list">
        <li>글자는 포탈(저장 · 명령 만들 때) · 엣지(작업 받을 때) · 설치 파일(대상 서버에서 root 로 돌기 전에) 세 곳에서 검사합니다.</li>
        <li>대상 서버에서 그 디렉터리와 위쪽 폴더가 모두 root 소유 · 그룹과 다른 계정이 쓸 수 없음 · 심링크 아님 · 실행 금지(noexec) 마운트 아님 · 로컬 파일시스템인지 봅니다. 하나라도 아니면 설치하지 않습니다.</li>
        <li>바꿔도 <b>이미 설치된 서버는 그대로 동작</b>합니다(서버마다 설치된 곳을 기억 · ‘옛 디렉터리’). 다시 설치하면 새 곳으로 옮기고, 옛 파일은 포탈 판본과 같을 때만 지웁니다.</li>
        <li>‘설치 파일 받기’(손으로 설치)에도 같은 디렉터리가 들어갑니다.</li>
      </ul>
    </div>
  );
}

/** 자동 설치 — 서버 표 · 확인 창(OTP) · 결과. */
export function InstallPanel({ d, rows, now, setMsg, reload }) {
  const ins = d.install;
  const dir = ins?.settings?.dir ?? null;
  const [picked, setPicked] = useState([]);
  const [picks, setPicks] = useState({});
  const [confirm, setConfirm] = useState(false);
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const credOf = (r) => ins?.cred?.[r.id] || { state: 'error' };
  const info = useMemo(() => new Map(rows.map((r) => [r.id, installRowState(r, credOf(r), dir)])), [rows, ins, dir]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ins) return null;
  const labels = d.labels;
  const toggle = (id) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const chosen = rows.filter((r) => picked.includes(r.id));
  const todo = chosen.filter((r) => !skipReason(r, credOf(r), dir, picks[r.id]));
  const skipped = chosen.filter((r) => skipReason(r, credOf(r), dir, picks[r.id]));
  const canCount = rows.filter((r) => info.get(r.id)?.can).length;
  const start = async () => {
    if (!todo.length) return;
    setBusy(true);
    try {
      const accounts = Object.fromEntries(todo.filter((r) => picks[r.id]).map((r) => [r.id, picks[r.id]]));
      const r = await postJson('/tools/focus-mon/audit/install', { ids: todo.map((x) => x.id), accounts, otp });
      const bad = (r?.results || []).filter((x) => !x.ok);
      setMsg?.({ tone: bad.length && !r.started ? 'bad' : 'ok', text: `자동 설치: 시작 ${r?.started ?? 0}대${bad.length ? ` · 시작하지 않음 ${bad.length}대(${[...new Set(bad.map((x) => x.reason))].slice(0, 2).join(' / ')})` : ''}` });
      setOtp(''); setConfirm(false); setPicked([]);
      reload?.();
    } catch (e) { setMsg?.({ tone: 'bad', text: errText(e) }); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="fm-grid2">
        <DirCard key={String(dir)} ins={ins} onSaved={reload} setMsg={setMsg} />
        <div className="fm-card fm-pad fm-col">
          <h3 className="fm-h3">설치에 쓰는 계정 — SSH 공용 접속에 등록한 키</h3>
          <ul className="fm-list">
            <li>설정 › 보안 › SSH 공용 접속의 키마다 ‘쓸 수 있는 기능’ 에 <b>디스크 점검 프로그램 설치(root)</b> 가 있습니다. 이 기능을 <b>직접 켠 키만</b> 씁니다 — 기능 목록이 없는 예전 키는 자동 설치에 쓰지 않습니다.</li>
            <li>서버마다 이렇게 찾습니다 — ① 같은 주소 · 포트로 등록된 SSH 공용 접속 서버의 자격 ② 없으면 그 법인의 공통 계정 가운데 ‘설치’ 를 켠 키(하나면 그것 · 여럿이면 줄에서 고릅니다).</li>
            <li>엣지가 맡은 서버는 <b>그 엣지 포탈에 등록한 키</b>로 엣지가 설치합니다. 중앙은 키를 받지 않고 계정 이름과 가능 여부만 봅니다.</li>
            <li>설치 계정은 그 서버에서 <b>비밀번호 없이 sudo</b> 할 수 있거나 root 여야 합니다. 저장된 비밀번호를 sudo 에 넣지 않습니다.</li>
            <li>설치 계정은 설치할 때 한 번만 씁니다. 평소 수집 · 점검은 지금처럼 수집 계정(일반 계정)과 sudoers 한 줄(그 실행 파일 하나 · 인자 없이)로 돕니다.</li>
          </ul>
        </div>
      </div>
      <div className="fm-card fm-col">
        <div className="fm-row fm-between fm-pad-x fm-pad-t">
          <div className="fm-row"><h3 className="fm-h3">자동 설치</h3><span className="fm-dim">설치 디렉터리 <span className="fm-mono">{dirLabel(dir)}</span> · 노드마다 한 번에 {d.limits.installConcurrency}대 · 서버당 {d.limits.installTimeoutSec}초</span></div>
          <div className="fm-row">
            <span className="fm-lbl">고른 서버 {picked.length}대</span>
            <button type="button" className="fm-btn" disabled={!canCount} onClick={() => setPicked(rows.filter((r) => info.get(r.id)?.can).map((r) => r.id))}>설치할 수 있는 서버 모두 고르기({canCount})</button>
            <button type="button" className="fm-btn pri" disabled={!picked.length || busy} onClick={() => setConfirm(true)}>고른 서버에 설치</button>
          </div>
        </div>
        <STable className="fm-table fm-itable" minWidth={1060}>
          <thead><tr><th data-nosort /><th>서버</th><th>법인 · 담당 노드</th><th>지금 상태 · 설치된 곳</th><th>설치에 쓸 계정</th><th>자동 설치</th><th>마지막 설치</th><th data-nosort /></tr></thead>
          <tbody>{rows.map((r) => {
            const c = credOf(r); const ct = credText(c); const s = info.get(r.id); const st = rowStatus(r, now); const li = installResultText(r.lastInstall);
            return (
              <tr key={r.id} className={picked.includes(r.id) ? 'fm-sel' : ''}>
                <td data-nosort><input type="checkbox" checked={picked.includes(r.id)} aria-label={`${r.name} 고르기`} onChange={() => toggle(r.id)} /></td>
                <td data-sort={r.name}><span className="fm-st"><b className="fm-mono">{r.name}</b><small className="fm-mono">{r.host}</small></span></td>
                <td data-sort={corpText(r, labels)}><span className="fm-st"><span>{corpText(r, labels)}</span><small>{nodeText(r.agent)}</small></span></td>
                <td data-sort={st.label} className="fm-stcol" title={[st.sub, s.old ? '지금 설정과 다른 디렉터리 — 그대로 동작합니다(다시 설치하면 옮깁니다)' : ''].filter(Boolean).join(' · ')}><span className="fm-st"><span className="fm-row" style={{ gap: 6 }}><span className={`fm-badge ${st.tone}`}>{st.label}</span>{s.old ? <span className="fm-badge warn">옛 디렉터리</span> : null}</span>
                  {r.job && st.sub ? <small className="fm-brk">{st.sub}</small> : <small className="fm-mono fm-path">{s.at === null ? '설치된 곳 모름' : dirLabel(s.at)}</small>}</span></td>
                <td data-sort={c.acct || ''}>
                  {c.state === 'ambig' ? (
                    <Select sort={false} className="fm-input fm-sel-sm" aria-label={`${r.name} 설치 계정 고르기`} value={picks[r.id] || ''} onChange={(e) => setPicks({ ...picks, [r.id]: e.target.value })}>
                      <option value="">계정 고르기</option>
                      {(c.choices || []).map((x) => <option key={x.id} value={x.id}>{x.name} — {x.acct} · 키 {x.key}</option>)}
                    </Select>
                  ) : <span className="fm-st" title={c.src ? SRC_TEXT[c.src] : ''}><span>{c.acct ? c.acct : DASH}</span><small>{c.key ? `키 ${c.key}` : ''}{c.src ? ` · ${c.src === 'server' ? '서버 항목' : '법인 공통'}` : r.agent && !c.acct ? '엣지가 고름' : ''}</small></span>}
                </td>
                <td data-sort={ct.label} className="fm-stcol" title={ct.hint || ''}><span className="fm-st"><span className={`fm-badge ${ct.tone}`}>{ct.label}</span><small>{c.state === 'ok' || c.state === 'ambig' ? (s.settled ? '할 일 없음' : s.act) : '까닭은 표 아래'}</small></span></td>
                <td data-sort={r.lastInstall?.at || ''} title={li?.sub || ''}>{li ? <span className="fm-st"><span className={`fm-badge ${li.tone}`}>{li.label}</span><small>{whenText(r.lastInstall.at, now)}{r.lastInstall.acct ? ` · ${r.lastInstall.acct}` : ''}</small></span> : <span className="fm-dim">{DASH}</span>}</td>
                <td data-nosort className="fm-r"><button type="button" className={`fm-btn sm ${s.can ? 'pri' : ''}`} disabled={!s.can || busy} onClick={() => { setPicked([r.id]); setConfirm(true); }}>{s.settled ? '준비됨' : s.at === null ? '설치' : '다시 설치'}</button></td>
              </tr>
            );
          })}</tbody>
        </STable>
        {confirm ? (
          <div className="fm-pad fm-col fm-confirm">
            <div className="fm-row"><h3 className="fm-h3">설치 확인 — 무엇을 어디에 설치하나</h3><span className="fm-badge live">설치 {todo.length}대</span>{skipped.length ? <span className="fm-badge warn">건너뜀 {skipped.length}대</span> : null}</div>
            {todo.length ? (
              <STable className="fm-table" minWidth={760}>
                <thead><tr><th>서버</th><th>담당 노드</th><th>하는 일</th><th>설치에 쓸 계정</th><th>수집 계정</th></tr></thead>
                <tbody>{todo.map((r) => { const c = credOf(r); const ch = c.state === 'ambig' ? (c.choices || []).find((x) => x.id === picks[r.id]) : null; const s = info.get(r.id); return (
                  <tr key={r.id}><td className="fm-mono">{r.name}</td><td>{nodeText(r.agent)}</td><td><span className="fm-st"><span>{s.act}</span>{s.old ? <small>옛 파일은 포탈 판본과 같을 때만 지웁니다</small> : null}</span></td>
                    <td>{ch ? `${ch.acct} · 키 ${ch.key}` : c.acct ? `${c.acct}${c.key ? ` · 키 ${c.key}` : ''}` : r.agent ? '엣지가 고름' : DASH}</td><td className="fm-mono">{r.username || DASH}</td></tr>
                ); })}</tbody>
              </STable>
            ) : <div className="fm-dim">설치할 서버가 없습니다.</div>}
            {skipped.length ? <ul className="fm-list">{skipped.map((r) => <li key={r.id}><span className="fm-mono">{r.name}</span> — {skipReason(r, credOf(r), dir, picks[r.id])}</li>)}</ul> : null}
            <dl className="fm-kv">
              <dt>설치 디렉터리</dt><dd className="fm-mono">{dirLabel(dir)}</dd>
              <dt>서버에 생기는 것</dt><dd>파일 둘(프로그램 0644 · 실행 파일 0755 — root 소유) + sudoers 한 줄(0440). 패키지 · 서비스 · cron 은 건드리지 않습니다.</dd>
              <dt>수집 계정에 주는 것</dt><dd className="fm-mono fm-brk">{ins.paths?.sudoersLine || DASH}</dd>
            </dl>
            <div className="fm-row">
              <label className="fm-row"><span className="fm-lbl">본인 OTP</span><input className="fm-input fm-mono" style={{ width: 110 }} inputMode="numeric" maxLength={8} autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value)} /></label>
              <button type="button" className="fm-btn pri" disabled={!todo.length || busy} onClick={start}>설치 시작</button>
              <button type="button" className="fm-btn" onClick={() => { setConfirm(false); setOtp(''); }}>취소</button>
              <span className="fm-dim">누가 · 어느 서버에 · 어느 디렉터리로 설치했는지 감사 기록에 남습니다. 실패한 서버는 자동으로 다시 시도하지 않습니다.</span>
            </div>
          </div>
        ) : null}
        {(() => { const bad = [...new Set(rows.map((r) => credOf(r).state).filter((x) => x !== 'ok'))]; return bad.length ? <ul className="fm-list fm-pad-x">{bad.map((x) => <li key={x}><b>{credText({ state: x }).label}</b> — {credText({ state: x }).hint || '—'}</li>)}</ul> : null; })()}
        <span className="fm-dim fm-pad">설치는 맡은 노드가 설치 계정의 키로 접속 → 비밀번호 없는 sudo 확인 → 설치 파일(‘설치 파일 받기’ 와 같은 내용)을 설치 계정 홈에 잠깐 올려 root 로 한 번 실행 → 올린 파일 지움 → 수집 계정으로 준비 확인 순서입니다. 점검 실행은 자동으로 하지 않습니다. 서버가 돌려준 글은 남기지 않고 정해 둔 까닭 이름만 남깁니다.</span>
      </div>
    </>
  );
}
