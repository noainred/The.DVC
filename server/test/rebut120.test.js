/**
 * rebut120.test.js — 전체 점검 120회차: 110회차(보안 심화) · 114회차(백업 복원 대상 전수 + 공개 API) 수정의 적대적 재검토(반증).
 *
 * 재현해서 확정한 것만 고쳤다:
 *  R1 `routes/publicApi.js GET /api/v1/` — 114 F7 은 자기점검의 allowed 를 endpointAllowed 하나로 맞췄지만 게이트에는 403 이 하나 더 있다(scope-empty —
 *     범위 vCenter 가 전부 등록돼 있지 않은 키). 그 키의 자기점검은 여전히 allowed:true 였다(실제 호출 5개 전부 403).
 *  R2 `backup/stagedRestore.js` bareos-rehearsal.json — 114 가 '남긴 것(OPEN)' 으로 둔 것. 정책 저장은 본인 OTP 인데 복원이 꺼 둔 복원 검증을 다시 켰다
 *     (실제 로더: 지금 끔 · 백업 켬 → 켬 · 법인마다 10대). 복원으로는 켜지 않고 대수를 늘리지 않는다.
 *  R3 같은 파일 peer-trust.json — 새 설치는 기동 직후 enforce(origin new-install · 항목 0) 파일을 스스로 만든다. 관찰 정책 현장의 백업을 새 서버에 복원하면
 *     (재해 복구) 정책이 enforce 로 남아 관찰만 된 지문의 장비가 전부 'not-approved' 로 거부되는데, 경고는 '정책을 유지했습니다' 뿐이었다 → 결과(대수)와 조치를 말한다.
 *     (정책 자체를 백업 값으로 되돌릴지는 결정 사항 — 고치지 않았다.)
 *  R4 같은 파일 credentials.json 경고 — 빠져나갈 길(지금 파일을 치우고 다시 복원)을 '새 서버로 옮기는 중' 에만 적어, 실수로 지운 계정을 되살리려는 경우가 빠져 있었다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const ROOT = path.resolve(SRC, '..');
const SR = await import('../src/backup/stagedRestore.js');

const TMP = [];
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rb120-')); fs.mkdirSync(path.join(d, 'backups'), { recursive: true }); TMP.push(d); return d; };
const rmTmp = () => { for (const d of TMP) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmp(); process.once('exit', () => { try { rmTmp(); } catch { /* 종료 중 */ } }); });
const w = (dir, name, v) => fs.writeFileSync(path.join(dir, name), typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const r = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const J = (v) => JSON.stringify(v);
function restore(dir, files) {
  SR._resetStagedRestoreState();
  SR.stageRestore(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? v : J(v)])), { configDir: dir, source: 'rb120' });
  const log = console.log; const warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return SR.applyStagedRestore({ configDir: dir }); } finally { console.log = log; console.warn = warn; }
}
/** 실제 모듈을 새 프로세스(= 복원 뒤 다음 기동)에서 돌린다 — 'OUT <json>' 한 줄. */
function child(dir, code, env = {}) {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, CONFIG_DIR: dir, AUTH_ENABLED: 'false', DATA_SOURCE: 'mock', NODE_ENV: 'test', ...env }, encoding: 'utf8', cwd: ROOT, timeout: 180_000,
  });
  const line = (res.stdout || '').split('\n').filter((l) => l.startsWith('OUT ')).pop();
  assert.ok(line, `자식 프로세스 출력 없음: ${(res.stderr || res.stdout || '').slice(-1200)}`);
  return JSON.parse(line.slice(4));
}
const imp = (rel) => JSON.stringify(path.join(SRC, rel));

/* ══ R1 공개 API 자기점검 ═══════════════════════════════════════════════════════════════════ */

