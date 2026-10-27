/**
 * vcenter/hostExportXlsx.js — '호스트 · 클러스터 엑셀' 워크북(v2.802 — 승인 시안 https://claude.ai/artifact/HKxFuVeie66ddR2i8VxmFX ·
 *   사용자 요청 "호스트 및 클러스터 정보로 VM 처럼 멋지게 · 호스트 1개에 엑셀 sheet 1개 · 최대한 자세하고 많은 정보").
 *
 *  ① 요약 — KPI 8칸 · 클러스터별 표 · 확인할 것(호스트 시트로 가는 링크)
 *  ② 클러스터 — HA · 승인 제어 · 호스트 모니터링 · DRS · EVC · 규칙 · ESXi 빌드 종류(클러스터 점검 권한이 있을 때)
 *  ③ 호스트 목록 — 한 줄 = 호스트 1대(호스트 이름 = 그 호스트 시트로 가는 링크) · 묶음 띠 · 첫 행·첫 열 고정 · 자동 필터
 *  ④ 호스트 시트(1대 = 1장) — 머리(← 호스트 목록 · 이전/다음 호스트) · KPI 8칸 · 왼쪽(기본 · 클러스터 · 구성·보안 점검) ·
 *     오른쪽(네트워크 · 스토리지 · 하드웨어 · 최근 재부팅) · 아래 VM 표(자동 필터)
 *  ⑤ 읽는 법 — 조건 · 뺀 묶음과 사유 · 출처 · 표기
 * 값은 hostExport.js 가 만든 것을 배치만 한다(판정을 새로 하지 않는다 — 칸 글자로 색만 고른다). 못 읽은 값은 '—'(단위를 붙이지 않는다) ·
 *   부분 합은 '≥'. 수식 칸·조건부 서식을 쓰지 않는다(vmXlsxStyle.js 머리말과 같은 이유). 시트 안 링크는 규격 모양(util/xlsxInternalLink.js).
 * ⚠ 이 파일은 워커(hostExportXlsxWorker.js)에서도 로드된다 — store·config·DB 같은 부수효과 있는 import 를 넣지 말 것
 *   (hostExport.js 도 불러오지 않는다 — 시트 이름은 여기 두고 테스트가 RESERVED_SHEETS 와 대조한다).
 */
import ExcelJS from 'exceljs';
import { runXlsxWorker } from '../util/xlsxWorkerRun.js';
import { sheetLink } from '../util/xlsxInternalLink.js';
import { localStamp } from '../util/dayKey.js';
import { BORDER, PAL, fill, styleHeadRow, barText, numFmtOf } from './vmXlsxStyle.js';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const HOST_XLSX_SHEETS = Object.freeze(['요약', '클러스터', '호스트 목록', '읽는 법']);
const [S_SUM, S_CL, S_LIST, S_GUIDE] = HOST_XLSX_SHEETS;
const DASH = '—';
const LIST_FIRST_ROW = 3;   // 호스트 목록 시트: 1행 묶음 띠 · 2행 머리 · 3행부터 호스트
const yieldLoop = () => new Promise((r) => setImmediate(r));
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const n1 = (v) => (fin(v) ? Math.round(v * 10) / 10 : null);
const fmt = (v, d = 0) => (fin(v) ? v.toLocaleString('en-US', { maximumFractionDigits: d }) : DASH);
const ratioText = (v) => (fin(v) ? `${v.toFixed(1)}:1` : DASH);
const stampOf = (p, ms) => (fin(ms) && ms > 0 ? localStamp(ms, p.meta.offsetMin) : DASH);

const C = Object.freeze({
  link: 'FF1D4ED8', gray: 'FF64748B', okBg: 'FFDCFCE7', okFg: 'FF166534', infoBg: 'FFE0F2FE', infoFg: 'FF075985', subHead: 'FFEEF2F7', subHeadFg: 'FF334155',
  rule: 'FF94A3B8', sec: 'FF1E3A5F',
});
const STATE_LOOK = Object.freeze({ CONNECTED: { color: PAL.green }, MAINTENANCE: { color: PAL.amber }, DISCONNECTED: { color: PAL.red } });
const SEV_LOOK = Object.freeze({
  crit: { bg: PAL.redBg, color: PAL.redFg, bold: true }, warn: { bg: PAL.amberBg, color: PAL.amberFg, bold: true },
  info: { bg: C.infoBg, color: C.infoFg }, ok: { bg: C.okBg, color: C.okFg, bold: true },
});
const HW_LOOK = Object.freeze({ ok: SEV_LOOK.ok, warn: SEV_LOOK.warn, fault: SEV_LOOK.crit, unknown: { color: C.gray } });
const HW_TEXT = Object.freeze({ ok: '✓ 정상', warn: '⚠ 주의', fault: '✕ 장애', unknown: '? 모름', '': DASH });
const BOOT_LOOK = Object.freeze({ unexpected: SEV_LOOK.crit, unknown: SEV_LOOK.warn, 'no-events': { color: C.gray }, planned: SEV_LOOK.ok });
const EVIDENCE_TEXT = Object.freeze({
  EnteringMaintenanceModeEvent: '유지보수 모드 진입', EnteredMaintenanceModeEvent: '유지보수 모드 진입', HostShutdownEvent: 'vCenter 의 종료 요청', HostConnectionLostEvent: 'vCenter 와 연결 끊김',
});
const DRS_TEXT = Object.freeze({ fullyAutomated: '완전 자동', partiallyAutomated: '부분 자동', manual: '수동' });
const VMMON_TEXT = Object.freeze({ vmMonitoringDisabled: '꺼짐', vmMonitoringOnly: 'VM 만', vmAndAppMonitoring: 'VM · 앱' });
const onOff = (v) => (v === true ? '켬' : v === false ? '꺼짐' : DASH);
const hostMonText = (v) => (v === 'enabled' ? '켬' : v === 'disabled' ? '꺼짐' : v || DASH);

/** 글자 폭(열 너비 단위 근사 — 한글·전각 2, 그 밖 1). 줄 수 추정에만 쓴다. */
function textWidth(s) {
  let w = 0;
  for (const ch of String(s ?? '')) w += ch.charCodeAt(0) > 0x2e7f ? 1.9 : 1.05;
  return w;
}
const linesOf = (s, width) => Math.max(1, ...String(s ?? '').split('\n').map((l) => Math.ceil(textWidth(l) / Math.max(4, width - 1))));

/** 칸 하나 — 값 + 모양. st: { bold, italic, color, bg, size, align, wrap, numFmt, border, link, mono, valign } */
function put(ws, r, c, v, st = {}) {
  const cell = ws.getCell(r, c);
  if (st.link && typeof v === 'string') cell.value = { text: v, hyperlink: st.link };
  else cell.value = v ?? null;
  const font = {};
  if (st.bold) font.bold = true;
  if (st.italic) font.italic = true;
  if (st.size) font.size = st.size;
  if (st.mono) font.name = 'Consolas';
  if (st.link) { font.color = { argb: C.link }; font.underline = true; } else if (st.color) font.color = { argb: st.color };
  if (Object.keys(font).length) cell.font = font;
  if (st.bg) cell.fill = fill(st.bg);
  if (typeof v === 'number' && fin(v)) cell.numFmt = st.numFmt || numFmtOf(v);
  if (st.align || st.wrap || st.valign) cell.alignment = { ...(st.align ? { horizontal: st.align } : {}), ...(st.wrap ? { wrapText: true } : {}), vertical: st.valign || (st.wrap ? 'top' : 'middle') };
  if (st.border) cell.border = st.border === true ? BORDER : st.border;
  return cell;
}
/** 값 칸 — 못 읽은 값(null)은 '—'(흐린 글자) · 수는 수 서식 · 사용률(pct)은 80%+ 노랑 · 90%+ 빨강. */
function val(v, extra = {}) {
  if (v == null || v === '' || (typeof v === 'number' && !fin(v))) return [DASH, { ...extra, color: PAL.faint, bg: extra.bg }];
  if (extra.pct && fin(v)) {
    if (v >= 90) return [v, { ...extra, bg: PAL.redBg, color: PAL.redFg, bold: true }];
    if (v >= 80) return [v, { ...extra, bg: PAL.amberBg, color: PAL.amberFg, bold: true }];
  }
  return [v, extra];
}
/** 부분 합 글자(KPI 칸) — 천 단위 쉼표 · unknown 이 있으면 '≥N' · 전부 모르면 '—'. */
const partialText = (v, unknown, total) => { const x = partial(v, unknown, total); return typeof x === 'number' ? fmt(x) : x; };
/** 부분 합 — unknown 이 있으면 '≥N'(글자), 전부 모르면 '—'. */
function partial(v, unknown, total, d = 0) {
  if (v == null || (total && unknown >= total)) return DASH;
  return unknown ? `≥${fmt(v, d)}` : v;
}

