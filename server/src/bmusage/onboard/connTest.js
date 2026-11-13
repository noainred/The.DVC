/**
 * bmusage/onboard/connTest.js — 저장된 OS 등록 항목 연결 시험(7b단계). 라우트 밖에 둔다 — 라우트 파일은 접속 자격 원본을 만지지 않는다(소스 스윕).
 *  · 주소는 **저장값**(v2.480 — 호출부가 id 로 찾은 항목을 넘긴다) · 자격 해석은 폴러와 같은 refs.resolveOsAuth · 한 번(재시도 없음) · 짧은 시한.
 *  · 결과에 비밀 · 출력 원문을 싣지 않는다(종류 · 짧은 문구 · OS 이름 꼴만).
 */
/** 저장 항목 연결 시험(한 번 · 짧은 시한). 결과에 비밀 · 출력 원문을 싣지 않는다(종류 · 짧은 문구만). */
export async function testSavedOs(s0) {
  const { resolveOsAuth } = await import('./refs.js');
  const a = resolveOsAuth(s0);
  if (!a.ok) return { ok: false, kind: 'auth-unresolved', reason: a.error };
  if (a.authKind === 'none') return { ok: false, kind: 'no-secret', reason: '인증 수단이 없습니다 — 키를 고르거나 비밀번호를 입력하세요.' };
  const { withSsh } = await import('../../proxy/sshExec.js');
  const { isAuthFailureText, isPeerRejectText } = await import('../../util/authGuard.js');
  const t0 = Date.now();
  try {
    const out = await withSsh({ host: String(s0.host), port: Number(s0.port) || 22, username: a.username, password: a.password || '', privateKey: a.privateKey, passphrase: a.passphrase, readyTimeout: 15_000 },
      async ({ exec }) => exec('uname -s', 10_000));
    const os = String(out?.stdout || '').trim().slice(0, 32);
    return { ok: true, kind: 'ok', authKind: a.authKind, os: /^[A-Za-z0-9_.-]{1,32}$/.test(os) ? os : '', ms: Date.now() - t0 };
  } catch (e) {
    const msg = String(e?.message || e);
    if (isPeerRejectText(msg)) return { ok: false, kind: 'hostkey', authKind: a.authKind, reason: '호스트키를 신뢰하지 않아 끊었습니다 — 설정 › 장비 신뢰에서 지문을 확인 · 승인하세요(무음 신뢰 없음).' };
    if (isAuthFailureText(msg)) return { ok: false, kind: 'auth-rejected', authKind: a.authKind, reason: '인증이 거부됐습니다 — 인증 정지 후보입니다(자동 재시도 없음 · 주기 수집은 다음 실패에서 멈춥니다). 키 · 계정을 확인하세요.' };
    return { ok: false, kind: 'connect', authKind: a.authKind, reason: `접속하지 못했습니다(${msg.replace(/\s+/g, ' ').slice(0, 120)})` };
  }
}

