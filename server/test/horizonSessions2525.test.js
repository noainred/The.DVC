/**
 * test/horizonSessions2525.test.js — Horizon 실시간 사용자(v2.525) 회귀 고정.
 *
 * 이 기능의 위험은 두 가지다:
 *  ① **거짓으로 '접속 중 0명' 이라고 말하는 것** — 상태 필드를 못 읽었거나 조회가 실패했는데
 *     0 으로 채우는 것. 아래 테스트가 그 경계를 전부 null 로 고정한다.
 *  ② **응답 필드명을 확인하지 못한 채 단정하는 것** — 공식 문서(`developer.broadcom.com`)가
 *     이 환경에서 egress 차단이라 계정 필드명을 확인하지 못했다. 그래서 후보 체인으로 읽고
 *     **무엇으로 읽었는지 보고**한다(v2.522 `usedCmds` 규약). 그 보고를 테스트가 고정한다.
 *
 * ⚠ 기준 시각은 **고정**하고 경계에서 떨어뜨린다(CLAUDE.md v2.517 규칙).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const HOUR = 3_600_000;
/** 정시 -30분 — 항상 과거이고 어느 버킷 경계에서도 30분 떨어져 있다. */
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

const {
  normalizeSessions, combineServers, seriesRow, pickKey, looksLikeSid,
  SESSION_PATH, USER_NAME_KEYS, USER_ID_KEYS, STATE_KEYS,
} = await import('../src/horizon/sessions.js');

/* ─── 정규화: 계정 필드 후보 체인 ─────────────────────────────────────────── */

test('정규화: user_name 으로 읽고 무엇으로 읽었는지 보고한다', () => {
  const r = normalizeSessions([
    { id: 's1', user_name: 'CORP\\aaa', session_state: 'CONNECTED', session_type: 'DESKTOP', desktop_pool_id: 'pool-1', machine_name: 'VDI-01', start_time: NOW - 600_000 },
    { id: 's2', user_name: 'CORP\\bbb', session_state: 'DISCONNECTED', desktop_pool_id: 'pool-1', machine_name: 'VDI-02' },
    { id: 's3', user_name: 'CORP\\aaa', session_state: 'CONNECTED', desktop_pool_id: 'pool-2', machine_name: 'VDI-09' },
  ]);
  assert.equal(r.parsed, true);
  assert.equal(r.usedUserKey, 'user_name');
  assert.equal(r.usedStateKey, 'session_state');
  assert.equal(r.sessions, 3);
  assert.equal(r.connected, 2);
  assert.equal(r.disconnected, 1);
  // 사용자 지시: 같은 계정이 여러 세션이면 **1명**이다(v2.520 과 같은 축)
  assert.equal(r.users, 2, '세션 수를 사용자 수로 쓰면 수치가 부풀어 거짓이 된다');
  assert.equal(r.usersConnected, 1, 'bbb 는 끊겨 있으므로 접속 중 사용자는 aaa 1명뿐');
  assert.equal(r.userIdOnly, false);
  const aaa = r.names.find((u) => u.name === 'CORP\\aaa');
  assert.equal(aaa.sessions, 2);
  assert.deepEqual(aaa.pools, ['pool-1', 'pool-2']);
  assert.equal(r.pools.length, 2);
});

test('정규화: 후보 체인 순서대로 다른 필드명도 읽는다', () => {
  for (const k of USER_NAME_KEYS) {
    const r = normalizeSessions([{ [k]: 'aaa', session_state: 'CONNECTED' }]);
    assert.equal(r.usedUserKey, k, `${k} 를 읽지 못하면 그 Horizon 버전에서 기능이 통째로 죽는다`);
    assert.equal(r.users, 1);
  }
});

test('정규화: 이름이 없고 SID 만 있으면 SID 로 세고 그 사실을 밝힌다', () => {
  const sid = 'S-1-5-21-367742975-1234567890-987654321-1001';
  const r = normalizeSessions([{ user_id: sid, session_state: 'CONNECTED' }]);
  assert.equal(r.usedUserKey, 'user_id');
  assert.equal(r.userIdOnly, true, 'SID 를 이름인 척 표시하면 거짓이다 — 화면이 구분할 수 있어야 한다');
  assert.equal(r.users, 1);
  assert.equal(r.names[0].isSid, true);
  assert.equal(looksLikeSid(sid), true);
  assert.equal(looksLikeSid('CORP\\aaa'), false);
  assert.ok(USER_ID_KEYS.includes('user_id'));
});

