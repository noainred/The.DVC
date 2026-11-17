/**
 * authGuardProbe127.test.js — 전체 점검 127회차: 인증 정지 기록(util/authGuard)을 못 읽는 동안의 동작을
 *   '시한 없는 전부 정지'(119회차) → **자격 지문(credHash)마다 한 대상 탐침**(124회차 결정 D-A 의 권장안)으로 바꾼 것을 모의 실험으로 고정한다.
 *
 * 지킬 것 둘 — ① 틀린 자격증명으로의 자동 재로그인은 지문마다 한 대상을 넘지 않는다 ② 파일을 못 읽는다는 이유만으로 수집 · 메일이 기한 없이 전부 멈추지 않는다.
 *   ① 자격이 틀림(N = 28 · 2,048) — 창 전체에서 로그인 1회 · 결과 없는 탐침은 시한마다 한 대상씩 옮겨 간다
 *   ② 자격이 맞음 — 첫 주기 탐침 1 · 다음 주기부터 전 대상
 *   ③ 지문이 섞임 ④ 못 읽는 동안 자격을 고침 ⑤ 읽힌 뒤 합치기 ⑥ 병렬(poolRun) ⑦ peekAuthStop 은 탐침을 주지 않음 ⑧ 메일 가드(실제 sendPortalMail + 가짜 SMTP)
 *   ⑨ 성공이 아닌 정리(verified:false)는 지문을 열지 않는다 + 호출부 분류표 ⑩ 보이게 하기(등록부 · 서비스 점검 행 · 엣지 로그 표) ⑪ 상한
 * 읽기 오류는 119 · 124회차와 같이 **그 파일 이름의 fs.readFileSync 만** 던지게 해 재현한다(root 컨테이너라 EACCES 를 만들 수 없다).
 * 시계: 실제 시각에서 정시 경계로 떨어뜨려 고정(재읽기 간격 · 탐침 시한이 같은 시계 — util/jsonFileRead.js nowMs).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agProbe127-'));
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_DIR: TMP, AUTH_ENABLED: 'true', DATA_SOURCE: 'live', SSRF_ALLOW_LOOPBACK: 'true' });
for (const k of ['CENTRAL_URL', 'CENTRAL_TOKEN']) delete process.env[k];
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const F = (n) => path.join(TMP, n);
const put = (n, v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); fs.writeFileSync(F(n), s); return s; };

const RD = await import('../src/util/jsonFileRead.js');
let NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
RD._setJsonFileLoadClockForTest(() => NOW);
const pass = (ms = RD.READ_RETRY_MS + 1_000) => { NOW += ms; };
const MIN = 60_000;

const realRead = fs.readFileSync;
const bad = new Map();   // 파일 이름 → 오류 코드
fs.readFileSync = (f, ...a) => {
  const code = bad.get(path.basename(String(f)));
  if (code) { const e = new Error(`${code}: read`); e.code = code; throw e; }
  return realRead.call(fs, f, ...a);
};
const raw = (n) => realRead.call(fs, F(n), 'utf8');
const closers = [];
after(async () => {
  fs.readFileSync = realRead; RD._setJsonFileLoadClockForTest();
  for (const c of closers.reverse()) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});
const quiet = async (fn) => { const w = console.warn; const e = console.error; const l = console.log; console.warn = () => {}; console.error = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.error = e; console.log = l; } };

const AG = await import('../src/util/authGuard.js');
const { poolRun } = await import('../src/util/pool.js');
const TTL = AG.UNREAD_PROBE_TTL_MS;

/** 못 읽는 가드 하나(파일은 있고 읽기만 실패한다). */
function unreadGuard(name, content = {}, opts = {}) {
  const g = AG.createAuthGuard({ file: name, ...opts });
  g._resetForTest();
  put(name, content);
  bad.set(name, 'EACCES');
  return g;
}
const devs = (n, prefix, username, password) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, username, password }));
/**
 * 주 폴러 모형 — 한 주기: 먼저 전 대상의 정지를 묻고(store.js 의 filter 꼴) 통과한 대상만 로그인한다.
 * verdictOf(dev) → 'ok'(clearAuthStop) · 'reject'(markAuthStopped) · 'none'(시한 · 통신 오류 — 신호 없음)
 */
function world(g, list, verdictOf) {
  const logins = [];
  let cycle = 0;
  return {
    logins,
    run() {
      cycle += 1;
      const go = list.filter((d) => !g.authStopFor(d));
      for (const d of go) {
        const v = verdictOf(d);
        logins.push({ id: d.id, cycle, v });
        if (v === 'ok') g.clearAuthStop(d.id);
        else if (v === 'reject') g.markAuthStopped(d.id, d, 'HTTP 401 Unauthorized');
      }
      return go.length;
    },
  };
}
const rejects = (w) => w.logins.filter((x) => x.v === 'reject').length;

