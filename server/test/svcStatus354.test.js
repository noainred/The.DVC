/**
 * svcStatus354 — 포탈 서비스 상태 모니터링(v3.54 · 설계 docs/design/portal-svc-status/README.md) 회귀.
 *
 * 고정하는 것:
 *  ① 판정 코어(judge.js) — 끊김 = 연속 N회 · 그 전 실패는 직전 판정 유지 · 처음부터 실패 = 판정 중 · 지연 = 대상별 평소 × 배수 ∧ 최소 차이 · 평소 모름 = 지연 판정 안 함 ·
 *     못 잼 = 측정 없음/멈춤(합계에 안 들어감) · 시한은 평소가 크면 늘린다(상한) · 알림 수준(끈 종류 · 못 잼 시한 · 사람이 뺀 대상은 조용히).
 *  ② 스토리지 접속처 판정 하나(storage/endpoint.js) — 수집기 6개에 env 포트 사본이 남지 않았다 · 카탈로그가 PowerMax 8443 · Isilon REST 8080 · SSH 포트를 쓴다.
 *  ③ 대상 계획(targets.js) — 등록된 주소:포트 그대로 · 기본 포트 아님 판정(URL 이 지운 :443 도) · 측정하는 곳(중앙/담당 엣지/담당 모름) ·
 *     꺼짐 · 제외 · 데모(live) · 설정 오류 · 못 읽은 등록부는 직전 목록 보류(제외는 지금 설정으로 다시 판정).
 *  ④ 저장(db.js) — 재전송(같은 시각)은 칸 · 판정을 두 번 세지 않는다 · 늦게 온 행은 최신값을 바꾸지 않는다 · 사건은 판정이 바뀔 때만 · 평소 = 성공 표본 중앙값(최소 표본).
 *  ⑤ 화면 행(view.js) — 엣지 대상의 '값 없음' 사유 · 띠 · 성공률 · 합계(꺼짐 · 제외 · 설정 오류는 따로).
 *  ⑥ 엣지 수신(service.js) — 인증된 agent 의 자기 몫 · 중앙이 준 접속처와 같을 때만 · 행 나이로 시각 환산 · 이상한 값은 버리고 센다 · 자기 몫 설정만 내려간다.
 *  ⑦ 메일 계획(notify.js) — 처음 본 상태는 기준점만 · 바뀐 것만 · 법인 묶음 · 법인이 많으면 요약 · 정책상 꺼짐이면 커서만 옮긴다.
 *  ⑧ 실제 경로 — 중앙 주기(진짜 TCP 연결 · 루프백 리스너)로 정상 → 끊김(연속 N회) → 복구, 엣지 워커 진입 함수를 가짜 중앙에 대고 부른다(gzip · a · 0건 보고 · 꺼짐 보고).
 *  ⑨ 배선 — 도구 키 · 카탈로그 · 메일 종류 · 데모 계정 · BIG_JSON · 엣지 로그 spec · 데이터 흐름 분류 · 라우트 게이트(관리자 ∧ 전체 범위) · 데모 계정 판본 · 주소 가림.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import zlib from 'node:zlib';
import { stripComments } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svcstatus354-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
const rmTmp = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } };
after(() => { rmTmp(); process.once('exit', rmTmp); });

const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const bare = (p) => stripComments(read(p));
// 기준 시각 — 정시 경계에서 떨어뜨린 실제 시각(docs/rules/common.md)
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

const J = await import('../src/svcstatus/judge.js');
const EP = await import('../src/storage/endpoint.js');
const T = await import('../src/svcstatus/targets.js');
const DB = await import('../src/svcstatus/db.js');
const V = await import('../src/svcstatus/view.js');
const SET = await import('../src/svcstatus/settings.js');
const SVC = await import('../src/svcstatus/service.js');
const N = await import('../src/svcstatus/notify.js');
const S = { failThreshold: 3, slowFactor: 2, slowMinDeltaMs: 30, timeoutMs: 2_500 };

/* ───────────────────────── ① 판정 코어 ───────────────────────── */

test('① 끊김 = 연속 N회 · 그 전 실패는 직전 판정 유지 · 처음부터 실패는 판정 중 · 성공 한 번이면 복구', () => {
  let p = null;
  p = J.judgeSample(p, { ok: true, ms: 10 }, S, null); assert.equal(p.state, 'ok'); assert.equal(p.st, J.SAMPLE.ok);
  p = J.judgeSample(p, { ok: false }, S, null); assert.equal(p.state, 'ok', '1회 실패는 끊김이 아니다'); assert.equal(p.st, J.SAMPLE.fail); assert.equal(p.failStreak, 1);
  p = J.judgeSample(p, { ok: false }, S, null); assert.equal(p.state, 'ok'); assert.equal(p.failStreak, 2);
  p = J.judgeSample(p, { ok: false }, S, null); assert.equal(p.state, 'down', '연속 3회째에 끊김'); assert.equal(p.st, J.SAMPLE.down);
  p = J.judgeSample(p, { ok: false }, S, null); assert.equal(p.state, 'down'); assert.equal(p.failStreak, 4);
  p = J.judgeSample(p, { ok: true, ms: 12 }, S, null); assert.equal(p.state, 'ok', '성공 한 번이면 복구'); assert.equal(p.failStreak, 0);
  const first = J.judgeSample(null, { ok: false }, S, null);
  assert.equal(first.state, 'pending', '처음부터 실패면 판정 전(끊김으로 단정하지 않는다)');
  assert.equal(J.judgeSample({ state: 'pending', failStreak: 2 }, { ok: false }, S, null).state, 'down');
  // 임계 1 — 한 번 실패가 곧 끊김(변이: failStreak >= threshold 를 > 로 바꾸면 여기서 깨진다)
  assert.equal(J.judgeSample(null, { ok: false }, { ...S, failThreshold: 1 }, null).state, 'down');
});

test('① 지연 = 평소 × 배수 ∧ 최소 차이 · 평소를 모르면 지연을 판정하지 않는다 · 800ms 대상이 늘 지연으로 뜨지 않는다', () => {
  assert.equal(J.judgeSample(null, { ok: true, ms: 9_999 }, S, null).state, 'ok', '평소 모름 → 지연 판정 없음');
  assert.equal(J.judgeSample(null, { ok: true, ms: 1_700 }, S, 820).state, 'slow');
  assert.equal(J.judgeSample(null, { ok: true, ms: 1_640 }, S, 820).state, 'ok', '경계(평소 × 2)는 지연이 아니다(초과만)');
  assert.equal(J.judgeSample(null, { ok: true, ms: 845 }, S, 820).state, 'ok', '고RTT 대상의 평소 근처는 정상');
  // LAN 2ms → 5ms 는 2.5배지만 차이 3ms — 최소 차이(30ms) 밑이면 지연이 아니다
  assert.equal(J.judgeSample(null, { ok: true, ms: 5 }, S, 2).state, 'ok');
  assert.equal(J.judgeSample(null, { ok: true, ms: 33 }, S, 2).state, 'slow');
  assert.equal(J.slowAtOf(820, S), 1_640); assert.equal(J.slowAtOf(2, S), 32); assert.equal(J.slowAtOf(null, S), null); assert.equal(J.slowAtOf(0, S), null);
});

test('① 화면 상태 — 측정 없음 · 멈춤 · 판정 중은 못 잼(사유 코드) · 시한은 평소 × 4 로 늘리되 상한', () => {
  const staleMs = J.staleLimitMs(60_000);
  assert.equal(staleMs, 240_000);
  assert.equal(J.staleLimitMs(600_000), 1_860_000);
  assert.deepEqual(J.presentState(null, { now: NOW, staleMs }), { state: 'unknown', reason: 'no-data' });
  assert.deepEqual(J.presentState({ ts: NOW - staleMs - 1, state: 'ok' }, { now: NOW, staleMs }), { state: 'unknown', reason: 'stale' });
  assert.deepEqual(J.presentState({ ts: NOW - staleMs, state: 'down' }, { now: NOW, staleMs }), { state: 'down', reason: null });
  assert.deepEqual(J.presentState({ ts: NOW, state: 'pending' }, { now: NOW, staleMs }), { state: 'unknown', reason: 'judging' });
  assert.equal(J.timeoutFor(null, S), 2_500); assert.equal(J.timeoutFor(820, S), 3_280); assert.equal(J.timeoutFor(9_000, S), J.TIMEOUT_CEIL_MS);
  assert.equal(J.median([3, 1, 2]), 2); assert.equal(J.median([4, 1, 3, 2]), 2.5); assert.equal(J.median([null, '', undefined]), null);
  assert.ok(J.MEASURED_STATES.every((s) => J.STATE_CODES.includes(s)));
  for (const s of ['off', 'excluded', 'problem']) assert.ok(!J.MEASURED_STATES.includes(s), `${s} 는 합계 밖`);
});

