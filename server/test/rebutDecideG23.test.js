/**
 * rebutDecideG23.test.js — 결정 권장안 G2 · G3 반증(적대적 재검토 — 커밋 7b76f6c4).
 *
 *  R1 73 ③ 덜 고침: GET /admin/mail 이 범위 관리자(쓰기 범위만 제한 — 조회는 전체)에게 settings 의 수신자 목록은 가렸지만 **같은 응답의
 *     status.history[].to**(실제로 보낸 수신자 주소)는 그대로 실었다 — scopeMailStatus 가 조회 범위(scopedVcenterIds)만 보기 때문.
 *  R2 68 D1 형제: notify.js prunedKeys(메일 '새로 넘음' 기억의 회복 판정)가 값 모름을 p.unknown 하나로만 봤다 — evaluate 는
 *     pct 를 만들 수 없는 파티션(용량 0 등 — 작은 파티션 무시를 끈 설정)도 값 모름으로 세어 VM 을 판정하지 않는데, 회복 판정은 그 VM 을 '읽음' 으로 보고 기억에서 뺐다.
 *  후속 ③' (결정 — '권장안대로'): 서비스 점검 조회가 오류가 선 공용 로더를 다시 판정한다(그 모듈이 불리지 않아도 되돌린 보존본의 줄이 지워진다 ·
 *     모듈 쪽은 다시 읽을 때까지 이전 오류 — 오류 중 캐시한 값으로 되돌린 파일을 덮지 않게).
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

/* ── 후속 ③ 공용 로더: 손상 상태 캐시 — 보존본을 되돌리면 30초 안에 재시작 없이 풀린다(모듈마다 회복 경로 하나) ─────── */
const J3 = await import('../src/util/jsonFileLoad.js');
let clock3 = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const tick3 = () => { clock3 += J3.READ_RETRY_MS + 1_000; };
const F3 = (n) => path.join(TMP, n);
const backups3 = (n) => fs.readdirSync(TMP).filter((x) => x.startsWith(`${n}.corrupt.`));
/**
 * 손상 → 보존 → (간격 안: 여전히 오류 — 캐시) → 온전한 파일을 되돌림 → 간격 뒤: 오류 풀림 · 값이 보인다.
 * @param {string} name 파일 이름 · @param {object} good 되돌릴 본문 · @param {() => any} probe 접근(값 반환) · @param {() => any} errOf 로드 오류(없으면 null)
 */
async function recoverCase(name, good, probe, errOf, check, { byMtime = false } = {}) {
  J3._setJsonFileLoadClockForTest(() => clock3);
  try {
    fs.writeFileSync(F3(name), '{ broken');
    probe();
    assert.ok(errOf(), `${name}: 손상이면 로드 오류`);
    assert.equal(backups3(name).length >= 1, true, `${name}: 보존본으로 옮겼다`);
    fs.writeFileSync(F3(name), JSON.stringify(good));
    probe();
    // 파일 mtime 으로 캐시를 가르는 모듈(DataCenter · fleet)은 되돌린 파일을 곧바로 본다 — 그 밖은 간격 안에서 디스크를 다시 보지 않는다
    if (!byMtime) assert.ok(errOf(), `${name}: 간격 안에서는 다시 판정하지 않는다(요청마다 디스크를 보지 않게)`);
    tick3();
    const v = probe();
    assert.equal(errOf() || null, null, `${name}: 되돌린 파일을 간격 뒤 다시 읽어 재시작 없이 풀린다`);
    check(v);
  } finally { J3._setJsonFileLoadClockForTest(); }
}

