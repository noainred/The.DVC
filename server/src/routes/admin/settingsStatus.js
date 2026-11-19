/**
 * routes/admin/settingsStatus.js — 설정 메뉴 상태 배지 API(v2.916, 설계 docs/design/settings-menu §4.4).
 *
 *   GET /settings/status → { ok, at, items: { [설정 하위 키]: { grade: unset|off|warn|new|unknown, text, count? } } }
 *
 * 권한: **adminOnly + requireSettingsOwner**(설정 소유자 ∧ 전체 범위). 배지는 SMTP 유무 · 비밀 저장 방식 · 정기 백업 여부처럼
 *   항목별 원 라우트가 소유자 등급으로 가리는 값의 **요약**이라(불리언도 정보다) 가장 엄격한 공통 등급으로 묶는다. 슈퍼 관리자 전용 항목
 *   (아이실론)은 isSuperAdmin 일 때만 싣는다. 범위가 지정된 소유자는 403 — 화면은 배지 없이 목록만 그린다.
 * 비용 · 신선도(v2.916 반증 D1 반영): 설정을 저장한 직후 배지가 바로 맞아야 한다 — memoJson(키 = 스냅샷 세대, ETag = 그 키)은 저장해도 세대가 같으면
 *   304 로 옛 본문을 돌려줘(브라우저 fetch 가 If-None-Match 를 자동으로 붙인다) 다음 폴링 주기까지, 긴급 중단 중에는 그 뒤로도 옛 값이 남았다.
 *   그래서 snapMemo 로 **3초 single-flight 만** 하고(같은 순간 여러 탭의 계산을 합친다) 응답은 `Cache-Control: no-store`(ETag 없음).
 *   '다시 읽기' 버튼은 `?fresh=1` 로 그 3초도 건너뛴다(소유자 전용 · 계산 약 6ms).
 */
import { adminOnly, requireSettingsOwner } from './shared.js';
import { snapMemo } from '../../util/snapCache.js';
import { isSuperAdmin } from '../../auth/roles.js';
import { buildSettingsStatus } from '../../settingsStatus/grade.js';
import { settingsStatusSources } from '../../settingsStatus/sources.js';

const MEMO_MS = 3_000;
const compute = (superAdmin) => {
  const { items } = buildSettingsStatus(settingsStatusSources(), { superAdmin });
  return { ok: true, at: new Date().toISOString(), items };
};

export function registerSettingsStatus(adminRouter) {
  adminRouter.get('/settings/status', adminOnly, requireSettingsOwner, async (req, res) => {
    const superAdmin = isSuperAdmin(req.user);
    const who = superAdmin ? 'super' : 'admin';   // 슈퍼 전용 항목(아이실론)이 일반 소유자 응답에 섞이지 않게 키를 나눈다
    const payload = req.query.fresh === '1' ? compute(superAdmin) : await snapMemo('settings-status', who, MEMO_MS, async () => compute(superAdmin));
    res.set('Cache-Control', 'no-store');
    res.json(payload);
  });
}
