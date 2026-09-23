// v2.583 전수 감사 확정 결함 — 개별 모듈 회귀 고정(분류별 파일에 넣기 애매한 것들).
import test from 'node:test';
import assert from 'node:assert/strict';

test('#28 거부 기록은 인증 전 입력의 길이·종류에 상한을 둔다', async () => {
  const m = await import('../src/central/ingestReject.js');
  m.resetRejects();
  const huge = 'a'.repeat(900_000);
  m.recordReject(huge, '/inventory', { status: 403 });
  const st = m.rejectStats();
  assert.equal(st.rows.length, 1);
  assert.ok(st.rows[0].agent.length <= 64, `agent 길이 ${st.rows[0].agent.length}`);
  for (let i = 0; i < 500; i++) m.recordReject('edge-x', `/p${i}/${'z'.repeat(8_000)}`, { status: 400 });
  const row = m.rejectStats().rows.find((r) => r.agent === 'edge-x');
  const eps = Object.keys(row.byEndpoint);
  assert.ok(eps.length <= 33, `경로 종류 ${eps.length}`);
  assert.ok(eps.includes('(기타)'), '넘친 경로는 (기타)로 합친다');
  assert.ok(eps.every((e) => e.length <= 128));
  // 합계는 보존된다(버리지 않고 합친다)
  const sum = Object.values(row.byEndpoint).reduce((s, n) => s + n, 0);
  assert.equal(sum, 500);
  // 이미 있는 경로는 상한과 무관하게 계속 센다
  m.recordReject('edge-x', `/p0/${'z'.repeat(8_000)}`, { status: 400 });
  const row2 = m.rejectStats().rows.find((r) => r.agent === 'edge-x');
  assert.equal(Object.keys(row2.byEndpoint).length, eps.length);
  m.resetRejects();
});

test('#24 보존일 env 0 은 전부 보관, 빈 값은 기본값', async () => {
  const { execFileSync } = await import('node:child_process');
  const run = (v) => JSON.parse(execFileSync(process.execPath, ['-e',
    "import('./src/config.js').then(({config:c})=>process.stdout.write(JSON.stringify([c.idrac.retentionDays,c.temp.retentionDays,c.ping.retentionDays])))"],
  { env: { ...process.env, IDRAC_RETENTION_DAYS: v, TEMP_RETENTION_DAYS: v, PING_MON_RETENTION_DAYS: v }, cwd: new URL('..', import.meta.url).pathname }).toString());
  assert.deepEqual(run('0'), [0, 0, 0], '0 = keep-all 이 기본값으로 둔갑하면 안 된다');
  assert.deepEqual(run(''), [90, 1830, 365], '빈 값은 미지정(기본값)이다 — 0 으로 읽으면 무제한 보관으로 둔갑');
  assert.deepEqual(run('7'), [7, 7, 7]);
});

test('#36 bm-usage 설정 패치의 빈 값·0(하한>0)은 미지정 — 보존일이 하한으로 줄지 않는다', async () => {
  const { dropUnspecifiedNumbers, normalizeSettings, DEFAULTS } = await import('../src/bmusage/settings.js');
  const { patch, dropped } = dropUnspecifiedNumbers({ rawRetentionDays: 0, dailyRetentionDays: '', intervalMs: null, alertPct: 'abc', alertSustainMin: 0, alertRepeatHours: 3, enabled: true });
  assert.deepEqual(dropped.sort(), ['alertPct', 'dailyRetentionDays', 'intervalMs', 'rawRetentionDays']);
  assert.equal(patch.alertSustainMin, 0, '하한이 0 인 칸의 0 은 유효한 값이다');
  assert.equal(patch.alertRepeatHours, 3);
  assert.equal(patch.enabled, true);
  const prev = normalizeSettings({ rawRetentionDays: 90, dailyRetentionDays: 1825 });
  const next = normalizeSettings({ ...prev, ...patch });
  assert.equal(next.rawRetentionDays, 90);
  assert.equal(next.dailyRetentionDays, 1825);
  assert.equal(next.intervalMs, DEFAULTS.intervalMs);
  // 명시적 유효값은 그대로 하한 강제를 받는다(정규화는 바꾸지 않았다)
  assert.equal(normalizeSettings({ rawRetentionDays: 3 }).rawRetentionDays, 7);
});