test('정규화: 계정 필드를 전혀 못 찾으면 unparsed — 수치를 0 으로 만들지 않는다', () => {
  const r = normalizeSessions([{ id: 's1', foo: 'bar' }]);
  assert.equal(r.parsed, false);
  assert.equal(r.users, null, "0 으로 채우면 '사용자 0명' 이라는 거짓이 된다");
  assert.equal(r.connected, null);
  assert.equal(r.sessions, 1, '세션이 1건 왔다는 사실은 사실이므로 그것만 싣는다');
  assert.ok(r.sampleKeys.includes('foo'), '응답 필드를 알려주면 필드명을 맞출 수 있다');
});

test('정규화: 상태 필드가 없으면 connected 는 null 이다(0 금지)', () => {
  const r = normalizeSessions([{ user_name: 'aaa' }, { user_name: 'bbb' }]);
  assert.equal(r.parsed, true);
  assert.equal(r.usedStateKey, null);
  assert.equal(r.connected, null, "상태를 모르는데 0 이라고 하면 '지금 아무도 없다' 는 거짓이 된다");
  assert.equal(r.usersConnected, null);
  assert.equal(r.users, 2, '고유 계정 수는 상태와 무관하게 셀 수 있다');
  assert.equal(r.stateUnknown, 2);
  assert.ok(STATE_KEYS.includes('session_state'));
});

test('정규화: 알 수 없는 상태값은 other 로 두고 지어내지 않는다', () => {
  const r = normalizeSessions([{ user_name: 'aaa', session_state: 'SOMETHING_NEW' }]);
  assert.equal(r.other, 1);
  assert.equal(r.connected, 0);
  assert.equal(r.usersConnected, 0);
});

test('정규화: 상한으로 자른 것은 개수를 밝힌다', () => {
  const raw = Array.from({ length: 10 }, (_, i) => ({ user_name: `u${i}`, session_state: 'CONNECTED', desktop_pool_id: `p${i}` }));
  const r = normalizeSessions(raw, { maxUsers: 3, maxPools: 2 });
  assert.equal(r.users, 10, '수치는 상한과 무관하게 전체다');
  assert.equal(r.names.length, 3);
  assert.equal(r.usersOmitted, 7, '조용히 자르면 목록이 전부라고 거짓말한다');
  assert.equal(r.poolsOmitted, 8);
});

test('pickKey: 빈 문자열·객체는 값으로 보지 않는다', () => {
  assert.deepEqual(pickKey({ a: '', b: '  ', c: 'x' }, ['a', 'b', 'c']), ['c', 'x']);
  assert.deepEqual(pickKey({ a: {} }, ['a']), [null, null]);
  assert.deepEqual(pickKey(null, ['a']), [null, null]);
});

/* ─── 여러 Connection Server 합치기 ───────────────────────────────────────── */

test('합치기: 두 서버에 같은 계정이면 1명이고, 서버별 합과의 차이를 낸다', () => {
  const a = { ok: true, serverId: 'hz1', ...normalizeSessions([{ user_name: 'aaa', session_state: 'CONNECTED' }, { user_name: 'bbb', session_state: 'CONNECTED' }]) };
  const b = { ok: true, serverId: 'hz2', ...normalizeSessions([{ user_name: 'aaa', session_state: 'CONNECTED' }, { user_name: 'ccc', session_state: 'DISCONNECTED' }]) };
  const t = combineServers([a, b]);
  assert.equal(t.users, 3, '합집합 — aaa 는 1명');
  assert.equal(t.usersByServerSum, 4, '서버별 고유의 합 — 이 차이가 사용자가 알아야 할 정보다');
  assert.equal(t.usersConnected, 2);
  assert.equal(t.sessions, 4);
  assert.deepEqual(t.names.find((u) => u.name === 'aaa').servers, ['hz1', 'hz2']);
  assert.equal(t.serversOk, 2);
  assert.equal(t.serversFailed, 0);
});

