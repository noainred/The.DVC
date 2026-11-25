/**
 * 전체 점검 128회차 — 앞 회차들이 '범위 밖 · 남긴 것' 으로 적어 둔 같은 꼴의 잔여.
 *
 *  A  재읽기 간격의 벽시계 비교(125회차 F2 의 형제): 읽기 오류 뒤 다시 읽기 간격을 `now < retryAt` 로만 봐서 **시계가 뒤로 가면**
 *     (NTP 보정 · 수동 변경 · VM 스냅샷 복귀) 그 차만큼 재읽기가 미뤄졌다 — 파일을 바로잡아도 쓰기 거절 · 닫힘이 이어졌다.
 *     유틸은 125회차에 `inRetryWindow`(간격을 건 시각보다 앞이면 지난 것으로)로 고쳤고, 유틸을 거치지 않는 곳이 남아 있었다:
 *       util/exportPrefs · ipam/subnetNotes · ipam/rangeStore · bmusage/maint/store · security/emergencyStop · security/loginStore ·
 *       security/loginHistory · security/peerTrust (125 보고서의 8곳) + grep 으로 더 찾은 central/inventory · central/fleet ·
 *       central/assignments(결과 파일) · sshaccess/state.
 *     닫는 쪽 판정(emergencyStop · peerTrust · sshaccess)은 '여전히 못 읽으면 닫힌 채' 를 함께 고정한다(안전측이 바뀌지 않는다).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'leftover128-'));
const CHILD_DIRS = [];
process.env.CONFIG_DIR = TMP;
process.env.DATA_DIR = TMP;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
after(() => { for (const d of [TMP, ...CHILD_DIRS]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const F = (n) => path.join(TMP, n);
const corruptOf = (n) => fs.readdirSync(TMP).filter((x) => x.startsWith(`${n}.corrupt.`));

// 시계: 실제 시각에서 정시 경계로 떨어뜨려 고정(util/jsonFileRead.js nowMs 를 쓰는 모듈 전부).
const RD = await import('../src/util/jsonFileRead.js');
let NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
RD._setJsonFileLoadClockForTest(() => NOW);
after(() => RD._setJsonFileLoadClockForTest());
const HOUR = 3_600_000;
const BACK = 9 * HOUR;   // RTC 가 로컬 시각(KST)이던 장비의 첫 NTP 동기화 = 9시간 뒤로

const realRead = fs.readFileSync;
const eio = new Set();          // 이 이름의 파일은 읽기가 EIO
const reads = new Map();        // 이름 → 읽기 시도 횟수
fs.readFileSync = function patched(f, ...a) {
  const n = path.basename(String(f));
  if (eio.has(n)) { reads.set(n, (reads.get(n) || 0) + 1); const e = new Error('EIO: i/o error, read'); e.code = 'EIO'; throw e; }
  return realRead.call(this, f, ...a);
};
after(() => { fs.readFileSync = realRead; });
const quiet = async (fn) => { const w = console.warn; const e = console.error; const l = console.log; console.warn = () => {}; console.error = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.error = e; console.log = l; } };
const put = (n, v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); fs.writeFileSync(F(n), s); return s; };

/**
 * 공통 시나리오: 읽기 오류 → (파일은 바로잡힘) → 시계가 9시간 뒤로 → 곧바로 다시 읽어 풀려야 한다.
 *   그리고 간격 규칙은 그대로다 — 오류 직후 간격 안에는 디스크를 다시 보지 않는다(핫패스가 죽어 가는 디스크를 두드리지 않게).
 * @param {{ name:string, failing:()=>void, stillFailing:()=>void, healed:()=>void }} c
 */
function clockBackCase(c) {
  eio.add(c.name); reads.delete(c.name);
  c.failing();
  const r1 = reads.get(c.name) || 0;
  assert.ok(r1 >= 1, `${c.name}: 읽기를 시도했다(전제)`);
  c.stillFailing();
  assert.equal(reads.get(c.name), r1, `${c.name}: 간격 안에는 디스크를 다시 읽지 않는다`);
  eio.delete(c.name);
  c.stillFailing();   // 파일은 바로잡혔지만 간격 안 — 아직 옛 판정(예전과 같다)
  NOW -= BACK;        // 시계가 9시간 뒤로
  c.healed();
  assert.deepEqual(corruptOf(c.name), [], `${c.name}: 읽기 오류에 보존본을 만들지 않는다`);
  NOW += BACK + RD.READ_RETRY_MS + 1_000;   // 다음 테스트를 위해 앞으로
}

