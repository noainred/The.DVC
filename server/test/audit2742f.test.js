// v2.742 1회차 GE2 — 끊긴 호스트 온도 · 실제 OS 인벤토리 정리 · 내보내기 zip 압축 · 유령 스냅샷 후보.
//
// VC-02  끊긴(DISCONNECTED·NOT_RESPONDING) ESXi 호스트의 센서 온도를 현재값으로 적재(temp_host·클러스터·vCenter 평균)하고 서버 온도 화면의
//        요약·ESXi 호스트별 표·클러스터/vCenter 집계에 넣었다 — 같은 호스트의 전력(host-unread)·CPU(host_cpu_pct)는 이미 빼는데 온도만 남았다.
//        판정은 store.usageReadable 하나(복제 금지). 행에는 남기되 오래됨(사유 host-disconnected)이고 '연결 끊김 N대' 로 센다.
// VC-04  실제 OS 인벤토리 스캔 끝의 정리(pruneMissing)가 '스냅샷 VM 목록에 없는 기록' 을 전부 지웠다 — 첫 수집 중·첫 병합 전 골격·연결 실패
//        (lastGood 만료)·재시작 직후 인증 정지 vCenter 의 OS 탐지 기록이 사라졌다. 실패 upsert 는 직전 탐지 OS·불일치를 ''·false 로 덮었다.
// LEFT-05·DB-05  /tools/waste/export 의 zipMany 가 항목마다 deflateRawSync 를 양보 없이 불러 메인 스레드를 멈췄다 → zipManyAsync(바이트 동일).
// RECENT-03·VC-09  유령 스냅샷 후보가 파일 이름 규칙 하나로 warn 이었다 — 같은 VM 의 vCenter '통합 필요' 가 true 일 때만 warn, 그 밖은 info.
//
// 기준 시각은 Date.now() 를 쓰지 않는다(정시 −30분 고정 — CLAUDE.md v2.517 규약). 라우트 하니스(자식 프로세스)는 라우트가 스스로 시각을 잡는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2742f-'));
process.env.CONFIG_DIR = TMP;
process.env.TEMP_DB_PATH = path.join(TMP, 'host-temp.db');
process.env.DATA_SOURCE = 'live';   // OS 스캔은 live 경로(runOsScanNowInner)를 탄다 — 로그인 대상이 없도록 스냅샷을 직접 꾸민다
const TMP_DIRS = [TMP];
after(() => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

const H = 3_600_000;
const NOW = Math.floor(1_800_000_000_000 / H) * H - 30 * 60_000;

const { store, usageReadable } = await import('../src/store.js');
const { buildServerTempReport, HOST_DISCONNECTED } = await import('../src/tools/serverTemp.js');

/* ── VC-02 ──────────────────────────────────────────────────────────────── */

const host = (id, vcenterId, connectionState, tempC, cluster = 'c1') => ({ id, vcenterId, name: `esx-${id}`, cluster, connectionState, tempC, tempMaxC: tempC + 5, temps: [] });

test('VC-02 ① 서버 온도 보고서 — 끊긴 호스트의 ESXi 대체 행은 오래됨(host-disconnected)이고 요약·법인 표에서 빠지며 개수로 밝힌다', () => {
  const hosts = [
    host('h1', 'vc-a', 'CONNECTED', 24),
    host('h2', 'vc-a', 'NOT_RESPONDING', 41),
    host('h3', 'vc-a', 'DISCONNECTED', 39),
    host('h4', 'vc-b', 'NOT_RESPONDING', 50),
  ];
  const rep = buildServerTempReport({ idracServers: [], hosts, hostReadable: usageReadable, unreadVcenters: new Map([['vc-b', 'unreachable']]) });
  const by = Object.fromEntries(rep.rows.map((r) => [r.id, r]));
  assert.equal(by.h1.stale, false);
  assert.equal(by.h2.stale, true, '끊긴 호스트의 마지막 센서 값을 지금 온도로 보이지 않는다');
  assert.equal(by.h2.staleReason, HOST_DISCONNECTED);
  assert.equal(by.h3.staleReason, 'host-disconnected');
  assert.equal(by.h4.staleReason, 'unreachable', 'vCenter 사유가 먼저다(조치가 다르다)');
  assert.equal(by.h2.curC, 41, '행(표)에는 마지막 값을 남긴다(오래됨 표지와 함께)');
  assert.equal(rep.summary.all.reporting, 1);
  assert.equal(rep.summary.all.avgC, 24);
  assert.equal(rep.summary.all.curMaxC, 24, '41℃·39℃ 가 최고로 보고되지 않는다');
  assert.equal(rep.summary.all.staleExcluded, 3);
  assert.equal(rep.counts.stale, 3);
  assert.equal(rep.counts.disconnected, 2, '연결 끊김은 따로 센다(vCenter 사유로 빠진 h4 는 넣지 않는다)');
  assert.equal(rep.byDatacenter.find((d) => d.key === 'vc-a').all.avgC, 24);
  // 인자를 안 주면 예전 그대로(구버전 호출 호환)
  const old = buildServerTempReport({ idracServers: [], hosts });
  assert.equal(old.rows.every((r) => r.stale === false), true);
  assert.equal(old.counts.disconnected, 0);
});

test('VC-02 ② iDRAC 행은 ESXi 연결과 무관하다 — 받침 호스트가 끊겨도 iDRAC 값은 그대로 집계된다', () => {
  const hosts = [{ ...host('h9', 'vc-a', 'NOT_RESPONDING', 45), serviceTag: 'TAG9' }];
  const srv = [{ id: 'srv-9', name: 'srv9', serviceTag: 'TAG9', remote: true, sensors: { t: NOW, temps: { 'Inlet Temp': 22, 'CPU1 Temp': 55 } } }];
  const rep = buildServerTempReport({ idracServers: srv, hosts, latestOf: (s) => s.sensors, maxAgeMs: 0, hostReadable: usageReadable, now: NOW });
  assert.equal(rep.rows.length, 1, 'iDRAC 행이 그 호스트를 점유한다(ESXi 대체 행 없음)');
  assert.equal(rep.rows[0].source, 'idrac');
  assert.equal(rep.rows[0].stale, false);
  assert.equal(rep.summary.all.avgC, 22);
  assert.equal(rep.counts.disconnected, 0);
});

test('VC-02 ③ 실제 샘플 1회 — 끊긴 호스트의 온도는 temp_host·클러스터·vCenter 평균에 적재하지 않고 lastRun 에 개수를 싣는다', async () => {
  const sampler = await import('../src/metrics/sampler.js');
  const metricsDb = await import('../src/metrics/db.js');
  store.snapshot = {
    generatedAt: new Date(NOW).toISOString(),
    vcenters: [{ id: 'vc-t', name: 'vc-t', status: 'connected' }],
    hosts: [
      { id: 'vc-t:h-ok', vcenterId: 'vc-t', name: 'h-ok', cluster: 'cl', connectionState: 'CONNECTED', tempC: 24 },
      { id: 'vc-t:h-down', vcenterId: 'vc-t', name: 'h-down', cluster: 'cl', connectionState: 'NOT_RESPONDING', tempC: 60 },
    ],
    vms: [], datastores: [], alarms: [],
  };
  await sampler._sampleOnceForTest();
  const st = sampler.metricsSamplerStatus();
  assert.ok(st.lastRun, '샘플이 돌지 않았다');
  assert.equal(st.lastRun.hostsWithTemp, 1);
  assert.equal(st.lastRun.tempHostsDisconnected, 1, '뺀 호스트 수를 밝힌다(조용한 제외 금지)');
  const db = await metricsDb.getMetricsDb();
  const hostLatest = db.latestAll('temp_host');
  assert.ok(hostLatest.has('vc-t:h-ok'));
  assert.equal(hostLatest.has('vc-t:h-down'), false, '끊긴 호스트의 마지막 센서 값이 지금 값으로 적재됐다');
  const vcLatest = db.latestAll('temp_vc').get('vc-t');
  const clLatest = db.latestAll('temp_cluster').get('vc-t|cl');
  const v = (x) => (x && typeof x === 'object' ? x.v : x);
  assert.equal(v(vcLatest), 24, 'vCenter 평균에 60℃ 가 섞이지 않는다(예전 42)');
  assert.equal(v(clLatest), 24);
});

/** 실제 api 라우터를 자식 프로세스(mock)로 띄운다 — 라우트가 store 를 스스로 읽는다. */
function runChild(script, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2742f-rt-'));
  TMP_DIRS.push(dir);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, TEMP_DB_PATH: path.join(dir, 'host-temp.db'), DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', ...extraEnv },
    encoding: 'utf8', cwd: SERVER_DIR, timeout: 150_000, maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${String(r.stderr).slice(-1500)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, r.stdout.slice(-400));
  return JSON.parse(line.slice(2));
}
const SERVE = `
  const express = (await import('express')).default;
  const { api } = await import('./src/routes/api.js');
  const app = express();
  app.use((req, _res, next) => { req.user = { username: 'admin', role: 'admin' }; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
`;

test('VC-02 ④ 라우트 /tools/esxi-temp — 끊긴 호스트는 행·호스트 목록이 오래됨이고 클러스터·vCenter 현재값에서 빠지며 disconnectedHosts 로 센다', () => {
  const o = runChild(`
    console.log = () => {}; console.warn = () => {};
    const { store } = await import('./src/store.js');
    await store.refresh({ force: true });
    const snap = store.get();
    const vc = snap.vcenters.map((v) => v.id).find((id) => (snap.hosts || []).filter((h) => h.vcenterId === id && h.tempC != null && h.connectionState === 'CONNECTED').length >= 2);
    const hs = snap.hosts.filter((h) => h.vcenterId === vc && h.tempC != null && h.connectionState === 'CONNECTED');
    const down = hs[0];
    down.connectionState = 'NOT_RESPONDING';
    down.tempC = 77; down.tempMaxC = 80;   // 다른 값보다 확실히 높게 — 집계에 섞이면 최고·평균이 바뀐다
    snap.source = 'live-test';   // mock 이면 라우트가 iDRAC 합성 보고서로 바꿔 첫 보고서(실운영 경로)를 보지 못한다
    ${SERVE}
    const r = await fetch(base + '/api/tools/esxi-temp');
    const b = await r.json();
    srv.close();
    process.stdout.write('@@' + JSON.stringify({ status: r.status, vc, downId: down.id, cluster: down.cluster || 'standalone', b }) + '\\n');
    process.exit(0);
  `);
  assert.equal(o.status, 200);
  const b = o.b;
  const row = b.idrac.rows.find((r) => r.id === o.downId);
  assert.ok(row, '끊긴 호스트도 행은 남는다');
  assert.equal(row.stale, true);
  assert.equal(row.staleReason, 'host-disconnected');
  assert.ok(b.idrac.counts.disconnected >= 1);
  const h = b.hosts.find((x) => x.id === o.downId);
  assert.equal(h.stale, true);
  assert.equal(h.staleReason, 'host-disconnected');
  assert.ok(b.disconnectedHosts >= 1, '연결 끊김 호스트 수를 싣는다');
  assert.ok(b.staleHosts >= b.disconnectedHosts);
  const vcRow = b.vcenters.find((g) => g.key === o.vc);
  assert.ok(vcRow.staleHosts >= 1);
  assert.ok(vcRow.curC < 77, `vCenter 집계 현재값에 77℃ 가 섞였다: ${vcRow.curC}`);
  const clRow = b.clusters.find((g) => g.key === `${o.vc}|${o.cluster}`);
  assert.ok(clRow && clRow.staleHosts >= 1);
  assert.ok(clRow.curC == null || clRow.curC < 77);
  assert.ok(!(b.idrac.summary.all.curMaxC >= 77), '서버 온도 요약 최고에 끊긴 호스트 값이 들어가지 않는다');
});

/* ── VC-04 ──────────────────────────────────────────────────────────────── */

const osStore = await import('../src/inventory/osStore.js');
const osScanner = await import('../src/inventory/osScanner.js');
const vm = (vcenterId, id, guestOS = 'Red Hat Enterprise Linux 8 (64-bit)') => ({ id: `${vcenterId}:${id}`, name: id, vcenterId, host: 'esx1', cluster: 'c', guestOS, powerState: 'POWERED_ON', toolsStatus: 'NOT_RUNNING' });
const RHEL9 = { os: 'Red Hat Enterprise Linux 9.2', osVersion: '9.2', family: 'RHEL', osId: 'rhel', kernel: '5.14' };

function seedVcenters(ids) {
  fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: ids.map((id) => ({ id, name: id, host: `https://${id}.invalid`, username: 'u', password: 'p' })) }));
}

