import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, sendJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { blankOr } from '../blankOr.js'; // v2.606 WEB2606-01: 빈 숫자 칸은 보내지 않는다(이전 값 유지 — MailSettings 와 같은 규약)

/**
 * 특수 기능 › 메일 진단(v2.455, admin 전용) — 사용자 요구사항:
 * "특수기능에 이메일 설정하고 테스트 발송 할 수 있는 기능 추가하고, **테스트할때 구체적인 로그**
 *  보이게 해줘."
 *
 * 설정 › 메일 발송과 **같은 설정**(`mail.json`)을 다룬다 — 두 벌이 아니다. 여기서는 한 화면에서
 * 서버 정보를 고치고 바로 보내 보면서 **SMTP 대화를 단계별로** 확인하는 데 초점을 둔다.
 *
 * ⚠️ 로그에 비밀번호는 나오지 않는다 — 서버(`util/smtp.js`)가 인증 단계 명령을 `<redacted>` 로
 *    가려서 보낸다. 화면에서 지우는 것이 아니라 **애초에 오지 않는다**(회귀 테스트로 고정).
 * ⚠️ 훅은 전부 최상단 — 조기 return 뒤 useState 는 React #310 크래시를 만든다.
 */
export function MailDiag() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [smtp, setSmtp] = useState({ host: '', port: 25, secure: false, startTls: true, user: '', password: '', from: '', fromName: 'VMware Portal', rejectUnauthorized: true, timeoutMs: 20000 });
  const [enabled, setEnabled] = useState(false);
  const [to, setTo] = useState('');
  const [result, setResult] = useState(null);   // { ok, reason, accepted, trace }
  const inited = useRef(false);

  const load = async () => {
    try {
      const r = await fetchJson('/admin/mail');
      setD(r);
      if (!inited.current && r?.settings) {
        inited.current = true;
        setEnabled(!!r.settings.enabled);
        setSmtp((p) => ({ ...p, ...(r.settings.smtp || {}), password: '' }));
        setTo((r.settings.defaultTo || []).join(', '));
      }
      setErr(null);
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await sendJson('/admin/mail', 'PUT', {
        enabled,
        smtp: { ...smtp, port: blankOr(smtp.port), timeoutMs: blankOr(smtp.timeoutMs), password: smtp.password || undefined },   // 비우면 서버가 기존 값 유지
      });
      setMsg('저장되었습니다.');
      // 빈 칸으로 저장했으면 서버가 유지한 값을 다시 채운다(칸이 비어 있으면 '무엇으로 저장됐나' 를 알 수 없다).
      setSmtp((s) => ({ ...s, password: '', port: r?.settings?.smtp?.port ?? s.port, timeoutMs: r?.settings?.smtp?.timeoutMs ?? s.timeoutMs }));
      if (r?.settings) setD((p) => ({ ...p, settings: r.settings }));
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };

  const test = async () => {
    setBusy(true); setMsg(null); setResult(null);
    const t0 = Date.now();
    try {
      const r = await postJson('/admin/mail/test', { to: split(to), trace: true });
      setResult({ ...r, elapsed: Date.now() - t0 });
      setMsg(r.ok ? `발송 성공 — ${r.accepted?.length ?? 0}명 수신` : `실패: ${r.reason}`);
    } catch (e) {
      // 서버가 502 로 줘도 본문에 trace 가 들어 있다 — api.js 의 HttpError 가 body 를 보존한다.
      // 실패한 대화야말로 진단의 핵심이라 여기서 반드시 꺼내 쓴다.
      setResult({ ok: false, reason: e.body?.reason || e.message, trace: e.body?.trace || null, elapsed: Date.now() - t0 });
      setMsg(`오류: ${e.message}`);
    } finally { setBusy(false); }
  };

  if (err && !d) return <ErrorBox message={err} />;
  if (!d) return <Loading />;

  return (
    <div className="card" style={{ padding: 16 }}>
      <h3 style={{ marginTop: 0 }}>메일 진단</h3>
      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.7, marginTop: -4 }}>
        SMTP 서버를 설정하고 <b>테스트 메일을 보내면서 단계별 대화를 그대로</b> 봅니다.
        어디서 막혔는지(연결·STARTTLS·인증·수신자 거부) 바로 알 수 있습니다.
        <br />
        여기 설정은 <b>설정 › 메일 발송</b>과 같은 것입니다 — 알림·리포트 등 모든 기능이 이 서버를 씁니다.
        <br />
        <b>로그에 비밀번호는 나오지 않습니다</b> — 서버가 인증 단계를 가려서 보냅니다.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 10, marginTop: 12 }}>
        <F label="서버 주소"><input className="input" value={smtp.host} placeholder="relay.corp.local" onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} /></F>
        <F label="포트"><input className="input" type="number" min={1} max={65535} value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: e.target.value })} /></F>
        <F label="보내는 사람(From)"><input className="input" value={smtp.from} placeholder="vmware-portal@corp.local" onChange={(e) => setSmtp({ ...smtp, from: e.target.value })} /></F>
        <F label="표시 이름"><input className="input" value={smtp.fromName || ''} onChange={(e) => setSmtp({ ...smtp, fromName: e.target.value })} /></F>
        <F label="계정 (선택)"><input className="input" value={smtp.user} onChange={(e) => setSmtp({ ...smtp, user: e.target.value })} /></F>
        <F label={`비밀번호 ${d.settings?.smtp?.hasPassword ? '(저장됨 — 바꿀 때만)' : ''}`}>
          <input className="input" type="password" autoComplete="new-password" value={smtp.password}
            placeholder={d.settings?.smtp?.hasPassword ? '●●●●●●' : ''} onChange={(e) => setSmtp({ ...smtp, password: e.target.value })} />
        </F>
        <F label="타임아웃(ms)"><input className="input" type="number" min={1000} max={120000} value={smtp.timeoutMs ?? ''} onChange={(e) => setSmtp({ ...smtp, timeoutMs: e.target.value })} /></F>
      </div>
      <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap', marginTop: 8, fontSize: 12.5 }}>
        <label className="flex gap" style={{ alignItems: 'center' }}><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> <b>메일 발송 사용</b></label>
        <label className="flex gap" style={{ alignItems: 'center' }}><input type="checkbox" checked={smtp.secure} onChange={(e) => setSmtp({ ...smtp, secure: e.target.checked })} /> 처음부터 TLS(465)</label>
        <label className="flex gap" style={{ alignItems: 'center' }}><input type="checkbox" checked={smtp.startTls !== false} onChange={(e) => setSmtp({ ...smtp, startTls: e.target.checked })} /> STARTTLS</label>
        <label className="flex gap" style={{ alignItems: 'center' }}><input type="checkbox" checked={smtp.rejectUnauthorized !== false} onChange={(e) => setSmtp({ ...smtp, rejectUnauthorized: e.target.checked })} /> 인증서 검증</label>
      </div>

      <div className="flex gap" style={{ alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
        <button className="logout-btn" style={{ padding: '7px 16px' }} disabled={busy} onClick={save}>{busy ? '처리 중…' : '설정 저장'}</button>
        <input className="input" style={{ width: 280 }} value={to} placeholder="받는 사람 (쉼표로 구분)" onChange={(e) => setTo(e.target.value)} />
        <button className="login-btn" style={{ flex: 'none', padding: '7px 16px' }} disabled={busy} onClick={test}>테스트 발송 + 로그 보기</button>
        {msg && <span className="muted" style={{ fontSize: 12.5, color: msg.startsWith('오류') || msg.startsWith('실패') ? '#f0a' : '#32d583' }}>{msg}</span>}
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
        ※ 테스트는 <b>저장된 설정</b>으로 보냅니다 — 위 값을 바꿨다면 먼저 '설정 저장'을 누르세요.
      </div>

      {result && <TraceView result={result} />}
    </div>
  );
}

