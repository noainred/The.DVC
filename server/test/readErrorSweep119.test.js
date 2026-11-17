/**
 * readErrorSweep119.test.js — 전체 점검 119회차: '읽기 오류 ≠ 손상' 분류표의 마지막 잔여(97회차 표가 '다른 점검 범위(scope)' 로 미뤄 두고 아무도 확인하지 않은 것).
 *
 * 파일마다 지금 코드를 재현해 셋 중 하나로 확정했다 — ⓐ 이미 고쳐짐(분류표를 사실대로) ⓑ 결함(고침) ⓒ 결함 아님(사유).
 *   ⓑ F1 isidu/digest · F2 isidu/notify : 처리 기록(lastSlot · 마지막으로 보낸 조사 · 실패 알림 시각)을 읽기 오류에도 .corrupt 로 옮기고 새로 시작 → 같은 메일 재발송 · 기록 소실.
 *      F3 metrics/vmperfDb · vmseries/db 색인 : 읽기 오류 = 빈 색인 → 한 줄짜리로 덮음(다른 vCenter 의 역매핑 소실).
 *   결정(권장안 구현) D1 util/authGuard : 읽기 오류 = 빈 기록 → 정지돼 있던 대상에 자동 재로그인(계정 잠금 경로) + 다음 기록이 원본을 덮음.
 *                    D2 security/peerTrust : v2.732 는 읽기 실패에도 원본을 옮기고 빈 승인 목록 + enforce 를 그 자리에 썼다(일시 오류 한 번에 승인 목록이 재시작해도 돌아오지 않음).
 *   ⓒ auth/sessionState(읽기 오류 = 옮기지 않고 notBefore) · auth/auth(users.json — 19회차 A-4) 는 동작을 고정만 한다.
 * 읽기 오류는 root 컨테이너라 EACCES 대신 **EIO 주입**(그 파일 이름의 fs.readFileSync 만 — 파일은 그대로 있고 쓰기는 실제로 성공할 수 있는 상태)으로 재현한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'readErr119-'));
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_DIR: TMP, AUTH_ENABLED: 'true', DATA_SOURCE: 'live' });
for (const k of ['CENTRAL_URL', 'CENTRAL_TOKEN', 'SSH_HOSTKEY_POLICY', 'TLS_PEER_POLICY', 'VMPERF_DB_DIR', 'VMSERIES_DB_DIR']) delete process.env[k];
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const F = (n) => path.join(TMP, n);
const put = (n, v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); fs.writeFileSync(F(n), s); return s; };
const corruptOf = (n, dir = TMP) => fs.readdirSync(dir).filter((x) => x.startsWith(`${n}.corrupt.`));

// 시계: 실제 시각에서 정시 경계로 떨어뜨려 고정(재읽기 간격 판정 — util/jsonFileRead.js nowMs).
const RD = await import('../src/util/jsonFileRead.js');
let NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
RD._setJsonFileLoadClockForTest(() => NOW);
const pass = (ms = RD.READ_RETRY_MS + 1_000) => { NOW += ms; };

// EIO 주입(그 파일 이름만) — reads 는 그 이름을 실제로 읽으려 한 횟수.
const realRead = fs.readFileSync;
const eio = new Set();
const reads = new Map();
fs.readFileSync = (f, ...a) => {
  const b = path.basename(String(f));
  if (eio.has(b)) { reads.set(b, (reads.get(b) || 0) + 1); const e = new Error('EIO: i/o error, read'); e.code = 'EIO'; throw e; }
  return realRead.call(fs, f, ...a);
};
const raw = (n, dir = TMP) => realRead.call(fs, path.join(dir, n), 'utf8');
const closers = [];
after(async () => {
  fs.readFileSync = realRead; RD._setJsonFileLoadClockForTest();
  for (const c of closers.reverse()) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});
const quiet = async (fn) => { const w = console.warn; const e = console.error; console.warn = () => {}; console.error = () => {}; try { return await fn(); } finally { console.warn = w; console.error = e; } };

/* ── F1 아이실론 종합 메일 처리 기록 ─────────────────────────────────────── */
test('F1 isidu/digest: 처리 기록 읽기 오류 — 원본 유지 · 보존본 없음 · 정기 발송 멈춤 · 기록을 쓰지 않음 · 읽히면 그 기록으로', () => quiet(async () => {
  const M = await import('../src/isidu/digest.js');
  const name = 'isidu-digest-state.json';
  const orig = put(name, { lastSlot: 1_700_000_000_000, lastSentAt: 1_700_000_001_000, lastScanMark: 5, history: [{ at: 1, state: 'sent' }] });
  M._resetForTest();
  assert.equal(M.isiduDigestStatus().lastSlot, 1_700_000_000_000);
  M._resetForTest();
  eio.add(name);
  assert.equal(M.isiduDigestStatus().lastSlot, null, '못 읽은 동안은 빈 기록(캐시하지 않는다)');
  const t = await M.digestTick(NOW);
  assert.equal(t.action, 'unreadable', '마지막 회차를 모르는 채 회차를 판정하지 않는다(같은 메일 재발송)');
  assert.equal(t.readError, true);
  assert.match(t.reason, /읽기 오류\(EIO\).*원본은 그대로/);
  // '지금 보내기' 는 막지 않지만(받는 사람 없음 → 생략 기록) 그 기록을 원본 위에 쓰지 않는다.
  const r = await M.sendDigestNow('adm', NOW);
  assert.equal(r.ok, false);
  assert.equal(raw(name), orig, '못 읽은 처리 기록 위에 쓰지 않는다');
  assert.deepEqual(corruptOf(name), [], '읽기 오류는 손상이 아니다 — 보존본을 만들지 않는다');
  eio.delete(name);
  assert.equal(M.isiduDigestStatus().lastSlot, null, '간격(30초) 안에는 디스크를 다시 보지 않는다');
  pass();
  const st = M.isiduDigestStatus();
  assert.equal(st.lastSlot, 1_700_000_000_000, '읽히면 원래 기록(재시작 없이)');
  assert.equal(st.history.length, 1);
  assert.notEqual((await M.digestTick(NOW)).action, 'unreadable');
  // 손상은 예전과 같다(보존 + 새로 시작)
  put(name, '{깨짐'); M._resetForTest();
  assert.equal(M.isiduDigestStatus().lastSlot, null);
  assert.equal(corruptOf(name).length, 1);
  M._resetForTest();
}));

