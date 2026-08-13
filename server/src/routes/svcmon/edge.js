/**
 * 성능점검 엣지 배정(중앙→엣지 정의 배포) + 엣지 위임(RMA) 현황·진단 — routes/svcmon.js
 * (구 1,053줄) 분할(v2.291.0). 본문은 원본 그대로, 등록 순서는 셸의 register 호출 순서가 보존한다.
 */

import { logAudit } from '../../audit.js';
import { listTargetsCopy, KINDS } from '../../svcmon/store.js';
import { pollerRole } from '../../svcmon/poller.js';
import { edgeSummary, edgeState, edgeTotals, forgetAgent, probeAgent, MAX_AGENTS, MAX_ROWS_PER_AGENT } from '../../central/svcmonEdge.js';
import { listAgentTokens } from '../../central/agentTokens.js';
import { silenceStatus, checkSilenceOnce } from '../../central/svcmonSilence.js';
import { svcmonPushStatus, pushSvcmonNow } from '../../agent/svcmonPush.js';
import {
  listAssignments, setAssignment, deleteAssignment, DEFAULT_EXCEPT_TYPES,
  MAX_TARGETS_PER_AGENT, batchTag,
} from '../../central/svcmonAssign.js';
import { svcmonConfigPullStatus, pullSvcmonConfigNow } from '../../agent/svcmonConfigPull.js';
import { canEdit } from './shared.js';

