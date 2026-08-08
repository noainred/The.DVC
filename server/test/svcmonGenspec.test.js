/**
 * 성능점검 대량 등록 생성기(genspec) — '이름 규칙 + IP 범위' 확장의 엣지 케이스 검증.
 *
 * 이 모듈의 계약은 '많이 만들어 준다' 가 아니라 **매핑이 어긋날 수 있으면 전체 거부** 다.
 * 그래서 테스트는 대부분 '거부되는가 · rows 가 0인가 · 원인을 읽을 수 있는가' 를 본다.
 * 임시 CONFIG_DIR 만 쓰고 외부 네트워크에 접근하지 않는다(호스트 판정은 동기 SSRF 가드).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config.configDir 은 모듈 로드 시점에 고정되므로 import 보다 먼저 설정해야 한다.
process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'svcmon-gen-'));
delete process.env.SSRF_ALLOW_LOOPBACK;      // 루프백 차단이 켜진 기본 상태로 검증

const { expandGenSpec, expandNames, parseNameCount, MAX_GEN_ROWS, LIST_CAPS } = await import('../src/svcmon/genspec.js');
const { LIMITS, planBulkTargets } = await import('../src/svcmon/store.js');

const joined = (arr) => arr.join(' | ');
/** 공통 스펙 — 각 케이스가 바꿀 부분만 덮어쓴다. */
const base = (over = {}) => ({
  kind: 'infra',
  path: 'A.Infra\\OC2\\워커노드',
  name: { pattern: 'lesasbpdp{n}', start: 1, pad: 2, count: 20 },
  host: { mode: 'ips', ips: '10.20.30.41-10.20.30.60' },
  enabled: false,
  onDuplicate: 'skip',
  ...over,
});

test('MAX_GEN_ROWS 는 store.LIMITS 에서 파생된다(새 숫자를 정의하지 않는다)', () => {
  assert.equal(MAX_GEN_ROWS, LIMITS.maxBulkRows);
});

/* T31 정상 케이스 — 나머지 테스트의 기준선 */
test('T31 정상: 이름 20개 + IP 20개 → rows 20, 순서대로 1:1 대응', () => {
  const r = expandGenSpec(base());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.blocked, []);
  assert.equal(r.suggest, null);
  assert.equal(r.rows.length, 20);
  assert.deepEqual(r.rows[0], {
    kind: 'infra', path: 'A.Infra\\OC2\\워커노드', name: 'lesasbpdp01', host: '10.20.30.41',
    enabled: false, tests: [],
  });
  assert.equal(r.rows[19].name, 'lesasbpdp20');
  assert.equal(r.rows[19].host, '10.20.30.60');
  // 중간도 밀리지 않는지 전수 확인(이 모듈의 유일한 핵심 계약)
  for (let i = 0; i < 20; i += 1) {
    assert.equal(r.rows[i].name, `lesasbpdp${String(i + 1).padStart(2, '0')}`);
    assert.equal(r.rows[i].host, `10.20.30.${41 + i}`);
  }
  assert.deepEqual(r.stats, {
    names: 20, ips: 20, dedupRemoved: 0, firstIp: '10.20.30.41', lastIp: '10.20.30.60',
    padTransition: null, nameMaxLen: 11,
  });
});

