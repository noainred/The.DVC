// 물리서버 운영 기능(v3.49 — 설계 docs/design/bm-feature-proposals ⑩ 건강 점수 · ⑥ 위치 LED 상태 · ⑤ 하드웨어 이벤트 로그 · ⑫ 제조사 케이스 · ④ 보안 권고 대조).
//   ⑩ 감점 합산 · 못 읽음은 따로 · 견준 것이 없으면 점수 없음 ⑥ LED 값 대응 · 엣지 push · 중앙 정제 ⑤ SEL 줄 · 정제 · 가림 · 읽기(가짜 장비) · 라우트(이 노드 · 엣지 · 수집 서버 · 데모)
//   ⑫ 저장 · 이력 · 라우트 게이트(조회 밖 404 · 쓰기 밖 403 · 조회 계정 403) · 접수 자료 묶음 가림 ④ CSV · 대조 · 관리 라우트 · 목록 요약.
//   픽스처 식별자는 전부 합성(SYNTH · 192.0.2.x — 공개 저장소 규약).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const tmp = tmpDir('bmops349-');
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'live';

const H = await import('../src/bmcheck/health.js');
const FW = await import('../src/bmcheck/fw.js');
const ST = await import('../src/bmcheck/state.js');
const LED = await import('../src/idrac/ledState.js');
const L = await import('../src/idrac/hwLog.js');
const ADV = await import('../src/bmcheck/advisory.js');
const S = await import('../src/bmcheck/store.js');
const fleet = await import('../src/central/fleet.js');
const bs = await import('../src/bmfolders/store.js');
const sm = await import('../src/servicemap/store.js');
const registry = await import('../src/idrac/registry.js');
const invCache = await import('../src/idrac/invCache.js');
const { hwDetailOf } = await import('../src/idrac/hwSummary.js');
const { store } = await import('../src/store.js');
const { registerBmFolders, _setTrendDepsForTest } = await import('../src/routes/api/bmFolders.js');
const svcinv = await import('../src/routes/api/svcInventory.js');
const { registerBmAssets } = await import('../src/routes/admin/bmAssets.js');

// ───────── ⑩ 건강 점수 ─────────
test('⑩ 건강 점수 — 100 에서 감점 합산 · 항목별 상한 · 못 읽음은 따로 · 견준 것이 없으면 점수 없음 · 경계', () => {
  const R = H.HEALTH_RULES;
  assert.deepEqual([R.fault.per, R.fault.cap, R.warrantyExpired.per, R.warrantySoon.per, R.fwBehind.per, R.fwBehind.cap, R.biosDiff.per, R.biosDiff.cap], [12, 36, 10, 3, 3, 12, 2, 8]);
  const all = H.healthOf({ faults: 1, chk: { w: 'soon', fw: 'behind', fwn: 2, bios: 'diff', biosn: 1 } });
  assert.deepEqual([all.score, all.band, all.unknown, all.judged], [100 - 12 - 3 - 6 - 2, 'warn', [], 4]);
  assert.deepEqual(all.items.map((x) => [x.k, x.pts]), [['fault', 12], ['warranty', 3], ['fw', 6], ['bios', 2]]);
  // 상한
  assert.equal(H.healthOf({ faults: 9, chk: { w: 'expired', fw: 'behind', fwn: 30, bios: 'diff', biosn: 30 } }).score, 100 - 36 - 10 - 12 - 8);
  // 못 읽음은 감점하지 않고 따로 센다 — 0 으로 세지 않는다
  // 견준 항목이 2개 미만이거나 절반 미만이면 점수를 내지 않는다(못 읽어서 ‘100 · 양호’ 가 되지 않게 · 반증 B1) — 견준 사실은 남는다
  const part = H.healthOf({ faults: null, chk: { w: 'ok', fw: 'unread', bios: 'unplaced' } });
  assert.deepEqual([part.score, part.band, part.unknown, part.judged, part.few], [null, 'none', ['fault', 'fw', 'bios'], 1, true]);
  assert.deepEqual(H.healthRowOf({ faults: 2, chk: { w: 'unknown', fw: 'unread', bios: 'unread' } }), { b: 'none', u: 3, uk: ['warranty', 'fw', 'bios'], few: 1, d: [['fault', 24, 2]] }, '점수가 없어도 확인된 감점 사실은 싣는다');
  const half = H.healthOf({ faults: 0, chk: { w: 'ok', fw: 'unread', bios: 'unread' } });
  assert.deepEqual([half.score, half.judged, half.unknown.length], [100, 2, 2], '절반 견줌 · 2개 — 점수를 낸다');
  assert.equal(H.healthOf({ kind: 'esxi', faults: 0, chk: { w: 'unknown' } }).score, null, 'ESXi 도 견준 것이 하나뿐이면 점수 없음');
  assert.equal(H.healthOf({ kind: 'esxi', faults: 0, chk: { w: 'ok' } }).score, 100);
  assert.deepEqual(H.HEALTH_MIN, { judged: 2, share: 0.5 });
  // 보증 감점 줄은 상태를 싣는다(끝남 · 곧 끝남 — 반증 B7) · 순서를 모르는 펌웨어(differ)는 감점하지 않는다(반증 B8)
  assert.deepEqual(H.healthRowOf({ faults: 0, chk: { w: 'soon', fw: 'ok', bios: 'ok' } }).d, [['warranty', 3, null, 'soon']]);
  const dif = H.healthOf({ faults: 0, chk: { w: 'ok', fw: 'behind', fwn: 3, fwd: 2, bios: 'ok' } });
  assert.deepEqual(dif.items.find((x) => x.k === 'fw'), { k: 'fw', state: 'behind', n: 1, pts: 3 }, '뒤처짐 3 중 순서 모름 2 — 1개만 감점');
  assert.deepEqual(H.healthOf({ faults: 0, chk: { w: 'ok', fw: 'behind', fwn: 2, fwd: 2, bios: 'ok' } }).items.find((x) => x.k === 'fw'), { k: 'fw', state: 'differ', pts: 0 });
  const fwDiff = FW.judgeFirmware([
    { id: 'a', corp: 'vc-a', model: 'R750', fw: { comps: [{ key: 'NIC|n', type: 'NIC', label: 'n', version: 'A01', mixed: false }], skipped: 0 } },
    { id: 'b', corp: 'vc-a', model: 'R750', fw: { comps: [{ key: 'NIC|n', type: 'NIC', label: 'n', version: 'B07', mixed: false }], skipped: 0 } },
    { id: 'c', corp: 'vc-a', model: 'R750', fw: { comps: [{ key: 'NIC|n', type: 'NIC', label: 'n', version: 'B07', mixed: false }], skipped: 0 } }]);
  assert.deepEqual([fwDiff.get('a').state, fwDiff.get('a').behind, fwDiff.get('a').differ, ST.chkRowOf({ fw: fwDiff.get('a') }).fwd], ['behind', 1, 1, 1], '점검 화면은 ‘다름’ 그대로 · 건강 점수만 감점하지 않는다');
  for (const f of ['', 'x', undefined, -1]) assert.ok(H.healthOf({ faults: f, chk: { w: 'ok' } }).unknown.includes('fault'), String(f));
  assert.equal(H.healthOf({ faults: 0, chk: {} }).items[0].pts, 0, '0건은 견준 것(감점 0)');
  // 견준 것이 하나도 없으면 점수 없음(못 읽어서 100 점이 되지 않는다)
  assert.deepEqual(H.healthOf({ faults: null, chk: { w: 'unknown', fw: 'none', bios: 'unsent' } }), { score: null, band: 'none', items: [], unknown: ['fault', 'warranty', 'fw', 'bios'], judged: 0 });
  // 갈림(split)은 견준 줄이 있을 때만 감점 없이 견준 것 · 견준 줄 0(fwj · biosj 가 0 · 없음)은 모름(v3.49 반증 A1) · ESXi 행은 펌웨어 · BIOS 를 보지 않는다
  const sp = H.healthOf({ faults: 0, chk: { w: 'ok', fw: 'split', fwj: 3, bios: 'split', biosj: 1 } });
  assert.deepEqual([sp.score, sp.unknown, sp.judged], [100, [], 4], '견준 줄이 있는 갈림은 견준 것');
  const sp0 = H.healthOf({ faults: 0, chk: { w: 'ok', fw: 'split', fwj: 0, bios: 'split' } });
  assert.deepEqual([sp0.score, sp0.unknown, sp0.judged], [100, ['fw', 'bios'], 2], '견준 줄 0 인 갈림은 모름(나머지 둘로 절반)');
  assert.deepEqual(H.healthRowOf({ faults: null, chk: { w: 'unknown', fw: 'split', fwj: 0, bios: 'split', biosj: 0 } }), { b: 'none', u: 4, uk: ['fault', 'warranty', 'fw', 'bios'] }, '견준 것이 없으면 점수 없음(100 점 · 양호가 아니다)');
  // 판정 함수에서 목록 행까지 — 한 대 · 구성요소가 모두 섞임 / 두 대 · BIOS 판 1:1 갈림 → split 이지만 견준 줄 0 → 모름
  const fwMixed = FW.judgeFirmware([{ id: 'a', corp: 'vc-a', model: 'R750', fw: { comps: [{ key: 'NIC|x', type: 'NIC', label: 'x', version: null, mixed: true }], skipped: 0 } }]);
  const rowA = ST.chkRowOf({ fw: fwMixed.get('a') });
  assert.deepEqual([rowA.fw, rowA.fwj], ['split', 0]);
  assert.ok(H.healthOf({ faults: 0, chk: rowA }).unknown.includes('fw'));
  const fwTie = FW.judgeFirmware([
    { id: 'a', corp: 'vc-a', model: 'R750', fw: { comps: [{ key: 'BIOS|bios', type: 'BIOS', label: 'BIOS', version: '2.19.1', mixed: false }], skipped: 0 } },
    { id: 'b', corp: 'vc-a', model: 'R750', fw: { comps: [{ key: 'BIOS|bios', type: 'BIOS', label: 'BIOS', version: '2.20.0', mixed: false }], skipped: 0 } }]);
  assert.deepEqual(['a', 'b'].map((k) => ST.chkRowOf({ fw: fwTie.get(k) }).fwj), [0, 0]);
  assert.deepEqual(H.healthOf({ kind: 'esxi', faults: 0, chk: { w: 'expired' } }).unknown, []);
  // 경계
  assert.deepEqual([H.bandOf(100), H.bandOf(90), H.bandOf(89), H.bandOf(70), H.bandOf(69), H.bandOf(0), H.bandOf(null), H.bandOf('')], ['ok', 'ok', 'warn', 'warn', 'bad', 'bad', 'none', 'none']);
  // 목록 행 꼴
  assert.deepEqual(H.healthRowOf({ faults: 1, chk: { w: 'ok', fw: 'ok', bios: 'ok' } }), { s: 88, b: 'warn', u: 0, uk: [], d: [['fault', 12, 1]], z: [['warranty', 'ok'], ['fw', 'ok'], ['bios', 'ok']] });
  assert.deepEqual(H.healthRowOf({ faults: null, chk: {} }), { b: 'none', u: 4, uk: ['fault', 'warranty', 'fw', 'bios'] });
  assert.deepEqual(H.healthRowOf({ faults: 0, chk: { w: 'ok', fw: 'ok', bios: 'ok' } }), { s: 100, b: 'ok', u: 0, uk: [], z: [['fault'], ['warranty', 'ok'], ['fw', 'ok'], ['bios', 'ok']] });
});

