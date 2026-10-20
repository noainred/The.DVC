/**
 * test/isiduLead2745.test.js — v2.745 검토 확정분 중 수정 그룹이 맡지 못한 것(리드 통합) 회귀.
 *
 *   SCHED-05·F4 정기 발송 대상에 늦게 온 옛 결과(성공·실패 모두)는 마지막 메일 기록(실제 정기 발송 결과)을 '건너뜀' 으로 덮지 않는다.
 *            '조사가 끝날 때마다' 대상은 예전대로 그 사실을 기록한다(대조군).
 *   F3       '지금 보내기' 메일 바닥글은 그 대상의 실제 보내는 때를 말한다 — 정기 발송 대상에 '조사가 끝날 때마다 보냅니다' 라고 적지 않는다.
 *   TOPNM-05 종합 메일 설정 저장 감사 로그에 corpTopM 이 남고, 조회 응답은 실제 범위(ranges)를 싣는다.
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'isidulead2745-'));
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


/* ── SCHED-05·F4 ─────────────────────────────────────────────────────── */
test('SCHED-05·F4 정기 발송 대상에 늦게 온 옛 실패 결과는 마지막 정기 발송 기록을 덮지 않는다 · 조사마다 대상은 예전대로 기록', async () => {
  const s = await setup();
  const db = await import('../src/isidu/db.js');
  const N = await import('../src/isidu/notify.js');
  N._resetForTest();
  writeJson('isidu-settings.json', settingsOf([
    { id: 'tS', label: '정기', host: '10.0.0.7', username: 'admin', path: ROOT, topN: 2, mail: { to: ['s@corp.local'], excludeCommon: true, onlyOnChange: false, skipIfNoNew: false, onFailure: true, ...SCHED, since: REF } },
    { id: 'tC', label: '조사마다', host: '10.0.0.8', username: 'admin', path: ROOT, topN: 2, mail: { to: ['c@corp.local'], excludeCommon: true, onlyOnChange: false, onFailure: true } },
  ]));
  const before = s.st.mails.length;
  const ts1 = SLOTS[0] - 2 * HOUR;
  const r1 = await db.insertScan(scanRec('tS', ts1, [['big', 40 * G]]));
  assert.equal((await N.notifyScanStored({ targetId: 'tS', scanId: r1.id, ok: true, ts: ts1 })).state, 'scheduled');
  await N.targetMailTick(SLOTS[0] + MIN, { bootAt: REF });
  const sent = N.isiduMailStateOf('tS');
  assert.equal(sent?.state, 'sent', JSON.stringify(sent));
  assert.equal(s.st.mails.length, before + 1);

  // 엣지가 밀린 옛 실패 결과를 늦게 보냄(ts 가 마지막으로 다룬 조사보다 이르다)
  const old = await N.notifyScanStored({ targetId: 'tS', scanId: r1.id - 1000, ok: false, ts: ts1 - 3 * HOUR });
  assert.equal(old.state, 'older');
  assert.equal(old.last, undefined, '정기 발송 대상은 기록을 남기지 않는다');
  assert.deepEqual(N.isiduMailStateOf('tS'), sent, `마지막 정기 발송 기록이 그대로다: ${JSON.stringify(N.isiduMailStateOf('tS'))}`);
  // 옛 성공 결과도 같다
  const old2 = await N.notifyScanStored({ targetId: 'tS', scanId: r1.id - 999, ok: true, ts: ts1 - 2 * HOUR });
  assert.equal(old2.state, 'older');
  assert.deepEqual(N.isiduMailStateOf('tS'), sent);
  assert.equal(s.st.mails.length, before + 1, '옛 결과로 메일을 보내지 않는다');

  // 대조군 — 조사마다 대상은 그 사실을 기록한다(예전 동작)
  const tsC = REF + 5 * HOUR;
  const rc = await db.insertScan(scanRec('tC', tsC, [['u', 3 * G]]));
  assert.equal((await N.notifyScanStored({ targetId: 'tC', scanId: rc.id, ok: true, ts: tsC })).state, 'sent');
  const oc = await N.notifyScanStored({ targetId: 'tC', scanId: rc.id - 1000, ok: false, ts: tsC - HOUR });
  assert.equal(oc.state, 'older');
  assert.equal(N.isiduMailStateOf('tC')?.state, 'skipped');
  assert.match(N.isiduMailStateOf('tC').reason, /오래된 결과/);
});

/* ── F3 ──────────────────────────────────────────────────────────────── */
test("F3 '지금 보내기' 메일 바닥글은 그 대상의 보내는 때를 말한다", async () => {
  await setup();
  const db = await import('../src/isidu/db.js');
  const N = await import('../src/isidu/notify.js');
  const { buildReport } = await import('../src/isidu/report.js');
  writeJson('isidu-settings.json', settingsOf([
    { id: 'tF', label: '정기 수동', host: '10.0.0.9', username: 'admin', path: ROOT, topN: 2, mail: { to: ['f@corp.local'], excludeCommon: true, onlyOnChange: true, ...SCHED, since: REF } },
    { id: 'tG', label: '조사마다 수동', host: '10.0.0.10', username: 'admin', path: ROOT, topN: 2, mail: { to: ['g@corp.local'], excludeCommon: true, onlyOnChange: true } },
  ]));
  const S = await import('../src/isidu/settings.js');
  const tgt = (id) => S.loadSettings().targets.find((t) => t.id === id);
  for (const id of ['tF', 'tG']) {
    const r = await db.insertScan(scanRec(id, REF + HOUR, [['big', 20 * G], ['small', 1 * G]]));
    assert.equal(r.ok, true, r.error);
  }
  const repF = await buildReport('tF', { topN: 2 });
  const repG = await buildReport('tG', { topN: 2 });
  assert.equal(repF.state, 'ok');
  const mF = N.buildResultMail(tgt('tF'), repF, { manual: true });
  const mG = N.buildResultMail(tgt('tG'), repG, { manual: true });
  const auto = N.buildResultMail(tgt('tG'), repG, {});
  const html = (m) => String(m.html || '');
  assert.match(html(mF), /지금 보내기로 보낸 메일입니다/);
  assert.match(html(mF), /평소에는 정기 발송 · /);
  assert.doesNotMatch(html(mF), /조사가 끝날 때마다 보냅니다/, '정기 발송 대상의 수동 메일이 조사마다 보낸다고 말하지 않는다');
  assert.match(html(mG), /평소에는 조사가 끝날 때마다 보냅니다/);
  assert.match(html(auto), /조사가 끝날 때마다 보냅니다\(직전 조사와/, '자동 발송 문구는 예전 그대로');
  assert.doesNotMatch(html(auto), /지금 보내기로/);
});

/* ── TOPNM-05 ────────────────────────────────────────────────────────── */
test('TOPNM-05 종합 메일 저장 감사 로그에 corpTopM · 조회 응답에 ranges', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(new URL('../src/routes/api/isilonDirUsage.js', import.meta.url), 'utf8'));
  const audit = src.split('\n').find((l) => /action: 'isidu\.digest',/.test(l)) || '';
  assert.match(audit, /corpTopM=\$\{d\.corpTopM\}/, '감사 로그에 corpTopM 을 남긴다');
  assert.match(audit, /topN=\$\{d\.topN\}/);
  const D = await import('../src/isidu/digestRules.js');
  assert.match(src, /ranges: DIGEST_RANGES/, '조회 응답이 실제 범위를 싣는다');
  assert.equal(D.DIGEST_RANGES.topN.max, 50);
  assert.equal(D.DIGEST_RANGES.corpTopM.max, 20);
});