test('후속 ③: 손상 상태를 캐시하던 모듈 — 보존본을 되돌리면 30초 안에 재시작 없이 풀린다(9 모듈 · 쓰기도 열린다)', async () => {
  const A = await import('../src/ipam/annotations.js');
  await recoverCase('ipam-annotations.json', { '10.0.0.9': { memo: 'restored', tags: [] } }, () => A.getAnnotation('10.0.0.9'), () => A.annotationsLoadError(),
    (v) => { assert.equal(v?.memo, 'restored'); assert.equal(A.setAnnotation('10.0.0.8', { memo: 'n' }, { username: 'a' }).ok, true); });
  const O = await import('../src/ipam/overrides.js');
  await recoverCase('ipam-overrides.json', { '10.0.0.9': { status: 'reserved', owner: 'ops' } }, () => O.getOverride('10.0.0.9'), () => O.overridesLoadError(),
    (v) => assert.equal(v?.owner, 'ops'));
  const M = await import('../src/mail/settings.js');
  M.invalidate();
  await recoverCase('mail.json', { enabled: false, smtp: { host: 'relay.restored', port: 25, from: 'p@corp.local' }, defaultTo: [], kinds: {} }, () => M.load(), () => M.mailSettingsLoadError(),
    (v) => { assert.equal(v.smtp.host, 'relay.restored'); assert.equal(M.mailSaveRefusal(), null, '저장도 다시 열린다'); });
  const N = await import('../src/vmclone/nfsDs.js');
  N._resetNfsDsForTest();
  await recoverCase('vm-clone-nfsds.json', { version: 1, items: [{ id: 'nfsds-r', vcenterId: 'vc-a', name: 'ds-r', hosts: {} }] }, () => N.listNfsDs(), () => N.nfsDsLoadError(),
    (v) => assert.deepEqual(v.map((x) => x.id), ['nfsds-r']));
  const P = await import('../src/vmdns/policy.js');
  await recoverCase('vm-dns-policy.json', { corps: {}, publicUnapproved: false }, () => P.loadVmDnsPolicy(), () => P.loadVmDnsPolicy().loadError,
    (v) => { assert.equal(v.publicUnapproved, false); assert.ok(!String(v.rev).startsWith('err-'), '응답 캐시 키(rev)도 바뀐다'); });
  const S = await import('../src/storage/inspect/schedule.js');
  S._resetScheduleForTest();
  await recoverCase('storage-inspect.json', { enabled: false }, () => S.loadSettings(), () => S.settingsLoadError(),
    (v) => assert.equal(v.enabled, false, '되돌린 값(꺼짐) — 주간 점검 보류도 풀린다'));
  const B = await import('../src/bulletin/store.js');
  B._resetBulletinCache();
  await recoverCase('board.json', { posts: [{ id: 'p-restored', title: '되돌린 글', body: 'b', author: 'a', createdAt: clock3, updatedAt: clock3, comments: [] }] }, () => B.listPosts({}), () => B.bulletinLoadError('board'),
    (v) => assert.ok(JSON.stringify(v).includes('p-restored')));
  const D = await import('../src/datacenter/store.js');
  await recoverCase('datacenters.json', { datacenters: [{ id: 'dc-r', name: 'R' }], assign: {} }, () => D.listDatacenters(), () => D.datacentersLoadError(),
    (v) => assert.ok(v.some((d) => d.id === 'dc-r')), { byMtime: true });
  const FT = await import('../src/insights/fleetTags.js');
  await recoverCase('fleet-tags.json', { tags: { SVC1: 'exclude' } }, () => FT.loadFleetTags(), () => FT.fleetTagsLoadError(),
    (v) => assert.equal(v.SVC1, 'exclude'), { byMtime: true });
  const FA = await import('../src/insights/fleetAssign.js');
  await recoverCase('fleet-assign.json', { assign: { SVC1: 'vc-a' } }, () => FA.loadFleetAssign(), () => FA.fleetAssignLoadError(),
    (v) => assert.equal(v.SVC1, 'vc-a'), { byMtime: true });
});

test('후속 ③: 거절 · 확정 안내가 다시 판정 동작을 사실대로 말한다(재시작 불필요 · 간격)', async () => {
  J3._setJsonFileLoadClockForTest(() => clock3);
  try {
    const N = await import('../src/vmclone/nfsDs.js');
    fs.writeFileSync(F3('vm-clone-nfsds.json'), '[1');
    N._resetNfsDsForTest();
    N.listNfsDs();
    assert.throws(() => N.createNfsDs({ vcenterId: 'vc-a', name: 'x' }), (e) => e.code === 'settings-unreadable' && /30초 안에 다시 읽어 재시작 없이 풀립니다/.test(e.message));
    fs.writeFileSync(F3('vm-clone-nfsds.json'), JSON.stringify({ version: 1, items: [] }));
    const U = await import('../src/util/settingsLoadError.js');
    const c = U.confirmSettingsDefault('vm-clone-nfsds.json');
    assert.equal(c.code, 'file-present');
    assert.match(c.detail, /30초 안에 그 파일을 다시 읽습니다\(재시작 불필요\)/);
    tick3(); N.listNfsDs();
    assert.equal(N.nfsDsLoadError(), null);
  } finally { J3._setJsonFileLoadClockForTest(); }
});

