/**
 * portalcheck/archScan.js — 특수 기능 › 포탈 점검 › **아키텍처 점검**(v2.614) 판정 코어.
 *
 * v2.613 감사에서 손으로(테스트·grep 으로) 하던 정합 판정을 **운영 포탈이 스스로** 돌린다 — 배포된 서버가 자기 라우터
 * 스택·게이트 태그·도구 카탈로그·엣지 로그 표·BIG_JSON 등록·DB 파일·설정 파일 분류·import 그래프를 본다.
 *
 * 구조(계약 `ARCH-SPEC.md`):
 *  · `gatherArchInputs({routers, flowRoutes})` — 입력 수집(파일·모듈 import·라우터 스택). **입력마다 try/catch** — 하나를
 *    못 읽어도 다른 항목은 판정하고, 못 읽은 것은 `inputs.errors` 에 남기며 그 입력에 의존하는 항목만 `unknown` 이다.
 *  · `scanArch(inputs)` — 순수 판정. 상태는 `ok`/`warn`/`fault`/**`unknown`**(못 읽음 — 정상으로도 결함으로도 세지 않는다).
 *  · `setApp(app)` — index.js 가 라우터 마운트 뒤 1회 주입. 마운트 수준 게이트(`app.use('/api/insights', …, requirePerm)`)와
 *    BIG_JSON 마운트는 app 의 라우터 스택에서만 읽을 수 있다. 주입 전(테스트·부팅 중)에는 그 두 입력이 없다고 밝힌다.
 *
 * ⚠ 이 모듈은 routes/ 를 import 하지 않는다(arch2579 규칙 ① — 도메인은 라우트를 향하지 않는다). 라우터는 라우트 파일이
 *   `gatherArchInputs({routers})` 로 넘긴다(dataflow/build.js 가 `routes` 를 받는 것과 같은 모양).
 * ⚠ 왕복 0 — 장비·엣지에 나가지 않는다. 비용은 import 그래프(server/src 전 파일 읽기·주석 제거, 수백 ms)뿐이라 라우트가
 *   memoJson 30초로 감싼다.
 * ⚠ 허용 목록(`ROUTE_GATE_ALLOW`·`BIG_JSON_SMALL`·`UTIL_ALLOW`·`DB_MIGRATE_EXCLUDED`·`KNOWN_CONFIG_FILES`)은 전부 **사유와
 *   함께** 적는다. 사유 없이 빼면 화면이 '정상' 이라 말하면서 무엇을 뺐는지 아무도 모른다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { TOOL_PATH_KEYS, TOOL_PATH2_KEYS, TOOL_EXACT_PATHS, UNMAPPED_TOOL_SEGMENTS } from '../auth/toolAccess.js';
import { ROLES, roleToolsDenied, userToolOverrides } from '../auth/permissions.js';
import { STATUS_SPEC } from '../edgelog/spec.js';
import { MIGRATABLE, MIGRATABLE_DIRS } from '../insights/dbLocation.js';
import { PURPOSES } from '../insights/portalDb.js';
import { RUNTIME_STATE_NAMES, isRuntimeStateFile } from '../backup/service.js';
import { SECRET_FILES } from '../security/secretVault.js';
import { buildDataFlow } from '../dataflow/build.js';
import { PRESET } from '../toolcats/catalog.js';
import { load as loadToolCats } from '../toolcats/settings.js';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_MAX = 20;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** 점검 항목 코드 — 웹 `archCheckText.js ARCH_TEXT` 키와 1:1(테스트가 대조). 순서가 화면 표 순서다. */
export const ARCH_CODES = Object.freeze([
  'route-gate-missing', 'asyncroute-unwrapped', 'tool-segment-unmapped',
  'catalog-missing', 'catalog-key-orphan', 'catalog-adminonly-mismatch',
  'edgelog-spec-drift', 'bigjson-missing', 'dataflow-cats-unmapped',
  'db-file-mode', 'db-not-migratable', 'db-no-purpose', 'config-file-unclassified',
  'import-cycle', 'util-imports-domain',
]);
export const ARCH_STATES = Object.freeze(['ok', 'warn', 'fault', 'unknown']);
/** 0 이 아니면 `fault` 인 항목 — 나머지는 `warn`. */
const FAULT_CODES = new Set(['asyncroute-unwrapped', 'tool-segment-unmapped', 'edgelog-spec-drift']);
/** 순환 SCC 상한(arch2579.test.js 와 같은 값 — v2.586 부터 4). */
export const IMPORT_CYCLE_MAX = 4;

/**
 * route-gate-missing 허용 목록 — `METHOD /경로` → 사유. 게이트 미들웨어 대신 **핸들러 안에서** 범위 판정을 하는 라우트
 * (v2.605 scopeMerge · v2.606 denyScopedRun · v2.607 사용자 관리 경계 · inUserWriteScope). 사유는 실제 코드를 열어 확인한
 * 것이다(2026-09-25). ⚠ 여기 없는 admin 상태변경 라우트는 `warn` 으로 **보인다** — 그것이 이 항목의 목적이다(v2.612 스윕의
 * 런타임판). 핸들러 안 판정을 새로 만들면 사유와 함께 여기 적을 것.
 */