// ───────── ⑥ 위치 LED ─────────
test('⑥ 위치 LED — Redfish 값 대응 · 모르는 값은 못 읽음(꺼짐이 아니다) · 인벤토리 상세 · 중앙 정제', async () => {
  assert.deepEqual(['Lit', 'Blinking', 'Off', 'on', 'blink', 'off', ' LIT '].map(LED.ledStateOf), ['on', 'blink', 'off', 'on', 'blink', 'off', 'on']);
  for (const v of ['', 'Unknown', null, 7, {}, 'constructor', '__proto__', 'x'.repeat(99)]) assert.equal(LED.ledStateOf(v), '', String(v));
  assert.equal(hwDetailOf({ system: { indicatorLED: 'Blinking' } }).idrac.led, 'blink');
  assert.equal(hwDetailOf({ system: {} }).idrac.led, '');
  // 중앙 fleet — 검증된 이름만 · 아는 값만
  fleet.resetEdgeFleet();
  fleet.setEdgeFleet('synth-edge', [{ fleetId: 'synth01', name: 'synth-db-01', serviceTag: 'SYNTH01', led: 'Blinking' }, { fleetId: 'synth02', name: 'synth-db-02', serviceTag: 'SYNTH02', led: 'evil' }], Date.now(), { verified: true });
  const out = fleet.getEdgeFleetServers();
  assert.deepEqual(out.map((x) => [x.serviceTag, x.led]), [['SYNTH01', 'blink'], ['SYNTH02', undefined]]);
  fleet.resetEdgeFleet();
  fleet.setEdgeFleet('synth-edge', [{ fleetId: 'synth01', name: 'synth-db-01', serviceTag: 'SYNTH01', led: 'on' }], Date.now(), { verified: false });
  assert.equal(fleet.getEdgeFleetServers()[0].led, undefined, '검증되지 않은 이름은 받지 않는다');
  fleet.resetEdgeFleet();
});

// ───────── ⑤ 하드웨어 이벤트 로그 ─────────
test('⑤ SEL 줄 · 등급 · 수 · 정제 · 가림', () => {
  assert.deepEqual(L.hwLogRow({ Created: '2026-11-25T03:12:00Z', Severity: 'Critical', MessageId: 'PSU0003', SensorType: 'Power Supply', Message: 'Power supply 2 lost input.\u0001' }),
    { at: Date.parse('2026-11-25T03:12:00Z'), created: Date.parse('2026-11-25T03:12:00Z'), sev: 'critical', code: 'PSU0003', sensor: 'Power Supply', msg: 'Power supply 2 lost input.', kind: 'any' });
  assert.deepEqual([L.hwLogRow({ Created: '1970-01-01T00:00:00Z' }).at, L.hwLogRow({ Created: 'x' }).at, L.hwLogRow({ Severity: 'Bogus' }).sev], [null, null, '']);
  assert.equal(L.hwLogRow(null), null); assert.equal(L.hwLogRow([]), null);
  assert.equal(L.hwLogRow({ Message: 'x'.repeat(5000) }).msg.length, L.HWLOG_MSG_MAX);
  assert.deepEqual(L.countsOf([{ sev: 'critical' }, { sev: 'warning' }, { sev: 'ok' }, { sev: '' }, null]), { critical: 1, warning: 1, ok: 1, other: 2 });
  // 엣지 응답 정제
  const now = 1_800_000_000_000;
  const s = L.sanitizeHwLog({ ok: true, at: now + 9e9, status: 'ok', read: '3', total: 5, pages: 1, stopped: 'evil', secret: 1,
    rows: [{ at: now + 9e9, sev: 'critical', code: 'A', msg: 'm', host: '192.0.2.9' }, { at: 'x', sev: 'nope', msg: 7 }, null, 'x'] }, now);
  assert.deepEqual(s, { ok: true, at: now, status: 'ok', read: 3, total: 5, pages: 1, gap: 0, stopped: '', rows: [{ at: now, sev: 'critical', code: 'A', sensor: '', msg: 'm' }, { at: null, sev: '', code: '', sensor: '', msg: '7' }], counts: { critical: 1, warning: 0, ok: 0, other: 1 } });
  assert.equal(L.sanitizeHwLog({ ok: true, rows: Array.from({ length: 900 }, () => ({ msg: 'x' })) }).rows.length, L.HWLOG_EVENTS_MAX);
  assert.equal(L.sanitizeHwLog({ ok: true, status: 'pwn', rows: [] }).status, 'error');
  assert.equal(L.sanitizeHwLog({ ok: false, rows: [] }), null); assert.equal(L.sanitizeHwLog(null), null);
  // 가림 — IPv4 · 이 서버 태그(대소문자 무시)
  assert.equal(L.maskHwLogText('iDRAC IP changed to 192.0.2.44 on idrac-synth01 (SYNTH01)', { tag: 'Synth01' }), 'iDRAC IP changed to ••• on idrac-••• (•••)');
  assert.equal(L.maskHwLogText('no tag here', { tag: '' }), 'no tag here');
  assert.equal(L.maskHwLogText('abc', { tag: 'ab' }), 'abc', '짧은 태그(4자 미만)는 가리지 않는다 — 낱말 조각을 가리지 않게');
  assert.equal(L.sanitizeHwLog({ ok: true, status: 'auth-stopped', gap: '24', rows: [] }).status, 'auth-stopped');
  assert.equal(L.sanitizeHwLog({ ok: true, gap: '24', rows: [] }).gap, 24);
  assert.equal(L.sanitizeHwLog({ ok: true, gap: -1, rows: [] }).gap, 0);
  // 가림을 넓힘(반증 A3 · A9) — IPv6 · MAC · 호스트 이름 · 낱말에 붙은 IPv4 · ‘for 계정 from’ 꼴 계정 · 길이가 바뀌는 글자 뒤의 태그
  const M = (x) => L.maskHwLogText(x, { tag: 'ABC1234' });
  assert.equal(M('Unable to log in for svc_idrac_admin from 2001:db8::77 using GUI.'), 'Unable to log in for ••• from ••• using GUI.');
  assert.equal(M('Successfully logged in using root, from 192.0.2.3 and GUI.'), 'Successfully logged in using •••, from ••• and GUI.');
  assert.equal(M('IP192.0.2.3 changed; host_192.0.2.4'), 'IP••• changed; host_•••');
  assert.equal(M('idrac-x.corp.example.com up'), '••• up');
  assert.equal(M('NIC aa:bb:cc:dd:ee:ff and AA-BB-CC-DD-EE-FF'), 'NIC ••• and •••');
  assert.equal(M('(fe80::1%eth0) [2001:db8::1]:443'), '(•••) [•••]:443');
  assert.equal(M('İİİ ABC1234 failed abc1234'), 'İİİ ••• failed •••', '소문자로 길이가 바뀌는 글자가 앞에 있어도 태그 앞부분이 새지 않는다');
  assert.equal(M('BIOS 2.19.1 updated, iDRAC 7.00.00.00 at 12:34'), 'BIOS 2.19.1 updated, iDRAC 7.00.00.00 at 12:34', '판 번호 · 시각은 그대로');
  // 길이에 비례(앵커 없는 무제한 반복 없음)
  const t0 = Date.now(); for (let i = 0; i < 500; i++) { M('1.'.repeat(150)); M(':'.repeat(300)); M('for '.repeat(75)); } assert.ok(Date.now() - t0 < 2000);
});

