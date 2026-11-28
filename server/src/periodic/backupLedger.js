/**
 * periodic/backupLedger.js — 정기 점검 보고 '백업 성공 · 실패 현황'(보고서 3절 · v3.59 · 설계 docs/design/periodic-report §9)의 순수 규칙.
 *   DB 는 backupStore.js, 틱 · 조립 연결은 backupService.js 가 한다. 이 파일은 시각 · 저장소를 모른다(테스트가 직접 부른다).
 *
 * 왜 적재가 필요한가(§9.1 — 코드에서 확인): Veeam 은 VM 마다 **마지막 결과 하나**만, Bareos 원장은 끝난 실행 최근 몇 건(jobDigests 5)만,
 *   VM 백업(복제)은 잡마다 최근 30회만 들고 있다. 그래서 '지난주 · 지난달 성공 · 실패' 를 그 자리에서 셀 수 없다 — 10분마다 **끝난 실행을 관측**해 쌓고(obs),
 *   날이 끝나면 그날 VM 마다 마지막 결과로 **확정**(day)한다.
 *
 * 세는 규칙(컨펌 ② — Backup › Summary 와 같은 규칙):
 *   · 단위는 VM(복제는 잡) · 하루에 여러 번 돌았으면 그날 그 VM 의 **마지막** 결과 · 경고는 복원 지점이 생긴 실행이라 성공률에 넣고 · 취소는 실패.
 *   · '실행 없음' = 그날 대상인데 끝난 실행이 없음(주 1회 잡이면 정상이다 — 여기서 판정하지 않는다 · RPO 가 판정).
 *   · '확인 불가' = 그 법인 · 그날의 결과를 다 봤다고 말할 수 없음 — 성공에도 실패에도 넣지 않고 따로 센다(부분 합은 적재하지 않는다 — 루트 CLAUDE.md).
 *
 * 그날을 '다 봤다' 고 하는 조건(확정 — sealStatus):
 *   · Veeam — VM 마다 마지막 결과만 있어 **지난 결과가 덮인다**. 그래서 신선한 관측(데이터 시각 = B&R 마지막 읽기 성공 시각)이 그날 내내 VEEAM_GAP_MAX 보다
 *     긴 틈 없이 이어지고, 날이 끝난 뒤에도 한 번 더(틈 ≤ 한도) 봤을 때만 확정한다. 틈이 길면 그사이 덮인 결과를 몰라 그날 그 법인은 확인 불가.
 *   · Bareos · VM 백업 — 실행 기록이 남아 있어 **날이 끝난 뒤 한 번만** 신선하게 읽으면 그날 실행이 다 보인다(늦게 와도 REFILL_DAYS 안이면 다시 채운다).
 *   · 적재를 처음 시작한 날보다 앞의 날은 확정하지 않는다('적재 전' — 소급하지 않는다).
 */
import { statusOf } from '../bareos/names.js';
import { numOrNull } from '../util/numOrNull.js';

export const PRODUCTS = Object.freeze(['veeam', 'bareos', 'clone']);
export const PRODUCT_LABEL = Object.freeze({ veeam: 'Veeam', bareos: 'Bareos', clone: 'VM 백업(복제)' });
export const BK_STATES = Object.freeze(['ok', 'warn', 'fail']);
/** 관측 주기 — 서비스 틱(1분)의 이 배수마다 한 번. 화면 · 문서는 API 값을 쓴다(숫자를 박지 않는다). */
export const CAPTURE_MS = 10 * 60_000;
/** Veeam 관측 틈 한도 — 이보다 긴 틈이 그날에 걸치면 그날 그 법인은 확인 불가(그사이 덮인 결과를 모른다). */
export const VEEAM_GAP_MAX_MS = 3 * 3_600_000;
/** 날이 끝나고 이만큼 지나면 확정한다(늦게 끝나 늦게 올라오는 결과를 기다린다). */
export const SEAL_LAG_MS = 3 * 3_600_000;
/** 실행 기록이 남는 백업(Bareos · VM 백업)은 확인 불가였던 날을 이 일수 안에 다시 채운다(Bareos 원장 요약은 끝난 실행 5건까지라 길게 잡지 않는다). */
export const REFILL_DAYS = 4;
/** 관측 원본 · 관측 범위 보관 일수(확정 뒤 재확정 · 주간 줄무늬 · 연속 실패 계산에만 쓴다). */
export const RAW_KEEP_DAYS = 40;
/** 확정 결과 보관 일수(설정) — 분기 보고서가 앞 분기와 견줄 수 있게 최소 92일. */
export const LEDGER_KEEP = Object.freeze({ def: 400, min: 92, max: 1825 });
const HISTORY_PRODUCTS = new Set(['bareos', 'clone']);
const CLOCK_SKEW_MS = 5 * 60_000;
const FAIL_ROWS_MAX = 1_000;
const REPEAT_ROWS_MAX = 200;
const STRIP_DAYS_MAX = 7;
const TEXT_MAX = 300;