test('opts.materialize 가 있으면 그 반환값이 tests 로 들어간다(없으면 tests:[])', () => {
  const r = expandGenSpec(base({ name: { pattern: 'n{n}', start: 1, pad: 2, count: 3 }, host: { mode: 'ips', ips: '10.20.30.41-10.20.30.43' } }), {
    materialize: (row) => [{ name: `ping ${row.name}`, type: 'ping' }],
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[2].tests[0].name, 'ping n03');
  const bare = expandGenSpec(base({ name: { pattern: 'n{n}', start: 1, pad: 2, count: 3 }, host: { mode: 'ips', ips: '10.20.30.41-10.20.30.43' } }));
  assert.deepEqual(bare.rows[0].tests, []);
});

/* T19 자리수 */
test('T19 자리수 유지(pad2 → 01) · pad 초과 전이는 경고 + stats.padTransition 노출', () => {
  const keep = expandGenSpec(base({
    name: { pattern: 'x{n}', start: 1, pad: 2, count: 3 },
    host: { mode: 'ips', ips: '10.20.30.41-10.20.30.43' },
  }));
  assert.deepEqual(keep.errors, []);
  assert.deepEqual(keep.rows.map((r) => r.name), ['x01', 'x02', 'x03']);
  assert.equal(keep.stats.padTransition, null);

  // 95..104 → 100 부터 3자리가 되어 문자열 정렬이 흐트러진다(거부는 아니고 경고).
  const cross = expandGenSpec(base({
    name: { pattern: 'h{n}', start: 95, pad: 2, count: 10 },
    host: { mode: 'name', domain: '.x.local' },
  }));
  assert.deepEqual(cross.errors, []);
  assert.equal(cross.rows.length, 10);
  assert.equal(cross.rows[0].name, 'h95');
  assert.equal(cross.rows[5].name, 'h100');
  assert.equal(cross.stats.padTransition, 100);
  assert.match(joined(cross.warnings), /자리수/);
});

/* T20 이름 길이 */
test('T20 이름 최종 길이가 120자를 넘으면 거부(잘리면 서로 다른 번호가 같은 이름이 된다)', () => {
  const r = expandGenSpec(base({
    name: { pattern: `${'x'.repeat(119)}{n}`, start: 1, pad: 2, count: 2 },
    host: { mode: 'name', domain: '.x.local' },
  }));
  assert.equal(r.rows.length, 0);
  assert.equal(r.stats.nameMaxLen, 121);
  assert.match(joined(r.errors), /120자/);
});

/* T21 개수 불일치 */
test('T21 개수 불일치(이름 20 vs IP 11) → 거부 + rows 0 + suggest.count=11', () => {
  const r = expandGenSpec(base({ host: { mode: 'ips', ips: '10.20.30.41-10.20.30.51' } }));
  assert.equal(r.rows.length, 0);
  assert.equal(r.stats.ips, 11);
  assert.deepEqual(r.suggest, { count: 11 });
  assert.match(joined(r.errors), /개수 불일치/);
  // 자동 연장 금지 — 제안은 count 하나뿐이고 IP 를 늘려 주지 않는다.
  assert.equal(r.stats.lastIp, '10.20.30.51');
});

/* T22 IP 파싱 오류 혼재 */
test('T22 expandIpList 오류 1건 혼재 → 부분 성공 없이 전체 거부', () => {
  const r = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 2, count: 2 },
    host: { mode: 'ips', ips: '10.20.30.41\nbadip\n10.20.30.43' },
  }));
  assert.equal(r.rows.length, 0);
  assert.match(joined(r.errors), /잘못된 IP/);
  assert.match(joined(r.errors), /전체를 거부/);
});

/* T23 확장 상한 */
test('T23 truncated(확장 상한 초과) → 조용히 자르지 않고 오류로 승격(상한 4096 명시)', () => {
  const r = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 4 },
    host: { mode: 'ips', ips: '10.0.0.0/20,10.1.0.0/20' },
  }));
  assert.equal(r.rows.length, 0);
  assert.ok(r.errors.some((e) => /4096/.test(e)), joined(r.errors));
  // '4096' 만 보면 truncated 가드를 지워도 통과한다 — 가드가 없으면 count 가 4096 으로 추론되어
  // '1회 생성 상한 초과: 대상 4096개 > 2000개' 가 나오고 그 문구에도 4096 이 들어 있다(실측).
  // 그래서 '확장 상한' 오류로 승격되었는지, 그리고 상한 오류와 뒤바뀌지 않았는지를 함께 본다.
  assert.match(joined(r.errors), /IP 확장 상한/);
  assert.ok(!/1회 생성 상한/.test(joined(r.errors)), joined(r.errors));
});

/* T24 dedup */
test('T24 중복 dedup 으로 IP 가 줄면 개수 불일치 오류 + 중복 N건 보고', () => {
  const r = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 2, count: 6 },
    host: { mode: 'ips', ips: '10.20.30.41-10.20.30.45,10.20.30.43' },
  }));
  assert.equal(r.rows.length, 0);
  assert.equal(r.stats.ips, 5);
  assert.equal(r.stats.dedupRemoved, 1);
  assert.deepEqual(r.suggest, { count: 5 });
  assert.match(joined(r.errors), /중복 1건/);
});

/* T25 CIDR 정규화 */
test("T25 '10.0.0.5/24' 는 10.0.0.1 부터 확장됨을 stats 가 노출(+정규화 경고)", () => {
  const r = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 3 },      // count 미입력 → IP 개수를 그대로 쓴다
    host: { mode: 'ips', ips: '10.0.0.5/24' },
  }));
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows.length, 254);
  assert.equal(r.stats.names, 254);
  assert.equal(r.stats.firstIp, '10.0.0.1');
  assert.equal(r.stats.lastIp, '10.0.0.254');
  assert.equal(r.rows[0].host, '10.0.0.1');
  assert.match(joined(r.warnings), /정규화/);
});

