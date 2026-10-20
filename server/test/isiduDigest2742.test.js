/**
 * test/isiduDigest2742.test.js — 아이실론 디렉터리 사용량 **종합 메일**(v2.742).
 *
 * 사용자 요청: 전 법인 결과를 모아 정한 요일·시각에 한 통으로 보낸다(Claude Design 시안 ①·② 승인) · 대상별 메일 새 템플릿(③④).
 * 선택: v2.742 에 함께 · 전체 검증 · 시안 그대로.
 *   ① 설정 정규화(400 field · 빠진 칸 유지 · since 는 서버가 정한다)
 *   ② 일정 판정(정한 시각 30분 안 = 보냄 · 넘으면 놓침(몰아서 안 보냄) · since 이전 소급 안 함 · 시계 되감김)
 *   ③ 받는 사람 = 통합 관리자 ∪ 추가(같은 주소 한 번)
 *   ④ 본문 모델(성공한 대상만 합계 · 7일은 기준 있는 대상만 · 반올림 안 = 0 · 실패·오래됨 = 직전 성공 값 · 데모 제외)
 *   ⑤ 본문 HTML 이스케이프
 *   ⑥ 실제 api 라우터(슈퍼 관리자 전용 · 저장·미리보기·지금 보내기 — 가짜 SMTP) · 대상 저장이 종합 메일을 지우지 않는다
 *   ⑦ 틱 — 회차 한 번만 · 재시작 뒤 같은 회차 안 보냄(상태 파일) · 새 조사 없으면 생략 · 놓침 기록 · 엣지는 안 보냄
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'isidudigest2742-'));
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'false' });
delete process.env.CENTRAL_URL;
delete process.env.CENTRAL_TOKEN;
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const writeJson = (n, v) => fs.writeFileSync(path.join(TMP, n), JSON.stringify(v, null, 2));
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const G = 1024 ** 3;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const KST = 9 * 60 * 60_000;
/** epoch ms → 포탈 시각(KST) 'HH:MM'(분 단위 내림). */
const hhmm = (ms) => new Date(ms + KST).toISOString().slice(11, 16);

/** 받은 원문 → 제목(RFC 2047)·본문(base64 구획). */
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

/* ── 순수 규칙 ─────────────────────────────────────────────────────────── */
const MON_0800_KST = Date.UTC(2026, 9, 18, 23, 0);   // 2026-10-19(월) 08:00 KST

test('① 설정 정규화 — 형식 오류는 400(field) · 빠진 칸은 이전 값 · since 는 켜거나 요일·시각을 바꾼 시각', async () => {
  const R = await import('../src/isidu/digestRules.js');
  assert.equal(R.normalizeDigest(null, null).field, 'digest');
  assert.equal(R.normalizeDigest({ enabled: true, days: [] }, null).field, 'digest.days', '켰는데 요일이 없으면 거부(조용히 고치지 않는다)');
  assert.equal(R.normalizeDigest({ enabled: true, days: [1], time: '24:00' }, null).field, 'digest.time');
  assert.equal(R.normalizeDigest({ enabled: true, days: [1], time: '8:00' }, null).field, 'digest.time', 'HH:MM 형식만');
  // v2.745: 순위 개수는 1~50 정수(DIGEST_RANGES) — 범위 밖·정수 아님만 거부한다(7 은 이제 유효).
  assert.equal(R.normalizeDigest({ enabled: true, days: [1], topN: 51 }, null).field, 'digest.topN');
  assert.equal(R.normalizeDigest({ enabled: true, days: [1], topN: 2.5 }, null).field, 'digest.topN');
  assert.equal(R.normalizeDigest({ enabled: true, days: [1], topN: 7 }, null).digest.topN, 7);
  const badTo = R.normalizeDigest({ enabled: true, days: [1], to: 'ok@corp.local\nbad' }, null);
  assert.equal(badTo.field, 'digest.to'); assert.match(badTo.error, /bad/);
  // 꺼진 상태는 요일이 없어도 저장된다(요일 검사는 켤 때만)
  assert.equal(R.normalizeDigest({ enabled: false, days: [] }, null).digest.enabled, false);
  const t0 = 1_800_000_000_000;
  const on = R.normalizeDigest({ enabled: true, days: [1, 3, 5, 5, 9, -1], time: '07:30', to: 'a@corp.local, A@corp.local', topN: '20' }, null, t0).digest;
  assert.deepEqual(on.days, [1, 3, 5], '중복·범위 밖 요일은 버리고 정렬');
  assert.deepEqual(on.to, ['a@corp.local'], '같은 주소(대소문자 무시)는 한 번');
  assert.equal(on.topN, 20); assert.equal(on.since, t0, '켠 시각이 since');
  // 같은 일정으로 다른 칸만 바꾸면 since 유지
  const same = R.normalizeDigest({ includeWatch: false }, on, t0 + HOUR).digest;
  assert.equal(same.since, t0); assert.equal(same.includeWatch, false); assert.equal(same.time, '07:30', '빠진 칸은 이전 값');
  assert.equal(same.enabled, true, 'enabled 가 빠진 부분 요청이 끄지 않는다');
  // 시각을 바꾸면 since = 그 시각(오늘 이미 지난 회차를 소급 발송하지 않게)
  assert.equal(R.normalizeDigest({ time: '06:00' }, on, t0 + 2 * HOUR).digest.since, t0 + 2 * HOUR);
  assert.equal(R.normalizeDigest({ enabled: false }, on, t0 + 3 * HOUR).digest.since, null, '끄면 since 를 지운다');
  // 옛 파일(필드 없음)
  const d = R.digestOf(undefined);
  assert.equal(d.enabled, false); assert.deepEqual(d.days, [1]); assert.equal(d.time, '08:00'); assert.equal(d.includeAdmin, true); assert.equal(d.topN, 10);
});

