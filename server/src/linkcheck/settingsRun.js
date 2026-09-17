/**
 * linkcheck/settingsRun.js — 설정 대상 하나를 **단계별로** 점검한다(v2.553).
 *
 * DNS·TCP·TLS·HTTP 는 `checks.js`(v2.552), SSH·SMTP·포트는 `protocols.js` 를 쓴다 —
 * 단계별 계측·SSRF 핀·본문 조각 상한을 **복제하지 않는다**(CLAUDE.md '코어는 하나다').
 *
 * ⚠⚠ **장비 계정으로 로그인하지 않는다**(사용자 선택 '도달성만'). 포탈이 발급한 자기 토큰
 *   (`set:collector`·`set:central`)만 예외이고, 그것은 장비 계정이 아니라 잠금 위험이 없다.
 * ⚠ **던지지 않는다** — 한 대상의 예외가 주기를 죽이면 나머지가 조용히 사라진다.
 */
import { stepDns, stepTcp, stepTls, stepHttp } from './checks.js';
import { stepSsh, stepSmtp, stepPortOnly } from './protocols.js';
import { judge, summaryText } from './phases.js';
import { SETTING_KINDS } from './settingsKinds.js';
import { identityIssue } from '../collector/registry.js';

const t = (v) => String(v ?? '').trim();

/** 무인증 HTTP 점검의 정체 대조(제품 확인). 확인할 수 없으면 `null` — 지어내지 않는다. */
export function identityCheckerFor(kind, target = {}, ctx = {}) {
  const id = t(SETTING_KINDS[kind]?.probe?.identity);
  if (!id) return null;
  if (id === 'vcenter') {
    return { raw: (body) => (/urn:vim25|vimService|versionId/i.test(String(body || '')) ? null : 'vCenter 의 서비스 버전 문서가 아닙니다 — 이 주소·포트가 vCenter 가 아닐 수 있습니다(포트포워딩 확인).') };
  }
  if (id === 'redfish') {
    return { json: (j) => (t(j?.RedfishVersion) || t(j?.['@odata.id']) ? null : 'Redfish 서비스 루트가 아닙니다 — 이 주소가 iDRAC 이 아닐 수 있습니다.') };
  }
  if (id === 'edge') {
    const c = ctx.collectors?.get?.(t(target.ref)) || ctx.collectors?.get?.(t(target.name)) || null;
    if (!c) return null;
    const others = (ctx.collectorIds || []).filter((x) => x !== t(c.id));
    return { json: (j) => { const iss = identityIssue({ id: t(c.id), name: t(c.name) }, j, others); return iss ? iss.reason : null; } };
  }
  if (id === 'central') {
    const agent = t(ctx.agentName);
    return {
      json: (j) => {
        const bound = t(j?.yourAgent);
        if (!bound || !agent) return null;
        return bound.toLowerCase() === agent.toLowerCase() ? null
          : `중앙은 이 토큰을 엣지 '${bound}' 의 것으로 봅니다(이 엣지는 '${agent}') — 토큰이 뒤바뀌었습니다.`;
      },
    };
  }
  return null;
}

/** 포탈 자기 토큰 헤더. **장비 계정은 절대 넣지 않는다.** */
function headersFor(kind, target, ctx) {
  const spec = SETTING_KINDS[kind];
  const h = { Accept: 'application/json, application/xml, text/xml, */*' };
  if (spec?.probe?.authMode !== 'token') return { headers: h };
  if (kind === 'set:collector') {
    const c = ctx.collectors?.get?.(t(target.ref)) || ctx.collectors?.get?.(t(target.name)) || null;
    const tok = t(c?.token);
    if (!tok) return { skip: '이 수집 서버에 토큰이 저장돼 있지 않습니다 — 설정 › 수집 서버에서 토큰을 넣으세요.' };
    return { headers: { ...h, 'X-Collector-Token': tok } };
  }
  if (kind === 'set:central') {
    const tok = t(ctx.centralToken);
    if (!tok) return { skip: '이 엣지에 중앙 토큰(CENTRAL_TOKEN)이 설정돼 있지 않습니다.' };
    return { headers: { ...h, 'X-Central-Token': tok, 'X-Agent-Name': t(ctx.agentName) } };
  }
  return { headers: h };
}

/**
 * 대상 하나 점검.
 * @param {object} target `buildSettingsTargets()` 의 항목
 * @param {object} p `{ timeouts, ctx }`
 */
