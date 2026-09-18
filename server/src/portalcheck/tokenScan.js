/**
 * portalcheck/tokenScan.js — '포탈 점검 › 토큰 점검' 의 **판정 코어**(순수, v2.560).
 *
 * 사용자 요청(2026-09-18): "특수기능에 '포탈 점검' 메뉴 · 첫 서브메뉴로 '토큰 점검' — ① 등록된
 * 모든 엣지/수집 서버의 모든 토큰을 수집해 **중복**이 있는지 ② 중앙에 저장된 토큰과 엣지에 저장된
 * 토큰으로 **통신이 되는지** ③ 중앙에 등록된 엣지의 토큰과 엣지에 저장된 토큰이 **동일한지**".
 *
 * ── 이 파일이 아는 것과 모르는 것(설계의 중심) ────────────────────────────────
 * 중앙이 **평문으로** 가진 토큰은 두 가지뿐이다:
 *   · `collectors.json` 의 수집 토큰(중앙→엣지 방향, `collector/registry.js`)
 *   · `portal.env` 의 공유 `CENTRAL_TOKEN`·`COLLECTOR_TOKEN`(`config.js`)
 * 엣지별 **개별 중앙 토큰은 SHA-256 해시만** 보관한다(`central/agentTokens.js:72` — "토큰 원문은
 * 저장하지 않고 … 발급 시 1회만 평문을 보여준다"). 그리고 엣지가 중앙으로 push 하는 설정 사본은
 * `*_TOKEN` 이 `REDACTED` 로 가려진다(v2.538 `util/envRedact.js`).
 * ⇒ 그래서 **요구 ③ 의 절반(중앙 토큰 방향)은 엣지가 스스로 보고하지 않으면 영원히 답할 수 없다.**
 *   이 파일은 '모른다' 를 '불일치' 로 뭉개지 않고 `unknown` 으로 남긴다.
 *
 * ⚠⚠ 평문·전체 해시를 **반환 객체에 담지 않는다**. 밖으로 나가는 것은 8자 지문(`short`)뿐이고,
 *   비교는 이 파일 안에서 전체 해시로 한다(`util/tokenFingerprint.js` 규칙 2·3).
 */

import { tokenFingerprintParts, tokenGroupKey, sameToken } from '../util/tokenFingerprint.js';

const norm = (s) => String(s ?? '').trim().toLowerCase();

/* ── 중복 종류 — 한 가지로 뭉개지 말 것 ─────────────────────────────────────── */

/**
 * 중복은 성격이 다르고 조치도 다르다. 같은 배지로 덮으면 **문서화된 기본 구성을 결함으로**
 * 보고하거나(공유 토큰) **권한 상승을 정상으로** 덮는다.
 */
export const DUP_KIND = Object.freeze({
  /** 공유 CENTRAL_TOKEN 이 전 엣지 공통 — 설계상 허용(agentTokens.js 머리말의 점진 이관 전제). */
  BY_DESIGN: 'by-design',
  /** 한 엣지 안에서 한 값이 두 용도(EDGE_MODE=all 기본값) — 문서화된 구성. */
  SAME_EDGE_MULTI_ROLE: 'same-edge-multi-role',
  /** ★ 서로 다른 엣지가 같은 수집 토큰 — 결함(한 곳이 털리면 다른 법인 데이터가 열린다). */
  CROSS_EDGE: 'cross-edge',
  /** ★★ 수집 토큰 == 공유 중앙 토큰 — 권한 상승(가장 위험). */
  COLLECTOR_EQUALS_CENTRAL: 'collector-equals-central',
  /** 배포 대상 파일의 값이 다른 엣지와 겹친다 — 재배포 시에만 터지는 지연 폭탄. */
  DEPLOY_TARGET: 'deploy-target',
});

/** 중복 종류별 등급. `fault`=결함 · `warn`=주의(설계상 허용이나 위험) · `info`=정보. */
export const DUP_GRADE = Object.freeze({
  [DUP_KIND.COLLECTOR_EQUALS_CENTRAL]: 'fault',
  [DUP_KIND.CROSS_EDGE]: 'fault',
  [DUP_KIND.DEPLOY_TARGET]: 'warn',
  [DUP_KIND.SAME_EDGE_MULTI_ROLE]: 'info',
  [DUP_KIND.BY_DESIGN]: 'info',
});