/* ── 결정(후속이 남긴 것 — '권장안대로'): 서비스 점검 조회가 다시 판정한다 — 그 모듈이 불리지 않아도 되돌린 보존본의 줄이 지워진다 ─────── */
test('후속 ③\': 서비스 점검 조회가 오류가 선 로더를 다시 판정(30초 간격) — 모듈을 부르지 않아도 줄이 지워지고, 모듈은 다음 접근에 다시 읽어 되돌린 파일 위에 쓴다', async () => {
  const U = await import('../src/util/settingsLoadError.js');
  const { getServiceCheck } = await import('../src/health/services.js');
  const B = await import('../src/bulletin/store.js');
  const FT = await import('../src/insights/fleetTags.js');
  const FR = await import('../src/insights/fleetRev.js');
  const rows = () => U.listSettingsLoadErrors().map((e) => e.file);
  const row = () => getServiceCheck({ isAdmin: true }).checks.find((c) => c.key === 'settings-files');
  J3._setJsonFileLoadClockForTest(() => clock3);
  try {
    // ① 공용 로더 단위 — 등록부(서비스 점검)는 지우고, 모듈 쪽에는 그 모듈이 다시 load() 할 때까지 이전 오류(held)
    const UNIT = F3('decide-rest-unit.json');
    const L = J3.makeJsonFileLoader(() => UNIT, { label: '시험 설정', confirm: () => {}, tag: 'test' });
    fs.writeFileSync(UNIT, '{ broken');
    L.load();
    assert.ok(L.loadError() && rows().includes('decide-rest-unit.json'));
    fs.writeFileSync(UNIT, JSON.stringify({ a: 1 }));
    assert.equal(U.recheckSettingsFiles(), 0, '간격 안에서는 다시 판정하지 않는다(조회마다 디스크를 보지 않게)');
    assert.ok(rows().includes('decide-rest-unit.json'));
    tick3();
    assert.equal(U.recheckSettingsFiles(), 1);
    assert.ok(!rows().includes('decide-rest-unit.json'), '되돌린 파일의 줄이 그 모듈을 부르지 않아도 지워진다');
    assert.ok(L.loadError(), '모듈 쪽 오류는 그 모듈이 다시 읽을 때까지 유지(캐시는 모듈이 들고 있다)');
    assert.ok(L.refusal('시험'), '모듈이 다시 읽기 전 쓰기는 여전히 거절');
    assert.equal(L.recheckDue(), true, '모듈의 다음 접근은 곧바로 다시 읽는다');
    assert.equal(L.recheckDue(), true, '다시 읽을 때까지 계속 참');
    assert.equal(L.load().kind, 'ok');
    assert.equal(L.loadError(), null); assert.equal(L.refusal('시험'), null); assert.equal(L.recheckDue(), false);

    // ② 게시판(오류가 없으면 캐시를 믿는 모듈) — 서비스 점검 화면 조회로 줄이 지워진 뒤 글을 쓰면 되돌린 글 위에 붙는다(오류 중 캐시한 빈 목록으로 덮지 않음)
    B._resetBulletinCache();
    fs.writeFileSync(F3('board.json'), '{ broken');
    B.listPosts({});
    assert.ok(rows().includes('board.json'));
    const restored = { posts: [{ id: 'p-keep', title: '되돌린 글', body: 'b', author: 'a', createdAt: clock3, updatedAt: clock3, comments: [], likes: [] }] };
    fs.writeFileSync(F3('board.json'), JSON.stringify(restored));
    assert.equal(row().files?.some((e) => e.file === 'board.json'), true, '간격 안의 조회는 아직 그대로');
    tick3();
    const r1 = row();
    assert.ok(!(r1.files || []).some((e) => e.file === 'board.json'), `서비스 점검 조회 한 번으로 지워진다: ${r1.detail}`);
    B.createPost({ title: '새 글', body: 'n' }, 'u1');
    B.flushBulletinNow();
    const ids = JSON.parse(fs.readFileSync(F3('board.json'), 'utf8')).posts.map((x) => x.id);
    assert.ok(ids.includes('p-keep'), `되돌린 글이 덮였다: ${JSON.stringify(ids)}`);
    assert.equal(ids.length, 2);

    // ③ 회복 전이로 캐시를 버리는 모듈(fleet) — 서비스 점검이 먼저 회복을 봐도 모듈의 회복 전이(rev)는 그대로 일어난다
    fs.writeFileSync(F3('fleet-tags.json'), '{ broken');
    FT.loadFleetTags();
    assert.ok(rows().includes('fleet-tags.json'));
    fs.writeFileSync(F3('fleet-tags.json'), JSON.stringify({ tags: { SVC9: 'exclude' } }));
    tick3();
    U.recheckSettingsFiles();
    assert.ok(!rows().includes('fleet-tags.json'));
    const rev0 = FR.fleetRev();
    assert.equal(FT.loadFleetTags().SVC9, 'exclude');
    assert.ok(FR.fleetRev() > rev0, '모듈이 회복 전이를 놓치지 않는다(플릿 캐시를 버린다)');
  } finally { J3._setJsonFileLoadClockForTest(); }
});

