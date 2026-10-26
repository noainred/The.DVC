// 설정 › Veeam 백업 서버 › Enterprise Manager(v2.788) — 등록·수정·삭제·연결 시험·지금 수집.
// 게이트: adminOnly + 전체 범위(전 법인 설정 — Veeam 백업 서버 등록과 같은 문구) · 변경은 감사 로그(비밀 미기재) · 응답에 비밀번호를 싣지 않는다(hasPassword 만).
// 연결 시험은 **저장된 EM 만**(id 로) — 요청 본문의 host 로 저장 비밀번호를 보내지 않는다(server/CLAUDE.md v2.480 규칙).
import { adminOnly, fullScopeOnlyWith } from './shared.js';
import { logAudit } from '../../audit.js';
import { listEms, saveEm, deleteEm, getEmWithSecret, emRegistryLoadError, DEFAULT_EM_PORT } from '../../veeam/em/registry.js';
import { getEmRecord, dropEmResult } from '../../veeam/em/store.js';
import { dropEmVms, emVmCountsByServer, getEmVms } from '../../veeam/em/vmStore.js';
import { brHealthy } from '../api/veeam.js';
import { pollEmOnce, emPollerStatus, emAuthGuard } from '../../veeam/em/poller.js';
import { testEm } from '../../veeam/em/client.js';
import { withDeadline } from '../../util/deadline.js';
import { summarizeRegistryError } from '../../util/registryCore.js';
import { getEmMap, setEmMap, emMapUnreadable, dropEmMapFor, mapKey } from '../../veeam/em/mapping.js';
import { mapBackupServers } from '../../veeam/em/view.js';
import { listServers } from '../../veeam/registry.js';
import { store } from '../../store.js';

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

/**
 * v2.788.1 매핑 표 — EM 마다 마지막 성공 결과의 백업 서버 + 매핑만 남은 줄(그 이름이 지금 EM 결과에 없음 — gone).
 * 화면이 고를 수 있는 vCenter(스냅샷)·B&R 등록(비밀 없음) 목록을 함께 준다.
 */
/**
 * v2.795 'vCenter 반영' 칸 — 이 백업 서버의 VM 기록이 vCenter 화면에 어떻게 실리는가(routes/api/veeam.js resultsFor 와 같은 우선 규칙 · brHealthy 하나).
 *  none = vCenter 를 정하지 않아 싣지 않음 · br = 짝지은 B&R 직접 수집이 정상이라 그것으로(EM 은 뺀다) · em = EM 으로 · mixed = vCenter 마다 다름.
 */
export function reflectOf(x, { healthy = brHealthy, now = Date.now() } = {}) {
  if (!x.vcenterIds?.length || x.enabled === false) return 'none';
  const kinds = new Set(x.vcenterIds.map((vc) => (x.brId && healthy(x.brId, vc, now) ? 'br' : 'em')));
  return kinds.size > 1 ? 'mixed' : [...kinds][0];
}

export function emMappingView(ems, { recOf = getEmRecord, map = getEmMap(), brServers = listServers(), vcenters = store.get()?.vcenters || [], healthy = brHealthy } = {}) {
  const vcName = new Map(vcenters.map((v) => [v.id, v.name || v.id]));
  const rows = [];
  const now = Date.now();
  for (const em of ems) {
    const rec = recOf(em.id);
    const data = rec?.result?.ok ? rec.result : (rec?.lastOk || null);
    const list = mapBackupServers(data?.backupServers || [], { emId: em.id, map, brServers, vcName });
    const seen = new Set(list.map((x) => mapKey(em.id, x.name)));
    const counts = emVmCountsByServer(em.id);
    const vmKnown = !!getEmVms(em.id);   // VM 기록을 한 번이라도 저장했는가(아니면 수는 모름 — 0 이 아니다)
    for (const x of list) rows.push({ emId: em.id, emName: em.name, name: x.name, version: x.version || '', registered: x.registered, brId: x.brId, brName: x.brName, brSource: x.brSource, vcenterIds: x.vcenterIds, vcNames: x.vcNames, vcSource: x.vcSource, manual: map[mapKey(em.id, x.name)] || null,
      reflect: reflectOf({ ...x, enabled: em.enabled }, { healthy, now }), vmCount: vmKnown ? (counts.get(String(x.name).trim().toLowerCase()) || 0) : null });
    for (const [k, e] of Object.entries(map)) {
      if (!k.startsWith(`${em.id}|`) || seen.has(k)) continue;
      rows.push({ emId: em.id, emName: em.name, name: e.server, version: '', gone: true, registered: false, brId: '', brName: '', brSource: null, vcenterIds: e.vcenterIds || [], vcNames: (e.vcenterIds || []).map((id) => vcName.get(id) || id), vcSource: e.vcenterIds?.length ? 'manual' : null, manual: e });
    }
  }
  return {
    rows, unreadable: emMapUnreadable() || undefined,
    vcenters: vcenters.map((v) => ({ id: v.id, name: v.name || v.id })).sort((a, b) => String(a.name).localeCompare(String(b.name), 'en', { numeric: true })),
    brServers: brServers.map((b) => ({ id: b.id, name: b.name, host: b.host, vcenterIds: b.vcenterIds || [] })),
  };
}

