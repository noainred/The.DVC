#!/usr/bin/env node
/**
 * 계정 관리 콘솔 도구(ASCII 메뉴) — v2.723. 서버에서 직접 실행한다.
 *
 * 메뉴: 계정 목록 · 생성 · 편집(표시 이름·역할·조회 범위) · 비밀번호 설정 · 로그인 방식 지정(계정별) · OTP 등록 ·
 *       OTP 해제 · 로그인 차단 · 삭제.
 *
 * ⚠ 이 도구는 users.json 을 직접 고친다. 실행 중인 포탈은 사용자 목록을 기동 때 한 번 읽어 메모리에 들고 있으므로
 *   (auth.js loadUsers) **계정·비밀번호·OTP 변경은 포탈을 다시 시작해야 반영**되고, 그 전에 포탈이 사용자 파일을
 *   저장하면 이 변경이 덮어써진다. 그래서 끝날 때 재시작을 묻는다(래퍼가 root 로 실행했을 때 — 종료코드 10).
 *   계정별 로그인 방식은 `login-policy-users.txt` 를 쓰므로 **재시작 없이** 3초 안에 적용된다(securitySettings.js 캐시).
 *   동작마다 디스크를 다시 읽는다(reloadUsersFromDisk) — 메뉴를 띄워 둔 사이 포탈이 저장한 값을 덮어쓰지 않게.
 * 이 도구는 서버 셸 권한을 가진 사람이 쓰는 신뢰 경로라 `trusted:true` 로 부른다(otp-enroll.js 와 같은 판단).
 * 그래도 데모 계정 역할 고정·수퍼관리자 삭제 불가·마지막 관리자 보호는 auth.js 가 그대로 지킨다.
 *
 * 실행: 래퍼 `user-admin.sh`(설치본은 `sudo vmware-portal-users`) — 번들 Node·CONFIG_DIR·서비스 계정 강등을 처리한다.
 *   root 로 node 를 직접 실행하면 users.json 이 root 소유가 되어 포탈이 저장하지 못한다.
 */
import process from 'node:process';
import os from 'node:os';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { config, currentVersion } from '../config.js';
import { logAudit } from '../audit.js'; // v2.727(감사 B-05): CLI 변경도 감사 로그에(웹 경로와 같은 등급)
import {
  listUsers, getUser, createUser, updateUser, setLocalPassword, clearLoginCredentials, deleteUser,
  beginTotpEnroll, confirmTotpEnroll, disableTotp, reloadUsersFromDisk, normalizedScope,
} from '../auth/auth.js';
import { VALID_ROLES, isAdminTier } from '../auth/roles.js';
import { effectiveLoginPolicy, loginPolicyOverrideOf, setFileLoginPolicy, invalidateLoginPolicyCache } from '../security/securitySettings.js';
import { boxLines, tableLines, loginStateOf, policyLabel, POLICY_TEXT, ROLE_TEXT, fitDisp } from './userAdminText.js';

const SERVICE = process.env.SERVICE_NAME || 'vmware-portal';
const CAN_RESTART = process.env.USER_ADMIN_CAN_RESTART === '1';
const ENFORCE = process.env.OTP_ROLE_ENFORCE !== 'false';
const RESTART_EXIT = 10; // 래퍼(user-admin.sh)가 이 종료코드를 보면 서비스를 재시작한다

const out = (s = '') => process.stdout.write(`${s}\n`);
const ok = (s) => out(`  [완료] ${s}`);
/*
 * v2.727(감사 B-05): 계정 생성·삭제·역할·비밀번호·OTP·로그인 방식 변경을 `audit.ndjson` 에 남긴다 — 웹 경로(routes/admin/users.js)는
 *   감사 대상인데 같은 변경을 이 도구로 하면 흔적이 없었다. 주체는 `cli:<OS 사용자>`(래퍼가 서비스 계정으로 강등하므로 sudo 호출자는
 *   SUDO_USER 로 함께 적는다), ip 는 'console'. ⚠ 비밀번호·OTP 키는 어떤 필드에도 싣지 않는다(테스트가 파일에 비밀 문자열 0 을 고정).
 *   `logAudit` 은 파일 추가라 포탈 재시작과 무관하게 남는다(실패해도 도구는 멈추지 않는다 — audit.js 가 catch 한다).
 */
