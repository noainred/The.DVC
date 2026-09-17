/**
 * unityCapacity2540.test.js — Unity 용량 산정을 위한 수집 필드 고정(v2.540).
 *
 * 사용자 요청(2026-09-17): uemcli 화면 3장을 주며 "이 화면 참고해서 용량 산정 하는 기능 만들어줘".
 * 산정에 필요한 필드(선할당·구독·임계·RAID·드라이브)와, 새로 추가한 **시스템 레벨 용량 교차검증**을
 * 실제 출력으로 고정한다. 픽스처는 실장비 캡처의 **형식만** 옮기고 식별자는 합성이다(v2.513 규약) —
 * 단 **용량 수치와 괄호 표기는 보존**한다(이 수치가 계약이다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'unitycap2540-'));
const fx = (n) => fs.readFileSync(path.join(HERE, 'fixtures', n), 'utf8');

const { normalizeUnitySsh } = await import('../src/storage/collectors/unitySsh.js');
const DEV = { id: 'u1', name: 'OC2-41.237', type: 'unity', host: '10.0.0.1' };

test('★ 풀 상세에서 선할당·구독·임계·RAID·드라이브를 전부 읽는다(용량 산정 입력)', () => {
  const snap = normalizeUnitySsh(DEV, { pools: fx('uemcli-pool-detail.txt') });
  assert.equal(snap.sections.pools, 'ok', JSON.stringify(snap.sections));
  const p = snap.pools[0];
  assert.equal(p.name, 'pool_1');
  assert.equal(p.totalBytes, 117544396521472, '전체 용량(106.9T)');
  // 사용량은 `Current allocation` 이다(v2.526 규약) — `Subscription`(50.4T)이 아니다.
  assert.equal(p.usedBytes, 29973242855424, '사용량은 Current allocation(27.2T)');
  assert.notEqual(p.usedBytes, p.subscribedBytes, '구독을 사용량으로 쓰면 씬 프로비저닝에서 거짓이 된다');
  assert.equal(p.freeBytes, 87568746020864, '잔여(79.6T)');
  assert.equal(p.subscribedBytes, 55491782770688, '구독(50.4T)');
  // v2.540 신규 — 항등식 검사에 쓴다(할당 + 잔여 + 선할당 = 전체)
  assert.equal(p.preallocatedBytes, 2407645184, '선할당(2.2G) — 이게 없으면 항등식이 어긋나 산정이 거부된다');
  assert.equal(p.alertThresholdPct, 70, '경고 임계 70%');
  assert.equal(p.raid, '5');
  assert.equal(p.stripeLength, 9);
  assert.equal(p.drives, '38 x 3.8T SAS Flash 4');
  assert.equal(snap.extra.preallocatedBytes, p.preallocatedBytes, '합계도 extra 에 실린다');
  assert.equal(snap.extra.subscribedBytes, p.subscribedBytes);
});

test('★ 항등식: 할당 + 잔여 + 선할당 = 전체 (실측 오차 0)', () => {
  const snap = normalizeUnitySsh(DEV, { pools: fx('uemcli-pool-detail.txt') });
  const p = snap.pools[0];
  const diff = p.totalBytes - (p.usedBytes + p.freeBytes + p.preallocatedBytes);
  assert.ok(Math.abs(diff) <= 1024 ** 3, `항등식이 ${diff} 바이트 어긋난다 — 필드를 잘못 읽었다`);
});

test('★ 시스템 레벨 용량(/stor/general/system show)을 읽되 **풀 합계를 덮어쓰지 않는다**', () => {
  const snap = normalizeUnitySsh(DEV, {
    pools: fx('uemcli-pool-detail.txt'),
    sysCapacity: fx('uemcli-system-capacity.txt'),
  });
  const sc = snap.extra.systemCapacity;
  assert.ok(sc, '시스템 용량을 읽지 못했다');
  assert.equal(sc.totalBytes, 117544396521472);
  assert.equal(sc.usedBytes, 29973250195456);
  assert.equal(sc.freeBytes, 87568746020864);
  assert.equal(sc.preallocatedBytes, 2400305152);
  assert.equal(sc.dataReductionRatio, '1.00:1');
  // 용량의 진실은 여전히 풀 합계다 — 이 값으로 덮어쓰면 풀별 내역(임계·RAID)이 사라져 산정이 불가능해진다.
  assert.equal(snap.capacity.totalBytes, snap.pools.reduce((a, p) => a + p.totalBytes, 0));
  // 둘이 같으므로 교차검증 경고는 없다
  assert.equal(snap.extra.capacityCrossCheck, undefined);
});

test('★ 시스템 용량과 풀 합계가 어긋나면 **밝힌다**(조용히 한쪽만 쓰지 않는다)', () => {
  const bogus = fx('uemcli-system-capacity.txt').replace('117544396521472 (106.9T)', '200000000000000 (181.9T)');
  const snap = normalizeUnitySsh(DEV, { pools: fx('uemcli-pool-detail.txt'), sysCapacity: bogus });
  assert.match(snap.extra.capacityCrossCheck || '', /다릅니다/);
  assert.match(snap.extra.capacityCrossCheck || '', /풀 합계/);
});

test('시스템 용량 명령이 실패해도 풀 기반 수집은 그대로 된다(선택 항목)', () => {
  const snap = normalizeUnitySsh(DEV, { pools: fx('uemcli-pool-detail.txt') });
  assert.equal(snap.sections.capacity, 'ok');
  assert.equal(snap.extra.systemCapacity, undefined);
});

test('SPECS 에 /stor/general/system show 가 등록돼 있다(후보 체인 포함)', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'src', 'storage', 'collectors', 'unitySsh.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(src, /key: 'sysCapacity'/);
  assert.match(src, /uemcli \/stor\/general\/system show/);
  // 매 주기 항목이어야 한다(구성 전용으로 두면 6시간마다만 갱신돼 교차검증이 낡는다)
  assert.match(src, /key: 'sysCapacity', when: 'always'/);
});
