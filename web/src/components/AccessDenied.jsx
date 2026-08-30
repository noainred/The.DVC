/**
 * AccessDenied — 권한 부족(403) 안내 화면.
 *
 * 왜 별도 화면인가: 권한 거부를 "오류: forbidden" 처럼 보여주면 사용자가 **시스템 장애**로 오해해
 * 새로고침·재로그인을 반복하거나 장애 문의를 올린다. 403 은 버그가 아니라 **정책대로 동작한
 * 접근 제어**이므로, ① 장애가 아님을 먼저 알리고 ② 무엇이 필요한지 ③ 누구에게 어떻게 요청할지를
 * 한 화면에서 알려준다.
 *
 * 공용 ErrorBox 가 403 을 감지하면 자동으로 이 화면으로 바뀐다(components/primitives.jsx) —
 * 뷰마다 따로 처리하지 않아도 전 화면에 동일한 안내가 적용된다.
 * 판정·문구 로직은 accessDeniedText.js(순수 함수, 테스트 대상)에 있다.
 */
import { useState } from 'react';
import { getCurrentUser } from '../api.js';
import { describePermission, buildRequestText, roleName } from './accessDeniedText.js';

export default function AccessDenied({ info = null, message = '', compact = false }) {
  const [copied, setCopied] = useState(false);
  const user = getCurrentUser();
  const d = describePermission(info);
  // 서버가 준 사유를 우선 인용한다 — 우리가 추측한 문장보다 정확하다.
  const reason = info?.serverReason || (typeof message === 'string' ? message : '');
  const text = buildRequestText({ user, info, reason });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 클립보드 차단 환경(비 HTTPS·권한 거부) — 아래 본문을 직접 선택해 복사하면 된다.
      setCopied(false);
    }
  };

  return (
    <div className={`access-denied${compact ? ' compact' : ''}`}>
      <div className="ad-head">
        <span className="ad-icon" aria-hidden="true">🔒</span>
        <div>
          <h3 className="ad-title">이 기능에 대한 권한이 없습니다</h3>
          {/* 가장 중요한 한 줄 — 사용자가 장애로 오해하지 않게 먼저 말한다. */}
          <p className="ad-sub">
            시스템 장애나 오류가 아닙니다. 계정 권한에 따라 <strong>정상적으로 차단</strong>된 접근입니다.
            새로고침이나 재로그인으로는 해결되지 않습니다.
          </p>
        </div>
      </div>

      <dl className="ad-facts">
        <dt>내 계정</dt>
        <dd>{user?.username || '(알 수 없음)'}{user?.role ? ` · ${roleName(user.role)}` : ''}</dd>
        <dt>필요한 권한</dt>
        <dd>{d.need}</dd>
        <dt>권한 부여 방법</dt>
        <dd>{d.how}</dd>
        {reason ? (<><dt>서버 사유</dt><dd className="ad-reason">{reason}</dd></>) : null}
      </dl>

      <div className="ad-action">
        <p className="ad-ask">
          이 기능이 업무에 필요하면 <strong>포탈 관리자에게 아래 내용을 전달해</strong> 권한을 요청하세요.
        </p>
        <pre className="ad-req">{text}</pre>
        <button type="button" className="btn" onClick={copy}>
          {copied ? '✓ 복사했습니다' : '요청 문구 복사'}
        </button>
      </div>
    </div>
  );
}
