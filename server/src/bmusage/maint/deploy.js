/**
 * bmusage/maint/deploy.js — 8a단계 정비 창 **중앙 → 엣지 배포**(15차 · 7b 배포 경로와 같은 꼴: 엣지가 주기 인출 · 개별 토큰으로 인증된 이름에만 · 결과는 다음 인출의 쿼리).
 *
 *   · 엣지는 **자기 법인 창만** 받는다 — 법인 = ‘중앙에서 켜기’ 와 같은 매핑(edgeCorps.edgeCorpsSource) ∪ 그 엣지가 봉투로 보고한 대상의 법인.
 *   · 서버 창도 **그 법인일 때만**(반증 F1 — 키만 겹친다고 보내지 않는다: IP 키는 법인끼리 겹친다 · 서버 대상은 (법인, 키) 쌍) ·
 *     태그 창은 중앙이 **그 엣지 대상 중 그 법인 · 그 태그(수동 용도 태그)를 가진 서버 키로 펼친다**
 *     (엣지에는 중앙 태그가 없다 — 판정 코어는 같은 함수 maint/judge.js 이고 엣지 입력은 펼친 keys).
 *   · 지금 억제용 `windows` = 진행 중 · 예정 창만. 이력(edits)은 싣지 않는다.
 *   · ⚠ 점검 반복 3회차 D2: 끝남 · 지움(묘비) · 만료 창은 **`history`**(지난 구간 전용 — 봉투 표지 historyVer)로 함께 보낸다 — 중앙이 지난 구간 계산에 쓰는 것과
 *     같은 집합(store.keptPast — 90일 안). 엣지는 history 를 지금 판정(억제)에 쓰지 않고 ⑤ 분모 제외 · 음영에만 쓴다(judge.activeOccurrence 가 뺀다).
 *     예전에는 끝난 일회 창이 다음 배포본에서 빠져 엣지 서버의 용량 · 저활용 · 베이스라인 제외가 소급해 사라졌다. 서명(sig)은 지금 억제용 windows 만으로
 *     (배포 현황 ‘반영됨’ = 억제 판이 같다 · 구버전 엣지는 history 를 모르고 무시한다 — maintBodyOk 는 windows · sig 만 본다). 상한 = store.DEPLOY_HISTORY_MAX · BYTES_MAX(넘치면 최근 것부터).
 *   · 공유 토큰(`?agent=` 를 댈 수 있다)에는 주지 않는다(distribute:false — 엣지는 지난 배포본을 TTL 까지만 쓴다).
 *   · 중앙 창 파일을 못 읽으면 라우트가 503(빈 목록을 보내 엣지 억제를 지우지 않는다 · 엣지는 TTL 까지 지난 배포본).
 * 엣지 쪽은 agent/bmMaintPull.js → store.saveDeployed(같은 normalizeWindow 로 다시 자름).
 * ⚠ v2.954(점검 D-1 → 반증 재수정): 태그 창의 keys 는 중앙이 그 엣지 대상(엣지 봉투 — central/bmUsageEdgePull 인메모리 · 사람이 인출할 때만 채워졌다)으로 펼친다.
 *   중앙 재시작 뒤 · 첫 인출 전에는 대상을 **모른다** — 예전에는 그때 빈 keys 로 배포해 엣지 억제가 꺼졌다. 첫 수정은 배포를 12시간 보류했는데,
 *   중앙은 자동 업그레이드로 자주 재시작하고 배포본은 통째 교체라 그동안 **억제를 줄이는 쓰기(지금 끝내기 · 지우기)까지** 엣지에 닿지 않았다(반증 — 억제가 계속되는 쪽).
 *   이제 보류하지 않는다: 대상을 모르면 그 태그 창에 `target.keysUnknown: true` 를 달아 보내고(엣지 store.saveDeployed 가 직전 배포본의 같은 창 keys 를 이어 쓴다 —
 *   새 태그 창이면 0대) · 그 엣지 봉투를 **한 번 자동 인출**한다(엣지별 10분에 한 번 — 다음 인출 주기부터 펼친 keys). 옛 엣지(keysUnknown 을 모름)는 첫 인출 전 한 주기 동안
 *   예전처럼 빈 keys 다. 배포 현황은 'targets-unknown' 으로 따로(빈 keys 판을 '반영됨' 으로 보이지 않게).
 * ⚠ 요청 경로 비용(반증 F6): 창 상태(진행 중 · 예정)는 **요청마다 한 번**(liveWindows — 시간 기준 양보) 계산하고 엣지마다 그 결과를 다시 쓴다
 *   (배포 현황이 엣지 28곳마다 전 창을 다시 세지 않는다).
 */
