/**
 * serverCmdText.js — 서버 명령 실행 화면 문구 · 고를 수 있나 판정(순수 · 시험 serverCmdText.test.js · v3.30 · 설계 docs/design/server-cmd ③).
 * 값이 없으면 단위를 붙이지 않는다(‘—’ · 루트 CLAUDE.md).
 */
import { numOrNull } from '../../numOrNull.js';

/** 실행 결과 코드 → 글(서버 readServer · servercmd 의 code 와 같은 열쇠). */
export const CODE_TEXT = Object.freeze({
  ok: '실행됨', 'exec-timeout': '시한 — 받은 만큼만', 'exec-truncated': '출력 상한 — 잘림', 'not-found': '서버 없음', 'registry-unreadable': '등록부 못 읽음',
  'edge-delegated': '엣지에서 실행', disabled: '수집 꺼짐', 'not-configured': '계정 없음', cred: '계정 판정에서 막힘', 'auth-rejected': '로그인 거부',
  'same-cred-rejected': '같은 계정 거부로 건너뜀', hostkey: '호스트키 미승인', tls: '인증서 미승인', timeout: '시한 초과', connect: '접속 실패', 'no-plan': '이 OS 에 없는 프리셋', error: '내부 오류',
});
export const codeTone = (code) => (code === 'ok' ? 'ok' : ['exec-timeout', 'exec-truncated', 'edge-delegated', 'disabled', 'not-configured', 'no-plan'].includes(code) ? 'warn' : 'bad');

/** 계정 판정에서 막힌 이유(credCode) 가운데 화면이 따로 말하는 것. */
export const CRED_TEXT = Object.freeze({
  'account-feature': '이 계정은 ‘서버 명령 실행’ 에 쓰지 않음 — 설정 › 보안 › 서버 접속에서 계정의 쓸 수 있는 기능에 켭니다',
  'key-feature': '이 키는 ‘서버 명령 실행’ 에 쓰지 않음 — 설정 › 보안 › 서버 접속에서 키의 쓸 수 있는 기능에 켭니다',
  'account-stopped': '계정 정지(앞선 로그인 거부)', 'account-corp-stopped': '법인 사용 중지', 'winrm-needs-password': 'WinRM 은 비밀번호 계정만',
});

/** 서버의 OS 로 프리셋을 돌릴 수 있나(미지정 = Linux 로 붙는다 — 코어와 같은 규칙). */
export const osOf = (s) => (s?.os === 'windows' ? 'windows' : 'linux');
export const osText = (os) => (os === 'windows' ? 'Windows' : os === 'linux' ? 'Linux' : '미지정(Linux 로 붙음)');

/**
 * 이 서버를 고를 수 있나 — 막히면 그 줄에 적을 이유. 접속 · 계정 판정은 서버가 다시 한다(여기는 미리 보이는 것만 — 계정의 ‘쓸 수 있는 기능’ 은 실행하면 접속 0회로 결과에 나온다).
 * @returns {null | {label:string, tone:string}}
 */
export function pickIssue(s, preset) {
  if (!s) return { label: '서버 없음', tone: 'bad' };
  if (s.agent) return { label: `엣지 ${s.agent} 포탈의 같은 화면에서`, tone: 'muted' };
  if (!s.enabled) return { label: '수집 끔', tone: 'muted' };
  const a = s.account || {};
  if (a.unreadable) return { label: '상태 파일 못 읽음', tone: 'bad' };
  if (a.pending) return { label: '승인 대기', tone: 'warn' };
  if (a.source === 'none' || !a.source) return { label: '계정 없음', tone: 'muted' };
  if (preset && Array.isArray(preset.os) && !preset.os.includes(osOf(s))) return { label: `이 프리셋은 ${osOf(s) === 'windows' ? 'Windows' : 'Linux'} 에 없음`, tone: 'muted' };
  return null;
}

