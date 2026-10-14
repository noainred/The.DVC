/**
 * test/isidu2736.test.js — 아이실론 디렉터리 사용량(v2.736).
 *
 * 순수 헬퍼만 고정하면 v2.566(push 함수가 첫 줄에서 죽었는데 테스트는 통과) 같은 결함을 놓친다 — 그래서 여기서는
 *   · 가짜 SSH 서버(공개키 인증 · exec 로 du 출력)로 collect.collectTarget 을 **실제로** 돌리고
 *   · 실제 centralRouter 로 엣지 수신(isidu-data · isidu-config)을, 실제 api 라우터로 화면 API 를 부르고
 *   · push.pushIsiduNow 를 실제로 불러 중앙까지 올린다.
 * 출력 픽스처는 사용자가 보낸 캡처의 **형식**(`<크기>\t<경로>` · -h 반올림 표기 · 루트 합계 줄)만 옮기고 이름은 합성이다(공개 저장소 — v2.513).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import ssh2 from 'ssh2';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'isidu2736-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.CENTRAL_TOKEN = 'ctok-2736';
process.env.SSH_HOSTKEY_POLICY = 'observe'; // 호스트키가 주제가 아니다(가짜 SSH 장비)
process.env.ISIDU_SSH_KEY = '';
process.env.COLLECTOR_TOKEN = 'coltok-2736'; // ⑨ — 같은 프로세스가 엣지의 collector 라우트도 맡는다

const GIB = 1024 ** 3;
const ROOT = '/ifs/data/workspace/users';
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const P = await import('../src/isidu/parse.js');
const S = await import('../src/isidu/settings.js');
const db = await import('../src/isidu/db.js');
const R = await import('../src/isidu/report.js');
const { config } = await import('../src/config.js');

/* ═══════════════════════════ ① 파서 ═══════════════════════════ */

test('① du -h 출력 — 반올림 해상도·루트 합계 제외·권한 오류 줄·하위 깊이 무시·끝 슬래시 경로(사용자 명령 그대로)', () => {
  const stdout = [
    `73G\t${ROOT}/alpha.kim`,
    ` 3.9G\t${ROOT}/beta.lee`,           // 앞 공백도 받는다
    `961K\t${ROOT}/gamma.park`,
    `16K\t${ROOT}/delta.choi`,
    `0B\t${ROOT}/empty.one`,
    `2.0G\t${ROOT}/alpha.kim/deeper`,     // -d 1 이면 안 나오지만 나와도 직계만 센다
    'garbage line',
    `77G\t${ROOT}`,
  ].join('\n');
  const r = P.parseDuOutput(stdout, `${ROOT}/`, { mode: 'h', stderr: `du: ${ROOT}/zeta/.snapshot: Permission denied\n` });
  const by = new Map(r.entries.map((e) => [e.name, e]));
  assert.equal(r.entries.length, 5);
  assert.equal(by.get('alpha.kim').bytes, 73 * GIB);
  assert.equal(by.get('alpha.kim').res, GIB, '10 이상은 1 단위 반올림');
  assert.equal(by.get('beta.lee').bytes, Math.round(3.9 * GIB));
  assert.equal(by.get('beta.lee').res, Math.round(0.1 * GIB), '10 미만은 0.1 단위');
  assert.equal(by.get('gamma.park').bytes, 961 * 1024);
  assert.equal(by.get('empty.one').bytes, 0);
  assert.equal(r.total.bytes, 77 * GIB, '루트 줄은 합계이고 순위에 넣지 않는다');
  assert.ok(!by.has(ROOT) && !by.has(''));
  assert.equal(r.errLines, 1);
  assert.match(r.errSample[0], /Permission denied/);
  assert.ok(r.skipped >= 1, '읽지 못한 줄은 센다');
});

test('① du -k 출력 — 정확한 KB(해상도 1KB) · -h 에서 단위 없는 숫자는 0 만', () => {
  const r = P.parseDuOutput(`76546048\t${ROOT}/alpha.kim\n12\t${ROOT}/tiny\n76546100\t${ROOT}\n`, ROOT, { mode: 'k' });
  assert.equal(r.entries.find((e) => e.name === 'alpha.kim').bytes, 76546048 * 1024);
  assert.equal(r.entries.find((e) => e.name === 'alpha.kim').res, 1024);
  assert.equal(P.parseSizeToken('123', 'h'), null, '-h 출력에 단위 없는 수는 읽지 않는다(지어내지 않는다)');
  assert.deepEqual(P.parseSizeToken('0', 'h'), { bytes: 0, res: 1 });
});

test('① 증감 — 반올림 해상도 안의 차이는 withinRes, 기준이 없으면 null', () => {
  const a = { bytes: Math.round(1.05 * GIB), res: Math.round(0.1 * GIB) };
  const b = { bytes: Math.round(1.0 * GIB), res: Math.round(0.1 * GIB) };
  assert.equal(P.deltaOf(a, b).withinRes, true);
  assert.equal(P.deltaOf({ bytes: 130 * GIB, res: GIB }, { bytes: 110 * GIB, res: GIB }).withinRes, false);
  assert.equal(P.deltaOf(a, null), null);
});

