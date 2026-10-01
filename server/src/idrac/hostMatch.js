/**
 * 물리(iDRAC) ↔ 가상화(vCenter ESXi) 매칭 — 순수 함수.
 * Dell 서버는 iDRAC '서비스태그'와 ESXi 호스트 하드웨어 '일련번호'가 동일하므로,
 * 서비스태그로 대응하는 vCenter 호스트를 찾는다. 대소문자·공백 무시.
 */
export function findHostByServiceTag(serviceTag, hosts = []) {
  const t = String(serviceTag || '').trim().toLowerCase();
  if (!t) return null;
  return (hosts || []).find((h) => String(h.serviceTag || '').trim().toLowerCase() === t) || null;
}

/**
 * v2.666 — 호스트 이름 비교용 짧은 이름(순수). 사용자 요청: "도메인 포함 호스트네임이면 도메인 떼고 비교 · HOST 와 host 는
 * 같은 이름". 앞뒤 공백 제거 → 소문자 → 끝 점 제거 → 첫 '.' 앞부분. ⚠ IP 주소(v4·v6)는 이름이 아니다 — '10.20.1.11' 을 줄이면
 * '10' 이 되어 10.x 로 등록된 모든 서버가 같은 호스트가 된다(v2.628 C2628-01 과 같은 함정). IP·빈 값은 '' 를 돌려 비교에서 뺀다.
 */
const IP_LIKE = /^(\d{1,3}\.){3}\d{1,3}$|:/;
export function hostShortName(name) {
  const n = String(name ?? '').slice(0, 255).trim().toLowerCase().replace(/\.+$/, ''); // 길이를 먼저 자른다(끝 점 정규식이 긴 입력에서 초선형)
  if (!n || IP_LIKE.test(n)) return '';
  return n.split('.')[0];
}

const AMBIGUOUS = Symbol('ambiguous-host-name');

/**
 * 호스트 목록 → 매칭 색인(순수). 서비스태그(대소문자 무시)와 짧은 이름. 짧은 이름이 **서로 다른 호스트 둘 이상**에 걸리면
 * 판정 근거가 아니다(AMBIGUOUS — 다른 법인의 같은 이름 호스트에 붙이지 않는다).
 */
export function buildHostMatchIndex(hosts = []) {
  const byTag = new Map();
  const byShort = new Map();
  for (const h of hosts || []) {
    if (!h || typeof h !== 'object') continue;
    const t = String(h.serviceTag || '').trim().toLowerCase();
    if (t && !byTag.has(t)) byTag.set(t, h);
    const sh = hostShortName(h.name);
    if (!sh) continue;
    const prev = byShort.get(sh);
    byShort.set(sh, prev === undefined || prev === h ? h : AMBIGUOUS);
  }
  return { byTag, byShort };
}

/**
 * 서버 → 대응 ESXi 호스트(순수). 서비스태그가 먼저이고, 없거나 맞지 않으면 이름 후보(iDRAC 등록 이름·인벤토리 호스트네임)의
 * 짧은 이름으로 찾는다. 반환 `{ host, matchedBy:'serviceTag'|'hostname'|null, ambiguous:boolean, name }`.
 * 이름 후보 둘이 서로 다른 호스트를 가리키면 판정하지 않는다(ambiguous).
 */
export function matchHostForServer(index, { serviceTag = '', names = [] } = {}) {
  const none = { host: null, matchedBy: null, ambiguous: false, name: '', tagMismatch: false };
  if (!index) return none;
  const t = String(serviceTag || '').trim().toLowerCase();
  if (t && index.byTag.has(t)) return { host: index.byTag.get(t), matchedBy: 'serviceTag', ambiguous: false, name: '', tagMismatch: false };
  let found = null; let foundName = ''; let ambiguous = false;
  for (const n of names || []) {
    const sh = hostShortName(n);
    if (!sh) continue;
    const h = index.byShort.get(sh);
    if (h === undefined) continue;
    if (h === AMBIGUOUS) { ambiguous = true; continue; }
    if (found && found !== h) return { ...none, ambiguous: true };
    found = h; foundName = sh;
  }
  if (found) {
    // v2.682(R3D-04): 서버 태그와 그 이름 호스트의 태그가 **둘 다 있고 다르면** 다른 박스라는 양성 증거다 — 이름만으로 잇지 않는다
    // (하드웨어 교체 뒤 호스트명 재사용 시 다른 박스의 vCenter CPU·GPU 를 겹쳐 그리게 된다). 한쪽이 비어 있으면 판정 근거가 없으니 이름을 쓴다.
    const ht = String(found.serviceTag || '').trim().toLowerCase();
    if (t && ht && ht !== t) return { ...none, tagMismatch: true, name: foundName };
    return { host: found, matchedBy: 'hostname', ambiguous: false, name: foundName, tagMismatch: false };
  }
  return { ...none, ambiguous };
}
