/**
 * VM 사용률 분포 · 패널 선택(facet) — v2.746(가상머신 상세 C안). 순수 모듈(입출력 없음).
 *
 * 화면(웹 `views/vmDistText.js` · `VmDistPanels.jsx`)은 CPU·메모리 사용률을 **5% 칸 20개**로 그리고, 막대(칸)·전원·GPU·Guest OS 를
 * 눌러 표를 거른다. 칸 번호는 **서버가 준다** — 웹은 칸을 다시 판정하지 않는다(판정 한 벌).
 *
 * 규칙(계약 — 바꾸지 말 것):
 *  - 칸 판정 `usageBinOf(pct)`: `numOrNull(pct)` 가 null 이거나 음수면 null(= '사용률 미수집'). 100 이상은 마지막 칸(19),
 *    그 밖은 `Math.floor(p / 5)`. 경계 75 는 칸 15, 90 은 칸 18 — 화면의 75%↑·90%↑ 판정과 같다. 100 **초과** 값의 개수는
 *    `over100` 으로 따로 센다(마지막 칸에 넣되 숨기지 않는다).
 *  - 분포·칸 선택 대상은 **전원 POWERED_ON 인 VM 만**이다. 정지·일시정지·전원 모름은 칸에 넣지 않고 `off` 로 센다
 *    (꺼진 VM 의 사용률은 낡은 값이라 '부하' 로 읽으면 거짓이다).
 *  - 각 패널의 개수는 **다른 패널에서 고른 조건만** 반영한다 — 자기 패널 선택으로 자기 개수를 줄이면 다른 칸을 고를 수
 *    없게 된다(스토리지 화면 칩 규칙 `deviceFacets.js` 와 같다). `total` 만 모든 선택을 통과한 수다(= /vms 의 total).
 *  - GPU 선택은 기존 쿼리 `gpu`·`gpuType` 이다(KPI GPU 카드와 같은 상태). 판정은 예전 `matchVms` 와 글자 그대로 같다.
 *  - Guest OS 는 원문을 앞뒤 공백만 지우고 대소문자 그대로 비교한다. 비었거나 없으면 키 `~`. 키는 최대 200자 —
 *    분포에 나온 이름을 그대로 다시 보낼 수 있게 키 자체를 200자로 자른다(쿼리 상한과 같은 값).
 *    ⚠ 자른 뒤 다시 다듬는다(v2.746 검토 RV-S1·C-02): 끝이 공백이면 화면(`cleanOs`)·서버(`parseVmFacets`)가 trim 해 보내
 *    199자가 되고, 서로게이트 쌍 가운데서 자르면 반쪽이 URLSearchParams 에서 U+FFFD 로 바뀐다 — 둘 다 그 줄을 누르면 0대다.
 *    그래서 쌍 가운데서 자르지 않고 끝 공백을 지우며, 짝 없는 서로게이트는 U+FFFD 로 바꾼다(`toWellFormed` — 전송에서 바뀌는
 *    값과 같게). 그 결과 키는 언제나 `trim(키)` 와 같고 잘 짜인 문자열이라 다듬어 실어 보낸 값과 글자 그대로 같다.
 *  - ⚠ 운영 앱은 라우터 앞의 `util/queryNormalize.js` 가 배열(같은 키 여러 번)을 마지막 값으로, 객체(`키[x]=`)를 버림으로 바꾼다.
 *    그 뒤의 `req.query` 만 보면 '배열·객체 → 400' 이 운영에서 성립하지 않는다(v2.746 검토 SP-01) — 라우트가 원문 쿼리를
 *    `parseVmFacets(q, { rawQuery })` 로 넘기고 여기서 모양을 본다(`facetShapeIssues`).
 *
 * 성능: `vmDistribution` 은 한 번 훑기(O(N × facet)) · 정렬은 서로 다른 OS 수만큼. 운영 규모(VM 6,000)에서 수 ms.
 */
import { numOrNull } from '../util/numOrNull.js';

export const VM_DIST_BIN_PCT = 5;
export const VM_DIST_BINS = 20;
export const OS_UNKNOWN_KEY = '~';
export const OS_NAME_MAX = 200;
/** 새 패널 선택 쿼리 키 — 형식 판정·오류 field 순서도 이 순서다. */
export const VM_FACET_KEYS = ['cpuBin', 'memBin', 'power', 'osName'];
export const POWER_KINDS = ['on', 'off', 'suspended', 'other'];
const LAST_BIN = VM_DIST_BINS - 1;

