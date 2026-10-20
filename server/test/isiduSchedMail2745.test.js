/**
 * test/isiduSchedMail2745.test.js — 아이실론 디렉터리 사용량 대상별 결과 메일 '보내는 때'(v2.745 기능 A).
 *
 * 사용자 결정: 대상마다 '조사가 끝날 때마다'(scan — 예전 동작) 또는 '정한 요일·시각'(schedule) · '새 조사 없으면 보내지 않기' 는 대상별(기본 켬).
 *   ① 저장 모양 — targetMailOf 기본값 · normalizeTargetMail 왕복(빠진 필드 유지 · since 는 서버가 정함 · 400 field) · 종합 메일 규칙과 같은 결과(대조)
 *   ② 정기 틱(고정 now · bootAt 주입) — send / missed(late·down) / rebase / none · 보내기 전에 lastSlot 이 상태 파일에 남는다 · 재시작 뒤 같은 회차 두 번 안 보냄
 *   ③ skipIfNoNew(마지막 정기 발송 이후 새 성공 조사) · onlyOnChange(**마지막으로 보낸 조사**와 비교)
 *   ④ schedule 모드에서 조사 적재는 결과 메일을 보내지 않고 last 를 덮지 않는다 · 실패 알림은 그대로 즉시 · scan 모드는 예전 그대로
 *   ⑤ 데모 대상·받는 사람 0명·결과 없음·엣지 노드 · ⑥ rows 의 when/days/time/skipIfNoNew/next · ⑦ 일괄 변경 4키(400 field) · ⑧ 설정 저장 왕복
 * ⚠ 일정 계산은 고정 시각을 주입한다(Date.now() 를 기준 시각으로 쓰지 않는다 — CLAUDE.md 규약). 회차는 같은 함수(nextDigestSlots)로 구한다 —
 *   포탈 시각 오프셋 env 가 달라도 깨지지 않게.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'isiduschedmail2745-'));
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'false' });
delete process.env.CENTRAL_URL;
delete process.env.CENTRAL_TOKEN;
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const writeJson = (n, v) => fs.writeFileSync(path.join(TMP, n), JSON.stringify(v, null, 2));
const readState = () => { try { return JSON.parse(fs.readFileSync(path.join(TMP, 'isidu-mail-state.json'), 'utf8')); } catch { return null; } };
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

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

/** 받은 메일을 기록하는 가짜 SMTP — MAIL FROM 순간의 상태 파일을 함께 남긴다('보내기 전에 기록' 검사). */
async function fakeSmtp() {
  const st = { mails: [], stateAtMailFrom: [] };
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
      if (u.startsWith('EHLO') || u.startsWith('HELO')) sock.write('250-fake\r\n250 OK\r\n');
      else if (u.startsWith('MAIL FROM')) { st.stateAtMailFrom.push(readState()); sock.write('250 ok\r\n'); }
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

const G = 1024 ** 3;
const ROOT = '/ifs/data/users';
const HOUR = 3_600_000;
const MIN = 60_000;
// 고정 기준 시각(2026-09-06 00:00 UTC) — 일정은 순수 계산이라 고정 시각을 주입한다. 회차는 nextDigestSlots 로 구한다.
const REF = Date.UTC(2026, 8, 6, 0, 0, 0);
const SCHED = { when: 'schedule', days: [1, 4], time: '08:00', since: REF };
let SLOTS = null;
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
    timeoutDefaultMin: 120, retentionDays: 400,
    mail: { commonTo: ['ops@corp.local'] },
    targets: [
      { id: 'ts1', label: '정기 홈', host: '10.0.0.5', username: 'admin', path: ROOT, topN: 2, mail: { to: ['own1@corp.local'], onFailure: true, ...SCHED } },
      { id: 'ts2', label: '정기 변화만', host: '10.0.0.6', username: 'admin', path: ROOT, topN: 2, mail: { to: ['own2@corp.local'], excludeCommon: true, onlyOnChange: true, skipIfNoNew: false, ...SCHED } },
      { id: 'ts-none', label: '받는 사람 없음', host: '10.0.0.7', username: 'admin', path: ROOT, topN: 2, mail: { to: [], excludeCommon: true, ...SCHED } },
      { id: 'mock-s', label: '데모 정기', host: '10.0.0.8', username: 'admin', path: ROOT, topN: 2, mail: { to: ['d@corp.local'], excludeCommon: true, ...SCHED } },
      { id: 'ts-empty', label: '결과 없음', host: '10.0.0.9', username: 'admin', path: ROOT, topN: 2, mail: { to: ['e@corp.local'], excludeCommon: true, ...SCHED } },
      { id: 'tscan', label: '조사마다', host: '10.0.0.10', username: 'admin', path: ROOT, topN: 2, mail: { to: ['scan@corp.local'], excludeCommon: true } },
    ],
  });
  const { invalidate } = await import('../src/mail/settings.js'); invalidate();
  const mail = await import('../src/mail/service.js'); mail._resetMail?.();
  const D = await import('../src/isidu/digestRules.js');
  SLOTS = D.nextDigestSlots({ enabled: true, days: SCHED.days, time: SCHED.time, since: REF }, REF, 8);
  assert.equal(SLOTS.length, 8);
  return smtp;
}

