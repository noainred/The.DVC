/**
 * storageUsage2789.test.js — 스토리지 사용량 보고서(일간·주간·월간 표 · 비교 · 예약 메일) 회귀(v2.789).
 *
 * 사용자 요청(2026-10-26): "스토리지 사용량을 일간/주간 별로 이렇게 정리해서 보는 기능"(엑셀 캡처) · "표 형식 기본 · CSV export ·
 *   법인별/같은 종류 스토리지별 비교" + "사용자가 지정한 시간에 전체 사용량을 이메일로".
 *
 * 고정하는 것:
 *  ① 기간 — 주간은 기준 요일(기본 월요일) · 직전 6일 안의 마지막 관측 · 월간 '이번 달은 오늘까지' · 일간은 그 날만
 *  ② 칸 — 기간 안의 가장 늦은 관측, 기준일과 다르면 exact:false · 크기를 못 읽은 행은 값이 아니다
 *  ③ 합계 — 크기·사용량을 둘 다 읽은 장비만 · 빠진 장비는 partial(0 으로 채우지 않는다) · 늦게 시작한 장비·꺼진 장비는 기대하지 않는다
 *  ④ DB — 하위 항목 일 롤업(더 늦은 관측만 갱신 · 크기 없는 항목은 행을 만들지 않음 · 조각 조회)
 *  ⑤ 실제 api 라우터 — 보고표 · 비관리자 주소 가림 · 범위 계정 403 · 등록부 손상 503
 *  ⑥ 메일 — 형식 오류 400(field) · since · 가짜 SMTP 로 지금 보내기 · 예약 회차 한 번만 · 상태에 주소 없음 · 본문 이스케이프
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'storageusage2789-'));
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'false' });
delete process.env.CENTRAL_URL;
delete process.env.CENTRAL_TOKEN;
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const G = 1024 ** 3;
const T = 1024 ** 4;
const DAY = 86_400_000;
// ⚠ 동적 import 는 **전부 여기서** 끝낸다 — 테스트 정의 사이에 top-level await 를 두면 러너가 앞 테스트만 보고 끝난 것으로 여겨
//   after(임시 폴더 삭제)를 먼저 돌린다(이 파일 초판에서 실제로 DB 가 'unable to open' 이 됐다).
const R = await import('../src/storage/usageReport.js');
const db = await import('../src/storage/db.js');
const reg = await import('../src/storage/registry.js');
const M = await import('../src/storage/usageMailRules.js');
const U = await import('../src/storage/usageMail.js');
const MS = await import('../src/mail/settings.js');
const { api } = await import('../src/routes/api.js');
const dayOf = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY);

/* ── ① 기간 ─────────────────────────────────────────────────────────── */
test('① 주간 — 기준 요일(기본 월) 날짜가 행이고 창은 직전 6일까지 · 일간 · 월간(이번 달은 오늘까지)', () => {
  const wed = dayOf('2026-10-28');                       // 수요일
  assert.equal(R.weekdayOf(dayOf('2026-10-26')), 1, '2026-10-26 은 월요일');
  const w = R.buildPeriods({ gran: 'weekly', asOfDay: wed, count: 3 });
  assert.deepEqual(w.map((p) => p.label), ['2026-10-12', '2026-10-19', '2026-10-26']);
  assert.equal(w[2].fromDay, dayOf('2026-10-20'));
  assert.equal(w[2].toDay, dayOf('2026-10-26'));
  const sun = R.buildPeriods({ gran: 'weekly', asOfDay: wed, count: 1, weekday: 0 });
  assert.equal(sun[0].label, '2026-10-25', '기준 요일을 일요일로');
  const d = R.buildPeriods({ gran: 'daily', asOfDay: wed, count: 3 });
  assert.deepEqual(d.map((p) => [p.fromDay === p.toDay, p.label]), [[true, '2026-10-26'], [true, '2026-10-27'], [true, '2026-10-28']]);
  const m = R.buildPeriods({ gran: 'monthly', asOfDay: wed, count: 2 });
  assert.deepEqual(m.map((p) => p.label), ['2026-09', '2026-10']);
  assert.equal(m[0].toDay, dayOf('2026-09-30')); assert.equal(m[0].current, undefined);
  assert.equal(m[1].toDay, wed); assert.equal(m[1].current, true, '이번 달은 오늘까지');
  // 모르는 값은 기본값, 상한은 자른다(읽기 경로)
  assert.deepEqual(R.normalizeReportQuery({ gran: 'x', count: 'abc' }), { gran: 'weekly', count: R.GRANS.weekly.def, weekday: 1 });
  assert.equal(R.normalizeReportQuery({ gran: 'daily', count: 9999 }).count, R.GRANS.daily.max);
});