// ── 두 단(왼쪽 · 오른쪽) 배치 ────────────────────────────────────────────────
/** 블록 = 행 목록. 행 = { cells:[{c(0부터), span, v, st}], h(높이 — 없으면 15) }. 블록 너비는 7열. */
function block() {
  const rows = [];
  return {
    rows,
    row(cells, h) { rows.push({ cells, h }); return this; },
    gap() { rows.push({ cells: [], h: 6 }); return this; },
  };
}
function place(ws, b, top, col0, widths, heights) {
  b.rows.forEach((row, i) => {
    const r = top + i;
    let h = row.h || 15;
    for (const x of row.cells) {
      const c = col0 + x.c;
      const span = x.span || 1;
      put(ws, r, c, x.v, x.st || {});
      if (span > 1) {
        ws.mergeCells(r, c, r, c + span - 1);
        if (x.st?.border) for (let k = 1; k < span; k++) ws.getCell(r, c + k).border = x.st.border === true ? BORDER : x.st.border;
      }
      if (x.st?.wrap && typeof x.v === 'string') {
        let w = 0; for (let k = 0; k < span; k++) w += widths[c - 1 + k] || 10;
        h = Math.max(h, linesOf(x.v, w) * 14 + 3);
      }
    }
    heights.set(r, Math.max(heights.get(r) || 0, h));
  });
  return top + b.rows.length;
}

const WIDTHS = Object.freeze([20, 12, 9, 11, 11, 11, 12, 16, 22, 12, 12, 18, 14, 16]);   // A~N — 왼쪽 단 A~G · 오른쪽 단 H~N(VM 표도 같은 열 — Veeam 을 고르면 N·O)
const VEEAM_WIDTHS = Object.freeze([12]);

/** 단 제목 — 굵은 글자 + 회색 주석, 아래 굵은 선. */
function title(b, text, note = '') {
  const rich = { richText: [{ font: { bold: true, size: 12, color: { argb: C.sec } }, text }, ...(note ? [{ font: { size: 9, color: { argb: C.gray } }, text: `   ${note}` }] : [])] };
  b.row([{ c: 0, span: 7, v: rich, st: { border: { bottom: { style: 'medium', color: { argb: C.sec } } } } }], 20);
}
/** 안내 한 줄(흐린 기울임 · 7열 병합 · 줄바꿈). */
function note(b, text, color = PAL.muted) {
  b.row([{ c: 0, span: 7, v: text, st: { italic: true, color, wrap: true, size: 9.5 } }]);
}
/** 이름–값 2쌍씩(열 배치: 이름 0 · 값 1~2 · 이름 3~4 · 값 5~6). 값이 긴 쌍(wide)은 한 줄에 하나(값 1~6). */
function kv(b, pairs) {
  const K = { color: PAL.muted, border: { bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } } } };
  const V = (st) => ({ bold: true, ...(st || {}), border: K.border });
  const queue = pairs.filter(Boolean);
  for (let i = 0; i < queue.length;) {
    const a = queue[i];
    if (a.wide || !queue[i + 1] || queue[i + 1].wide) {
      const [v, st] = val(a.v, a.st || {});
      b.row([{ c: 0, v: a.k, st: K }, { c: 1, span: 6, v, st: { ...V(st), wrap: a.wide } }]);
      i += 1;
      continue;
    }
    const z = queue[i + 1];
    const [v1, s1] = val(a.v, a.st || {}); const [v2, s2] = val(z.v, z.st || {});
    b.row([{ c: 0, v: a.k, st: K }, { c: 1, span: 2, v: v1, st: { ...V(s1), align: 'left' } }, { c: 3, span: 2, v: z.k, st: K }, { c: 5, span: 2, v: v2, st: { ...V(s2), align: 'left' } }]);
    i += 2;
  }
}
/** 작은 표 — head 글자 · spans(합 7 이하) · rows(값 배열) · looks(행·열 → 모양). 줄무늬 · 얇은 선. */
function table(b, head, spans, rows, { looks = null, more = 0, moreText = '' } = {}) {
  let c = 0;
  b.row(head.map((t, i) => { const x = { c, span: spans[i], v: t, st: { bold: true, bg: C.subHead, color: C.subHeadFg, border: true, size: 9.5 } }; c += spans[i]; return x; }));
  rows.forEach((r, ri) => {
    let cc = 0;
    b.row(r.map((v0, i) => {
      const extra = { border: true, ...(ri % 2 ? { bg: PAL.zebra } : {}), ...(looks ? looks(ri, i, v0) || {} : {}) };
      const [v, st] = val(v0, extra);
      const x = { c: cc, span: spans[i], v, st };
      cc += spans[i];
      return x;
    }));
  });
  if (more > 0) note(b, moreText || `… 외 ${more.toLocaleString('en-US')}개`);
}

// ── KPI 칸 ─────────────────────────────────────────────────────────────────
/** 3행(이름 · 값 · 보조) KPI 칸 — spans: [[시작열, 끝열]…] (1부터). */
function kpiRow(ws, top, tiles, spans) {
  tiles.forEach((k, i) => {
    const [a, z] = spans[i];
    const thick = { style: 'thick', color: { argb: k.color } }; const side = { style: 'thin', color: { argb: 'FFD4D8DE' } };
    put(ws, top, a, k.label, { color: PAL.muted, size: 9.5, border: { top: thick, left: side, right: side } });
    put(ws, top + 1, a, k.value, { bold: true, size: 17, color: k.color, align: 'left', border: { left: side, right: side } });
    put(ws, top + 2, a, k.sub || '', { color: C.gray, size: 9, wrap: true, border: { left: side, right: side, bottom: side } });
    if (z > a) for (let r = top; r <= top + 2; r++) {
      ws.mergeCells(r, a, r, z);
    }
  });
  ws.getRow(top + 1).height = 26;
  ws.getRow(top + 2).height = 25;   // 보조 글자 두 줄까지
}

