/**
 * linkcheck/run.js — 링크 하나를 **단계별로** 점검한다(v2.552).
 *
 * 사용자 선택: 점검 깊이 **'단계별 전체'** — DNS → TCP → TLS → HTTP → 인증 → 정체를 각각 재고
 * 어디서 막혔는지 기록한다. 이 모듈은 '어떤 URL·어떤 헤더·무엇으로 정체를 대조하는가' 를
 * 링크 종류별로 정하는 곳이고, 실제 네트워크는 `checks.js` 가 한다.
 *
 * ⚠⚠ **자격증명은 여기서 등록부를 직접 읽어 헤더에만 싣는다.** 링크 객체(`links.js`)에는 담지
 *   않는다 — 링크는 API 응답·DB·중앙↔엣지 전송을 오가므로 담으면 여러 경로로 샌다.
 * ⚠ **토큰이 없으면 '실패' 가 아니라 `skip`** 이다. 없는 것을 인증 실패로 세면 화면이 "토큰이
 *   거부됐습니다" 라고 말해 사용자가 멀쩡한 토큰을 의심한다(v2.548 '확인 불가' 규약).
 * ⚠ **중앙이 재는 것은 `by:'central'` 링크뿐**이다. 엣지가 재는 링크를 중앙에서 돌리면
 *   '중앙에서 안 닿는다' 를 그 링크의 상태로 기록하는 거짓이 된다(엣지는 닿는다).
 */
import { stepDns, stepTcp, stepTls, stepHttp } from './checks.js';
import { judge, summaryText } from './phases.js';
import { identityIssue } from '../collector/registry.js';

const t = (v) => String(v ?? '').trim();

/**
 * 링크 종류별 요청 사양. `ctx` 는 그 시점의 등록부 스냅샷이다.
 * @returns {{url:string, headers:object, identify?:Function, identifyRaw?:Function}|{skip:string}}
 */
export function specFor(link = {}, ctx = {}) {
  const kind = t(link.kind);
  const origin = t(link.origin) || (link.host ? `${t(link.scheme) || 'https'}://${link.host}:${link.port}` : '');
  /*
   * ⚠ 주소가 링크에 있어야 하는 종류와 **`ctx` 에서 오는 종류**(엣지→중앙: CENTRAL_URL)를 구분한다.
   *   구분하지 않고 여기서 일괄 거절하면 엣지→중앙 링크가 "등록 url 을 확인하세요" 라는 **틀린
   *   사유**로 건너뛰어진다(고칠 곳이 다른 데 있다고 말하는 것 — v2.549 '실패 원인을 한 문구로
   *   덮지 말 것' 계열).
   */
  const NEEDS_LINK_ORIGIN = ['central->edge', 'central->vcenter', 'edge->vcenter', 'edge->edge'];
  if (NEEDS_LINK_ORIGIN.includes(kind) && !origin) {
    return { skip: '점검할 주소가 없습니다(등록 url/host 를 확인하세요).' };
  }

  if (kind === 'central->edge') {
    const c = ctx.collectors?.get?.(t(link.to)) || null;
    const token = t(c?.token);
    if (!token) {
      // 토큰이 없으면 엣지가 403 을 준다 — 그것을 '인증 실패' 로 기록하면 원인을 거꾸로 말한다.
      return { skip: '이 수집 서버에 토큰이 저장돼 있지 않습니다 — 설정 › 수집 서버에서 토큰을 넣으세요.' };
    }
    const others = (ctx.collectorIds || []).filter((x) => x !== t(c?.id));
    return {
      // ⚠ `/export` 가 아니라 `/ping` 이다 — export 는 그 법인 인벤토리 전량이라 점검 주기마다
      //   당기면 그 자체가 부하다. 토큰·정체 확인에는 ping 이 충분하다.
      url: `${origin}/api/collector/ping`,
      headers: { Accept: 'application/json', 'X-Collector-Token': token },
      tag: t(c?.id) || t(link.to), // v2.613 EDGE2613-10: 데이터 흐름 지도가 같은 origin 엣지를 나누는 태그
      identify: (json) => {
        const iss = identityIssue({ id: t(c?.id), name: t(c?.name) }, json, others);
        return iss ? iss.reason : null;
      },
    };
  }

  if (kind === 'central->vcenter') {
    /*
     * ⚠⚠ **로그인하지 않는다.** `vimServiceVersions.xml` 은 인증 없이 받을 수 있고 그 vCenter 가
     *   실제로 vCenter 인지(= 포트포워딩이 다른 장비로 가지 않는지)를 확인해 준다. 점검이 5분마다
     *   로그인하면 세션 테이블을 채우고, 비밀번호가 바뀐 구간에서는 **계정을 잠근다**
     *   (`bulkRun.js` '자동 재시도 금지' 와 같은 사고).
     */
    return {
      url: `${origin}/sdk/vimServiceVersions.xml`,
      headers: { Accept: 'application/xml,text/xml,*/*' },
      identifyRaw: (body) => (/urn:vim25|vimService|versionId/i.test(String(body || ''))
        ? null
        : 'vCenter 의 서비스 버전 문서가 아닙니다 — 이 주소·포트가 vCenter 가 아닐 수 있습니다(포트포워딩 확인).'),
    };
  }

  if (kind === 'edge->edge') {
    return {
      url: `${origin}/api/health`,
      headers: { Accept: 'application/json' },
      identify: (json) => {
        const got = t(json?.agent);
        const want = t(link.to);
        if (!got || !want) return null;          // 구버전 엣지는 agent 가 없다 — 판정하지 않는다
        return got.toLowerCase() === want.toLowerCase()
          ? null
          : `이 주소에 응답한 엣지는 '${got}' 인데 점검 대상은 '${want}' 입니다 — 포트포워딩이 다른 엣지로 갑니다.`;
      },
    };
  }

  if (kind === 'edge->central' || kind === 'edge->central-pull') {
    const url = t(ctx.centralUrl);
    if (!url) return { skip: '이 엣지에 중앙 주소(CENTRAL_URL)가 설정돼 있지 않습니다.' };
    const token = t(ctx.centralToken);
    if (!token) return { skip: '이 엣지에 중앙 토큰(CENTRAL_TOKEN)이 설정돼 있지 않습니다.' };
    const agent = t(ctx.agentName);
    const base = url.replace(/\/+$/, '');
    const path = kind === 'edge->central'
      ? '/api/central/health-probe'
      : `/api/central/storage-config?agent=${encodeURIComponent(agent)}`;
    return {
      url: `${base}${path}`,
      headers: { Accept: 'application/json', 'X-Central-Token': token, 'X-Agent-Name': agent },
      identify: kind === 'edge->central'
        ? (json) => {
          // 중앙이 '이 토큰은 어느 엣지인지' 를 되돌려 준다 — 토큰이 남의 것이면 여기서 잡힌다.
          const bound = t(json?.yourAgent);
          if (!bound || !agent) return null;
          return bound.toLowerCase() === agent.toLowerCase()
            ? null
            : `중앙은 이 토큰을 엣지 '${bound}' 의 것으로 봅니다(이 엣지는 '${agent}') — 토큰이 뒤바뀌었습니다.`;
        }
        : null,
    };
  }

  if (kind === 'edge->vcenter') {
    return {
      url: `${origin}/sdk/vimServiceVersions.xml`,
      headers: { Accept: 'application/xml,text/xml,*/*' },
      identifyRaw: (body) => (/urn:vim25|vimService|versionId/i.test(String(body || ''))
        ? null
        : 'vCenter 의 서비스 버전 문서가 아닙니다 — 이 주소·포트가 vCenter 가 아닐 수 있습니다.'),
    };
  }

  return { skip: `점검 방법이 정의되지 않은 링크 종류입니다(${kind || '미지정'}).` };
}