test('R1 공개 API GET /api/v1/ — 범위 vCenter 가 전부 없는 키(scope-empty)도 allowed 가 실제 호출 결과와 같다', () => {
  const dir = mk();
  const out = child(dir, `
    const express = (await import('express')).default;
    const { store } = await import(${imp('store.js')});
    const v1 = (await import(${imp('routes/publicApi.js')})).default;
    const keys = await import(${imp('publicapi/keys.js')});
    await store.refresh({ force: true });
    const app = express(); app.use('/api/v1', v1);
    const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port + '/api/v1';
    const call = async (p, key) => { const res = await fetch(base + p, { headers: { 'X-Api-Key': key } }); let body = null; try { body = await res.json(); } catch { body = null; } return { status: res.status, code: body?.code || null, body }; };
    const vc = String(store.get().vcenters[0].id);
    const all = ['inventory', 'capacity', 'faults'];
    const ghost = keys.issueApiKey({ name: 'ghost', groups: all, vcenters: ['vc-does-not-exist'] }).plaintext;      // 범위가 전부 없음
    const half = keys.issueApiKey({ name: 'half', groups: all, vcenters: [vc, 'vc-nope'] }).plaintext;               // 일부만 없음 — 거절하지 않는다
    const out = {};
    for (const [k, key] of [['ghost', ghost], ['half', half]]) {
      const cat = await call('/', key);
      const rows = [];
      for (const e of cat.body.data.endpoints) { const live = await call(e.path, key); rows.push({ path: e.path, allowed: e.allowed, deniedBy: e.deniedBy || null, status: live.status, code: live.code }); }
      out[k] = { rows, note: cat.body.meta.note };
    }
    srv.close();
    console.log('OUT ' + JSON.stringify(out));
    process.exit(0);
  `);
  for (const x of [...out.ghost.rows, ...out.half.rows]) {
    if (x.allowed) { assert.notEqual(x.status, 403, `${x.path} — allowed:true 인데 실제 호출은 403(${x.code})`); assert.equal(x.deniedBy, null); }
    else { assert.equal(x.status, 403, `${x.path} — allowed:false 인데 ${x.status}`); assert.equal(x.code, x.deniedBy, `${x.path} — deniedBy(${x.deniedBy})가 실제 거절 코드(${x.code})와 다릅니다`); }
  }
  // 범위가 전부 없는 키: 되는 경로가 없다 — 게이트 순서 그대로(분류 없음 · 전체 범위 전용이 먼저, 그 밖은 scope-empty)
  assert.equal(out.ghost.rows.filter((x) => x.allowed).length, 0);
  assert.ok(out.ghost.rows.filter((x) => x.deniedBy === 'scope-empty').length >= 4, '범위 안 경로는 scope-empty 로 거절');
  assert.deepEqual(out.ghost.rows.filter((x) => x.deniedBy === 'needs-full-scope').map((x) => x.path).sort(), ['/capacity/storage', '/capacity/storage-growth', '/faults/parts']);
  assert.match(out.ghost.note, /scope-empty/);
  // 일부만 없는 키는 그대로 된다(거절하지 않는다)
  assert.ok(out.half.rows.filter((x) => x.allowed).length >= 4);
  assert.equal(out.half.rows.filter((x) => x.deniedBy === 'scope-empty').length, 0);
});

/* ══ R2 Bareos 복원 검증 정책 ═══════════════════════════════════════════════════════════════ */

const POL = (o = {}) => ({ enabled: true, weekday: 3, time: '02:00', perCorp: 3, deleteOnOk: true, datastores: {}, savedBy: 'owner', savedAt: 5, ...o });

test('R2 복원 검증 정책 — 규칙(순수): 켜지 않는다 · 대수를 늘리지 않는다 · 끄기 · 줄이기 · 그 밖은 백업 그대로', () => {
  const f = (b, c) => { const x = SR.reconcileRehearsalText(J(b), c == null ? c : J(c)); return { ...x, obj: JSON.parse(x.text) }; };
  // 지금 끔 · 백업 켬 → 끈 채(정의는 백업 것)
  let x = f(POL({ perCorp: 10, time: '04:30' }), POL({ enabled: false }));
  assert.equal(x.heldOff, true); assert.equal(x.obj.enabled, false); assert.equal(x.obj.perCorp, 10); assert.equal(x.obj.time, '04:30');
  // 지금 파일에 enabled 칸이 없으면(손으로 고친 파일) 로더는 끔으로 읽는다 — 끈 채
  x = f(POL(), { weekday: 1 });
  assert.equal(x.heldOff, true); assert.equal(x.obj.enabled, false);
  // 둘 다 켬: 대수는 늘리지 않는다 · 줄이는 것은 그대로
  x = f(POL({ perCorp: 10 }), POL({ perCorp: 3 }));
  assert.equal(x.heldPerCorp, true); assert.equal(x.obj.perCorp, 3); assert.equal(x.obj.enabled, true);
  x = f(POL({ perCorp: 2 }), POL({ perCorp: 3 }));
  assert.equal(x.heldPerCorp, false); assert.equal(x.text, J(POL({ perCorp: 2 })), '줄이는 복원은 글자 그대로');
  // 같은 값 · 끄는 복원은 글자 그대로
  assert.equal(f(POL(), POL()).text, J(POL()));
  assert.equal(f(POL({ enabled: false }), POL()).text, J(POL({ enabled: false })));
  // 지금 파일이 없거나(재해 복구) 객체로 읽히지 않으면 백업 그대로 — 켬도 그대로
  assert.equal(SR.reconcileRehearsalText(J(POL({ perCorp: 10 })), null).text, J(POL({ perCorp: 10 })));
  assert.equal(SR.reconcileRehearsalText(J(POL()), '{깨짐').text, J(POL()));
  assert.equal(SR.reconcileRehearsalText(J(POL()), '[]').text, J(POL()));
  // 백업이 객체가 아니면 손대지 않는다(로더의 손상 보존이 맡는다)
  assert.equal(SR.reconcileRehearsalText('{깨짐', J(POL({ enabled: false }))).text, '{깨짐');
});

