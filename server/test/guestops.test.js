import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNvidiaSmiCsv } from '../src/gpu/guestops.js';

test('parseNvidiaSmiCsv: 단일 GPU 파싱', () => {
  const r = parseNvidiaSmiCsv('75, 40, 8192, 16384, Disabled');
  assert.equal(r.count, 1);
  assert.equal(r.utilPct, 75);
  assert.equal(r.gpus[0].memUsedMB, 8192);
  assert.equal(r.gpus[0].memTotalMB, 16384);
  assert.equal(r.memUsedPct, 50);
  assert.equal(r.gpus[0].mig, 'disabled');
});

test('parseNvidiaSmiCsv: 다중 GPU 평균 + MIG 카운트', () => {
  const r = parseNvidiaSmiCsv('80, 50, 4096, 8192, Enabled\n40, 10, 1024, 8192, Disabled');
  assert.equal(r.count, 2);
  assert.equal(r.utilPct, 60);            // (80+40)/2
  assert.equal(r.migEnabled, 1);
});

test('parseNvidiaSmiCsv: 헤더/빈 줄/비숫자 라인 무시', () => {
  const r = parseNvidiaSmiCsv('utilization.gpu, memory\n\n90, 30, 2048, 4096');
  assert.equal(r.count, 1);
  assert.equal(r.utilPct, 90);
});

test('parseNvidiaSmiCsv: 빈 입력 → null', () => {
  assert.equal(parseNvidiaSmiCsv(''), null);
  assert.equal(parseNvidiaSmiCsv('   '), null);
  assert.equal(parseNvidiaSmiCsv('not,a,number'), null);
});

test('parseNvidiaSmiCsv: MIG Enabled로 사용률 N/A여도 GPU 수집(유휴 0%)', () => {
  // MIG 모드면 nvidia-smi가 GPU 단위 사용률을 [N/A]로 보고 → GPU가 통째로 누락되던 버그.
  const r = parseNvidiaSmiCsv('[N/A], [N/A], 0, 81920, Enabled\n[N/A], [N/A], 0, 81920, Enabled');
  assert.equal(r.count, 2);        // 두 장 모두 인식(예전엔 0 → null 반환)
  assert.equal(r.utilPct, 0);      // 전부 N/A → 유휴 0%
  assert.equal(r.utilNA, true);    // N/A(MIG) 구분 플래그
  assert.equal(r.memUsedPct, 0);
  assert.equal(r.migEnabled, 2);
});

test('parseNvidiaSmiCsv: 일부만 N/A면 아는 값으로 평균', () => {
  const r = parseNvidiaSmiCsv('[N/A], [N/A], 0, 81920, Enabled\n50, 20, 4096, 81920, Disabled');
  assert.equal(r.count, 2);
  assert.equal(r.utilPct, 50);     // 아는 GPU(50)만 평균
  assert.equal(r.utilNA, false);
});

test('addGuestUser: 리눅스 비번의 개행 거부(chpasswd 형식 보호), 그 외 특수문자는 통과해 클라이언트 호출 단계까지 진행', async () => {
  const { addGuestUser } = await import('../src/gpu/guestops.js');
  await assert.rejects(
    () => addGuestUser(null, 'vm-1', {}, { username: 'user1', password: 'a\nb', isWindows: false }),
    /줄바꿈/);
  await assert.rejects(
    () => addGuestUser(null, 'vm-1', {}, { username: 'user1', password: 'a\rb', isWindows: false }),
    /줄바꿈/);
  // 특수문자 비번은 검증을 통과해 vCenter 클라이언트 호출까지 가야 한다(null 클라이언트라 TypeError).
  await assert.rejects(
    () => addGuestUser(null, 'vm-1', {}, { username: 'user1', password: 'p@ss,w0rd"\'\\:$# 한글', isWindows: false }),
    (e) => !/줄바꿈|형식|비밀번호/.test(e.message));
});

test('addGuestUser: Windows 비번은 배치에 안전하지 않은 문자("·%·개행)만 거부', async () => {
  const { addGuestUser } = await import('../src/gpu/guestops.js');
  for (const bad of ['a"b', 'a%b', 'a\r\nb']) {
    await assert.rejects(
      () => addGuestUser(null, 'vm-1', {}, { username: 'winuser', password: bad, isWindows: true }),
      /사용할 수 없는 문자/);
  }
  // 그 외 특수문자는 통과해 클라이언트 호출 단계까지 진행.
  await assert.rejects(
    () => addGuestUser(null, 'vm-1', {}, { username: 'winuser', password: "p@ss,w0rd'!$#&", isWindows: true }),
    (e) => !/사용할 수 없는 문자/.test(e.message));
});