test('합치기: 실패한 서버는 수치에서 빼고 개수를 밝힌다', () => {
  const a = { ok: true, serverId: 'hz1', ...normalizeSessions([{ user_name: 'aaa', session_state: 'CONNECTED' }]) };
  const bad = { ok: false, serverId: 'hz2', kind: 'auth', parsed: false, sessions: null, users: null, names: [] };
  const t = combineServers([a, bad]);
  assert.equal(t.users, 1);
  assert.equal(t.serversOk, 1);
  assert.equal(t.serversFailed, 1, "빼놓고 밝히지 않으면 '사용자가 줄었다' 는 거짓 추이가 남는다");
});

test('합치기: 한 서버라도 상태를 못 읽으면 합계도 단정하지 않는다', () => {
  const a = { ok: true, serverId: 'hz1', ...normalizeSessions([{ user_name: 'aaa', session_state: 'CONNECTED' }]) };
  const blind = { ok: true, serverId: 'hz2', ...normalizeSessions([{ user_name: 'bbb' }]) };
  const t = combineServers([a, blind]);
  assert.equal(t.stateBlind, true);
  assert.equal(t.connected, null, '부분 합은 더 위험한 거짓이다');
  assert.equal(t.usersConnected, null);
  assert.equal(t.users, 2, '고유 계정 수는 여전히 셀 수 있다');
});

test('seriesRow: 계정명을 시계열에 넣지 않는다(수치만)', () => {
  const r = seriesRow({ users: 3, usersConnected: 2, sessions: 5, connected: 2, disconnected: 3, pending: 0, names: [{ name: 'aaa' }] });
  assert.deepEqual(Object.keys(r).sort(), ['connected', 'disconnected', 'pending', 'sessions', 'users', 'usersConnected'].sort());
  assert.equal(r.users, 3);
  // null 은 null 로 보존한다(0 으로 채우면 거짓)
  assert.equal(seriesRow({ users: null }).users, null);
});

/* ─── 두 출처 합집합(Windows ∪ VDI) ──────────────────────────────────────── */

const { combineSources, NAME_FORM_NOTE } = await import('../src/curuser/combine.js');

test('합집합: 양쪽에 있는 사람을 두 번 세지 않고 겹친 인원을 밝힌다', () => {
  const c = combineSources({
    windows: { state: 'ok', names: [{ name: 'CORP\\aaa' }, { name: 'CORP\\bbb' }] },
    vdi: { state: 'ok', names: [{ name: 'corp\\AAA' }, { name: 'CORP\\ccc' }] },
  });
  assert.equal(c.union, 3, '대소문자는 무시한다(Windows 계정명 규칙)');
  assert.equal(c.sum, 4);
  assert.equal(c.both, 1);
  assert.equal(c.onlyWindows, 1);
  assert.equal(c.onlyVdi, 1);
  assert.equal(c.partial, false);
});

test('합집합: 한 출처를 읽지 못하면 partial 로 밝힌다(전체라고 말하지 않는다)', () => {
  const c = combineSources({
    windows: { state: 'ok', names: [{ name: 'aaa' }] },
    vdi: { state: 'off', names: [], reason: '수집이 꺼져 있습니다' },
  });
  assert.equal(c.partial, true);
  assert.equal(c.missingSources.length, 1);
  assert.equal(c.missingSources[0].state, 'off', "'꺼짐' 과 '실패' 는 조치가 정반대라 구분해야 한다");
  assert.equal(c.union, 1);
});

test('합집합: SID 로만 식별된 계정은 이름과 겹칠 수 없다는 사실을 밝힌다', () => {
  const c = combineSources({
    windows: { state: 'ok', names: [{ name: 'CORP\\aaa' }] },
    vdi: { state: 'ok', names: [{ name: 'S-1-5-21-1-2-3-1001', isSid: true }] },
  });
  assert.equal(c.sidOnly, 1);
  assert.equal(c.union, 2, '실제로는 같은 사람일 수 있으나 우리는 알 수 없다 — 지어내지 않는다');
  assert.match(NAME_FORM_NOTE, /도메인 접두/);
});

/* ─── 설정 정규화 ─────────────────────────────────────────────────────────── */

const hzSet = await import('../src/horizon/sessionSettings.js');

