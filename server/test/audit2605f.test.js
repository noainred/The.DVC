/**
 * v2.605 감사 그룹 f — DB·타이머·보안·기타 회귀.
 *  DB2605-01 ping baseline 조회 유계 + statusAll 양보 · DB2605-03 capacity prune 청크 · DB2605-04 guestdisk prune 청크(옛 문장과 결과 동일) ·
 *  TIM2605-01 데이터스토어 탐색·VM export 완료 캐시 청소 + 파일 목록 문자열 평탄화 · TIM2605-04 시한·주기 env 정규화(+ 스윕) ·
 *  SEC2605-01 자연어 검색 ReDoS + 길이 상한 · RECENT2605-05 로그 분석 7일 창 '일부' 오판 · RECENT2605-07 SAN 테스트 sections 사유 절단.
 * 기준 시각: 시간 버킷 테스트는 고정 시각(정시 +20·40분)을 쓴다(루트 CLAUDE.md v2.517). 보존 경계 테스트는 경계에서 3시간 이상 떨어뜨린다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2605f-'));
process.env.CONFIG_DIR = TMP;
process.env.PING_DB_PATH = path.join(TMP, 'ping.db');
process.env.CAPACITY_DB_PATH = path.join(TMP, 'capacity.db');
process.env.GUESTDISK_DB_PATH = path.join(TMP, 'guest-disk.db');
process.env.PRUNE_CHUNK_ROWS = '500';           // 청크 사이 양보를 작은 표본으로 관찰한다
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..');
const SRC = path.join(SERVER, 'src');
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** 대상 Promise 가 끝날 때까지 setImmediate 로 자기를 다시 거는 프로브 — 양보 횟수를 센다(v2.581 BUG-E 규약: 벽시계 타이머 금지). */
async function countYields(p) {
  let n = 0; let done = false;
  const spin = () => { if (done) return; n += 1; setImmediate(spin); };
  setImmediate(spin);
  const r = await p;
  done = true;
  return { r, yields: n };
}

