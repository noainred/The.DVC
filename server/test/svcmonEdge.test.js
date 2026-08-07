/**
 * 성능점검 엣지 위임(RMA) — 중앙 수신 저장소·배정 저장소·역할 게이팅.
 * 두 프로세스 통합 흐름은 별도 수동 검증(중앙 18210 + 엣지 18211)으로 확인했고,
 * 여기서는 그 흐름의 단위 계약을 고정한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'svcmon-rma-'));
process.env.SVCMON_WORKERS = '0';

const edge = await import('../src/central/svcmonEdge.js');
const assign = await import('../src/central/svcmonAssign.js');

const rows = (n, pre = 't') => Array.from({ length: n }, (_, i) => ({ i: `${pre}-${i}`, s: 'ok', r: 'ok', m: 5, k: 1, a: 100 }));
const metas = (n, pre = 't') => Array.from({ length: n }, (_, i) => ({ i: `${pre}-${i}`, p: 'A\\B', n: `srv${i}`, h: '10.0.0.1', t: 'ping', y: 'ping', iv: 60 }));
const env = (over = {}) => ({ snapId: 100, seq: 1, total: 1, sentAt: Date.now(), expectMs: 20000, items: 5, reported: 5, metaSig: 'sig-a', meta: null, rows: rows(5), ...over });

/* ── 수신 저장소 ── */
test('보고 수신: agent 는 인자(토큰 해석값)만 쓰고 본문 agent 를 읽지 않는다', () => {
  const r = edge.ingestReport('edge-a', { ...env(), agent: 'victim-b' });
  assert.equal(r.ok, true);
  assert.equal(edge.getAgentRaw('victim-b'), null, '본문 agent 로 남의 저장소를 만들 수 없다');
  assert.equal(edge.getAgentRaw('edge-a').rows.size, 5);
  edge._resetEdgeCache();
});

test('시각은 중앙 시계: 구간값 환산 + 비정상 구간값은 수신 시각으로 대체(badRow 집계)', () => {
  const recv = 1_000_000_000;
  edge.ingestReport('e1', env({ rows: [
    { i: 'a', s: 'ok', r: '', m: 1, k: 1, a: 5_000 },          // 5초 전 측정
    { i: 'b', s: 'ok', r: '', m: 1, k: 1, a: -10 },            // 음수 — 위조·시계 점프
    { i: 'c', s: 'ok', r: '', m: 1, k: 1, a: 999_999_999 },    // 24시간 초과
  ] }), recv);
  const a = edge.getAgentRaw('e1');
  assert.equal(a.rows.get('a').measuredAt, recv - 5_000);
  assert.equal(a.rows.get('b').measuredAt, recv, '비정상 구간값은 버리지 않고 수신 시각으로 대체');
  assert.equal(a.rows.get('c').measuredAt, recv);
  assert.equal(a.counters.badRow, 2);
  edge._resetEdgeCache();
});

test('needMeta 협상: 메타가 없거나 sig 가 다르면 요청하고, 받으면 멈춘다', () => {
  let r = edge.ingestReport('e2', env({ metaSig: 'sig-a' }));
  assert.equal(r.needMeta, true, '메타가 없으면 요청');
  r = edge.ingestReport('e2', env({ metaSig: 'sig-a', meta: metas(5) }));
  assert.equal(r.needMeta, false);
  assert.equal(edge.getAgentRaw('e2').meta.size, 5);
  r = edge.ingestReport('e2', env({ metaSig: 'sig-a' }));
  assert.equal(r.needMeta, false, 'sig 일치 + 메타 보유 → 재요청 없음');
  r = edge.ingestReport('e2', env({ metaSig: 'sig-b' }));
  assert.equal(r.needMeta, true, '엣지 정의가 바뀌면(sig 변경) 다시 요청');
  edge._resetEdgeCache();
});

