/**
 * bmstor/agg.js — 베어메탈 스토리지 합산(순수 함수, v2.340). 서버별(자기 마운트 합) →
 * 그룹별(사용자 요구 — 그룹 설정 시 합산 표시) → 전체 순으로 총/사용/가용을 더한다.
 * 오류 서버는 합계에서 제외하되 개수·사유를 정직하게 노출한다(축소 보고 금지).
 */

const pct = (used, total) => (total > 0 ? Math.round((used / total) * 1000) / 10 : 0);
const zero = () => ({ totalBytes: 0, usedBytes: 0, availBytes: 0 });

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
    const row = {
      id: s.id, name: s.name || s.host, host: s.host, group: s.group || '', agent: s.agent || '',
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

    const g = s.group || '';
    if (!groupMap.has(g)) groupMap.set(g, { name: g || '(그룹 없음)', servers: 0, ok: 0, errors: 0, pending: 0, ...zero() });
    const gm = groupMap.get(g);
    gm.servers++;
    if (!r) gm.pending++;
    else if (r.ok) { gm.ok++; gm.totalBytes += sums.totalBytes; gm.usedBytes += sums.usedBytes; gm.availBytes += sums.availBytes; }
    else gm.errors++;
  }

  const groups = [...groupMap.values()]
    .map((g) => ({ ...g, usedPct: pct(g.usedBytes, g.totalBytes) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { total: { ...total, usedPct: pct(total.usedBytes, total.totalBytes) }, groups, perServer };
}
