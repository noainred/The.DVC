/**
 * portalcheck/tokenFindings.js — 토큰 점검의 **발견 목록**(순수, v2.560).
 *
 * 규칙(v2.553 `remedy.js` 와 같다): **서버는 `code` + 근거(`facts`)만 준다. 문장은 웹이 만든다**
 * (`web/src/views/tools/tokenCheckText.js`). 서버가 문구를 들고 있으면 같은 판정의 표현이 두
 * 벌이 되고, 화면이 `BoldText` 로 그리는 강조 규약(백틱 금지)을 서버가 어기게 된다.
 *
 * ⚠ **등급을 뭉개지 말 것** — `fault`(고쳐야 한다) / `warn`(설계상 허용이나 위험·기능 결손) /
 *   `info`(문서화된 구성) / `unknown`(확인 못 했다). '확인 못 한 것' 을 결함으로도 정상으로도
 *   세지 않는다(v2.519·v2.523·v2.548 규약).
 */

import { PROBE_STATE, TOKEN_MODE, EDGE_TOKEN_FACT } from './tokenScan.js';

/**
 * 발견 코드. **여기에 없는 코드를 화면이 만들지 않는다**(테스트가 두 목록을 대조한다).
 * 각 코드는 **조치가 서로 다르다** — 같은 조치면 코드를 나눌 이유가 없다.
 */
export const FINDING = Object.freeze({
  // ① 중복
  DUP_COLLECTOR_EQUALS_CENTRAL: 'dup-collector-equals-central',
  DUP_CROSS_EDGE: 'dup-cross-edge',
  DUP_DEPLOY_TARGET: 'dup-deploy-target',
  DUP_SAME_EDGE_MULTI_ROLE: 'dup-same-edge-multi-role',
  // ② 통신(중앙 → 엣지, 중앙 저장 토큰 사용)
  PROBE_TOKEN_MISMATCH: 'probe-token-mismatch',
  PROBE_WRONG_EDGE: 'probe-wrong-edge',
  PROBE_EDGE_NO_TOKEN: 'probe-edge-no-token',
  PROBE_UNREACHABLE: 'probe-unreachable',
  PROBE_NO_TOKEN_STORED: 'probe-no-token-stored',
  PROBE_HTTP: 'probe-http',
  PROBE_NOT_RUN: 'probe-not-run',
  // ③ 동일성(엣지 → 중앙, 엣지 자기보고)
  EDGE_CENTRAL_REJECTED: 'edge-central-rejected',
  EDGE_CENTRAL_WRONG_NAME: 'edge-central-wrong-name',
  EDGE_SHARED_TOKEN: 'edge-shared-token',
  EDGE_NO_REPORT: 'edge-no-report',
  EDGE_OLD_VERSION: 'edge-old-version',
  EDGE_NAME_MISMATCH: 'edge-name-mismatch',
  EDGE_COLLECTOR_FP_DIFF: 'edge-collector-fp-diff',
  // ④ 구성
  EDGE_IS_ALSO_CENTRAL: 'edge-is-also-central',
  DEPLOY_COLLECTOR_DIFF: 'deploy-collector-diff',
  NOT_IN_REGISTRY: 'not-in-registry',
  // ⑤ 값 위생
  HYGIENE_SPACE: 'hygiene-space',
  HYGIENE_SHORT: 'hygiene-short',
  HYGIENE_NEWLINE: 'hygiene-newline',
  HYGIENE_QUOTED: 'hygiene-quoted',
});

