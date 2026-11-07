// ESXi 경로 카운터 표본 이력(v2.929 C-①) — 호스트 id 별 최근 표본 몇 개(매시 1개 기본)를 인메모리로 모은다.
// 왜: host.spath 는 '가장 최근 표본' 하나다. 24h · 7d 기간을 그 한 표본의 비율로 나누면 하루 중 바뀐 배합을 못 본다 —
//   그래서 기간 안 표본들의 타깃별 전송량(KB)을 더해 비율을 만든다(표본이 많을수록 기간 전체에 가깝다).
// 원천은 **이 노드의 스냅샷**(store.get().hosts) — 중앙 직접 수집 호스트와 엣지가 push 한 호스트가 같은 곳에 있다(엣지 경로에 새 계약이 없다).
// 재시작하면 비고 매시 다시 찬다 — 화면은 표본 수를 함께 말한다(0 이 아니라 '표본 N개').
// 메모리: 호스트 × HIST_MAX × 타깃(≤64). 658대 × 26 × 평균 8 ≈ 14만 항목.

export const HIST_MAX = 26;          // 호스트당 표본 수 상한(매시 1개면 약 하루 + 여유)
export const SWEEP_MS = 5 * 60_000;  // 스냅샷을 훑는 주기

const _byHost = new Map();   // hostId -> [{ at, samples, sampleSec, t: Map(`${adapter}|${wwn}` -> kb) }] (오래된 것 먼저)
let _timer = null;

const keyOf = (t) => `${t?.adapter || t?.init || '?'}|${t?.wwn}`;

/** 스냅샷 호스트들의 spath 를 이력에 넣는다(같은 at 은 한 번만). 스냅샷에서 사라진 호스트의 이력은 버린다. */
export function recordHosts(hosts = []) {
  const live = new Set();
  let added = 0;
  for (const h of Array.isArray(hosts) ? hosts : []) {
    if (!h || h.id == null) continue;
    const id = String(h.id);
    live.add(id);
    const sp = h.spath;
    const at = Number(sp?.at);
    if (!sp || !Number.isFinite(at) || !Array.isArray(sp.targets)) continue;
    let arr = _byHost.get(id);
    if (!arr) { arr = []; _byHost.set(id, arr); }
    if (arr.some((x) => x.at === at)) continue;
    const t = new Map();
    for (const x of sp.targets) {
      if (!x || typeof x.wwn !== 'string') continue;
      const kb = (Number.isFinite(x.readKB) ? x.readKB : 0) + (Number.isFinite(x.writeKB) ? x.writeKB : 0);
      const has = Number.isFinite(x.readKB) || Number.isFinite(x.writeKB);
      if (!has) continue;   // 값이 하나도 없는 타깃은 0 이 아니라 '모름' — 넣지 않는다
      t.set(keyOf(x), (t.get(keyOf(x)) || 0) + kb);
    }
    arr.push({ at, samples: Number(sp.samples) || 0, sampleSec: Number(sp.sampleSec) || 20, t });
    arr.sort((a, b) => a.at - b.at);
    while (arr.length > HIST_MAX) arr.shift();
    added += 1;
  }
  for (const id of [..._byHost.keys()]) if (!live.has(id)) _byHost.delete(id);
  return added;
}

/**
 * 기간 [since, until] 안 표본의 타깃별 전송량 합 → { kb: Map(`${adapter}|${wwn}` -> KB), samples, firstAt, lastAt } · 표본이 없으면 null.
 * since·until 은 ms(없으면 제한 없음).
 */
export function weightsFor(hostId, { since = null, until = null } = {}) {
  const arr = _byHost.get(String(hostId));
  if (!arr || !arr.length) return null;
  const kb = new Map();
  let n = 0; let firstAt = null; let lastAt = null;
  for (const s of arr) {
    if (since != null && s.at < since) continue;
    if (until != null && s.at > until) continue;
    n += 1;
    firstAt = firstAt == null ? s.at : Math.min(firstAt, s.at);
    lastAt = lastAt == null ? s.at : Math.max(lastAt, s.at);
    for (const [k, v] of s.t) kb.set(k, (kb.get(k) || 0) + v);
  }
  return n ? { kb, samples: n, firstAt, lastAt } : null;
}

/** 상태(서비스 점검) — 이력을 가진 호스트 수 · 표본 합. */
export function historyStatus() {
  let samples = 0;
  for (const arr of _byHost.values()) samples += arr.length;
  return { hosts: _byHost.size, samples, max: HIST_MAX, running: !!_timer };
}

/** 주기 훑기 시작(한 번만). getHosts 는 지금 스냅샷 호스트 배열을 돌려준다. */
export function startStorPathHistory(getHosts) {
  if (_timer) return;
  const run = () => { try { recordHosts(getHosts() || []); } catch (e) { console.warn(`[storpath] 표본 이력 갱신 실패: ${e.message}`); } };
  _timer = setInterval(run, SWEEP_MS);
  _timer.unref?.();
  setTimeout(run, 30_000).unref?.();
}
export function _resetStorPathHistory() { _byHost.clear(); if (_timer) clearInterval(_timer); _timer = null; }