/* T32 CIDR 정규화 경고의 오탐 — 진짜 이동 경고가 묻히지 않게 */
test("T32 '10.20.30.1/24' 처럼 확장 시작 주소를 그대로 적은 표기는 경고하지 않는다(자기모순 경고 금지)", () => {
  // base == firstHost 인 표기들(/24 의 .1, /26 의 .65, /29 의 .9, /30 의 4k+1, /32).
  for (const token of ['10.20.30.1/24', '10.0.0.65/26', '10.0.0.9/29', '10.0.0.5/30', '10.0.0.7/32']) {
    const r = expandGenSpec(base({
      name: { pattern: 'n{n}', start: 1, pad: 3 },
      host: { mode: 'ips', ips: token },
    }));
    assert.deepEqual(r.errors, [], token);
    assert.deepEqual(r.warnings.filter((w) => w.includes('정규화')), [], `${token} → ${joined(r.warnings)}`);
    // 첫 행의 host 가 입력한 주소와 같다는 것이 '밀리지 않았다' 의 근거다.
    assert.equal(r.rows[0].host, token.split('/')[0]);
  }
  // 네트워크 주소를 적은 경우(.0/24)도 경고하지 않는다 — .0 이 빠지는 것은 CIDR 정의 그대로다.
  const net = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 3 },
    host: { mode: 'ips', ips: '10.0.0.0/24' },
  }));
  assert.deepEqual(net.errors, []);
  assert.deepEqual(net.warnings.filter((w) => w.includes('정규화')), [], joined(net.warnings));
  assert.equal(net.rows[0].host, '10.0.0.1');
  // 진짜 이동(base ≠ 확장 시작)은 계속 경고한다 — 위 오탐 제거가 이 경고를 없애지 않았는지 확인.
  const shifted = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 3 },
    host: { mode: 'ips', ips: '10.0.0.5/24' },
  }));
  assert.equal(shifted.rows[0].host, '10.0.0.1');
  assert.equal(shifted.warnings.filter((w) => w.includes('정규화')).length, 1, joined(shifted.warnings));
  // /31 은 네트워크 주소부터 확장되므로 .1 을 적으면 실제로 한 칸 아래(.0)부터다 → 경고 유지.
  const b31 = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 3 },
    host: { mode: 'ips', ips: '10.0.0.1/31' },
  }));
  assert.equal(b31.rows[0].host, '10.0.0.0');
  assert.match(joined(b31.warnings), /정규화/);
});

/* T33 중복 IP 통지 — count 미입력 경로 */
test('T33 count 미입력이라도 중복 IP 가 제거되면 경고로 알린다(조용히 접지 않는다)', () => {
  const r = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 2 },            // count 미입력 = 가장 흔한 사용 방식
    host: { mode: 'ips', ips: '10.20.30.41-10.20.30.45,10.20.30.43' },   // 붙여넣기 6개, 유효 5개
  }));
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows.length, 5);
  assert.equal(r.stats.dedupRemoved, 1);
  // 6대를 등록했다고 믿는데 5대만 감시되는 상태를 오류·경고 0건으로 넘기지 않는다.
  assert.match(joined(r.warnings), /중복 IP 1건/);
  assert.match(joined(r.warnings), /5개/);
});

test('.0/.255 가 범위에 있으면 경고만 하고 건너뛰지 않는다(건너뛰면 매핑이 밀린다)', () => {
  const r = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 254, pad: 3 },
    host: { mode: 'ips', ips: '10.0.0.254-10.0.1.1' },
  }));
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows.length, 4);
  assert.deepEqual(r.rows.map((x) => x.host), ['10.0.0.254', '10.0.0.255', '10.0.1.0', '10.0.1.1']);
  assert.match(joined(r.warnings), /브로드캐스트|네트워크/);
});

/* T26 SSRF */
test('T26 루프백/링크로컬 IP → blocked[] 로 분리 + 전체 거부', () => {
  const r = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 2, count: 3 },
    host: { mode: 'ips', ips: '127.0.0.1-127.0.0.3' },
  }));
  assert.equal(r.rows.length, 0);
  assert.equal(r.blocked.length, 3);
  assert.equal(r.blocked[0].ip, '127.0.0.1');
  assert.match(r.blocked[0].reason, /루프백/);
  assert.equal(r.errors.length, 1);          // 사유는 blocked 에, 오류는 요약 1건만

  const meta = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 2, count: 1 },
    host: { mode: 'ips', ips: '169.254.169.254' },
  }));
  assert.equal(meta.rows.length, 0);
  assert.equal(meta.blocked.length, 1);
  assert.match(meta.blocked[0].reason, /링크로컬|메타데이터/);
});

