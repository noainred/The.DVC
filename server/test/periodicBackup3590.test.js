/**
 * v3.59 정기 점검 보고 3절 '백업 성공 · 실패 현황'(설계 docs/design/periodic-report §9 · 컨펌 ④ 넣기 · ⑤ 연속 실패만 이상).
 *  ① 결과 글자 → 상태 — Veeam · Bareos(취소 = 실패) · 복제(복원 · 건너뜀 제외 · 재시작에 끊김 = 실패)
 *  ② 관측 — 신선 / 오래됨 · 연동 없음 제외 · 미래 시각 제외 · 같은 jobid 한 번 · 꺼진 잡은 대상 밖 · 복제 법인 묶음(늦은 출처가 있으면 오래됨)
 *  ③ 관측 범위 · 확정 판정 — 첫 관측은 그날 00시부터 틈 · 같은 읽기는 무시 · 적재 전 날 null · Veeam 은 날 끝 뒤 + 틈 한도 · 기록형은 날 끝 뒤 한 번
 *  ④ 그날 마지막 결과 · 실행 없음 · 연속 실패 · 판정(연속 2회 · 7일 = 이상 / 한 번 · 3일 = 주의 / 확인 불가는 아는 실패를 덮지 않는다)
 *  ⑤ 3절 조립 — 합계 = 법인 합 · 확인 불가 날은 수에 넣지 않음 · 앞 기간 · 실패 목록 순서 · 되풀이 줄무늬 · 빈 백업 선택은 빈 것
 *  ⑥ 범위 · 가림 — 범위로 자른 합계 = 행렬로 다시 센 수 · 비관리자 사유는 공개 문구 · 라우트 판본
 *  ⑦ DB 끝에서 끝까지 — Veeam 확정 · 틈이 길면 확인 불가 · Bareos 늦은 채움 · 멈춘 법인은 기다림 · 늦게 온 결과 다시 확정 · 적재 전 소급 없음 · 정리
 *  ⑧ 설정 정규화 · ⑨ 리더 판정(가짜 공급자) · ⑩ HTML 절 번호 · 확정 없는 수 '—' · ⑪ 실제 api(보관함 '백업' · 범위 계정 상태 가림)
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
const D = dayIndex(Date.now()) - 10;
const T0 = dayStartMs(D);
const helpers = { dayOf: (t) => dayIndex(t), dayStartOf: (d) => dayStartMs(d) };

test('① 결과 글자 → 상태(Summary 와 같은 갈래)', () => {
  assert.equal(L.veeamStateOf('Success'), 'ok');
  assert.equal(L.veeamStateOf('Warning'), 'warn');
  assert.equal(L.veeamStateOf('Failed'), 'fail');
  assert.equal(L.veeamStateOf('None'), null);
  assert.equal(L.veeamStateOf(''), null);
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
});

test('② 관측 — 신선 · 오래됨 · 제외 규칙', () => {
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
        { vmId: 'bv1', vmName: 'b-one', runs: [{ jobid: 5, status: 'T', endedAt: T0 + H }, { jobid: 5, status: 'T', endedAt: T0 + H }, { jobid: 6, status: 'A', endedAt: T0 + 3 * H, msg: 'canceled' }] },
        { vmId: 'bv2', enabled: false, runs: [] },
        { vmId: 'bv3', missing: true, runs: [] },
      ] } },
      { id: 'e', bareos: { mapped: false, jobs: [{ vmId: 'z', runs: [{ jobid: 1, status: 'T', endedAt: T0 }] }] } },
      { id: 'f', bareos: { mapped: true, resultsKnown: false, at: now, jobs: [] } },
    ],
    clones: [
      { vc: 'g', key: 'job:1', name: 'j1', at: now - H, target: true, runs: [{ at: T0 + H, ok: true }, { at: T0 + 2 * H, ok: false, detail: 'nfs full' }, { at: T0 + 2 * H, ok: false }] },
      { vc: 'g', key: 'job:2', name: 'j2', at: now - 2 * H, target: true, runs: [] },
      { vc: 'h', key: 'job:3', name: 'j3', at: null, target: true, runs: [{ at: T0 + H, ok: true }] },
    ],
  });
  const ofVc = (vc, p) => seen.find((s) => s.vc === vc && s.product === p);
  assert.deepEqual(obs.filter((o) => o.vc === 'a').map((o) => [o.vm, o.state]), [['vm1', 'ok'], ['vm2', 'fail']], 'None · 미래 시각은 관측이 아니다');
  const f2 = obs.find((o) => o.vm === 'vm2');
  assert.equal(f2.reason, 'raw secret path'); assert.equal(f2.reasonPub, 'public text');
  assert.equal(obs.find((o) => o.vm === 'vm1').reason, null, '성공에는 사유를 싣지 않는다');
  assert.equal(ofVc('a', 'veeam').fresh, true);
  assert.deepEqual(ofVc('a', 'veeam').targets, ['vm1', 'vm2', 'vm3', 'vm4']);
  assert.equal(ofVc('b', 'veeam').fresh, false, '읽기 상태가 ok 가 아니면 오래됨');
  assert.equal(ofVc('b', 'veeam').targets, null, '오래된 관측은 대상 목록을 남기지 않는다');
  assert.equal(ofVc('c', 'veeam'), undefined, '연동 없음은 관측 범위도 없다');
  assert.deepEqual(obs.filter((o) => o.vc === 'd').map((o) => [o.vm, o.runId, o.state]), [['bv1', '5', 'ok'], ['bv1', '6', 'fail']], '같은 jobid 는 한 번 · 취소는 실패');
  assert.deepEqual(ofVc('d', 'bareos').targets, ['bv1'], '꺼진 잡 · Director 에 없는 잡은 대상 밖');
  assert.equal(ofVc('e', 'bareos'), undefined, '연결되지 않은 Director 는 관측하지 않는다');
  assert.equal(obs.some((o) => o.vc === 'e'), false);
  assert.equal(ofVc('f', 'bareos').fresh, false, '결과를 모르면 오래됨');
  assert.equal(ofVc('g', 'clone').fresh, true);
  assert.equal(ofVc('g', 'clone').dataAt, now - 2 * H, '법인의 복제 데이터 시각은 가장 늦은 출처 기준(가장 이른 시각)');
  assert.deepEqual(ofVc('g', 'clone').targets, ['job:1', 'job:2']);
  assert.equal(obs.filter((o) => o.vc === 'g').length, 2, '같은 시각의 기록은 한 번');
  assert.equal(obs.find((o) => o.vc === 'g' && o.state === 'fail').reasonPub, '복제 백업 실패 — 사유는 백업 › VM 백업 화면');
  assert.equal(ofVc('h', 'clone').fresh, false, '데이터 시각을 모르는 출처가 있으면 그 법인은 오래됨');
});

test('③ 관측 범위 · 확정 판정', () => {
  assert.deepEqual(L.coverStep(null, T0 + 2 * H, helpers), { advance: true, gaps: [[D, 2 * H]] }, '첫 관측은 그날 00시부터 틈');
  assert.deepEqual(L.coverStep(T0 + 2 * H, T0 + 2 * H, helpers), { advance: false, gaps: [] }, '같은 읽기는 아무것도 바꾸지 않는다');
  assert.deepEqual(L.coverStep(T0 + 3 * H, T0 + 2 * H, helpers), { advance: false, gaps: [] }, '시계가 뒤로 가도 바꾸지 않는다');
  assert.deepEqual(L.coverStep(T0 + 23 * H, T0 + 25 * H, helpers), { advance: true, gaps: [[D, 2 * H], [D + 1, 2 * H]] }, '날을 걸친 틈은 두 날 모두에');
  assert.deepEqual(L.coverStep(T0, NaN, helpers), { advance: false, gaps: [] });
  const end = dayStartMs(D + 1);
  const base = { day: D, dayEnd: end, firstDay: D };
  assert.equal(L.sealStatus({ ...base, product: 'veeam', firstDay: D + 1, cursorAt: end + H, seenRow: { maxGap: H } }), null, '적재 시작 전 날은 확정하지 않는다');
  assert.equal(L.sealStatus({ ...base, product: 'veeam', firstDay: null, cursorAt: end + H, seenRow: { maxGap: H } }), null);
  assert.equal(L.sealStatus({ ...base, product: 'veeam', cursorAt: end + H, seenRow: { maxGap: L.VEEAM_GAP_MAX_MS } }), 'known');
  assert.equal(L.sealStatus({ ...base, product: 'veeam', cursorAt: end + H, seenRow: { maxGap: L.VEEAM_GAP_MAX_MS + 1 } }), 'unknown', '틈이 한도를 넘으면 확인 불가');
  assert.equal(L.sealStatus({ ...base, product: 'veeam', cursorAt: end - 1, seenRow: { maxGap: H } }), 'unknown', '날이 끝난 뒤 한 번 더 봐야 안다');
  assert.equal(L.sealStatus({ ...base, product: 'veeam', cursorAt: end + H, seenRow: null }), 'unknown');
  assert.equal(L.sealStatus({ ...base, product: 'veeam', cursorAt: end + H, seenRow: { maxGap: null } }), 'unknown', '틈을 모르면(0 이 아니다) 확인 불가');
  assert.equal(L.sealStatus({ ...base, product: 'bareos', cursorAt: end, seenRow: null }), 'known', '기록형은 날 끝 뒤 한 번 읽으면 안다');
  assert.equal(L.sealStatus({ ...base, product: 'clone', cursorAt: end - 1, seenRow: { maxGap: 1 } }), 'unknown');
  assert.equal(L.refillable('veeam'), false);
  assert.equal(L.refillable('bareos'), true);
  assert.equal(L.refillable('clone'), true);
});

test('④ 그날 마지막 결과 · 실행 없음 · 연속 실패 · 판정', () => {
  const rows = [
    { vm: 'a', endedAt: 1, state: 'fail' }, { vm: 'a', endedAt: 5, state: 'ok' },
    { vm: 'b', endedAt: 3, state: 'warn' }, { vm: 'c', endedAt: 4, state: 'fail' }, { vm: 'c', endedAt: 2, state: 'ok' },
    { vm: 'd', endedAt: 9, state: 'bogus' },
  ];
  const { counts, last } = L.sealCounts(rows, ['a', 'b', 'c', 'x', 'y']);
  assert.deepEqual(counts, { targets: 5, ended: 3, ok: 1, warn: 1, fail: 1, norun: 2 });
  assert.deepEqual(last.map((o) => [o.vm, o.state]).sort(), [['a', 'ok'], ['b', 'warn'], ['c', 'fail']]);
  assert.equal(L.sealCounts([{ vm: 'z', endedAt: 1, state: 'ok' }], null).counts.targets, 1, '대상 목록이 없어도 끝난 VM 은 대상');
  assert.equal(L.failStreak([{ endedAt: 1, state: 'ok' }, { endedAt: 3, state: 'fail' }, { endedAt: 2, state: 'fail' }]), 2, '끝난 시각 순서와 무관하게 맨 끝부터');
  assert.equal(L.failStreak([{ endedAt: 3, state: 'ok' }, { endedAt: 2, state: 'fail' }]), 0);
  assert.equal(L.failStreak([{ endedAt: 3, state: 'warn' }, { endedAt: 2, state: 'fail' }]), 0, '경고는 실패가 아니다');
  assert.equal(L.failStreak([{ endedAt: null, state: 'fail' }]), 0, '끝난 시각을 모르는 실행은 세지 않는다');
  assert.equal(L.backupJudge({}), 'ok');
  assert.equal(L.backupJudge({ failNow: 1 }), 'warn', '한 번 실패는 주의(컨펌 ⑤)');
  assert.equal(L.backupJudge({ failNow: 1, failRepeat: 1 }), 'crit', '연속 2회 이상 실패는 이상');
  assert.equal(L.backupJudge({ rpo3: 1 }), 'warn');
  assert.equal(L.backupJudge({ rpo7: 1 }), 'crit');
  assert.equal(L.backupJudge({ unknown: true }), 'unknown');
  assert.equal(L.backupJudge({ unknown: true, failNow: 1 }), 'warn', '확인 불가가 아는 실패를 덮지 않는다');
  assert.equal(L.rateOf({ e: 0, ok: 0, w: 0 }), null, '끝난 백업이 없으면 성공률 없음(0% 가 아니다)');
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
  { day: D, product: 'veeam', vm: 'vm9', vc: 'a', state: 'warn', name: 'nine', endedAt: T0 + 3 * H, reason: 'w', reasonPub: 'w' },
  { day: D + 1, product: 'veeam', vm: 'vb', vc: 'b', state: 'fail', name: 'bee', endedAt: T0 + DAY + 4 * H, reason: 'raw b', reasonPub: 'pub b' },
];
const prevDayRows = [{ day: D - 2, product: 'veeam', vc: 'a', status: 'known', targets: 10, ended: 10, ok: 10, warn: 0, fail: 0, norun: 0 }];
const strips = new Map([['veeam|vm1', [{ day: D, state: 'fail' }, { day: D + 1, state: 'fail' }]]]);
const sec = L.buildBackupSection({
  days: [D, D + 1], dayRows, vmRows, prevDayRows, strips,
  vmFacts: new Map([['veeam|vm1', { streak: 3, lastOkAt: T0 - DAY }], ['veeam|vm2', { streak: 1, lastOkAt: T0 }]]),
  now: [{ vc: 'a', product: 'veeam', vm: 'vm1', name: 'one' }, { vc: 'b', product: 'veeam', vm: 'vb', name: 'bee' }],
  products: ['veeam', 'bareos', 'clone'], dayLabel: (d) => `d${d - D}`, firstDay: D, asOf: T0 + 2 * DAY,
});

test('⑤ 3절 조립 — 합계 = 법인 합 · 확인 불가 날 · 앞 기간 · 목록', () => {
  const s = L.backupSummary(sec);
  assert.deepEqual({ t: s.total.t, e: s.total.e, ok: s.total.ok, w: s.total.w, f: s.total.f, n: s.total.n, kd: s.total.kd, ud: s.total.ud },
    { t: 31, e: 30, ok: 25, w: 1, f: 4, n: 1, kd: 5, ud: 1 }, '확인 불가 날의 수는 합계에 넣지 않는다');
  assert.equal(s.total.rate, L.rateOf(s.total));
  assert.equal(s.products.veeam.f, 4); assert.equal(s.products.bareos.ok, 4); assert.equal(s.products.clone.e, 2);
  assert.equal(s.unknownCorpDays, 1); assert.equal(s.corpsWithUnknown, 1);
  assert.deepEqual(s.days.map((d) => [d.e, d.f, d.u, d.k]), [[13, 1, 1, 3], [17, 3, 0, 3]]);
  assert.equal(s.prev.known, true); assert.equal(s.prev.e, 10); assert.equal(s.prev.f, 0);
  assert.equal(s.failNow, 2); assert.equal(s.repeatVms, 1); assert.equal(s.fails, 3);
  assert.deepEqual(s.coverage, { sealed: 2, days: 2, firstDay: D });
  // 법인 줄
  const rows = sec.corps.map((c) => L.backupCorpRow(c, sec.products));
  const a = rows.find((r) => r.vc === 'a');
  assert.deepEqual([a.e, a.f, a.failDays, a.repeatVms, a.failNow, a.unknownDays], [23, 3, 2, 1, 1, 0]);
  const sumE = rows.reduce((x, r) => x + r.e, 0); const sumF = rows.reduce((x, r) => x + r.f, 0);
  assert.equal(sumE, s.total.e); assert.equal(sumF, s.total.f);
  // 실패 목록 — (백업, VM) 하나에 한 줄 · 실패한 날 많은 순 · 경고는 목록에 넣지 않는다
  assert.deepEqual(sec.fails.map((x) => [x.vm, x.failDays, x.streak]), [['vm1', 2, 3], ['vm2', 1, 1], ['vb', 1, null]], '실패한 날 → 연속 실패(모름은 뒤) 순');
  assert.equal(sec.fails[0].reason, 'raw one b', '마지막 실패의 사유');
  assert.equal(sec.fails.some((x) => x.vm === 'vm9'), false);
  assert.deepEqual(sec.repeat.map((x) => x.vm), ['vm1']);
  assert.deepEqual(sec.repeat[0].strip, ['fail', 'fail']);
  // 줄무늬 — 관측이 없는 날은 그날 확정 상태로(알았음 = 실행 없음 · 확인 불가 · 적재 전)
  const sec2 = L.buildBackupSection({ days: [D - 1, D, D + 1], dayRows, vmRows: [...vmRows, { day: D + 1, product: 'veeam', vm: 'vb', vc: 'b', state: 'fail' }, { day: D, product: 'veeam', vm: 'vb', vc: 'b', state: 'fail' }],
    strips: new Map([['veeam|vb', [{ day: D + 1, state: 'fail' }]]]), products: ['veeam'] });
  const vb = sec2.repeat.find((x) => x.vm === 'vb');
  assert.deepEqual(vb.strip, ['pre', 'unknown', 'fail']);
  // 빈 백업 선택은 빈 것(전부로 바꾸지 않는다)
  const none = L.buildBackupSection({ days: [D], dayRows, vmRows, products: [] });
  assert.deepEqual(none.products, []); assert.equal(L.backupSummary(none).total.e, 0); assert.equal(none.fails.length, 0);
  const onlyBareos = L.backupSummary(L.buildBackupSection({ days: [D, D + 1], dayRows, vmRows, products: ['bareos'] }));
  assert.equal(onlyBareos.total.e, 4); assert.equal(onlyBareos.fails, 0, '고르지 않은 백업의 실패는 목록에 없다');
});

test('⑥ 범위 · 가림 — 자른 합계 = 행렬로 다시 센 수 · 사유는 공개 문구', async () => {
  const allowed = new Set(['b']);
  const cut = L.scopeCutBackup(sec, allowed);
  assert.deepEqual(cut.corps.map((c) => c.vc), ['b']);
  assert.deepEqual(cut.fails.map((x) => x.vm), ['vb']);
  assert.equal(cut.failsTotal, 1); assert.equal(cut.now.length, 1); assert.equal(cut.scoped, true);
  const s = L.backupSummary(cut);
  const m = L.backupFromMatrix(L.backupMatrixOf(sec), allowed);
  assert.deepEqual([m.ended, m.fail, m.unknown], [s.total.e, s.total.f, s.total.ud], '보관함 목록(행렬)과 보고서(자른 문서)가 같은 수');
  const full = L.backupFromMatrix(L.backupMatrixOf(sec), null);
  assert.deepEqual([full.ended, full.fail, full.unknown, full.days, full.sealed], [30, 4, 1, 2, 2]);
  assert.equal(L.scopeCutBackup(sec, null), sec);
  const pub = L.publicBackup(sec);
  assert.equal(pub.fails.find((x) => x.vm === 'vm1').reason, 'pub one b');
  assert.equal(pub.fails.find((x) => x.vm === 'vm2').reason, null, '공개 문구가 없으면 원문으로 채우지 않는다');
  assert.ok(!JSON.stringify(pub).includes('raw '), '비관리자 판본에 원문 사유가 없다');
  const { backupView } = await import('../src/routes/api/periodicReport.js');
  const vAdmin = backupView(sec, true); const vUser = backupView(sec, false);
  assert.equal(vAdmin.fails[0].reason, 'raw one b');
  assert.ok(!JSON.stringify(vUser).includes('raw '), '라우트 판본(비관리자)에도 원문 없음');
  assert.equal(vUser.summary.total.f, 4); assert.equal(vUser.corpRows.length, 3);
  assert.deepEqual(backupView({ off: true, reason: 'x' }, false), { off: true, reason: 'x' });
  assert.equal(backupView(null, true), null);
});

/* ── ⑦ DB 끝에서 끝까지 ── */
const vcsAt = (t) => {
  const vm2 = t >= T0 + 20 * H ? { id: 'vm2', name: 'two', lr: 'Success', lrt: T0 + 20 * H } : { id: 'vm2', name: 'two', lr: 'Failed', lrt: T0 + 3 * H, msg: 'snap fail', msgPub: 'pub snap' };
  const late = t >= T0 + 29 * H ? [{ id: 'vm4', name: 'late', lr: 'Failed', lrt: T0 + 23.9 * H, msg: 'late raw', msgPub: 'late pub' }] : [];
  const bRuns = [{ jobid: 5, status: 'T', endedAt: T0 + 2 * H }];
  if (t >= T0 + 31 * H) bRuns.push({ jobid: 7, status: 'E', endedAt: T0 + 23 * H });
  return [
    { id: 'v1', veeam: { state: 'ok', at: t, vms: [{ id: 'vm1', name: 'one', lr: 'Success', lrt: T0 + 2 * H }, vm2, { id: 'vm3', name: 'three', lr: 'Success', lrt: T0 - 2 * H }, ...late] } },
    // v2 — 08시 ~ 13시 B&R 읽기가 멈췄다(데이터 시각이 앞으로 가지 않음 → 5시간 틈)
    { id: 'v2', veeam: { state: 'ok', at: t >= T0 + 8 * H && t < T0 + 13 * H ? T0 + 8 * H : t, vms: [{ id: 'w1', name: 'w', lr: 'Success', lrt: T0 + H }] } },
    // b1 — 22시 ~ 31시 Director 결과를 모름(오래됨) → 날 끝 뒤 확정은 확인 불가 → 31시 신선 → 늦게 채움
    { id: 'b1', bareos: { mapped: true, resultsKnown: !(t > T0 + 22 * H && t < T0 + 31 * H), at: t, jobs: [{ vmId: 'bv1', vmName: 'b-one', runs: bRuns }] } },
    // b2 — 같은 멈춤이지만 새 실행이 없다 → 늦게 온 관측(dirty) 없이 '확인 불가였던 날 다시 채우기' 경로만으로 확정
    { id: 'b2', bareos: { mapped: true, resultsKnown: !(t > T0 + 22 * H && t < T0 + 31 * H), at: t, jobs: [{ vmId: 'bw1', vmName: 'b-two', runs: [{ jobid: 15, status: 'T', endedAt: T0 + 2 * H }] }] } },
  ];
};
// c9 — 20시 뒤 등록에서 빠졌다가(관측 없음) 40시에 돌아온다
const clonesAt = (t) => (t <= T0 + 20 * H || t >= T0 + 40 * H ? [{ vc: 'c9', key: 'job:9', name: 'nine', at: t, target: true, runs: [{ at: T0 + 5 * H, ok: true }] }] : []);
async function cap(t) {
  const { obs, seen } = L.observeOf({ vcs: vcsAt(t), clones: clonesAt(t), now: t });
  const r = await S.recordCapture({ obs, seen, now: t });
  assert.ok(r.ok, r.reason);
  const s = await S.sealDue({ now: t, dirty: r.dirty });
  assert.ok(s.ok, s.reason);
  return { r, s };
}
const dayOfLedger = async (day) => {
  const g = await S.ledgerBetween(day, day);
  return { g, row: (p, vc) => g.dayRows.find((x) => x.product === p && x.vc === vc) || null };
};