test('#20 범위 계정 /overview·/health — 전 함대 합(global)·지역 합(byRegion)이 새지 않고 허용 vCenter 로 재계산된다(실제 api 라우터)', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov2583-'));
  const apiPath = new URL('../src/routes/api.js', import.meta.url).pathname;
  const storePath = new URL('../src/store.js', import.meta.url).pathname;
  const script = `
    const express = (await import('express')).default;
    const { store } = await import(${JSON.stringify(storePath)});
    try { await store.refresh(); } catch {}
    const { api } = await import(${JSON.stringify(apiPath)});
    const snap = store.get();
    const vc = snap.vcenters[0].id;
    const app = express();
    app.use((req, _res, next) => { req.user = req.get('x-s') ? { username: 'sc', role: 'viewer', scope: { vcenters: [vc] } } : { username: 'ad', role: 'admin', scope: null }; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const get = async (u, h) => (await fetch(base + u, { headers: h })).json();
    const full = await get('/api/overview', {});
    const sc = await get('/api/overview', { 'x-s': '1' });
    const hFull = await get('/api/health', {});
    const hSc = await get('/api/health', { 'x-s': '1' });
    srv.close();
    const mine = { hosts: snap.hosts.filter((h) => h.vcenterId === vc).length, vms: snap.vms.filter((v) => v.vcenterId === vc).length };
    console.log('@@' + JSON.stringify({ mine, full: full.global, sc: sc.global, scScoped: sc.scoped, scSites: sc.sites.length, scRegion: sc.byRegion, hFull: [hFull.vcenters, hFull.hosts, hFull.vms], hSc: [hSc.vcenters, hSc.hosts, hSc.vms] }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true' }, encoding: 'utf8', cwd: path.resolve(new URL('..', import.meta.url).pathname), timeout: 120_000,
  });
  assert.equal(r.status, 0, r.stderr.slice(-800));
  const o = JSON.parse(r.stdout.split('@@')[1]);
  assert.ok(o.full.vcenters > 1 && o.full.hosts > o.mine.hosts, '전체 계정은 전 함대 합');
  assert.equal(o.sc.vcenters, 1);
  assert.equal(o.sc.hosts, o.mine.hosts);
  assert.equal(o.sc.vms, o.mine.vms);
  assert.equal(o.sc.powerRegistered, null, '전 함대 iDRAC 등록 수는 범위 계정에 주지 않는다');
  assert.equal(o.scScoped, true);
  assert.equal(o.scSites, 1);
  assert.equal(o.scRegion.length, 1, '자기 지역 1행 — 빈 배열이 아니다');
  assert.equal(o.scRegion[0].hosts, o.mine.hosts, '지역 행도 허용 vCenter 만 합산');
  assert.deepEqual(o.hSc, [1, o.mine.hosts, o.mine.vms], '/health 헤더도 범위 기준');
  assert.equal(o.hFull[0], o.full.vcenters);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#21 미보호 VM — 백업 이벤트를 (vCenter, 이름)으로 대조한다(다른 법인의 동명 VM 을 보호로 세지 않는다)', async () => {
  const { computeUnprotected } = await import('../src/reports/unprotected.js');
  const vms = [
    { id: 'vc-kr:vm-1', name: 'web-01', vcenterId: 'vc-kr', powerState: 'POWERED_ON' },
    { id: 'vc-pl:vm-9', name: 'web-01', vcenterId: 'vc-pl', powerState: 'POWERED_ON' },
  ];
  const rows = [{ type: 'VmSnapshotCreated', user: 'svc-veeam', entity: 'web-01', vcenterId: 'vc-kr', ts: 5 }];
  const r = computeUnprotected(vms, rows);
  assert.equal(r.summary.protectedCount, 1);
  assert.deepEqual(r.unprotected.map((x) => x.id), ['vc-pl:vm-9']);
  assert.equal(r.summary.nameOnlyEvents, 0);
  // vcenterId 없는 옛 행은 이름 폴백 + 개수 공개
  const r2 = computeUnprotected(vms, [{ type: 'VmSnapshotRemoved', user: 'veeam', entity: 'web-01', ts: 1 }]);
  assert.equal(r2.summary.protectedCount, 2);
  assert.equal(r2.summary.nameOnlyEvents, 1);
  // 상한 도달 표시
  assert.equal(computeUnprotected(vms, rows, { rowLimit: 1 }).summary.eventsTruncated, true);
  assert.equal(computeUnprotected(vms, rows, { rowLimit: 10 }).summary.eventsTruncated, false);
});

test('#22 bulkRun — 15분을 넘긴 **진행 중** 실행을 지우지 않는다(끝난 뒤 TTL)', async (t) => {
  const m = await import('../src/util/bulkRun.js');
  m._resetForTest();
  let release; const gate = new Promise((r) => { release = r; });
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; m._resetForTest(); });
  const st = m.startBulkTest({ kind: 'storage', rows: [{ _line: 2, host: 'a' }, { _line: 3, host: 'b' }], testOne: async () => { await gate; return { ok: true }; }, timeoutMs: 3_600_000 });
  assert.equal(st.ok, true);
  const base = realNow();
  Date.now = () => base + 16 * 60_000;
  const mid = m.publicRun(st.id);
  assert.ok(mid, '진행 중 실행이 16분에 사라지면 안 된다');
  assert.equal(mid.status, 'running');
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(m.passedLines(st.id), [2, 3], '끝난 뒤 통과 줄을 쓸 수 있다');
  assert.equal(m.isBusy('storage'), false);
  // 끝난 시각부터 15분 뒤에는 폐기(자격증명 보유 규약)
  const done = m.publicRun(st.id);
  Date.now = () => done.finishedAt + 16 * 60_000;
  assert.equal(m.publicRun(st.id), null);
});

test('#23 ipam 스캔 저장소 — 손상 파일은 .corrupt 로 보존하고 경고한다(다음 저장이 원본을 덮지 않게)', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipam2583-'));
  fs.writeFileSync(path.join(dir, 'ipam-scan-history.json'), '{"10.0.0.1": [ broken');
  const mod = new URL('../src/ipam/scanStore.js', import.meta.url).pathname;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(mod)});`], {
    env: { ...process.env, CONFIG_DIR: dir }, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stderr.slice(-500));
  const names = fs.readdirSync(dir);
  assert.ok(names.some((n) => n.startsWith('ipam-scan-history.json.corrupt.')), `보존본 없음: ${names.join(',')}`);
  assert.match(r.stderr + r.stdout, /ipam-scan-history\.json 파싱 실패/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#35 로그 연합 조회 — 바인딩이 결과보다 먼저 만료되지 않는다 · 모르는 reqId 는 거부(fail-closed)', async (t) => {
  const lq = await import('../src/central/logQueries.js');
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  const t0 = realNow();
  Date.now = () => t0;
  const id = lq.enqueueLogQuery('vc-secret', {}, 'alice');
  Date.now = () => t0 + 10_000;
  lq.setLogQueryResult(id, { vcenterId: 'vc-secret', total: 1, rows: [{ msg: 'secret event' }] });
  Date.now = () => t0 + 125_500; // 큐잉 기준 TTL(2분) 경과 — 다른 결과가 prune 을 돌린다
  lq.setLogQueryResult(lq.enqueueLogQuery('vc-other', {}, 'bob'), { rows: [] });
  const b = lq.bindingOfReq(id);
  assert.deepEqual(b, { owner: 'alice', vcenterId: 'vc-secret' }, '결과가 남아 있는 동안 바인딩도 남는다');
  assert.equal(lq.ownerOfReq(id), 'alice');
  assert.equal(lq.bindingOfReq('lq_nope'), null);
  // 라우트는 바인딩이 없으면 거부한다(소스 고정 — 빈 owner/vc 로 검사를 건너뛰는 형태 금지)
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/routes/api/checksLogs.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf("api.get('/tools/vclogs/federate'"), src.indexOf("api.get('/tools/vclogs',"));
  assert.match(body, /if \(!bind\) return res\.status\(404\)/);
  assert.doesNotMatch(body, /if \(owner && /, '빈 owner 로 소유자 검사를 건너뛰는 형태가 되살아나면 안 된다');
});

