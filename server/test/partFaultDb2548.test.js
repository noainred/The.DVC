/**
 * partFaultDb2548.test.js — 파트 장애 DB 스키마 v2: 기본키 `(agent, part_key)` + 스키마 버전·재시작 마커
 * (v2.548 F2, `partfault/db.js`).
 *
 * 이 파일이 고정하는 두 규칙과 그 근거:
 *  ① **법인 축은 DB 기본키가 담당한다.** v1 의 PK 는 `part_key` 하나였고 iDRAC 의 deviceId 는 **IP
 *     문자열**(`idrac/registry.js:272`)이라, 두 법인이 같은 사설 IP 를 쓰면 서로 다른 물리 서버가 **같은
 *     행**이 됐다 — 한쪽의 열린 장애가 다른 쪽 관측으로 **거짓 '복구'** 처리되는 경로다(types.js 머리말
 *     F2). 파트 키에 agent 를 넣지 않는 이유는 계약(`types.js partKeyOf`)에 있다 — AGENT_NAME 기본값이
 *     호스트명이라 호스트명 변경만으로 전 장애가 닫혔다 열린다. 그래서 같은 part_key 라도 agent 가 다르면
 *     **두 행**이어야 하고 한쪽을 닫아도 다른 쪽이 남아야 한다.
 *  ② **v1 파일은 이어 붙이지 않고 재생성하되, 조용히 하지 않고 1회만 한다.** IP 키로 쌓인 행은 어느
 *     법인 것인지 알 수 없어 agent 를 채워 넣을 수 없다(지어내는 것이다). v2.534 `capacityBasisMigration`
 *     과 같은 판단('측정 기준이 바뀌면 이어 붙이지 않는다'). 대신 `meta.reset` 마커 + warn 한 줄로
 *     밝히고, version 2 파일은 **다시 지우지 않는다**(재기동마다 지우면 이력이 영원히 안 쌓인다). 새
 *     파일에는 마커가 **없어야** 한다 — '처음부터 새 파일' 을 '지우고 새로 시작' 이라 말하면 거짓 배지다.
 *
 * 기준 시각은 **정시 -30분**(CLAUDE.md v2.517 규약) — 항상 과거이고 경계에서 30분 떨어져 있다.
 * `recentEvents` 의 조회 창이 `Date.now() - sinceMs` 라 절대 상수(2023년 등)를 쓰면 조회되지 않는다.
 * 여러 DB 파일을 한 프로세스에서 쓰기 위해 `PARTFAULT_DB_PATH` + `_resetForTest()` 로 파일을 바꾼다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'partfault-db2548-'));
process.env.CONFIG_DIR = dir;
process.env.PARTFAULT_DB_PATH = path.join(dir, 'fresh', 'part-faults.db');

const db = await import('../src/partfault/db.js');
const { makePart } = await import('../src/partfault/types.js');

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { /* node:sqlite 없음 — DB 테스트는 skip */ }

/** 같은 IP(deviceId)·같은 부품 — agent 만 다른 두 법인의 파트. deviceKey 를 주지 않으면 IP 가 키가 된다(localId). */
const part = (agent, o = {}) => makePart({
  scope: 'idrac', deviceId: '10.0.0.5', deviceName: 'srv', kind: 'psu', partId: 'PSU.Slot.1',
  keyKind: 'slot', state: 'fault', rawState: 'Critical', agent, ...o,
});

async function switchDb(file) {
  db._resetForTest();
  process.env.PARTFAULT_DB_PATH = file;
}

/* ─────────────────────────── ③ 새 파일 — 마커 없음 ─────────────────────────── */

test('새 파일은 schema_version 2 이고 reset 마커가 없다', async (t) => {
  const st = await db.partFaultDbStatus();
  if (!st.available) return t.skip(`node:sqlite 없음 — ${st.error}`);
  assert.equal(st.schemaVersion, 2);
  assert.equal(st.reset, null);
  assert.equal(await db.resetInfo(), null);
  assert.equal(st.openParts, 0);
});

/* ─────────────── ① F2 재현 — 같은 part_key · 다른 agent 는 두 행이다 ─────────────── */

