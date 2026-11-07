/**
 * bmusage/maint/deploy.js — 8a단계 정비 창 **중앙 → 엣지 배포**(15차 · 7b 배포 경로와 같은 꼴: 엣지가 주기 인출 · 개별 토큰으로 인증된 이름에만 · 결과는 다음 인출의 쿼리).
 *
 *   · 엣지는 **자기 법인 창만** 받는다 — 법인 = ‘중앙에서 켜기’ 와 같은 매핑(edgeCorps.edgeCorpsSource) ∪ 그 엣지가 봉투로 보고한 대상의 법인.
 *   · 서버 창은 그 법인이거나 키가 그 엣지 대상에 있을 때 · 태그 창은 중앙이 **그 엣지 대상 중 그 태그(수동 용도 태그)를 가진 서버 키로 펼친다**
 *     (엣지에는 중앙 태그가 없다 — 판정 코어는 같은 함수 maint/judge.js 이고 엣지 입력은 펼친 keys).
 *   · 진행 중 · 예정 창만(끝난 · 만료 · 지운 창은 보내지 않는다 — 엣지가 억제할 일이 없다). 이력(edits)은 싣지 않는다.
 *   · 공유 토큰(`?agent=` 를 댈 수 있다)에는 주지 않는다(distribute:false — 엣지는 지난 배포본을 TTL 까지만 쓴다).
 *   · 중앙 창 파일을 못 읽으면 라우트가 503(빈 목록을 보내 엣지 억제를 지우지 않는다 · 엣지는 TTL 까지 지난 배포본).
 * 엣지 쪽은 agent/bmMaintPull.js → store.saveDeployed(같은 normalizeWindow 로 다시 자름).
 */
import crypto from 'node:crypto';
import { listWindows } from './store.js';
import { windowStatus } from './judge.js';
import { tagsReader } from './runtime.js';

const t = (v) => String(v ?? '').trim();
const SEND_FIELDS = ['id', 'name', 'reason', 'target', 'vcenterId', 'tz', 'schedule', 'scopes', 'rev', 'by', 'at', 'approvedBy', 'confirmedAt', 'endedAt', 'endedBy', 'endedOccStart'];
export const sigOf = (list) => crypto.createHash('md5').update(JSON.stringify(list)).digest('hex');

/**
 * 한 엣지에 보낼 창(순수에 가까움 — 입력 주입).
 * @param {{ windows:Array, corps:Set<string>, edgeTargets:Array<{key,serviceTag,vcenterId}>, tagsOf:(t)=>string[], now:number }} p
 */
