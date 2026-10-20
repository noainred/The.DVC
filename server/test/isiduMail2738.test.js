/**
 * test/isiduMail2738.test.js — 아이실론 디렉터리 사용량 결과 메일(v2.738).
 *
 * 사용자 요청: "결과가 나오면 결과를 이메일로 보내고 싶어, 1개의 결과에 다수개의 이메일을 등록할수도 있고, 전체 공통으로 보낼수도 있고".
 *   ① 주소 목록 규칙(나누기·형식 거부·중복 한 번·상한) ② 수신자 = 공통 ∪ 대상별(공통 빼기) ③ '변화 없음' 판정(반올림 범위)
 *   ④ 설정 저장(실제 api 라우터 — 잘못된 주소 400 · 엣지 사본에 메일 없음 · 메일 준비 상태)
 *   ⑤ 실제 발송(가짜 SMTP) — 적재된 결과마다 한 번 · 수신자 합집합 · 같은 결과 두 번 안 보냄 · 변화 없으면 생략 · 실패 알림 6시간 · 데모 안 보냄
 *   ⑥ 엣지는 보내지 않는다 · 중앙 수신(/api/central/isidu-data)이 적재한 결과도 보낸다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'isidumail2738-'));
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'false' });
delete process.env.CENTRAL_URL;
process.env.CENTRAL_TOKEN = 'ctok-2738'; // ⑥ 중앙 수신 라우터용 — CENTRAL_URL 이 없으므로 이 프로세스는 중앙이다
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const writeJson = (n, v) => fs.writeFileSync(path.join(TMP, n), JSON.stringify(v, null, 2));
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

/** 받은 원문 → 제목(RFC 2047 해석)·본문(base64 구획 해석 — util/smtp.js 는 본문을 늘 base64 로 보낸다). */
function decodeMail(raw) {
  const m = /^Subject: (.*)$/mi.exec(raw);
  const subject = m ? m[1].replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_x, b) => Buffer.from(b, 'base64').toString('utf8')) : '';
  const out = []; let mode = 'hdr'; let buf = '';
  for (const line of raw.split('\n')) {
    if (/^Content-Transfer-Encoding:\s*base64/i.test(line)) { mode = 'wait'; continue; }
    if (mode === 'wait' && line.trim() === '') { mode = 'b64'; buf = ''; continue; }
    if (mode === 'b64') {
      if (line.trim() === '' || line.startsWith('--')) { out.push(Buffer.from(buf, 'base64').toString('utf8')); mode = 'hdr'; continue; }
      buf += line.trim();
    }
  }
  if (mode === 'b64' && buf) out.push(Buffer.from(buf, 'base64').toString('utf8'));
  return { subject, data: out.join('\n') };
}

/** 받은 메일(수신자·제목)을 기록하는 가짜 SMTP. */
async function fakeSmtp() {
  const st = { mails: [] };
  const srv = net.createServer((sock) => {
    let buf = ''; let inData = false; let cur = { rcpt: [], data: '' };
    sock.write('220 fake ESMTP\r\n');
    const handle = (line) => {
      if (inData) {
        if (line === '.') { inData = false; st.mails.push({ rcpt: cur.rcpt, ...decodeMail(cur.data) }); cur = { rcpt: [], data: '' }; sock.write('250 2.0.0 queued\r\n'); }
        else cur.data += `${line}\n`;
        return;
      }
      const u = line.toUpperCase();
      if (u.startsWith('EHLO')) sock.write('250-fake\r\n250 OK\r\n');
      else if (u.startsWith('MAIL FROM')) sock.write('250 ok\r\n');
      else if (u.startsWith('RCPT TO')) { cur.rcpt.push(line.replace(/^RCPT TO:\s*<?/i, '').replace(/>.*$/, '')); sock.write('250 ok\r\n'); }
      else if (u === 'DATA') { inData = true; sock.write('354 go\r\n'); }
      else if (u === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('250 ok\r\n');
    };
    sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); handle(l); } });
    sock.on('error', () => {});
  });
  const port = await listen(srv);
  closers.push(() => new Promise((r) => srv.close(() => r())));
  return { st, port };
}