test('① 알림 수준 — 끈 종류는 정상 · 못 잼은 정한 분이 지나야 · 사람이 끄거나 뺀 대상은 조용히', () => {
  const al = { down: true, slow: false, unknownMin: 30 };
  assert.equal(J.alertLevelOf('down', { alerts: al }), 'down');
  assert.equal(J.alertLevelOf('down', { alerts: { ...al, down: false } }), 'ok');
  assert.equal(J.alertLevelOf('slow', { alerts: al }), 'ok');
  assert.equal(J.alertLevelOf('slow', { alerts: { ...al, slow: true } }), 'slow');
  assert.equal(J.alertLevelOf('unknown', { alerts: al, unknownForMs: 29 * 60_000 }), 'hold');
  assert.equal(J.alertLevelOf('unknown', { alerts: al, unknownForMs: 30 * 60_000 }), 'unknown');
  assert.equal(J.alertLevelOf('unknown', { alerts: { ...al, unknownMin: 0 }, unknownForMs: 9e9 }), 'hold', '0 = 못 잼 알림 끔');
  for (const s of ['off', 'excluded', 'problem']) assert.equal(J.alertLevelOf(s, { alerts: al }), 'quiet');
});

/* ───────────────────────── ② 스토리지 접속처 ───────────────────────── */

