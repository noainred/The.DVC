/**
 * bmusage/edgePull.js — **엣지가 종합한 사용률 봉투**(v2.554).
 *
 * 사용자 지시(2026-09-17): "**엣지에서 종합하고 중앙으로 전달은 중앙에서 조회할때만 한다.**"
 *
 * ── 왜 push 가 아니라 pull 인가(사용자 선택) ────────────────────────────────
 * 베어메탈 사용률은 **대부분 볼 일이 없는 화면**이다. 28곳 × 5분 주기로 push 하면 회선을 상시
 * 점유하는데, 사람이 화면을 여는 순간에만 필요하다. 그래서 v2.549 엣지 로그와 **같은 방식**을
 * 쓴다 — 중앙이 `collector/puller.js:23` 과 **같은 url·같은 토큰**(`X-Collector-Token`)으로
 * `GET /api/collector/bm-usage` 를 당긴다. **새 포트·새 인증이 필요 없다** — 이 사실이 pull 을
 * 고른 근거이므로 새 인증 경로를 도입하려 하지 말 것.
 *
 * ── 정직성 규칙 ──────────────────────────────────────────────────────────────
 * ⚠ **자격증명을 싣지 않는다** — `publicTarget()` 을 통과한 것만(라우트가 아니라 여기서 한 번 더).
 * ⚠ **엣지의 판정을 그대로 전한다** — 중앙이 다시 판정하면 같은 서버를 두 곳에서 다르게 말한다
 *   (v2.548 '중앙이 위임 장비를 다시 판정하게 만들지 말 것' 과 같은 규칙).
 * ⚠ **상한으로 자른 것은 개수를 밝힌다**(`truncated`) — 조용한 상한 금지.
 * ⚠ **꺼져 있어도 응답한다** — `enabled:false` 를 그대로 실어야 중앙이 '안 켰다' 와 '못 읽었다' 를
 *   구분한다(빈 응답을 주면 중앙 화면이 '모른다' 밖에 말할 수 없다. v2.517 `sendStatusOnly` 규약).
 */
import { isMockMode } from '../mock/demo/flags.js'; // v2.920 데모 성능 열(응답 단계)
import { config, currentVersion } from '../config.js';
import { loadBmUsageSettings, bmUsageEnabled, enterpriseActive } from './settings.js';
import { publicTarget } from './targets.js';
import { currentTargets, bmUsageStatus, authStopsFor, collectHealthNow } from './poller.js';
import { latestUsage } from './db.js';
import { buildPerfEntry, PERF_COL_META, compactPerfEntry } from './perfView.js';
import { hwFactsReader } from './hwFacts.js';
import { freshMsFor } from './useJudge.js';

/**
 * v2.919(리눅스 성능 1단계): 봉투에 판정이 붙은 성능 항목(`perf`)을 싣는다 — **엣지가 판정하고 중앙은 그대로 전한다**.
 *   행(rows)에서는 JSON 문자열 열(detail_json·tuning_json)을 뗀다(중앙 정제가 글자 512자로 잘라 깨진 JSON 이 되므로 — 같은 내용은 perf 에 객체로).
 *   하드웨어 사실은 이 엣지가 이미 가진 iDRAC 데이터(hwFacts — 장비 왕복 0). 실패해도 봉투는 나간다(perf 만 비고 perfError 로 밝힌다).
 */