/* ── ① 저장 모양 ─────────────────────────────────────────────────────────── */
test('① targetMailOf 기본값 — 옛 저장값(필드 없음) = 조사마다 · 월 08:00 · 새 조사 없으면 생략 켬 · since null', async () => {
  const R = await import('../src/isidu/mailRules.js');
  const d = R.targetMailOf({});
  assert.deepEqual(d, { to: [], excludeCommon: false, onlyOnChange: false, onFailure: false, when: 'scan', days: [1], time: '08:00', skipIfNoNew: true, since: null });
  const old = R.targetMailOf({ mail: { to: ['a@corp.local'], onlyOnChange: true } });
  assert.equal(old.when, 'scan'); assert.equal(old.skipIfNoNew, true); assert.deepEqual(old.days, [1]);
  const s = R.targetMailOf({ mail: { when: 'schedule', days: [4, 1, 4, 9, 'x'], time: '07:30', skipIfNoNew: false, since: 123 } });
  assert.deepEqual([s.when, s.days, s.time, s.skipIfNoNew, s.since], ['schedule', [1, 4], '07:30', false, 123]);
  assert.equal(R.targetMailOf({ mail: { when: 'weekly', time: '7:5', since: '' } }).when, 'scan', '모르는 보내는 때는 예전 동작');
  assert.equal(R.targetMailOf({ mail: { time: '7:5' } }).time, '08:00');
  assert.equal(R.targetMailOf({ mail: { since: '' } }).since, null, 'Number("")===0 함정 — 빈 값은 null');
  assert.ok(R.TARGET_MAIL_CODES.includes('no-new') && R.TARGET_MAIL_CODES.includes('missed-late'));
  for (const c of ['no-new', 'unchanged', 'no-report', 'demo', 'missed-down', 'missed-late', 'no-recipients']) assert.ok(R.TARGET_MAIL_CODES.includes(c), c);
});

test('① normalizeTargetMail — 빠진 필드는 이전 값 · since 는 서버가 정한다 · 형식 오류 400 field', async () => {
  const R = await import('../src/isidu/mailRules.js');
  const N1 = 1_790_000_000_000; const N2 = N1 + 86_400_000;
  const a = R.normalizeTargetMail({ to: 'a@corp.local', when: 'schedule', since: 5 }, null, N1);
  assert.equal(a.error, undefined, a.error);
  assert.deepEqual(a.mail, { to: ['a@corp.local'], excludeCommon: false, onlyOnChange: false, onFailure: false, when: 'schedule', days: [1], time: '08:00', skipIfNoNew: true, since: N1 }, '클라이언트 since 는 무시 — 처음 schedule 로 바꾼 시각');
  // 부분 요청(다른 칸만) — 이전 값을 지우지 않는다 · 정의가 같으면 since 유지
  const b = R.normalizeTargetMail({ onlyOnChange: true }, a.mail, N2);
  assert.deepEqual(b.mail, { ...a.mail, onlyOnChange: true, since: N1 });
  // 요일 순서만 다름 = 같은 정의 → since 유지
  assert.equal(R.normalizeTargetMail({ days: [1] }, a.mail, N2).mail.since, N1);
  // 시각을 바꾸면 since = 지금
  const c = R.normalizeTargetMail({ time: ' 07:30 ' }, a.mail, N2);
  assert.equal(c.mail.time, '07:30'); assert.equal(c.mail.since, N2);
  // 요일을 바꾸면 since = 지금
  assert.equal(R.normalizeTargetMail({ days: [4, 1] }, a.mail, N2).mail.since, N2);
  // scan 으로 바꾸면 since null · 다시 schedule 로 오면 그때 시각
  const sc = R.normalizeTargetMail({ when: 'scan' }, a.mail, N2);
  assert.equal(sc.mail.since, null); assert.equal(sc.mail.when, 'scan'); assert.deepEqual(sc.mail.to, ['a@corp.local']);
  assert.equal(R.normalizeTargetMail({ when: 'schedule' }, sc.mail, N2 + 5).mail.since, N2 + 5);
  // 400
  assert.equal(R.normalizeTargetMail({ when: 'weekly' }, null, N1).field, 'mail.when');
  assert.equal(R.normalizeTargetMail({ when: 'schedule', days: [] }, null, N1).field, 'mail.days');
  assert.equal(R.normalizeTargetMail({ when: 'schedule', days: [7, 'x'] }, null, N1).field, 'mail.days', '쓸 수 있는 요일이 하나도 없음');
  assert.equal(R.normalizeTargetMail({ when: 'scan', days: [] }, null, N1).mail.days.length, 0, 'scan 이면 빈 요일도 저장한다(나중에 schedule 로 바꾸면 그때 400)');
  assert.equal(R.normalizeTargetMail({ when: 'schedule' }, { when: 'scan', days: [] }, N1).field, 'mail.days');
  for (const bad of ['24:00', '7:30', '08:60', 'x', '0800']) assert.equal(R.normalizeTargetMail({ time: bad }, null, N1).field, 'mail.time', bad);
  assert.equal(R.normalizeTargetMail({ to: 'nope' }, null, N1).field, 'mail.to');
  assert.equal(R.normalizeTargetMail('x', null, N1).field, 'mail');
  // 요청에 mail 이 없으면 이전 값 그대로(기본값 채움)
  assert.deepEqual(R.normalizeTargetMail(undefined, a.mail, N2).mail, a.mail);
  // 기본값이면 저장하지 않는다는 판정
  assert.equal(R.targetMailIsDefault(R.targetMailOf({})), true);
  assert.equal(R.targetMailIsDefault({ ...R.targetMailOf({}), when: 'schedule' }), false);
  assert.equal(R.targetMailIsDefault({ ...R.targetMailOf({}), skipIfNoNew: false }), false);
  assert.equal(R.targetMailIsDefault({ ...R.targetMailOf({}), days: [2] }), false);
});

