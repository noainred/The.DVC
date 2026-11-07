/**
 * routes/api/bmLogs.js — 리눅스 성능 7a단계 **로그 분석** API(설계 PROFILES §17 · 아트보드 Logs).
 *
 * 경로는 전부 `/tools/bm-usage/…`(도구 키 그대로 — auth/toolAccess.js 의 도구별 접근 집행을 탄다 · 새 첫 세그먼트를 만들지 않는다).
 *   · GET /tools/bm-usage/perf/:key/logs?range=1h|24h|7d — 서버 1대 상세(이 노드 DB 또는 엣지 대행 — 보관 없음)
 *   · GET /tools/bm-usage/logs — 함대(보드 KPI · 서버 표 · 공통 원인 후보): 이 노드 요약(메모리 — 주기마다 갱신) + 엣지 봉투 요약(정제본)
 * 권한 · 범위(형제 라우트와 같다 — security-api.md 7a): tools + vCenter scope — **조회 범위 교집합을 먼저** 자른다(applyScope · resolvePerfTarget) · 범위 밖 · 귀속 없음 · 없는 키는
 *   404(존재 은닉) · 미귀속 서버는 범위 계정에 보이지 않는다 · 응답 캐시(memoJson)는 범위 서명 + 역할 + 마지막 수집 + 엣지 보관분 세대.
 * ⚠⚠ 누가 무엇을 보나(보안 패널 — 관리자 판본 판정 `isAdminDetailUser` 하나 — addressMask.isAdminReq):
 *   · 관리자(데모 계정 제외): 실패 상위 IP · 계정 · 성공 로그인(계정 · IP) · sudo(계정 → 대상 명령 이름) · 계정 변경 · 집중 IP 와 보안 패턴의 가린 표본까지.
 *   · 그 밖(operator · viewer · 데모): 개수 · 분류 · 규칙은 같고 **IP 는 가림 토큰, 계정은 가림 토큰**(같은 값은 같은 토큰 — 반복은 보인다) · 보안 분류 패턴의 표본은 싣지 않는다
 *     (계정 · 명령이 원문에 있다) · 다른 분류 표본 · 연계 문구의 IPv4 · 등록부 주소는 공용 판정기(perfAddressMatcher — 엣지 대상 주소 포함)로 가린다.
 *   근거: 로그인 실패 IP · 계정은 공격 표면 정보(어떤 계정이 있고 누가 노리는가)라 포탈 로그인 실패 분석(security/loginFails)과 같은 등급으로 관리자에게만 원문을 준다.
 * ⚠ 포탈은 차단 · 계정 잠금을 하지 않는다 — 이 API 는 읽기만(쓰기 경로 없음 · 알림 규칙은 bmPerfOps.js 의 perf-rules 하나).
 */
import { requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { isAdminReq, maskedIdToken, scrubberFor } from '../../auth/addressMask.js';
import { currentTargets, bmUsageStatus } from '../../bmusage/poller.js';
import { memoJson, scopeKey } from './shared.js';
import { strOf } from '../../util/coercionTrap.js';
import { config } from '../../config.js';
import { resolvePerfTarget, bmAddressHosts, maskBmList, applyScope, perfAddressMatcher, noStoreFail } from './bmUsage.js';
import { CLASS_LABEL, LOG_CLASSES } from '../../bmusage/logs/rules.js';

const toolsPerm = requirePerm('tools');
const t = (v) => strOf(v, 4096).trim();
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const NOT_FOUND = Object.freeze({ __status: 404, ok: false, reason: '대상 서버를 찾지 못했습니다.' });
const RANGE_SET = new Set(['1h', '24h', '7d']);

export function depsOf(deps = {}) {
  return {
    currentTargets, bmAddressHosts,
    listEdgeBmUsage: async () => (await import('../../central/bmUsageEdgePull.js')).listEdgeBmUsage(),
    local: async (o) => (await import('../../bmusage/logs/view.js')).logViewFor(o),
    pull: async (agent, o) => (await import('../../central/bmLogsPull.js')).pullEdgeLogs(agent, o),
    summary: async () => (await import('../../bmusage/logs/view.js')).logSummaryNow(),
    ...deps,
  };
}

/**
 * 비관리자 판본의 계정 꼴 가림(순수 · 길이 한정) — 보안이 아닌 분류의 표본 · 서명에도 계정 이름이 실린다(GPDB ‘role "x" …’ · ‘user=x’ · audit acct="x" — 반증 F11).
 *   같은 값은 같은 토큰(maskedIdToken)이라 반복은 보인다. 보안 분류의 표본은 아예 싣지 않는다(아래).
 */
export function maskAccountForms(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/\b(user|role|acct|for user)( ?= ?| )"([^"<>]{1,64})"/g, (_m, k, sep, v) => `${k}${sep}"${maskedIdToken(v)}"`)
    .replace(/\b(user|ruser|acct|USER)=([^\s,;"'<>]{1,64})/g, (_m, k, v) => `${k}=${maskedIdToken(v)}`);
}

/** 비관리자 판본(순수) — 보안 상위 · 집중 IP · 계정은 가림 토큰 · 보안 표본 제외 · 그 밖 표본 · 서명 · 연계 문구는 주소 판정기 + IPv4 토큰 + 계정 꼴 토큰. */
export function maskLogView(body, scrub = (s) => s) {
  if (!body || typeof body !== 'object') return body;
  const tok = (v) => (v ? maskedIdToken(String(v)) : v);
  const clean = (s) => (typeof s === 'string' ? maskAccountForms(scrub(s)).replace(IPV4_RE, (ip) => maskedIdToken(ip)) : s);
  const sec = { ...(body.security || {}) };
  for (const k of ['fail_ip', 'root']) if (Array.isArray(sec[k])) sec[k] = sec[k].map((x) => ({ ...x, item: tok(x.item) }));
  for (const k of ['fail_user', 'sudofail']) if (Array.isArray(sec[k])) sec[k] = sec[k].map((x) => ({ ...x, item: tok(x.item) }));
  // ok = ‘계정 IP’ · sudo = ‘계정 → 대상 명령’ · acct = ‘동작 계정’ · avc = ‘프로세스 · 클래스’(계정 없음 — 그대로)
  if (Array.isArray(sec.ok)) sec.ok = sec.ok.map((x) => ({ ...x, item: String(x.item || '').split(' ').map((w, i) => (i < 2 && w ? tok(w) : w)).join(' ') }));
  if (Array.isArray(sec.sudo)) sec.sudo = sec.sudo.map((x) => { const [u, , to, cmd] = String(x.item || '').split(' '); return { ...x, item: `${tok(u)} → ${tok(to)}${cmd ? ` ${cmd}` : ''}` }; });
  if (Array.isArray(sec.acct)) sec.acct = sec.acct.map((x) => { const [op, who] = String(x.item || '').split(' '); return { ...x, item: `${op}${who ? ` ${tok(who)}` : ''}` }; });
  if (Array.isArray(sec.bursts)) sec.bursts = sec.bursts.map((b) => ({ ...b, ip: tok(b.ip) }));
  const patterns = (Array.isArray(body.patterns) ? body.patterns : []).map((p) => {
    const corr = p.corr ? { ...p.corr, changes: (p.corr.changes || []).map((e) => ({ ...e, item: clean(e.item) })) } : p.corr;
    if (p.cls === 'sec') return { ...p, tmpl: clean(p.tmpl), samples: [], samplesHidden: true, corr };
    return { ...p, tmpl: clean(p.tmpl), samples: (p.samples || []).map((x) => ({ ...x, text: clean(x.text) })), corr };
  });
  return { ...body, security: sec, patterns, addressHidden: true, secHidden: true };
}

/** GET /tools/bm-usage/perf/:key/logs */
export async function bmLogsRead(req, snap, deps = {}) {
  const D = depsOf(deps);
  const allowed = scopedVcenterIds(req.user, snap);   // ⚠ 범위 교집합 먼저
  const isAdmin = isAdminReq(req);
  const key = t(req.params.key);
  if (!key) return { __status: 400, ok: false, reason: 'key 가 필요합니다.' };
  const found = await resolvePerfTarget(req, D, { allowed, isAdmin, key });
  if (!found || found.denied) return NOT_FOUND;
  const range = RANGE_SET.has(String(req.query?.range)) ? String(req.query.range) : '24h';
  let res;
  if (found.via === 'local') res = await D.local({ key: found.realKey, range });
  else {
    const p = await D.pull(found.agent, { key: found.realKey, range });
    res = p.ok ? p.body : { ok: false, kind: p.kind, reason: p.reason };
  }
  if (!res || typeof res !== 'object') return { __status: 500, ok: false, reason: '응답이 없습니다.' };
  const out = { ...res, key, via: found.via, ...(found.via === 'edge' ? { agent: found.agent } : {}) };
  if (!out.ok && found.via === 'edge') return noStoreFail(out);
  if (!out.ok) return { __status: 503, ...out };
  if (isAdmin) return out;
  const tg = await D.currentTargets().catch(() => ({ targets: [] }));
  const { hosts } = await perfAddressMatcher(D, tg);
  return maskLogView(out, scrubberFor(hosts));
}

/** GET /tools/bm-usage/logs — 함대(이 노드 + 엣지 봉투). 범위 계정은 자기 법인 것만 · 비관리자는 주소인 키 · 이름 · 표본을 가린다. */
export async function bmLogsFleet(req, snap, deps = {}) {
  const D = depsOf(deps);
  const allowed = scopedVcenterIds(req.user, snap);
  const isAdmin = isAdminReq(req);
  const tg = await D.currentTargets().catch(() => ({ targets: [] }));
  const byKey = new Map((tg.targets || []).map((x) => [x.key, x]));
  const rows = []; const nodes0 = [];
  // ⚠ 범위 계정에는 **자기 범위 대상이 보이는 노드만**(반증 F10 — /tools/bm-usage/edges 의 v2.600 AUTHZ-2600-07 규약과 같다: 엣지 이름 · 상태 · 시각도 다른 법인 운영 정보다).
  const inScope = (list) => !allowed || (list || []).some((x) => x && allowed.has(String(x.vcenterId || '')));
  const sum = await D.summary().catch(() => null);
  const agent = config.agent?.name || '';
  const localSeen = inScope(tg.targets);
  if (Array.isArray(sum?.list)) {
    for (const s of sum.list) { const x = byKey.get(s.key); if (x) rows.push({ ...s, name: x.name || x.key, vcenterId: x.vcenterId || '', via: 'local', agent }); }
    nodes0.push({ seen: localSeen, n: { agent, via: 'local', state: 'ok', at: sum.at } });
  } else if (tg.targets?.length) nodes0.push({ seen: localSeen, n: { agent, via: 'local', state: sum?.error || 'none' } });
  for (const rec of await D.listEdgeBmUsage().catch(() => [])) {
    const sn = rec?.snap;
    const seen = inScope(sn?.targets);
    if (!sn) { nodes0.push({ seen, n: { agent: rec?.agent, via: 'edge', state: 'none' } }); continue; }
    if (!Number.isInteger(sn.logsVer)) { nodes0.push({ seen, n: { agent: rec.agent, via: 'edge', state: 'old-version', snapAt: rec.snapAt || null } }); continue; }
    const en = new Map((sn.targets || []).map((x) => [String(x.key), x]));
    if (!Array.isArray(sn.logSummary)) { nodes0.push({ seen, n: { agent: rec.agent, via: 'edge', state: 'no-cycle', snapAt: rec.snapAt || null } }); continue; }
    nodes0.push({ seen, n: { agent: rec.agent, via: 'edge', state: 'ok', snapAt: rec.snapAt || null, ...(sn.logSummaryDropped ? { dropped: sn.logSummaryDropped } : {}) } });
    for (const s of sn.logSummary) { const x = en.get(s.key); if (x) rows.push({ ...s, name: x.name || x.key, vcenterId: x.vcenterId || '', via: 'edge', agent: rec.agent, snapAt: rec.snapAt || null }); }
  }
  let list = applyScope(rows, allowed);   // ⚠ 범위 교집합 먼저(귀속 없는 서버는 범위 계정에 없다) — 공통 원인 후보도 이 목록으로만
  const { commonCauseCandidates, COMMON_WINDOW_MS } = await import('../../bmusage/logs/view.js');
  let common = commonCauseCandidates(list);
  // 분류별 ‘모름’ · ‘일부 출처만’ 서버 수(서버 요약의 cover — 못 읽은 서버를 0 · 정상 쪽에 넣지 않고 따로 센다 · 추가 수정)
  const coverCount = (cv) => Object.fromEntries(LOG_CLASSES.map((c) => [c, list.filter((r) => r.wasRead && r.cls?.[c]?.cover === cv).length]));
  const kpi = { servers: list.length, faultServers: list.filter((r) => (r.cls?.fault?.lines || 0) > 0).length, secHighServers: list.filter((r) => (r.secHigh || 0) > 0).length,
    byClass: Object.fromEntries(LOG_CLASSES.map((c) => [c, list.reduce((a, r) => a + (Number(r.cls?.[c]?.patterns) || 0), 0)])), unread: list.filter((r) => !r.wasRead).length, truncated: list.filter((r) => (r.trunc || 0) > 0).length,
    unknown: coverCount('none'), partial: coverCount('partial') };
  if (!isAdmin) {
    const { hosts, match } = await perfAddressMatcher(D, tg);
    const sc = scrubberFor(hosts);
    const clean = (s) => (typeof s === 'string' ? maskAccountForms(sc(s)).replace(IPV4_RE, (ip) => maskedIdToken(ip)) : s);
    list = maskBmList(list, match).map((r) => ({ ...r, top: (r.top || []).map((p) => ({ ...p, tmpl: clean(p.tmpl), sample: p.cls === 'sec' ? '' : clean(p.sample) })) }));
    common = common.map((c) => ({ ...c, servers: maskBmList(c.servers, match) }));
  }
  const nodes = nodes0.filter((x) => x.seen).map((x) => x.n);
  return { ok: true, at: Date.now(), kpi, classLabel: CLASS_LABEL, servers: list.slice(0, 2_000), common: common.slice(0, 50), commonWindowMs: COMMON_WINDOW_MS, nodes,
    ...(allowed ? { scoped: true, nodesOmitted: nodes0.length - nodes.length } : {}), ...(isAdmin ? {} : { addressHidden: true }) };
}

export function registerBmLogs(api) {
  const key = async (req) => {
    let e = 0; try { for (const r of (await import('../../central/bmUsageEdgePull.js')).listEdgeBmUsage()) e = Math.max(e, Number(r?.snapAt) || 0); } catch { e = 0; }
    let l = 0; try { l = Number((await import('../../bmusage/logs/run.js')).logCycleStatus()?.at) || 0; } catch { l = 0; }
    return `${scopeKey(req.user, store.get())}|${isAdminReq(req) ? 'a' : 'u'}|${bmUsageStatus().last?.at || 0}|l${l}|e${e}`;
  };
  api.get('/tools/bm-usage/logs', toolsPerm, async (req, res) => memoJson(req, res, 'bm-logs-fleet', (snap) => bmLogsFleet(req, snap), { extraKey: await key(req) }));
  api.get('/tools/bm-usage/perf/:key/logs', toolsPerm, async (req, res) => memoJson(req, res, 'bm-logs', (snap) => bmLogsRead(req, snap), { extraKey: await key(req) }));
}