export function registerVeeamEm(adminRouter) {
  adminRouter.get('/veeam/em', adminOnly, fleetWideOnly, (_req, res) => {
    const le = emRegistryLoadError();
    res.json({
      ok: true,
      ems: listEms().map((d) => ({ ...d, status: emStatusView(getEmRecord(d.id)) })),
      mapping: emMappingView(listEms()),
      poller: emPollerStatus(), defaults: { port: DEFAULT_EM_PORT },
      ...(le ? { registryError: summarizeRegistryError(le)?.text || '등록부 읽기 오류' } : {}),
    });
  });

  adminRouter.post('/veeam/em', adminOnly, fleetWideOnly, (req, res) => {
    try {
      const d = saveEm({ ...(req.body || {}) });
      // 접속처가 바뀌면 옛 접속처의 결과와 인증 정지를 지운다(다른 EM 이다 — secretCarry 와 같은 판단).
      if (d.moved) { dropEmResult(d.id); dropEmVms(d.id); emAuthGuard.clearAuthStop(d.id); }
      logAudit({ user: req.user?.username, action: 'Veeam EM 저장', target: d.name, detail: `${d.host}:${d.port}${d.enabled === false ? ' · 수집 끔' : ''}${d.moved ? ' · 접속처 변경으로 이전 결과·인증 정지 지움' : ''}${d.droppedSecrets ? ' · 접속처 변경으로 저장 비밀번호 폐기' : ''}` });
      res.status(201).json({ ok: true, em: d });
    } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
  });

  adminRouter.delete('/veeam/em/:id', adminOnly, fleetWideOnly, (req, res) => {
    const d = getEmWithSecret(req.params.id);
    if (!d || !deleteEm(req.params.id)) return res.status(404).json({ ok: false, reason: 'Enterprise Manager 를 찾을 수 없습니다.' });
    dropEmResult(req.params.id);
    dropEmVms(req.params.id);   // v2.795 VM 단위 기록도
    emAuthGuard.clearAuthStop(req.params.id);
    dropEmMapFor(req.params.id);   // v2.788.1 그 EM 의 매핑도(유령 매핑 방지)
    logAudit({ user: req.user?.username, action: 'Veeam EM 삭제', target: d.name, detail: `${d.host}:${d.port || DEFAULT_EM_PORT}` });
    res.json({ ok: true });
  });

  // v2.788.1 매핑 저장 — 백업 서버 한 대: vCenter(법인) 목록 · B&R 등록(''=자동 · id · 'none'). 둘 다 비면 지운다.
  //   알려진 vCenter·등록된 B&R 만 받는다(모르는 값 400) · 매핑 파일을 못 읽었으면 503(빈 맵 위에 쓰지 않는다) · 감사 로그.
  adminRouter.put('/veeam/em/map', adminOnly, fleetWideOnly, (req, res) => {
    const b = req.body || {};
    const em = getEmWithSecret(String(b.emId || ''));
    if (!em) return res.status(404).json({ ok: false, reason: 'Enterprise Manager 를 찾을 수 없습니다.' });
    const r = setEmMap({ emId: em.id, server: b.server, vcenterIds: b.vcenterIds, br: b.br },
      { knownVcenters: (store.get()?.vcenters || []).map((v) => v.id), knownBr: listServers().map((x) => x.id), user: req.user });
    if (!r.ok) return res.status(r.status).json({ ok: false, reason: r.reason, ...(r.code ? { code: r.code } : {}) });
    logAudit({ user: req.user?.username, action: 'Veeam EM 매핑', target: `${em.name} › ${String(b.server || '').slice(0, 120)}`,
      detail: r.entry ? `vCenter ${r.entry.vcenterIds.length ? r.entry.vcenterIds.join(',') : '자동'} · B&R ${r.entry.br === 'none' ? '포탈에 없음' : r.entry.br || '자동'}` : '매핑 지움(자동)' });
    res.json({ ok: true, entry: r.entry });
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
