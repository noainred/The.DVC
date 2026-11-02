/**
 * upgrade/fleetBundle.js — 중앙이 '지금 자기 버전' 의 업그레이드 번들을 패키지 폴더에 보관한다(v2.859, 사용자 요청
 * "중앙 포탈이 자동 업그레이드 되면 엣지도 모두 자동으로 업그레이드").
 *
 * 왜: 중앙은 자기 업그레이드를 마친 직후 등록된 엣지(수집 서버)에 같은 번들을 push 한다(manager.pushToCollectors). 그 push 는
 *   **그 순간 닿은 엣지**에만 간다 — 꺼져 있던·NAT 뒤라 인바운드가 막힌·시한을 넘긴 엣지는 구버전으로 남고, 재시작한 중앙은
 *   밀어 줄 번들을 더 갖고 있지 않았다(받은 번들은 옛 설치 디렉터리의 .upgrade-cache 와 함께 백업으로 밀려난다). 그래서
 *   적용한 번들(+ 서명 manifest)을 **패키지 폴더**(packageSettings.getPackageDir — 중앙 /dl 이 내주는 곳)에 복사해 둔다:
 *   ① 엣지 동기화(edgeSync.js)가 이 파일로 뒤처진 엣지에 다시 민다 ② 엣지의 자체 확인(CENTRAL_URL/dl/versions.json, 1시간
 *   주기 — config.js EDGE_MODE=all 기본)이 새 버전을 본다(중앙에서 닿지 않는 엣지가 올라오는 길).
 *
 * 규칙:
 *  - 이 모듈이 넣은 파일만 정리한다(관리자가 '패키지' 화면에서 내려받은 것은 건드리지 않는다). 무엇을 넣었는지는 상태 파일
 *    `upgrade-kept-bundles.json` 에 적고, UPGRADE_KEEP_BUNDLES(기본 3, [1, 20])개를 넘는 가장 오래된 보관본부터 지운다.
 *  - 같은 이름의 파일이 이미 있으면 덮어쓰지 않는다(내용이 같으면 '이미 있음', 다르면 그 사실을 사유로 돌려준다 — 서명 검증은
 *    쓰는 쪽 bundleSource.fromArchive 가 한다).
 *  - 쓰기는 임시 파일 + rename(util/atomicWrite) — 반쯤 쓴 파일을 /dl 이 내주거나 push 가 읽지 않게.
 *  - tar.gz 만 보관한다 — push 수신(upgrade.js readBundleBytes)과 /dl(dlsource BUNDLE_RE)이 tar.gz 만 다룬다. zip 은 사유와 함께 거절.
 *  - 실패해도 던지지 않는다(업그레이드·push 를 막지 않는다) — { ok:false, reason } 로 돌려주고 호출자가 로그에 남긴다.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { getPackageDir } from './packageSettings.js';
import { manifestPathForArchive, readManifestFile } from './signature.js';
import { manifestNameFor, VERSION_RE } from './signatureCore.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';
import { numOrNull } from '../util/numOrNull.js';

export const KEPT_FILE_NAME = 'upgrade-kept-bundles.json';
registerStateFile(KEPT_FILE_NAME);
const keptFile = () => path.join(config.configDir, 'upgrade-kept-bundles.json'); // 리터럴 — scripts/config-doc.mjs 가 이 줄에서 쓰는 모듈을 읽는다
export const KEPT_MAX = 20;
const BUNDLE_NAME_RE = /^vmware-portal-(\d{1,9}\.\d{1,9}\.\d{1,9})\.tar\.gz$/;

/** 보관 개수 — env 가 비었거나 숫자가 아니면 3, [1, 20] 로 자른다. */
export function keepBundlesOf(v = process.env.UPGRADE_KEEP_BUNDLES) {
  const n = numOrNull(v);
  if (n == null) return 3;
  return Math.min(KEPT_MAX, Math.max(1, Math.floor(n)));
}
export const UPGRADE_KEEP_BUNDLES = keepBundlesOf(numOrNull(process.env.UPGRADE_KEEP_BUNDLES) ?? 3); // 같은 판정 — 기본값을 문서 생성기가 읽게 한 줄로

const ver = (v) => { const s = String(v ?? '').trim().replace(/^v/i, ''); return VERSION_RE.test(s) ? s : null; };
export const bundleNameFor = (version) => `vmware-portal-${version}.tar.gz`;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 패키지 폴더(또는 dir)에 있는 '그 버전' 번들 경로 — 없으면 null. */
export function localBundlePath(version, dir = getPackageDir()) {
  const v = ver(version);
  if (!v || !dir) return null;
  const p = path.join(dir, bundleNameFor(v));
  try { return fs.statSync(p).isFile() ? p : null; } catch { return null; }
}

