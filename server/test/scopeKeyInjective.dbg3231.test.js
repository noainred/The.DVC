/**
 * dbg3231 — 범위 서명 scopeKey 가 단사가 아니라 memoJson 캐시가 범위 계정 사이에 섞였다(재현).
 *   예전: `[...a].sort().join(',')` · 무제한은 'all'. 등록부(vcenter/registry.js normalize)는 id 에 쉼표도 'all' 도 허용한다 —
 *     scope ['KR,Seoul'] 과 ['KR','Seoul'] 이 같은 열쇠 · scope ['all'](id 가 'all' 인 vCenter) 과 무제한이 같은 열쇠였다.
 *   고침: 무제한 = SCOPE_KEY_ALL('*') · 범위 = 's:' + JSON(정렬 배열). 무제한 판정 비교도 이 표식으로(hostHygiene · clusterCheck).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scopeKey3231-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DATA_DIR: DIR });
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const S = await import('../src/routes/api/shared.js');
const { store } = await import('../src/store.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));

const snap = { generatedAt: '2026-11-18T00:00:00.000Z', vcenters: [{ id: 'KR,Seoul' }, { id: 'KR' }, { id: 'Seoul' }, { id: 'all' }, { id: 'US1' }, { id: '*' }] };
const u = (vcenters) => ({ username: 'x', role: 'viewer', scope: vcenters ? { vcenters } : null });

test('서로 다른 허용 집합은 서로 다른 범위 서명 — 쉼표 id · \'all\' id · \'*\' id 포함', () => {
  const keys = [
    S.scopeKey(u(null), snap),
    S.scopeKey(u(['KR,Seoul']), snap),
    S.scopeKey(u(['KR', 'Seoul']), snap),
    S.scopeKey(u(['all']), snap),
    S.scopeKey(u(['*']), snap),
    S.scopeKey(u(['US1']), snap),
  ];
  assert.equal(new Set(keys).size, keys.length, `충돌: ${JSON.stringify(keys)}`);
  assert.equal(S.scopeKey(u(null), snap), S.SCOPE_KEY_ALL);
  assert.notEqual(S.scopeKey(u(['all']), snap), S.SCOPE_KEY_ALL, "id 가 'all' 인 범위 계정은 무제한이 아니다");
  assert.notEqual(S.scopeKey(u(['*']), snap), S.SCOPE_KEY_ALL, "id 가 '*' 인 범위 계정도 무제한이 아니다");
  // 같은 집합은 순서와 무관하게 같은 서명(캐시가 쓸데없이 갈라지지 않게)
  assert.equal(S.scopeKey(u(['US1', 'KR']), snap), S.scopeKey(u(['KR', 'US1']), snap));
});

test('memoJson — scope [\'KR,Seoul\'] 이 먼저 채운 캐시를 scope [\'KR\',\'Seoul\'] 이 받지 않는다 · [\'all\'] 은 무제한 캐시를 받지 않는다', async () => {
  const prev = store.snapshot;
  store.snapshot = { ...(store.get() || {}), ...snap };
  try {
    const call = async (user) => {
      const req = { user, originalUrl: '/api/dbg3231/probe', headers: {}, get: () => undefined };
      let body = null;
      const res = { headersSent: false, set() { return this; }, setHeader() { return this; }, status() { return this; }, end() { return this; }, json(b) { body = b; return this; }, send(b) { body = typeof b === 'string' ? JSON.parse(b) : b; return this; } };
      await S.memoJson(req, res, 'dbg3231-probe', () => ({ who: S.scopeKey(user, snap) }), { extraKey: S.scopeKey(user, store.get()) });
      return body;
    };
    const a = await call(u(['KR,Seoul']));
    const b = await call(u(['KR', 'Seoul']));
    assert.ok(a && b, '응답 본문이 있어야 한다');
    assert.notDeepEqual(b, a, 'B 가 A(범위 밖 KR,Seoul) 의 캐시를 받았다');
    const all = await call(u(null));
    const fake = await call(u(['all']));
    assert.notDeepEqual(fake, all, "scope ['all'] 계정이 무제한 계정의 캐시를 받았다");
  } finally { store.snapshot = prev; }
});

test('무제한 판정을 \'all\' 글자로 비교하지 않는다(소스 스윕)', () => {
  const dir = path.join(HERE, '../src');
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && /scopeKey\([^)]*\)\s*[!=]==?\s*'all'/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(dir, p));
    }
  };
  walk(dir);
  assert.deepEqual(hits, []);
});
