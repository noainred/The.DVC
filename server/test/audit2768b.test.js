/**
 * v2.768 점검 3회차 수정 그룹 G2(알림·메일) 회귀 고정.
 *
 *  - C5-03  알림 엔진이 낡은 위임(site) vCenter(stale)를 못 봤다 — 엣지가 push 를 멈춰도 '수집 실패' 류 알림이 없고, 마지막 값
 *           (DS 92% 등)이 '지금 발생 중' 으로 재발송되며 실제 복구 뒤에도 해소되지 않았다 → 공용 unreadVcenterReasons(+pending·
 *           disabled)로 판정 · stale vCenter 의 alarm/host/ds 는 새로 내지 않고 해소 보류 · 보고 끊김은 별도 키(vcstale:) warning.
 *  - C2-1   GET /api/admin/mail 이 범위 계정에 status.history(전 법인 알림 메일 제목·수신자)·lastError 를 그대로 줬다 → 빼고 표지.
 *  - C5-04  PUT /mail 검증은 기존 비밀번호를 승계해 보고 save 는 호스트 변경 시 비웠다 → '계정 있음 + 비밀번호 없음' 200 저장.
 *  - C5-05  parseReply 가 마지막 줄 CRLF 를 기다리지 않아 TCP 조각('…250 STAR' + 'TTLS\r\n')에서 STARTTLS 를 놓쳤다.
 *  - C5-06  비ASCII 표시 이름이 RFC 2047 없이 From 헤더에 원시 UTF-8 로 실렸다.
 *
 * 기준 시각은 실제 시각을 정시 경계로 떨어뜨려 고정한다(docs/rules/common.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2768b-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'false';

const { store } = await import('../src/store.js');
const alerts = await import('../src/alerts.js');
const { unreadVcenterReasons } = await import('../src/metrics/unreadVcenters.js');
const mailSettings = await import('../src/mail/settings.js');
const mailService = await import('../src/mail/service.js');
const smtp = await import('../src/util/smtp.js');
const { stripComments } = await import('./_stripComments.js');

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;   // 정시 −30분 고정
// v2.769(점검 R4-D1-5): vcstale 는 기준 = max(receivedAt, 프로세스 기동 시각) — 테스트 프로세스는 방금 떴으므로 '2시간 전 기동' 으로 둔다.
alerts._setProcessStartForTest(NOW - 2 * HOUR);

/* ── C5-03 ─────────────────────────────────────────────────────────── */
const CFG = {
  cooldownMin: 60,
  rules: { criticalAlarms: { enabled: true }, vcenterDown: { enabled: true }, hostDisconnected: { enabled: true }, datastorePct: { enabled: true, threshold: 90 } },
};
const staleVc = (over = {}) => ({ id: 'vc-pl', name: 'Poland', status: 'connected', collectSource: 'site', collectedBy: 'edge-pl', stale: true, receivedAt: NOW - 3 * HOUR, ...over });
const freshVc = (over = {}) => ({ id: 'vc-pl', name: 'Poland', status: 'connected', collectSource: 'site', stale: false, receivedAt: NOW, ...over });
const dsPl = (pct) => ({ id: 'ds-pl-1', vcenterId: 'vc-pl', name: 'pl-ds1', usagePct: pct, freeGB: 80 });
const hostPl = { id: 'h-pl', name: 'esx-pl', vcenterId: 'vc-pl', connectionState: 'DISCONNECTED' };
const alarmPl = { id: 'a-pl', name: 'HA down', severity: 'critical', vcenterId: 'vc-pl', entity: 'cl1' };

async function runWith(snap) {
  const orig = store.get;
  store.get = () => snap;
  try { await alerts._refreshStateForTest(CFG, false); } finally { store.get = orig; }
  return alerts.alertStatus();
}
const resolvedKeys = (st) => new Set(st.recent.filter((r) => r.severity === 'resolved').map((r) => r.key));
const firingKeys = (st) => new Set(st.firing.map((f) => f.key));

