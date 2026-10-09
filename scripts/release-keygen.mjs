#!/usr/bin/env node
/**
 * scripts/release-keygen.mjs — 릴리스 서명 키(Ed25519) 만들기(검토 S-10, v2.730). **사용자가 자기 PC 에서 직접 실행한다.**
 * (자동화·CI·Claude 는 이 스크립트를 실행하지 않는다 — 개인키는 배포 담당자만 갖는다.)
 *
 *   node scripts/release-keygen.mjs [--out-dir <폴더>] [--note "설명"] [--add-to server/src/upgrade/release-signing-keys.json]
 *
 * 하는 일:
 *  ① Ed25519 키 쌍을 만든다.
 *  ② 개인키(PKCS#8 PEM)를 `--out-dir`(기본 ~/.vmware-portal-release-keys)에 **0600** 으로 쓴다 — 같은 이름이 있으면 덮어쓰지 않는다.
 *     ⚠ git 작업 트리 안(위로 올라가며 .git 이 있는 폴더)에는 쓰지 않는다(실수로 커밋되는 것을 막는다).
 *  ③ 공개키 항목(keyId · publicKey)을 화면에 보이고, `--add-to` 를 주면 그 파일의 keys 에 추가한다(공개키만).
 *  ④ 다음 할 일(GitHub 비밀 등록·오프라인 백업)을 안내한다. 개인키 내용은 **화면에 출력하지 않는다.**
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { keyIdOf, spkiBase64Of, parseKeysDoc, KEYS_FORMAT } from '../server/src/upgrade/signatureCore.js';

export const DEFAULT_OUT_DIR = path.join(os.homedir(), '.vmware-portal-release-keys');

/** 폴더가 git 작업 트리 안인가(위로 올라가며 .git 을 찾는다) — 순수 판정. */
export function insideGitTree(dir) {
  let cur = path.resolve(dir);
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

/** 공개키 항목을 키 파일에 추가한다(이미 있으면 거부). 개인키는 다루지 않는다. */
export function addPublicKeyEntry(file, entry) {
  const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { format: KEYS_FORMAT, schema: 1, keys: [], revoked: [] };
  if (!Array.isArray(doc.keys)) doc.keys = [];
  if (doc.keys.some((k) => k && k.keyId === entry.keyId)) throw new Error(`이미 있는 keyId 입니다: ${entry.keyId}`);
  doc.keys.push(entry);
  const p = parseKeysDoc(doc, 'check');
  if (p.errors.length) throw new Error(`추가 뒤 키 파일 검사 실패: ${p.errors.join('; ')}`);
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--out-dir', '--note', '--add-to'].includes(a)) { o[a.slice(2)] = argv[i + 1]; i++; }
    else if (a === '-h' || a === '--help') o.help = true;
    else o.unknown = a;
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || o.unknown) {
    console.log('사용법: node scripts/release-keygen.mjs [--out-dir <폴더>] [--note "설명"] [--add-to server/src/upgrade/release-signing-keys.json]');
    process.exit(o.unknown ? 1 : 0);
  }
  const outDir = path.resolve(o['out-dir'] || DEFAULT_OUT_DIR);
  // 생성 **전에** 위치를 검사한다 — 거부할 곳이면 키를 만들지 않는다.
  const repo = insideGitTree(outDir);
  if (repo) { console.error(`개인키를 git 작업 트리(${repo}) 안에 쓰지 않습니다 — 저장소 밖 폴더를 --out-dir 로 지정하세요.`); process.exit(1); }
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keyId = keyIdOf(publicKey);
  const file = path.join(outDir, `release-signing-${keyId.slice('ed25519:'.length)}.key.pem`);
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  const entry = { keyId, publicKey: spkiBase64Of(publicKey), addedAt: new Date().toISOString().slice(0, 10), note: String(o.note || '').slice(0, 200), revoked: false };
  console.log(`✓ 키 생성: ${keyId}`);
  console.log(`  개인키 파일(0600, 화면에 출력하지 않음): ${file}`);
  console.log('  공개키 항목(server/src/upgrade/release-signing-keys.json 의 keys 에 추가):');
  console.log(JSON.stringify(entry, null, 2).split('\n').map((l) => `    ${l}`).join('\n'));
  if (o['add-to']) { addPublicKeyEntry(path.resolve(o['add-to']), entry); console.log(`  → ${o['add-to']} 에 공개키를 추가했습니다(커밋하세요).`); }
  console.log('\n다음 할 일(docs/RELEASE-SIGNING.md):');
  console.log('  1) 공개키 항목을 저장소 파일에 추가해 커밋·PR(이미 --add-to 로 했다면 커밋만).');
  console.log(`  2) GitHub › Settings › Secrets and variables › Actions 에 RELEASE_SIGNING_KEY 로 개인키 파일 내용을 등록`);
  console.log(`     (gh CLI: gh secret set RELEASE_SIGNING_KEY < "${file}").`);
  console.log('  3) 개인키 파일을 오프라인 매체에 백업하고, 등록·백업이 끝나면 이 PC 에서 지우는 것을 권장합니다.');
}

// ⚠ realpath 로 비교한다 — 설치본은 심볼릭 링크(/usr/local/bin/…·링크된 앱 폴더)로 불리는 일이 있고, 경로 문자열만 비교하면
//   본체가 **아무것도 하지 않고 종료 코드 0** 으로 끝난다(확인 도구에서 0 은 '서명 확인' 이다 — 실제로 그렇게 실패했다).
const realOf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isMain = !!process.argv[1] && realOf(process.argv[1]) === realOf(fileURLToPath(import.meta.url));
if (isMain) main();
