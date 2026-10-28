/**
 * upgrade/signature.js — 업그레이드 번들 배포자 서명 검증의 **런타임 판정 하나**(검토 S-10, v2.730).
 *
 * 모든 설치 경로가 이 `decideSignature` 하나를 탄다 — 원격 다운로드(GitHub·사내 미러·중앙 /dl) · 중앙 → 엣지 push
 * (`/api/upgrade/bundle`) · 중앙 → 수집기 push(`/api/collector/upgrade`) · 감시 폴더 · 오프라인 확인 도구(verifyCli.js).
 * 형식·서명 코어는 `signatureCore.js`(순수 — CI 서명 스크립트와 공용)다.
 *
 * ── 신뢰 키(고정) ─────────────────────────────────────────────────────────────────────────────────────
 *  ① 저장소 파일 `server/src/upgrade/release-signing-keys.json` — 번들과 함께 배포된다. **키 교체는 이 파일로** 한다:
 *     새 키를 이 파일에 추가한 릴리스를 **옛 키로** 서명해 내보내면, 그 릴리스를 설치한 현장은 다음부터 새 키를 믿는다.
 *  ② 호스트 파일 `CONFIG_DIR/release-signing-keys.conf`(선택 — 호스트 관리자가 직접 둔다). 키 추가·회수.
 *     ⚠ 확장자가 `.json`/`.env` 가 아닌 이유: 백업 복원(backup/service.js ALLOW_EXT)·엣지 설정 push 가 그 확장자만 쓴다 —
 *     웹 화면 경로로 이 파일을 넣어 신뢰 키를 늘릴 수 없게 한다. 그룹·기타 쓰기 권한이 있으면 읽지 않는다(검증 중단).
 *     권장 권한은 root:root 소유 · 0644 — 포탈(서비스 계정)이 읽을 수 있어야 하고(못 읽으면 trust-unreadable 로 업그레이드가 멈춘다),
 *     root 로 도는 확인은 root 소유 파일의 키만 받는다(아래 runningAsRoot). install.sh 가 root 소유 도구 폴더에 사본을 둔다(회수 보존).
 *  회수(revoked)는 어느 출처든 이긴다 — 호스트 파일이 저장소 키를 회수할 수 있고, 저장소가 회수한 키를 되살릴 수 없다.
 *
 * ── 정책 ──────────────────────────────────────────────────────────────────────────────────────────────
 *  기본 `require`(서명 필수): 확인할 수 없으면(신뢰 키 없음·manifest 없음·모르는 키) **설치하지 않고** 사유를 남긴다.
 *  ⚠ v2.735.1(사용자 결정 — 서명 키 등록 전 게시): 신뢰 키가 **아직 하나도 설정되지 않은** 설치본(저장소·호스트 어디에도
 *    키 항목이 없고 호스트 파일도 없음)은 env 가 없을 때 `warn` 이다(`signatureCore.resolvePolicy` — CI 와 같은 규칙).
 *    키가 들어간 릴리스를 설치하면 그 설치본은 저절로 require 가 된다. env `UPGRADE_SIGNATURE_POLICY=require` 면 언제나 필수.
 *  호스트 비상 탈출구는 env `UPGRADE_SIGNATURE_POLICY=warn` 뿐이다(portal.env — 웹 화면에서 바꾸는 경로를 두지 않는다).
 *  warn 이어도 **확인했더니 틀린 것**(서명 불일치·회수 키·버전/파일/크기/sha 불일치·형식 오류)은 거부한다 —
 *  탈출구는 '서명이 없는 소스' 를 위한 것이다. warn 으로 진행하면 콘솔·상태·화면에 경고를 남긴다.
 *  모르는 값은 require 로 본다(조용한 약화 금지). SHA 검사·아카이브 경로 검증·크기 상한은 이것과 별개로 그대로다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, currentVersion } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';
import { activeOverride, loadOverride } from './signatureOverride.js';   // v2.810 화면에서 시한부로 끈 상태
import {
  parseKeysDoc, mergeTrust, verifyEnvelopeText, matchArtifact, sha256Hex, strictBase64,
  CANNOT_VERIFY, MANIFEST_MAX_BYTES, manifestNameFor, resolvePolicy, trustUnconfigured,
} from './signatureCore.js';

export const REPO_KEYS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'release-signing-keys.json');
let _repoKeysFile = REPO_KEYS_FILE;
/**
 * 테스트 전용 — 저장소 키 파일 경로를 바꾼다. 운영 코드는 부르지 않고 env 로도 열지 않는다(신뢰 목록을 바꾸는 길을 늘리지 않는다).
 * v2.735.2 에 실제 저장소 목록에 키가 들어가 '키 미설정 설치본' 을 테스트가 따로 만들어야 했다.
 */
