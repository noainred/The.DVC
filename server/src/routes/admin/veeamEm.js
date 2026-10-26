// 설정 › Veeam 백업 서버 › Enterprise Manager(v2.788) — 등록·수정·삭제·연결 시험·지금 수집.
// 게이트: adminOnly + 전체 범위(전 법인 설정 — Veeam 백업 서버 등록과 같은 문구) · 변경은 감사 로그(비밀 미기재) · 응답에 비밀번호를 싣지 않는다(hasPassword 만).
// 연결 시험은 **저장된 EM 만**(id 로) — 요청 본문의 host 로 저장 비밀번호를 보내지 않는다(server/CLAUDE.md v2.480 규칙).
import { adminOnly, fullScopeOnlyWith } from './shared.js';
import { logAudit } from '../../audit.js';
import { listEms, saveEm, deleteEm, getEmWithSecret, emRegistryLoadError, DEFAULT_EM_PORT } from '../../veeam/em/registry.js';
import { getEmRecord, dropEmResult } from '../../veeam/em/store.js';
import { pollEmOnce, emPollerStatus, emAuthGuard } from '../../veeam/em/poller.js';
import { testEm } from '../../veeam/em/client.js';
import { withDeadline } from '../../util/deadline.js';
import { summarizeRegistryError } from '../../util/registryCore.js';

const fleetWideOnly = fullScopeOnlyWith('Veeam Enterprise Manager 등록은 전 법인에 걸친 설정이라 전체 범위(vCenter 제한 없는) 계정만 볼 수 있습니다.');

/** EM 1대의 상태 요약(설정 표 한 줄) — 수집 결과 본문은 싣지 않는다. */
export function emStatusView(rec) {
  if (!rec) return null;
  const r = rec.result || {};
  const sections = r.ok ? r.sections : (rec.lastOk?.sections || r.sections || {});
  return {
    at: rec.at, ok: r.ok === true, ts: r.ts ?? null, ms: r.ms ?? null, error: r.error || '', kind: r.kind || '',
    lastOkTs: r.ok ? r.ts : (rec.lastOk?.ts ?? null), authStop: r.authStop || null,
    sections: Object.fromEntries(Object.entries(sections || {}).map(([k, v]) => [k, { ok: v?.ok === true, ...(v?.reason ? { reason: String(v.reason).slice(0, 200) } : {}) }])),
    notes: Array.isArray(r.notes) ? r.notes.slice(0, 10) : [],
  };
}

