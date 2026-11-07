/**
 * storpath/parse.js — ESXi 경로별 스토리지 카운터(v2.935 C-① — 설계 docs/design/san-cvp-traffic/README.md §9). 순수 파서 · 요약 · 엣지 정제.
 *
 * 왜 있나: SAN 스위치 포트 카운터는 HBA 포트의 **합계**만 안다(목적지를 모른다). 한 HBA 포트가 스토리지 둘 이상과 조닝돼 있으면
 *   그 합계를 스토리지별로 나눌 근거가 필요한데, Flow Vision(스위치 쪽 플로우)은 라이선스가 있어야 한다. ESXi 는 경로(path)마다
 *   읽기·쓰기 KBps 를 따로 센다 — 경로 이름에 타깃 포트 WWN 이 들어 있으므로 **호스트 쪽에서 스토리지별 비율을 실측**할 수 있다(라이선스 불필요).
 *
 * 원천: vCenter **실시간(20초) 통계**의 최근 창(기본 15표본 = 5분)을 호스트 묶음으로(QueryPerf, instance '*'). 매시 한 번(기본).
 *   · 실시간 통계는 통계 레벨과 무관하게 ESXi 가 갖고 있다(contention/parse.js 와 같은 전제). 롤업(일·주)은 storagePath 가 레벨 3 이라 쓰지 않는다.
 *   · ⚠ 1시간 창 전체(180표본)를 매시 읽지 않는 이유: 경로 계열은 LUN × 경로 수(호스트당 수백)만큼 나와 응답이 호스트당 MB 단위가 된다
 *     (28개 vCenter · 고RTT — 루트 CLAUDE.md 수집 규약). 그래서 **비율**을 표본으로 재고, 바이트 합은 스위치 포트 카운터(정확한 합)를 쓴다.
 *   · ⚠ 경로 인스턴스 이름 형식은 **실장비로 확인하지 못했다**. 두 형식을 받는다 — 못 읽은 이름은 unparsed 로 세고(0 으로 만들지 않는다),
 *     타깃을 하나도 못 찾으면 귀속 엔진은 IPF · 타깃 포트 비율로 떨어진다.
 *
 * 모양(host.spath — 없으면 아직 읽지 않았다 = '미수집'):
 *   { at, sampleSec, samples, instances, unparsed, truncated,
 *     targets:[{ adapter, init, wwn, readKB, writeKB, rKBps, wKBps, latR, latW, paths, partial }] }
 *   - readKB·writeKB = 창 안 값이 있는 표본의 KBps × 20초 합(그 창의 전송량) · rKBps·wKBps = 경로별 평균 KBps 의 합(그 창의 평균 속도).
 *   - latR·latW = 경로별 평균 지연(ms)의 평균 — 값이 없으면 null. partial = 표본이 빠진 경로가 있다.
 */

export const STORPATH_COUNTERS = Object.freeze({
  read: 'storagePath.read.average',
  write: 'storagePath.write.average',
  latR: 'storagePath.totalReadLatency.average',
  latW: 'storagePath.totalWriteLatency.average',
});
export const SPATH_SAMPLE_SEC = 20;
export const SPATH_TARGETS_MAX = 64;
export const SPATH_PATHS_MAX = 4096;   // 호스트 하나에서 보는 경로 인스턴스 상한(방어)

const colon = (h) => h.replace(/(..)(?=.)/g, '$1:');
const WWN_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){7}$/;
const FC_RE = /^fc\.([0-9a-f]{16}):([0-9a-f]{16})-fc\.([0-9a-f]{16}):([0-9a-f]{16})-/;
const RT_RE = /^(vmhba\d{1,4}):(c\d{1,4}):(t\d{1,5}):l\d{1,6}$/;

/**
 * 경로 인스턴스 이름 → 키. 두 형식(추정 — 실장비 확인 전):
 *   ① 'fc.<노드>:<포트>-fc.<노드>:<포트>-<장치>' (전송 식별자 경로 이름) → { init: 초기자 포트 WWN, target: 타깃 포트 WWN }
 *   ② 'vmhbaN:C0:Tn:Lm' (런타임 이름) → { adapter, tid: 'vmhbaN:c0:tn' } — 타깃 WWN 은 멀티패스의 rt 표(hcfg.mp.targets[].rt)로 찾는다
 *   그 밖은 null. 길이를 먼저 자르고 앵커 있는 정규식만 쓴다(장비 출력 — 정규식 규약).
 */