export function _setRepoKeysFileForTest(file) { _repoKeysFile = file || REPO_KEYS_FILE; }
export const HOST_KEYS_NAME = 'release-signing-keys.conf';
export const hostKeysFile = (configDir = config.configDir) => path.join(configDir, HOST_KEYS_NAME);
/** push 요청 헤더 — manifest 봉투(JSON)의 base64. */
export const MANIFEST_HEADER = 'x-bundle-manifest';
/** 헤더 값 상한(base64 글자) — node 기본 헤더 총량 16KB 안. 넘으면 보내지 않는다(수신측이 '없음' 으로 판정). */
export const MANIFEST_HEADER_MAX = 12288;
const KEYS_FILE_MAX = 262144;
const DOC = 'docs/RELEASE-SIGNING.md';

/**
 * 정책 — env 가 있으면 그 값(warn | require, 그 밖은 require + invalid). 없으면 신뢰 키 설정 여부로 정한다:
 * 키가 하나도 설정되지 않은 설치본은 warn(source 'unconfigured'), 그 밖은 require(source 'default').
 * `trust` 를 넘기지 않으면 지금 키 파일을 읽어 판단한다(loadTrust — 작은 파일 두 개).
 */
export function signaturePolicy(env = process.env, trust, { ignoreOverride = false } = {}) {
  const v = env.UPGRADE_SIGNATURE_POLICY;
  if (v != null && v !== '') return resolvePolicy(v);
  let t = trust;
  if (t === undefined) { try { t = loadTrust(); } catch { t = null; } }
  // v2.742(INJPKG-01): root 소유 사본이 있으면 호스트 파일이 지워졌어도 '키 미설정' 으로 약해지지 않는다(require 쪽).
  const hostPresent = !!(t?.sources?.host?.present || t?.sources?.rootCopy?.present);
  const base = resolvePolicy(v, { unconfigured: trustUnconfigured(t, { hostPresent }) });
  // v2.810: 화면에서 시한부로 끈 상태(signatureOverride.js) — env 가 없을 때만 · root 확인(install.sh·verify CLI)은 보지 않는다 ·
  //   신뢰 키를 읽지 못했으면(fatal) 적용하지 않는다. 결과는 env warn 과 같다(CANNOT_VERIFY 만 통과 — 틀린 서명은 그대로 거부).
  if (base.policy === 'require' && !ignoreOverride && !runningAsRoot() && t && !t.fatal) {
    const o = activeOverride();
    if (o) return { policy: 'warn', source: 'ui', until: o.until, by: o.by };
  }
  return base;
}

/**
 * 지금 프로세스가 root 인가(v2.741 감사 INJPKG-01). root 로 도는 확인(install.sh·vmware-portal-verify)이 서비스 계정이 쓸 수 있는
 * 호스트 키 파일을 신뢰 기준으로 읽으면, 서비스 계정 권한을 얻은 공격자가 자기 키를 넣어 오프라인 서명 확인을 통과시킨다
 * (install.sh 가 CONFIG_DIR 를 chown -R 서비스 계정으로 바꾼다). 그래서 root 일 때는 **키 추가**를 uid 0 소유 파일에서만 받는다.
 * ⚠ v2.742(RECENT-01): **회수**는 소유자와 무관하게 받는다 — 예전에는 root 소유가 아닌 파일을 통째로 버려 그 파일의 회수 목록까지
 *   사라졌고, 회수한 키로 서명한 패키지를 install.sh·vmware-portal-verify 가 '확인됨' 으로 받았다(회수를 더해도 더 엄격해질 뿐이다).
 *   그 파일이 손상돼 읽히지 않으면 회수 목록을 알 수 없으므로 예전 서비스 계정 판정처럼 fatal 이다(fail-closed).
 */
export const runningAsRoot = () => (_rootForTest != null ? _rootForTest
  : process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0);
let _rootForTest = null;
/** 테스트 전용 — 컨테이너(root)에서 서비스 계정 판정을 재현한다(null = 실제 uid). HTTP·env 로 바꿀 수 없다. */
export function _setRunningAsRootForTest(v) { _rootForTest = v == null ? null : !!v; }
let _hostNotRootWarned = false;
let _rootCopyWarned = false;
/**
 * 호스트 키 파일의 root 소유 사본 경로를 싣는 env(v2.742 감사 INJPKG-01). install.sh 가 root 소유 도구 폴더
 * (release-verify-lib.sh vp_root_tools_dir 아래 trust/)에 사본을 두고, root 로 도는 확인(vmware-portal-verify·install.sh)이 이 env 로
 * 넘긴다. CONFIG_DIR 는 서비스 계정이 쓸 수 있어 root 소유 원본도 지울 수 있다 — 사본이 있으면 지워도 회수가 사라지지 않는다.
 * 사본에서는 **회수 항목만** 받는다(키 추가는 원본에서만). root 판정(rootOwnedOnly)일 때만 읽는다 — 서비스 계정 판정은 예전 그대로.
 */
