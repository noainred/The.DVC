// v2.674 — 로그인 실패 기록은 깨진 줄 하나 때문에 전체를 버리지 않는다 · ipam-scan-agents.json 은 상태 파일이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-loginstore2674-'));
process.env.CONFIG_DIR = dir;
const FILE = path.join(dir, 'login-fails.ndjson');
const now = Date.now();
const line = (i) => JSON.stringify({ ts: now - i * 60_000, source: 'portal', kind: 'portal', user: `u${i}`, ip: '10.0.0.1' });
// 정상 3줄 + 깨진 줄(쓰기 중 절단) + 정상 1줄
fs.writeFileSync(FILE, [line(1), line(2), line(3), '{"ts":12', line(4)].join('\n') + '\n');
const m = await import('../src/security/loginStore.js');

test('① 깨진 줄만 건너뛰고 나머지 기록은 유지한다(예전: 전체를 버리고 다음 저장이 덮어씀)', () => {
  const rows = m.getStoredFails(0);
  assert.equal(rows.length, 4, `유지된 기록 ${rows.length}`);
  assert.equal(m.loginStoreSkippedLines(), 1);
});

test('② 새 기록을 더해 저장해도 기존 기록이 남는다', async () => {
  m.recordPortalLoginFail({ username: 'new', ip: '10.0.0.9', reason: 'bad password' });
  await new Promise((r) => setTimeout(r, 4300));   // persistSoon 디바운스 4초
  const kept = fs.readFileSync(FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(kept.length, 5, `저장된 줄 ${kept.length}`);
  assert.ok(kept.some((r) => r.user === 'u3') && kept.some((r) => r.user === 'new'));
});

test('③ ipam-scan-agents.json(에이전트별 마지막 스캔 보고)은 상태 파일이라 백업 변경 감시에서 빠진다', async () => {
  const { isRuntimeStateFile } = await import('../src/backup/service.js');
  assert.equal(isRuntimeStateFile('ipam-scan-agents.json'), true);
});
