/**
 * reportExport.js — 화면에 보이는 리포트 영역을 **PDF/JPG 파일로 저장**(v2.449).
 *
 * 사용자 요구: "리포트 페이지를 PDF/JPG 로 저장하는 기능". 자원 축소 근거 리포트는 감축 결재의
 * 근거 자료라 화면 캡처가 아니라 파일로 남길 수 있어야 한다.
 *
 * 설계 메모:
 *  · html2canvas·jsPDF 는 **동적 import** 로만 불러온다. 둘 합쳐 ~500KB 인데 정적 import 하면
 *    특수기능 청크(이미 820KB)에 얹혀 리포트를 안 여는 사용자까지 매번 내려받는다. 동적 import 면
 *    vite 가 별도 청크로 잘라 **저장 버튼을 누른 사람만** 받는다. 오프라인 배포에서도 dist 안의
 *    정적 파일이라 외부 네트워크가 필요 없다.
 *  · 다크 테마라 배경을 명시하지 않으면 JPEG 가 검게 뭉갠다(JPEG 는 투명도가 없다) — 캡처 대상의
 *    실제 계산 배경색을 읽어 넣고, 못 읽으면 패널 기본색으로 폴백한다.
 *  · 리포트는 세로로 길다. PDF 는 한 장에 우겨넣지 않고 **A4 높이만큼 잘라 여러 장**으로 만든다
 *    (한 장에 맞추면 차트 눈금이 읽을 수 없게 줄어든다).
 *  · 버튼 자신은 결과물에 남으면 안 되므로 `data-export-hide` 가 붙은 요소는 캡처에서 제외한다.
 */

/** 파일명 안전화 — 파일시스템 금지 문자 제거 + 공백은 _ (한글은 사람이 읽으라고 보존). */
export function safeFileName(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '_')   // 경로·와일드카드 등 파일시스템 금지 문자
    .replace(/[\u0000-\u001f\u007f]/g, '')       // 제어문자는 통째로 제거
    .replace(/\s+/g, '_')                          // 공백 → _ (셸에서 다루기 쉽게)
    .replace(/_{2,}/g, '_')
    .slice(0, 120) || 'report';
}

/** `자원축소근거_<VM>_<기간>_<YYYYMMDD-HHmm>.<ext>` */
export function exportFileName(vmName, days, ext, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `${safeFileName(`자원축소근거_${vmName}_최근${days}일_${stamp}`)}.${ext}`;
}

/**
 * 캔버스를 A4 세로 페이지 높이로 자르는 계획을 만든다(순수 — 테스트로 고정).
 * @returns [{ sy, sh, hMm }] — 원본 캔버스에서 잘라낼 y·높이(px)와 PDF 에 그릴 높이(mm).
 */
export function pageSlices(canvasW, canvasH, pageWmm = 210, pageHmm = 297, marginMm = 8) {
  const usableW = pageWmm - marginMm * 2;
  const usableH = pageHmm - marginMm * 2;
  if (!(canvasW > 0) || !(canvasH > 0)) return [];
  const pxPerMm = canvasW / usableW;                 // 가로를 페이지 폭에 맞춘 배율
  const sliceH = Math.max(1, Math.floor(usableH * pxPerMm)); // 한 페이지에 들어가는 원본 px
  const out = [];
  for (let sy = 0; sy < canvasH; sy += sliceH) {
    const sh = Math.min(sliceH, canvasH - sy);
    out.push({ sy, sh, hMm: sh / pxPerMm });
    if (out.length > 200) break;                     // 폭주 방지(비정상 입력)
  }
  return out;
}

/** 브라우저 다운로드 트리거(a[download]). */
function saveBlobUrl(url, filename, revoke) {
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  if (revoke) setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** 캡처 대상의 실제 배경색(투명이면 조상 → 최종 폴백). */
function backgroundOf(el) {
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    const bg = getComputedStyle(n).backgroundColor;
    if (bg && !/^(transparent|rgba\(0,\s*0,\s*0,\s*0\))$/.test(bg)) return bg;
  }
  return '#0f172a';
}

const MARK = 'data-export-root';

