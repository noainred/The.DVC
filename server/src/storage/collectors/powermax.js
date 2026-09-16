/**
 * storage/collectors/powermax.js — Dell EMC VMAX·PowerMax 공용 수집기(v2.310, 사용자 요구).
 *
 * 두 타입 모두 **Unisphere for PowerMax(구 Unisphere for VMAX)** REST API 로 조회한다:
 *   https://<unisphere>:8443/univmax/restapi/...  (Basic 인증)
 * 등록 host = Unisphere 서버 주소(어레이 자체가 아님 — VMAX/PowerMax 는 직접 REST 가 없다).
 * Unisphere 하나가 **여러 어레이(symmetrix)** 를 관리할 수 있어 로컬 어레이별 용량을 pools 로
 * 싣고 capacity 는 합산한다(XMS 다중 클러스터와 동일 패턴 — 공통 스키마 재사용).
 *
 * ── 버전 경로: **장비가 스스로 알려준다 — 추측하지 말 것**(v2.532, 실장비 확인) ──────────
 * 사용자 신고("power max 스토리지 10.x 버전에서는 9.x 버전과 좀 달라진것 같네")로 드러난 결함:
 * 10.x 는 **무버전 `/univmax/restapi/system/*` 별칭을 없앴다**. 현장 실측(10.2.0.9, HG-PMAX):
 *     config: 오류: HTTP 404 — RESTEASY003210: Could not find resource for full path:
 *             https://10.112.31.25:8443/univmax/restapi/system/symmetrix
 *     alerts: 오류: HTTP 404 — …/univmax/restapi/system/alert_summary
 * 같은 코드가 9.2.4.9(GM1)에서는 전부 OK 였다 — 즉 **버전차**다.
 *
 * ⚠ 그런데 **버전 목록을 코드에 박을 필요가 없다.** 무버전 `/univmax/restapi/version` 은 10.x
 * 에서도 살아 있고, 자기가 무엇을 지원하는지 **직접 알려준다**(사용자 curl 실측):
 *     {"version":"V10.2.0.9","api_version":"102","supported_api_versions":["102","101","100"]}
 * 그래서 `apiVersionsFrom()` 이 이 배열을 그대로 쓴다. 정적 목록(`FALLBACK_VERS`)은 그 응답을
 * 못 읽었을 때의 **마지막 수단**일 뿐이다 — 순서를 뒤집거나 정적 목록을 앞에 두지 말 것.
 * **무버전 경로도 후보에서 빼지 말 것** — 9.x 에서 실제로 동작이 확인된 형태다.
 *
 * ⚠ 정직 표기:
 *  - **어떤 경로로 읽었는지 `extra.usedPaths` 에 남긴다**(v2.522 `usedCmds` 규약) — 화면이
 *    '이 장비는 102 로 읽었다' 를 말할 수 있어야 다음 버전차를 추측 없이 진단한다.
 *  - 용량 단위: system_capacity 의 *_tb 값을 **10진 TB(1e12)** 로 가정해 바이트 환산한다 —
 *    Unisphere 화면 표기와 2^40 환산 간 차이가 있으면 실장비에서 보정할 항목(주석 유지).
 *  - 관리 계정 목록은 Unisphere 사용자 API 가 버전 의존이라 이번엔 수집하지 않는다(sections.accounts='skip').
 *  - 401 즉시 중단(계정 잠금 예방) · 조회(GET) 전용.
 */
import { emptySnapshot } from '../types.js';
import { makeGetter, tryAny } from './restCommon.js';

const TB = 1e12; // Unisphere *_tb → 바이트(10진 가정 — 파일 머리말 정직 표기 참조)

/**
 * `/univmax/restapi/version` 응답을 못 읽었을 때만 쓰는 **마지막 수단** 목록.
 * ⚠ 이 목록을 '정답' 으로 삼지 말 것 — 장비가 준 `supported_api_versions` 가 언제나 우선이다.
 *   10.2 실측에서 지원 목록은 `["102","101","100"]` 이었고 **9x 는 없었다**.
 */
const FALLBACK_VERS = ['102', '101', '100', '92', '91', '90'];
const MAX_VERS = 8;   // 후보가 길면 실패 시 404 왕복만 늘어난다

/**
 * 버전 응답 → REST 경로에 쓸 버전 세그먼트 후보(순수 — 테스트가 고정한다).
 *
 * 우선순위: `supported_api_versions`(장비가 준 목록) → `api_version`(지금 쓰는 것) →
 * `version` 문자열에서 유도(`V10.2.0.9` → `102`, `V9.2.4.9` → `92`) → 정적 폴백.
 * 앞의 것이 있으면 **그것을 먼저** 쓰고 정적 폴백은 뒤에 덧붙인다(중복 제거).
 *
 * @param {object|null} v `/univmax/restapi/version` 응답
 * @returns {{vers:string[], source:'supported'|'api_version'|'derived'|'fallback'}}
 */