test('⑤ 장비 읽기 — 가장 새 300건 · 인증 실패 · 시한 · 경로 없음은 상태로(던지지 않는다)', async () => {
  const H0 = Date.UTC(2026, 10, 20);
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ Id: String(i), Created: new Date(H0 + i * 60_000).toISOString(), Severity: i % 7 ? 'OK' : 'Warning', Message: `m${i}`, MessageId: `C${i}` }));
  const all = mk(420);   // 오래된 것부터 주는 장비
  const getJson = async (_e, p) => {
    if (p === '/redfish/v1/Managers') return { Members: [{ '@odata.id': '/redfish/v1/Managers/iDRAC.Embedded.1' }] };
    const skip = Number((/\$skip=(\d+)/.exec(p) || [])[1] || 0);
    const page = all.slice(skip, skip + 50);
    return { Members: page, 'Members@odata.count': all.length, ...(skip + 50 < all.length ? { 'Members@odata.nextLink': 'x' } : {}) };
  };
  const r = await L.readHwLog({ host: 'https://192.0.2.10', username: 'u', password: 'p' }, { getJson });
  assert.deepEqual([r.ok, r.status, r.read, r.total, r.rows.length], [true, 'ok', 420, 420, L.HWLOG_EVENTS_MAX]);
  assert.equal(r.rows[0].msg, 'm419', '가장 새 것부터'); assert.equal(r.rows.at(-1).msg, 'm120');
  assert.equal(Object.hasOwn(r.rows[0], 'created'), false, '정렬 열쇠는 결과에서 뺀다');
  assert.equal(r.counts.warning + r.counts.ok, L.HWLOG_EVENTS_MAX);
  const auth = await L.readHwLog({ host: 'x' }, { getJson: async () => { const e = new Error('401'); e.status = 401; throw e; } });
  assert.deepEqual([auth.status, auth.rows.length], ['auth', 0]);
  const slow = await L.readHwLog({ host: 'x' }, { timeoutMs: 30, getJson: (_e, _p, { signal }) => new Promise((_r, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))) });
  assert.equal(slow.status, 'timeout');
  const absent = await L.readHwLog({ host: 'x' }, { getJson: async (_e, p) => { if (p === '/redfish/v1/Managers') return { Members: [{ '@odata.id': '/redfish/v1/Managers/iDRAC.Embedded.1' }] }; const e = new Error('404'); e.status = 404; throw e; } });
  assert.equal(absent.status, 'absent');
  // 데모 — 키로 정해진다 · 데모 표지
  const d1 = L.demoHwLog('st:synth01', H0); const d2 = L.demoHwLog('st:synth01', H0);
  assert.deepEqual(d1, d2); assert.equal(d1.demo, true); assert.ok(d1.rows.every((x) => /\(demo\)/.test(x.msg)));
});

// ───────── 라우트 공통 ─────────
const routes = new Map(); const admRoutes = new Map();
registerBmFolders({ get: (p, ...h) => routes.set(`GET ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h) });
svcinv.registerSvcInventory({ get: (p, ...h) => routes.set(`GET ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h) });
registerBmAssets({ get: (p, ...h) => admRoutes.set(`GET ${p}`, h), post: (p, ...h) => admRoutes.set(`POST ${p}`, h) });
const ADMIN = { username: 'admin', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: [] } };
const OPER = { username: 'oper1', role: 'operator', scope: { vcenters: [], regions: [], writeVcenters: [] } };
const VIEWER = { username: 'viewer1', role: 'viewer', scope: { vcenters: [], regions: [], writeVcenters: [] } };
const SCOPED_A = { username: 'scoped-a', role: 'operator', scope: { vcenters: ['vc-a'], regions: [], writeVcenters: [] } };
const SCOPED_B = { username: 'scoped-b', role: 'operator', scope: { vcenters: ['vc-b'], regions: [], writeVcenters: [] } };
const READONLY_A = { username: 'ro-a', role: 'operator', scope: { vcenters: ['vc-a', 'vc-b'], regions: [], writeVcenters: ['vc-b'] } };
let gen = 0;
const mkRes = () => ({ statusCode: 200, headers: {}, body: undefined, headersSent: false,
  status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; this.headersSent = true; return this; },
  setHeader(k, v) { this.headers[k] = v; }, set(k, v) { this.headers[k] = v; return this; }, end() { this.headersSent = true; return this; }, send(x) { this.body = x; this.headersSent = true; return this; } });
async function call(key, { user = ADMIN, query = {}, body = {}, table = routes } = {}) {
  const res = mkRes();
  await table.get(key).at(-1)({ user, query, body, ip: '127.0.0.1', headers: {}, originalUrl: `${key.replace(/^\w+ /, '/api')}?${new URLSearchParams(query)}&u=${user.username}&g=${gen}` }, res);
  return res;
}
const snapOf = () => ({ ...store.snapshot, initial: false, generatedAt: Date.now() + 1000 + (gen += 7),
  vcenters: [{ id: 'vc-a', name: 'vcenter-a', status: 'ok' }, { id: 'vc-b', name: 'vcenter-b', status: 'ok' }], hosts: [], vms: [] });
const withSnap = async (fn) => { const prev = store.snapshot; try { store.snapshot = snapOf(); return await fn(); } finally { store.snapshot = prev; } };
const TAG = (i) => `SYNTH${String(i).padStart(2, '0')}`;
const INV = (tag, extra = {}) => ({ collectedAt: 1_790_000_000_000, collections: { system: 'ok', events: 'ok' }, system: { hostName: `os-${tag}`, model: 'PowerEdge R750', manufacturer: 'Dell Inc.', serviceTag: tag, indicatorLED: 'Off' },
  firmware: [{ type: 'BIOS', name: 'BIOS', version: '2.19.1' }, { type: 'iDRAC', name: 'Integrated Dell Remote Access Controller', version: '7.00.00.171' }], idrac: { firmwareVersion: '7.00.00.171' },
  events: [{ severity: 'Critical', created: '2026-11-21T14:40:00Z', message: 'Drive 4 failed on 192.0.2.77 SYNTH01' }], ...extra });
function reset() {
  bs._resetForTest(); sm._resetForTest(); fleet.resetEdgeFleet();
  for (const st of [S.caseStore, S.advisoryStore, S.assetStore, S.fwBaselineStore]) st._resetForTest();
  for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { recursive: true, force: true });
  fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify({ rev: 0, globals: [], settings: { tagCategory: '' }, corps: {} }));
  fs.writeFileSync(path.join(tmp, 'service-map-pins.json'), JSON.stringify({ rev: 0, pins: {} }));
  const S1 = (i, vc) => ({ id: `s${i}`, name: `synth-db-s${i}`, host: `https://192.0.2.${10 + i}`, username: 'root', password: 'x', serviceTag: TAG(i), model: 'PowerEdge R750', vcenterId: vc });
  registry.importServers([S1(1, 'vc-a'), S1(2, 'vc-a'), S1(3, 'vc-b')], 'replace');
  for (const i of [1, 2, 3]) invCache.setInventory(`s${i}`, INV(TAG(i)));
}
const keyOfName = async (name, user = ADMIN) => (await call('GET /tools/bm-folders', { user })).body.servers.find((x) => x.name === name)?.key;

test('⑩ · ⑥ 목록 — 행마다 건강 점수(hs) · 규칙 · 경계는 응답에 · 드로어 하드웨어에 LED', async () => {
  reset();
  await withSnap(async () => {
    const list = (await call('GET /tools/bm-folders')).body;
    assert.equal(list.ok, true, JSON.stringify(list).slice(0, 300));
    assert.deepEqual([list.check.health.rules.fault.per, list.check.health.bands[0].min], [12, 90]);
    const r1 = list.servers.find((x) => x.name === 'synth-db-s1');
    assert.ok(r1.hs && (r1.hs.b === 'none' || Number.isFinite(r1.hs.s)), JSON.stringify(r1.hs));
    assert.ok(Number.isFinite(r1.hs.u));
    const hw = (await call('GET /tools/bm-folders/hw', { query: { key: r1.key } })).body;
    assert.equal(hw.detail.idrac.led, 'off');
  });
});