test('⑦ DB — 확정 · 확인 불가 · 늦은 채움 · 기다림 · 다시 확정 · 소급 없음 · 정리', async () => {
  for (let t = T0 + 0.5 * H; t <= T0 + 27.5 * H; t += H) await cap(t);
  let { g, row } = await dayOfLedger(D);
  const v1 = row('veeam', 'v1');
  assert.ok(v1, JSON.stringify(g.dayRows));
  assert.equal(v1.status, 'known', '틈 1시간 · 날 끝 뒤 관측 — 확정');
  assert.deepEqual([v1.targets, v1.ended, v1.ok, v1.warn, v1.fail, v1.norun], [3, 2, 2, 0, 0, 1], 'vm2 는 그날 마지막 결과(성공) · vm3 는 실행 없음(어제 결과)');
  assert.equal(row('veeam', 'v2').status, 'unknown', '5시간 틈 — 덮인 결과를 몰라 확인 불가');
  assert.equal(row('veeam', 'v2').ended, null, '확인 불가는 0 이 아니라 수가 없다');
  assert.equal(row('bareos', 'b1').status, 'unknown', '날 끝 뒤 신선한 읽기 전 — 일단 확인 불가');
  assert.equal(row('bareos', 'b2').status, 'unknown');
  assert.equal(row('clone', 'c9'), null, '날 끝 뒤 한 번도 보지 못한 법인은 확정하지 않고 기다린다');
  assert.equal(g.firstDay, D);
  assert.equal((await S.ledgerBetween(D - 1, D - 1)).dayRows.length, 0, '적재 시작 전 날은 소급하지 않는다(vm3 의 어제 결과가 있어도)');
  assert.equal(g.vmRows.length, 0, '그날 마지막 결과가 실패 · 경고인 VM 만 줄로 남긴다');

  // 29시 — 그날 23:54 에 끝난 vm4 실패가 늦게 올라온다 → 다시 확정
  for (let t = T0 + 28.5 * H; t <= T0 + 31.5 * H; t += H) await cap(t);
  ({ g, row } = await dayOfLedger(D));
  assert.deepEqual([row('veeam', 'v1').ended, row('veeam', 'v1').fail, row('veeam', 'v1').targets], [3, 1, 4], '늦게 온 결과로 다시 확정');
  assert.deepEqual(g.vmRows.filter((x) => x.product === 'veeam').map((x) => [x.vm, x.state, x.reason, x.reasonPub]), [['vm4', 'fail', 'late raw', 'late pub']], '관리자 원문 · 공개 문구를 둘 다 남긴다');
  const b1 = row('bareos', 'b1');
  assert.equal(b1.status, 'known', '기록형은 다시 신선하게 읽으면 채운다(REFILL_DAYS 안)');
  assert.deepEqual([b1.ended, b1.ok, b1.fail], [1, 0, 1], '23시에 끝난 실패가 그날 마지막 결과');
  assert.ok(g.vmRows.some((x) => x.vm === 'bv1' && x.state === 'fail'));
  const b2 = row('bareos', 'b2');
  assert.equal(b2.status, 'known', '새 관측 없이도 기록형은 다시 신선하게 읽은 뒤 채운다(늦은 채움 경로)');
  assert.deepEqual([b2.ended, b2.ok, b2.fail], [1, 1, 0]);
  assert.equal(row('veeam', 'v2').status, 'unknown', 'Veeam 은 늦은 채움이 없다(덮인 결과는 돌아오지 않는다)');

  // 40시 — c9 가 돌아온다 → 기다리던 날을 확정
  for (let t = T0 + 32.5 * H; t <= T0 + 40.5 * H; t += H) await cap(t);
  ({ row } = await dayOfLedger(D));
  const c9 = row('clone', 'c9');
  assert.ok(c9, '돌아온 뒤 확정');
  assert.equal(c9.status, 'known');
  assert.deepEqual([c9.ended, c9.ok], [1, 1]);

  // Veeam 의 확인 불가 날은 다시 확정하지 않는다(늦은 채움은 기록형만 — 덮인 결과는 돌아오지 않아 매 관측 같은 일을 되풀이할 뿐이다)
  const again = await S.sealDue({ now: T0 + 41 * H });
  assert.equal(again.resealed, 0, '다시 볼 날이 없으면 다시 확정 0');
  // 연속 실패 · 마지막 성공(관측 원본)
  const facts = await S.vmFacts(['veeam|vm2', 'veeam|vm4', 'bareos|bv1', 'bogus|x']);
  assert.equal(facts.get('veeam|vm2').streak, 0); assert.equal(facts.get('veeam|vm2').lastOkAt, T0 + 20 * H);
  assert.equal(facts.get('veeam|vm4').streak, 1); assert.equal(facts.get('veeam|vm4').lastOkAt, null);
  assert.equal(facts.get('bareos|bv1').streak, 1); assert.equal(facts.get('bareos|bv1').lastOkAt, T0 + 2 * H);
  assert.equal(facts.has('bogus|x'), false);

  // 3절 — 기간 [D, D+1) · 앞 기간 없음
  const section = await SV.backupSectionFor({ from: T0, to: T0 + DAY, now: T0 + 41 * H, settings: R.settingsOf({}), ctx: null });
  assert.equal(section.off, undefined); assert.equal(section.error, undefined);
  const sm = L.backupSummary(section);
  assert.equal(sm.coverage.sealed, 1);
  assert.equal(sm.total.f, 2, 'vm4 · bv1');
  assert.equal(sm.total.ud, 1, 'v2 의 Veeam 하루');
  assert.equal(sm.prev.known, false, '앞 기간은 적재 전');
  assert.deepEqual(section.fails.map((x) => x.vm).sort(), ['bv1', 'vm4']);
  assert.match(section.days[0].label, /^\d\d-\d\d \([월화수목금토일]\)$/, "날 표기 'MM-DD (요)'");
  const off = await SV.backupSectionFor({ from: T0, to: T0 + DAY, settings: R.settingsOf({ backup: { ledger: false } }) });
  assert.equal(off.off, true);
  const none = await SV.backupSectionFor({ from: T0, to: T0 + DAY, settings: R.settingsOf({ backup: { products: { veeam: false, bareos: false, clone: false } } }) });
  assert.equal(none.off, true, '실을 백업을 하나도 고르지 않으면 꺼진 것과 같게(전부로 바꾸지 않는다)');
  assert.match(none.reason, /고르지 않았습니다/);

  // 정리 — 관측 원본은 RAW_KEEP_DAYS, 확정 결과는 보관 일수 밖
  const info0 = await S.backupLedgerInfo();
  assert.ok(info0.obs > 0 && info0.days > 0);
  assert.equal(info0.firstDayAt, dayStartMs(D));
  await S.pruneBackup(400, T0 + (L.RAW_KEEP_DAYS + 2) * DAY);
  const info1 = await S.backupLedgerInfo();
  assert.equal(info1.obs, 0, '관측 원본은 40일 뒤 지운다');
  assert.equal(info1.days, info0.days, '확정 결과는 보관 일수 안이면 남긴다');
  await S.pruneBackup(92, T0 + 95 * DAY);
  assert.equal((await S.backupLedgerInfo()).days, 0, '보관 일수 밖 확정 결과를 지운다');
});

