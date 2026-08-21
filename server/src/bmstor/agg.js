/**
 * bmstor/agg.js — 베어메탈 스토리지 합산(순수 함수, v2.340). 서버별(자기 마운트 합) →
 * 그룹별(사용자 요구 — 그룹 설정 시 합산 표시) → 전체 순으로 총/사용/가용을 더한다.
 * 오류 서버는 합계에서 제외하되 개수·사유를 정직하게 노출한다(축소 보고 금지).
 */

const pct = (used, total) => (total > 0 ? Math.round((used / total) * 1000) / 10 : 0);
const zero = () => ({ totalBytes: 0, usedBytes: 0, availBytes: 0 });

// 서버당 그룹 상한(v2.344, 사용자 요구 — 한 서버가 여러 합산 그룹에 속할 수 있게).
export const MAX_GROUPS_PER_SERVER = 3;

/**
 * 그룹 입력 정규화(순수 — registry 저장·CSV 가져오기 공용 단일 소스).
 * 배열 또는 문자열(쉼표/세미콜론/줄바꿈 구분)을 받아 trim·중복 제거하고 상한을 검증한다.
 * @returns {{groups:string[], error:string|null}}
 */
export function normalizeBmGroups(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[,;\n]/);
  const groups = []; const seen = new Set();
  for (const g of raw.map((s) => String(s).trim()).filter(Boolean)) {
    if (g.length > 64 || [...g].some((c) => c.charCodeAt(0) < 32)) return { groups: [], error: `그룹 이름이 올바르지 않습니다: ${g.slice(0, 40)}` };
    const k = g.toLowerCase();
    if (!seen.has(k)) { seen.add(k); groups.push(g); }
  }
  if (groups.length > MAX_GROUPS_PER_SERVER) return { groups: [], error: `그룹은 서버당 최대 ${MAX_GROUPS_PER_SERVER}개입니다(입력 ${groups.length}개).` };
  return { groups, error: null };
}

/** 서버 레코드의 그룹 배열 — 신형 groups 배열 우선, 구형 단일 group 문자열 하위호환. */
export const groupsOf = (s) => (Array.isArray(s?.groups) && s.groups.length ? s.groups : (s?.group ? [s.group] : []));

/**
 * @param {Array} servers listServers() 결과(redact — id·name·group·agent·mounts·enabled)
 * @param {Map<string,object>} latest id → collectServer 결과(+at). 없으면 '미수집'.
 * @returns {{ total, groups, perServer }}
 */
export function aggregate(servers, latest) {
  const perServer = [];
  const groupMap = new Map();
  const total = { ...zero(), servers: 0, ok: 0, errors: 0, pending: 0 };

  for (const s of servers || []) {
    const r = (latest && latest.get(s.id)) || null;
    const sums = zero();
    for (const m of r?.mounts || []) {
      sums.totalBytes += m.totalBytes || 0;
      sums.usedBytes += m.usedBytes || 0;
      sums.availBytes += m.availBytes || 0;
    }
    const groups = groupsOf(s);
    const row = {
      id: s.id, name: s.name || s.host, host: s.host,
      groups, group: groups.join(', '), // group(문자열)은 표시/하위호환용 — 진실은 groups 배열
      agent: s.agent || '',
      enabled: s.enabled !== false, mountCount: (s.mounts || []).length,
      ...sums, usedPct: pct(sums.usedBytes, sums.totalBytes),
      ok: !!r?.ok, error: r?.error || null, missing: r?.missing || [], at: r?.at || null,
      mounts: r?.mounts || [],
    };
    perServer.push(row);
    if (s.enabled === false) continue;      // 비활성 서버는 합계·그룹에서 제외(표에는 남김)
    total.servers++;
    if (!r) { total.pending++; }
    else if (r.ok) {
      total.ok++;
      total.totalBytes += sums.totalBytes; total.usedBytes += sums.usedBytes; total.availBytes += sums.availBytes;
    } else total.errors++;

    // 멀티 그룹(v2.344): 서버가 속한 '모든' 그룹에 합산된다 — 그룹 표의 합이 전체 KPI 보다
    // 클 수 있음(의도: 그룹은 관점별 묶음이지 분할이 아님). 전체 KPI 는 서버당 1회만 집계.
    for (const g of groups.length ? groups : ['']) {
      if (!groupMap.has(g)) groupMap.set(g, { name: g || '(그룹 없음)', servers: 0, ok: 0, errors: 0, pending: 0, ...zero() });
      const gm = groupMap.get(g);
      gm.servers++;
      if (!r) gm.pending++;
      else if (r.ok) { gm.ok++; gm.totalBytes += sums.totalBytes; gm.usedBytes += sums.usedBytes; gm.availBytes += sums.availBytes; }
      else gm.errors++;
    }
  }

  const groups = [...groupMap.values()]
    .map((g) => ({ ...g, usedPct: pct(g.usedBytes, g.totalBytes) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { total: { ...total, usedPct: pct(total.usedBytes, total.totalBytes) }, groups, perServer };
}
