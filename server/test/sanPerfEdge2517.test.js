/**
 * v2.517 — 엣지 포트 사용량 수집: 원인 판정 · 상태 중계 · 위임 '지금 수집' 회귀.
 *
 * 사용자 신고(2026-09-15, 스크린샷): 엣지(AZ) 위임 스위치의 '사용량 분석' 탭이 비어 있고 화면은
 * "설정 › 수집 서버 › SAN 스위치 포트 사용량 에서 수집을 켜면 쌓기 시작합니다" 만 말했다 —
 * "데이터 수집이 안되, edge 의 사용량도 분석하게 해줘".
 *
 * 조사 결과: 엣지→중앙 **시계열 중계는 v2.423 에 이미 있었다**(`perfPush.js`). 확정 결함은 다른 것이다.
 *  ① 빈 상태 문구가 원인 6가지를 한 문장으로 덮었다(v2.493 '값이 없는 이유를 단정하지 말 것' 위반).
 *  ② 사용량 수집 실패가 **어디에도** 남지 않았다(`_last.errors` 5건·메모리·장비명 문자열뿐).
 *  ③ 중앙의 '지금 수집' 이 엣지 위임 장비에 **아무 일도 하지 않았다** — `devicesForThisNode()` 가
 *     중앙에서 agent 없는 장비만 돌려주는데(registry.js) 화면은 그 사실을 말하지 않았다.
 *  ④ 표본이 0건이면 엣지가 중앙으로 **아무것도 보내지 않아**(push 조기 반환) 중앙이 엣지 상태를
 *     알 수 없었다 — 그리고 0건이 바로 신고된 상태다.
 *
 * 여기서 고정하는 것은 그 4건이다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanperf2517-'));
process.env.CONFIG_DIR = dir;

const { perfEmptyDiag, PERF_DIAG_KINDS } = await import('../src/sanswitch/perfDiag.js');
const reqs = await import('../src/sanswitch/collectRequests.js');
const edgeStore = await import('../src/central/sanSwitchPerfEdge.js');

const ON = { enabled: true, intervalMs: 300_000 };
const OFF = { enabled: false, intervalMs: 300_000 };
const NOW = Date.now();

/* ── ① 원인 판정 ─────────────────────────────────────────────────────────── */

test('판정 종류 목록과 실제 반환이 어긋나지 않는다', () => {
  // 웹 문구 모듈이 이 목록을 기준으로 switch 를 갖는다 — 새 kind 를 반환하면서 목록에 안 넣으면
  // 화면이 기본 분기('원인 불명')로 조용히 떨어진다.
  const kinds = new Set(PERF_DIAG_KINDS);
  const cases = [
    { dbUnavailable: true },
    { device: { agent: '' }, settings: ON, lastSampleAt: NOW - 86400_000, since: NOW - 3600_000 },
    { device: { collectMethod: 'rest' }, settings: ON },
    { device: { agent: 'AZ' }, settings: ON },
    { device: { agent: 'AZ' }, settings: ON, edge: { enabled: false } },
    { device: { agent: 'AZ' }, settings: ON, edge: { enabled: true, device: { ok: false, error: 'x' } } },
    { device: { agent: 'AZ' }, settings: ON, edge: { enabled: true } },
    { device: { agent: 'AZ' }, settings: ON, edge: { enabled: true, at: NOW } },
    { device: {}, settings: OFF },
    { device: {}, settings: ON, lastEvent: { ok: false, error: 'x' } },
    { device: {}, settings: ON },
    { device: {}, settings: ON, poller: { at: NOW } },
  ];
  for (const c of cases) assert.ok(kinds.has(perfEmptyDiag(c).kind), `미선언 kind: ${perfEmptyDiag(c).kind}`);
});