import crypto from 'node:crypto';
import { listWindows, DEPLOY_TTL_MS, keptPast, capHistory, historyRecency } from './store.js';
import { windowStatus } from './judge.js';
import { tagsReader } from './runtime.js';
import { createYielder } from '../../util/timeSlice.js';

const t = (v) => String(v ?? '').trim();
// deleted 는 history(묘비 — 지운 시각까지가 지난 구간)에만 있다(지금 억제용 windows 에는 지운 창이 없다).
const SEND_FIELDS = ['id', 'name', 'reason', 'target', 'vcenterId', 'tz', 'schedule', 'scopes', 'rev', 'by', 'at', 'approvedBy', 'confirmedAt', 'endedAt', 'endedBy', 'endedOccStart', 'deleted'];
/** 배포 history 표지(인출 응답 historyVer) — 엣지가 history 를 아는 판인지 중앙이 따로 볼 필요는 없다(구버전 엣지는 필드를 무시한다 · 예전과 같다). */
export const HISTORY_VER = 1;
export const sigOf = (list) => crypto.createHash('md5').update(JSON.stringify(list)).digest('hex');

/**
 * 이 노드의 창을 지금 억제용(live — 진행 중 · 예정)과 지난 구간용(history — 끝남 · 만료 · 지움 묘비 · store.keptPast 90일 안)으로 가른다 —
 *   요청마다 한 번(창 상태는 창마다 한 번 · 시간 기준 양보 — F6). 중앙 배포본(origin central)은 다시 보내지 않는다.
 */
export async function splitWindows(windows = [], now = Date.now(), { yieldFn = createYielder(15) } = {}) {
  const live = []; const history = [];
  for (const w of windows || []) {
    if (!w || w.origin === 'central') continue;
    if (w.deleted) { if (keptPast(w, now)) history.push(w); continue; }
    const st = windowStatus(w, now).status;
    if (st === 'active' || st === 'scheduled') live.push(w); else if (keptPast(w, now)) history.push(w);
    await yieldFn();
  }
  return { live, history };
}
/** 보낼 수 있는 창(진행 중 · 예정 — 이 노드의 창 · 지우지 않음) — splitWindows 의 live. */
export async function liveWindows(windows = [], now = Date.now(), o = {}) {
  return (await splitWindows(windows, now, o)).live;
}

/**
 * 한 엣지에 보낼 창(순수 — 입력 주입). live = liveWindows 결과(엣지마다 다시 세지 않는다).
 * @param {{ live:Array, corps:Set<string>, edgeTargets:Array<{key,serviceTag,vcenterId}>, tagsOf:(t)=>string[] }} p
 */
