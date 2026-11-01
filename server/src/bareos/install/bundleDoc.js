/**
 * bareos/install/bundleDoc.js — Bareos 완전 설치 오프라인 번들의 **이름·문서 형식·검증**(순수 · v2.844).
 *
 * 번들은 CI(.github/workflows/bareos-bundle.yml → packaging/bareos-bundle/build-bundle.sh)가 만들고 릴리스 태그 `bareos-bundle` 에 올린다.
 *   bareos-bundle-<BV>.tar.gz        본체(rpms · wheels · keys · bundle.json)
 *   bareos-bundle-<BV>.json          bundle.json 사본(중앙이 tar 를 풀지 않고 판·패키지 목록을 읽는다)
 *   bareos-bundle-<BV>.manifest.json 서명 manifest — 포탈 릴리스와 **같은 서명 키·같은 검증 코드**(upgrade/signatureCore.js) · 두 파일의 크기·sha256 고정
 *   bareos-bundle.json               최신 포인터(서명 없음 — 가리키기만 한다. 믿는 것은 manifest 서명과 해시 대조다)
 * 규칙:
 *  - 엣지 노드에 root 로 설치되는 묶음이다 — **서명이 맞고 두 파일의 해시가 manifest 와 같을 때만** 쓴다(정책 warn 폴백 없음:
 *    저장소에 배포 키가 이미 있다 — release-signing-keys.json). 다른 버전 manifest 재사용 거부(expectVersion).
 *  - BV 는 x.y.z(서명 manifest 버전 규칙) — <Bareos 메이저>.<YYYYMMDD>.<실행 번호>.
 *  - pyVmomi 는 8.x 만 고를 수 있다: Rocky 9 의 Python 3.9 에서 9.x 는 플러그인이 시작하지 못했다(docs/BAREOS-VMWARE-ROCKY9-INSTALL.md 7.4 현장 기록).
 */
import { verifyEnvelopeText, matchArtifact, VERSION_RE } from '../../upgrade/signatureCore.js';

export const BUNDLE_TAG = 'bareos-bundle';
export const POINTER_NAME = 'bareos-bundle.json';
export const BUNDLE_FORMAT = 'portal-bareos-bundle';
export const POINTER_FORMAT = 'portal-bareos-bundle-pointer';
export const tarName = (v) => `bareos-bundle-${v}.tar.gz`;
export const contentsName = (v) => `bareos-bundle-${v}.json`;
export const manifestName = (v) => `bareos-bundle-${v}.manifest.json`;
export const TAR_RE = /^bareos-bundle-(\d{1,9}\.\d{1,9}\.\d{1,9})\.tar\.gz$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const PKG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;
const PKG_VER_RE = /^[A-Za-z0-9][A-Za-z0-9._+~^-]{0,99}$/;
export const PYVMOMI_RE = /^8\.\d{1,3}\.\d{1,3}(\.\d{1,3}){0,2}$/;
export const POINTER_MAX_BYTES = 8192;
export const CONTENTS_MAX_BYTES = 2 * 1024 * 1024;
export const TAR_MAX_BYTES = 3 * 1024 * 1024 * 1024;

/** 판 비교(숫자 조각) — 큰 것이 먼저. */
export function cmpVersionDesc(a, b) {
  const x = String(a).split('.').map(Number); const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (y[i] || 0) - (x[i] || 0); if (d) return d; }
  return 0;
}

/** 서명 스크립트가 쓰는 포인터(순수). */
export function buildPointer({ version, tarball, contents }) {
  return { format: POINTER_FORMAT, v: 1, version, tarball: { name: tarName(version), size: tarball.size, sha256: tarball.sha256 },
    contents: { name: contentsName(version), size: contents.size, sha256: contents.sha256 }, manifest: manifestName(version) };
}

/** 포인터 판정 — 형식이 맞지 않으면 사유 문자열. */
export function pointerIssue(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return '포인터가 객체가 아닙니다';
  if (p.format !== POINTER_FORMAT || p.v !== 1) return '포인터 형식이 아닙니다';
  if (!VERSION_RE.test(String(p.version || ''))) return '번들 버전 형식이 아닙니다';
  for (const [k, name] of [['tarball', tarName(p.version)], ['contents', contentsName(p.version)]]) {
    const f = p[k];
    if (!f || f.name !== name || !Number.isSafeInteger(f.size) || f.size <= 0 || !SHA_RE.test(String(f.sha256 || ''))) return `포인터의 ${k} 항목이 틀렸습니다`;
  }
  if (p.tarball.size > TAR_MAX_BYTES) return '번들이 상한보다 큽니다';
  if (p.contents.size > CONTENTS_MAX_BYTES) return '내용 목록이 상한보다 큽니다';
  if (p.manifest !== manifestName(p.version)) return '포인터의 manifest 이름이 틀렸습니다';
  return '';
}

