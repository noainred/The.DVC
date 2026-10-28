import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson } from '../api.js';
import { Loading, ErrorBox, StateBadge } from '../components/ui.jsx';
import { pollMinutesOf, pollIsOff, pollIntervalPatch } from './settingsFormDiff.js'; // v2.630 WEB2630-01
import { policyText, trustText, lastVerifyText, recentVerifyList, logIssueText, countsText, remoteLastGoodText, watchManifestWarn, overrideView, OVERRIDE_HOURS, overrideHoursLabel, TONE_COLOR } from './upgradeSignatureText.js'; // v2.730 S-10 · v2.736.1 기록
import { droppedSecretNote } from './droppedSecretText.js'; // v2.731(A3-01 ①): 주소가 바뀌어 저장 토큰을 폐기한 사실
// v2.736.2: 자동 업그레이드가 지금 동작하는가 · 왜 안 하는가 · 다음 확인은 언제인가(판정은 서버 autoState.js, 문장은 여기).
import { autoSummary, autoApplyRowText, noTickText, resultSummary, actionMsg, restoredNote, triggerText, remoteSourceLabel, runningScanWarning } from './upgradeAutoText.js';
import { readFailText } from './readFailText.js'; // v2.741(WEB-04): 재조회 실패는 화면을 지우지 않고 한 줄로 말한다

/**
 * v2.741(WEB-04): 상태 조회 실패의 표시. 확인·적용·설정 저장 뒤 다시 읽기(await load())가 실패하면 예전에는
 * `if (error)` 가 화면 전체를 ErrorBox 로 바꿔 **방금 받은 결과 문구와 상태 표·폼이 사라졌다**(5xx·네트워크 실패는 ServiceDown —
 * 네트워크 실패면 페이지 자동 새로고침까지). 첫 조회 실패(직전 상태 없음)만 화면 전체 오류이고, 그 밖에는 직전 값을 두고 배너로 말한다.
 * 반환: { full: 화면 전체 오류인가, banner: 배너 문구 | null }
 */
export function upgradeReloadView(status, error) {
  if (error == null || error === '') return { full: false, banner: null };
  if (status == null) return { full: true, banner: null };
  return { full: false, banner: readFailText('업그레이드 상태', error, { notMeaning: '아래는 직전에 읽은 값입니다', stale: true }) };
}

// 원격 소스 주소 비교(서버 upgrade/settings.js 와 같은 규칙 — 앞뒤 공백·끝 '/'·대소문자만 다른 주소는 같은 접속처).
const baseKey = (v) => {
  const t = String(v ?? '').trim().toLowerCase();
  let e = t.length;
  while (e > 0 && t.charCodeAt(e - 1) === 47) e--; // 끝 '/' — 정규식 /\/+$/ 는 긴 입력에서 O(n²)(v2.602 규약)
  return t.slice(0, e);
};

function Row({ label, children }) {
  return (
    <div className="flex between" style={{ padding: '8px 0', borderBottom: '1px solid rgba(36,48,73,.4)', gap: 12 }}>
      {/* 라벨은 줄바꿈하지 않는다 — 400px 에서 값이 길면 '정/책'·'마지막/검증' 처럼 글자 단위로 쪼개졌다(v2.736.1 스크린샷 판독) */}
      <span className="muted" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{label}</span>
      <span style={{ textAlign: 'right' }}>{children}</span>
    </div>
  );
}

function Toned({ v }) {
  return <span style={{ color: TONE_COLOR[v.tone] || 'inherit', whiteSpace: 'normal' }}>{v.text}</span>;
}

/**
 * v2.810 서명 확인 시한부 끄기·다시 켜기(사용자 요청 — 결정: 확인 불가만 허용 · 설정 소유자 + OTP 재인증 + 감사 · 시한 후 자동 복구).
 * 판정·권한은 서버(PUT /upgrade/signature-override) — 화면은 상태를 보이고 요청만 보낸다. 소유자가 아니면 서버 403 을 그대로 말한다.
 */
