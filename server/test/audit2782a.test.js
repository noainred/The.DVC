// v2.782(점검 K1) — vCenter 이벤트 로그 수집 폴러: v2.781(G1) 변경이 만든 회귀 2건 + 개선 1건.
//  F-B1  주기 도중 중간 저장(D-I2)이 마지막 묶음 뒤 dirty 를 비우면, 워커 끝의 연속 상한 수(_capStreak) 변경이 dirty 를 세우지 않아
//        주기 끝 저장이 아무것도 쓰지 않았다 — 파일이 늘 한 주기 늦고, 재시작하면 이미 따라잡은 vCenter 에 '연속 상한 N주기' 가 되살아났다.
//  F-B2  읽은 커서를 여유(10분) 안에서도 포탈 지금으로 잘랐다 — 심각도 필터로 행이 저장되지 않는 조금 앞선 vCenter 는 매 주기
//        [포탈 지금, vCenter 지금] 을 다시 읽었다(nextSinceTs 의 '여유 안은 예전 그대로' 는 db.lastTs 가 있을 때만 성립했다).
//        이제 읽은 커서는 여유를 넘을 때만 자르고, 온전한 시각(okAt)은 그대로 지금으로 자른다(지연을 숨기지 않게).
//  F-I1  DB 에 남은 미래 시각 행 1건(prune 은 ts < ? 라 지우지 않는다) 때문에 db.lastTs(MAX) 가 매 주기 미래 — 시작점 후보가 버려져
//        '시계 확인' 경고가 시간당 계속 나고, 커서 파일이 없으면 시작점이 지금이라 마지막 정상 저장~지금 사이를 못 읽었다.
//        이제 시작점 후보·지연 폴백은 db.lastTs(id, { maxTs: 지금 + 여유 }) — (vcenterId, ts) 인덱스 끝점 탐색 1회. 인자 없는 호출은 예전 그대로.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2782a-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';
process.env.VCLOGS_BATCH_ROWS = '100';
process.env.VCLOGS_CONCURRENCY = '1';
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const MIN = 60_000;
const H = 3_600_000;
const DAY = 24 * H;
const CURSOR = path.join(TMP, 'vcenter-logs-cursor.json');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_SRC = path.join(HERE, '../src/logs/db.js');
const P = await import('../src/logs/poller.js');
const D = await import('../src/logs/db.js');
const { saveLogSettings } = await import('../src/logs/settings.js');