test('⑧ 설정 정규화 — 백업', () => {
  const s0 = R.settingsOf({});
  assert.deepEqual(s0.backup.products, { veeam: true, bareos: true, clone: true });
  assert.equal(s0.backup.ledger, true); assert.equal(s0.backup.keepDays, 400);
  assert.ok(Array.isArray(s0.backup.kinds) && s0.backup.kinds.length === 4);
  const now = Date.now();
  assert.equal(R.normalizeSettings({ backup: [] }, null, { now }).field, 'backup');
  assert.equal(R.normalizeSettings({ backup: { kinds: ['yearly'] } }, null, { now }).field, 'backup.kinds');
  assert.equal(R.normalizeSettings({ backup: { products: { veeam: 'yes' } } }, null, { now }).field, 'backup.products.veeam');
  assert.equal(R.normalizeSettings({ backup: { ledger: 1 } }, null, { now }).field, 'backup.ledger');
  assert.equal(R.normalizeSettings({ backup: { keepDays: 30 } }, null, { now }).field, 'backup.keepDays', `최소 ${L.LEDGER_KEEP.min}일`);
  assert.equal(R.normalizeSettings({ backup: { keepDays: 9999 } }, null, { now }).field, 'backup.keepDays');
  assert.equal(R.normalizeSettings({ backup: { keepDays: '' } }, null, { now }).field, 'backup.keepDays', '빈 값은 0 이 아니라 잘못된 값');
  const ok = R.normalizeSettings({ backup: { kinds: ['weekly', 'monthly'], products: { clone: false }, ledger: false, keepDays: 120 } }, null, { now });
  assert.deepEqual(ok.settings.backup, { kinds: ['weekly', 'monthly'], products: { veeam: true, bareos: true, clone: false }, ledger: false, keepDays: 120 });
  const kept = R.normalizeSettings({ chat: { enabled: false } }, ok.settings, { now });
  assert.deepEqual(kept.settings.backup, ok.settings.backup, '다른 설정을 저장해도 백업 설정은 그대로');
  const doc = { items: [], corps: [], backup: sec };
  assert.deepEqual(R.matrixOf(doc).bk, L.backupMatrixOf(sec), '회차 행렬에 3절 요약');
  assert.deepEqual(R.scopeCutDoc(doc, new Set(['b'])).backup.corps.map((c) => c.vc), ['b'], '문서 범위 절단이 3절도 자른다');
});

