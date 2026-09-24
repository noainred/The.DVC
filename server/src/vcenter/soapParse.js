/**
 * 순수(사이드이펙트 없음) SOAP 응답 파서 — worker_threads 워커에서도 재사용하기 위해
 * soapClient.js에서 분리했다. 여기에는 config/DB/네트워크 등 부수효과 있는 import를 절대
 * 추가하지 말 것(워커가 로드할 때 부수효과가 워커 스레드에서 실행되면 안 됨).
 */

const XML_ENT_RE = /&(amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-fA-F]+));/g;
const XML_ENT_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function xmlUnescape(s) {
  if (!s || s.indexOf('&') === -1) return s;
  return s.replace(XML_ENT_RE, (whole, name, dec, hex) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return XML_ENT_MAP[name] ?? whole;
  });
}

// 스냅샷 체인 파일 판정(snapshotInfo) — layoutEx.file 의 type 과 델타 디스크 이름 형식.
const SNAP_FILE_TYPES = new Set(['snapshotData', 'snapshotMemory', 'snapshotList']);
const SNAP_DELTA_RE = /-\d{6}(?:-(?:delta|sesparse))?\.vmdk$/i;

/**
 * VM 'snapshot'(VirtualMachineSnapshotInfo) + 'layoutEx.file' XML → 스냅샷 요약.
 * 개수·근사 크기에 더해 생성일(가장 오래된/최신)과 이름 목록을 파싱한다 — 커뮤니티 표준
 * 점검 항목인 "N일 이상 된 스냅샷" 탐지에 필요(추가 SOAP 왕복 없음, 이미 수집된 XML 재사용).
 * 반환: { snapshotCount, snapshotSizeGB, snapshotOldestTs, snapshotNewestTs, snapshotNames }.
 */
export function snapshotInfo(snapXml, layoutXml) {
  let snapshotCount = 0;
  if (snapXml) snapshotCount = (snapXml.match(/<snapshot type="VirtualMachineSnapshot">/g) || []).length
    || (snapXml.match(/<VirtualMachineSnapshotTree>/g) || []).length;
  let bytes = 0;
  if (snapshotCount > 0 && layoutXml) {
    // 스냅샷 체인이 차지하는 파일 크기 합(v2.598 VC2598-01 — 예전에는 .vmsn 과 `-000001.vmdk`
    // **디스크립터**(수백 바이트)만 더해, 실제 용량인 델타 익스텐트(-000001-sesparse.vmdk ·
    // -000001-delta.vmdk)와 메모리(.vmem)가 빠졌다 → 스냅샷 크기가 거의 0 으로 보였다).
    // 판정: layoutEx.file 의 type 이 스냅샷 계열(snapshotData=.vmsn · snapshotMemory=.vmem ·
    // snapshotList=.vmsd)이거나, 파일 이름이 델타 체인 형식(`-NNNNNN.vmdk` · `-NNNNNN-delta.vmdk` ·
    // `-NNNNNN-sesparse.vmdk`)이면 더한다. 크기는 uniqueSize(다른 VM 과 공유하지 않는 바이트)가 있으면
    // 그것을 쓴다 — 링크드 클론이 공유하는 부모 체인을 이 VM 의 회수 가능 용량으로 세지 않게.
    for (const blk of layoutXml.split('<file>').slice(1)) {
      const type = /<type>([^<]+)<\/type>/.exec(blk)?.[1];
      const name = /<name>([^<]*)<\/name>/.exec(blk)?.[1] || '';
      const unique = /<uniqueSize>(\d+)<\/uniqueSize>/.exec(blk)?.[1];
      const size = Number(unique ?? /<size>(\d+)<\/size>/.exec(blk)?.[1] ?? 0);
      if (SNAP_FILE_TYPES.has(type) || SNAP_DELTA_RE.test(name)) bytes += size;
    }
  }
  // 트리 내 모든 <createTime>(중첩 child 포함)에서 가장 오래된/최신 생성일을 뽑는다.
  let oldest = null; let newest = null;
  const names = [];
  if (snapshotCount > 0 && snapXml) {
    const ctRe = /<createTime>([^<]+)<\/createTime>/g;
    let m;
    while ((m = ctRe.exec(snapXml))) {
      const ts = Date.parse(m[1]);
      if (!Number.isFinite(ts)) continue;
      if (oldest == null || ts < oldest) oldest = ts;
      if (newest == null || ts > newest) newest = ts;
    }
    // 스냅샷 이름 — currentSnapshot 참조 등에는 <name>이 없고 트리 노드에만 있다.
    const nameRe = /<name>([^<]*)<\/name>/g;
    while ((m = nameRe.exec(snapXml)) && names.length < 5) {
      const n = xmlUnescape(m[1]).trim();
      if (n) names.push(n);
    }
  }
  return {
    snapshotCount,
    snapshotSizeGB: Math.round(bytes / 1024 ** 3 * 10) / 10,
    snapshotOldestTs: oldest,
    snapshotNewestTs: newest,
    snapshotNames: names,
  };
}

