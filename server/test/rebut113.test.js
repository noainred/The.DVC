/**
 * 전체 점검 113회차 — 108(서버 공용 유틸) · 109(설치 · 패키징 · uagmon · release.sh) 수정에 대한 적대적 재검토(반증) 회귀.
 *
 *  R1 util/sshKeyKdf — 108회차 A6 수정이 만든 **회귀**: 머리를 '앞 64KB **글자**' 로 잘라 풀었다. 디코더가 건너뛰는 글자(공백 · 줄바꿈 · '!')를
 *     본문 앞에 6만 5천 자 넘게 채우면 사전 검사는 '빈 머리 = 검사 대상 아님' 으로 통과시키고, ssh2 는 그 글자를 건너뛰어 rounds 만큼 bcrypt 를 돈다
 *     (rounds 256 · 채움 7만 자: 사전 검사 null · parseKey 3.4초 — 108 전 판본은 글자를 지우고 풀어 이 입력을 거절했다).
 *     통합 계정 '키 검사'(POST /tools/credentials/inspect-key)는 길이 상한 없이 이 검사만 믿는다 → base64 글자 수로 자른다.
 *  R2 packaging/offline/install.sh vp_link — 설명을 `$4` 로 읽는데 부르는 곳은 인자를 셋만 준다. set -u 라 첫 링크를 건 직후 'unbound variable' 로
 *     **설치가 1 로 끝났다**(vmware-portal-verify · -users 링크, firewalld 포트 허용, 완료 · 최초 로그인 안내가 빠진다). install.sh 를 root 로
 *     통째 실행(overlay chroot — 스크래치 wholerun.sh)해서 찾았다 — 구간 실행 테스트는 이 함수를 부르지 않았다.
 *  R3 install.sh vp_stage_tree(109회차 A-2 가 만든 함수) — 지난 설치의 찌꺼기(node.new)를 지우지 못하면(이 함수는 `||` · `if !` 안에서 불려
 *     set -e 가 rm 실패를 보지 않는다) cp -a 가 그 폴더 **안으로** 복사해 runtime/node/node/… 가 놓였다 — bin/node 없는 런타임으로 설치가 0 으로 끝났다.
 *  R4 util/exportPrefs(108회차가 남긴 것 E5) — 읽기 오류(EIO · EACCES · EMFILE)도 손상처럼 원본을 `.corrupt.*` 로 **옮겼다** → 재시작 뒤 전 계정 저장값이 빈 채.
 *  R5 install.sh 설정 이전 — 첫 설치(BAK 가 비어 있다)의 첫 원본 후보가 '/server/config/<파일>'(파일시스템 루트)이었다.
 *
 * ⚠ install.sh 통째 실행(root · overlay chroot · 가짜 systemctl)은 이 파일에 넣지 않았다 — root 와 마운트 네임스페이스가 필요하다(CI 는 root 가 아니다).
 *   R2 는 그 실행이 찾은 것을 구간 실행 + '위치 인자 수' 스윕으로 고정한다.
 *
 *  확인만 한 것(결함 없음 — 고정해 둔다): envRedact 가림 → 복원 왕복(LF · CRLF · CR) · ssrfBlockReason 의 정상 주소.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rebut113-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_DIR = TMP;
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const require = createRequire(import.meta.url);

/* ── R1 sshKeyKdf ───────────────────────────────────────────────────────── */
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const sstr = (b) => { const x = Buffer.isBuffer(b) ? b : Buffer.from(b); return Buffer.concat([u32(x.length), x]); };
/** openssh-key-v1 모양(aes256-ctr · bcrypt · rounds). */
function craftKey(rounds) {
  const opts = Buffer.concat([sstr(Buffer.alloc(16, 7)), u32(rounds)]);
  return Buffer.concat([Buffer.from('openssh-key-v1\0', 'latin1'), sstr('aes256-ctr'), sstr('bcrypt'), sstr(opts), u32(1), sstr(Buffer.alloc(51, 1)), sstr(Buffer.alloc(160, 2))]).toString('base64');
}
const wrap = (body) => `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`;
/** ssh2 가 실제로 읽는 방식(keyParser.js — 본문 전체를 Buffer.from(…, 'base64'))으로 본 bcrypt rounds. bcrypt 머리가 아니면 null. */
function roundsAsSsh2(pem) {
  const m = /^-----BEGIN OPENSSH PRIVATE KEY-----(?:\r\n|\n)([\s\S]+)(?:\r\n|\n)-----END OPENSSH PRIVATE KEY-----$/.exec(pem.trim());
  if (!m) return null;
  const d = Buffer.from(m[1], 'base64');
  if (d.length < 31 || d.toString('latin1', 0, 15) !== 'openssh-key-v1\0') return null;
  let off = 15;
  const s = () => { if (off + 4 > d.length) return null; const n = d.readUInt32BE(off); off += 4; if (off + n > d.length) return null; const v = d.subarray(off, off + n); off += n; return v; };
  const cipher = s(); const kdf = s(); const o = s();
  if (!cipher || !kdf || !o || kdf.toString('latin1') !== 'bcrypt' || o.length < 8) return null;
  const sl = o.readUInt32BE(0);
  return 4 + sl + 4 > o.length ? null : o.readUInt32BE(4 + sl);
}

