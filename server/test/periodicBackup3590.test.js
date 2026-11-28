/**
 * v3.59 정기 점검 보고 3절 '백업 성공 · 실패 현황'(설계 docs/design/periodic-report §9 · 컨펌 ④ 넣기 · ⑤ 연속 실패만 이상).
 *   2026-11-28 다섯 축 점검(보안 · 판정 · 엣지 · 화면 · 성능) 뒤 다시 설계한 부분 — 기록형 '다 봤다' 판정(완결 시작점 · 대조 창) · 복제 실행 위치 ·
 *   실행 중복 · 알았음 줄 · 앞 기간 견주기 · 확정 대기 · 범위 수 — 을 결함마다 재현으로 고정한다(점검 기록 docs/design/periodic-report/README.md §9.6).
 *  ① 결과 글자 → 상태  ② 관측(신선 · 잘린 조회 · 완결 시작점 · 복제 법인 묶음)  ③ 틈 · 확정 판정(lossy)  ④ 마지막 결과 · 연속 실패(중복) · 판정
 *  ⑤ 3절 조립(알았음 줄 · 앞 기간 표지 · 확정 대기 · 법인별 실패 수 · 상한의 법인 몫 · 지금 실패 모름)  ⑥ 범위 · 가림 · 행렬
 *  ⑦ DB 끝에서 끝까지(Veeam · Bareos 짧은 끊김 채움 · 긴 끊김은 확인 불가 · 복제 30회 · 기다림 · 다시 확정 · 큰 첫 관측 · 정리)
 *  ⑧ 설정(객체 주기 400)  ⑨ 리더(실제 공급자 모양 · Director 모름 · 실제 복제 저장소 · 엣지 보고)  ⑩ HTML · 메일 · 채널  ⑪ 실제 api
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });
const TMP = tmpDir('periodic3590-');
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'false' });
delete process.env.CENTRAL_URL; delete process.env.CENTRAL_TOKEN;
// 복제 실행 위치 판정(⑨-2)용 — 중앙 직접 vcL · 엣지 위임 vcS(담당 edge-a)
fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: 'vcL', name: 'Local', host: 'https://10.0.0.1' },
  { id: 'vcS', name: 'Site', host: 'https://10.0.0.2', collectMode: 'site', remoteAgent: 'edge-a' },
] }));

const L = await import('../src/periodic/backupLedger.js');
const S = await import('../src/periodic/backupStore.js');
const SV = await import('../src/periodic/backupService.js');
const R = await import('../src/periodic/rules.js');
const RD = await import('../src/periodic/render.js');
const { READERS } = await import('../src/periodic/readers/index.js');
const { setPeriodicProvider } = await import('../src/periodic/providers.js');
const { dayIndex, dayStartMs } = await import('../src/util/dayKey.js');

const H = 3_600_000;
const DAY = 86_400_000;
// 기준 시각 — 실제 시각에서 날 경계로 떨어뜨려 고정(docs/rules/common.md — Date.now() 직접 · 고정 epoch 둘 다 깨진다)
const D = dayIndex(Date.now()) - 12;
const T0 = dayStartMs(D);
const helpers = { dayOf: (t) => dayIndex(t), dayStartOf: (d) => dayStartMs(d) };

test('① 결과 글자 → 상태(Summary 와 같은 갈래)', () => {
  assert.equal(L.veeamStateOf('Success'), 'ok');
  assert.equal(L.veeamStateOf('Warning'), 'warn');
  assert.equal(L.veeamStateOf('Failed'), 'fail');
  assert.equal(L.veeamStateOf('None'), null);
  assert.equal(L.bareosStateOf('T'), 'ok');
  assert.equal(L.bareosStateOf('W'), 'warn');
  assert.equal(L.bareosStateOf('E'), 'fail');
  assert.equal(L.bareosStateOf('f'), 'fail');
  assert.equal(L.bareosStateOf('A'), 'fail', '취소는 실패');
  assert.equal(L.bareosStateOf('R'), null, '실행 중은 끝난 결과가 아니다');
  assert.equal(L.cloneStateOf({ ok: true }), 'ok');
  assert.equal(L.cloneStateOf({ ok: false }), 'fail');
  assert.equal(L.cloneStateOf({ ok: true, kind: 'restore' }), null, '복원은 백업 결과가 아니다');
  assert.equal(L.cloneStateOf({ ok: false, skipped: 'busy' }), null, '돌지 않은 건너뜀은 세지 않는다');
  assert.equal(L.cloneStateOf({ ok: false, skipped: 'restart-interrupted' }), 'fail', '재시작에 끊긴 실행은 실패');
  assert.equal(L.cloneStateOf(null), null);
  assert.equal(L.BAREOS_WINDOW_MS, 36 * H, '대조 창 2일 - 여유 12시간');
});

test('② 관측 — 신선 · 잘린 조회 · 완결 시작점 · 복제 법인 묶음', () => {
  const now = T0 + 10 * H;
  const { obs, seen } = L.observeOf({
    now,
    vcs: [
      { id: 'a', veeam: { state: 'ok', at: now - 60_000, vms: [
        { id: 'vm1', name: 'one', lr: 'Success', lrt: T0 + H },
        { id: 'vm2', name: 'two', lr: 'Failed', lrt: T0 + 2 * H, msg: 'raw secret path', msgPub: 'public text' },
        { id: 'vm3', name: 'three', lr: 'None', lrt: null },
        { id: 'vm4', name: 'future', lr: 'Success', lrt: now + 2 * H },
      ] } },
      { id: 'b', veeam: { state: 'stale', at: now - 5 * H, vms: [{ id: 'x', lr: 'Success', lrt: T0 + H }] } },
      { id: 'c', veeam: { state: 'unlinked', at: now, vms: [] } },
      { id: 'd', bareos: { mapped: true, resultsKnown: true, at: now, jobs: [
        { vmId: 'bv1', vmName: 'b-one', full: true, oldestAt: T0 - 3 * DAY, runs: [{ jobid: 5, status: 'T', endedAt: T0 + H }, { jobid: 5, status: 'T', endedAt: T0 + H }, { jobid: 6, status: 'A', endedAt: T0 + 3 * H, msg: 'canceled' }] },
        { vmId: 'bv2', enabled: false, epoch: T0 - DAY, runs: [] },
        { vmId: 'bv3', missing: true, runs: [] },
      ] } },
      { id: 'e', bareos: { mapped: false, jobs: [{ vmId: 'z', runs: [{ jobid: 1, status: 'T', endedAt: T0 }] }] } },
      { id: 'f', bareos: { mapped: true, resultsKnown: false, at: now, jobs: [] } },
      { id: 'g2', bareos: { mapped: true, resultsKnown: true, partial: true, at: now, jobs: [] } },
      { id: 'h2', bareos: { mapped: true, resultsKnown: true, at: now, jobs: [{ vmId: 'q', full: true, oldestAt: null, runs: [] }] } },
    ],
    clones: [
      { vc: 'g', key: 'job:1', name: 'j1', at: now - H, target: true, runs: [{ at: T0 + H, ok: true }, { at: T0 + 2 * H, ok: false, detail: 'nfs full' }, { at: T0 + 2 * H, ok: false }] },
      { vc: 'g', key: 'job:2', name: 'j2', at: now - 2 * H, target: true, full: true, oldestAt: T0 - 5 * DAY, runs: [] },
      { vc: 'h', key: 'job:3', name: 'j3', at: 0, target: false, runs: [{ at: T0 + H, ok: true }] },
    ],
  });
  const ofVc = (vc, p) => seen.find((s) => s.vc === vc && s.product === p);
  assert.deepEqual(obs.filter((o) => o.vc === 'a').map((o) => [o.vm, o.state]), [['vm1', 'ok'], ['vm2', 'fail']], 'None · 미래 시각은 관측이 아니다');
  const f2 = obs.find((o) => o.vm === 'vm2');
  assert.equal(f2.reason, 'raw secret path'); assert.equal(f2.reasonPub, 'public text');
  assert.equal(ofVc('a', 'veeam').fresh, true); assert.equal(ofVc('a', 'veeam').horizon, null, 'Veeam 은 완결 시작점이 아니라 시간 틈으로 가른다');
  assert.deepEqual(ofVc('a', 'veeam').targets, ['vm1', 'vm2', 'vm3', 'vm4']);
  assert.equal(ofVc('b', 'veeam').fresh, false, '읽기 상태가 ok 가 아니면 오래됨');
  assert.equal(ofVc('c', 'veeam'), undefined, '연동 없음은 관측 범위도 없다');
  assert.deepEqual(obs.filter((o) => o.vc === 'd').map((o) => [o.vm, o.runId, o.state]), [['bv1', '5', 'ok'], ['bv1', '6', 'fail']], '같은 jobid 는 한 번 · 취소는 실패');
  assert.deepEqual(ofVc('d', 'bareos').targets, ['bv1'], '꺼진 잡 · Director 에 없는 잡은 대상 밖');
  assert.equal(ofVc('d', 'bareos').horizon, T0 - DAY, '완결 시작점 = 잡마다(가득 찬 보기의 가장 오래된 실행 · 기록 새로 시작한 시각) 중 가장 늦은 것');
  assert.equal(ofVc('d', 'bareos').windowMs, L.BAREOS_WINDOW_MS);
  assert.equal(ofVc('e', 'bareos'), undefined, '연결되지 않은 Director 는 관측하지 않는다');
  assert.equal(ofVc('f', 'bareos').fresh, false, '결과를 모르면 오래됨');
  assert.equal(ofVc('g2', 'bareos').fresh, false, '잘린 조회(partial)는 신선하지 않다');
  assert.equal(ofVc('h2', 'bareos').horizon, Infinity, '가득 찬 보기인데 가장 오래된 시각을 모르면 다 봤다고 말하지 않는다');
  assert.equal(ofVc('g', 'clone').fresh, true);
  assert.equal(ofVc('g', 'clone').dataAt, now - 2 * H, '법인의 복제 데이터 시각은 가장 늦은 출처 기준(가장 이른 시각)');
  assert.equal(ofVc('g', 'clone').horizon, T0 - 5 * DAY, '30회가 찬 잡은 가장 오래된 기록 앞을 모른다');
  assert.equal(obs.filter((o) => o.vc === 'g').length, 2, '같은 시각의 기록은 한 번');
  assert.equal(ofVc('h', 'clone').fresh, false, '지금 보고가 없는 출처(at 0)가 있으면 그 법인은 오래됨');
  assert.equal(L.jobHorizon({ full: false }), -Infinity, '보기가 가득 차지 않았고 새로 시작한 적 없으면 처음부터 다 있다');
  assert.equal(L.jobHorizon({ full: false, epoch: 5 }), 5);
});

test('③ 틈 · 확정 판정 — 잃은 틈(lossy)이 하나라도 걸치면 확인 불가', () => {
  const seg = (p, a, o) => L.coverSegments(p, a, { ...helpers, ...o });
  assert.deepEqual(seg(null, T0 + 2 * H, { product: 'veeam' }), { advance: true, segs: [[D, 2 * H, false]] }, '첫 관측은 그날 00시부터 틈');
  assert.equal(seg(null, T0 + 4 * H, { product: 'veeam' }).segs[0][2], true, '첫 관측이 3시간 넘어 늦으면 그날 Veeam 은 잃은 틈');
  assert.deepEqual(seg(T0 + 2 * H, T0 + 2 * H, { product: 'veeam' }), { advance: false, segs: [] }, '같은 읽기는 아무것도 바꾸지 않는다');
  assert.deepEqual(seg(T0 + 3 * H, T0 + 2 * H, { product: 'veeam' }), { advance: false, segs: [] }, '시계가 뒤로 가도 바꾸지 않는다');
  assert.deepEqual(seg(T0 + 23 * H, T0 + 25 * H, { product: 'veeam' }).segs, [[D, 2 * H, false], [D + 1, 2 * H, false]], '날을 걸친 틈은 두 날 모두에');
  const b = { product: 'bareos', windowMs: L.BAREOS_WINDOW_MS };
  assert.deepEqual(seg(T0 + 10 * H, T0 + 10 * H + 600_000, { ...b, horizon: T0 - DAY }).segs, [[D, 600_000, false]], '평상 관측 — 잃은 것 없음');
  const out = seg(T0 + 22 * H, T0 + 3 * DAY + 10 * H, { ...b, horizon: T0 - DAY }).segs;
  assert.deepEqual(out.map((x) => [x[0] - D, x[2]]), [[0, true], [1, true], [2, false], [3, false]], '3일 끊김 — 대조 창(36시간) 밖 날은 잃은 틈 · 안쪽 날은 그대로');
  const ev = seg(T0 + 22 * H, T0 + 2 * DAY + H, { ...b, horizon: T0 + DAY + 12 * H }).segs;
  assert.deepEqual(ev.map((x) => [x[0] - D, x[2]]), [[0, true], [1, true], [2, false]], '보기에서 밀려난 실행(완결 시작점이 그날 안) — 그날까지 잃은 틈');
  assert.equal(seg(T0 + H, T0 + 2 * H, { product: 'clone', horizon: null }).segs[0][2], true, '완결 시작점을 모르면 잃은 틈(지어내지 않는다)');
  assert.equal(seg(T0 + H, T0 + 20 * H, { product: 'clone', horizon: -Infinity }).segs[0][2], false, '복제는 대조 창이 없다 — 기록이 다 있으면 긴 틈도 잃지 않음');
  const end = dayStartMs(D + 1);
  const base = { day: D, dayEnd: end, firstDay: D };
  assert.equal(L.sealStatus({ ...base, product: 'veeam', firstDay: D + 1, cursorAt: end + H, seenRow: { maxGap: H } }), null, '적재 시작 전 날은 확정하지 않는다');
  assert.equal(L.sealStatus({ ...base, product: 'veeam', cursorAt: end + H, seenRow: { maxGap: H, lossy: false } }), 'known');
  assert.equal(L.sealStatus({ ...base, product: 'veeam', cursorAt: end + H, seenRow: { maxGap: L.VEEAM_GAP_MAX_MS + 1, lossy: false } }), 'unknown', '옛 줄(lossy 없이)도 틈 한도로');
  assert.equal(L.sealStatus({ ...base, product: 'veeam', cursorAt: end - 1, seenRow: { maxGap: H } }), 'unknown', '날이 끝난 뒤 한 번 더 봐야 안다');
  assert.equal(L.sealStatus({ ...base, product: 'bareos', cursorAt: end, seenRow: { maxGap: 600_000, lossy: false } }), 'known');
  assert.equal(L.sealStatus({ ...base, product: 'bareos', cursorAt: end, seenRow: { maxGap: 600_000, lossy: true } }), 'unknown', '기록형도 잃은 틈이면 확인 불가(예전 판은 known — 세 축 재현)');
  assert.equal(L.sealStatus({ ...base, product: 'bareos', cursorAt: end, seenRow: null }), 'unknown', '그날을 덮은 틈이 없으면 모름');
  assert.equal(L.sealStatus({ ...base, product: 'clone', cursorAt: end + DAY, seenRow: { maxGap: null } }), 'unknown', '틈을 모르면(0 이 아니다) 확인 불가');
});

test('④ 그날 마지막 결과 · 연속 실패(같은 실행 한 번) · 판정', () => {
  const { counts, last } = L.sealCounts([
    { vm: 'a', endedAt: 1, state: 'fail' }, { vm: 'a', endedAt: 5, state: 'ok' },
    { vm: 'b', endedAt: 3, state: 'warn' }, { vm: 'c', endedAt: 4, state: 'fail' }, { vm: 'c', endedAt: 2, state: 'ok' }, { vm: 'd', endedAt: 9, state: 'bogus' },
  ], ['a', 'b', 'c', 'x', 'y']);
  assert.deepEqual(counts, { targets: 5, ended: 3, ok: 1, warn: 1, fail: 1, norun: 2 });
  assert.deepEqual(last.map((o) => [o.vm, o.state]).sort(), [['a', 'ok'], ['b', 'warn'], ['c', 'fail']]);
  assert.equal(L.failStreak([{ endedAt: 1, state: 'ok' }, { endedAt: 3, state: 'fail' }, { endedAt: 2, state: 'fail' }]), 2);
  assert.equal(L.failStreak([{ endedAt: 3, state: 'fail' }, { endedAt: 2, state: 'ok' }, { endedAt: 3, state: 'fail' }]), 1, 'lastRun 과 기록에 겹친 같은 실행은 한 번(판정 축 F1)');
  assert.equal(L.failStreak([{ endedAt: 3, state: 'warn' }, { endedAt: 2, state: 'fail' }]), 0, '경고는 실패가 아니다');
  assert.equal(L.failStreak([{ endedAt: null, state: 'fail' }]), 0);
  assert.equal(L.backupJudge({}), 'ok');
  assert.equal(L.backupJudge({ failNow: 1 }), 'warn', '한 번 실패는 주의(컨펌 ⑤)');
  assert.equal(L.backupJudge({ failNow: 1, failRepeat: 1 }), 'crit');
  assert.equal(L.backupJudge({ rpo3: 1 }), 'warn');
  assert.equal(L.backupJudge({ rpo7: 1 }), 'crit');
  assert.equal(L.backupJudge({ unknown: true }), 'unknown');
  assert.equal(L.backupJudge({ unknown: true, failNow: 1 }), 'warn', '확인 불가가 아는 실패를 덮지 않는다');
  assert.equal(L.rateOf({ e: 0, ok: 0, w: 0 }), null);
  assert.equal(L.rateOf({ e: 4000, ok: 3990, w: 2 }), 99.8);
});

/* ── ⑤ 3절 조립 ── */
const dayRows = [
  { day: D, product: 'veeam', vc: 'a', status: 'known', targets: 10, ended: 9, ok: 7, warn: 1, fail: 1, norun: 1 },
  { day: D + 1, product: 'veeam', vc: 'a', status: 'known', targets: 10, ended: 10, ok: 8, warn: 0, fail: 2, norun: 0 },
  { day: D, product: 'bareos', vc: 'a', status: 'known', targets: 4, ended: 4, ok: 4, warn: 0, fail: 0, norun: 0 },
  { day: D, product: 'veeam', vc: 'b', status: 'unknown', targets: null, ended: null, ok: null, warn: null, fail: null, norun: null },
  { day: D + 1, product: 'veeam', vc: 'b', status: 'known', targets: 5, ended: 5, ok: 4, warn: 0, fail: 1, norun: 0 },
  { day: D + 1, product: 'clone', vc: 'c', status: 'known', targets: 2, ended: 2, ok: 2, warn: 0, fail: 0, norun: 0 },
];
const vmRows = [
  { day: D, product: 'veeam', vm: 'vm1', vc: 'a', state: 'fail', name: 'one', endedAt: T0 + H, reason: 'raw one', reasonPub: 'pub one' },
  { day: D + 1, product: 'veeam', vm: 'vm1', vc: 'a', state: 'fail', name: 'one', endedAt: T0 + DAY + H, reason: 'raw one b', reasonPub: 'pub one b' },
  { day: D + 1, product: 'veeam', vm: 'vm2', vc: 'a', state: 'fail', name: 'two', endedAt: T0 + DAY + 2 * H, reason: 'raw two', reasonPub: null },
  { day: D + 1, product: 'veeam', vm: 'vb', vc: 'b', state: 'fail', name: 'bee', endedAt: T0 + DAY + 4 * H, reason: 'raw b', reasonPub: 'pub b' },
];
const prevDayRows = [
  { day: D - 2, product: 'veeam', vc: 'a', status: 'known', targets: 10, ended: 10, ok: 10, warn: 0, fail: 0, norun: 0 },
  { day: D - 1, product: 'veeam', vc: 'a', status: 'known', targets: 10, ended: 10, ok: 9, warn: 0, fail: 1, norun: 0 },
];
const strips = new Map([['veeam|vm1', [{ day: D, state: 'fail' }, { day: D + 1, state: 'fail' }]]]);
const sec = L.buildBackupSection({
  days: [D, D + 1], prevDays: [D - 2, D - 1], dayRows, vmRows, prevDayRows, strips,
  vmFacts: new Map([['veeam|vm1', { streak: 3, lastOkAt: T0 - DAY }], ['veeam|vm2', { streak: 1, lastOkAt: T0 }]]),
  now: [{ vc: 'a', product: 'veeam', vm: 'vm1', name: 'one' }, { vc: 'b', product: 'veeam', vm: 'vb', name: 'bee' }], nowUnknown: ['b|veeam', 'a|clone-x'],
  products: ['veeam', 'bareos', 'clone'], dayLabel: (d) => `d${d - D}`, firstDay: D, asOf: T0 + 2 * DAY,
});