/* ── ② 칸 ───────────────────────────────────────────────────────────── */
test('② 칸 — 기간 안의 가장 늦은 관측 · 기준일이 아니면 exact:false · 창 밖·크기 없음은 값이 아니다', () => {
  const ps = R.buildPeriods({ gran: 'weekly', asOfDay: dayOf('2026-10-26'), count: 3 });
  const s = [
    { day: dayOf('2026-10-10'), total: 100 * T, used: 40 * T },    // 10-12 창(10-06~10-12) 안 — 기준일 아님
    { day: dayOf('2026-10-19'), total: 0, used: 0 },               // 크기 0 — 값이 아니다
    { day: dayOf('2026-10-26'), total: 100 * T, used: null },      // 사용량 못 읽음
  ];
  const c = R.pickCells(s, ps);
  assert.deepEqual(c[0], { day: dayOf('2026-10-10'), exact: false, totalBytes: 100 * T, usedBytes: 40 * T, pct: 40 });
  assert.equal(c[1], null, '0 바이트 행은 값이 아니다(0 으로 그리지 않는다)');
  assert.equal(c[2].usedBytes, null); assert.equal(c[2].pct, null, '사용량을 못 읽으면 사용률도 없다');
  const daily = R.pickCells(s, R.buildPeriods({ gran: 'daily', asOfDay: dayOf('2026-10-11'), count: 1 }));
  assert.equal(daily[0], null, '일간은 그 날만 — 앞날 값을 끌어오지 않는다');
});

/* ── ③ 합계 ─────────────────────────────────────────────────────────── */
test('③ 합계 — 둘 다 읽은 장비만 · 빠진 장비는 partial · 늦게 시작·꺼진 장비는 기대하지 않는다', () => {
  const ps = R.buildPeriods({ gran: 'daily', asOfDay: 100, count: 3 });   // 98 · 99 · 100
  const cell = (t, u, day, exact = true) => ({ day, exact, totalBytes: t, usedBytes: u, pct: u == null ? null : (u / t) * 100 });
  const devs = [
    { firstDay: 50, enabled: true, cells: [cell(10, 5, 98), cell(10, 6, 99), cell(10, 7, 100)] },
    { firstDay: 50, enabled: true, cells: [cell(20, 10, 98), null, cell(20, null, 100)] },   // 99 빠짐 · 100 사용량 못 읽음
    { firstDay: 100, enabled: true, cells: [null, null, cell(5, 1, 100)] },                   // 100 부터 이력 — 98·99 는 기대하지 않는다
    { firstDay: 10, lastDay: 60, enabled: false, cells: [null, null, null] },                 // 꺼진 장비(60 이후 관측 없음)
  ];
  const a = R.aggregateCells(devs, ps);
  assert.deepEqual([a[0].counted, a[0].expected, a[0].partial, a[0].totalBytes, a[0].usedBytes], [2, 2, false, 30, 15]);
  assert.deepEqual([a[1].counted, a[1].expected, a[1].missing, a[1].partial, a[1].totalBytes], [1, 2, 1, true, 10], '빠진 장비를 0 으로 더하지 않고 partial');
  assert.deepEqual([a[2].counted, a[2].usedUnknown, a[2].partial, a[2].totalBytes, a[2].usedBytes], [2, 1, true, 15, 8], '사용량을 못 읽은 장비는 따로 센다');
  assert.equal(a[2].pct, Math.round((8 / 15) * 1000) / 10, '사용률은 합계끼리 나눈다');
  assert.equal(R.deltaOf(a[0], a[1]), -9, '부분 합끼리의 차는 순수 함수가 내지만 화면·메일은 partial 표지를 함께 본다');
  assert.equal(R.deltaOf(null, a[0]), null);
});

/* ── ④ DB ───────────────────────────────────────────────────────────── */
const now = Date.now();
const snapAt = (deviceId, ts, total, used, resources) => ({
  deviceId, type: 'unity480', name: deviceId, ok: true, collectedAt: ts, capacity: { totalBytes: total, usedBytes: used },
  extra: { ...(resources ? { resources } : {}) },
});