const isFin = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v, n = 128) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);
const textOrNull = (v) => { const s = str(v, TEXT_MAX); return s || null; };

/** Veeam task 결과 글자 → 'ok' · 'warn' · 'fail' · null(끝난 결과가 아님 — None · Running 등). Summary R24 와 같은 갈래. */
export function veeamStateOf(lr) {
  const s = String(lr || '');
  if (/^success/i.test(s)) return 'ok';
  if (/^warn/i.test(s)) return 'warn';
  if (/^fail/i.test(s)) return 'fail';
  return null;
}
/** Bareos JobStatus 글자 → 'ok' · 'warn' · 'fail' · null(끝나지 않음). 취소는 실패(Summary BR24 와 같다). */
export function bareosStateOf(code) {
  const s = statusOf(code);
  if (s === 'ok') return 'ok';
  if (s === 'warning') return 'warn';
  if (s === 'error' || s === 'canceled') return 'fail';
  return null;
}
/** 복제 실행 기록 한 줄 → 'ok' · 'fail' · null(백업이 아님 · 돌지 않은 건너뜀). 재시작에 끊긴 실행은 돌던 백업이라 실패로 센다. */
export function cloneStateOf(h) {
  if (!h || typeof h !== 'object') return null;
  if ((h.kind || 'backup') !== 'backup') return null;
  if (h.skipped && h.skipped !== 'restart-interrupted') return null;
  return h.ok === true ? 'ok' : 'fail';
}

/**
 * 공급자 자료 → 관측(obs) · 관측 범위(seen). 순수.
 * @param {{vcs?:Array, clones?:Array, now?:number}} a
 *   vcs[]: { id, veeam?: { state, at, vms:[{id,name,lr,lrt,lrs,msg,msgPub}] }, bareos?: { mapped, resultsKnown, at, jobs:[{vmId,vmName,enabled,missing,runs:[{jobid,status,startedAt,endedAt,msg}]}] } }
 *   clones[]: { vc, key, name, at(데이터 시각), target:boolean, runs:[{at,ok,kind,skipped,detail}] }
 * @returns {{obs:object[], seen:object[]}}
 *   obs: { product, vc, vm, name, endedAt, startedAt, state, reason, reasonPub, runId }
 *   seen: { product, vc, fresh, dataAt, targets:string[]|null }
 */