test('VC-04 ① 스캔 끝 정리 — 지워진 vCenter·온전히 읽은 vCenter 에서 사라진 VM 만 지우고, 첫 수집 중·연결 실패·낡은 위임 vCenter 의 기록은 남긴다', async () => {
  seedVcenters(['vc-ok', 'vc-pend', 'vc-down', 'vc-stale']);
  for (const v of [vm('vc-ok', 'keep'), vm('vc-ok', 'gone'), vm('vc-pend', 'p1'), vm('vc-down', 'd1'), vm('vc-stale', 's1'), vm('vc-removed', 'r1')]) osStore.upsertOs(v, RHEL9);
  store.snapshot = {
    generatedAt: new Date(NOW).toISOString(),
    vcenters: [
      { id: 'vc-ok', status: 'connected' },
      { id: 'vc-pend', status: 'pending' },              // 첫 수집 중 — VM 0개
      { id: 'vc-down', status: 'unreachable' },          // lastGood 만료 — 인벤토리 비움
      { id: 'vc-stale', status: 'connected', stale: true }, // 낡은 위임
    ],
    hosts: [], datastores: [], alarms: [],
    vms: [vm('vc-ok', 'keep')],   // Tools 가 꺼져 있어 스캔 대상(로그인)은 없다 — 정리만 돈다
  };
  const r = await osScanner.runOsScanNow(undefined, { trigger: 'auto' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const ids = new Set(osStore.getOsResults().map((x) => x.vmId));
  assert.ok(ids.has('vc-ok:keep'));
  assert.equal(ids.has('vc-ok:gone'), false, '온전히 읽은 vCenter 에서 사라진 VM 은 지운다');
  assert.equal(ids.has('vc-removed:r1'), false, '등록에서 지워진 vCenter 의 기록은 지운다');
  assert.ok(ids.has('vc-pend:p1'), '첫 수집 중(VM 0개) vCenter 의 기록을 지웠다 — 게스트 로그인을 다시 해야 한다');
  assert.ok(ids.has('vc-down:d1'), '연결 실패로 인벤토리가 빈 vCenter 의 기록을 지웠다');
  assert.ok(ids.has('vc-stale:s1'), '낡은 위임 vCenter 의 기록을 지웠다');
});

test('VC-04 ② 첫 병합 전 골격(initial) — VM 단위 정리를 하지 않는다 · 스냅샷이 없으면 아무것도 지우지 않는다 · 등록부를 못 읽으면 vCenter 단위 정리를 하지 않는다', () => {
  osStore.upsertOs(vm('vc-ok', 'x1'), RHEL9);
  osStore.upsertOs(vm('vc-gone2', 'y1'), RHEL9);
  const skel = { initial: true, vcenters: [{ id: 'vc-ok', status: 'pending' }], vms: [] };
  const a = osStore.pruneMissing(skel, { registryIds: ['vc-ok', 'vc-gone2'] });   // (앞 시험의 다른 vCenter 기록은 등록 밖이라 지워질 수 있다)
  assert.equal(a.removedVm, 0);
  assert.ok(osStore.getScanInfo('vc-ok:x1'), '골격(VM 목록 없음)에서 VM 기록을 지웠다');
  assert.ok(osStore.getScanInfo('vc-gone2:y1'));
  // 골격이어도 status 가 connected 로 보이면? — initial 이면 VM 단위 정리를 하지 않는다
  const skel2 = { initial: true, vcenters: [{ id: 'vc-ok', status: 'connected' }], vms: [] };
  assert.equal(osStore.pruneMissing(skel2, { registryIds: ['vc-ok', 'vc-gone2'] }).removedVm, 0);
  assert.ok(osStore.getScanInfo('vc-ok:x1'));
  const b = osStore.pruneMissing(null, { registryIds: [] });
  assert.equal(b.removed, 0, '스냅샷을 모르면 아무것도 지우지 않는다');
  assert.ok(osStore.getScanInfo('vc-gone2:y1'));
  const c = osStore.pruneMissing({ vcenters: [], vms: [] }, { registryIds: null });
  assert.equal(c.removedVcenter, 0, '등록부를 못 읽었는데 vCenter 가 지워졌다고 판정했다');
  assert.ok(osStore.getScanInfo('vc-gone2:y1'));
  const d = osStore.pruneMissing({ vcenters: [{ id: 'vc-ok', status: 'connected' }], vms: [] }, { registryIds: ['vc-ok'] });
  assert.ok(d.removedVcenter >= 1, '등록부를 읽었으면 지워진 vCenter 의 기록을 지운다');
  assert.ok(d.removedVm >= 1, '온전히 읽은 vCenter 에서 사라진 VM 은 지운다');
  assert.equal(osStore.getScanInfo('vc-gone2:y1'), null);
  assert.equal(osStore.getScanInfo('vc-ok:x1'), null);
});

test('VC-04 ③ 실패 upsert — 직전 탐지 OS·불일치를 지우지 않고 오류·시각만 갱신 · 성공 시각(okAt)은 따로 · 성공하면 오류를 지운다', () => {
  const v = vm('vc-ok', 'mm', 'Red Hat Enterprise Linux 8 (64-bit)');
  const first = osStore.upsertOs(v, RHEL9);
  assert.equal(first.mismatch, true, 'ESXi RHEL8 ≠ 실제 RHEL9');
  assert.equal(first.error, '');
  assert.ok(Number.isFinite(first.okAt));
  const okAt = first.okAt;
  const fail = osStore.upsertOs(v, null, '게스트 로그인 실패');
  assert.equal(fail.os, RHEL9.os, '실패가 직전에 탐지한 OS 를 지웠다');
  assert.equal(fail.osVersion, '9.2');
  assert.equal(fail.family, 'RHEL');
  assert.equal(fail.mismatch, true, '실패가 불일치 판정을 지웠다');
  assert.equal(fail.error, '게스트 로그인 실패');
  assert.equal(fail.okAt, okAt, '성공 시각은 바꾸지 않는다');
  assert.ok(Number.isFinite(fail.errorAt));
  assert.equal(osStore.getOsResults({ mismatch: true }).some((r) => r.vmId === v.id), true, '불일치 목록에 남는다');
  // ESXi 보고값이 바뀌었으면 남긴 OS 로 다시 판정한다(지금 esxiGuestOS 와 짝이 맞게)
  const fixedEsxi = osStore.upsertOs({ ...v, guestOS: 'Red Hat Enterprise Linux 9 (64-bit)' }, null, '시한 초과');
  assert.equal(fixedEsxi.mismatch, false);
  assert.equal(fixedEsxi.os, RHEL9.os);
  // 처음부터 실패한 VM 은 예전처럼 빈 OS
  const never = osStore.upsertOs(vm('vc-ok', 'nn'), null, '게스트 계정 없음');
  assert.equal(never.os, ''); assert.equal(never.mismatch, false); assert.equal(never.okAt, null);
  // 성공은 오류를 지운다
  const ok2 = osStore.upsertOs(v, RHEL9);
  assert.equal(ok2.error, ''); assert.equal(Object.hasOwn(ok2, 'errorAt'), false); assert.ok(ok2.okAt >= okAt);
});

/* ── LEFT-05 · DB-05 ────────────────────────────────────────────────────── */

const { zipMany, zipManyAsync } = await import('../src/util/zip.js');

/** 최소 ZIP 해제(검증용) — 중앙 디렉터리를 따라 항목을 풀고 CRC 를 대조한다. */
function unzip(buf) {
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50);
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16); const csize = buf.readUInt32LE(p + 20); const nlen = buf.readUInt16LE(p + 28);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(off + 26); const lxlen = buf.readUInt16LE(off + 28);
    const data = zlib.inflateRawSync(buf.subarray(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize));
    assert.equal(zlib.crc32(data) >>> 0, crc, `${name} CRC`);
    out.push({ name, data });
    p += 46 + nlen;
  }
  return out;
}

