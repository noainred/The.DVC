/**
 * v3.25 서버 접속 2단계 — 기능 ‘서버 정보’(설계 docs/design/server-access §4.5 · ⑦ Reads · D3 기본 구성 + 디스크 · D5 sudo 없음).
 * 읽기 묶음(상수 · 안쪽 시한 산수 · cmd 한도) · 해석(못 읽음 · 권한 · 잘림 · 표지 위조) · 코어 readServer(실제 등록부 · 실제 keyStore · 가짜 sshd —
 * 시도 수를 센다) · 실제 라우터(관리자 + 전체 범위 · 데모 계정은 데모 서버만) · 보관 파일 손상 보존.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'srvinfo325-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.SSH_HOSTKEY_POLICY = 'observe';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '../src');

const VAULT = await import('../src/security/secretVault.js');
VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
const ssh2 = (await import('ssh2')).default;
const P = await import('../src/serverinfo/profiles.js');
const KS = await import('../src/bmusage/onboard/keyStore.js');
const BM = await import('../src/bmstor/registry.js');
const ST = await import('../src/sshaccess/state.js');
const RS = await import('../src/sshaccess/readServer.js');
const SVC = await import('../src/serverinfo/service.js');
const SI = await import('../src/serverinfo/store.js');
const { store } = await import('../src/store.js');
store.snapshot = { ...store.get(), vcenters: [{ id: 'vcA', name: 'KR-SEL' }] };

/* ── 고정 출력(그림용 가상값) ── */
const LINUX_OUT = [
  '##OSREL', 'ID="rocky"', 'VERSION_ID="9.4"', 'PRETTY_NAME="Rocky Linux 9.4 (Blue Onyx)"',
  '##KERNEL', 'Linux 5.14.0-427.13.1.el9_4.x86_64',
  '##HOST', 'kr-db-01.corp.example',
  '##DMI', 'sys_vendor=가상제조', 'product_name=가상 서버 GX-650', 'product_serial=!perm', 'board_vendor=가상제조', 'bios_vendor=가상', 'bios_version=2.19.1',
  '##CPU', 'Architecture:                    x86_64', 'CPU(s):                          128', 'Model name:                      가상 CPU 32C', 'Thread(s) per core:              2', 'Core(s) per socket:              32', 'Socket(s):                       2',
  '##MEM', 'MemTotal:       527937844 kB', 'SwapTotal:        8388604 kB',
  '##DISKS', 'NAME="sda" TYPE="disk" MODEL="가상 SSD-480" SERIAL="S1" WWN="0x5000c500a1b2c3d4" SIZE="480103981056" ROTA="0" TRAN="sas"',
  'NAME="nvme0n1" TYPE="disk" MODEL="가상 NV-1920" SERIAL="N1" WWN="" SIZE="1920383410176" ROTA="0" TRAN="nvme"',
  'NAME="sr0" TYPE="rom" MODEL="DVD" SERIAL="" WWN="" SIZE="1073741312" ROTA="1" TRAN="sata"',
  '##FS', 'Filesystem     Type 1024-blocks      Used Available Capacity Mounted on',
  '/dev/mapper/rl-root xfs     73364480  30089216  43275264      42% /', '/dev/sdb1      xfs   3758096384 2367100928 1390995456      63% /data project',
  '##END',
].join('\n');