export function observeOf({ vcs = [], clones = [], now = Date.now() } = {}) {
  const obs = []; const seen = [];
  const okTime = (t) => isFin(t) && t > 0 && t <= now + CLOCK_SKEW_MS;
  for (const vc of Array.isArray(vcs) ? vcs : []) {
    const id = str(vc?.id);
    if (!id) continue;
    const v = vc.veeam;
    if (v && v.state !== 'unlinked') {
      const fresh = v.state === 'ok' && okTime(v.at);
      const targets = [];
      for (const m of Array.isArray(v.vms) ? v.vms : []) {
        const vm = str(m?.id);
        if (!vm) continue;
        targets.push(vm);
        const st = veeamStateOf(m.lr);
        if (!st || !okTime(m.lrt)) continue;
        obs.push({ product: 'veeam', vc: id, vm, name: str(m.name), endedAt: m.lrt, startedAt: isFin(m.lrs) && m.lrs <= m.lrt ? m.lrs : null, state: st,
          reason: st === 'ok' ? null : textOrNull(m.msg), reasonPub: st === 'ok' ? null : textOrNull(m.msgPub), runId: null });
      }
      seen.push({ product: 'veeam', vc: id, fresh, dataAt: fresh ? Math.min(v.at, now) : null, targets: fresh ? targets : null });
    }
    const b = vc.bareos;
    if (b && b.mapped === true) {
      const fresh = b.resultsKnown === true && okTime(b.at);
      const targets = [];
      for (const j of Array.isArray(b.jobs) ? b.jobs : []) {
        const vm = str(j?.vmId);
        if (!vm) continue;
        if (j.enabled !== false && j.missing !== true) targets.push(vm);
        const seenJob = new Set();
        for (const r of Array.isArray(j.runs) ? j.runs : []) {
          const st = bareosStateOf(r?.status);
          if (!st || !okTime(r.endedAt)) continue;
          const rid = r.jobid != null ? String(r.jobid).slice(0, 32) : null;
          if (rid && seenJob.has(rid)) continue;
          if (rid) seenJob.add(rid);
          const msg = st === 'ok' ? null : textOrNull(r.msg);
          obs.push({ product: 'bareos', vc: id, vm, name: str(j.vmName), endedAt: r.endedAt, startedAt: isFin(r.startedAt) && r.startedAt <= r.endedAt ? r.startedAt : null,
            state: st, reason: msg, reasonPub: msg, runId: rid });
        }
      }
      seen.push({ product: 'bareos', vc: id, fresh, dataAt: fresh ? Math.min(b.at, now) : null, targets: fresh ? targets : null });
    }
  }
  // 복제 — 법인마다 잡을 모아 관측 범위 하나(데이터 시각 = 그 법인 잡 출처 중 가장 이른 것 — 엣지 보고가 늦은 잡이 있으면 그만큼만 안다).
  const cloneBy = new Map();
  for (const c of Array.isArray(clones) ? clones : []) {
    const vc = str(c?.vc); const key = str(c?.key);
    if (!vc || !key) continue;
    const g = cloneBy.get(vc) || { at: Infinity, targets: [] };
    if (c.target === true) g.targets.push(key);
    g.at = Math.min(g.at, okTime(c.at) ? c.at : -Infinity);
    cloneBy.set(vc, g);
    const seenAt = new Set();
    for (const h of Array.isArray(c.runs) ? c.runs : []) {
      const st = cloneStateOf(h);
      if (!st || !okTime(h.at) || seenAt.has(h.at)) continue;
      seenAt.add(h.at);
      obs.push({ product: 'clone', vc, vm: key, name: str(c.name), endedAt: h.at, startedAt: isFin(h.ms) && h.ms >= 0 ? h.at - h.ms : null, state: st,
        reason: st === 'ok' ? null : textOrNull(h.detail), reasonPub: st === 'ok' ? null : '복제 백업 실패 — 사유는 백업 › VM 백업 화면', runId: null });
    }
  }
  for (const [vc, g] of cloneBy) {
    const fresh = isFin(g.at) && g.at > 0;
    seen.push({ product: 'clone', vc, fresh, dataAt: fresh ? Math.min(g.at, now) : null, targets: fresh ? g.targets : null });
  }
  return { obs, seen };
}

/**
 * 신선한 관측 하나가 덮는 날 — 직전 데이터 시각(prevAt)에서 이번(at)까지의 틈을 그 틈에 걸친 모든 날에 매긴다(순수).
 *   처음 관측(prevAt 없음)이면 그날 00시부터를 틈으로 본다 — 적재를 시작한 날의 앞부분은 모른다(그날 Veeam 은 확인 불가).
 * @returns {{advance:boolean, gaps:Array<[number,number]>}} gaps = [day, gapMs] · advance=false 면 데이터 시각이 앞으로 가지 않았다(같은 읽기 — 아무것도 바꾸지 않는다)
 */
export function coverStep(prevAt, at, { dayOf, dayStartOf }) {
  if (!isFin(at) || at <= 0) return { advance: false, gaps: [] };
  if (isFin(prevAt) && prevAt > 0) {
    if (at <= prevAt) return { advance: false, gaps: [] };
    const gap = at - prevAt;
    const out = [];
    for (let d = dayOf(prevAt); d <= dayOf(at); d++) out.push([d, gap]);
    return { advance: true, gaps: out };
  }
  const d = dayOf(at);
  return { advance: true, gaps: [[d, at - dayStartOf(d)]] };
}

/**
 * 그날 그 법인 · 백업을 확정할 판정(순수).
 * @param {{product:string, day:number, dayEnd:number, firstDay:number|null, cursorAt:number|null, seenRow?:{maxGap:number}|null}} a
 * @returns {'known'|'unknown'|null} null = 확정하지 않음(적재 전)
 */
