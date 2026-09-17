/**
 * 파트 장애(물리 부품 장애) 라우트 — 특수기능 '파트 장애' 화면용(v2.547).
 *
 * 사용자 요청(2026-09-17): "서버 스토리지 등의 모든 장비에 있는 물리 파트 장애가 발생하면
 * 노티를 발생하고 체계적으로 파트 장애를 기록하는 DB 와 화면을 만들고 싶어" +
 * "엣지에서 수집해서 로컬에서 처리하고 장애만 중앙으로 보내게 해줘".
 *
 * 조회 권한: 스토리지 모니터링과 **같은 기준**이다 — 파트 장애는 vCenter 귀속이 없는 인프라
 * 장비(iDRAC·스토리지)의 상태라 범위 제한 계정에 부분집합을 줄 축이 없다. 빈 값을 주면
 * '장애 없음' 이라는 거짓이 되므로 **403 으로 거절**한다(`fullScopeOnly` — v2.525 Horizon 규약).
 *
 * ⚠ 이 라우트는 **장비에 접속하지 않는다**. 이미 수집된 스냅샷만 읽는다(`partfault/scan.js`).
 *   '지금 점검' 도 마찬가지다 — 새 SSH/Redfish 를 열지 않으므로 연타해도 장비 부하가 없다
 *   (그래도 재진입 가드는 폴러와 **공유**한다 — 전이 계산이 겹치면 상태가 꼬인다).
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { PART_STATE_LABEL, PART_STATE_TONE, PART_KIND_LABEL, SCOPE_LABEL,
  KEY_KIND_LABEL, KEY_KIND_NOTE } from '../../partfault/types.js';
import { openFaults, recentEvents, partFaultDbStatus } from '../../partfault/db.js';
import { runPartFaultsNow, partFaultStatus } from '../../partfault/poller.js';
import { partFaultPushStatus } from '../../partfault/push.js';
import { edgeReports } from '../../central/partFaultEdge.js';
import { knownAgentNames } from '../../central/knownAgents.js';
import { config } from '../../config.js';

const toolsPerm = requirePerm('tools');
const writeRole = requireRole('admin', 'operator');
const fullScopeOnly = (req, res, next) => {
  if (scopedVcenterIds(req.user, store.get())) {
    return res.status(403).json({ ok: false, reason: '파트 장애 화면은 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다.' });
  }
  next();
};

/** 화면이 문구를 복사하지 않도록 라벨은 서버가 단일 소스로 내려준다(CLAUDE.md '코어는 하나다'). */
const LABELS = {
  state: PART_STATE_LABEL, tone: PART_STATE_TONE, kind: PART_KIND_LABEL,
  scope: SCOPE_LABEL, keyKind: KEY_KIND_LABEL, keyKindNote: KEY_KIND_NOTE,
};

const STATE_RANK = { fault: 0, warn: 1 };

/**
 * DB 상태를 역할에 맞게 축약한다. **파일 경로는 admin 에게만** —
 * `operator` 는 `tools` 를 기본 보유하므로(v2.500 D/M1 '거부 기본값') 호스트 파일 배치를
 * 그대로 내보내지 않는다. 가린 사실은 `redacted` 로 밝힌다(조용히 빼지 않는다).
 */
function dbView(db, isAdmin) {
  if (!db) return null;
  if (isAdmin) return db;
  const { path: _p, ...rest } = db;
  return { ...rest, redacted: ['path'] };
}

/**
 * 엣지 보고 현황. **보고가 없는 엣지를 '정상' 이라 말하지 않는다** — '모른다' 다
 * (v2.517 규약: "보고가 없는 엣지를 '꺼짐' 이라 말하지 말 것").
 */
function edgeStatus(staleMs) {
  const now = Date.now();
  const rows = edgeReports().map((r) => ({
    agent: r.agent,
    at: r.at || null,
    reportedAt: r.reportedAt || null,
    ageMs: r.at ? now - r.at : null,
    stale: r.at ? (now - r.at) > staleMs : true,
    open: (r.open || []).length,
    omitted: r.omitted || 0,
    scanned: r.scanned || null,
  }));
  const seen = new Set(rows.map((r) => r.agent));
  // 등록돼 있는데 **한 번도 보고하지 않은** 엣지 — 화면이 '장애 없음' 과 구분해 말해야 한다.
  let silent = [];
  try { silent = knownAgentNames().filter((n) => n && !seen.has(n)); } catch { silent = []; }
  return { reports: rows, silent, staleMs };
}

