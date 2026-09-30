// v2.653 — GPU 표 시안 A: 게스트 값이 빈 이유 판정 · ESXi GPU 메모리·온도 카운터 · 메모리 사용량(MB) 저장 · 호스트 VM 목록.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const { guestWhyOf, GUEST_WHY_CODES, EDGE_REPORT_STALE_MS } = await import('../src/gpu/guestWhy.js');
const { parseHostGpuPerf } = await import('../src/vcenter/soapClient.js');
const { summarizeHostGpu } = await import('../src/gpu/hostGpu.js');

const NOW = 1_800_000_000_000;
const S = (o) => ({ vmsOn: 4, vmsRead: 0, vmsUnread: 4, tempC: null, memUsedMB: null, memUsedPct: null, ...o });

test('① 판정: 켜진 VM 이 없으면 사유 없음 · 다 읽었으면 사유 없음', () => {
  assert.equal(guestWhyOf(S({ vmsOn: 0 }), { mode: 'site' }, { now: NOW }), null);
  assert.equal(guestWhyOf(S({ vmsRead: 4, vmsUnread: 0, tempC: 40, memUsedMB: 10 }), { mode: 'direct' }, { now: NOW }), null);
});

test('② 엣지 경로: 보고 없음 → 멈춤 → 이 vCenter 미설정 → 계정 없음 → 수집 실패 순서', () => {
  const site = (o) => ({ mode: 'site', agent: 'EDGE-WA', ...o });
  assert.equal(guestWhyOf(S(), site({ report: null }), { now: NOW }).code, 'edge-no-report');
  assert.equal(guestWhyOf(S(), { mode: 'site', agent: '' }, { now: NOW }).code, 'edge-no-report');
  const stale = guestWhyOf(S(), site({ report: { receivedAt: NOW - EDGE_REPORT_STALE_MS - 60_000 } }), { now: NOW });
  assert.equal(stale.code, 'edge-stale'); assert.equal(stale.agent, 'EDGE-WA');
  assert.equal(guestWhyOf(S(), site({ report: { receivedAt: NOW }, diagVc: null }), { now: NOW }).code, 'edge-no-config');
  assert.equal(guestWhyOf(S(), site({ report: { receivedAt: NOW }, diagVc: { stage: '수집 대상 계정 없음' } }), { now: NOW }).code, 'no-creds');
  const f = guestWhyOf(S(), site({ report: { receivedAt: NOW }, diagVc: { stage: 'vCenter 로그인 실패', error: 'InvalidLogin' } }), { now: NOW });
  assert.equal(f.code, 'collect-failed'); assert.equal(f.detail, 'InvalidLogin');
  const r = guestWhyOf(S(), site({ report: { receivedAt: NOW }, diagVc: { stage: '완료', results: [{ ok: false, error: 'SSH timeout' }] } }), { now: NOW });
  assert.equal(r.code, 'collect-failed'); assert.equal(r.detail, 'SSH timeout');
  assert.equal(guestWhyOf(S(), site({ report: { receivedAt: NOW }, diagVc: { stage: '완료', results: [] } }), { now: NOW }).code, 'unknown');
});

test('③ 중앙 직접: 수집 꺼짐 · 일부만 · 엣지 구버전(온도·메모리 없음)', () => {
  assert.equal(guestWhyOf(S(), { mode: 'direct', enabled: false }, { now: NOW }).code, 'not-enabled');
  const p = guestWhyOf(S({ vmsRead: 1, vmsUnread: 3, tempC: 30 }), { mode: 'direct', enabled: true }, { now: NOW });
  assert.deepEqual([p.code, p.detail], ['partial', '1/4']);
  const old = guestWhyOf(S({ vmsRead: 4, vmsUnread: 0 }), { mode: 'site', agent: 'E', edgeVersion: '2.648.0', report: { receivedAt: NOW } }, { now: NOW });
  assert.equal(old.code, 'edge-old');
  // 2.650 이상이면 구버전이 아니다(값이 없을 뿐 — 읽은 VM 은 있다)
  assert.equal(guestWhyOf(S({ vmsRead: 4, vmsUnread: 0 }), { mode: 'site', agent: 'E', edgeVersion: '2.650.0' }, { now: NOW }), null);
  // 버전을 모르면 단정하지 않는다
  assert.equal(guestWhyOf(S({ vmsRead: 4, vmsUnread: 0 }), { mode: 'site', agent: 'E', edgeVersion: null }, { now: NOW }), null);
});