export const ROOT_TRUST_COPY_ENV = 'VP_ROOT_TRUST_COPY';
/** 키 문서에서 회수 항목만 남긴다(revoked 목록 · keys[].revoked===true) — 키 추가는 버린다. */
const revocationsOnly = (p) => ({ keys: [], revokedIds: p.revokedIds, errors: p.errors });
const activeKeysOf = (p) => p.keys.filter((k) => !k.revoked).length;

function readKeysFile(file, label, { checkPerms = false, rootOwnedOnly = false } = {}) {
  const C = fs.constants;
  // 연 파일(fd)로 판정하고 읽는다 — 소유자·종류 확인과 읽기 사이에 파일이 바뀌어도 확인한 그 파일만 읽는다.
  //   O_NONBLOCK: FIFO 로 바꿔치기돼도 열기에서 멈추지 않는다(아래 isFile 검사가 거부). O_NOFOLLOW: root 판정 대상은 링크를 따라가지 않는다.
  const flags = C.O_RDONLY | (C.O_NONBLOCK || 0) | (rootOwnedOnly ? (C.O_NOFOLLOW || 0) : 0);
  let fd;
  try { fd = fs.openSync(file, flags); } catch (e) {
    if (rootOwnedOnly && e?.code === 'ELOOP') throw Object.assign(new Error(`${label}이(가) 심볼릭 링크입니다`), { code: 'ENOTROOT' });
    throw e;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw Object.assign(new Error(`${label}이(가) 파일이 아닙니다`), { code: 'ENOTFILE' });
    // v2.742(RECENT-01): root 판정에서 root 소유가 아닌 파일도 **읽는다** — 회수 항목만 받기 위해서다(loadTrust 가 키 추가를 버린다).
    //   예전에는 여기서 던져 그 파일의 회수 목록까지 버렸다(회수한 키로 서명한 패키지를 root 확인이 받았다).
    const rootOwned = st.uid === 0;
    if (st.size > KEYS_FILE_MAX) throw Object.assign(new Error(`${label}이(가) 너무 큽니다(${st.size}바이트)`), { code: 'ETOOBIG' });
    // 권한 검사는 키를 받을 파일에만 뜻이 있다 — root 판정에서 회수만 받는 파일은 넓은 권한이어도 더 엄격해질 뿐이다.
    if (checkPerms && process.platform !== 'win32' && (!rootOwnedOnly || rootOwned) && (st.mode & 0o022) !== 0) {
      throw Object.assign(new Error(`${label}의 권한이 너무 넓습니다(그룹·기타 쓰기 가능 — root:root 소유 · chmod 644 로 두세요. 포탈 서비스 계정이 읽을 수 있어야 합니다)`), { code: 'EPERMS' });
    }
    return { doc: JSON.parse(fs.readFileSync(fd, 'utf8')), rootOwned, uid: st.uid };
  } finally { try { fs.closeSync(fd); } catch { /* 이미 닫힘 */ } }
}
/** 읽기 오류 문구 — 서비스 계정이 못 읽는 경우(EACCES)는 고칠 권한을 함께 말한다(v2.742 INJPKG-02). */
function keysReadError(e) {
  const msg = String(e?.message || e?.code || e).slice(0, 200);
  if (e?.code === 'EACCES') return `${msg} — 포탈 서비스 계정이 읽을 수 있게 root:root 소유 · chmod 644 로 두세요(${DOC} 8절)`;
  return msg;
}

/**
 * 신뢰 키를 읽는다. 파일이 작아 매번 읽는다(검증은 드물다). 호스트 파일이 **있는데** 못 읽으면 회수 목록을 알 수 없으므로
 * `fatal` 을 세워 검증을 진행하지 않는다(fail-closed). 저장소 파일을 못 읽어도 fatal.
 */