test('⑤ /hwlog — 이 노드 서버는 이 노드가 · 엣지 서버는 그 엣지가 · 60초 합치기 · 가림(관리자 판본만 원문) · 실패 사유는 관리자만 · ESXi · 404', async () => {
  reset();
  const calls = [];
  const fakeLog = { ok: true, at: 1, status: 'ok', read: 2, total: 2, pages: 1, stopped: '', counts: { critical: 1, warning: 0, ok: 1, other: 0 },
    rows: [{ at: 2, sev: 'critical', code: 'PSU0003', sensor: 'Power Supply', msg: 'PSU lost on 192.0.2.50 for SYNTH01' }, { at: 1, sev: 'ok', code: 'X', sensor: '', msg: 'ok' }] };
  const deps = {
    resolvePerfTarget: async () => null, perfTargetFail: () => ({}), targets: {},
    hwLogEntry: async (id) => { calls.push(['entry', id]); return id === 's1' ? { id, host: 'https://192.0.2.11' } : null; },
    hwLogLocal: async (entry) => { calls.push(['local', entry.id]); return fakeLog; },
    hwLogEdge: async (agent, q) => { calls.push(['edge', agent, q]); return agent === 'old-edge' ? { ok: false, kind: 'old-version', reason: "엣지 'old-edge' 구버전 192.0.2.99" } : { ok: true, body: fakeLog }; },
    hwLogDemo: async () => null,
  };
  const trendDepsFor = async () => deps;
  _setTrendDepsForTest(deps);
  try {
    await withSnap(async () => {
      const k1 = await keyOfName('synth-db-s1');
      const a = (await call('GET /tools/bm-folders/hwlog', { query: { key: k1 } })).body;
      assert.deepEqual([a.ok, a.via, a.status, a.rows.length, a.counts.critical], [true, 'local', 'ok', 2, 1]);
      assert.match(a.rows[0].msg, /192\.0\.2\.50/, '전체 범위 관리자는 원문');
      const op = (await call('GET /tools/bm-folders/hwlog', { user: OPER, query: { key: k1 } })).body;
      assert.equal(op.rows[0].msg, 'PSU lost on ••• for •••', '운영자 판본은 주소 · 태그를 가린다');
      assert.equal(calls.filter((c) => c[0] === 'local').length, 1, '60초 안 같은 서버는 장비에 한 번만');
      // 범위 밖 · 없는 키
      assert.equal((await call('GET /tools/bm-folders/hwlog', { user: SCOPED_B, query: { key: k1 } })).statusCode, 404);
      assert.equal((await call('GET /tools/bm-folders/hwlog', { query: { key: 'st:nope' } })).statusCode, 404);
      // 범위 밖 서버의 토큰을 손에 넣어도(같은 프로세스 HMAC) 범위 안 후보에서만 되돌린다
      const tokA = (await call('GET /tools/bm-folders', { user: SCOPED_A })).body.servers.find((x) => x.name === 'synth-db-s1').key;
      assert.equal((await call('GET /tools/bm-folders/hwlog', { user: SCOPED_B, query: { key: tokA } })).statusCode, 404);
      assert.equal((await call('GET /tools/bm-folders/hwlog', { user: SCOPED_A, query: { key: tokA } })).statusCode, 200);
      // 범위가 지정된 관리자는 전체 범위 관리자가 아니다 — 가린 판본(반증 A4 · M17)
      const SCOPED_ADMIN = { username: 'scoped-adm', role: 'admin', scope: { vcenters: ['vc-a'], regions: [], writeVcenters: [] } };
      const tokSa = (await call('GET /tools/bm-folders', { user: SCOPED_ADMIN })).body.servers.find((x) => x.name === 'synth-db-s1').key;
      assert.equal((await call('GET /tools/bm-folders/hwlog', { user: SCOPED_ADMIN, query: { key: tokSa } })).body.rows[0].msg, 'PSU lost on ••• for •••');
      // 등록부 밖 서버(이 노드에 없음) — 읽을 길이 없다
      const k2 = await keyOfName('synth-db-s2');
      assert.equal((await call('GET /tools/bm-folders/hwlog', { query: { key: k2 } })).body.why, 'no-source');
    });
    // 읽기 실패 사유(주소가 들어갈 수 있다)는 전체 범위 관리자 판본에만
    deps.hwLogLocal = async () => ({ ok: false, kind: 'error', reason: 'fetch failed https://192.0.2.55' });
    _setTrendDepsForTest(deps);
    await withSnap(async () => {
      const k1 = await keyOfName('synth-db-s1');
      const ad = (await call('GET /tools/bm-folders/hwlog', { query: { key: k1 } })).body;
      assert.deepEqual([ad.why, /192\.0\.2\.55/.test(ad.reason || '')], ['edge-fail', true]);
      const op = (await call('GET /tools/bm-folders/hwlog', { user: OPER, query: { key: k1 } })).body;
      assert.deepEqual([op.why, op.reason], ['edge-fail', undefined]);
    });
    // 누가 읽는가(순수) — 엣지 · 수집 서버 · 이 노드 · 읽을 길 없음
    const { hwLogSourceOf } = await import('../src/routes/api/bmFolders.js');
    assert.deepEqual(hwLogSourceOf({ serverId: 'edge:pl-edge:synth08', remoteAgent: 'pl-edge' }), { via: 'edge', agent: 'pl-edge', q: { k: 'synth08' } });
    assert.equal(hwLogSourceOf({ serverId: 'edge:pl-edge:synth08', remoteAgent: 'other' }), null, '이름이 맞지 않는 엣지에 묻지 않는다');
    assert.equal(hwLogSourceOf({ serverId: 'edge:pl-edge:', remoteAgent: 'pl-edge' }), null);
    assert.deepEqual(hwLogSourceOf({ serverId: 'remote:col-1:42' }), { via: 'remote', agent: 'col-1', q: { id: '42' } });
    assert.equal(hwLogSourceOf({ serverId: 'remote:col-1' }), null);
    assert.deepEqual(hwLogSourceOf({ serverId: 's1' }), { via: 'local', id: 's1' });
    assert.equal(hwLogSourceOf({ serverId: 'host:vc-a:esx-01' }), null);
    assert.equal(hwLogSourceOf({ serverId: '' }), null);
    // 엣지 경로 — 라우트가 그 엣지에 열쇠로 · 구버전 엣지는 old-version(사유는 관리자 판본만) — 가짜 구성원 대신 같은 판정 함수와 가짜 당김으로
    const eOk = await (await trendDepsFor()).hwLogEdge('pl-edge', { k: 'synth08' });
    assert.deepEqual([eOk.ok, eOk.body.rows.length], [true, 2]);
    const eOld = await (await trendDepsFor()).hwLogEdge('old-edge', { k: 'synth09' });
    assert.deepEqual([eOld.ok, eOld.kind], [false, 'old-version']);
  } finally { _setTrendDepsForTest(null); fleet.resetEdgeFleet(); }
});

