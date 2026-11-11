/**
 * storage/inspect/judge.js — 점검 **판정 코어**(v2.963 · 순수 · 서버 하나 — 화면 · 보고서 · 메일 · CSV 가 이 결과만 그린다).
 *
 *  · 입력: facts(facts.js · sanitizeFacts 를 지난 값) + why(못 읽은 사유) + perf(perf.js 의 장비 7일 노드 통계) + 기준값(thresholds).
 *  · 출력: 항목 20개 [{ id, no, group, label, status, value, basis, how, refs, why? }] — status 는 ok · warn · bad · unknown · na.
 *  · **확인 불가(unknown)는 정상이 아니다** — 값이 없으면 사유와 함께 unknown. 종합(summarize)은 다섯 개수를 따로 센다.
 *  · 기준은 catalog.THRESHOLD_DEFAULTS(출처가 준 숫자) — 노드 CPU 는 판정하지 않는다(Dell 기준 숫자 없음).
 */
import { ITEMS, GROUPS, STATUS_RANK, THRESHOLD_DEFAULTS } from './catalog.js';
import { numOrNull } from '../../util/numOrNull.js';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const pctText = (p) => (p == null ? '—' : `${Math.round(p * 10) / 10}%`);
const nodeList = (arr, f = (x) => `노드 ${x}`) => (arr || []).slice(0, 4).map(f).join(' · ') + ((arr || []).length > 4 ? ` 외 ${arr.length - 4}` : '');
const lnnText = (l) => (l == null ? '노드 ?' : `노드 ${l}`);
/** 기준값 정규화 — 숫자가 아니거나 범위 밖이면 기본값(설정 손상이 판정을 끄지 않게). */
export function thresholdsOf(t) {
  const out = { ...THRESHOLD_DEFAULTS };
  if (!isObj(t)) return out;
  const pick = (k, lo, hi) => { const n = numOrNull(t[k]); if (n != null && n >= lo && n <= hi) out[k] = n; };
  pick('capWarnPct', 50, 99); pick('capBadPct', 50, 100); pick('poolWarnPct', 50, 99); pick('poolBadPct', 50, 100);
  pick('vhsMinPct', 0, 50); pick('snapMaxPct', 1, 90); pick('busyMaxPct', 50, 100); pick('skewFactor', 1.1, 5);
  if (out.capWarnPct >= out.capBadPct) out.capWarnPct = Math.min(THRESHOLD_DEFAULTS.capWarnPct, out.capBadPct - 1);
  if (out.poolWarnPct >= out.poolBadPct) out.poolWarnPct = Math.min(THRESHOLD_DEFAULTS.poolWarnPct, out.poolBadPct - 1);
  return out;
}