export const FINDING_GRADE = Object.freeze({
  [FINDING.DUP_COLLECTOR_EQUALS_CENTRAL]: 'fault',
  [FINDING.DUP_CROSS_EDGE]: 'fault',
  [FINDING.DUP_DEPLOY_TARGET]: 'warn',
  [FINDING.DUP_SAME_EDGE_MULTI_ROLE]: 'info',

  [FINDING.PROBE_TOKEN_MISMATCH]: 'fault',
  [FINDING.PROBE_WRONG_EDGE]: 'fault',
  [FINDING.PROBE_EDGE_NO_TOKEN]: 'fault',
  [FINDING.PROBE_UNREACHABLE]: 'unknown',
  [FINDING.PROBE_NO_TOKEN_STORED]: 'warn',
  [FINDING.PROBE_HTTP]: 'unknown',
  [FINDING.PROBE_NOT_RUN]: 'unknown',

  [FINDING.EDGE_CENTRAL_REJECTED]: 'fault',
  [FINDING.EDGE_CENTRAL_WRONG_NAME]: 'fault',
  [FINDING.EDGE_SHARED_TOKEN]: 'warn',
  [FINDING.EDGE_NO_REPORT]: 'unknown',
  [FINDING.EDGE_OLD_VERSION]: 'unknown',
  [FINDING.EDGE_NAME_MISMATCH]: 'warn',
  [FINDING.EDGE_COLLECTOR_FP_DIFF]: 'fault',

  [FINDING.EDGE_IS_ALSO_CENTRAL]: 'warn',
  [FINDING.DEPLOY_COLLECTOR_DIFF]: 'warn',
  [FINDING.NOT_IN_REGISTRY]: 'warn',

  [FINDING.HYGIENE_SPACE]: 'warn',
  [FINDING.HYGIENE_SHORT]: 'warn',
  [FINDING.HYGIENE_NEWLINE]: 'warn',
  [FINDING.HYGIENE_QUOTED]: 'warn',
});

const HYGIENE_CODE = Object.freeze({
  space: FINDING.HYGIENE_SPACE,
  short: FINDING.HYGIENE_SHORT,
  newline: FINDING.HYGIENE_NEWLINE,
  quoted: FINDING.HYGIENE_QUOTED,
});

const DUP_CODE = Object.freeze({
  'collector-equals-central': FINDING.DUP_COLLECTOR_EQUALS_CENTRAL,
  'cross-edge': FINDING.DUP_CROSS_EDGE,
  'deploy-target': FINDING.DUP_DEPLOY_TARGET,
  'same-edge-multi-role': FINDING.DUP_SAME_EDGE_MULTI_ROLE,
});

const ORDER = { fault: 0, warn: 1, unknown: 2, info: 3 };

/**
 * 병합된 스캔(`mergeProbe`·`mergeEdgeReport` 통과분)에서 발견 목록을 만든다.
 * @returns {Array<{code:string, grade:string, agent:string, facts:object}>} 위험한 것 먼저
 */