test('같은 part_key + 다른 agent 는 두 행으로 공존하고 한쪽 close 가 다른 쪽을 건드리지 않는다', async (t) => {
  const st = await db.partFaultDbStatus();
  if (!st.available) return t.skip(`node:sqlite 없음 — ${st.error}`);

  const seoul = part('seoul');
  const poland = part('poland');
  assert.equal(seoul.partKey, poland.partKey);           // 전제: 키는 같다(IP 가 겹친 두 법인)
  assert.equal(seoul.deviceKeyKind, 'localId');           // 그래서 화면이 밝혀야 하는 등급

  await db.applyTransition({
    opened: [{ ...seoul, firstSeenAt: NOW, lastSeenAt: NOW }, { ...poland, firstSeenAt: NOW, lastSeenAt: NOW }],
    updated: [], closed: [], held: [],
  }, { now: NOW });
  let open = await db.openFaults();
  assert.equal(open.length, 2);                           // v1 이면 1 — 두 번째 upsert 가 첫 행을 덮었다
  assert.deepEqual(open.map((p) => p.agent).sort(), ['poland', 'seoul']);
  assert.ok(open.every((p) => p.deviceKey === '10.0.0.5' && p.deviceKeyKind === 'localId'));

  // 서울 쪽만 해소 — 폴란드의 열린 장애는 그대로다
  await db.applyTransition({ opened: [], updated: [], closed: [{ ...seoul, closeReason: 'ok' }], held: [] }, { now: NOW + 1000 });
  open = await db.openFaults();
  assert.equal(open.length, 1);
  assert.equal(open[0].agent, 'poland');
  assert.equal(open[0].state, 'fault');

  // 이력도 법인별로 갈린다 — 같은 part_key 의 두 법인 이벤트가 섞이지 않는다
  const evSeoul = await db.recentEvents({ partKey: { agent: 'seoul', partKey: seoul.partKey } });
  const evPoland = await db.recentEvents({ partKey: poland.partKey, agent: 'poland' });
  assert.deepEqual(evSeoul.map((e) => e.event), ['close', 'open']);
  assert.deepEqual(evPoland.map((e) => e.event), ['open']);
  assert.ok(evSeoul.every((e) => e.agent === 'seoul' && e.deviceKey === '10.0.0.5'));
  // 문자열 partKey + agent 미지정 = 중앙 직접('') — 이 두 법인에는 닿지 않는다
  assert.equal((await db.recentEvents({ partKey: seoul.partKey })).length, 0);

  // 알림 시각도 (agent, partKey) 쌍으로만 찍힌다 — 실제 갱신 행 수를 돌려준다
  assert.equal(await db.markNotified([{ agent: 'poland', partKey: poland.partKey }], { now: NOW + 2000 }), 1);
  assert.equal(await db.markNotified([{ agent: 'seoul', partKey: seoul.partKey }], { now: NOW + 2000 }), 0); // 이미 닫힌 행
  assert.equal(await db.markNotified([poland.partKey], { now: NOW + 2000 }), 0);                            // 문자열 = agent ''
  assert.equal((await db.openFaults())[0].notifiedAt, NOW + 2000);
});

test('held(유지)도 자기 법인의 행만 건드린다', async (t) => {
  const st = await db.partFaultDbStatus();
  if (!st.available) return t.skip(`node:sqlite 없음 — ${st.error}`);
  const poland = part('poland');
  await db.applyTransition({ opened: [], updated: [], closed: [], held: [{ ...poland, holdReason: 'unknown', lastSeenAt: NOW + 3000 }] }, { now: NOW + 3000 });
  const open = await db.openFaults();
  assert.equal(open.length, 1);
  assert.equal(open[0].holdReason, 'unknown');
  assert.equal(open[0].lastSeenAt, NOW + 3000);
  // 이벤트는 늘지 않는다(held 는 이벤트가 아니다)
  assert.equal((await db.recentEvents({ partKey: { agent: 'poland', partKey: poland.partKey } })).length, 1);
});

