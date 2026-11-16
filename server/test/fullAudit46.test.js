/**
 * 전체 점검 46회차(vCenter 점검 · iDRAC 심화) 회귀.
 *  V1 스냅샷 정책 일일 알림 — 읽지 못한 vCenter 가 있으면 '위반 0' 으로 그날을 닫지 않고, 보낼 때는 본문에 밝힌다(화면과 같은 판정)
 *  V2 태그 점검 '카테고리별 붙은 VM' 은 VM 당 카테고리 한 번(100% 를 넘지 않는다)
 *  V3 법인별 호스트 보기 — 호스트를 모르는 법인은 VM · 코어 · 전력도 null(0 이 아니다)
 *  I1 GPU 카드 집계 — Processors 컬렉션을 못 읽은 서버는 'GPU 0장' 이 아니라 못 읽음(hwSummary 와 같은 판정)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fa46-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'false';
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const NOW = Date.UTC(2026, 9, 5, 3, 30); // KST 12:30 — 정시 경계에서 떨어진 고정 시각
const DAY = 86_400_000;

test('46회차 V1: 읽지 못한 vCenter 가 있으면 위반 0 으로 그날을 닫지 않는다 · 위반이 있으면 본문에 밝힌다', async () => {
  const { vmHygieneNotifyOnce } = await import('../src/vmhygiene/notifier.js');
  const { saveVmHygieneSettings, _resetVmHygieneSettings } = await import('../src/vmhygiene/settings.js');
  _resetVmHygieneSettings();
  saveVmHygieneSettings({ notify: { enabled: true, hour: 9 } });
  const stateFile = path.join(DIR, 'vm-hygiene-state.json');
  const sent = [];
  const send = async (text) => { sent.push(text); return ['slack:200']; };
  const vm = (id, vcenterId, snaps) => ({ id: `${vcenterId}:${id}`, name: id, vcenterId, powerState: 'POWERED_ON', snapshotCount: snaps, snapshotOldestTs: snaps ? NOW - 30 * DAY : null });
  const vcenters = [{ id: 'vc-kr', name: 'KR', status: 'connected' }, { id: 'vc-pl', name: 'PL', status: 'unreachable' }, { id: 'vc-us', name: 'US', status: 'pending' }];
  const clean = { vcenters, hosts: [], vms: [vm('ok-1', 'vc-kr', 0)] };
  const r = await vmHygieneNotifyOnce({ now: NOW, force: true, send, snap: clean });
  assert.equal(r.reason, 'partial', `읽지 못한 vCenter 2곳을 빼고 '위반 0' 으로 닫으면 안 된다 — ${r.reason}`);
  assert.equal(r.notRead, 2);
  const st = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  assert.notEqual(st.lastSentDay, '2026-10-05', '그날을 보냄으로 기록하지 않는다(다음 확인에서 다시 본다)');
  const bad = { vcenters, hosts: [], vms: [vm('old-snap', 'vc-kr', 9)] };
  const s = await vmHygieneNotifyOnce({ now: NOW, force: true, send, snap: bad });
  assert.equal(s.sent, true);
  assert.match(sent.at(-1), /읽지 못한 vCenter 2곳/);
  assert.match(sent.at(-1), /문제가 없다는 뜻이 아님/);
  const all = { vcenters: [vcenters[0]], hosts: [], vms: [vm('ok-1', 'vc-kr', 0)] };
  const n = await vmHygieneNotifyOnce({ now: NOW, force: true, send, snap: all });
  assert.equal(n.reason, 'no-violation', '다 읽었으면 예전처럼 그날을 닫는다');
  _resetVmHygieneSettings();
});

test('46회차 V2: 여러 태그를 붙인 VM 도 카테고리당 한 번만 센다(100% 초과 금지)', async () => {
  const { analyzeTags } = await import('../src/tags/analyze.js');
  const inv = { at: 1, tagsAt: 1, customAt: 1, categories: [{ id: 'c1', name: 'App' }],
    tags: [{ id: 't1', name: 'web', cat: 0 }, { id: 't2', name: 'api', cat: 0 }, { id: 't3', name: 'batch', cat: 0 }],
    vmTags: { 'vm-1': [0, 1, 2], 'vm-2': [0] }, fields: [], vmCustom: {} };
  const vcs = [{ id: 'vc1', name: 'VC1', tagInv: inv }];
  const vms = [{ id: 'vc1:vm-1', vcenterId: 'vc1', name: 'a', powerState: 'POWERED_ON' }, { id: 'vc1:vm-2', vcenterId: 'vc1', name: 'b', powerState: 'POWERED_ON' }];
  const r = analyzeTags(vcs, vms, {});
  const app = (r.categories || []).find((c) => String(c.name).toLowerCase() === 'app');
  assert.ok(app, JSON.stringify(Object.keys(r)));
  assert.equal(app.vms, 2, `VM 2대 — 태그 수(4)가 아니다: ${app.vms}`);
});

test('46회차 V3: 호스트를 모르는 법인은 VM · vCPU · 코어 · 전력 · 여유도 null', async () => {
  const C = await import('../src/vcenter/hostCorp.js');
  const r = C.hostCorpOf({
    vcenters: [{ id: 'vc-a', name: 'A', status: 'pending' }], hosts: [], vms: [],
    readable: () => true, capKnown: () => true,
  });
  const c = r.corps[0];
  assert.equal(c.hosts, null);
  for (const k of ['vms', 'vcpu', 'cores', 'memTotalGB', 'powerKw', 'headroomGB', 'vcpuPerCore', 'ramPct']) assert.equal(c[k], null, `${k}=${c[k]}`);
});

test('46회차 I1: GPU 목록을 못 읽은 서버는 GPU 0장이 아니라 못 읽음 — 카드는 최소값 표지', async () => {
  const { idracGpuCounts } = await import('../src/idrac/gpuCount.js');
  const web = await import('../../web/src/views/overviewCardsText.js');
  const now = Date.now();
  const at = new Date(now - 60_000).toISOString();
  const invs = {
    a: { collectedAt: at, gpus: [1, 2, 3, 4].map((i) => ({ model: 'NVIDIA H100', name: `GPU${i}` })), collections: { gpus: 'ok' } },
    b: { collectedAt: at, gpus: [], collections: { gpus: 'failed' } },
  };
  const c = idracGpuCounts([{ id: 'a', type: 'idrac' }, { id: 'b', type: 'idrac' }], (s) => invs[s.id], now);
  assert.equal(c.gpus, 4);
  assert.equal(c.gpuUnread, 1);
  const card = { count: c.gpus, inventoryRead: c.invRead, inventoryStale: c.invStale, gpuUnread: c.gpuUnread, servers: c.count };
  assert.equal(web.gpuCardValue(card).partial, true, '최소값 표지');
  assert.match(web.gpuCardMeta(card), /GPU 목록을 못 읽은 서버 1대/);
});
