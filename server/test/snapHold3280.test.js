/**
 * snapHold3280.test.js — v3.28.0 스냅샷 3단계: 보류(기한 있는 예외) · 만든 계정.
 *   ① 보류는 hygieneFindings 하나가 판정(카드 · VM 구성 점검 · 알림 · 스냅샷 화면이 같은 판정) · 기한은 판정 시각으로 다시 본다
 *   ② 설정 로더가 붙인 holds 는 열거되지 않는다 — 설정 저장 · 응답 · rev 에 섞이지 않는다
 *   ③ setHold — 기한 필수(1~90일) · 사유 필수 · 0 = 풀기 · 못 읽은 파일 위에 저장하지 않는다(503)
 *   ④ 만든 계정 — VM 단위 · 같은 이름 VM 은 잇지 않음 · 백업 도구 계정 제외
 *   ⑤ 라우트(정적) — 쓰기는 관리자 · 조회 밖 404 → 쓰기 밖 403 · 감사 기록 · 계정 이름은 관리자 판본만
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snaphold3280-'));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* */ } });
process.env.CONFIG_DIR = TMP;
process.env.SNAPHIST_DB_PATH = path.join(TMP, 'snap-history.db');

const { hygieneFindings, holdOf } = await import('../src/vmhygiene/analyze.js');
const { loadVmHygieneSettings, saveVmHygieneSettings, _resetVmHygieneSettings } = await import('../src/vmhygiene/settings.js');
const { setHold, loadHolds, HOLD_DAYS_MAX, HOLDS_FILE_NAME, _resetHoldsForTest } = await import('../src/vmhygiene/holds.js');
const { snapshotToolView } = await import('../src/snaphist/view.js');
const { creatorsOf } = await import('../src/snaphist/creators.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const vm = { id: 'va:vm1', vcenterId: 'va', name: 'vm1', snapshotCount: 5, snapshotSizeGB: 500, snapshotOldestTs: NOW - 50 * DAY, powerState: 'POWERED_ON' };

test('① 보류 — 판정에서 빠지고, 기한이 지나면 다시 판정된다', () => {
  const s = { snapAgeDays: 7, snapCount: 3, snapSizeGB: 100, uptimeDays: 365, exceptions: [] };
  Object.defineProperty(s, 'holds', { value: new Map([['va\nva:vm1', { until: NOW + DAY, reason: 'DB 이관 중' }]]), enumerable: false });
  const f = hygieneFindings(vm, s, NOW);
  assert.equal(f.findings.filter((x) => x.code.startsWith('snap-')).length, 0);
  assert.equal(f.held.reason, 'DB 이관 중');
  const later = hygieneFindings(vm, s, NOW + 2 * DAY);
  assert.ok(later.findings.some((x) => x.code === 'snap-age'), '기한이 지난 보류는 판정에서 빼지 않는다(캐시된 Map 이라도)');
  assert.equal(holdOf({ id: 'x', vcenterId: 'va' }, s, NOW), null);
  const v = snapshotToolView({ vcenters: [{ id: 'va', name: 'A' }], vms: [vm], datastores: [] }, { hygiene: s, now: NOW });
  assert.equal(v.items[0].skip, 'hold'); assert.equal(v.items[0].judged, false); assert.equal(v.items[0].hold.reason, 'DB 이관 중');
  assert.equal('by' in v.items[0].hold, false, '건 계정은 화면 응답에 싣지 않는다');
});

test('② 설정 로더의 holds 는 열거되지 않는다 — 저장 · 응답 · rev 에 섞이지 않는다', () => {
  _resetHoldsForTest(); _resetVmHygieneSettings();
  const r = setHold({ vcenterId: 'va', vmId: 'va:vm1', vmName: 'vm1', days: 10, reason: '점검' }, 'admin1', NOW);
  assert.equal(r.ok, true);
  const s = loadVmHygieneSettings();
  assert.ok(s.holds instanceof Map); assert.equal(s.holds.size, 1);
  assert.equal(Object.keys(s).includes('holds'), false);
  assert.equal(JSON.stringify(s).includes('va:vm1'), false);
  const saved = saveVmHygieneSettings({ snapAgeDays: 8 }, 'admin1');
  assert.equal(saved.snapAgeDays, 8);
  const file = JSON.parse(fs.readFileSync(path.join(TMP, 'vm-hygiene.json'), 'utf8'));
  assert.equal('holds' in file, false);
  assert.equal(hygieneFindings(vm, loadVmHygieneSettings(), NOW).held?.reason, '점검', '저장 뒤 새 캐시에도 보류가 붙는다');
});

test('③ setHold — 기한 · 사유 · 풀기 · 못 읽은 파일', () => {
  _resetHoldsForTest();
  assert.equal(setHold({ vcenterId: 'va', vmId: 'v2', days: HOLD_DAYS_MAX + 1, reason: 'x' }, 'a', NOW).status, 400);
  assert.equal(setHold({ vcenterId: 'va', vmId: 'v2', days: 1.5, reason: 'x' }, 'a', NOW).status, 400);
  assert.equal(setHold({ vcenterId: 'va', vmId: 'v2', days: '', reason: 'x' }, 'a', NOW).status, 400, '빈 값은 0(풀기)이 아니다');
  assert.equal(setHold({ vcenterId: 'va', vmId: 'v2', days: 3, reason: '  ' }, 'a', NOW).status, 400);
  assert.equal(setHold({ vcenterId: 'va', vmId: 'v2', days: 3, reason: '패치' }, 'a', NOW).ok, true);
  assert.equal(loadHolds(NOW).holds.length, 2);
  assert.equal(loadHolds(NOW + 4 * DAY).holds.length, 1, '지난 보류는 목록에서 빠진다');
  assert.equal(setHold({ vcenterId: 'va', vmId: 'v2', days: 0 }, 'a', NOW).ok, true);
  assert.equal(loadHolds(NOW).holds.length, 1);
  // 못 읽는 파일(디렉터리로 바꿔 읽기 오류를 낸다) — 저장 거절
  const f = path.join(TMP, HOLDS_FILE_NAME); const keep = fs.readFileSync(f, 'utf8');
  fs.rmSync(f); fs.mkdirSync(f); _resetHoldsForTest();
  const r = setHold({ vcenterId: 'va', vmId: 'v3', days: 3, reason: 'x' }, 'a', NOW);
  assert.equal(r.status, 503);
  fs.rmSync(f, { recursive: true }); fs.writeFileSync(f, keep); _resetHoldsForTest();
});

test('④ 만든 계정 — VM 단위 · 같은 이름 VM 은 잇지 않음 · 백업 계정 제외 · 가장 최근', () => {
  const vms = [{ id: 'a:1', name: 'web' }, { id: 'a:2', name: 'dup' }, { id: 'a:3', name: 'dup' }];
  const ev = (entity, user, ts, type = 'VmSnapshotCreatedEvent') => ({ entity, user, ts, type, message: 'Task: Create virtual machine snapshot', severity: 'info' });
  const r = creatorsOf(vms, [ev('web', 'kim', 10), ev('web', 'lee', 20), ev('web', 'svc-veeam', 30), ev('dup', 'park', 5), ev('ghost', 'x', 5)], (u) => /veeam/.test(u));
  assert.deepEqual(r.byVm.get('a:1'), { user: 'lee', ts: 20 });
  assert.equal(r.byVm.has('a:2'), false); assert.equal(r.ambiguous, 1); assert.equal(r.unmatched, 1);
});

test('⑤ 라우트(정적) — 관리자 쓰기 · 404 → 403 순서 · 감사 · 계정은 관리자 판본만', () => {
  const src = stripComments(fs.readFileSync(path.join(HERE, '../src/routes/api/vcTools.js'), 'utf8'));
  const body = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a) + 1));
  const put = body("api.put('/tools/snapshots/holds'", "api.get('/tools/snapshots/history/vm'");
  assert.match(put, /requireRole\('admin'\)/);
  const i404 = put.indexOf('status(404)'); const i403 = put.indexOf('status(403)');
  assert.ok(i404 > 0 && i403 > i404, '조회 밖 404 가 먼저, 쓰기 밖 403 이 뒤');
  assert.match(put, /inUserWriteScope\(req\.user, snap, vcenterId\)/); assert.match(put, /logAudit\(/);
  const get = body("api.get('/tools/snapshots/holds'", "api.put('/tools/snapshots/holds'");
  assert.match(get, /scopedVcenterIds\(req\.user/); assert.match(get, /by: admin \? h\.by : null/);
  const cr = body("api.get('/tools/snapshots/creators'", "api.get('/tools/snapshots/holds'");
  assert.match(cr, /scopedVcenterIds\(req\.user/); assert.match(cr, /user: admin \? c\.user : null/); assert.match(cr, /isAdminDetailUser\(req\.user\) \? 'a' : 'u'/);
  const list = body("api.get('/tools/snapshots'", "api.get('/tools/snapshots/history'");
  assert.match(list, /holdsGeneration\(\)/);
});
