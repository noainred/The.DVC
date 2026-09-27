/**
 * corpUsage2625.test.js — 법인별 서버 사용량(v2.625).
 *
 * 사용자 요청: "iDRAC 사용량을 ESXi 호스트까지 넓혀서 · 법인별 전체/다빈치/IRS · 서버 전체/물리/가상화 CPU·메모리 사용량을 1페이지에".
 * 선택: 별도 스위치 + 법인 선택(기본 꺼짐) · 못 읽은 ESXi 는 vCenter 값으로 채우고 출처 표시 · 사용량 합 + 가중 사용률.
 *
 * 고정하는 것:
 *  ① 가중 사용률 = Σ(사용률 × 용량) ÷ Σ용량 — 퍼센트 평균이 아니다
 *  ② 못 읽음·오래됨·용량 모름은 합계에서 빼고 따로 센다(0 으로 세지 않는다) · 분모 0 이면 null
 *  ③ 가상화 호스트는 iDRAC 값이 없으면 vCenter 값 · 끊긴 호스트는 채우지 않는다 · 출처 카운트
 *  ④ 지표별 분모 — CPU 만 읽은 서버는 메모리 분모에 들어가지 않는다
 *  ⑤ 다빈치/IRS 구분(이름) · 알파벳순 · 범위 계정은 허용 법인만 + 귀속 없음 null
 *  ⑥ bmusage 대상 — ESXi 는 스위치를 켜야만 · 위임 vCenter 는 그 엣지 · 베어메탈과 중복하지 않음
 *  ⑦ mergeLatestRows 는 ts 가 큰 쪽 · makeCapOf 폴백 순서
 *  ⑧ 실제 api 라우터: 200 · 응답에 서버 이름 없음 · 범위 계정 필터
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCorpUsage, judgeServer, corpGroupOf, srcOfRow } from '../src/corpusage/build.js';
import { resolveTargets } from '../src/bmusage/targets.js';
import { mergeLatestRows, makeCapOf } from '../src/routes/api/corpUsage.js';
import { normalizeSettings } from '../src/bmusage/settings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const NOW = 1_800_000_000_000;
const FRESH = 30 * 60_000;

const VCS = [{ id: 'vc-b', name: 'Beta IRS' }, { id: 'vc-a', name: 'alpha' }, { id: 'vc-c', name: 'Charlie' }];

function base() {
  const bareMetal = [
    { serverId: 'idrac-1', fleetId: 'f1', name: 'bm1', serviceTag: 'T1', vcenterId: 'vc-a' },
    { serverId: 'idrac-2', fleetId: 'f2', name: 'bm2', serviceTag: 'T2', vcenterId: 'vc-a' },
    { serverId: 'idrac-3', fleetId: 'f3', name: 'bm3', serviceTag: 'T3', vcenterId: '' },
  ];
  const virtHosts = [
    { name: 'esx1', fleetId: 'e1', vcenterId: 'vc-b', serviceTag: 'E1', cpuCores: 64, memGB: 512, idracServerId: 'idrac-e1' },
    { name: 'esx2', fleetId: 'e2', vcenterId: 'vc-b', serviceTag: 'E2', cpuCores: 32, memGB: 256 },
    { name: 'esx3', fleetId: 'e3', vcenterId: 'vc-b', serviceTag: 'E3', cpuCores: 32, memGB: 256 },
    { name: 'orphan', fleetId: 'o1', vcenterId: 'vc-c', serviceTag: 'O1', cpuCores: 0, memGB: 0, synthetic: true },
  ];
  const rowsByKey = new Map([
    ['T1', { key: 'T1', ts: NOW - 60_000, src: 'idrac', cpu_pct: 50, mem_pct: 25 }],
    ['T2', { key: 'T2', ts: NOW - 60_000, src: 'os+idrac', cpu_pct: 10, mem_pct: null }],
    ['T3', { key: 'T3', ts: NOW - 60_000, src: 'idrac', cpu_pct: 80, mem_pct: 80 }],
    ['E1', { key: 'E1', ts: NOW - 60_000, src: 'idrac', cpu_pct: 20, mem_pct: 50 }],
    ['E3', { key: 'E3', ts: NOW - 3 * 3_600_000, src: 'idrac', cpu_pct: 99, mem_pct: 99 }], // 오래됨 → vCenter 값
  ]);
  const hostByKey = new Map([
    ['vc-b|esx1', { cpuUsagePct: 90, memUsagePct: 90, connectionState: 'CONNECTED' }],
    ['vc-b|esx2', { cpuUsagePct: 40, memUsagePct: 60, connectionState: 'CONNECTED' }],
    ['vc-b|esx3', { cpuUsagePct: 30, memUsagePct: 30, connectionState: 'DISCONNECTED' }],
  ]);
  const caps = { 'idrac-1': { cores: 32, memGB: 256 }, 'idrac-2': { cores: 16, memGB: 128 }, 'idrac-3': { cores: 8, memGB: 64 } };
  return { vcenters: VCS, bareMetal, virtHosts, rowsByKey, hostByKey, capOf: (b) => caps[b.serverId] || null, now: NOW, freshMs: FRESH };
}

test('① 가중 사용률 · ⑤ 이름순·구분 · 귀속 없음은 법인 밖', () => {
  const out = buildCorpUsage(base());
  assert.deepEqual(out.corps.map((c) => c.name), ['alpha', 'Beta IRS'], '알파벳순(대소문자 무시) · 서버 없는 법인(합성 행만)은 행이 없다');
  const a = out.corps[0];
  assert.equal(a.group, 'davinci');
  assert.equal(out.corps[1].group, 'irs');
  // CPU: (0.5×32 + 0.1×16) / 48 = 17.6/48 = 36.7%
  assert.equal(a.bm.cpu.used, 17.6);
  assert.equal(a.bm.cpu.total, 48);
  assert.equal(a.bm.cpu.pct, 36.7);
  // ④ MEM: bm2 는 메모리 못 읽음 → 분모에 없다. 0.25×256 / 256 = 25%
  assert.equal(a.bm.mem.total, 256);
  assert.equal(a.bm.mem.pct, 25);
  assert.equal(a.bm.src.os, 1);
  assert.equal(a.bm.src.idrac, 1);
  assert.equal(out.unassigned.bm.servers, 1, '귀속 없는 물리 서버는 unassigned 로만');
  assert.equal(out.totals.all.bm.servers, 2, '법인 합계에 귀속 없음이 섞이지 않는다');
});

test('③ 가상화: iDRAC 먼저 · 없으면 vCenter · 끊긴 호스트는 못 읽음', () => {
  const out = buildCorpUsage(base());
  const b = out.corps.find((c) => c.vcenterId === 'vc-b');
  // esx1 iDRAC(20%·64) + esx2 vCenter(40%·32). esx3: 오래된 iDRAC + 끊긴 호스트 → stale
  assert.equal(b.virt.src.idrac, 1);
  assert.equal(b.virt.src.vcenter, 1);
  assert.equal(b.virt.stale, 1);
  assert.equal(b.virt.cpu.total, 96);
  assert.equal(b.virt.cpu.used, 25.6); // 12.8 + 12.8
  assert.equal(b.virt.cpu.pct, 26.7);
  assert.equal(b.all.servers, 3);
  assert.equal(out.totals.irs.virt.servers, 3);
  assert.equal(out.totals.davinci.virt.servers, 0);
  assert.equal(out.totals.all.all.servers, 5);
});

test('② 분모 0 이면 null · 못 읽은 서버는 0 으로 세지 않는다', () => {
  const p = base();
  p.rowsByKey = new Map();
  p.hostByKey = new Map();
  const out = buildCorpUsage(p);
  const a = out.corps.find((c) => c.vcenterId === 'vc-a');
  assert.equal(a.bm.unread, 2);
  assert.equal(a.bm.cpu.pct, null, '0% 가 아니라 null');
  assert.equal(a.bm.cpu.total, 0);
  assert.equal(a.bm.capCores, 48, '설치 용량은 참고로 남는다');
  // 용량 모름
  const q = base();
  q.capOf = () => null;
  const o2 = buildCorpUsage(q);
  assert.equal(o2.corps.find((c) => c.vcenterId === 'vc-a').bm.noCap, 2);
});

test('judgeServer — 범위 밖 퍼센트는 퍼센트가 아니다 · 끊긴 호스트 대체 금지', () => {
  const j = judgeServer({ role: 'bm', row: { ts: NOW, cpu_pct: 150, mem_pct: -1 }, now: NOW, freshMs: FRESH });
  assert.equal(j.state, 'unread');
  const v = judgeServer({ role: 'virt', row: null, host: { cpuUsagePct: 10, memUsagePct: 10, connectionState: 'NOT_RESPONDING' }, now: NOW, freshMs: FRESH });
  assert.equal(v.state, 'unread');
  const bmHost = judgeServer({ role: 'bm', row: null, host: { cpuUsagePct: 10 }, now: NOW, freshMs: FRESH });
  assert.equal(bmHost.state, 'unread', '물리 서버는 vCenter 값으로 채우지 않는다');
  assert.equal(srcOfRow({ src: 'os' }), 'os');
  assert.equal(corpGroupOf('LGES-IRS-01'), 'irs');
  assert.equal(corpGroupOf('seoul'), 'davinci');
});

test('⑤ 범위 계정 — 허용 법인만 · 귀속 없음 null', () => {
  const out = buildCorpUsage({ ...base(), allowed: new Set(['vc-a']) });
  assert.deepEqual(out.corps.map((c) => c.vcenterId), ['vc-a']);
  assert.equal(out.unassigned, null);
  assert.equal(out.totals.all.all.servers, 2);
});

test('⑥ bmusage 대상 — ESXi 는 스위치를 켜야만 · 위임 · 중복 · 사유', () => {
  const virtHosts = [
    { name: 'esx1', fleetId: 'e1', vcenterId: 'vc-a', serviceTag: 'E1', idracServerId: 'r1' },
    { name: 'esx2', fleetId: 'e2', vcenterId: 'vc-site', serviceTag: 'E2', idracServerId: 'r2' },
    { name: 'esx3', fleetId: 'e3', vcenterId: 'vc-a', serviceTag: 'E3' },
    { name: 'dup', fleetId: 'd', vcenterId: 'vc-a', serviceTag: 'T1', idracServerId: 'r9' },
  ];
  const bareMetal = [{ serverId: 'r9', fleetId: 'f1', name: 'bm1', serviceTag: 'T1', vcenterId: 'vc-a' }];
  const registry = [
    { id: 'r1', host: 'https://10.0.0.1', username: 'root', password: 'x' },
    { id: 'r2', host: 'https://10.0.0.2', username: 'root', password: 'x' },
    { id: 'r9', host: 'https://10.0.0.9', username: 'root', password: 'x' },
  ];
  const vcenters = [{ id: 'vc-site', collectSource: 'site', collectedBy: 'EDGE1' }];
  const corps = { 'vc-a': true, 'vc-site': true };
  const off = resolveTargets({ bareMetal, virtHosts, vcenters, registry, settings: { corps, idracTelemetry: true } });
  assert.equal(off.counts.virt, 0, '기본 꺼짐');
  assert.ok(!off.skipped.some((s) => s.role === 'virt'), '꺼져 있으면 사유 목록에도 싣지 않는다');
  const on = resolveTargets({ bareMetal, virtHosts, vcenters, registry, settings: { corps, idracTelemetry: true, includeVirtualization: true } });
  assert.deepEqual(on.targets.filter((x) => x.role === 'virt').map((x) => x.key), ['E1']);
  assert.equal(on.targets.filter((x) => x.key === 'T1').length, 1, '베어메탈과 같은 박스는 한 번만');
  const why = Object.fromEntries(on.skipped.filter((s) => s.role === 'virt').map((s) => [s.key, s.reason]));
  assert.equal(why.E2, 'edge-delegated');
  assert.equal(why.E3, 'no-idrac');
  const edge = resolveTargets({ bareMetal: [], virtHosts, vcenters, registry, isEdge: true, agentName: 'edge1', settings: { corps, idracTelemetry: true, includeVirtualization: true } });
  assert.ok(edge.targets.some((x) => x.key === 'E2' && x.role === 'virt'), '위임 vCenter 의 호스트는 그 엣지가 잰다');
  assert.equal(normalizeSettings({}).includeVirtualization, false);
  assert.equal(normalizeSettings({ includeVirtualization: 'true' }).includeVirtualization, false, '진리값만 받는다');
});

test('⑦ mergeLatestRows · makeCapOf', () => {
  const m = mergeLatestRows([{ key: 'A', ts: 5, cpu_pct: 1 }], [{ key: 'A', ts: 9, cpu_pct: 2 }, { key: 'A', ts: 3 }, null, { key: '' }]);
  assert.equal(m.size, 1);
  assert.equal(m.get('A').cpu_pct, 2);
  const inv = { 'r-1': { cpu: { cores: 16 }, memory: { totalGiB: 128 } } };
  const capOf = makeCapOf({
    getInventory: (id) => inv[id] || null,
    registry: [{ id: 'r-1', serviceTag: 'TAG1' }],
    remoteServers: [{ serviceTag: 'TAG2', inv: { cpu: { cores: 8 }, memory: { totalGiB: 64 } } }],
  });
  assert.deepEqual(capOf({ serverId: 'x', serviceTag: 'tag1' }), { cores: 16, memGB: 128 }, '서비스태그로 등록부 찾기');
  assert.deepEqual(capOf({ serverId: 'x', serviceTag: 'TAG2' }), { cores: 8, memGB: 64 }, '엣지 원격 인벤토리');
  assert.equal(capOf({ serverId: 'x', serviceTag: 'NONE' }), null);
});

test('⑧ 실제 api 라우터 — 200 · 서버 이름 없음 · 범위 계정', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpusage2625-'));
  fs.writeFileSync(path.join(dir, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
  const script = `
    const express = (await import('express')).default;
    const { store } = await import(${JSON.stringify(path.join(SRC, 'store.js'))});
    await store.refresh?.();
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const snap = store.get();
    const vcs = (snap?.vcenters || []).map((v) => v.id);
    const hostNames = (snap?.hosts || []).slice(0, 50).map((h) => h.name);
    const out = { vcs: vcs.length };
    for (const [label, user] of [['admin', { username: 'a', role: 'admin', scope: null }], ['scoped', { username: 's', role: 'viewer', scope: { vcenters: [vcs[0]] } }]]) {
      const app = express();
      app.use((req, _res, next) => { req.user = user; next(); });
      app.use('/api', api);
      const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
      const r = await fetch('http://127.0.0.1:' + srv.address().port + '/api/tools/corp-usage');
      const text = await r.text();
      srv.close();
      let b = null; try { b = JSON.parse(text); } catch {}
      out[label] = { status: r.status, corps: b?.corps?.map((c) => c.vcenterId) || null, unassigned: b ? b.unassigned : 'x', scoped: b?.scoped,
        leak: hostNames.filter((n) => n && text.includes('"' + n + '"')).length, totals: !!b?.totals?.irs };
    }
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, r.stdout.slice(-600));
  const out = JSON.parse(line.slice(2));
  assert.ok(out.vcs > 1);
  assert.equal(out.admin.status, 200);
  assert.equal(out.admin.totals, true);
  assert.ok(out.admin.corps.length > 1, `목 데이터에서 법인 행이 나와야 한다: ${out.admin.corps}`);
  assert.equal(out.admin.leak, 0, '응답에 서버(호스트) 이름이 실리면 안 된다 — 법인 합계만');
  assert.equal(out.scoped.status, 200);
  assert.equal(out.scoped.scoped, true);
  assert.equal(out.scoped.unassigned, null);
  assert.ok(out.scoped.corps.length <= 1, `범위 계정에 다른 법인이 실렸다: ${out.scoped.corps}`);
});
