/**
 * test/bareosPolicy2840.test.js — v2.840 Bareos 백업 메뉴 개편 2차-b('보존 · 풀' 탭 · 그룹 카드 · 백업 대상 '적용 정책' · 실행 이력 거르기 · 오류 볼륨).
 *   ① 파서 — llist clients(실측 아님 — 카탈로그 Client 열 추정) · 볼륨 행(list volumes pool=) 두 모양 · 멱등 · 상한 · 엣지 회신 정제 · ops.volumes 관문
 *   ② 판정 — poolsView(쓰는 잡 수 · 범위 · 가림 · 수집 전) · poolPolicyOf · jobPolicyResolver · errorVolumeItems · volumeRows · groupOverlaps
 *   ③ 라우트 — 보존 · 풀 조회(범위 · canQuery) · 볼륨 즉시 조회(범위 404 · 이름 400 · operator 403 · 1분 기억 · Director 오류) · 소스 스윕(조회 라우트는 Director 에 접속하지 않는다)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2840-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';

const PP = await import('../src/bareos/policyParse.js');
const POL = await import('../src/bareos/policy.js');
const { OPS, MUTATING } = await import('../src/bareos/ops.js');
const { VALUE, sanitizeEdgeResult } = await import('../src/bareos/edgeResult.js');
const { RESULT_MS, EDGE_MUTATING } = await import('../src/bareos/edgeOps.js');
const BE = await import('../src/veeam/backupErrors.js');
const SC = await import('../src/veeam/backupSchedule.js');
const FX = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'bareosPolicy2839');
const fx = (f) => JSON.parse(fs.readFileSync(path.join(FX, `${f}.json`), 'utf8'));
const H = 3_600_000;
const closers = [];
after(async () => { for (const c of closers) await c(); fs.rmSync(DIR, { recursive: true, force: true }); });

function fakeSession(map) {
  const sent = [];
  return {
    sent, info: { banner: 'OK: bareos-dir Version: 25.1.2' },
    call: async (cmd) => {
      sent.push(cmd);
      const v = map[cmd];
      if (v instanceof Error) throw v;
      if (v === undefined) throw Object.assign(new Error(`${cmd.split(' ')[0]}: is an invalid command.`), { code: 'jsonrpc' });
      return JSON.parse(JSON.stringify(v));
    },
  };
}

test('① llist clients — 아는 칸만(주소 · uname · 비밀번호 칸은 버린다) · 문자열 → 초 · 못 읽음은 null · 멱등 · 선택 명령 등록', () => {
  const raw = { clients: [
    { clientid: '1', name: 'kr-fd', uname: '25.1.2 Linux', address: '10.0.0.1', password: 'secret-x', autoprune: '1', fileretention: '5184000', jobretention: '15552000' },
    { name: '' }, 'junk', { name: 'us-fd', fileretention: '-5', jobretention: 'abc', autoprune: 'yes' },
  ] };
  const c = PP.normClients(raw);
  assert.deepEqual(c, [
    { name: 'kr-fd', fileRetentionSec: 5184000, jobRetentionSec: 15552000, autoPrune: true },
    { name: 'us-fd', fileRetentionSec: null, jobRetentionSec: null, autoPrune: null },
  ], '음수 · 숫자 아님은 모름(0 이 아니다)');
  assert.ok(!JSON.stringify(c).includes('secret-x') && !JSON.stringify(c).includes('10.0.0.1'));
  assert.deepEqual(PP.normClients(c), c, '멱등(엣지 회신을 중앙이 다시 거른다)');
  const cmd = PP.POLICY_CMDS.find((x) => x.key === 'clients');
  assert.deepEqual([cmd.cmd, cmd.optional], ['llist clients', true], 'show 권한이 필요 없는 카탈로그 목록 · 선택 명령');
  assert.equal(PP.NORMALIZE.clients, PP.normClients);
  const r = PP.normPolicyResult({ results: { clients: { ok: true, value: raw } } });
  assert.equal(r.results.clients.value[0].fileRetentionSec, 5184000);
});

test('① 볼륨 행 — 배열 · 풀 키 객체 두 모양 · 상태 정규화 · 시각 · 상한(truncated · total) · 멱등 · 엣지 정제', () => {
  const arr = PP.normVolumeRows({ volumes: [
    { mediaid: '7', volumename: 'Full-0001', volstatus: 'full', enabled: '1', volbytes: '3145942', volfiles: '0', volretention: '31536000', recycle: '1', slot: '0', inchanger: '0', mediatype: 'File', lastwritten: '2026-10-30 21:05:00', storage: 'File', evil: 'x' },
    { volumename: '', volstatus: 'Append' }, null,
  ] });
  assert.equal(arr.rows.length, 1);
  const r0 = arr.rows[0];
  assert.deepEqual([r0.id, r0.name, r0.status, r0.bytes, r0.retentionSec, r0.recycle, r0.inChanger, r0.mediaType, r0.storage], [7, 'Full-0001', 'Full', 3145942, 31536000, true, false, 'File', 'File']);
  assert.equal(r0.lastWritten, new Date(2026, 9, 30, 21, 5, 0).getTime(), 'Director 현지 문자열 → 포탈 서버 현지(기존 규칙)');
  assert.ok(!('evil' in r0), '아는 칸만');
  const obj = PP.normVolumeRows(fx('list-volumes'));
  assert.deepEqual([obj.rows.length, obj.total, obj.truncated], [4, 4, false], '전체 목록 모양(풀 이름 키)도 받는다');
  assert.deepEqual(PP.normVolumeRows(obj), obj, '멱등');
  const many = PP.normVolumeRows({ volumes: Array.from({ length: PP.CAP.volumeRows + 100 }, (_, i) => ({ volumename: `v${i}`, volstatus: 'Full' })) });
  assert.deepEqual([many.rows.length, many.total, many.truncated], [PP.CAP.volumeRows, PP.CAP.volumeRows + 100, true]);
  const again = PP.normVolumeRows(many);
  assert.deepEqual([again.total, again.truncated], [many.total, true], '다시 걸러도 전체 수 · 잘림 표지 유지');
  assert.equal(PP.normVolumeRows({ rows: [{ name: 'a' }], truncated: true }).truncated, true, '전체 수가 없어도 잘림 표지는 지우지 않는다(엣지 회신 재정제)');
  assert.equal(VALUE.volumes({ rows: [{ name: 'v1', bytes: '5', status: 'Error', password: 'p' }] }).rows[0].bytes, 5);
  const s = sanitizeEdgeResult('volumes', { ok: true, value: { rows: [{ name: 'v1', status: 'Error', password: 'p' }] } });
  assert.ok(s.ok && !JSON.stringify(s).includes('password'));
  assert.ok(RESULT_MS.volumes > 0 && RESULT_MS.volumes <= RESULT_MS.policy, '읽기 하나 — 정책 수집보다 짧게');
  assert.ok(!MUTATING.has('volumes') && !EDGE_MUTATING.has('volumes'), '읽기 전용 — 회신이 없으면 결과 모름이 아니라 시한');
});

test('① ops.volumes — list volumes pool=<이름> 하나 · 리소스 이름 모양이 아니면 보내지 않는다', async () => {
  const s = fakeSession({ 'list volumes pool=Full': { volumes: [{ volumename: 'Full-0001', volstatus: 'Full' }] } });
  const r = await OPS.volumes(s, { pool: 'Full' });
  assert.deepEqual([s.sent, r.rows.map((x) => x.name)], [['list volumes pool=Full'], ['Full-0001']]);
  for (const bad of ['a b', '-x', 'x;y', '', 'x"y', 'a\nb', undefined]) {
    const s2 = fakeSession({});
    await assert.rejects(() => OPS.volumes(s2, { pool: bad }), (e) => e.code === 'invalid');
    assert.deepEqual(s2.sent, [], `거부(${JSON.stringify(bad)}) — 명령을 보내지 않는다`);
  }
});

/* ── 판정 ── */
const AT = Date.now() - 2 * H;
function dirRecord({ name, pools = fx('llist-pools'), volumes = fx('list-volumes'), clients = null, jobdefs = fx('show-jobdefs'), scheduler = null, clientsFail = null }) {
  const results = {
    pools: { ok: true, value: PP.normPools(pools) }, volumes: { ok: true, value: PP.normVolumes(volumes) }, jobdefs: { ok: true, value: PP.normJobdefs(jobdefs) },
    ...(clients ? { clients: { ok: true, value: PP.normClients(clients) } } : {}), ...(clientsFail ? { clients: clientsFail } : {}),
    ...(scheduler ? { scheduler: { ok: true, value: PP.normScheduler(scheduler) } } : {}),
  };
  return POL.mergeDirector(undefined, { name, keys: POL.policyKeys({}), res: { results, version: '25.1.2' }, err: null, at: AT, trigger: 'timer' });
}
const SETTINGS = {
  directors: [{ id: 'dir_kr', name: 'KR' }, { id: 'dir_us', name: 'US', agent: 'edge-us' }, { id: 'dir_jp', name: 'JP' }],
  sites: [{ vcenterId: 'vc-kr', directorId: 'dir_kr', pool: 'Incremental' }, { vcenterId: 'vc-us', directorId: 'dir_us', pool: 'Full' }, { vcenterId: 'vc-jp', directorId: 'dir_jp' }],
  defaults: { jobDefs: 'PortalVmwareDefaults' },
};
const usVolumes = () => { const v = fx('list-volumes'); v.volumes.incremental[0].volstatus = 'Error'; return v; };
const usPools = () => { const p = fx('llist-pools'); p.pools.push({ ...p.pools[1], poolid: '9', name: 'My Pool' }); return p; };
const DB = () => ({ directors: {
  dir_kr: dirRecord({ name: 'KR', clients: { clients: [{ name: 'kr-fd', fileretention: '5184000', jobretention: '15552000', autoprune: '1' }, { name: 'bareos-fd', fileretention: '2592000', jobretention: '7776000', autoprune: '0' }] },
    scheduler: { schedules: [{ name: 'VMwareNightly', enabled: '1', jobs: [{ name: 'pv-1', enabled: '1' }, { name: 'pv-off', enabled: '0' }] }], preview: [{ runtime: String(Math.floor((Date.now() + 2 * H) / 1000)), schedule: 'VMwareNightly', level: 'Incremental' }] } }),
  dir_us: dirRecord({ name: 'US', pools: usPools(), volumes: usVolumes(), clients: { clients: [{ name: 'us-fd', fileretention: '5184000', jobretention: '15552000', autoprune: '1' }] },
    clientsFail: null }),
}, sched: {} });
const DIGESTS = [
  { id: 'j1', vcenterId: 'vc-kr', vmId: 'vc-kr:vm-1', vmName: 'kr-1', bareosJob: 'pv-1', pool: 'Full', client: 'kr-fd', directorId: 'dir_kr' },
  { id: 'j2', vcenterId: 'vc-kr', vmId: 'vc-kr:vm-2', vmName: 'kr-2', bareosJob: 'pv-2', pool: 'Incremental', client: 'kr-fd', directorId: 'dir_kr' },
  { id: 'j3', vcenterId: 'vc-kr', vmId: 'vc-kr:vm-3', vmName: 'kr-3', bareosJob: 'pv-off', pool: 'Incremental', client: 'kr-fd', directorId: 'dir_kr' },
  { id: 'j4', vcenterId: 'vc-us', vmId: 'vc-us:vm-1', vmName: 'us-1', bareosJob: 'pv-us', pool: 'Full', client: 'us-fd', directorId: 'dir_us' },
];
const GROUPS = [{ id: 'g1', name: 'kr-night', vcenterId: 'vc-kr', directorId: 'dir_kr', vmIds: ['vc-kr:vm-2'], pool: 'Full', keep: 3, schedule: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], time: '23:30', level: 'Incremental', fullDays: [] } }];

