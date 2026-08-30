import { describe, it, expect } from 'vitest';
import { describePermission, buildRequestText, permName, roleName } from './accessDeniedText.js';

// 권한 거부(403) 안내 문구 — 사용자에게 실제로 보이는 내용이라 회귀로 고정한다.
// 목적: 403 을 '장애'가 아니라 '의도된 접근 제어'로 전달하고, 관리자에게 무엇을 요청해야 하는지
// 정확히 알려주는 것. 문구가 비거나 잘못된 권한을 지목하면 사용자가 엉뚱한 요청을 하게 된다.

describe('describePermission — 판정 우선순위', () => {
  it('설정 소유(owner)는 admin 보다 상위 경계라 가장 먼저 판정한다', () => {
    // requiredOwner 와 requiredRole 이 함께 와도 owner 안내가 나와야 한다 — admin 이면서
    // 소유자가 아닌 사용자에게 '역할을 admin 으로 바꾸세요'라고 하면 잘못된 안내다.
    const d = describePermission({ requiredOwner: true, requiredRole: ['admin'] });
    expect(d.kind).toBe('owner');
    expect(d.need).toContain('설정 소유');
    expect(d.how).toContain('로그인 ID');   // v2.395 부터 표시이름이 아니라 로그인 ID 로 등재해야 한다
  });

  it('역할 요구는 사람이 읽는 이름으로 나열한다', () => {
    const d = describePermission({ requiredRole: ['admin', 'operator'] });
    expect(d.kind).toBe('role');
    expect(d.need).toBe('관리자(admin) 또는 운영자(operator) 역할');
  });

  it('기능 권한 요구는 권한 키를 사람 이름으로 바꿔 보여준다', () => {
    const d = describePermission({ requiredPerm: ['vm.console'] });
    expect(d.kind).toBe('perm');
    expect(d.need).toBe('VM 콘솔 열기 권한');
    expect(d.how).toContain('기능 권한 매트릭스');
  });

  it('메타데이터 없는 403 은 데이터 범위(scope) 제한으로 안내한다', () => {
    // 서버가 `{ok:false, reason}` 만 주는 경로(범위 밖 vCenter 등) — 추측하지 않고 범위로 안내.
    for (const info of [null, undefined, {}, { requiredRole: [] }, { requiredPerm: [] }]) {
      expect(describePermission(info).kind).toBe('scope');
    }
  });

  it('모든 분기가 빈 문구를 내지 않는다(화면이 비면 사용자는 장애로 오해한다)', () => {
    const cases = [
      { requiredOwner: true }, { requiredRole: ['viewer'] }, { requiredPerm: ['tools'] }, null,
    ];
    for (const info of cases) {
      const d = describePermission(info);
      expect(d.need.length).toBeGreaterThan(0);
      expect(d.how.length).toBeGreaterThan(0);
    }
  });
});

describe('라벨 매핑 — 모르는 키는 원문을 그대로(추측 금지)', () => {
  it('알려진 키는 한국어 이름으로', () => {
    expect(permName('remote.access')).toBe('원격 접속(RDP/SSH)');
    expect(roleName('viewer')).toBe('조회자(viewer)');
  });
  it('모르는 키·역할은 원문 유지 — 없는 권한 이름을 만들어 보여주면 안 된다', () => {
    expect(permName('some.new.perm')).toBe('some.new.perm');
    expect(roleName('auditor')).toBe('auditor');
  });
});

describe('buildRequestText — 관리자에게 전달할 요청 문구', () => {
  it('계정·필요권한·조치를 담아 왕복을 줄인다', () => {
    const t = buildRequestText({
      user: { username: 'kim', role: 'operator' },
      info: { requiredPerm: ['vm.console'], path: '/vms/vm-1/console' },
      reason: '권한이 없습니다.',
    });
    expect(t).toContain('[포탈 권한 요청]');
    expect(t).toContain('계정: kim / 현재 역할: 운영자(operator)');
    expect(t).toContain('필요: VM 콘솔 열기 권한');
    expect(t).toContain('요청 경로: /vms/vm-1/console');
    expect(t).toContain('서버 사유: 권한이 없습니다.');
  });

  it('사용자 정보가 없어도 문구가 깨지지 않는다(로그인 직후·부트스트랩)', () => {
    const t = buildRequestText({});
    expect(t).toContain('계정: (알 수 없음)');
    expect(t.split('\n').length).toBeGreaterThanOrEqual(4);
  });

  it('경로·사유가 없으면 그 줄을 넣지 않는다(빈 라벨 방지)', () => {
    const t = buildRequestText({ user: { username: 'a' }, info: { requiredOwner: true } });
    expect(t).not.toContain('요청 경로:');
    expect(t).not.toContain('서버 사유:');
  });
});
