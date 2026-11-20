import { describe, it, expect } from 'vitest';
import { accountKindText, buildHierTree, nodeAccount, serverSourceText, accountStopText, passwordAgeText, assignableAccounts, serversOfNode, loginNamePreview, assignOf, rotateByInput } from './serverAccessText.js';

const accounts = [
  { id: 'a_000000000001', name: 'kr-linux', corp: 'vcA', os: 'linux', family: 'linux' },
  { id: 'a_000000000002', name: 'kr-ad', corp: 'vcA', os: 'windows', logon: 'ad', family: 'windows' },
  { id: 'a_000000000003', name: 'any-old', corp: '', os: '' },
  { id: 'a_000000000004', name: 'pl-linux', corp: 'vcB', os: 'linux' },
];
const accById = new Map(accounts.map((a) => [a.id, a]));

describe('서버 접속 — 계층 지정 화면 도우미(v3.24)', () => {
  it('계정 종류 글자 — 예전 계정은 Linux', () => {
    expect(accountKindText(accounts[0])).toBe('Linux');
    expect(accountKindText(accounts[1])).toBe('Windows AD');
    expect(accountKindText({ os: 'windows', logon: 'local' })).toBe('Windows 로컬');
    expect(accountKindText(accounts[2])).toBe('Linux');
    expect(accountKindText(null)).toBe('—');
  });
  it('노드 계정 — OS 단계가 이기고 · 법인 단계는 계열이 같을 때만 · 못 읽으면 unknown(없음과 다르다)', () => {
    const assign = [{ corp: 'vcA', level: 'all', account: 'a_000000000001', auth: '' }, { corp: 'vcA', level: 'windows', account: 'a_000000000002', auth: 'password' }];
    expect(nodeAccount({ corp: 'vcA' }, assign, accById).state).toBe('set');
    expect(nodeAccount({ corp: 'vcA', os: 'linux' }, assign, accById)).toMatchObject({ state: 'inherit', level: 'all' });
    expect(nodeAccount({ corp: 'vcA', os: 'windows' }, assign, accById)).toMatchObject({ state: 'set', level: 'windows' });
    expect(nodeAccount({ corp: 'vcA', os: 'none' }, assign, accById)).toMatchObject({ state: 'inherit', level: 'all' });
    // 법인 단계가 Windows 계정이면 Linux · 미지정 노드에는 닿지 않는다
    const winAll = [{ corp: 'vcA', level: 'all', account: 'a_000000000002' }];
    expect(nodeAccount({ corp: 'vcA', os: 'linux' }, winAll, accById)).toMatchObject({ state: 'empty', blockedByOs: true });
    expect(nodeAccount({ corp: 'vcA', os: 'none' }, winAll, accById).state).toBe('empty');
    expect(nodeAccount({ corp: 'vcA', os: 'windows' }, winAll, accById).state).toBe('inherit');
    expect(nodeAccount({ corp: 'vcA' }, null, accById).state).toBe('unknown');
    expect(assignOf(null, 'vcA', 'all')).toBeUndefined();
    expect(assignOf([], 'vcA', 'all')).toBeNull();
  });
  it('트리 — 법인마다 Linux · Windows · OS 미지정 노드 · 잎은 앞 N대 + 더', () => {
    const servers = Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, name: `kr-${i}`, vcenterId: 'vcA', os: i < 6 ? 'linux' : '' }));
    const tree = buildHierTree({ corps: [{ id: 'vcA' }], servers, assign: [], accounts }, { maxLeaves: 5 });
    expect(tree.map((n) => n.id)).toEqual(['corp:vcA', 'os:vcA:linux', 'os:vcA:windows', 'os:vcA:none']);
    const lin = tree.find((n) => n.id === 'os:vcA:linux');
    expect(lin.count).toBe(6); expect(lin.leaves).toHaveLength(5); expect(lin.more).toBe(1);
    expect(tree.find((n) => n.id === 'os:vcA:none').count).toBe(1);
    expect(tree[0].state).toBe('empty');
    expect(buildHierTree({ corps: [{ id: 'vcA' }], servers, assign: null, accounts })[0].state).toBe('unknown');
  });
  it('서버 출처 글자 — 따로 정함 · 물려받음 · 승인 대기(주소 바뀜 포함) · OS 다름 · 미설정 · 엣지', () => {
    expect(serverSourceText({ source: 'own' }).label).toBe('따로 정함');
    expect(serverSourceText({ source: 'os' }).label).toBe('OS 종류에서 물려받음');
    expect(serverSourceText({ source: 'corp' }).label).toBe('법인에서 물려받음');
    expect(serverSourceText({ source: 'none', pending: true }).label).toBe('승인 대기');
    expect(serverSourceText({ source: 'none', pending: true, inheritStale: true }).label).toContain('바뀜');
    expect(serverSourceText({ source: 'none', mismatch: true }).label).toBe('법인 계정 OS 다름');
    expect(serverSourceText({ source: 'none' })).toMatchObject({ label: '미설정', tone: 'bad' });
    expect(serverSourceText({ source: 'own', agent: 'edge-kr' }).label).toBe('엣지에서 정함');
  });
  it('정지 · 비밀번호 나이 — 모르는 값은 0 이 아니다', () => {
    expect(accountStopText(null)).toBeNull();
    expect(accountStopText({ current: true }).tone).toBe('bad');
    expect(accountStopText({ current: false }).tone).toBe('muted');
    expect(accountStopText({ unreadable: true }).label).toContain('모름');
    expect(passwordAgeText({ hasPassword: false })).toBe('저장하지 않음');
    expect(passwordAgeText({ hasPassword: true, pwAgeDays: null })).toBe('등록 시각 모름');
    expect(passwordAgeText({ hasPassword: true, pwAgeDays: 0 })).toBe('0일 전 등록');
    expect(passwordAgeText({ hasPassword: true, pwAgeDays: 88, rotateDue: true })).toContain('지났습니다');
    const now = Date.UTC(2026, 10, 1);
    expect(passwordAgeText({ hasPassword: true, pwAgeDays: 3, rotateBy: now + 5 * 86_400_000 }, now)).toBe('3일 전 등록 · 교체 예정 5일 뒤');
  });
  it('지정할 수 있는 계정 · 노드 서버 · 로그인 이름 미리 보기', () => {
    expect(assignableAccounts(accounts, 'vcA', 'windows').map((a) => a.name)).toEqual(['kr-ad']);
    expect(assignableAccounts(accounts, 'vcA', 'linux').map((a) => a.name)).toEqual(['kr-linux', 'any-old']);
    expect(assignableAccounts(accounts, 'vcA', 'all').map((a) => a.name)).toEqual(['kr-linux', 'kr-ad', 'any-old']);
    const servers = [{ id: '1', vcenterId: 'vcA', os: 'linux' }, { id: '2', vcenterId: 'vcA' }, { id: '3', vcenterId: 'vcB', os: 'linux' }];
    expect(serversOfNode(servers, { kind: 'corp', corp: 'vcA' }).map((s) => s.id)).toEqual(['1', '2']);
    expect(serversOfNode(servers, { kind: 'os', corp: 'vcA', os: 'none' }).map((s) => s.id)).toEqual(['2']);
    expect(loginNamePreview({ os: 'windows', logon: 'ad', domain: 'corp.example', username: 'svc' })).toBe('svc@corp.example');
    expect(loginNamePreview({ os: 'windows', logon: 'ad', domain: 'corp', username: 'svc' })).toBe('CORP\\svc');
    expect(loginNamePreview({ os: 'linux', username: 'root' })).toBe('root');
  });
});