/* ── F2 아이실론 대상별 메일 기록 ─────────────────────────────────────────── */
test('F2 isidu/notify: 대상별 기록 읽기 오류 — 원본 유지 · 자동 발송(조사 결과 · 정기 틱) 멈춤 · 지금 보내기는 기록을 덮지 않음 · 읽히면 돌아온다', () => quiet(async () => {
  const G = 1024 ** 3;
  put('isidu-settings.json', { timeoutDefaultMin: 120, retentionDays: 400, mail: { commonTo: [] },
    targets: [{ id: 'tscan', label: '조사마다', host: '10.0.0.10', username: 'admin', path: '/ifs/data/users', topN: 2, mail: { to: ['scan@corp.local'], excludeCommon: true } }] });
  const S = await import('../src/isidu/settings.js'); S.invalidate?.();
  const db = await import('../src/isidu/db.js');
  closers.push(() => db._closeForTest?.());
  const ts = NOW - 3_600_000;
  const ins = await db.insertScan({ agent: '', node: '', targetId: 'tscan', ts, ok: true, path: '/ifs/data/users', host: '10.0.0.10', sizeMode: 'h', durationMs: 1000, trig: 'schedule',
    total: { bytes: 2 * G, res: G / 10 }, sumBytes: 2 * G, sumRes: G / 10, count: 1, skipped: 0, errLines: 0, entries: [{ name: 'u', bytes: 2 * G, res: G / 10 }] });
  assert.ok(ins?.ok, JSON.stringify(ins));
  const N = await import('../src/isidu/notify.js');
  const name = 'isidu-mail-state.json';
  const orig = put(name, { targets: { tscan: { lastScanId: 7, lastScanTs: ts - 1, lastFailAlertAt: NOW - 60_000, last: { at: 1, kind: 'result', state: 'sent' } } } });
  N._resetForTest();
  assert.equal(N.isiduMailStateOf('tscan')?.state, 'sent');
  N._resetForTest();
  eio.add(name);
  assert.equal(N.isiduMailStateOf('tscan')?.code, 'state-unreadable', '124회차: 멈춘 사실을 대상의 메일 상태로 말한다(예전에는 null — 기록 없음으로 보였다)');
  assert.equal(N.isiduMailStateReadError(), 'EIO');
  // 실패한 조사 — 예전에는 실패 알림 간격(lastFailAlertAt)을 잃은 채 판정하고 기록을 새 파일로 썼다.
  assert.deepEqual(await N.notifyScanStored({ targetId: 'tscan', scanId: 99, ok: false, ts: NOW }), { state: 'state-unreadable' });
  assert.deepEqual(await N.targetMailTick(NOW), { action: 'unreadable', readError: true });
  // 지금 보내기(사람) — 보내기는 시도하지만(메일 꺼짐 → 생략) 그 기록을 원본 위에 쓰지 않는다.
  const man = await N.sendLatestNow('tscan', 'adm');
  assert.equal(man.state, 'skipped', JSON.stringify(man));
  assert.equal(raw(name), orig, '못 읽은 기록 위에 쓰지 않는다');
  assert.deepEqual(corruptOf(name), []);
  eio.delete(name); pass();
  assert.equal(N.isiduMailStateReadError(), '');
  assert.equal(N.isiduMailStateOf('tscan')?.state, 'sent', '읽히면 원래 기록');
  assert.equal((await N.targetMailTick(NOW)).action, 'tick');
  put(name, '{깨짐'); N._resetForTest();
  assert.equal(N.isiduMailStateOf('tscan'), null);
  assert.equal(corruptOf(name).length, 1, '손상은 예전처럼 보존');
  N._resetForTest();
}));

