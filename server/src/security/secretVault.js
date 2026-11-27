/**
 * secretVault.js — 설정 파일 자격증명(비밀번호·SSH 키·토큰)의 저장 방식(평문/암호화) 중앙 모듈(v2.296).
 *
 * 사용자 요구사항(2026-08-15): 프로그램이 쓰는 모든 계정 비밀번호(vCenter·NSX·엣지/수집기·
 * iDRAC·스캔대역·GPU/게스트 OS·Horizon·원격접속·캡처·에이전트 배포)를 ① 평문 또는 ② 암호화로
 * 저장할 수 있고, 암호화는 보안 레벨 1/2/3 또는 알고리즘을 직접 골라 쓸 수 있으며,
 * ③ 운영 중 평문↔암호화 전환(기존 저장분 일괄 마이그레이션)이 가능해야 한다.
 *
 * 설계(각 결정의 이유):
 * - **로드 시 복호 · 저장 시 봉인**: 모든 대상 레지스트리가 'readFileSync+parse / atomicWrite'
 *   의 균일 패턴이라, 그 경계에 openSecretsDeep/sealSecretsDeep 를 끼우면 **비밀번호를 소비하는
 *   코드(restClient·guestops·redfish 등)는 한 줄도 바꾸지 않는다**(메모리는 항상 평문).
 *   모드 전환도 재시작 없이 안전하다 — 실행 중 프로세스는 이미 평문을 들고 있고, 다음 save 가
 *   현재 정책대로 봉인한다.
 * - **자기서술(self-describing) 암호문**: `enc$1$<alg>$<logN>$<salt>$<iv>$<tag>$<ct>`(base64url).
 *   복호에 현재 정책이 필요 없어, 레벨/알고리즘을 바꿔도 기존 암호문이 그대로 읽히고(혼재 허용)
 *   마이그레이션 도중 크래시가 나도 파일이 절반 평문/절반 암호문인 상태에서 정상 동작한다.
 * - **AEAD 만 사용**(GCM/Poly1305): 변조되면 복호가 실패한다(무결성 내장). CBC 등 비인증 모드는
 *   제공하지 않는다 — '알고리즘 선택'은 안전한 선택지 안에서만.
 * - **키 관리**: env SECRETS_KEY 우선, 없으면 CONFIG_DIR/secrets-key 1회 생성(0600, 원자적) 후
 *   재사용(auth-secret v2.289 와 같은 패턴). ⚠ 정직한 한계: 키 파일이 설정 파일과 같은 호스트에
 *   있으므로 이 암호화는 '백업/사본/저장소 유출 시 평문 노출'을 막는 저장 시점(at-rest) 보호다 —
 *   호스트 자체가 완전히 장악되면 키도 함께 노출된다(그건 어떤 로컬 암호화도 못 막는다).
 *   그 이상이 필요하면 SECRETS_KEY 를 외부 비밀관리(환경변수 주입)로 옮길 것.
 * - **필드 선택은 정확 일치**: SECRET_FIELDS(password·privateKey·token)와 키 이름이 정확히 같은
 *   문자열 값만 봉인한다. users.json 의 passwordHash(이미 해시)는 이름이 달라 절대 걸리지 않고,
 *   봉인은 이 모듈에 **등록된 파일**(SECRET_FILES)에서만 일어난다 — 외부 프로그램이 직접 읽는
 *   공유 파일(ipam.db 등)은 등록하지 않는다.
 *   users.json 의 OTP 시드(totpSecret · totpPendingSecret)는 **파일 한정 추가 필드 + 레코드 단위 봉인**이다
 *   (보안 잔여 11-27 M3 — openRecordFields/sealRecordFields · 아래 '레코드 단위 봉인' 절. 일반 경로를 타지 않는 이유도 거기).
 * - **복호 실패는 빈 문자열 + 경고**(throw 금지): 폴링 루프가 자격증명 하나 때문에 죽으면 안
 *   된다. 키 분실 시 비밀번호는 복구 불가이므로(설계상 당연) 사용자는 해당 계정 비번을 재입력
 *   해야 한다 — UI 가 이 한계를 고지한다.
 *
 * 컴팩트 후 이어받기 메모: 대상 파일 추가 시 ① 그 레지스트리 load 에 openSecretsDeep, save 에
 * sealSecretsDeep 를 끼우고 ② 아래 SECRET_FILES 에 파일명을 추가할 것(마이그레이션 대상 등록).
 * 한쪽만 하면 '전환 시 그 파일만 안 바뀌는' 반쪽 상태가 된다.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { fileMissing } from '../util/fileMissing.js';   // 134회차: '정말 없는가'(ENOENT 만 — existsSync 는 stat 실패도 false)

// ⚠ 경로는 지연 평가(함수) — config.js 가 이 모듈을 import 하므로(loadVcenterConfig 복호 배선)
// 모듈 평가 시점에 config.configDir 를 읽으면 순환 import TDZ 로 기동이 죽는다. 함수 호출
// 시점에는 양쪽 모듈 평가가 끝나 있어 안전하다(ESM 순환의 표준 해법).
const policyFile = () => path.join(config.configDir, 'secrets-policy.json');
// S-07(2026-10-09): 정책의 신뢰 사본 — 정책을 저장하거나 정상으로 읽을 때마다 같은 내용으로 맞춘다. 정책 파일이 손상·삭제되면
// 이 사본으로 복구한다(아래 loadSecretsPolicy). 비밀은 담지 않는다(모드·레벨·알고리즘뿐).
const trustedPolicyFile = () => path.join(config.configDir, 'secrets-policy.trusted.json');
const keyFile = () => path.join(config.configDir, 'secrets-key');

// 봉인 대상 필드(정확 일치). token = 엣지/수집기 접속 토큰(collectors.json — 사용자 요구의
// 'edge 접속에 사용하는 계정'). vcenterPass/guestPass/centralToken/collectorToken 은
// agent-deploy-targets.json(에이전트 배포 대상)의 시크릿 필드명. passwordHash 등 유사 이름은
// 걸리지 않는다(정확 일치 — users.json 해시 오봉인 방지).
export const SECRET_FIELDS = new Set(['password', 'privateKey', 'passphrase', 'token', 'vcenterPass', 'guestPass', 'centralToken', 'collectorToken']);

// 마이그레이션(모드 전환) 대상 파일 — 각 레지스트리 load/save 에 open/seal 이 끼워진 파일만.
// (uagmon 데스크톱 앱은 별도 배포물이라 서버 스코프 밖 — 여기 등록하지 않는다.)
export const SECRET_FILES = [
  'vcenters.json',                 // vCenter 접속 계정
  'nsx.json',                      // NSX 매니저 접속 계정
  'collectors.json',               // 엣지/수집 서버 접속 토큰
  'storage-devices.json',          // 스토리지 장비(Isilon 등) 접속 비밀번호(v2.302)
  'sanswitch-devices.json',        // SAN 스위치(Brocade FOS) 접속 비밀번호(v2.410)
  'cvp-servers.json',              // Arista CloudVision(CVP) 서비스 계정 토큰·비밀번호(v2.608)
  'pdu-devices.json',              // PDU(APC Rack PDU 2G) 접속 비밀번호(v2.424)
  'rma-agents.json',               // 엣지 RMA(원격 명령) 서명 비밀번호(v2.416)
  'credentials.json',              // 통합 계정 관리(RMA SSH 계정: 비밀번호/개인키/패스프레이즈, v2.419)
  'idrac.json',                    // iDRAC/OME 계정
  'idrac-scan-ranges.json',        // 법인별 iDRAC 스캔 계정
  'gpu-guest.json',                // GPU 게스트 OS 공용/VM별 계정
  'bm-events.json',                // v3.52 물리서버 이벤트 구독 — 받는 주소 비밀 · Context 열쇠(파일 한정 추가 필드 — 디버깅 5회차 보안 #1)
  'gpu-physical.json',             // 물리 GPU 서버 SSH 계정
  'horizon.json',                  // Horizon 접속 계정
  'remote-access.json',            // 원격접속(HAProxy dataplane·SSH 프록시) 계정/키
  'capture-monitors.json',         // 네트워크 캡처 호스트 SSH 계정/키
  'agent-deploy-targets.json',     // 에이전트 배포 대상 SSH 계정/키
  'relay-topology.json',           // 중계 토폴로지 노드(Main/Edge/IRS) SSH 계정/키(v2.431)
  'central-agent-gpu-guest.json',  // 엣지 배포용 GPU 게스트 설정 사본(계정 포함)
  'mail.json',                     // 포탈 공용 메일(SMTP) 계정 비밀번호(v2.454)
  'bm-storage.json',               // 베어메탈 스토리지 SSH 계정 비밀번호(v2.500 감사 M4 — 등록 누락이었다)
  'veeam-servers.json',            // Veeam Backup & Replication REST 접속 비밀번호(v2.751 — veeam/registry.js)
  'veeam-em.json',                 // Veeam Enterprise Manager REST 접속 비밀번호(v2.788 — veeam/em/registry.js)
  // v2.538 저장 데이터 감사 — 아래 4개는 비밀을 담는데 **등록·봉인 배선이 없었다**(bm-storage 와 같은 계열의
  // 재발). 파일에 비밀 필드를 두면 ① load 에 openSecretsDeep ② save 에 sealSecretsDeep ③ 여기 등록 — 셋을 같이.
  'agent-assignments.json',        // 에이전트 위임 IP 스캔 할당 — iDRAC 계정 비밀번호(central/assignments.js)
  'guest-scans.json',              // 게스트 로그인 스캔 예약 — 게스트 OS 계정(guestPass)(security/guestScanScheduler.js)
  'upgrade.json',                  // 자동 업그레이드 원격 소스 토큰(upgrade/settings.js)
  'packages.json',                 // 패키지 저장소 토큰(upgrade/packageSettings.js)
  // v2.562: 외부 연동 API 키. 값은 sha256 해시만 저장하지만 이름·지문·허용목록이 평문으로
  // 남으므로 `.gitignore` 차단과 **함께** 해야 한다(v2.535 규약 — 둘은 별개 항목).
  'api-keys.json',                 // 외부 포탈용 조회 API 키(publicapi/keys.js)
  // v2.604(감사 SEC2604-03): Slack·Teams·일반 웹훅 URL 은 경로 자체가 비밀(그 URL 만 있으면 누구나 채널에 글을 쓴다)인데
  // 필드 이름이 `url` 이라 SECRET_FIELDS(정확 일치)에 걸리지 않아 암호화 모드에서도 평문이었다. `url` 을 전역 필드로
  // 넣으면 collectors.json 등의 접속 주소까지 봉인되므로, **이 파일에서만** 추가 필드로 봉인한다(FILE_EXTRA_SECRET_FIELDS).
  'alerts.json',                   // 알림 채널 웹훅 URL(alerts.js — 파일 한정 추가 필드 'url')
  'bareos.json',                   // Bareos Director 콘솔 비밀번호(bareos/settings.js, v2.820)
  'bareos-edge-directors.json',    // 엣지가 받은 법인 Director 대행 사본 — 콘솔 비밀번호(bareos/edgeStore.js, v2.824)
  'ssh-keys.json',                 // 7b: SSH 키 저장소 개인키 · passphrase + 법인 공통 계정 비밀번호(bmusage/onboard/keyStore.js)
  // 7b 감사 L-4: 온보딩 적용 직전 스냅샷(원본 바이트 = 봉인 그대로) — 봉인 방식 전환 · 평문 점검이 이 사본도 같이 다루게.
  'onboard-prev/bm-storage.json',
  'onboard-prev/idrac.json',
  // 보안 잔여 11-27 M3: 포탈 계정의 OTP(TOTP) 시드 — 고권한 계정은 OTP 전용이라 시드가 유일한 자격증명이다. 파일 한정 추가 필드
  //   (USER_SECRET_FIELDS)이고 load/save 는 일반 경로(openSecretsDeep/sealSecretsDeep)가 아니라 레코드 단위 봉인(auth/auth.js)이다.
  'users.json',
];

/**
 * 파일 한정 추가 봉인 필드(v2.604 SEC2604-03). 전역 SECRET_FIELDS 에 넣으면 다른 파일의 같은 이름(접속 주소 `url`)까지
 * 봉인되어 버리는 이름을 **그 파일에서만** 봉인한다. 해당 파일의 load/save 는 이 집합을 openSecretsDeep/sealSecretsDeep 에
 * 넘기고, 모드 전환 마이그레이션도 같은 집합을 쓴다(한쪽만 하면 반쪽 상태 — 위 메모 규약).
 */