// ── 호스트 시트 ─────────────────────────────────────────────────────────────
function leftBlock(p, h) {
  const b = block();
  const omitted = p.meta.omitted || {};
  title(b, '기본', `인벤토리 · ${stampOf(p, p.meta.at)} 기준`);
  kv(b, [
    { k: '제조사', v: h.vendor }, { k: '모델', v: h.model },
    { k: '서비스 태그', v: h.serviceTag }, { k: '데이터센터', v: h.dc },
    { k: 'CPU 모델', v: h.cpuModel, wide: true },
    { k: '소켓 · 코어 · 스레드', v: [h.sockets, h.cores, h.threads].some((x) => x != null) ? [h.sockets, h.cores, h.threads].map((x) => fmt(x)).join(' · ') : null }, { k: '코어당 클럭', v: fin(h.mhz) ? `${fmt(h.mhz)} MHz` : null },
    { k: '메모리', v: fin(h.memGB) ? `${fmt(h.memGB, 1)} GB` : null }, { k: 'ESXi', v: h.version ? `${h.version}${h.build ? ` 빌드 ${h.build}` : ''}` : null },
    { k: '관리 IP', v: h.mgmtIp }, { k: 'vCenter IP(호스트 보고)', v: h.mgmtServerIp },
    { k: '연결 상태', v: h.state, st: { color: (STATE_LOOK[h.stateCode] || {}).color } }, { k: '전원', v: h.power },
    { k: 'GPU', v: h.gpus.length ? h.gpus.map((g) => `${g.model}${fin(g.memGB) && !String(g.model).includes(`${g.memGB}GB`) ? ` ${fmt(g.memGB)}GB` : ''}${g.mode ? ` (${g.mode})` : ''}`).join(', ') : '없음', wide: true },
  ]);
  b.gap();
  title(b, '클러스터', h.cluster);
  if (omitted.cluster) note(b, omitted.cluster);
  else if (h.clusterKey === 'standalone') note(b, '클러스터에 속하지 않은 호스트입니다(HA · DRS 없음).');
  else if (!h.clusterCfg) note(b, '이 클러스터의 구성(HA · DRS · EVC)을 아직 읽지 못했습니다 — 수집 서버가 주기적으로 읽습니다.');
  const cl = (p.clusters || []).find((x) => x.key === h.clusterKey);
  if (!omitted.cluster && h.clusterCfg) {
    const g = h.clusterCfg;
    kv(b, [
      { k: 'HA', v: g.ha ? `${onOff(g.ha.enabled)} · 승인 제어 ${onOff(g.ha.admission)}` : null, st: { color: g.ha?.enabled === true ? PAL.green : g.ha?.enabled === false ? PAL.amber : undefined } },
      { k: 'DRS', v: g.drs ? `${onOff(g.drs.enabled)}${g.drs.enabled ? ` · ${DRS_TEXT[g.drs.behavior] || g.drs.behavior || DASH}` : ''}` : null, st: { color: g.drs?.enabled === true ? PAL.green : g.drs?.enabled === false ? PAL.amber : undefined } },
      { k: '호스트 모니터링', v: g.ha ? hostMonText(g.ha.hostMon) : null }, { k: 'VM 모니터링', v: g.ha ? VMMON_TEXT[g.ha.vmMon] || g.ha.vmMon : null },
      { k: 'EVC', v: g.evc === '' ? '꺼짐' : g.evc }, { k: '규칙(준수 / 전체)', v: fin(g.rulesTotal) ? `${fmt(g.rulesOk)} / ${fmt(g.rulesTotal)}` : null },
      { k: '호스트(유효)', v: fin(g.numHosts) ? `${fmt(g.numHosts)}대(유효 ${fmt(g.numEffectiveHosts)})` : null },
    ]);
  }
  if (cl) {
    kv(b, [
      { k: '클러스터 VM', v: `${fmt(cl.vms)}대(켜짐 ${fmt(cl.vmOn)})` }, { k: '이 파일의 호스트', v: `${fmt(cl.hosts)}대` },
      { k: 'CPU 가상화(클러스터)', v: fin(cl.cpuRatio) ? ratioText(cl.cpuRatio) : null, st: { color: cl.cpuRatio >= 4 ? PAL.red : undefined } }, { k: 'MEM 가상화(클러스터)', v: fin(cl.memRatio) ? ratioText(cl.memRatio) : null },
    ]);
  }
  if (p.meta.parts.includes('sec') || omitted.sec) {
    b.gap();
    const s = h.sec;
    const cnt = s ? [s.counts.crit && `✕ 위험 ${s.counts.crit}`, s.counts.warn && `⚠ 주의 ${s.counts.warn}`, s.counts.info && `ⓘ 참고 ${s.counts.info}`].filter(Boolean).join(' · ') : '';
    title(b, '구성 · 보안 점검', s ? `ESXi 호스트 구성 점검과 같은 판정${s.at ? ` · 구성 캐시 ${stampOf(p, s.at)}` : ''}${cnt ? ` · ${cnt}` : ''}` : '');
    if (omitted.sec) note(b, omitted.sec);
    else if (!s || s.state === 'none') note(b, '이 호스트의 구성 캐시를 아직 읽지 못했습니다 — 수집 서버가 주기적으로 읽습니다(판정하지 않습니다).');
    else {
      if (s.state === 'disconnected') note(b, '연결이 끊겨 판정하지 않습니다 — 아래 값은 마지막으로 읽은 구성입니다.', PAL.amberFg);
      b.row([
        { c: 0, v: '항목', st: { bold: true, bg: C.subHead, color: C.subHeadFg, border: true, size: 9.5 } },
        { c: 1, span: 3, v: '값', st: { bold: true, bg: C.subHead, color: C.subHeadFg, border: true, size: 9.5 } },
        { c: 4, span: 3, v: '판정', st: { bold: true, bg: C.subHead, color: C.subHeadFg, border: true, size: 9.5 } },
      ]);
      s.rows.forEach((r, i) => {
        const z = i % 2 ? { bg: PAL.zebra } : {};
        const look = r.sev ? SEV_LOOK[r.sev] : r.verdict === '✓' ? SEV_LOOK.ok : null;
        b.row([
          { c: 0, v: r.label, st: { ...z, color: PAL.muted, border: true, wrap: true } },
          { c: 1, span: 3, v: r.value, st: { ...z, bold: true, border: true, wrap: true } },
          { c: 4, span: 3, v: r.verdict || '', st: { ...z, ...(look || {}), border: true, wrap: true } },
        ]);
      });
    }
  }
  return b;
}

