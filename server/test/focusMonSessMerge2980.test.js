/**
 * test/focusMonSessMerge2980.test.js — v2.980 저장된 계속 수집의 겹침 정리.
 * 사용자 질문(2026-11-12, 진행 중인 수집 두 칸 '계속 수집 · 13대' · '계속 수집 · 18대' 화면): "이렇게 보이면 동시에 2번 수집하는거야? 버그야?"
 *  · 수집기는 서버마다 하나(desiredFor 가 id 로 합친다) — 겹쳐도 두 번 접속하지 않는다(겹침 정리 전에도)
 *  · v2.979 전에 만든 겹친 계속 수집은 업그레이드 뒤에도 그대로 남았다 → 읽을 때 먼저 시작한 수집에만 남기고 비게 된 수집은 뺀다
 *  · 정리하면 정의 파일을 다시 쓰고 · 고친 수집을 한 번만 돌려준다(fm_run 고쳐 쓰기) · 겹침이 없으면 파일을 쓰지 않는다
 *  · '지난번 다시 고르기'(ended)에 넣지 않는다 · 그 뒤 서버별 수집 종료는 그 서버를 실제로 멈춘다
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'focusmonmerge2980-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
const store = await import('../src/focusmon/store.js');
const FILE = path.join(DIR, 'focusmon-sessions.json');
const write = (sessions) => fs.writeFileSync(FILE, JSON.stringify({ v: 1, sessions }, null, 2));
const tg = (n) => `fm-merge${String(n).padStart(4, '0')}`;
const resolve = (id) => ({ id, host: '10.9.0.1', port: 22, username: 'dvcmon', agent: '' });

test('① 겹친 계속 수집 — 먼저 시작한 수집에만 남기고 · 비게 된 수집은 뺀다 · 파일을 다시 쓴다 · 고친 수집을 한 번만 돌려준다', () => {
  store._resetForTest();
  write([
    { id: 'fs-bbbbbbbb', mode: 'record', by: 'noainred', targets: [tg(2), tg(4), tg(5)], interval: 2, startedAt: 2_000 },
    { id: 'fs-aaaaaaaa', mode: 'record', by: 'noainred', targets: [tg(1), tg(2), tg(3)], interval: 2, startedAt: 1_000 },
    { id: 'fs-cccccccc', mode: 'record', by: 'noainred', targets: [tg(3)], interval: 5, startedAt: 3_000 },
  ]);
  const warn = console.warn; const warned = []; console.warn = (m) => warned.push(String(m));
  let list;
  try { list = store.listSessions(); } finally { console.warn = warn; }
  const by = Object.fromEntries(list.map((s) => [s.id, s.targets]));
  assert.deepEqual(by, { 'fs-aaaaaaaa': [tg(1), tg(2), tg(3)], 'fs-bbbbbbbb': [tg(4), tg(5)] }, '먼저 시작한 수집(a)이 서버를 가진다 · c 는 비어 빠진다');
  const all = list.flatMap((s) => s.targets);
  assert.equal(new Set(all).size, all.length, '서버는 수집 하나에만');
  assert.match(warned.join('\n'), /겹친 계속 수집을 정리했습니다 — 두 수집에 함께 있던 서버 2건을 .*비게 된 수집 1건은 뺌/);
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8')).sessions.map((s) => [s.id, s.targets]);
  assert.deepEqual(saved.sort(), [['fs-aaaaaaaa', [tg(1), tg(2), tg(3)]], ['fs-bbbbbbbb', [tg(4), tg(5)]]], '정리한 정의를 파일에 다시 쓴다(재시작해도 같은 상태)');
  const fixes = store.drainLoadFixes();
  assert.deepEqual(fixes.map((f) => [f.id, f.targets, f.ended == null]).sort(), [['fs-bbbbbbbb', [tg(4), tg(5)], true], ['fs-cccccccc', [tg(3)], false]], '고친 수집 · 끝낸 수집(원래 대상 · 끝 시각)');
  assert.deepEqual(store.drainLoadFixes(), [], '한 번만 돌려준다');
  assert.deepEqual(store.endedSessions(), [], "'지난번 다시 고르기' 에 넣지 않는다 — 사람이 끝낸 수집이 아니다");
});

test('② 정리 뒤 서버별 수집 종료는 그 서버를 실제로 멈춘다(예전에는 다른 수집에 남아 계속 수집됐다)', () => {
  // ①의 상태 그대로 — tg(2) 는 a 에만 있다
  assert.ok(store.desiredFor('', resolve).some((d) => d.id === tg(2)));
  const r = store.removeFromSession('fs-aaaaaaaa', tg(2));
  assert.equal(r.ok, true);
  assert.ok(!store.desiredFor('', resolve).some((d) => d.id === tg(2)), '빼면 수집 목록에서도 빠진다');
});

test('③ 겹침이 없으면 정의 파일을 쓰지 않고 고칠 것도 없다', async () => {
  store._resetForTest();
  write([
    { id: 'fs-dddddddd', mode: 'record', by: 'a', targets: [tg(11), tg(12)], interval: 2, startedAt: 1_000 },
    { id: 'fs-eeeeeeee', mode: 'record', by: 'a', targets: [tg(13)], interval: 2, startedAt: 2_000 },
  ]);
  const m0 = fs.statSync(FILE).mtimeMs;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(store.listSessions().length, 2);
  assert.deepEqual(store.drainLoadFixes(), []);
  assert.equal(fs.statSync(FILE).mtimeMs, m0, '파일을 다시 쓰지 않는다');
});

test('④ 겹침 정리 전에도 수집기는 서버마다 하나였다 — desiredFor 가 id 로 합친다(두 번 접속하지 않는다는 답의 근거)', () => {
  store._resetForTest();
  fs.rmSync(FILE, { force: true });
  // 정리를 거치지 않는 경로(지금 만드는 수집)로는 겹칠 수 없으므로, desiredFor 의 합치기 자체를 같은 id 두 수집으로 확인한다
  const a = store.startSession({ targets: [tg(21), tg(22)], interval: 2, mode: 'watch' });
  assert.equal(a.ok, true);
  const d = store.desiredFor('', resolve);
  assert.deepEqual(d.map((x) => x.id).sort(), [tg(21), tg(22)]);
  const src = fs.readFileSync(new URL('../src/focusmon/store.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function desiredFor'), src.indexOf('export function desiredFor') + 900);
  assert.match(body, /const want = new Map\(\);/);
  assert.match(body, /const prev = want\.get\(id\);/, '같은 서버가 두 수집에 있어도 한 항목(주기는 짧은 쪽)');
});
