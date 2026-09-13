/**
 * 보안 자가진단(v2.500) — **포탈이 스스로 확인할 수 있는 사실만** 모아 보여준다.
 *
 * 왜 필요한가: 기존 '프로그램 보안·완성도 점검'(`codexCheck.js`)은 2026-08-08 외부 점검 결과를
 * 상수로 굳혀 둔 **과거 스냅샷**이다. 그 뒤 여러 지적이 실제로 수정됐는데도 화면에는 그대로
 * 남아 있어, 사용자가 이미 해결된 항목을 현재 결함으로 오해한다. 이 모듈은 반대로 **지금 이
 * 서버의 실제 상태**(파일 권한·정책 값·완화 스위치·계정 상태)를 매번 조회해 보고한다.
 *
 * 정직성 규약(이 파일의 존재 이유이므로 지킬 것):
 *  - **점수를 매기지 않는다.** '보안 92점' 같은 숫자는 근거 없이 안심을 준다. 항목별 상태와
 *    개수만 보인다.
 *  - **확인하지 못한 것은 `unknown`** 이다. 파일을 못 읽었으면 '설정 안 됨'이 아니라 '확인 불가'
 *    이고, 그 이유(errno)를 함께 싣는다. 표본이 없는 것과 값이 나쁜 것은 다르다.
 *  - **비밀 값은 싣지 않는다.** 길이·존재 여부·지문까지만(루트 CLAUDE.md·server/CLAUDE.md 규약).
 *  - 완화 스위치는 '켜져 있다'는 사실과 그 의미만 말한다. 운영상 필요해서 켠 것일 수 있으므로
 *    'risk' 는 '위험' 이 아니라 '보호가 꺼져 있음' 으로 읽히게 문구를 쓴다(웹 문구 모듈 담당).
 *
 * 판정 함수는 순수하게 두고(테스트로 고정), 파일·환경 조회만 `collectSelfCheck()` 가 한다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { SECRET_FILES, loadSecretsPolicy } from './secretVault.js';
import { effectiveLoginPolicy, fileUserLoginPolicies, loadSessionSecurity } from './securitySettings.js';

/* ── 순수 판정 ───────────────────────────────────────────────────────────── */

/** 상태 심각도 — 요약·정렬에 쓴다. unknown 은 나쁨과 좋음 사이가 아니라 **별도**다. */
export const RANK = { risk: 3, warn: 2, unknown: 1, ok: 0 };

/** 여러 상태 중 가장 나쁜 것. unknown 은 warn 보다 낮게 본다(모르는 것을 경고로 부풀리지 않는다). */
export function worstStatus(list = []) {
  let out = 'ok';
  for (const s of list) if ((RANK[s] ?? 0) > (RANK[out] ?? 0)) out = s;
  return out;
}

/** 상태별 개수. 점수 대신 이것만 보여준다. */
export function summarize(checks = []) {
  const out = { ok: 0, warn: 0, risk: 0, unknown: 0, total: 0 };
  for (const c of checks) { if (out[c.status] != null) out[c.status] += 1; out.total += 1; }
  return out;
}

/**
 * 파일 권한 판정. 비밀 파일은 0600(소유자만)이어야 한다.
 * mode 는 `fs.statSync().mode` 의 하위 9비트만 본다. null(못 읽음)은 unknown.
 */
export function fileModeStatus(mode) {
  if (mode == null || Number.isNaN(Number(mode))) return { status: 'unknown', perm: null };
  const perm = Number(mode) & 0o777;
  if (perm & 0o007) return { status: 'risk', perm };          // 그 외 사용자에게 열림 — 가장 나쁨
  if (perm & 0o070) return { status: 'risk', perm };          // 그룹에 열림 — 서비스 계정 공유 호스트에서 실질 유출
  if (perm & 0o111) return { status: 'warn', perm };          // 실행 비트(오설정 신호)
  return { status: 'ok', perm };
}

/** 8진수 표기(화면·로그용). */
export const permText = (perm) => (perm == null ? '—' : `0${(perm & 0o777).toString(8).padStart(3, '0')}`);