export function loadTrust({ repoFile = _repoKeysFile, hostFile = hostKeysFile(), rootOwnedOnly = runningAsRoot(),
  rootCopyFile = process.env[ROOT_TRUST_COPY_ENV] || null } = {}) {
  const sources = {
    repo: { file: 'server/src/upgrade/release-signing-keys.json', ok: false, count: 0, error: null },
    host: { file: path.basename(hostFile), present: false, ok: true, count: 0, revoked: 0, error: null, ignored: null },
  };
  const parsed = [];
  let fatal = null;
  try {
    const p = parseKeysDoc(readKeysFile(repoFile, '저장소 신뢰 키 파일').doc, 'repo');
    parsed.push(p);
    sources.repo.ok = true; sources.repo.count = p.keys.length;
  } catch (e) {
    sources.repo.error = String(e?.code || e?.message || e).slice(0, 120);
    fatal = `저장소 신뢰 키 파일을 읽지 못했습니다(${sources.repo.error})`;
  }
  let present = false;
  try { present = fs.existsSync(hostFile); } catch { present = false; }
  if (present) {
    sources.host.present = true;
    const label = `호스트 신뢰 키 파일(${HOST_KEYS_NAME})`;
    try {
      const r = readKeysFile(hostFile, label, { checkPerms: true, rootOwnedOnly });
      const p = parseKeysDoc(r.doc, 'host');
      if (rootOwnedOnly && !r.rootOwned) {
        // root 로 도는 확인 — 서비스 계정이 쓸 수 있는 파일의 **키 추가**는 받지 않는다(신뢰 기준을 넓히지 못하게).
        //   **회수**는 받는다(v2.742 RECENT-01 — '회수는 어느 출처든 이긴다'. 회수를 더해도 더 엄격해질 뿐이다). 파일이 있다는
        //   사실(present)은 그대로 두어 정책은 '키 미설정' 으로 약해지지 않는다(require 쪽).
        parsed.push(revocationsOnly(p));
        sources.host.ignored = 'not-root-owned';
        sources.host.ignoredKeys = activeKeysOf(p);
        sources.host.revoked = p.revokedIds.size;
        sources.host.error = `${label}이(가) root 소유가 아닙니다(uid ${r.uid})`;
        if (!_hostNotRootWarned) {
          _hostNotRootWarned = true;
          console.warn(`⚠ ${sources.host.error} — root 로 실행하는 서명 확인은 이 파일의 키 추가(${sources.host.ignoredKeys}개)를 받지 않고 회수 항목(${sources.host.revoked}개)만 합칩니다 `
            + `(서비스 계정이 쓸 수 있는 파일로 신뢰 기준을 넓히지 않는다). 내용을 확인한 뒤 root:root 소유·chmod 644 의 새 파일로 바꾸세요(${DOC} 8절).`);
        }
      } else {
        parsed.push(p);
        sources.host.count = p.keys.length; sources.host.revoked = p.revokedIds.size;
      }
    } catch (e) {
      if (e?.code === 'ENOTROOT') {
        // root 판정의 심볼릭 링크 — 따라가지 않는다(대상을 바꿔치기할 수 있다). 읽지 않았으므로 회수도 받지 못한다 —
        //   지운 것과 같은 결과이고, 그 경우를 root 소유 사본(VP_ROOT_TRUST_COPY)이 막는다.
        sources.host.ignored = 'not-root-owned';
        sources.host.error = String(e?.message || e).slice(0, 200);
        if (!_hostNotRootWarned) {
          _hostNotRootWarned = true;
          console.warn(`⚠ ${sources.host.error} — root 로 실행하는 서명 확인은 이 파일을 읽지 않습니다(링크를 따라가지 않는다). `
            + `내용을 확인한 뒤 root:root 소유·chmod 644 의 파일로 두세요(${DOC} 8절).`);
        }
      } else {
        sources.host.ok = false;
        sources.host.error = keysReadError(e);
        fatal = fatal || `호스트 신뢰 키 파일을 읽지 못했습니다 — 회수 목록을 알 수 없어 검증을 진행하지 않습니다(${sources.host.error})`;
      }
    }
  }
  if (rootOwnedOnly && rootCopyFile) {
    // v2.742(INJPKG-01): install.sh 가 root 소유 도구 폴더에 둔 호스트 키 파일 사본 — 회수 항목만 합친다.
    sources.rootCopy = { file: path.basename(String(rootCopyFile)), present: false, ok: true, revoked: 0, error: null, notRootOwned: false };
    let st = null;
    try { st = fs.lstatSync(rootCopyFile); } catch { st = null; }
    if (st) {
      sources.rootCopy.present = true;
      try {
        const r = readKeysFile(rootCopyFile, '호스트 신뢰 키 root 소유 사본', { rootOwnedOnly: true });
        const p = parseKeysDoc(r.doc, 'host-copy');
        parsed.push(revocationsOnly(p));
        sources.rootCopy.revoked = p.revokedIds.size;
        if (!r.rootOwned) {
          sources.rootCopy.notRootOwned = true;
          if (!_rootCopyWarned) { _rootCopyWarned = true; console.warn(`⚠ 호스트 신뢰 키 root 소유 사본이 root 소유가 아닙니다(uid ${r.uid}) — 회수 항목만 합칩니다. install.sh 를 다시 실행하세요.`); }
        }
      } catch (e) {
        if (e?.code === 'ENOTROOT') {
          sources.rootCopy.ok = false;
          sources.rootCopy.error = String(e?.message || e).slice(0, 200);
          if (!_rootCopyWarned) { _rootCopyWarned = true; console.warn(`⚠ ${sources.rootCopy.error} — 사본을 읽지 않습니다. install.sh 를 다시 실행하세요.`); }
        } else {
          sources.rootCopy.ok = false;
          sources.rootCopy.error = keysReadError(e);
          fatal = fatal || `호스트 신뢰 키 root 소유 사본을 읽지 못했습니다 — 회수 목록을 알 수 없어 검증을 진행하지 않습니다(${sources.rootCopy.error})`;
        }
      }
    }
  }
  const t = mergeTrust(parsed);
  return { ...t, sources, fatal };
}

