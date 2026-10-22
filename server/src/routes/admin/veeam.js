// 설정 › vCenter 관리 › Veeam 백업 서버(v2.751) — 등록·수정·삭제·연결 시험·지금 읽기.
// 게이트: adminOnly + 전체 범위(전 법인 설정) · 변경은 감사 로그(비밀 미기재) · 응답에 비밀번호를 싣지 않는다(hasPassword 만).
// 연결 시험은 **저장된 서버만**(id 로) — 요청 본문의 host 로 저장 비밀번호를 보내지 않는다(server/CLAUDE.md v2.480 규칙).
import { adminOnly, fullScopeOnlyWith } from './shared.js';
import { logAudit } from '../../audit.js';
import { listServers, saveServer, deleteServer, getServerWithSecret, registryLoadError, DEFAULT_PORT, DEFAULT_API_VERSION } from '../../veeam/registry.js';
import { getRecord, dropResult } from '../../veeam/store.js';
import { pollVeeamOnce, veeamPollerStatus, authGuard } from '../../veeam/poller.js';
import { testVeeamServer } from '../../veeam/client.js';
import { withDeadline } from '../../util/deadline.js';
import { allVeeamEdgeStatus } from '../../central/veeamEdge.js';
import { listRegistry as listVcenters } from '../../vcenter/registry.js';
import { store } from '../../store.js';
import { listInventory } from '../../central/inventory.js';
import { knownAgentNames } from '../../central/knownAgents.js';
import { listAgentTokens } from '../../central/agentTokens.js';
import { summarizeRegistryError } from '../../util/registryCore.js';

const fleetWideOnly = fullScopeOnlyWith('Veeam 백업 서버 등록은 전 법인에 걸친 설정이라 전체 범위(vCenter 제한 없는) 계정만 볼 수 있습니다.');

/** 서버 1대의 상태 요약(화면 표 한 줄) — VM 표는 싣지 않는다. */
export function serverStatusView(rec) {
  if (!rec) return null;
  const r = rec.result || {};
  return {
    at: rec.at, via: rec.via, agent: rec.agent || '', ok: r.ok === true, ts: r.ts ?? null, ms: r.ms ?? null,
    error: r.error || '', kind: r.kind || '', apiVersion: r.apiVersion || '', notes: Array.isArray(r.notes) ? r.notes : [],
    counts: r.ok ? (r.counts || {}) : (rec.lastOk?.counts || {}), lastOkTs: r.ok ? r.ts : (rec.lastOk?.ts ?? null),
    authStop: r.authStop || null,
    jobs: (r.ok ? r.jobs : rec.lastOk?.jobs || []).slice(0, 300).map((j) => ({ name: j.name, status: j.status, lastResult: j.lastResult, lastRun: j.lastRun, running: j.running, disabled: j.disabled, vms: j.vms, containers: j.containers })),
  };
}