/* ── ① 주소 목록 ─────────────────────────────────────────────────────────── */
test('① 주소 목록 — 줄바꿈·쉼표·세미콜론으로 나누고, 형식이 틀리면 invalid · 같은 주소(대소문자 무시)는 한 번 · 50개 상한', async () => {
  const R = await import('../src/isidu/mailRules.js');
  const n = R.normalizeMailList('a@corp.local, B@corp.local;\nb@CORP.local  c@x.co\nnot-mail\nd@corp');
  assert.deepEqual(n.list, ['a@corp.local', 'B@corp.local', 'c@x.co']);
  assert.deepEqual(n.invalid, ['not-mail', 'd@corp']);
  assert.equal(n.dupes, 1);
  const many = Array.from({ length: 55 }, (_, i) => `u${i}@corp.local`);
  const m = R.normalizeMailList(many);
  assert.equal(m.list.length, 50); assert.equal(m.over, 5);
  assert.equal(R.isEmail('x"y@corp.local'), false, '따옴표는 메일 헤더를 깨뜨린다');
  assert.equal(R.isEmail('a@b.c\r\nBcc: z@evil'), false, '헤더 주입');
  // 저장 경로: 형식이 틀린 주소는 거부(조용히 빼지 않는다)
  const bad = R.normalizeTargetMail({ to: 'ok@corp.local\nbad' }, null);
  assert.equal(bad.field, 'mail.to'); assert.match(bad.error, /bad/);
  const keep = R.normalizeTargetMail(undefined, { to: ['p@corp.local'], onFailure: true });
  // v2.745: 보내는 때 필드(when·days·time·skipIfNoNew·since)가 기본값으로 함께 채워진다(옛 저장값 = 조사마다).
  assert.deepEqual(keep.mail, { to: ['p@corp.local'], excludeCommon: false, onlyOnChange: false, onFailure: true, when: 'scan', days: [1], time: '08:00', skipIfNoNew: true, since: null }, '메일 필드가 없는 저장 요청은 이전 값을 유지한다');
});

/* ── ② 수신자 ─────────────────────────────────────────────────────────── */
test('② 수신자 = 공통 ∪ 대상별 · 같은 주소는 한 번 · 공통 빼기', async () => {
  const R = await import('../src/isidu/mailRules.js');
  const r = R.mailRecipients(['ops@corp.local', 'Lead@corp.local'], { to: ['lead@corp.local', 'owner@corp.local'] });
  assert.deepEqual(r.to, ['ops@corp.local', 'Lead@corp.local', 'owner@corp.local']);
  assert.equal(r.dupes, 1); assert.equal(r.fromCommon, 2); assert.equal(r.fromTarget, 1);
  assert.deepEqual(R.mailRecipients(['ops@corp.local'], { to: ['owner@corp.local'], excludeCommon: true }).to, ['owner@corp.local']);
  assert.deepEqual(R.mailRecipients([], { to: [] }).to, [], '둘 다 비면 보내지 않는다');
});

