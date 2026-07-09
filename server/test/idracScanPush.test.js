import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idpush-'));

let addCollector, findCollectorForAgent, pushIdracScan;
before(async () => {
  ({ addCollector } = await import('../src/collector/registry.js'));
  ({ findCollectorForAgent, pushIdracScan } = await import('../src/central/idracScanPush.js'));
});

test('findCollectorForAgent: 원본 토큰 포함 반환(대소문자 무관, 마스킹 금지)', () => {
  addCollector({ id: 'oc2sandbox', name: 'oc2sandbox', url: 'http://10.0.0.9:4000', token: 'SECRET-TOKEN', datacenter: 'oc2sandbox', enabled: true });
  // 에이전트 이름 대소문자가 달라도 매칭.
  const c = findCollectorForAgent('OC2Sandbox');
  assert.ok(c, '수집 서버 매칭');
  assert.equal(c.url, 'http://10.0.0.9:4000');
  // ★ PUSH 인증에 쓰이는 토큰 원본이 반드시 포함돼야 한다(listCollectors 마스킹 회귀 방지).
  assert.equal(c.token, 'SECRET-TOKEN', 'findCollectorForAgent는 마스킹 아닌 원본 토큰을 준다');
});

test('pushIdracScan: 매칭 수집 서버(URL) 없으면 ok:false + 안내', () => {
  const r = pushIdracScan('no-such-agent', { ips: '10.0.0.1', username: 'root', password: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.reason || '', /수집 서버/);
});
