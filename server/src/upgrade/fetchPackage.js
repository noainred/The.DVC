/**
 * Download upgrade/install packages from a remote (GitHub raw by default, or a
 * LAN mirror for air-gapped sites) into config.packages.dir, with SHA-256
 * verification from the remote versions.json. The agent-deploy installer
 * resolver also searches this directory.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { getPackageBaseUrl, getPackageDir } from './packageSettings.js';
import { upgradeAgent } from './upgradeAgent.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { ssrfBlockReasonResolved } from '../collector/registry.js';
import { readBytesCapped } from '../util/readBytesCapped.js';
import { readJsonCapped, readTextCapped } from '../util/readCapped.js';
// v2.730(검토 I-08·S-10): 메타데이터 형식·상한 + 배포자 서명(원격 다운로드 경로 — 여기 받은 파일은 /dl 로 엣지에 나가고 설치에 쓰인다)
import { VERSIONS_MAX_BYTES, validateVersionsDoc, deadlineSignal, scrubUrlSecrets } from './versionsDoc.js';
import { decideSignature, signatureSummary } from './signature.js';
import { MANIFEST_MAX_BYTES, MANIFEST_NAME_RE, manifestNameFor } from './signatureCore.js';

// v2.607 SEC2607-06: 설치 패키지 다운로드의 바이트 상한 — 예전엔 상한 자체가 없어 원격 소스(사내 미러·중간자)가
//   거대 본문을 주면 sha256 검증 전에 전량을 메모리에 받았다. 오프라인 설치 패키지(노드 런타임 포함)는 수백 MB 라
//   번들 상한(200MB)보다 넉넉히 둔다. 빈 값·비숫자는 기본값.
export const PACKAGE_MAX_BYTES = (() => { const n = Number(process.env.UPGRADE_PACKAGE_MAX_BYTES); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1536 * 1024 * 1024; })();

const trim = (u) => String(u || '').replace(/\/+$/, '');

export async function fetchRemoteVersions(baseUrl) {
  const base = baseUrl || getPackageBaseUrl();
  // ⚠ 보안(M-3, 2026-09-12): admin 이 지정한 baseUrl(설정 › 수집 서버 › 패키지 저장소, 또는 즉석
  // ?baseUrl=)로 임의 내부 주소를 fetch 해 응답 본문을 되돌려받는 SSRF 를 막는다. 루프백/링크로컬/
  // 메타데이터는 차단, 사내 RFC1918·공개 미러는 허용(업그레이드 remoteBase 와 동일 정책).
  const block = await ssrfBlockReasonResolved(`${trim(base)}/versions.json`);
  if (block) throw new Error(`패키지 저장소 주소가 차단되었습니다: ${block}`);
  // v2.730(검토 I-08): fetch·본문 읽기를 한 전체 시한(20초)으로 묶고, 상한(VERSIONS_MAX_BYTES — 업그레이드 확인과 같은 값)과
  //   형식(항목 수·문자열·필드 타입)을 upgrade.js 와 **같은 함수**로 검사한다. 선언하지 않은 필드는 버린다.
  const dl = deadlineSignal(20000);
  try {
    // 고RTT·일시 오류 재시도. 단 TLS 검증 디스패처(upgradeAgent)는 유지(MITM→RCE 방지).
    const res = await resilientFetch(`${trim(base)}/versions.json`, { dispatcher: upgradeAgent, timeoutMs: 20000, retries: 2, signal: dl.signal });
    if (!res.ok) { try { await res.body?.cancel?.(); } catch { /* */ } throw new Error(`versions.json HTTP ${res.status}`); }
    // v2.632(감사 AX3-06): 저장소 응답은 상한까지만 읽는다(외부 응답 .json() 금지 — v2.604 규약).
    const raw = await readJsonCapped(res, VERSIONS_MAX_BYTES, 'versions.json');
    const v = validateVersionsDoc(raw);
    if (!v.ok) throw new Error(v.reason);
    return v.doc;
  } catch (e) {
    if (dl.aborted()) throw new Error('versions.json 을 전체 시한(20초) 안에 다 받지 못해 중단했습니다');
    if (e instanceof SyntaxError) throw new Error('versions.json 형식 오류 — JSON 이 아닙니다(잘렸거나 손상됐습니다)');
    throw new Error(scrubUrlSecrets(e?.message || e));
  } finally { dl.clear(); }
}