test('⑤ 3절 조립 — 알았음 줄 · 앞 기간 표지 · 지금 실패 모름 · 목록', () => {
  const s = L.backupSummary(sec);
  assert.deepEqual({ t: s.total.t, e: s.total.e, ok: s.total.ok, w: s.total.w, f: s.total.f, n: s.total.n, kd: s.total.kd, ud: s.total.ud },
    { t: 31, e: 30, ok: 25, w: 1, f: 4, n: 1, kd: 5, ud: 1 }, '확인 불가 날의 수는 합계에 넣지 않는다');
  assert.deepEqual(s.days.map((d) => [d.e, d.f, d.u, d.k]), [[13, 1, 1, 2], [17, 3, 0, 3]], 'k = 알았음 줄(확인 불가 줄을 세지 않는다 — 화면 축 M4)');
  assert.deepEqual([s.prev.e, s.prev.f, s.prev.kd, s.prev.sealed, s.prev.days, s.prev.full], [20, 1, 2, 2, 2, true]);
  assert.equal(L.prevComparable(s), false, '이번 기간에 확인 불가 줄(b 하루)이 있으면 부분 합이라 견주지 않는다(반증 F6)');
  const clean = L.backupSummary(L.buildBackupSection({ days: [D, D + 1], prevDays: [D - 2, D - 1], dayRows: dayRows.filter((r) => r.vc === 'a'), vmRows, prevDayRows, products: ['veeam', 'bareos'] }));
  assert.equal(L.prevComparable(clean), true, '두 기간 다 확정 · 확인 불가 없음 — 견준다');
  const prevUnk = L.backupSummary(L.buildBackupSection({ days: [D, D + 1], prevDays: [D - 2, D - 1], dayRows: dayRows.filter((r) => r.vc === 'a'), vmRows, prevDayRows: [...prevDayRows, { day: D - 1, product: 'veeam', vc: 'q', status: 'unknown' }], products: ['veeam', 'bareos'] }));
  assert.equal(L.prevComparable(prevUnk), false, '앞 기간에 확인 불가가 있어도 견주지 않는다');
  assert.equal(s.failNow, 1, '지금 결과를 다 읽지 못한 법인(b)은 지금 실패를 부분 합으로 세지 않는다 · 실지 않은 백업의 모름(a|clone-x)은 a 를 빼지 않는다(반증 F7)');
  assert.equal(s.nowPartial, 1);
  assert.equal(s.repeatVms, 1); assert.equal(s.fails, 3);
  assert.deepEqual(s.coverage, { sealed: 2, days: 2, firstDay: D, full: true });
  const rows = sec.corps.map((c) => L.backupCorpRow(c, sec.products, sec.nowOk));
  const a = rows.find((r) => r.vc === 'a'); const b = rows.find((r) => r.vc === 'b'); const c = rows.find((r) => r.vc === 'c');
  assert.deepEqual([a.e, a.f, a.failDays, a.repeatVms, a.failNow, a.unknownDays, a.prev.kd, a.prev.f], [23, 3, 2, 1, 1, 0, 2, 1]);
  assert.equal(b.failNow, null, '지금 결과 모름 — 0 이 아니라 모름');
  assert.equal(c.prev.kd, 0, '앞 기간을 모르는 법인은 kd 0 — 화면이 0 대신 —(판정 축 F5)');
  assert.deepEqual(sec.fails.map((x) => [x.vm, x.failDays, x.streak]), [['vm1', 2, 3], ['vm2', 1, 1], ['vb', 1, null]]);
  assert.deepEqual(sec.repeat[0].strip, ['fail', 'fail']);
  const half = L.backupSummary(L.buildBackupSection({ days: [D, D + 1], prevDays: [D - 2, D - 1], dayRows, vmRows, prevDayRows: prevDayRows.slice(1), products: ['veeam'] }));
  assert.deepEqual([half.prev.sealed, half.prev.full], [1, false]); assert.equal(L.prevComparable(half), false, '앞 기간 일부 날만 — 견주지 않는다(판정 축 F6)');
  const blind = L.backupSummary(L.buildBackupSection({ days: [D], dayRows, vmRows, products: ['veeam'], nowOk: false, now: [{ vc: 'a', product: 'veeam', vm: 'vm1' }] }));
  assert.equal(blind.failNow, null, '공급자를 못 읽었으면 지금 실패는 모름');
  const pend = L.backupSummary(L.buildBackupSection({ days: [D], dayRows, vmRows, products: ['veeam', 'clone'], pending: [{ product: 'clone', vc: 'z', day: D }, { product: 'veeam', vc: 'a', day: D }] }));
  assert.equal(pend.pending, 1, '실제 줄이 있는 대기는 세지 않는다'); assert.equal(pend.total.ud, 2, 'b 의 확인 불가 + z 의 확정 대기(판정 축 F12)');
  const none = L.buildBackupSection({ days: [D], dayRows, vmRows, products: [] });
  assert.deepEqual(none.products, []); assert.equal(L.backupSummary(none).total.e, 0);
  const many = []; for (let i = 0; i < 1100; i++) many.push({ day: D, product: 'veeam', vm: `big-${i}`, vc: 'big', state: 'fail', name: 'x' });
  for (let i = 0; i < 300; i++) many.push({ day: D, product: 'veeam', vm: `sm-${i}`, vc: 'small', state: 'fail', name: 'y' });
  const cap = L.buildBackupSection({ days: [D], dayRows: [], vmRows: many, products: ['veeam'] });
  assert.equal(cap.failsTotal, 1400); assert.equal(cap.fails.length, 1000);
  assert.ok(cap.fails.filter((x) => x.vc === 'small').length >= 30, '작은 법인도 몫(30줄)은 남는다(판정 축 F3)');
  const sm = L.scopeCutBackup(cap, new Set(['small']));
  assert.equal(sm.failsTotal, 300, '범위로 자른 전체 수는 법인별 수로 다시(잘린 목록에서 세지 않는다)');
  assert.ok(sm.fails.length >= 30);
});