function runChild(code, env = {}, args = []) {
  const r = spawnSync(process.execPath, [...args, '--input-type=module', '-e', code], {
    cwd: SERVER, env: { ...process.env, CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'a2605f-c-')), ...env }, encoding: 'utf8', timeout: 90_000,
  });
  if (r.status !== 0) throw new Error(`child 실패(${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

// ── DB2605-01 ─────────────────────────────────────────────────────────────
test('DB2605-01: 자동 baseline 은 최근 7일 OK 표본만 본다(OK 없던 대상의 이력 전체를 훑지 않는다)', async () => {
  const { getPingDb } = await import('../src/ping/db.js');
  const db = await getPingDb();
  const now = Date.now();
  // 30일 전 OK 1건 + 그 뒤 무응답만 — 예전 쿼리는 이 한 건을 찾으려고 무응답 이력을 끝까지 훑었다
  db.insertMany([{ target: 'dead', ts: now - 30 * DAY, rtt: 5, ok: true },
    ...Array.from({ length: 2000 }, (_, i) => ({ target: 'dead', ts: now - 29 * DAY + i * 20 * 60_000, rtt: null, ok: false })),
    { target: 'alive', ts: now - 2 * DAY, rtt: 7, ok: true }]);
  assert.deepEqual(db.recentOkRtt('dead', 200, now - 7 * DAY), [], '7일 안 OK 없음 → 빈 목록');
  assert.deepEqual(db.recentOkRtt('dead', 200), [5], '하한 없이 부르면 예전 동작');
  assert.deepEqual(db.recentOkRtt('alive', 200, now - 7 * DAY), [7]);
});

test('DB2605-01: statusAll 은 7일 하한으로 baseline 을 구하고 대상 사이에 양보한다', async () => {
  const store = await import('../src/ping/store.js');
  const { getPingDb } = await import('../src/ping/db.js');
  const { statusAll, BASELINE_LOOKBACK_MS } = await import('../src/ping/service.js');
  assert.equal(BASELINE_LOOKBACK_MS, 7 * DAY);
  for (const [i, id] of ['dead', 'alive', 'x3'].entries()) {
    const r = store.addTarget({ id, name: id, host: `10.9.0.${i + 1}`, kind: 'icmp' });
    assert.ok(r.ok, r.reason);
  }
  const db = await getPingDb();
  db.insertMany([{ target: 'dead', ts: Date.now() - 60_000, rtt: null, ok: false }]);
  const { r, yields } = await countYields(statusAll());
  const dead = r.targets.find((t) => t.id === 'dead');
  assert.equal(dead.baseline, null, '30일 전 OK 한 건으로 자동 기준을 만들지 않는다');
  assert.equal(dead.status, 'down');
  assert.equal(r.targets.find((t) => t.id === 'alive').baseline, 7);
  assert.ok(yields >= 2, `대상 사이 setImmediate 양보(${yields})`);
});

// ── DB2605-03 ─────────────────────────────────────────────────────────────
test('DB2605-03: capacity prune 은 청크로 지우고 양보한다 — 결과는 옛 한 방 DELETE 와 같다', async () => {
  const { getCapacityDb } = await import('../src/capacity/db.js');
  const db = await getCapacityDb();
  assert.equal(db.kind, 'sqlite');
  const now = Date.UTC(2031, 2, 4, 5, 30);            // 정시 +30분 고정
  const rows = [{ metric: 'cpu_system', v: 1 }, { metric: 'mem_used', v: 2 }];
  // 원본 경계(72h) 이전 1,500회 × 2지표 = 3,000행, 이후 50회 × 2 = 100행. 롤업 경계(400일) 이전 칸도 만든다.
  for (let i = 0; i < 1500; i++) db.insertSnapshot('local', rows, now - 80 * HOUR - i * 30_000, {});
  for (let i = 0; i < 50; i++) db.insertSnapshot('local', rows, now - 10 * HOUR - i * 30_000, {});
  for (let i = 0; i < 3; i++) db.insertSnapshot('edge-a', rows, now - 500 * DAY - i * HOUR, {});
  const { DatabaseSync } = await import('node:sqlite');
  const ro = new DatabaseSync(process.env.CAPACITY_DB_PATH);
  const count = (sql, ...a) => Number(ro.prepare(sql).get(...a).n);
  const before = count('SELECT COUNT(*) n FROM samples');
  const expectRaw = count('SELECT COUNT(*) n FROM samples WHERE ts < ?', now - 72 * HOUR);
  const expectHour = count('SELECT COUNT(*) n FROM samples_hourly WHERE h < ?', now - 400 * DAY);
  const { r, yields } = await countYields(db.prune(now));
  assert.ok(r && typeof r === 'object', 'prune 은 Promise<결과> 다(예전: 동기 undefined)');
  assert.equal(r.deleted, expectRaw);
  assert.equal(r.hourDeleted, expectHour);
  assert.ok(expectHour >= 3);
  assert.equal(count('SELECT COUNT(*) n FROM samples'), before - expectRaw);
  assert.equal(count('SELECT COUNT(*) n FROM samples WHERE ts < ?', now - 72 * HOUR), 0, '옛 한 방 DELETE 와 같은 결과');
  assert.equal(count('SELECT COUNT(*) n FROM samples_hourly WHERE h < ?', now - 400 * DAY), 0);
  assert.ok(yields >= 3, `청크 사이 양보(${yields})`);
  ro.close();
  const src = fs.readFileSync(path.join(SRC, 'capacity/sampler.js'), 'utf8');
  assert.match(src, /Promise\.resolve\(db\.prune\(snap\.ts\)\)\.catch/, '샘플 틱은 prune 을 기다리지 않는다(실패는 prune 안에서 남긴다)');
});

// ── DB2605-04 ─────────────────────────────────────────────────────────────
test('DB2605-04: guestdisk prune 은 청크로 양보하고, 옛 한 방 DELETE 와 남는 행이 같다(결정적 난수 대조)', async () => {
  const gd = await import('../src/guestdisk/db.js');
  const db = await gd.getDb();
  assert.ok(db, 'guestdisk DB 열기');
  const now0 = Date.now();
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  db.exec('BEGIN');
  const insVm = db.prepare('INSERT INTO vm_series (vcenter_id, vm_id, ts, alloc_gb, used_gb) VALUES (?,?,?,?,?)');
  const insPart = db.prepare('INSERT INTO part_series (vcenter_id, vm_id, path, ts, cap_gb, used_gb) VALUES (?,?,?,?,?,?)');
  for (let v = 0; v < 60; v++) {
    const vm = `vm-${v}`;
    if (v % 3 !== 0) db.prepare('INSERT INTO vm_latest (vm_id, vcenter_id, ts) VALUES (?,?,?)').run(vm, 'vc', now0);
    for (let i = 0; i < 60; i++) if (rnd() < 0.8) insVm.run('vc', vm, now0 - (i * 6 + 3) * HOUR, 10, i);
    for (const p of ['/', '/data']) {
      if (rnd() < 0.6) db.prepare('INSERT INTO part_last (vm_id, path, vcenter_id) VALUES (?,?,?)').run(vm, p, 'vc');
      for (let i = 0; i < 20; i++) if (rnd() < 0.7) insPart.run('vc', vm, p, now0 - (i * 18 + 3) * HOUR, 10, i);
    }
  }
  db.exec('COMMIT');
  // 옛 판본(v2.604 까지)의 두 문장을 사본에 그대로 돌려 기대값을 만든다
  const copy = path.join(TMP, 'gd-copy.db');
  db.exec(`VACUUM INTO '${copy}'`);
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(copy);
  const cut = Date.now() - 7 * DAY;
  old.prepare(`DELETE FROM vm_series WHERE ts<? AND NOT (
      vm_id IN (SELECT vm_id FROM vm_latest)
      AND ts = (SELECT MAX(q.ts) FROM vm_series q WHERE q.vm_id = vm_series.vm_id AND q.ts < ?))`).run(cut, cut);
  old.prepare(`DELETE FROM part_series WHERE ts<? AND NOT (
      EXISTS (SELECT 1 FROM part_last l WHERE l.vm_id = part_series.vm_id AND l.path = part_series.path)
      AND ts = (SELECT MAX(q.ts) FROM part_series q WHERE q.vm_id = part_series.vm_id AND q.path = part_series.path AND q.ts < ?))`).run(cut, cut);
  const ids = (d, t) => d.prepare(`SELECT id FROM ${t} ORDER BY id`).all().map((x) => x.id);
  const expVm = ids(old, 'vm_series'); const expPart = ids(old, 'part_series');
  old.close();
  const before = ids(db, 'vm_series').length;
  const { r, yields } = await countYields(gd.prune(7));
  assert.equal(r.ok, true);
  assert.deepEqual(ids(db, 'vm_series'), expVm, 'vm_series 남는 행이 옛 문장과 같다');
  assert.deepEqual(ids(db, 'part_series'), expPart, 'part_series 남는 행이 옛 문장과 같다');
  assert.equal(r.vmSeriesDeleted, before - expVm.length);
  assert.ok(r.vmSeriesDeleted > 1000, `충분한 삭제량(${r.vmSeriesDeleted})`);
  assert.ok(yields >= 2, `청크 사이 양보(${yields})`);
});

// ── TIM2605-01 ────────────────────────────────────────────────────────────
test('TIM2605-01: 데이터스토어 탐색·VM export 의 완료 항목은 60초 뒤 Map 에서 지워진다', async () => {
  const { store } = await import('../src/store.js');
  const prev = store.snapshot;
  store.snapshot = { ...prev, source: 'mock', datastores: [{ id: 'vc1:ds-1', name: 'ds1', vcenterId: 'vc1' }], vcenters: [{ id: 'vc1', name: 'vc1' }], vms: [] };
  try {
    const ds = await import('../src/vcenter/dsBrowse.js');
    const r = await ds.browseDatastore('vc1:ds-1');
    assert.equal(r.mock, true);
    assert.equal(ds._dsBrowseCacheSize(Date.now()), 1, '완료 직후에는 재사용된다');
    assert.equal(ds._dsBrowseCacheSize(Date.now() + 61_000), 0, '60초가 지나면 지운다(예전: 만료 판정만 하고 남김)');
    const vx = await import('../src/vcenter/vmExport.js');
    await vx.buildVmExport('vc1');
    assert.equal(vx._vmExportCacheSize(Date.now()), 1);
    assert.equal(vx._vmExportCacheSize(Date.now() + 61_000), 0);
  } finally { store.snapshot = prev; }
});

test('TIM2605-01: 잘라 낸 파일 목록은 원문 XML 을 붙잡지 않는다(평탄화) — 상주 힙 실측', () => {
  const code = `
    const { parseDsSearchResults } = await import('./src/vcenter/soapParse.js');
    const { flattenFiles } = await import('./src/vcenter/dsBrowse.js');
    const mk = () => { const parts = ['<returnval>'];
      for (let f = 0; f < 40; f++) { parts.push('<HostDatastoreBrowserSearchResults><folderPath>[ds1] folder' + f + '/</folderPath>');
        for (let i = 0; i < 2500; i++) parts.push('<file xsi:type="VmDiskFileInfo"><path>disk' + f + '_' + i + '.vmdk</path><fileSize>' + (i * 7919 % 100000) + '</fileSize><modification>2031-01-01T00:00:' + String(i % 60).padStart(2, '0') + 'Z</modification>' + 'x'.repeat(200) + '</file>');
        parts.push('</HostDatastoreBrowserSearchResults>'); }
      parts.push('</returnval>'); return parts.join(''); };
    const keep = (flat) => { let { files } = parseDsSearchResults(mk(), 200000); files.sort((a, b) => b.sizeBytes - a.sizeBytes); files = files.slice(0, 2000); return flat ? flattenFiles(files) : files; };
    const measure = (flat) => { global.gc(); const b = process.memoryUsage().heapUsed; const held = keep(flat); global.gc(); global.gc(); const a = process.memoryUsage().heapUsed; return { mb: (a - b) / 1048576, n: held.length }; };
    const raw = measure(false); const flat = measure(true);
    console.log(JSON.stringify({ raw: raw.mb, flat: flat.mb, n: flat.n }));`;
  const r = runChild(code, {}, ['--expose-gc']);
  assert.equal(r.n, 2000);
  assert.ok(r.raw > 10, `평탄화 없으면 원문이 남는다 — 대조 ${r.raw.toFixed(1)}MB`);
  assert.ok(r.flat < 5, `평탄화하면 잘라 낸 목록만 남는다(${r.flat.toFixed(1)}MB)`);
  const src = fs.readFileSync(path.join(SRC, 'vcenter/dsBrowse.js'), 'utf8');
  assert.match(src, /files = files\.slice\(0, FILE_CAP\)[\s\S]{0,400}files = flattenFiles\(files\)/, 'browseFresh 가 절단 뒤 평탄화한다');
});

// ── TIM2605-04 ────────────────────────────────────────────────────────────
test('TIM2605-04: SSH exec 시한 env 가 2^31 을 넘어도 즉시 타임아웃이 되지 않는다', () => {
  const r = runChild(`
    import { EventEmitter } from 'node:events';
    const { execAnswered } = await import('./src/proxy/sshExec.js');
    const conn = { exec(cmd, opts, cb) { const s = new EventEmitter(); s.stderr = new EventEmitter(); s.close = () => {}; s.setWindow = () => {}; s.write = () => {}; s.end = () => {};
      cb(null, s); setTimeout(() => { s.emit('data', Buffer.from('ok\\n')); s.emit('close', 0); }, 200); } };
    const t0 = Date.now(); const out = await execAnswered(conn, 'uemcli x');
    console.log(JSON.stringify({ ms: Date.now() - t0, timedOut: !!out.timedOut, stdout: out.stdout }));`, { SSH_EXEC_TIMEOUT_MS: '3000000000' });
  assert.equal(r.timedOut, false, `예전: 2ms 만에 타임아웃(${r.ms}ms)`);
  assert.match(r.stdout, /ok/);
});

test('TIM2605-04: 포탈 DB 샘플러 주기·스토리지 REST 시한·ping 시한 env 는 범위에 가둔다', () => {
  const p = runChild(`
    const seen = []; const orig = globalThis.setInterval;
    globalThis.setInterval = (fn, ms, ...a) => { seen.push(ms); const t = orig(() => {}, 1e9); t.unref?.(); return t; };
    const m = await import('./src/insights/portalDb.js'); m.startDbSizeSampler();
    console.log(JSON.stringify({ seen }));`, { PORTAL_DB_SAMPLE_MS: '-5' });
  assert.ok(p.seen.length >= 1 && p.seen.every((ms) => ms >= 10_000 && ms <= 2 ** 31 - 1), `setInterval 간격 ${p.seen}`);
  const s = runChild(`
    const seen = [];
    AbortSignal.timeout = (ms) => { seen.push(ms); return AbortSignal.abort(); };
    const { makeGetter } = await import('./src/storage/collectors/restCommon.js');
    try { await makeGetter({ host: '127.0.0.1', username: 'u', password: 'p' })('/x'); } catch { /* 중단 */ }
    console.log(JSON.stringify({ seen }));`, { STORAGE_HTTP_TIMEOUT_MS: '-5' });
  assert.ok(s.seen.length >= 1 && s.seen.every((ms) => ms >= 1_000 && ms <= 600_000), `AbortSignal.timeout(${s.seen}) — 예전: -5 → RangeError`);
  const c = runChild("const { config } = await import('./src/config.js'); console.log(JSON.stringify({ t: config.ping.timeoutMs }));", { PING_MON_TIMEOUT_MS: '3000000000' });
  assert.ok(c.t >= 100 && c.t <= 60_000, `ping 시한 ${c.t}`);
  const d = runChild("const { config } = await import('./src/config.js'); console.log(JSON.stringify({ t: config.ping.timeoutMs }));", { PING_MON_TIMEOUT_MS: '' });
  assert.equal(d.t, 2_500, '빈 값은 기본값');
});

// 스윕: 'Number(process.env.X_MS) ||' 를 clampIntervalMs 밖에 새로 만들지 않는다. 남은 것은 사유와 함께 허용 목록.
const LB = '하한(Math.max/min)은 있음 — 2^31 초과만 남은 잔여 후보(다음 점검)';
const RAW = '잔여 후보 — TIM2605-04 배정 밖(다음 점검에서 clampIntervalMs/reqTimeoutMs 로)';
const FORECAST = '예측 최소 구간(비교용 기간 — 타이머 인자가 아니다)';
// v2.606(TIM2606-01·03·04·LEFT2606-04): LLM_TIMEOUT_MS·SSH_READY_TIMEOUT_MS(sshGateway)·SANSW_HTTP/CLI_TIMEOUT_MS·
//   STORAGE_CLI_TIMEOUT_MS·DIRUSAGE_TICK_MS·GUESTDISK_TIMEOUT_MS 를 고치고 목록에서 뺐다(아래 '되돌아가면 안 된다' 에 추가).
const ENV_MS_OK = {
  'agent/fleetPush.js:AGENT_FLEET_WITHHOLD_MAX_MS': LB,
  'agent/gpuGuestPush.js:AGENT_GPU_GUEST_WITHHOLD_MAX_MS': LB,
  'agent/inventoryPush.js:LASTGOOD_HOLD_MS': RAW,
  'bmstor/jobs.js:BMSTOR_ACK_GRACE_MS': RAW,
  'bmstor/poller.js:BMSTOR_PUSH_TIMEOUT_MS': RAW,
  'bmusage/collectors/idracEnterprise.js:BMUSAGE_ENT_BUDGET_MS': LB,
  'bmusage/collectors/idracEnterprise.js:BMUSAGE_ENT_API_MS': LB,
  'bmusage/collectors/idracEnterprise.js:BMUSAGE_ENT_SSH_READY_MS': LB,
  'bmusage/collectors/idracEnterprise.js:BMUSAGE_ENT_CMD_MS': LB,
  'bmusage/db.js:BMUSAGE_COUNT_CACHE_MS': LB,
  'bmusage/poller.js:BMUSAGE_DEVICE_TIMEOUT_MS': LB,
  'central/bmUsageEdgePull.js:BMUSAGE_PULL_TIMEOUT_MS': LB,
  'central/bmUsageEdgePull.js:BMUSAGE_PULL_STALE_MS': LB,
  'central/captureJobs.js:CAPTURE_ACK_GRACE_MS': RAW,
  'central/edgeLogJobs.js:EDGELOG_ACK_TIMEOUT_MS': LB,
  'central/edgeLogJobs.js:EDGELOG_REQ_TTL_MS': LB,
  'central/edgeLogPull.js:EDGELOG_PULL_TIMEOUT_MS': LB,
  'central/edgeRecord.js:CENTRAL_EDGE_AGENT_EVICT_MS': LB,
  'central/fleet.js:CENTRAL_FLEET_TTL_MS': RAW,
  'central/idracScanJobs.js:IDRAC_SCAN_ACK_TIMEOUT_MS': RAW,
  'central/inventory.js:LASTGOOD_HOLD_MS': RAW,
  'central/linkCheckEdge.js:LINKCHECK_REPORT_STALE_MS': LB,
  'central/pduEdge.js:CENTRAL_PDU_TTL_MS': RAW,
  'central/pingJobs.js:PING_ACK_TIMEOUT_MS': RAW,
  'central/pingJobs.js:PING_PENDING_TTL_MS': RAW,
  'central/sanSwitchEdge.js:CENTRAL_SANSW_ORPHAN_TTL_MS': LB,
  'central/tokenCheckPull.js:PORTALCHECK_PULL_TIMEOUT_MS': LB,
  'central/tokenCheckPull.js:PORTALCHECK_PULL_STALE_MS': LB,
  'collector/upgradePush.js:EDGE_PUSH_TIMEOUT_MS': RAW,
  'curuser/db.js:CURUSER_COUNT_CACHE_MS': LB,
  'curuser/poller.js:CURUSER_FIRST_DELAY_MS': RAW,
  'dirusage/scheduler.js:DIRUSAGE_JOB_TIMEOUT_MS': LB,
  'gpu/store.js:GUEST_GPU_TTL_MS': RAW,
  'horizon/sessionPoller.js:HZSESS_FIRST_DELAY_MS': RAW,
  'idrac/redfish.js:BMUSAGE_REPORT_TTL_MS': LB,
  'idrac/redfish.js:BMUSAGE_SENSOR_TTL_MS': LB,
  'idrac/roomTemp.js:ROOMTEMP_STALE_MS': RAW,
  'idrac/service.js:POWER_CURRENT_STALE_MS': RAW,
  'index.js:SERVER_KEEPALIVE_MS': RAW,
  'index.js:SERVER_HEADERS_TIMEOUT_MS': RAW,
  'index.js:SERVER_REQUEST_TIMEOUT_MS': RAW,
  'index.js:SHUTDOWN_GRACE_MS': LB,
  'index.js:SHUTDOWN_HARD_MS': LB,
  'insights/portalDb.js:PORTAL_DB_MIN_FORECAST_MS': FORECAST,
  'insights/serialLookup.js:SERIAL_INDEX_CACHE_MS': LB,
  'ipam/scanRunner.js:IPAM_SCAN_DEADLINE_MS': LB,
  'linkcheck/db.js:LINKCHECK_COUNT_CACHE_MS': LB,
  'logs/db.js:LOGS_META_TTL_MS': LB,
  'partfault/hooks.js:PARTFAULT_HOOK_DEBOUNCE_MS': LB,
  'partfault/scan.js:PARTFAULT_INV_MAX_AGE_MS': LB,
  'pdu/collectRequests.js:PDU_DEVICE_TIMEOUT_MS': LB,
  'pdu/poller.js:PDU_DEVICE_TIMEOUT_MS': LB,
  'pdu/push.js:PDU_PUSH_WITHHOLD_MAX_MS': LB,
  'perf/monitor.js:PERF_INFLIGHT_MAX_AGE_MS': LB,
  'portalcheck/tokenProbe.js:PORTALCHECK_TIMEOUT_MS': LB,
  'portalcheck/tokenProbe.js:PORTALCHECK_BUDGET_MS': LB,
  'proxy/expiry.js:REMOTE_MAPPING_TTL_MS': RAW,
  'relaytopo/ops.js:RELAYTOPO_SSH_TIMEOUT_MS': LB,
  'rma/jobs.js:RMA_ACK_GRACE_MS': RAW,
  'rma/jobs.js:RMA_HEARTBEAT_STALE_MS': RAW,
  'rma/jobs.js:RMA_HEARTBEAT_PURGE_MS': LB,
  'routes/api/perfClient.js:PERF_CLIENT_COOLDOWN_MS': LB,
  'sanswitch/collectRequests.js:SANSW_DEVICE_TIMEOUT_MS': LB,
  'sanswitch/collectors/fosSsh.js:SANSW_CAPS_TTL_MS': LB,
  'sanswitch/perfPoller.js:SANSW_PERF_DEVICE_TIMEOUT_MS': LB,
  'sanswitch/perfPush.js:SANSW_PERF_PUSH_MS': LB,
  'sanswitch/poller.js:SANSW_DEVICE_TIMEOUT_MS': LB,
  'sanswitch/push.js:SANSW_PUSH_MS': LB,
  'sanswitch/testRuns.js:SANSW_TEST_PICKUP_MS': LB,
  'sanswitch/testRuns.js:SANSW_TEST_RESULT_MS': LB,
  'security/loginRateLimit.js:LOGIN_LOCKOUT_MS': RAW,
  'security/loginRateLimit.js:LOGIN_FAIL_WINDOW_MS': RAW,
  'security/loginRateLimit.js:LOGIN_IP_LOCKOUT_MS': LB,
  'security/loginRateLimit.js:OTP_LOCKOUT_MS': RAW,
  'security/loginRateLimit.js:OTP_FAIL_WINDOW_MS': LB,
  'storage/collectRequests.js:STORAGE_DEVICE_TIMEOUT_MS': LB,
  'storage/collectors/cliSsh.js:STORAGE_CLI_SESSION_BUDGET_MS': LB,
  'storage/poller.js:STORAGE_DEVICE_TIMEOUT_MS': LB,
  'storage/poller.js:STORAGE_AREAS_TIMEOUT_MS': LB,
  'store.js:SITE_INVENTORY_STALE_MS': RAW,
  'store.js:LASTGOOD_HOLD_MS': RAW,
  'upgrade/upgrade.js:EDGE_PUSH_TIMEOUT_MS': RAW,
  'util/loopLag.js:LOOP_LAG_WARN_MS': LB,
  'util/rateLimit.js:API_RATE_WINDOW_MS': LB,
  'util/resilientFetch.js:WAN_CONNECT_TIMEOUT_MS': RAW,
  'vcenter/restClient.js:VC_KEEPALIVE_MS': RAW,
  'vcenter/soapClient.js:PERF_COUNTER_TTL_MS': LB,
  'vmseries/poller.js:VMSERIES_FIRST_DELAY_MS': RAW,
};
// ⚠ 허용 목록은 '줄기만 한다'. 다른 그룹이 같은 릴리스에서 항목을 고치므로 여기서 '소스에 없는 항목' 을 실패로 보지 않는다 —
//   목록 정리는 릴리스 통합 시점에 한다(보고서 fix2605_f.md '남은 한계').
test('TIM2605-04 스윕: 시한·주기 env 의 Number(env)||기본값 형태를 허용 목록 밖에 새로 만들지 않는다', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p); } };
  walk(SRC);
  const found = new Set();
  for (const f of files) {
    const s = stripComments(fs.readFileSync(f, 'utf8'));
    for (const m of s.matchAll(/Number\(process\.env\.([A-Z0-9_]+_MS)\)\s*\|\|/g)) {
      if (/clampIntervalMs\(\s*$/.test(s.slice(Math.max(0, m.index - 40), m.index))) continue;
      found.add(`${path.relative(SRC, f).split(path.sep).join('/')}:${m[1]}`);
    }
  }
  const unknown = [...found].filter((k) => !ENV_MS_OK[k]);
  assert.deepEqual(unknown, [], `허용 목록 밖 env 시한: ${unknown.join(', ')}`);
  // 이번에 고친 것은 되돌아가면 안 된다
  for (const k of ['insights/portalDb.js:PORTAL_DB_SAMPLE_MS', 'proxy/sshExec.js:SSH_EXEC_TIMEOUT_MS', 'proxy/sshExec.js:SSH_READY_TIMEOUT_MS',
    'storage/collectors/restCommon.js:STORAGE_HTTP_TIMEOUT_MS', 'bmstor/collect.js:BMSTOR_SSH_TIMEOUT_MS', 'central/idracScanPush.js:IDRAC_PUSH_TIMEOUT_MS',
    'health/network.js:HEALTH_PROBE_TIMEOUT_MS',
    // v2.606
    'llm/config.js:LLM_TIMEOUT_MS', 'proxy/sshGateway.js:SSH_READY_TIMEOUT_MS', 'sanswitch/collectors/fosRest.js:SANSW_HTTP_TIMEOUT_MS',
    'sanswitch/collectors/fosSsh.js:SANSW_CLI_TIMEOUT_MS', 'storage/collectors/cliSsh.js:STORAGE_CLI_TIMEOUT_MS',
    'dirusage/scheduler.js:DIRUSAGE_TICK_MS', 'guestdisk/service.js:GUESTDISK_TIMEOUT_MS']) {
    assert.ok(!found.has(k), `${k} 가 되돌아갔다`);
    assert.ok(!ENV_MS_OK[k], k);
  }
  assert.doesNotMatch(stripComments(fs.readFileSync(path.join(SRC, 'config.js'), 'utf8')), /timeoutMs:\s*numEnv\(process\.env\.PING_MON_TIMEOUT_MS/);
});

// ── SEC2605-01 ────────────────────────────────────────────────────────────
test('SEC2605-01: 자연어 폴백 파서의 퍼센트 정규식은 선형이고 결과는 예전과 같다', async () => {
  const nl = await import('../src/llm/nlSearch.js');
  const t0 = performance.now();
  nl._fallbackParseForTest('1'.repeat(90_000) + 'x');   // v2.613 TESTDOC2613-02: 절대 상한은 1초(회귀와 확실히 갈리는 값 — v2.603) · 입력은 옛 O(n²) 구현이 수 초가 되는 크기
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `90k 숫자열 ${ms.toFixed(1)}ms (예전 30k 에 약 1,000ms — 90k 면 약 9초)`);
  // 옛 정규식과 결과 대조(정상 입력 + 결정적 난수 입력)
  const old = (q) => { const m = q.match(/(\d+)\s*%/); return m ? Number(m[1]) : null; };
  const cur = (q) => nl._fallbackParseForTest(q).filters.find((f) => /Pct$/.test(f.field))?.value ?? null;
  for (const q of ['CPU 80% 이상 VM', '메모리 90 % 넘는 vm', '서울 스토리지 70%', 'vm 목록', 'cpu 5%와 10%', '호스트 100%', 'a12b 34 %']) assert.equal(cur(q), old(q), q);
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const alpha = ['1', '2', '0', ' ', '%', 'a', '가', 'x'];
  for (let k = 0; k < 2000; k++) {
    let q = ''; for (let i = rnd(20) + 1; i > 0; i--) q += alpha[rnd(alpha.length)];
    const m = q.match(/(\d+)\s*%/);
    if (m && m[1].length > 6) continue;   // 7자리 이상 퍼센트는 새 정규식이 받지 않는다(의도된 차이)
    assert.equal(cur(q), old(q), JSON.stringify(q));
  }
});

test('SEC2605-01: 질의 길이 상한 — nlSearch·라우트·ChatOps 가 긴 입력을 해석 전에 거절한다', async () => {
  const nl = await import('../src/llm/nlSearch.js');
  assert.equal(nl.NL_QUERY_MAX, 500);
  await assert.rejects(nl.nlSearch('1'.repeat(60_000) + 'x'), (e) => e.status === 400 && e.code === 'query-too-long');
  const ok = await nl.nlSearch('cpu 80% 이상 vm');
  assert.equal(ok.entity, 'vm');
  const { chatOps } = await import('../src/llm/chatops.js');
  const t0 = performance.now();
  const r = await chatOps('몇 개 ' + '1'.repeat(60_000) + 'x');
  assert.equal(r.tooLong, true);
  assert.ok(performance.now() - t0 < 500);
  // 라우트: 실제 핸들러를 불러 상태코드로 본다
  const { registerSearchNotes } = await import('../src/routes/api/searchNotes.js');
  const routes = {};
  registerSearchNotes({ post: (p, ...h) => { routes[p] = h.at(-1); }, get: () => {} });
  let status = 0; let body = null;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; if (!status) status = 200; return this; } };
  await routes['/search/nl']({ body: { query: '1'.repeat(501) }, user: { username: 'v', role: 'viewer' } }, res);
  assert.equal(status, 400);
  assert.equal(body.error, 'query-too-long');
});

// ── RECENT2605-05 ─────────────────────────────────────────────────────────
test("RECENT2605-05: 오래 켜진 포탈의 7일 보기는 prune 이 창 앞을 지웠으면 '일부' 가 아니다", async () => {
  const L = await import('../src/loganalysis/live.js');
  L._resetLiveForTest();
  L.setLiveRules([]);
  const base = Math.floor(Date.UTC(2031, 0, 1) / HOUR) * HOUR;
  for (let i = 0; i < 240; i++) L.ingest({ ts: base + i * HOUR + 20 * 60_000, tag: 'x', msg: 'hello', level: 'info' });
  const NOW = base + 239 * HOUR + 40 * 60_000;
  for (const h of [24, 72, 168]) assert.equal(L.liveState(h, NOW).coverage.partial, false, `${h}h 창(예전: 168h 만 true)`);
  assert.equal(L.liveState(168, NOW).coverage.prunedBefore, base + 72 * HOUR);
  // 막 시작한 추적은 여전히 '일부' 다(정시 이후 시작)
  L._resetLiveForTest();
  L.setLiveRules([]);
  for (let i = 0; i < 5; i++) L.ingest({ ts: base + i * HOUR + 20 * 60_000, tag: 'x', msg: 'hi', level: 'info' });
  const N2 = base + 4 * HOUR + 40 * 60_000;
  assert.equal(L.liveState(168, N2).coverage.partial, true);
  assert.equal(L.liveState(5, N2).coverage.partial, true, '첫 버킷 hh:20 시작 — 창 시작(정시)보다 늦다');
  assert.equal(L.liveState(4, N2).coverage.partial, false);
  L._resetLiveForTest();
});

// ── RECENT2605-07 ─────────────────────────────────────────────────────────
test('RECENT2605-07: SAN 테스트 회신의 sections 실패 사유를 40자에서 자르지 않는다(넘으면 표식)', async () => {
  const { sanitizeTestSnap } = await import('../src/sanswitch/testRuns.js');
  const reason = 'rbash: sensorshow: command not found (restricted shell)';
  const out = sanitizeTestSnap({ sections: { sensors: reason, ports: 'ok', huge: 'y'.repeat(5000), bad: { x: 1 } } }).sections;
  assert.equal(out.sensors, reason, '사유 전문');
  assert.equal(out.ports, 'ok');
  assert.ok(out.huge.length <= 2010 && out.huge.endsWith('…(잘림)'), '상한을 넘으면 잘렸다고 표시한다');
  assert.equal(out.bad, undefined, '객체 값은 여전히 버린다(React #31 방지)');
});
