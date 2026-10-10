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
import { analyzeAvailability, TAIL_TOLERANCE_MS } from '../../availability/analyze.js';
import { logCollectOkAt } from '../../logs/poller.js'; // v2.731(A2-01): vCenter 별 마지막 이벤트 수집 성공 시각 — 측정 끝의 근거
import { AVAIL_TYPES, LIFE_TYPES } from '../../vmchanges/eventDetail.js';

const toolsPerm = requirePerm('tools');
const csvPerm = requirePerm('data.csv');
const DAY = 86_400_000;
export const AVAIL_READ_MAX = 50_000;
const qStr = (v, n) => (typeof v === 'string' ? capStr(v.trim(), n) : '');
const daysOf = (v) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) && n >= 1 ? Math.min(90, n) : 30; };
/** 목표 가동률 — 90~100 사이 숫자만. 빈 값·글자는 기본 99.9. */
export function targetOf(v) { const n = numOrNull(v); return n != null && n >= 90 && n <= 100 ? Math.round(n * 1000) / 1000 : 99.9; }

// v2.719(감사 S1-04): 같은 조건의 계산은 60초 동안 화면·CSV 가 함께 쓴다(진행 중이면 합류) — CSV 가 매 요청 이벤트를 다시 읽지 않게.
const RUN_TTL_MS = 60_000;
const RUN_MEMO_MAX = 32;
const _runMemo = new Map();   // key → { at, p }
function runShared(req, snap) {
  const key = JSON.stringify([scopeKey(req.user, snap), qStr(req.query.vcenterId, 128), daysOf(req.query.days), targetOf(req.query.target), qStr(req.query.q, 128), req.query.below === '1']);
  const now = Date.now();
  const hit = _runMemo.get(key);
  if (hit && now - hit.at < RUN_TTL_MS) return hit.p;
  const p = run(req, snap);
  _runMemo.delete(key);
  _runMemo.set(key, { at: now, p });
  p.catch(() => { if (_runMemo.get(key)?.p === p) _runMemo.delete(key); });   // 실패는 기억하지 않는다
  while (_runMemo.size > RUN_MEMO_MAX) _runMemo.delete(_runMemo.keys().next().value);
  return p;
}
export function _resetVmAvailabilityMemoForTest() { _runMemo.clear(); }

/**
 * v2.731(A2-01): 측정 끝을 자르지 않는 허용치 — 로그 수집 주기 × 3 과 1시간 중 큰 것(순수).
 * 한두 주기 실패는 정상 범위로 보고, 그보다 오래 수집이 멈춘 vCenter 만 끝을 자른다. 주기를 못 읽으면 기본 10분으로 본다.
 */
export function tailToleranceOf(settings) {
  const min = numOrNull(settings?.pollIntervalMin);
  const pollMs = (min != null && min > 0 ? min : 10) * 60_000;
  return Math.max(TAIL_TOLERANCE_MS, pollMs * 3);
}

async function run(req, snap) {
  const scoped = scopeSlice(snap, req.user, qStr(req.query.vcenterId, 128) || undefined);
  const ids = (scoped.vcenters || []).map((v) => v.id);
  const days = daysOf(req.query.days);
  const now = Date.now();
  const since = now - days * DAY;
  const db = await getLogsDb();
  // v2.719(감사 S1-04): 시간 조각 + 양보로 읽는다(한 문장 정렬이 이벤트 루프를 멈췄다).
  const rows = ids.length ? await db.opsEventsAsync({ vcenterIds: ids, since, types: [...AVAIL_TYPES, ...LIFE_TYPES.filter((t) => t !== 'VmRemovedEvent' && t !== 'VmRenamedEvent')] }, AVAIL_READ_MAX + 1, { now }) : [];
  const truncated = rows.length > AVAIL_READ_MAX;
  if (truncated) rows.length = AVAIL_READ_MAX;
  // v2.719(감사 B1-01): 최신 먼저 읽어 잘렸으므로 남은 가장 오래된 시각 이전은 모른다 — 그 시각부터만 잰다.
  const readFrom = truncated && rows.length ? rows[rows.length - 1].ts : null;
  const vcName = new Map((scoped.vcenters || []).map((v) => [v.id, v.name || v.id]));
  // v2.731(A2-01): okAt — 로그 폴러가 남긴 그 vCenter 의 마지막 수집 성공(이벤트가 온전한 시각). 측정 끝을 정한다.
  const cov = new Map(ids.map((id) => [id, { firstTs: db.firstTs(id) || null, lastTs: db.lastTs(id) || null, okAt: logCollectOkAt(id) }]));
  const s = loadLogSettings();
  const tailToleranceMs = tailToleranceOf(s);
  const r = analyzeAvailability(rows, scoped.vms, {
    days, now, target: targetOf(req.query.target), vcName, coverageOf: (id) => cov.get(id) || null,
    q: qStr(req.query.q, 128), onlyBelow: req.query.below === '1', readFrom, tailToleranceMs,
  });
  // 잘렸으면 '가장 최근 N건' 만 본 것이다 — v2.719(B1-01): 그 경계(readFrom) 이후만 쟀고 화면이 그 사실을 말한다.
  return { ...r, truncated, readMax: AVAIL_READ_MAX, tailToleranceMs, logs: { enabled: s.enabled, retentionDays: s.retentionDays, minSeverity: s.minSeverity } };
}

export function registerVmAvailability(api) {
  api.get('/tools/vm-availability', toolsPerm, (req, res) => memoJson(req, res, 'vm-availability', async (snap) => ({
    ...(await runShared(req, snap)), initial: snap.initial === true,
  }), { ttlMs: 60_000, extraKey: `${scopeKey(req.user, store.get())}` }));

  api.get('/tools/vm-availability.csv', csvPerm, toolsPerm, async (req, res) => {
    try {
      const r = await runShared(req, store.get());
      const pct = (x) => (x == null ? '' : String(x));
      // v2.731(A2-01): 측정 끝 — 이벤트 수집이 멈춰 잘린 VM 은 그 시각까지만 쟀다(꼬리를 가동으로 세지 않았다).
      const lines = [CSV_BOM + csvLine(['VM', 'vCenter', '클러스터', '가동률(%)', '사람이 끈 정지 제외(%)', '정지 시간(분)', '전원 끔 횟수', '사람이 끈 횟수', '게스트 재부팅', '재설정', 'HA 재시작', '전원 켜기 실패', '측정 시작(UTC)', '측정 구간 짧음', '측정 끝(UTC)', '수집 멈춤으로 끝 잘림'])];
      for (const v of r.vms) {
        lines.push(csvLine([v.name, v.vcenterName, v.cluster, pct(v.availability), pct(v.unplanned), Math.round(v.downMs / 60_000), v.offs, v.userOffs, v.reboots, v.resets, v.ha, v.failed,
          new Date(v.windowFrom).toISOString(), v.partial ? 'Y' : '', Number.isFinite(v.windowTo) ? new Date(v.windowTo).toISOString() : '', v.tailCut ? 'Y' : '']));
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