test('② 스토리지 접속처는 storage/endpoint.js 하나 — 수집기에 env 포트 사본이 없다 · 기본값 · env · SSH 포트 · 수집 방식 기본', () => {
  for (const f of ['isilon', 'powerstore', 'unity', 'xtremio', 'powermax', 'vplex', 'arrayPerf']) assert.match(bare(`storage/collectors/${f}.js`), /restPortOf\(/, `${f}.js 가 공용 표를 쓰지 않는다`);
  // 전수 — server/src 어디에서도 스토리지 포트 env 를 직접 읽지 않는다(표 하나 · 5분 표본 arrayPerf 의 사본 3곳을 전량 검증에서 찾았다)
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
  const leaks = walk(SRC).filter((p) => !p.endsWith(path.join('storage', 'endpoint.js')) && /process\.env\.STORAGE_[A-Z]+_PORT/.test(stripComments(fs.readFileSync(p, 'utf8'))));
  assert.deepEqual(leaks.map((p) => path.relative(SRC, p)), [], '스토리지 포트 env 사본');
  assert.equal(EP.restPortOf('isilon', {}), 8080); assert.equal(EP.restPortOf('powermax', {}), 8443); assert.equal(EP.restPortOf('vmax', {}), 8443);
  assert.equal(EP.restPortOf('unity480', {}), 443); assert.equal(EP.restPortOf('powermax', { STORAGE_UNISPHERE_PORT: '9443' }), 9443);
  assert.equal(EP.restPortOf('powermax', { STORAGE_UNISPHERE_PORT: '70000' }), 8443, '범위 밖 env 는 기본값');
  assert.deepEqual(EP.storageEndpointOf({ type: 'isilon', host: 'a', collectMethod: '' }, {}).method, 'ssh', '수집 방식이 빈 옛 Isilon = SSH(기본)');
  const ssh = EP.storageEndpointOf({ type: 'unity480', host: 'a', collectMethod: 'ssh', sshPort: 2222 }, {});
  assert.equal(ssh.port, 2222); assert.equal(ssh.defaultPort, 22);
  const api = EP.storageEndpointOf({ type: 'powermax', host: 'a', collectMethod: 'api' }, { STORAGE_UNISPHERE_PORT: '9443' });
  assert.equal(api.port, 9443); assert.equal(api.defaultPort, 8443);
});

test('② 설정 카탈로그 — 스토리지 REST 를 기종 포트로(PowerMax 8443 · Isilon REST 8080) · 수집 서버 법인 id 를 싣는다', async () => {
  const { buildSettingsTargets } = await import('../src/linkcheck/settingsLinks.js');
  const built = await buildSettingsTargets({
    storage: [
      { id: 'st-pm', type: 'powermax', name: 'pm', host: '10.0.0.5', collectMethod: 'api' },
      { id: 'st-isi', type: 'isilon', name: 'isi', host: '10.0.0.6', collectMethod: 'api' },
      { id: 'st-ssh', type: 'unity480', name: 'un', host: '10.0.0.7', collectMethod: 'ssh', sshPort: 2200 },
    ],
    collectors: [{ id: 'edge-a', name: 'edge-a', url: 'https://198.51.100.24:20443', datacenterId: 'us-east' }],
    snapshot: { vcenters: [] },
  });
  const by = new Map(built.targets.map((x) => [x.ref, x]));
  assert.equal(by.get('st-pm').port, 8443); assert.equal(by.get('st-isi').port, 8080); assert.equal(by.get('st-ssh').port, 2200);
  assert.equal(by.get('st-ssh').kind, 'set:storage-ssh');
  assert.equal(by.get('edge-a').port, 20443); assert.equal(by.get('edge-a').facts.datacenterId, 'us-east');
});

/* ───────────────────────── ③ 대상 계획 ───────────────────────── */

function cat(over = {}) {
  return {
    targets: [
      { id: 'set:collector|e1', kind: 'set:collector', ref: 'e1', name: 'edge-1', host: 'edge1.corp', port: 20443, scheme: 'https', enabled: true, agent: '', facts: {} },
      { id: 'set:collector|e2', kind: 'set:collector', ref: 'e2', name: 'edge-2', host: 'edge2.corp', port: 443, scheme: 'https', enabled: true, agent: '', facts: {} },
      { id: 'set:vcenter|vc-d', kind: 'set:vcenter', ref: 'vc-d', name: 'vc-direct', host: '10.1.1.10', port: 443, scheme: 'https', enabled: true, agent: '', facts: { collectMode: 'direct' } },
      { id: 'set:vcenter|vc-s', kind: 'set:vcenter', ref: 'vc-s', name: 'vc-site', host: '10.2.1.10', port: 8443, scheme: 'https', enabled: true, agent: '', facts: { collectMode: 'site' } },
      { id: 'set:vcenter|vc-u', kind: 'set:vcenter', ref: 'vc-u', name: 'vc-unassigned', host: '10.3.1.10', port: 443, scheme: 'https', enabled: true, agent: '', facts: { collectMode: 'site' } },
      { id: 'set:cvp|c1', kind: 'set:cvp', ref: 'c1', name: 'cvp-1', host: 'cvp.corp', port: 80, scheme: 'http', enabled: true, agent: 'edge-2', facts: {} },
      { id: 'set:storage-api|s1', kind: 'set:storage-api', ref: 's1', name: 'pmax', host: '10.4.1.1', port: 8443, enabled: true, agent: '', facts: { type: 'powermax', defaultPort: 8443 } },
      { id: 'set:storage-api|s2', kind: 'set:storage-api', ref: 's2', name: 'off', host: '10.4.1.2', port: 443, enabled: false, agent: '', facts: { type: 'unity480', defaultPort: 443 } },
      { id: 'set:storage-ssh|s3', kind: 'set:storage-ssh', ref: 's3', name: 'un-ssh', host: '10.5.1.1', port: 22, enabled: true, agent: 'edge-9', facts: { type: 'unity480', defaultPort: 22 } },
      { id: 'set:storage-api|mock-st-1', kind: 'set:storage-api', ref: 'mock-st-1', name: 'demo', host: '10.9.9.9', port: 443, enabled: true, agent: '', facts: { type: 'unity480', defaultPort: 443 } },
      { id: 'set:nsx|n1', kind: 'set:nsx', ref: 'n1', name: 'nsx', host: 'nsx', port: 443, enabled: true, facts: {} },
    ],
    problems: [{ kind: 'set:storage-api', ref: 's9', name: 'bad', address: '::', reason: '주소를 해석하지 못했습니다(x).' }],
    sourceErrors: [],
    ...over,
  };
}
const SETTINGS = SET.normalizeSettings({});

test('③ 등록된 주소:포트 그대로 · 기본 포트 아님 · 측정하는 곳 · 꺼짐/제외/데모/설정 오류/담당 모름', () => {
  const siteOwner = new Map([['vc-s', 'edge-2']]);
  const settings = SET.normalizeSettings({ excluded: [{ id: 'set:collector|e2', reason: '이전 중' }] });
  const { rows } = T.planTargets(cat(), { settings, siteOwner, mock: false });
  const by = new Map(rows.map((r) => [r.id, r]));
  assert.ok(!rows.some((r) => r.id === 'set:nsx|n1'), '네 종류 밖은 넣지 않는다');
  assert.equal(by.get('set:collector|e1').port, 20443); assert.equal(by.get('set:collector|e1').nonDefaultPort, true);
  assert.equal(by.get('set:collector|e1').plan, 'central');
  assert.equal(by.get('set:collector|e2').plan, 'excluded');
  assert.equal(by.get('set:vcenter|vc-d').plan, 'central'); assert.equal(by.get('set:vcenter|vc-d').nonDefaultPort, false, 'URL 이 지운 :443 도 기본 포트');
  assert.equal(by.get('set:vcenter|vc-s').plan, 'edge'); assert.equal(by.get('set:vcenter|vc-s').by, 'edge-2'); assert.equal(by.get('set:vcenter|vc-s').port, 8443);
  assert.equal(by.get('set:vcenter|vc-u').plan, 'unassigned', '담당을 모르면 중앙이 대신 재지 않는다');
  assert.equal(by.get('set:cvp|c1').plan, 'edge'); assert.equal(by.get('set:cvp|c1').defaultPort, 80, 'http 는 80');
  assert.equal(by.get('set:storage-api|s1').nonDefaultPort, false, 'PowerMax 8443 은 그 기종의 기본');
  assert.equal(by.get('set:storage-api|s2').plan, 'off');
  assert.equal(by.get('set:storage-api|mock-st-1').plan, 'demo-live', 'live 에서 데모 항목은 재지 않는다');
  assert.equal(T.planTargets(cat(), { settings, siteOwner, mock: true }).rows.find((r) => r.ref === 'mock-st-1').plan, 'central');
  const bad = rows.find((r) => r.problem);
  assert.equal(bad.plan, 'problem'); assert.equal(bad.host, ''); assert.equal(bad.port, null);
  // 종류를 끄면 그 종류는 통째로 빠진다
  assert.ok(!T.planTargets(cat(), { settings: SET.normalizeSettings({ kinds: { storage: false } }) }).rows.some((r) => r.kind === 'storage'));
});

test('③ 못 읽은 등록부는 직전 목록을 보류한다 — 제외는 지금 설정으로 다시 판정 · 직전이 없으면 비운다', () => {
  const first = T.planTargets(cat(), { settings: SETTINGS, siteOwner: new Map([['vc-s', 'edge-2']]) });
  const broken = cat({ targets: cat().targets.filter((x) => !x.kind.startsWith('set:storage')), problems: [], sourceErrors: [{ source: 'storage', reason: '등록부 파일을 읽지 못했습니다' }] });
  const ex = SET.normalizeSettings({ excluded: [{ id: 'set:storage-api|s1' }] });
  const held = T.planTargets(broken, { settings: ex, previous: first.raw, siteOwner: new Map([['vc-s', 'edge-2']]) });
  assert.deepEqual(held.heldKinds, ['storage']);
  const s1 = held.rows.find((r) => r.id === 'set:storage-api|s1');
  assert.ok(s1, '지우지 않고 보류'); assert.equal(s1.held, true); assert.equal(s1.plan, 'excluded', '보류 중에도 지금 제외가 먹는다');
  assert.equal(held.sourceErrors[0].kind, 'storage');
  const none = T.planTargets(broken, { settings: SETTINGS, previous: new Map() });
  assert.ok(!none.rows.some((r) => r.kind === 'storage'));
  assert.equal(T.isDemoTarget({ host: 'x.demo.invalid' }), true); assert.equal(T.isDemoTarget({ ref: 'vc-1', host: '10.0.0.1' }), false);
});

/* ───────────────────────── ④ 저장 ───────────────────────── */

const U = { id: 'set:collector|db1', host: '192.0.2.10', port: 4000, kind: 'collector', by: 'central' };
test('④ 재전송(같은 시각)은 칸 · 판정을 두 번 세지 않는다 · 늦게 온 행은 최신값을 바꾸지 않는다 · 사건은 바뀔 때만', async () => {
  if (!(await DB.available())) return;
  const t0 = NOW - 10 * 60_000;
  const r1 = await DB.recordResults([{ ...U, ts: t0, ok: true, ms: 20 }], { settings: S });
  assert.equal(r1.stored, 1); assert.equal(r1.events, 1, '첫 판정은 사건(from null)');
  const again = await DB.recordResults([{ ...U, ts: t0, ok: true, ms: 20 }], { settings: S });
  assert.equal(again.stored, 0); assert.equal(again.dup, 1, '같은 시각 재전송은 버린다');
  const b = await DB.bucketsSince(t0 - HOUR);
  const mine = b.filter((x) => x.n > 0);
  assert.equal(mine.reduce((s, x) => s + x.n, 0), 1, '칸이 두 번 세지 않았다');
  // 같은 판정이 이어지면 사건이 없다
  const r2 = await DB.recordResults([{ ...U, ts: t0 + 60_000, ok: true, ms: 22 }], { settings: S });
  assert.equal(r2.events, 0);
  // 실패 두 번(판정 유지) → 세 번째 끊김 사건
  const r3 = await DB.recordResults([{ ...U, ts: t0 + 120_000, ok: false, fk: 'refused' }, { ...U, ts: t0 + 180_000, ok: false, fk: 'refused' }, { ...U, ts: t0 + 240_000, ok: false, fk: 'timeout' }], { settings: S });
  assert.equal(r3.events, 1, '끊김으로 바뀐 사건 하나');
  // 늦게 온 옛 성공 행 — 최신(끊김)을 바꾸지 않는다
  await DB.recordResults([{ ...U, ts: t0 + 30_000, ok: true, ms: 19 }], { settings: S });
  const lat = (await DB.latestRows()).find((x) => x.id === U.id);
  assert.equal(lat.state, 'down'); assert.equal(lat.fail_streak, 3); assert.equal(lat.ts, t0 + 240_000); assert.equal(lat.fk, 'timeout');
  const ev = await DB.eventsForId(U.id);
  assert.deepEqual(ev.map((e) => [e.from_state, e.to_state]), [['ok', 'down'], [null, 'ok']]);
  // 실패 표본의 연결 시간은 0 이 아니라 비움(평균 분모 ms_n 따로)
  const s = await DB.samplesRange(lat.tid, t0, t0 + HOUR);
  assert.equal(s.rows.find((x) => x.ok === 0).ms, null);
  const bk = (await DB.bucketsRange(lat.tid, t0 - HOUR, t0 + HOUR)).reduce((a, x) => ({ n: a.n + x.n, msN: a.msN + x.ms_n }), { n: 0, msN: 0 });
  assert.equal(bk.n, 6); assert.equal(bk.msN, 3, '성공 3건만 연결 시간 평균에');
});

test('④ 주소 · 포트가 바뀌면 다른 감시 단위 — 평소 · 이력이 섞이지 않는다 · 평소 = 성공 표본 중앙값(최소 표본 미만이면 모름)', async () => {
  if (!(await DB.available())) return;
  const id = 'set:vcenter|chg';
  const rows = [];
  for (let i = 0; i < J.BASELINE_MIN_SAMPLES; i++) rows.push({ id, host: '192.0.2.20', port: 443, kind: 'vcenter', ts: NOW - 3 * HOUR + i * 60_000, ok: true, ms: 100 + (i % 3), by: 'central' });
  await DB.recordResults(rows, { settings: S });
  await DB.recordResults([{ id, host: '192.0.2.20', port: 8443, kind: 'vcenter', ts: NOW - HOUR, ok: true, ms: 9, by: 'central' }], { settings: S });
  await DB.refreshBaselines({ now: NOW, force: true });
  const lat = (await DB.latestRows()).filter((x) => x.id === id);
  assert.equal(lat.length, 2, '포트가 바뀌면 단위가 둘');
  assert.equal(lat.find((x) => x.port === 443).base_ms, 101);
  assert.equal(lat.find((x) => x.port === 8443).base_ms, null, '표본이 모자라면 평소를 모른다');
  assert.equal((await DB.unitsForId(id)).length, 2);
});

/* ───────────────────────── ⑤ 화면 행 ───────────────────────── */

test('⑤ 엣지 대상의 값 없음 사유 · 띠 · 성공률 · 합계는 꺼짐 · 제외 · 설정 오류를 따로 센다', () => {
  const { rows: plan } = T.planTargets(cat(), { settings: SET.normalizeSettings({ excluded: [{ id: 'set:collector|e2' }] }), siteOwner: new Map([['vc-s', 'edge-2']]) });
  const e1 = plan.find((r) => r.id === 'set:collector|e1');
  const lat = new Map([[V.unitKey(e1.id, e1.host, e1.port), { tid: 1, ts: NOW - 60_000, ok: 1, ms: 30, state: 'ok', since_ts: NOW - HOUR, fail_streak: 0, base_ms: 28 }]]);
  const curB = Math.floor(NOW / DB.BUCKET_MS) * DB.BUCKET_MS;
  const buckets = new Map([[1, [{ b: curB, n: 30, ok_n: 29, worst: 2 }, { b: curB - DB.BUCKET_MS, n: 30, ok_n: 30, worst: 0 }, { b: curB - 50 * DB.BUCKET_MS, n: 9, ok_n: 0, worst: 3 }]]]);
  const staleMs = J.staleLimitMs(60_000);
  const edge = { reports: new Map(), versions: new Map([['edge-2', '3.53.0']]), minEdgeVersion: '3.54.0', startedAt: NOW - HOUR, intervalMs: 60_000 };
  const rows = V.buildRows(plan, lat, buckets, { now: NOW, settings: S, staleMs, edge });
  const by = new Map(rows.map((r) => [r.id, r]));
  const r1 = by.get('set:collector|e1');
  assert.equal(r1.state, 'ok'); assert.equal(r1.ms, 30); assert.equal(r1.address, 'edge1.corp:20443');
  assert.equal(r1.strip.length, V.STRIP_CELLS); assert.equal(r1.strip.at(-1), 2); assert.equal(r1.strip.at(-2), 0); assert.equal(r1.strip.at(-3), null);
  assert.equal(r1.avail24, 98.3, '24시간 밖 칸은 성공률에 넣지 않는다');
  assert.equal(by.get('set:vcenter|vc-s').reason, 'edge-old-version', '엣지 버전이 낮으면 기다려도 오지 않는다고 말한다');
  assert.equal(by.get('set:vcenter|vc-u').reason, 'unassigned');
  assert.equal(by.get('set:vcenter|vc-d').reason, 'no-data');
  const withRep = V.buildRows(plan, lat, buckets, { now: NOW, settings: S, staleMs, edge: { ...edge, reports: new Map([['edge-2', { at: NOW - 30_000 }]]) } });
  assert.equal(withRep.find((r) => r.id === 'set:vcenter|vc-s').reason, 'edge-missing', '엣지가 보고했는데 이 대상이 없다');
  const c = V.countsOf(rows);
  assert.equal(c.excluded, 1); assert.equal(c.off, 2); assert.equal(c.problem, 1);
  assert.equal(c.total, c.ok + c.slow + c.down + c.unknown);
  assert.equal(c.total, rows.length - c.off - c.excluded - c.problem);
  // 주소 가림
  const hid = V.buildRows(plan, lat, buckets, { now: NOW, settings: S, staleMs, edge, maskAddress: true });
  assert.ok(hid.every((r) => r.host === '' && r.port === null && r.address === ''));
  assert.ok(!('_tid' in V.publicRow(r1)), '서버 전용 칸은 응답에서 뺀다');
});

/* ───────────────────────── ⑥ 엣지 수신 ───────────────────────── */

async function seedPlan() {
  SVC._resetSvcStatusServiceForTest();
  return SVC.getPlan({ force: true, deps: { build: async () => cat(), siteOwner: new Map([['vc-s', 'edge-2']]), corpOf: () => ({ key: '', label: '' }), settings: SETTINGS, mock: false } });
}
test('⑥ 엣지 보고 — 자기 몫 · 중앙이 준 접속처와 같을 때만 · 행 나이로 시각 · 이상한 값은 버리고 센다', async () => {
  if (!(await DB.available())) return;
  await seedPlan();
  const cfg = await SVC.edgeConfigFor('EDGE-2');
  assert.equal(cfg.status, 200);
  assert.deepEqual(cfg.body.targets.map((x) => x.id).sort(), ['set:cvp|c1', 'set:vcenter|vc-s'], '자기 몫만(대소문자 무시 · 다른 엣지 edge-9 의 몫은 없다)');
  assert.deepEqual((await SVC.edgeConfigFor('edge-9')).body.targets.map((x) => x.id), ['set:storage-ssh|s3']);
  assert.ok(cfg.body.targets.every((x) => !('token' in x) && !('password' in x)));
  const now = NOW;
  const out = await SVC.putEdgeReport('edge-2', {
    version: '3.54.0',
    results: [
      { id: 'set:vcenter|vc-s', host: '10.2.1.10', port: 8443, ok: true, ms: 4, a: 2_000 },
      { id: 'set:vcenter|vc-s', host: '10.2.1.10', port: 443, ok: true, ms: 4, a: 0 },       // 포트가 다르다
      { id: 'set:collector|e1', host: 'edge1.corp', port: 20443, ok: true, ms: 1, a: 0 },     // 남의 몫(중앙이 잰다)
      { id: 'set:storage-ssh|s3', host: '10.5.1.1', port: 22, ok: true, ms: 1, a: 0 },        // 다른 엣지의 몫
      { id: 'set:cvp|c1', host: 'CVP.corp', port: 80, ok: false, fk: '<script>', a: -5 },     // 모르는 실패 종류 · 음수 나이
      'x', null, [1],
    ],
  }, { now });
  assert.equal(out.stored, 2); assert.equal(out.rejected, 6, '포트 다름 · 남의 몫 2 · 객체 아님 3'); assert.equal(out.notAssigned, 2); assert.equal(out.badTime, 1);
  assert.deepEqual(await DB.eventsForId('set:cvp|c1'), [], '처음부터 실패(판정 중)는 사건이 아니다');
  const lat = await DB.latestRows();
  const vs = lat.find((x) => x.id === 'set:vcenter|vc-s');
  assert.equal(vs.ts, now - 2_000, '수신 시각 − 행 나이'); assert.equal(vs.by_node, 'edge-2');
  assert.equal(lat.find((x) => x.id === 'set:cvp|c1').fk, 'unknown', '모르는 실패 종류는 unknown');
  assert.ok(!lat.some((x) => x.id === 'set:collector|e1' && x.by_node === 'edge-2'));
  await assert.rejects(() => SVC.putEdgeReport('', {}), /agent/);
  // 중앙이 준 접속처와 다른 행만 온 보고 — 대상당 한 행 규칙과 별개로 접속처 대조가 막는다(변이 M11 이 1회차 뒤 살아남았던 자리)
  const mis = await SVC.putEdgeReport('edge-2', { results: [{ id: 'set:vcenter|vc-s', host: '10.2.1.10', port: 443, ok: false, fk: 'refused', a: 0 }] }, { now: now + 1_000 });
  assert.equal(mis.stored, 0); assert.equal(mis.rejected, 1);
  const big = await SVC.putEdgeReport('edge-2', { results: new Array(SVC.REPORT_MAX + 3).fill({ id: 'nope' }) }, { now });
  assert.equal(big.omitted, 3, '상한을 넘는 것은 버리고 센다');
});

/* ───────────────────────── ⑦ 메일 계획 ───────────────────────── */

const R = (o) => ({ _tid: o.tid, _notified: o.notified ?? null, state: o.state, since: o.since ?? null, lastTs: o.lastTs ?? NOW, corp: { key: o.corp || 'a', label: o.corp || 'A' }, kindLabel: 'vCenter', name: `n${o.tid}`, address: 'x:443', by: 'central', ms: null, baseMs: null, failKind: null });
test('⑦ 처음 본 상태는 기준점만 · 바뀐 것만 · 사람이 뺀 대상은 조용히 정상으로 · 못 잼은 정한 분 뒤', () => {
  const alerts = { down: true, slow: false, unknownMin: 30 };
  const { events, quiet } = N.planMail([
    R({ tid: 1, state: 'down' }),                                   // 처음 — 기준점
    R({ tid: 2, state: 'down', notified: 'ok' }),                   // 끊김
    R({ tid: 3, state: 'ok', notified: 'down' }),                   // 복구
    R({ tid: 4, state: 'slow', notified: 'ok' }),                   // 지연 알림 꺼짐 → 정상 수준 = 변화 없음
    R({ tid: 5, state: 'excluded', notified: 'down' }),             // 사람이 뺐다 → 조용히 ok
    R({ tid: 6, state: 'unknown', notified: 'ok', since: NOW - 10 * 60_000 }),   // 아직 짧다 → 보류
    R({ tid: 7, state: 'unknown', notified: 'ok', since: NOW - 31 * 60_000 }),   // 못 잼 알림
    { ...R({ tid: 8, state: 'down' }), _tid: null },               // 측정한 적 없음
  ], { alerts, now: NOW });
  assert.deepEqual(events.map((e) => [e.row._tid, e.from, e.to]), [[2, 'ok', 'down'], [3, 'down', 'ok'], [7, 'ok', 'unknown']]);
  assert.deepEqual(quiet, [[1, 'down'], [5, 'ok']]);
  const m = N.buildMail(events, { corpLabel: 'A' });
  assert.match(m.subject, /끊김 1 · 못 잼 1 · 복구 1 — A/);
  assert.doesNotMatch(m.html, /<script/);
});
test('⑦ 법인별 한 통 · 법인이 많으면 요약 한 통', () => {
  const ev = (corp) => ({ row: R({ tid: 1, state: 'down', corp }), from: 'ok', to: 'down' });
  assert.equal(N.groupMails([ev('a'), ev('a'), ev('b')]).length, 2);
  const many = N.groupMails(['a', 'b', 'c', 'd', 'e', 'f'].map(ev));
  assert.equal(many.length, 1); assert.equal(many[0].summary, true);
  assert.match(N.buildMail(many[0].events, many[0]).subject, /전체 6개 법인/);
});
test('⑦ 메일이 정책상 꺼져 있으면 보내지 않고 커서만 옮긴다(나중에 쌓인 변화를 쏟지 않게)', async () => {
  if (!(await DB.available())) return;
  await seedPlan();
  N._resetSvcStatusMailForTest();
  let sent = 0;
  const r = await N.svcStatusMailTick({ now: NOW, send: async () => { sent += 1; return { ok: true }; }, mock: false });
  assert.equal(sent, 0, '메일 설정이 없으면(꺼짐) 보내지 않는다');
  if (r?.skipped) assert.equal(r.skipped, 'policy');
  const after1 = (await DB.latestRows()).filter((x) => x.notified != null);
  assert.ok(after1.length > 0, '기준점 · 커서가 섰다');
});

/* ───────────────────────── ⑧ 실제 경로 ───────────────────────── */

const listen = (srv, port = 0) => new Promise((res, rej) => { srv.once('error', rej); srv.listen(port, '127.0.0.1', () => res(srv.address().port)); });
const closeSrv = (srv) => new Promise((res) => srv.close(() => res()));

test('⑧ 중앙 주기 — 진짜 TCP 연결(루프백): 정상 → 연속 N회 실패에 끊김 → 다시 열리면 복구 · 주기는 트랜잭션 하나', async () => {
  if (!(await DB.available())) return;
  const P = await import('../src/svcstatus/poller.js');
  P._resetSvcStatusPollerForTest(); SVC._resetSvcStatusServiceForTest();
  let srv = net.createServer((s) => s.destroy());
  const port = await listen(srv);
  const build = async () => ({ targets: [{ id: 'set:collector|loop', kind: 'set:collector', ref: 'loop', name: 'loop-edge', host: '127.0.0.1', port, scheme: 'https', enabled: true, agent: '', facts: {} }], problems: [], sourceErrors: [] });
  const planDeps = { build, siteOwner: new Map(), corpOf: () => ({ key: '', label: '' }), mock: false };
  let clock = NOW - 20 * 60_000;
  const tick = async () => { clock += 60_000; return P.pollSvcStatusOnce({ planDeps, now: () => clock }); };
  const stateOf = async () => (await DB.latestRows()).find((x) => x.id === 'set:collector|loop');
  let r = await tick();
  assert.equal(r.ok, true); assert.equal(r.measured, 1); assert.equal(r.failed, 0);
  let lat = await stateOf();
  assert.equal(lat.state, 'ok'); assert.ok(lat.ms != null && lat.ms >= 0);
  await closeSrv(srv);
  await tick(); assert.equal((await stateOf()).state, 'ok', '1회 실패 — 아직 정상');
  await tick(); assert.equal((await stateOf()).state, 'ok');
  await tick(); lat = await stateOf();
  assert.equal(lat.state, 'down', '연속 3회째 끊김'); assert.equal(lat.fk, 'refused', '닫힌 포트는 연결 거부');
  srv = net.createServer((s) => s.destroy());
  try { await listen(srv, port); } catch { return; }   // 같은 포트를 다시 못 얻는 환경이면 복구 단계는 건너뛴다
  await tick();
  assert.equal((await stateOf()).state, 'ok', '성공 한 번이면 복구');
  await closeSrv(srv);
  const ev = await DB.eventsForId('set:collector|loop');
  assert.deepEqual(ev.map((e) => e.to_state), ['ok', 'down', 'ok']);
  // 수동 실행은 가드를 공유한다
  const st = P.svcStatusPollerStatus();
  assert.equal(st.running, false); assert.equal(st.last.measured, 1);
  assert.equal(P.cycleMaxMs(60_000), 300_000); assert.equal(P.cycleMaxMs(600_000), 1_800_000);
});

test('⑧ 엣지 워커 진입 함수를 가짜 중앙에 대고 부른다 — 자기 몫 측정 · gzip · 행 나이 · 엣지 포트 차이(lp) · 0건 · 꺼짐 · 구버전 중앙', async () => {
  const W = await import('../src/agent/svcStatusWorker.js');
  const { config } = await import('../src/config.js');
  const probeSrv = net.createServer((s) => s.destroy());
  const openPort = await listen(probeSrv);
  let mode = 'normal'; const posts = []; let cfgReq = null;
  const central = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/api/central/svc-status-config')) {
      cfgReq = { url: req.url, token: req.headers['x-central-token'] };
      if (mode === 'old') { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<html>nope</html>'); }
      const targets = mode === 'empty' ? [] : [
        { id: 'set:vcenter|a', kind: 'vcenter', host: '127.0.0.1', port: openPort, timeoutMs: 1 },
        { id: 'set:storage-api|b', kind: 'storage', type: 'powermax', method: 'api', host: '127.0.0.1', port: 9, timeoutMs: 900_000 },
      ];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, enabled: mode !== 'off', intervalMs: 1, concurrency: 999, targets }));
    }
    if (req.method === 'POST' && req.url.startsWith('/api/central/svc-status')) {
      const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = req.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
        posts.push({ body: JSON.parse(text), agent: req.headers['x-agent-name'] });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, stored: 2, rejected: 0 }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  const cport = await listen(central);
  const saved = { url: config.agent.centralUrl, name: config.agent.name, token: config.agent.centralToken };
  config.agent.centralUrl = `http://127.0.0.1:${cport}`; config.agent.name = 'edge-x'; config.agent.centralToken = 'tok-x';
  try {
    let r = await W.runSvcStatusWorkerOnce();
    assert.equal(r.ok, true, JSON.stringify(W.svcStatusWorkerStatus().last));
    assert.equal(cfgReq.token, 'tok-x'); assert.match(cfgReq.url, /agent=edge-x/);
    assert.equal(posts.length, 1); assert.equal(posts[0].agent, 'edge-x');
    const res1 = posts[0].body.results;
    assert.equal(res1.length, 2);
    const a = res1.find((x) => x.id === 'set:vcenter|a'); const b = res1.find((x) => x.id === 'set:storage-api|b');
    assert.equal(a.ok, true); assert.ok(a.a >= 0 && a.a < 60_000, '행 나이(ms)');
    assert.equal(b.ok, false); assert.equal(b.lp, 8443, '엣지 env 의 PowerMax 포트가 중앙이 준 포트와 다르면 lp');
    assert.ok(!('ts' in a) && !('at' in a), '엣지 시각을 행에 싣지 않는다');
    assert.equal(W.svcStatusWorkerStatus().intervalMs, W.SVC_INTERVAL_MIN_MS, '중앙이 준 1ms 주기를 하한으로 자른다');
    mode = 'empty'; r = await W.runSvcStatusWorkerOnce();
    assert.equal(posts.length, 2, '0건이어도 보고한다'); assert.deepEqual(posts[1].body.results, []); assert.match(posts[1].body.note, /잴 대상이 없습니다/);
    mode = 'off'; r = await W.runSvcStatusWorkerOnce();
    assert.equal(posts.length, 3); assert.equal(posts[2].body.disabled, true, '꺼짐도 보고한다');
    mode = 'old'; r = await W.runSvcStatusWorkerOnce();
    assert.equal(r.ok, true); assert.equal(W.svcStatusWorkerStatus().last.kind, 'no-endpoint'); assert.equal(posts.length, 3);
    // 워커 상수 = 중앙 저장 범위(사본이지만 값은 같아야 한다)
    assert.equal(W.SVC_INTERVAL_MIN_MS, SET.LIMITS.intervalMs.min); assert.equal(W.SVC_INTERVAL_MAX_MS, SET.LIMITS.intervalMs.max);
    assert.equal(W.SVC_CONCURRENCY_MAX, SET.LIMITS.concurrency.max); assert.equal(W.SVC_TIMEOUT_MAX_MS, J.TIMEOUT_CEIL_MS);
  } finally {
    config.agent.centralUrl = saved.url; config.agent.name = saved.name; config.agent.centralToken = saved.token;
    await closeSrv(central); await closeSrv(probeSrv);
  }
});