/* T27 IPv6 */
test('T27 IPv6 입력은 입력 단계에서 명시 거부(저장소가 받지 못한다)', () => {
  const r = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 2, count: 1 },
    host: { mode: 'ips', ips: 'fe80::1' },
  }));
  assert.equal(r.rows.length, 0);
  assert.match(joined(r.errors), /IPv6/);
});

/* T28 경로 세그먼트 */
test("T28 경로 'OC2/SBP' 는 SAFE_PATH 를 통과해도 세그먼트 규칙 위반이라 거부", () => {
  const r = expandGenSpec(base({ path: 'OC2/SBP' }));
  assert.equal(r.rows.length, 0);
  assert.match(joined(r.errors), /쓸 수 없는 문자/);
  // 정상 경로는 통과(같은 스펙에서 경로만 다르다)
  assert.equal(expandGenSpec(base({ path: 'A.Infra\\OC2' })).rows.length, 20);
  assert.match(joined(expandGenSpec(base({ path: '' })).errors), /트리 경로/);
});

/* T29 1회 상한 */
test('T29 1회 생성 상한 초과 → 클램프 없이 오류 1건(행별 오류 배열이 아니다)', () => {
  const r = expandGenSpec(base({
    name: { pattern: 'h{n}', start: 1, pad: 4, count: MAX_GEN_ROWS + 500 },
    host: { mode: 'name', domain: '.x.local' },
  }));
  assert.equal(r.rows.length, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], new RegExp(String(MAX_GEN_ROWS)));
  // 경계값은 통과해야 한다(상한 자체를 거부하지 않게)
  const edge = expandGenSpec(base({
    name: { pattern: 'h{n}', start: 1, pad: 4, count: MAX_GEN_ROWS },
    host: { mode: 'name', domain: '.x.local' },
  }));
  assert.deepEqual(edge.errors, []);
  assert.equal(edge.rows.length, MAX_GEN_ROWS);
});

test('점검 상한 초과(materialize 결과 합계) → 오류 1건', () => {
  const per = Math.ceil(LIMITS.maxBulkTests / 100) + 1;      // 100대 × per > maxBulkTests
  const tests = Array.from({ length: per }, (_, i) => ({ name: `t${i}`, type: 'ping' }));
  const r = expandGenSpec(base({
    name: { pattern: 'h{n}', start: 1, pad: 3, count: 100 },
    host: { mode: 'name', domain: '.x.local' },
  }), { materialize: () => tests });
  assert.equal(r.rows.length, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /점검 상한 초과/);
});

/* T30 mode:'name' */
test("T30 mode:'name' — domain 필수 · '.' 시작 필수 · host 는 name+domain", () => {
  const noDomain = expandGenSpec(base({
    name: { pattern: 'app{n}', start: 1, pad: 2, count: 1 },
    host: { mode: 'name' },
  }));
  assert.equal(noDomain.rows.length, 0);
  assert.match(joined(noDomain.errors), /도메인/);

  const noDot = expandGenSpec(base({
    name: { pattern: 'app{n}', start: 1, pad: 2, count: 1 },
    host: { mode: 'name', domain: 'sbp.local' },
  }));
  assert.equal(noDot.rows.length, 0);
  assert.match(joined(noDot.errors), /'\.' 으로 시작/);

  const ok = expandGenSpec(base({
    name: { pattern: 'app{n}', start: 1, pad: 2, count: 2 },
    host: { mode: 'name', domain: '.sbp.local' },
  }));
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.rows.map((r) => r.host), ['app01.sbp.local', 'app02.sbp.local']);
  assert.equal(ok.stats.ips, 0);

  // 개수는 IP 로 추론할 수 없으므로 필수
  const noCount = expandGenSpec(base({
    name: { pattern: 'app{n}', start: 1, pad: 2 },
    host: { mode: 'name', domain: '.sbp.local' },
  }));
  assert.equal(noCount.rows.length, 0);
  assert.match(joined(noCount.errors), /개수/);
});

