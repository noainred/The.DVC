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