/** 보안 잔여 11-27 M3: users.json 의 OTP 시드 칸 — 전역 SECRET_FIELDS 에 넣지 않는다(다른 파일의 같은 이름 · 일반 경로의 키 없음 저장 거절 · 복호 실패 '' 소거). */
export const USER_SECRET_FIELDS = new Set(['totpSecret', 'totpPendingSecret']);
export const FILE_EXTRA_SECRET_FIELDS = Object.freeze({ 'alerts.json': new Set(['url']), 'bm-events.json': new Set(['secret', 'ctxKey', 'prevCtxKey']), 'users.json': USER_SECRET_FIELDS });

/* ── 정책(모드·레벨·알고리즘) ─────────────────────────────────────────────── */

// 레벨 → 기본 알고리즘 + scrypt 비용(logN). 레벨이 높을수록 키 유도(KDF)가 느려져 키 파일
// 없이 암호문만 유출된 경우의 무차별 대입 비용이 커진다. 알고리즘을 명시하면 그 알고리즘을
// 쓰되 KDF 강도는 레벨을 따른다.
const LEVELS = {
  1: { alg: 'aes-128-gcm', logN: 14 },   // 빠름 — 대량 항목/저사양
  2: { alg: 'aes-256-gcm', logN: 15 },   // 기본 권장
  3: { alg: 'aes-256-gcm', logN: 16 },   // 최고 강도(KDF 2^16)
};
const ALGOS = { 'aes-128-gcm': 16, 'aes-192-gcm': 24, 'aes-256-gcm': 32, 'chacha20-poly1305': 32 }; // alg → key bytes
const MODES = ['plain', 'encrypted'];

function normPolicy(p = {}) {
  return {
    mode: MODES.includes(p.mode) ? p.mode : 'plain',                      // 기본 평문(하위호환 — 기존 동작 유지)
    level: [1, 2, 3].includes(Number(p.level)) ? Number(p.level) : 2,
    algorithm: Object.prototype.hasOwnProperty.call(ALGOS, p.algorithm) ? p.algorithm : '', // ''=레벨 기본
  };
}

/*
 * S-07(2026-10-09 검토 보고서 — 재현): v2.322 의 '손상 시 직전 유효 정책 유지' 는 첫 load 한 번만 지켜졌다. preserveCorrupt 가
 * 손상 원본을 옆으로 치우므로 **둘째 load 는 '파일 없음' 이 되어 plain** 이었고, 재시작하면 직전 정책도 없어 처음부터 plain 이었다.
 * `{}`·알 수 없는 mode 도 normPolicy 가 plain 으로 정규화했다. 그 뒤의 저장은 새 비밀을 **평문으로** 썼고, 이미 봉인돼 있던 값도
 * 메모리의 평문 그대로 다시 써서 풀었다. 이제:
 *  - 정책 파일은 **mode 가 있고 알려진 값일 때만** 유효하다(validatePolicy). 아니면 손상과 같이 원본을 보존(preserveCorrupt)한다.
 *  - 못 읽으면 ① 직전 유효 정책(이 프로세스) → ② 신뢰 사본(secrets-policy.trusted.json) 순으로 복구한다(`recovered`).
 *  - 둘 다 없을 때 '정책 파일 없음' 이고 **암호화를 쓴 흔적이 없으면** 신규 설치다 — 예전처럼 plain(모양도 같다).
 *  - 흔적(키 파일 · 봉인된 값 · 정책 손상 보존본)이 있으면 **잠금**(`locked`): 새 비밀은 저장하지 않고(throw), 이미 봉인돼
 *    있던 값은 그 암호문 그대로 다시 쓴다. 평문 전환은 PUT /admin/secrets/policy(소유자 + OTP + 감사)로만 한다.
 *  - 정책 파일을 자동으로 다시 쓰지 않는다 — 복구는 명시적으로(설정 화면 저장 또는 손상본을 되돌리기). 키는 건드리지 않는다.
 */
function validatePolicy(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (!MODES.includes(p.mode)) return null;
  if (p.level !== undefined && ![1, 2, 3].includes(Number(p.level))) return null;
  if (p.algorithm !== undefined && p.algorithm !== '' && !Object.prototype.hasOwnProperty.call(ALGOS, p.algorithm)) return null;
  return normPolicy(p);
}
/** 정책 파일 한 개 읽기 → { state: ok|missing|unreadable|corrupt|invalid, policy?, error? } */
function readPolicyFile(fp) {
  let raw;
  // 134회차: `fs.existsSync` 가드는 stat 실패(폴더 수준 EACCES · EIO · ESTALE)를 'missing' 으로 읽었다 — 정책 · 신뢰 사본 · 흔적이 전부 '없음' 이 되어
  //   첫 로드가 신규 설치(plain)로 떨어졌다(암호화 설치에서 새 비밀이 평문으로 저장되는 창). 곧바로 읽어 ENOENT 만 없음이고 그 밖은 unreadable(잠금 쪽)이다.
  try { raw = fs.readFileSync(fp, 'utf8'); }
  catch (e) { return e?.code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable', error: e.message }; }   // 권한·입출력 — 손상이 아니므로 옆으로 치우지 않는다
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return { state: 'corrupt', error: e.message }; }
  const pol = validatePolicy(parsed);
  return pol ? { state: 'ok', policy: pol } : { state: 'invalid', error: 'mode 가 없거나 알 수 없는 값(plain|encrypted 아님)' };
}

// 암호화를 쓴 흔적 — 정책도 신뢰 사본도 없을 때 '신규 설치' 와 '정책 유실' 을 가른다. 키를 만들지 않는다(존재만 본다).
// 정상 경로(정책 파일 있음)에서는 부르지 않는다. 정책 파일이 없는 평문 설치는 저장 때마다(3초 캐시) 여기에 오므로 30초 기억한다.
let _evidence = null, _evidenceAt = 0;
const EVIDENCE_TTL_MS = 30_000;
function encryptionEvidence() {
  const now = Date.now();
  if (_evidence && now - _evidenceAt < EVIDENCE_TTL_MS) return _evidence;
  const ev = [];
  if (!fileMissing(keyFile())) ev.push('key-file');   // 134회차: 확인하지 못한 것(stat 실패)은 없음이 아니다 — 흔적으로 센다(잠금 쪽)
  try { if (fs.readdirSync(config.configDir).some((n) => n.startsWith('secrets-policy.json.corrupt.'))) ev.push('corrupt-policy-copy'); } catch { /* */ }
  for (const name of SECRET_FILES) {
    try {
      const fp = path.join(config.configDir, name);
      // 22회차 반증 D-9: 원문에 'enc$1$' 글자가 있는지만 보면 평문 설치의 이름 등에 그 글자가 있을 때 '봉인 흔적' 이 됐다 — JSON 문자열 값의 시작 + 알고리즘 · 레벨 모양까지.
      if (fs.existsSync(fp) && SEALED_VALUE_RE.test(fs.readFileSync(fp, 'utf8'))) { ev.push('sealed-values'); break; }
    } catch { /* 읽지 못한 파일은 건너뛴다 */ }
  }
  _evidence = ev; _evidenceAt = now;
  return ev;
}