test('⑥ 범위 · 가림 · 행렬 — 자른 수 = 행렬로 다시 센 수 · 전 법인 값 싣지 않음', async () => {
  const allowed = new Set(['b']);
  const cut = L.scopeCutBackup(sec, allowed);
  assert.deepEqual(cut.corps.map((c) => c.vc), ['b']);
  assert.equal(cut.firstDay, null, '적재 시작 날은 전 법인 값 — 범위 판본에 싣지 않는다(보안 축 S-1)');
  assert.equal(cut.sealedDays, 2);
  assert.equal(L.scopeCutBackup(sec, new Set(['c'])).sealedDays, 1, '확정 날 수도 범위로 다시(c 는 하루만)');
  const s = L.backupSummary(cut);
  const m = L.backupFromMatrix(L.backupMatrixOf(sec), allowed);
  assert.deepEqual([m.ended, m.fail, m.unknown, m.known, m.sealed], [s.total.e, s.total.f, s.total.ud, s.total.kd, cut.sealedDays], '보관함 목록(행렬)과 보고서(자른 문서)가 같은 수');
  assert.equal(L.backupFromMatrix(L.backupMatrixOf(sec), new Set(['c'])).sealed, 1);
  const allUnknown = L.buildBackupSection({ days: [D], dayRows: [{ day: D, product: 'veeam', vc: 'q', status: 'unknown' }], vmRows: [], products: ['veeam'] });
  assert.deepEqual(L.backupFromMatrix(L.backupMatrixOf(allUnknown), null), { ended: 0, fail: 0, unknown: 1, known: 0, days: 1, sealed: 1 }, '알았음 줄 0 — 화면은 0 대신 —(화면 축 M5)');
  assert.deepEqual(L.backupMatrixOf({ off: true }), { off: true });
  assert.deepEqual(L.backupFromMatrix({ error: true }, null), { error: true });
  const pub = L.publicBackup(sec);
  assert.equal(pub.fails.find((x) => x.vm === 'vm1').reason, 'pub one b');
  assert.equal(pub.fails.find((x) => x.vm === 'vm2').reason, null, '공개 문구가 없으면 원문으로 채우지 않는다');
  assert.ok(!JSON.stringify(pub).includes('raw '));
  const { backupView } = await import('../src/routes/api/periodicReport.js');
  assert.equal(backupView(sec, true).fails[0].reason, 'raw one b');
  const vUser = backupView(sec, false);
  assert.ok(!JSON.stringify(vUser).includes('raw '));
  assert.equal(vUser.corpRows.find((r) => r.vc === 'b').failNow, null);
  assert.deepEqual(backupView({ off: true, reason: 'x' }, false), { off: true, reason: 'x' });
});

