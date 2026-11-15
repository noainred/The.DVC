/**
 * storageFullAudit23.test.js — 전체 점검 23회차(스토리지) 확정분.
 *  S-1 연결 테스트 · 대량 테스트의 저장 비밀번호 승계는 저장과 같은 판정(host · 계정 · SSH 포트) · S-2 수정도 host+type 중복 검사
 *  S-3 보존 설정 손상 중 정리 보류 · 저장 409 · S-4 엣지 extra 목록 칸 정제 · S-6 일 요약은 마지막 유효 관측 · S-7 적재 실패 시 다음 push 재적재
 *  (S-5 미수집 0 표시는 web storageColumns.test.js)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stfa23-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_DIR = tmp;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(HERE, '../src');

test('S-1 — storageAccessMoved: host · 계정 · (둘 다 ssh 일 때) 포트', async () => {
  const { storageAccessMoved } = await import('../src/storage/registry.js');
  const ex = { host: '10.0.0.1', username: 'admin', collectMethod: 'ssh', sshPort: 22, type: 'isilon' };
  assert.equal(storageAccessMoved(ex, { type: 'isilon', host: '10.0.0.1', username: 'admin', collectMethod: 'ssh', sshPort: 22 }), false);
  assert.equal(storageAccessMoved(ex, { type: 'isilon', host: '10.0.0.1', username: 'root', collectMethod: 'ssh', sshPort: 22 }), true, '계정만 바뀜');
  assert.equal(storageAccessMoved(ex, { type: 'isilon', host: '10.0.0.1', username: 'admin', collectMethod: 'ssh', sshPort: 2222 }), true, 'SSH 포트만 바뀜');
  assert.equal(storageAccessMoved(ex, { type: 'isilon', host: '10.0.0.2', username: 'admin', collectMethod: 'ssh', sshPort: 22 }), true);
  const src = fs.readFileSync(path.join(SRC, 'routes/api/storageMon.js'), 'utf8');
  assert.match(src, /const moved = !!existing && storageAccessMoved\(existing, body\);\n  if \(!password && existing && !moved\)/);
  assert.match(src, /if \(storageAccessMoved\(full, input\)\) return \{ ok: false/);
  assert.doesNotMatch(src, /existing\.host === host\) \{ password = existing\.password/);
});

test('S-2 — 기존 장비를 다른 장비와 같은 host+type 으로 고치면 거절 · 메모리도 그대로', async () => {
  const R = await import('../src/storage/registry.js');
  const a = R.saveDevice({ type: 'powerstore', name: 'A', host: '10.9.0.1', username: 'admin', password: 'pw-a' });
  const b = R.saveDevice({ type: 'powerstore', name: 'B', host: '10.9.0.2', username: 'admin', password: 'pw-b' });
  assert.throws(() => R.saveDevice({ id: b.id, type: 'powerstore', name: 'B', host: '10.9.0.1', username: 'admin' }), (e) => !!e.conflict);
  assert.equal(R.listDevices().find((d) => d.id === b.id).host, '10.9.0.2', '거절이 메모리를 바꾸지 않는다');
  assert.equal(R.saveDevice({ id: b.id, type: 'powerstore', name: 'B2', host: '10.9.0.2', username: 'admin' }).name, 'B2', '자기 자신과는 겹치지 않는다');
  void a;
});

test('S-3 — 보존 설정 손상: 정리 보류 · 저장 409 · 확정으로 풀림', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stfa23b-'));
  try {
    fs.writeFileSync(path.join(d, 'storage-growth-settings.json'), '{"rawKeepDays":400,"dailyKeepDays":36');
    const code = `const g = await import(${JSON.stringify(path.join(SRC, 'storage/growthSettings.js'))});
      const db = await import(${JSON.stringify(path.join(SRC, 'storage/db.js'))});
      g.applyGrowthSettings();
      let save = 'ok'; try { g.saveGrowthSettings({ rawKeepDays: 120 }); } catch (e) { save = e.code; }
      const hold = db.pruneHold();
      const u = await import(${JSON.stringify(path.join(SRC, 'util/settingsLoadError.js'))});
      const row = u.listSettingsLoadErrors().find((x) => /growth/.test(x.file));
      const c = row ? u.confirmSettingsDefault(row.file, { by: 't' }) : null;
      console.log(JSON.stringify({ hold: !!hold, save, row: row?.file || null, conf: c?.ok ?? null, holdAfter: db.pruneHold() }));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CONFIG_DIR: d, DATA_DIR: d }, encoding: 'utf8' });
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(out.hold, true, '정리 보류(수정 전: 기본 보존으로 지움)'); assert.equal(out.save, 'settings-unreadable');
    assert.ok(out.row, '서비스 점검 목록'); assert.equal(out.conf, true); assert.equal(out.holdAfter, null, '확정 뒤 정리 재개');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
  const src = fs.readFileSync(path.join(SRC, 'routes/api/storageMon.js'), 'utf8');
  assert.match(src, /if \(e\?\.code === 'settings-unreadable'\) return res\.status\(409\)/);
});

test('S-4 — 엣지 extra 의 jobs · criticalEvents · clusters · perf 는 아는 모양으로만', async () => {
  const { narrowStorageSnapshot } = await import('../src/central/storageEdge.js');
  const { snap } = narrowStorageSnapshot({ id: 'a', extra: { jobs: { running: 'x', paused: [{ job: { a: 1 }, pri: 3 }], failed: [null] }, criticalEvents: [{ time: 't', event: { x: 1 } }, 'bad'], clusters: 5, perf: { totalIops: '12', latencyUs: { a: 1 }, at: 2026 } } });
  assert.deepEqual(snap.extra.jobs, { running: [], paused: [{ pri: 3 }], failed: [], recent: [] });
  assert.deepEqual(snap.extra.criticalEvents, [{ time: 't' }]);
  assert.equal(snap.extra.clusters, null);
  assert.deepEqual(snap.extra.perf, { totalIops: 12, latencyUs: null, at: null });
});

test('S-6 — 일 요약: 그날 마지막 관측이 못 읽음(null)이면 앞선 유효 사용량을 지키고 · S-7 적재 실패는 표지를 되돌린다', async () => {
  const db = await import('../src/storage/db.js');
  const day0 = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const base = { deviceId: 'dev-s6', ok: true, capacity: { totalBytes: 100e12, usedBytes: 31e12 } };
  const r1 = await db.saveCapacityPoint({ ...base, collectedAt: day0 + 3 * 3_600_000 });
  if (r1.reason === 'db-unavailable') return;   // node:sqlite 없는 환경
  await db.saveCapacityPoint({ ...base, capacity: { totalBytes: 100e12, usedBytes: null }, collectedAt: day0 + 6 * 3_600_000 });
  const rows = await db.dailySeries('dev-s6', 0);
  const last = rows[rows.length - 1];
  assert.equal(Number(last.used_bytes ?? last.usedBytes), 31e12, `마지막 유효 관측 유지(수정 전: null) ${JSON.stringify(last)}`);
  const src = fs.readFileSync(path.join(SRC, 'central/storageEdge.js'), 'utf8');
  assert.match(src, /saveCapacityPoint\(dv\)\.then\(\(r\) => \{ if \(r && r\.saved === false && r\.reason === 'db-unavailable'\) unmark\('db-unavailable'\); \}\)\.catch\(/);
});