test('R1 sshKeyKdf — 본문 앞에 디코더가 건너뛰는 글자를 6만 5천 자 넘게 채워도 ssh2 가 읽는 그 rounds 를 읽는다(상한 우회 없음)', async () => {
  const { opensshKdfRounds, sshKdfRoundsIssue } = await import('../src/util/sshKeyKdf.js');
  const b64 = craftKey(65_536);
  for (const [name, pad] of [['공백', ' '], ['줄바꿈', '\n'], ['CRLF', '\r\n'], ['탭', '\t'], ['느낌표', '!'], ['점', '.'], ['섞음', ' \n!\t*']]) {
    for (const n of [65_536, 70_000, 300_000]) {
      const pem = wrap(pad.repeat(Math.ceil(n / pad.length)) + b64);
      assert.equal(roundsAsSsh2(pem), 65_536, `전제(${name} ${n}): ssh2 는 채운 글자를 건너뛰고 rounds 65,536 키로 읽는다`);
      assert.equal(opensshKdfRounds(pem), 65_536, `${name} ${n}자: 사전 검사도 같은 값을 읽는다`);
      assert.match(String(sshKdfRoundsIssue(pem)), /상한/, `${name} ${n}자: 거절`);
    }
  }
  // 줄마다 채움이 낀 꼴(본문 글자 사이사이) — 머리가 64KB 글자 밖으로 밀려나도 같다
  const spread = wrap(b64.split('').join(' '.repeat(2_000)));
  assert.equal(roundsAsSsh2(spread), 65_536); assert.equal(opensshKdfRounds(spread), 65_536);
});

test('R1 sshKeyKdf — 채움 글자 0~255 · 그 밖 표본 전부에서 사전 검사 = ssh2 가 읽는 값(디코더가 건너뛰는 글자를 글자로 세지 않는다)', async () => {
  const { opensshKdfRounds } = await import('../src/util/sshKeyKdf.js');
  const b64 = craftKey(4_096);
  const codes = [...Array(256).keys(), 0x100, 0x120, 0x141, 0x16f, 0x2028, 0x2029, 0x3000, 0xfeff, 0xff21, 0xff0b, 0xffff];
  const diff = [];
  for (const c of codes) {
    const pem = wrap(String.fromCharCode(c).repeat(66_000) + b64);
    const a = roundsAsSsh2(pem); const b = opensshKdfRounds(pem);
    if (a !== b) diff.push(`U+${c.toString(16)}: ssh2 ${a} · 사전 검사 ${b}`);
  }
  assert.deepEqual(diff, []);
  // 앞부분만 풀어도 전체의 앞부분과 같다는 전제('=' · 잡글자가 섞여도) — Node 디코더가 바뀌면 여기서 드러난다
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_= \n!';
  for (let i = 0; i < 300; i++) {
    let s = ''; const len = 200 + Math.floor(rnd() * 600);
    for (let j = 0; j < len; j++) s += ALPH[Math.floor(rnd() * ALPH.length)];
    const cut = Math.floor(rnd() * len);
    const full = Buffer.from(s, 'base64'); const head = Buffer.from(s.slice(0, cut), 'base64');
    assert.ok(full.subarray(0, head.length).equals(head), `앞부분 디코드가 전체의 앞부분이 아니다: ${JSON.stringify(s.slice(0, 60))} cut=${cut}`);
  }
});