test('① 요일·시각 검사와 since 규칙은 종합 메일(normalizeDigest)과 같은 결과다(같은 입력 대조)', async () => {
  const R = await import('../src/isidu/mailRules.js');
  const D = await import('../src/isidu/digestRules.js');
  const N0 = 1_790_000_000_000;
  const prevs = [null, { when: 'scan', days: [1], time: '08:00' }, { when: 'schedule', days: [1, 4], time: '08:00', since: N0 - 5 }, { when: 'schedule', days: [2], time: '23:59', since: N0 - 9 }, { when: 'scan', days: [], time: '00:00' }];
  const inputs = [{}, { when: 'schedule' }, { when: 'scan' }, { days: [4, 1] }, { days: [] }, { days: [0, 6, 6] }, { time: '23:59' }, { time: '24:00' }, { time: ' 07:05 ' },
    { when: 'schedule', days: [3], time: '12:00' }, { when: 'schedule', days: [] }, { when: 'schedule', time: '7:5' }, { days: ['1', 2.5, -1, 7] }];
  const toDigest = (m) => {
    if (!m) return null;
    const o = { enabled: m.when === 'schedule' };
    if ('days' in m) o.days = m.days;
    if ('time' in m) o.time = m.time;
    if ('since' in m) o.since = m.since;
    return o;
  };
  const inDigest = (inp) => { const o = {}; if ('when' in inp) o.enabled = inp.when === 'schedule'; if ('days' in inp) o.days = inp.days; if ('time' in inp) o.time = inp.time; return o; };
  let n = 0;
  for (const p of prevs) {
    for (const inp of inputs) {
      const t = R.normalizeTargetMail(inp, p, N0);
      const d = D.normalizeDigest(inDigest(inp), toDigest(p), N0);
      const tag = JSON.stringify({ p, inp });
      assert.equal(!!t.error, !!d.error, `오류 여부가 같다 ${tag}`);
      if (t.error) { assert.equal(t.field.replace(/^mail\./, ''), d.field.replace(/^digest\./, ''), `칸이 같다 ${tag}`); continue; }
      assert.deepEqual([t.mail.days, t.mail.time, t.mail.since], [d.digest.days, d.digest.time, d.digest.since], `요일·시각·since 가 같다 ${tag}`);
      n++;
    }
  }
  assert.ok(n > 30, `대조한 경우 ${n}개`);
  if (D.TIME_RE) for (const s of ['00:00', '23:59', '24:00', '7:30', '08:60', '0800', 'ab:cd']) assert.equal(!R.normalizeTargetMail({ time: s }, null, N0).error, D.TIME_RE.test(s), s);
});

