// 설정 › 특수 기능 카테고리 라우트(v2.455) — 도구(현재 79개)를 사용자 정의 카테고리로 묶는다.
//
// 비밀 값이 없는 표시 설정이라 adminOnly 면 충분하다(소유자 게이트 불필요).
// 조회는 로그인 사용자 전체에 열어 둔다 — 특수 기능 화면이 자기 배치를 그리려면 이 값을 읽어야
// 하고, 여기에는 도구 키와 카테고리 이름밖에 없다(권한 판정은 여전히 프론트 toolAllowed +
// 서버 auth/toolAccess 가 한다 — 이 응답이 접근을 넓히지 않는다).
import { requireRole } from '../../auth/auth.js';
import { fullScopeOnlyWith } from './shared.js'; // v2.614: 특수 기능 카테고리 배치는 전 사용자 공통 설정 — 범위 관리자가 바꾸면 다른 법인 화면까지 바뀐다
const fleetOnly = fullScopeOnlyWith('특수 기능 카테고리 배치는 전 사용자 공통 설정이라 전체 범위(vCenter 제한 없는) 관리자만 바꿀 수 있습니다.');
import { logAudit } from '../../audit.js';
import { load as loadCfg, save as saveCfg, presetCategories } from '../../toolcats/settings.js';
import { validate, PRESET } from '../../toolcats/catalog.js';

const adminOnly = requireRole('admin');

export function registerToolCategories(adminRouter) {

  // 조회 — 특수 기능 화면이 매번 읽는다(로그인 사용자면 누구나).
  adminRouter.get('/tool-categories', (_req, res) => {
    res.json({ settings: loadCfg(), presetCount: PRESET.length });
  });

  adminRouter.put('/tool-categories', adminOnly, fleetOnly, (req, res) => {
    const body = req.body || {};
    const errs = validate({ ...loadCfg(), ...body });
    if (errs.length) return res.status(400).json({ ok: false, reason: errs[0], errors: errs });
    const saved = saveCfg(body);
    const tools = saved.categories.reduce((n, c) => n + c.tools.length, 0);
    logAudit({
      user: req.user?.username, action: '특수 기능 카테고리 저장',
      detail: `${saved.enabled ? '사용' : '미사용'} · 카테고리 ${saved.categories.length}개 · 배치 ${tools}건(중복 포함)`,
      ip: req.ip,
    });
    res.json({ ok: true, settings: saved });
  });

  // '추천 분류로 시작' — 프리셋을 돌려주기만 한다. **저장은 하지 않는다**:
  // 관리자가 화면에서 보고 손본 뒤 저장을 눌러야 한다(버튼 한 번에 기존 분류가 날아가면 안 된다).
  adminRouter.get('/tool-categories/preset', adminOnly, (_req, res) => {
    res.json({ ok: true, categories: presetCategories() });
  });
}
