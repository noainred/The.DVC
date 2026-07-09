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