/* ── F3 색인(_index.json) ─────────────────────────────────────────────────── */
test('F3 vmperf · vmseries 색인: 읽기 오류면 한 줄짜리 색인으로 덮지 않는다(다른 vCenter 의 역매핑 유지) · 다음 open 이 다시 등록', async () => {
  for (const [rel, get, close, dirOf, usage] of [
    ['metrics/vmperfDb.js', 'getVmperfDb', 'closeVmperfDb', 'vmperfDir', 'vmperfDiskUsage'],
    ['vmseries/db.js', 'getVmSeriesDb', 'closeVmSeriesDb', 'vmSeriesDir', 'vmSeriesDiskUsage'],
  ]) {
    const M = await import(`../src/${rel}`);
    const dir = M[dirOf]();
    const ids = ['vc:a', 'vc:b', 'vc:c'];
    closers.push(() => { for (const v of ids) M[close](v); });
    if (!(await M[get]('vc:a'))) return;   // node:sqlite 없는 런타임
    await M[get]('vc:b');
    const before = raw('_index.json', dir);
    assert.equal(Object.keys(JSON.parse(before)).length, 2, rel);
    eio.add('_index.json');
    try { await M[get]('vc:c'); } finally { eio.delete('_index.json'); }
    assert.equal(raw('_index.json', dir), before, `${rel}: 못 읽은 색인 위에 쓰지 않는다`);
    assert.deepEqual(M[usage]().map((u) => u.vcenterId).filter((v) => ids.includes(v)).sort(), ['vc:a', 'vc:b'], `${rel}: 기존 역매핑이 그대로`);
    M[close]('vc:c'); await M[get]('vc:c');
    assert.equal(Object.keys(JSON.parse(raw('_index.json', dir))).length, 3, `${rel}: 읽히면 다음 open 이 등록한다`);
    // 손상은 예전과 같다(보존 + 빈 색인)
    fs.writeFileSync(path.join(dir, '_index.json'), '{깨짐');
    M[usage]();
    assert.equal(corruptOf('_index.json', dir).length, 1, rel);
  }
});