/* T34 mode:'name' 의 호스트 가드 — 자유 문자열을 이어붙여 호스트를 만드는 유일한 경로 */
test("T34 mode:'name' 도 SSRF 가드·253자 상한을 통과해야 한다(mode:'ips' 와 대칭)", () => {
  // 이름+도메인이 루프백 IP 가 되는 경우 — 가드를 지우면 이 케이스가 rows 1 로 통과한다.
  const loop = expandGenSpec(base({
    name: { pattern: '127.0.0', start: 1, pad: 0, count: 1 },
    host: { mode: 'name', domain: '.1' },
  }));
  assert.equal(loop.rows.length, 0);
  assert.equal(loop.blocked.length, 1);
  assert.equal(loop.blocked[0].ip, '127.0.0.1');
  assert.match(loop.blocked[0].reason, /루프백/);
  assert.equal(loop.blockedTotal, 1);

  // 루프백 '이름'(localhost) 도 차단 — IP 형태만 보는 것이 아니다.
  const local = expandGenSpec(base({
    name: { pattern: 'a', count: 1 },
    host: { mode: 'name', domain: '.localhost' },
  }));
  assert.equal(local.rows.length, 0);
  assert.equal(local.blocked.length, 1);
  assert.match(local.blocked[0].reason, /루프백/);

  // 메타데이터 주소
  const meta = expandGenSpec(base({
    name: { pattern: '169.254.169', count: 1 },
    host: { mode: 'name', domain: '.254' },
  }));
  assert.equal(meta.rows.length, 0);
  assert.equal(meta.blocked.length, 1);
  assert.match(meta.blocked[0].reason, /링크로컬|메타데이터/);

  // 이름 115자 + 도메인 201자 = 317자 → 253자 상한 초과로 거부(자르지 않는다).
  const long = expandGenSpec(base({
    name: { pattern: 'x'.repeat(115), count: 1 },
    host: { mode: 'name', domain: `.${'y'.repeat(200)}` },
  }));
  assert.equal(long.rows.length, 0);
  assert.match(joined(long.errors), /253자/);

  // 정상 이름은 계속 통과한다(위 가드가 과잉 차단이 아님을 확인).
  const ok = expandGenSpec(base({
    name: { pattern: 'app{n}', start: 1, pad: 2, count: 2 },
    host: { mode: 'name', domain: '.sbp.local' },
  }));
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.rows.length, 2);
  assert.equal(ok.blockedTotal, 0);
});

/* T35 비정규 IPv4 표기(옥텟 선행 0) */
test('T35 선행 0 표기는 전체 거부 — 가드가 읽는 주소와 실제 접속 주소가 갈린다', () => {
  // '0127.0.0.1': SSRF 가드는 8진수로 읽어 87.0.0.1(공인) 로 판정해 허용하는데
  // OS 리졸버는 127.0.0.1 로 해석한다(macOS dns.lookup 실측) → 루프백 차단이 우회된다.
  const oct = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 2, count: 1 },
    host: { mode: 'ips', ips: '0127.0.0.1' },
  }));
  assert.equal(oct.rows.length, 0);
  assert.match(joined(oct.errors), /선행 0/);

  // 엑셀/CMDB 에서 자리를 맞춰 0 을 채운 목록 — 가드는 8진수 8.16.24.33 로 읽는다.
  const padded = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 2, count: 3 },
    host: { mode: 'ips', ips: '010.020.030.041,010.020.030.042,010.020.030.043' },
  }));
  assert.equal(padded.rows.length, 0);
  assert.match(joined(padded.errors), /선행 0/);

  // 마지막 옥텟만 채운 경우도 같다.
  const last = expandGenSpec(base({
    name: { pattern: 'n{n}', count: 1 },
    host: { mode: 'ips', ips: '10.0.0.01' },
  }));
  assert.equal(last.rows.length, 0);
  assert.match(joined(last.errors), /선행 0/);

  // 범위 표기는 iprange 가 정규형으로 되돌려 주므로 거부하지 않는다(정상 통과 + host 는 정규형).
  const range = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 2, count: 3 },
    host: { mode: 'ips', ips: '010.020.030.041-010.020.030.043' },
  }));
  assert.deepEqual(range.errors, []);
  assert.deepEqual(range.rows.map((x) => x.host), ['10.20.30.41', '10.20.30.42', '10.20.30.43']);

  // mode:'name' 에서 이름+도메인이 숫자 4옥텟이 되는 경우도 같은 규칙으로 막는다.
  const viaName = expandGenSpec(base({
    name: { pattern: '010.0.0', count: 1 },
    host: { mode: 'name', domain: '.1' },
  }));
  assert.equal(viaName.rows.length, 0);
  assert.match(joined(viaName.errors), /선행 0/);
  // 다만 DNS 이름 안의 '010' 라벨은 오탐하지 않는다(4옥텟 전부 숫자일 때만 본다).
  for (const domain of ['.corp.local', '.010.corp.local']) {
    const dns = expandGenSpec(base({ name: { pattern: 'srv010', count: 1 }, host: { mode: 'name', domain } }));
    assert.deepEqual(dns.errors, [], domain);
    assert.equal(dns.rows.length, 1);
  }
});