function rightBlock(p, h) {
  const b = block();
  const omitted = p.meta.omitted || {};
  const parts = new Set(p.meta.parts || []);
  let first = true;
  const gap = () => { if (!first) b.gap(); first = false; };
  if (h.net) {
    gap();
    const n = h.net;
    title(b, '네트워크', `물리 NIC ${n.nics.length}개${h.nicLinkDown ? ` · 링크 끊김 ${h.nicLinkDown}` : ''}`);
    if (n.nics.length) {
      table(b, ['NIC', '모델', '속도 / 정격', '링크', 'MAC', '스위치'], [1, 1, 1, 1, 1, 2], n.nics.map((x) => [
        x.device, x.model, fin(x.speedMb) || fin(x.maxSpeedMb) ? `${fin(x.speedMb) && x.speedMb > 0 ? fmt(x.speedMb / 1000, 1) : DASH} / ${fin(x.maxSpeedMb) ? fmt(x.maxSpeedMb / 1000, 1) : DASH} Gb` : null,
        x.link === true ? '연결' : x.link === false ? '끊김' : null, x.mac, n.switches ? x.sw || '(안 씀)' : null,
      ]), { looks: (ri, ci, v) => (ci === 0 ? { bold: true } : ci === 3 && v === '끊김' ? { bold: true, color: PAL.red } : ci === 3 && v === '연결' ? { color: PAL.green } : ci === 4 ? { mono: true, size: 9.5 } : null) });
    } else note(b, '물리 NIC 정보가 없습니다(인벤토리가 주지 않았습니다).');
    if (n.switches) {
      const linkOf = new Map(n.nics.map((x) => [x.device, x.link]));
      table(b, ['가상 스위치', '업링크', '종류', '포트그룹', '업링크 링크'], [1, 1, 1, 1, 3], n.switches.map((x) => {
        const down = x.uplinks.filter((u) => linkOf.get(u) === false);
        const known = x.uplinks.filter((u) => linkOf.has(u) && linkOf.get(u) != null).length;
        return [x.name, x.uplinks.join(', ') || '(없음)', x.kind, x.kind === '분산' ? null : x.pgs,
          !x.uplinks.length ? '업링크 없음' : down.length ? `끊김 ${down.length}개(${down.join(', ')}) / ${x.uplinks.length}개` : known ? `연결 ${known} / ${x.uplinks.length}개` : null];
      }), { looks: (ri, ci, v) => (ci === 0 ? { bold: true } : ci === 4 && typeof v === 'string' && v.startsWith('끊김') ? SEV_LOOK.warn : null) });
      if (n.pgs.length) {
        table(b, ['포트그룹', 'VLAN', '스위치', '무차별 모드'], [2, 1, 2, 2], n.pgs.slice(0, 60).map((x) => [x.name, x.vlan, x.sw, x.promisc === true ? '허용' : x.promisc === false ? '거부' : null]),
          { looks: (ri, ci, v) => (ci === 3 && v === '허용' ? SEV_LOOK.warn : ci === 1 ? { align: 'center' } : null), more: Math.max(0, (n.pgsTotal || n.pgs.length) - Math.min(60, n.pgs.length)) });
      }
    } else note(b, omitted.sec || !p.meta.access?.hygiene ? '가상 스위치 · 포트그룹은 ‘ESXi 호스트 구성 점검’ 권한이 있을 때 넣습니다.' : '가상 스위치 · 포트그룹: 이 호스트의 구성 캐시를 아직 읽지 못했습니다.');
  }
  if (h.st) {
    gap();
    const s = h.st;
    title(b, '스토리지', `HBA ${s.hbas.length}개 · 데이터스토어 ${s.datastores.length}개(이 호스트 VM 이 쓰는 것)`);
    if (s.hbas.length) {
      table(b, ['HBA', '모델', '종류 · 속도', '상태', 'WWN / 주소'], [1, 1, 1, 1, 3], s.hbas.map((x) => [x.name, x.model, [x.type, fin(x.speedGbps) && x.speedGbps > 0 ? `${fmt(x.speedGbps)}Gb` : ''].filter(Boolean).join(' ') || null, x.status, x.wwn]),
        { looks: (ri, ci, v) => (ci === 0 ? { bold: true } : ci === 4 ? { mono: true, size: 9.5 } : ci === 3 && /online|온라인/i.test(String(v)) ? { color: PAL.green } : ci === 3 && /offline|오프라인|unbound|unknown/i.test(String(v)) ? { color: PAL.amber, bold: true } : null) });
    } else note(b, 'HBA 정보가 없습니다(인벤토리가 주지 않았습니다).');
    if (s.mp) {
      const pol = Object.entries(s.mp.policies || {}).map(([k, c]) => `${k} ${c}`).join(', ');
      table(b, ['LUN(공유)', '경로', '죽은 경로', '경로 하나뿐인 공유 LUN', '경로 정책'], [1, 1, 1, 2, 2], [[`${fmt(s.mp.luns)}(${fmt(s.mp.shared)})`, s.mp.paths, s.mp.dead, s.mp.singlePath, pol || null]],
        { looks: (ri, ci, v) => ((ci === 2 || ci === 3) && fin(v) ? (v > 0 ? SEV_LOOK.warn : { color: PAL.green, bold: true }) : ci > 0 && ci < 4 ? { align: 'right' } : null) });
      if (s.mp.deadLuns?.length) note(b, `죽은 경로가 있는 LUN: ${s.mp.deadLuns.join(', ')}`, PAL.amberFg);
    } else if (parts.has('st')) note(b, !p.meta.access?.hygiene ? '멀티패스는 ‘ESXi 호스트 구성 점검’ 권한이 있을 때 넣습니다.' : '멀티패스: 이 호스트의 구성 캐시를 아직 읽지 못했습니다.');
    if (s.datastores.length) {
      table(b, ['데이터스토어', 'VM', '용량 GB', '여유 GB', '사용률'], [2, 1, 1, 1, 2], s.datastores.slice(0, 40).map((d) => [d.name, d.vms, n1(d.capGB), n1(d.freeGB), fin(d.pct) ? `${barText(d.pct / 100, 12)} ${Math.round(d.pct)}%` : null]),
        { looks: (ri, ci, v) => (ci === 0 ? { bold: true } : ci === 4 && typeof v === 'string' ? { mono: true, size: 9, ...(parseFloat(v.split(' ').pop()) >= 90 ? { bg: PAL.redBg, color: PAL.redFg } : parseFloat(v.split(' ').pop()) >= 80 ? { bg: PAL.amberBg, color: PAL.amberFg } : { color: PAL.bar }) } : null),
          more: Math.max(0, s.datastores.length - 40) });
    }
    if (s.vmNoDev) note(b, `VM ${s.vmNoDev}대는 장치 정보(구성 캐시)를 아직 읽지 못해 데이터스토어 셈에서 빠졌습니다.`);
  }
  if (h.hw || omitted.hw) {
    gap();
    title(b, '하드웨어(iDRAC)', h.hw?.state === 'ok' ? '파트 장애와 같은 판정' : '');
    const w = h.hw;
    if (omitted.hw) note(b, omitted.hw);
    else if (w.state === 'none') note(b, `iDRAC 등록 안 됨 — 서비스 태그 ‘${h.serviceTag || DASH}’ 와 맞는 iDRAC 가 등록부에 없습니다.`);
    else if (w.state === 'pending') note(b, 'iDRAC 에 등록됐지만 인벤토리를 아직 읽지 못했습니다.');
    else {
      kv(b, [{ k: 'BIOS', v: w.bios }, { k: 'iDRAC 펌웨어', v: w.idracFw }, { k: '시스템 상태', v: w.health, st: { color: /^ok$/i.test(w.health) ? PAL.green : w.health ? PAL.amber : undefined } }, { k: '시리얼', v: w.serial }]);
      if (w.groups.length) {
        table(b, ['부품', '상태', '정상', '주의 · 장애', '모름'], [2, 2, 1, 1, 1], w.groups.map((g) => [g.label, HW_TEXT[g.state] ?? g.state, `${g.ok} / ${g.present}`, g.warn + g.fault, g.unknown]),
          { looks: (ri, ci, v) => (ci === 1 ? HW_LOOK[w.groups[ri].state] || null : ci === 3 && v > 0 ? SEV_LOOK.warn : ci >= 2 ? { align: 'right' } : null) });
      }
      if (w.bad.length) table(b, ['문제 부품', '이름', '상태', 'Health'], [2, 3, 1, 1], w.bad.map((x) => [x.group, x.name, HW_TEXT[x.state] || x.state, x.health]), { looks: (ri, ci) => (ci === 2 ? HW_LOOK[w.bad[ri].state] : null) });
    }
  }
  // 센서(vCenter) — 기본 묶음
  if (h.temps.length) {
    gap();
    title(b, '온도 센서(vCenter)', fin(h.tempMaxC) ? `최고 ${fmt(h.tempMaxC)}℃` : '');
    const rows = [];
    for (let i = 0; i < h.temps.length; i += 2) rows.push([h.temps[i].name, n1(h.temps[i].c), h.temps[i + 1]?.name ?? '', h.temps[i + 1] ? n1(h.temps[i + 1].c) : '']);
    table(b, ['센서', '℃', '센서', '℃'], [3, 1, 2, 1], rows, { looks: (ri, ci, v) => ((ci === 1 || ci === 3) && fin(v) ? { align: 'right', ...(v >= 80 ? SEV_LOOK.crit : v >= 70 ? SEV_LOOK.warn : {}) } : null) });
  }
  if (parts.has('boot') || omitted.boot) {
    gap();
    title(b, '최근 재부팅', `최근 ${p.meta.bootDays}일 · 부팅 시각 + vCenter 이벤트`);
    const r = h.boot;
    if (omitted.boot) note(b, omitted.boot);
    else if (h.stateCode === 'DISCONNECTED') note(b, '연결이 끊겨 판정하지 않습니다.');
    else if (!r) note(b, h.bootTime == null ? '부팅 시각을 읽지 못했습니다.' : `최근 ${p.meta.bootDays}일 안에 재부팅하지 않았습니다(마지막 부팅 ${stampOf(p, h.bootTime)}).`);
    else {
      kv(b, [
        { k: '마지막 부팅', v: stampOf(p, r.bootTime) }, { k: '판정', v: r.label, st: BOOT_LOOK[r.kind] },
        { k: '근거', v: r.evidence ? `${EVIDENCE_TEXT[r.evidence.type] || r.evidence.type} · ${stampOf(p, r.evidence.ts)}${r.evidence.user ? ` · ${r.evidence.user}` : ''}` : r.notCollected ? `이 포탈이 지금 이 vCenter 이벤트를 수집하지 않습니다(${r.notCollected})` : '그 시간대 이벤트에 근거가 없습니다', wide: true },
      ]);
    }
  }
  return b;
}

const VM_HEAD = Object.freeze(['VM', '전원', 'vCPU', '메모리 GB', 'CPU %', '메모리 %', '디스크 GB', 'IP', 'Guest OS', '스냅샷', 'Tools', '데이터스토어', '폴더', '']);
const POWER_TEXT = Object.freeze({ POWERED_ON: '켜짐', POWERED_OFF: '꺼짐', SUSPENDED: '일시 중지' });
const POWER_LOOK = Object.freeze({ 켜짐: { color: PAL.green, bold: true }, 꺼짐: { color: C.gray }, '일시 중지': { color: PAL.amber, bold: true }, 템플릿: { color: C.gray, italic: true } });
const TOOLS_TEXT = Object.freeze({ RUNNING: '실행 중', NOT_RUNNING: '실행 안 함', OUTDATED: '구버전' });
const TOOLS_LOOK = Object.freeze({ '실행 중': { color: PAL.green }, '실행 안 함': { color: PAL.amber, bold: true }, 구버전: { color: PAL.amber, bold: true } });