/* ── ② ~ ⑤ 정기 틱(가짜 SMTP) ─────────────────────────────────────────────── */
test('②④ schedule 모드 — 조사 적재는 결과 메일을 보내지 않고 last 를 덮지 않는다 · 실패 알림은 즉시 · scan 모드는 예전 그대로', async () => {
  const s = await setup();
  const db = await import('../src/isidu/db.js');
  const N = await import('../src/isidu/notify.js');
  const S0 = SLOTS[0];
  // 회차 전 틱 — 아무것도 하지 않는다
  const t0 = await N.targetMailTick(S0 - 10 * MIN, { bootAt: REF });
  assert.equal(s.st.mails.length, 0, JSON.stringify(t0));
  assert.equal(N.isiduMailStateOf('ts1'), null);
  const a1 = await db.insertScan(scanRec('ts1', S0 - 2 * HOUR, [['alpha', 40 * G], ['beta', 12 * G], ['gamma', 1 * G]]));
  assert.equal(a1.ok, true, a1.error);
  const o1 = await N.notifyScanStored({ targetId: 'ts1', scanId: a1.id, ok: true, ts: S0 - 2 * HOUR });
  assert.equal(o1.state, 'scheduled', JSON.stringify(o1));
  assert.equal(s.st.mails.length, 0, '정기 발송 대상은 조사가 끝나도 결과 메일을 보내지 않는다');
  assert.equal(N.isiduMailStateOf('ts1'), null, '마지막 메일 기록은 실제 발송 결과다 — 덮지 않는다');
  assert.equal((await N.notifyScanStored({ targetId: 'ts1', scanId: a1.id, ok: true, ts: S0 - 2 * HOUR })).state, 'duplicate');
  // 실패 알림은 보내는 때와 무관하게 즉시
  const f1 = await db.insertScan(failRec('ts1', S0 - HOUR));
  const of1 = await N.notifyScanStored({ targetId: 'ts1', scanId: f1.id, ok: false, ts: S0 - HOUR });
  assert.equal(of1.state, 'sent', JSON.stringify(of1));
  assert.equal(s.st.mails.length, 1);
  assert.match(s.st.mails[0].subject, /조사 실패 — 정기 홈/);
  assert.equal(N.isiduMailStateOf('ts1').kind, 'failure');
  // 오래된 성공 결과(이미 다룬 것보다 앞) — 정기 발송 대상은 기록을 덮지 않는다
  const old = await db.insertScan(scanRec('ts1', S0 - 30 * HOUR, [['alpha', 39 * G]]));
  const before = N.isiduMailStateOf('ts1');
  assert.equal((await N.notifyScanStored({ targetId: 'ts1', scanId: old.id, ok: true, ts: S0 - 30 * HOUR })).state, 'older');
  assert.deepEqual(N.isiduMailStateOf('ts1'), before);
  // scan 모드 — 예전 그대로 바로 보낸다
  const sc = await db.insertScan(scanRec('tscan', S0 - HOUR, [['u', 2 * G]]));
  assert.equal((await N.notifyScanStored({ targetId: 'tscan', scanId: sc.id, ok: true, ts: S0 - HOUR })).state, 'sent');
  assert.equal(s.st.mails.length, 2);
  assert.deepEqual(s.st.mails[1].rcpt, ['scan@corp.local']);
  // ts2 · 데모 대상의 조사도 적재
  const a2 = await db.insertScan(scanRec('ts2', S0 - 2 * HOUR, [['u1', 40 * G], ['u2', 10 * G]]));
  assert.equal((await N.notifyScanStored({ targetId: 'ts2', scanId: a2.id, ok: true, ts: S0 - 2 * HOUR })).state, 'scheduled');
  const dm = await db.insertScan(scanRec('mock-s', S0 - 2 * HOUR, [['u1', G]]));
  assert.equal((await N.notifyScanStored({ targetId: 'mock-s', scanId: dm.id, ok: true, ts: S0 - 2 * HOUR })).state, 'scheduled');
  assert.equal(N.isiduMailStateOf('mock-s'), null);
  assert.equal(s.st.mails.length, 2);
});