/* ── D1 인증 정지 기록(util/authGuard) ───────────────────────────────────── */
test('D1 authGuard: 읽기 오류면 원본 유지 · 모르는 대상은 정지로 답함(자동 재로그인 없음) · 그동안의 기록 · 해제는 메모리 → 읽히면 합쳐 씀', () => quiet(async () => {
  const { createAuthGuard, credHashOf } = await import('../src/util/authGuard.js');
  const name = 'r119-auth-stops.json';
  const d1 = { id: 'd1', username: 'svc', password: 'wrong' };
  const d2 = { id: 'd2', username: 'svc', password: 'wrong' };
  const d3 = { id: 'd3', username: 'ok', password: 'good' };
  const d4 = { id: 'd4', username: 'x', password: 'y' };
  const g = createAuthGuard({ file: name });
  g._resetForTest();
  const orig = put(name, { d1: { credHash: credHashOf(d1), since: 1_700_000_000_000, at: 1_700_000_000_500, attempts: 3, reason: '인증 실패(401)' },
    d4: { credHash: credHashOf(d4), since: 1_700_000_000_000, at: 1_700_000_000_000, attempts: 1, reason: '인증 실패' } });
  assert.equal(g.authStopFor(d1)?.attempts, 3);
  assert.equal(g.unreadable(), null);
  g._resetForTest(); put(name, orig);

  eio.add(name); reads.delete(name);
  const stop = g.authStopFor(d1);
  assert.ok(stop, '정지돼 있던 대상을 "정지 아님" 으로 답하면 다음 주기가 같은 틀린 자격으로 다시 로그인한다');
  assert.deepEqual(Object.keys(stop).sort(), ['at', 'attempts', 'reason', 'since', 'unread'], '반환 꼴은 그대로 + 124회차 표지 unread(인증 실패가 아니라는 표시 — rebut124)');
  assert.equal(stop.attempts, 0);
  assert.match(stop.reason, /읽지 못해.*읽기 오류\(EIO\).*원본은 그대로/);
  assert.ok(g.peekAuthStop(d1), '읽기 전용 조회(다른 수집기)도 같은 판정 — 같은 계정으로 따로 로그인하지 않게');
  assert.ok(g.authStopFor(d3), '기록이 있었는지 모르는 대상도 정지로');
  assert.equal(g.unreadable()?.code, 'EIO');
  // 그동안의 기록 · 해제는 메모리에만
  assert.equal(g.markAuthStopped('d2', d2, '인증 실패(403)').attempts, 1);
  assert.equal(g.authStopFor(d2)?.reason, '인증 실패(403)', '이 창 안에서 기록된 대상은 그 기록대로');
  assert.equal(g.markAuthStopped('d1', d1, '인증 실패(401)').attempts, 1);
  assert.equal(g.clearAuthStop('d3'), true);   // 수동 실행이 성공했다 — 124회차: 정지로 답하던 대상을 풀었으면 true(예전 false — '풀지 않았다' 로 읽혔다)
  assert.equal(g.authStopFor(d3), null, '이 창 안에서 해제된 대상(수동 실행 성공)은 다시 수집한다');
  assert.equal(g.peekAuthStop(d3), null);
  assert.equal(g.clearAuthStop('d4'), true);
  g.flush();
  assert.equal(raw(name), orig, '못 읽은 원본 위에 쓰지 않는다(예전: 한 건짜리 파일로 덮음)');
  assert.deepEqual(corruptOf(name), []);
  for (let i = 0; i < 5; i += 1) g.authStopFor({ id: `n${i}`, username: 'a', password: 'b' });
  assert.equal(reads.get(name), 1, '간격 안의 호출은 디스크를 다시 읽지 않는다(대상마다 부르는 핫패스)');

  eio.delete(name); pass();
  const back = g.authStopFor(d1);
  assert.equal(g.unreadable(), null);
  assert.equal(back.since, 1_700_000_000_000, '같은 자격의 기록은 처음 시각을 지킨다');
  assert.equal(back.attempts, 4, '파일의 시도 수 + 그동안의 시도 수');
  const file = JSON.parse(raw(name));
  assert.deepEqual(Object.keys(file).sort(), ['d1', 'd2'], '읽히면 그동안의 기록을 합치고 해제(d4)를 반영해 한 번 쓴다');
  assert.equal(g.authStopFor({ ...d1, password: 'fixed' }), null, '자격증명이 바뀌면 자동 재개(규칙 2 — 예전과 같다)');
  assert.equal(g.authStopFor({ id: 'never', username: 'a', password: 'b' }), null, '읽힌 뒤 기록 없는 대상은 정지 아님');

  // 없음 · 손상은 예전과 같다 — 빈 기록(정지 아님) · 보존본 없음
  g._resetForTest();
  assert.equal(g.authStopFor(d1), null);
  g._resetForTest(); put(name, '{깨짐');
  assert.equal(g.authStopFor(d1), null);
  assert.equal(g.unreadable(), null);
  assert.deepEqual(corruptOf(name), []);
  g._resetForTest();
}));

