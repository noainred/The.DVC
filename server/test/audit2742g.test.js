/**
 * v2.742 감사 그룹 GF 회귀 고정 — 알림 발송 동시성·떨림·서비스 점검.
 *
 *  - TIMING-01  알림 엔진이 발생한 알림마다 notify() 를 await 없이 띄워, 잘못된 SMTP 비밀번호로 한 틱에 로그인 40회가 나갔다
 *               (메일 인증 정지는 첫 535 뒤에야 세워진다 — 동시 시도는 전부 검사를 통과했다). → 발송 대기열(한 번에 하나) +
 *               메일 쪽 자동 발송 단일 줄(계정 있는 SMTP) + 발송 실패 시 짧은 재시도(2번까지, 정책상 건너뜀은 재시도 안 함).
 *  - TIMING-02  해소 루프가 lastNotified 를 버려, 경계에서 오르내리는 지표가 쿨다운(60분)이 아니라 억제 창(5분)마다 재발송됐다.
 *               → 해소된 키의 발송 시각을 쿨다운 동안 기억해 이어받는다.
 *  - TIMING-05  서비스 점검의 비동기 상태 함수가 실패하면 그 행이 영원히 '정상 — 상태 조회 중' 이었다.
 *               → 결과 전에는 'unknown', 실패는 'warn' + 사유, 오래 응답이 없으면 'warn'.
 *
 * 가짜 SMTP 서버(127.0.0.1)로 실제 로그인 시도 수·동시 연결 수·배달 수를 센다. 시계는 고정값(정시 −30분)에서 움직인다
 * (Date.now() 를 기준 시각으로 쓰지 않는다 — CLAUDE.md v2.517).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2742g-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';

/* ── 가짜 SMTP — 동작을 시나리오마다 바꾼다 ─────────────────────────── */
const smtp = { auth: 'ok', data: 'ok', delayMs: 40, conns: 0, cur: 0, maxConc: 0, auths: 0, mails: 0, dataFails: 0 };
function resetSmtp(over = {}) { Object.assign(smtp, { auth: 'ok', data: 'ok', delayMs: 40, conns: 0, cur: 0, maxConc: 0, auths: 0, mails: 0, dataFails: 0 }, over); }
const srv = net.createServer((s) => {
  smtp.conns += 1; smtp.cur += 1; smtp.maxConc = Math.max(smtp.maxConc, smtp.cur);
  s.on('close', () => { smtp.cur -= 1; });
  s.on('error', () => {});
  s.write('220 fake ESMTP\r\n');
  let buf = ''; let inData = false;
  s.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (inData) {
        if (line === '.') {
          inData = false;
          if (smtp.data === 'ok') { smtp.mails += 1; s.write('250 queued\r\n'); } else { smtp.dataFails += 1; s.write('554 5.0.0 rejected\r\n'); }
        }
        continue;
      }
      if (/^EHLO/i.test(line)) s.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (/^AUTH/i.test(line)) {
        smtp.auths += 1;
        setTimeout(() => s.write(smtp.auth === 'ok' ? '235 2.7.0 ok\r\n' : '535 5.7.8 Authentication credentials invalid\r\n'), smtp.delayMs);
      } else if (/^DATA/i.test(line)) { inData = true; s.write('354 go\r\n'); }
      else if (/^QUIT/i.test(line)) { s.write('221 bye\r\n'); s.end(); }
      else s.write('250 ok\r\n');
    }
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
after(() => { try { srv.close(); } catch { /* */ } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

fs.writeFileSync(path.join(DIR, 'mail.json'), JSON.stringify({
  enabled: true,
  smtp: { host: '127.0.0.1', port: PORT, secure: false, startTls: false, user: 'svc', password: 'pw', from: 'portal@x.local', timeoutMs: 5000 },
  defaultTo: ['ops@x.local'], rateLimitPerHour: 0,   // 0 = 제한 없음 — 동시성 가드만 시험한다(속도 제한이 숫자를 가리지 않게)
}));
fs.writeFileSync(path.join(DIR, 'alerts.json'), JSON.stringify({ channels: { email: { enabled: true } }, cooldownMin: 60, intervalSec: 60, suppressWindowMin: 5 }));

const { store } = await import('../src/store.js');
const alerts = await import('../src/alerts.js');
const mail = await import('../src/mail/service.js');

const HOUR = 3_600_000;
const MIN = 60_000;
const T0 = Math.floor(1_800_000_000_000 / HOUR) * HOUR - 30 * MIN;   // 정시 −30분 고정
const realNow = Date.now;
let clock = null;
function useClock(t) { clock = t; Date.now = () => clock; }
function restoreClock() { Date.now = realNow; clock = null; }

const snapOf = (dss) => ({ vcenters: [{ id: 'vc-a', status: 'connected' }], alarms: [], hosts: [], vms: [], datastores: dss });
const ds = (id, pct) => ({ id, name: id, vcenterId: 'vc-a', usagePct: pct, freeGB: 1 });

/** 대기열·메일 줄이 빌 때까지 — 기준 판본(대기열 없음)에서도 동작하도록 발송 수가 멈출 때까지 기다린다. */
async function settle(maxMs = 8000) {
  const t0 = realNow();
  if (typeof alerts._drainNotifyQueueForTest === 'function') {
    await alerts._drainNotifyQueueForTest();
    while (smtp.cur > 0 && realNow() - t0 < maxMs) await new Promise((r) => setTimeout(r, 2));
    return;
  }
  let last = -1; let same = 0;
  while (realNow() - t0 < maxMs) {
    await alerts._drainNotifyQueueForTest?.();
    await new Promise((r) => setTimeout(r, 25));
    const sig = smtp.conns * 1000 + smtp.auths * 7 + smtp.mails + smtp.cur * 100000;
    if (sig === last && smtp.cur === 0) { if (++same >= 6) return; } else { same = 0; last = sig; }
  }
}
async function tick(dss) {
  const orig = store.get;
  store.get = () => snapOf(dss);
  try { await alerts._refreshStateForTest(alerts.loadAlertConfig(), true); } finally { store.get = orig; }
  await settle();
}
function freshState() {
  alerts._resetAlertStateForTest();
  mail._resetMail();
  mail.mailAuthGuard.clearAuthStop('smtp');
}

/* ── TIMING-01: 엔진 40건 → SMTP 로그인 1회 ─────────────────────────── */
test('TIMING-01: 한 틱에 알림 40건이 나도 잘못된 SMTP 비밀번호로는 로그인 1회 — 나머지는 정지 기록을 보고 건너뛴다', async () => {
  freshState();
  resetSmtp({ auth: 'fail', delayMs: 60 });
  await tick(Array.from({ length: 40 }, (_, i) => ds(`burst${i}`, 95)));
  assert.equal(smtp.auths, 1, `SMTP 로그인 시도 ${smtp.auths}회(수정 전: 알림 수만큼 동시 로그인 — 계정 잠금 경로)`);
  assert.ok(smtp.maxConc <= 1, `동시 SMTP 연결 ${smtp.maxConc}개`);
  assert.ok(mail.mailStatus().authStopped, '첫 거부가 정지로 기록돼야 한다');
  const skipped = mail.mailStatus().history.filter((h) => h.state === 'skipped' && /인증 실패로 자동 발송을 멈춘/.test(h.note || '')).length;
  assert.equal(skipped, 39, `정지를 보고 건너뛴 발송 ${skipped}건 — 조용히 버리지 않고 이력에 남긴다`);
  const st = alerts.alertStatus();
  assert.equal(st.queue.pending, 0);
  assert.ok(st.queue.done >= 40);
});

test('TIMING-01: 메일 쪽도 자동 발송은 한 줄 — 동시에 부른 자동 발송 10건이 로그인 1회 · 사람이 누른 발송은 줄 서지 않는다', async () => {
  freshState();
  resetSmtp({ auth: 'fail', delayMs: 60 });
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => mail.sendPortalMail({ kind: 'alert', subject: `s${i}`, text: 'x' })));
  assert.equal(smtp.auths, 1, `자동 발송 10건 동시 → 로그인 ${smtp.auths}회`);
  assert.equal(rs.filter((r) => r.authStopped).length, 10, '첫 거부와 나머지 건너뜀 모두 authStopped 를 싣는다');
  assert.equal(rs.filter((r) => r.skipped).length, 9);
  // 사람이 누른 발송(테스트 발송)은 정지 중에도 시도한다(고쳤는지 확인하는 경로) — 기존 규약 유지.
  resetSmtp({ auth: 'ok', delayMs: 10 });
  const m = await mail.sendPortalMail({ kind: 'test', subject: 't', text: 'x', by: 'admin' });
  assert.equal(m.ok, true);
  assert.equal(smtp.auths, 1);
  assert.equal(mail.mailStatus().authStopped, null, '수동 발송 성공이 정지를 푼다');
  assert.equal(mail.mailAutoQueueLength(), 0);
});

test('TIMING-01: 결과를 기다리지 않는 호출부(대기열)도 한 번에 하나씩 보낸다', async () => {
  freshState();
  resetSmtp({ delayMs: 80 });
  const ps = Array.from({ length: 6 }, (_, i) => alerts.enqueueNotify({ key: `direct-${i}`, severity: 'warning', title: `직접 ${i}` }));
  const res = await Promise.all(ps);
  assert.equal(smtp.mails, 6);
  assert.equal(smtp.maxConc, 1, `동시 SMTP 연결 ${smtp.maxConc}개`);
  for (const r of res) assert.deepEqual(r, ['email:ok']);
  // 소스: 결과를 기다리지 않던 4곳이 대기열을 쓴다
  for (const f of ['relaycheck/poller.js', 'security/loginMonitor.js', 'security/guestScanScheduler.js', 'rma/testResults.js']) {
    const src = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.match(src, /import \{ enqueueNotify as notify \} from '\.\.\/alerts\.js'/, `${f} 는 alerts.js 대기열로 보내야 한다`);
  }
});

test('TIMING-01: 엔진 발송 자체가 한 줄이다 — 계정 없는 SMTP(메일 쪽 줄 서기 없음)에서도 알림 8건이 동시 연결 1개', async () => {
  const mailSettings = await import('../src/mail/settings.js');
  freshState();
  resetSmtp({ delayMs: 60 });
  const full = { host: '127.0.0.1', port: PORT, secure: false, startTls: false, from: 'portal@x.local', timeoutMs: 5000 };
  mailSettings.save({ smtp: { ...full, user: '' } });
  try {
    assert.equal(mailSettings.load().smtp.user, '');
    await tick(Array.from({ length: 8 }, (_, i) => ds(`seq${i}`, 95)));
    assert.equal(smtp.mails, 8);
    assert.equal(smtp.maxConc, 1, `엔진 발송 동시 SMTP 연결 ${smtp.maxConc}개(수정 전: 알림 수만큼 동시 — 웹훅도 같은 순간 동시 POST)`);
  } finally { mailSettings.save({ smtp: { ...full, user: 'svc', password: 'pw' } }); }
});

test('TIMING-01: 발송 실패는 짧게 다시 시도한다(2번까지) — 정책상 건너뜀(인증 정지)은 재시도하지 않는다', async () => {
  freshState();
  resetSmtp({ data: 'fail', delayMs: 5 });
  try {
    useClock(T0);
    await tick([ds('retry1', 95)]);
    assert.equal(smtp.dataFails, 1, '첫 발송');
    for (let m = 1; m <= 4; m++) { useClock(T0 + m * MIN); await tick([ds('retry1', 95)]); }
    assert.equal(smtp.dataFails, 1, '억제 창(5분) 안에서는 다시 보내지 않는다');
    useClock(T0 + 6 * MIN); await tick([ds('retry1', 95)]);
    assert.equal(smtp.dataFails, 2, '실패 뒤 5분이 지나면 다시 시도한다(수정 전: 쿨다운 60분 동안 없음)');
    resetSmtp({ data: 'ok', delayMs: 5 });
    for (let m = 7; m <= 21; m++) { useClock(T0 + m * MIN); await tick([ds('retry1', 95)]); }
    assert.equal(smtp.mails, 1, '두 번째 재시도(15분 뒤)가 배달됐다');
    const at21 = smtp.mails;
    for (let m = 22; m <= 70; m += 4) { useClock(T0 + m * MIN); await tick([ds('retry1', 95)]); }
    assert.equal(smtp.mails, at21, '배달 뒤에는 쿨다운(60분)을 따른다');

    // 늘 실패하면 2번 재시도 뒤 쿨다운으로 돌아간다(메일 서버를 두드리지 않는다)
    freshState();
    resetSmtp({ data: 'fail', delayMs: 5 });
    for (let m = 0; m <= 70; m++) { useClock(T0 + 3 * HOUR + m * MIN); await tick([ds('retry2', 95)]); }
    assert.equal(smtp.dataFails, 3, `늘 실패하는 발송 시도 ${smtp.dataFails}회 — 첫 시도 + 재시도 2번(그 뒤는 쿨다운 60분)`);

    // 인증 실패로 메일이 멈춘 뒤의 'email:skip' 은 실패가 아니다 — 재시도하지 않는다(로그인 0회)
    freshState();
    resetSmtp({ auth: 'fail', delayMs: 5 });
    for (let m = 0; m <= 40; m++) { useClock(T0 + 6 * HOUR + m * MIN); await tick([ds('retry3', 95)]); }
    assert.equal(smtp.auths, 1, `인증 실패 뒤 로그인 ${smtp.auths}회 — 재시도가 계정 잠금을 만들면 안 된다`);
  } finally { restoreClock(); }
});

test('deliveryOutcome·retryDelayMs(순수)', () => {
  assert.equal(alerts.deliveryOutcome(['email:ok']), 'delivered');
  assert.equal(alerts.deliveryOutcome(['slack:200', 'email:err x']), 'delivered');
  assert.equal(alerts.deliveryOutcome(['slack:err timeout']), 'failed');
  assert.equal(alerts.deliveryOutcome(['webhook:500']), 'failed');
  assert.equal(alerts.deliveryOutcome(['queue-full']), 'failed');
  assert.equal(alerts.deliveryOutcome(['suppressed']), 'skipped');
  assert.equal(alerts.deliveryOutcome(['email:skip 시간당 발송 한도']), 'skipped');
  assert.equal(alerts.deliveryOutcome([]), 'skipped');
  assert.equal(alerts.retryDelayMs(0, 60 * MIN, 5 * MIN), 5 * MIN + 1000, '억제 창보다 길게');
  assert.equal(alerts.retryDelayMs(1, 60 * MIN, 5 * MIN), 15 * MIN);
  assert.equal(alerts.retryDelayMs(2, 60 * MIN, 5 * MIN), null, '2번 뒤에는 쿨다운');
  assert.equal(alerts.retryDelayMs(0, 4 * MIN, 0), null, '쿨다운이 더 짧으면 재시도하지 않는다');
});

/* ── TIMING-02: 경계에서 떨리는 알림 ───────────────────────────────── */
test('TIMING-02: 90%↔89% 를 오가는 데이터스토어는 120분 동안 쿨다운(60분)마다 1통 — 억제 창(5분)마다가 아니다', async () => {
  freshState();
  resetSmtp({ delayMs: 2 });
  try {
    for (let m = 0; m < 120; m++) {
      useClock(T0 + 12 * HOUR + m * MIN);
      await tick([ds('flap1', m % 2 === 0 ? 90 : 89)]);
    }
    assert.equal(smtp.mails, 2, `120분 동안 ${smtp.mails}통(수정 전: 억제 창마다 약 24통)`);
    // 해소는 여전히 기록된다(화면 '최근' 목록) — 기억하는 것은 발송 시각뿐이다
    assert.ok(alerts.alertStatus().recent.some((r) => r.severity === 'resolved' && r.key === 'ds:flap1'));
    // 해소 기억은 상태 파일에 남는다(재시작 뒤에도 같은 쿨다운)
    alerts._writeAlertStateForTest();
    const j = JSON.parse(fs.readFileSync(path.join(DIR, 'alerts-state.json'), 'utf8'));
    const e = j.firing['ds:flap1'];
    assert.ok(e && Number.isFinite(e.lastNotified));
  } finally { restoreClock(); }
});

test('TIMING-02: 해소 뒤 쿨다운이 지난 재발생은 새로 알린다 · 발생 시각은 새로 잡는다', async () => {
  freshState();
  resetSmtp({ delayMs: 2 });
  try {
    const base = T0 + 20 * HOUR;
    useClock(base); await tick([ds('flap2', 95)]);
    assert.equal(smtp.mails, 1);
    useClock(base + 10 * MIN); await tick([]);                 // 해소
    useClock(base + 20 * MIN); await tick([ds('flap2', 95)]); // 쿨다운 안 재발생 — 보내지 않는다
    assert.equal(smtp.mails, 1);
    const f = alerts.alertStatus().firing.find((x) => x.key === 'ds:flap2');
    assert.equal(Date.parse(f.since), base + 20 * MIN, '발생 시각은 재발생 시각이다(새 발생)');
    useClock(base + 30 * MIN); await tick([]);                 // 다시 해소
    useClock(base + 61 * MIN); await tick([ds('flap2', 95)]); // 마지막 발송에서 60분이 지났다 — 보낸다
    assert.equal(smtp.mails, 2);
  } finally { restoreClock(); }
});

/* ── TIMING-05: 서비스 점검 비동기 상태 함수 ─────────────────────────── */
test('TIMING-05: 비동기 상태 함수 — 결과 전에는 unknown(정상 아님), 실패는 warn + 사유, 오래 응답이 없으면 warn', async () => {
  const svc = await import('../src/health/services.js');
  svc._resetAsyncStatusCacheForTest();
  const now0 = T0;
  // ① 실패하는 상태 함수
  const failing = () => Promise.reject(new Error('로그 저장 경로를 만들 수 없습니다'));
  let s = svc._readStatusForTest('t.fail', failing, now0);
  let row = svc.asyncStatusRow(s, {}, now0);
  assert.equal(row.status, 'unknown', `첫 조회 ${row.status}(수정 전: ok — '정상 — 상태 조회 중')`);
  await new Promise((r) => setImmediate(r));
  s = svc._readStatusForTest('t.fail', failing, now0 + 15_000);
  row = svc.asyncStatusRow(s, {}, now0 + 15_000);
  assert.equal(row.status, 'warn', `실패한 상태 함수가 ${row.status}`);
  assert.match(row.detail, /상태 조회 실패: 로그 저장 경로를 만들 수 없습니다 — 성공한 적이 없습니다/);
  // ② 성공 뒤 실패 — 직전 성공 시각을 함께 말하고 값으로 판정하지 않는다
  let ok = true;
  const flaky = () => (ok ? Promise.resolve({ enabled: true, lastRun: { at: realNow() } }) : Promise.reject(new Error('DB 읽기 오류')));
  svc._readStatusForTest('t.flaky', flaky, now0);
  await new Promise((r) => setImmediate(r));
  row = svc.asyncStatusRow(svc._readStatusForTest('t.flaky', flaky, now0), {}, realNow());
  assert.notEqual(row.status, 'unknown');
  ok = false;
  await new Promise((r) => setImmediate(r));
  svc._readStatusForTest('t.flaky', flaky, now0);
  await new Promise((r) => setImmediate(r));
  row = svc.asyncStatusRow(svc._readStatusForTest('t.flaky', flaky, now0), {}, realNow());
  assert.equal(row.status, 'warn');
  assert.match(row.detail, /DB 읽기 오류 — 마지막 성공 \d+분 전/);
  // ③ 응답 없음(매달림) — 60초 넘으면 warn, 그 사이 상태 함수를 다시 부르지 않는다
  let calls = 0;
  const hang = () => { calls += 1; return new Promise(() => {}); };
  svc._readStatusForTest('t.hang', hang, now0);
  svc._readStatusForTest('t.hang', hang, now0 + 30_000);
  row = svc.asyncStatusRow(svc._readStatusForTest('t.hang', hang, now0 + 61_000), {}, now0 + 61_000);
  assert.equal(row.status, 'warn');
  assert.match(row.detail, /응답하지 않습니다/);
  assert.equal(calls, 1, `매달린 상태 함수를 ${calls}번 불렀다`);
  svc._resetAsyncStatusCacheForTest();
});

test('TIMING-05: getServiceCheck — 결과 전 비동기 행은 unknown 으로 세고, 그것만 남으면 종합을 정상이라 하지 않는다', async () => {
  const svc = await import('../src/health/services.js');
  svc._resetAsyncStatusCacheForTest();
  const r = svc.getServiceCheck();
  const pend = r.checks.filter((c) => c.pendingAsync);
  assert.ok(pend.length >= 1, '이 프로세스에도 비동기 상태 함수 행이 있다(vCenter 로그·파트 장애)');
  for (const c of pend) assert.notEqual(c.status, 'ok', `${c.key}: 결과 전인데 ${c.status}`);
  assert.equal(r.summary.unknown, r.checks.filter((c) => c.status === 'unknown').length);
  if (!r.summary.down && !r.summary.warn) assert.equal(r.overall, 'unknown');
  else assert.notEqual(r.overall, 'ok');
  svc._resetAsyncStatusCacheForTest();
});