/* ─────────────────── ⑤ 같은 상태 유지는 이벤트를 만들지 않는다 ─────────────────── */

test('같은 상태 유지(sameState)는 이벤트를 만들지 않는다 — 전이만 적재(v2.547 규약 유지)', async (t) => {
  const st = await db.partFaultDbStatus();
  if (!st.available) return t.skip(`node:sqlite 없음 — ${st.error}`);
  const p = part('', { partId: 'Fan.Embedded.1', kind: 'fan' });   // 중앙 직접(agent '')
  await db.applyTransition({ opened: [{ ...p, firstSeenAt: NOW, lastSeenAt: NOW }], updated: [], closed: [], held: [] }, { now: NOW });
  await db.applyTransition({ opened: [], updated: [{ ...p, firstSeenAt: NOW, lastSeenAt: NOW + 1000, prevState: 'fault', sameState: true }], closed: [], held: [] }, { now: NOW + 1000 });
  let ev = await db.recentEvents({ partKey: p.partKey });         // agent 기본 '' 로 찾는다
  assert.deepEqual(ev.map((e) => e.event), ['open']);
  // 상태가 바뀌면 change 1건 — first_seen 은 보존된다
  await db.applyTransition({ opened: [], updated: [{ ...p, state: 'warn', firstSeenAt: NOW, lastSeenAt: NOW + 2000, prevState: 'fault', sameState: false }], closed: [], held: [] }, { now: NOW + 2000 });
  ev = await db.recentEvents({ partKey: p.partKey });
  assert.deepEqual(ev.map((e) => e.event), ['change', 'open']);
  assert.equal(ev[0].prevState, 'fault');
  const row = (await db.openFaults()).find((r) => r.partKey === p.partKey && r.agent === '');
  assert.equal(row.state, 'warn');
  assert.equal(row.firstSeenAt, NOW);
});

/* ─────────────────────────────── ④ 파일 권한 ─────────────────────────────── */

test('DB 파일 권한은 0600(v2.503 규약)', async (t) => {
  const st = await db.partFaultDbStatus();
  if (!st.available) return t.skip(`node:sqlite 없음 — ${st.error}`);
  assert.equal(fs.statSync(st.path).mode & 0o777, 0o600);
});

/* ─────────────── ② v1 파일 → 재생성 + reset 마커 + 1회만 ─────────────── */

/** v2.547 이 만들던 스키마 그대로(PK part_key 단일, meta 없음). 손으로 만든 v1 파일. */
function makeV1File(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new sqlite.DatabaseSync(file);
  d.exec(`
    CREATE TABLE part_state (
      part_key TEXT PRIMARY KEY, scope TEXT NOT NULL, device_id TEXT NOT NULL, device_name TEXT,
      kind TEXT, part_id TEXT, key_kind TEXT, label TEXT, detail TEXT, agent TEXT,
      state TEXT NOT NULL, raw_state TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      hold_reason TEXT, notified_at INTEGER);
    CREATE INDEX ix_state_dev ON part_state(device_id);
    CREATE TABLE part_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, part_key TEXT NOT NULL, scope TEXT NOT NULL,
      device_id TEXT NOT NULL, device_name TEXT, kind TEXT, label TEXT, key_kind TEXT, event TEXT NOT NULL,
      state TEXT, prev_state TEXT, raw_state TEXT, close_reason TEXT, agent TEXT);
    CREATE INDEX ix_event_key ON part_event(part_key, at);
    INSERT INTO part_state (part_key,scope,device_id,state,first_seen,last_seen) VALUES ('idrac:10.0.0.5:psu:PSU1','idrac','10.0.0.5','fault',1,1);
    INSERT INTO part_event (at,part_key,scope,device_id,event,state) VALUES (1,'idrac:10.0.0.5:psu:PSU1','idrac','10.0.0.5','open','fault');
    INSERT INTO part_event (at,part_key,scope,device_id,event,state) VALUES (2,'idrac:10.0.0.5:psu:PSU1','idrac','10.0.0.5','change','warn');
  `);
  d.close();
}