export function apiVersionsFrom(v) {
  const out = [];
  const push = (x) => {
    const t = String(x ?? '').trim();
    if (/^\d{2,3}$/.test(t) && !out.includes(t)) out.push(t);
  };
  let source = 'fallback';
  const sup = Array.isArray(v?.supported_api_versions) ? v.supported_api_versions : null;
  if (sup?.length) { source = 'supported'; sup.forEach(push); }
  if (!out.length && v?.api_version != null) { source = 'api_version'; push(v.api_version); }
  if (!out.length) {
    // `V10.2.0.9` → major 10, minor 2 → `102`. 9.x 는 `92` — 실제로 9.2 에서 쓰이던 값이다.
    const m = /^V?(\d+)\.(\d+)/.exec(String(v?.version ?? ''));
    if (m) { source = 'derived'; push(`${m[1]}${m[2]}`); }
  }
  FALLBACK_VERS.forEach(push);   // 못 읽었을 때 대비 — 앞의 것이 있으면 뒤에 붙을 뿐이다
  return { vers: out.slice(0, MAX_VERS), source };
}

/**
 * 한 리소스의 경로 후보. 버전 경로를 앞에, **무버전을 맨 뒤에** 둔다.
 * ⚠ 무버전을 빼지 말 것 — 9.x 에서 실제로 동작하는 형태다(10.x 에서만 404).
 */
/**
 * 후보를 앞에서부터 시도하고 **성공한 경로까지** 돌려준다.
 * `restCommon.tryAny` 는 데이터만 주는데, 버전차 진단에는 '무엇으로 읽었나' 가 데이터만큼
 * 중요하다(v2.522 규약) — 그래서 여기서 따로 쓴다. 401 은 즉시 던진다(계정 잠금 예방).
 */
async function tryPaths(get, paths) {
  let err;
  for (const path of paths) {
    try { return { data: await get(path), path }; }
    catch (e) { err = e; if (/401/.test(e.message)) throw e; }
  }
  throw err;
}

export function pathsFor(vers, suffix) {
  const tail = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return [...vers.map((v) => `/univmax/restapi/${v}${tail}`), `/univmax/restapi${tail}`];
}

/**
 * 원시 응답 → 정규화(순수 — storageMon.test.js 픽스처 고정).
 * raw: { version: {version}|null, arrays: [{symmetrixId, model, ucode, local}...],
 *        caps: { [symmetrixId]: {usable_total_tb, usable_used_tb} }, alertCount: n|null }
 */
export function normalizePowermax(device, raw) {
  const snap = emptySnapshot(device);
  if (raw.version?.version) snap.version = String(raw.version.version).replace(/^V/, '');
  const arrays = Array.isArray(raw.arrays) ? raw.arrays.filter(Boolean) : [];
  if (arrays.length) {
    const a0 = arrays[0];
    snap.name = arrays.length === 1 ? (a0.symmetrixId || device.name) : `${a0.symmetrixId || device.name} 외 ${arrays.length - 1}`;
    snap.serial = a0.symmetrixId || '';
    snap.extra.model = a0.model || '';
    snap.extra.ucode = a0.ucode || a0.microcode || '';
    snap.extra.arrays = arrays.slice(0, 8).map((a) => ({ id: a.symmetrixId, model: a.model }));
    snap.sections.config = 'ok';
    // 어레이별 용량(TB→바이트) — 합산이 capacity, 개별은 pools(caps 에 없는 어레이는 0 이 아니라 제외).
    let total = 0, used = 0;
    const pools = [];
    for (const a of arrays.slice(0, 32)) {
      const c = raw.caps?.[a.symmetrixId];
      if (!c) continue;
      const t = (Number(c.usable_total_tb) || 0) * TB;
      const u = (Number(c.usable_used_tb) || 0) * TB;
      total += t; used += u;
      pools.push({ name: a.symmetrixId, totalBytes: t, usedBytes: u, pct: t ? Math.round((u / t) * 1000) / 10 : null });
    }
    snap.pools = pools;
    if (total > 0) {
      snap.capacity = { totalBytes: total, usedBytes: used, pct: Math.round((used / total) * 1000) / 10 };
      snap.sections.capacity = 'ok';
    }
  }
  if (raw.alertCount != null) { snap.alerts.unresolved = Number(raw.alertCount) || 0; snap.sections.alerts = 'ok'; }
  // nodes/accounts 는 이번 범위 밖(디렉터·보드 상세는 실장비 확인 후 후속) — 'skip' 정직 표기.
  snap.extra.collectMethod = 'api';
  // 버전차 진단의 근거 — 화면이 '이 장비는 102 로 읽었다' 를 말할 수 있어야 한다.
  if (raw.apiVersions) snap.extra.apiVersions = raw.apiVersions;
  if (raw.usedPaths && Object.keys(raw.usedPaths).length) snap.extra.usedPaths = raw.usedPaths;
  snap.ok = snap.sections.config === 'ok' || snap.sections.capacity === 'ok';
  if (!snap.ok && !snap.error) snap.error = '수집 실패(섹션 오류 참조)';
  return snap;
}

