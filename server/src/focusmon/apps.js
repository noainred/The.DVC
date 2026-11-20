/**
 * focusmon/apps.js — 앱 단위 묶음 조회(v3.14.0 ⑮ — 시안 Apps · 사용자 "기본값대로 모두 구현해줘" · 컨펌 ① 서비스 ② 상위 30 그대로 · 앱 단위는 단추 ③ 분마다 상위 20 · 30일 ④ 사용자 지정 묶음 없음).
 *
 *  · 묶음은 수집기(rates.appGroups)가 프로세스 표본마다 만든다(모든 프로세스 · 원격 명령 추가 없음). 메모리의 최근 표본은 표본마다, DB 는 분마다 마지막 표본(store).
 *  · 표: 구간 끝 순간(마지막 표본) 또는 구간 평균(CPU · RSS · 읽기 · 쓰기 — 표본 간격 가중 · 상위 20 에 없던 표본은 그 값을 모르므로 그 표본을 빼고 평균).
 *  · 펼침: 마지막 표본의 프로세스 상위 30 가운데 그 묶음에 드는 것(같은 열쇠 함수 — rates.appServiceKey · appNameOf) + '상위 30 밖 N개'.
 *  · 쌓은 영역: 구간 안 표본의 CPU — 구간 전체 CPU 합이 큰 묶음 5개 + 나머지(그 표본의 상위 20 안의 나머지 합). 칸은 60개까지 · 표본이 없는 칸은 null(수집 안 함).
 *  · 서비스 지도를 못 받은 표본(sv null)은 서비스 기준에서 뺀다 — 모두 '서비스 없음' 으로 지어내지 않는다.
 *  · 사용자 이름은 관리자 판본만 원문(라우트가 maskUser 를 넘긴다).
 */
import { procSnaps, sampleWeights } from './query.js';
import { appNameOf, appServiceKey, APP_TOP } from './rates.js';
import { createYielder } from '../util/timeSlice.js';

export const APP_BY = Object.freeze(['sv', 'cm']);
export const APP_SERIES_TOP = 5;
export const APP_POINTS = 60;
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

/** 프로세스 한 줄(상위 30) → 그 기준의 묶음 열쇠. */
export function memberKey(p, by) { return by === 'cm' ? appNameOf(p.c) : appServiceKey(p.sv || null, p.pp ?? null, p.pid); }

/** 표본 목록 → 표(끝 순간 | 평균). */
export function appTable(snaps, by, at) {
  const has = snaps.filter((s) => Array.isArray(s.apps?.[by]));
  if (!has.length) return [];
  const last = has[has.length - 1].apps[by];
  if (at !== 'avg' || has.length < 2) return last.slice(0, APP_TOP);
  const ws = sampleWeights(has.map((s) => [null, null, Number(s.t)]));
  const acc = new Map();
  has.forEach((s, i) => { for (const a of s.apps[by]) {
    const x = acc.get(a.k) || { a, w: 0, cpu: 0, rss: 0, rb: 0, wb: 0, wio: 0 };
    x.a = a; x.w += ws[i]; x.cpu += (a.cpu ?? 0) * ws[i]; x.rss += (a.rss ?? 0) * ws[i];
    if (a.rb != null) { x.rb += a.rb * ws[i]; x.wb += (a.wb ?? 0) * ws[i]; x.wio += ws[i]; }
    acc.set(a.k, x);
  } });
  return [...acc.values()].map((x) => ({ ...x.a, cpu: r2(x.cpu / x.w), rss: r2(x.rss / x.w), ...(x.wio ? { rb: r2(x.rb / x.wio), wb: r2(x.wb / x.wio) } : {}) }))
    .sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0)).slice(0, APP_TOP);
}

/** 쌓은 영역 — 위 5개 + 나머지 · 칸 n 개(평균). */
export function appSeries(snaps, by, from, to, n = APP_POINTS) {
  const has = snaps.filter((s) => Array.isArray(s.apps?.[by]));
  if (!has.length) return null;
  const tot = new Map();
  for (const s of has) for (const a of s.apps[by]) tot.set(a.k, (tot.get(a.k) || 0) + (a.cpu ?? 0));
  // 색은 이름을 따라간다 — 위 5개를 고른 뒤 **이름 순**으로 자리를 준다(순위가 바뀌어도 같은 앱은 같은 색)
  const keys = [...tot.entries()].sort((a, b) => b[1] - a[1]).slice(0, APP_SERIES_TOP).map(([k]) => k).sort((a, b) => a.localeCompare(b));
  const pts = Math.max(1, Math.min(n, has.length));
  const step = (to - from) / pts;
  const sum = Array.from({ length: pts }, () => new Float64Array(keys.length + 1)); const cnt = new Array(pts).fill(0);
  for (const s of has) {
    const k = Math.min(pts - 1, Math.max(0, Math.floor((s.t - from) / step)));
    let rest = 0; const v = new Float64Array(keys.length);
    for (const a of s.apps[by]) { const j = keys.indexOf(a.k); if (j >= 0) v[j] += a.cpu ?? 0; else rest += a.cpu ?? 0; }
    for (let j = 0; j < keys.length; j++) sum[k][j] += v[j];
    sum[k][keys.length] += rest; cnt[k] += 1;
  }
  const vals = keys.map((_, j) => sum.map((b, k) => (cnt[k] ? r2(b[j] / cnt[k]) : null)));
  const rest = sum.map((b, k) => (cnt[k] ? r2(b[keys.length] / cnt[k]) : null));
  return { keys, vals, rest, points: pts };
}

/**
 * 서버마다 앱 묶음.
 * @returns {{by, at, per: Array<{id, lastAt, snaps, total, noUnits, apps, members, series}>}}
 */
export async function apps(ids, w, { by = 'sv', at = 'end', maskUser = (u) => u } = {}) {
  const b = APP_BY.includes(by) ? by : 'sv';
  const y = createYielder(15);
  const per = [];
  for (const id of ids) {
    const snaps = await procSnaps(id, w.from, w.to);
    const withApps = snaps.filter((s) => s.apps);
    const lastAny = withApps[withApps.length - 1] || null;
    const table = appTable(withApps, b, at).map((a) => ({ ...a, u: a.u ? maskUser(a.u) : null }));
    // 펼침 — 마지막 표본의 상위 30 안에서 그 묶음에 드는 프로세스
    const lastTop = snaps.length ? (snaps[snaps.length - 1].top || []) : [];
    const members = {};
    for (const a of table) members[a.k] = [];
    for (const p of lastTop) { const k = memberKey(p, b); if (members[k] && members[k].length < 30) members[k].push({ pid: p.pid, c: p.c, u: p.u ? maskUser(p.u) : null, cpu: p.cpu ?? null, rss: p.rss ?? null, th: p.th ?? null }); }
    per.push({ id, lastAt: lastAny ? lastAny.t : null, snaps: withApps.length, total: lastAny?.n ?? null,
      noUnits: b === 'sv' && withApps.length > 0 && withApps.every((s) => s.apps.sv == null),
      apps: table, members, series: appSeries(withApps, b, w.from, w.to) });
    await y();
  }
  return { by: b, at: at === 'avg' ? 'avg' : 'end', per };
}