/**
 * 링크 하나 점검. **던지지 않는다** — 모든 실패는 단계 객체로 돌려준다(한 링크의 예외가 주기를
 * 죽이면 나머지 링크가 조용히 사라진다).
 *
 * @param {object} link      `buildLinks()` 의 항목
 * @param {object} p
 * @param {object} p.timeouts `{dnsMs,tcpMs,tlsMs,httpMs}`
 * @param {object} p.ctx      `{collectors:Map, collectorIds:[], centralUrl, centralToken, agentName}`
 * @param {string} p.byNode   측정 주체('central' 또는 엣지 이름)
 */
export async function runLink(link = {}, { timeouts = {}, ctx = {}, byNode = 'central' } = {}) {
  const ts = Date.now();
  const steps = {};
  const spec = specFor(link, ctx);
  if (spec.skip) {
    /*
     * ⚠ `skip` 은 ok 도 fail 도 아니다. 하지만 DB 는 두 값만 담으므로 **점검하지 않은 것을
     *   적재하지 않는다** — 호출부(`poller`)가 `skipped` 로 따로 세고 화면이 개수를 밝힌다.
     */
    return { link, ts, skipped: spec.skip, byNode };
  }

  const url = new URL(spec.url);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port ? Number(url.port) : (url.protocol === 'http:' ? 80 : 443);

  steps.dns = await stepDns(host, { timeoutMs: timeouts.dnsMs });
  if (!steps.dns.ok) return finish(link, ts, steps, byNode, spec.url);
  const ip = steps.dns.addrs[0];

  steps.tcp = await stepTcp(ip, port, { timeoutMs: timeouts.tcpMs });
  if (!steps.tcp.ok) return finish(link, ts, steps, byNode, spec.url);

  if (url.protocol === 'https:') {
    steps.tls = await stepTls(ip, port, host, { timeoutMs: timeouts.tlsMs });
    if (!steps.tls.ok) return finish(link, ts, steps, byNode, spec.url);
  }

  const h = await stepHttp({
    url: spec.url, ip, headers: spec.headers, timeoutMs: timeouts.httpMs,
    identify: spec.identify || null, identifyRaw: spec.identifyRaw || null,
    tag: spec.tag || '',
  });
  if (h.http) steps.http = h.http;
  if (h.auth) steps.auth = h.auth;
  if (h.identity) steps.identity = h.identity;
  return finish(link, ts, steps, byNode, spec.url);
}

function finish(link, ts, steps, byNode, url) {
  const verdict = judge(steps);
  return {
    link, ts, verdict, steps, byNode,
    summary: summaryText(link, verdict, steps),
    // 상세는 실패·상태변화 때만 저장된다(db.js) — 여기서는 항상 만들어 두고 저장 여부는 DB 가 정한다.
    detail: { url, steps, link: { id: link.id, kind: link.kind, from: link.from, to: link.to, host: link.host, port: link.port } },
  };
}
