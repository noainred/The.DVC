/**
 * guestpart/mailHtml.js — 게스트 파티션 사용률 메일 본문(HTML + 텍스트, v2.749). 순수 — 발송·파일 없음.
 *
 * 메일 클라이언트는 외부 CSS 를 버리므로 모든 스타일은 인라인이다. 운영 데이터(VM 이름·경로·vCenter 이름)는 전부 esc() 를 거친다.
 * 값이 없으면 0 이 아니라 '—' 이고 단위를 붙이지 않는다(CLAUDE.md '못 읽은 값은 0 이 아니다').
 */
import { esc } from '../isidu/mailHtml.js';
import { slotLabel } from '../isidu/digestRules.js';

const gb = (v) => {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  return n >= 1024 ? `${(n / 1024).toFixed(1)} TB` : `${n.toFixed(n < 100 ? 1 : 0)} GB`;
};
const pct = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}%`);
const pctColor = (v) => (v >= 95 ? '#b91c1c' : v >= 90 ? '#c2410c' : '#a16207');
const OS = { win: 'Windows', lnx: 'Linux', other: '기타' };
const etaText = (d) => (d == null ? '—' : d < 1 ? '1일 안' : d < 365 ? `${Math.round(d)}일 뒤` : '1년 이상');

/**
 * @param {object} m
 *  kind: 'digest'|'vcenter'|'crit'|'test' · scopeLabel: '전체 법인' 또는 vCenter 이름 · thr · mode · collectedAt
 *  rows: 초과 행(사용률 내림차순) · total: 전체 초과 수 · topN · newKeys: Set(새로 넘은 키) · newOnly · kpi: { overVms, crit, notReported, newCount }
 *  vcSummary: [{name, overVms, maxPct}] (통합 메일만) · staleNote · csvName · demo
 */
export function renderOverMail(m) {
  const title = m.kind === 'crit'
    ? `[VMware 포탈] 게스트 파티션 ${m.critPct ?? 95}% 이상 — ${m.scopeLabel} ${m.total}개`
    : `[VMware 포탈] 게스트 파티션 ${m.thr}% 초과 — ${m.scopeLabel} ${m.newOnly ? `새로 넘은 ${m.mode === 'vm' ? '게스트' : '파티션'} ${m.kpi.newCount}개` : `게스트 ${m.kpi.overVms}대`}`;
  const subject = `${m.kind === 'test' ? '[테스트] ' : ''}${title}${m.collectedAt ? ` (${slotLabel(m.collectedAt)} 수집)` : ''}`;
  const rows = (m.rows || []).slice(0, m.topN || 15);
  const keyOf = (r) => (r.path == null ? r.vmId : `${r.vmId}\u0000${r.path}`);
  const lead = m.kind === 'crit'
    ? `방금 끝난 수집에서 사용률이 <b>${m.critPct ?? 95}%</b> 이상인 파티션입니다. 같은 파티션은 24시간에 한 번만 알립니다.`
    : `사용률이 <b>${m.thr}%</b> 이상인 게스트입니다(${m.mode === 'vm' ? 'VM 파티션 합계 기준' : '파티션 하나라도 넘으면'}). ${m.newOnly ? '지난 메일 이후 새로 넘은 것만 실었습니다.' : '사용률 높은 순입니다.'}`;
  const kpiCell = (label, value, bg, fg) => `<td style="padding:10px;border-radius:8px;background:${bg};border:1px solid #e2e8f0;width:25%"><div style="font-size:11px;color:${fg}">${esc(label)}</div><div style="font-size:22px;font-weight:700;color:${fg}">${esc(value)}</div></td>`;
  const kpis = m.kind === 'crit' ? '' : `<table role="presentation" cellspacing="6" style="width:100%;border-collapse:separate"><tr>
${kpiCell('초과 게스트', m.kpi.overVms, '#fff7ed', '#9a3412')}${kpiCell('95% 이상', m.kpi.crit, '#fef2f2', '#991b1b')}${kpiCell(m.mode === 'vm' ? '새로 넘은 게스트' : '새로 넘은 파티션', m.kpi.newCount, '#f1f5f9', '#0f172a')}${kpiCell('확인 불가', m.kpi.notReported, '#f1f5f9', '#475569')}
</tr></table>`;
  const tr = rows.map((r) => `<tr style="border-bottom:1px solid #e2e8f0">
<td style="padding:7px 8px;font-weight:600">${esc(r.vmName)}${m.newKeys?.has(keyOf(r)) ? ' <span style="font-size:11px;color:#0e7490">새로</span>' : ''}</td>
<td style="padding:7px 8px;color:#475569">${esc(r.vcenterName)}</td>
<td style="padding:7px 8px;color:#475569">${esc(OS[r.os] || '')}</td>
<td style="padding:7px 8px;font-family:Consolas,monospace">${esc(r.path ?? `파티션 ${r.partCount ?? ''}개 합계`)}</td>
<td style="padding:7px 8px;text-align:right;font-family:Consolas,monospace">${esc(gb(r.usedGB))} / ${esc(gb(r.capGB))}</td>
<td style="padding:7px 8px;text-align:right;font-weight:700;color:${pctColor(r.pct)}">${esc(pct(r.pct))}</td>
<td style="padding:7px 8px;text-align:right;color:#475569">${esc(etaText(r.etaDays))}</td></tr>`).join('');
  const vcs = (m.vcSummary || []).filter((v) => v.overVms > 0).slice(0, 30);
  const vcTable = vcs.length ? `<div style="font-size:13px;font-weight:700;margin:14px 0 6px">vCenter 별</div>
