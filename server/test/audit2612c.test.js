// v2.612 감사 그룹 C — BMC 리다이렉트·팬 빈 슬롯·사용률 100% 초과·용량 단위·PDU VA 의 회귀 고정.
//   SEC2612-03 교차 출처 리다이렉트에 자격증명을 보내지 않는다(같은 출처만 따른다) · COL2612-08 Absent 팬 ·
//   COL2612-01 NIC 사용률 > 100 은 null · COL2612-06 toBytes 단위 뒤 글자·지수 · COL2612-07 toWatts VA.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2612c-'));
process.env.CONFIG_DIR = tmp;

let redfish, ome, winPerf, rates, cli, pdu, extract;
const servers = [];
before(async () => {
  redfish = await import('../src/idrac/redfish.js');
  ome = await import('../src/idrac/ome.js');
  winPerf = await import('../src/bmusage/parse/winPerf.js');
  rates = await import('../src/bmusage/rates.js');
  cli = await import('../src/storage/collectors/cliSsh.js');
  pdu = await import('../src/pdu/parse.js');
  extract = await import('../src/partfault/extract/idrac.js');
});
after(() => { for (const s of servers) s.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

function serve(handler) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => handler(req, res, body));
  });
  servers.push(srv);
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
}
const json = (res, o, code = 200) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };

// ── SEC2612-03 ────────────────────────────────────────────────────────────
test('SEC2612-03: 세션 POST 의 교차 출처 307 은 따라가지 않는다 — 다른 주소가 비밀번호를 받지 않는다', async () => {
  const got = [];
  const other = await serve((req, res, body) => { got.push({ url: req.url, body, auth: req.headers.authorization || '', xat: req.headers['x-auth-token'] || '' }); json(res, {}, 401); });
  const bmc = await serve((req, res) => {
    if (req.url.includes('SessionService')) { res.statusCode = 307; res.setHeader('location', `${other}/steal`); return res.end(); }
    json(res, {}, 401);
  });
  await assert.rejects(() => redfish.fetchPower({ host: bmc, username: 'root', password: 'S3cret!', id: 't' }));
  assert.deepEqual(got, [], '교차 출처 리다이렉트 대상에 요청이 가면 안 된다');
});

test('SEC2612-03: 교차 출처 리다이렉트는 토큰 헤더를 싣고 따라가지 않는다(bmcFetch 가 오류로 끊는다)', async () => {
  const got = [];
  const other = await serve((req, res) => { got.push(req.headers['x-auth-token'] || ''); json(res, {}); });
  const bmc = await serve((req, res) => { res.statusCode = 302; res.setHeader('location', `${other}/x`); res.end(); });
  await assert.rejects(() => redfish.bmcFetch(`${bmc}/redfish/v1/Systems`, { headers: { 'X-Auth-Token': 'tok' } }), /다른 주소로 리다이렉트/);
  assert.equal(got.length, 0);
});

