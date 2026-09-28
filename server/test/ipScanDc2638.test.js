/**
 * v2.638 IP 스캔 — 데이터센터 귀속(수동 지정 + 자동) · 에이전트가 쓰는 /24 대역 제안.
 *   ① 판정(순수): 수동 > 자동(후보가 정확히 하나) · 삭제된 수동 값은 귀속하지 않는다 · 후보 둘 이상·0개는 귀속하지 않는다.
 *   ② 제안(순수): vCenter VM·호스트 IP + iDRAC 관리 IP 를 /24 로 묶는다 · 이름 등록은 개수만.
 *   ③ 라우트: 대장 스캔 행에 데이터센터가 붙고, vCenter 를 고른 조회는 다른 데이터센터 스캔 행을 뺀다 ·
 *      등록되지 않은 DataCenter 저장은 400 · 제안 API.
 *   ④ 웹 문구·대역 판정(ipScanDcText.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveAgentDatacenters, agentVcenterIds, suggestAgentSubnets, ipOfHost, datacenterMapSig } from '../src/ipam/scanDatacenter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

const DCS = [{ id: 'hb', name: 'HB' }, { id: 'sn', name: 'SN' }];
const VCS = [
  { id: 'vc-a', collectMode: 'site', remoteAgent: 'Edge-A' },
  { id: 'vc-b', collectMode: 'site', remoteAgent: 'edge-b' },
  { id: 'vc-b2', collectMode: 'site', remoteAgent: 'edge-b' },
  { id: 'vc-c', collectMode: 'direct' },
  { id: 'vc-off', collectMode: 'site', remoteAgent: 'edge-a', enabled: false },
  { id: 'vc-n', collectMode: 'site', remoteAgent: 'edge-n' },
];
const ASSIGN = { 'vc-a': 'hb', 'vc-b': 'hb', 'vc-b2': 'sn', 'vc-c': 'sn', 'vc-off': 'sn' };

test('① 판정: 자동은 후보가 정확히 하나일 때만 · 수동이 이긴다 · 삭제된 수동 값은 귀속 안 함 · 비활성 vCenter 는 근거 아님', () => {
  const m = resolveAgentDatacenters({
    agents: ['edge-a', 'edge-b', 'edge-n', '__local__', 'edge-x', 'edge-m', 'edge-gone', 'col-1'],
    settings: { 'edge-m': { datacenterId: 'sn' }, 'edge-gone': { datacenterId: 'deleted-dc' } },
    vcenters: VCS, snapVcenters: [], assign: ASSIGN, datacenters: DCS,
    collectors: [{ id: 'col-1', name: 'Seoul Collector', datacenter: 'SN' }],
  });
  assert.equal(m.get('edge-a').datacenterId, 'hb', '대소문자 다른 remoteAgent 도 같은 에이전트');
  assert.equal(m.get('edge-a').source, 'auto');
  assert.deepEqual(m.get('edge-a').vcenters, ['vc-a'], '비활성 vCenter(vc-off)는 근거로 쓰지 않는다');
  assert.equal(m.get('edge-b').datacenterId, null); assert.equal(m.get('edge-b').reason, 'multiple');
  assert.deepEqual(m.get('edge-b').candidates.map((c) => c.id).sort(), ['hb', 'sn']);
  assert.equal(m.get('edge-n').reason, 'none'); assert.deepEqual(m.get('edge-n').unassignedVcenters, ['vc-n'], 'DataCenter 할당 없는 vCenter 는 따로 밝힌다');
  assert.equal(m.get('__local__').datacenterId, 'sn', '이 포탈 = 직접 수집 vCenter 기준');
  assert.equal(m.get('edge-x').reason, 'none');
  assert.equal(m.get('edge-m').datacenterId, 'sn'); assert.equal(m.get('edge-m').source, 'manual');
  assert.equal(m.get('edge-gone').datacenterId, null); assert.equal(m.get('edge-gone').reason, 'manual-missing');
  assert.equal(m.get('col-1').datacenterId, 'sn', '수집 서버 등록의 datacenter 는 이름으로도 찾는다');
  assert.match(datacenterMapSig(m), /edge-a=hb/);
});

test('① 등록부에 없는 스냅샷 vCenter 는 collectedBy 로 판정한다', () => {
  assert.deepEqual(agentVcenterIds('edge-z', { vcenters: [], snapVcenters: [{ id: 'vc-z', collectSource: 'site', collectedBy: 'EDGE-Z' }] }), ['vc-z']);
  assert.deepEqual(agentVcenterIds('edge-z', { vcenters: [{ id: 'vc-z', collectMode: 'site' }], snapVcenters: [{ id: 'vc-z', collectSource: 'site', collectedBy: 'edge-z' }] }), ['vc-z'], '등록부에 remoteAgent 가 비면 관측값');
});

test('② 제안: /24 로 묶고 IP·출처를 센다 · 이름 등록은 개수만', () => {
  const r = suggestAgentSubnets({
    vcenterIds: ['vc-a'], vcName: { 'vc-a': 'VC-A' },
    vms: [{ vcenterId: 'vc-a', ipAddresses: ['10.1.2.3', '10.1.2.4', 'fe80::1'] }, { vcenterId: 'vc-a', ipAddress: '10.1.3.9' }, { vcenterId: 'vc-other', ipAddress: '10.9.9.9' }],
    hosts: [{ vcenterId: 'vc-a', name: '10.1.2.10' }, { vcenterId: 'vc-a', name: 'esx01.corp.local' }],
    idrac: [{ host: 'https://10.1.2.200:443/' }, { host: 'idrac-x.corp.local' }, { id: '10.7.0.5' }],
  });
  assert.deepEqual(r.subnets.map((x) => `${x.cidr}:${x.ips}:${x.vcenterIps}:${x.idracIps}`), ['10.1.2.0/24:4:3:1', '10.1.3.0/24:1:1:0', '10.7.0.0/24:1:0:1']);
  assert.deepEqual(r.subnets[0].vcenters, ['VC-A']);
  assert.deepEqual(r.skipped, { hostsNoIp: 1, idracNoIp: 1 });
  assert.equal(r.totals.vmIps, 3);
  assert.equal(ipOfHost('https://[fe80::1]:443'), null);
  assert.equal(ipOfHost('10.0.0.5:8443'), '10.0.0.5');
});

function runChild(body, setup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipscandc2638-'));
  setup(dir);
  const script = `
    const SRC = ${JSON.stringify(SRC + '/')};
    const express = (await import('express')).default;
    const { store } = await import(SRC + 'store.js');
    await store.refresh?.();
    const { api } = await import(SRC + 'routes/api.js');
    const { adminRouter } = await import(SRC + 'routes/admin.js');
    const app = express(); app.use(express.json({ limit: '5mb' }));
    app.use((req, _r, n) => { req.user = { username: 'full', role: 'admin', scope: null }; n(); });
    app.use('/api/admin', adminRouter); app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const call = async (method, p, b) => {
      const r = await fetch(base + '/api' + p, { method, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 300); }
      return { s: r.status, j };
    };
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
  return o;
}

test('③ 라우트: 대장 스캔 행 귀속 · vCenter 조회 필터 · 잘못된 DataCenter 400 · 제안 API', () => {
  const o = runChild(`
    const led = await call('GET', '/tools/ipam');
    const row = (led.j.rows || []).find((r) => r.ip === '198.51.100.7');
    const row2 = (led.j.rows || []).find((r) => r.ip === '198.51.100.8');
    out.dc = row ? [row.datacenterId, row.datacenterName, row.dcSource, row.scanAgent, row.vcenterName] : null;
    out.dc2 = row2 ? row2.datacenterId : 'missing';
    out.byDc = led.j.scanByDatacenter;
    const east = await call('GET', '/tools/ipam?vcenterId=vc-us-east');
    const west = await call('GET', '/tools/ipam?vcenterId=vc-eu-west');
    out.east = (east.j.rows || []).filter((r) => r.ownerType === 'scanned').map((r) => r.ip).sort();
    out.west = (west.j.rows || []).filter((r) => r.ownerType === 'scanned').map((r) => r.ip).sort();
    const g = await call('GET', '/admin/ipam/scan/settings?agent=edge-a');
    out.gDc = g.j.datacenter && [g.j.datacenter.datacenterId, g.j.datacenter.reason];
    out.gList = (g.j.datacenters || []).map((d) => d.id);
    const bad = await call('PUT', '/admin/ipam/scan/settings', { agent: 'edge-a', datacenterId: 'nope' });
    out.badS = bad.s;
    const ok = await call('PUT', '/admin/ipam/scan/settings', { agent: 'edge-a', datacenterId: 'eu' });
    out.okS = ok.s; out.okDc = ok.j.datacenter && [ok.j.datacenter.datacenterId, ok.j.datacenter.source];
    const led2 = await call('GET', '/tools/ipam');
    out.after = ((led2.j.rows || []).find((r) => r.ip === '198.51.100.7') || {}).datacenterId;
    const clr = await call('PUT', '/admin/ipam/scan/settings', { agent: 'edge-a', datacenterId: '' });
    out.clrDc = clr.j.datacenter && clr.j.datacenter.source;
    const sg = await call('GET', '/admin/ipam/scan/suggest?agent=edge-a');
    out.sgS = sg.s; out.sgVc = (sg.j.vcenters || []).map((v) => v.id); out.sgN = (sg.j.subnets || []).length; out.sgTotals = sg.j.totals;
    const sgNew = await call('GET', '/admin/ipam/scan/suggest?agent=brand-new');
    out.sgNew = [sgNew.s, (sgNew.j.subnets || []).length, sgNew.j.datacenter && sgNew.j.datacenter.reason];
  `, (dir) => {
    fs.writeFileSync(path.join(dir, 'vcenters.json'), JSON.stringify({ vcenters: [
      { id: 'vc-us-east', name: 'vcenter-us-east.corp.local', host: 'https://10.0.0.1', username: 'u', password: 'p', collectMode: 'site', remoteAgent: 'edge-a', maintenance: true },
      { id: 'vc-eu-west', name: 'vcenter-eu-west.corp.local', host: 'https://10.0.0.2', username: 'u', password: 'p', maintenance: true },
    ] }));
    fs.writeFileSync(path.join(dir, 'datacenters.json'), JSON.stringify({ datacenters: [{ id: 'us', name: 'US' }, { id: 'eu', name: 'EU' }], assign: { 'vc-us-east': 'us', 'vc-eu-west': 'eu' } }));
    const now = Date.now();
    fs.writeFileSync(path.join(dir, 'ipam-scan-results.json'), JSON.stringify({
      '198.51.100.7': { openPorts: [22], services: ['ssh'], hostname: 'x', lastSeen: now, agent: 'edge-a' },
      '198.51.100.8': { openPorts: [80], services: [], hostname: '', lastSeen: now, agent: 'edge-unknown' },
    }));
  });
  assert.deepEqual(o.dc, ['us', 'US', 'auto', 'edge-a', '(네트워크 스캔)'], 'vCenter 이름 칸(외부 ipam.db 열)은 그대로');
  assert.equal(o.dc2, '', '판정 근거 없는 에이전트의 행은 귀속하지 않는다');
  assert.deepEqual(o.byDc.map((x) => `${x.datacenterId}:${x.count}`).sort(), [':1', 'us:1']);
  assert.deepEqual(o.east, ['198.51.100.7', '198.51.100.8'], '그 데이터센터 행 + 귀속 없는 행');
  assert.deepEqual(o.west, ['198.51.100.8'], '다른 데이터센터에 귀속된 스캔 행은 빠진다');
  assert.deepEqual(o.gDc, ['us', 'auto']); assert.deepEqual(o.gList, ['us', 'eu']);
  assert.equal(o.badS, 400, '등록되지 않은 DataCenter 는 저장하지 않는다');
  assert.equal(o.okS, 200); assert.deepEqual(o.okDc, ['eu', 'manual']);
  assert.equal(o.after, 'eu', '저장 즉시 대장이 새 귀속으로 다시 만들어진다(스냅샷 세대를 기다리지 않는다)');
  assert.equal(o.clrDc, 'auto', '빈 값 = 자동으로 되돌린다');
  assert.equal(o.sgS, 200); assert.deepEqual(o.sgVc, ['vc-us-east']); assert.ok(o.sgN > 0, '목 데이터의 VM IP 로 /24 가 나온다');
  assert.deepEqual(o.sgNew, [200, 0, 'none'], '설정이 없는 새 이름도 그 자리에서 판정한다');
});

test('④ 웹: 귀속 문구 · 입력된 대역 판정 · 붙이기', async () => {
  const w = await import(pathToFileURL(path.resolve(HERE, '../../web/src/views/tools/ipScanDcText.js')).href);
  assert.equal(w.dcDecisionText({ reason: 'auto', datacenterName: 'HB', candidates: [{ vcenters: ['vc-a'], collectors: [] }] }).tone, 'ok');
  assert.match(w.dcDecisionText({ reason: 'multiple', candidates: [{ name: 'A', vcenters: ['x'], collectors: [] }, { name: 'B', vcenters: [], collectors: ['c'] }] }).text, /후보 2곳/);
  assert.match(w.dcDecisionText({ reason: 'none', vcenters: ['vc-n'], unassignedVcenters: ['vc-n'], candidates: [] }).text, /할당 없음/);
  assert.match(w.dcDecisionText({ reason: 'manual-missing', manualId: 'x', candidates: [] }).detail, /삭제/);
  assert.equal(w.dcDecisionText(null).tone, 'muted');
  const rg = w.rangesOf(['10.1.2.0/25', 'abc', '10.1.3.0/24']);
  assert.equal(w.coverageOf('10.1.2.0/24', rg), 'partial');
  assert.equal(w.coverageOf('10.1.3.0/24', rg), 'full');
  assert.equal(w.coverageOf('10.1.4.0/24', rg), '');
  assert.equal(w.coverageOf('10.1.4.0/24', w.rangesOf(['10.1.4.0-10.1.4.127', '10.1.4.128-10.1.4.255'])), 'full', '겹치지 않는 두 줄의 합');
  const a = w.appendSubnets(['10.1.3.0/24', ''], ['10.1.3.0/24', '10.1.5.0/24', '10.1.5.0/24']);
  assert.deepEqual(a.lines, ['10.1.3.0/24', '10.1.5.0/24']); assert.equal(a.added, 1); assert.equal(a.skipped, 2);
  assert.match(w.suggestSummaryText({ totals: { subnets: 3, vmIps: 1, hostIps: 2, idracIps: 0 }, skipped: { hostsNoIp: 1 }, omitted: 0, subnets: [] }), /이름으로 등록된 ESXi 호스트 1대/);
});
