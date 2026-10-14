/**
 * routes/api/xferSpeed.js — 특수 기능 '법인 간 전송 속도' 화면 API(v2.735).
 *
 * 사용자 요청(2026-10-13): "main 서버와 edge 포탈간에 30분에 1번씩 10MB 파일을 전송해서 법인간 전송 속도를 테스트해서
 * 기록 … DB 로 저장해서 히스토리 보는 기능을 특수기능에".
 *
 * ── 권한: adminOnly + fullScopeOnly ─────────────────────────────────────────
 * 응답에 전 법인 엣지 이름·주소(origin)·측정 오류 원문이 들어간다. operator 는 `tools` 를 기본 보유하므로 `requirePerm('tools')`
 * 만으로는 전 법인 회선 정보가 열린다 — 통신 점검(v2.552)·엣지 로그(v2.549)와 같은 기준이다. 엣지는 vCenter 귀속이 아니라
 * 범위 계정에 나눌 축이 없다 → 403(v2.525 규약). CSV 는 + `data.csv`.
 *
 * ── 이 라우트가 하지 않는 것 ────────────────────────────────────────────────
 *  · 조회는 DB·등록부만 읽는다 — 장비·엣지 왕복 0. 측정은 폴러가 주기로, 또는 '지금 측정' 으로만 한다.
 *  · 요청 본문의 url·token 을 받지 않는다 — 대상은 수집 서버 등록부에서만(v2.480).
 *  · 응답에 토큰을 싣지 않는다. 주소는 origin 만(경로·쿼리에 토큰이 실릴 수 있다 — v2.584 통신 지도와 같은 판단).
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { loadCollectors } from '../../collector/registry.js';
import { allCollectorStatus } from '../../collector/state.js';
import { cmpVersion } from '../../util/cmpVersion.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { fileStamp, localStamp, dayKey, DAY_OFFSET_MIN } from '../../util/dayKey.js';
import { numOrNull } from '../../util/numOrNull.js';
import { loadXferSpeedSettings, saveXferSpeedSettings, xferSpeedEnabled, xferSettingsLoadError, DEFAULTS, RANGES } from '../../xferspeed/settings.js';
import { xferSpeedStatus, xferTargets, startXferRun } from '../../xferspeed/poller.js';
import { latestAll, samplesSince, recentFailures, dailyOf, exportRows, dbStatus } from '../../xferspeed/db.js';
import { edgeRows, kpisOf, trafficOf, heatOf, seriesOf, dailySeriesOf, statsOf, staleMsOf, latencyMsOf, MIN_BASELINE, BASELINE_DAYS } from '../../xferspeed/analyze.js';
import { MIN_XFER_EDGE_VERSION, XFER_FAIL_KINDS } from '../../xferspeed/probe.js';
import { SCHEDULE_KINDS, SCHEDULE_MAX, GRACE_MS, MISSED_REASONS } from '../../xferspeed/schedule.js';

const adminOnly = requireRole('admin');
const csvPerm = requirePerm('data.csv');
const fullScopeOnly = fullScopeOnlyWith('전송 속도 화면은 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다 — 전 법인 엣지의 주소·측정 기록이 들어갑니다.');

const DAY = 86_400_000;
const t = (v) => String(v ?? '').trim();
const originOf = (c) => { try { return new URL(t(c?.url)).origin; } catch { return null; } };
/** 원시로 그리는 최대 일수 — 넘으면 일 요약(하루 평균·최저·최고)이다. 화면이 그 사실을 말한다. */
export const RAW_MAX_DAYS = 31;
const HISTORY_MAX_DAYS = 3650;

/** 등록부 이름·id → 엣지 버전(통신 점검과 같은 규칙 — id 와 엣지가 보고한 agent 둘 다 키로). */
function versionMap() {
  const out = new Map();
  for (const [id, st] of Object.entries(allCollectorStatus() || {})) {
    const ver = t(st?.version);
    if (!ver) continue;
    if (t(id)) out.set(t(id).toLowerCase(), ver);
    if (t(st?.agent)) out.set(t(st.agent).toLowerCase(), ver);
  }
  return out;
}

/** 이 이름이 등록부나 측정 기록에 있는가(대소문자 무시) — 있으면 저장 표기를 돌려준다. */
async function resolveAgent(name) {
  const k = t(name).toLowerCase();
  if (!k) return null;
  for (const c of loadCollectors()) {
    const id = t(c?.id || c?.name);
    if (id.toLowerCase() === k || t(c?.name).toLowerCase() === k) return { id, col: c };
  }
  for (const r of await latestAll()) if (t(r.agent).toLowerCase() === k) return { id: t(r.agent), col: null };
  return null;
}

const daysArg = (v, def, max) => {
  const n = numOrNull(v);
  if (n == null) return def;
  return Math.max(1, Math.min(max, Math.floor(n)));
};

