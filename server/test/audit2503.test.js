/**
 * v2.503 전수조사(성능 + 보안) 확정 지적 회귀 테스트.
 *
 * 이번 라운드는 성능 감사 5도메인 + 보안 감사 2도메인을 병렬로 돌려 나온 확정 항목만 고정한다.
 * 각 테스트에 '무엇이 뚫렸/느렸는가' 를 적어 두어, 나중에 이 단정을 느슨하게 바꾸려는 사람이
 * 무엇을 되돌리는지 알 수 있게 한다. 측정값이 붙은 항목은 실제로 잰 값이다(추정은 추정이라고 적었다).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-2503-'));
process.env.CONFIG_DIR = CFG;

let proxyReg; let secretCarry; let rate;
before(async () => {
  proxyReg = await import('../src/proxy/registry.js');
  secretCarry = await import('../src/util/secretCarry.js');
  rate = await import('../src/security/loginRateLimit.js');
});

/* ── S2 high — Data Plane 접속처는 url 단독이 아니다 ───────────────────────── */

test('basePath 검증 — 권한부(authority)를 여는 형태를 거부한다', () => {
  // 공격 형태: proxy/dataplane.js base() 가 `url + basePath` 로 **문자열 연결**하므로
  // basePath='@attacker.example/v3' 면 최종 URL 의 앞부분이 userinfo 로 접히고 호스트가 바뀐다.
  const { basePathIssue } = proxyReg;
  assert.equal(basePathIssue('/v3'), null);
  assert.equal(basePathIssue(''), null, '미지정은 기본값(/v3) — 오류가 아니다');
  assert.equal(basePathIssue(undefined), null);
  assert.ok(basePathIssue('@attacker.example/v3'), "'@' 로 시작하는 값이 통과하면 안 된다");
  assert.ok(basePathIssue('/v3@attacker.example'), "경로 뒤의 '@' 도 호스트를 바꾼다");
  assert.ok(basePathIssue('//evil.example/v3'), '스킴 상대 URL');
  assert.ok(basePathIssue('/v3?x=1'));
  assert.ok(basePathIssue('/v3#a'));
  assert.ok(basePathIssue('v3'), "'/' 로 시작하지 않는 값");
  assert.ok(basePathIssue('/v 3'), '공백');
  assert.ok(basePathIssue(`/v3${'x'.repeat(200)}`), '길이 상한');
});

test('접속처 판정 키(idKeys)는 최종 요청 URL 을 만드는 모든 필드를 덮어야 한다', () => {
  // v2.500 은 ['url'] 만 넣어, basePath 만 바꾸면 accessMoved 가 거짓이라 비밀번호가 승계됐다.
  const { accessMoved } = secretCarry;
  const prev = { url: 'http://haproxy.internal:5555', basePath: '/v3' };
  assert.equal(accessMoved(prev, { basePath: '/v3x' }, ['url']), false, '이것이 결함의 모양이다');
  assert.equal(accessMoved(prev, { basePath: '/v3x' }, ['url', 'basePath']), true);
});

test('Data Plane 저장 — basePath 가 바뀌면 저장 비밀번호를 승계하지 않는다', () => {
  const { saveConfig, getConfig } = proxyReg;
  saveConfig({ dataplane: { url: 'http://dp.internal:5555', basePath: '/v3', username: 'admin', password: 'SECRET-dp' } });
  assert.equal(getConfig().dataplane.password, 'SECRET-dp');

  // 공격 요청: url 은 그대로 두고 basePath 만 바꾸며 비밀번호는 '기존 유지'(********) 로 보낸다.
  saveConfig({ dataplane: { basePath: '/v3/x', password: '********' } });
  assert.ok(!getConfig().dataplane.password, `접속처가 바뀌었는데 비밀번호가 남았다: ${getConfig().dataplane.password}`);
});

test('Data Plane 저장 — 잘못된 basePath 는 400 으로 거부(조용히 저장하지 않는다)', () => {
  assert.throws(() => proxyReg.saveConfig({ dataplane: { basePath: '@evil.example/v3' } }), /basePath/);
});

test('getConfigSafe — 프록시별 비밀도 가린다(최상위만 가리는 스프레드 금지)', () => {
  // v2.500 D/M1(relaycheck) 과 같은 원인: `{...c}` 뒤에 최상위만 덮어써 c.proxies[] 하위가 샜다.
  const r = proxyReg.saveProxy({ name: 'p1', dataplane: { url: 'http://p1:5555', username: 'a', password: 'SECRET-p1' }, deploy: { host: 'h1', username: 'root', password: 'SECRET-p1-ssh', privateKey: 'KEYDATA' } });
  assert.equal(r.ok, true, r.reason);
  const safe = proxyReg.getConfigSafe();
  const blob = JSON.stringify(safe);
  for (const s of ['SECRET-p1', 'SECRET-p1-ssh', 'KEYDATA']) {
    assert.ok(!blob.includes(s), `응답에 비밀이 그대로 실렸다: ${s}`);
  }
  assert.equal(safe.proxies[0].dataplane.password, '********');
});

