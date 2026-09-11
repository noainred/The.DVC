// v2.485 — 호스트 접근 제어: 설정 정규화·CIDR 판정·--list-all 파싱·적용 계획(diff)·commit-confirm 상태 기계(가짜 실행기).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostaccess-'));
process.env.CONFIG_DIR = tmp;
process.env.PORT = '4000';
const R = await import('../src/hostaccess/render.js');
const S = await import('../src/hostaccess/service.js');
const St = await import('../src/hostaccess/settings.js');

const LIST_ALL = `public (active)
  target: default
  icmp-block-inversion: no
  interfaces: ens192
  sources:
  services: cockpit dhcpv6-client ssh
  ports: 4000/tcp 22/tcp
  protocols:
  forward: yes
  masquerade: no
  forward-ports:
  source-ports:
  icmp-blocks:
  rich rules:
\trule family="ipv4" source address="10.9.9.9" service name="ssh" accept
\trule family="ipv4" source address="172.16.0.0/12" port port="8443" protocol="tcp" accept
`;

test('CIDR 파싱·포함 판정(IPv4/IPv6)', () => {
  assert.equal(R.parseCidr('10.0.0.0/8').text, '10.0.0.0/8');
  assert.equal(R.parseCidr('10.0.0.5').text, '10.0.0.5');
  assert.equal(R.parseCidr('10.0.0.0/33'), null);
  assert.equal(R.parseCidr('abc'), null);
  assert.equal(R.ipInCidr('10.1.2.3', '10.0.0.0/8'), true);
  assert.equal(R.ipInCidr('11.1.2.3', '10.0.0.0/8'), false);
  assert.equal(R.ipInCidr('10.1.2.3', '10.1.2.3'), true);
  assert.equal(R.ipInCidr('2001:db8::1', '2001:db8::/32'), true);
  assert.equal(R.ipInCidr('2001:db9::1', '2001:db8::/32'), false);
  assert.equal(R.ipInCidr('10.1.2.3', '2001:db8::/32'), false, '패밀리 불일치');
});