test('v1 파일(PK part_key 단일)은 열 때 재생성되고 resetInfo() 가 from:1,to:2 를 준다 — warn 한 줄', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const file = path.join(dir, 'v1', 'part-faults.db');
  makeV1File(file);
  await switchDb(file);

  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  let st;
  try { st = await db.partFaultDbStatus(); } finally { console.warn = orig; }
  assert.equal(st.available, true, st.error);
  assert.equal(st.schemaVersion, 2);
  // 무엇을 왜 지웠는지 — 마커와 로그 둘 다
  const info = await db.resetInfo();
  assert.equal(info.from, 1);
  assert.equal(info.to, 2);
  assert.ok(Number.isFinite(info.at) && info.at > 0);
  assert.match(info.reason, /agent, part_key/);
  assert.deepEqual(info.rows, { states: 1, events: 2 });       // 잃은 행 수를 센다(조용한 삭제 금지)
  assert.deepEqual(st.reset, info);                             // 상태 응답에도 같은 마커
  assert.equal(warns.length, 1);
  assert.match(warns[0], /\[partfault\].*v1 → v2.*1행.*2행/);
  // 옛 행은 이어 붙이지 않았다
  assert.deepEqual(await db.openFaults(), []);
  assert.equal(st.rows, 0);

  // 실제 PK 가 (agent, part_key) 인지 — 테이블 정의로 확인한다(두 행 공존 테스트는 위에서 했다)
  const d = new sqlite.DatabaseSync(file, { readOnly: true });
  const pk = d.prepare('PRAGMA table_info(part_state)').all().filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  assert.deepEqual(pk, ['agent', 'part_key']);
  const cols = new Set(d.prepare('PRAGMA table_info(part_event)').all().map((c) => c.name));
  assert.ok(cols.has('device_key') && cols.has('device_key_kind') && cols.has('agent'));
  const idx = d.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='ix_event_key'").get()?.sql || '';
  assert.match(idx, /\(agent, part_key, at\)/);
  d.close();
});

test('version 2 파일은 다시 열어도 지우지 않는다(1회만) — 행과 마커가 그대로 남는다', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const file = path.join(dir, 'v1', 'part-faults.db');   // 위 테스트가 v2 로 재생성한 그 파일
  const p = part('busan');
  await db.applyTransition({ opened: [{ ...p, firstSeenAt: NOW, lastSeenAt: NOW }], updated: [], closed: [], held: [] }, { now: NOW });
  const before = await db.resetInfo();

  await switchDb(file);   // 재기동을 흉내 낸다
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  let open;
  try { open = await db.openFaults(); } finally { console.warn = orig; }
  assert.equal(warns.length, 0);                         // 두 번째 열기에는 경고가 없다
  assert.equal(open.length, 1);
  assert.equal(open[0].agent, 'busan');
  assert.deepEqual(await db.resetInfo(), before);        // 마커는 처음 것 그대로(덮어쓰지 않는다)
});

test('이 코드보다 높은 스키마 버전의 파일은 열지 않는다 — available:false 이고 파일은 건드리지 않는다', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const file = path.join(dir, 'v9', 'part-faults.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new sqlite.DatabaseSync(file);
  d.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT); INSERT INTO meta VALUES ('schema_version','9');
          CREATE TABLE part_state (agent TEXT, part_key TEXT, future_col TEXT, PRIMARY KEY (agent, part_key));
          INSERT INTO part_state VALUES ('x','k','v');`);
  d.close();
  await switchDb(file);
  const st = await db.partFaultDbStatus();
  assert.equal(st.available, false);
  assert.match(st.error, /스키마 버전 9/);
  assert.equal(st.schemaVersion, null);
  assert.equal((await db.applyTransition({ opened: [part('x')] })).saved, false);
  // 새 버전이 쌓은 행이 살아 있다
  const d2 = new sqlite.DatabaseSync(file, { readOnly: true });
  assert.equal(d2.prepare('SELECT COUNT(*) AS n FROM part_state').get().n, 1);
  assert.equal(d2.prepare("SELECT v FROM meta WHERE k='schema_version'").get().v, '9');
  d2.close();
});