/** 가짜 vCenter(audit2781a 와 같은 하네스) — beginTime 을 지키고, ReadNextEvents 마다 커서 파일을 그 순간 그대로 찍어 둔다. */
function fakeVcenter() {
  const state = { events: [], view: [], served: 0, begins: [], snaps: [] };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const op = (/<(\w+) xmlns="urn:vim25"/.exec(b) || [])[1] || '?';
      const send = (x) => { res.setHeader('Content-Type', 'text/xml'); res.end(`<soapenv:Envelope><soapenv:Body>${x}</soapenv:Body></soapenv:Envelope>`); };
      if (op === 'RetrieveServiceContent') return send('<RetrieveServiceContentResponse><returnval><propertyCollector>pc</propertyCollector><rootFolder>rf</rootFolder><viewManager>vm</viewManager><sessionManager>sm</sessionManager><eventManager>em</eventManager><about><version>8.0</version></about></returnval></RetrieveServiceContentResponse>');
      if (op === 'Login') { res.setHeader('Set-Cookie', 'vmware_soap_session=x'); return send('<LoginResponse><returnval><key>s</key></returnval></LoginResponse>'); }
      if (op === 'CreateCollectorForEvents') {
        const begin = Date.parse((/<beginTime>([^<]+)<\/beginTime>/.exec(b) || [])[1] || '') || 0;
        state.begins.push({ begin, at: Date.now() });
        state.view = state.events.filter((e) => e.ts >= begin).sort((x, y) => x.ts - y.ts || String(x.key).localeCompare(String(y.key)));
        state.served = 0;
        return send('<CreateCollectorForEventsResponse><returnval type="EventHistoryCollector">col</returnval></CreateCollectorForEventsResponse>');
      }
      if (op === 'ReadNextEvents') {
        let snap = null;
        try { snap = JSON.parse(fs.readFileSync(CURSOR, 'utf8')); } catch { /* 아직 없다 */ }
        state.snaps.push(snap);
        const n = Number((/<maxCount>(\d+)<\/maxCount>/.exec(b) || [])[1] || 0);
        const page = state.view.slice(state.served, state.served + n);
        state.served += page.length;
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writeRegistry = (list) => fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: list }));
const vcEntry = (id, srv) => ({ id, name: id.toUpperCase(), host: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p', timeoutMs: 5000 });
/** 테스트마다 새 로그 DB(저장 경로) + 빈 커서(메모리·파일). */
const freshDb = async (name, minSeverity = 'info') => {
  const dir = path.join(TMP, name); fs.mkdirSync(dir, { recursive: true });
  saveLogSettings({ enabled: true, minSeverity, pollIntervalMin: 10, storagePath: dir });
  D.resetLogsDb();
  try { fs.rmSync(CURSOR, { force: true }); } catch { /* */ }
  P._resetCursorsForTest();
  return D.getLogsDb();
};
const clockWarns = (w) => w.mock.calls.map((c) => String(c.arguments[0])).filter((s) => /시계/.test(s));
const diagOf = async (id) => (await P.logStatus()).collect.find((x) => x.vcenterId === id);
const fileStreak = (id) => JSON.parse(fs.readFileSync(CURSOR, 'utf8')).vcenters?.[id]?.consecutiveCapped;
/** 가짜 vCenter 가 내는 이벤트와 같은 키(eventRowKey = 번호@시각)의 행 — 미리 DB 에 넣어 두는 용도. */
const row = (vcenterId, key, ts) => ({ vcenterId, key: `${key}@${ts}`, ts, severity: 'info', type: 'VmPoweredOffEvent', user: 'u', entity: `vm-${key}`, message: `off ${key}` });

/* ── F-B1 ───────────────────────────────────────────────────────────────────────────────────────── */

test('F-B1 — 마지막 묶음 뒤 중간 저장이 dirty 를 비워도 주기 끝의 연속 상한 수가 커서 파일에 남는다(메모리 = 파일 · 재시작 뒤 되살아나지 않음)', async () => {
  const { srv, state } = fakeVcenter();
  await listen(srv);
  const w = mock.method(console, 'warn', () => {}); const l = mock.method(console, 'log', () => {});
  try {
    const db = await freshDb('fb1');
    writeRegistry([vcEntry('oc2', srv)]);
    const base = Date.now() - 2 * H;
    state.events = Array.from({ length: 350 }, (_, i) => ({ key: i + 1, ts: base + i * 1000 }));
    // 예산 1ms → 첫 쪽 뒤 'budget' 으로 끝(상한) · 저장 간격 0 → 마지막(=유일한) 묶음 뒤 중간 저장이 dirty 를 비운다
    await P.pollLogsOnce({ manual: true, budgetMs: 1, cursorSaveEveryMs: 0 });
    assert.equal((await diagOf('oc2')).consecutiveCapped, 1, '전제: 메모리 연속 상한 1');
    assert.equal(fileStreak('oc2'), 1, '주기 1 — 파일도 1(예전 0: 한 주기 늦음)');
    await P.pollLogsOnce({ manual: true, budgetMs: 1, cursorSaveEveryMs: 0 });
    assert.equal((await diagOf('oc2')).consecutiveCapped, 2);
    assert.equal(fileStreak('oc2'), 2, '주기 2 — 파일도 2');
    await P.pollLogsOnce({ manual: true, cursorSaveEveryMs: 0 });   // 끝까지 읽음 → 0(지움)
    assert.equal((await diagOf('oc2')).consecutiveCapped, 0);
    assert.equal(fileStreak('oc2'), 0, '주기 3(끝까지 읽음) — 파일도 0(예전 2)');
    // 재시작 흉내 — 이미 따라잡은 vCenter 에 '연속 상한' 이 되살아나지 않는다
    P._resetCursorsForTest();
    P.loadCursorFile({ force: true, dbKey: P.logsDbKey(db) });
    assert.equal(P.logCollectDiag([]).find((x) => x.vcenterId === 'oc2')?.consecutiveCapped, 0);
  } finally { w.mock.restore(); l.mock.restore(); await closeSrv(srv); P._resetCursorsForTest(); }
});

test('F-B1 — 소스: 연속 상한 수는 바뀔 때만 dirty 를 세운다(주기 끝 저장을 force 로 부르지 않는다 — "바뀐 것이 없으면 쓰지 않는다" 계약)', () => {
  const src = fs.readFileSync(path.join(HERE, '../src/logs/poller.js'), 'utf8');
  assert.doesNotMatch(src, /saveCursorFile\(\{\s*[^}]*force:\s*true/, '폴러가 주기 끝 저장을 force 로 부르면 바뀐 것이 없어도 매 주기 쓴다');
});

/* ── F-B2 ───────────────────────────────────────────────────────────────────────────────────────── */

test('F-B2 — 여유 안(1분) 앞선 vCenter + 심각도 필터(저장 0): 다음 주기 시작점은 지난 주기에 읽은 마지막(지금으로 끌어내리지 않음) · 같은 5건을 다시 읽지 않음 · okAt 은 지금 이하', async () => {
  const { srv, state } = fakeVcenter();
  await listen(srv);
  const w = mock.method(console, 'warn', () => {}); const l = mock.method(console, 'log', () => {});
  try {
    const db = await freshDb('fb2', 'warning');
    writeRegistry([vcEntry('us', srv)]);
    const now = Date.now();
    state.events = Array.from({ length: 5 }, (_, i) => ({ key: i + 1, ts: now + MIN + i * 1000 }));   // info 5건 — 심각도 필터로 저장되지 않는다
    await P.pollLogsOnce({ manual: true });
    const c1 = await diagOf('us');
    assert.ok(c1.okAt <= Date.now(), `온전한 시각은 지금 이하(+${c1.okAt - Date.now()}ms) — 지연을 숨기지 않게`);
    assert.equal(c1.cursorTs, now + MIN + 4000, '여유 안의 읽은 커서는 원래 값 그대로');
    await sleep(20);
    await P.pollLogsOnce({ manual: true });
    assert.equal(state.begins.length, 2);
    assert.equal(state.begins[1].begin, now + MIN + 4000, `주기 2 시작점 = 지난 주기에 읽은 마지막(포함) — 예전은 포탈 지금(+${state.begins[1].begin - now}ms)`);
    const c2 = await diagOf('us');
    assert.ok(c2.lastPoll.read <= 1, `같은 구간을 통째로 다시 읽지 않는다(경계 ms 1건만 — read=${c2.lastPoll.read})`);
    assert.ok(c2.okAt <= Date.now(), 'okAt 은 주기 2 에도 지금 이하');
    assert.equal(db.query({ vcenterId: 'us' }, 100, 0).length, 0, '전제: 심각도 필터로 저장 0');
    assert.equal(clockWarns(w).length, 0, '여유 안은 경고하지 않는다');
  } finally { w.mock.restore(); l.mock.restore(); await closeSrv(srv); P._resetCursorsForTest(); }
});

test('F-B2 — 여유를 넘게 앞선 묶음은 여전히 읽은 커서를 지금으로 자른다(경고 1줄) · okAt 도 지금 이하', async () => {
  const { srv, state } = fakeVcenter();
  await listen(srv);
  const w = mock.method(console, 'warn', () => {}); const l = mock.method(console, 'log', () => {});
  try {
    await freshDb('fb2-over', 'warning');
    writeRegistry([vcEntry('pl', srv)]);
    const now = Date.now();
    state.events = [{ key: 1, ts: now - MIN }, { key: 2, ts: now + 11 * MIN }];
    await P.pollLogsOnce({ manual: true });
    const c = await diagOf('pl');
    const t = Date.now();
    assert.ok(c.cursorTs <= t, `여유(10분)를 넘으면 지금으로(+${c.cursorTs - t}ms)`);
    assert.ok(c.okAt <= t);
    assert.equal(clockWarns(w).length, 1);
    assert.match(clockWarns(w)[0], /읽은 시각을 포탈 지금으로 잘라/);
  } finally { w.mock.restore(); l.mock.restore(); await closeSrv(srv); P._resetCursorsForTest(); }
});

/* ── F-I1 ───────────────────────────────────────────────────────────────────────────────────────── */

test('F-I1 — db.lastTs(id, { maxTs }) (SQLite): 그 시각 이하의 MAX · 인자 없으면 예전 그대로 · (vcenterId, ts) 인덱스 끝점 탐색', async () => {
  const db = await freshDb('fi1-sql');
  assert.equal(db.kind, 'sqlite', '전제: --experimental-sqlite 로 돈다');
  const now = Date.now();
  db.insertMany([row('a', 1, now - H), row('a', 2, now - MIN), row('a', 3, now + 3 * H), row('b', 4, now + 3 * H)]);
  assert.equal(db.lastTs('a'), now + 3 * H, '인자 없음 — 예전 그대로(원본 MAX)');
  assert.equal(db.lastTs('a', { maxTs: now + 10 * MIN }), now - MIN);
  assert.equal(db.lastTs('a', { maxTs: now - MIN }), now - MIN, '경계 포함');
  assert.equal(db.lastTs('a', { maxTs: now - 2 * H }), 0, '그 이하에 행이 없으면 0(인자 없는 호출과 같은 모양)');
  assert.equal(db.lastTs('b', { maxTs: now }), 0, '미래 행뿐 — 0');
  assert.equal(db.lastTs('zz', { maxTs: now }), 0);
  for (const bad of [null, undefined, NaN, '', 'x', Infinity]) assert.equal(db.lastTs('a', { maxTs: bad }), now + 3 * H, `maxTs=${String(bad)} — 예전 그대로`);
  assert.equal(db.lastTs('a', 5), now + 3 * H, '객체가 아닌 둘째 인자(map 의 index 등)는 무시');
  // 쿼리 계획 — 같은 스키마에서 같은 SQL 이 인덱스 SEARCH(풀스캔 아님)
  const src = fs.readFileSync(DB_SRC, 'utf8');
  const m = /db\.prepare\('(SELECT MAX\(ts\) mx FROM events WHERE vcenterId=\? AND ts<=\?)'\)/.exec(src);
  assert.ok(m, '경계 있는 lastTs 는 MAX 단독 + vcenterId·ts 조건 한 문장');
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(db.path, { readOnly: true });
  try {
    const plan = raw.prepare(`EXPLAIN QUERY PLAN ${m[1]}`).all('a', now).map((r) => String(r.detail)).join(' | ');
    assert.match(plan, /SEARCH events USING (COVERING )?INDEX idx_events_ts \(vcenterId=\? AND ts<\?\)/, plan);
    assert.doesNotMatch(plan, /SCAN/, plan);
  } finally { raw.close(); }
});

test('F-I1 — db.lastTs(id, { maxTs }) (NDJSON 폴백 — node:sqlite 없는 프로세스): SQLite 판과 같은 값', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'fi1-json-'));
  const code = `
    const { saveLogSettings } = await import(${JSON.stringify(path.join(HERE, '../src/logs/settings.js'))});
    saveLogSettings({ enabled: true, minSeverity: 'info', pollIntervalMin: 10, storagePath: ${JSON.stringify(dir)} });
    console.warn = () => {};
    const D = await import(${JSON.stringify(DB_SRC)});
    const db = await D.getLogsDb();
    const now = ${Date.now()};
    const row = (vcenterId, key, ts) => ({ vcenterId, key: key + '@' + ts, ts, severity: 'info', type: 'T', user: 'u', entity: 'e', message: 'm' + key });
    db.insertMany([row('a', 1, now - ${H}), row('a', 2, now - ${MIN}), row('a', 3, now + ${3 * H}), row('b', 4, now + ${3 * H})]);
    const out = { kind: db.kind, all: db.lastTs('a'), bounded: db.lastTs('a', { maxTs: now + ${10 * MIN} }), edge: db.lastTs('a', { maxTs: now - ${MIN} }),
      none: db.lastTs('a', { maxTs: now - ${2 * H} }), futOnly: db.lastTs('b', { maxTs: now }), bad: db.lastTs('a', { maxTs: NaN }), num: db.lastTs('a', 5), now };
    process.stdout.write(JSON.stringify(out));
  `;
  const res = JSON.parse(execFileSync(process.execPath, ['--no-experimental-sqlite', '--input-type=module', '-e', code], { env: { ...process.env, CONFIG_DIR: dir }, encoding: 'utf8' }));
  const now = res.now;
  assert.equal(res.kind, 'json', '전제: NDJSON 폴백');
  assert.equal(res.all, now + 3 * H);
  assert.equal(res.bounded, now - MIN);
  assert.equal(res.edge, now - MIN);
  assert.equal(res.none, 0);
  assert.equal(res.futOnly, 0);
  assert.equal(res.bad, now + 3 * H);
  assert.equal(res.num, now + 3 * H);
});

