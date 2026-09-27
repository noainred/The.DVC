/**
 * v2.632 그룹 E(성능·수명주기) 회귀.
 *  ① A6-2632-01  /capacity/summary 요약은 TTL memo + single-flight(30초 폴링마다 동기 30일 롤업 조회 금지)
 *  ② A6-2632-02  vCenter 로그 CSV 내보내기는 (ts, rowid) 키셋 — 커서와 같은 ts 의 늦은 삽입에도 중복·밀림 없음
 *  ③ AX1-2632-03 resilientFetch 는 시한이 undici 기본 입출력 시한(300초)을 넘으면 긴 시한 디스패처를 쓴다
 *  ④ AX1-2632-07 SSH 웹 콘솔 data 는 서버 프레임 상한 안의 조각으로 나눠 보내고, 1009 닫힘은 사유를 말한다
 * ⚠ 기준 시각은 경계에서 떨어뜨려 고정한다(CLAUDE.md v2.517 규약) — Date.now() 를 그대로 기준으로 쓰지 않는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2632e-'));
const HOUR = 3600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

test('① A6-2632-01 요약 memo: TTL 안의 반복·동시 호출은 30일 창 조회를 다시 하지 않는다', async () => {
  const { getCapacityDb } = await import('../src/capacity/db.js');
  const ev = await import('../src/capacity/evaluate.js');
  const db = await getCapacityDb();
  for (let h = 48; h >= 1; h--) db.insertSnapshot('h-e', [{ metric: 'cpu_system', v: 40 }], NOW - h * HOUR, { hostname: 'h-e' });
  const orig = db.windowStats;
  let calls = 0;
  db.windowStats = (...a) => { calls++; return orig.apply(db, a); };
  try {
    ev._resetSummaryCache();
    assert.equal(ev.summarizeHostsAt(), null);
    const [a, b] = await Promise.all([ev.summarizeHosts(), ev.summarizeHosts()]);   // 동시 → 계산 1회 공유
    const first = calls;
    assert.ok(first > 0, '첫 호출은 계산한다');
    assert.deepEqual(a.map((r) => r.k), b.map((r) => r.k));
    await ev.summarizeHosts();                                                      // TTL 안 → 재계산 없음
    assert.equal(calls, first, `TTL 안에서 windowStats 를 다시 불렀다(${calls - first}회)`);
    assert.ok(Number.isFinite(ev.summarizeHostsAt()), '계산 시각을 밝힌다');
    assert.ok(ev.SUMMARY_TTL_MS >= 30_000 && ev.SUMMARY_TTL_MS <= 300_000);
    const row = a.find((r) => r.k === 'h-e');
    assert.equal(typeof row.fresh, 'boolean', 'fresh 는 응답 시각 기준으로 다시 계산해 싣는다');
    ev._resetSummaryCache();
    await ev.summarizeHosts();
    assert.ok(calls > first, '캐시를 비우면 다시 계산한다');
  } finally { db.windowStats = orig; }
});

test('② A6-2632-02 로그 CSV 키셋: 커서와 같은 ts 로 청크 사이 삽입 → 중복 0 · 원래 행 전부', async () => {
  const { getLogsDb } = await import('../src/logs/db.js');
  const { exportLogPages } = await import('../src/routes/api/checksLogs.js');
  const db = await getLogsDb();
  assert.equal(typeof db.queryPage, 'function');
  const recs = [];
  for (let i = 0; i < 6; i++) recs.push({ vcenterId: 'vc1', key: `a${i}`, ts: NOW - 100_000, severity: 'info', type: 't', user: '', entity: '', message: `a${i}` });
  for (let i = 0; i < 4; i++) recs.push({ vcenterId: 'vc1', key: `b${i}`, ts: NOW - 50_000, severity: 'info', type: 't', user: '', entity: '', message: `b${i}` });
  db.insertMany(recs);
  const out = [];
  let n = 0;
  const r = await exportLogPages(db, { vcenterId: 'vc1' }, {
    max: 1000, chunk: 6,
    onRows: async (rows) => {
      out.push(...rows.map((x) => x.message));
      if (n++ === 0) db.insertMany([{ vcenterId: 'vc1', key: 'LATE', ts: NOW - 100_000, severity: 'info', type: 't', user: '', entity: '', message: 'LATE' }]);
      return true;
    },
  });
  assert.equal(new Set(out).size, out.length, `중복 행: ${out.join(',')}`);
  for (const m of recs.map((x) => x.message)) assert.ok(out.includes(m), `${m} 누락`);
  assert.equal(r.emitted, out.length);
  assert.equal(r.truncated, false);
  // 커서는 숫자여야 한다 — 조용히 처음부터 다시 내보내지 않는다
  assert.throws(() => db.queryPage({}, 1, { ts: 'x', rid: 1 }));
  // 잘림 판정: 정확히 상한이면 잘린 것이 아니다 / 하나 더 있으면 잘림
  const all = db.count({ vcenterId: 'vc1' });
  const ex = await exportLogPages(db, { vcenterId: 'vc1' }, { max: all, chunk: 4, onRows: async () => true });
  assert.equal(ex.truncated, false);
  const ov = await exportLogPages(db, { vcenterId: 'vc1' }, { max: all - 1, chunk: 4, onRows: async () => true });
  assert.equal(ov.truncated, true);
});

test('③ AX1-2632-03 긴 시한 디스패처: 300초 초과 시한은 headersTimeout 이 시한보다 긴 에이전트로', async () => {
  const rf = await import('../src/util/resilientFetch.js');
  const { pushTimeoutMsFor } = await import('../src/bmstor/poller.js');
  const { wanAgent, wanLongAgent } = rf._internals;
  assert.notEqual(wanAgent, wanLongAgent);
  assert.equal(rf.dispatcherFor(undefined, 300_000), wanAgent);
  assert.equal(rf.dispatcherFor(undefined, 20_000), wanAgent);
  assert.equal(rf.dispatcherFor(undefined, 300_001), wanLongAgent);
  const own = { custom: true };
  assert.equal(rf.dispatcherFor(own, 900_000), own, '호출자 디스패처(보안 정책)는 바꾸지 않는다');
  const optsOf = (a) => { const s = Object.getOwnPropertySymbols(a).find((x) => x.toString() === 'Symbol(options)'); return a[s]; };
  const o = optsOf(wanLongAgent);
  const bmMax = pushTimeoutMsFor(10_000);
  assert.ok(bmMax > 300_000, 'bmstor 비례 시한이 300초를 넘는 경우가 실재한다');
  assert.equal(rf.dispatcherFor(undefined, pushTimeoutMsFor(13)), wanLongAgent, '서버 13대 — 예전엔 300초에 끊겼다');
  assert.ok(o.headersTimeout >= rf.normFetchTimeoutMs(1e12), `headersTimeout ${o.headersTimeout} 가 최대 시한보다 짧다`);
  assert.ok(o.bodyTimeout >= rf.normFetchTimeoutMs(1e12));
  assert.equal(o.connect.lookup, optsOf(wanAgent).connect.lookup, 'SSRF lookup 은 같다');
  assert.equal(o.connect.rejectUnauthorized, optsOf(wanAgent).connect.rejectUnauthorized, 'TLS 검증 정책은 같다');
});

test('④ AX1-2632-07 SSH data 분할: 모든 프레임이 서버 상한 안 · 이어 붙이면 원문 · 서로게이트 보존 · 1009 사유', async () => {
  const { SSH_WS_MAX_PAYLOAD } = await import('../src/proxy/sshGateway.js');
  const { sshDataFrames, sshCloseReasonText, SSH_DATA_CHUNK_CHARS } = await import('../../web/src/remote/sshSend.js');
  const cases = [
    'x'.repeat(300 * 1024),
    '\u0001'.repeat(100_000),             // 최악: JSON 이 \u0001(6자)로 늘린다
    '한'.repeat(120_000),                  // UTF-8 3바이트
    ('a' + '\u{1F600}').repeat(50_000),   // 서로게이트 쌍
  ];
  for (const s of cases) {
    const fr = sshDataFrames(s);
    assert.ok(fr.length >= 2);
    let joined = '';
    for (const f of fr) {
      assert.ok(Buffer.byteLength(f, 'utf8') <= SSH_WS_MAX_PAYLOAD, `프레임 ${Buffer.byteLength(f, 'utf8')}B > ${SSH_WS_MAX_PAYLOAD}`);
      const j = JSON.parse(f);
      assert.equal(j.type, 'data');
      const c0 = j.data.charCodeAt(0);
      assert.ok(!(c0 >= 0xdc00 && c0 <= 0xdfff), '하위 서로게이트로 시작하는 조각(쌍이 갈렸다)');
      joined += j.data;
    }
    assert.equal(joined, s);
  }
  // 최악 확장(6배)도 상한 안이어야 한다 — 상한·조각 크기를 따로 바꾸면 깨진다
  assert.ok(SSH_DATA_CHUNK_CHARS * 6 + 64 <= SSH_WS_MAX_PAYLOAD);
  assert.deepEqual(sshDataFrames('ls\r'), [JSON.stringify({ type: 'data', data: 'ls\r' })], '짧은 입력은 예전과 같은 한 프레임');
  assert.deepEqual(sshDataFrames(''), []);
  assert.match(sshCloseReasonText(1009), /256KB/);
  assert.equal(sshCloseReasonText(1000), null);
  // 화면이 실제로 쓰는지(주석 제거 후) — 한 프레임 JSON.stringify 로 되돌리면 실패
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(new URL('../../web/src/remote/RemoteConsole.jsx', import.meta.url), 'utf8'));
  assert.match(src, /sshDataFrames\(d\)/);
  assert.match(src, /sshCloseReasonText\(ev\?\.code\)/);
  assert.doesNotMatch(src, /JSON\.stringify\(\{ type: 'data'/);
});
