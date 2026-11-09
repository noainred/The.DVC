/**
 * fieldCheckOnefs2954.test.js — 개선 검토 3번(v2.954).
 *  ① 법인별 실환경 확인 '아이실론 분리 실행' 판정(순수) — 확인 · 실패(사유) · 대기(옛 엣지 · 조사 전) · 해당 없음(대상 없음 · 분리 실행 끔 · 중앙 직접) · 목 · 엣지 시각 자르기
 *  ② 중앙 정제 — 엣지 isidu 상태의 poller.lastRuns 는 아는 실행 방식만 · 상한 · 문자열 상한(엣지가 보낸 것은 정제한다)
 *  ③ 엣지 쪽 — 폴러 상태와 push 상태 본문이 lastRuns 를 싣는다(소스 스윕 — push 진입은 isidu push 테스트가 돈다)
 *  ④ 표 — 항목 다섯 · 실제 라우트에 isiduOf 연결
 *  ⑤ Bareos 늦은 회신 미반영(v2.938 반증 B-6 후속)은 감사 로그에도 남는다
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fc2954-'));
process.env.DATA_SOURCE = 'mock';
const J = await import('../src/fieldcheck/judge.js');
const IE = await import('../src/central/isiduEdge.js');

const st = (lastRuns, extra = {}) => ({ at: 2_000, status: { targets: 2, version: '2.954.0', poller: { lastRuns }, ...extra } });

test('① 판정 — 확인 · 실패 · 대기 · 해당 없음 · 목 · 시각 자르기', () => {
  const base = { site: true, agent: 'edge-pl', mock: false };
  assert.equal(J.judgeOnefsDetach({ ...base, isidu: st([{ targetId: 'a', at: 1_000, mode: 'detached', detach: true }]) }).state, 'confirmed');
  const re = J.judgeOnefsDetach({ ...base, isidu: st([{ targetId: 'a', at: 9_999, mode: 'attached', detach: true, attached: true }]) });
  assert.equal(re.state, 'confirmed'); assert.match(re.detail, /이어 받음/); assert.equal(re.at, 2_000, '엣지 시각이 수신 시각보다 뒤면 수신 시각으로 자른다');
  const f = J.judgeOnefsDetach({ ...base, isidu: st([{ targetId: 'a', at: 1_000, mode: 'attached-fallback', detach: true, fallback: 'nohup 없음' }]) });
  assert.equal(f.state, 'failed'); assert.match(f.detail, /nohup 없음/);
  // 하나라도 분리 실행이 됐으면 확인
  assert.equal(J.judgeOnefsDetach({ ...base, isidu: st([{ targetId: 'a', at: 1, mode: 'attached-fallback', detach: true }, { targetId: 'b', at: 2, mode: 'detached', detach: true }]) }).state, 'confirmed');
  assert.equal(J.judgeOnefsDetach({ ...base, isidu: st([{ targetId: 'a', at: 1, mode: 'attached', detach: false }]) }).state, 'na', '분리 실행을 끈 대상만');
  assert.equal(J.judgeOnefsDetach({ ...base, isidu: st([]) }).state, 'pending', '엣지 시작 뒤 조사 없음');
  assert.equal(J.judgeOnefsDetach({ ...base, isidu: { at: 1, status: { targets: 2, version: '2.950.0', poller: {} } } }).state, 'pending', '옛 엣지(lastRuns 없음)');
  assert.equal(J.judgeOnefsDetach({ ...base, isidu: { at: 1, status: { targets: 0, poller: { lastRuns: [] } } } }).state, 'na', '대상 없음');
  assert.equal(J.judgeOnefsDetach({ ...base, isidu: null }).state, 'na', '상태를 보내지 않는 엣지');
  assert.equal(J.judgeOnefsDetach({ ...base, site: false, isidu: null }).state, 'na');
  assert.equal(J.judgeOnefsDetach({ ...base, agent: '', isidu: null }).state, 'pending');
  assert.equal(J.judgeOnefsDetach({ ...base, mock: true, isidu: st([{ mode: 'detached' }]) }).state, 'unknown');
});

test('② 중앙 정제 — 아는 실행 방식만 · 상한 · 문자열 상한', () => {
  const runs = [
    { targetId: 'a', at: 1, mode: 'detached', detach: true, junk: 'x' },
    { targetId: 'b', at: 2, mode: 'rm -rf', detach: true },
    { targetId: 'c', at: 3, mode: 'attached-fallback', fallback: 'y'.repeat(5_000) },
    'str', null, [],
    ...Array.from({ length: 40 }, (_, i) => ({ targetId: `t${i}`, at: i, mode: 'detached' })),
  ];
  const s = IE.sanitizeIsiduStatus({ poller: { lastRuns: runs } });
  const lr = s.poller.lastRuns;
  assert.ok(lr.length <= 20);
  assert.deepEqual(lr[0], { targetId: 'a', at: 1, mode: 'detached', detach: true }, '모르는 키는 버린다');
  assert.ok(!lr.some((r) => r.mode === 'rm -rf'), '모르는 실행 방식은 버린다');
  assert.ok(lr[1].fallback.length <= 200);
  assert.deepEqual(IE.sanitizeIsiduStatus({ poller: { lastRuns: 'x' } }).poller.lastRuns, []);
});

test('③ 엣지 — 폴러 상태 · push 상태 본문이 lastRuns 를 싣는다', async () => {
  const P = await import('../src/isidu/poller.js');
  assert.ok(Array.isArray(P.isiduPollerStatus().lastRuns));
  const src = fs.readFileSync(path.join(SRC, 'isidu/push.js'), 'utf8');
  assert.match(src, /lastRuns: p\.lastRuns \|\| \[\]/);
  const pl = fs.readFileSync(path.join(SRC, 'isidu/poller.js'), 'utf8');
  assert.match(pl, /if \(rec\.runMode\) \{/);
});

test('④ 표 — 항목 다섯 · 실제 라우트에 isiduOf 연결', () => {
  const out = J.buildFieldChecks({
    registry: [{ id: 'vc-pl', name: 'PL', collectMode: 'site' }],
    agentOf: () => 'edge-pl',
    isiduOf: (a) => (a === 'edge-pl' ? st([{ targetId: 'a', at: 1, mode: 'detached', detach: true }]) : null),
  });
  assert.equal(J.FIELD_CHECKS.length, 5);
  assert.equal(out.rows[0].cells['onefs-detach'].state, 'confirmed');
  assert.equal(out.total, 5);
  const route = fs.readFileSync(path.join(SRC, 'routes/api/portalCheck.js'), 'utf8');
  assert.match(route, /isiduOf: \(agent\) => safe\(\(\) => isiduEdgeStatus\(agent\), null\)/);
});

test('⑤ Bareos 늦은 회신 미반영은 감사 로그에도 남는다', async () => {
  const L = await import('../src/bareos/lateReplies.js');
  const A = await import('../src/audit.js');
  L.lateRunJob('no-such-target', {})({ ok: true, value: 4242 });
  await new Promise((r) => setTimeout(r, 50));
  const list = A.listAudit({ limit: 20, q: '늦은 회신 미반영' });
  const items = list.items || list.rows || list;
  assert.ok(JSON.stringify(items).includes('4242'), JSON.stringify(list).slice(0, 300));
});