export function sealStatus({ product, day, dayEnd, firstDay, cursorAt, seenRow }) {
  if (firstDay == null || day < firstDay) return null;
  const after = isFin(cursorAt) && cursorAt >= dayEnd;
  if (HISTORY_PRODUCTS.has(product)) return after ? 'known' : 'unknown';
  if (!after || !seenRow) return 'unknown';
  return numOrNull(seenRow.maxGap) != null && seenRow.maxGap <= VEEAM_GAP_MAX_MS ? 'known' : 'unknown';
}
/** 확인 불가로 확정한 날을 다시 볼 백업인가(실행 기록이 남는 쪽만 — Veeam 은 덮인 결과가 돌아오지 않는다). */
export const refillable = (product) => HISTORY_PRODUCTS.has(product);

/**
 * 그날 관측 → VM 마다 마지막 결과 · 수(순수).
 * @param {Array<{vm,endedAt,state}>} obsRows 그날 그 법인 · 백업의 관측
 * @param {string[]|null} targets 그날 대상(마지막 신선 관측 때의 목록)
 */
export function sealCounts(obsRows, targets) {
  const last = new Map();
  for (const o of Array.isArray(obsRows) ? obsRows : []) {
    if (!o || !BK_STATES.includes(o.state)) continue;
    const cur = last.get(o.vm);
    if (!cur || o.endedAt > cur.endedAt) last.set(o.vm, o);
  }
  const T = new Set([...(Array.isArray(targets) ? targets : []), ...last.keys()]);
  const c = { targets: T.size, ended: last.size, ok: 0, warn: 0, fail: 0, norun: 0 };
  for (const o of last.values()) c[o.state] += 1;
  for (const vm of T) if (!last.has(vm)) c.norun += 1;
  return { counts: c, last: [...last.values()] };
}

/** 실행 목록(끝난 시각 무관 순서) → 맨 끝에서부터 이어진 실패 횟수(순수). */
export function failStreak(runs) {
  const list = (Array.isArray(runs) ? runs : []).filter((r) => r && BK_STATES.includes(r.state) && isFin(r.endedAt)).sort((a, b) => b.endedAt - a.endedAt);
  let n = 0;
  for (const r of list) { if (r.state !== 'fail') break; n += 1; }
  return n;
}

/**
 * 백업 항목 판정(컨펌 ④ ⑤ — 2026-11-28 사용자 결정 '연속 실패만 이상').
 *   이상 = 지금 실패이고 연속 2회 이상 실패 · 또는 마지막 성공이 7일 넘음 / 주의 = 지금 실패(한 번) · 또는 마지막 성공이 3일 넘음.
 *   확인 불가 = 이 법인 결과를 지금 읽지 못함(그 밖의 판정보다 앞서지 않는다 — 아는 실패는 그대로 센다).
 * @param {{failNow?:number, failRepeat?:number, rpo7?:number, rpo3?:number, unknown?:boolean}} c
 * @returns {'crit'|'warn'|'unknown'|'ok'}
 */
export function backupJudge({ failNow = 0, failRepeat = 0, rpo7 = 0, rpo3 = 0, unknown = false } = {}) {
  if (failRepeat > 0 || rpo7 > 0) return 'crit';
  if (failNow > 0 || rpo3 > 0) return 'warn';
  if (unknown) return 'unknown';
  return 'ok';
}

/* ───────────────────────── 보고서 3절 ───────────────────────── */

const zero = () => ({ t: 0, e: 0, ok: 0, w: 0, f: 0, n: 0, kd: 0, ud: 0 });
const addInto = (a, b) => { for (const k of Object.keys(a)) a[k] += Number(b?.[k]) || 0; return a; };
/** 성공률(%) — 끝난 백업 중 성공 + 경고. 끝난 백업이 없으면 null('—'). 소수 둘째 자리. */
export const rateOf = (c) => (c && c.e > 0 ? Math.round(((c.ok + c.w) / c.e) * 10_000) / 100 : null);