export async function perfForRows(rows, targets, s, { full = true, now = Date.now() } = {}) {
  let hwOf = () => null; let perfError = '';
  try { hwOf = await hwFactsReader({ agent: config.agent?.name || '', now, freshMs: freshMsFor(s.intervalMs) }); }
  catch (e) { perfError = `하드웨어 사실을 읽지 못했습니다: ${String(e?.message || e).slice(0, 160)}`; }
  const byKey = new Map((targets || []).map((x) => [t(x.key), x]));
  const perf = [];
  for (const r of rows || []) {
    try { perf.push(buildPerfEntry({ row: r, hw: hwOf(byKey.get(t(r.key))) || null, th: s.perf, intervalMs: s.intervalMs, now, full })); }
    catch (e) { perfError = perfError || `판정 실패: ${String(e?.message || e).slice(0, 160)}`; }
  }
  return { perf, perfError };
}
/**
 * v2.919(반증 D2) — 봉투 바이트 상한. 중앙 수신 상한(`util/readCapped.js EDGE_RESPONSE_MAX_BYTES` 16MB — 압축 해제 뒤 크기)을 넘으면
 *   중앙이 응답을 통째로 거절해 **기존 다섯 지표까지** 못 당긴다(반증 실측: 장치 32개 서버 1대 약 18KB → 약 880대에서 16MB).
 *   그래서 넘치면 무거운 것부터 뺀다: ① 성능 항목을 목록용(code 표)으로 — 근거·장치별(detail)·튜닝·하드웨어 사실 제거 ② 그래도 넘치면 성능 항목 전부 제거.
 *   행(rows — 다섯 지표)·대상(targets)은 **언제나 남긴다**. 뺀 사실은 `perfTruncated`(사유·단계·전후 바이트)로 봉투가 밝힌다(조용한 축약 금지).
 *   env `BMUSAGE_ENVELOPE_MAX_BYTES`(256KB~12MB, 기본 8MB — 중앙 16MB 의 절반).
 */
export const ENVELOPE_MAX_BYTES = Math.min(12 * 1_048_576, Math.max(256 * 1024, Number(process.env.BMUSAGE_ENVELOPE_MAX_BYTES) || 8 * 1_048_576));
const jsonBytes = (o) => Buffer.byteLength(JSON.stringify(o));
/** 순수 — 봉투를 상한 안으로(성능 항목만 줄인다). 상한 안이면 그대로 돌려준다. */
export function fitEnvelope(env, maxBytes = ENVELOPE_MAX_BYTES) {
  const before = jsonBytes(env);
  if (before <= maxBytes) return env;
  let out = { ...env, perf: (env.perf || []).map(compactPerfEntry) };
  let level = 'compact';
  let after = jsonBytes(out);
  if (after > maxBytes) { out = { ...out, perf: [] }; level = 'dropped'; after = jsonBytes(out); }
  out.perfTruncated = { reason: 'envelope-bytes', level, bytesBefore: before, bytesAfter: after, maxBytes, ...(after > maxBytes ? { overStill: true } : {}) };
  return out;
}

/** 행에서 JSON 문자열 열을 뗀다(봉투·주 조회 — 크기와 정제 상한). */
export const stripJsonCols = (r) => { const { detail_json: _d, tuning_json: _t, ...rest } = r || {}; return rest; };

/** 서버 수 상한 — 한 법인이 200대라도 봉투가 수백 KB 를 넘지 않게. */
export const DEFAULT_LIMIT = 400;
export const MAX_LIMIT = 2_000;

const t = (v) => String(v ?? '').trim();

/**
 * 이 노드(엣지)의 사용률 종합.
 * @param {{limit?:number}} opt
 * @returns {Promise<object>}
 */
