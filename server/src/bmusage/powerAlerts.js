/**
 * bmusage/powerAlerts.js — 다음 점검 ②: **전력 · 온도 알림 규칙 4종**의 판정 입력 · 조건 · 관측 표지 · 문구(설계 PROFILES §20 ㉒ ‘알림 ⑨’ · 기본 꺼짐).
 *
 * 엔진은 5단계 perfAlerts.js 그대로다(규칙 상태 직렬 큐 · 지속 · 한 사건 한 번 · 재발 억제 · 하루 상한 · 채널 · 이슈 · 8a 정비 창 억제 · 해제는 억제하지 않음).
 *   여기는 ‘무엇을 참으로 보나’ 만 갖는다 — 값은 전부 전력 집계(powerAgg.gatherPower → aggregatePower — 전력 · 온도 화면과 **같은 함수**)에서 온다(판정 코어 하나).
 *
 * 규칙(조건 = true 성립 · false 읽었고 아님 · null 판정 보류 — null 은 지속을 이어 가지도 끊지도 않는다):
 *   rack     랙 여유 부족 — 상한(설정 kW)을 정한 랙만(미매핑 · 상한 미설정 랙은 항목이 없다) · 여유 < power.rackLowPct(화면 ‘주의’ 와 같은 low).
 *            **미측정 서버가 하나라도 있는 랙은 null**(부분 합 — 8b 반증 F6 marginPartial) · 측정 0대도 null.
 *   inlet    흡기 지속 초과 — 흡기 ≥ power.inletWarnC(화면 ‘더운 서버’ 와 같은 ≥). 센서 표본이 없거나 · 낡았거나(roomTemp 신선도) · 흡기 센서가 없으면 null
 *            (초과도 정상도 아니다 — 낡음으로 사건을 끊지 않고 이어 세지도 않는다). 흡기는 **지금 값만** 있다(시계열 없음 — 8b 결정) — 그래서 ‘지속’ 은 규칙 엔진이
 *            주기마다 들고 가는 연속 상태(streak)로 센다.
 *   surge    24시간 피크 급증 — 서버마다 최근 24시간 피크 ≥ 그 **앞 7일 피크** × (1 + power.surgePct%)(설계 ‘24h 피크가 7일 피크 +20%’ · 시간 행 피크 = hourSummary 와 같은 정의).
 *            7일 평균 대비가 아닌 이유: 피크를 평균과 대면 낮 · 밤 차이만으로 매일 걸린다. 지난 24시간 피크 대비가 아닌 이유: 하루 기준은 주말 → 월요일마다 걸린다.
 *            법인 · 랙 합이 아니라 서버인 이유: 합의 시간 피크는 ‘측정 서버가 다 모인 시간만’ 이어야 부분 합이 아닌데(finishGroup) 대수가 많으면 한 대의 1시간 결측만으로
 *            그 시간이 빠져 7일 창에 다 모인 시간이 거의 남지 않는다 — 서버 시간 행은 iDRAC 폴러가 부분 합 표본을 적재하지 않아(v2.602) 부분 합이 없다.
 *            미측정(그 창에 0 W 초과 시간 없음) · 앞 7일 시간 수 < SURGE_MIN_BASE_HOURS(피크는 시간이 적을수록 낮아 거짓 급증이 된다)이면 null.
 *   powerCap PowerCap 걸림 지속 — 지금 W ≥ 상한 × power.capHitPct%(aggregatePower capHit — 화면과 같은 판정). 미측정 · 상한 없음(unset · unread · stale)이면 null.
 * 관측 표지(obs): 같은 표본을 두 주기 세지 않는다 — iDRAC 폴러가 멈춰 2시간 신선도 안의 같은 값이 되풀이되면 ‘지속’ 이 아니다. 아직 사건이 아닌데(비활성) 표지가 직전과 같으면
 *   그 주기는 보류(null)로 본다(perfAlerts.evaluatePerfRules).
 * 식별: 서버 규칙 상태 열쇠는 (법인, 키) 쌍(maint/judge.js targetIdOf — 키만 쓰지 않는다) · 랙 항목 키는 `rack:<법인>|<랙>`(법인이 키에 들어 있어 다른 법인의 같은 랙 이름과 섞이지 않는다).
 * 판정 주체: 전력 원천(iDRAC 폴러)이 있는 노드 — 폴러 주기 대상(엣지 위임 서버 제외 — targets.js edge-delegated)을 localOnly 원천(powerSources)으로만 본다.
 *   엣지 위임 서버는 그 엣지가 판정해 봉투 발송 기록(perfAlertSent)으로 올리고 중앙은 다시 판정하지 않는다(중앙과 엣지가 같은 서버를 두 번 알리지 않는다).
 */