/** 공통 캡처 — 스크롤로 잘린 부분까지 요소의 자연 크기 전체를 담는다. */
async function capture(el, { scale = 2 } = {}) {
  const { default: html2canvas } = await import('html2canvas');
  el.setAttribute(MARK, '1');
  try {
    return await html2canvas(el, {
      scale,
      backgroundColor: backgroundOf(el),
      useCORS: true,
      logging: false,
      // 부모가 overflow:auto 라도 요소 자체의 전체 높이를 그리게 한다.
      width: el.scrollWidth,
      height: el.scrollHeight,
      windowWidth: el.scrollWidth,
      windowHeight: el.scrollHeight,
      ignoreElements: (n) => n.nodeType === 1 && n.hasAttribute && n.hasAttribute('data-export-hide'),
      // html2canvas 는 DOM 을 복제해 그리는데, 복제본에도 maxHeight/overflow 가 그대로 남아
      // 스크롤로 가려진 아래쪽(메모리 표·인용 문서)이 잘린다 — 복제본에서만 해제한다.
      onclone: (doc) => {
        const t = doc.querySelector(`[${MARK}]`);
        if (t) { t.style.maxHeight = 'none'; t.style.height = 'auto'; t.style.overflow = 'visible'; }
      },
    });
  } finally {
    el.removeAttribute(MARK);
  }
}

/** JPG 한 장으로 저장. */
export async function saveElementAsJpg(el, filename, { quality = 0.92, scale = 2 } = {}) {
  const canvas = await capture(el, { scale });
  const url = canvas.toDataURL('image/jpeg', quality);
  saveBlobUrl(url, filename, false);
  return { pages: 1, width: canvas.width, height: canvas.height };
}

/** A4 세로 다중 페이지 PDF 로 저장. */
export async function saveElementAsPdf(el, filename, { scale = 2, quality = 0.92 } = {}) {
  const canvas = await capture(el, { scale });
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  const margin = 8;
  const slices = pageSlices(canvas.width, canvas.height, 210, 297, margin);
  const cut = document.createElement('canvas');
  const ctx = cut.getContext('2d');
  slices.forEach((s, i) => {
    if (i > 0) pdf.addPage();
    cut.width = canvas.width; cut.height = s.sh;
    ctx.drawImage(canvas, 0, s.sy, canvas.width, s.sh, 0, 0, canvas.width, s.sh);
    pdf.addImage(cut.toDataURL('image/jpeg', quality), 'JPEG', margin, margin, 210 - margin * 2, s.hMm, undefined, 'FAST');
  });
  pdf.save(filename);
  return { pages: slices.length, width: canvas.width, height: canvas.height };
}

/* ══════════════ 벡터 PDF — 글자·도형(래스터 이미지 대신 jsPDF 로 직접 그림) ══════════════
 * 사용자 요구(v2.471): "PDF 를 그림이 아니라 글자와 도형으로". html2canvas 캡처는 화면을 픽셀로
 * 떠 넣어 확대하면 흐리고 텍스트 선택도 안 된다. 여기서는 리포트의 '문서 모델'을 받아 제목·표·
 * 차트를 jsPDF 의 text/line/rect 로 그린다 → 선택·확대해도 선명한 벡터, 파일도 작다.
 * 한글은 임베드 폰트(Pretendard KS X 1001 서브셋, 저장 클릭 시 동적 로드)로 진짜 텍스트로 그린다.
 *
 * 문서 모델: { title, subtitle?, meta?, blocks: [ block ] }
 *   block = { type:'kvrow', items:[{k,v,color?,sub?}] }
 *         | { type:'heading', text, right? }
 *         | { type:'note', text }
 *         | { type:'table', columns:[{label,align?,w?}], rows:[[cell]] }  cell={text,align?,color?}
 *         | { type:'linechart', title?, unitLabel?, refY?, refLabel?, points:[{t,v}] }
 */
const PAL = {
  text: [30, 41, 59], muted: [100, 116, 139], line: [226, 232, 240], head: [241, 245, 249],
  blue: [37, 99, 235], green: [22, 163, 74], red: [220, 38, 38], amber: [217, 119, 6], zebra: [248, 250, 252],
};
const PAGE = { w: 210, h: 297, m: 12 };
const RGB = { green: PAL.green, red: PAL.red, amber: PAL.amber, blue: PAL.blue, muted: PAL.muted, text: PAL.text };
const colorOf = (name) => RGB[name] || PAL.text;