export const ROUTE_GATE_ALLOW = Object.freeze({
  // routes/admin/backupNetSec.js — denyScopedRun·writeScopedVcenterIds·denyGuestScanOutOfScope(v2.606 AUTHZ2606)
  'PUT /api/admin/vclogs/settings': 'denyScopedRun — 범위 계정 403(v2.606)',
  'POST /api/admin/vclogs/collect': 'denyScopedRun — 범위 계정 403(v2.606)',
  'POST /api/admin/guest/add-user': 'writeScopedVcenterIds — 대상 vCenter 쓰기 범위 판정(v2.606)',
  'POST /api/admin/deep-search/probe': 'writeScopedVcenterIds — 대상 vCenter 쓰기 범위 판정(v2.606)',
  'PUT /api/admin/security/login-fails/settings': 'denyScopedRun — 범위 계정 403(v2.606)',
  'POST /api/admin/security/login-fails/run': 'denyScopedRun — 범위 계정 403(v2.606)',
  'PUT /api/admin/security/guest-scans': 'scopedVcenterIds — 예약의 vCenter 를 범위로 판정',
  'DELETE /api/admin/security/guest-scans/:id': 'denyGuestScanOutOfScope — 범위 밖 예약 404',
  'POST /api/admin/security/guest-scans/:id/run': 'denyGuestScanOutOfScope — 범위 밖 예약 404',
  // routes/admin/centralIpam.js
  'PUT /api/admin/ipam/settings': 'mergeScoped — 범위 밖 키 보존 병합(v2.605 AUTHZ2605-01)',
  'PUT /api/admin/ipam/vc-ranges': 'vcRangeWritable — 범위 밖 vCenter 404(v2.607 AUTHZ2607-04)',
  'DELETE /api/admin/ipam/vc-ranges/:vcenterId': 'vcRangeWritable — 범위 밖 vCenter 404(v2.607 AUTHZ2607-04)',
  'POST /api/admin/ipam/vc-ranges/import': 'vcRangeWritable — 행마다 범위 판정(v2.607 AUTHZ2607-04)',
  // routes/admin/deployLlm.js · idracScan.js — 상태 변경 없음
  'POST /api/admin/llm-test': '상태 변경 없음 — 연결 테스트(llmUrlIssue SSRF 검사, v2.590 D6)',
  'POST /api/admin/idrac/expand-ips': '상태 변경 없음 — IP 목록 전개(순수 계산)',
  // routes/admin/gpuGuest.js
  'PUT /api/admin/metrics/settings': 'mergeScoped + denyScopedRun(v2.605·v2.606)',
  'POST /api/admin/gpu/collect-util': 'denyScopedRun — 범위 계정 403(v2.606)',
  'PUT /api/admin/gpu-guest/settings': 'mergeScoped — 범위 밖 키 보존 병합(v2.611)',
  'POST /api/admin/gpu-guest/test': 'inUserScope — 범위 밖 vCenter 404(v2.611)',
  'POST /api/admin/gpu-guest/test-ssh': '상태 변경 없음 — 본문 계정으로 SSH 연결 테스트 1회(저장 안 함)',
  // routes/admin/opsSettings.js
  'PUT /api/admin/alerts': 'mergeScoped — 범위 밖 키 보존 병합(v2.605)',
  'POST /api/admin/alerts/test': 'scopedVcenterIds — 범위 계정 판정(v2.605)',
  'PUT /api/admin/report/daily': 'mergeScoped — 범위 밖 키 보존 병합(v2.605)',
  'POST /api/admin/report/daily/run': 'scopedVcenterIds — 범위 계정 판정(v2.605)',
  'POST /api/admin/certs/refresh': 'scopedVcenterIds — 범위 계정 판정(v2.605)',
  'PUT /api/admin/anomaly': 'mergeScoped — 범위 밖 키 보존 병합(v2.605)',
  'PUT /api/admin/os-scan/settings': 'scopedVcenterIds — 범위 계정 판정',
  'POST /api/admin/os-scan/run': 'scopedVcenterIds — 범위 계정 판정',
  'POST /api/admin/provision/jobs': 'inUserWriteScope — 대상 vCenter 쓰기 범위(v2.369)',
  'PUT /api/admin/provision/saved/:id': 'inUserWriteScope — 저장 항목의 vCenter 쓰기 범위',
  'DELETE /api/admin/provision/saved/:id': 'inUserWriteScope — 저장 항목의 vCenter 쓰기 범위',
  // routes/admin/users.js — v2.607 AUTHZ2607-01(denyTargetOutOfScope · scopeWithinActor · 전체 범위 계정 거부)
  'POST /api/admin/users': 'scopeWithinActor — 새 범위는 요청자 범위의 부분집합(v2.607 AUTHZ2607-01)',
  'PATCH /api/admin/users/:username': 'denyTargetOutOfScope(v2.607 AUTHZ2607-01)',
  'DELETE /api/admin/users/:username': 'denyTargetOutOfScope(v2.607 AUTHZ2607-01)',
  'PUT /api/admin/user-tools/:username': 'denyTargetOutOfScope(v2.607 AUTHZ2607-01)',
  'PUT /api/admin/permissions': '핸들러 첫 줄에서 범위 계정 403(v2.607 AUTHZ2607-01)',
  'POST /api/admin/permissions/reset': '핸들러 첫 줄에서 범위 계정 403(v2.607 AUTHZ2607-01)',
  'POST /api/admin/users/:username/password': 'denyTargetOutOfScope(v2.607 AUTHZ2607-01)',
  'DELETE /api/admin/users/:username/password': 'denyTargetOutOfScope(v2.607 AUTHZ2607-01)',
  'POST /api/admin/users/:username/totp/begin': 'denyTargetOutOfScope(v2.607 AUTHZ2607-01)',
  'POST /api/admin/users/:username/totp/confirm': 'denyTargetOutOfScope(v2.607 AUTHZ2607-01)',
  'POST /api/admin/users/:username/totp/disable': 'denyTargetOutOfScope(v2.607 AUTHZ2607-01)',
  // routes/admin/vcenters.js
  'PUT /api/admin/vcenters/:id': 'scopedVcenterIds — 범위 밖 vCenter 404',
  'DELETE /api/admin/vcenters/:id': 'scopedVcenterIds — 범위 밖 vCenter 404',
  'POST /api/admin/vcenters/test': '범위 계정은 저장된 범위 안 vCenter 만(v2.607)',
  'POST /api/admin/vcenters/test-all': 'scopedVcenterIds — 범위 안 vCenter 만 시험(v2.607)',
  // routes/api — 인라인 requireRole('admin') + 핸들러 안 판정(2026-09-25 각 핸들러 첫 줄 확인)
  'PUT /api/tools/bm-usage/settings': 'mergeScoped — 범위 밖 법인 설정 보존 병합(v2.611)',
  'PUT /api/tools/waste/off-check/settings': 'denyScopedRun — 범위 계정 403(v2.605 AUTHZ2605-02)',
  'POST /api/tools/waste/off-check/run': 'denyScopedRun — 범위 계정 403(v2.605 AUTHZ2605-02)',
  'PUT /api/tools/waste/settings': 'mergeScoped — 범위 밖 키 보존 병합(v2.605)',
  'DELETE /api/tools/waste/settings/data': '핸들러에서 범위 계정 403(requiredOwner)',
  'PUT /api/tools/guest-disk/settings': 'denyScopedRun — 범위 계정 403(v2.605 AUTHZ2605-02)',
  'POST /api/tools/guest-disk/run': 'denyScopedRun — 범위 계정 403(v2.605 AUTHZ2605-02)',
  'PUT /api/tools/vmseries/settings': 'mergeScoped — 범위 밖 vCenter 설정 보존 병합(v2.605 AUTHZ2605-01)',
  'POST /api/tools/vmseries/run': 'denyScopedRun + inUserScope(v2.605)',
  'DELETE /api/tools/vmseries/data': '핸들러에서 범위 계정 403(requiredOwner)',
  'POST /api/tools/curuser/collect': 'denyScopedRun — 범위 계정 403(v2.605 AUTHZ2605-02)',
  'PUT /api/tools/curuser/settings': 'mergeScoped — 범위 밖 키 보존 병합(v2.605)',
  'POST /api/tools/horizon-sessions/collect': 'denyScoped — 범위 계정 403(v2.605 AUTHZ2605-02)',
  'PUT /api/tools/horizon-sessions/settings': 'denyScoped — 범위 계정 403(v2.605 AUTHZ2605-02)',
  'POST /api/tools/vm-track/snapshot': 'denyScopedRun — 범위 계정 403(v2.605 AUTHZ2605-02)',
  'POST /api/tools/vm-clone/jobs': 'inUserWriteScope — 대상 vCenter 쓰기 범위(v2.369)',
  'DELETE /api/tools/vm-clone/jobs/:id': 'scopedVcenterIds — 작업의 vCenter 범위 판정',
  'POST /api/tools/vm-clone/jobs/:id/run': 'scopedVcenterIds — 작업의 vCenter 범위 판정',
});