test('#29 토큰 점검 — id 와 표시 이름이 다른 수집 서버가 유령 행을 만들지 않는다(실제 api 라우터)', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tok2583-'));
  fs.writeFileSync(path.join(dir, 'collectors.json'), JSON.stringify({ collectors: [{ id: 'col1', name: 'Seoul Edge', url: 'https://10.20.30.40:3001', token: 'synthetic-token-123456', enabled: true }] }));
  const apiPath = new URL('../src/routes/api.js', import.meta.url).pathname;
  const script = `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(apiPath)});
    const app = express();
    app.use((req, _res, next) => { req.user = { username: 'ad', role: 'admin', scope: null }; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const r = await fetch('http://127.0.0.1:' + srv.address().port + '/api/tools/portal-check/tokens');
    const b = await r.json();
    srv.close();
    console.log('@@' + JSON.stringify({ s: r.status, rows: (b.rows || []).map((x) => ({ agent: x.agent, registered: x.registered, from: x.nameFrom })) }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true' }, encoding: 'utf8', timeout: 120_000,
  });
  assert.equal(r.status, 0, r.stderr.slice(-800));
  const o = JSON.parse(r.stdout.split('@@')[1]);
  assert.equal(o.s, 200);
  const names = o.rows.map((x) => x.agent.toLowerCase());
  assert.ok(names.includes('col1'), JSON.stringify(o.rows));
  assert.ok(!names.includes('seoul edge'), `표시 이름으로 유령 행이 생기면 안 된다: ${JSON.stringify(o.rows)}`);
  fs.rmSync(dir, { recursive: true, force: true });
  // 프로브 토큰 조회·엣지 보고 저장 키도 id 를 쓴다(소스 고정)
  const pc = fs.readFileSync(new URL('../src/routes/api/portalCheck.js', import.meta.url), 'utf8');
  assert.match(pc, /const k = norm\(c\.id \|\| c\.name\)/);
  const tp = fs.readFileSync(new URL('../src/central/tokenCheckPull.js', import.meta.url), 'utf8');
  assert.match(tp, /const name = col\.id \|\| col\.name \|\| agent;/);
});

test('#33·#34 엣지 push·위임 워커 — 실패를 상태에 남긴다(현재 사용자 push · IP 스캔 위임 · 설정 사본)', async () => {
  const { execFile } = await import('node:child_process');
  const http = await import('node:http');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const code = req.url.startsWith('/api/central/curuser') ? 413 : 403;
      res.writeHead(code, { 'content-type': 'application/json' }); res.end('{"ok":false}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge2583-'));
  const m = (f) => JSON.stringify(new URL(`../src/agent/${f}`, import.meta.url).pathname);
  const script = `
    const cu = await import(${m('curUserPush.js')});
    const ip = await import(${m('ipScanWorker.js')});
    const cp = await import(${m('configPush.js')});
    let threw = false;
    try { await cu.pushCurUserRecords([{ vmId: 'vm-1', vcenterId: 'vc-a', users: [] }]); } catch { threw = true; }
    await ip.runIpScanAgentOnce();
    await cp.pushConfigNow();
    console.log('@@' + JSON.stringify({ threw, cu: cu.curUserPushStatus().last, ip: ip.ipScanAgentStatus().last, cp: cp.configPushStatus().last }));
  `;
  // 목 중앙이 같은 프로세스에서 응답해야 하므로 spawnSync(이벤트 루프 정지) 대신 비동기 execFile.
  const r = await new Promise((resolve) => execFile(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, CENTRAL_URL: `http://127.0.0.1:${port}`, AGENT_PUSH_CURUSER: '1', AGENT_NAME: 'edge-t', SSRF_ALLOW_LOOPBACK: 'true', WAN_TLS_INSECURE: 'true' },
    timeout: 90_000,
  }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
  srv.close();
  assert.ok(r.stdout.includes('@@'), `${r.err} ${r.stderr.slice(-800)}`);
  const o = JSON.parse(r.stdout.split('@@')[1]);
  assert.equal(o.threw, true);
  assert.match(String(o.cu?.error), /413/, '현재 사용자 push 실패가 상태에 남는다');
  assert.match(String(o.ip?.error), /403/, 'IP 스캔 위임 실패가 상태에 남는다');
  assert.equal(o.ip.kind, 'auth');
  assert.equal(o.cp?.ok, false);
  assert.match(String(o.cp?.error), /403/);
  assert.match(r.stderr + r.stdout, /\[ipscan-agent\] 실패/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#31·#32 수집 서버 상태 — 삭제된 수집기 상태 정리 · 미검증 자기등록이 직전 상태를 지우지 않는다', async () => {
  const st = await import('../src/collector/state.js');
  st.setCollectorStatus('col-gone', { ok: true, version: '2.580.0' });
  st.setCollectorStatus('col-live', { ok: true, version: '2.582.0' });
  st.clearStaleRemote(new Set(['col-live']));
  assert.equal(st.getCollectorStatus('col-gone'), null, '원격 호스트 0개 수집기의 상태도 정리된다');
  assert.ok(st.getCollectorStatus('col-live'));
  st.clearCollectorStatus('col-live');
  assert.equal(st.getCollectorStatus('col-live'), null);
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/routes/central.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('const r = upsertCollectorFromAgent('), src.indexOf('const r = upsertCollectorFromAgent(') + 1800);
  assert.match(body, /const next = \{ \.\.\.prev \};/, '미검증 분기도 직전 상태 위에 덮는다');
  assert.doesNotMatch(body, /setCollectorStatus\(r\.collector\?\.id \|\| name, \{ ok: false/, '상태를 통째로 바꾸는 형태 금지');
  const dc = fs.readFileSync(new URL('../src/routes/admin/collectorsDc.js', import.meta.url), 'utf8');
  assert.match(dc, /clearCollectorStatus\(req\.params\.id\)/);
  assert.match(dc, /if \(r\.collector\?\.enabled === false\) \{ clearCollectorHosts\(curId\); clearCollectorServers\(curId\); \}/);
});