test('C5-03 ① 낡은 위임 vCenter 의 마지막 값으로 경보·호스트·DS 알림을 새로 내지 않고, 보고 끊김을 별도 키 warning 으로 알린다', () => {
  const snap = {
    vcenters: [staleVc(), { id: 'vc-kr', name: 'Korea', status: 'unreachable', error: 'timeout' }],
    hosts: [hostPl], alarms: [alarmPl], datastores: [dsPl(92)], vms: [],
  };
  const out = alerts.evaluate(snap, CFG);
  const keys = out.map((a) => a.key).sort();
  assert.deepEqual(keys, ['vc:vc-kr', 'vcstale:vc-pl'], '마지막 값(DS 92%·끊긴 호스트·위험 알람)을 지금 발생으로 내면 안 된다');
  const s = out.find((a) => a.key === 'vcstale:vc-pl');
  assert.equal(s.severity, 'warning', '보고 끊김은 수집 실패(위험)가 아니라 확인 불가다(healthReport 와 같은 판단)');
  assert.equal(s.vcenterId, 'vc-pl', '범위 판정(scopeAlertStatus)이 vcenterId 로 거른다');
  assert.match(s.title, /엣지 보고 끊김/);
  assert.ok(out.unreadVcenters.has('vc-pl'), 'stale 도 지금 값을 못 읽은 vCenter 다');
  // 연결 불가가 stale 보다 우선한다(공용 판정 순서) — 위험 vc: 하나만, vcstale: 는 없다
  const both = alerts.evaluate({ vcenters: [staleVc({ status: 'unreachable', error: 'edge says down' })], hosts: [], alarms: [], datastores: [] }, CFG);
  assert.deepEqual(both.map((a) => a.key), ['vc:vc-pl']);
  // 점검중 표지도 stale 보다 우선 — 알림 없음(보류만)
  const mt = alerts.evaluate({ vcenters: [staleVc({ maintenance: true })], hosts: [], alarms: [], datastores: [dsPl(95)] }, CFG);
  assert.deepEqual(mt.map((a) => a.key), ['ds:ds-pl-1'], '점검중은 기존과 같다(값은 직전 캐시 — 보류 대상이지만 신규 억제는 stale 만)');
  assert.ok(mt.unreadVcenters.has('vc-pl'));
  // 규칙(vcenterDown)이 꺼져 있으면 보고 끊김 알림도 없다 — 하지만 stale 값으로 신규 발생은 여전히 내지 않는다
  const off = alerts.evaluate({ vcenters: [staleVc()], hosts: [], alarms: [], datastores: [dsPl(92)] }, { ...CFG, rules: { ...CFG.rules, vcenterDown: { enabled: false } } });
  assert.deepEqual(off.map((a) => a.key), []);
});

test('C5-03 ② 이미 발생 중이던 알림은 stale 동안 해소하지도 재발송하지도 않고, 보고가 다시 오면 그때 판정한다', async () => {
  alerts._resetAlertStateForTest();
  let st = await runWith({ vcenters: [freshVc()], hosts: [hostPl], alarms: [alarmPl], datastores: [dsPl(92)], vms: [] });
  assert.deepEqual([...firingKeys(st)].sort(), ['alarm:a-pl', 'ds:ds-pl-1', 'host:h-pl']);
  // 엣지가 push 를 멈췄다 — store 는 마지막 값을 그대로 두고 stale:true 만 붙인다
  st = await runWith({ vcenters: [staleVc()], hosts: [hostPl], alarms: [alarmPl], datastores: [dsPl(92)], vms: [] });
  assert.equal(resolvedKeys(st).size, 0, '모름을 복구로 기록하면 안 된다');
  for (const k of ['alarm:a-pl', 'ds:ds-pl-1', 'host:h-pl', 'vcstale:vc-pl']) assert.ok(firingKeys(st).has(k), `${k} 는 발생 상태 유지`);
  // 보류 중인 키는 이번 평가 목록에 없다 → tick 의 발송 루프(목록 순회)가 재발송하지 않는다
  const out = alerts.evaluate({ vcenters: [staleVc()], hosts: [hostPl], alarms: [alarmPl], datastores: [dsPl(92)] }, CFG);
  assert.ok(!out.some((a) => /^(alarm|host|ds):/.test(a.key)));
  // 실제로 복구됐다(새 보고) — 그때 해소하고, 보고 끊김도 해소된다
  st = await runWith({ vcenters: [freshVc()], hosts: [], alarms: [], datastores: [dsPl(50)], vms: [] });
  assert.deepEqual([...resolvedKeys(st)].sort(), ['alarm:a-pl', 'ds:ds-pl-1', 'host:h-pl', 'vcstale:vc-pl']);
  assert.equal(st.firing.length, 0);
});

