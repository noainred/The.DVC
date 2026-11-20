/**
 * rebut124.test.js — 전체 점검 124회차: 119회차(읽기 오류 분류표 잔여 — 인증 정지 기록 · 장비 신뢰 · 아이실론) 수정 반증.
 *
 *   A1 util/authGuard unreadStop : 정지 기록 파일을 못 읽는 동안의 정지는 **인증 실패가 아닌데** 꼴이 인증 정지와 같아(시도 0회) 소비처가 'SMTP 인증 실패 … (0회 거부) …
 *      비밀번호를 고치면 자동 재개' 라고 말했다(메일 자동 발송 전체가 그 문구로 건너뜀 — 재현). 표지 unread + 메일 이력 문구.
 *   A2 util/authGuard clearAuthStop : 못 읽는 동안 모르는 대상을 수동 성공으로 풀고도 false('풀지 않았다')를 돌려줬다.
 *   A3 util/authGuard purgeWhere : 못 읽는 동안의 일괄 정리는 메모리만 지워, 읽힌 뒤에도 파일의 옛 기록이 재시작까지 남았다(주석은 '다음 호출이 지운다' — 호출부는 한 번만 부른다).
 *   A4 isidu/notify : 대상별 메일 기록을 못 읽는 동안 자동 발송이 멈추는데 화면 응답(isiduMailStateOf)은 '기록 없음' 이었다(콘솔 한 줄뿐 — 무음 정지).
 *   A5 security/peerTrust : 읽기 오류 중에 파일이 없어지면 닫힌 채 남는데 409 문구는 '원본은 그대로 있습니다 · 읽히면 돌아옵니다' 였다.
 * 읽기 오류는 119회차와 같이 **그 파일 이름의 fs.readFileSync 만** 던지게 해 재현한다(root 컨테이너라 EACCES 를 만들 수 없다).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rebut124-'));
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_DIR: TMP, AUTH_ENABLED: 'true', DATA_SOURCE: 'live' });
for (const k of ['CENTRAL_URL', 'CENTRAL_TOKEN', 'SSH_HOSTKEY_POLICY', 'TLS_PEER_POLICY']) delete process.env[k];
const F = (n) => path.join(TMP, n);
const put = (n, v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); fs.writeFileSync(F(n), s); return s; };

// 시계: 실제 시각에서 정시 경계로 떨어뜨려 고정(재읽기 간격 판정 — util/jsonFileRead.js nowMs).
const RD = await import('../src/util/jsonFileRead.js');
let NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
RD._setJsonFileLoadClockForTest(() => NOW);
const pass = (ms = RD.READ_RETRY_MS + 1_000) => { NOW += ms; };

const realRead = fs.readFileSync;
const bad = new Map();   // 파일 이름 → 오류 코드
fs.readFileSync = (f, ...a) => {
  const code = bad.get(path.basename(String(f)));
  if (code) { const e = new Error(`${code}: read`); e.code = code; throw e; }
  return realRead.call(fs, f, ...a);
};
const raw = (n) => realRead.call(fs, F(n), 'utf8');
after(() => { fs.readFileSync = realRead; RD._setJsonFileLoadClockForTest(); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const quiet = async (fn) => { const w = console.warn; const e = console.error; const l = console.log; console.warn = () => {}; console.error = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.error = e; console.log = l; } };

const AG = await import('../src/util/authGuard.js');

test('A1 authGuard: 못 읽는 동안의 정지는 표지(unread · 시도 0회)를 싣는다 — 실제 정지 기록은 싣지 않는다', () => quiet(async () => {
  const name = 'a1-auth-stops.json';
  const d1 = { id: 'd1', username: 'svc', password: 'wrong' };
  put(name, { d1: { credHash: AG.credHashOf(d1), since: 1, at: 2, attempts: 3, reason: '인증 실패(401)' } });
  const g = AG.createAuthGuard({ file: name });
  bad.set(name, 'EACCES');
  // 127회차(결정 D-A → 권장안 구현 — 기대값이 바뀐 이유): 못 읽는 동안 '모르는 대상 = 전부 정지' 가 아니라 자격 지문마다 한 대상(처음 묻는 대상)이 먼저 시도한다.
  //   표지(unread · 시도 0회)는 그 판정을 기다리는 같은 지문의 다른 대상에 싣는다.
  assert.equal(g.authStopFor({ id: 'probe', username: 'a', password: 'b' }), null);
  const u = g.authStopFor({ id: 'unknown', username: 'a', password: 'b' });
  assert.equal(u.unread, true);
  assert.equal(u.attempts, 0);
  assert.equal(AG.isUnreadStop(u), true);
  assert.deepEqual(Object.keys(AG.authStopView(u)).sort(), ['at', 'attempts', 'reason', 'since', 'unread']);
  assert.equal(AG.isUnreadStop({ since: 1, at: 1, attempts: 0, reason: 'x' }), true, '표지를 떨군 옛 view 를 지나도 시도 0회로 가린다');
  assert.equal(g.peekAuthStop({ id: 'unknown2', username: 'a', password: 'b' }).unread, true);
  // 이 창 안에서 실제로 거부된 대상은 실제 정지 기록이다(표지 없음 · 시도 1 이상).
  const real = g.markAuthStopped('d9', { id: 'd9', username: 'q', password: 'w' }, 'HTTP 401');
  assert.equal(real.attempts, 1);
  assert.equal(AG.isUnreadStop(g.authStopFor({ id: 'd9', username: 'q', password: 'w' })), false);
  bad.delete(name); pass();
  const stop = g.authStopFor(d1);
  assert.equal(stop.attempts, 3);
  assert.equal(AG.isUnreadStop(stop), false);
  assert.deepEqual(Object.keys(AG.authStopView(stop)).sort(), ['at', 'attempts', 'reason', 'since'], '평소 응답 꼴은 그대로');
  assert.equal(AG.isUnreadStop(null), false);
  g._resetForTest();
}));

test('A2 authGuard: 못 읽는 동안 모르는 대상을 수동 성공으로 풀면 true(풀렸다) — 이미 푼 대상은 false', () => quiet(async () => {
  const name = 'a2-auth-stops.json';
  put(name, {});
  const g = AG.createAuthGuard({ file: name });
  bad.set(name, 'EIO');
  const dev = { id: 't1', username: 'u', password: 'p' };
  // 127회차(기대값이 바뀐 이유 — 위 A1 주석): 같은 지문의 첫 대상(t0)이 탐침이고, 다음 대상(t1)이 정지로 답한다.
  assert.equal(g.authStopFor({ ...dev, id: 't0' }), null);
  assert.ok(g.authStopFor(dev), '탐침을 기다리는 대상은 정지로 답한다');
  assert.equal(g.clearAuthStop('t9'), false, '127회차: 정지로 답한 적이 없는 대상(묻지 않았다)은 false');
  assert.equal(g.clearAuthStop('t1'), true, '정지로 답하던 대상을 풀었다');
  assert.equal(g.authStopFor(dev), null);
  assert.equal(g.clearAuthStop('t1'), false, '이미 풀린 대상');
  g.markAuthStopped('t1', dev, 'HTTP 401');
  assert.equal(g.clearAuthStop('t1'), true, '그동안 기록된 대상');
  bad.delete(name); pass();
  assert.equal(g.clearAuthStop('t1'), false, '읽힌 뒤 — 기록이 없으면 false(예전과 같다)');
  g._resetForTest();
}));

test('A3 authGuard: 못 읽는 동안의 purgeWhere 는 읽힌 뒤 파일의 기록에 적용된다(재시작까지 남지 않는다)', () => quiet(async () => {
  const name = 'a3-auth-stops.json';
  const rec = { credHash: 'x', since: 1, at: 1, attempts: 2, reason: '인증 실패' };
  const orig = put(name, { 'scan|adhoc|10.0.0.1': rec, 'scan|adhoc|10.0.0.2': rec, 'scan|r1|10.0.0.3': rec });
  const g = AG.createAuthGuard({ file: name });
  bad.set(name, 'EIO');
  assert.equal(g.purgeWhere((id) => id.startsWith('scan|adhoc|')), 0, '못 읽는 동안에는 메모리 기록만(0건)');
  assert.equal(raw(name), orig, '못 읽은 원본 위에 쓰지 않는다');
  for (let i = 0; i < 50; i++) g.purgeWhere(() => { throw new Error('pred'); });   // 던지는 조건 · 반복 호출 — 상한 안에서만 기억한다
  bad.delete(name); pass();
  assert.equal(g.unreadable(), null);
  assert.deepEqual(Object.keys(JSON.parse(raw(name))), ['scan|r1|10.0.0.3'], '읽히면 파일의 옛 기록에도 적용');
  g._resetForTest();
}));

test('A1 mail: 정지 기록 파일을 못 읽는 동안의 자동 발송을 SMTP 인증 실패(0회 거부)라고 적지 않는다 — 127회차: 건너뛰지 않고 한 번 시도한다', () => quiet(async () => {
  put('mail.json', { enabled: true, smtp: { host: '127.0.0.1', port: 1, user: 'alert@corp.example', password: 'pw', secure: 'none' }, from: 'a@corp.example', defaultTo: ['ops@corp.example'] });
  put('mail-auth-stops.json', {});
  bad.set('mail-auth-stops.json', 'EACCES');
  const M = await import('../src/mail/service.js');
  M.mailAuthGuard._resetForTest(); put('mail-auth-stops.json', {});
  assert.equal(M.mailStatus().authStopped?.unread, true, '첫 발송 전 상태 조회 — 아직 확인 전이라고 말한다(표지 unread — 인증 실패 정지가 아니다)');
  const r = await M.sendPortalMail({ kind: 'alert', subject: '장애 알림', text: 'x' });
  // 127회차(결정 D-A → 권장안 구현 — 기대값이 바뀐 이유): 124 까지는 못 읽는 동안 자동 메일 전체를 건너뛰었다(skipped — 이 테스트는 그 사유 문구를 고정했다). 메일 계정은 대상 1 · 지문 1 이라
  //   이제 그 지문의 탐침이다 — 한 번 시도한다. 여기서는 SMTP 가 없는 주소(127.0.0.1:1)라 연결 실패로 끝나고, 인증 거부가 아니므로 정지도 아니다. 거부 · 성공 갈래는 authGuardProbe127 ⑧(가짜 SMTP).
  assert.equal(r.ok, false);
  assert.notEqual(r.skipped, true, r.reason);
  assert.equal(r.authStopped, undefined);
  assert.doesNotMatch(r.reason, /SMTP 인증 실패로 자동 발송을 멈춘|0회 거부|비밀번호를 고치면 자동 재개/, r.reason);
  const st = M.mailStatus();
  assert.equal(st.authStopped, null, '탐침 대상은 정지로 보이지 않는다');
  assert.equal(st.history[0].state, 'failed', '시도했고 실패했다(건너뜀이 아니다)');
  assert.equal(st.history[0].note, r.reason.slice(0, 300), '이력에도 같은 사유');
  bad.delete('mail-auth-stops.json'); pass();
  assert.equal(M.mailStatus().authStopped, null, '읽히면 정지 아님');
  M.mailAuthGuard._resetForTest();
}));

test('A4 isidu/notify: 대상별 메일 기록을 못 읽는 동안 그 사실을 대상의 메일 상태로 말한다(기록에는 쓰지 않는다)', () => quiet(async () => {
  const N = await import('../src/isidu/notify.js');
  const name = 'isidu-mail-state.json';
  const orig = put(name, { targets: { t1: { lastScanId: 7, last: { at: 1, kind: 'result', state: 'sent' } } } });
  N._resetForTest();
  bad.set(name, 'EACCES');
  for (const id of ['t1', 'never-mailed']) {
    const m = N.isiduMailStateOf(id);
    assert.equal(m?.state, 'skipped', JSON.stringify(m));
    assert.equal(m.code, 'state-unreadable');
    assert.match(m.reason, /읽지 못해 자동 발송을 멈췄습니다/);
    assert.match(m.reason, /EACCES/);
  }
  assert.equal(raw(name), orig);
  bad.delete(name); pass();
  assert.equal(N.isiduMailStateOf('t1')?.state, 'sent', '읽히면 원래 기록');
  assert.equal(N.isiduMailStateOf('never-mailed'), null);
  N._resetForTest();
}));

test('A5 peerTrust: 읽기 오류 중에 파일이 없어지면 표지(gone) · 409 문구가 그 사실을 말한다 — 파일이 돌아오면 다시 읽는다', () => quiet(async () => {
  const fp = 'SHA256:' + 'A'.repeat(43);
  put('vcenters.json', { vcenters: [{ id: 'vc1' }] });
  const orig = { v: 1, policy: { ssh: 'enforce', tls: 'enforce' }, origin: {}, entries: [{ kind: 'ssh', host: '10.0.0.1', port: 22, trusted: { fp, state: 'approved', at: 1 } }] };
  put('peer-trust.json', orig);
  const pt = await import('../src/security/peerTrust.js');
  pt._resetPeerTrustForTest();
  bad.set('peer-trust.json', 'EACCES');
  pt.initPeerTrust();
  assert.equal(pt.checkPeer('ssh', '10.0.0.1', 22, fp).ok, false, '못 읽는 동안에는 승인돼 있던 지문도 거부(닫힌 쪽)');
  assert.equal(pt.peerTrustStatus().loadError.gone, undefined);
  assert.throws(() => pt.approvePeer('ssh', '10.0.0.1', 22, fp, { by: 't' }), (e) => e.code === 'peer-trust-unwritable' && /원본은 그대로 있습니다/.test(e.message));
  // 파일이 없어졌다(읽기 오류는 풀렸지만 읽을 것이 없다)
  bad.delete('peer-trust.json'); fs.rmSync(F('peer-trust.json')); pass();
  assert.equal(pt.checkPeer('ssh', '10.0.0.1', 22, fp).ok, false, '실행 중에는 닫힌 채');
  const le = pt.peerTrustStatus().loadError;
  assert.equal(le.gone, true, JSON.stringify(le));
  assert.equal(le.readError, true); assert.equal(le.writeBlocked, true);
  assert.throws(() => pt.approvePeer('ssh', '10.0.0.1', 22, fp, { by: 't' }),
    (e) => e.status === 409 && e.code === 'peer-trust-unwritable' && /없어져/.test(e.message) && /재시작/.test(e.message) && !/원본은 그대로 있습니다/.test(e.message));
  assert.equal(fs.existsSync(F('peer-trust.json')), false, '없는 자리에 쓰지 않는다');
  // 파일은 돌아왔는데 아직 못 읽는다 → gone 표지가 떨어진다
  put('peer-trust.json', orig); bad.set('peer-trust.json', 'EIO'); pass();
  pt.checkPeer('ssh', '10.0.0.1', 22, fp);
  assert.equal(pt.peerTrustStatus().loadError.gone, undefined);
  assert.equal(pt.peerTrustStatus().loadError.detail, 'EIO');
  // 읽힌다 → 승인 목록이 돌아온다
  bad.delete('peer-trust.json'); pass();
  assert.equal(pt.checkPeer('ssh', '10.0.0.1', 22, fp).reason, 'approved');
  assert.equal(pt.peerTrustStatus().loadError, null);
  pt.flushPeerTrust(); pt._resetPeerTrustForTest();
}));