export function registerXferSpeed(api) {

/** 메인 — 법인별 최신값·평소 대비·24시간 스파크라인·KPI·회선 사용 산수·최근 실패. */
api.get('/tools/xfer-speed', adminOnly, fullScopeOnly, async (_req, res) => {
  const now = Date.now();
  const s = loadXferSpeedSettings();
  const cols = loadCollectors();
  const latest = await latestAll();
  const recent = await samplesSince(now - BASELINE_DAYS * DAY);
  const rows = edgeRows({ collectors: cols, latest, recent: recent.rows, settings: s, now, originOf });
  const vers = versionMap();
  for (const r of rows) {
    const v = vers.get(t(r.id).toLowerCase()) || vers.get(t(r.name).toLowerCase()) || null;
    r.edgeVersion = v;
    const c = v ? cmpVersion(v, MIN_XFER_EDGE_VERSION) : null;
    r.edgeOld = c == null ? null : c < 0;
  }
  const names = new Map(rows.map((r) => [t(r.id).toLowerCase(), r.name]));
  const failures = (await recentFailures(now - BASELINE_DAYS * DAY, 12)).map((f) => ({
    agent: f.agent, name: names.get(t(f.agent).toLowerCase()) || f.agent, dir: f.dir, ts: f.ts, kind: f.kind, error: f.err || '',
    totalMs: numOrNull(f.total_ms), bytes: numOrNull(f.bytes),
  }));
  const { targets, skipped } = xferTargets(cols, s);
  res.json({
    ok: true, now,
    enabled: xferSpeedEnabled(s), settings: s, defaults: DEFAULTS, ranges: RANGES, settingsLoadError: xferSettingsLoadError(),
    status: xferSpeedStatus(now),
    scheduleRules: { kinds: SCHEDULE_KINDS, max: SCHEDULE_MAX, graceMs: GRACE_MS, missedReasons: MISSED_REASONS },
    kpis: kpisOf(rows), rows,
    traffic: trafficOf(s, targets.length), skippedTargets: skipped,
    failures, failKinds: XFER_FAIL_KINDS,
    minEdgeVersion: MIN_XFER_EDGE_VERSION, staleMs: staleMsOf(s, { now }),
    baseline: { days: BASELINE_DAYS, minSamples: MIN_BASELINE }, offsetMin: DAY_OFFSET_MIN,
    recentTruncated: recent.truncated,
    db: await dbStatus(),
  });
});

/** 시간대 히트맵 — 엣지 × 24시간(포탈 시각) × 방향. 칸 = 그 시간 평균 ÷ 그 엣지 기간 중앙값. */
api.get('/tools/xfer-speed/heat', adminOnly, fullScopeOnly, async (req, res) => {
  const days = daysArg(req.query.days, 14, 30);
  const r = await samplesSince(Date.now() - days * DAY);
  res.json({ ok: true, days, offsetMin: DAY_OFFSET_MIN, rows: heatOf(r.rows), truncated: r.truncated });
});

/** 한 엣지의 추이 — 31일 이하는 원시(30분 1점), 넘으면 일 요약. 측정 기록(최근 40건)은 언제나 원시. */
api.get('/tools/xfer-speed/history', adminOnly, fullScopeOnly, async (req, res) => {
  const a = await resolveAgent(req.query.agent);
  if (!a) return res.status(404).json({ ok: false, reason: '등록부와 측정 기록 어디에도 없는 엣지입니다.' });
  const days = daysArg(req.query.days, 7, HISTORY_MAX_DAYS);
  const now = Date.now();
  const since = now - days * DAY;
  let source; let series; let stats; let truncated = false;
  if (days <= RAW_MAX_DAYS) {
    const r = await samplesSince(since, { agent: a.id, limit: 100_000 });
    truncated = r.truncated;
    source = 'raw';
    series = seriesOf(r.rows);
    stats = { down: statsOf(r.rows.filter((x) => x.dir === 'down')), up: statsOf(r.rows.filter((x) => x.dir === 'up')) };
  } else {
    const d = await dailyOf(a.id, dayKey(since));
    source = 'daily';
    series = dailySeriesOf(d);
    const agg = (dir) => {
      const rows = d.filter((x) => x.dir === dir);
      const n = rows.reduce((s2, x) => s2 + (numOrNull(x.n) ?? 0), 0);
      const okN = rows.reduce((s2, x) => s2 + (numOrNull(x.ok_n) ?? 0), 0);
      const sum = rows.reduce((s2, x) => s2 + (numOrNull(x.mbps_sum) ?? 0), 0);
      const mins = rows.map((x) => numOrNull(x.mbps_min)).filter((v) => v != null);
      const maxs = rows.map((x) => numOrNull(x.mbps_max)).filter((v) => v != null);
      return {
        n, ok: okN, okRate: n ? Math.round((okN / n) * 10_000) / 100 : null,
        avg: okN ? Math.round((sum / okN) * 100) / 100 : null,
        min: mins.length ? Math.min(...mins) : null, max: maxs.length ? Math.max(...maxs) : null,
        median: null, p10: null, ttfbMedian: null,   // 일 요약에서는 분위수를 만들 수 없다(지어내지 않는다)
      };
    };
    stats = { down: agg('down'), up: agg('up') };
  }
  const logR = await samplesSince(now - 14 * DAY, { agent: a.id, limit: 100_000 });
  const log = logR.rows.slice(-40).reverse().map((x) => ({
    ts: x.ts, dir: x.dir, ok: Number(x.ok) === 1, mbps: Number(x.ok) === 1 ? numOrNull(x.mbps) : null,
    ttfbMs: latencyMsOf(x), totalMs: numOrNull(x.total_ms), xferMs: numOrNull(x.xfer_ms), bytes: numOrNull(x.bytes),
    basis: x.basis || null, kind: x.kind || null, error: x.err || '',
  }));
  const col = a.col;
  res.json({
    ok: true, agent: a.id, name: t(col?.name) || a.id, datacenter: t(col?.datacenter), origin: col ? originOf(col) : null, registered: !!col,
    days, source, rawMaxDays: RAW_MAX_DAYS, series, stats, log, truncated, offsetMin: DAY_OFFSET_MIN,
  });
});

/** 지금 측정 — 기다리지 않고 시작만 한다(한 주기가 수 분 걸린다). 화면은 메인 응답의 status.progress 로 진행을 본다. */
api.post('/tools/xfer-speed/run', adminOnly, fullScopeOnly, async (req, res) => {
  const want = t(req.body?.agent);
  let only = '';
  if (want) {
    const a = await resolveAgent(want);
    if (!a?.col) return res.status(404).json({ ok: false, reason: '수집 서버 등록부에 없는 엣지입니다.' });
    only = a.id;
  }
  const r = startXferRun({ only });
  if (!r.ok) {
    const reason = r.reason === 'already-running' ? '이미 측정 중입니다 — 끝난 뒤 다시 누르세요.' : r.reason === 'edge-node' ? '엣지 노드에서는 측정하지 않습니다(측정은 중앙이 주도합니다).' : String(r.reason || '시작하지 못했습니다');
    return res.status(409).json({ ok: false, busy: r.reason === 'already-running', reason });
  }
  logAudit({ user: req.user?.username, action: 'xfer-speed.run', target: only || '(전체)', ip: req.ip });
  res.status(202).json({ ok: true, started: true, only: only || null });
});

/** 설정 저장 — 보낸 칸만, 빈 숫자 칸은 이전 값 유지. 전 법인 공통 설정이라 전체 범위 관리자만. */
api.put('/tools/xfer-speed/settings', adminOnly, fullScopeOnly, (req, res) => {
  const before = loadXferSpeedSettings();
  let next;
  try { next = saveXferSpeedSettings(req.body || {}); } catch (e) {
    // 잘못된 일정은 고치지 않고 돌려준다 — 몇 번째 일정의 어느 칸인지 화면이 말한다.
    if (e?.code === 'bad-schedule') return res.status(400).json({ ok: false, reason: e.message, field: 'schedules', errors: e.errors || [] });
    throw e;
  }
  const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
  logAudit({ user: req.user?.username, action: 'xfer-speed.settings', target: 'xfer-speed', detail: changed.length ? `바뀐 항목: ${changed.join(', ')}` : '변경 없음', ip: req.ip });
  res.json({ ok: true, settings: next, enabled: xferSpeedEnabled(next), changed });
});

/** CSV — 기간 안 원시 측정 전체(상한 20만 행, 넘으면 머리에 밝힌다). */
api.get('/tools/xfer-speed/export.csv', adminOnly, fullScopeOnly, csvPerm, async (req, res) => {
  const days = daysArg(req.query.days, 30, 730);
  let agent = '';
  if (t(req.query.agent)) {
    const a = await resolveAgent(req.query.agent);
    if (!a) return res.status(404).json({ ok: false, reason: '등록부와 측정 기록 어디에도 없는 엣지입니다.' });
    agent = a.id;
  }
  const r = await exportRows(Date.now() - days * DAY, { agent });
  const head = ['시각(포탈)', '엣지', '방향', '결과', '속도(Mbps)', '바이트', '전송(ms)', '전체(ms)', '지연(ms)', '계산 기준', '실패 종류', '사유', '실행'];
  const lines = [CSV_BOM + csvLine(head)];
  for (const x of r.rows) {
    lines.push(csvLine([
      localStamp(x.ts), x.agent, x.dir === 'down' ? '엣지→메인' : '메인→엣지', Number(x.ok) === 1 ? '성공' : '실패',
      Number(x.ok) === 1 ? x.mbps : '', x.bytes ?? '', x.xfer_ms ?? '', x.total_ms ?? '', latencyMsOf(x) ?? '',
      x.basis || '', x.kind || '', x.err || '', x.trig || '',
    ]));
  }
  if (r.truncated) lines.push(csvLine([`(상한 ${r.rows.length}행에서 잘랐습니다 — 기간을 줄이세요)`]));
  logAudit({ user: req.user?.username, action: 'xfer-speed.csv', target: agent || '(전체)', detail: `${days}일 ${r.rows.length}행${r.truncated ? ' (잘림)' : ''}`, ip: req.ip });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="xfer-speed-${fileStamp()}.csv"`);
  res.send(lines.join('\r\n'));
});

}
