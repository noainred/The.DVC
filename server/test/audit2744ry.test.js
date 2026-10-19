/**
 * test/audit2744ry.test.js — v2.744(세 번 반복 3회차) 리드 후속 그룹 RY.
 *
 * ① 등록부·설정 파일 JSON 파싱 오류 **원문**(V8 메시지는 오류 위치 앞뒤 원문 약 10자 — 짧은 파일은 내용 전부 — 를 싣는다. 자격증명 파일이면
 *    평문 비밀번호 조각)이 노드 밖·화면으로 나가던 형제 경로 5곳(RD 의 GD-R1 이 fleet 경로만 고쳤다):
 *    a. 엣지 GET /api/collector/export 503 의 detail·error → 중앙 puller 가 수집 서버 상태 error 로 저장(수집 서버 화면·통신 지도)
 *    b. 파트 장애 스캔(partfault/scan.js)의 registryUnreadable.reason → push → 중앙 파트 장애 화면(operator 도 본다)
 *    c. 중앙 routes/central.js registryUnreadable() 503 detail → 엣지 설정 pull 상태
 *    d. registryCore.pullRecoveryNote 의 reason·note → 엣지 상태·콘솔 → 엣지 로그
 *    e. util/atomicWrite.js preserveCorrupt 콘솔 줄(130곳의 설정·상태 파일 공용) → 엣지 링 버퍼 → 중앙 엣지 로그
 * ② /tools/ipam/sheet 의 VM 칸이 스냅샷 VM 객체 통째(owner)를 실어 inv.vms 없는(/vms 403) tools 역할에도 나갔다.
 *
 * 실제 V8 JSON.parse 메시지 · 실제 collectorRouter · centralRouter · api 라우터 · 실제 puller 판정 · 실제 파트 장애 스캔으로 본다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744ry-'));
Object.assign(process.env, {
  CONFIG_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'true', SSRF_ALLOW_LOOPBACK: 'true', IPAM_WRITE_WORKER: '0',
  COLLECTOR_TOKEN: 'col-2744ry', CENTRAL_TOKEN: 'ctok-2744ry', AGENT_NAME: 'edge-ry',
});
delete process.env.CENTRAL_URL;
fs.writeFileSync(path.join(TMP, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [] }));
// viewer = tools 만(inv.vms 없음) — ② 의 권한 경계. operator 는 inv.vms 가 있어 상세 지연 조회 경로를 본다.
fs.writeFileSync(path.join(TMP, 'permissions.json'), JSON.stringify({
  schemaVersion: 3,
  matrix: { operator: ['dashboard', 'tools', 'inv.hosts', 'inv.vms'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } },
}));

const SECRET = 'SuperSecret123!';
const LEAK = /SuperSecre|assword|hunter2|uperSecret/;   // 원문 조각의 흔적(비밀번호 앞 글자 · 키 이름 조각)
const IDRAC = path.join(TMP, 'idrac.json');
const STORAGE = path.join(TMP, 'storage-devices.json');
const IDRAC_GOOD = JSON.stringify({ servers: [{ id: 's1', name: 'srv-1', host: 'https://10.9.0.11', username: 'root', password: 'x' }] });
// 비밀번호 칸 따옴표를 빠뜨린 손편집 — V8 메시지가 `..."assword": SuperSecre"...` 조각을 싣는다.
const IDRAC_BAD = `{"servers":[{"id":"s1","name":"srv-1","host":"https://10.9.0.11","username":"root","password": ${SECRET}}]}`;
const STORAGE_BAD = `{"devices":[{"id":"st1","type":"unity480","host":"10.9.0.21","username":"admin","password": ${SECRET}}]}`;
const v8msg = (txt) => { try { JSON.parse(txt); } catch (e) { return e.message; } return ''; };

/** console.error·console.warn 를 잡는다(줄은 엣지 링 버퍼로 중앙 엣지 로그에 당겨진다). */
async function capture(fn) {
  const lines = []; const e = console.error; const w = console.warn;
  console.error = (...a) => { lines.push(a.map(String).join(' ')); };
  console.warn = (...a) => { lines.push(a.map(String).join(' ')); };
  try { const v = await fn(); return { v, lines }; } finally { console.error = e; console.warn = w; }
}
const clearCorrupt = (base) => { for (const n of fs.readdirSync(TMP)) if (n.startsWith(`${base}.corrupt.`)) fs.rmSync(path.join(TMP, n)); };

