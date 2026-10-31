/**
 * test/bareosGroupRetention2831.test.js — v2.831 백업 그룹 '보관 개수'(사용자 요청 '백업을 몇 개 저장할 것인지') 판정 · 작업 표 · 엣지 회신.
 *  데이터 삭제 기능이다 — 지우는 범위를 넓히는 변경은 이 시험이 막는다(groupRetention.js 머리말 ①~⑤).
 *  ① pruneSelection(순수): 제한 없음 · N개 이하 · 기준 Full 까지 남김 · Full 없으면 안 지움 · 끝나지 않은 실행·다른 이름·다른 종류 안 지움 · 상한
 *  ② normKeep · keepText
 *  ③ ops.pruneJobs: 다시 읽어 실제로 사라진 것만 · 세션이 끊기면 남은 것은 건너뜀 · 이름 검사 · delete 는 숫자 jobid 만
 *  ④ 엣지 회신 정제: 성공인데 지운 목록이 없으면 결과 모름 · 숫자가 아닌 jobid 버림
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneSelection, normKeep, keepText, keepOtpReasons, PRUNE_MAX_PER_JOB } from '../src/bareos/groupRetention.js';
import { OPS, MUTATING } from '../src/bareos/ops.js';
import { sanitizeEdgeResult } from '../src/bareos/edgeResult.js';
import { RESULT_MS } from '../src/bareos/edgeOps.js';

const R = (jobid, level, status = 'T', extra = {}) => ({ jobid, name: 'pv-a', type: 'B', level, status, startedAt: 1_700_000_000_000 + jobid * 86_400_000, bytes: 5e9, ...extra });

test('① 제한 없음·N개 이하면 아무것도 지우지 않는다', () => {
  const runs = [R(1, 'F'), R(2, 'I'), R(3, 'I')];
  assert.deepEqual(pruneSelection(runs, null, 'pv-a').deletable, []);
  assert.deepEqual(pruneSelection(runs, 3, 'pv-a').deletable, []);
  assert.deepEqual(pruneSelection(runs, 5, 'pv-a').deletable, []);
  assert.deepEqual(pruneSelection([R(1, 'F'), R(2, 'F')], null, 'pv-a').deletable, [], '제한 없음이면 Full 이 여럿이어도 지우지 않는다');
  assert.deepEqual(pruneSelection([R(1, 'F', 'f'), R(2, 'F')], 1, 'pv-a').deletable, [], '성공 복원 지점이 N개 이하면 실패 행도 지우지 않는다');
});

test('① 남기는 가장 오래된 복원 지점의 기준 Full 까지 남긴다(체인을 끊지 않는다)', () => {
  const runs = [R(1, 'F'), R(2, 'I'), R(3, 'I'), R(4, 'F'), R(5, 'I'), R(6, 'I')];
  let s = pruneSelection(runs, 3, 'pv-a');
  assert.deepEqual(s.deletable, [1, 2, 3]);
  assert.equal(s.kept, 3);
  assert.equal(s.baseJobid, 4);
  s = pruneSelection(runs, 2, 'pv-a');   // 가장 오래된 남김 = 5(I) → 기준 Full 4
  assert.deepEqual(s.deletable, [1, 2, 3]);
  assert.equal(s.kept, 3, '체인 때문에 N 보다 많이 남을 수 있다');
  s = pruneSelection(runs, 4, 'pv-a');   // 가장 오래된 남김 = 3(I) → 기준 Full 1 → 지울 것 없음
  assert.deepEqual(s.deletable, []);
  s = pruneSelection(runs, 1, 'pv-a');
  assert.deepEqual(s.deletable, [1, 2, 3]);
  // Differential 도 기준 Full 까지
  s = pruneSelection([R(1, 'F'), R(2, 'D'), R(3, 'F'), R(4, 'D'), R(5, 'I')], 2, 'pv-a');
  assert.deepEqual(s.deletable, [1, 2]);
});

test('① 기준 Full 이 없으면(실패한 Full 은 기준이 아니다) 아무것도 지우지 않는다', () => {
  let s = pruneSelection([R(1, 'I'), R(2, 'I'), R(3, 'I'), R(4, 'I')], 1, 'pv-a');
  assert.deepEqual(s.deletable, []);
  assert.match(s.reason, /기준 Full/);
  s = pruneSelection([R(1, 'F'), R(2, 'I'), R(3, 'F', 'f'), R(4, 'I'), R(5, 'I')], 2, 'pv-a');
  assert.deepEqual(s.deletable, [], '실패한 Full(3)을 기준으로 삼아 1·2 를 지우면 4·5 의 체인이 끊긴다');
  assert.equal(s.baseJobid, 1);
  s = pruneSelection([R(1, 'F', 'E'), R(2, 'I'), R(3, 'I')], 1, 'pv-a');
  assert.deepEqual(s.deletable, []);
});

test('① 끝나지 않은 실행·다른 잡 이름은 지우지 않는다 · 경고(W)도 복원 지점', () => {
  const runs = [R(1, 'F', 'R'), R(2, 'I', 'C'), R(3, 'F', 'T', { name: 'pv-b' }), R(5, 'I', 'f'), R(6, 'F', 'W'), R(7, 'I'), R(8, 'I', 'A')];
  const s = pruneSelection(runs, 1, 'pv-a');
  assert.deepEqual(s.deletable, [5], '끝난 실행(실패 5)만 · 실행 중 1·2, 다른 이름 3 은 남는다');
  assert.equal(s.baseJobid, 6);
  assert.equal(s.good, 2);
});

test('① 반증 F1 — Migration 으로 jobid 순서와 시작 시각 순서가 어긋나면 지우지 않는다(복원 체인은 시작 시각 순)', () => {
  const t = (d) => 1_700_000_000_000 + d * 86_400_000;
  // 1주차 F1 I2 I3 를 Migration — 원본은 type M, 새 B 행 8·9·10 은 1주차 시각 · 2주차 F4 I5 I6 · 그 뒤 I11
  const rows = [
    R(1, 'F', 'T', { type: 'M', startedAt: t(1) }), R(2, 'I', 'T', { type: 'M', startedAt: t(2) }), R(3, 'I', 'T', { type: 'M', startedAt: t(3) }),
    R(4, 'F', 'T', { startedAt: t(8) }), R(5, 'I', 'T', { startedAt: t(9) }), R(6, 'I', 'T', { startedAt: t(10) }),
    R(8, 'F', 'T', { startedAt: t(1) }), R(9, 'I', 'T', { startedAt: t(2) }), R(10, 'I', 'T', { startedAt: t(3) }), R(11, 'I', 'T', { startedAt: t(11) }),
  ];
  assert.deepEqual(pruneSelection(rows, 3, 'pv-a').deletable, [], '이전(M) 행이 있으면 지우지 않는다');
  const noM = rows.filter((r) => r.type === 'B');
  const s = pruneSelection(noM, 3, 'pv-a');
  assert.deepEqual(s.deletable, [], 'M 행이 사라졌어도 시각 순서가 어긋나면 지우지 않는다');
  assert.match(s.reason, /시작 시각 순서/);
});

test('① 반증 F2·F3·F6 — VirtualFull(새 jobid·옛 시각)·복사 행·시각 모름·0 B Full', () => {
  const t = (d) => 1_700_000_000_000 + d * 86_400_000;
  const vf = [R(4, 'I', 'T', { startedAt: t(4) }), R(5, 'I', 'T', { startedAt: t(5) }), R(20, 'F', 'T', { startedAt: t(3) }), R(21, 'I', 'T', { startedAt: t(21) })];
  assert.deepEqual(pruneSelection(vf, 2, 'pv-a').deletable, []);
  assert.deepEqual(pruneSelection([R(1, 'F'), R(2, 'F'), R(3, 'F', 'T', { type: 'C' })], 1, 'pv-a').deletable, [], '복사 행이 있으면 지우지 않는다');
  assert.deepEqual(pruneSelection([R(1, 'F'), R(2, 'F', 'T', { startedAt: null }), R(3, 'F')], 1, 'pv-a').deletable, []);
  assert.deepEqual(pruneSelection([R(1, 'F', 'T', { startedAt: null }), R(2, 'F'), R(3, 'F')], 1, 'pv-a').deletable, [], '시각 모름이 맨 앞이어도');
  // 0 B Full 은 기준이 아니다 — 그 앞의 실제 Full 로 내려가 지울 것이 없다
  assert.deepEqual(pruneSelection([R(1, 'F'), R(2, 'I'), R(3, 'F', 'W', { bytes: 0 }), R(4, 'I')], 2, 'pv-a').deletable, []);
  assert.deepEqual(pruneSelection([R(1, 'F'), R(2, 'I'), R(3, 'F', 'T', { bytes: null }), R(4, 'I')], 2, 'pv-a').deletable, [], '바이트 모름도 기준이 아니다');
  // 실패한 행(시각 모름)은 순서 판정에 넣지 않는다 — 기준 Full 앞이면 지운다
  assert.deepEqual(pruneSelection([R(1, 'F'), R(2, 'I', 'f', { startedAt: null }), R(3, 'F'), R(4, 'I')], 2, 'pv-a').deletable, [1, 2]);
});

test('① 순서 — 입력 순서와 무관(jobid 와 시각이 같은 순서일 때) · 한 번에 지우는 수 상한', () => {
  const shuffled = [R(4, 'F'), R(1, 'F'), R(3, 'I'), R(2, 'I'), R(5, 'I')];
  assert.deepEqual(pruneSelection(shuffled, 1, 'pv-a').deletable, [1, 2, 3]);
  const many = Array.from({ length: PRUNE_MAX_PER_JOB + 30 }, (_, i) => R(i + 1, 'F'));
  const s = pruneSelection(many, 1, 'pv-a');
  assert.equal(s.deletable.length, PRUNE_MAX_PER_JOB);
  assert.equal(s.more, 29);
  assert.equal(s.deletable[0], 1, '오래된 것부터');
});

test('② normKeep · keepText', () => {
  for (const v of [null, undefined, '']) assert.equal(normKeep(v), null);
  assert.equal(normKeep(7), 7);
  assert.equal(normKeep('14'), 14);
  for (const v of [0, 366, 1.5, 'abc', -1, '7x', true, {}]) assert.throws(() => normKeep(v), /보관 개수/, String(v));
  assert.equal(keepText(null), '보관 개수 제한 없음');
  assert.equal(keepText(14), '최근 14회 보관');
});

function fakeSession(hist, { dropDelete = false, dieOn = null } = {}) {
  const cmds = [];
  return {
    cmds,
    async call(cmd) {
      cmds.push(cmd);
      if (dieOn && cmd.includes(dieOn)) { const e = new Error('closed'); e.code = 'closed'; throw e; }
      const m = cmd.match(/^list jobs job=(\S+)/);
      if (m) {
        if (dieOn === 'relist' && cmds.some((c) => c.startsWith('delete'))) { const e = new Error('timeout'); e.code = 'timeout'; throw e; }
        return { jobs: (hist.get(m[1]) || []).map((r) => ({ jobid: r.jobid, name: r.name, type: r.type, level: r.level, jobstatus: r.status, jobbytes: 5e9, starttime: `2026-10-${String(r.jobid % 28 + 1).padStart(2, '0')} 02:10:00` })) };
      }
      const d = cmd.match(/^delete jobid=([\d,]+)$/);
      if (d) { if (!dropDelete) { const ids = new Set(d[1].split(',').map(Number)); for (const [k, v] of hist) hist.set(k, v.filter((r) => !ids.has(r.jobid))); } return {}; }
      throw Object.assign(new Error(`unknown ${cmd}`), { code: 'jsonrpc' });
    },
  };
}

test('③ ops.pruneJobs — 지운 뒤 다시 읽어 실제로 사라진 jobid 만 · 지우지 못한 수 · 세션이 끊기면 남은 것은 건너뜀', async () => {
  const B = (jobid, level, status = 'T') => ({ ...R(jobid, level, status), name: 'pv-b' });
  const hist = new Map([['pv-a', [R(1, 'F'), R(2, 'I'), R(3, 'F'), R(4, 'I')]], ['pv-b', [B(11, 'F'), B(12, 'F')]]]);
  let s = fakeSession(hist);
  let out = await OPS.pruneJobs(s, { items: [{ key: 0, job: 'pv-a', keep: 1 }, { key: 1, job: 'pv-b', keep: 1 }, { key: 2, job: 'bad name', keep: 1 }] });
  assert.deepEqual(out[0].deleted, [1, 2]);
  assert.deepEqual(out[1].deleted, [11]);
  assert.equal(out[2].ok, false);
  assert.ok(s.cmds.includes('delete jobid=1,2'));
  assert.ok(!s.cmds.some((c) => c.includes('bad')), '틀린 이름은 Director 에 보내지 않는다');
  // Director 가 응답만 성공하고 지우지 않음
  const h2 = new Map([['pv-a', [R(1, 'F'), R(2, 'F')]]]);
  out = await OPS.pruneJobs(fakeSession(h2, { dropDelete: true }), { items: [{ key: 0, job: 'pv-a', keep: 1 }] });
  assert.deepEqual(out[0].deleted, []);
  assert.equal(out[0].notDeleted, 1);
  // 세션째 끊김 → 남은 항목 건너뜀
  const h3 = new Map([['pv-a', [R(1, 'F'), R(2, 'F')]], ['pv-b', [B(11, 'F'), B(12, 'F')]]]);
  out = await OPS.pruneJobs(fakeSession(h3, { dieOn: 'delete' }), { items: [{ key: 0, job: 'pv-a', keep: 1 }, { key: 1, job: 'pv-b', keep: 1 }] });
  assert.equal(out[0].ok, false);
  assert.equal(out[1].code, 'skipped');
  // 반증 F4: delete 를 보낸 뒤 다시 읽기가 끊기면 보낸 jobid 를 돌려준다(지웠는지 모름 — 감사에 남긴다)
  // since 를 작업 표가 그대로 넘긴다(등록 전 행은 보내지 않는다)
  const h5 = new Map([['pv-a', [R(1, 'F'), R(2, 'F'), R(3, 'F')]]]);
  const s5 = fakeSession(h5);
  out = await OPS.pruneJobs(s5, { items: [{ key: 0, job: 'pv-a', keep: 1, since: Date.parse('2026-10-03T00:00:00') }] });
  assert.deepEqual(s5.cmds.filter((c) => c.startsWith('delete')), ['delete jobid=2'], `등록(10-03) 전에 시작한 1 은 지우지 않는다: ${s5.cmds.join(' | ')}`);
  const h4 = new Map([['pv-a', [R(1, 'F'), R(2, 'F')]]]);
  out = await OPS.pruneJobs(fakeSession(h4, { dieOn: 'relist' }), { items: [{ key: 0, job: 'pv-a', keep: 1 }] });
  assert.equal(out[0].ok, false);
  assert.deepEqual(out[0].sent, [1]);
  assert.ok(MUTATING.has('pruneJobs'), '가져간 뒤 미회신은 결과 모름(다시 보내지 않음)');
  assert.ok(RESULT_MS.pruneJobs > 0);
});

test('④ 엣지 회신 정제 — 성공인데 지운 목록이 없으면 결과 모름 · 숫자가 아닌 jobid 는 버린다', () => {
  const r = sanitizeEdgeResult('pruneJobs', { ok: true, value: [
    { key: 0, ok: true, deleted: [1, '2', 'x', -3, 4.5], kept: 3, good: 5, baseJobid: 9, baseAt: 1_800_000_000_000 },
    { key: 1, ok: true },
    { key: 2, ok: false, code: 'jsonrpc', message: 'denied' },
    { key: 3, ok: false, code: 'timeout', sent: [7, 'x', 8] },
  ] });
  assert.deepEqual(r.value[3].sent, [7, 8]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value[0].deleted, [1, 2]);
  assert.equal(r.value[0].baseJobid, 9);
  assert.equal(r.value[1].ok, false);
  assert.equal(r.value[1].code, 'unknown');
  assert.equal(r.value[2].message, 'denied');
});

test('⑤ v2.831.1 본인 OTP 판정 — 지울 범위가 넓어지는 저장만(새 그룹·처음 정함·줄임·기존 잡 VM 추가)', () => {
  const g = { keep: 7, vmIds: ['a', 'b'] };
  assert.deepEqual(keepOtpReasons(null, { keep: null, vmIds: ['a'] }), [], '제한 없음 새 그룹은 OTP 없이');
  assert.deepEqual(keepOtpReasons(null, { keep: 14, vmIds: ['a'] }), ['보관 개수(최근 14회)를 정한 새 그룹']);
  assert.deepEqual(keepOtpReasons({ keep: null, vmIds: ['a'] }, { keep: 3, vmIds: ['a'] }), ['보관 개수를 처음 정함(최근 3회)']);
  assert.deepEqual(keepOtpReasons(g, { keep: 3, vmIds: ['a', 'b'] }), ['보관 개수를 줄임(7 → 3회)']);
  assert.deepEqual(keepOtpReasons(g, { keep: 7, vmIds: ['a', 'b'] }), []);
  assert.deepEqual(keepOtpReasons(g, { keep: 9, vmIds: ['a', 'b'] }), [], '늘리기는 OTP 없이');
  assert.deepEqual(keepOtpReasons(g, { keep: null, vmIds: ['a', 'b'] }), [], '제한 없음으로 풀기는 OTP 없이');
  assert.deepEqual(keepOtpReasons(g, { keep: undefined, vmIds: ['a', 'b'] }), [], 'keep 을 보내지 않으면 그대로');
  assert.deepEqual(keepOtpReasons(g, { keep: undefined, vmIds: ['a', 'b', 'c', 'd'] }, (id) => id === 'c'), ['백업 기록이 있을 수 있는 VM 1대를 더함'], '잡 없는 새 VM(d)은 세지 않는다');
  assert.deepEqual(keepOtpReasons(g, { keep: 3, vmIds: ['a', 'c'] }, () => true), ['보관 개수를 줄임(7 → 3회)'], '줄이면 그 까닭 하나로');
  assert.deepEqual(keepOtpReasons({ keep: null, vmIds: [] }, { keep: undefined, vmIds: ['c'] }), [], '제한 없음 그룹에 VM 추가는 OTP 없이');
});

test('⑨ v2.831.1 반증 F1 — 원장 잡 등록 시각(since)보다 먼저 시작한 행·시각 모름은 지우지도 세지도 않는다', () => {
  const t = (d) => 1_700_000_000_000 + d * 86_400_000;
  const rows = [R(1, 'F', 'T', { startedAt: t(1) }), R(2, 'I', 'T', { startedAt: t(2) }), R(3, 'F', 'f', { startedAt: null }),
    R(10, 'F', 'T', { startedAt: t(10) }), R(11, 'I', 'T', { startedAt: t(11) }), R(12, 'F', 'T', { startedAt: t(12) })];
  assert.deepEqual(pruneSelection(rows, 1, 'pv-a').deletable, [1, 2, 3, 10, 11], 'since 가 없으면 예전처럼');
  const s = pruneSelection(rows, 1, 'pv-a', { since: t(9) });
  assert.deepEqual(s.deletable, [10, 11], '등록(9일) 전 행 1·2 와 시각 모름 3 은 지우지 않는다');
  assert.equal(s.good, 3);
  assert.deepEqual(pruneSelection(rows, 2, 'pv-a', { since: t(11) }).deletable, [], '등록 뒤 성공이 2개뿐이면 지우지 않는다');
});
