/**
 * test/bareosPolicy2839.test.js — v2.839 Bareos 정책 · 일정 수집(백업 메뉴 개편 2차-a · 사용자 결정 '실제 출력 먼저 · show 추가 + 선택 명령 · 표준 검증').
 *   ① 파서 — 실측 고정값(test/fixtures/bareosPolicy2839 — Director 25.1.2 · 2026-11-01) · 멱등 · 엣지 회신 정제 · Run 줄 · ReDoS 비율
 *   ② 판정 — 풀 가득 참 · 사용 % · VM 적용 정책 · 수집 병합 · 보낼 차례
 *   ③ 작업 표 ops.policy — 명령 순서 · llist 거부 → list 폴백 · show 권한 없음은 그 항목만 · 세션째 끊기면 나머지 건너뜀 · 시한
 *   ④ 수집 collectPolicy(가짜 세션) · 화면 값 policyView(범위 · 가림 · 7일 · 겹침 · 미등록) · Summary 요약 · 24시간 띠 항목
 *   ⑤ 라우트 — 범위 404 · operator 403 · 1분 상한 429 · 감사 · 수집 POST 는 Director 에 읽기 명령만
 *   ⑥ 설정 · Profile ACL(show) · archScan 허용 목록
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2839-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';

const PP = await import('../src/bareos/policyParse.js');
const POL = await import('../src/bareos/policy.js');
const { OPS } = await import('../src/bareos/ops.js');
const { VALUE } = await import('../src/bareos/edgeResult.js');
const FX = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'bareosPolicy2839');
const fx = (f) => JSON.parse(fs.readFileSync(path.join(FX, `${f}.json`), 'utf8'));
const H = 3_600_000; const DAY = 24 * H;
const closers = [];
after(async () => { for (const c of closers) await c(); fs.rmSync(DIR, { recursive: true, force: true }); });

test('① 실측 고정값 — status scheduler · show schedules · show jobdefs · show filesets', () => {
  const s = PP.normScheduler(fx('status-scheduler'));
  assert.deepEqual(s.schedules.map((x) => [x.name, x.enabled, x.jobs.map((j) => j.name)]), [['WeeklyCycle', true, ['backup-bareos-fd']], ['WeeklyCycleAfterBackup', true, ['BackupCatalog']]]);
  assert.equal(s.preview.length, 8);
  assert.deepEqual(s.preview[0], { at: 1793620800 * 1000, schedule: 'WeeklyCycle', level: 'Incremental' }, 'runtime(epoch 초) → ms · datetime(현지 문자열)은 쓰지 않는다');
  assert.ok(s.preview.every((p, i) => i === 0 || s.preview[i - 1].at <= p.at), '시각 순');
  assert.equal(s.preview[1].level, 'Full');
  const ss = PP.normShowSchedules(fx('show-schedules'));
  assert.deepEqual(ss[0].run.map((r) => [r.level, r.at, r.pool]), [['Full', '21:00', null], ['Differential', '21:00', null], ['Incremental', '21:00', null]]);
  assert.equal(ss[0].run[1].text, 'Differential 2nd-5th Sat at 21:00', '원문 그대로');
  assert.match(ss[1].description, /catalog/);
  const jd = PP.normJobdefs(fx('show-jobdefs'));
  const d = jd.find((x) => x.name === 'DefaultJob');
  assert.deepEqual([d.storage, d.pool, d.fullPool, d.incPool, d.diffPool, d.schedule, d.fileset], ['File', 'Incremental', 'Full', 'Incremental', 'Differential', 'WeeklyCycle', 'SelfTest']);
  const p = jd.find((x) => x.name === 'PortalVmwareDefaults');
  assert.deepEqual([p.pool, p.storage, p.schedule, p.priority, p.ai], ['', '', '', null, null], '기본값인 칸은 Director 가 싣지 않는다 — 지어내지 않는다');
  const fsets = PP.normFilesets(fx('show-filesets'));
  const g = fsets.find((x) => x.name === 'PortalVmwareGeneric');
  assert.deepEqual([g.plugins, g.compression, g.signature, g.include], [['python3:module_name=bareos-fd-vmware'], 'LZ4', 'XXH128', 1]);
  assert.equal(fsets.find((x) => x.name === 'LinuxAll').exclude, 1);
});

test('① 실측 고정값 — llist pools · list pools(짧은) · list volumes(풀마다 · 소문자 키)', () => {
  const pl = PP.normPools(fx('llist-pools'));
  const inc = pl.find((x) => x.name === 'Incremental');
  assert.deepEqual([inc.numVols, inc.maxVols, inc.volRetentionSec, inc.maxVolBytes, inc.autoPrune, inc.recycle, inc.type], [1, 100, 2592000, 1073741824, true, true, 'Backup'], '문자열 → 수 · "1" → true');
  const short = PP.normPools(fx('list-pools'));
  assert.deepEqual([short[1].volRetentionSec, short[1].maxVolBytes, short[1].autoPrune], [null, null, null], '짧은 목록에 없는 칸은 모름(0 이 아니다)');
  const v = PP.normVolumes(fx('list-volumes'));
  const full = v.pools.find((x) => x.pool === 'full');
  assert.deepEqual([full.n, full.status, full.bytes, full.bytesN, full.retentionSec], [3, { Full: 3 }, 3145942 + 3145942 + 2097366, 3, 31536000]);
  assert.equal(full.oldest, Date.parse('2026-10-30T08:41:32'), 'lastwritten 은 Director 현지 — 포탈 서버 현지로 읽는다(기존 규칙)');
  assert.equal(v.pools.find((x) => x.pool === 'incremental').status.Append, 1);
  assert.equal(v.total, 4);
});

test('① 멱등(엣지 회신을 중앙이 같은 함수로 다시 거른다) · 정제 · 거부 사유', () => {
  for (const [k, f] of [['scheduler', 'status-scheduler'], ['schedules', 'show-schedules'], ['jobdefs', 'show-jobdefs'], ['filesets', 'show-filesets'], ['pools', 'llist-pools'], ['volumes', 'list-volumes']]) {
    const once = PP.NORMALIZE[k](fx(f));
    assert.deepEqual(PP.NORMALIZE[k](JSON.parse(JSON.stringify(once))), once, `${k} 멱등`);
  }
  const ai = PP.normJobdefs({ jobdefs: { A: { name: 'A', alwaysincremental: true, alwaysincrementalkeepnumber: '7', alwaysincrementaljobretention: '7 days' } } });
  assert.deepEqual(PP.normJobdefs(JSON.parse(JSON.stringify(ai)))[0].ai, { on: true, keep: 7, retention: '7 days', maxFullAge: '' }, 'Always Incremental 표지가 두 번째 정규화에서 사라지지 않는다');
  // 엣지 회신 정제 — 모르는 키 · 필드 버림 · 성공인데 값이 이상하면 빈 값
  const r = VALUE.policy({ results: { scheduler: { ok: true, ms: 5, value: fx('status-scheduler'), evil: 1 }, hack: { ok: true }, volumes: { ok: false, code: 'x'.repeat(99), message: 'm'.repeat(999) } }, version: '25.1.2', other: 1 });
  assert.deepEqual(Object.keys(r.results).sort(), ['scheduler', 'volumes']);
  assert.equal(r.results.scheduler.evil, undefined);
  assert.equal(r.results.volumes.code.length, 32);
  assert.equal(r.results.volumes.message.length, 300);
  assert.equal(r.other, undefined);
  assert.deepEqual(PP.normScheduler({ preview: [{ runtime: 1793707200, schedule: 'B', level: 'Full' }, { runtime: 1793620800, schedule: 'A', level: 'I' }] }).preview.map((p) => p.schedule), ['A', 'B'], '미리보기는 시각 순으로 정렬(Director 순서를 믿지 않는다)');
  assert.deepEqual(PP.normScheduler({ schedules: 'x', preview: [{ runtime: 'abc', schedule: 'S' }, { runtime: 1, schedule: 'S' }, { runtime: 1793620800 }] }), { schedules: [], preview: [] }, '시각을 모르거나 이름이 없는 회차는 버린다');
  assert.equal(PP.deniedText('Command "show" not authorized.'), true);
  assert.equal(PP.deniedText('show: is an invalid command.'), true);
  assert.equal(PP.deniedText('connection reset'), false);
});

test('① Run 줄 — 레벨 · 시각 · 풀 · 못 뽑으면 원문만 · ReDoS 비율', () => {
  assert.deepEqual(PP.parseRunLine('Level=Full Pool=VMware-Full 1st sat at 02:00'), { text: 'Level=Full Pool=VMware-Full 1st sat at 02:00', level: 'Full', at: '02:00', pool: 'VMware-Full' });
  assert.deepEqual(PP.parseRunLine('Incremental mon-sat at 2:05'), { text: 'Incremental mon-sat at 2:05', level: 'Incremental', at: '02:05', pool: null });
  assert.deepEqual(PP.parseRunLine('weird text'), { text: 'weird text', level: null, at: null, pool: null });
  assert.equal(PP.parseRunLine('Full at 25:00').at, null, '없는 시각');
  const t = (n) => { const s = `${'a'.repeat(n)} at ${' '.repeat(n)}`; const t0 = process.hrtime.bigint(); for (let i = 0; i < 200; i++) PP.parseRunLine(s); return Number(process.hrtime.bigint() - t0); };
  t(1000);
  const small = t(2000); const big = t(20000);
  assert.ok(big / small < 6, `입력을 먼저 자른다(비율 ${(big / small).toFixed(1)})`);
});

test('② 판정 — 풀 가득 참 · 사용 %(실측 Full 풀 100/100)', () => {
  const pools = PP.normPools(fx('llist-pools'));
  const vols = PP.normVolumes(fx('list-volumes')).pools;
  const vOf = (n) => vols.find((x) => x.pool === n.toLowerCase());
  const full = pools.find((p) => p.name === 'Full');
  assert.equal(PP.poolFull(full, vOf('Full'), 0), true, '볼륨 100/100 · 쓸 수 있는 볼륨 0 · Scratch 0');
  assert.equal(PP.poolFull(full, vOf('Full'), 2), false, 'Scratch 에서 가져올 볼륨이 있으면 아니다');
  assert.equal(PP.poolFull(full, { ...vOf('Full'), status: { Full: 2, Purged: 1 } }, 0), false, 'Purged 는 다시 쓴다');
  assert.equal(PP.poolFull(full, null, 0), null, '볼륨을 모르면 모름');
  assert.equal(PP.poolFull({ ...full, numVols: 5 }, { status: { Full: 5 } }, 0), false, '상한 아래면 새 볼륨을 만들 수 있다 — 쓸 볼륨이 없어도 가득 참이 아니다');
  assert.equal(PP.poolFull(full, vOf('Full'), null), null, 'Scratch 를 모르면 모름');
  const inc = pools.find((p) => p.name === 'Incremental');
  assert.equal(PP.poolFull(inc, vOf('Incremental'), 0), false);
  assert.equal(PP.poolFull({ ...full, maxVols: 0 }, vOf('Full'), 0), false, 'MaxVols 0 = 제한 없음');
  assert.equal(PP.poolFull({ ...full, maxVols: null }, vOf('Full'), 0), null);
  assert.equal(PP.poolFull(pools.find((p) => p.name === 'Scratch'), null, 0), false);
  assert.equal(PP.poolUsagePct(inc, vOf('Incremental')), Math.round((64476 / (100 * 1073741824)) * 1000) / 10);
  assert.equal(PP.poolUsagePct(full, vOf('Full')), null, 'MaxVolBytes 0(제한 없음)이면 용량을 모른다 — 지어내지 않는다');
  assert.equal(PP.poolUsagePct(inc, { bytes: 0, bytesN: 0 }), null, '바이트를 읽은 볼륨이 없으면 모름');
});

test('② 판정 — VM 적용 정책 · 수집 병합 · 보낼 차례', () => {
  const j = { bareosJob: 'pv-1' };
  const V = POL.vmPolicyVerdict;
  assert.equal(V({ job: null, method: 'bareos' }), 'unregistered');
  assert.equal(V({ job: null, method: 'veeam' }), null);
  assert.equal(V({ job: j, method: 'veeam', group: { schedule: { enabled: true } } }), 'mismatch', '정책이 Bareos 가 아니면 불일치가 먼저');
  assert.equal(V({ job: j, method: 'bareos', group: { schedule: { enabled: true } }, inDirSchedule: null }), 'policy', '그룹 예약이면 수집본이 없어도 정책 있음');
  assert.equal(V({ job: j, method: 'bareos', group: { schedule: { enabled: false } }, inDirSchedule: true }), 'policy');
  assert.equal(V({ job: j, method: '', group: null, inDirSchedule: false }), 'manual', '정책 미정 · 잡만 있고 일정 없음');
  assert.equal(V({ job: j, method: null, group: null, inDirSchedule: null }), 'unknown', '수집본도 없으면 모름(수동이라 단정하지 않는다)');
  // 병합 — 실패한 명령은 지난 값을 지우지 않는다 · 필수 셋이 다 성공해야 ok
  const keys = PP.POLICY_KEYS;
  const ok = { results: Object.fromEntries(keys.map((k) => [k, { ok: true, ms: 1, value: k === 'scheduler' ? { schedules: [], preview: [] } : [] }])), version: '25' };
  const a = POL.mergeDirector(undefined, { name: 'KR', keys, res: ok, err: null, at: 100, trigger: 'timer' });
  assert.deepEqual([a.ok, a.any, a.cmds.pools.ok, a.data.pools.at], [true, true, true, 100]);
  const b = POL.mergeDirector(a, { name: 'KR', keys, res: { results: { ...ok.results, pools: { ok: false, code: 'denied', message: 'no' } } }, err: null, at: 200, trigger: 'manual' });
  assert.deepEqual([b.ok, b.cmds.pools.ok, b.cmds.pools.code, b.data.pools.at, b.version], [false, false, 'denied', 100, '25'], '지난 값 · 그 시각 유지');
  const c = POL.mergeDirector(b, { name: 'KR', keys: keys.filter((k) => k !== 'jobdefs'), res: null, err: { code: 'connect', message: 'x' }, at: 300 });
  assert.deepEqual([c.cmds.jobdefs, c.data.jobdefs.at, c.cmds.scheduler.code, c.data.scheduler.at, c.any, c.error.code], [undefined, 200, 'connect', 200, false, 'connect'], '끈 선택 명령은 상태만 지우고 지난 값은 둔다 · 세션 실패도 지난 값 유지');
  // 보낼 차례(포탈 시각)
  const { dayIndex, dayStartMs } = await_dayKey();
  const T0 = dayStartMs(dayIndex(Date.now()));
  const ps = { enabled: true, time: '06:10' };
  const at = (h, m = 0) => T0 + h * H + m * 60_000;
  assert.equal(POL.policyDue(ps, {}, at(6, 9)).due, false);
  assert.equal(POL.policyDue(ps, {}, at(6, 10)).due, true);
  const day = POL.policyDue(ps, {}, at(7)).day;
  assert.equal(POL.policyDue(ps, { day, ok: true }, at(9)).due, false);
  assert.equal(POL.policyDue(ps, { day, ok: false, tries: 1, nextTry: at(7, 30) }, at(7, 10)).due, false);
  assert.equal(POL.policyDue(ps, { day, ok: false, tries: POL.TRIES_MAX }, at(23)).due, false);
  assert.equal(POL.policyDue({ ...ps, enabled: false }, {}, at(9)).due, false);
});
let _dk = null;
function await_dayKey() { return _dk; }
_dk = await import('../src/util/dayKey.js');

/** 가짜 세션 — 명령 → 고정값(또는 오류). */
function fakeSession(map, { banner = 'OK: bareos-dir Version: 25.1.2~pre73 (26 October 2026)' } = {}) {
  const sent = [];
  return {
    sent, info: { banner },
    call: async (cmd) => {
      sent.push(cmd);
      const v = map[cmd];
      if (v instanceof Error) throw v;
      if (v === undefined) { const e = new Error(`${cmd.split(' ')[0]}: is an invalid command.`); e.code = 'jsonrpc'; throw e; }
      return JSON.parse(JSON.stringify(v));
    },
  };
}
const rpc = (m) => Object.assign(new Error(m), { code: 'jsonrpc' });
const fullMap = () => ({
  'status scheduler days=7': fx('status-scheduler'), 'llist pools': fx('llist-pools'), 'list volumes': fx('list-volumes'),
  'show schedules': fx('show-schedules'), 'show jobdefs': fx('show-jobdefs'), 'show filesets': fx('show-filesets'),
});

