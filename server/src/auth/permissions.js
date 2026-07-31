import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

// ─────────────────────────────────────────────────────────────────────────────
// 기능별 권한(Permission) 프레임워크 — "모든 기능에 대해 역할별 권한을 켜고 끈다".
//
// 설계(A안): 역할은 admin/operator/viewer 3개로 고정하되, "역할 → 기능 권한 키 집합"을
// 편집 가능한 매트릭스(permissions.json)로 관리한다. 서버가 진실의 원천이며(requirePerm),
// 프론트는 /api/auth/me 가 내려주는 '내 권한 목록'으로 메뉴/버튼을 노출만 한다.
//   - admin 은 항상 모든 권한을 가진다(매트릭스로 낮출 수 없음 — 관리자 잠김 방지).
//   - operator/viewer 행만 편집 가능.
// 회귀 방지: 기본 매트릭스는 기존 role 동작과 동일(operator=쓰기 가능, viewer=읽기 전용)하게
// 맞춰, 이 기능 도입만으로 권한이 바뀌지 않게 한다.
// ─────────────────────────────────────────────────────────────────────────────

export const ROLES = ['admin', 'operator', 'viewer'];

// 기능 권한 카탈로그 — key(내부 식별), label(표시), group(UI 묶음).
// 새 기능을 권한으로 통제하려면 여기에 key 를 추가하고, 라우트에 requirePerm(key),
// 프론트 탭/버튼에 hasPerm(key) 게이트를 걸면 된다.
export const PERMISSION_CATALOG = [
  // 대시보드(기본 열람)
  { key: 'dashboard', label: '대시보드·요약·플랫폼·탐색', group: '대시보드' },
  // 인벤토리(조회)
  { key: 'inv.hosts', label: '호스트', group: '인벤토리' },
  { key: 'inv.vms', label: '가상머신', group: '인벤토리' },
  { key: 'inv.datastores', label: '스토리지', group: '인벤토리' },
  { key: 'inv.networks', label: '네트워크', group: '인벤토리' },
  { key: 'inv.nsx', label: 'NSX', group: '인벤토리' },
  { key: 'inv.alarms', label: '알람(음소거 포함)', group: '인벤토리' },
  // 도구·분석
  { key: 'tools', label: '특수 기능(IPAM·핑·검색 등)', group: '도구·분석' },
  { key: 'insights', label: '인사이트(FinOps·이상탐지 등)', group: '도구·분석' },
  // 원격·작업(상태 변경)
  { key: 'remote.access', label: '원격 접속(SSH/RDP/콘솔)', group: '원격·작업' },
  { key: 'vm.reconfig', label: 'VM 재구성·툴 업그레이드', group: '원격·작업' },
  { key: 'vm.provision', label: 'VM 프로비저닝', group: '원격·작업' },
  { key: 'guest.deploy', label: '게스트 계정 배포', group: '원격·작업' },
  // 관리(고권한)
  { key: 'settings', label: '설정', group: '관리' },
  { key: 'upgrade', label: '업그레이드', group: '관리' },
  { key: 'users.manage', label: '사용자·권한 관리', group: '관리' },
];

export const ALL_PERMISSION_KEYS = PERMISSION_CATALOG.map((p) => p.key);
const CATALOG_SET = new Set(ALL_PERMISSION_KEYS);

// 기본 매트릭스(admin 은 항상 전체라 매트릭스에 담지 않는다).
//   operator: 조회 + 도구/분석 + 원격·작업(상태 변경) — 기존 requireRole('admin','operator') 동작과 동일.
//   viewer  : 조회 + 인사이트(읽기)만 — 상태 변경 불가.
const DEFAULT_MATRIX = {
  operator: [
    'dashboard', 'inv.hosts', 'inv.vms', 'inv.datastores', 'inv.networks', 'inv.nsx', 'inv.alarms',
    'tools', 'insights', 'remote.access', 'vm.reconfig', 'vm.provision', 'guest.deploy',
  ],
  viewer: [
    'dashboard', 'inv.hosts', 'inv.vms', 'inv.datastores', 'inv.networks', 'inv.nsx', 'inv.alarms',
    'insights',
  ],
};

function matrixFile() {
  return path.join(config.configDir, 'permissions.json');
}

let cached = null;

function sanitizeRow(arr) {
  // 카탈로그에 없는 키는 버리고, 중복 제거.
  return [...new Set((Array.isArray(arr) ? arr : []).filter((k) => CATALOG_SET.has(k)))];
}

function defaultMatrix() {
  return { operator: [...DEFAULT_MATRIX.operator], viewer: [...DEFAULT_MATRIX.viewer] };
}

/** 편집 가능한 역할→권한 매트릭스 로드(operator/viewer 만). admin 은 항상 전체. */
export function loadMatrix() {
  if (cached) return cached;
  const file = matrixFile();
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const m = parsed && typeof parsed === 'object' ? (parsed.matrix || parsed) : {};
      cached = {
        operator: sanitizeRow(m.operator ?? DEFAULT_MATRIX.operator),
        viewer: sanitizeRow(m.viewer ?? DEFAULT_MATRIX.viewer),
      };
      return cached;
    } catch (err) {
      // 손상 파일을 조용히 기본값으로 덮어쓰면 다음 저장이 원본을 잃는다 → .corrupt 로 보존.
      preserveCorrupt(file, err.message);
      console.error(`[perm] permissions.json 파싱 실패: ${err.message}`);
    }
  }
  cached = defaultMatrix();
  return cached;
}

function persistMatrix() {
  atomicWriteFileSync(matrixFile(), JSON.stringify({ matrix: cached }, null, 2), { mode: 0o600 });
}

/** operator/viewer 두 행을 저장(부분 갱신 허용). admin 행은 무시된다(항상 전체). */
export function saveMatrix(next = {}) {
  const cur = loadMatrix();
  cached = {
    operator: next.operator !== undefined ? sanitizeRow(next.operator) : cur.operator,
    viewer: next.viewer !== undefined ? sanitizeRow(next.viewer) : cur.viewer,
  };
  persistMatrix();
  return cached;
}

/** 기본값으로 초기화. */
export function resetMatrix() {
  cached = defaultMatrix();
  persistMatrix();
  return cached;
}

/** 역할이 가진 권한 키 집합(Set). admin → 전체. */
export function rolePermissionSet(role) {
  if (role === 'admin') return new Set(ALL_PERMISSION_KEYS);
  const m = loadMatrix();
  return new Set(role === 'operator' ? m.operator : role === 'viewer' ? m.viewer : []);
}

/** 역할의 권한 키 배열(프론트 노출용). */
export function rolePermissions(role) {
  return [...rolePermissionSet(role)];
}

/** 사용자(req.user) 가 특정 권한을 가지는지. */
export function userHasPermission(user, key) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return rolePermissionSet(user.role).has(key);
}
