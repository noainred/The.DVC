/**
 * v3.17.4 — 2차 공통 기능 점검 3회차: 권한 거부(403) 안내의 권한 이름 표가 서버 카탈로그와 같다.
 *
 * 예전: web/src/components/accessDeniedText.js PERM_LABEL 이 서버 키 20개 중 6개만 알았고 서버에 없는 키 7개를 들고 있었다 —
 *   가장 흔한 403(`requirePerm('inv.vms')` 등)이 '필요: inv.vms 권한' 처럼 원문 키로 보였다. 웹은 서버 소스를 import 할 수 없어
 *   (번들 경계) 두 벌이고, 이 테스트가 같은 키 · 같은 이름인지 대조한다(서버에 권한을 더하면 여기서 먼저 깨진다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSION_CATALOG } from '../src/auth/permissions.js';

test('웹 PERM_LABEL = 서버 PERMISSION_CATALOG(키 · 이름)', async () => {
  const { PERM_LABEL, permName } = await import('../../web/src/components/accessDeniedText.js');
  const server = Object.fromEntries(PERMISSION_CATALOG.map((p) => [p.key, p.label]));
  assert.deepEqual(PERM_LABEL, server);
  for (const p of PERMISSION_CATALOG) assert.notEqual(permName(p.key), p.key, `${p.key} 가 원문 키로 보인다`);
});
