// v2.692: '/24 가져오기' 에 IPMS 무시 대역 제외 + 공인/사설 분류 · 등록된 스캔 대역 표(대역 1줄 = 1행) · 줄 단위 수정·삭제.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { annotateSubnets } from '../src/ipam/vcRangeSuggest.js';
import { buildScanRangeRows, applyRangeLineOp, rangeIgnore, rangeClass } from '../src/ipam/scanRangeRows.js';
import { parseRangeSpec } from '../src/ipam/rangeSyntax.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const R = (s) => parseRangeSpec(s);
const priv = (n) => { const a = Math.floor(n / 16777216); return a === 10 || a === 192 ? 'private' : 'public'; };

test('① 무시 대역 — 호스트 전부가 들면 후보에서 빼고 출처를 센다 · 일부만 걸치면 남기고 표시', () => {
  const r = annotateSubnets([{ cidr: '10.1.0.0/24' }, { cidr: '10.1.1.0/24' }, { cidr: '10.2.0.0/24' }, { cidr: '10.3.0.0/24' }], {
    ignore: { global: [R('10.1.0.0/24')], vcenters: { vcA: [R('10.2.0.1-10.2.0.254')], vcB: [R('10.3.0.0/24')] } },
    vcenterIds: ['vcA'], classify: priv, vcName: { vcA: 'AZ' },
  });
  assert.deepEqual(r.subnets.map((x) => x.cidr), ['10.1.1.0/24', '10.3.0.0/24'], '전체 무시·vCenter 무시(호스트 .1~.254 전부)는 뺀다 · 다른 vCenter 무시는 적용하지 않는다');
  assert.equal(r.ignored.count, 2); assert.deepEqual(r.ignored.bySource, { global: 1, 'vc:vcA': 1 });
  assert.deepEqual(r.sources.map((x) => x.label), ['전체(모든 vCenter)', 'vCenter AZ']);
  const p = annotateSubnets([{ cidr: '172.18.3.0/24' }], { ignore: { global: [R('172.18.3.0-172.18.3.127')] }, classify: priv });
  assert.equal(p.subnets.length, 1); assert.equal(p.subnets[0].ignore, 'partial'); assert.deepEqual(p.subnets[0].ignoreBy, ['global']);
});

test('② 공인/사설 — IPMS 분류기 그대로 · /24 안에서 갈리면 mixed · 분류기가 없으면 null', () => {
  const r = annotateSubnets([{ cidr: '10.0.0.0/24' }, { cidr: '8.8.8.0/24' }], { classify: priv });
  assert.deepEqual(r.subnets.map((x) => x.cls), ['private', 'public']);
  assert.equal(rangeClass(R('9.255.255.200-10.0.0.10').lo, R('9.255.255.200-10.0.0.10').hi, priv), 'mixed');
  assert.equal(annotateSubnets([{ cidr: '10.0.0.0/24' }], {}).subnets[0].cls, null);
});

test('③ 무시 판정 — 구간 합집합(두 줄로 나눠 덮어도 full)', () => {
  const lo = R('10.5.0.0/24').lo; const hi = R('10.5.0.0/24').hi;
  assert.equal(rangeIgnore(lo, hi, [{ ...R('10.5.0.0-10.5.0.127'), src: 'g' }, { ...R('10.5.0.128-10.5.0.255'), src: 'v' }]).state, 'full');
  assert.equal(rangeIgnore(lo, hi, [{ ...R('10.5.0.0-10.5.0.100'), src: 'g' }]).state, 'partial');
  assert.equal(rangeIgnore(lo, hi, []).state, null);
});