export function pathKeyOf(inst) {
  const s = String(inst ?? '').slice(0, 256).toLowerCase();
  let m = FC_RE.exec(s);
  if (m) return { init: colon(m[2]), target: colon(m[4]) };
  m = RT_RE.exec(s);
  if (m) return { adapter: m[1], tid: `${m[1]}:${m[2]}:${m[3]}` };
  return null;
}

/** hcfg.mp.targets → rt 표(Map 'vmhbaN:c0:tn' → 타깃 WWN). rt 가 없는 구버전 hcfg 는 빈 표. */
export function rtMapOf(host) {
  const out = new Map();
  for (const t of Array.isArray(host?.hcfg?.mp?.targets) ? host.hcfg.mp.targets : []) {
    if (!t || typeof t.wwn !== 'string' || !WWN_RE.test(t.wwn)) continue;
    for (const r of Array.isArray(t.rt) ? t.rt : []) if (typeof r === 'string' && /^vmhba\d{1,4}:c\d{1,4}:t\d{1,5}$/.test(r)) out.set(r, t.wwn);
  }
  return out;
}
/** host.hbas → 초기자 포트 WWN(콜론 소문자) → 어댑터 이름. */
export function hbaByWwnOf(host) {
  const out = new Map();
  for (const h of Array.isArray(host?.hbas) ? host.hbas : []) {
    const w = String(h?.wwn || '').toLowerCase();
    if (WWN_RE.test(w) && h?.name) out.set(w, String(h.name).slice(0, 32));
  }
  return out;
}

const r1 = (x) => Math.round(x * 10) / 10;
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

/**
 * 호스트 하나의 경로 계열 → 타깃별 요약.
 * @param {Map<string, Map<string, number[]>>} byCounter counterId → instance → 값(결측은 이미 빠짐 — contention parsePerfInstances)
 * @param {{read?:string,write?:string,latR?:string,latW?:string}} ids 카운터 키 → id
 * @param {{ rtMap?:Map, hbaByWwn?:Map, at?:number, samples?:number }} opt samples = 요청한 표본 수(창 길이)
 */
export function summarizeHostPaths(byCounter, ids, { rtMap = new Map(), hbaByWwn = new Map(), at = Date.now(), samples = 15 } = {}) {
  const series = (k) => (ids?.[k] != null ? byCounter?.get?.(String(ids[k])) || null : null);
  const rd = series('read'); const wr = series('write'); const lr = series('latR'); const lw = series('latW');
  const insts = new Set([...(rd ? rd.keys() : []), ...(wr ? wr.keys() : [])]);
  const byT = new Map();
  let unparsed = 0; let seen = 0; let truncated = false;
  // v2.938: 못 푼 인스턴스 이름 원문 표본(최대 UNPARSED_SAMPLES · 120자) — 이름 형식이 실장비 미확인이라 처음 붙은 현장에서 형식을 확인할 근거.
  const unparsedSamples = [];
  const keepSample = (inst, why) => { if (unparsedSamples.length < UNPARSED_SAMPLES) unparsedSamples.push({ name: sampleText(inst), why }); };
  for (const inst of insts) {
    if (seen >= SPATH_PATHS_MAX) { truncated = true; break; }
    seen += 1;
    const k = pathKeyOf(inst);
    if (!k) { unparsed += 1; keepSample(inst, 'format'); continue; }
    const target = k.target || (k.tid ? rtMap.get(k.tid) || null : null);
    const adapter = k.adapter || (k.init ? hbaByWwn.get(k.init) || null : null);
    if (!target) { unparsed += 1; keepSample(inst, 'no-target'); continue; }
    const key = `${adapter || k.init || '?'}|${target}`;
    let T = byT.get(key);
    if (!T) {
      if (byT.size >= SPATH_TARGETS_MAX) { truncated = true; continue; }
      T = { adapter, init: k.init || null, wwn: target, readKB: null, writeKB: null, rKBps: null, wKBps: null, latRs: [], latWs: [], paths: 0, partial: false };
      byT.set(key, T);
    }
    T.paths += 1;
    const addRate = (vals, sumK, rateK) => {
      if (!Array.isArray(vals) || !vals.length) return;
      const s = vals.reduce((a, v) => a + v, 0);
      T[sumK] = (T[sumK] ?? 0) + s * SPATH_SAMPLE_SEC;
      T[rateK] = (T[rateK] ?? 0) + s / vals.length;
      if (vals.length < samples) T.partial = true;
    };
    const rv = rd?.get(inst); const wv = wr?.get(inst);
    addRate(rv, 'readKB', 'rKBps'); addRate(wv, 'writeKB', 'wKBps');
    if ((rd && !rv?.length) || (wr && !wv?.length)) T.partial = true;
    const a1 = avg(lr?.get(inst) || []); const a2 = avg(lw?.get(inst) || []);
    if (a1 != null) T.latRs.push(a1);
    if (a2 != null) T.latWs.push(a2);
  }
  const targets = [...byT.values()].map((t) => ({
    adapter: t.adapter, init: t.init, wwn: t.wwn,
    readKB: t.readKB == null ? null : Math.round(t.readKB), writeKB: t.writeKB == null ? null : Math.round(t.writeKB),
    rKBps: t.rKBps == null ? null : r1(t.rKBps), wKBps: t.wKBps == null ? null : r1(t.wKBps),
    latR: t.latRs.length ? r1(avg(t.latRs)) : null, latW: t.latWs.length ? r1(avg(t.latWs)) : null,
    paths: t.paths, partial: t.partial,
  })).sort((a, b) => String(a.adapter || '').localeCompare(String(b.adapter || ''), 'en', { numeric: true }) || a.wwn.localeCompare(b.wwn));
  return { at, sampleSec: SPATH_SAMPLE_SEC, samples, instances: insts.size, unparsed, truncated, targets, ...(unparsedSamples.length ? { unparsedSamples } : {}) };
}

