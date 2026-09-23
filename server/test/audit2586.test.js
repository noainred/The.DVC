// v2.586 — 서버 결함 스윕 확정분 회귀(빈 칸 → 무제한/리셋 · 로그 키 프로토타입 오염 · Unity 버전 체인 · 표시 시각 TZ).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2586-'));
process.env.CONFIG_DIR = DIR;
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('F1 로그 보관 — 빈 칸·null 은 미지정(현재 값 유지), 명시적 0 만 무제한', async () => {
  const { saveLogSettings } = await import('../src/logs/settings.js');
  saveLogSettings({ retentionDays: 30, maxSizeMB: 2048 });
  let s = saveLogSettings({ retentionDays: '', maxSizeMB: '' });
  assert.equal(s.retentionDays, 30); assert.equal(s.maxSizeMB, 2048);
  s = saveLogSettings({ retentionDays: null, maxSizeMB: '  ' });
  assert.equal(s.retentionDays, 30); assert.equal(s.maxSizeMB, 2048);
  s = saveLogSettings({ enabled: true });
  assert.equal(s.retentionDays, 30);
  s = saveLogSettings({ retentionDays: 0 });
  assert.equal(s.retentionDays, 0, '명시적 0 은 여전히 무제한');
});

test('F5 일일 보고 — 칸을 비워도 발송 시각·임계가 바뀌지 않는다', async () => {
  const { saveDailyReportSettings } = await import('../src/reports/dailyReport.js');
  saveDailyReportSettings({ hour: 8, minute: 30, snapshotAgeDays: 7, dsWarnPct: 90 });
  let s = saveDailyReportSettings({ hour: '' });
  assert.equal(s.hour, 8);
  s = saveDailyReportSettings({ minute: '', snapshotAgeDays: '', dsWarnPct: null });
  assert.deepEqual([s.minute, s.snapshotAgeDays, s.dsWarnPct], [30, 7, 90]);
  s = saveDailyReportSettings({ hour: 0, minute: '0' });
  assert.deepEqual([s.hour, s.minute], [0, 0], '명시적 0 시는 유효');
});

test('F2 로그 분석 — [__proto__]·[constructor] 태그가 Object.prototype 을 오염시키지 않는다', async () => {
  const { newState, addItem, indexRules, mergeState, safeKey } = await import('../src/loganalysis/engine.js');
  const st = newState();
  const idx = indexRules([]);
  for (const msg of ['[__proto__] x', '[constructor] y', '[prototype] z', '[toString] w', '[toString] w2']) addItem(st, { msg, level: 'info' }, idx);
  assert.equal(({}).n, undefined);
  assert.equal(Object.n, undefined);
  assert.equal(st.tags[safeKey('__proto__')].n, 1);
  assert.equal(st.tags.tostring.n, 2); // 태그는 소문자화된다
  const a = newState();
  mergeState(a, JSON.parse('{"tags":{"__proto__":{"n":3}},"rules":{"constructor":{"n":1,"ent":{"__proto__":2}}}}'));
  assert.equal(({}).n, undefined);
  assert.equal(a.tags['(__proto__)'].n, 3);
  assert.equal(a.rules['(constructor)'].ent['(__proto__)'], 2);
});

test('F3 Unity 버전 — 모델만 읽은 후보에서 체인을 끝내지 않는다', async () => {
  const { SPECS } = await import('../src/storage/collectors/unitySsh.js');
  const v = SPECS.find((s) => s.key === 'version');
  const modelOnly = 'Product:          Unity 480F\nSystem State:     Normal\n';
  assert.equal(v.accept(modelOnly), false, '버전이 없으면 다음 uemcli 후보를 실행해야 한다');
});

test('F4 사람이 읽는 시각은 프로세스 TZ 가 아니라 포탈 시각', () => {
  // 08:30 KST = 전날 23:30 UTC. TZ=UTC 프로세스에서 제목·수집 줄이 KST 로 나와야 한다.
  const code = `
    const { renderSubject, renderReport } = await import(${JSON.stringify(path.join(SRC, 'dirusage/report.js'))});
    const ts = Date.UTC(2026, 8, 22, 23, 30);
    console.log(renderSubject('{date}', { ts }));
    const r = renderReport({ ts, root: '/x', agent: 'e', top: [], entries: [] });
    console.log(JSON.stringify(r).includes('2026-09-23 08:30'));`;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ: 'UTC' }, encoding: 'utf8' });
  const [subject, has] = out.stdout.trim().split('\n');
  assert.equal(subject, '2026-09-23', out.stderr);
  assert.equal(has, 'true', out.stderr);
});

test('F4 소스 스윕 — 표시·이름용 로컬 getter 사본을 되살리지 않는다', () => {
  for (const f of ['dirusage/report.js', 'vmclone/runner.js', 'insights/migrateScript.js']) {
    const s = fs.readFileSync(path.join(SRC, f), 'utf8');
    assert.doesNotMatch(s, /getHours\(\)|getFullYear\(\)|toLocaleString\('ko-KR'\)/, f);
  }
});
