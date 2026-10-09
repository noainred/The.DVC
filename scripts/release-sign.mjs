#!/usr/bin/env node
/**
 * scripts/release-sign.mjs — 릴리스 산출물 서명 manifest 생성(검토 S-10, v2.730). **CI(release 워크플로)가 실행한다.**
 *
 *   node scripts/release-sign.mjs --check
 *       게시 전 사전 점검 — ① 저장소 공개키 목록(server/src/upgrade/release-signing-keys.json)에 쓸 수 있는 키가 있는가
 *       ② 비밀 RELEASE_SIGNING_KEY 가 있는가 ③ 그 개인키의 keyId 가 목록에 있고 회수되지 않았는가. 하나라도 아니면 종료 코드 1.
 *   node scripts/release-sign.mjs --version <X.Y.Z> --dist <dir> [--out <file>] [--keys <keys.json>]
 *       dist 안의 그 버전 산출물(.tar.gz/.zip)을 해시해 manifest 를 만들고 서명한 뒤, **같은 검증 코드**
 *       (server/src/upgrade/signatureCore.js)로 다시 검증한다. 필수 4종(번들·el9·cent9·windows)이 없으면 실패.
 *
 * 개인키: env RELEASE_SIGNING_KEY — PKCS#8 PEM 원문 또는 그 base64. 이 스크립트는 키를 **출력·저장하지 않는다**
 * (오류 문구에도 싣지 않는다). manifest 에는 공개 정보(keyId·해시·크기)만 들어간다.
 * 키 만들기·등록 절차: scripts/release-keygen.mjs, docs/RELEASE-SIGNING.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  parseKeysDoc, mergeTrust, keyIdOf, buildManifest, signManifest, serializeEnvelope, verifyEnvelopeText, matchArtifact, manifestNameFor, VERSION_RE,
} from '../server/src/upgrade/signatureCore.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_KEYS_FILE = path.join(ROOT, 'server/src/upgrade/release-signing-keys.json');
const DOC = 'docs/RELEASE-SIGNING.md';

/** 산출물 이름 → kind·platform(update-versions.mjs 의 이름 규칙과 같다). */
export function classify(name, version) {
  if (name === `vmware-portal-${version}.tar.gz`) return { kind: 'bundle', platform: 'any' };
  if (name === `vmware-portal-offline-${version}-el9-x64.tar.gz`) return { kind: 'installer', platform: 'linux-x64' };
  if (name === `vmware-portal-offline-${version}-cent9-x64.tar.gz`) return { kind: 'installer_cent9', platform: 'linux-x64' };
  if (name === `vmware-portal-win-${version}-x64.zip`) return { kind: 'windows', platform: 'win-x64' };
  return { kind: 'other', platform: 'any' };
}
export const requiredNames = (v) => [`vmware-portal-${v}.tar.gz`, `vmware-portal-offline-${v}-el9-x64.tar.gz`, `vmware-portal-offline-${v}-cent9-x64.tar.gz`, `vmware-portal-win-${v}-x64.zip`];

/** env 값 → Ed25519 개인키. 실패 사유에 키 내용을 싣지 않는다. */
export function privateKeyFromEnv(raw) {
  const s = String(raw || '').trim();
  if (!s) throw new Error(`비밀 RELEASE_SIGNING_KEY 가 비어 있습니다 — GitHub 저장소 Settings › Secrets 에 개인키를 등록하세요(${DOC})`);
  const pem = s.includes('-----BEGIN') ? s : (() => { try { return Buffer.from(s, 'base64').toString('utf8'); } catch { return ''; } })();
  let key;
  try { key = crypto.createPrivateKey({ key: pem, format: 'pem' }); } catch { throw new Error('RELEASE_SIGNING_KEY 를 PKCS#8 PEM 개인키로 읽지 못했습니다(원문 PEM 또는 그 base64 여야 합니다)'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`RELEASE_SIGNING_KEY 가 Ed25519 키가 아닙니다(${key.asymmetricKeyType})`);
  return key;
}

export function loadRepoTrust(file = DEFAULT_KEYS_FILE) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`공개키 목록을 읽지 못했습니다(${path.relative(ROOT, file)}: ${e.code || e.message})`); }
  const p = parseKeysDoc(doc, 'repo');
  const t = mergeTrust([p]);
  return { trust: t, errors: p.errors };
}