export async function runSettingsTarget(target = {}, { timeouts = {}, ctx = {} } = {}) {
  const ts = Date.now();
  const kind = t(target.kind);
  const spec = SETTING_KINDS[kind];
  if (!spec) return { target, ts, skipped: `점검 방법이 정의되지 않은 종류입니다(${kind || '미지정'}).` };
  if (target.bad) return { target, ts, skipped: `주소를 해석할 수 없습니다 — ${target.bad}` };
  if (target.enabled === false) return { target, ts, skipped: '이 대상이 비활성입니다(등록부에서 껐습니다).' };
  const host = t(target.host);
  const port = Number(target.port);
  if (!host || !Number.isInteger(port)) return { target, ts, skipped: '주소·포트를 읽지 못했습니다.' };

  const steps = {};
  steps.dns = await stepDns(host, { timeoutMs: timeouts.dnsMs });
  if (!steps.dns.ok) return finish(target, ts, steps, '');
  const ip = steps.dns.addrs[0];

  steps.tcp = await stepTcp(ip, port, { timeoutMs: timeouts.tcpMs });
  if (!steps.tcp.ok) return finish(target, ts, steps, '');

  const mode = t(spec.probe.mode);

  if (mode === 'tcp') {
    steps.port = stepPortOnly(steps.tcp, { note: spec.desc });
    return finish(target, ts, steps, '');
  }
  if (mode === 'ssh') {
    steps.ssh = await stepSsh(ip, port, { timeoutMs: timeouts.sshMs || timeouts.httpMs });
    return finish(target, ts, steps, '');
  }
  if (mode === 'smtp') {
    const secure = !!target.facts?.secure;
    steps.smtp = await stepSmtp(ip, port, { timeoutMs: timeouts.smtpMs || timeouts.httpMs, secure, servername: host });
    return finish(target, ts, steps, '');
  }

  // https 면 TLS 를 따로 재서 인증서를 읽는다(만료 예고가 이 기능의 큰 값이다).
  const https = t(target.scheme) !== 'http';
  if (https) {
    steps.tls = await stepTls(ip, port, host, { timeoutMs: timeouts.tlsMs });
    if (!steps.tls.ok) return finish(target, ts, steps, '');
  }
  if (mode === 'tls') return finish(target, ts, steps, '');

  // HTTP
  const hd = headersFor(kind, target, ctx);
  if (hd.skip) return { target, ts, skipped: hd.skip, steps };
  const base = `${https ? 'https' : 'http'}://${host}:${port}`;
  // ⚠ Data Plane 은 등록된 basePath 를 그대로 붙인다(v2.503 S-1 — 조립 주소가 진실이다).
  const pathPart = kind === 'set:dataplane'
    ? `${t(target.basePath) || ''}${t(target.facts?.basePath) || ''}` || '/'
    : (t(spec.probe.path) || '/');
  const url = `${base}${pathPart.startsWith('/') ? pathPart : `/${pathPart}`}`;
  const ident = identityCheckerFor(kind, target, ctx);
  const h = await stepHttp({
    url, ip, headers: hd.headers, timeoutMs: timeouts.httpMs,
    identify: ident?.json || null, identifyRaw: ident?.raw || null,
  });
  if (h.http) steps.http = h.http;
  if (h.auth) steps.auth = h.auth;
  if (h.identity) steps.identity = h.identity;

  /*
   * ⚠⚠ **무인증 점검에서 401/403 을 실패로 두지 않는다.** `stepHttp` 는 v2.552 규약대로
   *   401/403 을 `auth: {ok:false}` 로 가르는데, 그것은 **토큰을 보낸** 경우의 판정이다.
   *   여기서는 자격증명을 보내지 않았으므로 "서비스가 살아 있고 인증을 요구한다" = **도달 성공**이다.
   *   이 보정을 지우면 정상 장비 수십 대가 전부 '인증 실패' 로 보인다.
   */
  if (spec.probe.authMode === 'none' && steps.auth && steps.auth.ok === false) {
    const st = Number(steps.auth.status);
    if (st === 401 || st === 403) {
      steps.auth = { ok: true, ms: 0, status: st, note: '인증을 요구했습니다(자격증명을 보내지 않았으므로 정상 응답입니다).' };
    } else if (st === 404) {
      // 무인증 경로가 없는 제품일 수 있다 — 실패로 단정하지 않고 '도달은 했다' 로 둔다.
      steps.auth = { ok: true, ms: 0, status: st, note: '그 경로가 없습니다(무인증 확인 경로가 없는 제품일 수 있습니다 — 연결 자체는 됐습니다).' };
    }
  }
  return finish(target, ts, steps, url);
}

function finish(target, ts, steps, url) {
  const verdict = judge(steps);
  const link = { id: target.id, kind: target.kind, from: 'portal', to: t(target.name) || t(target.ref), host: t(target.host), port: Number(target.port) };
  return {
    target, ts, verdict, steps,
    summary: summaryText({ from: '포탈', to: t(target.name) || t(target.ref) }, verdict, steps),
    detail: { url, steps, target: { id: target.id, kind: target.kind, name: target.name, address: target.address, host: target.host, port: target.port, depth: target.depth } },
    link,
  };
}