/**
 * 보안 완화 스위치 판정 — env 값이 '보호를 끄는 쪽'이면 risk.
 * onValue: 그 값일 때 보호가 꺼진다. 미설정(undefined/'')은 기본값이므로 ok.
 */
export function switchStatus(raw, { onValue = 'true', invert = false } = {}) {
  const v = raw == null ? '' : String(raw).trim().toLowerCase();
  if (v === '') return invert ? 'ok' : 'ok';                  // 미설정 = 기본값(안전 쪽)
  const off = invert ? v !== String(onValue) : v === String(onValue);
  return off ? 'risk' : 'ok';
}

/**
 * 로그인 정책 판정. 기본(null=레거시: 고권한 OTP 전용)과 otp_only 는 ok.
 * 혼용은 warn, 비번 전용은 risk — 다만 **사용자가 명시적으로 고른 정책**이므로 문구는 중립적으로.
 */
export function loginPolicyStatus(policy) {
  if (policy == null || policy === 'otp_only') return 'ok';
  if (policy === 'otp_or_password') return 'warn';
  if (policy === 'password_only') return 'risk';
  return 'unknown';
}

/** 자격증명 저장 모드 판정. plain 은 기본값이라 '위험'이 아니라 '보호 미적용'(warn). */
export function secretsModeStatus(mode) {
  if (mode === 'encrypted') return 'ok';
  if (mode === 'plain') return 'warn';
  return 'unknown';
}

/**
 * 고권한 계정의 OTP 등록 상태 판정.
 *  - 등록된 admin 이 0명이면 risk: OTP 강제 정책에서 **아무도 로그인 못 하는 잠금**으로 갈 수 있고,
 *    반대로 비번 로그인이 열려 있다는 뜻이기도 하다(둘 다 조치 대상).
 *  - 미등록 고권한 계정이 남아 있으면 warn(부트스트랩 상태가 방치된 것).
 */
export function otpCoverageStatus({ privileged = 0, enrolled = 0 } = {}) {
  if (privileged === 0) return 'unknown';                     // 로컬 고권한 계정이 없다(AD 전용 등)
  if (enrolled === 0) return 'risk';
  if (enrolled < privileged) return 'warn';
  return 'ok';
}

/* ── 조회(파일·환경) ─────────────────────────────────────────────────────── */

/** 파일 하나의 존재·권한·크기. 실패는 던지지 않고 reason 을 담는다. */
export function statFile(file) {
  try {
    const st = fs.statSync(file);
    return { exists: true, mode: st.mode, size: st.size, mtime: st.mtimeMs, reason: null };
  } catch (e) {
    return { exists: false, mode: null, size: null, mtime: null, reason: e?.code || String(e?.message || e) };
  }
}

/** CONFIG_DIR 안의 `*.corrupt.*` — 로드 실패 시 보존된 원본(손상 이력). */
function corruptFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => /\.corrupt\.\d+/.test(n)).sort();
  } catch { return null; }                                     // 못 읽음 → unknown 신호
}

/**
 * 보호를 끄는 환경변수 목록. 이름·의미·현재 상태만 보고하며 **값 자체는 불리언 판정만** 싣는다.
 * 새 완화 스위치를 만들면 여기에 추가할 것 — 안 그러면 '켜 둔 줄 몰랐다'가 반복된다.
 */
