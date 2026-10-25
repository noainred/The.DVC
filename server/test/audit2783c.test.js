// v2.783(점검 Q3) — 로그 수집 폴러·지연 판정·백업 보기·게스트 파티션 메일.
//  L-B2  앞서던 vCenter 를 NTP 로 맞춘 뒤 [보정 뒤 실제 시각, 옛 시작점) 의 이벤트를 영영 읽지 않았다(여유 안 — 읽은 커서·마지막 저장은 vCenter 시각).
//        'min(시작점, 지금)' 은 반증(다음 주기의 지금 = 지난 읽기 + 주기 ≥ 앞선 폭). 이제 읽은 커서를 기록한 순간의 **포탈** 시각(_readAt · 커서 파일 readAt)
//        이하에서 시작한다(collectBeginTs) — 옛 커서 파일(readAt 없음)은 기동 시각으로 대신.
//  L-B1  지연 판정의 db.lastTs 경계(지금 + 여유)가 콘솔 줄에만 있었다 — 화면 수집 진단(logStatus collect)·coverage(eventLagForView)·VM 가용성
//        (availabilityCoverage)은 미래 행 1건(2099)이 지연을 숨겼다(measureEndOf = max(okAt, lastTs) 라 okAt 이 있어도).
//  L-B3  '스냅샷만' 보기(서버 vmViewMatches)가 Veeam 모름 VM 을 셌다 — 웹 vmMatches 와 한 쌍(web/src/views/tools/audit2783c.test.js).
//  L-I2  게스트 파티션 메일 — 건너뛸 때의 회복분 정리가 던지면 바깥 catch 가 '발송 실패' 로 기록했다.
// 폴러 테스트는 Date 만 가짜 시계(mock.timers apis:['Date'])로 주기 간격(5·10분)을 흉내 낸다 — 소켓·setTimeout 은 실제 시계.
// 기준 시각은 실제 시각을 분 경계로 떨어뜨린 값(docs/rules/common.md).
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2783c-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';
process.env.VCLOGS_BATCH_ROWS = '100';
process.env.VCLOGS_CONCURRENCY = '1';
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const MIN = 60_000;
const H = 3_600_000;
const DAY = 24 * H;
const CURSOR = path.join(TMP, 'vcenter-logs-cursor.json');
const SRC = new URL('../src/', import.meta.url).pathname;
const P = await import('../src/logs/poller.js');
const D = await import('../src/logs/db.js');
const COV = await import('../src/logs/coverage.js');
const AV = await import('../src/routes/api/vmAvailability.js');
const BS = await import('../src/veeam/backupStatus.js');
const { saveLogSettings } = await import('../src/logs/settings.js');

/**
 * 가짜 vCenter — 이벤트마다 created(포탈 기준 실제 발생 시각)와 ts(vCenter 가 찍은 시각)를 둔다. CreateCollector 때 '이미 생긴(created ≤ 지금)'
 *   이벤트 중 ts ≥ beginTime 만 보여 준다(실제 EventHistoryCollector 와 같은 규칙). 읽어 준 이벤트 번호를 seen 에 모은다.
 */