test('② poolsView — 풀 표(가득 참 먼저 · 쓰는 잡 = 그룹 풀 → 잡 풀 · JobDefs 참조) · 클라이언트 · 숫자 · 범위 · 가림 · 수집 전', () => {
  const db = DB();
  const v = POL.poolsView({ settings: SETTINGS, digests: DIGESTS, groups: GROUPS, allowed: null, admin: true, db, now: Date.now() });
  assert.deepEqual(v.directors.map((d) => [d.name, d.via, d.at === null]), [['KR', 'central', false], ['US', 'edge', false], ['JP', 'central', true]], '수집 전 Director 도 상태 줄에(— 수집 전)');
  assert.deepEqual([v.kpis.pools, v.kpis.full, v.kpis.errorVols, v.kpis.clients], [7, 2, 1, 3]);
  assert.equal(v.pools[0].full, true, '가득 참 먼저');
  const krFull = v.pools.find((p) => p.directorId === 'dir_kr' && p.name === 'Full');
  assert.deepEqual(krFull.used, { jobs: 2, groups: 1, jobdefs: ['DefaultJob(Full)'] }, 'vm-1(잡 풀 Full) + vm-2(그룹 풀 Full 이 잡 풀 Incremental 을 이긴다) · 그룹 1');
  const krInc = v.pools.find((p) => p.directorId === 'dir_kr' && p.name === 'Incremental');
  assert.deepEqual(krInc.used, { jobs: 1, groups: 0, jobdefs: ['DefaultJob', 'DefaultJob(Incr)'] }, 'vm-3 만(vm-2 는 그룹 풀로 갔다)');
  assert.equal(v.pools.find((p) => p.name === 'My Pool').queryable, false, '공백이 든 이름은 즉시 조회 대상이 아니다');
  assert.equal(krFull.queryable, true);
  assert.equal(v.pools.find((p) => p.directorId === 'dir_us' && p.name === 'Incremental').vol.errors[0], 'Incremental-0002');
  assert.deepEqual(v.clients.map((c) => [c.director, c.name, c.jobs]), [['KR', 'bareos-fd', 0], ['KR', 'kr-fd', 3], ['US', 'us-fd', 1]]);
  // 범위 계정(KR 만) — US 없음 · 범위 밖 잡을 세지 않는다 · 자기 잡이 안 쓰는 FD(bareos-fd)는 숨긴다
  const k = POL.poolsView({ settings: SETTINGS, digests: DIGESTS, groups: GROUPS, allowed: new Set(['vc-kr']), admin: false, db, now: Date.now() });
  assert.deepEqual(k.directors.map((d) => d.name), ['KR']);
  assert.ok(k.pools.every((p) => p.directorId === 'dir_kr'));
  assert.deepEqual(k.clients.map((c) => c.name), ['kr-fd']);
  assert.ok(!JSON.stringify(k).includes('us-fd') && !JSON.stringify(k).includes('dir_us'));
  // 범위 밖 법인(vc-us)의 잡이 범위 안 Director(KR)에 묶여 있어도 범위 계정은 세지 않는다(정책 · 일정 탭 jobOk 와 같은 규칙)
  const cross = [...DIGESTS, { id: 'j9', vcenterId: 'vc-us', vmId: 'vc-us:vm-7', vmName: 'us-7', bareosJob: 'pv-x', pool: 'Full', client: 'bareos-fd', directorId: 'dir_kr' }];
  const cf = POL.poolsView({ settings: SETTINGS, digests: cross, groups: GROUPS, allowed: null, admin: true, db, now: Date.now() });
  assert.deepEqual([cf.pools.find((p) => p.directorId === 'dir_kr' && p.name === 'Full').used.jobs, cf.clients.find((c) => c.name === 'bareos-fd').jobs], [3, 1]);
  const ck = POL.poolsView({ settings: SETTINGS, digests: cross, groups: GROUPS, allowed: new Set(['vc-kr']), admin: false, db, now: Date.now() });
  assert.deepEqual([ck.pools.find((p) => p.name === 'Full').used.jobs, ck.clients.map((c) => c.name)], [2, ['kr-fd']]);
  // 실패 원문 — 관리자 판본만
  db.directors.dir_us = dirRecord({ name: 'US', clientsFail: { ok: false, code: 'denied', message: 'Command llist not authorized for portal' } });
  const a = POL.poolsView({ settings: SETTINGS, digests: DIGESTS, groups: GROUPS, allowed: null, admin: true, db, now: Date.now() });
  assert.match(a.directors.find((d) => d.id === 'dir_us').cmds.clients.message, /not authorized/);
  const u = POL.poolsView({ settings: SETTINGS, digests: DIGESTS, groups: GROUPS, allowed: null, admin: false, db, now: Date.now() });
  assert.equal(u.directors.find((d) => d.id === 'dir_us').cmds.clients.code, 'denied');
  assert.ok(!JSON.stringify(u).includes('not authorized'));
  // 아무것도 수집하지 않았으면 숫자는 모름(0 이 아니다)
  const none = POL.poolsView({ settings: SETTINGS, digests: DIGESTS, groups: GROUPS, allowed: null, admin: true, db: { directors: {} }, now: Date.now() });
  assert.deepEqual([none.kpis.pools, none.kpis.full, none.kpis.errorVols, none.kpis.clients, none.pools.length], [null, null, null, null, 0]);
});