/** 원격 manifest(상한 64KB·전체 시한 30초). 404 → missing, 그 밖 실패 → reason, 상한 초과 → malformed. */
async function fetchPackageManifest(url) {
  const dl = deadlineSignal(30000);
  try {
    const res = await resilientFetch(url, { dispatcher: upgradeAgent, timeoutMs: 30000, retries: 2, signal: dl.signal });
    if (res.status === 404) { try { await res.body?.cancel?.(); } catch { /* */ } return { text: null, missing: true }; }
    if (!res.ok) { try { await res.body?.cancel?.(); } catch { /* */ } return { text: null, reason: `서명 manifest 를 받지 못했습니다(HTTP ${res.status})` }; }
    return { text: await readTextCapped(res, MANIFEST_MAX_BYTES + 1, 'manifest') };
  } catch (e) {
    if (dl.aborted()) return { text: null, reason: '서명 manifest 를 시한(30초) 안에 받지 못했습니다' };
    if (/상한/.test(String(e?.message || ''))) return { text: null, malformed: `manifest 가 상한(${MANIFEST_MAX_BYTES}바이트)보다 큽니다` };
    return { text: null, reason: `서명 manifest 를 받지 못했습니다: ${scrubUrlSecrets(e?.message || e)}` };
  } finally { dl.clear(); }
}

