// 보안 잔여 11-27 G4 — Node 런타임 22.23.5 갱신 · 번들 런타임 해시 고정 · 보안 하한 경고 · 웹 source-map-js.
//
// 고정하는 것:
//   T1 계약 — releaseVersion · securityFloor 닻('22.23.5') · minVersion ≤ securityFloor ≤ releaseVersion.
//   T2 버전 스윕 — 고정 목록 파일 안의 모든 22.x.y 가 releaseVersion(또는 minVersion)과 같다(허용 목록 방식 — 굵은 글씨·괄호·주석 꼴도 잡는다)
//      + 저장소 전체(git ls-files · 역사 기록 제외)의 'node-v22.x.y' · 'NODE_VERSION/node-version … 22.x.y' 꼴.
//   T3 핀 파일 · 정적 순서 — packaging/node-runtime.sha256 두 줄(닻 해시) · 빌드 스크립트가 풀기 전에 대조 · release.yml Windows 단계.
//   T4 빌드 스크립트 실제 실행(네트워크 없음 — 가짜 curl) — 가짜 압축본은 풀기 전에 막힌다 · --node-sha256 · 형식 오류 · 온라인 분기 · Windows zip.
//   T5 판정 · 노출 — belowSecurityFloor · 서비스 점검 행 · 기동 로그 · /health 모양(비관리자 state 하나).
//   T7 web/package-lock.json source-map-js ≥ 1.2.2(GHSA-68fv-2mgg-jv7q).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  RUNTIME_CONTRACT, parseNodeVersion, judgeVersion, overallState, runtimeStatus, runtimeForHealth, runtimeServiceRow,
  runtimeLogLine, runRuntimeSelfCheck, startRuntimeCheck, _resetRuntimeCheckForTest,
} from '../src/util/runtimeCheck.js';

