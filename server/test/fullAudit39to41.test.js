/**
 * 전체 점검 39 · 40 · 41회차 회귀.
 *  40회차: F1 롤백된 행은 롤업에 넣지 않음(소스) · F3 원시 보존 밖 1시간 버킷은 다시 집계하지 않음 · F4 시한 지난 배포본에서 억제 keys 를 잇지 않음 · F5 못 연 파일 표시
 *  41회차: F1 Horizon 못 읽은(unparsed) 서버 · F2 HAS_MORE 페이징 · F4 끊긴 GPU 호스트 · F5 du 재개 시한 · F7 B 시리즈 프로파일
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'full-audit-39-41-'));
process.env.CONFIG_DIR = path.join(TMP, 'cfg');
process.env.DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const SRC = new URL('../src/', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, SRC), 'utf8');

test('40회차 F3 · F5: 원시 보존 밖 1시간 버킷은 다시 집계하지 않고 · 못 연 파일은 0행으로 더하지 않는다(소스)', () => {
  const s = read('bmusage/monthStore.js');
  assert.match(s, /if \(rawKeepFrom != null && h < rawKeepFrom\) \{ out\.expiredHourly = \(out\.expiredHourly \|\| 0\) \+ 1; hourOk\.push\(pd\); continue; \}/);
  assert.match(s, /catch \{ unread\.push\(f\.name\); \}/);
  assert.match(s, /export function devRollupMissed\(\)/);
});

test('40회차 F4: 시한(24h)이 지난 직전 배포본에서는 태그 창 keys 를 이어 쓰지 않는다', async () => {
  const ST = await import('../src/bmusage/maint/store.js');
  const J = await import('../src/bmusage/maint/judge.js');
  const now = Date.now(); const DAY = 86_400_000;
  const win = (keys, extra = {}) => ({ id: 'mw-abc12345', name: '태그 정비', reason: '점검', vcenterId: 'vc-1', tz: 'Asia/Seoul', rev: 1, by: 'o', at: now - DAY, confirmedAt: now - DAY,
    target: { kind: 'tag', tag: 'role:db', keys, ...extra }, schedule: { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '00:00', durMin: 720 }, scopes: { alerts: true } });
  ST.saveDeployed([win(['old-a', 'old-b'])], { sig: 'x', now: now - 3 * DAY, history: [] });
  ST._resetMaintStoreForTest();
  const r = ST.saveDeployed([win([], { keysUnknown: true })], { sig: 'y', now, history: [] });
  ST._resetMaintStoreForTest();
  assert.equal(r.carried ?? 0, 0);
  const after = ST.windowsForJudge(now);
  assert.deepEqual(after.windows.find((w) => w.id === 'mw-abc12345')?.target?.keys || [], []);
  const at = (() => { const d = new Date(now + 9 * 3_600_000); d.setUTCHours(3, 0, 0, 0); return d.getTime() - 9 * 3_600_000; })();
  assert.equal(J.maintStateFor(after.windows, { vcenterId: 'vc-1', key: 'old-a' }, at).active, false);
  // 대조: 시한 안 직전판이면 잇는다(v2.954 D-1)
  ST.saveDeployed([win(['old-a'])], { sig: 'z', now: now - 60_000, history: [] });
  ST._resetMaintStoreForTest();
  assert.equal(ST.saveDeployed([win([], { keysUnknown: true })], { sig: 'w', now, history: [] }).carried, 1);
});

test('41회차 F1: Horizon 계정 필드를 못 읽은 주기는 DB 왕복 뒤에도 읽은 서버가 아니다', async () => {
  const s = read('horizon/sessionDb.js');
  assert.match(s, /parsed: r\.kind !== 'unparsed',/);
  assert.match(s, /r\.ok && r\.parsed !== false && r\.kind !== 'unparsed' \? 1 : 0/);
  const { combineServers } = await import('../src/horizon/sessions.js');
  const t = combineServers([{ ok: true, parsed: false, kind: 'unparsed', sessions: 3, names: [] }]);
  assert.equal(t.serversOk, 0);
  assert.equal(t.serversFailed, 1);
  assert.notEqual(t.users, 0, '못 읽은 서버를 0명으로 세지 않는다');
});

test('41회차 F2: HAS_MORE_RECORDS true 면 짧은 페이지에서도 다음 페이지(소스)', () => {
  const s = read('horizon/sessionCollect.js');
  assert.match(s, /if \(more !== true && body\.length < size\) break;/);
});

test('41회차 F4: 끊긴 GPU 호스트(GPU VM 이 있는데 목록 빈 배열)는 hostsDown 으로 세고 일 이력에 쓰지 않는다', async () => {
  const { buildGpuAllocTree } = await import('../src/gpu/allocTree.js');
  const { allocDailyRows } = await import('../src/gpu/allocHistory.js');
  const gpu = (i) => ({ model: 'NVIDIA A40', memGB: 45, mode: 'vgpu', vgpuMode: true, pciId: `0000:${i}:00.0`, vms: [] });
  const mkHost = (name, conn, withGpus) => ({ id: `vc1:${name}`, vcenterId: 'vc1', name, cluster: 'GPU-CL', vcDatacenter: 'DC1', connectionState: conn, gpus: withGpus ? [gpu(1), gpu(2)] : [] });
  const vms = [];
  for (const h of ['esx1', 'esx2']) for (let i = 0; i < 3; i++) vms.push({ id: `vc1:vm-${h}-${i}`, name: `${h}-vm${i}`, vcenterId: 'vc1', host: h, powerState: 'POWERED_ON', gpu: { type: 'vgpu', vgpu: 1, passthrough: 0, profile: 'nvidia_a40-24q', count: 1 } });
  const snapOk = { vcenters: [{ id: 'vc1', name: 'KR', status: 'ok' }], hosts: [mkHost('esx1', 'CONNECTED', true), mkHost('esx2', 'CONNECTED', true)], vms };
  const snapDown = { ...snapOk, hosts: [mkHost('esx1', 'CONNECTED', true), mkHost('esx2', 'NOT_RESPONDING', false)] };
  assert.equal(allocDailyRows(snapOk).length, 1);
  assert.equal(buildGpuAllocTree(snapDown).totals.hostsDown, 1);
  assert.deepEqual(allocDailyRows(snapDown), [], '줄어든 용량을 일 이력에 쓰지 않는다');
});

test('41회차 F5: 다시 붙는 du 의 시한 · 소요는 원래 시작 시각부터(소스)', () => {
  const c = read('isidu/collect.js');
  assert.match(c, /const started = attachJob && Number\(startedAt\) > 0 && Number\(startedAt\) <= Date\.now\(\) \? Number\(startedAt\) : Date\.now\(\);/);
  const p = read('isidu/poller.js');
  assert.match(p, /startedAt: jobStartedAt,/);
  assert.match(p, /jobStartedAt: Date\.now\(\)/);
});

test('41회차 F7: B 시리즈 다중 디스플레이 프로파일(…-2b4)', async () => {
  const { vgpuProfileGB } = await import('../src/gpu/vgpuProfile.js');
  assert.equal(vgpuProfileGB('grid_m10-2b4'), 2);
  assert.equal(vgpuProfileGB('grid_m60-0b'), 0.5);
  assert.equal(vgpuProfileGB('grid_a40-24q'), 24);
  assert.equal(vgpuProfileGB('grid_a100-3-20c'), 20);
});

/* ── 42회차(38~41회차 수정 반증) ── */
test('42회차 R1: 재개 대상이 장비에 없어 새로 띄운 du 는 지금부터 시한을 받는다(옛 시작 시각 기준으로 곧바로 죽지 않는다)', async () => {
  const { runDetached } = await import('../src/isidu/detach.js');
  let clock = Date.now();
  const seq = ['DVC-NONE', 'STARTED', 'DVC-RUNNING', 'DVC-RUNNING', 'DVC-DONE 0'];
  const calls = [];
  const api = { exec: async (cmd) => {
    calls.push(cmd.slice(0, 40)); clock += 10 * 60_000;
    if (/DVC-STARTED|nohup|setsid/.test(cmd) && seq[0] === 'STARTED') { seq.shift(); return { stdout: 'DVC-STARTED 1234\n', code: 0 }; }
    if (/cat .*\.out|readOut|head -c/.test(cmd) && !seq.length) return { stdout: '1.0K\t/ifs/a\n', code: 0 };
    const s = seq.length ? seq.shift() : 'DVC-DONE 0';
    return { stdout: `${s}\n`, code: 0 };
  } };
  const t = { id: 'tA', path: '/ifs/a', sizeMode: 'h' };
  const started = clock - 175 * 60_000;   // 재시작 전 du 가 175분 돌았다(시한 180분)
  const r = await runDetached(api, t, { cmdMs: 180 * 60_000, attachJob: 'isidu-tA-1', started, now: () => clock, pollMinMs: 1 }).catch((e) => ({ err: e.message }));
  assert.ok(!r.err || !/시한 초과/.test(r.err), `새 작업이 옛 시각 기준 시한으로 죽으면 안 된다: ${r.err || ''}`);
  if (!r.err) assert.ok(r.startedAt > started, '실제 시작 시각(새 작업)을 돌려준다');
});

