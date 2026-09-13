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

test('① /api/svcmon mount 에 requirePerm 이 걸려 있다', () => {
  // 예전에는 authMiddleware+requireEnrolled 만 있어 로그인한 아무 계정이나
  // GET /api/svcmon/state?limit=2000 으로 전 법인 감시 대상 host·포트를 페이징할 수 있었다.
  // 라우트 56개 중 읽기 6개(/state·/edges·/edge-state·/templates·/log·/log/windows)가 무가드였다.
  const idx = read('index.js');
  const line = idx.split('\n').find((l) => l.includes("app.use('/api/svcmon'"));
  assert.ok(line, "/api/svcmon mount 를 찾지 못했다");
  assert.match(line, /requirePerm\('svcmon'\)/, `mount 에 requirePerm('svcmon') 이 없다: ${line}`);
  // 형제 /api/insights 와 같은 규약을 유지한다.
  assert.match(idx, /app\.use\('\/api\/insights'[^\n]*requirePerm\('insights'\)/);
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

test('② 멀티-A 에 차단 대역이 섞이면 전체를 거부한다', async () => {
  // 공격자는 A 레코드에 정상 IP 와 사내 IP 를 함께 실어 어느 것을 고르든 한 번은 사내로 가게 만든다.
  const r = await probe((h, o, cb) => cb(null, [{ address: '10.0.0.5', family: 4 }, { address: '127.0.0.1', family: 4 }], 4), 'x.example', { all: true });
  assert.equal(r.err?.code, 'ESSRFBLOCKED');
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

test('③ 권한 화면 API 가 집행 가능 여부를 내려준다(무음 실패 제거)', () => {
  const src = fs.readFileSync(path.join(SRC, 'routes/admin/users.js'), 'utf8');
  assert.match(src, /toolEnforcement/, '/admin/permissions 응답에 toolEnforcement 가 없다');
  assert.match(src, /enforcedToolKeys\(\)/);
  assert.match(src, /TOOL_ENFORCEMENT_NOTES/);
});

test('③ 거부는 실제로 403 을 만든다(집행 경로 확인)', async () => {
  // 미들웨어는 routes/api.js 의 api.use('/tools', …) 하나뿐이다 — 그 계약을 고정한다.
  const apiSrc = fs.readFileSync(path.join(SRC, 'routes/api.js'), 'utf8');
  assert.match(apiSrc, /api\.use\('\/tools',/, '도구 게이트 미들웨어가 사라졌다');
  assert.match(apiSrc, /toolAccessIssue\(role, req\.path\)/);
  // 403 본문 계약(프론트 ErrorBox 가 AccessDenied 로 전환하는 근거)
  assert.match(apiSrc, /error: 'forbidden'/);
  assert.match(apiSrc, /requiredPerm: \[`tool:\$\{issue\.tool\}`\]/);
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
