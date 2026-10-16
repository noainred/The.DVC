/**
 * v2.743 감사 그룹 GG 회귀 고정 — 알림 발송 줄·메일 제목·데모 알림·일일 보고.
 *
 *  - TIMING-02  v2.742 발송 대기열이 알림을 채널까지 한 줄로 묶어, 응답 없는 웹훅 하나(시한 15초 × 재시도 1)가 **모든 알림·모든
 *               채널**을 알림당 약 30초씩 늦췄다(재현: 알림 4건의 정상 Slack 도착 0.2·30.6·61.0·91.4초). 대기 중인 알림은
 *               파일에 '보냄' 으로 남아 재시작 때 쿨다운 동안 다시 보내지 않았다.
 *               → 채널별 줄(웹훅 채널은 상한 있는 동시성 · 메일은 1) + 결과를 받기 전에는 파일에 직전 값을 쓴다.
 *               v2.742 가 막은 '첫 SMTP 거부가 기록되기 전 같은 계정 동시 로그인' 이 되살아나지 않는지도 함께 고정한다.
 *  - INJPKG-03  알림 제목에 제어문자(탭·CR·LF)가 하나라도 있으면 buildMime 이 던져 그 알림 메일 전체가 실패했다.
 *               → alertSubject·sendPortalMail 진입부가 공백으로 정리한다(buildMime 의 throw 는 마지막 방어선).
 *  - VC-05      VM 구성 점검(스냅샷 정책) 알림이 목업 스냅샷의 위반을 실제 알림 채널로 보냈다(v2.708 데모 알림 가드 누락).
 *               → 목업 vCenter 의 VM 은 알림 입력에서 빼고, 남는 VM 이 없으면(mock 모드) 'demo' 로 끝낸다('지금 보내기' 포함).
 *  - TIMING-04  일일 헬스체크 '지금 발송(테스트)' 이 성공하면 그날 예약 발송을 건너뛰었다(정한 시각 전에 테스트하면 정기 리포트 생략).
 *               → 정한 시각 전의 수동 발송은 예약 기준(lastRunTs)을 바꾸지 않고 lastManualTs 를 따로 남긴다.
 *
 * 가짜 HTTP(웹훅)·가짜 SMTP 서버(127.0.0.1)로 실제 도착 시각·로그인 수를 센다. 루프백 웹훅은 SSRF_ALLOW_LOOPBACK 으로 연다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2743g-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'true';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
delete process.env.CENTRAL_URL;

const realNow = Date.now;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, maxMs) {
  const t0 = realNow();
  while (realNow() - t0 < maxMs) { if (fn()) return true; await sleep(10); }
  return fn();
}

/* ── 가짜 웹훅(바로 200) ─────────────────────────────────────────────── */
const hits = [];   // { path, at }
const fast = http.createServer((req, res) => { req.resume(); req.on('end', () => { hits.push({ path: req.url, at: realNow() }); res.end('ok'); }); });
await new Promise((r) => fast.listen(0, '127.0.0.1', r));
const FAST = `http://127.0.0.1:${fast.address().port}`;
const hitCount = (p) => hits.filter((h) => h.path === p).length;

