/**
 * routes/admin/perfMonitor.js — 설정 › 서버 성능 측정 API(v2.498).
 *
 * 사용자 요청: "'불러오는 중…' 이 3분 이상 지속될 때가 있다. 설정에 서버 성능 측정 메뉴를 만들고,
 * 이런 hang 현상이 발생할 때 로그를 찍어 나중에 튜닝할 때 쓰게 하자."
 *
 * 권한: 전부 adminOnly — 요청 경로·사용자명·진행 중 요청 목록이 담기므로 운영 진단 정보다
 * (범위 제한 계정에 주지 않는다). 비밀·쿼리스트링·본문은 담지 않는다.
 * 응답은 res.json 그대로 → util/compress.js 의 ETag/304·gzip 을 그대로 탄다.
 */
import { logAudit } from '../../audit.js';
import { perfSnapshot, measureNow, pruneHangLog } from '../../perf/monitor.js';
import { loadPerfSettings, savePerfSettings, LIMITS as PERF_LIMITS, DEFAULTS as PERF_DEFAULTS } from '../../perf/settings.js';
import { readHangs, clearHangs, hangLogStatus } from '../../perf/hangLog.js';
import { adminOnly } from './shared.js';

export function registerPerfMonitor(adminRouter) {
  /** 현재 스냅샷(라우트별 지연·느린 요청·hang·루프 창·진행 중 요청·메모리). */
  adminRouter.get('/perf', adminOnly, (req, res) => {
    const lim = (k, d, max) => Math.max(1, Math.min(max, Number(req.query[k]) || d));
    res.json({
      ...perfSnapshot({ routeLimit: lim('routes', 60, 400), slowLimit: lim('slow', 100, 500), hangLimit: lim('hangs', 100, 500) }),
      limits: PERF_LIMITS, defaults: PERF_DEFAULTS,
    });
  });

  /** 임계·보관 설정 변경. 저장 후 보존일 정리를 한 번 돌린다. */
  adminRouter.put('/perf/settings', adminOnly, (req, res) => {
    const before = loadPerfSettings();
    const next = savePerfSettings(req.body || {});
    logAudit({
      user: req.user?.username, action: '서버 성능 측정 설정 변경',
      detail: `enabled=${before.enabled}→${next.enabled} slow=${before.slowRequestMs}→${next.slowRequestMs}ms hang=${before.hangLagMs}→${next.hangLagMs}ms client=${before.clientStuckMs}→${next.clientStuckMs}ms keep=${next.keepSlow}/${next.keepHangs} 보존=${next.retentionDays}일`,
      ip: req.ip || '',
    });
    const pruned = pruneHangLog();
    res.json({ ok: true, settings: next, limits: PERF_LIMITS, pruned });
  });

  /**
   * '지금 측정' — 30초 창을 기다리지 않고 현재 루프 응답성을 잰다(setImmediate 왕복 + 1초 히스토그램).
   * 재진입 가드는 monitor.measureNow 안에 있고 진행 중이면 409 로 알린다(같은 작업 중복 실행 금지 규약).
   */
  adminRouter.post('/perf/measure', adminOnly, async (req, res) => {
    const r = await measureNow({ samples: Number(req.body?.samples) || 60 });
    if (r.busy) return res.status(409).json(r);
    res.json(r);
  });

  /** hang 로그 파일(재시작 후에도 남는 기록) — 최근 limit 건, kind=loop|client 필터. */
  adminRouter.get('/perf/hangs', adminOnly, (req, res) => {
    const kind = ['loop', 'client'].includes(String(req.query.kind || '')) ? String(req.query.kind) : '';
    res.json({ ok: true, ...readHangs({ limit: Number(req.query.limit) || 200, kind }), status: hangLogStatus() });
  });

  /** hang 로그 비우기(관리자). 기록 자체가 진단 근거라 감사에 남긴다. */
  adminRouter.delete('/perf/hangs', adminOnly, (req, res) => {
    const st = hangLogStatus();
    const r = clearHangs();
    logAudit({ user: req.user?.username, action: '서버 성능 hang 로그 삭제', detail: `bytes=${st.bytes ?? 0}`, ip: req.ip || '' });
    res.json(r);
  });
}
