// 종료 지연(v2.456) — 업그레이드 재시작이 느리던 원인의 회귀 고정.
//
// 운영 관측: "오늘 업데이트 이후 업그레이드를 적용하면 서비스가 올라가는 데 시간이 오래 걸린다."
// 실측해 보니 **기동이 아니라 종료**였다:
//   14:24:23.154 Started → 14:24:24.171 listening      = 기동 1.0초 (정상)
//   14:24:22.917 [shutdown] 유예 시간 초과              = 종료 8.2초 (유예 전량 소진)
//
// 원인: 엣지 RMA 가 최대 55초 롱폴로 HTTP 연결을 열어 두는데(routes/central.js), 법인 수만큼
// 그 연결이 살아 있고 `server.close()` 는 전부 닫혀야 콜백을 부른다. v2.447 이 정상 종료를
// 도입하면서 매 재시작마다 유예(8초)를 통째로 쓰게 됐다.
//
// 수정 실측(로컬, pending 연결 3개): 8,014ms → 1,518ms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { takeJobsWait, releaseAllWaiters, _resetRma } from '../src/rma/jobs.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

test('★ releaseAllWaiters — 대기 중인 롱폴을 즉시 깨운다(종료가 막히지 않게)', async () => {
  _resetRma();
  const t0 = Date.now();
  // 55초 롱폴 3건 — 운영에서 법인마다 하나씩 걸려 있는 그 상태.
  const polls = ['A', 'B', 'C'].map((a) => takeJobsWait(a, '', 55_000));
  await new Promise((r) => setTimeout(r, 30));   // 대기자가 등록될 틈

  const woken = releaseAllWaiters();
  assert.equal(woken, 3, `대기자 3건을 모두 깨워야 한다(깨운 수=${woken})`);

  const results = await Promise.all(polls);
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `깨운 뒤 즉시 끝나야 한다(${ms}ms) — 안 그러면 종료가 55초까지 늘어진다`);
  for (const r of results) assert.deepEqual(r, [], '깨어난 폴은 잡을 claim 하지 않는다(큐에 남겨 다음 폴이 가져간다)');
  _resetRma();
});

test('releaseAllWaiters — 대기자가 없으면 0 을 돌려주고 아무 일도 하지 않는다', () => {
  _resetRma();
  assert.equal(releaseAllWaiters(), 0);
});

test('종료 경로가 롱폴을 먼저 해제한다(순서가 바뀌면 다시 8초를 쓴다)', () => {
  const idx = read('index.js');
  const g = idx.slice(idx.indexOf('const gracefulExit'), idx.indexOf("process.on('SIGTERM'"));
  assert.ok(/releaseRmaWaiters\(\)/.test(g), '종료 경로에 롱폴 해제가 없다 — server.close() 가 최대 55초를 기다린다');
  // 함정 둘: ⓐ 주석에도 'server.close()' 가 나온다 ⓑ 'closeAllConnections' 가 'server.close' 로도
  // 매치된다. 주석을 걷어내고 **여는 괄호까지 붙여** 실제 호출만 본다.
  const code = g.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const iRelease = code.indexOf('releaseRmaWaiters(');
  const iClose = code.indexOf('server.close(');
  assert.ok(iRelease >= 0 && iClose >= 0, `호출을 찾지 못했다(release=${iRelease}, close=${iClose})`);
  assert.ok(iRelease < iClose,
    '롱폴 해제는 server.close() **앞**이어야 한다 — 뒤에 있으면 이미 기다리기 시작한 뒤다');
});

test('남은 연결을 짧은 지연 뒤 강제로 끊는다(WS 터널 등이 유예를 다 쓰지 않게)', () => {
  const idx = read('index.js');
  const g = idx.slice(idx.indexOf('const gracefulExit'), idx.indexOf("process.on('SIGTERM'"));
  assert.ok(/closeAllConnections/.test(g), 'closeAllConnections 가 없으면 롱폴 외 연결이 유예를 소진한다');
  assert.ok(/SHUTDOWN_HARD_MS/.test(idx), '강제 종료 지연이 조정 가능해야 한다');
  // 강제 지연은 유예보다 반드시 짧아야 한다 — 같거나 길면 의미가 없다.
  const m = /Math\.max\(200, Math\.min\(SHUTDOWN_GRACE_MS - 200, Number\(process\.env\.SHUTDOWN_HARD_MS\) \|\| (\d+)\)\)/.exec(idx);
  assert.ok(m, '강제 지연 계산식을 찾지 못했다');
  assert.ok(Number(m[1]) <= 3000, `기본 강제 지연이 너무 길다(${m[1]}ms)`);
});

test('종료 타이머를 모두 정리한다(프로세스가 타이머 때문에 남지 않게)', () => {
  const idx = read('index.js');
  const g = idx.slice(idx.indexOf('const gracefulExit'), idx.indexOf("process.on('SIGTERM'"));
  // server.close 콜백과 catch 경로 양쪽에서 두 타이머를 모두 clear 해야 한다.
  const closes = g.match(/clearTimeout\(timer\); clearTimeout\(hard\);/g) || [];
  assert.ok(closes.length >= 2, `타이머 정리가 빠진 경로가 있다(${closes.length}곳)`);
});

test('롱폴 대기 타이머는 여전히 unref 하지 않는다(응답 대기 중인 요청을 살려야 한다)', () => {
  // 이 규칙을 되돌리면 롱폴이 응답 전에 프로세스가 죽을 수 있다(server/CLAUDE.md RMA 불변조건).
  const jobs = read('rma/jobs.js');
  assert.match(jobs, /setTimeout\(done, waitMs\); \/\/ unref 하지 않는다/);
});
