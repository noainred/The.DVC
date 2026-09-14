/**
 * v2.506 — 2026-09-13 감사 미해결 3건(①②③) 조치 회귀 테스트.
 *
 * ① /api/svcmon 기능 권한 게이트  ② DNS 리바인딩(TOCTOU) 차단  ③ toolsDenied 서버 집행 커버리지
 *
 * 여기서 고정하는 것은 '기능이 동작한다' 가 아니라 **되돌리면 다시 뚫리는 경계**다.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2506-'));

let PERM; let LOOKUP;
before(async () => {
  PERM = await import('../src/auth/permissions.js');
  LOOKUP = await import('../src/util/ssrfLookup.js');
});

/* ── ① svcmon 기능 권한 게이트 ────────────────────────────────────────────── */

test('① /api/svcmon 은 마운트가 전부이며 그 마운트에 requirePerm 이 걸려 있다', () => {
  // 예전에는 authMiddleware+requireEnrolled 만 있어 로그인한 아무 계정이나
  // GET /api/svcmon/state?limit=2000 으로 전 법인 감시 대상 host·포트를 페이징할 수 있었다.
  // 라우트 56개 중 읽기 6개(/state·/edges·/edge-state·/templates·/log·/log/windows)가 무가드였다.
  const idx = read('index.js');
  const all = idx.split('\n').filter((l) => /app\.use\(\s*'\/api\/svcmon/.test(l));
  // ⚠ v2.506 검증 지적: 초판은 `.find()` 로 **첫 줄 하나만** 봤다. 두 번째 마운트가 추가되거나
  //   더 느슨한 경로(예: '/api/svcmon/state')가 위에 끼면 통과했다. 전수로 본다.
  // 라우터를 붙이는 마운트는 정확히 하나여야 한다 — 두 개면 한쪽에만 게이트가 걸릴 수 있다.
  const mounts = all.filter((l) => l.includes('svcmonRouter'));
  assert.equal(mounts.length, 1, `svcmonRouter 마운트가 ${mounts.length}개다:\n${mounts.join('\n')}`);
  // 나머지 /api/svcmon 마운트는 **본문 파서(BIG_JSON)뿐**이어야 한다. 파서는 next() 로 넘기므로
  // 응답을 만들지 않지만, 라우터나 다른 핸들러가 여기 섞이면 게이트를 우회하는 경로가 생긴다.
  for (const l of all.filter((x) => !x.includes('svcmonRouter'))) {
    assert.match(l, /BIG_JSON\);/, `게이트 밖 /api/svcmon 마운트가 본문 파서가 아니다 — 우회 경로가 된다: ${l}`);
  }
  assert.match(mounts[0], /requirePerm\('svcmon'\)/, `mount 에 requirePerm 이 없다: ${mounts[0]}`);
  // 미들웨어 순서: authMiddleware → requireEnrolled → requirePerm → 라우터.
  const order = ['authMiddleware', 'requireEnrolled', "requirePerm('svcmon')", 'svcmonRouter'].map((t) => mounts[0].indexOf(t));
  assert.ok(order.every((i) => i >= 0), `마운트에 빠진 미들웨어가 있다: ${mounts[0]}`);
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i] > order[i - 1], `미들웨어 순서가 뒤바뀌었다 — 라우터가 게이트보다 먼저다: ${mounts[0]}`);
  }
  // 형제 /api/insights 와 같은 규약을 유지한다.
  assert.match(idx, /app\.use\('\/api\/insights'[^\n]*requirePerm\('insights'\)/);
  // 라우터 안에 '조회는 로그인 사용자' 라는 낡은 서술이 남아 있으면 다음 사람이 게이트를 지운다.
  assert.ok(!read('routes/svcmon/shared.js').includes('조회는 로그인 사용자'),
    'svcmon/shared.js 주석이 마운트 게이트 이전 상태를 서술하고 있다');
});