test('SEC2612-03: 같은 출처 308(끝 슬래시)은 본문과 함께 따라가 정상 동작한다', async () => {
  let posted = null;
  const bmc = await serve((req, res, body) => {
    if (req.url === '/redfish/v1') { res.statusCode = 308; res.setHeader('location', '/redfish/v1/'); return res.end(); }
    if (req.url === '/redfish/v1/') return json(res, { RedfishVersion: '1.9.0', Vendor: 'Dell', Oem: { Dell: {} } });
    if (req.url === '/s') { res.statusCode = 308; res.setHeader('location', '/s/'); return res.end(); }
    if (req.url === '/s/' && req.method === 'POST') { posted = body; return json(res, { ok: true }, 201); }
    json(res, {}, 404);
  });
  const r = await redfish.bmcFetch(`${bmc}/s`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' });
  assert.equal(r.status, 201);
  assert.equal(posted, '{"a":1}');
  const root = await redfish.bmcFetch(`${bmc}/redfish/v1`, { headers: { Accept: 'application/json' } });
  assert.equal(root.status, 200);
  assert.equal((await root.json()).Vendor, 'Dell');
});

test('SEC2612-03: OME 로그인도 교차 출처 307 에 비밀번호를 다시 보내지 않는다', async () => {
  const got = [];
  const other = await serve((req, res, body) => { got.push(body); json(res, {}, 201); });
  const bmc = await serve((req, res) => { res.statusCode = 307; res.setHeader('location', `${other}/steal`); res.end(); });
  const c = new ome.OmeClient({ host: bmc, username: 'admin', password: 'OmePw!' });
  await c.login(); // 실패는 삼키고 Basic 폴백(원래 동작)
  assert.equal(c.token, null);
  assert.deepEqual(got, []);
});

// ── COL2612-08 ────────────────────────────────────────────────────────────
test('COL2612-08: Absent 팬은 rpm·pct 가 없고 state:absent — 파트 장애는 빈 슬롯으로 분류한다', async () => {
  const url = await serve((req, res) => {
    if (req.url === '/redfish/v1/Chassis') return json(res, { Members: [{ '@odata.id': '/redfish/v1/Chassis/1' }] });
    if (req.url === '/redfish/v1/Chassis/1/Thermal') {
      return json(res, {
        Temperatures: [{ Name: 'Inlet', ReadingCelsius: 22, Status: { State: 'Enabled', Health: 'OK' } }],
        Fans: [
          { Name: 'Fan 1', Reading: 7200, ReadingUnits: 'RPM', Status: { State: 'Enabled', Health: 'OK' } },
          { Name: 'Fan 6', Reading: 0, ReadingUnits: 'Percent', Status: { State: 'Absent' } },
          { Name: 'Fan 7', Reading: 0, ReadingUnits: 'RPM', Status: { State: 'Absent' } },
        ],
      });
    }
    return json(res, {}, 404);
  });
  const s = await redfish.fetchSensors({ host: url, username: 'a', password: 'b' });
  const f6 = s.fans.find((f) => f.name === 'Fan 6');
  const f7 = s.fans.find((f) => f.name === 'Fan 7');
  assert.equal(f6.pct, undefined, 'HPE 빈 슬롯에 0% 를 싣지 않는다');
  assert.equal(f6.rpm, null);
  assert.equal(f7.rpm, null, '빈 슬롯의 0 RPM 은 값이 아니다(시계열에서 빠진다)');
  assert.equal(f6.state, 'absent');
  assert.equal(s.fans.find((f) => f.name === 'Fan 1').rpm, 7200);
  assert.equal(s.fans.find((f) => f.name === 'Fan 1').state, undefined);

  const inv = { system: { serviceTag: 'ABC1234' }, collections: { psus: 'ok', disks: 'ok', storageControllers: 'ok', memoryDimms: 'ok', cpus: 'ok', gpus: 'ok', pcie: 'ok', fans: 'ok' }, reachable: true, psus: [], disks: [], memoryDimms: [], cpus: [], gpus: [], storageControllers: [], pcie: [], fans: s.fans };
  const r = extract.extractIdracParts({ id: '10.0.0.5' }, inv);
  const p6 = r.parts.find((p) => p.kind === 'fan' && /Fan 6/.test(p.partKey));
  assert.equal(p6.state, 'absent');
});

// ── COL2612-01 ────────────────────────────────────────────────────────────
test('COL2612-01: NIC 사용률이 100% 를 넘으면 클램프하지 않고 null + 개수', () => {
  const o = winPerf.parseWinPerf('NIC=eth2|10|1000000000|150000000|90000000\nNIC=eth3|10|1000000000|50000000|10000000');
  assert.equal(o.nics[0].pct, null);
  assert.equal(o.nicPctOutOfRange, 1);
  assert.equal(o.nics[1].pct, 40);
  assert.equal(rates.linkPct(200e6, 1e9), null);
  assert.equal(rates.linkPct(100e6, 1e9), 80);
  assert.equal(rates.linkPct(125e6, 1e9), 100);
});

// ── COL2612-06 ────────────────────────────────────────────────────────────
test('COL2612-06: 단위 뒤에 글자가 이어지면 단위가 아니다 · 지수 표기는 바이트 수', () => {
  assert.equal(cli.toBytesOrNull('3 tiers'), null);
  assert.equal(cli.toBytesOrNull('7 entries'), null);
  assert.equal(cli.toBytes('1.2e+12'), 1.2e12);
  assert.equal(cli.toBytes('Size: 11.0T'), cli.toBytes('11.0T'));
  assert.ok(cli.toBytes('11.0T') > 1e13);
  assert.equal(cli.toBytes('12094627905536 (11.0T)'), 12094627905536);
  assert.ok(cli.toBytes('1.5 TiB used') > 1e12);
});

// ── COL2612-07 ────────────────────────────────────────────────────────────
test('COL2612-07: toWatts — VA 는 ×1, kVA 는 ×1000, 모르는 단위는 null', () => {
  assert.equal(pdu.toWatts(1980, 'VA'), 1980);
  assert.equal(pdu.toWatts(1.98, 'kVA'), 1980);
  assert.equal(pdu.toWatts(1.98, 'kW'), 1980);
  assert.equal(pdu.toWatts(500, 'W'), 500);
  assert.equal(pdu.toWatts(1.98, ''), 1980, '단위 미표기는 장비 기본(kW)');
  assert.equal(pdu.toWatts(3, 'A'), null);
});