/* ── ⑦ DB 끝에서 끝까지 ── */
// Bareos 보기 — 잡마다 끝난 실행 최근 5건(실제 RECENT_RUNS_VIEW) · 대조는 최근 2일(실제 RECONCILE_RECENT_DAYS)을 흉내 낸다
const bareosJob = (vmId, runsAll, t, { reconcileFrom = -Infinity } = {}) => {
  const fin = runsAll.filter((r) => r.endedAt <= t && r.startedAt >= reconcileFrom).sort((a, b) => a.endedAt - b.endedAt);
  const recent = fin.slice(-5);
  return { vmId, vmName: vmId, full: recent.length >= 5, oldestAt: recent.length ? recent[0].endedAt : null, epoch: null, runs: [...recent.slice(-1), ...recent].map((r) => ({ ...r })) };
};
const daily22 = (fails = new Set()) => { const out = []; for (let d = -3; d < 12; d++) out.push({ jobid: 1000 + d, status: fails.has(d) ? 'E' : 'T', startedAt: T0 + d * DAY + 22 * H, endedAt: T0 + d * DAY + 22.5 * H }); return out; };
const B3 = daily22(new Set([1]));   // D+1 실패
let b3Seen = [];   // b3 원장이 이미 받은 실행(대조가 한 번 받은 실행은 원장에 남는다)
const vcsAt = (t) => {
  const vm2 = t >= T0 + 20 * H ? { id: 'vm2', name: 'two', lr: 'Success', lrt: T0 + 20 * H } : { id: 'vm2', name: 'two', lr: 'Failed', lrt: T0 + 3 * H, msg: 'snap fail', msgPub: 'pub snap' };
  const late = t >= T0 + 29 * H ? [{ id: 'vm4', name: 'late', lr: 'Failed', lrt: T0 + 23.9 * H, msg: 'late raw', msgPub: 'late pub' }] : [];
  const bRuns = [{ jobid: 5, status: 'T', endedAt: T0 + 2 * H }];
  if (t >= T0 + 31 * H) bRuns.push({ jobid: 7, status: 'E', endedAt: T0 + 23 * H });
  const stale = t > T0 + 22 * H && t < T0 + 31 * H;
  // b3 — D+1 06:00 ~ D+4 10:00 Director 결과 모름(인증 정지 등) · 돌아온 뒤 원장은 최근 2일에 시작한 실행만 받는다(판정 축 F2 재현 A)
  const b3down = t > T0 + DAY + 6 * H && t < T0 + 4 * DAY + 10 * H;
  if (!b3down) {
    const from = t >= T0 + 4 * DAY + 10 * H && t < T0 + 4 * DAY + 11 * H ? t - 2 * DAY : -Infinity;
    for (const r of B3) if (r.endedAt <= t && r.startedAt >= from && !b3Seen.includes(r)) b3Seen.push(r);
  }
  return [
    { id: 'v1', veeam: { state: 'ok', at: t, vms: [{ id: 'vm1', name: 'one', lr: 'Success', lrt: T0 + 2 * H }, vm2, { id: 'vm3', name: 'three', lr: 'Success', lrt: T0 - 2 * H }, ...late] } },
    { id: 'v2', veeam: { state: 'ok', at: t >= T0 + 8 * H && t < T0 + 13 * H ? T0 + 8 * H : t, vms: [{ id: 'w1', name: 'w', lr: 'Success', lrt: T0 + H }] } },
    { id: 'b1', bareos: { mapped: true, resultsKnown: !stale, at: t, jobs: [{ vmId: 'bv1', vmName: 'b-one', runs: bRuns }] } },
    { id: 'b2', bareos: { mapped: true, resultsKnown: !stale, at: t, jobs: [{ vmId: 'bw1', vmName: 'b-two', runs: [{ jobid: 15, status: 'T', endedAt: T0 + 2 * H }] }] } },
    { id: 'b3', bareos: { mapped: true, resultsKnown: !b3down, at: t, jobs: [bareosJob('bv3', b3Seen, t)] } },
  ];
};
const clonesAt = (t) => (t <= T0 + 20 * H || t >= T0 + 40 * H ? [{ vc: 'c9', key: 'job:9', name: 'nine', at: t, target: true, runs: [{ at: T0 + 5 * H, ok: true }] }] : []);
async function cap(t) {
  const { obs, seen } = L.observeOf({ vcs: vcsAt(t), clones: clonesAt(t), now: t });
  const r = await S.recordCapture({ obs, seen, now: t });
  assert.ok(r.ok, r.reason);
  const s = await S.sealDue({ now: t, dirty: r.dirty });
  assert.ok(s.ok, s.reason);
  return { r, s };
}
const rowsOf = async (day, now = T0 + 30 * DAY) => {
  const g = await S.ledgerFor({ p0: day, d0: day, d1: day, now });
  return { g, row: (p, vc) => g.dayRows.find((x) => x.product === p && x.vc === vc) || null };
};

test('⑦ DB — 확정 · 짧은 끊김 채움 · 긴 끊김 확인 불가 · 기다림 · 다시 확정 · 소급 없음 · 정리', async () => {
  for (let t = T0 + 0.5 * H; t <= T0 + 27.5 * H; t += H) await cap(t);
  let { g, row } = await rowsOf(D, T0 + 27.6 * H);
  const v1 = row('veeam', 'v1');
  assert.equal(v1.status, 'known', '틈 1시간 · 날 끝 뒤 관측 — 확정');
  assert.deepEqual([v1.targets, v1.ended, v1.ok, v1.warn, v1.fail, v1.norun], [3, 2, 2, 0, 0, 1]);
  assert.equal(row('veeam', 'v2').status, 'unknown', '5시간 틈 — 덮인 결과를 몰라 확인 불가');
  assert.equal(row('veeam', 'v2').ended, null);
  assert.equal(row('bareos', 'b1').status, 'unknown', '날 끝 뒤 신선한 읽기 전 — 일단 확인 불가');
  assert.equal(row('clone', 'c9'), null, '날 끝 뒤 한 번도 보지 못한 법인은 확정하지 않고 기다린다');
  assert.ok(g.pending.some((x) => x.product === 'clone' && x.vc === 'c9' && x.day === D), '기다리는 줄은 확정 대기로 드러난다(판정 축 F12)');
  assert.equal((await S.ledgerFor({ p0: D - 1, d0: D - 1, d1: D - 1 })).dayRows.length, 0, '적재 시작 전 날은 소급하지 않는다');
  assert.equal(g.vmRows.length, 0);

  for (let t = T0 + 28.5 * H; t <= T0 + 31.5 * H; t += H) await cap(t);
  ({ g, row } = await rowsOf(D));
  assert.deepEqual([row('veeam', 'v1').ended, row('veeam', 'v1').fail, row('veeam', 'v1').targets], [3, 1, 4], '늦게 온 결과로 다시 확정');
  assert.deepEqual(g.vmRows.filter((x) => x.product === 'veeam').map((x) => [x.vm, x.reason, x.reasonPub]), [['vm4', 'late raw', 'late pub']]);
  assert.deepEqual([row('bareos', 'b1').status, row('bareos', 'b1').fail], ['known', 1], '9시간 끊김 — 잃은 것이 없으면 늦게 채운다');
  assert.deepEqual([row('bareos', 'b2').status, row('bareos', 'b2').ok], ['known', 1], '새 관측 없이도(늦은 채움 경로)');
  assert.equal(row('veeam', 'v2').status, 'unknown');

  for (let t = T0 + 32.5 * H; t <= T0 + 5 * DAY + 4 * H; t += H) await cap(t);
  ({ row } = await rowsOf(D));
  const c9 = row('clone', 'c9');
  assert.ok(c9 && c9.status === 'known', '돌아온 뒤 기다리던 날을 확정');
  const b3 = async (k) => (await rowsOf(D + k)).row('bareos', 'b3');
  assert.equal((await b3(0)).status, 'known', '끊기기 전 날');
  assert.equal((await b3(1)).status, 'unknown', 'D+1 — 실제로는 실패한 날 · 원장에 들어오지 않았다 → 실행 없음으로 지어내지 않는다(예전 판은 known · 실행 없음 — 판정 축 F2 재현 A)');
  assert.equal((await b3(1)).norun, null);
  assert.equal((await b3(3)).status, 'known', '대조 창 안의 날은 채운다');
  assert.deepEqual([(await b3(3)).ok, (await b3(3)).norun], [1, 0]);
  const again = await S.sealDue({ now: T0 + 5 * DAY + 5 * H });
  assert.equal(again.resealed, 0, '잃은 틈이 있던 날 · Veeam 확인 불가 날은 매 관측 다시 확정하지 않는다');

  const facts = await S.vmFacts(['veeam|vm2', 'veeam|vm4', 'bareos|bv1', 'bogus|x']);
  assert.equal(facts.get('veeam|vm2').streak, 0); assert.equal(facts.get('veeam|vm2').lastOkAt, T0 + 20 * H);
  assert.equal(facts.get('veeam|vm4').streak, 1);
  assert.equal(facts.get('bareos|bv1').streak, 1);
  assert.equal(facts.has('bogus|x'), false);

  const section = await SV.backupSectionFor({ from: T0, to: T0 + DAY, now: T0 + 5 * DAY + 5 * H, settings: R.settingsOf({}), ctx: null });
  const sm = L.backupSummary(section);
  assert.equal(sm.total.f, 2, 'vm4 · bv1');
  assert.equal(sm.total.ud, 1, 'v2 의 Veeam 하루');
  assert.equal(sm.prev.known, false); assert.equal(sm.prev.days, 1);
  assert.equal(section.nowOk, false, '판정 자료 없이 만든 3절 — 지금 실패는 모름');
  assert.equal(sm.failNow, null);
  assert.match(section.days[0].label, /^\d\d-\d\d \([월화수목금토일]\)$/);
  assert.equal((await SV.backupSectionFor({ from: T0, to: T0 + DAY, settings: R.settingsOf({ backup: { ledger: false } }) })).off, true);
  const none = await SV.backupSectionFor({ from: T0, to: T0 + DAY, settings: R.settingsOf({ backup: { products: { veeam: false, bareos: false, clone: false } } }) });
  assert.equal(none.off, true); assert.match(none.reason, /고르지 않았습니다/);
  assert.deepEqual(S.pendingOf([{ product: 'clone', vc: 'gone', first_day: D, sealed_to: D, active_at: T0 + DAY }], [], { d0: D, d1: D + 20, dueDay: D + 20 }).map((x) => x.day - D), [1, 2, 3, 4, 5, 6, 7, 8],
    '오래 안 보인 법인은 없어졌다고 본다(앞으로의 회차에 확인 불가로 남지 않는다)');

  const info0 = await S.backupLedgerInfo();
  assert.ok(info0.obs > 0 && info0.days > 0);
  await S.pruneBackup(400, T0 + (L.RAW_KEEP_DAYS + 7) * DAY);
  const info1 = await S.backupLedgerInfo();
  assert.equal(info1.obs, 0, '관측 원본은 40일 뒤 지운다');
  assert.equal(info1.days, info0.days);
  await S.pruneBackup(92, T0 + 100 * DAY);
  assert.equal((await S.backupLedgerInfo()).days, 0);
});

