/**
 * linkcheck/links.js — **설정에서 통신 링크를 자동으로 뽑는다**(순수, v2.552).
 *
 * 사용자 요청(2026-09-18): "main 포탈과 edge 포탈의 모든 통신이 정상인지 측정하는 프로그램을
 * 특수기능에 만들어줘, 현재 포탈에서 설정된 **엣지와 vcenter 와 수집 서버**가 통신하는 것을
 * 파악해서 점검하고 점검하는 **로그를 최대한 많이 기록**해서 이슈가 있을때 분석하는 자료로".
 * 선택: **엣지↔엣지 상호 도달성 포함** · 로그 **3단 구조** · 점검 **단계별 전체**.
 *
 * ── 왜 '자동 발견' 인가 ──────────────────────────────────────────────────────
 * 점검 대상을 손으로 등록하게 하면 **등록을 안 한 링크가 조용히 빠진다** — 그러면 "모든 통신이
 * 정상" 이라는 화면이 거짓이 된다. 그래서 이미 있는 등록부에서 링크를 **계산**한다:
 *   · `collector/registry.js` 수집 서버(=엣지) 목록 → url·token
 *   · `vcenter/registry.js` vCenter 목록 → host·collectMode(direct|site)·remoteAgent
 * 등록부가 바뀌면 링크도 자동으로 바뀐다(손으로 맞추는 곳이 없다).
 *
 * ── 링크의 '측정 주체' 가 다르다 ────────────────────────────────────────────
 * ⚠⚠ 이것이 이 기능의 핵심 제약이다. 중앙에서 측정할 수 있는 것은 **중앙이 나가는 방향**뿐이다:
 *   · `central→edge`      중앙이 엣지 포탈의 `/api/collector/export` 를 당긴다 → **중앙 측정**
 *   · `central→vcenter`   중앙이 direct vCenter 를 폴링한다                → **중앙 측정**
 *   · `edge→central`      엣지가 `/api/central/*` 로 push 한다             → **엣지만 측정 가능**
 *   · `edge→central-pull` 엣지가 설정을 당긴다(9종)                        → **엣지만 측정 가능**
 *   · `edge→vcenter`      site vCenter 는 엣지가 수집한다                  → **엣지만 측정 가능**
 *   · `edge→edge`         엣지 상호 도달성(사용자 선택)                     → **엣지만 측정 가능**
 * 엣지 측정분은 **엣지에 새 코드가 필요**하므로 구버전 엣지는 값이 없다 — 화면이 '버전 부족' 으로
 * 밝힌다(v2.548 `classifyEdges` 와 같은 판단). **빈 칸을 '정상' 으로 칠하지 않는다.**
 *
 * ⚠ 자격증명(토큰·비밀번호)은 링크 객체에 **담지 않는다**. 점검기가 필요할 때 등록부에서 직접
 *   읽는다 — 링크는 화면·DB·중앙↔엣지 전송을 오가므로 여기에 담으면 여러 경로로 샌다.
 */
const t = (v) => String(v ?? '').trim();

/** 링크 종류 — 이 목록이 계약이다(화면·DB·테스트가 같이 쓴다). */
export const LINK_KINDS = Object.freeze({
  'central->edge': {
    label: '중앙 → 엣지 포탈', by: 'central',
    desc: '중앙이 엣지 포탈의 /api/collector/export 를 당긴다(수집 토큰). 이 링크가 죽으면 그 법인 인벤토리가 중앙에서 낡는다.',
  },
  'central->vcenter': {
    label: '중앙 → vCenter', by: 'central',
    desc: '중앙이 직접 폴링하는 vCenter(collectMode=direct). TLS·인증서 만료까지 본다.',
  },
  'edge->central': {
    label: '엣지 → 중앙 push', by: 'edge',
    desc: '엣지가 /api/central/* 로 수집분을 올린다. 이 링크가 죽으면 중앙 화면이 조용히 낡는다(엣지는 정상으로 보인다).',
  },
  'edge->central-pull': {
    label: '엣지 → 중앙 설정 pull', by: 'edge',
    desc: '엣지가 중앙에서 설정을 당긴다(스토리지·PDU·SAN·svcmon·users·GPU·파트장애·VM계열·현재사용자 9종). 죽으면 중앙에서 바꾼 설정이 그 법인에 영원히 안 먹는다.',
  },
  'edge->vcenter': {
    label: '엣지 → vCenter', by: 'edge',
    desc: '엣지가 수집하는 vCenter(collectMode=site). 중앙에서는 닿을 수 없어 엣지만 측정할 수 있다.',
  },
  'edge->edge': {
    label: '엣지 ↔ 엣지', by: 'edge',
    desc: '엣지 상호 도달성(사용자 선택). 중계·우회 경로를 쓰는 현장에서 한쪽만 막히는 것을 잡는다.',
  },
});
export const KIND_KEYS = Object.freeze(Object.keys(LINK_KINDS));
/** 중앙이 직접 잴 수 있는 종류. */
export const CENTRAL_KINDS = Object.freeze(KIND_KEYS.filter((k) => LINK_KINDS[k].by === 'central'));
export const EDGE_KINDS = Object.freeze(KIND_KEYS.filter((k) => LINK_KINDS[k].by === 'edge'));