// 신뢰 사본 맞추기 — 정상 정책을 읽거나 저장할 때. 같은 내용이면 쓰지 않는다(mtime·백업 감시 배려).
let _trustedSig = null;
function syncTrustedCopy(pol) {
  const body = JSON.stringify(pol, null, 2);
  try {
    if (_trustedSig === body && fs.existsSync(trustedPolicyFile())) return;
    const cur = fs.existsSync(trustedPolicyFile()) ? fs.readFileSync(trustedPolicyFile(), 'utf8') : null;
    if (cur !== body) atomicWriteFileSync(trustedPolicyFile(), body, { mode: 0o600 });
    _trustedSig = body;
  } catch (e) { warnPolicyOnce(`trusted-write|${e.message}`, `[secrets] ⚠ 정책 신뢰 사본(${path.basename(trustedPolicyFile())})을 쓰지 못했습니다(${e.message}) — 정책 파일이 손상되면 재시작 뒤 복구할 사본이 없습니다. CONFIG_DIR 권한을 확인하세요.`); }
}

let _policyWarnKey = null;
function warnPolicyOnce(key, msg) { if (_policyWarnKey === key) return; _policyWarnKey = key; console.error(msg); }

const PROBLEM_TEXT = { missing: '없음', unreadable: '읽기 실패', corrupt: '손상(JSON 아님)', invalid: '내용 오류' };

// 마지막으로 성공 로드한 정책(v2.322 보안 감사 — S-07 에 '두 번째 load·재시작' 까지 넓혔다).
let _lastGoodPolicy = null;
let _lastGoodFrom = null;   // 'policy-file' | 'trusted-copy' — 복구 문구가 출처를 바르게 말하게(사본에서 온 값을 '직전 정책' 이라 하지 않는다)
export function loadSecretsPolicy() {
  const r = readPolicyFile(policyFile());
  if (r.state === 'ok') {
    _lastGoodPolicy = r.policy; _lastGoodFrom = 'policy-file';
    if (_policyWarnKey && !_policyWarnKey.startsWith('trusted-write|')) _policyWarnKey = null;
    syncTrustedCopy(r.policy);
    return { ...r.policy };
  }
  // 손상·내용 오류는 원본을 지우지 않고 옆으로 치운다(.corrupt.<ts> — 운영자가 되돌릴 수 있게).
  if (r.state === 'corrupt' || r.state === 'invalid') { preserveCorrupt(policyFile(), r.error); _evidence = null; }
  const problem = r.state;
  if (_lastGoodPolicy) {
    warnPolicyOnce(`last-good|${problem}`, `[secrets] ⚠ 정책 파일 ${PROBLEM_TEXT[problem]} — 평문으로 내려가지 않도록 직전 유효 정책(${_lastGoodPolicy.mode})을 유지합니다. 설정 › 자격증명 저장 방식에서 다시 저장하거나 정책 파일을 복구하세요.`);
    return { ..._lastGoodPolicy, recovered: _lastGoodFrom === 'trusted-copy' ? 'trusted-copy' : 'last-good', problem };
  }
  const t = readPolicyFile(trustedPolicyFile());
  if (t.state === 'ok') {
    _lastGoodPolicy = t.policy; _lastGoodFrom = 'trusted-copy';
    warnPolicyOnce(`trusted|${problem}`, `[secrets] ⚠ 정책 파일 ${PROBLEM_TEXT[problem]} — 신뢰 사본(${path.basename(trustedPolicyFile())})의 정책(${t.policy.mode})으로 계속합니다. 설정 › 자격증명 저장 방식에서 다시 저장해 정책 파일을 복구하세요.`);
    return { ...t.policy, recovered: 'trusted-copy', problem };
  }
  const evidence = encryptionEvidence();
  if (problem === 'missing' && !evidence.length) return normPolicy();   // 신규 설치(또는 정책을 저장한 적 없는 평문 설치) — 예전과 같다
  warnPolicyOnce(`locked|${problem}|${evidence.join(',')}`, `[secrets] ⛔ 정책 파일 ${PROBLEM_TEXT[problem]} · 신뢰 사본 없음 · 암호화 흔적(${evidence.join(', ') || '정책 파일 손상'}) — 평문으로 저장하지 않도록 새 비밀 저장을 막습니다(기존 암호문은 그대로 유지). 설정 › 자격증명 저장 방식에서 방식을 다시 선택하거나 손상 보존본(secrets-policy.json.corrupt.*)을 되돌리세요.`);
  return { mode: 'unavailable', level: 2, algorithm: '', locked: true, problem, evidence };
}

/** 정책을 읽지 못해 새 비밀을 봉인할 수 없을 때(S-07) — 평문으로 저장하는 대신 던진다. */
export class SecretsPolicyUnavailableError extends Error {
  constructor(pol) {
    super(`자격증명 저장 방식(secrets-policy.json)을 읽지 못해(${PROBLEM_TEXT[pol?.problem] || '알 수 없음'}) 새 비밀을 저장하지 않았습니다 — 평문으로 저장하지 않기 위해서입니다. 설정 › 자격증명 저장 방식에서 방식을 다시 선택하세요.`);
    this.code = 'SECRETS_POLICY_UNAVAILABLE';
  }
}

// 핫패스 캐시(3초) — 모든 save 경로가 정책을 읽으므로 파일 IO 를 매 저장마다 하지 않는다.
let _polAt = 0, _polCache = null;
function policy() {
  const now = Date.now();
  if (_polAt && now - _polAt < 3000) return _polCache;
  _polCache = loadSecretsPolicy(); _polAt = now;
  return _polCache;
}
/** 테스트용 — 3초 정책 캐시를 비운다(다음 저장이 정책 파일을 다시 읽는다). */
export function _resetSecretsPolicyCache() { _polAt = 0; }

export function saveSecretsPolicy(partial = {}) {
  const cur = loadSecretsPolicy();
  // S-07: 값이 undefined 인 키는 '바꾸지 않음' 이다 — 예전에는 `{...cur, mode: undefined}` 가 plain 으로 정규화돼
  // 레벨만 바꾸는 저장이 평문 전환(+ 전 파일 평문 재기록)이 됐다. 알 수 없는 mode 도 plain 으로 바꾸지 않고 거부한다.
  const want = {};
  for (const k of ['mode', 'level', 'algorithm']) if (partial?.[k] !== undefined) want[k] = partial[k];
  if (want.mode !== undefined && !MODES.includes(want.mode)) throw new Error(`알 수 없는 저장 방식(mode): ${String(want.mode).slice(0, 40)} — plain 또는 encrypted 를 고르세요.`);
  if (cur.locked && want.mode === undefined) throw new Error('현재 저장 방식을 읽지 못했습니다 — 평문/암호화 중 하나를 명시해 저장하세요.');
  const base = cur.locked ? {} : { mode: cur.mode, level: cur.level, algorithm: cur.algorithm };
  const next = normPolicy({ ...base, ...want });
  // 암호화를 켜면 키를 미리 준비한다(있으면 그대로 — 새로 만들지 않는다). 첫 봉인 전에 정책을 잃어도 키 파일이 '암호화를 쓴 흔적' 이 되게.
  if (next.mode === 'encrypted') masterKey();
  atomicWriteFileSync(policyFile(), JSON.stringify(next, null, 2), { mode: 0o600 });
  _lastGoodPolicy = next; _lastGoodFrom = 'policy-file'; _evidence = null; _policyWarnKey = null;
  syncTrustedCopy(next);
  _polAt = 0; // 캐시 즉시 무효화 — 이후 save 부터 새 정책으로 봉인
  if (next.mode === 'encrypted') scheduleKeyCheck();   // 보안 잔여 11-27 M3: 콘솔 도구가 같은 키인지 확인할 값(아래 '키 확인 값')
  return { ...next };
}

/* ── 마스터 키 ────────────────────────────────────────────────────────────── */

let _key = null;
/*
 * 전체 점검 21회차 M-1(재현): 키(SECRETS_KEY env · secrets-key 파일)가 없을 때 **복호(읽기) 중에** 새 무작위 키를 만들어 저장했다 —
 *   재시작 때 env 가 빠지면 새 키 파일이 생기고 모든 비밀이 '' 로 열린 뒤, 관리자가 아무 항목이나 저장하면 전 항목 암호문이 '' 로 기록됐다
 *   (env 를 되돌려도 복구 불가). 이제 **봉인된 값이 이미 있으면 키를 만들지 않는다**(SECRETS_KEY_MISSING — 복호는 실패, 봉인은 거절).
 *   키 파일이 있는데 읽지 못하면(EACCES) 임시 메모리 키로 넘어가지 않고 같은 거절이다(예전 콘솔 문구 '쓰기 실패' 도 틀렸다).
 *   키를 쓸 수 없는 동안은 비밀 파일 저장을 거절한다(sealSecretsDeep — 22회차 반증으로 '복호 실패 암호문 되돌리기' 를 대체).
 */