test('⑤ 수집 서버 경로 — 토큰이 먼저 · 데모 모드는 합성 · 등록부 밖 404 · 소스 스윕(읽기만 · 최소 버전은 노트에서)', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const col = stripComments(fs.readFileSync(new URL('../src/routes/collector.js', import.meta.url), 'utf8'));
  assert.match(col, /collectorRouter\.get\('\/bm-hwlog', tokenFirst\('bm-hwlog'\), async/);
  const pull = stripComments(fs.readFileSync(new URL('../src/central/bmHwLogPull.js', import.meta.url), 'utf8'));
  assert.match(pull, /minVersion: hwlogMinEdgeVersion\(\)/); assert.match(pull, /retries: 0/); assert.doesNotMatch(pull, /minVersion:\s*'\d/);
  const hw = stripComments(fs.readFileSync(new URL('../src/idrac/hwLog.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(hw, /method:\s*'(POST|PATCH|PUT|DELETE)'|redfishPost|redfishPatch/, '읽기만');
  const MV = await import('../src/central/featureMinEdgeVersion.js');
  assert.ok(MV.HWLOG_TITLE_RE.test('물리서버 — 하드웨어 이벤트 로그 · 건강 점수'));
});

test('⑫ 케이스 — 저장 · 이력(상태 · 번호가 바뀔 때만) · 상한 · 다른 서버의 케이스는 고치지 않는다 · 손상이면 쓰기 거절', () => {
  reset();
  const a = S.upsertCase({ tag: 'SYNTH01', part: '디스크 Bay 4', status: 'open', by: 'oper1', now: 1000, newId: 'c-test-0001' });
  assert.deepEqual(a, { ok: true, id: 'c-test-0001', changed: true });
  const b = S.upsertCase({ id: 'c-test-0001', tag: 'synth01', part: '디스크 Bay 4', caseNo: 'SR-SYNTH-1', status: 'parts', by: 'oper1', now: 2000 });
  assert.equal(b.changed, true);
  assert.equal(S.upsertCase({ id: 'c-test-0001', tag: 'SYNTH01', part: '디스크 Bay 4', caseNo: 'SR-SYNTH-1', status: 'parts', by: 'x', now: 3000 }).changed, false, '같은 값이면 바뀌지 않음');
  const n = S.upsertCase({ id: 'c-test-0001', tag: 'SYNTH01', part: '디스크 Bay 4', caseNo: 'SR-SYNTH-1', status: 'parts', note: '부품 배송 중', by: 'x', now: 4000 });
  assert.equal(n.changed, true);
  const c = S.casesOfTag('SYNTH01')[0];
  assert.deepEqual([c.status, c.caseNo, c.note, c.created, c.hist.length, c.hist.map((h) => h.status)], ['parts', 'SR-SYNTH-1', '부품 배송 중', 1000, 2, ['open', 'parts']], '비고만 바뀌면 이력 줄을 더하지 않는다');
  assert.equal(c.corp, '', '법인을 함께 적는다(이 픽스처는 법인 없음)');
  assert.equal(S.upsertCase({ id: 'c-test-0001', tag: 'SYNTH02', status: 'open' }).status, 404, '다른 서버의 케이스 — 찾지 못함(있음을 드러내지 않는다)');
  assert.equal(S.upsertCase({ id: 'c-test-0001', tag: 'SYNTH01', corp: 'vc-x', status: 'open' }).status, 404, '같은 태그라도 다른 법인의 케이스는 고치지 않는다(반증 A2)');
  assert.equal(S.casesOfTag('SYNTH01', { corp: 'vc-x' }).length, 0, '다른 법인으로는 읽히지 않는다');
  // 끝난 케이스만 지운다 · 다른 법인 · 다른 서버는 404
  assert.equal(S.removeCase({ id: 'c-test-0001', tag: 'SYNTH01' }).status, 400, '진행 중인 케이스는 지우지 않는다');
  S.upsertCase({ id: 'c-test-0001', tag: 'SYNTH01', part: '디스크 Bay 4', caseNo: 'SR-SYNTH-1', status: 'closed', note: '부품 배송 중', by: 'x', now: 5000 });
  assert.equal(S.removeCase({ id: 'c-test-0001', tag: 'SYNTH01', corp: 'vc-x' }).status, 404);
  assert.equal(S.removeCase({ id: 'c-test-0001', tag: 'SYNTH02' }).status, 404);
  assert.equal(S.removeCase({ id: '__proto__', tag: 'SYNTH01' }).status, 404);
  assert.equal(S.removeCase({ id: 'c-test-0001', tag: 'SYNTH01' }).ok, true);
  assert.equal(S.casesOfTag('SYNTH01').length, 0);
  S.upsertCase({ tag: 'SYNTH01', part: '디스크 Bay 4', caseNo: 'SR-SYNTH-1', status: 'parts', note: '부품 배송 중', by: 'x', now: 4000, newId: 'c-test-0001' });
  assert.equal(S.upsertCase({ id: 'c-nope-0001', tag: 'SYNTH01', status: 'open' }).status, 404);
  assert.equal(S.upsertCase({ tag: '', status: 'open' }).status, 400);
  assert.equal(S.upsertCase({ tag: 'SYNTH01', status: 'evil' }).status, 400);
  assert.equal(S.casesOfTag('synth02').length, 0);
  // 손상 → 쓰기 거절 · 빈 기록으로 덮지 않는다
  S.caseStore._resetForTest(); fs.writeFileSync(path.join(tmp, 'bm-cases.json'), '{oops');
  const w = console.error; const ww = console.warn; console.error = () => {}; console.warn = () => {};
  try {
    assert.equal(S.upsertCase({ tag: 'SYNTH01', status: 'open' }).status, 409);
    // 손상본은 보존된다(공용 로더가 옆으로 옮겨 둔다) · 빈 기록으로 새 파일을 쓰지 않았다
    const kept = fs.readdirSync(tmp).filter((f) => f.startsWith('bm-cases.json'));
    assert.ok(kept.some((f) => fs.readFileSync(path.join(tmp, f), 'utf8') === '{oops'), kept.join(','));
    assert.equal(kept.some((f) => /"cases"/.test(fs.readFileSync(path.join(tmp, f), 'utf8'))), false);
  } finally { console.error = w; console.warn = ww; }
  // 모르는 꼴은 손상이다
  S.caseStore._resetForTest(); fs.writeFileSync(path.join(tmp, 'bm-cases.json'), JSON.stringify({ v: 2, cases: {} }));
  console.error = () => {}; console.warn = () => {};
  try { assert.ok(S.caseStore.loadError()); } finally { console.error = w; console.warn = ww; }
  reset();
});

test('⑫ 케이스 라우트 — 조회 계정은 읽기만(canWrite false · 쓰기 403) · 쓰기 범위 밖 403 · 조회 밖 404 · 태그 없는 서버 · 감사 대상 · 접수 자료 묶음 가림', async () => {
  reset();
  await withSnap(async () => {
    const k1 = await keyOfName('synth-db-s1');
    const g = (await call('GET /tools/bm-folders/cases', { query: { key: k1 } })).body;
    assert.deepEqual([g.ok, g.cases, g.canWrite, g.statuses], [true, [], true, ['open', 'parts', 'replaced', 'closed']]);
    assert.equal((await call('GET /tools/bm-folders/cases', { user: VIEWER, query: { key: k1 } })).body.canWrite, false);
    assert.equal((await call('POST /tools/bm-folders/cases', { user: VIEWER, body: { key: k1, status: 'open' } })).statusCode, 403);
    // 쓰기 범위 밖(vc-a 는 조회만) — 403 · 조회 밖 — 404
    const tokRo = (await call('GET /tools/bm-folders', { user: READONLY_A })).body.servers.find((x) => x.name === 'synth-db-s1').key;
    const ro = await call('POST /tools/bm-folders/cases', { user: READONLY_A, body: { key: tokRo, status: 'open' } });
    assert.deepEqual([ro.statusCode, /조회 전용/.test(ro.body.reason)], [403, true]);
    assert.equal((await call('POST /tools/bm-folders/cases', { user: SCOPED_B, body: { key: k1, status: 'open' } })).statusCode, 404);
    // 적기 → 읽기
    const w = await call('POST /tools/bm-folders/cases', { user: OPER, body: { key: k1, part: '디스크 Bay 4', caseNo: 'SR-SYNTH-9', status: 'open', note: '접수' } });
    assert.deepEqual([w.statusCode, w.body.ok, w.body.changed], [200, true, true]);
    const g2 = (await call('GET /tools/bm-folders/cases', { query: { key: k1 } })).body;
    assert.deepEqual(g2.cases.map((c) => [c.part, c.caseNo, c.status, c.by]), [['디스크 Bay 4', 'SR-SYNTH-9', 'open', 'oper1']]);
    assert.equal((await call('POST /tools/bm-folders/cases', { user: OPER, body: { key: k1, status: 'evil' } })).statusCode, 400);
    // 접수 자료 묶음 — 관리자 판본도 기록 글자는 가린다(제조사에 붙여 보내는 파일 · 반증 A3) · 범위 계정은 태그를 싣지 않는다
    const bAdm = JSON.parse((await call('GET /tools/bm-folders/case-bundle', { query: { key: k1 } })).body);
    assert.deepEqual([bAdm.kind, bAdm.server.serviceTag, bAdm.server.model], ['bm-support-bundle', 'SYNTH01', 'PowerEdge R750']);
    assert.equal(bAdm.recentEvents[0].msg, 'Drive 4 failed on ••• •••');
    const bOp = JSON.parse((await call('GET /tools/bm-folders/case-bundle', { user: OPER, query: { key: k1 } })).body);
    assert.equal(bOp.recentEvents[0].msg, 'Drive 4 failed on ••• •••');
    const tokA = (await call('GET /tools/bm-folders', { user: SCOPED_A })).body.servers.find((x) => x.name === 'synth-db-s1').key;
    const bSc = JSON.parse((await call('GET /tools/bm-folders/case-bundle', { user: SCOPED_A, query: { key: tokA } })).body);
    assert.equal(bSc.server.serviceTag, undefined);
    assert.equal(/192\.0\.2\.|password|username/.test(JSON.stringify(bSc)), false);
  });
});

test('④ 권고 CSV — 별칭 · 필수 열 · 오류 줄(번호 없음 · 모르는 종류 · 숫자 아닌 고친 버전 · 모르는 심각도 · http 아닌 링크 · 중복) · 내보내기 왕복', () => {
  const p = ADV.parseAdvisoryCsv('﻿권고 번호,심각도,종류,모델,구성요소,고친 버전,제목,링크\r\nSYN-1,높음,BIOS,R750,,2.20.0,합성 권고,https://example.test/a\r\n\r\nSYN-2,,iDRAC,,,7.10.30.00,,\r\n,high,BIOS,,,1\r\nSYN-3,high,PSU,,,1\r\nSYN-4,high,NIC,,,abc\r\nSYN-5,odd,NIC,,,1\r\nSYN-6,low,NIC,,,1,,javascript:alert(1)\r\nSYN-1,high,BIOS,r750,,2.21.0\r\n');
  assert.deepEqual(p.rows.map((r) => [r.id, r.sev, r.type, r.model, r.fixed]), [['SYN-1', 'high', 'BIOS', 'r750', '2.20.0'], ['SYN-2', 'medium', 'iDRAC', '', '7.10.30.00']]);
  assert.deepEqual(p.errors.map((e) => e.line), [5, 6, 7, 8, 9, 10], JSON.stringify(p.errors));
  assert.equal(ADV.parseAdvisoryCsv('id,severity\nA,high\n').errors[0].line, 1, '필수 열 없음');
  assert.equal(ADV.parseAdvisoryCsv('').errors.length, 1);
  const back = ADV.parseAdvisoryCsv(ADV.advisoriesToCsv(p.rows));
  assert.deepEqual(back.rows, p.rows);
  assert.deepEqual(ADV.parseAdvisoryCsv(ADV.sampleAdvisoryCsv()).rows, [], '양식에는 권고를 지어 넣지 않는다');
});

test('④ 권고 대조 — 표가 비면 대조하지 않음 · 펌웨어를 못 읽음 · 걸림 · 숫자 아닌 버전은 모름 · 섞인 줄은 보지 않음 · 심각도 순', () => {
  const fw = [{ type: 'BIOS', label: 'BIOS', installed: '2.19.1' }, { type: 'iDRAC', label: 'Integrated Dell Remote Access Controller', installed: '7.00.00.171' },
    { type: 'NIC', label: 'Synth NIC', installed: 'X1' }, { type: 'NIC', label: 'Other NIC', installed: '1.0', mixed: true }];
  const T = [{ id: 'A', sev: 'low', type: 'BIOS', model: '', comp: '', fixed: '2.20.0' }, { id: 'B', sev: 'critical', type: 'iDRAC', model: 'r750', comp: 'remote access', fixed: '7.10' },
    { id: 'C', sev: 'high', type: 'NIC', model: '', comp: 'synth', fixed: '2.0' }, { id: 'D', sev: 'high', type: 'NIC', model: '', comp: 'other', fixed: '9' }, { id: 'E', sev: 'high', type: 'BIOS', model: 'r650', comp: '', fixed: '9' }];
  assert.deepEqual(ADV.advisoriesFor({ model: 'PowerEdge R750', rows: fw }, []), { state: 'no-table', hits: [], total: 0, unknown: 0, checked: 0 });
  assert.deepEqual(ADV.advisoriesFor({ model: 'PowerEdge R750', rows: null }, T).state, 'no-fw');
  const r = ADV.advisoriesFor({ model: 'PowerEdge R750', rows: fw }, T);
  // 섞인 줄(Other NIC)은 권고 D 에 맞지만 견줄 수 없다 — 모름으로 센다(‘걸린 것 없음’ 에 숨지 않는다 · 반증 A6)
  assert.deepEqual([r.state, r.hits.map((h) => h.id), r.total, r.unknown, r.checked], ['hit', ['B', 'A'], 2, 2, 4]);
  assert.deepEqual(ADV.advisoriesFor({ model: 'PowerEdge R750', rows: [fw[3]] }, T).state, 'unknown', '섞인 줄만 맞으면 판정 못 함');
  assert.equal(ADV.advisoriesFor({ model: 'PowerEdge R650', rows: [{ type: 'iDRAC', label: 'x', installed: '1' }] }, [T[1]]).state, 'unmatched', '맞는 권고 줄이 없으면 ‘걸린 것 없음’ 이 아니다(반증 B2)');
  // 걸린 수는 자르기 전 수(반증 A7)
  const big = Array.from({ length: 80 }, (_, i) => ({ id: `Z${i}`, sev: 'low', type: 'BIOS', model: '', comp: '', fixed: '9' }));
  const r80 = ADV.advisoriesFor({ model: 'R750', rows: [{ type: 'BIOS', label: 'BIOS', installed: '1.0' }] }, big);
  assert.deepEqual([r80.hits.length, r80.total, ST.chkRowOf({ adv: r80 }).adv], [50, 80, 80]);
  // 원형 열쇠는 오류 줄(반증 A8) — 검증과 저장이 같은 판정
  const pp = ADV.parseAdvisoryCsv('advisory_id,severity,component_type,fixed_version\nP1,constructor,BIOS,1.0\nP2,high,constructor,1.0\nP3,__proto__,BIOS,1.0\nP4,high,__proto__,1.0\nP5,high,BIOS,1.0\n');
  assert.deepEqual([pp.rows.map((x) => x.id), pp.errors.map((e) => e.line)], [['P5'], [2, 3, 4, 5]]);
  assert.equal(ADV.parseAdvisoryCsv('constructor,advisory_id,component_type,fixed_version\nx,P1,BIOS,1.0\n').rows.length, 1, '머리글 원형 이름은 모르는 열(무시)');
  assert.equal(ADV.advisoriesFor({ model: 'PowerEdge R750', rows: [{ type: 'BIOS', label: 'BIOS', installed: '2.20.0' }] }, T).state, 'clear', '같은 버전은 걸리지 않는다');
});

test('④ 관리 라우트 · 목록 · /check — 검증 뒤 적용 · 오류 줄이 있으면 쓰지 않음 · 미리본 표와 다르면 409 · 목록에 걸림 수 · 범위 계정에는 표 상태를 싣지 않음', async () => {
  reset();
  const csv = 'advisory_id,severity,component_type,model,component,fixed_version\nSYN-ADV-1,critical,BIOS,r750,,2.20.0\n';
  const dry = (await call('POST /bm-advisories/import', { table: admRoutes, body: { csv, dryRun: true } })).body;
  assert.deepEqual([dry.ok, dry.dryRun, dry.rows, dry.errors, dry.base], [true, true, 1, [], { n: 0, at: null }]);
  assert.equal((await call('POST /bm-advisories/import', { table: admRoutes, body: { csv } })).statusCode, 400, '검증 없이 적용하지 않는다');
  assert.equal((await call('POST /bm-advisories/import', { table: admRoutes, body: { csv, dryRun: 'true' } })).statusCode, 400);
  const bad = await call('POST /bm-advisories/import', { table: admRoutes, body: { csv: `${csv}SYN-X,high,PSU,,,1\n`, expect: dry.base } });
  assert.deepEqual([bad.statusCode, S.advisoryStore.get().rows.length], [400, 0], '오류 줄이 있으면 아무것도 쓰지 않는다');
  const ok = await call('POST /bm-advisories/import', { table: admRoutes, body: { csv, expect: dry.base } });
  assert.deepEqual([ok.statusCode, ok.body.changed, S.advisoryStore.get().rows.length], [200, true, 1]);
  assert.equal((await call('POST /bm-advisories/import', { table: admRoutes, body: { csv, expect: dry.base } })).statusCode, 409, '그 사이 표가 바뀌었다');
  const csvOut = (await call('GET /bm-advisories.csv', { table: admRoutes })).body;
  assert.match(csvOut, /SYN-ADV-1,critical,BIOS,r750,,2\.20\.0/);
  await withSnap(async () => {
    const list = (await call('GET /tools/bm-folders')).body;
    assert.deepEqual(list.check.advisories.n, 1);
    const r1 = list.servers.find((x) => x.name === 'synth-db-s1');
    assert.deepEqual([r1.chk.adva, r1.chk.adv, r1.chk.advs], ['hit', 1, 'critical']);
    const d = (await call('GET /tools/bm-folders/check', { query: { key: r1.key } })).body;
    assert.deepEqual([d.adv.state, d.adv.hits[0].id, d.adv.hits[0].installed, d.adv.hits[0].fixed], ['hit', 'SYN-ADV-1', '2.19.1', '2.20.0']);
    assert.deepEqual((await call('GET /tools/bm-folders', { user: SCOPED_A })).body.check.advisories, {});
  });
  // 표 손상 — 대조하지 않았다고 밝힌다(걸린 것 없음이 아니다)
  S.advisoryStore._resetForTest(); fs.writeFileSync(path.join(tmp, 'bm-advisories.json'), '{oops');
  const w = console.error; const ww = console.warn; console.error = () => {}; console.warn = () => {};
  try {
    await withSnap(async () => {
      const list = (await call('GET /tools/bm-folders')).body;
      assert.deepEqual(list.check.advisories, { unreadable: true });
      assert.equal(list.servers.find((x) => x.name === 'synth-db-s1').chk.adva, undefined);
    });
  } finally { console.error = w; console.warn = ww; reset(); }
});

// ───────── v3.49 반증 반영 — 라우트 단(반증 A4 의 생존 변이 M3 · M4 · M11 · M15 · M17 · M24 · M30 · M31 · M32 · M33 · M34) ─────────
const auditLines = () => { try { return fs.readFileSync(path.join(tmp, 'audit.ndjson'), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)); } catch { return []; } };

test('⑫ 케이스 — 범위 계정은 남의 토큰으로도 404(읽기 · 쓰기 · 묶음 · 지우기) · 같은 태그라도 다른 법인 케이스는 읽지도 고치지도 못한다 · 끝난 케이스 지우기 · 감사', async () => {
  reset();
  await withSnap(async () => {
    const k1 = await keyOfName('synth-db-s1');
    // 범위 안 계정의 토큰(같은 프로세스 HMAC)을 범위 밖 계정이 써도 범위 안 후보에서만 되돌린다(M11 — 원문 키만으로는 거르기 삭제를 잡지 못했다)
    const tokA = (await call('GET /tools/bm-folders', { user: SCOPED_A })).body.servers.find((x) => x.name === 'synth-db-s1').key;
    assert.equal((await call('GET /tools/bm-folders/cases', { user: SCOPED_A, query: { key: tokA } })).statusCode, 200);
    for (const [k, opt] of [['GET /tools/bm-folders/cases', { query: { key: tokA } }], ['GET /tools/bm-folders/case-bundle', { query: { key: tokA } }],
      ['POST /tools/bm-folders/cases', { body: { key: tokA, part: 'x', status: 'open' } }], ['POST /tools/bm-folders/cases/delete', { body: { key: tokA, id: 'c-x' } }]]) {
      assert.equal((await call(k, { user: SCOPED_B, ...opt })).statusCode, 404, k);
    }
    // 적기 · 고치기 · 지우기 감사
    const before = auditLines().length;
    const w = await call('POST /tools/bm-folders/cases', { user: OPER, body: { key: k1, part: '디스크 Bay 4', caseNo: 'SR-SYNTH-7', status: 'open' } });
    assert.equal(w.statusCode, 200);
    const id = w.body.id;
    assert.equal((await call('POST /tools/bm-folders/cases', { user: OPER, body: { key: k1, id, part: '디스크 Bay 4', caseNo: 'SR-SYNTH-7', status: 'closed' } })).statusCode, 200);
    assert.equal((await call('POST /tools/bm-folders/cases/delete', { user: VIEWER, body: { key: k1, id } })).statusCode, 403, '조회 계정은 지우지 못한다');
    const tokRo = (await call('GET /tools/bm-folders', { user: READONLY_A })).body.servers.find((x) => x.name === 'synth-db-s1').key;
    assert.equal((await call('POST /tools/bm-folders/cases/delete', { user: READONLY_A, body: { key: tokRo, id } })).statusCode, 403, '쓰기 범위 밖');
    assert.equal((await call('POST /tools/bm-folders/cases/delete', { user: OPER, body: { key: k1, id } })).statusCode, 200);
    assert.deepEqual((await call('GET /tools/bm-folders/cases', { query: { key: k1 } })).body.cases, []);
    const acts = auditLines().slice(before).map((x) => x.action);
    assert.deepEqual(acts, ['물리서버 제조사 케이스 적음', '물리서버 제조사 케이스 고침', '물리서버 제조사 케이스 지움'], JSON.stringify(acts));
    // 접수 자료 묶음 내려받기도 감사
    const b0 = auditLines().length;
    assert.equal((await call('GET /tools/bm-folders/case-bundle', { user: OPER, query: { key: k1 } })).statusCode, 200);
    assert.deepEqual(auditLines().slice(b0).map((x) => x.action), ['물리서버 접수 자료 묶음 내려받기']);
  });
  // 같은 태그(SYNTH01)가 다른 법인 서버로 나타난다 — vc-b 계정이 적은 케이스를 vc-a 계정 · 관리자(vc-a 서버 행)가 읽거나 고치지 못한다(반증 A2 · M30)
  reset();
  registry.importServers([{ id: 's1', name: 'synth-db-s1', host: 'https://192.0.2.11', username: 'root', password: 'x', serviceTag: 'SYNTH01', model: 'PowerEdge R750', vcenterId: 'vc-b' }], 'replace');
  invCache.setInventory('s1', INV('SYNTH01'));
  let caseId = '';
  await withSnap(async () => {
    const kB = (await call('GET /tools/bm-folders', { user: SCOPED_B })).body.servers.find((x) => x.name === 'synth-db-s1').key;
    const w = await call('POST /tools/bm-folders/cases', { user: SCOPED_B, body: { key: kB, part: 'B 법인 디스크', caseNo: 'SR-B-1', status: 'open', note: 'B 법인 메모' } });
    assert.equal(w.statusCode, 200); caseId = w.body.id;
  });
  registry.importServers([{ id: 's9', name: 'synth-other', host: 'https://192.0.2.19', username: 'root', password: 'x', serviceTag: 'SYNTH09', model: 'PowerEdge R750', vcenterId: 'vc-b' }], 'replace');
  registry.importServers([{ id: 's1a', name: 'a-side-box', host: 'https://192.0.2.31', username: 'root', password: 'x', serviceTag: 'SYNTH01', model: 'PowerEdge R750', vcenterId: 'vc-a' }], 'merge');
  invCache.setInventory('s1a', INV('SYNTH01'));
  await withSnap(async () => {
    const kA = (await call('GET /tools/bm-folders', { user: SCOPED_A })).body.servers.find((x) => x.name === 'a-side-box')?.key;
    assert.ok(kA, 'vc-a 쪽 같은 태그 서버');
    assert.deepEqual((await call('GET /tools/bm-folders/cases', { user: SCOPED_A, query: { key: kA } })).body.cases, [], '다른 법인 케이스를 읽지 못한다');
    const kAdm = await keyOfName('a-side-box');
    assert.deepEqual((await call('GET /tools/bm-folders/cases', { query: { key: kAdm } })).body.cases, [], '관리자도 그 서버(vc-a) 행에서는 vc-b 케이스가 보이지 않는다');
    const u = await call('POST /tools/bm-folders/cases', { user: SCOPED_A, body: { key: kA, id: caseId, part: 'A 가 고침', status: 'closed' } });
    assert.equal(u.statusCode, 404, '다른 법인 케이스를 고치지 못한다');
    assert.equal(S.caseStore.get().cases[caseId].part, 'B 법인 디스크');
  });
  reset();
});

test('⑤ 엣지 서버 — /hwlog 가 그 엣지에 열쇠(k)로 묻는다 · old-version · not-found · 실패는 why 로 · 운영자 판본 가림 · /hw 는 요약 없어도 LED(반증 A15)', async () => {
  reset();
  const { config } = await import('../src/config.js');
  const prevTok = config.central.token; config.central.token = 'synth-central-token';
  const calls = [];
  const deps = {
    resolvePerfTarget: async () => null, perfTargetFail: () => ({}), targets: {},
    hwLogEntry: async () => null, hwLogLocal: async () => { calls.push(['local']); return { ok: true, status: 'ok', rows: [] }; },
    hwLogEdge: async (agent, q) => { calls.push(['edge', agent, q]); return deps._edge(agent, q); }, hwLogDemo: async () => null,
    _edge: () => ({ ok: false, kind: 'old-version', reason: '엣지 구버전 192.0.2.99' }),
  };
  _setTrendDepsForTest(deps);
  try {
    fleet.setEdgeFleet('pl-edge', [{ fleetId: 'synth08', name: 'synth-edge-08', serviceTag: 'SYNTH08', model: 'PowerEdge R750', vcenterId: 'vc-a', led: 'Lit', source: 'idrac' },
      { fleetId: 'synth28', name: 'synth-edge-28', serviceTag: 'SYNTH28', model: 'PowerEdge R750', vcenterId: 'vc-a', source: 'idrac' }], 'g1', { verified: true, vcAllowed: () => true });
    await withSnap(async () => {
      const r = (await call('GET /tools/bm-folders')).body.servers.find((x) => x.name === 'synth-edge-08');
      assert.ok(r, '엣지 서버 행');
      const a = (await call('GET /tools/bm-folders/hwlog', { query: { key: r.key } })).body;
      assert.deepEqual([a.via, a.why, /192\.0\.2\.99/.test(a.reason || '')], ['edge', 'old-version', true]);
      assert.deepEqual(calls.at(-1), ['edge', 'pl-edge', { k: 'synth08' }], '그 엣지에 열쇠로 묻는다(id 가 아니다)');
      // 같은 서버는 실패 결과도 잠깐 합친다(15초) — 다른 판정은 다른 서버로 본다
      deps._edge = () => ({ ok: false, kind: 'not-found', reason: 'x 192.0.2.98' });
      const r2 = (await call('GET /tools/bm-folders')).body.servers.find((x) => x.name === 'synth-edge-28');
      const nf = (await call('GET /tools/bm-folders/hwlog', { user: OPER, query: { key: r2.key } })).body;
      assert.deepEqual([nf.why, nf.reason], ['not-found', undefined], '실패 사유는 관리자 판본만');
      assert.deepEqual(calls.at(-1), ['edge', 'pl-edge', { k: 'synth28' }]);
      const hw = (await call('GET /tools/bm-folders/hw', { query: { key: r.key } })).body;
      assert.deepEqual([hw.why, hw.led], ['edge-none', 'on'], '요약이 없어도 엣지가 실은 LED 는 싣는다');
    });
    // 성공 — 운영자 판본은 가린다 · 관리자 판본은 원문
    fleet.resetEdgeFleet();
    fleet.setEdgeFleet('pl-edge2', [{ fleetId: 'synth18', name: 'synth-edge-18', serviceTag: 'SYNTH18', model: 'PowerEdge R750', vcenterId: 'vc-a', source: 'idrac' }], 'g2', { verified: true, vcAllowed: () => true });
    deps._edge = () => ({ ok: true, body: { ok: true, at: 5, status: 'ok', read: 1, total: 1, gap: 0, stopped: '', counts: { critical: 1, warning: 0, ok: 0, other: 0 }, rows: [{ at: 5, sev: 'critical', code: 'X', sensor: '', msg: 'on 192.0.2.9 SYNTH18' }] } });
    _setTrendDepsForTest(deps);
    await withSnap(async () => {
      const r = (await call('GET /tools/bm-folders')).body.servers.find((x) => x.name === 'synth-edge-18');
      const op = (await call('GET /tools/bm-folders/hwlog', { user: OPER, query: { key: r.key } })).body;
      assert.deepEqual([op.via, op.rows[0].msg], ['edge', 'on ••• •••']);
      const ad = (await call('GET /tools/bm-folders/hwlog', { query: { key: r.key } })).body;
      assert.equal(ad.rows[0].msg, 'on 192.0.2.9 SYNTH18');
    });
  } finally { _setTrendDepsForTest(null); fleet.resetEdgeFleet(); config.central.token = prevTok; reset(); }
});

test('⑫ 접수 자료 묶음 — 기록 글자는 판본과 관계없이 가린다(계정 · IPv6) · 계약 번호는 전체 범위 관리자만 · 못 읽은 것은 null + 이유 · 디스크 요약', async () => {
  reset();
  invCache.setInventory('s1', INV('SYNTH01', { events: [{ severity: 'Warning', created: '2026-11-21T14:40:00Z', message: 'Unable to log in for svc_idrac_admin from 2001:db8::77 using GUI.' }] }));
  invCache.setInventory('s2', INV('SYNTH02', { collections: { system: 'ok', events: 'failed' }, events: [] }));
  S.assetStore.save({ v: 1, at: 5, by: 'admin', rows: { synth01: { tag: 'SYNTH01', end: '2027-03-14', type: 'ProSupport', contract: 'CT-SYNTH-1' } } });
  await withSnap(async () => {
    const k1 = await keyOfName('synth-db-s1');
    const adm = JSON.parse((await call('GET /tools/bm-folders/case-bundle', { query: { key: k1 } })).body);
    assert.equal(adm.recentEvents[0].msg, 'Unable to log in for ••• from ••• using GUI.', '관리자 판본도 가린다');
    assert.equal(adm.warranty.contract, 'CT-SYNTH-1', '계약 번호는 전체 범위 관리자 판본');
    assert.equal(JSON.parse((await call('GET /tools/bm-folders/case-bundle', { user: OPER, query: { key: k1 } })).body).warranty.contract, undefined);
    const tokA = (await call('GET /tools/bm-folders', { user: SCOPED_A })).body.servers.find((x) => x.name === 'synth-db-s1').key;
    const sc = JSON.parse((await call('GET /tools/bm-folders/case-bundle', { user: SCOPED_A, query: { key: tokA } })).body);
    assert.deepEqual([sc.warranty.contract, sc.server.serviceTag], [undefined, undefined]);
    assert.ok(Array.isArray(adm.unread));
    assert.equal(adm.faults, null, '부품 장애 기록이 없으면 null(빈 목록이 아니다)');
    assert.ok(adm.unread.some((x) => /^faults:/.test(x)));
    const k2 = await keyOfName('synth-db-s2');
    const b2 = JSON.parse((await call('GET /tools/bm-folders/case-bundle', { query: { key: k2 } })).body);
    assert.equal(b2.recentEvents, null, '이벤트 로그를 못 읽은 주기 — 없음이 아니다');
    assert.ok(b2.unread.some((x) => /^recentEvents:/.test(x)));
    assert.ok(['no-table', null].includes(b2.advisoryCheck));
    assert.ok('disk' in (adm.hardware || { disk: null }), '하드웨어 요약 키는 disk');
  });
  reset();
});

test('⑥ 엣지 pushFleetNow 가 위치 LED 를 싣는다(반증 A4 · M24) · 수집 서버 경로 축약 · 정제에도 짝으로(반증 A5)', async (t) => {
  const http = await import('node:http');
  const zlib = await import('node:zlib');
  const got = [];
  const central = http.createServer((q, r) => {
    const ch = []; q.on('data', (c) => ch.push(c));
    q.on('end', () => {
      let b = Buffer.concat(ch); if ((q.headers['content-encoding'] || '') === 'gzip') b = zlib.gunzipSync(b);
      let body = null; try { body = JSON.parse(b.toString('utf8') || 'null'); } catch { body = null; }
      got.push({ path: q.url.split('?')[0], body });
      r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ ok: true, accepted: Array.isArray(body?.baremetal) ? body.baremetal.length : 0 }));
    });
  });
  await new Promise((ok) => central.listen(0, '127.0.0.1', ok));
  const { config } = await import('../src/config.js');
  const prev = { url: config.agent.centralUrl, tok: config.agent.centralToken, name: config.agent.name };
  t.after(() => { central.close(); Object.assign(config.agent, { centralUrl: prev.url, centralToken: prev.tok, name: prev.name }); });
  reset();
  invCache.setInventory('s2', INV('SYNTH02', { system: { model: 'PowerEdge R750', serviceTag: 'SYNTH02', indicatorLED: 'Blinking' } }));
  config.agent.centralUrl = `http://127.0.0.1:${central.address().port}`; config.agent.centralToken = 'synth-edge-token'; config.agent.name = 'synth-edge';
  const fp = await import('../src/agent/fleetPush.js');
  fp._setFleetWithholdSinceForTest(null, null);
  const w = console.warn; const l = console.log; console.warn = () => {}; console.log = () => {};
  let r;
  try { r = await withSnap(() => fp.pushFleetNow()); } finally { console.warn = w; console.log = l; }
  assert.equal(r?.ok, true, JSON.stringify(r));
  const f = got.find((g) => g.path === '/api/central/fleet');
  const by = (tag) => f.body.baremetal.find((x) => x.serviceTag === tag);
  assert.deepEqual([by('SYNTH01').led, by('SYNTH02').led], ['off', 'blink']);
  // 수집 서버(pull) 경로 — 엣지 축약(compactInv) ↔ 중앙 정제(sanitizeRemoteInv) 짝
  const { compactInv } = await import('../src/collector/compactInv.js');
  const rinv = await import('../src/collector/remoteInventory.js');
  const c = compactInv(INV('SYNTH03', { system: { model: 'PowerEdge R750', serviceTag: 'SYNTH03', indicatorLED: 'Blinking' } }));
  assert.equal(c.system.indicatorLED, 'Blinking');
  assert.equal(hwDetailOf(rinv.sanitizeRemoteInv(c)).idrac.led, 'blink', '수집 서버 서버도 LED 를 읽는다(빠지면 늘 못 읽음)');
  reset();
});

