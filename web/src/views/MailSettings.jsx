import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, sendJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import { STable } from '../components/STable.jsx';

/**
 * 설정 › 메일 발송(v2.454, admin 조회 / 저장·테스트는 설정 소유자).
 *
 * 포탈의 **모든 기능이 쓰는 하나의 SMTP 설정**이다. 기능마다 SMTP 를 따로 두면 같은 값을 여러 번
 * 입력하게 되고, 한쪽만 고쳐 놓고 "왜 이 알림만 안 오지" 를 겪는다.
 * 각 기능은 여기서 종류별로 켜고 끄며, 수신자를 비우면 기본 수신자로 간다.
 *
 * ⚠️ 훅은 전부 최상단 — 조기 return 뒤 useState 는 React #310 크래시를 만든다(v2.202 실제 사고).
 */
export default function MailSettings() {
  const [d, setD] = useState(null);          // { settings, status, kinds }
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [smtp, setSmtp] = useState({ host: '', port: 25, secure: false, startTls: true, user: '', password: '', from: '', fromName: 'VMware Portal', rejectUnauthorized: true });
  const [defaultTo, setDefaultTo] = useState('');
  const [kinds, setKinds] = useState({});
  const [rateLimit, setRateLimit] = useState(60);
  const [testTo, setTestTo] = useState('');
  const inited = useRef(false);

  const load = async () => {
    try {
      const r = await fetchJson('/admin/mail');
      setD(r);
      // 첫 로드에만 폼을 채운다 — 폴링이 입력 중인 값을 덮어쓰면 안 된다.
      if (!inited.current && r?.settings) {
        inited.current = true;
        const s = r.settings;
        setEnabled(!!s.enabled);
        setSmtp((p) => ({ ...p, ...(s.smtp || {}), password: '' }));   // 비밀번호는 서버가 안 내려준다
        setDefaultTo((s.defaultTo || []).join(', '));
        setRateLimit(s.rateLimitPerHour ?? 60);
        const k = {};
        for (const kind of r.kinds || []) {
          const v = (s.kinds || {})[kind.id] || {};
          k[kind.id] = { enabled: v.enabled !== false, to: (v.to || []).join(', '), cc: (v.cc || []).join(', ') };
        }
        setKinds(k);
      }
      setErr(null);
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); const t = setInterval(load, 20_000); return () => clearInterval(t); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const outKinds = {};
      for (const [id, v] of Object.entries(kinds)) outKinds[id] = { enabled: v.enabled, to: split(v.to), cc: split(v.cc) };
      const r = await sendJson('/admin/mail', 'PUT', {
        enabled, defaultTo: split(defaultTo), kinds: outKinds,
        rateLimitPerHour: Number(rateLimit) || 0,
        smtp: { ...smtp, password: smtp.password || undefined },   // 비우면 서버가 기존 값 유지
      });
      setMsg('저장되었습니다.');
      setSmtp((s) => ({ ...s, password: '' }));
      if (r?.settings) setD((prev) => ({ ...prev, settings: r.settings }));
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };

  const test = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/admin/mail/test', { to: split(testTo || defaultTo) });
      setMsg(r.ok ? `테스트 메일을 보냈습니다(${r.accepted.length}명). 받은 편지함을 확인하세요.` : `오류: ${r.reason}`);
      load();
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };

  if (err && !d) return <ErrorBox message={err} />;
  if (!d) return <Loading />;

  const st = d.status || {};

  return (
    <div className="card" style={{ padding: 16 }}>
      <h3 style={{ marginTop: 0 }}>메일 발송</h3>
      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.7, marginTop: -4 }}>
        포탈의 <b>모든 기능이 함께 쓰는</b> SMTP 설정입니다. 알림·일일 리포트·폴더 사용량 리포트가
        여기 설정을 따르며, 아래에서 종류별로 켜고 끄거나 수신자를 따로 지정할 수 있습니다.
        <br />
        메일은 외부 라이브러리 없이 포탈이 <b>직접 SMTP 로</b> 보냅니다 — OAuth2·DKIM 서명·첨부는 지원하지 않습니다.
      </p>
      {err && <div className="muted" style={{ color: '#f0a', fontSize: 12, marginBottom: 8 }}>폴링 오류: {err}</div>}

      <label className="flex gap" style={{ alignItems: 'center', fontSize: 13, margin: '12px 0' }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <b>메일 발송 사용</b>
        <span className="muted" style={{ fontSize: 12 }}>(끄면 모든 기능의 메일이 나가지 않습니다)</span>
      </label>

      {/* ── SMTP ─────────────────────────────────────────────── */}
      <h4 style={{ margin: '16px 0 8px', fontSize: 14 }}>SMTP 서버</h4>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        사내 릴레이 기준입니다. 인증이 필요 없으면 계정을 비워 두세요.
        평문 연결이라도 서버가 STARTTLS 를 광고하면 <b>자동으로 승격</b>한 뒤 인증 정보를 보냅니다.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 10 }}>
        <Field label="서버 주소"><input className="input" value={smtp.host} placeholder="relay.corp.local" onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} /></Field>
        <Field label="포트"><input className="input" type="number" min={1} max={65535} value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: Number(e.target.value) })} /></Field>
        <Field label="보내는 사람(From)"><input className="input" value={smtp.from} placeholder="vmware-portal@corp.local" onChange={(e) => setSmtp({ ...smtp, from: e.target.value })} /></Field>
        <Field label="보내는 사람 표시 이름"><input className="input" value={smtp.fromName || ''} placeholder="VMware Portal" onChange={(e) => setSmtp({ ...smtp, fromName: e.target.value })} /></Field>
        <Field label="계정 (선택)"><input className="input" value={smtp.user} onChange={(e) => setSmtp({ ...smtp, user: e.target.value })} /></Field>
        <Field label={`비밀번호 ${d.settings?.smtp?.hasPassword ? '(저장됨 — 바꿀 때만 입력)' : ''}`}>
          <input className="input" type="password" value={smtp.password} autoComplete="new-password"
            placeholder={d.settings?.smtp?.hasPassword ? '●●●●●●' : ''} onChange={(e) => setSmtp({ ...smtp, password: e.target.value })} />
        </Field>
      </div>
      <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap', marginTop: 8, fontSize: 12.5 }}>
        <label className="flex gap" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={smtp.secure} onChange={(e) => setSmtp({ ...smtp, secure: e.target.checked })} /> 처음부터 TLS(465)
        </label>
        <label className="flex gap" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={smtp.startTls !== false} onChange={(e) => setSmtp({ ...smtp, startTls: e.target.checked })} /> STARTTLS 사용
        </label>
        <label className="flex gap" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={smtp.rejectUnauthorized !== false} onChange={(e) => setSmtp({ ...smtp, rejectUnauthorized: e.target.checked })} /> 인증서 검증
        </label>
      </div>

      {/* ── 수신자 ───────────────────────────────────────────── */}
      <h4 style={{ margin: '20px 0 8px', fontSize: 14 }}>기본 수신자</h4>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        종류별 수신자를 지정하지 않은 메일이 여기로 갑니다.
      </div>
      <input className="input" style={{ width: '100%', maxWidth: 520 }} value={defaultTo}
        placeholder="admin@corp.local, infra@corp.local" onChange={(e) => setDefaultTo(e.target.value)} />

      {/* ── 종류별 ───────────────────────────────────────────── */}
      <h4 style={{ margin: '20px 0 8px', fontSize: 14 }}>기능별 발송</h4>
      <STable minWidth={640} style={{ fontSize: 12.5 }}>
        <thead><tr><th data-nosort>사용</th><th>기능</th><th data-nosort>받는 사람(비우면 기본)</th><th data-nosort>참조</th></tr></thead>
        <tbody>
          {(d.kinds || []).map((k) => {
            const v = kinds[k.id] || { enabled: true, to: '', cc: '' };
            return (
              <tr key={k.id}>
                <td><input type="checkbox" checked={v.enabled} disabled={k.id === 'test'}
                  onChange={(e) => setKinds({ ...kinds, [k.id]: { ...v, enabled: e.target.checked } })} /></td>
                <td>
                  <div>{k.label}</div>
                  <div className="muted" style={{ fontSize: 11, lineHeight: 1.5 }}>{k.desc}</div>
                </td>
                <td><input className="input" style={{ width: 220 }} value={v.to}
                  onChange={(e) => setKinds({ ...kinds, [k.id]: { ...v, to: e.target.value } })} /></td>
                <td><input className="input" style={{ width: 160 }} value={v.cc}
                  onChange={(e) => setKinds({ ...kinds, [k.id]: { ...v, cc: e.target.value } })} /></td>
              </tr>
            );
          })}
        </tbody>
      </STable>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
        '알림' 을 켜면 <b>설정 › 알림</b> 의 규칙과 네트워크·PDU·HAProxy·RMA 점검 이벤트가 메일로도 나갑니다
        (설정 › 알림에서 <b>메일 채널</b>도 함께 켜야 합니다).
      </div>

      <Field label="시간당 발송 한도 (0 = 제한 없음)">
        <input className="input" type="number" min={0} max={10000} style={{ width: 120 }} value={rateLimit}
          onChange={(e) => setRateLimit(Number(e.target.value))} />
        <span className="muted" style={{ fontSize: 11.5, marginLeft: 8 }}>
          알림 폭주(수십 대 동시 다운)로 릴레이가 우리를 차단하는 것을 막습니다.
        </span>
      </Field>

      <div className="flex gap" style={{ alignItems: 'center', marginTop: 18, flexWrap: 'wrap' }}>
        <button className="logout-btn" style={{ padding: '7px 16px' }} disabled={busy} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
        <input className="input" style={{ width: 240 }} value={testTo} placeholder="테스트 수신 주소(비우면 기본 수신자)"
          onChange={(e) => setTestTo(e.target.value)} />
        <button className="logout-btn" style={{ padding: '7px 16px' }} disabled={busy} onClick={test}>메일 테스트</button>
        {msg && <span className="muted" style={{ fontSize: 12.5, color: msg.startsWith('오류') ? '#f0a' : undefined }}>{msg}</span>}
      </div>

      {/* ── 발송 이력 ────────────────────────────────────────── */}
      <h4 style={{ margin: '22px 0 8px', fontSize: 14 }}>최근 발송</h4>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        최근 1시간 {st.sentLastHour ?? 0}건{st.rateLimitPerHour ? ` / 한도 ${st.rateLimitPerHour}건` : ''}
        {st.lastError && <span style={{ color: '#f0a' }}> · 최근 오류: {st.lastError}</span>}
      </div>
      {(st.history || []).length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>아직 발송 기록이 없습니다.</div>}
      {(st.history || []).length > 0 && (
        <STable style={{ width: '100%', fontSize: 12 }}>
          <thead><tr><th>시각</th><th>기능</th><th>제목</th><th>상태</th><th>비고</th></tr></thead>
          <tbody>
            {st.history.map((h, i) => (
              <tr key={i}>
                <td data-sort={h.at}>{new Date(h.at).toLocaleString()}</td>
                <td>{h.kind}</td>
                <td style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.subject}</td>
                <td style={{ color: h.state === 'failed' ? '#f0a' : h.state === 'skipped' ? '#fb0' : '#32d583' }}>
                  {h.state === 'sent' ? '발송' : h.state === 'skipped' ? '건너뜀' : '실패'}
                </td>
                <td className="muted">{h.note}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginTop: 10 }}>
      <label className="muted" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}

const split = (s) => String(s || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