test('② poolPolicyOf — 그룹 카드 적용 풀 · 보존(풀 보존 → 볼륨 최빈값 · 대소문자 · 목록에 없음 · 수집 전 null)', () => {
  const db = DB();
  const f = POL.poolPolicyOf('dir_kr', 'Full', db);
  assert.deepEqual([f.name, f.retentionSec, f.retentionFrom, f.full, f.at], ['Full', 31536000, 'pool', true, AT]);
  assert.equal(POL.poolPolicyOf('dir_kr', 'full', db).name, 'Full', '대소문자 무시(볼륨 목록의 풀 키는 소문자)');
  assert.deepEqual([POL.poolPolicyOf('dir_kr', 'Nope', db).missing, POL.poolPolicyOf('dir_kr', 'Nope', db).retentionSec], [true, null]);
  assert.equal(POL.poolPolicyOf('dir_jp', 'Full', db), null, '수집 전 — 모름');
  assert.equal(POL.poolPolicyOf('dir_kr', '', db), null);
  db.directors.dir_kr = dirRecord({ name: 'KR', pools: fx('list-pools') });   // 짧은 목록 — 풀 행에 보존 칸이 없다
  const s = POL.poolPolicyOf('dir_kr', 'Full', db);
  assert.deepEqual([s.retentionSec, s.retentionFrom], [31536000, 'volumes'], '볼륨 보존 최빈값으로');
  assert.equal(POL.poolPolicyOf('dir_us', 'Incremental', DB()).errorVols, 1);
});