/** 사전 점검 — 게시 전에 실패해야 할 조건을 모두 본다. */
export function preflight({ env = process.env, keysFile = DEFAULT_KEYS_FILE } = {}) {
  const { trust, errors } = loadRepoTrust(keysFile);
  const problems = [...errors];
  if (!trust.activeCount) {
    problems.push(`저장소 공개키 목록(${path.relative(ROOT, keysFile)})에 쓸 수 있는 키가 없습니다 — 이 상태로 게시하면 이 버전을 설치한 현장은 다음 버전을 영원히 받지 못합니다. scripts/release-keygen.mjs 로 키를 만들고 공개키를 목록에 추가하세요(${DOC})`);
  }
  let keyId = null;
  try {
    const key = privateKeyFromEnv(env.RELEASE_SIGNING_KEY);
    keyId = keyIdOf(crypto.createPublicKey(key));
    const k = trust.byId.get(keyId);
    if (!k || !k.publicKey) problems.push(`서명 개인키의 keyId(${keyId})가 저장소 공개키 목록에 없습니다 — 공개키를 목록에 추가하거나 비밀을 맞는 키로 바꾸세요`);
    else if (k.revoked) problems.push(`서명 개인키의 keyId(${keyId})가 회수(revoked)된 키입니다 — 새 키로 서명하세요`);
  } catch (e) { problems.push(e.message); }
  return { ok: problems.length === 0, problems, keyId, activeKeys: trust.activeCount };
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(1 << 20);
  let size = 0;
  try { for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, null); if (!n) break; size += n; h.update(buf.subarray(0, n)); } } finally { fs.closeSync(fd); }
  return { sha256: h.digest('hex'), size };
}

/** 서명 — manifest 를 만들고 쓰고, 같은 검증 코드로 다시 검증한다. */
export function signRelease({ version, dist, out, keysFile = DEFAULT_KEYS_FILE, env = process.env, now = new Date() }) {
  if (!VERSION_RE.test(String(version || ''))) throw new Error(`버전 형식이 아닙니다: ${version}`);
  const pre = preflight({ env, keysFile });
  if (!pre.ok) throw new Error(`서명 사전 점검 실패:\n  - ${pre.problems.join('\n  - ')}`);
  const key = privateKeyFromEnv(env.RELEASE_SIGNING_KEY);
  const names = fs.readdirSync(dist).filter((n) => /\.(tar\.gz|zip)$/.test(n) && n.includes(version)).sort();
  const missing = requiredNames(version).filter((n) => !names.includes(n));
  if (missing.length) throw new Error(`필수 산출물이 없습니다: ${missing.join(', ')}`);
  const files = names.map((name) => ({ name, ...classify(name, version), ...sha256File(path.join(dist, name)) }));
  const manifest = buildManifest({ version, files, keyId: pre.keyId, createdAt: now.toISOString() });
  const env2 = signManifest(manifest, key);
  const text = serializeEnvelope(env2);
  // 자기 검증 — 게시 전에, 수신측과 같은 코드로.
  const { trust } = loadRepoTrust(keysFile);
  const v = verifyEnvelopeText(text, trust);
  if (!v.ok) throw new Error(`만든 manifest 가 검증되지 않습니다(${v.code}): ${v.reason}`);
  for (const f of files) {
    const m = matchArtifact(v.manifest, { name: f.name, kind: f.kind, size: f.size, sha256: f.sha256, expectVersion: version });
    if (!m.ok) throw new Error(`자기 검증 실패(${f.name}): ${m.reason}`);
  }
  const target = out || path.join(dist, manifestNameFor(version));
  fs.writeFileSync(target, text);
  return { file: target, keyId: pre.keyId, files: files.map((f) => ({ name: f.name, kind: f.kind, size: f.size })) };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') o.check = true;
    else if (['--version', '--dist', '--out', '--keys'].includes(a)) { o[a.slice(2)] = argv[i + 1]; i++; }
    else o.unknown = a;
  }
  return o;
}

// ⚠ realpath 로 비교한다 — 설치본은 심볼릭 링크(/usr/local/bin/…·링크된 앱 폴더)로 불리는 일이 있고, 경로 문자열만 비교하면
//   본체가 **아무것도 하지 않고 종료 코드 0** 으로 끝난다(확인 도구에서 0 은 '서명 확인' 이다 — 실제로 그렇게 실패했다).
const realOf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isMain = !!process.argv[1] && realOf(process.argv[1]) === realOf(fileURLToPath(import.meta.url));
if (isMain) {
  const o = parseArgs(process.argv.slice(2));
  try {
    if (o.unknown) throw new Error(`알 수 없는 인자: ${o.unknown}`);
    const keysFile = o.keys ? path.resolve(o.keys) : DEFAULT_KEYS_FILE;
    if (o.check) {
      const r = preflight({ keysFile });
      if (!r.ok) { for (const p of r.problems) console.error(`::error::${p}`); process.exit(1); }
      console.log(`릴리스 서명 사전 점검 통과 — 서명 키 ${r.keyId} · 신뢰 공개키 ${r.activeKeys}개`);
    } else {
      if (!o.version || !o.dist) throw new Error('사용법: release-sign.mjs --check | --version <X.Y.Z> --dist <dir> [--out <file>] [--keys <file>]');
      const r = signRelease({ version: o.version, dist: path.resolve(o.dist), out: o.out ? path.resolve(o.out) : undefined, keysFile });
      console.log(`서명 manifest 생성: ${path.basename(r.file)} — 키 ${r.keyId} · 파일 ${r.files.length}개`);
      for (const f of r.files) console.log(`  ${f.kind.padEnd(16)} ${f.name} (${f.size} bytes)`);
    }
  } catch (e) {
    console.error(`::error::${String(e?.message || e)}`);
    process.exit(1);
  }
}