test('② 일정 — 다음 회차(KST) · 30분 안이면 보냄 · 넘으면 놓침(몰아서 안 보냄) · since 이전 소급 안 함 · 시계 되감김', async () => {
  const R = await import('../src/isidu/digestRules.js');
  const dig = { enabled: true, days: [1], time: '08:00', since: MON_0800_KST - 30 * DAY };
  const fri = Date.UTC(2026, 9, 16, 3, 0);   // 2026-10-16(금) 12:00 KST
  const next = R.nextDigestSlots(dig, fri, 3);
  assert.deepEqual(next, [MON_0800_KST, MON_0800_KST + 7 * DAY, MON_0800_KST + 14 * DAY]);
  assert.equal(R.slotLabel(MON_0800_KST), '2026-10-19 (월) 08:00');
  assert.equal(R.daysLabel([1, 2, 3, 4, 5]), '평일'); assert.equal(R.daysLabel([0, 1, 2, 3, 4, 5, 6]), '매일'); assert.equal(R.daysLabel([1, 3, 5]), '월·수·금');
  assert.deepEqual(R.nextDigestSlots({ ...dig, enabled: false }, fri), [], '꺼져 있으면 회차 없음');

  // 정한 시각 10분 뒤 — 보낸다
  assert.deepEqual(R.planDigestTick({ digest: dig, state: {}, now: MON_0800_KST + 10 * 60_000, bootAt: 0 }), { action: 'send', slot: MON_0800_KST });
  // 처리한 회차는 다시 보내지 않는다
  assert.equal(R.planDigestTick({ digest: dig, state: { lastSlot: MON_0800_KST }, now: MON_0800_KST + 20 * 60_000 }).action, 'none');
  // 30분 넘게 늦으면 놓침 — 포탈이 꺼져 있던 회차(기동 전)는 'down', 기동 뒤는 'late'
  const lateNow = MON_0800_KST + 2 * HOUR;
  const miss = R.planDigestTick({ digest: dig, state: { lastSlot: MON_0800_KST - 7 * DAY }, now: lateNow, bootAt: MON_0800_KST + HOUR });
  assert.deepEqual(miss, { action: 'missed', slot: MON_0800_KST, count: 1, reason: 'down' });
  assert.equal(R.planDigestTick({ digest: dig, state: { lastSlot: MON_0800_KST - 7 * DAY }, now: lateNow, bootAt: MON_0800_KST - DAY }).reason, 'late');
  // 3주 동안 못 봤으면 놓친 회차를 세기만 한다(한 통도 몰아서 보내지 않는다)
  const m3 = R.planDigestTick({ digest: dig, state: { lastSlot: MON_0800_KST - 21 * DAY }, now: lateNow, bootAt: 0 });
  assert.equal(m3.action, 'missed'); assert.equal(m3.count, 3);
  // since 이전 회차는 보지 않는다(오늘 08:00 지난 뒤에 켠 경우 — 08:10 에 켰다)
  assert.equal(R.planDigestTick({ digest: { ...dig, since: MON_0800_KST + 10 * 60_000 }, state: {}, now: MON_0800_KST + 15 * 60_000 }).action, 'none');
  // 시계가 뒤로 가 기록이 지금보다 한참 뒤 → 기록을 지금으로
  assert.deepEqual(R.planDigestTick({ digest: dig, state: { lastSlot: lateNow + DAY }, now: lateNow }), { action: 'rebase', lastSlot: lateNow, reason: 'clock' });
  assert.equal(R.planDigestTick({ digest: { ...dig, days: [] }, now: lateNow }).action, 'none');
  assert.deepEqual(R.DIGEST_MISSED_REASONS, ['down', 'late', 'clock']);
});