test('② jobPolicyResolver — 그룹 → Director 스케줄 → 없음 · 풀 그룹 우선 · 보존 · 판정(정책 · 수동 · 모름 · 불일치)', () => {
  const now = Date.now();
  const resolve = POL.jobPolicyResolver({ settings: SETTINGS, groups: GROUPS, db: DB(), now });
  const r1 = resolve(DIGESTS[0], 'bareos');
  assert.deepEqual([r1.verdict, r1.src?.kind, r1.src?.name, r1.pool, r1.poolFrom, r1.retentionSec, r1.collected], ['policy', 'director', 'VMwareNightly', 'Full', 'job', 31536000, true]);
  assert.ok(r1.next.at > now && r1.next.at <= now + 2 * H + 1000);
  const r2 = resolve(DIGESTS[1], 'bareos');
  assert.deepEqual([r2.verdict, r2.src.kind, r2.src.name, r2.pool, r2.poolFrom, r2.keep, r2.group.id], ['policy', 'group', 'kr-night', 'Full', 'group', 3, 'g1'], '그룹 풀이 잡 풀을 이긴다');
  const r3 = resolve(DIGESTS[2], 'bareos');
  assert.deepEqual([r3.verdict, r3.src], ['manual', null], 'Director 스케줄에서 꺼진 잡은 일정 출처가 아니다');
  const r4 = resolve(DIGESTS[3], 'bareos');
  assert.deepEqual([r4.verdict, r4.collected], ['unknown', true], 'US 는 스케줄을 수집하지 못했다 — 모름(수동으로 단정하지 않는다)');
  assert.equal(resolve(DIGESTS[0], 'veeam').verdict, 'mismatch');
  assert.equal(r2.dup, '', 'pv-2 는 Director 스케줄에 없다');
  // 그룹 예약 + Director 스케줄 둘 다에 든 잡 — 두 번 돌 수 있다(dup)
  const db2 = DB();
  db2.directors.dir_kr = dirRecord({ name: 'KR', scheduler: { schedules: [{ name: 'VMwareNightly', enabled: '1', jobs: [{ name: 'pv-2', enabled: '1' }] }], preview: [] } });
  const rd = POL.jobPolicyResolver({ settings: SETTINGS, groups: GROUPS, db: db2, now })(DIGESTS[1], 'bareos');
  assert.deepEqual([rd.src.kind, rd.dup], ['group', 'VMwareNightly']);
  const offG = [{ ...GROUPS[0], schedule: { ...GROUPS[0].schedule, enabled: false } }];
  assert.equal(POL.jobPolicyResolver({ settings: SETTINGS, groups: offG, db: db2, now })(DIGESTS[1], 'bareos').dup, '', '그룹 예약이 꺼져 있으면 한 곳에서만 돈다');
  const r5 = POL.jobPolicyResolver({ settings: SETTINGS, groups: [], db: { directors: {} }, now })(DIGESTS[0], 'bareos');
  assert.deepEqual([r5.verdict, r5.collected, r5.retentionSec], ['unknown', false, null]);
});