test('① 경로 판정 — /ifs 아래 절대 경로만, 작은따옴표·$·역슬래시·백틱·.. 금지 · 명령은 작은따옴표로 감싼다', () => {
  for (const bad of ['/data/x', "/ifs/data/x'; rm -rf /", '/ifs/$(id)', '/ifs/a\\b', '/ifs/`x`', '/ifs/../etc', '/ifs/./a', '', 'ifs/data']) {
    assert.ok(S.pathIssue(bad), `거부해야 한다: ${bad}`);
  }
  assert.equal(S.pathIssue(`${ROOT}/`), null);
  assert.equal(P.duCommand(`${ROOT}/`, 'h'), `du -A -h -d 1 '${ROOT}'`);
  assert.equal(P.duCommand(ROOT, 'k'), `du -A -k -d 1 '${ROOT}'`);
});

/* ═══════════════════════════ ② 설정 ═══════════════════════════ */

const { pickAgent, pickDatacenter } = await import('../src/cvp/formChoices.js');
const ctxWith = (devices, agents = ['edge-a']) => ({ devices, agents, dcs: [{ id: 'dc-1', name: '법인1' }], pickAgent, pickDatacenter, ssrfBlockReason: () => null });

test('② 설정 — 아이실론이 아닌 장비·목록에 없는 엣지·등록부 없이 계정 인증·빈 숫자 칸(이전 값 유지)', () => {
  const devs = [{ id: 'd-isi', type: 'isilon', host: '10.0.0.5' }, { id: 'd-unity', type: 'unity480', host: '10.0.0.6' }];
  assert.match(S.normalizeTarget({ deviceId: 'd-unity', path: ROOT }, null, ctxWith(devs)).error, /아이실론/);
  assert.match(S.normalizeTarget({ deviceId: 'nope', path: ROOT }, null, ctxWith(devs)).error, /등록부에 없/);
  assert.equal(S.normalizeTarget({ host: '10.1.1.1', username: 'admin', agent: 'Edge-Z', path: ROOT }, null, ctxWith(devs)).field, 'agent');
  assert.equal(S.normalizeTarget({ host: '10.1.1.1', username: 'admin', auth: 'device', path: ROOT }, null, ctxWith(devs)).field, 'auth');
  const ok = S.normalizeTarget({ host: '10.1.1.1', username: 'admin', agent: 'EDGE-A', datacenterId: '법인1', path: `${ROOT}/`, intervalHours: '' }, { id: 't1', intervalHours: 6 }, ctxWith(devs));
  assert.equal(ok.target.agent, 'edge-a', '대소문자만 다른 엣지는 목록 표기로');
  assert.equal(ok.target.datacenterId, 'dc-1', 'DataCenter 는 표시명으로 와도 id 로');
  assert.equal(ok.target.intervalHours, 6, '빈 칸은 이전 값(Number(\'\')===0 이 하한 1 로 승격되지 않게)');
  assert.equal(ok.target.path, ROOT);
});

test('② 실행 노드 지정(runVia) — 등록부 아이실론을 다른 엣지에서 실행 · 등록부 계정은 장비 담당 노드·메인에서만 · 시한 상한 120분', () => {
  const devs = [{ id: 'd-isi', type: 'isilon', host: '10.0.0.5', agent: 'edge-a' }];
  const ctx = ctxWith(devs, ['edge-a', 'edge-b']);
  const bad = S.normalizeTarget({ deviceId: 'd-isi', path: ROOT, auth: 'device', runVia: 'node', agent: 'edge-b' }, null, ctx);
  assert.equal(bad.field, 'auth', '다른 엣지의 스토리지 등록부에는 그 장비 계정이 없다');
  const toMain = S.normalizeTarget({ deviceId: 'd-isi', path: ROOT, auth: 'device', runVia: 'node', agent: '' }, null, ctx);
  assert.ok(toMain.target, '메인은 등록부 전체를 가진다');
  const ok = S.normalizeTarget({ deviceId: 'd-isi', path: ROOT, auth: 'key', runVia: 'node', agent: 'EDGE-B', timeoutMin: 999 }, null, ctx);
  assert.equal(ok.target.agent, 'edge-b');
  assert.equal(ok.target.timeoutMin, 120, '시한 상한 120분');
  const r = S.resolveTarget(ok.target, { devices: devs });
  assert.equal(r.agent, 'edge-b');
  assert.equal(r.agentSource, 'override');
  assert.equal(r.deviceAgent, 'edge-a');
  const follow = S.normalizeTarget({ deviceId: 'd-isi', path: ROOT, auth: 'key', runVia: 'device', agent: 'edge-b' }, null, ctx);
  assert.equal(follow.target.agent, undefined, "'장비 담당 노드' 면 고른 엣지를 저장하지 않는다");
  assert.equal(S.resolveTarget(follow.target, { devices: devs }).agent, 'edge-a');
  assert.equal(S.normalizeTarget({ deviceId: 'd-isi', path: ROOT, runVia: 'node', agent: 'nope' }, null, ctx).field, 'agent');
  const plan = S.sessionPlanOf({ timeoutMin: 120 });
  assert.ok(plan.sessionMs <= 7_200_000 && plan.cmdMs < plan.sessionMs, '세션 시한(2시간 상한)이 명령 시한보다 길다 — 세션이 먼저 끊기면 결과가 버려진다');
  assert.equal(S.sessionPlanOf({ timeoutMin: '' }).cmdMs, 30 * 60_000, '빈 값은 기본 30분');
});

