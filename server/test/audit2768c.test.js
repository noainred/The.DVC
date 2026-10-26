/**
 * audit2768c.test.js — v2.768(3회차) 수정 그룹 G3: 데모 가림·Veeam·폴더 사용량.
 *
 *  R3-C2-2  mock 데모 계정이 comm-map·data-flow·device-flow·xfer-speed 로 사람이 등록한 엣지 origin·이름·vCenter·스토리지 이름·
 *           iDRAC 이름/서비스태그를 받던 것 — 403 이 아니라 행 가림(audit2743a 가 데모 xfer-speed 200 을 고정). memo 키에 데모 축.
 *  R3-C1-1  Veeam vu:<vc> 누적 계정이 현재 판정기와 무관하게 덮음 판정을 끄던 것.
 *  R3-C1-2  publicTaskMessage 의 VM 이름 부분 문자열 제거가 FQDN 판정을 깨고 .NET 네임스페이스를 가리던 것.
 *  R3-C4-3  dirusage onlyOnChange 가 '마지막 발송 회차' 가 아니라 '직전 저장 스캔' 과 비교해 미발송 뒤 영영 생략하던 것.
 *
 * ①은 실제 라우터(express) + 실제 denyDemoGuest 를 자식 프로세스에서 띄워 응답 본문으로 본다(소스 grep 아님).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const J = (p) => JSON.stringify(path.join(SRC, p));

process.env.CONFIG_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'audit2768c-pure-'));

/* ───────────────────────── ① R3-C2-2 데모 가림 ───────────────────────── */

const LEAKS = ['10.77.1.20', 'corp-edge-pl', 'Warsaw', 'vcsa-pl01.corp.example', 'PL-Unity-01', '10.77.3.44', 'ABC1234', 'EDGEREAL-SVR', 'TAGREAL9', 'REALTOKEN', 'tok=abc'];

function runFlowHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2768c-'));
  fs.writeFileSync(path.join(dir, 'collectors.json'), JSON.stringify({ collectors: [
    { id: 'corp-edge-pl', name: 'corp-edge-pl', url: 'https://10.77.1.20:4000/sec/path?tok=abc', token: 'REALTOKEN-xyz', datacenter: 'Warsaw' },
    { id: 'mock-Edge-Seoul', name: 'mock-Edge-Seoul', url: 'https://edge-seoul.demo.invalid:4000', token: 'demo-tok-seoul-0001', datacenter: 'Seoul' },
  ] }));
  fs.writeFileSync(path.join(dir, 'vcenters.json'), JSON.stringify({ vcenters: [
    { id: 'vc-real-pl', name: 'vcsa-pl01.corp.example', host: 'https://10.77.1.5', username: 'administrator@vsphere.local', password: 'p', collectMode: 'site', remoteAgent: 'corp-edge-pl' },
  ] }));
  fs.writeFileSync(path.join(dir, 'storage-devices.json'), JSON.stringify({ version: 1, devices: [
    { id: 'st1', name: 'PL-Unity-01', type: 'unity', host: '10.77.2.9', username: 'admin', password: 'x', agent: 'corp-edge-pl' },
  ] }));
  fs.writeFileSync(path.join(dir, 'idrac.json'), JSON.stringify({ servers: [
    { id: '10.77.3.44', name: '10.77.3.44', host: 'https://10.77.3.44', username: 'root', password: 'calvin', serviceTag: 'ABC1234' },
  ] }));
  const script = `
    const fs = await import('node:fs');
    const express = (await import('express')).default;
    const { denyDemoGuest } = await import(${J('auth/demoGuest.js')});
    const { store } = await import(${J('store.js')});
    await store.refresh();
    const { recordIngest } = await import(${J('central/ingestStats.js')});
    const { recordReject } = await import(${J('central/ingestReject.js')});
    const { recordPull } = await import(${J('central/pullStats.js')});
    const { recordOutbound } = await import(${J('util/outboundStats.js')});
    const { setCollectorServers } = await import(${J('collector/remoteInventory.js')});
    const { insertSamples } = await import(${J('xferspeed/db.js')});
    // 실제 엣지의 수신·거부·pull·중앙→엣지 기록 + 등록부에 없는 엣지 이름(데이터 흐름의 '?이름' 노드)
    recordIngest('corp-edge-pl', '/inventory', { wireBytes: 1000, verified: true });
    recordIngest('ghost-edge-real', '/inventory', { wireBytes: 500, verified: true });
    recordIngest('mock-Edge-Seoul', '/inventory', { wireBytes: 800, verified: true });
    recordReject('corp-edge-pl', '/fleet', { status: 403, kind: 'agent', reason: 'corp-edge-pl 토큰 불일치' });
    recordPull('corp-edge-pl', '/storage-config', { status: 200, bytes: 10, verified: true });
    recordOutbound('https://10.77.1.20:4000/api/collector/export', { status: 200, bytes: 100, ms: 5 });
    setCollectorServers('corp-edge-pl', 'Warsaw', [{ id: 'r1', name: 'EDGEREAL-SVR', host: 'https://10.77.9.9', serviceTag: 'TAGREAL9', type: 'idrac' }]);
    setCollectorServers('mock-Edge-Seoul', 'Seoul', [{ id: 'mock-edgeidrac-edge-seoul-1', name: 'edge-seoul-r640-01', host: 'https://192.0.2.1', serviceTag: 'DEMO001', type: 'idrac' }]);
    const ts = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000;
    await insertSamples([
      { agent: 'corp-edge-pl', dir: 'up', ts: ts - 1_800_000, ok: true, bytes: 10485760, mbps: 40, xferMs: 2000, totalMs: 2100, trig: 'auto' },
      { agent: 'corp-edge-pl', dir: 'down', ts, ok: false, bytes: 0, kind: 'connect', error: 'connect ECONNREFUSED 10.77.1.20:4000', trig: 'auto' },
      { agent: 'mock-Edge-Seoul', dir: 'down', ts, ok: true, bytes: 10485760, mbps: 80, xferMs: 1000, totalMs: 1100, trig: 'auto' },
    ]);
    const USERS = { demo: { username: 'thedvcdemp', role: 'admin', demoGuest: true, scope: null }, adm: { username: 'fadm', role: 'admin', scope: null } };
    const app = express();
    app.use((req, res, next) => { req.user = USERS[req.headers['x-who']]; if (denyDemoGuest(req, res)) return; next(); });
    const api = express.Router();
    for (const m of ['commMap', 'dataFlow', 'deviceFlow', 'xferSpeed']) {
      const mod = await import(${J('routes/api')} + '/' + m + '.js');
      mod['register' + m[0].toUpperCase() + m.slice(1)](api);
    }
    app.use('/api', api);
    const srv = app.listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
    const base = 'http://127.0.0.1:' + srv.address().port;
    const call = async (who, p) => { const r = await fetch(base + p, { headers: { 'x-who': who } }); return { st: r.status, txt: await r.text() }; };
    const paths = ['/api/tools/comm-map', '/api/tools/data-flow', '/api/tools/device-flow', '/api/tools/xfer-speed', '/api/tools/xfer-speed/heat',
      '/api/tools/xfer-speed/history?agent=corp-edge-pl', '/api/tools/xfer-speed/history?agent=mock-Edge-Seoul'];
    const out = { demo1: {}, adm: {}, demo2: {} };
    // 순서: 데모 → 관리자 → 데모 — 기억(memoJson·memoized)이 판본을 섞으면 둘째·셋째에서 드러난다.
    for (const p of paths) out.demo1[p] = await call('demo', p);
    for (const p of paths) out.adm[p] = await call('adm', p);
    for (const p of paths) out.demo2[p] = await call('demo', p);
    srv.close();
    fs.writeFileSync(process.env.CONFIG_DIR + '/harness-out.json', JSON.stringify(out));
    console.log('@@done');
    process.exit(0);`;
  const r = spawnSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', DB_DIR: '' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 240_000, maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  assert.ok(r.stdout.includes('@@done'), r.stdout.slice(-600) + r.stderr.slice(-600));
  return JSON.parse(fs.readFileSync(path.join(dir, 'harness-out.json'), 'utf8'));
}
let H = null;
const harness = () => (H ||= runFlowHarness());

