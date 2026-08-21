// 베어메탈 스토리지(v2.340) 단위테스트 — df 파서·마운트 검증(명령 주입 방어)·서버/그룹/전체 합산.
// 사용자 요구를 고정한다: 지정 마운트들의 총/사용/가용 종합, 그룹 설정 시 그룹 합산 표시.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeMounts, parseDfOutput, MOUNT_RE } from '../src/bmstor/collect.js';
import { aggregate, normalizeBmGroups, groupsOf } from '../src/bmstor/agg.js';

test('sanitizeMounts: 절대경로+안전문자만 허용 — 셸 메타문자는 명령 주입 방어로 거부', () => {
  const { mounts, errors } = sanitizeMounts('/\n/data, /var/log; /mnt/backup-01');
  assert.deepEqual(mounts, ['/', '/data', '/var/log', '/mnt/backup-01']);
  assert.equal(errors.length, 0);
  for (const bad of ['data', '/tmp; rm -rf /', '/a b', '/a"b', '/a$(x)', '/a|b']) {
    assert.ok(sanitizeMounts(bad).errors.length, `거부돼야 함: ${bad}`);
    assert.ok(!MOUNT_RE.test(bad));
  }
  assert.deepEqual(sanitizeMounts('/, /').mounts, ['/'], '중복 제거');
});

const DF = [
  'Filesystem     1024-blocks      Used Available Capacity Mounted on',
  '/dev/sda1        102400000  51200000  51200000      50% /',
  '/dev/sdb1        204800000 153600000  51200000      75% /data',
  'tmpfs              1024000         0   1024000       0% /dev/shm',
].join('\n');

test('parseDfOutput: 요청 마운트만 골라 KB→바이트 환산, 없는 마운트는 missing', () => {
  const { mounts, missing } = parseDfOutput(DF, ['/', '/data', '/backup']);
  assert.equal(mounts.length, 2);
  assert.deepEqual(missing, ['/backup']);
  const root = mounts.find((m) => m.mount === '/');
  assert.equal(root.totalBytes, 102400000 * 1024);
  assert.equal(root.usedBytes, 51200000 * 1024);
  assert.equal(root.availBytes, 51200000 * 1024);
  assert.equal(root.usedPct, 50);
  assert.equal(mounts.find((m) => m.mount === '/data').usedPct, 75);
});

test('parseDfOutput: 빈/깨진 출력 방어', () => {
  assert.deepEqual(parseDfOutput('', ['/']).mounts, []);
  assert.deepEqual(parseDfOutput('garbage\nnot df', ['/']).missing, ['/']);
});

const SERVERS = [
  { id: 'a', name: 'srv-a', host: '10.0.0.1', group: 'G1', mounts: ['/', '/data'], enabled: true },
  { id: 'b', name: 'srv-b', host: '10.0.0.2', group: 'G1', mounts: ['/'], enabled: true },
  { id: 'c', name: 'srv-c', host: '10.0.0.3', group: '', mounts: ['/'], enabled: true },
  { id: 'd', name: 'srv-d', host: '10.0.0.4', group: 'G1', mounts: ['/'], enabled: false }, // 비활성 — 합계 제외
];
const GB = 1024 ** 3;
const LATEST = new Map([
  ['a', { ok: true, at: 1, mounts: [
    { mount: '/', totalBytes: 100 * GB, usedBytes: 40 * GB, availBytes: 60 * GB },
    { mount: '/data', totalBytes: 200 * GB, usedBytes: 100 * GB, availBytes: 100 * GB }] }],
  ['b', { ok: true, at: 1, mounts: [{ mount: '/', totalBytes: 100 * GB, usedBytes: 90 * GB, availBytes: 10 * GB }] }],
  ['c', { ok: false, at: 1, mounts: [], error: 'SSH 접속 실패' }],
]);