function cliActor() {
  let name = '';
  try { name = os.userInfo().username || ''; } catch { name = process.env.USER || process.env.LOGNAME || ''; }
  return `cli:${name || 'unknown'}`;
}
function audit(action, target, detail = '') {
  const sudo = process.env.SUDO_USER ? ` (sudo:${process.env.SUDO_USER})` : '';
  logAudit({ user: cliActor(), action, target, detail: `${detail}${sudo}`, ip: 'console' });
}
const warn = (s) => out(`  [주의] ${s}`);
const fail = (s) => out(`  [실패] ${s}`);

/* ───────────── 입력(파이프 입력도 줄 단위로 받는다 — 테스트·자동화) ───────────── */

const tty = !!process.stdin.isTTY;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
const queue = []; const waiters = []; let closed = false; let muted = false;
rl.on('line', (l) => { if (waiters.length) waiters.shift()(l); else queue.push(l); });
rl.on('close', () => { closed = true; while (waiters.length) waiters.shift()(null); });
if (tty) {
  // 비밀번호 입력 중에는 글자를 보여 주지 않는다(줄바꿈만).
  const orig = rl._writeToOutput?.bind(rl);
  rl._writeToOutput = (s) => { if (!muted) orig?.(s); else if (/[\r\n]/.test(s)) process.stdout.write('\n'); };
}
function nextLine() {
  if (queue.length) return Promise.resolve(queue.shift());
  if (closed) return Promise.resolve(null);
  return new Promise((r) => waiters.push(r));
}
async function ask(q) {
  process.stdout.write(q);
  const v = await nextLine();
  if (v === null) { out(''); throw new EofError(); }
  if (!tty) out('');
  return v.trim();
}
async function askHidden(q) {
  process.stdout.write(q);
  muted = true;
  try {
    const v = await nextLine();
    if (v === null) { out(''); throw new EofError(); }
    if (!tty) out('');
    return v; // 비밀번호는 앞뒤 공백도 값이다 — 다듬지 않는다.
  } finally { muted = false; }
}
async function confirm(q, def = false) {
  const v = (await ask(`${q} ${def ? '[Y/n]' : '[y/N]'} > `)).toLowerCase();
  if (!v) return def;
  return v === 'y' || v === 'yes' || v === '예' || v === 'ㅛ';
}
class EofError extends Error {}

/* ───────────── 상태 ───────────── */

let usersChanged = false;   // users.json 을 바꿨는가(재시작 필요)
let policyChanged = false;  // 계정별 로그인 방식 파일을 바꿨는가(재시작 불필요)

function contextOf(username) {
  const o = loginPolicyOverrideOf(username);
  return { override: o.effective, overrideSource: o.file ? 'file' : (o.env ? 'env' : null), globalPolicy: effectiveLoginPolicy(), enforce: ENFORCE, raw: o };
}

function portalActive() {
  try {
    const r = spawnSync('systemctl', ['is-active', SERVICE], { encoding: 'utf8', timeout: 3000 });
    if (r.error) return null;
    return String(r.stdout || '').trim() === 'active';
  } catch { return null; }
}

/* ───────────── 화면 ───────────── */

function header() {
  invalidateLoginPolicyCache();
  const g = effectiveLoginPolicy();
  const act = portalActive();
  const head = [
    `VMware Portal 계정 관리 (CLI)   v${currentVersion()}`,
    `CONFIG_DIR : ${config.configDir}`,
    `전역 로그인 정책 : ${g ? POLICY_TEXT[g] || g : '기본(관리자·운영자는 OTP 전용)'}${ENFORCE ? '' : '  [OTP_ROLE_ENFORCE=false — OTP 강제 꺼짐]'}`,
    act === true ? `포탈 서비스(${SERVICE}) 실행 중 — 계정 변경은 재시작 후 반영됩니다` : (act === false ? `포탈 서비스(${SERVICE}) 멈춤` : '포탈 서비스 상태: 확인 불가'),
  ];
  const menu = [
    ' 1. 계정 목록',
    ' 2. 계정 생성',
    ' 3. 계정 편집 (표시 이름 · 역할 · 조회 범위)',
    ' 4. 비밀번호 설정 / 재설정',
    ' 5. 로그인 방식 지정 (비밀번호 / OTP / 둘 다 / 기본)',
    ' 6. OTP 등록 (인증 앱)',
    ' 7. OTP 해제 (다시 등록할 때)',
    ' 8. 로그인 차단 (비밀번호·OTP 모두 제거)',
    ' 9. 계정 삭제',
    ' 0. 종료',
  ];
  out('');
  for (const l of boxLines(head, menu, { width: 66 })) out(l);
}