/**
 * bigjson-missing 허용 목록 — `side:/경로` → 사유(본문이 구조적으로 작아 기본 1MB 파서로 충분한 POST). ⚠ '작다' 는 계산해서
 * 적는다 — 목록·결과를 통째로 싣는 경로는 여기 넣지 말고 index.js 에 BIG_JSON 을 등록할 것(413 은 재시도 대상이 아니라
 * 조용한 소실이다 — v2.503·v2.517 규약).
 */
export const BIG_JSON_SMALL = Object.freeze({
  'central:/register-collector': '자기등록 — 이름·버전·주소 몇 필드',
  'central:/result': '위임 iDRAC 스캔 잡 결과 — 잡 단위(대역 하나) · 서버 항목 수백 개여도 1MB 아래(v2.287)',
  'central:/capacity-report': '리소스 적정성 요약 — vCenter 단위 집계값(원시 행 없음)',
  'central:/svcmon-config-ack': '배정 sig 확인응답 한 줄',
  'central:/idrac-scan-progress': '진행률 숫자 몇 개',
  'central:/sanswitch-test-result': '연결 테스트 1대 결과',
  'central:/rma-poll': '잡 인출 요청(본문은 agent 이름뿐)',
  'central:/rma-credential': '자격증명 요청(대상 id 하나)',
  'central:/ping-result': 'ping 결과 — 대상당 수 필드 × 대상 수백(수십 KB)',
  'central:/capture-result': '캡처 결과 요약(파일은 별도 경로)',
  'central:/bmstor-result': 'df 마운트 결과 — 서버 1대 단위',
  'collector:/set-password': '계정 비밀번호 한 건',
  'collector:/idrac-scan': '스캔 요청 — 대역 문자열',
  'collector:/bmstor-collect': '수집 요청 — 대상 id',
  'collector:/upgrade': '본문 파서가 express.raw(번들 바이너리) — JSON 한도와 무관',
});

/** util/ 이 바깥을 향해도 되는 예외 — arch2579.test.js 의 UTIL_ALLOW 와 같은 값·같은 사유. */
export const UTIL_ALLOW = Object.freeze({
  'perf/monitor.js': '루프 지연·스톨 계측은 횡단 관심사(instrumentation) — util 이 기록만 남긴다',
  'vcenter/soapParse.js': '순수 SOAP 파서인데 vcenter/ 아래에 산다 — 워커 풀이 그것을 돌린다(옮기는 것은 별건)',
});

/** dbDir 의 *.db 중 MIGRATABLE 에 **의도적으로** 없는 파일(insights/dbLocation.js 머리말의 두 예외). */
export const DB_MIGRATE_EXCLUDED = Object.freeze({
  'vcenter-logs.db': '설정 › 로그 수집의 storagePath 가 따로 경로를 정한다(두 곳이 제어하면 어느 쪽이 이겼는지 모른다)',
  'ipam.db': '외부 프로그램이 경로를 고정해 읽는 공유 파일 — 옮기면 외부 연동이 조용히 끊긴다',
});

/** CONFIG_DIR 의 설정 파일 중 PURPOSES·SECRET_FILES·상태 판정 어디에도 없지만 설치가 만드는 것으로 확인된 파일. */
export const KNOWN_CONFIG_FILES = Object.freeze({
  'portal.env': '설치 스크립트가 만드는 env 파일(config.js 가 읽는다)',
  'settings-owners.txt': '설정 소유 계정 목록(routes/admin/shared.js requireSettingsOwner)',
  'db-location.json': 'DB 저장 디렉터리 설정(insights/dbLocation.js)',
  'ping-targets.json': 'Ping 감시 대상 등록부(ping/store.js — 사용자가 손으로 등록, v2.580 손상 보존). v2.614 첫 목 실행에서 미분류로 잡혀 등재',
  'initial-admin-password.txt': '첫 관리자 임시 비밀번호(auth/auth.js — 0600, 비밀번호를 바꾸면 지운다). v2.614 첫 목 실행에서 미분류로 잡혀 여기 등재',
});

