/**
 * v2.637 IPMS 설정 — 대역 문법 판정(ipam/rangeSyntax.js) + 저장 검증(PUT /admin/ipam/settings · /vc-ranges) + 저장된 옛 값 보고.
 *   ① `10.0.0.0/`(빈 마스크)는 Number('')===0 → /0 으로 읽혀 무시 대역이면 IPv4 전체를 숨기고, 공인 대역이면 사설 주소까지
 *      '공인' 으로 분류했다(재현). 이제 적용 단계에서도 버리고 저장 단계에서 400 이다.
 *   ② `abc`·`/33` 같은 줄은 '저장했습니다' 뒤 조용히 버려졌다 — 이제 400 + 줄 번호·사유.
 *   ③ 웹 사본(web/src/views/tools/ipmsRangeText.js)과 같은 입력으로 같은 결과인지 대조한다(번들 경계로 두 벌이다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkRangeSpec, checkRangeList, parseRangeSpec } from '../src/ipam/rangeSyntax.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function runChild(body, { env = {}, setup = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipms2637-'));
  if (setup) setup(dir);
  const script = `
    const SRC = ${JSON.stringify(SRC + '/')};
    const fs = await import('node:fs'); const path = await import('node:path');
    const express = (await import('express')).default;
    const { store } = await import(SRC + 'store.js');
    await store.refresh?.();
    const auth = await import(SRC + 'auth/auth.js');
    const { api } = await import(SRC + 'routes/api.js');
    const { adminRouter } = await import(SRC + 'routes/admin.js');
    const { remoteRouter } = await import(SRC + 'routes/remote.js');
    auth.createUser({ username: 'boss', role: 'admin', name: 'B' }, { trusted: true });
    auth.createUser({ username: 'sadm', role: 'admin', name: 'S', scope: { vcenters: ['vc-us-east'] } }, { trusted: true });
    auth.createUser({ username: 'sub', role: 'viewer', name: 'U', scope: { vcenters: ['vc-us-east'] } }, { trusted: true });
    auth.createUser({ username: 'euop', role: 'operator', name: 'E', scope: { vcenters: ['vc-eu-west'] } }, { trusted: true });
    const app = express(); app.use(express.json({ limit: '5mb' }));
    app.use((req, _r, n) => {
      const name = req.headers['x-u'] || 'full';
      if (name === 'full') { req.user = { username: 'full', role: 'admin', scope: null }; return n(); }
      const u = auth.listUsers().find((x) => x.username === name);
      req.user = u ? { username: u.username, role: u.role, scope: u.scope } : null; n();
    });
    app.use('/api/admin', adminRouter); app.use('/api/remote', remoteRouter); app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const call = async (u, method, p, b) => {
      const r = await fetch(base + '/api' + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 300); }
      return { s: r.status, j };
    };
    const CFG = process.env.CONFIG_DIR;
    const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(CFG, f), 'utf8')); } catch { return null; } };
    const userRec = (n) => auth.listUsers().find((x) => x.username === n) || null;
    const out = {};
    try { ${body} } catch (e) { out.err = String(e && e.stack || e); } finally { srv.close(); }
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', ...env },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 180_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${(r.stderr || '').slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1000)} ${r.stderr.slice(-1000)}`);
  const o = JSON.parse(line.slice(2));
  assert.equal(o.err, undefined, o.err);
  return o;
}



const writeVcReg = (dir) => fs.writeFileSync(path.join(dir, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: 'vc-us-east', name: 'vcenter-us-east.corp.local', host: 'https://10.0.0.1', username: 'u', password: 'p', maintenance: true },
  { id: 'vc-eu-west', name: 'vcenter-eu-west.corp.local', host: 'https://10.0.0.2', username: 'u', password: 'p', maintenance: true },
] }));

const SAMPLES = [
  '10.0.0.0/', '10.0.0.0/0', '10.0.0.0/7', '10.0.0.0/8', '10.0.0.0/33', '10.0.0.0/2a', '10.0.0.0/24/1', '10.0.0.5/24',
  '10.0.0.1-10.0.0.50', '10.0.0.1-50', '10.0.0.50-10.0.0.1', '10.0.0.1-', '-10.0.0.1', '10.0.0.1-256', '1.2.3.4', 'abc',
  '256.1.1.1', ' 10.1.1.1 ', '10.0.0.1-10.0.0.2-10.0.0.3', '010.0.0.1', '', '/24',
];

test('① 빈 마스크·너무 넓은 마스크·/33·숫자 아닌 마스크는 오류 — 경계 아닌 CIDR·뒤바뀐 범위는 경고', () => {
  for (const bad of ['10.0.0.0/', '10.0.0.0/0', '10.0.0.0/7', '10.0.0.0/33', '10.0.0.0/2a', 'abc', '256.1.1.1', '/24', '10.0.0.1-', '10.0.0.1-256']) {
    assert.equal(checkRangeSpec(bad).ok, false, bad);
    assert.equal(parseRangeSpec(bad), null, bad);
  }
  const w = checkRangeSpec('10.0.0.5/24');
  assert.equal(w.ok, true); assert.match(w.warn, /10\.0\.0\.0\/24/);
  const rev = checkRangeSpec('10.0.0.50-10.0.0.1');
  assert.equal(rev.ok, true); assert.equal(rev.size, 50); assert.match(rev.warn, /뒤바뀌/);
  assert.equal(checkRangeSpec('10.0.0.50-10.0.0.1', { reversed: 'error' }).ok, false, '스캔 대역은 뒤바뀐 범위를 거부(rangeSize 와 같다)');
  assert.equal(checkRangeSpec('10.0.0.1-50').size, 50, '끝이 마지막 옥텟인 짧은 형식');
  const l = checkRangeList(['10.0.0.0/24', '', 'abc', '10.0.0.0/24', '10.0.0.0/16'], { scanCap: 4096 });
  assert.deepEqual(l.invalid.map((x) => x.line), [3], '줄 번호는 빈 줄을 포함한 원래 줄 기준');
  assert.ok(l.warnings.some((x) => x.line === 4 && /1행/.test(x.reason)), '중복 대역 경고');
  assert.ok(l.warnings.some((x) => x.line === 5 && /4,096/.test(x.reason)), '스캔 상한 경고');
});

test('① 적용 단계: 저장된 옛 값 `10.0.0.0/` 가 더는 IPv4 전체를 숨기거나 사설을 공인으로 바꾸지 않는다 · 뒤바뀐 옛 범위는 계속 적용', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipms2637a-'));
  fs.writeFileSync(path.join(dir, 'ipam-settings.json'), JSON.stringify({ global: ['10.0.0.0/', '10.9.9.20-10.9.9.10'], vcenters: {}, publicRanges: ['1.2.3.0/'], privateRanges: [] }));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const m = await import(${JSON.stringify(pathToFileURL(path.join(SRC, 'ipam/settings.js')).href)});
    const f = m.getIgnoreMatcher(); const c = m.getClassifier();
    console.log('@@' + JSON.stringify({ g: f('8.8.8.8', ''), rev: f('10.9.9.15', ''), cls: c('10.0.0.1'), inv: m.savedInvalidEntries().map((x) => x.field + ':' + x.line) }));
  `], { env: { ...process.env, CONFIG_DIR: dir }, encoding: 'utf8' });
  const o = JSON.parse(r.stdout.split('\n').find((x) => x.startsWith('@@')).slice(2));
  assert.equal(o.g, false, '수정 전: 8.8.8.8 이 숨겨졌다(/0)');
  assert.equal(o.rev, true, '뒤바뀐 옛 범위는 예전처럼 바꿔 읽는다');
  assert.equal(o.cls, 'private', '수정 전: 10.0.0.1 이 공인으로 분류됐다');
  assert.deepEqual(o.inv, ['global:1', 'publicRanges:1'], '적용되지 않는 저장값을 보고한다');
});

test('② PUT 은 형식 오류를 400 으로 거절하고 파일을 건드리지 않는다 · 범위 계정은 적용되는 vCenter 목록만 검사한다', () => {
  const o = runChild(`
    const ok = await call('full', 'PUT', '/admin/ipam/settings', { global: ['1.1.1.1'], publicRanges: [], privateRanges: [], vcenters: { 'vc-us-east': ['10.0.0.1'] } });
    out.okS = ok.s;
    const bad = await call('full', 'PUT', '/admin/ipam/settings', { global: ['10.0.0.0/', 'abc'], publicRanges: [], privateRanges: [], vcenters: { 'vc-eu-west': ['10.0.0.0/33'] } });
    out.badS = bad.s; out.badInvalid = bad.j.invalid; out.badReason = bad.j.reason;
    out.fileAfterBad = readJson('ipam-settings.json');
    // 범위 계정: 전역 목록의 오류는 어차피 적용되지 않으므로 막지 않는다(기존 ignoredGlobal 계약) — 자기 vCenter 목록 오류만 막는다.
    out.sGlobalS = (await call('sadm', 'PUT', '/admin/ipam/settings', { global: ['abc'], publicRanges: [], privateRanges: [], vcenters: { 'vc-us-east': ['10.0.0.2'] } })).s;
    out.sVcS = (await call('sadm', 'PUT', '/admin/ipam/settings', { global: [], publicRanges: [], privateRanges: [], vcenters: { 'vc-us-east': ['10.0.0.2/'] } })).s;
    // 스캔 대역
    const sb = await call('full', 'PUT', '/admin/ipam/vc-ranges', { vcenterId: 'vc-us-east', ranges: '10.1.0.0/\\n10.2.0.9-10.2.0.1', enabled: true });
    out.scanBadS = sb.s; out.scanBadLines = (sb.j.invalid || []).map((x) => x.line + ':' + x.field);
    const sg = await call('full', 'PUT', '/admin/ipam/vc-ranges', { vcenterId: 'vc-us-east', ranges: '10.1.0.0/24\\n10.1.0.0/24', enabled: true });
    out.scanOkS = sg.s; out.scanWarn = (sg.j.warnings || []).length;
  `, { setup: writeVcReg });
  assert.equal(o.okS, 200);
  assert.equal(o.badS, 400, '수정 전: 형식 오류가 200 으로 저장됐다');
  assert.deepEqual(o.badInvalid.map((x) => `${x.field}:${x.vcenterId ?? ''}:${x.line}`), ['global::1', 'global::2', 'vcenters:vc-eu-west:1']);
  assert.match(o.badReason, /3개/);
  assert.deepEqual(o.fileAfterBad.global, ['1.1.1.1'], '400 이면 파일은 그대로');
  assert.equal(o.sGlobalS, 200); assert.equal(o.sVcS, 400);
  assert.equal(o.scanBadS, 400); assert.deepEqual(o.scanBadLines, ['1:scanRanges', '2:scanRanges']);
  assert.equal(o.scanOkS, 200); assert.equal(o.scanWarn, 1, '중복 대역은 저장하되 경고');
});

test('② GET 은 삭제된 vCenter 에 남은 무시 대역(orphanVcenters)과 적용되지 않는 저장값(invalidSaved)을 밝힌다', () => {
  const o = runChild(`
    const g = await call('full', 'GET', '/admin/ipam/settings');
    out.orphan = g.j.orphanVcenters; out.inv = (g.j.invalidSaved || []).map((x) => x.field + ':' + x.line);
    const s = await call('sadm', 'GET', '/admin/ipam/settings');
    out.sOrphan = s.j.orphanVcenters ?? null;
  `, { setup: (dir) => { writeVcReg(dir); fs.writeFileSync(path.join(dir, 'ipam-settings.json'), JSON.stringify({ global: ['abc'], publicRanges: [], privateRanges: [], vcenters: { 'vc-us-east': ['10.0.0.1'], 'vc-gone': ['10.5.5.5'] } })); } });
  assert.deepEqual(o.orphan, ['vc-gone']);
  assert.deepEqual(o.inv, ['global:1']);
  assert.equal(o.sOrphan, null, '범위 계정에는 범위 밖(삭제된) vCenter 키를 드러내지 않는다');
});

test('③ 웹 사본과 서버 판정이 같은 입력에서 같은 결과를 낸다', async () => {
  const web = await import(pathToFileURL(path.resolve(HERE, '../../web/src/views/tools/ipmsRangeText.js')).href);
  for (const x of SAMPLES) {
    for (const opt of [{}, { reversed: 'error' }]) assert.deepEqual(web.checkRangeSpec(x, opt), checkRangeSpec(x, opt), `${x} ${JSON.stringify(opt)}`);
  }
  assert.deepEqual(web.checkRangeList(SAMPLES, { scanCap: 4096 }), checkRangeList(SAMPLES, { scanCap: 4096 }));
});