const _keyWarned = new Set();
let _keyMissing = null;   // 22회차 반증: 키를 쓸 수 없다고 판정했으면 그 오류(다시 판정하지 않는다 — 복호 실패마다 흔적을 다시 읽던 비용 · 저장 거절 표지)
/** 키를 쓸 수 없어 비밀 파일 저장을 막고 있으면 그 사유, 아니면 null(자가진단 · 화면용). */
export function secretsKeyMissing() { return _keyMissing ? _keyMissing.message : null; }
function keyUnavailable(why) {
  const e = new Error(`자격증명 암호화 키를 쓸 수 없습니다(${why}) — 새 키를 만들지 않습니다(기존 암호문 보호). SECRETS_KEY env 또는 CONFIG_DIR/secrets-key 를 되돌리고 재시작하세요.`);
  e.code = 'SECRETS_KEY_MISSING';
  if (!_keyWarned.has(why)) { _keyWarned.add(why); console.error(`[secrets] ⚠ ${e.message}`); }
  _keyMissing = e;
  return e;
}
function masterKey() {
  if (_key) return _key;
  if (_keyMissing) throw _keyMissing;
  const env = process.env.SECRETS_KEY;
  if (env && env.length >= 16) { _key = Buffer.from(env, 'utf8'); scheduleKeyCheck(); return _key; }
  // 134회차(재현): 키 파일 유무를 `fs.existsSync` 로 갈랐다 — stat 이 실패하는 폴더 수준 읽기 오류(EACCES · EIO · ESTALE)가 '키 없음' 으로 읽히고, 같은 오류로
  //   비밀 파일의 봉인 흔적도 보이지 않아 **새 키를 만들었다**: 쓰기가 되면(일시 오류) 기존 키 파일을 덮어 모든 암호문이 복호 불가가 되고, 안 되면 임시 메모리 키로 돌았다.
  //   곧바로 읽어 ENOENT 만 '키 없음' 이다 — 그 밖은 아래 '읽지 못함'(새 키를 만들지 않는다 · 21회차 M-1 과 같은 거절).
  let exists = false;
  let cur = '';
  try { cur = fs.readFileSync(keyFile(), 'utf8').trim(); exists = true; }
  catch (e) { if (e?.code !== 'ENOENT') throw keyUnavailable(`키 파일을 읽지 못함 ${String(e?.code || '')}`.trim()); }
  if (exists && cur.length >= 32) { _key = Buffer.from(cur, 'utf8'); scheduleKeyCheck(); return _key; }
  // 보안 잔여 11-27 M3: 콘솔 도구(otp-enroll · user-admin)는 키를 만들지 않는다 — 도구와 포탈이 각자 키를 만들거나(원자적 쓰기 둘), env 키(portal.env)를
  //   못 받은 도구가 파일 키를 새로 만들어 그 키로 시드를 봉인하면 재시작 뒤 포탈이 그 시드를 열지 못해 그 관리자가 잠긴다. 키는 포탈이 준비한다.
  if (_noKeyCreation) throw keyUnavailable('콘솔 도구는 암호화 키를 만들지 않습니다 — 키는 포탈이 준비합니다');
  _evidence = null;   // 흔적을 지금 다시 본다(30초 기억을 쓰지 않는다)
  if (encryptionEvidence().includes('sealed-values')) {
    // 22회차 반증 D-2: 키를 정말 잃은 설치의 탈출 — 운영자가 명시적으로 SECRETS_KEY_LOST=true 로 재시작하면 새 키를 만든다(옛 암호문은 복호 실패 · 저장 때 지워진다).
    if (process.env.SECRETS_KEY_LOST !== 'true') throw keyUnavailable(exists ? '키 파일이 짧거나 비었는데 봉인된 비밀이 있음' : '봉인된 비밀이 있는데 키가 없음');
    console.error('[secrets] ⚠ SECRETS_KEY_LOST=true — 키 분실을 확정해 새 키를 만듭니다. 옛 키로 봉인한 비밀은 복호되지 않고, 저장할 때 지워집니다. 모든 장비 비밀번호를 다시 입력하세요(끝나면 이 env 를 지울 것).');
  }
  try {
    const gen = crypto.randomBytes(32).toString('base64url');
    atomicWriteFileSync(keyFile(), gen, { mode: 0o600 });
    console.log(`[secrets] 암호화 키가 없어 ${keyFile()} 에 생성·영속했습니다(0600). 멀티노드/외부 비밀관리가 필요하면 SECRETS_KEY env 를 설정하세요.`);
    _key = Buffer.from(gen, 'utf8');
    scheduleKeyCheck();
  } catch (e) {
    // 키 파일 쓰기 실패 — 프로세스 메모리 키로 폴백(재시작 시 기존 암호문 복호 불가).
    // 이 상태로 '암호화' 모드를 켜면 위험하므로 경고를 명확히 남긴다.
    console.warn(`[secrets] ⚠ 키 파일 쓰기 실패(${e.message}) — 임시 메모리 키 사용. 이 상태로 암호화 저장 시 재시작 후 복호가 불가능합니다. CONFIG_DIR 권한 또는 SECRETS_KEY env 를 확인하세요.`);
    _key = crypto.randomBytes(32);
  }
  return _key;
}

/* ── 봉인/복호(단일 값) ───────────────────────────────────────────────────── */

const PREFIX = 'enc$1$';
const SEALED_VALUE_RE = /"enc\$1\$[a-z0-9-]{3,40}\$\d{1,2}\$/;   // 22회차 반증 D-9: JSON 문자열 값으로 들어 있는 봉인(알고리즘 · 레벨 모양까지)
export const isSealed = (v) => typeof v === 'string' && v.startsWith(PREFIX);

// scrypt 파생키 캐시 — 캐시 키는 (alg|logN|salt). 복호는 salt 마다 1회 유도하고 여기 둔다.
// v2.598(감사 L2598-01): 예전에는 2,000개를 넘으면 **통째로 비웠다**(clear) — 그 순간 이 프로세스가 연 값 전부가
// 다시 scrypt 대상이 됐다. 이제 LRU 다(조회 성공도 뒤로 보내고, 넘치면 오래된 1/4 만 버린다).
const kdfCache = new Map();
const KDF_CACHE_MAX = 2000;
const sessionKeyByCk = new Map();  // ck → 세션 키(아래 sessionKey) — 복호·openSecretIfCached 가 kdfCache LRU 와 무관하게 찾는다
let _scryptCalls = 0;               // 테스트용 계측(_vaultStats)
function kdfGet(ck) {
  const k = kdfCache.get(ck);
  if (k) { kdfCache.delete(ck); kdfCache.set(ck, k); }
  return k || sessionKeyByCk.get(ck) || null;
}
function kdfPut(ck, k) {
  kdfCache.set(ck, k);
  if (kdfCache.size > KDF_CACHE_MAX) {
    let drop = Math.ceil(KDF_CACHE_MAX / 4);
    for (const key of kdfCache.keys()) { if (drop-- <= 0) break; kdfCache.delete(key); }
  }
}
const ckOf = (alg, logN, saltB64u) => `${alg}|${Number(logN)}|${saltB64u}`;
function deriveKey(alg, logN, salt) {
  const ck = ckOf(alg, logN, salt.toString('base64url'));
  let k = kdfGet(ck);
  if (!k) {
    k = crypto.scryptSync(masterKey(), salt, ALGOS[alg], { N: 2 ** logN, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }); _scryptCalls += 1;
    kdfPut(ck, k);
  }
  return k;
}

/*
 * v2.598(감사 L2598-01 — 재현: 40대 등록부에서 1대를 고쳐 저장하면 3.8~4.1초 이벤트 루프 정지):
 * 예전에는 봉인마다 새 salt 를 뽑아 **값마다 scryptSync(N=2^15, 약 100ms)** 를 메인 스레드에서 돌렸고, save 는 파일의
 * 전 비밀을 다시 봉인하므로 한 대 수정이 N×0.1초가 됐다. 두 가지로 고쳤다 — 봉인 형식(자기서술 enc$1$…)은 그대로다.
 *
 * ① **세션 키**: 새로 봉인하는 값은 (alg,logN) 마다 이 프로세스에서 한 번 뽑은 salt·키를 쓰고 **값마다 IV 만 새로** 뽑는다.
 *    GCM/ChaCha20-Poly1305 는 무작위 96-bit IV 로 같은 키에 2^32 회까지 안전하다(여기서는 2^20 회에서 교체한다).
 *    salt 를 값마다 두던 이득은 '키 파일 없이 암호문만 유출됐을 때의 대입 비용' 인데, 전 값이 같은 마스터 키에서
 *    나오므로 하나를 깨면 전부 깨진다 — 값마다 다른 salt 는 대입 비용을 늘리지 않는다. 기존 암호문은 각자의 salt 로 그대로 열린다.
 * ② **평문이 같은 값은 기존 암호문을 재사용**한다(`sealSecretsDeep`). 로드(openSecretsDeep)와 봉인이 '문맥 + 평문' 의 HMAC →
 *    암호문을 기억해 두고, 다음 저장에서 같은 문맥·같은 평문이면 그 암호문을 그대로 쓴다. 그래서 설정을 안 바꾼 저장은 파일의
 *    봉인 값이 **글자 그대로 같다** — 백업 지문(backup/service.js)이 봉인을 열지 않고 원문으로 비교할 수 있다(RECENT2598-01).
 *    ⚠ 문맥(필드 이름 + 그 객체의 식별 필드)을 키에 넣는다 — 평문만으로 재사용하면 **서로 다른 장비의 같은 비밀번호가 같은
 *    암호문**이 되어 파일에서 '비밀번호가 같다' 는 사실이 드러난다(무작위 봉인이 지키던 성질). 평문은 저장하지 않는다(HMAC 만).
 */
const SESSION_ROTATE = 2 ** 20;
const sessionKeys = new Map();     // `${alg}|${logN}` → { salt, key, ck, n }
function sessionKey(alg, logN) {
  const sk = `${alg}|${logN}`;
  let s = sessionKeys.get(sk);
  if (!s || s.n >= SESSION_ROTATE) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(masterKey(), salt, ALGOS[alg], { N: 2 ** logN, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }); _scryptCalls += 1;
    const ck = ckOf(alg, logN, salt.toString('base64url'));
    // 교체된 세션 키도 지우지 않는다 — 그 키로 봉인한 값이 이 프로세스 안에서 아직 열려야 한다(교체는 2^20 회마다라 몇 개뿐).
    s = { salt, key, ck, n: 0 };
    sessionKeys.set(sk, s); sessionKeyByCk.set(ck, key);
  }
  s.n += 1;
  return s;
}