/** 사용률(%) → 칸 번호 0~19, 못 읽음·음수는 null. */
export function usageBinOf(pct) {
  const p = numOrNull(pct);
  if (p == null || p < 0) return null;
  if (p >= 100) return LAST_BIN;
  return Math.floor(p / VM_DIST_BIN_PCT);
}

/** 전원 종류 — 'on'·'off'·'suspended'·'other'(값 없음·모르는 값 포함). */
export function powerKindOf(v) {
  const s = v?.powerState;
  if (s === 'POWERED_ON') return 'on';
  if (s === 'POWERED_OFF') return 'off';
  if (s === 'SUSPENDED') return 'suspended';
  return 'other';
}

/**
 * 다듬은 OS 이름 → 키. `s` 는 이미 앞뒤 공백을 지운 비어 있지 않은 문자열이다.
 * 짝 없는 서로게이트를 U+FFFD 로 바꾼 뒤(그 뒤에 남는 상위 서로게이트는 쌍의 앞쪽뿐이다) 200자에서 자르고, 쌍 가운데서
 * 잘렸으면 한 글자 더 떼고, 끝 공백을 지운다. 앞쪽은 이미 trim 했으므로 빈 값이 되지 않는다.
 */
function osKeyText(s) {
  let k = s.isWellFormed() ? s : s.toWellFormed();
  if (k.length > OS_NAME_MAX) {
    k = k.slice(0, OS_NAME_MAX);
    const last = k.charCodeAt(k.length - 1);
    if (last >= 0xD800 && last <= 0xDBFF) k = k.slice(0, -1);
    k = k.trimEnd();
  }
  return k;
}

/** Guest OS 키 — 앞뒤 공백 제거 · 대소문자 그대로 · 200자(자른 끝도 다듬는다) · 비면 '~'. */
export function osKeyOf(v) {
  const raw = v?.guestOS;
  const s = raw == null ? '' : String(raw).trim();
  if (s === '') return OS_UNKNOWN_KEY;
  return osKeyText(s);
}

/**
 * 원문 쿼리 문자열 → 모양이 틀린 패널 선택 키 집합. 같은 키가 두 번 이상(qs 가 배열로 만든다)이거나 `키[` 로 시작하는
 * 이름(qs 가 객체·배열로 만든다 — `키[x]=`·`키[]=`·`키[=`)이면 그 키를 넣는다. 원문이 없거나 읽지 못하면 빈 집합
 * (그때는 `req.query` 의 typeof 판정만 남는다 — 정규화기가 없는 경로).
 */
export function facetShapeIssues(rawQuery) {
  const bad = new Set();
  if (typeof rawQuery !== 'string' || rawQuery === '') return bad;
  let sp;
  try { sp = new URLSearchParams(rawQuery); } catch { return bad; }
  const seen = new Set();
  for (const k of sp.keys()) {
    for (const f of VM_FACET_KEYS) {
      if (k === f) { if (seen.has(f)) bad.add(f); else seen.add(f); }
      else if (k.startsWith(`${f}[`)) bad.add(f);
    }
  }
  return bad;
}

const BIN_RE = /^(\d{1,2})-(\d{1,2})$/;
/** 칸 선택 문자열 → { na:true } | { a, b } | null(선택 없음) | false(형식 오류). */
function parseBinSpec(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') return false;
  if (v === 'na') return { na: true };
  const m = BIN_RE.exec(v);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a > b || b > LAST_BIN) return false;
  return { a, b };
}
const binEcho = (s) => (s == null ? null : s.na ? 'na' : `${s.a}-${s.b}`);

