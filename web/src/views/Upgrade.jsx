import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson } from '../api.js';
import { Loading, ErrorBox, StateBadge } from '../components/ui.jsx';
import { pollMinutesOf, pollIsOff, pollIntervalPatch } from './settingsFormDiff.js'; // v2.630 WEB2630-01
import { policyText, trustText, lastVerifyText, countsText, remoteLastGoodText, TONE_COLOR } from './upgradeSignatureText.js'; // v2.730 S-10
import { droppedSecretNote } from './droppedSecretText.js'; // v2.731(A3-01 ①): 주소가 바뀌어 저장 토큰을 폐기한 사실

// 원격 소스 주소 비교(서버 upgrade/settings.js 와 같은 규칙 — 앞뒤 공백·끝 '/'·대소문자만 다른 주소는 같은 접속처).
const baseKey = (v) => {
  const t = String(v ?? '').trim().toLowerCase();
  let e = t.length;
  while (e > 0 && t.charCodeAt(e - 1) === 47) e--; // 끝 '/' — 정규식 /\/+$/ 는 긴 입력에서 O(n²)(v2.602 규약)
  return t.slice(0, e);
};

function Row({ label, children }) {
  return (
    <div className="flex between" style={{ padding: '8px 0', borderBottom: '1px solid rgba(36,48,73,.4)' }}>
      <span className="muted">{label}</span>
      <span style={{ textAlign: 'right' }}>{children}</span>
    </div>
  );
}

function Toned({ v }) {
  return <span style={{ color: TONE_COLOR[v.tone] || 'inherit', whiteSpace: 'normal' }}>{v.text}</span>;
}