test('D1 authGuard: 못 읽은 동안의 신원 모양 이관(rekeyAuthStop)은 읽힌 뒤에 적용된다', () => quiet(async () => {
  const { createAuthGuard, credHashOf } = await import('../src/util/authGuard.js');
  const name = 'r119-auth-stops-rekey.json';
  const from = { id: 'dir1', username: 'bareos', password: 'pw' };
  const to = { id: 'dir1', username: 'bareos#tls1.2', password: 'pw' };
  const g = createAuthGuard({ file: name });
  g._resetForTest();
  put(name, { dir1: { credHash: credHashOf(from), since: 5, at: 6, attempts: 2, reason: '인증 실패' } });
  eio.add(name);
  assert.equal(g.rekeyAuthStop(from, to), false);
  assert.ok(g.authStopFor(to), '그동안은 모름 = 정지');
  eio.delete(name); pass();
  assert.equal(g.authStopFor(to)?.attempts, 2, '읽힌 뒤 새 신원으로 옮겨져 정지가 유지된다(한 번 더 로그인하지 않는다)');
  g._resetForTest();
}));

/* ── D2 장비 신뢰(security/peerTrust) ────────────────────────────────────── */
const FP_A = `SHA256:${'A'.repeat(43)}`;
const FP_B = `SHA256:${'B'.repeat(43)}`;
function seedTrust(policy = { ssh: 'enforce', tls: 'enforce' }, state = 'approved') {
  put('vcenters.json', { vcenters: [{ id: 'vc1' }] });   // 기존 현장 표지(없음 = observe 로 여는 조건)
  return put('peer-trust.json', { v: 1, policy, origin: {}, entries: [{ kind: 'ssh', host: '10.0.0.5', port: 22, trusted: { fp: FP_A, state, at: 1 } }] });
}

test('D2 peerTrust: 읽기 오류 한 번 — 원본을 옮기지 않고 enforce 로 닫음 · 쓰기 차단 · 30초 뒤 다시 읽어 승인 목록이 재시작 없이 돌아온다', () => quiet(async () => {
  const pt = await import('../src/security/peerTrust.js');
  const name = 'peer-trust.json';
  const orig = seedTrust();
  pt._resetPeerTrustForTest();
  eio.add(name); reads.delete(name);
  pt.initPeerTrust();
  const le = pt.peerTrustStatus().loadError;
  assert.deepEqual(le, { code: 'unreadable', detail: 'EIO', writeBlocked: true, readError: true });
  assert.equal(pt.getPeerPolicy('ssh').mode, 'enforce');
  assert.equal(pt.getPeerPolicy('ssh').origin, 'load-error');
  assert.deepEqual([pt.checkPeer('ssh', '10.0.0.5', 22, FP_A).ok, pt.checkPeer('ssh', '10.0.0.5', 22, FP_A).reason], [false, 'unknown'], '승인 목록을 모르는 동안은 전부 거부(닫는 쪽)');
  assert.equal(pt.checkPeer('ssh', '10.0.0.9', 22, FP_B).reason, 'unknown', 'observe 로 열지 않는다(observed-new 금지)');
  assert.throws(() => pt.approvePeer('ssh', '10.0.0.9', 22, FP_B, { by: 't' }), (e) => e.status === 409 && e.code === 'peer-trust-unwritable' && /저장하지 않습니다/.test(e.message) && /다시 읽/.test(e.message));
  assert.throws(() => pt.setPeerPolicy('ssh', 'observe'), (e) => e.status === 409);
  pt.flushPeerTrust();
  assert.equal(raw(name), orig, '원본이 글자 그대로(예전: 빈 승인 목록 + enforce 를 그 자리에 씀)');
  assert.deepEqual(corruptOf(name), [], '읽기 실패는 손상이 아니다 — 옮기지 않는다');
  assert.equal(reads.get(name), 1, '연결마다(핫패스) 디스크를 다시 읽지 않는다');

  eio.delete(name);
  assert.equal(pt.checkPeer('ssh', '10.0.0.5', 22, FP_A).reason, 'unknown', '간격 안에는 다시 읽지 않는다');
  pass();
  assert.equal(pt.checkPeer('ssh', '10.0.0.5', 22, FP_A).reason, 'approved', '읽히면 승인 목록이 돌아온다(재시작 · 수동 복구 없이)');
  assert.equal(pt.peerTrustStatus().loadError, null);
  assert.equal(pt.getPeerPolicy('ssh').origin, undefined, '파일의 정책 그대로(load-error 가 남지 않는다)');
  assert.equal(pt.listPeers({ kind: 'ssh' }).some((e) => e.host === '10.0.0.9'), false, '그동안의 메모리 기록은 버린다');
  pt.flushPeerTrust(); pt._resetPeerTrustForTest();
}));

