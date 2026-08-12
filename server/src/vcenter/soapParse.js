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
    // Sum sizes of snapshot data (.vmsn) files as a best-effort delta size.
    for (const blk of layoutXml.split('<file>').slice(1)) {
      const type = /<type>([^<]+)<\/type>/.exec(blk)?.[1];
      const size = Number(/<size>(\d+)<\/size>/.exec(blk)?.[1] || 0);
      if (type === 'snapshotData' || /-(\d{6})\.vmdk/.test(blk)) bytes += size;
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
    const psRe = /<propSet>\s*<name>([^<]+)<\/name>\s*<val[^>]*>([\s\S]*?)<\/val>\s*<\/propSet>/g;
    let p;
    while ((p = psRe.exec(block))) {
      // 스칼라 텍스트 값만 엔티티 복원(중첩 XML은 이후 내부 파서가 다루므로 원형 유지).
      props[p[1]] = p[2].indexOf('<') === -1 ? xmlUnescape(p[2]) : p[2];
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
    const free = Number(/<freeSpace>(\d+)<\/freeSpace>/.exec(blk)?.[1] || 0);
    if (!path && !cap) continue;
    const gb = (n) => Math.round((n / 1024 ** 3) * 10) / 10;
    out.push({ path, capacityGB: gb(cap), freeGB: gb(free), usedGB: gb(Math.max(0, cap - free)) });
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
