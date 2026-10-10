/**
 * v2.732(점검 2회차 그룹 c · B4-01) — 비활성·점검중·엣지 위임(site) vCenter 에 **로그인하지 않는다** · 로그인 거부는 **정지 기록**에 올린다.
 *
 * 결함(재현): vCenter 이벤트 로그 폴러(logs/poller.js)의 live 대상이 등록부 전량이라, store.js 주 폴러·vmseries·curuser 가 거르는
 *   enabled===false · maintenance · collectMode==='site' vCenter 에 10분마다 로그인했다(3주기 × 계정 3개 = 9회). 그리고 로그인 거부를
 *   vcAuthGuard 에 올리지 않아(주 폴러는 그 셋을 수집하지 않으므로 기록이 생기지 않는다) 비밀번호가 틀린 구간에 실패 로그인이 쌓였다.
 *   같은 원인의 형제: 게스트 디스크(점검중 — 스냅샷의 직전 VM 때문에 로그인) · OS 판별 스캐너(site·점검중).
 * ⚠ 문자열이 아니라 **실제 로그인 시도 횟수**를 센다(가짜 vCenter — SOAP InvalidLogin). 판정은 vcenter/collectTarget.js 하나다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2732c-targets-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 이 테스트의 가짜 vCenter 가 127.0.0.1 에 산다 — 이 테스트 전용
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const H = 3_600_000;
const ENV = (inner) => '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>'
  + inner + '</soapenv:Body></soapenv:Envelope>';
const SC_XML = ENV('<RetrieveServiceContentResponse xmlns="urn:vim25"><returnval>'
  + '<rootFolder type="Folder">group-d1</rootFolder><propertyCollector type="PropertyCollector">propertyCollector</propertyCollector>'
  + '<viewManager type="ViewManager">ViewManager</viewManager><sessionManager type="SessionManager">SessionManager</sessionManager>'
  + '<eventManager type="EventManager">EventManager</eventManager>'
  + '<guestOperationsManager type="GuestOperationsManager">guestOperationsManager</guestOperationsManager>'
  + '<about><version>8.0.2</version><build>1</build><fullName>VMware vCenter Server 8.0.2</fullName><apiVersion>8.0.2.0</apiVersion></about>'
  + '</returnval></RetrieveServiceContentResponse>');
const FAULT = (type, msg) => ENV(`<soapenv:Fault><faultcode>ServerFaultCode</faultcode><faultstring>${msg}</faultstring>`
  + `<detail><${type}Fault xmlns="urn:vim25" xsi:type="${type}"></${type}Fault></detail></soapenv:Fault>`);
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => resolve(b)); });

/** 가짜 vCenter — Login 은 password 'good' 만 통과(계정별로 센다) · 이벤트 조회 지원(events 배열). */
async function fakeVcenter() {
  const st = { logins: new Map(), events: [], served: 0 };
  const srv = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const send = (code, xml) => { res.writeHead(code, { 'content-type': 'text/xml' }); res.end(xml); };
    if (body.includes('<RetrieveServiceContent')) return send(200, SC_XML);
    if (body.includes('<Login ')) {
      const u = /<userName>([^<]*)<\/userName>/.exec(body)?.[1] || '';
      st.logins.set(u, (st.logins.get(u) || 0) + 1);
      if (body.includes('<password>good</password>')) { res.setHeader('Set-Cookie', 'vmware_soap_session=x'); return send(200, ENV('<LoginResponse xmlns="urn:vim25"><returnval><key>s1</key><userName>u</userName></returnval></LoginResponse>')); }
      return send(500, FAULT('InvalidLogin', 'Cannot complete login due to an incorrect user name or password.'));
    }
    if (body.includes('<Logout ')) return send(200, ENV('<LogoutResponse xmlns="urn:vim25"></LogoutResponse>'));
    if (body.includes('<CreateCollectorForEvents')) { st.served = 0; return send(200, ENV('<CreateCollectorForEventsResponse xmlns="urn:vim25"><returnval type="EventHistoryCollector">col</returnval></CreateCollectorForEventsResponse>')); }
    if (body.includes('<ReadNextEvents')) {
      const n = Number((/<maxCount>(\d+)<\/maxCount>/.exec(body) || [])[1] || 0);
      const page = st.events.slice(st.served, st.served + n);
      st.served += page.length;
      const xml = page.map((e) => `<returnval xsi:type="UserLoginSessionEvent"><key>${e.key}</key><createdTime>${new Date(e.ts).toISOString()}</createdTime><userName>u</userName><fullFormattedMessage>login ${e.key}</fullFormattedMessage></returnval>`).join('');
      return send(200, ENV(`<ReadNextEventsResponse xmlns="urn:vim25">${xml}</ReadNextEventsResponse>`));
    }
    if (body.includes('<DestroyCollector')) return send(200, ENV('<DestroyCollectorResponse xmlns="urn:vim25"></DestroyCollectorResponse>'));
    if (body.includes('<RetrieveProperties')) return send(200, ENV('<RetrievePropertiesResponse xmlns="urn:vim25"></RetrievePropertiesResponse>'));
    return send(500, FAULT('NotSupported', 'unexpected'));
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  return { st, host: `http://127.0.0.1:${port}`, logins: (u) => st.logins.get(u) || 0 };
}

