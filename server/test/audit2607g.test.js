// v2.607 그룹 g — 서버 쪽 회귀(store.js). 웹 화면 판정은 web/src 의 모듈 옆 *.test.js(vitest)가 고정한다.
//  · WEB2607-05  롤업 vCenter 별 전력: 측정 서버 0대면 powerKw 는 0 이 아니라 null(+ powerServers)
//  · LEFT2607-04 엣지 위임 병합이 collectSource:'rest' 표지를 collectMethod 로 보존
//  · RECENT2607-08 storeStatus.collectMode 는 site/direct 축만, REST 여부는 collectSource 로 따로
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const read = (p) => stripComments(fs.readFileSync(path.join(SRC, p), 'utf8'));

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'a2607g-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';

const snapOf = () => ({
  vcenters: [{ id: 'vc1', status: 'connected' }, { id: 'vc2', status: 'connected' }],
  hosts: [
    { id: 'h1', vcenterId: 'vc1', connectionState: 'CONNECTED', cpuTotalMhz: 1000, cpuUsageMhz: 100, memTotalMB: 1000, memUsageMB: 100, cpuCores: 4, powerWatts: 450 },
    { id: 'h2', vcenterId: 'vc2', connectionState: 'CONNECTED', cpuTotalMhz: 1000, cpuUsageMhz: 100, memTotalMB: 1000, memUsageMB: 100, cpuCores: 4, powerWatts: 550 },
  ],
  vms: [], datastores: [], networks: [], alarms: [],
  // vc1 은 iDRAC 측정 2대(1,200W) · vc2 는 측정 0대
  measuredPower: { totalWatts: 1200, servers: 2, byVc: { vc1: 1200 }, countByVc: { vc1: 2 } },
});

test('WEB2607-05 — 측정 서버 0대인 vCenter 는 powerKw null(0 kW 아님), 측정 있으면 값과 대수', async () => {
  const { scopedRollups } = await import('../src/store.js');
  const r = scopedRollups(snapOf(), new Set(['vc1', 'vc2']));
  const site = (id) => r.sites.find((s) => s.id === id).metrics;
  assert.equal(site('vc2').powerKw, null, '예전: 0 — 호스트 보고 전력 폴백을 가렸다');
  assert.equal(site('vc2').powerServers, 0);
  assert.equal(site('vc1').powerKw, 1.2);
  assert.equal(site('vc1').powerServers, 2);
});

test('WEB2607-05 — measuredPower 가 아예 없으면 null(측정 없음을 0 이라 하지 않는다)', async () => {
  const { scopedRollups } = await import('../src/store.js');
  const s = snapOf(); delete s.measuredPower;
  const r = scopedRollups(s, new Set(['vc1']));
  assert.equal(r.sites.find((x) => x.id === 'vc1').metrics.powerKw, null);
});

test('RECENT2607-08 — storeStatus.collectMode 는 site/direct 만, REST 폴백은 collectSource', async () => {
  const { store, storeStatus } = await import('../src/store.js');
  const prev = store.snapshot;
  try {
    store.snapshot = {
      generatedAt: new Date().toISOString(), hosts: [], vms: [],
      vcenters: [
        { id: 'a', status: 'connected', collectSource: 'rest', restUnknown: ['alarms'], alarmsUnknown: true },
        { id: 'b', status: 'connected', collectSource: 'site', collectMethod: 'rest' },
        { id: 'c', status: 'connected' },
      ],
    };
    const st = storeStatus();
    const by = Object.fromEntries(st.vcenters.map((v) => [v.id, v]));
    assert.equal(by.a.collectMode, 'direct', "예전: 'rest' 가 수집 방식 칸으로 샜다");
    assert.equal(by.a.collectSource, 'rest');
    assert.equal(by.b.collectMode, 'site');
    assert.equal(by.b.collectSource, 'rest');
    assert.equal(by.c.collectMode, 'direct');
    assert.equal(by.c.collectSource, '');
  } finally { store.snapshot = prev; }
});

test('LEFT2607-04 — 엣지 위임 병합은 원래 collectSource(rest)를 collectMethod 로 보존한다', () => {
  const s = read('store.js');
  const i = s.indexOf("collectSource: 'site', collectedBy: inv.agent");
  const j = s.indexOf("collectSource: 'site', ...(siteMethod");
  assert.equal(i, -1, "스프레드 뒤 collectSource:'site' 로만 덮으면 'rest' 표지가 사라진다");
  assert.ok(j > 0, 'collectMethod 보존이 병합 줄에 있다');
  assert.match(s, /siteVc\.collectSource !== 'site' \? siteVc\.collectSource/);
});