/* ═══════════════════════════ ③ DB + 보고서 ═══════════════════════════ */

const DAY = 86_400_000;
const e = (name, gib, resGib = 1) => ({ name, bytes: Math.round(gib * GIB), res: Math.round(resGib * GIB) });
async function putScan(targetId, ts, entries, extra = {}) {
  const sum = entries.reduce((s, x) => s + x.bytes, 0);
  return db.insertScan({ agent: '', targetId, ts, ok: true, path: ROOT, host: 'h', sizeMode: 'h', total: { bytes: sum + GIB, res: GIB }, sumBytes: sum, sumRes: 0, count: entries.length, entries, ...extra });
}

test('③ 보고서 — 7일 변화·신규·사라짐·해상도 안·Top 비중 · 사용자 표 필터 · 추이', async () => {
  const now = Date.now();
  await putScan('tgt-r', now - 31 * DAY, [e('a', 100), e('b', 10), e('c', 1.0, 0.1), e('old', 5)]);
  await putScan('tgt-r', now - 8 * DAY, [e('a', 110), e('b', 10), e('c', 1.0, 0.1), e('old', 5)]);
  await putScan('tgt-r', now, [e('a', 130), e('b', 10), e('c', 1.05, 0.1), e('new', 2, 0.1)]);
  // 같은 (agent, 대상, 시각) 재적재는 중복(엣지 재전송 멱등)
  const dup = await putScan('tgt-r', now, [e('a', 1)]);
  assert.equal(dup.duplicate, true);

  const rep = await R.buildReport('tgt-r', { topN: 10 });
  assert.equal(rep.state, 'ok');
  assert.equal(rep.kpi.users, 4);
  assert.equal(rep.kpi.new7, 1);
  assert.equal(rep.kpi.removed7, 1);
  const a = rep.top.find((r) => r.name === 'a');
  assert.equal(a.rank, 1);
  assert.equal(a.d7.bytes, 20 * GIB);
  assert.equal(a.d7.withinRes, false);
  assert.equal(a.d30.bytes, 30 * GIB);
  const c = rep.top.find((r) => r.name === 'c');
  assert.equal(c.d7.withinRes, true, '0.05G 차이는 0.1G 반올림 안 — 증가로 단정하지 않는다');
  assert.equal(rep.top.find((r) => r.name === 'new').new7, true);
  assert.deepEqual(rep.growth.map((r) => r.name), ['a'], '해상도 안의 흔들림·신규는 증가 상위에 넣지 않는다');
  assert.ok(Array.isArray(a.spark) && a.spark.length >= 2, '30일 스파크라인');
  assert.ok(rep.base7.spanDays >= 7 && rep.base7.spanDays < 9, `실제 비교 간격을 밝힌다: ${rep.base7.spanDays}`);

  const n = await R.listUsers('tgt-r', { filter: 'new' });
  assert.deepEqual(n.rows.map((r) => r.name), ['new']);
  const rm = await R.listUsers('tgt-r', { filter: 'removed' });
  assert.deepEqual(rm.rows.map((r) => r.name), ['old']);
  assert.equal(rm.rows[0].removed, true);
  const byName = await R.listUsers('tgt-r', { sort: 'name', dir: 'asc', limit: 2 });
  assert.deepEqual(byName.rows.map((r) => r.name), ['a', 'b']);
  assert.equal(byName.total, 4);
  const q = await R.listUsers('tgt-r', { q: 'NE' });
  assert.deepEqual(q.rows.map((r) => r.name), ['new'], '검색은 대소문자 무시');

  const tr = await R.trend('tgt-r', { days: 90 });
  assert.equal(tr.points.length, 3);
  const tu = await R.trend('tgt-r', { name: 'old', days: 90 });
  assert.equal(tu.points.length, 2, '사라진 뒤의 스캔에는 점이 없다(0 을 지어내지 않는다)');
});

test('③ 7일 전 기준이 없으면 증감·신규·사라짐은 null(관측 2일로 7일 변화를 만들지 않는다)', async () => {
  const now = Date.now();
  await putScan('tgt-young', now - 2 * DAY, [e('a', 1)]);
  await putScan('tgt-young', now, [e('a', 2), e('b', 1)]);
  const rep = await R.buildReport('tgt-young');
  assert.equal(rep.base7, null);
  assert.equal(rep.kpi.new7, null);
  assert.equal(rep.kpi.removed7, null);
  assert.equal(rep.top[0].d7, null);
  assert.equal(rep.top[0].new7, null);
});

