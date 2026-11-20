/**
 * routes/api/serverInfo.js — 기능 ‘서버 정보’(v3.25 · 서버 접속 2단계 — 설계 docs/design/server-access §4.5 · D3).
 *  · 조회 · 읽기 모두 관리자 + 전체 범위(베어메탈 스토리지 · 서버 접속 화면과 같은 등록부 — vCenter 범위로 자를 수 없는 서버가 섞인다).
 *  · 읽기(POST)는 저장된 비밀(서버 · 공통 계정)로 접속한다 — 접속처는 **등록부 저장값만**(요청은 서버 id 만 고른다 — 주소 · 계정 · 명령을 받지 않는다).
 *    판정(허용 기능 · 계정 정지 · 승인 · 법인 사용 중지)은 코어(sshaccess/readServer → refs.resolveOsAuth)가 한다.
 *  · 일괄은 시작만 하고 202(응답 없는 서버가 섞이면 수 분 — 화면이 진행을 조회한다) · 진행 중이면 429(일괄은 하나씩).
 *  · 데모 계정(viewer)은 관리자 게이트에서 막힌다(데모 분기를 두지 않는다 — 닿지 않는 코드였다 · 반증 F12).
 *  · 감사에 비밀 · 출력 없음(서버 수 · 결과 코드만).
 */
import { requireRole } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import * as SVC from '../../serverinfo/service.js';

const adminOnly = requireRole('admin');
const fullScopeOnly = fullScopeOnlyWith('서버 정보는 vCenter 범위로 자를 수 없는 서버가 섞여 전체 범위(vCenter 제한 없는) 계정만 쓸 수 있습니다.');
const who = (req) => String(req.user?.username || '').slice(0, 64);
const send = (res, r) => res.status(r.ok ? 200 : (r.status || 409)).json(r);

export function registerServerInfo(api) {
  api.get('/tools/server-info', adminOnly, fullScopeOnly, (req, res) => {
    const v = SVC.buildView();
    send(res, v);
  });
  api.post('/tools/server-info/read', adminOnly, fullScopeOnly, (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const ids = Array.isArray(b.ids) ? b.ids.slice(0, SVC.READ_BATCH_MAX + 1).map((x) => String(x ?? '').slice(0, 64)) : [];
    const r = SVC.startRead(ids, { by: who(req) });
    logAudit({ user: who(req), action: 'server-info.read', target: `${ids.length}대`, ip: req.ip || '', detail: JSON.stringify(r.ok ? { started: r.total } : { ok: false, code: r.code }).slice(0, 300) });
    if (!r.ok) return send(res, r);
    // 끝난 결과도 감사에 남긴다(코드만 — 비밀 · 출력 없음)
    r.done.then((d) => logAudit({ user: who(req), action: 'server-info.read.done', target: `${r.total}대`, ip: req.ip || '',
      detail: JSON.stringify(d.ok ? { read: d.read, failed: d.failed, codes: [...new Set(d.results.filter((x) => x && !x.ok).map((x) => x.code))].slice(0, 8) } : { ok: false, code: d.code }).slice(0, 300) })).catch(() => {});
    res.status(202).json({ ok: true, started: true, total: r.total });
  });
}