/* ── 가짜 sshd — 비밀번호 로그인 · 고정 출력 · 시도 수 ── */
async function fakeSshd() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  // methods: 서버가 받는 인증 방식(SSSD/AD 처럼 keyboard-interactive 를 켠 서버 흉내) · hang: 명령 출력을 앞 구획까지만 쓰고 끝내지 않음(exec 시한 시험)
  const st = { passwords: {}, seen: [], cmds: [], methods: ['password'], hang: false };
  const srv = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && st.methods.includes('password')) {
        st.seen.push(ctx.password);
        if (st.passwords[ctx.username] === ctx.password) return ctx.accept();
      } else if (ctx.method === 'keyboard-interactive' && st.methods.includes('keyboard-interactive')) {
        return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) => { st.seen.push(answers[0]); return st.passwords[ctx.username] === answers[0] ? ctx.accept() : ctx.reject(st.methods); });
      }
      return ctx.reject(st.methods);
    });
    client.on('ready', () => client.on('session', (accept) => {
      const s = accept();
      s.on('exec', (acc, _rej, info) => {
        st.cmds.push(info.command); const stream = acc();
        if (st.hang) { stream.write(LINUX_OUT.split('##DISKS')[0]); return; }   // 끝내지 않는다
        stream.write(info.command.startsWith('export LC_ALL=C') ? LINUX_OUT : 'ok\n'); stream.exit(0); stream.end();
      });
    }));
    client.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, st, close: () => srv.close() };
}
const SSHD = await fakeSshd();
test.after(() => SSHD.close());
const srv = (body) => { const r = BM.saveBmServer({ host: '127.0.0.1', port: SSHD.port, mounts: ['/'], ...body }); assert.equal(r.ok, true, r.reason); return BM.listBmServersRaw().find((x) => x.id === r.server.id); };
const addrOf = (s) => `${String(s.host).toLowerCase()}:${Number(s.port) || 22}|${String(s.username || 'root').toLowerCase()}`;

