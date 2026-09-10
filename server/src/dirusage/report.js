/**
 * dirusage/report.js — 폴더 사용량 Top-N 리포트 본문 생성 (순수 모듈, v2.454).
 *
 * HTML 과 텍스트를 함께 만든다(multipart/alternative). 메일 클라이언트는 `<style>` 블록·외부 CSS·
 * flex/grid 를 대부분 무시하거나 지워 버리므로 **인라인 스타일 + table 레이아웃**만 쓴다.
 * (Outlook 은 특히 완고하다 — 여기서 `<div>` 격자를 쓰면 한 줄로 무너진다.)
 *
 * 값 표기 규칙은 화면과 같은 함수를 쓴다(scan.js humanBytes) — 메일과 화면 숫자가 어긋나지 않게.
 * 증감이 null 이면 '—' 로 둔다(직전 관측이 없다는 뜻이며 0 으로 채우지 않는다).
 */
import { humanBytes, deltaMap, removedEntries } from './scan.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtTs = (ts) => {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 증감 표기 — 양수는 +, null 은 '—'(신규는 '신규'). */
function fmtDelta(d) {
  if (!d) return '—';
  if (d.isNew) return '신규';
  if (d.deltaBytes == null) return '—';
  if (d.deltaBytes === 0) return '0';
  return `${d.deltaBytes > 0 ? '+' : ''}${humanBytes(d.deltaBytes)}`;
}

/** 제목 — 설정에서 바꿀 수 있고, `{root}`·`{date}`·`{agent}` 치환을 지원한다. */
export function renderSubject(template, { root, agent, ts, topN }) {
  const t = String(template || '[VMware Portal] {root} 폴더 사용량 Top {topN} ({date})');
  return t
    .replace(/\{root\}/g, String(root || ''))
    .replace(/\{agent\}/g, String(agent || ''))
    .replace(/\{topN\}/g, String(topN ?? ''))
    .replace(/\{date\}/g, fmtTs(ts).slice(0, 10));
}

/**
 * 리포트 본문.
 * @param {object} scan  buildScanRecord() 결과
 * @param {object|null} prev 직전 스캔(증감 계산용, 없으면 null)
 * @returns {{html:string, text:string}}
 */
