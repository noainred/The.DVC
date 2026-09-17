/**
 * 엣지 로그·진행상태(v2.549) 회귀 — 사용자 요청 "진행상태를 edge 의 로그를 읽어와서 확인".
 *
 * 고정하는 것은 **정직성 규칙**이다:
 *  · 비밀은 출구에서 가리고 가린 개수를 밝힌다. 비밀이 아닌 `deviceKey`·`partKey` 는 가리지 않는다.
 *  · '수집 실패' 와 '항목 없음' 을 구분한다(상태 항목 실패는 그 항목만).
 *  · 보관은 인메모리 링버퍼이고 상한을 밝힌다(엣지가 자른 것 / 중앙이 자른 것을 구분).
 *  · 폴백 큐는 claim→ack 2단계다(인출 직후 재시작해도 요청이 사라지지 않는다).
 *  · 404 는 두 뜻이다(구버전 / 엣지에서 꺼짐) — 본문으로 가른다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isSecretKey, redactDeep, redactLogLine, MASK } from '../src/edgelog/redact.js';
import { STATUS_SPEC, STATUS_KEYS, GROUP_LABEL } from '../src/edgelog/spec.js';
import { collectEdgeLog, DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT } from '../src/edgelog/collect.js';
import * as store from '../src/central/edgeLogStore.js';
import * as jobs from '../src/central/edgeLogJobs.js';
import { buildEdgeRows, cmpVersion } from '../src/routes/api/edgeLog.js';

test('가릴 키와 가리면 안 되는 키를 구분한다', () => {
  for (const k of ['password', 'token', 'centralToken', 'collectorToken', 'privateKey', 'passphrase',
    'CENTRAL_TOKEN', 'AUTH_SECRET', 'guestPass', 'apiKey', 'devicePassword']) {
    assert.equal(isSecretKey(k), true, `가려야 한다: ${k}`);
  }
  // ⚠ `key$` 를 통째로 넣으면 이것들이 전부 가려져 화면의 식별자가 사라진다.
  for (const k of ['deviceKey', 'partKey', 'dbKey', 'keyKind', 'agent', 'host', 'tokenCount', 'broken']) {
    assert.equal(isSecretKey(k), false, `가리면 안 된다: ${k}`);
  }
});

test('redactDeep 은 값을 가리되 키는 남기고 개수를 밝힌다', () => {
  const src = { a: { password: 'p@ss', host: '10.0.0.1' }, list: [{ token: 'abc' }, { token: '' }, { token: null }] };
  const r = redactDeep(src);
  assert.equal(r.value.a.password, MASK);
  assert.equal(r.value.a.host, '10.0.0.1');
  assert.equal(r.value.list[0].token, MASK);
  assert.equal(r.value.list[1].token, '', '빈 값 자체가 진단이므로 그대로 둔다');
  assert.equal(r.value.list[2].token, null);
  assert.equal(r.masked, 2);
  assert.equal(src.a.password, 'p@ss', '원본을 바꾸지 않는다');
});

test('redactDeep 은 순환 참조에서 멈춘다', () => {
  const a = { name: 'x' }; a.self = a;
  const r = redactDeep(a);
  assert.equal(r.value.name, 'x');
  assert.equal(r.value.self, '[순환]');
});

test('로그 줄 가림 — KEY=값 · Bearer 꼴', () => {
  assert.match(redactLogLine('token=abcd1234 done'), /token=\[가림\] done/);
  assert.match(redactLogLine('Authorization: Bearer eyJhbGciOi'), /Bearer \[가림\]/);
  assert.match(redactLogLine('X-Collector-Token: zzz'), /\[가림\]/);
  // 이름만 적는 기존 로그는 그대로 남는다(값이 없으므로).
  assert.equal(redactLogLine('[partfault-push] 비활성 — CENTRAL_URL/CENTRAL_TOKEN 없음'),
    '[partfault-push] 비활성 — CENTRAL_URL/CENTRAL_TOKEN 없음');
});

test('상태 사양은 키 중복이 없고 그룹 라벨이 전부 있다', () => {
  assert.equal(STATUS_KEYS.size, STATUS_SPEC.length, '키가 중복되면 라벨·값이 덮인다');
  for (const s of STATUS_SPEC) assert.ok(GROUP_LABEL[s.group], `그룹 라벨 없음: ${s.group}`);
  assert.ok(STATUS_SPEC.length >= 20, '진행상태 항목이 너무 적다');
});

test('collectEdgeLog 봉투 — 로그 상한·상태 실패 개수를 밝힌다', async () => {
  const snap = await collectEdgeLog({ limit: 5 });
  assert.ok(snap.node.hostname);
  assert.ok(['edge', 'central'].includes(snap.node.role));
  assert.ok(snap.logs.count <= 5);
  assert.equal(typeof snap.logs.truncated, 'boolean');
  assert.equal(snap.status.length, STATUS_SPEC.length);
  assert.equal(snap.statusFailed, snap.status.filter((x) => !x.ok).length);
  // 상태를 못 읽은 항목은 value 가 null 이고 error 가 있다 — '꺼짐' 이 아니다.
  for (const it of snap.status) if (!it.ok) assert.ok(it.error, '실패 항목은 사유를 남긴다');
});

test('로그 상한은 MAX_LOG_LIMIT 를 넘지 않는다', async () => {
  const snap = await collectEdgeLog({ limit: MAX_LOG_LIMIT * 10, withStatus: false });
  assert.ok(snap.logs.count <= MAX_LOG_LIMIT);
  assert.equal(snap.status, null, 'withStatus:false 면 상태를 담지 않는다');
  assert.ok(DEFAULT_LOG_LIMIT <= MAX_LOG_LIMIT);
});

test('보관소 — 엣지당 상한 · 엣지가 자른 것과 중앙이 자른 것을 구분', () => {
  store._resetForTest();
  const big = Array.from({ length: 5_000 }, (_, i) => ({ id: i, time: 't', level: 'info', msg: 'x' }));
  const rec = store.putEdgeLog('E1', { via: 'pull', ok: true, logs: { lastId: 4999, items: big, truncated: true, omitted: 7 } });
  assert.ok(rec.logs.count < 5_000, '중앙도 스스로 자른다');
  assert.equal(rec.logs.centralCapped, true);
  assert.equal(rec.logs.truncated, true, '엣지가 자른 사실은 별도로 남는다');
  assert.equal(rec.logs.omitted, 7);
  for (let i = 0; i < 30; i += 1) store.putEdgeLog('E1', { via: 'pull', ok: true, logs: { items: [] } });
  assert.ok(store.edgeLogHistory('E1').length <= store.storeInfo().keepPerAgent);
  assert.equal(store.edgeLogSummaries().length, 1);
  assert.equal(store.latestEdgeLog('e1').ok, true, '대소문자 무시');
});

test('보관소는 실패도 기록한다 — 사유가 남아야 화면이 말할 수 있다', () => {
  store._resetForTest();
  store.putEdgeLog('E2', { via: 'pull', ok: false, error: 'unreachable: connect ECONNREFUSED', ms: 12 });
  const s = store.edgeLogSummaries()[0];
  assert.equal(s.ok, false);
  assert.match(s.error, /ECONNREFUSED/);
  assert.equal(s.logCount, null, '실패 스냅샷의 수치는 0 이 아니라 null 이다');
});

test('보관소 — 실패 기록을 "보관분" 으로 내주지 않는다', () => {
  store._resetForTest();
  store.putEdgeLog('E3', { via: 'pull', ok: true, logs: { items: [{ id: 1, time: 't', level: 'info', msg: 'a' }] } });
  store.putEdgeLog('E3', { via: 'pull', ok: false, error: 'unreachable' });
  assert.equal(store.latestEdgeLog('E3').ok, false, '최신은 실패 기록이다(사유를 남긴다)');
  const d = store.lastDataEdgeLog('E3');
  assert.equal(d.ok, true);
  assert.equal(d.logs.count, 1, '화면에 내주는 것은 내용이 있는 마지막 보관분이다');
  store._resetForTest();
  store.putEdgeLog('E4', { via: 'pull', ok: false, error: 'x' });
  assert.equal(store.lastDataEdgeLog('E4'), null, '내용이 한 번도 없었으면 null 이다');
});

test('폴백 큐 — claim→ack 2단계, 기한 초과는 되돌린다', () => {
  jobs._resetForTest();
  const t0 = 1_000_000;
  assert.ok(jobs.enqueueEdgeLogJob('E1', { limit: 100 }));
  assert.equal(jobs.edgeLogJobState('E1', t0).state, 'pending');
  const claimed = jobs.takeEdgeLogJob('E1', t0);
  assert.equal(claimed.limit, 100);
  assert.equal(jobs.edgeLogJobState('E1', t0).state, 'claimed');
  assert.equal(jobs.takeEdgeLogJob('E1', t0), null, '두 번 인출되지 않는다');
  // 기한 초과 → 대기로 되돌린다(엣지가 인출 직후 재시작해도 요청이 사라지지 않는다).
  const far = t0 + 10 * 60_000;
  jobs.reapEdgeLogClaims(far);
  assert.equal(jobs.edgeLogJobState('E1', far).state, 'pending');
});

test('폴백 큐 — ack 는 인출분만 지우고, 요청 없던 회신을 구분한다', () => {
  jobs._resetForTest();
  jobs.enqueueEdgeLogJob('E1');
  jobs.takeEdgeLogJob('E1');
  assert.equal(jobs.ackEdgeLogJob('E1').acked, true);
  assert.equal(jobs.ackEdgeLogJob('E1').acked, false, '요청한 적 없는 회신은 그렇다고 알려준다');
  assert.equal(jobs.edgeLogJobState('E1').state, 'none');
});

test('폴백 큐 — 엣지당 대기 1건(연타가 큐를 부풀리지 않는다)', () => {
  jobs._resetForTest();
  jobs.enqueueEdgeLogJob('E1', { limit: 10 });
  jobs.enqueueEdgeLogJob('E1', { limit: 20 });
  assert.equal(jobs.edgeLogJobsInfo().pending, 1);
  assert.equal(jobs.takeEdgeLogJob('E1').limit, 20, '최신 요청이 이긴다');
});

test('cmpVersion — 형식이 아니면 null(추측하지 않는다)', () => {
  assert.ok(cmpVersion('2.549.0', '2.548.0') > 0);
  assert.equal(cmpVersion('2.549.0', '2.549.0'), 0);
  assert.ok(cmpVersion('2.547.9', '2.549.0') < 0);
  assert.equal(cmpVersion('', '2.549.0'), null);
  assert.equal(cmpVersion('dev', '2.549.0'), null);
});

test('buildEdgeRows — 아직 안 가져온 것을 이상으로 분류하지 않는다', () => {
  const collectors = [
    { id: 'c1', name: 'E1', url: 'http://a', enabled: true },
    { id: 'c2', name: 'E2', url: 'http://b', enabled: true },
    { id: 'c3', name: 'E3', url: 'http://c', enabled: false },
    { id: 'c4', name: 'E4', url: '', enabled: true },
    { id: 'c5', name: 'E5', url: 'http://e', enabled: true },
  ];
  const status = { c1: { version: '2.549.0' }, c2: { version: '2.500.0' }, c5: {} };
  const r = buildEdgeRows({ collectors, status, summaries: [], jobs: {}, minVersion: '2.549.0' });
  const by = Object.fromEntries(r.rows.map((x) => [x.agent, x.kind]));
  assert.equal(by.E1, 'ready', '버전은 되는데 아직 안 가져온 것 = ready(이상 아님)');
  assert.equal(by.E2, 'old-version');
  assert.equal(by.E3, 'disabled');
  assert.equal(by.E4, 'no-url');
  assert.equal(by.E5, 'unknown-version', '버전을 모르면 모른다고 한다');
});

test('buildEdgeRows — 보관분·실패·등록부에 없는 엣지', () => {
  const collectors = [{ id: 'c1', name: 'E1', url: 'http://a', enabled: true }];
  const summaries = [
    { agent: 'E1', ok: true, at: 1, logCount: 3, kept: 1 },
    { agent: 'ZZ', ok: false, at: 2, error: 'x', kept: 1, node: { version: '2.549.0' } },
  ];
  const r = buildEdgeRows({ collectors, status: { c1: { version: '2.549.0' } }, summaries, jobs: {} });
  const by = Object.fromEntries(r.rows.map((x) => [x.agent, x]));
  assert.equal(by.E1.kind, 'have');
  assert.equal(by.ZZ.kind, 'failed');
  assert.equal(by.ZZ.unregistered, true, '등록부에 없어도 숨기지 않는다');
  assert.equal(r.counts.have, 1);
});
