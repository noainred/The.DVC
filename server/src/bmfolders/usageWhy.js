/**
 * bmfolders/usageWhy.js — 물리서버 폴더 **값 없음 사유**(v2.992 · 설계 docs/design/bm-folders §12). 판정은 서버 — 화면은 코드를 글자로 바꿀 뿐이다.
 *
 * 사용률(CPU · 메모리)이 없는 칸의 사유 코드. 근거는 베어메탈 사용률 대상 해석(`bmusage/poller.js currentTargets` — 누락 점검과 같은 입력 · 같은 사유 코드)이다.
 *   off              — 이 노드의 베어메탈 사용률 수집이 꺼져 있다(엣지가 수집하는 서버는 그 엣지 설정이라 이 코드가 아니다)
 *   <NO_PATH 코드>     — 수집 대상에서 빠진 이유(corp-off · unassigned · no-idrac · no-idrac-cred · no-os-cred · both-off · os-ambiguous · os-foreign · key-conflict · remote-collector-unknown)
 *   edge-no-record   — 엣지가 수집하는 서버인데 중앙에 그 엣지 값이 없다(엣지 보관분 · 엣지 설정은 여기서 모른다)
 *   no-record        — 수집 대상인데 기록이 없다(등록 직후 · 주기 전 · 수집 실패 — 실패 원문은 서버별로 남기지 않는다: collectHealth 머리말)
 *   stale            — 마지막 값이 오래됐다(사용률 판정 stale — at 이 마지막 값 시각)
 *   powered-off      — 꺼진 서버(전원 상태를 읽었고 꺼짐)
 *   vc-unread        — ESXi 호스트: vCenter 를 지금 읽지 못한다(값은 vCenter 것)
 *   unknown          — 위 어느 것도 아니다 — **원인을 단정하지 않는다**('이유를 확인하지 못했습니다')
 * 문구에 계정 이름 · 주소 · 엣지 이름을 싣지 않는다(코드만) — 판본(관리자 · 범위 계정) 구분 없이 같은 값.
 */
const t = (v) => String(v ?? '').trim();

export const WHY_CODES = Object.freeze(['off', 'corp-off', 'unassigned', 'no-idrac', 'no-idrac-cred', 'no-os-cred', 'both-off', 'os-ambiguous', 'os-foreign', 'key-conflict',
  'remote-collector-unknown', 'edge-no-record', 'no-record', 'stale', 'powered-off', 'vc-unread', 'unknown']);
const SKIP_PASS = new Set(WHY_CODES);

/** 대상 해석 결과 → 사유 색인(순수). currentTargets 실패면 null(사유 'unknown'). */
export function whyIndexOf(tg) {
  if (!tg || typeof tg !== 'object') return null;
  const skipped = new Map();
  for (const s of Array.isArray(tg.skipped) ? tg.skipped : []) {
    const k = t(s?.key); if (!k) continue;
    skipped.set(k, t(s.reason));
  }
  const targets = new Set((Array.isArray(tg.targets) ? tg.targets : []).map((x) => t(x?.key)).filter(Boolean));
  return { off: tg.settings?.enabled !== true, skipped, targets };
}

/**
 * 구성원 하나의 사용률 사유(순수). 값이 있으면(state ok) null.
 * @param {object} m   membersOf 구성원(kind · usage · usageKey · powered · remoteAgent · source)
 * @param {object|null} ix whyIndexOf 결과
 */
export function usageWhyOf(m, ix) {
  const u = m?.usage || {};
  if (u.state === 'ok' && (u.cpuPct != null || u.memPct != null)) return null;
  if (u.state === 'stale') return { code: m?.kind === 'esxi' && u.vcUnread ? 'vc-unread' : 'stale', ...(Number(u.at) > 0 ? { at: Number(u.at) } : {}) };
  if (m?.powered === false) return { code: 'powered-off' };
  if (m?.kind === 'esxi') return { code: 'unknown' };   // ESXi 는 vCenter 값 — 베어메탈 대상 해석의 사유가 맞지 않는다
  if (!ix) return { code: 'unknown' };
  const k = t(m?.usageKey);
  const sk = k ? ix.skipped.get(k) : undefined;
  if (sk === 'edge-delegated') return { code: 'edge-no-record' };
  if (sk && SKIP_PASS.has(sk)) return { code: sk };
  if (k && ix.targets.has(k)) return { code: ix.off ? 'off' : 'no-record' };
  if (ix.off) return { code: 'off' };
  return { code: 'unknown' };
}

/** 사유 코드별 개수(묶음 띠). */
export function whyCounts(rows) {
  const c = {};
  for (const r of rows || []) { const code = r?.why?.code; if (code) c[code] = (c[code] || 0) + 1; }
  return c;
}

/* 대상 해석 memo — 물리서버 폴더 응답마다 대상을 다시 풀지 않는다(성공 60초 · 실패 15초 · 진행 중 공유). */
let _memo = null; let _inflight = null;
export async function currentWhyIndex({ now = Date.now(), load = null } = {}) {
  if (_memo && now - _memo.at < (_memo.ix ? 60_000 : 15_000)) return _memo.ix;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    let ix = null;
    try {
      const fn = load || (await import('../bmusage/poller.js')).currentTargets;
      ix = whyIndexOf(await fn());
    } catch { ix = null; }
    _memo = { at: Date.now(), ix };
    return ix;
  })().finally(() => { _inflight = null; });
  return _inflight;
}
export function _resetWhyMemoForTest() { _memo = null; _inflight = null; }