export async function buildBmUsageEnvelope(opt = {}) {
  // v2.919(반증 D2): 봉투 바이트 상한 — 넘치면 성능 상세부터 뺀다(fitEnvelope). 다섯 지표 행은 언제나 남는다.
  return fitEnvelope(await buildEnvelopeRaw(opt), opt.maxBytes ?? ENVELOPE_MAX_BYTES);
}
async function buildEnvelopeRaw({ limit = DEFAULT_LIMIT } = {}) {
  const cap = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  const s = loadBmUsageSettings();
  const [tg, latest] = await Promise.all([
    currentTargets(),
    latestUsage({ json: true }).catch(() => []),   // v2.922(D13): 봉투의 판정 항목이 JSON 열을 쓴다
  ]);
  const all = (tg.targets || []).map(publicTarget);
  const targets = all.slice(0, cap);
  const keys = new Set(targets.map((x) => t(x.key)));
  // 최신값은 **대상 목록 안의 것만**(법인을 끄거나 등록이 사라진 서버의 옛 값이 새어 나가지 않게).
  const rows00 = (latest || []).filter((r) => keys.has(t(r.key)));
  // v2.920(반증 D2): 데모(mock) 엣지는 데모 대상 성능 열을 봉투 단계에서만 겹친다(적재하지 않는다).
  const rows0 = isMockMode() ? (await import('../mock/demo/baremetal.js')).demoPerfLatestRows(rows00, tg.targets || []) : rows00;
  const { perf: perf0, perfError } = await perfForRows(rows0, tg.targets || [], s, { full: true });
  // v2.923(4단계): 튜닝 사실의 감지 목록(유닛 · 프로세스 이름 · 포트)은 프로파일 · 카탈로그가 보는 것만 싣는다(봉투 상한 — profiles/index.js ENVELOPE_WATCH).
  const { compactTuningForEnvelope } = await import('./profiles/index.js');
  const perf = perf0.map((p) => (p && p.tuning ? { ...p, tuning: compactTuningForEnvelope(p.tuning) } : p));
  const rows = rows0.map(stripJsonCols);
  return {
    node: {
      agent: config.agent?.name || '',
      version: currentVersion(),
      role: config.agent?.centralUrl ? 'edge' : 'central',
      datacenter: config.collector?.datacenter || '',
    },
    at: Date.now(),
    enabled: bmUsageEnabled(),
    // 설정 전체를 싣지 않는다 — 중앙 화면이 쓰는 값만(법인 목록은 그 법인의 것이라 그대로).
    settings: {
      intervalMs: s.intervalMs, osSsh: !!s.osSsh, idracTelemetry: !!s.idracTelemetry,
      idracFullTelemetry: !!s.idracFullTelemetry, includeUnassigned: !!s.includeUnassigned, includeVirtualization: !!s.includeVirtualization,
      corps: Object.keys(s.corps || {}),
      enterpriseEnabled: !!s.enterpriseEnabled, enterpriseAck: !!s.enterpriseAck,
      enterpriseMode: s.enterpriseMode, enterpriseActive: enterpriseActive(s),
    },
    targets,
    truncated: all.length > targets.length ? all.length - targets.length : 0,
    rows,
    counts: tg.counts || {},
    skippedCounts: (tg.counts || {}).byReason || {},
    // ⚠ 정지 대상은 **개수와 경로만**(이름은 targets 에 이미 있다 — 중복으로 싣지 않는다).
    authStops: authStopsFor(tg.targets || []).map(({ key, path, attempts, since, reason }) => ({ key, path, attempts, since, reason })),
    status: bmUsageStatus(),
    // v2.919 — 판정이 붙은 성능 항목 · 이 엣지의 기준값 · 열 ↔ USE 칸 대응(중앙 정제 화이트리스트: central/bmUsageEdgePull.js sanitizePerfEntry).
    perfVersion: 1,
    perf,
    perfThresholds: s.perf,
    perfCols: PERF_COL_META,
    ...(perfError ? { perfError } : {}),
    // v2.929(5단계): 집중 모니터링 요약(진행 중 · 대기 · 최근 24시간 — 중앙 보드 ‘집중 n 건’ 칩 · 상세는 볼 때 엣지 대행으로) · 성능 알림 발송 기록(최근 24시간 · 채널 URL 없음).
    ...(await envelopeOps()),
  };
}
/** 5단계 봉투 필드 — 실패해도 봉투는 나간다(그 필드만 빠진다). */
async function envelopeOps(now = Date.now()) {
  const out = {};
  try { const F = await import('./focus/run.js'); const f = await F.focusEnvelopeSummary({ now }); if (f) out.focusSummary = f; } catch { /* */ }
  try { const A = await import('./perfAlerts.js'); out.perfAlertSent = (A.perfAlertStatus().sent || []).filter((r) => Number(r?.at) >= now - 86_400_000); } catch { /* */ }
  // 6단계 수집 건강 — 이 엣지가 매 주기 잰 값 + 주기 추이(7일 · 1시간 칸). 아직 주기가 없으면 싣지 않는다(지어내지 않는다 — 중앙은 ‘아직 주기 없음’).
  try {
    const h = collectHealthNow();
    if (h) out.collectHealth = { ...h, trend: await collectTrend({ now }) };
  } catch { /* 그 필드만 빠진다 */ }
  return out;
}

/** 6단계 — 이 노드의 주기 추이(메인 DB collect_cycle · 7일 → 1시간 칸). 못 읽으면 빈 배열. */
export async function collectTrend({ now = Date.now(), days = 7 } = {}) {
  try {
    const O = await import('./opsDb.js');
    const rows = await O.cycleRange({ agent: config.agent?.name || '', from: now - days * 86_400_000, to: now, limit: 20_000 });
    return rows ? (await import('./collectHealth.js')).hourlyTrend(rows) : [];
  } catch { return []; }
}
