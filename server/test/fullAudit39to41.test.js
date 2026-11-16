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
