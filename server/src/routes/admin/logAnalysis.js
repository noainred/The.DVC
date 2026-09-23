/**
 * routes/admin/logAnalysis.js — 설정 › Log › 로그 분석(개선점 도출) API(v2.583).
 *
 * 사용자 요청: "지금 분석하고 있는 로그를 분석해서 개선점 도출할 수 있는 메뉴와 기능을 설정에 만들어줘"
 * (그 로그는 폐쇄망 중앙 서버의 서비스 저널이었고 반출이 안 돼 화면 덤프만 가능했다).
 *
 * 권한: adminOnly + 전체 범위 — 로그에는 전 법인 호스트명·IP·VM 이름·엣지 이름이 그대로 있다
 * (operator 는 `tools` 를 기본 보유 — v2.549 엣지 로그·v2.560 토큰 점검과 같은 기준).
 * 붙여넣기는 **8MB·20만 줄**까지다(index.js BIG_JSON 등록). 저널은 동시에 하나만(journal.js 재진입 가드).
 * 표본 문장은 비밀처럼 보이는 값을 가린다(edgelog/redact.redactLogLine — 완전할 수 없다는 사실을 화면이 말한다).
 */
import { adminOnly, fullScopeOnlyWith } from './shared.js';
import { getLogs } from '../../logbuffer.js';
import { analyzeLive, analyzeBuffer, analyzePaste, analyzeJournal, analyzeEdge, ruleCatalog, journalUnit, liveStatus } from '../../loganalysis/index.js';
import { lastDataEdgeLog, edgeLogSummaries } from '../../central/edgeLogStore.js';
import { logAudit } from '../../audit.js';

const PASTE_MAX_BYTES = 8 * 1048576;
const fullScopeOnly = fullScopeOnlyWith('로그 분석은 전체 범위(vCenter 제한 없는) 계정만 볼 수 있습니다 — 전 법인의 호스트명·IP·VM 이름이 들어갑니다.');

export function registerLogAnalysis(adminRouter) {
  /** GET /log-analysis?source=live|buffer|edge&hours=24&agent=X */
  adminRouter.get('/log-analysis', adminOnly, fullScopeOnly, async (req, res) => {
    const source = String(req.query.source || 'live');
    const hours = Math.max(1, Math.min(168, Math.round(Number(req.query.hours) || 24)));
    let report;
    if (source === 'buffer') report = await analyzeBuffer(getLogs({ since: 0 }).items);
    else if (source === 'edge') {
      const agent = String(req.query.agent || '').trim();
      if (!agent) return res.status(400).json({ ok: false, reason: '엣지 이름(agent)이 필요합니다.' });
      const snap = lastDataEdgeLog(agent);
      if (!snap) return res.json({ ok: false, reason: 'no-edge-log', detail: '이 엣지의 로그 보관분이 없습니다 — 특수기능 › 엣지 로그에서 먼저 가져오세요.', agent });
      report = await analyzeEdge(agent, snap);
    } else report = analyzeLive(hours);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, source, report });
  });

  /** GET /log-analysis/meta — 원천별 가용성(엣지 보관분 목록·저널 유닛·누적 상태) + 규칙 카탈로그. */
  adminRouter.get('/log-analysis/meta', adminOnly, fullScopeOnly, (_req, res) => {
    const edges = edgeLogSummaries().filter((e) => e.hasData).map((e) => ({ agent: e.agent, at: e.at, logCount: e.logCount }));
    res.json({ ok: true, live: liveStatus(), journal: { unit: journalUnit() }, edges, rules: ruleCatalog(), pasteMaxBytes: PASTE_MAX_BYTES });
  });

  /** POST /log-analysis/journal { hours } — 이 서버의 서비스 저널을 읽어 분석한다(재진입 가드). */
  adminRouter.post('/log-analysis/journal', adminOnly, fullScopeOnly, async (req, res) => {
    const hours = Math.max(1, Math.min(168, Math.round(Number(req.body?.hours) || 24)));
    const report = await analyzeJournal(hours);
    logAudit({ user: req.user?.username, action: '로그 분석 — 서비스 저널 읽기', target: journalUnit(), detail: `${hours}시간 · ${report.coverage.lines}줄${report.coverage.ok === false ? ` · 실패(${report.coverage.reason})` : ''}`, ip: req.ip || '' });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, source: 'journal', report });
  });

  /** POST /log-analysis/paste { text } — 붙여넣은 로그(다른 서버의 journalctl·tail 출력)를 분석한다. */
  adminRouter.post('/log-analysis/paste', adminOnly, fullScopeOnly, async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text.trim()) return res.status(400).json({ ok: false, reason: '분석할 로그가 비어 있습니다.' });
    if (Buffer.byteLength(text) > PASTE_MAX_BYTES) return res.status(413).json({ ok: false, reason: `붙여넣기는 ${PASTE_MAX_BYTES / 1048576}MB 까지입니다 — grep 으로 줄여서 넣으세요.` });
    const report = await analyzePaste(text);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, source: 'paste', report });
  });
}