test('설정: 기본은 꺼짐이고 한계 밖 값은 하한/상한으로 잡힌다', () => {
  const d = hzSet.normalize({});
  assert.equal(d.enabled, false, 'opt-in — 켜지 않으면 Horizon 에 로그인 왕복을 만들지 않는다');
  assert.equal(d.intervalMs, hzSet.LIMITS.intervalMs.def);
  assert.equal(hzSet.normalize({ intervalMs: 1 }).intervalMs, hzSet.LIMITS.intervalMs.min);
  assert.equal(hzSet.normalize({ intervalMs: 9e9 }).intervalMs, hzSet.LIMITS.intervalMs.max);
  // 빈 값·0 은 하한으로 승격하지 않고 기본값을 쓴다(미입력이 최소주기로 둔갑하는 사고 방지)
  assert.equal(hzSet.normalize({ intervalMs: 0 }).intervalMs, hzSet.LIMITS.intervalMs.def);
  assert.equal(hzSet.normalize({ pageSize: 99999 }).pageSize, hzSet.LIMITS.pageSize.max);
  assert.ok(hzSet.LIMITS.pageSize.max <= 1000, 'Horizon size 파라미터 상한이 1000 이다');
  assert.equal(hzSet.normalize({ servers: { hz1: { enabled: false } } }).servers.hz1.enabled, false);
  assert.equal(hzSet.normalize({ servers: { hz1: {} } }).servers.hz1.enabled, true, '등록했으면 기본 수집');
});

test('설정: 자격증명을 저장하지 않는다(horizon.json 재사용)', () => {
  const src = read('horizon/sessionSettings.js');
  assert.ok(!/password/i.test(src), '자격증명 스토어를 두 개 두면 비밀 승계·SSRF 가드를 두 곳에서 지켜야 한다');
});

/* ─── 수집: 페이징·실패 원인 구분 ────────────────────────────────────────── */

const { collectServerSessions, KIND_LABEL } = await import('../src/horizon/sessionCollect.js');

/** global fetch 를 갈아 끼워 로그인→페이징→로그아웃 경로를 실제로 돌린다. */
function stubFetch(handler) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET' });
    return handler(String(url), opts);
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const SRV = { id: 'hz1', name: 'HZ', host: 'https://hz.example.com', username: 'u', password: 'p', domain: 'CORP', timeoutMs: 5_000 };

test('수집: 페이지를 이어붙이고 마지막 페이지에서 멈춘다', async () => {
  const page = (n, size) => Array.from({ length: size }, (_, i) => ({ id: `s${n}-${i}`, user_name: `u${n}-${i}`, session_state: 'CONNECTED' }));
  const s = stubFetch((url) => {
    if (url.endsWith('/rest/login')) return json({ access_token: 't', refresh_token: 'r' });
    if (url.endsWith('/rest/logout')) return json({});
    const p = Number(new URL(url).searchParams.get('page'));
    return json(p === 1 ? page(1, 2) : page(2, 1));     // 2건(=size) → 1건(<size) 이면 끝
  });
  try {
    const r = await collectServerSessions(SRV, { pageSize: 2, maxPages: 5 });
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'ok');
    assert.equal(r.sessions, 3);
    assert.equal(r.pages, 2);
    assert.equal(r.truncated, false);
    assert.ok(s.calls.some((c) => c.url.includes(SESSION_PATH)), '실제 조회 경로가 바뀌면 기능이 죽는다');
    assert.ok(s.calls.some((c) => c.url.endsWith('/rest/logout')), '로그아웃을 빠뜨리면 세션이 누수된다');
  } finally { s.restore(); }
});

test('수집: 페이지 상한에 걸리면 truncated 로 밝힌다(조용한 상한 금지)', async () => {
  const s = stubFetch((url) => {
    if (url.endsWith('/rest/login')) return json({ access_token: 't' });
    if (url.endsWith('/rest/logout')) return json({});
    return json([{ user_name: 'a', session_state: 'CONNECTED' }, { user_name: 'b', session_state: 'CONNECTED' }]);
  });
  try {
    const r = await collectServerSessions(SRV, { pageSize: 2, maxPages: 2 });
    assert.equal(r.truncated, true);
    assert.equal(r.pages, 2);
  } finally { s.restore(); }
});