test('R1 sshKeyKdf — 실제 ssh2: 공백 7만 자를 채운 rounds 1,024 키는 bcrypt 를 돌리기 전에 거절된다 · 정상 키(암호 없음 · rounds 16 · 64)는 그대로 통과', async () => {
  const { inspectPrivateKey } = await import('../src/security/credentialStore.js');
  const { sshKdfRoundsIssue, opensshKdfRounds } = await import('../src/util/sshKeyKdf.js');
  const pem = wrap(' '.repeat(70_000) + craftKey(1_024));
  const t0 = performance.now(); const r = inspectPrivateKey(pem, 'pw'); const ms = performance.now() - t0;
  assert.equal(r.ok, false); assert.match(r.reason, /상한/);
  assert.ok(ms < 1_500, `bcrypt 1,024회(10초대)를 돌리지 않는다(${ms.toFixed(0)}ms)`);
  // 진짜 키(ssh2 가 만든 것) — KDF 사전 검사가 새로 거절하지 않는다.
  //   ⚠ ssh2 1.17 의 generateKeyPairSync 는 약 1/256 로 **자기 parseKey 가 Malformed 로 거절하는 키**를 만든다(실측 800개 중 3개 — ed25519).
  //     그래서 '파싱 성공' 을 단정하지 않고, 실패했다면 그 사유가 KDF 검사가 아님만 본다(사전 검사 값은 800개 전부 맞았다).
  const ssh2 = require('ssh2');
  const notKdf = (r) => assert.ok(r.ok || !/KDF/.test(String(r.reason)), `KDF 검사가 정상 키를 거절했다: ${r.reason}`);
  const plain = ssh2.utils.generateKeyPairSync('ed25519');
  assert.equal(sshKdfRoundsIssue(plain.private), null); assert.equal(opensshKdfRounds(plain.private), null);
  notKdf(inspectPrivateKey(plain.private));
  for (const rounds of [16, 64]) {
    const enc = ssh2.utils.generateKeyPairSync('ed25519', { passphrase: 'pw-113', cipher: 'aes256-ctr', rounds });
    assert.equal(opensshKdfRounds(enc.private), rounds, `rounds ${rounds}`);
    assert.equal(sshKdfRoundsIssue(enc.private), null);
    // 앞뒤 공백 · CRLF 로 붙여 넣은 꼴도 같다
    assert.equal(opensshKdfRounds(`\n  ${enc.private.replace(/\n/g, '\r\n')}\r\n`), rounds);
  }
  const rsa = ssh2.utils.generateKeyPairSync('rsa', { bits: 2048, passphrase: 'pw-113', cipher: 'aes256-ctr', rounds: 16 });
  assert.equal(sshKdfRoundsIssue(rsa.private), null); assert.equal(opensshKdfRounds(rsa.private), 16);
  notKdf(inspectPrivateKey(rsa.private, 'pw-113'));
});

/* ── R2 · R3 install.sh ─────────────────────────────────────────────────── */
const INSTALL = rd('packaging/offline/install.sh');
function region(from, to) {
  const a = INSTALL.indexOf(`\n${from}`);
  const b = INSTALL.indexOf(`\n${to}`, a + 1);
  assert.ok(a >= 0 && b > a, `install.sh 구간을 찾지 못했다: ${from} ~ ${to}`);
  return INSTALL.slice(a + 1, b + 1);
}
const mk = (d, files) => { for (const f of files) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), 'x'); } return d; };