export function findingsOf(scan = {}) {
  const out = [];
  const add = (code, agent, facts = {}) => out.push({ code, grade: FINDING_GRADE[code] || 'info', agent: agent || '', facts });

  /* ── ① 중복 ─────────────────────────────────────────────────────────────── */
  for (const d of scan.duplicates || []) {
    const code = DUP_CODE[d.kind];
    if (!code) continue; // by-design(공유 토큰 전 엣지 공통)은 발견으로 내지 않는다 — 별도 KPI 칸이다
    add(code, '', { short: d.short, len: d.len, members: d.members });
  }

  for (const r of scan.rows || []) {
    const a = r.agent;

    /* ── ④ 등록부 밖 ─────────────────────────────────────────────────────── */
    if (r.registered === false) add(FINDING.NOT_IN_REGISTRY, a, {});

    /* ── ⑤ 값 위생(중앙 저장 수집 토큰) ────────────────────────────────────── */
    for (const h of r.collector?.hygiene || []) {
      if (HYGIENE_CODE[h]) add(HYGIENE_CODE[h], a, { where: 'central-collector', len: r.collector?.len || 0 });
    }
    /* 엣지가 보고한 자기 값의 위생 — 중앙 값과 **따로** 센다(고칠 파일이 다르다). */
    for (const h of r.edge?.tokens?.collector?.hygiene || []) {
      if (HYGIENE_CODE[h]) add(HYGIENE_CODE[h], a, { where: 'edge-collector', len: r.edge?.tokens?.collector?.len || 0 });
    }
    for (const h of r.edge?.tokens?.centralSend?.hygiene || []) {
      if (HYGIENE_CODE[h]) add(HYGIENE_CODE[h], a, { where: 'edge-central-send', len: r.edge?.tokens?.centralSend?.len || 0 });
    }

    /* ── ② 통신 ─────────────────────────────────────────────────────────── */
    const st = r.probe?.state || PROBE_STATE.NOT_RUN;
    if (st === PROBE_STATE.TOKEN_MISMATCH) {
      /*
       * ⚠ **정직 기록**: 여기서는 '다르다' 까지만 안다. **'무엇과 다른가' 는 알 수 없다** —
       *   엣지 자기보고도 같은 토큰으로 당기므로 함께 거부된다. 그래서 화면이 다음 단서로
       *   ① 배포 대상 파일 대조(`deploy`) ② 그 엣지 호스트에서 직접 확인을 안내한다.
       */
      add(FINDING.PROBE_TOKEN_MISMATCH, a, { httpStatus: r.probe?.httpStatus || 403, centralShort: r.collector?.short || '', deploy: r.deploy || null });
    } else if (st === PROBE_STATE.WRONG_EDGE) {
      add(FINDING.PROBE_WRONG_EDGE, a, { said: r.probe?.agentSaid || '', hostname: r.probe?.hostname || '', reason: r.probe?.identity?.reason || '' });
    } else if (st === PROBE_STATE.EDGE_NO_TOKEN) {
      add(FINDING.PROBE_EDGE_NO_TOKEN, a, { reason: r.probe?.reason || '' });
    } else if (st === PROBE_STATE.UNREACHABLE || st === PROBE_STATE.TIMEOUT) {
      add(FINDING.PROBE_UNREACHABLE, a, { kind: st, reason: r.probe?.reason || '', url: r.url || '' });
    } else if (st === PROBE_STATE.SKIP_NO_TOKEN) {
      add(FINDING.PROBE_NO_TOKEN_STORED, a, {});
    } else if (st === PROBE_STATE.OLD_ROUTE || st === PROBE_STATE.HTTP) {
      add(FINDING.PROBE_HTTP, a, { httpStatus: r.probe?.httpStatus || null, reason: r.probe?.reason || '' });
    } else if (st === PROBE_STATE.NOT_RUN) {
      add(FINDING.PROBE_NOT_RUN, a, { reason: r.probe?.reason || '' });
    }

    /* ── ③ 동일성(엣지 → 중앙) ───────────────────────────────────────────── */
    if (!r.edge) {
      // 보고가 없는 이유를 **버전으로 가른다**(조치가 정반대다 — 업그레이드 / 다시 당기기).
      if (r.capability === 'old-version') add(FINDING.EDGE_OLD_VERSION, a, { version: r.version || '' });
      else add(FINDING.EDGE_NO_REPORT, a, { capability: r.capability || 'unknown-version', version: r.version || '' });
    } else {
      if (r.edge.fact === EDGE_TOKEN_FACT.REJECTED) {
        add(FINDING.EDGE_CENTRAL_REJECTED, a, { reason: r.edge.selfProbe?.reason || '', short: r.edge.tokens?.centralSend?.short || '' });
      } else if (r.edge.fact === EDGE_TOKEN_FACT.AGENT_WRONG_NAME) {
        add(FINDING.EDGE_CENTRAL_WRONG_NAME, a, { yourAgent: r.edge.selfProbe?.yourAgent || '' });
      } else if (r.edge.fact === EDGE_TOKEN_FACT.SHARED) {
        add(FINDING.EDGE_SHARED_TOKEN, a, {});
      }
      if (r.edge.nameMismatch) add(FINDING.EDGE_NAME_MISMATCH, a, { said: r.edge.said });
      if (r.edge.collectorShortMatch === false) {
        add(FINDING.EDGE_COLLECTOR_FP_DIFF, a, { centralShort: r.collector?.short || '', edgeShort: r.edge.tokens?.collector?.short || '' });
      }
      if (r.edge.centralRole?.enabled) {
        add(FINDING.EDGE_IS_ALSO_CENTRAL, a, { byEnv: !!r.edge.centralRole.byEnv, byIssuedTokens: !!r.edge.centralRole.byIssuedTokens, source: 'edge-report' });
      }
    }
    /*
     * 엣지 보고가 없어도 중앙의 무인증 확인으로 같은 사실을 알 수 있다(요구 ① 구성 축).
     * ⚠ 보고와 프로브가 **둘 다** 말하면 한 번만 센다(같은 사실을 두 줄로 내면 개수가 부풀린다).
     */
    if (!r.edge?.centralRole?.enabled && r.centralRole?.kind === 'central-enabled') {
      add(FINDING.EDGE_IS_ALSO_CENTRAL, a, { byEnv: true, byIssuedTokens: false, source: 'probe' });
    }

    /* ── 배포 대상 대조(저장소끼리 — 찔러보지 않는다) ───────────────────────── */
    if (r.deploy?.present && r.deploy.collectorMatchesRegistry === false) {
      add(FINDING.DEPLOY_COLLECTOR_DIFF, a, { deployShort: r.deploy.collector || '', registryShort: r.collector?.short || '' });
    }

    /* 공유 토큰인데 엣지 보고가 없어 실측이 없으면 등록부 판정으로라도 알린다. */
    if (!r.edge && r.central?.mode === TOKEN_MODE.SHARED) add(FINDING.EDGE_SHARED_TOKEN, a, { basis: 'registry' });
  }

  out.sort((x, y) => (ORDER[x.grade] - ORDER[y.grade]) || x.code.localeCompare(y.code) || String(x.agent).localeCompare(String(y.agent)));
  return out;
}

