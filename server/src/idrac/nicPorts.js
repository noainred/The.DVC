/**
 * idrac/nicPorts.js — NIC 포트 링크 판정·중복 제거(순수, v2.728). 의존 없음 — 엣지(collector/agent.js compactInv)·
 * 중앙(collector/remoteInventory.js sanitizeRemoteInv)·수집(idrac/redfish.js fetchInventory)·조회 응답(idrac/invView.js)이 같이 쓴다.
 *
 * ── 왜 생겼나(사용자 신고 v2.728) ──────────────────────────────────────────────────────────────
 * PowerEdge R640(iDRAC 7.00.00.183) 상세 화면에서 'BRCM GbE 4P 5720-t rNDC' 의 포트가 NIC.Integrated.1-1~1-4 로
 * **두 번씩(8개)** 나왔다. 원인(코드로 확인): `fetchInventory` 가 어댑터의 `NetworkPorts`(옛 스키마)와 `Ports`(새 스키마)
 * 컬렉션 **둘 다**와 컨트롤러 `Links.(NetworkPorts|Ports)` 를 따라가 포트 URL 을 모은 뒤 **URL 로만** 중복을 걸렀다
 * (`new Set(portRefs)`). 같은 물리 포트가 `.../NetworkPorts/NIC.Integrated.1-1` 과 `.../Ports/NIC.Integrated.1-1`
 * 두 URL 로 노출되면 둘 다 남는다. ⚠ 정직 기록 — 이 iDRAC 의 실제 응답 본문은 보지 못했다. 같은 Id 가 두 번 보인
 * 화면과 두 컬렉션을 모두 따라가는 코드로 추정했다. 그래서 중복은 URL 이 아니라 **포트 Id(대소문자 무시)** 로 묶는다.
 *
 * 링크 표시도 고친다: 화면이 `/up|enabled|linkup/` 에 맞지 않는 값을 전부 ⛔(다운)으로 칠했다 — 값을 못 읽은 포트
 * (빈 값·`Starting` 등)까지 '다운' 이라고 말한 것이다. 이제 판정은 이 파일 하나이고 셋으로 나눈다:
 *   up · down · **unknown**(못 읽음 — 다운으로 칠하지 않는다).
 * 근거(DMTF 스키마 — ⚠ 이 현장 iDRAC 응답으로는 확인하지 못했다):
 *   NetworkPort.LinkStatus  = Down | Up | Starting | Training
 *   Port.LinkStatus         = LinkUp | Starting | Training | LinkDown | NoLink
 *   Port.LinkState          = Enabled | Disabled | Unknown   (관리 상태 — Disabled 면 링크가 없다)
 *   Status.State(예전 폴백) = Enabled 등 — **링크가 아니라 자원 상태**다. 'Enabled' 를 링크 업으로 읽지 않는다
 *     (예전 화면은 그것을 🔗 로 칠했다 — 반대 방향의 거짓).
 */

const norm = (v) => String(v ?? '').trim().toUpperCase().replace(/[\s_-]+/g, '');

const UP = new Set(['UP', 'LINKUP']);
const DOWN = new Set(['DOWN', 'LINKDOWN', 'NOLINK', 'DISABLED']);

/** 원문 한 조각 → 'up' | 'down' | 'unknown'. */
function oneLink(v) {
  const s = norm(v);
  if (UP.has(s)) return 'up';
  if (DOWN.has(s)) return 'down';
  return 'unknown';
}

/**
 * 포트 링크 원문 → 'up' | 'down' | 'unknown'.
 * 중복 병합에서 두 출처가 다르게 말하면 `a | b` 로 둘 다 남긴다 — 그 경우 **unknown**(어느 쪽인지 모른다).
 * @param {string} link  ports[].link (원문)
 */
export function nicLinkState(link) {
  const parts = String(link ?? '').split('|').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return 'unknown';
  const states = new Set(parts.map(oneLink));
  if (states.size !== 1) return 'unknown';
  return [...states][0];
}

const portKey = (p) => String(p?.id ?? '').trim().toLowerCase();
const speedOf = (v) => { const n = Number(v); return typeof v === 'number' && Number.isFinite(n) && n > 0 ? n : null; };

/** 같은 포트 두 기록을 하나로 — 링크·속도·MAC 을 아는 쪽을 남긴다. */
function mergePort(a, b) {
  const out = { ...a };
  // 링크: 아는 쪽 우선. 둘 다 알고 다르면 원문을 둘 다 남겨 unknown 으로 떨어지게 한다(지어내지 않는다).
  const la = nicLinkState(a.link); const lb = nicLinkState(b.link);
  const ra = String(a.link ?? '').trim(); const rb = String(b.link ?? '').trim();
  if (la === 'unknown' && lb !== 'unknown') out.link = rb;
  else if (la !== 'unknown' && lb !== 'unknown' && la !== lb) out.link = `${ra} | ${rb}`;
  else if (!ra && rb) out.link = rb;
  // 속도: 정격/현재 중 큰 값(설치된 카드 속도를 보이는 것이 목적 — redfish.js nicPortSpeedMbps 와 같은 판단)
  const sa = speedOf(a.speedMbps); const sb = speedOf(b.speedMbps);
  if (sa == null && sb != null) out.speedMbps = sb;
  else if (sa != null && sb != null && sb > sa) out.speedMbps = sb;
  // MAC: 첫 비어 있지 않은 값
  if (!(typeof a.mac === 'string' && a.mac) && typeof b.mac === 'string' && b.mac) out.mac = b.mac;
  return out;
}

/**
 * 포트 목록에서 같은 물리 포트(Id 대소문자 무시)를 하나로 묶는다. Id 가 비어 있으면 묶지 않는다(근거가 없다).
 * 원래 순서(첫 등장 위치)를 유지한다. 입력을 고치지 않는다.
 * @returns {Array<object>}
 */
export function dedupNicPorts(ports) {
  if (!Array.isArray(ports)) return [];
  const out = [];
  const at = new Map();
  for (const p of ports) {
    if (!p || typeof p !== 'object') continue;
    const k = portKey(p);
    if (!k) { out.push(p); continue; }
    const i = at.get(k);
    if (i === undefined) { at.set(k, out.length); out.push(p); continue; }
    out[i] = mergePort(out[i], p);
  }
  return out;
}

/** 어댑터 배열의 포트를 각각 중복 제거한다(어댑터의 다른 필드는 그대로). 배열이 아니면 그대로 돌려준다. */
export function dedupNics(nics) {
  if (!Array.isArray(nics)) return nics;
  return nics.map((n) => (n && typeof n === 'object' && Array.isArray(n.ports) ? { ...n, ports: dedupNicPorts(n.ports) } : n));
}