test('② 회차가 오면 보낸다 — 보내기 전에 lastSlot 을 상태 파일에 남긴다 · 데모·결과 없음은 기록 · 받는 사람 0명은 판정·기록 안 함 · 재시작 뒤 두 번 안 보냄', async () => {
  const s = await setup();
  const N = await import('../src/isidu/notify.js');
  const S0 = SLOTS[0];
  const before = s.st.mails.length;
  const r = await N.targetMailTick(S0 + MIN, { bootAt: REF });
  assert.equal(r.action, 'tick', JSON.stringify(r));
  const sent = s.st.mails.slice(before);
  assert.equal(sent.length, 2, `ts1·ts2 두 통 ${JSON.stringify(sent.map((m) => m.rcpt))}`);
  const m1 = sent.find((m) => m.rcpt.includes('own1@corp.local'));
  assert.deepEqual(m1.rcpt, ['ops@corp.local', 'own1@corp.local'], '받는 사람 규칙은 그대로(공통 ∪ 대상별)');
  assert.match(m1.data, /alpha/);
  assert.deepEqual(sent.find((m) => m.rcpt.includes('own2@corp.local')).rcpt, ['own2@corp.local']);
  // MAIL FROM 순간 상태 파일에 그 대상의 회차가 이미 있다(설정 순서대로 ts1 → ts2 를 보낸다)
  const [snap1, snap2] = s.st.stateAtMailFrom.slice(-2);
  assert.equal(snap1?.targets?.ts1?.lastSlot, S0, `ts1 을 보내는 순간 처리 회차가 기록돼 있다: ${JSON.stringify(snap1?.targets?.ts1)}`);
  assert.equal(snap1?.targets?.ts1?.schedSentScanId, undefined, '보내기 전이다(발송 기록은 아직 없다)');
  assert.equal(snap2?.targets?.ts2?.lastSlot, S0, `ts2 를 보내는 순간 처리 회차가 기록돼 있다: ${JSON.stringify(snap2?.targets?.ts2)}`);
  const l1 = N.isiduMailStateOf('ts1');
  assert.equal(l1.kind, 'result'); assert.equal(l1.schedule, true); assert.equal(l1.slot, S0); assert.equal(l1.state, 'sent'); assert.equal(l1.to, 2);
  assert.ok(!JSON.stringify(l1).includes('own1@'), '기록에 주소를 남기지 않는다');
  const st = readState();
  assert.equal(st.targets.ts1.lastSlot, S0);
  assert.ok(Number.isFinite(st.targets.ts1.schedSentScanId));
  assert.ok(Number.isFinite(st.targets.ts1.schedSentAt));
  // 데모 · 결과 없음은 기록만(보내지 않음) · 받는 사람 0명은 기록도 없음
  const dm = N.isiduMailStateOf('mock-s');
  assert.equal(dm.code, 'demo'); assert.equal(dm.state, 'skipped'); assert.equal(dm.schedule, true);
  const em = N.isiduMailStateOf('ts-empty');
  assert.equal(em.code, 'no-report'); assert.equal(em.slot, S0);
  assert.equal(N.isiduMailStateOf('ts-none'), null);
  assert.equal(st.targets['ts-none'], undefined, '받는 사람 0명 대상은 회차를 판정하지 않는다');
  assert.equal(N.isiduMailStateOf('tscan').schedule, undefined, 'scan 모드 대상은 틱이 건드리지 않는다');
  for (const v of Object.values(st.targets)) if (v.last?.code) assert.ok((await import('../src/isidu/mailRules.js')).TARGET_MAIL_CODES.includes(v.last.code), v.last.code);
  // 재시작 흉내 — 메모리를 비우고 상태 파일에서 다시 읽는다: 같은 회차는 다시 보내지 않는다
  N._resetForTest();
  const r2 = await N.targetMailTick(S0 + 2 * MIN, { bootAt: S0 + 90_000 });
  assert.equal(s.st.mails.length, before + 2, JSON.stringify(r2));
  assert.equal(N.isiduMailStateOf('ts1').slot, S0);
});

test('③ 새 조사 없으면 생략(no-new) · 변화 없으면 생략은 마지막으로 보낸 조사와 비교(unchanged → 바뀌면 보냄)', async () => {
  const s = await setup();
  const db = await import('../src/isidu/db.js');
  const N = await import('../src/isidu/notify.js');
  const [, S1, S2] = SLOTS;
  const before = s.st.mails.length;
  await N.targetMailTick(S1 + MIN, { bootAt: REF });
  assert.equal(s.st.mails.length, before, '새 조사가 없다 — 두 대상 모두 보내지 않는다');
  const l1 = N.isiduMailStateOf('ts1');
  assert.equal(l1.code, 'no-new'); assert.equal(l1.state, 'skipped'); assert.equal(l1.slot, S1);
  const l2 = N.isiduMailStateOf('ts2');
  assert.equal(l2.code, 'unchanged', 'ts2 는 새 조사 없으면 생략을 껐다 — 마지막으로 보낸 조사와 같으므로 변화 없음');
  // 새 조사: ts1 B1 · ts2 B2(45G) → C2(45.05G — B2 와는 반올림 범위 안, 마지막으로 보낸 A2(40G) 와는 다르다)
  const b1 = await db.insertScan(scanRec('ts1', S1 + HOUR, [['alpha', 41 * G], ['beta', 12 * G]]));
  await N.notifyScanStored({ targetId: 'ts1', scanId: b1.id, ok: true, ts: S1 + HOUR });
  const b2 = await db.insertScan(scanRec('ts2', S1 + HOUR, [['u1', 45 * G], ['u2', 10 * G]]));
  await N.notifyScanStored({ targetId: 'ts2', scanId: b2.id, ok: true, ts: S1 + HOUR });
  const c2 = await db.insertScan(scanRec('ts2', S1 + 2 * HOUR, [['u1', 45 * G + 0.05 * G], ['u2', 10 * G]]));
  const keep = N.isiduMailStateOf('ts2');
  assert.equal((await N.notifyScanStored({ targetId: 'ts2', scanId: c2.id, ok: true, ts: S1 + 2 * HOUR })).state, 'scheduled');
  assert.deepEqual(N.isiduMailStateOf('ts2'), keep, '조사 적재가 마지막 메일 기록을 덮지 않는다');
  assert.equal(s.st.mails.length, before);
  await N.targetMailTick(S2 + MIN, { bootAt: REF });
  assert.equal(s.st.mails.length, before + 2, '새 조사가 있는 ts1 · 마지막으로 보낸 조사(A2)와 달라진 ts2');
  assert.equal(N.isiduMailStateOf('ts1').state, 'sent');
  assert.equal(N.isiduMailStateOf('ts2').state, 'sent');
  assert.equal(readState().targets.ts2.schedSentScanId, c2.id);
  assert.equal(readState().targets.ts1.schedSentScanId, b1.id);
  assert.match(s.st.mails.at(-1).data + s.st.mails.at(-2).data, /u1/);
});