test('DB 를 못 열면 그 판정이 다른 모든 것을 이긴다(무엇을 켜도 저장되지 않는다)', () => {
  const r = perfEmptyDiag({ dbUnavailable: true, device: { agent: 'AZ' }, settings: OFF });
  assert.equal(r.kind, 'db-unavailable');
  assert.equal(r.waiting, false);
});

test('표본이 있는데 조회 기간 밖이면 "수집 안 됨" 이라 하지 않는다', () => {
  // ⚠ v2.566 정정 — 예전에는 여기 `NOW - 8일` 을 썼는데, **그것은 out-of-range 가 아니라 정지**다.
  //   그 단언이 곧 사용자가 신고한 거짓("10일째 죽었는데 화면이 '수집은 되고 있습니다'")을 고정하고
  //   있었다. 진짜 out-of-range 는 **최근 표본이 좁은 창 밖에 있는 것**이다.
  const r = perfEmptyDiag({ device: {}, settings: ON, lastSampleAt: NOW - 10 * 60_000, since: NOW - 5 * 60_000, now: NOW });
  assert.equal(r.kind, 'out-of-range');
  assert.equal(r.facts.lastSampleAt, NOW - 10 * 60_000);
});

test('⚠ 마지막 표본이 한참 오래되면 "기간을 넓히세요" 가 아니라 "멈췄다" 라고 말한다 (v2.566)', () => {
  const r = perfEmptyDiag({ device: {}, settings: ON, lastSampleAt: NOW - 10 * 86400_000, since: NOW - 3600_000, now: NOW });
  assert.equal(r.kind, 'stale', '10일 전 표본을 조회 기간 문제로 말하면 거짓이다');
  assert.equal(r.waiting, false, '기다려서 될 일이 아니다');
  assert.ok(r.facts.sampleAgeMs > r.facts.staleLimitMs, '판정 근거(나이·한계)를 함께 실어야 화면이 설명할 수 있다');
});

test('수집이 꺼져 있으면 오래된 표본은 정상이다 — "멈췄다" 라고 하지 않는다', () => {
  const off = { ...ON, enabled: false };
  const r = perfEmptyDiag({ device: {}, settings: off, lastSampleAt: NOW - 10 * 86400_000, since: NOW - 3600_000, now: NOW });
  assert.notEqual(r.kind, 'stale', '끈 것은 고장이 아니다');
  assert.equal(r.kind, 'out-of-range');
});

test('⚠ 엣지가 "올리지 못하고 있다" 고 보고하면 기다리라고 말하지 않는다 (v2.566)', () => {
  const r = perfEmptyDiag({
    device: { agent: 'agent-WA' }, settings: ON, lastSampleAt: null, since: NOW - 3600_000, now: NOW,
    edge: { enabled: true, at: NOW - 60_000, pushAt: NOW - 30_000, pushError: "Cannot access 'maxRowid' before initialization", device: null },
  });
  assert.equal(r.kind, 'edge-push-failed');
  assert.equal(r.waiting, false);
  assert.match(r.facts.error, /maxRowid/, '엣지만 아는 사유가 화면까지 와야 한다');
});

test('기간(since)을 모르면 있는 표본을 "기간 밖" 이라 단정하지 않는다', () => {
  const r = perfEmptyDiag({ device: {}, settings: ON, lastSampleAt: NOW - 8 * 86400_000, since: null, poller: { at: NOW } });
  assert.notEqual(r.kind, 'out-of-range');
});

test('null 시각이 0(1970년)으로 둔갑하지 않는다', () => {
  // 초판 결함: `Number(null)` 은 0 이고 0 은 유한수라 facts.lastSampleAt 이 0 으로 나왔다.
  // 0 이 통과하면 `0 < since` 가 참이 되어 '기간 밖' 으로 오판한다.
  const f = perfEmptyDiag({ device: {}, settings: ON, since: NOW - 3600_000 }).facts;
  assert.equal(f.lastSampleAt, null);
  assert.equal(f.pollerAt, null);
  assert.equal(f.errorAt, null);
});

