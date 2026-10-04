/**
 * releaseVersions2689.test.js — 이전 versions.json 을 못 받거나 손상됐을 때 '빈 시작' 으로
 * 넘어가지 않는다(v2.689 B1).
 *
 * 왜 이 테스트가 있는가
 * ---------------------
 * release.yml 은 이전 versions.json 을 받아 새 버전을 앞에 붙이고, 그 목록을 기준으로
 * prune-assets.mjs 가 '목록 밖 버전' 의 자산을 지운다. 예전에는 ① 다운로드 일시 오류가
 * `|| true` 로 삼켜지고 ② update-versions.mjs 가 JSON 손상을 '새로 시작' 으로 삼켜,
 * 새 목록에 새 버전 1개만 남고 prune 이 **기존 버전 자산 전부**를 지울 수 있었다.
 * 오류도 경고도 없는 경로라 되돌려도 CI 는 통과한다 — 그래서 고정한다.
 *
 * ⚠ update-versions.mjs 는 실제로 실행한다(문자열 검사로 끝내지 않는다).
 * ⚠ 워크플로 검사는 전체 줄 주석을 지운 뒤 본다 — 규칙을 설명하는 주석이 통과 근거가 되면 안 된다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'packaging/release/update-versions.mjs');
const VER = '9.9.9';

function makeDist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relver2689-'));
  for (const n of [
    `vmware-portal-${VER}.tar.gz`,
    `vmware-portal-offline-${VER}-el9-x64.tar.gz`,
    `vmware-portal-offline-${VER}-cent9-x64.tar.gz`,
    `vmware-portal-win-${VER}-x64.zip`,
  ]) fs.writeFileSync(path.join(dir, n), `dummy ${n}`);
  return dir;
}

function run(dir, prevArg) {
  const out = path.join(dir, 'out-versions.json');
  const r = spawnSync(process.execPath, [SCRIPT, VER, dir, prevArg, out], {
    encoding: 'utf8', env: { ...process.env, VERSIONS_KEEP: '15' },
  });
  return { status: r.status, stderr: r.stderr, out, wrote: fs.existsSync(out) };
}

const OLD = { latest: '9.9.8', versions: [{ version: '9.9.8' }, { version: '9.9.7' }] };

test('정상 이전 목록은 이어 붙인다(새 버전 맨 앞 + 기존 항목 보존)', () => {
  const dir = makeDist();
  try {
    const prev = path.join(dir, 'prev.json');
    fs.writeFileSync(prev, JSON.stringify(OLD));
    const r = run(dir, prev);
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(fs.readFileSync(r.out, 'utf8'));
    assert.equal(doc.latest, VER);
    assert.deepEqual(doc.versions.map((v) => v.version), [VER, '9.9.8', '9.9.7']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('이전 파일이 없으면(정말 처음) 새 버전 1개로 시작한다', () => {
  const dir = makeDist();
  try {
    const r = run(dir, path.join(dir, 'no-such.json'));
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(fs.readFileSync(r.out, 'utf8'));
    assert.deepEqual(doc.versions.map((v) => v.version), [VER]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const [label, body] of [
  ['JSON 파싱 실패(잘린 파일)', '{"latest":"9.9.8","versions":[{"vers'],
  ['빈 파일', ''],
  ['versions 배열 없음', '{"latest":"9.9.8"}'],
  ['객체가 아님', '[1,2,3]'],
  ['null', 'null'],
]) {
  test(`이전 versions.json 손상(${label})이면 실패하고 결과 파일을 쓰지 않는다`, () => {
    const dir = makeDist();
    try {
      const prev = path.join(dir, 'prev.json');
      fs.writeFileSync(prev, body);
      const r = run(dir, prev);
      assert.notEqual(r.status, 0, '손상된 이전 목록을 빈 시작으로 삼키면 prune 이 기존 자산을 전부 지운다');
      assert.equal(r.wrote, false, '실패했으면 versions.json 을 쓰지 않아야 한다');
      assert.match(r.stderr, /중단/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

/* ----------------------------- 워크플로 구조 ----------------------------- */

