/**
 * vim25 VirtualDeviceConnectInfo(장치의 `connectable`) XML — 장치 연결 칸을 만드는 곳은 여기 하나다(순수 — 테스트 고정).
 *
 * ⚠ **원소 순서가 스키마 순서여야 한다**: migrateConnect? · startConnected · allowGuestControl · connected · status?.
 *   vCenter 의 SOAP 역직렬화는 순서를 지킨다 — v3.0.1 이전 VM 사양 변경(provision/reconfig.js)은 startConnected · connected ·
 *   allowGuestControl 순서로 보내 NIC 연결 해제가 'SOAP 500: Required property allowGuestControl is missing from data object of type
 *   VirtualDeviceConnectInfo' 로 거부됐다(사용자 실측 2026-11-13). NIC 추가도 같은 순서였다(같은 거부일 것으로 추정 — 실측은 연결 해제뿐).
 *   세 칸은 모두 필수(minOccurs 1)다. 순서 근거: vim25 WSDL sequence(govmomi vim25/types 필드 순서와 같다).
 *   이 파일 밖에서 `<connectable><…>` 를 직접 조립하지 말 것 — `test/nicConnectInfo301.test.js` 가 소스를 스윕한다.
 */

const tf = (v) => (v ? 'true' : 'false');

/** 스키마 순서의 `<connectable>` — 세 값 모두 필수라 빠뜨릴 수 없게 인자로 받는다. */
export function connectInfoXml({ startConnected, allowGuestControl, connected }) {
  return `<connectable><startConnected>${tf(startConnected)}</startConnected>`
    + `<allowGuestControl>${tf(allowGuestControl)}</allowGuestControl>`
    + `<connected>${tf(connected)}</connected></connectable>`;
}

/** 장치 본문에서 connectable 의 한 칸(true|false)을 읽는다. 칸이 없거나 못 읽으면 null(false 로 단정하지 않는다). */
export function readConnectFlag(deviceInner, tag) {
  const conn = /<connectable>([\s\S]*?)<\/connectable>/.exec(String(deviceInner || ''))?.[1];
  if (conn == null) return null;
  const m = new RegExp(`<${tag}>(true|false)</${tag}>`).exec(conn);
  return m ? m[1] === 'true' : null;
}

// VirtualDevice 의 sequence 에서 connectable **뒤에** 오는 원소들(VirtualDevice · VirtualEthernetCard). connectable 이 없는 장치에
//   넣을 때 이 중 가장 앞의 것 앞에 넣는다 — 끝에 덧붙이면 macAddress 뒤로 가 순서가 깨진다.
//   실제 NIC 는 connectable 을 늘 싣는다 — 이 경로는 방어용이다(목록에 없는 새 칸이 맨 앞이면 그 뒤에 들어갈 수 있다).
const AFTER_CONNECTABLE_RE = /<(?:slotInfo|controllerKey|unitNumber|numaNode|deviceGroupInfo|addressType|macAddress|wakeOnLanEnabled|resourceAllocation|externalId|uptCompatibilityEnabled|subnetId|uptv2Enabled|strictLatencyConfig)[\s>]/;

/**
 * 읽은 장치 본문(`<VirtualDevice …>` 와 `</VirtualDevice>` 사이)의 connectable 을 connXml 로 바꾼다.
 * 장치는 **읽은 그대로 되돌려 보낸다** — backing 을 비우면 DVS 포트가 풀리고, macAddress·addressType 등을 빼고 edit 하면 vCenter 가
 * 무엇으로 채울지 확인하지 못했다(추정 — 실환경 미확인). govc device.connect 도 읽은 장치 전체를 EditDevice 로 보낸다(반증 검토가 원본 확인).
 */
export function withConnectable(deviceInner, connXml) {
  const s = String(deviceInner || '');
  if (/<connectable>[\s\S]*?<\/connectable>/.test(s)) return s.replace(/<connectable>[\s\S]*?<\/connectable>/, () => connXml);
  const m = AFTER_CONNECTABLE_RE.exec(s);
  return m ? s.slice(0, m.index) + connXml + s.slice(m.index) : s + connXml;
}

/** `<VirtualDevice xsi:type="…">본문</VirtualDevice>` 조각에서 본문만(여는 태그 뒤 ~ 마지막 닫는 태그 앞). 형식이 아니면 ''. */
export function deviceInnerOf(piece) {
  const s = String(piece || '');
  const open = s.indexOf('>');
  const close = s.lastIndexOf('</VirtualDevice>');
  return open < 0 || close < open ? '' : s.slice(open + 1, close);
}