test('② 놓친 회차는 몰아서 보내지 않는다(late·down) · 시계가 뒤로 가면 기록을 지금으로(rebase) · 진행 중이면 건너뜀', async () => {
  const s = await setup();
  const N = await import('../src/isidu/notify.js');
  const [, , , S3, S4, S5] = SLOTS;
  const before = s.st.mails.length;
  await N.targetMailTick(S3 + 31 * MIN, { bootAt: REF });
  assert.equal(s.st.mails.length, before);
  const l = N.isiduMailStateOf('ts1');
  assert.equal(l.code, 'missed-late'); assert.equal(l.state, 'skipped'); assert.equal(l.slot, S3);
  assert.equal(readState().targets.ts1.lastSlot, S3);
  await N.targetMailTick(S3 + 32 * MIN, { bootAt: REF });
  assert.equal(N.isiduMailStateOf('ts1').slot, S3, '같은 회차는 다시 판정하지 않는다');
  await N.targetMailTick(S4 + 40 * MIN, { bootAt: S4 + 35 * MIN });
  assert.equal(N.isiduMailStateOf('ts1').code, 'missed-down', '회차가 기동 전 — 포탈이 꺼져 있었다');
  assert.equal(s.st.mails.length, before);
  // rebase — 기록이 지금보다 한참 뒤(시계가 뒤로 감)
  const st = readState();
  st.targets.ts1.lastSlot = S5 + 10 * 86_400_000;
  fs.writeFileSync(path.join(TMP, 'isidu-mail-state.json'), JSON.stringify(st));
  N._resetForTest();
  const keep = N.isiduMailStateOf('ts1');
  const now = S5 - HOUR;
  await N.targetMailTick(now, { bootAt: REF });
  assert.equal(readState().targets.ts1.lastSlot, now, '처리 기록을 지금으로 다시 잡는다');
  assert.deepEqual(N.isiduMailStateOf('ts1'), keep, 'rebase 는 마지막 메일 기록을 바꾸지 않는다');
  // 진행 중이면 건너뜀
  const [x, y] = await Promise.all([N.targetMailTick(now + MIN, { bootAt: REF }), N.targetMailTick(now + MIN, { bootAt: REF })]);
  assert.ok([x.action, y.action].includes('busy'), JSON.stringify([x, y]));
});

test('⑤ 엣지 노드는 틱을 돌리지 않는다 · 사람이 누른 지금 보내기는 정기 발송 기록을 건드리지 않는다', async () => {
  await setup();
  const N = await import('../src/isidu/notify.js');
  const { config } = await import('../src/config.js');
  const keep = { centralUrl: config.agent.centralUrl, centralToken: config.agent.centralToken };
  Object.assign(config.agent, { centralUrl: 'https://central.example.invalid', centralToken: 'x' });
  try { assert.equal((await N.targetMailTick(SLOTS[5] + MIN, { bootAt: REF })).action, 'edge'); }
  finally { Object.assign(config.agent, keep); }
  const before = readState().targets.ts1;
  const r = await N.sendLatestNow('ts1', 'root');
  assert.equal(r.ok, true, JSON.stringify(r));
  const after = readState().targets.ts1;
  assert.equal(after.lastSlot, before.lastSlot); assert.equal(after.schedSentScanId, before.schedSentScanId); assert.equal(after.schedSentAt, before.schedSentAt);
  assert.equal(N.isiduMailStateOf('ts1').manual, true);
});