/** SMTP 대화 로그 — 이 화면의 핵심(요구사항: "구체적인 로그"). */
function TraceView({ result }) {
  const trace = result.trace || [];
  const color = (t) => (t.dir === '>' ? '#7dd3fc' : t.dir === '<' ? (t.code >= 400 ? '#f0a' : '#32d583') : t.dir === '!' ? '#f0a' : '#a78bfa');
  const mark = (t) => (t.dir === '>' ? '→ 보냄' : t.dir === '<' ? `← 응답 ${t.code ?? ''}` : t.dir === '!' ? '✖ 오류' : 'ℹ 정보');

  return (
    <div style={{ marginTop: 18 }}>
      <div className="flex gap" style={{ alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 14 }}>SMTP 대화 로그</b>
        <span className="badge" style={{ background: result.ok ? 'rgba(50,213,131,.18)' : 'rgba(255,0,170,.18)', fontSize: 11.5 }}>
          {result.ok ? '성공' : '실패'}
        </span>
        {result.elapsed != null && <span className="muted" style={{ fontSize: 11.5 }}>{result.elapsed}ms</span>}
        {result.accepted?.length > 0 && <span className="muted" style={{ fontSize: 11.5 }}>수신: {result.accepted.join(', ')}</span>}
      </div>

      {!result.ok && (
        <div style={{ fontSize: 12.5, marginBottom: 10, padding: '9px 11px', borderRadius: 6, background: 'rgba(255,0,170,.08)', border: '1px solid rgba(255,0,170,.3)', lineHeight: 1.7 }}>
          <b>실패 사유:</b> {result.reason}
          <Hint reason={result.reason} />
        </div>
      )}

      {trace.length === 0 && (
        <div className="muted" style={{ fontSize: 12.5 }}>
          대화 로그가 없습니다 — 서버에 연결하기 전에 막혔거나(설정 오류·발송 꺼짐), 발송이 건너뛰어졌습니다.
        </div>
      )}

      {trace.length > 0 && (
        <div style={{ fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 11.5, lineHeight: 1.7,
          background: 'rgba(0,0,0,.25)', borderRadius: 6, padding: '10px 12px', maxHeight: 420, overflowY: 'auto' }}>
          {trace.map((t, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              <span style={{ color: '#667085', flexShrink: 0, width: 62 }}>{mark(t)}</span>
              <span style={{ color: color(t), flex: 1, minWidth: 0 }}>{t.text}</span>
              {t.ms != null && <span style={{ color: '#667085', flexShrink: 0 }}>{t.ms}ms</span>}
            </div>
          ))}
        </div>
      )}
      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        비밀번호는 <code>&lt;redacted&gt;</code>로 가려져 서버에서 아예 전송되지 않으며, 본문도 크기만 기록됩니다.
      </div>
    </div>
  );
}

