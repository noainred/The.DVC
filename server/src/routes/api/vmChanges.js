/**
 * routes/api/vmChanges.js — 특수 기능 'VM 이동·구성 변경 이력'(도구 키 `vm-changes`, v2.702 — A7·A8) API.
 * 원천은 vCenter 로그 수집이 쌓은 logs DB 의 이동·구성 변경·권한 이벤트(부분 인덱스 idx_events_tracked). vCenter 왕복 0.
 * 권한: tools + toolGate('vm-changes') + vCenter 범위(형제 /tools/vclogs 와 같다) · CSV data.csv + 감사 로그.
 * `/tools/vm-changes/of` 는 VM 상세 창이 그 VM 하나를 묻는 경로다(범위 밖 VM 은 404 — 존재 은닉).
 * 화면은 폴링하지 않는다(마운트 1회 + 새로고침).
 */
import { requirePerm } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { store } from '../../store.js';
import { scopedVcenterIds, inUserScope } from '../../auth/scope.js';
import { memoJson, scopeKey } from './shared.js';
import { capStr } from '../../util/capStr.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { fileStamp } from '../../util/dayKey.js';
import { getLogsDb } from '../../logs/db.js';
import { loadLogSettings } from '../../logs/settings.js';
import { eventNotCollectedMap, notCollectedList } from '../../logs/coverage.js'; // v2.733(C1-01): 지금 이벤트를 수집하지 않는 vCenter
import { analyzeMoves, analyzeChanges, vmHistory } from '../../vmchanges/analyze.js';
import { MOVE_TYPES, RECONFIG_TYPES, PERM_TYPES } from '../../vmchanges/eventDetail.js';

const toolsPerm = requirePerm('tools');
const csvPerm = requirePerm('data.csv');
const DAY = 86_400_000;
export const READ_MAX = 20_000;
const qStr = (v, n) => (typeof v === 'string' ? capStr(v.trim(), n) : '');
const daysOf = (v) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) && n >= 1 ? Math.min(90, n) : 7; };

async function load(req, snap) {
  const allowed = scopedVcenterIds(req.user, snap);
  const reqVc = qStr(req.query.vcenterId, 128);
  let ids = (snap.vcenters || []).map((v) => v.id);
  if (allowed) ids = ids.filter((id) => allowed.has(id));
  if (reqVc) ids = ids.filter((id) => id === reqVc);
  const days = daysOf(req.query.days);
  const since = Date.now() - days * DAY;
  const db = await getLogsDb();
  // v2.727(감사 F-01): 화면·CSV 둘 다 1일 조각 + 양보로 읽는다(한 문장 판은 기간 안 일치 행 전부를 TEMP B-TREE 로 흘려 동기 정지).
  //   결과(행·순서·상한)는 trackedEvents 와 같다 — `/of`(entity 전용 인덱스, 행이 적다)만 동기 판을 그대로 쓴다.
  const rows = ids.length ? await db.trackedEventsAsync({ vcenterIds: ids, since }, READ_MAX + 1) : [];
  const truncated = rows.length > READ_MAX;
  if (truncated) rows.length = READ_MAX;
  const vcName = new Map((snap.vcenters || []).map((v) => [v.id, v.name || v.id]));
  const s = loadLogSettings();
  // 수집 범위 — vCenter 마다 마지막으로 받은 이벤트 시각(없으면 그 vCenter 의 이벤트는 이 포탈에 없다).
  // v2.733(점검 3회차 C1-01): 이 포탈이 지금 이벤트를 수집하지 않는 vCenter(엣지 위임·비활성·점검중)는 항목에 notCollected(사유)를 싣는다 —
  //   lastTs 가 남아 있어도(수집을 멈추기 전 이벤트) '없음' 이 아니라 '지금 수집하지 않는다' 다. 목록(notCollected)은 범위로 이미 거른 ids 기준.
  const nc = eventNotCollectedMap();
  const coverage = ids.slice(0, 200).map((id) => ({ vcenterId: id, name: vcName.get(id) || id, lastTs: db.lastTs(id) || null, ...(nc.has(id) ? { notCollected: nc.get(id) } : {}) }));
  const notCollected = notCollectedList(nc, { only: ids, names: vcName });
  return { rows, truncated, days, since, vcName, ids, coverage, notCollected, settings: { enabled: s.enabled, retentionDays: s.retentionDays, pollIntervalMin: s.pollIntervalMin, minSeverity: s.minSeverity } };
}