test('프록시별 저장도 basePath 를 검증한다', () => {
  const r = proxyReg.saveProxy({ name: 'p2', dataplane: { basePath: '//evil.example/v3' } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /basePath/);
});

/* ── S2 medium — 출발지 전용 잠금이 전체 로그인을 마비시키지 않게 ─────────── */

test('계정 무관(ip:) 잠금은 계정 잠금보다 짧다 — 오탐 복구 시간을 분 단위로', () => {
  // v2.500 이 추가한 ip: 카운터는 계정과 무관하므로, 리버스 프록시 뒤라면 그 출발지가 곧 전 사용자다.
  // 게다가 잠기면 checkLoginAllowed 가 시도를 막아 '정상 로그인 1회가 리셋' 이 발동할 수 없다(자기지속).
  // 그래서 이 레이어만 잠금 시간을 분리했다. 계정을 아는 브루트포스는 per-IP+계정(8회)·계정 전역이 막는다.
  const ip = '203.0.113.77';
  let locked = false;
  // 매번 다른 계정명 — `<ip>|<user>` 도 `acct:<user>` 도 차지 않는 패턴이다(이것이 v2.500 M-1 의 동기).
  for (let i = 0; i < 48; i += 1) locked = rate.recordLoginFailure(ip, `user-${i}`).locked || locked;
  assert.equal(locked, true, '계정명을 바꿔 가며 시도하면 출발지 카운터가 차야 한다');
  const g = rate.checkLoginAllowed(ip, 'someone-else');
  assert.equal(g.blocked, true);
  assert.ok(g.retryAfterSec <= 120, `출발지 잠금이 ${g.retryAfterSec}s — 15분(900s)이면 사무실 전체가 잠긴다`);
});

/* ── 성능: perf 히스토그램 해상도(v2.498 결함) ─────────────────────────────── */

test('perf 버킷 — 밀리초 단위 경계가 있어야 튜닝 표가 정보를 준다', async () => {
  const S = await import('../src/perf/stats.js');
  assert.ok(S.BUCKETS_MS[0] <= 1);
  for (const b of [2, 5, 10, 25]) assert.ok(S.BUCKETS_MS.includes(b), `${b}ms 경계 없음`);
});

/* ── 성능: DB ─────────────────────────────────────────────────────────────── */

test('vmtrack changes — vcenter_id 커버링 인덱스(실측 20.4배)', async () => {
  // 없으면 계획이 `SCAN changes` + temp b-tree GROUP BY 라 vCenter 28개 = 풀스캔 28회다.
  const src = fs.readFileSync(new URL('../src/vmtrack/db.js', import.meta.url), 'utf8');
  assert.match(src, /CREATE INDEX IF NOT EXISTS idx_changes_vc_kind ON changes \(vcenter_id, kind, vm_id, ts\)/);
});

test('prune 스로틀은 기동 첫 틱에 돌지 않는다(v2.453 금지 패턴)', () => {
  // `% N === 1` 이나 `tick++ % N === 0`(tick 초기값 0)은 **첫 샘플/첫 폴에서 즉시 참**이다.
  // 보존기간을 줄이고 재시작하면 그 차액을 한 번에 지운다 — v2.451 에서 실제로 포탈이 멈췄다.
  for (const f of ['../src/capacity/sampler.js', '../src/logs/poller.js', '../src/metrics/sampler.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    assert.ok(!/%\s*PRUNE_EVERY\s*===\s*1/.test(code), `${f}: '% N === 1' 은 첫 틱에 prune 한다`);
    assert.ok(!/tick\+\+\s*%\s*PRUNE_EVERY\s*===\s*0/.test(code), `${f}: 'tick++ % N === 0' 은 첫 틱에 prune 한다`);
  }
});

test('vCenter perf 카운터 조회는 카탈로그 캐시를 경유한다', async () => {
  // 예전에는 powerCounterId/gpuUtilCounterId 가 카탈로그(수백 KB)를 직접 내려받아,
  // 수집 주기마다 vCenter 마다 전량 재전송·재파싱했다(v2.447 이 만든 캐시를 안 쓰고 있었다).
  const src = fs.readFileSync(new URL('../src/vcenter/soapClient.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async powerCounterId()'), src.indexOf('async queryHostPower('));
  assert.ok(body.includes('perfCounterMap()'), 'powerCounterId 가 캐시를 쓰지 않는다');
  assert.ok(!body.includes("retrieveObjectProps('PerformanceManager'"), 'powerCounterId 가 카탈로그를 직접 받는다');
  const gbody = src.slice(src.indexOf('async gpuUtilCounterId()'), src.indexOf('async queryHostGpuUtil('));
  assert.ok(gbody.includes('perfCounterMap()'), 'gpuUtilCounterId 가 캐시를 쓰지 않는다');
});

/* ── S1 #6 — 나머지 자격증명 스토어의 '접속처 변경 시 비밀 폐기' ─────────── */

test('자격증명 스토어 6종이 공용 secretCarry 판정을 쓴다', () => {
  // v2.500 은 세 곳(deployRegistry·proxy/registry·net/monitor)만 고쳤고, 나머지는 '추정' 으로 남았다.
  // 2026-09-13 재감사에서 코드로 확인됐다: `{host:'https://vc.attacker.example', password:''}` 로
  // 저장하면 host 만 바뀌고 저장 비밀번호가 남아, 다음 수집에서 운영 계정이 그 호스트로 평문 전송된다.
  const files = [
    'vcenter/registry.js', 'nsx/registry.js', 'idrac/registry.js',
    'horizon/horizon.js', 'collector/registry.js', 'gpu/physicalRegistry.js',
  ];
  for (const f of files) {
    const src = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.ok(src.includes("from '../util/secretCarry.js'"), `${f}: 공용 판정을 import 하지 않는다`);
    assert.ok(src.includes('accessMoved(') && src.includes('dropCarriedSecrets('), `${f}: 판정을 호출하지 않는다`);
  }
});

test('vCenter 저장 — host 가 바뀌면 저장 비밀번호를 승계하지 않는다', async () => {
  const reg = await import('../src/vcenter/registry.js');
  const add = reg.addVcenter({ id: 'vc-2503', name: 'T', host: 'https://vc.internal', username: 'svc@vsphere.local', password: 'SECRET-vc' });
  assert.equal(add.ok, true, add.reason);
  assert.equal(reg.loadRegistry().find((v) => v.id === 'vc-2503').password, 'SECRET-vc');

  const upd = reg.updateVcenter('vc-2503', { name: 'T', host: 'https://vc.attacker.example', username: 'svc@vsphere.local', password: '' });
  assert.equal(upd.ok, true, upd.reason);
  const after = reg.loadRegistry().find((v) => v.id === 'vc-2503');
  assert.ok(!after.password, `접속처가 바뀌었는데 비밀번호가 남았다: ${after.password}`);
  assert.deepEqual(upd.droppedSecrets, ['password'], '버린 사실을 호출부에 알려야 한다(재입력 안내)');
});

test('수집 서버 저장 — url 이 바뀌면 저장 토큰을 승계하지 않는다', async () => {
  const reg = await import('../src/collector/registry.js');
  const a = reg.addCollector({ id: 'col-2503', name: 'C', url: 'http://10.10.0.5:8080', datacenter: 'dc1', token: 'SECRET-collector-token' });
  assert.equal(a.ok, true, a.reason);
  const u = reg.updateCollector('col-2503', { name: 'C', url: 'http://10.10.9.9:8080', datacenter: 'dc1', token: '' });
  assert.equal(u.ok, true, u.reason);
  const after = reg.loadCollectors().find((c) => c.id === 'col-2503');
  assert.ok(!after.token, `url 이 바뀌었는데 토큰이 남았다: ${after.token}`);
});

/* ── 성능: 로그 DB ────────────────────────────────────────────────────────── */

test('logs/db 는 GROUP BY 없는 rowCount 를 제공하고, 용량 루프가 그것을 쓴다', () => {
  const db = fs.readFileSync(new URL('../src/logs/db.js', import.meta.url), 'utf8');
  assert.match(db, /rowCount: \(\) =>/, 'rowCount 가 없다');
  const poller = fs.readFileSync(new URL('../src/logs/poller.js', import.meta.url), 'utf8');
  const loop = poller.slice(poller.indexOf('while (size > limit'), poller.indexOf('if (dropped)'));
  assert.ok(!loop.includes('db.meta()'), '용량 정리 루프가 매 반복 풀스캔 2회(meta)를 돈다');
});

test('/tools/capacity-forecast 는 memo + 양보를 쓴다(DS 1,100개 N+1 로 1.5초 하드블록이었다)', () => {
  const src = fs.readFileSync(new URL('../src/routes/api/toolsCapacity.js', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf("api.get('/tools/capacity-forecast'"));
  assert.ok(route.includes('memoJson'), 'memo 가 없다');
  assert.ok(route.includes('scopeKey('), 'memo 캐시 라우트는 scopeKey 필수(범위 누출 방지)');
  assert.ok(route.includes('setImmediate'), '루프 중간 양보가 없다');
  // ⚠ '전 키 1쿼리 병합' 은 실측 2.3배 느렸다(1,563ms → 3,586ms) — 되돌리지 말 것.
  assert.ok(!route.includes('historyAll('), 'historyAll 병합은 이 스키마에서 더 느리다(측정 근거는 주석 참조)');
});