/* ── ③ 변화 판정 ─────────────────────────────────────────────────────────── */
test('③ 변화 없음 = 상위 N 구성이 같고 상위 폴더·합계 차이가 반올림 범위 안', async () => {
  const R = await import('../src/isidu/mailRules.js');
  const G = 1024 ** 3;
  const prev = { entries: new Map([['a', { bytes: 40 * G, res: 0.1 * G }], ['b', { bytes: 12 * G, res: 0.1 * G }], ['c', { bytes: 1 * G, res: 0.1 * G }]]), total: { bytes: 53 * G, res: 0.3 * G } };
  const same = { rows: [{ name: 'a', bytes: 40.05 * G, res: 0.1 * G }, { name: 'b', bytes: 12 * G, res: 0.1 * G }], total: { bytes: 53 * G, res: 0.3 * G } };
  assert.equal(R.changeSummary(same, prev, 2).changed, false);
  const moved = { rows: [{ name: 'a', bytes: 45 * G, res: 0.1 * G }, { name: 'b', bytes: 12 * G, res: 0.1 * G }], total: { bytes: 53 * G, res: 0.3 * G } };
  assert.deepEqual(R.changeSummary(moved, prev, 2).reasons, ['상위 폴더 1개 크기 변화']);
  const entered = { rows: [{ name: 'a', bytes: 40 * G, res: 0.1 * G }, { name: 'z', bytes: 13 * G, res: 0.1 * G }], total: { bytes: 53 * G, res: 0.3 * G } };
  assert.match(R.changeSummary(entered, prev, 2).reasons[0], /구성 변경/);
  const tot = { rows: same.rows, total: { bytes: 60 * G, res: 0.3 * G } };
  assert.deepEqual(R.changeSummary(tot, prev, 2).reasons, ['전체 합계 변화']);
  assert.equal(R.changeSummary(same, null, 2).first, true, '직전 성공 조사가 없으면 첫 결과 — 보낸다');
  assert.equal(R.failAlertDue(null), true);
  assert.equal(R.failAlertDue(1_000_000, 1_000_000 + 5 * 3_600_000), false);
  assert.equal(R.failAlertDue(1_000_000, 1_000_000 + 6 * 3_600_000), true);
});

/* ── ⑤ 실제 발송(가짜 SMTP) ─────────────────────────────────────────────── */
const G = 1024 ** 3;
const ROOT = '/ifs/data/users';
const scanRec = (targetId, ts, entries, extra = {}) => {
  const sum = entries.reduce((a, e) => a + e[1], 0);
  return {
    agent: '', node: '', targetId, ts, ok: true, path: ROOT, host: '10.0.0.5', sizeMode: 'h', durationMs: 42_000, trig: 'schedule',
    total: { bytes: sum, res: 0.1 * G }, sumBytes: sum, sumRes: 0.1 * G * entries.length, count: entries.length, skipped: 0, errLines: 0,
    entries: entries.map(([name, bytes]) => ({ name, bytes, res: Math.round(0.1 * G) })), ...extra,
  };
};
const failRec = (targetId, ts) => ({ agent: '', node: '', targetId, ts, ok: false, path: ROOT, host: '10.0.0.5', sizeMode: 'h', durationMs: 1000, trig: 'schedule', kind: 'timeout', error: 'du 시한 초과(30분)' });

let smtp = null;
async function setup() {
  if (smtp) return smtp;
  smtp = await fakeSmtp();
  writeJson('mail.json', { enabled: true, smtp: { host: '127.0.0.1', port: smtp.port, startTls: false, user: '', password: '', from: 'portal@corp.local', timeoutMs: 5000 }, defaultTo: ['default@corp.local'], kinds: {}, rateLimitPerHour: 0 });
  writeJson('isidu-settings.json', {
    retentionDays: 400,
    mail: { commonTo: ['ops@corp.local'] },
    targets: [
      { id: 'tg1', label: '사용자 홈', host: '10.0.0.5', username: 'admin', path: ROOT, topN: 2, mail: { to: ['owner@corp.local', 'OPS@corp.local'], onFailure: true } },
      { id: 'tg2', label: '변화만', host: '10.0.0.6', username: 'admin', path: ROOT, topN: 2, mail: { to: ['x@corp.local'], onlyOnChange: true, excludeCommon: true } },
      { id: 'tg-none', label: '메일 없음', host: '10.0.0.7', username: 'admin', path: ROOT, topN: 2, mail: { to: [], excludeCommon: true } },
      { id: 'mock-demo', label: '데모', host: '10.0.0.8', username: 'admin', path: ROOT, topN: 2, mail: { to: ['d@corp.local'] } },
    ],
  });
  const { invalidate } = await import('../src/mail/settings.js'); invalidate();
  const mail = await import('../src/mail/service.js'); mail._resetMail?.();
  return smtp;
}
const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000 - 10 * 86_400_000;   // 정시 −30분 기준(경계에서 떨어뜨림 — v2.517 규약)