test('③ ops.policy — 순서 · 읽기 명령만 · llist 거부 → list 폴백 · show 권한 없음은 그 항목만 · 세션째 끊김 · 시한 · 판', async () => {
  const s = fakeSession(fullMap());
  const r = await OPS.policy(s, { keys: PP.POLICY_KEYS });
  assert.deepEqual(s.sent, PP.POLICY_CMDS.map((c) => c.cmd));
  assert.ok(s.sent.every((c) => /^(status scheduler|llist pools|list (pools|volumes)|show (schedules|jobdefs|filesets))/.test(c)), '읽기 전용 명령만');
  assert.ok(Object.values(r.results).every((x) => x.ok));
  assert.equal(r.version, '25.1.2~pre73');
  assert.equal(r.results.scheduler.value.preview.length, 8);
  const m = fullMap(); delete m['llist pools']; m['list pools'] = fx('list-pools');
  m['show jobdefs'] = rpc('Command "show" not authorized.'); m['show filesets'] = rpc('Command "show" not authorized.');
  const s2 = fakeSession(m);
  const r2 = await OPS.policy(s2, { keys: PP.POLICY_KEYS });
  assert.deepEqual([r2.results.pools.ok, r2.results.pools.fallback, r2.results.pools.value[1].volRetentionSec], [true, true, null], 'llist 를 거부하면 짧은 list 로');
  assert.deepEqual([r2.results.jobdefs.code, r2.results.filesets.code, r2.results.volumes.ok], ['denied', 'denied', true], '권한 없음은 그 항목만 — 나머지는 계속');
  const dead = fullMap(); dead['llist pools'] = Object.assign(new Error('closed'), { code: 'closed' });
  const s3 = fakeSession(dead);
  const r3 = await OPS.policy(s3, { keys: PP.POLICY_KEYS });
  assert.deepEqual(s3.sent, ['status scheduler days=7', 'llist pools'], '세션째 끊기면 남은 명령은 보내지 않는다');
  assert.deepEqual(['volumes', 'schedules', 'jobdefs', 'filesets'].map((k) => r3.results[k].code), ['skipped', 'skipped', 'skipped', 'skipped']);
  const ac = new AbortController(); ac.abort();
  const r4 = await OPS.policy(fakeSession(fullMap()), { keys: ['scheduler', 'pools'] }, { signal: ac.signal });
  assert.deepEqual([r4.results.scheduler.code, Object.keys(r4.results).length], ['skipped', 2], '시한 신호면 시작하지 않는다 · 고른 키만');
  const r5 = await OPS.policy(fakeSession(fullMap()), { keys: ['scheduler', 'evil'] });
  assert.deepEqual(Object.keys(r5.results), ['scheduler'], '모르는 키는 무시');
});