let collectorBase; let centralBase; let apiBase; let store; const closers = [];
before(async () => {
  fs.writeFileSync(IDRAC, IDRAC_GOOD);
  // 중앙 스토리지 등록부는 모듈이 처음 읽을 때 손상이어야 한다(그 뒤로는 메모리 판정 — c 가 그 503 을 본다).
  fs.writeFileSync(STORAGE, STORAGE_BAD);
  const express = (await import('express')).default;
  const { collectorRouter } = await import('../src/routes/collector.js');
  const { centralRouter } = await import('../src/routes/central.js');
  const { api } = await import('../src/routes/api.js');
  ({ store } = await import('../src/store.js'));
  const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => { closers.push(() => new Promise((q) => { s.closeAllConnections?.(); s.close(q); })); r(`http://127.0.0.1:${s.address().port}`); }); });
  const a1 = express(); a1.use('/api/collector', collectorRouter); collectorBase = await listen(a1);
  const a2 = express(); a2.use(express.json({ limit: '4mb' })); a2.use('/api/central', centralRouter); centralBase = await listen(a2);
  const a3 = express(); a3.use(express.json());
  a3.use((req, _r, n) => { const role = req.get('x-role') || 'admin'; req.user = { username: role === 'admin' ? 'adm' : `u-${role}`, role, scope: null }; n(); });
  a3.use('/api', api); apiBase = await listen(a3);
});
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});

/* ════════════════════ 공용 요약(atomicWrite) ════════════════════ */

test('① 공용 요약 summarizeLoadReason — 실제 V8 메시지에서 원문 글자를 옮기지 않는다 · 숫자만 · 사람 문장은 남긴다', async () => {
  const { summarizeLoadReason, classifyLoadReason } = await import('../src/util/atomicWrite.js');
  const samples = [
    `{"servers":[{"password": ${SECRET}}]}`,                // Unexpected token 'S', ..."assword": SuperSecre"... (짝 안 맞는 따옴표)
    `{\n "x": 1,\n "pw": hunter2\n}`,                         // 여러 줄 조각
    SECRET,                                                   // 짧은 파일 — 내용 전부가 실린다
    `[${SECRET}]`,
  ];
  for (const s of samples) {
    const raw = v8msg(s);
    assert.match(raw, LEAK, `전제: V8 원문은 조각을 싣는다(${raw})`);
    const out = summarizeLoadReason(raw);
    assert.doesNotMatch(out, LEAK, `${JSON.stringify(s)} → ${out}`);
    assert.equal(out, 'JSON 형식 오류');
    assert.equal(classifyLoadReason(raw).kind, 'parse');
  }
  // 위치가 있는 V8 형식은 줄·칸만 옮긴다.
  assert.equal(summarizeLoadReason(v8msg('{\n  "a": 1,\n}')), 'JSON 형식 오류(3번째 줄 1번째 칸)');
  assert.equal(summarizeLoadReason(v8msg('{"password":"Sup\u0001er"}')), 'JSON 형식 오류(1번째 줄 17번째 칸)');
  assert.equal(summarizeLoadReason(v8msg('')), 'JSON 형식 오류');
  // 시스템 오류는 코드만 — 경로를 옮기지 않는다.
  assert.equal(summarizeLoadReason("EACCES: permission denied, open '/etc/vmware-portal/idrac.json'"), '읽기 오류(EACCES)');
  // 따옴표가 없는 짧은 사람 문장(호출부가 직접 쓴 사유)은 그대로.
  for (const s of ['객체가 아님', 'templates 배열이 없음', 'upgrade-status', '원장 형식이 아닙니다(배열도 batches 배열도 아님)']) assert.equal(summarizeLoadReason(s), s);
  // 따옴표가 든 그 밖의 문장(TypeError 등 — 값이 들어갈 수 있다)은 원문을 싣지 않는다.
  const q = summarizeLoadReason("Cannot read properties of null (reading 'servers')");
  assert.doesNotMatch(q, /servers|reading/);
  assert.match(q, /원문/);
  // 짝 안 맞는 따옴표·백슬래시·제어 문자·긴 문장도 원문이 아니다.
  for (const s of [`x "${SECRET}`, `a\\b ${SECRET}`, `line1\n${SECRET}`, `${'가'.repeat(120)}${SECRET}`]) assert.doesNotMatch(summarizeLoadReason(s), LEAK, s);
  // Error 객체 · 빈 값 · 이상한 값
  assert.equal(summarizeLoadReason(new SyntaxError(v8msg(`{"password": ${SECRET}}`))), 'JSON 형식 오류');
  assert.equal(summarizeLoadReason(''), ''); assert.equal(summarizeLoadReason(null), '');
  assert.doesNotThrow(() => summarizeLoadReason({ toString() { throw new Error('x'); } }));
  // 긴 입력도 선형(정규식 입력 상한)
  const t0 = Date.now(); summarizeLoadReason('E'.repeat(300_000)); summarizeLoadReason('"'.repeat(300_000)); assert.ok(Date.now() - t0 < 1000);
});