const intOr = (x, lo, hi) => { const n = Number(x); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.trunc(n))) : null; };
const numOr = (x) => { const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN; return Number.isFinite(n) && n >= 0 ? n : null; };

/** 못 푼 인스턴스 이름 표본 수 · 글자 정리(제어문자 제거 · 120자). 엣지 정제도 같은 함수를 쓴다. */
export const UNPARSED_SAMPLES = 5;
const sampleText = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 120); // eslint-disable-line no-control-regex
const SAMPLE_WHY = new Set(['format', 'no-target']);

/** 엣지가 보낸 host.spath 정제(아는 필드만 · 상한 · 수치는 수로 · 엣지 시각은 수신 시각으로 자르고 원본은 edgeAt). 모양이 아니면 null. */
export function sanitizeHostSpath(v, now = Date.now()) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const at0 = numOr(v.at);
  const at = at0 == null ? null : at0 > now ? Math.trunc(now) : Math.trunc(at0);
  const targets = Array.isArray(v.targets) ? v.targets.slice(0, SPATH_TARGETS_MAX)
    .filter((t) => t && typeof t === 'object' && !Array.isArray(t) && typeof t.wwn === 'string' && WWN_RE.test(t.wwn.toLowerCase()))
    .map((t) => ({
      adapter: typeof t.adapter === 'string' && /^[\w.:-]{1,32}$/.test(t.adapter) ? t.adapter : null,
      init: typeof t.init === 'string' && WWN_RE.test(t.init.toLowerCase()) ? t.init.toLowerCase() : null,
      wwn: t.wwn.toLowerCase(),
      readKB: numOr(t.readKB), writeKB: numOr(t.writeKB), rKBps: numOr(t.rKBps), wKBps: numOr(t.wKBps), latR: numOr(t.latR), latW: numOr(t.latW),
      paths: intOr(t.paths, 0, SPATH_PATHS_MAX) ?? 0, partial: t.partial === true,
    })) : [];
  return {
    at, ...(at0 != null && at0 > now ? { edgeAt: Math.trunc(at0) } : {}),
    sampleSec: intOr(v.sampleSec, 1, 3600) ?? SPATH_SAMPLE_SEC, samples: intOr(v.samples, 0, 1000) ?? 0,
    instances: intOr(v.instances, 0, 100_000) ?? 0, unparsed: intOr(v.unparsed, 0, 100_000) ?? 0, truncated: v.truncated === true, targets,
    // v2.938: 못 푼 이름 표본 — 아는 모양만 · 상한 · 글자 정리(엣지가 보낸 것은 정제한다)
    ...(Array.isArray(v.unparsedSamples) ? { unparsedSamples: v.unparsedSamples.slice(0, UNPARSED_SAMPLES).filter((x) => x && typeof x === 'object' && typeof x.name === 'string')
      .map((x) => ({ name: sampleText(x.name), why: SAMPLE_WHY.has(x.why) ? x.why : 'format' })) } : {}),
  };
}