test('#13 SAN·PDU push — 위임 0대면 빈 목록으로 중앙을 비우고, 위임은 있는데 스냅샷이 없으면 보내지 않는다', async () => {
  const { execFile } = await import('node:child_process');
  const http = await import('node:http');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const seen = [];
  const srv = http.createServer((req, res) => {
    const bufs = []; req.on('data', (b) => bufs.push(b));
    req.on('end', () => { seen.push({ url: req.url, body: Buffer.concat(bufs).toString('utf8') }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const run = (dir) => new Promise((resolve) => execFile(process.execPath, ['--input-type=module', '-e', `
      const san = await import(${JSON.stringify(new URL('../src/sanswitch/push.js', import.meta.url).pathname)});
      const pdu = await import(${JSON.stringify(new URL('../src/pdu/push.js', import.meta.url).pathname)});
      const a = await san.pushSanSwitchNow(); const b = await pdu.pushPduNow();
      console.log('@@' + JSON.stringify({ a, b, sa: san.sanSwitchPushStatus(), pa: pdu.pduPushStatus() }));`], {
    env: { ...process.env, CONFIG_DIR: dir, CENTRAL_URL: `http://127.0.0.1:${port}`, CENTRAL_TOKEN: 'synthetic-central-token', AGENT_NAME: 'edge-z', SANSW_PUSH_GZIP: 'false', PDU_PUSH_GZIP: 'false', SSRF_ALLOW_LOOPBACK: 'true' }, timeout: 60_000,
  }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
  // ① 위임 0대
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'push0-'));
  const r1 = await run(d1);
  assert.ok(r1.stdout.includes('@@'), `${r1.err} ${r1.stderr.slice(-600)}`);
  const o1 = JSON.parse(r1.stdout.split('@@')[1]);
  assert.equal(o1.a.cleared, true);
  const sanPost = seen.find((x) => x.url === '/api/central/sanswitch-data');
  assert.ok(sanPost, 'SAN 빈 청크 0 을 보낸다');
  assert.deepEqual(JSON.parse(sanPost.body).devices, []);
  const pduPost = seen.find((x) => x.url === '/api/central/pdu-data');
  assert.ok(pduPost, 'PDU 빈 목록을 보낸다');
  assert.deepEqual(JSON.parse(pduPost.body).snapshots, []);
  // ② 위임은 있는데 스냅샷 없음 — 보내지 않는다
  seen.length = 0;
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'push1-'));
  fs.writeFileSync(path.join(d2, 'sanswitch-devices.json'), JSON.stringify({ devices: [{ id: 'sw1', name: 'sw1', host: '10.1.1.1', agent: 'edge-z', enabled: true }] }));
  fs.writeFileSync(path.join(d2, 'pdu-devices.json'), JSON.stringify({ devices: [{ id: 'p1', name: 'p1', host: '10.1.1.2', agent: 'edge-z', enabled: true }] }));
  const r2 = await run(d2);
  const o2 = JSON.parse(r2.stdout.split('@@')[1]);
  srv.close();
  assert.equal(seen.length, 0, `스냅샷이 없는 위임 장비가 있으면 중앙을 비우지 않는다: ${JSON.stringify(seen.map((x) => x.url))}`);
  assert.match(o2.sa.reason, /위임 장비 1대/);
  assert.match(o2.pa.reason, /위임 PDU 1대/);
  fs.rmSync(d1, { recursive: true, force: true }); fs.rmSync(d2, { recursive: true, force: true });
});

test('#25 시각 표기는 프로세스 TZ 가 아니라 포탈 오프셋(KST) — UTC 서버에서도 같은 값', async () => {
  const { execFileSync } = await import('node:child_process');
  const cwd = new URL('..', import.meta.url).pathname;
  const out = (tz) => execFileSync(process.execPath, ['--input-type=module', '-e', `
    const d = await import('./src/util/dayKey.js');
    const w = await import('./src/tools/wasteExport.js');
    const h = await import('./src/reports/healthReport.js');
    const at = Date.UTC(2026, 8, 23, 0, 4); // KST 09:04
    const txt = h.buildDailyReportText({ overall: 'ok', generatedAt: at, summary: { vcenters: 1, hosts: 1, vms: 1, issues: 0 }, sections: [] }, 'P');
    process.stdout.write(JSON.stringify({ s: d.localStamp(at), f: d.fileStamp(at), z: w.exportZipName({ at }), t: txt.split('\\n')[0] }));`], { cwd, env: { ...process.env, TZ: tz } }).toString();
  const a = JSON.parse(out('UTC'));
  const b = JSON.parse(out('Asia/Seoul'));
  assert.deepEqual(a, b, 'TZ 와 무관해야 한다');
  assert.equal(a.s, '2026-09-23 09:04');
  assert.equal(a.f, '20260923-0904');
  assert.match(a.z, /-20260923-0904\.zip$/);
  assert.match(a.t, /\(2026-09-23 09:04\)/);
  const d = await import('../src/util/dayKey.js');
  assert.equal(d.localStamp(null), '');
  assert.equal(d.fileStamp(''), '');
});

test('#26 프로비저닝 저장 작업 — 응답은 사본(compress 본문 캐시가 제자리 수정 뒤 옛 값을 주지 않게)', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov2583-'));
  fs.writeFileSync(path.join(dir, 'provision-saved.json'), JSON.stringify([{ id: 's1', vcenterId: 'vc-a', memo: 'v1', tags: ['a'] }]));
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const m = await import(${JSON.stringify(new URL('../src/provision/saved.js', import.meta.url).pathname)});
    const a = m.getSaved('s1'); const b = m.getSaved('s1');
    m.updateSaved('s1', { memo: 'v2' });
    const c = m.getSaved('s1');
    const l = m.listSaved({}).items[0];
    process.stdout.write(JSON.stringify({ same: a === b, aMemo: a.memo, cMemo: c.memo, fresh: c !== a, lMemo: l.memo }));`], { env: { ...process.env, CONFIG_DIR: dir } }).toString();
  const o = JSON.parse(out);
  assert.equal(o.same, false, '매 호출 새 객체(정체성 키 캐시가 섞이지 않게)');
  assert.equal(o.aMemo, 'v1', '먼저 받은 사본은 뒤의 수정에 바뀌지 않는다');
  assert.equal(o.cMemo, 'v2');
  assert.equal(o.lMemo, 'v2');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#27 VM 내보내기 캐시 — TTL 은 완료 시각부터, 진행 중은 합류(소스 고정)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/vcenter/vmExport.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function buildVmExport('), src.indexOf('async function buildVmExportFresh('));
  assert.match(body, /hit\.settled \? now - hit\.at < CACHE_MS : now - hit\.startedAt < PENDING_MAX_MS/);
  assert.match(body, /entry\.settled = true; entry\.at = Date\.now\(\)/);
});

test('카탈로그 N3 — iDRAC 스캔 대역 저장이 디스크에 못 쓰면 성공이라 말하지 않는다', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scanr2583-'));
  const blocker = path.join(base, 'file');
  fs.writeFileSync(blocker, 'x');
  const cfg = path.join(blocker, 'cfg'); // 일반 파일 아래 경로 — 쓰기가 ENOTDIR 로 실패한다
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const m = await import(${JSON.stringify(new URL('../src/idrac/scanRanges.js', import.meta.url).pathname)});
    const r = m.saveScanRanges({ datacenterId: 'dc-synth', ranges: '10.9.0.1-10.9.0.5', username: 'root', password: 'x' });
    process.stdout.write(JSON.stringify({ ok: r.ok, reason: r.reason || '' }));`], { env: { ...process.env, CONFIG_DIR: cfg }, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  const o = JSON.parse(out);
  assert.equal(o.ok, false, '디스크 쓰기 실패인데 ok:true 면 재시작 후 사라진 설정을 저장됐다고 말한다');
  assert.match(o.reason, /저장 실패/);
  fs.rmSync(base, { recursive: true, force: true });
});

test('무인증 거부 감사 로그 요약 — 게이트는 하나이고 로그인 실패·차단·API 키 거부가 같이 쓴다', async () => {
  const { createDenyAuditGate, foldedNote } = await import('../src/util/denyAuditGate.js');
  const g = createDenyAuditGate({ windowMs: 60_000 });
  assert.deepEqual(g('1.2.3.4', 0), { write: true, folded: 0 });
  for (let i = 1; i <= 5; i++) assert.equal(g('1.2.3.4', i * 1000).write, false);
  assert.deepEqual(g('1.2.3.4', 61_000), { write: true, folded: 5 }, '버리지 않고 다음 줄에 합친다');
  assert.equal(g('5.6.7.8', 1).write, true, '출처가 다르면 따로');
  assert.equal(foldedNote(0), '');
  assert.match(foldedNote(3), /3건/);
  const fs = await import('node:fs');
  const au = fs.readFileSync(new URL('../src/routes/auth.js', import.meta.url), 'utf8');
  assert.match(au, /if \(lk\.locked\) logAudit\(\{ user: username, action: '로그인 실패\(잠금 발동\)'/, '잠금 발동 줄은 게이트 없이 항상');
  assert.match(au, /loginFailGate\(gateIp\)/);
  assert.match(au, /loginBlockedGate\(gateIp\)/);
  const pa = fs.readFileSync(new URL('../src/publicapi/auth.js', import.meta.url), 'utf8');
  assert.doesNotMatch(pa, /new Map\(\);\s*\/\/[^\n]*deny/i, '게이트를 복사하지 않는다');
  assert.match(pa, /createDenyAuditGate/);
});

test('검증 에이전트 권고 회귀 — SAN 최신 표본 조회·finops 캐시 키·GPU auto 사유·SAN 고아 만료', async () => {
  const fs = await import('node:fs');
  const { stripComments } = await import('./_stripComments.js');
  const rd = (f) => stripComments(fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'));
  const pdb = rd('sanswitch/perfDb.js');
  const lst = pdb.slice(pdb.indexOf('latestSampleTs'), pdb.indexOf('latestSampleTs') + 900);
  assert.doesNotMatch(lst, /GROUP BY/i, 'GROUP BY + MAX 는 테이블을 훑는다(v2.550.3) — 장비별 MAX(ts) 인덱스 선탐색');
  assert.match(lst, /WHERE device_id = \?/);
  const ins = rd('routes/insights.js');
  assert.match(ins, /\|vc:\$\{String\(req\.query\.vcenterId \|\| ''\)\}/, 'finops 캐시 키에 요청 vCenter');
  const gp = rd('gpu/poller.js');
  assert.match(gp, /err = tried\.join\(' \/ '\)/, 'auto 방식은 두 경로의 사유를 모두 남긴다');
  const sw = rd('routes/api/sanSwitch.js');
  assert.match(sw, /orphansExpired/);
  const { ORPHAN_TTL_MS } = await import('../src/central/sanSwitchEdge.js');
  assert.ok(ORPHAN_TTL_MS >= 3_600_000);
});