test('REST 장비는 설정보다 먼저 판정한다 — 켜도 안 쌓인다', () => {
  for (const st of [ON, OFF]) {
    const r = perfEmptyDiag({ device: { collectMethod: 'rest' }, settings: st });
    assert.equal(r.kind, 'rest-method');
    assert.equal(r.waiting, false);   // '기다리세요' 라고 말하면 거짓이다
  }
});

test('엣지 위임: 보고 없음 / 꺼짐 / 실패 / 첫 수집 / push 대기를 구분한다', () => {
  const base = { device: { agent: 'AZ' }, settings: ON };
  assert.equal(perfEmptyDiag(base).kind, 'edge-no-report');
  assert.equal(perfEmptyDiag({ ...base, edge: { enabled: false, at: NOW } }).kind, 'edge-disabled');
  const failed = perfEmptyDiag({ ...base, edge: { enabled: true, at: NOW, device: { ok: false, error: 'rbash: portperfshow: command not found', at: NOW - 60_000 } } });
  assert.equal(failed.kind, 'edge-device-failed');
  assert.equal(failed.waiting, false);
  assert.match(failed.facts.error, /command not found/);
  assert.equal(failed.facts.errorSource, 'AZ');
  assert.equal(perfEmptyDiag({ ...base, edge: { enabled: true, at: null } }).kind, 'edge-first-cycle');
  assert.equal(perfEmptyDiag({ ...base, edge: { enabled: true, at: NOW } }).waiting, true);
});

test('엣지 위임 장비는 중앙 폴러 상태로 판정하지 않는다', () => {
  // 중앙 폴러가 방금 돌았어도(agent 없는 장비만 수집) 위임 장비와는 무관하다.
  const r = perfEmptyDiag({ device: { agent: 'AZ' }, settings: ON, poller: { at: NOW }, lastEvent: { ok: false, error: '중앙 실패' } });
  assert.equal(r.kind, 'edge-no-report');
  assert.equal(r.facts.error, null);   // 중앙의 실패 사유를 엣지 장비에 갖다 붙이지 않는다
});

test('중앙 직접: 꺼짐 / 실패 / 첫 폴 / 원인 불명', () => {
  assert.equal(perfEmptyDiag({ device: {}, settings: OFF }).kind, 'disabled');
  const f = perfEmptyDiag({ device: {}, settings: ON, lastEvent: { ok: false, error: 'boom', at: NOW } });
  assert.equal(f.kind, 'device-failed');
  assert.equal(f.facts.error, 'boom');
  assert.equal(perfEmptyDiag({ device: {}, settings: ON }).kind, 'first-cycle');
  const u = perfEmptyDiag({ device: {}, settings: ON, poller: { at: NOW }, lastEvent: { ok: true, at: NOW } });
  assert.equal(u.kind, 'collected-empty');
  assert.equal(u.waiting, false);      // 원인을 모를 때 '기다리세요' 라고 말하지 않는다
});

/* ── ② 엣지 상태 정규화·보관 ───────────────────────────────────────────────── */

test('엣지 상태는 형식·상한을 중앙이 강제한다', () => {
  const st = edgeStore.normalizeEdgePerfStatus({
    enabled: 'yes',                                  // 문자열은 켜짐이 아니다
    intervalMs: 'abc', at: NOW, collected: 3, failed: null,
    devices: [{ id: 'a', ok: true, ports: 12, at: NOW }, { id: '', ok: true }, { id: 'b', ok: false, error: 'x'.repeat(500) }],
  });
  assert.equal(st.enabled, false);
  assert.equal(st.intervalMs, null);
  assert.equal(st.failed, null);
  assert.equal(st.devices.length, 2);                // id 빈 항목은 버린다
  assert.equal(st.devices[1].error.length, 300);     // 오류 300자 절단(작업 로그와 같은 상한)
});