test('⑤ 결과가 적재될 때마다 한 번 — 수신자 합집합(같은 주소 한 번) · 같은 결과 재전송은 안 보냄 · 오래된 결과는 안 보냄', async () => {
  const s = await setup();
  const db = await import('../src/isidu/db.js');
  const N = await import('../src/isidu/notify.js');
  const r1 = await db.insertScan(scanRec('tg1', T0, [['alpha', 40 * G], ['beta', 12 * G], ['gamma', 1 * G]]));
  assert.equal(r1.ok, true, r1.error);
  const o1 = await N.notifyScanStored({ targetId: 'tg1', scanId: r1.id, ok: true, ts: T0 });
  assert.equal(o1.state, 'sent', JSON.stringify(o1));
  assert.equal(s.st.mails.length, 1);
  assert.deepEqual(s.st.mails[0].rcpt, ['ops@corp.local', 'owner@corp.local'], '공통 + 대상별, OPS@ 는 같은 주소라 한 번');
  assert.ok(!s.st.mails[0].rcpt.includes('default@corp.local'), '메일 설정의 기본 수신자로 새지 않는다(명시 수신자)');
  assert.equal(N.isiduMailStateOf('tg1').state, 'sent');
  assert.equal(N.isiduMailStateOf('tg1').to, 2);
  assert.ok(!JSON.stringify(N.isiduMailStateOf('tg1')).includes('owner@'), '상태에 주소를 남기지 않는다(개수만)');
  // 같은 조사를 다시 알려도(엣지 재전송) 보내지 않는다
  const o2 = await N.notifyScanStored({ targetId: 'tg1', scanId: r1.id, ok: true, ts: T0 });
  assert.equal(o2.state, 'duplicate');
  assert.equal(s.st.mails.length, 1);
  // 이미 보낸 것보다 오래된 결과(엣지가 밀린 결과를 늦게 보냄)
  const old = await db.insertScan(scanRec('tg1', T0 - 86_400_000, [['alpha', 39 * G]]));
  const o3 = await N.notifyScanStored({ targetId: 'tg1', scanId: old.id, ok: true, ts: T0 - 86_400_000 });
  assert.equal(o3.state, 'older');
  assert.equal(s.st.mails.length, 1);
  // 본문: 상위 2개 · 폴더 이름은 HTML 이스케이프
  assert.match(s.st.mails[0].data, /alpha/);
});

test('⑤ 변화 없으면 생략 — 첫 결과는 보내고, 반올림 범위 안이면 생략, 바뀌면 보낸다', async () => {
  const s = await setup();
  const db = await import('../src/isidu/db.js');
  const N = await import('../src/isidu/notify.js');
  const before = s.st.mails.length;
  const a = await db.insertScan(scanRec('tg2', T0, [['u1', 30 * G], ['u2', 10 * G]]));
  assert.equal((await N.notifyScanStored({ targetId: 'tg2', scanId: a.id, ok: true, ts: T0 })).state, 'sent', '첫 결과');
  assert.deepEqual(s.st.mails.at(-1).rcpt, ['x@corp.local'], '공통 빼기');
  const b = await db.insertScan(scanRec('tg2', T0 + 86_400_000, [['u1', 30 * G + 0.05 * G], ['u2', 10 * G]]));
  const ob = await N.notifyScanStored({ targetId: 'tg2', scanId: b.id, ok: true, ts: T0 + 86_400_000 });
  assert.equal(ob.state, 'unchanged');
  assert.match(N.isiduMailStateOf('tg2').reason, /변화 없으면 생략/);
  const c = await db.insertScan(scanRec('tg2', T0 + 2 * 86_400_000, [['u1', 35 * G], ['u2', 10 * G]]));
  assert.equal((await N.notifyScanStored({ targetId: 'tg2', scanId: c.id, ok: true, ts: T0 + 2 * 86_400_000 })).state, 'sent');
  assert.equal(s.st.mails.length, before + 2);
  assert.match(s.st.mails.at(-1).data, /상위 폴더 1개 크기 변화/, '무엇이 바뀌었는지 본문이 말한다');
});