test('⑦-2 큰 첫 관측(조각 트랜잭션) · 복제 30회 보기(끊긴 동안 밀려난 마지막 결과)', async () => {
  const t = T0 + 30 * DAY + 10 * H;
  const vms = []; for (let i = 0; i < 9_500; i++) vms.push({ id: `bulk-${i}`, name: `b${i}`, lr: i % 50 ? 'Success' : 'Failed', lrt: t - H - i });
  const big = L.observeOf({ now: t, vcs: [{ id: 'vbig', veeam: { state: 'ok', at: t, vms } }] });
  const r = await S.recordCapture({ ...big, now: t });
  assert.ok(r.ok); assert.equal(r.inserted, 9_500, '조각으로 나눠도 전부 넣는다');
  assert.equal((await S.recordCapture({ ...big, now: t + 600_000 })).inserted, 0, '같은 관측은 다시 넣지 않는다(OR IGNORE)');
  const hist = (until) => { const out = []; for (let k = 0; k < 400; k++) { const at = T0 + 31 * DAY + k * H + 1800_000; if (at <= until) out.push({ at, ok: k !== 23 }); } return out.slice(-30); };
  const ct = (t2) => { const h = hist(t2); return [{ vc: 'cs', key: 'job:h', name: 'hourly', at: t2, target: true, full: h.length >= 30, oldestAt: h[0]?.at ?? null, runs: h }]; };
  const run = async (t2) => { const o = L.observeOf({ now: t2, clones: ct(t2) }); const x = await S.recordCapture({ ...o, now: t2 }); assert.ok(x.ok); await S.sealDue({ now: t2, dirty: x.dirty }); };
  for (let t2 = T0 + 31 * DAY + 0.5 * H; t2 <= T0 + 31 * DAY + 12 * H; t2 += H) await run(t2);
  await run(T0 + 33 * DAY + 8 * H);   // 44시간 끊긴 뒤 첫 보고(최근 30회만)
  for (let t2 = T0 + 33 * DAY + 9 * H; t2 <= T0 + 33 * DAY + 12 * H; t2 += H) await run(t2);
  const g = await S.ledgerFor({ p0: D + 31, d0: D + 31, d1: D + 31, now: T0 + 34 * DAY });
  // 밀린 확정 — 포탈이 5일 꺼졌다 켜진 뒤 관측 한 번에 밀린 날을 한꺼번에(한 번에 SEAL_BATCH_DAYS 까지) 확정한다(줄을 잃지 않고 · 다음 관측까지 미루지 않게)
  const z = (t3) => L.observeOf({ now: t3, vcs: [{ id: 'vz', veeam: { state: 'ok', at: t3, vms: [{ id: 'z1', lr: 'Success', lrt: t3 - H }] } }] });
  const z0 = T0 + 40 * DAY + 0.5 * H; const z1 = T0 + 45 * DAY + 4 * H;
  assert.ok((await S.recordCapture({ ...z(z0), now: z0 })).ok);
  const zr = await S.recordCapture({ ...z(z1), now: z1 });
  const zs = await S.sealDue({ now: z1, dirty: zr.dirty });
  assert.ok(zs.sealed >= 5, `밀린 5일을 한 번에 확정(${zs.sealed})`);
  const zg = await S.ledgerFor({ p0: D + 40, d0: D + 40, d1: D + 44, now: z1 });
  assert.deepEqual(zg.dayRows.filter((x) => x.vc === 'vz').map((x) => [x.day - D, x.status]).sort((x, y) => x[0] - y[0]), [[40, 'unknown'], [41, 'unknown'], [42, 'unknown'], [43, 'unknown'], [44, 'unknown']], '꺼진 동안의 Veeam 날은 확인 불가로 · 줄은 다 있다');
  assert.equal(g.dayRows.find((x) => x.vc === 'cs')?.status, 'unknown', '그날 마지막 실패(23:30)가 밀려났을 수 있는 날 — 성공으로 뒤집지 않는다(판정 축 F2 재현 B)');
});

test('⑧ 설정 정규화 — 백업 · 객체 주기는 400(500 아님)', () => {
  const s0 = R.settingsOf({});
  assert.deepEqual(s0.backup.products, { veeam: true, bareos: true, clone: true });
  const now = Date.now();
  assert.equal(R.normalizeSettings({ backup: [] }, null, { now }).field, 'backup');
  assert.equal(R.normalizeSettings({ backup: { kinds: ['yearly'] } }, null, { now }).field, 'backup.kinds');
  assert.equal(R.normalizeSettings({ backup: { kinds: [{ toString: null }] } }, null, { now }).field, 'backup.kinds', '원시값으로 바꿀 수 없는 객체도 400(보안 축 S-2)');
  assert.equal(R.normalizeSettings({ backup: { kinds: [['daily']] } }, null, { now }).field, 'backup.kinds', '배열 안 배열은 글자가 아니다');
  assert.equal(R.normalizeSettings({ items: { veeam: { kinds: [{ toString: null }] } } }, null, { now }).field, 'items.veeam.kinds');
  assert.equal(R.normalizeSettings({ backup: { products: { veeam: 'yes' } } }, null, { now }).field, 'backup.products.veeam');
  assert.equal(R.normalizeSettings({ backup: { ledger: 1 } }, null, { now }).field, 'backup.ledger');
  assert.equal(R.normalizeSettings({ backup: { keepDays: 30 } }, null, { now }).field, 'backup.keepDays');
  assert.equal(R.normalizeSettings({ backup: { keepDays: '' } }, null, { now }).field, 'backup.keepDays', '빈 값은 0 이 아니라 잘못된 값');
  const ok = R.normalizeSettings({ backup: { kinds: ['weekly', 'monthly'], products: { clone: false }, ledger: false, keepDays: 120 } }, null, { now });
  assert.deepEqual(ok.settings.backup, { kinds: ['weekly', 'monthly'], products: { veeam: true, bareos: true, clone: false }, ledger: false, keepDays: 120 });
  assert.deepEqual(R.normalizeSettings({ chat: { enabled: false } }, ok.settings, { now }).settings.backup, ok.settings.backup);
  const doc = { items: [], corps: [], backup: sec };
  assert.deepEqual(R.matrixOf(doc).bk, L.backupMatrixOf(sec));
  assert.deepEqual(R.scopeCutDoc(doc, new Set(['b'])).backup.corps.map((c) => c.vc), ['b']);
});