export function listLocalPackages(dir = getPackageDir()) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => /\.(tar\.gz|zip)$/.test(f))
      .map((f) => { const st = fs.statSync(path.join(dir, f)); return { name: f, sizeBytes: st.size, mtime: st.mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

const KIND = {
  installer: { file: 'installer', sha: 'installer_sha256', manifestKind: 'installer' },                     // el9 offline installer (Rocky 9)
  installer_cent9: { file: 'installer_cent9', sha: 'installer_cent9_sha256', manifestKind: 'installer_cent9' }, // CentOS Stream 9 offline installer
  bundle: { file: 'tar_gz', sha: 'sha256', manifestKind: 'bundle' },                                       // app upgrade bundle
  windows: { file: 'windows', sha: 'windows_sha256', manifestKind: 'windows' },                            // Windows zip
};

/** Download one package kind (default: latest installer). Verifies SHA-256. */
export async function downloadPackage({ kind = 'installer', version, baseUrl, dir } = {}) {
  baseUrl = baseUrl || getPackageBaseUrl();
  dir = dir || getPackageDir();
  const k = KIND[kind];
  if (!k) return { ok: false, reason: `알 수 없는 종류: ${kind}` };
  const versions = await fetchRemoteVersions(baseUrl);
  const v = version ? (versions.versions || []).find((x) => x.version === version)
    : (versions.versions || []).find((x) => x.version === versions.latest) || (versions.versions || [])[0];
  if (!v) return { ok: false, reason: '원격 버전 정보를 찾을 수 없습니다.' };
  const fname = v[k.file];
  const sha = v[k.sha];
  const wantVersion = String(v.version || '').replace(/^v/, '');
  if (!fname) return { ok: false, reason: `버전 ${v.version}에 ${kind} 파일이 없습니다.` };
  // fname 은 원격 versions.json 값 — path.join(dir, fname) 에 그대로 쓰면 '../' 로 packages.dir 밖에
  // 임의 파일을 쓸 수 있다(TLS 로 GitHub 는 신뢰하지만 사내 미러·수기 versions.json 대비 심층 방어).
  // basename 으로 경로 성분을 제거하고 확장자를 화이트리스트(.tar.gz/.zip = listLocalPackages 와 동일)로 강제.
  const safeName = path.basename(String(fname));
  if (safeName !== String(fname) || !/\.(tar\.gz|zip)$/.test(safeName)) {
    return { ok: false, reason: `잘못된 패키지 파일명입니다: ${fname}` };
  }

  fs.mkdirSync(dir, { recursive: true });
  // 대용량 다운로드(수십~수백MB)도 고RTT/일시 끊김 시 재시도(체크섬으로 무결성 검증되므로 안전).
  const res = await resilientFetch(`${trim(baseUrl)}/${safeName}`, { dispatcher: upgradeAgent, timeoutMs: 600000, retries: 2, retryBackoffMs: 2000 });
  if (!res.ok) return { ok: false, reason: `다운로드 실패 HTTP ${res.status}` };
  const rd = await readBytesCapped(res, PACKAGE_MAX_BYTES);
  if (!rd.ok) return { ok: false, reason: `다운로드가 크기 상한(${Math.round(PACKAGE_MAX_BYTES / 1048576)}MB)을 넘어 중단했습니다 — 원격 소스를 확인하세요(UPGRADE_PACKAGE_MAX_BYTES).` };
  const buf = rd.buf;
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  // 무결성 검증 — upgrade.js downloadArchive와 동일 정책으로 통일. 여기 저장된 파일은 설치/
  // 업그레이드에 그대로 쓰여 코드로 실행되므로, sha 부재를 '경고 후 저장'으로 흘리면 미검증
  // 패키지가 설치 경로(packages.dir)에 들어와 downloadArchive의 거부 정책이 우회된다.
  // 공식 릴리스는 4종(tar_gz/installer/installer_cent9/windows) 모두 sha256을 싣는다
  // (packaging/release/update-versions.mjs) — 부재는 사내 미러·수기 versions.json에서만 발생.
  // 그런 경우만 UPGRADE_ALLOW_UNVERIFIED=true 로 우회(downloadArchive와 같은 env).
  if (!sha) {
    if (process.env.UPGRADE_ALLOW_UNVERIFIED !== 'true') {
      return { ok: false, reason: `${fname}에 sha256이 없어 무결성을 검증할 수 없습니다 — 다운로드를 거부합니다(versions.json에 ${k.sha} 추가, 신뢰 미러라면 UPGRADE_ALLOW_UNVERIFIED=true로 우회 가능).` };
    }
    console.warn(`[upgrade] ⚠ ${fname} sha256 없이 저장(UPGRADE_ALLOW_UNVERIFIED=true) — 무결성 미검증 패키지.`);
  } else if (got.toLowerCase() !== String(sha).toLowerCase()) {
    // 대소문자 무시 비교 — 수기 versions.json의 대문자 hex를 '불일치'로 오판하지 않게(downloadArchive와 동일).
    return { ok: false, reason: '체크섬 불일치 — 파일 손상/변조 가능' };
  }

  // v2.730(검토 S-10): 배포자 서명 — 여기 받은 파일은 중앙 /dl 로 엣지 자동 업그레이드에 나가고 원격 설치에 쓰인다.
  //   versions.json 의 sha 는 같은 채널이라 배포자를 인증하지 않는다. manifest 가 버전 항목에 적혀 있으면 그 이름, 아니면 규칙 이름.
  const manName = (typeof v.manifest === 'string' && MANIFEST_NAME_RE.exec(path.basename(v.manifest))?.[1] === wantVersion) ? path.basename(v.manifest) : manifestNameFor(wantVersion);
  const man = await fetchPackageManifest(`${trim(baseUrl)}/${manName}`);
  const sig = decideSignature({
    manifestText: man.text, bytes: buf, name: safeName, kind: k.manifestKind, expectVersion: wantVersion, where: 'package',
    unavailableReason: man.missing ? undefined : man.reason, malformedReason: man.malformed,
  });
  if (!sig.ok) return { ok: false, reason: sig.reason, signature: signatureSummary(sig) };

  const dest = path.join(dir, safeName);
  fs.writeFileSync(dest, buf);
  // manifest 도 같은 폴더에 둔다 — 중앙 /dl 이 엣지에 함께 내주고(routes/dlsource.js), 엣지가 설치 전에 검증한다.
  if (man.text) { try { fs.writeFileSync(path.join(dir, manName), man.text); } catch { /* 엣지가 '서명 없음' 으로 거부한다 — 사유가 보인다 */ } }
  return { ok: true, kind, version: v.version, file: safeName, path: dest, sizeBytes: buf.length, sha256: got, verified: Boolean(sha), signature: signatureSummary(sig) };
}