export const RELAX_SWITCHES = [
  { env: 'AUTH_ENABLED', onValue: 'false', title: '인증 비활성', why: '모든 API 가 인증 없이 열린다(개발용).' },
  { env: 'WAN_TLS_INSECURE', onValue: 'true', title: '중앙↔엣지 TLS 검증 해제', why: '엣지 통신의 인증서 검증을 끈다 — 그 경로로 토큰·자격증명이 흐른다.' },
  { env: 'UPGRADE_ALLOW_UNVERIFIED', onValue: 'true', title: '업그레이드 번들 서명 검증 생략', why: 'sha256 없이도 번들을 적용한다 — 함대 확산 경로.' },
  { env: 'OTP_ROLE_ENFORCE', onValue: 'false', title: 'OTP 강제 해제', why: '고권한 계정의 OTP 전용 정책을 끈다(잠금 복구용 긴급 스위치).' },
  { env: 'RMA_ALLOW_CUSTOM', onValue: 'true', title: '원격 자유 명령 허용', why: '프리셋 밖의 임의 명령을 이 엣지에서 실행할 수 있다.' },
  { env: 'RMA_ALLOW_SSH', onValue: 'true', title: '원격 SSH 실행 허용', why: '엣지가 저장 계정으로 다른 장비에 SSH 명령을 낸다.' },
  { env: 'RMA_ALLOW_REBOOT', onValue: 'true', title: '원격 재부팅 허용', why: '재부팅 프리셋이 활성화된다.' },
  { env: 'UAGMON_ALLOW_PUBLIC', onValue: 'true', title: 'UAG 모니터 공개 IP 허용', why: '공개 IP 대상에도 Basic 자격증명을 보낸다.' },
  { env: 'STORAGE_TLS_VERIFY', onValue: 'false', title: '스토리지 수집 TLS 검증 해제', why: '자체서명 허용이 기본이라 명시적으로 끈 경우만 표시된다.', optIn: true },
  { env: 'SANSWITCH_TLS_VERIFY', onValue: 'false', title: 'SAN 스위치 TLS 검증 해제', why: '자체서명 허용이 기본이라 명시적으로 끈 경우만 표시된다.', optIn: true },
];

/**
 * 지금 이 서버의 보안 상태를 조회한다.
 * users: `listUsers()` 결과(주입 — 테스트에서 대체 가능). 미주입이면 계정 항목은 unknown.
 */