test('① 프론트도 같은 경계를 쓴다 — 셸 폴링과 특수 기능 카드', () => {
  // 서버만 막으면 권한 없는 역할은 30초마다 403 을 받고, 타일은 '점검 상태 대기'(거짓 원인)로
  // 남는다(CLAUDE.md v2.493). 두 셸(V4·관제 콘솔)과 특수 기능 카드가 같은 키를 봐야 한다.
  const WEB = path.resolve(HERE, '../../web/src');
  for (const f of ['version_4/V4App.jsx', 'console/DvcConsole.jsx']) {
    const src = fs.readFileSync(path.join(WEB, f), 'utf8');
    assert.match(src, /canSvcmon = can\('svcmon'\)/, `${f}: svcmon 권한 판정이 없다`);
    assert.match(src, /usePolling\(canSvcmon \? '\/svcmon\/state' : null/, `${f}: 권한 무관 폴링이 남아 있다`);
    assert.match(src, /svcmon: canSvcmon/, `${f}: 타일에 권한 상태를 넘기지 않아 원인 문구가 거짓이 된다`);
  }
  const list = fs.readFileSync(path.join(WEB, 'views/specialToolsList.js'), 'utf8');
  const row = list.split('\n').find((l) => l.includes("k: 'svcmon-config'"));
  assert.ok(row, 'svcmon-config 항목을 찾지 못했다');
  assert.match(row, /perm: 'svcmon'/, 'svcmon-config 카드에 perm 이 없어 tools 권한만으로 열리고 화면 전체가 403 이 된다');
});

test('① svcmon 권한 키가 카탈로그에 있고 viewer 기본값에서 제외된다', () => {
  assert.ok(PERM.ALL_PERMISSION_KEYS.includes('svcmon'), '카탈로그에 svcmon 키가 없다');
  // 핵심: viewer 가 기본으로 가지면 이번 수정이 무의미하다(v2.500 B/M-1 알람 음소거와 같은 교훈).
  assert.ok(!PERM.rolePermissions('viewer').includes('svcmon'), 'viewer 가 svcmon 을 기본 보유한다 — 취약점이 그대로다');
  assert.ok(PERM.rolePermissions('operator').includes('svcmon'), 'operator 는 기존 기능을 유지해야 한다');
  assert.ok(PERM.rolePermissions('admin').includes('svcmon'), 'admin 은 항상 전 권한');
});

test('① 가산 마이그레이션(순수) — operator 는 기능을 잃지 않고 viewer 는 얻지 않는다', () => {
  // `loadMatrix` 는 저장된 행을 그대로 쓴다(`m.operator ?? DEFAULT`). 행은 '부여된 키 배열' 이라
  // "키가 없던 파일" 과 "관리자가 거부한 키" 를 구분할 수 없다 → 카탈로그에 키만 추가하면
  // 권한 UI 를 한 번이라도 저장한 현장에서 operator 가 업그레이드만으로 기능을 잃는다.
  const opRow = ['dashboard', 'inv.hosts', 'tools', 'insights', 'remote.access'];
  const vwRow = ['dashboard', 'inv.hosts', 'insights'];

  // 구버전 파일(버전 없음 = 1): 기본값에 있는 키만 가산된다.
  assert.ok(PERM.migrateRow(opRow, 'operator', 1).includes('svcmon'), '구버전 파일에서 operator 가 svcmon 을 잃었다(업그레이드 회귀)');
  assert.ok(!PERM.migrateRow(vwRow, 'viewer', 1).includes('svcmon'), '구버전 파일에서 viewer 가 svcmon 을 얻었다(취약점 유지)');
  // 기존 키를 건드리지 않는다(가산만).
  for (const k of opRow) assert.ok(PERM.migrateRow(opRow, 'operator', 1).includes(k), `기존 키 ${k} 가 사라졌다`);

  // 현재 버전 파일: 마이그레이션이 돌지 않는다 — 관리자의 명시적 거부를 되살리면 안 된다.
  const denied = PERM.migrateRow(['dashboard'], 'operator', 2);
  assert.ok(!denied.includes('svcmon'), '현재 버전 파일에 가산이 일어났다 — 관리자가 내린 결정을 덮어쓴다');
  assert.deepEqual(denied, ['dashboard']);
});

test('① 파일 왕복 — 구버전 파일 로드·저장이 실제로 그렇게 동작한다(별도 프로세스)', () => {
  // config.js 는 싱글톤이라 한 프로세스에서 CONFIG_DIR 을 바꿔 재확인할 수 없다 → 자식 프로세스로.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2506-mig-'));
  fs.writeFileSync(path.join(dir, 'permissions.json'), JSON.stringify({
    matrix: {
      operator: ['dashboard', 'inv.hosts', 'tools', 'insights', 'remote.access'],
      viewer: ['dashboard', 'inv.hosts', 'insights'],
      toolsDenied: { operator: [], viewer: ['gpu'] },
    },
  }));
  const script = `
    const P = await import(${JSON.stringify(path.join(SRC, 'auth/permissions.js'))});
    const out = {
      op: P.rolePermissions('operator').includes('svcmon'),
      vw: P.rolePermissions('viewer').includes('svcmon'),
      td: P.roleToolsDenied('viewer'),
    };
    P.saveMatrix({ viewer: ['dashboard'] });
    const fs2 = await import('node:fs');
    const after = JSON.parse(fs2.readFileSync(${JSON.stringify(path.join(dir, 'permissions.json'))}, 'utf8'));
    out.ver = after.schemaVersion;
    out.reGranted = after.matrix.viewer.includes('svcmon');
    console.log(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.op, true, 'operator 가 svcmon 을 잃었다');
  assert.equal(out.vw, false, 'viewer 가 svcmon 을 얻었다');
  assert.deepEqual(out.td, ['gpu'], '기존 toolsDenied 가 보존돼야 한다');
  assert.ok(Number(out.ver) >= 2, 'schemaVersion 을 기록하지 않으면 다음 키 추가 때 또 조용한 거부가 된다');
  assert.equal(out.reGranted, false, '명시적 거부를 재부여하면 안 된다');
});

test('① 프론트 탭 게이트가 서버와 같은 키를 쓴다', () => {
  // 다른 키를 쓰면 '메뉴는 보이는데 API 는 403' 이 된다(사용자는 장애로 오해한다).
  const app = fs.readFileSync(path.resolve(HERE, '../../web/src/App.jsx'), 'utf8');
  const line = app.split('\n').find((l) => l.includes("id: 'svcmon'"));
  assert.ok(line, 'svcmon 탭 정의를 찾지 못했다');
  assert.match(line, /perm: 'svcmon'/, `프론트 게이트 키가 서버와 다르다: ${line}`);
});

/* ── ② DNS 리바인딩(TOCTOU) ──────────────────────────────────────────────── */

const probe = (lookupImpl, host = 'x.example', opts = {}) => new Promise((res) => {
  LOOKUP.makeSsrfLookup({ lookupImpl })(host, opts, (e, a, f) => res({ err: e, a, f }));
});

test('② 해석 결과가 차단 대역이면 접속 전에 거부된다', async () => {
  for (const ip of ['127.0.0.1', '169.254.169.254', '::1']) {
    const r = await probe((h, o, cb) => cb(null, ip, ip.includes(':') ? 6 : 4));
    assert.equal(r.err?.code, 'ESSRFBLOCKED', `${ip} 가 통과했다`);
  }
});

test('② 사내(RFC1918)·공인 주소는 통과한다(정상 흐름 보존)', async () => {
  for (const ip of ['10.20.30.40', '192.168.1.10', '172.16.5.5', '140.82.121.4']) {
    const r = await probe((h, o, cb) => cb(null, ip, 4));
    assert.equal(r.err, null, `${ip} 가 차단됐다 — 정상 수집/업그레이드가 깨진다`);
    assert.equal(r.a, ip);
  }
});

test('② 멀티-A 는 차단 주소만 걸러낸다 — 남은 게 없을 때만 거부', async () => {
  // 공격자는 A 레코드에 정상 IP 와 사내 IP 를 함께 실어 어느 것을 고르든 한 번은 사내로 가게 만든다.
  // 초판은 '하나라도 차단이면 전체 거부' 였는데, 그러면 **이중스택 사내 FQDN**
  // (A=192.168.x + AAAA=fd00::x, ULA 는 ipv6BlockReason 이 막는다)이 통째로 실패했다 —
  // 정상 수집·업그레이드가 깨지는 쪽이 더 큰 사고다. 필터링으로도 리바인딩 방어는 동등하다:
  // 공격자가 노리는 주소가 **후보 집합에서 제거**되므로 undici 가 그것을 고를 수 없다.
  const mixed = await probe(
    (h, o, cb) => cb(null, [{ address: '10.0.0.5', family: 4 }, { address: '127.0.0.1', family: 4 }], 4),
    'x.example', { all: true },
  );
  assert.equal(mixed.err, null, '허용 주소가 남아 있는데 거부했다');
  assert.deepEqual(mixed.a, [{ address: '10.0.0.5', family: 4 }], '차단 주소가 후보에 남아 있다');

  // 이중스택 사내 이름(회귀 — 이 케이스가 v2.506 초판에서 하드 실패였다).
  const dual = await probe(
    (h, o, cb) => cb(null, [{ address: '192.168.1.10', family: 4 }, { address: 'fd00::1', family: 6 }], 4),
    'intra.example', { all: true },
  );
  assert.equal(dual.err, null, '이중스택 사내 이름을 막았다 — 정상 수집이 깨진다');
  assert.deepEqual(dual.a, [{ address: '192.168.1.10', family: 4 }]);

  // 전부 차단 대역이면 그때는 거부한다.
  const all = await probe(
    (h, o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }, { address: '169.254.169.254', family: 4 }], 4),
    'evil.example', { all: true },
  );
  assert.equal(all.err?.code, 'ESSRFBLOCKED');

  // 단건(all 없음)에서 차단 주소면 거부.
  const one = await probe((h, o, cb) => cb(null, '127.0.0.1', 4), 'evil2.example');
  assert.equal(one.err?.code, 'ESSRFBLOCKED');
});

test('② all:true 응답 형태를 보존한다(undici 가 배열을 기대한다)', async () => {
  const r = await probe((h, o, cb) => cb(null, [{ address: '10.0.0.5', family: 4 }], 4), 'x.example', { all: true });
  assert.equal(r.err, null);
  assert.deepEqual(r.a, [{ address: '10.0.0.5', family: 4 }]);
});

test('② DNS 가 응답하지 않으면 타임아웃으로 끊는다(폴러가 매달리지 않게)', async () => {
  const t0 = Date.now();
  const r = await new Promise((res) => {
    LOOKUP.makeSsrfLookup({ timeoutMs: 300, lookupImpl: () => {} })('slow.example', {}, (e) => res(e));
  });
  assert.equal(r?.code, 'ETIMEDOUT');
  assert.ok(Date.now() - t0 < 3000, '타임아웃이 동작하지 않았다');
});

test('② 타임아웃 후 늦게 온 응답이 콜백을 두 번 부르지 않는다', async () => {
  let n = 0;
  await new Promise((res) => {
    LOOKUP.makeSsrfLookup({ timeoutMs: 120, lookupImpl: (h, o, cb) => setTimeout(() => cb(null, '10.0.0.1', 4), 320) })(
      'late.example', {}, () => { n += 1; },
    );
    setTimeout(res, 600);
  });
  assert.equal(n, 1, `콜백이 ${n}회 불렸다 — 소켓 상태가 깨진다`);
});

test('② DNS 오류는 차단으로 바꾸지 않고 그대로 전파한다', async () => {
  const r = await probe((h, o, cb) => cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })));
  assert.equal(r.err?.code, 'ENOTFOUND', '해석 실패를 ESSRFBLOCKED 로 바꾸면 원인 진단이 불가능해진다');
});

test('② 리바인딩 취약 접속부 전부에 lookup 이 붙어 있다', () => {
  // 하나라도 빠지면 그 경로가 TOCTOU 로 남는다.
  const cases = [
    ['util/resilientFetch.js', /connect: \{[^}]*lookup: ssrfLookup/],
    ['alerts.js', /new UndiciAgent\(\{ connect: \{[^}]*lookup: ssrfLookup/],
    ['horizon/horizon.js', /new Agent\(\{ connect: \{[^}]*lookup: ssrfLookup/],
  ];
  for (const [f, re] of cases) assert.match(read(f), re, `${f} 에 lookup 이 없다`);
  // tls.connect / https.request 계열은 옵션 객체에 직접 붙는다.
  for (const f of ['vcenter/relayProbe.js', 'security/certMonitor.js']) {
    const src = read(f);
    const n = (src.match(/lookup: ssrfLookup/g) || []).length;
    assert.ok(n >= 1, `${f} 에 lookup 이 없다`);
    assert.match(src, /servername: host/, `${f}: servername 을 유지해야 SNI·인증서 검증이 살아 있다`);
  }
  // relayProbe 는 접속부가 **4개**다(net.connect·tls.connect·https.request·http.request).
  // 처음에 2개만 배선했다가 검증에서 잡혔다 — 하나라도 빠지면 그 단계가 TOCTOU 로 남는다.
  const rp = read('vcenter/relayProbe.js');
  assert.equal((rp.match(/lookup: ssrfLookup/g) || []).length, 4,
    'relayProbe 의 4개 접속부(net/tls/https/http) 전부에 lookup 이 필요하다');
  for (const call of ['net.connect(', 'tls.connect(', 'https.request(', 'http.request(']) {
    assert.ok(rp.includes(call), `relayProbe 에서 ${call} 가 사라졌다 — 테스트 기대치를 갱신해야 한다`);
  }
});

test('② dispatcher 훅은 사전 가드가 없던 경로도 덮는다(horizon 폴러)', () => {
  // `fetchHorizonLicenses`(horizon.js) 는 실행 시점 SSRF 가드가 **전혀 없었다** — 저장 시점
  // 검사만 있었다. 감사가 제안한 '호출부마다 사전 검사 추가' 방식이면 이 경로를 빠뜨릴 수 있다.
  // dispatcher 에 lookup 을 달면 그 dispatcher 를 쓰는 전 요청이 자동으로 덮인다.
  const hz = read('horizon/horizon.js');
  assert.match(hz, /const dispatcher = new Agent\(\{ connect: \{[^}]*lookup: ssrfLookup/);
  assert.match(hz, /hzFetch[\s\S]{0,200}dispatcher/, 'hzFetch 가 그 dispatcher 를 써야 폴러 경로가 덮인다');
});

test('② IP 리터럴은 lookup 을 타지 않으므로 동기 가드를 없애면 안 된다', () => {
  // 실측: http://127.0.0.1 요청은 lookup 이 불리지 않아 그대로 나간다.
  // 그래서 저장·요청 시점의 ssrfBlockReason(동기, IP 리터럴 검사)이 계속 있어야 한다.
  const reg = read('collector/registry.js');
  assert.match(reg, /export function ssrfBlockReason\(/);
  assert.match(reg, /export function ipBlockReason\(/);
  for (const f of ['alerts.js', 'horizon/horizon.js']) {
    assert.match(read(f), /ssrfBlockReason(Resolved)?\(/, `${f}: 사전 가드를 제거하면 IP 리터럴 SSRF 가 열린다`);
  }
});

/* ── ③ toolsDenied 서버 집행 커버리지 ───────────────────────────────────────── */

let TA;
before(async () => { TA = await import('../src/auth/toolAccess.js'); });

const uiToolKeys = () => [...fs.readFileSync(path.resolve(HERE, '../../web/src/views/specialToolsList.js'), 'utf8')
  .matchAll(/\{ k: '([a-z0-9-]+)'/g)].map((m) => m[1]);

test('③ 두 세그먼트 매칭 — /tools/report/* 가 도구별로 구분된다', () => {
  // 첫 세그먼트만 보던 예전 매처로는 report 하위 10개 도구가 전부 집행 대상에서 빠졌다
  // (관리자는 화면에서 '차단됨' 을 보지만 curl 은 200 — v2.447 이 없애려 한 무음 실패).
  const want = {
    '/report/health': 'daily-health',
    '/report/snapshot-age': 'snapshot-age',
    '/report/zombies': 'zombie-vms',
    '/report/certs': 'cert-expiry',
    '/report/rightsizing': 'rightsizing',
    '/report/capacity': 'capacity-forecast',
    '/report/alerts': 'alert-channels',
    '/report/compliance': 'compliance-report',
    '/report/changes': 'change-history',
    '/report/unprotected': 'unprotected-vms',
  };
  for (const [p, k] of Object.entries(want)) assert.equal(TA.toolKeyForPath(p), k, `${p} 매칭 실패`);
  // 확장자·쿼리스트링이 붙어도 같은 키로 떨어진다(내보내기 경로로 우회 불가).
  assert.equal(TA.toolKeyForPath('/report/health.csv'), 'daily-health');
  assert.equal(TA.toolKeyForPath('/report/capacity?days=30'), 'capacity-forecast');
  // 두 세그먼트 표에 없는 report 하위는 null — 모르면 막지 않는다(오차단 방지 규약).
  assert.equal(TA.toolKeyForPath('/report/unknown'), null);
});

test('③ capacity-forecast 미스매핑이 고쳐졌다', () => {
  // `/tools/capacity-forecast` 를 실제로 부르는 화면은 'forecast'(CapacityTools.jsx)다.
  // 예전에는 'capacity-forecast' 키로 매핑돼 **거부하면 엉뚱한 화면이 막히고** 정작
  // forecast 는 안 막혔다. 두 키가 서로 다른 경로를 쓰는 것을 함께 고정한다.
  assert.equal(TA.toolKeyForPath('/capacity-forecast'), 'forecast');
  assert.equal(TA.toolKeyForPath('/report/capacity'), 'capacity-forecast');
});

test('③ 전용 엔드포인트를 가진 도구가 매핑돼 있다', () => {
  assert.equal(TA.toolKeyForPath('/orphan-vmdk'), 'orphanvmdk');
  assert.equal(TA.toolKeyForPath('/orphan-vmdk/datastores'), 'orphanvmdk');
  assert.equal(TA.toolKeyForPath('/service-check'), 'davinci-svc');
  assert.equal(TA.toolKeyForPath('/vmware-config'), 'vmware-backup');
});

test('③ 공유 엔드포인트를 한 도구에 묶지 않는다(다른 화면이 같이 막히는 사고)', () => {
  // `/tools/groups` 는 특수기능 헤더의 클러스터·폴더 콤보가 쓰는 **공용** 목록이다.
  // 어느 도구 키에 묶으면 그 도구를 거부한 역할의 **모든 도구 헤더**가 깨진다.
  assert.equal(TA.toolKeyForPath('/groups'), null, '/tools/groups 를 도구 키에 묶으면 안 된다');
  // `/tools/ip-ping` 은 VM 상세에서도 쓰인다(도구 화면 전용이 아니다).
  assert.equal(TA.toolKeyForPath('/ip-ping'), null);
});

test('③ 모든 UI 도구가 매핑되거나 사유와 함께 선언돼 있다 — 미지 0', () => {
  // 이 테스트가 이번 조치의 핵심이다. 감사 지적은 "41개 미매핑" 이었는데, 그 41개의 성격이
  // 섞여 있었다(전용 엔드포인트 없음 / 다른 라우터 / 미구현). 이제 셋 중 하나로 **선언**되며,
  // 새 도구를 추가하면서 선언을 빼면 이 테스트가 깨진다 → 구멍이 조용히 넓어지지 않는다.
  const cov = TA.toolCoverage(uiToolKeys());
  assert.deepEqual(cov.undeclared, [],
    `서버 집행도 없고 사유 선언도 없는 도구: ${cov.undeclared.join(', ')}\n`
    + '→ 전용 /api/tools 경로가 있으면 TOOL_PATH_KEYS(또는 TOOL_PATH2_KEYS)에 추가하고,\n'
    + '  없으면 TOOL_ENFORCEMENT_NOTES 에 분류와 사유를 적어라(auth/toolAccess.js).');
  // 집행 가능 도구 수가 줄면(= 매핑을 지우면) 알아챌 수 있게 하한을 고정한다.
  assert.ok(cov.enforced.length >= 49, `집행 가능 도구가 ${cov.enforced.length}개로 줄었다(v2.506 기준 49)`);
  assert.ok(uiToolKeys().length >= 79);
});

test('③ 선언된 사유는 알려진 분류만 쓴다(자유 문자열 방지)', () => {
  const kinds = new Set([TA.ENFORCE_OTHER_ROUTER, TA.ENFORCE_SHARED, TA.ENFORCE_PARTIAL, TA.ENFORCE_NO_API]);
  for (const [k, v] of Object.entries(TA.TOOL_ENFORCEMENT_NOTES)) {
    assert.ok(Array.isArray(v) && v.length === 2, `${k}: [분류, 사유] 형태여야 한다`);
    assert.ok(kinds.has(v[0]), `${k}: 알 수 없는 분류 ${v[0]}`);
    assert.ok(String(v[1]).trim().length > 3, `${k}: 사유가 비어 있다 — 관리자가 이유를 알아야 한다`);
  }
});

test('③ /tools 밖 전용 엔드포인트도 실제로 집행된다 — 사유만 고치지 않았다', async () => {
  const TA = await import('../src/auth/toolAccess.js');
  // v2.506 초판은 aisearch·explore 를 "각자 requirePerm/adminOnly 로 보호됨" 으로 적었는데
  // 열어 보니 **둘 다 기능 권한 게이트가 없었다**. 거짓 사유는 관리자를 오판하게 만든다.
  assert.deepEqual(Object.keys(TA.TOOL_EXACT_PATHS).sort(), ['/search/nl', '/top']);
  assert.equal(TA.TOOL_EXACT_PATHS['/search/nl'], 'aisearch');
  assert.equal(TA.TOOL_EXACT_PATHS['/top'], 'explore');
  // 집행 집합에 포함돼야 커버리지 표가 사실과 맞는다.
  const enforced = TA.enforcedToolKeys();
  assert.ok(enforced.has('aisearch') && enforced.has('explore'));
  // 거짓 사유가 다시 들어오지 못하게 — 집행되는 키는 notes 에 남기지 않는다.
  assert.ok(!TA.TOOL_ENFORCEMENT_NOTES.aisearch, 'aisearch 에 미집행 사유가 남아 있다(거짓 선언)');
  assert.ok(!TA.TOOL_ENFORCEMENT_NOTES.explore, 'explore 에 미집행 사유가 남아 있다(거짓 선언)');

  // 정확 일치만 본다 — 접두 일치로 번지면 무관한 경로가 막힌다.
  const issue = (p) => TA.exactToolAccessIssue('nobody-role', p);
  assert.equal(issue('/topology'), null);
  assert.equal(issue('/search/nl/extra'), null);
  assert.equal(issue('/top'), null, '거부목록에 없는 역할은 통과해야 한다');
  // admin 은 언제나 통과.
  assert.equal(TA.exactToolAccessIssue('admin', '/top'), null);
});

test('③ 사유 문자열이 없는 게이트를 주장하지 않는다(dsusage·vmprovision 정정)', async () => {
  const TA = await import('../src/auth/toolAccess.js');
  const inv = read('routes/api/inventory.js');
  // 근거: /datastores 라우트에 requirePerm 이 없다('inv:datastores' 는 memoJson 캐시 이름).
  const dsLine = inv.split('\n').find((l) => l.includes("api.get('/datastores'"));
  assert.ok(dsLine, '/datastores 라우트를 찾지 못했다');
  assert.ok(!/requirePerm/.test(dsLine), '/datastores 에 requirePerm 이 생겼다 — 사유 분류를 갱신할 것');
  assert.equal(TA.TOOL_ENFORCEMENT_NOTES.dsusage[0], TA.ENFORCE_SHARED);
  assert.ok(!/inv\.datastores|inv:datastores/.test(TA.TOOL_ENFORCEMENT_NOTES.dsusage[1]),
    '없는 권한 게이트를 사유로 적고 있다');
  // vmprovision: 두 라우터로 갈린다 — 사유가 둘을 모두 밝혀야 한다.
  const why = TA.TOOL_ENFORCEMENT_NOTES.vmprovision[1];
  assert.match(why, /vm\.provision/);
  assert.match(why, /adminOnly/);
  assert.match(read('routes/api/provision.js'), /requirePerm\('vm\.provision'\)/);
  assert.match(read('routes/admin/opsSettings.js'), /'\/provision\/jobs', adminOnly/);
});

test('③ 집행 정보가 화면까지 도달한다 — 응답만 만들고 안 쓰면 무음 실패가 남는다', () => {
  const WEB = path.resolve(HERE, '../../web/src');
  const ua = fs.readFileSync(path.join(WEB, 'views/UserAdmin.jsx'), 'utf8');
  assert.match(ua, /perms\.toolEnforcement/, '권한 화면이 toolEnforcement 를 쓰지 않는다');
  assert.match(ua, /enforcementOf\(t\.k, perms\.toolEnforcement\)/, '도구 행마다 집행 상태를 보이지 않는다');
  assert.match(ua, /<th>서버 집행<\/th>/, '표에 집행 열이 없다');
  // 판정·문구는 순수 모듈에 둔다(웹 테스트가 node 환경이라 컴포넌트 렌더 테스트가 불가).
  const pure = path.join(WEB, 'views/userAdmin/toolEnforcementText.js');
  assert.ok(fs.existsSync(pure), '집행 문구 순수 모듈이 없다');
  assert.ok(fs.existsSync(pure.replace(/\.js$/, '.test.js')), '순수 모듈 회귀 테스트가 없다');
});

test('③ 권한 화면 API 가 집행 가능 여부를 내려준다(무음 실패 제거)', () => {
  const src = fs.readFileSync(path.join(SRC, 'routes/admin/users.js'), 'utf8');
  assert.match(src, /toolEnforcement/, '/admin/permissions 응답에 toolEnforcement 가 없다');
  assert.match(src, /enforcedToolKeys\(\)/);
  assert.match(src, /TOOL_ENFORCEMENT_NOTES/);
});

test('③ 거부는 실제로 403 을 만든다 — 실 express 앱 + 실 permissions.json (동작 검증)', () => {
  // v2.506 초판의 이 테스트는 routes/api.js 를 **문자열로 grep** 하기만 했다. 그러면
  // 미들웨어 순서가 바뀌거나 두 번째 마운트(전용 엔드포인트)가 빠져도 통과한다 —
  // "규칙이 문서에만 있는" v2.480 실패와 같은 종류다. 그래서 실제 미들웨어(toolGate)를
  // express 앱에 마운트하고 실제 permissions.json 을 읽혀 **상태코드와 본문**을 본다.
  // 자식 프로세스인 이유: config.js 는 싱글턴이라 이 프로세스에서 CONFIG_DIR 을 다시 못 가리킨다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolgate-'));
  fs.writeFileSync(path.join(dir, 'permissions.json'), JSON.stringify({
    schemaVersion: 2,
    matrix: { toolsDenied: { operator: ['ipam', 'aisearch', 'daily-health'], viewer: [] } },
  }));
  const script = `
    const express = (await import('express')).default;
    const { toolGate, exactToolAccessIssue } = await import(${JSON.stringify(path.join(SRC, 'auth/toolAccess.js'))});
    const app = express();
    const roleOf = () => 'operator';
    const api = express.Router();
    api.use('/tools', toolGate({ roleOf }));
    api.use(toolGate({ roleOf, issueOf: exactToolAccessIssue }));
    api.use((_q, res) => res.json({ ok: true }));   // 게이트를 통과하면 200
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const paths = [
      '/api/tools/ipam',            // 정상 형태
      '/api/tools/Ipam',            // 대문자 — express 는 기본 대소문자 무시로 라우팅한다
      '/api/tools/ipam.csv',        // 확장자
      '/api/tools/ipam?vcenterId=x',// 쿼리
      '/api/tools/ipam/',           // 끝 슬래시
      '/api/tools/report/health',   // 두 세그먼트 표(daily-health)
      '/api/tools/REPORT/Health.CSV',
      '/api/search/nl',             // /tools 밖 전용 엔드포인트(aisearch)
      '/api/tools/vms',             // 매핑 없음 → 통과해야 한다(오차단 금지)
      '/api/top',                   // 거부목록에 없다(explore) → 통과
    ];
    const out = {};
    for (const p of paths) {
      const r = await fetch(base + p);
      let body = null; try { body = await r.json(); } catch {}
      out[p] = { status: r.status, perm: body && body.requiredPerm, err: body && body.error };
    }
    srv.close();
    console.log(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir }, encoding: 'utf8', cwd: path.resolve(SRC, '..'),
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());

  const denied403 = {
    '/api/tools/ipam': 'tool:ipam',
    '/api/tools/Ipam': 'tool:ipam',
    '/api/tools/ipam.csv': 'tool:ipam',
    '/api/tools/ipam?vcenterId=x': 'tool:ipam',
    '/api/tools/ipam/': 'tool:ipam',
    '/api/tools/report/health': 'tool:daily-health',
    '/api/tools/REPORT/Health.CSV': 'tool:daily-health',
    '/api/search/nl': 'tool:aisearch',
  };
  for (const [p, perm] of Object.entries(denied403)) {
    assert.equal(out[p].status, 403, `${p} 가 403 이 아니다(${out[p].status}) — 이 변형으로 게이트를 우회할 수 있다`);
    assert.equal(out[p].err, 'forbidden', `${p} 의 error 키가 다르다 — 프론트가 AccessDenied 로 전환하지 못한다`);
    assert.deepEqual(out[p].perm, [perm], `${p} 의 requiredPerm 이 다르다`);
  }
  // 오차단 금지: 매핑 없는 경로와 거부되지 않은 도구는 그대로 통과해야 한다.
  assert.equal(out['/api/tools/vms'].status, 200, '매핑 없는 경로를 막았다 — 정상 사용자가 막힌다');
  assert.equal(out['/api/top'].status, 200, '거부목록에 없는 도구를 막았다');
});