test('③ 실패 스캔은 최신 성공을 덮지 않고, 보고서가 그 실패를 말한다 · 실패만 있으면 failed-only', async () => {
  const now = Date.now();
  await putScan('tgt-f', now - DAY, [e('a', 1)]);
  await db.insertScan({ agent: '', targetId: 'tgt-f', ts: now, ok: false, kind: 'timeout', error: 'du 시한 초과' });
  const rep = await R.buildReport('tgt-f');
  assert.equal(rep.state, 'ok');
  assert.equal(rep.lastFailure.kind, 'timeout');
  assert.equal(rep.failStreak, 1);
  await db.insertScan({ agent: '', targetId: 'tgt-only-fail', ts: now, ok: false, kind: 'auth', error: 'x' });
  assert.equal((await R.buildReport('tgt-only-fail')).state, 'failed-only');
});

/* ═══════════════════════════ ④ SSH 실제 조사 ═══════════════════════════ */

const { Server } = ssh2;
function hostKey() { return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' }); }

/** 공개키 인증만 받는 가짜 아이실론. allowKey(publicKeyText) 로 허용 키를 정한다. */
async function fakeIsilon({ output, stderr = '', code = 0, rejectAll = false } = {}) {
  const st = { auths: 0, conns: 0, commands: [], allowed: null };
  const srv = new Server({ hostKeys: [hostKey()] }, (client) => {
    st.conns++;
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'none') st.auths++;
      if (rejectAll || ctx.method !== 'publickey' || !st.allowed) return ctx.reject(['publickey']);
      const pk = ssh2.utils.parseKey(st.allowed);
      if (ctx.key.algo !== pk.type || !ctx.key.data.equals(pk.getPublicSSH())) return ctx.reject(['publickey']);
      if (ctx.signature && !pk.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.reject(['publickey']);
      return ctx.accept();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acc, _rej, info) => {
          st.commands.push(info.command);
          const stream = acc();
          stream.write(typeof output === 'function' ? output(info.command) : output);
          if (stderr) stream.stderr.write(stderr);
          stream.exit(code);
          stream.end();
        });
      });
    });
    client.on('error', () => {});
  });
  const port = await new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
  closers.push(() => new Promise((r) => srv.close(() => r())));
  return { port, st, allow: (pub) => { st.allowed = pub; } };
}

test('④ 노드 SSH 키 — 없으면 0600 으로 만들고 공개키·지문을 준다 · 있으면 덮어쓰지 않는다', async () => {
  const K = await import('../src/isidu/sshKey.js');
  const r1 = K.ensureKey();
  assert.equal(r1.created, true);
  const f = path.join(DIR, 'ssh', K.KEY_FILE_NAME);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(DIR, 'ssh')).mode & 0o777, 0o700);
  const v = K.publicKeyView();
  assert.match(v.publicKey, /^ecdsa-sha2-nistp256 [A-Za-z0-9+/=]+/);
  assert.match(v.fingerprint, /^SHA256:/);
  assert.ok(!JSON.stringify(v).includes('PRIVATE KEY'), '공개 보기에 개인키가 없다');
  const before = fs.readFileSync(f, 'utf8');
  assert.equal(K.ensureKey().created, false);
  assert.equal(fs.readFileSync(f, 'utf8'), before, '있는 키는 덮어쓰지 않는다');
});

test('④ 가짜 아이실론에 키로 접속해 du 를 실제로 돌리고 해석한다 · 명령은 작은따옴표로 감싼 경로', async () => {
  const K = await import('../src/isidu/sshKey.js');
  const C = await import('../src/isidu/collect.js');
  const out = [`73G\t${ROOT}/alpha.kim`, `3.9G\t${ROOT}/beta.lee`, `961K\t${ROOT}/gamma.park`, `77G\t${ROOT}`].join('\n') + '\n';
  const fk = await fakeIsilon({ output: out, stderr: `du: ${ROOT}/x: Permission denied\n`, code: 1 });
  fk.allow(K.publicKeyView().publicKey);
  const t = { id: 'tgt-ssh', host: '127.0.0.1', port: fk.port, username: 'admin', auth: 'key', path: `${ROOT}/`, sizeMode: 'h', timeoutMin: 1 };
  const rec = await C.collectTarget(t, { trigger: 'manual', manual: true });
  assert.equal(rec.ok, true, rec.error);
  assert.equal(rec.count, 3);
  assert.equal(rec.errLines, 1, '권한 오류가 있어도 해석된 폴더가 있으면 성공 — 오류 줄 수를 남긴다');
  assert.equal(rec.total.bytes, 77 * GIB);
  assert.deepEqual(fk.st.commands, [`du -A -h -d 1 '${ROOT}'`]);
  const saved = await db.insertScan(rec);
  assert.equal(saved.ok, true);
});