test('④ 수집(가짜 세션 · Director 둘) · 화면 값(범위 · 가림 · 7일 · 겹침 · 미등록) · Summary 요약 · 24시간 띠', async () => {
  const S = await import('../src/bareos/settings.js');
  const svc = await import('../src/bareos/service.js');
  const REG = await import('../src/bareos/registry.js');
  const { store } = await import('../src/store.js');
  POL._resetPolicyForTest();
  const kr = S.addDirector({ name: 'KR', host: '10.1.2.3', consoleName: 'portal', password: 'pw' }).director;
  const us = S.addDirector({ name: 'US', host: '10.9.9.9', consoleName: 'portal', password: 'pw' }).director;
  const prevSnap = store.snapshot;
  store.snapshot = { source: 'live', generatedAt: Date.now(), vcenters: [{ id: 'vc-kr', name: 'KR-HQ' }, { id: 'vc-us', name: 'US-EAST' }], hosts: [], vms: [
    { id: 'vc-kr:vm-1', vcenterId: 'vc-kr', name: 'kr-app-01', guestOS: 'windows9Server64Guest' },
    { id: 'vc-kr:vm-2', vcenterId: 'vc-kr', name: 'kr-db-02', guestOS: 'rhel9_64Guest' },
    { id: 'vc-us:vm-1', vcenterId: 'vc-us', name: 'us-web-01', guestOS: 'rhel9_64Guest' },
  ] };
  S.saveSettings({ sites: [{ vcenterId: 'vc-kr', directorId: kr.id }, { vcenterId: 'vc-us', directorId: us.id }] });
  // KR Director 의 스케줄에 포탈 잡 pv-kr-1 이 든다 · US 는 show 권한 없음
  const krMap = fullMap();
  krMap['status scheduler days=7'] = { schedules: [{ name: 'VMwareNightly', enabled: true, jobs: [{ name: 'pv-kr-1', enabled: true }, { name: 'pv-us-1', enabled: true }, { name: 'BackupCatalog', enabled: true }, { name: 'pv-off', enabled: false }] }, { name: 'Unused', enabled: true, jobs: [] }],
    preview: [{ runtime: Math.floor((Date.now() + 2 * H) / 1000), schedule: 'VMwareNightly', level: 'Incremental' }, { runtime: Math.floor((Date.now() + 26 * H) / 1000), schedule: 'VMwareNightly', level: 'Full' }] };
  const usMap = fullMap(); usMap['show jobdefs'] = rpc('Command "show" not authorized.');
  svc._setSessionFactoryForTest(async (id) => fakeSession(id === kr.id ? krMap : usMap));
  try {
    POL.loadPolicy().directors.dir_gone = { name: 'gone', at: 1 };
    const r = await POL.collectPolicy({ trigger: 'manual' });
    assert.deepEqual(r.done.map((x) => x.ok).sort(), [true, true]);
    assert.equal(POL.loadPolicy().directors.dir_gone, undefined, '설정에서 사라진 Director 의 수집본은 지운다');
    const db = POL.loadPolicy();
    assert.deepEqual([db.directors[us.id].cmds.jobdefs.code, db.directors[us.id].ok], ['denied', true], '선택 명령 실패는 Director ok 를 떨어뜨리지 않는다');
    assert.ok(fs.existsSync(path.join(DIR, 'bareos-policy.json')));
    assert.equal(fs.statSync(path.join(DIR, 'bareos-policy.json')).mode & 0o777, 0o600);
    // 원장 — pv-kr-1(KR · 스케줄 든) · pv-kr-2(KR · 스케줄 없음) · pv-us-1(US)
    REG.addJob({ vcenterId: 'vc-kr', vmId: 'vc-kr:vm-1', vmName: 'kr-app-01', dc: 'DC', folder: 'A', directorId: kr.id, bareosJob: 'pv-kr-1', client: 'kr-fd', storage: 'kr-sd', pool: 'Full' });
    REG.addJob({ vcenterId: 'vc-kr', vmId: 'vc-kr:vm-2', vmName: 'kr-db-02', dc: 'DC', folder: 'A', directorId: kr.id, bareosJob: 'pv-kr-2', client: 'kr-fd', storage: 'kr-sd', pool: 'Incremental' });
    REG.addJob({ vcenterId: 'vc-us', vmId: 'vc-us:vm-1', vmName: 'us-web-01', dc: 'DC', folder: 'A', directorId: kr.id, bareosJob: 'pv-us-1', client: 'kr-fd', storage: 'kr-sd', pool: 'Full' });
    const settings = S.loadSettings();
    const digests = REG.jobDigests();
    const vmsById = new Map(store.snapshot.vms.map((v) => [v.id, v]));
    const names = (id) => ({ 'vc-kr': 'KR-HQ', 'vc-us': 'US-EAST' }[id] || id);
    const marks = { 'vc-kr:vm-2': { method: 'veeam' }, 'vc-us:vm-9': { method: 'bareos' } };
    store.snapshot.vms.push({ id: 'vc-us:vm-9', vcenterId: 'vc-us', name: 'us-new-09' });
    vmsById.set('vc-us:vm-9', store.snapshot.vms[3]);
    const now = Date.now();
    const groups = [{ id: 'g1', name: 'kr-night', vcenterId: 'vc-kr', directorId: kr.id, vmIds: ['vc-kr:vm-9'], schedule: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], time: (() => { const d = new Date(now + 2 * H + 20 * 60_000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; })(), level: 'Incremental', fullDays: [] } }];
    const full = POL.policyView({ settings, digests, groups, marks, vmsById, allowed: null, admin: true, now, vcName: names });
    const vOf = (v, n) => v.vms.find((x) => x.vm === n);
    assert.deepEqual([vOf(full, 'kr-app-01').verdict, vOf(full, 'kr-db-02').verdict, vOf(full, 'us-web-01').verdict, vOf(full, 'us-new-09').verdict], ['policy', 'mismatch', 'policy', 'unregistered']);
    assert.equal(vOf(full, 'kr-app-01').os, 'windows');
    assert.deepEqual(vOf(full, 'kr-app-01').src, { kind: 'director', name: 'VMwareNightly', text: '' }, 'Run 줄은 show schedules 에 없는 스케줄이면 빈 글자');
    assert.equal(vOf(full, 'kr-app-01').retentionSec, 31536000, '잡 풀(Full)의 Volume Retention');
    assert.deepEqual(full.kpis.vm, { total: 4, policy: 2, manual: 0, unregistered: 1, mismatch: 1, unknown: 0 });
    assert.equal(full.kpis.pools.full, 2, 'KR · US 의 Full 풀(실측 100/100) 둘 다 가득 참');
    assert.equal(full.kpis.jobdefs, 2, 'US 는 show 권한 없음 — KR 의 JobDefs 만');
    const nightly = full.schedules.find((x) => x.name === 'VMwareNightly');
    assert.deepEqual([nightly.jobs, nightly.portalJobs, nightly.overlap], [3, 2, ['kr-night']], '꺼진 잡은 세지 않는다 · Director 자체 잡은 전체 범위만 · 같은 Director 의 그룹 회차와 1시간 안 — 겹침');
    assert.equal(full.schedules.find((x) => x.name === 'Unused').jobs, 0);
    assert.equal(full.kpis.schedules.unused, 1, 'Unused 만 — US 실측 스케줄은 Director 자체 잡(BackupCatalog 등)이 있어 전체 범위에서는 쓰는 잡이 있다');
    const w = full.week.reduce((a, x) => a + x.jobs, 0);
    assert.ok(w >= 2, '7일 칸에 Director 회차 × 잡');
    assert.ok(full.directors.find((d) => d.id === us.id).cmds.jobdefs.message, '관리자 판본은 Director 거부 원문');
    const op = POL.policyView({ settings, digests, groups, marks, vmsById, allowed: null, admin: false, now, vcName: names });
    assert.equal(op.directors.find((d) => d.id === us.id).cmds.jobdefs.code, 'denied');
    assert.ok(!JSON.stringify(op).includes('not authorized'), '관리자 판본이 아니면 원문 없음(코드만)');
    // 범위 계정(KR 만) — US 잡 · Director 가 보이지 않는다 · 원문 없음
    const kOnly = POL.policyView({ settings, digests, groups, marks, vmsById, allowed: new Set(['vc-kr']), admin: false, now, vcName: names });
    assert.deepEqual(kOnly.directors.map((d) => d.name), ['KR']);
    assert.ok(!kOnly.vms.some((x) => x.vc === 'vc-us'));
    assert.equal(kOnly.schedules.find((x) => x.name === 'VMwareNightly').jobs, 1, '범위 밖 법인의 잡은 세지 않는다');
    assert.ok(!kOnly.schedules.some((x) => x.name === 'Unused' || x.name === 'WeeklyCycle'), '자기 법인 잡이 없는 스케줄은 범위 계정에 보이지 않는다(쓰는 잡 0 · Director 자체 잡)');
    assert.ok(!JSON.stringify(kOnly).includes('not authorized'));
    assert.ok(!JSON.stringify(kOnly).includes('pv-us-1'));
    // Summary 요약 · 24시간 띠
    const sum = POL.policySummary(settings, new Set(['vc-kr']), digests, { now });
    assert.deepEqual([sum.collected, sum.directors, sum.pools.full, sum.schedules], [1, 1, 1, 1]);
    assert.ok(sum.next > now && sum.next <= now + 2 * H + 1000);
    assert.equal(POL.policySummary(settings, new Set(['vc-zz']), digests, { now }), null, '범위 안 Director 가 없으면 null(수집 전)');
    const items = POL.directorScheduleItems(settings, digests, now, now + 7 * DAY);
    assert.deepEqual(items.get('vc-kr').map((x) => [x.vms, x.level, x.src]), [[1, 'Incremental', 'director'], [1, 'Full', 'director']], '법인마다 그 법인 잡 수');
    assert.deepEqual([...items.keys()].sort(), ['vc-kr', 'vc-us'], '포탈 잡이 아닌 잡(BackupCatalog)은 어느 법인 띠에도 넣지 않는다');
    assert.equal(items.get('vc-us').length, 2);
    const nx = POL.directorNextByJob(kr.id, now);
    assert.equal(nx.get('pv-kr-1').schedule, 'VMwareNightly');
    assert.equal(nx.has('pv-kr-2'), false);
  } finally { svc._setSessionFactoryForTest(null); store.snapshot = prevSnap; }
});