test('42회차 R2: GPU 호스트가 모두 끊긴 법인은 0대가 아니라 모름(hostsDown) — 서버 · 웹 같은 판정', async () => {
  const { buildGpuAllocTree, allocCorpRoster, corpUnknownOf } = await import('../src/gpu/allocTree.js');
  const web = await import('../../web/src/views/tools/gpuAllocText.js');
  const vms = [{ id: 'vc1:vm-1', name: 'vm1', vcenterId: 'vc1', host: 'esx1', powerState: 'POWERED_ON', gpu: { type: 'vgpu', vgpu: 1, passthrough: 0, profile: 'nvidia_a40-24q', count: 1 } }];
  const snap = { vcenters: [{ id: 'vc1', name: 'KR', status: 'ok' }], hosts: [{ id: 'vc1:esx1', vcenterId: 'vc1', name: 'esx1', connectionState: 'NOT_RESPONDING', gpus: [] }], vms };
  const tree = buildGpuAllocTree(snap);
  assert.equal(tree.hostsDownByVc?.vc1, 1);
  const roster = allocCorpRoster(snap, {}, tree);
  assert.equal(roster.find((c) => c.id === 'vc1').unknown, 'hostsDown');
  for (const args of [[{ status: 'ok' }, false, 0, 1], [{ status: 'ok' }, false, 0, 0], [{ status: 'pending' }, false, 0, 1], [{ status: 'ok' }, true, 0, 1]]) {
    assert.equal(web.corpUnknownOf(...args), corpUnknownOf(...args), JSON.stringify(args));
  }
  const chips = web.corpChips(tree, [{ id: 'vc1', name: 'KR', status: 'ok' }]);
  assert.equal(chips[0].unknown, 'hostsDown');
  assert.match(web.totalsNote({ hostsDown: 1, gpus: 2 }).note, /끊긴 호스트 1대/);
});

