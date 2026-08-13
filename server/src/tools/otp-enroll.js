#!/usr/bin/env node
/**
 * OTP(TOTP) 콘솔 등록 도구 — 서버에서 직접 실행한다.
 *
 * admin·operator 계정은 비밀번호 로그인이 완전히 차단되므로(OTP 전용 정책), 첫 관리자는
 * 웹으로 OTP 를 등록할 방법이 없다. 이 도구가 그 유일한 초기 등록 경로이자 잠금 복구 수단이다.
 * users.json 을 직접 읽고 쓰므로 **포탈 서비스 계정(또는 root)** 으로, 같은 CONFIG_DIR 을
 * 바라보게 실행해야 한다.
 *
 * 사용법:
 *   node server/src/tools/otp-enroll.js --list
 *   node server/src/tools/otp-enroll.js <username>                  # 시크릿 발급(등록 시작)
 *   node server/src/tools/otp-enroll.js <username> --confirm 123456 # 앱 코드로 확정
 *   node server/src/tools/otp-enroll.js <username> --disable        # OTP 해제(재등록용)
 *
 * 오프라인 설치본 예:
 *   sudo CONFIG_DIR=/etc/vmware-portal node /opt/vmware-portal/app/server/src/tools/otp-enroll.js admin
 */
import process from 'node:process';
import { config } from '../config.js';
import { loadUsers, getUser, listUsers, beginTotpEnroll, confirmTotpEnroll, disableTotp } from '../auth/auth.js';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const username = argv.find((a) => !a.startsWith('-') && argv[argv.indexOf(a) - 1] !== '--confirm');

function die(msg, code = 1) { console.error(`\n✖ ${msg}\n`); process.exit(code); }

console.log(`\nCONFIG_DIR = ${config.configDir}`);

if (has('--help') || has('-h') || (!username && !has('--list'))) {
  console.log(`
OTP 콘솔 등록 도구 (admin/operator 는 OTP 전용 로그인)

  --list                       계정 목록과 OTP 등록 상태 표시
  <username>                   OTP 등록 시작 → 시크릿(수동 입력 키) 출력
  <username> --confirm <코드>  인증 앱의 6자리 코드로 등록 확정
  <username> --disable         OTP 해제(다시 등록하려면 처음부터)

예)
  node server/src/tools/otp-enroll.js admin
  node server/src/tools/otp-enroll.js admin --confirm 482913
`);
  process.exit(0);
}

loadUsers(); // 시드(관리자/수퍼관리자/데모 계정) 보장 후 조회

if (has('--list')) {
  console.log('\n사용자 목록:\n');
  for (const u of listUsers()) {
    const otp = u.totpEnabled ? 'OTP 등록됨' : (u.hasPassword ? '비밀번호만' : '자격증명 없음');
    const note = (u.role === 'admin' || u.role === 'operator') && !u.totpEnabled ? '  ← OTP 등록 필요(로그인 불가)' : '';
    console.log(`  ${u.username.padEnd(20)} ${String(u.role).padEnd(9)} ${otp}${note}`);
  }
  console.log('');
  process.exit(0);
}

const user = getUser(username);
if (!user) die(`사용자 '${username}' 를 찾을 수 없습니다. --list 로 확인하세요.`);

if (has('--disable')) {
  // force: 콘솔 복구 도구는 신뢰된 로컬 실행이라 '비번 없는 OTP 전용 계정'·수퍼관리자도 해제한다
  // (해제 → 인자 없이 재실행으로 재등록하는 헤드리스 복구 흐름). 웹 admin 경로의 잠금 방지 가드는 유지.
  const r = disableTotp(username, { force: true });
  if (!r.ok) die(r.reason);
  console.log(`\n✔ '${username}' 의 OTP 를 해제했습니다. 다시 등록하려면 인자 없이 실행하세요.\n`);
  process.exit(0);
}

const code = valueOf('--confirm');
if (code) {
  const r = confirmTotpEnroll(username, String(code).trim());
  if (!r.ok) die(`${r.reason} (먼저 인자 없이 실행해 등록을 시작했는지, 코드가 유효한지 확인하세요)`);
  console.log(`\n✔ '${username}' OTP 등록 완료 — 이제 이 계정은 6자리 코드로만 로그인합니다.\n`);
  process.exit(0);
}

// 등록 시작 — 시크릿/otpauth URL 출력. 인증 앱의 '설정 키 직접 입력'에 시크릿을 넣으면 된다.
const r = beginTotpEnroll(username, '');
if (!r.ok) die(r.reason);
console.log(`
등록 시작: ${username} (${user.role})

  1) 인증 앱(Google Authenticator / MS Authenticator / Authy)에서
     '설정 키 직접 입력(Enter a setup key)' 을 선택하고 아래 키를 입력하세요.

     계정 이름 : ${username}
     설정 키   : ${r.secret}
     유형      : 시간 기반(Time-based)

     (QR 로 넣고 싶다면 아래 otpauth URL 을 사내 QR 생성기로 변환하세요 —
      이 값은 비밀이므로 외부 웹 서비스에 붙여넣지 마세요.)
     ${r.otpauthURL}

  2) 앱에 표시된 6자리 코드로 확정하세요:

     node server/src/tools/otp-enroll.js ${username} --confirm <6자리>

  ※ 확정 전까지는 기존 로그인 수단이 바뀌지 않습니다.
`);
