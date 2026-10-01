// v2.676 — 호스트 상세 '통합 성능 모니터링'(ESXi 호스트 → iDRAC 서버 복합 매칭) + GPU 카드 모델·장수 + '서비스' 표기.
// 순수 판정(idrac/serverForHost.js)을 규칙마다 고정하고, 실제 admin 라우터를 띄워 resolve-host 응답을 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idraclink2676-'));
process.env.CONFIG_DIR = DIR;
process.env.TEMP_DB_PATH = path.join(DIR, 'host-temp.db');
process.env.IDRAC_DB_PATH = path.join(DIR, 'idrac-power.db');
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'mock';

const { resolveServerForHost, gpuCardsOf, macKey, serverKeys, hostKeys } = await import('../src/idrac/serverForHost.js');

const HOST = { id: 'host-1', name: 'esx01.corp.example.com', vcenterId: 'vc-a', serviceTag: 'ABC1234', mgmtIp: '10.1.1.11',
  nics: [{ device: 'vmnic0', mac: '00:11:22:33:44:55' }] };

test('① 규칙 넷이 모두 같은 서버 — 연결 · 근거 4개 · 확실', () => {
  const s = { id: 's1', name: 'esx01', serviceTag: 'abc1234', host: '10.9.9.9', hostNames: ['10.1.1.11'] };
  const inv = { nics: [{ ports: [{ mac: '00-11-22-33-44-55' }] }] };
  const r = resolveServerForHost(HOST, [s, { id: 's2', name: 'other' }], { invOf: (x) => (x.id === 's1' ? inv : null) });
  assert.equal(r.serverId, 's1');
  assert.deepEqual(r.matchedBy, ['serviceTag', 'hostname', 'ip', 'mac']);
  assert.equal(r.confidence, 'high');
  assert.equal(r.reason, 'ok');
  assert.equal(r.rules.mac.value, '00:11:22:33:44:55');
});

test('② BMC 주소(s.host)는 ESXi IP 와 비교하지 않는다 — IP 는 OS 쪽 이름에서만', () => {
  const bmcSame = { id: 'b', name: 'idrac-x', host: '10.1.1.11' };
  const r = resolveServerForHost(HOST, [bmcSame]);
  assert.equal(r.serverId, null);
  assert.equal(r.reason, 'no-match');
  assert.equal(r.rules.ip.state, 'none');
});

test('③ 호스트네임 하나뿐이면 연결하되 근거 1개(medium) · IP 를 짧은 이름으로 줄이지 않는다', () => {
  const r = resolveServerForHost({ ...HOST, serviceTag: '', nics: [], mgmtIp: '' }, [{ id: 'n', name: 'ESX01.other.local' }]);
  assert.equal(r.serverId, 'n'); assert.equal(r.confidence, 'medium'); assert.deepEqual(r.matchedBy, ['hostname']);
  // 호스트 이름이 IP 면 '10' 으로 줄여 10.x 서버 전부와 맞추지 않는다(v2.628 C2628-01).
  const ipHost = { id: 'h', name: '10.20.1.11', vcenterId: 'vc-a' };
  const r2 = resolveServerForHost(ipHost, [{ id: 'x', name: '10.20.9.9' }, { id: 'y', name: '10.20.1.11' }]);
  assert.equal(r2.rules.hostname.state, 'no-key');
  assert.equal(r2.serverId, 'y'); assert.deepEqual(r2.matchedBy, ['ip']);
});

test('④ 같은 이름 서버 둘 — 판정하지 않음 · 이 호스트 vCenter 에 귀속된 하나면 좁힌다', () => {
  const h = { ...HOST, serviceTag: '', nics: [], mgmtIp: '' };
  const two = [{ id: 'a', name: 'esx01', vcenterId: 'vc-a' }, { id: 'b', name: 'esx01', vcenterId: 'vc-b' }];
  const r = resolveServerForHost(h, two, { vcOf: (s) => s.vcenterId });
  assert.equal(r.serverId, 'a'); assert.equal(r.rules.hostname.narrowedBy, 'vcenter');
  const r2 = resolveServerForHost(h, two.map((s) => ({ ...s, vcenterId: 'vc-z' })), { vcOf: (s) => s.vcenterId });
  assert.equal(r2.serverId, null); assert.equal(r2.reason, 'ambiguous'); assert.equal(r2.candidates.length, 2);
});