const SERVER = path.resolve(new URL('..', import.meta.url).pathname);
const ROOT = path.resolve(SERVER, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const REL = RUNTIME_CONTRACT.releaseVersion;
const FLOOR = RUNTIME_CONTRACT.securityFloor;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const PIN = 'packaging/node-runtime.sha256';
const BUILD = 'packaging/offline/build-package.sh';
const WIN = 'packaging/windows/build-collector-win.sh';
/** 셸 주석 줄과 줄 끝 주석을 뗀다(따옴표 안의 # 은 이 스크립트들에 없다 — '#' 다음이 공백인 경우만 주석으로 본다). */
const stripSh = (t) => t.split('\n').map((l) => (/^\s*#/.test(l) ? '' : l.replace(/\s#\s.*$/, ''))).join('\n');

test('T1 계약 — 검증 버전 · 보안 하한 닻과 불변조건', () => {
  assert.equal(REL, '22.23.5', '닻: 검증 버전');
  assert.equal(FLOOR, '22.23.5', '닻: 보안 하한(22.23.4 · 22.23.5 보안 릴리스를 모두 담은 가장 낮은 패치)');
  const c = (a, b) => { const x = parseNodeVersion(a); const y = parseNodeVersion(b); return (x.major - y.major) || (x.minor - y.minor) || (x.patch - y.patch); };
  assert.ok(c(RUNTIME_CONTRACT.minVersion, FLOOR) <= 0, 'minVersion ≤ securityFloor');
  assert.ok(c(FLOOR, REL) <= 0, 'securityFloor ≤ releaseVersion (검증 버전이 보안 하한 미만이면 새 설치본이 경고를 낸다)');
  assert.ok(RUNTIME_CONTRACT.supportedMajors.includes(parseNodeVersion(FLOOR).major), '보안 하한은 지원 major 의 버전');
  assert.ok(Object.isFrozen(RUNTIME_CONTRACT));
  assert.equal(runtimeStatus().contract.securityFloor, FLOOR, '관리자 판본 계약에 하한이 실린다');
});

/** 파일 안의 모든 22.x.y 중 허용 목록(검증 버전 · 기술적 하한 · 파일별 예외) 밖을 모은다 — 굵은 글씨 · 괄호 · 주석 · 어순과 무관(허용 목록 방식). */
function strayVersions(files) {
  const bad = [];
  for (const [f, extra] of Object.entries(files)) {
    const allow = new Set([REL, RUNTIME_CONTRACT.minVersion, ...extra]);
    read(f).split('\n').forEach((l, i) => {
      for (const m of l.matchAll(/(?<![\d.])22\.\d+\.\d+(?!\d)/g)) if (!allow.has(m[0])) bad.push(`${f}:${i + 1} ${m[0]}`);
    });
  }
  return bad;
}

test('T2b 공유 설치 문서 — docs/INSTALL.md · docs/NETWORK-COMMS-FIREWALL.md 의 22.x.y 도 검증 버전(메인이 문서 변경을 같은 머지에 싣는다)', () => {
  assert.deepEqual(strayVersions({
    'docs/INSTALL.md': ['22.22.2'], // A.2 의 '22.22.2 에서 확인' — 그 버전에서 관찰한 사실(고정값 아님)
    'docs/NETWORK-COMMS-FIREWALL.md': [],
  }), [], `검증 버전(${REL})과 다른 22.x.y`);
});

test('T2 버전 스윕 — 고정 목록 파일의 모든 22.x.y 는 검증 버전(또는 기술적 하한)', () => {
  // 역사 기록(release-notes.json · docs/rules/audits.md · security_check_*.MD · docs/PERF-AUDIT-*)은 그 시점의 사실이라 넣지 않는다.
  const bad = strayVersions({
    '.nvmrc': [], '.node-version': [],
    '.github/workflows/ci.yml': [], '.github/workflows/release.yml': [], '.github/workflows/bareos-bundle.yml': [],
    [BUILD]: [], [WIN]: [], [PIN]: [],
    'packaging/README.md': [], 'packaging/offline/OFFLINE-INSTALL.md': [], 'packaging/DISTRIBUTED-COLLECTION.md': [],
    'README.md': [],
  });
  assert.deepEqual(bad, [], `검증 버전(${REL})과 다른 22.x.y`);
  for (const f of ['.nvmrc', '.node-version']) assert.equal(read(f).trim(), REL, f);
  // 워크플로 셋 다(bareos-bundle 포함 — 예전 시험 밖이었다)
  for (const f of ['.github/workflows/release.yml', '.github/workflows/bareos-bundle.yml']) {
    assert.match(read(f), new RegExp(`\\n\\s*NODE_VERSION: '${esc(REL)}'\\n`), f);
  }
  assert.match(read('.github/workflows/ci.yml'), new RegExp(`node-version: '${esc(REL)}'`));

  // 저장소 전체 — 새 파일이 버전을 박아도 잡는다(꼴 기반 · 역사 기록 제외).
  const ls = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(ls.status, 0, ls.stderr);
  const HIST = [/^server\/src\/release-notes\.json$/, /^release-notes\.json$/, /^docs\/rules\//, /^security_check_/, /^docs\/PERF-AUDIT-/,
    /package-lock\.json$/, /^server\/test\//, /^web\/src\/.*\.test\.js$/, /^docs\/design\//,
    /^docs\/INSTALL\.md$/, /^docs\/NETWORK-COMMS-FIREWALL\.md$/]; // 공유 설치 문서는 T2b 가 따로(더 엄격하게) 본다
  const hits = [];
  for (const f of ls.stdout.split('\0').filter(Boolean)) {
    if (HIST.some((r) => r.test(f))) continue;
    if (!/\.(md|MD|sh|ya?ml|txt|ps1|bat|js|mjs|cjs|json|sha256)$|^\.nvmrc$|^\.node-version$/.test(path.basename(f)) && !/^\.(nvmrc|node-version)$/.test(f)) continue;
    let t;
    try { t = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    if (t.length > 3_000_000) continue;
    for (const m of t.matchAll(/node-v(22\.\d+\.\d+)|(?:NODE_VERSION|node-version)[^0-9\n]{0,40}(22\.\d+\.\d+)/g)) {
      const v = m[1] || m[2];
      if (v !== REL) hits.push(`${f}: ${m[0].slice(0, 80)}`);
    }
  }
  assert.deepEqual(hits, [], '저장소의 Node 버전 고정 꼴이 검증 버전과 다르다');
});

test('T3 핀 파일 — 두 줄 · 닻 해시 · 빌드가 풀기 전에 대조(정적 순서)', () => {
  const rows = read(PIN).split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  assert.deepEqual(rows, [
    `cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8  node-v${REL}-linux-x64.tar.xz`,
    `4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3  node-v${REL}-win-x64.zip`,
  ], '닻: nodejs.org v22.23.5 SHASUMS256.txt(서명 확인) 그대로 — 버전을 올리면 이 닻도 함께 바꾼다');

  const b = stripSh(read(BUILD));
  assert.match(b, new RegExp(`\\nVERIFIED_NODE_VERSION="${esc(REL)}"\\n`), 'build-package.sh 검증 버전 변수');
  assert.match(b, /\[\[ "\$BUNDLED_NODE_VER" != "v\$\{VERIFIED_NODE_VERSION\}" \]\]/, '검증 버전 판정은 변수로(리터럴 금지)');
  assert.doesNotMatch(b, /BUNDLED_NODE_VER" != "v\d/, '판정 줄에 숫자 리터럴이 없다');
  assert.match(b, /--node-sha256\) NODE_SHA256="\$2"/);
  assert.doesNotMatch(b, /NODE_SHA256="\$\{NODE_SHA256/, '환경 변수로 명시값을 받지 않는다(셸에 남은 값이 고정값을 건너뛰지 않게)');
  // --node-tarball: 인자 파싱 뒤 · mktemp · 추출보다 먼저
  const iFmt = b.indexOf('^[0-9a-f]{64}$');
  const iTarCall = b.indexOf('vp_node_pin_check "$NODE_TARBALL"');
  const iMktemp = b.indexOf('BUILD_DIR="$(mktemp -d)"');
  const iTarX = b.indexOf('tar -xf "$NODE_TARBALL"');
  assert.ok(iFmt > 0 && iTarCall > iFmt && iTarCall < iMktemp && iMktemp < iTarX, `--node-tarball 핀 순서 ${[iFmt, iTarCall, iMktemp, iTarX]}`);
  // 온라인: SHASUMS 대조 → 핀 → 추출
  const iSums = b.indexOf('sha256sum -c -');
  const iOnCall = b.indexOf('vp_node_pin_check "$BUILD_DIR/${NODE_PKG}.tar.xz"');
  const iTarJ = b.indexOf('tar -xJf "$BUILD_DIR/${NODE_PKG}.tar.xz"');
  assert.ok(iSums > 0 && iOnCall > iSums && iTarJ > iOnCall, `온라인 핀 순서 ${[iSums, iOnCall, iTarJ]}`);

  const w = stripSh(read(WIN));
  assert.match(w, new RegExp(`\\nVERIFIED_NODE_VERSION="${esc(REL)}"\\n`), 'build-collector-win.sh 검증 버전 변수');
  const iPin = w.indexOf('packaging/node-runtime.sha256');
  const iTools = w.indexOf('command -v unzip');
  const iUnzip = w.indexOf('unzip -q "$NODE_ZIP"');
  assert.ok(iPin > 0 && iPin < iTools && iTools < iUnzip, `Windows 핀은 도구 검사 · unzip 보다 먼저 ${[iPin, iTools, iUnzip]}`);

  const rel = read('.github/workflows/release.yml');
  const step = rel.slice(rel.indexOf('- name: Fetch Windows Node runtime'), rel.indexOf('- name: Build Windows collector package'));
  const s = step.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const iShas = s.indexOf('sha256sum -c node-win.sha256');
  const iPinF = s.indexOf('packaging/node-runtime.sha256');
  const iPinC = s.indexOf('sha256sum -c node-win.pin');
  const iMv = s.indexOf('mv "$zip" node-win.zip');
  assert.ok(iShas > 0 && iPinF > iShas && iPinC > iPinF && iMv > iPinC, `release.yml Windows 단계: SHASUMS → 핀 → rename ${[iShas, iPinF, iPinC, iMv]}`);
  assert.match(s, /grep -c \. node-win\.pin\)" = "1"/, '고정값 줄이 정확히 하나여야 한다(없으면 빈 파일 sha256sum -c 가 통과하지 않게)');
});

// ── T4 실제 실행 ───────────────────────────────────────────────────────────────
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sec1127g4-'));
/** 빌드 스크립트를 가짜 저장소 배치(packaging/…)로 복사한다 — REPO_ROOT 가 스크립트 위치에서 정해지므로 핀 파일을 바꿔 볼 수 있다. */
function fakeRepo(pinText) {
  const d = tmp();
  for (const f of [BUILD, WIN]) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(d, f));
  }
  fs.writeFileSync(path.join(d, PIN), pinText ?? read(PIN));
  return d;
}
function run(script, args, { env = {}, pathPrefix } = {}) {
  const base = { ...process.env };
  delete base.NODE_VERSION; delete base.NODE_SHA256; delete base.NODE_TARBALL; delete base.NODE_ZIP; delete base.OFFLINE; delete base.STAMP;
  const PATH = [pathPrefix, path.dirname(process.execPath), base.PATH].filter(Boolean).join(path.delimiter);
  const r = spawnSync('bash', [script, ...args], { env: { ...base, PATH, ...env }, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const fakeBytes = () => crypto.randomBytes(4096);

test('T4 build-package.sh --node-tarball — 저장소 고정값과 다른 압축본은 풀기 전에 막힌다', () => {
  const d = tmp();
  try {
    const tar = path.join(d, `node-v${REL}-linux-x64.tar.xz`); // 이름은 검증 버전이지만 내용이 다르다
    fs.writeFileSync(tar, fakeBytes());
    const out = path.join(d, 'out');
    const r = run(path.join(ROOT, BUILD), ['--offline', '--node-tarball', tar, '--out', out]);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /저장소 고정값\(packaging\/node-runtime\.sha256\)과 다릅니다/, r.err);
    assert.match(r.err, new RegExp(`검증 버전 ${esc(REL)} 의 node-v${esc(REL)}-linux-x64\\.tar\\.xz`));
    assert.doesNotMatch(r.out, /Using local Node\.js tarball|Building offline package/, '추출 · 스테이징 전에 멈춘다');
    assert.equal(fs.existsSync(out), false, '산출물 폴더도 만들지 않는다');

    // 명시값(--node-sha256) — 핀 단계는 통과하고(대문자도 받는다) 그 뒤 추출에서 실패한다(가짜라서)
    const h = sha(fs.readFileSync(tar));
    const r2 = run(path.join(ROOT, BUILD), ['--offline', '--node-tarball', tar, '--node-sha256', h.toUpperCase(), '--out', out]);
    assert.match(r2.out, /--node-sha256 명시값 일치/, r2.out + r2.err);
    assert.match(r2.out, /Using local Node\.js tarball/);
    assert.notEqual(r2.code, 0, '가짜 압축본은 추출에서 실패');
    assert.doesNotMatch(r2.err, /저장소 고정값/);
    // 명시값이 틀리면 거부
    const r3 = run(path.join(ROOT, BUILD), ['--offline', '--node-tarball', tar, '--node-sha256', 'a'.repeat(64), '--out', out]);
    assert.notEqual(r3.code, 0);
    assert.match(r3.err, /--node-sha256 명시값과 다릅니다/);
    assert.doesNotMatch(r3.out, /Using local Node\.js tarball/);
    // 형식 오류는 즉시
    for (const bad of ['xyz', 'a'.repeat(63), `${'a'.repeat(64)}0`, `${'g'.repeat(64)}`, `${'a'.repeat(63)} `]) {
      const r4 = run(path.join(ROOT, BUILD), ['--offline', '--node-tarball', tar, '--node-sha256', bad, '--out', out]);
      assert.notEqual(r4.code, 0, bad);
      assert.match(r4.err, /64자리 16진수/, bad);
    }
    // 환경 변수 NODE_SHA256 은 탈출구가 아니다
    const r5 = run(path.join(ROOT, BUILD), ['--offline', '--node-tarball', tar, '--out', out], { env: { NODE_SHA256: h } });
    assert.notEqual(r5.code, 0);
    assert.match(r5.err, /저장소 고정값/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('T4 build-package.sh --node-tarball — 고정값과 맞으면 통과(이름이 아니라 NODE_VERSION 의 줄로) · 고정되지 않은 버전은 실패', () => {
  const d = tmp();
  try {
    const buf = fakeBytes();
    const tar = path.join(d, 'whatever-name.tar.xz');
    fs.writeFileSync(tar, buf);
    const repo = fakeRepo(`# 시험용\n${sha(buf)}  node-v${REL}-linux-x64.tar.xz\n${'0'.repeat(64)}  node-v${REL}-win-x64.zip\n`);
    const r = run(path.join(repo, BUILD), ['--offline', '--node-tarball', tar, '--out', path.join(d, 'o')]);
    assert.match(r.out, new RegExp(`저장소 고정값 일치\\(node-v${esc(REL)}-linux-x64\\.tar\\.xz\\)`), r.out + r.err);
    assert.match(r.out, /Using local Node\.js tarball/);
    assert.notEqual(r.code, 0, '가짜라 추출에서 실패');
    // 같은 해시라도 다른 버전 줄이면 — 기대 이름은 --node-version 에서 만든다
    const r2 = run(path.join(repo, BUILD), ['--offline', '--node-version', '22.99.1', '--node-tarball', tar, '--out', path.join(d, 'o')]);
    assert.notEqual(r2.code, 0);
    assert.match(r2.err, /Node 22\.99\.1 은 저장소에 고정된 해시가 없습니다/);
    assert.match(r2.err, /NODE_VERSION 환경 변수/);
    assert.doesNotMatch(r2.out, /Using local Node\.js tarball/);
    // 주석 줄에 든 해시는 고정값이 아니다
    const repo2 = fakeRepo(`# ${sha(buf)}  node-v${REL}-linux-x64.tar.xz\n`);
    const r3 = run(path.join(repo2, BUILD), ['--offline', '--node-tarball', tar, '--out', path.join(d, 'o')]);
    assert.notEqual(r3.code, 0);
    assert.match(r3.err, /고정된 해시가 없습니다/);
    // 핀 파일이 없으면 실패(조용히 건너뛰지 않는다)
    fs.rmSync(path.join(repo2, PIN));
    const r4 = run(path.join(repo2, BUILD), ['--offline', '--node-tarball', tar, '--out', path.join(d, 'o')]);
    assert.notEqual(r4.code, 0);
    assert.match(r4.err, /고정값 파일\(packaging\/node-runtime\.sha256\)을 읽지 못했습니다/);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(repo2, { recursive: true, force: true });
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('T4 build-package.sh 온라인 분기(가짜 curl) — SHASUMS 는 통과해도 저장소 고정값과 다르면 풀지 않는다', () => {
  const d = tmp();
  try {
    const buf = fakeBytes();
    const tarSrc = path.join(d, 'src.tar.xz');
    fs.writeFileSync(tarSrc, buf);
    const sums = path.join(d, 'SHASUMS256.txt');
    fs.writeFileSync(sums, `${sha(buf)}  node-v${REL}-linux-x64.tar.xz\n`);
    const bin = path.join(d, 'bin');
    fs.mkdirSync(bin);
    // 가짜 curl: URL 끝으로 무엇을 줄지 고른다(네트워크 없음)
    fs.writeFileSync(path.join(bin, 'curl'), [
      '#!/bin/sh', 'out=""; url=""',
      'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -*) shift;; *) url="$1"; shift;; esac; done',
      'echo "fake-curl $url" >&2',
      'case "$url" in *SHASUMS256.txt) cat "$FAKE_SUMS" > "$out";; *.tar.xz) cat "$FAKE_TAR" > "$out";; *) exit 22;; esac', '',
    ].join('\n'), { mode: 0o755 });
    const env = { FAKE_SUMS: sums, FAKE_TAR: tarSrc };
    const r = run(path.join(ROOT, BUILD), ['--out', path.join(d, 'o')], { env, pathPrefix: bin });
    assert.match(r.err, /fake-curl https:\/\/nodejs\.org\/dist\/v22\.23\.5\/node-v22\.23\.5-linux-x64\.tar\.xz/, '기본값이 검증 버전');
    assert.match(r.out, /checksum OK/, 'SHASUMS(같은 채널) 대조는 통과');
    assert.notEqual(r.code, 0);
    assert.match(r.err, /저장소 고정값\(packaging\/node-runtime\.sha256\)과 다릅니다/, r.err);
    assert.doesNotMatch(r.err, /xz: |tar: |Unexpected EOF|File format not recognized/i, '추출을 시도하지 않는다');
    // 고정값과도 맞으면 추출로 간다(가짜라 거기서 실패)
    const repo = fakeRepo(`${sha(buf)}  node-v${REL}-linux-x64.tar.xz\n`);
    const r2 = run(path.join(repo, BUILD), ['--out', path.join(d, 'o2')], { env, pathPrefix: bin });
    assert.match(r2.out, /checksum OK[\s\S]*저장소 고정값 일치/, r2.out + r2.err);
    assert.notEqual(r2.code, 0);
    assert.doesNotMatch(r2.err, /저장소 고정값\(/);
    // SHASUMS 가 틀리면 그 단계에서 실패(기존 동작 유지)
    fs.writeFileSync(sums, `${'b'.repeat(64)}  node-v${REL}-linux-x64.tar.xz\n`);
    const r3 = run(path.join(repo, BUILD), ['--out', path.join(d, 'o3')], { env, pathPrefix: bin });
    assert.notEqual(r3.code, 0);
    assert.doesNotMatch(r3.out, /checksum OK/);
    fs.rmSync(repo, { recursive: true, force: true });
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('T4 build-collector-win.sh — 고정값에 없는 zip 은 도구 검사 · unzip · 웹 빌드 전에 막힌다(해시로 조회)', () => {
  const d = tmp();
  try {
    const buf = fakeBytes();
    const zip = path.join(d, 'node-win.zip'); // 릴리스 워크플로가 바꾼 이름
    fs.writeFileSync(zip, buf);
    const r = run(path.join(ROOT, WIN), ['--node-zip', zip, '--out', path.join(d, 'o')]);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /저장소 고정값\(packaging\/node-runtime\.sha256\)에 없습니다/, r.err);
    assert.match(r.err, new RegExp(`node-v${esc(REL)}-win-x64\\.zip`));
    assert.doesNotMatch(r.out + r.err, /==> Windows 패키지 빌드|unzip 필요/, '도구 검사 · 빌드 전에 멈춘다');
    // 해시가 고정값에 있으면 이름과 무관하게 통과(그 뒤 가짜라 실패)
    const repo = fakeRepo(`${'0'.repeat(64)}  node-v${REL}-linux-x64.tar.xz\n${sha(buf)}  node-v${REL}-win-x64.zip\n`);
    const r2 = run(path.join(repo, WIN), ['--node-zip', zip, '--out', path.join(d, 'o')]);
    assert.match(r2.out, new RegExp(`저장소 고정값 일치\\(node-v${esc(REL)}-win-x64\\.zip\\)`), r2.out + r2.err);
    assert.notEqual(r2.code, 0);
    // 같은 해시가 리눅스 줄에만 있으면 Windows 고정값이 아니다
    const repo2 = fakeRepo(`${sha(buf)}  node-v${REL}-linux-x64.tar.xz\n`);
    const r3 = run(path.join(repo2, WIN), ['--node-zip', zip, '--out', path.join(d, 'o')]);
    assert.notEqual(r3.code, 0);
    assert.match(r3.err, /저장소 고정값/);
    // 명시값 · 형식 오류
    const r4 = run(path.join(ROOT, WIN), ['--node-zip', zip, '--node-sha256', sha(buf), '--out', path.join(d, 'o')]);
    assert.match(r4.out, /--node-sha256 명시값 일치/, r4.out + r4.err);
    const r5 = run(path.join(ROOT, WIN), ['--node-zip', zip, '--node-sha256', 'zz', '--out', path.join(d, 'o')]);
    assert.notEqual(r5.code, 0);
    assert.match(r5.err, /64자리 16진수/);
    const r6 = run(path.join(ROOT, WIN), ['--node-zip', zip, '--node-sha256', 'c'.repeat(64), '--out', path.join(d, 'o')]);
    assert.notEqual(r6.code, 0);
    assert.match(r6.err, /--node-sha256 명시값과 다릅니다/);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(repo2, { recursive: true, force: true });
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── T5 판정 · 노출 ─────────────────────────────────────────────────────────────
test('T5 judgeVersion.belowSecurityFloor — 하한 미만만 true · 계약 밖은 null · overallState 불변', () => {
  const b = (v) => judgeVersion(v).belowSecurityFloor;
  assert.equal(b('v22.23.2'), true, '이전 검증 버전(기존 설치본)');
  assert.equal(b('v22.23.4'), true, '22.23.5 보안 수정 없음');
  assert.equal(b('v22.5.0'), true);
  assert.equal(b(`v${FLOOR}-rc.1`), true, '같은 숫자의 사전 배포판은 하한 미만(semver)');
  assert.equal(b(`v${FLOOR}`), false);
  assert.equal(b('v22.23.6'), false);
  assert.equal(b('v22.30.0'), false);
  for (const v of ['v24.0.0', 'v20.20.2', 'v22.4.1', 'garbage', '', null]) assert.equal(b(v), null, String(v));
  // 하한이 계약에 없거나 다른 major 면 판정하지 않는다(지어내지 않는다)
  assert.equal(judgeVersion('v22.23.2', { ...RUNTIME_CONTRACT, securityFloor: undefined }).belowSecurityFloor, null);
  assert.equal(judgeVersion('v22.23.2', { ...RUNTIME_CONTRACT, supportedMajors: [22, 24], securityFloor: '24.1.0' }).belowSecurityFloor, null);
  // 종합 상태는 하한으로 바뀌지 않는다(구버전 웹이 모르는 state 를 조용히 무시하지 않게 — 별도 필드)
  assert.equal(overallState(judgeVersion('v22.23.2'), { state: 'ok' }), 'ok');
});

test('T5 하한 미만 런타임 — 서비스 점검 warn · 기동 warn 로그 · 관리자만 상세 · 비관리자는 state 하나', async () => {
  try {
    _resetRuntimeCheckForTest('v22.23.2');
    // 자가 점검 전(unchecked) — 원래도 warn 이고 하한 문구가 붙는다
    const pre = runtimeServiceRow({ isAdmin: false });
    assert.equal(pre.status, 'warn');
    assert.match(pre.detail, /보안 패치가 빠진 Node 런타임/);
    const lines = { log: [], warn: [] };
    const log = { log: (s) => lines.log.push(s), warn: (s) => lines.warn.push(s) };
    const s = await startRuntimeCheck({ log, timeoutMs: 5000, retryDelaysMs: [] });
    assert.equal(s.state, 'ok', '통신 자가 점검은 통과 — state 는 그대로 ok');
    assert.equal(s.belowSecurityFloor, true);
    assert.deepEqual([lines.warn.length, lines.log.length], [1, 0], '기동 로그는 warn 1줄');
    assert.match(lines.warn[0], new RegExp(`보안 하한\\(${esc(FLOOR)}\\) 미만 — 그 뒤 나온 Node 보안 수정이 빠져 있습니다`));
    assert.match(lines.warn[0], /자동 업그레이드는 Node 런타임을 바꾸지 않으니 최신 설치 패키지로 다시 설치하세요/);
    assert.doesNotMatch(lines.warn[0], /TLS|DNS|Brotli|HTTP/, '고친 항목을 나열하지 않는다(버전마다 다르다)');
    const adm = runtimeServiceRow({ isAdmin: true });
    assert.equal(adm.status, 'warn');
    assert.match(adm.detail, /^보안 패치가 빠진 Node 런타임 — 엣지는 중앙의 엣지 배포를 다시 실행하고, 소스 설치면/);
    assert.match(adm.detail, /v22\.23\.2/);
    const op = runtimeServiceRow({ isAdmin: false });
    assert.equal(op.status, 'warn');
    assert.equal(op.detail, '보안 패치가 빠진 Node 런타임 — 관리자에게 알리세요');
    assert.doesNotMatch(op.detail, /\d+\.\d+\.\d+/, '비관리자 문구에 버전 숫자(서버 · 하한) 없음');
    assert.deepEqual(runtimeForHealth(false), { state: 'ok' }, '비관리자 /health 모양 그대로(버전 단서 없음)');
    const full = runtimeForHealth(true);
    assert.equal(full.belowSecurityFloor, true);
    assert.equal(full.contract.securityFloor, FLOOR);
    // 점검 중(checking)도 warn
    const p = runRuntimeSelfCheck({ timeoutMs: 5000 });
    assert.equal(runtimeStatus().state, 'checking');
    assert.equal(runtimeServiceRow().status, 'warn');
    await p;

    // 하한 이상(검증 버전) — 조용하다: ok 행 · log 1줄 · 하한 문구 없음
    _resetRuntimeCheckForTest(`v${REL}`);
    const l2 = { log: [], warn: [] };
    const s2 = await startRuntimeCheck({ log: { log: (x) => l2.log.push(x), warn: (x) => l2.warn.push(x) }, timeoutMs: 5000, retryDelaysMs: [] });
    assert.equal(s2.state, 'ok');
    assert.equal(s2.belowSecurityFloor, false);
    assert.deepEqual([l2.warn.length, l2.log.length], [0, 1]);
    assert.doesNotMatch(l2.log[0], /보안 하한/);
    assert.equal(runtimeServiceRow({ isAdmin: true }).status, 'ok');
    assert.doesNotMatch(runtimeServiceRow({ isAdmin: true }).detail, /보안/);
    const ch = runRuntimeSelfCheck({ timeoutMs: 5000 });
    assert.equal(runtimeServiceRow().status, 'ok', '하한 이상이면 점검 중은 ok(예전 그대로)');
    await ch;

    // 계약 밖(unsupported)은 원래 경고가 우선 — 하한 문구를 붙이지 않는다(null)
    _resetRuntimeCheckForTest('v24.11.0');
    await runRuntimeSelfCheck({ timeoutMs: 5000 });
    assert.equal(runtimeStatus().belowSecurityFloor, null);
    assert.doesNotMatch(runtimeLogLine(), /보안 하한/);
    assert.match(runtimeServiceRow().detail, /^지원 범위 밖 Node/);
  } finally { _resetRuntimeCheckForTest(); }
});

test('T7 web/package-lock.json — source-map-js ≥ 1.2.2(GHSA-68fv-2mgg-jv7q) · 무결성 값 있음', () => {
  const lock = JSON.parse(read('web/package-lock.json'));
  const entries = Object.entries(lock.packages || {}).filter(([k]) => /(^|\/)node_modules\/source-map-js$/.test(k));
  assert.ok(entries.length >= 1, 'source-map-js 항목이 있다(postcss 경유)');
  for (const [k, v] of entries) {
    const p = parseNodeVersion(v.version);
    assert.ok(p, `${k} 버전 판독`);
    assert.ok(p.major > 1 || (p.major === 1 && (p.minor > 2 || (p.minor === 2 && p.patch >= 2))), `${k} ${v.version} < 1.2.2`);
    assert.match(v.integrity || '', /^sha512-[A-Za-z0-9+/]+={0,2}$/, `${k} integrity`);
    assert.match(v.resolved || '', /^https:\/\/registry\.npmjs\.org\/source-map-js\/-\/source-map-js-\d+\.\d+\.\d+\.tgz$/);
  }
  const pkg = JSON.parse(read('web/package.json'));
  assert.equal({ ...pkg.dependencies, ...pkg.devDependencies }['source-map-js'], undefined, '직접 의존성으로 올리지 않는다(잠금만)');
});
