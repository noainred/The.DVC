/**
 * v2.782 점검 K2(축 H — 게스트 파티션 사용률) 회귀.
 *  H-B2: '새로 넘은 것만'(통합 newOnly)·onlyOnChange(vCenter) 로 건너뛸 때도 회복된 키를 기억에서 뺀다 — 초과 → 회복 → 재초과가 다시 메일된다.
 *        이번에 보고되지 않은 VM·값 모름 파티션의 키는 남긴다(회복이 아니다). onlyOnChange 를 끈 'none-over' 재설정은 그대로.
 *  H-B3: 범위 계정 응답의 settings.vcThresholds 에 범위 밖 vCenter id 를 싣지 않는다(실제 api 라우터 3곳).
 *  H-I1: 95% 즉시 알림은 판정 단위 'vm' 설정에서도 파티션 단위로 판정한다.
 * 메일 발송(mail/service.js)·인벤토리(store.js)만 가짜로 바꾸고 실제 DB(commitCollection)·overview·notify 를 돈다(자식 프로세스 — mock.module).
 * 기준 시각은 실제 시각을 정시로 떨어뜨린 값(docs/rules/common.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2782b-'));
process.env.CONFIG_DIR = DIR;   // 이 프로세스에서 읽는 settings.js 도 임시 폴더로(저장소 설정을 건드리지 않게)
const SRC = new URL('../src/', import.meta.url).pathname;
const u = (p) => JSON.stringify(path.join(SRC, p));
const H = 3_600_000;
const BASE = Math.floor(Date.now() / H) * H - 10 * H;

/** 자식: 가짜 메일·인벤토리로 body 를 돈다. body 는 db·S·N·rep·commit·sent·stateKeys 를 쓸 수 있다. */
function runChild(name, vms, body) {
  const cfg = fs.mkdtempSync(path.join(DIR, `${name}-`));
  const script = `
    import { mock } from 'node:test';
    import fs from 'node:fs';
    const sent = [];
    mock.module(${u('mail/service.js')}, { namedExports: { sendPortalMail: async (o) => { sent.push({ subject: o.subject, text: o.text }); return { ok: true, accepted: o.to }; } } });
    mock.module(${u('store.js')}, { namedExports: { store: { get: () => ({ source: 'vcenter', vcenters: [{ id: 'vc1', name: 'VC1' }], vms: ${JSON.stringify(vms)} }) } } });
    console.warn = () => {}; console.log = () => {};
    const db = await import(${u('guestdisk/db.js')});
    const S = await import(${u('guestpart/settings.js')});
    const N = await import(${u('guestpart/notify.js')});
    const rep = await import(${u('guestpart/report.js')});
    let ts = ${BASE};
    const commit = async (list) => { ts += ${H}; const r = await db.commitCollection('vc1', 'VC1', list, { ts }); rep._resetPartsCache(); return r; };
    const stateFile = ${JSON.stringify(path.join(cfg, 'guestpart-mail-state.json'))};
    const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const out = {};
    ${body}
    process.stdout.write('\\n@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--experimental-sqlite', '--no-warnings', '--input-type=module', '-e', script],
    { env: { ...process.env, CONFIG_DIR: cfg, GUESTDISK_DB_PATH: path.join(cfg, 'guest-disk.db'), NODE_NO_WARNINGS: '1' }, encoding: 'utf8', timeout: 90_000 });
  const i = String(r.stdout).lastIndexOf('@@');
  assert.ok(i >= 0, `자식 실패: ${r.stderr}\n${r.stdout}`);
  return JSON.parse(r.stdout.slice(i + 2));
}

const INV = [1, 2, 3].map((n) => ({ id: `vc1:vm-${n}`, vcenterId: 'vc1', name: `app0${n}`, powerState: 'POWERED_ON' }));
const one = (n, path_, cap, used) => ({ vmId: `vc1:vm-${n}`, vmName: `app0${n}`, allocGB: cap, usedGB: used, partCount: 1, parts: [{ path: path_, capGB: cap, usedGB: used }] });
const unknownD = (n) => ({ vmId: `vc1:vm-${n}`, vmName: `app0${n}`, allocGB: 0, usedGB: 0, partCount: 1, parts: [], partsUnknown: 1, unknownPaths: ['D:\\'] });
const K = (n, p) => `vc1:vm-${n}\u0000${p}`;

// 세 단계: ① vm-1 C: 90%·vm-2 C: 85%·vm-3 D: 88% 모두 초과(메일) ② vm-1 은 50% 로 회복, vm-2 는 이번 수집에 없음(보고 안 됨), vm-3 D: 는 여유 미보고(값 모름)
//         ③ vm-1 92% 재초과, vm-2·vm-3 은 그대로 초과(이미 알린 것).
const STEPS = `
  const s1 = [${JSON.stringify(one(1, 'C:\\', 100, 90))}, ${JSON.stringify(one(2, 'C:\\', 100, 85))}, ${JSON.stringify(one(3, 'D:\\', 100, 88))}];
  const s2 = [${JSON.stringify(one(1, 'C:\\', 100, 50))}, ${JSON.stringify(unknownD(3))}];
  const s3 = [${JSON.stringify(one(1, 'C:\\', 100, 92))}, ${JSON.stringify(one(2, 'C:\\', 100, 85))}, ${JSON.stringify(one(3, 'D:\\', 100, 88))}];
`;

test('H-B2 vCenter 메일 onlyOnChange — 초과 → 회복(건너뜀) → 재초과가 다시 메일된다 · 보고 안 된 VM·값 모름 파티션의 키는 남긴다', () => {
  const o = runChild('vc', INV, `${STEPS}
    S.save({ threshold: 80, mail: { commonTo: ['ops@example.com'], vcenters: { vc1: { to: ['a@example.com'], onlyOnChange: true, when: 'scan' } } } });
    out.steps = [];
    for (const list of [s1, s2, s3]) {
      await commit(list);
      const r = await N.sendVcenter('vc1', { trigger: 'scan' });
      out.steps.push({ state: r.state, code: r.code || null, sent: sent.length, keys: readState().vc.vc1.lastKeys.slice().sort() });
    }`);
  const [a, b, c] = o.steps;
  assert.equal(a.state, 'sent');
  assert.deepEqual(a.keys, [K(1, 'C:\\'), K(2, 'C:\\'), K(3, 'D:\\')].sort());
  assert.equal(b.state, 'skipped'); assert.equal(b.code, 'unchanged');
  assert.deepEqual(b.keys, [K(2, 'C:\\'), K(3, 'D:\\')].sort(), '회복한 vm-1 C: 만 뺀다 — 보고 안 된 vm-2·값 모름 vm-3 D: 는 남긴다');
  assert.equal(c.state, 'sent', `수정 전: 재초과가 '새로 넘음' 이 아니어서 건너뛰었다 — ${JSON.stringify(c)}`);
  assert.equal(c.sent, 2);
  assert.deepEqual(c.keys, [K(1, 'C:\\'), K(2, 'C:\\'), K(3, 'D:\\')].sort());
});

test('H-B2 통합 메일 newOnly — 같은 3단계에서 재초과는 메일되고, 그 메일의 새로 넘은 것은 vm-1 하나다', () => {
  const o = runChild('dg', INV, `${STEPS}
    S.save({ threshold: 80, mail: { digest: { enabled: true, days: [0,1,2,3,4,5,6], time: '09:00', includeAdmin: false, to: ['d@example.com'], newOnly: true, skipIfNoNew: true } } });
    out.steps = [];
    for (const list of [s1, s2, s3]) {
      await commit(list);
      const r = await N.sendDigest({ slot: ts });
      out.steps.push({ state: r.state, code: r.code || null, sent: sent.length, count: r.count ?? null, keys: readState().digest.lastKeys.slice().sort() });
    }`);
  const [a, b, c] = o.steps;
  assert.equal(a.state, 'sent'); assert.equal(a.count, 3);
  assert.equal(b.state, 'skipped'); assert.equal(b.code, 'unchanged');
  assert.deepEqual(b.keys, [K(2, 'C:\\'), K(3, 'D:\\')].sort());
  assert.equal(c.state, 'sent', `수정 전: 재초과가 건너뛰어졌다 — ${JSON.stringify(c)}`);
  assert.equal(c.count, 1, 'newOnly 본문은 새로 넘은 것만 — 이미 알린 vm-2·vm-3 은 다시 싣지 않는다');
});

test('기존 재설정 유지 — onlyOnChange 를 끈 vCenter 메일은 초과 0 이면 none-over 로 lastKeys 를 비우고, 재초과는 메일된다', () => {
  const o = runChild('reset', INV, `
    S.save({ threshold: 80, mail: { commonTo: ['ops@example.com'], vcenters: { vc1: { to: ['a@example.com'], when: 'scan' } } } });
    out.steps = [];
    for (const used of [90, 50, 92]) {
      await commit([${JSON.stringify(one(1, 'C:\\', 100, 90))}].map((v) => ({ ...v, usedGB: used, parts: [{ ...v.parts[0], usedGB: used }] })));
      const r = await N.sendVcenter('vc1', { trigger: 'scan' });
      out.steps.push({ state: r.state, code: r.code || null, sent: sent.length, keys: readState().vc.vc1.lastKeys });
    }`);
  assert.deepEqual(o.steps.map((x) => [x.state, x.code]), [['sent', null], ['skipped', 'none-over'], ['sent', null]]);
  assert.deepEqual(o.steps[1].keys, []);
  assert.equal(o.steps[2].sent, 2);
});

test("H-I1 95% 즉시 알림 — 판정 단위가 'vm' 이어도 파티션 단위로 판정한다(C: 99/100 + D: 100/400 → VM 합계 39.9% 여도 알림)", () => {
  const vm = { vmId: 'vc1:vm-1', vmName: 'app01', allocGB: 500, usedGB: 199, partCount: 2, parts: [{ path: 'C:\\', capGB: 100, usedGB: 99 }, { path: 'D:\\', capGB: 400, usedGB: 100 }] };
  const o = runChild('crit', INV.slice(0, 1), `
    S.save({ threshold: 80, mode: 'vm', mail: { digest: { critNow: true, includeAdmin: false, to: ['d@example.com'] } } });
    await commit([${JSON.stringify(vm)}]);
    const r = await N.sendCritFor('vc1');
    out.r = { state: r.state, count: r.count ?? null };
    out.sent = sent.length;
    out.crit = Object.keys(readState().crit);
    out.text = sent[0]?.text || '';`);
  assert.equal(o.r.state, 'sent', `수정 전: VM 합계(39.9%)로 판정해 알림이 없었다 — ${JSON.stringify(o.r)}`);
  assert.equal(o.r.count, 1);
  assert.deepEqual(o.crit, [K(1, 'C:\\')], '키는 파티션(vmId\\0경로)');
  assert.match(o.text, /C:/);
});

test('H-B3 publicSettings(s, allowed) — 범위가 있으면 vCenter 별 임계를 범위 안 id 만 · 전체 범위(null)는 그대로', async () => {
  const s = { threshold: 80, mode: 'part', rules: {}, vcThresholds: { 'vc-kr': 85, 'vc-pl': 90, 'vc-us': 70 }, mail: { from: 'x@example.com' } };
  const { publicSettings } = await import('../src/guestpart/settings.js');
  assert.deepEqual(publicSettings(s, new Set(['vc-kr'])).vcThresholds, { 'vc-kr': 85 });
  assert.deepEqual(publicSettings(s, new Set()).vcThresholds, {});
  assert.deepEqual(publicSettings(s, null).vcThresholds, s.vcThresholds);
  assert.deepEqual(publicSettings(s).vcThresholds, s.vcThresholds);
  assert.equal(publicSettings(s, new Set(['vc-kr'])).mail, undefined);
});

test('H-B3 실제 api 라우터 — 범위 계정의 /tools/guest-partition·vcenter/:id·settings 응답에 범위 밖 vCenter id 가 없다(전체 범위는 전부)', () => {
  const dir = fs.mkdtempSync(path.join(DIR, 'route-'));
  const script = `
    const express = (await import('express')).default;
    const { store } = await import(${u('store.js')});
    try { await store.refresh(); } catch {}
    const S = await import(${u('guestpart/settings.js')});
    const { api } = await import(${u('routes/api.js')});
    const snap = store.get();
    const ids = [...new Set(snap.vcenters.map((v) => v.id))];
    const vcA = ids[0];
    const others = ids.slice(1);
    const vct = {}; ids.forEach((id, i) => { vct[id] = 81 + (i % 10); }); vct['vc-out-of-fleet-secret'] = 77;
    const sv = S.save({ vcThresholds: vct });
    if (sv.error) throw new Error(sv.error);
    const app = express();
    app.use((req, _res, next) => { req.user = req.get('x-s') ? { username: 'sc', role: 'admin', scope: { vcenters: [vcA] } } : { username: 'ad', role: 'admin', scope: null }; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const get = async (p, h = {}) => { const r = await fetch(base + p, { headers: h }); return [r.status, await r.text()]; };
    const sc = { 'x-s': '1' };
    const out = { vcA, others, routes: {
      ov: await get('/api/tools/guest-partition', sc),
      vc: await get('/api/tools/guest-partition/vcenter/' + encodeURIComponent(vcA), sc),
      st: await get('/api/tools/guest-partition/settings', sc),
      adOv: await get('/api/tools/guest-partition'),
    } };
    srv.close();
    process.stdout.write('\\n@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', '--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, GUESTDISK_DB_PATH: path.join(dir, 'guest-disk.db'), DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', NODE_NO_WARNINGS: '1' },
    encoding: 'utf8', cwd: path.resolve(new URL('..', import.meta.url).pathname), timeout: 120_000,
  });
  const i = String(r.stdout).lastIndexOf('@@');
  assert.ok(i >= 0, `자식 실패: ${String(r.stderr).slice(-1500)}`);
  const o = JSON.parse(r.stdout.slice(i + 2));
  assert.ok(o.others.length >= 1, '목 데이터에 vCenter 가 둘 이상이어야 의미가 있다');
  for (const k of ['ov', 'vc', 'st']) {
    const [status, txt] = o.routes[k];
    assert.equal(status, 200, `${k}: ${txt.slice(0, 300)}`);
    const body = JSON.parse(txt);
    assert.deepEqual(Object.keys(body.settings.vcThresholds), [o.vcA], `${k}: 범위 안 vCenter 임계만`);
    assert.equal(txt.includes('vc-out-of-fleet-secret'), false, `${k}: 범위 밖 id 가 응답에 실렸다`);
    assert.equal(body.settings.mail, undefined);
  }
  const ad = JSON.parse(o.routes.adOv[1]);
  assert.equal(Object.keys(ad.settings.vcThresholds).length, o.others.length + 2, '전체 범위 계정은 예전 그대로 전부');
});
