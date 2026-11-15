/**
 * sanFullAudit24.test.js — 전체 점검 24회차(SAN 스위치) 확정분.
 *  #1 대량 테스트의 저장 비밀번호는 sanAccessMoved 가 같을 때만 · #2 대량 가져오기가 버린 비밀번호를 밝힘
 *  #3 수정 · 대소문자 다른 신규도 host 중복 거절(메모리 불변) · #4 설정 손상 중 정리 보류 · PUT · 정리 409 · GET loadError
 *  #5 저장 실패 시 메모리 불변 · #7 사용률 못 읽음 0% 금지 · #8 flow 목록 정규식 선형 · #9 빈 글자 0 금지 · #11 parseCounter NaN
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sanfa24-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_DIR = tmp;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(HERE, '../src');
const rd = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

test('#3 · #5 — 수정 · 대소문자만 다른 신규의 host 중복 거절 · 거절 뒤 메모리 불변', async () => {
  const R = await import('../src/sanswitch/registry.js');
  const a = R.saveDevice({ type: 'brocade', name: 'A', host: 'san-a.example', username: 'admin', password: 'pw' });
  const b = R.saveDevice({ type: 'brocade', name: 'B', host: '10.72.9.2', username: 'admin', password: 'pw' });
  assert.throws(() => R.saveDevice({ id: b.id, type: 'brocade', name: 'B', host: 'san-a.example', username: 'admin' }), /같은 host/);
  assert.throws(() => R.saveDevice({ type: 'brocade', name: 'C', host: 'SAN-A.example', username: 'admin', password: 'pw' }), /같은 host/);
  assert.equal(R.listDevices().find((d) => d.id === b.id).host, '10.72.9.2', '거절이 메모리를 바꾸지 않는다');
  assert.equal(R.listDevices().length, 2);
  void a;
  const src = rd('sanswitch/registry.js');
  assert.match(src, /const next = existing \? db\.devices\.map\(\(d\) => \(d === existing \? dev : d\)\) : \[\.\.\.db\.devices, dev\];\n  persist\(next\);\n  db\.devices = next;/);
});

test('#5 — 저장이 실패하면(키 없음) 메모리 · 이 노드 수집 대상이 바뀌지 않는다', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sanfa24b-'));
  try {
    fs.writeFileSync(path.join(d, 'secrets-policy.json'), JSON.stringify({ mode: 'encrypted', level: 2 }));
    const REG = JSON.stringify(path.join(SRC, 'sanswitch/registry.js'));
    const run = (code, env) => { const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CONFIG_DIR: d, DATA_DIR: d, ...env }, encoding: 'utf8' }); return JSON.parse(r.stdout.trim().split('\n').pop()); };
    const env0 = { ...process.env }; delete env0.SECRETS_KEY;
    run(`const R = await import(${REG}); const x = R.saveDevice({ type: 'brocade', name: 'A', host: '10.9.9.1', username: 'admin', password: 'pw' }); console.log(JSON.stringify({ id: x.id }));`, { SECRETS_KEY: 'k'.repeat(32) });
    const out = (() => { const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const R = await import(${REG}); const id = R.listDevices()[0].id; let e1 = null, e2 = null;
      try { R.saveDevice({ id, type: 'brocade', name: 'A', host: '10.9.9.77', username: 'root', password: 'NEW-PW' }); } catch (e) { e1 = e.code || e.message; }
      try { R.saveDevice({ type: 'brocade', name: 'N', host: '10.9.9.2', username: 'admin', password: 'pw2' }); } catch (e) { e2 = e.code || e.message; }
      console.log(JSON.stringify({ e1, e2, hosts: R.listDevices().map((x) => x.host) }));`], { env: { ...env0, CONFIG_DIR: d, DATA_DIR: d }, encoding: 'utf8' }); return JSON.parse(r.stdout.trim().split('\n').pop()); })();
    assert.ok(out.e1 && out.e2, '키 없음 → 저장 실패(전제)');
    assert.deepEqual(out.hosts, ['10.9.9.1'], '메모리는 그대로(수정 전: 10.9.9.77 · 10.9.9.2)');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('#4 — 포트 사용량 설정 손상: 정리 보류(held) · PUT · 정리 409 · GET loadError', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sanfa24c-'));
  try {
    fs.writeFileSync(path.join(d, 'sanswitch-perf-settings.json'), '{ broken');
    const code = `const db = await import(${JSON.stringify(path.join(SRC, 'sanswitch/perfDb.js'))});
      const r = await db.pruneNow(3650); console.log(JSON.stringify(r));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CONFIG_DIR: d, DATA_DIR: d }, encoding: 'utf8' });
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    if (!out.unavailable) assert.equal(out.held, true, `손상 중 정리 보류(수정 전: 집계 24행 삭제) ${JSON.stringify(out)}`);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
  const src = rd('routes/api/sanSwitch.js');
  assert.equal((src.match(/if \(perfSettingsLoadError\(\)\) return res\.status\(409\)/g) || []).length, 2, 'PUT · 정리');
  assert.match(src, /loadError: \{ reason: String\(le\.reason \|\| ''\)\.slice\(0, 200\) \}/);
});

test('#1 · #2 · #7 · #9 — 대량 테스트 승계 판정 · 버린 비밀번호 보고 · 0% 막대 · 빈 글자 수', () => {
  const src = rd('routes/api/sanSwitch.js');
  assert.match(src, /if \(sanAccessMoved\(full, input\)\) return \{ ok: false/);
  assert.match(src, /\.\.\.\(droppedSecrets\.length \? \{ droppedSecrets \} : \{\}\)/);
  const web = fs.readFileSync(path.join(HERE, '../../web/src/views/tools/SanSwitchTool.jsx'), 'utf8');
  assert.doesNotMatch(web, /UsageCell pct=\{[^}]*\?\? 0\}/, '못 읽은 사용률을 0 으로 그리지 않는다');
  assert.match(rd('routes/central/pduSanRoutes.js'), /numOrNull\(v\) \?\? NaN/);
});

test('#8 · #11 — flow 목록 정규식 선형 · parseCounter 못 읽음은 null', async () => {
  const { parseFlowList } = await import('../src/sanswitch/flowCmd.js');
  const bad = `${' '.repeat(16_000)}!`; const ok = `${'x'.repeat(16_000)}!`;
  const t = (s) => { const t0 = performance.now(); for (let i = 0; i < 3; i++) parseFlowList(s); return performance.now() - t0; };
  t(ok); const base = t(ok); const ms = t(bad);
  assert.ok(ms < Math.max(base * 20, 20), `공백 줄 ${ms.toFixed(1)}ms · 기준 ${base.toFixed(1)}ms`);
  assert.deepEqual(parseFlowList('| myflow | x |').names, ['myflow']);
  const { parseCounter } = await import('../src/sanswitch/collectors/fosParse.js');
  assert.equal(parseCounter('.'), null); assert.equal(parseCounter('1.2.3'), null); assert.equal(parseCounter('1.2m'), 1_200_000);
});
