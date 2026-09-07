import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v2.417 개선 포인트 회귀 — 세션 취소(withDeadline)·push 청크/병합·법인 미지정 센티널·출력 상한.
process.env.CONFIG_DIR = process.env.CONFIG_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'imp2417-'));

test('withDeadline: 기한이 지나면 signal 이 abort 되고 라벨이 붙은 오류로 끝난다 — 결과만 포기하는 race 가 아니다', async () => {
  const { withDeadline } = await import('../src/proxy/sshExec.js');
  let seen = null;
  const t0 = Date.now();
  await assert.rejects(
    withDeadline(1200, (signal) => new Promise((_, rej) => { seen = signal; signal.addEventListener('abort', () => rej(new Error('inner aborted'))); }), '수집 타임아웃'),
    /수집 타임아웃\(1초\)/,
  );
  assert.equal(seen?.aborted, true, '호출자가 받은 signal 이 실제로 abort 됨');
  assert.ok(Date.now() - t0 < 3000);
  // 정상 완료는 그대로 통과, 내부 오류는 그대로 전달
  assert.equal(await withDeadline(5000, async () => 42), 42);
  await assert.rejects(withDeadline(5000, async () => { throw new Error('boom'); }), /boom/);
});

test('chunkDevices: JSON 크기 상한으로 나누고 순서·전체를 보존한다', async () => {
  const { chunkDevices } = await import('../src/sanswitch/push.js');
  const big = (id) => ({ deviceId: id, ports: { list: Array.from({ length: 50 }, (_, i) => ({ index: i, name: 'x'.repeat(40) })) } });
  const devices = Array.from({ length: 10 }, (_, i) => big(`d${i}`));
  const one = Buffer.byteLength(JSON.stringify(devices[0]));
  const chunks = chunkDevices(devices, one * 3 + 10);
  assert.ok(chunks.length >= 4 && chunks.length <= 5, `청크 수 ${chunks.length}`);
  assert.deepEqual(chunks.flat().map((d) => d.deviceId), devices.map((d) => d.deviceId));
  assert.equal(chunkDevices([big('solo')], 10).length, 1, '상한보다 큰 단일 장비도 단독 청크로');
  assert.deepEqual(chunkDevices([], 100), []);
});

test('saveEdgeSanSwitch: 첫 청크는 교체, 이후 청크는 deviceId upsert 로 합쳐진다', async () => {
  const m = await import('../src/central/sanSwitchEdge.js');
  m._resetForTest();
  m.saveEdgeSanSwitch('E1', [{ deviceId: 'old', ok: true }]);
  m.saveEdgeSanSwitch('E1', [{ deviceId: 'a', ok: true }], { chunk: 0, chunks: 3 });
  m.saveEdgeSanSwitch('E1', [{ deviceId: 'b', ok: true }], { chunk: 1, chunks: 3 });
  m.saveEdgeSanSwitch('E1', [{ deviceId: 'a', ok: false }, { deviceId: 'c', ok: true }], { chunk: 2, chunks: 3 });
  const ids = m.edgeSanSwitchSnapshots().filter((s) => s.agent === 'E1').map((s) => `${s.deviceId}:${s.ok}`).sort();
  assert.deepEqual(ids, ['a:false', 'b:true', 'c:true'], '옛 목록(old)은 첫 청크에서 사라지고, a 는 마지막 값으로 갱신');
  m.saveEdgeSanSwitch('E1', [{ deviceId: 'z', ok: true }]);
  assert.deepEqual(m.edgeSanSwitchSnapshots().filter((s) => s.agent === 'E1').map((s) => s.deviceId), ['z'], '청크 정보 없는 push 는 종전처럼 교체');
});

test('NONE_DC 센티널이 route 모듈에서 노출된다(법인 미지정 범위 조회용)', async () => {
  const { NONE_DC, parsePortsParam } = await import('../src/routes/api/sanSwitch.js');
  assert.equal(NONE_DC, '__none__');
  assert.deepEqual(parsePortsParam('1,2'), [1, 2]);
});

test('sshExec exec 출력 상한 상수는 환경변수로 조정되고 하한 64KB 를 지킨다', async () => {
  const src = fs.readFileSync(new URL('../src/proxy/sshExec.js', import.meta.url), 'utf8');
  assert.match(src, /EXEC_MAX_OUTPUT = Math\.max\(64 \* 1024/);
  assert.match(src, /출력 상한.*초과/);
});