test("수집: HAS_MORE_RECORDS=false 헤더를 주면 그 페이지에서 멈춘다", async () => {
  let n = 0;
  const s = stubFetch((url) => {
    if (url.endsWith('/rest/login')) return json({ access_token: 't' });
    if (url.endsWith('/rest/logout')) return json({});
    n++;
    return json([{ user_name: 'a', session_state: 'CONNECTED' }, { user_name: 'b', session_state: 'CONNECTED' }], 200, { HAS_MORE_RECORDS: 'false' });
  });
  try {
    const r = await collectServerSessions(SRV, { pageSize: 2, maxPages: 10 });
    assert.equal(n, 1, '헤더가 더 없다고 하면 개수 판정보다 헤더를 믿는다');
    assert.equal(r.truncated, false);
  } finally { s.restore(); }
});

test('수집: 실패 원인을 구분한다 — 401/404/형식/기타', async () => {
  for (const [status, kind] of [[401, 'auth'], [403, 'auth'], [404, 'no-endpoint'], [500, 'http']]) {
    const s = stubFetch((url) => {
      if (url.endsWith('/rest/login')) return json({ access_token: 't' });
      if (url.endsWith('/rest/logout')) return json({});
      return json({ error_message: 'nope' }, status);
    });
    try {
      const r = await collectServerSessions(SRV, {});
      assert.equal(r.ok, false);
      assert.equal(r.kind, kind, `HTTP ${status} 는 ${kind} 로 구분해야 조치 문구가 맞는다`);
      assert.equal(r.users, null, '실패 주기의 수치는 null 이다(0 금지)');
      assert.equal(r.sessions, null);
    } finally { s.restore(); }
  }
});

test('수집: 로그인 401 은 auth 로 구분한다', async () => {
  const s = stubFetch(() => json({}, 401));
  try {
    const r = await collectServerSessions(SRV, {});
    assert.equal(r.kind, 'auth');
    assert.match(r.error, /로그인 실패/);
  } finally { s.restore(); }
});

test('수집: 배열이 아닌 응답은 unparsed 다', async () => {
  const s = stubFetch((url) => {
    if (url.endsWith('/rest/login')) return json({ access_token: 't' });
    if (url.endsWith('/rest/logout')) return json({});
    return json({ sessions: [] });
  });
  try {
    const r = await collectServerSessions(SRV, {});
    assert.equal(r.kind, 'unparsed');
  } finally { s.restore(); }
});

test('KIND_LABEL: 모든 판정에 한글 라벨이 있다', () => {
  for (const k of ['ok', 'unparsed', 'auth', 'no-endpoint', 'http', 'timeout', 'error', 'mock', 'disabled']) {
    assert.ok(KIND_LABEL[k], `${k} 라벨이 없으면 화면이 영문 코드를 그대로 보여준다`);
  }
});

/* ─── 공용 로그인(withHorizonSession) 을 복제하지 않았다 ──────────────────── */

