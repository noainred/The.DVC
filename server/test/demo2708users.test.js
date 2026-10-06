/**
 * v2.708 데모(mock) — '사용자·게스트' 묶음(mock/demo/users.js) 회귀.
 *
 * ① 결정성: 같은 (입력, 시각) 은 같은 값 · 시간이 흐르면 값이 바뀐다
 * ② mock 이 아니면 무동작(설정 그대로 · 시드 0 · 망 이슈 합성 0)
 * ③ Horizon 시드는 등록부가 비어 있을 때만 · `mock-` 접두 · 데모 등록에는 로그인하지 않는다
 * ④ 합성 결과가 실수집과 같은 판정 함수를 통과한다(세션 해석·누적 쌍·로그인 실패 판정·스파이크 저장 형식)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo2708users-'));
process.env.CONFIG_DIR = dir;

const rt = await import('../src/runtime-settings.js');
const users = await import('../src/mock/demo/users.js');
const { normalizeSessions } = await import('../src/horizon/sessions.js');
const { normalizeCatalog, usageFromSessions } = await import('../src/horizon/appUsage.js');
const { isLoginFailRow } = await import('../src/logs/loginFailPattern.js');
const { VM_COUNTERS, HOST_COUNTERS } = await import('../src/vmseries/counters.js');
const { packMoments, unpackMoments } = await import('../src/vmseries/spikes.js');

const setMode = (m) => rt.setDataSource ? rt.setDataSource(m) : rt.saveRuntimeSettings?.({ dataSource: m });
const NOW = Math.floor(Date.UTC(2026, 9, 6, 5, 0, 0) / 3_600_000) * 3_600_000 - 30 * 60_000;   // 정시 −30분(경계에서 떨어뜨린 고정 시각)

const vms = Array.from({ length: 40 }, (_, i) => ({
  id: `vc-a:vm-${i}`, vcenterId: 'vc-a', name: `vm-${i}`, powerState: 'POWERED_ON', toolsStatus: 'RUNNING',
  guestOS: i % 2 ? 'Windows Server 2022' : 'Red Hat Enterprise Linux 9', storageGB: 120 + i, cpuCount: 4, memMB: 8192, host: 'esx-1', cluster: 'c1',
}));
const snap = { vcenters: [{ id: 'vc-a', name: 'A' }, { id: 'vc-b', name: 'B' }], vms, hosts: [{ id: 'vc-a:esx-1', vcenterId: 'vc-a', name: 'esx-1' }] };

test('① 결정성 — 같은 입력·시각은 같은 값, 시간대 곡선은 0~1', () => {
  const t = vms.slice(0, 20).map((v) => ({ vmId: v.id, vcenterId: v.vcenterId, name: v.name }));
  assert.deepEqual(users.demoCurUserRecords(t, { now: NOW }), users.demoCurUserRecords(t, { now: NOW }));
  assert.deepEqual(users.demoHorizonSessionsRaw('mock-hz-cs01', NOW), users.demoHorizonSessionsRaw('mock-hz-cs01', NOW));
  assert.deepEqual(users.demoGuestDiskVms('vc-a', vms, NOW), users.demoGuestDiskVms('vc-a', vms, NOW));
  assert.deepEqual(users.demoLoginFailEvents('vc-a', NOW - 86_400_000, NOW), users.demoLoginFailEvents('vc-a', NOW - 86_400_000, NOW));
  for (let h = 0; h < 48; h++) { const f = users.diurnal(NOW + h * 3_600_000); assert.ok(f >= 0 && f <= 1); }
  // 일부 서버는 정직 분기(no-agent·guest-error·stale)로 남는다
  const kinds = new Set(users.demoCurUserRecords(vms.map((v) => ({ vmId: v.id, vcenterId: 'vc-a' })), { now: NOW }).map((r) => r.kind));
  assert.ok(kinds.has('ok'));
  assert.ok([...kinds].some((k) => k !== 'ok'), '정직 분기(no-agent·stale·guest-error)가 하나도 없다');
});

test('② mock 이 아니면 무동작', async () => {
  setMode('live');
  assert.equal(users.isMockMode(), false);
  const s = { enabled: false, vcenters: {} };
  assert.equal(users.demoCurUserSettings(s, snap), s);
  users._resetDemoUsersForTest();
  const hz = await import('../src/horizon/horizon.js');
  assert.equal(await users.ensureDemoHorizonSeed(hz), 0);
  assert.equal(hz.loadHorizon().length, 0);
});

test('③ mock — 설정은 켜진 것처럼(저장 X), Horizon 시드는 비어 있을 때만 · mock- 접두 · 접속 안 함', async () => {
  setMode('mock');
  assert.equal(users.isMockMode(), true);
  const s = users.demoCurUserSettings({ enabled: false, vcenters: {} }, snap);
  assert.equal(s.enabled, true); assert.equal(s.demo, true);
  assert.deepEqual(Object.keys(s.vcenters).sort(), ['vc-a', 'vc-b']);
  // 실제로 폴더를 지정한 vCenter 는 그 범위를 그대로 쓴다
  const kept = users.demoCurUserSettings({ enabled: true, vcenters: { 'vc-a': { enabled: true, folders: ['X'] } } }, snap);
  assert.deepEqual(kept.vcenters['vc-a'].folders, ['X']);

  const hz = await import('../src/horizon/horizon.js');
  users._resetDemoUsersForTest();
  assert.equal(await users.ensureDemoHorizonSeed(hz), 2);
  const list = hz.loadHorizon();
  assert.equal(list.length, 2);
  assert.ok(list.every((x) => x.id.startsWith('mock-')));
  users._resetDemoUsersForTest();
  assert.equal(await users.ensureDemoHorizonSeed(hz), 0, '두 번째 시드는 하지 않는다(비어 있지 않다)');
  await assert.rejects(() => hz.withHorizonSession(list[0], async () => 1), /데모\(mock\) 등록/);
  // live 로 바꾸면 데모 등록은 수집 대상에서 빠진다
  const { targetServers } = await import('../src/horizon/sessionPoller.js');
  assert.equal(targetServers({ servers: {} }).length, 2);
  setMode('live');
  assert.equal(targetServers({ servers: {} }).length, 0);
  setMode('mock');
});

test('③-b 실등록이 있으면 시드하지 않는다', async () => {
  const hz = await import('../src/horizon/horizon.js');
  for (const s of hz.loadHorizon()) hz.removeHorizon(s.id);
  hz.upsertHorizon({ id: 'real-cs', host: 'https://10.1.2.3', username: 'u', domain: 'D', password: 'p' });
  users._resetDemoUsersForTest();
  assert.equal(await users.ensureDemoHorizonSeed(hz), 0);
  assert.deepEqual(hz.loadHorizon().map((x) => x.id), ['real-cs']);
  hz.removeHorizon('real-cs');
});

test('④ 합성 결과가 실수집 판정 함수를 통과한다', async () => {
  // Horizon — 계정·상태 키를 읽고, 서비스 해석 근거가 여러 갈래로 나온다
  const raw = users.demoHorizonSessionsRaw('mock-hz-cs01', NOW);
  const norm = normalizeSessions(raw);
  assert.equal(norm.parsed, true); assert.equal(norm.usedUserKey, 'user_name'); assert.equal(norm.usedStateKey, 'session_state');
  assert.ok(norm.connected > 0);
  const cat = normalizeCatalog(users.demoHorizonCatalogRaw());
  const u = usageFromSessions(raw, { usedUserKey: norm.usedUserKey, usedStateKey: norm.usedStateKey, catalog: cat });
  assert.ok(u.services.length >= 3);
  assert.ok(u.basisCounts['app-pool'] > 0 && u.basisCounts['desktop-pool'] > 0);
  // 백필 — 하루 수집 횟수는 하루/주기(일부만 수집으로 보이지 않게)
  const bf = await users.demoHorizonBackfillRows({
    serverIds: ['mock-hz-cs01'], now: NOW, seriesDays: 1, usageDays: 2, intervalMs: 300_000,
    normalize: (r) => normalizeSessions(r), usageOf: (r, n) => usageFromSessions(r, { usedUserKey: n.usedUserKey, usedStateKey: n.usedStateKey, catalog: cat }),
  });
  assert.ok(bf.series.length > 200 && bf.usage.length > 0);
  const full = bf.cover.filter((c) => c.lastTs - c.firstTs >= 86_000_000);
  assert.ok(full.every((c) => c.cycles === 288));

  // 로그인 실패 — 실분석의 판정(정규식)에 걸리고 메시지에서 출발지 IP 를 뽑을 수 있다
  const ev = users.demoLoginFailEvents('vc-a', NOW - 7 * 86_400_000, NOW);
  assert.ok(ev.length > 10);
  assert.ok(ev.every((e) => isLoginFailRow(e) && /\d+\.\d+\.\d+\.\d+/.test(e.message)));
  assert.equal(new Set(ev.map((e) => e.key)).size, ev.length);

  // 게스트 디스크 — 사용량 ≤ 용량, 비율 0~100
  const gd = users.demoGuestDiskVms('vc-a', vms, NOW);
  assert.ok(gd.length > 20);
  for (const v of gd) { assert.ok(v.usedGB <= v.allocGB); assert.ok(v.ratioPct >= 0 && v.ratioPct <= 100); }

  // 실제 OS — 일부 불일치·일부 실패
  const os_ = vms.map((v) => users.demoRealOs(v));
  assert.ok(os_.some((r) => r.detected) && os_.some((r) => !r.detected));

  // 망 이슈 — 소수 VM, 레코드 모양
  const ni = users.demoNetIssues({ vms: Array.from({ length: 400 }, (_, i) => ({ ...vms[0], id: `vc-a:n${i}`, name: `n${i}` })) }, { now: NOW, days: 7 });
  assert.ok(ni.length > 0 && ni.every((r) => r.newDrop >= 0 && r.ts <= NOW + 3_600_000));

  // 스파이크 — 저장 형식이 unpack 으로 되돌아오고, 미래 순간은 없다
  const vs = users.demoVmSeriesRows({ vcenterId: 'vc-a', vms, hosts: snap.hosts, fromTs: NOW - 2 * 86_400_000, toTs: NOW, vmCols: VM_COUNTERS, hostCols: HOST_COUNTERS, pack: packMoments, thresholds: { cpuPct: 50, memPct: 50 } });
  assert.ok(vs.spikes.length > 0 && vs.cover.length > 0);
  for (const s of vs.spikes) {
    assert.ok(s.t1 <= NOW);
    const m = unpackMoments(s.buf, s.t0, s.cols.length);
    assert.equal(m.length, s.n);
  }
});

test('⑤ mock 이 아니면 망 이슈 합성 0 · 데모 모듈 파일에 접속 코드 없음', async () => {
  setMode('live');
  const { analyzeNetIssues } = await import('../src/security/netIssueStore.js');
  const r = analyzeNetIssues({ days: 7 });
  assert.equal(r.summary.total, 0);
  assert.equal(r.demo, undefined);
  const src = fs.readFileSync(new URL('../src/mock/demo/users.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bfetch\(|net\.connect|withSsh|VimSoapClient/);
  setMode('mock');
});

test('⑥ 실제 OS 불일치 — Windows 는 연도로 비교한다(메이저 숫자 2022≠10 오판 수정)', async () => {
  const { computeMismatch } = await import('../src/inventory/osStore.js');
  const det = (os, v) => ({ os, family: 'Windows', osVersion: v });
  assert.equal(computeMismatch('Microsoft Windows Server 2022 (64-bit)', det('Microsoft Windows Server 2022 Standard', '10.0.20348')), false);
  assert.equal(computeMismatch('Microsoft Windows Server 2022 (64-bit)', det('Microsoft Windows Server 2019 Standard', '10.0.17763')), true);
  assert.equal(computeMismatch('Microsoft Windows Server 2016 or later (64-bit)', det('Microsoft Windows Server 2022 Datacenter', '10.0.20348')), false);
  assert.equal(computeMismatch('Microsoft Windows Server 2016 or later (64-bit)', det('Microsoft Windows Server 2012 R2', '6.3.9600')), true);
  assert.equal(computeMismatch('Microsoft Windows 10 (64-bit)', det('Windows (build 19045)', '10.0.19045')), false);
  // 데모 합성 — 일치 갈래는 실제로 '일치' 로 판정된다(불일치는 약 1/6 만)
  const sample = Array.from({ length: 300 }, (_, i) => ({ id: `x:${i}`, guestOS: ['Red Hat Enterprise Linux 9', 'Ubuntu Server 22.04', 'Windows Server 2022', 'Windows Server 2019', 'CentOS Stream 9', 'SUSE Linux Enterprise 15', 'Debian 12'][i % 7] }));
  const rows = sample.map((v) => ({ v, r: users.demoRealOs(v) })).filter((x) => x.r.detected);
  const mm = rows.filter((x) => computeMismatch(x.v.guestOS, x.r.detected)).length;
  assert.ok(mm > 0 && mm / rows.length < 0.3, `불일치 비율 ${mm}/${rows.length}`);
});

test('⑦ 현재 사용자 백필 — 전체(합집합)는 법인 합이 아니라 전체 고유 계정 기준', () => {
  const recs = users.demoCurUserRecords(vms.map((v, i) => ({ vmId: v.id, vcenterId: i % 2 ? 'vc-a' : 'vc-b' })), { now: NOW });
  const uniq = new Set(recs.filter((r) => r.ok).flatMap((r) => r.users.map((u) => u.name.toLowerCase()))).size;
  const rows = users.demoCurUserBackfillRows(recs, { now: NOW, days: 2, intervalMs: 600_000 });
  assert.ok(rows.length > 250);
  for (const r of rows) {
    const tot = r.series.find((x) => x.vcenterId === '');
    const sum = r.series.filter((x) => x.vcenterId !== '').reduce((a, x) => a + x.users, 0);
    assert.ok(tot.users <= sum && tot.users <= uniq * 2, `${tot.users} vs sum ${sum} uniq ${uniq}`);
  }
});
