/**
 * powermaxCapacityText.js — VMAX/PowerMax 용량 구성 문구·행(순수 · v2.534).
 *
 * 사용자 신고: "vmax, powermax 스토리지의 할당량 말고 **실제로 디스크에 기록한 사용량** 보여줘".
 * 이 파일은 그 셋(구독 · 할당 · 실제 기록)을 **절대 섞지 않는다**. 웹 테스트는 node 환경(DOM 없음)
 * 이라 판정·문구를 여기에 두고 vitest 로 고정한다(`accessDeniedText.js` 관례).
 *
 * 근거(Dell 공식 OpenAPI 스펙 원문 — Dell 이 PyU4V 저장소 `tools/openapi.json` 에 커밋한 것):
 *   usable_used_tb          "…used by Host, eNas and System **after Data reduction is applied**"
 *   subscribed_allocated_tb "Host allocated plus eNas allocated capacity in TBs"
 *   subscribed_total_tb     "Host subscribed capacity plus eNas subscribed capacity in TBs"
 *   disk_group_total_capacity_gb "The total disk group (raw) capacity including RAID overhead"
 *
 * ⚠ `physicalCapacity` 는 **Dell 스펙에도 설명이 없다**. 그 필드로 읽었고 사용 == 전체면
 *   화면이 경고해야 한다 — 조용히 100% 를 보여주면 사용자가 용량 부족으로 오해한다.
 */

/** TB 표기(소수 2자리, 천 단위 구분). null 은 '—'. */
export function tb(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return `${Number(v).toLocaleString('ko-KR', { maximumFractionDigits: 2 })} TB`;
}

/**
 * 용량 구성 행 — 있는 값만, **정의된 순서로**.
 * 순서가 계약이다: 실제 기록 → 할당 → 구독 순으로 '작은 것부터 큰 것' 이라야 셋의 관계가 보인다.
 *
 * @param {object|null} extra 스냅샷의 extra
 * @returns {Array<{key:string,label:string,value:string,desc:string,strong?:boolean}>}
 */
export function capacityRows(extra) {
  const d = extra?.capacityDetail;
  if (!d || typeof d !== 'object') return [];
  const out = [];
  const push = (key, label, v, desc, strong) => {
    if (v == null) return;
    out.push({ key, label, value: tb(v), desc, strong: !!strong });
  };
  push('written', '실제 기록', d.usableUsedTb,
    '데이터 감축(압축·중복제거)을 적용한 뒤 디스크에 실제로 쓰인 양입니다.', true);
  push('allocated', '할당', d.allocatedTb,
    '씬 풀에서 디바이스에 할당된 양입니다 — 감축 전 기준이라 실제 기록량과 다를 수 있습니다.');
  push('subscribed', '구독(프로비저닝)', d.subscribedTb,
    '호스트에 약속한 씬 디바이스 총 크기입니다. 씬 프로비저닝이라 전체 용량을 넘을 수 있습니다.');
  push('usable', 'usable 전체', d.usableTotalTb, 'RAID 오버헤드를 뺀 뒤 실제로 쓸 수 있는 용량입니다.');
  push('raw', 'raw 전체', d.rawTb, '디스크 그룹의 원시 용량(RAID 오버헤드 포함)입니다.');
  push('snapshot', '스냅샷', d.snapshotTb, '스냅샷이 차지한 논리 총량입니다.');
  push('savings', '감축 절감', d.savingsTb, '압축·중복제거로 아낀 양입니다(SRP 보고값).');
  return out;
}

/** 오버프로비저닝 비율 문구 — Dell 이 100% 초과가 정상이라고 명시한 값이다. */
export function subscribedNote(extra) {
  const p = extra?.capacityDetail?.subscribedPct;
  if (p == null || !Number.isFinite(Number(p))) return null;
  return `구독은 usable 전체의 ${Number(p).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}% 입니다`
    + (Number(p) > 100 ? ' — 씬 프로비저닝이라 100%를 넘는 것이 정상입니다.' : '.');
}

/**
 * SRP(풀) 행 — 어느 필드로 읽었는지까지 밝힌다(v2.522 `usedCmds` 규약).
 * @returns {Array<{id:string,array:string,used:string,total:string,pct:number|null,basis:string,meta:string}>}
 */