test('⑨ 리더 — 실제 공급자 모양(lastRun 중복) · Director 모름 · 연속 실패만 이상', async () => {
  const now = T0 + 50 * H;
  const pre = L.observeOf({ now: now - 6 * H, vcs: [{ id: 'x2', veeam: { state: 'ok', at: now - 6 * H, vms: [{ id: 'vb2', lr: 'Failed', lrt: now - 7 * H }] } }] });
  assert.ok((await S.recordCapture({ ...pre, now: now - 6 * H })).ok);
  // 실제 backupObserveData 는 lastRun 이 recentRuns 에도 같은 jobid 로 들어 있는 모양을 낸다(판정 축 F1) — 공급자가 걸러도 리더가 다시 한 번 견딘다
  const dupRuns = [{ jobid: 11, status: 'E', endedAt: now - H }, { jobid: 10, status: 'T', endedAt: now - DAY }, { jobid: 11, status: 'E', endedAt: now - H }];
  setPeriodicProvider('backup-observe', async () => ({
    at: now,
    vcs: [
      { id: 'x1', veeam: { state: 'ok', at: now, vms: [{ id: 'va1', name: 'a', lr: 'Failed', lrt: now - H, lb: now - DAY }, { id: 'va2', lr: 'Success', lrt: now - H, lb: now - H }] } },
      { id: 'x2', veeam: { state: 'ok', at: now, vms: [{ id: 'vb2', name: 'b', lr: 'Failed', lrt: now - H, lb: now - 2 * DAY }] } },
      { id: 'x3', veeam: { state: 'ok', at: now, vms: [{ id: 'vc3', lr: 'Success', lrt: now - 8 * DAY, lb: now - 8 * DAY }] } },
      { id: 'x4', veeam: { state: 'stale', at: now - 9 * H, vms: [{ id: 'vd4', lr: 'Success', lrt: now - H, lb: now - H }] } },
      { id: 'x5', bareos: { mapped: true, resultsKnown: true, state: 'ok', at: now, jobs: [{ vmId: 'bb1', vmName: 'bb', lastOkAt: now - DAY, runs: dupRuns }] } },
      { id: 'x6', bareos: { mapped: true, resultsKnown: false, state: 'auth', at: null, jobs: [{ vmId: 'bc6', lastOkAt: now - 52 * H, runs: [{ jobid: 3, status: 'E', endedAt: now - 52 * H }] }] } },
      { id: 'x7', bareos: { mapped: true, resultsKnown: true, state: 'ok', at: now, jobs: [{ vmId: 'bd7', lastOkAt: now - 8 * DAY, runs: [{ jobid: 4, status: 'E', endedAt: now - H }, { jobid: 2, status: 'f', endedAt: now - DAY }] }] } },
    ],
  }));
  const ctx = { now, cache: new Map(), from: now - DAY, to: now, snap: { vcenters: [], vms: [] } };
  const v = await READERS.veeam(ctx);
  const st = (r, vc) => r.rows.find((x) => x.vc === vc)?.status;
  assert.equal(st(v, 'x1'), 'warn', '한 번 실패는 주의');
  assert.equal(st(v, 'x2'), 'crit', '연속 2회 실패(적재 원본 + 지금)');
  assert.equal(st(v, 'x3'), 'crit', '마지막 성공 7일 넘음');
  assert.equal(st(v, 'x4'), 'unknown');
  const b = await READERS.bareos(ctx);
  assert.equal(st(b, 'x5'), 'warn', '같은 실패가 lastRun · 기록에 겹쳐도 한 번 실패 — 주의(예전 판은 이상 · 판정 축 F1)');
  assert.equal(st(b, 'x6'), 'unknown');
  assert.equal(st(b, 'x7'), 'crit', '연속 2회(실패 · 취소 섞임) · 7일 넘음');
  const facts = await SV.backupFacts(ctx);
  assert.ok(facts.nowUnknown.has('x6|bareos') && facts.nowUnknown.has('x4|veeam'), '모름은 (법인, 백업) 마다');
  assert.ok(!facts.now.some((x) => x.vc === 'x6'), 'Director 결과를 모르는 법인의 옛 실패는 지금 실패가 아니다(판정 축 F4)');
  let calls = 0;
  setPeriodicProvider('backup-observe', async () => { calls += 1; return { at: now, vcs: [] }; });
  const ctx2 = { now, cache: new Map() };
  await READERS.veeam(ctx2); await READERS.bareos(ctx2); await SV.backupFacts(ctx2);
  assert.equal(calls, 1, '회차 하나에 공급자 한 번(ctx.cache)');
});

test('⑨-2 복제 — 실행 위치는 Detail 과 같은 판정 · 엣지 미보고는 모름 · 옛 엣지 보고 무시 · 시각 원본 · 원장 못 읽음', async () => {
  const store = await import('../src/vmclone/store.js');
  const dispatch = await import('../src/vmclone/dispatch.js');
  const { loadVcenterConfig } = await import('../src/config.js');
  setPeriodicProvider('backup-observe', async () => ({ at: Date.now(), vcs: [] }));
  const mk = (vcenterId, vmId) => store.saveJob({ vcenterId, vmId, vmName: vmId, dest: { type: 'datastore', datastoreName: 'ds1' }, schedule: { mode: 'daily', time: '01:00' } });
  const jl = mk('vcL', 'vm-local');
  const js = mk('vcS', 'vm-site');
  // 위임 잡은 9일 전에 만들었다(모르는 동안 '만든 시각부터 7일 넘음' 을 지어내는지 보려고 — 엣지 축 E1 둘째)
  const vf = path.join(TMP, 'vm-clone.json');
  const raw = JSON.parse(fs.readFileSync(vf, 'utf8'));
  for (const j of raw.jobs) if (j.id === js.id) j.createdAt = Date.now() - 9 * DAY;
  fs.writeFileSync(vf, JSON.stringify(raw));
  store._resetForTest();
  store.recordRun(jl.id, { ok: true, detail: '' });
  await new Promise((r) => setTimeout(r, 3));
  store.recordRun(jl.id, { ok: false, detail: 'nfs full' });
  await new Promise((r) => setTimeout(r, 3));
  // 스냅샷 경고 덧붙이기(history:false) — 같은 실행을 다시 적으며 lastRun.at 만 새로 바꾼다(판정 축 F9)
  store.recordRun(jl.id, { ok: false, detail: 'nfs full · 스냅샷 정리 실패', history: false });
  const now = Date.now();
  let f = await SV.backupFacts({ now, cache: new Map() });
  const L1 = f.vcs.get('vcL').clone; const S1 = f.vcs.get('vcS').clone;
  assert.equal(L1.fails[0].streak, 1, '한 번 실패 — lastRun 사본 · 다시 적기를 두 번 세지 않는다');
  assert.equal(S1.unknown, true, '위임 잡인데 담당 엣지가 아직 보고하지 않았다 — 모름(예전 판은 중앙 · 지금 신선 · 실행 없음 — 엣지 축 E1)');
  assert.equal(S1.rpo7, 0, '만든 시각부터 세어 7일 넘음을 지어내지 않는다');
  let c = await READERS['vm-clone']({ now, cache: new Map() });
  assert.equal(c.rows.find((r) => r.vc === 'vcL').status, 'warn', '한 번 실패 = 주의(컨펌 ⑤)');
  assert.equal(c.rows.find((r) => r.vc === 'vcS').status, 'unknown');
  const targets = dispatch.execTargets(loadVcenterConfig().vcenters, []);
  const ahead = now + 15 * 60_000;   // 엣지 시계가 15분 앞섬(E3) — 관측은 원래 시각으로, 미래인 동안은 받지 않는다
  // 옛 담당 엣지(edge-old)가 담당이던 때 올린 보고는 담당이 바뀐 뒤 쓰지 않는다(_edges 는 메모리에 남아 있다 — 엣지 축 E2)
  const oldTargets = dispatch.execTargets(loadVcenterConfig().vcenters.map((v) => (v.id === 'vcS' ? { ...v, remoteAgent: 'edge-old' } : v)), []);
  dispatch.ingestReport('edge-old', dispatch.sanitizeReport({ jobs: [{ id: js.id, lastRun: { at: now - H, ok: false }, history: [{ at: now - H, kind: 'backup', ok: false }] }] }), oldTargets, now);
  assert.ok(dispatch.edgeStateOf('edge-old')?.jobs?.get?.(js.id), '전제 — 옛 엣지 보고가 메모리에 남아 있다');
  f = await SV.backupFacts({ now, cache: new Map() });
  assert.equal(f.vcs.get('vcS').clone.unknown, true, '담당이 아닌 엣지의 보고로 알았다고 하지 않는다');
  dispatch.ingestReport('edge-a', dispatch.sanitizeReport({ jobs: [{ id: js.id, lastRun: { at: now - H, ok: true }, history: [{ at: now - H, kind: 'backup', ok: true }, { at: ahead, kind: 'backup', ok: false }] }] }), targets, now);
  f = await SV.backupFacts({ now, cache: new Map() });
  assert.equal(f.vcs.get('vcS').clone.unknown, false, '지금 담당 엣지가 보고하면 안다');
  const src = L.observeOf({ now, clones: [{ vc: 'vcS', key: `job:${js.id}`, at: now, target: true, runs: [{ at: now - H, ok: true }, { at: ahead, ok: false }] }] });
  assert.equal(src.obs.length, 1, '엣지 시각이 미래면 아직 받지 않는다(수신 시각으로 잘라 보고마다 다른 줄을 만들지 않는다)');
  // 잡 원장을 못 읽으면 '잡 없음'(해당 없음)이 아니라 확인 불가(엣지 축 E4) — 실제 파일 손상
  const file = path.join(TMP, 'vm-clone.json');
  const keep = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '{"jobs": [');
  store._resetForTest();   // 캐시를 비워 다시 읽게(실제로는 재시작 · 첫 로드에서 생긴다)
  try {
    if (store.jobsLoadError()) {
      c = await READERS['vm-clone']({ now, cache: new Map() });
      assert.equal(c.status, 'unknown'); assert.match(c.unknownReason, /읽지 못했습니다/);
    } else assert.fail('잘린 JSON 을 읽기 오류로 보지 않았다 — 이 시험의 전제가 바뀌었다');
  } finally { fs.writeFileSync(file, keep); store._resetForTest(); }
});

