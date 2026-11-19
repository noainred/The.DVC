/**
 * 전체 점검 32회차(vCenter 점검 기능) 회귀.
 *  F1 · F3: VMware Tools 분포 — '오래됨' 은 toolsVersionStatus(VM 신호와 같은 집합) · 못 읽은 VM 은 '미수집' · 업그레이드 id 는 켜진 VM · 템플릿 제외 · 상한 표지.
 *  F2: /tools/vm-hygiene 본 응답도 범위 계정에 예외 원문을 주지 않는다(/settings 와 같은 가림).
 *  F4 · E2: 상한으로 잘린 CSV 는 파일 · 헤더에 밝힌다. E1: Tools 업그레이드 요청 VM 수 상한.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { vmToolsDistribution, TOOLS_IDS_MAX, TOOLS_UNREAD_VERSION } from '../src/inventory/vmToolsDist.js';
import { vmSignalsOf } from '../src/inventory/vmSignals.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

test('F1: 실 SOAP 모양 VM 의 오래됨은 toolsVersionStatus 로 센다 — VM 신호 toolsOld 와 같은 수', () => {
  const vms = [
    { id: 'vc:vm-1', toolsStatus: 'RUNNING', toolsVersion: '11365', toolsVersionStatus: 'guestToolsNeedUpgrade', powerState: 'POWERED_ON' },
    { id: 'vc:vm-2', toolsStatus: 'RUNNING', toolsVersion: '11365', toolsVersionStatus: 'guestToolsSupportedOld', powerState: 'POWERED_ON' },
    { id: 'vc:vm-3', toolsStatus: 'NOT_RUNNING', toolsVersion: '12352', toolsVersionStatus: 'guestToolsTooOld', powerState: 'POWERED_OFF' },
    { id: 'vc:vm-4', toolsStatus: 'RUNNING', toolsVersion: '12352', toolsVersionStatus: 'guestToolsCurrent', powerState: 'POWERED_ON' },
    { id: 'vc:tpl', toolsStatus: 'NOT_RUNNING', toolsVersion: '12352', toolsVersionStatus: 'guestToolsNeedUpgrade', powerState: 'POWERED_OFF', template: true },
  ];
  const rows = vmToolsDistribution(vms);
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  const sig = vms.filter((v) => vmSignalsOf(v).includes('toolsOld')).length;
  assert.equal(sum('outdated'), 2);
  assert.equal(sum('outdated'), sig, '판정 코어가 VM 신호와 같다');
  // 칸은 겹치지 않는다
  for (const r of rows) assert.equal(r.running + r.outdated + r.notRunning + r.unknown, r.count, JSON.stringify(r));
  const v11 = rows.find((r) => r.version === '11365');
  assert.deepEqual({ running: v11.running, outdated: v11.outdated }, { running: 1, outdated: 1 });
});

test('F1: Tools 필드를 읽지 못한 VM(REST 폴백)은 버전 없음이 아니라 미수집 — 업그레이드 대상 아님', () => {
  const rows = vmToolsDistribution([
    { id: 'vc:r1', powerState: 'POWERED_ON' },
    { id: 'vc:r2', powerState: 'POWERED_ON' },
    { id: 'vc:s1', toolsStatus: 'NOT_RUNNING', toolsVersion: '', toolsVersionStatus: 'guestToolsNotInstalled', powerState: 'POWERED_ON' },
  ]);
  const un = rows.find((r) => r.version === TOOLS_UNREAD_VERSION);
  assert.ok(un && un.unread === true && un.count === 2 && un.unknown === 2 && un.notRunning === 0, JSON.stringify(un));
  assert.deepEqual(un.ids, [], '못 읽은 VM 은 업그레이드 요청에 넣지 않는다');
  const none = rows.find((r) => r.version === '없음');
  assert.equal(none.count, 1, "SOAP 이 읽은 '' 만 버전 없음");
});

test('F3: 업그레이드 id 는 켜진 VM · 템플릿 제외, 상한을 넘으면 표지와 전체 대상 수', () => {
  const vms = [];
  for (let i = 0; i < 2600; i++) vms.push({ id: `vc:vm-${i}`, toolsStatus: 'RUNNING', toolsVersion: '12352', toolsVersionStatus: 'guestToolsCurrent',
    powerState: i % 10 === 0 ? 'POWERED_OFF' : 'POWERED_ON', template: i % 50 === 1 });
  const [r] = vmToolsDistribution(vms);
  const byId = new Map(vms.map((v) => [v.id, v]));
  assert.equal(r.count, 2600);
  assert.equal(r.upgradable, 2600 - 260 - 52);
  assert.equal(r.ids.length, TOOLS_IDS_MAX);
  assert.equal(r.idsTruncated, true);
  assert.ok(r.ids.every((id) => byId.get(id).powerState === 'POWERED_ON' && byId.get(id).template !== true));
});

test('E1 · F4 · E2: 소스 계약 — 업그레이드 요청 상한 · 잘린 CSV 표지', () => {
  const up = read('routes/api/toolsInfo.js');
  assert.match(up, /if \(ids\.length > TOOLS_IDS_MAX\) return res\.status\(400\)/);
  for (const f of ['routes/api/migrationReadiness.js', 'routes/api/vmAvailability.js']) {
    const s = read(f);
    assert.match(s, /if \(r\.omitted\) \{ lines\.push\(csvLine\(\[`\(상한으로 \$\{r\.omitted\}행 생략/, f);
    assert.match(s, /res\.setHeader\('X-Omitted-Rows', String\(r\.omitted\)\)/, f);
  }
  assert.match(read('routes/api/costShowback.js'), /if \(r\.groupsOmitted\) \{ lines\.push/);
});

test('F2 · F1 · E1: 실제 라우터 — 범위 계정의 VM 구성 점검 본 응답 가림 · Tools 분포 · 업그레이드 상한', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcaudit32-'));
  fs.writeFileSync(path.join(dir, 'permissions.json'), JSON.stringify({ schemaVersion: 3, matrix: {
    operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
  const script = `
    const express = (await import('express')).default;
    const { store } = await import(${JSON.stringify(path.join(SRC, 'store.js'))});
    await store.refresh?.();
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const { saveVmHygieneSettings } = await import(${JSON.stringify(path.join(SRC, 'vmhygiene/settings.js'))});
    const snap = store.get();
    const first = (snap.vcenters || [])[0].id;
    const users = { admin: { username: 'a', role: 'admin', scope: null }, scopedViewer: { username: 'sv', role: 'viewer', scope: { vcenters: [first] } } };
    const app = express(); app.use(express.json({ limit: '5mb' }));
    let who = 'admin';
    app.use((req, _r, n) => { req.user = users[who]; n(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port + '/api';
    const call = async (u, p, body) => { who = u; const r = await fetch(base + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { s: r.status, j, t }; };
    const out = {};
    saveVmHygieneSettings({ exceptions: ['corpB-erp-db', 'other-corp-x'] }, 'fleet-admin-name');
    const ah = await call('admin', '/tools/vm-hygiene');
    out.admin = { s: ah.s, ex: ah.j?.settings?.exceptions };
    const sh = await call('scopedViewer', '/tools/vm-hygiene');
    out.scoped = { s: sh.s, ex: sh.j?.settings?.exceptions, n: sh.j?.settings?.exceptionsCount, hidden: sh.j?.settings?.exceptionsHidden, leak: sh.t.includes('corpB-erp-db') || sh.t.includes('other-corp-x'), snapAgeDays: sh.j?.settings?.snapAgeDays };
    const vt = await call('admin', '/tools/vmtools');
    const byId = new Map(snap.vms.map((v) => [v.id, v]));
    const rows = vt.j?.versions || [];
    out.tools = { s: vt.s, outdated: rows.reduce((a, r) => a + r.outdated, 0), offInIds: rows.flatMap((r) => r.ids).filter((id) => byId.get(id)?.powerState !== 'POWERED_ON' || byId.get(id)?.template === true).length, idsMax: vt.j?.idsMax };
    const many = Array.from({ length: 2001 }, (_, i) => snap.vms[i % snap.vms.length].id);
    const up = await call('admin', '/vms/upgrade-tools', { ids: many });
    out.up = { s: up.s, reason: up.j?.reason || '' };
    srv.close();
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true' }, encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, (r.stderr || '').slice(-2000));
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, r.stdout.slice(-800));
  const o = JSON.parse(line.slice(2));
  assert.equal(o.admin.s, 200);
  assert.deepEqual(o.admin.ex, ['corpB-erp-db', 'other-corp-x'], '전체 범위는 그대로');
  assert.equal(o.scoped.s, 200);
  assert.deepEqual(o.scoped.ex, []);
  assert.equal(o.scoped.n, 2);
  assert.equal(o.scoped.hidden, true);
  assert.equal(o.scoped.leak, false, '본 응답으로도 예외 원문이 나가지 않는다');
  assert.equal(typeof o.scoped.snapAgeDays, 'number', '임계값은 그대로');
  assert.equal(o.tools.s, 200);
  assert.ok(o.tools.outdated > 0, '목 데이터의 업그레이드 필요 VM 이 오래됨으로 잡힌다');
  assert.equal(o.tools.offInIds, 0, '꺼진 VM · 템플릿은 업그레이드 id 에 없다');
  assert.equal(o.tools.idsMax, 2000);
  assert.equal(o.up.s, 400);
  assert.match(o.up.reason, /2000대까지/);
});
