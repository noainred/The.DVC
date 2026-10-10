/**
 * v2.732 그룹 g — B6-06: (데모) SAN 포트 사용량 폴러는 장비마다 매크로태스크를 양보한다.
 *
 * 데모 분기(mock 모드 + mock-san- 장비)에는 I/O 가 없다 — perfDb 핸들은 이미 열려 있고 작업 로그 묶음 해제도 queueMicrotask 라
 * 풀 전체가 마이크로태스크 체인이었다(260대 한 덩어리 436ms — verify-B6). 기본 수집 폴러(v2.731 A6-07)와 같은 장비별 setImmediate.
 * 양보 여부는 벽시계 타이머가 아니라 **setImmediate 프로브가 몇 번 돌았는가**로 잰다(v2.581 BUG-E 규약 — setInterval(0) 하한 1ms 함정).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'a2732g-perfdemo-'));
process.env.CONFIG_DIR = TMP;
process.env.DB_DIR = TMP;
process.env.DATA_SOURCE = 'mock';

const { setDataSource } = await import('../src/runtime-settings.js');
setDataSource('mock');
const { generateSnapshot } = await import('../src/mock/generator.js');
const demo = await import('../src/mock/demo/sanswitch.js');
const reg = await import('../src/sanswitch/registry.js');
const perfPoller = await import('../src/sanswitch/perfPoller.js');
const perfAct = await import('../src/sanswitch/perfActivityLog.js');

test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

test('B6-06: 데모 장비 N대 수집 중 다른 매크로태스크가 장비 수만큼 돈다 · 작업 로그는 N건 전부', async () => {
  const devs = demo.sanDemoDevices(demo.planSanDemo(generateSnapshot()));
  assert.ok(devs.length >= 40, `데모 장비 ${devs.length}대`);
  assert.equal(reg.seedDemoDevices(devs), devs.length);
  const n = reg.listDevices().filter((d) => d.id.startsWith('mock-san-')).length;
  assert.equal(n, devs.length);

  let ticks = 0;
  let stop = false;
  const probe = () => { if (stop) return; ticks++; setImmediate(probe); };
  setImmediate(probe);
  let r;
  try { r = await perfPoller.pollPerfOnce({ force: true }); } finally { stop = true; }

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.collected, n, `전부 수집(${r.collected}/${n}, 실패 ${r.failed})`);
  assert.ok(ticks >= Math.floor(n / 2), `프로브가 ${ticks}번만 돌았다(장비 ${n}대) — 풀 전체가 마이크로태스크 한 덩어리였다는 뜻`);
  const logged = new Set(perfAct.listActivity(1000).map((e) => e.deviceId));
  for (const d of devs) assert.ok(logged.has(d.id), `작업 로그에 ${d.id} 가 있다`);
});