test('F-I1 — DB 에 미래 행(3시간 앞)이 남아 있고 커서 파일이 없어도 시작점은 마지막 정상 저장 시각 — 그 뒤~지금 이벤트를 놓치지 않는다 · 시작점 경고 없음', async () => {
  const { srv, state } = fakeVcenter();
  await listen(srv);
  const w = mock.method(console, 'warn', () => {}); const l = mock.method(console, 'log', () => {});
  try {
    const db = await freshDb('fi1-gap');
    writeRegistry([vcEntry('pl', srv)]);
    const now = Date.now();
    const sane = Array.from({ length: 10 }, (_, i) => ({ key: i + 1, ts: now - 2 * H + i * MIN }));
    const future = { key: 99, ts: now + 3 * H };   // vCenter 시계가 앞섰던 순간의 이벤트(vCenter 는 아직 그 이벤트를 내준다)
    db.insertMany([...sane, future].map((e) => row('pl', e.key, e.ts)));
    const missed = Array.from({ length: 20 }, (_, i) => ({ key: 200 + i, ts: now - H + i * MIN }));   // 포탈이 내려가 있던 사이의 이벤트
    state.events = [...sane, future, ...missed];
    const r = await P.pollLogsOnce({ manual: true });
    assert.equal(state.begins[0].begin, now - 2 * H + 9 * MIN, `시작점 = 마지막 정상 저장(포함) — 예전은 지금(+${state.begins[0].begin - now}ms)`);
    assert.equal(r.collected, 20, '그 사이 이벤트 20건을 저장한다(예전 0 — 지금부터 읽어 영영 놓쳤다)');
    const warns = clockWarns(w);
    assert.equal(warns.filter((s) => /미래 시각을 버리고/.test(s)).length, 0, `저장된 미래 행만으로 시작점 경고를 내지 않는다: ${JSON.stringify(warns)}`);
    assert.equal(warns.length, 1, 'vCenter 가 지금 내준 묶음이 앞선 것은 그대로 경고한다(시간당 1줄)');
    assert.match(warns[0], /읽은 시각을 포탈 지금으로 잘라/);
    assert.equal(db.lastTs('pl'), now + 3 * H, '행 ts 는 원본 그대로(인자 없는 lastTs)');
  } finally { w.mock.restore(); l.mock.restore(); await closeSrv(srv); P._resetCursorsForTest(); }
});