test('⑤ 실패 알림 — 고른 대상만, 6시간에 한 번 · 데모 대상·수신자 없는 대상은 보내지 않는다', async () => {
  const s = await setup();
  const db = await import('../src/isidu/db.js');
  const N = await import('../src/isidu/notify.js');
  const before = s.st.mails.length;
  const f1 = await db.insertScan(failRec('tg1', T0 + 3 * 86_400_000));
  const o1 = await N.notifyScanStored({ targetId: 'tg1', scanId: f1.id, ok: false, ts: T0 + 3 * 86_400_000 });
  assert.equal(o1.state, 'sent', JSON.stringify(o1));
  assert.match(s.st.mails.at(-1).subject, /조사 실패 — 사용자 홈/);
  const f2 = await db.insertScan(failRec('tg1', T0 + 3 * 86_400_000 + 60_000));
  const o2 = await N.notifyScanStored({ targetId: 'tg1', scanId: f2.id, ok: false, ts: T0 + 3 * 86_400_000 + 60_000 });
  assert.equal(o2.state, 'throttled');
  // 실패 알림을 고르지 않은 대상(tg2)
  const f3 = await db.insertScan(failRec('tg2', T0 + 3 * 86_400_000));
  assert.equal((await N.notifyScanStored({ targetId: 'tg2', scanId: f3.id, ok: false, ts: T0 + 3 * 86_400_000 })).state, 'no-failure-alert');
  // 수신자 없음 · 데모
  const n1 = await db.insertScan(scanRec('tg-none', T0, [['a', G]]));
  assert.equal((await N.notifyScanStored({ targetId: 'tg-none', scanId: n1.id, ok: true, ts: T0 })).state, 'no-recipients');
  assert.equal(N.isiduMailStateOf('tg-none'), null, '메일을 고르지 않은 대상은 기록도 남기지 않는다');
  const d1 = await db.insertScan(scanRec('mock-demo', T0, [['a', G]]));
  assert.equal((await N.notifyScanStored({ targetId: 'mock-demo', scanId: d1.id, ok: true, ts: T0 })).state, 'demo');
  assert.equal(s.st.mails.length, before + 1, '실패 알림 1건만');
});

