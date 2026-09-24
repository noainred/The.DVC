/**
 * test/sanHealth2522.test.js — SAN 점검 v2.522 회귀 고정.
 *
 * 사용자 요청·신고:
 *  · "실행되지 않는 명령어가 있는데, 결과가 비슷한 실행 가능한 명령어를 찾아서 대체해줘"
 *  · "errshow 명령어 점검에 추가"(그 스위치에 errdump 는 없고 errshow 만 있으며 페이저로 멈춘다)
 *  · "isl 점검 기능 추가"(islshow · trunkshow · lsan --show)
 *  · "점검 결과를 DB 로 저장해서 최근 10번 점검과 비교 하는 기능 만들어줘"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDevice, checkPorts, attachUsed, ITEM_SOURCE, CHECK_ITEMS } from '../src/sanswitch/healthCheck.js';
import { parseTempShow, parseIslShow, parseTrunkShow, parseLsanShow, parseErrDump } from '../src/sanswitch/collectors/fosParse.js';
import { buildSnapshot } from '../src/sanswitch/collectors/fosSsh.js';
import { slimItems, compareRuns } from '../src/sanswitch/healthHistory.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const OK = { ports: 'ok', sfp: 'ok', counters: 'ok', chassis: 'ok', health: 'ok', sensors: 'ok', bottleneck: 'ok', raslog: 'ok', fabric: 'ok', isl: 'ok', trunk: 'ok', lsan: 'ok', zoning: 'ok' };
const snapOf = (o = {}) => ({
  ok: true, deviceId: 'd1', name: 'SW1', collectedAt: 1000, switchState: 'Online',
  sections: { ...OK, ...(o.sections || {}) },
  ports: { list: [], portsOmitted: 0, ...(o.ports || {}) },
  health: { status: 'HEALTHY', psus: { total: 2, ok: 2 }, fans: { total: 2, ok: 2 }, ...(o.health || {}) },
  extra: { ...(o.extra || {}) },
});
const itemOf = (r, key) => r.items.find((i) => i.key === key);

/* ── ② 명령 후보 체인 ─────────────────────────────────────────────────────── */

test('후보 체인: 후보마다 자기 bin 을 갖는다(첫 후보가 없어도 뒤 후보를 시도한다)', () => {
  const src = read('sanswitch/collectors/fosSsh.js');
  // v2.521 까지는 항목당 `bin` 하나라 errdump 가 없으면 errshow 가 **한 번도** 시도되지 않았다.
  assert.match(src, /const avail = spec\.cmds\.filter\(\(k\) => !\(caps\.has && k\.bin && !caps\.has\.has\(k\.bin\)\)\)/,
    '후보별 bin 필터가 사라지면 대체 명령이 다시 죽는다');
  assert.match(src, /K\('errdump', 'errdump'\), K\('errshow', 'errshow', \{ paged: true \}\)/,
    'errshow 는 errdump 의 대체 후보이고 페이저 경로여야 한다');
  assert.match(src, /K\('sensorshow', 'sensorshow'\), K\('tempshow', 'tempshow'\)/);
  assert.match(src, /usedCmds\[spec\.key\]/, '무엇으로 확인했는지 남기지 않으면 화면이 대체 사실을 말할 수 없다');
});