export function registerPartFaults(api) {

/**
 * 열린 장애 + 스캔 요약. 화면의 주 조회.
 * ⚠ 응답에 **'왜 비었는지'를 판정할 재료**를 함께 싣는다 — 열린 장애 0건이
 *   '정상' 인지 '점검이 한 번도 안 돌았다' 인지 '엣지가 보고를 안 한다' 인지는 다른 상황이고
 *   조치가 정반대다(v2.517 `perfEmptyDiag` 와 같은 판단).
 */
api.get('/tools/part-faults', toolsPerm, fullScopeOnly, async (req, res) => {
  const scope = String(req.query.scope || '').trim();
  const [open, st] = await Promise.all([
    openFaults({ scope }).catch(() => []),
    partFaultStatus().catch(() => null),
  ]);
  open.sort((a, b) => (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9)
    || (b.firstSeenAt || 0) - (a.firstSeenAt || 0));
  const summary = { fault: 0, warn: 0 };
  const devices = new Set();
  for (const p of open) { if (summary[p.state] != null) summary[p.state] += 1; devices.add(`${p.scope}:${p.deviceId}`); }
  res.json({
    ok: true,
    open,
    summary: { ...summary, devices: devices.size },
    labels: LABELS,
    poller: st ? { enabled: st.enabled, intervalMs: st.intervalMs, busy: st.busy, last: st.last } : null,
    db: dbView(st ? st.db : await partFaultDbStatus().catch(() => null), req.user?.role === 'admin'),
    edges: edgeStatus(3 * 3_600_000),
    // 이 노드가 엣지면 중앙으로 push 하는 쪽이라 화면 문구가 달라진다(중앙 DB 가 아니라 push 상태를 본다).
    role: config.agent.centralUrl ? 'edge' : 'central',
    push: config.agent.centralUrl ? partFaultPushStatus() : null,
  });
});

/** 전이 이력(열림/변화/해소). **전이만** 기록되므로 그대로 시간순 목록이다. */
api.get('/tools/part-faults/events', toolsPerm, fullScopeOnly, async (req, res) => {
  const days = Math.min(730, Math.max(1, Number(req.query.days) || 30));
  const limit = Math.min(2_000, Math.max(1, Number(req.query.limit) || 500));
  const partKey = String(req.query.partKey || '').trim();
  const events = await recentEvents({ sinceMs: days * 86_400_000, limit, partKey }).catch(() => []);
  res.json({
    ok: true, events, days, limit, labels: LABELS,
    // ⚠ 상한으로 잘렸으면 밝힌다(조용한 상한 금지 — CLAUDE.md 규약).
    truncated: events.length >= limit,
    db: dbView(await partFaultDbStatus().catch(() => null), req.user?.role === 'admin'),
  });
});

/**
 * 지금 점검(수동). 폴러와 **같은 재진입 가드**를 공유한다 — 겹치면 전이가 꼬인다.
 * ⚠ 장비 왕복이 없으므로 '자동 재시도 금지'(계정 잠금) 규칙의 대상이 아니다.
 */
api.post('/tools/part-faults/scan', writeRole, toolsPerm, fullScopeOnly, async (req, res) => {
  const r = await runPartFaultsNow({ notify: true });
  logAudit({
    user: req.user?.username, action: '파트 장애 지금 점검',
    detail: r.ok ? `신규 ${r?.stats?.opened ?? 0} · 해소 ${r?.stats?.closed ?? 0} · 변화 ${r?.stats?.changed ?? 0}` : String(r.reason || '실패'),
  });
  res.status(r.ok ? 200 : 409).json(r);
});

/** 상태 — 폴러·DB·push·엣지 보고를 한 번에(진단 화면용). */
api.get('/tools/part-faults/status', toolsPerm, fullScopeOnly, async (req, res) => {
  const st = await partFaultStatus().catch((e) => ({ error: String(e.message || e).slice(0, 200) }));
  res.json({
    ok: true, ...st, db: dbView(st.db, req.user?.role === 'admin'),
    role: config.agent.centralUrl ? 'edge' : 'central',
    push: config.agent.centralUrl ? partFaultPushStatus() : null,
    edges: edgeStatus(3 * 3_600_000),
  });
});

}