test('④ 하위 항목 일 롤업 — 더 늦은 관측만 갱신 · 크기 없는 항목은 행을 만들지 않음 · 조각 조회', async () => {
  const today = db.dayIndex(now);
  const t0 = db.dayStartMs(today) + 3600_000;
  const r1 = await db.saveCapacityPoint(snapAt('u-1', t0, 100 * T, 30 * T, [
    { kind: 'lun', id: 'sv_1', name: 'Davinci_01', totalBytes: 120 * T, usedBytes: 40 * T },
    { kind: 'fs', id: 'res_3', name: 'sandbox', totalBytes: 1024 * G, usedBytes: 185 * G },
    { kind: 'fs', id: 'res_9', name: 'nosize', totalBytes: null, usedBytes: 1 },
  ]));
  assert.equal(r1.saved, true); assert.equal(r1.resources, 2, '크기를 못 읽은 항목은 행을 만들지 않는다');
  await db.saveCapacityPoint(snapAt('u-1', t0 + 3600_000, 100 * T, 31 * T, [{ kind: 'fs', id: 'res_3', name: 'sandbox2', totalBytes: 1024 * G, usedBytes: 186 * G }]));
  await db.saveCapacityPoint(snapAt('u-1', t0 + 1800_000, 100 * T, 30 * T, [{ kind: 'fs', id: 'res_3', name: 'old', totalBytes: 1024 * G, usedBytes: 1 }]));
  const rows = await db.resourceDailyRange(today - 40, today, { sliceDays: 7 });
  const sb = rows.filter((x) => x.rkey === 'fs:res_3');
  assert.equal(sb.length, 1, '하루 1행');
  assert.equal(sb[0].used_bytes, 186 * G, '더 늦은 관측만 갱신(엣지 push 는 순서대로 오지 않는다)');
  assert.equal(sb[0].name, 'sandbox2', '이름을 바꿔도 키(id)가 같으면 이어진다');
  assert.deepEqual((await db.resourceDailyRange(today - 40, today, { deviceIds: ['nope'] })), []);
  // 장비 이력 재시작(측정 기준 변경)은 하위 항목 이력도 지운다
  await db.resetCapacityHistory(['u-1'], { reason: 't' });
  assert.equal((await db.resourceDailyRange(today - 40, today)).filter((x) => x.device_id === 'u-1').length, 0);
});

/* ── ⑤ 실제 api 라우터 ──────────────────────────────────────────────── */
async function call(method, url, body, user = { username: 'root', role: 'admin', scope: {} }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message || err) }));
  const srv = http.createServer(app); const port = await listen(srv);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { srv.closeAllConnections?.(); srv.close(); }
}

let devA; let devB;
async function seed() {
  if (devA) return;
  devA = reg.saveDevice({ type: 'unity480', name: 'UNITY-A', host: '10.20.0.5', username: 'svc', password: 'p', collectMethod: 'ssh' });
  devB = reg.saveDevice({ type: 'isilon', name: '10.20.0.6', host: '10.20.0.6', username: 'svc', password: 'p' });
  const today = db.dayIndex(now);
  for (let k = 3; k >= 0; k--) {
    const ts = db.dayStartMs(today - k) + 7200_000;
    await db.saveCapacityPoint({ ...snapAt(devA.id, ts, 100 * T, (30 + k) * T, [{ kind: 'lun', id: 'sv_1', name: 'Davinci_01', totalBytes: 120 * T, usedBytes: (40 + k) * T }]), name: 'UNITY-A' });
    if (k !== 1) await db.saveCapacityPoint({ ...snapAt(devB.id, ts, 500 * T, 250 * T), type: 'isilon', name: '10.20.0.6' });
  }
}