test('③ 받는 사람 = 통합 관리자(고르면) ∪ 추가 주소 · 같은 주소 한 번 · 형식 오류는 버린다', async () => {
  const R = await import('../src/isidu/digestRules.js');
  const r = R.digestRecipients({ includeAdmin: true, to: ['lead@corp.local', 'new@corp.local'] }, ['admin@corp.local', 'Lead@corp.local', 'not-mail']);
  assert.deepEqual(r.to, ['admin@corp.local', 'Lead@corp.local', 'new@corp.local']);
  assert.deepEqual([r.fromAdmin, r.fromExtra, r.dupes], [2, 1, 1]);
  assert.deepEqual(R.digestRecipients({ includeAdmin: false, to: ['x@corp.local'] }, ['admin@corp.local']).to, ['x@corp.local']);
  assert.deepEqual(R.digestRecipients({ includeAdmin: false, to: [] }, ['admin@corp.local']).to, []);
});

test('④ 본문 모델(순수) — 반올림 범위 안의 7일 변화는 0 · 기준 없는 대상은 7일 합에서 뺀다 · 데모 제외/포함', async () => {
  const R = await import('../src/isidu/digestRules.js');
  const now = MON_0800_KST;
  const row = (id, corp, bytes, extra = {}) => ({ id, corp, path: `/ifs/${id}`, intervalHours: 24, timeoutMin: 120, okScan: { id: 1, ts: now - HOUR, total: { bytes }, sumBytes: bytes, errLines: 0 }, ...extra });
  const rows = [row('a', '한국', 100 * G), row('b', '미국', 40 * G), row('c', '한국', 0, { okScan: null }), row('mock-z', '데모', 999 * G)];
  const ov = new Map([
    ['a', { state: 'ok', totalDelta7: { bytes: 0.05 * G, withinRes: true }, base7: { ts: 1 }, top: [{ name: 'x', bytes: 60 * G }], scan: { path: '/ifs/a', sizeMode: 'h' } }],
    ['b', { state: 'ok', totalDelta7: null, base7: null, top: [{ name: 'y', bytes: 30 * G }], scan: { path: '/ifs/b', sizeMode: 'h' } }],
  ]);
  const m = R.buildDigestModel(rows, ov, { now, topN: 5 });
  assert.equal(m.totals.targets, 3, '데모 제외');
  assert.equal(m.demoExcluded, 1);
  assert.equal(m.totals.measured, 2); assert.equal(m.totals.unmeasured, 1);
  assert.equal(m.totals.bytes, 140 * G, '성공한 대상만 더한다');
  assert.equal(m.totals.d7, 0, '반올림 범위 안 = 0');
  assert.equal(m.totals.d7Targets, 1, '7일 기준이 있는 대상만');
  assert.equal(m.totals.d7Within, true);
  assert.deepEqual(m.corps.map((c) => c.label), ['한국', '미국'], '사용량 많은 순');
  assert.equal(m.corps[0].unmeasured, 1);
  assert.deepEqual(m.top.map((r) => r.name), ['x', 'y']);
  assert.equal(m.counts.never, 1);
  const withDemo = R.buildDigestModel(rows, ov, { now, excludeDemo: false });
  assert.equal(withDemo.totals.targets, 4); assert.equal(withDemo.demoIncluded, 1);
  // 결과가 하나도 없으면 합계는 0 이 아니라 null
  assert.equal(R.buildDigestModel([row('c', '', 0, { okScan: null })], new Map(), { now }).totals.bytes, null);
});