/* 재사용 기억: HMAC(문맥 + 평문) → 암호문. 상한을 둔 LRU. */
const REUSE_MAX = 20000;
const reuse = new Map();
let _hmacKey = null;
function reuseKey(ctx, plain) {
  if (!_hmacKey) _hmacKey = crypto.createHash('sha256').update('secretVault-reuse\0').update(masterKey()).digest();
  return crypto.createHmac('sha256', _hmacKey).update(ctx).update('\0').update(plain, 'utf8').digest('base64url');
}
function reusePut(rk, sealed) {
  reuse.delete(rk); reuse.set(rk, sealed);
  if (reuse.size > REUSE_MAX) { let drop = Math.ceil(REUSE_MAX / 4); for (const k of reuse.keys()) { if (drop-- <= 0) break; reuse.delete(k); } }
}
// 식별 필드 — 같은 등록부를 로드할 때와 저장할 때 모양(배열/래퍼 객체)이 달라도 문맥이 같게, **그 비밀을 담은 객체의
// 식별자**를 문맥에 넣는다. 식별자가 바뀌면(이름 변경) 새로 봉인할 뿐이다(백업이 한 번 더 생기는 쪽 — 안전).
const ID_FIELDS = ['id', 'name', 'host', 'agent', 'agentName', 'url', 'username', 'user'];
function ctxOf(parent, k) {
  const ids = [];
  if (parent && typeof parent === 'object' && !Array.isArray(parent)) for (const f of ID_FIELDS) { const x = parent[f]; if (typeof x === 'string' || typeof x === 'number') ids.push(`${f}=${x}`); }
  return `${k}\0${ids.join('\0')}`;
}
/*
 * v2.599(감사 RECENT2599-02 = LO2599-02 = SEC2599-01 — 재현): 위 식별 필드만으로는 **맵 키·배열 위치로만 구분되는 대상**
 *   (gpu-guest.json 의 vcenters[vcId]·vms[vmId], central-agent-gpu-guest.json 의 byAgent[agent], id 없는 배열 원소)이
 *   같은 문맥이 됐다 — username 이 같으면 서로 다른 vCenter·VM 의 같은 비밀번호가 **같은 암호문**으로 저장되어, 파일을 읽는
 *   사람에게 '비밀번호가 같다' 는 사실이 드러났다(무작위 봉인이 지키던 성질, 위 ② 주석이 막겠다고 한 바로 그것).
 *   이제 **경로**(객체 키 · 배열 원소의 강한 식별자 `STRONG_IDS` 또는 위치)를 문맥에 넣는다.
 *   ⚠ 로드는 파일의 **일부**(예: `parsed.vcenters`)를 열고 저장은 래퍼(`{vcenters: list}`)를 봉인하는 스토어가 대부분이라
 *     경로가 한 단계 어긋난다 — 저장 쪽은 전체 경로 → 첫 조각을 뗀 경로 순으로 찾는다(`pathCtxs`). 래퍼 깊이는 전 호출부가 1이다.
 *     못 찾으면 새로 봉인할 뿐이다(안전한 쪽).
 *   ⚠ 그리고 **한 번의 봉인(sealSecretsDeep) 안에서 같은 암호문을 두 번 내지 않는다** — 경로 문맥이 어떤 이유로 겹쳐도
 *     한 파일 안에서 같은 암호문은 생기지 않는다(마지막 방어선).
 */
const STRONG_IDS = ['id', 'name', 'host', 'agent', 'agentName', 'url'];   // username 은 대상 식별자가 아니다(여러 장비가 root)
function elemSeg(v, i) {
  const ids = [];
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const f of STRONG_IDS) { const x = v[f]; if (typeof x === 'string' || typeof x === 'number') ids.push(`${f}=${x}`); }
  return ids.length ? `@${ids.join(',')}` : `#${i}`;
}
const keySeg = (k) => `.${k}`;
/** 경로 조각 + 필드 문맥 → 재사용 문맥 후보(전체 경로 먼저, 다음은 래퍼 한 단계를 뗀 경로). */
function pathCtxs(segs, parent, k) {
  const tail = ctxOf(parent, k);
  const out = [`${segs.join('\u0001')}\u0002${tail}`];
  if (segs.length) out.push(`${segs.slice(1).join('\u0001')}\u0002${tail}`);
  return out;
}
// 봉인 문자열의 (alg, logN) — 재사용은 현재 정책과 같을 때만(레벨·알고리즘을 바꾸면 새 정책으로 다시 봉인해야 한다).
function sealedParams(v) { const [alg, logN] = v.slice(PREFIX.length).split('$'); return { alg, logN: Number(logN) }; }
function policyParams(pol) { const lv = LEVELS[pol.level] || LEVELS[2]; return { alg: pol.algorithm || lv.alg, logN: lv.logN }; }

/** 테스트·진단용 — scrypt 호출 수와 캐시 크기. */
export function _vaultStats() { return { scryptCalls: _scryptCalls, kdfCache: kdfCache.size, reuse: reuse.size, sessionKeys: sessionKeys.size }; }

