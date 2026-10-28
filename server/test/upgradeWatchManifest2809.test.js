/**
 * v2.809 — 감시 폴더 번들 옆 서명 manifest 안내(사용자 신고: 감시 폴더에 tar.gz 만 넣어 '서명 manifest 가 없습니다' 로 업그레이드가 멈췄다).
 *  · 판정은 그대로(manifest-missing 으로 거부 · 설치 폴더 불변) — 사유에 '찾은 위치(폴더/파일 이름)' 만 덧붙인다
 *  · 확인(check) 결과 watch.manifest · watch.hasManifest — 적용 전에 화면이 알린다(있는지만 — 서명 확인은 적용 때)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-watchman-'));
Object.assign(process.env, { CONFIG_DIR: CFG, DATA_SOURCE: 'mock' });
for (const k of ['UPGRADE_ENABLED', 'UPGRADE_POLL_INTERVAL_MS', 'UPGRADE_AUTO_APPLY', 'UPGRADE_INSTALL_DIR', 'UPGRADE_REMOTE_BASE', 'UPGRADE_WATCH_DIR', 'EDGE_MODE', 'CENTRAL_URL', 'UPGRADE_REQUIRE_SIGNATURE', 'UPGRADE_ALLOW_UNVERIFIED']) delete process.env[k];

const upg = await import('../src/upgrade/upgrade.js');
const { UpgradeManager } = await import('../src/upgrade/manager.js');

test('감시 폴더 번들만 — 거부 · 사유에 폴더와 manifest 이름 · 설치 폴더 불변 · 확인 단계에서 hasManifest=false → 두면 true', async () => {
  const watch = fs.mkdtempSync(path.join(CFG, 'w-'));
  const inst = fs.mkdtempSync(path.join(CFG, 'i-'));
  const bundle = path.join(watch, 'vmware-portal-99.0.0.tar.gz');
  fs.writeFileSync(bundle, Buffer.from('not-a-real-bundle'));

  const r = upg.upgradeFromArchive(bundle, inst, '2.808.0', 'vmware-portal');
  assert.equal(r.ok, false);
  assert.equal(r.signature?.code, 'manifest-missing', JSON.stringify(r.signature));
  assert.match(r.reason, /^서명 검증 실패 — 서명 manifest 가 없습니다/);
  assert.ok(r.reason.includes(path.join(watch, 'vmware-portal-99.0.0.manifest.json')), r.reason);
  assert.ok(r.reason.includes('번들 vmware-portal-99.0.0.tar.gz'), r.reason);
  assert.deepEqual(fs.readdirSync(inst), [], '설치 폴더는 그대로');

  // 호출자가 manifestText 를 넘긴 경로(원격 다운로드)는 옆 파일을 찾지 않았으므로 위치를 덧붙이지 않는다
  const r2 = upg.upgradeFromArchive(bundle, inst, '2.808.0', 'vmware-portal', { manifestText: null, where: 'remote' });
  assert.equal(r2.ok, false);
  assert.ok(!r2.reason.includes('찾은 위치'), r2.reason);

  const m = new UpgradeManager();
  m.settings = { ...m.settings, enabled: true, watchDir: watch, remoteBase: '', installDir: inst, autoApply: false, pollIntervalMs: 0 };
  let c = await m.check();
  assert.deepEqual([c.watch.available, c.watch.manifest, c.watch.hasManifest], [true, 'vmware-portal-99.0.0.manifest.json', false]);
  const a = await m.apply({ source: 'watch' });
  assert.equal(a.ok, false);
  assert.match(a.reason, /찾은 위치: .*vmware-portal-99\.0\.0\.manifest\.json/);

  fs.writeFileSync(path.join(watch, 'vmware-portal-99.0.0.manifest.json'), '{"format":"x"}');
  c = await m.check();
  assert.equal(c.watch.hasManifest, true, '있는지만 본다(서명 확인은 적용 때)');
  const a2 = await m.apply({ source: 'watch' });
  assert.equal(a2.ok, false, '형식이 틀린 manifest 는 여전히 거부');
  assert.ok(!/찾은 위치/.test(a2.reason), 'manifest 가 있으면 위치 안내 대상이 아니다');
  assert.deepEqual(fs.readdirSync(inst), []);
});
