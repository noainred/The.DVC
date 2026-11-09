/**
 * bmusage/maint/deploy.js — 8a단계 정비 창 **중앙 → 엣지 배포**(15차 · 7b 배포 경로와 같은 꼴: 엣지가 주기 인출 · 개별 토큰으로 인증된 이름에만 · 결과는 다음 인출의 쿼리).
 *
 *   · 엣지는 **자기 법인 창만** 받는다 — 법인 = ‘중앙에서 켜기’ 와 같은 매핑(edgeCorps.edgeCorpsSource) ∪ 그 엣지가 봉투로 보고한 대상의 법인.
 *   · 서버 창도 **그 법인일 때만**(반증 F1 — 키만 겹친다고 보내지 않는다: IP 키는 법인끼리 겹친다 · 서버 대상은 (법인, 키) 쌍) ·
 *     태그 창은 중앙이 **그 엣지 대상 중 그 법인 · 그 태그(수동 용도 태그)를 가진 서버 키로 펼친다**
 *     (엣지에는 중앙 태그가 없다 — 판정 코어는 같은 함수 maint/judge.js 이고 엣지 입력은 펼친 keys).
 *   · 진행 중 · 예정 창만(끝난 · 만료 · 지운 창은 보내지 않는다 — 엣지가 억제할 일이 없다). 이력(edits)은 싣지 않는다.
 *   · 공유 토큰(`?agent=` 를 댈 수 있다)에는 주지 않는다(distribute:false — 엣지는 지난 배포본을 TTL 까지만 쓴다).
 *   · 중앙 창 파일을 못 읽으면 라우트가 503(빈 목록을 보내 엣지 억제를 지우지 않는다 · 엣지는 TTL 까지 지난 배포본).
 * 엣지 쪽은 agent/bmMaintPull.js → store.saveDeployed(같은 normalizeWindow 로 다시 자름).
 * ⚠ v2.954(점검 D-1): 태그 창의 keys 는 중앙이 그 엣지 대상(엣지 봉투 — central/bmUsageEdgePull 인메모리 · 사람이 인출할 때만 채워진다)으로 펼친다.
 *   중앙 재시작 뒤 · 첫 인출 전에는 대상을 **모른다** — 그때 그 엣지 법인에 살아 있는 태그 창이 있으면 빈 keys 로 배포하지 않고 보류한다
 *   (distribute:false · reason 'targets-unknown' — 엣지는 지난 배포본을 받은 지 24시간까지 쓴다). 보류에는 시한(TARGETS_HOLD_MS — 엣지 TTL 보다 짧게):
 *   넘기면 예전처럼 배포한다(새 창 · 끝낸 창이 엣지에 닿지 못하는 상태를 끝없이 끌지 않는다 — 그 판의 태그 창은 대상 0대). 배포 현황은 'targets-unknown' 으로 따로 말한다.
 * ⚠ 요청 경로 비용(반증 F6): 창 상태(진행 중 · 예정)는 **요청마다 한 번**(liveWindows — 시간 기준 양보) 계산하고 엣지마다 그 결과를 다시 쓴다
 *   (배포 현황이 엣지 28곳마다 전 창을 다시 세지 않는다).
 */
import crypto from 'node:crypto';
import { listWindows, DEPLOY_TTL_MS } from './store.js';
import { windowStatus } from './judge.js';
import { tagsReader } from './runtime.js';
import { createYielder } from '../../util/timeSlice.js';

const t = (v) => String(v ?? '').trim();
const SEND_FIELDS = ['id', 'name', 'reason', 'target', 'vcenterId', 'tz', 'schedule', 'scopes', 'rev', 'by', 'at', 'approvedBy', 'confirmedAt', 'endedAt', 'endedBy', 'endedOccStart'];
export const sigOf = (list) => crypto.createHash('md5').update(JSON.stringify(list)).digest('hex');