test('④ 인증 거부 → 주기 수집은 멈춘다(다음 주기 로그인 0회) · 수동 실행은 시도한다 · 해석 0 은 실패', async () => {
  const C = await import('../src/isidu/collect.js');
  const fk = await fakeIsilon({ output: '', rejectAll: true });
  const t = { id: 'tgt-deny', host: '127.0.0.1', port: fk.port, username: 'admin', auth: 'key', path: ROOT, sizeMode: 'h', timeoutMin: 1 };
  const r1 = await C.collectTarget(t, { trigger: 'schedule' });
  assert.equal(r1.ok, false);
  assert.equal(r1.kind, 'auth');
  const conns1 = fk.st.conns;
  const r2 = await C.collectTarget(t, { trigger: 'schedule' });
  assert.equal(r2.kind, 'auth');
  assert.equal(r2.authStopped, true);
  assert.equal(fk.st.conns, conns1, '정지된 대상은 주기 수집에서 접속하지 않는다(계정 잠금 방지)');
  assert.ok(await C.authStopOf(t), '화면용 조회가 정지를 본다');
  await C.collectTarget(t, { trigger: 'manual', manual: true });
  assert.ok(fk.st.conns > conns1, '수동 실행은 막지 않는다');

  const K = await import('../src/isidu/sshKey.js');
  const empty = await fakeIsilon({ output: 'nothing useful\n' });
  empty.allow(K.publicKeyView().publicKey);
  const r3 = await C.collectTarget({ ...t, id: 'tgt-empty', port: empty.port }, { trigger: 'manual', manual: true });
  assert.equal(r3.ok, false, '해석된 것이 하나도 없으면 실패(빈 결과를 사용자 0명으로 만들지 않는다)');
  assert.equal(r3.kind, 'parse');
});

/* ═══════════════════════════ ⑤ 중앙 수신(실제 centralRouter) ═══════════════════════════ */

let centralPort = 0;
let edgeTargetId = '';
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/central', centralRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  centralPort = srv.address().port;
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
  // 엣지 edge-a 가 담당하는 아이실론 1대 + 그 대상
  const reg = await import('../src/storage/registry.js');
  const dev = reg.saveDevice({ type: 'isilon', name: 'ISI-A', host: '10.20.30.40', username: 'root', password: 'secret-pw', agent: 'edge-a', datacenterId: '' });
  const r = S.saveSettings({ targets: [{ id: 'tgt-edge', label: '엣지 대상', deviceId: dev.id, path: ROOT, auth: 'key', username: 'admin' }] },
    { devices: reg.listDevices(), agents: ['edge-a'], dcs: [], pickAgent, pickDatacenter, ssrfBlockReason: () => null });
  assert.equal(r.ok, true, r.error);
  edgeTargetId = 'tgt-edge';
});

const cpost = (url, body, agent = 'edge-a') => fetch(`http://127.0.0.1:${centralPort}/api/central${url}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': 'ctok-2736', 'X-Agent-Name': agent }, body: JSON.stringify(body),
});
const cget = (url, agent = 'edge-a') => fetch(`http://127.0.0.1:${centralPort}/api/central${url}`, { headers: { 'X-Central-Token': 'ctok-2736', 'X-Agent-Name': agent } });

test('⑤ isidu-config — 그 엣지 몫 대상만, 비밀 없음 · 다른 엣지는 빈 목록', async () => {
  const r = await cget('/isidu-config?agent=edge-a');
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.deepEqual(b.targets.map((t) => t.id), [edgeTargetId]);
  assert.equal(b.targets[0].host, '10.20.30.40', '주소는 등록부에서 읽는다');
  assert.ok(!JSON.stringify(b).includes('secret-pw'), '장비 비밀번호를 싣지 않는다');
  const o = await (await cget('/isidu-config?agent=edge-b', 'edge-b')).json();
  assert.deepEqual(o.targets, []);
});

test('⑤ isidu-data — 배정된 대상만 적재 · 남의 대상·형식 오류는 버리고 개수를 밝힌다 · 상태만 보고도 받는다 · 미래 시각은 자른다', async () => {
  const ts = Date.now() - 60_000;
  const r = await cpost('/isidu-data?agent=edge-a', {
    agent: 'edge-a',
    status: { key: { present: true, usable: true, type: 'ecdsa-sha2-nistp256', fingerprint: 'SHA256:abc', publicKey: 'ecdsa-sha2-nistp256 AAAAE2VjZHNh isidu@edge-a' } },
    scans: [
      { id: 1, targetId: edgeTargetId, ts, ok: true, path: ROOT, sizeMode: 'h', total: { bytes: 5 * GIB, res: 1 }, entries: [['u1', 3 * GIB, GIB], ['u2', GIB, 1], ['bad/name', 1, 1]] },
      { id: 2, targetId: 'tgt-r', ts, ok: true, entries: [['x', 1, 1]] },
      { id: 3, targetId: edgeTargetId, ts: Date.now() + 3_600_000, ok: false, kind: 'timeout', error: 'x' },
      'not-an-object',
    ],
  });
  const b = await r.json();
  assert.equal(r.status, 200, JSON.stringify(b));
  assert.equal(b.saved.inserted, 2);
  assert.equal(b.dropped.notOwned, 1, '남의 대상 id 는 버린다');
  assert.equal(b.dropped.bad, 1);
  assert.equal(b.dropped.entries, 1, "이름에 '/' 가 든 폴더는 버린다");
  assert.equal(b.dropped.futureClamped, 1);
  const lat = await db.latestOf('', edgeTargetId);
  assert.equal(lat.okScan.node, 'edge-a', '누가 조사했는지 남긴다');
  assert.ok(lat.lastTry.ts <= Date.now(), '미래 시각은 수신 시각으로 자른다');
  const ents = await db.entriesOf(lat.okScan.id);
  assert.deepEqual([...ents.keys()].sort(), ['u1', 'u2']);
  const E = await import('../src/central/isiduEdge.js');
  assert.match(E.isiduEdgeStatus('edge-a').status.key.publicKey, /^ecdsa-sha2-nistp256 /);
  const so = await cpost('/isidu-data?agent=edge-zero', { agent: 'edge-zero', status: { targets: 0 } }, 'edge-zero');
  assert.equal(so.status, 200, '대상 0건 엣지도 상태는 올린다');
});

test('⑤ 설정 파일 손상 — 설정 pull 은 503(엣지 사본을 지우지 않는다) · 결과 수신도 503 · 상태만 보고는 200', async () => {
  const f = path.join(DIR, 'isidu-settings.json');
  const good = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, '{not json');
  S._resetForTest();
  const quiet = console.warn; console.warn = () => {};
  try {
    const r = await cget('/isidu-config?agent=edge-a');
    assert.equal(r.status, 503);
    assert.equal((await r.json()).reason, 'settingsUnreadable');
    const d = await cpost('/isidu-data?agent=edge-a', { agent: 'edge-a', scans: [{ targetId: edgeTargetId, ts: Date.now(), ok: false, kind: 'exec' }] });
    assert.equal(d.status, 503);
    const s = await cpost('/isidu-data?agent=edge-a', { agent: 'edge-a', status: {} });
    assert.equal(s.status, 200);
  } finally {
    console.warn = quiet;
    fs.writeFileSync(f, good);
    S._resetForTest();
  }
  assert.equal((await cget('/isidu-config?agent=edge-a')).status, 200);
});

