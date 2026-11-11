/**
 * views/tools/bmCapture.js — 리눅스 성능 6단계 **화면 캡처 PNG**(설계 PROFILES §16 B — 캡처는 서버가 만들지 않고 브라우저가 만든다 · 기존 CSV 와 같은 쪽).
 *
 * ⚠ 캡처 코어는 하나 — 리포트 저장(reportExport.js)의 html2canvas 경로(captureElementCanvas · 동적 import · 이미 있는 의존성 MIT 1.4.1)를 그대로 쓴다.
 *   새 의존성을 들이지 않았다(설계 정직 기록의 ‘html-to-image 류 추가’ 는 필요 없었다 — 저장소에 이미 같은 일을 하는 라이브러리가 있다).
 * ⚠ 이 화면의 그래프는 SVG 속성에 CSS 변수(stroke="var(--accent-2)")를 쓴다 — html2canvas 는 SVG 를 그림으로 직렬화하므로 변수가 풀리지 않는다.
 *   복제 문서에서 SVG 도형의 stroke · fill · opacity 를 **계산값으로 인라인**한다(inlineSvgPaint).
 * 그 아래에 **맥락 각주**(서버 · 법인 · 기간 · 커서 · 출처 · 생성자)를 캔버스 글자로 덧붙인다 — 보는 사람이 화면 없이도 읽게.
 */
import { captureElementCanvas } from './reportExport.js';

const PAINT = Object.freeze(['stroke', 'fill', 'stroke-opacity', 'fill-opacity', 'opacity', 'stroke-dasharray', 'stroke-width', 'color']);
/** 복제 문서의 SVG 도형 칠을 계산값으로(순회만). root 아래 svg 만. */
export function inlineSvgPaint(doc, root) {
  const win = doc?.defaultView;
  if (!win || !root) return 0;
  let n = 0;
  for (const el of root.querySelectorAll('svg, svg *')) {
    const cs = win.getComputedStyle(el);
    for (const p of PAINT) {
      const v = cs.getPropertyValue(p);
      if (v && !/var\(/.test(v)) { el.style.setProperty(p, v); n += 1; }
    }
  }
  return n;
}
/** 각주 줄 → 높이(px · 배율 전). */
export const footerHeight = (lines = []) => 16 + lines.length * 20;
/**
 * DOM 조각 → PNG Blob(각주 포함).
 * @param {HTMLElement} el
 * @param {{footer?:string[], scale?:number, capture?:Function}} o  capture — 테스트 주입(기본 = reportExport 캡처 코어)
 */
export async function captureNodePng(el, { footer = [], scale = 2, capture = captureElementCanvas } = {}) {
  if (!el) throw new Error('캡처할 화면이 없습니다.');
  const base = await capture(el, { scale, onclone: inlineSvgPaint });
  const fh = Math.ceil(footerHeight(footer) * scale);
  const out = document.createElement('canvas');
  out.width = base.width; out.height = base.height + fh;
  const ctx = out.getContext('2d');
  const root = window.getComputedStyle(document.documentElement);   // 바탕 · 글자색은 테마 토큰에서(색을 새로 박지 않는다)
  ctx.fillStyle = root.getPropertyValue('--bg').trim() || window.getComputedStyle(document.body).backgroundColor;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(base, 0, 0);
  ctx.fillStyle = root.getPropertyValue('--text').trim() || window.getComputedStyle(document.body).color;
  ctx.font = `${12 * scale}px system-ui, sans-serif`;
  footer.forEach((line, i) => ctx.fillText(String(line).slice(0, 220), 12 * scale, base.height + (20 + i * 20) * scale));
  return new Promise((resolve, reject) => {
    try { out.toBlob((b) => (b ? resolve(b) : reject(new Error('그림 파일을 만들지 못했습니다.'))), 'image/png'); }
    catch (e) { reject(e?.name === 'SecurityError' ? new Error('이 브라우저가 화면 그림 만들기를 막았습니다(보안 설정).') : e); }
  });
}
export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1_000);
}
/** 파일 이름(ASCII — 헤드리스 · 일부 브라우저가 한글 download 이름을 떨어뜨린다: v2.519). */
export function captureName(kind, at = Date.now()) {
  const d = new Date(at);
  const p = (v) => String(v).padStart(2, '0');
  return `bm-${String(kind).replace(/[^\w-]+/g, '_').slice(0, 30)}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.png`;
}
