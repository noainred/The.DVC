/**
 * test/isiduSchedReview2745.test.js — v2.745 대상별 결과 메일 '정한 요일·시각' 적대적 검토 확정분(SCHED-01~04) 회귀.
 *
 *   SCHED-01 '변화 없으면 생략' 의 기준은 **실제로 보낸 정기 발송 조사**다. 정기 발송 이력이 없거나 그 조사가 DB 에 없으면 비교하지 않고 보낸다
 *            (직전 조사와 비교하면 조사마다 du -h 해상도보다 조금씩 자라는 폴더가 영원히 '변화 없음' 이 됐다 — 재현: 8회차 0통, 6.4배 자람).
 *   SCHED-02 받는 사람이 0명이던 동안 지나간 회차는 조용히 처리한 것으로 넘긴다 — 수신자를 넣은 뒤 그 회차들이 '놓침(늦게 확인·포탈 꺼짐) N번' 으로
 *            한꺼번에 기록되지 않게(포탈은 켜져 있었고 회차를 놓친 것도 아니다).
 *   SCHED-03 since 가 미래(저장 뒤 서버 시계가 뒤로 감)면 설정 파일은 고치지 않고 기록에 sinceFrom·sinceCap 을 남겨 지금으로 잡는다(xferspeed
 *            rebaseClock 과 같은 규칙) — 그 since 때문에 보낼 차례에 막힌 회차는 'missed-clock' 으로 기록한다. 화면 '다음 발송' 도 같은 실효 since 를 본다.
 *   SCHED-04 메인 목록·설정 조회 응답이 포탈 시각 오프셋(offsetMin)을 싣는다 — 화면이 언제나 540 으로 그려 서버 일정과 어긋나지 않게.
 * ⚠ 일정 계산은 고정 시각을 주입한다(Date.now() 를 기준 시각으로 쓰지 않는다 — CLAUDE.md 규약). 회차는 같은 함수(nextDigestSlots)로 구한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'isiduschedrev2745-'));
// 인증을 켠다 — 설정 조회는 슈퍼 관리자 전용이다(익명 사용자는 슈퍼 관리자가 아니다). 메일 틱은 인증과 무관하다.
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'true' });
delete process.env.CENTRAL_URL;
delete process.env.CENTRAL_TOKEN;
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const writeJson = (n, v) => fs.writeFileSync(path.join(TMP, n), JSON.stringify(v, null, 2));
const readState = () => { try { return JSON.parse(fs.readFileSync(path.join(TMP, 'isidu-mail-state.json'), 'utf8')); } catch { return null; } };
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

async function fakeSmtp() {
  const st = { mails: [] };
  const srv = net.createServer((sock) => {
    let buf = ''; let inData = false; let cur = { rcpt: [], data: '' };
    sock.write('220 fake ESMTP\r\n');
    const handle = (line) => {
      if (inData) {
        if (line === '.') { inData = false; st.mails.push({ rcpt: cur.rcpt, data: cur.data }); cur = { rcpt: [], data: '' }; sock.write('250 2.0.0 queued\r\n'); }
        else cur.data += `${line}\n`;
        return;
      }
      const u = line.toUpperCase();
      if (u.startsWith('EHLO') || u.startsWith('HELO')) sock.write('250-fake\r\n250 OK\r\n');
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
const DAY = 86_400_000;
// 고정 기준 시각(2026-09-06 00:00 UTC) — 일정은 순수 계산이라 고정 시각을 주입한다.
const REF = Date.UTC(2026, 8, 6, 0, 0, 0);
const SCHED = { when: 'schedule', days: [1, 4], time: '08:00' };
const scanRec = (targetId, ts, entries) => {
  const sum = entries.reduce((a, e) => a + e[1], 0);
  return {
    agent: '', node: '', targetId, ts, ok: true, path: ROOT, host: '10.0.0.5', sizeMode: 'h', durationMs: 42_000, trig: 'schedule',
    total: { bytes: sum, res: 0.1 * G }, sumBytes: sum, sumRes: 0.1 * G * entries.length, count: entries.length, skipped: 0, errLines: 0,
    entries: entries.map(([name, bytes]) => ({ name, bytes, res: Math.round(0.1 * G) })),
  };
};
const CTX = {
  devices: [], agents: [], dcs: [],
  pickAgent: (v) => ({ value: String(v || '') }),
  pickDatacenter: (v) => ({ value: String(v || '') }),
  ssrfBlockReason: () => null,
};
const settingsOf = (targets, commonTo = []) => ({ timeoutDefaultMin: 120, retentionDays: 400, mail: { commonTo }, targets });

let smtp = null;
let SLOTS = null;
async function setup() {
  if (smtp) return smtp;
  smtp = await fakeSmtp();
  writeJson('mail.json', { enabled: true, smtp: { host: '127.0.0.1', port: smtp.port, startTls: false, user: '', password: '', from: 'portal@corp.local', timeoutMs: 5000 }, defaultTo: ['default@corp.local'], kinds: {}, rateLimitPerHour: 0 });
  const { invalidate } = await import('../src/mail/settings.js'); invalidate();
  const mail = await import('../src/mail/service.js'); mail._resetMail?.();
  const D = await import('../src/isidu/digestRules.js');
  SLOTS = D.nextDigestSlots({ enabled: true, ...SCHED, since: REF }, REF, 10);
  assert.equal(SLOTS.length, 10);
  return smtp;
}

/* ── SCHED-01 ─────────────────────────────────────────────────────────── */
test('SCHED-01 정기 발송 이력이 없으면 비교하지 않고 보낸다 · 그 뒤로는 마지막으로 보낸 조사와 비교한다(조금씩 자라는 폴더도 쌓이면 보낸다)', async () => {
  const s = await setup();
  const db = await import('../src/isidu/db.js');
  const N = await import('../src/isidu/notify.js');
  writeJson('isidu-settings.json', settingsOf([
    { id: 'tA', label: '변화만 정기', host: '10.0.0.5', username: 'admin', path: ROOT, topN: 2, mail: { to: ['a@corp.local'], excludeCommon: true, onlyOnChange: true, skipIfNoNew: true, ...SCHED, since: REF } },
  ]));
  let size = 40 * G;
  const ins = async (ts) => {
    size += 0.08 * G;   // 행 해상도 0.1 G 보다 작게 — 이웃한 두 조사는 언제나 '같다'
    const r = await db.insertScan(scanRec('tA', ts, [['big', size], ['small', 1 * G]]));
    assert.equal(r.ok, true, r.error);
    assert.equal((await N.notifyScanStored({ targetId: 'tA', scanId: r.id, ok: true, ts })).state, 'scheduled');
    return r.id;
  };
  await ins(SLOTS[0] - 5 * HOUR);
  const first = await ins(SLOTS[0] - 2 * HOUR);
  const before = s.st.mails.length;
  await N.targetMailTick(SLOTS[0] + MIN, { bootAt: REF });
  const l0 = N.isiduMailStateOf('tA');
  assert.equal(l0?.state, 'sent', `정기 발송 이력이 없으면 직전 조사와 비교하지 않고 보낸다: ${JSON.stringify(l0)}`);
  assert.equal(s.st.mails.length, before + 1);
  assert.equal(readState().targets.tA.schedSentScanId, first);

  // 다음 회차 — 마지막으로 보낸 조사 대비 0.08 G(해상도 안) → 생략 · 사유는 사실('마지막으로 보낸')
  await ins(SLOTS[1] - 2 * HOUR);
  await N.targetMailTick(SLOTS[1] + MIN, { bootAt: REF });
  const l1 = N.isiduMailStateOf('tA');
  assert.equal(l1.code, 'unchanged', JSON.stringify(l1));
  assert.match(l1.reason, /마지막으로 보낸 조사/);
  assert.equal(s.st.mails.length, before + 1);

  // 그다음 — 마지막으로 보낸 조사 대비 0.16 G(해상도 밖) → 보낸다(직전 조사 대비로는 여전히 0.08 G)
  const third = await ins(SLOTS[2] - 2 * HOUR);
  await N.targetMailTick(SLOTS[2] + MIN, { bootAt: REF });
  assert.equal(N.isiduMailStateOf('tA').state, 'sent', JSON.stringify(N.isiduMailStateOf('tA')));
  assert.equal(s.st.mails.length, before + 2);
  assert.equal(readState().targets.tA.schedSentScanId, third);

  // 보낸 조사가 DB 에 없다(보존 기간이 지움 등) — 직전 조사와 비교하지 않고 보낸다(기준이 '보낸 조사' 가 아니면 '변화 없음' 이라 말할 근거가 없다)
  const st = readState();
  st.targets.tA.schedSentScanId = 999_999; st.targets.tA.schedSentScanTs = REF - 400 * DAY;
  fs.writeFileSync(path.join(TMP, 'isidu-mail-state.json'), JSON.stringify(st));
  N._resetForTest();
  size -= 0.07 * G;   // 직전 조사 대비 +0.01 G — 직전 조사와 비교하면 '변화 없음'
  await ins(SLOTS[3] - 2 * HOUR);
  await N.targetMailTick(SLOTS[3] + MIN, { bootAt: REF });
  assert.equal(N.isiduMailStateOf('tA').state, 'sent', `기준 조사가 없으면 보낸다: ${JSON.stringify(N.isiduMailStateOf('tA'))}`);
  assert.equal(s.st.mails.length, before + 3);
});