function vmTable(ws, p, h, top, heights) {
  const veeam = (p.meta.parts || []).includes('vmVeeam');
  const head = [...VM_HEAD.slice(0, 13), ...(veeam ? [`Veeam 마지막 백업`, '최근 1일 백업'] : [])];
  const t = top;
  const rich = { richText: [{ font: { bold: true, size: 12, color: { argb: C.sec } }, text: `VM — 이 호스트 ${h.vms.toLocaleString('en-US')}대` },
    { font: { size: 9, color: { argb: C.gray } }, text: `   켜짐 ${h.vmOn} · 꺼짐 ${h.vms - h.vmOn}${h.templates ? ` · 템플릿 ${h.templates}(셈에서 뺌)` : ''} · 인벤토리${veeam ? ' · Veeam 은 내려받을 때 대조' : ''}` }] };
  put(ws, t, 1, rich, { border: { bottom: { style: 'medium', color: { argb: C.sec } } } });
  ws.mergeCells(t, 1, t, head.length);
  heights.set(t, 20);
  const hr = ws.getRow(t + 1);
  head.forEach((x, i) => { hr.getCell(i + 1).value = x; });
  styleHeadRow(hr, { height: 20 });
  if (!h.vmRows.length) { put(ws, t + 2, 1, '이 호스트에 등록된 VM 이 없습니다.', { italic: true, color: PAL.muted }); return t + 3; }
  h.vmRows.forEach((v, i) => {
    const r = t + 2 + i;
    const z = i % 2 ? { bg: PAL.zebra } : {};
    const cells = [
      [v.name, { bold: true }], [POWER_TEXT[v.power] || v.power || DASH, POWER_LOOK[POWER_TEXT[v.power] || v.power] || {}], val(v.vcpu, {}), val(v.memGB, {}), val(v.cpuPct, { pct: true }), val(v.memPct, { pct: true }), val(n1(v.storGB), {}),
      [v.ip || DASH, v.ip ? {} : { color: PAL.faint }], [v.guestOS || DASH, v.guestOS ? {} : { color: PAL.faint }], val(v.snapshots, v.snapshots > 0 ? { color: PAL.amber, bold: true, align: 'center' } : { align: 'center' }),
      [TOOLS_TEXT[v.tools] || v.tools || DASH, TOOLS_LOOK[TOOLS_TEXT[v.tools]] || (v.tools ? {} : { color: PAL.faint })], v.ds == null ? ['수집 안 됨', { italic: true, color: PAL.faint }] : [v.ds || DASH, v.ds ? {} : { color: PAL.faint }], [v.folder || DASH, {}],
    ];
    if (veeam) {
      cells.push(v.veeamLast ? [stampOf(p, v.veeamLast), {}] : [DASH, { color: PAL.faint }]);
      cells.push(v.veeamYn == null ? ['수집 안 됨', { italic: true, color: PAL.faint }] : [v.veeamYn, v.veeamYn === '예' ? { color: PAL.green, bold: true } : v.veeamYn === '아니오' ? { color: PAL.redFg, bold: true } : { color: C.gray }]);
    }
    cells.forEach(([x, st], ci) => put(ws, r, ci + 1, x, { ...(st.bg ? {} : z), ...(typeof x === 'number' ? { align: 'right' } : {}), ...st, border: true }));
  });
  ws.autoFilter = { from: { row: t + 1, column: 1 }, to: { row: t + 1 + h.vmRows.length, column: head.length } };
  return t + 2 + h.vmRows.length;
}

function hostSheet(wb, p, h, i, hosts) {
  const ws = wb.addWorksheet(h.sheet, {
    views: [{ state: 'frozen', ySplit: 3, showGridLines: false }],
    pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } },
  });
  const veeam = (p.meta.parts || []).includes('vmVeeam');
  ws.columns = [...WIDTHS, ...(veeam ? VEEAM_WIDTHS : [])].map((width) => ({ width }));
  const heights = new Map();
  // 머리 — 1행 이동 링크 · 2행 이름(상태) · 3행 소속·기준
  put(ws, 1, 1, '← 호스트 목록', { link: sheetLink(S_LIST, `A${LIST_FIRST_ROW + i}`) });
  put(ws, 1, 2, '요약', { link: sheetLink(S_SUM) });
  if (i > 0) put(ws, 1, 12, `◀ ${hosts[i - 1].sheet}`, { link: sheetLink(hosts[i - 1].sheet), align: 'right' });
  if (i < hosts.length - 1) put(ws, 1, 13, `${hosts[i + 1].sheet} ▶`, { link: sheetLink(hosts[i + 1].sheet) });
  const stLook = STATE_LOOK[h.stateCode] || { color: C.gray };
  put(ws, 2, 1, { richText: [{ font: { bold: true, size: 17, color: { argb: PAL.title } }, text: h.name }, { font: { bold: true, size: 11, color: { argb: stLook.color } }, text: `   ● ${h.state || DASH}` }] });
  heights.set(2, 26);
  put(ws, 3, 1, [`클러스터 ${h.cluster}`, h.dc && `데이터센터 ${h.dc}`, `vCenter ${p.meta.vcenterName}`, h.version && `ESXi ${h.version}${h.build ? ` · ${h.build}` : ''}`, `기준 ${stampOf(p, p.meta.at)} ${p.meta.offsetLabel || ''}`.trim()].filter(Boolean).join('  ·  '), { color: PAL.muted });
  // KPI 8칸(5~7행)
  const cpuSub = fin(h.cpuUsedMhz) && fin(h.cpuTotalMhz) ? `${fmt(h.cpuUsedMhz)} / ${fmt(h.cpuTotalMhz)} MHz` : h.stateCode === 'DISCONNECTED' ? '연결 끊김' : '';
  const memSub = fin(h.memUsedGB) && fin(h.memGB) ? `${fmt(h.memUsedGB)} / ${fmt(h.memGB)} GB` : h.stateCode === 'DISCONNECTED' ? '연결 끊김' : '';
  kpiRow(ws, 5, [
    { label: 'CPU 사용률', value: fin(h.cpuPct) ? `${Math.round(h.cpuPct)}%  ${barText(h.cpuPct / 100, 10)}` : DASH, sub: cpuSub, color: h.cpuPct >= 90 ? PAL.red : h.cpuPct >= 80 ? PAL.amber : 'FF1E3A5F' },
    { label: '메모리 사용률', value: fin(h.memPct) ? `${Math.round(h.memPct)}%  ${barText(h.memPct / 100, 10)}` : DASH, sub: memSub, color: h.memPct >= 90 ? PAL.red : h.memPct >= 80 ? PAL.amber : 'FF5B21B6' },
    { label: 'VM', value: fmt(h.vms), sub: `켜짐 ${h.vmOn} · 꺼짐 ${h.vms - h.vmOn}${h.templates ? ` · 템플릿 ${h.templates}` : ''}`, color: PAL.title },
    { label: 'CPU 가상화 비율', value: h.vcpuUnknown ? (fin(h.cores) && fin(h.vcpu) ? `≥${(h.vcpu / h.cores).toFixed(1)}:1` : DASH) : ratioText(h.cpuRatio), sub: `vCPU ${partialText(h.vcpu, h.vcpuUnknown, h.vms)} / 코어 ${fmt(h.cores)}${h.vcpuUnknown ? ` · 모름 ${h.vcpuUnknown}대` : ''}`, color: h.cpuRatio >= 4 ? PAL.red : PAL.amber },
    { label: '메모리 가상화 비율', value: h.vmMemUnknown ? (fin(h.memGB) && fin(h.vmMemGB) ? `≥${(h.vmMemGB / h.memGB).toFixed(1)}:1` : DASH) : ratioText(h.memRatio), sub: `할당 ${partialText(h.vmMemGB, h.vmMemUnknown, h.vms)} / ${fmt(h.memGB)} GB`, color: 'FF0F766E' },
    { label: '가동', value: fin(h.uptimeDays) ? `${fmt(h.uptimeDays)}일` : DASH, sub: h.bootTime ? `부팅 ${stampOf(p, h.bootTime)}` : '', color: 'FF334155' },
    { label: '온도', value: fin(h.tempC) ? `${fmt(h.tempC)}℃` : DASH, sub: fin(h.tempMaxC) ? `최고 ${fmt(h.tempMaxC)}℃` : '센서 값 없음', color: h.tempMaxC >= 80 ? PAL.red : PAL.green },
    { label: '전력', value: fin(h.powerW) ? `${fmt(h.powerW)} W` : DASH, sub: fin(h.powerW) ? 'vCenter · IPMI 센서' : '값 없음', color: PAL.amberFg },
  ].map((k) => ({ ...k, value: String(k.value) })), [[1, 1], [2, 3], [4, 5], [6, 7], [8, 8], [9, 9], [10, 11], [12, 13]]);
  // 두 단
  const top = 9;
  const endL = place(ws, leftBlock(p, h), top, 1, WIDTHS, heights);
  const endR = place(ws, rightBlock(p, h), top, 8, WIDTHS, heights);
  let next = Math.max(endL, endR) + 1;
  if (h.vmRows) next = vmTable(ws, p, h, next, heights) + 1;
  else if ((p.meta.omitted || {}).vm) put(ws, next, 1, p.meta.omitted.vm, { italic: true, color: PAL.muted });
  for (const [r, ht] of heights) if (ht !== 15) ws.getRow(r).height = ht;
  ws.headerFooter = { oddFooter: `&L${h.name}&R&P / &N` };
  return ws;
}