test('⑤ 주 폴러가 인증 실패로 멈춘 서버는 장비에 묻지 않는다(반증 A13) · 기본 판정은 iDRAC 폴러의 정지 기록', async () => {
  let n = 0;
  const r = await L.readHwLog({ id: 'sx', host: 'https://192.0.2.70' }, { getJson: async () => { n += 1; return {}; }, authStopped: () => true });
  assert.deepEqual([r.status, r.rows.length, n], ['auth-stopped', 0, 0]);
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(new URL('../src/idrac/hwLog.js', import.meta.url), 'utf8'));
  assert.match(src, /import\('\.\/poller\.js'\)\)\.idracAuthStopFor\(entry\)/);
});

test('⑫ 묶음 부품 장애 — 그 서버의 수집 주체 · 태그로 SQL 에서 고른다(다른 엣지의 같은 태그 기록은 싣지 않는다 · 반증 A14) · 상세 글자도 가린다', async (t) => {
  let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }
  if (!sqlite) return t.skip('node:sqlite 없음');
  reset();
  const pf = await import('../src/partfault/db.js');
  const P = (agent, tag, part, detail = '') => ({ scope: 'idrac', agent, deviceId: `dev-${agent || 'local'}-${tag}`, deviceKey: tag, deviceKeyKind: 'serviceTag', deviceName: tag,
    partKey: `idrac:${tag}:psu:${part}`, kind: 'psu', partId: part, keyKind: 'fqdd', label: part, detail, state: 'fault', rawState: 'Critical' });
  await pf.applyTransition({ opened: [P('', 'SYNTH01', 'PSU.Slot.1', 'lost input on 192.0.2.66'), P('other-edge', 'SYNTH01', 'PSU.Slot.9'), P('', 'SYNTH02', 'PSU.Slot.2')] }, { now: 1_790_000_000_000 });
  const mine = await pf.openFaultsOfDevice({ scope: 'idrac', agent: '', key: 'synth01' });
  assert.deepEqual(mine.map((x) => x.partId), ['PSU.Slot.1'], '수집 주체가 다른 같은 태그 기록 · 다른 태그는 빠진다');
  assert.deepEqual((await pf.openFaultsOfDevice({ scope: 'idrac', agent: 'Other-Edge', key: 'SYNTH01' })).map((x) => x.partId), ['PSU.Slot.9'], '엣지 이름은 대소문자 무시');
  assert.deepEqual(await pf.openFaultsOfDevice({ scope: 'idrac', agent: '', key: '', id: '' }), [], '열쇠가 없으면 아무것도 고르지 않는다');
  await withSnap(async () => {
    const k1 = await keyOfName('synth-db-s1');
    const b = JSON.parse((await call('GET /tools/bm-folders/case-bundle', { query: { key: k1 } })).body);
    assert.deepEqual(b.faults.map((x) => [x.part, x.detail]), [['PSU.Slot.1', 'lost input on •••']]);
    assert.equal(b.unread.some((x) => /^faults:/.test(x)), false);
  });
  reset();
});