test('⑤ 라우터 — 일간 보고표 · 하위 항목 · 비관리자 주소 가림 · 범위 계정 403', async () => {
  await seed();
  const r = await call('GET', '/tools/storage-usage?gran=daily&count=4');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.periods.length, 4);
  const a = r.body.devices.find((x) => x.deviceId === devA.id);
  assert.deepEqual(a.cells.map((c) => c && c.usedBytes / T), [33, 32, 31, 30]);
  assert.equal(a.resources[0].name, 'Davinci_01');
  assert.deepEqual(a.resources[0].cells.map((c) => c && c.usedBytes / T), [43, 42, 41, 40]);
  const b = r.body.devices.find((x) => x.deviceId === devB.id);
  assert.equal(b.cells[2], null, '수집이 없던 날은 빈 칸(앞날 값을 끌어오지 않는다)');
  assert.ok(!r.body.addressHidden);

  const op = await call('GET', '/tools/storage-usage?gran=daily&count=4', null, { username: 'op', role: 'operator', scope: {} });
  assert.equal(op.status, 200);
  assert.equal(op.body.addressHidden, true);
  const bo = op.body.devices.find((x) => x.deviceId === devB.id);
  assert.notEqual(bo.name, '10.20.0.6', '이름이 관리 주소와 같으면 비관리자에게 가린다');
  assert.ok(!JSON.stringify(op.body).includes('10.20.0.6'), '응답 어디에도 관리 주소가 없다');

  const scoped = await call('GET', '/tools/storage-usage', null, { username: 's', role: 'admin', scope: { vcenters: ['vc-1'] } });
  assert.equal(scoped.status, 403, '범위 계정은 조회할 수 없다(vCenter 귀속 없는 인프라 장비)');
  const mailScoped = await call('GET', '/tools/storage-usage/mail', null, { username: 's', role: 'admin', scope: { vcenters: ['vc-1'] } });
  assert.equal(mailScoped.status, 403);
  // 역할 게이트는 인증을 끈 이 하네스에서 익명 역할로 판정되므로(requireRole) 소스로 고정한다 — 메일 라우트는 전부 adminOnly + fullScopeOnly,
  //   저장·지금 보내기는 설정 소유자까지(받는 사람 주소가 오가는 경로).
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'routes', 'api', 'storageUsage.js'), 'utf8');
  const lines = src.split('\n').filter((l) => /api\.(get|put|post)\('\/tools\/storage-usage\/mail/.test(l));
  assert.equal(lines.length, 4);
  for (const l of lines) assert.match(l, /adminOnly, fullScopeOnly/, l);
  for (const l of lines.filter((x) => /api\.put|send-now/.test(x))) assert.match(l, /requireSettingsOwner/, l);
});

/* ── ⑥ 메일 ─────────────────────────────────────────────────────────── */
function decodeMail(raw) {
  const m = /^Subject: (.*)$/mi.exec(raw);
  const subject = m ? m[1].replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_x, x) => Buffer.from(x, 'base64').toString('utf8')) : '';
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

test('⑥-1 메일 규칙 — 형식 오류는 저장하지 않고 field · since 는 켜거나 일정을 바꾼 시각 · 본문 이스케이프', async () => {
  assert.equal(M.normalizeMail({ enabled: true, days: [] }, null).field, 'mail.days');
  assert.equal(M.normalizeMail({ time: '24:00' }, null).field, 'mail.time');
  assert.equal(M.normalizeMail({ gran: 'hourly' }, null).field, 'mail.gran');
  assert.equal(M.normalizeMail({ count: 99 }, null).field, 'mail.count');
  assert.equal(M.normalizeMail({ to: 'ok@corp.local\nbad' }, null).field, 'mail.to');
  const t0 = 1_800_000_000_000;
  const on = M.normalizeMail({ enabled: true, days: [1, 3, 3, 9], time: '07:30', to: 'a@corp.local, A@corp.local' }, null, t0).mail;
  assert.deepEqual(on.days, [1, 3]); assert.deepEqual(on.to, ['a@corp.local']); assert.equal(on.since, t0);
  assert.equal(M.normalizeMail({ includeResources: true }, on, t0 + 1000).mail.since, t0, '일정이 같으면 since 유지');
  assert.equal(M.normalizeMail({ time: '06:00' }, on, t0 + 2000).mail.since, t0 + 2000);
  assert.equal(M.normalizeMail({ enabled: false }, on, t0).mail.since, null);
  // 본문 — 장비 이름·법인 이름은 이스케이프된다. 부분 합 표지가 본문에 있다.
  const rep = {
    gran: 'weekly', asOfLabel: '2026-10-26', types: [{ type: 'unity480', label: 'Unity' }], datacenters: [{ id: 'dc1', name: '<i>법인</i>' }],
    periods: R.buildPeriods({ gran: 'weekly', asOfDay: dayOf('2026-10-26'), count: 2 }),
    devices: [
      { deviceId: 'a', name: '<script>x</script>', type: 'unity480', datacenterId: 'dc1', enabled: true, firstDay: 1, cells: [{ day: 1, exact: true, totalBytes: T, usedBytes: G, pct: 0.1 }, { day: 2, exact: true, totalBytes: T, usedBytes: 2 * G, pct: 0.2 }], resources: [] },
      { deviceId: 'b', name: 'B', type: 'unity480', datacenterId: 'dc1', enabled: true, firstDay: 1, cells: [{ day: 1, exact: true, totalBytes: T, usedBytes: G, pct: 0.1 }, null], resources: [] },
    ],
  };
  const mail = M.renderUsageMail(M.buildMailModel(rep), { mail: { includeDevices: true }, manual: true, recipients: 2 });
  assert.ok(!mail.html.includes('<script>x'), '장비 이름 이스케이프');
  assert.ok(mail.html.includes('&lt;script&gt;'));
  assert.ok(!mail.html.includes('<i>법인'), '법인 이름 이스케이프');
  assert.match(mail.html, /값 있음 1\/2대/, '부분 합 표지');
  assert.match(mail.html, /@media only screen and \(max-width:520px\)/, '좁은 화면 규칙');
});

