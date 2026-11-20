/**
 * 전체 소스 점검 158회차 — 2축(vCenter 수집 · 인벤토리 · 지표 · 이력 DB · 폴러 · 공용 util)의 반증 + 이어 읽기.
 *
 *   N158-1 만든 계정(snaphist/creators.js) — 덮음 기록(from:<vc>)이 31일이어도, 모은 지 31일이 안 된 vCenter(로그 폴러 첫 수집은 최근 7일만 ·
 *          백필은 로그 DB 에 없는 날을 빈 날로 지나 31일 덮음을 적는다)가 'ok' 라 화면이 그 전에 만든 스냅샷을 ‘31일 안 기록 없음’ 으로 단정했다(153회차 추정 P1).
 *   N158-2 지표 샘플러(metrics/sampler.js) — 긴급중단 동안 얼어 있는 스냅샷을 매 분 ‘지금 값’ 으로 적재했다(vCenter 상태가 connected 그대로라 아무것도 거르지 않았다).
 *   N158-3 요청 값으로 여는 고정 표(153회차 N153-3 과 같은 꼴 — routes 전수 스윕): iDRAC 온도 추이 · iDRAC 통합 추이(기간 · 내보내기 열 · 선 모양) ·
 *          스토리지 사용량 추이 · 네트워크 체크 범위 · 서비스 인벤토리 쓰기 연산 표가 상속 키(constructor · __proto__ · toString)를 받았다.
 * 원칙: 실제 함수 · 실제 DB · 실제 라우터를 불러 값으로 판정한다(소스 grep 은 호출부 한 줄 확인에만).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const TMP = tmpDir('full158-');
Object.assign(process.env, { CONFIG_DIR: TMP, TEMP_DB_PATH: path.join(TMP, 'host-temp.db'), DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', IPAM_WRITE_WORKER: '0', METRICS_ROLLUP_BACKFILL: '0' });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const { stripComments } = await import('./_stripComments.js');

const DAY = 86_400_000;
// 기준 시각 — 실제 시각에서 정시 경계로(docs/rules/common.md)
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;

test('N158-1 만든 계정 — 모은 지 31일이 안 된 vCenter 는 덮음 기록이 31일이어도 partial(증명될 때만 · 31일 뒤 스스로 풀린다)', async () => {
  const D = await import('../src/veeam/snapDb.js');
  const { snapshotCreators, lateEventStart } = await import('../src/snaphist/creators.js');
  const { getLogsDb } = await import('../src/logs/db.js');
  const db = await D.getSnapDb();
  assert.ok(db, '스냅샷 이벤트 DB 를 열지 못했다');
  const logs = await getLogsDb();
  assert.equal(logs.kind, 'sqlite');
  const since = NOW - D.RETENTION_MS;
  // 로그 DB: vc-old 는 60일 전부터 · vc-new 는 6일 전부터만(등록 직후 — 로그 폴러 첫 수집은 최근 7일) · vc-never 는 하나도 없다(아직 첫 수집 전)
  const le = (vc, ts, i) => ({ vcenterId: vc, key: `${vc}-${i}`, ts, severity: 'info', type: 'UserLoginSessionEvent', user: 'CORP\\bob', entity: 'h1', message: 'User logged in' });
  const rows = [];
  for (let d = 60; d >= 1; d--) rows.push(le('vc-old', NOW - d * DAY, d));
  for (let d = 6; d >= 1; d--) rows.push(le('vc-new', NOW - d * DAY, d));
  logs.insertMany(rows);
  // 스냅샷 이벤트 DB: 세 곳 모두 백필이 31일 덮음을 적었다(로그 DB 에 없는 날은 빈 날로 지나간다 — veeam/snapDb.js runBackfill)
  const ev = (vc, ts, user, entity) => ({ vcenterId: vc, ts, severity: 'info', type: 'TaskEvent', user, entity, message: 'Task: Create virtual machine snapshot' });
  db.ingest([ev('vc-old', NOW - 3 * DAY, 'CORP\\kim', 'vm-a'), ev('vc-new', NOW - 2 * DAY, 'CORP\\lee', 'vm-b')]);
  for (const vc of ['vc-old', 'vc-new', 'vc-never']) db.setCoveredFrom(vc, since - DAY, NOW);
  db.setCoveredFrom('vc-short', NOW - 8 * DAY, NOW);   // 백필 1단계(8일)까지만 — 백필이 메울 수 있는 틈
  const vmOfVc = (vc, n, name) => ({ id: `${vc}:${n}`, vcenterId: vc, name });
  const snap = {
    vcenters: [{ id: 'vc-old' }, { id: 'vc-new' }, { id: 'vc-never' }],
    vms: [vmOfVc('vc-old', 1, 'vm-a'), vmOfVc('vc-new', 1, 'vm-b'), vmOfVc('vc-new', 2, 'vm-snap-20d-ago'), vmOfVc('vc-never', 1, 'vm-x')],
  };
  const base = { now: NOW, logSettings: { enabled: true, minSeverity: 'info' }, notCollected: new Map() };
  const vcIds = new Set(['vc-old', 'vc-new', 'vc-never']);
  // ① 실제 로그 DB(logsDb 를 주지 않으면 getLogsDb)
  const r = await snapshotCreators({ snap, vcIds, ...base });
  assert.deepEqual(r.vcenters, { 'vc-old': 'ok', 'vc-new': 'partial', 'vc-never': 'partial' },
    '모은 지 31일이 안 된 vCenter 를 ok 로 말했다(화면이 그 전에 만든 스냅샷을 31일 안 기록 없음으로 단정한다)');
  assert.deepEqual(r.coveredFrom, { 'vc-new': NOW - 6 * DAY, 'vc-never': null }, '그 vCenter 의 첫 이벤트 시각(하나도 없으면 null)');
  assert.equal(r.byVm['vc-new\nvc-new:1']?.user, 'CORP\\lee', '찾은 계정은 partial 이어도 그대로다');
  assert.equal(r.byVm['vc-old\nvc-old:1']?.user, 'CORP\\kim');
  assert.equal(r.needBackfill, false, '백필이 메울 틈이 없다(덮음 기록은 31일) — 백필을 시작하지 않는다');
  // ② 31일이 지나면 스스로 풀린다(첫 이벤트가 31일 창 밖으로 나간다 — 로그 DB 는 그대로)
  for (const vc of ['vc-old', 'vc-new']) db.setCoveredFrom(vc, since - DAY, NOW);
  const later = await snapshotCreators({ snap, vcIds: new Set(['vc-old', 'vc-new']), ...base, now: NOW + 26 * DAY });
  assert.equal(later.vcenters['vc-new'], 'ok', '첫 이벤트가 31일보다 오래됐는데도 partial 로 남았다(거짓 partial)');
  // ③ 가를 수 없으면 예전 판정 그대로 — 로그 DB 전체가 31일보다 짧다(신규 설치 · 용량 상한으로 정리됨) · 로그 DB 를 못 열었다 · API 가 없다
  const fake = (min, first) => ({ tsRange: () => ({ min, max: NOW }), firstTs: (vc) => first[vc] ?? 0 });
  const young = await snapshotCreators({ snap, vcIds, ...base, logsDb: fake(NOW - 7 * DAY, { 'vc-old': NOW - 7 * DAY, 'vc-new': NOW - 6 * DAY }) });
  assert.deepEqual(young.vcenters, { 'vc-old': 'ok', 'vc-new': 'ok', 'vc-never': 'ok' }, '로그 DB 전체가 31일보다 짧으면 가를 수 없다 — partial 로 굳히지 않는다');
  for (const ldb of [null, {}, { tsRange: () => { throw new Error('x'); }, firstTs: () => 0 }]) {
    const x = await snapshotCreators({ snap, vcIds, ...base, logsDb: ldb });
    assert.deepEqual(x.vcenters, { 'vc-old': 'ok', 'vc-new': 'ok', 'vc-never': 'ok' });
  }
  // ④ 백필이 메울 수 있는 틈(덮음 기록이 31일에 못 미침)만 needBackfill — 이벤트를 모으지 않는 vCenter 의 틈은 아니다
  const short = await snapshotCreators({ snap: { vcenters: [{ id: 'vc-short' }], vms: [] }, vcIds: new Set(['vc-short']), ...base, logsDb: null });
  assert.equal(short.vcenters['vc-short'], 'partial'); assert.equal(short.needBackfill, true);
  assert.equal(short.coveredFrom['vc-short'], NOW - 8 * DAY, '덮음이 더 늦으면 그 시각');
  // 덮음도 못 미치고 이벤트도 늦게 시작했으면 둘 중 더 늦은 시각 · 어느 한쪽을 모르면 null
  const shortOf = (first, id = 'vc-short') => snapshotCreators({ snap: { vcenters: [{ id }], vms: [] }, vcIds: new Set([id]), ...base, logsDb: fake(since - DAY, first) });
  assert.equal((await shortOf({ 'vc-short': NOW - 6 * DAY })).coveredFrom['vc-short'], NOW - 6 * DAY, '첫 이벤트(6일 전)가 덮음(8일 전)보다 늦다');
  assert.equal((await shortOf({ 'vc-short': NOW - 20 * DAY })).coveredFrom['vc-short'], NOW - 8 * DAY, '덮음(8일 전)이 첫 이벤트(20일 전)보다 늦다');
  assert.equal((await shortOf({})).coveredFrom['vc-short'], null, '이벤트가 하나도 없으면 모름');
  assert.equal((await shortOf({ 'vc-nometa': NOW - 6 * DAY }, 'vc-nometa')).coveredFrom['vc-nometa'], null, '덮음 기록이 없으면 모름');
  assert.equal((await shortOf({ 'vc-short': NOW - 40 * DAY })).coveredFrom['vc-short'], NOW - 8 * DAY, '이벤트는 31일 전부터 있다 — 덮음 시각 그대로');
  const nc = await snapshotCreators({ snap: { vcenters: [{ id: 'vc-short' }], vms: [] }, vcIds: new Set(['vc-short']), ...base, notCollected: new Map([['vc-short', 'maintenance']]), logsDb: null });
  assert.equal(nc.vcenters['vc-short'], 'not-collected'); assert.equal(nc.needBackfill, false);
  // ⑤ 경계(순수)
  const one = (first) => ({ firstTs: () => first });
  assert.deepEqual(lateEventStart(one(since), 'v', since, since - 1), { late: false }, '첫 이벤트가 정확히 31일 전 = 31일을 모았다');
  assert.deepEqual(lateEventStart(one(since + 1), 'v', since, since), { late: true, from: since + 1 });
  assert.deepEqual(lateEventStart(one(since + 1), 'v', since, since + 1), { late: false }, '로그 DB 의 가장 이른 이벤트가 31일 안쪽이면 가를 수 없다');
  assert.deepEqual(lateEventStart(one(0), 'v', since, since - 1), { late: true, from: null });
  assert.deepEqual(lateEventStart(one(since + 1), 'v', since, null), { late: false });
  assert.deepEqual(lateEventStart(one(since + 1), 'v', since, ''), { late: false }, "'' 는 0(1970)이 아니다");
  // ⑥ 라우트는 needBackfill 로만 백필을 시작한다(백필이 못 메우는 partial 로 요청마다 워커를 띄우지 않는다)
  const route = stripComments(fs.readFileSync(path.join(SRC, 'routes/api/vcTools.js'), 'utf8'));
  assert.match(route, /if \(r\.needBackfill\) kickSnapBackfill\(\);/);
  assert.doesNotMatch(route, /includes\('partial'\)\) kickSnapBackfill/);
});

test('N158-2 지표 샘플러 — 긴급중단 동안에는 얼어 있는 스냅샷을 지금 값으로 적재하지 않는다(전 vCenter 사유 stopped)', async () => {
  const { store } = await import('../src/store.js');
  const S = await import('../src/metrics/sampler.js');
  const { getMetricsDb } = await import('../src/metrics/db.js');
  const ES = await import('../src/security/emergencyStop.js');
  const { loadVmperfSettings } = await import('../src/metrics/vmperfSettings.js');
  const stopFile = path.join(TMP, 'emergency-stop.json');
  try {
    await store.refresh();
    const snap0 = store.get();
    assert.ok(snap0.vcenters.length > 0 && snap0.hosts.some((h) => h.tempC != null), '목 스냅샷에 온도 있는 호스트가 있어야 한다');
    // 긴급중단(2인 승인 뒤의 상태 파일) — store.refresh 는 곧바로 돌아와 스냅샷이 그대로다
    fs.writeFileSync(stopFile, JSON.stringify({ active: true, by: ['a', 'b'], at: Date.now() }));
    ES._resetEmergencyStopForTest();
    assert.equal(ES.isStopped(), true);
    await store.refresh();
    assert.equal(store.get(), snap0, '긴급중단 중에는 스냅샷이 얼어 있다(전제)');
    const db = await getMetricsDb();
    const host = snap0.hosts.find((h) => h.tempC != null);
    const points = () => db.history('temp_host', host.id, Date.now() - 3_600_000, 0, 1000).length;
    assert.equal(points(), 0);
    await S._sampleOnceForTest();
    const lr = S.metricsSamplerStatus().lastRun;
    assert.equal(lr.hostsWithTemp, 0, '긴급중단 중 얼어 있는 호스트 온도를 지금 값으로 적재했다');
    assert.equal(points(), 0, 'temp_host 에 행이 쌓였다');
    assert.deepEqual(lr.staleSkipped?.byReason, { stopped: snap0.vcenters.length }, '뺀 사유를 밝힌다(조용한 제외 금지)');
    assert.equal(lr.staleSkipped.hosts, snap0.hosts.length);
    assert.equal(lr.vmperfStale?.vcenters, snap0.vcenters.length, 'VM 할당/사용 계열도 같은 판정으로 뺀다(vmAllocRows 에 판정을 넘긴다)');
    assert.ok(lr.rows < 50, `스냅샷에서 온 행이 남았다(rows ${lr.rows}) — 프로세스 메모리 계열만 남아야 한다`);
    // 순수 판정
    const all = S.samplingUnreadReasons(snap0, { stopped: true });
    assert.equal(all.size, snap0.vcenters.length); assert.ok([...all.values()].every((v) => v === 'stopped'));
    assert.deepEqual([...S.samplingUnreadReasons(snap0, { stopped: false })], [...S.unreadVcenterReasons(snap0)], '긴급중단이 아니면 공용 판정 그대로');
    const rowsStopped = S.vmAllocRows(snap0, { ...loadVmperfSettings(), enabled: true }, { unread: all });
    assert.equal(rowsStopped.size, 0, '긴급중단 판정을 받은 vmAllocRows 가 행을 만들었다');
    assert.ok(S.vmAllocRows(snap0, { ...loadVmperfSettings(), enabled: true }).size > 0, '판정을 주지 않으면 예전 그대로(대조군)');
    // 긴급중단을 풀면 **다음 병합 뒤의** 샘플부터 다시 적재한다(162회차 — 푼 직후의 스냅샷은 아직 중단 전 값이다: 그것을 지금 값으로 적재하지 않는다)
    fs.writeFileSync(stopFile, JSON.stringify({ active: false, by: [], at: null }));
    ES._resetEmergencyStopForTest();
    assert.equal(ES.isStopped(), false);
    await S._sampleOnceForTest();
    assert.equal(S.metricsSamplerStatus().lastRun.hostsWithTemp, 0, '푼 직후(병합 전) 얼어 있는 값을 지금 값으로 적재했다');
    assert.equal(points(), 0);
    await new Promise((r) => setTimeout(r, 5));   // 병합 시각이 '마지막으로 긴급중단을 본 시각' 뒤가 되게
    await store.refresh();
    await S._sampleOnceForTest();
    const lr2 = S.metricsSamplerStatus().lastRun;
    assert.ok(lr2.hostsWithTemp > 0, '긴급중단을 풀었는데도 적재하지 않는다');
    assert.equal(lr2.staleSkipped, undefined);
    assert.equal(points(), 1);
  } finally {
    try { fs.rmSync(stopFile, { force: true }); } catch { /* */ }
    ES._resetEmergencyStopForTest();
  }
});