/* ───────────────────────── ⑨ 배선 · 라우트 ───────────────────────── */

test('⑨ 배선 — 도구 키 · 카탈로그 · 메일 종류 · 데모 계정 · BIG_JSON · 엣지 로그 spec · 서비스 점검 · 데이터 흐름 · 엣지 최소 판 표지', async () => {
  const { TOOL_PATH_KEYS } = await import('../src/auth/toolAccess.js');
  assert.equal(TOOL_PATH_KEYS['svc-status'], 'svc-status');
  const { PRESET } = await import('../src/toolcats/catalog.js');
  assert.ok(PRESET.find((c) => c.id === 'network').tools.includes('svc-status'));
  const { isKind } = await import('../src/mail/kinds.js');
  assert.ok(isKind(N.MAIL_KIND));
  const dg = await import('../src/auth/demoGuest.js');
  assert.match(String(dg.demoGuestDenial('GET', '/api/tools/svc-status/settings') || ''), /./, '설정 화면 API 는 데모 계정 거부');
  assert.equal(dg.demoGuestDenial('GET', '/api/tools/svc-status'), null, '메인 조회는 데모 판본으로 연다');
  assert.ok(dg.demoGuestDenial('POST', '/api/tools/svc-status/run'), '지금 측정(실제 연결)은 데모 계정 거부');
  assert.match(bare('index.js'), /app\.use\('\/api\/central\/svc-status', BIG_JSON\)/);
  const idx = bare('index.js');
  assert.ok(idx.indexOf("app.use('/api/central/svc-status', BIG_JSON)") < idx.indexOf("app.use('/api/central',"), 'BIG_JSON 은 central 마운트보다 앞');
  assert.match(idx, /startSvcStatusPoller,/); assert.match(idx, /startSvcStatusWorker,/);
  const { STATUS_SPEC } = await import('../src/edgelog/spec.js');
  assert.ok(STATUS_SPEC.some((s) => s.key === 'push.svcStatus' && s.fn === 'svcStatusWorkerStatus'));
  const { CENTRAL_ONLY_SPEC } = await import('../src/health/services.js');
  assert.ok(CENTRAL_ONLY_SPEC.some((s) => s.key === 'collect.svcStatus'));
  const { CATS } = await import('../src/dataflow/build.js').catch(() => ({}));
  if (CATS) for (const p of ['central:/svc-status', 'central:/svc-status-config']) assert.ok(CATS.some((c) => c.test.test(p)), `${p} 분류`);
  const F = await import('../src/central/featureMinEdgeVersion.js');
  assert.ok(F.SVC_STATUS_TITLE_RE.test('v3.54 포탈 서비스 상태 모니터링'));
  // 엣지 수신 라우트 — 개별 토큰만 · 503 은 지속형 머리
  const ops = stripComments(fs.readFileSync(path.join(SRC, 'routes/central/opsRoutes.js'), 'utf8'));
  const seg = ops.slice(ops.indexOf("centralRouter.post('/svc-status'"), ops.indexOf("centralRouter.post('/svc-status'") + 900);
  assert.match(seg, /req\.centralAuth\.mode !== 'agent'/); assert.match(seg, /putSvcStatusEdgeReport\(req\.centralAuth\.agent/);
  const segCfg = ops.slice(ops.indexOf("centralRouter.get('/svc-status-config'"), ops.indexOf("centralRouter.get('/svc-status-config'") + 900);
  assert.match(segCfg, /req\.centralAuth\.mode !== 'agent'/); assert.match(segCfg, /reqAgent\.toLowerCase\(\) !== agent\.toLowerCase\(\)/);
});

test('⑨ 라우트 — 관리자 ∧ 전체 범위 · 범위 계정 403 · 비관리자 판본 주소 가림 · 데모 계정은 데모 항목만', async () => {
  const { registerSvcStatus, maskForDemoGuest, maskAddresses } = await import('../src/routes/api/svcStatus.js');
  const routes = new Map();
  registerSvcStatus({ get: (p, ...h) => routes.set(`GET ${p}`, h), put: (p, ...h) => routes.set(`PUT ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h) });
  for (const k of ['GET /tools/svc-status', 'GET /tools/svc-status/target', 'GET /tools/svc-status/settings', 'PUT /tools/svc-status/settings', 'POST /tools/svc-status/exclude', 'POST /tools/svc-status/run']) {
    assert.ok(routes.has(k), k); assert.ok(routes.get(k).length >= 3, `${k}: 관리자 + 범위 게이트`);
  }
  const call = async (key, { user, query = {}, body = {} } = {}) => {
    const res = { statusCode: 200, headers: {}, body: undefined, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, set(k, v) { this.headers[k] = v; return this; }, setHeader(k, v) { this.headers[k] = v; } };
    const req = { user, query, body, params: {}, ip: '127.0.0.1', headers: {}, method: key.split(' ')[0], originalUrl: `/api${key.replace(/^\w+ /, '')}` };
    for (const h of routes.get(key)) { let nx = false; await h(req, res, () => { nx = true; }); if (!nx) break; }
    return res;
  };
  const ADMIN = { username: 'admin', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: [] } };
  const SCOPED = { username: 'admin-a', role: 'admin', scope: { vcenters: ['vc-a'], regions: [], writeVcenters: [] } };
  const OP = { username: 'op', role: 'operator', scope: { vcenters: [], regions: [], writeVcenters: [] } };
  await seedPlan();
  assert.equal((await call('GET /tools/svc-status', { user: SCOPED })).statusCode, 403, '범위 계정은 403');
  assert.equal((await call('GET /tools/svc-status', { user: OP })).statusCode, 403, 'operator 는 403');
  const ok = await call('GET /tools/svc-status', { user: ADMIN });
  assert.equal(ok.statusCode, 200); assert.equal(ok.body.addressHidden, false); assert.ok(ok.body.rows.some((r) => r.address));
  assert.ok(ok.body.rows.every((r) => !('_tid' in r)));
  const bad = await call('GET /tools/svc-status/target', { user: ADMIN, query: { id: 'set:nope|x' } });
  assert.equal(bad.statusCode, 404);
  const det = await call('GET /tools/svc-status/target', { user: ADMIN, query: { id: 'set:collector|e1', range: 'constructor' } });
  assert.equal(det.statusCode, 200); assert.equal(det.body.range, '24h', '모르는 범위 이름(constructor 포함)은 24h');
  const put = await call('PUT /tools/svc-status/settings', { user: ADMIN, body: { intervalMs: '', failThreshold: 4, alerts: { to: 'not-an-address' } } });
  assert.equal(put.statusCode, 400); assert.equal(put.body.field, 'alerts.to');
  const put2 = await call('PUT /tools/svc-status/settings', { user: ADMIN, body: { intervalMs: '', failThreshold: 4 } });
  assert.equal(put2.statusCode, 200); assert.equal(put2.body.settings.failThreshold, 4); assert.equal(put2.body.settings.intervalMs, SET.LIMITS.intervalMs.def, '빈 칸은 현재 값 유지');
  const ex = await call('POST /tools/svc-status/exclude', { user: ADMIN, body: { id: 'set:collector|e1', on: true, reason: '점검' } });
  assert.equal(ex.statusCode, 200); assert.equal(ex.body.excluded[0].id, 'set:collector|e1'); assert.equal(ex.body.excluded[0].by, 'admin');
  await seedPlan();   // 설정 저장이 계획을 비웠다 — 시험 카탈로그로 다시
  const run = await call('POST /tools/svc-status/run', { user: ADMIN, body: { id: 'set:vcenter|vc-s' } });
  assert.equal(run.statusCode, 400); assert.match(run.body.reason, /엣지/);
  // 판본 변환(순수)
  const body = { rows: [{ id: 'a', demo: true, kind: 'collector', state: 'ok', host: 'h', port: 1, address: 'h:1' }, { id: 'b', demo: false, kind: 'vcenter', state: 'down', host: 'x', port: 2, address: 'x:2' }],
    kinds: [{ key: 'collector', n: 1 }, { key: 'vcenter', n: 1 }], edges: [{ agent: 'mock-Edge-Seoul' }, { agent: 'edge-real' }], counts: {}, sourceErrors: [{ kind: 'storage' }] };
  const dm = maskForDemoGuest(body);
  assert.deepEqual(dm.rows.map((r) => r.id), ['a']); assert.equal(dm.demoMasked, 1); assert.equal(dm.counts.down, 0); assert.deepEqual(dm.edges.map((e) => e.agent), ['mock-Edge-Seoul']);
  const am = maskAddresses(body);
  assert.ok(am.addressHidden); assert.ok(am.rows.every((r) => r.host === '' && r.port === null && r.address === ''));
});

test('⑩ 설정을 못 읽어도 제외 목록 · 알림을 풀지 않는다(마지막으로 읽은 값) · 저장은 409 · 숫자 빈 칸은 현재 값 유지', async () => {
  SET._resetSvcStatusSettingsForTest();
  SET.saveSvcStatusSettings({}, { replace: true });   // 앞 시험(라우트)이 남긴 제외를 지운다
  SET.saveSvcStatusSettings({ alerts: { to: ['ops@example.invalid'] } });
  SET.setExcluded('set:collector|keep', true, { reason: '이전', by: 'admin', now: NOW });
  assert.deepEqual(SET.loadSvcStatusSettings().excluded.map((x) => x.id), ['set:collector|keep']);
  fs.writeFileSync(path.join(tmp, 'svc-status-settings.json'), '{ 손상', { mode: 0o600 });
  SET._dropSvcStatusSettingsCacheForTest();
  const s = SET.loadSvcStatusSettings();
  assert.deepEqual(s.excluded.map((x) => x.id), ['set:collector|keep'], '손상돼도 제외가 풀리지 않는다');
  assert.deepEqual(s.alerts.to, ['ops@example.invalid'], '받는 사람이 사라지지 않는다');
  assert.equal(SET.svcStatusUsingLastGood(), true);
  assert.ok(SET.svcStatusWriteRefusal(), '저장 거절 표지');
  assert.throws(() => SET.saveSvcStatusSettings({ failThreshold: 5 }), (e) => e.status === 409);
  assert.throws(() => SET.setExcluded('x', true), (e) => e.status === 409);
  SET.saveSvcStatusSettings({}, { replace: true });   // 확정(기본값으로)
  assert.equal(SET.svcStatusSettingsLoadError(), null);
  const n = SET.normalizeSettings({ intervalMs: '', failThreshold: '7', slowFactor: 2.55, retentionDays: 99999, kinds: { cvp: false }, alerts: { unknownMin: -3 } });
  assert.equal(n.intervalMs, SET.LIMITS.intervalMs.def); assert.equal(n.failThreshold, 7); assert.equal(n.slowFactor, 2.6); assert.equal(n.retentionDays, SET.LIMITS.retentionDays.max);
  assert.equal(n.kinds.cvp, false); assert.equal(n.kinds.storage, true); assert.equal(n.alerts.unknownMin, 0);
});

/* ───────────────────────── ⑪ 점검 반증 확정분(2026-11-27) ───────────────────────── */

test('⑪ #1 측정을 꺼 두면 메일 틱은 아무것도 하지 않는다(커서 그대로) · 다시 켠 시각 + 멈춤 경계 전에는 못 잼을 세지 않는다 · 꺼짐 행은 합계 밖', async () => {
  if (!(await DB.available())) return;
  await seedPlan();
  SET._resetSvcStatusSettingsForTest(); SET.saveSvcStatusSettings({}, { replace: true });
  SET.saveSvcStatusSettings({ enabled: false });
  N._resetSvcStatusMailForTest();
  const before = (await DB.latestRows()).map((x) => [x.tid, x.notified]);
  const r = await N.svcStatusMailTick({ now: NOW, mock: false, send: async () => { throw new Error('보내면 안 된다'); } });
  assert.equal(r.skipped, 'disabled');
  assert.deepEqual((await DB.latestRows()).map((x) => [x.tid, x.notified]), before, '커서를 건드리지 않는다');
  const saved = SET.saveSvcStatusSettings({ enabled: true });
  assert.ok(saved.enabledAt >= NOW - HOUR, '꺼짐 → 켜짐 저장이 다시 켠 시각을 남긴다');
  // 못 잼 시계 — 중앙 기동 · 다시 켠 시각 + 멈춤 경계 이후만
  const row = { state: 'unknown', since: null, lastTs: NOW - 5 * HOUR };
  assert.equal(J.unknownForMsOf(row, { now: NOW, staleMs: 240_000, armedAt: 0 }), 5 * HOUR - 240_000);
  assert.equal(J.unknownForMsOf(row, { now: NOW, staleMs: 240_000, armedAt: NOW - 10 * 60_000 }), 10 * 60_000 - 240_000, '다시 켠 뒤만 센다');
  assert.equal(J.unknownForMsOf(row, { now: NOW, staleMs: 240_000, armedAt: NOW }), 0);
  assert.equal(J.unknownForMsOf({ ...row, state: 'ok' }, { now: NOW, staleMs: 1, armedAt: 0 }), 0);
  const ev = N.planMail([{ ...R({ tid: 9, state: 'unknown', notified: 'ok' }), since: null, lastTs: NOW - 5 * HOUR }], { alerts: { unknownMin: 30 }, now: NOW, staleMs: 240_000, armedAt: NOW - 5 * 60_000 });
  assert.equal(ev.events.length, 0, '중앙 재기동 직후 · 다시 켠 직후에는 못 잼을 보내지 않는다');
  // 꺼짐 행
  const { rows: plan } = T.planTargets(cat(), { settings: SETTINGS, siteOwner: new Map([['vc-s', 'edge-2']]) });
  const off = V.buildRows(plan, new Map(), new Map(), { now: NOW, settings: { ...S, enabled: false }, staleMs: 240_000 });
  assert.ok(off.filter((x) => ['central', 'edge'].includes(plan.find((p) => p.id === x.id).plan)).every((x) => x.state === 'off' && x.reason === 'measure-off'));
  assert.equal(V.countsOf(off).unknown, 0, '측정을 꺼 둔 동안 못 잼으로 부풀지 않는다(담당 모름도 측정 꺼짐이 먼저)');
});

test('⑪ #2 · #3 측정하는 곳이 바뀌면 평소를 비우고 그 시각부터 · 주소가 바뀐 새 단위는 직전 알림 커서를 이어받는다', async () => {
  if (!(await DB.available())) return;
  const id = 'set:vcenter|moved';
  const rows = [];
  for (let i = 0; i < J.BASELINE_MIN_SAMPLES + 5; i++) rows.push({ id, host: '192.0.2.30', port: 443, kind: 'vcenter', ts: NOW - 6 * HOUR + i * 60_000, ok: true, ms: 2, by: 'edge-pl' });
  await DB.recordResults(rows, { settings: S });
  await DB.refreshBaselines({ now: NOW - 5 * HOUR, force: true });
  let lat = (await DB.latestRows()).find((x) => x.id === id);
  assert.equal(lat.base_ms, 2);
  await DB.recordResults([{ id, host: '192.0.2.30', port: 443, kind: 'vcenter', ts: NOW - 4 * HOUR, ok: true, ms: 800, by: 'central' }], { settings: S });
  lat = (await DB.latestRows()).find((x) => x.id === id);
  assert.equal(lat.state, 'ok', '옛 지점의 평소(2ms)로 800ms 를 지연이라 하지 않는다'); assert.equal(lat.base_ms, null); assert.equal(lat.by_since, NOW - 4 * HOUR);
  // 대소문자만 다른 같은 지점은 바뀐 것이 아니다
  await DB.recordResults([{ id, host: '192.0.2.30', port: 443, kind: 'vcenter', ts: NOW - 4 * HOUR + 60_000, ok: true, ms: 801, by: 'CENTRAL' }], { settings: S });
  assert.equal((await DB.latestRows()).find((x) => x.id === id).by_since, NOW - 4 * HOUR);
  // 새 지점 표본만으로 평소(옛 2ms 표본을 섞지 않는다)
  const more = [];
  for (let i = 2; i < J.BASELINE_MIN_SAMPLES + 2; i++) more.push({ id, host: '192.0.2.30', port: 443, kind: 'vcenter', ts: NOW - 4 * HOUR + i * 60_000, ok: true, ms: 800, by: 'central' });
  await DB.recordResults(more, { settings: S });
  await DB.refreshBaselines({ now: NOW - 3 * HOUR, force: true });
  assert.equal((await DB.latestRows()).find((x) => x.id === id).base_ms, 800);
  // #3 커서 승계 — 옛 단위 커서 'ok' → 새 주소 단위가 이어받는다
  const old = (await DB.latestRows()).find((x) => x.id === id);
  await DB.setNotified([[old.tid, 'ok']], NOW - 2 * HOUR);
  await DB.recordResults([{ id, host: '192.0.2.31', port: 8443, kind: 'vcenter', ts: NOW - HOUR, ok: false, fk: 'refused', by: 'central' }], { settings: S });
  const neu = (await DB.latestRows()).find((x) => x.id === id && x.port === 8443);
  assert.equal(neu.notified, 'ok', '새 단위가 직전 커서를 이어받아 끊김을 알릴 수 있다');
});

test('⑪ #8 평소를 모르는 단위는 표본이 늘면 다음 틱에 다시 계산한다(1시간 도장 금지)', async () => {
  if (!(await DB.available())) return;
  const id = 'set:cvp|base';
  const mk = (from, n) => Array.from({ length: n }, (_, i) => ({ id, host: '192.0.2.40', port: 443, kind: 'cvp', ts: from + i * 60_000, ok: true, ms: 50, by: 'central' }));
  const t0 = NOW - 2 * HOUR;
  await DB.recordResults(mk(t0, 10), { settings: S });
  await DB.refreshBaselines({ now: t0 + 15 * 60_000 });
  assert.equal((await DB.latestRows()).find((x) => x.id === id).base_ms, null, '10표본 — 모름');
  await DB.recordResults(mk(t0 + 10 * 60_000, 25), { settings: S });
  await DB.refreshBaselines({ now: t0 + 40 * 60_000 });
  assert.equal((await DB.latestRows()).find((x) => x.id === id).base_ms, 50, '25분 뒤 다음 틱에 채워진다(1시간을 기다리지 않는다)');
});

test('⑪ #5 · #6 · #15 설정 오류 행 id · 엣지 대상 못 잼 시작 시각 · DB 못 씀 사유 · #7 엣지에 건넨 주기로 멈춤 경계 · 성공률 내림', () => {
  const { rows: plan } = T.planTargets(cat({ problems: [{ kind: 'set:storage-api', ref: 's9', name: 'bad', address: '::', reason: 'x' }, { kind: 'set:cvp', ref: 'c9', name: 'bad2', address: '::', reason: 'y' }] }), { settings: SET.normalizeSettings({ excluded: [{ id: 'set:storage-api|s9' }] }), siteOwner: new Map([['vc-s', 'edge-2']]) });
  const probs = plan.filter((r) => r.problem);
  assert.deepEqual(probs.map((r) => r.id), ['set:cvp|c9', 'set:storage-api|s9']);
  assert.equal(probs.find((r) => r.id === 'set:storage-api|s9').excluded != null, true); assert.equal(probs.find((r) => r.id === 'set:storage-api|s9').plan, 'problem');
  const vs = plan.find((r) => r.id === 'set:vcenter|vc-s');
  const staleMs = 240_000;
  const lat = new Map([[V.unitKey(vs.id, vs.host, vs.port), { tid: 7, ts: NOW - staleMs - 5 * 60_000, ok: 1, ms: 3, state: 'ok', since_ts: NOW - HOUR, fail_streak: 0 }]]);
  const edge = { reports: new Map(), versions: new Map([['edge-2', '9.0.0']]), minEdgeVersion: '3.54.0', startedAt: NOW - HOUR, intervalMs: 60_000 };
  let rows = V.buildRows(plan, lat, new Map(), { now: NOW, settings: S, staleMs, edge });
  let r = rows.find((x) => x.id === vs.id);
  assert.match(r.reason, /^edge-/); assert.equal(r.since, NOW - 5 * 60_000, '엣지 사유로 바꾼 행도 언제부터 못 잼을 준다');
  // 엣지에 10분 주기를 건넸다 → 그 엣지의 멈춤 경계는 넓다(주기를 줄인 직후 거짓 못 잼 금지)
  rows = V.buildRows(plan, lat, new Map(), { now: NOW, settings: S, staleMs, edge, edgeStaleMs: new Map([['edge-2', J.staleLimitMs(600_000)]]) });
  assert.equal(rows.find((x) => x.id === vs.id).state, 'ok');
  rows = V.buildRows(plan, lat, new Map(), { now: NOW, settings: S, staleMs, edge, dbOk: false });
  assert.equal(rows.find((x) => x.id === vs.id).reason, 'db-unavailable');
  assert.equal(rows.find((x) => x.id === 'set:collector|e1').reason, 'db-unavailable', '중앙 대상도 첫 측정 대기라 하지 않는다');
  const rep = V.buildRows(plan, new Map(), new Map(), { now: NOW, settings: S, staleMs, edge: { ...edge, reports: new Map([['edge-2', { at: NOW - 10_000, dbUnavailable: true }]]) } });
  assert.equal(rep.find((x) => x.id === vs.id).reason, 'db-unavailable');
  const curB = Math.floor(NOW / DB.BUCKET_MS) * DB.BUCKET_MS;
  assert.equal(V.stripOf([{ b: curB, n: 2880, ok_n: 2879, worst: 3 }], NOW).avail24, 99.9, '실패가 있으면 100 % 가 아니다');
  for (const c of ['measure-off', 'db-unavailable']) assert.ok(J.REASON_CODES.includes(c));
});

test('⑪ #13 · #10 등록부 하나를 못 읽어도 엣지 설정 · 보고를 통째로 막지 않는다 · 한 보고에 한 대상은 한 행', async () => {
  if (!(await DB.available())) return;
  SVC._resetSvcStatusServiceForTest();
  SET._resetSvcStatusSettingsForTest(); SET.saveSvcStatusSettings({}, { replace: true });
  const broken = cat({ targets: cat().targets.filter((x) => x.kind !== 'set:cvp'), sourceErrors: [{ source: 'cvp', reason: '못 읽음' }] });
  await SVC.getPlan({ force: true, deps: { build: async () => broken, siteOwner: new Map([['vc-s', 'edge-2']]), corpOf: () => ({ key: '', label: '' }), settings: SETTINGS, mock: false } });
  const cfg = await SVC.edgeConfigFor('edge-2');
  assert.equal(cfg.status, 200); assert.deepEqual(cfg.body.targets.map((x) => x.id), ['set:vcenter|vc-s']);
  assert.deepEqual(cfg.body.heldEmpty, [{ kind: 'cvp', label: 'CVP' }]);
  const out = await SVC.putEdgeReport('edge-2', { results: [
    { id: 'set:vcenter|vc-s', host: '10.2.1.10', port: 8443, ok: false, fk: 'timeout', a: 1 },
    { id: 'set:vcenter|vc-s', host: '10.2.1.10', port: 8443, ok: false, fk: 'timeout', a: 0 },
    { id: 'set:vcenter|vc-s', host: '10.2.1.10', port: 8443, ok: false, fk: 'timeout', a: 2 },
  ] }, { now: NOW + 3 * HOUR });
  assert.equal(out.ok, true); assert.equal(out.stored, 1, '같은 대상은 한 행만'); assert.equal(out.rejected, 2);
});

test('⑪ 웹 점검 서버 몫 — 상세 generatedAt · 데모 계정 같은 주소 · 꺼진 종류 등록 수 · 받는 사람 상한 · 비관리자 폴러 화이트리스트', async () => {
  if (!(await DB.available())) return;
  await seedPlan();
  const d = await SVC.detailPayload('set:collector|e1', { range: '30d', now: NOW });
  assert.equal(d.generatedAt, NOW); assert.ok(d.end >= NOW);
  const sh = cat({ targets: [...cat().targets, { id: 'set:storage-api|mock-x', kind: 'set:storage-api', ref: 'mock-x', name: 'demo-same', host: 'edge1.corp', port: 443, enabled: true, agent: '', facts: { type: 'unity480', defaultPort: 443 } }] });
  SVC._resetSvcStatusServiceForTest();
  await SVC.getPlan({ force: true, deps: { build: async () => sh, siteOwner: new Map(), corpOf: () => ({ key: '', label: '' }), settings: SETTINGS, mock: true } });
  const all = await SVC.detailPayload('set:storage-api|mock-x', { now: NOW });
  assert.ok(all.sameHost.some((x) => x.id === 'set:collector|e1'));
  const demo = await SVC.detailPayload('set:storage-api|mock-x', { now: NOW, demoOnly: true });
  assert.ok(!demo.sameHost.some((x) => x.id === 'set:collector|e1'), '데모 계정에는 실제 등록 항목을 섞지 않는다');
  SVC._resetSvcStatusServiceForTest();
  await SVC.getPlan({ force: true, deps: { build: async () => cat(), siteOwner: new Map(), corpOf: () => ({ key: '', label: '' }), settings: SET.normalizeSettings({ kinds: { storage: false } }), mock: false } });
  const src = await SVC.sourcesPayload();
  const st = src.find((s) => s.kind === 'storage');
  assert.equal(st.measured, false); assert.equal(st.registered, 5, '측정을 꺼도 등록 수는 센다'); assert.equal(st.targets, null);
  SET._resetSvcStatusSettingsForTest(); SET.saveSvcStatusSettings({}, { replace: true });
  const many = Array.from({ length: SET.ALERT_TO_MAX + 1 }, (_, i) => `u${i}@example.invalid`);
  assert.throws(() => SET.saveSvcStatusSettings({ alerts: { to: many } }), (e) => e.status === 400 && e.field === 'alerts.to');
  const { maskPollerForNonAdmin } = await import('../src/routes/api/svcStatus.js');
  const m = maskPollerForNonAdmin({ enabled: true, running: false, last: { at: 1, error: 'smtp.corp:25 거부' }, mail: { at: 1, sent: 0, reason: 'smtp.corp:25 연결 거부' }, baseline: { at: 1, error: 'x' } });
  assert.ok(!JSON.stringify(m).includes('smtp.corp'), 'SMTP 주소 · 오류 원문이 비관리자 판본에 실리지 않는다');
});

test('⑪ #14 엣지 워커 — 설정 응답 모양이 다르면 실패로 끝낸다(중앙에서 꺼짐이라는 거짓 보고 금지)', async () => {
  const W = await import('../src/agent/svcStatusWorker.js');
  const { config } = await import('../src/config.js');
  const posts = [];
  const central = http.createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"hello":"not central"}'); }
    posts.push(1); res.writeHead(200); res.end('{}');
  });
  const cport = await listen(central);
  const saved = { url: config.agent.centralUrl, name: config.agent.name, token: config.agent.centralToken };
  config.agent.centralUrl = `http://127.0.0.1:${cport}`; config.agent.name = 'edge-y'; config.agent.centralToken = 'tok-y';
  try {
    const r = await W.runSvcStatusWorkerOnce();
    assert.equal(r.ok, false); assert.equal(posts.length, 0, '꺼짐 보고를 올리지 않는다');
    assert.equal(W.svcStatusWorkerStatus().last.kind, 'bad-shape');
  } finally {
    config.agent.centralUrl = saved.url; config.agent.name = saved.name; config.agent.centralToken = saved.token;
    await closeSrv(central);
  }
});