test('⑨ 리더 판정 — 연속 실패만 이상 · 한 번 실패 주의 · 7일 이상 · 모름은 확인 불가', async () => {
  const now = T0 + 50 * H;
  // vb2 는 앞서 한 번 실패했다(적재 원본) — 지금 다시 실패면 연속 2회
  const pre = L.observeOf({ now: now - 6 * H, vcs: [{ id: 'x2', veeam: { state: 'ok', at: now - 6 * H, vms: [{ id: 'vb2', lr: 'Failed', lrt: now - 7 * H }] } }] });
  assert.ok((await S.recordCapture({ ...pre, now: now - 6 * H })).ok);
  setPeriodicProvider('backup-observe', async () => ({
    at: now,
    vcs: [
      { id: 'x1', veeam: { state: 'ok', at: now, vms: [{ id: 'va1', name: 'a', lr: 'Failed', lrt: now - H, lb: now - DAY }, { id: 'va2', lr: 'Success', lrt: now - H, lb: now - H }] } },
      { id: 'x2', veeam: { state: 'ok', at: now, vms: [{ id: 'vb2', name: 'b', lr: 'Failed', lrt: now - H, lb: now - 2 * DAY }] } },
      { id: 'x3', veeam: { state: 'ok', at: now, vms: [{ id: 'vc3', lr: 'Success', lrt: now - 8 * DAY, lb: now - 8 * DAY }] } },
      { id: 'x4', veeam: { state: 'stale', at: now - 9 * H, vms: [{ id: 'vd4', lr: 'Success', lrt: now - H, lb: now - H }] } },
      { id: 'x5', veeam: { state: 'ok', at: now, vms: [{ id: 've5', lr: 'Success', lrt: now - H, lb: now - H }] }, bareos: { mapped: true, resultsKnown: true, state: 'ok', at: now,
        jobs: [{ vmId: 'bb1', vmName: 'bb', lastOkAt: now - 2 * DAY, runs: [{ jobid: 2, status: 'E', endedAt: now - 2 * H }, { jobid: 1, status: 'f', endedAt: now - DAY }, { jobid: 0, status: 'T', endedAt: now - 2 * DAY }] }] } },
      { id: 'x6', bareos: { mapped: true, resultsKnown: false, state: 'auth-blocked', at: null, jobs: [] } },
      { id: 'x7', bareos: { mapped: true, resultsKnown: true, state: 'ok', at: now, jobs: [{ vmId: 'bc1', lastOkAt: now - 4 * DAY, runs: [{ jobid: 3, status: 'E', endedAt: now - H }] }] } },
    ],
  }));
  const ctx = { now, cache: new Map(), from: now - DAY, to: now, snap: { vcenters: [], vms: [] } };
  const v = await READERS.veeam(ctx);
  const st = (r, vc) => r.rows.find((x) => x.vc === vc)?.status;
  assert.equal(st(v, 'x1'), 'warn', '한 번 실패는 주의');
  assert.equal(st(v, 'x2'), 'crit', '연속 2회 실패(적재 원본 + 지금)는 이상');
  assert.equal(st(v, 'x3'), 'crit', '마지막 성공 7일 넘음은 이상');
  assert.equal(st(v, 'x4'), 'unknown', '결과를 못 읽은 법인은 확인 불가');
  assert.equal(st(v, 'x5'), 'ok');
  const b = await READERS.bareos(ctx);
  assert.equal(st(b, 'x5'), 'crit', 'Bareos 연속 2회 실패(취소 · 실패 섞임)는 이상');
  assert.equal(st(b, 'x6'), 'unknown', 'Director 결과를 모르면 확인 불가');
  assert.equal(st(b, 'x7'), 'warn', '한 번 실패 + 마지막 성공 3일 넘음은 주의');
  const c = await READERS['vm-clone'](ctx);
  assert.equal(c.na, true, '켜진 VM 복제 잡이 없으면 해당 없음');
  // 3절의 '지금 실패' — 같은 ctx 의 판정 자료를 쓴다(공급자를 두 번 부르지 않는다)
  let calls = 0;
  setPeriodicProvider('backup-observe', async () => { calls += 1; return { at: now, vcs: [] }; });
  const ctx2 = { now, cache: new Map() };
  await READERS.veeam(ctx2); await READERS.bareos(ctx2); await SV.backupFacts(ctx2);
  assert.equal(calls, 1, '회차 하나에 공급자 한 번(ctx.cache)');
  setPeriodicProvider('backup-observe', async () => ({ notReady: true, reason: '첫 수집 전' }));
  const nr = await READERS.veeam({ now, cache: new Map() });
  assert.equal(nr.status, 'unknown'); assert.match(nr.unknownReason, /첫 수집 전/);
});

