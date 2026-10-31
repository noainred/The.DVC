/**
 * test/osKind2834.test.js — v2.834 Bareos 백업 대상 OS 구분(inventory/osKind.js).
 * vCenter guestFullName 문자열 → windows · linux · other · null(모름). 빈 값·'unknown'(soapClient 가 넣는 글자)은 모름 — 기타로 세지 않는다.
 * 라우트 계약(목록·후보에 os·guestOS)은 bareosRoutes ④·⑤ 가 본다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { osKind, osFields } from '../src/inventory/osKind.js';

test('vCenter 게스트 OS 이름 → 분류', () => {
  const cases = [
    ['Microsoft Windows Server 2019 (64-bit)', 'windows'], ['Microsoft Windows 10 (64-bit)', 'windows'],
    ['Red Hat Enterprise Linux 9 (64-bit)', 'linux'], ['CentOS 7 (64-bit)', 'linux'], ['Ubuntu Linux (64-bit)', 'linux'],
    ['SUSE Linux Enterprise 15 (64-bit)', 'linux'], ['Debian GNU/Linux 12 (64-bit)', 'linux'], ['Rocky Linux (64-bit)', 'linux'],
    ['AlmaLinux (64-bit)', 'linux'], ['VMware Photon OS (64-bit)', 'linux'], ['Other 4.x or later Linux (64-bit)', 'linux'],
    ['Oracle Linux 8 (64-bit)', 'linux'], ['FreeBSD 13 (64-bit)', 'other'], ['Oracle Solaris 11 (64-bit)', 'other'], ['VMware ESXi 8.0 or later', 'other'],
    ['unknown', null], ['UNKNOWN', null], ['', null], ['   ', null], [null, null], [undefined, null], [42, null],
  ];
  for (const [s, want] of cases) assert.equal(osKind(s), want, JSON.stringify(s));
});

test('응답 칸 — 모르면 원문도 null · 원문은 200자', () => {
  assert.deepEqual(osFields(undefined), { os: null, guestOS: null });
  assert.deepEqual(osFields({ guestOS: 'unknown' }), { os: null, guestOS: null });
  assert.deepEqual(osFields({ guestOS: ' Ubuntu Linux (64-bit) ' }), { os: 'linux', guestOS: 'Ubuntu Linux (64-bit)' });
  assert.equal(osFields({ guestOS: `Windows ${'x'.repeat(500)}` }).guestOS.length, 200);
});

test('긴 입력도 선형(정규식 전에 길이를 자른다)', () => {
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) osKind('a'.repeat(100_000));
  assert.ok(performance.now() - t0 < 1000);
});
