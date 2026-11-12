/**
 * bmfolders/edgeBundle.js — 물리서버 폴더 **엣지 묶음**(v2.994 · 설계 docs/design/bm-folders §11 — 묶음 D). 순수.
 *
 * 저장소는 중앙 하나 그대로. 중앙이 판정한 결과(서버 → 폴더)를 그 엣지 법인 것만 **엣지 키로** 내려보낸다 — 엣지는 받은 사본 위에 자기 지금 값을 얹어 그린다
 * (서버 값이 WAN 을 왕복하지 않는다 · 엣지가 규칙으로 다시 판정하지 않는다 — 판정 코어 하나).
 *
 * 싣는 것: 법인(그 엣지가 수집하는 법인만) · 폴더 경로 · 폴더에 연결된 서비스 이름(서비스 인벤토리 물리서버 폴더 규칙 — 그 법인 것만) ·
 *   배치(엣지 키 → 경로 · 손 등록/규칙) · '이 엣지 밖 등록'(같은 법인이지만 이 엣지 목록에 없는 서버 — 중앙 직접 · 수집 서버 · 다른 엣지).
 * 싣지 않는 것: 다른 법인 · 법인 미지정 · 등록한 사람 · 시각 · 감사 · **자동 규칙 값**(규칙으로 놓였다는 사실만) · 관리 주소 · 서비스 태그(키 안에만).
 */
const t = (v) => String(v ?? '').trim();
const lc = (v) => t(v).toLowerCase();

export const BUNDLE_VER = 1;
export const BUNDLE_MAX = Object.freeze({ place: 20_000, outside: 2_000, folders: 2_000, services: 500, name: 128 });

/**
 * @param {object} p
 * @param {string}   p.agent     인증된 엣지 이름
 * @param {object[]} p.members   membersOf(g).members — edgeKey 는 엣지 출처 구성원만 갖는다
 * @param {object}   p.b         buildFolders 결과(전체 범위로 — placeOf)
 * @param {object}   p.main      peekMain()(폴더 목록)
 * @param {Set<string>|null} p.corps  그 엣지가 수집하는 법인(agentVcenterIds) — 없으면 그 엣지 서버가 있는 법인만
 * @param {Map<string,string>} [p.corpNames]
 * @param {object}   [p.svcLinks]  { [corp]: [{ prefix, service }] }
 * @param {string}   p.rev       저장소 세대
 */
export function buildEdgeBundle({ agent, members = [], b, main, corps = null, corpNames = new Map(), svcLinks = {}, rev = '', now = Date.now() } = {}) {
  const me = lc(agent);
  const mine = (m) => m?.kind === 'bm' && lc(m.remoteAgent) === me && t(m.source) === 'edge';
  const corpSet = new Set(corps instanceof Set ? [...corps].map(t).filter(Boolean) : []);
  for (const m of members) if (mine(m) && t(m.corp)) corpSet.add(t(m.corp));
  const place = {}; let nPlace = 0; let noEdgeKey = 0;
  const outside = []; let outsideMore = 0;
  for (const m of members) {
    const corp = t(m?.corp);
    if (!corp || !corpSet.has(corp)) continue;
    const p = b?.placeOf?.get?.(m.key);
    if (mine(m)) {
      if (!p?.path) continue;
      const ek = t(m.edgeKey);
      if (!ek) { noEdgeKey += 1; continue; }   // 엣지 키를 모르면(구버전 엣지 serverId 꼴 밖) 싣지 않는다 — 엉뚱한 서버에 붙이지 않게
      if (nPlace >= BUNDLE_MAX.place) continue;
      place[ek] = { path: p.path, src: p.src === 'rule' ? 'rule' : 'manual', corp };
      nPlace += 1;
    } else if (p?.path && m.kind === 'bm') {
      if (outside.length >= BUNDLE_MAX.outside) { outsideMore += 1; continue; }
      outside.push({ corp, path: p.path, name: t(m.name).slice(0, BUNDLE_MAX.name), via: t(m.source) === 'edge' ? 'other-edge' : t(m.source) === 'remote' ? 'collector' : 'central' });
    }
  }
  const corpRows = [...corpSet].sort().map((vc) => {
    const folders = Array.isArray(main?.corps?.[vc]?.folders) ? main.corps[vc].folders.filter((x) => typeof x === 'string').slice(0, BUNDLE_MAX.folders) : [];
    const services = (Array.isArray(svcLinks?.[vc]) ? svcLinks[vc] : []).slice(0, BUNDLE_MAX.services).map((x) => ({ prefix: t(x.prefix), service: t(x.service).slice(0, BUNDLE_MAX.name) })).filter((x) => x.prefix && x.service);
    return { vcenterId: vc, name: t(corpNames.get?.(vc) || vc).slice(0, BUNDLE_MAX.name), folders, services };
  });
  return { v: BUNDLE_VER, rev: t(rev), at: now, agent: t(agent), corps: corpRows, place, outside, ...(outsideMore ? { outsideMore } : {}), ...(noEdgeKey ? { noEdgeKey } : {}) };
}

/* 엣지별 받기 기록(메모리 — 재시작하면 다음 받기까지 '모름'). 중앙 법인 표의 '엣지 전달'. */
const _sync = new Map();
export function recordEdgeSync(agent, { have = '', version = '', now = Date.now() } = {}) {
  const k = lc(agent); if (!k) return;
  _sync.set(k, { at: now, have: t(have).slice(0, 64), version: t(version).slice(0, 32) });
  if (_sync.size > 500) _sync.delete(_sync.keys().next().value);
}
/** 그 엣지의 받기 상태 — { at, have, current } · 받은 적 없으면 null. current = 받아 간 판이 지금 저장소 세대와 같은가. */
export function edgeSyncOf(agent, rev) {
  const s = _sync.get(lc(agent));
  return s ? { at: s.at, have: s.have, current: !!s.have && s.have === t(rev) } : null;
}
export function _resetEdgeSyncForTest() { _sync.clear(); }