function OverrideControl({ sig, onChanged }) {
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState(24);
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const v = overrideView(sig);
  if (v.state === 'unknown' || v.state === 'na') return null;
  const send = async (body) => {
    setBusy(true); setMsg(null);
    try {
      const r = await putJson('/upgrade/signature-override', body);
      if (r && r.ok === false) setMsg({ ok: false, text: r.reason || '실패' });
      else { setMsg({ ok: true, text: body.verify ? '서명 확인을 다시 켰습니다.' : `서명 확인을 ${overrideHoursLabel(r.hours)} 동안 껐습니다.${r.warning ? ` ${r.warning}` : ''}` }); setOpen(false); setOtp(''); onChanged?.(); }
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };
  return (
    <div data-sig-override="" style={{ marginTop: 10, borderTop: '1px solid rgba(255,255,255,.08)', paddingTop: 10 }}>
      <div className="flex gap wrap" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="muted" style={{ flex: 'none' }}>화면 설정</span>
        <span style={{ color: TONE_COLOR[v.tone] || 'inherit', whiteSpace: 'normal', minWidth: 0, flex: '1 1 240px' }}>{v.text}</span>
        {v.state === 'off' && <button type="button" className="tab" disabled={busy} onClick={() => send({ verify: true })}>지금 다시 켜기</button>}
        {v.state === 'on' && !open && <button type="button" className="tab" disabled={busy} onClick={() => { setOpen(true); setMsg(null); }}>서명 확인 끄기…</button>}
      </div>
      {v.state === 'on' && open && (
        <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 8, background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.25)' }}>
          <div style={{ fontSize: 12, whiteSpace: 'normal', marginBottom: 8 }}>
            끄는 동안 서명을 확인할 수 없는 번들(manifest 없음·받지 못함)도 <b>경고 후 설치</b>합니다. 틀린 서명·회수된 키·버전이 맞지 않는 번들은 계속 거부합니다.
            시한이 지나면 자동으로 다시 켜집니다. 설정 소유자만 바꿀 수 있고 감사 로그에 남습니다.
          </div>
          <div className="flex gap wrap" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="muted">시한</span>
            {OVERRIDE_HOURS.map((h) => (
              <button key={h} type="button" className={`tab${hours === h ? ' active' : ''}`} aria-pressed={hours === h} onClick={() => setHours(h)}>{overrideHoursLabel(h)}</button>
            ))}
          </div>
          <div className="flex gap wrap" style={{ alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <span className="muted">본인 OTP 6자리</span>
            <input className="input" inputMode="numeric" autoComplete="one-time-code" placeholder="000000" maxLength={6} style={{ width: 120, letterSpacing: 3 }}
              value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} />
            <button type="button" className="login-btn" style={{ flex: 'none', padding: '6px 14px', background: 'var(--red)' }} disabled={busy} onClick={() => send({ verify: false, hours, otp: otp.trim() })}>
              {busy ? '저장 중…' : `${overrideHoursLabel(hours)} 동안 끄기`}
            </button>
            <button type="button" className="tab" disabled={busy} onClick={() => { setOpen(false); setOtp(''); }}>취소</button>
          </div>
        </div>
      )}
      {msg && <div style={{ marginTop: 6, fontSize: 12, whiteSpace: 'normal', color: msg.ok ? 'var(--green)' : 'var(--red)' }}>{msg.text}</div>}
    </div>
  );
}

/** 릴리스 서명 상태 — 짧게(정책·신뢰 키 수·마지막 검증). 판정은 서버, 문구는 upgradeSignatureText.js. */
function SignatureCard({ sig, onChanged }) {
  const pol = policyText(sig);
  const trust = trustText(sig);
  const last = lastVerifyText(sig);
  const recent = recentVerifyList(sig);
  const logIssue = logIssueText(sig);
  const counts = countsText(sig);
  return (
    <div className="card" style={{ marginBottom: 16, minWidth: 0 }}>
      <b>릴리스 서명</b>
      <div style={{ marginTop: 10 }}>
        <Row label="정책"><Toned v={pol} /></Row>
        <Row label="신뢰 공개키"><Toned v={trust} /></Row>
        <Row label="마지막 검증"><Toned v={last} /></Row>
      </div>
      {last.detail && (
        <div className="muted" style={{ marginTop: 6, fontSize: 11.5, whiteSpace: 'normal', wordBreak: 'break-word' }}>{last.detail}</div>
      )}
      {recent.length > 1 && (
        <details style={{ marginTop: 6, fontSize: 11.5 }}>
          <summary className="muted" style={{ cursor: 'pointer' }}>최근 검증 기록 {recent.length}건</summary>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {recent.map((r) => <li key={r.key} style={{ color: TONE_COLOR[r.tone] || 'inherit', whiteSpace: 'normal' }}>{r.text}</li>)}
          </ul>
        </details>
      )}
      {logIssue && <div style={{ marginTop: 4, fontSize: 11.5, color: TONE_COLOR.warn, whiteSpace: 'normal' }}>{logIssue}</div>}
      {counts && <div className="muted" style={{ marginTop: 4, fontSize: 11.5 }}>{counts}</div>}
      <OverrideControl sig={sig} onChanged={onChanged} />
      <div className="muted" style={{ marginTop: 6, fontSize: 11.5, whiteSpace: 'normal' }}>
        호스트 portal.env 의 UPGRADE_SIGNATURE_POLICY 가 정해져 있으면 그 값이 우선합니다 — docs/RELEASE-SIGNING.md 를 보세요.
      </div>
    </div>
  );
}

/** 자동 업그레이드 동작 — 상태 · 안 되는 이유와 조치 · 다음 확인 시각 · 마지막 자동 확인(v2.736.2). 서버가 auto 를 보내지 않으면 그리지 않는다. */
function AutoCard({ status }) {
  const a = autoSummary(status);
  if (!a) return null;
  return (
    <div className="card" style={{ marginBottom: 16, minWidth: 0 }}>
      <b>자동 업그레이드 동작</b>
      <div style={{ marginTop: 10 }}>
        <Row label="상태"><span style={{ color: TONE_COLOR[a.tone] || 'inherit', fontWeight: 600, whiteSpace: 'normal' }}>{a.label}</span></Row>
        <Row label="다음 자동 확인"><span style={{ whiteSpace: 'normal' }}>{a.next}</span></Row>
        <Row label="마지막 자동 확인">
          {a.tick
            ? <span style={{ color: TONE_COLOR[a.tickTone] || 'inherit', whiteSpace: 'normal' }}>{a.tick}</span>
            : <span className="muted" style={{ whiteSpace: 'normal' }}>{noTickText(status)}</span>}
        </Row>
      </div>
      {a.lines.length > 0 && (
        <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6 }}>
          {a.lines.map((l) => (
            <li key={l.code} style={{ whiteSpace: 'normal', wordBreak: 'break-word', marginBottom: 4 }}>
              <span style={{ color: l.code === 'check-failed' || l.code === 'apply-failed' ? TONE_COLOR.bad : TONE_COLOR.warn }}>{l.title}</span>
              {l.reason && <span className="muted"> — {l.reason}{l.when ? ` (${l.when})` : ''}</span>}
              {l.fix && <div className="muted" style={{ fontSize: 11.5 }}>{l.fix}</div>}
            </li>
          ))}
        </ul>
      )}
      {status.persist?.error && <div style={{ marginTop: 6, fontSize: 11.5, color: TONE_COLOR.warn, whiteSpace: 'normal' }}>{status.persist.error}</div>}
    </div>
  );
}