/* ── SCHED-02 ─────────────────────────────────────────────────────────── */
test('SCHED-02 받는 사람이 0명이던 동안의 회차는 조용히 넘긴다 — 수신자를 넣은 뒤 놓침(늦게 확인·포탈 꺼짐) N번이 생기지 않는다', async () => {
  const s = await setup();
  const db = await import('../src/isidu/db.js');
  const N = await import('../src/isidu/notify.js');
  const S = await import('../src/isidu/settings.js');
  N._resetForTest();
  writeJson('isidu-settings.json', settingsOf([
    { id: 'tB', label: '공통 수신자 대기', host: '10.0.0.6', username: 'admin', path: ROOT, topN: 2, mail: { to: [], onlyOnChange: false, skipIfNoNew: false, ...SCHED, since: REF } },
  ], []));
  const before = s.st.mails.length;
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  try {
    for (let i = 0; i < 6; i++) {
      await N.targetMailTick(SLOTS[i] + MIN, { bootAt: REF });
      assert.equal(N.isiduMailStateOf('tB'), null, `받는 사람 0명 — 마지막 메일 기록을 남기지 않는다(${i})`);
    }
  } finally { console.warn = origWarn; }
  assert.equal(s.st.mails.length, before);
  assert.equal(warns.filter((w) => /tB/.test(w)).length, 0, `받는 사람이 없는 대상의 회차로 경고를 남기지 않는다: ${warns.join(' | ')}`);
  assert.equal(readState().targets.tB?.last, undefined);

  // 실제 저장 경로로 공통 수신자를 넣는다 — 요일·시각은 그대로라 since 도 그대로다(이 수정은 since 재설정에 기대지 않는다)
  const cur = S.loadSettings();
  const r = S.saveSettings({ ...cur, mail: { commonTo: ['ops@corp.local'] } }, CTX);
  assert.equal(r.ok, true, r.error);
  assert.equal(S.loadSettings().targets.find((t) => t.id === 'tB').mail.since, REF, 'since 는 그대로');

  // 재시작 뒤(기동 시각이 마지막 회차 뒤) 첫 틱 — 지나간 6회차를 '포탈이 꺼져 있던 동안의 놓침' 으로 기록하지 않는다
  N._resetForTest();
  const t1 = await N.targetMailTick(SLOTS[5] + 2 * HOUR, { bootAt: SLOTS[5] + HOUR });
  assert.equal(N.isiduMailStateOf('tB'), null, `수신자를 넣은 직후 거짓 놓침 기록이 없다: ${JSON.stringify(t1)} · ${JSON.stringify(N.isiduMailStateOf('tB'))}`);
  // 같은 프로세스(재시작 없음)의 '늦게 확인' 쪽도 같다
  const t2 = await N.targetMailTick(SLOTS[5] + 3 * HOUR, { bootAt: REF });
  assert.equal(N.isiduMailStateOf('tB'), null, JSON.stringify(t2));

  // 다음 회차는 정상으로 보낸다
  const sc = await db.insertScan(scanRec('tB', SLOTS[6] - 2 * HOUR, [['u1', 3 * G]]));
  await N.notifyScanStored({ targetId: 'tB', scanId: sc.id, ok: true, ts: SLOTS[6] - 2 * HOUR });
  await N.targetMailTick(SLOTS[6] + MIN, { bootAt: REF });
  const l = N.isiduMailStateOf('tB');
  assert.equal(l?.state, 'sent', JSON.stringify(l));
  assert.equal(l.slot, SLOTS[6]);
  assert.deepEqual(s.st.mails.at(-1).rcpt, ['ops@corp.local']);
});