/** 등급별 개수 — 화면 배너가 쓴다. 칸이 겹치지 않는다. */
export function findingCounts(findings = []) {
  const c = { fault: 0, warn: 0, unknown: 0, info: 0, total: findings.length };
  for (const f of findings) if (c[f.grade] != null) c[f.grade] += 1;
  return c;
}

/**
 * ⚠⚠ **같은 코드를 묶는다**(v2.560 스크린샷 판독에서 잡은 결함): 엣지 28곳이 전부 공유 토큰을
 *   쓰는 현장에서 `edge-shared-token` 이 28줄, `edge-no-report` 가 28줄, `probe-not-run` 이 28줄 —
 *   **같은 문단 84줄이 화면을 덮는다**. 실측(엣지 6곳)에서도 22건 중 17건이 같은 문장 3종의 반복
 *   이었다. v2.509 규약('행마다 반복하면 같은 문단이 화면을 덮는다')의 정면 위반이고 **수치로는
 *   안 잡힌다**(개수는 정확했다).
 *
 * 묶어도 **개수와 대상은 잃지 않는다** — `count` 와 `agents` 로 밝힌다(조용한 축약 금지).
 * 정렬은 `findingsOf` 의 순서(위험한 것 먼저)를 그대로 물려받는다.
 *
 * @returns {Array<{code:string, grade:string, count:number, agents:string[], facts:object, first:object}>}
 */
export function groupFindings(findings = []) {
  const by = new Map();
  for (const f of findings) {
    /*
     * ⚠ 위생 항목은 **어느 파일을 고쳐야 하는지**(`facts.where`)가 조치를 가르므로 그것까지 키에
     *   넣는다 — 묶어 버리면 '중앙 등록값' 과 '엣지 값' 이 한 줄이 되어 엉뚱한 곳을 고치게 된다.
     */
    const key = f.facts?.where ? `${f.code}|${f.facts.where}` : f.code;
    if (!by.has(key)) by.set(key, { code: f.code, grade: f.grade, count: 0, agents: [], facts: f.facts || {}, first: f });
    const g = by.get(key);
    g.count += 1;
    if (f.agent && !g.agents.includes(f.agent)) g.agents.push(f.agent);
  }
  return [...by.values()];
}