/** Parse RetrieveProperties response into [{type, ref, props:{path:value}}]. */
export function parseObjectContent(xml) {
  const out = [];
  const objRe = /<returnval>([\s\S]*?)<\/returnval>/g;
  let m;
  while ((m = objRe.exec(xml))) {
    const block = m[1];
    const objM = /<obj type="([^"]+)">([^<]+)<\/obj>/.exec(block);
    if (!objM) continue;
    const props = {};
    // v2.598 VC2598-10: 빈 속성은 자기닫힘 `<val xsi:type="ArrayOfX"/>` 으로 올 수 있다. 예전 `<val[^>]*>`
    // 은 그 `/>` 까지 여는 태그로 읽고 **다음 propSet 의 `</val>` 까지** 삼켜, 그 속성에 옆 속성의 XML 이
    // 들어가고 옆 속성은 사라졌다. 자기닫힘을 먼저 따로 받는다(값은 빈 문자열).
    const psRe = /<propSet>\s*<name>([^<]+)<\/name>\s*<val(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/val>)\s*<\/propSet>/g;
    let p;
    while ((p = psRe.exec(block))) {
      const raw = p[2] ?? '';
      // 스칼라 텍스트 값만 엔티티 복원(중첩 XML은 이후 내부 파서가 다루므로 원형 유지).
      props[p[1]] = raw.indexOf('<') === -1 ? xmlUnescape(raw) : raw;
    }
    out.push({ type: objM[1], ref: objM[2], props });
  }
  return out;
}

/* ------------------- VM 전체 정보 CSV export 용 파서 (v2.275) ------------------- */

// NIC 로 취급하는 VirtualDevice 구체 타입(xsi:type) — VirtualEthernetCard 하위 전부.
const NIC_TYPE_RE = /^Virtual(E1000e?|Vmxnet\d?|Vmxnet3Vrdma|PCNet32|SriovEthernetCard)$/i;

/**
 * VM 'config.hardware.device'(ArrayOfVirtualDevice) XML → NIC/디스크 상세.
 * RetrieveProperties 직렬화에서 배열 원소는 <VirtualDevice xsi:type="구체타입">…
 * (HostGraphicsInfo 파서와 동일 규칙). 반환:
 *   nics:  [{ label, type, mac, network, connected }]
 *   disks: [{ label, capacityGB, thin, rdm, mode, datastore, fileName }]
 */