export function windowsForEdge({ live = [], corps = new Set(), edgeTargets = [], tagsOf = () => [], targetsKnown = true } = {}) {
  const out = [];
  for (const w of live) {
    const pick = Object.fromEntries(SEND_FIELDS.filter((k) => w[k] !== undefined).map((k) => [k, w[k]]));
    if (!corps.has(w.vcenterId)) continue;   // 모든 종류 — 그 법인을 맡은 엣지에만
    if (w.target.kind === 'corp' || w.target.kind === 'server') { out.push(pick); continue; }
    if (w.target.kind === 'tag') {
      const ks = edgeTargets.filter((x) => t(x.vcenterId) === w.vcenterId && (tagsOf(x) || []).includes(w.target.tag)).map((x) => t(x.key)).filter(Boolean);
      out.push({ ...pick, target: { kind: 'tag', tag: w.target.tag, keys: [...new Set(ks)].slice(0, 5_000), ...(targetsKnown ? {} : { keysUnknown: true }) } });
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
  let edgeTargets = []; let targetsKnown = false; let truncated = 0;
  try {
    const rec = (await import('../../central/bmUsageEdgePull.js')).getEdgeBmUsage(agent);
    targetsKnown = !!rec?.snap && Array.isArray(rec.snap.targets);
    edgeTargets = (rec?.snap?.targets || []).map((x) => ({ key: t(x.key), serviceTag: t(x.serviceTag), vcenterId: t(x.vcenterId) }));
    for (const x of edgeTargets) if (x.vcenterId) corps.add(x.vcenterId);
    // 5회차 D1: 보관분이 엣지 상한에서 잘렸는가(그 수 — 태그 창 펼침은 받은 대상만 · 화면에 밝힌다). keysUnknown 으로 바꾸지 않는다:
    //   자동 인출도 사람 인출과 같은 상한(EDGE_PULL_LIMIT)이라 잘림은 엣지 대상이 그 상한을 넘을 때만이고, 다시 당겨도 같다 — 직전 배포본 keys 를
    //   이어 써도(그것도 잘린 판) 나아지지 않고 빠진 서버를 계속 쥘 수 있다. 받지 못한 서버는 억제하지 않는다(모르는 대상은 억제가 아니다 — 알림이 나가는 쪽).
    truncated = Math.max(0, Number(rec?.snap?.truncated) || 0);
  } catch { edgeTargets = []; targetsKnown = false; }
  return { corps, edgeTargets, targetsKnown, truncated };
}

/** v2.954(점검 D-1): 대상을 모르는데 그 엣지 법인에 살아 있는 태그 창이 있는가(순수) — 있으면 빈 keys 로 펼치게 된다. */
export function tagWindowsBlind({ live = [], corps = new Set(), targetsKnown = false } = {}) {
  if (targetsKnown) return false;
  return live.some((w) => w?.target?.kind === 'tag' && corps.has(w.vcenterId));
}
/** 대상을 모를 때 그 엣지 봉투 자동 인출 — 엣지별 간격(같은 엣지를 인출 주기마다 다시 당기지 않게). */
export const AUTO_PULL_GAP_MS = 10 * 60_000;
const _autoPullAt = new Map();   // agent(소문자) → 마지막 자동 인출 시각
// 5회차 D1: 사람 인출과 같은 상한(EDGE_PULL_LIMIT) — 예전에는 limit 없이 당겨 엣지 기본 400대에서 잘렸다(태그 창 펼침도 400대)
let _autoPull = async (agent) => { const E = await import('../../central/bmUsageEdgePull.js'); return E.pullBmUsage(agent, { limit: E.EDGE_PULL_LIMIT }); };
export function _setAutoPullForTest(fn) { _autoPull = fn; _autoPullAt.clear(); }
function autoPullTargets(agent, now) {
  const k = t(agent).toLowerCase(); if (!k) return false;
  if (now - (_autoPullAt.get(k) || 0) < AUTO_PULL_GAP_MS) return false;
  _autoPullAt.set(k, now); if (_autoPullAt.size > 512) _autoPullAt.delete(_autoPullAt.keys().next().value);
  // 기다리지 않는다(인출 응답을 늦추지 않게) — 실패는 bmUsageEdgePull 이 보관소에 기록하고 다음 간격에 다시 시도한다
  Promise.resolve().then(() => _autoPull(agent)).catch((e) => console.warn(`[bmusage] 정비 창 배포 — 엣지 '${agent}' 대상 자동 인출 실패: ${String(e?.message || e).slice(0, 160)}`));
  return true;
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
  const { live, history: past } = await splitWindows(windows, now);
  // v2.954(점검 D-1 → 반증 재수정): 대상을 모르면 보류하지 않고 keysUnknown(엣지가 직전 keys 를 이어 쓴다)으로 보내며 봉투를 자동 인출한다
  const blind = tagWindowsBlind({ live, corps, targetsKnown });
  if (blind) autoPullTargets(agent, now);
  const list = windowsForEdge({ live, corps, edgeTargets, tagsOf, targetsKnown });
  // 3회차 D2: 지난 구간용 — 같은 법인 · 같은 태그 펼침(windowsForEdge 하나) · 최근 것부터 상한(개수 · 크기 — 지금 억제 창의 본문 자리를 빼앗지 않게)
  const h = capHistory(windowsForEdge({ live: past, corps, edgeTargets, tagsOf, targetsKnown }).sort((a, b) => historyRecency(b) - historyRecency(a)));
  return { distribute: true, sig: sigOf(list), windows: list, historyVer: HISTORY_VER, history: h.list, ...(h.dropped ? { historyDropped: h.dropped } : {}), ...(blind ? { targetsUnknown: true } : {}) };
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
    let expectSig = null; let blind = false; let truncated = 0;
    if (live) { const ctx = await edgeContext(rec?.agent || k); expectSig = sigOf(windowsForEdge({ live, ...ctx, tagsOf })); blind = tagWindowsBlind({ live, ...ctx }); truncated = ctx.truncated; }
    // v2.954(점검 D-1): 대상을 모르면(중앙 재시작 뒤 · 첫 인출 전) 기대 판을 빈 keys 로 계산하게 된다 — ‘반영됨’ 으로 보이지 않게 따로 말한다
    const status = rec && maintVer == null ? 'old' : blind ? 'targets-unknown' : !p ? 'never' : (expectSig && p.appliedSig === expectSig ? 'applied' : 'pending');
    rows.push({ agent: rec?.agent || k, status, lastPullAt: p?.at ?? null, version: p?.version || '', ...(truncated ? { targetsTruncated: truncated } : {}),
      envelope: env ? { deployedAt: env.deployed?.at ?? null, n: env.deployed?.n ?? null, stale: env.deployed?.stale ?? null, unreadable: !!env.deployed?.unreadable, leak: env.leak?.n ?? null } : null, maintVer });
  }
  return { edges: rows, now, ...(windows ? {} : { unreadable: true }) };
}
export function _resetMaintDeployForTest() { _pulls.clear(); _autoPullAt.clear(); }
