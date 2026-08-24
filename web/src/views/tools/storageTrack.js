// storageTrack.js — '스토리지 사용량 추이'(v2.350) 화면의 순수 계산부.
// 컴포넌트 안에 두면 테스트할 수 없어(렌더 필요) 파생 계산만 따로 뺐다. 셋 다 부수효과 없음.

/**
 * DS 데이터가 실제로 있는 포인트인가 — v2.348 이전 버전에서 만들어진 스냅샷 행은 ds 열이
 * 전부 0 이다(열 자체가 없다가 ALTER 로 추가됨). 이런 행을 기준선으로 쓰면 '0 → 현재 사용량'
 * 전체가 증가로 잡혀 기간 증감이 +2만 TB 처럼 나온다(실제 발생) — 반드시 걸러야 한다.
 * DS 가 진짜 0개인 vCenter 도 여기서 false 지만, 그 경우 증감도 0 이므로 결과는 동일하다.
 */
export function hasDsData(p) {
  if (!p) return false;
  return (p.dsCapGB || 0) > 0 || (p.dsUsedGB || 0) > 0 || (p.dsCount || 0) > 0;
}

/** GB → TB(소수 1자리). 저장은 GB(REAL), 표시는 TB — 수백 TB 규모라 GB 축은 읽기 어렵다. */
export function tb(gb) {
  return Math.round(((Number(gb) || 0) / 1024) * 10) / 10;
}

/** 증감 표기: 1TB 미만은 GB, 그 이상은 TB(스토리지 운영자가 읽는 단위). null 은 대시. */
export function gbTb(gb) {
  if (gb == null || !Number.isFinite(Number(gb))) return '—';
  const n = Number(gb);
  if (Math.abs(n) >= 1024) return `${(n / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} TB`;
  return `${Math.round(n).toLocaleString()} GB`;
}

/**
 * vCenter별 '현재 상태 + 기간 증감' — bySlotVc(슬롯 → vCenter 행 배열)에서 각 vCenter 의
 * 첫 슬롯과 마지막 슬롯을 뽑아 계산한다. 슬롯마다 등장하는 vCenter 집합이 다를 수 있으므로
 * (신규 등록·일시 unreachable) vCenter 단위로 각각의 첫/마지막을 잡는다 — 전체 첫 슬롯에
 * 없던 vCenter 를 0 으로 두면 증감이 '전량 신규'로 과대 계상된다.
 * 사용률은 저장된 vCenter별 값(ds_used/ds_cap)을 그대로 쓴다.
 */
export function perVcSummary(bySlotVc) {
  const slots = Object.keys(bySlotVc || {}).sort();
  if (!slots.length) return [];
  const firstOf = new Map();
  const lastOf = new Map();
  for (const s of slots) {
    for (const v of bySlotVc[s] || []) {
      // 기준선은 DS 데이터가 있는 첫 행 — 구버전(ds 열 0) 행을 기준으로 잡으면 전량 신규로 과대 계상.
      if (!firstOf.has(v.vcenterId) && hasDsData(v)) firstOf.set(v.vcenterId, v);
      lastOf.set(v.vcenterId, v);
    }
  }
  return [...lastOf.entries()].map(([vc, cur]) => {
    const f = firstOf.get(vc) || cur;
    const capGB = cur.dsCapGB || 0;
    const usedGB = cur.dsUsedGB || 0;
    return {
      vcenterId: vc,
      snapId: cur.snapId,
      dsCount: cur.dsCount || 0,
      capGB,
      usedGB,
      freeGB: Math.max(0, capGB - usedGB),
      usagePct: cur.dsUsagePct ?? (capGB > 0 ? Math.round((usedGB / capGB) * 1000) / 10 : 0),
      deltaGB: Math.round((usedGB - (f.dsUsedGB || 0)) * 10) / 10,
    };
  });
}

/**
 * 기간 증가량과 선형 소진 예상.
 * 일수는 '스냅샷 개수 ÷ 2'가 아니라 **첫·마지막 수집 시각 차이**로 센다 — 폴러가 멈춘 구간이나
 * 수동 스냅샷이 섞이면 슬롯 수와 실제 경과일이 어긋나 일평균이 왜곡된다.
 * fullDays 는 증가 추세(perDayGB>0)일 때만 값을 주고, 그 외에는 null(=추정 불가)이다.
 * @param {Array<{collectedAt:number,dsUsedGB:number,dsCapGB:number}>} points 시간 오름차순
 */
export function growth(points) {
  const arr = (points || []).filter(hasDsData); // 구버전(ds 열 0) 행은 기준·기간에서 제외
  const first = arr[0] || null;
  const last = arr[arr.length - 1] || null;
  if (!first || !last) return { spanDays: 0, netGB: 0, perDayGB: 0, freeGB: 0, fullDays: null };
  const spanDays = last.collectedAt > first.collectedAt
    ? Math.max(0.5, (last.collectedAt - first.collectedAt) / 86_400_000) : 0;
  const netGB = Math.round(((last.dsUsedGB || 0) - (first.dsUsedGB || 0)) * 10) / 10;
  const perDayGB = spanDays > 0 ? Math.round((netGB / spanDays) * 10) / 10 : 0;
  const freeGB = Math.max(0, (last.dsCapGB || 0) - (last.dsUsedGB || 0));
  return { spanDays, netGB, perDayGB, freeGB, fullDays: perDayGB > 0 ? Math.round(freeGB / perDayGB) : null };
}
