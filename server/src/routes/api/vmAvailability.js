/**
 * routes/api/vmAvailability.js — 특수 기능 'VM 가용성(SLA)'(도구 키 `vm-availability`, v2.707 — C6) API.
 * 원천은 logs DB 의 전원·가용성 이벤트(부분 인덱스 idx_events_ops) + 스냅샷 VM 현재 전원 상태. vCenter 왕복 0.
 * 권한: tools + toolGate('vm-availability') + vCenter 범위 · CSV data.csv + 감사 로그. 화면은 폴링하지 않는다.
 */
import { requirePerm } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { store } from '../../store.js';
import { scopeSlice, memoJson, scopeKey } from './shared.js';
import { capStr } from '../../util/capStr.js';
import { numOrNull } from '../../util/numOrNull.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { fileStamp } from '../../util/dayKey.js';
import { getLogsDb } from '../../logs/db.js';
import { loadLogSettings } from '../../logs/settings.js';
import { analyzeAvailability } from '../../availability/analyze.js';
import { AVAIL_TYPES, LIFE_TYPES } from '../../vmchanges/eventDetail.js';

const toolsPerm = requirePerm('tools');
const csvPerm = requirePerm('data.csv');
const DAY = 86_400_000;
export const AVAIL_READ_MAX = 50_000;
const qStr = (v, n) => (typeof v === 'string' ? capStr(v.trim(), n) : '');
const daysOf = (v) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) && n >= 1 ? Math.min(90, n) : 30; };
/** 목표 가동률 — 90~100 사이 숫자만. 빈 값·글자는 기본 99.9. */
export function targetOf(v) { const n = numOrNull(v); return n != null && n >= 90 && n <= 100 ? Math.round(n * 1000) / 1000 : 99.9; }

async function run(req, snap) {
  const scoped = scopeSlice(snap, req.user, qStr(req.query.vcenterId, 128) || undefined);
  const ids = (scoped.vcenters || []).map((v) => v.id);
  const days = daysOf(req.query.days);
  const now = Date.now();
  const since = now - days * DAY;
  const db = await getLogsDb();
  const rows = ids.length ? db.opsEvents({ vcenterIds: ids, since, types: [...AVAIL_TYPES, ...LIFE_TYPES.filter((t) => t !== 'VmRemovedEvent' && t !== 'VmRenamedEvent')] }, AVAIL_READ_MAX + 1) : [];
  const truncated = rows.length > AVAIL_READ_MAX;
  if (truncated) rows.length = AVAIL_READ_MAX;
  const vcName = new Map((scoped.vcenters || []).map((v) => [v.id, v.name || v.id]));
  const cov = new Map(ids.map((id) => [id, { firstTs: db.firstTs(id) || null, lastTs: db.lastTs(id) || null }]));
  const r = analyzeAvailability(rows, scoped.vms, {
    days, now, target: targetOf(req.query.target), vcName, coverageOf: (id) => cov.get(id) || null,
    q: qStr(req.query.q, 128), onlyBelow: req.query.below === '1',
  });
  const s = loadLogSettings();
  // 잘렸으면 '가장 최근 N건' 만 본 것이다 — 앞쪽 정지가 빠졌을 수 있으므로 화면이 그 사실을 말한다.
  return { ...r, truncated, readMax: AVAIL_READ_MAX, logs: { enabled: s.enabled, retentionDays: s.retentionDays, minSeverity: s.minSeverity } };
}

export function registerVmAvailability(api) {
  api.get('/tools/vm-availability', toolsPerm, (req, res) => memoJson(req, res, 'vm-availability', async (snap) => ({
    ...(await run(req, snap)), initial: snap.initial === true,
  }), { ttlMs: 60_000, extraKey: `${scopeKey(req.user, store.get())}` }));

  api.get('/tools/vm-availability.csv', csvPerm, toolsPerm, async (req, res) => {
    try {
      const r = await run(req, store.get());
      const pct = (x) => (x == null ? '' : String(x));
      const lines = [CSV_BOM + csvLine(['VM', 'vCenter', '클러스터', '가동률(%)', '사람이 끈 정지 제외(%)', '정지 시간(분)', '전원 끔 횟수', '사람이 끈 횟수', '게스트 재부팅', '재설정', 'HA 재시작', '전원 켜기 실패', '측정 시작(UTC)', '측정 구간 짧음'])];
      for (const v of r.vms) {
        lines.push(csvLine([v.name, v.vcenterName, v.cluster, pct(v.availability), pct(v.unplanned), Math.round(v.downMs / 60_000), v.offs, v.userOffs, v.reboots, v.resets, v.ha, v.failed,
          new Date(v.windowFrom).toISOString(), v.partial ? 'Y' : '']));
      }
      logAudit({ user: req.user?.username, action: 'vm-availability.csv', target: 'vm-availability', detail: `${lines.length - 1} rows · ${r.days}d`, ip: req.ip });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="vm-availability-${fileStamp()}.csv"`);
      res.send(lines.join('\r\n'));
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
    }
  });
}
