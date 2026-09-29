/**
 * test/cvp2644.test.js — v2.644 CVP 카운터·BGP 수집(실장비 DCS-7010TX · EOS 4.28 · CVP 2023.1.1 캡처에 맞춘 회귀).
 *   ① 카운터: 알려진 세 경로가 전부 빈 응답이면 `/Smash/counters/ethIntf` 의 자식(와일드카드)을 시도한다
 *      · 포트 아래 `statistics` 포인터도 한 단계 더 따라간다(깊이 2)
 *   ② BGP: 표 → VRF → 피어 → 값(깊이 3). 피어 값에 세션 상태가 없어도 피어로 세고 상태는 모름으로 남긴다
 *   ③ 와일드카드 순수 함수(펼치기 · 일치 판정 · '..' 버림)
 * 식별자는 합성했다(v2.513 규약).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvp2644-'));
process.env.SSRF_ALLOW_LOOPBACK = 'true';

const P = await import('../src/cvp/parse.js');
const C = await import('../src/cvp/client.js');

const segs = (s) => s.split('/').filter(Boolean);
const ptrU = (base, k) => ({ key: k, value: { ptr: [...segs(base), k] } });
const note = (p, updates, ts = '1737996752057206753') => ({ timestamp: ts, path_elements: segs(p), updates });
const int = (k, n) => ({ key: k, value: { int: n } });
const EMPTY = '{"notifications":[]}';

function mockCvp(serial, routes) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    const send = (b) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(typeof b === 'string' ? b : JSON.stringify(b)); };
    const raw = new URL(req.url, 'http://x').pathname; hits.push(raw);
    if (raw === '/api/resources/inventory/v1/Device/all') return send(JSON.stringify({ result: { value: { key: { deviceId: serial }, hostname: 'sw-x', streamingStatus: 'STREAMING_STATUS_ACTIVE' } } }));
    const m = new RegExp(`^/api/v1/rest/${serial}(/.*)$`).exec(raw);
    if (!m) return send(EMPTY);
    const rest = m[1].split('/').map((x) => decodeURIComponent(x)).join('/');
    const r = routes(rest);
    return send(r == null ? EMPTY : r);
  });
  return { srv, hits };
}
const collect = (port, partsDue = false) => C.collectCvp({ host: `http://127.0.0.1:${port}`, authMode: 'token', token: 'T', verifyTls: false }, { budgetMs: 30_000, partsDue, prefer: new Map() });

const IS = '/Sysdb/interface/status/eth/phy/slice/1/intfStatus';
const up = (rest) => note(rest, { operStatus: { key: 'operStatus', value: { Name: 'intfOperUp' } }, adminStatus: { key: 'adminStatus', value: { Name: 'intfAdminUp' } }, speed: { key: 'speed', value: { Name: 'speed1Gbps' } } });

test('① 카운터 — 빈 알려진 경로 뒤에 /Smash/counters/ethIntf 자식(와일드카드)을 시도하고 statistics 포인터까지 따라간다', async () => {
  const E = '/Smash/counters/ethIntf';
  const { srv, hits } = mockCvp('SN-K', (rest) => {
    if (rest === IS) return { notifications: [note(IS, { Ethernet1: ptrU(IS, 'Ethernet1') })] };
    if (rest === `${IS}/Ethernet1`) return { notifications: [up(rest)] };
    if (rest === E) return { notifications: [note(E, { StrataCounters: ptrU(E, 'StrataCounters') })] };
    const CC = `${E}/StrataCounters/current/counter`;
    if (rest === CC) return { notifications: [note(CC, { Ethernet1: ptrU(CC, 'Ethernet1') })] };
    if (rest === `${CC}/Ethernet1`) return { notifications: [note(rest, { statistics: ptrU(rest, 'statistics') })] };
    if (rest === `${CC}/Ethernet1/statistics`) return { notifications: [note(rest, { inOctets: int('inOctets', 1000), outOctets: int('outOctets', 2000) })] };
    return null;
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await collect(srv.address().port);
    const d = r.devices.find((x) => x.key === 'SN-K' || x.serial === 'SN-K');
    assert.ok(d.counters, `카운터를 못 읽었다: ${JSON.stringify(r.missing)}`);
    const c = d.counters instanceof Map ? d.counters.get('Ethernet1') : d.counters.Ethernet1;
    assert.equal(c.inOctets, 1000);
    assert.equal(c.outOctets, 2000);
    assert.ok(hits.some((h) => h.endsWith('/Smash/counters/ethIntf')), '부모 경로로 자식을 찾지 않았다');
    assert.ok(String(r.usedPaths?.counters || '').includes('StrataCounters'), JSON.stringify(r.usedPaths));
  } finally { srv.close(); }
});

test('② BGP — 표 → VRF → 피어 → 값(깊이 3), 상태 필드가 없으면 상태는 모름', async () => {
  const T = '/Sysdb/routing/bgp/export/vrfBgpPeerAfiSafiStateTable';
  const { srv } = mockCvp('SN-B', (rest) => {
    if (rest === T) return { notifications: [note(T, { default: ptrU(T, 'default'), Private: ptrU(T, 'Private') })] };
    if (rest === `${T}/default`) return { notifications: [note(rest, { '10.0.0.1': ptrU(rest, '10.0.0.1') })] };
    if (rest === `${T}/Private`) return null; // 피어 없는 VRF(빈 응답)
    if (rest === `${T}/default/10.0.0.1`) return { notifications: [note(rest, { afiSafiState: { key: 'afiSafiState', value: 'afiSafiNegotiated' }, prefixesAccepted: int('prefixesAccepted', 5) })] };
    return null;
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await collect(srv.address().port);
    const d = r.devices.find((x) => x.key === 'SN-B' || x.serial === 'SN-B');
    assert.ok(Array.isArray(d.bgp), `BGP 를 못 읽었다: ${JSON.stringify(r.missing)}`);
    assert.equal(d.bgp.length, 1);
    assert.equal(d.bgp[0].peer, '10.0.0.1');
    assert.equal(d.bgp[0].vrf, 'default');
    assert.equal(d.bgp[0].prefixes, 5);
    assert.equal(P.bgpStateWord(d.bgp[0].state), 'unknown', '상태를 모르는데 established/down 으로 칠했다');
    assert.equal(C.FOLLOW_DEPTH_BY_KIND.bgp, 3);
  } finally { srv.close(); }
  // VRF 이름만 가진 중간 개체는 피어가 아니다
  const mid = JSON.stringify({ notifications: [note('/leaf/x', { vrfName: { key: 'vrfName', value: 'default' } })] });
  assert.equal(P.parseBgp(mid).peers, null);
});

test('③ 와일드카드 펼치기·일치 판정', () => {
  const tpl = '/api/v1/rest/{serial}/Smash/counters/ethIntf/*/current/counter';
  assert.deepEqual(C.expandWildcard(tpl, ['A', '..', 'B c']), ['/api/v1/rest/{serial}/Smash/counters/ethIntf/A/current/counter', '/api/v1/rest/{serial}/Smash/counters/ethIntf/B%20c/current/counter']);
  assert.equal(C.expandWildcard(tpl, Array.from({ length: 20 }, (_, i) => `k${i}`)).length, C.WILDCARD_MAX);
  assert.equal(C.wildcardMatches(tpl, '/api/v1/rest/{serial}/Smash/counters/ethIntf/StrataCounters/current/counter'), true);
  assert.equal(C.wildcardMatches(tpl, '/api/v1/rest/{serial}/Smash/counters/ethIntf/a/b/current/counter'), false);
  assert.deepEqual(C.expandWildcard('/no/wild', ['x']), ['/no/wild']);
});
