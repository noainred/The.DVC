/**
 * storageDuplicate2522.test.js — v2.522 회귀 고정.
 *
 * 2026-09-16 사용자 신고: "장비를 등록하려고 하는데, 표에는 없는데, 등록하려고 하면 있는
 * 장비라고 나온다." 중복 판정은 **등록부 전체**(host+type)인데 화면은 법인·타입 칩으로
 * 걸러져 있어 충돌 장비가 시야 밖이었고, 오류는 어느 장비인지 말해 주지 않았다.
 *
 * 고정하는 것:
 *  1) 식별 키는 **host+type 그대로**다(사용자 결정 "규칙은 그대로, 안내만 고친다").
 *     CSV 가져오기 멱등성 키와 같아서 바꾸면 내보내기→가져오기 왕복이 장비를 중복 생성한다.
 *  2) 중복 오류는 **충돌 장비를 지목**한다(표시명·법인·수집주체·활성/배포 여부).
 *  3) 그 정보에 **비밀번호가 없다**(400 응답 본문으로 화면까지 나간다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { duplicateIssue, duplicateMessage, conflictInfo } from '../src/storage/duplicate.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const DEVS = [
  { id: 'st-a', name: 'HD-PS-1', host: '10.228.123.28', type: 'powerstore', datacenterId: 'HD', agent: 'HD', enabled: true, password: 'SECRET-PW' },
  { id: 'st-b', name: 'MIL-ISI-1', host: '10.228.123.28', type: 'isilon', datacenterId: 'MIL', agent: 'MIL', enabled: true, password: 'SECRET-PW' },
  { id: 'st-c', name: '이름없는집', host: '10.1.1.1', type: 'unity', datacenterId: '', agent: '', enabled: false, pulled: true },
];

test('duplicateIssue: 같은 host+type 이면 법인이 달라도 중복 — 그리고 그 장비를 지목한다', () => {
  const r = duplicateIssue(DEVS, { host: '10.228.123.28', type: 'powerstore' });
  assert.ok(r, '중복인데 통과시켰다');
  assert.equal(r.conflict.id, 'st-a');
  assert.equal(r.conflict.name, 'HD-PS-1');
  assert.equal(r.conflict.datacenterId, 'HD');   // ← 사용자가 MIL 로 걸러 놓아 안 보이던 그 정보
  assert.match(r.message, /HD-PS-1/);
  assert.match(r.message, /필터/, '어디를 봐야 하는지(필터)까지 말해야 한다');
});

test('duplicateIssue: type 이 다르면 중복이 아니다(같은 host 라도)', () => {
  // 같은 어레이 관리 IP 에 서로 다른 제품이 올 수는 없지만, 키 정의가 host 단독으로
  // 좁아지면 이 케이스가 막힌다 — 키가 host+type 임을 고정한다.
  assert.equal(duplicateIssue(DEVS, { host: '10.228.123.28', type: 'unity' }), null);
  assert.equal(duplicateIssue(DEVS, { host: '10.9.9.9', type: 'powerstore' }), null);
});

test('duplicateIssue: host·type 이 비면 판정하지 않는다(입력 검증이 먼저 잡는다)', () => {
  assert.equal(duplicateIssue(DEVS, { host: '', type: 'powerstore' }), null);
  assert.equal(duplicateIssue(DEVS, { host: '10.228.123.28', type: '' }), null);
  assert.equal(duplicateIssue([], { host: '10.228.123.28', type: 'powerstore' }), null);
});

test('conflictInfo: 비밀번호를 절대 싣지 않는다(400 응답 본문으로 나간다)', () => {
  const c = conflictInfo(DEVS[0]);
  assert.equal(c.password, undefined);
  assert.equal(JSON.stringify(c).includes('SECRET-PW'), false, '직렬화 어디에도 비밀번호가 있으면 안 된다');
  // 노출 필드는 listDevices() 와 같은 등급만.
  assert.deepEqual(Object.keys(c).sort(), ['agent', 'datacenterId', 'enabled', 'host', 'id', 'name', 'pulled', 'type']);
});

test('duplicateMessage: 법인 미지정·중앙 수집·비활성도 사실대로 말한다', () => {
  const m = duplicateMessage(conflictInfo(DEVS[2]));
  assert.match(m, /법인 미지정/);
  assert.match(m, /수집 중앙/);   // agent 가 비면 '중앙 직접'
  assert.match(m, /비활성/);      // enabled:false 를 숨기면 '왜 안 보이지' 가 된다
});

test('식별 키를 바꾸지 않았다 — CSV 멱등성 키와 같은 host+type', () => {
  const csv = readFileSync(join(SRC, 'storage/csv.js'), 'utf8');
  assert.match(csv, /keyOf:\s*\(row\)\s*=>\s*`\$\{row\.host\}\|\$\{row\.type\}`/,
    'CSV 가져오기 키가 바뀌면 내보내기→가져오기 왕복이 장비를 중복 생성한다');
  const reg = readFileSync(join(SRC, 'storage/registry.js'), 'utf8');
  assert.match(reg, /duplicateIssue\(db\.devices, \{ host, type \}\)/);
});

test('저장 라우트가 conflict 를 응답에 싣는다', () => {
  const route = readFileSync(join(SRC, 'routes/api/storageMon.js'), 'utf8');
  assert.match(route, /conflict:\s*e\.conflict/,
    'conflict 를 빼면 화면이 다시 "어느 장비인지 모르는" 상태로 돌아간다');
});
