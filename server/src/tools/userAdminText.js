/**
 * tools/userAdminText.js — CLI 계정 메뉴(user-admin.js)의 순수 판정·그리기(v2.723). 테스트가 이 모듈을 직접 본다.
 *
 * 그리기는 ASCII 문자(+ - | =)만 쓴다. 한글은 터미널에서 두 칸을 차지하므로 폭을 `dispWidth` 로 세어 맞춘다 —
 * 글자 수로 맞추면 한글이 든 줄마다 오른쪽 테두리가 밀린다.
 *
 * 로그인 판정(`loginStateOf`)은 auth/auth.js authenticateLocal·isOtpOnlyUser 와 **같은 규칙**을 글로 옮긴 것이다 —
 * 그 규칙을 바꾸면 여기도 바꿀 것(테스트가 같은 입력으로 대조한다).
 */
import { isAdminTier } from '../auth/roles.js';

/** 한 글자의 터미널 폭 — 한글·한자·전각은 2, 결합 문자는 0, 그 밖 1. */
export function charWidth(cp) {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}
export function dispWidth(s) {
  let w = 0;
  for (const ch of String(s ?? '')) w += charWidth(ch.codePointAt(0));
  return w;
}
/** 폭 w 를 넘으면 잘라 '~' 를 붙인다(ASCII 만 쓰므로 … 대신 ~). */
export function fitDisp(s, w) {
  const str = String(s ?? '');
  if (dispWidth(str) <= w) return str + ' '.repeat(w - dispWidth(str));
  let out = ''; let cur = 0;
  for (const ch of str) {
    const cw = charWidth(ch.codePointAt(0));
    if (cur + cw > w - 1) break;
    out += ch; cur += cw;
  }
  return out + '~' + ' '.repeat(Math.max(0, w - cur - 1));
}

/** 상자: 제목 줄들 + 구분선 + 본문 줄들. 폭은 내용에 맞추되 최소 width. */
export function boxLines(head, body = [], { width = 64 } = {}) {
  const all = [...head, ...body];
  const inner = Math.max(width, ...all.map((l) => dispWidth(l) + 2));
  const bar = (c) => `+${c.repeat(inner)}+`;
  const row = (l) => `| ${fitDisp(l, inner - 2)} |`;
  return [bar('='), ...head.map(row), bar(body.length ? '-' : '='), ...(body.length ? [...body.map(row), bar('=')] : [])];
}

/** ASCII 표 — cols: [{ title, width }]. */
export function tableLines(cols, rows) {
  const bar = `+${cols.map((c) => '-'.repeat(c.width + 2)).join('+')}+`;
  const line = (cells) => `|${cols.map((c, i) => ` ${fitDisp(cells[i], c.width)} `).join('|')}|`;
  return [bar, line(cols.map((c) => c.title)), bar, ...rows.map(line), bar];
}

export const POLICY_TEXT = Object.freeze({
  otp_only: 'OTP 전용', password_only: '비밀번호 전용', otp_or_password: '비밀번호 또는 OTP',
});
export const ROLE_TEXT = Object.freeze({
  super_admin: '수퍼관리자', admin: '관리자', operator: '운영자', viewer: '조회',
});

/**
 * 이 계정이 지금 무엇으로 로그인하는가 — authenticateLocal 과 같은 규칙.
 * @param {{ role?:string, hasPassword?:boolean, totpEnabled?:boolean }} u listUsers() 의 한 줄
 * @param {{ override?: string|null, overrideSource?: 'file'|'env'|null, globalPolicy?: string|null, enforce?: boolean }} ctx
 * @returns {{ policy: string|null, source: string, enforced: boolean, methods: string, state: 'ok'|'enroll'|'none', note: string }}
 */
export function loginStateOf(u, { override = null, overrideSource = null, globalPolicy = null, enforce = true } = {}) {
  const role = u?.role || 'viewer';
  const hasPw = !!u?.hasPassword;
  const otp = !!u?.totpEnabled;
  const policy = override || globalPolicy || null;
  const source = override
    ? `계정별 지정(${overrideSource === 'env' ? 'portal.env' : '파일'})`
    : (globalPolicy ? '전역 정책' : '기본 규칙');
  let enforced;
  if (!enforce) enforced = false;
  else if (policy === 'otp_or_password' || policy === 'password_only') enforced = false;
  else if (policy === 'otp_only') enforced = true;
  else enforced = isAdminTier(role) || role === 'operator';

  if (enforced) {
    if (otp) return { policy, source, enforced, methods: 'OTP', state: 'ok', note: '' };
    if (hasPw) return { policy, source, enforced, methods: '비밀번호(OTP 등록 전용)', state: 'enroll', note: '비밀번호로 들어가면 OTP 등록 화면만 열립니다 — 등록하면 그 뒤로는 OTP 로만 로그인합니다' };
    return { policy, source, enforced, methods: '없음', state: 'none', note: '비밀번호도 OTP 도 없어 로그인할 수 없습니다' };
  }
  if (policy === 'password_only' && hasPw) return { policy, source, enforced, methods: '비밀번호', state: 'ok', note: otp ? 'OTP 가 등록돼 있지만 이 방식에서는 쓰지 않습니다' : '' };
  const m = [hasPw && '비밀번호', otp && 'OTP'].filter(Boolean);
  if (!m.length) return { policy, source, enforced, methods: '없음', state: 'none', note: '비밀번호도 OTP 도 없어 로그인할 수 없습니다' };
  return { policy, source, enforced, methods: m.join(' 또는 '), state: 'ok', note: '' };
}

/** 방식 이름(정식 값 → 화면 글자). null 이면 규칙 설명. */
export function policyLabel(policy, globalPolicy = null) {
  if (policy) return POLICY_TEXT[policy] || policy;
  if (globalPolicy) return `전역 정책(${POLICY_TEXT[globalPolicy] || globalPolicy})`;
  return '기본(관리자·운영자는 OTP, 조회는 비밀번호 또는 OTP)';
}