function listTable() {
  reloadUsersFromDisk();
  invalidateLoginPolicyCache();
  const rows = listUsers().map((u, i) => {
    const st = loginStateOf(u, contextOf(u.username));
    const ctx = contextOf(u.username);
    return [
      String(i + 1), u.username, u.name || '', ROLE_TEXT[u.role] || u.role,
      u.hasPassword ? '있음' : '-', u.totpEnabled ? '등록' : '-',
      ctx.override ? `${POLICY_TEXT[ctx.override]}*` : '기본',
      st.state === 'ok' ? st.methods : (st.state === 'enroll' ? 'OTP 등록 필요' : '로그인 불가'),
    ];
  });
  out('');
  for (const l of tableLines([
    { title: '#', width: 3 }, { title: '사용자', width: 16 }, { title: '이름', width: 12 }, { title: '역할', width: 10 },
    { title: '비번', width: 4 }, { title: 'OTP', width: 4 }, { title: '방식', width: 14 }, { title: '로그인', width: 18 },
  ], rows)) out(l);
  out('  * = 계정별로 지정한 로그인 방식(login-policy-users.txt 또는 portal.env)');
  return listUsers();
}

async function pickUser(title = '계정') {
  const list = listTable();
  const v = await ask(`${title} 번호 또는 ID (Enter = 취소) > `);
  if (!v) return null;
  const n = Number(v);
  const u = Number.isInteger(n) && n >= 1 && n <= list.length ? list[n - 1] : list.find((x) => x.username === v);
  if (!u) { fail(`'${v}' 계정을 찾지 못했습니다.`); return null; }
  return u;
}

function showLogin(username) {
  reloadUsersFromDisk();
  const u = listUsers().find((x) => x.username === username);
  if (!u) return;
  const ctx = contextOf(username);
  const st = loginStateOf(u, ctx);
  out(`  로그인 방식 : ${policyLabel(ctx.override, ctx.globalPolicy)}  (${st.source})`);
  out(`  지금 로그인 : ${st.methods}${st.note ? `  — ${st.note}` : ''}`);
  if (ctx.raw.env && !ctx.raw.file) out('  (portal.env 의 LOGIN_POLICY_USERS 에서 지정된 값입니다 — 파일로 지정하면 파일이 이깁니다)');
}

async function askNewPassword() {
  for (let i = 0; i < 3; i++) {
    const a = await askHidden('  새 비밀번호(8~128자) > ');
    if (a.length < 8 || a.length > 128) { fail('비밀번호는 8자 이상 128자 이하여야 합니다.'); continue; }
    const b = await askHidden('  한 번 더 입력 > ');
    if (a !== b) { fail('두 입력이 다릅니다.'); continue; }
    return a;
  }
  return null;
}

async function askRole(cur) {
  const opts = [...VALID_ROLES].reverse(); // viewer · operator · admin · super_admin
  out(`  역할: ${opts.map((r, i) => `${i + 1}) ${ROLE_TEXT[r] || r}(${r})`).join('  ')}`);
  const v = await ask(`  역할 번호${cur ? ` (Enter = 그대로 ${cur})` : ' (Enter = viewer)'} > `);
  if (!v) return cur || 'viewer';
  const r = opts[Number(v) - 1] || (VALID_ROLES.includes(v) ? v : null);
  if (!r) { fail('역할 번호가 올바르지 않습니다.'); return undefined; }
  return r;
}

const POLICY_CHOICES = [
  ['password', '비밀번호로 로그인'],
  ['otp', 'OTP(인증 앱 6자리)로 로그인'],
  ['both', '비밀번호 또는 OTP'],
  [null, '기본 규칙 따름(계정별 지정 삭제)'],
];

async function applyPolicy(username, role, choice) {
  if (choice === 'password' && isAdminTier(role)) {
    warn('관리자 계정을 비밀번호로만 로그인하게 하면 OTP 보호가 빠집니다. 비밀번호를 길고 고유하게 쓰세요.');
    if (!(await confirm('  그래도 지정할까요?'))) { out('  취소했습니다.'); return false; }
  }
  const r = setFileLoginPolicy(username, choice);
  if (!r.ok) { fail(r.reason); return false; }
  policyChanged = true;
  audit('cli.user.login-policy', username, choice ? `policy=${r.policy}` : 'policy=default(지정 삭제)');
  ok(`로그인 방식을 ${choice ? `'${POLICY_TEXT[r.policy]}'` : '기본 규칙'}(으)로 정했습니다 → ${r.file}`);
  out('  이 설정은 포탈 재시작 없이 몇 초 안에 적용됩니다.');
  const o = loginPolicyOverrideOf(username);
  if (!choice && o.env) warn(`portal.env 의 LOGIN_POLICY_USERS 에 이 계정이 '${POLICY_TEXT[o.env]}' 로 남아 있어 그 값이 적용됩니다.`);
  return true;
}

