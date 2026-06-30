/**
 * LLM ChatOps — 자연어 운영 질문에 인프라 현황 컨텍스트를 곁들여 답한다. 실제 데이터는
 * 포탈을 떠나지 않고(요약 컨텍스트만 LLM에 전달), 답변 톤은 운영자 친화적. LLM 비활성 시
 * 결정적(deterministic) 요약으로 폴백한다. 데이터 조회는 nlSearch를 재사용한다.
 */

import { loadLlmConfig } from './config.js';
import { ollamaGenerate } from './ollama.js';
import { nlSearch } from './nlSearch.js';
import { store } from '../store.js';
import { alertStatus } from '../alerts.js';

const pct = (n) => (Number.isFinite(n) ? Math.round(n) : 0);

/** 스냅샷 → LLM에 줄 컴팩트 컨텍스트(수MB가 아니라 핵심 수치만). */
function buildContext() {
  const snap = store.get();
  const hosts = snap.hosts || [], vms = snap.vms || [], ds = snap.datastores || [];
  const onVms = vms.filter((v) => v.powerState === 'POWERED_ON' && !v.template);
  const topCpu = [...hosts].sort((a, b) => (b.cpuUsagePct || 0) - (a.cpuUsagePct || 0)).slice(0, 5)
    .map((h) => `${h.name}(CPU ${pct(h.cpuUsagePct)}%/MEM ${pct(h.memUsagePct)}%)`);
  const fullDs = ds.filter((d) => (d.usagePct || 0) >= 85).sort((a, b) => b.usagePct - a.usagePct).slice(0, 5)
    .map((d) => `${d.name}(${pct(d.usagePct)}%, 여유 ${Math.round(d.freeGB)}GB)`);
  const st = alertStatus();
  const firing = (st.firing || []).slice(0, 8).map((f) => `${f.severity}:${f.title}`);
  const vcLines = (snap.vcenters || []).map((v) => `${v.id}(${v.status},v${v.version || '?'},호스트 ${hosts.filter((h) => h.vcenterId === v.id).length})`);
  return {
    text: [
      `생성시각: ${snap.generatedAt}`,
      `vCenter ${(snap.vcenters || []).length}개: ${vcLines.join(', ')}`,
      `호스트 ${hosts.length}개, VM ${vms.length}개(가동 ${onVms.length}), 데이터스토어 ${ds.length}개`,
      `CPU 상위: ${topCpu.join(', ') || '없음'}`,
      `포화 임박 데이터스토어: ${fullDs.join(', ') || '없음'}`,
      `진행중 경보 ${(st.firing || []).length}건: ${firing.join('; ') || '없음'}`,
    ].join('\n'),
    counts: { vcenters: (snap.vcenters || []).length, hosts: hosts.length, vms: vms.length, onVms: onVms.length, firing: (st.firing || []).length },
  };
}

/**
 * 운영 질문 응답. { answer, source, context, search? }.
 * - LLM 켜져 있으면 컨텍스트+질문으로 답변 생성.
 * - "조회/목록/몇 개" 류 질문은 nlSearch로 실제 데이터도 함께 첨부.
 */
export async function chatOps(question) {
  const q = String(question || '').trim();
  if (!q) return { answer: '질문을 입력하세요.', source: 'none' };
  const ctx = buildContext();

  // 데이터 조회 의도가 있으면 nlSearch 결과를 근거로 첨부.
  let search = null;
  if (/(몇|개수|목록|리스트|보여|찾아|조회|이상|초과|넘는|top|상위)/i.test(q)) {
    try { const r = await nlSearch(q); if (r && r.total != null) search = { entity: r.entity, total: r.total, summary: r.summary, sample: (r.results || []).slice(0, 10) }; } catch { /* 무시 */ }
  }

  const cfg = loadLlmConfig();
  if (!cfg.enabled) {
    // 폴백: 컨텍스트 + 검색결과를 결정적으로 요약.
    const lines = ['(LLM 비활성 — 규칙 기반 요약. 설정 › AI 검색에서 Ollama 활성화 시 자연어 답변)'];
    lines.push(ctx.text);
    if (search) lines.push(`\n질의 결과: ${search.entity} ${search.total}건 — ${search.summary || ''}`);
    return { answer: lines.join('\n'), source: 'fallback', context: ctx.counts, search };
  }

  const prompt = [
    '당신은 VMware 글로벌 모니터링 포탈의 운영 어시스턴트입니다. 아래 인프라 현황만 근거로,',
    '한국어로 간결하고 실무적으로 답하세요. 모르면 모른다고 하고, 수치는 컨텍스트 범위에서만 인용하세요.',
    '',
    '== 인프라 현황 ==',
    ctx.text,
    search ? `\n== 질의 데이터(${search.entity} ${search.total}건) ==\n${(search.sample || []).map((x) => x.name || x.id).join(', ')}` : '',
    '',
    `== 질문 ==\n${q}`,
    '',
    '== 답변 ==',
  ].join('\n');

  try {
    const answer = await ollamaGenerate(cfg, prompt);
    return { answer: answer.trim() || '(빈 응답)', source: 'llm', context: ctx.counts, search };
  } catch (e) {
    return { answer: `LLM 호출 실패: ${e.message}\n\n${ctx.text}`, source: 'error', context: ctx.counts, search };
  }
}
