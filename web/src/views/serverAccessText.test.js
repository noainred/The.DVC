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

describe('3회차 F2 — 정지 사유', () => {
  it('비밀번호를 보낸 뒤 판정 시한이 연달아 건 정지는 ‘거부’ 로 말하지 않는다', () => {
    expect(accountStopText({ current: true, cause: 'timeout' }).label).toBe('로그인 판정 시한 연달음 — 정지 중');
    expect(accountStopText({ current: true }).label).toBe('로그인 거부 — 정지 중');
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
    // 2회차 W2-4: OTP 는 동작마다 비운다 — need-verify(OTP 앞 판정 · OTP 를 쓰지 않음)만 남긴다
    expect((src.match(/finally \{ setBusy\(''\); if \(!keepOtp\) setOtp\(''\); \}/g) || []).length).toBe(2);
    expect((src.match(/keepOtp = true;/g) || []).length).toBe(2);
    expect(src).not.toMatch(/keepOtp = true[^\n]*\n[^\n]*\n[^\n]*code !== 'need-verify'/);
    expect(src).not.toMatch(/<select\b/);
    expect(src).not.toMatch(/text-transform/);
  });
  it('점검 1회차 W1 · S2 — 공통 계정 기능 0개는 저장 단추를 막는다(키 폼과 같이) · 지우기에도 확인할 서버를 고른다', () => {
    expect(src).toMatch(/!featuresChosen\(form\.features\) \|\| !!busy\} onClick=\{save\}/);
    expect(src).toMatch(/na\.state === 'set' && verifyFor === 'clear' && verifyCands && verifyCands\.length > 0/);
    // 2회차 W2-1: 확인 대상을 화면이 지어내지 않는다 — 지정 폼은 서버 후보만 · 승인 막대는 고른 서버만
    expect(src).toMatch(/const verifyChoices = verifyFor === 'assign' && verifyCands \? verifyCands : \[\];/);
    expect(src).toMatch(/const approveChoices = verifyFor === 'approve' && verifyCands \? verifyCands : pickedList\.map/);
    expect(src).not.toMatch(/inheritApproved && !s\.ownCred\)\.map\(\(s\) => \(\{ id: s\.id, name: s\.name \}\)\)/);
    // 3회차 R3-W2 · W3: 확인 서버 · 후보는 받은 흐름(지정 · 지우기 · 승인) 하나에만 — 취소 · 성공 · 노드 바꾸기에 지운다
    expect(src).toMatch(/const vidFor = \(flow\) => \(verifyFor === flow \? verifyId : ''\);/);
    expect(src).toMatch(/verifyServerId: vidFor\(clear \? 'clear' : 'assign'\)/);
    expect(src).toMatch(/verifyServerId: vidFor\('approve'\)/);
    expect(src).not.toMatch(/verifyServerId: verifyId/);
    expect((src.match(/clearVerify\(\)/g) || []).length).toBeGreaterThanOrEqual(5);
    // 3회차 R3-W5: 공통 계정 폼의 확인 목록도 서버 후보만
    expect(src).not.toMatch(/form\.cands \|\| usersOfForm/);
    // 4회차 R4-W3: 승인 막대에서 고르면 다른 흐름의 후보를 비운다 · R4-W4 정지 칩에 설명(title)
    expect(src).toMatch(/if \(verifyFor !== 'approve'\) setVerifyCands\(null\);/);
    expect(src).toMatch(/<Chip tone=\{curStop\.tone\} title=\{curStop\.title\}>/);
    expect(src).toMatch(/<Chip tone=\{stp\.tone\} title=\{stp\.title\}>/);
    // 4회차 R4-W2: 변경 기록의 계정 정지 · 풀기 사건은 서버 사유(detail)를 함께
    const settings = fs.readFileSync(path.join(HERE, 'SshAccessSettings.jsx'), 'utf8');
    expect(settings).toMatch(/e\.kind === 'account-stopped' \|\| e\.kind === 'account-resumed'\) && e\.detail/);
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