function sampleEntries(n = 60) {
  const ents = [{ name: 'waste-all-20261016.xlsx', data: Buffer.alloc(400_000, 0x41) }, { name: 'reports/한글-보고서.html', data: '<p>근거</p>'.repeat(4000) }, { name: 'empty.txt', data: '' }];
  for (let i = 0; i < n; i++) ents.push({ name: `reports/vm-${i}.html`, data: `<tr><td>${i}</td></tr>`.repeat(800 + i * 13) });
  return ents;
}

test('LEFT-05·DB-05 ① zipManyAsync 결과 바이트는 zipMany 와 같고, 풀면 원본이 나온다', async () => {
  const ents = sampleEntries();
  const a = zipMany(ents);
  const b = await zipManyAsync(ents);
  assert.equal(Buffer.compare(a, b), 0, '비동기판이 다른 바이트를 만들었다');
  const files = unzip(b);
  assert.equal(files.length, ents.length);
  for (let i = 0; i < ents.length; i++) {
    assert.equal(files[i].name, ents[i].name);
    const want = Buffer.isBuffer(ents[i].data) ? ents[i].data : Buffer.from(String(ents[i].data));
    assert.equal(Buffer.compare(files[i].data, want), 0, ents[i].name);
  }
  assert.equal(Buffer.compare(zipMany([]), await zipManyAsync([])), 0, '빈 목록도 같다');
});

