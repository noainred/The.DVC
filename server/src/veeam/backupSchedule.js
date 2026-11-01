/**
 * veeam/backupSchedule.js — Backup › Summary '백업 스케줄 — 다음 24시간'(v2.838 · 시안 ① '용량과 일정' 구획). 순수 함수.
 *   쓰는 곳: routes/api/veeam.js GET /tools/backup-summary/schedule.
 *
 * 출처(지어내지 않는다 — 사용자 결정 '출처를 바꿔 채우고 표기'):
 *   · Veeam = B&R 결과의 잡 '다음 실행'(nextRun) 하나 — 잡의 반복 주기는 포탈이 읽지 않으므로 **다음 1회만** 안다(7일 요약의 Veeam 칸은 오늘·내일만 · 그 밖 모름).
 *     띠 길이 = 그 잡의 지난 실행 폭(그 법인 VM 들의 마지막 task 시작~끝 — 36시간 안의 것만) · 모르면 60분(est 표지).
 *   · Bareos = 포탈 그룹 예약(groupSchedule.nextSlot 을 되풀이해 7일을 전개 — 스케줄 코어 하나) · 띠 길이 = 그룹 마지막 회차 폭을 모르니 60분(est).
 *   · Director 스케줄은 2차 수집 뒤(화면이 '—(2차)' 로 밝힌다).
 */

const isFin = (v) => typeof v === 'number' && Number.isFinite(v);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const DEFAULT_DUR_MS = HOUR;
export const DUR_LOOKBACK_MS = 36 * HOUR;
export const MAX_ITEMS_PER_SITE = 60;

/**
 * 그룹 예약 전개 — from 뒤 to 까지의 회차(nextSlot 을 되풀이). 무한 반복을 막으려고 상한(14)을 둔다.
 * @param {(sched:object, now:number) => ({at:number, level:string}|null)} nextSlot
 */
export function expandSlots(sched, from, to, nextSlot) {
  const out = [];
  let t = from;
  for (let i = 0; i < 14; i++) {
    const s = nextSlot(sched, t);
    if (!s || !isFin(s.at) || s.at > to) break;
    if (s.at <= t && i > 0) break;   // 앞으로 가지 않으면 멈춘다(코어가 같은 회차를 다시 주면)
    out.push({ at: s.at, level: String(s.level || '') });
    t = s.at + 60_000;
  }
  return out;
}

/**
 * 한 법인의 Veeam 잡 — VM 행(Detail 모양)에서 잡 이름별 VM 수 · 지난 실행 폭, 결과(잡 목록)에서 다음 실행.
 * @param {object[]} rows Detail VM 행(v.jobs · v.lrs · v.lrt)
 * @param {Array<{name:string, nextRun:number|null}>} jobs B&R 결과의 잡(그 법인을 맡는 서버들 — 이름이 VM 행에 있는 것만 쓴다)
 * @returns {Array<{ name, at, end, est, vms }>}  at 이 지금 뒤인 것만
 */
export function veeamJobItems(rows, jobs, now = Date.now()) {
  const by = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    for (const name of Array.isArray(r?.v?.jobs) ? r.v.jobs : []) {
      const x = by.get(name) || { vms: 0, s: null, e: null };
      x.vms++;
      const s = r.v.lrs; const e = r.v.lrt;
      if (isFin(s) && isFin(e) && s <= e && now - e <= DUR_LOOKBACK_MS) {
        if (x.s == null || s < x.s) x.s = s;
        if (x.e == null || e > x.e) x.e = e;
      }
      by.set(name, x);
    }
  }
  const next = new Map();
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (!j?.name || !by.has(j.name) || !isFin(j.nextRun) || j.nextRun <= now) continue;
    if (!next.has(j.name) || j.nextRun < next.get(j.name)) next.set(j.name, j.nextRun);
  }
  const out = [];
  for (const [name, at] of next) {
    const x = by.get(name);
    const known = x.s != null && x.e != null && x.e > x.s;
    out.push({ name, at, end: at + (known ? x.e - x.s : DEFAULT_DUR_MS), est: !known, vms: x.vms });
  }
  return out.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
}

/**
 * 한 법인의 Bareos 그룹 회차(예약이 켜진 그룹만) — [from, to] 안.
 * @param {Array<{name, vmIds, schedule}>} groups 그 법인의 그룹
 */
