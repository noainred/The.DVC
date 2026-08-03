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