/* ── ① 자격이 틀린 경우 ─────────────────────────────────────────────────── */
for (const N of [28, 2048]) {
  test(`① 틀린 자격증명 · 한 지문을 ${N}개 대상이 쓴다 — 못 읽는 창 전체에서 로그인은 1회(119 이전: ${N}회 · 119: 0회 + 전부 정지)`, () => quiet(async () => {
    const name = `p1-${N}-auth-stops.json`;
    const list = devs(N, 'vc', 'svc@corp', 'wrong-password');
    // 파일에는 절반이 정지돼 있었다(이 창은 그것을 모른다)
    const orig = Object.fromEntries(list.filter((_, i) => i % 2 === 0).map((d) => [d.id, { credHash: AG.credHashOf(d), since: 1, at: 2, attempts: 3, reason: '인증 실패(401)' }]));
    const g = unreadGuard(name, orig);
    const w = world(g, list, () => 'reject');
    assert.equal(w.run(), 1, '첫 주기 — 한 대상만 시도한다(탐침)');
    for (let i = 0; i < 25; i += 1) { pass(MIN); assert.equal(w.run(), 0, `주기 ${i + 2} — 거부된 지문은 다시 시도하지 않는다(탐침 시한 ${TTL / MIN}분이 지나도)`); }
    assert.equal(w.logins.length, 1, '창 전체(26분 · 탐침 시한의 2배 넘게)에서 실제 로그인 1회');
    // 거부된 대상은 실제 정지 기록(시도 1회), 나머지는 '같은 자격증명이 거부됨'(인증 실패가 이 대상에서 확인된 것이 아니다 — unread 표지)
    const first = g.authStopFor(list[0]);
    assert.equal(first.attempts, 1); assert.equal(AG.isUnreadStop(first), false);
    const other = g.authStopFor(list[N - 1]);
    assert.equal(AG.isUnreadStop(other), true); assert.equal(other.attempts, 0);
    assert.match(other.reason, /같은 자격증명이 다른 대상에서 거부/);
    assert.match(other.reason, new RegExp(`${name.replace(/\./g, '\\.')}.*읽기 오류\\(EACCES\\).*원본은 그대로`));
    assert.doesNotMatch(other.reason, /vc0|HTTP 401/, '다른 대상의 id · 거부 문구를 싣지 않는다(범위 밖 대상이 새지 않게)');
    assert.equal(g.peekAuthStop(list[1])?.unread, true, '보조 수집기(peek)도 같은 판정');
    assert.equal(raw(name), JSON.stringify(orig), '못 읽은 원본 위에 쓰지 않는다');
    g._resetForTest(); bad.delete(name);
  }));
}

test('① 결과 없는 탐침(시한 · 통신 오류)은 시한마다 **다른** 대상 하나로 옮겨 간다 — 닿지 않는 한 대상이 같은 지문 전체를 붙잡지 않는다', () => quiet(async () => {
  const name = 'p1b-auth-stops.json';
  const list = devs(28, 'vc', 'svc@corp', 'pw');
  const g = unreadGuard(name);
  const down = new Set(['vc0', 'vc1', 'vc2']);   // 앞의 셋은 닿지 않는다 · 넷째부터는 틀린 자격으로 거부한다
  const w = world(g, list, (d) => (down.has(d.id) ? 'none' : 'reject'));
  const perInterval = [];
  for (let k = 0; k < 4; k += 1) {
    const seen = new Set();
    for (let i = 0; i < 10; i += 1) { const before = w.logins.length; w.run(); for (const x of w.logins.slice(before)) seen.add(x.id); pass(MIN); }
    perInterval.push([...seen]);
  }
  assert.deepEqual(perInterval, [['vc0'], ['vc1'], ['vc2'], ['vc3']], '시한(10분)마다 한 대상 — 같은 대상으로 돌아가지 않는다');
  assert.equal(new Set(w.logins.map((x) => `${x.cycle}`)).size, w.logins.length, '어느 주기에도 시도하는 대상은 하나뿐이다');
  assert.equal(rejects(w), 1, '거부는 한 번 — 그 뒤로 이 지문은 멈춘다');
  for (let i = 0; i < 12; i += 1) { pass(MIN); assert.equal(w.run(), 0); }
  g._resetForTest(); bad.delete(name);

  // 전 대상이 닿지 않으면 한 바퀴 돈 뒤 처음부터(한 바퀴와 다음 바퀴 사이에 시한 한 번을 쉰다)
  const g2 = unreadGuard(name);
  const three = devs(3, 'x', 'u', 'p');
  const w2 = world(g2, three, () => 'none');
  const order = [];
  for (let i = 0; i < 80; i += 1) { const b = w2.logins.length; w2.run(); const got = w2.logins.slice(b).map((x) => x.id); assert.ok(got.length <= 1); if (got[0] && order[order.length - 1] !== got[0]) order.push(got[0]); pass(MIN); }
  assert.deepEqual(order.slice(0, 6), ['x0', 'x1', 'x2', 'x0', 'x1', 'x2']);
  g2._resetForTest(); bad.delete(name);

  // 기다리는 대상이 없는 지문(대상 하나)은 시한이 지나도 같은 대상이 이어서 한다(쉬는 구간 없음)
  const g3 = unreadGuard(name);
  const one = devs(1, 'solo', 'u', 'p');
  const w3 = world(g3, one, () => 'none');
  for (let i = 0; i < 35; i += 1) { assert.equal(w3.run(), 1, `주기 ${i + 1}`); pass(MIN); }
  g3._resetForTest(); bad.delete(name);
}));

/* ── ② 자격이 맞는 경우 ─────────────────────────────────────────────────── */
test('② 맞는 자격증명 — 첫 주기 탐침 1대 · 다음 주기부터 전 대상 수집(119: 파일이 읽힐 때까지 0대)', () => quiet(async () => {
  for (const N of [28, 2048]) {
    const name = `p2-${N}-auth-stops.json`;
    const list = devs(N, 'vc', 'svc@corp', 'right');
    const g = unreadGuard(name);
    const w = world(g, list, () => 'ok');
    assert.equal(w.run(), 1);
    pass(MIN);
    assert.equal(w.run(), N, '둘째 주기 — 전 대상');
    pass(20 * MIN);
    assert.equal(w.run(), N, '시한이 지나도 그대로');
    assert.equal(g.unreadable()?.code, 'EACCES', '창은 아직 열려 있다(파일은 여전히 못 읽는다)');
    assert.equal(raw(name), '{}', '원본 그대로');
    g._resetForTest(); bad.delete(name);
  }
  // 통과한 지문에서도 거부는 그 대상만 멈춘다(대상마다 계정이 따로인 장비 — 지문을 뒤집지 않는다)
  const name = 'p2b-auth-stops.json';
  const list = devs(10, 'idrac', 'root', 'calvin');
  const g = unreadGuard(name);
  const w = world(g, list, (d) => (d.id === 'idrac7' ? 'reject' : 'ok'));
  w.run(); pass(MIN); w.run(); pass(MIN);
  assert.equal(w.run(), 9, '거부된 한 대만 빠진다');
  assert.equal(rejects(w), 1);
  assert.equal(g.authStopFor(list[7]).attempts, 1);
  assert.equal(g.authStopFor({ id: 'idrac-new', username: 'root', password: 'calvin' }), null, '통과가 확인된 지문은 한 대상의 거부로 닫히지 않는다(아직 묻지 않은 대상도 평소처럼)');
  g._resetForTest(); bad.delete(name);
}));