/**
 * 쿼리 → 패널 선택. 반환 { ok:true, sel, facets } | { ok:false, field }.
 *  - `facets` 는 새 키 중 고른 것만 담은 정규화 메아리(없으면 빈 객체) — /vms 응답의 `facets`.
 *  - `sel.gpu`·`sel.gpuTypeRaw` 는 예전 matchVms 판정 그대로(gpu 는 '1'|'true', gpuType 은 값이 있으면 같아야 함).
 *  - 형식 오류: 범위 밖·a>b·모르는 값·문자열 아님(배열·객체)·OS 201자 이상. 빈 값은 '선택 없음'.
 *  - `opts.rawQuery`(원문 쿼리 문자열)를 주면 그 모양도 본다(`facetShapeIssues`) — 운영에서는 정규화기가 배열·객체를 이미
 *    문자열·없음으로 바꿨으므로 위의 typeof 판정은 정규화기가 없는 경로(직접 호출·테스트)에서만 걸린다. 키 순서
 *    (cpuBin → memBin → power → osName)대로 모양 오류와 값 오류를 함께 본다.
 *  - OS 이름은 trim 한 뒤 짝 없는 서로게이트를 U+FFFD 로 바꾼다(키 `osKeyOf` 와 같은 규칙 — 직접 호출에서도 왕복되게).
 */
export function parseVmFacets(q, opts = {}) {
  const src = q || {};
  const shape = facetShapeIssues(opts?.rawQuery);
  if (shape.has('cpuBin')) return { ok: false, field: 'cpuBin' };
  const cpu = parseBinSpec(src.cpuBin);
  if (cpu === false) return { ok: false, field: 'cpuBin' };
  if (shape.has('memBin')) return { ok: false, field: 'memBin' };
  const mem = parseBinSpec(src.memBin);
  if (mem === false) return { ok: false, field: 'memBin' };
  if (shape.has('power')) return { ok: false, field: 'power' };
  let power = null;
  const pw = src.power;
  if (pw !== undefined && pw !== null && pw !== '') {
    if (typeof pw !== 'string' || !POWER_KINDS.includes(pw)) return { ok: false, field: 'power' };
    power = pw;
  }
  if (shape.has('osName')) return { ok: false, field: 'osName' };
  let osName = null;
  const on = src.osName;
  if (on !== undefined && on !== null && on !== '') {
    if (typeof on !== 'string') return { ok: false, field: 'osName' };
    const t = on.trim();
    if (t.length > OS_NAME_MAX) return { ok: false, field: 'osName' };
    if (t !== '') osName = t.isWellFormed() ? t : t.toWellFormed();
  }
  const gpu = src.gpu === '1' || src.gpu === 'true';
  const gpuTypeRaw = src.gpuType;
  const sel = { cpuBin: cpu, memBin: mem, power, osName, gpu, gpuTypeRaw };
  const facets = {};
  if (cpu) facets.cpuBin = binEcho(cpu);
  if (mem) facets.memBin = binEcho(mem);
  if (power) facets.power = power;
  if (osName) facets.osName = osName;
  return { ok: true, sel, facets };
}

/** cpu·mem·power·os 중 하나라도 골랐는가(gpu 는 예전 키라 여기서 세지 않는다). */
export function hasPanelFacet(sel) {
  return !!(sel && (sel.cpuBin || sel.memBin || sel.power || sel.osName));
}

/** GPU 선택 — 예전 matchVms 의 두 줄과 같은 판정. */
export function passGpu(v, sel) {
  if (sel?.gpu && !v.gpu) return false;
  if (sel?.gpuTypeRaw && (v.gpu?.type || null) !== sel.gpuTypeRaw) return false;
  return true;
}

/** 칸 선택 판정 — on 은 전원 POWERED_ON, bin 은 그 VM 의 칸(null = 미수집). */
function passBin(spec, on, bin) {
  if (!spec) return true;
  if (!on) return false;
  if (spec.na) return bin == null;
  return bin != null && bin >= spec.a && bin <= spec.b;
}

/**
 * cpu·mem·power·os 선택으로 거른다(gpu 는 KPI 집합에서 이미 걸렀다). 선택이 없으면 **같은 배열**을 그대로 돌려준다
 * (예전 응답과 바이트 단위로 같게 — 새 배열을 만들 이유가 없다). 순서는 입력 순서 그대로.
 */
export function filterVmsByFacets(vms, sel) {
  if (!hasPanelFacet(sel)) return vms;
  const out = [];
  for (const v of vms) {
    if (!v || typeof v !== 'object') continue;
    const on = v.powerState === 'POWERED_ON';
    if (sel.cpuBin && !passBin(sel.cpuBin, on, on ? usageBinOf(v.cpuUsagePct) : null)) continue;
    if (sel.memBin && !passBin(sel.memBin, on, on ? usageBinOf(v.memUsagePct) : null)) continue;
    if (sel.power && powerKindOf(v) !== sel.power) continue;
    if (sel.osName && osKeyOf(v) !== sel.osName) continue;
    out.push(v);
  }
  return out;
}