test('⑩ HTML · 메일 · 채널 — 절 번호 · 확정 없는 수 — · 단위 · 앞 기간 견주기', () => {
  const base = { id: 'D-x', kind: 'daily', periodLabel: 'x', items: [], corps: [{ vc: 'a', name: 'A' }, { vc: 'b', name: 'B' }, { vc: 'c', name: 'C' }], counts: {}, overall: 'ok', generatedAt: T0 };
  const without = RD.renderReportHtml(base, {});
  assert.match(without, /3\. 법인별 현황/); assert.ok(!without.includes('백업 성공 · 실패 현황'));
  const html = RD.renderReportHtml({ ...base, backup: sec }, {});
  assert.match(html, /3\. 백업 성공 · 실패 현황/); assert.match(html, /4\. 법인별 현황/); assert.match(html, /8\. 확인하지 못한 것/);
  assert.match(html, /확인 불가\(법인 · 백업 · 날\)/, '단위는 법인 · 백업 · 날(판정 축 F10)');
  assert.ok(!/확인 불가\(날\)/.test(html));
  const empty = L.buildBackupSection({ days: [D, D + 1], dayRows: [{ day: D, product: 'veeam', vc: 'a', status: 'unknown' }], vmRows: [], products: ['veeam'] });
  const h2 = RD.renderReportHtml({ ...base, backup: empty }, {});
  assert.match(h2, /끝난 백업 <b>—<\/b>/);
  assert.match(h2, /전부 확인 불가/, '전부 확인 불가인 날은 0 이 아니다(화면 축 M4)');
  assert.match(h2, /실패가 없다는 뜻이 아닙니다/);
  assert.match(RD.backupLine(empty), /확정된 결과가 아직 없습니다/);
  const line = RD.backupLine(sec, (vc) => ({ a: 'A', b: 'B' }[vc] || vc));
  assert.match(line, /실패 4\(확인 불가가 있어 앞 기간과 견주지 않음\)/, '확인 불가가 있으면 견주지 않는다(반증 F6)'); assert.match(line, /\n실패 — A 3 · B 1/);
  const cleanSec = L.buildBackupSection({ days: [D, D + 1], prevDays: [D - 2, D - 1], dayRows: dayRows.filter((r) => r.vc === 'a'), vmRows, prevDayRows, products: ['veeam', 'bareos'] });
  assert.match(RD.backupLine(cleanSec), /실패 3\(앞 기간 1\)/);
  assert.match(line, /법인 1곳은 지금 결과를 못 읽어 뺌/);
  const half = L.buildBackupSection({ days: [D, D + 1], prevDays: [D - 2, D - 1], dayRows, vmRows, prevDayRows: prevDayRows.slice(1), products: ['veeam'] });
  assert.match(RD.backupChat(half), /앞 기간은 적재 1 \/ 2일이라 견주지 않음/, '일부 날만 확정된 앞 기간과 견주지 않는다');
  assert.match(RD.renderReportHtml({ ...base, backup: { v: 2, off: true, reason: '하루 치 적재가 꺼져 있습니다' } }, {}), /하루 치 적재가 꺼져 있습니다/);
  const m = RD.renderMail({ ...base, backup: L.publicBackup(sec) }, { portal: 'P' });
  assert.ok(!m.text.includes('raw '));
});

/* ── ⑪ 실제 api ── */
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const { api } = await import('../src/routes/api.js');
const pdb = await import('../src/periodic/db.js');
async function call(urlPath, { user = { username: 'root', role: 'admin', scope: {} } } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api', api);
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message || err) }));
  const srv = http.createServer(app); const port = await listen(srv);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${urlPath}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    let j = null; try { j = JSON.parse(text); } catch { /* html · xlsx */ }
    return { status: res.status, body: j, text, buf };
  } finally { srv.closeAllConnections?.(); srv.close(); }
}

test('⑪ 실제 api — 보관함 백업 수 · 보고서 3절 · 범위 계정 · 비관리자 가림 · XLSX · 근거 문구', async () => {
  const items = [{ key: 'veeam', axis: 'service', label: 'Veeam 백업 판정', status: 'crit', basis: '법인 3곳 — 이상 1곳 · 주의 1곳 · 정상 1곳 · 잡 57개', value: '전 법인 5,850', rows: [{ vc: 'a', status: 'crit' }, { vc: 'b', status: 'warn', prev: 'ok' }, { vc: 'c', status: 'ok' }] }];
  const doc = { id: 'D-2099-01-01', kind: 'daily', periodFrom: T0, periodTo: T0 + DAY, periodLabel: 'x', generatedAt: Date.now(), status: 'done', items,
    corps: [{ vc: 'a', name: 'A' }, { vc: 'b', name: 'B' }, { vc: 'c', name: 'C' }], counts: R.countsOf(items), overall: R.overallOf(items), corpsTotal: 3, corpsReported: 3, backup: sec };
  assert.ok((await pdb.putRun(doc, R.matrixOf(doc))).ok);
  const admin = { username: 'root', role: 'admin', scope: {} };
  const viewer = { username: 'v', role: 'viewer', scope: {} };
  const scopedUser = { username: 'kr', role: 'operator', scope: { vcenters: ['b'] } };
  const row = (await call('/tools/periodic-report/runs', { user: admin })).body.runs.find((r) => r.id === doc.id);
  assert.deepEqual(row.backup, { ended: 30, fail: 4, unknown: 1, known: 5, days: 2, sealed: 2 });
  const sl = (await call('/tools/periodic-report/runs', { user: scopedUser })).body.runs.find((r) => r.id === doc.id);
  assert.deepEqual(sl.backup, { ended: 5, fail: 1, unknown: 1, known: 1, days: 2, sealed: 2 });
  const one = await call(`/tools/periodic-report/runs/${doc.id}`, { user: scopedUser });
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.run.backup.corpRows.map((c) => c.vc), ['b']);
  assert.equal(one.body.run.backup.summary.total.f, sl.backup.fail, '목록과 보고서가 같은 수');
  assert.equal(one.body.run.backup.firstDay, null);
  const it = one.body.run.items.find((x) => x.key === 'veeam');
  assert.ok(!/57|5,850|3곳/.test(`${it.basis} ${it.value || ''}`), '범위 계정의 근거에 전 법인 수가 없다(보안 축 E-1 — 기존 결함)');
  assert.match(it.basis, /^내 범위 법인 1곳 — 주의 1곳/);
  assert.deepEqual(it.prev, { status: 'ok' }, '직전 판정도 보이는 행으로');
  assert.equal((await call(`/tools/periodic-report/runs/${doc.id}`, { user: admin })).body.run.backup.fails[0].reason, 'raw one b');
  assert.ok(!JSON.stringify((await call(`/tools/periodic-report/runs/${doc.id}`, { user: viewer })).body.run.backup).includes('raw '));
  assert.ok(!(await call(`/tools/periodic-report/runs/${doc.id}/report.html`, { user: viewer })).text.includes('raw '));
  const ExcelJS = (await import('exceljs')).default;
  const xl = await call(`/tools/periodic-report/runs/${doc.id}/export.xlsx`, { user: viewer });
  assert.equal(xl.status, 200);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xl.buf);
  const fsh = wb.getWorksheet('백업 실패'); const csh = wb.getWorksheet('백업 법인별');
  assert.ok(fsh && csh);
  assert.equal(fsh.rowCount - 1, sec.fails.length);
  const txt = []; fsh.eachRow((r) => txt.push(r.values.join('|')));
  assert.ok(!txt.join('\n').includes('raw '));
  const empty = { ...doc, id: 'D-2099-01-02', backup: L.buildBackupSection({ days: [D], dayRows: [{ day: D, product: 'veeam', vc: 'a', status: 'unknown' }], vmRows: [], products: ['veeam'] }) };
  assert.ok((await pdb.putRun(empty, R.matrixOf(empty))).ok);
  const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load((await call(`/tools/periodic-report/runs/${empty.id}/export.xlsx`, { user: admin })).buf);
  const r2 = wb2.getWorksheet('백업 법인별').getRow(2).values;
  assert.ok(r2[3] == null || r2[3] === '', '확정된 날이 없는 법인의 끝난 백업은 빈칸');
  const st = await call('/tools/periodic-report/status', { user: scopedUser });
  assert.deepEqual(Object.keys(st.body.backup || {}).sort(), ['captureMs', 'enabled'], '범위 계정 상태에는 전 법인 적재 수를 싣지 않는다');
  const sa = await call('/tools/periodic-report/status', { user: admin });
  assert.equal(sa.body.backup.captureMs, L.CAPTURE_MS); assert.equal(sa.body.backup.sealLagMs, L.SEAL_LAG_MS);
});