/* ── ⑥ 엣지는 보내지 않는다 · 중앙 수신이 적재한 엣지 결과도 보낸다 ─────────── */
test('⑥ 엣지 노드는 메일을 보내지 않는다 · 중앙 /api/central/isidu-data 가 새로 적재한 결과는 보내고 재전송은 보내지 않는다', async () => {
  const s = await setup();
  const N = await import('../src/isidu/notify.js');
  const { config } = await import('../src/config.js');
  const keep = { centralUrl: config.agent.centralUrl, centralToken: config.agent.centralToken };
  Object.assign(config.agent, { centralUrl: 'https://central.example.invalid', centralToken: 'x' });
  try { assert.equal((await N.notifyScanStored({ targetId: 'tg1', scanId: 999, ok: true, ts: T0 + 9e6 })).state, 'edge'); }
  finally { Object.assign(config.agent, keep); }

  // 엣지 edge-a 가 담당하는 아이실론 + 메일을 고른 대상
  const reg = await import('../src/storage/registry.js');
  const dev = reg.saveDevice({ type: 'isilon', name: 'ISI-E', host: '10.20.30.41', username: 'root', password: 'pw-2738', agent: 'edge-a', datacenterId: '' });
  const S = await import('../src/isidu/settings.js');
  const { pickAgent, pickDatacenter } = await import('../src/cvp/formChoices.js');
  const cur = S.loadSettings();
  const r = S.saveSettings({ ...cur, targets: [...cur.targets, { id: 'tg-edge', label: '엣지 대상', deviceId: dev.id, path: ROOT, auth: 'key', username: 'admin', mail: { to: ['edge-owner@corp.local'], excludeCommon: true } }] },
    { devices: reg.listDevices(), agents: ['edge-a'], dcs: [], pickAgent, pickDatacenter, ssrfBlockReason: () => null });
  assert.equal(r.ok, true, r.error);
  // 엣지로 내려가는 사본에는 메일 설정이 없다(주소를 엣지에 퍼뜨리지 않는다)
  const edgeView = S.edgeTargetView(S.resolveTarget(r.settings.targets.find((x) => x.id === 'tg-edge'), { devices: reg.listDevices() }));
  assert.equal('mail' in edgeView, false);
  assert.ok(!JSON.stringify(edgeView).includes('edge-owner@'));

  const { centralRouter } = await import('../src/routes/central.js');
  const app = express(); app.use(express.json({ limit: '16mb' })); app.use('/api/central', centralRouter);
  const srv = http.createServer(app); const port = await listen(srv);
  closers.push(() => new Promise((rr) => { srv.closeAllConnections?.(); srv.close(() => rr()); }));
  const ts = Date.now() - 120_000;
  const body = { agent: 'edge-a', status: {}, scans: [{ id: 7, targetId: 'tg-edge', ts, ok: true, path: ROOT, host: '10.20.30.41', sizeMode: 'h', durationMs: 3000, total: { bytes: 5 * G, res: 0.1 * G }, sumBytes: 5 * G, sumRes: 0.1 * G, entries: [['kim', 4 * G, 0.1 * G], ['lee', 1 * G, 0.1 * G]] }] };
  const before = s.st.mails.length;
  const post = () => fetch(`http://127.0.0.1:${port}/api/central/isidu-data?agent=edge-a`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': 'ctok-2738', 'X-Agent-Name': 'edge-a' }, body: JSON.stringify(body) });
  const res1 = await post();
  assert.equal(res1.status, 200, await res1.clone().text());
  // 발송은 응답을 기다리지 않는다 — 기록이 생길 때까지 잠깐 본다
  for (let i = 0; i < 50 && s.st.mails.length === before; i++) await new Promise((rr) => setTimeout(rr, 40));
  assert.equal(s.st.mails.length, before + 1, '엣지 결과도 중앙이 받아 적재하면 보낸다');
  assert.deepEqual(s.st.mails.at(-1).rcpt, ['edge-owner@corp.local']);
  assert.match(s.st.mails.at(-1).data, /kim/);
  const res2 = await post();   // 같은 결과 재전송(중복 적재)
  assert.equal((await res2.json()).saved.duplicates, 1);
  await new Promise((rr) => setTimeout(rr, 200));
  assert.equal(s.st.mails.length, before + 1, '재전송은 보내지 않는다');
});

/* ── ④ 설정 저장·조회(실제 api 라우터) ─────────────────────────────────── */
async function call(method, url, body) {
  const { api } = await import('../src/routes/api.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'root', role: 'admin', superAdmin: true, scope: {} }; next(); });
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message || err) }));
  const srv = http.createServer(app); const port = await listen(srv);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { srv.closeAllConnections?.(); srv.close(); }
}