test('① R3-C2-2 데모 계정 — 통신 지도·데이터 흐름·3단 지도·전송 속도에 실등록 엣지·장비 값 0, 조회는 200(가림)', () => {
  const out = harness();
  for (const run of ['demo1', 'demo2']) {
    for (const p of ['/api/tools/comm-map', '/api/tools/data-flow', '/api/tools/device-flow', '/api/tools/xfer-speed', '/api/tools/xfer-speed/heat']) {
      const r = out[run][p];
      assert.equal(r.st, 200, `${run} ${p} ${r.txt.slice(0, 200)}`);
      const leaks = LEAKS.filter((s) => r.txt.includes(s));
      assert.deepEqual(leaks, [], `${run} ${p} 샌 값`);
      assert.ok(r.txt.includes('mock-Edge-Seoul'), `${run} ${p} 데모 엣지는 남는다`);
    }
    assert.equal(out[run]['/api/tools/xfer-speed/history?agent=corp-edge-pl'].st, 404, `${run} 실등록 엣지 추이`);
    assert.equal(out[run]['/api/tools/xfer-speed/history?agent=mock-Edge-Seoul'].st, 200, `${run} 데모 엣지 추이`);
  }
  // 가린 수를 밝힌다
  const cm = JSON.parse(out.demo1['/api/tools/comm-map'].txt);
  assert.equal(cm.demoMasked.collectors, 1);
  assert.equal(cm.demoMasked.vcenters, 1);
  assert.equal(cm.demoMasked.storage, 1);
  assert.deepEqual(cm.edges.map((e) => e.id), ['mock-Edge-Seoul']);
  assert.equal(cm.counts.edges, 1, '합계가 남은 행과 맞는다');
  const df = JSON.parse(out.demo1['/api/tools/device-flow'].txt);
  assert.equal(df.demoMasked.idrac, 1);
  assert.equal(df.demoMasked.idracEdge, 1);
  assert.ok(out.demo1['/api/tools/device-flow'].txt.includes('DEMO001'), '데모 엣지 위임 iDRAC 은 남는다');
  const xs = JSON.parse(out.demo1['/api/tools/xfer-speed'].txt);
  assert.deepEqual(xs.rows.map((r) => r.id), ['mock-Edge-Seoul']);
  assert.equal(xs.kpis.total ?? xs.rows.length, xs.rows.length);
  assert.ok(xs.demoMasked.rows >= 1);
});

test('① R3-C2-2 대조: 관리자는 같은 기억 창 안에서도 가리지 않은 판본을 받는다', () => {
  const out = harness();
  for (const p of ['/api/tools/comm-map', '/api/tools/data-flow', '/api/tools/device-flow', '/api/tools/xfer-speed']) {
    const r = out.adm[p];
    assert.equal(r.st, 200, p);
    assert.ok(r.txt.includes('corp-edge-pl'), `${p} 관리자는 실등록 엣지를 본다`);
    assert.equal(JSON.parse(r.txt).demoMasked, undefined, p);
    assert.equal(r.txt.includes('REALTOKEN') || r.txt.includes('tok=abc'), false, `${p} 토큰·경로는 관리자에게도 없다`);
  }
  assert.ok(out.adm['/api/tools/comm-map'].txt.includes('vcsa-pl01.corp.example'));
  assert.ok(out.adm['/api/tools/device-flow'].txt.includes('ABC1234'));
  assert.ok(out.adm['/api/tools/data-flow'].txt.includes('ghost-edge-real'));
  assert.ok(out.adm['/api/tools/xfer-speed/heat'].txt.includes('corp-edge-pl'), '대조: 히트맵 관리자 판본');
  assert.ok(out.adm['/api/tools/xfer-speed'].txt.includes('ECONNREFUSED 10.77.1.20'), '대조: 최근 실패 원문');
  assert.equal(out.adm['/api/tools/xfer-speed/history?agent=corp-edge-pl'].st, 200);
});

test('① R3-C2-2 순수 가림 — 입력 키가 없으면 건드리지 않고, 인증 실패 pull 칸·실제 엣지 링크 id 도 뺀다', async () => {
  const { maskFlowInputsForDemoGuest, maskIdracForDemoGuest, maxMasked } = await import('../src/commmap/demoMask.js');
  const preds = { isDemoCollector: (c) => /^mock-/.test(c.id), isDemoAgent: (n) => /^mock-/.test(n), isDemoItem: (x) => /^mock-/.test(x?.id || ''), isDemoOrigin: (u) => /\.demo\.invalid/.test(u) };
  const { inputs, masked } = maskFlowInputsForDemoGuest({
    collectors: [{ id: 'mock-A' }, { id: 'real' }],
    pulls: { rows: [{ agent: '(인증 실패)' }, { agent: 'mock-A' }], since: 1 },
    latestLinks: [{ link_id: 'central->edge|central|real' }, { link_id: 'central->edge|central|mock-A' }],
    outbound: { rows: [{ base: 'https://a.demo.invalid:4000' }, { base: 'https://10.0.0.1:4000' }, { tag: 'mock-A', base: 'https://x' }] },
  }, preds);
  assert.deepEqual(inputs.collectors.map((c) => c.id), ['mock-A']);
  assert.deepEqual(inputs.pulls.rows.map((r) => r.agent), ['mock-A']);
  assert.deepEqual(inputs.latestLinks.map((r) => r.link_id), ['central->edge|central|mock-A']);
  assert.equal(inputs.outbound.rows.length, 2);
  assert.equal('vcenters' in inputs, false);
  assert.deepEqual(masked, { collectors: 1, pulls: 1, outbound: 1 });
  const im = maskIdracForDemoGuest([{ id: 'x' }], [{ collectorId: 'mock-A' }, { collectorId: 'real' }], preds);
  assert.equal(im.idracLocal.length, 0); assert.equal(im.idracRemote.length, 1);
  assert.deepEqual(maxMasked({ a: 1, b: 3 }, { a: 2 }), { a: 2, b: 3 });
});