test('구조: 세션 수집이 로그인·TLS 설정을 복제하지 않는다', () => {
  assert.match(read('horizon/sessionCollect.js'), /withHorizonSession/);
  assert.ok(!/new Agent\(/.test(read('horizon/sessionCollect.js')),
    'dispatcher(사설 인증서·DNS 리바인딩 가드)를 복사하면 두 갈래로 갈라진다');
  assert.match(read('horizon/horizon.js'), /export async function withHorizonSession/);
  // 라이선스 조회도 같은 함수를 쓴다(로그아웃 누락 방지 단일 지점)
  assert.match(read('horizon/horizon.js'), /fetchHorizonLicenses[\s\S]{0,200}withHorizonSession/);
});

/* ─── 폴러 규약 ───────────────────────────────────────────────────────────── */

test('폴러: 재진입 가드 · 적응형 타이머 · prune 스로틀 규약', () => {
  const src = read('horizon/sessionPoller.js');
  assert.match(src, /if \(running\) return/, '재진입 가드 — 이전 주기가 안 끝났으면 건너뛴다');
  assert.match(src, /startAdaptiveTimer/, '주기를 모듈 로드 시 굳히면 설정 변경이 먹지 않는다(v2.409)');
  assert.match(src, /subscribe: onHorizonSessionSettingsChange/, '설정 변경 시 무장된 타이머를 즉시 재무장');
  assert.match(src, /\(\+\+tick % PRUNE_EVERY_RUNS\) === 0/, 'tick++ 는 첫 틱에서 즉시 참이다(v2.453)');
  assert.match(read('horizon/sessionDb.js'), /\(\+\+tick % Math\.max\(1, every\)\) !== 0/);
});

test('폴러: 이번 주기 결과만 합친다(직전 값 섞기 금지)', () => {
  assert.match(read('horizon/sessionPoller.js'), /Number\(r\.ts\) === ts/,
    "직전 주기 값을 섞으면 '지금 몇 명' 이 거짓이 된다");
});

/* ─── DB 왕복 ─────────────────────────────────────────────────────────────── */

test('DB: 적재 → 최신 조회 → 추이 조회 → prune 스로틀', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'hzsess-'));
  process.env.HZSESS_DB_PATH = path.join(dir, 'horizon-sessions.db');
  const db = await import(`../src/horizon/sessionDb.js?t=${Date.now()}`);
  const st = await db.hzSessionDbStatus();
  if (!st.available) { assert.ok(true, `node:sqlite 없음 — 건너뜀(${st.error})`); return; }
  const ts = NOW;
  const c = await db.commitHzSessions({
    ts,
    records: [
      { serverId: 'hz1', name: 'HZ', host: 'https://hz', ok: true, kind: 'ok', users: 2, usersConnected: 1, sessions: 3, connected: 1, disconnected: 2, pending: 0, pages: 1, usedUserKey: 'user_name', usedStateKey: 'session_state', names: [{ name: 'aaa', connected: 1, sessions: 2 }], pools: [{ pool: 'p1', sessions: 3, connected: 1, users: 2 }], ms: 120 },
      { serverId: 'hz2', name: 'HZ2', ok: false, kind: 'auth', error: '로그인 실패', names: [], pools: [] },
    ],
    series: [{ serverId: '', users: 2, usersConnected: 1, sessions: 3, serversOk: 1, serversFailed: 1 }],
  });
  assert.equal(c.ok, true);
  const rows = await db.hzLatestRecords();
  assert.equal(rows.length, 2);
  const ok = rows.find((r) => r.serverId === 'hz1');
  assert.equal(ok.names[0].name, 'aaa');
  assert.equal(ok.pools[0].pool, 'p1');
  const bad = rows.find((r) => r.serverId === 'hz2');
  assert.equal(bad.kind, 'auth');
  assert.equal(bad.users, null, '실패 서버의 수치는 null 로 남아야 한다(0 이면 사용자 0명이라는 거짓)');
  const s = await db.hzSeriesRange('', ts - HOUR, ts + HOUR);
  assert.equal(s.available, true);
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].serversFailed, 1);
  assert.equal(s.span.first, ts);
  // prune 스로틀 — 첫 호출은 건너뛴다(기동 첫 틱에 보존 차액을 한 번에 지우지 않게)
  assert.equal((await db.pruneHzSessions(180, { every: 12 })).skipped, true);
  // 파일 권한 0600
  assert.equal(fs.statSync(process.env.HZSESS_DB_PATH).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.HZSESS_DB_PATH;
});

/* ─── 라우트 규약 ─────────────────────────────────────────────────────────── */

test('라우트: 범위 제한 계정은 403 으로 거절한다(빈 값 금지)', () => {
  const src = read('routes/api/horizonSessions.js');
  assert.match(src, /requiredOwner: true/, '빈 값을 주면 사용자 0명이라는 거짓이 된다');
  assert.match(src, /requireRole\('admin'\)/, '수집·설정 변경은 관리자만');
  assert.ok(!/password/.test(src), '자격증명은 응답에 절대 싣지 않는다');
});

test('라우트: 등록됐지만 아직 수집되지 않은 서버를 pending 으로 구분한다', () => {
  assert.match(read('routes/api/horizonSessions.js'), /pending:/);
});

/* ─── DB 위치 등록 ────────────────────────────────────────────────────────── */

test('DB 위치: horizon-sessions.db 가 이관 대상에 등록돼 있다', () => {
  assert.match(read('insights/dbLocation.js'), /horizon-sessions\.db/);
});