/* ── SCHED-03 ─────────────────────────────────────────────────────────── */
test('SCHED-03 since 가 미래(시계가 뒤로 감)면 기록에 sinceFrom·sinceCap 을 남겨 지금으로 잡고, 막힌 회차는 missed-clock 으로 남긴다 · 설정 파일은 고치지 않는다', async () => {
  const s = await setup();
  const db = await import('../src/isidu/db.js');
  const N = await import('../src/isidu/notify.js');
  const R = await import('../src/isidu/mailRules.js');
  N._resetForTest();
  const FUT = SLOTS[0] + 10 * DAY + HOUR;   // 첫 회차 시점 기준 10일 뒤 — 저장할 때 시계가 그만큼 앞서 있었다
  writeJson('isidu-settings.json', settingsOf([
    { id: 'tC', label: '시계', host: '10.0.0.7', username: 'admin', path: ROOT, topN: 2, mail: { to: ['c@corp.local'], excludeCommon: true, skipIfNoNew: false, ...SCHED, since: FUT } },
  ]));
  const sc = await db.insertScan(scanRec('tC', SLOTS[0] - 2 * HOUR, [['u1', 5 * G]]));
  await N.notifyScanStored({ targetId: 'tC', scanId: sc.id, ok: true, ts: SLOTS[0] - 2 * HOUR });
  const before = s.st.mails.length;
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  try { await N.targetMailTick(SLOTS[0] + MIN, { bootAt: REF }); } finally { console.warn = origWarn; }
  const l = N.isiduMailStateOf('tC');
  assert.equal(l?.code, 'missed-clock', `미래 since 때문에 막힌 회차는 기록한다: ${JSON.stringify(l)}`);
  assert.equal(l.slot, SLOTS[0]); assert.equal(l.state, 'skipped');
  assert.ok(R.TARGET_MAIL_CODES.includes('missed-clock'));
  const rc = readState().targets.tC;
  assert.equal(rc.sinceFrom, FUT); assert.equal(rc.sinceCap, SLOTS[0] + MIN);
  assert.ok(warns.some((w) => /tC/.test(w) && /시계/.test(w)), `경고를 남긴다: ${warns.join(' | ')}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(TMP, 'isidu-settings.json'), 'utf8')).targets[0].mail.since, FUT, '설정 파일은 배경 틱이 고치지 않는다');
  assert.equal(s.st.mails.length, before, '소급 발송하지 않는다');

  // 다음 회차(원래 since 보다 앞) — 보정한 since 로 정상 발송
  await N.targetMailTick(SLOTS[1] + MIN, { bootAt: REF });
  assert.equal(N.isiduMailStateOf('tC').state, 'sent', JSON.stringify(N.isiduMailStateOf('tC')));
  assert.equal(N.isiduMailStateOf('tC').slot, SLOTS[1]);
  assert.equal(s.st.mails.length, before + 1);
});

test('SCHED-03 화면 다음 발송(targetMailNextSlots) — 틱과 같은 실효 since: 시계 보정 대상(미래 since)은 지금부터 · 허용 폭 안의 since 는 since 뒤부터', async () => {
  await setup();
  const N = await import('../src/isidu/notify.js');
  const D = await import('../src/isidu/digestRules.js');
  const now = SLOTS[0] - 10 * MIN;
  const tm = { when: 'schedule', days: [1, 4], time: '08:00' };
  const plain = D.nextDigestSlots({ enabled: true, ...tm, since: REF }, now, 3);
  assert.equal(plain[0], SLOTS[0]);
  // since 가 지난 시각 — 예전과 같다
  assert.deepEqual(N.targetMailNextSlots({ ...tm, since: REF }, null, now), plain);
  // since 가 크게 미래 — 틱이 지금으로 잡으므로 지금부터(그 회차는 실제로 보낸다)
  assert.deepEqual(N.targetMailNextSlots({ ...tm, since: now + 10 * DAY }, null, now), plain);
  // 보정 기록이 그 since 값이면 보정값
  assert.deepEqual(N.targetMailNextSlots({ ...tm, since: now + 10 * DAY }, { sinceFrom: now + 10 * DAY, sinceCap: now - HOUR }, now), plain);
  // since 가 허용 폭(2분) 안의 미래 — 틱은 보정하지 않고 since 이하 회차를 보내지 않는다 → 화면도 since 뒤부터
  const edge = SLOTS[0] + 30_000;
  const near = N.targetMailNextSlots({ ...tm, since: edge }, null, SLOTS[0] - 30_000);
  assert.ok(near[0] > edge, `since 이하 회차를 '다음' 으로 보이지 않는다: ${near[0]} vs ${edge}`);
  assert.equal(near[0], SLOTS[1]);
  // 정기 발송이 아니면 []
  assert.deepEqual(N.targetMailNextSlots({ ...tm, when: 'scan', since: null }, null, now), []);
  // rows.js 가 같은 함수를 쓴다(다음 회차 계산을 두 벌 두지 않는다)
  const rows = fs.readFileSync(new URL('../src/isidu/rows.js', import.meta.url), 'utf8');
  assert.match(rows, /targetMailNext(?:Of|Slots)\(/);
  assert.doesNotMatch(rows, /nextDigestSlots\(/, 'rows.js 가 since 를 보지 않는 계산을 직접 부르지 않는다');
});

/* ── SCHED-04 ─────────────────────────────────────────────────────────── */
test('SCHED-04 메인 목록·설정 조회 응답이 포탈 시각 오프셋(offsetMin)을 싣는다', async () => {
  await setup();
  const { api } = await import('../src/routes/api.js');
  const { DAY_OFFSET_MIN } = await import('../src/util/dayKey.js');
  const SUPER = { username: 'noainred', role: 'admin', superAdmin: true, scope: {} };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = SUPER; next(); });
  app.use('/api', api);
  const srv = http.createServer(app); const port = await listen(srv);
  try {
    for (const u of ['/tools/isilon-dirusage', '/tools/isilon-dirusage/settings']) {
      const res = await fetch(`http://127.0.0.1:${port}/api${u}`);
      const body = await res.json();
      assert.equal(res.status, 200, `${u}: ${JSON.stringify(body).slice(0, 200)}`);
      assert.equal(body.offsetMin, DAY_OFFSET_MIN, `${u} 는 offsetMin 을 싣는다`);
    }
  } finally { srv.closeAllConnections?.(); srv.close(); }
});
