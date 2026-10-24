/**
 * v2.778 — 실서버 GM1 두 가지.
 *  A Veeam 작업 목록에는 VM 54대인데 vCenter 화면은 '백업 대상 0 / 340' — Veeam 이 적은 vCenter 이름과 포탈 등록 주소(IP·포워딩 주소)가 달랐다.
 *    moref·이름이 함께 맞으면 그 이름을 이 vCenter 의 별칭으로 배운다(veeam/parse.js learnHostAliases · matchToVcenter 하나).
 *  B 진행 상태가 토큰 발급 전의 403 을 '막힘' 으로 보였고, 6단계(결과 올리기)가 다른 경로(/inventory)의 거부 사유를 붙였다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'veeam2778-'));
process.env.CONFIG_DIR = DIR;

const P = await import('../src/veeam/parse.js');
const { veeamProgress } = await import('../src/veeam/progress.js');
const IR = await import('../src/central/ingestReject.js');
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

/* ═════════ A 별칭 ═════════ */
const VC = 'gm1:vc';
const vms = Array.from({ length: 6 }, (_, i) => ({ id: `${VC}:vm-${i + 1}`, name: `GM1-SRV${i + 1}` }));
const job = { name: 'J1', type: 'Backup', disabled: false, lastRun: NOW - HOUR, lastResult: 'Success' };
const entry = (i, h, name = `GM1-SRV${i}`) => ({ m: `vm-${i}`, n: name, h, j: [0] });
const res = (entries) => [{ server: { id: 's', name: 'GM1' }, result: { vms: entries, jobs: [job] } }];

test('A-1 포탈이 포워딩 주소로 등록 · Veeam 은 FQDN — moref·이름이 맞으면 같은 vCenter 로 맞추고 별칭을 알린다', () => {
  const m = P.matchToVcenter({ id: VC, host: '10.0.0.1:8443' }, vms, res([1, 2, 3, 4, 5].map((i) => entry(i, 'gm1-vc.corp.local'))));
  assert.equal(Object.keys(m.byVm).length, 5);
  assert.equal(m.otherVcenter, 0);
  assert.deepEqual(m.aliasHosts, ['gm1-vc.corp.local']);
});

test('A-2 근거가 모자라면 배우지 않는다 — 맞은 수 < 3 · 비율 < 0.8 · 이름이 다름(다른 vCenter 의 같은 moref)', () => {
  let m = P.matchToVcenter({ id: VC, host: '10.0.0.1' }, vms, res([1, 2].map((i) => entry(i, 'gm1-vc.corp.local'))));
  assert.equal(Object.keys(m.byVm).length, 0); assert.equal(m.otherVcenter, 2); assert.equal(m.aliasHosts, undefined);
  // 3대 맞음 + 2대 이름 다름 = 60%
  m = P.matchToVcenter({ id: VC, host: '10.0.0.1' }, vms, res([...[1, 2, 3].map((i) => entry(i, 'x.corp')), entry(4, 'x.corp', 'OTHER-A'), entry(5, 'x.corp', 'OTHER-B')]));
  assert.equal(Object.keys(m.byVm).length, 0); assert.equal(m.otherVcenter, 5);
  m = P.matchToVcenter({ id: VC, host: '10.0.0.1' }, vms, res([1, 2, 3, 4].map((i) => entry(i, 'pl-vc.corp', `PL-${i}`))));
  assert.equal(Object.keys(m.byVm).length, 0, 'moref 만 겹치는 다른 vCenter 의 VM 에 배지를 달지 않는다');
});

test('A-3 다른 등록 vCenter 의 주소와 같은 이름은 별칭으로 배우지 않는다 · 별칭이 아닌 이름은 그대로 다른 vCenter', () => {
  const m = P.matchToVcenter({ id: VC, host: '10.0.0.1' }, vms, res([1, 2, 3, 4].map((i) => entry(i, 'kr-vc.corp.local'))), { otherHosts: ['https://KR-VC.corp.local/sdk', ''] });
  assert.equal(Object.keys(m.byVm).length, 0); assert.equal(m.otherVcenter, 4); assert.equal(m.aliasHosts, undefined);
  const m2 = P.matchToVcenter({ id: VC, host: '10.0.0.1' }, vms, res([...[1, 2, 3].map((i) => entry(i, 'gm1-vc.corp')), entry(6, 'other.corp')]));
  assert.equal(Object.keys(m2.byVm).length, 3); assert.equal(m2.otherVcenter, 1, '별칭이 아닌 이름의 항목은 여전히 다른 vCenter');
});

test('A-4 등록 주소와 Veeam 이름이 이미 같으면 별칭 없음(기존 동작 그대로)', () => {
  const m = P.matchToVcenter({ id: VC, host: 'GM1-VC.corp.local' }, vms, res([1, 2, 3].map((i) => entry(i, 'gm1-vc.corp.local'))));
  assert.equal(Object.keys(m.byVm).length, 3); assert.equal(m.aliasHosts, undefined);
});

