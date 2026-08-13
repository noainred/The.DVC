/**
 * 성능점검 로그 설정/파일/분석 — routes/svcmon.js(구 1,053줄) 분할(v2.291.0). 본문은 원본 그대로,
 * 등록 순서는 셸(routes/svcmon.js)의 register 호출 순서가 보존한다.
 * 로그 파일 다운로드는 스트리밍(createReadStream) — GB 파일을 메모리에 올리지 않는다(원본 헤더 이관).
 */

import fs from 'node:fs';
import { logAudit } from '../../audit.js';
import { analyzeLog, listLogWindows, ANALYZE_BUCKETS } from '../../svcmon/loganalyze.js';
import { getLogSettings, setLogSettings, logDir } from '../../svcmon/logsettings.js';
import { logStatus, logFilePath, pruneOld } from '../../svcmon/csvlog.js';
import { canEdit, adminOnly } from './shared.js';

export function registerLogs(svcmonRouter) {

/* ── 로그 설정/파일 ── */
svcmonRouter.get('/log', (req, res) => res.json(logStatus()));

svcmonRouter.put('/log', adminOnly, (req, res) => {
  try {
    const before = getLogSettings();
    const next = setLogSettings(req.body || {});
    // 보관 정책이 줄어들면 즉시 반영(다음 파일 생성까지 기다리지 않게)
    if (next.keepFiles < before.keepFiles || (next.maxTotalMB && next.maxTotalMB < before.maxTotalMB)) {
      pruneOld(logDir(), next);
    }
    logAudit({ user: req.user?.username, action: 'svcmon.log.settings', detail: `${next.rotate}/${next.keepFiles}` });
    res.json(logStatus());
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * CSV 다운로드 — 스트리밍(GB 파일을 메모리에 올리지 않는다).
 * 로그에는 전 대상의 호스트명·점검 결과가 들어 있어 사실상 인벤토리 내보내기다 —
 * 조회 권한만으로 열어 두지 않고 편집 권한을 요구하고 감사에 남긴다.
 */
svcmonRouter.get('/log/files/:name', canEdit, (req, res) => {
  const p = logFilePath(req.params.name);
  if (!p) return res.status(404).json({ error: '로그 파일을 찾을 수 없습니다.' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}"`);
  logAudit({ user: req.user?.username, action: 'svcmon.log.download', target: req.params.name });
  fs.createReadStream(p).on('error', () => res.end()).pipe(res);
});

/** 로그 보유 범위 — 분석 화면이 조회 가능 기간을 먼저 보여줄 때 쓴다. */
svcmonRouter.get('/log/windows', (req, res) => {
  const files = listLogWindows();
  const froms = files.map((f) => f.from).filter(Boolean);
  const tos = files.map((f) => f.to).filter(Boolean);
  res.json({
    files,
    from: froms.length ? Math.min(...froms) : null,
    to: tos.length ? Math.max(...tos) : null,
  });
});

/**
 * 로그 분석 — CSV 로그를 기간·버킷으로 집계한다. 일 2GB 규모이므로 스트리밍 + 행/시간
 * 예산으로 돌고, 예산에 걸리면 truncated 로 알린다(조용한 절단 금지).
 * canEdit 인 이유: 로그와 같은 데이터(전 대상 호스트·결과)를 읽는 조회다 — /log/files 와 동일.
 */
svcmonRouter.get('/log/analyze', canEdit, async (req, res) => {
  try {
    // `|| 기본값` 은 0 을 삼킨다(from=0 이 '최근 7일'로 둔갑해 전 파일이 기간 밖 처리됨 —
    // 스모크에서 실제 발생). 유한성 검사로만 폴백한다.
    const toRaw = Number(req.query.to);
    const to = Number.isFinite(toRaw) && toRaw > 0 ? toRaw : Date.now();
    const fromRaw = Number(req.query.from);
    const from = Number.isFinite(fromRaw) && fromRaw >= 0 && String(req.query.from ?? '') !== ''
      ? fromRaw : (to - 7 * 86400e3);
    const bucket = ANALYZE_BUCKETS.includes(req.query.bucket) ? req.query.bucket : 'day';
    const r = await analyzeLog({
      from, to, bucket,
      path: typeof req.query.path === 'string' ? req.query.path : '',
      target: typeof req.query.target === 'string' ? req.query.target : '',
      test: typeof req.query.test === 'string' ? req.query.test : '',
      type: typeof req.query.type === 'string' ? req.query.type : '',
    });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

svcmonRouter.post('/log/prune', adminOnly, (req, res) => {
  const removed = pruneOld(logDir(), getLogSettings());
  logAudit({ user: req.user?.username, action: 'svcmon.log.prune', detail: `${removed}개 삭제` });
  res.json({ removed, ...logStatus() });
});

}