test('④ 코드 ↔ 웹 문구 1:1', () => {
  const web = fs.readFileSync(path.join(HERE, '..', '..', 'web', 'src', 'views', 'tools', 'gpuWhyText.js'), 'utf8');
  for (const c of GUEST_WHY_CODES) assert.ok(web.includes(`'${c}'`) || web.includes(`${c}:`), `웹 문구 없음: ${c}`);
});

test('⑤ ESXi GPU 카운터 파서: 인스턴스 평균·합·최대, -1 제외, 합계 인스턴스("") 제외', () => {
  const keyOf = new Map([['101', 'util'], ['102', 'memPct'], ['103', 'memUsedKB'], ['104', 'tempC']]);
  const ser = (cid, inst, vals) => `<value xsi:type="PerfMetricIntSeries"><id><counterId>${cid}</counterId><instance>${inst}</instance></id>${vals.map((v) => `<value>${v}</value>`).join('')}</value>`;
  const xml = `<returnval><entity type="HostSystem">host-1</entity>${ser(101, 'gpu0', [1000, 3000])}${ser(101, 'gpu1', [5000])}${ser(102, 'gpu0', [4000])}${ser(102, 'gpu1', [6000])}${ser(103, 'gpu0', [1048576])}${ser(103, 'gpu1', [2097152])}${ser(103, '', [9999999])}${ser(104, 'gpu0', [61])}${ser(104, 'gpu1', [-1])}</returnval>`
    + `<returnval><entity type="HostSystem">host-2</entity>${ser(104, 'gpu0', [-1])}</returnval>`;
  const m = parseHostGpuPerf(xml, keyOf);
  assert.deepEqual(m.get('host-1'), { util: 40, memPct: 50, memUsedKB: 3145728, tempC: 61 });
  assert.equal(m.has('host-2'), false, '값이 전부 -1 이면 기록하지 않는다(0 으로 채우지 않는다)');
});

test('⑥ summarizeHostGpu: 게스트 값이 없으면 ESXi 값 + 출처, 게스트가 있으면 게스트가 먼저', () => {
  const host = { name: 'esx', gpus: [{ model: 'A40', memGB: 45, mode: 'vgpu' }], gpuTempC: 55, gpuMemUsedMB: 9216, gpuMemUsedPct: 20 };
  const vms = [{ id: 'v1', powerState: 'POWERED_ON', gpu: { type: 'vgpu', count: 1, vgpu: 1, profile: 'nvidia_a40-12q' } }];
  const s = summarizeHostGpu(host, vms, new Map());
  assert.equal(s.tempC, 55); assert.equal(s.tempSource, 'esxi');
  assert.equal(s.memUsedMB, 9216); assert.equal(s.memTotalMB, 46080); assert.equal(s.memUsedPct, 20); assert.equal(s.memSource, 'esxi');
  const g = summarizeHostGpu(host, vms, new Map([['v1', { utilPct: 50, memUsedMB: 1024, memTotalMB: 12288, tempC: 44 }]]));
  assert.equal(g.tempC, 44); assert.equal(g.tempSource, 'guest'); assert.equal(g.memSource, 'guest'); assert.equal(g.memUsedMB, 1024);
  const none = summarizeHostGpu({ name: 'x', gpus: host.gpus }, vms, new Map());
  assert.equal(none.tempC, null); assert.equal(none.memUsedMB, null); assert.equal(none.memSource, null);
});