const stripComments = (yaml) => yaml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const REL = stripComments(fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8'));
function step(name) {
  const i = REL.indexOf(`- name: ${name}`);
  assert.ok(i >= 0, `release.yml 에 '${name}' 스텝이 있어야 한다`);
  const rest = REL.slice(i + 1);
  const j = rest.search(/\n {6}- name:/);
  return j < 0 ? rest : rest.slice(0, j);
}

test('versions.json 다운로드는 실패를 삼키지 않고 재시도한다', () => {
  const s = step('Fetch previous versions.json');
  assert.match(s, /id: prevver/);
  const dl = s.split('\n').find((l) => /gh release download .*versions\.json/.test(l)) || '';
  assert.ok(dl, '다운로드 줄이 있어야 한다');
  assert.ok(!/\|\|\s*true/.test(dl), '다운로드 실패를 || true 로 삼키면 prev 가 빈 목록이 된다');
  assert.match(s, /for i in 1 2 3/, '3회 재시도');
  assert.match(s, /gh release view "\$RELEASE_TAG" --json assets/, '못 받았을 때 릴리스 자산 존재를 확인한다');
  assert.match(s, /exit 1/, '자산이 있는데 못 받았으면 실패한다');
  assert.match(s, /first=true/);
  assert.match(s, /first=false/);
});

test('prune 은 "정말 처음" 으로 확인된 경우에만 생략한다', () => {
  const s = step('Prune old release assets');
  assert.match(s, /steps\.prevver\.outputs\.first/);
});

/* ------------------- 호스트 접근 제어: NoNewPrivileges 안내(v2.689 NNP 조사) ------------------- */
/*
 * 별건이지만 같은 수정 그룹(G1)이라 여기 둔다. 본체 유닛의 NoNewPrivileges=true 아래에서는 sudo 가 sudoers 와
 * 무관하게 거부한다. 아래 stderr 는 이 컨테이너에서 setpriv --no-new-privs 로 실제로 받은 문구(sudo 1.9.15p5)다.
 * 이 문구는 exec.js isSudoDenied 정규식에 걸리지 않아 'unavailable' 로 떨어진다 — 그래서 원인 안내를 detail 에 싣는다.
 */
const NNP_STDERR = 'sudo: The "no new privileges" flag is set, which prevents sudo from running as root.\n'
  + 'sudo: If sudo is running in a container, you may need to adjust the container configuration to disable the flag.\n';

let cfgTmp = null;
after(() => { if (cfgTmp) fs.rmSync(cfgTmp, { recursive: true, force: true }); });
async function engineWith(stderr) {
  if (!process.env.CONFIG_DIR) { cfgTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relver2689-cfg-')); process.env.CONFIG_DIR = cfgTmp; }
  const S = await import('../src/hostaccess/service.js');
  const E = await import('../src/hostaccess/exec.js');
  S._setExec({ ...E, fw: async () => ({ ok: false, code: 1, stdout: '', stderr }) });
  try { return { eng: await S.readEngine(), S }; } finally { S._setExec(null); }
}

test('NNP — sudo 가 no new privileges 로 거부하면 화면 detail 이 원인 후보와 확인 명령을 말한다', async () => {
  const { eng, S } = await engineWith(NNP_STDERR);
  assert.equal(eng.ok, false);
  assert.equal(eng.reason, 'unavailable', '실제 NNP 문구는 sudoers 거부 정규식에 걸리지 않는다(재현 결과)');
  assert.ok(eng.detail.includes(S.NNP_NOTE), eng.detail);
  assert.ok(eng.detail.includes('no new privileges'), '원문을 지우지 않는다');
  assert.match(S.NNP_NOTE, /NoNewPrivileges=true/);
  assert.match(S.NNP_NOTE, /sudo -n \/usr\/bin\/firewall-cmd --state/);
  assert.ok(!/`|\*\*/.test(S.NNP_NOTE), '화면 문구에 백틱·별표 금지');
});

test('NNP — sudoers 거부(sudo-denied)에도 같은 안내를 붙이고, 무관한 실패에는 붙이지 않는다', async () => {
  const a = await engineWith('sudo: a password is required\n');
  assert.equal(a.eng.reason, 'sudo-denied');
  assert.ok(a.eng.detail.includes(a.S.NNP_NOTE));
  assert.match(a.eng.hint, /firewall-cmd/);
  const b = await engineWith('Error: something else\n');
  assert.equal(b.eng.reason, 'unavailable');
  assert.ok(!b.eng.detail.includes(b.S.NNP_NOTE), '관계없는 실패에 NNP 를 원인처럼 말하지 않는다');
  const c = await engineWith("sudo: effective uid is not 0, is /usr/bin/sudo on a file system with the 'nosuid' option set or an NFS file system without root privileges?\n");
  assert.ok(c.eng.detail.includes(c.S.NNP_NOTE), '구버전 sudo 문구(추정)에도 안내');
});