test('F-I1 — vCenter 가 더는 미래 이벤트를 내주지 않으면(보관 만료 등) 저장된 미래 행만으로는 시계 경고가 나지 않는다', async () => {
  const { srv, state } = fakeVcenter();
  await listen(srv);
  const w = mock.method(console, 'warn', () => {}); const l = mock.method(console, 'log', () => {});
  try {
    const db = await freshDb('fi1-quiet');
    writeRegistry([vcEntry('pl', srv)]);
    const now = Date.now();
    db.insertMany([row('pl', 1, now - 30 * MIN), row('pl', 99, now + 3 * H)]);
    state.events = [{ key: 1, ts: now - 30 * MIN }, { key: 2, ts: now - 5 * MIN }];
    const r1 = await P.pollLogsOnce({ manual: true });
    assert.equal(state.begins[0].begin, now - 30 * MIN);
    assert.equal(r1.collected, 1);
    await P.pollLogsOnce({ manual: true });
    assert.equal(clockWarns(w).length, 0, `예전: 매 주기 시작점 후보(미래 MAX)를 버리며 시간당 경고: ${JSON.stringify(clockWarns(w))}`);
  } finally { w.mock.restore(); l.mock.restore(); await closeSrv(srv); P._resetCursorsForTest(); }
});

test('F-I1 — 지연 폴백(온전한 시각 없음)도 경계 있는 마지막 저장 시각을 쓴다: 미래 행 1건이 이틀 밀린 수집을 지연 0 으로 숨기지 않는다', async () => {
  const w = mock.method(console, 'warn', () => {}); const l = mock.method(console, 'log', () => {});
  const dead = http.createServer(); await listen(dead); const port = dead.address().port; await closeSrv(dead);   // 닫힌 포트 — 연결 거부
  try {
    const db = await freshDb('fi1-lag');
    writeRegistry([{ id: 'down', name: 'DOWN', host: `http://127.0.0.1:${port}`, username: 'u', password: 'p', timeoutMs: 2000 }]);
    const now = Date.now();
    db.insertMany([row('down', 1, now - 2 * DAY), row('down', 99, now + 3 * H)]);
    const r = await P.pollLogsOnce({ manual: true });
    assert.ok(Array.isArray(r.failed) && r.failed.some((f) => f.vcenterId === 'down'), '전제: 수집 실패(온전한 시각 없음)');
    const lag = (r.lagging || []).find((x) => x.vcenterId === 'down');
    assert.ok(lag, `이틀 밀린 vCenter 가 lagging 에 실린다(예전: 미래 MAX 로 지연 0): ${JSON.stringify(r.lagging)}`);
    assert.ok(lag.lagMs >= 2 * DAY - MIN && lag.lagMs < 2 * DAY + H, String(lag.lagMs));
  } finally { w.mock.restore(); l.mock.restore(); P._resetCursorsForTest(); }
});
