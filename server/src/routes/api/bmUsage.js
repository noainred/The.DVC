/**
 * routes/api/bmUsage.js — 특수기능 '베어메탈 사용률' 화면 API(v2.550).
 *
 * 사용자 요청(2026-09-17): "여기에 분류된 서버들만 CPU memory disk Network HBA 사용율을 수집하고 싶어"
 * (서버 분석 › 구분 › **Baremetal(미가상화 물리)**).
 *
 * ── 권한: `tools` + **vCenter scope** ───────────────────────────────────────
 * 베어메탈은 `vcenterId`(법인) 축이 **있다** — 그래서 스토리지·Horizon 처럼 403 으로 거절하지 않고
 * 범위 계정에는 그 법인 것만 준다(CLAUDE.md '조회 라우트 scope 는 예외 없이').
 * ⚠ **법인 귀속이 없는 베어메탈은 범위 계정에 노출하지 않는다**('귀속 없는 데이터 미노출' 불변조건).
 *
 * ⚠ **자격증명을 응답에 싣지 않는다** — `targets.publicTarget()` 을 통과한 것만 내보낸다
 *   (`server/CLAUDE.md`: "비밀 값은 어떤 API 응답에도 싣지 않는다").
 * ⚠ **폴링 금지** — '지금 수집' 은 SSH·Redfish 왕복이다. 화면은 마운트 1회 + 버튼(v2.508 규약).
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { loadBmUsageSettings, saveBmUsageSettings, bmUsageEnabled, DEFAULTS } from '../../bmusage/settings.js';
import { publicTarget, NO_PATH_REASON } from '../../bmusage/targets.js';
import { currentTargets, pollBmUsageOnce, bmUsageStatus, authStopsFor } from '../../bmusage/poller.js';
import { latestUsage, usageHistory, usageDaily, dbStatus, METRICS } from '../../bmusage/db.js';
import { bmUsageEvents, bmUsageLogInfo } from '../../bmusage/activityLog.js';
import { config } from '../../config.js';

const toolsPerm = requirePerm('tools');
const writeRole = requireRole('admin', 'operator');
const adminOnly = requireRole('admin');

const t = (v) => String(v ?? '').trim();

/** 범위 계정용 절단(순수) — 허용 vCenter 것만, 귀속 없는 것은 숨긴다. */
export function applyScope(list = [], allowed = null, field = 'vcenterId') {
  if (!allowed) return list;
  const ok = new Set(allowed);
  return list.filter((x) => t(x[field]) && ok.has(t(x[field])));
}

