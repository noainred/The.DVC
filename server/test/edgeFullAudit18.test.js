/**
 * edgeFullAudit18.test.js — 전체 점검 18회차(16 · 17회차 반증 + 중앙 수신 잔여) 확정분.
 *  B-1 '기본값으로 확정' 은 파일이 다시 있으면(되돌린 보존본) 덮지 않는다(409 file-present)
 *  B-2 확정 게이트는 그 설정의 쓰기 게이트보다 약하지 않다(ownerOnly — 엣지 배포 사용자)
 *  B-3 iDRAC 스캔 배정도 못 읽은 동안 한 엣지 쓰기를 거절한다(바꾸기 가져오기만 허용)
 *  B-4 성능점검 배정 파일을 못 읽으면 '기동 후 보고 없음' 감시는 판정 보류를 밝힌다(조용히 꺼지지 않는다)
 *  (A-1 · A-2 · A-3 은 edgeFullAudit16 에)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edgefa18-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_DIR = tmp;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const GOOD_USERS = JSON.stringify({ 'edge-a': { at: 1, users: [{ username: 'op1', role: 'operator' }] } });
fs.writeFileSync(path.join(tmp, 'central-agent-users.json'), GOOD_USERS.slice(0, -5));               // 잘림
fs.writeFileSync(path.join(tmp, 'agent-assignments.json'), '{"assignments":[{"agent":"edge-a","ips":"10.0.0.0/24"');   // 잘림
fs.writeFileSync(path.join(tmp, 'central-svcmon-assign.json'), '{"v":1,"agents":{"edge-a":');                         // 잘림

test('B-1 — 오류 중 파일이 다시 있으면 확정이 덮지 않는다(409 file-present) · 없으면 예전처럼 확정', async () => {
  const au = await import('../src/central/agentUsers.js');
  const { listSettingsLoadErrors, confirmSettingsDefault } = await import('../src/util/settingsLoadError.js');
  assert.ok(au.registryLoadError());
  const F = path.join(tmp, 'central-agent-users.json');
  assert.ok(!fs.existsSync(F), '손상 원본은 보존본으로 옮겨졌다');
  fs.writeFileSync(F, GOOD_USERS);   // 운영자가 보존본을 되돌림(재시작 전)
  assert.ok(listSettingsLoadErrors().some((x) => x.file === 'central-agent-users.json'), '메모리 표지는 아직 서 있다');
  const r = confirmSettingsDefault('central-agent-users.json', { by: 't' });
  assert.equal(r.ok, false); assert.equal(r.code, 'file-present'); assert.match(r.detail, /재시작/);
  assert.equal(fs.readFileSync(F, 'utf8'), GOOD_USERS, '되돌린 파일을 기본값으로 덮지 않았다');
  fs.rmSync(F);
  assert.equal(confirmSettingsDefault('central-agent-users.json', { by: 't' }).ok, true, '파일이 없으면 예전처럼 확정');
  const src = fs.readFileSync(new URL('../src/routes/api/checksLogs.js', import.meta.url), 'utf8');
  assert.match(src, /r\.code === 'file-present' \? 409/);
  const web = fs.readFileSync(new URL('../../web/src/views/settingsFileConfirmText.js', import.meta.url), 'utf8');
  assert.match(web, /'file-present':/);
  const dv = fs.readFileSync(new URL('../../web/src/views/DavinciChecks.jsx', import.meta.url), 'utf8');
  assert.match(dv, /\{ ok: !!r\?\.ok, text: resultText\(r\) \}/, '409 를 성공 색으로 칠하지 않는다');
});

test('B-2 — 엣지 배포 사용자는 ownerOnly(확정 라우트가 설정 소유자 등급을 요구)', async () => {
  const { settingsFileOwnerOnly } = await import('../src/util/settingsLoadError.js');
  assert.equal(settingsFileOwnerOnly('central-agent-users.json'), true);
  assert.equal(settingsFileOwnerOnly('agent-assignments.json'), false);
  const src = fs.readFileSync(new URL('../src/routes/api/checksLogs.js', import.meta.url), 'utf8');
  assert.match(src, /if \(settingsFileOwnerOnly\(file\)\) \{ const g = settingsOwnerGradeDenial\(req\); if \(g\) return res\.status\(403\)\.json\(g\); \}\n(?:.*\n)?  const r = confirmSettingsDefault/);   // 20회차 F8: super 게이트 줄이 사이에 올 수 있다
});

test('B-3 — iDRAC 스캔 배정: 못 읽은 동안 추가 · 수정 · 삭제 · 병합 가져오기 거절 · 바꾸기는 허용', async () => {
  const A = await import('../src/central/assignments.js');
  assert.ok(A.assignmentsLoadError());
  const body = { agent: 'edge-b', ips: '10.1.0.0/24', username: 'root', password: 'pw' };
  for (const r of [A.addAssignment(body), A.updateAssignment('edge-a', body), A.removeAssignment('edge-a'), A.importAssignments([body], 'merge')]) {
    assert.equal(r.ok, false); assert.equal(r.code, 'registry-unreadable'); assert.equal(r.status, 503);
  }
  assert.ok(A.assignmentsLoadError(), '표지가 그대로(→ /assignment 503 유지)');
  const rep = A.importAssignments([body], 'replace');
  assert.equal(rep.ok, true, JSON.stringify(rep));
  assert.equal(A.assignmentsLoadError(), null, '목록 전체를 다시 정하면 풀린다');
  const src = fs.readFileSync(new URL('../src/routes/admin/horizonAssign.js', import.meta.url), 'utf8');
  assert.equal((src.match(/\(result\.status \|\| 40[04]\)/g) || []).length, 4, '라우트 4곳이 503 을 그대로 낸다');
});

test('B-4 — 성능점검 배정 파일을 못 읽으면 무보고 감시는 판정 보류를 밝힌다', async () => {
  const S = await import('../src/central/svcmonSilence.js');
  S._resetSilenceState({ startedAt: Date.now() - 86_400_000 });
  const r = await S.checkSilenceOnce({ now: Date.now() });
  assert.equal(r.noReportHeld, true);
  assert.match(S.silenceStatus().assignError || '', /판정을 보류/);
});