/* ── 공용 ─────────────────────────────────────────────────────────────────────── */
const t = (v) => String(v ?? '').trim();
const uniq = (a) => [...new Set(a)];
const joinPath = (mount, p) => {
  const m = t(mount).replace(/\/+$/u, '');
  const s = String(p || '/');
  return `${m}${s.startsWith('/') ? '' : '/'}${s}`.replace(/\/{2,}/g, '/') || '/';
};

/**
 * 주석 제거(상태 기계) — `test/_stripComments.js` 와 **같은 규칙**이다(테스트가 두 구현의 출력을 대조한다). 배포 패키지는
 * server/src 만 담으므로(packaging/offline/build-package.sh) 테스트 디렉터리를 런타임에 import 할 수 없어 여기 둔다.
 * 개행은 보존하고 주석 문자는 지운다(공백으로 채우지 않는다 — 거리 창을 쓰는 스윕과 같은 형태를 유지).
 */
const BLANK = (s) => s.replace(/[^\n]/g, '');
const REGEX_OK_BEFORE = /[([{;,:=!&|?+\-*%~^<>]$/;
export function stripComments(src) {
  const s = String(src ?? '');
  let out = '';
  let i = 0;
  let prev = '';
  while (i < s.length) {
    const c = s[i]; const d = s[i + 1];
    if (c === '/' && d === '*') {
      const end = s.indexOf('*/', i + 2);
      const stop = end === -1 ? s.length : end + 2;
      out += BLANK(s.slice(i, stop)); i = stop; continue;
    }
    if (c === '/' && d === '/') {
      let end = s.indexOf('\n', i);
      if (end === -1) end = s.length;
      out += BLANK(s.slice(i, end)); i = end; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === c) { j += 1; break; }
        j += 1;
      }
      out += s.slice(i, j); prev = c; i = j; continue;
    }
    if (c === '/' && REGEX_OK_BEFORE.test(prev)) {
      let j = i + 1; let cls = false; let ok = false;
      while (j < s.length) {
        const ch = s[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '\n') break;
        if (ch === '[') cls = true;
        else if (ch === ']') cls = false;
        else if (ch === '/' && !cls) { j += 1; ok = true; break; }
        j += 1;
      }
      if (ok) { out += s.slice(i, j); prev = '/'; i = j; continue; }
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out;
}

/* ── app 주입(마운트 게이트 · BIG_JSON) ────────────────────────────────────────── */
let _app = null;
/** index.js 가 라우터 마운트 뒤 1회 부른다. 테스트는 합성 express app 을 넣는다. */
export function setApp(app) { _app = app || null; }
export function _appInjected() { return !!_app; }

/** express 4 `app.use('/api/admin', …)` 레이어의 regexp → 마운트 경로. 못 읽으면 null(추측하지 않는다). */
export function mountPathOf(layer) {
  const re = layer?.regexp;
  if (!re) return null;
  if (re.fast_slash) return '/';
  const src = String(re.source || '');
  const m = src.match(/^\^((?:\\\/[A-Za-z0-9_.\-~]*)+)\\\/\?\(\?=\\\/\|\$\)$/);
  if (!m) return null;
  return m[1].replace(/\\\//g, '/') || '/';
}

/**
 * app 의 최상위 레이어를 읽는다 — {mount, handle, gate, isRouter}. 라우터(`handle.stack` 배열)와 마운트 게이트(`handle.gate`)와
 * BIG_JSON(`bigJsonGate` 가 돌려주는 함수 이름 `gate`)을 구분한다.
 * ⚠ BIG_JSON 판정은 **함수 이름**(`gate`)에 기댄다 — `util/bigJsonGate.js` 가 돌려주는 함수의 이름이다. 바뀌면 이 판정이
 *   '등록 0건' 으로 떨어지고 bigjson-missing 이 전부 warn 이 된다(테스트가 이름을 고정한다).
 */
export function appLayers(app = _app) {
  const stack = app?._router?.stack || app?.router?.stack || [];
  const out = [];
  for (const layer of stack) {
    const handle = layer?.handle;
    if (typeof handle !== 'function') continue;
    out.push({
      mount: mountPathOf(layer),
      handle,
      gate: handle.gate || null,
      isRouter: Array.isArray(handle.stack),
      isBigJson: handle.name === 'gate' && !handle.gate && !Array.isArray(handle.stack), // 게이트 태그가 있는 함수는 BIG_JSON 이 아니다
      name: handle.name || '',
    });
  }
  return out;
}

/* ── 라우터 스택 순회 ─────────────────────────────────────────────────────────── */
/**
 * 라우터 하나의 라우트 목록. 라우터 수준 미들웨어(`router.use(path, gate)`)의 게이트는 그 뒤에 등록된 라우트 중 경로 접두가
 * 맞는 것에 붙는다(`api.use('/tools', toolGate)` · `capacityRouter.use(adminOnly)`).
 * @returns {Array<{router:string,mount:string,path:string,full:string,method:string,handles:Function[],gates:object[]}>}
 */
export function routesOf({ name, mount, router, mountGates = [] }) {
  const out = [];
  const useGates = []; // [{prefix, gate}] — 등록 순서
  for (const layer of router?.stack || []) {
    const r = layer?.route;
    if (!r) {
      const h = layer?.handle;
      if (typeof h === 'function' && h.gate && !Array.isArray(h.stack)) {
        const prefix = mountPathOf(layer);
        useGates.push({ prefix: prefix == null ? '/' : prefix, gate: h.gate });
      }
      continue;
    }
    const paths = Array.isArray(r.path) ? r.path : [r.path];
    const methods = Object.keys(r.methods || {}).filter((m) => r.methods[m]);
    const handles = (r.stack || []).map((h) => h?.handle).filter((fn) => typeof fn === 'function');
    for (const p0 of paths) {
      const p = String(p0);
      const inherited = useGates.filter((u) => u.prefix === '/' || p === u.prefix || p.startsWith(`${u.prefix}/`)).map((u) => u.gate);
      for (const m of methods) {
        out.push({
          router: name, mount, path: p, full: joinPath(mount, p), method: m.toUpperCase(), handles,
          gates: [...mountGates, ...inherited, ...handles.map((h) => h.gate).filter(Boolean)],
        });
      }
    }
  }
  return out;
}

const hasGate = (route, pred) => (route.gates || []).some(pred);
const isAdminGated = (route) => hasGate(route, (g) => g.kind === 'role' && Array.isArray(g.arg) && g.arg.length === 1 && g.arg[0] === 'admin');
const hasFullScope = (route) => hasGate(route, (g) => g.kind === 'fullScope' || g.kind === 'settingsOwner');

/** 라우터 목록 조립 — 주입된 라우터(라우트 파일이 넘긴 것) + app 에서 발견한 라우터·마운트 게이트. */
function routerEntries(routers, layers) {
  const byMount = new Map();
  for (const r of routers || []) {
    if (!r?.router || !Array.isArray(r.router.stack)) continue;
    byMount.set(t(r.mount) || '/', { name: t(r.name) || t(r.mount), mount: t(r.mount) || '/', router: r.router, mountGates: [] });
  }
  if (layers) {
    // 같은 마운트 경로에 앞서 붙은 게이트가 그 라우터의 마운트 게이트다(index.js 의 `app.use('/api/insights', auth, enrolled, requirePerm, router)`).
    const pendingGates = new Map(); // mount → gates
    for (const L of layers) {
      if (L.mount == null) continue;
      if (L.isRouter) {
        const gates = pendingGates.get(L.mount) || [];
        pendingGates.delete(L.mount);
        const known = byMount.get(L.mount);
        if (known && known.router === L.handle) known.mountGates = gates;
        else if (!known) byMount.set(L.mount, { name: L.mount, mount: L.mount, router: L.handle, mountGates: gates });
        // 같은 마운트 경로에 라우터가 둘이면(드물다) 첫 것만 — 두 번째는 이름을 바꿔 둔다.
        else if (known.router !== L.handle) byMount.set(`${L.mount}#${byMount.size}`, { name: `${L.mount}#2`, mount: L.mount, router: L.handle, mountGates: gates });
      } else if (L.gate) {
        pendingGates.set(L.mount, [...(pendingGates.get(L.mount) || []), L.gate]);
      }
    }
  }
  return [...byMount.values()];
}

/* ── 입력 수집 ────────────────────────────────────────────────────────────────── */
async function safeAsync(errors, code, fn) {
  try { return await fn(); } catch (e) { errors.push({ code, message: String(e?.message || e).slice(0, 200) }); return undefined; }
}
function safe(errors, code, fn) {
  try { return fn(); } catch (e) { errors.push({ code, message: String(e?.message || e).slice(0, 200) }); return undefined; }
}

/** 카탈로그 리더는 다른 모듈(`toolCatalog.js`)이다 — 없거나 던지면 `missing` 이지 추측하지 않는다. */
async function readCatalog(errors) {
  try {
    const mod = await import('./toolCatalog.js');
    const c = await mod.readToolCatalog();
    if (!c || c.source !== 'dist' || !Array.isArray(c.tools)) {
      return { source: 'missing', tools: [], count: 0, generatedAt: null, path: c?.path || null, reason: c?.reason || 'special-tools.json 을 읽지 못했습니다' };
    }
    return { source: 'dist', tools: c.tools, count: Number(c.count) || c.tools.length, generatedAt: c.generatedAt ?? null, path: c.path || null };
  } catch (e) {
    errors.push({ code: 'catalog', message: String(e?.message || e).slice(0, 200) });
    return { source: 'missing', tools: [], count: 0, generatedAt: null, path: null, reason: 'catalog reader unavailable' };
  }
}

/** edgelog STATUS_SPEC 의 모듈·함수 실재 여부 — 모듈 없음(ERR_MODULE_NOT_FOUND)만 '표류' 이고 다른 import 오류는 판정 보류. */
async function checkEdgelogSpec() {
  const drift = []; const errors = [];
  for (const s of STATUS_SPEC) {
    const url = new URL(s.mod, import.meta.url);
    try {
      const mod = await import(url.href);
      if (typeof mod?.[s.fn] !== 'function') drift.push(`${s.key} → ${s.mod}#${s.fn} (export 없음)`);
    } catch (e) {
      if (e?.code === 'ERR_MODULE_NOT_FOUND' && String(e?.message || '').includes(path.basename(s.mod))) drift.push(`${s.key} → ${s.mod} (모듈 없음)`);
      else errors.push({ code: 'edgelog', message: `${s.key}: ${String(e?.message || e).slice(0, 160)}` });
    }
  }
  return { total: STATUS_SPEC.length, drift, errors };
}

/** dbDir 의 DB 파일 나열(하위 vmperf/·vmseries/ 포함) — {name, rel, abs, mode}. */
function listDbFiles(dir) {
  const out = [];
  const isDb = (n) => /\.db(-wal|-shm)?$/i.test(n);
  const push = (abs, rel) => {
    const st = fs.statSync(abs);
    if (!st.isFile()) return;
    out.push({ name: path.basename(abs), rel, abs, mode: st.mode & 0o777, top: !rel.includes('/') });
  };
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && isDb(e.name)) push(path.join(dir, e.name), e.name);
  }
  for (const d of MIGRATABLE_DIRS) {
    const sub = path.join(dir, d.dir);
    if (!fs.existsSync(sub)) continue;
    for (const e of fs.readdirSync(sub, { withFileTypes: true })) if (e.isFile() && isDb(e.name)) push(path.join(sub, e.name), `${d.dir}/${e.name}`);
  }
  return out;
}

/** CONFIG_DIR 의 최상위 설정 후보 파일(*.json/*.env/*.txt) — 예제·손상 보존본은 뺀다. */
function listConfigFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const n = e.name;
    if (!/\.(json|env|txt)$/i.test(n)) continue;
    if (/\.example\.json$/i.test(n) || /\.corrupt\./i.test(n)) continue;
    out.push(n);
  }
  return out.sort();
}