/* ── ③ 지문이 여럿 섞인 경우 ────────────────────────────────────────────── */
test('③ 지문이 섞임 — 지문마다 따로 탐침한다(틀린 공용 계정 1회 · 맞는 공용 계정은 다음 주기 전부 · 대상마다 계정이 다른 것은 대상당 1회)', () => quiet(async () => {
  const name = 'p3-auth-stops.json';
  const A = devs(10, 'a', 'svc-a', 'wrong');
  const B = devs(10, 'b', 'svc-b', 'right');
  const C = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, username: `local${i}`, password: i < 3 ? 'right' : 'wrong' }));
  const E = [{ id: 'e0' }, { id: 'e1', username: '', password: '' }];   // 자격이 없는 대상 — 지문을 만들 수 없다
  const g = unreadGuard(name);
  const w = world(g, [...A, ...B, ...C, ...E], (d) => (d.password === 'right' ? 'ok' : 'reject'));
  assert.equal(w.run(), 1 + 1 + 5, '첫 주기 — 공용 지문 둘에 하나씩 + 지문이 따로인 다섯');
  assert.equal(rejects(w), 1 + 2);
  pass(MIN);
  assert.equal(w.run(), 10 + 3, '둘째 주기 — 맞는 공용 계정 전부 + 통과한 개별 계정');
  pass(MIN); w.run();
  assert.equal(rejects(w), 3, '거부는 지문당 한 번에서 늘지 않는다');
  for (const d of E) {
    const s = g.authStopFor(d);
    assert.equal(s?.unread, true, '지문을 만들 수 없는 대상은 119회차 그대로 정지');
    assert.match(s.reason, /주기 수집을 건너뜁니다/);
  }
  g._resetForTest(); bad.delete(name);
}));

/* ── ④ 못 읽는 동안 자격을 고친 경우 ────────────────────────────────────── */
test('④ 못 읽는 동안 자격증명을 고치면 한 대상으로 다시 확인하고 통하면 전부 재개 — 119 · 124 는 파일이 읽힐 때까지 정지였다', () => quiet(async () => {
  const name = 'p4-auth-stops.json';
  const N = 28;
  let pw = 'wrong';
  const list = () => devs(N, 'vc', 'svc', pw);
  const g = unreadGuard(name);
  const login = (cur) => {
    const go = cur.filter((d) => !g.authStopFor(d));
    for (const d of go) { if (d.password === 'right') g.clearAuthStop(d.id); else g.markAuthStopped(d.id, d, 'HTTP 401 Unauthorized'); }
    return go.length;
  };
  assert.equal(login(list()), 1);
  pass(MIN); assert.equal(login(list()), 0);
  pw = 'still-wrong';                          // 또 틀린 값으로 고침 — 한 번만 더
  pass(MIN); assert.equal(login(list()), 1, '새 자격증명(새 지문)은 한 대상으로 확인한다');
  pass(MIN); assert.equal(login(list()), 0);
  pw = 'right';                                // 맞게 고침
  pass(MIN); assert.equal(login(list()), 1);
  pass(MIN); assert.equal(login(list()), N, '통과하면 다음 주기부터 전부');
  g._resetForTest(); bad.delete(name);

  // 장비 쪽에서 고친 경우(포탈 값은 그대로 — 지문이 같다): 거부됐던 대상의 수동 성공이 지문을 '모름' 으로 되돌리고, 다음 주기 한 대상이 확인한다
  const g2 = unreadGuard(name);
  let accept = false;
  const same = devs(N, 'vc', 'svc', 'pw');
  const w = world(g2, same, () => (accept ? 'ok' : 'reject'));
  assert.equal(w.run(), 1);
  accept = true;
  assert.equal(g2.clearAuthStop('vc0'), true, '연결 시험 성공 — 그 대상의 정지를 풀었다');
  pass(MIN);
  assert.equal(w.run(), 2, '풀린 대상 + 탐침 하나(바로 전부 열지 않는다 — 그 성공이 어느 자격증명으로 된 것인지 이 호출은 모른다)');
  pass(MIN);
  assert.equal(w.run(), N);
  g2._resetForTest(); bad.delete(name);

  // 기다리던 대상의 수동 성공은 그 대상만 푼다(124회차 A2 그대로 — true)
  const g3 = unreadGuard(name);
  const w3 = world(g3, same, () => 'none');
  w3.run();
  assert.ok(g3.authStopFor(same[5]));
  assert.equal(g3.clearAuthStop('vc5'), true);
  assert.equal(g3.authStopFor(same[5]), null);
  assert.equal(g3.clearAuthStop('vc5'), false, '이미 풀린 대상');
  assert.ok(g3.authStopFor(same[6]), '다른 대상은 여전히 탐침을 기다린다');
  g3._resetForTest(); bad.delete(name);
}));

