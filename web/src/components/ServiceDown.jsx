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
import React, { useState } from 'react';
import { SERVICE_DOWN_TEXT as T, diagnosticLines, diagnosticText } from './serviceDownText.js';

export default function ServiceDown({ kind, message, http = null, compact = false }) {
  const [open, setOpen] = useState(false);   // 기본 접힘
  const [copied, setCopied] = useState(false);
  const lines = diagnosticLines(kind, message, http);

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

      <div className="ad-action">
        <button className="login-btn" onClick={() => window.location.reload()}>다시 시도</button>
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