export async function collect(device, { signal = null } = {}) {
  const get = makeGetter(device, { port: Number(process.env.STORAGE_UNISPHERE_PORT) || 8443, signal });
  const raw = { caps: {} };
  const snap = emptySnapshot(device); // 섹션 오류 임시 기록용
  try {
    // ① Unisphere 버전(무버전 경로 — 인증 확인 겸용, 401 이면 즉시 전체 중단).
    try { raw.version = await get('/univmax/restapi/version'); }
    catch (e) { if (/401/.test(e.message)) throw e; /* 버전 실패는 치명 아님 */ }
    // 버전 경로 후보는 **장비가 준 목록**에서 나온다(추측 금지 — 파일 머리말 참조).
    const { vers, source } = apiVersionsFrom(raw.version);
    raw.apiVersions = { vers, source };
    raw.usedPaths = {};
    // ② 어레이 목록 → 어레이별 상세(model/ucode). 원격(SRDF 상대) 어레이는 로컬만 남긴다 —
    //    원격 어레이는 상대 Unisphere 소관이라 여기서 용량 질의하면 오류/중복 집계가 된다.
    //    목록 실패는 섹션 오류로 기록하고 계속(v2.310 검증 반영 — 독립 섹션인 alerts 까지
    //    막지 않게. 401 만 전체 중단).
    let ids = [];
    try {
      const r = await tryPaths(get, pathsFor(vers, '/system/symmetrix'));
      raw.usedPaths.arrays = r.path;
      ids = r.data?.symmetrixId || [];
    } catch (e) { snap.sections.config = `오류: ${e.message}`; if (/401/.test(e.message)) throw e; }
    raw.arrays = [];
    for (const id of ids.slice(0, 8)) {
      try {
        const r = await tryPaths(get, pathsFor(vers, `/system/symmetrix/${encodeURIComponent(id)}`));
        raw.usedPaths.array = r.path;
        const d = r.data;
        const a = Array.isArray(d?.symmetrix) ? d.symmetrix[0] : d?.symmetrix || d;
        if (a && a.local !== false) raw.arrays.push({ symmetrixId: a.symmetrixId || id, model: a.model, ucode: a.ucode, local: a.local });
      } catch (e) { if (/401/.test(e.message)) throw e; snap.sections.config = `일부 어레이 오류: ${e.message}`; }
    }
    // ③ 어레이별 용량(sloprovisioning — 버전 경로 폴백). 실패 어레이는 caps 에서 빠져
    //    pools 에도 안 실린다(0 오표시 방지 — powerstore appliance 와 동일 원칙).
    for (const a of raw.arrays) {
      try {
        const r = await tryPaths(get, pathsFor(vers, `/sloprovisioning/symmetrix/${encodeURIComponent(a.symmetrixId)}`));
        raw.usedPaths.capacity = r.path;
        const d = r.data;
        const s = Array.isArray(d?.symmetrix) ? d.symmetrix[0] : d?.symmetrix || d;
        const c = s?.system_capacity;
        if (c && (c.usable_total_tb != null)) raw.caps[a.symmetrixId] = { usable_total_tb: c.usable_total_tb, usable_used_tb: c.usable_used_tb };
        else snap.sections.capacity = '오류: system_capacity 필드 부재(Unisphere 버전 확인)';
      } catch (e) { if (/401/.test(e.message)) throw e; snap.sections.capacity = `오류: ${e.message}`; }
    }
    // ④ 미해결 알람 수 — /system/alert 는 알람 ID 배열을 반환(버전에 따라 alert_summary 폴백).
    try {
      // 9.x 는 무버전 `/system/alert`(+`alert_summary`)만 있었고 10.x 는 버전 경로만 있다 —
      // 둘을 모두 후보에 두고 **먹힌 경로를 기록**한다.
      const r = await tryPaths(get, [...pathsFor(vers, '/system/alert'), ...pathsFor(vers, '/system/alert_summary')]);
      raw.usedPaths.alerts = r.path;
      const d = r.data;
      if (Array.isArray(d?.alertId)) raw.alertCount = d.alertId.length;
      else if (d?.serverAlertSummary || d?.symmAlertSummary) {
        // alert_summary 는 구조가 버전마다 달라 숫자 필드 합산으로 방어적으로 센다(정직: 근사치).
        const nums = JSON.stringify(d).match(/"(?:alert_count|critical|warning)":(\d+)/g) || [];
        raw.alertCount = nums.reduce((s, m) => s + Number(m.split(':')[1]), 0);
      }
    } catch (e) { if (/401/.test(e.message)) throw e; snap.sections.alerts = `오류: ${e.message}`; }
  } catch (e) {
    const out = normalizePowermax(device, raw);
    out.error = e.message;
    for (const [k, v] of Object.entries(snap.sections)) if (String(v).includes('오류')) out.sections[k] = v;
    return out;
  }
  const out = normalizePowermax(device, raw);
  for (const [k, v] of Object.entries(snap.sections)) if (String(v).includes('오류')) out.sections[k] = v;
  return out;
}