test('⑦ 저장: 메모리 사용량(MB) 계열 + ESXi 호스트 온도·메모리 · 중앙 수신 수치 필드 · 추이 API memmb', () => {
  const smp = stripComments(fs.readFileSync(path.join(SRC, 'metrics/sampler.js'), 'utf8'));
  for (const m of ['gpu_vm_mem_mb', 'gpu_mem_mb']) assert.match(smp, new RegExp(`'${m}'`));
  assert.match(smp, /h\.gpuTempC/); assert.match(smp, /h\.gpuMemUsedPct/);
  const cen = fs.readFileSync(path.join(SRC, 'routes/central.js'), 'utf8');
  for (const k of ['gpuMemUsedPct', 'gpuMemUsedMB', 'gpuTempC']) assert.match(cen, new RegExp(`'${k}'`));
  const an = stripComments(fs.readFileSync(path.join(SRC, 'routes/api/toolsAnalytics.js'), 'utf8'));
  assert.match(an, /memmb: 'gpu_mem_mb'/); assert.match(an, /memmb: 'gpu_vm_mem_mb'/);
});

test('⑧ 실제 api 라우터: /tools/gpu 가 guestWhy·호스트 VM 목록·ESXi 출처를 싣는다', async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { store } = await import('../src/store.js');
  const gstore = await import('../src/gpu/store.js');
  const prev = store.snapshot;
  store.snapshot = {
    ...(prev || {}), source: 'vcenter', generatedAt: new Date().toISOString(),
    vcenters: [{ id: 'vc-e', collectedBy: 'EDGE-X' }],
    hosts: [{ id: 'he', name: 'esx-e', vcenterId: 'vc-e', connectionState: 'CONNECTED', gpuUtilPct: 0, gpuTempC: 48, gpus: [{ model: 'A40', memGB: 45, mode: 'vgpu' }] }],
    vms: [{ id: 've', name: 'vdi-1', vcenterId: 'vc-e', host: 'esx-e', powerState: 'POWERED_ON', gpu: { type: 'vgpu', count: 1, vgpu: 1, passthrough: 0, profile: 'nvidia_a40-12q' } }],
    datastores: [], networks: [], alarms: [],
  };
  gstore._resetGuestGpuForTest();
  const app = express(); app.use((req, _r, n) => { req.user = { username: 'u', role: 'admin', scope: null }; n(); }); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/tools/gpu`);
    const b = await r.json();
    const row = b.items.find((x) => x.id === 'he');
    assert.equal(row.tempC, 48); assert.equal(row.tempSource, 'esxi');
    assert.equal(row.vms.length, 1); assert.equal(row.vms[0].name, 'vdi-1'); assert.equal(row.vms[0].activity, 'unknown');
    assert.ok(row.guestWhy && GUEST_WHY_CODES.includes(row.guestWhy.code), `사유 코드: ${JSON.stringify(row.guestWhy)}`);
    assert.ok(Array.isArray(b.guestWhy) && b.guestWhy.length === 1 && b.guestWhy[0].hosts === 1);
    assert.ok(b.guestWhy[0].missing && typeof b.guestWhy[0].missing.all === 'number', 'v2.657: 배너에 무엇을 못 읽었나(missing)를 싣는다');
  } finally { srv.close(); store.snapshot = prev; gstore._resetGuestGpuForTest(); }
});

test('⑨ 목 데이터: vSGA 가 아닌 GPU 호스트는 전부 GPU VM 을 갖고, 데모 게스트 수집은 설정 없이도 돈다', async () => {
  const { generateSnapshot } = await import('../src/mock/generator.js');
  const s = await generateSnapshot();
  const g = s.hosts.filter((h) => (h.gpus || []).length && h.gpus[0].mode !== 'vsga');
  const empty = g.filter((h) => !s.vms.some((v) => v.host === h.name && v.vcenterId === h.vcenterId && v.gpu));
  assert.equal(empty.length, 0, `GPU VM 0대 호스트: ${empty.map((h) => h.name).join(', ')}`);
  assert.ok(s.vms.filter((v) => v.template && v.gpu).length === 0, '템플릿은 GPU 를 받지 않는다');
  const src = stripComments(fs.readFileSync(path.join(SRC, 'gpu/poller.js'), 'utf8'));
  assert.match(src, /const demoAll = mock &&/);
  assert.match(src, /return \{ hosts, vms, diag \}/, '데모도 수집 진단을 낸다(이유 칩)');
  const hw = stripComments(fs.readFileSync(path.join(SRC, 'routes/api/hardwareGpu.js'), 'utf8'));
  assert.match(hw, /snap\.source === 'mock' \? null/, "데모에서 '수집 꺼짐' 이라 말하지 않는다");
});