describe('서버 접속 — 계정 계층 · 공통 계정 화면 규약(소스)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(HERE, 'ServerAccessHier.jsx'), 'utf8');
  it('쓰기는 전부 must() 로 감싼다(ok:false 를 성공으로 그리지 않게 — E-H1) · DELETE 의 OTP 는 쿼리로', () => {
    const calls = [...src.matchAll(/await (postJson|putJson|delJson)\(/g)].length;
    const wrapped = [...src.matchAll(/must\(await (postJson|putJson|delJson)\(/g)].length;
    expect(calls).toBeGreaterThan(5);
    expect(wrapped).toBe(calls);
    for (const m of src.matchAll(/delJson\(`([^`]*)`/g)) expect(m[1]).toMatch(/\?otp=\$\{encodeURIComponent\(code\)\}/);
  });
  it('비밀번호는 보내기만 — 응답에서 비밀번호를 그리지 않는다 · OTP 는 동작마다 비운다 · 날 select 금지', () => {
    expect(src).not.toMatch(/r\.account\.password|\ba\.password\b|resp\.password|stop\.password/);
    expect(src).toMatch(/finally \{ setBusy\(''\); setOtp\(''\); \}/);
    expect(src).not.toMatch(/<select\b/);
    expect(src).not.toMatch(/text-transform/);
  });
  it('공용 조각을 쓴다(두 벌 금지) — must · Chip · Otp · FeaturePicker 는 sshAccessParts.jsx', () => {
    expect(src).toMatch(/from '\.\/sshAccessParts\.jsx'/);
    expect(src).not.toMatch(/^function must\(|^const Chip =|^const Otp =|^function FeaturePicker\(/m);
  });

  it('교체 예정일 입력값 — 서버가 UTC 자정으로 저장한 날짜를 같은 달력 날짜로(시간대와 무관) · 못 읽으면 빈 값', () => {
    expect(rotateByInput(Date.parse('2026-11-10T00:00:00Z'))).toBe('2026-11-10');
    expect(rotateByInput(null)).toBe(''); expect(rotateByInput('x')).toBe(''); expect(rotateByInput(0)).toBe('');
  });
});