test('LEFT-05·DB-05 ② zipManyAsync 는 압축 중에 이벤트 루프를 양보한다(setImmediate 프로브 — 동기판은 0회)', async () => {
  const ents = sampleEntries(40);
  const probe = () => { let n = 0; let on = true; const tick = () => { if (!on) return; n += 1; setImmediate(tick); }; setImmediate(tick); return { stop: () => { on = false; return n; } }; };
  const p1 = probe(); zipMany(ents); const syncTicks = p1.stop();
  assert.equal(syncTicks, 0, '동기판은 양보하지 않는다(기준선)');
  const p2 = probe(); await zipManyAsync(ents); const asyncTicks = p2.stop();
  assert.ok(asyncTicks >= ents.length / 2, `비동기판이 양보하지 않았다: ${asyncTicks}`);
});

test('LEFT-05·DB-05 ③ 검증·상한 오류는 두 판이 같다(Zip Slip·중복·드라이브 문자·빈 이름·항목 수·합계)', async () => {
  const cases = [
    [[{ name: '../x', data: 'a' }]],
    [[{ name: 'a', data: '1' }, { name: 'a', data: '2' }]],
    [[{ name: 'C:/x', data: 'a' }]],
    [[{ name: '', data: 'a' }]],
    [[{ name: 'a', data: '1' }, { name: 'b', data: '2' }], { maxEntries: 1 }],
    [[{ name: 'a', data: 'x'.repeat(100) }], { maxBytes: 10 }],
  ];
  for (const [ents, opt] of cases) {
    let e1 = null; let e2 = null;
    try { zipMany(ents, opt); } catch (e) { e1 = e.message; }
    try { await zipManyAsync(ents, opt); } catch (e) { e2 = e.message; }
    assert.ok(e1, `동기판이 거부하지 않았다: ${JSON.stringify(ents)}`);
    assert.equal(e2, e1);
  }
});

