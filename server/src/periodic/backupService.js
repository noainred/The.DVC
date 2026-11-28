/**
 * periodic/backupService.js — 백업 성공 · 실패 현황(보고서 3절 · v3.59 · 설계 §9)의 연결부: 10분 관측 틱 · 3절 조립 · 백업 항목 판정 자료.
 *   규칙은 backupLedger.js(순수), DB 는 backupStore.js. **새로 수집하지 않는다** — Veeam 결과 · Bareos 원장은 라우트 공급자(backup-observe — Detail 과 같은 VM 행),
 *   VM 백업(복제)은 잡 원장 · 엣지 보고를 읽는다. B&R · Director · 법인 엣지를 부르지 않는다.
 *  · 중앙 전용(정기 점검 보고와 같다) · 관측은 서버 전체에서 동시 1건 · 관측 실패는 상태에 남기고(무음 실패 금지) 다음 틱에 다시 본다.
 */
import { periodicProvider } from './providers.js';
import { dayIndex, dayLabel } from '../util/dayKey.js';
import {
  PRODUCTS, CAPTURE_MS, SEAL_LAG_MS, observeOf, veeamStateOf, bareosStateOf, cloneStateOf, failStreak, buildBackupSection, LEDGER_KEEP,
} from './backupLedger.js';
import * as bs from './backupStore.js';

const DAY = 86_400_000;
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const KNOWN_MAX = 200_000;
const KNOWN_KEEP_MS = 3 * DAY;
/** 복제 잡 기록 보관 개수(vmclone/store.js HISTORY_MAX · 엣지 보고 slice(-30)) — 이 수가 차 있으면 그보다 앞 실행은 밀려났다. */
const CLONE_HISTORY_KEEP = 30;
let _busy = false;
let _last = null;           // { at, ok, reason?, inserted, sealed, resealed, ms, vcs, clones }
const _known = new Map();   // `${product}|${vm}|${endedAt}` → endedAt — 이미 넣은 관측(같은 결과를 틱마다 다시 쓰지 않게 · 재시작하면 비어 OR IGNORE 가 거른다)

const kOf = (o) => `${o.product}|${o.vm}|${o.endedAt}`;
function remember(list, now) {
  for (const o of list) _known.set(kOf(o), o.endedAt);
  // 나이로 정리(관측마다 — 성능 축 P8: 18만 키를 넘을 때만 지우면 큰 환경에서 3주 넘게 자랐다)
  for (const [k, t] of _known) if (now - t > KNOWN_KEEP_MS) _known.delete(k);
  while (_known.size > KNOWN_MAX) _known.delete(_known.keys().next().value);
}

/** 날 표기 'MM-DD (요)'. */
export function dayText(d) {
  const iso = dayLabel(d);
  if (!iso) return String(d);
  const wd = WD[new Date(`${iso}T00:00:00Z`).getUTCDay()];
  return `${iso.slice(5)} (${wd})`;
}

/**
 * VM 백업(복제) 잡 → 관측 자료. 실행 위치는 Detail 의 Clone 칸(vmclone/jobState.js)과 같은 판정 하나 — execTargetOf:
 *   중앙 직접 수집이면 이 노드의 잡 기록(데이터 시각 = 지금) · 엣지 위임이면 **지금 담당 엣지**의 보고(데이터 시각 = 그 보고를 받은 시각) ·
 *   담당 엣지가 아직 보고하지 않았거나 불일치 · 미확정이면 모름(at 0 — 그 법인은 오래됨 · 확인 불가. 이 노드의 빈 기록으로 '실행 없음' 을 지어내지 않는다 — 엣지 축 E1 · E2).
 *   실행은 기록(history)에서만 센다(lastRun 은 같은 실행의 사본이고, 스냅샷 경고 덧붙이기가 시각만 새로 바꾼다 — 판정 축 F1 · F9).
 *   엣지 시각은 원래 값을 쓴다(수신 시각으로 자르면 보고마다 같은 실행의 시각이 바뀌어 관측이 여러 줄이 된다 — E3). 미래 시각은 observeOf 가 받지 않는다.
 * @returns {Promise<Array|null>} 잡 원장을 못 읽었으면 null(모름 — 빈 목록으로 '잡 없음' 을 지어내지 않는다 · E4)
 */