/* ═══════════════════════════ ⑥ 엣지 push(실제 호출) ═══════════════════════════ */

test('⑥ pushIsiduNow — 커서 뒤 로컬 스캔을 gzip 으로 올리고, 성공해야 커서를 전진한다 · 중앙 실패면 전진하지 않는다', async () => {
  const push = await import('../src/isidu/push.js');
  push._resetForTest();
  // 같은 프로세스가 엣지·중앙을 겸하므로(같은 DB) 이 로컬 스캔은 ⑤ 의 수신분보다 이른 시각으로 둔다 — ⑦ 이 최신 성공 스캔의 node 를 본다.
  await db.insertScan({ agent: '', targetId: edgeTargetId, ts: Date.now() - 2 * 3_600_000, ok: true, path: ROOT, sizeMode: 'h', total: { bytes: GIB, res: 1 }, entries: [{ name: 'p1', bytes: GIB, res: 1 }] });
  const quiet = console.warn; console.warn = () => {};
  const keep = { ...config.agent };
  try {
    config.agent.centralUrl = 'http://127.0.0.1:1';
    config.agent.centralToken = 'ctok-2736';
    config.agent.name = 'edge-a';
    const bad = await push.pushIsiduNow();
    assert.equal(bad.ok, false);
    assert.equal(push.isiduPushStatus().cursor, 0, '보내지 못했으면 커서를 전진하지 않는다');
    config.agent.centralUrl = `http://127.0.0.1:${centralPort}`;
    const okr = await push.pushIsiduNow();
    assert.equal(okr.ok, true, okr.reason);
    assert.ok(push.isiduPushStatus().cursor > 0, '받았으면 커서를 전진한다');
    assert.ok(push.isiduPushStatus().scans > 0);
  } finally { console.warn = quiet; Object.assign(config.agent, keep); }
});

/* ═══════════════════════════ ⑦ 화면 API(실제 api 라우터) ═══════════════════════════ */

async function call(user, method, url, body) {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message || err) }));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const raw = Buffer.from(await res.arrayBuffer());
    const text = raw.toString('utf8'); // Response.text() 는 BOM 을 벗긴다 — 원시 바이트로 읽는다
    let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, body: json, text, headers: res.headers };
  } finally { srv.close(); }
}
const ADMIN = { username: 'root', role: 'admin', scope: {} };
const OPER = { username: 'op', role: 'operator', scope: {} };
const SCOPED = { username: 'adm2', role: 'admin', scope: { vcenters: ['vc-x'] } };

test('⑦ 권한 — 관리자 + 전체 범위만(operator 403 · 범위 관리자 403)', async () => {
  assert.equal((await call(OPER, 'GET', '/tools/isilon-dirusage')).status, 403);
  assert.equal((await call(SCOPED, 'GET', '/tools/isilon-dirusage')).status, 403);
  const r = await call(ADMIN, 'GET', '/tools/isilon-dirusage');
  assert.equal(r.status, 200, r.text);
  const t = r.body.targets.find((x) => x.id === edgeTargetId);
  assert.equal(t.agent, 'edge-a');
  assert.equal(t.okScan.node, 'edge-a');
  assert.ok(r.body.edges.some((x) => x.agent === 'edge-a' && x.key?.publicKey), '엣지 공개키를 보여 준다(그 법인 아이실론에 등록할 값)');
  assert.ok(!r.text.includes('secret-pw'));
});