/* T36 정수 검증 — count 는 이 모듈의 중심 안전장치다 */
test("T36 count/pad/start 는 정수 리터럴만 인정한다('1e3'·'0x64'·true·[3] 우회 차단)", () => {
  for (const bad of ['1e3', '0x64', true, false, [3], {}, '1_0', ' 1e3 ', '0b11', Infinity, NaN]) {
    const r = expandGenSpec(base({
      name: { pattern: 'n{n}', start: 1, pad: 2, count: bad },
      host: { mode: 'name', domain: '.x.local' },
    }));
    assert.equal(r.rows.length, 0, `count=${String(bad)} 가 통과했다`);
    assert.match(joined(r.errors), /정수/, String(bad));
  }
  // pad 도 같다 — true 를 1 로 받으면 이름 자리수가 조용히 바뀌어 트리 정렬이 흐트러진다.
  const padBool = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: true, count: 2 },
    host: { mode: 'name', domain: '.x.local' },
  }));
  assert.equal(padBool.rows.length, 0);
  assert.match(joined(padBool.errors), /자리수/);

  // 폼에서 오는 숫자 문자열·공백은 계속 받아야 한다(과잉 거부 방지).
  const str = expandGenSpec(base({
    name: { pattern: 'n{n}', start: ' 5 ', pad: '2', count: '3' },
    host: { mode: 'ips', ips: '10.20.30.41-10.20.30.43' },
  }));
  assert.deepEqual(str.errors, []);
  assert.deepEqual(str.rows.map((x) => x.name), ['n05', 'n06', 'n07']);
});

/* T37 목록 상한 — errors 만 캡을 두면 의미가 없다 */
test('T37 blocked/warnings 도 상한·중복 제거 — 응답이 입력 토큰 수에 비례해 커지지 않는다', () => {
  const r = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 4 },
    host: { mode: 'ips', ips: '127.0.0.0/22' },
  }));
  assert.equal(r.rows.length, 0);
  assert.equal(r.blockedTotal, 1022);                       // 총 건수는 정확히 보고
  assert.equal(r.blocked.length, LIST_CAPS.blocked);        // 목록은 상한까지만
  assert.match(joined(r.errors), /1022건/);                 // 요약 문구가 실제 건수를 담는다
  assert.ok(JSON.stringify(r).length < 8000, `응답 ${JSON.stringify(r).length}바이트`);

  // 같은 CIDR 토큰 5,000개 → 완전히 동일한 정규화 경고가 5,000건 쌓였던 케이스(388KB).
  const dup = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 4 },
    host: { mode: 'ips', ips: Array.from({ length: 5000 }, () => '10.0.0.5/24').join(',') },
  }));
  assert.equal(dup.warnings.length, new Set(dup.warnings).size, joined(dup.warnings));
  assert.ok(dup.warnings.length <= LIST_CAPS.warnings + 1, joined(dup.warnings));
  assert.match(joined(dup.warnings), /정규화/);

  // 서로 다른 경고가 상한을 넘으면 생략 건수를 알린다(조용히 버리지 않는다).
  const manyWarn = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 3 },
    host: { mode: 'ips', ips: Array.from({ length: 25 }, (_, i) => `10.0.${i}.6/30`).join(',') },
  }));
  assert.deepEqual(manyWarn.errors, []);
  assert.equal(manyWarn.warnings.length, LIST_CAPS.warnings + 1);
  assert.match(manyWarn.warnings[LIST_CAPS.warnings], /생략/);
});

/* T38 suggest 는 그대로 넣으면 통과하는 값이어야 한다 */
test('T38 IP 개수가 1회 생성 상한을 넘으면 suggest 를 주지 않고 분할 안내를 준다', () => {
  const r = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 4, count: 20 },
    host: { mode: 'ips', ips: '10.0.0.0/20' },              // 4,094개 > MAX_GEN_ROWS
  }));
  assert.equal(r.rows.length, 0);
  assert.equal(r.stats.ips, 4094);
  // 4094 를 제안하면 그 값을 그대로 적용해도 '1회 생성 상한 초과' 로 다시 거부된다(막다른 길).
  assert.equal(r.suggest, null);
  assert.match(joined(r.errors), new RegExp(String(MAX_GEN_ROWS)));
  assert.match(joined(r.errors), /나눠/);

  // 상한 이하일 때는 계속 제안하고, 그 값을 적용하면 실제로 통과한다(왕복 확인).
  const ok = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 3, count: 20 },
    host: { mode: 'ips', ips: '10.0.0.0/24' },
  }));
  assert.deepEqual(ok.suggest, { count: 254 });
  const applied = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 3, count: ok.suggest.count },
    host: { mode: 'ips', ips: '10.0.0.0/24' },
  }));
  assert.deepEqual(applied.errors, []);
  assert.equal(applied.rows.length, 254);
});