test('페이저 자동 응답 경로가 있고 상한·시한을 갖는다', () => {
  const src = read('proxy/sshExec.js');
  assert.match(src, /function execPaged\(/);
  assert.match(src, /maxPages/, '응답 횟수 상한이 없으면 세션을 무한히 붙잡는다');
  assert.match(src, /truncated: true/, '상한으로 끊었으면 그 사실을 밝혀야 한다');
  assert.match(src, /execPaged: async \(cmd, opts\)/, '세션 핸들에 노출되지 않으면 수집기가 쓸 수 없다');
  // 시한이 되면 모아 둔 출력을 **살려** 돌려준다(일반 exec 과 다른 점 — 버리면 존재 이유가 없다).
  assert.match(src, /timedOut: true/);
});

test('소스에 리터럴 제어문자가 없다(grep 사각지대 방지 — server/CLAUDE.md C/L4)', () => {
  for (const f of ['proxy/sshExec.js', 'sanswitch/collectors/fosParse.js', 'sanswitch/healthHistory.js']) {
    const buf = fs.readFileSync(path.join(SRC, f));
    const bad = [...buf].filter((b) => b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d).length;
    assert.equal(bad, 0, `${f} 에 제어문자 ${bad}개`);
  }
});

test('대체 명령을 썼으면 항목에 표시된다', () => {
  const items = [{ key: 'sensors', cmd: 'sensorshow', status: 'ok', detail: '' }, { key: 'raslog', cmd: 'errdump', status: 'ok', detail: '' }];
  const out = attachUsed(items, { sensorshow: { cmd: 'tempshow', alt: true }, errdump: { cmd: 'errshow', alt: true, paged: true, truncated: true } });
  assert.equal(out[0].usedCmd, 'tempshow');
  assert.equal(out[0].usedAlt, true);
  assert.equal(out[1].usedPaged, true);
  assert.equal(out[1].usedTruncated, true);
  // 대체가 없으면 건드리지 않는다.
  assert.equal(attachUsed(items, {})[0].usedCmd, undefined);
});

test('ITEM_SOURCE 는 모든 점검 항목을 덮는다(빠지면 그 항목은 대체 사실을 못 말한다)', () => {
  const missing = CHECK_ITEMS.map((i) => i.key).filter((k) => !ITEM_SOURCE[k]);
  assert.deepEqual(missing, []);
});

test('tempshow 로 대체했으면 전압 미확인을 밝힌다(정상이라 말하지 않는다)', () => {
  const snap = snapOf({
    extra: {
      usedCmds: { sensorshow: { cmd: 'tempshow', alt: true } },
      sensors: parseTempShow('Sensor ID  Temp(C)  Temp(F)  Status\n   1    31    87   Ok'),
    },
  });
  const it = itemOf(checkDevice(snap), 'sensors');
  assert.equal(it.status, 'warn', "'온도·전압 센서 정상' 이라 말하면 전압을 안 본 채로 거짓을 말하는 것이다");
  assert.match(it.detail, /전압은 확인하지 못했습니다/);
});

test('errshow 출력도 errdump 파서가 읽는다(같은 형식)', () => {
  const txt = '2025/02/03-03:02:57, [RAS-2009], 3854, CHASSIS, INFO, G620, Audit log message storage has reached 75 percentage of limit.';
  const r = parseErrDump(txt);
  assert.equal(r.parsed, true);
  assert.equal(r.list[0].id, 'RAS-2009');
  assert.equal(r.list[0].severity, 'info');
  assert.equal(r.list[0].at, '2025/02/03-03:02:57');
});

/* ── ⑧ ISL 점검 ───────────────────────────────────────────────────────────── */

test('ISL: 링크를 읽고 속도를 확인한다', () => {
  const isl = parseIslShow(' 1: 12-> 12 10:00:00:05:1e:aa:bb:cc  2 fab1 sp: 16.000G bw: 16.000G TRUNK QOS\n 2: 13-> 13 10:00:00:05:1e:aa:bb:cc  2 fab1 sp: 16.000G bw: 16.000G TRUNK');
  assert.equal(isl.count, 2);
  const it = itemOf(checkDevice(snapOf({ extra: { isl } })), 'isl');
  assert.equal(it.status, 'ok');
  assert.match(it.detail, /ISL 2개/);
});

test('ISL 0개는 단독 스위치면 정상 — 패브릭 구성원이 2대 이상일 때만 주의', () => {
  const none = { parsed: true, list: [], count: 0, note: '' };
  const solo = itemOf(checkDevice(snapOf({ extra: { isl: none } })), 'isl');
  assert.equal(solo.status, 'ok', 'ISL 이 없는 단독 스위치를 이상이라 하면 오탐이다');
  const multi = itemOf(checkDevice(snapOf({ extra: { isl: none, fabricMembers: { parsed: true, count: 3, switches: [], principal: 1 } } })), 'isl');
  assert.equal(multi.status, 'warn');
  assert.match(multi.detail, /패브릭 구성원은 3대/);
});

test('ISL: DEGRADED 는 이상, 속도 미확인은 주의', () => {
  const deg = parseIslShow(' 1: 12-> 12 10:00:00:05:1e:aa:bb:cc  2 fab1 sp: 16.000G bw: 16.000G DEGRADED');
  assert.equal(itemOf(checkDevice(snapOf({ extra: { isl: deg } })), 'isl').status, 'bad');
  const noSp = parseIslShow(' 1: 12-> 12 10:00:00:05:1e:aa:bb:cc  2 fab1');
  assert.equal(itemOf(checkDevice(snapOf({ extra: { isl: noSp } })), 'isl').status, 'warn');
});

test('트렁크: 멤버 1개 그룹은 주의로 밝히되 단정하지 않는다', () => {
  const t = parseTrunkShow(' 1:  0->  0 10:00:00:05:1e:aa:bb:cc   2  deskew 15 MASTER');
  const it = itemOf(checkDevice(snapOf({ extra: { trunk: t } })), 'trunk');
  assert.equal(it.status, 'warn');
  assert.match(it.detail, /정상 구성일 수도 있습니다/);
});

test('트렁크·LSAN 이 없는 것은 정상이다(없다고 경고하지 않는다)', () => {
  const t = itemOf(checkDevice(snapOf({ extra: { trunk: { parsed: true, groups: [], count: 0, members: 0, note: '' } } })), 'trunk');
  assert.equal(t.status, 'ok');
  const l = itemOf(checkDevice(snapOf({ extra: { lsan: { parsed: true, zones: [], count: 0, note: '' } } })), 'lsan');
  assert.equal(l.status, 'ok');
  assert.match(l.detail, /정상입니다/);
});

test('ISL 형식 미인식은 정상이 아니라 확인 불가다', () => {
  const bad = parseIslShow('rbash: islshow: command not found');
  assert.equal(bad.parsed, false);
  assert.equal(itemOf(checkDevice(snapOf({ extra: { isl: bad } })), 'isl').status, 'unknown');
  // 수집 자체가 안 됐으면(섹션 사유) 그 사유를 그대로 말한다.
  const it = itemOf(checkDevice(snapOf({ sections: { isl: 'rbash: islshow: command not found' } })), 'isl');
  assert.equal(it.status, 'unknown');
});

test('스냅샷 조립: ISL/trunk/LSAN 과 sections·usedCmds 가 실린다', () => {
  const snap = buildSnapshot({ id: 'd', name: 'S', host: 'h' }, {
    switchshow: 'switchName: S\nswitchState: Online\n',
    islshow: ' 1: 12-> 12 10:00:00:05:1e:aa:bb:cc  2 fab1 sp: 16.000G bw: 16.000G',
    trunkshow: ' 1:  0->  0 10:00:00:05:1e:aa:bb:cc   2  deskew 15 MASTER',
  }, { lsanshow: "이 스위치에 'lsan' 명령이 없습니다" }, { islshow: { cmd: 'islshow', alt: false } });
  assert.equal(snap.extra.isl.count, 1);
  assert.equal(snap.extra.trunk.count, 1);
  assert.equal(snap.extra.lsan, null);
  assert.equal(snap.sections.isl, 'ok');
  assert.match(snap.sections.lsan, /명령이 없습니다/);
  assert.equal(snap.extra.usedCmds.islshow.cmd, 'islshow');
  // v2.522 에 추가한 sections 4개 — 없으면 화면이 실패 사유를 못 보여준다.
  for (const k of ['sensors', 'raslog', 'bottleneck', 'fabric']) assert.ok(k in snap.sections, `sections.${k} 누락`);
});

/* ── ⑥ 점검 이력 · 최근 N회 비교 ───────────────────────────────────────────── */

const run = (at, items, ports = null) => ({
  at, collectedAt: at, overall: 'ok',
  counts: { ok: items.filter((i) => i.status === 'ok').length, warn: items.filter((i) => i.status === 'warn').length, bad: items.filter((i) => i.status === 'bad').length, unknown: items.filter((i) => i.status === 'unknown').length },
  items, ports: ports || {},
});

test('이력 저장 형태에 근거(evidence)를 넣지 않는다(원문 수천 줄)', () => {
  const out = slimItems([{ key: 'raslog', label: '로그', stage: 4, status: 'ok', detail: 'x'.repeat(500), evidence: ['a', 'b'], usedCmd: 'errshow', usedAlt: true }]);
  assert.equal('evidence' in out[0], false);
  assert.equal(out[0].detail.length, 200);
  assert.equal(out[0].usedCmd, 'errshow');
});

test('비교: 이력이 없거나 1건이면 그 사실을 말한다(억지로 비교하지 않는다)', () => {
  assert.match(compareRuns([]).note, /이력이 없습니다/);
  const one = compareRuns([run(3, [{ key: 'a', label: 'A', status: 'ok' }])]);
  assert.equal(one.compared, 1);
  assert.match(one.note, /비교할 이전 점검이 없습니다/);
});

test('비교: 새로 생긴 문제와 해소된 문제를 각각 센다', () => {
  const runs = [
    run(3, [{ key: 'optical', label: '광량', status: 'bad' }, { key: 'ports', label: '포트', status: 'ok' }]),
    run(2, [{ key: 'optical', label: '광량', status: 'ok' }, { key: 'ports', label: '포트', status: 'warn' }]),
  ];
  const c = compareRuns(runs);
  assert.deepEqual(c.newProblems, ['광량']);
  assert.deepEqual(c.resolved, ['포트']);
  assert.equal(c.changes.find((x) => x.key === 'optical').dir, 'worse');
  assert.equal(c.changes.find((x) => x.key === 'ports').dir, 'better');
});

test("비교: '확인 불가 → 정상' 은 호전이 아니라 '이제 확인됨' 이다", () => {
  const c = compareRuns([
    run(3, [{ key: 'raslog', label: '로그', status: 'ok' }]),
    run(2, [{ key: 'raslog', label: '로그', status: 'unknown' }]),
  ]);
  assert.equal(c.changes[0].dir, 'nowKnown');
  assert.deepEqual(c.resolved, [], "unknown→ok 를 '해소' 로 세면 없던 개선을 보고하는 것이다");
});

test("비교: '정상 → 확인 불가' 도 구분한다(조용히 넘기면 항목이 사라진 것처럼 보인다)", () => {
  const c = compareRuns([
    run(3, [{ key: 'raslog', label: '로그', status: 'unknown' }]),
    run(2, [{ key: 'raslog', label: '로그', status: 'ok' }]),
  ]);
  assert.equal(c.changes[0].dir, 'nowUnknown');
  assert.deepEqual(c.newProblems, []);
});

test('비교: N회 내내 문제인 항목을 따로 센다(매달 같은 경고)', () => {
  const runs = [3, 2, 1].map((n) => run(n, [{ key: 'optical', label: '광량', status: 'bad' }, { key: 'ports', label: '포트', status: 'ok' }]));
  const c = compareRuns(runs);
  assert.equal(c.persistent.length, 1);
  assert.equal(c.persistent[0].label, '광량');
  assert.equal(c.changes.length, 0, '판정이 같으면 변화 목록은 비어야 한다');
});

test('비교: 추이는 오래된 것부터(차트·표 순서)', () => {
  const c = compareRuns([run(3, [{ key: 'a', label: 'A', status: 'ok' }]), run(1, [{ key: 'a', label: 'A', status: 'ok' }])]);
  assert.deepEqual(c.trend.map((t) => t.at), [1, 3]);
});

test('이력 DB 는 ts 인덱스·0600·중복 방지를 갖는다', () => {
  const src = read('sanswitch/healthHistory.js');
  assert.match(src, /CREATE INDEX IF NOT EXISTS idx_runs_at ON runs \(at\)/);
  assert.match(src, /chmodSync\(p, 0o600\)/);
  assert.match(src, /Number\(last\.collected_at\) === collectedAt/, '수집 1회 = 기록 1회 규약');
  // v2.606(DB2606-03): PRAGMA 는 util/sqliteOpen.js openSqlite 가 건다(busy_timeout 먼저 → WAL + NORMAL). 잠금이면 래치하지 않는다.
  assert.match(src, /openSqlite\(new DatabaseSync\(p\)\)/);
  assert.match(src, /createLockRetry\(/);
  assert.match(src, /st\.trim\.run/, '장비당 보관 상한이 없으면 무한히 자란다');
});

test('DB 왕복: 기록 → 중복 거부 → 조회 → 비교', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'sanhealth-'));
  process.env.SANHEALTH_DB_PATH = path.join(dir, 'san-health.db');
  const m = await import(`../src/sanswitch/healthHistory.js?t=${Date.now()}`);
  const st = await m.healthHistoryStatus();
  if (!st.available) { assert.ok(true, `node:sqlite 없음 — 건너뜀(${st.error})`); return; }
  const mk = (collectedAt, status) => ({
    deviceId: 'd1', collectedAt, overall: status,
    counts: { ok: 1, warn: 0, bad: status === 'bad' ? 1 : 0, unknown: 0 },
    items: [{ key: 'optical', label: '광량', stage: 2, status, detail: 'x' }],
  });
  assert.equal((await m.recordRun(mk(1000, 'ok'))).saved, true);
  const dup = await m.recordRun(mk(1000, 'ok'));
  assert.equal(dup.saved, false, '같은 스냅샷을 두 번 기록하면 최근 10회가 같은 값으로 채워진다');
  assert.match(dup.reason, /수집 1회 = 기록 1회/);
  assert.equal((await m.recordRun(mk(2000, 'bad'))).saved, true);
  const l = await m.listRuns('d1', 10);
  assert.equal(l.runs.length, 2);
  assert.equal(l.runs[0].collectedAt, 2000, '최신 먼저');
  const c = m.compareRuns(l.runs);
  assert.deepEqual(c.newProblems, ['광량']);
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.SANHEALTH_DB_PATH;
});