test('미위임 deviceId 는 버린다(남의 스위치 상태 위조 차단)', () => {
  edgeStore._resetForTest();
  edgeStore.saveEdgePerfStatus('AZ', {
    enabled: true, at: NOW,
    devices: [{ id: 'mine', ok: true, at: NOW }, { id: 'others', ok: false, at: NOW, error: 'x' }],
  }, { owned: new Set(['mine']) });
  const got = edgeStore.edgePerfStatusFor('others', 'AZ');
  assert.equal(got.device, null);
  assert.equal(edgeStore.edgePerfStatusFor('mine', 'AZ').device.ok, true);
});

test('보고가 없는 엣지는 null 을 돌려준다 — 꺼짐이라 말하지 않는다', () => {
  edgeStore._resetForTest();
  assert.equal(edgeStore.edgePerfStatusFor('x', 'NOBODY'), null);
  assert.equal(edgeStore.edgePerfStatusFor('x', ''), null);
  // 이 null 이 곧 'edge-no-report' 판정으로 이어진다(위 테스트).
  assert.equal(perfEmptyDiag({ device: { agent: 'NOBODY' }, settings: ON, edge: null }).kind, 'edge-no-report');
});

test('엣지 상태는 중앙 작업 로그에도 남고, 같은 이벤트를 두 번 남기지 않는다', async () => {
  const log = await import('../src/sanswitch/perfActivityLog.js');
  log._resetForTest();
  edgeStore._resetForTest();
  const payload = { enabled: true, at: NOW, devices: [{ id: 'd1', ok: false, at: NOW, error: 'rbash: portperfshow: command not found' }] };
  const owned = new Set(['d1']);
  edgeStore.saveEdgePerfStatus('AZ', payload, { owned, names: new Map([['d1', 'AZ-1']]) });
  edgeStore.saveEdgePerfStatus('AZ', payload, { owned });   // 엣지는 주기마다 같은 것을 다시 보낸다
  const evts = log.listActivity(50).filter((e) => e.deviceId === 'd1');
  assert.equal(evts.length, 1, '같은 at 재push 가 로그를 부풀리면 상한이 빨리 소진된다');
  assert.equal(evts[0].source, 'AZ');
  assert.equal(evts[0].name, 'AZ-1');
  assert.match(evts[0].error, /command not found/);
  // ⚠ 실패 이벤트의 수치는 null 이다 — 0 을 실으면 '포트 0개' 라는 거짓이 찍힌다(v2.516 규약).
  assert.equal(evts[0].ports, null);
});

/* ── ③ 위임 '지금 수집' 큐 ─────────────────────────────────────────────────── */

test('사용량 재수집 요청은 엣지 단위·one-shot·멱등', () => {
  reqs._resetForTest();
  assert.equal(reqs.hasPendingPerfRequest('AZ'), false);
  assert.equal(reqs.requestPerfCollect('AZ').duplicate, false);
  assert.equal(reqs.requestPerfCollect('AZ').duplicate, true, '연타는 중복으로 알려야 한다(요청을 곱하지 않게)');
  assert.equal(reqs.hasPendingPerfRequest('az'), true, '대소문자 무관');
  assert.equal(reqs.takePerfRequestForAgent('AZ'), true);
  assert.equal(reqs.takePerfRequestForAgent('AZ'), false, 'one-shot — 서빙 뒤 제거');
});

test('사용량 큐와 기본 수집 큐는 서로를 지우지 않는다', () => {
  reqs._resetForTest();
  reqs.requestCollect('dev1', 'AZ');
  reqs.requestPerfCollect('AZ');
  assert.deepEqual(reqs.takeRequestsForAgent('AZ'), ['dev1']);
  assert.equal(reqs.hasPendingPerfRequest('AZ'), true, '기본 수집 인출이 사용량 요청을 지우면 안 된다');
});

test('빈 agent 이름으로는 요청이 등록되지 않는다', () => {
  reqs._resetForTest();
  reqs.requestPerfCollect('');
  assert.equal(reqs.takePerfRequestForAgent(''), false);
});