/* T39 미리보기 ↔ 커밋 판정 일치 (store.planBulkTargets 와 같은 상한) */
test('T39 대상당 점검 상한을 미리보기에서도 본다 — 통과한 rows 는 planBulkTargets 도 전부 받는다', () => {
  const over = Array.from({ length: LIMITS.maxTestsPerTarget + 5 }, (_, i) => ({ name: `t${i}`, type: 'ping' }));
  const r = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 2, count: 3 },
    host: { mode: 'ips', ips: '10.20.30.41-10.20.30.43' },
  }), { materialize: () => over });
  assert.equal(r.rows.length, 0);
  assert.match(joined(r.errors), new RegExp(`대상당 상한 ${LIMITS.maxTestsPerTarget}개`));

  // 점검 값 자체도 커밋과 같은 정제 함수로 본다(예산 안에서) — 'disk' 는 미리보기에서 걸러진다.
  const badType = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 2, count: 3 },
    host: { mode: 'ips', ips: '10.20.30.41-10.20.30.43' },
  }), { materialize: () => [{ name: 'x', type: 'disk' }] });
  assert.equal(badType.rows.length, 0);
  assert.match(joined(badType.errors), /알 수 없는 점검 유형/);

  // 왕복: 미리보기를 통과한 rows 는 커밋 판정(planBulkTargets)에서 전부 prepared 여야 한다.
  const good = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 2, count: 3 },
    host: { mode: 'ips', ips: '10.20.30.41-10.20.30.43' },
  }), { materialize: (row) => [{ name: `ping ${row.name}`, type: 'ping' }] });
  assert.deepEqual(good.errors, []);
  const plan = planBulkTargets(good.rows);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.over, []);
  assert.equal(plan.prepared.length, good.rows.length);
});

/* 그 밖의 입력 검증 */
test('count 는 1 이상 정수만 · 숫자 없는 패턴 + count>1 은 거부 · 역순 범위 거부', () => {
  const zero = expandGenSpec(base({ name: { pattern: 'n{n}', start: 1, pad: 2, count: 0 } }));
  assert.match(joined(zero.errors), /개수/);
  assert.equal(zero.rows.length, 0);
  assert.match(joined(expandGenSpec(base({ name: { pattern: 'n{n}', count: -3 } })).errors), /개수/);
  assert.match(joined(expandGenSpec(base({ name: { pattern: 'n{n}', count: 2.5 } })).errors), /정수/);

  const noVar = expandGenSpec(base({
    name: { pattern: 'fixedname', start: 1, pad: 2, count: 3 },
    host: { mode: 'ips', ips: '10.20.30.41-10.20.30.43' },
  }));
  assert.equal(noVar.rows.length, 0);
  assert.match(joined(noVar.errors), /\{n\}/);
  // count 1 이면 번호 자리가 없어도 된다(단건 등록)
  const single = expandGenSpec(base({
    name: { pattern: 'fixedname', count: 1 },
    host: { mode: 'ips', ips: '10.20.30.41' },
  }));
  assert.deepEqual(single.errors, []);
  assert.equal(single.rows[0].name, 'fixedname');

  const rev = expandGenSpec(base({
    name: { pattern: 'n{n}', count: 3 },
    host: { mode: 'ips', ips: '10.20.30.60-10.20.30.41' },
  }));
  assert.equal(rev.rows.length, 0);
  assert.match(joined(rev.errors), /범위 끝이 시작보다 작습니다/);
});

test("알 수 없는 kind/mode/onDuplicate 는 조용히 폴백하지 않고 오류 · enabled 는 'false' 문자열도 해석", () => {
  assert.match(joined(expandGenSpec(base({ kind: 'infras' })).errors), /알 수 없는 구분/);
  assert.match(joined(expandGenSpec(base({ host: { mode: 'dns', ips: '10.20.30.41' } })).errors), /알 수 없는 호스트 방식/);
  assert.match(joined(expandGenSpec(base({ onDuplicate: 'overwrite' })).errors), /알 수 없는 중복 처리/);
  assert.equal(expandGenSpec(base({ enabled: 'false' })).rows[0].enabled, false);
  assert.equal(expandGenSpec(base({ enabled: 'true' })).rows[0].enabled, true);
  // 미지정 기본값은 testSchema 대상 필드표의 dflt(=true) 를 그대로 쓴다(여기서 새로 정하지 않는다).
  assert.equal(expandGenSpec(base({ enabled: undefined })).rows[0].enabled, true);
  assert.equal(expandGenSpec(base({ kind: 'service' })).rows[0].kind, 'service');
});