/* ── ⑥ 화면에 주는 값 ─────────────────────────────────────────────────── */
test('⑥ targetRows 의 mail — when·days·time·skipIfNoNew·next(schedule 만 · 받는 사람 0명이면 [])', async () => {
  await setup();
  const rows = await (await import('../src/isidu/rows.js')).targetRows();
  const by = new Map(rows.map((r) => [r.id, r]));
  const m1 = by.get('ts1').mail;
  assert.deepEqual([m1.when, m1.days, m1.time, m1.skipIfNoNew], ['schedule', [1, 4], '08:00', true]);
  assert.equal(m1.next.length, 3);
  for (let i = 1; i < 3; i++) assert.ok(m1.next[i] > m1.next[i - 1]);
  assert.ok(m1.next[0] > Date.now() - MIN, '다음 회차는 지금 뒤');
  assert.deepEqual(by.get('ts-none').mail.next, [], '받는 사람 0명이면 보내지 않으므로 다음 회차가 없다');
  assert.equal(by.get('ts-none').mail.recipients, 0);
  assert.equal(by.get('tscan').mail.when, 'scan');
  assert.deepEqual(by.get('tscan').mail.next, []);
  assert.ok(!JSON.stringify(rows).includes('own1@'), '목록 응답에 주소를 싣지 않는다');
});

/* ── ⑦ 일괄 변경 ─────────────────────────────────────────────────────── */
const CTX = {
  devices: [], agents: [], dcs: [{ id: 'dc1', name: 'DC1' }],
  pickAgent: (v) => ({ value: String(v || '') }),
  pickDatacenter: (v, list, prev) => { const s = String(v || ''); if (!s) return { value: '' }; return list.some((d) => d.id === s) || s === prev ? { value: s } : { error: '목록에 없는 DataCenter' }; },
  ssrfBlockReason: () => null,
};
test('⑦ 일괄 변경 4키 — mailWhen·mailDays·mailTime·mailSkipIfNoNew · 잘못된 값은 400 field · 적용은 같은 정규화(since 서버)', async () => {
  const B = await import('../src/isidu/bulk.js');
  for (const k of ['mailWhen', 'mailDays', 'mailTime', 'mailSkipIfNoNew']) assert.ok(B.BULK_KEYS.includes(k), k);
  const p = B.normalizeBulkPatch({ mailWhen: 'schedule', mailDays: [4, 1, 4], mailTime: ' 07:30 ', mailSkipIfNoNew: false });
  assert.deepEqual(p.patch, { mailWhen: 'schedule', mailDays: [1, 4], mailTime: '07:30', mailSkipIfNoNew: false });
  assert.deepEqual(B.normalizeBulkPatch({ mailWhen: '', mailDays: '', mailTime: '', mailSkipIfNoNew: '', enabled: true }).patch, { enabled: true }, '빈 값은 그대로');
  assert.equal(B.normalizeBulkPatch({ mailWhen: 'weekly' }).field, 'mailWhen');
  assert.equal(B.normalizeBulkPatch({ mailDays: [] }).field, 'mailDays');
  assert.equal(B.normalizeBulkPatch({ mailDays: [1, 7] }).field, 'mailDays', '범위 밖 요일은 버리지 않고 거부');
  assert.equal(B.normalizeBulkPatch({ mailDays: '1,4' }).field, 'mailDays');
  assert.equal(B.normalizeBulkPatch({ mailDays: [1.5] }).field, 'mailDays');
  assert.equal(B.normalizeBulkPatch({ mailTime: '25:00' }).field, 'mailTime');
  assert.equal(B.normalizeBulkPatch({ mailSkipIfNoNew: 'yes' }).field, 'mailSkipIfNoNew');
  const base = [
    { id: 'x1', label: 'a', host: '10.2.0.1', username: 'admin', agent: '', datacenterId: '', path: ROOT, sizeMode: 'h', intervalHours: 24, timeoutMin: 120, topN: 10, port: 22, enabled: true, auth: 'key', detach: true, mail: { to: ['a@corp.local'], excludeCommon: false, onlyOnChange: false, onFailure: false } },
    { id: 'x2', label: 'b', host: '10.2.0.2', username: 'admin', agent: '', datacenterId: '', path: ROOT, sizeMode: 'h', intervalHours: 24, timeoutMin: 120, topN: 10, port: 22, enabled: true, auth: 'key', detach: true },
  ];
  const r = B.applyBulk(base, ['x1', 'x2'], p.patch, CTX);
  assert.deepEqual(r.skipped, []);
  for (const id of ['x1', 'x2']) {
    const m = r.targets.find((t) => t.id === id).mail;
    assert.deepEqual([m.when, m.days, m.time, m.skipIfNoNew], ['schedule', [1, 4], '07:30', false], id);
    assert.ok(Number.isFinite(m.since) && m.since > 0, `since 는 서버가 정한다 ${id}`);
  }
  assert.deepEqual(r.targets.find((t) => t.id === 'x1').mail.to, ['a@corp.local'], '받는 사람은 그대로');
  assert.ok(r.changed.find((c) => c.id === 'x1').keys.includes('mail'));
  // 같은 값(옛 저장 모양 4필드 ↔ 정규화 9필드)은 바뀐 것으로 세지 않는다
  const same = B.applyBulk(base, ['x1'], B.normalizeBulkPatch({ timeoutMin: 120 }).patch, CTX);
  assert.deepEqual(same.unchanged, ['x1'], JSON.stringify(same.changed));
  // 요일이 비어 있는(조사마다로 저장된) 대상을 정기 발송으로 바꾸면 그 대상만 거절
  const emptyDays = [{ ...base[1], id: 'x3', mail: { to: ['c@corp.local'], when: 'scan', days: [] } }];
  const rj = B.applyBulk(emptyDays, ['x3'], B.normalizeBulkPatch({ mailWhen: 'schedule' }).patch, CTX);
  assert.equal(rj.skipped.length, 1); assert.equal(rj.skipped[0].field, 'mail.days');
});

