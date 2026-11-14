/**
 * diskbad/diskvals.js — 디스크가 스스로 적어 둔 **누적 값**(재할당 · 보류 · 복구 불가)을 읽는다(과거 기록 읽기 1단계 — README §22).
 *
 * 왜: iDRAC 가 Redfish 로 주는 Lifecycle 로그는 활성 로그뿐이라(README §21) 몇 주 전의 배드 섹터 기록이 없다. 디스크의 누적 값은
 *   로그가 넘어가도 남는다 — '지금 꽂힌 디스크에 과거의 흔적이 있는가' 를 **날짜 없이** 말해 준다. 교체되어 나간 디스크는 볼 수 없다.
 *
 * 읽는 곳(둘 다 GET 만 — 장비 설정을 바꾸지 않는다):
 *  ① 텔레메트리 보고서 `TelemetryService/MetricReports/StorageDiskSMARTData` — 한 번의 GET 으로 디스크 전부.
 *     Dell 백서 'iDRAC9 Telemetry Streaming — Storage report'(검색 요약 — 원문 미확인)에 ReallocatedBlockCount ·
 *     CurrentPendingSectorCount · UncorrectableLBACount 가 있다. iDRAC9 4.00+ · Datacenter 라이선스 · 보고서가 켜져 있어야 한다(같은 백서).
 *     없으면 404 → 'absent'(모름 — 0 이 아니다).
 *  ② 장비가 디스크 자원에 `Metrics` 링크를 알려 준 디스크만 그 링크(Redfish DriveMetrics — 필드 이름은 DMTF 스키마 기억 기준 · 실장비 대조 전).
 *     링크는 iDRAC 인벤토리가 같은 응답에서 받아 둔다(`idrac/redfish.js` — 추가 HTTP 0회). 링크가 없는 장비에는 묻지 않는다.
 *
 * 정직 규칙:
 *  · 메트릭 id 는 **정해 둔 이름만** 읽는다(비슷한 이름을 넓게 잡으면 뜻이 다른 값이 섞인다). 장비가 준 이름은 그대로 싣는다(`seen`) —
 *    이름이 달라 못 읽은 장비는 화면의 장비 진단 · 이 목록으로 드러난다.
 *  · 못 읽은 값은 null 이다(`numOrNull`). 음수 · 정수가 아닌 건수는 모르는 값으로 본다.
 *  · 누적 값이라 **언제 생겼는지 말하지 않는다**. 포탈이 읽기 시작한 뒤의 증가만 날짜를 안다(db.js changedAt).
 */
import { redfishGetCapped } from '../idrac/redfish.js';
import { numOrNull } from '../util/numOrNull.js';
import { deviceIdOf } from '../bmusage/parse/idracTelemetry.js';

export const REPORT_PATH = '/redfish/v1/TelemetryService/MetricReports/StorageDiskSMARTData';
export const DRIVES_MAX = 64;
const SEEN_MAX = 40;
const VALUES_MAX = 20_000;      // 보고서 한 개에서 보는 메트릭 수 상한(장비가 이상한 값을 줘도 메모리를 지킨다)
const t = (v, n) => String(v ?? '').slice(0, n);

/** 메트릭 id(소문자) → 필드. **정확히 이 이름일 때만**(README §22.1 — 이름은 문서 요약 · 스키마 기억 기준). */
export const METRIC_FIELD = Object.freeze({
  reallocatedblockcount: 'realloc', reallocatedsectorcount: 'realloc', reallocatedsectorscount: 'realloc',
  currentpendingsectorcount: 'pending', pendingsectorcount: 'pending',
  uncorrectablelbacount: 'uncorrectable', uncorrectableerrorcount: 'uncorrectable', uncorrectablesectorcount: 'uncorrectable',
  poweronhours: 'powerOnHours',
});
export const VAL_FIELDS = Object.freeze(['realloc', 'pending', 'uncorrectable', 'powerOnHours']);

/** 0 이상의 수(건수 · 시간). 못 읽으면 null. */
function count(v) {
  const n = numOrNull(v);
  return n != null && n >= 0 ? n : null;
}

/** 값이 하나라도 있는가. */
export function hasAnyVal(v) {
  return !!v && VAL_FIELDS.some((f) => Number.isFinite(v[f]));
}

/**
 * 텔레메트리 보고서 → 디스크별 값(순수).
 * 같은 디스크 · 같은 값이 여러 번 오면 **가장 큰 값**(누적 값은 늘기만 한다 — 시각 파싱에 기대지 않는다).
 * @returns {{at:number|null, drives:Map<string,object>, seen:string[]}}
 */
export function parseSmartReport(rep) {
  const drives = new Map();
  const seen = new Set();
  let at = null;
  const list = Array.isArray(rep?.MetricValues) ? rep.MetricValues.slice(0, VALUES_MAX) : [];
  for (const mv of list) {
    if (!mv || typeof mv !== 'object') continue;
    const mid = t(mv.MetricId, 64).trim();
    if (mid && seen.size < SEEN_MAX) seen.add(mid);
    const key = mid.toLowerCase();
    // 프로토타입 이름('constructor' 등)이 필드로 읽히지 않게 자기 키만 본다.
    const field = Object.hasOwn(METRIC_FIELD, key) ? METRIC_FIELD[key] : '';
    if (!field) continue;
    const v = count(mv.MetricValue);
    if (v == null) continue;
    const id = t(deviceIdOf(mv), 200).trim();
    if (!id) continue;
    if (!drives.has(id) && drives.size >= DRIVES_MAX) continue;
    const cur = drives.get(id) || { id };
    cur[field] = cur[field] == null ? v : Math.max(cur[field], v);
    drives.set(id, cur);
    const ts = Date.parse(t(mv.Timestamp, 40));
    if (Number.isFinite(ts) && (at == null || ts > at)) at = ts;
  }
  if (at == null) { const ts = Date.parse(t(rep?.Timestamp, 40)); if (Number.isFinite(ts)) at = ts; }
  return { at, drives, seen: [...seen] };
}