test('42회차 R3 · R5 · R6: 원시 행 수 하한 표지 · 카탈로그 HAS_MORE · 빈 마지막 쪽(소스)', () => {
  assert.match(read('bmusage/db.js'), /rawRowsPartial: true/);
  const s = read('horizon/sessionCollect.js');
  assert.match(s, /if \(more !== true && body\.length < CATALOG_PAGE\) break;/);
  assert.match(s, /if \(more === true && body\.length === 0\) \{ if \(page === 1 \|\| prevLen < size\) break; truncated = true; break; \}/);   // 43회차 R6
  assert.match(s, /if \(!r\.ok && page > 1 && prevLen < size\) break;/, '43회차 R7: 짧은 쪽 다음 요청의 오류는 끝');
  assert.match(s, /if \(!r\.ok && page > 1\) \{ truncated\[kind\] = true; break; \}/, '43회차 R7: 카탈로그 2쪽 이후 오류는 앞 쪽까지');
});

/* ── 43회차(42회차 수정 반증) ── */
test('43회차 R1: 재개 대상이 없어 새로 띄우면 호출부 소요 기준(onRestart)도 지금으로', async () => {
  const { runDetached } = await import('../src/isidu/detach.js');
  let clock = Date.now(); let restarted = null;
  const seq = ['DVC-NONE', 'STARTED', 'DVC-DONE 0'];
  const api = { exec: async (cmd) => { clock += 60_000; if (/DVC-STARTED|nohup|setsid/.test(cmd) && seq[0] === 'STARTED') { seq.shift(); return { stdout: 'DVC-STARTED 1\n' }; } const x = seq.length ? seq.shift() : 'DVC-DONE 0'; return { stdout: `${x}\n` }; } };
  await runDetached(api, { id: 'tA', path: '/ifs/a', sizeMode: 'h' }, { cmdMs: 180 * 60_000, attachJob: 'isidu-tA-1', started: clock - 175 * 60_000, now: () => clock, pollMinMs: 1, onRestart: (ts) => { restarted = ts; } });
  assert.ok(restarted && restarted > clock - 10 * 60_000, '새 작업 시작 시각을 알린다');
  assert.match(read('isidu/collect.js'), /onRestart: \(ts\) => \{ runStart = ts; \}/);
});