test('R2 복원 검증 정책 — 실제 적용 + 실제 로더(bareos/rehearsal.js): 꺼 둔 검증이 복원으로 켜지지 않는다 · 재해 복구는 백업 그대로', () => {
  const load = (dir) => child(dir, `const R = await import(${imp('bareos/rehearsal.js')}); const p = R.loadPolicy(); console.log('OUT ' + JSON.stringify({ enabled: p.enabled, perCorp: p.perCorp, time: p.time }));`);
  // 같은 서버: 지금 끔(본인 OTP 로 저장) · 백업 켬
  const dir = mk();
  w(dir, 'bareos-rehearsal.json', POL({ enabled: false }));
  const res = restore(dir, { 'bareos-rehearsal.json': POL({ perCorp: 10, time: '04:30', savedBy: 'old', savedAt: 1 }) });
  assert.deepEqual(res.applied, ['bareos-rehearsal.json']);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0].reason, /꺼진 채로 복원했습니다.*본인 OTP/);
  assert.doesNotMatch(res.warnings[0].reason, /`/, '화면 문구에 백틱 금지');
  const got = load(dir);
  assert.equal(got.enabled, false, '복원 뒤 로더가 켬으로 읽습니다(OTP 없이 켜짐)');
  assert.equal(got.time, '04:30', '정의는 백업 것');
  // 대수: 지금 3 · 백업 10 → 3
  const d2 = mk();
  w(d2, 'bareos-rehearsal.json', POL({ perCorp: 3 }));
  const res2 = restore(d2, { 'bareos-rehearsal.json': POL({ perCorp: 10 }) });
  assert.match(res2.warnings[0].reason, /대수.*지금 값/);
  assert.deepEqual([load(d2).enabled, load(d2).perCorp], [true, 3]);
  // 재해 복구(지금 파일 없음): 백업 그대로 켜진다 · 경고 없음
  const d3 = mk();
  const res3 = restore(d3, { 'bareos-rehearsal.json': POL({ perCorp: 10 }) });
  assert.deepEqual(res3.warnings, []);
  assert.equal(fs.readFileSync(path.join(d3, 'bareos-rehearsal.json'), 'utf8'), J(POL({ perCorp: 10 })));
  assert.deepEqual([load(d3).enabled, load(d3).perCorp], [true, 10]);
  // 지금 파일 읽기 오류: 이 파일만 적용하지 않는다(지금 값을 모른 채 켜지 않는다)
  const d4 = mk();
  fs.mkdirSync(path.join(d4, 'bareos-rehearsal.json'));
  assert.throws(() => SR.reconcileForApply('bareos-rehearsal.json', J(POL()), d4), /읽지 못해/);
});

/* ══ R3 장비 신뢰 — 새 설치 위 재해 복구 ════════════════════════════════════════════════════ */

test('R3 장비 신뢰 — 새 설치가 스스로 만든 enforce 파일 위에 관찰 현장의 백업을 복원하면 경고가 결과(거부되는 장비 수)와 조치를 말한다', () => {
  const dir = mk();
  // 새 설치의 첫 기동(실제 로더)이 만드는 파일 — 정책 enforce · origin new-install · 항목 0
  child(dir, `const P = await import(${imp('security/peerTrust.js')}); P.initPeerTrust(); P.flushPeerTrust(); console.log('OUT {}');`);
  const fresh = r(dir, 'peer-trust.json');
  assert.deepEqual([fresh.policy, fresh.origin.ssh.origin, fresh.entries], [{ ssh: 'enforce', tls: 'enforce' }, 'new-install', []], '새 설치 기본 파일의 모양이 바뀌었습니다 — 이 시험의 전제를 다시 보세요');
  const fpA = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; const fpB = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const backup = { v: 1, policy: { ssh: 'observe', tls: 'observe' }, origin: { ssh: { origin: 'upgrade-migration', at: 1 }, tls: { origin: 'upgrade-migration', at: 1 } },
    entries: [
      { kind: 'ssh', host: '10.0.0.5', port: 22, trusted: { fp: fpA, state: 'observed', at: 1 } },                                   // 관찰만 — 거부된다
      { kind: 'ssh', host: '10.0.0.6', port: 22, trusted: { fp: fpB, state: 'approved', at: 1 } },                                   // 승인 — 통과
      { kind: 'ssh', host: '10.0.0.7', port: 22, trusted: { fp: fpB, state: 'approved', at: 1 }, trustedMore: [{ fp: fpA, state: 'observed', at: 2 }] },   // 승인 지문이 있다 — 세지 않는다
      { kind: 'ssh', host: '10.0.0.8', port: 22, trusted: null, pending: { fp: fpA, at: 3 } },                                       // 신뢰 지문 없음 — 세지 않는다
    ] };
  const res = restore(dir, { 'peer-trust.json': backup });
  assert.equal(res.warnings.length, 1);
  const why = res.warnings[0].reason;
  assert.match(why, /정책은 지금 값/);
  assert.match(why, /장비 1대는 승인 전까지 접속이 거부됩니다/, '관찰만 된 지문뿐인 장비 수(1)를 말해야 합니다');
  assert.match(why, /‘관찰 지문 일괄 승인’/);
  assert.doesNotMatch(why, /`/);
  // 실제 로더: 정책은 enforce 그대로(91회차 규칙 — 바꾸지 않았다) · 관찰만 된 지문은 거부 · 승인 지문은 통과
  const after = child(dir, `const P = await import(${imp('security/peerTrust.js')});
    console.log('OUT ' + JSON.stringify({ mode: P.getPeerPolicy('ssh').mode, a: P.checkPeer('ssh', '10.0.0.5', 22, ${J(fpA)}).reason, b: P.checkPeer('ssh', '10.0.0.6', 22, ${J(fpB)}).reason }));`);
  assert.deepEqual(after, { mode: 'enforce', a: 'not-approved', b: 'approved' });
  // 정책을 바꾸지 않은 복원(지금도 observe)에는 그 문구가 없다
  const pure = SR.reconcilePeerTrustText(J(backup), J({ ...fresh, policy: { ssh: 'observe', tls: 'observe' } }));
  assert.deepEqual([pure.keptPolicy, pure.observedOnly], [[], 0]);
  // tls 만 지킨 복원은 ssh 항목을 세지 않는다
  const tlsOnly = SR.reconcilePeerTrustText(J(backup), J({ ...fresh, policy: { ssh: 'observe', tls: 'enforce' } }));
  assert.deepEqual([tlsOnly.keptPolicy, tlsOnly.observedOnly], [['tls'], 0]);
});