/** 보낼 수 있는 창(진행 중 · 예정 — 이 노드의 창 · 지우지 않음) — 요청마다 한 번(시간 기준 양보). */
export async function liveWindows(windows = [], now = Date.now(), { yieldFn = createYielder(15) } = {}) {
  const out = [];
  for (const w of windows || []) {
    if (!w || w.deleted || w.origin === 'central') continue;
    const st = windowStatus(w, now).status;
    if (st === 'active' || st === 'scheduled') out.push(w);
    await yieldFn();
  }
  return out;
}

/**
 * 한 엣지에 보낼 창(순수 — 입력 주입). live = liveWindows 결과(엣지마다 다시 세지 않는다).
 * @param {{ live:Array, corps:Set<string>, edgeTargets:Array<{key,serviceTag,vcenterId}>, tagsOf:(t)=>string[] }} p
 */
export function windowsForEdge({ live = [], corps = new Set(), edgeTargets = [], tagsOf = () => [] } = {}) {
  const out = [];
  for (const w of live) {
    const pick = Object.fromEntries(SEND_FIELDS.filter((k) => w[k] !== undefined).map((k) => [k, w[k]]));
    if (!corps.has(w.vcenterId)) continue;   // 모든 종류 — 그 법인을 맡은 엣지에만
    if (w.target.kind === 'corp' || w.target.kind === 'server') { out.push(pick); continue; }
    if (w.target.kind === 'tag') {
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

/** 엣지의 법인 · 대상(중앙 보관분). targetsKnown = 중앙이 그 엣지 봉투(대상 목록)를 한 번이라도 받았는가(v2.954 점검 D-1). */
async function edgeContext(agent) {
  const corps = new Set();
  try { const { edgeCorpsSource } = await import('../edgeCorps.js'); for (const c of edgeCorpsSource()(agent) || []) corps.add(String(c)); } catch { /* 매핑을 모르면 봉투 법인만 */ }
  let edgeTargets = []; let targetsKnown = false;
  try {
    const rec = (await import('../../central/bmUsageEdgePull.js')).getEdgeBmUsage(agent);
    targetsKnown = !!rec?.snap && Array.isArray(rec.snap.targets);
    edgeTargets = (rec?.snap?.targets || []).map((x) => ({ key: t(x.key), serviceTag: t(x.serviceTag), vcenterId: t(x.vcenterId) }));
    for (const x of edgeTargets) if (x.vcenterId) corps.add(x.vcenterId);
  } catch { edgeTargets = []; targetsKnown = false; }
  return { corps, edgeTargets, targetsKnown };
}

/** v2.954(점검 D-1): 대상을 모르는데 그 엣지 법인에 살아 있는 태그 창이 있는가(순수) — 있으면 빈 keys 로 펼치게 된다. */
export function tagWindowsBlind({ live = [], corps = new Set(), targetsKnown = false } = {}) {
  if (targetsKnown) return false;
  return live.some((w) => w?.target?.kind === 'tag' && corps.has(w.vcenterId));
}
/** 보류 시한 — 엣지 배포본 TTL(24h)보다 짧게(보류가 끝나기 전에 엣지 배포본이 먼저 만료되지 않게). */
export const TARGETS_HOLD_MS = Math.floor(DEPLOY_TTL_MS / 2);
const _blindSince = new Map();   // agent(소문자) → 처음 '대상 모름 + 태그 창' 을 본 시각(인메모리 — 중앙 재시작이 곧 시작점)
function blindHold(agent, blind, now) {
  const k = t(agent).toLowerCase();
  if (!blind) { _blindSince.delete(k); return { hold: false }; }
  if (!_blindSince.has(k)) { _blindSince.set(k, now); if (_blindSince.size > 512) _blindSince.delete(_blindSince.keys().next().value); }
  const since = _blindSince.get(k);
  return { hold: now - since < TARGETS_HOLD_MS, since };
}

/**
 * 인출 응답 본문(라우트). 창 파일을 못 읽으면 던진다(라우트가 503).
 * @returns {Promise<{distribute:boolean, reason?:string, sig?:string, windows?:Array}>}
 */
export async function deployFor(agent, { verified = false, now = Date.now() } = {}) {
  if (!verified) return { distribute: false, reason: 'unverified' };
  const windows = listWindows();
  const { corps, edgeTargets, targetsKnown } = await edgeContext(agent);
  const tagsOf = await tagsReader();
  const live = await liveWindows(windows, now);
  // v2.954(점검 D-1): 대상을 모르는 채 태그 창을 빈 keys 로 보내면 엣지 억제(알림 · 수집 · 집중)가 꺼진다 — 시한 안에서는 보류
  const bh = blindHold(agent, tagWindowsBlind({ live, corps, targetsKnown }), now);
  if (bh.hold) return { distribute: false, reason: 'targets-unknown' };
  const list = windowsForEdge({ live, corps, edgeTargets, tagsOf });
  return { distribute: true, sig: sigOf(list), windows: list, ...(bh.since != null ? { targetsUnknown: true } : {}) };
}

/**
 * 배포 현황(중앙 화면 — 전체 범위만) — 인출 기록 + 엣지 봉투의 배포본 상태. 상태: applied(지금 보낼 판 = 엣지가 적용한 판) · pending(다른 판) ·
 *   never(인출 기록 없음 — 이 중앙 기동 뒤) · old(봉투에 8a 표지 없음 — 구버전 엣지) · targets-unknown(v2.954 D-1 — 그 엣지 대상을 몰라 태그 창을 펼 수 없음 · 인출 보류). 판정은 인출 응답과 같은 함수(windowsForEdge → sigOf).
 */
export async function deployStatusView(edges = [], now = Date.now()) {
  const rows = [];
  let windows = [];
  try { windows = listWindows(); } catch { windows = null; }
  const tagsOf = await tagsReader();
  const y = createYielder(15);
  const live = windows ? await liveWindows(windows, now, { yieldFn: y }) : null;   // 한 번만 — 엣지마다 다시 세지 않는다(F6)
  const names = new Set([..._pulls.keys(), ...edges.map((r) => t(r.agent).toLowerCase())]);
  for (const k of [...names].filter(Boolean).sort().slice(0, 256)) {
    await y();
    const p = _pulls.get(k) || null;
    const rec = edges.find((r) => t(r.agent).toLowerCase() === k);
    const env = rec?.snap?.maint || null;
    const maintVer = Number.isInteger(rec?.snap?.maintVer) ? rec.snap.maintVer : null;
    let expectSig = null; let blind = false;
    if (live) { const ctx = await edgeContext(rec?.agent || k); expectSig = sigOf(windowsForEdge({ live, ...ctx, tagsOf })); blind = tagWindowsBlind({ live, ...ctx }); }
    // v2.954(점검 D-1): 대상을 모르면(중앙 재시작 뒤 · 첫 인출 전) 기대 판을 빈 keys 로 계산하게 된다 — ‘반영됨’ 으로 보이지 않게 따로 말한다
    const status = rec && maintVer == null ? 'old' : blind ? 'targets-unknown' : !p ? 'never' : (expectSig && p.appliedSig === expectSig ? 'applied' : 'pending');
    rows.push({ agent: rec?.agent || k, status, lastPullAt: p?.at ?? null, version: p?.version || '',
      envelope: env ? { deployedAt: env.deployed?.at ?? null, n: env.deployed?.n ?? null, stale: env.deployed?.stale ?? null, unreadable: !!env.deployed?.unreadable, leak: env.leak?.n ?? null } : null, maintVer });
  }
  return { edges: rows, now, ...(windows ? {} : { unreadable: true }) };
}
export function _resetMaintDeployForTest() { _pulls.clear(); _blindSince.clear(); }
