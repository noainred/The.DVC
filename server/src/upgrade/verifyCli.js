#!/usr/bin/env node
/**
 * upgrade/verifyCli.js — 릴리스 산출물(설치 패키지·업그레이드 번들·Windows zip)의 배포자 서명 확인 도구(검토 S-10, v2.730).
 *
 * 포탈 런타임과 **같은 판정 함수**(signature.js decideSignature)를 쓴다 — 오프라인 설치(install.sh)·관리자 수동 확인이
 * 온라인 경로와 다른 규칙으로 통과하지 않게. 신뢰 키는 **이 파일이 들어 있는 설치본**의 저장소 키 파일과
 * CONFIG_DIR 의 호스트 파일(release-signing-keys.conf)이다 — 그래서 확인은 **이미 설치된(신뢰하는) 설치본**의 이 도구로
 * 새 패키지를 확인해야 뜻이 있다(새 패키지 안의 도구로 그 패키지를 확인하면 무결성만 확인된다 — 순환).
 *
 *   node verifyCli.js --file <패키지> --manifest <vmware-portal-<버전>.manifest.json> [--version X.Y.Z] [--json]
 *   종료 코드: 0 = 서명 확인(또는 warn 정책으로 허용) · 1 = 확인했더니 틀림(거부) · 2 = 확인할 수 없음(정책 require) · 3 = 사용법 오류
 *
 * 개인키를 읽지 않는다. 파일은 스트림으로 해시한다(설치 패키지는 수백 MB 다).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decideSignature, readManifestFile, signaturePolicy } from './signature.js';
import { CANNOT_VERIFY } from './signatureCore.js';

export function parseArgs(argv) {
  const o = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--file' || a === '--manifest' || a === '--version' || a === '--kind') { o[a.slice(2)] = argv[i + 1]; i++; }
    else if (a === '-h' || a === '--help') o.help = true;
    else o.unknown = a;
  }
  return o;
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let size = 0;
    fs.createReadStream(p).on('data', (d) => { size += d.length; h.update(d); }).on('end', () => resolve({ sha256: h.digest('hex'), size })).on('error', reject);
  });
}

/** CLI 본체 — 테스트가 그대로 부른다(종료 코드와 출력 줄을 돌려준다). */
export async function runVerify(argv, { log = console.log } = {}) {
  const o = parseArgs(argv);
  const usage = '사용법: verifyCli.js --file <패키지 파일> --manifest <vmware-portal-<버전>.manifest.json> [--version X.Y.Z] [--json]';
  if (o.help) { log(usage); return 0; }
  if (o.unknown || !o.file || !o.manifest) { log(o.unknown ? `알 수 없는 인자: ${o.unknown}` : usage); return 3; }
  let st;
  try { st = fs.statSync(o.file); } catch { log(`파일이 없습니다: ${o.file}`); return 3; }
  if (!st.isFile()) { log(`파일이 아닙니다: ${o.file}`); return 3; }
  const manifestText = readManifestFile(o.manifest);
  const name = path.basename(o.file);
  const ver = o.version || /(\d{1,9}\.\d{1,9}\.\d{1,9})/.exec(name)?.[1];
  const { sha256, size } = await sha256File(o.file);
  const d = decideSignature({ manifestText, sha256, size, name, kind: o.kind || null, expectVersion: ver, where: 'offline' });
  const code = d.ok ? 0 : (CANNOT_VERIFY.has(d.code) ? 2 : 1);
  if (o.json) log(JSON.stringify({ ok: d.ok, verified: d.verified, warned: !!d.warned, code: d.code || null, keyId: d.keyId || null, version: d.version || null, policy: d.policy, reason: d.reason || '', file: name, sha256, size, exit: code }));
  else if (d.verified) log(`✓ 서명 확인: ${name} — 버전 ${d.version} · 키 ${d.keyId} · sha256 ${sha256.slice(0, 16)}…`);
  else if (d.ok) log(`⚠ 서명을 확인하지 못했지만 정책(${signaturePolicy().policy})이 허용합니다: ${d.reason}`);
  else log(`✗ ${d.reason}`);
  return code;
}

// ⚠ realpath 로 비교한다 — 설치본은 심볼릭 링크(/usr/local/bin/…·링크된 앱 폴더)로 불리는 일이 있고, 경로 문자열만 비교하면
//   본체가 **아무것도 하지 않고 종료 코드 0** 으로 끝난다(확인 도구에서 0 은 '서명 확인' 이다 — 실제로 그렇게 실패했다).
const realOf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isMain = !!process.argv[1] && realOf(process.argv[1]) === realOf(fileURLToPath(import.meta.url));
if (isMain) {
  runVerify(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(`확인 도구 오류: ${e?.message || e}`); process.exitCode = 3; });
}
