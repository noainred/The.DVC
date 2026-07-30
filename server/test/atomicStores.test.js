/**
 * 설정/상태 스토어 하드닝 회귀 테스트 —
 *  (1) 저장이 원자적(tmp+rename)이고 자격증명 파일 권한이 0600으로 유지되는지,
 *  (2) 손상 JSON을 만나면 <file>.corrupt.<ts>로 보존하고 빈 값/기본값으로 기동하는지,
 *  (3) 원격 업그레이드 번들의 sha256 불일치/부재를 거부하는지.
 *
 * CONFIG_DIR을 임시 디렉터리로 먼저 지정한 뒤 모듈을 동적 import 한다 — 정적 import는
 * 호이스팅되어 config.js가 저장소 server/config를 잡아버리므로(테스트가 실제 설정을 오염).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-stores-'));
process.env.CONFIG_DIR = CFG;

const corruptBackups = (base) => fs.readdirSync(CFG).filter((n) => n.startsWith(`${base}.corrupt.`));
const tmpLeftovers = () => fs.readdirSync(CFG).filter((n) => n.includes('.tmp-'));
const mode = (f) => fs.statSync(f).mode & 0o777;

/** 조건이 만족될 때까지 대기(디바운스된 비동기 쓰기 확인용). */
async function waitFor(fn, { timeoutMs = 15_000, stepMs = 100 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

test('central/inventory: 손상 파일은 .corrupt로 보존 + 빈 인벤토리로 기동, 저장은 tmp+rename', async () => {
  const file = path.join(CFG, 'central-inventory.json');
  fs.writeFileSync(file, '{"inventory": {"vc-1": {truncated', { mode: 0o600 }); // 부분기록 재현

  // load가 모듈 최상위에서 일어나므로 손상 파일을 만든 뒤에 import 해야 한다.
  const inv = await import('../src/central/inventory.js');

  assert.equal(inv.listInventory().length, 0, '손상 파일은 빈 인벤토리로 리셋');
  assert.equal(corruptBackups('central-inventory.json').length, 1, '손상본을 .corrupt.<ts>로 보존');
  assert.equal(fs.existsSync(file), false, '손상본은 원래 경로에서 치워져 재파싱되지 않음');

  inv.setInventory('vc-1', { hosts: [{ name: 'h1' }], vms: [], datastores: [] }, 'agent-a', Date.now());
  assert.equal(inv.listInventory()[0].hosts, 1, '메모리 캐시는 즉시 반영');

  // persistSoon은 5초 디바운스 후 비동기로 쓴다(이벤트 루프 비차단 유지가 목적).
  const written = await waitFor(() => fs.existsSync(file));
  assert.ok(written, '디바운스 후 파일이 생성됨');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).inventory['vc-1'].agent, 'agent-a');
  assert.equal(mode(file), 0o600, '인벤토리 파일 권한 0600 유지');
  assert.equal(tmpLeftovers().length, 0, 'rename 후 tmp 잔여 없음');
});

test('security/loginMonitor: 손상 파일은 .corrupt로 보존 + 기본값 기동, 저장은 0600 원자적 쓰기', async () => {
  const file = path.join(CFG, 'login-monitor.json');
  fs.writeFileSync(file, '{"enabled": false, "threshold":', { mode: 0o600 });

  const lm = await import('../src/security/loginMonitor.js');
  const loaded = lm.loadLoginMonitor(); // 지연 로드 — import 이후 첫 호출에서 파싱
  assert.equal(loaded.enabled, true, '손상 시 기본값(enabled=true)으로 복귀');
  assert.equal(loaded.threshold, 5);
  assert.equal(corruptBackups('login-monitor.json').length, 1, '손상본을 .corrupt.<ts>로 보존');

  const next = lm.saveLoginMonitor({ enabled: true, intervalMin: 30, threshold: 9 });
  assert.equal(next.threshold, 9);
  assert.equal(mode(file), 0o600, '설정 파일 권한 0600');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).threshold, 9, '저장 후 정상 읽힘');
  assert.equal(tmpLeftovers().length, 0, 'rename 후 tmp 잔여 없음');
});

test('net/monitor: 배열 아닌/손상 파일은 .corrupt로 보존 + 빈 목록, 자격증명 저장은 0600', async () => {
  const file = path.join(CFG, 'capture-monitors.json');
  fs.writeFileSync(file, '{"not": "an array"}', { mode: 0o600 }); // 형식 불일치도 손상 취급

  const mon = await import('../src/net/monitor.js');
  assert.deepEqual(mon.listMonitors(), [], '손상 시 빈 목록');
  assert.equal(corruptBackups('capture-monitors.json').length, 1, '손상본을 .corrupt.<ts>로 보존');

  const saved = mon.saveMonitor({ name: 'mon-a', mode: 'single', peer: '10.0.0.2', hostA: { host: '10.0.0.1', username: 'u', password: 'secret' } });
  assert.equal(mode(file), 0o600, 'SSH 자격증명 포함 파일 권한 0600');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.length, 1);
  assert.equal(raw[0].id, saved.id);
  assert.equal(raw[0].hostA.password, 'secret', '자격증명은 파일에 보존(목록 응답에서만 redact)');
  assert.equal(mon.listMonitors()[0].hostA, '10.0.0.1');
  assert.equal(tmpLeftovers().length, 0, 'rename 후 tmp 잔여 없음');
});

test('upgrade/bundleSource.verifyBundleSha: 불일치·부재 거부, 일치 통과, env로만 우회', async () => {
  const { verifyBundleSha } = await import('../src/upgrade/bundleSource.js');
  const bytes = Buffer.from('bundle-bytes');
  const good = crypto.createHash('sha256').update(bytes).digest('hex');

  // 거부 경로는 console.error/warn을 남기므로 테스트 출력에서 일시 차단.
  const err = console.error; const warn = console.warn;
  console.error = () => {}; console.warn = () => {};
  const prev = process.env.UPGRADE_ALLOW_UNVERIFIED;
  try {
    assert.equal(verifyBundleSha(bytes, good), true, '일치하면 통과');
    assert.equal(verifyBundleSha(bytes, good.toUpperCase()), true, '대문자 hex도 일치로 처리');
    assert.equal(verifyBundleSha(bytes, `${good.slice(0, 63)}0`), false, '불일치는 거부');
    delete process.env.UPGRADE_ALLOW_UNVERIFIED;
    assert.equal(verifyBundleSha(bytes, ''), false, 'sha256 부재는 기본 거부(검증 불가)');
    process.env.UPGRADE_ALLOW_UNVERIFIED = 'true';
    assert.equal(verifyBundleSha(bytes, ''), true, 'downloadArchive와 같은 env로만 우회 허용');
    assert.equal(verifyBundleSha(bytes, `${good.slice(0, 63)}0`), false, '우회 env가 있어도 명시된 sha 불일치는 거부');
  } finally {
    if (prev === undefined) delete process.env.UPGRADE_ALLOW_UNVERIFIED; else process.env.UPGRADE_ALLOW_UNVERIFIED = prev;
    console.error = err; console.warn = warn;
  }
});

after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* */ } });
