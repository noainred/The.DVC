/**
 * test/backupSummary2838.test.js — v2.838 Summary 를 시안 ① 에 맞추기 B(사용자 요청 '2.838 구현해줘').
 *   ① 백업 스케줄 코어 — 그룹 회차 전개 · Veeam 잡 다음 실행 · 띠 길이(지난 실행 폭 · 모르면 추정) · 겹침 · 7일 요약(Veeam 은 오늘 · 내일만)
 *   ② 통합 에러 로그 코어 — Veeam VM 마지막 결과 · Bareos 원장 끝난 실행 · EM 세션 · 수집 오류 · 같은 원인 · 정렬 · 상한
 *   ③ 일일 메일 — 조건 정규화 · 보낼 차례 · 본문 이스케이프 · 틱(메일 꺼짐 · 실패 재시도 · 하루 상한) · 손상 설정
 *   ④ 저장소 남은 일수(추정 — 모르면 null)
 *   ⑤ 라우트 — Detail 거부 403 · 범위 · EM 은 전체 범위만 · 알림 설정은 전체 범위 관리자만(데모 · 범위 · operator 403) · 감사 · 1분 상한
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'backup2838-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';   // 인증 켬(도구별 접근 집행이 실제로 돈다) · 데모 아님(일일 메일 틱이 돈다)

const SC = await import('../src/veeam/backupSchedule.js');
const ER = await import('../src/veeam/backupErrors.js');
const SA = await import('../src/veeam/staleAlert.js');
const { dayIndex, dayStartMs } = await import('../src/util/dayKey.js');
const H = 3_600_000; const DAY = 24 * H; const MIN = 60_000;
const NOW = Math.floor(Date.now() / H) * H;
const closers = [];
after(async () => { for (const c of closers) await c(); fs.rmSync(DIR, { recursive: true, force: true }); });

// 매일 23:00(포탈 시각) · 일요일은 Full — groupSchedule.nextSlot 과 같은 모양(sched, now) → { at, level }
const T0 = dayStartMs(dayIndex(NOW));
const daily23 = (_s, t) => { let at = dayStartMs(dayIndex(t)) + 23 * H; if (at <= t) at += DAY; return { at, level: dayIndex(at) % 7 === 3 ? 'Full' : 'Incremental' }; };

test('① 그룹 회차 전개 — 창 안만 · 앞으로 가지 않으면 멈춤 · 상한 14', () => {
  const s = SC.expandSlots({}, T0, T0 + 3 * DAY, daily23);
  assert.deepEqual(s.map((x) => x.at), [T0 + 23 * H, T0 + DAY + 23 * H, T0 + 2 * DAY + 23 * H], '끝(to) 뒤 회차는 넣지 않는다');
  assert.deepEqual(SC.expandSlots({}, T0, T0 + 23 * H - 1, daily23), [], '첫 회차가 창 밖이면 없음');
  assert.equal(SC.expandSlots({}, T0, T0 + 23 * H, daily23).length, 1, '끝과 같은 시각은 든다');
  const stuck = () => ({ at: T0 + H, level: 'Full' });
  assert.equal(SC.expandSlots({}, T0, T0 + DAY, stuck).length, 1, '같은 회차를 다시 주면 멈춘다(무한 반복 없음)');
  const every = (_s, t) => ({ at: t + MIN, level: 'Incremental' });
  assert.equal(SC.expandSlots({}, T0, T0 + DAY, every).length, 14, '상한 14');
  assert.deepEqual(SC.expandSlots({}, T0, T0 + DAY, () => null), []);
});

test('① Veeam 잡 — 다음 실행(가장 이른 것) · 띠 길이 = 지난 실행 폭(36시간 안) · 모르면 60분 추정 · 지난 시각은 버림', () => {
  const rows = [
    { id: 'b', v: { jobs: ['J1'], lrs: NOW - 5.5 * H, lrt: NOW - 3 * H } },   // 가장 이른 시작이 먼저 와도(순서와 무관)
    { id: 'a', v: { jobs: ['J1'], lrs: NOW - 5 * H, lrt: NOW - 4 * H, nr: NOW + 2 * H } },
    { id: 'c', v: { jobs: ['J2'], lrs: NOW - 40 * H, lrt: NOW - 39 * H } },   // 36시간 밖 — 폭 모름
    { id: 'd', v: { jobs: ['J3', 'J1'] } },
    { id: 'e', v: { jobs: ['J4'], lrs: NOW - H, lrt: NOW - 2 * H } },   // 시작 > 끝 — 버린다
    { id: 'z', v: { jobs: ['J6'], lrs: NOW - H, lrt: NOW - H } },   // 폭 0 — 모름(추정)
  ];
  const jobs = [{ name: 'J1', nextRun: NOW + 2 * H }, { name: 'J1', nextRun: NOW + 3 * H }, { name: 'J6', nextRun: NOW + 6 * H }, { name: 'J2', nextRun: NOW + 5 * H }, { name: 'J3', nextRun: NOW - H },
    { name: 'J4', nextRun: NOW + H }, { name: 'X', nextRun: NOW + H }, { name: 'J5', nextRun: null }];
  const it = SC.veeamJobItems(rows, jobs, NOW);
  assert.deepEqual(it.map((x) => x.name), ['J4', 'J1', 'J2', 'J6'], '시각 순 · VM 행에 없는 잡(X) · 지난 실행(J3) · 다음 실행 모름은 빠진다');
  const j1 = it.find((x) => x.name === 'J1');
  assert.deepEqual([j1.at, j1.end - j1.at, j1.est, j1.vms], [NOW + 2 * H, 2.5 * H, false, 3], 'J1 폭 = 가장 이른 시작 ~ 가장 늦은 끝(2.5시간) · VM 3대(d 포함)');
  const j2 = it.find((x) => x.name === 'J2');
  assert.deepEqual([j2.end - j2.at, j2.est], [SC.DEFAULT_DUR_MS, true], '36시간 밖 실행은 폭으로 쓰지 않는다 — 추정 표지');
  assert.equal(it.find((x) => x.name === 'J4').est, true, '시작 > 끝이면 폭 모름');
  assert.deepEqual([it.find((x) => x.name === 'J6').est, it.find((x) => x.name === 'J6').end - NOW - 6 * H], [true, SC.DEFAULT_DUR_MS], '폭 0 이면 모름 — 추정 60분');
  assert.deepEqual(SC.veeamJobItems(null, null, NOW), []);
  // 결과 잡 목록이 없을 때 — VM 행 v.nr(잡 하나에만 든 VM 만)
  assert.deepEqual(SC.jobsFromRows([...rows, { id: 'f', v: { jobs: ['J1'], nr: NOW + H } }, { id: 'g', v: { jobs: ['J3', 'J1'], nr: NOW + 0.5 * H } }]),
    [{ name: 'J1', nextRun: NOW + H }], '둘 이상 잡에 든 VM 의 nr 은 어느 잡 것인지 모른다 — 쓰지 않는다');
});

test('① 그룹 회차 · 겹침 · 7일 요약', async () => {
  const groups = [
    { name: 'g1', vmIds: ['a', 'b'], schedule: { enabled: true } },
    { name: 'g2', vmIds: ['c'], schedule: { enabled: false } },
    { name: 'g3', vmIds: [], schedule: null },
  ];
  const gi = SC.groupItems(groups, T0, T0 + 7 * DAY, daily23);
  assert.equal(gi.length, 7, '예약이 켜진 그룹만 · 7일 7회차');
  assert.ok(gi.every((x) => x.name === 'g1' && x.vms === 2 && x.est === true && x.end - x.at === SC.DEFAULT_DUR_MS));
  assert.equal(gi.filter((x) => x.full).length, 1, 'Full 회차 표지');
  // 실제 스케줄 코어와 모양이 맞는다(nextSlot(sched, now) → { at, level })
  const { nextSlot } = await import('../src/bareos/groupSchedule.js');
  const real = SC.groupItems([{ name: 'r', vmIds: ['x'], schedule: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], fullDays: [0], level: 'Incremental', time: '23:00' } }], NOW, NOW + 7 * DAY, nextSlot);
  assert.ok(real.length >= 6 && real.every((x) => Number.isFinite(x.at) && x.at > NOW), JSON.stringify(real.slice(0, 2)));
  assert.equal(real.filter((x) => x.full).length, 1, '일요일 Full 표지(실제 코어의 레벨)');
  // 겹침 — 맞닿기만 하면 겹침 아님
  const v = [{ name: 'J1', at: T0 + 22 * H, end: T0 + 23.5 * H }, { name: 'J2', at: T0 + 20 * H, end: T0 + 23 * H }];
  const o = SC.overlapOf(v, [{ name: 'g1', at: T0 + 23 * H, end: T0 + 24 * H }]);
  assert.deepEqual(o, { from: T0 + 23 * H, to: T0 + 23.5 * H, veeam: 1, bareos: 1 }, 'J2 는 23:00 에 끝나 맞닿기만 — 겹침 아님');
  assert.equal(SC.overlapOf(v, []), null);
  assert.equal(SC.overlapOf([], gi), null);
  // 7일 — Bareos 회차 · VM · Full / Veeam 은 다음 1회만 알므로 사흘째부터 null(모름 — 0 이 아니다)
  const days = SC.sevenDays([{ veeam: [{ at: T0 + 2 * H }, { at: T0 + DAY + H }, { at: T0 + 3 * DAY }], bareos: gi }, { veeam: [], bareos: [{ at: T0 + DAY, vms: 4, full: false }] }], T0);
  assert.equal(days.length, 7);
  assert.deepEqual(days.map((d) => d.day), [0, 1, 2, 3, 4, 5, 6].map((i) => T0 + i * DAY));
  assert.deepEqual(days.map((d) => d.veeam), [1, 1, null, null, null, null, null]);
  assert.deepEqual(days.map((d) => d.groups), [1, 2, 1, 1, 1, 1, 1], '자정 정각 회차는 그날(뒤 날)에 든다');
  assert.equal(days.reduce((a, d) => a + d.gvms, 0), 18);
  assert.equal(days.reduce((a, d) => a + d.full, 0), 1);
});

test('② 에러 로그 코어 — Veeam VM 마지막 결과 · Bareos 원장 · EM 세션 · 수집 오류', () => {
  const site = { id: 'vc1', name: 'VC1' };
  const since = NOW - DAY;
  const vr = ER.veeamVmRows([
    { id: 'vc1:1', name: 'web01', v: { lr: 'Failed', lrt: NOW - H, lm: 'Disk <full>', jobs: ['J1'] } },
    { id: 'vc1:2', name: 'db01', v: { lr: 'Warning', lrt: NOW - 2 * H, jobs: [] } },
    { id: 'vc1:3', name: 'ok01', v: { lr: 'Success', lrt: NOW - H } },
    { id: 'vc1:4', name: 'old01', v: { lr: 'Failed', lrt: NOW - 2 * DAY } },
    { id: 'vc1:5', name: 'nots', v: { lr: 'Failed', lrt: null } },
  ], site, since, (r) => r.v.lm || '');
  assert.deepEqual(vr.map((x) => [x.vm, x.kind, x.job]), [['web01', 'fail', 'J1'], ['db01', 'warn', '']], '성공 · 창 밖 · 시각 모름은 넣지 않는다');
  assert.equal(vr[0].msg, 'Disk <full>', '메시지 원문(이스케이프는 화면이 — React)');
  assert.equal(vr[1].msg, 'Veeam task 결과 Warning', '메시지가 없으면 결과를 적는다');
  assert.equal(vr[0].open, 'detail');
  // Bareos — 원장을 못 읽으면 행 없음 · lastRun 과 recentRuns 의 같은 jobid 는 한 번 · 성공(T) 제외 · 범위 밖 VM 제외
  assert.deepEqual(ER.bareosRows(null, null, site, since), []);
  const dig = new Map([
    ['vc1:1', { vmId: 'vc1:1', vmName: 'web01', bareosJob: 'vm-web01', lastRun: { jobid: 9, status: 'E', level: 'Full', endedAt: NOW - H, errors: 2 },
      recentRuns: [{ jobid: 7, status: 'T', endedAt: NOW - 3 * H }, { jobid: 8, status: 'W', endedAt: NOW - 2 * H }, { jobid: 9, status: 'E', endedAt: NOW - H }, { jobid: 6, status: 'A', endedAt: NOW - 3 * DAY }] }],
    ['vc1:9', { vmId: 'vc1:9', vmName: 'other', bareosJob: 'vm-other', lastRun: { jobid: 3, status: 'f', endedAt: NOW - H }, recentRuns: [] }],
    ['vc1:2', { vmId: 'vc1:2', vmName: 'db01', bareosJob: 'vm-db01', lastRun: { jobid: 4, status: 'R', endedAt: null }, recentRuns: [{ jobid: 2, status: 'A', level: 'I', endedAt: NOW - 5 * H }] }],
  ]);
  const br = ER.bareosRows(dig, new Set(['vc1:1', 'vc1:2']), site, since);
  assert.deepEqual(br.map((x) => [x.vm, x.jobid, x.kind]).sort((a, b) => a[1] - b[1]), [['db01', 2, 'fail'], ['web01', 8, 'warn'], ['web01', 9, 'fail']]);
  assert.match(br.find((x) => x.jobid === 9).msg, /^오류로 끝남 · Full · 오류 2건/);
  assert.match(br.find((x) => x.jobid === 2).msg, /^취소됨 · Incremental/, '카탈로그 한 글자 레벨은 이름으로');
  assert.ok(br.every((x) => x.open === 'bareos' && x.src === 'bareos'));
  // EM 세션 — 법인 칸은 백업 서버 매핑의 이름만(vcNames) · 창 · 결과
  const em = ER.emSessionRows([{ id: 'em1', data: { sessions: { recentBad: [
    { uid: 'u1', job: 'EJ', server: 'VBR', result: 'fail', end: NOW - H, vcNames: ['KR', 'JP', 'US', 'DE'] },
    { uid: 'u2', job: 'EJ2', server: 'VBR', result: 'warn', end: NOW - 2 * DAY, vcNames: null },
    { uid: 'u3', job: 'EJ3', server: 'VBR', result: 'ok', end: NOW - H },
    { uid: 'u4', job: 'EJ4', result: 'warn', end: NOW - H, vcNames: null },
  ] } } }, { id: 'em2', data: null }], since);
  assert.deepEqual(em.map((x) => [x.job, x.kind, x.vcName]), [['EJ', 'fail', 'KR, JP, US 외 1'], ['EJ4', 'warn', '']]);
  assert.ok(em.every((x) => x.vc === '' && x.open === 'em' && x.em === 'em1'));
  // 멈춤 의심 — 진행 현황 행 중 stuck 만 · 지금의 상태(조회 시각) · 시각을 모르면 행 없음
  const sk = ER.stuckRows([{ vmId: 'vc1:1', vmName: 'web01', jobid: '62', elapsed: (6 * 60 + 16) * MIN, stuck: 'no-report' }, { vmId: 'vc1:2', vmName: 'db01', jobid: 63, elapsed: 9 * H }, { vmId: 'vc1:3', vmName: 'x', jobid: 64, elapsed: null, stuck: 'zero' }], site, NOW - MIN);
  assert.deepEqual(sk.map((x) => [x.vm, x.jobid, x.kind, x.at, x.open]), [['web01', 62, 'stuck', NOW - MIN, 'live'], ['x', 64, 'stuck', NOW - MIN, 'live']]);
  assert.equal(sk[0].msg, '6시간 16분째 실행 중 · FD 진행 보고 없음');
  assert.equal(sk[1].msg, '오래 실행 중 · 전송 속도 0');
  assert.deepEqual(ER.stuckRows([{ stuck: 'zero' }], site, null), []);
  // 수집 오류 — 시각 모름 · 창 밖 제외 · 인증 정지 문구 · 여는 곳
  const co = ER.collectRows([
    { at: NOW - H, vc: 'vc1', vcName: 'VC1', src: 'veeam', name: 'VBR', error: 'timeout', auth: false },
    { at: NOW - H, vc: 'vc1', vcName: 'VC1', src: 'bareos', name: 'dir1', error: '', auth: true },
    { at: null, src: 'veeam', name: 'x' }, { at: NOW - 2 * DAY, src: 'veeam', name: 'y' },
  ], since);
  assert.deepEqual(co.map((x) => [x.job, x.kind, x.via, x.open]), [['VBR', 'collect', 'veeam', 'em'], ['dir1', 'collect', 'bareos', 'bareos-settings']]);
  assert.equal(co[0].msg, '읽기 실패 — timeout');
  assert.match(co[1].msg, /^인증 실패 — 주기 수집 정지/);
});

test('② Veeam 작업 메시지는 어떤 응답에도 원문으로 실리지 않는다 — Symbol 키 · 에러 로그만 꺼내 비관리자는 가린다(v2.766 규칙)', async () => {
  const { matchToVcenter, TASK_MSG } = await import('../src/veeam/parse.js');
  const BS = await import('../src/veeam/backupStatus.js');
  const { taskMsgOf } = await import('../src/routes/api/veeam.js');
  const SECRET = 'Failed to connect to proxy vbr-proxy01.corp.local:9392';
  const vc = { id: 'vc1', host: 'vc1.corp.local' };
  const vms = [{ id: 'vc1:vm-1', vcenterId: 'vc1', name: 'web01', moref: 'vm-1' }];
  const m = matchToVcenter(vc, vms, [{ server: { id: 'A', name: 'A' }, result: { ok: true, ts: NOW, jobs: [{ id: 'j', name: 'J', lastRun: NOW - H, lastResult: 'Failed' }],
    vms: [{ n: 'web01', m: 'vm-1', h: 'vc1.corp.local', j: [0], rp: 1, lt: { r: 'Failed', m: SECRET, s: NOW - 2 * H, e: NOW - H } }] } }]);
  const e = m.byVm['vc1:vm-1'];
  assert.equal(e[TASK_MSG], SECRET, '서버 안에서는 꺼낼 수 있다');
  assert.ok(!JSON.stringify(m).includes('vbr-proxy01'), '/veeam/vcenter 응답(byVm 그대로)에 원문이 없다');
  assert.ok(!JSON.stringify(BS.vmBackupView(vms[0], e, null, { now: NOW })).includes('vbr-proxy01'), 'Detail 행에도 없다');
  const rows = [{ id: 'vc1:vm-1', name: 'web01' }];
  assert.equal(taskMsgOf(m.byVm, true)(rows[0]), SECRET, '관리자 판본은 원문');
  assert.equal(taskMsgOf(m.byVm, false)(rows[0]), '작업 메시지에 주소가 들어 있어 관리자 화면에서만 보입니다', '그 밖은 VM 상세와 같은 가림');
  e[TASK_MSG] = 'Snapshot cleanup took too long';
  assert.equal(taskMsgOf(m.byVm, false)(rows[0]), 'Snapshot cleanup took too long', '주소가 없으면 그대로');
  assert.equal(taskMsgOf(m.byVm, false)({ id: 'nope', name: 'x' }), '');
  assert.equal(taskMsgOf(null, true)(rows[0]), '');
  const vr = ER.veeamVmRows([{ id: 'vc1:vm-1', name: 'web01', v: { lr: 'Failed', lrt: NOW - H, jobs: ['J'] } }], { id: 'vc1', name: 'VC1' }, NOW - DAY, () => '');
  assert.equal(vr[0].msg, 'Veeam task 결과 Failed', '메시지가 없으면 결과만');
});

test('② 에러 로그 — 같은 원인 · 새것 먼저 · 수는 전부 · 상한', () => {
  const r = (at, o = {}) => ({ at, vcName: 'A', src: 'veeam', kind: 'fail', job: 'J', msg: 'm', ...o });
  const rows = [r(NOW - 3 * H), r(NOW - H), r(NOW - 2 * H, { kind: 'warn' }), r(NOW - 4 * H, { src: 'bareos' }), r(NOW - 5 * H, { src: 'collect', kind: 'collect' }), r(NOW - 6 * H, { msg: 'other' }), r(NOW - 7 * H, { src: 'bareos', kind: 'stuck' })];
  const f = ER.finishErrors(rows, 3);
  assert.deepEqual(f.rows.map((x) => x.at), [NOW - H, NOW - 2 * H, NOW - 3 * H]);
  assert.equal(f.truncated, true);
  assert.deepEqual(f.counts, { all: 7, fail: 4, warn: 1, stuck: 1, collect: 1, volume: 0, veeam: 4, bareos: 2 }, '수는 상한 밖까지 센다 · 수집 오류는 Veeam/Bareos 에 넣지 않는다 · v2.840 오류 볼륨 칸');
  assert.deepEqual(f.rows.map((x) => x.same), [2, 1, 2], '같은 출처 · 결과 · 잡 · 메시지 앞머리');
  assert.equal('truncated' in ER.finishErrors(rows), false);
  assert.deepEqual(ER.ERROR_DAYS, [1, 7, 30]);
});

test('③ 일일 메일 — 조건 정규화 · 보낼 차례', () => {
  assert.throws(() => SA.normAlert({ time: '24:00' }), (e) => e.code === 'invalid');
  assert.throws(() => SA.normAlert({ time: '8:30' }), (e) => e.code === 'invalid');
  assert.throws(() => SA.normAlert({ q: { n: 0 } }), (e) => e.code === 'invalid');
  assert.throws(() => SA.normAlert({ q: { n: 'abc' } }), (e) => e.code === 'invalid');
  const n = SA.normAlert({ enabled: true, time: '07:05', q: { n: 2, unit: 'w', src: 'policy', excludeNone: false, onlyOn: false, includeNever: false, vc: 'vc1' } });
  assert.deepEqual(n, { enabled: true, time: '07:05', q: { n: 2, unit: 'w', src: 'policy', excludeNone: false, onlyOn: false, includeNever: false, vc: 'vc1' } });
  assert.equal(SA.normAlert({ enabled: 'yes', q: { n: 3 } }).enabled, false, 'enabled 는 true 일 때만');
  assert.equal(SA.normAlert({ q: { n: 3, src: 'bogus' } }).q.src, 'all', '모르는 기준은 전부(찾기와 같은 규칙)');
  // 보낼 차례 — 포탈 시각 기준
  const cfg = { enabled: true, time: '08:30' };
  const at = (h, m = 0) => T0 + h * H + m * MIN;
  const day = SA.dueOf(cfg, {}, at(9)).day;
  assert.equal(SA.dueOf(cfg, {}, at(8, 29)).due, false, '정한 시각 전');
  assert.equal(SA.dueOf(cfg, {}, at(8, 30)).due, true, '정한 시각부터');
  assert.equal(SA.dueOf({ ...cfg, enabled: false }, {}, at(9)).due, false);
  assert.equal(SA.dueOf(cfg, { day, ok: true }, at(23)).due, false, '오늘 보냈으면 다시 보내지 않는다');
  assert.equal(SA.dueOf(cfg, { day: '2000-01-01', ok: true, tries: 3 }, at(9)).due, true, '어제 기록은 오늘을 막지 않는다');
  assert.equal(SA.dueOf(cfg, { day, ok: false, tries: SA.TRIES_MAX }, at(23)).due, false, '하루 시도 상한');
  assert.equal(SA.dueOf(cfg, { day, ok: false, tries: 1, nextTry: at(9, 30) }, at(9, 10)).due, false, '재시도 시각 전');
  assert.equal(SA.dueOf(cfg, { day, ok: false, tries: 1, nextTry: at(9, 30) }, at(9, 30)).due, true);
});

test('③ 일일 메일 — 본문은 값을 전부 이스케이프 · 링크 없음 · 모름 행은 목록에 넣지 않는다', () => {
  const d = { q: { n: 3, unit: 'd', excludeNone: true, onlyOn: true }, n: 3, never: 1, old: 2, unknown: 1, failing: 1, sites: 2, excluded: { none: 4, off: 5 },
    rows: [
      { vcName: 'KR<b>', kind: 'never', last: null, vm: { name: '<script>alert(1)</script>', folder: 'DC/vm/A/"B"', p: 'veeam', mm: true } },
      { vcName: 'JP', kind: 'old', last: NOW - 5 * DAY, vm: { name: "o'neil", p: 'bareos', e: [{ r: 'fail' }] } },
      { vcName: 'JP', kind: 'unknown', last: null, vm: { name: 'unk01' } },
    ] };
  const m = SA.renderStaleMail(d, { vcLabel: '' });
  assert.equal(m.subject, '[Backup] 최근 3일 동안 성공한 백업이 없는 VM 3대');
  assert.ok(!m.html.includes('<script>') && m.html.includes('&lt;script&gt;'));
  assert.ok(!m.html.includes('KR<b>') && m.html.includes('KR&lt;b&gt;'));
  assert.ok(m.html.includes('o&#39;neil') && m.html.includes('&quot;B&quot;'));
  assert.ok(!/href=|<a /i.test(m.html), '포탈 링크를 싣지 않는다(메뉴 경로를 글로)');
  assert.ok(!m.html.includes('unk01'), '모름 행은 목록에 넣지 않는다(수만)');
  assert.match(m.html, /결과를 못 읽은 1대는 모름으로 따로/);
  assert.match(m.html, /정책≠실제/);
  assert.match(m.html, /최근 24시간 실패/);
  assert.match(m.html, /… 1대 더/, 'n(3) - 목록(2) = 1');
  const big = { ...d, n: 250, rows: Array.from({ length: 250 }, (_, i) => ({ vcName: 'A', kind: 'never', vm: { name: `v${i}` } })) };
  assert.equal((SA.renderStaleMail(big).html.match(/<tr>/g) || []).length - 1, SA.MAIL_ROWS_MAX, '본문 행 상한(머리 줄 제외)');
  assert.match(SA.renderStaleMail(d, { vcLabel: 'KR' }).subject, / — KR$/);
});

test('③ 일일 메일 — 틱: 메일 꺼짐이면 계산하지 않음 · 실패하면 30분 뒤 · 손상 설정은 저장 거부', async () => {
  const mailCfg = await import('../src/mail/settings.js');
  SA._resetForTest();
  let calls = 0;
  SA.setStaleProvider(async () => { calls++; return { q: { n: 3, unit: 'd' }, n: 1, never: 1, old: 0, unknown: 0, sites: 1, excluded: {}, total: 1, rows: [{ vcName: 'A', kind: 'never', vm: { name: 'x' } }] }; });
  const at = (h, m = 0) => T0 + h * H + m * MIN;
  // 설정 꺼짐 → 아무것도 안 함
  assert.equal(await SA.tick(at(9)), null);
  const saved = SA.saveAlert({ enabled: true, time: '08:30', q: { n: 3 } }, { by: 'adm', now: at(7) });
  assert.equal(saved.savedBy, 'adm');
  assert.equal(fs.statSync(path.join(DIR, 'backup-stale-alert.json')).mode & 0o777, 0o600);
  // 메일 전역 꺼짐 → 계산하지 않는다
  assert.equal(await SA.tick(at(9)), null);
  assert.equal(calls, 0, '메일이 꺼져 있으면 계산(무거운 집계)도 하지 않는다');
  // 메일 켬 · 수신자 없음 → 발송은 건너뜀(실패) → 30분 뒤 다시
  fs.writeFileSync(path.join(DIR, 'mail.json'), JSON.stringify({ enabled: true }));
  mailCfg.invalidate();
  const r1 = await SA.tick(at(9));
  assert.equal(calls, 1);
  assert.equal(r1.ok, false);
  assert.equal(SA.alertStatus().tries, 1);
  assert.equal(await SA.tick(at(9, 10)), null, '30분 안에는 다시 계산하지 않는다');
  assert.equal(calls, 1);
  await SA.tick(at(9, 31));
  assert.equal(calls, 2);
  await SA.tick(at(10, 2));
  await SA.tick(at(10, 40));
  assert.equal(calls, 3, '하루 시도 상한(3)');
  const st = JSON.parse(fs.readFileSync(path.join(DIR, 'backup-stale-alert-state.json'), 'utf8'));
  assert.deepEqual([st.ok, st.tries, st.n], [false, 3, 1]);
  // 이 종류만 끔 → 계산하지 않는다(다음 날이어도)
  fs.writeFileSync(path.join(DIR, 'mail.json'), JSON.stringify({ enabled: true, kinds: { [SA.MAIL_KIND]: { enabled: false } } }));
  mailCfg.invalidate();
  assert.equal(await SA.tick(at(9) + DAY), null);
  assert.equal(calls, 3);
  // 지금 보내기 — 오늘 기록을 바꾸지 않는다
  const before = fs.readFileSync(path.join(DIR, 'backup-stale-alert-state.json'), 'utf8');
  const sn = await SA.sendNow({ by: 'adm' });
  assert.equal(sn.ok, false, '수신자 없음');
  assert.equal(calls, 4);
  assert.equal(fs.readFileSync(path.join(DIR, 'backup-stale-alert-state.json'), 'utf8'), before);
  // 계산기가 던지면 실패로 기록(틱이 죽지 않는다)
  fs.writeFileSync(path.join(DIR, 'mail.json'), JSON.stringify({ enabled: true }));
  mailCfg.invalidate();
  SA.setStaleProvider(async () => { throw new Error('boom'); });
  const r2 = await SA.tick(at(9) + 2 * DAY);
  assert.deepEqual([r2.ok, r2.reason], [false, 'boom']);
  // 손상 설정 — 보존 · 저장 거부 · 보내지 않음
  fs.writeFileSync(path.join(DIR, 'backup-stale-alert.json'), '{broken');
  SA._resetForTest();
  assert.ok(SA.alertLoadError());
  assert.equal(SA.loadAlert().enabled, false);
  assert.throws(() => SA.saveAlert({ enabled: true, time: '08:30', q: { n: 3 } }), (e) => e.code === 'unreadable');
  assert.ok(fs.readdirSync(DIR).some((f) => f.startsWith('backup-stale-alert.json.corrupt.')), '손상본 보존');
  assert.equal(await SA.tick(at(9) + 3 * DAY), null);
  for (const f of fs.readdirSync(DIR)) if (f.startsWith('backup-stale-alert')) fs.rmSync(path.join(DIR, f));
  fs.rmSync(path.join(DIR, 'mail.json'));
  mailCfg.invalidate();
  SA._resetForTest();
});

test('④ 저장소 남은 일수 — 최근 30일 사용 증가 기울기 · 모르면 null', async () => {
  const { repoDaysLeft } = await import('../src/routes/api/veeam.js');
  assert.equal(repoDaysLeft(null), null);
  assert.equal(repoDaysLeft([[100, 1000, 100]]), null, '하루치뿐이면 모름');
  assert.equal(repoDaysLeft([[90, 1000, 100], [100, 1000, 100]]), null, '사용이 늘지 않으면 모름(0 이 아니다)');
  assert.equal(repoDaysLeft([[90, 1000, 200], [100, 1000, 100]]), 10, '열흘에 100 늘어 하루 10 · 여유 100 → 10일');
  assert.equal(repoDaysLeft([[10, 1000, 900], [80, 1000, 300], [100, 1000, 100]]), 10, '30일보다 오래된 점(10일차)은 쓰지 않는다 — 80일차부터 하루 10');
  assert.equal(repoDaysLeft([[90, 1000, 105], [100, 1000, 100], [95, 'x', 1]]), 200, '숫자가 아닌 점은 버린다 · 순서가 섞여도');
});

test('④ 저장소 30일 선 — 모든 저장소가 값을 가진 날만(부분 합 제외) · 점 둘 미만이면 null', async () => {
  const { repoSeries30 } = await import('../src/routes/api/veeam.js');
  assert.equal(repoSeries30(null), null);
  assert.equal(repoSeries30({ a: [[100, 10, 5]] }), null);
  const s = repoSeries30({ a: [[60, 100, 90], [80, 100, 50], [90, 100, 40], [100, 100, 30]], b: [[90, 10, 5], [100, 10, 4]], c: [] });
  assert.deepEqual(s, [[90, 65], [100, 76]], '80일차는 b 가 없어 뺀다 · 60일차는 30일 밖');
  assert.equal(repoSeries30({ a: [[50, 100, 50], [100, 100, 40]] }), null, '30일 밖 점은 쓰지 않는다 — 창 안 점이 하나면 모름');
});

test('⑤ 라우트 — 스케줄 · 에러 로그(Detail 거부 403 · 범위 · EM 은 전체 범위만) · 알림 설정(전체 범위 관리자만 · 감사 · 1분 상한)', async () => {
  const VA = 'vc-a'; const VB = 'vc-b'; const OUT = 'vc-out';
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerBackupStatus } = await import('../src/routes/api/veeam.js');
  const P = await import('../src/auth/permissions.js');
  const prev = store.snapshot;
  store.snapshot = { source: 'live', generatedAt: NOW, vcenters: [VA, VB, OUT].map((id) => ({ id, name: id.toUpperCase() })), hosts: [], vms: [
    { id: `${VA}:vm-1`, vcenterId: VA, name: 'web01', folder: 'DC/vm/A', powerState: 'POWERED_ON' },
    { id: `${VB}:vm-1`, vcenterId: VB, name: 'app01', folder: 'DC/vm/X', powerState: 'POWERED_ON' },
    { id: `${OUT}:vm-1`, vcenterId: OUT, name: 'out01', folder: 'DC/vm/X', powerState: 'POWERED_ON' },
  ] };
  let user = { username: 'op1', role: 'operator', scope: { vcenters: [VA, VB] } };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerBackupStatus(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const call = async (method, p, body) => {
    const r = await fetch(`${base}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const get = (p) => call('GET', p);
  try {
    // 스케줄 — 범위 안 법인만 · 연동 없음이면 Veeam 줄 비고 · 그룹 파일 없음 = 그룹 0(모름 아님)
    const s = await get('/tools/backup-summary/schedule');
    assert.equal(s.status, 200);
    assert.deepEqual(s.body.rows.map((r) => r.id).sort(), [VA, VB]);
    assert.ok(s.body.rows.every((r) => Array.isArray(r.veeam) && Array.isArray(r.bareos) && r.overlap === null));
    assert.equal(s.body.days.length, 7);
    assert.equal(s.body.groupsUnreadable, undefined);
    // 에러 로그 — 범위 계정에는 EM 을 싣지 않는다 · days 는 1 · 7 · 30 만(그 밖은 1)
    const e = await get('/tools/backup-summary/errors?days=7');
    assert.equal(e.status, 200);
    assert.equal(e.body.days, 7);
    assert.equal(e.body.sources.em, false, 'EM 세션 · EM 수집 상태는 전 법인 자료 — 범위 계정 제외');
    assert.ok(e.body.rows.every((r) => !r.vc || [VA, VB].includes(r.vc)));
    assert.equal((await get('/tools/backup-summary/errors?days=99')).body.days, 1);
    // Detail 이 거부된 계정 — 잡 · VM 이름이 새지 않는다
    assert.equal(P.setUserTools('op3', { mode: 'deny', tools: ['backup-detail'], by: 't' }).ok, true);
    user = { username: 'op3', role: 'operator', scope: { vcenters: [VA, VB] } };
    assert.equal((await get('/tools/backup-summary/schedule')).status, 403);
    assert.equal((await get('/tools/backup-summary/errors?days=1')).status, 403);
    // 전체 범위 관리자 — EM 이 들어간다(등록 EM 0 대)
    user = { username: 'adm', role: 'admin' };
    const ea = await get('/tools/backup-summary/errors?days=30');
    assert.equal(ea.body.sources.em, true);
    assert.equal((await get('/tools/backup-summary/schedule')).body.rows.length, 3);

    // 알림 설정 — 범위 계정은 숨김(설정을 싣지 않는다)
    user = { username: 'op1', role: 'operator', scope: { vcenters: [VA, VB] } };
    const ga = await get('/tools/backup-summary/alert');
    assert.deepEqual(ga.body, { ok: true, canEdit: false, hidden: true });
    user = { username: 'adm2', role: 'admin', scope: { vcenters: [VA] } };
    assert.equal((await get('/tools/backup-summary/alert')).body.hidden, true, '범위 지정 관리자도 숨김');
    assert.equal((await call('PUT', '/tools/backup-summary/alert', { enabled: true, time: '08:30', q: { n: 3 } })).status, 403, '범위 지정 관리자는 저장 불가');
    user = { username: 'op9', role: 'operator' };
    const go = await get('/tools/backup-summary/alert');
    assert.deepEqual([go.body.canEdit, !!go.body.settings], [false, true], '전체 범위 operator 는 보기만');
    assert.equal((await call('PUT', '/tools/backup-summary/alert', { enabled: true, time: '08:30', q: { n: 3 } })).status, 403);
    assert.equal((await call('POST', '/tools/backup-summary/alert/send')).status, 403);
    user = { username: 'thedvcdemp', role: 'admin', demoGuest: true };
    assert.equal((await call('PUT', '/tools/backup-summary/alert', { enabled: true, time: '08:30', q: { n: 3 } })).status, 403, '데모 계정 403');
    assert.equal((await get('/tools/backup-summary/alert')).body.canEdit, false);
    // 관리자 — 입력 검증 · 없는 법인 · 저장 · 감사
    user = { username: 'adm', role: 'admin' };
    assert.equal((await get('/tools/backup-summary/alert')).body.canEdit, true);
    assert.equal((await call('PUT', '/tools/backup-summary/alert', { enabled: true, time: '25:00', q: { n: 3 } })).status, 400);
    assert.equal((await call('PUT', '/tools/backup-summary/alert', { enabled: true, time: '08:30', q: { n: 0 } })).status, 400);
    assert.equal((await call('PUT', '/tools/backup-summary/alert', { enabled: true, time: '08:30', q: { n: 3, vc: 'nope' } })).status, 400, '없는 법인');
    const ok = await call('PUT', '/tools/backup-summary/alert', { enabled: true, time: '07:15', q: { n: 2, unit: 'd', src: 'policy', vc: VA } });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.body.settings.time, ok.body.settings.q.src, ok.body.settings.q.vc, ok.body.settings.savedBy], ['07:15', 'policy', VA, 'adm']);
    assert.equal((await get('/tools/backup-summary/alert')).body.settings.time, '07:15');
    // 지금 보내기 — 계산(전 법인 · 시스템 계정) → 메일 꺼짐이라 실패 사유 · 1분 상한 · 감사
    const sn = await call('POST', '/tools/backup-summary/alert/send');
    assert.equal(sn.status, 200);
    assert.equal(sn.body.ok, false);
    assert.ok(sn.body.reason, '보내지 못한 사유');
    assert.equal(typeof sn.body.n, 'number', '계산한 수는 사실대로(발송 여부와 따로)');
    assert.equal((await call('POST', '/tools/backup-summary/alert/send')).status, 429);
    const audit = fs.readFileSync(path.join(DIR, 'audit.ndjson'), 'utf8');
    assert.match(audit, /backup-stale-alert\.save/);
    assert.match(audit, /backup-stale-alert\.send/);
  } finally {
    store.snapshot = prev;
    for (const f of fs.readdirSync(DIR)) if (f.startsWith('backup-stale-alert')) fs.rmSync(path.join(DIR, f));
    SA._resetForTest();
  }
});