/* ── ⑤ 파일이 읽힌 뒤 합치기 ────────────────────────────────────────────── */
test('⑤ 파일이 읽히면 탐침 상태를 버리고 119 · 124 의 합치기 규칙대로 — 파일의 기록 + 창 안의 기록 · 해제', () => quiet(async () => {
  const name = 'p5-auth-stops.json';
  const A = devs(6, 'a', 'svc', 'wrong');
  const B = devs(4, 'b', 'ok', 'right');
  const orig = { a3: { credHash: AG.credHashOf(A[3]), since: 1_700_000_000_000, at: 1_700_000_000_500, attempts: 4, reason: '인증 실패(401)' },
    b2: { credHash: AG.credHashOf(B[2]), since: 5, at: 6, attempts: 1, reason: '인증 실패' } };
  const g = unreadGuard(name, orig);
  const w = world(g, [...A, ...B], (d) => (d.password === 'right' ? 'ok' : 'reject'));
  w.run(); pass(MIN); w.run();
  assert.deepEqual(w.logins.map((x) => x.id), ['a0', 'b0', 'b0', 'b1', 'b2', 'b3']);
  assert.equal(AG.unreadableAuthGuards().find((x) => x.file === name)?.code, 'EACCES');

  bad.delete(name); pass();
  assert.equal(g.unreadable(), null);
  assert.equal(AG.unreadableAuthGuards().some((x) => x.file === name), false);
  const file = JSON.parse(raw(name));
  assert.deepEqual(Object.keys(file).sort(), ['a0', 'a3'], '창 안의 거부(a0)를 합치고 창 안에서 성공한 대상(b2)의 옛 기록을 지운다');
  assert.equal(file.a3.attempts, 4, '파일의 기록은 그대로');
  assert.equal(g.authStopFor(A[3]).attempts, 4);
  assert.equal(g.authStopFor(A[0]).attempts, 1);
  // 탐침 상태는 버렸다 — 파일에 기록이 없는 대상은 평소처럼 정지 아님(같은 지문이 창 안에서 거부됐어도)
  assert.equal(g.authStopFor(A[1]), null);
  assert.equal(g.peekAuthStop(A[2]), null);
  g._resetForTest();
}));

/* ── ⑥ 병렬로 동시에 물을 때 ────────────────────────────────────────────── */
test('⑥ 병렬(poolRun)로 동시에 물어도 한 지문에 탐침은 하나다', () => quiet(async () => {
  const name = 'p6-auth-stops.json';
  const list = devs(200, 'vc', 'svc', 'wrong');
  const g = unreadGuard(name);
  let logins = 0; let inFlight = 0; let maxFlight = 0;
  const tick = () => new Promise((r) => setImmediate(r));
  const collect = async (d) => {
    await tick();
    if (g.authStopFor(d)) return;
    logins += 1; inFlight += 1; maxFlight = Math.max(maxFlight, inFlight);
    await tick(); await tick();                       // 로그인 응답을 기다리는 동안 다른 대상들이 묻는다
    g.markAuthStopped(d.id, d, 'HTTP 401 Unauthorized');
    inFlight -= 1;
  };
  await poolRun(list, 16, collect);
  await Promise.all(list.map((d) => collect(d)));      // 풀 없이 한꺼번에
  assert.equal(logins, 1);
  assert.equal(maxFlight, 1);
  g._resetForTest(); bad.delete(name);
}));

/* ── ⑦ peekAuthStop 은 탐침을 주지 않는다 ───────────────────────────────── */
test('⑦ peekAuthStop 은 보기만 한다 — 탐침을 주지도 옮기지도 않고, 주인의 판정(탐침 대상 · 통과 · 거부)을 지문으로 따라간다', () => quiet(async () => {
  const name = 'p7-auth-stops.json';
  const [x, y, z] = devs(3, 'vc', 'svc', 'pw');
  const g = unreadGuard(name);
  for (let i = 0; i < 50; i += 1) for (const d of [x, y, z]) assert.equal(g.peekAuthStop(d)?.unread, true, '탐침 전 — 보기만 하는 조회는 정지로 답한다(전 대상이 따로 로그인하지 않게)');
  assert.match(g.peekAuthStop(x).reason, /같은 자격증명을 쓰는 대상 하나로 먼저 로그인을 확인/);
  assert.equal(g.authStopFor(y), null, 'peek 를 아무리 불러도 탐침은 남아 있다 — 처음 authStopFor 로 묻는 대상이 받는다');
  assert.equal(g.peekAuthStop(y), null, '탐침 대상은 보조 수집기에도 정지 아님(평소의 기록 없는 대상과 같다)');
  assert.equal(g.peekAuthStop(x)?.unread, true);
  // 시한이 지나도 peek 는 탐침을 옮기지 않는다
  pass(TTL + MIN);
  assert.equal(g.peekAuthStop(x)?.unread, true);
  assert.equal(g.peekAuthStop(z)?.unread, true);
  assert.equal(g.authStopFor(y), null, '기다린다고 authStopFor 로 물은 대상이 없었다 — 같은 대상이 이어서');
  assert.equal(g.authStopFor(x)?.unread, true);        // 이제 기다리는 대상이 있다
  pass(TTL + MIN);
  assert.equal(g.peekAuthStop(x)?.unread, true, 'peek 는 넘겨받지 않는다');
  assert.equal(g.authStopFor(x), null, 'authStopFor 가 넘겨받는다');
  assert.equal(g.peekAuthStop(y)?.unread, true, '앞 탐침 대상은 이제 기다린다');
  // 판정이 나면 따라간다
  g.clearAuthStop('vc0');
  for (const d of [x, y, z]) assert.equal(g.peekAuthStop(d), null);
  // 창 안의 기록이 다른 자격증명의 것이면(주인이 아직 다시 묻기 전) peek 는 지우지 않고 새 지문의 판정을 따른다
  const q = { id: 'q', username: 'other', password: 'bad' };
  g.markAuthStopped('q', q, 'HTTP 401');
  const q2 = { ...q, password: 'fixed' };
  assert.equal(g.peekAuthStop(q2)?.unread, true);
  assert.equal(g.peekAuthStop(q).attempts, 1, '기록은 그대로다(peek 는 지우지 않는다)');
  g._resetForTest(); bad.delete(name);
}));