test('A-5 라우트가 다른 vCenter 주소를 넘기고, 관리자가 아니면 별칭(주소)을 싣지 않는다', () => {
  const src = fs.readFileSync(new URL('../src/routes/api/veeam.js', import.meta.url), 'utf8');
  // v2.779: 백업 메뉴(vcBackup)가 한 번 더 부른다 — 수를 박지 않고 '모든 호출이 otherHosts' 로 본다
  const calls = src.match(/matchToVcenter\([^;]*;/g) || [];
  assert.ok(calls.length >= 3);
  assert.deepEqual(calls.filter((c) => !/otherHosts/.test(c)), [], '모든 호출(badges·backup-counts·vm-detail·백업 메뉴)이 otherHosts');
  assert.match(src, /aliasHosts: _al, \.\.\.rest/);
});

/* ═════════ B 진행 상태 ═════════ */
const SRV = { id: 's1', name: 'GM1', agent: 'GM1', enabled: true, vcenterIds: ['gm1:vc'] };
const pulls = (lastFailAt) => ({ since: NOW - HOUR, rows: [{ agent: 'GM1', verified: true, firstAt: NOW - HOUR, lastAt: NOW - 10_000, byEndpoint: [{ endpoint: '/veeam-config', count: 21, okCount: 0, failCount: 21, lastOkAt: 0, lastFailAt, lastStatus: 403 }] }] });
const rejects = (veeamAt) => ({ rows: [{ agent: 'GM1', total: 30, lastAt: NOW - 5_000, lastReason: "vcenterId 'GM1' 는 중앙이 직접 수집하는(direct) vCenter 입니다", byEndpoint: { '/veeam-data': 22, '/inventory': 8 }, lastByEndpoint: { '/veeam-data': { at: veeamAt, status: 403, reason: '개별 토큰 필요' }, '/inventory': { at: NOW - 5_000, status: 403, reason: "vcenterId 'GM1' 는 중앙이 직접 수집하는(direct) vCenter 입니다" } } }] });
const by = (r) => Object.fromEntries(r.steps.map((s) => [s.key, s]));

test('B-1 실서버 GM1: 토큰 발급(18:40) 전의 403·거부는 막힘이 아니라 대기 · 6단계 사유는 /veeam-data 것', () => {
  const issued = NOW - 4 * 60_000;
  const r = veeamProgress({ server: SRV, tokenAgents: [{ agent: 'GM1', createdAt: issued, lastUsedAt: NOW - 60_000 }], pulls: pulls(issued - 4 * 60_000), rejects: rejects(issued - 60_000), edge: null, now: NOW });
  const s = by(r);
  assert.equal(s.pull.state, 'wait'); assert.match(s.pull.text, /발급 전/);
  assert.equal(s.push.state, 'wait'); assert.match(s.push.text, /발급 전/);
  assert.ok(!/direct/.test(s.push.text), '다른 경로(/inventory) 사유를 붙이지 않는다');
});

test('B-2 발급 뒤에도 403·거부면 막힘 · 사유는 /veeam-data 의 마지막 것', () => {
  const issued = NOW - 30 * 60_000;
  const r = veeamProgress({ server: SRV, tokenAgents: [{ agent: 'GM1', createdAt: issued, lastUsedAt: NOW - 60_000 }], pulls: pulls(NOW - 60_000), rejects: rejects(NOW - 60_000), edge: null, now: NOW });
  const s = by(r);
  assert.equal(s.pull.state, 'bad'); assert.match(s.pull.text, /403/);
  assert.equal(s.push.state, 'bad'); assert.match(s.push.text, /22회.*개별 토큰 필요/);
  assert.ok(!/direct/.test(s.push.text));
  assert.equal(s.push.at, NOW - 60_000, '시각도 그 경로의 것');
});

test('B-3 ingestReject — 경로별 마지막 거부(시각·상태·사유)를 따로 남긴다', () => {
  IR.resetRejects();
  IR.recordReject('GM1', '/veeam-data', { status: 403, reason: '개별 토큰 필요' });
  IR.recordReject('GM1', '/inventory', { status: 403, reason: 'direct vCenter' });
  const row = IR.rejectStats().rows.find((x) => x.agent === 'GM1');
  assert.equal(row.lastReason, 'direct vCenter');
  assert.equal(row.lastByEndpoint['/veeam-data'].reason, '개별 토큰 필요');
  assert.equal(row.lastByEndpoint['/veeam-data'].status, 403);
  assert.equal(row.byEndpoint['/veeam-data'], 1);
  IR.resetRejects();
});

test('B-4 엣지 — 토큰을 적용했으면 응답 뒤 Veeam 배정을 곧바로 다시 가져온다(적용 안 됐으면 안 한다)', () => {
  const src = fs.readFileSync(new URL('../src/routes/collector.js', import.meta.url), 'utf8');
  const i = src.indexOf("collectorRouter.post('/central-token'");
  const body = src.slice(i, src.indexOf('\n});', i));
  assert.match(body, /if \(r\.applied\) setImmediate\([^\n]*pullVeeamConfigNow\(\)/);
  assert.ok(body.indexOf('res.status(') < body.indexOf('pullVeeamConfigNow'), '응답을 먼저 보낸다');
});