/**
 * 내용 목록(bundle.json) 정규화 — 화면·러너가 쓰는 값만 꺼낸다(모르는 키는 버린다). 형식이 틀리면 { issue }.
 * install 은 dnf 에 넘기는 패키지 이름 — 러너 명령에 들어가므로 이름 규칙을 다시 본다.
 */
export function normContents(doc, version) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { issue: '내용 목록이 객체가 아닙니다' };
  if (doc.format !== BUNDLE_FORMAT || doc.v !== 1) return { issue: '내용 목록 형식이 아닙니다' };
  if (doc.version !== version) return { issue: `내용 목록 버전(${String(doc.version).slice(0, 32)})이 번들 버전(${version})과 다릅니다` };
  if (doc.el !== '9' || doc.arch !== 'x86_64') return { issue: 'Rocky/RHEL 9 x86_64 번들이 아닙니다' };
  const install = Array.isArray(doc.install) ? doc.install.map(String) : [];
  if (!install.length || install.length > 60 || !install.every((n) => PKG_NAME_RE.test(n))) return { issue: '설치 패키지 목록이 틀렸습니다' };
  const packages = (Array.isArray(doc.packages) ? doc.packages : []).slice(0, 2000)
    .filter((p) => p && PKG_NAME_RE.test(String(p.name || '')) && PKG_VER_RE.test(String(p.version || '')))
    .map((p) => ({ name: String(p.name), version: String(p.version), release: String(p.release || '').slice(0, 80), arch: String(p.arch || '').slice(0, 16) }));
  const py = doc.pyvmomi && typeof doc.pyvmomi === 'object' ? doc.pyvmomi : {};
  const versions = (Array.isArray(py.versions) ? py.versions.map(String) : []).filter((v) => PYVMOMI_RE.test(v)).sort(cmpVersionDesc).slice(0, 20);
  if (!versions.length) return { issue: '번들에 pyVmomi 8.x 휠이 없습니다' };
  const def = versions.includes(String(py.default)) ? String(py.default) : versions[0];
  const keys = (Array.isArray(doc.keys) ? doc.keys.map(String) : []).filter((k) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(k)).slice(0, 20);
  if (!keys.length) return { issue: '번들에 패키지 서명 키가 없습니다' };
  const s = (v, n = 40) => (typeof v === 'string' && PKG_VER_RE.test(v) ? v.slice(0, n) : '');
  return {
    contents: {
      version, builtAt: typeof doc.builtAt === 'string' ? doc.builtAt.slice(0, 40) : '', bareosVersion: s(doc.bareosVersion), postgresqlVersion: s(doc.postgresqlVersion),
      install, packages, keys, pyvmomi: { versions, default: def, python: '3.9' },
      vddk: (Array.isArray(doc.vddk) ? doc.vddk.map(String) : []).filter((x) => PKG_VER_RE.test(x)).slice(0, 8),
    },
  };
}

/**
 * 받은 세 문서를 대조한다(순수 — 파일 해시는 부른 쪽이 계산해 넘긴다).
 * @param {{ pointer, manifestText, contentsBuf: Buffer, contentsSha256: string, tar: { size, sha256 } }} got
 * @param trust upgrade/signature.js loadTrust() 결과
 * @returns {{ ok: true, version, contents } | { ok: false, code, reason }}
 */
export function verifyBundle({ pointer, manifestText, contentsBuf, contentsSha256, tar }, trust) {
  const pi = pointerIssue(pointer);
  if (pi) return { ok: false, code: 'pointer', reason: pi };
  const v = verifyEnvelopeText(manifestText, trust);
  if (!v.ok) return { ok: false, code: v.code, reason: `번들 서명을 확인하지 못했습니다 — ${v.reason}` };
  const version = pointer.version;
  const checks = [
    { name: tarName(version), size: tar?.size, sha256: tar?.sha256 },
    { name: contentsName(version), size: contentsBuf?.length, sha256: contentsSha256 },
  ];
  for (const c of checks) {
    const m = matchArtifact(v.manifest, { name: c.name, kind: 'other', size: c.size, sha256: c.sha256, expectVersion: version });
    if (!m.ok) return { ok: false, code: m.code, reason: `번들 대조 실패(${c.name}) — ${m.reason}` };
  }
  let doc;
  try { doc = JSON.parse(contentsBuf.toString('utf8')); } catch { return { ok: false, code: 'contents', reason: '내용 목록이 JSON 이 아닙니다' }; }
  const n = normContents(doc, version);
  if (n.issue) return { ok: false, code: 'contents', reason: n.issue };
  return { ok: true, version, contents: n.contents, keyId: v.keyId };
}