/* ── 실제 DB·발송 ─────────────────────────────────────────────────────── */
const T0 = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;   // 정시 −30분(경계에서 떨어뜨림 — v2.517 규약)
const scanRec = (targetId, ts, entries, extra = {}) => {
  const sum = entries.reduce((a, e) => a + e[1], 0);
  return {
    agent: '', node: '', targetId, ts, ok: true, path: `/ifs/${targetId}`, host: '10.0.0.5', sizeMode: 'h', durationMs: 42_000, trig: 'schedule',
    total: { bytes: sum, res: 0.1 * G }, sumBytes: sum, sumRes: 0.1 * G * entries.length, count: entries.length, skipped: 0, errLines: 0,
    entries: entries.map(([name, bytes]) => ({ name, bytes, res: Math.round(0.1 * G) })), ...extra,
  };
};
const failRec = (targetId, ts) => ({ agent: '', node: '', targetId, ts, ok: false, path: `/ifs/${targetId}`, host: '10.0.0.9', sizeMode: 'h', durationMs: 1000, trig: 'schedule', kind: 'timeout', error: 'du 시한 초과(120분)' });

let smtp = null;
async function setup() {
  if (smtp) return smtp;
  smtp = await fakeSmtp();
  writeJson('mail.json', { enabled: true, smtp: { host: '127.0.0.1', port: smtp.port, startTls: false, user: '', password: '', from: 'portal@corp.local', timeoutMs: 5000 }, defaultTo: ['admin@corp.local', 'Lead@corp.local'], kinds: {}, rateLimitPerHour: 0 });
  writeJson('datacenters.json', { datacenters: [{ id: 'dc-kr', name: '한국' }, { id: 'dc-us', name: '미국' }], assign: {} });
  writeJson('isidu-settings.json', {
    retentionDays: 400,
    mail: { commonTo: [] },
    targets: [
      { id: 'tg-a', label: '홈 <b>굵게</b>', host: '10.0.0.5', username: 'admin', path: '/ifs/tg-a', topN: 10, datacenterId: 'dc-kr' },
      { id: 'tg-b', label: '연구', host: '10.0.0.6', username: 'admin', path: '/ifs/tg-b', topN: 10, datacenterId: 'dc-us' },
      { id: 'tg-c', label: '오래됨', host: '10.0.0.7', username: 'admin', path: '/ifs/tg-c', topN: 10, datacenterId: 'dc-kr' },
      { id: 'tg-f', label: '실패', host: '10.0.0.9', username: 'admin', path: '/ifs/tg-f', topN: 10, datacenterId: 'dc-us' },
      { id: 'mock-demo', label: '데모', host: '10.0.0.8', username: 'admin', path: '/ifs/mock-demo', topN: 10 },
    ],
  });
  const db = await import('../src/isidu/db.js');
  for (const rec of [
    scanRec('tg-a', T0 - 8 * DAY, [['alpha', 100 * G], ['<script>x</script>', 10 * G]]),
    scanRec('tg-a', T0, [['alpha', 300 * G], ['<script>x</script>', 10 * G]]),
    scanRec('tg-b', T0, [['beta', 50 * G]]),
    scanRec('tg-c', T0 - 5 * DAY, [['gamma', 20 * G]]),
    scanRec('tg-f', T0 - DAY, [['delta', 5 * G]]),
    failRec('tg-f', T0),
    scanRec('mock-demo', T0, [['demo-folder-xyz', 1000 * G]]),
  ]) { const r = await db.insertScan(rec); assert.equal(r.ok, true, r.error); }
  const { invalidate } = await import('../src/mail/settings.js'); invalidate();
  const mail = await import('../src/mail/service.js'); mail._resetMail?.();
  return smtp;
}

test('④ 본문 모델(실제 DB) — 합계는 성공한 대상만 · 7일은 기준 있는 대상만 · 먼저 볼 것(실패·보고 늦음·급증) · 데모 제외', async () => {
  await setup();
  const { targetRows } = await import('../src/isidu/rows.js');
  const { buildOverview } = await import('../src/isidu/report.js');
  const R = await import('../src/isidu/digestRules.js');
  const rows = await targetRows();
  const ov = await buildOverview(rows.map((r) => r.id));
  const m = R.buildDigestModel(rows, new Map(ov.map((x) => [x.id, x])), { now: Date.now(), topN: 10 });
  assert.equal(m.totals.targets, 4); assert.equal(m.demoExcluded, 1);
  assert.equal(m.totals.bytes, (310 + 50 + 20 + 5) * G, 'tg-f 는 직전 성공 값(5G)을 넣는다');
  assert.equal(m.totals.d7, 200 * G); assert.equal(m.totals.d7Targets, 1);
  assert.deepEqual(m.corps.map((c) => c.label), ['한국', '미국']);
  const st = Object.fromEntries(rows.map((r) => [r.id, R.statusOfRow(r).key]));
  assert.deepEqual([st['tg-a'], st['tg-b'], st['tg-c'], st['tg-f']], ['ok', 'ok', 'stale', 'failed']);
  const kinds = m.watch.map((w) => (w.kind === 'surge' ? `surge:${w.folder.name}` : `${w.kind}:${w.item.t.id}`));
  assert.deepEqual(kinds, ['bad:tg-f', 'warn:tg-c', 'surge:alpha'], '실패 → 보고 늦음 → 급증 순');
  const f = m.corps.find((c) => c.label === '미국').items.find((x) => x.t.id === 'tg-f');
  assert.equal(f.lastValue, true, '실패 대상의 값은 직전 성공 값');
  assert.equal(m.biggest.name, 'alpha');
  assert.ok(!m.top.some((r) => r.name === 'demo-folder-xyz'), '데모 폴더는 순위에 없다');
});