<table style="width:100%;border-collapse:collapse;font-size:12.5px"><tr style="background:#e2e8f0;text-align:left;color:#334155"><th style="padding:6px 8px">vCenter</th><th style="padding:6px 8px;text-align:right">초과 게스트</th><th style="padding:6px 8px;text-align:right">최고 사용률</th></tr>
${vcs.map((v) => `<tr style="border-bottom:1px solid #e2e8f0"><td style="padding:6px 8px">${esc(v.name)}</td><td style="padding:6px 8px;text-align:right">${esc(v.overVms)}</td><td style="padding:6px 8px;text-align:right">${esc(pct(v.maxPct))}</td></tr>`).join('')}</table>` : '';
  const more = m.total > rows.length
    ? `본문은 상위 ${rows.length}개까지입니다 · 전체 ${m.total}개는 ${m.csvName ? `첨부 CSV(${esc(m.csvName)})` : '포탈'}에서 보세요.`
    : `전체 ${m.total}개입니다.`;
  const html = `<!doctype html><html lang="ko"><body style="margin:0;background:#f8fafc;color:#0f172a;font-family:'Malgun Gothic',Arial,sans-serif">
<div style="max-width:760px;margin:0 auto;padding:20px">
${m.demo ? '<div style="padding:8px 10px;margin-bottom:10px;background:#fef9c3;border:1px solid #fde68a;font-size:12px">데모(mock) 데이터로 만든 미리보기입니다.</div>' : ''}
${m.staleNote ? `<div style="padding:8px 10px;margin-bottom:10px;background:#fff7ed;border:1px solid #fed7aa;font-size:12.5px;color:#9a3412">${esc(m.staleNote)}</div>` : ''}
<div style="font-size:16px;font-weight:700;margin-bottom:6px">${esc(m.scopeLabel)} — 게스트 파티션 사용률</div>
<div style="font-size:13.5px;line-height:1.7;margin-bottom:10px">${lead}</div>
${kpis}
<table style="width:100%;border-collapse:collapse;font-size:12.5px;margin-top:8px"><tr style="background:#e2e8f0;text-align:left;color:#334155">
<th style="padding:7px 8px">게스트</th><th style="padding:7px 8px">vCenter</th><th style="padding:7px 8px">OS</th><th style="padding:7px 8px">파티션</th><th style="padding:7px 8px;text-align:right">사용 / 할당</th><th style="padding:7px 8px;text-align:right">사용률</th><th style="padding:7px 8px;text-align:right">가득 참 예상</th></tr>
${tr || '<tr><td colspan="7" style="padding:14px;text-align:center;color:#475569">해당 게스트가 없습니다.</td></tr>'}</table>
<div style="font-size:12px;color:#475569;margin-top:6px">${more}</div>
${vcTable}
<div style="font-size:11.5px;color:#475569;border-top:1px solid #e2e8f0;padding-top:10px;margin-top:14px;line-height:1.6">
사용률은 VMware Tools 가 보고한 게스트 파일시스템 기준입니다. Tools 가 돌지 않거나 전원이 꺼진 게스트${m.kpi.notReported ? ` ${esc(m.kpi.notReported)}대` : ''}는 확인할 수 없어 이 목록에 없습니다.
가득 참 예상은 지난 7일 증가 속도를 그대로 이어 간 단순 추정입니다. 무시 규칙(Windows 드라이브·Linux 마운트 지점 등)에 걸린 파티션은 싣지 않았습니다.
이 메일은 포탈 설정 › 수집 서버 › 게스트 파티션 사용률에서 끄거나 바꿀 수 있습니다.</div>
</div></body></html>`;
  const text = [
    title, '',
    m.kind === 'crit' ? `사용률 ${m.critPct ?? 95}% 이상 파티션 ${m.total}개` : `임계 ${m.thr}% · 초과 게스트 ${m.kpi.overVms}대 · 95% 이상 ${m.kpi.crit} · 새로 넘은 ${m.mode === 'vm' ? '게스트' : '파티션'} ${m.kpi.newCount} · 확인 불가 ${m.kpi.notReported}대`,
    '',
    ...rows.map((r) => `${r.vmName} | ${r.vcenterName} | ${r.path ?? `파티션 ${r.partCount ?? ''}개 합계`} | ${gb(r.usedGB)} / ${gb(r.capGB)} | ${pct(r.pct)} | ${etaText(r.etaDays)}`),
    '', more.replace(/<[^>]{0,200}>/g, ''),
  ].join('\n');
  return { subject, html, text };
}

/** 수집 실패·지연 알림. */
export function renderFailMail({ vcenterName, error = '', staleSince = null, now = Date.now() }) {
  const subject = `[VMware 포탈] 게스트 파티션 수집 ${error ? '실패' : '지연'} — ${vcenterName}`;
  const body = error
    ? `${vcenterName} 의 게스트 파티션 수집이 실패했습니다: ${String(error).slice(0, 300)}`
    : `${vcenterName} 의 게스트 파티션 값이 ${staleSince ? `${slotLabel(staleSince)} 수집 이후` : '오래'} 갱신되지 않았습니다(엣지 전송 지연·수집 꺼짐·vCenter 접속 문제일 수 있습니다).`;
  const html = `<!doctype html><html lang="ko"><body style="margin:0;background:#f8fafc;color:#0f172a;font-family:'Malgun Gothic',Arial,sans-serif"><div style="max-width:640px;margin:0 auto;padding:20px">
<div style="font-size:15px;font-weight:700;margin-bottom:8px">${esc(subject)}</div><div style="font-size:13.5px;line-height:1.7">${esc(body)}</div>
<div style="font-size:11.5px;color:#475569;margin-top:12px">같은 vCenter 의 이 알림은 6시간에 한 번까지 보냅니다. 확인 시각 ${esc(slotLabel(now))}.</div></div></body></html>`;
  return { subject, html, text: `${subject}\n\n${body}` };
}