test('① 등록부 요약(registryCore.summarizeRegistryError)과 공용 요약은 판정이 한 벌이다', async () => {
  const { summarizeRegistryError } = await import('../src/util/registryCore.js');
  const { classifyLoadReason } = await import('../src/util/atomicWrite.js');
  const cases = [v8msg(`{"password": ${SECRET}}`), v8msg('{\n  "a": 1,\n}'), "EACCES: permission denied, open '/x'", '객체가 아님', v8msg('{"a":1}x')];
  for (const raw of cases) {
    const c = classifyLoadReason(raw); const r = summarizeRegistryError({ reason: raw });
    assert.equal(r.code === 'parse-error', c.kind === 'parse', raw);
    if (c.kind === 'parse') { assert.equal(r.line, c.line); assert.equal(r.column, c.column); assert.equal(r.position, c.position); } else assert.equal(r.sysCode, c.sysCode);
    assert.doesNotMatch(r.text, LEAK);
  }
});

/* ════════════════════ e. preserveCorrupt 콘솔 줄 ════════════════════ */

test('e. preserveCorrupt 콘솔 줄(손상 보존) — 파일 이름·분류·위치만, 원문 조각 없음(파싱 실패 문구는 그대로)', async () => {
  const { preserveCorrupt } = await import('../src/util/atomicWrite.js');
  const f = path.join(TMP, 'some-settings.json');
  fs.writeFileSync(f, `{"token": ${SECRET}}`);
  let raw = ''; try { JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { raw = e.message; }
  assert.match(raw, LEAK);
  const { v: bak, lines } = await capture(() => preserveCorrupt(f, raw));
  assert.ok(bak && fs.existsSync(bak), '보존은 그대로');
  const line = lines.join('\n');
  assert.match(line, /some-settings\.json 파싱 실패/, '기존 테스트가 고정한 문구');
  assert.match(line, /JSON 형식 오류/);
  assert.match(line, /some-settings\.json\.corrupt\.\d+/);
  assert.doesNotMatch(line, LEAK, line);
  // 실제 등록부 로드 경로(idrac/registry.js load catch → preserveCorrupt(FILE, e.message))도 같다.
  const registry = await import('../src/idrac/registry.js');
  fs.writeFileSync(IDRAC, IDRAC_BAD);
  const r2 = await capture(() => registry.loadRegistry());
  assert.deepEqual(r2.v, []);
  assert.match(r2.lines.join('\n'), /idrac\.json 파싱 실패/);
  assert.doesNotMatch(r2.lines.join('\n'), LEAK, r2.lines.join('\n'));
  fs.writeFileSync(IDRAC, IDRAC_GOOD); clearCorrupt('idrac.json');
  assert.equal(registry.registryLoadError(), null);
});

/* ════════════════════ a. 엣지 export 503 ════════════════════ */

test('a. 엣지 /api/collector/export 503 — detail·error 에 원문 조각이 없고 계약(reason 코드·detail 문자열)은 그대로 · 중앙 puller 오류 문구에도 없다', async () => {
  const registry = await import('../src/idrac/registry.js');
  const puller = await import('../src/collector/puller.js');
  const get = () => fetch(`${collectorBase}/api/collector/export`, { headers: { 'X-Collector-Token': 'col-2744ry', Accept: 'application/json' } });
  assert.equal((await get()).status, 200, '전제: 정상');
  fs.writeFileSync(IDRAC, IDRAC_BAD);
  const { v: res } = await capture(() => get());
  assert.equal(res.status, 503);
  const txt = await res.text();
  assert.doesNotMatch(txt, LEAK, `503 본문에 원문 조각: ${txt}`);
  const body = JSON.parse(txt);
  assert.equal(body.reason, 'registryUnreadable', '중앙 puller 가 읽는 코드는 그대로');
  assert.equal(body.registry, 'idrac');
  assert.equal(typeof body.detail, 'string');
  assert.match(body.detail, /JSON 형식 오류/);
  assert.match(body.error, /엣지 iDRAC 등록부\(idrac\.json\)를 읽지 못했습니다/);
  assert.equal(body.registryError?.code, 'parse-error', '분류 코드를 싣는다(숫자만 — 원문 없음)');
  // 중앙 puller 의 실제 판정에 이 응답을 넣는다 — 상태 error 로 저장되는 문구.
  const mk = new Response(txt, { status: 503, statusText: 'Service Unavailable', headers: { 'content-type': 'application/json' } });
  const err = await puller.exportFailError(mk);
  assert.equal(err.edgeReason, 'registryUnreadable');
  assert.match(err.message, /JSON 형식 오류/);
  assert.doesNotMatch(err.message, LEAK);
  // 원상 복구
  fs.writeFileSync(IDRAC, IDRAC_GOOD); clearCorrupt('idrac.json');
  assert.equal(registry.registryLoadError(), null);
  assert.equal((await get()).status, 200);
});

/* ════════════════════ b. 파트 장애 스캔 ════════════════════ */

test('b. 파트 장애 스캔·push 본문의 registryUnreadable 사유에 원문 조각이 없다(실제 runScan · buildPayload)', async () => {
  const { runScan, scanFrom } = await import('../src/partfault/scan.js');
  const { buildPayload } = await import('../src/partfault/push.js');
  fs.writeFileSync(IDRAC, IDRAC_BAD);
  const { v: scan, lines } = await capture(() => runScan());
  assert.doesNotMatch(lines.join('\n'), LEAK, '스캔이 처음 읽은 등록부의 preserveCorrupt 줄에도 없다');
  assert.ok(scan.registryUnreadable?.storage, '스토리지 등록부(처음부터 손상)도 싣는다');
  const ru = scan.registryUnreadable?.idrac;
  assert.ok(ru, JSON.stringify(scan.registryUnreadable));
  assert.equal(ru.code, 'parse-error');
  assert.match(ru.reason, /JSON 형식 오류/);
  assert.doesNotMatch(JSON.stringify(scan.registryUnreadable), LEAK);
  assert.doesNotMatch(JSON.stringify(scan.scanned), LEAK, '요약(scanned — 화면)에도 없다');
  const payload = buildPayload(scan, { agent: 'edge-ry', version: '2.744.0' });
  assert.doesNotMatch(JSON.stringify(payload), LEAK, 'push 본문에도 없다');
  // 순수 경로 — 원문 사유를 받아도 요약한다(scanFrom 은 다른 호출부도 쓴다).
  const r = scanFrom({ registryUnreadable: { storage: { at: 5, reason: v8msg(`{"password": ${SECRET}}`) } } });
  assert.equal(r.registryUnreadable.storage.reason, 'JSON 형식 오류');
  assert.equal(r.registryUnreadable.storage.at, 5);
  fs.writeFileSync(IDRAC, IDRAC_GOOD); clearCorrupt('idrac.json');
});

/* ════════════════════ c. 중앙 registryUnreadable 503 ════════════════════ */

test('c. 중앙 설정 pull·파트 장애 수신의 503 registryUnreadable detail 에 중앙 등록부 원문 조각이 없다(실제 centralRouter)', async () => {
  fs.writeFileSync(STORAGE, STORAGE_BAD);
  const H = { 'X-Central-Token': 'ctok-2744ry', 'Content-Type': 'application/json' };
  const { v: r1 } = await capture(() => fetch(`${centralBase}/api/central/storage-config?agent=edge-ry`, { headers: H }));
  assert.equal(r1.status, 503);
  const t1 = await r1.text();
  assert.doesNotMatch(t1, LEAK, `설정 pull 503 본문: ${t1}`);
  const b1 = JSON.parse(t1);
  assert.equal(b1.reason, 'registryUnreadable');
  assert.match(b1.detail, /중앙 스토리지 등록부를 읽지 못했습니다\(JSON 형식 오류\)/);
  // 파트 장애 수신(스토리지 장비가 든 보고) — 같은 함수가 503 을 낸다.
  const { v: r2 } = await capture(() => fetch(`${centralBase}/api/central/part-faults`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ v: 2, agent: 'edge-ry', devices: [{ scope: 'storage', deviceId: 'st1', ok: true, open: [], states: {} }] }),
  }));
  assert.equal(r2.status, 503);
  const t2 = await r2.text();
  assert.doesNotMatch(t2, LEAK, `파트 장애 수신 503 본문: ${t2}`);
  assert.equal(JSON.parse(t2).reason, 'registryUnreadable');
});