test('② 오류 볼륨 — errorVolumeItems(범위 · 풀 이름 복원) · volumeRows(기간 · 나머지 한 줄 · 법인) · finishErrors 칸', () => {
  const db = DB();
  const items = POL.errorVolumeItems(SETTINGS, null, { db });
  assert.deepEqual(items.map((x) => [x.director, x.pool, x.n, x.names, x.vcIds, x.at]), [['US', 'Incremental', 1, ['Incremental-0002'], ['vc-us'], AT]], '볼륨 목록의 소문자 키 → 풀 이름');
  assert.deepEqual(POL.errorVolumeItems(SETTINGS, new Set(['vc-kr']), { db }), [], '범위 밖 Director 의 오류 볼륨은 싣지 않는다');
  const rows = BE.volumeRows(items, AT - 1, (id) => ({ 'vc-us': 'US-EAST' }[id] || id));
  assert.deepEqual(rows.map((r) => [r.kind, r.src, r.job, r.vc, r.vcName, r.open]), [['volume', 'bareos', 'Incremental-0002', 'vc-us', 'US-EAST', 'pools']]);
  assert.match(rows[0].msg, /볼륨 상태 Error · 풀 Incremental · Director US/);
  assert.deepEqual(BE.volumeRows(items, AT + 1), [], '창 밖(수집 시각이 기간 앞) — 행 없음');
  const many = BE.volumeRows([{ at: AT, director: 'X', vcIds: ['a', 'b'], pool: 'P', n: 25, names: Array.from({ length: 20 }, (_, i) => `v${i}`) }], 0);
  assert.equal(many.length, 21);
  assert.deepEqual([many[20].job, many[0].vc, many[0].vcName], ['그 밖 볼륨 5개', '', 'a, b'], '법인이 여럿이면 한 법인으로 단정하지 않는다');
  const fin = BE.finishErrors([...rows, { at: AT, src: 'bareos', kind: 'fail', job: 'j', msg: 'x', vcName: '' }]);
  assert.deepEqual([fin.counts.volume, fin.counts.bareos, fin.counts.fail], [1, 2, 1]);
});

