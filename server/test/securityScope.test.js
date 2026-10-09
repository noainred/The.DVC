import test from 'node:test';
import assert from 'node:assert/strict';
import { scopedVcenterIds, inUserScope } from '../src/auth/scope.js';
import { stripComments } from './_stripComments.js';

// v2.207 보안 감사(4차) 회귀 방지 —
//  S1: WS SSH/RDP 터널이 'OTP 등록 전 세션'을 거부하는지(게이트 조건 자체를 검증)
//  S2: 단건(:id) 조회 scope 검사 헬퍼
//  S3: 미인증 /auth/config 에 settingsOwners(계정명) 미포함

const snap = {
  vcenters: [
    { id: 'vc-seoul', location: { region: '아시아' } },
    { id: 'vc-warsaw', location: { region: '유럽' } },
    { id: 'vc-nyc', location: { region: '북미' } },
  ],
};

test('S2 inUserScope: 제한 없는 사용자는 전부 통과', () => {
  assert.equal(inUserScope(null, snap, 'vc-nyc'), true);
  assert.equal(inUserScope({ role: 'admin' }, snap, 'vc-nyc'), true);
  assert.equal(inUserScope({ scope: { vcenters: [], regions: [] } }, snap, 'vc-nyc'), true);
});

test('S2 inUserScope: 범위 밖 vCenter 의 단건 자원은 거부', () => {
  const u = { role: 'viewer', scope: { vcenters: [], regions: ['유럽'] } };
  assert.equal(inUserScope(u, snap, 'vc-warsaw'), true, '허용 리전은 통과');
  assert.equal(inUserScope(u, snap, 'vc-nyc'), false, '범위 밖은 차단(콘솔·성능·상세 유출 방지)');
  assert.equal(inUserScope(u, snap, 'vc-seoul'), false);
});

test('S2 scopedVcenterIds: 명시 vCenter + 리전 합집합', () => {
  const set = scopedVcenterIds({ scope: { vcenters: ['vc-nyc'], regions: ['유럽'] } }, snap);
  assert.deepEqual([...set].sort(), ['vc-nyc', 'vc-warsaw']);
});

test('S1: WS 게이트웨이 소스가 mustEnrollOtp 를 거부하는지(정적 검증)', async () => {
  const fs = await import('node:fs');
  // 2026-10-09 S-04(그룹 H): 판정 본문은 sshGateway.js remoteUserIssue 하나이고 RDP 게이트웨이는 그 함수를 쓴다
  //   (업그레이드·열린 연결 재검증이 같은 판정 — 복제하면 한쪽만 바뀐다). 실행 검증은 test/rvH_remoteSession.test.js.
  const strip = stripComments; // v2.574 규약 — 2줄 정규식 사본 금지(test/_stripComments.js 하나)
  const ssh = strip(fs.readFileSync(new URL('../src/proxy/sshGateway.js', import.meta.url), 'utf8'));
  assert.ok(/user\.mustEnrollOtp/.test(ssh),
    'sshGateway: OTP 등록 전 세션 차단이 빠졌습니다 — WS 는 requireEnrolled 미들웨어를 타지 않으므로 여기서 직접 막아야 합니다');
  assert.ok(/userHasPermission\(user, 'remote\.access'\)/.test(ssh), 'sshGateway: remote.access 권한 검사가 빠졌습니다');
  for (const f of ['../src/proxy/sshGateway.js', '../src/proxy/guacdTunnel.js']) {
    const src = strip(fs.readFileSync(new URL(f, import.meta.url), 'utf8'));
    assert.ok(/const deny = remoteUserIssue\(user\);/.test(src), `${f}: 업그레이드가 공용 판정(remoteUserIssue)을 거치지 않습니다`);
  }
});

test('S3: 미인증 /auth/config 응답에 settingsOwners 가 없어야 함(계정 열거 방지)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/routes/auth.js', import.meta.url), 'utf8');
  const cfg = src.slice(src.indexOf("authRouter.get('/config'"), src.indexOf("authRouter.post('/login'"));
  assert.ok(!/settingsOwners:/.test(cfg), '미인증 config 응답에 소유 계정명 목록을 실으면 안 됩니다');
  assert.ok(/isSettingsOwner/.test(src), '인증 후 응답에는 isSettingsOwner 불리언이 있어야 합니다');
});
