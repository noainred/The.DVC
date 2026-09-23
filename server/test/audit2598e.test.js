/**
 * v2.598 감사 그룹 e — 암호화 저장 비용 · 백업 지문 · vmtrack 범위 부분 합 · DS 사용량 결측.
 *  - L2598-01: 암호화 모드에서 저장할 때마다 전 비밀을 값마다 scrypt(약 100ms)로 다시 봉인했다(40대 → 약 4초 루프 정지).
 *  - RECENT2598-01: 백업 지문이 파생키 캐시 상태에 따라 뒤집혀 내용 변화 없이 change 백업이 생겼다.
 *  - RECENT2598-02: vmtrack 범위 계정 합산 경로가 skipped(부분 합)를 버렸다.
 *  - RECENT2598-03: DS 사용량 null 을 sampler·alerts·vmtrack diff 가 0 으로 읽었다.
 * 기준 시각은 Date.now() 가 아니라 정시·자정 경계에서 떨어뜨린 고정 값을 쓴다(CLAUDE.md v2.517 규약).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'a2598e-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';
process.env.VMTRACK_DB_PATH = path.join(CFG, 'vm-track.db');
delete process.env.SECRETS_KEY;
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const VAULT_URL = new URL('../src/security/secretVault.js', import.meta.url).href;

const vault = await import('../src/security/secretVault.js');
const POL = { mode: 'encrypted', level: 2, algorithm: '' };
const scrypts = () => vault._vaultStats().scryptCalls;

/** 다른 프로세스(같은 CONFIG_DIR·같은 키)가 봉인한 값 — 이 프로세스의 파생키 캐시·재사용 기억에 없다. */
function sealInOtherProcess(obj) {
  const code = `const v = await import(${JSON.stringify(VAULT_URL)}); process.stdout.write(JSON.stringify(v.sealSecretsDeep(${JSON.stringify(obj)}, ${JSON.stringify(POL)})));`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CONFIG_DIR: CFG }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/* ── L2598-01 ── */
test('L2598-01 — 신규 40대 봉인은 scrypt 1회 이하 · 왕복 보존', () => {
  const list = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, host: `10.1.0.${i}`, password: `new-${i}` }));
  const before = scrypts();
  const t0 = performance.now();
  const sealed = vault.sealSecretsDeep({ servers: list }, POL);
  const ms = performance.now() - t0;
  assert.ok(scrypts() - before <= 1, `scrypt ${scrypts() - before}회 — 예전에는 값마다 1회(40회)`);
  assert.ok(ms < 1_500, `봉인 ${ms.toFixed(0)}ms`);
  assert.ok(sealed.servers.every((s) => vault.isSealed(s.password)));
  assert.equal(new Set(sealed.servers.map((s) => s.password)).size, 40, '값마다 IV 가 달라 암호문이 서로 다르다');
  const back = vault.openSecretsDeep(structuredClone(sealed));
  assert.ok(back.servers.every((s, i) => s.password === `new-${i}`), '복호 왕복');
});

test('L2598-01 — 다른 프로세스가 쓴 등록부를 읽고 1대만 고쳐 저장: scrypt 0회 · 안 바뀐 암호문은 글자 그대로', () => {
  const list = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, host: `10.0.0.${i}`, username: 'root', password: `pw-${i}` }));
  const disk1 = JSON.parse(sealInOtherProcess({ servers: list }));
  // 로드 — 다른 프로세스의 salt 라 여기서는 복호에 scrypt 가 든다(한 번만 — 그 프로세스의 세션 키 하나).
  const loaded = vault.openSecretsDeep(structuredClone(disk1)).servers;
  assert.ok(loaded.every((s, i) => s.password === `pw-${i}`), '기존(다른 프로세스) 암호문이 열린다 — 형식 호환');
  loaded[3].vcenterId = 'vc-x';                  // 비밀이 아닌 필드 1개 수정
  loaded[5].password = 'changed';                // 비밀 1개 변경
  const before = scrypts();
  const disk2 = vault.sealSecretsDeep({ servers: loaded }, POL);
  assert.equal(scrypts() - before, 0, '저장에 scrypt 가 돌면 안 된다(세션 키 + 재사용)');
  disk2.servers.forEach((s, i) => {
    if (i === 5) assert.notEqual(s.password, disk1.servers[i].password, '바뀐 비밀은 새로 봉인');
    else assert.equal(s.password, disk1.servers[i].password, `안 바뀐 비밀(${i})은 암호문 재사용`);
  });
  const back = vault.openSecretsDeep(structuredClone(disk2)).servers;
  assert.equal(back[5].password, 'changed');
  assert.equal(back[7].password, 'pw-7');
});

