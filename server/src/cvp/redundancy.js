/**
 * cvp/redundancy.js — ⑧ MLAG · 포트 채널 이중화(순수, v3.39 — docs/design/cvp-network-features §3 '이중화').
 *
 * 포트 채널: 설정된 멤버(관리상 켜진 것) 대비 링크가 올라온 멤버 — 전부 올라옴 ok · 일부만 degraded(이중화 상실) · 하나도 없음 down ·
 *   멤버 상태를 모르는 것이 섞여 결론을 못 내면 unknown · 멤버가 전부 관리상 꺼짐이면 off. 채널 소속(lag)을 **읽지 못한 장비**는 채널을 세지 않고
 *   lagUnread 로 따로 둔다(소속 '' 이 '채널 없음' 인지 '못 읽음' 인지는 info.cfgReadAt.lag 로 가른다).
 * MLAG: 상태 노드(…/Sysdb/mlag/status — 경로 · 필드 이름 추정) — active + connected + 피어 링크 up = ok. disabled = MLAG 안 씀(off).
 *   상태를 못 읽었으면 unread(인벤토리의 'MLAG 켜짐' 여부만 함께 싣는다 — 켜짐인데 못 읽음은 따로 보인다). 장애로 열지 않는다(화면만 — 시안 §6-5 기본값).
 */
export const CHANNEL_STATES = Object.freeze(['degraded', 'down', 'unknown', 'ok', 'off']);
export const MLAG_STATES = Object.freeze(['peerDown', 'notConnected', 'inactive', 'unknown', 'ok', 'off', 'unread']);
const PO = /^port-?channel\s?\d+$/i;

/** 한 장비의 포트 행 → 채널 목록. ports: [{port|name, oper, admin, lag, speedBps}] */
export function channelsOf(ports = []) {
  const m = new Map();
  for (const p of Array.isArray(ports) ? ports : []) {
    const lag = String(p?.lag || '').trim();
    if (!lag || !PO.test(lag)) continue;
    const name = String(p.port ?? p.name ?? '');
    if (!m.has(lag)) m.set(lag, { po: lag, members: [] });
    m.get(lag).members.push({ port: name, oper: p.oper || 'unknown', admin: p.admin || 'unknown', speedBps: p.speedBps ?? null });
  }
  const out = [];
  for (const c of m.values()) {
    const want = c.members.filter((x) => x.admin !== 'down');
    const up = want.filter((x) => x.oper === 'up').length;
    const unk = want.filter((x) => x.oper !== 'up' && x.oper !== 'down' && x.oper !== 'nolink').length;
    const knownDown = want.length - up - unk;
    let state;
    if (!want.length) state = 'off';
    else if (up === want.length) state = 'ok';
    // 반증 F4: 내려간 멤버가 하나라도 확인되면 이중화 상실이다(모르는 멤버가 섞여도 — 예전에는 unknown 으로 가려졌다). 전부 확인된 내려감만 down.
    else if (knownDown > 0) state = up === 0 && unk === 0 ? 'down' : 'degraded';
    else state = 'unknown';
    c.members.sort((a, b) => a.port.localeCompare(b.port, 'en', { numeric: true }));
    out.push({ ...c, total: c.members.length, expected: want.length, up, state });
  }
  return out.sort((a, b) => a.po.localeCompare(b.po, 'en', { numeric: true }));
}

/** MLAG 판정. ms = info.mlagStatus(없으면 null) · enabled = info.mlag(인벤토리 — true/false/undefined). */
export function mlagJudge(ms, enabled = undefined) {
  if (!ms || typeof ms !== 'object') return { state: enabled === false ? 'off' : 'unread', enabled: enabled ?? null };
  const st = String(ms.state || '');
  const neg = String(ms.negotiation || '');
  const pl = String(ms.peerLinkState || '');
  let state;
  if (!st && !neg && !pl) state = 'unknown';
  else if (/disabled|notconfigured|^off$/.test(st)) state = 'off';
  else if (/down|disabled|err/.test(pl)) state = 'peerDown';
  else if (neg && !/^connected$/.test(neg)) state = 'notConnected';
  else if (/inactive|primaryonly|secondaryonly/.test(st)) state = 'inactive';
  // 반증 F3: 협상 · 피어 링크를 **둘 다 읽고** 정상일 때만 ok(필드 이름이 추정이라 상태만 맞고 나머지를 못 읽으면 피어가 끊겨도 정상으로 셌다).
  else if (/active/.test(st) && neg === 'connected' && /up/.test(pl)) state = 'ok';
  else state = 'unknown';
  return { state, enabled: enabled ?? null, raw: { state: ms.state ?? null, negotiation: ms.negotiation ?? null, peerLinkState: ms.peerLinkState ?? null }, peerLink: ms.peerLink ?? null, domain: ms.domain ?? null, at: ms.at ?? null };
}

/**
 * 전 장비 → 장비 행 · 채널 · 개수.
 * @param {{ devices:Array<{agent,cvpId,key,hostname,model,info,corpName?,portsRead?}>, portsByDev:Map<string,Array> }} a
 */
export function redundancyFleet({ devices = [], portsByDev = new Map() } = {}) {
  const counts = { channels: 0, ch: Object.fromEntries(CHANNEL_STATES.map((k) => [k, 0])), mlag: Object.fromEntries(MLAG_STATES.map((k) => [k, 0])), lagUnread: 0, devices: 0 };
  const rows = [];
  for (const d of Array.isArray(devices) ? devices : []) {
    const id = `${d.agent}\u0000${d.cvpId}\u0000${d.key}`;
    const info = d.info && typeof d.info === 'object' ? d.info : {};
    const lagRead = !!(info.cfgReadAt && info.cfgReadAt.lag);
    const ports = portsByDev.get(id) || [];
    const chans = channelsOf(ports);
    // 소속을 읽지 못한 장비라도 포트 행에 채널 이름이 있으면(다른 경로 · 데모) 그 채널은 센다 — 없으면 '못 읽음'.
    const lagUnread = !lagRead && !chans.length;
    const mlag = mlagJudge(info.mlagStatus, info.mlag);
    counts.devices++;
    counts.mlag[mlag.state]++;
    if (lagUnread) counts.lagUnread++;
    for (const c of chans) { counts.channels++; counts.ch[c.state]++; }
    rows.push({ agent: d.agent, cvpId: d.cvpId, key: d.key, hostname: d.hostname || d.key, model: d.model || '', corpName: d.corpName || '',
      mlag, channels: chans, lagRead, lagUnread, lagPartial: !!(info.cfgReadAt && info.cfgReadAt.lagPartial), portsRead: d.portsRead !== false, worst: worstOf(chans, mlag) });
  }
  rows.sort((a, b) => a.worst - b.worst || String(a.hostname).localeCompare(String(b.hostname)));
  return { rows, counts };
}
/** 장비 하나의 가장 나쁜 상태 순위(작을수록 나쁨) — 정렬용. */
function worstOf(chans, mlag) {
  const m = { peerDown: 0, notConnected: 1, inactive: 2 }[mlag.state];
  const c = Math.min(9, ...chans.map((x) => ({ down: 0, degraded: 1, unknown: 5 }[x.state] ?? 9)));
  return Math.min(m ?? 9, c);
}