/* ── 검증 기록(v2.736.1) ─────────────────────────────────────────────────────────────────────────────────
 * 사용자 신고(2.736.0 업그레이드 화면 캡처): '마지막 검증 — 아직 검증한 번들이 없습니다'. 기록이 프로세스 메모리에만 있었는데
 * 업그레이드는 새 번들을 확인한 **직후 재시작**하므로 그 기록은 재시작과 함께 사라졌고, 평소의 '업데이트 확인' 은 새 버전이
 * 없으면 검증하지 않아 다시 채워지지도 않았다. 그래서 운영 포탈에서 이 줄은 사실상 언제나 비어 '검증한 적이 없다' 로 읽혔다
 * (앱 안 업그레이드로 설치한 버전이면 설치 때 확인을 거쳤다 — 서명 필수 정책에서는 통과하지 못한 번들을 설치하지 않는다.
 *  install.sh 설치의 확인 결과는 그 설치 로그에만 있고, 신규 설치 등은 확인을 건너뛴다 — release-verify-lib.sh).
 * 이제 최근 기록(최신 먼저, SIG_LOG_MAX 개)을 상태 파일에 남긴다. 규칙:
 *  - 파일에 쓰는 것은 서버 프로세스가 `enableSignatureLog()` 를 부른 뒤뿐이다 — 오프라인 확인 도구(verifyCli — install.sh 가
 *    root 로 부를 수 있다)와 테스트가 import 만으로 CONFIG_DIR 에 쓰지 않게(root 소유 파일이 남으면 서비스 계정이 못 고친다).
 *  - 쓰기는 동기 원자 쓰기다 — 업그레이드는 검증 직후 재시작하므로 디바운스하면 그 기록이 사라진다(검증은 드물다: 설치 1회에 2~3번).
 *  - 쓰기 실패는 판정을 바꾸지 않는다(콘솔과 상태 `log.error` 에만). 손상 파일은 보존(.corrupt.<ts>) 후 새로 시작한다.
 *  - 아는 필드만 담고 글자 길이를 자른다 — 읽을 때도 같은 정제를 한다(손으로 고친 파일이 화면을 깨지 않게).
 *  - 누적 개수(counts)는 예전처럼 이 프로세스 시작 뒤만 센다(화면 문구가 '프로세스 시작 뒤' 라고 말한다).
 */
registerStateFile('upgrade-signature-log.json');
export const SIG_LOG_MAX = 10;
export const sigLogFile = (configDir = config.configDir) => path.join(configDir, 'upgrade-signature-log.json');
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);
let _recent = [];
let _counts = { verified: 0, warned: 0, rejected: 0 };
let _log = { enabled: false, file: null, error: null, corruptKept: null, loadedCount: 0 };

const VERSION_TEXT_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
const capText = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
/** 기록 한 줄 정제(쓰기·읽기 공용) — 아는 필드만. 시각이 숫자가 아니면 버린다(null). */
export function sanitizeSigEntry(d) {
  if (!d || typeof d !== 'object') return null;
  const at = Number(d.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  const ver = typeof d.version === 'string' && VERSION_TEXT_RE.test(d.version) ? d.version : null;
  const av = typeof d.appVersion === 'string' && VERSION_TEXT_RE.test(d.appVersion) ? d.appVersion : null;
  return {
    at, where: capText(d.where, 40) || 'unknown', ok: d.ok === true, verified: d.verified === true, warned: d.warned === true,
    code: capText(d.code, 60), reason: capText(d.reason, 400) || '', keyId: capText(d.keyId, 80), version: ver,
    name: capText(d.name, 200), policy: d.policy === 'warn' || d.policy === 'require' ? d.policy : null, appVersion: av,
  };
}
function readSigLog(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e?.code === 'ENOENT') return { recent: [] };
    return { recent: [], error: `검증 기록 파일을 읽지 못했습니다(${String(e?.code || e?.message || e).slice(0, 80)})` };
  }
  let doc;
  try { doc = JSON.parse(text); } catch { doc = undefined; }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.recent)) {
    const kept = preserveCorrupt(file, 'upgrade-signature-log');
    return { recent: [], error: '검증 기록 파일이 손상되어 새로 시작했습니다', corruptKept: kept ? path.basename(kept) : null };
  }
  // 쓴 순서(최신 먼저)를 그대로 쓴다 — 벽시계 at 으로 다시 정렬하면 그사이 시계가 뒤로 맞춰진 경우 재시작 뒤 '마지막' 이 바뀐다.
  const recent = doc.recent.map(sanitizeSigEntry).filter(Boolean).slice(0, SIG_LOG_MAX);
  return { recent };
}