test('⑤ 규칙이 서로 다른 서버를 가리키면 — 태그가 있으면 태그 + conflicts, 없으면 연결하지 않음', () => {
  const s1 = { id: 't', name: 'zzz', serviceTag: 'ABC1234' };
  const s2 = { id: 'n', name: 'esx01' };
  const r = resolveServerForHost(HOST, [s1, s2]);
  assert.equal(r.serverId, 't'); assert.deepEqual(r.conflicts, ['hostname']); assert.equal(r.reason, 'conflict-tag-wins');
  const r2 = resolveServerForHost({ ...HOST, serviceTag: '' }, [{ id: 'n', name: 'esx01' }, { id: 'i', name: 'q', hostNames: ['10.1.1.11'] }]);
  assert.equal(r2.serverId, null); assert.equal(r2.reason, 'conflict');
});

test('⑥ MAC 정규화 — 표기 무관, 전부 0·F·자리 부족은 근거 아님 · 키 추출', () => {
  assert.equal(macKey('00:11:22:AA:bb:CC'), macKey('0011.22aa.bbcc'));
  assert.equal(macKey('00:00:00:00:00:00'), ''); assert.equal(macKey('ff:ff:ff:ff:ff:ff'), ''); assert.equal(macKey('00:11'), '');
  const k = serverKeys({ name: 'srv01.dom', hostNames: ['10.0.0.5', 'alias'] }, { system: { hostName: 'SRV01', serviceTag: 'q1' } });
  assert.equal(k.tag, 'q1'); assert.ok(k.shorts.has('srv01') && k.shorts.has('alias')); assert.ok(k.ips.has('10.0.0.5')); assert.ok(!k.shorts.has('10'));
  assert.deepEqual([...hostKeys({ name: '10.0.0.5', mgmtIp: '010.0.0.5' }).ips], ['10.0.0.5'], '비정규 IP 표기는 근거 아님');
});

test('⑦ GPU 카드 요약 — 모델별 장수 · 모드 · 모르면 null · 0장은 []', () => {
  const g = gpuCardsOf([{ model: 'NVIDIA A40', mode: 'vgpu' }, { model: 'NVIDIA A40', mode: 'vgpu' }, { model: 'NVIDIA L4', mode: 'passthrough' }]);
  assert.deepEqual(g, { cards: [{ model: 'NVIDIA A40', count: 2, modes: ['vgpu'] }, { model: 'NVIDIA L4', count: 1, modes: ['passthrough'] }], total: 3 });
  assert.equal(gpuCardsOf(undefined), null);
  assert.deepEqual(gpuCardsOf([]), { cards: [], total: 0 });
  assert.equal(gpuCardsOf([{ name: 'GPU.Slot.1' }]).cards[0].model, 'GPU.Slot.1');
});

test('⑧ 라우트 — resolve-host 연결 · 없는 호스트 404 · 추이 응답 gpuCards · CSV 머리글 서비스', async () => {
  const { store } = await import('../src/store.js');
  await store.refresh();
  const hosts = store.get().hosts || [];
  assert.ok(hosts.length > 0, '목 호스트');
  const h = hosts.find((x) => Array.isArray(x.gpus) && x.gpus.length) || hosts[0];
  const { addServer } = await import('../src/idrac/registry.js');
  addServer({ id: 'link-1', name: String(h.name).split('.')[0].toUpperCase(), host: '10.250.0.9', username: 'root', password: 'x' });
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express(); app.use(express.json()); app.use('/api/admin', adminRouter);
  const srv = app.listen(0); await new Promise((ok) => srv.once('listening', ok));
  const base = `http://127.0.0.1:${srv.address().port}/api/admin`;
  try {
    const r = await (await fetch(`${base}/idrac/trend/resolve-host?hostId=${encodeURIComponent(h.id)}`)).json();
    assert.equal(r.ok, true);
    assert.equal(r.serverId, 'link-1', JSON.stringify(r.rules));
    assert.ok(r.matchedBy.includes('hostname'));
    assert.equal(r.reverse?.same, true, '거꾸로 찾아도 같은 호스트');
    assert.equal((await fetch(`${base}/idrac/trend/resolve-host?hostId=nope`)).status, 404);
    const t = await (await fetch(`${base}/idrac/link-1/trend?range=1h`)).json();
    assert.ok(t.gpuCards && 'esxi' in t.gpuCards && 'idrac' in t.gpuCards);
    if (Array.isArray(h.gpus) && h.gpus.length) assert.equal(t.gpuCards.esxi.total, h.gpus.length);
    const csv = await (await fetch(`${base}/idrac/trend/export.csv?scope=server&id=link-1&range=1h`)).text();
    assert.match(csv.replace(/^﻿/, ''), /^법인,서비스,서버,서비스태그/);
  } finally { srv.close(); }
});