export function registerVeeam(adminRouter) {
  adminRouter.get('/veeam/servers', adminOnly, fleetWideOnly, (_req, res) => {
    const le = registryLoadError();
    const owners = new Map(listInventory().map((i) => [i.vcenterId, i.agent]));
    // 화면 목록은 지금 보이는 vCenter(스냅샷 — 데모 포함) + 등록부의 주소·수집 방식.
    const reg = new Map(listVcenters().map((v) => [v.id, v]));
    const vcenters = (store.get()?.vcenters || []).map((v) => ({ id: v.id, name: v.name, host: reg.get(v.id)?.host || '', collectMode: reg.get(v.id)?.collectMode || 'direct', siteAgent: owners.get(v.id) || '' }));
    res.json({
      ok: true,
      servers: listServers().map((d) => ({ ...d, status: serverStatusView(getRecord(d.id)) })),
      vcenters, agents: knownAgentNames(), edges: allVeeamEdgeStatus(), poller: veeamPollerStatus(),
      // 개별 토큰이 발급된 엣지 이름 — Veeam 위임 라우트는 개별 토큰만 받는다(central.js veeam-config). 화면이 토큰 없는 엣지 배정을 경고한다.
      tokenAgents: (() => { try { return listAgentTokens().map((t) => t.agent); } catch { return []; } })(),
      defaults: { port: DEFAULT_PORT, apiVersion: DEFAULT_API_VERSION },
      ...(le ? { registryError: summarizeRegistryError(le)?.text || '등록부 읽기 오류' } : {}),
    });
  });

  adminRouter.post('/veeam/servers', adminOnly, fleetWideOnly, (req, res) => {
    try {
      const d = saveServer(req.body || {});
      logAudit({ user: req.user?.username, action: 'Veeam 서버 저장', target: d.name, detail: `${d.host}:${d.port} · vCenter ${d.vcenterIds.join(',')} · 읽는 곳=${d.agent || '중앙'}${d.droppedSecrets ? ' · 접속처 변경으로 저장 비밀번호 폐기' : ''}` });
      res.status(201).json({ ok: true, server: d });
    } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
  });

  adminRouter.delete('/veeam/servers/:id', adminOnly, fleetWideOnly, (req, res) => {
    const d = getServerWithSecret(req.params.id);
    if (!d || !deleteServer(req.params.id)) return res.status(404).json({ ok: false, reason: '서버를 찾을 수 없습니다.' });
    dropResult(req.params.id);
    authGuard.clearAuthStop(req.params.id);
    logAudit({ user: req.user?.username, action: 'Veeam 서버 삭제', target: d.name, detail: `${d.host}:${d.port || DEFAULT_PORT}` });
    res.json({ ok: true });
  });

  // 연결 시험 — 중앙이 직접 읽는 서버만(엣지 담당은 그 엣지가 읽는다 — 중앙에서는 닿지 않는 망일 수 있다).
  adminRouter.post('/veeam/servers/:id/test', adminOnly, fleetWideOnly, async (req, res) => {
    const d = getServerWithSecret(req.params.id);
    if (!d) return res.status(404).json({ ok: false, reason: '서버를 찾을 수 없습니다.' });
    if (String(d.id).startsWith('mock-')) return res.json({ ok: false, reason: '데모 서버는 접속하지 않습니다.' });
    if ((d.agent || '').trim()) return res.json({ ok: false, edge: true, reason: `엣지 '${d.agent}' 가 읽는 서버입니다 — 중앙에서는 시험하지 않습니다. 엣지가 배정을 받는 대로(최대 5분) 읽고 결과를 올립니다.` });
    try {
      const r = await withDeadline(90_000, (signal) => testVeeamServer(d, { signal }), 'Veeam 연결 시험 시한 초과');
      logAudit({ user: req.user?.username, action: 'Veeam 연결 시험', target: d.name, detail: `성공 · 작업 ${r.jobs}개` });
      res.json(r);
    } catch (e) {
      const reason = String(e?.message || e).slice(0, 600);
      logAudit({ user: req.user?.username, action: 'Veeam 연결 시험', target: d.name, detail: `실패 · ${reason.slice(0, 120)}` });
      res.json({ ok: false, reason, auth: !!e?.authFailed });
    }
  });

  // 지금 읽기 — 중앙 직접 서버만 바로 읽는다(수동은 인증 정지를 건너뛴다 — 고쳤는지 확인할 길).
  adminRouter.post('/veeam/servers/:id/collect', adminOnly, fleetWideOnly, async (req, res) => {
    const d = getServerWithSecret(req.params.id);
    if (!d) return res.status(404).json({ ok: false, reason: '서버를 찾을 수 없습니다.' });
    if ((d.agent || '').trim()) return res.json({ ok: false, edge: true, reason: `엣지 '${d.agent}' 가 읽는 서버입니다 — 엣지의 다음 수집 주기에 반영됩니다.` });
    const r = await pollVeeamOnce({ manual: true, ids: [d.id] });
    logAudit({ user: req.user?.username, action: 'Veeam 지금 읽기', target: d.name, detail: r.skipped ? '이미 수집 중' : `성공 ${r.ok ?? 0}·실패 ${r.fail ?? 0}` });
    res.json({ ok: !r.skipped && !r.timedOut, ...r, status: serverStatusView(getRecord(d.id)) });
  });
}