/* ── ⑧ 메일 가드(대상 1 · 지문 1) ───────────────────────────────────────── */
const smtp = { auth: 'ok', auths: 0, mails: 0 };
const smtpSrv = net.createServer((s) => {
  s.on('error', () => {});
  s.write('220 fake ESMTP\r\n');
  let buf = ''; let inData = false;
  s.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (inData) { if (line === '.') { inData = false; smtp.mails += 1; s.write('250 queued\r\n'); } continue; }
      if (/^EHLO/i.test(line)) s.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (/^AUTH/i.test(line)) { smtp.auths += 1; s.write(smtp.auth === 'ok' ? '235 2.7.0 ok\r\n' : '535 5.7.8 Authentication credentials invalid\r\n'); }
      else if (/^DATA/i.test(line)) { inData = true; s.write('354 go\r\n'); }
      else if (/^QUIT/i.test(line)) { s.write('221 bye\r\n'); s.end(); }
      else s.write('250 ok\r\n');
    }
  });
});
await new Promise((r) => smtpSrv.listen(0, '127.0.0.1', r));
closers.push(() => new Promise((r) => smtpSrv.close(r)));

test('⑧ 메일 가드 — 못 읽는 동안에도 자동 메일은 한 번 시도한다: 통하면 계속 보내고(119: 전부 건너뜀), 거부되면 그 한 번으로 멈춘다(별도 예외 없음)', () => quiet(async () => {
  put('mail.json', { enabled: true, smtp: { host: '127.0.0.1', port: smtpSrv.address().port, secure: false, startTls: false, user: 'alert@corp.example', password: 'pw', from: 'a@corp.example', timeoutMs: 5000 }, defaultTo: ['ops@corp.example'], rateLimitPerHour: 0 });
  const M = await import('../src/mail/service.js');
  const name = 'mail-auth-stops.json';
  const logs = [];
  const realLog = console.log; console.log = (...a) => logs.push(a.join(' '));
  try {
    // (a) 자격이 맞다 — 자동 메일 3통이 전부 나간다
    M.mailAuthGuard._resetForTest(); put(name, {}); bad.set(name, 'EACCES');
    Object.assign(smtp, { auth: 'ok', auths: 0, mails: 0 });
    assert.equal(M.mailStatus().authStopped?.unread, true, '첫 발송 전 — 상태 조회(peek)는 아직 확인 전이라고 말한다');
    const ok = await Promise.all([1, 2, 3].map((i) => M.sendPortalMail({ kind: 'alert', subject: `장애 알림 ${i}`, text: 'x' })));
    assert.deepEqual(ok.map((r) => r.ok), [true, true, true], JSON.stringify(ok));
    assert.equal(smtp.mails, 3);
    assert.equal(M.mailStatus().authStopped, null);
    assert.equal(logs.some((l) => /SMTP 인증 실패 정지를 풀었습니다/.test(l)), false, '정지로 답한 적이 없는 발송 성공을 "정지를 풀었다" 고 적지 않는다');
    assert.equal(raw(name), '{}', '원본 그대로');

    // (b) 자격이 틀리다 — 로그인 1회로 멈추고 나머지는 실제 인증 정지 문구로 건너뛴다
    M.mailAuthGuard._resetForTest(); put(name, {}); bad.set(name, 'EACCES');
    Object.assign(smtp, { auth: 'bad', auths: 0, mails: 0 });
    const rs = await Promise.all([1, 2, 3, 4].map((i) => M.sendPortalMail({ kind: 'alert', subject: `장애 알림 ${i}`, text: 'x' })));
    assert.equal(smtp.auths, 1, '틀린 계정으로의 로그인은 한 번');
    assert.equal(rs[0].ok, false); assert.equal(rs[0].skipped, undefined);
    assert.equal(rs[0].authStopped?.attempts, 1);
    for (const r of rs.slice(1)) {
      assert.equal(r.skipped, true);
      assert.equal(r.authStopped?.attempts, 1);
      assert.match(r.reason, /SMTP 인증 실패로 자동 발송을 멈춘 상태라 보내지 않았습니다\(1회 거부\)/, '이번에는 실제 인증 실패다 — 그렇게 말한다');
    }
    pass(TTL + MIN);
    assert.equal((await M.sendPortalMail({ kind: 'alert', subject: '뒤', text: 'x' })).skipped, true, '시한이 지나도 다시 로그인하지 않는다');
    assert.equal(smtp.auths, 1);
    // 읽히면 창 안의 거부가 파일에 합쳐진다
    bad.delete(name); pass();
    assert.equal(M.mailStatus().authStopped?.attempts, 1);
    assert.deepEqual(Object.keys(JSON.parse(raw(name))), ['smtp']);
  } finally { console.log = realLog; M.mailAuthGuard._resetForTest(); bad.delete(name); }
}));

