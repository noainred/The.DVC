/**
 * v2.478 감사 후속 회귀 테스트(docs/AUDIT-2026-09-11.md).
 *  - S6: 엣지 로그 연합 조회 reqId 가 큐잉한 사용자에 묶인다(ownerOfReq/vcenterOfReq).
 *  - S7: 소유자 없는 원격접속 매핑은 admin 에게만 보이고, 비-admin 은 자기 소유만 본다.
 *  - B7: 네트워크 모니터 저장 시 useSudo 를 안 보내면 기존 값을 유지하고 redact 가 useSudo 를 내려준다.
 * CONFIG_DIR 을 임시 디렉터리로 돌려 저장소 server/config 를 오염시키지 않는다.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-audit2478-'));

let lq; let reg; let mon;
before(async () => {
  lq = await import('../src/central/logQueries.js');
  reg = await import('../src/proxy/registry.js');
  mon = await import('../src/net/monitor.js');
});

test('S6: reqId 는 큐잉 사용자·vCenter 에 묶인다(미지정 소유자는 빈 값)', () => {
  const id = lq.enqueueLogQuery('vc-a', { q: 'x' }, 'alice');
  assert.equal(lq.ownerOfReq(id), 'alice');
  assert.equal(lq.vcenterOfReq(id), 'vc-a');
  const anon = lq.enqueueLogQuery('vc-b', {});
  assert.equal(lq.ownerOfReq(anon), '');
  assert.equal(lq.ownerOfReq('lq_nope'), '');
});

test('S7: 소유자 없는 매핑은 admin 전용, 비-admin 은 자기 소유만', () => {
  const a = reg.addMapping({ name: 'own-bob', protocol: 'ssh', targetHost: '10.0.0.11', owner: 'bob' });
  const b = reg.addMapping({ name: 'ownerless', protocol: 'ssh', targetHost: '10.0.0.12' });
  const c = reg.addMapping({ name: 'own-carol', protocol: 'ssh', targetHost: '10.0.0.13', owner: 'carol' });
  assert.ok(a.ok && b.ok && c.ok, JSON.stringify([a, b, c]));
  const names = (u) => reg.listMappingsForUser(u).map((m) => m.name).sort();
  assert.deepEqual(names({ username: 'bob', role: 'operator' }), ['own-bob']);          // 소유자 없는 매핑 미노출
  assert.deepEqual(names({ username: 'carol', role: 'viewer' }), ['own-carol']);
  assert.deepEqual(names({ username: 'root', role: 'admin' }), ['own-bob', 'own-carol', 'ownerless']);
});

test('B7: useSudo 미전송 저장(토글)은 기존 값을 유지하고 redact 가 노출한다', () => {
  const m = mon.saveMonitor({ name: 'mon-a', hostA: { host: '10.0.0.5' }, peer: '10.0.0.6', useSudo: false });
  assert.equal(m.useSudo, false);
  const toggled = mon.saveMonitor({ id: m.id, enabled: false }); // 시작/중지 토글 — useSudo 없이 저장
  assert.equal(toggled.useSudo, false, '토글이 useSudo 를 true 로 되돌리면 안 된다(감사 B7)');
  assert.equal(mon.listMonitors().find((x) => x.id === m.id)?.useSudo, false);
  const on = mon.saveMonitor({ id: m.id, useSudo: true });
  assert.equal(on.useSudo, true);
});
