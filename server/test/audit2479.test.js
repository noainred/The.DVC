/**
 * v2.479 감사 후속 회귀 테스트(docs/AUDIT-2026-09-11b.md).
 *  - S-1/S-2: PDU·베어메탈 스토리지 서버의 host 가 바뀌면 저장 비밀번호를 이월하지 않는다(uagmon M3 규칙).
 *  - 코어 B-1: 알림 메일 채널이 저장→로드 왕복에서 살아남는다(예전엔 세 단계 모두 탈락).
 *  - 코어 B-2: config.secretsReady 가 export 되고 resolve 된다(첫 수집 대기 계약).
 * CONFIG_DIR 을 임시 디렉터리로 돌려 저장소 server/config 를 오염시키지 않는다.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-audit2479-'));

let pdu; let bm; let alerts; let cfg;
before(async () => {
  pdu = await import('../src/pdu/registry.js');
  bm = await import('../src/bmstor/registry.js');
  alerts = await import('../src/alerts.js');
  cfg = await import('../src/config.js');
});

test('S-1: PDU host 변경 + 비밀번호 미입력 → 비밀번호 이월 금지', () => {
  const r = pdu.saveDevice({ name: 'PDU-A', host: '10.40.0.10', username: 'apc', password: 'pdu-pw-1', datacenterId: 'KR' });
  assert.ok(r.ok, JSON.stringify(r));
  const same = pdu.saveDevice({ id: r.device.id, name: 'PDU-A', host: '10.40.0.10', username: 'apc', password: '', datacenterId: 'KR' });
  assert.ok(same.ok); assert.equal(pdu.getDeviceWithSecret(r.device.id).password, 'pdu-pw-1', 'host 불변 편집은 기존 비밀번호 유지');
  const moved = pdu.saveDevice({ id: r.device.id, name: 'PDU-A', host: '10.40.0.99', username: 'apc', password: '', datacenterId: 'KR' });
  assert.ok(moved.ok, JSON.stringify(moved));
  assert.equal(pdu.getDeviceWithSecret(r.device.id).password, '', 'host 변경 시 비밀번호가 새 host 로 이월되면 안 된다(감사 S-1)');
});

test('S-2: 베어메탈 서버 host 변경 + 비밀번호 미입력 → 비밀번호 이월 금지', () => {
  const r = bm.saveBmServer({ name: 'BM-1', host: '10.41.0.10', username: 'root', password: 'bm-pw-1', mounts: ['/data'] });
  assert.ok(r.ok, JSON.stringify(r));
  const moved = bm.saveBmServer({ id: r.server.id, name: 'BM-1', host: '10.41.0.77', username: 'root', password: '', mounts: ['/data'] });
  assert.ok(moved.ok, JSON.stringify(moved));
  assert.equal(bm.listBmServersRaw().find((s) => s.id === r.server.id).password, '', '감사 S-2');
  const kept = bm.saveBmServer({ id: r.server.id, name: 'BM-1', host: '10.41.0.77', username: 'root', password: 'bm-pw-2', mounts: ['/data'] });
  assert.ok(kept.ok);
  const again = bm.saveBmServer({ id: r.server.id, name: 'BM-1 renamed', host: '10.41.0.77', username: 'root', password: '********', mounts: ['/data'] });
  assert.ok(again.ok);
  assert.equal(bm.listBmServersRaw().find((s) => s.id === r.server.id).password, 'bm-pw-2', 'host 불변이면 마스킹 값은 기존 유지');
});

test('코어 B-1: 알림 메일 채널이 저장·로드에서 유지된다', () => {
  const saved = alerts.saveAlertConfig({ channels: { email: { enabled: true } } });
  assert.equal(saved.channels.email?.enabled, true, '저장 결과에 email 이 있어야 웹 체크박스가 풀리지 않는다');
  assert.equal(alerts.loadAlertConfig().channels.email?.enabled, true);
  const files = fs.readdirSync(process.env.CONFIG_DIR).filter((f) => f.endsWith('.json'));
  const onDisk = files.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(process.env.CONFIG_DIR, f), 'utf8')); } catch { return null; } })
    .find((j) => j && j.channels && j.rules);
  assert.ok(onDisk, '알림 설정 파일이 저장되어야 한다');
  assert.equal(onDisk.channels.email?.enabled, true, '파일에도 email 채널이 기록되어야 한다');
});

test('코어 B-2: config.secretsReady 계약', async () => {
  assert.ok(cfg.secretsReady && typeof cfg.secretsReady.then === 'function');
  await cfg.secretsReady; // resolve(복호 모듈 로드) 또는 catch 로 흡수 — reject 하지 않는다
});