/**
 * 서버 프로세스가 기동 때 한 번 부른다(index.js). 파일의 기록을 읽어 메모리 앞에 둔다 — 이 호출 전에 이미 생긴 메모리 기록이
 * 있으면(기동 중 검증) 그것이 더 최신이므로 앞에 둔다. 다시 불러도 안전하다(같은 파일이면 다시 읽기만 한다).
 */
export function enableSignatureLog({ configDir = config.configDir } = {}) {
  const file = sigLogFile(configDir);
  const r = readSigLog(file);
  const seen = new Set(_recent.map((e) => `${e.at}|${e.where}|${e.name || ''}`));
  _recent = [..._recent, ...r.recent.filter((e) => !seen.has(`${e.at}|${e.where}|${e.name || ''}`))].slice(0, SIG_LOG_MAX);
  _log = { enabled: true, file, error: r.error || null, corruptKept: r.corruptKept || null, loadedCount: r.recent.length };
  if (r.error) console.warn(`[upgrade] ${r.error}${r.corruptKept ? ` — 원본은 ${r.corruptKept}` : ''}`);
  return { loaded: r.recent.length, error: r.error || null };
}

function writeSigLog() {
  if (!_log.enabled || !_log.file) return;
  try {
    atomicWriteFileSync(_log.file, JSON.stringify({ v: 1, recent: _recent }), { mode: 0o600 });
    _log.error = null;
  } catch (e) {
    _log.error = `검증 기록을 파일에 남기지 못했습니다(${String(e?.code || e?.message || e).slice(0, 80)}) — 재시작하면 이번 기록은 사라집니다`;
    console.warn(`[upgrade] ${_log.error}`);
  }
}

export function recordVerification(d) {
  let appVersion = null;
  try { appVersion = currentVersion(); } catch { /* 버전을 못 읽어도 기록은 남긴다 */ }
  const e = sanitizeSigEntry({ ...d, appVersion });
  if (e) {
    _recent = [e, ..._recent].slice(0, SIG_LOG_MAX);
    writeSigLog();
  }
  if (d.verified) _counts.verified += 1; else if (d.ok) _counts.warned += 1; else _counts.rejected += 1;
}
export function _resetSignatureStatusForTest() {
  _recent = []; _counts = { verified: 0, warned: 0, rejected: 0 };
  _log = { enabled: false, file: null, error: null, corruptKept: null, loadedCount: 0 };
}

function guidance(code) {
  if (code === 'no-trusted-keys') return ` 이 설치본에 신뢰 공개키가 없습니다 — 공개키가 들어간 릴리스로 업그레이드하거나 호스트 파일 ${HOST_KEYS_NAME} 에 키를 두세요(${DOC}).`;
  if (code === 'manifest-missing' || code === 'manifest-unavailable') return ` 번들과 같은 폴더(또는 원격 소스)에 ${manifestNameFor('<버전>')} 가 있어야 합니다(${DOC}).`;
  if (code === 'unknown-key') return ` 이 설치본이 모르는 키입니다 — 키 교체 릴리스를 먼저 설치했는지 확인하세요(${DOC}).`;
  if (code === 'trust-unreadable') return ` 신뢰 키 파일을 확인하세요(${DOC}).`;
  return '';
}

/**
 * 설치 전 서명 판정 — 모든 경로가 이 함수 하나를 쓴다.
 * @param {object} o
 * @param {string|Buffer|null} o.manifestText 봉투 글(없으면 null)
 * @param {Buffer} [o.bytes] 산출물 바이트(sha256·size 를 직접 계산) — 또는 o.sha256 + o.size
 * @param {string} [o.name] 산출물 파일 이름(원격·감시 폴더). push 는 이름이 없어 kind+sha 로 찾는다.
 * @param {string|null} [o.kind='bundle'] null 이면 종류를 따지지 않는다(오프라인 확인 도구 — 이름으로 찾는다)
 * @param {string} [o.expectVersion] 요청·설치하려는 버전 — manifest 버전과 같아야 한다
 * @param {string} o.where 'remote'|'push-edge'|'push-collector'|'watch'|'package'|'offline'|'bundle-source'
 * @param {string} [o.unavailableReason] manifest 를 가져오다 실패한 사유(없음과 구분)
 * @param {object} [o.trust] 테스트·CLI 가 주입하는 신뢰 집합(loadTrust 결과)
 * @param {'require'|'warn'} [o.policy]
 * @param {boolean} [o.preflight] 번들을 받기 전 사전 확인 — 서명·버전·이름만(주어진 sha·크기는 대조), 바이트 대조는 받은 뒤에
 * @param {string} [o.malformedReason] manifest 를 받다 형식 오류로 판정한 사유(상한 초과 등 — 정책과 무관하게 거부)
 * @returns {{ok:boolean, verified:boolean, warned?:boolean, code?:string, reason?:string, keyId?:string, version?:string, policy:string, where:string, at:number}}
 */