export function windowsForEdge({ windows = [], corps = new Set(), edgeTargets = [], tagsOf = () => [], now = Date.now() } = {}) {
  const keys = new Set(edgeTargets.map((x) => t(x.key)).filter(Boolean));
  const out = [];
  for (const w of windows) {
    if (!w || w.deleted || w.origin === 'central') continue;
    const st = windowStatus(w, now).status;
    if (st !== 'active' && st !== 'scheduled') continue;
    const pick = Object.fromEntries(SEND_FIELDS.filter((k) => w[k] !== undefined).map((k) => [k, w[k]]));
    if (w.target.kind === 'corp') { if (corps.has(w.vcenterId)) out.push(pick); continue; }
    if (w.target.kind === 'server') { if (corps.has(w.vcenterId) || (w.target.keys || []).some((k) => keys.has(k))) out.push(pick); continue; }
    if (w.target.kind === 'tag' && corps.has(w.vcenterId)) {
      const ks = edgeTargets.filter((x) => t(x.vcenterId) === w.vcenterId && (tagsOf(x) || []).includes(w.target.tag)).map((x) => t(x.key)).filter(Boolean);
      out.push({ ...pick, target: { kind: 'tag', tag: w.target.tag, keys: [...new Set(ks)].slice(0, 5_000) } });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const _pulls = new Map();   // agent(소문자) → { at, appliedSig, version, n }
export function recordMaintPull(agent, { appliedSig = '', version = '', n = null } = {}) {
  const k = t(agent).toLowerCase(); if (!k) return;
  _pulls.set(k, { at: Date.now(), appliedSig: /^[0-9a-f]{32}$/.test(appliedSig) ? appliedSig : '', version: t(version).slice(0, 32), ...(n != null ? { n } : {}) });
  if (_pulls.size > 512) _pulls.delete(_pulls.keys().next().value);
}

/** 엣지의 법인 · 대상(중앙 보관분). */
async function edgeContext(agent) {
  const corps = new Set();
  try { const { edgeCorpsSource } = await import('../edgeCorps.js'); for (const c of edgeCorpsSource()(agent) || []) corps.add(String(c)); } catch { /* 매핑을 모르면 봉투 법인만 */ }
  let edgeTargets = [];
  try {
    const rec = (await import('../../central/bmUsageEdgePull.js')).getEdgeBmUsage(agent);
    edgeTargets = (rec?.snap?.targets || []).map((x) => ({ key: t(x.key), serviceTag: t(x.serviceTag), vcenterId: t(x.vcenterId) }));
    for (const x of edgeTargets) if (x.vcenterId) corps.add(x.vcenterId);
  } catch { edgeTargets = []; }
  return { corps, edgeTargets };
}

/**
 * 인출 응답 본문(라우트). 창 파일을 못 읽으면 던진다(라우트가 503).
 * @returns {Promise<{distribute:boolean, reason?:string, sig?:string, windows?:Array}>}
 */
export async function deployFor(agent, { verified = false, now = Date.now() } = {}) {
  if (!verified) return { distribute: false, reason: 'unverified' };
  const windows = listWindows();
  const { corps, edgeTargets } = await edgeContext(agent);
  const tagsOf = await tagsReader();
  const list = windowsForEdge({ windows, corps, edgeTargets, tagsOf, now });
  return { distribute: true, sig: sigOf(list), windows: list };
}

/**
 * 배포 현황(중앙 화면 — 전체 범위만) — 인출 기록 + 엣지 봉투의 배포본 상태. 상태: applied(지금 보낼 판 = 엣지가 적용한 판) · pending(다른 판) ·
 *   never(인출 기록 없음 — 이 중앙 기동 뒤) · old(봉투에 8a 표지 없음 — 구버전 엣지). 판정은 인출 응답과 같은 함수(windowsForEdge → sigOf).
 */
export async function deployStatusView(edges = [], now = Date.now()) {
  const rows = [];
  let windows = [];
  try { windows = listWindows(); } catch { windows = null; }
  const tagsOf = await tagsReader();
  const names = new Set([..._pulls.keys(), ...edges.map((r) => t(r.agent).toLowerCase())]);
  for (const k of [...names].filter(Boolean).sort().slice(0, 256)) {
    const p = _pulls.get(k) || null;
    const rec = edges.find((r) => t(r.agent).toLowerCase() === k);
    const env = rec?.snap?.maint || null;
    const maintVer = Number.isInteger(rec?.snap?.maintVer) ? rec.snap.maintVer : null;
    let expectSig = null;
    if (windows) { const ctx = await edgeContext(rec?.agent || k); expectSig = sigOf(windowsForEdge({ windows, ...ctx, tagsOf, now })); }
    const status = rec && maintVer == null ? 'old' : !p ? 'never' : (expectSig && p.appliedSig === expectSig ? 'applied' : 'pending');
    rows.push({ agent: rec?.agent || k, status, lastPullAt: p?.at ?? null, version: p?.version || '',
      envelope: env ? { deployedAt: env.deployed?.at ?? null, n: env.deployed?.n ?? null, stale: env.deployed?.stale ?? null, unreadable: !!env.deployed?.unreadable, leak: env.leak?.n ?? null } : null, maintVer });
  }
  return { edges: rows, now, ...(windows ? {} : { unreadable: true }) };
}
export function _resetMaintDeployForTest() { _pulls.clear(); }
