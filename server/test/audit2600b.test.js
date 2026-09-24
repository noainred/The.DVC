/**
 * v2.600 감사 — 권한·가림 + 스토리지 추이 그룹(b) 회귀 고정.
 *
 *  - RECENT2600-03 / AUTHZ-2600-02  storage-growth 가 비-admin 에 devices[].host·noHistory[].host 를 줬다
 *  - AUTHZ-2600-03  SAN perf/storage-summary 가 switches[].host 를 줬다
 *  - AUTHZ-2600-04  SAN perf/activity 가 events 만 가리고 poller(inFlight[].host·errors 문구)를 그대로 줬다
 *  - RECENT2600-04  이름이 주소와 같아 가린 행의 이름이 빈 문자열이었다(라벨 없는 행)
 *  - AUTHZ-2600-01  시리얼 조회(+CSV)가 비-admin 에 iDRAC 관리 URL·스토리지/SAN 주소를 줬다
 *  - AUTHZ-2600-05  Horizon 세션 조회가 Connection Server 주소를 줬다
 *  - AUTHZ-2600-06  /idrac/host-power 가 권한 게이트 없이 iDRAC 관리 URL·네트워크 식별을 줬다
 *  - AUTHZ-2600-07  relaycheck·relaytopo·bm-usage/edges 가 범위 계정에 전 엣지 사이트를 줬다
 *  - AUTHZ-2600-08  bm-usage 대상의 idracHost·osHostName 이 비-admin 에 나갔다
 *  - DB2600-01      전체 합계 추이가 10분 버킷마다 일부 엣지만 합산했다(실제의 1/4)
 *
 * ⚠ 검증 방식: 순수 함수는 직접, 라우트는 **실제 라우터를 express 에 띄워 역할·범위별 응답으로** 본다.
 *   기준 시각은 Date.now() 가 아니라 고정값(정시 경계에서 떨어뜨린 값)이다(CLAUDE.md v2.517).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { maskDeviceAddress, maskSnapAddress, maskActivityEvents, maskPollerStatus, maskedNameLabel, scrubHosts } from '../src/auth/addressMask.js';
import { sumCapacityBuckets } from '../src/storage/db.js';
import { maskSerialRow } from '../src/routes/api/serialLookup.js';
import { maskHostPower } from '../src/routes/api/vmMetrics.js';
import { maskTargetAddress, publicTarget } from '../src/bmusage/targets.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const ROOT = path.resolve(SRC, '..');
const J = (p) => JSON.stringify(path.join(SRC, p));
const IP_RE = /\b10\.20\.0\.\d+\b/;

/* ── 순수 모듈 ─────────────────────────────────────────────────────────────── */

test('RECENT2600-04: 이름이 주소와 같아 가린 행은 빈 문자열이 아니라 타입+id 라벨', () => {
  const m = maskDeviceAddress({ id: 'st-abc1', type: 'unity480', name: '10.9.9.9', host: '10.9.9.9' });
  assert.equal(m.host, '');
  assert.ok(m.name, '빈 이름은 화면에서 라벨 없는 행이 된다');
  assert.ok(!m.name.includes('10.9.9.9'), m.name);
  assert.match(m.name, /unity480/); assert.match(m.name, /st-abc1/);
  const s = maskSnapAddress({ deviceId: 'sw-1', type: 'brocade', name: 'h1', host: 'h1' });
  assert.ok(s.name && !s.name.includes('h1'), s.name);
  const e = maskActivityEvents([{ deviceId: 'pdu-1', name: '10.1.1.1', host: '10.1.1.1', error: 'x 10.1.1.1' }])[0];
  assert.ok(e.name && !e.name.includes('10.1.1.1')); assert.ok(!e.error.includes('10.1.1.1'));
  assert.equal(maskedNameLabel({}), '(이름 가림)');
  // 이름이 주소가 아니면 그대로
  assert.equal(maskDeviceAddress({ id: 'x', name: 'UNITY-A', host: '10.9.9.9' }).name, 'UNITY-A');
});

