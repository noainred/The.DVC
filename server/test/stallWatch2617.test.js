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

test('④ 큰 본문 동시 해석 상한 — 넘으면 본문을 읽지 않고 503 + Retry-After, 끝나면 슬롯을 돌려준다', async () => {
  const { bigJsonGate, bigJsonStats } = await import('../src/util/bigJsonGate.js');
  const { EventEmitter } = await import('node:events');
  let parsed = 0;
  const parser = (_q, _s, next) => { parsed++; next(); };
  const gate = bigJsonGate(parser, { central: () => true }, { maxConcurrent: 2, maxBytes: 10 * 1_048_576 });
  const mkReq = (len) => ({ baseUrl: '/api/central/inventory', path: '/', get: (h) => (h === 'content-length' ? String(len) : '') });
  const mkRes = () => { const r = new EventEmitter(); r.headers = {}; r.set = (k, v) => { r.headers[k] = v; return r; }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  const a = mkRes(); gate(mkReq(1_048_576), a, () => {});
  const b = mkRes(); gate(mkReq(1_048_576), b, () => {});
  const c = mkRes(); gate(mkReq(1_048_576), c, () => {});            // 개수 초과
  assert.equal(parsed, 2); assert.equal(c.code, 503); assert.equal(c.headers['Retry-After'], '5');
  a.emit('finish'); a.emit('close');                                  // 두 번 와도 한 번만 반환
  const d = mkRes(); gate(mkReq(20 * 1_048_576), d, () => {});       // 바이트 초과(진행 중 1건 있음)
  assert.equal(d.code, 503);
  b.emit('close');
  const e = mkRes(); gate(mkReq(20 * 1_048_576), e, () => {});       // 진행 중 0건이면 한도보다 커도 받는다
  assert.equal(parsed, 3); assert.equal(e.code, undefined);
  e.emit('close');
  const st = bigJsonStats();
  assert.equal(st.inflight, 0); assert.equal(st.bytes, 0); assert.ok(st.rejected >= 2);
});

test('⑤ 스냅샷이 바뀌면 모든 이름의 옛 세대 응답 캐시를 버린다(세대 개념 없는 키·진행 중 계산은 남긴다)', async () => {
  const { snapMemo, snapCacheSweep, _snapCacheStats, snapCacheClear } = await import('../src/util/snapCache.js');
  snapCacheClear();
  const g1 = '2026-09-26T00:00:00.000Z', g2 = '2026-09-26T00:00:30.000Z';
  await snapMemo('t2617a', `${g1}|/api/vms|`, 60_000, async () => ({ big: 1 }));
  await snapMemo('t2617b', `${g1}|/api/hosts|`, 60_000, async () => ({ big: 2 }));
  await snapMemo('t2617c', 'anomalies|x', 60_000, async () => 3);
  assert.equal(snapCacheSweep(g2), 2);
  assert.equal(_snapCacheStats('t2617a').entries, 0);
  assert.equal(_snapCacheStats('t2617b').entries, 0);
  assert.equal(_snapCacheStats('t2617c').entries, 1, '세대 개념 없는 키는 남는다');
  assert.equal(snapCacheSweep('not-a-time'), 0);
  assert.match(stripComments(read('store.js')), /snapCacheSweep\(this\.snapshot\.generatedAt\)/);
  snapCacheClear();
});

test('⑥ 링 버퍼는 줄마다 8KB 로 자른다 · 시작 백업은 기동 10분 뒤 · 위임 인벤토리 저장은 30초 디바운스', async () => {
  const lb = await import('../src/logbuffer.js');
  lb.pushLog('info', 'y'.repeat(50_000));
  const all = lb.getLogs ? lb.getLogs({}) : null;
  const src = stripComments(read('logbuffer.js'));
  assert.match(src, /if \(msg\.length > MSG_MAX\) msg = `\$\{flatStr\(msg\.slice\(0, MSG_MAX\)\)\}/);
  assert.match(src, /const MSG_MAX = 8192;/);
  assert.match(stripComments(read('backup/settings.js')), /BACKUP_STARTUP_DELAY_MS\) \|\| 10 \* 60_000/);
  assert.match(stripComments(read('central/inventory.js')), /CENTRAL_INVENTORY_PERSIST_MS\) \|\| 30_000/);
  const last = all.items[all.items.length - 1];
  assert.ok(last.msg.length < 8300, `len=${last.msg.length}`);
  assert.match(last.msg, /\+41808자 생략\)$/);
});