/** 평문 → 암호문(현재 정책). mode=plain 이면 평문 그대로, 이미 봉인된 값은 그대로(이중 봉인 방지). */
export function sealSecret(plain, pol = policy()) {
  if (typeof plain !== 'string' || plain === '' || isSealed(plain)) return plain;
  if (pol?.mode === 'plain') return plain;
  if (pol?.mode !== 'encrypted') throw new SecretsPolicyUnavailableError(pol);   // S-07: 정책을 모르면 평문으로 내보내지 않는다
  const lv = LEVELS[pol.level] || LEVELS[2];
  const alg = pol.algorithm || lv.alg;
  const { salt, key } = sessionKey(alg, lv.logN);           // v2.598 L2598-01: 프로세스당 1회 유도 — 값마다 scrypt 하지 않는다
  const iv = crypto.randomBytes(12);                       // GCM/ChaCha20-Poly1305 표준 96-bit nonce(값마다 새로)
  const cipher = crypto.createCipheriv(alg, key, iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b = (x) => x.toString('base64url');
  return `${PREFIX}${alg}$${lv.logN}$${b(salt)}$${b(iv)}$${b(tag)}$${b(ct)}`;
}

const warned = new Set(); // 같은 사유 경고 1회(폴링 루프 로그 폭주 방지)
/** 암호문 → 평문. 봉인 포맷이 아니면 그대로 반환(평문 혼재 허용). 복호 실패는 ''(throw 금지). */
let _decryptFailures = 0;
/** 복호 실패 누적 횟수(v2.480) — 정책 전환 시 '이 파일에서 실패가 났는가' 판정용. */
export function decryptFailureCount() { return _decryptFailures; }
export function openSecret(v) {
  if (!isSealed(v)) return v;
  try {
    const [alg, logN, salt, iv, tag, ct] = v.slice(PREFIX.length).split('$');
    if (!Object.prototype.hasOwnProperty.call(ALGOS, alg)) throw new Error(`unknown alg ${alg}`);
    const key = deriveKey(alg, Number(logN), Buffer.from(salt, 'base64url'));
    const d = crypto.createDecipheriv(alg, key, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch (e) {
    const k = String(e.message).slice(0, 60);
    if (!warned.has(k)) { warned.add(k); console.warn(`[secrets] ⚠ 자격증명 복호 실패(${k}) — 빈 값으로 대체. 키(secrets-key/SECRETS_KEY) 변경·유실 여부를 확인하세요(되돌리고 재시작 · 정말 잃었으면 SECRETS_KEY_LOST=true 로 재시작 후 재입력).`); }
    // 빈 값 반환은 유지한다(봉인문을 비밀번호로 쓰면 매 폴링마다 잘못된 비밀번호로 로그인해 서비스 계정 잠금 위험). 대신
    // v2.480(3차 감사 코어2 S2): 실패 횟수를 세어 migrateSecretFiles 가 복호 실패 파일의 재기록(암호문 소거)을 건너뛴다.
    _decryptFailures += 1;
    return '';
  }
}

/**
 * v2.597(감사 RECENT-01 — 재현): 파생키가 **이미 캐시에 있을 때만** 연다. 없으면 `null`(scrypt 를 돌리지 않는다).
 * 백업 지문은 매 백업마다 모든 설정 파일을 훑는데, 캐시에 없는 봉인 값마다 scryptSync(N=2^15, 약 100ms)를 메인
 * 스레드에서 돌려 값 100개에 10~22초 이벤트 루프가 멈췄다. 경고도 남기지 않는다(지문용 — 복호 실패가 아니다).
 * v2.599(감사 RECENT2599-04): v2.598 에 백업 지문이 봉인 원문을 그대로 쓰게 되어(암호문 재사용) **제품 코드 호출부는 0 이다.**
 *   지우지 않고 남긴다 — 폴링·백업 같은 뜨거운 경로에서 봉인 값을 열어야 할 때 **scrypt 없이 여는 유일한 안전한 길**이고,
 *   `openSecret` 으로 대신하면 v2.597 RECENT-01(10~22초 정지)이 재발한다. 회귀는 audit2597 이 고정한다.
 */
export function openSecretIfCached(v) {
  if (!isSealed(v)) return v;
  try {
    const [alg, logN, salt, iv, tag, ct] = v.slice(PREFIX.length).split('$');
    if (!Object.prototype.hasOwnProperty.call(ALGOS, alg)) return null;
    const key = kdfGet(ckOf(alg, logN, Buffer.from(salt, 'base64url').toString('base64url')));
    if (!key) return null;
    const d = crypto.createDecipheriv(alg, key, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch { return null; }
}

/* ── 봉인/복호(객체 깊은 순회) ────────────────────────────────────────────── */

function walk(obj, fn) {
  if (Array.isArray(obj)) { obj.forEach((v, i) => { const r = fn(null, v); if (r !== undefined) obj[i] = r; else walk(v, fn); }); return obj; }
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const r = fn(k, obj[k]);
      if (r !== undefined) obj[k] = r; else walk(obj[k], fn);
    }
  }
  return obj;
}

/**
 * 로드 경계용 — **비밀 칸(SECRET_FIELDS · extraFields)** 의 봉인 문자열을 복호. in-place.
 * ⚠ 전체 점검 21회차 M-2(재현 — 복호 오라클): 예전에는 키 이름과 무관하게 전부 복호해, 유출된 다른 계정의 암호문을 이름 · 메모 같은 **표시 칸**에
 *   넣어 저장하면 목록 응답이 평문을 보여 줬다. 봉인은 비밀 칸에만 하므로(sealSecretsDeep) 그 밖의 칸 · 배열 원소에 봉인 문자열이 있을 이유가 없다 — 열지 않는다.
 *   (비밀 칸 → 비밀 칸 이식은 문맥을 묶는 새 형식이 필요하다 — 남긴 것, docs/rules/security-api.md 21회차)
 */
export function openSecretsDeep(obj, extraFields = null) {
  const seen = new Set();   // v2.599: 한 파일 안에서 같은 문맥이 두 번 나오면 첫 것만 기억한다(뒤 것이 덮어 엉뚱한 대상에 재사용되지 않게)
  return walkCtx(obj, (k, v, parent, segs) => {
    if (!isSealed(v)) return undefined;
    if (!(k && (SECRET_FIELDS.has(k) || extraFields?.has(k)))) return undefined;   // 21회차 M-2: 비밀 칸만
    const plain = openSecret(v);
    // v2.598 L2598-01: 연 값의 암호문을 기억해 다음 저장에서 재사용한다(평문이 안 바뀐 값은 파일이 글자 그대로 같게).
    if (plain !== '' && k && (SECRET_FIELDS.has(k) || extraFields?.has(k))) {
      const rk = reuseKey(pathCtxs(segs, parent, k)[0], plain);
      if (!seen.has(rk)) { seen.add(rk); reusePut(rk, v); }
    }
    return plain;
  });
}
// walk 와 같되 부모 객체와 경로 조각(v2.599)을 함께 넘긴다(재사용 문맥용).
function walkCtx(obj, fn, segs = []) {
  if (Array.isArray(obj)) { obj.forEach((v, i) => { const r = fn(null, v, obj, segs); if (r !== undefined) obj[i] = r; else walkCtx(v, fn, [...segs, elemSeg(v, i)]); }); return obj; }
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const r = fn(k, obj[k], obj, segs);
      if (r !== undefined) obj[k] = r; else if (obj[k] && typeof obj[k] === 'object') walkCtx(obj[k], fn, [...segs, keySeg(k)]);
    }
  }
  return obj;
}

/**
 * 저장 경계용 — SECRET_FIELDS 이름의 비어있지 않은 문자열 값을 현재 정책대로 봉인.
 * ⚠ 깊은 복제 후 변환(원본 불변): save 는 메모리 상태를 직렬화하므로 in-place 로 봉인하면
 * 실행 중 메모리가 암호문으로 오염돼 다음 vCenter 로그인부터 전부 실패한다.
 */
export function sealSecretsDeep(obj, pol = policy(), extraFields = null) {
  // 21회차 M-1 · 22회차 반증: 키를 쓸 수 없는 동안(봉인된 값이 있는데 키 없음)은 **어느 모드든 비밀 파일을 저장하지 않는다** — 복호에 실패한 칸이
  //   '' 로 열려 있어, 저장하면 그 암호문이 지워진다(재현: 이름만 고친 저장 한 번이 전 vCenter 비밀번호 소거). 예전 안(복호 실패 암호문을 근사 문맥으로
  //   되돌려 쓰기)은 반증에서 엉뚱한 항목에 옛 비밀을 붙였다(위치 문맥 · 파일 이름 없음 · 접속처 변경 · 사람이 지운 칸) — 파일 단위로 닫는다.
  //   해제: 키(SECRETS_KEY · secrets-key)를 되돌리고 재시작. 키를 정말 잃었으면 SECRETS_KEY_LOST=true 로 재시작(새 키 · 옛 암호문은 저장 때 지워진다).
  if (_keyMissing) throw _keyMissing;
  if (pol?.mode === 'plain') return obj;                  // 평문 모드 — 복제 비용도 생략
  if (pol?.mode !== 'encrypted') return sealLocked(obj, pol, extraFields);   // S-07: 정책을 읽지 못함(잠금)
  const clone = structuredClone(obj);
  const want = policyParams(pol);
  const emitted = new Set();   // v2.599: 이 봉인에서 이미 낸 암호문 — 한 파일 안에서 같은 암호문을 두 번 내지 않는다
  return walkCtx(clone, (k, v, parent, segs) => {
    if (!(k && (SECRET_FIELDS.has(k) || extraFields?.has(k)) && typeof v === 'string' && v !== '')) return undefined;
    if (isSealed(v)) { emitted.add(v); return v; }        // 이미 봉인(이중 봉인 방지 — 예전과 같다)
    // v2.598 L2598-01: 같은 문맥·같은 평문을 이미 봉인했거나 읽은 적이 있고 현재 정책과 같으면 그 암호문을 그대로 쓴다.
    // v2.599: 문맥은 경로를 포함한다 — 전체 경로 먼저, 없으면 래퍼 한 단계를 뗀 경로(로드가 파일의 일부를 연 경우).
    const [full, ...alts] = pathCtxs(segs, parent, k);
    const rk = reuseKey(full, v);
    for (const ctx of [full, ...alts]) {
      const prev = reuse.get(ctx === full ? rk : reuseKey(ctx, v));
      if (!prev || emitted.has(prev)) continue;
      const p = sealedParams(prev);
      if (p.alg === want.alg && p.logN === want.logN) { reusePut(rk, prev); emitted.add(prev); return prev; }
    }
    const sealed = sealSecret(v, pol);
    if (isSealed(sealed)) { reusePut(rk, sealed); emitted.add(sealed); }
    return sealed;
  });
}

// 키가 이미 있는가(만들지 않는다) — 잠금 상태에서 재사용 기억을 볼 때 masterKey() 가 새 키를 만들지 않게 먼저 본다.
function keyPresent() {
  if (_key) return true;
  const env = process.env.SECRETS_KEY;
  if (env && env.length >= 16) return true;
  try { return fs.existsSync(keyFile()); } catch { return false; }
}

/**
 * 잠금(S-07) — 정책을 읽지 못한 상태의 저장. 새 봉인은 하지 않는다(어느 레벨·알고리즘이었는지 모른다). 이미 봉인된 값과
 * 이 프로세스가 읽어 둔 암호문(재사용 기억 — 레벨·알고리즘 무관, 원래 암호문 그대로)은 다시 쓰고, 그 밖의 비어 있지 않은
 * 비밀이 하나라도 있으면 던진다 — 평문으로도 새 정책으로도 쓰지 않는다. 그래서 비밀을 바꾸지 않은 수정은 계속 저장된다.
 * ⚠ 재사용 문맥에 식별 필드(name 등)가 들어가므로 이름을 바꾸는 수정은 잠금 동안 거부된다(새로 봉인해야 하는 값이 된다).
 */
function sealLocked(obj, pol, extraFields) {
  const clone = structuredClone(obj);
  const canReuse = keyPresent();
  const emitted = new Set();
  return walkCtx(clone, (k, v, parent, segs) => {
    if (!(k && (SECRET_FIELDS.has(k) || extraFields?.has(k)) && typeof v === 'string' && v !== '')) return undefined;
    if (isSealed(v)) { emitted.add(v); return v; }
    if (canReuse) {
      for (const ctx of pathCtxs(segs, parent, k)) {
        const prev = reuse.get(reuseKey(ctx, v));
        if (prev && !emitted.has(prev)) { emitted.add(prev); return prev; }
      }
    }
    throw new SecretsPolicyUnavailableError(pol);
  });
}

/* ── 레코드 단위 봉인(users.json OTP 시드 — 보안 잔여 11-27 M3) ───────────────────────────────── */

/*
 * 왜 일반 경로(openSecretsDeep/sealSecretsDeep)가 아닌가 — users.json 은 로그인 카운터 · tokenVersion · 비밀번호 변경 같은 **세션 핵심 쓰기**가 같은 파일이다.
 *  ① sealSecretsDeep 는 키를 쓸 수 없으면(_keyMissing) 어느 모드든 저장을 거절한다 → 로그인 · 비밀번호 변경이 깨진다.
 *  ② openSecret 은 복호 실패를 '' 로 연다 → 다음 저장이 암호문을 지우고, OTP 전용 강제 계정의 분기(totpEnabled && totpSecret)가 거짓이 되어
 *     **비밀번호로 로그인**된다(인증 하향 — 비밀번호가 남아 있는 계정).
 * 그래서 여기서는 ⓐ 복호 실패를 **암호문 그대로** 메모리에 둔다(지우지 않고 · '등록됨' 의미 유지 — 소비처(auth)가 isSealed 로 거른다)
 *  ⓑ 레코드 객체마다 '디스크에 무엇이 있었나'(disk · plain)를 기억해, 시드를 바꾸지 않는 저장은 **디스크 원문을 그대로** 다시 쓴다 —
 *     잠금(S-07) · 키 없음에서도 그렇다(디스크가 이미 그 값이므로 하향이 아니다). 새로 봉인해야 하는 값만 거절한다.
 * 기억은 WeakMap<레코드 객체, Map<칸, {disk, plain}>> — 같은 메모리 객체의 같은 칸만 대상이다(22회차 반증이 거부한 '근사 문맥' 문제가 없다).
 */
const _recMem = new WeakMap();
// 서로 다른 salt(= 봉인한 프로세스 수)가 이보다 많으면 다음 저장에서 세션 키 하나로 다시 봉인한다(정상 정책 · 키에서만) — 복호 때 salt 마다 scrypt 1회라
//   콘솔 등록이 쌓일수록 기동 · 첫 요청이 느려지던 것(반증 S-2). 바이트는 한 번 바뀐다.
export const RECORD_SALT_CAP = 4;

/** 조용한 복호 — 성공이면 평문, 실패면 null(경고 · 실패 카운터 · '' 대체 없음). 키를 쓸 수 없으면 null. */
function openQuiet(v) {
  if (!isSealed(v)) return null;
  try {
    const [alg, logN, salt, iv, tag, ct] = v.slice(PREFIX.length).split('$');
    if (!Object.prototype.hasOwnProperty.call(ALGOS, alg)) return null;
    const key = deriveKey(alg, Number(logN), Buffer.from(salt, 'base64url'));
    const d = crypto.createDecipheriv(alg, key, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch { return null; }
}
const saltOf = (v) => v.slice(PREFIX.length).split('$')[2] || '';
function memOf(r) { let m = _recMem.get(r); if (!m) { m = new Map(); _recMem.set(r, m); } return m; }

/**
 * 로드 경계 — records(배열)의 fields 칸을 연다(in-place). 평문은 그대로(혼재 읽기 호환), 봉인은 복호해 평문으로 바꾸고,
 * **복호에 실패하면 암호문을 그대로 둔다**('' 로 바꾸지 않는다). 레코드별로 디스크 원문을 기억한다(sealRecordFields 가 쓴다).
 * @returns {{ opened:number, failed:number, plaintext:number }}  plaintext = 디스크에 평문으로 있던 시드 수(업그레이드 자동 봉인 판정)
 */
export function openRecordFields(records, fields) {
  const out = { opened: 0, failed: 0, plaintext: 0 };
  if (!Array.isArray(records)) return out;
  for (const r of records) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    for (const f of fields) {
      const v = r[f];
      if (typeof v !== 'string' || v === '') continue;
      if (!isSealed(v)) { memOf(r).set(f, { disk: v, plain: v }); out.plaintext += 1; continue; }
      const p = openQuiet(v);
      if (p == null || p === '') { memOf(r).set(f, { disk: v, plain: null }); out.failed += 1; continue; }   // 암호문 보존
      r[f] = p; memOf(r).set(f, { disk: v, plain: p }); out.opened += 1;
    }
  }
  return out;
}

/** 새 비밀을 봉인할 수 없는 사유(Error) 또는 null. 평문 모드는 null(키를 보지 않는다). */
function newSealError(pol) {
  if (pol?.mode === 'plain') return null;
  if (pol?.mode !== 'encrypted') return new SecretsPolicyUnavailableError(pol);
  try { masterKey(); } catch (e) { return e; }
  return toolKeyIssue();
}
/** 새 비밀(예: 새 OTP 시드)을 **바꾸기 전에** 봉인할 수 있는지 — null 이면 된다, 아니면 { code, reason }(한국어). */
export function newSecretSealIssue(pol = policy()) {
  const e = newSealError(pol);
  return e ? { code: e.code || 'SECRETS_SEAL_UNAVAILABLE', reason: e.message } : null;
}

/**
 * 저장 경계 — records 를 바꾸지 않고, 디스크에 쓸 레코드 배열과 commit() 을 돌려준다. 바꿔 써야 하는 레코드만 얕은 복사(키 순서 유지)하고
 * 나머지는 **같은 객체**다 — 평문 모드 · 봉인 값 없음이면 records 그 자체를 돌려준다(파일 바이트가 예전과 같다).
 * 칸 값 v 마다: 봉인 문자열(복호 실패분) → 그대로 · 평문 모드 → 평문 · 암호화 모드 → 같은 레코드의 기억 중 평문이 같은 것(같은 칸 먼저, 다음 형제 칸 —
 *   확정이 대기 시드를 활성 칸으로 옮길 때 암호문을 승계)이 현재 정책과 같은 봉인이면 재사용, 아니면 새로 봉인 · 새로 봉인할 수 없으면(키 없음 · 잠금 ·
 *   콘솔 도구 키 미확인) 그 기억의 디스크 원문을 승계하고, 기억이 없으면 던진다. 한 레코드 안에서 같은 암호문을 두 칸에 쓰지 않는다.
 * 잠금(정책을 못 읽음)도 같은 갈래다 — 정책 판정이 '새로 봉인할 수 없음' 이라 디스크 원문 승계 · 없으면 SecretsPolicyUnavailableError.
 * commit() 은 **원자적 쓰기가 성공한 뒤에만** 부른다(기억을 이번에 쓴 형태로 바꾼다 — 쓰기 실패면 기억은 디스크 그대로).
 */
export function sealRecordFields(records, fields, pol = policy()) {
  const list = Array.isArray(records) ? records : [];
  const fieldList = [...fields];
  const plans = [];
  let outRecords = list;
  let issue;   // undefined = 아직 판정 안 함
  const sealIssue = () => (issue === undefined ? (issue = newSealError(pol)) : issue);
  const want = pol?.mode === 'encrypted' ? policyParams(pol) : null;
  // salt 정리(반증 S-2): 재사용 후보 암호문의 서로 다른 salt 가 상한을 넘으면 이번에는 재사용하지 않고 세션 키로 다시 봉인한다.
  let consolidate = false;
  if (want) {
    const salts = new Set();
    for (const r of list) {
      const m = r && typeof r === 'object' ? _recMem.get(r) : null;
      if (!m) continue;
      for (const e of m.values()) if (e.plain != null && isSealed(e.disk)) salts.add(saltOf(e.disk));
    }
    consolidate = salts.size > RECORD_SALT_CAP && !sealIssue();
  }
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const mem = _recMem.get(r);
    const used = new Set();
    const wrote = new Map();
    let next = null;
    for (const f of fieldList) {
      const v = r[f];
      if (typeof v !== 'string' || v === '') continue;
      let disk;
      if (isSealed(v)) disk = v;                                   // 복호 실패분(또는 이미 봉인) — 원래 암호문 보존
      else if (pol?.mode === 'plain') disk = v;                     // 정책이 평문 — 다른 등록부와 같다
      else {
        const cands = [];
        if (mem) {
          const same = mem.get(f);
          if (same && same.plain === v) cands.push(same);
          for (const g of fieldList) { if (g === f) continue; const e = mem.get(g); if (e && e.plain === v) cands.push(e); }
        }
        const free = cands.filter((c) => !(isSealed(c.disk) && used.has(c.disk)));
        let reuse = null;
        if (want && !consolidate) reuse = free.find((c) => { if (!isSealed(c.disk)) return false; const p = sealedParams(c.disk); return p.alg === want.alg && p.logN === want.logN; }) || null;
        if (reuse) disk = reuse.disk;
        else if (!sealIssue()) disk = sealSecret(v, pol);
        else if (free.length) disk = free[0].disk;                 // 새로 봉인할 수 없음 — 디스크에 있던 원문 그대로(하향 아님)
        else throw sealIssue();
      }
      if (isSealed(disk)) used.add(disk);
      wrote.set(f, { disk, plain: isSealed(v) ? null : v });
      if (disk !== v) { if (!next) next = { ...r }; next[f] = disk; }
    }
    plans.push([r, wrote]);
    if (next) { if (outRecords === list) outRecords = list.slice(); outRecords[i] = next; }
  }
  return {
    records: outRecords,
    commit() {
      for (const [r, wrote] of plans) {
        const m = memOf(r);
        for (const f of fieldList) { if (wrote.has(f)) m.set(f, wrote.get(f)); else m.delete(f); }
      }
    },
  };
}

/**
 * 복원 경고용 — JSON 텍스트(users.json 모양 { users: [...] })의 fields 칸 봉인 값 중 **이 호스트의 키로 열 수 없는** 것을 센다.
 * 부작용 없음: 키를 만들지 않는다(키가 없으면 masterKey 를 부르지 않고 전부 못 엶으로 센다) · 실패 카운터 · 경고 · 재사용 기억을 건드리지 않는다.
 * @returns {{ sealed:number, unopenable:number, records: Array<{ role:string|null, totpEnabled:boolean }> }}  records = 못 여는 시드가 있는 레코드
 */
export function countUnopenableSealed(text, fields = USER_SECRET_FIELDS) {
  const out = { sealed: 0, unopenable: 0, records: [] };
  let data;
  try { data = JSON.parse(String(text)); } catch { return out; }
  const list = Array.isArray(data?.users) ? data.users : [];
  const usable = keyUsableWithoutCreating();
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    let bad = false;
    for (const f of fields) {
      const v = r[f];
      if (!isSealed(v)) continue;
      out.sealed += 1;
      if (!usable || openQuiet(v) == null) { out.unopenable += 1; bad = true; }
    }
    if (bad) out.records.push({ role: typeof r.role === 'string' ? r.role : null, totpEnabled: !!r.totpEnabled });
  }
  return out;
}
// 키를 **만들지 않고** 쓸 수 있는가 — 이미 읽었거나, env 가 유효하거나, 키 파일이 유효한 길이로 있을 때만. 이때 masterKey() 는 생성 갈래에 가지 않는다.
function keyUsableWithoutCreating() {
  if (_key) return true;
  if (_keyMissing) return false;
  const env = process.env.SECRETS_KEY;
  if (env && env.length >= 16) return true;
  try { return fs.readFileSync(keyFile(), 'utf8').trim().length >= 32; } catch { return false; }
}

