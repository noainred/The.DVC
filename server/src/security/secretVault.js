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
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

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
  'gpu-physical.json',             // 물리 GPU 서버 SSH 계정
  'horizon.json',                  // Horizon 접속 계정
  'remote-access.json',            // 원격접속(HAProxy dataplane·SSH 프록시) 계정/키
  'capture-monitors.json',         // 네트워크 캡처 호스트 SSH 계정/키
  'agent-deploy-targets.json',     // 에이전트 배포 대상 SSH 계정/키
  'relay-topology.json',           // 중계 토폴로지 노드(Main/Edge/IRS) SSH 계정/키(v2.431)
  'central-agent-gpu-guest.json',  // 엣지 배포용 GPU 게스트 설정 사본(계정 포함)
  'mail.json',                     // 포탈 공용 메일(SMTP) 계정 비밀번호(v2.454)
  'bm-storage.json',               // 베어메탈 스토리지 SSH 계정 비밀번호(v2.500 감사 M4 — 등록 누락이었다)
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
];

/**
 * 파일 한정 추가 봉인 필드(v2.604 SEC2604-03). 전역 SECRET_FIELDS 에 넣으면 다른 파일의 같은 이름(접속 주소 `url`)까지
 * 봉인되어 버리는 이름을 **그 파일에서만** 봉인한다. 해당 파일의 load/save 는 이 집합을 openSecretsDeep/sealSecretsDeep 에
 * 넘기고, 모드 전환 마이그레이션도 같은 집합을 쓴다(한쪽만 하면 반쪽 상태 — 위 메모 규약).
 */
export const FILE_EXTRA_SECRET_FIELDS = Object.freeze({ 'alerts.json': new Set(['url']) });

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
  try {
    if (!fs.existsSync(fp)) return { state: 'missing' };
    raw = fs.readFileSync(fp, 'utf8');
  } catch (e) { return { state: 'unreadable', error: e.message }; }   // 권한·입출력 — 손상이 아니므로 옆으로 치우지 않는다
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
  try { if (fs.existsSync(keyFile())) ev.push('key-file'); } catch { /* 존재 확인 실패는 흔적 없음으로 */ }
  try { if (fs.readdirSync(config.configDir).some((n) => n.startsWith('secrets-policy.json.corrupt.'))) ev.push('corrupt-policy-copy'); } catch { /* */ }
  for (const name of SECRET_FILES) {
    try {
      const fp = path.join(config.configDir, name);
      if (fs.existsSync(fp) && fs.readFileSync(fp, 'utf8').includes(PREFIX)) { ev.push('sealed-values'); break; }
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
  return { ...next };
}

/* ── 마스터 키 ────────────────────────────────────────────────────────────── */

let _key = null;
function masterKey() {
  if (_key) return _key;
  const env = process.env.SECRETS_KEY;
  if (env && env.length >= 16) { _key = Buffer.from(env, 'utf8'); return _key; }
  try {
    const cur = fs.existsSync(keyFile()) ? fs.readFileSync(keyFile(), 'utf8').trim() : '';
    if (cur.length >= 32) { _key = Buffer.from(cur, 'utf8'); return _key; }
    const gen = crypto.randomBytes(32).toString('base64url');
    atomicWriteFileSync(keyFile(), gen, { mode: 0o600 });
    console.log(`[secrets] 암호화 키가 없어 ${keyFile()} 에 생성·영속했습니다(0600). 멀티노드/외부 비밀관리가 필요하면 SECRETS_KEY env 를 설정하세요.`);
    _key = Buffer.from(gen, 'utf8');
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
    if (!warned.has(k)) { warned.add(k); console.warn(`[secrets] ⚠ 자격증명 복호 실패(${k}) — 빈 값으로 대체. 키(secrets-key/SECRETS_KEY) 변경·유실 여부를 확인하고 해당 계정 비밀번호를 재입력하세요.`); }
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

/** 로드 경계용 — 봉인 포맷인 문자열을 **키 이름과 무관하게** 전부 복호(과거 필드 개명에도 안전). in-place. */
export function openSecretsDeep(obj, extraFields = null) {
  const seen = new Set();   // v2.599: 한 파일 안에서 같은 문맥이 두 번 나오면 첫 것만 기억한다(뒤 것이 덮어 엉뚱한 대상에 재사용되지 않게)
  return walkCtx(obj, (k, v, parent, segs) => {
    if (!isSealed(v)) return undefined;
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
      if (!fs.existsSync(fp)) { out.files.push({ file: name, changed: false, secrets: 0 }); continue; }
      const raw = fs.readFileSync(fp, 'utf8');
      const data = JSON.parse(raw);
      const failBefore = _decryptFailures;
      const extra = FILE_EXTRA_SECRET_FIELDS[name] || null; // v2.604: 파일 한정 추가 필드(alerts.json 의 url)
      openSecretsDeep(data, extra);                        // ① 전부 평문으로
      // v2.480(3차 감사 코어2 S2): 이 파일에서 복호 실패가 있었으면 재기록하지 않는다 — 실패값 '' 를 디스크에 쓰면 암호문이
      // 영구 소거된다(키 env 누락 상태에서 '평문 전환' 1회면 전 레지스트리 비밀 유실). 키를 복구한 뒤 다시 전환하면 된다.
      if (_decryptFailures > failBefore) { out.errors.push({ file: name, error: `복호 실패 ${_decryptFailures - failBefore}건 — 암호문 보존을 위해 이 파일은 재기록하지 않음(키 확인 후 재시도)` }); continue; }
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
      out.errors.push({ file: name, error: e.message });
    }
  }
  return out;
}
