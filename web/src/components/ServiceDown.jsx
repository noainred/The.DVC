/**
 * ServiceDown — 서비스 일시 미가용(업그레이드 중·5xx·연결 실패) 안내 화면(v2.459).
 *
 * 공용 ErrorBox 가 5xx/네트워크 실패를 감지하면 자동으로 이 화면으로 바뀐다
 * (components/primitives.jsx) — 뷰마다 따로 처리하지 않아도 전 화면에 같은 안내가 적용된다.
 * 판정·문구는 serviceDownText.js(순수 함수, 테스트 대상)에 있다.
 *
 * 화면 원칙: 평소엔 '무엇을 하면 되는지'(5분 후 재시도)만 보이고, 기술적 상세는 **클릭해야**
 * 펼쳐진다 — 일반 사용자에게 스택 문구를 들이밀지 않되 관리자 문의 시 근거는 잃지 않는다.
 * 스타일은 AccessDenied 와 같은 .access-denied 계열을 재사용한다(신규 CSS 최소화).
 */
import React, { useState, useEffect, useRef } from 'react';
import {
  headlineFor, diagnosticLines, diagnosticText, probeOutcome, reconnectStep, reconnectStatusText, RECONNECT_INITIAL,
} from './serviceDownText.js';
import { getToken } from '../api.js';

export default function ServiceDown({ kind, message, http = null, compact = false }) {
  const [open, setOpen] = useState(false);   // 기본 접힘
  const [copied, setCopied] = useState(false);
  const [elapsed, setElapsed] = useState(0); // 자동 재연결 경과(초)
  const lines = diagnosticLines(kind, message, http);
  const T = headlineFor(kind);

  // 자동 재연결(업데이트 재시작 등 연결 자체가 끊긴 경우만) — /api/health 를 폴링하다 살아나면
  // 자동으로 새로고침한다. 5xx(서버 살아서 오류)는 autoReconnect=false 라 반복 새로고침을 피한다.
  // v2.742(WEB-01): ① 확인 요청에 로그인 토큰을 붙이고 401·403 도 '서버가 응답함' 으로 본다(probeOutcome) — 예전에는 토큰 없이
  //   물어 인증을 켠 포탈에서 언제나 401 이었고 재연결이 끝나지 않았다. ② 새로고침은 **연결 불가였다가 응답으로 바뀔 때만**
  //   (reconnectStep) — 처음부터 살아 있었으면 새로고침하지 않고 '다시 시도' 만 남긴다(인증을 끈 포탈의 새로고침 반복 방지).
  const done = useRef(false);
  const [rc, setRc] = useState(RECONNECT_INITIAL);
  const rcRef = useRef(RECONNECT_INITIAL);
  useEffect(() => {
    if (!T.autoReconnect || compact) return undefined;
    const t0 = Date.now();
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    let poll = null;
    let alive = true;   // 이 효과 실행분이 살아 있는가(언마운트·재실행 뒤 늦게 끝난 확인 요청을 버린다)
    const stop = () => { clearInterval(tick); if (poll) clearInterval(poll); poll = null; };
    const probe = async () => {
      if (done.current || !alive) return;
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 4000);
      let r;
      try {
        const token = getToken();
        const res = await fetch('/api/health', {
          cache: 'no-store', signal: ctl.signal,
          ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
        });
        r = { status: res.status };
      } catch (e) { r = { error: e || true }; /* 아직 재시작 중 — 다음 주기에 재시도 */ } finally { clearTimeout(to); }
      if (done.current || !alive) return;
      const next = reconnectStep(rcRef.current, probeOutcome(r));
      rcRef.current = next; setRc(next);
      if (next.phase === 'reload') { done.current = true; stop(); window.location.reload(); }
      else if (next.phase === 'alive') { done.current = true; stop(); }
    };
    poll = setInterval(probe, 3000);
    probe();
    return () => { alive = false; stop(); };
  }, [T.autoReconnect, compact]);
  const rcText = reconnectStatusText(rc, elapsed);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(diagnosticText(lines));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 클립보드 차단 환경(비 HTTPS·권한 거부) — 아래 항목을 직접 선택해 복사하면 된다.
      setCopied(false);
    }
  };

  return (
    <div className={`access-denied${compact ? ' compact' : ''}`}>
      <div className="ad-head">
        <span className="ad-icon" aria-hidden="true">🔧</span>
        <div>
          <h3 className="ad-title">{T.title}</h3>
          <p className="ad-sub">{T.sub}</p>
        </div>
      </div>

      <dl className="ad-facts">
        <dt>조치</dt><dd><strong>{T.act}</strong></dd>
        <dt>계속될 때</dt><dd>{T.esc}</dd>
      </dl>

      {T.autoReconnect && !compact && (
        <div className="sd-reconnect" role="status" aria-live="polite">
          {rcText.spinning && <span className="sd-spin" aria-hidden="true" />}
          {rcText.text}
        </div>
      )}

      <div className="ad-action">
        <button className="login-btn" onClick={() => window.location.reload()}>{T.autoReconnect && rc.phase === 'probing' ? '지금 다시 시도' : '다시 시도'}</button>
        <button className="tab" style={{ marginLeft: 8 }} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? '상세 정보 숨기기' : '상세 정보 보기'}
        </button>
        {open && (
          <div className="sd-detail">
            <dl className="ad-facts">
              {lines.map(([k, v]) => (
                <React.Fragment key={k}><dt>{k}</dt><dd className="ad-reason">{v}</dd></React.Fragment>
              ))}
            </dl>
            <button className="tab" onClick={copy}>{copied ? '복사됨' : '관리자 문의용으로 복사'}</button>
          </div>
        )}
      </div>
    </div>
  );
}
