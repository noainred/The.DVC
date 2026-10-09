/**
 * 2026-10-09 검토 S-10(리드 통합) — 백업 복원이 portal.env 의 보안 스위치를 번들 값으로 되돌려 보호를 약하게 만들지 못한다.
 * 실제 createBackup → readBackup → restoreCentral 경로로 확인한다(번들의 portal.env 를 복원 직전에 약한 값으로 바꿔 넣는다).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'rvlead-envpin-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';

let BK; let ENV;
before(async () => {
  ENV = await import('../src/util/envRedact.js');
  BK = await import('../src/backup/service.js');
});

test('pinHostSecurityEnv — 보안 키는 현재 값 · 현재에 없으면 번들 줄을 버린다 · 현재에만 있으면 이어 붙인다 · 그 밖은 번들 값', () => {
  const inc = 'PORT=4000\nUPGRADE_SIGNATURE_POLICY=warn\nVC_TLS_REJECT_UNAUTHORIZED=false\nAUTH_ENABLED=false\nX=1';
  const cur = 'PORT=4001\nVC_TLS_REJECT_UNAUTHORIZED=true\nSSH_HOSTKEY_POLICY=enforce';
  const r = ENV.pinHostSecurityEnv(inc, cur);
  const lines = r.text.split('\n');
  assert.ok(lines.includes('PORT=4000'), '보안 키가 아닌 값은 번들 값');
  assert.ok(lines.includes('X=1'));
  assert.ok(lines.includes('VC_TLS_REJECT_UNAUTHORIZED=true'), '현재 값 유지');
  assert.ok(!r.text.includes('UPGRADE_SIGNATURE_POLICY=warn'), '현재에 없는 약화 키는 버린다');
  assert.ok(!r.text.includes('AUTH_ENABLED=false'));
  assert.ok(lines.includes('SSH_HOSTKEY_POLICY=enforce'), '현재에만 있는 보안 키는 유지');
  assert.deepEqual(r.pinned.sort(), ['AUTH_ENABLED', 'UPGRADE_SIGNATURE_POLICY', 'VC_TLS_REJECT_UNAUTHORIZED']);
});

test('restoreCentral — 번들의 약한 보안 스위치가 현재 portal.env 를 덮지 않는다(실제 백업 → 복원)', async () => {
  fs.writeFileSync(path.join(CFG, 'portal.env'), 'PORT=4000\nWAN_TLS_INSECURE=false\nAUTH_SECRET=keep-me\n');
  const r = await BK.createBackup('manual');
  const a = BK.readBackup(r.name);
  // 번들 안의 portal.env 를 약한 값으로 바꾼다(예전 백업이 약한 설정이었던 경우와 같다)
  a.central.files['portal.env'] = 'PORT=4100\nWAN_TLS_INSECURE=true\nUPGRADE_SIGNATURE_POLICY=warn\nAUTH_SECRET=keep-me\n';
  const rr = await BK.restoreCentral(a);
  const after = fs.readFileSync(path.join(CFG, 'portal.env'), 'utf8');
  assert.ok(after.includes('PORT=4100'), `일반 키는 복원돼야 한다:\n${after}`);
  assert.ok(after.includes('WAN_TLS_INSECURE=false') && !after.includes('WAN_TLS_INSECURE=true'), `보안 스위치가 약해졌다:\n${after}`);
  assert.ok(!after.includes('UPGRADE_SIGNATURE_POLICY'), `현재에 없던 약화 키가 들어왔다:\n${after}`);
  assert.ok(Array.isArray(rr.envKeysPinned) && rr.envKeysPinned.includes('portal.env:WAN_TLS_INSECURE'), JSON.stringify(rr));
});