test('⑦ 보고서·사용자·추이·CSV · 저장 검증(400 field) · 엣지 대상 연결 시험은 그 엣지로 · 지금 수집은 엣지에 요청을 남긴다', async () => {
  const rep = await call(ADMIN, 'GET', `/tools/isilon-dirusage/report?target=${edgeTargetId}`);
  assert.equal(rep.status, 200, rep.text);
  assert.equal(rep.body.state, 'ok');
  assert.equal((await call(ADMIN, 'GET', '/tools/isilon-dirusage/report?target=nope')).status, 404);
  const us = await call(ADMIN, 'GET', `/tools/isilon-dirusage/users?target=${edgeTargetId}&sort=size`);
  assert.equal(us.status, 200);
  assert.ok(us.body.rows.length >= 1);
  assert.equal((await call(ADMIN, 'GET', `/tools/isilon-dirusage/trend?target=${edgeTargetId}&name=a/b`)).status, 400);
  const csv = await call(ADMIN, 'GET', `/tools/isilon-dirusage/export.csv?target=${edgeTargetId}`);
  assert.equal(csv.status, 200, csv.text);
  assert.ok(csv.text.charCodeAt(0) === 0xfeff, 'BOM');
  assert.match(csv.text, /사용자\(폴더\)/);
  const cur = (await call(ADMIN, 'GET', '/tools/isilon-dirusage/settings')).body.settings;
  const bad = await call(ADMIN, 'PUT', '/tools/isilon-dirusage/settings', { targets: [{ ...cur.targets[0], path: "/ifs/x'y" }] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.field, 'path');
  assert.equal((await call(OPER, 'PUT', '/tools/isilon-dirusage/settings', { targets: [] })).status, 403);
  // v2.736: 엣지 담당 대상의 연결 시험은 그 엣지로 보낸다 — 여기서는 edge-a 가 수집 서버로 등록되지 않아 '등록부에 없음' 을 말한다(⑨ 가 성공 경로).
  const tst = await call(ADMIN, 'POST', '/tools/isilon-dirusage/test', { id: edgeTargetId, ...cur.targets[0] });
  assert.equal(tst.status, 200, tst.text);
  assert.equal(tst.body.via, 'edge');
  assert.equal(tst.body.ok, false);
  assert.equal(tst.body.kind, 'not-registered');
  const run = await call(ADMIN, 'POST', '/tools/isilon-dirusage/run', { ids: [edgeTargetId] });
  assert.equal(run.status, 202);
  assert.deepEqual(run.body.requested.map((x) => x.id), [edgeTargetId]);
  assert.equal(run.body.nudged.length, 1);
  assert.equal(run.body.nudged[0].kind, 'not-registered', '바로 알리지 못해도 요청은 큐에 남는다(아래 설정 pull 이 가져간다)');
  const cfg = await (await cget('/isidu-config?agent=edge-a')).json();
  assert.deepEqual(cfg.runNow, [edgeTargetId], '엣지가 다음 설정 pull 에 요청을 가져간다');
});

/* ═══════════════════════════ ⑧ 엣지 설정 pull(실제 호출) ═══════════════════════════ */

test('⑧ pullIsiduConfigNow — 중앙 배정 대상을 엣지 사본에 적용 · 중앙 503 이면 사본을 지우지 않는다', async () => {
  const pull = await import('../src/agent/isiduConfigPull.js');
  const keep = { ...config.agent };
  const quiet = console.warn; console.warn = () => {};
  const f = path.join(DIR, 'isidu-settings.json');
  const good = fs.readFileSync(f, 'utf8');
  try {
    config.agent.centralUrl = `http://127.0.0.1:${centralPort}`;
    config.agent.centralToken = 'ctok-2736';
    config.agent.name = 'edge-a';
    const r = await pull.pullIsiduConfigNow();
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.count, 1);
    assert.deepEqual(S.edgeTargets().targets.map((t) => t.id), [edgeTargetId], '배정된 대상이 엣지 사본에 들어간다');
    assert.ok(!fs.readFileSync(path.join(DIR, 'isidu-edge-targets.json'), 'utf8').includes('secret-pw'), '엣지 사본에 장비 비밀번호가 없다');
    fs.writeFileSync(f, '{not json');
    S._resetForTest();
    const bad = await pull.pullIsiduConfigNow();
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /503/);
    assert.deepEqual(S.edgeTargets().targets.map((t) => t.id), [edgeTargetId], '중앙이 설정을 못 읽으면 엣지 사본을 그대로 둔다');
    assert.equal(pull.isiduConfigPullStatus().ok, false, '실패를 상태에 남긴다(무음 실패 금지)');
  } finally {
    console.warn = quiet;
    fs.writeFileSync(f, good);
    S._resetForTest();
    Object.assign(config.agent, keep);
  }
});

/* ═══════════════════════════ ⑨ 엣지 원격 실행·연결 시험(실제 collector 라우트) ═══════════════════════════ */

