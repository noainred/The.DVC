/**
 * idrac/scanSite.js — 서버 IP → 그 IP 를 포함하는 iDRAC 스캔 대역(v2.660).
 *
 * 두 용도가 **같은 판정**을 쓴다(판정 두 벌 금지):
 *  ① iDRAC 통합 추이의 '데이터센터' 선택 = 스캔 대역 이름(`service`) — 사용자 선택(법인 아래 사이트 필드가 없다).
 *  ② 서버 분석의 법인 귀속 보강 — 법인이 빈 물리 서버를 **그 IP 를 스캔한 대역의 에이전트가 속한 데이터센터**로
 *     분류한다(사용자 요청 "미 가상화 물리서버도 idrac scan 할때 사용한 agent 가 속한 데이터 센터로 분류").
 *
 * 정직성:
 *  · 대역을 **펼치지 않는다** — [lo, hi] 수 구간으로만 비교한다(/16 같은 넓은 대역을 수만 개로 펼치지 않게).
 *  · 여러 대역이 겹쳐 **다른 법인**을 가리키면 귀속하지 않는다(`ambiguous`) — 어느 쪽인지 지어내지 않는다.
 *  · 대역 해석은 idrac/iprange.js 와 같은 문법(단일 · a-b · a-짧은끝 · CIDR)이다. CIDR 은 스캔처럼 네트워크·
 *    브로드캐스트를 빼지만, 판정 목적상 전 구간을 포함해도 결과가 같다(그 두 주소에는 iDRAC 이 없다).
 */
import { ipToNum } from '../util/ipv4.js';

/** 등록 host(스킴·포트·경로 포함 가능) → IPv4 숫자 | null. 이름 등록은 null(DNS 를 보지 않는다). */
export function hostIpNum(host) {
  let s = String(host ?? '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split('/')[0];
  const colon = s.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(s.slice(colon + 1))) s = s.slice(0, colon);
  if (!/^[0-9.]+$/.test(s)) return null;
  return ipToNum(s);
}

/** 대역 토큰 하나 → [lo, hi] | null. */
export function rangeSpan(token) {
  const t = String(token ?? '').split('#')[0].trim();
  if (!t) return null;
  if (t.includes('/')) {
    const [base, bits] = t.split('/');
    const b = ipToNum(base.trim());
    if (b == null || !/^\d+$/.test(String(bits).trim())) return null;
    const k = Number(bits);
    if (k < 0 || k > 32) return null;
    const mask = k === 0 ? 0 : (0xffffffff << (32 - k)) >>> 0;
    const lo = (b & mask) >>> 0;
    return [lo, (lo + 2 ** (32 - k) - 1) >>> 0];
  }
  if (t.includes('-')) {
    const [aRaw, bRaw] = t.split('-').map((x) => x.trim());
    const a = ipToNum(aRaw);
    if (a == null || !bRaw) return null;
    let b = null;
    if (bRaw.includes('.')) b = ipToNum(bRaw);
    else if (/^\d+$/.test(bRaw) && Number(bRaw) <= 255) b = ((a & 0xffffff00) | Number(bRaw)) >>> 0;
    if (b == null || b < a) return null;
    return [a, b];
  }
  const n = ipToNum(t);
  return n == null ? null : [n, n];
}

/**
 * 스캔 대역 엔트리 → 색인(순수). entries: [{ id, datacenterId, service, ranges, agent }].
 * agentDc(agent) → 그 에이전트(수집 서버)가 속한 DataCenter id('' = 모름). 없으면 엔트리의 법인을 쓴다.
 */
export function buildScanSiteIndex(entries, { agentDc = () => '' } = {}) {
  const spans = [];
  for (const e of entries || []) {
    if (!e || typeof e !== 'object') continue;
    const agent = String(e.agent || '').trim();
    const local = !agent || agent === '__local__';
    const dcByAgent = local ? '' : String(agentDc(agent) || '').trim();
    const entryDc = String(e.datacenterId || '').trim();
    const site = String(e.service || '').trim() || '(대역 이름 없음)';
    for (const tok of (Array.isArray(e.ranges) ? e.ranges : [])) {
      for (const part of String(tok || '').split(/[\n,]/)) {
        const sp = rangeSpan(part);
        if (!sp) continue;
        spans.push({ lo: sp[0], hi: sp[1], entryId: String(e.id || ''), site, agent: local ? '' : agent,
          datacenterId: dcByAgent || entryDc, dcSource: dcByAgent ? 'agent' : 'range' });
      }
    }
  }
  return spans;
}

/**
 * IP 숫자 → 포함 대역들. onlyDc 를 주면 그 법인 대역만 본다.
 * @returns {{match:object|null, ambiguous:boolean, candidates:object[]}}
 */
export function scanSiteOf(ipNum, index, { onlyDc = '' } = {}) {
  if (ipNum == null || !Array.isArray(index)) return { match: null, ambiguous: false, candidates: [] };
  const hits = index.filter((x) => ipNum >= x.lo && ipNum <= x.hi && (!onlyDc || x.datacenterId === onlyDc));
  if (!hits.length) return { match: null, ambiguous: false, candidates: [] };
  const dcs = new Set(hits.map((x) => x.datacenterId));
  if (dcs.size > 1) return { match: null, ambiguous: true, candidates: hits };
  // 같은 법인 안에서 대역이 겹치면 **가장 좁은 대역**(더 구체적인 서비스)을 쓴다.
  const best = hits.slice().sort((a, b) => (a.hi - a.lo) - (b.hi - b.lo) || a.site.localeCompare(b.site))[0];
  return { match: best, ambiguous: false, candidates: hits };
}

/** 서버 목록에서 사이트 이름(통합 추이의 '데이터센터' 선택). 대역 밖이면 '(스캔 대역 밖)'. */
export const SITE_OUTSIDE = '(스캔 대역 밖)';
export function siteNameOf(server, index) {
  const r = scanSiteOf(hostIpNum(server?.host), index, { onlyDc: String(server?.datacenterId || '') });
  if (r.match) return r.match.site;
  // 법인 대역에 없으면 법인 제한 없이 한 번 더(법인이 비어 있는 서버) — 여러 법인이면 밝힌다.
  const any = scanSiteOf(hostIpNum(server?.host), index);
  if (any.match) return any.match.site;
  return any.ambiguous ? '(대역 겹침)' : SITE_OUTSIDE;
}