export function srpRows(extra) {
  const list = extra?.capacityDetail?.srps;
  if (!Array.isArray(list)) return [];
  return list.map((s) => {
    const pct = s.totalTb > 0 && s.usedTb != null ? Math.round((s.usedTb / s.totalTb) * 1000) / 10 : null;
    const meta = [
      s.drr != null ? `감축 ${Number(s.drr).toFixed(2)}:1` : null,
      s.compression ? `압축 ${s.compression}` : null,
      s.effectiveUsedTb != null ? `감축 전 ${tb(s.effectiveUsedTb)}` : null,
      s.subscribedTb != null ? `구독 ${tb(s.subscribedTb)}` : null,
    ].filter(Boolean).join(' · ');
    return { id: s.id || '—', array: s.array || '', used: tb(s.usedTb), total: tb(s.totalTb), pct, basis: s.basis || '', meta };
  });
}

/**
 * 사용량을 믿을 수 있는지 — **판정을 한 곳에서** 한다(목록 배지 + 상세 문구의 단일 소유자).
 *
 * ⚠ v2.546 — `partial` 갈래 추가. 다중 풀 장비에서 일부 풀이 합계에서 빠지면 **사용률·전체
 *   용량이 그만큼 작게** 나온다. 그 사실이 상세에만 있으면(`capacityBasisNote`) 목록에서
 *   퍼센트만 훑는 사람은 그대로 믿는다 — v2.516 '실패 사유를 툴팁에만 두지 말 것',
 *   v2.534 '상세를 열어야만 알 수 있으면 사용자는 100% 를 용량 부족으로 읽는다' 와 같은 규약.
 * ⚠ 이 갈래를 **가장 먼저** 본다 — `capacitySuspect`(VMAX 전용)와 실제로 겹치지는 않지만,
 *   '어느 풀이 빠졌나' 는 조치가 분명한 반면 '기준 불명' 은 조사가 필요하다.
 * @returns {{kind:'partial'|'suspect'|'undocumented'|'ok', short:string|null, text:string|null}}
 */
export function usageTrust(extra) {
  const skipped = (Number(extra?.poolsUnreadable) || 0) + (Number(extra?.poolsUsedUnreadable) || 0);
  if (skipped > 0) {
    return {
      kind: 'partial',
      short: `풀 ${skipped}개 제외`,
      // v2.600(감사 COL-2600-01~03 후속): 이 갈래는 Unity 만이 아니라 PowerMax(어레이)·XtremIO(클러스터)에서도 뜬다 —
      //   Unity uemcli 항목명(Total space 등)을 안내하면 다른 벤더에서는 없는 항목을 찾게 된다. 벤더 중립으로 말한다.
      text: `용량 또는 사용량을 읽지 못한 풀(어레이·클러스터) ${skipped}개를 합계에서 제외했습니다 — `
        + '**전체 용량이 실제보다 작고, 사용률도 전체 기준과 다를 수 있습니다**. 상세의 풀 목록과 섹션 오류(또는 CLI 원문)에서 '
        + '그 풀의 **전체 용량**·**사용량** 항목을 확인하세요. '
        + '⚠ 이 주기는 **증가량 추이에 적재되지 않습니다**(기준이 달라진 값을 이어 붙이지 않기 위해).',
    };
  }
  if (extra?.capacitySuspect) {
    return {
      kind: 'suspect',
      short: '기준 불명',
      text: '이 장비의 사용량은 **실제 기록량이 아닐 수 있습니다** — Dell 스펙에 설명이 없는 '
        + '‘physicalCapacity’ 필드로 읽었고 사용량이 전체 용량과 같게 보고됩니다. '
        + 'Unisphere 응답에 ‘system_capacity.usable_used_tb’ 가 있거나 SRP 조회가 되면 실제 기록량이 표시됩니다.',
    };
  }
  const basis = String(extra?.capacityBasis || '');
  if (basis && !/usable|physical_capacity/.test(basis)) {
    return { kind: 'undocumented', short: null, text: null };
  }
  return { kind: 'ok', short: null, text: null };
}
