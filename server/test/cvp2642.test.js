/**
 * test/cvp2642.test.js — v2.642 CVP 2023.1.1 실장비 응답 모양(사용자가 원문 표본을 펼친 캡처로 확인).
 *   ① 포인터는 `{"ptr":["Sysdb",…,"Ethernet1"]}` **배열**이다(v2.641 은 `{"_ptr":"/…"}` 문자열만 알아 한 번도 따라가지 못했다)
 *   ② 값은 형식 표지로 감싸여 온다 — `{"int":4056276992}`(벗기지 않으면 meminfo 가 '.int' 필드뿐이라 memTotal 을 못 찾았다)
 *   ③ 키가 객체일 수 있다 — `{"key":{"int":1}}`
 *   ④ 같은 경로가 시각이 다른 notification 여러 개로 나뉘어 온다 — 합치되 나중 값이 이긴다
 *   ⑤ 포인터 조각은 조각 그대로 URL 에 붙인다('Ethernet3/1' 이 둘로 갈라지지 않게)
 * 원문 값(메모리 바이트 수)은 캡처의 형식만 옮기고 식별자는 합성했다(v2.513 규약).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvp2642-'));
process.env.SSRF_ALLOW_LOOPBACK = 'true';

const P = await import('../src/cvp/parse.js');
const C = await import('../src/cvp/client.js');

const segs = (s) => s.split('/').filter(Boolean);
const ptrU = (base, k) => ({ key: k, value: { ptr: [...segs(base), k] } });
const note = (p, updates, ts = '1737996752057206753') => ({ timestamp: ts, path_elements: segs(p), updates });
const int = (k, n) => ({ key: k, value: { int: n } });

test('① ptr 배열 포인터를 인식하고 조각을 보존한다', () => {
  const IS = '/Sysdb/interface/status/eth/phy/slice/1/intfStatus';
  const body = JSON.stringify({ notifications: [note(IS, { Ethernet1: ptrU(IS, 'Ethernet1'), 'Ethernet3/1': ptrU(IS, 'Ethernet3/1') })] });
  const sh = P.telemetryShape(body);
  assert.equal(sh.ptrs.length, 2);
  const e31 = sh.ptrs.find((x) => x.key === 'Ethernet3/1');
  assert.deepEqual(e31.segs.slice(-1), ['Ethernet3/1']);
  assert.equal(C.childPath('SN1', '/x', e31.key, e31.ptr, e31.segs), '/api/v1/rest/SN1/Sysdb/interface/status/eth/phy/slice/1/intfStatus/Ethernet3%2F1');
  // 포인터만 있는 응답은 개체가 아니다(없는 포트를 지어내지 않는다)
  assert.equal(P.parseInterfaces(body).ports, null);
  // 문자열 형태(`_ptr`)도 계속 받는다
  assert.equal(P.telemetryShape(JSON.stringify({ notifications: [note('/t', { a: { key: 'a', value: { _ptr: '/t/a' } } })] })).ptrs.length, 1);
});

test('② ③ ④ meminfo — 형식 표지 벗김 · 여러 notification 합침(나중 값 우선) → 사용률', () => {
  const MI = '/Kernel/proc/meminfo';
  const body = JSON.stringify({ notifications: [
    note(MI, { memTotal: int('memTotal', 4_056_276_992), memFree: int('memFree', 999), name: { key: 'name', value: 'meminfo' } }, '1702278189966220270'),
    note(MI, { memAvailable: int('memAvailable', 2_046_578_688), memFree: int('memFree', 130_330_624) }, '1790642722491115269'),
    note(MI, { memFree: int('memFree', 1) }, '1700000000000000000'), // 더 오래된 값 — 나중 값을 덮으면 안 된다
  ] });
  const r = P.parseMemory(body);
  assert.equal(r.total, 4_056_276_992);
  assert.equal(r.pct, Math.round(((4_056_276_992 - 2_046_578_688) / 4_056_276_992) * 1000) / 10);
  const { entities } = P.entitiesOf(body);
  assert.equal(entities.get('meminfo').memFree, 130_330_624);
  assert.equal(P.unwrap({ int: 0 }), 0); // 0 도 값이다
  assert.equal(P.unwrap({ float: 1.5 }), 1.5);
});

test('③ 객체 키 {"key":{"int":1}} 는 문자열 키가 된다', () => {
  assert.equal(P.updKey({ key: { int: 1022 }, value: {} }, 'x'), '1022');
  assert.equal(P.updKey({ key: 'Ethernet1' }, 'x'), 'Ethernet1');
  const body = JSON.stringify({ notifications: [note('/Kernel/proc/stat', { 1: { key: { int: 1 }, value: { ptr: ['Kernel', 'proc', 'stat', '1'] } } })] });
  assert.equal(P.telemetryShape(body).ptrs[0].key, '1');
});

test('⑤ 수집 — ptr 배열을 따라가 포트·BGP 피어를 읽고, /Kernel/proc/stat 는 CPU 후보가 아니다', async () => {
  const IS = '/Sysdb/interface/status/eth/phy/slice/1/intfStatus';
  const BG = '/Sysdb/routing/bgp/export/vrfBgpPeerAfiSafiStateTable';
  const hits = [];
  const srv = http.createServer((req, res) => {
    const send = (b) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(typeof b === 'string' ? b : JSON.stringify(b)); };
    const raw = new URL(req.url, 'http://x').pathname; hits.push(raw);
    if (raw === '/api/resources/inventory/v1/Device/all') return send(JSON.stringify({ result: { value: { key: { deviceId: 'SN-A' }, hostname: 'sw-a', modelName: 'DCS-7010TX-48', streamingStatus: 'STREAMING_STATUS_ACTIVE' } } }));
    const m = /^\/api\/v1\/rest\/SN-A(\/.*)$/.exec(raw);
    if (!m) return send('{"notifications":[]}');
    const rest = m[1].split('/').map((x) => decodeURIComponent(x)).join('/');
    if (rest === IS) return send({ notifications: [note(IS, { Ethernet1: ptrU(IS, 'Ethernet1'), Ethernet2: ptrU(IS, 'Ethernet2') })] });
    if (rest === `${IS}/Ethernet1`) return send({ notifications: [note(rest, { operStatus: { key: 'operStatus', value: { Name: 'intfOperUp' } }, speedEnum: { key: 'speedEnum', value: { Name: 'speed1Gbps' } } })] });
    if (rest === `${IS}/Ethernet2`) return send({ notifications: [note(rest, { operStatus: { key: 'operStatus', value: { Name: 'intfOperDown' } } })] });
    if (rest === BG) return send({ notifications: [note(BG, { default: ptrU(BG, 'default') })] });
    if (rest === `${BG}/default`) return send({ notifications: [note(rest, { '10.9.9.1': ptrU(rest, '10.9.9.1') })] });
    if (rest === `${BG}/default/10.9.9.1`) return send({ notifications: [note(rest, { bgpPeerState: { key: 'bgpPeerState', value: 'Established' }, bgpPeerAs: int('bgpPeerAs', 65001) })] });
    if (rest === '/Kernel/proc/meminfo') return send({ notifications: [note(rest, { memTotal: int('memTotal', 1000), memAvailable: int('memAvailable', 250) })] });
    return send('{"notifications":[]}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await C.collectCvp({ host: `http://127.0.0.1:${srv.address().port}`, authMode: 'token', token: 'T', verifyTls: false }, { budgetMs: 30_000, partsDue: false, prefer: new Map() });
    const d = r.devices.find((x) => x.serial === 'SN-A' || x.key === 'SN-A');
    assert.ok(d.ports, `포트를 읽어야 한다: ${JSON.stringify(r.missing)}`);
    assert.deepEqual(d.ports.map((p) => [p.name, p.oper]).sort(), [['Ethernet1', 'up'], ['Ethernet2', 'down']]);
    assert.equal(d.ports.find((p) => p.name === 'Ethernet1').speedBps, 1e9);
    assert.equal(d.bgp?.[0]?.peer, '10.9.9.1');
    assert.equal(d.memPct ?? d.mem?.pct, 75);
    assert.equal(hits.some((h) => h.includes('/Kernel/proc/stat')), false, 'PID 별 표를 CPU 후보로 조회하지 않는다');
  } finally { srv.close(); }
});

test('⑥ v2.643 부품 — 포인터 경로 전체로 이름(PowerSupply1·2 가 컨테이너 한 개로 합쳐지지 않는다) · 온도 소수 1자리', async () => {
  const PW = '/Sysdb/environment/power/status';
  const srv = http.createServer((req, res) => {
    const send = (b) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(typeof b === 'string' ? b : JSON.stringify(b)); };
    const raw = new URL(req.url, 'http://x').pathname;
    if (raw === '/api/resources/inventory/v1/Device/all') return send(JSON.stringify({ result: { value: { key: { deviceId: 'SN-B' }, hostname: 'sw-b', streamingStatus: 'STREAMING_STATUS_ACTIVE' } } }));
    const m = /^\/api\/v1\/rest\/SN-B(\/.*)$/.exec(raw);
    if (!m) return send('{"notifications":[]}');
    const rest = m[1].split('/').map((x) => decodeURIComponent(x)).join('/');
    if (rest === PW) return send({ notifications: [note(PW, { powerSupply: ptrU(PW, 'powerSupply'), currentSensor: ptrU(PW, 'currentSensor') })] });
    if (rest === `${PW}/powerSupply`) return send({ notifications: [note(rest, { PowerSupply1: ptrU(rest, 'PowerSupply1'), PowerSupply2: ptrU(rest, 'PowerSupply2') })] });
    if (rest === `${PW}/powerSupply/PowerSupply1`) return send({ notifications: [note(rest, { state: { key: 'state', value: 'ok' } })] });
    if (rest === `${PW}/powerSupply/PowerSupply2`) return send({ notifications: [note(rest, { state: { key: 'state', value: 'powerLoss' } })] });
    if (rest === `${PW}/currentSensor`) return send({ notifications: [note(rest, { units: { key: 'units', value: 'A' } })] }); // 상태 필드 없음 → 부품 아님
    return send('{"notifications":[]}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await C.collectCvp({ host: `http://127.0.0.1:${srv.address().port}`, authMode: 'token', token: 'T', verifyTls: false }, { budgetMs: 30_000, partsDue: true, prefer: new Map() });
    const d = r.devices.find((x) => x.key === 'SN-B' || x.serial === 'SN-B');
    const psu = (d.parts || []).filter((p) => p.kind === 'psu');
    assert.deepEqual(psu.map((p) => p.name).sort(), [`powerSupply${C.PART_PATH_SEP}PowerSupply1`, `powerSupply${C.PART_PATH_SEP}PowerSupply2`], JSON.stringify(d.parts));
    assert.equal(psu.find((p) => p.name.endsWith('PowerSupply2')).state === 'ok', false, 'powerLoss 인 PSU2 가 정상으로 보이면 안 된다(예전엔 PSU1 과 합쳐졌다)');
  } finally { srv.close(); }
  const t = P.parseParts(JSON.stringify({ notifications: [note('/x', { temperature: { key: 'temperature', value: 25.329440000000034 } })] }), 'temp');
  assert.ok(t.parts[0].detail.includes('25.3℃'), t.parts[0].detail);
});