test('⑨ 지금 수집 → 그 엣지에 바로 알림(설정을 다시 받아 du 시작) · 연결 시험은 그 엣지가 · 구버전·불통은 kind 로', async () => {
  const express = (await import('express')).default;
  const { collectorRouter } = await import('../src/routes/collector.js');
  const edgeApp = express();
  edgeApp.use('/api/collector', collectorRouter);
  edgeApp.use('/api', (_req, res) => res.status(401).json({ error: 'unauthorized' })); // 경로 없음 → 사용자 인증 미들웨어(401)
  const es = await new Promise((r) => { const s = edgeApp.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => { es.closeAllConnections?.(); es.close(() => r()); }));
  const old = express(); old.use((_req, res) => res.status(401).json({ error: 'unauthorized' }));
  const os2 = await new Promise((r) => { const s = old.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => { os2.closeAllConnections?.(); os2.close(() => r()); }));

  const reg = await import('../src/collector/registry.js');
  assert.equal(reg.addCollector({ id: 'edge-a', name: 'edge-a', url: `http://127.0.0.1:${es.address().port}`, token: 'coltok-2736' }).ok, true);
  assert.equal(reg.addCollector({ id: 'edge-old', name: 'edge-old', url: `http://127.0.0.1:${os2.address().port}`, token: 'coltok-2736' }).ok, true);
  assert.equal(reg.addCollector({ id: 'edge-down', name: 'edge-down', url: 'http://127.0.0.1:1', token: 'coltok-2736' }).ok, true);

  // edge-a 가 조사할 직접 입력 대상 — 가짜 아이실론(이 프로세스의 키를 허용)
  const K = await import('../src/isidu/sshKey.js');
  const out = [`5.0G\t${ROOT}/remote.one`, `6.0G\t${ROOT}`].join('\n') + '\n';
  const fk = await fakeIsilon({ output: out });
  fk.allow(K.publicKeyView().publicKey);
  const cur = S.loadSettings().targets;
  const storage = await import('../src/storage/registry.js');
  const sv = S.saveSettings({ targets: [...cur, { id: 'tgt-remote', label: '원격', host: '127.0.0.1', port: fk.port, username: 'admin', auth: 'key', agent: 'edge-a', path: ROOT }] },
    { devices: storage.listDevices(), agents: ['edge-a'], dcs: [], pickAgent, pickDatacenter, ssrfBlockReason: () => null });
  assert.equal(sv.ok, true, sv.error);

  const keep = { ...config.agent };
  const quiet = console.warn; console.warn = () => {};
  try {
    config.agent.centralUrl = `http://127.0.0.1:${centralPort}`;
    config.agent.centralToken = 'ctok-2736';
    config.agent.name = 'edge-a';
    const run = await call(ADMIN, 'POST', '/tools/isilon-dirusage/run', { ids: ['tgt-remote'] });
    assert.equal(run.status, 202, run.text);
    const n = run.body.nudged.find((x) => x.agent === 'edge-a');
    assert.equal(n.ok, true, JSON.stringify(n));
    assert.equal(n.started, 1, '엣지가 설정을 다시 받아 **요청된** 수집만 바로 시작했다(엣지의 다른 대상은 건드리지 않는다)');
    const P2 = await import('../src/isidu/poller.js');
    await P2.waitIdle();
    assert.ok(fk.st.commands.includes(`du -A -h -d 1 '${ROOT}'`), '엣지가 du 를 실제로 실행했다');

    const tst = await call(ADMIN, 'POST', '/tools/isilon-dirusage/test', { id: 'tgt-remote', host: '127.0.0.1', port: fk.port, username: 'admin', auth: 'key', agent: 'edge-a', path: ROOT });
    assert.equal(tst.status, 200, tst.text);
    assert.equal(tst.body.via, 'edge');
    assert.equal(tst.body.node, 'edge-a');
    assert.equal(tst.body.ok, true, tst.text);
    assert.ok(fk.st.commands.includes(`ls -d '${ROOT}'`), '연결 시험은 그 엣지에서 ls -d 만 한다');

    // 다른 설정 pull 이 진행 중이면(요청이 큐에 들어가기 전에 시작했을 수 있다) 끝난 뒤 한 번 더 받는다.
    const pull = await import('../src/agent/isiduConfigPull.js');
    const EO = await import('../src/isidu/edgeOps.js');
    const p1 = pull.pullIsiduConfigNow();
    const n2 = await EO.edgeIsiduNudge();
    await p1;
    assert.equal(n2.ok, true, JSON.stringify(n2));

    const R2 = await import('../src/central/isiduRemote.js');
    assert.equal((await R2.nudgeIsiduEdge('edge-old')).kind, 'old-version', '경로가 없는 구버전 엣지(401)는 토큰 문제가 아니라 버전 문제다');
    assert.equal((await R2.nudgeIsiduEdge('edge-down')).kind, 'unreachable');
    assert.equal((await R2.nudgeIsiduEdge('edge-none')).kind, 'not-registered');
    const bad = await fetch(`http://127.0.0.1:${es.address().port}/api/collector/isidu-run`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Collector-Token': 'wrong' }, body: '{}' });
    assert.equal(bad.status, 403, '토큰이 틀리면 엣지가 거부한다');
    const badT = await fetch(`http://127.0.0.1:${es.address().port}/api/collector/isidu-test`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Collector-Token': 'coltok-2736' }, body: JSON.stringify({ target: { id: 'x', host: '127.0.0.1', username: 'admin', path: "/ifs/a'; id" } }) });
    assert.equal(badT.status, 400, '엣지도 경로를 다시 검증한다(메인이 보낸 값도 원격 셸에 들어간다)');
  } finally { console.warn = quiet; Object.assign(config.agent, keep); }
});