test('완결 GC: 2세대 지난 행 정리 · 미완결은 유지 · snapId 역행에는 GC 금지', () => {
  edge.ingestReport('e3', env({ snapId: 100, rows: rows(5) }));
  // 엣지에서 t-4 삭제 → 4행 스냅샷 2세대
  edge.ingestReport('e3', env({ snapId: 200, rows: rows(4) }));
  edge.ingestReport('e3', env({ snapId: 300, rows: rows(4) }));
  const a = edge.getAgentRaw('e3');
  assert.equal(a.rows.size, 4, '삭제된 점검이 2세대 후 정리된다');
  assert.ok(!a.rows.has('t-4'));

  // 미완결(청크 1/2) — GC 없음: 유실 청크의 행이 이전 값으로 남아 stale 로 보이는 것이 정확하다
  edge.ingestReport('e3', env({ snapId: 400, seq: 1, total: 2, rows: rows(2) }));
  assert.equal(edge.getAgentRaw('e3').rows.size, 4);
  assert.equal(edge.getAgentRaw('e3').complete, false);

  // snapId 역행(엣지 재시작·시계 점프·위조) — 낮은 id 기준 GC 를 돌리면 정상 행이 대량 삭제된다
  edge.ingestReport('e3', env({ snapId: 50, rows: [{ i: 'x', s: 'ok', r: '', m: 1, k: 1, a: 10 }] }));
  const b = edge.getAgentRaw('e3');
  assert.ok(b.rows.has('t-0'), '역행 스냅샷이 기존 행을 지우면 안 된다');
  edge._resetEdgeCache();
});

test('무보고 판정: 엣지가 알린 주기의 3배(하한 5분) · 하트비트로 항목 0 과 죽음을 구별', () => {
  const now = Date.now();
  edge.ingestReport('e4', env({ expectMs: 60_000, items: 0, reported: 0, rows: [] }), now);
  const s1 = edge.edgeSummary(now)[0];
  assert.equal(s1.silent, false, '항목 0개여도 봉투가 오면 살아 있는 것');
  assert.equal(s1.items, 0);
  const s2 = edge.edgeSummary(now + 301_000)[0];
  assert.equal(s2.silent, true, '5분(하한) 넘게 조용하면 무보고');
  // 무보고 엣지의 항목은 상태 미상 — ok/bad 로 세지 않는다
  assert.deepEqual(s2.counts, { ok: 0, warn: 0, bad: 0, stale: 0 });
  edge._resetEdgeCache();
});

test('행 상한 초과는 조용히 자르지 않고 dropped·overflow 로 보고한다', () => {
  const max = edge.MAX_ROWS_PER_AGENT;
  const r1 = edge.ingestReport('e5', env({ rows: rows(Math.min(10, max)) }));
  assert.equal(r1.dropped, 0);
  // 상한을 넘기는 것은 환경변수 없이 재현이 무거우므로 개별 행 형식 오류로 dropped 경로만 고정
  const r2 = edge.ingestReport('e5', env({ rows: [{ s: 'ok' }, ...rows(2, 'y')] }));
  assert.equal(r2.dropped, 1, 'id 없는 행은 버리고 개수로 보고');
  edge._resetEdgeCache();
});

/* ── 배정 저장소 ── */
test('배정: 태그가 40자 상한 안(24자) — 넘으면 엣지 삭제가 0건이 되어 정의가 영구히 갱신되지 않는다', () => {
  const targets = [{ kind: 'infra', path: 'A\\B', name: 's1', host: '10.0.0.1', enabled: true, tests: [
    { id: 'orig-1', name: 'p', type: 'ping', intervalSec: 120, enabled: true },
    { id: 'orig-2', name: 'tr', type: 'trace', intervalSec: 300, enabled: true },
    { id: 'orig-3', name: 'dom', type: 'domain', intervalSec: 86400, enabled: true },
  ] }];
  const a = assign.setAssignment('edge-x', { kind: 'infra', path: 'A' }, targets, { user: 'tester' });
  assert.equal(assign.batchTag(a.sig).length, 24);
  assert.ok(assign.batchTag(a.sig).length <= 40);
  assert.equal(a.state, 'pending', '배포만으로 성공을 단정하지 않는다');

  // 기본 제외 유형: trace(환경 의존)·domain(외부 인터넷 필요)은 엣지로 보내지 않는다
  const full = assign.getAssignmentForAgent('edge-x');
  assert.equal(full.targets[0].tests.length, 1);
  assert.equal(full.targets[0].tests[0].type, 'ping');
  // 엣지가 자기 id 를 발급하도록 중앙 id 는 벗겨 보낸다
  assert.equal(full.targets[0].tests[0].id, undefined);
});