// ⚠ 시험은 모듈 맨 위의 await(가짜 sshd)가 다 끝난 뒤에 등록한다 — 먼저 등록한 시험이 혼자 끝나면 러너가 test.after(설정 폴더 지우기)를 먼저 돌린다(반증 F17).
test('① 읽기 묶음 — 명령은 상수 · sudo 없음 · 안쪽 시한 합 + 여유 ≤ exec 시한 · Windows 한 줄은 cmd 한도 안 · 계획은 OS 마다 하나', () => {
  assert.equal(/\bsudo\b/.test(P.LINUX_COMMAND), false); assert.equal(/\bsudo\b/.test(P.WIN_SCRIPT), false);
  const inner = Object.values(P.LINUX_INNER_TIMEOUTS_S);
  assert.ok(inner.every((x) => Number.isInteger(x) && x > 0));
  // 한 번에 도는 최악 합(hostname -f 실패 뒤 hostname · lsblk 탐침 + 둘 중 하나) + 여유 ≤ exec 시한
  const worst = P.LINUX_INNER_TIMEOUTS_S.hostname + P.LINUX_INNER_TIMEOUTS_S.hostnameShort + P.LINUX_INNER_TIMEOUTS_S.lscpu + P.LINUX_INNER_TIMEOUTS_S.lsblkProbe
    + Math.max(P.LINUX_INNER_TIMEOUTS_S.lsblk, P.LINUX_INNER_TIMEOUTS_S.lsblkFallback) + P.LINUX_INNER_TIMEOUTS_S.df;
  assert.equal(P.LINUX_INNER_WORST_S, worst);
  assert.ok((worst + P.LINUX_SLACK_S) * 1000 <= P.LINUX_EXEC_TIMEOUT_MS, `안쪽 시한 합 ${worst}s + 여유 ${P.LINUX_SLACK_S}s ≤ ${P.LINUX_EXEC_TIMEOUT_MS / 1000}s`);
  // 반증 F5: 바깥 프로그램(멈출 수 있는 것)은 **모두** timeout 으로 감싼다 — 맨몸 호출이 하나라도 있으면 실패
  for (const prog of ['hostname', 'lscpu', 'lsblk', 'df']) {
    const all = [...P.LINUX_COMMAND.matchAll(new RegExp(`(timeout \\d+ )?\\b${prog}\\b`, 'g'))].filter((m) => !/^echo|##/.test(m[0]));
    assert.ok(all.length > 0, prog);
    for (const m of all) assert.match(m[0], new RegExp(`^timeout \\d+ ${prog}$`), `${prog} 은 timeout 으로 감싼다: '${m[0]}'`);
  }
  // Windows: 조회마다 시한 · 조회 수 × 시한 + 여유 ≤ exec 시한 · 로그인 + 명령 < 장비 시한(두 OS 모두 — 세션 예산 < 장비 시한 · 반증 F14)
  assert.equal((P.WIN_SCRIPT.match(/-OperationTimeoutSec \$T/g) || []).length, P.WIN_QUERIES);
  assert.ok((P.WIN_QUERIES * P.WIN_QUERY_TIMEOUT_S + P.WIN_SLACK_S) * 1000 <= P.WIN_EXEC_TIMEOUT_MS);
  for (const ms of [P.LINUX_EXEC_TIMEOUT_MS, P.WIN_EXEC_TIMEOUT_MS]) assert.ok(RS.READ_LOGIN_TIMEOUT_MS + ms < RS.READ_DEADLINE_MS, `로그인 ${RS.READ_LOGIN_TIMEOUT_MS} + 명령 ${ms} < 장비 시한 ${RS.READ_DEADLINE_MS}`);
  assert.ok(P.WIN_COMMAND.length <= P.CMD_LINE_MAX, `Windows 명령 ${P.WIN_COMMAND.length}자 ≤ ${P.CMD_LINE_MAX}`);
  assert.equal(Buffer.from(P.WIN_COMMAND.split(' ').pop(), 'base64').toString('utf16le'), P.WIN_SCRIPT);
  // 표지 순서 = 해석 순서
  const marks = [...P.LINUX_COMMAND.matchAll(/echo '##([A-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(marks, [...P.LINUX_SECTIONS]);
  // 소스에 바깥 값이 들어갈 자리가 없다(템플릿 자리는 이 파일의 상수만)
  const src = fs.readFileSync(path.join(SRC, 'serverinfo/profiles.js'), 'utf8');
  const shell = src.slice(src.indexOf('const LINUX_SHELL = ['), src.indexOf('export const LINUX_COMMAND'));
  assert.ok(shell.length > 200);
  for (const m of shell.matchAll(/\$\{([^}]{1,80})\}/g)) assert.match(m[1], /^(DMI_FIELDS\.join\(' '\)|LINUX_INNER_TIMEOUTS_S\.\w+)$/, `명령 조각의 자리는 상수만: ${m[1]}`);
  const win = src.slice(src.indexOf('export const WIN_SCRIPT = ['), src.indexOf('export const WIN_EXEC_TIMEOUT_MS'));
  for (const m of win.matchAll(/\$\{([^}]{1,80})\}/g)) assert.equal(m[1], 'WIN_QUERY_TIMEOUT_S', `Windows 스크립트의 자리는 상수만: ${m[1]}`);
  assert.equal(P.SERVER_INFO_PLAN.linux.command, P.LINUX_COMMAND); assert.equal(P.SERVER_INFO_PLAN.windows.command, P.WIN_COMMAND);
});

test('② Linux 해석 — 값 · 권한 칸은 못 읽음(0 아님) · 디스크는 disk 만 · 공백 있는 마운트 · 잘림 · 표지 위조', () => {
  const p = P.parseLinux(LINUX_OUT);
  assert.equal(p.truncated, false);
  assert.equal(p.base.os.value, 'Rocky Linux 9.4 (Blue Onyx)');
  assert.deepEqual(p.base.serial, { value: null, missing: true, reason: 'permission' });
  assert.equal(p.base.cpuCores.value, 64); assert.equal(p.base.cpuThreads.value, 128); assert.equal(p.base.cpuSockets.value, 2);
  assert.equal(p.base.memBytes.value, 527937844 * 1024);
  assert.deepEqual(p.disks.map((d) => [d.dev, d.media, d.sizeBytes]), [['/dev/sda', 'SSD', 480103981056], ['/dev/nvme0n1', 'SSD', 1920383410176]]);
  assert.deepEqual(p.fs.map((f) => [f.mount, f.usePct]), [['/', 42], ['/data project', 63]]);
  // 끝 표지가 없으면 잘림 — 온 칸만, 오지 않은 구획은 null(빈 배열이 아니다)
  const cut = P.parseLinux(LINUX_OUT.split('##DISKS')[0]);
  assert.equal(cut.truncated, true); assert.equal(cut.disks, null); assert.equal(cut.fs, null); assert.equal(cut.base.os.value, 'Rocky Linux 9.4 (Blue Onyx)');
  // 비특권 사용자가 만든 이름이 표지처럼 보여도(앞 구획 다시 열기) 받지 않는다
  const forged = LINUX_OUT.replace('##FS\n', '##FS\n##MEM\nMemTotal: 1 kB\n');
  assert.equal(P.parseLinux(forged).base.memBytes.value, 527937844 * 1024);
  // 못 읽은 숫자는 null — 0 이 아니다
  const noCpu = P.parseLinux(LINUX_OUT.replace(/##CPU[\s\S]*?##MEM/, '##CPU\n##MEM'));
  assert.equal(noCpu.base.cpuCores.value, null); assert.equal(noCpu.base.cpuCores.missing, true);
  // 반증 F7: 안쪽 시한에 죽은 df · lsblk 는 빈 구획을 낸다 — ‘0개 · 읽음’ 이 아니라 못 읽음(null)
  const dead = P.parseLinux(LINUX_OUT.replace(/##DISKS[\s\S]*?##FS[\s\S]*?##END/, '##DISKS\n##FS\n##END'));
  assert.equal(dead.disks, null); assert.equal(dead.fs, null); assert.equal(dead.truncated, false); assert.deepEqual(dead.missing, { disks: true, fs: true });
  // Windows 셸에서 돈 흔적이면 알린다(저절로 다시 읽지 않는다)
  assert.equal(P.parseFor('linux', '', "'echo' is not recognized as an internal or external command").hint, 'maybe-windows');
});

test('③ Windows 해석 — JSON 칸 · 디스크 상태 · 볼륨 사용률 · JSON 이 없으면 전부 못 읽음', () => {
  const j = { os: { caption: 'Microsoft Windows Server 2022 Standard', version: '10.0.20348', build: '20348', memKB: 268435456 }, cs: { maker: '가상제조', model: 'GX-650', name: 'kr-file-01', domain: 'corp.example' },
    bios: { serial: 'VSN1', version: '2.1', maker: '가상' }, cpu: [{ Name: '가상 CPU', NumberOfCores: 16, NumberOfLogicalProcessors: 32 }, { Name: '가상 CPU', NumberOfCores: 16, NumberOfLogicalProcessors: 32 }],
    disk: [{ Index: 0, Model: '가상 SSD', SerialNumber: 'S0', Size: 480103981056, InterfaceType: 'SCSI' }], pd: { DeviceId: '0', MediaType: 4, HealthStatus: 0, BusType: 10 }, err: [],
    vol: [{ DeviceID: 'C:', FileSystem: 'NTFS', Size: 214748364800, FreeSpace: 107374182400, VolumeName: 'OS' }] };
  const p = P.parseWindows(`#< CLIXML\r\n##WINJSON\r\n${JSON.stringify(j)}\r\n`);
  assert.equal(p.truncated, false);
  assert.equal(p.base.cpuCores.value, 32); assert.equal(p.base.cpuThreads.value, 64); assert.equal(p.base.memBytes.value, 268435456 * 1024);
  assert.equal(p.base.hostname.value, 'kr-file-01.corp.example');
  assert.deepEqual(p.disks[0], { dev: 'Disk 0', model: '가상 SSD', serial: 'S0', wwn: '', sizeBytes: 480103981056, media: 'SSD', tran: 'SAS', health: 'Healthy' });
  assert.equal(p.fs[0].usePct, 50);
  const bad = P.parseWindows('Access denied');
  assert.equal(bad.truncated, true); assert.equal(bad.disks, null); assert.equal(bad.base.os.missing, true);
  // 반증 F7: 조회가 실패한 칸(err)은 빈 목록이 아니라 못 읽음 · F8: 남은 칸을 못 읽으면 사용률 null(0% 아님) · F9: 열거값 ‘__proto__’ 는 글이 아니다(객체를 꺼내지 않음)
  const part = P.parseWindows(`##WINJSON\n${JSON.stringify({ ...j, err: ['disk', 'os'], disk: null, os: null, vol: [{ DeviceID: 'D:', Size: 100, FreeSpace: null }] })}`);
  assert.equal(part.disks, null); assert.equal(part.base.os.missing, true); assert.deepEqual(part.failed, ['disk', 'os']);
  assert.equal(part.fs[0].usePct, null);
  // 실패 목록(err)에 든 조회는 값이 와도(빈 배열) 못 읽음이다 — 빈 목록 · 읽음으로 보지 않는다
  assert.equal(P.parseWindows(`##WINJSON\n${JSON.stringify({ ...j, err: ['vol'], vol: [] })}`).fs, null);
  const proto = P.parseWindows(`##WINJSON\n${JSON.stringify({ ...j, pd: { DeviceId: '0', MediaType: '__proto__', HealthStatus: 'constructor', BusType: 'toString' } })}`);
  for (const k of ['media', 'health', 'tran']) assert.equal(typeof proto.disks[0][k], 'string', k);
});


test('④ 코어 readServer — 서버 비밀번호 · 물려받은 공통 계정으로 한 번 · 계정 없으면 붙지 않음 · 엣지 서버 거절 · 허용 기능 밖 계정은 막힘 · 거부면 계정 정지', async () => {
  SSHD.st.passwords.root = 'Own-1';
  const own = srv({ name: 'own', vcenterId: 'vcA', os: 'linux', password: 'Own-1' });
  const r1 = await RS.readServer(own.id, { feature: 'server-info', plan: P.SERVER_INFO_PLAN });
  assert.equal(r1.ok, true, r1.reason); assert.equal(r1.os, 'linux'); assert.equal(r1.via, 'ssh');
  assert.equal(SSHD.st.cmds.at(-1), P.LINUX_COMMAND, '보낸 명령은 묶음 상수 그대로');
  assert.equal(JSON.stringify(r1).includes('Own-1'), false, '결과에 비밀 없음');
  // 계정이 없으면 시도하지 않는다
  const seen0 = SSHD.st.seen.length;
  const none = srv({ name: 'none', vcenterId: 'vcA', os: 'linux', addrOnly: true });
  assert.equal((await RS.readServer(none.id, { feature: 'server-info', plan: P.SERVER_INFO_PLAN })).code, 'not-configured');
  assert.equal(SSHD.st.seen.length, seen0, '빈 비밀번호로 시도하지 않았다');
  // 엣지 서버
  const edge = srv({ name: 'edge', vcenterId: 'vcA', os: 'linux', agent: 'edge-kr', password: 'x' });
  assert.equal((await RS.readServer(edge.id, { feature: 'server-info', plan: P.SERVER_INFO_PLAN })).code, 'edge-delegated');
  // 물려받기(공통 계정 · 승인) — 허용 기능에 server-info 가 없는 계정은 막힌다(접속 0회)
  const a = KS.saveAccount({ name: 'kr-lin', kind: 'os', corp: 'vcA', os: 'linux', username: 'svc', password: 'Svc-1', features: ['bm-usage'] }, { by: 't' });
  assert.equal(a.ok, true, a.reason);
  ST.setAssign('vcA', 'linux', { account: a.account.id, auth: '' }, { by: 't' });
  const inh = srv({ name: 'inh', vcenterId: 'vcA', os: 'linux', addrOnly: true });
  assert.equal(BM.setBmServerInherit(inh.id, { on: true, expectAddr: addrOf(inh), expectKey: BM.inheritKeyOf(inh), by: 't' }).ok, true);
  const seen1 = SSHD.st.seen.length;
  const blocked = await RS.readServer(inh.id, { feature: 'server-info', plan: P.SERVER_INFO_PLAN });
  assert.equal(blocked.code, 'cred'); assert.equal(blocked.credCode, 'account-feature'); assert.equal(SSHD.st.seen.length, seen1);
  // 기능을 켜면 읽는다
  assert.equal(KS.saveAccount({ id: a.account.id, features: ['bm-usage', 'server-info'] }, { by: 't' }).ok, true);
  SSHD.st.passwords.svc = 'Svc-1';
  const ok2 = await RS.readServer(inh.id, { feature: 'server-info', plan: P.SERVER_INFO_PLAN });
  assert.equal(ok2.ok, true, ok2.reason); assert.equal(ok2.auth.account, 'kr-lin'); assert.equal(ok2.auth.source, 'os');
  // 거부(서버 쪽 비밀번호가 바뀜) → 한 번만 · 계정 정지
  SSHD.st.passwords.svc = 'Rotated-2';
  const n0 = SSHD.st.seen.filter((p) => p === 'Svc-1').length;
  const rej = await RS.readServer(inh.id, { feature: 'server-info', plan: P.SERVER_INFO_PLAN });
  assert.equal(rej.code, 'auth-rejected');
  assert.equal(SSHD.st.seen.filter((p) => p === 'Svc-1').length, n0 + 1, '다시 시도하지 않았다');
  assert.ok(ST.accountStopFor(a.account.id, KS.accountSecretVersion(KS.accountById(a.account.id))), '로그인 거부 → 계정 단위 정지');
  const after = await RS.readServer(inh.id, { feature: 'server-info', plan: P.SERVER_INFO_PLAN });
  assert.equal(after.code, 'cred'); assert.equal(after.credCode, 'account-stopped');
  assert.equal(SSHD.st.seen.filter((p) => p === 'Svc-1').length, n0 + 1, '정지된 계정은 보내지 않는다');
});

test('⑤ 서비스 — 한 번에 상한 · 보관(원문 없음 · 실패해도 마지막 성공 값 유지) · 보관 파일 손상은 보존 후 빈 값', async () => {
  const own = BM.listBmServersRaw().find((s) => s.name === 'own');
  const r = await SVC.readMany([own.id], { by: 'own' });
  assert.equal(r.ok, true); assert.equal(r.read, 1);
  const row = SI.getResult(own.id);
  assert.equal(row.ok, true); assert.equal(row.base.os.value, 'Rocky Linux 9.4 (Blue Onyx)'); assert.equal(row.stdout, undefined, '원문은 보관하지 않는다');
  SSHD.st.passwords.root = 'Changed';
  await SVC.readMany([own.id], { by: 'own' });
  const failed = SI.getResult(own.id);
  assert.equal(failed.ok, false); assert.equal(failed.code, 'auth-rejected'); assert.equal(failed.lastOk.base.os.value, 'Rocky Linux 9.4 (Blue Onyx)');
  assert.equal((await SVC.readMany(Array.from({ length: SVC.READ_BATCH_MAX + 1 }, (_, i) => `x${i}`))).code, 'too-many');
  // 손상 파일 — 보존(.corrupt.*) 후 빈 값(수집 사본이라 다시 읽으면 채워진다)
  fs.writeFileSync(path.join(DIR, SI.SERVER_INFO_FILE), '{broken');
  SI._resetServerInfoStoreForTest();
  assert.equal(SI.getResult(own.id), null); assert.equal(SI.storeLoadError(), 'corrupt');
  assert.ok(fs.readdirSync(DIR).some((f) => f.startsWith(`${SI.SERVER_INFO_FILE}.corrupt.`)));
});

test('⑥ 라우트 — 관리자 + 전체 범위만 · 범위 관리자 · viewer 403 · 응답 · 감사에 비밀 없음', async (t) => {
  const express = (await import('express')).default;
  const { api: router } = await import('../src/routes/api.js');
  const USERS = { own: { username: 'own', role: 'admin', scope: null }, sown: { username: 'sown', role: 'admin', scope: { vcenters: ['vcA'] } }, v: { username: 'v', role: 'viewer', scope: null } };
  const app = express(); app.use(express.json());
  app.use((req, _r, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', router);
  const hs = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => hs.close());
  const call = async (u, method, p, body) => { const r = await fetch(`http://127.0.0.1:${hs.address().port}/api${p}`, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const txt = await r.text(); let j = {}; try { j = JSON.parse(txt); } catch { /* */ } return { s: r.status, j, txt }; };
  assert.equal((await call('sown', 'GET', '/tools/server-info')).s, 403);
  assert.equal((await call('v', 'GET', '/tools/server-info')).s, 403);
  const g = await call('own', 'GET', '/tools/server-info');
  assert.equal(g.s, 200); assert.ok(g.j.servers.some((s) => s.name === 'own'));
  for (const secret of ['Own-1', 'Svc-1', 'Rotated-2']) assert.equal(g.txt.includes(secret), false);
  SSHD.st.passwords.root = 'Own-1';
  const own = g.j.servers.find((s) => s.name === 'own');
  assert.equal((await call('sown', 'POST', '/tools/server-info/read', { ids: [own.id] })).s, 403);
  const p = await call('own', 'POST', '/tools/server-info/read', { ids: [own.id] });
  assert.equal(p.s, 202, p.txt); assert.equal(p.j.started, true); assert.equal(p.j.total, 1);   // 시작만 하고 돌려준다(반증 F4)
  for (let i = 0; i < 200 && SVC.buildView().job; i += 1) await new Promise((r) => setTimeout(r, 50));
  const g2 = await call('own', 'GET', '/tools/server-info');
  assert.equal(g2.j.job, null); assert.equal(g2.j.servers.find((x) => x.id === own.id).result.ok, true);
  const auditTxt = fs.readdirSync(DIR).filter((f) => f.startsWith('audit')).map((f) => { try { return fs.readFileSync(path.join(DIR, f), 'utf8'); } catch { return ''; } }).join('\n');
  assert.equal(auditTxt.includes('Own-1'), false);
});

test('⑦ 반증(review325) — 비밀번호는 한 번만(k-i 재시도 없음) · 같은 계정명 · 비밀번호 N대는 탐침 하나 · 일괄은 하나씩 · 명령 시한이면 받은 칸 · 꺼진 서버 · 보관 파일 일시 오류 회복', async () => {
  // F1: 서버가 password 와 keyboard-interactive 를 함께 받을 때 — 틀린 비밀번호는 한 번만 닿는다(예전: password + k-i 로 두 번)
  SSHD.st.methods = ['password', 'keyboard-interactive'];
  const k1 = srv({ name: 'ki-1', vcenterId: 'vcA', os: 'linux', username: 'kiuser', password: 'Ki-Wrong-1' });
  const r1 = await RS.readServer(k1.id, { feature: 'server-info', plan: P.SERVER_INFO_PLAN });
  assert.equal(r1.code, 'auth-rejected');
  assert.equal(SSHD.st.seen.filter((p) => p === 'Ki-Wrong-1').length, 1, '로그인 한 번 = 비밀번호 확인 한 번');
  // 서버가 password 방식을 아예 받지 않으면 k-i 로 간다(그때 password 시도는 비밀번호 확인까지 가지 않는다)
  SSHD.st.methods = ['keyboard-interactive']; SSHD.st.passwords.kiuser = 'Ki-Right-1';
  const k2 = srv({ name: 'ki-2', vcenterId: 'vcA', os: 'linux', username: 'kiuser', password: 'Ki-Right-1' });
  assert.equal((await RS.readServer(k2.id, { feature: 'server-info', plan: P.SERVER_INFO_PLAN })).ok, true);
  SSHD.st.methods = ['password'];
  // F2: 서버 단독 비밀번호 — 같은 계정명 · 비밀번호로 등록한 4대를 한 번에 읽어도 틀린 비밀번호는 한 번
  const same = [1, 2, 3, 4].map((i) => srv({ name: `same-${i}`, vcenterId: 'vcA', os: 'linux', username: 'dup', password: 'Dup-Wrong-1' }));
  const b = await SVC.readMany(same.map((x) => x.id), { by: 'own' });
  assert.equal(SSHD.st.seen.filter((p) => p === 'Dup-Wrong-1').length, 1, `탐침 하나 — ${JSON.stringify(b.results?.map((x) => x.code))}`);
  assert.deepEqual(b.results.map((x) => x.code).sort(), ['auth-rejected', 'same-cred-rejected', 'same-cred-rejected', 'same-cred-rejected']);
  // 공통 계정(물려받기) 3대를 한 번에 — 계정 탐침이 하나만 보낸다(코어가 accountGate 를 지난다)
  const g = KS.saveAccount({ name: 'f2-acc', kind: 'os', corp: 'vcG', os: 'linux', username: 'gacc', password: 'G-Wrong-1', features: ['server-info'] }, { by: 't' });
  assert.equal(g.ok, true, g.reason);
  ST.setAssign('vcG', 'linux', { account: g.account.id, auth: '' }, { by: 't' });
  const inh3 = [1, 2, 3].map((i) => { const x = srv({ name: `g-${i}`, vcenterId: 'vcG', os: 'linux', addrOnly: true }); assert.equal(BM.setBmServerInherit(x.id, { on: true, expectAddr: addrOf(x), expectKey: BM.inheritKeyOf(x), by: 't' }).ok, true); return x; });
  await SVC.readMany(inh3.map((x) => x.id), { by: 'own' });
  assert.equal(SSHD.st.seen.filter((p) => p === 'G-Wrong-1').length, 1, '공통 계정 탐침 하나');
  // F3: 일괄은 하나씩 — 도는 동안 두 번째는 429
  const own = BM.listBmServersRaw().find((s) => s.name === 'own');
  SSHD.st.passwords.root = 'Own-1';
  const j1 = SVC.startRead([own.id], { by: 'own' });
  assert.equal(j1.ok, true);
  const j2 = SVC.startRead([own.id], { by: 'own' });
  assert.equal(j2.code, 'busy'); assert.equal(j2.status, 429);
  assert.equal(SVC.buildView().job.total, 1);
  await j1.done;
  assert.equal(SVC.buildView().job, null);
  // F6: 로그인은 됐는데 명령이 시한 안에 끝나지 않으면 — 받은 칸만(잘림) · 접속 실패가 아니다 · 탐침은 성공(비밀번호는 맞았다)
  SSHD.st.hang = true;
  const plan = { linux: { command: P.LINUX_COMMAND, timeoutMs: 1500 } };
  const h = await RS.readServer(own.id, { feature: 'server-info', plan });
  SSHD.st.hang = false;
  assert.equal(h.code, 'exec-timeout'); assert.equal(h.partial, true); assert.match(h.stdout, /##OSREL/);
  const hp = P.parseFor('linux', h.stdout, h.stderr);
  assert.equal(hp.truncated, true); assert.equal(hp.base.os.value, 'Rocky Linux 9.4 (Blue Onyx)'); assert.equal(hp.disks, null);
  // F16: 수집을 끈 서버에는 붙지 않는다
  const off = srv({ name: 'off', vcenterId: 'vcA', os: 'linux', password: 'Off-1', enabled: false });
  const n0 = SSHD.st.seen.length;
  assert.equal((await RS.readServer(off.id, { feature: 'server-info', plan: P.SERVER_INFO_PLAN })).code, 'disabled');
  assert.equal(SSHD.st.seen.length, n0);
  // F11: 보관 파일 일시 읽기 오류(여기서는 폴더로 바꿔 EISDIR) — 원본을 덮지 않고, 다시 읽을 수 있게 되면 그동안의 결과를 얹는다
  const FILE = path.join(DIR, SI.SERVER_INFO_FILE);
  fs.rmSync(FILE, { force: true }); fs.mkdirSync(FILE);
  SI._resetServerInfoStoreForTest();
  assert.ok(SI.storeLoadError());
  SI.putResult('zz-1', { ok: true, at: 1, code: 'ok' });
  fs.rmSync(FILE, { recursive: true, force: true }); fs.writeFileSync(FILE, JSON.stringify({ v: 1, servers: { 'zz-0': { ok: true, at: 0, code: 'ok' } } }));
  SI._resetServerInfoStoreForTest({ retryNow: true });
  assert.equal(SI.getResult('zz-0').at, 0, '다시 읽었다'); assert.equal(SI.getResult('zz-1').at, 1, '그동안의 결과를 얹었다'); assert.equal(SI.storeLoadError(), '');
});