test('L2598-01 — 재사용은 문맥별: 다른 장비의 같은 비밀번호는 다른 암호문 · 정책이 바뀌면 재사용하지 않는다', () => {
  const a = vault.sealSecretsDeep({ devices: [{ id: 'd1', password: 'same' }, { id: 'd2', password: 'same' }] }, POL);
  assert.notEqual(a.devices[0].password, a.devices[1].password, '파일에서 비밀번호가 같다는 사실이 드러나면 안 된다');
  const again = vault.sealSecretsDeep({ devices: [{ id: 'd1', password: 'same' }, { id: 'd2', password: 'same' }] }, POL);
  assert.deepEqual(again, a, '같은 문맥·같은 평문 재저장은 글자 그대로');
  const l3 = vault.sealSecretsDeep({ devices: [{ id: 'd1', password: 'same' }] }, { mode: 'encrypted', level: 3, algorithm: '' });
  assert.notEqual(l3.devices[0].password, a.devices[0].password);
  assert.match(l3.devices[0].password, /^enc\$1\$aes-256-gcm\$16\$/, '새 정책(L3 logN 16)으로 다시 봉인');
  assert.equal(vault.openSecret(l3.devices[0].password), 'same');
});

test('L2598-01 — 정책 마이그레이션 왕복은 그대로(평문→암호→평문)', () => {
  const fp = path.join(CFG, 'nsx.json');
  fs.writeFileSync(fp, JSON.stringify({ managers: [{ id: 'm1', password: 'nsx-pw' }] }));
  assert.equal(vault.migrateSecretFiles(POL).errors.length, 0);
  assert.ok(!fs.readFileSync(fp, 'utf8').includes('nsx-pw'));
  const again = vault.migrateSecretFiles(POL);            // 같은 정책 재적용 — 재사용이라 파일이 바뀌지 않는다
  assert.equal(again.files.find((f) => f.file === 'nsx.json').changed, false);
  vault.migrateSecretFiles({ mode: 'plain' });
  assert.deepEqual(JSON.parse(fs.readFileSync(fp, 'utf8')), { managers: [{ id: 'm1', password: 'nsx-pw' }] });
});

/* ── RECENT2598-01 ── */
test('RECENT2598-01 — 기동 백업(레지스트리 로드 전) 뒤 로드·무변경 저장을 해도 change 백업이 생기지 않는다', async () => {
  vault.saveSecretsPolicy(POL);
  const bk = await import('../src/backup/service.js');
  const file = path.join(CFG, 'mail.json');
  fs.writeFileSync(file, sealInOtherProcess({ smtp: { host: 'mail.example', username: 'u', password: 'pw1' } }));
  bk._resetBackupFingerprint();
  const r1 = bk.createBackup('startup', { retention: 30 });
  assert.notEqual(r1.skipped, true, 'startup 백업은 생긴다');
  // 모듈이 파일을 읽어 복호(파생키 캐시 적재) → 무변경 저장
  const loaded = vault.openSecretsDeep(JSON.parse(fs.readFileSync(file, 'utf8')));
  const raw0 = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, JSON.stringify(vault.sealSecretsDeep(loaded)));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).smtp.password, JSON.parse(raw0).smtp.password, '무변경 저장은 암호문을 재사용');
  const r2 = bk.createBackup('change', { retention: 30, skipIfUnchanged: true });
  assert.equal(r2.skipped, true, '내용 변화 없이 change 백업이 생기면 안 된다');
  // 실제 변경은 백업한다
  loaded.smtp.password = 'pw2';
  fs.writeFileSync(file, JSON.stringify(vault.sealSecretsDeep(loaded)));
  const r3 = bk.createBackup('change', { retention: 30, skipIfUnchanged: true });
  assert.notEqual(r3.skipped, true, '비밀번호 변경은 설정 변경이다');
  vault.saveSecretsPolicy({ mode: 'plain' });
});