test('AUTHZ-2600-04: maskPollerStatus — inFlight host·errors 문구 속 주소를 가리고 원본은 그대로', () => {
  const p = { busy: true, inFlight: [{ id: 'sw-1', name: 'SW-A', host: '10.77.2.9', startedAt: 1 }, { id: 'sw-2', name: '10.77.2.10', host: '10.77.2.10' }],
    errors: ['SW-A: connect ECONNREFUSED 10.77.2.9:22', 'x: 10.77.2.100 down'], collected: 3 };
  const m = maskPollerStatus(p, ['10.77.2.9', '10.77.2.10', '10.77.2.100']);
  assert.ok(!/10\.77\.2\./.test(JSON.stringify(m)), JSON.stringify(m));
  assert.equal(m.inFlight[0].name, 'SW-A'); assert.equal(m.collected, 3);
  assert.equal(p.inFlight[0].host, '10.77.2.9', '원본을 바꾸면 admin 응답까지 가려진다');
  // URL 등록부(Horizon) — 오류 문구에는 스킴 없는 호스트명만 실린다
  assert.equal(scrubHosts('getaddrinfo ENOTFOUND cs01.corp', ['https://cs01.corp:443/']).includes('cs01.corp'), false);
});

test('AUTHZ-2600-01: maskSerialRow — iDRAC 는 id 가 IP 이고 host 에 스킴이 붙는다', () => {
  const r = maskSerialRow({ kind: 'server', kindLabel: '서버', serial: 'ABC1234', host: 'https://10.20.0.61', deviceId: '10.20.0.61', deviceName: 'https://10.20.0.61', model: 'R750' });
  assert.ok(!IP_RE.test(JSON.stringify(r)), JSON.stringify(r));
  assert.equal(r.serial, 'ABC1234'); assert.equal(r.model, 'R750'); assert.match(r.deviceName, /서버/);
  const s = maskSerialRow({ kind: 'storage', host: '10.20.0.50', deviceId: 'st-1', deviceName: 'UNITY-A' });
  assert.equal(s.deviceId, 'st-1'); assert.equal(s.deviceName, 'UNITY-A'); assert.equal(s.host, '');
});

test('AUTHZ-2600-06: maskHostPower — 관리 URL·IP 형 id·iDRAC 네트워크 식별을 가리고 전력은 그대로', () => {
  const r = maskHostPower({ matched: true, source: 'idrac', server: { id: '10.20.0.70', name: 'esx01', host: 'https://10.20.0.70', serviceTag: 'TAG1' },
    current: { watts: 300 }, info: { system: { model: 'R750' }, network: [{ name: 'NIC.1', mac: 'aa', ipv4: '10.20.0.70', fqdn: 'idrac-esx01.corp', hostName: 'idrac-esx01' }] } });
  assert.ok(!IP_RE.test(JSON.stringify(r)), JSON.stringify(r));
  assert.ok(!JSON.stringify(r).includes('idrac-esx01'));
  assert.equal(r.current.watts, 300); assert.equal(r.server.serviceTag, 'TAG1'); assert.equal(r.addressHidden, true);
  // 출처 표식은 주소가 아니다
  assert.equal(maskHostPower({ server: { id: 'remote:e1', host: '(수집서버 E1)' } }).server.host, '(수집서버 E1)');
});

test('AUTHZ-2600-08: maskTargetAddress — 경로 유무(null)와 가림("")을 구분해 남긴다', () => {
  const pt = publicTarget({ key: 'K', name: 'bm1', idrac: { host: 'https://10.20.0.80', password: 'p' }, osHost: { host: '10.20.0.81', mounts: ['/'] } });
  assert.equal(pt.idracHost, 'https://10.20.0.80');
  const m = maskTargetAddress(pt);
  assert.equal(m.idracHost, ''); assert.equal(m.osHostName, ''); assert.equal(m.osMounts, 1);
  const n = maskTargetAddress(publicTarget({ key: 'K2' }));
  assert.equal(n.idracHost, null); assert.equal(n.osHostName, null);
});

/*
 * DB2600-01 재현(감사 보고와 같은 모양): 엣지 4곳 × 장비 5대(각 100TB), 각 엣지가 **1시간마다 서로 다른
 * 분(0·15·30·45분)** 에 수집. 10분 버킷으로 버킷마다 관측된 장비만 더하면 점마다 5대·500TB 였다.
 */