/* ── ⑧ 설정 저장 왕복 ─────────────────────────────────────────────────── */
test('⑧ 설정 저장 — 새 필드를 저장하고(기본값과 다를 때) · 클라이언트 since 는 무시 · 기본값만이면 mail 을 저장하지 않는다 · 400 field', async () => {
  await setup();
  const S = await import('../src/isidu/settings.js');
  const cur = S.loadSettings();
  const add = [
    { id: 'n1', label: '정기 새', host: '10.3.0.1', username: 'admin', path: ROOT, mail: { to: '', excludeCommon: true, when: 'schedule', days: [4, 1], time: '07:30', since: 123 } },
    { id: 'n2', label: '요일만', host: '10.3.0.2', username: 'admin', path: ROOT, mail: { to: '', when: 'scan', days: [2] } },
    { id: 'n3', label: '기본', host: '10.3.0.3', username: 'admin', path: ROOT, mail: { to: '', excludeCommon: false, onlyOnChange: false, onFailure: false } },
  ];
  const r = S.saveSettings({ ...cur, targets: [...cur.targets, ...add] }, CTX);
  assert.equal(r.ok, true, r.error);
  const by = new Map(r.settings.targets.map((t) => [t.id, t]));
  assert.deepEqual([by.get('n1').mail.when, by.get('n1').mail.days, by.get('n1').mail.time], ['schedule', [1, 4], '07:30']);
  assert.notEqual(by.get('n1').mail.since, 123, '클라이언트 since 는 무시');
  assert.ok(by.get('n1').mail.since > 0);
  assert.deepEqual(by.get('n2').mail.days, [2], '보내는 때가 조사마다여도 바꾼 요일은 저장(기본값과 다르다)');
  assert.equal('mail' in by.get('n3'), false, '기본값만이면 저장하지 않는다');
  // 정의가 같은 재저장은 since 를 유지(화면이 since 를 다시 보내도 같다)
  const keepSince = by.get('n1').mail.since;
  const r2 = S.saveSettings({ ...r.settings, targets: r.settings.targets.map((t) => (t.id === 'n1' ? { ...t, mail: { ...t.mail, since: 1 } } : t)) }, CTX);
  assert.equal(r2.settings.targets.find((t) => t.id === 'n1').mail.since, keepSince);
  // 다른 저장 경로의 기존 정기 대상(ts1)도 since 유지
  assert.equal(r2.settings.targets.find((t) => t.id === 'ts1').mail.since, REF);
  const bad = S.saveSettings({ ...r2.settings, targets: r2.settings.targets.map((t) => (t.id === 'n1' ? { ...t, mail: { ...t.mail, time: '7:30' } } : t)) }, CTX);
  assert.equal(bad.ok, false); assert.equal(bad.field, 'mail.time');
  const bad2 = S.saveSettings({ ...r2.settings, targets: r2.settings.targets.map((t) => (t.id === 'n1' ? { ...t, mail: { ...t.mail, days: [] } } : t)) }, CTX);
  assert.equal(bad2.field, 'mail.days');
  const bad3 = S.saveSettings({ ...r2.settings, targets: r2.settings.targets.map((t) => (t.id === 'n1' ? { ...t, mail: { ...t.mail, when: 'x' } } : t)) }, CTX);
  assert.equal(bad3.field, 'mail.when');
});