export function registerEdge(svcmonRouter) {

/* ── 엣지 배정(중앙 → 엣지 정의 배포) ── */

/** 배정 목록 + 이 인스턴스의 역할. 화면이 '중앙은 실행하지 않는다'를 명확히 표시해야 한다. */
svcmonRouter.get('/assign', canEdit, (req, res) => {
  res.json({
    role: pollerRole(),
    assignments: listAssignments(),
    defaultExceptTypes: DEFAULT_EXCEPT_TYPES,
    maxTargetsPerAgent: MAX_TARGETS_PER_AGENT,
    // 배정 후보 엣지 = **개별 토큰이 발급된 엣지 + 이미 보고 중인 엣지** 의 합집합.
    // 자유 입력을 없애는 근거: 토큰의 agent 이름과 대소문자 하나만 달라도 엣지 pull 이
    // 영원히 '배정 없음'을 받는다(조회 키 불일치) — 오타가 무음 공백이 된다.
    reporting: edgeSummary().map((e) => e.agent),
    candidates: (() => {
      const seen = new Map();
      for (const t of listAgentTokens()) seen.set(t.agent, { agent: t.agent, hasToken: true, lastUsedAt: t.lastUsedAt, note: t.note, reporting: false });
      for (const e of edgeSummary()) {
        const cur = seen.get(e.agent) || { agent: e.agent, hasToken: false, lastUsedAt: null, note: '', reporting: false };
        cur.reporting = !e.silent;
        cur.lastReportAt = e.lastAt;
        cur.sourceIp = e.sourceIp;
        seen.set(e.agent, cur);
      }
      return [...seen.values()].sort((a, b) => a.agent.localeCompare(b.agent));
    })(),
    pull: svcmonConfigPullStatus(),
  });
});

/**
 * 배정 저장 — 중앙 트리에서 범위를 잘라 그 엣지 몫으로 굳힌다(스냅샷).
 * `mode:'preview'` 면 저장하지 않고 무엇이 배포될지만 돌려준다.
 */
svcmonRouter.put('/assign/:agent', canEdit, (req, res) => {
  try {
    const agentName = String(req.params.agent || '').trim();
    const kind = KINDS.includes(req.body?.kind) ? req.body.kind : '';
    const scopePath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
    const includeSub = req.body?.includeSub !== false;
    const byAgent = req.body?.byAgent === true;   // 대상별 엣지 태그로 배정(대량등록 흐름의 원클릭 동기화)
    const exceptTypes = Array.isArray(req.body?.exceptTypes) ? req.body.exceptTypes : DEFAULT_EXCEPT_TYPES;
    // 대상별 agent 규칙: 대상에 엣지가 박혀 있으면 '그 엣지 전용'이다.
    //  - byAgent 모드: 이 엣지에 태그된 대상만 스냅샷(경로 무시).
    //  - 경로 스코프 모드: 경로로 고르되, **다른 엣지 소유** 대상은 제외한다(한 대상을 둘이 점검 = 이중).
    const picked = listTargetsCopy().filter((t) => {
      const owner = (t.agent || '').trim();
      if (byAgent) return owner === agentName;
      if (owner && owner !== agentName) return false;
      if (kind && (t.kind || 'infra') !== kind) return false;
      if (!scopePath) return true;
      return includeSub ? (t.path === scopePath || t.path.startsWith(`${scopePath}\\`)) : t.path === scopePath;
    });
    let tests = 0;
    const skip = new Set(exceptTypes);
    for (const t of picked) for (const x of t.tests) if (!skip.has(x.type)) tests += 1;

    if (req.body?.mode === 'preview') {
      return res.json({
        preview: true, agent: req.params.agent,
        counts: { targets: picked.length, tests },
        exceptTypes,
        sample: picked.slice(0, 25).map((t) => ({
          kind: t.kind, path: t.path, name: t.name, host: t.host,
          tests: t.tests.filter((x) => !skip.has(x.type)).length,
          excluded: t.tests.filter((x) => skip.has(x.type)).length,
        })),
        truncated: picked.length > 25,
      });
    }
    const a = setAssignment(req.params.agent, { kind, path: scopePath, includeSub, byAgent, exceptTypes, note: req.body?.note },
      picked, { user: req.user?.username });
    res.json({ assignment: { ...a, targets: undefined }, tag: batchTag(a.sig), assignments: listAssignments() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

svcmonRouter.delete('/assign/:agent', canEdit, (req, res) => {
  if (!deleteAssignment(req.params.agent, { user: req.user?.username })) {
    return res.status(404).json({ error: '그 엣지의 배정이 없습니다.' });
  }
  res.json({ ok: true, assignments: listAssignments() });
});

/** 이 서버가 엣지일 때 — 정의를 즉시 1회 받아 적용(진단용). */
svcmonRouter.post('/config-pull-now', canEdit, async (req, res) => {
  const r = await pullSvcmonConfigNow();
  logAudit({ user: req.user?.username, action: 'svcmon.config.pull', detail: r.ok ? `대상 ${r.added ?? '-'} · sig ${r.sig ?? '-'}` : (r.reason || '실패') });
  res.status(r.ok ? 200 : 202).json(r);
});

/* ── 엣지 위임(RMA) ── */

/** 엣지 카드 목록 — 무보고·시계 오차·ping 판정 방식·미점검 수까지 한 화면에서 본다. */
svcmonRouter.get('/edges', (req, res) => {
  const now = Date.now();
  res.json({
    edges: edgeSummary(now),
    totals: edgeTotals(now),
    limits: { maxAgents: MAX_AGENTS, maxRowsPerAgent: MAX_ROWS_PER_AGENT },
    silence: silenceStatus(),
    // 이 서버가 **엣지로서** 중앙에 보고 중인지도 함께(한 포탈이 양쪽 역할을 겸할 수 있다).
    push: svcmonPushStatus(),
  });
});

/** 엣지 1개의 항목 목록. 메타(경로·대상·호스트)는 엣지가 보내 준 범위만 있다. */
svcmonRouter.get('/edge-state', (req, res) => {
  const r = edgeState(req.query.agent, {
    path: typeof req.query.path === 'string' ? req.query.path.trim() : '',
    limit: Math.min(2000, Math.max(1, Number(req.query.limit) || 500)),
    only: typeof req.query.only === 'string' ? req.query.only.trim() : '',
  });
  if (!r) return res.status(404).json({ error: '그 엣지의 보고가 없습니다.' });
  res.json(r);
});

/**
 * 엣지 통신 진단 — 마지막 보고의 소스 IP 로 ping(ICMP RTT)·TCP 연결(RTT)을 찍는다.
 * 진실의 원천은 '보고가 오는가'다(Active push 는 인바운드를 요구하지 않는다) — 응답에
 * 보고 상태를 함께 싣고, 화면도 그 순서로 보여준다.
 */
svcmonRouter.post('/edges/:agent/probe', canEdit, async (req, res) => {
  const r = await probeAgent(req.params.agent);
  logAudit({
    user: req.user?.username, action: 'svcmon.edge.probe', target: req.params.agent,
    detail: r.ok ? `${r.sourceIp} · ping ${r.ping?.status}/${r.ping?.ms}ms${r.tcp ? ` · tcp:${r.portalPort} ${r.tcp.status}/${r.tcp.ms}ms` : ''}` : (r.reason || '실패'),
  });
  res.status(r.ok ? 200 : 400).json(r);
});

/** 유령 엣지 정리(이름 변경·오타로 남은 항목). 대상 정의는 엣지가 갖고 있으므로 영향 없음. */
svcmonRouter.delete('/edges/:agent', canEdit, (req, res) => {
  if (!forgetAgent(req.params.agent, req.user?.username)) {
    return res.status(404).json({ error: '그 엣지를 찾을 수 없습니다.' });
  }
  res.json({ ok: true, edges: edgeSummary() });
});

/** 이 서버가 엣지일 때 — 즉시 1회 보고(진단용). 재진입 가드는 push 모듈이 공유한다. */
svcmonRouter.post('/push-now', canEdit, async (req, res) => {
  const r = await pushSvcmonNow();
  logAudit({ user: req.user?.username, action: 'svcmon.push.now', detail: r.ok ? `행 ${r.rows} · 청크 ${r.chunks}` : (r.reason || '실패') });
  res.status(r.ok ? 200 : 202).json(r);
});

/** 무보고 감시 즉시 1회(진단용). */
svcmonRouter.post('/silence-check', canEdit, async (req, res) => res.json(await checkSilenceOnce()));

}
