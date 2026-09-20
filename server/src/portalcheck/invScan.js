/**
 * 포탈 점검 › **인벤토리 점검** — 위임(site) vCenter 의 인벤토리가 실제로 들어오고 있는가(v2.570).
 *
 * 사용자 요청(2026-09-20): '에이전트 수신 트래픽 진단' 표에서 **최근 페이로드가 전부 `—`** 인
 * 것을 보고 "여기서 수집되는 데이터가 없으면 어떤 문제가 발생하는지 확인하고 오류를 점검하려면
 * 어떻게 해야 하는지" → "점검할 수 있는 기능 만들어줘".
 *
 * ── 이 모듈이 고치는 확정 결함 3건(v2.569 조사에서 코드로 확인) ────────────────────────────
 *  ⚠⚠ **① `stale` 을 아무도 보여주지 않았다.** `store.js` 가 위임 vCenter 의 마지막 push 가
 *      `SITE_INVENTORY_STALE_MS`(기본 5분)를 넘으면 `stale:true` 를 찍는데, 웹 소비처가 **0건**
 *      이고 `/health` 도 세지 않았다. 데이터는 디스크 캐시(`central-inventory.json`)에서 계속
 *      서빙되므로 **며칠 전 값이 지금 값처럼 보인다** — 이 포탈이 만들 수 있는 가장 위험한 거짓이다.
 *  ⚠⚠ **② `—` 가 두 뜻이었다.** 수신 집계는 4xx/5xx 를 빼므로(`routes/central.js`) '안 보냈다'
 *      와 '보냈는데 막혔다'(mock 차단·소유권·토큰)가 화면에서 **똑같이** 보였다. 조치가 정반대다.
 *      이제 `central/ingestReject.js` 가 거부를 기록하고 여기서 갈라 준다.
 *  ⚠ **③ 저장된 인벤토리 목록에 화면 진입로가 없었다**(`/api/admin/central/inventory` API 전용).
 *
 * ── 설계 규약 ──────────────────────────────────────────────────────────────
 *  · **순수 함수다** — 파일·네트워크·시계를 직접 읽지 않는다(`now` 를 받는다). 테스트가 경계를 고정한다.
 *  · **판정은 여기가 소유하고 문구는 웹이 만든다**(v2.553 `remedy.js` 규약) — 코드 + 근거(`facts`)만 준다.
 *  · **'확인 불가' 를 정상으로도 장애로도 세지 않는다**(v2.519·v2.523·v2.534·v2.548 규약).
 *  · **왕복 0** — 이미 중앙이 가진 값만 조합한다. 이 점검이 엣지·vCenter 에 부하를 주지 않는다.
 *
 * ⚠ **담당 엣지를 지정하는 곳이 없다**(정직 기록): vCenter 등록부에는 `collectMode` 만 있고
 *   `agent` 필드가 없다(`vcenter/registry.js:90`). 담당은 **push 로 학습**된다(`inventory[].agent`).
 *   그래서 한 번도 push 되지 않은 위임 vCenter 는 **누가 보내야 하는지 중앙이 알지 못한다** —
 *   그 사실을 `owner:null` 로 밝히고 추측하지 않는다.
 */

/** 행 상태 — **겹치지 않는다**(합계 = ok + stale + never + rejected + unknown). */
export const INV_STATE = Object.freeze({
  OK: 'ok',              // 신선한 수신이 있다
  STALE: 'stale',        // 수신은 있으나 기준 시간을 넘었다 — 지금 값이 아니다
  NEVER: 'never',        // 한 번도 들어온 적이 없다
  REJECTED: 'rejected',  // 보냈는데 중앙이 거부했다(마지막 수신보다 뒤)
  UNKNOWN: 'unknown',    // 판정 근거가 부족하다 — 정상이라 말하지 않는다
});

