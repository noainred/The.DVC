import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// EDGE_MODE=all — 3개 env(EDGE_MODE/CENTRAL_URL/EDGE_TOKEN)만으로 엣지 전 기능이 켜지는지.
// config.js는 import 시점에 env를 읽으므로, import 전에 env를 세팅한다(파일별 프로세스 격리).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edgemode-'));
process.env.CONFIG_DIR = tmp;
process.env.EDGE_MODE = 'all';
process.env.CENTRAL_URL = 'http://central.example:4000/';
process.env.EDGE_TOKEN = 'shared-secret';
delete process.env.COLLECTOR_TOKEN;
delete process.env.CENTRAL_TOKEN;
delete process.env.DATA_SOURCE;
delete process.env.AGENT_PUSH_INVENTORY;
delete process.env.UPGRADE_ENABLED;
delete process.env.UPGRADE_AUTO_APPLY;
delete process.env.UPGRADE_REMOTE_BASE;
delete process.env.UPGRADE_POLL_INTERVAL_MS;
delete process.env.UPGRADE_INSTALL_DIR;

let config;
before(async () => { ({ config } = await import('../src/config.js')); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('EDGE_MODE=all: 수집기 export 토큰 = EDGE_TOKEN', () => {
  assert.equal(config.edgeAll, true);
  assert.equal(config.collector.token, 'shared-secret');
});

test('EDGE_MODE=all: 에이전트 워커용 centralToken = EDGE_TOKEN, centralUrl 정규화', () => {
  assert.equal(config.agent.centralToken, 'shared-secret');
  assert.equal(config.agent.centralUrl, 'http://central.example:4000');
});

test('EDGE_MODE=all: central.token은 켜지지 않음(엣지가 중앙이 되는 부작용 방지)', () => {
  assert.equal(config.central.token, '');
});

test('EDGE_MODE=all: live 수집 + 인벤토리 push 기본 on', () => {
  assert.equal(config.dataSource, 'live');
  assert.equal(config.agent.pushInventory, true);
});

test('EDGE_MODE=all: 중앙발 자동 업그레이드 기본 on (/dl 소스, 1시간 주기, installDir 자동)', () => {
  assert.equal(config.upgrade.enabled, true);
  assert.equal(config.upgrade.autoApply, true);
  assert.equal(config.upgrade.remoteBase, 'http://central.example:4000/dl');
  assert.equal(config.upgrade.pollIntervalMs, 3_600_000);
  assert.ok(config.upgrade.installDir.length > 0);
});