/**
 * URL → `{host, port, scheme}`. ⚠ 포트가 없으면 스킴 기본값을 쓴다(없으면 점검 대상이 빈다).
 * ⚠ 파싱 실패를 조용히 넘기지 않는다 — `bad` 를 돌려 화면이 '설정이 잘못됐다' 고 말하게 한다.
 */
export function parseTarget(urlStr) {
  const s = t(urlStr);
  if (!s) return { bad: 'url 이 비어 있습니다.' };
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    const scheme = u.protocol.replace(':', '').toLowerCase();
    const port = u.port ? Number(u.port) : (scheme === 'http' ? 80 : 443);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!host) return { bad: 'host 를 읽지 못했습니다.' };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { bad: `포트가 올바르지 않습니다(${u.port}).` };
    return { host, port, scheme, origin: `${scheme}://${u.hostname}${u.port ? `:${u.port}` : ''}` };
  } catch (e) { return { bad: `url 을 해석하지 못했습니다(${String(e?.message || e).slice(0, 60)}).` };
  }
}

/** 링크 id — **안정적**이어야 한다(DB 기본키이고 이력이 이어진다). */
export function linkIdOf(kind, from, to) {
  return `${kind}|${t(from) || '-'}|${t(to) || '-'}`;
}

/**
 * 엣지↔엣지 짝. ⚠ **전량은 만들지 않는다** — 28곳이면 28×27=756 방향이고 주기마다 그만큼
 * 나가면 그 자체가 사고다. `pairs` 설정(명시 짝)이 있으면 그것만, 없으면 **빈 배열**이다
 * (자동으로 전량을 켜지 않는다 — 사용자가 고른 짝만).
 * @param {Array<{from:string,to:string}>} pairs
 */