test('⑤ 본문 HTML — 폴더·라벨은 이스케이프 · 제목에 법인·대상·합계 · 텍스트판도 만든다', async () => {
  await setup();
  const { targetRows } = await import('../src/isidu/rows.js');
  const { buildOverview } = await import('../src/isidu/report.js');
  const R = await import('../src/isidu/digestRules.js');
  const H = await import('../src/isidu/mailHtml.js');
  const rows = await targetRows();
  const ov = await buildOverview(rows.map((r) => r.id));
  const m = R.buildDigestModel(rows, new Map(ov.map((x) => [x.id, x])), { now: Date.now() });
  const mail = H.renderDigestMail(m, { digest: { days: [1, 3, 5], time: '08:00' }, slot: MON_0800_KST, recipients: 3 });
  assert.ok(!mail.html.includes('<script>x</script>'), '폴더 이름이 태그로 들어가지 않는다');
  assert.ok(mail.html.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.ok(!mail.html.includes('<b>굵게</b>'), '라벨도 이스케이프');
  assert.match(mail.subject, /종합 보고 — 2026-10-19 \(월\) 08:00 · 법인 2곳 · 대상 4개/);
  assert.match(mail.html, /매주 월·수·금 08:00/);
  assert.match(mail.html, /데모 대상 1개는 넣지 않았습니다/);
  assert.match(mail.text, /전 법인 사용자 Top 10/, "v2.745: 열 이름 '사용자(폴더)' — 절 제목도 '사용자'");
  assert.match(mail.html, /직전 성공 값/);
  // 수집 대상별·먼저 볼 것을 끄면 그 구획이 빠진다
  const slim = H.renderDigestMail(m, { digest: { days: [1], time: '08:00' }, slot: MON_0800_KST, includeWatch: false, includeTargets: false });
  assert.ok(!slim.html.includes('먼저 볼 것')); assert.ok(!slim.html.includes('수집 대상별'));
  // 대상별 결과 메일·실패 알림도 같은 이스케이프 규칙
  const fm = H.renderFailureMail({ label: '<i>x</i>', corp: '한국', scan: { ts: T0, kind: 'timeout', error: '<img src=x>', path: '/ifs/a', host: 'h' }, target: { host: 'h' }, failStreak: 2 });
  assert.ok(!fm.html.includes('<img src=x>')); assert.ok(!fm.html.includes('<i>x</i>'));
  assert.match(fm.subject, /조사 실패 — <i>x<\/i>/, '제목은 텍스트(메일 헤더)라 그대로');
  // 카드 묶음은 font-size:0·line-height:0 래퍼 안의 inline-block 이다 — 안쪽 카드가 글자 크기·줄 높이를 되돌리지 않으면
  // 라벨과 값이 한 줄 높이 0 에서 겹친다(Chromium 판독에서 발견). 좁은 화면 여백 축소(@media)도 함께 고정한다.
  const res = H.renderResultMail({ label: 'L', corp: '한국', report: { ok: true, ts: T0, total: { bytes: 1e12 }, entries: [{ path: '/ifs/a/x', bytes: 5e11 }] }, change: { growth: [{ path: '/ifs/a/x', delta: 1e11 }] } });
  for (const html of [mail.html, res.html]) {
    const inner = [...html.matchAll(/display:inline-block;vertical-align:top[^"]*"><div style="([^"]*)"/g)].map((x) => x[1]);
    for (const st of inner) {
      assert.match(st, /font-size:\d+px/, `카드 안쪽이 글자 크기를 되돌린다: ${st}`);
      assert.match(st, /line-height:1\.\d+/, `카드 안쪽이 줄 높이를 되돌린다: ${st}`);
    }
    assert.match(html, /@media only screen and \(max-width:520px\)/);
    assert.match(html, /class="dvc-outer"/);
  }
  assert.ok([...mail.html.matchAll(/display:inline-block;vertical-align:top/g)].length >= 4, 'KPI 카드 넷');
});

/* ── 실제 api 라우터 ──────────────────────────────────────────────────── */
async function call(method, url, body, user = { username: 'root', role: 'admin', superAdmin: true, scope: {} }) {
  const { api } = await import('../src/routes/api.js');
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

test('⑥ 라우터 — 슈퍼 관리자 전용 · 형식 오류 400 · 저장 · 상태에 주소 없음 · 대상 저장과 서로 지우지 않음', async () => {
  await setup();
  const plainAdmin = { username: 'ad', role: 'admin', superAdmin: false, scope: {} };
  for (const [m, u] of [['GET', '/tools/isilon-dirusage/digest'], ['PUT', '/tools/isilon-dirusage/digest'], ['POST', '/tools/isilon-dirusage/digest/send-now'], ['POST', '/tools/isilon-dirusage/digest/preview']]) {
    const r = await call(m, u, m === 'GET' ? undefined : {}, plainAdmin);
    assert.equal(r.status, 403, `${m} ${u} 는 슈퍼 관리자 전용`);
  }
  const g = await call('GET', '/tools/isilon-dirusage/digest');
  assert.equal(g.status, 200);
  assert.equal(g.body.digest.enabled, false, '옛 파일(필드 없음) — 기본값(꺼짐)으로 읽는다');
  assert.equal(g.body.digest.time, '08:00'); assert.equal(g.body.digest.since, null);
  assert.equal(g.body.status.enabled, false);
  assert.deepEqual(g.body.status.recipients, { total: 2, fromAdmin: 2, fromExtra: 0, dupes: 0 }, '기본은 통합 관리자 포함');
  assert.deepEqual(g.body.topNChoices, [5, 10, 20]);
  assert.equal(g.body.graceMin, 30);
  assert.deepEqual(g.body.adminTo, ['admin@corp.local', 'Lead@corp.local'], '화면이 저장 전 입력으로 받는 사람 수를 세도록 통합 관리자 주소를 준다(슈퍼 관리자 전용 응답)');
  assert.equal(g.body.offsetMin, 540);

  for (const [body, field] of [[{ enabled: true, days: [] }, 'digest.days'], [{ enabled: true, days: [1], time: '25:00' }, 'digest.time'], [{ enabled: true, days: [1], to: 'nope' }, 'digest.to'], [{ topN: 51 }, 'digest.topN'], [{ corpTopM: 21 }, 'digest.corpTopM']]) {
    const r = await call('PUT', '/tools/isilon-dirusage/digest', { digest: body });
    assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.body.field, field);
  }
  const ok = await call('PUT', '/tools/isilon-dirusage/digest', { digest: { enabled: true, days: [1, 3, 5], time: '08:00', to: 'extra@corp.local\nADMIN@corp.local' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.digest.enabled, true); assert.ok(ok.body.digest.since > 0, '서버가 since 를 정한다');
  assert.deepEqual(ok.body.status.recipients, { total: 3, fromAdmin: 2, fromExtra: 1, dupes: 1 });
  assert.equal(ok.body.status.next.length, 3, '다음 회차 3번');
  assert.ok(!JSON.stringify(ok.body.status).includes('@'), '상태에는 주소를 싣지 않는다(개수만)');

  // 대상 목록 저장이 종합 메일을 지우지 않는다
  const s = await call('GET', '/tools/isilon-dirusage/settings');
  const put = await call('PUT', '/tools/isilon-dirusage/settings', { ...s.body.settings, retentionDays: 300 });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const g2 = await call('GET', '/tools/isilon-dirusage/digest');
  assert.equal(g2.body.digest.enabled, true); assert.deepEqual(g2.body.digest.days, [1, 3, 5]);
  // 종합 메일 저장이 대상 목록·보존일을 건드리지 않는다
  await call('PUT', '/tools/isilon-dirusage/digest', { digest: { topN: 5 } });
  const s2 = await call('GET', '/tools/isilon-dirusage/settings');
  assert.equal(s2.body.settings.retentionDays, 300); assert.equal(s2.body.settings.targets.length, 5);
  assert.equal((await call('GET', '/tools/isilon-dirusage/digest')).body.digest.topN, 5);
});

test('⑥ 미리보기(보내지 않음 · 데모 포함 표시) · 지금 보내기(가짜 SMTP · 받는 사람 합집합 · 데모 제외) · 받는 사람 없음 409', async () => {
  const s = await setup();
  await call('PUT', '/tools/isilon-dirusage/digest', { digest: { enabled: true, days: [1, 3, 5], time: '08:00', to: 'extra@corp.local\nADMIN@corp.local', topN: 10 } });
  const before = s.st.mails.length;
  const pv = await call('POST', '/tools/isilon-dirusage/digest/preview', { digest: { topN: 5, includeTargets: false } });
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.demoIncluded, 1); assert.match(pv.body.html, /미리보기/); assert.match(pv.body.html, /demo-folder-xyz/, '미리보기는 데모를 넣고 그 사실을 밝힌다');
  assert.ok(!pv.body.html.includes('수집 대상별'), '저장하지 않은 화면 값(includeTargets:false)으로 만든다');
  assert.equal(s.st.mails.length, before, '미리보기는 보내지 않는다');
  assert.equal((await call('POST', '/tools/isilon-dirusage/digest/preview', { digest: { topN: 51 } })).status, 400);

  const sn = await call('POST', '/tools/isilon-dirusage/digest/send-now', {});
  assert.equal(sn.status, 200, JSON.stringify(sn.body));
  assert.equal(sn.body.state, 'sent'); assert.equal(sn.body.to, 3);
  assert.equal(s.st.mails.length, before + 1);
  const got = s.st.mails.at(-1);
  assert.deepEqual(got.rcpt, ['admin@corp.local', 'Lead@corp.local', 'extra@corp.local'], '통합 관리자 먼저 · ADMIN@ 은 같은 주소라 한 번');
  assert.match(got.subject, /종합 보고/);
  assert.match(got.data, /alpha/);
  assert.ok(!got.data.includes('demo-folder-xyz'), '실제 메일에는 데모 대상을 넣지 않는다');
  const st = (await call('GET', '/tools/isilon-dirusage/digest')).body.status;
  assert.equal(st.history[0].state, 'sent'); assert.equal(st.history[0].kind, 'manual');
  assert.equal(st.lastSlot, null, '지금 보내기는 회차 기록을 건드리지 않는다');

  await call('PUT', '/tools/isilon-dirusage/digest', { digest: { includeAdmin: false, to: '' } });
  const none = await call('POST', '/tools/isilon-dirusage/digest/send-now', {});
  assert.equal(none.status, 409); assert.equal(none.body.code, 'no-recipients');
  assert.equal(s.st.mails.length, before + 1);
  // 메일 종류를 끄면 보내지 않고 사유를 남긴다
  await call('PUT', '/tools/isilon-dirusage/digest', { digest: { includeAdmin: true } });
  writeJson('mail.json', { ...JSON.parse(fs.readFileSync(path.join(TMP, 'mail.json'), 'utf8')), kinds: { isidu: { enabled: false } } });
  const { invalidate } = await import('../src/mail/settings.js'); invalidate();
  const off = await call('POST', '/tools/isilon-dirusage/digest/send-now', {});
  assert.equal(off.status, 409); assert.equal(off.body.state, 'skipped'); assert.equal(off.body.code, 'mail-off');
  writeJson('mail.json', { ...JSON.parse(fs.readFileSync(path.join(TMP, 'mail.json'), 'utf8')), kinds: {} });
  invalidate();
  assert.equal(s.st.mails.length, before + 1);
});

/* ── 틱 ──────────────────────────────────────────────────────────────── */
test('⑦ 틱 — 정한 시각 한 번 · 재시작 뒤에도 같은 회차 안 보냄 · 새 조사 없으면 생략 · 놓침은 기록만 · 엣지는 안 보냄', async () => {
  const s = await setup();
  const S = await import('../src/isidu/settings.js');
  const D = await import('../src/isidu/digest.js');
  const db = await import('../src/isidu/db.js');
  const allDays = [0, 1, 2, 3, 4, 5, 6];
  let now = Date.now();
  // 10분 전 회차 — since 는 3시간 전(그 회차보다 앞) → 보낸다
  let r = S.saveDigestSettings({ enabled: true, days: allDays, time: hhmm(now - 10 * 60_000), includeAdmin: true, to: [], skipIfNoNew: false }, now - 3 * HOUR);
  assert.equal(r.ok, true, r.error);
  const before = s.st.mails.length;
  const t1 = await D.digestTick(now);
  assert.equal(t1.action, 'send', JSON.stringify(t1)); assert.equal(t1.result.state, 'sent', JSON.stringify(t1.result));
  assert.equal(s.st.mails.length, before + 1);
  assert.equal((await D.digestTick(now + 60_000)).action, 'none', '같은 회차는 한 번만');
  // 재시작 — 메모리를 버리고 상태 파일에서 다시 읽는다
  D._resetForTest();
  assert.equal((await D.digestTick(now + 2 * 60_000)).action, 'none', '재시작 뒤에도 같은 회차를 보내지 않는다');
  assert.equal(s.st.mails.length, before + 1);
  const stateRaw = fs.readFileSync(path.join(TMP, 'isidu-digest-state.json'), 'utf8');
  assert.ok(!stateRaw.includes('@'), '상태 파일에 주소를 남기지 않는다');
  assert.equal((fs.statSync(path.join(TMP, 'isidu-digest-state.json')).mode & 0o777), 0o600);

  // 새 조사 없으면 생략 — 5분 전 회차(다른 시각)
  now = Date.now();
  r = S.saveDigestSettings({ time: hhmm(now - 5 * 60_000), skipIfNoNew: true }, now - 3 * HOUR);
  assert.equal(r.ok, true, r.error);
  const t2 = await D.digestTick(now);
  assert.equal(t2.action, 'send'); assert.equal(t2.result.state, 'skipped'); assert.equal(t2.result.code, 'no-new');
  assert.equal(s.st.mails.length, before + 1);
  // 새 성공 조사가 끝나면 보낸다
  const nr = await db.insertScan(scanRec('tg-b', Date.now() - 60_000, [['beta', 52 * G]]));
  assert.equal(nr.ok, true, nr.error);
  const sent = await D.sendDigest({ slot: Date.now() });
  assert.equal(sent.state, 'sent', JSON.stringify(sent));
  assert.equal(s.st.mails.length, before + 2);

  // 놓침 — 1시간 뒤 회차를 3시간 뒤에야 확인(이 프로세스는 그때 떠 있었다) → 'late' 로 기록만, 보내지 않는다
  now = Date.now();
  r = S.saveDigestSettings({ time: hhmm(now + HOUR), skipIfNoNew: false }, now - 3 * HOUR);
  assert.equal(r.ok, true, r.error);
  const t3 = await D.digestTick(now + 3 * HOUR);
  assert.equal(t3.action, 'missed', JSON.stringify(t3));
  assert.equal(t3.reason, 'late');
  assert.equal(s.st.mails.length, before + 2, '놓친 회차는 몰아서 보내지 않는다');
  const hist = D.isiduDigestStatus().history;
  assert.equal(hist[0].state, 'missed'); assert.equal(hist[0].code, 'late');
  assert.equal((await D.digestTick(now + 3 * HOUR + 60_000)).action, 'none', '놓친 회차를 다음 틱에 다시 보내지 않는다');

  // 엣지 노드는 보내지 않는다
  const { config } = await import('../src/config.js');
  const keep = { centralUrl: config.agent.centralUrl, centralToken: config.agent.centralToken };
  Object.assign(config.agent, { centralUrl: 'https://central.example.invalid', centralToken: 'x' });
  try {
    assert.equal((await D.digestTick(Date.now())).action, 'edge');
    assert.equal((await D.sendDigestNow('root')).state, 'edge');
  } finally { Object.assign(config.agent, keep); }
  assert.equal(s.st.mails.length, before + 2);
});

test('⑦ 상태 파일 손상 — 보존하고 새로 시작한다(던지지 않는다)', async () => {
  await setup();
  const D = await import('../src/isidu/digest.js');
  fs.writeFileSync(path.join(TMP, 'isidu-digest-state.json'), '{ broken');
  D._resetForTest();
  const st = D.isiduDigestStatus();
  assert.deepEqual(st.history, []);
  assert.ok(fs.readdirSync(TMP).some((n) => n.startsWith('isidu-digest-state.json.corrupt')), '손상 원본을 보존한다');
});

test('⑧ 상태 파일·카탈로그 등록 — 상태 파일은 백업 감시 밖 · 메일 종류 설명이 새 설정 위치를 말한다', async () => {
  const { isRuntimeStateFile } = await import('../src/backup/service.js');
  assert.equal(isRuntimeStateFile('isidu-digest-state.json'), true);
  const K = await import('../src/mail/kinds.js');
  assert.match(JSON.stringify(K.MAIL_KINDS?.find?.((k) => k.key === 'isidu') || K), /종합 메일|아이실론/);
});
