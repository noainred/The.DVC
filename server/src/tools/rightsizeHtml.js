/**
 * tools/rightsizeHtml.js — VM 자원 축소 근거 리포트를 **자기완결 HTML 한 장**으로 렌더(순수, v2.497).
 *
 * 왜 HTML 인가: 낭비 리소스 엑셀 내보내기(ZIP)에 VM 별 근거 리포트를 첨부해 엑셀에서 클릭해 열게
 * 해야 한다. 서버에는 PDF 엔진이 없고(PDF 는 웹이 jsPDF + 567KB 한글 폰트로 브라우저에서만 만든다)
 * 에어갭 Rocky 9 패키지에 새 의존성을 넣지 않기 위해, 외부 자원 참조 없이(인라인 CSS·인라인 SVG 차트)
 * 브라우저만 있으면 열리는 HTML 로 만든다. 내용은 모달의 PDF 문서 모델(RightsizeReport.jsx
 * buildRightsizeDoc)과 같은 구성이다: 판정 → 관측 창 → CPU → 메모리 → 디스크 → 방법론 → 참고 문서.
 *
 * 입력은 tools/rightsize.js analyzeRightsize 의 반환(+ series·realtime·synthesized) 그대로다.
 * 모든 텍스트는 이스케이프한다(VM 이름·게스트 OS 문자열은 vCenter 에서 온 외부 입력).
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gb = (mb) => (mb == null ? '—' : `${(mb / 1024).toFixed(1)} GB`);
const ghz = (mhz) => (mhz == null ? '—' : `${(mhz / 1000).toFixed(2)} GHz`);
const pc = (x) => (x == null ? '—' : `${x}%`);
const dt = (t) => { const d = new Date(t); return Number.isFinite(d.getTime()) ? d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—'; };

const STATE = {
  reduce: { color: '#16a34a', bg: '#dcfce7', icon: '✅' },
  hold: { color: '#b45309', bg: '#fef3c7', icon: '⚠️' },
  insufficient: { color: '#b91c1c', bg: '#fee2e2', icon: '⛔' },
  keep: { color: '#475569', bg: '#e2e8f0', icon: 'ℹ️' },
};

/**
 * 시계열 → 인라인 SVG 선 그래프. points: [{ t: ms, v: number }] (null 은 호출부가 뺀다).
 * refY(수평 기준선, 예: p95·할당)·axisMax(y 상한, 예: 할당) 를 지원한다. 점이 없으면 빈 문자열.
 */
export function svgLineChart({ points = [], width = 760, height = 200, unit = '', refY = null, refLabel = '', axisMax = null, color = '#2563eb' } = {}) {
  const pts = (points || []).filter((p) => Number.isFinite(p?.t) && Number.isFinite(p?.v));
  if (!pts.length) return '';
  const padL = 56; const padR = 12; const padT = 12; const padB = 26;
  const W = width - padL - padR; const H = height - padT - padB;
  const t0 = Math.min(...pts.map((p) => p.t)); const t1 = Math.max(...pts.map((p) => p.t));
  const vmax0 = Math.max(...pts.map((p) => p.v), refY ?? 0, axisMax ?? 0);
  const vmax = vmax0 > 0 ? vmax0 * 1.05 : 1;
  const x = (t) => padL + (t1 > t0 ? ((t - t0) / (t1 - t0)) * W : W / 2);
  const y = (v) => padT + H - (v / vmax) * H;
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const ticks = 4;
  const grid = Array.from({ length: ticks + 1 }, (_, i) => {
    const v = (vmax / ticks) * i; const yy = y(v).toFixed(1);
    return `<line x1="${padL}" y1="${yy}" x2="${width - padR}" y2="${yy}" stroke="#e2e8f0"/><text x="${padL - 6}" y="${yy}" font-size="10" text-anchor="end" dominant-baseline="middle" fill="#64748b">${v.toFixed(v >= 10 ? 0 : 1)}</text>`;
  }).join('');
  const xt = [t0, t0 + (t1 - t0) / 2, t1].map((t, i) => `<text x="${x(t).toFixed(1)}" y="${height - 8}" font-size="10" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}" fill="#64748b">${esc(dt(t).slice(0, 16))}</text>`).join('');
  const ref = refY != null && Number.isFinite(refY)
    ? `<line x1="${padL}" y1="${y(refY).toFixed(1)}" x2="${width - padR}" y2="${y(refY).toFixed(1)}" stroke="#dc2626" stroke-dasharray="4 3"/><text x="${width - padR}" y="${(y(refY) - 4).toFixed(1)}" font-size="10" text-anchor="end" fill="#dc2626">${esc(refLabel)} ${esc(refY.toFixed(2))}${esc(unit)}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" style="max-width:${width}px;display:block;background:#fff;border:1px solid #e2e8f0;border-radius:6px">${grid}<path d="${path}" fill="none" stroke="${color}" stroke-width="1.5"/>${ref}${xt}<text x="${padL}" y="${padT - 2}" font-size="10" fill="#64748b">${esc(unit)}</text></svg>`;
}