/* ───────────────────────── 자식 프로세스 실행 도우미 ───────────────────────── */
function runChild(script, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2768c-c-'));
  const r = spawnSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'live', DB_DIR: '', ...extraEnv(dir) },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, r.stdout.slice(-600) + r.stderr.slice(-600));
  return JSON.parse(line.slice(2));
}

/* ───────────────────────── ② R3-C1-1 Veeam 누적 계정 ───────────────────────── */

test('② R3-C1-1 vu 누적 계정은 지금 판정기로 거른다 — 목록에서 뺀 계정이 덮음 판정을 끄지 않고, 이름 규칙 계정은 남는다', () => {
  const out = runChild(`
    const ev = await import(${J('veeam/snapEvents.js')});
    const sdb = await import(${J('veeam/snapDb.js')});
    const col = await import(${J('veeam/snapCollector.js')});
    const db = await sdb.getSnapDb();
    const o = { open: !!db };
    ev.saveManualAccounts(['svcbak@corp.local', 'oldbak@corp.local']);
    const vc = 'vc-1';
    sdb.rememberVeeamUsers(vc, ['svcbak@corp.local', 'oldbak@corp.local'], Date.now(), db);
    o.coversBoth = col.snapCollectorCovers({ veeamUsers: ['svcbak@corp.local'] }, vc);
    ev.saveManualAccounts(['svcbak@corp.local']);                 // oldbak 을 목록에서 뺐다 — 지금 판정은 Veeam 아님
    o.oldbakNow = ev.makeVeeamAccountMatcher(ev.veeamAccounts())('oldbak@corp.local');
    o.seen = sdb.seenVeeamUsers(vc);
    o.coversAfterRemoval = col.snapCollectorCovers({ veeamUsers: ['svcbak@corp.local'] }, vc);
    // 이름 규칙('veeam') 계정 — 목록에 없어도 판정기는 늘 Veeam 으로 본다 → 누적에 있으면 덮여야 한다(R2-B1-1 목적 유지)
    sdb.rememberVeeamUsers(vc, ['veeamsvc@corp.local'], Date.now(), db);
    o.coversNameRule = col.snapCollectorCovers({ veeamUsers: ['svcbak@corp.local'] }, vc);
    console.log('@@' + JSON.stringify(o));
    process.exit(0);`, () => ({}));
  assert.equal(out.open, true);
  assert.equal(out.coversBoth, true);
  assert.equal(out.oldbakNow, null);
  assert.ok(out.seen.includes('oldbak@corp.local'), '누적 기록 자체는 시한까지 남는다(지우지 않는다)');
  assert.equal(out.coversAfterRemoval, true, '목록에서 뺀 계정 때문에 결합이 꺼지면 안 된다');
  assert.equal(out.coversNameRule, false, "이름 규칙 계정이 지금 userList 에 없으면 '모름'(덮지 않음)");
});

/* ───────────────────────── ③ R3-C1-2 Veeam 작업 메시지 ───────────────────────── */

