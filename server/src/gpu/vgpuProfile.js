/**
 * vGPU 프로파일 이름 → 할당 프레임버퍼(GB) (v2.650). 순수 함수.
 *
 * NVIDIA vGPU 프로파일 이름은 `<접두>_<GPU>-[<MIG 슬라이스>-]<프레임버퍼 GB><시리즈>` 꼴이다
 *   (예: grid_a100-10c · nvidia_l40s-48q · grid_t4-16q · grid_a100-3-40c · grid_m60-0b).
 * 끝의 숫자가 그 VM 에 할당된 VRAM(GB)이고, `0` 은 512MB 다(M60·M10 의 0Q/0B 프로파일).
 * ⚠ 이 규칙은 NVIDIA 문서의 명명 관례이고 이 현장 프로파일 목록으로 확인하지 않았다(정직 기록) — 형식이 맞지 않으면
 *   **지어내지 않고 null** 이다(화면이 '프로파일 해석 불가' 로 센다).
 * ⚠ 패스스루는 GPU 한 장 전체를 준다 — 이 함수의 대상이 아니다(용량은 게스트 nvidia-smi 의 memory.total 로 본다).
 */
export function vgpuProfileGB(profile) {
  const s = String(profile ?? '').trim();
  if (!s || s.length > 128) return null;
  const m = /-(\d{1,3})([a-z]{1,2})$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return n === 0 ? 0.5 : n;
}

/**
 * VM 의 vGPU·패스스루 장치 수. 수집기(soapClient parseVmGpu)는 vgpu·passthrough 를 따로 싣지만,
 * 그 필드가 없는 객체(구버전 스냅샷·목 데이터)는 type + count 로 되돌린다.
 */
export function vmGpuDevices(gpu) {
  if (!gpu) return { vgpu: 0, passthrough: 0 };
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  const count = n(gpu.count);
  return {
    vgpu: gpu.vgpu != null ? n(gpu.vgpu) : gpu.type === 'vgpu' ? count : 0,
    passthrough: gpu.passthrough != null ? n(gpu.passthrough) : gpu.type === 'passthrough' ? count : 0,
  };
}

/** VM 의 vGPU 할당 GB = 프로파일 GB × vGPU 장치 수. vGPU 가 없거나 해석 못 하면 null. */
export function vmVgpuAllocGB(gpu) {
  const { vgpu } = vmGpuDevices(gpu);
  if (!(vgpu > 0)) return null;
  const per = vgpuProfileGB(gpu.profile);
  return per == null ? null : per * vgpu;
}