async function newVectorPdf() {
  const { jsPDF } = await import('jspdf');
  const { PRETENDARD_KSX_BASE64 } = await import('../../vendor/pretendardKsxFont.js');
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  pdf.addFileToVFS('PretendardKSX.ttf', PRETENDARD_KSX_BASE64);
  pdf.addFont('PretendardKSX.ttf', 'Pretendard', 'normal');
  pdf.setFont('Pretendard', 'normal');
  return pdf;
}

function ensureSpace(ctx, need) {
  if (ctx.y + need > PAGE.h - PAGE.m) { ctx.pdf.addPage(); ctx.y = PAGE.m; }
}
function tcol(pdf, rgb) { pdf.setTextColor(rgb[0], rgb[1], rgb[2]); }
function fillcol(pdf, rgb) { pdf.setFillColor(rgb[0], rgb[1], rgb[2]); }
function drawcol(pdf, rgb) { pdf.setDrawColor(rgb[0], rgb[1], rgb[2]); }
// 임베드 폰트 폭으로 말줄임 — 셀·라벨이 열 폭을 넘지 않게.
function ellipsize(pdf, s, maxW) {
  s = String(s == null ? '' : s);
  if (pdf.getTextWidth(s) <= maxW) return s;
  let lo = 0; let hi = s.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pdf.getTextWidth(s.slice(0, mid) + '…') <= maxW) lo = mid; else hi = mid - 1; }
  return s.slice(0, lo) + '…';
}

function drawHeader(ctx, doc) {
  const { pdf } = ctx; const x = PAGE.m;
  pdf.setFontSize(15); tcol(pdf, PAL.text);
  pdf.text(ellipsize(pdf, doc.title || '', PAGE.w - PAGE.m * 2), x, ctx.y);
  ctx.y += 6.5;
  if (doc.subtitle) { pdf.setFontSize(10); tcol(pdf, PAL.muted); pdf.text(ellipsize(pdf, doc.subtitle, PAGE.w - PAGE.m * 2), x, ctx.y); ctx.y += 5; }
  if (doc.meta) { pdf.setFontSize(9); tcol(pdf, PAL.muted); pdf.text(ellipsize(pdf, doc.meta, PAGE.w - PAGE.m * 2), x, ctx.y); ctx.y += 4.5; }
  drawcol(pdf, PAL.line); pdf.setLineWidth(0.3); pdf.line(x, ctx.y, PAGE.w - PAGE.m, ctx.y); ctx.y += 5;
}

function drawKvRow(ctx, items) {
  const { pdf } = ctx; const x0 = PAGE.m; const avail = PAGE.w - PAGE.m * 2;
  const cols = Math.min(items.length, 6) || 1;
  const cw = avail / cols;
  ensureSpace(ctx, 13);
  const rowTop = ctx.y;
  items.forEach((it, i) => {
    const col = i % cols;
    if (col === 0 && i > 0) ctx.y += 13;
    const x = x0 + col * cw;
    let yy = ctx.y;
    pdf.setFontSize(8); tcol(pdf, PAL.muted); pdf.text(ellipsize(pdf, it.k, cw - 2), x, yy); yy += 4.6;
    pdf.setFontSize(11.5); tcol(pdf, colorOf(it.color)); pdf.text(ellipsize(pdf, it.v, cw - 2), x, yy); yy += 4;
    if (it.sub) { pdf.setFontSize(7.5); tcol(pdf, PAL.muted); pdf.text(ellipsize(pdf, it.sub, cw - 2), x, yy); }
  });
  ctx.y = rowTop + Math.ceil(items.length / cols) * 13 + 2;
}

function drawHeading(ctx, text) {
  ensureSpace(ctx, 9);
  const { pdf } = ctx; ctx.y += 1;
  pdf.setFontSize(11.5); tcol(pdf, PAL.text); pdf.text(text, PAGE.m, ctx.y); ctx.y += 5.5;
}
function drawNote(ctx, text) {
  const { pdf } = ctx; pdf.setFontSize(8); tcol(pdf, PAL.muted);
  const lines = pdf.splitTextToSize(text, PAGE.w - PAGE.m * 2);
  ensureSpace(ctx, lines.length * 3.6 + 2);
  pdf.text(lines, PAGE.m, ctx.y); ctx.y += lines.length * 3.6 + 2;
}