/**
 * 확정 결과 · 실패 VM → 3절 문서(순수 — 법인 단위로 담아 범위로 자를 수 있게 한다. 합계는 backupSummary 가 다시 낸다).
 * @param {object} a
 * @param {number[]} a.days 기간의 날(dayIndex)
 * @param {Array} a.dayRows pr_bk_day 행 { day, product, vc, status, targets, ended, ok, warn, fail, norun }
 * @param {Array} a.vmRows pr_bk_vmday 행(실패 · 경고) { day, product, vm, vc, state, name, endedAt, reason, reasonPub }
 * @param {Array} [a.prevDayRows] 앞 기간의 확정 결과(같은 길이)
 * @param {Map<string,{streak:number,lastOkAt:number|null}>} [a.vmFacts] `${product}|${vm}` → 연속 실패 · 마지막 성공
 * @param {Map<string,Array<{day,state}>>} [a.strips] `${product}|${vm}` → 날마다 마지막 결과(주간 줄무늬 — 7일 이하 기간만)
 * @param {Array} [a.now] 지금 실패 상태 [{ vc, product, vm, name }]
 * @param {string[]} [a.products] 실을 백업
 * @param {(day:number)=>string} [a.dayLabel]
 * @param {number|null} [a.firstDay] 적재를 시작한 날
 * @param {number|null} [a.asOf] 마지막 관측 시각
 */
export function buildBackupSection(a) {
  const products = (Array.isArray(a.products) ? a.products : PRODUCTS).filter((p) => PRODUCTS.includes(p));   // 빈 목록은 빈 목록(전부로 바꾸지 않는다)
  const pset = new Set(products);
  const days = Array.isArray(a.days) ? a.days : [];
  const dIdx = new Map(days.map((d, i) => [d, i]));
  const corps = new Map();
  const corpOf = (vc) => {
    let c = corps.get(vc);
    if (!c) {
      c = { vc, p: Object.fromEntries(products.map((p) => [p, zero()])), d: days.map(() => [0, 0, 0, 0, 0, 0]),
        s: Object.fromEntries(products.map((p) => [p, days.map(() => '-')])), prev: { e: 0, f: 0, ok: 0, w: 0, kd: 0, ud: 0 } };
      corps.set(vc, c);
    }
    return c;
  };
  const sealed = new Set();
  for (const r of Array.isArray(a.dayRows) ? a.dayRows : []) {
    if (!r || !pset.has(r.product) || !dIdx.has(r.day)) continue;
    sealed.add(r.day);
    const c = corpOf(String(r.vc));
    const p = c.p[r.product];
    const di = c.d[dIdx.get(r.day)];   // [끝남, 성공, 경고, 실패, 확인 불가 법인-백업 수, 확정 수]
    di[5] += 1;
    c.s[r.product][dIdx.get(r.day)] = r.status === 'known' ? 'k' : 'u';
    if (r.status !== 'known') { p.ud += 1; di[4] += 1; continue; }
    p.kd += 1;
    p.t += Number(r.targets) || 0; p.e += Number(r.ended) || 0; p.ok += Number(r.ok) || 0; p.w += Number(r.warn) || 0; p.f += Number(r.fail) || 0; p.n += Number(r.norun) || 0;
    di[0] += Number(r.ended) || 0; di[1] += Number(r.ok) || 0; di[2] += Number(r.warn) || 0; di[3] += Number(r.fail) || 0;
  }
  for (const r of Array.isArray(a.prevDayRows) ? a.prevDayRows : []) {
    if (!r || !pset.has(r.product)) continue;
    const c = corpOf(String(r.vc));
    if (r.status !== 'known') { c.prev.ud += 1; continue; }
    c.prev.kd += 1; c.prev.e += Number(r.ended) || 0; c.prev.f += Number(r.fail) || 0; c.prev.ok += Number(r.ok) || 0; c.prev.w += Number(r.warn) || 0;
  }
  // 실패 VM — (백업, VM) 하나에 한 줄(기간 안 실패한 날 수 · 마지막 실패). 경고는 세지만 목록에 넣지 않는다(실패만 조치 대상).
  const byVm = new Map();
  for (const r of Array.isArray(a.vmRows) ? a.vmRows : []) {
    if (!r || r.state !== 'fail' || !pset.has(r.product) || !dIdx.has(r.day)) continue;
    const k = `${r.product}|${r.vm}`;
    const cur = byVm.get(k);
    if (!cur) byVm.set(k, { product: r.product, vc: String(r.vc), vm: String(r.vm), name: str(r.name), failDays: 1, day: r.day, endedAt: numOrNull(r.endedAt), reason: r.reason || null, reasonPub: r.reasonPub || null });
    else {
      cur.failDays += 1;
      if (r.day > cur.day) Object.assign(cur, { day: r.day, endedAt: numOrNull(r.endedAt), name: str(r.name) || cur.name, reason: r.reason || null, reasonPub: r.reasonPub || null, vc: String(r.vc) });
    }
  }
  const facts = a.vmFacts instanceof Map ? a.vmFacts : new Map();
  const failList = [...byVm.values()].map((x) => {
    const f = facts.get(`${x.product}|${x.vm}`) || {};
    return { ...x, streak: numOrNull(f.streak), lastOkAt: numOrNull(f.lastOkAt) };
  }).sort((x, y) => (y.failDays - x.failDays) || ((y.streak ?? 0) - (x.streak ?? 0)) || ((y.endedAt ?? 0) - (x.endedAt ?? 0)) || x.vm.localeCompare(y.vm));
  for (const x of failList) { const c = corpOf(x.vc); c.rv = (c.rv || 0) + (x.failDays >= 2 ? 1 : 0); }
  const strips = a.strips instanceof Map ? a.strips : null;
  const stripOk = !!strips && days.length > 1 && days.length <= STRIP_DAYS_MAX;
  const repeat = failList.filter((x) => x.failDays >= 2).slice(0, REPEAT_ROWS_MAX).map((x) => {
    if (!stripOk) return x;
    const m = new Map((strips.get(`${x.product}|${x.vm}`) || []).map((s) => [s.day, s.state]));
    const ds = corps.get(x.vc)?.s?.[x.product] || [];
    // 그날 관측이 있으면 그 결과 · 없으면 그날 확정 상태로(확정 · 알았음 = 실행 없음 · 확인 불가 = 모름 · 확정 전 = 적재 전)
    return { ...x, strip: days.map((d, i) => m.get(d) || (ds[i] === 'k' ? 'none' : ds[i] === 'u' ? 'unknown' : 'pre')) };
  });
  for (const x of Array.isArray(a.now) ? a.now : []) {
    if (!x || !pset.has(x.product)) continue;
    const c = corpOf(String(x.vc));
    c.fn = (c.fn || 0) + 1;
  }
  return {
    v: 1, products, days: days.map((d) => ({ day: d, label: a.dayLabel ? a.dayLabel(d) : String(d) })),
    firstDay: numOrNull(a.firstDay), sealedDays: sealed.size, asOf: numOrNull(a.asOf),
    corps: [...corps.values()].map((c) => ({ vc: c.vc, p: c.p, d: c.d, s: Object.fromEntries(Object.entries(c.s).map(([k, v]) => [k, v.join('')])), prev: c.prev, rv: c.rv || 0, fn: c.fn || 0 })),
    fails: failList.slice(0, FAIL_ROWS_MAX), failsTotal: failList.length,
    repeat, repeatTotal: failList.filter((x) => x.failDays >= 2).length,
    now: (Array.isArray(a.now) ? a.now : []).filter((x) => x && pset.has(x.product)).slice(0, FAIL_ROWS_MAX).map((x) => ({ vc: String(x.vc), product: x.product, vm: str(x.vm), name: str(x.name) })),
  };
}

