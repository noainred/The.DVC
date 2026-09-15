/**
 * v2.516 — 수집 작업 로그 **공용 팩토리** 회귀.
 *
 * 사용자 요구(2026-09-15): "스토리지 모니터링 처럼 화면 하단에 진행상태와 로그 보여주는 기능 추가"
 * + "실패일때 클릭하면 구체적인 로그 보여주는 기능".
 *
 * 여기서 고정하는 것:
 *  · 링버퍼 상한(오래된 것부터 폐기) — 없으면 28대×10분 주기로 파일이 무한히 커진다.
 *  · 오류 문구 300자 절단 — SSH 추적·스택이 통째로 들어와 로그가 비대해지는 것을 막는다.
 *  · **수치 필드는 0 과 '미수집'(null)을 구분한다** — 실패 스냅샷을 0 으로 실으면 화면에
 *    '포트 0개' 라는 사실과 다른 표시가 된다(v2.516 실측으로 발견해 고친 결함).
 *  · 손상 파일은 **새로 시작**한다(재생성 가능한 캐시 — 자격증명 스토어의 preserveCorrupt 규칙
 *    대상이 아니다. 여기서 원본을 보존하면 쓸모없는 파일만 쌓인다).
 *  · 스토리지·SAN 두 도메인이 **같은 팩토리**를 쓴다(복제 금지 — 로그 포맷이 갈라지지 않게).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actlog-'));
process.env.CONFIG_DIR = dir;

const { createActivityLog } = await import('../src/util/activityLog.js');

const mk = (over = {}) => createActivityLog({ fileName: 'x-activity.json', max: 50, numFields: ['ports', 'pct'], ...over });

test('기록·조회 — newest-first, 공통 필드 + 주입한 수치 필드', () => {
  const log = mk();
  log._resetForTest();
  log.recordActivity({ deviceId: 'a', name: 'SW-A', host: '10.0.0.1', source: 'central', ok: true, ports: 20, pct: 41, durationMs: 1200, at: 1000 });
  log.recordActivity({ deviceId: 'b', name: 'SW-B', host: '10.0.0.2', source: 'agent-WA', ok: false, error: '실패 사유', at: 2000 });
  const [first, second] = log.listActivity();
  assert.equal(first.deviceId, 'b', 'newest-first');
  assert.equal(first.source, 'agent-WA');
  assert.equal(first.error, '실패 사유');
  assert.equal(second.ports, 20);
  assert.equal(second.pct, 41);
  assert.equal(second.error, null, '오류 없으면 null(빈 문자열이 아니다)');
});

test('수치 필드는 0 과 미수집(null)을 구분한다 — 실패를 0 으로 위장하지 않는다', () => {
  const log = mk(); log._resetForTest();
  log.recordActivity({ deviceId: 'z', ok: true, ports: 0, pct: 0 });        // 진짜 0
  log.recordActivity({ deviceId: 'y', ok: false });                          // 미수집
  const [miss, real] = log.listActivity();
  assert.equal(real.ports, 0, '진짜 0 은 0 으로 남는다');
  assert.equal(miss.ports, null, '값이 없으면 null — 0 으로 채우면 화면이 거짓이 된다');
  assert.equal(miss.pct, null);
  // 유한수가 아닌 값도 전부 null 로 굳힌다(NaN 이 JSON 에서 null 로 새는 것을 미리 막는다).
  log.recordActivity({ deviceId: 'x', ok: true, ports: NaN, pct: Infinity });
  assert.equal(log.listActivity()[0].ports, null);
  assert.equal(log.listActivity()[0].pct, null);
});

test('오류 문구는 300자에서 자른다(로그 비대 방지)', () => {
  const log = mk(); log._resetForTest();
  log.recordActivity({ deviceId: 'a', ok: false, error: 'x'.repeat(5000) });
  assert.equal(log.listActivity()[0].error.length, 300);
});

test('링버퍼 상한 — 오래된 것부터 폐기하고 파일도 상한을 넘지 않는다', () => {
  // ⚠ 팩토리에 **하한 50** 이 있다(`Math.max(50, …)`) — 너무 작은 버퍼는 진단에 쓸모가 없어
  //   원본 스토리지 모듈이 의도적으로 둔 가드다. 그래서 상한 검증은 50 초과 값으로 한다
  //   (max:5 로 테스트하면 50 이 적용돼 '상한이 안 먹는다' 고 오판한다 — 실제로 그랬다).
  const N = 60;
  const log = mk({ max: N, fileName: 'ring.json' }); log._resetForTest();
  for (let i = 0; i < N + 7; i++) log.recordActivity({ deviceId: `d${i}`, ok: true, at: 1000 + i });
  const list = log.listActivity(999);
  assert.equal(list.length, N, `상한 ${N} 을 넘겼다 — 실제 ${list.length}`);
  assert.equal(list[0].deviceId, `d${N + 6}`, '최신이 앞');
  assert.equal(list[N - 1].deviceId, 'd7', '오래된 것부터 폐기');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'ring.json'), 'utf8'));
  assert.equal(onDisk.length, N, '파일도 상한 안이어야 한다(무한 증가 방지)');
});

test('파일 권한 0600 — 오류 문구에 내부 host/경로가 들어간다', () => {
  const log = mk({ fileName: 'perm.json' }); log._resetForTest();
  log.recordActivity({ deviceId: 'a', ok: true });
  const mode = fs.statSync(path.join(dir, 'perm.json')).mode & 0o777;
  assert.equal(mode, 0o600, `모드 ${mode.toString(8)}`);
});

test('손상 파일은 새로 시작한다(preserveCorrupt 대상이 아닌 재생성 캐시)', () => {
  fs.writeFileSync(path.join(dir, 'broken.json'), '{이건 JSON 이 아니다');
  const log = mk({ fileName: 'broken.json' }); log._resetForTest();
  assert.deepEqual(log.listActivity(), [], '손상 시 빈 목록으로 시작');
  log.recordActivity({ deviceId: 'a', ok: true });
  assert.equal(log.listActivity().length, 1, '이후 기록은 정상 동작');
  // 손상 원본을 별도 파일로 남기지 않는다(쓸모없는 파일이 쌓이지 않게).
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('broken.json.corrupt')).length, 0);
});

test('상한을 넘긴 과거 파일은 로드 시 절단한다', () => {
  const big = Array.from({ length: 200 }, (_, i) => ({ at: i, deviceId: `d${i}`, ok: true }));
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify(big));
  const log = mk({ max: 60, fileName: 'old.json' }); log._resetForTest();   // 하한 50 위 값으로
  assert.equal(log.listActivity(999).length, 60);
});

test('스토리지·SAN 이 같은 팩토리를 쓴다 — 로그 포맷이 갈라지지 않게', async () => {
  const st = await import('../src/storage/activityLog.js');
  const sw = await import('../src/sanswitch/activityLog.js');
  for (const m of [st, sw]) {
    assert.equal(typeof m.recordActivity, 'function');
    assert.equal(typeof m.listActivity, 'function');
    assert.equal(typeof m._resetForTest, 'function');
  }
  // 도메인 전용 수치 필드가 각자 다르다(스토리지=노드·용량, 스위치=포트).
  st._resetForTest(); sw._resetForTest();
  st.recordActivity({ deviceId: 'a', ok: true, nodes: 4, usedBytes: 1, totalBytes: 2 });
  sw.recordActivity({ deviceId: 'b', ok: true, portsOnline: 20, portsLicensed: 48, usedPct: 41 });
  assert.equal(st.listActivity()[0].nodes, 4);
  assert.equal(sw.listActivity()[0].portsLicensed, 48);
  assert.equal(sw.listActivity()[0].nodes, undefined, '스위치 로그에 스토리지 필드가 섞이지 않는다');
});

test('공용 팩토리 소스에 복제 흔적이 없다 — 두 파일은 얇은 위임이어야 한다', () => {
  const src = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  for (const f of ['../src/storage/activityLog.js', '../src/sanswitch/activityLog.js']) {
    const s = src(f);
    assert.match(s, /createActivityLog/, `${f} 가 공용 팩토리를 쓰지 않는다`);
    assert.ok(!/atomicWriteFileSync/.test(s), `${f} 에 링버퍼 구현이 복제됐다 — 포맷이 갈라진다`);
  }
});
