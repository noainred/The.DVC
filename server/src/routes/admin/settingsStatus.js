/**
 * routes/admin/settingsStatus.js — 설정 메뉴 상태 배지 API(v2.916, 설계 docs/design/settings-menu §4.4).
 *
 *   GET /settings/status → { ok, at, items: { [설정 하위 키]: { grade: unset|off|warn|new|unknown, text, count? } } }
 *
 * 권한: **adminOnly + requireSettingsOwner**(설정 소유자 ∧ 전체 범위). 배지는 SMTP 유무 · 비밀 저장 방식 · 정기 백업 여부처럼
 *   항목별 원 라우트가 소유자 등급으로 가리는 값의 **요약**이라(불리언도 정보다) 가장 엄격한 공통 등급으로 묶는다. 슈퍼 관리자 전용 항목
 *   (아이실론)은 isSuperAdmin 일 때만 싣는다. 범위가 지정된 소유자는 403 — 화면은 배지 없이 목록만 그린다.
 * 비용: 파일 · 메모리 값만(sources.js 규약 — 외부 호출 · SQLite 0). 설정 화면이 60초마다 · 항목을 옮길 때 다시 부르므로
 *   memoJson(5초 · 스냅샷 세대 + 슈퍼 여부 키)으로 같은 순간의 중복 계산만 합친다 — 저장 직후 배지가 최대 5초 늦을 수 있다(화면에 '다시 읽기').
 */
import { adminOnly, requireSettingsOwner } from './shared.js';
import { memoJson } from '../api/shared.js';
import { isSuperAdmin } from '../../auth/roles.js';
import { buildSettingsStatus } from '../../settingsStatus/grade.js';
import { settingsStatusSources } from '../../settingsStatus/sources.js';

export function registerSettingsStatus(adminRouter) {
  adminRouter.get('/settings/status', adminOnly, requireSettingsOwner, (req, res) => {
    const superAdmin = isSuperAdmin(req.user);
    return memoJson(req, res, 'settings-status', () => {
      const { items } = buildSettingsStatus(settingsStatusSources(), { superAdmin });
      return { ok: true, at: new Date().toISOString(), items };
    }, { ttlMs: 5_000, extraKey: superAdmin ? 'super' : 'admin' });
  });
}