const writeJson = (name, obj) => fs.writeFileSync(path.join(DIR, name), JSON.stringify(obj, null, 2));
/** 등록부 vCenter 목록을 유지하며 항목을 덮어쓴다(테스트끼리 서로의 vCenter 를 지우지 않게). */
function upsertVcenters(list) {
  const f = path.join(DIR, 'vcenters.json');
  let cur = [];
  try { cur = JSON.parse(fs.readFileSync(f, 'utf8')).vcenters || []; } catch { /* 없음 */ }
  const ids = new Set(list.map((v) => v.id));
  writeJson('vcenters.json', { vcenters: [...cur.filter((v) => !ids.has(v.id)), ...list] });
}
async function seedSnapshot({ vcenters = [], vms = [] }) {
  const { store } = await import('../src/store.js');
  const cur = store.get() || {};
  const ids = new Set(vcenters.map((v) => v.id));
  const keep = (arr) => (arr || []).filter((x) => !ids.has(x.vcenterId ?? x.id));
  store.snapshot = { ...cur, source: 'live', vcenters: [...keep(cur.vcenters), ...vcenters], vms: [...keep(cur.vms), ...vms] };
}
const vmRow = (vcId, n) => ({ id: `${vcId}:vm-${n}`, vcenterId: vcId, name: `${vcId}-g${n}`, powerState: 'POWERED_ON', toolsStatus: 'RUNNING', guestOS: 'Red Hat Enterprise Linux 9', host: 'h1' });

// ── 판정 모듈(순수) ──────────────────────────────────────────────────────────
test('B4-01 ⓪ collectTarget: 비활성 → 점검중 → site 순 · 직접 수집은 null · 건너뛴 항목은 이유와 함께 돌려준다', async () => {
  const { directCollectSkipReason, splitDirectCollectTargets, skippedCountsOf, DIRECT_SKIP_REASONS } = await import('../src/vcenter/collectTarget.js');
  assert.equal(directCollectSkipReason({ id: 'a' }), null);
  assert.equal(directCollectSkipReason({ id: 'a', enabled: true, collectMode: 'direct' }), null);
  assert.equal(directCollectSkipReason({ id: 'a', enabled: false, maintenance: true, collectMode: 'site' }), 'disabled');
  assert.equal(directCollectSkipReason({ id: 'a', maintenance: true, collectMode: 'site' }), 'maintenance');
  assert.equal(directCollectSkipReason({ id: 'a', collectMode: 'site' }), 'site');
  assert.equal(directCollectSkipReason(null), 'invalid');
  const r = splitDirectCollectTargets([{ id: 'd' }, { id: 'x', enabled: false }, { id: 'm', maintenance: true }, { id: 's', collectMode: 'site' }]);
  assert.deepEqual(r.targets.map((v) => v.id), ['d']);
  assert.deepEqual(r.skipped, [{ vcenterId: 'x', why: 'disabled' }, { vcenterId: 'm', why: 'maintenance' }, { vcenterId: 's', why: 'site' }]);
  assert.deepEqual(skippedCountsOf(r.skipped), { disabled: 1, maintenance: 1, site: 1 });
  assert.deepEqual([...DIRECT_SKIP_REASONS].sort(), ['disabled', 'maintenance', 'site']);
});