/** 응답하지 않는 웹훅 — 닫으면 걸린 연결을 끊어 발송이 곧 실패로 끝나게 한다. */
async function hangServer() {
  const srv = http.createServer((req) => { req.resume(); /* 응답하지 않는다 */ });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${srv.address().port}`,
    close: () => new Promise((r) => { srv.close(() => r()); srv.closeAllConnections?.(); }),
  };
}

/* ── 가짜 SMTP — 로그인 수·동시 연결 수·배달 수·받은 제목 ───────────────── */
const smtp = { auth: 'ok', delayMs: 20, conns: 0, cur: 0, maxConc: 0, auths: 0, mails: 0, subjects: [] };
function resetSmtp(over = {}) { Object.assign(smtp, { auth: 'ok', delayMs: 20, conns: 0, cur: 0, maxConc: 0, auths: 0, mails: 0, subjects: [] }, over); }
const smtpSrv = net.createServer((s) => {
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
        if (line === '.') { inData = false; smtp.mails += 1; s.write('250 queued\r\n'); } else if (/^Subject:/i.test(line)) smtp.subjects.push(line);
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
await new Promise((r) => smtpSrv.listen(0, '127.0.0.1', r));
const SMTP_PORT = smtpSrv.address().port;

fs.writeFileSync(path.join(DIR, 'mail.json'), JSON.stringify({
  enabled: true,
  smtp: { host: '127.0.0.1', port: SMTP_PORT, secure: false, startTls: false, user: 'svc', password: 'pw', from: 'portal@x.local', timeoutMs: 5000 },
  defaultTo: ['ops@x.local'], rateLimitPerHour: 0,
}));
// 일일 보고(sendText)가 쓰는 채널 — 다른 시험은 cfg 를 직접 넘긴다.
fs.writeFileSync(path.join(DIR, 'alerts.json'), JSON.stringify({ channels: { slack: { enabled: true, url: `${FAST}/daily` } }, cooldownMin: 60, intervalSec: 60, suppressWindowMin: 0 }));

const { store } = await import('../src/store.js');
const alerts = await import('../src/alerts.js');
const mail = await import('../src/mail/service.js');
const { headerSafeText, buildMime } = await import('../src/util/smtp.js');
const { setDataSource } = await import('../src/runtime-settings.js');

after(() => {
  Date.now = realNow;
  try { fast.close(); fast.closeAllConnections?.(); } catch { /* */ }
  try { smtpSrv.close(); } catch { /* */ }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

function freshMail() { mail._resetMail(); mail.mailAuthGuard.clearAuthStop('smtp'); }

/* ── TIMING-02 ───────────────────────────────────────────────────────── */
test('TIMING-02: 응답 없는 웹훅(Teams) 하나가 정상 채널(Slack)을 알림 수만큼 늦추지 않는다', async () => {
  const hang = await hangServer();
  const cfg = { suppressWindowMin: 0, channels: { slack: { enabled: true, url: `${FAST}/hol` }, teams: { enabled: true, url: `${hang.url}/hook` } } };
  const N = 8;
  const slackBefore = alerts.notifyQueueStatus().lanes?.slack?.done ?? 0;
  const t0 = realNow();
  const ps = Array.from({ length: N }, (_, i) => alerts.enqueueNotify({ key: `hol-${i}`, severity: 'warning', title: `HOL ${i}` }, cfg));
  let arrived; let elapsed; let qs;
  try {
    // 서버가 받은 것(hits)과 보내는 쪽 줄이 응답까지 받은 것(slack done)을 둘 다 기다린다 — 앞만 보면 마지막 응답이 오는 중일 수 있다.
    arrived = await waitFor(() => hitCount('/hol') >= N && (alerts.notifyQueueStatus().lanes?.slack?.done ?? -1) - slackBefore >= N, 6000);
    elapsed = realNow() - t0;
    qs = alerts.notifyQueueStatus();
  } finally { await hang.close(); }
  const res = await Promise.all(ps);
  assert.ok(arrived, `정상 Slack 도착 ${hitCount('/hol')}/${N}건(6초) — 수정 전: 알림마다 응답 없는 Teams 시한(약 30초)을 기다렸다`);
  assert.ok(elapsed < 6000, `정상 채널 ${N}건 도착 ${elapsed}ms`);
  // 응답 없는 채널은 자기 줄의 상한까지만 붙잡는다 — 다른 채널 줄은 비어 있다.
  assert.equal(qs?.lanes?.teams?.active, alerts.NOTIFY_LANE_LIMIT.teams, `Teams 줄 동시 ${qs?.lanes?.teams?.active}`);
  assert.equal(qs?.lanes?.slack?.active, 0);
  assert.ok(alerts.NOTIFY_LANE_LIMIT.teams <= 4, '웹훅 줄 상한은 webhookAgent 의 출처당 연결 수(4) 이하');
  // 결과는 그 알림의 채널이 모두 끝난 뒤에, 채널 순서 그대로 돌려준다.
  for (const r of res) {
    assert.equal(r.length, 2);
    assert.match(r[0], /^slack:200$/);
    assert.match(r[1], /^teams:err\b/);
  }
  await alerts._drainNotifyQueueForTest();
  assert.equal(alerts.notifyQueueStatus().pending, 0);
});

test('TIMING-02: 메일은 여전히 한 번에 하나 — 응답 없는 웹훅과 함께여도 잘못된 SMTP 비밀번호로 로그인 1회, 메일 줄은 웹훅을 기다리지 않는다', async () => {
  freshMail();
  resetSmtp({ auth: 'fail', delayMs: 30 });
  const hang = await hangServer();
  const cfg = { suppressWindowMin: 0, channels: { teams: { enabled: true, url: `${hang.url}/hook` }, email: { enabled: true } } };
  const N = 10;
  const before = alerts.notifyQueueStatus().lanes?.email?.done ?? 0;
  const ps = Array.from({ length: N }, (_, i) => alerts.enqueueNotify({ key: `mailhol-${i}`, severity: 'warning', title: `메일 ${i}` }, cfg));
  let mailDone;
  try {
    mailDone = await waitFor(() => (alerts.notifyQueueStatus().lanes?.email?.done ?? -1) - before >= N, 6000);
  } finally { await hang.close(); }
  const res = await Promise.all(ps);
  await waitFor(() => smtp.cur === 0, 3000);
  assert.ok(mailDone, '메일 줄이 응답 없는 Teams 를 기다리지 않고 끝나야 한다(수정 전: 알림마다 Teams 시한 뒤에 메일)');
  assert.equal(smtp.auths, 1, `SMTP 로그인 ${smtp.auths}회 — 첫 거부 뒤 나머지는 정지 기록을 보고 건너뛴다(v2.742 TIMING-01)`);
  assert.ok(smtp.maxConc <= 1, `동시 SMTP 연결 ${smtp.maxConc}개`);
  for (const r of res) assert.match(r[r.length - 1], /^email:(err|skip)\b/);
  await alerts._drainNotifyQueueForTest();
  freshMail();
});

test('TIMING-02: 대기 중인 발송은 파일에 \'보냄\' 으로 남지 않는다 — 대기 중 재시작하면 다시 보낸다', async () => {
  const hang = await hangServer();
  alerts._resetAlertStateForTest();
  const cfg = { ...alerts.loadAlertConfig(), suppressWindowMin: 0, cooldownMin: 60,
    channels: { slack: { enabled: true, url: `${FAST}/pend` }, teams: { enabled: true, url: `${hang.url}/hook` } } };
  const snap = { vcenters: [{ id: 'vc-a', status: 'connected' }], alarms: [], hosts: [], vms: [], datastores: [{ id: 'pc', name: 'pc', vcenterId: 'vc-a', usagePct: 95, freeGB: 1 }] };
  const orig = store.get;
  store.get = () => snap;
  const file = path.join(DIR, 'alerts-state.json');
  try {
    await alerts._refreshStateForTest(cfg, true);
    assert.ok(await waitFor(() => hitCount('/pend') >= 1, 3000), 'Slack 은 곧바로 도착');
    // Teams 가 응답하지 않는 동안(발송 결과 대기 중) 상태를 남긴다
    alerts._writeAlertStateForTest();
    const pending = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(pending.firing['ds:pc']?.lastNotified, 0, `대기 중 기록 lastNotified=${pending.firing['ds:pc']?.lastNotified} — 수정 전: 넣은 시각(= '보냄')`);
    // 재시작 흉내 — 메모리를 비우고 파일에서 복원한다
    alerts._resetAlertStateForTest();
    await sleep(5);
    await alerts._refreshStateForTest(cfg, true);
    assert.ok(await waitFor(() => hitCount('/pend') >= 2, 3000), `재시작 뒤 다시 보낸다(Slack ${hitCount('/pend')}건) — 수정 전: 쿨다운 동안 '보냄' 으로 복원`);
  } finally {
    store.get = orig;
    await hang.close();
  }
  await alerts._drainNotifyQueueForTest();
  await sleep(10);
  alerts._writeAlertStateForTest();
  const done = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Number(done.firing['ds:pc']?.lastNotified) > 0, '결과를 받은 뒤에는 보낸 시각을 남긴다');
  alerts._resetAlertStateForTest();
});

test('TIMING-02: 줄 서기 시그니처는 그대로 — 결과를 기다리지 않는 호출부 4곳이 enqueueNotify 를 쓴다', () => {
  for (const f of ['relaycheck/poller.js', 'security/loginMonitor.js', 'security/guestScanScheduler.js', 'rma/testResults.js']) {
    const src = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.match(src, /import \{ enqueueNotify as notify \} from '\.\.\/alerts\.js'/, f);
  }
});

/* ── INJPKG-03 ───────────────────────────────────────────────────────── */
test('INJPKG-03: 알림 제목의 제어문자는 공백으로 정리한 뒤 자른다 · 메일 전체가 실패하지 않는다', async () => {
  assert.equal(headerSafeText('a\tb\r\nc\u0000d\u007fe'), 'a b c d e');
  assert.equal(headerSafeText(null), '');
  assert.equal(alerts.alertSubject({ severity: 'critical', title: 'esx-01\tDISCONNECTED\r\n' }), '[위험] esx-01 DISCONNECTED');
  assert.equal(alerts.alertSubject({ title: '\t\r\n' }), '[경고] 알림', '정리 뒤 빈 제목은 기본 제목');
  const long = alerts.alertSubject({ title: `${'\t'.repeat(50)}${'가'.repeat(300)}` });
  assert.equal(long, `[경고] ${'가'.repeat(180)}`, '제어문자를 먼저 정리하고 자른다(탭이 180자 몫을 먹지 않게)');
  // buildMime 의 throw 는 마지막 방어선으로 남는다
  assert.throws(() => buildMime({ from: 'a@x.local', to: ['b@x.local'], subject: 'x\ny', text: 't' }), /제어문자/);

  freshMail();
  resetSmtp();
  const r = await mail.sendPortalMail({ kind: 'alert', subject: 'VM\tweb-01\r\n중지', text: '본문' });
  assert.equal(r.ok, true, `제어문자가 든 제목 발송 ${JSON.stringify(r).slice(0, 200)} — 수정 전: '제목에 제어문자를 쓸 수 없습니다'`);
  assert.equal(smtp.mails, 1);
  const cfg = { suppressWindowMin: 0, channels: { email: { enabled: true } } };
  const res = await alerts.enqueueNotify({ key: 'inj-1', severity: 'warning', title: 'host\tA\r\nB' }, cfg);
  assert.deepEqual(res, ['email:ok']);
  assert.equal(smtp.mails, 2);
  await waitFor(() => smtp.cur === 0, 3000);
  freshMail();
});

/* ── VC-05 ───────────────────────────────────────────────────────────── */
test('VC-05: 데모(목업) 스냅샷의 스냅샷 정책 위반은 실제 채널로 보내지 않는다(\'지금 보내기\' 포함) · live 에서도 목업 vCenter 의 VM 은 뺀다', async () => {
  const { vmHygieneNotifyOnce, vmHygieneNotifierStatus } = await import('../src/vmhygiene/notifier.js');
  const { saveVmHygieneSettings, _resetVmHygieneSettings } = await import('../src/vmhygiene/settings.js');
  const { generateSnapshot, isMockVcenter } = await import('../src/mock/generator.js');
  const NOW = Date.UTC(2026, 9, 5, 3, 30); // KST 12:30
  const DAY = 86_400_000;
  _resetVmHygieneSettings();
  saveVmHygieneSettings({ notify: { enabled: true, hour: 9 } });
  const sent = [];
  const send = async (text) => { sent.push(text); return ['slack:200']; };
  const stateFile = path.join(DIR, 'vm-hygiene-state.json');

  // mock 모드 — 생성기 스냅샷(전 vCenter 가 목업)
  setDataSource('mock');
  try {
    const snap = generateSnapshot();
    assert.ok(snap.vms.length > 0 && snap.vcenters.every((v) => isMockVcenter(v)), '생성기 vCenter 는 전부 목업으로 판정된다');
    const f = await vmHygieneNotifyOnce({ now: NOW, force: true, send, snap });
    assert.equal(f.reason, 'demo', `mock 모드 '지금 보내기' → ${f.reason} — 수정 전: 목업 위반을 실제 채널로 보냈다`);
    assert.equal(f.sent, false);
    const p = await vmHygieneNotifyOnce({ now: NOW, send, snap });
    assert.equal(p.reason, 'demo');
    assert.equal(sent.length, 0, '보내기 함수를 부르지 않는다');
    assert.equal(fs.existsSync(stateFile), false, "데모는 그날 '보냄' 으로 기록하지 않는다");
    assert.equal(vmHygieneNotifierStatus().last?.reason, 'demo');
  } finally { setDataSource('live'); }

  // live — 목업 vCenter(id·이름 동시 일치)의 VM 은 빼고 나머지만 알린다
  const vm = (id, name, vcenterId) => ({ id, name, vcenterId, powerState: 'POWERED_ON', snapshotCount: 9, snapshotOldestTs: NOW - 30 * DAY });
  const mixed = {
    vcenters: [{ id: 'vc-us-east', name: 'vcenter-us-east-01' }, { id: 'vc1', name: 'VC1' }],
    vms: [vm('m1', 'mock-vm-zz', 'vc-us-east'), vm('r1', 'real-vm-aa', 'vc1')],
  };
  const r = await vmHygieneNotifyOnce({ now: NOW, force: true, send, snap: mixed });
  assert.equal(r.sent, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /스냅샷 정책 위반 1대/);
  assert.ok(!sent[0].includes('mock-vm-zz'), '목업 vCenter 의 VM 이름이 알림에 없다');
  assert.equal(r.mockExcluded, 1, '뺀 대수를 상태가 말한다');
  const onlyMock = { vcenters: [mixed.vcenters[0]], vms: [mixed.vms[0]] };
  const d = await vmHygieneNotifyOnce({ now: NOW, force: true, send, snap: onlyMock });
  assert.equal(d.reason, 'demo', 'live 에서도 전부 목업이면 보내지 않는다');
  assert.equal(sent.length, 1);
  _resetVmHygieneSettings();
});

/* ── TIMING-04 ───────────────────────────────────────────────────────── */
const KST = 9 * 3_600_000;
const kst = (y, mo, d, h, mi) => Date.UTC(y, mo, d, h, mi) - KST;   // 포탈 기본 오프셋 UTC+9

test('TIMING-04: 정한 시각 전의 \'지금 발송(테스트)\' 은 그날 예약 발송을 건너뛰게 만들지 않는다 · 수동 시각은 따로 남긴다', async () => {
  const dr = await import('../src/reports/dailyReport.js');
  const file = path.join(DIR, 'daily-report.json');
  fs.writeFileSync(file, JSON.stringify({ enabled: true, hour: 8, minute: 0, lastRunTs: 0 }));
  dr._resetDailyReportForTest();
  const okRun = async () => ({ ok: true });
  try {
    // ① 07:00 테스트 → 08:01 예약은 그대로 돈다
    const t0700 = kst(2026, 9, 20, 7, 0);
    Date.now = () => t0700;
    const r = await dr.runDailyReportNow({ manual: true });
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
    assert.equal(r.countedAsScheduled, false);
    let st = dr.dailyReportStatus();
    assert.equal(st.lastRunTs, 0, `예약 기준 lastRunTs=${st.lastRunTs} — 수정 전: 테스트 시각으로 세워져 그날 예약을 건너뛰었다`);
    assert.equal(st.lastManualTs, t0700);
    const tick = await dr.dailyReportTick(kst(2026, 9, 20, 8, 1), okRun);
    assert.equal(tick.ran, true, `08:01 예약 ${JSON.stringify(tick)}`);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).lastManualTs, t0700, '수동 시각은 파일에도 남는다');

    // ② 정한 시각이 지났는데 오늘 몫이 아직이면 수동 발송이 오늘 리포트다(곧바로 같은 리포트를 한 번 더 보내지 않는다)
    fs.writeFileSync(file, JSON.stringify({ enabled: true, hour: 8, minute: 0, lastRunTs: 0 }));
    dr._resetDailyReportForTest();
    const t0900 = kst(2026, 9, 21, 9, 0);
    Date.now = () => t0900;
    const r2 = await dr.runDailyReportNow({ manual: true });
    assert.equal(r2.countedAsScheduled, true);
    st = dr.dailyReportStatus();
    assert.equal(st.lastRunTs, t0900);
    assert.equal(st.lastRunBy, 'manual');
    assert.deepEqual(await dr.dailyReportTick(kst(2026, 9, 21, 9, 1), okRun), { skipped: 'not-due' });

    // ③ 예약 발송은 예전처럼 예약 기준을 세운다
    fs.writeFileSync(file, JSON.stringify({ enabled: true, hour: 8, minute: 0, lastRunTs: 0 }));
    dr._resetDailyReportForTest();
    const t0801 = kst(2026, 9, 22, 8, 1);
    Date.now = () => t0801;
    const r3 = await dr.dailyReportTick(t0801);
    assert.equal(r3.ran, true);
    st = dr.dailyReportStatus();
    assert.equal(st.lastRunTs, t0801);
    assert.equal(st.lastRunBy, 'schedule');
    assert.equal(st.lastManualTs, 0);
  } finally { Date.now = realNow; }
  dr._resetDailyReportForTest();
});

test('TIMING-04: 화면의 \'지금 발송(테스트)\' 라우트는 수동 발송으로 부른다(실제 adminRouter)', async () => {
  const dr = await import('../src/reports/dailyReport.js');
  fs.writeFileSync(path.join(DIR, 'daily-report.json'), JSON.stringify({ enabled: true, hour: 23, minute: 59, lastRunTs: 0 }));
  dr._resetDailyReportForTest();
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'full', role: 'admin', scope: null }; next(); });
  app.use('/api/admin', adminRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const t = kst(2026, 9, 23, 7, 0);
    Date.now = () => t;
    const resp = await fetch(`http://127.0.0.1:${srv.address().port}/api/admin/report/daily/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    Date.now = realNow;
    const j = await resp.json();
    assert.equal(resp.status, 200);
    assert.equal(j.ok, true, JSON.stringify(j).slice(0, 200));
    assert.equal(j.manual, true, '라우트가 manual 로 부르지 않으면 정한 시각 전 테스트가 그날 예약을 지운다');
    assert.equal(j.countedAsScheduled, false);
    assert.equal(dr.dailyReportStatus().lastRunTs, 0);
    assert.equal(dr.dailyReportStatus().lastManualTs, t);
  } finally {
    Date.now = realNow;
    await new Promise((r) => srv.close(() => r()));
  }
  dr._resetDailyReportForTest();
});