/** server/src 정적 import 그래프 — arch2579.test.js 와 같은 규칙(vendor 제외 · export … from 포함 · 동적 import 포함). */
export function buildImportGraph(root = SRC_ROOT) {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); } else if (p.endsWith('.js')) files.push(p);
    }
  })(root);
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');
  const edges = new Map();
  for (const f of files) {
    const out = [];
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    for (const m of code.matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      let target = path.resolve(path.dirname(f), m[1] || m[2]);
      if (!target.endsWith('.js')) target = fs.existsSync(`${target}.js`) ? `${target}.js` : path.join(target, 'index.js');
      if (fs.existsSync(target)) out.push(rel(target));
    }
    edges.set(rel(f), uniq(out));
  }
  return edges;
}

/** Tarjan SCC — 크기 2 이상만. */
export function cyclesOf(edges) {
  let idx = 0; const st = []; const on = new Set(); const index = new Map(); const low = new Map(); const sccs = [];
  const sc = (v) => {
    index.set(v, idx); low.set(v, idx); idx += 1; st.push(v); on.add(v);
    for (const w of edges.get(v) || []) {
      if (!index.has(w)) { sc(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) { const c = []; let w; do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v); if (c.length > 1) sccs.push(c.sort()); }
  };
  for (const f of edges.keys()) if (!index.has(f)) sc(f);
  return sccs;
}

/**
 * 입력 수집 — 각 입력은 독립이다(하나가 실패해도 나머지는 온다). 실패는 `errors` 에 남고 판정이 그 항목을 unknown 으로 둔다.
 * @param {object} o
 * @param {Array<{name:string,mount:string,router:any}>} [o.routers] 라우트 파일이 넘기는 라우터(api·admin·central·collector)
 * @param {Array<{side:string,method:string,path:string}>} [o.flowRoutes] dataflow 용 선언 경로(routes/api/dataFlow.js declaredRoutes)
 */
export async function gatherArchInputs({ routers = [], flowRoutes = null, app = _app, dbDir = null, configDir = null } = {}) {
  const errors = [];
  const layers = app ? safe(errors, 'app', () => appLayers(app)) : null;
  const entries = safe(errors, 'routers', () => routerEntries(routers, layers)) || [];
  const routes = safe(errors, 'routes', () => entries.flatMap((e) => routesOf(e))) || [];
  const bigJsonMounts = layers ? uniq(layers.filter((L) => L.isBigJson && L.mount).map((L) => L.mount)) : null;
  const catalog = await readCatalog(errors);
  const edgelog = await safeAsync(errors, 'edgelog', () => checkEdgelogSpec());
  for (const e of (edgelog?.errors || [])) errors.push(e); // 전개 push 금지(v2.603 CEN2603-03 스윕) — 작은 배열이지만 규약대로
  const dDir = dbDir || config.dbDir || config.configDir;
  const cDir = configDir || config.configDir;
  const dbFiles = process.platform === 'win32'
    ? (errors.push({ code: 'db-mode', message: 'Windows 에서는 POSIX 파일 모드를 읽을 수 없습니다' }), safe(errors, 'db-files', () => listDbFiles(dDir).map((f) => ({ ...f, mode: null }))))
    : safe(errors, 'db-files', () => listDbFiles(dDir));
  const configFiles = safe(errors, 'config-files', () => listConfigFiles(cDir));
  const toolKeys = safe(errors, 'tool-keys', () => ({
    roleDenied: Object.fromEntries(ROLES.filter((r) => r !== 'admin').map((r) => [r, roleToolsDenied(r)])),
    users: userToolOverrides(),
    toolcats: (loadToolCats()?.categories || []).map((c) => ({ id: c.id, tools: c.tools || [] })),
    preset: PRESET.map((c) => ({ id: c.id, tools: c.tools || [] })),
  }));
  const graph = safe(errors, 'import-graph', () => buildImportGraph());
  const flow = flowRoutes ? safe(errors, 'dataflow', () => buildDataFlow({ routes: flowRoutes })) : null;
  if (!flowRoutes) errors.push({ code: 'dataflow', message: 'dataflow 선언 경로가 주입되지 않았습니다' });
  if (!app) errors.push({ code: 'app', message: 'app 이 주입되지 않았습니다(setApp) — 마운트 게이트·BIG_JSON 등록을 읽을 수 없습니다' });
  return {
    at: Date.now(), routes, bigJsonMounts, catalog, edgelog, dbFiles, dbDir: dDir, configFiles, configDir: cDir, toolKeys, graph,
    flowUnmapped: flow ? flow.unmapped || [] : null, appInjected: !!app, errors,
  };
}

/* ── 판정 ────────────────────────────────────────────────────────────────────── */
function item(code, list, { unknown = false, detail = {}, faultIf = null } = {}) {
  if (unknown) return { code, state: 'unknown', count: 0, samples: [], omitted: 0, detail };
  const arr = list || [];
  const bad = faultIf ? faultIf(arr.length) : arr.length > 0;
  const state = !bad ? 'ok' : (FAULT_CODES.has(code) ? 'fault' : 'warn');
  return { code, state, count: arr.length, samples: arr.slice(0, SAMPLE_MAX), omitted: Math.max(0, arr.length - SAMPLE_MAX), detail };
}

const segOf = (p) => t(p).split('/').filter(Boolean)[1] || '';
const normSeg = (s) => t(s).toLowerCase().replace(/\.[a-z0-9]+$/i, '');
const catalogKeys = (catalog) => new Set((catalog?.tools || []).map((x) => t(x?.k)).filter(Boolean));

/** 순수 판정 — 입력 모양은 gatherArchInputs 참조. */
export function scanArch(inputs) {
  const errors = [...(inputs?.errors || [])];
  const failed = new Set(errors.map((e) => e.code));
  const routes = inputs?.routes || [];
  const items = [];

  // ① route-gate-missing
  {
    const bad = []; const allowed = [];
    for (const r of routes) {
      if (!MUTATING.has(r.method)) continue;
      if (!(r.full.startsWith('/api/admin/') || r.full.startsWith('/api/tools/'))) continue;
      if (!isAdminGated(r) || hasFullScope(r)) continue;
      const key = `${r.method} ${r.full}`;
      if (ROUTE_GATE_ALLOW[key]) allowed.push(key); else bad.push(key);
    }
    const unknownAllow = Object.keys(ROUTE_GATE_ALLOW).filter((k) => !routes.some((r) => `${r.method} ${r.full}` === k));
    items.push(item('route-gate-missing', bad, {
      unknown: failed.has('routes') || !routes.length,
      detail: { checked: routes.filter((r) => MUTATING.has(r.method) && isAdminGated(r)).length, allowed: allowed.length, allowlistStale: unknownAllow, mountGates: inputs?.appInjected ? 'app' : 'injected-only' },
    }));
  }
  // ② asyncroute-unwrapped
  items.push(item('asyncroute-unwrapped',
    routes.flatMap((r) => (r.handles || []).some((h) => h?.constructor?.name === 'AsyncFunction' && !h.__asyncWrapped) ? [`${r.method} ${r.full}`] : []),
    { unknown: failed.has('routes') || !routes.length, detail: { routers: uniq(routes.map((r) => r.router)) } }));
  // ③ tool-segment-unmapped
  {
    const segs = uniq(routes.filter((r) => r.full.startsWith('/api/tools/')).map((r) => normSeg(segOf(r.full.slice(4)))).filter((s) => s && !s.startsWith(':')));
    const p2 = new Set(Object.keys(TOOL_PATH2_KEYS).map((k) => k.split('/')[0]));
    const bad = segs.filter((s) => !TOOL_PATH_KEYS[s] && !p2.has(s) && !UNMAPPED_TOOL_SEGMENTS[s]);
    items.push(item('tool-segment-unmapped', bad, { unknown: failed.has('routes') || !routes.length, detail: { segments: segs.length } }));
  }
  // ④ catalog-missing
  const catalog = inputs?.catalog || { source: 'missing', tools: [] };
  const catMissing = catalog.source !== 'dist';
  items.push(item('catalog-missing', [], { unknown: catMissing, detail: { source: catalog.source, count: catalog.count || 0, reason: catMissing ? (catalog.reason || '') : '' } }));
  const keys = catalogKeys(catalog);
  // ⑤ catalog-key-orphan
  {
    const tk = inputs?.toolKeys;
    const bad = [];
    if (!catMissing && tk) {
      for (const [role, list] of Object.entries(tk.roleDenied || {})) for (const k of list || []) if (!keys.has(k)) bad.push(`permissions.toolsDenied.${role}:${k}`);
      for (const [u, o] of Object.entries(tk.users || {})) for (const k of o?.tools || []) if (!keys.has(k)) bad.push(`permissions.users.${u}:${k}`);
      for (const c of tk.toolcats || []) for (const k of c.tools || []) if (!keys.has(k)) bad.push(`toolcats.${c.id}:${k}`);
      for (const c of tk.preset || []) for (const k of c.tools || []) if (!keys.has(k)) bad.push(`toolcats.preset.${c.id}:${k}`);
      for (const [seg, k] of Object.entries(TOOL_PATH_KEYS)) if (!keys.has(k)) bad.push(`TOOL_PATH_KEYS.${seg}:${k}`);
      for (const [seg, k] of Object.entries(TOOL_PATH2_KEYS)) if (!keys.has(k)) bad.push(`TOOL_PATH2_KEYS.${seg}:${k}`);
      for (const [p, k] of Object.entries(TOOL_EXACT_PATHS)) if (!keys.has(k)) bad.push(`TOOL_EXACT_PATHS.${p}:${k}`);
    }
    items.push(item('catalog-key-orphan', uniq(bad), { unknown: catMissing || failed.has('tool-keys') || !tk, detail: { catalogKeys: keys.size } }));
  }
  // ⑥ catalog-adminonly-mismatch — 주 라우트(`GET /api/tools/<seg>`)가 있는 도구만 판정.
  //    ⚠ 한 방향만 warn 이다: 라우트가 admin 인데 카탈로그가 adminOnly:false 면 viewer 에게 '열 수 있는 카드' 로 보이고 열면 403 이다
  //    (v2.613 CATALOG2613-01 웹 테스트와 같은 규칙). 반대(카탈로그 adminOnly:true 인데 라우트는 tools+fullScope)는 v2.555 가 '표시
  //    관례' 로 확정한 구성(스토리지·파트 장애·PDU·SAN …)이라 결함이 아니다 — `detail.displayOnly` 로 개수·목록만 밝힌다.
  {
    const bad = []; const displayOnly = []; let judged = 0; let notJudged = 0;
    if (!catMissing && routes.length) {
      const gets = new Map(routes.filter((r) => r.method === 'GET' && r.full.startsWith('/api/tools/')).map((r) => [r.full.toLowerCase(), r]));
      for (const tool of catalog.tools || []) {
        const k = t(tool?.k); if (!k) continue;
        const segs = uniq([k, ...Object.entries(TOOL_PATH_KEYS).filter(([, v]) => v === k).map(([s]) => s)]);
        const r = segs.map((s) => gets.get(`/api/tools/${s}`)).find(Boolean);
        if (!r) { notJudged += 1; continue; }
        judged += 1;
        const admin = isAdminGated(r);
        if (admin && !tool.adminOnly) bad.push(`${k}: catalog adminOnly=false · route ${r.method} ${r.full} admin=true`);
        else if (!admin && tool.adminOnly) displayOnly.push(`${k}: ${r.method} ${r.full}`);
      }
    }
    items.push(item('catalog-adminonly-mismatch', bad, { unknown: catMissing || failed.has('routes') || !routes.length, detail: { judged, notJudged, displayOnly: displayOnly.length, displayOnlySamples: displayOnly.slice(0, 20) } }));
  }
  // ⑦ edgelog-spec-drift
  {
    const e = inputs?.edgelog;
    items.push(item('edgelog-spec-drift', e?.drift || [], { unknown: !e || (e.errors?.length > 0), detail: { total: e?.total || STATUS_SPEC.length, importErrors: e?.errors?.length || 0 } }));
  }
  // ⑧ bigjson-missing
  {
    const mounts = inputs?.bigJsonMounts;
    const bad = []; const allowed = [];
    if (Array.isArray(mounts)) {
      for (const r of routes) {
        if (r.method !== 'POST') continue;
        const side = r.full.startsWith('/api/central/') ? 'central' : r.full.startsWith('/api/collector/') ? 'collector' : null;
        if (!side) continue;
        const reg = mounts.some((m) => r.full === m || r.full.startsWith(`${m}/`));
        if (reg) continue;
        const key = `${side}:${r.path}`;
        if (BIG_JSON_SMALL[key]) allowed.push(key); else bad.push(key);
      }
    }
    items.push(item('bigjson-missing', bad, { unknown: !Array.isArray(mounts) || failed.has('routes'), detail: { registered: mounts?.length ?? null, allowed: allowed.length } }));
  }
  // ⑨ dataflow-cats-unmapped
  items.push(item('dataflow-cats-unmapped', inputs?.flowUnmapped || [], { unknown: !Array.isArray(inputs?.flowUnmapped) }));
  // ⑩ db-file-mode · db-not-migratable · db-no-purpose
  {
    const files = inputs?.dbFiles;
    const modeUnknown = !Array.isArray(files) || failed.has('db-mode');
    items.push(item('db-file-mode', modeUnknown ? [] : files.filter((f) => f.mode !== null && f.mode !== 0o600).map((f) => `${f.rel} (0${f.mode.toString(8)})`),
      { unknown: modeUnknown, detail: { files: files?.length ?? 0, dir: inputs?.dbDir || '' } }));
    const mig = new Set(MIGRATABLE.map((m) => m.file));
    items.push(item('db-not-migratable', Array.isArray(files) ? files.filter((f) => f.top && /\.db$/i.test(f.name) && !mig.has(f.name) && !DB_MIGRATE_EXCLUDED[f.name]).map((f) => f.name) : [],
      { unknown: !Array.isArray(files), detail: { excluded: Object.keys(DB_MIGRATE_EXCLUDED) } }));
    const noPurpose = [...MIGRATABLE.map((m) => m.file), ...RUNTIME_STATE_NAMES].filter((n) => !PURPOSES[n]);
    items.push(item('db-no-purpose', uniq(noPurpose), { detail: { checked: MIGRATABLE.length + RUNTIME_STATE_NAMES.size } }));
  }
  // ⑪ config-file-unclassified
  {
    const files = inputs?.configFiles;
    const secret = new Set(SECRET_FILES);
    const bad = Array.isArray(files) ? files.filter((n) => !(secret.has(n) || isRuntimeStateFile(n) || PURPOSES[n] || KNOWN_CONFIG_FILES[n])) : [];
    items.push(item('config-file-unclassified', bad, {
      unknown: !Array.isArray(files),
      // ⚠ 정직 기록: 런타임에는 docs/CONFIG-FILES.md(생성 문서) 카탈로그가 없다 — 설정 분류의 원천은 PURPOSES + SECRET_FILES +
      //   KNOWN_CONFIG_FILES 뿐이다. 그 밖의 파일이 '미분류' 로 보이면 문서 카탈로그를 런타임 모듈로 옮기는 것이 조치다.
      detail: { files: files?.length ?? 0, dir: inputs?.configDir || '', classifier: 'SECRET_FILES+isRuntimeStateFile+PURPOSES+KNOWN_CONFIG_FILES' },
    }));
  }
  // ⑫ import-cycle · util-imports-domain
  {
    const g = inputs?.graph;
    if (g instanceof Map) {
      const sccs = cyclesOf(g);
      items.push(item('import-cycle', sccs.map((c) => c.join(' <-> ')), { faultIf: (n) => n > IMPORT_CYCLE_MAX, detail: { max: IMPORT_CYCLE_MAX, files: g.size } }));
      const bad = [];
      for (const [f, deps] of g) {
        if (!f.startsWith('util/')) continue;
        for (const d of deps) if (!(d.startsWith('util/') || d === 'config.js' || UTIL_ALLOW[d])) bad.push(`${f} -> ${d}`);
      }
      items.push(item('util-imports-domain', bad, { detail: { allow: Object.keys(UTIL_ALLOW) } }));
    } else {
      items.push(item('import-cycle', [], { unknown: true }));
      items.push(item('util-imports-domain', [], { unknown: true }));
    }
  }

  const kpi = { total: items.length, ok: 0, warn: 0, fault: 0, unknown: 0 };
  for (const it of items) kpi[it.state] += 1;
  return {
    kpi, items,
    catalog: { source: catalog.source, count: catalog.count || 0, generatedAt: catalog.generatedAt ?? null, path: catalog.path || null },
    inputs: { errors, appInjected: !!inputs?.appInjected, at: inputs?.at || Date.now() },
  };
}

/**
 * 응답의 절대 경로를 역할에 맞게 접는다 — admin 전체범위 계정만 절대 경로(`scopeFilePaths` 규약). 다른 계정은 basename.
 * (라우트 게이트가 admin 전체범위만 통과시키므로 실제로는 인증 비활성 배포의 대체 역할이 이 분기를 탄다.)
 */
export function scopeArchPaths(result, user) {
  if (!result || user?.role === 'admin') return result;
  const base = (p) => (typeof p === 'string' && p ? (p.split(/[\\/]/).filter(Boolean).pop() || null) : p);
  const out = { ...result, catalog: { ...result.catalog, path: base(result.catalog?.path) }, pathHidden: true };
  out.items = (result.items || []).map((it) => {
    const d = it.detail || {};
    return { ...it, detail: { ...d, ...(d.dir ? { dir: base(d.dir) } : {}) } };
  });
  return out;
}