/** 계정이 오는 곳(서버 접속 · 서버 정보 화면과 같은 말). */
export function sourceText(s) {
  const a = s?.account || {};
  const via = a.via === 'winrm' ? ' · WinRM' : '';
  if (a.source === 'own') return `따로 정함${via}`;
  if (a.source === 'os') return `OS 종류에서 물려받음${via}`;
  if (a.source === 'corp') return `법인에서 물려받음${via}`;
  if (a.pending) return '승인 대기';
  return '—';
}

/** 값 → 한 줄(‘서비스 이름 chronyd’). 값 없는 프리셋은 빈 글. */
export function paramsText(preset, params) {
  if (!preset || !params) return '';
  return (preset.params || []).map((d) => (typeof params[d.name] === 'string' && params[d.name] ? `${d.label} ${params[d.name]}` : '')).filter(Boolean).join(' · ');
}

/** 결과 칸 글(코드 + 끝 코드). 끝 코드가 0 이 아니어도 실패로 치지 않는다 — 그대로 보인다. */
export function resultText(r) {
  if (!r) return '—';
  const base = CODE_TEXT[r.code] || r.code || '—';
  const ex = numOrNull(r.exit);
  // 점검 1회차 U1: 실행은 됐는데 끝 코드를 못 읽었으면(표지 수가 어긋남 등) ‘모름’ 이라고 밝힌다 — ‘실행됨’ 만 보이면 성공으로 읽힌다.
  if (ex == null) return r.ran && r.code === 'ok' ? `${base} · 끝 코드 모름` : base;
  return `${base} · 끝 코드 ${ex}`;
}

/** 걸린 시간(초 한 자리) — 값이 없으면 ‘—’. */
export function msText(ms) {
  const v = numOrNull(ms);
  if (v == null) return '—';
  return `${(v / 1000).toFixed(1)}초`;
}

/** 결과 합계(실행됨 · 시한/잘림 · 실패 — 코드별). */
export function resultCounts(rows = []) {
  const out = { ran: 0, partial: 0, failed: 0, nonZero: 0 };
  for (const r of rows) {
    if (r?.ran && !r.partial) out.ran += 1;
    else if (r?.ran && r.partial) out.partial += 1;
    else out.failed += 1;
    if (r?.ran && numOrNull(r.exit) != null && Number(r.exit) !== 0) out.nonZero += 1;
  }
  return out;
}

/** 전체 복사 글 — 서버마다 머리줄 + 출력(값이 없으면 ‘(출력 없음)’). */
export function copyAllText(label, rows = []) {
  return rows.filter((r) => r && r.ran !== false).map((r) => [`### ${r.name} — ${label}${numOrNull(r.exit) != null ? ` · 끝 코드 ${r.exit}` : (r.ran && r.code === 'ok' ? ' · 끝 코드 모름' : '')}${r.cut ? ' · 잘림' : ''}`, r.out || '(출력 없음)', ...(r.err ? ['--- 오류 출력', r.err] : [])].join('\n')).join('\n\n');
}

/** 펼친 출력의 머리줄 — 데모 · 계정 정보가 없는 행은 접속 방식 · 로그인 방식을 지어내지 않는다(Chromium 확인: 데모 행이 ‘SSH · 비밀번호’ 로 보였다). */
export function outHead(r) {
  if (!r) return '—';
  const parts = [];
  if (r.demo) parts.push('데모 서버(접속하지 않음)');
  else {
    // 점검 1회차 W2: 값이 있을 때만 — 접속 방식이 비면 ‘SSH’ 로, 모르는 인증 종류를 ‘비밀번호’ 로 지어내지 않는다.
    if (r.via === 'winrm' || r.via === 'ssh') parts.push(r.via === 'winrm' ? 'WinRM' : 'SSH');
    if (r.auth?.kind === 'key' || r.auth?.kind === 'password') parts.push(r.auth.kind === 'key' ? '키' : '비밀번호');
    if (r.auth?.account) parts.push(r.auth.account);
  }
  parts.push(osText(r.os), resultText(r));
  return parts.join(' · ');
}
