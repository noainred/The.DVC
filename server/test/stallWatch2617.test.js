/**
 * v2.617 — 운영 중앙 멈춤(2026-09-26) 대응 회귀.
 *  ① perf/stallWatch.js: 메인 루프가 멈춘 **동안** stderr 로 보고하고 멈춘 지점의 JS 스택을 자동 채취한다
 *     (console 은 메인 경유라 멈춘 동안 한 줄도 못 나간다 — 그래서 fs.writeSync(2) 여야 한다).
 *  ② collector/puller.js: 엣지 pull 을 전부 동시에(Promise.all) 하지 않는다 — 동시 개수 제한.
 *  ③ /health·롤업이 비활성 vCenter 를 따로 센다(화면이 '연결 불가'·'첫 수집 중' 으로 세지 않게).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { stripComments } from './_stripComments.js';

const SRC = new URL('../src/', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, SRC), 'utf8');

test('① 멈춘 동안 stderr 에 멈춤·스택·해제를 적는다', () => {
  const mod = new URL('perf/stallWatch.js', SRC).href;
  const code = `
    import { startStallWatch, stallWatchStatus, _stopStallWatch } from '${mod}';
    startStallWatch({ stallMs: 800 });
    function blockedHere(ms) { const end = Date.now() + ms; let a = []; while (Date.now() < end) { a.push(ms); if (a.length > 1e5) a = []; } }
    setTimeout(() => {
      blockedHere(3500);
      setTimeout(async () => { process.stdout.write(JSON.stringify(stallWatchStatus())); await _stopStallWatch(); }, 1500);
    }, 1200);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /\[stallwatch\] 메인 이벤트 루프가 \d+초째 응답하지 않습니다/);
  assert.match(r.stderr, /\[stallwatch\] 멈춘 지점의 메인 JS 호출 스택/);
  assert.match(r.stderr, /\[stallwatch\]\s+blockedHere\s/, '멈춘 함수 이름이 스택에 있어야 한다');
  assert.match(r.stderr, /\[stallwatch\] 멈춤이 풀렸습니다 — 약 \d+초/);
  const st = JSON.parse(r.stdout);
  assert.equal(st.enabled, true);
  assert.equal(st.stalls, 1);
  assert.ok(st.last.frames.some((f) => f.startsWith('blockedHere')));
  assert.ok(st.last.durMs >= 2500, `durMs=${st.last.durMs}`);
});

test('① 멈추지 않으면 아무것도 적지 않는다 · STALL_WATCH=0 이면 끈다', () => {
  const mod = new URL('perf/stallWatch.js', SRC).href;
  const code = `import { startStallWatch, stallWatchStatus, _stopStallWatch } from '${mod}';
    const on = startStallWatch({ stallMs: 800 });
    setTimeout(async () => { process.stdout.write(JSON.stringify({ on, st: stallWatchStatus() })); await _stopStallWatch(); }, 2500);`;
  const ok = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(ok.status, 0, ok.stderr);
  assert.doesNotMatch(ok.stderr, /stallwatch/);
  assert.equal(JSON.parse(ok.stdout).st.stalls, 0);
  const off = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, STALL_WATCH: '0' } });
  assert.equal(JSON.parse(off.stdout).on, false);
});

test('① 기동이 감시를 켜고, 멈춤을 console 이 아니라 fd 2 로 직접 쓴다', () => {
  const idx = stripComments(read('index.js'));
  assert.match(idx, /startStallWatch\(\);/);
  const sw = read('perf/stallWatch.js');
  assert.match(sw, /fs\.writeSync\(2,/);
  assert.match(sw, /connectToMainThread\(\)/);
  assert.match(stripComments(read('health/services.js')), /wrap\('stallwatch'/);
});

test('② 엣지 pull 은 동시 개수를 제한한다', () => {
  const p = stripComments(read('collector/puller.js'));
  assert.doesNotMatch(p, /Promise\.all\(\s*collectors\.map/);
  assert.match(p, /poolRun\(collectors,\s*config\.collector\.pullConcurrency/);
  const c = stripComments(read('config.js'));
  assert.match(c, /pullConcurrency:\s*Math\.min\(16,\s*Math\.max\(1,/);
});

test('③ /health 와 전역 롤업이 비활성 vCenter 를 따로 센다', () => {
  assert.match(stripComments(read('routes/api/overviewNsx.js')), /vcentersDisabled:\s*byStatus\('disabled'\)/);
  assert.match(stripComments(read('store.js')), /vcentersDisabled:\s*snap\.vcenters\.filter\(\(v\) => v\.status === 'disabled'\)/);
});
