// v2.674 — OTP 콘솔 도구의 안내 문구 회귀 테스트.
// ① 다음 단계 안내는 래퍼가 넘긴 호출 형태(OTP_ENROLL_CMD)를 쓴다 — 예전에는 언제나 'node server/src/tools/otp-enroll.js' 를
//    안내해, 설치본에서 그대로 따라 하면 CONFIG_DIR 이 달라지거나 root 소유 users.json 이 생겼다.
// ② 등록 확정·해제 뒤에는 재시작을 안내한다 — 포탈은 users.json 을 기동 때 한 번 읽어 메모리에 둔다(auth.js loadUsers).
// ③ 래퍼가 두 값을 실제로 넘긴다(주석을 지운 소스로 본다).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..');
const TOOL = path.join(SERVER, 'src', 'tools', 'otp-enroll.js');
const WRAPPER = path.resolve(SERVER, '..', 'otp-enroll.sh');

function run(args, env) {
  const dir = env.CONFIG_DIR;
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    cwd: SERVER, encoding: 'utf8', timeout: 30_000,
    env: { PATH: process.env.PATH, CONFIG_DIR: dir, ...env },
  });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

test('① 래퍼가 넘긴 호출 형태로 다음 단계를 안내한다(없으면 예전 문구)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otp-hint-'));
  try {
    const withCmd = run(['admin'], { CONFIG_DIR: dir, OTP_ENROLL_CMD: 'sudo vmware-portal-otp' });
    assert.match(withCmd, /sudo vmware-portal-otp admin --confirm <6자리>/);
    assert.doesNotMatch(withCmd, /node server\/src\/tools\/otp-enroll\.js admin --confirm/);
    const help = run(['--help'], { CONFIG_DIR: dir, OTP_ENROLL_CMD: 'sudo vmware-portal-otp' });
    assert.match(help, /sudo vmware-portal-otp admin --confirm 482913/);
    const bare = run(['admin'], { CONFIG_DIR: dir });
    assert.match(bare, /node server\/src\/tools\/otp-enroll\.js admin --confirm <6자리>/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('② 해제 뒤 재시작을 안내하고 서비스 이름은 래퍼가 넘긴 값을 쓴다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otp-restart-'));
  try {
    run(['admin'], { CONFIG_DIR: dir });
    const out = run(['admin', '--disable'], { CONFIG_DIR: dir, SERVICE_NAME: 'portal-edge' });
    assert.match(out, /OTP 를 해제했습니다/);
    assert.match(out, /sudo systemctl restart portal-edge/);
    assert.match(out, /재시작 전에는 이 변경을 모르고/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('③ 래퍼는 두 exec 경로 모두 SERVICE_NAME·OTP_ENROLL_CMD 를 넘긴다', () => {
  const src = fs.readFileSync(WRAPPER, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const execs = src.split('\n').filter((l) => /^\s*exec\b/.test(l));
  assert.equal(execs.length, 2, '래퍼의 exec 줄은 둘(강등 실행·직접 실행)');
  for (const l of execs) {
    assert.match(l, /SERVICE_NAME="\$SERVICE_NAME"/, l);
    assert.match(l, /OTP_ENROLL_CMD="\$CMD_HINT"/, l);
  }
  assert.match(src, /CMD_HINT="\$0"/);
});