test('⑥-2 메일 발송 — 라우터 400 · 저장 · 지금 보내기(가짜 SMTP) · 예약 회차 한 번만 · 상태에 주소 없음', async () => {
  await seed();
  const smtp = await fakeSmtp();
  fs.writeFileSync(path.join(TMP, 'mail.json'), JSON.stringify({ enabled: true, smtp: { host: '127.0.0.1', port: smtp.port, startTls: false, user: '', password: '', from: 'portal@corp.local', timeoutMs: 5000 }, defaultTo: ['admin@corp.local'], kinds: {}, rateLimitPerHour: 0 }));
  MS.invalidate?.();

  const bad = await call('PUT', '/tools/storage-usage/mail', { mail: { enabled: true, days: [1], to: 'nope' } });
  assert.equal(bad.status, 400); assert.equal(bad.body.field, 'mail.to');
  assert.equal(fs.existsSync(path.join(TMP, 'storage-usage-mail.json')), false, '형식 오류는 파일을 쓰지 않는다');

  const ok = await call('PUT', '/tools/storage-usage/mail', { mail: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], time: '08:00', to: 'extra@corp.local\nADMIN@corp.local' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.mail.since > 0);
  assert.deepEqual(ok.body.status.recipients, { total: 2, fromAdmin: 1, fromExtra: 1, dupes: 1 });

  const sent = await call('POST', '/tools/storage-usage/mail/send-now', {});
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(smtp.st.mails.length, 1);
  const m0 = smtp.st.mails[0];
  assert.deepEqual(m0.rcpt.map((x) => x.toLowerCase()).sort(), ['admin@corp.local', 'extra@corp.local']);
  assert.match(m0.subject, /스토리지 사용량 주간 보고/);
  assert.match(m0.data, /UNITY-A/);
  assert.ok(!m0.data.includes('10.20.0.6'), '메일은 비관리자 판본 — 관리 주소를 싣지 않는다');
  const st = (await call('GET', '/tools/storage-usage/mail')).body.status;
  assert.ok(!JSON.stringify(st).includes('@'), '상태·기록에는 주소를 싣지 않는다(개수만)');
  assert.equal(st.history[0].state, 'sent');

  // 예약 — since 이후 회차 하나만 보낸다. 같은 회차를 다시 틱해도 두 번 보내지 않는다.
  const cfgPath = path.join(TMP, 'storage-usage-mail.json');
  const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const slot = Math.floor((Date.now() + 9 * 3600_000) / 60_000) * 60_000 - 9 * 3600_000 - 5 * 60_000;   // 5분 전(KST 분 경계)
  const hh = new Date(slot + 9 * 3600_000).toISOString().slice(11, 16);
  fs.writeFileSync(cfgPath, JSON.stringify({ ...saved, time: hh, since: slot - 60_000 }));
  U._resetForTest();
  const t1 = await U.usageMailTick(slot + 60_000);
  assert.equal(t1.action, 'send', JSON.stringify(t1));
  assert.equal(t1.result?.state, 'sent');
  const t2 = await U.usageMailTick(slot + 120_000);
  assert.equal(t2.action, 'none', '같은 회차는 한 번만');
  assert.equal(smtp.st.mails.length, 2);
});

test('⑦ 등록부 손상 — 빈 표를 내려보내지 않고 503(원문 조각은 관리자 상세에만)', async () => {
  await seed();
  const file = path.join(TMP, 'storage-devices.json');
  const keep = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '{"devices":[{"password":"SECRETFRAG');
  reg._resetForTest();
  try {
    const op = await call('GET', '/tools/storage-usage', null, { username: 'op', role: 'operator', scope: {} });
    assert.equal(op.status, 503);
    assert.equal(op.body.registryUnreadable, true);
    assert.ok(!JSON.stringify(op.body).includes('SECRETFRAG'), '파일 조각을 응답에 싣지 않는다');
  } finally {
    fs.writeFileSync(file, keep);
    reg._resetForTest();
  }
});
