// 설정 › Unity 스토리지 장비 등록 라우트 — Dell EMC Unity(Unisphere) 등록/수정/삭제 +
// **등록 시 API 동작 확인(연결 테스트)**. vCenter 등록의 testConnection 과 같은 사용 흐름.
//
// 전부 adminOnly + 감사로그: 자격증명(Unisphere 계정)을 다루는 상태변경 라우트다.
// SSRF 가드·자격증명 마스킹·원자적 저장은 unity/registry.js 가 소유한다.
import { adminOnly } from './shared.js';
import { logAudit } from '../../audit.js';
import {
  listRegistry as listUnity, addUnity, updateUnity, removeUnity, testConnection as testUnity,
} from '../../unity/registry.js';

export function registerUnity(adminRouter) {

  adminRouter.get('/unity', adminOnly, (_req, res) => {
    res.json({ ok: true, arrays: listUnity() }); // 비밀번호는 redact 되어 hasPassword 만 나간다
  });

  // ⚠️ 정적 라우트('/unity/test')를 파라미터 라우트('/unity/:id')보다 먼저 등록해야
  // '/unity/test' 가 :id='test' 로 잡히지 않는다(idracRouteOrder 와 동일한 함정).
  adminRouter.post('/unity/test', adminOnly, async (req, res) => {
    const r = await testUnity(req.body || {});
    logAudit({
      user: req.user?.username,
      action: 'Unity 연결 테스트',
      target: String(req.body?.id || req.body?.host || ''),
      detail: r.ok ? `성공 · ${r.model || ''} · 풀 ${r.pools}개 · ${r.ms}ms` : `실패(${r.stepLabel || r.step || ''}) · ${r.reason || ''}`,
    });
    res.json(r); // 실패도 200 + { ok:false } — 화면이 단계별 원인/조치를 그대로 보여준다
  });

  adminRouter.post('/unity', adminOnly, (req, res) => {
    const r = addUnity(req.body || {});
    if (r.ok) logAudit({ user: req.user?.username, action: 'Unity 장비 등록', target: r.unity.id, detail: r.unity.host });
    res.status(r.ok ? 200 : 400).json(r);
  });

  adminRouter.put('/unity/:id', adminOnly, (req, res) => {
    const r = updateUnity(req.params.id, req.body || {});
    if (r.ok) logAudit({ user: req.user?.username, action: 'Unity 장비 수정', target: req.params.id, detail: r.unity.host });
    res.status(r.ok ? 200 : 400).json(r);
  });

  adminRouter.delete('/unity/:id', adminOnly, (req, res) => {
    const r = removeUnity(req.params.id);
    if (r.ok) logAudit({ user: req.user?.username, action: 'Unity 장비 삭제', target: req.params.id });
    res.status(r.ok ? 200 : 404).json(r);
  });

}
