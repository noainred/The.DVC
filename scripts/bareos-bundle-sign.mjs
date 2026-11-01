#!/usr/bin/env node
/**
 * scripts/bareos-bundle-sign.mjs — Bareos 완전 설치 오프라인 번들의 서명 manifest + 최신 포인터(v2.844). **CI(bareos-bundle 워크플로)가 실행한다.**
 *
 *   node scripts/bareos-bundle-sign.mjs --version <BV> --dist <dir>
 *
 * dist 의 bareos-bundle-<BV>.tar.gz · bareos-bundle-<BV>.json 을 해시해 포탈 릴리스와 **같은 서명 키·같은 형식**(upgrade/signatureCore.js)으로
 * manifest 를 만들고, 수신측과 같은 코드(bareos/install/bundleDoc.js verifyBundle)로 다시 검증한 뒤 bareos-bundle.json(포인터)을 쓴다.
 * 개인키: env RELEASE_SIGNING_KEY(scripts/release-sign.mjs 와 같은 비밀) — 출력·저장하지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildManifest, signManifest, serializeEnvelope, VERSION_RE } from '../server/src/upgrade/signatureCore.js';
import { preflight, privateKeyFromEnv, loadRepoTrust, DEFAULT_KEYS_FILE } from './release-sign.mjs';
import { tarName, contentsName, manifestName, POINTER_NAME, buildPointer, verifyBundle } from '../server/src/bareos/install/bundleDoc.js';

function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(1 << 20);
  let size = 0;
  try { for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, null); if (!n) break; size += n; h.update(buf.subarray(0, n)); } } finally { fs.closeSync(fd); }
  return { sha256: h.digest('hex'), size };
}

export function signBundle({ version, dist, keysFile = DEFAULT_KEYS_FILE, env = process.env, now = new Date() }) {
  if (!VERSION_RE.test(String(version || ''))) throw new Error(`번들 버전 형식이 아닙니다: ${version}`);
  const pre = preflight({ env, keysFile });
  if (!pre.ok) throw new Error(`서명 사전 점검 실패:\n  - ${pre.problems.join('\n  - ')}`);
  const key = privateKeyFromEnv(env.RELEASE_SIGNING_KEY);
  const tarP = path.join(dist, tarName(version));
  const conP = path.join(dist, contentsName(version));
  for (const p of [tarP, conP]) if (!fs.existsSync(p)) throw new Error(`산출물이 없습니다: ${path.basename(p)}`);
  const tar = sha256File(tarP); const con = sha256File(conP);
  const manifest = buildManifest({ version, keyId: pre.keyId, createdAt: now.toISOString(), files: [
    { name: tarName(version), kind: 'other', platform: 'linux-x64', ...tar },
    { name: contentsName(version), kind: 'other', platform: 'any', ...con },
  ] });
  const text = serializeEnvelope(signManifest(manifest, key));
  const pointer = buildPointer({ version, tarball: tar, contents: con });
  // 자기 검증 — 수신측(중앙)과 같은 코드로
  const { trust } = loadRepoTrust(keysFile);
  const v = verifyBundle({ pointer, manifestText: text, contentsBuf: fs.readFileSync(conP), contentsSha256: con.sha256, tar }, trust);
  if (!v.ok) throw new Error(`만든 번들 manifest 가 검증되지 않습니다(${v.code}): ${v.reason}`);
  fs.writeFileSync(path.join(dist, manifestName(version)), text);
  fs.writeFileSync(path.join(dist, POINTER_NAME), `${JSON.stringify(pointer, null, 2)}\n`);
  return { keyId: pre.keyId, pointer, contents: { bareosVersion: v.contents.bareosVersion, pyvmomi: v.contents.pyvmomi.versions, vddk: v.contents.vddk } };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  try {
    const r = signBundle({ version: get('--version'), dist: get('--dist') });
    console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    console.error(String(e?.message || e));
    process.exit(1);
  }
}