test('④ 설정 — 잘못된 주소는 400(field) · 공통 수신자 저장 · 메일 준비 상태 · 지금 보내기 · 목록에는 주소 대신 개수', async () => {
  await setup();
  const g = await call('GET', '/tools/isilon-dirusage/settings');
  assert.equal(g.status, 200);
  assert.deepEqual(g.body.mailReady, { ok: true });
  assert.equal(g.body.mailLimits.listMax, 50);
  assert.deepEqual(g.body.settings.mail.commonTo, ['ops@corp.local']);
  const cur = g.body.settings;
  const bad = await call('PUT', '/tools/isilon-dirusage/settings', { ...cur, mail: { commonTo: 'ops@corp.local\nnope' } });
  assert.equal(bad.status, 400); assert.equal(bad.body.field, 'mail.commonTo');
  const bad2 = await call('PUT', '/tools/isilon-dirusage/settings', { ...cur, targets: cur.targets.map((t, i) => (i === 0 ? { ...t, mail: { to: 'x@@corp' } } : t)) });
  assert.equal(bad2.status, 400); assert.equal(bad2.body.field, 'mail.to'); assert.equal(bad2.body.index, 0);
  const okSave = await call('PUT', '/tools/isilon-dirusage/settings', { ...cur, mail: { commonTo: 'ops@corp.local, sre@corp.local' } });
  assert.equal(okSave.status, 200, JSON.stringify(okSave.body));
  assert.deepEqual(okSave.body.settings.mail.commonTo, ['ops@corp.local', 'sre@corp.local']);
  assert.deepEqual(okSave.body.settings.targets.find((t) => t.id === 'tg1').mail.to, ['owner@corp.local', 'OPS@corp.local'], '대상 메일은 그대로');
  // 메일 필드 없이 저장하면 이전 값 유지(옛 화면이 지우지 않게)
  const noMail = await call('PUT', '/tools/isilon-dirusage/settings', { retentionDays: cur.retentionDays, targets: okSave.body.settings.targets.map(({ mail, ...t }) => t) });
  assert.equal(noMail.status, 200);
  assert.deepEqual(noMail.body.settings.mail.commonTo, ['ops@corp.local', 'sre@corp.local']);
  assert.equal(noMail.body.settings.targets.find((t) => t.id === 'tg1').mail.onFailure, true);
  // 메인 목록: 주소 대신 개수·선택·마지막 결과
  const m = await call('GET', '/tools/isilon-dirusage');
  const row = m.body.targets.find((t) => t.id === 'tg1');
  assert.equal(row.mail.recipients, 3, 'ops·sre(공통) + owner(대상) — OPS@ 는 같은 주소');
  assert.ok(!JSON.stringify(m.body.targets).includes('owner@'), '목록 응답에 주소를 싣지 않는다');
  assert.ok(row.lastMail && row.lastMail.state, '마지막 발송 결과');
  // 지금 보내기 — 사람이 누른 것은 '변화 없으면 생략' 을 보지 않는다
  const before = smtp.st.mails.length;
  const now = await call('POST', '/tools/isilon-dirusage/mail-now', { id: 'tg2' });
  assert.equal(now.status, 200, JSON.stringify(now.body)); assert.equal(now.body.manual, true);
  assert.equal(smtp.st.mails.length, before + 1);
  assert.equal((await call('POST', '/tools/isilon-dirusage/mail-now', { id: 'tg-none' })).status, 409, '받는 사람 없음');
  assert.equal((await call('POST', '/tools/isilon-dirusage/mail-now', { id: 'mock-demo' })).status, 409, '데모');
  assert.equal((await call('POST', '/tools/isilon-dirusage/mail-now', { id: 'nope' })).status, 404);
  // 메일 종류를 끄면 준비 상태가 그 사실을 말한다
  writeJson('mail.json', { ...JSON.parse(fs.readFileSync(path.join(TMP, 'mail.json'), 'utf8')), kinds: { isidu: { enabled: false } } });
  const { invalidate } = await import('../src/mail/settings.js'); invalidate();
  const g2 = await call('GET', '/tools/isilon-dirusage/settings');
  assert.equal(g2.body.mailReady.ok, false); assert.match(g2.body.mailReady.reason, /꺼져 있습니다/);
});

test('⑦ 메일 종류 카탈로그에 isidu 가 있다(설정 › 메일 발송에서 끄고 켠다)', async () => {
  const K = await import('../src/mail/kinds.js');
  assert.equal(K.isKind('isidu'), true);
  assert.match(K.kindLabel('isidu'), /아이실론/);
});