test('⑤ 라우트 — 수집본 화면(범위) · 지금 수집(범위 404 · operator 403 · 1분 429 · 감사)', async () => {
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const S = await import('../src/bareos/settings.js');
  const svc = await import('../src/bareos/service.js');
  const { registerBareosPolicy } = await import('../src/routes/api/bareosPolicy.js');
  POL._resetPolicyForTest();
  const prevSnap = store.snapshot;
  store.snapshot = { source: 'live', generatedAt: Date.now(), vcenters: [{ id: 'vc-kr', name: 'KR-HQ' }, { id: 'vc-us', name: 'US-EAST' }], hosts: [], vms: [] };
  const st = S.loadSettings();
  const kr = st.sites.find((x) => x.vcenterId === 'vc-kr').directorId; const us = st.sites.find((x) => x.vcenterId === 'vc-us').directorId;
  const sent = [];
  svc._setSessionFactoryForTest(async (id) => { const s = fakeSession(fullMap()); const c = s.call; s.call = async (cmd, o) => { sent.push([id, cmd]); return c(cmd, o); }; return s; });
  let user = { username: 'adm2', role: 'admin', scope: { vcenters: ['vc-kr'] } };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerBareosPolicy(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const call = async (method, p, body) => { const r = await fetch(`${base}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    assert.equal((await call('POST', '/tools/bareos-backup/policy/collect', { directorIds: [us] })).status, 404, '범위 밖 Director — 존재 은닉');
    const ok = await call('POST', '/tools/bareos-backup/policy/collect', { directorIds: [kr] });
    assert.deepEqual([ok.status, ok.body.started], [202, [kr]]);
    for (let i = 0; i < 50 && POL.policyBusy(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(sent.length && sent.every(([id, c]) => id === kr && !/^(run|configure|delete|cancel|restore|enable|disable)\b/.test(c)), 'Director 에는 읽기 명령만 · 고른 Director 만');
    assert.equal((await call('POST', '/tools/bareos-backup/policy/collect', { directorIds: [kr] })).status, 429, 'Director 마다 1분에 한 번');
    const v = await call('GET', '/tools/bareos-summary/policy');
    assert.deepEqual([v.status, v.body.directors.map((d) => d.name), v.body.canCollect], [200, ['KR'], true]);
    assert.ok(v.body.directors[0].at > 0);
    user = { username: 'op1', role: 'operator' };
    assert.equal((await call('POST', '/tools/bareos-backup/policy/collect', {})).status, 403, 'operator 는 수집을 일으키지 못한다');
    const vo = await call('GET', '/tools/bareos-summary/policy');
    assert.deepEqual([vo.status, vo.body.canCollect, vo.body.directors.length], [200, false, 2], '전체 범위 operator 는 보기만 · 두 Director');
    const audit = fs.readFileSync(path.join(DIR, 'audit.ndjson'), 'utf8');
    assert.match(audit, /bareos-policy\.collect/);
  } finally { svc._setSessionFactoryForTest(null); store.snapshot = prevSnap; }
});

test('⑥ 설정(정책 수집) · Profile Command ACL 에 show(서버 · 웹 같은 줄) · archScan 허용 목록 · 작업 표 등록', async () => {
  const S = await import('../src/bareos/settings.js');
  assert.deepEqual(S.normPolicySettings({ enabled: false, time: '7:00', optional: { jobdefs: false }, off: ['dir_ab', 'x y', 'dir_ab'] }),
    { enabled: false, time: '06:10', optional: { schedules: true, jobdefs: false, filesets: true }, off: ['dir_ab'] });
  S.saveSettings({ defaults: { policy: { enabled: true, time: '05:40', optional: { filesets: false }, off: [] } } });
  S._resetForTest();
  assert.deepEqual(S.loadSettings().defaults.policy, { enabled: true, time: '05:40', optional: { schedules: true, jobdefs: true, filesets: false }, off: [] });
  assert.deepEqual(POL.policyKeys(S.loadSettings().defaults.policy), ['scheduler', 'pools', 'volumes', 'schedules', 'jobdefs'], '끈 선택 명령은 보내지 않는다');
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const acl = (s) => /Command ACL = ([^'`]+)/.exec(s)?.[1].trim();
  const a = acl(read('../src/bareos/autoSetup.js')); const b = acl(read('../../web/src/views/tools/bareosText.js'));
  assert.equal(a, b);
  assert.ok(a.split(/,\s*/).includes('show'), 'v2.839 정책 수집의 선택 명령');
  const { ROUTE_GATE_ALLOW } = await import('../src/portalcheck/archScan.js');
  assert.match(ROUTE_GATE_ALLOW['POST /api/tools/bareos-backup/policy/collect'], /scopedDirectors/);
  const { RESULT_MS, EDGE_MUTATING } = await import('../src/bareos/edgeOps.js');
  assert.ok(RESULT_MS.policy > 0 && !EDGE_MUTATING.has('policy'), '읽기 전용 — 회신이 없으면 결과 모름이 아니라 실패');
});