export function decideSignature(o = {}) {
  const trust = o.trust || loadTrust();
  // v2.810: 오프라인 확인(verify CLI — root 로 돈다)은 화면 설정을 보지 않는다(signaturePolicy 의 root 판정과 이중)
  const pol = o.policy ? { policy: o.policy, source: 'arg' } : signaturePolicy(process.env, trust, { ignoreOverride: o.where === 'offline' });
  const sha = o.sha256 ? String(o.sha256).toLowerCase() : (o.bytes ? sha256Hex(o.bytes) : '');
  const size = Number.isFinite(o.size) ? o.size : (o.bytes ? o.bytes.length : undefined);
  let r;
  const noKeys = { ok: false, code: 'no-trusted-keys', reason: '신뢰 공개키가 0개입니다' };
  if (trust.fatal) r = { ok: false, code: 'trust-unreadable', reason: trust.fatal };
  else if (o.malformedReason) r = { ok: false, code: 'manifest-malformed', reason: String(o.malformedReason) };
  else if (o.manifestText == null || o.manifestText === '') {
    if (!trust.activeCount) r = noKeys;
    else r = o.unavailableReason ? { ok: false, code: 'manifest-unavailable', reason: o.unavailableReason } : { ok: false, code: 'manifest-missing', reason: '서명 manifest 가 없습니다' };
  } else {
    // ⚠ 신뢰 키가 0개여도 봉투는 검증한다 — 회수된 키·틀린 서명은 '확인할 수 없음' 이 아니라 '틀림' 이다(warn 이어도 거부).
    //   모르는 키인데 신뢰 키가 0개면 그때만 '신뢰 키 없음' 으로 말한다.
    const v = verifyEnvelopeText(o.manifestText, trust);
    if (!v.ok) r = (v.code === 'unknown-key' && !trust.activeCount) ? { ...noKeys, keyId: v.keyId } : v;
    else {
      const m = matchArtifact(v.manifest, { name: o.name, kind: o.kind === undefined ? 'bundle' : o.kind, size, sha256: sha, expectVersion: o.expectVersion, checkHash: !o.preflight });
      r = m.ok ? { ok: true, keyId: v.keyId, version: v.manifest.version } : { ...m, keyId: v.keyId, version: v.manifest.version };
    }
  }
  const base = { policy: pol.policy, where: String(o.where || 'unknown'), at: Date.now(), name: o.name || null };
  let out;
  if (r.ok) out = { ok: true, verified: true, keyId: r.keyId, version: r.version, ...base };
  else if (CANNOT_VERIFY.has(r.code) && pol.policy === 'warn') {
    const why = pol.source === 'unconfigured'
      ? '이 설치본에 서명 공개키가 아직 설정되지 않아(키 등록 전 릴리스) 경고 후 진행합니다'
      : pol.source === 'ui'
        ? `업그레이드 화면에서 서명 확인을 ${new Date(pol.until).toISOString().slice(0, 16).replace('T', ' ')} UTC 까지 끄도록 해(${pol.by || '?'}) 진행합니다`
        : 'UPGRADE_SIGNATURE_POLICY=warn 이라 진행합니다';
    out = { ok: true, verified: false, warned: true, code: r.code, reason: `서명을 확인하지 못했지만 ${why} — ${r.reason}`, keyId: r.keyId || null, version: r.version || null, policySource: pol.source || null, ...base };
    console.warn(`[upgrade] ⚠ 서명 미확인 설치 허용(${pol.source === 'unconfigured' ? '서명 키 미설정' : pol.source === 'ui' ? `화면에서 끔 — ${pol.by || '?'}` : 'UPGRADE_SIGNATURE_POLICY=warn'}, ${base.where}): ${r.reason}`);
  } else {
    out = { ok: false, verified: false, code: r.code, reason: `서명 검증 실패 — ${r.reason}.${guidance(r.code)}`, keyId: r.keyId || null, version: r.version || null, ...base };
    console.warn(`[upgrade] 서명 검증 실패(${base.where}, ${r.code}): ${r.reason}`);
  }
  recordVerification(out);
  return out;
}

/** 판정 결과를 응답·lastResult 에 싣는 짧은 형태(사유 글은 reason 이 따로 갖는다). */
export const signatureSummary = (d) => (d ? { verified: !!d.verified, warned: !!d.warned, code: d.code || null, keyId: d.keyId || null, version: d.version || null, policy: d.policy, where: d.where } : null);