test('④ 등록된 대역 표 — 줄마다 한 행 · 형식 오류 사유 · 다른 에이전트 겹침 · 응답 IP 수는 그 에이전트 결과만', () => {
  const { rows } = buildScanRangeRows({
    agents: [{ name: '__local__', enabled: true, ranges: ['10.0.0.0/24', '10.0.0.0/'] }, { name: 'Edge-A', enabled: false, ranges: ['10.0.0.128/25', '8.8.8.0/24'] }],
    results: { '10.0.0.5': { agent: '__local__' }, '10.0.0.200': { agent: 'edge-a' }, '10.0.0.201': { agent: '__local__' } },
    classify: priv, ignore: { global: [R('8.8.8.0/24')] }, datacenterOf: (a) => (a === 'Edge-A' ? { datacenterId: 'DC-A', datacenterName: 'A' } : null),
  });
  assert.equal(rows.length, 4);
  const [l0, l1, e0, e1] = rows;
  assert.equal(l0.alive, 2); assert.deepEqual(l0.overlaps, ['Edge-A']); assert.equal(l0.size, 256);
  assert.equal(l1.valid, false); assert.match(l1.reason, /마스크/);
  assert.equal(e0.alive, 1, '결과 에이전트 이름은 대소문자 무시'); assert.equal(e0.agentEnabled, false); assert.equal(e0.datacenterName, 'A');
  assert.equal(e1.ignore, 'full'); assert.equal(e1.cls, 'public');
});

test('⑤ 줄 단위 변경 — 지금 값과 다르면 stale · 중복·빈 값 거부 · 다른 줄은 그대로', () => {
  const cur = ['a', 'b', 'c'];
  assert.deepEqual(applyRangeLineOp(cur, { op: 'edit', index: 1, old: 'b', value: 'B' }).ranges, ['a', 'B', 'c']);
  assert.deepEqual(applyRangeLineOp(cur, { op: 'delete', index: 2, old: 'c' }).ranges, ['a', 'b']);
  assert.deepEqual(applyRangeLineOp(cur, { op: 'add', value: 'd' }).ranges, ['a', 'b', 'c', 'd']);
  assert.equal(applyRangeLineOp(cur, { op: 'edit', index: 1, old: 'x', value: 'B' }).code, 'stale');
  assert.equal(applyRangeLineOp(cur, { op: 'delete', index: 9, old: 'c' }).code, 'stale');
  assert.equal(applyRangeLineOp(cur, { op: 'edit', index: 0, old: 'a', value: 'c' }).code, 'exists');
  assert.equal(applyRangeLineOp(cur, { op: 'add', value: '  ' }).code, 'empty');
  assert.equal(applyRangeLineOp(cur, { op: 'zz' }).code, 'stale');
});

