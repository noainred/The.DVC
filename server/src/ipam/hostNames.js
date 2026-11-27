/**
 * hostNames.js — 스캔이 찾은 호스트명의 표시 규칙(순수 · v2.991). 스캔 엔진(scan.js) · 저장(scanStore.js) · 대장(ledger.js)이
 * 같은 판정을 쓴다(복제 금지 — 웹 사본 `web/src/views/tools/ipamHostText.js` 는 표시 문구만 갖고, 판정은 서버가 행에 실어 보낸다).
 *
 * 방식은 셋이고 이 순서가 표시 우선순위다(Angry IP Scanner 의 Hostname 칸과 같은 순서 — 시안 docs/design/ip-scan-hostname):
 *   dns     — DNS 서버에 PTR 조회(대상 장비로는 아무것도 보내지 않는다)
 *   mdns    — 대상 IP 의 UDP 5353 으로 역방향 PTR 질의(같은 네트워크 구간만 답한다)
 *   netbios — 대상 IP 의 UDP 137 로 노드 상태(NBSTAT) 질의(Windows · Samba)
 * 직접 넣은 이름(관리상태 편집 › 호스트명 = override `hostnameOverride`)은 대장에서 이 셋보다 먼저다(`netNameFields`).
 *
 * 저장 모양: `names = { dns?: {v, at, miss}, mdns?: …, netbios?: … }` — v 이름 · at 마지막으로 그 방식이 답한 시각 ·
 *   miss 그 뒤 연속으로 답하지 않은 횟수(묻지 않은 스캔은 세지 않는다). 스캔 엔진 결과는 같은 키에 문자열만 싣는다.
 */

/** 표시 우선순위 순 — 이 배열 순서를 바꾸면 표시 이름이 바뀐다(테스트 고정). */
export const NAME_METHODS = Object.freeze(['dns', 'mdns', 'netbios']);
/** 한 방식이 연속으로 이만큼 답하지 않으면 그 방식의 이름을 지운다(UDP 유실 한 번으로 이름이 깜박이지 않게 + 사라진 이름이 영원히 남지 않게). */
export const NAME_MISS_MAX = 3;

/** 문자열 또는 {v} → 이름 글자('' = 없음). */
export const nameValue = (x) => (typeof x === 'string' ? x : (x && typeof x === 'object' && typeof x.v === 'string' ? x.v : ''));

/** names(문자열 또는 {v} 값) → { name, src } — 우선순위대로 처음 있는 것. 없으면 { name:'', src:'' }. */
export function displayName(names) {
  if (!names || typeof names !== 'object') return { name: '', src: '' };
  for (const k of NAME_METHODS) {
    const v = nameValue(names[k]);
    if (v) return { name: v, src: k };
  }
  return { name: '', src: '' };
}

/**
 * 비교용 이름 — 첫 라벨 · 소문자 · 15자(NetBIOS 이름은 15자에서 잘리고 대문자다. 'WIN-APP01' 과 'win-app01.corp.example' 은 같은 이름이다).
 * '.local'(mDNS)도 첫 라벨만 본다.
 */
export function nameKey(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return '';
  return s.split('.')[0].slice(0, 15);
}

/**
 * 방식마다 이름이 다른가 — 서로 다른 비교용 이름이 둘 이상이면 그 목록(표시 이름을 뺀 나머지)을, 아니면 null.
 * 어느 쪽이 맞는지는 판정하지 않는다(시안 상태 ④).
 * @returns {null | Array<{src:string, v:string}>}
 */
export function nameMismatch(names) {
  if (!names || typeof names !== 'object') return null;
  const seen = new Map();
  for (const k of NAME_METHODS) {
    const v = nameValue(names[k]);
    const key = nameKey(v);
    if (key && !seen.has(key)) seen.set(key, { src: k, v });
  }
  if (seen.size < 2) return null;
  return [...seen.values()].slice(1);
}

/**
 * 대장 행에 싣는 호스트명 칸(순수). 행 하나에 붙는 값만 — 방식별 상세(시각 · 연속 무응답 · MAC)는 IP 상세 창이 따로 읽는다(응답 다이어트).
 * @param {object|null} sc 그 IP 의 스캔 결과(저장 모양) — 없으면 null
 * @param {object|null} ov 그 IP 의 관리상태(override) — hostnameOverride 가 있으면 그것이 먼저다
 * @returns {object} { netName, netNameSrc, netNameStale?, netNameAt?, nameMismatch?, nameAlt?, nameUnchecked? } — 값이 없는 칸은 싣지 않는다
 */
export function netNameFields(sc, ov) {
  const out = {};
  const manual = ov && typeof ov.hostnameOverride === 'string' ? ov.hostnameOverride.trim() : '';
  const names = sc && sc.names && typeof sc.names === 'object' ? sc.names : null;
  const d = displayName(names);
  if (manual) { out.netName = manual; out.netNameSrc = 'manual'; }
  else if (d.name) {
    out.netName = d.name; out.netNameSrc = d.src;
    const e = names[d.src];
    // 지난 스캔에서 그 방식이 답하지 않았다(아직 지우지 않았다) — 언제 확인한 이름인지 함께 싣는다(시안 상태 ⑤).
    if (e && typeof e === 'object' && Number(e.miss) > 0) { out.netNameStale = true; if (Number(e.at) > 0) out.netNameAt = Number(e.at); }
  } else if (sc && Array.isArray(sc.tried) && sc.tried.length === 0) {
    out.nameUnchecked = true; // 그 에이전트의 방식이 모두 꺼져 있었다 — '응답 없음' 과 다르다(시안 상태 ③)
  }
  const mm = nameMismatch(names);
  if (mm) { out.nameMismatch = true; out.nameAlt = mm; }
  return out;
}