test('배정 pull: sig 가 같으면 본문을 보내지 않는다(WAN 절약)', () => {
  const cur = assign.getAssignmentForAgent('edge-x');
  const again = assign.getAssignmentForAgent('edge-x', cur.sig);
  assert.equal(again.unchanged, true);
  assert.equal(again.targets.length, 0);
});

test('배정 ack: 수가 정확히 일치해야 active — 아니면 mismatch 로 드러낸다', () => {
  const cur = assign.getAssignmentForAgent('edge-x');
  // 엉뚱한 sig → 거부(다시 pull 유도)
  let r = assign.ackAssignment('edge-x', { sig: 'wrong', applied: { added: 1, newTests: 1 } });
  assert.equal(r.ok, false);
  // 수 불일치 → mismatch (조용히 성공으로 넘기면 감시 공백이 정상으로 보인다)
  r = assign.ackAssignment('edge-x', { sig: cur.sig, applied: { added: 0, newTests: 0 } });
  assert.equal(r.state, 'mismatch');
  // 정확 일치 → active
  r = assign.ackAssignment('edge-x', { sig: cur.sig, applied: { added: cur.counts.targets, newTests: cur.counts.tests } });
  assert.equal(r.state, 'active');
  assert.equal(r.exact, true);
  // 엣지가 오류를 보고하면 error
  r = assign.ackAssignment('edge-x', { sig: cur.sig, applied: { added: 1, newTests: 1 }, errors: ['host 차단'] });
  assert.equal(r.state, 'error');
});

test('배정 파일 왕복 + 손상 보존', () => {
  assign._resetAssignCache();
  const list = assign.listAssignments();
  assert.equal(list.length, 1, '캐시를 비워도 파일에서 복원된다');
  assert.equal(list[0].agent, 'edge-x');

  // 형식이 다른 파일(파싱은 되는)도 .corrupt 로 보존 — 조용히 비우면 다음 저장이 원본을 덮는다
  const file = path.join(process.env.CONFIG_DIR, 'central-svcmon-assign.json');
  fs.writeFileSync(file, JSON.stringify({ agents: [1, 2, 3] }));
  assign._resetAssignCache();
  assert.equal(assign.listAssignments().length, 0);
  const bak = fs.readdirSync(process.env.CONFIG_DIR).filter((f) => f.startsWith('central-svcmon-assign.json.corrupt.'));
  assert.equal(bak.length, 1, '형식 불일치도 corrupt 보존 대상이다');
});

/* ── 역할 게이팅 ── */
test('SVCMON_ROLE=central 이면 폴러가 실행하지 않는다(자식 프로세스로 검증)', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  // 이 테스트 파일 기준 상대경로로 poller 를 찾는다 — cwd 에 의존하면(과거 path.resolve('src/...'))
  // 리포지토리 루트에서 `node --test` 를 돌릴 때 경로가 어긋난다(server/ 안에서만 통과했었다).
  const pollerUrl = new URL('../src/svcmon/poller.js', import.meta.url).href;
  const script = `
    process.env.SVCMON_ROLE='central';
    const m = await import(${JSON.stringify(pollerUrl)});
    m.startSvcmonPoller();
    const r = m.pollerRole();
    console.log(JSON.stringify(r));
  `;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svcmon-role-'));
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve('.'), env: { ...process.env, CONFIG_DIR: dir, SVCMON_ROLE: 'central' },
  });
  const out = JSON.parse(stdout.trim().split('\n').pop());
  assert.equal(out.role, 'central');
  assert.equal(out.executes, false, '중앙은 점검을 직접 실행하지 않는다 — 배포·수신만');
});
