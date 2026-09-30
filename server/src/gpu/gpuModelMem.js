/**
 * GPU 모델명 → 명목 VRAM(GB). v2.657 에 vcenter/soapClient.js 에서 옮겼다 — 호스트 GPU 요약(gpu/hostGpu.js)이
 * vGPU 할당률의 분모(명목 용량)로 함께 쓴다. 순수 모듈(import 0) — 수집기와 요약이 같은 표를 본다.
 */
/**
 * 모델명에서 GPU VRAM(GB) 추론 — 패스쓰루 GPU는 PCI 정보에 메모리가 없어 표시가 0이 되므로
 * 모델 문자열의 명시값(예: "A100 PCIe 80GB")을 우선, 없으면 알려진 모델로 보정.
 */
export function inferGpuMemGB(model) {
  const s = String(model || '');
  const explicit = /(\d{2,3})\s*GB/i.exec(s); // "80GB", "48 GB" 등 명시값 우선
  if (explicit) return Number(explicit[1]);
  const m = s.toUpperCase();
  if (/H200/.test(m)) return 141;
  if (/H100/.test(m)) return 80;
  if (/A100/.test(m)) return 80;          // 40/80 혼재 가능 — 명시 없으면 80 가정
  if (/A40|GA102/.test(m)) return 48;
  if (/L40S?/.test(m)) return 48;
  if (/A30/.test(m)) return 24;
  if (/A10(?!0)/.test(m)) return 24;
  if (/\bL4\b|AD104/.test(m)) return 24;
  if (/A16/.test(m)) return 16;
  if (/\bT4\b|TU104/.test(m)) return 16;
  if (/V100/.test(m)) return 32;
  return 0;
}