test('설정 정규화 — 포탈 포트 항상 포함, 잘못된 주소는 오류, 웹 허용목록 비면 오류', () => {
  const { settings, errors } = R.normalizeSettings({ ssh: { mode: 'allowlist', allow: '10.0.0.0/8, bad' }, web: { mode: 'allowlist', allow: [], ports: ['443', '70000'] }, firewall: { extra: [{ port: '5000-5010', proto: 'udp', action: 'drop', sources: ['192.168.1.0/24'] }, { port: 'x' }] }, confirmMinutes: 99 }, { portalPort: 4000 });
  assert.deepEqual(settings.web.ports, ['4000', '443']);
  assert.deepEqual(settings.ssh.allow, ['10.0.0.0/8']);
  assert.equal(settings.confirmMinutes, 30);
  assert.equal(settings.firewall.extra.length, 1);
  assert.ok(errors.some((e) => /SSH 허용 주소 형식 오류: bad/.test(e)));
  assert.ok(errors.some((e) => /웹 허용목록 모드인데 허용 주소가 없습니다/.test(e)));
  assert.ok(errors.some((e) => /추가 규칙 #2: 포트 형식 오류/.test(e)));
  // 차단 모드가 아니면 sshd 중지는 무시
  assert.equal(R.normalizeSettings({ ssh: { mode: 'open', stopService: true } }).settings.ssh.stopService, false);
});

test('--list-all 파싱', () => {
  const c = R.parseListAll(LIST_ALL);
  assert.equal(c.zone, 'public'); assert.equal(c.active, true); assert.equal(c.target, 'default');
  assert.deepEqual(c.interfaces, ['ens192']); assert.deepEqual(c.services, ['cockpit', 'dhcpv6-client', 'ssh']);
  assert.deepEqual(c.ports, ['4000/tcp', '22/tcp']); assert.equal(c.richRules.length, 2);
});

test('계획 — SSH 허용목록: ssh 서비스·22/tcp 제거 + 관리 대상 rich rule 교체, 비관리 규칙은 보존', () => {
  const cur = R.parseListAll(LIST_ALL);
  const { settings } = R.normalizeSettings({ ssh: { mode: 'allowlist', allow: ['10.0.0.0/8'] }, web: { mode: 'open' } }, { portalPort: 4000 });
  const p = R.planCommands(settings, cur, { requesterIp: '10.1.1.1' });
  assert.deepEqual(p.errors, []);
  const flat = p.commands.map((c) => c.join(' '));
  assert.ok(flat.includes('--zone=public --remove-service=ssh'));
  assert.ok(flat.includes('--zone=public --remove-port=22/tcp'));
  assert.ok(flat.includes('--zone=public --remove-rich-rule=rule family="ipv4" source address="10.9.9.9" service name="ssh" accept'), '옛 ssh 허용 규칙 제거');
  assert.ok(flat.includes('--zone=public --add-rich-rule=rule family="ipv4" source address="10.0.0.0/8" service name="ssh" accept'));
  assert.ok(!flat.some((x) => x.includes('8443')), '포탈이 관리하지 않는 8443 규칙은 건드리지 않는다');
  assert.ok(p.warnings.some((w) => /22\/tcp/.test(w)));
});

test('계획 — 웹 허용목록: 요청자 IP 미포함이면 오류(자기 잠금 방지), 포함이면 포트 제거 + rich rule', () => {
  const cur = R.parseListAll(LIST_ALL);
  const { settings } = R.normalizeSettings({ web: { mode: 'allowlist', allow: ['192.168.0.0/16'] } }, { portalPort: 4000 });
  const bad = R.planCommands(settings, cur, { requesterIp: '10.1.1.1' });
  assert.ok(bad.errors.some((e) => /요청자 IP 10.1.1.1 가 웹 허용목록에 없습니다/.test(e)));
  const good = R.planCommands(settings, cur, { requesterIp: '192.168.5.5' });
  assert.deepEqual(good.errors, []);
  const flat = good.commands.map((c) => c.join(' '));
  assert.ok(flat.includes('--zone=public --remove-port=4000/tcp'));
  assert.ok(flat.includes('--zone=public --add-rich-rule=rule family="ipv4" source address="192.168.0.0/16" port port="4000" protocol="tcp" accept'));
  // 요청자 IP 를 모르면 오류
  assert.ok(R.planCommands(settings, cur, { requesterIp: '' }).errors.length > 0);
});

test('계획 — 존 target ACCEPT 면 오류, 추가 규칙이 포탈 포트를 전체 drop 하면 오류, 바뀔 게 없으면 명령 0', () => {
  const cur = R.parseListAll(LIST_ALL.replace('target: default', 'target: ACCEPT'));
  const { settings } = R.normalizeSettings({ ssh: { mode: 'deny' } }, { portalPort: 4000 });
  assert.ok(R.planCommands(settings, cur, { requesterIp: '10.1.1.1' }).errors.some((e) => /ACCEPT/.test(e)));
  const cur2 = R.parseListAll(LIST_ALL);
  const s2 = R.normalizeSettings({ firewall: { extra: [{ port: '4000', proto: 'tcp', action: 'drop' }] } }, { portalPort: 4000 }).settings;
  assert.ok(R.planCommands(s2, cur2, { requesterIp: '10.1.1.1' }).errors.some((e) => /포탈이 잠깁니다/.test(e)));
  // 열림+열림, 기존 ssh 허용 rich rule 은 관리 대상이라 제거됨 → 명령 1개. 그 규칙이 없다면 0개.
  const s3 = R.normalizeSettings({}, { portalPort: 4000 }).settings;
  const cur3 = R.parseListAll(LIST_ALL.replace(/\trule family="ipv4" source address="10.9.9.9" service name="ssh" accept\n/, ''));
  assert.equal(R.planCommands(s3, cur3, { requesterIp: '10.1.1.1' }).commands.length, 0);
});

// ── commit-confirm 상태 기계(가짜 실행기) ──
function fakeExec(state) {
  const calls = [];
  const fw = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === '--state') return { ok: state.sudo, code: state.sudo ? 0 : 1, stdout: state.sudo ? 'running\n' : '', stderr: state.sudo ? '' : 'sudo: a password is required\n' };
    if (args[0] === '--get-default-zone') return { ok: true, code: 0, stdout: 'public\n', stderr: '' };
    if (args.includes('--list-all')) return { ok: true, code: 0, stdout: state.listAll, stderr: '' };
    if (args[0] === '--reload') { state.reloads++; return { ok: true, code: 0, stdout: 'success', stderr: '' }; }
    if (args[0] === '--runtime-to-permanent') { state.perm++; return { ok: true, code: 0, stdout: 'success', stderr: '' }; }
    return { ok: !state.failNext, code: state.failNext ? 1 : 0, stdout: 'success', stderr: state.failNext ? 'Error: boom' : '' };
  };
  return { calls, fw, sshdCtl: async (verb) => { calls.push(`sshd ${verb}`); return { ok: true, code: 0, stdout: '', stderr: '' }; }, sshdActive: async () => true, isSudoDenied: (r) => /password is required/.test(r.stderr || '') };
}