function readKept() {
  const f = keptFile();
  if (!fs.existsSync(f)) return [];
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    const list = Array.isArray(d?.kept) ? d.kept : [];
    return list.filter((x) => x && typeof x === 'object' && typeof x.name === 'string' && BUNDLE_NAME_RE.test(x.name))
      .map((x) => ({ name: x.name, version: ver(x.version) || BUNDLE_NAME_RE.exec(x.name)[1], at: numOrNull(x.at) ?? 0 }))
      .slice(0, KEPT_MAX * 2);
  } catch (e) { preserveCorrupt(f, e?.message || String(e)); return []; }
}
function writeKept(list) {
  atomicWriteFileSync(keptFile(), JSON.stringify({ kept: list }, null, 2), { mode: 0o600 });
}
/** 보관 기록(진단·테스트용). */
export function keptBundles() { return readKept(); }

/**
 * 번들을 패키지 폴더에 보관한다. 원본은 파일 경로(archivePath — 적용 직후) 또는 바이트(bytes — 원격에서 받은 것).
 * manifestText 가 undefined 이고 파일 경로면 옆의 manifest 파일을 읽는다.
 * @returns {{ok:boolean, path?:string, existing?:boolean, manifest?:boolean, pruned?:string[], reason?:string}}
 */
export function keepBundle({ archivePath = null, bytes = null, version = null, manifestText = undefined, dir = getPackageDir(), keep = keepBundlesOf(), now = Date.now() } = {}) {
  const fromName = archivePath ? /vmware-portal-(\d{1,9}\.\d{1,9}\.\d{1,9})\.(?:tar\.gz|tgz|zip)$/.exec(path.basename(String(archivePath)))?.[1] : null;
  const v = ver(version) || ver(fromName);
  if (!v) return { ok: false, reason: '보관할 번들의 버전을 알 수 없습니다' };
  if (!dir) return { ok: false, reason: '패키지 폴더가 설정되지 않았습니다' };
  if (archivePath && !/\.(tar\.gz|tgz)$/i.test(String(archivePath))) return { ok: false, reason: `tar.gz 번들만 보관합니다(${path.basename(String(archivePath))})` };
  let buf = bytes;
  if (!Buffer.isBuffer(buf)) {
    if (!archivePath) return { ok: false, reason: '번들 파일도 바이트도 없습니다' };
    try { buf = fs.readFileSync(archivePath); } catch (e) { return { ok: false, reason: `번들을 읽지 못했습니다: ${e?.code || e?.message || e}` }; }
  }
  const name = bundleNameFor(v);
  const dest = path.join(dir, name);
  const out = { ok: true, path: dest, existing: false, manifest: false, pruned: [] };
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(dest)) {
      let same = false;
      try { same = sha256(fs.readFileSync(dest)) === sha256(buf); } catch { same = false; }
      if (!same) return { ok: false, reason: `패키지 폴더에 같은 이름의 다른 파일이 이미 있습니다(${name}) — 덮어쓰지 않습니다` };
      out.existing = true;
    } else {
      atomicWriteFileSync(dest, buf, { mode: 0o644 });
    }
    // 서명 manifest — 번들 옆에(엣지가 설치 전에 검증한다. 없으면 require 정책 엣지가 '서명 없음' 으로 거부한다 — 사유가 보인다).
    let man = manifestText;
    if (man === undefined && archivePath) man = readManifestFile(manifestPathForArchive(archivePath));
    const manDest = path.join(dir, manifestNameFor(v));
    if (fs.existsSync(manDest)) out.manifest = true;
    else if (typeof man === 'string' && man) { atomicWriteFileSync(manDest, man, { mode: 0o644 }); out.manifest = true; }
    // 보관 기록 + 정리 — 이 모듈이 넣은 것만. 관리자가 내려받은 같은 이름의 파일(existing 인데 기록에 없음)은 기록하지 않는다(지우지 않게).
    const prior = readKept();
    const mine = prior.find((x) => x.name === name) || null;
    const kept = prior.filter((x) => x.name !== name);
    if (!out.existing || mine) kept.push(mine || { name, version: v, at: now });
    kept.sort((a, b) => (a.at || 0) - (b.at || 0));
    while (kept.length > keep) {
      const old = kept.shift();
      if (old.name === name) { kept.unshift(old); break; } // 방금 넣은(지금 버전) 것은 지우지 않는다
      for (const f of [path.join(dir, old.name), path.join(dir, manifestNameFor(old.version))]) { try { fs.rmSync(f, { force: true }); } catch { /* 다음 보관 때 다시 */ } }
      out.pruned.push(old.name);
    }
    writeKept(kept);
    return out;
  } catch (e) {
    return { ok: false, reason: `번들 보관 실패: ${e?.code || e?.message || e}` };
  }
}
