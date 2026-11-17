/**
 * rebutDecideG23.test.js — 결정 권장안 G2 · G3 반증(적대적 재검토 — 커밋 7b76f6c4).
 *
 *  R1 73 ③ 덜 고침: GET /admin/mail 이 범위 관리자(쓰기 범위만 제한 — 조회는 전체)에게 settings 의 수신자 목록은 가렸지만 **같은 응답의
 *     status.history[].to**(실제로 보낸 수신자 주소)는 그대로 실었다 — scopeMailStatus 가 조회 범위(scopedVcenterIds)만 보기 때문.
 *  R2 68 D1 형제: notify.js prunedKeys(메일 '새로 넘음' 기억의 회복 판정)가 값 모름을 p.unknown 하나로만 봤다 — evaluate 는
 *     pct 를 만들 수 없는 파티션(용량 0 등 — 작은 파티션 무시를 끈 설정)도 값 모름으로 세어 VM 을 판정하지 않는데, 회복 판정은 그 VM 을 '읽음' 으로 보고 기억에서 뺐다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rebutG23-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_DIR = TMP;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});
const writeJson = (name, obj) => fs.writeFileSync(path.join(TMP, name), JSON.stringify(obj, null, 2));
const express = (await import('express')).default;
const FULL = { username: 'root', role: 'admin', scope: null };
const WRITE_SCOPED = { username: 'w', role: 'admin', scope: { writeVcenters: ['vc-kr'] } };

async function call(mount, user, method, url, body) {
  const app = express(); app.use(express.json());
  app.use((req, _r, next) => { req.user = user; next(); });
  mount(app);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, body: json, text };
  } finally { srv.close(); }
}

/** 가짜 SMTP — AUTH 없이 받는다(계정 없는 설정). */
async function fakeSmtp() {
  const st = { mails: 0 };
  const srv = net.createServer((sock) => {
    let buf = ''; let inData = false;
    sock.write('220 fake ESMTP\r\n');
    const handle = (line) => {
      if (inData) { if (line === '.') { inData = false; st.mails += 1; sock.write('250 2.0.0 queued\r\n'); } return; }
      const u = line.toUpperCase();
      if (u.startsWith('EHLO') || u.startsWith('HELO')) sock.write('250 fake\r\n');
      else if (u.startsWith('MAIL FROM') || u.startsWith('RCPT TO') || u.startsWith('RSET')) sock.write('250 ok\r\n');
      else if (u === 'DATA') { inData = true; sock.write('354 go\r\n'); }
      else if (u === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('502 no\r\n');
    };
    sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); handle(l); } });
    sock.on('error', () => {});
  });
  const port = await new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
  closers.push(() => new Promise((r) => srv.close(() => r())));
  return { st, port };
}

/* ── R1 73 ③: 발송 이력의 수신자 주소도 가린다 ─────────────────────── */
test('R1 73 ③: GET /admin/mail — 쓰기 범위만 제한된 관리자에게 발송 이력(status.history)의 수신자 주소도 싣지 않는다 · 전체 범위는 원문', async () => {
  const smtp = await fakeSmtp();
  writeJson('mail.json', { enabled: true, smtp: { host: '127.0.0.1', port: smtp.port, startTls: false, user: '', password: '', from: 'portal@corp.local', timeoutMs: 5000 }, defaultTo: ['ops@corp.com'], kinds: {}, rateLimitPerHour: 0 });
  const M = await import('../src/mail/settings.js');
  M.invalidate();
  const S = await import('../src/mail/service.js');
  S._resetMail();
  const sent = await S.sendPortalMail({ kind: 'test', to: ['secret-rcpt@corp.com'], subject: '이력 가림 시험', text: 'x' });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(smtp.st.mails, 1);
  const { registerMail } = await import('../src/routes/admin/mail.js');
  const mount = (app) => { const r = express.Router(); registerMail(r); app.use('/api/admin', r); };

  const full = await call(mount, FULL, 'GET', '/api/admin/mail');
  assert.equal(full.status, 200);
  assert.deepEqual(full.body.status.history[0].to, ['secret-rcpt@corp.com'], '전체 범위는 원문(예전 그대로)');

  const w = await call(mount, WRITE_SCOPED, 'GET', '/api/admin/mail');
  assert.equal(w.status, 200);
  assert.equal(w.body.settings.scopedMasked, true, '설정은 이미 가렸다(73 ③)');
  assert.ok(!w.text.includes('secret-rcpt@corp.com'), `같은 응답의 발송 이력에 수신자 주소가 남으면 안 된다: ${JSON.stringify(w.body.status.history)}`);
  assert.ok(!w.text.includes('ops@corp.com'), '기본 수신자도 어디에도 없다');
  const h = w.body.status.history[0];
  assert.equal(h.subject, '이력 가림 시험', '제목 · 상태는 그대로(조회 범위는 전체 — 법인 축 가림은 scopeMailStatus 몫)');
  assert.equal(h.state, 'sent');
  assert.equal(h.toCount, 1, '수신자 수는 남긴다');
  assert.equal(w.body.status.historyMasked, true);
});

