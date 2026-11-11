/**
 * storage/inspect/report.js — PowerScale **주간 점검 보고서**(v2.964 · 순수 · 설계 README §3 ③).
 *
 * 무엇: 1쪽 결재용 요약(결과 · 법인별 · 이상/주의와 조치 · 확인 불가) + 2쪽 근거 수치(용량 · Top 10 노드 편중 · 데이터 보호 · 다음 주 확인) + 근거 자료.
 *  · 메일 본문과 첨부(자급형 HTML — 브라우저에서 인쇄 › PDF 로 저장)가 같은 HTML 이다. PDF 를 서버에서 만들지 않는다(이 저장소에 PDF 라이브러리가 없다 —
 *    SAN 스토리지 월간 보고서 v2.950 과 같은 판단). 설계의 'PDF 첨부' 는 이 형태로 바꿨다(README §8 정정).
 *  · 판정은 view.buildInspectModel(judge 하나)의 결과만 쓴다 — 보고서가 다시 판정하지 않는다. 확인 불가는 정상에 넣지 않고 따로 적는다.
 *  · 모든 글자는 esc() 를 지난다(장비 이름 · 사유는 외부에서 온 값).
 */
import { DAY_OFFSET_MIN } from '../../util/dayKey.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { ITEMS, GROUPS, STATUS_KO, ACTIONS, REFS, REF_LEVEL_KO, SOURCES_NOTE } from './catalog.js';

