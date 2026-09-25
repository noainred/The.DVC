/**
 * audit2591.test.js — v2.591 3차 점검(7축 병렬 감사) 확정분 회귀 고정.
 *
 * v2.590 과 같은 기준 — **수정 전 코드로 되돌리면 실패하는지**(변이 검증)를 보고 썼다. 가능하면 실제 함수·실제 파일을
 * 돌리고, 소스 검사는 주석을 먼저 제거한다(`_stripComments.js`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2591-'));
process.env.CONFIG_DIR = TMP;
process.env.GUESTDISK_DB_PATH = path.join(TMP, 'gd.db');
process.env.DB_HEALTH_QUICK_MAX_BYTES = '1';
process.env.SVCMON_WORKERS = '0';

const src = (rel) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));

// ── R-Q1 / PR-3: claim→ack 는 엣지 시계끼리만 비교한다 ────────────────────────────
test('★ R-Q1: 엣지 시계가 중앙보다 1시간 늦어도 새 수집이 도착하면 완료, 같은 수집은 완료가 아니다', async () => {
  const { createCollectRequestQueue } = await import('../src/util/collectRequestQueue.js');
  const q = createCollectRequestQueue({ ackMs: 60_000, maxTries: 2 });
  const CENTRAL = 10_000_000_000;              // 중앙 시계
  const EDGE = CENTRAL - 3_600_000;            // 엣지 시계(1시간 늦다)
  q.ack('d1', EDGE);                           // 요청 전 마지막 push(기준선)
  q.request('d1', 'Edge-A', CENTRAL);
  assert.deepEqual(q.take('edge-a', CENTRAL, 20), ['d1']);
  assert.equal(q.ack('d1', EDGE), false, '요청 이전 수집(같은 collectedAt)으로 완료하면 안 된다');
  assert.equal(q.ack('d1', EDGE + 5_000), true, '엣지 시계가 중앙보다 늦어도 기준선보다 새 수집이면 완료');
  assert.equal(q.has('d1', CENTRAL), false);
});

test('★ PR-3: 인출은 엣지 처리량(max)만큼, 시한은 개수에 비례 · 재시작 뒤 기준선은 baseOf', async () => {
  const { createCollectRequestQueue } = await import('../src/util/collectRequestQueue.js');
  const q = createCollectRequestQueue({ ackMs: 60_000, perItemMs: 180_000, baseOf: (id) => (id === 'x0' ? 777 : null) });
  const T = 20_000_000_000;
  for (let i = 0; i < 50; i += 1) q.request(`x${i}`, 'E', T);
  const got = q.take('E', T, 20);
  assert.equal(got.length, 20, '엣지가 pull 당 20대만 처리하는데 50대를 인출하면 30대가 시도 없이 시한을 먹는다');
  const st = q.state('x5', T);
  assert.equal(st.deadline, T + 60_000 + 20 * 180_000, '순차 수집 5×3분이면 시한이 개수에 비례해야 한다');
  assert.equal(q.state('x0', T).base, 777, '중앙 재시작 직후에는 보관 중인 스냅샷 시각이 기준선');
  assert.equal(q.ack('x0', 777), false);
  assert.equal(q.ack('x0', 778), true);
  // 나머지 30대는 대기로 남는다
  assert.equal(q.state('x30', T).state, 'pending');
});

test('★ R-Q2: 결과 없이 폐기된 요청은 drops 로 남고 목록 라우트 3종이 응답에 싣는다', async () => {
  const { createCollectRequestQueue } = await import('../src/util/collectRequestQueue.js');
  const q = createCollectRequestQueue({ ackMs: 1_000, maxTries: 1 });
  const T = 30_000_000_000;
  q.request('z', 'E', T); q.take('E', T, 5);
  const d = q.drops(T + 5_000);
  assert.equal(d.length, 1); assert.equal(d[0].id, 'z'); assert.equal(d[0].agent, 'e');
  for (const [rel, fn] of [['routes/api/storageMon.js', 'recentCollectDrops'], ['routes/api/sanSwitch.js', 'recentCollectDrops'], ['routes/api/pdu.js', 'recentCollectDrops']]) {
    assert.match(src(rel), new RegExp(`collectDrops:\\s*${fn}\\(`), `${rel}: 폐기 사실이 응답에 없다`);
  }
  for (const rel of ['storage/collectRequests.js', 'sanswitch/collectRequests.js', 'pdu/collectRequests.js']) {
    assert.match(src(rel), /\.take\([\s\S]{0,60}?TAKE_MAX\)/, `${rel}: 인출에 상한이 없다`);
  }
});

// ── R-B1: 실제 설정 파일을 상태 파일로 분류하지 않는다 ───────────────────────────────
test('★ R-B1: svcmon-log.json·agent-assignments.json 은 설정이다(변경 백업 대상)', async () => {
  const backup = await import('../src/backup/service.js');
  for (const n of ['svcmon-log.json', 'agent-assignments.json']) assert.equal(backup.isRuntimeStateFile(n), false, n);
  assert.equal(backup.isRuntimeStateFile('central-inventory.json'), true);
});

// ── R-D1: 정합성 점검을 생략한 DB 를 '정상' 으로 세지 않는다 ─────────────────────────
test('★ R-D1: 점검 생략(unchecked)은 okCount 가 아니라 uncheckedCount 다', async () => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { return; }
  const p = path.join(TMP, 'd1.db');
  const d = new DatabaseSync(p); d.exec('CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1);'); d.close();
  const { inspectMany } = await import('../src/insights/dbHealth.js');
  const r = await inspectMany([p], { full: false });
  assert.equal(r.okCount, 0, "생략한 점검을 '정상' 에 셌다");
  assert.equal(r.uncheckedCount, 1);
});

// ── R-G1: 제거된 파티션을 현재 파티션으로 되살리지 않는다 ────────────────────────────
test('★ R-G1: 최근 수집에 없는 파티션은 removed 이고 회수 후보(safe)가 아니다', async () => {
  const gd = await import('../src/guestdisk/db.js');
  const svc = await import('../src/guestdisk/service.js');
  const DAY = 86400e3; const now = Date.now();
  const two = { vmId: 'vm-rm', vmName: 'db01', allocGB: 200, usedGB: 40, partCount: 2, parts: [{ path: 'C:\\', capGB: 60, usedGB: 30 }, { path: 'E:\\', capGB: 100, usedGB: 5 }] };
  const c = await gd.commitCollection('vc1', 'VC1', [two], { ts: now - 10 * DAY });
  if (c?.ok === false && /sqlite/i.test(String(c.reason))) return;
  const one = { ...two, allocGB: 100, partCount: 1, parts: [{ path: 'C:\\', capGB: 60, usedGB: 31 }] };
  await gd.commitCollection('vc1', 'VC1', [one], { ts: now - 1 * DAY });
  const cur = await gd.currentPartPaths('vm-rm');
  assert.deepEqual([...cur], ['C:\\'], 'part_last 에 사라진 E: 가 남았다');
  const det = await svc.vmDetail('vm-rm', { days: 30 });
  const e = det.partitions.find((p) => p.path === 'E:\\');
  if (e) {
    assert.equal(e.removed, true, '제거된 파티션을 현재 파티션처럼 보여줬다');
    assert.notEqual(e.advice?.safe, true, "제거된 파티션을 '축소 후보' 로 권했다");
  }
  const c2 = det.partitions.find((p) => p.path === 'C:\\');
  assert.ok(c2 && !c2.removed);
});

// ── PR-1 / PR-2: 수신 집계는 인증된 이름 · 길이 상한 · 검증 여부 ─────────────────────
test('★ PR-1/PR-2: 수신 집계 키는 64자로 자르고 검증 여부를 싣는다 · 라우트는 인증된 agent 를 먼저 쓴다', async () => {
  const st = await import('../src/central/ingestStats.js');
  st.resetIngestStats();
  st.recordIngest('x'.repeat(5000), '/inventory', { wireBytes: 10, verified: false });
  st.recordIngest('edge-a', '/' + 'p'.repeat(5000), { wireBytes: 10, verified: true });
  const rows = st.getIngestStats().rows;
  assert.ok(rows.every((r) => r.agent.length <= 64), '본문 agent 문자열을 자르지 않고 Map 키로 보관했다');
  assert.equal(rows.find((r) => r.agent === 'edge-a').verified, true);
  assert.equal(rows.find((r) => r.agent !== 'edge-a').verified, false);
  assert.ok(rows.find((r) => r.agent === 'edge-a').byEndpoint.every((e) => e.endpoint.length <= 200));
  const s = src('routes/central.js');
  assert.match(s, /verified\s*\?\s*String\(auth\.agent/, "개별 토큰이면 인증된 이름을 써야 한다(데이터 흐름 지도가 '(unknown)' 을 그렸다)");
  st.resetIngestStats();
});

// ── PR-4: svcmon 메타 구멍 ─────────────────────────────────────────────────────
test('★ PR-4: 메타가 일부만 있어도(청크 유실) 빠진 행이 있으면 다시 요청한다', async () => {
  const edge = await import('../src/central/svcmonEdge.js');
  edge._resetEdgeCache();
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ i: `t-${i}`, s: 'ok', r: 'ok', m: 5, k: 1, a: 100 }));
  const metas = (n) => Array.from({ length: n }, (_, i) => ({ i: `t-${i}`, p: 'A', n: `s${i}`, h: '10.0.0.1', t: 'ping', y: 'ping', iv: 60 }));
  const env = (o) => ({ snapId: 1, seq: 1, total: 1, sentAt: Date.now(), expectMs: 20000, items: 5, reported: 5, metaSig: 'sig', meta: null, rows: rows(5), ...o });
  edge.ingestReport('m1', env({ meta: metas(3) }));      // 5행 중 메타 3개만 도착
  const r = edge.ingestReport('m1', env({}));
  assert.equal(r.needMeta, true, 'sig 가 같다는 이유로 메타 구멍을 영원히 두었다');
  edge._resetEdgeCache();
});

// ── PR-5 / PR-7: 위임 워커·설정 pull 의 HTTP 실패는 무음이 아니다 ─────────────────────
test('★ PR-5/PR-7: 워커 3종의 인출·회신 HTTP 실패와 설정 pull 403 이 상태·콘솔에 남는다', () => {
  for (const rel of ['agent/pingWorker.js', 'agent/captureWorker.js', 'agent/bmstorWorker.js']) {
    const s = src(rel);
    assert.match(s, /httpFail\(/, `${rel}: 인출 HTTP 오류가 무음이다`);
    assert.match(s, /postResult\(/, `${rel}: 결과 회신 실패를 보지 않는다`);
    assert.match(s, /X-Agent-Name/, `${rel}: 이름 헤더가 없다(중앙 계측이 '(unknown)')`);
  }
  for (const rel of ['agent/storageConfigPull.js', 'agent/pduConfigPull.js', 'agent/sanSwitchConfigPull.js', 'agent/usersConfigPull.js', 'agent/gpuGuestConfigPull.js']) {
    assert.match(src(rel), /createChangeLogger/, `${rel}: 실패가 콘솔에 남지 않는다`);
  }
});

// ── PR-6: 본문 파서 거부도 거부 기록에 ────────────────────────────────────────────
test('★ PR-6: 413 은 too-large 로 분류되고 전역 오류 처리기가 /api/central 파서 거부를 기록한다', async () => {
  const rj = await import('../src/central/ingestReject.js');
  assert.equal(rj.rejectKindOf(413), 'too-large');
  const s = src('index.js');
  assert.match(s, /recordReject\(/, '본문 파서 거부가 기록되지 않는다');
  assert.match(s, /\/api\/central\//);
});

// ── PR-8: null 원소 ───────────────────────────────────────────────────────────
test('★ PR-8: fleet push 의 null·문자열 원소는 건너뛴다(TypeError → 500 금지)', async () => {
  const fleet = await import('../src/central/fleet.js');
  assert.doesNotThrow(() => fleet.setEdgeFleet('e-null', [null, 'x', 7, { serviceTag: 'ABC', name: 'bm1' }], new Date().toISOString()));
});

// ── C4: 개요 물리 용량 범위 ───────────────────────────────────────────────────────
test('★ C4: 서버별 귀속 결과를 호출부가 받는다 · 범위 계정의 physical 은 함대 값이 아니다', async () => {
  const { serversByCorp } = await import('../src/idrac/serverByCorp.js');
  const seen = [];
  serversByCorp(
    [{ id: 's1', vcenterId: 'vcA' }, { id: 's2', vcenterId: 'vcB' }, { id: 's3' }],
    [{ name: 'h', vcenterId: 'vcA' }],
    { knownVcenters: new Set(['vcA', 'vcB']), onAttributed: (s, vc) => seen.push([s.id, vc]) },
  );
  assert.deepEqual(seen, [['s1', 'vcA'], ['s2', 'vcB'], ['s3', '']]);
  const s = src('routes/api/overviewNsx.js');
  assert.doesNotMatch(s, /physical:\s*physicalCapacity\(\)\s*,/, '범위와 무관하게 함대 전체 물리 용량을 싣는다');
  assert.match(s, /matchedBy:\s*null/, '범위 계정에 함대 전체 귀속 경로 분포를 준다');
});

// ── C6: 물리 메모리 단위 ────────────────────────────────────────────────────────
test('★ C6: 물리 메모리 GB 는 vCenter 카드와 같은 이진 단위다', async () => {
  const { aggregatePhysical } = await import('../src/idrac/physicalCapacity.js');
  const r = aggregatePhysical([{ id: 'a' }], () => ({ memory: { totalGiB: 1024 } }));
  assert.equal(r.memGB, 1024, '1 TiB 서버를 1100 GB 로 보여줬다(ESXi 카드는 1024)');
});

// ── L1: 스토리지 단건 수집 동시 실행 금지 ────────────────────────────────────────────
test('★ L1: 스토리지 단건 수집은 같은 장비가 수집 중이면 새 세션을 열지 않는다', () => {
  const s = src('storage/poller.js');
  const fn = s.slice(s.indexOf('export async function collectDeviceNow'), s.indexOf('export async function testDeviceConnection'));
  assert.match(fn, /_inFlight\.has\(dev\.id\)\)\s*return false/, '주기 수집과 같은 장비를 동시에 수집한다');
  assert.ok(fn.indexOf('_inFlight.has') < fn.indexOf('await collectOne'), '가드가 수집보다 앞이어야 한다');
  for (const rel of ['routes/api/storageMon.js', 'routes/api/sanSwitch.js']) assert.match(src(rel), /status\(409\)[^\n]*busy:\s*true/, `${rel}: 이미 수집 중인데 '됐다' 고 답한다`);
});

// ── L2: 긴 주기 타이머 ─────────────────────────────────────────────────────────
test('★ L2: 24.8일을 넘는 주기가 1ms 폭주가 되지 않는다 · 짧은 주기는 정상 반복', async () => {
  const { every, MAX_TIMER_MS } = await import('../src/util/longTimer.js');
  let n = 0;
  const h = every(() => { n += 1; }, 30 * 86_400_000);
  await new Promise((r) => setTimeout(r, 150));
  h.clear();
  assert.equal(n, 0, '30일 주기가 즉시 반복 실행됐다');
  assert.ok(30 * 86_400_000 > MAX_TIMER_MS);
  let m = 0;
  const h2 = every(() => { m += 1; }, 20, { unref: false });
  await new Promise((r) => setTimeout(r, 130));
  h2.clear();
  assert.ok(m >= 2 && m <= 10, `짧은 주기 반복 횟수 ${m}`);
  assert.doesNotMatch(src('backup/settings.js'), /setInterval\(/, '백업 스케줄이 setInterval 이다(24.8일 초과 시 1ms)');
});

// ── L3: 업그레이드 확인 주기 ─────────────────────────────────────────────────────
test('★ L3: 자동 업그레이드 확인 주기는 1분~7일로 클램프, 0 은 끔 · tick 재진입 가드', async () => {
  const { clampPollMs, POLL_MAX_MS, POLL_MIN_MS } = await import('../src/upgrade/settings.js');
  assert.equal(clampPollMs(43_200 * 60_000), POLL_MAX_MS, '30일이 그대로 저장되면 setInterval 이 1ms 가 된다');
  assert.ok(POLL_MAX_MS < 2 ** 31 - 1);
  assert.equal(clampPollMs(1000), POLL_MIN_MS);
  assert.equal(clampPollMs(0), 0);
  assert.equal(clampPollMs(''), 0);
  assert.match(src('upgrade/manager.js'), /if \(this\.#ticking\) return/, 'tick 재진입 가드가 없다');
});

// ── L5: 성공한 자동 백업이 '건너뜀' 이 되지 않는다 ────────────────────────────────────
test('★ L5: 빈 skipped 배열(성공)은 생략이 아니다', () => {
  const s = src('backup/settings.js');
  assert.match(s, /m\.skipped === true/, "성공 백업의 skipped:[] 를 '생략' 으로 읽는다 — lastRun 이 영원히 빈다");
  assert.doesNotMatch(s, /if \(m\.skipped\)\s*\{/);
});

// ── L6: 호스트 접근 자동 되돌림이 busy 로 버려지지 않는다 ───────────────────────────────
test('★ L6: 기한 직전 확정이 진행 중이다 실패해도 자동 되돌림(--reload)이 이어서 실행된다', async () => {
  const S = await import('../src/hostaccess/service.js');
  const St = await import('../src/hostaccess/settings.js');
  St._resetHostAccessCache();
  const LIST_ALL = 'public (active)\n  target: default\n  services: ssh\n  ports: 4000/tcp 22/tcp\n  rich rules:\n';
  const state = { reloads: 0, slowPerm: false };
  const fw = async (args) => {
    if (args[0] === '--state') return { ok: true, code: 0, stdout: 'running\n', stderr: '' };
    if (args[0] === '--get-default-zone') return { ok: true, code: 0, stdout: 'public\n', stderr: '' };
    if (args.includes('--list-all')) return { ok: true, code: 0, stdout: LIST_ALL, stderr: '' };
    if (args[0] === '--reload') { state.reloads += 1; return { ok: true, code: 0, stdout: 'success', stderr: '' }; }
    if (args[0] === '--runtime-to-permanent') { await new Promise((r) => setTimeout(r, 400)); return { ok: false, code: 1, stdout: '', stderr: 'boom' }; }
    return { ok: true, code: 0, stdout: 'success', stderr: '' };
  };
  S._setExec({ fw, sshdCtl: async () => ({ ok: true }), sshdActive: async () => true, isSudoDenied: () => false });
  const a = await S.applyHostAccess({ ssh: { mode: 'deny' }, confirmMinutes: 1 }, { requesterIp: '10.1.1.1', by: 't' });
  assert.equal(a.ok, true, JSON.stringify(a));
  const pend = St.loadHostAccess().pending;
  St.saveHostAccess({ pending: { ...pend, deadline: Date.now() + 100 } });
  await S.resumeHostAccessPending();            // 기한 100ms 로 재무장
  const conf = S.confirmHostAccess({ by: 't' }); // 400ms 걸리다 실패 — 그 사이 타이머 발화(busy)
  const cr = await conf;
  assert.equal(cr.ok, false);
  await new Promise((r) => setTimeout(r, 2600));
  assert.ok(state.reloads >= 1, '확정이 진행 중이라는 이유로 자동 되돌림이 조용히 버려졌다');
  assert.equal(St.loadHostAccess().pending, null);
  S._setExec(null);
});

// ── L7: svcmon CSV 종료 flush ───────────────────────────────────────────────────
test('★ L7: 스트림이 열리기 전 종료해도 대기 행이 파일에 남는다', async () => {
  const csv = await import('../src/svcmon/csvlog.js');
  const ls = await import('../src/svcmon/logsettings.js');
  ls._resetLogSettingsCache?.();
  ls.setLogSettings({ enabled: true, mode: 'all' });
  const t0 = Date.now();
  for (let i = 0; i < 100; i += 1) {
    csv.appendResult({ ts: t0, target: { path: 'P', name: `n${i}`, host: '10.0.0.1' }, test: { name: 'ping', type: 'ping' }, result: { status: 'ok', reply: 'ok', ms: 1, streak: 1 }, changed: true });
  }
  csv.closeCsvLog();                               // 첫 flush(200ms) 전 종료 — 스트림이 아직 없다
  const dir = ls.logDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.csv'));
  assert.ok(files.length >= 1, '스트림이 없다는 이유로 대기 행을 쓰지 않고 버렸다(파일 자체 없음)');
  const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n');
  assert.equal(lines.length, 101, `헤더 + 100행이어야 한다(실제 ${lines.length})`);
  assert.match(src('index.js'), /closeCsvLogAsync\(/, '정상 종료가 스트림 finish 를 기다리지 않는다');
});

// ── L8: fleet 캐시 원자 쓰기 ─────────────────────────────────────────────────────
test('★ L8: central-fleet.json 주기 저장은 임시 파일 + rename 이고, 쓰는 중 종료도 flush 한다', () => {
  const s = src('central/fleet.js');
  assert.doesNotMatch(s, /fs\.promises\.writeFile\(FILE/, '대상 파일에 직접 비동기 쓰기(절단본 위험)');
  assert.match(s, /fs\.promises\.rename\(tmp, FILE\)/);
  assert.match(s, /writeTimer \|\| writing \|\| dirty/, "'쓰는 중' 종료를 건너뛴다");
});

// ── L9 / L10: 폴러 타이머 ──────────────────────────────────────────────────────
test('★ L9: start* 는 기동 스태거 전에 걸린 reschedule interval 을 지운다', () => {
  for (const [rel, fn] of [['metrics/sampler.js', 'startMetricsSampler'], ['gpu/poller.js', 'startGpuGuestPoller'], ['ipam/scanPoller.js', 'startIpScanPoller']]) {
    const s = src(rel);
    const body = s.slice(s.indexOf(`export function ${fn}`));
    const i = body.indexOf('timer = setInterval(');
    assert.ok(i > 0, rel);
    assert.match(body.slice(0, i), /if \(timer\) clearInterval\(timer\)/, `${rel}: 고아 interval 이 남는다`);
  }
});

test('★ L10: 설정 저장이 무장된 폴러 타이머를 즉시 재무장시킨다(3종)', async () => {
  const perf = await import('../src/sanswitch/perfSettings.js');
  let n = 0;
  const off = perf.onPerfSettingsChange(() => { n += 1; });
  perf.savePerfSettings({ enabled: true, intervalMs: 60_000 });
  off();
  assert.equal(n, 1, '설정이 바뀌어도 폴러가 모른다(최대 6시간 뒤 적용)');
  for (const [rel, name] of [['sanswitch/perfPoller.js', 'onPerfSettingsChange'], ['bmusage/poller.js', 'onBmUsageSettingsChange'], ['relaycheck/poller.js', 'onRelayCheckSettingsChange']]) {
    assert.match(src(rel), new RegExp(`subscribe:\\s*${name}`), `${rel}: startAdaptiveTimer 에 subscribe 가 없다`);
  }
});

// ── S1: ChatOps 가 inv.* 권한을 우회하지 않는다 ────────────────────────────────────
test('★ S1: ChatOps 는 조회 권한이 없는 종류의 원본 객체·이름을 싣지 않는다', async () => {
  const { chatOps } = await import('../src/llm/chatops.js');
  const deny = { can: (k) => !k.startsWith('inv.') };
  const r = await chatOps('VM 목록 보여줘', null, deny);
  if (r.search) {
    assert.equal(r.search.withheld, true, `권한 없는 종류의 원본 객체를 실었다: ${JSON.stringify(r.search).slice(0, 200)}`);
    assert.equal(r.search.sample, undefined);
  }
  assert.doesNotMatch(r.answer, /undefined건/);
  assert.match(src('routes/insights.js'), /chatOps\([\s\S]{0,200}?\{\s*can:/, '라우트가 권한 판정을 넘기지 않는다');
  const { NL_ENTITY_PERM } = await import('../src/llm/nlSearch.js');
  assert.equal(NL_ENTITY_PERM.vm, 'inv.vms');
  assert.match(src('routes/api/searchNotes.js'), /NL_ENTITY_PERM/, '표가 두 벌이면 한쪽에만 종류가 는다');
});

// ── S2: 로그 분석 붙여넣기가 이벤트 루프를 멈추지 않는다 ───────────────────────────────
test('★ S2: 템플릿 정규식은 긴 줄에서 선형 · 분석 루프는 시간으로도 양보한다', async () => {
  const { templateOf } = await import('../src/loganalysis/template.js');
  const s = src('loganalysis/template.js');
  assert.match(s, /\(\?=\[\\w\.-\]\{0,80\}\\d\)/, "식별자 앞보기가 무제한이면 'x-x-x…' 줄에서 O(n²) 이다");
  // 같은 입력의 결과는 예전과 같다(뜻을 바꾸지 않았다)
  assert.equal(templateOf('[s] server-a1b2c3 id=77 key="abc" 10.1.2.3:443'), '<id> id=<*> key=<*> <ip>');
  const long = '[svc] ' + 'x-'.repeat(40_000);   // v2.613 TESTDOC2613-02: 절대 상한은 1초(회귀와 확실히 갈리는 값 — v2.603) · 입력은 옛 O(n²) 구현이 수 초가 되는 크기
  const t0 = performance.now(); templateOf(long); const dt = performance.now() - t0;
  assert.ok(dt < 1000, `80,000자 한 줄에 ${dt.toFixed(1)}ms(예전 8,000자에 84ms — 초선형이면 80,000자에 약 8초)`);
  const { analyzeItems } = await import('../src/loganalysis/engine.js');
  let interleaved = 0;
  const tick = () => { interleaved += 1; if (interleaved < 1000) setImmediate(tick); };
  setImmediate(tick);
  const items = Array.from({ length: 50 }, (_, i) => ({ ts: Date.now(), tag: 'svc', level: 'info', msg: `line ${i}` }));
  await analyzeItems(items, [], { chunk: 1e9, sliceMs: 0 });
  assert.ok(interleaved >= 10, `분석 중 다른 작업이 끼어들지 못했다(양보 ${interleaved}회)`);
});

// ── packaging 축(P1·P2·P4·P5·P6·P7·P8) ─────────────────────────────────────────────
const ROOT = path.resolve(HERE, '../..');
const repoText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('★ P1: Windows 패키지는 고정 기본 비밀번호를 싣지 않는다(리눅스와 같이 임의 생성)', () => {
  const bat = repoText('packaging/windows/portal.env.example.bat');
  const live = bat.split(/\r?\n/).filter((l) => /^\s*set\s+DEFAULT_ADMIN_PASSWORD\s*=/i.test(l));
  assert.deepEqual(live, [], `주석이 아닌 DEFAULT_ADMIN_PASSWORD 설정이 있다: ${live.join(' | ')}`);
  assert.doesNotMatch(bat, /admin123/);
  assert.doesNotMatch(src('config.js'), /'admin123'/, 'config.js 기본값도 알려진 비밀번호면 안 된다(ENV.md 에 그대로 실린다)');
  assert.match(repoText('packaging/windows/README-WINDOWS.md'), /initial-admin-password\.txt/);
});

test('★ P2: Windows 빌드는 빌드 머신의 런타임 config(auth-secret·DB·감사 로그)를 싣지 않는다', () => {
  const sh = repoText('packaging/windows/build-collector-win.sh').replace(/^\s*#.*$/gm, '');
  const cp = sh.indexOf('cp -r "$REPO_ROOT/server/config" "$APP/server/config"');
  const clean = sh.indexOf('find "$APP/server/config"');
  const zip = sh.indexOf('zip -qr');
  assert.ok(cp > 0 && clean > cp && clean < zip, 'config 복사 뒤·zip 앞에 정리가 있어야 한다');
  const block = sh.slice(clean, sh.indexOf('\n', sh.indexOf('-exec rm', clean)));
  for (const k of ["'auth-secret'", "'*.db'", "'*.ndjson'", "'secrets-key'", "! -name '*.example.json'"]) assert.ok(block.includes(k), `정리 대상에 ${k} 가 없다`);
});

test('★ P5: 오프라인 패키지가 OTP 콘솔 래퍼(otp-enroll.sh)를 담는다', () => {
  const sh = repoText('packaging/offline/build-package.sh').replace(/^\s*#.*$/gm, '');
  assert.match(sh, /cp "\$REPO_ROOT\/otp-enroll\.sh" "\$APP\/otp-enroll\.sh"/);
  assert.match(repoText('packaging/offline/install.sh'), /-x "\$APP_DST\/otp-enroll\.sh"/, 'install.sh 는 이 파일이 있을 때만 링크를 건다');
});

test('★ P6: push sha 를 토큰 탈취·중간자 방어라 주장하지 않는다(자기신고 해시)', () => {
  const raw = fs.readFileSync(path.join(SRC, 'upgrade/upgrade.js'), 'utf8');
  const doc = raw.slice(raw.indexOf('수신측 번들 무결성 판정'), raw.indexOf('export function bundleShaIssue'));
  assert.doesNotMatch(doc, /토큰 탈취\/http 중간자가\s*\n?\s*\*?\s*임의 tar\.gz 를 설치/, '예전의 과장된 방어 주장이 남아 있다');
  assert.match(doc, /중간자 방어가 아니다/);
});

test('★ P4: 업그레이드가 하드링크를 사본으로 풀고 실행 비트를 지킨다 · 심링크는 건너뛴다', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const work = fs.mkdtempSync(path.join(TMP, 'tar-'));
  const pkg = path.join(work, 'vmware-portal');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '9.9.1' }));
  fs.writeFileSync(path.join(pkg, 'bin', 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
  fs.writeFileSync(path.join(pkg, 'native.node'), 'BINARY');
  fs.linkSync(path.join(pkg, 'native.node'), path.join(pkg, 'bin', 'native-link.node'));
  fs.symlinkSync('/etc', path.join(pkg, 'escape'));
  const tgz = path.join(work, 'b.tar.gz');
  try { execFileSync('tar', ['-C', work, '-czf', tgz, 'vmware-portal']); } catch (e) { t.skip(`tar 없음: ${e.message}`); return; }
  const { parseTarGz } = await import('../src/upgrade/archive.js');
  const ents = parseTarGz(fs.readFileSync(tgz));
  const names = ents.map((e) => e.name.replace(/^\.?\/?/, ''));
  assert.ok(names.some((n) => n.endsWith('bin/native-link.node')), `하드링크가 버려졌다: ${names.join(',')}`);
  assert.equal(ents.find((e) => e.name.endsWith('bin/native-link.node')).data.toString(), 'BINARY');
  assert.ok(!names.some((n) => n.endsWith('/escape')), '심링크는 스테이징 밖 쓰기 경로라 건너뛴다');
  assert.equal(ents.find((e) => e.name.endsWith('bin/run.sh')).data.exec, true);
  const { readBundleBytes, applyPackage } = await import('../src/upgrade/upgrade.js');
  const members = readBundleBytes(fs.readFileSync(tgz), 'vmware-portal');
  const dst = path.join(work, 'install', 'app');
  applyPackage(members, dst);
  assert.notEqual(fs.statSync(path.join(dst, 'bin', 'run.sh')).mode & 0o100, 0, '실행 비트가 있던 파일은 실행 가능해야 한다');
  assert.equal(fs.statSync(path.join(dst, 'native.node')).mode & 0o111, 0, '실행 비트가 없던 파일에 붙이지 않는다');
  assert.equal(fs.readFileSync(path.join(dst, 'bin', 'native-link.node'), 'utf8'), 'BINARY');
});

test('★ P7: 스테이징 쓰기 실패 시 부분 .new.<ts> 를 남기지 않는다', async () => {
  const { applyPackage } = await import('../src/upgrade/upgrade.js');
  const base = fs.mkdtempSync(path.join(TMP, 'stg-'));
  const target = path.join(base, 'app');
  // 'a' 를 파일로 쓴 뒤 'a/b' 를 쓰면 mkdir 이 ENOTDIR 로 실패한다.
  const members = new Map([['package.json', Buffer.from('{"version":"9.9.2"}')], ['a', Buffer.from('x')], ['a/b', Buffer.from('y')]]);
  assert.throws(() => applyPackage(members, target));
  const left = fs.readdirSync(base).filter((n) => n.startsWith('app.new.'));
  assert.deepEqual(left, [], `실패한 스테이징이 남았다: ${left.join(',')}`);
  assert.equal(fs.existsSync(target), false, '원본이 없었으면 여전히 없다(반쯤 적용 금지)');
});

test('★ P8: 백업 정리는 install.sh(초)·in-app(ms) 시각을 같은 단위로 비교한다', async () => {
  const { applyPackage } = await import('../src/upgrade/upgrade.js');
  const base = fs.mkdtempSync(path.join(TMP, 'bak-'));
  const target = path.join(base, 'app');
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'package.json'), '{"version":"1.0.0"}');
  const nowS = Math.floor(Date.now() / 1000);
  // 옛 ms 백업 2개(과거) + 방금 한 수동 재설치(초 단위, 가장 최근)
  fs.mkdirSync(path.join(base, `app.bak.${(nowS - 86_400 * 3) * 1000}`));
  fs.mkdirSync(path.join(base, `app.bak.${(nowS - 86_400 * 2) * 1000}`));
  fs.mkdirSync(path.join(base, `app.bak.${nowS - 60}`));
  applyPackage(new Map([['package.json', Buffer.from('{"version":"2.0.0"}')]]), target);
  const baks = fs.readdirSync(base).filter((n) => n.startsWith('app.bak.'));
  assert.equal(baks.length, 2, baks.join(','));
  assert.ok(baks.includes(`app.bak.${nowS - 60}`), `가장 최근의 초 단위 백업이 지워졌다: ${baks.join(',')}`);
});

test('★ PR-9: RMA 결과 회신의 비-2xx 가 로그에 남고, rma-result 는 대용량 본문 게이트에 등록돼 있다', () => {
  const a = src('rma/agent.js');
  const body = a.slice(a.indexOf('async function postResult'), a.indexOf('export async function handleJob'));
  assert.match(body, /r\.ok === false/, '응답 상태를 보지 않으면 413·403 이 무음이다');
  assert.match(body, /HTTP \$\{r\.status\}/);
  assert.match(src('index.js'), /app\.use\('\/api\/central\/rma-result', BIG_JSON\)/);
});

test('★ L4: iDRAC 인증 캐시는 LRU · 대상이 512 를 넘어도 세션을 매 주기 새로 만들지 않는다 · 밀려난 세션은 DELETE', async () => {
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  let made = 0, deleted = 0;
  const live = new Set();
  const srv = http.createServer((req, res) => {
    // 'b-' 로 시작하는 계정은 Basic 을 받는 iDRAC 처럼 굴게 한다(LRU 순서 확인용).
    const basicUser = Buffer.from(String(req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString().split(':')[0];
    if (basicUser.startsWith('b-')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"Members":[]}'); }
    if (req.method === 'POST' && req.url === '/redfish/v1/SessionService/Sessions') {
      made += 1; const tok = `tok-${made}`; live.add(tok);
      req.resume(); res.writeHead(201, { 'X-Auth-Token': tok, Location: `/redfish/v1/SessionService/Sessions/${made}` }); return res.end('{}');
    }
    if (req.method === 'DELETE' && req.url.startsWith('/redfish/v1/SessionService/Sessions/')) { deleted += 1; live.delete(req.headers['x-auth-token']); res.writeHead(204); return res.end(); }
    if (req.headers['x-auth-token'] && live.has(req.headers['x-auth-token'])) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"Members":[]}'); }
    res.writeHead(401); res.end('{}'); // Basic 비활성(세션 전용) iDRAC
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const script = `
    const { fetchPower, authCacheInfo } = await import(${JSON.stringify(path.join(SRC, 'idrac/redfish.js'))});
    const n = Number(process.env.N);
    const hit = (u) => fetchPower({ host: 'http://127.0.0.1:${port}', username: u, password: 'p' }).catch(() => {});
    if (process.env.MODE === 'hot') {
      // 자주 쓰는 세션 키 10개 사이에 한 번 쓰고 마는 키 n개 — LRU 면 자주 쓰는 키는 밀려나지 않는다.
      for (let i = 0; i < n; i++) { await hit('hot' + (i % 10)); await hit('cold' + i); }
    } else if (process.env.MODE === 'basic') {
      for (let i = 0; i < 64; i++) await hit('b-' + i);   // 상한까지 채운다
      await hit('b-0');                                     // 가장 오래된 키를 다시 쓴다 → 맨 뒤로
      await hit('b-new');                                   // 하나 더 → 밀려나는 것은 b-1 이어야 한다
    } else {
      for (let round = 0; round < 2; round++) for (let i = 0; i < n; i++) await hit('u' + i);
    }
    await new Promise((r) => setTimeout(r, 300)); // DELETE 는 기다리지 않고 나간다
    console.log(JSON.stringify(authCacheInfo()));`;
  const run = async (env) => {
    const before = made, delBefore = deleted;
    const out = await new Promise((resolve) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, CONFIG_DIR: TMP, ...env } });
      let so = ''; c.stdout.on('data', (d) => { so += d; }); c.on('close', () => resolve(so));
    });
    return { made: made - before, deleted: deleted - delBefore, info: JSON.parse(out.trim().split('\n').pop() || '{}') };
  };
  try {
    const big = await run({ N: '600' });
    assert.equal(big.made, 600, `2회 × 600 키에서 세션은 키마다 1번만 만들어야 한다(예전 FIFO 512 는 1,200) — ${big.made}`);
    assert.ok(big.info.max >= 4096);
    const small = await run({ N: '100', IDRAC_AUTH_CACHE_MAX: '64' });
    assert.ok(small.made > 100, '상한보다 대상이 많으면 밀려나는 것은 어쩔 수 없다');
    assert.ok(small.deleted >= small.made - 64, `밀려난 세션을 닫아야 한다(만듦 ${small.made} · 닫음 ${small.deleted})`);
    const hot = await run({ N: '200', MODE: 'hot', IDRAC_AUTH_CACHE_MAX: '64' });
    assert.equal(hot.made, 210, `자주 쓰는 키 10개는 한 번씩만 세션을 만들어야 한다(LRU) — 만듦 ${hot.made}`);
    const basic = await run({ N: '0', MODE: 'basic', IDRAC_AUTH_CACHE_MAX: '64' });
    assert.ok(basic.info.order.includes('b-0') && !basic.info.order.includes('b-1'), `다시 쓴 키가 뒤로 가지 않았다(FIFO): 앞 ${basic.info.order.slice(0, 3)}`);
  } finally { srv.close(); }
});