test('RECENT2598-01 — 지문은 봉인을 열지 않는다(캐시 상태와 무관 · scrypt 0회)', async () => {
  const { settingsFingerprint } = await import('../src/backup/service.js');
  const alien = JSON.parse(sealInOtherProcess({ devices: [{ id: 'z', password: 'zz' }] })).devices[0].password;
  const files = { 'storage-devices.json': JSON.stringify({ devices: [{ id: 'z', password: alien }] }) };
  const before = scrypts();
  const fp1 = settingsFingerprint(files);
  vault.openSecret(alien);                          // 이제 캐시에 있다
  const fp2 = settingsFingerprint(files);
  assert.equal(fp1, fp2, '캐시에 있든 없든 같은 내용이면 같은 지문');
  assert.equal(scrypts() - before, 1, '지문 계산은 scrypt 를 돌리지 않는다(1회는 위의 openSecret)');
});

/* ── RECENT2598-02 ── */
const DAY = 86_400_000;
const BASE = Math.floor(Date.now() / DAY) * DAY - 2 * DAY; // 이틀 전 UTC 자정(경계에서 떨어뜨려 아래 시각을 더한다)
const mkVms = (vc, n) => Array.from({ length: n }, (_, i) => ({ id: `${vc}:vm${i}`, vcenterId: vc, name: `vm${i}`, powerState: 'poweredOn' }));

test('RECENT2598-02 — 범위 계정 합산도 슬롯의 부분 합(skipped)을 밝힌다', async () => {
  const svc = await import('../src/vmtrack/service.js');
  const s1 = new Date(BASE + 1 * 3600_000);   // UTC 01:00 = KST 10:00 → T00 슬롯
  const s2 = new Date(BASE + 13 * 3600_000);  // UTC 13:00 = KST 22:00 → T12 슬롯
  let r = await svc.takeVmSnapshot({ vcenters: [{ id: 'a', status: 'ok' }, { id: 'b', status: 'ok' }, { id: 'c', status: 'ok' }], vms: [...mkVms('a', 5), ...mkVms('b', 7), ...mkVms('c', 3)], datastores: [] }, { now: s1 });
  assert.ok(r.ok);
  r = await svc.takeVmSnapshot({ vcenters: [{ id: 'a', status: 'ok' }, { id: 'b', status: 'unreachable' }, { id: 'c', status: 'ok' }], vms: [...mkVms('a', 5), ...mkVms('c', 3)], datastores: [] }, { now: s2 });
  assert.equal(r.skippedCount, 1);
  const full = await svc.vmtrackSeries({ days: 10 });
  assert.deepEqual(full.points.map((p) => [p.total, p.skipped]), [[15, 0], [8, 1]]);
  const ab = await svc.vmtrackSeries({ days: 10, scopeIds: new Set(['a', 'b']) });
  assert.deepEqual(ab.points.map((p) => [p.total, p.skipped]), [[12, 0], [5, 1]], '범위 안 b 가 빠졌다 — 부분 합');
  const ac = await svc.vmtrackSeries({ days: 10, scopeIds: new Set(['a', 'c']) });
  assert.deepEqual(ac.points.map((p) => [p.total, p.skipped]), [[8, 0], [8, 0]], '범위 밖 vCenter 의 실패는 범위 계정의 부분 합이 아니다');
});

/* ── RECENT2598-03 ── */
test('RECENT2598-03 — sampler: 사용량 미상 DS 는 vCenter 디스크 합계에서 빼고 개수를 밝힌다', async () => {
  const { vmAllocRows } = await import('../src/metrics/sampler.js');
  const snap = { vms: [], hosts: [], datastores: [
    { id: 'ds1', vcenterId: 'vc1', capacityGB: 1000, usedGB: 800 },
    { id: 'ds2', vcenterId: 'vc1', capacityGB: 1000, usedGB: null },
  ] };
  const out = vmAllocRows(snap, { enabled: true, vcenterIds: [], trackTotal: false, retentionDays: 30 });
  const rows = Object.fromEntries(out.get('vc1').map((r) => [r.metric, r.v]));
  assert.equal(rows.ds_cap_gb_vc, 1000, '예전에는 2000(사용량 미상 DS 용량까지)');
  assert.equal(rows.ds_used_gb_vc, 800);
  assert.equal(out.dsUsedUnknown, 1);
});

test('RECENT2598-03 — vmtrack diff: 사용량 미상 DS 는 합계에서 빼고 usedUnknown 으로 센다', async () => {
  const { diffDatastores, totalsOf } = await import('../src/vmtrack/diff.js');
  const r = diffDatastores([
    { id: 'vc1:ds1', name: 'ds1', capacityGB: 1000, usedGB: 800 },
    { id: 'vc1:ds2', name: 'ds2', capacityGB: 1000, usedGB: null },
  ], null);
  assert.equal(r.capGB, 1000);
  assert.equal(r.usedGB, 800);
  assert.equal(r.usagePct, 80, '예전에는 40%(미상을 0 으로)');
  assert.equal(r.usedUnknown, 1);
  assert.equal(totalsOf([{ total: 0, onCount: 0, added: [], removed: [], ds: r }]).dsUsedUnknown, 1);
});

