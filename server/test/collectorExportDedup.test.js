import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 격리된 CONFIG_DIR — 레지스트리/DB가 이 디렉터리를 쓴다.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'col-dedup-'));
process.env.CONFIG_DIR = tmp;

let agent, registry, dbMod, service, state;
before(async () => {
  registry = await import('../src/idrac/registry.js');
  dbMod = await import('../src/idrac/db.js');
  agent = await import('../src/collector/agent.js');
  service = await import('../src/idrac/service.js');
  state = await import('../src/collector/state.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

// 서버 1대가 여러 별칭(이름·서비스태그·hostNames)을 가질 때, export는 그 서버를 1행으로만 내보내야 한다.
// (과거 데드코드 dedup 버그: 별칭 수만큼 중복 export → 중앙 '전력 보고' 수 과다)
test('buildExport: 서버 1대 = 1행 (별칭 다수여도 중복 없음)', async () => {
  registry.importServers([{
    id: 'srv-aliased', name: 'LESHESXPWA50', host: '10.1.1.1', username: 'root', password: 'x',
    serviceTag: 'TAG50', hostNames: ['leshesxpwa50', 'leshesxpwa50.dc.local', '10.1.1.1'],
  }], 'replace');
  const m = await dbMod.getDb();
  m.insert('srv-aliased', 1900, Date.now());

  const exp = await agent.buildExport();
  const rows = exp.power.byHost.filter((h) => h.serverId === 'srv-aliased');
  assert.equal(rows.length, 1, '별칭이 여러 개여도 export는 서버당 1행');
  assert.equal(exp.hosts, exp.power.byHost.length);
});

// 중앙 안전망: 같은 수집기에서 동일 serverId가 여러 별칭으로 들어와도 allMeasuredPower는 1대로 집계.
test('allMeasuredPower: 원격 동일 서버 중복(별칭) → 1대', async () => {
  // 로컬 iDRAC 레지스트리를 비워 원격 경로만 격리 검증(이전 테스트의 등록 서버 영향 제거).
  registry.importServers([], 'replace');
  // 구버전 수집기가 같은 서버(serverId)를 3개 별칭 호스트로 보고한 상황을 모사.
  state.setRemoteHost('remote-srv-a', { watts: 1900, ts: Date.now(), collectorId: 'colA', serverName: 'REMOTE-SRV', serverId: 'srv-x' });
  state.setRemoteHost('remote-srv-a.dc.local', { watts: 1900, ts: Date.now(), collectorId: 'colA', serverName: 'REMOTE-SRV', serverId: 'srv-x' });
  state.setRemoteHost('10.9.9.9', { watts: 1900, ts: Date.now(), collectorId: 'colA', serverName: 'REMOTE-SRV', serverId: 'srv-x' });

  const measured = await service.allMeasuredPower();
  const remoteX = measured.filter((m) => m.source === 'remote' && m.serverName === 'REMOTE-SRV');
  assert.equal(remoteX.length, 1, '동일 출처 서버는 별칭 수와 무관하게 1대');
});