// ── 로그 폴러 ────────────────────────────────────────────────────────────────
test('B4-01 ① 로그 폴러: 비활성·점검중·site 는 로그인 0회(수동 포함) · 직접 수집 vCenter 의 거부는 정지 기록 → 다음 주기 0회 · 수동은 시도', async () => {
  const vc = await fakeVcenter();
  const base = { host: vc.host, password: 'bad', timeoutMs: 5000 };
  upsertVcenters([
    { id: 'vc-direct', name: 'D', username: 'u-direct', ...base },
    { id: 'vc-dis', name: 'X', username: 'u-dis', enabled: false, ...base },
    { id: 'vc-maint', name: 'M', username: 'u-maint', maintenance: true, ...base },
    { id: 'vc-site', name: 'S', username: 'u-site', collectMode: 'site', remoteAgent: 'edge-a', ...base },
  ]);
  const P = await import('../src/logs/poller.js');
  const { vcAuthGuard } = await import('../src/vcenter/restClient.js');
  const { loadVcenterConfig } = await import('../src/config.js');
  const cfg = (id) => loadVcenterConfig().vcenters.find((v) => v.id === id);

  const r1 = await P.pollLogsOnce();
  assert.equal(vc.logins('u-dis'), 0, '관리자가 끈 vCenter 에 로그인하면 안 된다');
  assert.equal(vc.logins('u-maint'), 0, '점검중 vCenter 에 로그인하면 안 된다');
  assert.equal(vc.logins('u-site'), 0, '엣지 위임 vCenter 는 엣지가 수집한다 — 중앙이 로그인하면 안 된다');
  assert.equal(vc.logins('u-direct'), 1);
  const nc = Object.fromEntries((r1.notCollected || []).map((x) => [x.vcenterId, x.why]));
  assert.deepEqual(nc, { 'vc-dis': 'disabled', 'vc-maint': 'maintenance', 'vc-site': 'site' }, `건너뛴 vCenter 를 이유와 함께 밝힌다: ${JSON.stringify(r1)}`);
  assert.deepEqual((r1.authRejected || []).map((x) => x.vcenterId), ['vc-direct'], `로그인 거부를 결과에 싣는다: ${JSON.stringify(r1)}`);
  assert.equal(vcAuthGuard.peekAuthStop(cfg('vc-direct'))?.attempts, 1, '로그인 거부는 주 폴러와 같은 정지 기록에 올린다');

  const r2 = await P.pollLogsOnce();
  assert.equal(vc.logins('u-direct'), 1, '정지된 vCenter 는 다음 주기에 로그인하지 않는다(10분마다 실패 로그인이 쌓이지 않게)');
  assert.ok((r2.authStopped || []).includes('vc-direct'), JSON.stringify(r2));

  await P.pollLogsOnce({ manual: true });
  assert.equal(vc.logins('u-direct'), 2, '수동 실행은 막지 않는다(authGuard 규칙 3)');
  assert.equal(vcAuthGuard.peekAuthStop(cfg('vc-direct'))?.attempts, 2, '수동 거부도 같은 기록에 시도를 올린다');
  for (const u of ['u-dis', 'u-maint', 'u-site']) assert.equal(vc.logins(u), 0, `${u}: 수동 실행도 직접 수집 대상이 아닌 vCenter 는 건너뛴다`);
});

test('B6-01 로그 폴러: 적재는 조각 적재(insertManyAsync)로 · 수집 성공 기록은 그 vCenter 적재가 끝난 뒤에만', async () => {
  const vc = await fakeVcenter();
  const NOW = Math.floor(Date.now() / H) * H - 30 * 60_000;   // 정시 −30분 — 이벤트 시각만 정한다(판정 경계에 쓰지 않는다)
  vc.st.events = Array.from({ length: 2_500 }, (_, i) => ({ key: `e${i}`, ts: NOW - 5 * H + Math.floor(i / 2) * 1_000 }));
  upsertVcenters([{ id: 'vc-good', name: 'G', username: 'u-good', password: 'good', host: vc.host, timeoutMs: 5000 }]);
  const { getLogsDb } = await import('../src/logs/db.js');
  const db = await getLogsDb();
  const P = await import('../src/logs/poller.js');
  const orig = db.insertManyAsync;
  assert.equal(typeof orig, 'function');
  const calls = [];
  db.insertManyAsync = async (rows, opts) => {
    calls.push({ vc: rows[0]?.vcenterId, n: rows.length, okBefore: P.logCollectOkAt(rows[0]?.vcenterId) });
    return orig(rows, opts);
  };
  try {
    await P.pollLogsOnce({ manual: true });
  } finally { db.insertManyAsync = orig; }
  const mine = calls.filter((c) => c.vc === 'vc-good');
  assert.equal(mine.length, 1, `vc-good 은 조각 적재로 들어가야 한다: ${JSON.stringify(calls)}`);
  assert.equal(mine[0].n, 2_500);
  assert.equal(mine[0].okBefore, null, '적재가 시작될 때 수집 성공은 아직 기록되지 않았다');
  assert.ok(P.logCollectOkAt('vc-good') != null, '적재가 끝난 뒤 기록된다');
  assert.equal(db.count({ vcenterId: 'vc-good' }), 2_500);
});