test('RECENT2598-03 — vmtrack: 사용량 미상 DS 수가 슬롯 행에 저장되고 조회(전체·범위·vCenter)에 실린다', async () => {
  const svc = await import('../src/vmtrack/service.js');
  const s3 = new Date(BASE + 25 * 3600_000); // 다음 날 KST 10:00 → T00 슬롯
  const r = await svc.takeVmSnapshot({ vcenters: [{ id: 'a', status: 'ok' }, { id: 'b', status: 'ok' }, { id: 'c', status: 'ok' }],
    vms: [...mkVms('a', 5), ...mkVms('b', 7), ...mkVms('c', 3)],
    datastores: [{ id: 'a:ds1', vcenterId: 'a', name: 'ds1', capacityGB: 1000, usedGB: 800 }, { id: 'a:ds2', vcenterId: 'a', name: 'ds2', capacityGB: 1000, usedGB: null }] }, { now: s3 });
  assert.ok(r.ok);
  assert.equal(r.dsUsedUnknown, 1);
  const last = (x) => x.points[x.points.length - 1];
  assert.equal(last(await svc.vmtrackSeries({ days: 10 })).dsUsedUnknown, 1);
  assert.equal(last(await svc.vmtrackSeries({ days: 10, scopeIds: new Set(['a']) })).dsUsedUnknown, 1);
  const one = last(await svc.vmtrackSeries({ days: 10, vcenterId: 'a' }));
  assert.equal(one.dsUsedUnknown, 1);
  assert.equal(one.dsCapGB, 1000, '사용량 미상 DS 는 용량 합계에서도 빠진다');
  assert.equal(one.dsUsagePct, 80);
});

test('RECENT2598-03 — alerts: 발생 중 DS 용량 알림은 사용률을 못 읽은 주기에 해소되지 않는다', async () => {
  const alerts = await import('../src/alerts.js');
  const { store } = await import('../src/store.js');
  const cfg = structuredClone(alerts.loadAlertConfig());
  for (const k of Object.keys(cfg.rules)) if (cfg.rules[k] && typeof cfg.rules[k] === 'object') cfg.rules[k].enabled = false;
  cfg.rules.datastorePct = { enabled: true, threshold: 90 };
  alerts._resetAlertStateForTest();
  const ds = (pct) => ({ vcenters: [], hosts: [], vms: [], alarms: [], datastores: [{ id: 'dsX', name: 'dsX', vcenterId: 'vc1', usagePct: pct, freeGB: 10 }] });
  const firingKeys = () => alerts.alertStatus().firing.map((f) => f.key);
  store.snapshot = ds(96);
  await alerts._refreshStateForTest(cfg, false);
  assert.deepEqual(firingKeys(), ['ds:dsX']);
  const ev = alerts.evaluate(ds(null), cfg);
  assert.equal(ev.length, 0, 'null 은 초과가 아니다');
  assert.ok(ev.held.has('ds:dsX'), 'null 은 판정 보류');
  store.snapshot = ds(null);
  await alerts._refreshStateForTest(cfg, false);
  assert.deepEqual(firingKeys(), ['ds:dsX'], '못 읽은 주기에 해소로 보내면 안 된다');
  assert.ok(!alerts.alertStatus().recent.some((r) => r.severity === 'resolved'), '해소 알림 없음');
  store.snapshot = ds(50);
  await alerts._refreshStateForTest(cfg, false);
  assert.deepEqual(firingKeys(), [], '값을 읽고 임계 아래면 해소');
  alerts._resetAlertStateForTest();
});

test('RECENT2598-03 — 소스: 결측을 0 으로 읽는 형태가 남지 않았다', () => {
  const a = stripComments(fs.readFileSync(path.join(SRC, 'alerts.js'), 'utf8'));
  assert.ok(!/\(x\.usagePct \|\| 0\) >= th/.test(a));
  const s = stripComments(fs.readFileSync(path.join(SRC, 'metrics/sampler.js'), 'utf8'));
  assert.ok(!/const used = Number\(d\.usedGB\) \|\| 0;/.test(s));
});