/* ══ R4 통합 계정 경고 — 빠져나갈 길 ═════════════════════════════════════════════════════════ */

test('R4 통합 계정 — 되살리지 않은 계정의 경고가 실수로 지운 경우의 길과 그때 잃는 것을 말한다', () => {
  const dir = mk();
  w(dir, 'credentials.json', { version: 1, items: [{ id: 'c1', name: 'a', hosts: ['*'], agents: ['*'] }] });
  const rc = SR.reconcileForApply('credentials.json', J({ version: 1, items: [{ id: 'c1', name: 'a', hosts: ['*'], agents: ['*'] }, { id: 'gone', name: 'b', hosts: ['*'], agents: ['*'] }] }), dir);
  assert.equal(rc.info.credentialsDropped, 1);
  assert.match(rc.warning.reason, /실수로 지운 계정을 되살려야 하거나/);
  assert.match(rc.warning.reason, /credentials\.json 을 치운 뒤 다시 복원/);
  assert.match(rc.warning.reason, /백업 뒤에 등록 · 고친 계정은 백업 판본으로 바뀝니다/);
  assert.doesNotMatch(rc.warning.reason, /`/);
  // 그 길이 실제로 통한다 — 지금 파일이 없으면 지운 계정까지 백업 그대로
  fs.rmSync(path.join(dir, 'credentials.json'));
  const again = SR.reconcileForApply('credentials.json', J({ version: 1, items: [{ id: 'gone', name: 'b', hosts: ['*'], agents: ['*'] }] }), dir);
  assert.equal(JSON.parse(again.content).items.length, 1);
  assert.equal(again.warning, undefined);
});