export function registerVeeamEm(adminRouter) {
  adminRouter.get('/veeam/em', adminOnly, fleetWideOnly, (_req, res) => {
    const le = emRegistryLoadError();
    res.json({
      ok: true,
      ems: listEms().map((d) => ({ ...d, status: emStatusView(getEmRecord(d.id)) })),
      poller: emPollerStatus(), defaults: { port: DEFAULT_EM_PORT },
      ...(le ? { registryError: summarizeRegistryError(le)?.text || '등록부 읽기 오류' } : {}),
    });
  });

  adminRouter.post('/veeam/em', adminOnly, fleetWideOnly, (req, res) => {
    try {
      const d = saveEm({ ...(req.body || {}) });
      // 접속처가 바뀌면 옛 접속처의 결과와 인증 정지를 지운다(다른 EM 이다 — secretCarry 와 같은 판단).
      if (d.moved) { dropEmResult(d.id); emAuthGuard.clearAuthStop(d.id); }
      logAudit({ user: req.user?.username, action: 'Veeam EM 저장', target: d.name, detail: `${d.host}:${d.port}${d.enabled === false ? ' · 수집 끔' : ''}${d.moved ? ' · 접속처 변경으로 이전 결과·인증 정지 지움' : ''}${d.droppedSecrets ? ' · 접속처 변경으로 저장 비밀번호 폐기' : ''}` });
      res.status(201).json({ ok: true, em: d });
    } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
  });

  adminRouter.delete('/veeam/em/:id', adminOnly, fleetWideOnly, (req, res) => {
    const d = getEmWithSecret(req.params.id);
    if (!d || !deleteEm(req.params.id)) return res.status(404).json({ ok: false, reason: 'Enterprise Manager 를 찾을 수 없습니다.' });
    dropEmResult(req.params.id);
    emAuthGuard.clearAuthStop(req.params.id);
    logAudit({ user: req.user?.username, action: 'Veeam EM 삭제', target: d.name, detail: `${d.host}:${d.port || DEFAULT_EM_PORT}` });
    res.json({ ok: true });
  });

  adminRouter.post('/veeam/em/:id/test', adminOnly, fleetWideOnly, async (req, res) => {
    const d = getEmWithSecret(req.params.id);
    if (!d) return res.status(404).json({ ok: false, reason: 'Enterprise Manager 를 찾을 수 없습니다.' });
    if (String(d.id).startsWith('mock-')) return res.json({ ok: false, reason: '데모 EM 은 접속하지 않습니다.' });
    if (!d.password) return res.json({ ok: false, kind: 'no-password', reason: '저장된 비밀번호가 없어 시험하지 않았습니다 — 수정에서 비밀번호를 입력하세요.' });
    try {
      const r = await withDeadline(90_000, (signal) => testEm(d, { signal }), 'Veeam EM 연결 시험 시한 초과');
      const authStopCleared = r?.ok !== false && emAuthGuard.clearAuthStop(d.id);
      logAudit({ user: req.user?.username, action: 'Veeam EM 연결 시험', target: d.name, detail: `성공 · 백업 서버 ${r.backupServers != null ? `${r.backupServers}대` : '수 모름'}${authStopCleared ? ' · 인증 실패 정지 해제' : ''}` });
      res.json({ ...r, ...(authStopCleared ? { authStopCleared: true } : {}) });
    } catch (e) {
      const reason = String(e?.message || e).slice(0, 600);
      logAudit({ user: req.user?.username, action: 'Veeam EM 연결 시험', target: d.name, detail: `실패 · ${reason.slice(0, 120)}` });
      res.json({ ok: false, reason, auth: !!e?.authFailed });
    }
  });

  // 지금 수집 — 수동은 인증 정지를 건너뛴다(고쳤는지 확인할 길 — authGuard 규칙). 응답: { ok, skipped?, timedOut?, disabled?, reason?, status }
  adminRouter.post('/veeam/em/:id/collect', adminOnly, fleetWideOnly, async (req, res) => {
    const d = getEmWithSecret(req.params.id);
    if (!d) return res.status(404).json({ ok: false, reason: 'Enterprise Manager 를 찾을 수 없습니다.' });
    if (d.enabled === false) return res.json({ ok: false, disabled: true, reason: '수집이 꺼진 EM 이라 읽지 않았습니다 — 수정에서 수집을 켠 뒤 읽으세요.', status: emStatusView(getEmRecord(d.id)) });
    const r = await pollEmOnce({ manual: true, ids: [d.id] });
    const status = emStatusView(getEmRecord(d.id));
    const ok = !r.skipped && !r.timedOut && Number(r.ok) > 0 && !Number(r.fail);
    let reason = '';
    if (r.skipped) reason = r.reason || '이미 수집 중입니다 — 끝난 뒤 다시 누르세요.';
    else if (r.timedOut) reason = '수집 상한을 넘겨 기다리지 않았습니다 — 잠시 뒤 상태를 확인하세요.';
    else if (!ok) reason = r.discarded ? '읽는 도중 접속처가 바뀌어 이전 접속처에서 읽은 결과를 버렸습니다 — 다시 누르세요.' : (status?.error || '읽기에 실패했습니다.');
    logAudit({ user: req.user?.username, action: 'Veeam EM 지금 수집', target: d.name, detail: r.skipped ? '건너뜀' : r.timedOut ? '상한 초과' : ok ? '성공' : '실패' });
    res.json({ ok, ...(r.skipped ? { skipped: true } : {}), ...(r.timedOut ? { timedOut: true } : {}), ...(reason ? { reason } : {}), status });
  });
}