/** 한 항목 판정 — r = { status, value, why? }. 못 읽음은 unknown + 사유. */
const U = (why, value = '—') => ({ status: 'unknown', value, why: why || '읽지 못했습니다' });
const JUDGE = {
  'cluster-health': (f, w) => {
    const h = f.health; if (!isObj(h) || !h.word) return U(w.health);
    const word = String(h.word).toUpperCase();
    const status = word === 'OK' ? 'ok' : /DOWN|CRIT|NOT OK|FAIL|READ.?ONLY/.test(word) ? 'bad' : 'warn';
    return { status, value: h.derived ? `${word}(노드 상태로 판단 — REST)` : word };
  },
  group: (f, w) => {
    const g = f.group; if (!isObj(g)) return U(w.group);
    if (g.inGroup >= g.total && !(g.down || []).length) return { status: 'ok', value: `노드 ${g.inGroup} / ${g.total} 이 그룹에 있음` };
    return { status: 'bad', value: `노드 ${g.inGroup} / ${g.total}${g.down?.length ? ` · 빠짐 ${nodeList(g.down)}` : ''}` };
  },
  events: (f, w) => {
    const e = f.events; if (!isObj(e)) return U(w.events);
    if (!e.severityKnown) return e.total > 0 ? { status: 'unknown', value: `미해결 ${e.total}건(심각도 미확인)`, why: '이 경로는 심각도를 주지 않아 critical 여부를 모릅니다' } : { status: 'ok', value: '미해결 0건' };
    const c = e.critical || 0;
    const v = `critical ${c}${e.warning != null ? ` · warning ${e.warning}` : ''}${e.source === 'isi-status' ? '(isi status 의 Critical Events)' : ''}`;
    return { status: c > 0 ? 'warn' : 'ok', value: v };
  },
  'node-state': (f, w) => {
    const n = f.nodeState; if (!isObj(n)) return U(w.nodeState);
    if (n.bad?.length) {
      const down = n.bad.some((x) => /down|^d|-d|\bd\b/i.test(String(x.state)));
      return { status: down ? 'bad' : 'warn', value: `${nodeList(n.bad, (x) => `${lnnText(x.lnn)} ${x.state}`)}` };
    }
    if (n.unknown) return { status: 'unknown', value: `노드 ${n.unknown} / ${n.total} 상태 못 읽음`, why: '노드 상태 필드를 읽지 못한 노드가 있습니다' };
    return { status: 'ok', value: `노드 ${n.total} / ${n.total} 정상` };
  },
  drives: (f, w) => {
    const d = f.drives; if (!isObj(d)) return U(w.drives);
    if (d.notHealthy?.length) return { status: 'bad', value: `${nodeList(d.notHealthy, (x) => `${lnnText(x.lnn)}${x.bay ? ` 베이 ${x.bay}` : ''} ${x.state}`)} · ${d.total - d.notHealthy.length} / ${d.total} HEALTHY` };
    return { status: 'ok', value: `${d.total} / ${d.total} HEALTHY` };
  },
  'boot-mirror': (f, w) => {
    const b = f.bootMirror; if (!isObj(b)) return U(w.bootMirror);
    if (b.bad?.length) return { status: 'warn', value: `미러 이상 ${nodeList(b.bad)}` };
    return { status: 'ok', value: `노드 ${b.total} / ${b.total} 미러 정상` };
  },
  psu: (f, w) => {
    const p = f.psu; if (!isObj(p)) return U(w.psu);
    if (p.bad?.length) return { status: 'bad', value: `${p.bad.length} / ${p.total} 이상 — ${nodeList(p.bad, (x) => `${lnnText(x.lnn)} ${x.text}`)}` };
    return { status: 'ok', value: `${p.total} / ${p.total} good` };
  },
  battery: (f, w) => {
    const b = f.battery; if (!isObj(b)) return U(w.battery);
    if (b.bad?.length) return { status: 'bad', value: `${b.bad.length} / ${b.total} 이상 — ${nodeList(b.bad, (x) => `${lnnText(x.lnn)} ${x.text}`)}` };
    return { status: 'ok', value: `${b.total} / ${b.total} good` };
  },
  ifaces: (f, w) => {
    const i = f.ifaces; if (!isObj(i)) return U(w.ifaces);
    if (!i.configured) return { status: 'unknown', value: '구성된 포트를 찾지 못함', why: 'IP · 풀이 붙은 인터페이스가 응답에 없습니다' };
    if (i.down?.length) return { status: 'warn', value: `구성된 포트 ${i.configured} 중 ${i.down.length}개 up 아님 — ${nodeList(i.down, (x) => `${lnnText(x.lnn)} ${x.name} ${x.status}`)}` };
    return { status: 'ok', value: `구성된 포트 ${i.configured} / ${i.configured} up` };
  },
  healthcheck: (f, w) => {
    const h = f.healthcheck; if (!isObj(h)) return U(w.healthcheck);
    if (!h.evaluations) return { status: 'unknown', value: '평가 기록 없음', why: '장비에서 HealthCheck 평가를 돌린 기록이 없습니다(포탈은 평가를 돌리지 않습니다)' };
    if (h.failed?.length) return { status: 'warn', value: `평가 ${h.evaluations}건 중 FAIL ${h.failed.length} — ${h.failed.slice(0, 2).map((x) => x.checklist || x.id).join(' · ')}` };
    return { status: 'ok', value: `평가 ${h.evaluations}건 · FAIL 0` };
  },
  ntp: (f, w) => {
    const n = f.ntp; if (!isObj(n)) return U(w.ntp);
    return n.servers > 0 ? { status: 'ok', value: `NTP 서버 ${n.servers}개 구성` } : { status: 'warn', value: 'NTP 서버 없음' };
  },
  capacity: (f, w, t) => {
    const c = f.capacity; if (!isObj(c) || c.pct == null) return U(w.capacity);
    return { status: c.pct >= t.capBadPct ? 'bad' : c.pct >= t.capWarnPct ? 'warn' : 'ok', value: pctText(c.pct) };
  },
  pools: (f, w, t) => {
    const p = Array.isArray(f.pools) ? f.pools.filter((x) => x.pct != null) : null;
    if (!p || !p.length) return U(w.pools);
    const top = p.reduce((a, b) => (b.pct > a.pct ? b : a));
    return { status: top.pct >= t.poolBadPct ? 'bad' : top.pct >= t.poolWarnPct ? 'warn' : 'ok', value: `가장 찬 풀 ${top.name || '?'} ${pctText(top.pct)}` };
  },
  vhs: (f, w, t) => {
    const v = f.vhs; if (!isObj(v) || v.enabled == null) return U(w.vhs);
    if (!v.enabled) return { status: 'warn', value: '꺼짐' };
    if (v.pct != null && v.pct < t.vhsMinPct) return { status: 'warn', value: `켜짐 · ${pctText(v.pct)} 예약(10% 미만)` };
    return { status: 'ok', value: `켜짐${v.pct != null ? ` · ${pctText(v.pct)} 예약` : v.drives ? ` · 드라이브 ${v.drives}개` : ''}` };
  },
  snapshots: (f, w, t) => {
    const s = f.snapshots; const tot = numOrNull(f.capacity?.totalBytes);
    if (!isObj(s)) return U(w.snapshots);
    if (!(tot > 0)) return U('클러스터 전체 용량을 몰라 비율을 내지 못했습니다', `${s.count}개`);
    const pct = (s.usedBytes / tot) * 100;
    const lg = s.largestBytes != null ? ` · 가장 큰 스냅샷 ${pctText((s.largestBytes / tot) * 100)}` : '';
    if (pct > t.snapMaxPct) return { status: 'warn', value: `${pctText(pct)}${s.partial ? ' 이상(일부만 셈)' : ''}${lg} · ${s.count}개` };
    if (s.partial) return { status: 'unknown', value: `${pctText(pct)} 이상(일부만 셈)`, why: '목록이 길어 일부만 읽었습니다 — 합계가 하한이라 10% 이하라고 단정하지 않습니다' };
    return { status: 'ok', value: `${pctText(pct)}${lg} · ${s.count}개` };
  },
  'disk-busy': (f, w, t, p) => {
    if (!isObj(p) || !p.samples) return U(p?.why || '7일 안에 노드 디스크 표본이 없습니다(표본 수집이 꺼졌거나 아직 쌓이지 않았습니다)');
    const ns = (p.nodes || []).filter((n) => n.busyAvg != null);
    if (!ns.length) return U('디스크 busy 값이 든 표본이 없습니다');
    const top = ns.reduce((a, b) => (b.busyAvg > a.busyAvg ? b : a));
    const v = `가장 바쁜 ${lnnText(top.lnn)} 평균 ${pctText(top.busyAvg)}${top.busyMax != null ? ` · 피크 ${pctText(top.busyMax)}` : ''}`;
    return { status: top.busyAvg >= t.busyMaxPct ? 'warn' : 'ok', value: v };
  },
  'node-skew': (f, w, t, p) => {
    if (!isObj(p) || !p.samples) return U(p?.why || '7일 안에 노드 처리량 표본이 없습니다');
    const s = p.skew;
    if (!isObj(s) || s.nodes < 2) return { status: 'na', value: '노드 1대 — 편중을 따지지 않습니다' };
    if (s.ratio == null) return U('노드 처리량 평균이 0 이라 비율을 내지 못했습니다');
    return { status: s.ratio >= t.skewFactor ? 'warn' : 'ok', value: `가장 바쁜 ${lnnText(s.lnn)} = 평균의 ${s.ratio}배(${s.metricLabel || 'ops/s'})` };
  },
  jobs: (f, w) => {
    const j = f.jobs; if (!isObj(j)) return U(w.jobs);
    if (j.failed?.length) return { status: 'warn', value: `실패 ${j.failed.length} — ${j.failed.slice(0, 2).map((x) => x.name).join(' · ')}` };
    return { status: 'ok', value: `실패 0 · 실행 · 대기 ${j.running?.length || 0}` };
  },
  reprotect: (f, w) => {
    const j = f.jobs; if (!isObj(j)) return U(w.jobs);
    const fp = (j.running || []).filter((x) => /flexprotect/i.test(x.name));
    if (fp.length) return { status: 'warn', value: `${fp.map((x) => `${x.name}${x.progress ? ` ${x.progress}` : ''}`).join(' · ')} 진행 중` };
    return { status: 'ok', value: '진행 중인 재보호 없음' };
  },
  synciq: (f, w) => {
    const s = f.synciq; if (!isObj(s)) return U(w.synciq);
    if (!s.policies) return { status: 'na', value: '정책 없음' };
    if (s.failed) return { status: 'warn', value: `지난 7일 보고서 ${s.reports}건 중 실패 ${s.failed}${s.failedPolicies?.length ? ` — ${s.failedPolicies.slice(0, 2).join(' · ')}` : ''}` };
    return { status: 'ok', value: `지난 7일 보고서 ${s.reports}건 · 실패 0` };
  },
};

