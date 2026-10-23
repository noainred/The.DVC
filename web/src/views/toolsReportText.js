/**
 * 운영 리포트(ToolsReports) · 인사이트 카드의 부가 문구 — 판정·문구는 여기 하나(v2.630 UI2630-02).
 * 서버(v2.629)가 싣는 needUpgradeOmitted·oldOmitted·toolsNotCollected·snapshotInPoweredOffGB·reclaimBasis 를
 * 화면이 읽지 않아 ① 목록이 상한으로 잘려도 말하지 않았고 ② '회수 가능' 설명이 서버 계산과 달랐고
 * ③ Tools 미수집 VM 이 KPI 어디에도 없었고 ④ 인사이트의 회수 가능이 순간값 기준이라는 사실이 없었다.
 * 값이 없으면 null(문구를 띄우지 않는다) — 0 을 지어내지 않는다.
 */

const posInt = (v) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

/** 목록이 서버 상한(listLimit)으로 잘렸을 때 한 줄. 잘리지 않았으면 null. */
export function listOmittedNote(omitted, listLimit, unit = '대') {
  const o = posInt(omitted);
  if (o == null) return null;
  const lim = posInt(listLimit);
  return `외 ${o}${unit}는 표시하지 않았습니다(목록 상한 ${lim != null ? `${lim}${unit}` : '적용'}) — 위 개수(KPI)는 전체 기준입니다.`;
}

/**
 * KPI '회수 가능(추정)' 설명. 서버 계산은 정지 VM 디스크 + (정지 VM 에 속하지 않은) 스냅샷 델타다 —
 * 정지 VM 디스크(committed)가 그 VM 의 스냅샷 델타를 이미 포함하므로 겹친 몫을 두 번 세지 않는다.
 * 옆 KPI '정지 VM 점유' + '스냅샷 델타' 의 합과 다른 이유를 겹친 크기로 밝힌다.
 */
export function reclaimMeta(summary, fmt = (gb) => `${gb} GB`) {
  const base = '정지 VM 디스크 + 정지 VM 에 속하지 않은 스냅샷 델타';
  const over = summary?.snapshotInPoweredOffGB;
  let out = base;
  if (typeof over === 'number' && Number.isFinite(over) && over > 0) out = `${base}(겹친 ${fmt(over)} 제외)`;
  // v2.727(C-01): 디스크 용량을 못 읽은 정지 VM 은 회수량에서 뺐다(0 으로 채우지 않음) — 그 수를 말한다.
  const unk = summary?.poweredOffStorageUnknown;
  if (typeof unk === 'number' && Number.isFinite(unk) && unk > 0) out += ` · 용량 미상 정지 VM ${unk}대 제외`;
  return out;
}

/** Tools 업그레이드 KPI 부가 설명 — Tools 상태를 못 읽은(미수집) VM 은 업그레이드 필요 판정에 들지 않는다. */
export function toolsKpiMeta(summary) {
  const n = posInt(summary?.toolsNotCollected);
  return n != null ? `Tools 상태 미수집 ${n}대 — 판정에서 빠짐` : null;
}

/** 인사이트 '회수 가능(추정)' 카드 설명 — 사용률이 순간값이면 그렇게 말한다. */
export function reclaimBasisNote(rs) {
  const ram = rs?.reclaimableRamGB;
  const ramText = typeof ram === 'number' && Number.isFinite(ram) ? `${ram} GB RAM` : 'RAM —';
  if (rs?.reclaimBasis === 'instant') return `${ramText} · 순간 사용률 기준(기간 통계는 라이트사이징 리포트)`;
  return ramText;
}

/**
 * v2.632 WEB2632-04: 용량 고갈 예측 목록이 서버 상한(listLimit)에 닿았을 때 한 줄. 서버는 잘리기 전 개수를
 * 모르므로(상한에 닿았는지만 안다) 개수를 지어내지 않고 '더 있을 수 있다' 고 말한다. 닿지 않았으면 null.
 */
export function forecastCapNote(data) {
  if (!data || data.datastoresCapped !== true) return null;
  const lim = posInt(data.listLimit);
  return `추세 산출 데이터스토어가 목록 상한(${lim != null ? `${lim}개` : '적용'})에 닿았습니다 — 고갈이 빠른 순으로 상한까지만 표시하며, 표시하지 않은 데이터스토어가 더 있을 수 있습니다.`;
}

/**
 * v2.772(Z4-3): 구성 변경 이력이 스캔 상한에 닿았을 때 한 줄 — 상한에 닿지 않았으면 null.
 * 서버는 기간 안 **모든 종류** 이벤트의 최신 scanMax 행만 읽고 변경 종류·분류·계정·대상을 거른다. 예전 안내 '기간을 줄이세요' 는 틀렸다 —
 * 이벤트가 많은 현장에서는 1일로 줄여도 최근 한 시간 남짓만 본다. 실제로 훑은 행의 시각 범위(scannedFrom ~ scannedTo)를 말한다.
 * fmt 는 시각 문구(화면의 fmtDate). 시각을 모르면 범위 없이 말한다(지어내지 않는다).
 */
export function changeScanNote(data, fmt = (ts) => new Date(ts).toLocaleString('ko-KR')) {
  if (!data || data.truncated !== true) return null;
  const from = typeof data.scannedFrom === 'number' && Number.isFinite(data.scannedFrom) ? data.scannedFrom : null;
  const to = typeof data.scannedTo === 'number' && Number.isFinite(data.scannedTo) ? data.scannedTo : null;
  const max = posInt(data.scanMax) ?? posInt(data.scanned);
  const range = from != null && to != null ? ` — ${fmt(from)} ~ ${fmt(to)} 만 봤습니다` : '';
  return `스캔 상한(최신 ${max != null ? `${max.toLocaleString()}행` : '상한'})에 닿았습니다${range}. 그보다 앞의 변경은 이 결과에 없고, 분류·계정·대상 필터도 이 범위 안에서만 찾습니다(상한은 종류와 무관한 최신 행 수라 기간을 줄여도 범위가 넓어지지 않을 수 있습니다). VM 의 이동·구성 변경은 특수 기능 'VM 이동·구성 변경 이력' 이 기간 전체를 봅니다.`;
}