// ── 형제 경로 ────────────────────────────────────────────────────────────────
test('B4-01 ② 게스트 디스크: 점검중·비활성 vCenter 는 스냅샷에 VM 이 남아 있어도 로그인하지 않는다(수동 포함) · 이유를 싣는다', async () => {
  const vc = await fakeVcenter();
  const base = { host: vc.host, password: 'bad', timeoutMs: 5000 };
  upsertVcenters([
    { id: 'vc-gd-m', name: 'GM', username: 'u-gd-m', maintenance: true, ...base },
    { id: 'vc-gd-d', name: 'GD', username: 'u-gd-d', enabled: false, ...base },
    { id: 'vc-gd-ok', name: 'GO', username: 'u-gd-ok', ...base },
  ]);
  await seedSnapshot({ vcenters: [{ id: 'vc-gd-m', name: 'GM' }, { id: 'vc-gd-d', name: 'GD' }, { id: 'vc-gd-ok', name: 'GO' }],
    vms: [vmRow('vc-gd-m', 1), vmRow('vc-gd-d', 1), vmRow('vc-gd-ok', 1)] });
  const { runGuestDiskNow } = await import('../src/guestdisk/poller.js');
  const r = await runGuestDiskNow('manual');
  assert.equal(vc.logins('u-gd-m'), 0, '점검중 vCenter 에 게스트 디스크 조회 로그인을 하면 안 된다');
  assert.equal(vc.logins('u-gd-d'), 0);
  assert.equal(vc.logins('u-gd-ok'), 1, '직접 수집 vCenter 는 그대로 수집한다');
  const nc = Object.fromEntries((r.notCollected || []).map((x) => [x.vcenterId, x.why]));
  assert.equal(nc['vc-gd-m'], 'maintenance', JSON.stringify(r));
  assert.equal(nc['vc-gd-d'], 'disabled');
});

test('B4-01 ③ OS 판별 스캐너: site·점검중 vCenter 에 게스트 조사 로그인을 하지 않는다 · 결과·상태가 이유를 말한다', async () => {
  const vc = await fakeVcenter();
  const base = { host: vc.host, password: 'good', timeoutMs: 5000 };
  upsertVcenters([
    { id: 'vc-os-m', name: 'OM', username: 'u-os-m', maintenance: true, ...base },
    { id: 'vc-os-s', name: 'OS', username: 'u-os-s', collectMode: 'site', remoteAgent: 'edge-b', ...base },
    { id: 'vc-os-ok', name: 'OK', username: 'u-os-ok', ...base, password: 'bad' },
  ]);
  await seedSnapshot({ vcenters: [{ id: 'vc-os-m', name: 'OM' }, { id: 'vc-os-s', name: 'OS', collectSource: 'site' }, { id: 'vc-os-ok', name: 'OK' }],
    vms: [vmRow('vc-os-m', 1), vmRow('vc-os-s', 1), vmRow('vc-os-ok', 1)] });
  writeJson('gpu-guest.json', { vcenters: { 'vc-os-m': { username: 'g', password: 'p' }, 'vc-os-s': { username: 'g', password: 'p' }, 'vc-os-ok': { username: 'g', password: 'p' } } });
  writeJson('os-scan.json', { enabled: true, intervalMin: 5, scope: 'all', maxVms: 50, concurrency: 2, rescanDays: 0 });
  const osm = await import('../src/inventory/osScanner.js');
  const r = await osm.runOsScanNow(undefined, { trigger: 'auto' });
  assert.equal(vc.logins('u-os-m'), 0, '점검중 vCenter 에 로그인하면 안 된다');
  assert.equal(vc.logins('u-os-s'), 0, '엣지가 push 한 site VM 때문에 중앙이 그 vCenter 에 로그인하면 안 된다');
  assert.equal(vc.logins('u-os-ok'), 1, '직접 수집 vCenter 는 그대로 스캔한다');
  // 등록부에는 앞 테스트의 vCenter 도 있다(scope 'all') — 이 테스트의 둘만 본다
  const nc = Object.fromEntries((r.notCollected || []).filter((x) => x.vcenterId.startsWith('vc-os-')).map((x) => [x.vcenterId, x.why]));
  assert.deepEqual(nc, { 'vc-os-m': 'maintenance', 'vc-os-s': 'site' }, JSON.stringify(r));
  const st = osm.osScanStatus();
  const sk = (st.lastSkipped || []).filter((x) => x.vcenterId.startsWith('vc-os-')).map((x) => x.vcenterId).sort();
  assert.deepEqual(sk, ['vc-os-m', 'vc-os-s'], `상태가 건너뛴 vCenter 를 말한다: ${JSON.stringify(st.lastSkipped)}`);
  // 대상이 전부 직접 수집이 아니면 로그인 없이 그 사실을 말한다(실패로 지어내지 않는다)
  const only = await osm.runOsScanNow('vc-os-s', { trigger: 'manual' });
  assert.equal(only.ok, false);
  assert.match(only.reason || '', /엣지 위임/);
  assert.equal(vc.logins('u-os-s'), 0, '수동 실행도 site vCenter 에 로그인하지 않는다');
});