/* ── ⑫ 반증(2026-11-28) 재현 — 결함마다 하나 ── */
test('⑫ 반증 재현 — Veeam 연속 실패는 마지막 성공 뒤만 · 출처 바뀐 틈 · 대상 목록 지어내지 않음 · 범위 근거 · 백업별 모름', async () => {
  // F1 — 실패(관측함) → 성공(관측 못 함 · 공급자 lb 가 앎) → 실패: 연속 1회(주의)이지 2회(이상)가 아니다
  const now = T0 + 70 * DAY;
  const o1 = L.observeOf({ now: now - 5 * DAY, vcs: [{ id: 'xf1', veeam: { state: 'ok', at: now - 5 * DAY, vms: [{ id: 'vf1', lr: 'Failed', lrt: now - 5 * DAY - H }] } }] });
  assert.ok((await S.recordCapture({ ...o1, now: now - 5 * DAY })).ok);
  setPeriodicProvider('backup-observe', async () => ({ at: now, vcs: [
    { id: 'xf1', veeam: { state: 'ok', at: now, vms: [{ id: 'vf1', name: 'f', lr: 'Failed', lrt: now - H, lb: now - DAY }] } },
    { id: 'x8', bareos: { mapped: true, resultsKnown: true, partial: true, state: 'error', at: now, jobs: [{ vmId: 'b8', runs: [{ jobid: 1, status: 'E', endedAt: now - H }] }] } },
    { id: 'x9', bareos: { mapped: true, resultsKnown: true, state: 'ok', at: now, jobs: [{ vmId: 'b9', lastOkAt: now - 4 * DAY, runs: [{ jobid: 1, status: 'T', endedAt: now - 4 * DAY }] }] } },
  ] }));
  const ctx = { now, cache: new Map() };
  const f = await SV.backupFacts(ctx);
  assert.equal(f.vcs.get('xf1').veeam.fails[0].streak, 1, '관측이 빈 동안의 성공(lb)을 넘어 이어 세지 않는다(반증 F1)');
  const v = await READERS.veeam(ctx);
  assert.equal(v.rows.find((r) => r.vc === 'xf1').status, 'warn');
  const b = await READERS.bareos(ctx);
  assert.equal(b.rows.find((r) => r.vc === 'x8').status, 'unknown', '잘린 조회(partial)의 Bareos 결과는 모름');
  assert.ok(f.nowUnknown.has('x8|bareos'));
  assert.equal(b.rows.find((r) => r.vc === 'x9').status, 'warn', 'Bareos 마지막 성공 3일 넘음 = 주의');

  // F5 — 복제 결과 출처가 바뀐 틈(담당 엣지 교대)은 잃은 틈: 옛 엣지가 끝낸 실패를 새 엣지 기록은 모른다
  const dS = D + 50; const s0 = dayStartMs(dS);
  const cs = (t, src, runs) => L.observeOf({ now: t, clones: [{ vc: 'csrc', key: 'job:s', name: 's', at: t, target: true, src, runs }] });
  const capS = async (t, src, runs) => { const x = await S.recordCapture({ ...cs(t, src, runs), now: t }); assert.ok(x.ok); await S.sealDue({ now: t, dirty: x.dirty }); };
  await capS(s0 + 0.5 * H, 'edge:a', [{ at: s0 - H, ok: true }]);
  await capS(s0 + 13 * H, 'edge:b', [{ at: s0 - H, ok: true }]);   // 12:55 뒤 edge-a 가 죽고 13:00 실패 → 13:05 edge-b 로 재배정(그 실패는 edge-b 기록에 없다)
  for (let t = s0 + 14 * H; t <= s0 + DAY + 4 * H; t += H) await capS(t, 'edge:b', [{ at: s0 - H, ok: true }]);
  const gS = await S.ledgerFor({ p0: dS, d0: dS, d1: dS, now: s0 + 2 * DAY });
  assert.equal(gS.dayRows.find((x) => x.vc === 'csrc').status, 'unknown', '출처가 바뀐 날은 확인 불가(예전 판은 알았음 · 성공 — 반증 F5)');
  // 같은 출처면 알았음(통제)
  const dK = D + 52; const k0 = dayStartMs(dK);
  const capK = async (t) => { const x = await S.recordCapture({ ...L.observeOf({ now: t, clones: [{ vc: 'ckeep', key: 'job:k', name: 'k', at: t, target: true, src: 'edge:b', runs: [{ at: k0 + 2 * H, ok: true }] }] }), now: t }); await S.sealDue({ now: t, dirty: x.dirty }); };
  for (let t = k0 + 0.5 * H; t <= k0 + DAY + 4 * H; t += H) await capK(t);
  assert.equal((await S.ledgerFor({ p0: dK, d0: dK, d1: dK, now: k0 + 2 * DAY })).dayRows.find((x) => x.vc === 'ckeep').status, 'known');

  // F3 — 잡이 없던 날(마지막 잡을 지우고 며칠 뒤 새로 만듦)에 새 잡을 대상으로 지어내 '실행 없음' 을 만들지 않는다
  const dT = D + 55; const t0 = dayStartMs(dT);
  const capT = async (t, key) => { const x = await S.recordCapture({ ...L.observeOf({ now: t, clones: key ? [{ vc: 'cnew', key, name: key, at: t, target: true, runs: [] }] : [] }), now: t }); await S.sealDue({ now: t, dirty: x.dirty }); };
  for (let t = t0 + 0.5 * H; t <= t0 + 12 * H; t += H) await capT(t, 'job:old');
  for (let t = t0 + 6 * DAY; t <= t0 + 7 * DAY + 4 * H; t += H) await capT(t, 'job:new');
  const gT = await S.ledgerFor({ p0: dT + 1, d0: dT + 1, d1: dT + 5, now: t0 + 8 * DAY });
  const rowsT = gT.dayRows.filter((x) => x.vc === 'cnew');
  assert.ok(rowsT.length >= 1);
  assert.ok(rowsT.every((x) => x.status !== 'known' || x.norun === 0), `잡이 없던 날에 실행 없음을 지어내지 않는다(반증 F3): ${JSON.stringify(rowsT.map((x) => [x.day - dT, x.status, x.targets, x.norun]))}`);

  // F8 — 범위 판본: 행이 전부 범위 안이어도 전 법인 근거(점검 서버 412대) · 직전 판정을 싣지 않는다
  const cut = R.scopeCutDoc({ items: [{ key: 'disk-bad', axis: 'facility', status: 'crit', basis: '점검 서버 412대 · 새 기록 3', value: '412', prev: { status: 'crit', count: 57 }, rows: [{ vc: 'b', status: 'crit', prev: 'ok' }] }], corps: [] }, new Set(['b']));
  assert.ok(!/412|57/.test(JSON.stringify(cut.items[0])), JSON.stringify(cut.items[0]));
  assert.deepEqual(cut.items[0].prev, { status: 'ok' });
});

test('⑬ 실제 원천 모양 — Bareos 원장 보기(jobDigests) → 관측용 잡 · 복제 30회 가득 참', async () => {
  const REG = await import('../src/bareos/registry.js');
  const job = REG.addJob({ vcenterId: 'vcR', vmId: 'vcR:vm-1', vmName: 'reg-01', dc: 'DC', folder: '/', directorId: 'dir-1', bareosJob: 'pv-r1', client: 'c', storage: 's', pool: 'p', schedule: '', level: 'Incremental', createdBy: 't' });
  const base = T0 + 60 * DAY;
  for (let k = 0; k < 7; k++) REG.applyRunRow(job.id, { jobid: 100 + k, status: k === 6 ? 'E' : 'T', level: 'I', startedAt: base + k * DAY, endedAt: base + k * DAY + H, bytes: 1, files: 1, errors: 0 });
  const dg = REG.jobDigests().find((x) => x.id === job.id);
  assert.ok(dg, '원장 보기에 잡이 있다');
  const view = L.bareosJobView(dg, (id) => (String(id) === '106' ? 'first error line' : ''));
  assert.equal(view.full, true, `보기가 가득 찼다(최근 ${dg.recentRuns.length}건)`);
  assert.equal(view.oldestAt, base + 2 * DAY + H, '가장 오래된 끝난 실행 = 7건 중 최근 5건의 첫째');
  assert.equal(new Set(view.runs.map((r) => r.jobid)).size, view.runs.length, 'lastRun 과 recentRuns 의 같은 jobid 는 한 번(실제 보기 모양)');
  assert.equal(view.runs.find((r) => r.jobid === 106)?.msg, 'first error line');
  assert.equal(view.epoch, null);
  assert.equal(L.jobHorizon(view), base + 2 * DAY + H);
  // 복제 — 기록 30회가 찬 잡은 가득 참 · 가장 오래된 기록 시각을 싣는다(중앙 잡 · 실제 저장소)
  const store = await import('../src/vmclone/store.js');
  const jf = store.saveJob({ vcenterId: 'vcL', vmId: 'vm-full', vmName: 'vm-full', dest: { type: 'datastore', datastoreName: 'ds1' }, schedule: { mode: 'interval', hours: 1 } });
  for (let k = 0; k < 31; k++) store.recordRun(jf.id, { ok: true, detail: '', historyAt: base + k * H });
  const src = (await SV._cloneSourcesForTest(Date.now())).find((x) => x.key === `job:${jf.id}`);
  assert.equal(src.full, true, '30회가 찬 기록');
  assert.equal(src.oldestAt, base + H, '앞 한 회는 밀려났다(가장 오래된 남은 기록)');
  assert.equal(src.src, 'local');
  const lf = (await SV._cloneSourcesForTest(Date.now())).find((x) => x.key === `job:${jf.id}`);
  assert.equal(lf.runs.length, 30, '기록만 센다(lastRun 사본을 더하지 않는다)');
  // Bareos 마지막 성공 3일 넘음 · 복제 마지막 성공 3일 넘음 = 주의(컨펌 ⑤ — 모든 백업 같은 기준)
  const fx = await SV.backupFacts({ now: base + 34 * H + 4 * DAY, cache: new Map() });
  assert.ok(fx.vcs.get('vcL').clone.rpo3 >= 1, '복제 마지막 성공 3일 넘음을 센다');
});

