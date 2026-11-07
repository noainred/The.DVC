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

/**
 * v2.873 Bareos 백업 대상 표지 — 인벤토리 VM → { vgpu, passthrough, profile } 또는 null.
 *   VMware 는 vGPU·PCI 패스스루(DirectPath I/O) 장치가 있는 **켜진** VM 의 스냅샷을 지원하지 않아 스냅샷 기반 백업이 실패한다
 *   (Broadcom KB 394566 — 검색 요약 기준). 판정은 `vmGpuDevices` 하나를 쓴다(복제 금지).
 *   null = 인벤토리에 없음 · vm.gpu 없음(수집기는 **GPU 호스트 위 VM 만** 장치를 읽는다 — GPU 없는 호스트의 NIC 패스스루는 모른다) · 장치 0.
 *   패스스루 수는 GPU 가 아닌 DirectPath(NIC · HBA)도 센다(v2.871 gpu.md ①) — 스냅샷 제약은 그것도 같으므로 백업 표지에는 맞는 값이다.
 *   엣지 push 값은 수 형식을 좁히지 않으므로(central sanitizeVmGpuField 는 pciIds 만) 여기서 정수 0~64 로 자른다. 프로파일은 이름 글자만(64자).
 */
export function vmGpuMark(vm) {
  if (!vm || typeof vm !== 'object' || !vm.gpu || typeof vm.gpu !== 'object') return null;
  const d = vmGpuDevices(vm.gpu);
  const cap = (n) => Math.min(64, Math.floor(n));
  const vgpu = cap(d.vgpu);
  const passthrough = cap(d.passthrough);
  if (vgpu < 1 && passthrough < 1) return null;
  const p = typeof vm.gpu.profile === 'string' ? vm.gpu.profile.trim() : '';
  return { vgpu: Math.max(0, vgpu), passthrough: Math.max(0, passthrough), profile: vgpu > 0 && /^[A-Za-z0-9._-]{1,64}$/.test(p) ? p : '' };
}

/** GPU 모드 — 수집기 mode 가 없으면 vgpuMode 로(구버전 스냅샷). (v2.938: allocTree.js 에서 옮김 — 아래 gpuDevicesOnHost 가 함께 쓴다) */
export function gpuModeOf(g) {
  if (!g) return null;
  if (g.mode === 'vgpu' || g.mode === 'passthrough' || g.mode === 'vsga') return g.mode;
  return g.vgpuMode ? 'vgpu' : 'passthrough';
}

/**
 * v2.871 → v2.938(판정 한 벌): 호스트 기준 VM 의 GPU 장치 수. 수집기(parseVmGpu)의 패스스루 수는 GPU 가 아닌 DirectPath 장치(NIC · HBA)까지 센다 —
 * 호스트 패스스루 GPU 목록은 PCI 디스플레이 클래스(0x03)만이다(soapClient parsePassthruGpus). 호스트 패스스루 GPU 가 모두 pciId 를 갖고
 * VM 장치 주소(gpu.pciIds)를 모두 읽었을 때만 주소로 가른다(맞는 것만 GPU · 대소문자 무시). 하나라도 모르면(구버전 수집기 · 꺼진 VM 의 동적
 * DirectPath) 예전처럼 전부 GPU 로 본다(지어내지 않는다). GPU 할당율(allocTree)과 GPU 인벤토리(hostGpu · hardwareGpu)가 이것 하나를 쓴다.
 * ⚠ Bareos 백업 표지(vmGpuMark)는 쓰지 않는다 — 스냅샷 제약은 NIC 패스스루도 같다.
 * @returns {{ vgpu: number, passthrough: number, other: number }} other = GPU 가 아닌 패스스루 장치 수
 */
export function gpuDevicesOnHost(gpu, hostGpus) {
  const dev = vmGpuDevices(gpu);
  const list = Array.isArray(hostGpus) ? hostGpus.filter((g) => g && typeof g === 'object') : [];
  const ids = Array.isArray(gpu?.pciIds) ? gpu.pciIds.map((x) => String(x).toLowerCase()) : null;
  const pt = list.filter((g) => gpuModeOf(g) === 'passthrough');
  if (dev.passthrough > 0 && ids && ids.length === dev.passthrough && pt.every((g) => typeof g.pciId === 'string' && g.pciId)) {
    const hostIds = new Set(pt.map((g) => g.pciId.toLowerCase()));
    const gpuPt = ids.filter((id) => hostIds.has(id)).length;
    return { vgpu: dev.vgpu, passthrough: gpuPt, other: dev.passthrough - gpuPt };
  }
  return { vgpu: dev.vgpu, passthrough: dev.passthrough, other: 0 };
}
/** GPU 장치가 하나라도 있는 VM 인가(패스스루가 전부 NIC 등이면 아니다). 장치 수를 모르는 VM(필드 없음)은 예전처럼 GPU VM 으로 둔다. */
export const isGpuVmOnHost = (d) => d.vgpu > 0 || d.passthrough > 0 || !(d.other > 0);
/** 화면용 VM gpu 객체 — 패스스루 수·type 을 GPU 장치 기준으로 고친 사본(원본 스냅샷은 바꾸지 않는다). nonGpuPassthrough 로 뺀 수를 싣는다. */
export function gpuViewOnHost(gpu, d) {
  if (!gpu || typeof gpu !== 'object' || !(d.other > 0)) return gpu;
  const type = d.vgpu && d.passthrough ? 'mixed' : d.vgpu ? 'vgpu' : 'passthrough';
  return { ...gpu, type, count: d.vgpu + d.passthrough, passthrough: d.passthrough, nonGpuPassthrough: d.other };
}

/** VM 의 vGPU 할당 GB = 프로파일 GB × vGPU 장치 수. vGPU 가 없거나 해석 못 하면 null. */
export function vmVgpuAllocGB(gpu) {
  const { vgpu } = vmGpuDevices(gpu);
  if (!(vgpu > 0)) return null;
  const per = vgpuProfileGB(gpu.profile);
  return per == null ? null : per * vgpu;
}
