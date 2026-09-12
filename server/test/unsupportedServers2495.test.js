// v2.495 — 미지원(비-Dell) 서버 중앙 보관소 회귀 고정.
// 핵심: (1) 그룹 키 단위 교체(성공 스캔만 저장하는 것은 호출부 책임), (2) 상한 200 + truncated 정직 표기,
// (3) 법인 필터, (4) 자격증명·임의 필드가 저장되지 않는다, (5) 재시작 후에도 남는다(파일 영속).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unsup-'));
process.env.CONFIG_DIR = tmp;
const M = await import('../src/central/unsupportedServers.js');

const hpe = (ip) => ({ ip, vendor: 'hpe', vendorLabel: 'HPE', evidence: 'oem:Hpe', product: 'ProLiant DL380', authFailed: true, password: 'MUST-NOT-PERSIST', extra: 'x' });

test('저장·조회 — 그룹 키(agent·법인·서비스)로 교체되고 귀속이 붙는다', () => {
  M._resetUnsupportedForTest();
  M.saveUnsupportedServers({ agent: 'edge-az', datacenterId: 'AZ', service: 'MI', trigger: 'periodic' }, [hpe('10.0.0.5'), hpe('10.0.0.2')]);
  let r = M.listUnsupportedServers();
  assert.equal(r.total, 2);
  assert.deepEqual(r.rows.map((x) => x.ip), ['10.0.0.2', '10.0.0.5']); // 같은 시각이면 IP 숫자순
  assert.equal(r.rows[0].source, 'edge'); assert.equal(r.rows[0].agent, 'edge-az'); assert.equal(r.rows[0].datacenterId, 'AZ');
  // 같은 키로 다시 저장하면 교체(누적 아님)
  M.saveUnsupportedServers({ agent: 'edge-az', datacenterId: 'AZ', service: 'MI' }, [hpe('10.0.0.9')]);
  r = M.listUnsupportedServers();
  assert.deepEqual(r.rows.map((x) => x.ip), ['10.0.0.9']);
  // 다른 키(중앙 직접 스캔 = agent '')는 별도 보관
  M.saveUnsupportedServers({ agent: '', datacenterId: 'HQ', service: '' }, [hpe('192.168.1.1')]);
  r = M.listUnsupportedServers();
  assert.equal(r.total, 2);
  assert.equal(r.rows.find((x) => x.ip === '192.168.1.1').source, 'central');
});

test('자격증명·임의 필드는 저장되지 않는다(IP·벤더·제품·근거만)', () => {
  const r = M.listUnsupportedServers();
  for (const row of r.rows) { assert.equal(row.password, undefined); assert.equal(row.extra, undefined); }
  const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'central-unsupported-servers.json'), 'utf8'));
  assert.ok(!JSON.stringify(raw).includes('MUST-NOT-PERSIST'));
});

test('법인 필터', () => {
  assert.deepEqual(M.listUnsupportedServers({ datacenterId: 'AZ' }).rows.map((x) => x.ip), ['10.0.0.9']);
  assert.equal(M.listUnsupportedServers({ datacenterId: 'NOPE' }).total, 0);
});

test('상한 200 — 넘치면 잘라 저장하고 truncated 로 정직하게 표기', () => {
  const many = Array.from({ length: 250 }, (_, i) => hpe(`10.9.${Math.floor(i / 250)}.${i}`));
  const s = M.saveUnsupportedServers({ agent: 'edge-big', datacenterId: 'BIG', service: 'S' }, many, { count: 250 });
  assert.equal(s.saved, 200);
  const r = M.listUnsupportedServers({ datacenterId: 'BIG' });
  assert.equal(r.total, 200);
  assert.equal(r.groups[0].count, 250);
  assert.equal(r.groups[0].truncated, true);
  assert.equal(r.truncatedGroups, 1);
});

test('빈 IP·비정상 항목은 버리고, 파일 영속 후 재로드해도 남는다', () => {
  M.saveUnsupportedServers({ agent: 'e2', datacenterId: 'X', service: '' }, [{ ip: '' }, null, { ip: ' 10.1.1.1 ' }]);
  assert.deepEqual(M.listUnsupportedServers({ datacenterId: 'X' }).rows.map((x) => x.ip), ['10.1.1.1']);
  M._resetUnsupportedForTest(); // 메모리 비우고 파일에서 다시 읽는다
  assert.deepEqual(M.listUnsupportedServers({ datacenterId: 'X' }).rows.map((x) => x.ip), ['10.1.1.1']);
});