/* ── ⑫ 소비처 ───────────────────────────────────────────────────────────── */
test('⑫ 소비처 — 못 읽음 정지는 사람이 누른 실행(Veeam 백업 실행 · 집중 모니터링 시험)을 막지 않고, 실제 거부는 예전처럼 막는다', () => quiet(async () => {
  const VP = await import('../src/veeam/poller.js');
  const D = await import('../src/veeam/run/dispatch.js');
  const vname = 'veeam-auth-stops.json';
  VP.authGuard._resetForTest(); put(vname, {}); bad.set(vname, 'EACCES');
  const s1 = { id: 'vbr1', name: 'VBR-1', host: '10.0.0.1', port: 9419, username: 'svc', password: 'pw' };
  const s2 = { ...s1, id: 'vbr2', name: 'VBR-2', host: '10.0.0.2' };
  const s3 = { ...s1, id: 'vbr3', name: 'VBR-3', host: '10.0.0.3' };
  assert.equal(VP.authGuard.authStopFor(s1), null);                      // 주기 수집이 s1 로 탐침 중
  assert.equal(VP.authGuard.peekAuthStop(s2)?.unread, true);             // s2 의 주기 수집은 판정을 기다린다
  assert.equal(D.authStopOf(s2), null, '사람이 누른 백업 실행 · 조회는 못 읽음 정지에 막히지 않는다(124회차 실측: 보내지 않았다)');
  VP.authGuard.markAuthStopped('vbr2', s2, 'HTTP 401 Unauthorized');     // 그 실행이 거부됐다(dispatchOp 이 기록한다)
  assert.equal(D.authStopOf(s2)?.reason, 'HTTP 401 Unauthorized', '이 서버에서 실제로 거부되면 그때부터 보내지 않는다(서버당 거부 1회)');
  assert.equal(VP.authGuard.peekAuthStop(s3)?.unread, true);             // 같은 자격증명이 거부됐다 — s3 의 주기 수집은 멈춘다
  assert.equal(D.authStopOf(s3), null, '다른 서버의 거부는 이 서버에서 확인된 인증 실패가 아니다');
  VP.authGuard._resetForTest(); bad.delete(vname);
  const worker = stripComments(realRead.call(fs, path.join(SRC, 'agent/veeamRunWorker.js'), 'utf8'));
  assert.match(worker, /if \(stop && !isUnreadStop\(stop\)\) return sanitize\(/, '엣지 워커도 같은 규칙');
  const disp = stripComments(realRead.call(fs, path.join(SRC, 'veeam/run/dispatch.js'), 'utf8'));
  assert.equal((disp.match(/!isUnreadStop\(st\)/g) || []).length, 2, '중앙 직접 · 엣지가 올린 정지 표지 둘 다');
  // 엣지가 올린 못 읽음 표지는 중앙 정제를 지난다
  assert.match(stripComments(realRead.call(fs, path.join(SRC, 'veeam/parse.js'), 'utf8')), /r\.authStop\.unread === true \? \{ unread: true \} : \{\}/);

  // 집중 모니터링 연결 시험(사람이 누른 것 — peek 로 막던 경로)
  const FC = await import('../src/focusmon/collector.js');
  const fname = 'focusmon-auth-stops.json';
  FC.focusAuthGuard._resetForTest(); put(fname, {}); bad.set(fname, 'EACCES');
  const keys = { keyInfo: () => ({ fingerprint: 'SHA256:test' }), privateKeyForConnect: () => 'PEM' };
  const target = { id: 'f1', host: '10.9.9.9', port: 22, username: 'mon' };
  let calls = 0;
  const r = await FC.testTarget(target, { keys, connect: async () => { calls += 1; throw new Error('connect ECONNREFUSED 10.9.9.9:22'); }, timeoutMs: 2_000 });
  assert.equal(calls, 1, '한 번 시도한다');
  assert.notEqual(r.kind, 'auth-stopped', JSON.stringify(r));
  const fdev = FC.authDevOf(target, 'SHA256:test');
  FC.focusAuthGuard.markAuthStopped(fdev.id, fdev, '키 로그인 거부');
  const r2 = await FC.testTarget(target, { keys, connect: async () => { calls += 1; return null; }, timeoutMs: 2_000 });
  assert.equal(r2.kind, 'auth-stopped', '실제로 거부된 대상은 시험도 하지 않는다(예전과 같다)');
  assert.equal(calls, 1);
  FC.focusAuthGuard._resetForTest(); bad.delete(fname);
}));

test('⑫ 소비처 — vCenter 주문형 조회 본문 · 자기 문장을 만들던 곳이 못 읽음 정지를 "인증 실패(0회) · 비밀번호를 고치면 재개" 라고 말하지 않는다', () => quiet(async () => {
  const G = await import('../src/vcenter/authStopGate.js');
  const RC = await import('../src/vcenter/restClient.js');
  const cname = 'vcenter-auth-stops.json';
  RC.vcAuthGuard._resetForTest(); put(cname, {}); bad.set(cname, 'EACCES');
  const vc1 = { id: 'vc1', host: 'vc1.corp.example', username: 'svc@vsphere.local', password: 'pw' };
  const vc2 = { ...vc1, id: 'vc2', host: 'vc2.corp.example' };
  assert.equal(RC.vcAuthGuard.authStopFor(vc1), null);
  const info = G.vcAuthStopOf(vc2);
  assert.equal(info.authStopped, true); assert.equal(info.unread, true); assert.equal(info.attempts, 0);
  assert.doesNotMatch(info.reason, /실패 0회|vCenter 인증 실패로 멈춰|비밀번호를 고치거나/, info.reason);
  assert.match(info.reason, /vcenter-auth-stops\.json.*읽기 오류\(EACCES\)/);
  assert.deepEqual(Object.keys(G.authStopView(info)).sort(), ['at', 'attempts', 'reason', 'since', 'unread']);
  assert.equal(G.vcAuthStopOf(vc1), null, '탐침 대상은 주문형 조회도 평소처럼');
  RC.vcAuthGuard.markAuthStopped('vc2', vc2, 'HTTP 401');
  const real = G.vcAuthStopOf(vc2);
  assert.equal(real.reason, G.authStoppedReason(1), '실제 인증 정지는 예전 문장 그대로');
  assert.deepEqual(Object.keys(G.authStopView(real)).sort(), ['at', 'attempts', 'reason', 'since']);
  RC.vcAuthGuard._resetForTest(); bad.delete(cname);

  // 자기 문장을 만들던 소비처(124회차가 남긴 8곳 + osScanner + authStopGate)는 공용 authStopText 를 지난다 · view 사본은 공용 authStopView 로
  const code = (rel) => stripComments(realRead.call(fs, path.join(SRC, rel), 'utf8'));
  const SITES = { 'bmstor/poller.js': 1, 'bmusage/poller.js': 3, 'isidu/collect.js': 1, 'gpu/physicalPoller.js': 1, 'vmclone/runner.js': 1, 'security/guestScanScheduler.js': 2, 'inventory/osScanner.js': 1, 'vcenter/authStopGate.js': 1 };
  for (const [rel, n] of Object.entries(SITES)) assert.equal((code(rel).match(/authStopText\(/g) || []).length, n, rel);
  for (const rel of ['bmstor/poller.js', 'sanswitch/poller.js', 'idrac/poller.js', 'pdu/poller.js', 'gpu/sshCollect.js', 'nsx/store.js', 'vcenter/authStopGate.js']) {
    assert.doesNotMatch(code(rel), /attempts: (?:rec|info)\.attempts, reason: (?:rec|info)\.reason \}/, `${rel} — 못 읽음 표지를 떨구는 view 사본`);
  }
}));

/* ── ⑨ 성공이 아닌 정리는 지문을 열지 않는다 ─────────────────────────────── */
test('⑨ 성공이 아닌 정리(verified:false — 삭제 · 접속처 변경 · 시도 없는 해제)는 그 대상만 풀고 지문은 열지 않는다', () => quiet(async () => {
  const name = 'p9-auth-stops.json';
  const list = devs(28, 'srv', 'svc', 'wrong');
  const g = unreadGuard(name);
  assert.equal(g.authStopFor(list[0]), null);                                   // 탐침 대상
  assert.equal(g.clearAuthStop('srv0', { verified: false }), false, '탐침 대상은 정지로 답한 적이 없다');   // 그 대상이 지워졌다(로그인 성공이 아니다)
  const w = world(g, list.slice(1), () => 'reject');
  assert.equal(w.run(), 1, '지문은 열리지 않았다 — 다음 대상 하나가 탐침을 이어받는다(verified:true 였다면 27대가 한꺼번에 로그인했다)');
  pass(MIN); assert.equal(w.run(), 0);
  g._resetForTest(); bad.delete(name);

  // 대조: 탐침 대상의 성공(기본값)은 지문을 연다 — 늦게 와도(탐침이 다른 대상으로 넘어간 뒤) · 그사이 다른 대상이 거부됐어도
  const g2 = unreadGuard(name);
  assert.equal(g2.authStopFor(list[0]), null);
  assert.ok(g2.authStopFor(list[1]));
  pass(TTL + MIN);
  assert.equal(g2.authStopFor(list[1]), null, '탐침이 넘어갔다');
  g2.markAuthStopped('srv1', list[1], 'HTTP 401');                                // 둘째는 거부(그 장비만의 사정)
  assert.equal(g2.authStopFor(list[2])?.unread, true);
  g2.clearAuthStop('srv0');                                                       // 첫 탐침의 긴 수집이 이제 끝났다(성공)
  assert.equal(g2.authStopFor(list[2]), null, '그 지문은 통한다 — 나머지는 대상마다 평소처럼');
  assert.equal(g2.authStopFor(list[1]).attempts, 1, '거부된 대상은 그대로 멈춰 있다');
  g2._resetForTest(); bad.delete(name);
}));

test('⑨ 호출부 분류표 — clearAuthStop 호출이 늘거나 줄면 성공 신호인지 정리인지 다시 가른다', () => {
  // [전체 호출 수, 그중 verified:false 수]. 성공 신호 = 저장된 자격증명으로 로그인이 통한 직후. 정리 = 삭제 · 접속처 변경 · 낡은 기록 · 시도 없이 사람이 누른 해제.
  const TABLE = {
    'agent/bareosConfigPull.js': [1, 1], 'agent/veeamConfigPull.js': [2, 2], 'bareos/autoSetup.js': [2, 1], 'bareos/edgeSetup.js': [1, 1], 'bareos/service.js': [2, 0],
    'bmstor/poller.js': [1, 0], 'bmusage/poller.js': [5, 0], 'cvp/poller.js': [3, 0], 'diskbad/scan.js': [1, 0], 'focusmon/audit/prep.js': [1, 1], 'focusmon/audit/runner.js': [1, 0],
    'focusmon/collector.js': [3, 1], 'focusmon/runner.js': [1, 1], 'gpu/physicalPoller.js': [1, 0], 'gpu/poller.js': [1, 0], 'horizon/sessionPoller.js': [2, 1], 'idrac/poller.js': [2, 0],
    'idrac/scanAuth.js': [1, 0], 'inventory/osScanner.js': [2, 0], 'isidu/collect.js': [2, 0], 'mail/service.js': [1, 0], 'net/monitor.js': [3, 2], 'nsx/registry.js': [1, 0], 'nsx/store.js': [1, 0],
    'pdu/poller.js': [1, 0], 'routes/admin/gpuGuest.js': [2, 0], 'routes/admin/veeam.js': [4, 3], 'routes/admin/veeamEm.js': [3, 2], 'routes/api/bareosBackup.js': [2, 1],
    'sanswitch/flowJobs.js': [1, 0], 'sanswitch/poller.js': [1, 0], 'security/guestScanScheduler.js': [3, 0], 'storage/authGuard.js': [1, 0], 'storage/inspect/runner.js': [1, 0],
    'storage/nodeLoadPoller.js': [1, 0], 'storage/poller.js': [1, 0], 'store.js': [1, 0], 'vcenter/registry.js': [1, 0], 'veeam/em/poller.js': [1, 0], 'veeam/poller.js': [1, 0],
  };
  const walk = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p); } return out; };
  const got = {};
  for (const f of walk(SRC)) {
    const rel = path.relative(SRC, f).split(path.sep).join('/');
    if (rel === 'util/authGuard.js') continue;
    const code = stripComments(realRead.call(fs, f, 'utf8'));
    // 호출만 센다 — 정의(export const clearAuthStop = …) · 옵션 객체의 키(clearAuthStop: () => …) · 다른 이름(clearAuthStopIfSame)은 빼고
    const calls = [...code.matchAll(/(?<![\w$])(?:[\w$.?]+\.)?clearAuthStop\(([^;\n]*)/g)].filter((m) => !/(?:function|const|let)\s+$/.test(code.slice(Math.max(0, m.index - 12), m.index)));
    if (!calls.length) continue;
    got[rel] = [calls.length, calls.filter((m) => /verified:\s*false/.test(m[1])).length];
  }
  assert.deepEqual(got, TABLE);
});

