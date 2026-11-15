/**
 * edgeFullAudit17.test.js — 전체 소스 점검 17회차(중앙 수신 잔여 · 14 · 15회차 반증) 확정분.
 *  ① C-10: 배포 사용자 파일을 못 읽는 동안 쓰기 3함수는 거절(503) — 관리자 저장 1건이 '읽지 못함' 표지를 지워 다른 엣지의 managed 계정이 지워지던 것.
 *         서비스 점검 목록에 나오고 '기본값으로 확정' 으로만 풀린다.
 *  ② C-11: 파트 장애 엣지 보고의 scanned 는 아는 필드만(원본 객체 그대로 보관 · 응답하던 것)
 *  ③ R-1: 인벤토리 generatedAt 은 평탄화(capTrim) — slice 가 수 MB 원문을 캐시에 붙잡던 것
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edgefa17-'));
process.env.CONFIG_DIR = tmp;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// 잘린 JSON — 모듈 로드 시 손상으로 판정된다
fs.writeFileSync(path.join(tmp, 'central-agent-users.json'), '{"*":{"at":1,"users":[{"username":"admin2","role":"admin"}]},"edge-a":{"at":1,"users":[{"username":"op1"');

test('① C-10 — 손상 상태에서 upsert · bulk · remove 는 거절되고 표지가 남는다 · 확정으로만 풀린다', async () => {
  const au = await import('../src/central/agentUsers.js');
  assert.ok(au.registryLoadError(), '손상 판정');
  const r = au.upsertAgentUser('edge-b', { username: 'newop', role: 'viewer', password: 'Passw0rd!x' });
  assert.equal(r.ok, false); assert.equal(r.code, 'registry-unreadable'); assert.equal(r.status, 503);
  assert.match(r.reason, /다른 엣지의 배포 사용자가 모든 엣지에서 지워집니다/);
  assert.equal(au.upsertAgentUsersBulk(['edge-b', 'edge-c'], { username: 'x1', role: 'viewer' }).code, 'registry-unreadable');
  assert.equal(au.removeAgentUser('edge-a', 'op1').code, 'registry-unreadable');
  assert.ok(au.registryLoadError(), '거절 뒤에도 표지가 그대로(→ /users-config 503 유지)');
  assert.ok(!fs.existsSync(path.join(tmp, 'central-agent-users.json')), '손상 원본은 보존본으로 옮겨졌고 새로 쓰지 않았다');
  // 서비스 점검 목록에 나오고 확정할 수 있다
  const { listSettingsLoadErrors, confirmSettingsDefault } = await import('../src/util/settingsLoadError.js');
  const row = listSettingsLoadErrors().find((x) => x.file === 'central-agent-users.json');
  assert.ok(row, '서비스 점검 목록'); assert.equal(row.confirmable, true);
  const c = confirmSettingsDefault('central-agent-users.json', { by: 'test' });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(au.registryLoadError(), null, '확정 뒤 풀린다');
  assert.equal(au.upsertAgentUser('edge-b', { username: 'newop', role: 'viewer', password: 'Passw0rd!x' }).ok, true, '확정 뒤에는 저장된다');
});

test('① C-10 — 관리 라우트는 503 으로 답한다(400 아님)', () => {
  const src = fs.readFileSync(new URL('../src/routes/admin/gpuGuest.js', import.meta.url), 'utf8');
  for (const fn of ['upsertAgentUser\\(req\\.params\\.agent', 'upsertAgentUsersBulk\\(targets', 'removeAgentUser\\(req\\.params\\.agent']) {
    assert.match(src, new RegExp(`${fn}[^\\n]*\\);\\n  res\\.status\\(r\\.ok \\? 200 : \\(r\\.status \\|\\| 400\\)\\)`), fn);
  }
});

test('② C-11 — scanned 는 아는 필드만 · 개수는 수(못 읽으면 null) · 장비군 표지 정제', async () => {
  const { sanitizeScanned, putEdgeReport, edgeReport, _resetForTest } = await import('../src/central/partFaultEdge.js');
  const out = sanitizeScanned({
    at: 1_700_000_000_000, agent: 'e1', evil: { deep: 'x'.repeat(1000) },
    idrac: { devices: 3, ok: '2', failed: { x: 1 }, junk: 'y' },
    storage: { devices: 1, notCollected: { a: 1, b: 'z' }, extra: [1, 2] },
    sanswitch: { extractor: 'yes', registryUnreadable: { at: 5, code: 'parse-error', reason: 'r', leak: 'S' } },
    summary: { total: 5, unknown: null, x: 1 }, devicesFailed: 1,
  });
  assert.deepEqual(out, {
    at: 1_700_000_000_000, agent: 'e1',
    idrac: { devices: 3, ok: 2, failed: null },
    storage: { devices: 1, notCollected: { a: 1, b: null } },
    sanswitch: { extractor: false, registryUnreadable: { at: 5, code: 'parse-error', reason: 'r' } },
    summary: { total: 5, unknown: null }, devicesFailed: 1,
  });
  assert.equal(sanitizeScanned([1, 2]), null); assert.equal(sanitizeScanned('x'), null);
  // 수신 경로가 정제본을 보관한다
  _resetForTest(async () => ({ storage: new Set(), sanswitch: new Set() }));
  const pr = await putEdgeReport('edge-z', { v: 2, at: Date.now(), devices: [], scanned: { summary: { total: 1 }, junk: { a: 1 } } });
  const rep = edgeReport('edge-z');
  assert.ok(rep, JSON.stringify(pr));
  assert.equal(rep.scanned.junk, undefined, '원본 객체를 보관하지 않는다'); assert.deepEqual(rep.scanned.summary, { total: 1 });
  const src = fs.readFileSync(new URL('../src/central/partFaultEdge.js', import.meta.url), 'utf8');
  assert.match(src, /<= SCANNED_MAX_BYTES \? sanitizeScanned\(body\.scanned\) : null/);
});

test('③ R-1 — generatedAt 은 capTrim(평탄화)', () => {
  const src = fs.readFileSync(new URL('../src/routes/central.js', import.meta.url), 'utf8');
  assert.match(src, /typeof genIn === 'string' \? \(capTrim\(genIn, 40\) \|\| null\) : null/);
  assert.doesNotMatch(src, /genIn\.trim\(\)\.slice\(0, 40\)/);
});