test('② groupOverlaps — 그룹마다 overlapOf 그대로(Veeam 잡 · 다른 Bareos 회차) · 그룹 회차가 없으면 싣지 않는다 · groupItems 에 gid', () => {
  const T = Date.now() + H;
  const veeam = [{ name: 'J1', at: T, end: T + H }];
  const bareos = [
    { gid: 'g1', name: 'G1', at: T + 30 * 60_000, end: T + 90 * 60_000 },
    { gid: 'g2', name: 'G2', at: T + 5 * H, end: T + 6 * H },
    { name: 'Nightly', at: T + 5.5 * H, end: T + 6.5 * H, src: 'director' },
  ];
  const o = SC.groupOverlaps(veeam, bareos);
  assert.deepEqual(o.map((x) => [x.gid, x.veeam?.n ?? null, x.bareos?.n ?? null]), [['g1', 1, null], ['g2', null, 1]]);
  assert.deepEqual([o[0].veeam.from, o[0].veeam.to], [T + 30 * 60_000, T + H]);
  assert.deepEqual(SC.groupOverlaps(veeam, [bareos[2]]), [], 'Director 회차만 있으면 그룹 줄 없음');
  const gi = SC.groupItems([{ id: 'g9', name: 'x', vmIds: ['a'], schedule: { enabled: true } }], 0, 10, () => ({ at: 5, level: 'Full' }));
  assert.equal(gi[0].gid, 'g9');
});