/**
 * 3절 합계(순수 — 문서를 범위로 자른 뒤에도 같은 함수로 다시 낸다 · 화면 · HTML · 메일이 이 값을 쓴다).
 * @returns {{total, products, prev, days, unknownCorpDays, corpsWithUnknown, failNow, repeat, fails, coverage}}
 */
export function backupSummary(sec) {
  if (!sec || !Array.isArray(sec.corps)) return null;
  const products = sec.products || PRODUCTS;
  const byP = Object.fromEntries(products.map((p) => [p, zero()]));
  const total = zero();
  const prev = { e: 0, f: 0, ok: 0, w: 0, kd: 0, ud: 0 };
  const days = (sec.days || []).map((d) => ({ day: d.day, label: d.label, e: 0, ok: 0, w: 0, f: 0, u: 0, k: 0 }));
  let corpsWithUnknown = 0; let failNow = 0; let repeatVms = 0;
  for (const c of sec.corps) {
    let unk = false;
    for (const p of products) { addInto(byP[p], c.p?.[p]); addInto(total, c.p?.[p]); if ((c.p?.[p]?.ud || 0) > 0) unk = true; }
    if (unk) corpsWithUnknown += 1;
    addInto(prev, c.prev);
    (c.d || []).forEach((x, i) => { if (!days[i]) return; days[i].e += x[0]; days[i].ok += x[1]; days[i].w += x[2]; days[i].f += x[3]; days[i].u += x[4]; days[i].k += x[5]; });
    failNow += c.fn || 0; repeatVms += c.rv || 0;
  }
  const sealedDays = days.filter((d) => d.k > 0).length;
  return {
    total: { ...total, rate: rateOf(total) }, products: Object.fromEntries(products.map((p) => [p, { ...byP[p], rate: rateOf(byP[p]) }])),
    prev: { ...prev, rate: rateOf(prev), known: prev.kd > 0 },
    days, unknownCorpDays: total.ud, corpsWithUnknown, failNow, repeatVms, fails: sec.failsTotal ?? (sec.fails || []).length,
    coverage: { sealed: sealedDays, days: days.length, firstDay: sec.firstDay ?? null },
  };
}