test('D2 peerTrust: 계속 못 읽으면 닫힌 채(메모리 기록 유지) · 다시 읽을 때 파일이 사라져도 실행 중에는 observe 로 열지 않는다 · observe 원본도 닫았다가 그대로 돌아온다', () => quiet(async () => {
  const pt = await import('../src/security/peerTrust.js');
  const name = 'peer-trust.json';
  const orig = seedTrust({ ssh: 'observe', tls: 'observe' }, 'observed');
  pt._resetPeerTrustForTest();
  eio.add(name);
  assert.equal(pt.getPeerPolicy('ssh').mode, 'enforce', 'observe 였던 설치도 못 읽는 동안은 enforce');
  assert.equal(pt.checkPeer('ssh', '10.0.0.9', 22, FP_B).reason, 'unknown');
  pass();
  assert.equal(pt.getPeerPolicy('ssh').mode, 'enforce', '다시 읽어도 못 읽으면 그대로 닫힘');   // 이 호출이 다시 읽기를 시도한다
  assert.equal(pt.peerTrustStatus().kinds.ssh.counts.pending, 1, '계속 못 읽는 동안 메모리의 대기 기록은 남는다(다시 읽기 실패가 상태를 비우지 않는다)');
  assert.equal(pt.checkPeer('ssh', '10.0.0.9', 22, FP_B).ok, false);
  // 다시 읽을 때 파일이 없다(ENOENT) — 실행 중에 '없음 = 기존 현장 observe' 로 열지 않는다
  eio.delete(name);
  const keep = F('peer-trust.keep119'); fs.renameSync(F(name), keep);
  pass();
  assert.equal(pt.getPeerPolicy('ssh').mode, 'enforce');
  assert.equal(pt.checkPeer('ssh', '10.0.0.9', 22, FP_B).reason, 'unknown');
  assert.equal(pt.peerTrustStatus().loadError?.detail, 'ENOENT');
  assert.equal(fs.existsSync(F(name)), false, '닫힌 정책을 새 파일로 쓰지 않는다');
  fs.renameSync(keep, F(name));
  pass();
  assert.equal(pt.getPeerPolicy('ssh').mode, 'observe', '읽히면 파일의 정책(관찰) 그대로');
  assert.equal(pt.checkPeer('ssh', '10.0.0.5', 22, FP_A).reason, 'observed');
  assert.equal(pt.checkPeer('ssh', '10.0.0.5', 22, FP_B).reason, 'changed', '관찰로 고정한 지문과 다른 지문은 여전히 거부');
  pt.flushPeerTrust(); pt._resetPeerTrustForTest();
  assert.equal(JSON.parse(raw(name)).entries.find((e) => e.host === '10.0.0.5').trusted.fp, FP_A);
  assert.ok(orig.includes(FP_A));
  for (const n of [name, 'vcenters.json']) fs.rmSync(F(n), { force: true });
  for (const n of corruptOf(name)) fs.rmSync(F(n), { force: true });
}));