/* ── 라우트 ── */
test('③ 라우트 — 보존 · 풀(범위 · canQuery) · 볼륨 즉시 조회(범위 404 · 이름 400 · operator 403 · 1분 기억 · Director 오류 502)', async () => {
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const S = await import('../src/bareos/settings.js');
  const svc = await import('../src/bareos/service.js');
  const R = await import('../src/routes/api/bareosPolicy.js');
  POL._resetPolicyForTest(); R._resetVolumeQueryForTest();
  const kr = S.addDirector({ name: 'KR', host: '10.1.2.3', consoleName: 'portal', password: 'pw' }).director;
  const us = S.addDirector({ name: 'US', host: '10.9.9.9', consoleName: 'portal', password: 'pw' }).director;
  S.saveSettings({ sites: [{ vcenterId: 'vc-kr', directorId: kr.id }, { vcenterId: 'vc-us', directorId: us.id }] });
  const prevSnap = store.snapshot;
  store.snapshot = { source: 'live', generatedAt: Date.now(), vcenters: [{ id: 'vc-kr', name: 'KR-HQ' }, { id: 'vc-us', name: 'US-EAST' }], hosts: [], vms: [] };
  const db = POL.loadPolicy();
  db.directors[kr.id] = dirRecord({ name: 'KR' });
  db.directors[us.id] = dirRecord({ name: 'US', volumes: usVolumes() });
  const sent = [];
  const volMap = { 'list volumes pool=Full': { volumes: [{ volumename: 'Full-0001', volstatus: 'Full', volbytes: '10' }] }, 'list volumes pool=Gone': Object.assign(new Error('Pool "Gone" not found'), { code: 'jsonrpc' }) };
  let opened = 0;
  svc._setSessionFactoryForTest(async (id) => { opened++; const s = fakeSession(volMap); const c = s.call; s.call = async (cmd, o) => { sent.push([id, cmd]); return c(cmd, o); }; return s; });
  let user = { username: 'adm2', role: 'admin', scope: { vcenters: ['vc-kr'] } };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); R.registerBareosPolicy(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const get = async (p, q = {}) => { const r = await fetch(`${base}${p}?${new URLSearchParams(q)}`); return { status: r.status, body: await r.json() }; };
  try {
    const v = await get('/tools/bareos-summary/pools');
    assert.deepEqual([v.status, v.body.directors.map((d) => d.name), v.body.canQuery, v.body.queryGapSec], [200, ['KR'], true, 60]);
    assert.ok(v.body.pools.every((p) => p.directorId === kr.id) && !JSON.stringify(v.body).includes('Incremental-0002'), '범위 밖 Director 의 볼륨 이름 없음');
    assert.equal(sent.length, 0, '보존 · 풀 조회는 Director 에 접속하지 않는다');
    assert.equal((await get('/tools/bareos-backup/policy/volumes', { directorId: us.id, pool: 'Full' })).status, 404, '범위 밖 Director — 존재 은닉');
    assert.equal((await get('/tools/bareos-backup/policy/volumes', { directorId: kr.id, pool: 'a b' })).status, 400);
    assert.equal((await get('/tools/bareos-backup/policy/volumes', { directorId: kr.id, pool: '-x' })).status, 400);
    assert.deepEqual([sent.length, opened], [0, 0], '거부한 요청은 Director 에 닿지 않는다(세션도 열지 않는다)');
    const ok = await get('/tools/bareos-backup/policy/volumes', { directorId: kr.id, pool: 'Full' });
    assert.deepEqual([ok.status, ok.body.rows.map((r) => r.name), ok.body.cached, sent], [200, ['Full-0001'], undefined, [[kr.id, 'list volumes pool=Full']]]);
    const again = await get('/tools/bareos-backup/policy/volumes', { directorId: kr.id, pool: 'Full' });
    assert.deepEqual([again.status, again.body.cached, again.body.at, sent.length], [200, true, ok.body.at, 1], '1분 안에는 기억한 결과(Director 를 다시 부르지 않는다)');
    assert.ok(again.body.nextSec > 0 && again.body.nextSec <= 60);
    const bad = await get('/tools/bareos-backup/policy/volumes', { directorId: kr.id, pool: 'Gone' });
    assert.deepEqual([bad.status, bad.body.code], [502, 'jsonrpc']);
    user = { username: 'op1', role: 'operator' };
    assert.equal((await get('/tools/bareos-backup/policy/volumes', { directorId: kr.id, pool: 'Full' })).status, 403, 'operator 는 즉시 조회를 일으키지 못한다');
    const vo = await get('/tools/bareos-summary/pools');
    assert.deepEqual([vo.status, vo.body.canQuery, vo.body.directors.length, vo.body.kpis.errorVols], [200, false, 2, 1], '전체 범위 operator 는 보기만');
  } finally { svc._setSessionFactoryForTest(null); store.snapshot = prevSnap; }
});