export function registerVmChanges(api) {
  api.get('/tools/vm-changes', toolsPerm, (req, res) => memoJson(req, res, 'vm-changes', async (snap) => {
    const L = await load(req, snap);
    const q = qStr(req.query.q, 128);
    const kind = qStr(req.query.kind, 16);
    return {
      days: L.days, since: L.since, truncated: L.truncated, readMax: READ_MAX,
      vcenters: L.coverage, notCollected: L.notCollected, logs: L.settings,
      moves: analyzeMoves(L.rows, { days: L.days, vcName: L.vcName, q }),
      changes: analyzeChanges(L.rows, { vcName: L.vcName, q, kind }),
      initial: snap.initial === true,
    };
  }, { ttlMs: 30_000, extraKey: `${scopeKey(req.user, store.get())}` }));

  api.get('/tools/vm-changes/of', toolsPerm, async (req, res) => {
    try {
      const snap = store.get();
      const vmId = qStr(req.query.vmId, 256);
      const vm = (snap.vms || []).find((v) => v.id === vmId);
      if (!vm || !inUserScope(req.user, snap, vm.vcenterId)) return res.status(404).json({ ok: false, reason: 'not-found' });
      const db = await getLogsDb();
      const days = Math.min(90, daysOf(req.query.days || 30));
      const rows = db.trackedEvents({ vcenterIds: [vm.vcenterId], since: Date.now() - days * DAY, entity: vm.name, types: [...MOVE_TYPES, ...RECONFIG_TYPES] }, 200);
      // v2.733(C1-01): 이 VM 의 vCenter 를 이 포탈이 지금 이벤트로 수집하지 않으면 그 사유(아니면 null) — 화면이 '변경 없음' 대신 말한다.
      const notCollected = eventNotCollectedMap().get(String(vm.vcenterId)) || null;
      res.json({ ok: true, days, items: vmHistory(rows, 20), more: Math.max(0, rows.length - 20), logs: { enabled: loadLogSettings().enabled }, lastTs: db.lastTs(vm.vcenterId) || null, notCollected });
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
    }
  });

  api.get('/tools/vm-changes.csv', csvPerm, toolsPerm, async (req, res) => {
    try {
      const L = await load(req, store.get());
      const kind = qStr(req.query.kind, 16) === 'changes' ? 'changes' : 'moves';
      const fmt = (ts) => new Date(ts).toISOString();
      const lines = [];
      if (kind === 'moves') {
        lines.push(CSV_BOM + csvLine(['시각(UTC)', 'vCenter', 'VM', '종류', '출발 호스트', '도착 호스트', '출발 데이터스토어', '도착 데이터스토어', '사용자']));
        for (const r of L.rows) {
          if (!MOVE_TYPES.includes(r.type)) continue;
          let d = null; try { d = r.detail ? JSON.parse(r.detail) : null; } catch { d = null; }
          lines.push(csvLine([fmt(r.ts), L.vcName.get(r.vcenterId) || r.vcenterId, r.entity, d?.kind || r.type, d?.from || '', d?.to || '', d?.fromDs || '', d?.toDs || '', r.user || '']));
        }
      } else {
        lines.push(CSV_BOM + csvLine(['시각(UTC)', 'vCenter', '대상', '종류', '사용자', '변경 내용', '메시지']));
        for (const r of L.rows) {
          if (!RECONFIG_TYPES.includes(r.type) && !PERM_TYPES.includes(r.type)) continue;
          let d = null; try { d = r.detail ? JSON.parse(r.detail) : null; } catch { d = null; }
          const what = d ? [d.modified, d.added, d.deleted, d.principal && `${d.principal}${d.role ? ` → ${d.role}` : ''}`].filter(Boolean).join(' / ') : '';
          lines.push(csvLine([fmt(r.ts), L.vcName.get(r.vcenterId) || r.vcenterId, r.entity, r.type, r.user || '', what, r.message || '']));
        }
      }
      logAudit({ user: req.user?.username, action: 'vm-changes.csv', target: kind, detail: `${lines.length - 1} rows · ${L.days}d${L.truncated ? ' (truncated)' : ''}`, ip: req.ip });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="vm-${kind}-${fileStamp()}.csv"`);
      if (L.truncated) res.setHeader('X-Truncated', String(READ_MAX));
      res.send(lines.join('\r\n'));
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
    }
  });
}