/* ── ⓒ 결함 아님으로 확정한 것 — 동작 고정 ────────────────────────────────── */
test('ⓒ auth/sessionState: 읽기 오류는 원본을 옮기지 않고 지금 이전 세션을 전부 무효(닫는 쪽) — 폐기한 세션이 되살아나지 않는다', () => quiet(async () => {
  const S = await import('../src/auth/sessionState.js');
  const name = 'session-state.json';
  put(name, { v: 1, notBefore: 0, revoked: { s1: { u: 'a', until: 4_102_444_800, at: 1, why: 'logout' } }, revokedTokens: {}, activity: {} });
  S._resetSessionStateForTest();
  eio.add(name);
  const before = Math.floor(Date.now() / 1000);
  assert.ok(S.sessionNotBefore() >= before, '폐기 목록을 모르면 지금 이전에 로그인한 세션을 전부 무효로');
  assert.deepEqual(corruptOf(name), [], '읽기 오류에 보존본을 만들지 않는다');
  S.persistNow();
  eio.delete(name);
  assert.ok(JSON.parse(raw(name)).notBefore >= before, '이후 저장은 notBefore 를 담는다 — 덮인 폐기 목록의 세션은 이미 전부 무효다');
  S._resetSessionStateForTest();
  assert.ok(S.sessionNotBefore() >= before, '재시작 뒤에도 그 판정이 남는다');
  S._resetSessionStateForTest(); fs.rmSync(F(name), { force: true });
}));

test('ⓒ auth/auth users.json: 읽기 오류는 fail-closed — 원본 유지 · 기본 계정을 만들지 않음(19회차 A-4 회귀)', () => quiet(async () => {
  const name = 'users.json';
  const orig = put(name, { users: [{ username: 'alice', role: 'admin', tokenVersion: 7 }] });
  eio.add(name);
  const A = await import('../src/auth/auth.js');
  let list;
  try { list = A.loadUsers(); } finally { eio.delete(name); }
  assert.deepEqual(list, []);
  assert.equal(A.usersReadError()?.code, 'EIO');
  assert.equal(raw(name), orig);
  assert.deepEqual(corruptOf(name), []);
  assert.equal(fs.existsSync(F('initial-admin-password.txt')), false);
}));

/* ── 스윕 ─────────────────────────────────────────────────────────────────── */
test('스윕: 이번에 가른 읽기 단계가 되돌아가지 않는다(소스 표지)', () => {
  const src = (rel) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
  for (const rel of ['isidu/digest.js', 'isidu/notify.js']) {
    const s = src(rel);
    assert.match(s, /makeJsonFileReader\(/, rel);
    assert.doesNotMatch(s, /JSON\.parse\(fs\.readFileSync/, `${rel}: 읽기와 parse 를 한 try 에 두면 읽기 오류도 손상 보존으로 간다`);
    assert.match(s, /if \(_stReadErr\) return;/, `${rel}: 못 읽은 기록 위에 쓰지 않는 가드`);
  }
  const ag = src('util/authGuard.js');
  assert.match(ag, /makeJsonFileReader\(/);
  assert.doesNotMatch(ag, /catch\s*\{\s*_mem = \{\};?\s*\}/, '읽기 오류를 빈 기록으로 받는 catch 하나로 되돌리지 말 것');
  assert.match(ag, /if \(_unread\) return;/, 'persist 는 못 읽은 원본 위에 쓰지 않는다');
  const pt = src('security/peerTrust.js');
  assert.doesNotMatch(pt, /failClosed\(st, 'unreadable'/, '읽기 실패를 손상 보존(원본 이동)으로 되돌리지 말 것');
  assert.match(pt, /return failUnreadable\(/);
  for (const rel of ['metrics/vmperfDb.js', 'vmseries/db.js']) assert.match(src(rel), /readIndex\(\{ strict: true \}\)/, rel);
});