/* ════════════════════ d. pullRecoveryNote ════════════════════ */

test('d. pullRecoveryNote — reason·note 는 요약(원문 조각 없음) · 분류 코드를 싣는다', async () => {
  const { pullRecoveryNote } = await import('../src/util/registryCore.js');
  const n = pullRecoveryNote({ at: 1000, reason: v8msg(`{"password": ${SECRET}}`) }, { what: '스토리지 등록부(storage-devices.json)', restored: 3 });
  assert.doesNotMatch(JSON.stringify(n), LEAK, JSON.stringify(n));
  assert.equal(n.reason, 'JSON 형식 오류');
  assert.equal(n.code, 'parse-error');
  assert.match(n.note, /스토리지 등록부\(storage-devices\.json\) 읽기 실패\(JSON 형식 오류\) — 중앙 배포분 3건으로 다시 썼습니다/);
  assert.equal(n.lostAt, 1000); assert.equal(n.restored, 3);
  const n2 = pullRecoveryNote({ at: 2, reason: v8msg('{\n  "a": 1,\n}') });
  assert.equal(n2.reason, 'JSON 형식 오류(3번째 줄 1번째 칸)');
});

/* ════════════════════ ② /tools/ipam/sheet VM 칸 ════════════════════ */

test('② /tools/ipam/sheet 의 VM 칸은 owner 본문 없이 hasOwner — inv.vms 없는 tools 역할(/vms 403)에게 VM 전체 객체가 나가지 않는다', async () => {
  store.snapshot = {
    ...(store.get() || {}), source: 'live', generatedAt: new Date().toISOString(),
    vcenters: [{ id: 'vc-y', name: 'VC-Y', status: 'connected' }],
    hosts: [{ id: 'vc-y:host-1', vcenterId: 'vc-y', name: 'esx-y1', connectionState: 'CONNECTED', powerState: 'POWERED_ON', cluster: 'CY' }],
    vms: [{
      id: 'vc-y:vm-1', vcenterId: 'vc-y', name: 'app-ry', powerState: 'POWERED_ON', host: 'esx-y1', cluster: 'CY', ipAddresses: ['10.30.0.50'],
      guestOS: 'Ubuntu', notes: '첫 줄 메모', uuid: 'VMUUID-RY-SECRET', macAddresses: ['00:50:56:ry:00:01'],
      disks: [{ label: 'Hard disk 1', path: '[ds-ry] app-ry/SECRETDISK.vmdk' }], customValues: { owner: 'RYCUSTOM' },
    }],
    datastores: [], networks: [], alarms: [],
  };
  const SECRET_VM = /VMUUID-RY|00:50:56:ry|SECRETDISK|RYCUSTOM|"macAddresses"|"disks"|"uuid"/;
  const V = { 'x-role': 'viewer', 'accept-encoding': 'identity' };
  assert.equal((await fetch(`${apiBase}/api/vms`, { headers: V })).status, 403, '전제: 이 역할은 VM 목록을 볼 수 없다');
  const r = await fetch(`${apiBase}/api/tools/ipam/sheet?base=10.30.0`, { headers: V });
  assert.equal(r.status, 200);
  const txt = await r.text();
  assert.doesNotMatch(txt, SECRET_VM, '시트 응답에 VM 전체 객체가 실렸다');
  const rows = JSON.parse(txt).rows || [];
  const vm = rows.find((x) => x.ip === '10.30.0.50');
  assert.equal(vm?.ownerType, 'vm', JSON.stringify(vm));
  assert.equal('owner' in vm, false, 'VM 칸에 owner 가 남았다');
  assert.equal(vm.hasOwner, true, '화면이 클릭 때 지연 조회하도록 표지를 싣는다');
  assert.equal(vm.hostname, 'app-ry'); assert.equal(vm.notes, '첫 줄 메모'); assert.equal(vm.vcenterId, 'vc-y');
  assert.ok(JSON.stringify(vm).length < 1024, `VM 칸 ${JSON.stringify(vm).length}B`);
  // 빈 칸·네트워크 칸은 그대로(owner null — 키가 남아도 값이 없다)
  assert.equal(rows.find((x) => x.ip === '10.30.0.1')?.owner, null);
  // 목록(/tools/ipam)의 VM 행과 같은 모양
  const list = await (await fetch(`${apiBase}/api/tools/ipam`, { headers: V })).json();
  const lv = (list.rows || []).find((x) => x.ip === '10.30.0.50');
  assert.equal('owner' in lv, false); assert.equal(lv.hasOwner, true);
  // 상세 지연 조회 경로(화면 IpHistoryModal → /vms/lookup?ip=&vcenterId=): inv.vms 가 있는 역할은 전체 객체를, 없는 역할은 403 을 받는다.
  const op = await (await fetch(`${apiBase}/api/vms/lookup?ip=10.30.0.50&vcenterId=vc-y`, { headers: { 'x-role': 'operator' } })).json();
  assert.equal(op.vm?.uuid, 'VMUUID-RY-SECRET', '권한 있는 역할의 상세는 예전처럼 전체 객체');
  assert.equal((await fetch(`${apiBase}/api/vms/lookup?ip=10.30.0.50&vcenterId=vc-y`, { headers: { 'x-role': 'viewer' } })).status, 403);
});