export function renderReport(scan, prev = null) {
  const rows = scan?.entries || [];
  const dm = deltaMap(rows, prev?.entries || null);
  const removed = removedEntries(rows, prev?.entries || null);
  const denom = Number.isFinite(scan?.totalBytes) && scan.totalBytes > 0 ? scan.totalBytes : scan?.sumBytes || 0;
  const pct = (b) => (denom > 0 ? `${Math.round((b / denom) * 1000) / 10}%` : '—');

  // ── 텍스트 (HTML 을 막아 둔 클라이언트·모바일 알림 미리보기용) ──────────────────
  const tl = [];
  tl.push(`${scan.root} 폴더 사용량 Top ${rows.length}`);
  tl.push(`수집: ${fmtTs(scan.ts)} · 엣지: ${scan.agent || '-'}`);
  tl.push(`전체 ${humanBytes(scan.totalBytes ?? scan.sumBytes)} · 하위 폴더 ${scan.count}개`);
  if (prev) tl.push(`직전 수집: ${fmtTs(prev.ts)} 대비 증감 표시`);
  tl.push('');
  tl.push('순위  사용량        비율    증감        폴더');
  rows.forEach((e, i) => {
    tl.push(`${String(i + 1).padStart(3)}  ${humanBytes(e.bytes).padStart(11)}  ${pct(e.bytes).padStart(6)}  ${fmtDelta(dm.get(e.name)).padStart(10)}  ${e.name}`);
  });
  if (scan.othersCount > 0) tl.push(`      ${humanBytes(scan.othersBytes).padStart(11)}  ${pct(scan.othersBytes).padStart(6)}              (그 외 ${scan.othersCount}개)`);
  if (removed.length) tl.push('', `사라진 폴더 ${removed.length}개: ${removed.slice(0, 10).map((r) => r.name).join(', ')}${removed.length > 10 ? ' …' : ''}`);
  if (scan.skipped) tl.push('', `⚠ 해석하지 못한 줄 ${scan.skipped}개(권한 없는 폴더이거나 이름에 개행이 있는 경우).`);
  if (scan.truncated) tl.push('⚠ 하위 폴더가 매우 많아 일부만 집계했습니다.');
  const text = tl.join('\n');

  // ── HTML ────────────────────────────────────────────────────────────────────
  const th = 'padding:8px 10px;border-bottom:2px solid #d0d5dd;text-align:left;font-size:13px;color:#344054;background:#f9fafb;';
  const thR = th + 'text-align:right;';
  const td = 'padding:7px 10px;border-bottom:1px solid #eaecf0;font-size:13px;color:#101828;';
  const tdR = td + 'text-align:right;font-variant-numeric:tabular-nums;';
  const muted = 'color:#667085;';

  const bar = (b) => {
    const w = denom > 0 ? Math.max(1, Math.round((b / denom) * 100)) : 0;
    // 막대도 table 로 그린다 — div+width 는 일부 클라이언트가 무너뜨린다.
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:90px;border-collapse:collapse;">`
      + `<tr><td style="height:8px;width:${w}%;background:#2e90fa;border-radius:2px;font-size:0;line-height:0;">&nbsp;</td>`
      + `<td style="height:8px;background:#eaecf0;border-radius:2px;font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
  };

  const body = rows.map((e, i) => {
    const d = dm.get(e.name);
    const dCol = d?.isNew ? '#7a5af8' : d?.deltaBytes > 0 ? '#d92d20' : d?.deltaBytes < 0 ? '#039855' : '#667085';
    return `<tr>`
      + `<td style="${tdR}${muted}">${i + 1}</td>`
      + `<td style="${td}word-break:break-all;">${esc(e.name)}</td>`
      + `<td style="${tdR}font-weight:600;">${esc(humanBytes(e.bytes))}</td>`
      + `<td style="${tdR}${muted}">${esc(pct(e.bytes))}</td>`
      + `<td style="${td}">${bar(e.bytes)}</td>`
      + `<td style="${tdR}color:${dCol};">${esc(fmtDelta(d))}</td>`
      + `</tr>`;
  }).join('');

  const others = scan.othersCount > 0
    ? `<tr><td style="${tdR}${muted}">·</td><td style="${td}${muted}">그 외 ${scan.othersCount}개 폴더</td>`
      + `<td style="${tdR}${muted}">${esc(humanBytes(scan.othersBytes))}</td><td style="${tdR}${muted}">${esc(pct(scan.othersBytes))}</td>`
      + `<td style="${td}"></td><td style="${tdR}${muted}">—</td></tr>`
    : '';

  const notes = [];
  if (removed.length) notes.push(`직전 수집에 있었으나 사라진 폴더 <b>${removed.length}개</b>: ${esc(removed.slice(0, 10).map((r) => r.name).join(', '))}${removed.length > 10 ? ' …' : ''}`);
  if (scan.skipped) notes.push(`해석하지 못한 줄 <b>${scan.skipped}개</b> — 읽기 권한이 없는 폴더이거나 이름에 개행이 든 경우입니다. 그만큼 합계에서 빠집니다.`);
  if (scan.truncated) notes.push('하위 폴더가 매우 많아 일부만 집계했습니다.');
  if (!prev) notes.push('직전 수집 기록이 없어 <b>증감을 표시하지 않았습니다</b>(다음 회차부터 표시됩니다).');

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Malgun Gothic',sans-serif;max-width:760px;margin:0 auto;padding:16px;color:#101828;">
  <h2 style="margin:0 0 4px;font-size:18px;">${esc(scan.root)} 폴더 사용량 Top ${rows.length}</h2>
  <div style="${muted}font-size:12.5px;margin-bottom:14px;">
    수집 ${esc(fmtTs(scan.ts))}${scan.agent ? ` · 엣지 <b>${esc(scan.agent)}</b>` : ''}
    ${prev ? ` · 직전 수집 ${esc(fmtTs(prev.ts))} 대비 증감` : ''}
  </div>
  <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin-bottom:14px;background:#f9fafb;border-radius:6px;">
    <tr>
      <td style="padding:10px 12px;font-size:12.5px;${muted}">전체 사용량<br><span style="font-size:17px;color:#101828;font-weight:600;">${esc(humanBytes(scan.totalBytes ?? scan.sumBytes))}</span></td>
      <td style="padding:10px 12px;font-size:12.5px;${muted}">하위 폴더<br><span style="font-size:17px;color:#101828;font-weight:600;">${scan.count}개</span></td>
      <td style="padding:10px 12px;font-size:12.5px;${muted}">상위 ${rows.length}개 합<br><span style="font-size:17px;color:#101828;font-weight:600;">${esc(humanBytes(rows.reduce((s, e) => s + e.bytes, 0)))}</span></td>
    </tr>
  </table>
  <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;">
    <thead><tr>
      <th style="${thR}width:36px;">#</th><th style="${th}">폴더(사용자)</th>
      <th style="${thR}">사용량</th><th style="${thR}">비율</th>
      <th style="${th}width:96px;"></th><th style="${thR}">증감</th>
    </tr></thead>
    <tbody>${body}${others}</tbody>
  </table>
  ${notes.length ? `<ul style="${muted}font-size:12px;line-height:1.7;margin:14px 0 0;padding-left:18px;">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>` : ''}
  <div style="${muted}font-size:11.5px;margin-top:18px;border-top:1px solid #eaecf0;padding-top:10px;">
    VMware Global Monitoring Portal — 설정 › 폴더 사용량 리포트에서 주기·대상·수신자를 변경할 수 있습니다.
  </div>
</div>`;

  return { html, text };
}