function edgeRows({ base, hours, bucket }) {
  const rows = [];
  for (let h = 0; h < hours; h++) {
    for (let e = 0; e < 4; e++) {
      const ts = base + h * 3_600_000 + e * 15 * 60_000;
      for (let d = 0; d < 5; d++) {
        rows.push({ ts: Math.floor(ts / bucket) * bucket, device_id: `e${e}-d${d}`, total_bytes: 100e12, used_bytes: 40e12, hdd_total: null, hdd_used: null, ssd_total: null, ssd_used: null });
      }
    }
  }
  return rows.sort((a, b) => a.ts - b.ts);
}

test('DB2600-01: 전체 합계는 장비별 마지막 값을 이어 붙여 20대·2000TB 를 더한다', () => {
  const HOUR = 3_600_000;
  const BASE = 1_800_000_000_000 - (1_800_000_000_000 % HOUR) + 5 * 60_000;   // 정시 +5분(경계에서 떨어뜨림)
  const b = 600_000;
  const rows = edgeRows({ base: BASE, hours: 26, bucket: b });
  const since = BASE + 2 * HOUR;               // 앞 2시간은 carry 시드 구간
  const now = BASE + 26 * HOUR - 60_000;
  const r = sumCapacityBuckets(rows, { sinceMs: since, nowMs: now, bucketMs: b, staleMs: 2 * HOUR });
  assert.equal(r.expectedDevices, 20);
  assert.ok(r.points.length >= 100, `점 ${r.points.length}`);
  for (const p of r.points) {
    assert.equal(p.devices, 20, `점마다 20대여야 한다(수정 전 5대) — ${JSON.stringify(p)}`);
    assert.equal(p.total_bytes, 2000e12);
    assert.equal(p.used_bytes, 800e12);
    assert.equal(p.missing, 0);
  }
  // 신선도 한계를 넘긴 장비는 빠지고 missing 이 밝힌다(부분 합을 전체처럼 그리지 않는다)
  const stale = rows.filter((x) => !(x.device_id === 'e3-d0' && x.ts > BASE + 10 * HOUR));
  const r2 = sumCapacityBuckets(stale, { sinceMs: since, nowMs: now, bucketMs: b, staleMs: 2 * HOUR });
  const late = r2.points[r2.points.length - 1];
  assert.equal(late.devices, 19); assert.equal(late.missing, 1);
  // 사용량을 못 읽은 장비가 합에 들면 그 점 사용량은 null(v2.594 규칙 유지)
  const nul = rows.map((x) => (x.device_id === 'e0-d0' ? { ...x, used_bytes: null } : x));
  const r3 = sumCapacityBuckets(nul, { sinceMs: since, nowMs: now, bucketMs: b, staleMs: 2 * HOUR });
  assert.ok(r3.points.every((p) => p.used_bytes === null && p.used_unknown === 1));
});

/* ── 실제 라우터 ─────────────────────────────────────────────────────────── */

function runLive(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2600b-'));
  const boot = `
    const express = (await import('express')).default;
    const { store } = await import(${J('store.js')});
    const { api } = await import(${J('routes/api.js')});
    const storageReg = await import(${J('storage/registry.js')});
    const sanReg = await import(${J('sanswitch/registry.js')});
    const hz = await import(${J('horizon/horizon.js')});
    const colReg = await import(${J('collector/registry.js')});
    const bmEdge = await import(${J('central/bmUsageEdgePull.js')});
    const stDb = await import(${J('storage/db.js')});
    const { STORAGE_TYPES } = await import(${J('storage/types.js')});
    const { SAN_SWITCH_TYPES } = await import(${J('sanswitch/types.js')});
    await store.refresh({ force: true });
    const snap = store.get();
    const vcs = snap.vcenters.map((v) => v.id);
    const mk = (user) => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.user = user; next(); });
      app.use('/api', api);
      return app;
    };
    const servers = [];
    const start = async (app) => { const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); }); servers.push(s); return 'http://127.0.0.1:' + s.address().port; };
    const req = async (base, p) => {
      const r = await fetch(base + p);
      const text = await r.text();
      let b = null; try { b = JSON.parse(text); } catch {}
      return { status: r.status, body: b, text };
    };
    const out = await (async () => { ${script} })();
    for (const s of servers) s.close();
    console.log('@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', boot], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' },
    encoding: 'utf8', cwd: ROOT, timeout: 180_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr?.slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1500)}`);
  return JSON.parse(line.slice(2));
}