test('C5-03 ③ 판정은 한 벌 — unreadVcenterIds = 공용 unreadVcenterReasons + pending·disabled, 상태 목록 사본 없음', () => {
  const snap = {
    vcenters: [
      { id: 'a', status: 'connected' }, { id: 'b', status: 'unreachable' }, { id: 'c', status: 'maintenance' },
      { id: 'd', status: 'connected', maintenance: true }, { id: 'e', status: 'connected', stale: true },
      { id: 'f', status: 'pending' }, { id: 'g', status: 'disabled' }, null, { status: 'unreachable' },
    ],
  };
  const want = new Set([...unreadVcenterReasons(snap).keys(), 'f', 'g']);
  assert.deepEqual([...alerts.unreadVcenterIds(snap)].sort(), [...want].sort());
  assert.deepEqual([...want].sort(), ['b', 'c', 'd', 'e', 'f', 'g']);
  const src = stripComments(fs.readFileSync(new URL('../src/alerts.js', import.meta.url), 'utf8'));
  assert.ok(src.includes("from './metrics/unreadVcenters.js'"), '공용 판정을 import 한다');
  assert.ok(!/UNREAD_VC_STATUS\s*=\s*new Set\(\[[^\]]*'unreachable'/.test(src), "'unreachable'·'maintenance' 상태 목록 사본을 다시 두지 말 것");
});

/* ── C2-1 ──────────────────────────────────────────────────────────── */
async function mailApp(user) {
  const express = (await import('express')).default;
  const { registerMail } = await import('../src/routes/admin/mail.js');
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  const r = express.Router(); registerMail(r); app.use('/api/admin', r);
  const srv = app.listen(0, '127.0.0.1'); await new Promise((x) => srv.once('listening', x));
  return { srv, base: `http://127.0.0.1:${srv.address().port}/api/admin` };
}

test('C2-1 범위 계정의 GET /admin/mail 에는 발송 이력·최근 오류를 싣지 않고 뺀 사실을 밝힌다(전체 범위는 그대로)', async () => {
  mailService._resetMail();
  // 메일 기능이 꺼진 기본 상태에서도 알림 메일 시도는 이력(skipped)에 제목과 함께 남는다
  await mailService.sendPortalMail({ kind: 'alert', subject: alerts.alertSubject({ severity: 'critical', title: 'vCenter 수집 실패: vcsa-pl01.corp.example' }) });
  const scoped = await mailApp({ username: 'kr-admin', role: 'admin', scope: { vcenters: ['vc-kr'] } });
  try {
    const j = await (await fetch(`${scoped.base}/mail`)).json();
    assert.deepEqual(j.status.history, [], '다른 법인 알림 메일 제목이 범위 계정에 나가면 안 된다');
    assert.equal(j.status.lastError, null);
    assert.equal(j.status.scoped, true);
    assert.deepEqual(j.status.omittedOutOfScope, { history: 1, lastError: false });
    assert.ok(!JSON.stringify(j).includes('vcsa-pl01'));
    assert.ok(j.settings && j.kinds, '설정·종류 목록은 그대로(전 법인 공용 설정 조회 — v2.604 정책)');
  } finally { scoped.srv.close(); }
  const full = await mailApp({ username: 'root', role: 'admin' });
  try {
    const j = await (await fetch(`${full.base}/mail`)).json();
    assert.equal(j.status.history.length, 1);
    assert.match(j.status.history[0].subject, /vcsa-pl01/);
    assert.equal(j.status.scoped, undefined);
  } finally { full.srv.close(); }
});

/* ── C5-04 ─────────────────────────────────────────────────────────── */
test('C5-04 ① nextSmtpPassword — save 와 PUT 검증의 승계식 한 벌(v2.480 호스트 변경 시 미승계 유지)', () => {
  const cur = { host: 'smtp-old.corp.local', password: 'Secret1!' };
  assert.deepEqual(mailSettings.nextSmtpPassword({ host: 'smtp-old.corp.local' }, cur), { password: 'Secret1!', dropped: null });
  assert.deepEqual(mailSettings.nextSmtpPassword({}, cur), { password: 'Secret1!', dropped: null });
  assert.deepEqual(mailSettings.nextSmtpPassword({ host: 'smtp-new.corp.local' }, cur), { password: '', dropped: 'hostChanged' });
  assert.deepEqual(mailSettings.nextSmtpPassword({ host: 'smtp-new.corp.local', password: 'N3w!' }, cur), { password: 'N3w!', dropped: null });
  assert.deepEqual(mailSettings.nextSmtpPassword({ clearPassword: true }, cur), { password: '', dropped: 'cleared' });
  assert.deepEqual(mailSettings.nextSmtpPassword({ host: 'x' }, { host: 'y', password: '' }), { password: '', dropped: null });
  // smtpIssue 문구가 사유별로 갈린다 — 예전 '(이미 저장돼 있다면 비워 두세요)' 는 어느 경우에도 맞지 않았다
  const s = { host: 'h', from: 'p@corp.local', port: 25, user: 'relay', password: '' };
  assert.match(mailSettings.smtpIssue(s, 'hostChanged'), /새 서버의 비밀번호를 다시 입력/);
  assert.match(mailSettings.smtpIssue(s, 'cleared'), /계정도 비우세요/);
  assert.match(mailSettings.smtpIssue(s), /저장된 비밀번호가 없습니다/);
  assert.ok(!/이미 저장돼 있다면/.test(mailSettings.smtpIssue(s)));
});

test('C5-04 ② PUT /admin/mail — 호스트만 바꾸고 비밀번호를 비우거나 clearPassword 면 400(저장하지 않는다)', async () => {
  mailSettings.save({ enabled: true, defaultTo: ['ops@corp.local'], smtp: { host: 'smtp-old.corp.local', port: 587, user: 'relay', password: 'Secret1!', from: 'portal@corp.local' } });
  const app = await mailApp({ username: 'root', role: 'admin' });
  const put = (body) => fetch(`${app.base}/mail`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    let r = await put({ enabled: true, smtp: { host: 'smtp-new.corp.local', user: 'relay', from: 'portal@corp.local', port: 587 } });
    assert.equal(r.status, 400);
    assert.match((await r.json()).reason, /새 서버의 비밀번호를 다시 입력/);
    assert.equal(mailSettings.load().smtp.host, 'smtp-old.corp.local', '400 이면 저장하지 않는다');
    assert.equal(mailSettings.load().smtp.password, 'Secret1!');
    r = await put({ enabled: true, smtp: { host: 'smtp-old.corp.local', user: 'relay', from: 'portal@corp.local', port: 587, clearPassword: true } });
    assert.equal(r.status, 400);
    assert.match((await r.json()).reason, /계정도 비우세요/);
    // 정상 경로는 그대로 — 같은 호스트 + 빈 칸 = 기존 유지, 새 호스트 + 새 비밀번호 = 저장
    r = await put({ enabled: true, smtp: { host: 'smtp-old.corp.local', user: 'relay', from: 'portal@corp.local', port: 587 } });
    assert.equal(r.status, 200);
    assert.equal(mailSettings.load().smtp.password, 'Secret1!');
    r = await put({ enabled: true, smtp: { host: 'smtp-new.corp.local', user: 'relay', password: 'N3w!', from: 'portal@corp.local', port: 587 } });
    assert.equal(r.status, 200);
    assert.equal(mailSettings.load().smtp.host, 'smtp-new.corp.local');
    assert.equal(mailSettings.load().smtp.password, 'N3w!');
    // 계정 없이(user 비움) 호스트를 바꾸는 것은 허용 — 비밀번호가 필요 없다
    r = await put({ enabled: true, smtp: { host: 'smtp-3.corp.local', user: '', from: 'portal@corp.local', port: 25 } });
    assert.equal(r.status, 200);
    assert.equal(mailSettings.load().smtp.password, '', '접속처가 바뀌면 비밀번호를 승계하지 않는다(v2.480)');
  } finally { app.srv.close(); }
});

/* ── C5-05 ─────────────────────────────────────────────────────────── */
test('C5-05 ① parseReply 는 줄바꿈으로 끝날 때만 완성이다', () => {
  assert.equal(smtp.parseReply('250-smtp.corp.local\r\n250-AUTH PLAIN\r\n250 STAR'), null, '마지막 줄이 덜 온 조각');
  const r = smtp.parseReply('250-smtp.corp.local\r\n250-AUTH PLAIN\r\n250 STARTTLS\r\n');
  assert.equal(r.code, 250);
  assert.ok(smtp.ehloCaps(r).has('STARTTLS'));
  assert.equal(smtp.parseReply('220 ready\n').code, 220, 'LF 만 쓰는 서버도 받는다');
  assert.equal(smtp.parseReply('250-a\r\n'), null, '멀티라인 진행 중');
  // 긴 입력에서도 선형(끝 한 글자만 본다) — 비율로 확인
  const big = '250-x\r\n'.repeat(20000);
  const t0 = process.hrtime.bigint(); smtp.parseReply(big); const t1 = process.hrtime.bigint();
  smtp.parseReply(big + big); const t2 = process.hrtime.bigint();
  assert.ok(Number(t2 - t1) < Number(t1 - t0) * 8 + 5e7, '입력 2배에 시간이 폭증하면 안 된다');
});

test('C5-05 ② TCP 조각으로 잘린 EHLO 응답에서도 STARTTLS 를 본다(계정 있음 — 광고 없음 거부 동작은 유지)', async () => {
  // 가짜 SMTP: EHLO 응답의 마지막 줄을 '250 STAR' / 'TTLS\r\n' 두 조각으로 50ms 간격을 두고 보낸다. STARTTLS 를 받으면 454 로
  //   거절해 대화를 끝낸다(TLS 협상까지는 가지 않는다 — 'STARTTLS 를 보냈는가' 만 본다).
  const seen = [];
  const srv = net.createServer((sock) => {
    sock.write('220 fake ready\r\n');
    sock.on('data', (d) => {
      const line = String(d).trim(); seen.push(line);
      if (/^EHLO/i.test(line)) { sock.write('250-fake\r\n250-AUTH PLAIN\r\n250 STAR'); setTimeout(() => sock.write('TTLS\r\n'), 50); }
      else if (/^STARTTLS/i.test(line)) sock.write('454 not now\r\n');
      else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('500 ?\r\n');
    });
  });
  srv.listen(0, '127.0.0.1'); await new Promise((x) => srv.once('listening', x));
  try {
    const err = await smtp.sendMail({ host: '127.0.0.1', port: srv.address().port, startTls: true, user: 'relay', password: 'pw', from: 'p@corp.local', timeoutMs: 5000 },
      { to: ['a@corp.local'], subject: 's', text: 't' }).then(() => null, (e) => e);
    assert.ok(err, '454 로 거절했으니 실패해야 한다');
    assert.ok(seen.some((l) => /^STARTTLS/i.test(l)), `조각난 광고를 놓치면 STARTTLS 를 보내지 않는다 — 받은 명령: ${seen.join(' / ')}`);
    assert.ok(!/광고하지 않습니다/.test(err.message));
  } finally { srv.close(); }
});

/* ── C5-06 ─────────────────────────────────────────────────────────── */
test('C5-06 비ASCII 표시 이름은 RFC 2047 encoded-word 로 — From 헤더에 원시 UTF-8 이 없다', () => {
  assert.equal(smtp.formatDisplayName('VMware Portal'), 'VMware Portal');
  assert.equal(smtp.formatDisplayName('Ops (KR), team'), '"Ops (KR), team"');
  assert.equal(smtp.formatDisplayName('a"b<c>\r\nd'), 'abcd', '따옴표·꺾쇠·제어문자 제거는 그대로');
  assert.equal(smtp.formatDisplayName(''), '');
  const enc = smtp.formatDisplayName('VMware 포탈');
  assert.match(enc, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  assert.ok(!enc.startsWith('"'), 'encoded-word 는 따옴표 안에 두면 해석되지 않는다');
  const dec = (s) => s.split(' ').map((w) => Buffer.from(/^=\?UTF-8\?B\?([^?]*)\?=$/.exec(w)[1], 'base64').toString('utf8')).join('');
  assert.equal(dec(enc), 'VMware 포탈');
  // 긴 이름은 75자 상한 안의 여러 단어로 — 이어 붙이면 원래 이름(코드포인트 경계에서만 자른다)
  const long = '가상화 운영 포탈 알림 발송 계정 '.repeat(4);
  const words = smtp.formatDisplayName(long).split(' ');
  assert.ok(words.length > 1);
  for (const w of words) assert.ok(w.length <= 75, `encoded-word 길이 ${w.length}`);
  assert.equal(dec(words.join(' ')), long.trim().slice(0, 80));
  const m = smtp.buildMime({ from: `${enc} <portal@corp.local>`, to: ['a@corp.local'], subject: '테스트', text: 'x' });
  const from = m.split('\r\n').find((l) => l.startsWith('From:'));
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[^\x00-\x7f]/.test(from), from);
  assert.ok(from.endsWith('<portal@corp.local>'), '주소부는 그대로');
  // mail/service.js 는 같은 함수를 쓴다(사본 금지)
  const svc = stripComments(fs.readFileSync(new URL('../src/mail/service.js', import.meta.url), 'utf8'));
  assert.ok(svc.includes('formatDisplayName(headerName)'));
  assert.ok(!/function quoteName/.test(svc));
});