export function edgePairs(pairs = [], agents = []) {
  const known = new Set(agents.map((a) => t(a)).filter(Boolean));
  const out = [];
  const seen = new Set();
  for (const p of pairs || []) {
    const from = t(p?.from); const to = t(p?.to);
    if (!from || !to || from === to) continue;
    const key = `${from}|${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      from, to,
      // 등록부에 없는 이름은 **버리지 않고 표시한다** — 이름이 바뀐 것 자체가 진단이다.
      unknownFrom: known.size > 0 && !known.has(from),
      unknownTo: known.size > 0 && !known.has(to),
    });
  }
  return out;
}

/**
 * 링크 전체를 계산한다.
 *
 * @param {object} p
 * @param {Array} p.collectors  `listCollectors()`(비밀 제거본이어도 된다 — url·name 만 쓴다)
 * @param {Array} p.vcenters    `listVcenters()`
 * @param {Array} p.pairs       엣지↔엣지 짝(설정)
 * @param {object} p.settings   `loadLinkCheckSettings()`
 * @returns {{links:Array, counts:object, problems:Array}}
 */
export function buildLinks({ collectors = [], vcenters = [], pairs = [], settings = {} } = {}) {
  const links = [];
  const problems = [];
  const on = (kind) => settings.kinds?.[kind] !== false;   // 기본 켜짐(명시 false 만 끈다)

  const agents = [];
  for (const c of collectors) {
    const name = t(c.name) || t(c.id);
    if (!name) continue;
    agents.push(name);
    const enabled = c.enabled !== false;
    const tg = parseTarget(c.url);
    if (tg.bad) {
      // ⚠ 잘못된 설정을 조용히 빼지 않는다 — 그러면 '전부 정상' 이라는 거짓이 된다.
      problems.push({ kind: 'central->edge', from: 'central', to: name, reason: tg.bad });
      continue;
    }
    if (on('central->edge')) {
      links.push({
        id: linkIdOf('central->edge', 'central', name),
        kind: 'central->edge', by: 'central', from: 'central', to: name,
        host: tg.host, port: tg.port, scheme: tg.scheme, origin: tg.origin,
        path: '/api/collector/export', auth: 'collector-token',
        enabled, agent: name, note: t(c.note) || '',
      });
    }
    // 엣지가 재는 방향 — **중앙은 이 링크를 직접 못 잰다**(위 머리말). 링크는 만들고 값은 엣지가 채운다.
    if (on('edge->central')) {
      links.push({
        id: linkIdOf('edge->central', name, 'central'),
        kind: 'edge->central', by: 'edge', from: name, to: 'central',
        path: '/api/central/health-probe', auth: 'central-token', enabled, agent: name,
      });
    }
    if (on('edge->central-pull')) {
      links.push({
        id: linkIdOf('edge->central-pull', name, 'central'),
        kind: 'edge->central-pull', by: 'edge', from: name, to: 'central',
        path: '/api/central/storage-config', auth: 'central-token', enabled, agent: name,
      });
    }
  }

  for (const v of vcenters) {
    const id = t(v.id);
    if (!id) continue;
    const enabled = v.enabled !== false;
    const tg = parseTarget(v.host);
    const site = t(v.collectMode) === 'site';
    const kind = site ? 'edge->vcenter' : 'central->vcenter';
    if (tg.bad) { problems.push({ kind, from: site ? (t(v.remoteAgent) || '(엣지 미지정)') : 'central', to: id, reason: tg.bad }); continue; }
    if (!on(kind)) continue;
    links.push({
      id: linkIdOf(kind, site ? (t(v.remoteAgent) || 'edge') : 'central', id),
      kind, by: site ? 'edge' : 'central',
      from: site ? (t(v.remoteAgent) || '') : 'central', to: id,
      host: tg.host, port: tg.port, scheme: tg.scheme, origin: tg.origin,
      path: '/sdk', auth: 'vcenter-cred',
      enabled, vcenterId: id, vcenterName: t(v.name) || id,
      agent: site ? t(v.remoteAgent) : '',
      // site 인데 담당 엣지가 비어 있으면 **누가 재야 하는지 모른다** — 그 사실을 밝힌다.
      ...(site && !t(v.remoteAgent) ? { unassigned: true } : {}),
    });
    if (site && !t(v.remoteAgent)) {
      problems.push({ kind, from: '(엣지 미지정)', to: id, reason: 'collectMode=site 인데 담당 엣지(remoteAgent)가 비어 있습니다 — 누가 수집·점검하는지 알 수 없습니다.' });
    }
  }

  if (on('edge->edge')) {
    for (const p of edgePairs(pairs, agents)) {
      links.push({
        id: linkIdOf('edge->edge', p.from, p.to),
        kind: 'edge->edge', by: 'edge', from: p.from, to: p.to,
        path: '/api/health', auth: 'none', enabled: true, agent: p.from,
        ...(p.unknownFrom ? { unknownFrom: true } : {}), ...(p.unknownTo ? { unknownTo: true } : {}),
      });
      if (p.unknownFrom || p.unknownTo) {
        problems.push({ kind: 'edge->edge', from: p.from, to: p.to, reason: '등록부에 없는 엣지 이름입니다 — 이름이 바뀌었거나 등록이 삭제됐습니다.' });
      }
    }
  }

  const counts = { total: links.length, byKind: {}, byBy: { central: 0, edge: 0 }, disabled: 0, problems: problems.length };
  for (const l of links) {
    counts.byKind[l.kind] = (counts.byKind[l.kind] || 0) + 1;
    counts.byBy[l.by] += 1;
    if (!l.enabled) counts.disabled += 1;
  }
  return { links, counts, problems };
}

/** 응답용 — 링크에는 비밀이 없지만 규약으로 한 번 더 거른다(새 필드가 들어와도 새지 않게). */
const PUBLIC_KEYS = Object.freeze(['id', 'kind', 'by', 'from', 'to', 'host', 'port', 'scheme', 'origin',
  'path', 'auth', 'enabled', 'agent', 'vcenterId', 'vcenterName', 'note', 'unassigned', 'unknownFrom', 'unknownTo']);
export function publicLink(l = {}) {
  const out = {};
  for (const k of PUBLIC_KEYS) if (l[k] !== undefined) out[k] = l[k];
  return out;
}