test('service — sudo 거부면 엔진 불가 + sudoers 안내', async () => {
  const st = { sudo: false, listAll: LIST_ALL, reloads: 0, perm: 0 };
  S._setExec(fakeExec(st));
  const s = await S.hostAccessStatus({ requesterIp: '10.1.1.1' });
  assert.equal(s.engine.ok, false); assert.equal(s.engine.reason, 'sudo-denied'); assert.match(s.engine.hint, /firewall-cmd/);
  const p = await S.planHostAccess({}, { requesterIp: '10.1.1.1' });
  assert.equal(p.ok, false);
});

test('service — 적용(런타임)→pending, 확정→runtime-to-permanent + sshd 중지, 되돌림→reload', async () => {
  St._resetHostAccessCache();
  const st = { sudo: true, listAll: LIST_ALL, reloads: 0, perm: 0 };
  const ex = fakeExec(st); S._setExec(ex);
  const input = { ssh: { mode: 'deny', stopService: true }, web: { mode: 'open' }, confirmMinutes: 5 };
  const a = await S.applyHostAccess(input, { requesterIp: '10.1.1.1', by: 'admin' });
  assert.equal(a.ok, true, JSON.stringify(a.errors));
  assert.ok(a.commands.length >= 2);
  assert.ok(ex.calls.includes('--zone=public --remove-service=ssh'));
  assert.ok(!ex.calls.some((c) => /^sshd/.test(c)), 'sshd 중지는 런타임 적용 단계에서 실행하지 않는다');
  let cur = St.loadHostAccess();
  assert.ok(cur.pending && cur.pending.deadline > Date.now());
  // 대기 중 재적용은 거부
  assert.equal((await S.applyHostAccess(input, { requesterIp: '10.1.1.1' })).ok, false);
  const c = await S.confirmHostAccess({ by: 'admin' });
  assert.equal(c.ok, true, JSON.stringify(c.errors));
  assert.equal(st.perm, 1);
  assert.ok(ex.calls.includes('sshd stop') && ex.calls.includes('sshd disable'));
  cur = St.loadHostAccess();
  assert.equal(cur.pending, null); assert.equal(cur.applied.sshdStopped, true); assert.equal(cur.applied.by, 'admin');
  // 모드를 열림으로 바꿔 적용·확정하면 sshd 재개
  const a2 = await S.applyHostAccess({ ssh: { mode: 'open' } }, { requesterIp: '10.1.1.1', by: 'admin' });
  assert.equal(a2.ok, true, JSON.stringify(a2.errors));
  const c2 = await S.confirmHostAccess({ by: 'admin' });
  assert.equal(c2.ok, true);
  assert.ok(ex.calls.includes('sshd enable') && ex.calls.includes('sshd start'));
  assert.equal(St.loadHostAccess().applied.sshdStopped, false);
  // 되돌림
  const a3 = await S.applyHostAccess({ ssh: { mode: 'deny' } }, { requesterIp: '10.1.1.1', by: 'admin' });
  assert.equal(a3.ok, true);
  const r = await S.revertHostAccess({ by: 'admin' });
  assert.equal(r.ok, true); assert.equal(r.hadPending, true); assert.equal(st.reloads, 1);
  assert.equal(St.loadHostAccess().pending, null);
  // 확정 대기 없음
  assert.equal((await S.confirmHostAccess({ by: 'admin' })).ok, false);
});

test('service — 중간 명령 실패 시 --reload 로 반쯤 적용된 상태를 남기지 않는다', async () => {
  St._resetHostAccessCache();
  const st = { sudo: true, listAll: LIST_ALL, reloads: 0, perm: 0, failNext: true };
  S._setExec(fakeExec(st));
  const a = await S.applyHostAccess({ ssh: { mode: 'deny' } }, { requesterIp: '10.1.1.1', by: 'admin' });
  assert.equal(a.ok, false);
  assert.equal(st.reloads, 1);
  assert.equal(St.loadHostAccess().pending, null);
});

test('service — 기동 시 기한 지난 pending 은 즉시 되돌린다', async () => {
  St._resetHostAccessCache();
  const st = { sudo: true, listAll: LIST_ALL, reloads: 0, perm: 0 };
  S._setExec(fakeExec(st));
  St.saveHostAccess({ pending: { at: Date.now() - 600_000, deadline: Date.now() - 1, by: 'x', fingerprint: '', rich: [] } });
  await S.resumeHostAccessPending();
  assert.equal(st.reloads, 1);
  assert.equal(St.loadHostAccess().pending, null);
});