export function groupItems(groups, from, to, nextSlot) {
  const out = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    if (g?.schedule?.enabled !== true) continue;
    for (const s of expandSlots(g.schedule, from, to, nextSlot)) {
      out.push({ name: String(g.name || '').slice(0, 64), at: s.at, end: s.at + DEFAULT_DUR_MS, est: true, full: /^full$/i.test(s.level), level: s.level, vms: Array.isArray(g.vmIds) ? g.vmIds.length : 0, gid: String(g.id || '').slice(0, 64) });
    }
  }
  return out.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
}

/**
 * 겹침 — 같은 법인에서 Veeam 잡 창과 Bareos 그룹 창이 시간이 겹치는 구간(시안 '겹침 경고' — 동시 실행 상한에 걸려 대기가 길어지는 원인 후보).
 * @returns {null | { from, to, veeam:number, bareos:number }}
 */
export function overlapOf(veeam, bareos) {
  let from = null; let to = null; const vs = new Set(); const bs = new Set();
  for (const v of veeam || []) for (const b of bareos || []) {
    const s = Math.max(v.at, b.at); const e = Math.min(v.end, b.end);
    if (s < e) {
      vs.add(v.name); bs.add(`${b.name}@${b.at}`);
      if (from == null || s < from) from = s;
      if (to == null || e > to) to = e;
    }
  }
  return from == null ? null : { from, to, veeam: vs.size, bareos: bs.size };
}

/**
 * v2.840 그룹 카드의 겹침 경고 — 한 법인의 다음 24시간에서 그룹마다 overlapOf 를 그대로 쓴다(판정 하나):
 *   veeam = 그 그룹 회차 ↔ Veeam 잡 창 · bareos = 그 그룹 회차 ↔ 같은 법인의 다른 Bareos 회차(다른 그룹 · Director 스케줄 — 같은 Director 는 차례로 돈다).
 *   그룹 회차가 24시간 안에 없으면 싣지 않는다(화면 '—'). n = 겹친 상대 수.
 * @param {Array<{name,at,end}>} veeam @param {Array<{name,at,end,gid?}>} bareos 그룹 회차(gid 있음) + Director 회차(gid 없음)
 * @returns {Array<{ gid, veeam:{from,to,n}|null, bareos:{from,to,n}|null }>}
 */
export function groupOverlaps(veeam, bareos) {
  const list = Array.isArray(bareos) ? bareos : [];
  const ids = [...new Set(list.filter((i) => i.gid).map((i) => i.gid))];
  return ids.map((gid) => {
    const mine = list.filter((i) => i.gid === gid);
    const others = list.filter((i) => i.gid !== gid);
    const ov = overlapOf(veeam, mine); const ob = overlapOf(others, mine);
    return { gid, veeam: ov ? { from: ov.from, to: ov.to, n: ov.veeam } : null, bareos: ob ? { from: ob.from, to: ob.to, n: ob.veeam } : null };
  });
}

/**
 * 7일 요약 — 오늘부터 하루씩: Bareos 그룹 회차 수 · 그 VM 수 · Full 회차 수 · Veeam 잡 수(다음 실행이 그날인 것 — 다음 1회만 알므로 오늘·내일 밖은 null).
 * @param {number} dayStart 오늘 0시(포탈 서버 현지 — 호출부가 정한다)
 */
export function sevenDays(sites, dayStart) {
  const out = [];
  for (let i = 0; i < 7; i++) {
    const a = dayStart + i * DAY; const b = a + DAY;
    let groups = 0; let gvms = 0; let full = 0; let veeam = 0;
    for (const s of sites) {
      for (const g of s.bareos || []) if (g.at >= a && g.at < b) { groups++; gvms += g.vms; if (g.full) full++; }
      for (const v of s.veeam || []) if (v.at >= a && v.at < b) veeam++;
    }
    out.push({ day: a, groups, gvms, full, veeam: i < 2 ? veeam : null });
  }
  return out;
}

/**
 * VM 행에서 잡 '다음 실행' 을 모은다(B&R 결과 잡 목록을 따로 들고 다니지 않을 때 — Detail 행의 v.nr 은 그 VM 이 든 잡들 중 가장 이른 nextRun).
 *   VM 이 잡 하나에만 들 때만 그 nr 을 그 잡의 것으로 삼는다(둘 이상이면 어느 잡의 nr 인지 모른다 — 지어내지 않는다).
 */
export function jobsFromRows(rows) {
  const m = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const js = r?.v?.jobs;
    if (Array.isArray(js) && js.length === 1 && isFin(r.v.nr)) {
      const n = js[0];
      if (!m.has(n) || r.v.nr < m.get(n)) m.set(n, r.v.nr);
    }
  }
  return [...m].map(([name, nextRun]) => ({ name, nextRun }));
}