export function registerBmUsage(api) {

/** 주 조회 — 대상·최신값·설정·상태. 장비에 접속하지 않는다. */
api.get('/tools/bm-usage', toolsPerm, async (req, res) => {
  const allowed = scopedVcenterIds(req.user, store.get());
  const isAdmin = req.user?.role === 'admin';
  try {
    const [tg, latest, db] = await Promise.all([
      currentTargets(),
      latestUsage().catch(() => []),
      dbStatus().catch(() => ({ available: false })),
    ]);
    const targets = applyScope(tg.targets.map(publicTarget), allowed);
    const skipped = applyScope(tg.skipped, allowed);
    /*
     * ⚠ **사유별 개수도 scope 를 타야 한다**(v2.550 자체 재검토에서 잡은 결함): 예전에는
     *   `tg.counts.byReason` 을 그대로 내보내 범위 제한 계정이 **다른 법인 서버 대수**를 알 수 있었다
     *   (server/CLAUDE.md '귀속 없는 데이터·범위 밖 요약은 범위 계정에 노출하지 않는다').
     *   전체 범위 계정은 그대로, 범위 계정은 **보이는 목록에서 다시 센다**.
     */
    const skippedCounts = allowed
      ? skipped.reduce((acc, x) => { acc[x.reason] = (acc[x.reason] || 0) + 1; return acc; }, {})
      : (tg.counts.byReason || {});
    const counts = allowed
      ? { ...tg.counts, targets: targets.length, skipped: skipped.length, byReason: skippedCounts,
          idrac: targets.filter((x) => (x.paths || []).includes('idrac')).length,
          os: targets.filter((x) => (x.paths || []).includes('os')).length,
          both: targets.filter((x) => (x.paths || []).length > 1).length }
      : tg.counts;
    const keys = new Set(targets.map((x) => x.key));
    // 최신값은 **대상 목록 안의 것만** 준다(법인을 끄거나 등록이 사라진 서버의 옛 값이 새어 나가지 않게).
    const rows = latest.filter((r) => keys.has(t(r.key)));
    res.json({
      ok: true, at: Date.now(),
      enabled: bmUsageEnabled(),
      settings: loadBmUsageSettings(), defaults: DEFAULTS,
      targets, rows,
      // '왜 대상이 아닌지' 는 개수와 사유로만 준다(범위 밖 서버 이름을 흘리지 않기 위해).
      skippedCounts,
      skipped,
      counts,
      /* 키 충돌 — 범위 계정에는 보이는 것만(v2.550.3). 조용히 두면 한 서버 값이 다른 서버로 보인다. */
      keyConflicts: applyScope(tg.keyConflicts || [], allowed),
      metrics: METRICS, reasons: NO_PATH_REASON,
      vcenters: applyScope(tg.vcenters.map((v) => ({ ...v, vcenterId: v.id })), allowed),
      isEdge: tg.isEdge,
      // ⚠ DB 파일 경로는 admin 에게만(operator 는 tools 를 기본 보유 — '거부 기본값' 규칙).
      db: isAdmin ? db : (({ path: _p, ...rest }) => ({ ...rest, redacted: ['path'] }))(db),
      status: bmUsageStatus(),
      /*
       * ⚠ 인증 실패로 정지된 대상은 **파일 기준으로 다시 센다** — 폴러의 인메모리 맵은 재시작하면
       *   비어서, 그것만 보고 '정지 0건' 이라 말하면 조용한 정지가 된다(v2.528 규약).
       *   범위 계정에는 보이는 대상만.
       */
      authStops: applyScope(authStopsFor(tg.targets), allowed),
      log: bmUsageLogInfo(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
  }
});

/** 한 서버의 추이 — 원시 + 일 롤업. 상한으로 잘렸으면 밝힌다(조용한 상한 금지). */
api.get('/tools/bm-usage/history', toolsPerm, async (req, res) => {
  const key = t(req.query.key);
  if (!key) return res.status(400).json({ ok: false, reason: 'key 가 필요합니다.' });
  const allowed = scopedVcenterIds(req.user, store.get());
  try {
    const tg = await currentTargets();
    const target = tg.targets.find((x) => x.key === key) || null;
    // 범위 계정은 자기 법인 서버만 — 없는 것과 구분하지 않고 404(존재 은닉 규약).
    if (!target || (allowed && (!target.vcenterId || !allowed.includes(target.vcenterId)))) {
      return res.status(404).json({ ok: false, reason: '대상 서버를 찾지 못했습니다.' });
    }
    /*
     * ⚠⚠ **적재 키와 조회 키가 같아야 한다**(v2.550 자체 재검토에서 잡은 결함):
     *   `poller.js` 는 `insertUsage(rows, config.agent?.name || '')` 로 적재한다 — 엣지에서는
     *   `AGENT_NAME`, 중앙에서는 `''` 다. 조회를 `''` 로 굳혀 두면 **엣지에서는 추이가 영원히 빈다**
     *   (수집은 되는데 상세가 비어 '저장이 안 된다' 로 보인다). 같은 식을 쓴다.
     */
    const agent = config.agent?.name || '';
    const [raw, daily] = await Promise.all([
      usageHistory(key, { agent, hours: Number(req.query.hours) || 24 }),
      usageDaily({ key, agent, days: Number(req.query.days) || 90 }),
    ]);
    res.json({ ok: true, key, target: publicTarget(target), raw: raw.rows, rawTruncated: raw.truncated, daily, metrics: METRICS });
  } catch (e) {
    res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
  }
});

/** 지금 수집 — 폴러와 **재진입 가드를 공유**한다(연타가 세션을 곱하지 않게). */
api.post('/tools/bm-usage/collect', writeRole, toolsPerm, async (req, res) => {
  const r = await pollBmUsageOnce({ trigger: 'manual' });
  logAudit(req, 'bm-usage.collect', { ok: !!r.ok, servers: r.servers ?? null });
  res.json(r);
});

/** 작업 로그 — 실패 사유를 툴팁이 아니라 본문으로 볼 수 있게(v2.516 규약). */
api.get('/tools/bm-usage/activity', toolsPerm, (req, res) => {
  res.json({ ok: true, poller: bmUsageStatus(), events: bmUsageEvents(Number(req.query.limit) || 100), log: bmUsageLogInfo() });
});

/** 설정 — 법인 on/off·주기·보존. 수집 범위를 바꾸는 동작이라 admin 전용 + 감사. */
api.put('/tools/bm-usage/settings', adminOnly, (req, res) => {
  const next = saveBmUsageSettings(req.body || {});
  logAudit(req, 'bm-usage.settings', {
    enabled: next.enabled, corps: Object.keys(next.corps).length,
    intervalMs: next.intervalMs, rawRetentionDays: next.rawRetentionDays, dailyRetentionDays: next.dailyRetentionDays,
  });
  res.json({ ok: true, settings: next });
});

}