test('aggregate: 서버=자기 마운트 합, 그룹=그룹 서버 합, 전체=정상 서버 합(오류·비활성 제외)', () => {
  const { total, groups, perServer } = aggregate(SERVERS, LATEST);
  const a = perServer.find((s) => s.id === 'a');
  assert.equal(a.totalBytes, 300 * GB);        // / 100 + /data 200
  assert.equal(a.usedBytes, 140 * GB);
  assert.equal(a.usedPct, 46.7);
  // 그룹 G1 = a + b (d 는 비활성 제외)
  const g1 = groups.find((g) => g.name === 'G1');
  assert.equal(g1.servers, 2);
  assert.equal(g1.totalBytes, 400 * GB);
  assert.equal(g1.usedBytes, 230 * GB);
  assert.equal(g1.availBytes, 170 * GB);
  // 전체 = a + b (c 오류 제외 — errors 로 집계)
  assert.equal(total.servers, 3);
  assert.equal(total.ok, 2);
  assert.equal(total.errors, 1);
  assert.equal(total.totalBytes, 400 * GB);
  assert.equal(total.availBytes, 170 * GB);
  // 오류 서버는 사유가 그대로 노출(축소 보고 금지)
  assert.equal(perServer.find((s) => s.id === 'c').error, 'SSH 접속 실패');
});

test('normalizeBmGroups(v2.344): 문자열 분리·중복 제거·최대 3개, 구형 group 하위호환', () => {
  assert.deepEqual(normalizeBmGroups('A, B; C').groups, ['A', 'B', 'C']);
  assert.deepEqual(normalizeBmGroups(['A', 'a', ' A ']).groups, ['A'], '대소문자 무시 중복 제거');
  assert.match(normalizeBmGroups('a,b,c,d').error, /최대 3개/);
  assert.deepEqual(normalizeBmGroups('').groups, []);
  assert.deepEqual(groupsOf({ groups: ['X'] }), ['X']);
  assert.deepEqual(groupsOf({ group: 'legacy' }), ['legacy'], 'v2.340 단일 group 저장분 호환');
  assert.deepEqual(groupsOf({}), []);
});

test('aggregate(v2.344 멀티 그룹): 서버가 속한 모든 그룹에 합산, 전체 KPI 는 서버당 1회', () => {
  const servers = [
    { id: 'a', name: 'a', host: 'h1', groups: ['G1', 'G2'], mounts: ['/'], enabled: true },
    { id: 'b', name: 'b', host: 'h2', groups: ['G2'], mounts: ['/'], enabled: true },
  ];
  const latest = new Map([
    ['a', { ok: true, at: 1, mounts: [{ mount: '/', totalBytes: 100 * GB, usedBytes: 50 * GB, availBytes: 50 * GB }] }],
    ['b', { ok: true, at: 1, mounts: [{ mount: '/', totalBytes: 100 * GB, usedBytes: 10 * GB, availBytes: 90 * GB }] }],
  ]);
  const { total, groups, perServer } = aggregate(servers, latest);
  assert.equal(total.totalBytes, 200 * GB, '전체는 서버당 1회(중복 합산 없음)');
  const g1 = groups.find((g) => g.name === 'G1');
  const g2 = groups.find((g) => g.name === 'G2');
  assert.equal(g1.servers, 1);
  assert.equal(g1.totalBytes, 100 * GB);
  assert.equal(g2.servers, 2, 'a 는 G1·G2 양쪽에 집계');
  assert.equal(g2.totalBytes, 200 * GB);
  assert.deepEqual(perServer.find((s) => s.id === 'a').groups, ['G1', 'G2']);
});

test('aggregate: 미수집(latest 없음)은 pending, 빈 입력 안전', () => {
  const { total } = aggregate(SERVERS, new Map());
  assert.equal(total.pending, 3);
  assert.equal(total.totalBytes, 0);
  assert.deepEqual(aggregate([], new Map()).groups, []);
});
