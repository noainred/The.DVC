/**
 * bmusage/attribution.js — **'법인 귀속 없음' 의 원인을 판정한다**(순수, v2.554).
 *
 * 사용자 지시(2026-09-17): 베어메탈 사용률 화면에 "대상이 아닌 서버 500대 — 법인 귀속 없음 500대"
 * 가 떠 있는 것을 보고 → **"네 — 원인까지 조사"**.
 *
 * ── 조사 결과(코드를 읽어 확정한 것) ────────────────────────────────────────
 * 베어메탈의 `vcenterId` 는 `insights/fleetInventory.js:60 resolveVc` 가 정한다. 우선순위는
 *   ① 등록부가 권위인 경우(`source==='idrac'`) 그 항목의 `vcenterId`
 *   ② 수동 귀속(`fleet-assign.json` — 키는 **소문자 서비스태그**, 없으면 서버 id/호스트명)
 *   ③ 그 밖(OME 상속·엣지 보고·호스팅 vCenter)
 * 그리고 `knownVc(id)` 가 **현재 존재하는 vCenter 만** 통과시킨다(삭제된 법인 = 유령 → 미지정).
 * 즉 500대가 미지정인 것은 **버그가 아니라 데이터**다 — 등록부의 `vcenterId` 가 비어 있고
 * `fleet-assign.json` 에도 키가 없다. 그래서 이 모듈은 고치는 코드가 아니라 **원인을 나눠
 * 화면이 조치를 말하게 하는** 판정이다(CLAUDE.md '사유마다 조치가 다르므로 한 문구로 덮지 말 것').
 *
 * ⚠ **원인을 단정하지 않는다**(v2.493 규약): 등록부에서 서버를 찾지 못한 경우는 '등록이 없다' 와
 *   '키가 안 맞는다'(서비스태그 공백)를 **구분할 수 없다** — 두 가능성을 함께 말한다.
 * ⚠ **'일괄 지정' 을 자동으로 하지 않는다.** 어느 서버가 어느 법인인지 포탈은 알지 못하고,
 *   틀리게 귀속하면 그 법인의 부하 통계가 거짓이 된다(v2.550 `includeUnassigned` 기본 제외와
 *   같은 판단). 화면은 **어디서 지정하는지**만 알려준다.
 */
const t = (v) => String(v ?? '').trim();
const norm = (v) => t(v).toLowerCase();

/** 원인 — 조치가 서로 다르다. 화면 문구는 웹 순수 모듈이 만든다. */
export const CAUSE = Object.freeze({
  'registry-no-vc': 'iDRAC 등록부에 있지만 법인(vCenter)이 지정돼 있지 않습니다.',
  'assign-ghost': '수동 귀속이 **지금 없는 vCenter** 를 가리킵니다(법인을 삭제·재등록했을 수 있습니다).',
  'edge-no-vc': '엣지가 보고했지만 그 보고에 법인이 없습니다(엣지 쪽 등록부에서 지정해야 합니다).',
  'no-registry-match': 'iDRAC 등록부에서 이 서버를 찾지 못했습니다(등록이 없거나 서비스태그가 비어 키가 맞지 않습니다).',
});

/**
 * 귀속 없음 원인 판정.
 * @param {object} p
 * @param {Array}  p.unassigned  `resolveTargets().skipped` 중 `reason==='unassigned'` 인 항목
 * @param {Array}  p.registry    `idrac/registry.js loadRegistry()`
 * @param {object} p.assign      `insights/fleetAssign.js loadFleetAssign()`
 * @param {Array}  p.vcenterIds  현재 존재하는 vCenter id 목록(유령 판정용)
 * @param {number} [p.sampleMax] 목록 상한(조용한 상한 금지 — 자른 개수를 밝힌다)
 * @returns {{total:number, byCause:object, samples:Array, truncated:number, assignKeys:number}}
 */
export function unassignedCauses({ unassigned = [], registry = [], assign = {}, vcenterIds = [], sampleMax = 20 } = {}) {
  const regById = new Map((registry || []).map((r) => [t(r.id), r]));
  const regByTag = new Map((registry || []).filter((r) => t(r.serviceTag)).map((r) => [norm(r.serviceTag), r]));
  const known = new Set((vcenterIds || []).map(t).filter(Boolean));
  const a = assign && typeof assign === 'object' ? assign : {};

  const byCause = {};
  const samples = [];
  for (const x of unassigned || []) {
    const reg = regById.get(t(x.serverId)) || (t(x.serviceTag) ? regByTag.get(norm(x.serviceTag)) : null) || null;
    // 수동 귀속 키 — `fleetInventory.resolveVc` 와 **같은 순서**(서비스태그 → 대체키)로 본다.
    const assigned = t(a[norm(x.serviceTag)]) || t(a[norm(x.serverId)]) || t(a[norm(x.fleetId)]) || '';
    let cause;
    if (assigned && !known.has(assigned)) cause = 'assign-ghost';
    else if (!reg) cause = t(x.agent) ? 'edge-no-vc' : 'no-registry-match';
    else if (t(reg.agent)) cause = 'edge-no-vc';
    else cause = 'registry-no-vc';
    byCause[cause] = (byCause[cause] || 0) + 1;
    if (samples.length < Math.max(1, sampleMax)) {
      samples.push({
        key: x.key, name: x.name, serviceTag: x.serviceTag || '', cause,
        // ⚠ 유령 귀속은 **그 id 를 보여준다** — 그것이 곧 진단이다(어느 법인이 사라졌는지).
        ghostVcenterId: cause === 'assign-ghost' ? assigned : '',
        hasServiceTag: !!t(x.serviceTag),
      });
    }
  }
  return {
    total: (unassigned || []).length,
    byCause,
    samples,
    truncated: Math.max(0, (unassigned || []).length - samples.length),
    assignKeys: Object.keys(a).length,
  };
}