test('⑩ HTML — 절 번호가 밀린다 · 확정 없는 수는 — · 메일 · 채널 한 줄', () => {
  const base = { id: 'D-x', kind: 'daily', periodLabel: 'x', items: [], corps: [{ vc: 'a', name: 'A' }, { vc: 'b', name: 'B' }, { vc: 'c', name: 'C' }], counts: {}, overall: 'ok', generatedAt: T0 };
  const without = RD.renderReportHtml(base, {});
  assert.match(without, /3\. 법인별 현황/); assert.ok(!without.includes('백업 성공 · 실패 현황'));
  const html = RD.renderReportHtml({ ...base, backup: sec }, {});
  assert.match(html, /3\. 백업 성공 · 실패 현황/); assert.match(html, /4\. 법인별 현황/); assert.match(html, /8\. 확인하지 못한 것/);
  assert.ok(!html.includes('<script'));
  const empty = L.buildBackupSection({ days: [D], dayRows: [{ day: D, product: 'veeam', vc: 'a', status: 'unknown' }], vmRows: [], products: ['veeam'] });
  const h2 = RD.renderReportHtml({ ...base, backup: empty }, {});
  assert.match(h2, /끝난 백업 <b>—<\/b>/, '확정된 날이 없으면 0 이 아니라 —');
  assert.match(h2, /실패가 없다는 뜻이 아닙니다/);
  assert.match(RD.backupLine(empty), /확정된 결과가 아직 없습니다/);
  assert.match(RD.backupChat(empty), /확정된 결과 없음/);
  const line = RD.backupLine(sec, (vc) => ({ a: 'A', b: 'B' }[vc] || vc));
  assert.match(line, /실패 4/); assert.match(line, /\n실패 — A 3 · B 1/);
  assert.match(RD.backupChat(sec), /^백업 실패 4\(앞 기간 0\)/);
  const offHtml = RD.renderReportHtml({ ...base, backup: { v: 1, off: true, reason: '하루 치 적재가 꺼져 있습니다' } }, {});
  assert.match(offHtml, /3\. 백업 성공 · 실패 현황/); assert.match(offHtml, /하루 치 적재가 꺼져 있습니다/);
  const m = RD.renderMail({ ...base, backup: L.publicBackup(sec) }, { portal: 'P' });
  assert.ok(!m.text.includes('raw '), '메일에는 원문 사유가 없다');
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
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, body: j, text };
  } finally { srv.closeAllConnections?.(); srv.close(); }
}

