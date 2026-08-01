import test from 'node:test';
import assert from 'node:assert/strict';
import { scopedVcenterIds, inUserScope } from '../src/auth/scope.js';

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
  for (const f of ['../src/proxy/sshGateway.js', '../src/proxy/guacdTunnel.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(/user\.mustEnrollOtp/.test(src),
      `${f}: OTP 등록 전 세션 차단이 빠졌습니다 — WS 는 requireEnrolled 미들웨어를 타지 않으므로 여기서 직접 막아야 합니다`);
    assert.ok(/userHasPermission\(user, 'remote\.access'\)/.test(src),
      `${f}: remote.access 권한 검사가 빠졌습니다`);
  }
});

test('S3: 미인증 /auth/config 응답에 settingsOwners 가 없어야 함(계정 열거 방지)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/routes/auth.js', import.meta.url), 'utf8');
  const cfg = src.slice(src.indexOf("authRouter.get('/config'"), src.indexOf("authRouter.post('/login'"));
  assert.ok(!/settingsOwners:/.test(cfg), '미인증 config 응답에 소유 계정명 목록을 실으면 안 됩니다');
  assert.ok(/isSettingsOwner/.test(src), '인증 후 응답에는 isSettingsOwner 불리언이 있어야 합니다');
});