const COLL = new Intl.Collator(undefined, { numeric: true });
function usageBox() { return { bins: new Array(VM_DIST_BINS).fill(0), na: 0, off: 0, over100: 0 }; }
function addUsage(box, on, bin, pct) {
  if (!on) { box.off += 1; return; }
  if (bin == null) { box.na += 1; return; }
  box.bins[bin] += 1;
  if (bin === LAST_BIN) { const p = numOrNull(pct); if (p != null && p > 100) box.over100 += 1; }
}

/**
 * 분포 — `base` 는 범위·페이지 필터를 적용했고 GPU 선택은 **적용하지 않은** 집합(GPU 도 패널 하나로 다룬다).
 * 반환 모양은 계약 그대로(binPct·bins·total·cpu·mem·power·gpu·os·selected).
 */
export function vmDistribution(base, sel, { osTop = 5 } = {}) {
  const s = sel || {};
  const cpu = usageBox();
  const mem = usageBox();
  const power = { on: 0, off: 0, suspended: 0, other: 0 };
  const gpu = { total: 0, vgpu: 0, passthrough: 0, mixed: 0, none: 0 };
  const osMap = new Map();
  let total = 0;
  for (const v of base || []) {
    if (!v || typeof v !== 'object') continue;
    const pk = powerKindOf(v);
    const on = pk === 'on';
    const cb = on ? usageBinOf(v.cpuUsagePct) : null;
    const mb = on ? usageBinOf(v.memUsagePct) : null;
    const osk = osKeyOf(v);
    const okC = passBin(s.cpuBin, on, cb);
    const okM = passBin(s.memBin, on, mb);
    const okP = !s.power || pk === s.power;
    const okO = !s.osName || osk === s.osName;
    const okG = passGpu(v, s);
    if (okC && okM && okP && okO && okG) total += 1;
    if (okM && okP && okO && okG) addUsage(cpu, on, cb, v.cpuUsagePct);
    if (okC && okP && okO && okG) addUsage(mem, on, mb, v.memUsagePct);
    if (okC && okM && okO && okG) power[pk] += 1;
    if (okC && okM && okP && okO) {
      if (v.gpu) {
        gpu.total += 1;
        const t = v.gpu?.type || null;
        if (t === 'vgpu') gpu.vgpu += 1;
        else if (t === 'passthrough') gpu.passthrough += 1;
        else if (t === 'mixed') gpu.mixed += 1;
      } else gpu.none += 1;
    }
    if (okC && okM && okP && okG) osMap.set(osk, (osMap.get(osk) || 0) + 1);
  }
  const entries = [...osMap].sort((x, y) => (y[1] - x[1]) || COLL.compare(x[0], y[0]));
  const n = Math.max(0, Math.floor(Number(osTop) || 0));
  const top = entries.slice(0, n).map(([name, cnt]) => ({ name, n: cnt, selected: !!s.osName && name === s.osName }));
  if (s.osName && !top.some((t) => t.name === s.osName)) {
    // 상위 밖(또는 0건)이어도 고른 항목은 남긴다 — 사라지면 화면에서 해제할 수 없다.
    top.push({ name: s.osName, n: osMap.get(s.osName) || 0, selected: true });
  }
  const inTop = new Set(top.map((t) => t.name));
  let other = 0;
  for (const [name, cnt] of entries) if (!inTop.has(name)) other += cnt;
  return {
    binPct: VM_DIST_BIN_PCT,
    bins: VM_DIST_BINS,
    total,
    cpu,
    mem,
    power,
    gpu,
    os: { top, other, distinct: osMap.size, unknownKey: OS_UNKNOWN_KEY },
    selected: {
      cpuBin: binEcho(s.cpuBin),
      memBin: binEcho(s.memBin),
      power: s.power || null,
      osName: s.osName || null,
      gpu: !!s.gpu,
      gpuType: typeof s.gpuTypeRaw === 'string' && s.gpuTypeRaw !== '' ? s.gpuTypeRaw : null,
    },
  };
}