import { numOrNull } from '../util/numOrNull.js';
import { capStr } from '../util/capStr.js';
import { DAY_OFFSET_MIN } from '../util/dayKey.js';
import { POWER_RULE_IDS, DEFAULTS as RULE_SET_DEFAULTS } from './perfRules.js';
import { aggregatePower, gatherPower } from './powerAgg.js';

const n = numOrNull;
/** 규칙 → 항목 종류(랙 칸 · 서버 칸). 종류가 맞지 않는 항목에는 그 규칙을 대지 않는다(상태를 만들지 않는다). */
export const POWER_RULE_KIND = Object.freeze({ rack: 'rack', inlet: 'server', surge: 'server', powerCap: 'server' });
/** 피크 급증 — 앞 7일 창에 0 W 초과 시간이 이만큼은 있어야 판정한다(168시간의 4/7 — 절반을 넘게). */
export const SURGE_MIN_BASE_HOURS = 96;
export const isPowerRule = (id) => POWER_RULE_IDS.includes(id);
export const RACK_KEY_PREFIX = 'rack:';
export const rackKeyOf = (vcenterId, rack) => `${RACK_KEY_PREFIX}${String(vcenterId ?? '')}|${String(rack ?? '')}`;
/** 랙 키 → { vcenterId, rack }(형식 밖이면 null). 법인 id 에는 ‘|’ 가 없다(perfRules VC_RE) — 첫 ‘|’ 로 가른다. */
export function parseRackKey(key) {
  const s = String(key ?? '');
  if (!s.startsWith(RACK_KEY_PREFIX)) return null;
  const rest = s.slice(RACK_KEY_PREFIX.length); const i = rest.indexOf('|');
  if (i <= 0 || i === rest.length - 1) return null;
  return { vcenterId: rest.slice(0, i), rack: rest.slice(i + 1) };
}

/** 피크 급증 계산(순수). h24 = hourSummary(24시간) · base = peakSummary(앞 7일). */
export function surgeOf(h24, base, pct, { minBaseHours = SURGE_MIN_BASE_HOURS } = {}) {
  const peakW = n(h24?.peakW); const baseW = n(base?.peakW); const baseHours = n(base?.hours) ?? 0;
  if (peakW == null || peakW <= 0) return { state: 'none', peakW: null, baseW, baseHours };
  if (baseW == null || baseW <= 0) return { state: 'no-base', peakW, baseW: null, baseHours };
  if (baseHours < minBaseHours) return { state: 'short', peakW, baseW, baseHours };
  const ratioPct = Math.round(((peakW - baseW) / baseW) * 1000) / 10;
  return { state: 'ok', peakW, baseW, baseHours, hours24: n(h24?.hours), ratioPct, lastHour: Array.isArray(h24?.byHour) && h24.byHour.length ? h24.byHour[h24.byHour.length - 1].t : null, pct: n(pct) };
}

/**
 * 조건(순수) — true · false · null(보류). ctx.power 는 powerAlertItems 가 만든 칸(기준값을 함께 싣는다 — 시험 실행이 저장 전 값으로 대 보게).
 */