/**
 * Redfish DriveMetrics → 값(순수). 이름은 DMTF 스키마 기억 기준(실장비 대조 전):
 *  BadBlockCount → 재할당(불량 블록) · UncorrectableIORead/WriteErrorCount → 복구 불가(둘을 더한다 — 하나만 있으면 그것만) · PowerOnHours.
 *  보류(pending)에 해당하는 이름은 없다 — null 로 둔다.
 */
export function parseDriveMetrics(j) {
  if (!j || typeof j !== 'object') return null;
  const ur = count(j.UncorrectableIOReadErrorCount);
  const uw = count(j.UncorrectableIOWriteErrorCount);
  return {
    realloc: count(j.BadBlockCount), pending: null,
    uncorrectable: ur == null && uw == null ? null : (ur || 0) + (uw || 0),
    powerOnHours: count(j.PowerOnHours),
  };
}

const SAFE_PATH_RE = /^\/redfish\/v1\/[A-Za-z0-9._:\/%-]{1,280}\/Metrics$/;
/**
 * 인벤토리가 받아 둔 DriveMetrics 링크 — 이 꼴이고 그 디스크 Id 를 담을 때만 쓴다(장비가 준 경로를 그대로 붙이지 않는다 — probe.js safePath 와 같은 선).
 */
export function metricsPathOf(d) {
  const p = typeof d?.metricsPath === 'string' ? d.metricsPath : '';
  const id = String(d?.id || '');
  if (!p || !id || p.length > 300 || p.includes('..') || p.includes('//') || !SAFE_PATH_RE.test(p)) return '';
  return p.includes(id) || p.includes(encodeURIComponent(id)) ? p : '';
}

const errKind = (e) => (e?.status === 404 ? 'absent' : (e?.status === 403 ? 'forbidden' : 'error'));
const isAuth = (e) => e?.status === 401 || e?.authFailed === true;

/**
 * 서버 한 대의 디스크 값. 401 은 던진다(호출자가 인증 정지로 — 다시 로그인하지 않는다).
 * @param {object} entry  등록부 항목(자격증명 — 결과에 싣지 않는다)
 * @param {{signal?:AbortSignal|null, drives?:Array<{id:string, metricsPath?:string}>|null, getJson?:Function, now?:Function}} o
 * @returns {Promise<{at:number, status:string, telemetry:string, metrics:string, reportAt:number|null, seen:string[], drives:Array}>}
 *   status: ok(한 개라도 읽음) · empty(보고서는 있으나 디스크 값 없음) · absent(보고서 · 링크 없음) · forbidden · error
 */
export async function readDiskVals(entry, { signal = null, drives = null, getJson = redfishGetCapped, now = Date.now } = {}) {
  const G = (p) => getJson(entry, p, { signal, maxBytes: 4 * 1048576 });
  const out = { at: now(), status: 'absent', telemetry: '', metrics: '', reportAt: null, seen: [], drives: [] };
  const by = new Map();
  try {
    const p = parseSmartReport(await G(REPORT_PATH));
    out.reportAt = p.at; out.seen = p.seen;
    for (const d of p.drives.values()) by.set(d.id, { ...d, src: 'telemetry' });
    out.telemetry = p.drives.size ? 'ok' : 'empty';
  } catch (e) {
    if (isAuth(e)) throw e;
    out.telemetry = errKind(e);
  }
  // ② 텔레메트리에서 못 읽은 디스크 가운데 장비가 링크를 알려 준 것만.
  const links = (Array.isArray(drives) ? drives : []).map((d) => ({ id: String(d?.id || '').slice(0, 200), path: metricsPathOf(d) }))
    .filter((d) => d.id && d.path && !by.has(d.id)).slice(0, DRIVES_MAX);
  if (links.length) {
    let ok = 0; let fail = '';
    for (const d of links) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const v = parseDriveMetrics(await G(d.path));
        if (hasAnyVal(v)) { by.set(d.id, { id: d.id, ...v, src: 'metrics' }); ok += 1; }
      } catch (e) {
        if (isAuth(e)) throw e;
        fail = fail || errKind(e);
      }
    }
    out.metrics = ok ? 'ok' : (fail || 'empty');
  }
  out.drives = [...by.values()].filter(hasAnyVal).slice(0, DRIVES_MAX);
  if (out.drives.length) out.status = 'ok';
  else if (out.telemetry === 'forbidden' || out.metrics === 'forbidden') out.status = 'forbidden';
  else if (out.telemetry === 'error' || out.metrics === 'error') out.status = 'error';
  else if (out.telemetry === 'empty' || out.metrics === 'empty') out.status = 'empty';
  return out;
}