test('43회차 R3 · R4: 엑셀 비고 · 목차 사유 · 못 읽은 파일 수(소스)', () => {
  const x = read('gpu/allocTreeXlsx.js');
  assert.match(x, /GPU 를 못 읽은 끊긴 호스트 \$\{t\.hostsDown\}대 — 합계는 부분/);
  assert.match(x, /c\.unknown === 'hostsDown' \?/);
  assert.match(read('bmusage/monthStore.js'), /unreadCount: unread\.length/);
  assert.match(read('bmusage/db.js'), /Number\(files\.raw\.unreadCount\)/);
});

test('43회차: 끊긴 GPU 호스트가 있는 법인 · 전체 합계는 예비 · 할당률을 내지 않는다', async () => {
  const { buildGpuAllocTree } = await import('../src/gpu/allocTree.js');
  const gpu = (i) => ({ model: 'NVIDIA A40', memGB: 45, mode: 'vgpu', vgpuMode: true, pciId: `0000:${i}:00.0`, vms: [] });
  const vms = ['esx1', 'esx2'].map((h, i) => ({ id: `vc1:vm-${i}`, name: `vm${i}`, vcenterId: 'vc1', host: h, powerState: 'POWERED_ON', gpu: { type: 'vgpu', vgpu: 1, passthrough: 0, profile: 'nvidia_a40-24q', count: 1 } }));
  const snap = { vcenters: [{ id: 'vc1', status: 'ok' }], hosts: [{ id: 'vc1:esx1', vcenterId: 'vc1', name: 'esx1', connectionState: 'CONNECTED', gpus: [gpu(1)] }, { id: 'vc1:esx2', vcenterId: 'vc1', name: 'esx2', connectionState: 'NOT_RESPONDING', gpus: [] }], vms };
  const t = buildGpuAllocTree(snap);
  assert.equal(t.vcenters[0].totals.hostsDown, 1);
  assert.equal(t.vcenters[0].totals.allocPct, null);
  assert.equal(t.totals.spareGB, null);
});