/** 발견 코드 — 화면 문구와 **1:1** 이어야 한다(테스트가 두 목록을 대조한다). */
export const INV_FINDING = Object.freeze({
  STALE: 'inv-stale',
  NEVER: 'inv-never',
  REJECT_MOCK: 'inv-reject-mock',
  REJECT_OWNER: 'inv-reject-owner',
  REJECT_AUTH: 'inv-reject-auth',
  REJECT_OTHER: 'inv-reject-other',
  EMPTY_PUSH: 'inv-empty-push',
  NO_OWNER: 'inv-no-owner',
  AGENT_NO_INVENTORY: 'inv-agent-no-inventory',
  AGENT_MOCK: 'inv-agent-mock',
  OWNER_CONFLICT: 'inv-owner-conflict',
  NO_SITE_VCENTER: 'inv-no-site-vcenter',
});

export const INV_GRADE = Object.freeze({ FAULT: 'fault', WARN: 'warn', INFO: 'info' });

const t = (v) => String(v ?? '').trim();
const low = (v) => t(v).toLowerCase();
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * 위임 vCenter별 수신 판정 + 엣지별 인벤토리 push 여부.
 *
 * @param vcenters  `vcenter/registry.js listRegistry()` — collectMode 를 읽는다
 * @param inventory `central/inventory.js listInventory()` — 실제로 저장된 것(진실의 원천)
 * @param ingestRows `central/ingestStats.js getIngestStats().rows` — 누가 무엇을 보냈나
 * @param rejects   `central/ingestReject.js rejectStats()` — 거부 기록(⚠ agent 이름은 미검증)
 * @param identity  `central/agentIdentity.js agentIdentitySummary()` — mock 보고·이름 충돌
 * @param now       기준 시각(ms). ⚠ 테스트가 고정할 수 있게 **반드시 주입**한다(v2.517 규약)
 * @param staleMs   store.js 의 SITE_INVENTORY_STALE_MS 와 **같은 값**이어야 한다
 */
