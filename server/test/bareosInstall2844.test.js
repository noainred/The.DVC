/**
 * test/bareosInstall2844.test.js — v2.844 Bareos 완전 설치(순수 판정 · 라우트 문지기).
 *  ① 번들 서명: 서명 스크립트 → 수신측 검증 통과 · 본체/내용 목록 한 바이트 변조 · 다른 키 · 다른 판 manifest 재사용 거부 · pyVmomi 9.x 는 목록에서 빠짐
 *  ② 계획: pyVmomi 는 번들 8.x 만 · 볼륨 경로 시스템 경로·얕은 경로·.. 거부 · 재설치 확인·볼륨 삭제는 법인 이름 일치 · plan.env 에 따옴표·$ 불가
 *  ③ 사전 점검: 파서(못 읽음 = null) · install 에 Bareos 있으면 ✗ · reinstall 실행 중 작업 ✗ · 80 포트 남의 프로그램 ✗ · 9.x pyVmomi ! · 시계 못 읽음 ?
 *  ④ 원인 판정: 근거 줄 = 출력에서 맞은 줄 · 미분류는 지어내지 않음 · SSH 인증 실패에 자동 재시도 단추 없음 · 출력 비밀 줄 빼기
 *  ⑤ 대상 표: 엣지 없음 · 배포 등록부 없음 · 비밀번호 없음 · 엣지 응답 없음 · Director 가 엣지 아닌 서버 · 재설치 가능
 *  ⑥ 상태 파싱 · 라우트 문지기(소스): 쓰기 라우트 전부 fullScopeOnly + fullWriteOnly + (데모가 아니면) installGate · 감사 '[OTP 없이 실행]' · 비밀이 감사에 없음
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bi2844u-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const { signBundle } = await import('../../scripts/bareos-bundle-sign.mjs');
const { keyIdOf, spkiBase64Of, parseKeysDoc, mergeTrust } = await import('../src/upgrade/signatureCore.js');
const BD = await import('../src/bareos/install/bundleDoc.js');
const PL = await import('../src/bareos/install/plan.js');
const PC = await import('../src/bareos/install/precheck.js');
const CA = await import('../src/bareos/install/causes.js');
const TG = await import('../src/bareos/install/targets.js');
const JB = await import('../src/bareos/install/job.js');

function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKey, privateKey, doc: { format: 'vmware-portal-release-keys', schema: 1, keys: [{ keyId: keyIdOf(publicKey), publicKey: spkiBase64Of(publicKey), addedAt: '2026-11-01', revoked: false }] } };
}
const contentsDoc = (v, extra = {}) => ({ format: 'portal-bareos-bundle', v: 1, version: v, el: '9', arch: 'x86_64', bareosVersion: '25.1.2~pre73', postgresqlVersion: '13.23',
  install: ['bareos', 'bareos-webui', 'postgresql-server'], packages: [{ name: 'bareos-director', version: '25.1.2~pre73', release: '126.el9', arch: 'x86_64' }], keys: ['RPM-GPG-KEY-bareos-1'],
  pyvmomi: { versions: ['8.0.2.0.1', '9.1.1.0', '8.0.3.0.1'], default: '8.0.3.0.1' }, vddk: ['bareos-vmware-vix-disklib-8.0.3'], ...extra });

function signed(v = '25.20261101.4') {
  const k = keyPair();
  const dir = fs.mkdtempSync(path.join(tmp, 'b-'));
  const keysFile = path.join(dir, 'keys.json');
  fs.writeFileSync(keysFile, JSON.stringify(k.doc));
  fs.writeFileSync(path.join(dir, BD.tarName(v)), crypto.randomBytes(2048));
  fs.writeFileSync(path.join(dir, BD.contentsName(v)), JSON.stringify(contentsDoc(v)));
  signBundle({ version: v, dist: dir, keysFile, env: { RELEASE_SIGNING_KEY: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) } });
  const trust = mergeTrust([parseKeysDoc(k.doc, 'test')]);
  const read = () => {
    const tarBuf = fs.readFileSync(path.join(dir, BD.tarName(v)));
    const contentsBuf = fs.readFileSync(path.join(dir, BD.contentsName(v)));
    return { pointer: JSON.parse(fs.readFileSync(path.join(dir, BD.POINTER_NAME), 'utf8')), manifestText: fs.readFileSync(path.join(dir, BD.manifestName(v)), 'utf8'), contentsBuf,
      contentsSha256: crypto.createHash('sha256').update(contentsBuf).digest('hex'), tar: { size: tarBuf.length, sha256: crypto.createHash('sha256').update(tarBuf).digest('hex') } };
  };
  return { dir, v, trust, read, k };
}

test('① 번들 서명 — 검증 통과 · 변조·다른 키·다른 판 거부 · pyVmomi 9.x 는 빠짐', () => {
  const s = signed();
  const ok = BD.verifyBundle(s.read(), s.trust);
  assert.equal(ok.ok, true, ok.reason);
  assert.deepEqual(ok.contents.pyvmomi.versions, ['8.0.3.0.1', '8.0.2.0.1']);
  assert.equal(ok.contents.pyvmomi.default, '8.0.3.0.1');
  // 본체 1바이트 변조
  const g = s.read(); g.tar = { ...g.tar, sha256: crypto.createHash('sha256').update('x').digest('hex') };
  assert.equal(BD.verifyBundle(g, s.trust).ok, false);
  // 내용 목록 변조(해시는 그대로 두고 내용만)
  const g2 = s.read(); g2.contentsBuf = Buffer.from(String(g2.contentsBuf).replace('postgresql-server', 'evil-pkg'));
  assert.equal(BD.verifyBundle(g2, s.trust).ok, false);
  // 다른 키 신뢰
  const other = keyPair();
  assert.equal(BD.verifyBundle(s.read(), mergeTrust([parseKeysDoc(other.doc, 'o')])).ok, false);
  // 다른 판 manifest 재사용(포인터 판만 바꿈)
  const s2 = signed('25.20261102.5');
  const g3 = s.read(); g3.manifestText = s2.read().manifestText;
  assert.equal(BD.verifyBundle(g3, s.trust).ok, false);
  // 포인터 형식
  assert.match(BD.pointerIssue({ format: 'x' }), /형식/);
  assert.match(BD.pointerIssue({ ...s.read().pointer, manifest: 'evil.json' }), /manifest/);
});

test('① 내용 목록 정규화 — 설치 패키지 이름 규칙 · 8.x 없으면 거부 · 키 없으면 거부', () => {
  const v = '25.1.1';
  assert.match(BD.normContents(contentsDoc(v, { install: ['bareos; rm -rf /'] }), v).issue, /설치 패키지/);
  assert.match(BD.normContents(contentsDoc(v, { pyvmomi: { versions: ['9.1.1.0'] } }), v).issue, /8\.x/);
  assert.match(BD.normContents(contentsDoc(v, { keys: [] }), v).issue, /서명 키/);
  assert.match(BD.normContents(contentsDoc(v), '25.1.2').issue, /버전/);
});

const C = BD.normContents(contentsDoc('25.1.1'), '25.1.1').contents;
test('② 계획 — pyVmomi 8.x 만 · 볼륨 경로 · 재설치 확인 · plan.env', () => {
  const ok = PL.normPlan({}, { contents: C, mode: 'install', corpName: '북미' });
  assert.equal(ok.pyvmomi, '8.0.3.0.1'); assert.equal(ok.volumeDir, '/var/lib/bareos/storage'); assert.equal(ok.webui, true);
  assert.throws(() => PL.normPlan({ pyvmomi: '9.1.1.0' }, { contents: C, mode: 'install' }), /8\.x/);
  for (const bad of ['/', '/etc/bareos', '/var', '/usr/local/x', 'relative/x', '/mnt', '/srv/../etc', '/a//b', '/data/x/', '/x']) {
    assert.ok(PL.volumeDirIssue(bad), `${bad} 거부`);
  }
  for (const good of ['/var/lib/bareos/storage', '/mnt/bareos', '/data/bareos-vol']) assert.equal(PL.volumeDirIssue(good), '', good);
  assert.throws(() => PL.normPlan({ reset: { catalog: true } }, { contents: C, mode: 'reinstall', corpName: '폴란드' }), /확인/);
  assert.throws(() => PL.normPlan({ reset: { ack: true, volumes: true, confirmName: '폴란' } }, { contents: C, mode: 'reinstall', corpName: '폴란드' }), /법인 이름/);
  const r = PL.normPlan({ reset: { ack: true, volumes: true, confirmName: '폴란드' } }, { contents: C, mode: 'reinstall', corpName: '폴란드' });
  assert.deepEqual(r.reset, { catalog: true, volumes: true });
  const env = PL.planEnv({ jobId: 'bi_abcdef12', bundle: { version: '25.1.1', sha256: 'a'.repeat(64) }, install: C.install, plan: r, hostAddr: '10.1.2.3', resetVolumeDirs: ['/srv/bk', '/etc', '/'] });
  assert.match(env, /^RESET='1'$/m); assert.match(env, /^RESET_VOLUME_DIRS='\/srv\/bk'$/m, '시스템 경로는 plan.env 에 싣지 않는다');
  assert.match(env, /^WEBUI='1'$/m);
  assert.throws(() => PL.planEnv({ jobId: 'bi_abcdef12', bundle: { version: '25.1.1', sha256: 'a'.repeat(64) }, install: C.install, plan: r, hostAddr: "1.2.3.4'; rm -rf /" }), /허용 형식|쓸 수 없는/);
  assert.throws(() => PL.planEnv({ jobId: 'bi_abcdef12', bundle: { version: '25.1.1', sha256: 'a'.repeat(64) }, install: ['ok', 'a$(id)'], plan: r, hostAddr: '1.2.3.4' }), /패키지/);
});

const PRE = (o = {}) => [
  '@@id', '0', '@@os', 'ID=rocky', 'VERSION_ID=9.4', 'PRETTY=Rocky Linux 9.4', 'ARCH=x86_64', '@@tools', 'systemd-run=1', 'dnf=1', 'rpm=1', 'ss=1', 'python3=1', 'chronyc=0',
  '@@selinux', 'Enforcing', '@@pkgs', ...(o.pkgs || []), '@@etc', o.etc ?? 'none', '@@svc', 'bareos-dir=inactive', '@@ports', ...(o.ports || []),
  '@@python', '3.9.18', '@@pyvmomi', o.pyv || 'none', '@@bpp', ...(o.bpp || []), '@@disk', 'PATH=/var/lib', 'AVAIL_KB=431800000', 'SIZE_KB=1800000000', 'MOUNT=/', 'EXISTS=0',
  '@@varlib', '431800000', '@@clock', o.clock || '', '@@addr', '10.20.0.14', 'edge-us.corp', '@@runner', '', '@@running', o.running ?? 'none', '@@catalog', 'none', '@@volumes', '@@end',
].join('\n');
const item = (j, k) => j.items.find((i) => i.key === k);

test('③ 사전 점검 — 파서·판정', () => {
  const f = PC.parsePrecheck(PRE());
  assert.equal(f.complete, true); assert.equal(f.uid, 0); assert.equal(f.hostAddr, '10.20.0.14'); assert.equal(f.clockOffsetSec, null); assert.equal(f.runningJobs, null);
  const j = PC.judgePrecheck(f, { mode: 'install', bundle: C });
  assert.equal(j.blocked, false, JSON.stringify(j.items.filter((i) => i.status === 'bad')));
  assert.equal(item(j, 'clock').status, 'unknown', '시계를 못 읽으면 확인 불가(0 이 아니다)');
  const inst = PC.judgePrecheck(PC.parsePrecheck(PRE({ pkgs: ['bareos-director 22.1.2'], etc: '41' })), { mode: 'install', bundle: C });
  assert.equal(item(inst, 'bareos').status, 'bad'); assert.equal(inst.blocked, true);
  const re = PC.judgePrecheck(PC.parsePrecheck(PRE({ pkgs: ['bareos-director 22.1.2'], etc: '41', running: '2' })), { mode: 'reinstall', bundle: C });
  assert.equal(item(re, 'running').status, 'bad');
  const re0 = PC.judgePrecheck(PC.parsePrecheck(PRE({ pkgs: ['bareos-director 22.1.2'], etc: '41', running: '0' })), { mode: 'reinstall', bundle: C });
  assert.equal(item(re0, 'running').status, 'ok'); assert.equal(item(re0, 'bareos').status, 'warn');
  const web = PC.judgePrecheck(PC.parsePrecheck(PRE({ ports: ['0.0.0.0:80'], pkgs: ['nginx 1.20'] })), { mode: 'install', bundle: C, plan: { webui: true } });
  assert.equal(item(web, 'web').status, 'bad');
  const nine = PC.judgePrecheck(PC.parsePrecheck(PRE({ pyv: '9.1.1', bpp: ['/usr/lib64/bareos/plugins/pyVmomi'] })), { mode: 'install', bundle: C });
  assert.equal(item(nine, 'pyvmomi').status, 'warn'); assert.equal(item(nine, 'bpp').status, 'warn');
  const nob = PC.judgePrecheck(f, { mode: 'install', bundle: null });
  assert.equal(item(nob, 'bundle').status, 'bad');
  // 끊긴 출력
  const cut = PC.judgePrecheck(PC.parsePrecheck(PRE().replace('@@end', '')), { mode: 'install', bundle: C });
  assert.equal(item(cut, 'read').status, 'unknown');
  assert.throws(() => PC.precheckScript('/etc'), /허용/);
});

test('④ 원인 판정 — 근거 줄 · 미분류 · SSH 인증 · 비밀 줄 빼기', () => {
  const d = CA.classifyFailure({ step: 2, output: 'Last metadata\nError:\n Problem: conflicting requests\n  - nothing provides libfoo' });
  assert.equal(d.key, 'dnf-conflict'); assert.match(d.evidence, /Problem: conflicting requests/);
  const u = CA.classifyFailure({ step: 2, output: 'something odd happened' });
  assert.equal(u.key, 'unclassified'); assert.equal(u.evidence, '');
  const a = CA.classifyFailure({ step: 1, sshAuth: true, message: 'All configured authentication methods failed' });
  assert.equal(a.key, 'ssh-auth');
  assert.ok(!a.fixes.some((f) => f.kind === 'retry' || f.kind === 'portal'), 'SSH 인증 실패에는 자동 재시도 단추가 없다');
  const py = CA.classifyFailure({ step: 2, output: 'Exception: Python 3.10 or newer is required (found 3.9)' });
  assert.equal(py.key, 'pyvmomi-shadow'); assert.ok(py.fixes.some((f) => f.action === 'pyvmomi-fix'));
  assert.equal(CA.classifyFailure({ step: 6, message: '엣지 응답 없음' }).key, 'edge-probe');
  const s = CA.scrubOutput('ok line\npassword=Sup3rSecret!\nanother', ['Sup3rSecret!']);
  assert.ok(!s.includes('Sup3rSecret!')); assert.match(s, /ok line/);
  const e = CA.parseErrFile('cmd=dnf install\ncode=1\ncause=\n---\nline1\nline2');
  assert.deepEqual([e.cmd, e.code, e.output], ['dnf install', 1, 'line1\nline2']);
});

test('⑤ 대상 표 — 불가 사유 · 재설치 조건', () => {
  const now = Date.now();
  const vcenters = [1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: `vc${i}`, name: `법인${i}`, host: `vc${i}.corp` }));
  const inventory = [
    { vcenterId: 'vc1', agent: 'edge1', at: now - 60_000 }, { vcenterId: 'vc3', agent: 'edge3', at: now - 60_000 }, { vcenterId: 'vc4', agent: 'edge4', at: now - 60_000 },
    { vcenterId: 'vc5', agent: 'edge5', at: now - 5 * 3600_000 }, { vcenterId: 'vc6', agent: 'edge6', at: now - 60_000 }, { vcenterId: 'vc7', agent: 'edge7', at: now - 60_000 },
  ];
  const deployTargets = [
    { id: 't1', agentName: 'edge1', host: '10.0.0.1', username: 'root', password: 'p' }, { id: 't4', agentName: 'edge4', host: '10.0.0.4', username: 'root', privateKey: 'k' },
    { id: 't5', agentName: 'edge5', host: '10.0.0.5', username: 'root', password: 'p' }, { id: 't6', agentName: 'edge6', host: '10.0.0.6', username: 'root', password: 'p' },
    { id: 't7', agentName: 'edge7', host: '10.0.0.7', username: 'root', password: 'p' },
  ];
  const settings = { directors: [{ id: 'dir_a6', name: 'D6', host: '10.0.0.6' }, { id: 'dir_a7', name: 'D7', host: '10.9.9.9' }], sites: [{ vcenterId: 'vc6', directorId: 'dir_a6' }, { vcenterId: 'vc7', directorId: 'dir_a7' }] };
  const rows = TG.buildTargets({ vcenters, inventory, deployTargets, settings, now });
  const by = Object.fromEntries(rows.map((r) => [r.vcenterId, r]));
  assert.equal(by.vc1.can, true); assert.equal(by.vc1.mode, 'install');
  assert.match(by.vc2.why, /엣지 노드 없음/);
  assert.match(by.vc3.why, /배포 등록부/);
  assert.match(by.vc4.why, /비밀번호/);
  assert.match(by.vc5.why, /엣지 응답 없음/);
  assert.equal(by.vc6.can, true); assert.equal(by.vc6.mode, 'reinstall');
  assert.equal(by.vc7.can, false); assert.match(by.vc7.why, /엣지 노드가 아닌 서버/);
  // 이 기능이 설치한 주소로 등록돼 있으면 재설치 가능
  const rows2 = TG.buildTargets({ vcenters, inventory, deployTargets, settings, now, knownHostAddrs: new Map([['vc7', '10.9.9.9']]) });
  assert.equal(rows2.find((r) => r.vcenterId === 'vc7').can, true);
  assert.ok(!JSON.stringify(rows).includes('"password"'), '응답 행에 비밀번호 칸이 없다');
});

test('⑥ 상태 파싱', () => {
  const s = JB.parseState('1 start 100\n1 ok 110\n2 start 111\n2 fail 120\n2 rolledback 125\nall done 130\nbad line');
  assert.equal(s.steps[1].status, 'ok'); assert.equal(s.steps[2].status, 'rolledback'); assert.equal(s.all.status, 'done');
  assert.equal(s.steps[2].endedAt, 125_000);
  // 반증 M3: 앞 회차의 all done 은 다음 회차의 begin 뒤에서 무시한다
  const t = JB.parseState('1 ok 1\nall done 9\nbegin install 10\n2 start 11\n');
  assert.equal(t.all, null); assert.equal(t.steps[2].status, 'running'); assert.equal(t.steps[1], undefined);
});

test('⑥ 라우트 문지기(소스) — 쓰기 전부 fullScopeOnly + fullWriteOnly · 데모가 아니면 installGate · 감사 접두 · 비밀 없음', () => {
  const src = stripComments(fs.readFileSync(path.join(HERE, '../src/routes/api/bareosInstall.js'), 'utf8'));
  const routes = [...src.matchAll(/api\.(post|delete|put)\(`\$\{P\}([^`]*)`,([^\n]*)/g)];
  assert.ok(routes.length >= 9, `쓰기 라우트 ${routes.length}개`);
  for (const [, m, p, rest] of routes) {
    assert.match(rest, /adminOnly, fullScopeOnly, fullWriteOnly/, `${m} ${p}`);
  }
  // fetch·rescan(중앙 폴더만 — 원격 접속 없음)을 뺀 쓰기 라우트는 installGate 를 지난다
  const blocks = src.split(/\napi\.(?:post|delete|put|get)\(/).slice(1);
  for (const b of blocks) {
    const head = b.slice(0, 80);
    if (!/^`\$\{P\}/.test(head) || /bundle\/(fetch|rescan)/.test(head) || /^`\$\{P\}`|jobs\/:id`, adminOnly, fullScopeOnly, \(/.test(head)) continue;
    if (/^`\$\{P\}\/jobs\/:id`/.test(head)) continue;
    assert.match(b, /installGate\(req, res\)/, head);
  }
  assert.match(src, /const OTP_OFF = '\[OTP 없이 실행\] '/);
  assert.ok(!/audit\([^)]*(vcpass|password)/.test(src), '감사에 비밀번호가 없다');
  assert.match(src, /totpEnabled/, 'OTP 를 등록한 계정만');
  // 경로는 설정 아래(데모 계정 READ_DENY 접두가 덮는다)
  assert.match(src, /const P = '\/tools\/bareos-backup\/settings\/install'/);
  const dg = fs.readFileSync(path.join(HERE, '../src/auth/demoGuest.js'), 'utf8');
  assert.match(dg, /'\/api\/tools\/bareos-backup\/settings'/);
});