/* ── 콘솔 도구 모드 · 키 확인 값(보안 잔여 11-27 M3 — 반증 M-1) ─────────────────────────────────────── */

/*
 * 콘솔 도구(otp-enroll · user-admin)는 포탈과 **같은 키**를 쓰는지 스스로 알 수 없다 — 포탈은 SECRETS_KEY(portal.env, systemd EnvironmentFile)를 우선하고
 * 도구는 그 파일을 못 읽으면(권한 · Windows 의 portal.env.bat · 따옴표 해석 차이) secrets-key 파일 키를 쓴다. 다른 키로 시드를 봉인하면 재시작 뒤 포탈이
 * 그 시드를 열지 못해 **복구하려던 관리자가 잠긴다**. 그래서 포탈이 자기 키로 봉인한 상수(키 확인 값)를 CONFIG_DIR/secrets-keycheck 에 두고,
 * 도구는 암호화 정책에서 새 봉인 전에 그 값을 자기 키로 열어 본다 — 열리지 않거나 없으면 새로 봉인하지 않는다(디스크 원문 승계 · 새 시드 거절).
 * 값은 다른 암호문과 같은 형식 · 같은 KDF 강도다(빠른 HMAC 검증값을 두면 약한 SECRETS_KEY 의 오프라인 대입이 쉬워진다). 확장자가 없어 백업 번들 밖이다.
 * 포탈은 키를 처음 쓸 때 · 암호화 정책을 저장할 때 **비동기**(scrypt 를 libuv 스레드에서)로 맞춘다 — 이벤트 루프를 막지 않는다. 도구는 쓰지 않는다.
 * ⚠ 콘솔 도구 모드가 아닌 프로세스는 '포탈' 로 본다 — 키를 쓰는 다른 독립 실행 스크립트를 새로 만들면 disallowKeyCreation() 을 부를 것.
 */
const keyCheckFile = () => path.join(config.configDir, 'secrets-keycheck');
const KEYCHECK_PLAIN = 'secretVault-keycheck-v1';
let _noKeyCreation = false;
let _toolKeyVerdict;   // undefined = 아직 판정 안 함 · null = 같은 키 · Error = 거절 사유
/** 콘솔 도구 전용 — 이 프로세스는 키를 만들지 않고, 키 확인 값을 쓰지 않으며, 암호화 정책의 새 봉인 전에 포탈과 같은 키인지 확인한다. */
export function disallowKeyCreation() { _noKeyCreation = true; _toolKeyVerdict = undefined; }
/** 콘솔 도구 모드인가(auth 의 업그레이드 자동 봉인은 포탈 프로세스에서만 돈다). */
export function keyCreationDisallowed() { return _noKeyCreation; }