export function powerCondition(id, ctx = {}) {
  const p = ctx?.power;
  if (!p || p.kind !== POWER_RULE_KIND[id]) return null;
  if (id === 'rack') return typeof p.low === 'boolean' ? p.low : null;
  if (id === 'inlet') return p.tempState === 'ok' && n(p.inletC) != null && n(p.inletWarnC) != null ? p.inletC >= p.inletWarnC : null;
  if (id === 'powerCap') return typeof p.capHit === 'boolean' ? p.capHit : null;
  if (id === 'surge') { const sg = p.surge; return sg && sg.state === 'ok' && n(p.surgePct) != null ? sg.ratioPct >= p.surgePct : null; }
  return null;
}
/** 관측 표지(순수) — 같은 표본이면 같은 글자. 없으면 null(표지 없음 = 매 주기 새 관측으로 본다). */
export function powerObs(id, ctx = {}) {
  const p = ctx?.power;
  if (!p) return null;
  if (id === 'rack') return p.obs ?? null;
  if (id === 'inlet') return n(p.tempAt) != null ? `t${p.tempAt}` : null;
  if (id === 'powerCap') return n(p.at) != null ? `w${p.at}` : null;
  if (id === 'surge') return p.surge?.state === 'ok' ? `h${p.surge.lastHour ?? ''}:${p.surge.peakW}:${p.surge.baseW}` : null;
  return null;
}

const hm = (ms) => (n(ms) == null || ms <= 0 ? '모름' : new Date(ms + DAY_OFFSET_MIN * 60_000).toISOString().slice(5, 16).replace('T', ' '));
const kw = (v) => (n(v) == null ? '—' : `${v} kW`);
/** 알림 본문(순수 — `**` 없음 · 원인 단정 없음 · ‘무엇이 · 얼마나 · 무엇 대비 · 언제부터’). */
export function powerAlertOf(f, head, key) {
  const p = f.ctx?.power || {};
  const since = `${f.sustain || 1}주기 지속(서로 다른 표본) · 처음 성립 ${hm(f.since)}`;
  if (f.rule === 'rack') {
    const over = n(p.marginPct) != null && p.marginPct < 0;
    return { key, severity: over ? 'critical' : 'warning',
      title: capStr(`${head} 랙 상한 ${over ? `초과 ${Math.abs(p.marginPct)}%` : `여유 ${p.marginPct ?? '—'}%`}(기준 ${p.rackLowPct ?? '—'}% 미만)`, 200),
      detail: capStr(`지금 ${kw(p.nowKw)} / 상한 ${kw(p.capKw)}(설정값) · 측정 ${p.measured ?? '—'}/${p.servers ?? '—'}대(미측정 서버가 있는 랙은 판정하지 않습니다)\n${since}\n어느 서버의 증가인지는 단정하지 않습니다 — 베어메탈 사용률 › 전력 · 온도에서 그 랙을 눌러 서버 목록을 확인하세요.`, 1_500) };
  }
  if (f.rule === 'inlet') {
    return { key, severity: 'warning', title: capStr(`${head} 흡기 ${p.inletC ?? '—'} °C(기준 ${p.inletWarnC ?? '—'} °C 이상)`, 200),
      detail: capStr(`센서 표본 ${hm(p.tempAt)} · ${since}\n기준은 설정값입니다(모델별 Dell 권장 범위를 인용하지 않았습니다). 랙 급기 · 팬 · 이웃 서버 확인은 사람이 합니다${p.rack ? `(랙 ${p.rack}${p.u != null ? ` · ${p.u}U` : ''})` : ''}.`, 1_500) };
  }
  if (f.rule === 'powerCap') {
    return { key, severity: 'warning', title: capStr(`${head} PowerCap 걸림 — 지금 ${p.w ?? '—'} W / 상한 ${p.capW ?? '—'} W(${p.capPct ?? '—'}% · 기준 ${p.capHitPct ?? '—'}%)`, 200),
      detail: capStr(`전력 표본 ${hm(p.at)} · ${since}\n상한에 닿으면 iDRAC 이 CPU 클럭을 낮출 수 있습니다(성능 억제 가능 — 단정 아님 · 서버 상세의 교차 판정 ⑤ 와 함께 보세요).`, 1_500) };
  }
  if (f.rule === 'surge') {
    const sg = p.surge || {};
    return { key, severity: 'warning', title: capStr(`${head} 24시간 전력 피크 +${sg.ratioPct ?? '—'}% — ${sg.peakW ?? '—'} W(앞 7일 피크 ${sg.baseW ?? '—'} W 대비 · 기준 +${p.surgePct ?? '—'}%)`, 200),
      detail: capStr(`피크 = 시간 롤업의 시간 최대(순간 표본 최대) · 최근 24시간 ${sg.hours24 ?? '—'}시간 · 그 앞 7일 ${sg.baseHours ?? '—'}시간 표본 · ${since}\n증가 원인(작업 · 펌웨어 · 팬 곡선 등)은 단정하지 않습니다.`, 1_500) };
  }
  return null;
}