/* ───────────── 동작 ───────────── */

async function doCreate() {
  reloadUsersFromDisk();
  const username = await ask('  새 계정 ID (영문·숫자·._@- 2~64자, Enter = 취소) > ');
  if (!username) return;
  if (!/^[A-Za-z0-9._@-]{2,64}$/.test(username)) { fail('ID 형식이 올바르지 않습니다.'); return; }
  if (getUser(username)) { fail('이미 있는 계정입니다.'); return; }
  const name = (await ask(`  표시 이름 (Enter = ${username}) > `)) || username;
  const role = await askRole(null);
  if (role === undefined) return;
  let password = null;
  if (await confirm('  비밀번호를 지금 정할까요?', true)) {
    password = await askNewPassword();
    if (!password) { fail('비밀번호를 정하지 못해 생성을 멈췄습니다.'); return; }
  }
  out('  로그인 방식:');
  POLICY_CHOICES.forEach(([, label], i) => out(`    ${i + 1}) ${label}`));
  const pv = await ask('  번호 (Enter = 4 기본 규칙) > ');
  const pi = pv ? Number(pv) - 1 : 3;
  if (!POLICY_CHOICES[pi]) { fail('번호가 올바르지 않습니다.'); return; }
  const choice = POLICY_CHOICES[pi][0];
  out('');
  for (const l of boxLines(['만들 계정'], [
    `ID       : ${username}`, `표시 이름 : ${name}`, `역할     : ${ROLE_TEXT[role] || role}(${role})`,
    `비밀번호 : ${password ? '설정함' : '없음'}`, `로그인 방식 : ${POLICY_CHOICES[pi][1]}`,
  ], { width: 50 })) out(`  ${l}`);
  if (!(await confirm('  이대로 만들까요?', true))) { out('  취소했습니다.'); return; }
  reloadUsersFromDisk();
  const r = createUser({ username, name, role, password: password || undefined }, { trusted: true });
  if (!r.ok) { fail(r.reason); return; }
  usersChanged = true;
  audit('cli.user.create', username, `role=${role} · password=${password ? 'set' : 'none'}`);
  ok(`계정 '${username}' 을(를) 만들었습니다.`);
  if (choice) await applyPolicy(username, role, choice);
  showLogin(username);
}

async function doEdit() {
  const u = await pickUser('편집할 계정');
  if (!u) return;
  out(`  현재: 이름 '${u.name}' · 역할 ${u.role} · 조회 범위 ${scopeText(u)}`);
  const name = await ask('  새 표시 이름 (Enter = 그대로) > ');
  const role = await askRole(u.role);
  if (role === undefined) return;
  const sc = await ask('  조회 범위 vCenter ID 콤마 구분 (Enter = 그대로, - = 전체) > ');
  const patch = {};
  if (name) patch.name = name;
  if (role !== u.role) patch.role = role;
  if (sc === '-') patch.scope = null;
  else if (sc) patch.scope = { ...normalizedScope(getUser(u.username)), vcenters: sc.split(',').map((x) => x.trim()).filter(Boolean) };
  if (!Object.keys(patch).length) { out('  바뀐 것이 없습니다.'); return; }
  if (!(await confirm(`  ${Object.keys(patch).map((k) => ({ name: '이름', role: '역할', scope: '조회 범위' })[k]).join('·')} 을(를) 바꿀까요?`, true))) { out('  취소했습니다.'); return; }
  reloadUsersFromDisk();
  const r = updateUser(u.username, patch, { trusted: true });
  if (!r.ok) { fail(r.reason); return; }
  usersChanged = true;
  audit('cli.user.update', u.username, Object.keys(patch).map((k) => (k === 'role' ? `role=${u.role}→${patch.role}` : k === 'scope' ? `scope=${patch.scope ? (patch.scope.vcenters || []).join(',') : 'all'}` : k)).join(' · '));
  ok(`'${u.username}' 을(를) 바꿨습니다.`);
  if (patch.role) showLogin(u.username);
}