const kv = (items) => `<div class="kv">${items.map((it) => `<div class="kvi"><div class="k">${esc(it.k)}</div><div class="v">${esc(it.v)}</div>${it.sub ? `<div class="s">${esc(it.sub)}</div>` : ''}</div>`).join('')}</div>`;
const table = (cols, rows) => `<table><thead><tr>${cols.map((c) => `<th${c.align ? ` style="text-align:${c.align}"` : ''}>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${cols[i]?.align ? ` style="text-align:${cols[i].align}"` : ''}${c.color ? ` class="c-${esc(c.color)}"` : ''}>${esc(c.text)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

/**
 * @param {object} p
 * @param {object} p.report  analyzeRightsize 결과(+ series, realtime, synthesized, cached)
 * @param {object} p.vm      { name, vcenterId, host, guestOS }
 * @param {number} p.days    요청 관측 일수
 * @param {number} [p.generatedAt] 생성 시각(ms)
 * @returns {string} HTML 문서
 */
export function renderRightsizeHtml({ report: r = {}, vm = {}, days = 30, generatedAt = Date.now() } = {}) {
  const w = r.window || {}; const cpu = r.cpu || {}; const mem = r.mem || {}; const rt = r.realtime || {};
  const st = STATE[r.verdict?.state] || STATE.keep;
  const parts = [];
  parts.push(`<h1>자원 축소 근거 리포트 — ${esc(vm.name || r.vm?.name || '')}</h1>`);
  parts.push(`<div class="sub">${esc(vm.vcenterId || r.vm?.vcenterId || '')} · ${esc(vm.host || r.vm?.host || '')} · ${esc(vm.guestOS || r.vm?.guestOS || '')}</div>`);
  parts.push(`<div class="meta">최근 ${esc(w.days ?? days)}일 · 롤업 ${esc(w.intervalSec ?? '—')}초${r.cached ? ' · 5분 캐시' : ''}${r.synthesized ? ' · 데모(mock) 합성 데이터' : ''} · 생성 ${esc(dt(generatedAt))}</div>`);

  // 판정
  parts.push(`<div class="verdict" style="background:${st.bg};border-color:${st.color}"><div class="vt" style="color:${st.color}">${st.icon} ${esc(r.verdict?.title || '')}</div>${r.verdict?.summary ? `<div class="vs">${esc(r.verdict.summary)}</div>` : ''}</div>`);
  const reasons = r.evidence?.reasons || [];
  if (reasons.length) parts.push(`<ul class="reasons">${reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`);
  parts.push(kv([
    { k: '관측 기간', v: `${w.days ?? days}일`, sub: w.firstTs ? `데이터 ${w.coverageDays ?? 0}일 · ${dt(w.firstTs)} ~ ${dt(w.lastTs)}` : '데이터 없음' },
    { k: '샘플', v: `${w.samples ?? 0} / ${w.expectedSamples ?? 0}`, sub: `커버리지 ${pc(w.coveragePct)} · 간격 ${w.intervalSec ?? '—'}초` },
    { k: '정책', v: `여유 ${r.policy?.headroomPct}% · 상한 ${r.policy?.capReductionPct}%`, sub: `최소 ${r.policy?.minDays}일 · 커버리지 ${r.policy?.minCoveragePct}%` },
  ]));

  // CPU
  const cpuHead = `CPU — vCPU ${cpu.vcpu ?? '—'}${cpu.allocMhz ? ` (${ghz(cpu.allocMhz)} 할당)` : ''}${cpu.recommendedVcpu != null ? ` · 권장 ${cpu.recommendedVcpu}${cpu.reductionVcpu > 0 ? ` (−${cpu.reductionVcpu}, ${cpu.reductionPct}%)` : ' (변경 없음)'}${cpu.capped ? ' · 50% 상한' : ''}` : ''}`;
  parts.push(`<h2>${esc(cpuHead)}</h2>`);
  parts.push(kv([
    { k: '사용 MHz 평균', v: ghz(cpu.used?.avg) },
    { k: '사용 MHz p95', v: ghz(cpu.used?.p95), sub: cpu.basisNote || '산정 기준' },
    { k: '사용 MHz 최대', v: ghz(cpu.used?.max) },
    { k: '사용률 p95/최대', v: `${pc(cpu.usagePct?.p95)} / ${pc(cpu.usagePct?.max)}` },
    { k: 'CPU Ready p95', v: pc(cpu.readyPct?.p95), sub: `경고선 ${r.policy?.readyWarnPct}%/vCPU` },
  ]));
  for (const b of cpu.blockers || []) parts.push(`<div class="blk">⚠️ ${esc(b)}</div>`);
  const cpuPts = (r.series?.cpuUsageMhz || []).map((p) => ({ t: Date.parse(p.t), v: p.v == null ? null : p.v / 1000 })).filter((p) => Number.isFinite(p.t) && p.v != null);
  const cpuSvg = svgLineChart({ points: cpuPts, unit: 'GHz', refY: cpu.used?.p95 != null ? cpu.used.p95 / 1000 : null, refLabel: 'p95', axisMax: cpu.allocMhz != null ? cpu.allocMhz / 1000 : null });
  parts.push(`<h3>사용 MHz 추이</h3>${cpuSvg || '<div class="none">표본 없음</div>'}`);

  // 메모리
  const memHead = `메모리 — ${gb(mem.allocMB)} 할당${mem.recommendedMB != null ? ` · 권장 ${gb(mem.recommendedMB)}${mem.reductionPct > 0 ? ` (−${gb(mem.reductionMB)}, ${mem.reductionPct}%)` : ' (변경 없음)'}${mem.capped ? ' · 50% 상한' : ''}` : ''}`;
  parts.push(`<h2>${esc(memHead)}</h2>`);
  const memCell = (s, rtc) => { const has = s && (s.avg != null || s.max != null); if (has) return { avg: gb(s.avg), p95: gb(s.p95), max: gb(s.max), rt: false }; if (rtc) return { avg: gb(rtc.avg), p95: '—', max: gb(rtc.max), rt: true }; return { avg: '—', p95: '—', max: '—', rt: false }; };
  const memRow = (label, mean, s, rtc, note) => { const c = memCell(s, rtc); return [
    { text: label }, { text: mean }, { text: c.avg + (c.rt ? ' (실시간)' : ''), color: c.rt ? 'blue' : '' }, { text: c.p95 }, { text: c.max }, { text: c.rt ? '이력 없음 · 실시간(최근 1시간) 현재값' : note },
  ]; };
  const isConsumed = mem.memBasis === 'consumed';
  parts.push(table(
    [{ label: '계열' }, { label: '의미' }, { label: '평균', align: 'right' }, { label: 'p95', align: 'right' }, { label: '최대', align: 'right' }, { label: '해석' }],
    [
      memRow('Active', '게스트가 실제로 만지는 메모리(워킹셋)', mem.active, rt.memActiveMB, isConsumed ? '감축 하한 후보 ①' : '산정 기준(워킹셋 최대 × 여유)'),
      memRow('Consumed', '호스트가 배정한 메모리(캐시 포함)', mem.consumed, rt.memConsumedMB, isConsumed ? '감축 하한 후보 ②' : '참고 — 회수 안 된 과거 터치 페이지, 필요량 근거 아님'),
      memRow('Balloon', '벌룬 회수(>0=호스트 압박)', mem.balloon, rt.memBalloonMB, mem.balloon?.samplesAbove0 ? `${mem.balloon.pctTime}% 에서 0 초과 → 보류` : '관측 없음 → 정상'),
      memRow('Swapped', '호스트 스왑(>0=심각한 압박)', mem.swapped, rt.memSwappedMB, mem.swapped?.samplesAbove0 ? `${mem.swapped.pctTime}% 에서 0 초과 → 금지` : '관측 없음 → 정상'),
      [{ text: 'Usage %' }, { text: 'vCenter 사용률(active÷할당)' }, { text: pc(mem.usagePct?.avg) }, { text: pc(mem.usagePct?.p95) }, { text: pc(mem.usagePct?.max) }, { text: String(mem.workingSetSource || '').startsWith('usagePct') ? '워킹셋 복원 출처(최대 × 할당)' : '참고' }],
    ],
  ));
  for (const b of mem.blockers || []) parts.push(`<div class="blk">⚠️ ${esc(b)}</div>`);
  if (mem.basisNote) parts.push(`<div class="note">메모리 산정: ${esc(mem.basisNote)}</div>`);
  if (mem.skipReason) parts.push(`<div class="note">• ${esc(mem.skipReason)}</div>`);
  if (mem.consumedNote) parts.push(`<div class="note">• ${esc(mem.consumedNote)}</div>`);
  const toPts = (arr) => (arr || []).map((p) => ({ t: Date.parse(p.t), v: p.v == null ? null : p.v / 1024 })).filter((p) => Number.isFinite(p.t) && p.v != null);
  const consumedSvg = svgLineChart({ points: toPts(r.series?.memConsumedMB), unit: 'GB', refY: mem.allocMB != null ? mem.allocMB / 1024 : null, refLabel: '할당', color: '#7c3aed' });
  parts.push(`<h3>Consumed 메모리 추이</h3>${consumedSvg || '<div class="none">표본 없음</div>'}`);
  const activeSvg = svgLineChart({ points: toPts(r.series?.memActiveMB), unit: 'GB', refY: mem.workingSetMB != null ? mem.workingSetMB / 1024 : null, refLabel: '워킹셋 최대', color: '#059669' });
  parts.push(`<h3>Active(워킹셋) 메모리 추이</h3>${activeSvg || '<div class="none">표본 없음(기본 통계 레벨 1 은 주/월/년 롤업에 mem.active 를 남기지 않습니다)</div>'}`);

  // 디스크
  parts.push('<h2>디스크</h2>');
  parts.push(kv([
    { k: '커밋(실사용) 용량', v: r.disk?.storageGB != null ? `${r.disk.storageGB} GB` : '—' },
    { k: '미커밋(thin 여유)', v: r.disk?.uncommittedGB != null ? `${r.disk.uncommittedGB} GB` : '—', sub: r.disk?.thin ? 'thin 디스크' : 'thick' },
    { k: 'VMware Tools', v: r.disk?.toolsStatus || '—' },
  ]));
  if (r.disk?.note) parts.push(`<div class="note">${esc(r.disk.note)}</div>`);

  // 방법론·참고 문서
  parts.push('<h2>방법론</h2>');
  parts.push(`<ol class="method">${(r.methodology || []).map((m) => `<li>${esc(m)}</li>`).join('')}</ol>`);
  parts.push('<h2>참고 문서</h2>');
  parts.push(`<ul class="cite">${(r.citations || []).map((c) => `<li><a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.title)}</a><div class="s">${esc(c.usedFor)}</div></li>`).join('')}</ul>`);
  parts.push('<div class="foot">이 리포트는 vCenter 롤업 통계(각 점=간격 평균)를 근거로 합니다. 순간 피크는 이보다 높을 수 있으므로 감축은 여유를 두고 적용 후 재확인하세요. 실시간 표시 값은 참고용 현재값이며 다일 감축 하한 계산에는 반영하지 않습니다.</div>');

  const css = `body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,'Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:#0f172a;background:#f8fafc;margin:0;padding:24px}
main{max-width:860px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:24px 28px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 8px;padding-bottom:4px;border-bottom:1px solid #e2e8f0}h3{font-size:13px;margin:12px 0 6px;color:#334155}
.sub{color:#475569;font-size:13px}.meta{color:#64748b;font-size:12px;margin-bottom:14px}
.verdict{border:1px solid;border-radius:8px;padding:10px 14px;margin:10px 0}.vt{font-weight:700;font-size:14px}.vs{font-size:13px;margin-top:4px}
.reasons{font-size:12.5px;color:#334155;margin:6px 0 10px;padding-left:20px}.reasons li{margin:2px 0}
.kv{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}.kvi{flex:1 1 150px;min-width:140px;border:1px solid #e2e8f0;border-radius:6px;padding:8px 10px;background:#f8fafc}
.k{font-size:11px;color:#64748b}.v{font-size:15px;font-weight:600;margin-top:2px}.s{font-size:11px;color:#64748b;margin-top:2px;overflow-wrap:anywhere}
table{border-collapse:collapse;width:100%;font-size:12.5px;margin:6px 0}th,td{border:1px solid #e2e8f0;padding:5px 8px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#f1f5f9;font-weight:600}
.c-blue{color:#0284c7}.blk{background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:8px 10px;font-size:12.5px;margin:6px 0}
.note{font-size:12px;color:#475569;margin:6px 0;overflow-wrap:anywhere}.none{font-size:12px;color:#94a3b8;padding:12px;border:1px dashed #cbd5e1;border-radius:6px}
.method{font-size:12.5px;color:#334155;padding-left:20px}.method li{margin:4px 0}.cite{font-size:12.5px;padding-left:20px}.cite li{margin:6px 0}.cite a{color:#2563eb}
.foot{font-size:11.5px;color:#64748b;margin-top:18px;border-top:1px solid #e2e8f0;padding-top:10px}
@media print{body{background:#fff;padding:0}main{border:none}}`;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(`자원 축소 근거 — ${vm.name || r.vm?.name || ''}`)}</title><style>${css}</style></head><body><main>${parts.join('\n')}</main></body></html>`;
}