/**
 * 판정 항목(이 노드 원천 — localOnly) — 서버 칸(inlet · surge · powerCap) + 랙 칸(rack · 상한을 정한 랙만).
 * @param {{ targets:Array, rules:object, now?:number, deps?:object }} p  targets = 폴러 주기 대상(이 노드 수집분) · rules = perfRules(power 기준 · 랙 배치 · 켠 규칙)
 * @returns {Promise<Array>}
 */
export async function powerAlertItems({ targets = [], rules = {}, now = Date.now(), deps = {} } = {}) {
  const on = POWER_RULE_IDS.filter((id) => rules?.rules?.[id]?.on);
  if (!on.length || !targets.length) return [];
  const cfg = { ...RULE_SET_DEFAULTS.power, ...Object.fromEntries(Object.entries(rules.power || {}).filter(([k, v]) => k !== 'racks' && k !== 'racksText' && v != null)) };
  const sources = deps.sources ? await deps.sources() : await (await import('./powerSources.js')).powerSources({ now, localOnly: true });
  const list = targets.filter((x) => x && x.key).map((x) => ({ key: x.key, name: x.name, vcenterId: x.vcenterId || '', serviceTag: x.serviceTag || '', idrac: x.idrac ? { regId: x.idrac.regId } : null, paths: x.paths || [], node: '', via: 'local', _t: x }));
  const servers = await gatherPower({ targets: list, deps: sources, now, withWeek: on.includes('surge'), withMonth: false });
  const tgOf = new Map(list.map((x) => [`${x.vcenterId}|${x.key}`, x._t]));
  const racks = Array.isArray(rules.power?.racks) ? rules.power.racks : [];
  const ag = aggregatePower(servers, { racks, cfg });
  const items = [];
  if (on.some((id) => POWER_RULE_KIND[id] === 'server')) {
    for (const s of ag.all) {
      const sg = on.includes('surge') ? surgeOf(s.h24, s.base7, cfg.surgePct) : null;
      items.push({ key: s.key, name: s.name || s.key, vcenterId: s.vcenterId, target: tgOf.get(`${s.vcenterId}|${s.key}`) || { key: s.key, vcenterId: s.vcenterId },
        power: { kind: 'server', w: s.w, at: s.at ?? null, unmeasured: s.unmeasured || null, capW: s.capW ?? null, capPct: s.capPct ?? null, capHit: s.capHit ?? null, capState: s.capState ?? null, capHitPct: cfg.capHitPct,
          inletC: s.inletC ?? null, tempState: s.tempState || 'none', tempAt: s.tempAt ?? null, inletWarnC: cfg.inletWarnC, surge: sg, surgePct: cfg.surgePct, rack: s.rack || '', u: s.u ?? null } });
    }
  }
  if (on.includes('rack')) {
    const byRack = new Map();
    for (const s of ag.all) { if (!s.rack) continue; const k = `${s.vcenterId}|${s.rack}`; if (!byRack.has(k)) byRack.set(k, []); byRack.get(k).push(s); }
    for (const r of ag.racks) {
      if (r.unmapped || r.capKw == null) continue;   // 미매핑 · 상한 미설정 랙은 판정 대상이 아니다
      const mem = byRack.get(`${r.vcenterId}|${r.rack}`) || [];
      // 관측 표지 — 측정 서버 표본 시각의 합 + 대수(한 대라도 새 표본이면 바뀐다)
      const obs = `r${mem.length}:${mem.reduce((a, s) => a + (n(s.at) ?? 0), 0)}`;
      items.push({ key: rackKeyOf(r.vcenterId, r.rack), name: `랙 ${r.rack}`, vcenterId: r.vcenterId, members: mem.map((s) => tgOf.get(`${s.vcenterId}|${s.key}`) || { key: s.key, vcenterId: s.vcenterId }),
        power: { kind: 'rack', rack: r.rack, capKw: r.capKw, nowKw: r.nowKw, marginPct: r.marginPct, low: r.low, marginPartial: r.marginPartial, measured: r.measured, servers: r.servers, rackLowPct: cfg.rackLowPct, obs } });
    }
  }
  return items;
}
