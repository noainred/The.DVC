/**
 * 대상(등록 노드) 이름 변경 회귀 방지 — 트리 컨텍스트 메뉴 '이름 변경'이 쓰는 경로.
 * PUT /svcmon/targets/:id 에 { name } 만 보내면 updateTarget 부분 업데이트로 이름만 바뀌고
 * 호스트·점검·경로·enabled 는 그대로 보존돼야 한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'svcmon-rename-'));
process.env.SVCMON_WORKERS = '0';

const store = await import('../src/svcmon/store.js');

test('대상 이름만 변경하면 호스트·점검·경로가 보존된다', () => {
  const t = store.addTarget({ kind: 'infra', path: 'RN', name: 'old-name', host: '10.9.0.1' });
  store.addTest(t.id, { name: 'ping', type: 'ping', intervalSec: 60 });
  const before = store.getTarget(t.id);
  assert.equal(before.tests.length, 1);

  const up = store.updateTarget(t.id, { name: 'new-name' });   // 이름만 부분 업데이트
  assert.equal(up.name, 'new-name', '이름 변경됨');
  assert.equal(up.host, '10.9.0.1', '호스트 보존');
  assert.equal(up.path, 'RN', '경로 보존');
  assert.equal(up.tests.length, 1, '점검 보존');
});

test('빈/공백 이름으로 업데이트하면 기존 이름을 유지한다(부분 업데이트 기본값 폴백)', () => {
  const t = store.addTarget({ kind: 'infra', path: 'RN', name: 'keep', host: '10.9.0.2' });
  const up = store.updateTarget(t.id, { name: '   ' });
  assert.equal(up.name, 'keep', '공백 이름은 무시되고 기존 이름을 유지(프론트도 빈 이름을 막는다)');
});