function scopeText(u) {
  const s = u.scope || {};
  const v = Array.isArray(s.vcenters) ? s.vcenters : [];
  const r = Array.isArray(s.regions) ? s.regions : [];
  if (!v.length && !r.length) return '전체';
  return [v.length && `vCenter ${v.join(',')}`, r.length && `지역 ${r.join(',')}`].filter(Boolean).join(' / ');
}

async function doPassword() {
  const u = await pickUser('비밀번호를 정할 계정');
  if (!u) return;
  const pw = await askNewPassword();
  if (!pw) { fail('비밀번호를 바꾸지 않았습니다.'); return; }
  reloadUsersFromDisk();
  const r = setLocalPassword(u.username, pw, { trusted: true });
  if (!r.ok) { fail(r.reason); return; }
  usersChanged = true;
  audit('cli.user.password', u.username, 'set');
  ok(`'${u.username}' 의 비밀번호를 바꿨습니다(이 계정의 기존 로그인 세션은 끊깁니다).`);
  showLogin(u.username);
  const st = loginStateOf(listUsers().find((x) => x.username === u.username), contextOf(u.username));
  if (st.enforced && st.methods === 'OTP') {
    warn('이 계정은 지금 OTP 로만 로그인합니다 — 비밀번호로 로그인하게 하려면 5번에서 \'비밀번호\' 로 지정하세요.');
  }
}

async function doPolicy() {
  const u = await pickUser('로그인 방식을 정할 계정');
  if (!u) return;
  showLogin(u.username);
  POLICY_CHOICES.forEach(([, label], i) => out(`    ${i + 1}) ${label}`));
  const v = await ask('  번호 (Enter = 취소) > ');
  if (!v) return;
  const c = POLICY_CHOICES[Number(v) - 1];
  if (!c) { fail('번호가 올바르지 않습니다.'); return; }
  if (!(await applyPolicy(u.username, u.role, c[0]))) return;
  if (c[0] === 'password' && !getUser(u.username)?.passwordHash) {
    warn('이 계정에는 비밀번호가 없습니다 — 지금 정하지 않으면 비밀번호로 로그인할 수 없습니다.');
    if (await confirm('  지금 비밀번호를 정할까요?', true)) {
      const pw = await askNewPassword();
      if (pw) {
        reloadUsersFromDisk();
        const r = setLocalPassword(u.username, pw, { trusted: true });
        if (r.ok) { usersChanged = true; audit('cli.user.password', u.username, 'set'); ok('비밀번호를 정했습니다.'); } else fail(r.reason);
      }
    }
  }
  showLogin(u.username);
}

async function doOtpEnroll() {
  const u = await pickUser('OTP 를 등록할 계정');
  if (!u) return;
  reloadUsersFromDisk();
  const r = beginTotpEnroll(u.username, '', { trusted: true });
  if (!r.ok) { fail(r.reason); return; }
  usersChanged = true;
  audit('cli.user.otp-enroll', u.username, 'begin'); // 키·otpauth 는 싣지 않는다
  out('');
  out('  인증 앱(Google Authenticator·MS Authenticator 등)에서 \'설정 키 직접 입력\' 을 고르고 아래 키를 넣으세요.');
  out(`    계정 이름 : ${u.username}`);
  out(`    설정 키   : ${r.secret}`);
  out('    유형      : 시간 기반');
  out(`    otpauth   : ${r.otpauthURL}`);
  out('    (이 값은 비밀입니다 — 외부 QR 생성 사이트에 붙여넣지 마세요)');
  const code = await ask('  앱에 보이는 6자리 코드 (Enter = 나중에 확정) > ');
  if (!code) { out('  등록을 확정하지 않았습니다. 다시 6번을 고르면 새 키가 발급됩니다(기존 로그인 수단은 그대로).'); return; }
  reloadUsersFromDisk();
  const c = confirmTotpEnroll(u.username, code, { trusted: true });
  if (!c.ok) { fail(`${c.reason} (코드가 맞는지·시계가 맞는지 확인하세요)`); return; }
  audit('cli.user.otp-enroll', u.username, 'confirm');
  ok(`'${u.username}' OTP 등록을 마쳤습니다.`);
  showLogin(u.username);
}

