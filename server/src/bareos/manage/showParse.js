/**
 * bareos/manage/showParse.js — 법인별 Bareos 설정 조회(v2.845) 응답 정규화(순수 · 멱등 — 엣지 회신을 중앙이 같은 함수로 다시 거른다).
 *
 * 모양: `.api json` 의 `show <종류>` 는 `{ <복수형>: { <이름>: { name, …소문자 키 } } }`(v2.839 실측 — show schedules·jobdefs·filesets).
 *   `show storages`·`show consoles`·`show profiles` 의 칸 모양은 **실측 전(추정)** — 문자열·배열 둘 다 받는다(jobdefs 의 storage 는 배열이었다).
 * ★ 비밀번호 칸(password)은 **고르지 않는다** — 아는 칸만 새 객체에 옮긴다(원문 객체를 그대로 돌려주지 않는다). 시험이 password 가 결과에 없음을 고정한다.
 * 규칙: 외부 입력 — 문자열 자르기 · 제어문자 지우기 · 수는 numOrNull(못 읽으면 null) · 행 수 상한.
 */
import { numOrNull } from '../../util/numOrNull.js';
import { str, flag, normPools, normShowSchedules } from '../policyParse.js';

export const CAP = Object.freeze({ storages: 200, consoles: 500, profiles: 200, acl: 60 });
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const first = (v) => (Array.isArray(v) ? v[0] : v);
const list = (v, n = 128, cap = CAP.acl) => (Array.isArray(v) ? v : (v == null || v === '' ? [] : [v])).slice(0, cap).map((x) => str(x, n)).filter(Boolean);
/** 키를 소문자·공백 없이(어떤 판은 'Media Type' · 'mediatype' 둘 다 있을 수 있다 — 추정). */
function lowerKeys(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) out[String(k).toLowerCase().replace(/[\s_]+/g, '')] = v;
  return out;
}
function entries(v, key, cap) {
  const m = isObj(v) ? (isObj(v[key]) ? v[key] : v) : {};
  return Object.entries(m).filter(([, x]) => isObj(x)).slice(0, cap);
}
const tri = (v) => { const f = flag(v); if (f !== null) return f; const s = str(first(v), 8).toLowerCase(); return s === 'yes' || s === 'true' ? true : s === 'no' || s === 'false' ? false : null; };

/** `show storages` → [{ name, address, port, device[], mediaType[], maxConcurrentJobs, description }] (비밀번호 없음). */
export function normShowStorages(v) {
  return entries(v, 'storages', CAP.storages).map(([k, raw]) => {
    const x = lowerKeys(raw);
    return {
      name: str(x.name || k, 64), address: str(first(x.address), 253), port: numOrNull(first(x.port ?? x.sdport)),
      device: list(x.device, 64, 20), mediaType: list(x.mediatype, 64, 20),
      maxConcurrentJobs: numOrNull(first(x.maximumconcurrentjobs)), description: str(first(x.description), 200),
    };
  });
}

/** `show consoles` → [{ name, profile[], tlsEnable, pam, description }] (비밀번호 없음). */
export function normShowConsoles(v) {
  return entries(v, 'consoles', CAP.consoles).map(([k, raw]) => {
    const x = lowerKeys(raw);
    return {
      name: str(x.name || k, 64), profile: list(x.profile, 64, 10), tlsEnable: tri(x.tlsenable),
      pam: tri(x.usepamauthentication), description: str(first(x.description), 200),
      // 콘솔 자체에 ACL 이 걸린 경우(bareos-mon 처럼 Profile 없이) — 명령 ACL 몇 개만 보인다
      commandAcl: list(x.commandacl, 40, 20),
    };
  });
}

/** `show profiles` → [{ name, description, commandAcl[] }]. */
export function normShowProfiles(v) {
  return entries(v, 'profiles', CAP.profiles).map(([k, raw]) => {
    const x = lowerKeys(raw);
    return { name: str(x.name || k, 64), description: str(first(x.description), 200), commandAcl: list(x.commandacl, 40, CAP.acl) };
  });
}

/** 결과 묶음 정규화(엣지 회신 재정제 — edgeResult.VALUE.config). */
export function normConfigResult(v) {
  const r = isObj(v) ? v : {};
  const res = isObj(r.results) ? r.results : {};
  const out = {};
  for (const k of ['storages', 'consoles', 'profiles', 'pools', 'schedules']) {
    const x = res[k];
    if (!isObj(x)) continue;
    if (x.ok === true) out[k] = { ok: true, value: CONFIG_NORMALIZE[k](x.value) };
    else out[k] = { ok: false, code: str(x.code, 40) || 'error', message: str(x.message, 300) };
  }
  return { results: out, version: str(r.version, 60) };
}

// pools·schedules 는 정책 수집과 같은 정규화(policyParse)를 쓴다 — 판정 코어 하나
export const CONFIG_NORMALIZE = Object.freeze({
  storages: (v) => (Array.isArray(v) ? v.map((x) => normShowStorages({ storages: { [x?.name || '']: x } })[0]).filter(Boolean) : normShowStorages(v)),
  consoles: (v) => (Array.isArray(v) ? v.map((x) => normShowConsoles({ consoles: { [x?.name || '']: x } })[0]).filter(Boolean) : normShowConsoles(v)),
  profiles: (v) => (Array.isArray(v) ? v.map((x) => normShowProfiles({ profiles: { [x?.name || '']: x } })[0]).filter(Boolean) : normShowProfiles(v)),
  pools: (v) => normPools(v),
  schedules: (v) => normShowSchedules(v),
});
/** 조회 명령(읽기 전용). pools 는 llist(보존 · 상한 칸) — 거부되면 list 로 한 번 더(정책 수집과 같다). */
export const CONFIG_CMDS = Object.freeze([
  { key: 'storages', cmd: 'show storages' },
  { key: 'consoles', cmd: 'show consoles' },
  { key: 'profiles', cmd: 'show profiles' },
  { key: 'pools', cmd: 'llist pools', fallback: 'list pools' },
  { key: 'schedules', cmd: 'show schedules' },
]);

/** 디스크 · 표지 읽기 결과(apply.parseScan 모양) 재정제 — 엣지 회신(edgeResult 'setup.scan')과 중앙 직접이 같은 함수. */
export function normScanResult(v) {
  const r = isObj(v) ? v : {};
  const arr = (x, cap) => (Array.isArray(x) ? x.slice(0, cap).filter(isObj) : []);
  const path = (x) => { const s = str(x, 300); return s.startsWith('/') ? s : ''; };
  const size = (x) => { const n = numOrNull(x); return n !== null && n >= 0 ? n : null; };
  return {
    complete: r.complete === true,
    devices: arr(r.devices, 200).map((d) => ({ file: str(d.file, 128), portal: d.portal === true, name: str(d.name, 64), archiveDevice: path(d.archiveDevice), count: size(d.count) })),
    files: arr(r.files, 2000).filter((f) => ['console', 'storage', 'pool', 'schedule'].includes(f.type)).map((f) => ({ type: f.type, name: str(f.name, 64), portal: f.portal === true })),
    disks: arr(r.disks, 200).map((d) => (d.missing === true ? { path: path(d.path), missing: true }
      : { path: path(d.path), files: size(d.files), usedBytes: size(d.usedBytes), availBytes: size(d.availBytes), sizeBytes: size(d.sizeBytes), mount: path(d.mount) })).filter((d) => d.path),
  };
}