function keyMismatch(why) {
  const e = new Error(`콘솔 도구가 포탈과 같은 암호화 키를 쓰는지 확인하지 못했습니다(${why}) — 포탈이 열 수 없는 값으로 저장해 그 계정이 잠기지 않게 새 비밀을 봉인하지 않습니다. 래퍼(sudo vmware-portal-otp · vmware-portal-users)로 실행해 도구가 portal.env 의 SECRETS_KEY 를 읽게 하고(SECRETS_KEY 가 systemd drop-in 등 portal.env 밖에 있으면 portal.env 로 옮기세요), 키 확인 값이 없으면 포탈을 재시작하고 한 번 로그인한 뒤 다시 실행하세요.`);
  e.code = 'SECRETS_KEY_MISMATCH';
  return e;
}
function toolKeyIssue() {
  if (!_noKeyCreation) return null;
  if (_toolKeyVerdict !== undefined) return _toolKeyVerdict;
  let raw;
  try { raw = fs.readFileSync(keyCheckFile(), 'utf8').trim(); }
  catch (e) { return (_toolKeyVerdict = keyMismatch(e?.code === 'ENOENT' ? '포탈의 키 확인 값 secrets-keycheck 가 없음' : `키 확인 값을 읽지 못함 ${String(e?.code || '')}`.trim())); }
  if (!isSealed(raw)) return (_toolKeyVerdict = keyMismatch('키 확인 값 형식 오류'));
  return (_toolKeyVerdict = openQuiet(raw) === KEYCHECK_PLAIN ? null : keyMismatch('이 도구의 키로 포탈의 키 확인 값이 열리지 않음 — 키가 다름'));
}

const scryptAsync = (pass, salt, len, opts) => new Promise((res, rej) => crypto.scrypt(pass, salt, len, opts, (e, k) => (e ? rej(e) : res(k))));
const KDF_OPTS = (logN) => ({ N: 2 ** logN, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
async function openWithKeyAsync(v, mk) {
  const [alg, logN, salt, iv, tag, ct] = v.slice(PREFIX.length).split('$');
  if (!Object.prototype.hasOwnProperty.call(ALGOS, alg) || !(Number(logN) >= 10 && Number(logN) <= 20)) return null;
  const k = await scryptAsync(mk, Buffer.from(salt, 'base64url'), ALGOS[alg], KDF_OPTS(Number(logN)));
  try {
    const d = crypto.createDecipheriv(alg, k, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch { return null; }
}
async function sealWithKeyAsync(plain, mk, { alg, logN }) {
  const salt = crypto.randomBytes(16);
  const k = await scryptAsync(mk, salt, ALGOS[alg], KDF_OPTS(logN));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(alg, k, iv, { authTagLength: 16 });
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const b = (x) => x.toString('base64url');
  return `${PREFIX}${alg}$${logN}$${b(salt)}$${b(iv)}$${b(c.getAuthTag())}$${b(ct)}`;
}
let _keyCheckRun = null;    // 진행 중인(또는 끝난) 맞추기(Promise)
let _keyCheckFor = null;    // 맞춘(또는 맞추는 중인) 키 — 키 하나당 한 번
/** 포탈 — 암호화 정책이고 키를 쓸 수 있으면 키 확인 값을 비동기로 맞춘다(같은 키면 쓰지 않는다). 도구 모드는 아무것도 하지 않는다. */
function scheduleKeyCheck() {
  if (_noKeyCreation || !_key || _keyCheckFor === _key) return;
  let pol;
  try { pol = policy(); } catch { return; }
  if (pol?.mode !== 'encrypted') return;
  const mk = _key; _keyCheckFor = mk;
  _keyCheckRun = (async () => {
    let cur = null;
    try { cur = (await fs.promises.readFile(keyCheckFile(), 'utf8')).trim(); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
    if (cur && isSealed(cur) && (await openWithKeyAsync(cur, mk)) === KEYCHECK_PLAIN) return 'same';
    if (_key !== mk) return 'stale';
    const sealed = await sealWithKeyAsync(KEYCHECK_PLAIN, mk, policyParams(pol));
    atomicWriteFileSync(keyCheckFile(), sealed, { mode: 0o600 });
    return 'written';
  })().catch((e) => {
    if (_keyCheckFor === mk) _keyCheckFor = null;   // 다음 기회에 다시
    warnPolicyOnce(`keycheck|${e?.code || e?.message}`, `[secrets] ⚠ 키 확인 값(secrets-keycheck)을 쓰지 못했습니다(${String(e?.code || e?.message || e).slice(0, 80)}) — 콘솔 도구(OTP 등록)가 암호화 정책에서 새 OTP 키를 봉인하지 않습니다. CONFIG_DIR 권한을 확인하세요.`);
    return 'error';
  });
}
/** 포탈(auth) — 사용자 목록을 읽을 때 암호화 정책이면 키 확인 값을 맞춰 둔다(키를 아직 안 썼으면 지금 연다 — 암호화 정책의 첫 봉인과 같은 동작). */
export function ensureKeyCheckSoon() {
  if (_noKeyCreation) return;
  let pol;
  try { pol = policy(); } catch { return; }
  if (pol?.mode !== 'encrypted') return;
  try { masterKey(); } catch { return; }   // 키를 쓸 수 없음 — 그 사유는 masterKey 가 이미 알렸다
  scheduleKeyCheck();
}
/** 테스트용 — 진행 중인 키 확인 맞추기를 기다린다. */
export function _keyCheckSettled() { return _keyCheckRun || Promise.resolve(null); }
/** 현재(3초 캐시) 정책 — 읽기 전용 사본. */
export function secretsPolicyCached() { return { ...policy() }; }

/* ── 모드 전환 마이그레이션 ───────────────────────────────────────────────── */

/**
 * 등록된 전 파일을 새 정책으로 일괄 재저장(평문→암호화 / 암호화→평문 / 레벨·알고리즘 변경).
 * 파일별로: 파스 → 전부 복호(자기서술 포맷이라 이전 정책 불요) → 새 정책이 encrypted 면 봉인 →
 * 원자적 재기록. 실행 중 프로세스는 영향 없음(메모리는 평문 유지, 다음 save 는 새 정책).
 * @returns {{ files: Array<{file, changed, secrets}>, errors: Array<{file, error}> }}
 */
export function migrateSecretFiles(newPolicy) {
  // S-07: 정책이 아닌 값(잠금 상태 객체·알 수 없는 mode)을 normPolicy 로 plain 으로 바꿔 전 파일을 평문으로 재기록하지 않는다.
  if (!newPolicy || !MODES.includes(newPolicy.mode)) throw new Error(`전환할 저장 방식이 올바르지 않습니다(mode: ${String(newPolicy?.mode).slice(0, 40)}).`);
  const pol = normPolicy(newPolicy);
  const out = { files: [], errors: [] };
  for (const name of SECRET_FILES) {
    const fp = path.join(config.configDir, name);
    try {
      if (fileMissing(fp)) { out.files.push({ file: name, changed: false, secrets: 0 }); continue; }   // 134회차: stat 실패는 없음이 아니다 — 아래 읽기가 오류로 남긴다(조용히 건너뛰지 않는다)
      const raw = fs.readFileSync(fp, 'utf8');
      const data = JSON.parse(raw);
      const failBefore = _decryptFailures;
      const extra = FILE_EXTRA_SECRET_FIELDS[name] || null; // v2.604: 파일 한정 추가 필드(alerts.json 의 url)
      openSecretsDeep(data, extra);                        // ① 전부 평문으로
      // v2.480(3차 감사 코어2 S2): 이 파일에서 복호 실패가 있었으면 재기록하지 않는다 — 실패값 '' 를 디스크에 쓰면 암호문이
      // 영구 소거된다(키 env 누락 상태에서 '평문 전환' 1회면 전 레지스트리 비밀 유실). 키를 복구한 뒤 다시 전환하면 된다.
      // 보안 잔여 11-27 M3(반증 N-5): users.json 의 복호 실패는 OTP 시드다 — 키를 정말 잃었으면(SECRETS_KEY_LOST) 그 계정을 다시 등록하거나 해제해야 이 보고가 사라진다.
      if (_decryptFailures > failBefore) { out.errors.push({ file: name, error: `복호 실패 ${_decryptFailures - failBefore}건 — 암호문 보존을 위해 이 파일은 재기록하지 않음(키 확인 후 재시도)${name === 'users.json' ? ' · OTP 키라면 키를 되돌리거나, 키를 잃었으면 그 계정의 OTP 를 다시 등록 · 해제하세요(콘솔 도구 vmware-portal-otp)' : ''}` }); continue; }
      let count = 0;
      walk(data, (k, v) => {                               // ② 대상 필드 수 집계(보고용)
        if (k && (SECRET_FIELDS.has(k) || extra?.has(k)) && typeof v === 'string' && v !== '') count += 1;
        return undefined;
      });
      const next = pol.mode === 'encrypted' ? sealSecretsDeep(data, pol, extra) : data;
      const nextRaw = JSON.stringify(next, null, 2);
      const changed = nextRaw !== raw;
      // 평문→평문 재기록도 무해하지만, 무변경이면 파일 mtime 을 건드리지 않는다(mtime 캐시 스토어 배려).
      if (changed) atomicWriteFileSync(fp, nextRaw, { mode: 0o600 });
      out.files.push({ file: name, changed, secrets: count });
    } catch (e) {
      // 한 파일 실패가 전체 전환을 막지 않는다 — 자기서술 포맷이라 혼재 상태로도 동작하며,
      // 실패 파일은 보고돼 사용자가 원인(손상·권한)을 고치고 재시도할 수 있다.
      out.errors.push({ file: name, error: safeLoadText(e, 200) || '사유 미상' });   // 21회차 L-5: JSON.parse 원문(파일 조각 — 비밀번호 끝 글자)이 응답에 실리던 것
    }
  }
  return out;
}