export function parseVmDevices(deviceXml) {
  const nics = [];
  const disks = [];
  if (!deviceXml) return { nics, disks };
  for (const blk of deviceXml.split(/<VirtualDevice(?=[ >])/).slice(1)) {
    const xsiType = /^[^>]*xsi:type="([^"]+)"/.exec(blk)?.[1] || '';
    const label = xmlUnescape(/<label>([^<]*)<\/label>/.exec(blk)?.[1] || '');
    if (NIC_TYPE_RE.test(xsiType)) {
      // 네트워크 이름: 표준 백킹은 <backing><deviceName>, DVS 포트 백킹은 이름이 없어
      // deviceInfo.summary(예: "DVSwitch: …")를 폴백으로 쓴다(추가 왕복 없이 최선).
      const deviceName = xmlUnescape(/<backing[^>]*>[\s\S]*?<deviceName>([^<]*)<\/deviceName>/.exec(blk)?.[1] || '');
      const summary = xmlUnescape(/<summary>([^<]*)<\/summary>/.exec(blk)?.[1] || '');
      nics.push({
        label,
        type: xsiType.replace(/^Virtual/, ''),
        mac: /<macAddress>([^<]*)<\/macAddress>/.exec(blk)?.[1] || '',
        network: deviceName || summary,
        connected: /<connectable>[\s\S]*?<connected>true<\/connected>/.test(blk),
      });
    } else if (xsiType === 'VirtualDisk') {
      const fileName = xmlUnescape(/<fileName>([^<]*)<\/fileName>/.exec(blk)?.[1] || '');
      const capKB = Number(/<capacityInKB>(\d+)<\/capacityInKB>/.exec(blk)?.[1] || 0);
      const backingType = /<backing xsi:type="([^"]+)"/.exec(blk)?.[1] || '';
      disks.push({
        label,
        capacityGB: Math.round((capKB / 1024 / 1024) * 10) / 10,
        thin: /<thinProvisioned>true<\/thinProvisioned>/.test(blk),
        rdm: /RawDiskMapping/i.test(backingType),
        mode: /<diskMode>([^<]*)<\/diskMode>/.exec(blk)?.[1] || '',
        datastore: /^\[([^\]]+)\]/.exec(fileName)?.[1] || '',
        fileName,
      });
    }
  }
  return { nics, disks };
}

/**
 * VM 'guest.disk'(ArrayOfGuestDiskInfo) XML → 게스트 내부 파티션 사용량.
 * 반환: [{ path, capacityGB, freeGB, usedGB }] (VMware Tools 실행 중일 때만 값이 온다).
 */
export function parseGuestDisks(guestDiskXml) {
  const out = [];
  if (!guestDiskXml) return out;
  for (const blk of guestDiskXml.split(/<GuestDiskInfo(?=[ >])/).slice(1)) {
    const path = xmlUnescape(/<diskPath>([^<]*)<\/diskPath>/.exec(blk)?.[1] || '');
    const cap = Number(/<capacity>(\d+)<\/capacity>/.exec(blk)?.[1] || 0);
    const freeM = /<freeSpace>(\d+)<\/freeSpace>/.exec(blk);
    const free = Number(freeM?.[1] || 0);
    if (!path && !cap) continue;
    const gb = (n) => Math.round((n / 1024 ** 3) * 10) / 10;
    // v2.600(감사 LO2600-07 — 보류): freeSpace 가 없으면 사용 = 용량(100%)으로 읽힌다. 소비처(guestdisk/analyze.vmSummary·
    //   vmExport)가 usedGB 를 `|| 0` 으로 더하므로 여기서 null 로 바꾸면 반대로 '전부 비었다'(회수 후보 과대)가 된다 —
    //   지금의 보수적 방향을 유지하고 사실만 `freeUnknown` 으로 싣는다(소비처가 걸러 쓰도록).
    out.push({ path, capacityGB: gb(cap), freeGB: gb(free), usedGB: gb(Math.max(0, cap - free)), ...(freeM ? {} : { freeUnknown: true }) });
  }
  return out;
}

/* --------------- 데이터스토어 브라우즈(파일·할당 VM) 용 파서 (v2.276) --------------- */

/** ArrayOfManagedObjectReference XML → 지정 타입의 ref 문자열 목록. */
export function parseMorefs(xml, type) {
  const out = [];
  if (!xml) return out;
  const re = new RegExp(`<ManagedObjectReference[^>]*type="${type}"[^>]*>([^<]+)<`, 'g');
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

/**
 * SearchDatastoreSubFolders 태스크의 info.result
 * (ArrayOfHostDatastoreBrowserSearchResults) XML → 평탄화된 파일 목록.
 * 반환: [{ folder, name, type, sizeBytes, modified }] — type 은 xsi:type 에서
 * 'FileInfo' 접미사를 뗀 값(VmDisk/VmConfig/VmLog/Folder/IsoImage/…, 미상은 'File').
 */
export function parseDsSearchResults(xml, cap = Infinity) {
  const out = [];
  if (!xml) return { files: out, truncated: false };
  let truncated = false;
  for (const blk of xml.split(/<HostDatastoreBrowserSearchResults(?=[ >])/).slice(1)) {
    const folder = xmlUnescape(/<folderPath>([^<]*)<\/folderPath>/.exec(blk)?.[1] || '');
    for (const fb of blk.split(/<file(?=[ >])/).slice(1)) {
      if (out.length >= cap) { truncated = true; return { files: out, truncated }; }
      const xsiType = /^[^>]*xsi:type="([^"]+)"/.exec(fb)?.[1] || 'FileInfo';
      const name = xmlUnescape(/<path>([^<]*)<\/path>/.exec(fb)?.[1] || '');
      if (!name) continue;
      out.push({
        folder,
        name,
        type: xsiType.replace(/FileInfo$/, '') || 'File',
        sizeBytes: Number(/<fileSize>(\d+)<\/fileSize>/.exec(fb)?.[1] || 0),
        modified: /<modification>([^<]+)<\/modification>/.exec(fb)?.[1] || '',
      });
    }
  }
  return { files: out, truncated };
}