test('LEFT-05·DB-05 ④ /tools/waste/export 는 비동기판을 쓰고(주석 제외 소스) 실제 라우트가 올바른 zip 을 돌려준다 · 동시 1건 가드 유지', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(path.join(SERVER_DIR, 'src/routes/api/toolsCapacity.js'), 'utf8'));
  const route = src.slice(src.indexOf("api.get('/tools/waste/export'"), src.indexOf('async function rightsizeReportsFor'));
  assert.ok(route.length > 100);
  assert.match(route, /zipManyAsync\(/, '내보내기가 비동기 zip 을 써야 한다');
  assert.doesNotMatch(route, /\bzipMany\(/, '요청 경로에 동기 zipMany 가 남아 있다');
  assert.match(route, /acquireExport\('waste\.export'/, '동시 1건 가드를 지우지 말 것');
  const o = runChild(`
    console.log = () => {}; console.warn = () => {}; console.error = () => {};
    const { store } = await import('./src/store.js');
    await store.refresh({ force: true });
    ${SERVE}
    const r = await fetch(base + '/api/tools/waste/export?days=7');
    const ab = Buffer.from(await r.arrayBuffer());
    srv.close();
    process.stdout.write('@@' + JSON.stringify({ status: r.status, type: r.headers.get('content-type'), b64: ab.toString('base64') }) + '\\n');
    process.exit(0);
  `, { WASTE_EXPORT_MAX_REPORTS: '3' });
  assert.equal(o.status, 200, Buffer.from(o.b64, 'base64').toString('utf8').slice(0, 300));
  assert.equal(o.type, 'application/zip');
  const files = unzip(Buffer.from(o.b64, 'base64'));
  assert.ok(files.length >= 1);
  assert.match(files[0].name, /\.xlsx$/);
  assert.equal(files[0].data.subarray(0, 2).toString('latin1'), 'PK', 'xlsx 도 zip 형식이어야 한다');
});

/* ── RECENT-03 · VC-09 ──────────────────────────────────────────────────── */

const { hygieneFindings, analyzeVmHygiene, snapshotPolicySummary, HYGIENE_CODES } = await import('../src/vmhygiene/analyze.js');
const { DEFAULTS } = await import('../src/vmhygiene/settings.js');
const S = { ...DEFAULTS, notify: { ...DEFAULTS.notify } };

test('RECENT-03·VC-09 ① 유령 스냅샷 후보 — vCenter 가 통합 필요로 표시한 VM 만 주의(warn), 이름 규칙만이면 참고(info) · 근거를 싣는다 · 빼지 않는다', () => {
  const base = { name: 'lc01', powerState: 'POWERED_ON', snapshotCount: 0, orphanDeltaGB: 2 };
  const pick = (v) => hygieneFindings(v, S, NOW).findings.find((f) => f.code === 'snap-orphan-delta');
  const yes = pick({ ...base, cfg: { consolidationNeeded: true } });
  assert.equal(yes.sev, 'warn');
  assert.equal(yes.facts.basis, 'consolidation');
  assert.equal(yes.sev, HYGIENE_CODES['snap-orphan-delta'], '주의 등급은 코드 표의 등급이다');
  const no = pick({ ...base, cfg: { consolidationNeeded: false } });
  assert.ok(no, '통합 필요 false 라도 후보를 빼지 않는다(진짜 유령 델타일 수 있다)');
  assert.equal(no.sev, 'info', '이름 규칙만 맞는 후보가 주의(warn)로 올라갔다 — 링크드 클론 오탐');
  assert.deepEqual(no.facts, { gb: 2, basis: 'name-rule', consolidationNeeded: false });
  const unknown = pick({ ...base });
  assert.equal(unknown.sev, 'info');
  assert.equal(unknown.facts.consolidationNeeded, null, '아직 안 읽은 것은 false 가 아니라 모름');
  assert.equal(pick({ ...base, snapshotCount: 1 }), undefined, '스냅샷이 있으면 정상 체인');
});

test('RECENT-03·VC-09 ② 집계·알림 — 참고 후보는 행의 최악 등급을 올리지 않고, 매일 알림에는 주의 후보만 싣는다', () => {
  const vms = [
    { id: 'a', name: 'lc-a', vcenterId: 'vc1', powerState: 'POWERED_ON', snapshotCount: 0, orphanDeltaGB: 3, cfg: { consolidationNeeded: false } },
    { id: 'b', name: 'ghost-b', vcenterId: 'vc1', powerState: 'POWERED_ON', snapshotCount: 0, orphanDeltaGB: 5, cfg: { consolidationNeeded: true } },
  ];
  const r = analyzeVmHygiene(vms, S, { now: NOW });
  const ra = r.rows.find((x) => x.id === 'a');
  assert.equal(ra.worst, 'info', '이름 규칙만 맞는 VM 이 주의 행이 됐다');
  assert.equal(r.vcenters[0].warn, 1, 'vCenter 주의 수에 참고 후보를 세지 않는다');
  assert.equal(r.byCode['snap-orphan-delta'].vms, 2, '코드 칩 개수에는 둘 다 센다(화면에서 보인다)');
  const text = snapshotPolicySummary(r);
  assert.ok(text, '주의 후보가 있으면 알림을 만든다');
  assert.match(text, /ghost-b/);
  assert.doesNotMatch(text, /lc-a/, '이름 규칙만 맞는 후보로 매일 알림을 보냈다');
  assert.match(text.split('\n')[0], /위반 1대/);
  const onlyInfo = analyzeVmHygiene([vms[0]], S, { now: NOW });
  assert.equal(snapshotPolicySummary(onlyInfo), null, '참고 후보만 있으면 보낼 것이 없다');
});

/* ── 화면 문구(웹 순수 모듈 — 서버 판정 코드와 짝) ─────────────────────────── */

test('문구 ① 서버 온도 — host-disconnected 사유는 vCenter 사유와 다른 문장이고, 표 머리가 연결 끊김 수를 말한다', async () => {
  const board = await import('../../web/src/views/tools/serverTemp/board.js');
  assert.equal(board.STALE_REASON_KO[HOST_DISCONNECTED], '호스트 연결 끊김', '서버 사유 코드와 웹 키가 같아야 한다');
  const t = board.staleRowTitle({ staleReason: HOST_DISCONNECTED });
  assert.match(t, /연결이 끊겨/);
  assert.doesNotMatch(t, /vCenter 를 지금 읽지 못해/, '끊긴 호스트를 vCenter 문제로 말하지 않는다');
  assert.match(board.staleRowTitle({ staleReason: 'unreachable' }), /vCenter 를 지금 읽지 못해\(연결 실패\)/);
  assert.equal(board.staleHostsNote({ staleHosts: 0 }), '');
  assert.equal(board.staleHostsNote({ staleHosts: 3 }), ' · 오래된 값 3대(집계 제외)');
  assert.equal(board.staleHostsNote({ staleHosts: 3, disconnectedHosts: 2 }), ' · 오래된 값 3대(집계 제외 · 그중 호스트 연결 끊김 2대)');
  for (const s of [t, board.staleHostsNote({ staleHosts: 3, disconnectedHosts: 2 })]) assert.doesNotMatch(s, /`|\*\*/);
});

test('문구 ② 유령 스냅샷 후보 — 이름 규칙 기반임을 말하고 근거별로 다른 설명을 낸다', async () => {
  const t = await import('../../web/src/views/vmcfg/vmHygieneText.js');
  assert.match(t.HYGIENE_TEXT['snap-orphan-delta'].title, /이름 규칙 기반/);
  assert.match(t.findingDetail({ code: 'snap-orphan-delta', facts: { gb: 2, basis: 'consolidation', consolidationNeeded: true } }), /통합 필요로 표시/);
  assert.match(t.findingDetail({ code: 'snap-orphan-delta', facts: { gb: 2, basis: 'name-rule', consolidationNeeded: false } }), /이름 규칙 기반 후보 — 통합 필요 표시 없음/);
  assert.match(t.findingDetail({ code: 'snap-orphan-delta', facts: { gb: 2, basis: 'name-rule', consolidationNeeded: null } }), /아직 읽지 않음/);
  assert.equal(t.findingDetail({ code: 'snap-orphan-delta', facts: { gb: 2 } }), '델타 꼴 파일 2 GB', '옛 서버(basis 없음)는 크기만');
  for (const s of Object.values(t.HYGIENE_TEXT['snap-orphan-delta'])) assert.doesNotMatch(s, /`|\*\*/);
});
