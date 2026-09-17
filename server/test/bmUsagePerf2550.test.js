/**
 * 베어메탈 사용률 — v2.550.3 버그 수정·성능 최적화 회귀.
 *
 * ★ 이 파일이 고정하는 것은 **실측으로 확정한 것**뿐이다(추정 최적화 금지 — CLAUDE.md v2.503:
 *   'N+1 을 1쿼리로 합치면 빠르다고 단정하지 말 것'. 실제로 그 합치기가 2.3배 느렸다).
 *
 * 실측 환경: 목표 규모 **200대 · 5분 주기 · 90일 = 518만 행 · 633MB** 를 직접 만들어 측정했다.
 *  ┌ 화면 로드 1회의 DB 비용 ─────────────────────────────────────────────────┐
 *  │ latestUsage()  GROUP BY agent,key + JOIN   702.5ms → usage_latest  0.53ms │
 *  │ dbStatus()     MIN(ts),MAX(ts) 한 쿼리     384~400ms → 분리        0.01ms │
 *  │ dbStatus()     COUNT(*) ×2                  28.7ms → 60초 캐시     0.12ms │
 *  │ 합계                                        1,115ms → 0.65ms (1,726배)   │
 *  └───────────────────────────────────────────────────────────────────────────┘
 *  · insertUsage(200행): 14.5ms → 7.4ms(행당 2쿼리 → ON CONFLICT DO UPDATE)
 *  · 구버전 DB 마이그레이션(usage_latest 시드): 783ms — **기동 1회**
 *  · 효과 없어서 **채택하지 않은 대안**: `WHERE ts>=?` 로 최근 구간만 좁히기(303ms — 옵티마이저가
 *    GROUP BY 때문에 여전히 PK 커버링 인덱스를 스캔한다). 그 방향으로 되돌리지 말 것.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = (rel) => fs.readFileSync(path.join(import.meta.dirname, '../src', rel), 'utf8');
/** 주석을 지운 소스 — 규칙을 설명하는 주석이 검사 통과 근거가 되면 안 된다(v2.535 규약). */
const bare = (rel) => SRC(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── P1: MIN/MAX 한 쿼리 = 400ms (SQLite 는 aggregate 하나일 때만 인덱스 최적화) ──
test('⚠ MIN(ts) 과 MAX(ts) 를 한 쿼리에 쓰지 않는다 (실측 400ms → 0.01ms)', () => {
  const s = bare('bmusage/db.js');
  assert.ok(!/MIN\(ts\)[^;']*MAX\(ts\)/.test(s), '한 쿼리에 두 aggregate 가 있다 — 인덱스 최적화가 죽는다');
  assert.match(s, /SELECT MIN\(ts\) v FROM usage_history/, 'MIN 단독 쿼리');
  assert.match(s, /SELECT MAX\(ts\) v FROM usage_history/, 'MAX 단독 쿼리');
});

// ── P2: latestUsage 풀스캔 = 702ms ────────────────────────────────────────────
test('⚠ latestUsage 는 GROUP BY 풀스캔이 아니라 usage_latest 를 읽는다 (702ms → 0.53ms)', () => {
  const s = bare('bmusage/db.js');
  const fn = s.slice(s.indexOf('export async function latestUsage'), s.indexOf('export async function usageHistory'));
  assert.match(fn, /SELECT \* FROM usage_latest/, '전용 테이블을 읽어야 한다');
  assert.ok(!/GROUP BY/.test(fn), 'GROUP BY 로 되돌리면 화면 로드마다 702ms 다');
  assert.match(s, /CREATE TABLE IF NOT EXISTS usage_latest/, '스키마');
  assert.match(s, /INSERT OR REPLACE INTO usage_latest[\s\S]{0,600}GROUP BY agent,key/, '구버전 DB 1회 시드');
});

// ── P3 + B5 ───────────────────────────────────────────────────────────────────
test('일 롤업은 ON CONFLICT DO UPDATE 로 누적한다 (행당 2쿼리 14.5ms → 7.4ms)', () => {
  const s = bare('bmusage/db.js');
  assert.match(s, /ON CONFLICT\(agent,key,day\) DO UPDATE SET/);
  assert.ok(!/SELECT \* FROM usage_daily WHERE agent=\? AND key=\? AND day=\?/.test(s), '행당 SELECT 를 되살리지 말 것');
  // ⚠ MAX() 는 인자 하나가 NULL 이면 NULL 이라 하한으로 감싸고 되돌려야 한다.
  assert.match(s, /NULLIF\(MAX\(IFNULL\(cpu_max,-1e308\)/);
});
test('같은 ts 재삽입은 INSERT OR IGNORE + changes 검사로 이중 계수를 막는다', () => {
  const s = bare('bmusage/db.js');
  assert.match(s, /INSERT OR IGNORE INTO usage_history/);
  assert.ok(!/INSERT OR REPLACE INTO usage_history/.test(s), 'REPLACE 면 롤업이 두 번 누적된다');
  assert.match(s, /if \(!Number\(res\?\.changes\)\)/, 'changes 0 이면 롤업을 건드리지 않는다');
});
test('최신값은 ts 가 더 클 때만 갱신한다 — 엣지 push 는 순서대로 오지 않는다', () => {
  assert.match(bare('bmusage/db.js'), /WHERE excluded\.ts > usage_latest\.ts/);
});

// ── B1: 표본 시각 ─────────────────────────────────────────────────────────────
test('⚠⚠ 표본 시각은 주기 시작 시각이 아니라 그 서버가 실제로 읽힌 시각이다', () => {
  /*
   * 주기 시작 시각 하나를 전 서버에 쓰면 span(분모)이 실제 경과와 달라진다. 재현 계산:
   *   offset 10초→200초 : 실제 490초인데 300초로 나눠 **63% 과다**
   *   offset 200초→10초 : 실제 110초인데 300초로 나눠 **63% 과소**
   *   offset 5초→250초  : 실제 545초인데 300초로 나눠 **82% 과다**
   * offset 은 한 대가 60초 시한에 걸리면 뒤 서버들이 통째로 밀려 주기마다 흔들린다.
   */
  const s = bare('bmusage/poller.js');
  assert.match(s, /const sampledAt = Date\.now\(\);/, '서버마다 표본 시각을 찍어야 한다');
  assert.match(s, /buildUsage\(\{[^}]*now: sampledAt[^}]*\}\)/, 'buildUsage 에 그 시각을 넘긴다');
  assert.ok(!/collectOne\(tg, now,/.test(s), '주기 시각을 전 서버에 넘기던 코드가 남아 있다');
  // 산수 자체도 고정한다(문서가 아니라 테스트가 근거를 갖는다).
  const err = (o1, o2, interval = 300) => ((interval + (o2 - o1) - interval) / interval) * 100;
  assert.equal(Math.round(err(10, 200)), 63);
  assert.equal(Math.round(err(200, 10)), -63);
  assert.equal(Math.round(err(5, 250)), 82);
});

// ── B2: scope 누출 ────────────────────────────────────────────────────────────
test('⚠ status.last 에 counts 를 싣지 않는다 — byReason 이 무스코프로 샜다', () => {
  const s = bare('bmusage/poller.js');
  assert.match(s, /last: _last \? \(\(\{ counts: _c, \.\.\.rest \}\) => rest\)\(_last\) : null/);
});

// ── B3 ───────────────────────────────────────────────────────────────────────
test('usageDaily 전체 조회도 agent 로 거른다', () => {
  const s = bare('bmusage/db.js');
  assert.ok(!/SELECT \* FROM usage_daily WHERE day>=\? ORDER BY day'/.test(s), 'agent 없는 전체 조회가 남아 있다');
  assert.match(s, /SELECT \* FROM usage_daily WHERE agent=\? AND day>=\?/);
});

// ── B4 ───────────────────────────────────────────────────────────────────────
test('대상에서 사라진 서버의 인메모리 항목을 버린다 (누수 + 옛 카운터 비교 방지)', () => {
  const s = bare('bmusage/poller.js');
  assert.match(s, /const live = new Set\(targets\.map/);
  assert.match(s, /for \(const k of _prev\.keys\(\)\) if \(!live\.has\(k\)\) _prev\.delete\(k\)/);
  assert.match(s, /_authStopped\.delete\(k\)/);
});

// ── B6 ───────────────────────────────────────────────────────────────────────
test('키 충돌을 감지해 개수·목록으로 밝힌다 (대상에서 빼지는 않는다)', async () => {
  const { resolveTargets } = await import('../src/bmusage/targets.js');
  const bm = [
    { serverId: 's1', fleetId: 'DUP1', name: 'bm-a', serviceTag: '', vcenterId: 'vc1' },
    { serverId: 's2', fleetId: 'x2', name: 'bm-b', serviceTag: 'DUP1', vcenterId: 'vc1' },
  ];
  const reg = [
    { id: 's1', host: 'https://10.0.0.1', username: 'u', password: 'p' },
    { id: 's2', host: 'https://10.0.0.2', username: 'u', password: 'p', serviceTag: 'DUP1' },
  ];
  const r = resolveTargets({ bareMetal: bm, registry: reg, bmServers: [],
    settings: { corps: { vc1: true }, osSsh: true, idracTelemetry: true }, isEdge: false, agentName: 'C' });
  assert.equal(r.targets.length, 2, '충돌해도 대상에서 빼지 않는다(어느 쪽을 버릴지 알 수 없다)');
  assert.equal(r.counts.keyConflicts, 1);
  assert.equal(r.keyConflicts[0].key, 'DUP1');
  assert.deepEqual(r.keyConflicts[0].names.sort(), ['bm-a', 'bm-b']);
  assert.equal(r.keyConflicts[0].vcenterId, 'vc1', 'scope 로 거를 수 있어야 한다(없으면 범위 계정에 전부 숨는다)');
});

// ── B7 ───────────────────────────────────────────────────────────────────────
test('화면 상세용 내부 배열(_perIf·_perFc)은 DB 적재 경로로 넘기지 않는다', () => {
  assert.match(bare('bmusage/poller.js'), /const \{ _perIf: _a, _perFc: _b, \.\.\.row \} = r\.built\.row/);
});

// ── 시한 예산(v2.528 유형) ────────────────────────────────────────────────────
test('⚠⚠ 세션 예산 < 장비 시한 — 두 번 시도해도 결과가 버려지지 않는다', async () => {
  /*
   * 예전: READY(15s) + 첫 시도(30s) + 두 번째 시도(30s) = **75s** > 장비 시한 60s
   *   → withDeadline 이 먼저 던져 두 번째 시도 결과가 통째로 버려졌다(CLAUDE.md v2.528 Unity 와 같은 유형).
   */
  const os = await import('../src/bmusage/collectors/osSsh.js');
  const poller = bare('bmusage/poller.js');
  const m = /DEVICE_TIMEOUT_MS = Math\.max\(20_000, Number\(process\.env\.BMUSAGE_DEVICE_TIMEOUT_MS\) \|\| (\d+)_?(\d*)\)/.exec(poller);
  assert.ok(m, '장비 시한 상수를 찾지 못했다');
  const deviceMs = Number(`${m[1]}${m[2]}`);
  assert.equal(deviceMs, 60000);
  assert.ok(os.SESSION_BUDGET_MS < deviceMs,
    `세션 예산(${os.SESSION_BUDGET_MS})이 장비 시한(${deviceMs}) 보다 작아야 한다 — 같거나 크면 가드 전에 폴러가 던진다`);
  const READY = 15_000;
  assert.ok(READY + (os.SESSION_BUDGET_MS - READY) <= deviceMs, '최악 합계가 장비 시한을 넘지 않는다');
  assert.equal(os.MIN_SLICE_MS, 5_000);
  const s = bare('bmusage/collectors/osSsh.js');
  assert.match(s, /const slice = \(\) => Math\.min\(CMD_TIMEOUT_MS/, '남은 예산만큼만 시도한다');
  assert.match(s, /if \(slice\(\) < MIN_SLICE_MS\)/, '남은 시간이 부족하면 시작하지 않는다');
  assert.match(s, /budgetSkipped/, '건너뛴 사실을 사유로 남긴다(조용한 생략 금지)');
});

// ── 실제 DB 왕복(산수·중복·순서) ──────────────────────────────────────────────
test('실제 DB 왕복 — 롤업 산수 · 중복 방지 · 낡은 ts · null 처리 · agent 격리', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'bmusage-perf-'));
  const prevCfg = process.env.CONFIG_DIR;
  process.env.CONFIG_DIR = dir;
  try {
    const cfg = await import('../src/config.js');
    const realDir = cfg.config.dbDir || cfg.config.configDir;
    const db = await import('../src/bmusage/db.js');
    db._resetForTest();
    if (!(await db.available())) { console.log('  (node:sqlite 없음 — 건너뜀)'); return; }
    const now = Date.parse('2026-09-17T03:00:00Z');   // KST 12:00
    const mk = (key, ts, cpu, mem, x = {}) => ({ key, ts, name: `bm-${key}`, vcenterId: 'vc1', src: 'os', cpu_pct: cpu, mem_pct: mem, ...x });

    assert.deepEqual(await db.insertUsage([mk('A', now, 20, 60), mk('B', now, null, 44)], ''), { ok: true, inserted: 2, duplicates: 0 });
    assert.equal((await db.latestUsage()).length, 2);

    // 같은 ts 재삽입 → 롤업이 누적되지 않는다
    assert.deepEqual(await db.insertUsage([mk('A', now, 99, 99)], ''), { ok: true, inserted: 0, duplicates: 1 });
    let d = (await db.usageDaily({ key: 'A', agent: '' }))[0];
    assert.equal(d.samples, 1); assert.equal(d.cpu_n, 1); assert.equal(d.cpu_avg, 20); assert.equal(d.cpu_max, 20);

    // 다음 주기 → 평균·최대 갱신, 최신값도 갱신
    await db.insertUsage([mk('A', now + 300_000, 40, 70)], '');
    d = (await db.usageDaily({ key: 'A', agent: '' }))[0];
    assert.equal(d.samples, 2); assert.equal(d.cpu_avg, 30); assert.equal(d.cpu_max, 40);
    assert.equal((await db.latestUsage()).find((r) => r.key === 'A').cpu_pct, 40);

    // 낡은 ts 가 늦게 도착해도 최신값을 덮지 않는다
    await db.insertUsage([mk('A', now - 600_000, 5, 5)], '');
    assert.equal((await db.latestUsage()).find((r) => r.key === 'A').cpu_pct, 40, '낡은 값이 최신을 덮었다');

    // null 은 평균 분모에 넣지 않는다
    await db.insertUsage([mk('B', now + 300_000, 50, 50)], '');
    const dB = (await db.usageDaily({ key: 'B', agent: '' }))[0];
    assert.equal(dB.samples, 2); assert.equal(dB.cpu_n, 1); assert.equal(dB.cpu_avg, 50);
    assert.equal(dB.mem_n, 2); assert.equal(dB.mem_avg, 47);

    // 전부 null 이면 max 도 null(0 이 아니다)
    await db.insertUsage([mk('C', now, null, null, { disk_busy_pct: null, net_pct: null })], '');
    const dC = (await db.usageDaily({ key: 'C', agent: '' }))[0];
    assert.equal(dC.cpu_max, null); assert.equal(dC.disk_busy_max, null); assert.equal(dC.cpu_avg, null);
    await db.insertUsage([mk('C', now + 300_000, null, null, { disk_busy_pct: 33, net_pct: null })], '');
    const dC2 = (await db.usageDaily({ key: 'C', agent: '' }))[0];
    assert.equal(dC2.disk_busy_max, 33); assert.equal(dC2.net_max, null);

    // agent 격리
    await db.insertUsage([mk('Z', now, 10, 10)], 'SEOUL');
    assert.deepEqual((await db.usageDaily({ agent: '' })).map((r) => r.key).sort(), ['A', 'B', 'C']);
    assert.deepEqual((await db.usageDaily({ agent: 'SEOUL' })).map((r) => r.key), ['Z']);

    // ⚠ 새 DB 파일은 열자마자 0600(v2.535 규약)
    const mode = fs.statSync(path.join(realDir, 'bm-usage.db')).mode & 0o777;
    assert.equal(mode, 0o600, `DB 권한이 ${mode.toString(8)} 다`);

    const st = await db.dbStatus();
    assert.ok(st.countsAt, '행 수가 캐시임을 밝혀야 한다(숨기지 않는다)');
    db._resetForTest();
  } finally {
    if (prevCfg === undefined) delete process.env.CONFIG_DIR; else process.env.CONFIG_DIR = prevCfg;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