/**
 * 장비 하나 판정.
 * @param {{facts?:object, why?:object}} run   저장된 점검 실행(facts · why) — 없으면 장비 명령 항목은 전부 확인 불가
 * @param {object|null} perf  perf.devicePerf 결과(7일 노드 통계)
 * @returns {Array<{id,no,group,label,status,value,basis,how,refs,why?,syntaxUnverified?}>}
 */
export function judgeDevice(run, perf = null, thresholds = null) {
  const t = thresholdsOf(thresholds);
  const facts = isObj(run?.facts) ? run.facts : {};
  const why = isObj(run?.why) ? run.why : {};
  const noRun = !isObj(run?.facts);
  return ITEMS.map((it) => {
    let r;
    try { r = JUDGE[it.id](facts, why, t, perf); } catch (e) { r = U(`판정 중 오류: ${String(e?.message || e).slice(0, 80)}`); }
    if (noRun && it.source !== 'portal') r = U('이 장비는 아직 점검을 실행하지 않았습니다');
    const basis = it.id === 'node-skew' ? `가장 바쁜 노드 < 노드 평균 × ${t.skewFactor}(포탈 기준 — Dell 수치 아님)`
      : it.id === 'capacity' ? `${t.capBadPct}% 미만 유지 · ${t.capWarnPct}% 부터 증설 발주` : it.basis;
    return { id: it.id, no: it.no, group: it.group, label: it.label, status: r.status, value: r.value ?? '—', basis, how: it.how, refs: it.refs,
      ...(r.status === 'unknown' || r.status === 'na' ? { why: r.why || null } : {}), ...(it.syntaxUnverified ? { syntaxUnverified: true } : {}) };
  });
}
/** 다섯 개수 + 종합(가장 나쁜 상태 — 확인 불가는 정상으로 흡수하지 않는다: 정상 + 확인 불가 = 'unknown'). */
export function summarize(items) {
  const c = { ok: 0, warn: 0, bad: 0, unknown: 0, na: 0 };
  for (const i of items || []) if (Object.hasOwn(c, i.status)) c[i.status] += 1;
  const overall = c.bad ? 'bad' : c.warn ? 'warn' : c.unknown ? 'unknown' : c.ok ? 'ok' : 'na';
  return { ...c, total: (items || []).length, overall };
}
/** 구분별 대표 상태(가장 나쁜 것) — 화면 띠 · 이력 비교. */
export function groupStatus(items) {
  const out = {};
  for (const g of GROUPS) {
    const xs = (items || []).filter((i) => i.group === g.id);
    out[g.id] = xs.reduce((a, b) => (STATUS_RANK[b.status] > STATUS_RANK[a] ? b.status : a), 'na');
  }
  return out;
}
/** 지난 실행과 비교 — 새로 나빠진 항목 · 풀린 항목(이상 · 주의 기준). */
export function diffItems(cur, prev) {
  if (!Array.isArray(prev) || !prev.length) return { worse: [], better: [], base: false };
  const p = new Map(prev.map((i) => [i.id, i.status]));
  const bad = (s) => s === 'bad' || s === 'warn';
  const worse = []; const better = [];
  for (const i of cur || []) {
    const was = p.get(i.id);
    if (was == null) continue;
    if (STATUS_RANK[i.status] > STATUS_RANK[was] && bad(i.status)) worse.push({ id: i.id, label: i.label, from: was, to: i.status });
    else if (bad(was) && !bad(i.status) && i.status !== 'unknown') better.push({ id: i.id, label: i.label, from: was, to: i.status });
  }
  return { worse, better, base: true };
}
