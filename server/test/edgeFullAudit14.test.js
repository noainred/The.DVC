/**
 * edgeFullAudit14.test.js — 전체 소스 점검 14회차(엣지 통신 ① 중앙 수신) 확정분.
 *  ① C-1: 중앙 직접 수집 장비 거절(onlyDelegated)은 저장 키와 같은 정규화(edgeId — 앞뒤 공백 · 제어 문자)로 · 후보 id(deviceId · id) 중 하나라도 직접 장비면 거절
 *  ② C-2: 노드 부하 표본 — 중앙이 DB 를 쓰지 못했으면(db-unavailable · db-error) 엣지는 고리를 지우지 않는다
 *  ③ C-3: /inventory generatedAt 은 수 또는 40자 글자만
 *  ④ C-4: 작업 로그의 엣지 시각은 수신 시각으로 자르고 원본은 edgeAt
 *  ⑤ C-5: /log-query-result 는 반영하지 못한 reqId 에 410
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'edgefa14-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
test.after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });
const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), '../src');
const rd = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

test('① C-1 — 앞뒤 공백 · 제어 문자 · 빈 deviceId + id 로 중앙 직접 장비 거절을 비켜 가지 못한다', async () => {
  const { onlyDelegated } = await import('../src/routes/central/storageRoutes.js');
  const fake = path.join(DIR, 'fakeReg.mjs');
  fs.writeFileSync(fake, "export function listDevices() { return [{ id: 'unity-1', agent: '' }, { id: 'edge-1', agent: 'edge-a' }]; }\n");
  const reg = pathToFileURL(fake).href;
  const list = [{ deviceId: ' unity-1 ' }, { deviceId: 'unity-1\t' }, { deviceId: '', id: 'unity-1' }, { deviceId: {}, id: 'unity-1' }, { deviceId: 'edge-1' }, { deviceId: 'unity-1' }];
  const r = await onlyDelegated(list, (d) => [d.deviceId, d.id], reg);
  assert.equal(r.denied, 5, '중앙 직접 장비 다섯 모양 모두 거절');
  assert.deepEqual(r.list.map((d) => d.deviceId), ['edge-1']);
  // 값 하나를 주는 호출(SAN · PDU)도 정규화한다
  const r2 = await onlyDelegated([{ deviceId: ' unity-1 ' }, { deviceId: 'edge-1' }], (d) => d.deviceId, reg);
  assert.equal(r2.denied, 1);
  assert.match(rd('routes/central/storageRoutes.js'), /onlyDelegated\(devices, \(d\) => \[d\.deviceId, d\.id\], '\.\.\/storage\/registry\.js'\)/);
});

test('② C-2 — 중앙이 표본 DB 를 못 쓰면 엣지는 고리를 지우지 않는다(소스)', () => {
  assert.match(rd('central/storageEdge.js'), /r\?\.reason === 'db-unavailable' \|\| r\?\.reason === 'db-error'\) out\.dbUnavailable = true;/);
  const push = rd('storage/push.js');
  assert.match(push, /if \(ack\?\.dbUnavailable\) console\.warn\([^\n]*\n\s*else markNodeLoadSamplesSent\(nodeLoadSamples\);/);
});

test('③ C-3 · ⑤ C-5 — generatedAt 좁히기 · 모르는 reqId 410(소스)', () => {
  const c = rd('routes/central.js');
  assert.match(c, /const genAt = typeof genIn === 'number' && Number\.isFinite\(genIn\) \? genIn : \(typeof genIn === 'string' && genIn\.trim\(\) \? genIn\.trim\(\)\.slice\(0, 40\) : null\);/);
  assert.doesNotMatch(c, /setInventory\(vcId, slice, agent, b\.generatedAt \|\| null\)/);
  assert.match(rd('routes/central/opsRoutes.js'), /if \(!setLogQueryResult\(String\(b\.reqId\), b\)\) return res\.status\(410\)/);
});

test('④ C-4 — 작업 로그 at 은 수신 시각 이하 · 엣지 원본은 edgeAt', async () => {
  const { createActivityLog } = await import('../src/util/activityLog.js');
  const log = createActivityLog({ fileName: 'fa14-activity.json', max: 10, writeGapMs: 0 });
  const future = Date.now() + 2 * 3_600_000;
  const e = log.recordActivity({ at: future, deviceId: 'd1', source: 'edge-a', ok: true });
  assert.ok(e.at <= Date.now(), '미래 시각이 아니다'); assert.equal(e.edgeAt, future, '원본은 따로');
  const past = Date.now() - 60_000;
  const e2 = log.recordActivity({ at: past, deviceId: 'd2', source: 'edge-a', ok: true });
  assert.equal(e2.at, past); assert.equal(e2.edgeAt, undefined);
  log.flush();
});