/**
 * `layoutEx.file`(ArrayOfVirtualMachineFileLayoutExFileInfo) XML → 그 VM 이 소유한 **전 파일 경로**.
 *
 * v2.505 고아 VMDK 탐지의 소유 집합 소스다. `<file>` 블록의 `<name>` 이 `[ds] folder/file` 형태로
 * vmx·vmdk 디스크립터·flat/delta 익스텐트·vswp·vmsn·nvram·로그를 **전부** 담는다.
 * 소유 집합은 크게 잡는 쪽이 안전하므로 유형을 가리지 않고 전부 넣는다 — 빠뜨리면 쓰고 있는
 * 디스크가 고아로 보고된다(그 판정으로 사람이 파일을 지운다).
 */
export function parseLayoutFilePaths(xml) {
  const out = [];
  if (!xml) return out;
  for (const blk of String(xml).split('<file>').slice(1)) {
    const name = /<name>([^<]*)<\/name>/.exec(blk)?.[1];
    if (name) out.push(xmlUnescape(name));
  }
  return out;
}

/* ------------------- 요청 시한 정규화 (v2.598 T2598-03) ------------------- */

// vCenter·NSX·Horizon 등록의 요청 시한(timeoutMs) 범위. ⚠ 상한이 없으면 사고가 두 가지다 —
// ① AbortSignal.timeout / setTimeout 은 2^31−1ms(24.8일)를 넘으면 **1ms** 로 바뀌어(v2.591 L2 와 같은
//    함정) 모든 요청이 즉시 abort 된다 ② store 의 수집 데드라인은 timeoutMs×3 이라 715,827,883ms 부터
//    그 곱이 2^31 을 넘어 **데드라인이 즉시 발화**한다. 10분이면 800ms+ RTT 회선의 대형 RetrieveProperties
//    에도 충분하다. 이 파일에 두는 이유: 부수효과 없는 leaf 모듈이라 soapClient·registry·store 가 순환 없이
//    함께 쓸 수 있다(vcenter/registry.js 는 restClient 를 import 하고 restClient 는 soapClient 를 동적
//    import 하므로, soapClient 가 registry 를 import 하면 순환이 생긴다).
export const REQUEST_TIMEOUT_MIN_MS = 1_000;
export const REQUEST_TIMEOUT_MAX_MS = 600_000;

/**
 * 등록 저장용 — 빈 값·0·음수·숫자 아님은 0(= 기본값 규약), 그 밖은 [1초, 10분] 으로 자른다.
 * `Number('') === 0` 함정은 빈 값을 먼저 걸러 피한다(빈 칸 = 기본값이 이 등록부의 기존 규약이다).
 */
export function normRequestTimeoutMs(raw) {
  if (raw == null || raw === '' || typeof raw === 'boolean' || Array.isArray(raw)) return 0;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(REQUEST_TIMEOUT_MIN_MS, Math.min(REQUEST_TIMEOUT_MAX_MS, n));
}

/** 실행 시점 방어선 — 저장 파일에 남은 옛 큰 값(정규화 이전 저장분)도 상한으로 자른다. 0/없음은 dflt. */
export function effectiveRequestTimeoutMs(ms, dflt) {
  const n = normRequestTimeoutMs(ms);
  return n > 0 ? n : dflt;
}
