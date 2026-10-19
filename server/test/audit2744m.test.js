/**
 * v2.744 리드 후속 그룹 FC — ① 호스트·VM 구성 점검도 '읽지 못한 vCenter' 를 0 으로 섞지 않는다(VC-03 의 형제)
 *   ② 엣지 iDRAC 등록부 손상 상태(EDGE-01·03 이 만든 상태 필드)가 화면까지 가는가.
 *
 * ① 은 실제 api 라우터(express 마운트)로 본다 — 첫 수집 중(pending)·불통(직전 값 없음 — store.js 가 인벤토리를 비운다) vCenter 는
 *    스냅샷에 호스트·VM 이 0개라 판정 결과 어디에도 나타나지 않았고, 화면은 읽은 vCenter 만의 결과를 전체 결과처럼 말했다.
 *    판정은 corelicense/analyze.js notReadVcentersOf 한 벌(복제하지 않는다)이고 응답에 notReadVcenters·partial 을 싣는다.
 * ② 는 실제 함수로 본다 — 중앙 fleetPartialsSummary 가 싣는 registryUnreadable 을 웹 문구 모듈이 그대로 말하는지(서버 출력 → 웹 함수),
 *    엣지 fleet push 의 상태(registryUnreadable·statusOnlyReason)가 엣지 로그 진행상태(collectStatus)에 가림 없이 실리는지.
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744m-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'true';
delete process.env.CENTRAL_URL;
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

// 기준 시각은 경계에서 떨어뜨려 고정한다(Date.now() 를 기준으로 쓰지 않는다 — 루트 CLAUDE.md 규약).
const T0 = Date.UTC(2026, 9, 19, 3, 30, 0);

// vc-a 만 읽었다. vc-u 는 불통 + 직전 값 없음(store.js 가 인벤토리를 비운 모양), vc-p 는 첫 수집 중, vc-o 는 비활성.
const hosts = [1, 2].map((i) => ({
  id: `vc-a:host-${i}`, vcenterId: 'vc-a', name: `esx-a${i}`, cluster: 'C1', connectionState: 'CONNECTED', version: '8.0.2', build: '1',
  hcfg: { at: T0, ntpServers: [], syslogHost: '', ssh: { running: true, policy: 'on' } },
}));
const vms = [1, 2, 3].map((i) => ({
  id: `vc-a:vm-${i}`, vcenterId: 'vc-a', name: `app-a${i}`, powerState: 'POWERED_ON', host: 'esx-a1', cluster: 'C1',
  snapshotCount: 0, toolsVersionStatus: 'guestToolsNotInstalled', cfg: { at: T0 }, dev: { at: T0 },
}));
const snap = {
  source: 'live', generatedAt: '2026-10-19T03:30:00.000Z',
  vcenters: [
    { id: 'vc-a', name: 'VC-A', status: 'connected' },
    { id: 'vc-u', name: 'VC-U', status: 'unreachable' },
    { id: 'vc-p', name: 'VC-P', status: 'pending' },
    { id: 'vc-o', name: 'VC-O', status: 'disabled' },
  ],
  hosts, vms, datastores: [], networks: [], alarms: [],
};

let base;
before(async () => {
  const { store } = await import('../src/store.js');
  store.snapshot = { ...(store.get() || {}), ...snap };
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    let scope = null; try { scope = req.get('x-scope') ? JSON.parse(req.get('x-scope')) : null; } catch { scope = null; }
    req.user = { username: 'adm', role: 'admin', scope }; next();
  });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  base = `http://127.0.0.1:${srv.address().port}`;
});

const getJson = async (p, h = {}) => {
  const r = await fetch(base + p, { headers: h });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, j };
};

// ─────────────────── ① 호스트·VM 구성 점검 — 읽지 못한 vCenter ───────────────────
test('① 호스트·VM 구성 점검(실제 라우터): 읽지 못한 vCenter 를 notReadVcenters 로 밝히고 partial 을 싣는다 — 비활성은 partial 이 아니다', async () => {
  for (const p of ['/api/tools/host-hygiene', '/api/tools/vm-hygiene']) {
    const r = await getJson(p);
    assert.equal(r.status, 200, `${p} ${r.status}`);
    const ids = (r.j.notReadVcenters || []).map((x) => `${x.vcenterId}:${x.why}`).sort();
    assert.deepEqual(ids, ['vc-o:disabled', 'vc-p:pending', 'vc-u:unreachable'], `${p} 읽지 못한 vCenter 가 응답에 없다: ${JSON.stringify(r.j.notReadVcenters)}`);
    assert.equal(r.j.partial, true, `${p}: 읽지 못한 vCenter 가 있는데 결과를 전체라 말했다`);
    // 판정은 읽은 vCenter 의 값으로 그대로 한다(빼거나 지어내지 않는다).
    assert.ok(Array.isArray(r.j.rows) && r.j.rows.length > 0, `${p} 읽은 vCenter 의 판정이 사라졌다`);
  }
  // 비활성만 빠졌으면 partial 이 아니다(관리자가 끈 것 — notReadPartialOf 규칙 그대로).
  const { store } = await import('../src/store.js');
  const prev = store.snapshot;
  try {
    store.snapshot = { ...prev, generatedAt: '2026-10-19T03:31:00.000Z', vcenters: snap.vcenters.filter((v) => v.id === 'vc-a' || v.id === 'vc-o') };
    for (const p of ['/api/tools/host-hygiene', '/api/tools/vm-hygiene']) {
      const r = await getJson(p);
      assert.equal(r.status, 200);
      assert.deepEqual((r.j.notReadVcenters || []).map((x) => x.vcenterId), ['vc-o'], p);
      assert.equal(r.j.partial, false, `${p}: 비활성만 빠졌는데 하한이라 말했다`);
    }
  } finally { store.snapshot = prev; }
});

test('① 범위 계정에는 범위 안의 읽지 못한 vCenter 만 싣는다 · CSV 는 마지막 줄에 밝힌다', async () => {
  for (const p of ['/api/tools/host-hygiene', '/api/tools/vm-hygiene']) {
    const sc = await getJson(p, { 'x-scope': JSON.stringify({ vcenters: ['vc-a', 'vc-u'] }) });
    assert.equal(sc.status, 200);
    assert.deepEqual((sc.j.notReadVcenters || []).map((x) => x.vcenterId), ['vc-u'], `${p} 범위 밖 vCenter 가 실렸다: ${JSON.stringify(sc.j.notReadVcenters)}`);
    // vCenter 를 하나 고르면 그 vCenter 만 본다(scopeSlice 와 같은 기준).
    const one = await getJson(`${p}?vcenterId=vc-a`);
    assert.deepEqual(one.j.notReadVcenters, [], `${p} 고른 vCenter 밖의 것을 실었다`);
    assert.equal(one.j.partial, false);
  }
  for (const p of ['/api/tools/host-hygiene.csv', '/api/tools/vm-hygiene.csv']) {
    const csv = await fetch(`${base}${p}`).then((x) => x.text());
    assert.match(csv, /읽지 못한 vCenter 3곳/, `${p} 파일만 받은 사람이 결과가 일부임을 모른다`);
    assert.match(csv, /VC-U\(unreachable\)/);
  }
});

// ─────────────────── ② 엣지 등록부 손상 상태가 화면까지 ───────────────────
test('② 중앙 fleetPartialsSummary 의 registryUnreadable 을 웹 문구가 그대로 말한다(서버 출력 → 웹 함수)', async () => {
  const cf = await import('../src/central/fleet.js');
  const { fleetHeldNote, fleetHeldBadge, fleetPartialsNote } = await import('../../web/src/views/fleetPartialText.js');
  cf.resetEdgeFleet();
  cf.setEdgeFleet('edge-x', [{ fleetId: 'f1', name: 'bm-1', serviceTag: 'ST1' }], T0, { verified: true });
  cf.setEdgeFleet('edge-y', [{ fleetId: 'f2', name: 'bm-2', serviceTag: 'ST2' }], T0, { verified: true });
  const now = Date.now();
  const h = cf.holdEdgeFleet('edge-x', { registryUnreadable: { at: now, reason: '형식 오류' }, now });
  assert.equal(h.kept, 1);
  const fp = cf.fleetPartialsSummary();
  assert.equal(fp.registryUnreadableEdges, 1, JSON.stringify(fp));
  const note = fleetHeldNote(fp);
  assert.match(note, /edge-x/, note);
  assert.match(note, /형식 오류/, '서버가 준 사유를 그대로 말한다');
  assert.match(note, /직전 목록/);
  assert.ok(!/edge-y/.test(note), '읽지 못함이 아닌 엣지를 지목하지 않는다');
  const b = fleetHeldBadge(fp, 'edge-x');
  assert.ok(b && b.text && b.title, JSON.stringify(b));
  assert.equal(fleetHeldBadge(fp, 'edge-y'), null);
  // 보류 시한이 지나면 문구가 '곧 빠진다' 를 말한다.
  const late = cf.holdEdgeFleet('edge-x', { registryUnreadable: { at: now, reason: '형식 오류' }, now: now + cf.UNREADABLE_HOLD_MS + 60_000 });
  assert.equal(late.holdExpired, true);
  assert.match(fleetHeldNote(cf.fleetPartialsSummary()), /시한/);
  // 부분 목록 문구(v2.607)는 보류를 '일부 목록' 으로 섞어 말하지 않는다 — 두 사실은 조치가 다르다.
  assert.equal(fleetPartialsNote(cf.fleetPartialsSummary()), '');
  cf.resetEdgeFleet();
});

test('② 엣지 fleet push 의 등록부 손상 상태(registryUnreadable·statusOnlyReason)가 엣지 로그 진행상태에 가림 없이 실린다', async () => {
  const { config } = await import('../src/config.js');
  const fp = await import('../src/agent/fleetPush.js');
  const registry = await import('../src/idrac/registry.js');
  const { collectStatus } = await import('../src/edgelog/collect.js');
  const { STATUS_SPEC } = await import('../src/edgelog/spec.js');
  const { redactDeep, isSecretKey } = await import('../src/edgelog/redact.js');
  const prev = { url: config.agent.centralUrl, name: config.agent.name };
  try {
    config.agent.centralUrl = 'http://127.0.0.1:9'; config.agent.name = 'edge-fc2744';
    // 구버전 중앙(상태 전용 보고를 모름) — 네트워크로 나가지 않는다.
    fp._setFleetStatusOnlySupportForTest(() => ({ ok: false, reason: 'old-central', text: '중앙 2.743.0 은 상태 전용 보고를 모릅니다' }));
    fs.writeFileSync(path.join(DIR, 'idrac.json'), '{"servers": [ 손상');
    assert.ok(registry.registryLoadError());
    const r = await fp.pushFleetNow();
    assert.equal(r.registryUnreadable, true, JSON.stringify(r));
    const st = await collectStatus();
    const item = st.items.find((x) => x.key === 'push.fleet');
    assert.ok(item && item.ok, `push.fleet 진행상태를 읽지 못했다: ${JSON.stringify(item)}`);
    assert.ok(item.value?.last?.registryUnreadable?.reason, `등록부 손상 사유가 실리지 않았다: ${JSON.stringify(item.value)}`);
    assert.equal(item.value.last.statusOnlyReason, 'old-central');
    assert.match(String(item.value.last.note || ''), /idrac\.json/);
  } finally {
    fp._setFleetStatusOnlySupportForTest(null);
    config.agent.centralUrl = prev.url; config.agent.name = prev.name;
    try { fs.rmSync(path.join(DIR, 'idrac.json'), { force: true }); } catch { /* */ }
  }
  // 나머지 상태 필드(iDRAC 스캔 registerError · 설정 pull registryRecovered)도 표가 그 상태 함수를 싣고 가림이 지우지 않는다.
  const fns = new Map(STATUS_SPEC.map((s) => [s.key, s.fn]));
  for (const [k, fn] of [['collect.idracScan', 'getIdracScanWorkerStatus'], ['collect.idracScanLocal', 'idracScanStatus'], ['collect.agentScan', 'getAgentScanStatus'],
    ['pull.storage', 'storageConfigPullStatus'], ['pull.sanswitch', 'sanSwitchConfigPullStatus'], ['pull.pdu', 'pduConfigPullStatus'], ['pull.cvp', 'cvpConfigPullStatus'], ['push.fleet', 'fleetPushStatus']]) {
    assert.equal(fns.get(k), fn, `엣지 로그 표에 ${k} 가 없다`);
  }
  for (const key of ['registryUnreadable', 'statusOnlyReason', 'registerError', 'registryRecovered', 'note', 'reason']) assert.equal(isSecretKey(key), false, key);
  const sample = { last: { registerError: '등록부 읽기 실패', registryUnreadable: { at: T0, reason: 'x' } }, registryRecovered: { at: T0, lostAt: T0, reason: 'x', restored: 3, note: '다시 썼습니다' } };
  const { value, masked } = redactDeep(sample);
  assert.equal(masked, 0);
  assert.deepEqual(value, sample);
});