/* ── ④ 소스 규약(코드가 규칙을 지키는지) ──────────────────────────────────── */

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('표본이 0건이어도 엣지는 상태를 올린다(push 조기 반환 금지)', () => {
  const src = read('../src/sanswitch/perfPush.js');
  assert.match(src, /sendStatusOnly/, '상태 전용 하트비트가 있어야 한다');
  const zero = src.slice(src.indexOf('if (!rows.length)'), src.indexOf('const meta = await metaFor'));
  assert.match(zero, /sendStatusOnly\(status\)/, '표본 0건 경로가 상태를 보내지 않으면 중앙이 엣지를 영영 못 본다');
  // 상태는 청크 0 에만 — 매 청크에 실으면 중앙이 같은 상태를 청크 수만큼 다시 기록한다.
  assert.match(src, /i === 0 \? \{ status \} : \{\}/);
});

test('중앙 config 응답이 perfCollectNow 를 내려주고, 엣지가 그것으로 수집한다', () => {
  assert.match(read('../src/routes/central.js'), /perfCollectNow: takePerfRequestForAgent\(agent\)/);
  const pull = read('../src/agent/sanSwitchConfigPull.js');
  assert.match(pull, /body\?\.perfCollectNow === true/);
  assert.match(pull, /pollPerfOnce\(\{ force: true \}\)/);
  // pull 응답을 붙잡지 않는다 — 캡처는 표본시간×장비수라 설정 반영·테스트 대행이 그만큼 밀린다.
  // (수집 자체는 async IIFE 안에서 await 하지만, 그 IIFE 를 **await 하지 않는다**.)
  const blk = pull.slice(pull.indexOf('body?.perfCollectNow === true'), pull.indexOf('_last = { at: Date.now()'));
  assert.match(blk, /\}\)\(\)\.catch\(/, '수집을 비동기로 떼어내지 않으면 설정 pull 이 캡처 시간만큼 지연된다');
  assert.ok(!/await \(async/.test(blk), 'IIFE 를 await 하면 떼어낸 의미가 없다');
});

test('실패 스냅샷의 수치를 0 으로 싣지 않는다(폴러·엣지 수신 양쪽)', () => {
  assert.match(read('../src/sanswitch/perfPoller.js'), /ports: null, totalBps: null, error: e\.message/);
  assert.match(read('../src/central/sanSwitchPerfEdge.js'), /ports: d\.ok \? d\.ports : null/);
});

test('사용량 작업 로그 라우트는 기본 수집과 같은 응답 형태를 쓴다', () => {
  const src = read('../src/routes/api/sanSwitch.js');
  assert.match(src, /'\/tools\/sanswitch\/perf\/activity'/);
  assert.match(src, /poller: sanSwitchPerfStatus\(\), events: listPerfActivity/);
  // '지금 수집' 은 즉시분과 요청분을 나눠 말한다(뭉치면 '전부 지금 수집했다' 는 거짓).
  assert.match(src, /requested, alreadyQueued/);
  // 설정 응답은 중앙 폴러 상태와 엣지 보고를 따로 싣는다.
  assert.match(src, /status: sanSwitchPerfStatus\(\), edges: listEdgePerfStatus\(\)/);
});

test('REST 장비의 건너뜀은 작업 로그에 남기지 않는다(상한을 비이벤트로 소진하지 않게)', () => {
  const src = read('../src/sanswitch/perfPoller.js');
  const pool = src.slice(src.indexOf('await pool(devices, CONCURRENCY'), src.indexOf('_last = { at: Date.now()'));
  assert.match(pool, /if \(r\.skipped\) return;/);
  assert.ok(pool.indexOf('if (r.skipped) return;') < pool.indexOf('recordActivity'), 'skip 이 기록보다 먼저 반환해야 한다');
});