export const REPORT_KIND = 'storage-inspect-report';
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLOR = { ok: '#0f6b4b', warn: '#7a5200', bad: '#a5161b', unknown: '#3a4558', na: '#6d7a92' };
const BG = { ok: '#dff3ea', warn: '#fbefd0', bad: '#fbe1e2', unknown: '#eef1f6', na: '#f4f6fa' };
const pctText = (p) => (p == null ? '—' : `${Math.round(p * 10) / 10}%`);
const num = (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'));
export function kstText(ms, offsetMin = DAY_OFFSET_MIN) {
  if (ms == null) return '—';
  const d = new Date(ms + offsetMin * 60_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
/** ISO 주차(포탈 시각) — '2026년 46주차'. */
export function weekLabel(ms, offsetMin = DAY_OFFSET_MIN) {
  const d = new Date(ms + offsetMin * 60_000);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const w = Math.ceil(((t - y0) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}년 ${w}주차`;
}

/**
 * 보고서 모델(순수).
 * @param {object} model view.buildInspectModel 결과(주소 가림 판본)
 * @param {object|null} top view.buildTopNodes 결과(7일 · ops)
 * @param {{now:number, corp?:string|null, portal?:string}} o corp 를 주면 그 법인 장비만(법인 담당자 판)
 */
export function buildReportModel(model, top, { now = Date.now(), corp = null, portal = '' } = {}) {
  const devices = (model?.devices || []).filter((d) => corp == null || String(d.corp) === String(corp));
  const ids = new Set(devices.map((d) => d.id));
  const counts = { ok: 0, warn: 0, bad: 0, unknown: 0, na: 0 };
  for (const d of devices) for (const k of Object.keys(counts)) counts[k] += d.summary?.[k] || 0;
  const issues = []; const unknowns = [];
  for (const d of devices) for (const i of d.items || []) {
    if (i.status === 'bad' || i.status === 'warn') issues.push({ corp: d.corpName, device: d.name, deviceId: d.id, id: i.id, label: i.label, status: i.status, value: i.value, basis: i.basis, action: ACTIONS[i.id] || '', refs: i.refs });
    else if (i.status === 'unknown') unknowns.push({ corp: d.corpName, device: d.name, label: i.label, why: i.why || '' });
  }
  issues.sort((a, b) => (a.status === b.status ? 0 : a.status === 'bad' ? -1 : 1) || String(a.corp).localeCompare(String(b.corp)));
  const topRows = (top?.rows || []).filter((r) => corp == null || ids.has(r.deviceId)).slice(0, 10);
  const skewed = (top?.clusters || []).filter((c) => (corp == null || ids.has(c.deviceId)) && c.skewed);
  const prot = devices.map((d) => {
    const it = (id) => (d.items || []).find((x) => x.id === id) || null;
    return { name: d.name, synciq: it('synciq'), snapshots: it('snapshots'), jobs: it('jobs'), reprotect: it('reprotect') };
  });
  const lastRun = devices.reduce((a, d) => Math.max(a, d.run?.at || 0), 0) || null;
  const todo = issues.slice(0, 8).map((x) => `${x.corp} · ${x.device} — ${x.label}: ${x.action || '원인 확인'}`);
  for (const u of unknowns.slice(0, 3)) todo.push(`${u.corp} · ${u.device} — ${u.label} 확인 불가 해소: ${u.why}`);
  const usedRefs = [...new Set([...issues.flatMap((x) => x.refs || []), 1, 3, 10, 14])].sort((a, b) => a - b);
  return {
    kind: REPORT_KIND, generatedAt: now, week: weekLabel(now), // 반증 F4: 주차는 보고서를 만든 주 — 오래된 실행의 주차를 이번 보고서 제목에 붙이지 않는다
    lastRun, portal, corp, corpName: corp != null ? devices[0]?.corpName || String(corp) : null,
    counts, total: Object.values(counts).reduce((a, b) => a + b, 0), devices: devices.map((d) => ({ name: d.name, corpName: d.corpName, version: d.version, nodeCount: d.nodeCount,
      capacityPct: d.capacityPct, summary: d.summary, runAt: d.run?.at ?? null, staleDays: d.run?.staleDays || 0, method: d.run?.method || null, worse: d.diff?.worse?.length || 0, better: d.diff?.better?.length || 0,
      skewRatio: d.skew?.ratio ?? null })),
    corps: [...new Set(devices.map((d) => d.corpName))].length, nodes: devices.reduce((a, d) => a + (Number(d.nodeCount) || 0), 0), nodesUnknown: devices.filter((d) => !(Number(d.nodeCount) > 0)).length,
    issues, unknowns, top: { rows: topRows, metricLabel: top?.metricLabel || 'ops/s', from: top?.from ?? null, to: top?.to ?? null, skewFactor: top?.skewFactor ?? 1.5, skewed: skewed.map((c) => ({ name: c.name, corpName: c.corpName, maxRatio: c.maxRatio, maxLnn: c.maxLnn })) },
    protection: prot, todo, refs: REFS.filter((r) => usedRefs.includes(r.n)), thresholds: model?.thresholds || null,
  };
}

const badge = (s) => `<span style="display:inline-block;padding:0 5px;border-radius:3px;font-size:11px;font-weight:700;white-space:nowrap;background:${BG[s] || '#eee'};color:${COLOR[s] || '#333'};border:1px solid ${COLOR[s] || '#999'}">${esc(STATUS_KO[s] || s)}</span>`;
const TH = 'text-align:left;font-weight:600;color:#4a5670;padding:4px 6px;border-bottom:1px solid #9aa5b8;white-space:nowrap';
const TD = 'padding:4px 6px;border-bottom:1px solid #dfe4ec;vertical-align:top';
const TDN = `${TD};text-align:right;font-family:Consolas,monospace;white-space:nowrap`;
const H2 = 'margin:16px 0 6px;font-size:14px;padding-bottom:3px;border-bottom:1.5px solid #1a2233';
/** 자급형 HTML(메일 본문 · 첨부 · 인쇄 공용). 인라인 CSS 만 — 메일 프로그램이 &lt;style&gt; 을 버려도 읽힌다. */
export function renderReportHtml(m) {
  const c = m.counts;
  const head = `<h1 style="margin:0;font-size:20px">PowerScale 주간 점검 보고서${m.corpName ? ` — ${esc(m.corpName)}` : ''}</h1>
<div style="color:#4a5670;font-size:12px;margin-top:2px">${esc(m.week)} · 마지막 점검 ${esc(kstText(m.lastRun))} KST · 만든 시각 ${esc(kstText(m.generatedAt))} KST${m.portal ? ` · ${esc(m.portal)}` : ''} · 대상 ${m.corps} 법인 · ${m.devices.length} 클러스터 · ${m.nodes} 노드${m.nodesUnknown ? `(노드 수 모름 ${m.nodesUnknown}대 제외)` : ''}</div>`;
  const summary = `<h2 style="${H2}">1. 요약</h2>
<div style="font-size:13px">항목 ${m.total}개 — 정상 <b>${c.ok}</b> · 주의 <b style="color:${COLOR.warn}">${c.warn}</b> · 이상 <b style="color:${COLOR.bad}">${c.bad}</b> · 확인 불가 <b>${c.unknown}</b> · 해당 없음 ${c.na}. 확인하지 못한 항목은 정상에 넣지 않았습니다.</div>`;
  const corpRows = m.devices.map((d) => `<tr><td style="${TD}">${esc(d.corpName)}</td><td style="${TD}">${esc(d.name)}</td><td style="${TD}">${esc(d.version || '—')}</td><td style="${TDN}">${d.nodeCount ?? '—'}</td><td style="${TDN}">${pctText(d.capacityPct)}</td>`
    + `<td style="${TDN}">${d.summary.ok}</td><td style="${TDN}">${d.summary.warn}</td><td style="${TDN}">${d.summary.bad}</td><td style="${TDN}">${d.summary.unknown}</td><td style="${TDN}">${d.skewRatio != null ? `${d.skewRatio}×` : '—'}</td>`
    + `<td style="${TD}">${d.runAt ? esc(kstText(d.runAt)) : '점검 안 함'}${d.staleDays ? ` <b style="color:${COLOR.warn}">(${d.staleDays}일 전 — 판정 안 함)</b>` : ''}${d.worse ? ` · <b style="color:${COLOR.bad}">나빠짐 ${d.worse}</b>` : ''}${d.better ? ` · 풀림 ${d.better}` : ''}</td></tr>`).join('');
  const corp = `<h2 style="${H2}">2. 법인별 결과</h2><table style="width:100%;border-collapse:collapse;font-size:12px"><tr><th style="${TH}">법인</th><th style="${TH}">클러스터</th><th style="${TH}">OneFS</th><th style="${TH}">노드</th><th style="${TH}">용량</th><th style="${TH}">정상</th><th style="${TH}">주의</th><th style="${TH}">이상</th><th style="${TH}">불가</th><th style="${TH}">편중</th><th style="${TH}">점검 · 지난번 대비</th></tr>${corpRows || `<tr><td style="${TD}" colspan="11">대상 장비가 없습니다.</td></tr>`}</table>`;
  const issueRows = m.issues.map((x) => `<tr><td style="${TD}">${badge(x.status)}</td><td style="${TD}">${esc(x.corp)} · ${esc(x.device)} · <b>${esc(x.label)}</b></td><td style="${TD}">${esc(x.value)}</td><td style="${TD}">${esc(x.basis)}</td><td style="${TD}">${esc(x.action)}</td></tr>`).join('');
  const issues = `<h2 style="${H2}">3. 이상 · 주의 항목과 조치(${m.issues.length})</h2>${m.issues.length ? `<table style="width:100%;border-collapse:collapse;font-size:12px"><tr><th style="${TH}"></th><th style="${TH}">법인 · 장비 · 항목</th><th style="${TH}">본 값</th><th style="${TH}">기준</th><th style="${TH}">조치 · 근거</th></tr>${issueRows}</table>` : '<div style="font-size:12px">이상 · 주의 항목이 없습니다.</div>'}`;
  const unkRows = m.unknowns.slice(0, 60).map((u) => `<tr><td style="${TD}">${esc(u.corp)} · ${esc(u.device)}</td><td style="${TD}">${esc(u.label)}</td><td style="${TD}">${esc(u.why)}</td></tr>`).join('');
  const unknown = `<h2 style="${H2}">4. 확인하지 못한 항목(${m.unknowns.length})</h2>${m.unknowns.length ? `<table style="width:100%;border-collapse:collapse;font-size:12px"><tr><th style="${TH}">법인 · 장비</th><th style="${TH}">항목</th><th style="${TH}">사유</th></tr>${unkRows}</table>${m.unknowns.length > 60 ? `<div style="font-size:11px;color:#4a5670">외 ${m.unknowns.length - 60}건은 포탈 화면에서 봅니다.</div>` : ''}` : '<div style="font-size:12px">없습니다.</div>'}`;
  const capRows = [...m.devices].sort((a, b) => (b.capacityPct ?? -1) - (a.capacityPct ?? -1)).map((d) => `<tr><td style="${TD}">${esc(d.corpName)} · ${esc(d.name)}</td><td style="${TDN}">${pctText(d.capacityPct)}</td><td style="${TD}">${d.capacityPct == null ? '—' : d.capacityPct >= (m.thresholds?.capBadPct ?? 90) ? badge('bad') : d.capacityPct >= (m.thresholds?.capWarnPct ?? 80) ? badge('warn') : badge('ok')}</td></tr>`).join('');
  const cap = `<h2 style="${H2}">5. 용량(${m.thresholds?.capWarnPct ?? 80}% 증설 발주 · ${m.thresholds?.capBadPct ?? 90}% 상한)</h2><table style="width:100%;border-collapse:collapse;font-size:12px"><tr><th style="${TH}">법인 · 클러스터</th><th style="${TH}">사용률</th><th style="${TH}">판정</th></tr>${capRows}</table>`;
  const tr = m.top.rows.map((r, i) => `<tr><td style="${TDN}">${i + 1}</td><td style="${TD}">${esc(r.corpName)} · ${esc(r.name)} · 노드 ${r.lnn}</td><td style="${TDN}">${num(r.value)}</td><td style="${TDN}">${r.ratio != null ? `<b style="color:${r.skewed ? COLOR.warn : '#1a2233'}">${r.ratio}×</b>` : '—'}</td><td style="${TDN}">${pctText(r.share)}</td><td style="${TDN}">${r.cpuAvg != null ? `${pctText(r.cpuAvg)} · ${pctText(r.cpuMax)}` : '—'}</td><td style="${TDN}">${r.busyAvg != null ? `${pctText(r.busyAvg)} · ${pctText(r.busyMax)}` : '—'}</td></tr>`).join('');
  const top = `<h2 style="${H2}">6. 성능 — 가장 바쁜 노드 10개와 편중</h2><div style="font-size:12px;margin-bottom:4px">전 노드를 지난 7일 평균 ${esc(m.top.metricLabel)} 로 줄 세운 상위 10개입니다(${esc(kstText(m.top.from))} ~ ${esc(kstText(m.top.to))}). ‘평균 대비’ 는 자기 클러스터 노드 평균의 몇 배인지, ‘비중’ 은 그 클러스터 안 몫입니다. ${m.top.skewFactor}배 이상(포탈 기준 — Dell 수치 아님)인 클러스터: ${m.top.skewed.length ? m.top.skewed.map((c) => `${esc(c.corpName)} · ${esc(c.name)} 노드 ${c.maxLnn} ${c.maxRatio}×`).join(' · ') : '없음'}. CPU · 디스크 busy 는 기준 없이 값만 싣습니다.</div>
${m.top.rows.length ? `<table style="width:100%;border-collapse:collapse;font-size:12px"><tr><th style="${TH}">#</th><th style="${TH}">법인 · 클러스터 · 노드</th><th style="${TH}">${esc(m.top.metricLabel)}</th><th style="${TH}">평균 대비</th><th style="${TH}">비중</th><th style="${TH}">CPU 평균 · 피크</th><th style="${TH}">busy 평균 · 피크</th></tr>${tr}</table>` : '<div style="font-size:12px">7일 안에 노드 표본이 없습니다(표본 수집이 꺼졌거나 아직 쌓이지 않았습니다).</div>'}`;
  const pr = m.protection.map((p) => `<tr><td style="${TD}">${esc(p.name)}</td><td style="${TD}">${p.synciq ? `${badge(p.synciq.status)} ${esc(p.synciq.value)}` : '—'}</td><td style="${TD}">${p.snapshots ? `${badge(p.snapshots.status)} ${esc(p.snapshots.value)}` : '—'}</td><td style="${TD}">${p.jobs ? `${badge(p.jobs.status)} ${esc(p.jobs.value)}` : '—'}</td><td style="${TD}">${p.reprotect ? esc(p.reprotect.value) : '—'}</td></tr>`).join('');
  const prot = `<h2 style="${H2}">7. 데이터 보호</h2><table style="width:100%;border-collapse:collapse;font-size:12px"><tr><th style="${TH}">클러스터</th><th style="${TH}">SyncIQ</th><th style="${TH}">스냅샷</th><th style="${TH}">잡 엔진</th><th style="${TH}">재보호</th></tr>${pr}</table>`;
  const todo = `<h2 style="${H2}">8. 다음 주까지 확인할 것</h2>${m.todo.length ? `<ul style="margin:4px 0 0 18px;padding:0;font-size:12px">${m.todo.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '<div style="font-size:12px">없습니다.</div>'}`;
  const refs = `<h2 style="${H2}">9. 근거 자료</h2><div style="font-size:11px;color:#4a5670">${m.refs.map((r) => `[${r.n}] ${esc(r.title)} — ${esc(r.kind)} · ${esc(REF_LEVEL_KO[r.level] || r.level)}`).join('<br>')}<br>${esc(SOURCES_NOTE)} 편중 기준 ${m.top.skewFactor}배는 포탈 기준이며 Dell 수치가 아닙니다.</div>`;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>PowerScale 주간 점검 보고서</title></head>
<body style="margin:0;padding:24px;background:#fff;color:#1a2233;font-family:-apple-system,'Segoe UI','Apple SD Gothic Neo','Noto Sans KR',sans-serif;word-break:keep-all;max-width:960px">
${head}${summary}${corp}${issues}${unknown}${cap}${top}${prot}${todo}${refs}
</body></html>`;
}
/** 메일 제목 · 본문(같은 HTML) · 첨부 파일 이름 · 글자판(텍스트 메일 대안). */
export function reportMailParts(m) {
  const c = m.counts;
  const subject = `[PowerScale 주간 점검] ${m.week}${m.corpName ? ` · ${m.corpName}` : ''} — 이상 ${c.bad} · 주의 ${c.warn} · 확인 불가 ${c.unknown}`;
  const text = [`PowerScale 주간 점검 보고서 — ${m.week}`, `정상 ${c.ok} · 주의 ${c.warn} · 이상 ${c.bad} · 확인 불가 ${c.unknown} · 해당 없음 ${c.na}`, '',
    ...m.issues.slice(0, 20).map((x) => `[${STATUS_KO[x.status]}] ${x.corp} · ${x.device} · ${x.label}: ${x.value} — ${x.action}`), '', '전체 내용은 첨부(HTML — 브라우저에서 열어 인쇄 › PDF 로 저장)를 봅니다.'].join('\n');
  const safe = (s) => String(s || '').replace(/[^\w가-힣.-]+/g, '-').slice(0, 40);
  return { subject: subject.slice(0, 200), html: renderReportHtml(m), text, filename: `powerscale-inspect-${safe(m.week)}${m.corpName ? `-${safe(m.corpName)}` : ''}.html` };
}
/** CSV(장비 × 항목) — 수식 가드 · BOM. */
export function reportCsv(model) {
  const lines = [csvLine(['법인', '클러스터', '점검 시각(KST)', '#', '구분', '항목', '결과', '본 값', '기준', '확인 불가 사유', '근거'])];
  const gl = new Map(GROUPS.map((g) => [g.id, g.label]));
  for (const d of model?.devices || []) for (const i of d.items || []) {
    lines.push(csvLine([d.corpName, d.name, d.run ? kstText(d.run.at) : '', i.no, gl.get(i.group) || i.group, i.label, STATUS_KO[i.status] || i.status, i.value, i.basis, i.why || '', (i.refs || []).map((n) => `[${n}]`).join('')]));
  }
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`;
}
export const _ITEMS_COUNT = ITEMS.length;