/* ── ⑩ 보이게 하기 ──────────────────────────────────────────────────────── */
test('⑩ 못 읽는 가드는 등록부 · 서비스 점검 한 행 · 엣지 로그 표로 보인다(파일 이름은 기본 이름만 · 대상 id 없음)', () => quiet(async () => {
  const a = unreadGuard('p10a-auth-stops.json');
  const b = unreadGuard('p10b-auth-stops.json');
  const c = AG.createAuthGuard({ file: 'p10c-auth-stops.json' }); c._resetForTest();
  assert.equal(AG.authGuardHealthRow().status, 'ok', '한 번도 못 읽은 적이 없으면(가드를 아직 쓰지 않았어도) 정상');
  const w = world(a, devs(5, 'vc-secret-', 'svc', 'wrong'), () => 'reject'); w.run();
  b.authStopFor({ id: 'only', username: 'u', password: 'p' });
  assert.equal(c.authStopFor({ id: 'z', username: 'u', password: 'p' }), null);   // 파일 없음 — 정상
  const list = AG.unreadableAuthGuards().filter((x) => x.file.startsWith('p10'));
  assert.deepEqual(list.map((x) => [x.file, x.code, x.probing, x.passed, x.rejected]), [['p10a-auth-stops.json', 'EACCES', 0, 0, 1], ['p10b-auth-stops.json', 'EACCES', 1, 0, 0]]);
  const row = AG.authGuardHealthRow();
  assert.equal(row.status, 'warn');
  assert.match(row.detail, /정지 기록 파일을 읽지 못하는 도구 2개\(p10a-auth-stops\.json\(EACCES\), p10b-auth-stops\.json\(EACCES\)\)/);
  assert.match(row.detail, /인증 실패가 확인된 것이 아닙니다/);
  assert.doesNotMatch(row.detail, /vc-secret-|only|`/);
  assert.doesNotMatch(JSON.stringify(row), new RegExp(TMP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '경로를 싣지 않는다');
  assert.equal(AG.authGuardFilesStatus().ok, false);
  // 풀리면 행도 정상으로
  bad.delete('p10a-auth-stops.json'); bad.delete('p10b-auth-stops.json'); pass();
  assert.equal(AG.authGuardHealthRow().status, 'ok', '서비스 점검이 물을 때 다시 읽는다(그 가드를 쓰는 폴러가 돌 때까지 남지 않는다)');
  for (const g of [a, b, c]) g._resetForTest();
  // 소스 표지: 서비스 점검 행 · 엣지 로그 표
  const svc = stripComments(realRead.call(fs, path.join(SRC, 'health/services.js'), 'utf8'));
  assert.match(svc, /wrap\('auth-stops', '인증 정지 기록 파일', \(\) => authGuardHealthRow\(\)\)/);
  const { STATUS_SPEC } = await import('../src/edgelog/spec.js');
  const ent = STATUS_SPEC.find((s) => s.key === 'service.authStops');
  assert.deepEqual([ent?.group, ent?.mod, ent?.fn], ['service', '../util/authGuard.js', 'authGuardFilesStatus']);
}));

/* ── ⑪ 상한 · 공용 문구 ────────────────────────────────────────────────── */
test('⑪ 지문 수 상한을 넘으면 그 지문은 119회차 그대로 정지 · 공용 문구(authStopText)는 못 읽음 정지의 사유를 그대로 쓴다', () => quiet(async () => {
  const name = 'p11-auth-stops.json';
  const g = unreadGuard(name);
  for (let i = 0; i < 4096; i += 1) assert.equal(g.authStopFor({ id: `t${i}`, username: `u${i}`, password: 'p' }), null);
  const over = g.authStopFor({ id: 'over', username: 'one-more', password: 'p' });
  assert.equal(over?.unread, true);
  assert.match(over.reason, /주기 수집을 건너뜁니다/);
  const real = g.markAuthStopped('t0', { id: 't0', username: 'u0', password: 'p' }, 'HTTP 401');
  assert.equal(AG.authStopText(real, '인증 실패로 주기 수집 정지(1회) — 비밀번호를 고치면 자동 재개합니다'), '인증 실패로 주기 수집 정지(1회) — 비밀번호를 고치면 자동 재개합니다');
  assert.equal(AG.authStopText(over, '인증 실패로 주기 수집 정지(0회) — 비밀번호를 고치면 자동 재개합니다'), over.reason, '못 읽음 정지를 "인증 실패(0회) · 비밀번호를 고치면 재개" 라고 말하지 않는다');
  assert.equal(AG.authStopText(real, (s) => `거부 ${s.attempts}회`), '거부 1회');
  assert.equal(AG.authStopText(null, 'x'), 'x');
  g._resetForTest(); bad.delete(name);
}));
