/**
 * GPU 모델명 → 명목 VRAM(GB). v2.657 에 vcenter/soapClient.js 에서 옮겼다 — 호스트 GPU 요약(gpu/hostGpu.js)이
 * vGPU 할당률의 분모(명목 용량)로 함께 쓴다. 순수 모듈(import 0) — 수집기와 요약이 같은 표를 본다.
 */
/**
 * 모델명에서 GPU VRAM(GB) 추론 — 패스쓰루 GPU는 PCI 정보에 메모리가 없어 표시가 0이 되므로
 * 모델 문자열의 명시값(예: "A100 PCIe 80GB")을 우선, 없으면 알려진 모델로 보정.
 */
/*
 * 전체 점검 95회차 F2(재현): 모델 이름을 낱말 경계 없이 맞춰 PCI 장치 이름 꼴(ESXi HostPciDevice.deviceName — 'GA102GL [A10]' 처럼 칩 이름 + 괄호 모델)에서
 *   틀린 명목값을 냈다 — 'GA102GL [A10]' → 48(칩 이름 GA102 를 A40 으로 봄 · 실제 24) · 'GA107GL [A16]' → 24('GA107' 안의 'A10') ·
 *   'RTX A4000' → 48('A4000' 안의 'A40' · 실제 16) · 'GA102GL [RTX A5000]' → 48(실제 24). 명목값은 vGPU 할당률의 분모(max(보고, 명목))와
 *   패스스루 용량이라, A10 한 장이 '48 GB 중 24 GB(50%)' 로 보였다. 이제 모델은 **낱말**로만 맞추고, 여러 모델이 같은 칩을 쓰는 칩 이름(GA102 = A10 · A40 · RTX A5000/A6000)은
 *   쓰지 않는다(모르면 0 — 명목을 지어내지 않는다 · 보고값이 분모). 웹 gpuAllocText.modelHasFamily 와 같은 낱말 규칙이다.
 *   ⚠ 이 현장 vCenter 가 GPU 이름을 어느 꼴로 주는지는 확인하지 못했다(정직 기록) — 두 꼴 모두 맞게 읽는다.
 */
// 96회차(95회차 F2 반증 — 재현): `\b` 는 밑줄을 낱말 글자로 봐 'NVIDIA_A10' · 'grid_a40-24q' 꼴(밑줄로 이은 이름)을 놓쳤다(예전 판은 48 · 지금 0).
//   지금 호출부(호스트 GPU 장치 이름)에는 그 꼴이 없지만 경계는 '영숫자가 아닌 것' 으로 둔다 — 'A4000' · 'GA107' 안의 모델 글자는 여전히 맞추지 않는다.
const W = (x) => new RegExp(`(?<![A-Z0-9])${x}(?![A-Z0-9])`);
const MODEL_GB = [
  [W('H200'), 141], [W('H100'), 80],
  [W('A100'), 80],                      // 40/80 혼재 가능 — 명시 없으면 80 가정
  [W('A40'), 48], [W('L40S?'), 48],
  [W('A30'), 24], [W('A10'), 24], [W('L4'), 24],
  [W('A16'), 16], [W('T4'), 16],
  [W('V100'), 32],
];
export function inferGpuMemGB(model) {
  const s = String(model || '').slice(0, 256);   // 외부 입력(장치 이름) — 길이를 먼저 자른다
  const explicit = /(\d{2,3})\s*GB/i.exec(s); // "80GB", "48 GB" 등 명시값 우선
  if (explicit) return Number(explicit[1]);
  const m = s.toUpperCase();
  for (const [re, gb] of MODEL_GB) if (re.test(m)) return gb;
  // 칩 이름만 있고 괄호 모델이 없을 때 — 그 칩을 쓰는 데이터센터 모델이 하나인 것만(TU104GL = T4 · AD104GL = L4. 괄호에 다른 모델이 있으면 위에서 못 맞춘 것이라 0).
  if (!/\[/.test(m)) {
    if (W('AD104(?:GL)?').test(m)) return 24;
    if (W('TU104(?:GL)?').test(m)) return 16;
  }
  return 0;
}