test('A 스윕: 읽기 재시도 간격을 벽시계 한쪽 비교(`now < retryAt` · `now >= retryAt`)로만 보는 곳이 남아 있지 않다', () => {
  const files = ['util/exportPrefs.js', 'ipam/subnetNotes.js', 'ipam/rangeStore.js', 'bmusage/maint/store.js', 'security/emergencyStop.js', 'security/loginStore.js',
    'security/loginHistory.js', 'security/peerTrust.js', 'central/inventory.js', 'central/fleet.js', 'central/assignments.js', 'sshaccess/state.js'];
  for (const f of files) {
    const text = stripComments(realRead(path.join(SRC, f), 'utf8'));
    assert.match(text, /inRetryWindow\(/, `${f}: 공용 판정(util/jsonFileRead.js inRetryWindow)을 쓴다`);
    assert.doesNotMatch(text, /(nowMs\(\)|Date\.now\(\))\s*(<|>=)\s*_?\w*(retryAt|RetryAt|readFailUntil)\b/, `${f}: 벽시계 한쪽 비교가 남았다`);
    assert.doesNotMatch(text, /Date\.now\(\)\s*-\s*readFailAt\s*</, `${f}: 벽시계 차 비교가 남았다`);
    assert.doesNotMatch(text, /function inRetryWindow|const inRetryWindow/, `${f}: 판정을 복제하지 않는다`);
  }
});

test('A1 내보내기 저장값(exportPrefs): 시계가 뒤로 가도 읽기 오류가 그 차만큼 굳지 않는다', () => quiet(async () => {
  const { createExportPrefs } = await import('../src/util/exportPrefs.js');
  const spec = { resolveCols: (c) => (Array.isArray(c) && c.length ? { ok: true, keys: c.map(String) } : { ok: false, reason: '항목 없음' }), knownKeys: (c) => ({ keys: Array.isArray(c) ? c : [], dropped: 0 }), normalizeOpts: () => ({ ok: true, value: {} }) };
  const name = 'leftover128-prefs.json';
  put(name, { v: 1, users: { 'u:kim': { def: { name: '기본값', cols: ['a', 'b'] }, slots: [null, null, null, null, null], at: '2026-11-01T00:00:00.000Z' } } });
  const P = createExportPrefs({ fileName: name, ...spec });
  clockBackCase({ name,
    failing: () => { assert.equal(P.getPrefs('kim').unreadable, true); },
    stillFailing: () => { assert.equal(P.prefsUnreadable(), true); assert.equal(P.setPref('lee', 1, { cols: ['x'] }).status, 503); },
    healed: () => { assert.deepEqual(P.getPrefs('kim').def?.cols, ['a', 'b'], '원본 값으로 풀린다'); assert.equal(P.setPref('lee', 1, { cols: ['x'] }).ok, true); },
  });
}));

test('A2 · A3 IP 관리 대역 용도 · vCenter 별 스캔 대역: 시계가 뒤로 가도 저장 거절이 그 차만큼 굳지 않는다', () => quiet(async () => {
  const N = await import('../src/ipam/subnetNotes.js');
  N._resetSubnetNotesForTest();
  assert.equal(N.setSubnetNote('10.9.8', { purpose: 'DB' }, 'adm').ok, true);
  N._resetSubnetNotesForTest();
  clockBackCase({ name: 'ipam-subnet-notes.json',
    failing: () => { assert.equal(N.subnetNotesLoadError()?.readError, true); },
    stillFailing: () => { assert.equal(N.setSubnetNote('10.9.9', { purpose: 'WEB' }, 'adm').code, 'settings-unreadable'); },
    healed: () => { assert.equal(N.subnetNotesLoadError(), null); assert.equal(N.getSubnetNote('10.9.8')?.purpose, 'DB'); assert.equal(N.setSubnetNote('10.9.9', { purpose: 'WEB' }, 'adm').ok, true); },
  });
  N._resetSubnetNotesForTest();

  const R = await import('../src/ipam/rangeStore.js');
  assert.equal(R.saveVcRanges('vcA', { ranges: ['10.1.0.0/24'] }).ok, true);
  const t = fs.statSync(F('ipam-vcenter-ranges.json')).mtime;
  fs.utimesSync(F('ipam-vcenter-ranges.json'), t, new Date(t.getTime() + 5_000));   // mtime 캐시를 비켜 다시 읽게
  clockBackCase({ name: 'ipam-vcenter-ranges.json',
    failing: () => { assert.equal(R.vcRangesLoadError()?.readError, true); },
    stillFailing: () => { assert.equal(R.saveVcRanges('vcB', { ranges: ['10.2.0.0/24'] }).code, 'settings-unreadable'); },
    healed: () => { assert.equal(R.vcRangesLoadError(), null); assert.equal(R.saveVcRanges('vcB', { ranges: ['10.2.0.0/24'] }).ok, true); },
  });
}));

test('A4 베어메탈 정비 창: 시계가 뒤로 가도 503(못 읽음)이 그 차만큼 굳지 않는다', () => quiet(async () => {
  put('maintenance-windows.json', { v: 1, seq: 0, items: [] });
  const M = await import('../src/bmusage/maint/store.js');
  M._resetMaintStoreForTest();
  clockBackCase({ name: 'maintenance-windows.json',
    failing: () => { assert.equal(M.maintLoadError()?.readError, true); },
    stillFailing: () => { assert.equal(M.windowsForJudge(NOW).localUnreadable, true); },
    healed: () => { assert.equal(M.maintLoadError(), null); assert.notEqual(M.windowsForJudge(NOW).localUnreadable, true); },
  });
  M._resetMaintStoreForTest();
}));

test('A5 긴급중단(닫는 쪽): 시계가 뒤로 가면 곧바로 다시 읽는다 — 읽히면 저장된 상태 · 여전히 못 읽으면 멈춘 채(안전측 그대로)', () => quiet(async () => {
  const es = await import('../src/security/emergencyStop.js');
  const name = 'emergency-stop.json';
  put(name, { active: false, by: [], at: NOW - HOUR });
  es._resetEmergencyStopForTest();
  // ① 여전히 못 읽는 동안: 시계가 뒤로 가든 앞으로 뛰든 멈춤 — 다시 읽기는 한 번씩만(핫패스가 디스크를 두드리지 않는다)
  eio.add(name); reads.delete(name);
  assert.equal(es.isStopped(), true);
  assert.equal(reads.get(name), 1);
  NOW -= BACK;
  for (let i = 0; i < 5; i += 1) assert.equal(es.isStopped(), true, '뒤로 간 시계 — 못 읽으면 멈춤');
  assert.equal(reads.get(name), 2, '뒤로 간 뒤 한 번만 다시 읽고 다시 간격을 건다');
  assert.equal(es.getEmergencyStatus().readError?.failClosed, true);
  NOW += BACK + 10 * HOUR;
  for (let i = 0; i < 5; i += 1) assert.equal(es.isStopped(), true, '앞으로 뛴 시계 — 못 읽으면 멈춤');
  assert.equal(reads.get(name), 3, '앞으로 뛴 뒤에도 한 번만');
  // ② 파일이 바로잡힌 뒤 시계가 뒤로: 예전에는 그 차(9시간) 동안 '못 읽음 = 멈춤' 이 이어졌다
  eio.delete(name);
  assert.equal(es.isStopped(), true, '간격 안 — 아직 다시 읽지 않는다');
  NOW -= BACK;
  assert.equal(es.isStopped(), false, '읽히는 순간 저장된 상태(꺼짐)');
  assert.equal(es.getEmergencyStatus().readError, undefined);
  // ③ 저장된 상태가 켜짐이면 다시 읽어도 멈춤(다시 읽기가 여는 쪽으로 기울지 않는다)
  put(name, { active: true, by: ['a', 'b'], at: NOW - HOUR });
  es._resetEmergencyStopForTest();
  eio.add(name); assert.equal(es.isStopped(), true); eio.delete(name);
  NOW -= BACK;
  assert.equal(es.isStopped(), true); assert.deepEqual(es.getEmergencyStatus().by, ['a', 'b']);
  es._resetEmergencyStopForTest();
  fs.rmSync(F(name), { force: true });
  NOW += 2 * BACK + HOUR;
}));

test('A6 · A7 로그인 실패 기록 · 로그인 기록: 시계가 뒤로 가도 읽기 오류가 그 차만큼 굳지 않는다(그동안 파일에 쓰지 않는 상태)', () => quiet(async () => {
  const t0 = NOW - 60_000;
  put('login-fails.ndjson', `${JSON.stringify({ ts: t0, source: 'portal', kind: 'portal', user: 'u1', ip: '10.0.0.1' })}\n`);
  const LS = await import('../src/security/loginStore.js');
  LS._resetLoginStoreForTest();
  clockBackCase({ name: 'login-fails.ndjson',
    failing: () => { assert.equal(LS.loginStoreReadError(), 'EIO'); },
    stillFailing: () => { assert.equal(LS.loginStoreReadError(), 'EIO'); },
    healed: () => { assert.equal(LS.loginStoreReadError(), null); assert.deepEqual(LS.getStoredFails(0).map((r) => r.user), ['u1']); },
  });
  LS._resetLoginStoreForTest();

  put('login-history.ndjson', `${JSON.stringify({ ts: t0, user: 'u1', ip: '10.0.0.1', role: 'admin', src: '' })}\n`);
  const LH = await import('../src/security/loginHistory.js');
  LH._resetLoginHistoryForTest();
  clockBackCase({ name: 'login-history.ndjson',
    failing: () => { assert.ok(LH.loginHistorySummary({ now: NOW }).loadError); },
    stillFailing: () => { assert.ok(LH.loginHistorySummary({ now: NOW }).loadError); },
    healed: () => { const s = LH.loginHistorySummary({ now: NOW + BACK }); assert.equal(s.loadError, null); assert.equal(s.records, 1, '원본 기록이 돌아온다'); },
  });
  LH._resetLoginHistoryForTest();
}));

const FP_A = `SHA256:${'A'.repeat(43)}`;
test('A8 장비 신뢰(닫는 쪽): 시계가 뒤로 가면 곧바로 다시 읽는다 — 읽히면 승인 목록이 돌아오고 · 여전히 못 읽으면 enforce 로 닫힌 채', () => quiet(async () => {
  const pt = await import('../src/security/peerTrust.js');
  const name = 'peer-trust.json';
  put('vcenters.json', { vcenters: [{ id: 'vc1' }] });
  const orig = put(name, { v: 1, policy: { ssh: 'observe', tls: 'observe' }, origin: {}, entries: [{ kind: 'ssh', host: '10.0.0.5', port: 22, trusted: { fp: FP_A, state: 'approved', at: 1 } }] });
  pt._resetPeerTrustForTest();
  eio.add(name); reads.delete(name);
  pt.initPeerTrust();
  assert.equal(pt.getPeerPolicy('ssh').mode, 'enforce');
  assert.equal(reads.get(name), 1);
  // ① 여전히 못 읽는 동안 시계가 뒤로 · 앞으로: 닫힌 채 — observe(원본 정책)로 열리지 않는다 · 다시 읽기는 한 번씩
  NOW -= BACK;
  for (let i = 0; i < 5; i += 1) assert.equal(pt.checkPeer('ssh', '10.0.0.5', 22, FP_A).reason, 'unknown', '뒤로 간 시계 — 못 읽으면 전부 거부');
  assert.equal(pt.getPeerPolicy('ssh').mode, 'enforce');
  assert.equal(reads.get(name), 2);
  NOW += BACK + 10 * HOUR;
  for (let i = 0; i < 5; i += 1) assert.equal(pt.checkPeer('ssh', '10.0.0.5', 22, FP_A).ok, false, '앞으로 뛴 시계 — 못 읽으면 전부 거부');
  assert.equal(reads.get(name), 3);
  assert.throws(() => pt.setPeerPolicy('ssh', 'observe'), (e) => e.status === 409, '그동안 관리 동작은 거절(예전과 같다)');
  // ② 파일이 바로잡힌 뒤 시계가 뒤로: 예전에는 9시간 동안 모든 장비 접속이 '승인되지 않은 지문' 으로 거부됐다
  eio.delete(name);
  assert.equal(pt.checkPeer('ssh', '10.0.0.5', 22, FP_A).ok, false, '간격 안 — 아직 다시 읽지 않는다');
  NOW -= BACK;
  assert.equal(pt.checkPeer('ssh', '10.0.0.5', 22, FP_A).reason, 'approved', '읽히면 승인 목록이 돌아온다');
  assert.equal(pt.peerTrustStatus().loadError, null);
  assert.equal(pt.getPeerPolicy('ssh').mode, 'observe', '파일의 정책 그대로');
  pt.flushPeerTrust();
  assert.equal(JSON.parse(realRead(F(name), 'utf8')).entries.length, JSON.parse(orig).entries.length);
  assert.deepEqual(corruptOf(name), []);
  pt._resetPeerTrustForTest();
  NOW += BACK + HOUR;
}));

test('A9 SSH 키 접속 상태(sshaccess/state — 닫는 쪽 · 실제 시계): 시계가 뒤로 가도 읽기 실패 잠금이 그 차만큼 굳지 않는다', () => quiet(async () => {
  const S = await import('../src/sshaccess/state.js');
  const name = 'ssh-access-state.json';
  put(name, { stops: {}, events: [] });
  S._resetSshAccessStateForTest();
  const realNow = Date.now;
  let shift = 0;
  Date.now = () => realNow() + shift;
  try {
    eio.add(name); reads.delete(name);
    assert.ok(S.stateLoadError(), '읽기 실패 = 잠금');
    assert.ok(S.stateLoadError()); assert.equal(reads.get(name), 1, '간격 안에는 다시 읽지 않는다');
    shift = -BACK;
    assert.ok(S.stateLoadError(), '뒤로 간 시계 — 여전히 못 읽으면 잠긴 채');
    assert.equal(reads.get(name), 2, '한 번만 다시 읽는다');
    assert.ok(S.stateLoadError()); assert.equal(reads.get(name), 2);
    eio.delete(name);
    assert.ok(S.stateLoadError(), '간격 안');
    shift = -2 * BACK;
    assert.equal(S.stateLoadError(), null, '파일이 읽히면 곧바로 풀린다(예전: 뒤로 간 만큼 잠김)');
  } finally { Date.now = realNow; S._resetSshAccessStateForTest(); }
}));

/** 자식 프로세스 — 모듈 로드 때 읽는 중앙 캐시(인벤토리 · 함대 · 스캔 결과). 지정한 파일의 읽기를 EACCES 로 막고 body 를 돌린다. */
function runChild(dir, deny, body, extraEnv = {}) {
  const script = `
    import fs from 'node:fs';
    const realRead = fs.readFileSync; const DENY = ${JSON.stringify(deny)};
    globalThis.__deny = true;
    fs.readFileSync = function (p, ...a) { if (globalThis.__deny && DENY.includes(String(p))) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } return realRead.call(this, p, ...a); };
    console.warn = () => {};
    const out = {};
    ${body}
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const res = execFileSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', script], { env: { ...process.env, CONFIG_DIR: dir, DATA_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', ...extraEnv }, encoding: 'utf8', timeout: 90_000 });
  return JSON.parse(res.split('\n').find((l) => l.startsWith('@@')).slice(2));
}

test('A10 중앙 캐시(인벤토리 · 함대 · 스캔 결과): 읽기 오류 뒤 시계가 뒤로 가도 저장이 그 차만큼 멈추지 않는다 · 간격 안에는 여전히 쓰지 않는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leftover128-central-')); CHILD_DIRS.push(dir);
  const I = path.join(dir, 'central-inventory.json');
  const FL = path.join(dir, 'central-fleet.json');
  const R = path.join(dir, 'agent-results.json');
  const at = NOW - 60_000;
  const invOrig = JSON.stringify({ inventory: { 'vc-a': { at, agent: 'edge-a', data: { hosts: [{ id: 'h1' }], vms: [] } } } });
  const fleetOrig = JSON.stringify({ fleet: { 'edge-a': { at, generatedAt: null, baremetal: [{ fleetId: 'f1', name: 'bm1' }] } } });
  const resOrig = JSON.stringify({ 'edge-old': { at: 5, scanned: 3, foundCount: 0, found: [] } });
  fs.writeFileSync(I, invOrig); fs.writeFileSync(FL, fleetOrig); fs.writeFileSync(R, resOrig);
  const out = runChild(dir, [I, FL, R], `
    const inv = await import(${JSON.stringify(path.join(SRC, 'central/inventory.js'))});
    const fleet = await import(${JSON.stringify(path.join(SRC, 'central/fleet.js'))});
    const A = await import(${JSON.stringify(path.join(SRC, 'central/assignments.js'))});
    out.blocked = [inv.inventoryReadBlocked(), fleet.fleetReadBlocked()];
    inv.setInventory('vc-c', { vcenter: { id: 'vc-c', status: 'ok' }, hosts: [], vms: [] }, 'edge-c', null);
    fleet.setEdgeFleet('edge-n', [{ fleetId: 'f9', name: 'bm9' }], null, { verified: true });
    A.setResult('edge-new', { scanned: 1, foundCount: 0, found: [] });
    globalThis.__deny = false;                      // 파일은 바로잡혔다
    out.ownInWindow = inv.setInventoryOwner('vc-c', 'edge-c2').persisted;   // 간격 안 — 아직 쓰지 않는다
    fleet.flushEdgeFleetNow();
    out.sameInWindow = [realRead(${JSON.stringify(I)}, 'utf8') === ${JSON.stringify(invOrig)}, realRead(${JSON.stringify(FL)}, 'utf8') === ${JSON.stringify(fleetOrig)}];
    const realNow = Date.now; Date.now = () => realNow() - ${BACK};   // 시계가 9시간 뒤로
    out.own = inv.setInventoryOwner('vc-c', 'edge-c2').persisted;
    fleet.flushEdgeFleetNow();
    await new Promise((r) => setTimeout(r, 3_400));   // 스캔 결과 디바운스(3초)
    Date.now = realNow;
    out.blockedAfter = [inv.inventoryReadBlocked(), fleet.fleetReadBlocked()];
    out.invIds = Object.keys(JSON.parse(realRead(${JSON.stringify(I)}, 'utf8')).inventory).sort();
    out.fleetAgents = Object.keys(JSON.parse(realRead(${JSON.stringify(FL)}, 'utf8')).fleet).sort();
    out.resultKeys = Object.keys(JSON.parse(realRead(${JSON.stringify(R)}, 'utf8'))).sort();
  `, { CENTRAL_TOKEN: 'tok-128-test', CENTRAL_FLEET_TTL_MS: String(10 * 86_400_000) });
  assert.deepEqual(out.blocked, [true, true]);
  assert.equal(out.ownInWindow, false, '간격 안에는 다시 읽지 않고 저장도 하지 않는다(예전과 같다)');
  assert.deepEqual(out.sameInWindow, [true, true]);
  assert.equal(out.own, true, '시계가 뒤로 갔으면 곧바로 다시 읽어 합쳐 쓴다(예전: 9시간 동안 저장 안 함)');
  assert.deepEqual(out.blockedAfter, [false, false]);
  assert.deepEqual(out.invIds, ['vc-a', 'vc-c'], '파일에만 있던 것을 되살리고 메모리 것을 더한다');
  assert.deepEqual(out.fleetAgents, ['edge-a', 'edge-n']);
  assert.deepEqual(out.resultKeys, ['edge-new', 'edge-old'], '스캔 결과도 합쳐 쓴다');
});

/* ═══ B — 설정 화면 대조 잔여(112 · 123회차가 'out' 으로 남긴 등록부 · 설정) ═══════════════════════════════════════
 *  B1 등록부 조회에 표지가 없었다: SAN 스위치 · CVP 서버 · 베어메탈 스토리지 서버 · NSX Manager — 못 읽는 동안 빈 목록이 나가고 화면이
 *     ‘등록된 … 없습니다 · 추가하세요’ 라고 말했다(118회차 vCenter 관리 화면의 꼴 — 운영자가 전부 새로 등록하게 만든다).
 *  B2 설정 폼(전체 교체)에 표지가 없었다: 서버 성능 측정 설정(perf-monitor.json — 폼을 한 번만 채운다) · 패키지 저장소 설정(packages.json — 빈 칸 = 지정 해제).
 *     못 읽은 동안 받은 기본값 · 빈 폼을 다시 읽힌 뒤 저장하면 저장돼 있던 설정이 덮였다(서버의 409 는 읽기 오류가 이어지는 동안만 막는다).
 */
const pass = (ms = RD.READ_RETRY_MS + 1_000) => { NOW += ms; };
/** 원본을 옆에 비켜 두고 그 자리에 폴더를 둔다(실제 EISDIR) — restore() 가 원본을 되돌린다. */
function asDir(name) {
  const keep = F(`${name}.keep128`);
  if (fs.existsSync(F(name)) && !fs.statSync(F(name)).isDirectory()) fs.renameSync(F(name), keep);
  fs.mkdirSync(F(name), { recursive: true });
  return () => { fs.rmSync(F(name), { recursive: true, force: true }); if (fs.existsSync(keep)) fs.renameSync(keep, F(name)); };
}
/** 라우트 등록 함수에 가짜 라우터를 넘겨 마지막 핸들러(게이트 뒤)를 모은다 — 112회차 스윕과 같은 방식. */
function handlersOf(register) {
  const handlers = {};
  const reg = (m) => (p, ...h) => { handlers[`${m} ${p}`] = h.at(-1); };
  register({ get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE'), patch: reg('PATCH'), use: () => {} });
  return async (key, req = {}) => {
    assert.ok(handlers[key], `핸들러 없음: ${key}`);
    let body = null; let code = 200;
    const res = {
      json: (b) => { body = b; return res; }, status: (c) => { code = c; return res; }, set: () => res, setHeader: () => res, getHeader: () => undefined, type: () => res,
      end: (b) => { if (b != null && body == null) { try { body = JSON.parse(String(b)); } catch { body = b; } } return res; }, send: (b) => res.end(b), headersSent: false,
    };
    const rq = { query: {}, body: {}, params: {}, headers: {}, get: () => undefined, user: { username: 'admin', role: 'admin' }, ...req };
    await handlers[key](rq, res, (e) => { if (e) throw e; });
    return { code, body };
  };
}
/** 표지 모양: 읽기 오류 · 사유 요약만 — 파일 경로 · 파일 이름 · 설정 폴더를 싣지 않는다. */
function isMark(le, label, fileName) {
  assert.ok(le && typeof le === 'object', `${label}: 못 읽은 동안의 조회는 표지를 실어야 화면이 ‘등록 없음’ 이라고 말하지 않는다`);
  assert.equal(le.readError, true, `${label}: 읽기 오류(다시 읽히면 풀림)임을 싣는다`);
  const text = JSON.stringify(le);
  assert.ok(!text.includes(TMP), `${label}: 표지에 설정 폴더 경로를 싣지 않는다`);
  if (fileName) assert.ok(!text.includes(fileName), `${label}: 표지에 파일 이름을 싣지 않는다`);
  assert.match(String(le.reason || ''), /읽지 못했습니다|읽기 오류/, label);
}

test('B registryMark: 등록부 로드 오류에서 조회 표지를 만든다 — 읽기 오류는 readError · 손상은 사유 요약만(파일 조각 · 경로 없음)', async () => {
  const { registryMark } = await import('../src/routes/settingsUnreadMark.js');
  assert.deepEqual(registryMark(null), {});
  assert.deepEqual(registryMark(undefined), {});
  const read = registryMark({ at: 1, reason: '읽기 오류(EACCES) — 손상이 아니라 원본은 그대로 둡니다', readError: true, code: 'EACCES' });
  assert.deepEqual(Object.keys(read), ['loadError']);
  assert.equal(read.loadError.readError, true); assert.equal(read.loadError.code, 'EACCES');
  assert.match(read.loadError.reason, /읽지 못했습니다\(EACCES\) — 읽기 오류이고 원본은 그대로 있습니다/);
  const corrupt = registryMark({ at: 1, reason: 'Unexpected token } in JSON at position 17 "password":"hunter2' });
  assert.equal(corrupt.loadError.readError, undefined, '손상은 읽기 오류가 아니다(저장이 새 등록부를 만드는 규약)');
  assert.match(corrupt.loadError.reason, /^등록부 파일을 읽지 못했습니다\(/);
  assert.ok(!corrupt.loadError.reason.includes('hunter2') && !corrupt.loadError.reason.includes('password'), '파일 조각을 싣지 않는다(요약만)');
  const only = registryMark({ at: 1, reason: '등록부 파일이 없고 손상 보존본(x.json.corrupt.1)만 남아 있습니다' });
  assert.ok(only.loadError && !only.loadError.reason.includes('x.json'), '보존본만 남은 경우도 표지 — 파일 이름 없이');
});

test('B1 등록부 조회 5곳(실제 핸들러): 못 읽은 동안 표지를 싣고 다시 읽히면 싣지 않는다 — 빈 목록이 ‘등록 없음’ 이 아니다', () => quiet(async () => {
  /** [이름, 파일, 씨앗, 등록 함수 얻기, 조회 키, 목록 길이] */
  const CASES = [
    ['SAN 스위치 등록부', 'sanswitch-devices.json', { version: 1, devices: [{ id: 'sw1', name: 'sw1', host: '10.0.0.11', type: 'brocade', collectMethod: 'ssh', username: 'admin', enabled: true }] },
      async () => (await import('../src/routes/api/sanSwitch.js')).registerSanSwitch, 'GET /tools/sanswitch', (b) => b.devices.length],
    ['CVP 서버 등록부(현황)', 'cvp-servers.json', { version: 1, servers: [{ id: 'cvp1', name: 'cvp1', host: '10.0.0.12', authMode: 'token', enabled: true }] },
      async () => (await import('../src/routes/api/cvp.js')).registerCvp, 'GET /tools/cvp', (b) => b.servers.length],
    ['CVP 서버 등록부(등록 목록)', 'cvp-servers.json', null,
      async () => { (await import('../src/cvp/registry.js'))._resetForTest(); return (await import('../src/routes/api/cvp.js')).registerCvp; }, 'GET /tools/cvp/servers', (b) => b.servers.length],
    ['베어메탈 스토리지 서버 등록부', 'bm-storage.json', { servers: [{ id: 'bm1', name: 'bm1', host: '10.0.0.13', port: 22, username: 'root', mounts: ['/'], groups: [], enabled: true }], settings: { intervalMinutes: 45 } },
      async () => (await import('../src/routes/api/bmstor.js')).registerBmStorage, 'GET /tools/bm-storage', (b) => b.config.length],
    ['NSX Manager 등록부', 'nsx.json', { managers: [{ id: 'nsx1', name: 'nsx1', host: 'https://10.0.0.14', username: 'admin', enabled: true, location: { region: '아시아' } }] },
      async () => (await import('../src/routes/admin/nsxImport.js')).registerNsxImport, 'GET /nsx/managers', (b) => b.managers.length],
  ];
  for (const [label, file, seed, getReg, key, count] of CASES) {
    if (seed) put(file, seed);
    const restore = asDir(file);   // 모듈이 처음 읽기 전에 읽기 오류로 둔다(같은 파일을 두 번 보는 CVP 는 getReg 가 캐시를 버린다)
    pass();                        // 앞 사례가 건 재읽기 간격을 지나게
    const call = handlersOf(await getReg());
    const bad = await call(key);
    assert.equal(bad.code, 200, `${label}: 조회 자체는 답한다`);
    assert.equal(count(bad.body), 0, `${label}: 못 읽은 동안 목록은 비어 나간다(전제 — 그래서 표지가 필요하다)`);
    isMark(bad.body.loadError, label, file);
    restore(); pass();
    const ok = await call(key);
    assert.equal(ok.body.loadError, undefined, `${label}: 다시 읽히면 표지가 없다`);
    assert.equal(count(ok.body), 1, `${label}: 다시 읽히면 저장된 목록`);
  }
  // 베어메탈 스토리지: 같은 파일의 수집 주기도 못 읽은 동안은 기본값이다(표지 하나가 함께 말한다) · 읽히면 저장값
  const bm = handlersOf((await import('../src/routes/api/bmstor.js')).registerBmStorage);
  assert.equal((await bm('GET /tools/bm-storage')).body.settings.intervalMinutes, 45);
}));

test('B1 등록부 손상(보존본으로 옮김): 표지는 싣되 readError 가 아니다 — 화면은 ‘등록이 없었던 것이 아니다’ 를 말한다', () => quiet(async () => {
  const REG = await import('../src/sanswitch/registry.js');
  put('sanswitch-devices.json', '{ broken');
  REG._resetForTest();
  const call = handlersOf((await import('../src/routes/api/sanSwitch.js')).registerSanSwitch);
  const r = await call('GET /tools/sanswitch');
  assert.equal(r.body.devices.length, 0);
  assert.ok(r.body.loadError && r.body.loadError.readError === undefined, JSON.stringify(r.body.loadError));
  assert.match(r.body.loadError.reason, /손상본은 설정 폴더에 보존돼 있습니다/);
  assert.ok(!r.body.loadError.reason.includes('sanswitch-devices.json'));
  for (const f of corruptOf('sanswitch-devices.json')) fs.rmSync(F(f), { force: true });
  REG._resetForTest();
}));

test('B2 서버 성능 측정 설정 조회: 못 읽은 동안 표지를 싣는다 — 그 기본값 폼의 저장은 다시 읽힌 뒤 서버가 막지 못한다(화면이 잠가야 한다)', () => quiet(async () => {
  const S = await import('../src/perf/settings.js');
  const saved = { enabled: false, slowRequestMs: 4321, retentionDays: 30 };
  put('perf-monitor.json', saved);
  S._resetPerfSettingsCache();
  const call = handlersOf((await import('../src/routes/admin/perfMonitor.js')).registerPerfMonitor);
  const ok = await call('GET /perf');
  assert.equal(ok.body.loadError, undefined);
  assert.equal(ok.body.settings.slowRequestMs, 4321);
  S._resetPerfSettingsCache();
  const restore = asDir('perf-monitor.json');
  const bad = await call('GET /perf');
  isMark(bad.body.loadError, '서버 성능 측정 설정', 'perf-monitor.json');
  assert.notEqual(bad.body.settings.slowRequestMs, 4321, '못 읽은 동안의 settings 는 저장된 값이 아니다');
  assert.equal(bad.body.settings.enabled, S.DEFAULTS.enabled);
  assert.equal((await call('PUT /perf/settings', { body: { enabled: true } })).code, 409, '읽기 오류가 이어지는 동안은 서버가 막는다');
  restore(); pass();
  const again = await call('GET /perf');
  assert.equal(again.body.loadError, undefined, '다시 읽히면 표지가 없다');
  assert.equal(again.body.settings.slowRequestMs, 4321);
  // 재현(수정 전 화면): 못 읽은 동안 한 번 채운 폼을 다시 읽힌 뒤 저장하면 꺼 둔 계측이 켜지고 임계가 기본값으로 돌아간다 — 서버는 그 저장을 받아들인다.
  const form = bad.body.settings;
  const wiped = await call('PUT /perf/settings', { body: { enabled: !!form.enabled, slowRequestMs: form.slowRequestMs, retentionDays: form.retentionDays } });
  assert.equal(wiped.code, 200);
  assert.equal(wiped.body.settings.slowRequestMs, S.DEFAULTS.slowRequestMs, '전체 저장 — 서버가 막지 못한다');
  assert.equal(wiped.body.settings.enabled, S.DEFAULTS.enabled);
  S._resetPerfSettingsCache();
}));

test('B2 패키지 저장소 설정: 못 읽은 동안은 ‘웹 지정 없음’ 으로 보이고 쓰기 거절이 선다 — 조회 라우트가 그 거절로 표지를 싣는다(소스) · 빈 폼 저장은 지정을 지운다', () => quiet(async () => {
  const P = await import('../src/upgrade/packageSettings.js');
  const { unreadMark } = await import('../src/routes/settingsUnreadMark.js');
  put('packages.json', { baseUrl: 'https://mirror.corp.example/vp/download', dir: '/data/pkgs' });
  P._resetPackageSettingsForTest();
  assert.deepEqual(P.getPackageSettings().overridden, { baseUrl: true, dir: true });
  assert.deepEqual(unreadMark(P.packageSettingsWriteRefusal()), {});
  P._resetPackageSettingsForTest();
  const restore = asDir('packages.json');
  assert.deepEqual(P.getPackageSettings().overridden, { baseUrl: false, dir: false }, '못 읽은 동안은 지정 없음으로 보인다(화면 폼 = 빈 칸 둘)');
  isMark(unreadMark(P.packageSettingsWriteRefusal()).loadError, '패키지 저장소 설정', 'packages.json');
  restore(); pass();
  assert.deepEqual(unreadMark(P.packageSettingsWriteRefusal()), {}, '다시 읽히면 표지가 없다');
  // 재현(수정 전 화면): 못 읽은 동안의 빈 폼에 저장 경로만 적어 저장 — 두 칸을 함께 보내므로(빈 칸 = 지정 해제) 사내 미러 주소가 지워진다.
  const after = P.savePackageSettings({ baseUrl: '', dir: '/data/pkgs2' });
  assert.equal(after.overridden.baseUrl, false, '서버는 그 저장을 받아들인다(그래서 화면이 잠가야 한다)');
  P._resetPackageSettingsForTest();
  const route = stripComments(realRead(path.join(SRC, 'routes/admin/deployLlm.js'), 'utf8'));
  assert.match(route, /settings: s, local: listLocalPackages\(\), remote, \.\.\.unreadMark\(packageSettingsWriteRefusal\(\)\)/, 'GET /packages 가 표지를 싣는다');
}));

test('B 화면 배선: 등록부 표지로 빈 목록 문구를 바꾸고 · 설정 폼은 읽기 오류 동안 저장을 잠근다(소스)', () => {
  const WEB = path.join(SRC, '..', '..', 'web', 'src');
  const web = (rel) => stripComments(realRead(path.join(WEB, rel), 'utf8'));
  for (const [file, what] of [['views/tools/SanSwitchTool.jsx', 'SAN 스위치 등록부'], ['views/tools/CvpTool.jsx', 'CVP 서버 등록부'], ['views/NsxAdmin.jsx', 'NSX Manager 등록부']]) {
    const t = web(file);
    assert.match(t, new RegExp(`<RegistryUnreadBanner le=\\{unreadMarkOf\\(data\\)\\} what="${what}"`), `${file}: 등록부 배너`);
    assert.match(t, new RegExp(`registryEmptyText\\(unreadMarkOf\\(data\\), '${what}'\\) \\|\\|`), `${file}: 빈 목록 문구는 표지가 먼저`);
  }
  const bm = web('views/tools/BmStorageTool.jsx');
  assert.match(bm, /<RegistryUnreadBanner le=\{unreadMarkOf\(data\)\} what="베어메탈 스토리지 서버 등록부"/);
  assert.match(bm, /registryEmptyText\(unreadMarkOf\(data\), '서버 등록부'\) \|\|/);
  assert.match(web('views/VeeamEmSettings.jsx'), /d\?\.registryError \? 'Enterprise Manager 등록부를 읽지 못했습니다/, 'EM: 배너 아래에서 ‘등록된 … 없습니다 — 추가하세요’ 를 말하지 않는다');
  assert.match(web('views/tools/PduTool.jsx'), /data\?\.loadErrors\?\.registry \? 'PDU 등록부를 읽지 못했습니다/);
  const pm = web('views/PerfMonitor.jsx');
  assert.ok(!/if \(!inited\.current\) \{ inited\.current = true; setForm/.test(pm), '처음 받은 값을 끝까지 들고 있지 않는다');
  assert.match(pm, /if \(seedKind\.current === null \|\| shouldReseed\(seedKind\.current, le\)\) \{ seedKind\.current = unreadKind\(le\); setForm\(\{ \.\.\.r\.settings \}\); \}/);
  assert.match(pm, /const saveLocked = saveLockedByUnread\(unread\);\s*const save = async \(\) => \{\s*if \(saveLocked\) return;/);
  assert.match(pm, /disabled=\{busy !== '' \|\| saveLocked\} onClick=\{save\}/);
  const ad = web('views/AgentDeploy.jsx');
  assert.match(ad, /const pkgSaveLocked = saveLockedByUnread\(pkgUnread\);\s*const savePkgCfg = async \(\) => \{\s*if \(pkgSaveLocked\) return;/);
  assert.match(ad, /disabled=\{pkgSaveLocked\} onClick=\{savePkgCfg\}/);
  assert.match(ad, /<SettingsUnreadBanner le=\{pkgUnread\} what="패키지 저장소 설정" save="저장" onRecheck=\{loadPkg\}/, '‘다시 확인’ 이 폼을 다시 채운다(loadPkg 는 조회마다 폼을 채운다)');
  // 123회차가 추정으로 남긴 것: 배너는 잠근다고 말하는데 버튼이 열려 있었다
  const net = web('views/tools/IpamNet.jsx');
  assert.match(net, /disabled=\{saveLockedByUnread\(unreadMarkOf\(data\)\)\}[^>]*onClick=\{\(\) => setEdit\(\{ __new: true/, '‘＋ 새 정책’ 을 읽기 오류 동안 잠근다');
  assert.match(net, /unreadKind\(unreadMarkOf\(data\)\) \? '대역 정책 파일을 읽지 못했습니다/, '배너 아래에서 ‘등록된 대역 정책이 없습니다’ 를 말하지 않는다');
  // 123회차가 남긴 ‘손상본 보존’ 문구: 서버가 표지에 readError 를 싣는 화면은 사유별 조치를 가른다(읽기 오류면 보존본이 없다)
  for (const f of ['views/FeatureUsage.jsx', 'views/tools/SanStorageCheck.jsx', 'views/tools/IsiduSettings.jsx', 'views/tools/IsiduDigestSettings.jsx', 'views/tools/IsilonDirUsageTool.jsx']) {
    assert.match(web(f), /unreadFixText\(/, `${f}: 조치 문구는 공용 판정(loadErrorText.js unreadFixText)`);
  }
  assert.equal((web('views/tools/SanStorageCheck.jsx').match(/unreadFixText\(got\.loadError,/g) || []).length, 2, '알림 설정 · 보고서 메일 설정 둘');
  assert.ok(!/String\(data\.settingsLoadError\)\}/.test(web('views/tools/IsilonDirUsageTool.jsx')), '표지 객체를 글자로 바꿔 [object Object] 로 그리지 않는다');
});

/* ═══ C — 웹 postJson 은 409 본문을 던지지 않고 돌려준다(112회차가 '전수 대조하지 못했다' 고 남긴 호출부) ═══════════════════ */
test('C 서버: 그 라우트들이 실제로 409 + 본문을 준다(등록부 읽기 오류) — 화면이 그 본문을 성공으로 읽던 전제', () => quiet(async () => {
  // SAN 스위치 등록(POST) — 등록부 읽기 오류 409
  const REG = await import('../src/sanswitch/registry.js');
  put('sanswitch-devices.json', { version: 1, devices: [] });
  REG._resetForTest();
  const san = handlersOf((await import('../src/routes/api/sanSwitch.js')).registerSanSwitch);
  let restore = asDir('sanswitch-devices.json'); pass();
  const r1 = await san('POST /tools/sanswitch/devices', { body: { name: 'sw9', host: '10.0.0.99', type: 'brocade', username: 'admin', password: 'x' } });
  assert.equal(r1.code, 409); assert.equal(r1.body.ok, false); assert.equal(r1.body.readError, true); assert.match(r1.body.reason, /읽지 못한 상태라 저장하지 않았습니다/);
  restore(); pass(); REG._resetForTest();
  // CVP 서버 등록(POST) · 수정(PUT) — 등록부 읽기 오류 409
  const CR = await import('../src/cvp/registry.js');
  CR._resetForTest();
  const cvp = handlersOf((await import('../src/routes/api/cvp.js')).registerCvp);
  restore = asDir('cvp-servers.json'); pass();
  for (const key of ['POST /tools/cvp/servers', 'PUT /tools/cvp/servers/:id']) {
    const r = await cvp(key, { params: key.startsWith('PUT') ? { id: 'cvp1' } : {}, body: { name: 'c', host: '10.0.0.98', authMode: 'token', token: 't' } });
    assert.equal(r.code, 409, key); assert.equal(r.body.ok, false, key);
  }
  restore(); pass(); CR._resetForTest();
  // CVP 서버 수정(PUT)의 입력 거절은 400 + 본문이다 — 웹 putJson 은 400 도 던지지 않아 ‘저장했습니다.’ 가 떴다(등록부가 멀쩡해도 생기는 경로)
  const bad = await cvp('PUT /tools/cvp/servers/:id', { params: { id: 'cvp1' }, body: { name: 'c', host: '', authMode: 'token' } });
  assert.equal(bad.code, 400, JSON.stringify(bad.body)); assert.equal(bad.body.ok, false); assert.ok(String(bad.body.reason || '').length > 0);
}));

test('C 웹 호출부: 409 본문(ok:false · error)을 성공으로 읽지 않는다 — requireChanged 또는 ok 판정(소스)', () => {
  const WEB = path.join(SRC, '..', '..', 'web', 'src');
  const web = (rel) => stripComments(realRead(path.join(WEB, rel), 'utf8'));
  const must = [
    ['views/tools/SanSwitchTool.jsx', /const r = requireChanged\(await postJson\('\/tools\/sanswitch\/devices', form\)\);/, 'SAN 스위치 등록 — 409 에 ‘저장되었습니다.’'],
    ['views/tools/CvpTool.jsx', /const r = requireChanged\(isNew \? await postJson\('\/tools\/cvp\/servers', body\) : await putJson\(/, 'CVP 서버 등록 · 수정 — 409 · 400 에 ‘저장했습니다.’'],
    ['views/tools/PduTool.jsx', /requireChanged\(await postJson\('\/tools\/pdu\/thresholds', \{ enabled, \.\.\.vals \}\)\);/, 'PDU 임계치 — 409 에 ‘저장했습니다.’'],
    ['views/tools/PduTool.jsx', /r\?\.ok === false && !Array\.isArray\(r\.failed\) \? \{ \.\.\.r, failed: \[r\.reason/, 'PDU CSV 가져오기 — 409 사유가 ‘추가 0 · 수정 0’ 에 묻혔다'],
    ['views/tools/BareosLiveTab.jsx', /const out = requireChanged\(await postJson\(`\/tools\/bareos-backup\/jobs\/\$\{encodeURIComponent\(r\.id\)\}\/cancel`/, 'Bareos 실행 취소 — 409 에 ‘취소를 보냈습니다’'],
    ['views/tools/BareosLiveTab.jsx', /const out = requireChanged\(await postJson\(`\/tools\/bareos-backup\/groups\/\$\{encodeURIComponent\(g\.id\)\}\/cancel`, body\)\);/, 'Bareos 그룹 회차 중단 — 409 에 ‘중단을 시작했습니다’'],
    ['views/svcmon/TestWizard.jsx', /else requireChanged\(await postJson\(`\/svcmon\/targets\/\$\{wiz\.targetId\}\/tests`, body\)\);/, '서비스 점검 추가 — 409 에 창이 닫혔다'],
    ['views/GuestAccount.jsx', /setRes\(requireChanged\(r\)\);/, '게스트 계정 추가 — 409 사유가 빈 결과 카드에 묻혔다'],
    ['views/tools/DiskBadTool.jsx', /\.then\(\(r\) => \{ requireChanged\(r\); if \(r\?\.job\) setJobs\(/, '디스크 점검 작업 멈춤 · 다시 보내기 — 409 본문으로 목록에 undefined'],
    ['views/tools/bmFolders/EdgeView.jsx', /const r = requireChanged\(await postJson\('\/tools\/bm-folders\/edge\/pull', \{\}\)\);/, '사본 지금 받기'],
    ['views/tools/FocusMonTool.jsx', /if \(r\?\.ok === false \|\| !r\?\.job\) return \{ ok: false, reason: r\?\.reason/, '연결 시험 일괄 — 409 사유'],
    ['views/tools/FocusMonBulk.jsx', /if \(b\?\.ok === false \|\| !b\?\.job\) return \{ ok: false, reason:/, '가져오기 뒤 연결 시험 — 409 사유'],
  ];
  for (const [file, re, why] of must) assert.match(web(file), re, `${file}: ${why}`);
  const sm = web('views/SvcMonitor.jsx');
  assert.equal((sm.match(/requireChanged\(await postJson\('\/svcmon\/folders(?:\/move)?',/g) || []).length, 3, '서비스 모니터 폴더 만들기 · 옮기기 셋 — 409 본문을 삼키지 않는다');
  assert.ok(!/[^(]await postJson\('\/svcmon\/folders/.test(sm), '판정 없이 부르는 폴더 호출이 남지 않았다');
});