test('실제 라우터 — admin/operator/범위 operator 응답(RECENT2600-03·AUTHZ-2600-01~08·DB2600-01)', () => {
  const r = runLive(`
    const [A] = vcs;
    const stType = STORAGE_TYPES.find((t) => t.implemented).type;
    const swType = SAN_SWITCH_TYPES.find((t) => t.implemented).type;
    storageReg.saveDevice({ type: stType, name: 'ST1', host: '10.20.0.50', username: 'stadmin', password: 'p' });
    storageReg.saveDevice({ type: stType, name: '10.20.0.53', host: '10.20.0.53', username: 'stadmin', password: 'p' });
    sanReg.saveDevice({ type: swType, name: 'SW1', host: '10.20.0.51', username: 'swadmin', password: 'p' });
    const hzr = hz.upsertHorizon({ id: 'hz1', name: 'HZ1', host: 'https://10.20.0.60', username: 'u', domain: 'corp', password: 'p' });
    const colr = colReg.addCollector({ id: 'edge-a', name: 'edge-a', url: 'http://10.20.0.90:4000', token: 'x'.repeat(24) });
    bmEdge.putEdgeBmUsage('edge-a', { ok: false, kind: 'unreachable', reason: 'connect ECONNREFUSED 10.20.0.90:4000' });

    // DB2600-01 — 라우트 경로: 장비 2대가 서로 다른 10분 버킷에 수집된다(1시간 주기).
    const HOUR = 3600000; const now = Date.now();
    const base = Math.floor(now / HOUR) * HOUR - 6 * HOUR;
    const ids = storageReg.listDevices().map((d) => d.id);
    for (let h = 0; h < 7; h++) {
      for (const [i, id] of ids.entries()) {
        const at = base + h * HOUR + i * 25 * 60000 + 60000;
        if (at > now) continue;
        await stDb.saveCapacityPoint({ deviceId: id, ok: true, collectedAt: at, capacity: { totalBytes: 100e12, usedBytes: 10e12, pct: 10 } });
      }
    }

    // 형제 경로(작업 로그·시리얼 색인)에 주소가 실리도록 목 수집을 한 번 돌린다.
    const swId = sanReg.listDevices()[0].id; const stId = storageReg.listDevices()[0].id;
    await (await import(${J('sanswitch/poller.js')})).collectDeviceNow(swId).catch(() => {});
    await (await import(${J('storage/poller.js')})).collectDeviceNow(stId).catch(() => {});

    const admin = await start(mk({ username: 'root', role: 'admin', scope: null }));
    const oper = await start(mk({ username: 'op', role: 'operator', scope: null }));
    const sop = await start(mk({ username: 'sop', role: 'operator', scope: { vcenters: [A] } }));
    // 시리얼 검색어 — admin CSV(전체) 에서 주소가 붙은 첫 행의 시리얼
    const csvAll = (await req(admin, '/api/tools/serial-lookup/export.csv')).text.split(/\\r?\\n/).slice(1);
    const withIp = csvAll.find((l) => /\\b10\\.20\\.0\\.\\d+\\b/.test(l)) || '';
    const q = encodeURIComponent((withIp.split(',')[0] || '0').replace(/^\\uFEFF|"/g, ''));
    const P = ['/api/tools/storage-growth', '/api/tools/sanswitch/perf/storage-summary', '/api/tools/sanswitch/perf/activity',
      '/api/tools/serial-lookup?q=' + q, '/api/tools/serial-lookup/export.csv', '/api/tools/horizon-sessions',
      '/api/tools/horizon-sessions/settings', '/api/tools/horizon-sessions/activity', '/api/tools/bm-usage', '/api/tools/bm-usage/edges',
      '/api/tools/storage/activity', '/api/tools/sanswitch/activity'];
    const res = {};
    for (const [who, b] of [['admin', admin], ['oper', oper]]) {
      res[who] = {};
      for (const p of P) { const x = await req(b, p); res[who][p] = { status: x.status, ip: /\\b10\\.20\\.0\\.\\d+\\b/.test(x.text), hidden: x.body?.addressHidden === true, body: p.includes('storage-growth') ? x.body : null }; }
    }
    const host = snap.hosts[0];
    const hp = await req(oper, '/api/idrac/host-power?name=' + encodeURIComponent(host.name));
    const scoped = {
      relaycheck: (await req(sop, '/api/tools/relaycheck')).status,
      relaytopo: (await req(sop, '/api/tools/relaytopo')).status,
      edges: (await req(sop, '/api/tools/bm-usage/edges')).body,
      relaycheckFull: (await req(oper, '/api/tools/relaycheck')).status,
      relaytopoFull: (await req(oper, '/api/tools/relaytopo')).status,
    };
    const hist = (await req(admin, '/api/tools/storage/history?range=12h')).body;
    return { hzr: hzr.ok, colr: colr.ok, res, hp: { status: hp.status, body: hp.body }, scoped, hist, serialQ: q };
  `);
  assert.ok(r.hzr, 'Horizon 등록 실패'); assert.ok(r.colr, '수집 서버 등록 실패');
  for (const [p, a] of Object.entries(r.res.admin)) assert.equal(a.status, 200, `admin ${p} ${a.status}`);
  for (const [p, o] of Object.entries(r.res.oper)) {
    assert.equal(o.status, 200, `oper ${p} ${o.status}`);
    assert.equal(o.ip, false, `비-admin 응답에 관리 주소가 남았다: ${p}`);
    if (!p.includes('.csv')) assert.equal(o.hidden, true, `addressHidden 이 없다: ${p}`);
  }
  // 테스트가 공허하지 않은지 — admin 응답에는 주소가 실제로 들어 있다(형제 경로 몇 개로 확인).
  for (const p of ['/api/tools/storage-growth', '/api/tools/sanswitch/perf/storage-summary', '/api/tools/horizon-sessions',
    '/api/tools/horizon-sessions/settings', '/api/tools/bm-usage/edges', '/api/tools/serial-lookup?q=' + r.serialQ,
    '/api/tools/serial-lookup/export.csv', '/api/tools/storage/activity', '/api/tools/sanswitch/activity']) {
    assert.equal(r.res.admin[p].ip, true, `admin 은 원문을 받아야 한다: ${p}`);
  }
  // RECENT2600-04 — 이름이 주소인 장비는 빈 이름이 아니라 라벨
  const g = r.res.oper['/api/tools/storage-growth'].body;
  const all = [...(g.devices || []), ...(g.noHistory || [])];
  assert.ok(all.length >= 2);
  for (const d of all) assert.ok(d.name, `빈 이름 행: ${JSON.stringify(d)}`);
  // AUTHZ-2600-06
  assert.equal(r.hp.status, 200);
  assert.equal(r.hp.body.addressHidden, true);
  // AUTHZ-2600-07 — 범위 계정은 403, 전체 범위 operator 는 그대로 200
  assert.equal(r.scoped.relaycheck, 403); assert.equal(r.scoped.relaytopo, 403);
  assert.equal(r.scoped.relaycheckFull, 200); assert.equal(r.scoped.relaytopoFull, 200);
  assert.equal(r.scoped.edges.rows.length, 0, '범위 대상이 없는 엣지 행은 주지 않는다');
  assert.equal(r.scoped.edges.edgesOmitted, 1); assert.equal(r.scoped.edges.scoped, true);
  // DB2600-01 — 12h 추이: 장비 2대가 서로 다른 10분 버킷에 수집돼도 점마다 2대가 합산된다
  assert.equal(r.hist.expectedDevices, 2);
  const pts = r.hist.points.filter((p) => p.ts >= r.hist.points[0].ts + 3_600_000);   // 첫 시드 구간 뒤
  assert.ok(pts.length >= 10, `점 ${pts.length}`);
  for (const p of pts) assert.equal(p.devices, 2, `부분 합: ${JSON.stringify(p)}`);
  assert.ok(r.hist.carryMaxMs >= 2 * 3_600_000);
});
