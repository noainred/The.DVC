/**
 * routes/svcmon/trial.js — 사용/중지 일괄 전환 · 시험 점검 후 사용(v2.960 쉬운 등록 A).
 *
 * 게이트(형제 쓰기 라우트와 같은 기준 — shared.js 머리말): 마운트가 `requirePerm('svcmon')` 아래 · 쓰기는 canEdit + fullScopeOnly
 *   (성능점검 대상 · 엣지 배정은 전 법인 공용이라 범위로 나눌 수 없다 — v2.602 AUTHZ-2602-01). 조회(GET /trial/:id)도 canEdit — 편집자 화면 전용.
 * 엣지 노드(CENTRAL_URL)는 쓰지 않는다(409) — 엣지의 대상은 중앙 배정 사본이라 다음 배정 당기기가 덮어쓴다.
 * 바뀐 대상의 담당 엣지는 byAgent 배정을 다시 굳힌다(central/svcmonAssignSync.js — 경로 기준 배정은 건너뜀으로 보고).
 */
import { logAudit } from '../../audit.js';
import { setEnabledMany, LIMITS } from '../../svcmon/store.js';
import { startTrial, getTrial, TRIAL_MAX_IDS } from '../../svcmon/trial.js';
import { syncAvailableHere, requestDetect } from '../../svcmon/settingsSync.js';
import { syncByAgentAssignments } from '../../central/svcmonAssignSync.js';
import { canEdit, fullScopeOnly } from './shared.js';

const edgeNode = (res) => res.status(409).json({ ok: false, reason: 'edge-node', error: '엣지 노드에서는 대상을 켜고 끌 수 없습니다 — Monitoring 대상은 중앙에서 배정됩니다.' });
const MAX_IDS = Math.max(TRIAL_MAX_IDS, LIMITS.maxBulkRows || 0);

export function registerTrial(svcmonRouter) {

/** 사용/중지 일괄 — 대상 id 목록 · (대상 id, 점검 id) 목록. 바뀐 대상의 담당 엣지(byAgent)는 배정을 다시 굳힌다. */
svcmonRouter.post('/targets/enabled', canEdit, fullScopeOnly, (req, res) => {
  if (!syncAvailableHere()) return edgeNode(res);
  const b = req.body || {};
  if (typeof b.enabled !== 'boolean') return res.status(400).json({ ok: false, error: 'enabled(true/false)가 필요합니다.' });
  const targets = Array.isArray(b.targets) ? b.targets : [];
  const tests = Array.isArray(b.tests) ? b.tests : [];
  if (!targets.length && !tests.length) return res.status(400).json({ ok: false, error: '바꿀 대상이나 점검을 고르세요.' });
  if (targets.length + tests.length > MAX_IDS) return res.status(400).json({ ok: false, error: `한 번에 ${MAX_IDS}개까지 바꿀 수 있습니다(요청 ${targets.length + tests.length}개).` });
  const r = setEnabledMany({ targets, tests, enabled: b.enabled });
  const user = req.user?.username || '';
  const assign = r.agents.length ? syncByAgentAssignments(r.agents, user, { note: b.enabled ? '사용으로 전환' : '중지로 전환' }) : [];
  if (r.changed) {
    logAudit({ user, action: b.enabled ? 'svcmon.target.enable' : 'svcmon.target.disable', detail: `바뀜 ${r.changed} · 그대로 ${r.unchanged} · 없음 ${r.missing.length}${assign.length ? ` · 배정 ${assign.filter((x) => x.ok).length}/${assign.length}` : ''}` });
    requestDetect();   // 개요 '감시 범위' 카드(설정 연동 감지 값)를 곧바로 맞춘다
  }
  res.json({ ok: true, changed: r.changed, unchanged: r.unchanged, missing: r.missing.slice(0, 50), assign });
});

/** 시험 점검 후 사용 — 시작(직접 시험은 뒤에서 돈다 · 엣지 시험은 대기로). */
svcmonRouter.post('/trial', canEdit, fullScopeOnly, (req, res) => {
  if (!syncAvailableHere()) return edgeNode(res);
  const user = req.user?.username || '';
  const r = startTrial(req.body?.ids, { user });
  if (!r.ok) return res.status(r.busy ? 409 : 400).json({ ok: false, error: r.error });
  const c = r.job.counts || {};
  logAudit({ user, action: 'svcmon.trial.start', target: r.job.id, detail: `직접 ${r.job.items.filter((x) => x.where === 'local').length} · 엣지 대기 ${c.wait || 0} · 건너뜀 ${c.skip || 0} · 실패 ${c.fail || 0}` });
  r.done.then(() => requestDetect()).catch(() => {});
  res.status(202).json({ ok: true, job: r.job });
});

svcmonRouter.get('/trial/:id', canEdit, (req, res) => {
  const job = getTrial(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: '시험 작업을 찾을 수 없습니다(재시작했거나 오래돼 지워졌을 수 있습니다).' });
  res.json({ ok: true, job });
});

}