test('R2 install.sh vp_link — set -u 아래에서 세 콘솔 도구 링크가 모두 걸리고 설치가 계속된다(예전: 첫 링크 직후 $4 unbound variable 로 1)', () => {
  const d = fs.mkdtempSync(path.join(TMP, 'link-'));
  const tools = path.join(d, 'tools'); const app = path.join(d, 'app');
  for (const n of ['vmware-portal-otp', 'vmware-portal-verify', 'vmware-portal-users']) { mk(tools, [n]); fs.chmodSync(path.join(tools, n), 0o755); }
  for (const n of ['otp-enroll.sh', 'release-verify.sh', 'user-admin.sh']) { mk(app, [n]); fs.chmodSync(path.join(app, n), 0o755); }
  // 링크는 실제로 걸지 않는다(/usr/local/bin) — ln 만 가짜로 바꾸고 나머지(인자 · set -u · 판정)는 install.sh 그대로다.
  const body = region('vp_link() {', '# 7) firewalld');
  const script = `set -euo pipefail\nln() { echo "LN $*"; }\nTOOLS_DIR="$1"; APP_DST="$2"\n${body}\necho REACHED-END`;
  const r = spawnSync('bash', ['-c', script, '_', tools, app], { encoding: 'utf8' });
  assert.equal(r.status, 0, `install.sh 가 링크 단계에서 끝났다: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /unbound variable/);
  assert.match(r.stdout, /REACHED-END/, '링크 뒤 단계(7 firewalld · 완료 안내)까지 간다');
  for (const [name, label] of [['vmware-portal-otp', 'OTP 등록 도구'], ['vmware-portal-verify', '패키지 서명 확인 도구'], ['vmware-portal-users', '계정 관리 메뉴']]) {
    assert.match(r.stdout, new RegExp(`LN -sfn ${tools.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${name} /usr/local/bin/${name}`), `${name} 링크`);
    assert.match(r.stdout, new RegExp(`==> ${label}: ${name} `), `${name} 안내 줄에 설명이 실린다`);
  }
});

test('R2 install.sh — 함수가 쓰는 위치 인자($N)보다 적게 주는 호출이 없다(set -u — 통째 실행해야만 드러나던 꼴)', () => {
  const code = INSTALL.split('\n').map((l) => (/^\s*#/.test(l) ? '' : l)).join('\n');
  const defs = [...code.matchAll(/^(vp_[a-z_0-9]+)\(\) \{/gm)].map((m) => m[1]);
  assert.ok(defs.includes('vp_link') && defs.includes('vp_stage_tree'), '전제: 함수 정의를 찾는다');
  const bad = [];
  for (const name of defs) {
    const a = code.indexOf(`\n${name}() {`);
    const oneLine = code.slice(a + 1, code.indexOf('\n', a + 1));
    const end = /\}\s*$/.test(oneLine) ? code.indexOf('\n', a + 1) : code.indexOf('\n}\n', a + 1);
    const bodyText = code.slice(a, end);
    // 기본값 없이 읽는 위치 인자의 최댓값("$3" · $3 — "${3:-…}" 는 없어도 된다)
    const need = Math.max(0, ...[...bodyText.matchAll(/\$([1-9])(?![0-9])/g)].map((m) => Number(m[1])));
    if (!need) continue;
    const rest = code.slice(0, a) + code.slice(end);
    for (const m of rest.matchAll(new RegExp(`(?:^|[;&|]\\s*|then\\s+|if\\s+!?\\s*|\\$\\()${name}((?:[ \\t]+(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s;&|)"']+))*)`, 'gm'))) {
      const args = m[1].match(/"[^"\n]*"|'[^'\n]*'|[^\s;&|)"']+/g) || [];
      if (args.some((x) => /^\$@$|^"\$@"$/.test(x))) continue;
      if (args.length < need) bad.push(`${name} 은 $${need} 까지 읽는데 인자 ${args.length}개: ${m[0].trim().slice(0, 90)}`);
    }
  }
  assert.deepEqual(bad, []);
});

const SWAP_REGION = region('# 2) Runtime', '# 4) Config');
test('R3 install.sh vp_stage_tree — 지난 설치의 찌꺼기를 지우지 못하면 멈춘다(그 안으로 복사해 bin/node 없는 런타임을 놓지 않는다)', () => {
  const d = fs.mkdtempSync(path.join(TMP, 'stage-'));
  const pkg = mk(path.join(d, 'pkg'), ['runtime/node/bin/node', 'app/server/src/index.js', 'app/package.json']);
  fs.writeFileSync(path.join(pkg, 'runtime/node/bin/node'), 'NEW-NODE');
  const prefix = mk(path.join(d, 'prefix'), ['runtime/node/bin/node', 'app/package.json', 'runtime/node.new/stale/f']);
  fs.writeFileSync(path.join(prefix, 'runtime/node/bin/node'), 'OLD-NODE');
  fs.writeFileSync(path.join(prefix, 'app/package.json'), 'OLD-APP');
  // 임시 폴더(node.new)만 지워지지 않는다 — 변경 불가 속성 · 마운트 지점 흉내(실제 rm 은 그런 폴더에서 1 을 돌려준다)
  const shim = 'rm() { if [[ "$*" == *"node.new"* ]]; then echo "rm: cannot remove: Operation not permitted" >&2; return 1; fi; command rm "$@"; }';
  const script = `set -euo pipefail\n${shim}\nSCRIPT_DIR="$1"; PREFIX="$2"\n${SWAP_REGION}\necho "BAK=$BAK"`;
  const r = spawnSync('bash', ['-c', script, '_', pkg, prefix], { encoding: 'utf8' });
  assert.notEqual(r.status, 0, '찌꺼기를 못 지웠는데 설치가 계속됐다');
  assert.match(r.stderr, /임시 폴더.*지우지 못했습니다/);
  assert.equal(fs.readFileSync(path.join(prefix, 'runtime/node/bin/node'), 'utf8'), 'OLD-NODE', '기존 런타임 그대로');
  assert.equal(fs.readFileSync(path.join(prefix, 'app/package.json'), 'utf8'), 'OLD-APP', '기존 앱 그대로');
  assert.equal(fs.existsSync(path.join(prefix, 'runtime/node/node')), false, '런타임 자리에 중첩 폴더(node/node)가 놓이지 않는다');
  assert.equal(fs.readdirSync(prefix).some((n) => n.startsWith('app.bak.')), false, '앱 백업도 만들지 않았다(무변경)');
  // 찌꺼기를 지울 수 있으면 예전처럼 정상 교체(109회차 A-2 동작 유지)
  const ok = spawnSync('bash', ['-c', `set -euo pipefail\nSCRIPT_DIR="$1"; PREFIX="$2"\n${SWAP_REGION}`, '_', pkg, prefix], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(fs.readFileSync(path.join(prefix, 'runtime/node/bin/node'), 'utf8'), 'NEW-NODE');
  assert.equal(fs.existsSync(path.join(prefix, 'runtime/node/stale')), false);
  assert.equal(fs.existsSync(path.join(prefix, 'runtime/node.new')), false);
});

test('R5 install.sh 설정 이전 — 첫 설치(백업 없음)에서 파일시스템 루트(/server/config)를 원본 후보로 보지 않는다 · 백업이 있으면 백업 → 새 앱 순서 그대로', () => {
  const a = INSTALL.indexOf('\nfor f in vcenters.json users.json upgrade.json; do');
  const b = INSTALL.indexOf('\ndone\n', a);
  assert.ok(a >= 0 && b > a, 'install.sh 의 설정 이전 구간을 찾지 못했다');
  const loop = INSTALL.slice(a + 1, b + 6);
  const d = fs.mkdtempSync(path.join(TMP, 'mig-'));
  const app = mk(path.join(d, 'app'), ['server/config/users.json']);
  const bak = mk(path.join(d, 'app.bak.1'), ['server/config/users.json', 'server/config/vcenters.json']);
  const cfg = path.join(d, 'cfg'); fs.mkdirSync(cfg);
  // vp_cfg_state 1 = 그 설정 파일이 아직 없다 · vp_cfg_copy_new 는 무엇을 어디로 옮기려 했는지만 적는다. 판정 줄은 xtrace 로 본다.
  const run = (bakDir) => spawnSync('bash', ['-c', `set -euo pipefail\nvp_cfg_state() { return 1; }\nvp_cfg_copy_new() { echo "COPY $1"; }\nBAK="$1"; APP_DST="$2"; CONFIG_DIR="$3"\nset -x\n${loop}`, '_', bakDir, app, cfg], { encoding: 'utf8' });
  const first = run('');
  assert.equal(first.status, 0, first.stderr);
  assert.doesNotMatch(first.stderr, /-f \/server\/config\//, '백업이 없는데 /server/config/… 를 살폈다');
  assert.deepEqual(first.stdout.split('\n').filter((l) => l.startsWith('COPY ')), [`COPY ${app}/server/config/users.json`], '첫 설치는 새 앱의 옛 위치만 본다');
  const re = run(bak);
  assert.equal(re.status, 0, re.stderr);
  assert.deepEqual(re.stdout.split('\n').filter((l) => l.startsWith('COPY ')), [`COPY ${bak}/server/config/vcenters.json`, `COPY ${bak}/server/config/users.json`], '재설치는 백업 것이 먼저');
});

/* ── R4 exportPrefs ─────────────────────────────────────────────────────── */
test('R4 exportPrefs — 읽기 오류(EIO)는 손상이 아니다: 원본을 옮기지 않고 · 쓰기 503 · 다시 읽히면 원본 값으로 풀린다(손상은 예전처럼 보존)', async () => {
  const RD = await import('../src/util/jsonFileRead.js');
  let NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;   // 실제 시각에서 정시 경계로 떨어뜨려 고정
  RD._setJsonFileLoadClockForTest(() => NOW);
  const { createExportPrefs } = await import('../src/util/exportPrefs.js');
  const spec = { resolveCols: (c) => (Array.isArray(c) && c.length ? { ok: true, keys: c.map(String) } : { ok: false, reason: '항목 없음' }), knownKeys: (c) => ({ keys: Array.isArray(c) ? c : [], dropped: 0 }), normalizeOpts: () => ({ ok: true, value: {} }) };
  const NAME = 'rebut113-prefs.json'; const FILE = path.join(TMP, NAME);
  const corrupt = () => fs.readdirSync(TMP).filter((x) => x.startsWith(`${NAME}.corrupt.`));
  const origText = JSON.stringify({ v: 1, users: { 'u:kim': { def: { name: '기본값', cols: ['a', 'b'] }, slots: [null, null, null, null, null], at: '2026-11-01T00:00:00.000Z' } } });
  fs.writeFileSync(FILE, origText);
  const P = createExportPrefs({ fileName: NAME, ...spec });
  const orig = fs.readFileSync;
  const warn = console.warn; const err = console.error; console.warn = () => {}; console.error = () => {};
  try {
    // 파일은 그대로 있는데 읽기만 실패(권한 · 디스크 · fd 고갈)
    fs.readFileSync = (f, ...a) => { if (path.basename(String(f)) === NAME) { const e = new Error('EIO: i/o error, read'); e.code = 'EIO'; throw e; } return orig.call(fs, f, ...a); };
    const g = P.getPrefs('kim');
    assert.equal(g.unreadable, true, '못 읽음을 알린다'); assert.equal(g.def, null);
    assert.equal(P.prefsUnreadable(), true);
    fs.readFileSync = orig;
    assert.deepEqual(corrupt(), [], '읽기 오류에 원본을 .corrupt.* 로 옮기지 않는다');
    assert.equal(orig.call(fs, FILE, 'utf8'), origText, '원본 그대로');
    fs.readFileSync = (f, ...a) => { if (path.basename(String(f)) === NAME) { const e = new Error('EIO: i/o error, read'); e.code = 'EIO'; throw e; } return orig.call(fs, f, ...a); };
    const no = P.setPref('lee', 1, { cols: ['x'] });
    assert.equal(no.ok, false); assert.equal(no.status, 503); assert.equal(no.code, 'prefsUnreadable');
    assert.match(no.reason, /읽기 오류 EIO.*원본은 그대로/);
    assert.equal(P.clearPref('kim', 'default').status, 503);
    fs.readFileSync = orig;
    assert.equal(orig.call(fs, FILE, 'utf8'), origText, '쓰기 거절 — 빈 값 위에 덮지 않았다');
    // 간격 안에는 디스크를 다시 보지 않고, 간격이 지나면 다시 읽어 풀린다
    assert.equal(P.getPrefs('kim').unreadable, true, '간격 안 — 아직 못 읽음');
    NOW += RD.READ_RETRY_MS + 1_000;
    const back = P.getPrefs('kim');
    assert.equal(back.unreadable, undefined); assert.deepEqual(back.def.cols, ['a', 'b'], '원본 값으로 풀린다');
    const yes = P.setPref('lee', 1, { cols: ['x'] });
    assert.equal(yes.ok, true);
    const saved = JSON.parse(orig.call(fs, FILE, 'utf8'));
    assert.deepEqual(Object.keys(saved.users).sort(), ['u:kim', 'u:lee'], '기존 계정 값을 지우지 않고 더했다');
    // 손상(JSON 이 아님)은 예전처럼: 옆에 보존 + 쓰기 거절
    fs.writeFileSync(FILE, '{broken');
    P._resetForTest();
    assert.equal(P.getPrefs('kim').unreadable, true);
    assert.equal(corrupt().length, 1, '손상본은 보존한다');
    const no2 = P.setPref('lee', 2, { cols: ['x'] });
    assert.equal(no2.status, 503); assert.match(no2.reason, /손상 사본/);
    // 모양이 틀린 JSON 도 손상(보존본 이름은 ms 시각이라 같은 ms 면 겹친다 — 앞의 것을 지우고 센다)
    for (const c of corrupt()) fs.rmSync(path.join(TMP, c));
    fs.writeFileSync(FILE, JSON.stringify({ v: 1, users: [] }));
    P._resetForTest();
    assert.equal(P.prefsUnreadable(), true); assert.equal(corrupt().length, 1);
    // 파일 없음은 빈 값 + 쓰기 가능
    P._resetForTest();
    assert.equal(P.prefsUnreadable(), false);
    assert.equal(P.setPref('kim', 'default', { cols: ['z'] }).ok, true);
  } finally { fs.readFileSync = orig; console.warn = warn; console.error = err; RD._setJsonFileLoadClockForTest(); }
});

/* ── 확인만 한 것(결함 없음) — 고정 ─────────────────────────────────────── */
test('확인 envRedact(108회차 A3) — 가림 → 복원 왕복이 LF · CRLF · CR · 끝 줄바꿈 유무 · export · 따옴표 · 값 안 = 에서 원문과 같다', async () => {
  const { redactEnvSecrets, mergeRedactedEnv, pinHostSecurityEnv, REDACTED } = await import('../src/util/envRedact.js');
  let seed = 113; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const KEYS = ['PORT', 'AUTH_SECRET', 'SECRETS_KEY', 'CENTRAL_TOKEN', 'SMTP_PASSWORD', 'NODE_ENV', 'X_KEY', 'DB_PWD', 'TITLE'];
  const VALS = ['abc', 'a=b=c', '"quoted value"', "'single'", '  spaced  ', 'true', 'x#y', 'a\tb', '한글'];
  for (let i = 0; i < 400; i++) {
    const keys = [...KEYS].sort(() => rnd() - 0.5).slice(0, 1 + Math.floor(rnd() * KEYS.length));
    const lines = [];
    for (const k of keys) {
      if (rnd() < 0.2) lines.push(pick(['', '# 주석 AUTH_SECRET=zzz', '   ', 'no equals here']));
      lines.push(pick(['', '', 'export ', '  ']) + k + pick(['=', ' = ', '= ']) + pick(VALS));
    }
    const base = lines.join('\n') + pick(['', '\n', '\n\n']);
    for (const eol of ['\n', '\r\n', '\r']) {
      const src = base.replace(/\n/g, eol);
      const red = redactEnvSecrets(src);
      for (const k of red.keys) assert.ok(new RegExp(`${k}\\s*=\\s*${REDACTED.replace(/[<>-]/g, '\\$&')}`).test(red.text), `${k} 가려짐`);
      assert.equal(red.redacted, keys.filter((k) => /(SECRET|TOKEN|PASSWORD|_KEY|_PWD)$/.test(k)).length, `가린 개수(${JSON.stringify(eol)})`);
      const back = mergeRedactedEnv(red.text, src);
      assert.equal(back.text, src, `왕복이 원문과 다르다(${JSON.stringify(eol)}): ${JSON.stringify(src)}`);
      assert.deepEqual(back.dropped, []);
      // 고정 키가 없는 문서는 호스트 고정을 거쳐도 글자가 같다
      assert.equal(pinHostSecurityEnv(back.text, src).text, src);
    }
  }
});

test('확인 ssrfBlockReason(108회차 A1 · A2) — 정상 주소 표기는 새로 막히지 않는다', async () => {
  const { ssrfBlockReason } = await import('../src/util/ssrfBlock.js');
  for (const ok of ['vc01.corp.local', 'vc01.corp.local:8080', '10.1.2.3:443', 'https://10.1.2.3', 'HTTPS://VC01.Corp.Local:8443/x', 'http://192.168.0.10:4000/dl',
    'http-proxy.corp:3128', 'https.internal:443', 'httpd', 'edge-pl/path', 'example.com.', 'http://user:pw@vc01.corp.local/', 'mylocalhost', 'localhost.corp:4000', 'notlocalhost.']) {
    assert.equal(ssrfBlockReason(ok), null, ok);
  }
  for (const bad of ['http:/169.254.169.254/x?a=b://c', 'http:\\\\127.0.0.1', 'http:/\t/[::1]/', 'localhost.', 'app.localhost.:8080', 'http://127.0.0.1.', 'http://a@b@127.0.0.1/']) {
    assert.ok(ssrfBlockReason(bad), bad);
  }
});
