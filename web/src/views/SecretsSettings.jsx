import React, { useEffect, useState } from 'react';
import { fetchJson, putJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

/**
 * 설정 › 자격증명 저장 방식(v2.296) — 프로그램이 쓰는 모든 계정 비밀번호(vCenter·NSX·엣지/
 * 수집기 토큰·iDRAC·스캔대역·GPU/게스트 OS·Horizon·원격접속·캡처·에이전트 배포)를 설정 파일에
 * 평문으로 둘지, 암호화(보안 레벨 1/2/3 또는 알고리즘 직접 선택)해 둘지 고른다.
 * 저장 시 기존 저장분이 즉시 일괄 전환되고(평문↔암호화 양방향), 변경은 본인 OTP 재인증 +
 * 감사 로그를 거친다(서버 라우트가 강제 — 이 화면은 표면일 뿐).
 */
const LEVEL_DESC = {
  1: '1단계 — AES-128-GCM · 키 유도 2¹⁴ (빠름: 항목이 아주 많거나 저사양일 때)',
  2: '2단계 — AES-256-GCM · 키 유도 2¹⁵ (기본 권장)',
  3: '3단계 — AES-256-GCM · 키 유도 2¹⁶ (최고 강도: 전환·저장이 약간 느려짐)',
};
const ALGOS = ['aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'chacha20-poly1305'];

export default function SecretsSettings() {
  const [d, setD] = useState(null);       // { policy, files, keySource }
  const [err, setErr] = useState(null);
  const [mode, setMode] = useState('plain');
  const [level, setLevel] = useState(2);
  const [algorithm, setAlgorithm] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // 저장 결과(파일별 전환 보고)

  useEffect(() => {
    fetchJson('/admin/secrets/policy')
      .then((r) => { setD(r); setMode(r.policy.mode); setLevel(r.policy.level); setAlgorithm(r.policy.algorithm || ''); })
      .catch((e) => setErr(e.message));
  }, []);
  if (err) return <ErrorBox message={err} />;
  if (!d) return <Loading />;

  const save = async () => {
    setBusy(true); setResult(null);
    try {
      const r = await putJson('/admin/secrets/policy', { mode, level: Number(level), algorithm, otp: otp.trim() });
      if (r && r.ok === false) setResult({ ok: false, text: r.reason || '저장 실패' });
      else {
        setD((cur) => ({ ...cur, policy: r.policy }));
        setOtp('');
        const changed = (r.migration?.files || []).filter((f) => f.changed);
        const errs = r.migration?.errors || [];
        setResult({
          ok: errs.length === 0,
          text: `적용됨 — ${r.policy.mode === 'encrypted' ? `암호화(레벨 ${r.policy.level}${r.policy.algorithm ? ` · ${r.policy.algorithm}` : ''})` : '평문'} · 전환된 파일 ${changed.length}개${errs.length ? ` · 실패 ${errs.length}개(${errs.map((e) => e.file).join(', ')})` : ''}`,
          detail: r.migration,
        });
      }
    } catch (e) { setResult({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 760 }}>
      <div className="section-title" style={{ marginTop: 0 }}>🔐 자격증명 저장 방식</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0, lineHeight: 1.7 }}>
        vCenter·NSX·엣지/수집기·iDRAC·GPU/게스트 OS 등 <b>프로그램이 사용하는 모든 계정의 비밀번호/토큰/SSH 키</b>를
        설정 파일에 <b>평문</b>으로 둘지 <b>암호화</b>해 둘지 정합니다. 저장하면 기존 저장분이 <b>즉시 일괄 전환</b>되며
        (양방향), 실행 중인 수집·접속 동작에는 영향이 없습니다(메모리에서는 항상 복호되어 사용).
      </p>

      <div className="card" style={{ padding: 16 }}>
        {/* 저장 모드 */}
        {[
          { v: 'plain', label: '평문 저장', desc: '설정 파일에 비밀번호를 그대로 저장합니다(기존 방식). 파일 권한(0600)으로만 보호됩니다.' },
          { v: 'encrypted', label: '암호화 저장', desc: '비밀번호를 AEAD(인증 암호화)로 봉인해 저장합니다 — 백업/사본/저장소 유출 시 평문이 노출되지 않습니다.' },
        ].map((o) => (
          <label key={o.v} className="card" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', cursor: 'pointer', marginBottom: 8, borderColor: mode === o.v ? 'var(--accent,#3b82f6)' : undefined }}>
            <input type="radio" name="secretsMode" style={{ marginTop: 3 }} checked={mode === o.v} onChange={() => setMode(o.v)} />
            <span>
              <b>{o.label}</b>{d.policy.mode === o.v && <span className="badge blue" style={{ marginLeft: 8 }}>현재</span>}
              <div className="muted" style={{ fontSize: 12, marginTop: 3, lineHeight: 1.6 }}>{o.desc}</div>
            </span>
          </label>
        ))}

        {/* 암호화 옵션 — 레벨/알고리즘 */}
        {mode === 'encrypted' && (
          <div style={{ margin: '12px 0 4px', paddingLeft: 4 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}><b>보안 레벨</b> — 레벨이 높을수록 키 유도가 느려져 암호문 단독 유출 시 무차별 대입 비용이 커집니다.</div>
            {[1, 2, 3].map((lv) => (
              <label key={lv} className="flex gap" style={{ alignItems: 'center', cursor: 'pointer', marginBottom: 4, fontSize: 12.5 }}>
                <input type="radio" name="secretsLevel" checked={Number(level) === lv} onChange={() => setLevel(lv)} /> {LEVEL_DESC[lv]}
              </label>
            ))}
            <div className="flex gap wrap" style={{ alignItems: 'center', marginTop: 10 }}>
              <span className="muted" style={{ fontSize: 12 }}><b>알고리즘</b></span>
              <select className="select" value={algorithm} onChange={(e) => setAlgorithm(e.target.value)} style={{ minWidth: 220 }}>
                <option value="">자동 — 레벨 기본값 사용(권장)</option>
                {ALGOS.map((a) => <option key={a} value={a}>{a}{a === 'chacha20-poly1305' ? ' (AES 가속 없는 CPU에 유리)' : ''}</option>)}
              </select>
              <span className="muted" style={{ fontSize: 11 }}>전부 AEAD(무결성 내장) — 변조된 값은 복호가 거부됩니다.</span>
            </div>
          </div>
        )}

        {/* 커버리지 + 키 안내 */}
        <div style={{ borderTop: '1px solid rgba(255,255,255,.08)', marginTop: 14, paddingTop: 12 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}><b>적용 대상 파일</b> ({(d.files || []).length}개) — 저장 시 아래 파일의 비밀번호/토큰/키가 일괄 전환됩니다.</div>
          <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.8, fontFamily: 'ui-monospace, monospace' }}>{(d.files || []).join(' · ')}</div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.7 }}>
            🔑 암호화 키: {d.keySource === 'env' ? <b>SECRETS_KEY 환경변수</b> : <><b>CONFIG_DIR/secrets-key</b> 파일(자동 생성·0600)</>} ·
            ⚠ 키를 잃으면 암호화된 비밀번호는 <b>복구할 수 없습니다</b>(해당 계정 비밀번호 재입력 필요). 백업에 설정 폴더 전체를 포함하면 키도 함께 보관됩니다.
            이 암호화는 <b>저장 시점(백업/사본/저장소 유출) 보호</b>입니다 — 서버 호스트 자체가 장악되면 키도 함께 노출되므로, 그 이상이 필요하면 SECRETS_KEY 를 외부 비밀관리로 주입하세요.
          </div>
        </div>

        {/* 적용(OTP 재인증) */}
        <div style={{ borderTop: '1px solid rgba(255,255,255,.08)', marginTop: 14, paddingTop: 12 }}>
          <div className="flex gap wrap" style={{ alignItems: 'center', gap: 10 }}>
            <span className="muted">변경 확인 — <b>OTP 6자리</b></span>
            <input className="input" inputMode="numeric" autoComplete="one-time-code" placeholder="000000" maxLength={6} style={{ width: 120, letterSpacing: 3 }}
              value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} />
            <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy || otp.length !== 6} onClick={save}>
              {busy ? '전환 중…' : '저장 및 일괄 전환(OTP 확인)'}
            </button>
          </div>
          {result && (
            <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, fontSize: 12.5,
              background: result.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)', color: result.ok ? '#4ade80' : '#f87171' }}>
              {result.ok ? '✅ ' : '⚠ '}{result.text}
            </div>
          )}
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>※ 변경 내역(누가·이전→이후·전환 파일 수)은 설정 › 감사 로그에 기록됩니다.</div>
        </div>
      </div>
    </div>
  );
}