function drawTable(ctx, columns, rows) {
  const { pdf } = ctx; const x0 = PAGE.m; const avail = PAGE.w - PAGE.m * 2;
  const wsum = columns.reduce((s, c) => s + (c.w || 1), 0);
  const widths = columns.map((c) => (c.w || 1) / wsum * avail);
  const padX = 1.6; const lineH = 3.5; const padY = 1.9;
  // 셀 내용을 열 폭에 맞춰 여러 줄로 접는다(잘리지 않게 — 사용자 요구 '문장 길면 줄바꿈').
  const wrap = (text, w, fontSize) => { pdf.setFontSize(fontSize); return pdf.splitTextToSize(String(text == null ? '' : text), Math.max(4, w - padX * 2)); };
  const drawHeadRow = () => {
    const linesArr = columns.map((c, i) => wrap(c.label, widths[i], 8.2));
    const maxLines = Math.max(1, ...linesArr.map((l) => l.length));
    const h = maxLines * lineH + padY * 2;
    if (ctx.y + h > PAGE.h - PAGE.m) { pdf.addPage(); ctx.y = PAGE.m; }
    fillcol(pdf, PAL.head); pdf.rect(x0, ctx.y, avail, h, 'F');
    pdf.setFontSize(8.2); tcol(pdf, PAL.muted);
    let cx = x0;
    columns.forEach((c, i) => {
      const w = widths[i]; const align = c.align || 'left';
      const tx = align === 'right' ? cx + w - padX : cx + padX;
      linesArr[i].forEach((ln, li) => pdf.text(ln, tx, ctx.y + padY + lineH - 1 + li * lineH, { align }));
      cx += w;
    });
    ctx.y += h;
  };
  ensureSpace(ctx, 20); drawHeadRow();
  rows.forEach((r, ri) => {
    const linesArr = columns.map((c, i) => wrap((r[i] || {}).text, widths[i], 8.4));
    const maxLines = Math.max(1, ...linesArr.map((l) => l.length));
    const h = maxLines * lineH + padY * 2;
    if (ctx.y + h > PAGE.h - PAGE.m) { pdf.addPage(); ctx.y = PAGE.m; drawHeadRow(); }
    if (ri % 2 === 1) { fillcol(pdf, PAL.zebra); pdf.rect(x0, ctx.y, avail, h, 'F'); }
    pdf.setFontSize(8.4);
    let cx = x0;
    columns.forEach((c, i) => {
      const cell = r[i] || {}; const w = widths[i]; const align = cell.align || c.align || 'left';
      tcol(pdf, colorOf(cell.color));
      const tx = align === 'right' ? cx + w - padX : cx + padX;
      linesArr[i].forEach((ln, li) => pdf.text(ln, tx, ctx.y + padY + lineH - 1 + li * lineH, { align }));
      cx += w;
    });
    ctx.y += h;
  });
  drawcol(pdf, PAL.line); pdf.setLineWidth(0.2); pdf.line(x0, ctx.y, x0 + avail, ctx.y);
  ctx.y += 3;
}