export function scanInventory({
  vcenters = [], inventory = [], ingestRows = [], rejects = null,
  identity = null, now = 0, staleMs = 300_000,
} = {}) {
  const at = num(now) || 0;
  const stale = Math.max(1000, num(staleMs) || 300_000);

  const invBy = new Map();
  for (const e of inventory) if (t(e?.vcenterId)) invBy.set(t(e.vcenterId), e);

  // 거부 기록에서 vCenter 축과 agent 축을 각각 뽑는다.
  const rejByVc = new Map();     // vcenterId(low) → 가장 최근 거부
  for (const r of rejects?.recent || []) {
    const k = low(r?.vcenterId);
    if (!k || rejByVc.has(k)) continue; // recent 는 최신이 앞 — 첫 건이 가장 최근이다
    rejByVc.set(k, r);
  }
  const rejByAgent = new Map();  // agent(low) → 요약
  for (const r of rejects?.rows || []) { const k = low(r?.agent); if (k) rejByAgent.set(k, r); }

  const sites = vcenters.filter((v) => t(v?.collectMode) === 'site');

  const rows = sites.map((vc) => {
    const id = t(vc.id);
    const inv = invBy.get(id) || null;
    const rej = rejByVc.get(low(id)) || null;
    const lastAt = num(inv?.at);
    const ageMs = lastAt != null && at ? Math.max(0, at - lastAt) : null;
    const owner = t(inv?.agent) || null;              // ⚠ push 로 학습된 값 — 등록부에는 없다
    const hosts = num(inv?.hosts);
    const vms = num(inv?.vms);
    const emptyPush = lastAt != null && hosts === 0 && vms === 0;

    // ⚠ 판정 순서가 계약이다 — '거부' 가 '낡음' 보다 **먼저**다. 낡았는데 그 사이에 거부가
    //   있었다면 원인은 '엣지가 조용하다' 가 아니라 '중앙이 막고 있다' 이고 조치가 정반대다.
    //   단, 거부가 마지막 수신보다 **앞**이면 이미 해소된 과거 기록이므로 상태로 올리지 않는다.
    let state = INV_STATE.UNKNOWN;
    if (rej && (lastAt == null || num(rej.at) > lastAt)) state = INV_STATE.REJECTED;
    else if (lastAt == null) state = INV_STATE.NEVER;
    else if (ageMs != null && ageMs > stale) state = INV_STATE.STALE;
    else if (ageMs != null) state = INV_STATE.OK;

    return {
      vcenterId: id,
      name: t(vc.name) || id,
      owner,
      lastAt: lastAt ?? null,
      generatedAt: inv?.generatedAt ?? null,
      ageMs,
      hosts: hosts ?? null,
      vms: vms ?? null,
      datastores: num(inv?.datastores) ?? null,
      emptyPush: !!emptyPush,
      state,
      // 거부 근거 — **원문을 그대로** 싣는다(요약하면 사용자가 어디를 고칠지 알 수 없다).
      reject: rej ? { at: rej.at, kind: rej.kind, reason: rej.reason, status: rej.status, agent: rej.agent } : null,
      // agent 이름 충돌(같은 vCenter 를 두 엣지가 번갈아 push) — 그 자체가 진단이다.
      conflict: (identity?.vcenterConflicts || []).find((c) => low(c?.vcenterId) === low(id)) || null,
    };
  }).sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name, 'ko'));

  // ── 엣지 축 — 수신 트래픽 표의 `—` 를 설명한다 ──────────────────────────────
  // `ingestStats` 의 `last` 는 **`/inventory` push 일 때만** 채워진다. 그래서 `last:null` 은
  // "이 집계 시작 이후 인벤토리를 한 번도 성공적으로 보내지 않았다" 는 뜻이다.
  const ownerSet = new Set(rows.map((r) => low(r.owner)).filter(Boolean));
  const agents = ingestRows.map((a) => {
    const name = t(a?.agent);
    const rj = rejByAgent.get(low(name)) || null;
    const mock = !!(identity?.byAgent || {})[low(name)]?.mock;
    return {
      agent: name,
      pushes: num(a?.pushes) ?? 0,
      wireBytes: num(a?.wireBytes) ?? 0,
      lastAt: num(a?.lastAt) ?? null,
      // ⚠ 이 값이 이 표의 존재 이유다 — false 면 그 엣지는 인벤토리를 안 보내고 있다.
      sentInventory: Boolean(a?.last && t(a.last.endpoint).replace(/^\//, '') === 'inventory'),
      lastEndpoint: t(a?.last?.endpoint).replace(/^\//, '') || null,
      lastVcenterId: t(a?.last?.vcenterId) || null,
      lastHosts: num(a?.last?.hosts),
      lastVms: num(a?.last?.vms),
      gzip: a?.last ? Boolean(a.last.gzip) : null,
      rejects: rj ? { total: rj.total, lastAt: rj.lastAt, lastKind: rj.lastKind, lastReason: rj.lastReason, byKind: rj.byKind } : null,
      mockReported: mock,
      // 이 엣지가 위임 vCenter 의 담당으로 **학습된 적이 있나** — 없으면 인벤토리 담당이 아닐 수 있다.
      knownOwner: ownerSet.has(low(name)),
    };
  }).sort((a, b) => Number(a.sentInventory) - Number(b.sentInventory) || (b.wireBytes - a.wireBytes));

  return { rows, agents, kpis: kpisOf(rows), staleMs: stale, at, siteCount: sites.length, vcenterCount: vcenters.length };
}

const STATE_ORDER = Object.freeze({ rejected: 0, never: 1, stale: 2, unknown: 3, ok: 4 });

/**
 * KPI — **겹치지 않는다**: 합계 = 정상 + 낡음 + 미수신 + 거부됨 + 확인 불가.
 * ⚠ `emptyPush` 는 **별도 축**이다(정상 수신인데 내용이 빈 것) — 합에 더하지 말 것.
 */
export function kpisOf(rows = []) {
  const k = { total: rows.length, ok: 0, stale: 0, never: 0, rejected: 0, unknown: 0, emptyPush: 0 };
  for (const r of rows) {
    if (r.state === INV_STATE.OK) k.ok++;
    else if (r.state === INV_STATE.STALE) k.stale++;
    else if (r.state === INV_STATE.NEVER) k.never++;
    else if (r.state === INV_STATE.REJECTED) k.rejected++;
    else k.unknown++;
    if (r.emptyPush) k.emptyPush++;
  }
  // ⚠ 신선율의 분모는 **수신 이력이 있는 행**이다 — 한 번도 안 온 것을 '실패' 로 세면
  //   신규 구축 중인 사이트 때문에 비율이 거짓이 된다. 0 이면 null(0% 가 아니다).
  const measured = k.ok + k.stale;
  k.measured = measured;
  k.freshPct = measured > 0 ? Math.round((k.ok / measured) * 100) : null;
  return k;
}

/**
 * 발견 — `code` + 근거(`facts`)만 준다. **문장은 웹이 만든다**(v2.553 규약).
 * ⚠ 같은 코드는 웹이 묶어서 그린다(v2.509) — 여기서는 대상별로 1건씩 낸다(개수·대상을 잃지 않게).
 */
export function findingsOf(scan) {
  const out = [];
  const push = (code, grade, target, facts) => out.push({ code, grade, target, facts });

  for (const r of scan?.rows || []) {
    if (r.state === INV_STATE.REJECTED) {
      const k = t(r.reject?.kind);
      const code = k === 'mock' ? INV_FINDING.REJECT_MOCK
        : k === 'owner' ? INV_FINDING.REJECT_OWNER
          : k === 'auth' ? INV_FINDING.REJECT_AUTH
            : INV_FINDING.REJECT_OTHER;
      push(code, INV_GRADE.FAULT, r.vcenterId, { agent: r.reject?.agent || '', reason: r.reject?.reason || '', at: r.reject?.at || 0, status: r.reject?.status || 0 });
    } else if (r.state === INV_STATE.STALE) {
      push(INV_FINDING.STALE, INV_GRADE.FAULT, r.vcenterId, { ageMs: r.ageMs, owner: r.owner || '', staleMs: scan?.staleMs || 0 });
    } else if (r.state === INV_STATE.NEVER) {
      push(INV_FINDING.NEVER, INV_GRADE.WARN, r.vcenterId, { owner: r.owner || '' });
    }
    if (r.emptyPush) push(INV_FINDING.EMPTY_PUSH, INV_GRADE.WARN, r.vcenterId, { owner: r.owner || '', lastAt: r.lastAt });
    if (!r.owner && r.state !== INV_STATE.OK) push(INV_FINDING.NO_OWNER, INV_GRADE.INFO, r.vcenterId, {});
    if (r.conflict) push(INV_FINDING.OWNER_CONFLICT, INV_GRADE.FAULT, r.vcenterId, { agent: r.conflict.agent || '', other: r.conflict.other || '', flips: r.conflict.flips || 0 });
  }

  for (const a of scan?.agents || []) {
    if (a.mockReported) push(INV_FINDING.AGENT_MOCK, INV_GRADE.FAULT, a.agent, {});
    // ⚠ '인벤토리를 안 보낸 엣지' 는 **위임 담당으로 학습된 적이 있을 때만** 결함이다.
    //   그 밖의 엣지(스토리지·svcmon 전용 등)는 인벤토리를 보내지 않는 것이 **정상**이다 —
    //   전부 결함으로 올리면 화면이 정상 구성을 결함이라 말한다(v2.560 오탐과 같은 유형).
    else if (!a.sentInventory && a.knownOwner) push(INV_FINDING.AGENT_NO_INVENTORY, INV_GRADE.FAULT, a.agent, { pushes: a.pushes, lastEndpoint: a.lastEndpoint || '' });
  }

  if ((scan?.siteCount || 0) === 0) push(INV_FINDING.NO_SITE_VCENTER, INV_GRADE.INFO, '', { vcenterCount: scan?.vcenterCount || 0 });

  const order = { fault: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.grade] - order[b.grade]);
}

/** 같은 코드끼리 묶는다 — 28곳이 같은 상태면 같은 문장이 28줄로 화면을 덮는다(v2.509 규약). */
export function groupFindings(findings = []) {
  const by = new Map();
  for (const f of findings) {
    const g = by.get(f.code) || { code: f.code, grade: f.grade, count: 0, targets: [], facts: f.facts };
    g.count++;
    if (g.targets.length < 40) g.targets.push(f.target); // ⚠ 상한으로 자른 것은 count 가 밝힌다
    by.set(f.code, g);
  }
  const order = { fault: 0, warn: 1, info: 2 };
  return [...by.values()].sort((a, b) => order[a.grade] - order[b.grade] || b.count - a.count);
}

export function findingCounts(findings = []) {
  const c = { fault: 0, warn: 0, info: 0 };
  for (const f of findings) if (c[f.grade] != null) c[f.grade]++;
  return c;
}