/** 상태 — 업그레이드 화면이 '신뢰 키 수 · 마지막 검증 결과 · 정책' 을 보여 준다(공개키 id 만 — 비밀 없음). */
export function signatureStatus() {
  const t = loadTrust();
  const pol = signaturePolicy(process.env, t);
  const activeIds = [...t.byId.values()].filter((k) => !k.revoked && k.publicKey).map((k) => k.keyId);
  return {
    policy: pol.policy, policySource: pol.source, policyInvalid: pol.invalid || null,
    // v2.810 화면 끄기 — envLocked 면 화면에서 바꿀 수 없다 · override 는 저장된 기록(시한이 지났으면 expired)
    envLocked: (() => { const v = process.env.UPGRADE_SIGNATURE_POLICY; return v != null && v !== ''; })(),
    override: (() => { const o = loadOverride(); return o ? { until: o.until, at: o.at, by: o.by, active: Date.now() < o.until } : null; })(),
    unconfigured: pol.source === 'unconfigured',
    trustedKeys: t.activeCount, revokedKeys: t.revokedCount, keyIds: activeIds.slice(0, 8),
    ready: !t.fatal && t.activeCount > 0,
    fatal: t.fatal, errors: t.errors.slice(0, 5),
    sources: t.sources,
    // v2.736.1: 기록은 재시작을 넘어 남는다 — beforeStart 는 '이 프로세스가 시작되기 전(대개 업그레이드 직전)에 남긴 기록' 이다.
    last: _recent[0] ? { ..._recent[0], beforeStart: _recent[0].at < PROCESS_STARTED_AT } : null,
    recent: _recent.slice(0, 5).map((e) => ({ ...e, beforeStart: e.at < PROCESS_STARTED_AT })),
    counts: { ..._counts },
    currentVersion: (() => { try { return currentVersion(); } catch { return null; } })(),
    processStartedAt: PROCESS_STARTED_AT,
    log: { enabled: _log.enabled, error: _log.error, corruptKept: _log.corruptKept },
  };
}

/* ───────────────────────────── manifest 파일·헤더 ───────────────────────────── */

const ARCHIVE_VER_RE = /vmware-portal-(\d{1,9}\.\d{1,9}\.\d{1,9})\.(?:tar\.gz|tgz|zip)$/;
/** 번들 파일 옆의 manifest 경로(같은 폴더 · 같은 버전). 이름이 규칙에 맞지 않으면 null. */
export function manifestPathForArchive(archivePath) {
  const m = ARCHIVE_VER_RE.exec(path.basename(String(archivePath || '')));
  return m ? path.join(path.dirname(archivePath), manifestNameFor(m[1])) : null;
}
export const archiveVersionOf = (archivePath) => ARCHIVE_VER_RE.exec(path.basename(String(archivePath || '')))?.[1] || null;

// 릴리스 산출물 이름 전부(번들·el9·cent9·windows) — update-versions.mjs·release-sign.mjs 의 이름 규칙과 같다.
const ARTIFACT_VER_RE = /^vmware-portal-(?:offline-|win-)?(\d{1,9}\.\d{1,9}\.\d{1,9})(?:\.tar\.gz|\.tgz|\.zip|(?:-[a-z0-9]{1,16})?-x64\.(?:tar\.gz|zip))$/;
/**
 * 산출물 파일 옆의 manifest 경로 — **있을 때만**(없으면 null). 에이전트 원격 배포(agent/deploy.js)가 설치 패키지와 함께
 * 원격 호스트로 올려 install.sh --package/--manifest 로 넘기는 데 쓴다(기존 설치본이 v2.730 이상이면 install.sh 가 확인을 요구한다).
 */
export function manifestPathForArtifact(p) {
  const m = ARTIFACT_VER_RE.exec(path.basename(String(p || '')));
  if (!m) return null;
  const mp = path.join(path.dirname(p), manifestNameFor(m[1]));
  try { return fs.statSync(mp).isFile() ? mp : null; } catch { return null; }
}

/** manifest 파일을 읽는다 — 없으면 null. 상한보다 크면 상한+1 바이트만 읽어 검증이 '형식 오류' 로 거부하게 한다. */
export function readManifestFile(p) {
  if (!p) return null;
  let fd;
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    const n = Math.min(st.size, MANIFEST_MAX_BYTES + 1);
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    return buf.toString('utf8');
  } catch { return null; } finally { if (fd != null) try { fs.closeSync(fd); } catch { /* */ } }
}

/** push 헤더 값으로 — 상한을 넘으면 null(보내지 않는다). */
export function encodeManifestHeader(text) {
  if (text == null || text === '') return null;
  const b = Buffer.from(String(text), 'utf8').toString('base64');
  return b.length <= MANIFEST_HEADER_MAX ? b : null;
}
/** 수신 헤더 → 봉투 글. 헤더가 없으면 null. base64 가 아니면 원문을 그대로 돌려 검증이 '형식 오류' 로 거부하게 한다. */
export function decodeManifestHeader(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim().slice(0, MANIFEST_HEADER_MAX + 4);
  const buf = strictBase64(s, MANIFEST_HEADER_MAX + 4);
  return buf ? buf.toString('utf8') : s;
}
