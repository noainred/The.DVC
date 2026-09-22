/**
 * v2.580 — 아키텍처 2차 점검의 회귀 고정.
 *
 *  BUG-A  DB 모듈이 첫 호출 동시성에서 같은 파일을 **두 번** 열었다(재현: 동시 2호출 → fd 2개).
 *         `_db` 검사와 `await import('node:sqlite')` 사이의 틈이다. 진행 중 open 을 공유해야 한다
 *         (`bmusage/db.js` v2.550 패턴). 단일 파일 모듈은 `_opening`, 파일별(Map) 모듈은 `opening` Map.
 *  BUG-B  `ping/store.js` 가 손상 파일을 조용히 빈 값으로 읽어 다음 save() 가 대상 전부를 덮어썼다
 *         (v2.447 alarm-mutes B4 와 같은 유형). 원본을 `.corrupt.<ts>` 로 보존해야 한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const read = (f) => stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));

test('BUG-A 소스 — node:sqlite 를 지연 로드해 모듈 핸들을 만드는 모듈은 진행 중 open 을 공유한다', () => {
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } })(ROOT);
  const bad = [];
  for (const f of files) {
    const s = read(path.relative(ROOT, f));
    if (!/await import\('node:sqlite'\)/.test(s)) continue;
    // 모듈이 핸들을 **보관**하는 경우만 대상(임시로 열고 닫는 진단 경로는 제외)
    const keeps = /\b(_db|x|open|sqliteMod)\s*=\s*/.test(s) && /new\s+(mod\.)?DatabaseSync\(/.test(s);
    if (!keeps) continue;
    const shares = /_opening\s*=|ready\s*=\s*\(async|opening\.set\(|opening\.has\(/.test(s);
    if (!shares) bad.push(path.relative(ROOT, f));
  }
  assert.deepEqual(bad, [], `진행 중 open 을 공유하지 않는 DB 모듈:\n${bad.join('\n')}`);
});

test('BUG-A 실행 — storage/db.js 를 동시에 두 경로가 열어도 파일 핸들은 하나다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch2580-'));
  process.env.CONFIG_DIR = dir;
  const m = await import('../src/storage/db.js');
  await Promise.all([m.capacityResets(), m.dailySpans()]);
  const fds = fs.readdirSync('/proc/self/fd').map((d) => { try { return fs.readlinkSync(`/proc/self/fd/${d}`); } catch { return ''; } })
    .filter((p) => p.startsWith(dir) && p.endsWith('.db'));
  assert.equal(fds.length, 1, `같은 DB 파일 핸들이 ${fds.length}개 — 동시 첫 호출이 두 번 열었다`);
});

test('BUG-B — ping 대상 파일이 손상되면 원본을 보존하고 경고한다(조용한 빈 값 금지)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch2580-ping-'));
  process.env.CONFIG_DIR = dir;
  const { config } = await import('../src/config.js');
  config.configDir = dir;
  const file = path.join(dir, 'ping-targets.json');
  fs.writeFileSync(file, '{"targets":[{"id":"a","host":"10.0.0.1"}', 'utf8'); // 잘린 JSON
  const warns = []; const orig = console.warn; console.warn = (...a) => warns.push(a.join(' '));
  try {
    const st = await import('../src/ping/store.js');
    const list = typeof st.listTargets === 'function' ? st.listTargets() : (typeof st.loadTargets === 'function' ? st.loadTargets() : null);
    assert.ok(list == null || Array.isArray(list));
  } finally { console.warn = orig; }
  const kept = fs.readdirSync(dir).filter((n) => /ping-targets\.json\.corrupt\./.test(n));
  assert.equal(kept.length, 1, '손상본이 .corrupt.<ts> 로 보존돼야 한다');
  assert.ok(!fs.existsSync(file), '원본 자리는 비워져 재저장이 손상본을 덮어쓰지 않는다');
  assert.ok(warns.some((w) => /손상/.test(w)), '경고를 남겨야 한다');
});

test('TUNE-B — IPAM rows/시트 캐시는 현재 스냅샷 세대만 남긴다(지난 세대 항목이 32개까지 쌓이지 않는다)', async () => {
  const m = await import('../src/ipam/ledger.js');
  const snapOf = (gen) => ({ generatedAt: `2026-09-22T00:${String(gen).padStart(2, '0')}:00.000Z`, vms: [{ id: `vm${gen}`, name: `vm${gen}`, vcenterId: 'vc1', ips: [`10.0.0.${gen}`], guestOS: 'CentOS 7 (64-bit)' }], hosts: [], vcenters: [{ id: 'vc1', name: 'VC1' }] });
  // 매 폴링처럼 세대를 바꿔 가며 20번 부른다(스코프는 2가지) — 예전에는 rows 캐시가 20개까지 자랐다.
  for (let g = 1; g <= 20; g++) {
    const snap = snapOf(g);
    m.buildIpamRows(snap, '', null);
    m.buildIpamRows(snap, 'vc1', null);
    m.buildSubnetSheets(snap, { vcenterId: '', onlyBase: '' });
  }
  const st = m._ledgerCacheStats();
  assert.equal(st.rowsGenerations, 1, `rows 캐시에 세대가 하나만 남아야 한다: ${JSON.stringify(st)}`);
  assert.equal(st.rows, 2, `같은 세대의 scope 2개는 남는다: ${JSON.stringify(st)}`);
  assert.equal(st.sheetsGenerations, 1, `시트 캐시도 현재 세대만: ${JSON.stringify(st)}`);
  // 같은 세대 재호출은 캐시 히트(같은 객체)
  const snap = snapOf(20);
  assert.equal(m.buildIpamRows(snap, '', null), m.buildIpamRows(snap, '', null));
});

test('TUNE-C — snapMemo 는 현재 스냅샷 세대만 남긴다(폴링 사용자 1명이 32세대 응답을 상주시키지 않는다)', async () => {
  const m = await import('../src/util/snapCache.js');
  for (let g = 1; g <= 40; g++) {
    await m.snapMemo('t2580', `gen${g}|/api/x|all`, 60_000, async () => ({ g, big: new Array(10).fill(g) }));
    await m.snapMemo('t2580', `gen${g}|/api/x|vc1`, 60_000, async () => ({ g, scope: 'vc1' }));
  }
  const st = m._snapCacheStats('t2580');
  assert.equal(st.generations, 1, JSON.stringify(st));
  assert.equal(st.entries, 2, JSON.stringify(st));
  // 같은 세대의 다른 scope 는 히트(재계산 없음)
  let calls = 0;
  await m.snapMemo('t2580', 'gen40|/api/x|vc1', 60_000, async () => { calls++; return {}; });
  assert.equal(calls, 0);
  // 진행 중 계산은 세대가 바뀌어도 버리지 않는다(합류 중인 요청 보호)
  let resolve; const p = m.snapMemo('t2580', 'gen41|/api/y|all', 60_000, () => new Promise((r) => { resolve = r; }));
  await m.snapMemo('t2580', 'gen42|/api/x|all', 60_000, async () => ({}));
  assert.ok(m._snapCacheStats('t2580').entries >= 2, '진행 중 항목이 남아 있어야 한다');
  resolve({ ok: 1 }); assert.deepEqual(await p, { ok: 1 });
});