/** 법인 하나의 3절 한 줄(표) — 합계 · 성공률 · 실패한 날 수 · 확인 불가 날 수. */
export function backupCorpRow(c, products) {
  const t = zero();
  for (const p of products || PRODUCTS) addInto(t, c.p?.[p]);
  const failDays = (c.d || []).filter((x) => x[3] > 0).length;
  return { vc: c.vc, ...t, rate: rateOf(t), failDays, repeatVms: c.rv || 0, failNow: c.fn || 0, unknownDays: t.ud, prev: { e: c.prev?.e || 0, f: c.prev?.f || 0, rate: rateOf(c.prev) } };
}

/** 3절을 보이는 vCenter 로 자른다(범위 계정 — 법인 행 · 실패 목록 · 지금 실패 모두). allowed 가 null 이면 그대로. */
export function scopeCutBackup(sec, allowed) {
  if (!sec || !allowed) return sec;
  const keep = (x) => allowed.has(String(x?.vc));
  const fails = (sec.fails || []).filter(keep);
  return { ...sec, corps: (sec.corps || []).filter(keep), fails, failsTotal: fails.length, repeat: (sec.repeat || []).filter(keep), repeatTotal: (sec.repeat || []).filter(keep).length, now: (sec.now || []).filter(keep), scoped: true };
}

/** 비관리자 판본 — 실패 사유 원문 대신 공개 문구(Veeam = 상세 화면과 같은 가림 · 복제 = 화면 안내 · Bareos = 상태 글자). */
export function publicBackup(sec) {
  if (!sec) return sec;
  const pub = (x) => ({ ...x, reason: x.reasonPub || null, reasonPub: undefined });
  return { ...sec, fails: (sec.fails || []).map(pub), repeat: (sec.repeat || []).map(pub) };
}

/** 회차 행렬에 싣는 3절 요약(보관함 목록이 문서를 읽지 않고 범위로 다시 센다) — { t:[끝남, 실패, 확인 불가 법인-날], vc:{ [vc]:[끝남, 실패, 확인 불가] } }. */
export function backupMatrixOf(sec) {
  if (!sec || !Array.isArray(sec.corps)) return null;
  const vc = {}; const t = [0, 0, 0];
  for (const c of sec.corps) {
    const s = zero();
    for (const p of sec.products || PRODUCTS) addInto(s, c.p?.[p]);
    vc[c.vc] = [s.e, s.f, s.ud];
    t[0] += s.e; t[1] += s.f; t[2] += s.ud;
  }
  return { t, vc, days: (sec.days || []).length, sealed: sec.sealedDays ?? null };
}
/** 행렬 요약 → 보이는 vCenter 만의 수(범위 계정 목록). */
export function backupFromMatrix(bk, allowed) {
  if (!bk) return null;
  if (!allowed) return { ended: bk.t?.[0] ?? 0, fail: bk.t?.[1] ?? 0, unknown: bk.t?.[2] ?? 0, days: bk.days ?? null, sealed: bk.sealed ?? null };
  let e = 0; let f = 0; let u = 0;
  for (const [vc, v] of Object.entries(bk.vc || {})) { if (!allowed.has(vc)) continue; e += Number(v?.[0]) || 0; f += Number(v?.[1]) || 0; u += Number(v?.[2]) || 0; }
  return { ended: e, fail: f, unknown: u, days: bk.days ?? null, sealed: bk.sealed ?? null };
}