async function doOtpDisable() {
  const u = await pickUser('OTP 를 해제할 계정');
  if (!u) return;
  if (!u.totpEnabled) { out('  이 계정에는 등록된 OTP 가 없습니다.'); return; }
  if (!(await confirm(`  '${u.username}' 의 OTP 를 해제할까요?`))) { out('  취소했습니다.'); return; }
  reloadUsersFromDisk();
  const r = disableTotp(u.username, { force: true });
  if (!r.ok) { fail(r.reason); return; }
  usersChanged = true;
  audit('cli.user.otp-disable', u.username, '');
  ok('OTP 를 해제했습니다.');
  showLogin(u.username);
}

async function doBlock() {
  const u = await pickUser('로그인을 막을 계정');
  if (!u) return;
  if (!(await confirm(`  '${u.username}' 의 비밀번호와 OTP 를 모두 지워 로그인을 막을까요? (다시 열려면 4번으로 비밀번호를 정하세요)`))) { out('  취소했습니다.'); return; }
  reloadUsersFromDisk();
  const r = clearLoginCredentials(u.username, { trusted: true });
  if (!r.ok) { fail(r.reason); return; }
  usersChanged = true;
  audit('cli.user.block', u.username, 'password+otp cleared');
  ok('로그인을 막았습니다.');
}

async function doDelete() {
  const u = await pickUser('삭제할 계정');
  if (!u) return;
  const typed = await ask(`  지우려면 계정 ID '${u.username}' 를 그대로 입력하세요 > `);
  if (typed !== u.username) { out('  입력이 달라 지우지 않았습니다.'); return; }
  reloadUsersFromDisk();
  const r = deleteUser(u.username, { trusted: true });
  if (!r.ok) { fail(r.reason); return; }
  usersChanged = true;
  audit('cli.user.delete', u.username, `role=${u.role}`);
  ok(`'${u.username}' 을(를) 지웠습니다.`);
  if (loginPolicyOverrideOf(u.username).file) {
    const p = setFileLoginPolicy(u.username, null);
    if (p.ok) { policyChanged = true; audit('cli.user.login-policy', u.username, 'policy=default(계정 삭제로 지정 삭제)'); out('  이 계정의 로그인 방식 지정도 지웠습니다.'); }
  }
}

/* ───────────── 시작 ───────────── */

async function finish() {
  out('');
  if (usersChanged) {
    out('  계정·비밀번호·OTP 를 바꿨습니다. 실행 중인 포탈은 재시작해야 이 변경을 압니다.');
    out('  재시작 전에 포탈이 사용자 파일을 저장하면 이 변경이 덮어써질 수 있으니 바로 재시작하세요.');
    if (CAN_RESTART && portalActive() === true) {
      let yes = false;
      try { yes = await confirm(`  지금 ${SERVICE} 를 재시작할까요?`, true); } catch { yes = false; }
      if (yes) { rl.close(); process.exit(RESTART_EXIT); }
    }
    out(`  재시작: sudo systemctl restart ${SERVICE}`);
  } else if (policyChanged) {
    out('  로그인 방식만 바꿨습니다 — 재시작하지 않아도 됩니다.');
  }
  rl.close();
  process.exit(0);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    out('계정 관리 콘솔 도구 — 인자 없이 실행하면 메뉴가 뜹니다. --list 는 목록만 출력합니다.');
    process.exit(0);
  }
  if (argv.includes('--list')) { listTable(); out(''); process.exit(0); }
  reloadUsersFromDisk(); // 첫 설치 시드 안내가 메뉴 중간이 아니라 시작에 찍히게
  for (;;) {
    header();
    let v;
    try { v = await ask('선택 > '); } catch (e) { if (e instanceof EofError) return finish(); throw e; }
    try {
      switch (v) {
        case '1': listTable(); for (const u of listUsers()) { const st = loginStateOf(u, contextOf(u.username)); if (st.note) out(`  - ${fitDisp(u.username, 16)} ${st.note}`); } break;
        case '2': await doCreate(); break;
        case '3': await doEdit(); break;
        case '4': await doPassword(); break;
        case '5': await doPolicy(); break;
        case '6': await doOtpEnroll(); break;
        case '7': await doOtpDisable(); break;
        case '8': await doBlock(); break;
        case '9': await doDelete(); break;
        case '0': case 'q': case 'Q': return finish();
        case '': break;
        default: fail(`'${v}' 는 메뉴에 없습니다.`);
      }
    } catch (e) {
      if (e instanceof EofError) return finish();
      fail(e?.message || String(e));
    }
  }
}

main();