export function collectSelfCheck({ users = null, env = process.env, dir = null } = {}) {
  const configDir = dir || config.configDir;
  const checks = [];
  const add = (c) => { checks.push(c); return c; };

  /* 1. 로그인 정책 ------------------------------------------------------- */
  let policy = null; let policyErr = null;
  try { policy = effectiveLoginPolicy(); } catch (e) { policyErr = e?.message || String(e); }
  add({
    id: 'login-policy',
    group: '인증·계정',
    title: '로그인 정책',
    status: policyErr ? 'unknown' : loginPolicyStatus(policy),
    detail: policyErr ? `정책을 읽지 못했다: ${policyErr}` : `현재 정책: ${policy == null ? '기본(고권한 OTP 전용 · 그 외 혼용)' : policy}`,
    evidence: 'security-session.json · security/securitySettings.js effectiveLoginPolicy',
    howto: policy === 'password_only' ? '설정 › 세션 보안에서 정책을 되돌릴 수 있다(소유자 + 본인 OTP 재인증 필요).' : '',
  });

  /* 2. 사용자별 정책 재정의 --------------------------------------------- */
  let overrides = null; let ovErr = null;
  try { overrides = fileUserLoginPolicies(); } catch (e) { ovErr = e?.message || String(e); }
  const ovCount = overrides ? Object.keys(overrides).length : 0;
  add({
    id: 'login-policy-overrides',
    group: '인증·계정',
    title: '사용자별 로그인 정책 재정의',
    status: ovErr ? 'unknown' : (ovCount > 0 ? 'warn' : 'ok'),
    // 계정 열거 단서가 되므로 **이름은 싣지 않는다**(server/CLAUDE.md 규약).
    detail: ovErr ? `읽지 못했다: ${ovErr}` : (ovCount > 0 ? `${ovCount}개 계정에 전역 정책과 다른 재정의가 걸려 있다(계정명은 표시하지 않는다).` : '재정의 없음 — 전역 정책이 모든 계정에 적용된다.'),
    evidence: 'login-policy-users.txt · LOGIN_POLICY_USERS',
    howto: ovCount > 0 ? '의도한 예외인지 확인한다. 파일에서 해당 줄을 지우면 전역 정책으로 돌아간다.' : '',
  });

  /* 3. 고권한 계정 OTP 등록 --------------------------------------------- */
  if (Array.isArray(users)) {
    const local = users.filter((u) => !u.ad && !u.isAd);
    const priv = local.filter((u) => u.role === 'admin' || u.role === 'operator');
    const enrolled = priv.filter((u) => u.totpEnabled || u.hasTotp || u.otpEnrolled);
    const admins = local.filter((u) => u.role === 'admin');
    const adminEnrolled = admins.filter((u) => u.totpEnabled || u.hasTotp || u.otpEnrolled);
    add({
      id: 'otp-coverage',
      group: '인증·계정',
      title: '고권한 계정 OTP 등록',
      status: otpCoverageStatus({ privileged: priv.length, enrolled: enrolled.length }),
      detail: priv.length === 0
        ? '로컬 admin/operator 계정이 없다(AD 전용 구성일 수 있다).'
        : `로컬 고권한 ${priv.length}개 중 ${enrolled.length}개 등록 · admin ${admins.length}개 중 ${adminEnrolled.length}개 등록.`,
      evidence: 'users.json · auth/auth.js listUsers',
      howto: enrolled.length < priv.length ? '설정 › 메인포탈 사용자 관리에서 미등록 계정의 OTP 등록을 요청한다. 전원 분실 시 콘솔 도구 otp-enroll.sh 로 복구한다.' : '',
    });
  } else {
    add({
      id: 'otp-coverage', group: '인증·계정', title: '고권한 계정 OTP 등록', status: 'unknown',
      detail: '계정 목록을 조회하지 못해 판정하지 못했다.', evidence: 'users.json', howto: '',
    });
  }

  /* 4. 초기 admin 비밀번호 파일 잔존 ------------------------------------- */
  const initPw = statFile(path.join(configDir, 'initial-admin-password.txt'));
  add({
    id: 'initial-admin-password',
    group: '인증·계정',
    title: '초기 admin 비밀번호 파일',
    status: initPw.exists ? 'risk' : 'ok',
    detail: initPw.exists
      ? '설치 시 생성된 평문 비밀번호 파일이 아직 남아 있다. OTP 등록을 마치면 자동 삭제되므로, 남아 있다는 것은 부트스트랩이 끝나지 않았다는 뜻이다.'
      : '남아 있지 않다(정상).',
    evidence: `${configDir}/initial-admin-password.txt`,
    howto: initPw.exists ? 'admin 계정의 OTP 등록을 완료하면 삭제된다. 이미 등록했다면 파일을 직접 지운다.' : '',
  });

  /* 5. 비밀 파일 권한 ---------------------------------------------------- */
  const secretRows = [];
  for (const name of SECRET_FILES) {
    const st = statFile(path.join(configDir, name));
    if (!st.exists) continue;                                   // 없는 파일은 판정 대상이 아니다
    const m = fileModeStatus(st.mode);
    secretRows.push({ name, status: m.status, perm: permText(m.perm) });
  }
  const badSecret = secretRows.filter((r) => r.status !== 'ok');
  add({
    id: 'secret-file-modes',
    group: '비밀 보관',
    title: '자격증명 파일 권한(0600)',
    status: secretRows.length === 0 ? 'unknown' : worstStatus(secretRows.map((r) => r.status)),
    detail: secretRows.length === 0
      ? '등록된 자격증명 파일이 아직 없다(장비를 등록하면 생성된다).'
      : `${secretRows.length}개 중 ${badSecret.length}개가 0600 이 아니다.`,
    rows: secretRows,
    evidence: 'security/secretVault.js SECRET_FILES',
    howto: badSecret.length ? `chmod 600 ${badSecret.map((r) => path.join(configDir, r.name)).join(' ')}` : '',
  });

  /* 6. portal.env 권한(AUTH_SECRET·CENTRAL_TOKEN 보관) --------------------- */
  const envFile = statFile(path.join(configDir, 'portal.env'));
  const envMode = fileModeStatus(envFile.mode);
  add({
    id: 'portal-env-mode',
    group: '비밀 보관',
    title: 'portal.env 권한',
    status: envFile.exists ? envMode.status : 'unknown',
    detail: envFile.exists
      ? `현재 권한 ${permText(envMode.perm)}. 이 파일에는 AUTH_SECRET·CENTRAL_TOKEN 이 들어 있다 — 유출되면 임의 계정 토큰 위조가 가능하다.`
      : `파일이 없다(${envFile.reason}). 환경변수로 직접 주입하는 구성일 수 있다.`,
    evidence: `${configDir}/portal.env`,
    howto: envFile.exists && envMode.status !== 'ok' ? `chmod 600 ${path.join(configDir, 'portal.env')}` : '',
  });

  /* 7. 자격증명 저장 방식 ------------------------------------------------- */
  let pol = null; let polErr = null;
  try { pol = loadSecretsPolicy(); } catch (e) { polErr = e?.message || String(e); }
  add({
    id: 'secrets-policy',
    group: '비밀 보관',
    title: '자격증명 저장 방식',
    status: polErr ? 'unknown' : secretsModeStatus(pol?.mode),
    detail: polErr
      ? `정책을 읽지 못했다: ${polErr}`
      : (pol?.mode === 'encrypted'
        ? `봉인 저장(${pol.alg || 'aes-256-gcm'} · 레벨 ${pol.level ?? 2}). 키 파일이 같은 호스트에 있으므로 at-rest 보호이며 호스트 완전 장악은 막지 못한다.`
        : '평문 저장(기본값). 파일 권한(0600)만이 보호 수단이다.'),
    evidence: 'secrets-policy.json',
    howto: pol?.mode === 'plain' ? '설정 › 자격증명 저장 방식에서 암호화로 전환할 수 있다(전환 시 기존 파일이 마이그레이션된다).' : '',
  });

  /* 8. 손상 보존 파일 ---------------------------------------------------- */
  const corrupt = corruptFiles(configDir);
  add({
    id: 'corrupt-files',
    group: '비밀 보관',
    title: '손상 보존 파일',
    status: corrupt == null ? 'unknown' : (corrupt.length ? 'warn' : 'ok'),
    detail: corrupt == null
      ? '설정 디렉터리를 읽지 못해 확인하지 못했다.'
      : (corrupt.length
        ? `${corrupt.length}개의 .corrupt 백업이 있다 — 과거에 설정 파일이 깨져 보존된 흔적이다(자동 복구는 하지 않는다).`
        : '없음.'),
    rows: corrupt ? corrupt.slice(0, 20).map((n) => ({ name: n })) : [],
    evidence: `${configDir}/*.corrupt.*`,
    howto: corrupt?.length ? '내용을 확인해 필요한 값을 복원한 뒤 파일을 정리한다. 반복되면 디스크·전원 문제를 의심한다.' : '',
  });

  /* 9. 보안 완화 스위치 --------------------------------------------------- */
  const relaxRows = RELAX_SWITCHES.map((s) => {
    const raw = env[s.env];
    const on = String(raw ?? '').trim().toLowerCase() === String(s.onValue);
    return { env: s.env, title: s.title, why: s.why, status: on ? 'risk' : 'ok', set: raw != null && String(raw).trim() !== '' };
  });
  const relaxOn = relaxRows.filter((r) => r.status === 'risk');
  add({
    id: 'relax-switches',
    group: '통신·실행',
    title: '보호를 끄는 환경변수',
    status: relaxOn.length ? 'risk' : 'ok',
    detail: relaxOn.length
      ? `${relaxOn.length}개가 켜져 있다: ${relaxOn.map((r) => r.env).join(', ')}. 운영상 필요해 켠 것일 수 있으나, 켜져 있다는 사실 자체는 보이는 편이 낫다.`
      : `${relaxRows.length}개 스위치 모두 기본값(보호 켜짐).`,
    rows: relaxRows,
    evidence: 'portal.env · 프로세스 환경변수',
    howto: relaxOn.length ? '필요 없는 스위치는 portal.env 에서 지우고 포탈을 재시작한다.' : '',
  });

  /* 10. 세션 보안 설정 ---------------------------------------------------- */
  let sess = null; let sessErr = null;
  try { sess = loadSessionSecurity(); } catch (e) { sessErr = e?.message || String(e); }
  add({
    id: 'session-security',
    group: '인증·계정',
    title: '세션 보안 설정',
    status: sessErr ? 'unknown' : 'ok',
    detail: sessErr
      ? `설정을 읽지 못했다: ${sessErr}`
      : `단일 세션 강제 ${sess?.singleSession ? '켜짐' : '꺼짐'} · 데모 세션 모드 ${sess?.demoSessionMode || '기본'}.`,
    evidence: 'security-session.json',
    howto: '',
  });

  return { checks, summary: summarize(checks) };
}