// ── 호스트 목록 ─────────────────────────────────────────────────────────────
const LIST_HEAD = Object.freeze(['호스트', '클러스터', '상태', '모델', '서비스 태그', 'ESXi 빌드', '소켓', '코어', '메모리 GB', 'CPU %', '메모리 %', 'VM', 'CPU 가상화', 'MEM 가상화', '가동(일)', '온도 ℃', '전력 W', '업링크 끊김', '점검 경고', 'iDRAC']);
const LIST_W = Object.freeze([24, 16, 10, 22, 12, 17, 6, 7, 10, 7, 9, 6, 10, 10, 8, 8, 8, 9, 9, 18]);
const LIST_BANDS = Object.freeze([['호스트', 3, 'FFDBE5F1', 'FF1E3A5F'], ['하드웨어 · ESXi', 3, 'FFFEF3C7', 'FF92400E'], ['CPU · 메모리', 5, 'FFEDE9FE', 'FF5B21B6'], ['VM · 가상화', 3, 'FFDCFCE7', 'FF166534'], ['상태 · 센서', 3, 'FFFEE2E2', 'FF991B1B'], ['점검', 3, 'FFE0E7FF', 'FF3730A3']]);

function hwCell(h) {
  if (!h.hw) return null;
  if (h.hw.state === 'none') return 'iDRAC 등록 안 됨';
  if (h.hw.state === 'pending') return '인벤토리 대기';
  const bad = h.hw.groups.filter((g) => g.warn || g.fault);
  return bad.length ? `⚠ ${bad.map((g) => `${g.label} ${g.warn + g.fault}`).join(', ')}` : h.hw.groups.some((g) => g.unknown) ? '? 일부 모름' : '✓';
}

async function listSheet(wb, p) {
  const ws = wb.addWorksheet(S_LIST, { views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }], pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.columns = LIST_W.map((width) => ({ width }));
  let c = 1;
  for (const [name, span, bg, fg] of LIST_BANDS) {
    put(ws, 1, c, name, { bold: true, size: 9.5, bg, color: fg, border: true });
    if (span > 1) ws.mergeCells(1, c, 1, c + span - 1);
    c += span;
  }
  const hr = ws.getRow(2);
  LIST_HEAD.forEach((x, i) => { hr.getCell(i + 1).value = x; });
  styleHeadRow(hr, { height: 30 });
  const hasSec = (p.meta.parts || []).includes('sec');
  for (let i = 0; i < p.hosts.length; i++) {
    if (i % 25 === 24) await yieldLoop();
    const h = p.hosts[i];
    const r = LIST_FIRST_ROW + i;
    const z = i % 2 ? { bg: PAL.zebra } : {};
    const newCl = i > 0 && p.hosts[i - 1].clusterKey !== h.clusterKey;
    const warn = hasSec && h.sec ? h.sec.counts.crit + h.sec.counts.warn : null;
    const hw = hwCell(h);
    const cells = [
      [h.name, { link: sheetLink(h.sheet), bold: true }],
      [h.cluster, {}], [h.state, { bold: true, color: (STATE_LOOK[h.stateCode] || {}).color }], val(h.model, {}), val(h.serviceTag, {}), val([h.version, h.build].filter(Boolean).join(' · '), {}),
      val(h.sockets, {}), val(h.cores, {}), val(h.memGB, {}), val(h.cpuPct == null ? null : Math.round(h.cpuPct), { pct: true }), val(h.memPct == null ? null : Math.round(h.memPct), { pct: true }),
      [h.vms, {}], [h.vcpuUnknown ? DASH : ratioText(h.cpuRatio), h.cpuRatio >= 4 ? { color: PAL.amber, bold: true, align: 'right' } : { align: 'right' }], [h.vmMemUnknown ? DASH : ratioText(h.memRatio), { align: 'right' }],
      val(h.uptimeDays, {}), val(h.tempC, h.tempC >= 70 ? { color: PAL.amber, bold: true } : {}), val(h.powerW, {}),
      val(h.uplinkDown, h.uplinkDown > 0 ? { color: PAL.amberFg, bold: true } : {}), val(warn, warn > 0 ? { color: PAL.amberFg, bold: true } : {}),
      hw == null ? [DASH, { color: PAL.faint }] : [hw, hw.startsWith('⚠') ? { color: PAL.amberFg, bold: true } : hw === '✓' ? { color: PAL.green, bold: true } : { color: PAL.faint, italic: true }],
    ];
    const top = newCl ? { top: { style: 'medium', color: { argb: C.rule } } } : {};
    cells.forEach(([v, st], ci) => {
      const b = { ...BORDER, ...top, ...(ci === 0 ? { right: { style: 'medium', color: { argb: C.rule } } } : {}) };
      put(ws, r, ci + 1, v, { ...(st.bg ? {} : z), ...st, border: b });
    });
  }
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2 + p.hosts.length, column: LIST_HEAD.length } };
  const foot = LIST_FIRST_ROW + p.hosts.length + 1;
  put(ws, foot, 1, '호스트 이름 = 그 호스트 시트로 가는 링크 · 호스트 시트 맨 위 ‘← 호스트 목록’ 으로 돌아옵니다 · 클러스터마다 묶어서(이름 순) · 사용률 80%+ 노랑 · 90%+ 빨강 · CPU 가상화 4:1+ 주황 · 점검 경고 = 호스트 시트 ‘구성 · 보안 점검’ 의 ✕·⚠ 개수 · — = 값을 읽지 못함', { italic: true, color: PAL.muted, size: 9 });
  return ws;
}