function runChild(body, { user, setup }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipscan2691-'));
  setup?.(dir);
  const script = `
    const SRC = ${JSON.stringify(SRC + '/')};
    const express = (await import('express')).default;
    const fs = await import('node:fs');
    const { store } = await import(SRC + 'store.js');
    await store.refresh?.();
    const { adminRouter } = await import(SRC + 'routes/admin.js');
    const app = express(); app.use(express.json());
    app.use((req, _r, n) => { req.user = ${JSON.stringify(user)}; n(); });
    app.use('/api/admin', adminRouter);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const call = async (m, p, b) => { const r = await fetch(base + '/api/admin' + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 200); } return { s: r.status, j }; };
    const get = (p) => call('GET', p);
    const post = (p, b) => call('POST', p, b);
    const out = {};
    try { ${body} } catch (e) { out.err = String(e && e.stack || e); } finally { srv.close(); }
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' }, encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 180_000,
  });
  assert.equal(r.status, 0, (r.stderr || '').slice(-2000));
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `${r.stdout.slice(-800)} ${r.stderr.slice(-800)}`);
  const o = JSON.parse(line.slice(2));
  assert.equal(o.err, undefined, o.err);
  return { ...o, dir };
}

const FULL = { username: 'full', role: 'admin', scope: null };

test('⑥ 실제 라우터 — 목록·줄 수정·409·400·삭제 · 가져오기에 무시·분류 적용 · 범위 계정 403', () => {
  const o = runChild(`
    const vc = store.get().vcenters[0].id;
    fs.writeFileSync(process.env.CONFIG_DIR + '/ipam-scan.json', JSON.stringify({ agents: { __local__: { enabled: false, ranges: ['10.10.0.0/24', '10.10.1.0/24'] }, 'Edge-A': { enabled: true, ranges: ['10.10.1.0/25'] } } }));
    (await import(SRC + 'ipam/settings.js')).saveSettings({ global: ['192.168.40.0/24'], vcenters: { [vc]: ['192.168.41.0/24'] }, publicRanges: ['192.168.42.0/24'], privateRanges: [] }); // 캐시도 함께 갱신(화면 저장 경로와 같다)
    fs.writeFileSync(process.env.CONFIG_DIR + '/datacenters.json', JSON.stringify({ datacenters: [{ id: 'DC-WA', name: 'WA' }], assign: { [vc]: 'DC-WA' } }));
    fs.writeFileSync(process.env.CONFIG_DIR + '/idrac-scan-ranges.json', JSON.stringify({ entries: { a: { datacenterId: 'DC-WA', service: 'S', ranges: ['192.168.40.0/22'], enabled: true } } }));
    out.list = await get('/ipam/scan/ranges');
    out.edit = await post('/ipam/scan/ranges/line', { agent: '__local__', op: 'edit', index: 1, old: '10.10.1.0/24', value: '10.10.2.0/24' });
    out.stale = await post('/ipam/scan/ranges/line', { agent: '__local__', op: 'edit', index: 1, old: '10.10.1.0/24', value: '10.10.3.0/24' });
    out.bad = await post('/ipam/scan/ranges/line', { agent: '__local__', op: 'add', value: '10.10.9.0/' });
    out.add = await post('/ipam/scan/ranges/line', { agent: 'Edge-A', op: 'add', value: '10.20.0.0/24' });
    out.del = await post('/ipam/scan/ranges/line', { agent: '__local__', op: 'delete', index: 0, old: '10.10.0.0/24' });
    out.after = await get('/ipam/scan/settings');
    out.idrac = await get('/ipam/scan/import?kind=idrac&datacenterId=DC-WA');
  `, { user: FULL });
  assert.equal(o.list.s, 200);
  assert.equal(o.list.j.rows.length, 3);
  assert.deepEqual(o.list.j.rows.find((r) => r.range === '10.10.1.0/24').overlaps, ['Edge-A']);
  assert.equal(o.edit.s, 200); assert.deepEqual(o.edit.j.ranges, ['10.10.0.0/24', '10.10.2.0/24']);
  assert.equal(o.stale.s, 409);
  assert.equal(o.bad.s, 400); assert.ok(o.bad.j.invalid.length);
  assert.equal(o.add.s, 200); assert.deepEqual(o.add.j.ranges, ['10.10.1.0/25', '10.20.0.0/24']);
  assert.equal(o.del.s, 200); assert.deepEqual(o.after.j.settings.ranges, ['10.10.2.0/24'], '다른 줄·다른 설정은 그대로');
  assert.equal(o.after.j.settings.enabled, false);
  const sv = o.idrac.j.services[0];
  assert.deepEqual(sv.subnets.map((x) => x.cidr), ['192.168.42.0/24', '192.168.43.0/24'], '전체 무시(.40)·DataCenter vCenter 무시(.41) 제외');
  assert.equal(sv.ignored.count, 2);
  assert.equal(sv.subnets[0].cls, 'public', 'IPMS ③ 명시 공인'); assert.equal(sv.subnets[1].cls, 'private');
  const scoped = runChild(`out.l = await get('/ipam/scan/ranges'); out.p = await post('/ipam/scan/ranges/line', { op: 'add', value: '10.0.0.0/24' });`,
    { user: { username: 'scoped', role: 'admin', scope: { vcenters: ['vc-x'] } } });
  assert.equal(scoped.l.s, 403); assert.equal(scoped.p.s, 403);
});