function fakeVcenter() {
  const state = { events: [], view: [], served: 0, begins: [], seen: new Set(), reads: 0 };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const op = (/<(\w+) xmlns="urn:vim25"/.exec(b) || [])[1] || '?';
      const send = (x) => { res.setHeader('Content-Type', 'text/xml'); res.end(`<soapenv:Envelope><soapenv:Body>${x}</soapenv:Body></soapenv:Envelope>`); };
      if (op === 'RetrieveServiceContent') return send('<RetrieveServiceContentResponse><returnval><propertyCollector>pc</propertyCollector><rootFolder>rf</rootFolder><viewManager>vm</viewManager><sessionManager>sm</sessionManager><eventManager>em</eventManager><about><version>8.0</version></about></returnval></RetrieveServiceContentResponse>');
      if (op === 'Login') { res.setHeader('Set-Cookie', 'vmware_soap_session=x'); return send('<LoginResponse><returnval><key>s</key></returnval></LoginResponse>'); }
      if (op === 'CreateCollectorForEvents') {
        const begin = Date.parse((/<beginTime>([^<]+)<\/beginTime>/.exec(b) || [])[1] || '') || 0;
        const now = Date.now();   // 가짜 시계(포탈과 같은 프로세스)
        state.begins.push({ begin, now });
        state.view = state.events.filter((e) => e.created <= now && e.ts >= begin).sort((x, y) => x.ts - y.ts || x.key - y.key);
        state.served = 0;
        return send('<CreateCollectorForEventsResponse><returnval type="EventHistoryCollector">col</returnval></CreateCollectorForEventsResponse>');
      }
      if (op === 'ReadNextEvents') {
        const n = Number((/<maxCount>(\d+)<\/maxCount>/.exec(b) || [])[1] || 0);
        const page = state.view.slice(state.served, state.served + n);
        state.served += page.length;
        for (const e of page) { state.seen.add(e.key); state.reads += 1; }
        const xml = page.map((e) => `<returnval xsi:type="VmPoweredOffEvent"><key>${e.key}</key><createdTime>${new Date(e.ts).toISOString()}</createdTime><userName>u</userName><vm><name>vm-${e.key}</name></vm><fullFormattedMessage>off ${e.key}</fullFormattedMessage></returnval>`).join('');
        return send(`<ReadNextEventsResponse>${xml}</ReadNextEventsResponse>`);
      }
      return send('<Response></Response>');
    });
  });
  return { srv, state };
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r));
const closeSrv = (srv) => new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); });
const writeRegistry = (list) => fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: list }));
const vcEntry = (id, srv) => ({ id, name: id.toUpperCase(), host: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p', timeoutMs: 5000 });
const freshDb = async (name, minSeverity = 'info') => {
  const dir = path.join(TMP, name); fs.mkdirSync(dir, { recursive: true });
  saveLogSettings({ enabled: true, minSeverity, pollIntervalMin: 10, storagePath: dir });
  D.resetLogsDb();
  try { fs.rmSync(CURSOR, { force: true }); } catch { /* */ }
  P._resetCursorsForTest();
  P._setProcessStartForTest?.(Date.now());   // ?. — 변이 검증(기준판 폴러)에서도 실제 단언까지 가게
  return D.getLogsDb();
};
const row = (vcenterId, key, ts) => ({ vcenterId, key: `${key}@${ts}`, ts, severity: 'info', type: 'VmPoweredOffEvent', user: 'u', entity: `vm-${key}`, message: `off ${key}` });
const T0 = () => Math.floor(Date.now() / MIN) * MIN;

/**
 * NTP 보정 흉내 — vCenter 가 aMin 분 앞서다가 corrAt(포탈 시각)에 보정된다. 20초마다 이벤트 1건(보정 전 ts = created + a · 뒤 ts = created).
 *   주기 i 는 포탈 시각 t0 + i×P 에 돈다(가짜 Date). restart(i) 가 있으면 그 주기 앞에서 부른다(재시작 흉내).
 *   돌려주는 lost = 마지막 주기까지 이미 생겼는데 한 번도 읽히지 않은 이벤트(created 순).
 */
async function ntpRun({ name, Pms, aMin, corrAt, mode, cycles = 6, restart = null, t0 }) {
  const { srv, state } = fakeVcenter();
  await listen(srv);
  const w = mock.method(console, 'warn', () => {}); const l = mock.method(console, 'log', () => {});
  try {
    const db = await freshDb(name, mode === 'filter' ? 'warning' : 'info');
    writeRegistry([vcEntry('pl', srv)]);
    for (let t = t0 - H, k = 1; t <= t0 + cycles * Pms; t += 20_000, k++) state.events.push({ key: k, created: t, ts: t < corrAt ? t + aMin * MIN : t });
    mock.timers.enable({ apis: ['Date'], now: t0 });
    const perCycle = [];
    try {
      for (let i = 0; i < cycles; i++) {
        mock.timers.setTime(t0 + i * Pms);
        if (typeof restart === 'function') await restart(i, db);
        const before = state.reads;
        await P.pollLogsOnce({ manual: true });
        perCycle.push({ at: t0 + i * Pms, read: state.reads - before, begin: state.begins.at(-1)?.begin ?? null });
      }
    } finally { mock.timers.reset(); }
    const end = t0 + (cycles - 1) * Pms;
    const lost = state.events.filter((e) => e.created <= end && !state.seen.has(e.key));
    const stored = mode === 'filter' ? 0 : db.query({ vcenterId: 'pl' }, 100_000, 0).length;
    const distinct = state.events.filter((e) => e.created <= end && state.seen.has(e.key)).length;
    return { lost, perCycle, stored, distinct, begins: state.begins, warns: w.mock.calls.map((c) => String(c.arguments[0])) };
  } finally { w.mock.restore(); l.mock.restore(); await closeSrv(srv); P._resetCursorsForTest(); }
}

/* ── L-B2 ───────────────────────────────────────────────────────────────────────────────────────── */

for (const Pmin of [10, 5]) {
  for (const mode of ['filter', 'stored']) {
    test(`L-B2 — vCenter 7분 앞섬 → 주기 사이에 NTP 보정(주기 ${Pmin}분 · ${mode === 'filter' ? '심각도 필터(저장 0)' : '전량 저장'}): 잃는 이벤트 0 · 중복은 저장되지 않음`, async () => {
      const Pms = Pmin * MIN;
      const t0 = T0();
      const corrAt = t0 + 2 * Pms + Math.min(3 * MIN, Pms / 2);   // 주기 2 와 3 사이
      const r = await ntpRun({ name: `ntp-${Pmin}-${mode}`, Pms, aMin: 7, corrAt, mode, t0 });
      assert.equal(r.lost.length, 0, `잃은 이벤트 ${r.lost.length}건(created ${r.lost.slice(0, 3).map((e) => `+${(e.created - corrAt) / 1000}s`).join(',')} … — 보정 시각 기준) · 시작점 ${JSON.stringify(r.perCycle.map((c) => (c.begin - c.at) / 1000))}`);
      // 시작점은 지난 읽기의 포탈 시각 이하 — 주기 1 이후 앞서는 동안은 지난 주기 시각(= 그 커서를 기록한 포탈 시각)
      for (let i = 1; i <= 2; i++) assert.ok(r.perCycle[i].begin <= r.perCycle[i - 1].at, `주기 ${i} 시작점(+${(r.perCycle[i].begin - r.perCycle[i - 1].at) / 1000}s)은 지난 읽기 포탈 시각 이하`);
      if (mode === 'stored') assert.equal(r.stored, r.distinct, '다시 읽은 이벤트는 번호@시각 키로 걸러져 저장 수 = 서로 다른 이벤트 수');
      assert.equal(r.warns.filter((s) => /시계/.test(s)).length, 0, '여유 안(7분)은 시계 경고를 내지 않는다');
    });
  }
}

test('L-B2 — 앞서지 않은 vCenter 는 다시 읽지 않는다(시작점 = 지난 주기에 읽은 마지막 · 주기마다 새 이벤트만)', async () => {
  const Pms = 10 * MIN;
  const t0 = T0();
  const r = await ntpRun({ name: 'ntp-sync', Pms, aMin: 0, corrAt: 0, mode: 'filter', cycles: 4, t0 });
  assert.equal(r.lost.length, 0);
  for (let i = 1; i < 4; i++) assert.ok(r.perCycle[i].read <= Pms / 20_000 + 1, `주기 ${i} 읽음 ${r.perCycle[i].read}건 — 새 이벤트(${Pms / 20_000}건) + 경계 ms 1건 이하`);
});

test('L-B2 — 재시작(옛 커서 파일 — readAt 없음) 뒤 보정: 기동 시각 이하에서 시작해 잃는 이벤트 0 · 다음 저장부터 readAt 이 파일에 실린다', async () => {
  const Pms = 10 * MIN;
  const t0 = T0();
  const restartAt = t0 + Pms + 3 * MIN;
  const corrAt = t0 + Pms + 5 * MIN;   // 재시작 뒤 보정
  let fileAfter = null;
  let hadReadAt = null;
  const r = await ntpRun({
    name: 'ntp-restart', Pms, aMin: 7, corrAt, mode: 'stored', cycles: 4, t0,
    restart: async (i, db) => {
      if (i === 2) {
        // 재시작 흉내 — 옛 판(v2.782)이 쓴 커서 파일은 readAt 이 없다
        const f = JSON.parse(fs.readFileSync(CURSOR, 'utf8'));
        hadReadAt = f.vcenters.pl.readAt > 0;
        for (const v of Object.values(f.vcenters)) delete v.readAt;
        fs.writeFileSync(CURSOR, JSON.stringify(f));
        P._resetCursorsForTest();
        P._setProcessStartForTest?.(restartAt);
        assert.ok(db.lastTs('pl') > restartAt, '전제: 마지막 저장(vCenter 시각)이 기동 시각보다 늦다');
      }
      if (i === 3) fileAfter = JSON.parse(fs.readFileSync(CURSOR, 'utf8'));
    },
  });
  assert.equal(r.lost.length, 0, `잃은 이벤트 ${r.lost.length}건 — 시작점 ${JSON.stringify(r.perCycle.map((c) => (c.begin - c.at) / 1000))}`);
  assert.ok(r.perCycle[2].begin <= restartAt, `재시작 뒤 첫 시작점(+${(r.perCycle[2].begin - restartAt) / 1000}s)은 기동 시각 이하`);
  assert.equal(hadReadAt, true, '새 판은 커서 파일에 readAt 을 쓴다');
  assert.ok(fileAfter?.vcenters?.pl?.readAt > 0, '재시작 뒤 첫 저장부터 readAt 이 다시 실린다');
  assert.equal(r.stored, r.distinct);
});

test('L-B2 — 보정이 재시작 **전**: 새 커서 파일(readAt 있음)은 잃는 이벤트 0 · 옛 파일(readAt 없음)은 보정~기동 사이만 잃는다(정직 기록 — 일부만 막음)', async () => {
  const Pms = 10 * MIN;
  const run = async (strip) => {
    const t0 = T0();
    const corrAt = t0 + Pms + 3 * MIN;
    const restartAt = t0 + Pms + 5 * MIN;
    const r = await ntpRun({
      name: `ntp-restart-before-${strip ? 'old' : 'new'}`, Pms, aMin: 7, corrAt, mode: 'stored', cycles: 4, t0,
      restart: async (i) => {
        if (i !== 2) return;
        if (strip) {
          const f = JSON.parse(fs.readFileSync(CURSOR, 'utf8'));
          for (const v of Object.values(f.vcenters)) delete v.readAt;
          fs.writeFileSync(CURSOR, JSON.stringify(f));
        }
        P._resetCursorsForTest();
        P._setProcessStartForTest?.(restartAt);
      },
    });
    return { ...r, corrAt, restartAt };
  };
  const nw = await run(false);
  assert.equal(nw.lost.length, 0, `새 파일 — 잃은 이벤트 ${nw.lost.length}건(readAt 을 읽어 지난 읽기 포탈 시각부터)`);
  const old = await run(true);
  assert.ok(old.lost.length > 0, '전제: 옛 파일은 이 경우를 다 막지 못한다');
  assert.ok(old.lost.every((e) => e.created >= old.corrAt && e.created < old.restartAt), `잃는 것은 보정~기동 사이뿐 — ${old.lost.map((e) => (e.created - old.corrAt) / 1000).join(',')}`);
});

test('L-B2 — 커서 파일 readAt: 지금으로 자르고(포탈 시계가 뒤로 간 뒤에도 미래가 경계가 되지 않게) · readTs 없으면 버린다 · collectBeginTs 순수', () => {
  const now = T0();
  assert.deepEqual(
    (({ readTs, readAt }) => ({ readTs, readAt }))(P.normalizeCursorEntry({ readTs: now + 5 * MIN, readAt: now + 5 * MIN }, now)),
    { readTs: now, readAt: now });
  assert.equal(P.normalizeCursorEntry({ readTs: now - MIN, readAt: 'x' }, now).readAt ?? null, null);
  assert.equal(P.normalizeCursorEntry({ readTs: now - MIN }, now).readAt ?? null, null, '옛 파일(키 없음 — 옛 모양 그대로)');
  assert.equal(P.normalizeCursorEntry({ okAt: now - MIN, readAt: now - MIN }, now).readAt ?? null, null, 'readTs 없는 readAt 은 쓰지 않는다');
  assert.equal(P.collectBeginTs(now + 7 * MIN, now, now - H), now, '커서가 readAt 보다 늦으면 readAt');
  assert.equal(P.collectBeginTs(now - MIN, now, now - H), now - MIN, '앞서지 않으면 그대로');
  assert.equal(P.collectBeginTs(now + 7 * MIN, null, now - H), now - H, 'readAt 없으면 대체 경계(기동 시각)');
  assert.equal(P.collectBeginTs(now + 7 * MIN, null, null), now + 7 * MIN, '둘 다 없으면 그대로');
  assert.equal(P.collectBeginTs(now - 7 * DAY, now, now), now - 7 * DAY, '첫 수집 창은 그대로');
});

/* ── L-B1 ───────────────────────────────────────────────────────────────────────────────────────── */

const Y2099 = Date.UTC(2099, 0, 1);

test('L-B1 — 2099 행 1건: 화면 수집 진단(logStatus collect)의 lagMs·마지막 저장은 지금 + 여유 이하의 MAX 로', async () => {
  const w = mock.method(console, 'warn', () => {});
  try {
    const db = await freshDb('lb1-diag');
    assert.equal(db.kind, 'sqlite', '전제: --experimental-sqlite');
    const now = Date.now();
    db.insertMany([row('oc2', 1, now - 3 * DAY), row('oc2', 2, Y2099)]);
    const c = (await P.logStatus()).collect.find((x) => x.vcenterId === 'oc2');
    assert.ok(c, '진단 행');
    assert.equal(c.lastStoredTs, now - 3 * DAY, `마지막 저장 = 미래 행을 뺀 MAX(예전 2099 — ${new Date(c.lastStoredTs).toISOString()})`);
    assert.ok(c.lagMs >= 3 * DAY - MIN, `지연 3일(예전 0 — ${c.lagMs})`);
  } finally { w.mock.restore(); P._resetCursorsForTest(); }
});

test('L-B1 — coverage eventLagForView(실제 db.lastTs): okAt 이 3일 전이어도 2099 행이 지연을 숨기지 않는다', async () => {
  const db = await freshDb('lb1-cov');
  const now = Date.now();
  db.insertMany([row('oc2', 1, now - 3 * DAY), row('oc2', 2, Y2099)]);
  const lag = await COV.eventLagForView({ db, now, deps: { registry: [{ id: 'oc2', host: 'h' }], okAtOf: () => now - 3 * DAY, tolMs: H } });
  assert.ok(Array.isArray(lag), '판정 성공');
  const x = lag.find((y) => y.vcenterId === 'oc2');
  assert.ok(x, `지연 목록에 든다(예전 빈 목록 — ${JSON.stringify(lag)})`);
  assert.ok(x.lagMs >= 3 * DAY - MIN);
});

test('L-B1 — VM 가용성 availabilityCoverage: lastTs 는 지금 + 여유 이하의 MAX(측정 끝이 미래로 밀리지 않는다)', async () => {
  const db = await freshDb('lb1-avail');
  const now = Date.now();
  db.insertMany([row('oc2', 1, now - 3 * DAY), row('oc2', 2, Y2099), row('ok', 3, now - MIN), row('ok', 4, now + 5 * MIN)]);
  const cov = AV.availabilityCoverage(db, ['oc2', 'ok', 'none'], { now, okAtOf: () => now - 3 * DAY });
  assert.equal(cov.get('oc2').lastTs, now - 3 * DAY, '2099 행은 경계 밖');
  assert.equal(cov.get('ok').lastTs, now + 5 * MIN, '여유 안(5분 앞)은 그대로');
  assert.equal(cov.get('none').lastTs, null);
  assert.equal(cov.get('oc2').okAt, now - 3 * DAY);
});

test('L-B1 — 상수는 import 0 모듈 한 벌(coverage 가 폴러를 정적으로 끌어오지 않는다) · 폴러는 같은 이름으로 다시 내보낸다', async () => {
  const T = await import('../src/logs/clockTolerance.js');
  assert.equal(P.FUTURE_CLOCK_TOLERANCE_MS, T.FUTURE_CLOCK_TOLERANCE_MS);
  assert.equal(T.FUTURE_CLOCK_TOLERANCE_MS, 10 * MIN);
  const tol = fs.readFileSync(path.join(SRC, 'logs/clockTolerance.js'), 'utf8');
  assert.doesNotMatch(tol, /^\s*import\s/m, 'import 0');
  const cov = fs.readFileSync(path.join(SRC, 'logs/coverage.js'), 'utf8');
  assert.doesNotMatch(cov, /^import[^\n]*['"]\.\/poller\.js['"]/m, 'coverage 는 폴러를 정적으로 import 하지 않는다');
});

/* ── L-B3 ───────────────────────────────────────────────────────────────────────────────────────── */

test("L-B3 — 서버 '스냅샷만' 은 Veeam 을 아는 VM 만(모름 + 스냅샷 VM 은 들지 않는다 · 'none' 과 같은 규칙)", () => {
  const now = Date.now();
  const unknown = { s: { ev: { ts: now - H, n: 1 } } };               // v 키 없음 = Veeam 모름
  const absent = { v: null, s: { ev: { ts: now - H, n: 1 } } };       // Veeam 에 없음(확인됨)
  assert.equal(BS.vmViewMatches(unknown, 'snaponly', { now }), false, '예전 true');
  assert.equal(BS.vmViewMatches(absent, 'snaponly', { now }), true);
  assert.equal(BS.vmViewMatches(unknown, 'none', { now }), false);
});

/* ── L-I2 ───────────────────────────────────────────────────────────────────────────────────────── */

test("L-I2 — 건너뛸 때 회복분 정리(listPartLatest)가 던져도 기록은 '건너뜀'(unchanged) — '발송 실패' 가 아니다(vCenter·통합 둘 다)", () => {
  const cfg = fs.mkdtempSync(path.join(TMP, 'li2-'));
  const u = (p) => JSON.stringify(path.join(SRC, p));
  const BASE = Math.floor(Date.now() / H) * H - 10 * H;
  const one = (n, used) => ({ vmId: `vc1:vm-${n}`, vmName: `app0${n}`, allocGB: 100, usedGB: used, partCount: 1, parts: [{ path: 'C:\\', capGB: 100, usedGB: used }] });
  const vms = [1, 2].map((n) => ({ id: `vc1:vm-${n}`, vcenterId: 'vc1', name: `app0${n}`, powerState: 'POWERED_ON' }));
  // 실제 guestdisk/db.js 를 다른 URL(?real)로 한 번 읽고, 원래 URL 에는 listPartLatest 만 '켜면 던짐' 으로 감싼 같은 모듈을 둔다(나머지는 같은 인스턴스).
  const script = `
    import { mock } from 'node:test';
    const real = await import(${u('guestdisk/db.js')} + '?real');
    globalThis.__fail = null;
    mock.module(${u('guestdisk/db.js')}, { namedExports: { ...real, listPartLatest: async (ids) => {
      if (globalThis.__fail && globalThis.__fail(ids)) throw new Error('SQLITE_BUSY 흉내');
      return real.listPartLatest(ids);
    } } });
    mock.module(${u('mail/service.js')}, { namedExports: { sendPortalMail: async (o) => ({ ok: true, accepted: o.to }) } });
    mock.module(${u('store.js')}, { namedExports: { store: { get: () => ({ source: 'vcenter', vcenters: [{ id: 'vc1', name: 'VC1' }], vms: ${JSON.stringify(vms)} }) } } });
    const warns = []; console.warn = (s) => warns.push(String(s)); console.log = () => {};
    const S = await import(${u('guestpart/settings.js')});
    const N = await import(${u('guestpart/notify.js')});
    const rep = await import(${u('guestpart/report.js')});
    let ts = ${BASE};
    const commit = async (list) => { ts += ${H}; await real.commitCollection('vc1', 'VC1', list, { ts }); rep._resetPartsCache(); };
    S.save({ threshold: 80, mail: { commonTo: ['ops@example.com'], vcenters: { vc1: { to: ['a@example.com'], onlyOnChange: true, when: 'scan' } },
      digest: { enabled: true, days: [0,1,2,3,4,5,6], time: '09:00', includeAdmin: false, to: ['d@example.com'], newOnly: true, skipIfNoNew: false } } });
    const out = { vc: [], dg: [] };
    await commit([${JSON.stringify(one(1, 90))}, ${JSON.stringify(one(2, 85))}]);
    out.vc.push((await N.sendVcenter('vc1', { trigger: 'scan' })).state);
    out.dg.push((await N.sendDigest({ slot: ts })).state);
    await commit([${JSON.stringify(one(1, 50))}, ${JSON.stringify(one(2, 85))}]);   // vm-1 회복 → 건너뜀 + 회복분 정리
    // vCenter 메일: 회복분 정리만 vcenterIds 배열로 부른다 · 통합 메일: 캐시(partsFor — null)를 먼저 채운 뒤 정리(null)가 둘째 호출
    globalThis.__fail = (ids) => Array.isArray(ids);
    const r1 = await N.sendVcenter('vc1', { trigger: 'scan' });
    out.vc.push({ state: r1.state, code: r1.code || null });
    let calls = 0; globalThis.__fail = () => ++calls >= 2;
    rep._resetPartsCache();
    const r2 = await N.sendDigest({ slot: ts + 1 });
    out.dg.push({ state: r2.state, code: r2.code || null, calls });
    out.warns = warns.filter((s) => /회복분 정리 실패/.test(s)).length;
    process.stdout.write('\\n@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--experimental-sqlite', '--no-warnings', '--input-type=module', '-e', script],
    { env: { ...process.env, CONFIG_DIR: cfg, GUESTDISK_DB_PATH: path.join(cfg, 'guest-disk.db'), NODE_NO_WARNINGS: '1' }, encoding: 'utf8', timeout: 90_000 });
  const i = String(r.stdout).lastIndexOf('@@');
  assert.ok(i >= 0, `자식 실패: ${r.stderr}\n${r.stdout}`);
  const o = JSON.parse(r.stdout.slice(i + 2));
  assert.deepEqual(o.vc[0], 'sent'); assert.deepEqual(o.dg[0], 'sent');
  assert.deepEqual(o.vc[1], { state: 'skipped', code: 'unchanged' }, `vCenter 메일 — 예전 'failed': ${JSON.stringify(o.vc[1])}`);
  assert.equal(o.dg[1].state, 'skipped', `통합 메일 — 예전 'failed': ${JSON.stringify(o.dg[1])}`);
  assert.equal(o.dg[1].code, 'unchanged');
  assert.ok(o.dg[1].calls >= 2, '전제: 정리 호출이 실제로 던졌다');
  assert.equal(o.warns, 2, '경고 1줄씩(무음 실패 금지)');
});