async function fetchBuf(urlPath, user) {
  const app = express();
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api', api);
  const srv = http.createServer(app); const port = await listen(srv);
  try { const res = await fetch(`http://127.0.0.1:${port}/api${urlPath}`); return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) }; }
  finally { srv.closeAllConnections?.(); srv.close(); }
}

test('⑪ 실제 api — 보관함 백업 수 · 보고서 3절 · 범위 계정 · 비관리자 가림', async () => {
  const items = [{ key: 'veeam', axis: 'service', label: 'Veeam 백업 판정', status: 'crit', rows: [{ vc: 'a', status: 'crit' }, { vc: 'b', status: 'warn' }] }];
  const doc = { id: 'D-2099-01-01', kind: 'daily', periodFrom: T0, periodTo: T0 + DAY, periodLabel: 'x', generatedAt: Date.now(), status: 'done', items,
    corps: [{ vc: 'a', name: 'A' }, { vc: 'b', name: 'B' }, { vc: 'c', name: 'C' }], counts: R.countsOf(items), overall: R.overallOf(items), corpsTotal: 3, corpsReported: 3, backup: sec };
  const put = await pdb.putRun(doc, R.matrixOf(doc));
  assert.ok(put.ok, put.reason);
  const admin = { username: 'root', role: 'admin', scope: {} };
  const viewer = { username: 'v', role: 'viewer', scope: {} };
  const scopedUser = { username: 'kr', role: 'operator', scope: { vcenters: ['b'] } };
  const list = await call('/tools/periodic-report/runs', { user: admin });
  const row = list.body.runs.find((r) => r.id === doc.id);
  assert.deepEqual(row.backup, { ended: 30, fail: 4, unknown: 1, days: 2, sealed: 2 });
  const sl = await call('/tools/periodic-report/runs', { user: scopedUser });
  assert.deepEqual(sl.body.runs.find((r) => r.id === doc.id).backup, { ended: 5, fail: 1, unknown: 1, days: 2, sealed: 2 }, '범위 계정은 자기 법인만 다시 센다');
  const one = await call(`/tools/periodic-report/runs/${doc.id}`, { user: scopedUser });
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.run.backup.corpRows.map((c) => c.vc), ['b']);
  assert.equal(one.body.run.backup.summary.total.f, 1);
  assert.equal(one.body.run.backup.summary.total.f, sl.body.runs.find((r) => r.id === doc.id).backup.fail, '목록과 보고서가 같은 수');
  const va = await call(`/tools/periodic-report/runs/${doc.id}`, { user: admin });
  assert.equal(va.body.run.backup.fails[0].reason, 'raw one b', '관리자는 원문 사유');
  const vv = await call(`/tools/periodic-report/runs/${doc.id}`, { user: viewer });
  assert.ok(!JSON.stringify(vv.body.run.backup).includes('raw '), '비관리자는 공개 문구');
  const html = await call(`/tools/periodic-report/runs/${doc.id}/report.html`, { user: viewer });
  assert.equal(html.status, 200); assert.ok(!html.text.includes('raw '), 'HTML 보고서도 비관리자는 공개 문구');
  const xl = await fetchBuf(`/tools/periodic-report/runs/${doc.id}/export.xlsx`, viewer);
  assert.equal(xl.status, 200);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xl.buf);
  const fs2 = wb.getWorksheet('백업 실패'); const fc = wb.getWorksheet('백업 법인별');
  assert.ok(fs2 && fc, 'XLSX 에 백업 시트 둘');
  assert.equal(fs2.rowCount - 1, sec.fails.length, '실패 시트에는 문서의 실패 전부');
  const cells = []; fs2.eachRow((r) => cells.push(r.values.join('|')));
  assert.ok(!cells.join('\n').includes('raw '), '비관리자 XLSX 도 공개 문구');
  const empty = { ...doc, id: 'D-2099-01-02', backup: L.buildBackupSection({ days: [D], dayRows: [{ day: D, product: 'veeam', vc: 'a', status: 'unknown' }], vmRows: [], products: ['veeam'] }) };
  assert.ok((await pdb.putRun(empty, R.matrixOf(empty))).ok);
  const xe = await fetchBuf(`/tools/periodic-report/runs/${empty.id}/export.xlsx`, admin);
  const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(xe.buf);
  const r2 = wb2.getWorksheet('백업 법인별').getRow(2).values;
  assert.ok(r2[3] == null || r2[3] === '', '확정된 날이 없는 법인의 끝난 백업은 빈칸(0 이 아니다)');
  assert.equal(r2[9], 1, '확인 불가 날 수는 그대로');
  const st = await call('/tools/periodic-report/status', { user: scopedUser });
  assert.equal(st.status, 200);
  assert.deepEqual(Object.keys(st.body.backup || {}).sort(), ['captureMs', 'enabled'], '범위 계정 상태에는 전 법인 적재 수를 싣지 않는다');
  const sa = await call('/tools/periodic-report/status', { user: admin });
  assert.ok(sa.body.backup && 'db' in sa.body.backup && sa.body.backup.captureMs === L.CAPTURE_MS);
});