/** 흔한 실패에 다음 조치를 붙인다 — 코드만 보고 원인을 아는 사람은 많지 않다. */
function Hint({ reason }) {
  const r = String(reason || '');
  let tip = null;
  if (/접속 실패|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|시간 초과/.test(r)) {
    tip = '서버 주소·포트와 방화벽을 확인하세요. 사내 릴레이는 보통 25번이며, 포탈 서버에서 그 포트로 나가는 것이 허용돼야 합니다.';
  } else if (/인증/.test(r)) {
    tip = '계정·비밀번호를 확인하세요. 인증이 필요 없는 릴레이라면 계정을 비우고 다시 시도하세요.';
  } else if (/STARTTLS|certificate|self.signed|TLS/i.test(r)) {
    tip = '사설 인증서라면 «인증서 검증»을 끄고 시도해 보세요(사내망 한정). 서버가 TLS 를 지원하지 않으면 «STARTTLS»를 끕니다.';
  } else if (/수신자|RCPT|550|relay/i.test(r)) {
    tip = '릴레이가 이 발신 주소/수신 도메인을 허용하지 않을 수 있습니다. 메일 담당자에게 포탈 서버 IP 의 릴레이 허용을 요청하세요.';
  } else if (/꺼져 있|받는 사람이 없/.test(r)) {
    tip = '설정 › 메일 발송에서 «메일 발송 사용»을 켜고 받는 사람을 지정하세요.';
  }
  return tip ? <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>💡 {tip}</div> : null;
}

function F({ label, children }) {
  return (
    <div>
      <label className="muted" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}

const split = (s) => String(s || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