async function cloneSources(now) {
  try {
    const store = await import('../vmclone/store.js');
    if (store.jobsLoadError()) return null;
    const { execTargets, edgeStateOf } = await import('../vmclone/dispatch.js');
    const { rpoOf, lastSuccessAt } = await import('../vmclone/rpo.js');
    const { loadVcenterConfig } = await import('../config.js');
    const { listInventory } = await import('../central/inventory.js');
    const { getDataSource } = await import('../runtime-settings.js');
    let mock = false; try { mock = getDataSource() === 'mock'; } catch { mock = false; }
    let vcs = []; try { vcs = loadVcenterConfig().vcenters || []; } catch { vcs = []; }
    let inv = []; try { inv = listInventory() || []; } catch { inv = []; }
    const targets = execTargets(vcs, inv, { mock });
    const out = [];
    for (const j of store.listJobs()) {
      const vc = String(j.vcenterId || '');
      if (!vc) continue;
      const tg = targets.get(vc) || { where: 'none' };
      let hist = null; let lastRun = null; let at = 0;
      if (tg.where === 'local') { hist = Array.isArray(j.history) ? j.history : []; lastRun = j.lastRun || null; at = now; }
      else if (tg.where === 'edge') {
        const e = edgeStateOf(tg.agent);
        const st = e?.jobs?.get?.(j.id);
        if (st) { hist = Array.isArray(st.history) ? st.history : []; lastRun = st.lastRun || null; at = Number(e.at) || 0; }
      }
      const known = hist != null;
      const h = known ? hist : [];
      const runs = h.length ? h : (lastRun ? [{ ...lastRun, kind: lastRun.kind || 'backup' }] : []);
      const def = { enabled: j.enabled !== false && j.demo !== true, schedule: j.schedule, createdAt: j.createdAt, ...(j.suspended ? { suspended: j.suspended } : {}) };
      const job = { ...def, history: h, lastRun };
      const r = known ? rpoOf(job, now) : null;
      const ats = h.map((x) => Number(x?.at)).filter((t) => Number.isFinite(t) && t > 0);
      out.push({
        vc, key: `job:${j.id}`, name: j.vmName, at, known, target: known && r != null, runs,
        full: h.length >= CLONE_HISTORY_KEEP, oldestAt: ats.length ? Math.min(...ats) : null,
        rpo: r, lastOkAt: known ? lastSuccessAt(job) : null, createdAt: Number(j.createdAt) > 0 ? Number(j.createdAt) : null, enabled: def.enabled && !j.suspended,
      });
    }
    return out;
  } catch { return null; }
}

/**
 * 관측 한 번(서비스 틱이 CAPTURE_MS 마다 부른다). 적재를 끈 설정이면 부르지 않는다.
 * @returns {Promise<{action:string, reason?:string}>}
 */
export async function captureBackups({ now = Date.now() } = {}) {
  if (_busy) return { action: 'busy' };
  const p = periodicProvider('backup-observe');
  if (!p) { _last = { at: now, ok: false, reason: '백업 결과 공급자가 등록되지 않았습니다(라우트를 싣지 않은 실행)' }; return { action: 'no-provider' }; }
  _busy = true;
  const t0 = Date.now();
  try {
    const data = await p();
    if (data?.notReady) { _last = { at: now, ok: false, reason: String(data.reason || '아직 준비되지 않았습니다').slice(0, 200) }; return { action: 'not-ready' }; }
    const clones = await cloneSources(now);
    const { obs, seen } = observeOf({ vcs: data?.vcs || [], clones: clones || [], now });
    const fresh = obs.filter((o) => !_known.has(kOf(o)));
    const r = await bs.recordCapture({ obs: fresh, seen, now });
    if (!r.ok) { _last = { at: now, ok: false, reason: `적재하지 못했습니다: ${r.reason}` }; return { action: 'db-fail', reason: r.reason }; }
    remember(fresh, now);
    const s = await bs.sealDue({ now, dirty: r.dirty || [] });
    _last = { at: now, ok: s.ok, ...(s.ok ? {} : { reason: `확정하지 못했습니다: ${s.reason}` }), inserted: r.inserted, sealed: s.sealed ?? 0, resealed: s.resealed ?? 0,
      ms: Date.now() - t0, vcs: (data?.vcs || []).length, clones: clones == null ? null : clones.length, ...(clones == null ? { cloneNote: 'VM 백업 잡 원장을 읽지 못했습니다' } : {}) };
    return { action: 'ok' };
  } catch (e) {
    _last = { at: now, ok: false, reason: String(e?.message || e).slice(0, 200) };
    return { action: 'error', reason: _last.reason };
  } finally { _busy = false; }
}

