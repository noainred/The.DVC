/**
 * routes/api/vmLifecycle.js — 특수 기능 'VM 생성·삭제 이력'(도구 키 `vm-lifecycle`, v2.706 — C5) API.
 * 원천은 vCenter 로그 수집이 쌓은 logs DB 의 생성·복제·배포·등록·삭제·이름 변경 이벤트(부분 인덱스 idx_events_ops). vCenter 왕복 0.
 * 권한: tools + toolGate('vm-lifecycle') + vCenter 범위(형제 /tools/vm-changes 와 같다) · CSV data.csv + 감사 로그.
 * 화면은 폴링하지 않는다(마운트 1회 + 새로고침).
 */
import { requirePerm } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { store } from '../../store.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { memoJson, scopeKey } from './shared.js';
import { capStr } from '../../util/capStr.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { fileStamp } from '../../util/dayKey.js';
import { getLogsDb } from '../../logs/db.js';
import { loadLogSettings } from '../../logs/settings.js';
import { analyzeLifecycle, kindOfLife } from '../../vmlife/analyze.js';
import { LIFE_TYPES, parseDetail } from '../../vmchanges/eventDetail.js';

const toolsPerm = requirePerm('tools');
const csvPerm = requirePerm('data.csv');
const DAY = 86_400_000;
export const LIFE_READ_MAX = 20_000;
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
  const rows = ids.length ? db.opsEvents({ vcenterIds: ids, since, types: [...LIFE_TYPES] }, LIFE_READ_MAX + 1) : [];
  const truncated = rows.length > LIFE_READ_MAX;
  if (truncated) rows.length = LIFE_READ_MAX;
  const vcName = new Map((snap.vcenters || []).map((v) => [v.id, v.name || v.id]));
  const coverage = ids.slice(0, 200).map((id) => ({ vcenterId: id, name: vcName.get(id) || id, lastTs: db.lastTs(id) || null }));
  const s = loadLogSettings();
  return { rows, truncated, days, since, vcName, ids, coverage, settings: { enabled: s.enabled, retentionDays: s.retentionDays, pollIntervalMin: s.pollIntervalMin, minSeverity: s.minSeverity } };
}

/** 지금 인벤토리의 VM 이름(vCenter 별) — 이벤트의 VM 이 지금도 있는지 이름으로만 본다. 첫 수집 중이면 모른다(null). */
function liveNamesOf(snap, ids) {
  if (snap.initial === true) return null;
  const set = new Set(ids);
  const m = new Map();
  for (const v of snap.vms || []) {
    if (!set.has(v.vcenterId)) continue;
    let s = m.get(v.vcenterId); if (!s) { s = new Set(); m.set(v.vcenterId, s); }
    s.add(v.name);
  }
  for (const id of ids) if (!m.has(id)) m.set(id, new Set());
  return m;
}

export function registerVmLifecycle(api) {
  api.get('/tools/vm-lifecycle', toolsPerm, (req, res) => memoJson(req, res, 'vm-lifecycle', async (snap) => {
    const L = await load(req, snap);
    return {
      days: L.days, since: L.since, truncated: L.truncated, readMax: LIFE_READ_MAX,
      vcenters: L.coverage, logs: L.settings,
      life: analyzeLifecycle(L.rows, { days: L.days, vcName: L.vcName, q: qStr(req.query.q, 128), kind: qStr(req.query.kind, 16), liveNames: liveNamesOf(snap, L.ids) }),
      initial: snap.initial === true,
    };
  }, { ttlMs: 30_000, extraKey: `${scopeKey(req.user, store.get())}` }));

  api.get('/tools/vm-lifecycle.csv', csvPerm, toolsPerm, async (req, res) => {
    try {
      const L = await load(req, store.get());
      const fmt = (ts) => new Date(ts).toISOString();
      const lines = [CSV_BOM + csvLine(['시각(UTC)', 'vCenter', 'VM', '종류', '사용자', '호스트', '데이터스토어', '원본', '이전 이름', '새 이름', '메시지'])];
      for (const r of L.rows) {
        const d = parseDetail(r.detail);
        lines.push(csvLine([fmt(r.ts), L.vcName.get(r.vcenterId) || r.vcenterId, r.entity, kindOfLife(r.type, d) || r.type, r.user || '',
          d?.host || '', d?.ds || '', d?.source || '', d?.oldName || '', d?.newName || '', r.message || '']));
      }
      logAudit({ user: req.user?.username, action: 'vm-lifecycle.csv', target: 'vm-lifecycle', detail: `${lines.length - 1} rows · ${L.days}d${L.truncated ? ' (truncated)' : ''}`, ip: req.ip });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="vm-lifecycle-${fileStamp()}.csv"`);
      if (L.truncated) res.setHeader('X-Truncated', String(LIFE_READ_MAX));
      res.send(lines.join('\r\n'));
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
    }
  });
}
