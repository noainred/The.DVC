// v2.447 감사 수정 회귀 고정 — 보안 5 · 버그 5 · 개선/튜닝 중 순수 판정 부분.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { toolKeyForPath, TOOL_PATH_KEYS } from '../src/auth/toolAccess.js';
import { morefOf } from '../src/vcenter/registry.js';
import { resolveInstaller } from '../src/agent/deploy.js';
import { snapMemo, snapCacheClear, snapCacheStats, weakEtag } from '../src/util/snapCache.js';

// ── S2: 도구별 접근 서버 집행 ────────────────────────────────────────────────
test('S2: 경로 → 도구 키 매핑(확장자·하위경로 포함), 매핑 없는 경로는 검사 대상 아님', () => {
  assert.equal(toolKeyForPath('/ipam'), 'ipam');
  assert.equal(toolKeyForPath('/ipam.csv'), 'ipam');
  assert.equal(toolKeyForPath('/ipam.xlsx?q=1'), 'ipam');
  assert.equal(toolKeyForPath('/ipam/settings'), 'ipam');
  assert.equal(toolKeyForPath('/rightsize'), 'rightsizing', '경로와 도구 키 이름이 다른 케이스');
  assert.equal(toolKeyForPath('/storage'), 'storage-mon');
  assert.equal(toolKeyForPath('/deep-search'), 'deepsearch');
  // 매핑에 없는 경로는 null — 잘못된 매핑으로 정상 사용자를 막지 않는다(가용성 우선).
  assert.equal(toolKeyForPath('/ip-ping'), null);
  assert.equal(toolKeyForPath('/vclogs'), null);
  assert.equal(toolKeyForPath(''), null);
});

test('S2: 매핑된 도구 키는 전부 프론트 목록(specialToolsList)에 실재해야 한다', () => {
  const src = fs.readFileSync(new URL('../../web/src/views/specialToolsList.js', import.meta.url), 'utf8');
  const known = new Set([...src.matchAll(/k: '([a-z0-9-]+)'/g)].map((m) => m[1]));
  for (const [route, key] of Object.entries(TOOL_PATH_KEYS)) {
    assert.ok(known.has(key), `도구 키 '${key}'(경로 /${route})가 프론트 목록에 없다 — 오차단 위험`);
  }
});

// ── B1: moref 추출(콜론 포함 vcenterId) ─────────────────────────────────────
test('B1: morefOf 는 vcenterId 에 콜론이 있어도 MoRef 를 정확히 잘라낸다', () => {
  assert.equal(morefOf('vc-kr:vm-123', 'vc-kr'), 'vm-123');
  assert.equal(morefOf('apac:vc01:vm-123', 'apac:vc01'), 'vm-123', 'split(:) 이면 vc01:vm-123 이 됐다');
  assert.equal(morefOf('vc-kr:network-7', 'vc-kr'), 'network-7');
  // vcenterId 를 모르면 첫 콜론 뒤 전체(최선 추정) — 기존 동작과 동일
  assert.equal(morefOf('vc-kr:vm-1', ''), 'vm-1');
  // 프리픽스가 맞지 않으면(다른 vc 의 id) 최선 추정으로 폴백
  assert.equal(morefOf('vc-kr:vm-1', 'vc-us'), 'vm-1');
  assert.equal(morefOf('', 'vc'), '');
});

test('B1: split(\':\') 기반 moref 추출이 코드에 남아 있지 않다(회귀 방지)', () => {
  const root = new URL('../src/', import.meta.url);
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        // 주석 줄(설명·금지 사유)은 제외하고 **실제 코드**만 본다 — registry.js 의 morefOf 주석이
        // 이 패턴을 인용하고 있어 그대로 검사하면 항상 실패한다.
        const code = fs.readFileSync(p, 'utf8').split('\n')
          .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
        if (/split\(':'\)\.slice\(1\)/.test(code)) hits.push(e.name);
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, [], `split(':').slice(1) 로 moref 를 자르는 파일이 남아 있다: ${hits.join(', ')}`);
});

// ── S1: 설치 패키지 경로 제한 ───────────────────────────────────────────────
test('S1: resolveInstaller 는 허용 디렉터리 밖·규격 외 파일명을 거부한다', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-'));
  const secret = path.join(tmp, 'portal.env');
  fs.writeFileSync(secret, 'AUTH_SECRET=hunter2');
  assert.equal(resolveInstaller(secret), null, '임의 파일은 거부해야 한다(SFTP 유출 경로)');
  const fake = path.join(tmp, 'vmware-portal-offline-9.9.9-el9-x64.tar.gz');
  fs.writeFileSync(fake, 'x');
  assert.equal(resolveInstaller(fake), null, '파일명이 맞아도 허용 디렉터리 밖이면 거부');
  assert.equal(resolveInstaller('/etc/shadow'), null);
  assert.equal(resolveInstaller(path.join(tmp, 'none.tar.gz')), null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── T6/B14: snapMemo LRU + undefined 값 처리 ────────────────────────────────
test('T6: 서로 다른 key 가 같은 이름 안에서 공존한다(사용자·필터별 캐시 히트)', async () => {
  snapCacheClear();
  let calls = 0;
  const compute = () => { calls++; return Promise.resolve(calls); };
  const a1 = await snapMemo('t', 'kr', 60_000, compute);
  const b1 = await snapMemo('t', 'pl', 60_000, compute);
  const a2 = await snapMemo('t', 'kr', 60_000, compute);   // 예전에는 pl 이 kr 을 축출해 재계산했다
  const b2 = await snapMemo('t', 'pl', 60_000, compute);
  assert.equal(calls, 2, `계산은 key 당 1회여야 한다(실제 ${calls}회)`);
  assert.equal(a1, a2); assert.equal(b1, b2);
  assert.deepEqual(snapCacheStats().find((x) => x.name === 't'), { name: 't', keys: 2 });
});

test('B14: compute() 가 undefined 를 돌려줘도 캐시가 동작한다', async () => {
  snapCacheClear();
  let calls = 0;
  const compute = () => { calls++; return Promise.resolve(undefined); };
  await snapMemo('u', 'k', 60_000, compute);
  await snapMemo('u', 'k', 60_000, compute);
  assert.equal(calls, 1, 'undefined 를 센티널로 쓰면 매번 재계산됐다');
});

test('T6: 이름당 보관 수는 상한을 넘지 않는다(LRU 축출)', async () => {
  snapCacheClear();
  for (let i = 0; i < 40; i++) await snapMemo('lru', `k${i}`, 60_000, () => Promise.resolve(i));
  const st = snapCacheStats().find((x) => x.name === 'lru');
  assert.ok(st.keys <= 12, `상한 12 이내여야 한다(실제 ${st.keys})`);
  assert.ok(st.keys >= 2);
});

test('T6: weakEtag/sendCached 는 그대로 동작한다(ETag/304 회귀 방지)', () => {
  assert.equal(weakEtag('a|b'), weakEtag('a|b'));
  assert.notEqual(weakEtag('a|b'), weakEtag('a|c'));
  assert.match(weakEtag('x'), /^W\/"/);
});
