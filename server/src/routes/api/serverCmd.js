/**
 * routes/api/serverCmd.js — 기능 ‘서버 명령 실행’(v3.30 · 설계 docs/design/server-cmd · D7).
 *  · 조회 · 미리 보기 · 출력 · 실행 모두 관리자 + 전체 범위(서버 정보와 같은 등록부 — vCenter 범위로 자를 수 없는 서버가 섞인다 · 데모 계정은 authMiddleware 의 READ_DENY 가 막는다 — 보안 잔여 11-27 L7 정정: 요청 문맥이 role admin 이라 관리자 게이트는 통과했다).
 *  · 요청은 **프리셋 id · 값 · 서버 id 만** 받는다 — 명령 글자 · 주소 · 계정을 받지 않는다(명령은 servercmd/presets.js 에 고정 · 값은 그 파일이 검사한다).
 *  · 실행은 시작만 하고 202(응답 없는 서버가 섞이면 수 분 — 화면이 진행을 조회한다) · 진행 중이면 429(일괄은 하나씩).
 *  · 감사: 누가 · 프리셋 · 값 · 대상 수 · 끝난 뒤 서버별 결과 코드 — **출력 · 비밀은 싣지 않는다**.
 */
import { requireRole } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import * as SVC from '../../servercmd/service.js';
import { previewOf, presetById } from '../../servercmd/presets.js';

const adminOnly = requireRole('admin');
const fullScopeOnly = fullScopeOnlyWith('서버 명령 실행은 vCenter 범위로 자를 수 없는 서버가 섞여 전체 범위(vCenter 제한 없는) 계정만 쓸 수 있습니다.');
const who = (req) => String(req.user?.username || '').slice(0, 64);
const send = (res, r) => res.status(r.ok ? 200 : (r.status || 409)).json(r);
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

/**
 * 요청 값(객체) → 자기 칸만 옮긴 프로토타입 없는 객체(반증 F1 — 보통 객체에 ‘__proto__’ 칸을 넣으면 프로토타입이 바뀌어 값 이름 검사를 비켜 가고 감사에서 값이 빠졌다).
 * 이름 검사(모르는 값 거절)는 presets.checkRequest 가 한다 — 여기서 이름을 거르지 않는다(거르면 모르는 값이 조용히 사라진다).
 */
function paramsOf(src) {
  const o = Object.create(null);
  if (!src || typeof src !== 'object' || Array.isArray(src)) return o;
  for (const k of Object.keys(src).slice(0, 8)) {
    const v = src[k];
    Object.defineProperty(o, String(k).slice(0, 32), { value: typeof v === 'string' ? v.slice(0, 400) : v, enumerable: true, writable: true, configurable: true });
  }
  return o;
}

export function registerServerCmd(api) {
  api.get('/tools/server-cmd', adminOnly, fullScopeOnly, (_req, res) => send(res, SVC.buildView()));
  // 미리 보기 — 실행될 글 그대로(값 검사를 지난 것만 · 접속하지 않는다). 값 검사 결과도 **답**이다(200 + ok:false · 사유) —
  //   화면은 칸을 칠 때마다 묻는다: 400 으로 답하면 브라우저 콘솔이 오류로 찍는다(Chromium 확인). 실행(POST run)은 그대로 400.
  api.get('/tools/server-cmd/preview', adminOnly, fullScopeOnly, (req, res) => {
    const p = presetById(str(req.query.preset, 64));
    const params = {};
    for (const d of p?.params || []) params[d.name] = str(req.query[d.name], 400);
    res.json(previewOf(str(req.query.preset, 64), params));
  });
  // 마지막 실행의 출력(한 대 — ?id= · 없으면 전부 · ?run= 화면이 본 실행 — 다르면 409)
  api.get('/tools/server-cmd/output', adminOnly, fullScopeOnly, (req, res) => send(res, SVC.outputs(str(req.query.id, 64), str(req.query.run, 64))));
  api.post('/tools/server-cmd/run', adminOnly, fullScopeOnly, (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const ids = Array.isArray(b.ids) ? b.ids.slice(0, SVC.RUN_BATCH_MAX + 1) : [];   // 152회차: 여기서 String() 으로 바꾸지 않는다({"toString":1} 이 던져 500) — 글자 판정은 일괄 틀(batch.batchIdOf) 하나
    const preset = str(b.preset, 64);
    const params = paramsOf(b.params);
    const r = SVC.startRun({ preset, params, ids }, { by: who(req) });
    const pv = Object.entries(params).filter(([, v]) => typeof v === 'string').map(([k, v]) => `${k}=${v.slice(0, 120)}`).join(' ');
    logAudit({ user: who(req), action: 'server-cmd.run', target: `${preset || '?'} · ${r.ok ? r.total : ids.length}대`, ip: req.ip || '',
      detail: JSON.stringify(r.ok ? { preset, params: pv, started: r.total } : { ok: false, code: r.code }).slice(0, 400) });
    if (!r.ok) return send(res, r);
    // 끝난 결과도 감사에 남긴다(서버별 결과 코드 · 끝 코드가 0 이 아닌 수 — 출력 · 비밀 없음)
    r.done.then((d) => logAudit({ user: who(req), action: 'server-cmd.run.done', target: `${preset} · ${r.total}대`, ip: req.ip || '',
      detail: JSON.stringify(d.ok ? { ran: d.ran, partial: d.partial, failed: d.failed, nonZero: d.nonZero, codes: d.results.map((x) => `${String(x?.name || '').slice(0, 40)}:${x?.code}`).join(' ').slice(0, 300) } : { ok: false, code: d.code }).slice(0, 400) })).catch(() => {});
    res.status(202).json({ ok: true, started: true, total: r.total, preset: r.preset });
  });
}