/* ── 후속 ④: IPAM 예약 · 메모 읽기 오류의 회복을 스스로 알아챈다(원장 입력 지문 rev 가 오른다 — 다음 갱신이 ipam.db 를 다시 만든다) ─────── */
test('후속 ④: 예약 · 메모 파일 읽기 오류 — 아무도 부르지 않아도 30초 뒤 스스로 다시 판정해 회복하면 rev 를 올린다(오류가 없으면 타이머 없음)', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebutG23ipam-'));
  try {
    const code = `import fs from 'node:fs'; import path from 'node:path'; import { mock } from 'node:test';
      mock.timers.enable({ apis: ['setTimeout'] });
      const J = await import(${JSON.stringify(path.join(SRC, 'util/jsonFileLoad.js'))}); let c = 1e12; J._setJsonFileLoadClockForTest(() => c);
      const out = {};
      for (const [mod, file, get, rev, err] of [['ipam/overrides.js', 'ipam-overrides.json', 'getOverride', 'overridesRev', 'overridesLoadError'], ['ipam/annotations.js', 'ipam-annotations.json', 'getAnnotation', 'annotationsRev', 'annotationsLoadError']]) {
        const F = path.join(process.env.CONFIG_DIR, file);
        fs.mkdirSync(F);   // 파일 자리에 폴더 — 실제 읽기 오류(EISDIR)
        const M = await import(${JSON.stringify(SRC)} + '/' + mod);
        M[get]('10.0.0.9');
        const r1 = M[rev]();
        fs.rmSync(F, { recursive: true }); fs.writeFileSync(F, JSON.stringify({ '10.0.0.9': { owner: 'ops', memo: 'm', tags: [] } }));
        c += 31_000; mock.timers.tick(31_000);
        const r2 = M[rev]();   // 접근 없이 — 타이머가 다시 판정했으면 올랐다
        out[file] = { r1, r2, err: M[err]() };
      }
      console.log('@@' + JSON.stringify(out));`;
    const r = spawnSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', code], { env: { ...process.env, CONFIG_DIR: dir, DATA_DIR: dir }, encoding: 'utf8', timeout: 90_000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('@@')).slice(2));
    for (const [f, x] of Object.entries(out)) {
      assert.ok(x.r2 > x.r1, `${f}: 회복을 스스로 알아채 rev 가 올라야 한다(원장 동기화가 10분 전량 확인을 기다리지 않게) — ${JSON.stringify(x)}`);
      assert.equal(x.err, null, `${f}: 오류가 풀렸다`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ── 후속 ②: VM 사양 변경 — 결과 대기 시간 초과면 잠금을 풀지 않고 그 작업을 확인한다 ─────── */
test('후속 ②: 사양 변경 시간 초과 — 잠금은 그 vCenter 작업이 끝나거나 잠금 시한까지 유지 · 두 번째 요청은 409(앞 작업 진행 중일 수 있음) · 같은 세션으로 확인 뒤 로그아웃', async () => {
  const H = 3_600_000;
  const NOW = Math.floor(Date.now() / H) * H - 30 * 60_000;
  const RC = await import('../src/provision/reconfig.js');
  RC.reconfigLocksForTest().clear();
  // ① 잠금 붙잡기 — finally 의 해제는 무시되고, 확인 promise 가 끝나야 풀린다
  const u = RC.tryLockVmReconfig('vc:vm-9', { now: NOW });
  let finish; const p = new Promise((r) => { finish = r; });
  u.holdUntil(p);
  u();   // 라우트 finally
  assert.equal(RC.tryLockVmReconfig('vc:vm-9', { now: NOW + 1000 }), null, '확인 중에는 두 번째 요청을 받지 않는다');
  const busy = RC.reconfigBusyBody('vc:vm-9', { now: NOW + 1000 });
  assert.equal(busy.pendingTask, true);
  assert.match(busy.reason, /앞 사양 변경 작업이 vCenter 에서 아직 진행 중일 수 있습니다/);
  assert.equal(typeof RC.tryLockVmReconfig('vc:vm-9', { now: NOW + RC.RECONFIG_LOCK_TTL_MS }), 'function', '잠금 시한이 지나면 새 요청이 가져간다(보류에는 시한)');
  RC.reconfigLocksForTest().clear();
  const u2 = RC.tryLockVmReconfig('vc:vm-9', { now: NOW });
  let fin2; u2.holdUntil(new Promise((r) => { fin2 = r; })); u2();
  fin2({ ok: true }); await new Promise((r) => setImmediate(r));
  assert.equal(typeof RC.tryLockVmReconfig('vc:vm-9', { now: NOW + 2000 }), 'function', '확인이 끝나면 풀린다');
  finish({ ok: true });
  RC.reconfigLocksForTest().clear();
  assert.equal(RC.reconfigBusyBody('vc:vm-x').pendingTask, undefined, '확인 중이 아니면 예전 문구');
  // ② 같은 세션으로 이어 확인 — 새 로그인 없음 · 끝나면 로그아웃 · onTimeout 이 없으면 넘기지 않는다(부르는 쪽이 로그아웃)
  let polls = 0; let logouts = 0;
  const c = { retrieveObjectProps: async () => { polls += 1; return [{ props: { 'info.state': polls >= 2 ? 'success' : 'running' } }]; }, logout: async () => { logouts += 1; } };
  let handed = null;
  const q = RC.continueWaitOnTimeout(c, 'task-1', { onTimeout: (x) => { handed = x; }, extraWaitMs: 60_000, pollMs: 1 });
  assert.ok(q && handed === q);
  assert.deepEqual(await q, { ok: true });
  assert.equal(logouts, 1, '확인이 끝난 뒤 로그아웃');
  assert.equal(RC.continueWaitOnTimeout(c, 'task-1', { onTimeout: null, extraWaitMs: 60_000 }), null);
  assert.equal(RC.continueWaitOnTimeout(c, 'task-1', { onTimeout: () => {}, extraWaitMs: 0 }), null, '잠금 시한이 다 됐으면 넘기지 않는다');
  // ③ 라우트 — 시간 초과를 holdUntil 로 넘기고 남은 시한 안에서 확인한다 · reconfigVm 은 넘겼으면 로그아웃하지 않는다
  const { stripComments } = await import('./_stripComments.js');
  const { fileURLToPath } = await import('node:url');
  const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const route = stripComments(fs.readFileSync(path.join(SRC, 'routes/admin/collectorsDc.js'), 'utf8'));
  assert.match(route, /reconfigVm\(t\.vc, t\.moref, plan, \{ onTimeout: \(p\) => unlock\.holdUntil\(p\), extraWaitMs: unlock\.remainingMs\(\) \}\)/);
  assert.match(route, /if \(!unlock\) return res\.status\(409\)\.json\(reconfigBusyBody\(t\.vm\.id\)\)/);
  const rc = stripComments(fs.readFileSync(path.join(SRC, 'provision/reconfig.js'), 'utf8'));
  assert.match(rc, /handedOff = !!continueWaitOnTimeout\(c, task, \{ onTimeout, extraWaitMs \}\)/);
  assert.match(rc, /finally \{ if \(!handedOff\) await c\.logout\(\)/);
});

/* ── 후속 ①: 메일 계정 · 수신자 원문 가림 기준 통일(GET /admin/mail 과 같은 isFullReadWriteScope) ─────── */
test('후속 ①: 통신 점검 설정 링크의 SMTP 계정 · 스토리지 사용량 · 아이실론 종합 메일의 통합 관리자 주소 — 쓰기 범위만 제한된 관리자에게는 개수 · 있음 표지만', async () => {
  writeJson('mail.json', { enabled: true, smtp: { host: 'relay.corp.local', port: 25, from: 'portal@corp.local', user: 'svc-mail-acct' }, defaultTo: ['boss-a@corp.com', 'boss-b@corp.com'], kinds: {} });
  const MS = await import('../src/mail/settings.js');
  MS.invalidate();
  const api = () => { const r = express.Router(); return r; };
  const mountWith = (reg) => (app) => { const r = api(); reg(r); app.use('/api', r); };
  const { registerLinkCheck } = await import('../src/routes/api/linkCheck.js');
  const { registerStorageUsage } = await import('../src/routes/api/storageUsage.js');
  const { registerIsilonDirUsage } = await import('../src/routes/api/isilonDirUsage.js');
  const SUPER = { username: 'sa', role: 'admin', superAdmin: true, scope: null };
  const SUPER_W = { username: 'sw', role: 'admin', superAdmin: true, scope: { writeVcenters: ['vc-kr'] } };
  const cases = [
    [mountWith(registerLinkCheck), '/api/tools/link-check/targets', FULL, WRITE_SCOPED, 'svc-mail-acct', (b) => b.rows?.find?.((x) => x.kind === 'set:smtp') || (b.targets || []).find?.((x) => x.kind === 'set:smtp')],
    [mountWith(registerStorageUsage), '/api/tools/storage-usage/mail', FULL, WRITE_SCOPED, 'boss-a@corp.com', (b) => b],
    [mountWith(registerIsilonDirUsage), '/api/tools/isilon-dirusage/digest', SUPER, SUPER_W, 'boss-a@corp.com', (b) => b],
  ];
  for (const [mount, url, fullUser, wUser, secret, pick] of cases) {
    const f = await call(mount, fullUser, 'GET', url);
    assert.equal(f.status, 200, `${url} ${f.text.slice(0, 200)}`);
    assert.ok(f.text.includes(secret), `${url}: 전체 범위는 원문(예전 그대로)`);
    const w = await call(mount, wUser, 'GET', url);
    assert.equal(w.status, 200, `${url} ${w.text.slice(0, 200)}`);
    assert.ok(!w.text.includes(secret), `${url}: 쓰기 범위만 제한된 관리자에게 원문이 없어야 한다`);
    const o = pick(w.body);
    if (url.includes('link-check')) { assert.equal(o.facts.hasUser, true); assert.equal(o.facts.userMasked, true); assert.equal(o.facts.user, ''); }
    else { assert.equal(o.adminToMasked, true); assert.equal(o.adminToCount, 2); assert.deepEqual(o.adminTo, []); }
  }
});

/* ── 후속 ⑤: 통신 점검 보고 1건 — 등록부는 한 번만 읽는다(읽기 · 판정 · 배정이 같은 값) ─────── */
test('후속 ⑤: putEdgeLinkReport — 수집 서버 등록부(collectors.json)를 보고 1건에 한 번만 읽는다 · 손상이면 여전히 503 보류', async () => {
  writeJson('collectors.json', { collectors: [{ id: 'edge-kr', name: 'edge-kr', url: 'https://10.0.0.1:8443' }] });
  const L = await import('../src/central/linkCheckEdge.js');
  const count = async (fn) => {
    const orig = fs.readFileSync; let n = 0;
    fs.readFileSync = (f, ...a) => { if (path.basename(String(f)) === 'collectors.json') n += 1; return orig.call(fs, f, ...a); };
    try { return { out: await fn(), n }; } finally { fs.readFileSync = orig; }
  };
  const ok = await count(() => L.putEdgeLinkReport('edge-kr', { results: [] }));
  assert.notEqual(ok.out.registryUnreadable, true);
  assert.equal(ok.n, 1, `보고 1건의 등록부 읽기 수 — 예전 3번(배정 · 배정 안 판정 · 호출부 판정): ${ok.n}`);
  const single = await count(() => L.assignedEdgeLinkIds('edge-kr'));
  assert.ok(single.out instanceof Set); assert.equal(single.n, 1, '배정만 물어도 한 번(예전 2번)');
  fs.writeFileSync(F3('collectors.json'), '{"collectors":[');
  const bad = await count(() => L.putEdgeLinkReport('edge-kr', { results: [] }));
  assert.equal(bad.out.registryUnreadable, true, '손상이면 그대로 503 보류(65 ①)');
  assert.equal(bad.n, 1);
  writeJson('collectors.json', { collectors: [] });
});

/* ── 후속 ⑥: provision-runs.json 기동 때 읽기 오류 — 덮지 않고 30초 간격 재읽기 · 회복하면 합쳐 저장 재개 · 그동안 표지 ─────── */
test('후속 ⑥: 작업 기록 파일 읽기 오류 — 원본을 덮지 않고(손상 아님) 30초 뒤 다시 읽어 그동안의 새 작업과 합친다 · 그동안 storeError 표지', async () => {
  const H = 3_600_000;
  const NOW = Math.floor(Date.now() / H) * H - 30 * 60_000;
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebutG23runs-'));
  try {
    const good = JSON.stringify({ jobs: [{ id: 'old-1', createdAt: new Date(NOW).toISOString(), createdBy: 'admin', vcenterId: 'vc-a', sourceName: 'tmpl', live: true, status: 'completed', placement: {}, vms: [{ name: 'a', status: 'done', task: 't1' }] }] });
    const code = `import fs from 'node:fs'; import path from 'node:path'; import { mock } from 'node:test';
      mock.timers.enable({ apis: ['setTimeout'] });
      const F = path.join(process.env.CONFIG_DIR, 'provision-runs.json');
      const realRead = fs.readFileSync; let eio = true;
      fs.readFileSync = (f, ...a) => { if (eio && path.basename(String(f)) === 'provision-runs.json') { const e = new Error('EIO: i/o error, read'); e.code = 'EIO'; throw e; } return realRead.call(fs, f, ...a); };
      const J = await import(${JSON.stringify(path.join(SRC, 'util/jsonFileLoad.js'))}); let c = 1e12; J._setJsonFileLoadClockForTest(() => c);
      const P = await import(${JSON.stringify(path.join(SRC, 'provision/jobs.js'))});
      const out = {};
      out.err1 = P.jobsStoreError();
      // 보류 중 변경(멈춘 추적 정리 → 저장 요청) — 디바운스(3초)를 넘기고 비동기 쓰기가 끝날 만큼 돌려도 원본을 덮지 않아야 한다
      P.sweepStale({ id: 'x', status: 'running', vms: [{ status: 'submitted', submittedAt: 0 }] });
      mock.timers.tick(3_100);
      for (let i = 0; i < 3000; i += 1) await new Promise((r) => setImmediate(r));
      out.flush1 = realRead.call(fs, F, 'utf8');   // 원본 그대로
      eio = false;   // 디스크가 풀렸다
      c += 31_000; mock.timers.tick(31_000);   // 접근 없이 스스로 다시 읽는다
      out.ids = P.listJobs({ username: 'admin', role: 'admin' }).map((j) => j.id);   // 목록 조회는 다시 읽지 않는다 — 타이머가 읽었어야 보인다
      out.err2 = P.jobsStoreError();
      console.log('@@' + JSON.stringify(out));`;
    fs.writeFileSync(path.join(dir, 'provision-runs.json'), good);
    const r = spawnSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', code], { env: { ...process.env, CONFIG_DIR: dir, DATA_DIR: dir, DATA_SOURCE: 'mock' }, encoding: 'utf8', timeout: 90_000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('@@')).slice(2));
    assert.equal(out.err1?.readError, true, '읽기 오류 동안 표지');
    assert.match(out.err1.reason, /원본은 그대로 두고 새 작업은 메모리에만/);
    assert.equal(out.flush1, good, '원본을 덮지 않았다');
    assert.equal(out.err2, null, '30초 뒤 스스로 다시 읽어 풀렸다');
    assert.deepEqual(out.ids, ['old-1'], '파일의 작업이 돌아왔다');
    assert.deepEqual(fs.readdirSync(dir).filter((x) => x.includes('.corrupt.')), [], '읽기 오류는 보존본으로 옮기지 않는다');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