function drawLineChart(ctx, block) {
  const { pdf } = ctx; const x0 = PAGE.m; const avail = PAGE.w - PAGE.m * 2;
  const chartH = 46; const labelH = block.title ? 5 : 0;
  ensureSpace(ctx, chartH + labelH + 8);
  if (block.title) { pdf.setFontSize(9.5); tcol(pdf, PAL.text); pdf.text(block.title, x0, ctx.y + 3.5); ctx.y += labelH; }
  const px = x0 + 16; const pw = avail - 20; const py = ctx.y + 2; const ph = chartH - 10;
  const pts = (block.points || []).filter((p) => p && Number.isFinite(Number(p.t)) && Number.isFinite(Number(p.v))).map((p) => ({ t: +p.t, v: +p.v })).sort((a, b) => a.t - b.t);
  // 축 상자
  drawcol(pdf, PAL.line); pdf.setLineWidth(0.2); pdf.rect(px, py, pw, ph, 'S');
  if (pts.length < 2) {
    pdf.setFontSize(8); tcol(pdf, PAL.muted); pdf.text('추이 표본 부족(관측 2점 미만) — 더 긴 구간을 선택하세요', px + 3, py + ph / 2);
    ctx.y = py + ph + 6; return;
  }
  const xs = pts.map((p) => p.t); const ys = pts.map((p) => p.v);
  let minY = Math.min(...ys); let maxY = Math.max(...ys);
  if (block.refY != null) { minY = Math.min(minY, block.refY); maxY = Math.max(maxY, block.refY); }
  // Y축 상단을 할당 용량까지(사용자 요구) — 사용량 대비 여유가 한눈에 보이게. 데이터가 더 크면 확장.
  if (block.axisMax != null && Number.isFinite(block.axisMax)) maxY = Math.max(maxY, block.axisMax);
  minY = Math.min(minY, 0);
  if (minY === maxY) { maxY = minY + 1; minY -= 1; }
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const sx = (t) => px + (maxX === minX ? 0 : (t - minX) / (maxX - minX)) * pw;
  const sy = (v) => py + ph - (v - minY) / (maxY - minY) * ph;
  // y 그리드 3줄 + 라벨
  pdf.setFontSize(7); tcol(pdf, PAL.muted); drawcol(pdf, PAL.line);
  for (let g = 0; g <= 2; g++) {
    const v = minY + (maxY - minY) * (g / 2); const yy = sy(v);
    pdf.setLineWidth(0.1); pdf.line(px, yy, px + pw, yy);
    pdf.text(v.toLocaleString(undefined, { maximumFractionDigits: 1 }), px - 1.5, yy + 1, { align: 'right' });
  }
  // 기준선(할당 용량)
  if (block.refY != null) {
    drawcol(pdf, PAL.amber); pdf.setLineWidth(0.3); pdf.setLineDashPattern([1, 1], 0);
    pdf.line(px, sy(block.refY), px + pw, sy(block.refY)); pdf.setLineDashPattern([], 0);
    pdf.setFontSize(6.8); tcol(pdf, PAL.amber); pdf.text(block.refLabel || '할당', px + pw, sy(block.refY) - 0.8, { align: 'right' });
  }
  // 추이선 + 점
  drawcol(pdf, PAL.blue); pdf.setLineWidth(0.5);
  for (let i = 1; i < pts.length; i++) pdf.line(sx(pts[i - 1].t), sy(pts[i - 1].v), sx(pts[i].t), sy(pts[i].v));
  fillcol(pdf, PAL.blue);
  pts.forEach((p) => pdf.circle(sx(p.t), sy(p.v), 0.45, 'F'));
  // x 라벨(처음·끝)
  pdf.setFontSize(7); tcol(pdf, PAL.muted);
  const dt = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };
  pdf.text(dt(minX), px, py + ph + 3.5); pdf.text(dt(maxX), px + pw, py + ph + 3.5, { align: 'right' });
  // 단위 라벨은 좌상단에 — 우상단은 '할당' 기준선 라벨 자리라 겹친다(사용자 신고).
  if (block.unitLabel) pdf.text(`단위 ${block.unitLabel}`, px, py - 1.2);
  ctx.y = py + ph + 6;
}

/** 문서 모델 → 벡터 PDF 저장(한글 임베드 폰트). blocks 를 순서대로 그린다. */
export async function saveDocAsPdf(doc, filename) {
  const pdf = await newVectorPdf();
  const ctx = { pdf, y: PAGE.m };
  drawHeader(ctx, doc);
  for (const b of (doc.blocks || [])) {
    if (!b) continue;
    if (b.type === 'kvrow') drawKvRow(ctx, b.items || []);
    else if (b.type === 'heading') drawHeading(ctx, b.text || '');
    else if (b.type === 'note') drawNote(ctx, b.text || '');
    else if (b.type === 'table') drawTable(ctx, b.columns || [], b.rows || []);
    else if (b.type === 'linechart') drawLineChart(ctx, b);
  }
  // 페이지 번호(벡터)
  const n = pdf.getNumberOfPages();
  for (let i = 1; i <= n; i++) { pdf.setPage(i); pdf.setFontSize(7.5); tcol(pdf, PAL.muted); pdf.text(`${i} / ${n}`, PAGE.w - PAGE.m, PAGE.h - 6, { align: 'right' }); }
  pdf.save(filename);
  return { pages: n };
}