/* ── R2 68 D1 형제: 회복 판정의 '값 모름' 은 evaluate 와 같은 기준 ─────── */
test('R2 68 D1: 메일 기억(prunedKeys) — evaluate 가 값 모름으로 판정하지 않은 VM(용량 0 파티션 · 작은 파티션 무시 꺼짐)을 회복으로 빼지 않는다', async () => {
  const H = 3_600_000;
  const NOW = Math.floor(Date.now() / H) * H - 30 * 60_000;   // 정시 −30분 고정
  const GS = await import('../src/guestpart/settings.js');
  const saved = GS.save({ mode: 'vm', rules: { tinyOn: false } });
  assert.ok(!saved?.error, JSON.stringify(saved));
  const db = await import('../src/guestdisk/db.js');
  const vm = { vmId: 'vc-r2:vm1', vmName: 'r2', allocGB: 100, usedGB: 95, partCount: 2, parts: [{ path: 'C:\\', capGB: 100, usedGB: 95 }, { path: 'E:\\', capGB: 0, usedGB: 0 }] };
  assert.ok((await db.commitCollection('vc-r2', 'VC-R2', [vm], { ts: NOW })).ok);
  const rows = await db.listPartLatest(['vc-r2']);
  const e = rows.find((p) => p.path === 'E:\\');
  assert.ok(e && e.unknown === false && e.capGB === 0, `용량 0 파티션은 값 모름 표지 없이 적재된다: ${JSON.stringify(e)}`);
  const R = await import('../src/guestpart/rules.js');
  const ev = R.evaluate(rows, GS.load(), { mode: 'vm' });
  const v = ev.vms.get('vc-r2:vm1');
  assert.equal(v.pct, null, 'evaluate 는 이 VM 을 판정하지 않는다(값 모름 1)');
  assert.equal(v.unknown, 1);
  const N = await import('../src/guestpart/notify.js');
  const kept = await N._prunedKeysForTest(['vc-r2:vm1'], new Set(), ['vc-r2']);
  assert.deepEqual(kept, ['vc-r2:vm1'], '판정하지 않은 VM 은 초과가 아니어도 회복이 아니다 — 기억에서 빼면 다음 초과가 다시 \'새로 넘음\' 메일이 된다');
});

/* ── R3 74 ② 개선: provision-runs.json 직렬화 — 끝난 작업은 기억(같은 바이트 · 실측 비율) ─────── */
test('R3 74 ②: 작업 목록 직렬화는 예전과 같은 바이트이고, 끝난 작업은 다시 직렬화하지 않는다(50작업 × 500대 — 비율)', async () => {
  const H = 3_600_000;
  const NOW = Math.floor(Date.now() / H) * H - 30 * 60_000;
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebutG23jobs-'));
  try {
    const jobs = [];
    for (let j = 0; j < 50; j += 1) {
      const vms = [];
      for (let i = 0; i < 500; i += 1) vms.push({ name: `web-${j}-${i}`, hostname: `web-${j}-${i}`, ip: `10.${j}.${i >> 8}.${i & 255}`, status: j === 0 && i < 3 ? 'submitted' : 'done', error: null, task: `task-${j}-${i}`, submittedAt: NOW });
      jobs.push({ id: `job-${j}`, createdAt: new Date(NOW).toISOString(), createdBy: 'admin', vcenterId: 'vc-a', sourceId: 's', sourceName: 'tmpl', live: true, status: j === 0 ? 'running' : 'completed', placement: {}, vms });
    }
    fs.writeFileSync(path.join(dir, 'provision-runs.json'), JSON.stringify({ jobs }));
    const code = `const J = await import(${JSON.stringify(path.join(SRC, 'provision/jobs.js'))});
      const VM_KEEP = ['name', 'hostname', 'ip', 'status', 'error', 'task', 'submittedAt'];
      const a = J.serializeJobs();
      const parsed = JSON.parse(a);
      const old = () => JSON.stringify({ jobs: parsed.jobs.map((j) => ({ ...j, vms: j.vms.map((v) => Object.fromEntries(VM_KEEP.filter((k) => v[k] !== undefined).map((k) => [k, v[k]]))) })) });
      const same = old() === a && J.serializeJobs() === a;
      let tOld = Infinity; let tNew = Infinity;
      for (let k = 0; k < 6; k += 1) { let t = performance.now(); old(); tOld = Math.min(tOld, performance.now() - t); t = performance.now(); J.serializeJobs(); tNew = Math.min(tNew, performance.now() - t); }
      console.log('@@' + JSON.stringify({ same, n: parsed.jobs.length, first: parsed.jobs[0].status, firstVms: parsed.jobs[0].vms.slice(0, 4).map((v) => v.status), tOld, tNew }));`;
    const r = spawnSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', code], { env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock' }, encoding: 'utf8', timeout: 90_000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('@@')).slice(2));
    assert.equal(out.same, true, '예전 직렬화(JSON.stringify({ jobs: jobs.map(slimJob) }))와 같은 바이트');
    assert.equal(out.n, 50);
    assert.equal(out.first, 'completed_with_unknown', '재기동 판정은 그대로');
    assert.deepEqual(out.firstVms, ['unknown', 'unknown', 'unknown', 'done']);
    assert.ok(out.tNew * 3 < out.tOld, `끝난 작업은 기억한 직렬화를 쓴다 — 새 ${out.tNew.toFixed(1)}ms · 통째 ${out.tOld.toFixed(1)}ms`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