test('빈 스펙·비객체 입력에도 던지지 않고 오류로 보고한다(라우트가 500 을 내지 않게)', () => {
  for (const bad of [undefined, null, {}, 'x', 42, []]) {
    const r = expandGenSpec(bad);
    assert.equal(r.rows.length, 0);
    assert.ok(r.errors.length >= 1);
    assert.deepEqual(r.blocked, []);
  }
});

/* ── 끝번호(end) · parseNameCount · expandNames · manual 모드 (v2.249) ── */

test('E1 끝번호(end): start~end 로 개수를 도출한다(count 미입력)', () => {
  const nc = parseNameCount({ pattern: 'srv{n}', start: 1, end: 5, pad: 2 });
  assert.equal(nc.count, 5);
  assert.equal(nc.countFixed, true);
  assert.deepEqual(nc.errors, []);
});

test('E2 끝번호 < 시작번호는 오류', () => {
  const nc = parseNameCount({ pattern: 'a{n}', start: 5, end: 2 });
  assert.match(joined(nc.errors), /끝 번호.*작습니다/);
});

test('E3 개수와 끝번호가 어긋나면 오류(둘 중 하나만 지정)', () => {
  const nc = parseNameCount({ pattern: 'a{n}', start: 1, end: 3, count: 10 });
  assert.match(joined(nc.errors), /어긋납니다/);
});

test('E4 개수·끝번호가 일치하면 통과', () => {
  const nc = parseNameCount({ pattern: 'a{n}', start: 1, end: 3, count: 3 });
  assert.equal(nc.count, 3);
  assert.deepEqual(nc.errors, []);
});

test('E5 expandNames: 이름 목록을 시작~끝·pad 로 만든다', () => {
  const r = expandNames({ pattern: 'srv{n}', start: 1, end: 3, pad: 2 });
  assert.deepEqual(r.names, ['srv01', 'srv02', 'srv03']);
  assert.equal(r.count, 3);
});

test('E6 expandNames: 개수/끝번호 미입력이면 오류(DNS 모드는 개수가 먼저 정해져야)', () => {
  const r = expandNames({ pattern: 'a{n}' });
  assert.equal(r.names.length, 0);
  assert.match(joined(r.errors), /개수 또는 끝번호/);
});

test('E7 expandGenSpec: 끝번호로 ips 모드 개수 교차검증 — 이름 5 vs IP 3 은 거부', () => {
  const r = expandGenSpec(base({
    name: { pattern: 's{n}', start: 1, end: 5, pad: 1 },
    host: { mode: 'ips', ips: '10.20.30.41-10.20.30.43' },
  }));
  assert.equal(r.rows.length, 0);
  assert.match(joined(r.errors), /개수 불일치/);
});

test('M1 manual 정상: 이름 키로 IP 를 붙인다(행 순서 무관)', () => {
  const r = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, end: 3, pad: 1 },
    host: { mode: 'manual', hostMap: { n2: '10.9.0.2', n1: '10.9.0.1', n3: '10.9.0.3' } },
  }));
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows.find((x) => x.name === 'n2').host, '10.9.0.2');
});

test('M2 manual 누락: IP 가 빠진 이름이 있으면 전체 거부', () => {
  const r = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, end: 3, pad: 1 },
    host: { mode: 'manual', hostMap: { n1: '10.9.0.1' } },
  }));
  assert.equal(r.rows.length, 0);
  assert.match(joined(r.errors), /IP 매핑이 없습니다|IP 가 지정되지 않은/);
});

test('M3 manual 차단 IP: SSRF 가드에 걸리면 blocked + 전체 거부', () => {
  const r = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, end: 1, pad: 1 },
    host: { mode: 'manual', hostMap: { n1: '127.0.0.1' } },
  }));
  assert.equal(r.rows.length, 0);
  assert.ok(r.blocked.length >= 1 || /사용할 수 없는/.test(joined(r.errors)));
});

test('M4 manual 개수 미확정: 끝번호/개수 없으면 오류', () => {
  const r = expandGenSpec(base({
    name: { pattern: 'n{n}', start: 1, pad: 1 },
    host: { mode: 'manual', hostMap: { n1: '10.9.0.1' } },
  }));
  assert.equal(r.rows.length, 0);
  assert.match(joined(r.errors), /개수 또는 끝번호/);
});
