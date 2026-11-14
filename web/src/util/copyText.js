/**
 * 글자를 클립보드에 복사한다 — **HTTP 포탈에서도 동작하는** 공용 판정(v3.10.1).
 *
 * 왜: `navigator.clipboard` 는 보안 문맥(HTTPS · localhost)에서만 있다. 사내 포탈은 평문 HTTP 로 여는 곳이 있어
 * `navigator.clipboard.writeText` 만 쓰면 **조용히 실패**한다(v3.10.0 공통 기능 서랍의 ‘복사’ 단추 — 판독에서 발견).
 * 같은 이유로 `IdracConnect.jsx` · `ScanJobLogModal.jsx` 는 각자 `execCommand('copy')` 폴백을 손으로 적어 두었다.
 * 순서: 보안 문맥이면 Clipboard API → 실패하거나 없으면 숨긴 textarea + `execCommand('copy')`.
 *
 * @returns {Promise<boolean>} 복사됐으면 true. 실패를 삼키지 않고 false 로 돌려준다 — 화면이 ‘복사 실패’ 를 보여야 한다.
 * 의존성(navigator · document · window)은 테스트를 위해 주입할 수 있다(웹 테스트는 DOM 이 없는 node 환경).
 */
export async function copyText(text, { nav = globalThis.navigator, doc = globalThis.document, win = globalThis.window } = {}) {
  const s = String(text ?? '');
  if (nav?.clipboard?.writeText && win?.isSecureContext !== false) {
    try {
      await nav.clipboard.writeText(s);
      return true;
    } catch { /* 권한 거부 · 포커스 없음 — 아래 폴백으로 */ }
  }
  if (!doc?.createElement || !doc?.body?.appendChild) return false;
  const ta = doc.createElement('textarea');
  ta.value = s;
  ta.setAttribute?.('readonly', '');
  // 화면을 밀거나 스크롤을 옮기지 않게 — 보이지 않는 고정 위치.
  Object.assign(ta.style || {}, { position: 'fixed', top: '0', left: '0', opacity: '0', pointerEvents: 'none' });
  doc.body.appendChild(ta);
  try {
    ta.select?.();
    return typeof doc.execCommand === 'function' ? !!doc.execCommand('copy') : false;
  } catch {
    return false;
  } finally {
    try { doc.body.removeChild(ta); } catch { /* 이미 빠졌다 */ }
  }
}

export default copyText;