test('③ 소스 — bareos-summary 조회 라우트 본문에 Director 호출 없음 · 즉시 조회는 readDirector + 데모 필터 · 오류 로그 캐시 키에 정책 리비전', () => {
  const src = stripComments(fs.readFileSync(new URL('../src/routes/api/bareosPolicy.js', import.meta.url), 'utf8'));
  const decls = [...src.matchAll(/\bapi\.(get|post)\(\s*'([^']+)'/g)].map((m) => ({ lit: m[2], at: m.index }));
  const body = (lit) => { const i = decls.findIndex((d) => d.lit === lit); return src.slice(decls[i].at, i + 1 < decls.length ? decls[i + 1].at : src.length); };
  for (const lit of ['/tools/bareos-summary/pools', '/tools/bareos-summary/policy']) {
    for (const bad of ['onDirector', 'readDirector', 'withDirector', 'collectPolicy']) assert.ok(!body(lit).includes(bad), `${lit} 에 ${bad} 없음`);
  }
  const vq = body('/tools/bareos-backup/policy/volumes');
  assert.match(vq, /readDirector\(\{ demoOnly: isDemoGuest\(req\.user\) \}/);
  assert.match(vq, /requireRole\('admin'\)/);
  assert.ok(!vq.includes('onDirector('), '라우트 본문은 readDirector 만(스윕 audit2719b 가 데모 필터를 확인한다)');
  const grp = stripComments(fs.readFileSync(new URL('../src/routes/api/bareosGroups.js', import.meta.url), 'utf8'));
  assert.match(grp, /if \(r\.collected\) known = true; if \(r\.dup\) n\+\+;/);
  assert.match(grp, /dupVms = known \? n : null;/, '그룹 카드 두 번 실행 수 — 수집본이 없으면 0 이 아니라 null');
  const veeam = fs.readFileSync(new URL('../src/routes/api/veeam.js', import.meta.url), 'utf8');
  assert.match(veeam, /'backup-summary-errors'[\s\S]{0,200}\|b\$\{bareosRegistryRev\(\)\}\|bp\$\{bareosPolicyRev\(\)\}/, '오류 볼륨이 바뀌면 오류 로그 캐시도 바뀐다');
  const S = fs.readFileSync(new URL('../src/bareos/settings.js', import.meta.url), 'utf8');
  assert.match(S, /optional: Object\.freeze\(\{ schedules: true, jobdefs: true, filesets: true, clients: true \}\)/);
});
