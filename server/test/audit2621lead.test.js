/*
 * v2.621 리드 통합분 회귀 — 그룹 수정(A~F) 밖에서 리드가 고친 것.
 *
 *   SEC-02 후속: gpu/sshCollect.js usableIp 가 정규식 + 접두 비교라 '000.0.0.0'(→ 루프백)·'010.0.0.5'(8진수 해석)가
 *     통과했다. 이제 정규형 IPv4(strictIpv4Num) + 차단 대역(ipBlockReason) + 루프백 상시 제외.
 *   WEB-05 후속: 위임 iDRAC 스캔 결과 정제(sanitizeIdracScanData)가 미지원 행의 noCreds 를 버렸다 — '계정 없어 시도 안 함' 이
 *     중앙에서 '통과' 로 보였다.
 *   그룹 A 관찰 → 리드 확인: runGuestScript 가 stdout 을 앞 2000자로 잘라 로그인 실패 조사(tail 80줄)의 **최신 줄**을
 *     조용히 버렸다. outMax 옵션 + stdoutTruncated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');

test('SEC-02 후속 · usableIp 는 정규형 IPv4 만, 루프백·링크로컬·미지정은 거부', async () => {
  const { usableIp, guestIps } = await import('../src/gpu/sshCollect.js');
  for (const ok of ['10.0.0.5', '192.168.1.1', '172.16.0.9']) assert.equal(usableIp(ok), true, ok);
  for (const bad of ['000.0.0.0', '010.0.0.5', '0127.0.0.1', '127.0.0.1', '169.254.169.254', '0.0.0.0', ' 10.0.0.5', '10.0.0.5 ',
    '10.0.0.256', '10.1', 'fe80::1', '::1', 'localhost', '', null, undefined, 1234]) {
    assert.equal(usableIp(bad), false, String(bad));
  }
  // 고정 IP 가 비정규면 쓰지 않는다(그 VM 이 보고한 IP 로 떨어진다 — 예전과 같은 폴백).
  assert.deepEqual(guestIps({ ipAddress: '10.0.0.9' }, '000.0.0.0'), ['10.0.0.9']);
  assert.deepEqual(guestIps({ ipAddresses: ['000.0.0.0', '10.2.3.4', 'fe80::1'] }), ['10.2.3.4']);
});

test('SEC-02 후속 · 루프백은 SSRF_ALLOW_LOOPBACK 과 무관하게 뺀다(게스트 IP 로 루프백은 뜻이 없다)', async () => {
  const prev = process.env.SSRF_ALLOW_LOOPBACK;
  process.env.SSRF_ALLOW_LOOPBACK = 'true';
  try {
    const { usableIp } = await import('../src/gpu/sshCollect.js');
    assert.equal(usableIp('127.0.0.1'), false);
    assert.equal(usableIp('127.8.8.8'), false);
  } finally {
    if (prev === undefined) delete process.env.SSRF_ALLOW_LOOPBACK; else process.env.SSRF_ALLOW_LOOPBACK = prev;
  }
});

test('WEB-05 후속 · 위임 스캔 결과 정제는 미지원 행의 noCreds 를 보존한다(참만 참)', async () => {
  const { sanitizeIdracScanData } = await import('../src/central/idracScanJobs.js');
  const o = sanitizeIdracScanData({
    unsupported: [
      { ip: '192.0.2.10', vendor: 'lenovo', noCreds: true },
      { ip: '192.0.2.11', vendor: 'lenovo', noCreds: 'true' },
      { ip: '192.0.2.12', vendor: 'lenovo' },
    ],
  });
  assert.equal(o.unsupported[0].noCreds, true);
  assert.equal(o.unsupported[1].noCreds, false, "문자열 'true' 를 참으로 지어내지 않는다");
  assert.equal('noCreds' in o.unsupported[2], false, '없던 필드를 만들지 않는다');
});

test('그룹 A 관찰 → 리드 확인 · 로그인 실패 조사는 출력 상한을 넓히고 잘리면 밝힌다', async () => {
  const g = stripComments(src('gpu/guestops.js'));
  assert.match(g, /outMax = 2000/, '기본값은 예전 그대로(다른 호출부 동작 불변)');
  assert.match(g, /stdoutTruncated: rawOut\.length > cap/);
  assert.doesNotMatch(g, /stdout: \(out\.text \|\| ''\)\.trim\(\)\.slice\(0, 2000\)/, '고정 2000자 절단이 돌아오면 안 된다');
  const { LOGIN_SCAN_OUT_MAX } = await import('../src/security/guestLoginScan.js');
  // tail 80줄 × 저널 한 줄 약 150자 = 12KB — 상한이 그보다 작으면 최신 실패가 다시 잘린다.
  assert.ok(LOGIN_SCAN_OUT_MAX >= 80 * 150, `상한 ${LOGIN_SCAN_OUT_MAX}`);
  const l = stripComments(src('security/guestLoginScan.js'));
  assert.match(l, /outMax: LOGIN_SCAN_OUT_MAX/);
  assert.match(l, /stdoutTruncated/, '잘렸으면 밝힌다');
});