// ── 요약 ───────────────────────────────────────────────────────────────────
function summarySheet(wb, p) {
  const ws = wb.addWorksheet(S_SUM, { views: [{ showGridLines: false }], pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.columns = [34, 10, 10, 10, 10, 11, 12, 10, 10, 13, 13, 40].map((width) => ({ width }));
  const S = p.summary; const m = p.meta;
  put(ws, 1, 1, `${m.vcenterName} — 호스트 · 클러스터 요약`, { bold: true, size: 16, color: PAL.title });
  ws.getRow(1).height = 24;
  put(ws, 2, 1, [`기준 ${stampOf(p, m.at)} ${m.offsetLabel || ''}`.trim(), m.location, m.vcVersion && `vCenter ${m.vcVersion}`, `대상 ${m.target} · 호스트 ${S.hosts}대${m.target !== '전체' ? ` / 이 vCenter ${m.hostsTotal}대` : ''}`, `시트 ${S.hosts + 4}장`].filter(Boolean).join('  ·  '), { color: PAL.muted });
  const vUnknown = p.hosts.reduce((s, h) => s + (h.vcpuUnknown || 0), 0);
  const cpuR = fin(S.vcpu.sum) && S.cores.sum > 0 && !S.cores.unknown ? S.vcpu.sum / S.cores.sum : null;
  const tiles = [
    { label: '호스트', value: fmt(S.hosts), sub: `연결 ${S.connected} · 유지보수 ${S.maint} · 끊김 ${S.disc}`, color: 'FF1E3A5F' },
    { label: '클러스터', value: fmt(S.clusters), sub: (() => { const cs = p.clusters.filter((c) => c.cfg); return cs.length ? `HA ${cs.filter((c) => c.cfg.ha?.enabled).length} · DRS ${cs.filter((c) => c.cfg.drs?.enabled).length}` : m.omitted?.cluster ? '구성은 넣지 않음' : '구성 읽기 전'; })(), color: 'FF1E3A5F' },
    { label: '코어 합', value: partialText(S.cores.sum, S.cores.unknown, S.hosts), sub: `소켓 ${partialText(S.sockets.sum, S.sockets.unknown, S.hosts)} · 스레드 ${partialText(S.threads.sum, S.threads.unknown, S.hosts)}`, color: 'FF5B21B6' },
    { label: '메모리 합', value: S.memGB.unknown >= S.hosts ? DASH : `${S.memGB.unknown ? '≥' : ''}${(S.memGB.sum / 1024).toFixed(1)} TB`, sub: `사용 ${(S.memUsedGB.sum / 1024).toFixed(1)} TB${S.memUsedGB.unknown ? `(읽은 호스트 ${S.hosts - S.memUsedGB.unknown}대)` : ''}`, color: 'FF5B21B6' },
    { label: 'VM', value: fmt(S.vms), sub: `켜짐 ${S.vmOn} · 꺼짐 ${S.vms - S.vmOn}${S.templates ? ` · 템플릿 ${S.templates}` : ''}`, color: PAL.title },
    { label: 'CPU 가상화', value: cpuR == null ? DASH : `${vUnknown ? '≥' : ''}${cpuR.toFixed(1)}:1`, sub: `vCPU ${fmt(S.vcpu.sum)} / 코어 ${fmt(S.cores.sum)}${vUnknown ? ` · 모름 ${vUnknown}대` : ''}`, color: PAL.amber },
    { label: '전력 합', value: S.powerW.unknown >= S.hosts ? DASH : `${S.powerW.unknown ? '≥' : ''}${(S.powerW.sum / 1000).toFixed(1)} kW`, sub: `읽은 호스트 ${S.hosts - S.powerW.unknown}대`, color: PAL.amberFg },
    { label: '점검 경고', value: (m.parts || []).includes('sec') ? fmt(S.secWarn) : DASH, sub: (m.parts || []).includes('sec') ? `호스트 ${S.secHosts}대(✕·⚠)` : m.omitted?.sec ? '권한 없음 — 넣지 않음' : '고르지 않음', color: 'FF9A3412' },
  ];
  // KPI 2줄 × 4칸(보조 글자가 잘리지 않게 칸을 넓게)
  const spans4 = [[1, 1], [2, 4], [5, 7], [8, 10]];
  kpiRow(ws, 4, tiles.slice(0, 4), spans4);
  kpiRow(ws, 7, tiles.slice(4), spans4);
  let r = 11;
  const sec = (text, n = '') => { put(ws, r, 1, { richText: [{ font: { bold: true, size: 12, color: { argb: C.sec } }, text }, ...(n ? [{ font: { size: 9, color: { argb: C.gray } }, text: `   ${n}` }] : [])] }); r += 1; };
  sec('클러스터별', '클러스터 이름 = 그 클러스터의 첫 호스트 시트로 가는 링크 · 사용률은 연결된 호스트 합');
  const head = ['클러스터', '호스트', '연결', 'VM', '켜짐', '코어', '메모리 GB', 'CPU %', '메모리 %', 'CPU 가상화', 'MEM 가상화', 'ESXi 빌드'];
  const hr = ws.getRow(r); head.forEach((x, i) => { hr.getCell(i + 1).value = x; }); styleHeadRow(hr, { height: 20 }); r += 1;
  p.clusters.forEach((c, i) => {
    const z = i % 2 ? { bg: PAL.zebra } : {};
    const cells = [[c.name, { link: sheetLink(c.firstSheet), bold: true }], [c.hosts, {}], [c.connected, c.connected < c.hosts ? { color: PAL.amber, bold: true } : {}], [c.vms, {}], [c.vmOn, {}], val(c.cores, {}), val(c.memGB, {}),
      val(c.cpuPct, { pct: true }), val(c.memPct, { pct: true }), [ratioText(c.cpuRatio), c.cpuRatio >= 4 ? { color: PAL.red, bold: true, align: 'right' } : { align: 'right' }], [ratioText(c.memRatio), { align: 'right' }],
      [c.builds.length ? `${c.builds.length}종${c.builds.length > 1 ? ' ⚠' : ''} · ${c.builds.join(', ')}` : DASH, c.builds.length > 1 ? SEV_LOOK.warn : {}]];
    cells.forEach(([v, st], ci) => put(ws, r, ci + 1, v, { ...(st.bg ? {} : z), ...st, border: true }));
    r += 1;
  });
  r += 1;
  sec('확인할 것', '판정은 각 점검 기능과 같은 함수입니다(이 파일이 새로 판정하지 않습니다) · 첫 호스트 이름 = 그 호스트 시트 링크');
  const ch = ws.getRow(r); ['항목', '호스트', '첫 호스트', '', '', '그 밖 호스트'].forEach((x, i) => { ch.getCell(i + 1).value = x; }); styleHeadRow(ch, { height: 20 });
  ws.mergeCells(r, 3, r, 5); ws.mergeCells(r, 6, r, 12); r += 1;
  for (const k of p.checks) {
    const n = k.hosts.length;
    const hot = n > 0;
    const look = hot ? (k.sev === 'crit' || k.id === 'disc' || k.id === 'unexpected' ? SEV_LOOK.crit : SEV_LOOK.warn) : {};
    put(ws, r, 1, k.label, { bold: true, border: true, ...(hot ? { bg: look.bg } : {}) });
    put(ws, r, 2, n, { bold: true, border: true, align: 'right', ...(hot ? look : { color: PAL.green }) });
    if (hot) put(ws, r, 3, k.hosts[0].name, { link: sheetLink(k.hosts[0].sheet), border: true }); else put(ws, r, 3, DASH, { color: PAL.faint, border: true });
    ws.mergeCells(r, 3, r, 5);
    const rest = k.hosts.slice(1, 30).map((x) => x.name).join(', ') + (n > 30 ? ` … 외 ${n - 30}대` : '');
    put(ws, r, 6, rest, { color: PAL.muted, border: true, wrap: true, size: 9.5 });
    ws.mergeCells(r, 6, r, 12);
    if (rest) ws.getRow(r).height = Math.max(15, linesOf(rest, 110) * 13 + 3);
    r += 1;
  }
  const om = Object.values(m.omitted || {});
  if (om.length) { r += 1; for (const t of [...new Set(om)]) { put(ws, r, 1, `넣지 않은 묶음 — ${t}`, { italic: true, color: PAL.amberFg }); r += 1; } }
  return ws;
}

// ── 클러스터 ────────────────────────────────────────────────────────────────
function clusterSheet(wb, p) {
  const ws = wb.addWorksheet(S_CL, { views: [{ state: 'frozen', xSplit: 1, ySplit: 3 }], pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  const omitted = (p.meta.omitted || {}).cluster;
  const head = ['클러스터', '호스트', '유효 호스트', 'VM', '코어', '메모리 GB', 'CPU %', '메모리 %', 'CPU 가상화', 'MEM 가상화', ...(omitted ? [] : ['HA', '승인 제어', '호스트 모니터링', 'VM 모니터링', 'DRS', 'DRS 자동화', 'EVC', '규칙(준수 / 전체)', '구성 읽은 시각']), 'ESXi 빌드'];
  ws.columns = [24, 8, 10, 7, 8, 11, 7, 8, 10, 10, ...(omitted ? [] : [7, 9, 11, 11, 7, 11, 20, 12, 17]), 36].map((width) => ({ width }));
  put(ws, 1, 1, `${p.meta.vcenterName} — 클러스터`, { bold: true, size: 14, color: PAL.title });
  put(ws, 2, 1, omitted || '구성(HA · DRS · EVC · 규칙)은 클러스터 점검과 같은 출처(클러스터 구성 캐시)입니다 · — = 아직 읽지 못함', { color: omitted ? PAL.amberFg : PAL.muted, italic: !!omitted });
  const hr = ws.getRow(3); head.forEach((x, i) => { hr.getCell(i + 1).value = x; }); styleHeadRow(hr, { height: 30 });
  const ON = { color: PAL.green, bold: true }; const OFF = { color: PAL.amber, bold: true };
  const tone = (v) => (v === '켬' ? ON : v === '꺼짐' ? OFF : { color: PAL.faint });
  p.clusters.forEach((c, i) => {
    const r = 4 + i;
    const z = i % 2 ? { bg: PAL.zebra } : {};
    const g = c.cfg;
    const cells = [[c.name, { link: sheetLink(c.firstSheet), bold: true }], [c.hosts, {}], val(g?.numEffectiveHosts, g && fin(g.numHosts) && g.numEffectiveHosts < g.numHosts ? { color: PAL.amber, bold: true } : {}), [c.vms, {}], val(c.cores, {}), val(c.memGB, {}),
      val(c.cpuPct, { pct: true }), val(c.memPct, { pct: true }), [ratioText(c.cpuRatio), c.cpuRatio >= 4 ? { color: PAL.red, bold: true, align: 'right' } : { align: 'right' }], [ratioText(c.memRatio), { align: 'right' }]];
    if (!omitted) {
      const ha = g?.ha; const drs = g?.drs;
      const t = [onOff(ha?.enabled), ha?.enabled ? onOff(ha.admission) : DASH, ha?.enabled ? hostMonText(ha.hostMon) : DASH, ha?.enabled ? VMMON_TEXT[ha.vmMon] || ha?.vmMon || DASH : DASH, onOff(drs?.enabled)];
      t.forEach((x) => cells.push([x, tone(x)]));
      const beh = drs?.enabled ? DRS_TEXT[drs.behavior] || drs.behavior || DASH : DASH;
      cells.push([beh, beh === '수동' ? OFF : {}]);
      cells.push(g ? [g.evc === '' ? '꺼짐' : g.evc || DASH, g.evc === '' ? { color: C.gray } : {}] : [DASH, { color: PAL.faint }]);
      cells.push(g && fin(g.rulesTotal) ? [`${g.rulesOk} / ${g.rulesTotal}${g.rulesOk < g.rulesTotal ? ' ⚠' : ''}`, g.rulesOk < g.rulesTotal ? SEV_LOOK.warn : {}] : [DASH, { color: PAL.faint }]);
      cells.push([g?.at ? stampOf(p, g.at) : DASH, { color: g?.at ? PAL.muted : PAL.faint }]);
    }
    cells.push([c.builds.length ? `${c.builds.length}종 · ${c.builds.join(', ')}` : DASH, c.builds.length > 1 ? SEV_LOOK.warn : {}]);
    cells.forEach(([v, st], ci) => put(ws, r, ci + 1, v, { ...(st.bg ? {} : z), ...st, border: true }));
  });
  return ws;
}

// ── 읽는 법 ────────────────────────────────────────────────────────────────
const PART_TEXT = Object.freeze({ sec: '구성 · 보안 점검', net: '네트워크', st: '스토리지', hw: '하드웨어(iDRAC)', boot: '최근 재부팅', vm: 'VM 목록', vmVeeam: 'VM 목록에 Veeam' });
function guideSheet(wb, p) {
  const g = wb.addWorksheet(S_GUIDE, { views: [{ showGridLines: false }] });
  g.getColumn(1).width = 26; g.getColumn(2).width = 90;
  const m = p.meta; const S = p.summary;
  put(g, 1, 1, '읽는 법', { bold: true, size: 14, color: PAL.title });
  let r = 3;
  const row = (k, v, st = {}) => { put(g, r, 1, k, { color: PAL.muted }); put(g, r, 2, v, { wrap: true, ...st }); g.getRow(r).height = Math.max(15, linesOf(v, 90) * 14 + 2); r += 1; };
  row('vCenter', `${m.vcenterName}${m.vcVersion ? ` · ${m.vcVersion}` : ''}${m.location ? ` · ${m.location}` : ''}`);
  row('대상', `${m.target} · 호스트 ${S.hosts}대${m.target !== '전체' ? `(이 vCenter ${m.hostsTotal}대 중)` : ''}`);
  row('만든 시각', `${stampOf(p, m.at)} ${m.offsetLabel || ''}`.trim());
  row('넣은 내용', ['기본 · CPU · 메모리 · 클러스터', ...(m.parts || []).map((x) => PART_TEXT[x] || x)].join(' · '));
  for (const [k, t] of Object.entries(m.omitted || {})) row(`넣지 않음 — ${PART_TEXT[k] || (k === 'cluster' ? '클러스터 구성' : k)}`, t, { color: PAL.amberFg });
  if (m.veeam === 'unread') row('Veeam', 'Veeam 판정을 읽지 못해 ‘최근 1일 백업’ 칸이 ‘수집 안 됨’ 입니다.', { color: PAL.amberFg });
  else if (m.veeam === 'unlinked') row('Veeam', '이 vCenter 는 Veeam 연동이 없어 ‘최근 1일 백업’ 칸이 ‘모름’ 입니다(‘아니오’ 가 아닙니다).');
  r += 1;
  const hr = g.getRow(r); ['묶음', '출처'].forEach((x, i) => { hr.getCell(i + 1).value = x; }); styleHeadRow(hr, { height: 20 }); r += 1;
  for (const [k, v] of [
    ['기본 · CPU · 메모리', '인벤토리(vCenter 수집 주기) — 모델 · 서비스 태그 · CPU · 메모리 · ESXi 빌드 · 관리 IP · 사용률 · 부팅 시각 · 온도 · 전력'],
    ['클러스터', `클러스터 구성 캐시(HA · DRS · EVC · 규칙 — 클러스터 점검과 같은 출처) · 이 vCenter 에서 구성을 읽은 클러스터 ${m.clusterCfg}개`],
    ['구성 · 보안 점검', `호스트 구성 캐시(주기 수집 — ESXi 호스트 구성 점검과 같은 판정) · 이 파일의 호스트 중 읽은 것 ${m.hcfgHosts} / ${S.hosts}대`],
    ['네트워크', '물리 NIC = 인벤토리 · 가상 스위치 · 포트그룹 · VLAN = 호스트 구성 캐시'],
    ['스토리지', 'HBA = 인벤토리 · 멀티패스 = 호스트 구성 캐시 · 데이터스토어 = 이 호스트 VM 의 디스크가 놓인 곳(호스트별 마운트 목록이 아닙니다 — VM 이 없는 데이터스토어는 나오지 않습니다)'],
    ['하드웨어(iDRAC)', '서비스 태그가 같은 iDRAC 등록부 항목(이 포탈 · 엣지가 보낸 것)의 인벤토리 — 부품 상태는 파트 장애와 같은 판정 · 관리자 판본에만'],
    ['최근 재부팅', `부팅 시각 + vCenter 이벤트(유지보수 모드 · 종료 요청 · 연결 끊김) — 최근 ${m.bootDays}일 · ESXi 호스트 구성 점검 ‘최근 재부팅’ 과 같은 판정`],
    ['VM', '인벤토리(이 호스트에 등록된 VM) · 데이터스토어 칸 = 구성 캐시의 디스크 위치 · Veeam = 내려받을 때 VM 목록과 같은 판정으로 대조'],
  ]) { put(g, r, 1, k, { bold: true, border: true }); put(g, r, 2, v, { wrap: true, border: true }); g.getRow(r).height = Math.max(15, linesOf(v, 90) * 14 + 2); r += 1; }
  r += 1;
  for (const line of [
    '시트: 요약 · 클러스터 · 호스트 목록 · 호스트마다 한 장(이름 = 호스트 이름의 첫 마디 — 겹치면 전체 이름 · 31자 · 그래도 겹치면 ~2) · 읽는 법.',
    '이동: 호스트 목록의 호스트 이름 · 요약의 클러스터 이름 · ‘확인할 것’ 의 첫 호스트 = 그 시트로 가는 링크 · 호스트 시트 맨 위 ‘← 호스트 목록’ · ‘◀ 이전 / 다음 ▶’.',
    '— = 값을 읽지 못했습니다(0 으로 쓰지 않습니다). ‘≥’ 가 붙은 합·비율 = 값을 못 읽은 것을 빼고 셌습니다(실제는 그 이상).',
    '가상화 비율 = 켤 수 있는 VM(템플릿 제외)의 vCPU 합 ÷ 물리 코어 · 할당 메모리 합 ÷ 물리 메모리. 꺼진 VM 도 셉니다.',
    '판정 칸: ✕ 위험(빨강) · ⚠ 주의(노랑) · ⓘ 참고(파랑) · ✓ 확인함(초록) · 빈칸 = 판정 대상이 아니거나 값을 읽지 못함. 연결 끊긴 호스트는 판정하지 않습니다.',
    '색: 사용률 80% 이상 노랑 · 90% 이상 빨강 / 연결됨 초록 · 유지보수 주황 · 연결 끊김 빨강. 값은 그대로 두고 색만 입혔습니다(수식 칸 없음).',
    '시각은 포탈 시각입니다(머리에 시간대 표기).',
  ]) { put(g, r, 1, line, { color: PAL.muted, size: 10 }); r += 1; }
  return g;
}

/**
 * 내용(hostExport.js buildHostExport 결과 + meta.offsetLabel) → 워크북 바이트(순수 — 메인·워커가 같은 함수).
 * @param {object} p
 */
export async function buildHostExportWorkbook(p) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VMware Global Monitoring Portal';
  wb.created = new Date(p.meta.at || Date.now());
  summarySheet(wb, p);
  clusterSheet(wb, p);
  await listSheet(wb, p);
  for (let i = 0; i < p.hosts.length; i++) {
    if (i % 4 === 3) await yieldLoop();
    hostSheet(wb, p, p.hosts[i], i, p.hosts);
  }
  guideSheet(wb, p);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, meta: { hosts: p.hosts.length, sheets: p.hosts.length + 4 } };
}

let _workerUrl = new URL('./hostExportXlsxWorker.js', import.meta.url);
/** 테스트 전용 — 띄우지 못하는 가짜 워커로 인라인 경로를 확인한다. */
export function _setHostExportXlsxWorkerUrlForTest(url) { _workerUrl = url || new URL('./hostExportXlsxWorker.js', import.meta.url); }

/** 내용 → .xlsx 바이트(워커 — 끄는 길 env HOST_EXPORT_XLSX_WORKER=0 · 시한 HOST_EXPORT_XLSX_TIMEOUT_MS 기본 5분). */
export function renderHostExportWorkbook(payload, { signal = null } = {}) {
  return runXlsxWorker({
    workerUrl: _workerUrl, payload, inline: buildHostExportWorkbook, signal, tag: 'host-export',
    timeoutMs: process.env.HOST_EXPORT_XLSX_TIMEOUT_MS ?? 300_000,   // 해석·상하한은 runXlsxWorker 의 deadlineMs
    disabled: String(process.env.HOST_EXPORT_XLSX_WORKER ?? '1').trim() === '0',
  });
}