test('③ R3-C1-2 publicTaskMessage — VM 이름은 단어 경계에서만 빼고, .NET 점 구분 식별자는 주소가 아니다', async () => {
  const { publicTaskMessage } = await import('../src/routes/api/veeam.js');
  const HIDDEN = '작업 메시지에 주소가 들어 있어 관리자 화면에서만 보입니다';
  // ① 부분 문자열 제거가 FQDN 을 쪼개던 것
  assert.equal(publicTaskMessage('Processing web01 Error: proxy vbr01.corp.local not available', { vmName: 'corp' }), HIDDEN);
  assert.equal(publicTaskMessage('Processing corp Error: proxy vbr01.corp.local not available', { vmName: 'corp' }), HIDDEN);
  // VM 이름 자체(점이 든 이름)는 여전히 빼고 판정한다(v2.767 과잉 가림 방지 유지)
  const own = 'Processing db01.corp.local Success';
  assert.equal(publicTaskMessage(own, { vmName: 'db01.corp.local' }), own);
  assert.equal(publicTaskMessage(own, { vmName: 'DB01.corp.local' }), own);
  // ② .NET 네임스페이스는 가리지 않는다
  const dotnet = 'Error: Veeam.Backup.Core.CVmRestoreException timeout';
  assert.equal(publicTaskMessage(dotnet), dotnet);
  assert.equal(publicTaskMessage('Error: Veeam.Backup.Common.Exception at Veeam.Backup.Core.X'), 'Error: Veeam.Backup.Common.Exception at Veeam.Backup.Core.X');
  // 주소는 여전히 가린다 — 전부 대문자·흔한 내부 끝 라벨·PascalCase 라도 끝 라벨이 local
  for (const m of ['proxy VBR01.CORP.LOCAL failed', 'proxy Vbr01.Corp.Local failed', 'repo nas01.example.com full', 'Veeam.Backup.Core.X on vbr-proxy01.corp.local', '\\\\nas01\\veeam', 'at 10.1.2.3'])
    assert.equal(publicTaskMessage(m), HIDDEN, m);
  // 300자 선절단 유지 + 긴 입력에서도 선형(비율 — 절대 ms 단언 금지)
  const long = 'a'.repeat(5000);
  assert.equal(publicTaskMessage(long).length, 300);
  const t0 = process.hrtime.bigint(); for (let i = 0; i < 200; i++) publicTaskMessage(`${'corp '.repeat(2000)}`, { vmName: 'corp' }); const big = Number(process.hrtime.bigint() - t0);
  const t1 = process.hrtime.bigint(); for (let i = 0; i < 200; i++) publicTaskMessage('corp corp', { vmName: 'corp' }); const small = Number(process.hrtime.bigint() - t1);
  assert.ok(big < Math.max(small, 1) * 400, `잘라서 본다 — ${big} vs ${small}`);
});

/* ───────────────────────── ④ R3-C4-3 폴더 사용량 '변경 시에만 발송' ───────────────────────── */

test('④ R3-C4-3 onlyOnChange 는 마지막 발송 성공 회차와 비교 — 미발송 뒤 같은 데이터면 생략하지 않는다', () => {
  const out = runChild(`
    const fs = await import('node:fs'); const path = await import('node:path');
    fs.writeFileSync(path.join(process.env.CONFIG_DIR, 'dirusage.json'), JSON.stringify({ enabled: false,
      targets: [{ id: 't1', agent: 'corpA', path: '/mnt/a', topN: 5, intervalHours: 24, enabled: true }],
      mail: { enabled: true, onlyOnChange: true } }));
    const J = await import(${J('rma/jobs.js')}); const S = await import(${J('dirusage/scheduler.js')}); const D = await import(${J('dirusage/db.js')});
    const db = await D.getDb(); J.noteHeartbeat('corpA', 'i1', {});
    const DU = '1000\\t/mnt/a/hong\\n3000\\t/mnt/a/kim\\n5000\\t/mnt/a\\n';
    const DU2 = '1000\\t/mnt/a/hong\\n4000\\t/mnt/a/kim\\n6000\\t/mnt/a\\n';
    const wait = () => new Promise((r) => setTimeout(r, 10));
    const step = async (r, du) => { J.setJobResult(r.queued[0].reqId, { ok: true, exitCode: 0, stdout: du, stderr: '' }); await wait(); return S.runNow('t1'); };
    const notes = () => db.list('t1', 10).map((x) => [x.id, x.mailed, x.mail_note]);
    let r = await S.runNow('t1');
    r = await step(r, DU);                    // 1회차 — 메일 설정이 없어 미발송(mailed 0)
    r = await step(r, DU);                    // 2회차 — 같은 데이터, 발송 성공 회차가 없다 → 생략하지 않는다
    const afterTwo = notes();
    db.markMailed(afterTwo[0][0], 1, '1명 수신');   // 2회차가 발송에 성공했다고 치자
    r = await step(r, DU);                    // 3회차 — 마지막 발송 회차와 같다 → 생략
    const afterThree = notes();
    r = await step(r, DU2);                   // 4회차 — 달라졌다 → 생략하지 않는다
    console.log('@@' + JSON.stringify({ afterTwo, afterThree, afterFour: notes() }));
    process.exit(0);`, (dir) => ({ DIRUSAGE_DB_PATH: path.join(dir, 'du.db') }));
  const SKIP = '직전과 동일해 발송 생략(변경 시에만 발송)';
  assert.equal(out.afterTwo.length, 2);
  assert.notEqual(out.afterTwo[0][2], SKIP, `2회차는 생략하면 안 된다: ${JSON.stringify(out.afterTwo)}`);
  assert.equal(out.afterThree[0][2], SKIP, JSON.stringify(out.afterThree));
  assert.notEqual(out.afterFour[0][2], SKIP, JSON.stringify(out.afterFour));
});