/** 릴리스 서명 상태 — 짧게(정책·신뢰 키 수·마지막 검증). 판정은 서버, 문구는 upgradeSignatureText.js. */
function SignatureCard({ sig }) {
  const pol = policyText(sig);
  const trust = trustText(sig);
  const last = lastVerifyText(sig);
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
      {counts && <div className="muted" style={{ marginTop: 4, fontSize: 11.5 }}>{counts}</div>}
      <div className="muted" style={{ marginTop: 6, fontSize: 11.5, whiteSpace: 'normal' }}>
        서명 정책은 화면에서 바꿀 수 없습니다 — 호스트의 portal.env 와 docs/RELEASE-SIGNING.md 를 보세요.
      </div>
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
    } catch (e) { setError(e.message); }
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

  if (error) return <ErrorBox message={error} />;
  if (!status || !form) return <Loading />;

  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setChk = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.checked }));

  const check = status.lastCheck;
  // v2.731(A3-01 ①): 저장 토큰이 있는데 주소를 바꿨고 새 토큰을 넣지 않았다 → 저장하면 서버가 그 토큰을 폐기한다(미리 말한다).
  const tokenWillDrop = !!status.hasToken && !form.token && baseKey(form.remoteBase) !== baseKey(status.remoteBase);
  const result = status.lastResult;
  const newer = check && (check.watch?.available || check.remote?.available);

  return (
    <>
      <div className="section-title">시스템 자동 업그레이드 (관리자)</div>

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
            <Row label="자동 적용">{status.autoApply ? '예' : '아니오'}{status.pollIntervalMs ? ` · ${Math.round(status.pollIntervalMs / 60000)}분 주기` : ''}</Row>
          </div>
        </div>

        <div className="card">
          <b>최근 확인 결과</b>
          {!check && <div className="muted" style={{ padding: 12 }}>아직 확인하지 않았습니다.</div>}
          {check && (
            <div style={{ marginTop: 10 }}>
              <Row label="확인 시각">{new Date(check.at).toLocaleString('ko-KR')}</Row>
              {check.watch && <Row label="감시 폴더">{check.watch.available
                ? <b style={{ color: 'var(--green)' }}>새 버전 v{check.watch.version}</b>
                : <span className="muted">최신</span>}</Row>}
              {check.remote && <Row label="원격(GitHub)">{check.remote.available
                ? <b style={{ color: 'var(--green)' }}>새 버전 v{check.remote.latest}</b>
                : <span className="muted">{check.remote.error ? `오류: ${check.remote.error}` : `최신 (v${check.remote.latest || '?'})`}</span>}</Row>}
              {/* v2.730 I-08: 원격 확인이 실패했을 때 직전 정상 확인(참고용 — 설치에는 쓰지 않는다). */}
              {check.remote && remoteLastGoodText(check.remote) && (
                <div className="muted" style={{ fontSize: 11.5, padding: '4px 0', whiteSpace: 'normal' }}>{remoteLastGoodText(check.remote)}</div>
              )}
              <Row label="업그레이드 가능">{newer ? <span className="badge green">예</span> : <span className="badge gray">아니오</span>}</Row>
            </div>
          )}
        </div>
      </div>

      {/* v2.730 S-10: 릴리스 서명 — 정책·신뢰 공개키·마지막 검증. 설정은 화면에서 바꾸지 않는다(호스트 portal.env · docs/RELEASE-SIGNING.md). */}
      <SignatureCard sig={status.signature} />

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

        <label className="flex gap" style={{ alignItems: 'center', fontSize: 13, marginTop: 10 }}>
          <input type="checkbox" checked={form.autoApply} onChange={setChk('autoApply')} />
          <span>새 버전 발견 시 <b>자동 적용 + 재시작</b> (끄면 확인만 하고 수동 적용)</span>
        </label>

        {/* v2.580: 버튼 4개가 한 줄에 고정돼 400px 에서 83px 가로 넘침(Chromium A/B 실측 — 기존 결함). 줄바꿈 허용. */}
        <div className="flex gap" style={{ marginTop: 14, flexWrap: 'wrap' }}>
          <button className="login-btn" style={{ flex: 'none', padding: '10px 18px' }} disabled={busy} onClick={saveSettings}>
            {busy === 'save' ? '저장 중…' : '설정 저장'}
          </button>
          <button className="logout-btn" style={{ padding: '10px 18px' }} disabled={busy || !form.enabled}
            onClick={() => run('check', () => postJson('/upgrade/check'))}>
            {busy === 'check' ? '확인 중…' : '새 버전 확인'}
          </button>
          <button className="login-btn" style={{ flex: 'none', padding: '10px 18px', background: newer ? 'linear-gradient(135deg,var(--green),#16a34a)' : undefined }}
            disabled={busy || !form.enabled || !newer} onClick={() => run('apply', () => postJson('/upgrade/apply', { source: 'auto', restart: true }))}>
            {busy === 'apply' ? '적용 중…' : '업그레이드 적용 + 재시작'}
          </button>
          <button className="logout-btn" style={{ padding: '10px 18px' }} disabled={busy}
            onClick={() => run('restart', () => postJson('/upgrade/restart'))}>
            {busy === 'restart' ? '재시작 중…' : '프로세스 재시작'}
          </button>
        </div>

        {msg && (
          <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 8,
            background: msg.r.ok && !msg.r.note ? 'rgba(34,197,94,.12)' : 'rgba(245,158,11,.12)',
            color: msg.r.ok && !msg.r.note ? '#4ade80' : '#fbbf24', fontSize: 13 }}>
            <b>{msg.action}</b> · {msg.r.ok && msg.r.note ? msg.r.note : msg.r.ok
              ? `성공${msg.r.version ? ` — v${msg.r.from || '?'} → v${msg.r.version}` : ''}${msg.r.backup ? ` (백업: ${msg.r.backup})` : ''}${msg.r.restarting ? ' · 재시작 중' : ''}`
              : (msg.r.reason || '실패')}
          </div>
        )}
      </div>

      {result && (
        <div className="card" style={{ marginTop: 16 }}>
          <b>최근 적용 결과</b>
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