/** 실제 api · admin · ping 라우터를 목(mock) 모드로 띄워 부른다(자식 프로세스 — 127.0.0.1 포트를 연다). */
function viaRoutes() {
  const dir = tmpDir('full158-route-');
  fs.writeFileSync(path.join(dir, 'idrac.json'), JSON.stringify({ servers: [{ id: 's1', name: 's1', host: '10.9.9.9', username: 'root', password: 'x', type: 'idrac' }] }));
  const script = `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const { adminRouter } = await import(${JSON.stringify(path.join(SRC, 'routes/admin.js'))});
    const { pingRouter } = await import(${JSON.stringify(path.join(SRC, 'routes/ping.js'))});
    const { store } = await import(${JSON.stringify(path.join(SRC, 'store.js'))});
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { username: 'u', role: 'admin', scope: null }; next(); });
    app.use('/api', api); app.use('/api/admin', adminRouter); app.use('/api/ping', pingRouter);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    try { await store.refresh(); } catch { /* */ }
    const corp = store.get().vcenters[0].id;
    const out = [];
    const get = async (name, u, opt) => {
      const r = await fetch(base + u, opt); const t = await r.text(); let b = null; try { b = JSON.parse(t); } catch { /* CSV */ }
      out.push({ name, status: r.status, bucket: b?.bucket ?? null, bucketMs: b?.bucketMs ?? null, range: b?.range ?? null, rangeMs: b?.rangeMs ?? null, spanMs: b?.spanMs ?? null,
        start: b?.start === undefined ? undefined : (b.start === null ? null : 'num'), points: Array.isArray(b?.points) ? b.points.length : null, error: b?.error ?? null, reason: b?.reason ?? null, rev: b?.rev ?? null,
        series: b?.series ? Object.keys(b.series).join(',') : null, cd: r.headers.get('content-disposition'), head: b ? null : t.split('\\n')[0].trim().slice(0, 400) });
    };
    for (const k of ['', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      await get('temp|' + k, '/api/admin/idrac/s1/temp-history?days=1' + (k ? '&bucket=' + k : ''));
      await get('trend|' + k, '/api/admin/idrac/s1/trend' + (k ? '?range=' + k : ''));
      await get('export|' + k, '/api/admin/idrac/trend/export.csv?scope=server&id=s1&cols=cpuPct' + (k ? ',' + k + '&range=' + k + '&styles=' + k + ':dash:2:1' : ''));
      await get('storage|' + k, '/api/tools/storage/history' + (k ? '?range=' + k : ''));
      await get('ping|' + k, '/api/ping/edge/overview' + (k ? '?range=' + k : ''));
    }
    await get('temp|hour', '/api/admin/idrac/s1/temp-history?days=1&bucket=hour');
    await get('temp|minute', '/api/admin/idrac/s1/temp-history?days=1&bucket=minute');
    await get('trend|7d', '/api/admin/idrac/s1/trend?range=7d');
    await get('storage|7d', '/api/tools/storage/history?range=7d');
    await get('ping|7d', '/api/ping/edge/overview?range=7d');
    const post = (name, body) => get(name, '/api/tools/svc-inventory/op', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    for (const op of ['nope', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) { await post('fleet|' + op, { op }); await post('corp|' + op, { op, corp }); }
    await post('fleet|global.add', { op: 'global.add', name: '시험 서비스 158' });
    srv.close();
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, TEMP_DB_PATH: path.join(dir, 'host-temp.db'), DATA_SOURCE: 'mock', AUTH_ENABLED: 'true' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 180_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${String(r.stderr || '').slice(-800)}`);
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력에 결과가 없습니다: ${String(r.stdout || '').slice(-600)}`);
  return new Map(JSON.parse(line.slice(2)).map((x) => [x.name, x]));
}

test('N158-3 요청 값으로 여는 고정 표는 자기 키만 — 상속 키는 모르는 값(기본 · 400)으로 떨어진다(routes 전수 스윕)', async () => {
  const res = viaRoutes();
  const INHERITED = ['constructor', '__proto__', 'toString', 'hasOwnProperty'];
  const pick = (x) => ({ status: x.status, bucket: x.bucket, bucketMs: x.bucketMs, range: x.range, rangeMs: x.rangeMs, spanMs: x.spanMs, start: x.start, points: x.points, error: x.error, series: x.series });
  for (const route of ['temp', 'trend', 'storage', 'ping']) {
    const base = res.get(`${route}|`);
    assert.equal(base.status, 200, `${route} 기본 호출`);
    for (const k of INHERITED) {
      // 모르는 값을 보낸 응답 = 값을 보내지 않은 응답. 수정 전: bucket 'constructor' · 함수를 SQL 에 묶다 오류 · start null · range 'constructor' · rangeMs 없음 · bucketMs null
      assert.deepEqual(pick(res.get(`${route}|${k}`)), pick(base), `${route} ?${k} 가 기본값으로 떨어지지 않았다: ${JSON.stringify(res.get(`${route}|${k}`))}`);
    }
  }
  // 대조군 — 기본 응답이 뜻이 있는 값이고, 아는 값은 그대로 받는다
  assert.equal(res.get('temp|').bucket, 'auto'); assert.equal(res.get('temp|').bucketMs, 3_600_000); assert.equal(res.get('temp|').error, null);
  assert.equal(res.get('temp|hour').bucket, 'hour'); assert.equal(res.get('temp|minute').bucketMs, 60_000);
  assert.equal(res.get('trend|').start, 'num'); assert.equal(res.get('trend|').bucketMs, 300_000); assert.equal(res.get('trend|7d').bucketMs, 3_600_000);
  assert.equal(res.get('storage|').range, '30d'); assert.equal(res.get('storage|7d').range, '7d'); assert.equal(res.get('storage|7d').spanMs, 7 * DAY);
  assert.equal(res.get('ping|').rangeMs, DAY); assert.equal(res.get('ping|7d').rangeMs, 7 * DAY);
  // 내보내기: 모르는 열 · 기간은 버린다(수정 전: 머리글이 함수 원문 · 파일 이름에 'constructor')
  const exp = res.get('export|');
  assert.equal(exp.status, 200); assert.match(exp.head, /CPU 사용률\(%\)$/); assert.match(exp.cd, /idrac-trend_24h_/);
  for (const k of INHERITED) {
    const x = res.get(`export|${k}`);
    assert.equal(x.status, 200);
    assert.equal(x.head, exp.head, `내보내기 열에 ${k} 가 들어갔다: ${x.head}`);
    assert.match(x.cd, /idrac-trend_24h_/, `파일 이름의 기간이 ${k}: ${x.cd}`);
  }
  // 서비스 인벤토리 쓰기 연산: 모르는 연산과 같은 응답(수정 전: 200 · rev 올림 · 감사 기록, '__proto__' 는 500)
  for (const op of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    assert.deepEqual({ ...res.get(`fleet|${op}`), name: '' }, { ...res.get('fleet|nope'), name: '' }, `전역 연산 ${op}`);
    assert.equal(res.get(`corp|${op}`).status, 400, `법인 연산 ${op} 가 400 이 아니다: ${JSON.stringify(res.get(`corp|${op}`))}`);
    assert.match(res.get(`corp|${op}`).reason, /알 수 없는 연산/);
    assert.equal(res.get(`corp|${op}`).rev, null);
  }
  assert.equal(res.get('corp|nope').status, 400);
  assert.equal(res.get('fleet|global.add').status, 200, '아는 연산은 그대로 된다');
  assert.equal(res.get('fleet|global.add').rev, '1.0', '모르는 연산이 rev 를 올렸다(첫 쓰기가 1 이어야 한다)');

  // 순수 함수(내보낸 것)
  const { parseWindow, parseExportStyles, PRESETS } = await import('../src/routes/admin/idracTrend.js');
  const def = parseWindow({}, { now: NOW });
  for (const k of [...INHERITED, 'valueOf', 'nope']) assert.deepEqual(parseWindow({ range: k }, { now: NOW }), def, `parseWindow range=${k}`);
  assert.ok(Number.isFinite(def.start));
  assert.equal(parseWindow({ range: '7d' }, { now: NOW }).end - parseWindow({ range: '7d' }, { now: NOW }).start >= PRESETS['7d'], true);
  assert.deepEqual(parseExportStyles('constructor:dash:2:1,__proto__:dot:1:0,cpuPct:dot:1:0'), { cpuPct: { dash: 'dot', width: 1, marker: false } });

  // 축 안의 비-라우트 모듈: VM 구성 점검 필터(?code · ?sev) — 모르는 값은 거르지 않는다(수정 전: 상속 키는 '맞는 VM 0대')
  const { analyzeVmHygiene } = await import('../src/vmhygiene/analyze.js');
  const vms = [1, 2, 3].map((i) => ({ id: `v${i}`, vcenterId: 'va', name: `vm${i}`, snapshotCount: 5, snapshotOldestTs: NOW - 50 * DAY, snapshotSizeGB: 1, powerState: 'POWERED_ON' }));
  const hs = { snapAgeDays: 7, snapCount: 3, snapSizeGB: 100, uptimeDays: 365, exceptions: [] };
  const matched = (o) => analyzeVmHygiene(vms, hs, { now: NOW, ...o }).matched;
  assert.equal(matched({}), 3);
  for (const k of [...INHERITED, 'valueOf', 'nope']) {
    assert.equal(matched({ code: k }), 3, `?code=${k}`);
    assert.equal(matched({ sev: k }), 3, `?sev=${k}`);
  }
  assert.equal(matched({ code: 'snap-age' }), 3); assert.equal(matched({ code: 'tools-missing' }), 0, '아는 코드는 그대로 거른다');
  assert.equal(matched({ sev: 'warn' }), 3); assert.equal(matched({ sev: 'crit' }), 0, '아는 심각도는 그대로 거른다');
});