/* ── 토큰 모드 ─────────────────────────────────────────────────────────────── */

/**
 * 그 엣지가 중앙에 인증할 때 쓰는 토큰의 종류.
 * ⚠ `shared` 를 **결함으로 세지 않는다**(사용자 선택 v2.560: 전용 '주의' 칸). 문서화된 기본
 *   구성이지만 개별 토큰 전용 라우트가 전부 403 이라 **실제 기능 결손**이므로 정보도 아니다.
 */
export const TOKEN_MODE = Object.freeze({ AGENT: 'agent', SHARED: 'shared', NONE: 'none' });

/* ── 값 위생 ───────────────────────────────────────────────────────────────── */

/** 토큰 값의 형태 문제. 값 자체는 보지 않고 **길이·공백·문자셋**만 판정한다. */
export function hygieneOf(raw, { minLen = 16 } = {}) {
  const out = [];
  if (raw == null || raw === '') return out;           // 미설정은 위생 문제가 아니다(별도 축)
  const s = String(raw);
  if (/^\s|\s$/.test(s)) out.push('space');            // 붙여넣기 사고 최다 원인
  if (s.length < minLen) out.push('short');            // 추측 가능한 짧은 토큰
  if (/[\r\n]/.test(s)) out.push('newline');           // .env 한 줄이 깨진 경우
  if (/^["'].*["']$/.test(s)) out.push('quoted');      // 따옴표까지 값에 들어간 경우
  return out;
}

/* ── 엣지 버전 분류(v2.549·v2.552 규약) ───────────────────────────────────── */

/** 문자열 버전 비교 — `2.10.0 > 2.9.0`. 형식이 아니면 null(모르는 것을 낮게 보지 않는다). */
export function cmpVersion(a, b) {
  const pa = String(a ?? '').trim().split('.').map((x) => Number(x));
  const pb = String(b ?? '').trim().split('.').map((x) => Number(x));
  if (!pa.length || pa.some((x) => !Number.isFinite(x))) return null;
  if (!pb.length || pb.some((x) => !Number.isFinite(x))) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 엣지가 토큰 보고(`GET /api/collector/token-check`)를 할 수 있는가.
 * ⚠ 버전을 모르면 `unknown` 이다 — '구버전' 으로 단정하면 관리자가 엉뚱한 업그레이드를 한다.
 */
export function edgeReportCapability(version, minVersion) {
  const v = String(version ?? '').trim();
  if (!v) return 'unknown-version';
  const c = cmpVersion(v, minVersion);
  if (c == null) return 'unknown-version';
  return c >= 0 ? 'capable' : 'old-version';
}

/* ── 본체 ─────────────────────────────────────────────────────────────────── */

/**
 * 중앙 로컬 판정(왕복 0). 프로브·엣지 보고는 나중에 `mergeProbe`/`mergeEdgeReport` 로 덧댄다.
 *
 * @param {object} src 중앙 소스 — 전부 호출부가 읽어 넣는다(이 모듈은 파일을 읽지 않는다)
 * @param {Array<{id:string,name?:string,url?:string,token?:string,managed?:boolean,agent?:string,lastSelfRegisterAt?:number}>} src.collectors
 * @param {string} src.sharedCentralToken   config.central.token(공유)
 * @param {string} src.sharedCollectorToken config.collector.token(이 노드 자신의 수집 토큰)
 * @param {Array<{agent:string,createdAt?:number,lastUsedAt?:number}>} src.agentTokens  개별 토큰 메타(해시 비노출)
 * @param {Array<{agentName?:string,host?:string,centralToken?:string,collectorToken?:string}>} src.deployTargets
 * @param {string[]} src.knownAgents  중앙이 아는 엣지 이름(등록부 밖 소스까지 합집합)
 * @param {Record<string, {version?:string, lastPullAt?:number, ok?:boolean}>} src.status
 * @param {string} src.minEdgeVersion
 */
export function scanTokens(src = {}) {
  const collectors = Array.isArray(src.collectors) ? src.collectors : [];
  const agentTokens = Array.isArray(src.agentTokens) ? src.agentTokens : [];
  const deployTargets = Array.isArray(src.deployTargets) ? src.deployTargets : [];
  const known = Array.isArray(src.knownAgents) ? src.knownAgents : [];
  const status = src.status && typeof src.status === 'object' ? src.status : {};
  const minEdgeVersion = String(src.minEdgeVersion || '0.0.0');

  const agentTokenBy = new Map(agentTokens.map((t) => [norm(t.agent), t]));
  /*
   * ⚠ 배포 대상(`agent-deploy-targets.json`)의 엣지 이름 필드는 **`agentName`** 이다
   *   (`agent/deployRegistry.js:24-25` FIELDS). `name` 으로 읽으면 전 항목이 host 로 떨어져
   *   등록부와 **영원히 짝이 맞지 않고** '배포 대상 없음' 이라는 거짓이 된다.
   */
  const deployBy = new Map();
  for (const t of deployTargets) {
    const k = norm(t.agentName || t.name || t.host);
    if (k) deployBy.set(k, t);
  }

  /* ── 행 조립 — 등록부에서 계산한다(손 등록 금지) ─────────────────────────── */
  const rows = [];
  const seen = new Set();
  for (const c of collectors) {
    const key = norm(c.agent || c.id || c.name);
    if (!key) continue;
    seen.add(key);
    const st = status[c.id] || status[key] || {};
    const colFp = tokenFingerprintParts(c.token);
    const dep = deployBy.get(key) || null;
    const at = agentTokenBy.get(key) || null;
    rows.push({
      agent: c.agent || c.id || c.name || '',
      id: c.id || '',
      registered: true,
      url: c.url || '',
      managed: c.managed === true,
      lastSelfRegisterAt: Number(c.lastSelfRegisterAt) || null,
      // 수집 토큰(중앙→엣지) — 중앙이 평문을 가진 축
      collector: { ...colFp, hygiene: hygieneOf(c.token) },
      // 중앙 토큰(엣지→중앙) — 중앙은 해시만 가진다. 지문도 낼 수 없다.
      central: {
        mode: at ? TOKEN_MODE.AGENT : (src.sharedCentralToken ? TOKEN_MODE.SHARED : TOKEN_MODE.NONE),
        issuedAt: at?.createdAt || null,
        lastUsedAt: at?.lastUsedAt || null,
        /** ⚠ 중앙은 개별 토큰의 평문이 없어 **지문을 만들 수 없다** — 엣지 보고로만 채워진다. */
        expectedShort: null,
      },
      deploy: dep
        ? {
          present: true,
          collector: tokenFingerprintParts(dep.collectorToken).short || '',
          central: tokenFingerprintParts(dep.centralToken).short || '',
          // 저장소 대조(사용자 선택: 실제로 찔러보지 않는다)
          collectorMatchesRegistry: sameToken(dep.collectorToken, c.token),
        }
        : { present: false },
      version: st.version || '',
      lastPullAt: Number(st.lastPullAt) || null,
      capability: edgeReportCapability(st.version, minEdgeVersion),
      // 프로브·엣지 보고가 채운다
      probe: null,
      edge: null,
    });
  }

  /*
   * ⚠⚠ **등록부에 없는 엣지를 빠뜨리면 '전부 정상' 이라는 거짓이 된다** — 공유 토큰만 쓰고
   *   자기등록도 하지 않는 사이트는 행이 아예 생기지 않는다. 중앙이 아는 이름(6소스 합집합)에는
   *   있는데 `collectors.json` 에 없는 것을 `등록부 없음` 행으로 반드시 만든다.
   */
  for (const name of known) {
    const key = norm(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const at = agentTokenBy.get(key) || null;
    rows.push({
      agent: name,
      id: '',
      registered: false,
      url: '',
      managed: false,
      lastSelfRegisterAt: null,
      collector: { set: false, fp: '', short: '', len: 0, space: false, hygiene: [] },
      central: {
        mode: at ? TOKEN_MODE.AGENT : (src.sharedCentralToken ? TOKEN_MODE.SHARED : TOKEN_MODE.NONE),
        issuedAt: at?.createdAt || null,
        lastUsedAt: at?.lastUsedAt || null,
        expectedShort: null,
      },
      deploy: deployBy.has(key) ? { present: true, collector: '', central: '', collectorMatchesRegistry: null } : { present: false },
      version: '',
      lastPullAt: null,
      capability: 'unknown-version',
      probe: null,
      edge: null,
    });
  }

  /* ── 중복 그룹 — 전체 해시로 묶는다(정확 판정) ───────────────────────────── */
  const buckets = new Map(); // groupKey -> [{ scope, agent }]
  const put = (raw, scope, agent) => {
    const k = tokenGroupKey(raw);
    if (!k) return;
    if (!buckets.has(k)) buckets.set(k, { short: tokenFingerprintParts(raw).short, len: String(raw).length, members: [] });
    buckets.get(k).members.push({ scope, agent });
  };
  for (const c of collectors) put(c.token, 'collector', c.agent || c.id || '');
  put(src.sharedCentralToken, 'shared-central', '(공유)');
  put(src.sharedCollectorToken, 'self-collector', '(이 노드)');
  for (const t of deployTargets) {
    const k = norm(t.agentName || t.name || t.host);
    put(t.collectorToken, 'deploy-collector', k);
    put(t.centralToken, 'deploy-central', k);
  }

  const duplicates = [];
  for (const g of buckets.values()) {
    if (g.members.length < 2) continue;
    const scopes = new Set(g.members.map((m) => m.scope));
    const agents = new Set(g.members.filter((m) => m.scope === 'collector').map((m) => norm(m.agent)).filter(Boolean));
    /*
     * 엣지 축에 묶이는 이름들(공유 값·이 노드 자신은 제외) — '여러 엣지에 걸쳤는가' 를 본다.
     */
    const edgeAgents = new Set(g.members
      .filter((m) => m.scope !== 'shared-central' && m.scope !== 'self-collector')
      .map((m) => norm(m.agent)).filter(Boolean));
    let kind;
    if (scopes.has('collector') && scopes.has('shared-central')) kind = DUP_KIND.COLLECTOR_EQUALS_CENTRAL;
    else if (agents.size >= 2) kind = DUP_KIND.CROSS_EDGE;
    /*
     * ⚠⚠ **배포 대상 경고는 '여러 엣지에 걸쳤을 때' 만이다**(v2.560 스크린샷 판독에서 잡은 오탐):
     *   초판은 `deploy-*` 스코프가 있으면 전부 warn 으로 올렸다. 그런데 ① 배포 대상의 중앙 토큰이
     *   **공유 중앙 토큰과 같은 것**은 그것을 그 엣지에 심으려는 **의도된 구성**이고 ② 배포 대상의
     *   수집 토큰이 **그 엣지 등록값과 같은 것**도 정상이다(지금 값을 그대로 배포). 그 둘을 경고로
     *   올리면 화면이 정상 구성을 결함처럼 말한다 — 실측에서 실제로 그랬다.
     *   진짜 위험은 배포 대상 값이 **다른 엣지**의 값과 겹치는 것이다.
     */
    else if ((scopes.has('deploy-collector') || scopes.has('deploy-central')) && edgeAgents.size >= 2) kind = DUP_KIND.DEPLOY_TARGET;
    else if (scopes.has('shared-central') && (scopes.has('self-collector') || scopes.has('collector'))) kind = DUP_KIND.SAME_EDGE_MULTI_ROLE;
    else if (scopes.has('self-collector') && scopes.has('collector')) kind = DUP_KIND.SAME_EDGE_MULTI_ROLE;
    else kind = DUP_KIND.BY_DESIGN;
    duplicates.push({
      short: g.short, len: g.len, kind, grade: DUP_GRADE[kind] || 'info',
      members: g.members.map((m) => ({ scope: m.scope, agent: m.agent })),
    });
  }
  // 위험한 것을 먼저(화면이 상한으로 자를 때 결함이 밀려나지 않게)
  const order = { fault: 0, warn: 1, info: 2 };
  duplicates.sort((a, b) => (order[a.grade] - order[b.grade]) || a.short.localeCompare(b.short));

  return {
    rows: rows.sort((a, b) => String(a.agent).localeCompare(String(b.agent))),
    duplicates,
    sources: {
      collectors: collectors.length,
      agentTokens: agentTokens.length,
      deployTargets: deployTargets.length,
      knownAgents: known.length,
      sharedCentralSet: !!src.sharedCentralToken,
      sharedCollectorSet: !!src.sharedCollectorToken,
    },
    minEdgeVersion,
  };
}

/* ── 프로브 결과 해석(중앙→엣지) ──────────────────────────────────────────── */

/**
 * 도달성·동일성 상태 어휘. ⚠ **거부 코드를 한 문구로 덮지 않는다** — 조치가 전부 다르다.
 */
export const PROBE_STATE = Object.freeze({
  OK: 'ok',                       // 200 + 정체 일치 → 중앙 저장값 == 엣지 저장값이 **증명**됐다
  WRONG_EDGE: 'wrong-edge',       // 200 인데 다른 엣지가 응답(포워딩 되돌림)
  TOKEN_MISMATCH: 'token-mismatch', // 403 — 값 불일치 또는 헤더 누락
  EDGE_NO_TOKEN: 'edge-no-token', // 404 + 본문 reason — 엣지에 COLLECTOR_TOKEN 미설정
  OLD_ROUTE: 'old-route',         // 404/401 인데 본문이 없다 — 구버전 라우트 부재
  UNREACHABLE: 'unreachable',     // 연결 실패·NAT·미기동
  TIMEOUT: 'timeout',
  HTTP: 'http',                   // 그 밖의 상태코드
  SKIP_NO_TOKEN: 'skip-no-token', // 중앙에 저장된 토큰이 없다 — **인증 실패가 아니다**
  NOT_RUN: 'not-run',
});

/**
 * 프로브 1건의 상태 판정(순수). 호출부가 HTTP 결과를 이 형태로 넘긴다.
 * ⚠ 200 을 무조건 정상으로 칠하지 않는다 — `identity` 가 불일치면 `wrong-edge` 다.
 */
export function probeState({ hasToken, status, bodyReason, identityMismatch, errorKind } = {}) {
  if (!hasToken) return PROBE_STATE.SKIP_NO_TOKEN;
  if (errorKind === 'timeout') return PROBE_STATE.TIMEOUT;
  if (errorKind === 'unreachable') return PROBE_STATE.UNREACHABLE;
  const code = Number(status);
  if (code === 200) return identityMismatch ? PROBE_STATE.WRONG_EDGE : PROBE_STATE.OK;
  if (code === 403) return PROBE_STATE.TOKEN_MISMATCH;
  if (code === 404) return bodyReason ? PROBE_STATE.EDGE_NO_TOKEN : PROBE_STATE.OLD_ROUTE;
  if (code === 401) return PROBE_STATE.OLD_ROUTE;
  if (Number.isFinite(code)) return PROBE_STATE.HTTP;
  return PROBE_STATE.NOT_RUN;
}

/** 그 상태가 '요구 ③(값 동일성)' 에 주는 근거의 강도. */
export function identityEvidence(state) {
  if (state === PROBE_STATE.OK) return 'proven-same';        // 엣지 게이트가 전체 문자열 상수시간 비교다
  if (state === PROBE_STATE.TOKEN_MISMATCH) return 'differs-or-header';
  if (state === PROBE_STATE.EDGE_NO_TOKEN) return 'edge-unset';
  return 'unknown';
}

/* ── KPI — 칸이 겹치지 않아야 한다 ────────────────────────────────────────── */

/** 행 종합 상태. 네 칸은 **겹치지 않는다**(합계 = 정상+결함+주의+확인불가). */
export const ROW_STATE = Object.freeze({ OK: 'ok', FAULT: 'fault', WARN: 'warn', UNKNOWN: 'unknown' });

/** 프로브 상태 중 '결함' 으로 세는 것 — 조치가 명확하고 재시도해도 결과가 같은 것들. */
export const FAULT_PROBE_STATES = Object.freeze([
  PROBE_STATE.TOKEN_MISMATCH, PROBE_STATE.WRONG_EDGE, PROBE_STATE.EDGE_NO_TOKEN,
]);

/**
 * ⚠⚠ **행 상태 판정은 이 함수 하나가 소유한다**(CLAUDE.md '코어는 하나다'). KPI 개수와 표의 행
 *   색이 같은 기준을 써야 한다 — 두 곳에서 각자 판정하던 v2.560 초안은 `kpisOf` 가 공유 토큰을
 *   `unknown` 으로, 화면은 `warn` 으로 세어 **KPI 합계와 표의 색이 어긋났다**.
 *
 * ⚠ 점검을 돌리지 않은 행(`not-run`)은 **확인 불가**다 — 초록으로 칠하면 이 화면 최악의 거짓이다.
 * ⚠ `shared`(공유 토큰)는 결함이 아니라 **주의**다(사용자 선택 v2.560). 문서화된 기본 구성이지만
 *   개별 토큰 전용 라우트가 전부 403 이라 기능 결손이므로 정보도 아니다.
 */
export function rowStateOf(row) {
  const st = row?.probe?.state || PROBE_STATE.NOT_RUN;
  const fact = row?.edge?.fact || '';
  const hygiene = (row?.collector?.hygiene || []).length > 0;
  if (FAULT_PROBE_STATES.includes(st)) return ROW_STATE.FAULT;
  if (fact === EDGE_TOKEN_FACT.REJECTED || fact === EDGE_TOKEN_FACT.AGENT_WRONG_NAME) return ROW_STATE.FAULT;
  if (row?.edge?.collectorShortMatch === false) return ROW_STATE.FAULT;
  if (st === PROBE_STATE.OK) {
    if (hygiene) return ROW_STATE.WARN;
    if (fact === EDGE_TOKEN_FACT.SHARED || row?.central?.mode === TOKEN_MODE.SHARED) return ROW_STATE.WARN;
    if (row?.edge?.centralRole?.enabled || row?.centralRole?.kind === 'central-enabled') return ROW_STATE.WARN;
    if (row?.registered === false) return ROW_STATE.WARN;
    return ROW_STATE.OK;
  }
  if (st === PROBE_STATE.SKIP_NO_TOKEN || hygiene || row?.registered === false) return ROW_STATE.WARN;
  return ROW_STATE.UNKNOWN;
}

/** 행마다 `state` 를 붙인다 — 화면은 이 값을 **읽기만** 한다(판정 복제 금지). */
export function withRowStates(scan) {
  return { ...scan, rows: (scan?.rows || []).map((r) => ({ ...r, state: rowStateOf(r) })) };
}

/**
 * 프로브가 **실제로 HTTP 응답을 받은** 상태들 — 이것만 '측정했다' 고 말할 수 있다.
 * ⚠ `unreachable`·`timeout`·`skip-no-token`·`not-run` 은 측정이 아니다.
 */
export const ANSWERED_STATES = Object.freeze([
  PROBE_STATE.OK, PROBE_STATE.WRONG_EDGE, PROBE_STATE.TOKEN_MISMATCH,
  PROBE_STATE.EDGE_NO_TOKEN, PROBE_STATE.HTTP, PROBE_STATE.OLD_ROUTE,
]);

/**
 * KPI. **합계 = 정상 + 결함 + 주의 + 확인 불가** 항등식이 항상 성립한다.
 * ⚠ `sharedToken`·`dupFault` 는 **별도 축**이라 이 네 칸과 더하지 않는다(겹친다).
 * ⚠⚠ **정상률의 분모는 '응답을 받은 행' 이다**(v2.560 자체 검증에서 고친 결함): 초판은
 *   `ok + fault + warn` 을 측정분으로 썼는데, 값 위생(앞뒤 공백)만으로 `warn` 이 된 행은
 *   **네트워크 측정을 한 적이 없다**. 그래서 점검을 한 번도 누르지 않은 상태에서 `측정 1곳 ·
 *   정상률 0%` 라고 말했다 — '통신이 실패했다' 로 읽히는 **거짓**이다.
 *   분자는 `probe.state === 'ok'` 이므로 분자 ⊆ 분모가 구조적으로 보장된다.
 */
export function kpisOf(scan) {
  const rows = scan?.rows || [];
  const k = { total: rows.length, ok: 0, fault: 0, warn: 0, unknown: 0, sharedToken: 0, dupFault: 0 };
  let answered = 0; let probeOk = 0;
  for (const r of rows) {
    k[rowStateOf(r)] += 1;
    if (r.central?.mode === TOKEN_MODE.SHARED) k.sharedToken += 1;
    const st = r.probe?.state || PROBE_STATE.NOT_RUN;
    if (ANSWERED_STATES.includes(st)) answered += 1;
    if (st === PROBE_STATE.OK) probeOk += 1;
  }
  k.dupFault = (scan?.duplicates || []).filter((d) => d.grade === 'fault').length;
  k.measured = answered;
  k.probeOk = probeOk;
  k.okRate = answered > 0 ? Math.round((probeOk / answered) * 100) : null;
  return k;
}

/* ── 프로브·엣지 보고 병합 ─────────────────────────────────────────────────── */

/**
 * 프로브 결과를 행에 얹는다(순수 — 새 배열을 돌려준다).
 * ⚠ 행의 `agent` 로 맞춘다. 순서에 의존하지 말 것(예산 초과로 건너뛴 항목이 섞인다).
 */
export function mergeProbe(scan, probes = []) {
  const by = new Map(probes.filter(Boolean).map((p) => [norm(p.agent), p]));
  return {
    ...scan,
    rows: (scan?.rows || []).map((r) => {
      const p = by.get(norm(r.agent));
      if (!p) return r;
      return { ...r, probe: p.probe || null, centralRole: p.centralRole || null };
    }),
  };
}

/** 엣지 토큰 모드 — 자기보고의 `selfProbe` 가 말해 주는 **실측**이다(추정이 아니다). */
export const EDGE_TOKEN_FACT = Object.freeze({
  AGENT: 'agent',          // 중앙이 개별 토큰으로 해석했고 이름까지 일치 → 동일성 **증명**
  AGENT_WRONG_NAME: 'agent-wrong-name', // 개별 토큰인데 **다른 엣지 이름**으로 해석됐다(토큰 뒤바뀜)
  SHARED: 'shared',        // 공유 토큰 — 개별 토큰 전용 라우트가 전부 403
  REJECTED: 'rejected',    // 중앙이 거부 → 엣지 저장값이 중앙의 어느 토큰과도 다르다(확정)
  NOT_RUN: 'not-run',      // 자기확인을 돌리지 않았다
  UNKNOWN: 'unknown',      // 닿지 못함·형식 미상
});

/**
 * 엣지 자기보고(`central/tokenCheckPull.js` 의 `report`)를 행에 얹는다.
 *
 * ⚠ **저장 키(중앙이 아는 이름)와 엣지가 말한 이름이 다르면 그 사실 자체가 진단**이다 —
 *   한쪽으로 덮지 않고 `nameMismatch` 로 나란히 남긴다(v2.548 F5 · v2.549 규약).
 */
export function mergeEdgeReport(scan, reports = []) {
  const by = new Map(reports.filter(Boolean).map((x) => [norm(x.agent), x]));
  return {
    ...scan,
    rows: (scan?.rows || []).map((r) => {
      const rec = by.get(norm(r.agent));
      if (!rec) return r;
      const rep = rec.report || null;
      const said = rep ? String(rep.node?.agent || '') : '';
      const sp = rep?.selfProbe || null;
      let fact = EDGE_TOKEN_FACT.UNKNOWN;
      if (sp) {
        if (!sp.ran) fact = EDGE_TOKEN_FACT.NOT_RUN;
        else if (sp.kind === 'rejected') fact = EDGE_TOKEN_FACT.REJECTED;
        else if (sp.ok && sp.tokenMode === 'agent') {
          fact = norm(sp.yourAgent) === norm(r.agent) ? EDGE_TOKEN_FACT.AGENT : EDGE_TOKEN_FACT.AGENT_WRONG_NAME;
        } else if (sp.ok && sp.tokenMode === 'shared') fact = EDGE_TOKEN_FACT.SHARED;
      }
      /*
       * 수집 토큰 지문 대조. ⚠ **정직 기록**: 중앙의 수집 토큰이 틀리면 이 보고 자체를 받을 수
       *   없다(같은 토큰으로 당긴다) — 그래서 이 값이 존재하는 경우는 대개 일치다. 불일치가
       *   보이는 경우는 등록부에 **여러 항목**이 있거나 보고가 이전 값인 때다.
       */
      const centralShort = r.collector?.short || '';
      const edgeShort = rep?.tokens?.collector?.short || '';
      const collectorShortMatch = (centralShort && edgeShort) ? centralShort === edgeShort : null;
      return {
        ...r,
        edge: {
          at: rec.reportAt || rec.at || null,
          ok: !!rec.ok,
          kind: rec.kind || '',
          reason: rec.reason || '',
          lastAttempt: rec.lastAttempt || null,
          said, nameMismatch: !!(said && norm(said) !== norm(r.agent)),
          version: rep?.node?.version || '',
          tokens: rep?.tokens || null,
          centralRole: rep?.centralRole || null,
          selfProbe: sp,
          fact,
          collectorShortMatch,
        },
      };
    }),
  };
}