const blankForm = (s) => ({
  enabled: !!s.enabled,
  installDir: s.installDir || '',
  watchDir: s.watchDir || '',
  remoteBase: s.remoteBase || '',
  token: '',
  // v2.630 WEB2630-01: 0(끔)을 60 으로 채우지 않는다 — 서버 값을 그대로 보인다.
  pollMinutes: pollMinutesOf(s.pollIntervalMs),
  autoApply: !!s.autoApply,
});

export default function Upgrade() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const [form, setForm] = useState(null);
  const [detect, setDetect] = useState(null);
  const [pollInit, setPollInit] = useState(null); // 처음 채운 확인 주기(분) — 바뀌었을 때만 보낸다

  const load = async () => {
    try {
      const s = await fetchJson('/upgrade/status');
      setStatus(s);
      setForm((f) => f || blankForm(s));
      setPollInit((p) => (p == null ? pollMinutesOf(s.pollIntervalMs) : p));
      setError(null);
    } catch (e) { setError(e); } // 객체 그대로 — 403 은 권한 안내로(ErrorBox·readFailText 가 같은 정규화를 쓴다)
  };
  useEffect(() => { load(); }, []);

  const run = async (action, fn) => {
    setBusy(action); setMsg(null);
    try { const r = await fn(); setMsg({ action, r }); await load(); }
    catch (e) { setMsg({ action, r: { ok: false, reason: e.message } }); }
    finally { setBusy(null); }
  };

  // 서버가 자신의 실행 경로를 분석해 installDir 후보와 점검 근거(패키지 확인·쓰기 권한 등)를
  // 돌려준다. 값은 폼에만 채우고 저장은 사용자가 '설정 저장'으로 확정한다.
  const detectInstallDir = async () => {
    setBusy('detect'); setDetect(null);
    try {
      const d = await fetchJson('/upgrade/detect-install');
      setDetect(d);
      if (d.installDir) setForm((f) => ({ ...f, installDir: d.installDir }));
    } catch (e) { setDetect({ error: e.message }); }
    finally { setBusy(null); }
  };

  const saveSettings = async () => {
    setBusy('save'); setMsg(null);
    try {
      const body = {
        enabled: form.enabled,
        installDir: form.installDir.trim(),
        watchDir: form.watchDir.trim(),
        remoteBase: form.remoteBase.trim(),
        autoApply: form.autoApply,
      };
      // v2.596(감사 CLAMP2596-06): 빈 칸('')은 0(=확인 끔)이 아니라 미지정 — 보내지 않으면 서버가 이전 값을 유지한다.
      //   명시적 0 만 '끔' 으로 보낸다.
      // v2.630 WEB2630-01: 처음 값에서 바뀐 경우에만 보낸다 — 다른 칸만 고친 저장이 확인 주기를 건드리지 않게.
      const pollPatch = pollIntervalPatch(form.pollMinutes, pollInit);
      if (pollPatch !== undefined) body.pollIntervalMs = pollPatch;
      if (form.token) body.token = form.token;
      const r = await putJson('/upgrade/settings', body);
      // v2.731(A3-01 ①): 서버가 저장 토큰을 폐기했으면 '성공' 대신 그 사실을 말한다(폐기 사유는 서버 skipped 문구).
      //   putJson 은 400 을 던지지 않고 본문을 돌려준다 — 실패 사유(reason)도 함께 싣는다.
      setMsg({ action: 'save', r: { ok: r.ok, reason: r.reason, note: droppedSecretNote(r) } });
      setForm((f) => ({ ...f, token: '' }));
      if (r.ok && pollPatch !== undefined) setPollInit(form.pollMinutes);
      await load();
    } catch (e) { setMsg({ action: 'save', r: { ok: false, reason: e.message } }); }
    finally { setBusy(null); }
  };

  const reload = upgradeReloadView(status, error);
  if (reload.full) return <ErrorBox message={error} />;
  if (!status || !form) return <Loading />;

  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setChk = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.checked }));

  const check = status.lastCheck;
  // v2.731(A3-01 ①): 저장 토큰이 있는데 주소를 바꿨고 새 토큰을 넣지 않았다 → 저장하면 서버가 그 토큰을 폐기한다(미리 말한다).
  const tokenWillDrop = !!status.hasToken && !form.token && baseKey(form.remoteBase) !== baseKey(status.remoteBase);
  const result = status.lastResult;
  const newer = check && (check.watch?.available || check.remote?.available);
  // v2.736.2: 확인·적용은 저장된 '자동 업그레이드 사용' 을 따른다(서버 판정과 같은 값) — 체크만 바꾼 상태면 저장하라고 말한다.
  const savedEnabled = !!status.enabled;
  const lockTitle = savedEnabled ? undefined
    : form.enabled ? '설정을 저장한 뒤에 쓸 수 있습니다(저장된 설정에서는 자동 업그레이드 사용이 꺼져 있습니다)' : '자동 업그레이드 사용이 꺼져 있습니다';

  return (
    <>
      <div className="section-title">시스템 자동 업그레이드 (관리자)</div>
      {reload.banner && <div className="card" data-reload-fail="" style={{ marginBottom: 10, padding: '8px 12px', color: 'var(--amber)', fontSize: 12, whiteSpace: 'normal' }}>{reload.banner}</div>}

      {/* v2.808: 자동 적용 체크와 저장·확인·적용·재시작 버튼을 화면 맨 위로 — 설정 카드 끝까지 한참 내려가야 했다(사용자 요청).
          '설정 저장' 은 아래 '업그레이드 설정' 카드의 값도 함께 저장한다(폼은 하나). */}
      <div className="card" style={{ marginBottom: 16, minWidth: 0 }}>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={form.autoApply} onChange={setChk('autoApply')} />
          <span>새 버전 발견 시 <b>자동 적용 + 재시작</b> (끄면 확인만 하고 수동 적용)</span>
        </label>

        {/* v2.580: 버튼 4개가 한 줄에 고정돼 400px 에서 83px 가로 넘침(Chromium A/B 실측 — 기존 결함). 줄바꿈 허용. */}
        <div className="flex gap" style={{ marginTop: 14, flexWrap: 'wrap' }}>
          <button className="login-btn" style={{ flex: 'none', padding: '10px 18px' }} disabled={busy} onClick={saveSettings}>
            {busy === 'save' ? '저장 중…' : '설정 저장'}
          </button>
          {/* v2.736.2(리뷰 UPG-UI-05): 잠금은 **저장된** 설정 기준이다 — 서버는 저장값으로 판정한다(체크만 하고 누르면 409). */}
          <button className="logout-btn" style={{ padding: '10px 18px' }} disabled={busy || !savedEnabled} title={lockTitle}
            onClick={() => run('check', () => postJson('/upgrade/check'))}>
            {busy === 'check' ? '확인 중…' : '새 버전 확인'}
          </button>
          <button className="login-btn" style={{ flex: 'none', padding: '10px 18px', background: newer ? 'linear-gradient(135deg,var(--green),#16a34a)' : undefined }}
            disabled={busy || !savedEnabled || !newer} title={lockTitle} onClick={() => {
              // v2.737: 수동 적용은 실행 중 스캔을 기다리지 않는다 — 끊긴다는 사실을 먼저 말한다(재시작 뒤 자동 재개).
              const warn = runningScanWarning(status);
              if (warn && !window.confirm(warn)) return;
              run('apply', () => postJson('/upgrade/apply', { source: 'auto', restart: true }));
            }}>
            {busy === 'apply' ? '적용 중…' : '업그레이드 적용 + 재시작'}
          </button>
          <button className="logout-btn" style={{ padding: '10px 18px' }} disabled={busy}
            onClick={() => { const warn = runningScanWarning(status); if (warn && !window.confirm(warn)) return; run('restart', () => postJson('/upgrade/restart')); }}>
            {busy === 'restart' ? '재시작 중…' : '프로세스 재시작'}
          </button>
        </div>

        {/* v2.736.2: 문구는 actionMsg 하나 — 예전에는 '새 버전 확인' 응답에 ok 가 없어 확인이 성공해도 '실패' 로 보였다. */}
        {msg && (() => {
          const m = actionMsg(msg.action, msg.r);
          const good = m.ok && !m.warn;
          return (
            <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 8, whiteSpace: 'normal', wordBreak: 'break-word',
              background: good ? 'rgba(34,197,94,.12)' : 'rgba(245,158,11,.12)',
              color: good ? '#4ade80' : '#fbbf24', fontSize: 13 }}>
              <b>{m.label}</b> · {m.text}
            </div>
          );
        })()}
      </div>

      {/* v2.736.2: 자동 업그레이드가 왜 안 되는지·다음 확인은 언제인지 — 실행 줄 바로 아래에 말한다. */}
      <AutoCard status={status} />

      {/* 현재 상태 + 최근 확인 결과 — 화면 최상단(설정 위)에 먼저 보여준다. */}
      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <b>현재 상태</b>
          <div style={{ marginTop: 10 }}>
            <Row label="활성화"><StateBadge state={status.enabled ? 'CONNECTED' : 'POWERED_OFF'} /></Row>
            <Row label="현재 버전"><b className="tabular">v{status.version}</b></Row>
            <Row label="설치 경로">{status.installDir || <span className="muted">미설정</span>}</Row>
            <Row label="감시 대상(versions.json)">
              {status.remoteVersionsUrl
                ? <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, wordBreak: 'break-all' }}>{status.remoteVersionsUrl}</span>
                : <span className="muted">미설정</span>}
            </Row>
            <Row label="감시 폴더">{status.watchDir || <span className="muted">미설정</span>}</Row>
            <Row label="자동 적용"><span style={{ whiteSpace: 'normal' }}>{autoApplyRowText(status)}</span></Row>
          </div>
        </div>

        <div className="card">
          <b>최근 확인 결과</b>
          {!check && <div className="muted" style={{ padding: 12 }}>아직 확인하지 않았습니다.</div>}
          {check && (
            <div style={{ marginTop: 10 }}>
              <Row label="확인 시각">
                <span style={{ whiteSpace: 'normal' }}>{new Date(check.at).toLocaleString('ko-KR')}
                  {triggerText(check.trigger) && <span className="muted"> · {triggerText(check.trigger)}</span>}
                  {restoredNote(check) && <span className="badge gray" style={{ marginLeft: 6 }}>{restoredNote(check)}</span>}
                </span>
              </Row>
              {check.watch && <Row label="감시 폴더">{check.watch.available
                ? <b style={{ color: 'var(--green)' }}>새 버전 v{check.watch.version}</b>
                : <span className="muted">최신</span>}</Row>}
              {watchManifestWarn(check.watch) && (
                <div data-watch-manifest="" style={{ fontSize: 12, padding: '4px 0', whiteSpace: 'normal', color: TONE_COLOR.warn }}>{watchManifestWarn(check.watch)}</div>
              )}
              {check.remote && <Row label={remoteSourceLabel(check.remote.source)}>{check.remote.available
                ? <b style={{ color: 'var(--green)' }}>새 버전 v{check.remote.latest}</b>
                : <span className="muted" style={{ whiteSpace: 'normal' }}>{check.remote.error ? `오류: ${check.remote.error}` : `최신 (v${check.remote.latest || '?'})`}</span>}</Row>}
              {/* v2.730 I-08: 원격 확인이 실패했을 때 직전 정상 확인(참고용 — 설치에는 쓰지 않는다). */}
              {check.remote && remoteLastGoodText(check.remote) && (
                <div className="muted" style={{ fontSize: 11.5, padding: '4px 0', whiteSpace: 'normal' }}>{remoteLastGoodText(check.remote)}</div>
              )}
              <Row label="업그레이드 가능">{newer ? <span className="badge green">예</span> : <span className="badge gray">아니오</span>}</Row>
            </div>
          )}
        </div>
      </div>

      {/* v2.730 S-10: 릴리스 서명 — 정책·신뢰 공개키·마지막 검증. v2.810: 시한부 끄기만 화면에서(소유자 + OTP) — 그 밖은 호스트 portal.env · docs/RELEASE-SIGNING.md. */}
      <SignatureCard sig={status.signature} onChanged={load} />

      {/* Editable settings */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="flex between" style={{ marginBottom: 12 }}>
          <b>업그레이드 설정</b>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={form.enabled} onChange={setChk('enabled')} />
            <span>자동 업그레이드 사용</span>
          </label>
        </div>

        <div className="spec-grid">
          <label style={{ gridColumn: '1 / -1' }}>설치 경로 (installDir) *
            <div className="flex gap">
              <input className="input" style={{ flex: 1 }} value={form.installDir} onChange={setF('installDir')} placeholder="/opt/vmware-portal/app" />
              <button type="button" className="logout-btn" style={{ flex: 'none', whiteSpace: 'nowrap', padding: '0 14px' }}
                disabled={busy} onClick={detectInstallDir} title="서버가 자신의 실행 경로를 분석해 설치 경로를 채웁니다">
                {busy === 'detect' ? '감지 중…' : '서버에서 자동 감지'}
              </button>
            </div>
            {detect && (detect.error
              ? <div style={{ marginTop: 6, fontSize: 12, color: '#fbbf24' }}>감지 실패: {detect.error}</div>
              : (
                <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.7 }}>
                  <div className="muted">{detect.source} 기준: <b style={{ color: 'var(--text)' }}>{detect.installDir}</b>
                    {detect.ok ? '' : ' — 일부 점검 미통과(아래 확인)'}</div>
                  {(detect.checks || []).map((c) => (
                    <div key={c.key} style={{ color: c.ok ? 'var(--green)' : '#fbbf24' }}>{c.ok ? '✓' : '⚠'} {c.label}</div>
                  ))}
                  {detect.envInstallDir && (
                    <div className="muted">참고: 환경변수 UPGRADE_INSTALL_DIR={detect.envInstallDir} (감지값과 다름)</div>
                  )}
                </div>
              ))}
          </label>
        </div>

        <div className="settings-group">
          <div className="settings-group-title">🌐 인터넷 업그레이드 (원격 모니터링)</div>
          <div className="spec-grid">
            <label style={{ gridColumn: '1 / -1' }}>원격 소스 URL (versions.json 디렉터리)
              <input className="input" value={form.remoteBase} onChange={setF('remoteBase')}
                placeholder="비워 두면 원격 확인을 하지 않습니다 · 예: https://<사내 미러>/downloads" />
            </label>
            <label>토큰 (사설 레포)
              <input className="input" type="password" value={form.token} onChange={setF('token')}
                placeholder={status.hasToken ? (tokenWillDrop ? '주소를 바꾸면 저장된 토큰은 폐기됩니다' : '저장됨 (비우면 유지)') : '선택'} />
              {tokenWillDrop && <span style={{ fontSize: 11.5, color: '#fbbf24', display: 'block', marginTop: 4, whiteSpace: 'normal' }}>
                원격 소스 주소가 바뀌어 저장된 토큰은 새 주소로 보내지 않습니다 — 이 주소에 토큰이 필요하면 다시 입력하세요.</span>}
            </label>
            <label>확인 주기 (분, 0=끔 · 1~10080분 — 범위 밖은 서버가 맞춥니다)
              <input className="input" type="number" min="0" max="10080" value={form.pollMinutes} onChange={setF('pollMinutes')} />
              {pollIsOff(form.pollMinutes) && <span className="muted" style={{ fontSize: 11.5, marginLeft: 6 }}>끔 — 백그라운드 확인을 하지 않습니다</span>}
            </label>
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-group-title">📁 수동 업그레이드 (로컬 감시 폴더)</div>
          <div className="spec-grid">
            <label style={{ gridColumn: '1 / -1' }}>감시 폴더 (watchDir) — 여기에 <code>vmware-portal-&lt;버전&gt;.tar.gz</code> 를 넣으면 적용
              <input className="input" value={form.watchDir} onChange={setF('watchDir')} placeholder="/opt/vmware-portal/incoming" />
            </label>
          </div>
        </div>

        <div className="muted" style={{ marginTop: 12, fontSize: 12, whiteSpace: 'normal' }}>바꾼 값은 화면 맨 위의 ‘설정 저장’ 버튼으로 저장합니다.</div>
      </div>

      {result && (
        <div className="card" style={{ marginTop: 16 }}>
          <b>최근 적용 결과</b>
          {resultSummary(result) && (
            <div style={{ marginTop: 8, fontSize: 13, whiteSpace: 'normal', wordBreak: 'break-word', color: TONE_COLOR[resultSummary(result).tone] || 'inherit' }}>
              {resultSummary(result).text}
            </div>
          )}
          <pre style={{ marginTop: 10, fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}

      <div className="muted" style={{ marginTop: 12, fontSize: 12 }}>
        적용 후 새 코드를 로드하려면 재시작이 필요합니다(자동 적용 시 자동 재시작). 더 새 버전만 적용되며 기존 코드는 자동 백업되어 롤백할 수 있습니다.
      </div>
    </>
  );
}