/** 화면 '적재 상태'(관측 주기 · 확정 지연 · 보관 상한은 서버 값 — 화면이 숫자를 박지 않는다). */
export async function ledgerStatus() {
  const info = await bs.backupLedgerInfo();
  return { captureMs: CAPTURE_MS, sealLagMs: SEAL_LAG_MS, last: _last, busy: _busy, db: info, keep: LEDGER_KEEP };
}

/**
 * 백업 항목 판정 자료(회차마다 한 번 — ctx.cache). 공급자를 지금 부르고(저장된 결과), 연속 실패는 적재 원본과 합친다.
 *   provider.ok=false 면 Veeam · Bareos 는 확인 불가(리더가 사유를 싣는다) · cloneOk=false 면 복제 잡 원장을 못 읽음.
 *   nowUnknown = 지금 결과를 다 읽지 못한 법인(Veeam 일부 · Director 결과 모름 · 복제 보고 없음) — 3절 '지금 실패' 는 그 법인을 부분 합으로 세지 않는다.
 * @returns {Promise<{provider:{ok:boolean, reason?:string}, cloneOk:boolean, at:number, vcs:Map<string,object>, now:Array, nowUnknown:Set<string>}>}
 */
export async function backupFacts(ctx) {
  if (ctx?.cache?.has('backup-facts')) return ctx.cache.get('backup-facts');
  const run = (async () => {
    const now = ctx?.now ?? Date.now();
    const p = periodicProvider('backup-observe');
    let data = null; let provider = { ok: true };
    if (!p) provider = { ok: false, reason: '백업 결과 공급자가 등록되지 않았습니다' };
    else {
      try { data = await p(); } catch (e) { provider = { ok: false, reason: `백업 결과를 읽지 못했습니다: ${String(e?.message || e).slice(0, 120)}` }; }
      if (data?.notReady) provider = { ok: false, reason: String(data.reason || '아직 준비되지 않았습니다') };
    }
    if (!provider.ok) data = null;
    const clones = await cloneSources(now);
    const vcs = new Map();
    const nowList = [];
    const nowUnknown = new Set();
    const vcOf = (id) => { let x = vcs.get(id); if (!x) { x = { veeam: null, bareos: null, clone: null }; vcs.set(id, x); } return x; };
    const ageOf = (since) => (Number.isFinite(since) && since > 0 ? now - since : null);
    const failKeys = [];
    for (const vc of data?.vcs || []) {
      const x = vcOf(String(vc.id));
      const v = vc.veeam;
      if (v && v.state !== 'unlinked') {
        const f = { state: v.state, unknown: v.state !== 'ok', vms: 0, fails: [], rpo3: 0, rpo7: 0, rpoUnknown: 0 };
        for (const m of v.vms || []) {
          f.vms += 1;
          const age = ageOf(m.lb);
          if (age == null) f.rpoUnknown += 1; else { if (age > 3 * DAY) f.rpo3 += 1; if (age > 7 * DAY) f.rpo7 += 1; }
          if (veeamStateOf(m.lr) === 'fail' && Number.isFinite(m.lrt)) { f.fails.push({ vm: String(m.id), name: m.name, endedAt: m.lrt, lastOkAt: Number.isFinite(m.lb) ? m.lb : null }); failKeys.push(`veeam|${m.id}`); }
        }
        if (f.unknown) nowUnknown.add(String(vc.id));
        x.veeam = f;
      }
      const b = vc.bareos;
      if (b && b.mapped) {
        // Director 결과를 모르면(인증 정지 · 조회 실패 · 잘린 조회) 원장의 옛 실패를 '지금 실패' 로 세지 않는다 — Detail(backupVmRows)과 같은 판정(판정 축 F4)
        const known = b.resultsKnown === true && b.partial !== true;
        const f = { known, state: b.state, jobs: 0, fails: [], rpo3: 0, rpo7: 0, rpoUnknown: 0 };
        if (!known) nowUnknown.add(String(vc.id));
        for (const j of b.jobs || []) {
          if (j.enabled === false || j.missing) continue;
          f.jobs += 1;
          if (!known) continue;
          const runs = (j.runs || []).map((r) => ({ endedAt: r.endedAt, state: bareosStateOf(r.status) })).filter((r) => r.state && Number.isFinite(r.endedAt));
          const age = ageOf(Number.isFinite(j.lastOkAt) ? j.lastOkAt : j.createdAt);
          if (age == null) f.rpoUnknown += 1; else { if (age > 3 * DAY) f.rpo3 += 1; if (age > 7 * DAY) f.rpo7 += 1; }
          const streak = failStreak(runs);
          if (streak > 0) f.fails.push({ vm: String(j.vmId), name: j.vmName, streak, endedAt: runs.sort((a, c) => c.endedAt - a.endedAt)[0]?.endedAt ?? null, lastOkAt: Number.isFinite(j.lastOkAt) ? j.lastOkAt : null });
        }
        x.bareos = f;
      }
    }
    for (const c of clones || []) {
      if (!c.enabled) continue;
      const x = vcOf(c.vc);
      if (!x.clone) x.clone = { jobs: 0, fails: [], rpo3: 0, rpo7: 0, rpoUnknown: 0, unknownJobs: 0, unknown: false };
      const f = x.clone;
      f.jobs += 1;
      // 담당 엣지가 지금 보고하지 않은 위임 잡 — 결과 · RPO 를 모른다(만든 시각부터 세어 '7일 넘음' 을 지어내지 않는다 — 엣지 축 E1)
      if (!c.known) { f.unknownJobs += 1; f.unknown = true; nowUnknown.add(c.vc); continue; }
      const runs = (c.runs || []).map((h) => ({ endedAt: Number(h.at), state: cloneStateOf(h) })).filter((r) => r.state && Number.isFinite(r.endedAt));
      const streak = failStreak(runs);
      if (streak > 0) f.fails.push({ vm: c.key, name: c.name, streak, endedAt: runs.sort((a, d) => d.endedAt - a.endedAt)[0]?.endedAt ?? null, lastOkAt: c.lastOkAt ?? null });
      // 컨펌 ⑤ 그대로 — 마지막 성공 3일 · 7일(모든 백업 같은 기준 · 판정 축 F7). 성공이 없으면 만든 시각부터.
      const age = ageOf(c.lastOkAt ?? c.createdAt);
      if (age == null) f.rpoUnknown += 1; else { if (age > 3 * DAY) f.rpo3 += 1; if (age > 7 * DAY) f.rpo7 += 1; }
    }
    // Veeam 은 VM 마다 마지막 결과 하나라 연속 실패를 적재 원본으로 센다(지금 결과를 맨 앞에 더한다 — 아직 관측되지 않았을 수 있다)
    const facts = await bs.vmFacts(failKeys);
    for (const [id, x] of vcs) {
      for (const f of x.veeam?.fails || []) {
        const runs = [...(facts.get(`veeam|${f.vm}`)?.runs || [])];
        if (!runs.some((r) => r.endedAt === f.endedAt)) runs.push({ endedAt: f.endedAt, state: 'fail' });
        f.streak = failStreak(runs);
        nowList.push({ vc: id, product: 'veeam', vm: f.vm, name: f.name });
      }
      for (const f of x.bareos?.fails || []) nowList.push({ vc: id, product: 'bareos', vm: f.vm, name: f.name });
      for (const f of x.clone?.fails || []) nowList.push({ vc: id, product: 'clone', vm: f.vm, name: f.name });
    }
    return { provider, cloneOk: clones != null, at: data?.at ?? now, vcs, now: nowList, nowUnknown };
  })();
  ctx?.cache?.set('backup-facts', run);
  return run;
}