test('② 종단 검증 — 이름이 루프백으로 해석되면 실제 HTTP 요청이 소켓에서 막힌다', async () => {
  // 문자열 매칭이 아닌 **동작** 검증. `localhost` 는 실제로 127.0.0.1 로 해석되므로
  // DNS 리바인딩과 동일한 상황이다(이름 → 차단 대역).
  // 이 테스트가 통과한다는 것은 ① undici 가 connect.lookup 을 실제로 호출하고
  // ② lookup 오류가 요청을 중단시킨다는 뜻이다 — 둘 중 하나라도 아니면 이 조치는
  // '문서만 있는 방어' 가 된다(v2.480 에 같은 사고가 있었다: 규칙이 문서에만 있었다).
  const http = await import('node:http');
  const srv = http.createServer((_q, res) => res.end('INTERNAL'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  const { resilientFetch } = await import('../src/util/resilientFetch.js');
  try {
    let blocked = false;
    try {
      await resilientFetch(`http://localhost:${port}/`, { timeoutMs: 4000, retries: 0 });
    } catch (e) {
      blocked = (e.cause?.code || e.code) === 'ESSRFBLOCKED';
      if (!blocked) throw new Error(`예상과 다른 오류: ${e.cause?.code || e.code} ${e.message}`);
    }
    assert.equal(blocked, true, 'localhost 로 나가는 요청이 차단되지 않았다 — lookup 훅이 동작하지 않는다');

    // 대조군: IP 리터럴은 lookup 을 타지 않는다(문서화한 한계) — 이 사실도 고정해 둔다.
    // 이것이 200 이라는 것은 "동기 ssrfBlockReason 을 없애면 안 된다" 의 근거다.
    const r2 = await resilientFetch(`http://127.0.0.1:${port}/`, { timeoutMs: 4000, retries: 0 });
    assert.equal(r2.status, 200, 'IP 리터럴 경로의 동작이 바뀌었다 — 한계 서술을 갱신해야 한다');
  } finally { srv.close(); }
});
