/**
 * loganalysis/index.js — 설정 › Log › 로그 분석 파사드(v2.583).
 * 원천 5가지(누적 · 링 버퍼 · 서비스 저널 · 붙여넣기 · 엣지 로그 보관분)를 같은 엔진으로 분석한다.
 */
import { CORE_RULES, normalizeRules, CATEGORY_LABEL, SEVERITY_RANK } from './rules.js';
import { CATALOG_RULES } from './catalog.js';
import { newState, analyzeItems, buildReport, indexRules, addItem } from './engine.js';
import { parseText, fromBufferEntry } from './parse.js';
import { liveState, liveStatus, startLiveAnalysis, liveEnabled } from './live.js';
import { readJournal, journalUnit } from './journal.js';

/**
 * 활성 규칙 — 같은 id 면 코어가 이긴다. 엔진은 태그별로 **처음 맞는 규칙 하나**만 세므로 순서가 곧 분류다:
 *   ① 카탈로그 `early`(GPU 게스트 VM별 실패의 세부 분류 — 게스트 로그인·Tools·전원·다운로드 …)
 *   ② 코어(일반 규칙 제외) ③ 카탈로그 나머지 ④ 코어 `late`(모든 ✗ 줄을 잡는 gpu-guest-fail-other).
 * ①을 코어 뒤에 두면 auto 방식 줄('게스트작업: … / SSH: …')이 SSH 꼬리로 먼저 분류돼, 근본 원인이 게스트 로그인
 * 실패인 VM 이 'SSH 문제' 로 집계된다(v2.583 카탈로그 에이전트가 엔진 순서로 시뮬레이션해 13/13 가려짐을 확인).
 */
export function activeRules() {
  const early = CATALOG_RULES.filter((r) => r.early);
  const coreIds = new Set(CORE_RULES.map((r) => r.id));
  return normalizeRules([
    ...early.filter((r) => !coreIds.has(r.id)),
    ...CORE_RULES.filter((r) => !r.late),
    ...CATALOG_RULES.filter((r) => !r.early),
    ...CORE_RULES.filter((r) => r.late),
  ]);
}

export function startLogAnalysis() { return startLiveAnalysis(activeRules()); }

/** 규칙 카탈로그(화면의 '규칙 목록') — 정규식은 문자열로. */
export function ruleCatalog() {
  return activeRules().map((r) => ({
    id: r.id, tag: r.tag, severity: r.severity, category: r.category, categoryLabel: CATEGORY_LABEL[r.category] || r.category,
    title: r.title, meaning: r.meaning, action: r.action, link: r.link || '', linkLabel: r.linkLabel || '', pattern: r.re.source, src: r.src || '',
    entityLabel: r.entityLabel || '', edge: !!r.edge, origin: CORE_RULES.some((c) => c.id === r.id) ? 'core' : 'catalog',
  })).sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || a.id.localeCompare(b.id));
}

export function analyzeLive(hours = 24) {
  const { state, coverage } = liveState(hours);
  return buildReport(state, activeRules(), { coverage: { ...coverage, status: liveStatus(), enabled: liveEnabled() } });
}

export async function analyzeBuffer(entries = []) {
  const items = entries.map(fromBufferEntry).filter(Boolean);
  const st = await analyzeItems(items, activeRules());
  return buildReport(st, activeRules(), { coverage: { source: 'buffer', bufferLines: entries.length } });
}

export async function analyzePaste(text, { maxLines = 200_000 } = {}) {
  const p = parseText(text, { maxLines });
  const st = await analyzeItems(p.items, activeRules());
  return buildReport(st, activeRules(), { coverage: { source: 'paste', inputLines: p.total, dropped: p.dropped, continuation: p.continuation, skipped: p.skipped } });
}

export async function analyzeJournal(hours = 24) {
  const rules = activeRules();
  const idx = indexRules(rules);
  const st = newState();
  let n = 0;
  const r = await readJournal({ hours, onItem: (it) => { addItem(st, it, idx); n += 1; } });
  const report = buildReport(st, rules, { coverage: { source: 'journal', hours, unit: r.unit, ok: r.ok, reason: r.reason || '', detail: r.detail || '', warning: r.warning || '', truncated: r.truncated, continuation: r.continuation, bytes: r.bytes, ms: r.ms } });
  void n;
  return report;
}

export async function analyzeEdge(agent, snap) {
  const items = (snap?.logs?.items || []).map(fromBufferEntry).filter(Boolean);
  const st = await analyzeItems(items, activeRules());
  return buildReport(st, activeRules(), {
    coverage: {
      source: 'edge', agent, fetchedAt: snap?.at || null, via: snap?.via || '',
      truncated: !!snap?.logs?.truncated, omitted: snap?.logs?.omitted || 0, centralCapped: !!snap?.logs?.centralCapped,
      edgeStartedAt: snap?.node?.startedAt || null,
    },
  });
}

export { journalUnit, liveStatus };