/**
 * 보고서 3절(회차 기간 · 법인 단위 — 범위로 자를 수 있게). 적재가 꺼졌거나 DB 를 못 열면 { off|error } 를 싣는다(지어내지 않는다).
 *   앞 기간은 같은 길이의 바로 앞 날들 · 이번 기간의 실패 VM 줄만 읽는다(조각 사이 양보 — 성능 축 P1).
 * @param {{from:number, to:number, now:number, settings:object, ctx?:object}} a
 */
export async function backupSectionFor({ from, to, now = Date.now(), settings, ctx = null }) {
  const b = settings?.backup || {};
  const products = PRODUCTS.filter((p) => b.products?.[p] !== false);
  if (b.ledger === false) return { v: 2, off: true, products, reason: '하루 치 적재가 꺼져 있습니다 — 일정 · 전달 › 백업 성공 · 실패 현황에서 켜면 그때부터 쌓습니다(꺼져 있던 날은 원본에 기록이 남은 만큼만 채우고, 나머지는 확인 불가로 둡니다)' };
  if (!products.length) return { v: 2, off: true, products, reason: '실을 백업을 하나도 고르지 않았습니다 — 일정 · 전달 › 백업 성공 · 실패 현황에서 고릅니다' };
  const d0 = dayIndex(from); const d1 = dayIndex(to - 1);
  const len = d1 - d0 + 1;
  const got = await bs.ledgerFor({ p0: d0 - len, d0, d1, now });
  if (!got) return { v: 2, error: true, products, reason: '보관 DB 를 열지 못해 백업 적재를 읽지 못했습니다' };
  const inCur = (r) => r.day >= d0 && r.day <= d1;
  const days = []; for (let d = d0; d <= d1; d++) days.push(d);
  const prevDays = []; for (let d = d0 - len; d < d0; d++) prevDays.push(d);
  const facts = ctx ? await backupFacts(ctx).catch(() => null) : null;
  const nowOk = !!facts && (!products.some((p) => p !== 'clone') || facts.provider?.ok) && (!products.includes('clone') || facts.cloneOk);
  const keys = [...new Set(got.vmRows.map((r) => `${r.product}|${r.vm}`))].slice(0, 1000);
  const vmFacts = await bs.vmFacts(keys);
  // 지금 아는 마지막 성공(공급자 — 적재 원본보다 길게 안다)이 있으면 그것을
  if (facts) {
    for (const x of facts.vcs.values()) for (const p of PRODUCTS) for (const f of x[p]?.fails || []) {
      const k = `${p}|${f.vm}`;
      const cur = vmFacts.get(k);
      if (cur && Number.isFinite(f.lastOkAt) && (cur.lastOkAt == null || f.lastOkAt > cur.lastOkAt)) cur.lastOkAt = f.lastOkAt;
    }
  }
  let strips = null;
  if (len > 1 && len <= 7) {
    const byVm = new Map();
    for (const r of got.vmRows) byVm.set(`${r.product}|${r.vm}`, (byVm.get(`${r.product}|${r.vm}`) || 0) + 1);
    strips = await bs.vmDayStates([...byVm.entries()].filter(([, n]) => n >= 2).map(([k]) => k).slice(0, 200), d0, d1);
  }
  return buildBackupSection({
    days, prevDays, dayRows: got.dayRows.filter(inCur), vmRows: got.vmRows, prevDayRows: got.dayRows.filter((r) => r.day < d0), pending: got.pending.filter(inCur),
    vmFacts, strips, now: facts ? facts.now : [], nowOk, nowUnknown: facts ? facts.nowUnknown : [],
    products, dayLabel: dayText, firstDay: got.firstDay, asOf: _last?.ok ? _last.at : null,
  });
}

export function _resetBackupServiceForTest() { _busy = false; _last = null; _known.clear(); }
