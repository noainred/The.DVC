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
 * 같은 코드가 9.2.4.9(GM1)에서는 전부 OK 였다 — 즉 **버전차**다.
 *
 * ⚠ 그런데 **버전 목록을 코드에 박을 필요가 없다.** 무버전 `/univmax/restapi/version` 은 10.x
 * 에서도 살아 있고, 자기가 무엇을 지원하는지 **직접 알려준다**(사용자 curl 실측):
 *     {"version":"V10.2.0.9","api_version":"102","supported_api_versions":["102","101","100"]}
 * 그래서 `apiVersionsFrom()` 이 이 배열을 그대로 쓴다. 정적 목록(`FALLBACK_VERS`)은 그 응답을
 * 못 읽었을 때의 **마지막 수단**일 뿐이다 — 순서를 뒤집거나 정적 목록을 앞에 두지 말 것.
 * **무버전 경로도 후보에서 빼지 말 것** — 9.x 에서 실제로 동작이 확인된 형태다.
 *
 * ── ★★ 용량: '할당' 이 아니라 '실제로 디스크에 기록한 양' 을 쓴다(v2.534) ────────────────
 * 사용자 신고: "vmax, powermax 스토리지의 할당량 말고 실제로 디스크에 기록한 사용량 보여줘".
 * 증상은 **VMAX 11대가 전부 정확히 100%**(전체 용량 == 사용 용량)였다. 12대 중 유일한
 * PowerMax 10.2 만 31.1% 로 정상이었다.
 *
 * 원인은 **읽는 필드의 우선순위**였다. v2.533 은 `physicalCapacity` 를 ①순위로 봤는데,
 * V3 플랫폼(VMAX) 응답에는 그 필드가 **있고 `used_capacity_gb == total_capacity_gb`** 다.
 * 재현으로 확인했다 — Comcast/libstorage 의 실캡처(VMAX200K, ucode 5977.1125.1125)를 이 함수에
 * 그대로 넣으면 1325680.37/1325680.37 = **정확히 100.0%** 가 나오고, 같은 응답의
 * `system_capacity` 로는 440.74/1070.61 = **41.2%** 다. Dell 자신의 PyU4V 픽스처
 * (PowerMax_2000, ucode 5978.669.669)도 76290.38/76290.38 으로 같은 패턴이다 — 독립 표본 2건.
 *
 * ★ **Dell 공식 스펙 원문**(Dell 이 PyU4V 저장소에 커밋해 둔 `tools/openapi.json`, PowerMax 10.3.
 *   developer.dell.com 은 이 환경에서 차단이라 이 경로로 확보했다):
 *     usable_used_tb      "Total Capacity in TBs used by Host, eNas and System
 *                          **after Data reduction is applied**"   ← 실제로 기록된 양
 *     usable_total_tb     "Total system usable capacity in TBs"
 *     subscribed_total_tb "Host subscribed capacity plus eNas subscribed capacity in TBs"  ← 구독
 *     subscribed_allocated_tb "Host allocated plus eNas allocated capacity in TBs"        ← 할당
 *     disk_group_total_capacity_gb "The total disk group (raw) capacity including RAID overhead"
 *   세 가지가 **각각 다른 필드**이므로 화면도 셋을 섞지 않는다.
 *
 * ⚠ **`physicalCapacity` 를 '원시 용량' 이라고 단정하지 말 것.** Dell 자신의 OpenAPI 스펙에도
 *   이 스키마에는 설명이 없다(Java DTO 클래스명 `com.emc.em.restapi.common.dto.PhysicalCapacity`
 *   와 필드명 반복뿐). raw 를 뜻하는 필드는 `disk_group_total_capacity_gb` 로 **따로 있다**.
 *   확정할 수 있는 것은 "확인한 V3 표본 2건에서 used == total 이었다" 까지다. 그래서 이 필드는
 *   **마지막 수단**이고, `used === total` 이면 `suspect` 로 표시해 화면이 경고한다.
 *
 * ⚠ 정직 표기:
 *  - **어떤 경로로 읽었는지 `extra.usedPaths` 에 남긴다**(v2.522 `usedCmds` 규약).
 *  - 용량 단위: `*_tb` 를 **10진 TB(1e12)** 로 가정한다. OpenStack Cinder 의 Dell PowerMax
 *    드라이버는 같은 필드에 `* units.Ki`(=1024)를 곱해 **TiB(2^40)** 로 다룬다 — 약 10% 차이다.
 *    Dell 스펙에 단위 명시가 없어 **확정하지 못했다**. 실장비 Unisphere 화면값과 대조해 보정할 것.
 *  - 관리 계정 목록은 Unisphere 사용자 API 가 버전 의존이라 수집하지 않는다(sections.accounts='skip').
 *  - 401 즉시 중단(계정 잠금 예방) · 조회(GET) 전용.
 */
import { emptySnapshot } from '../types.js';
import { makeGetter } from './restCommon.js';
import { numOrNull } from '../../util/numOrNull.js';

const TB = 1e12; // Unisphere *_tb → 바이트(10진 가정 — 파일 머리말 정직 표기 참조)
const GB = 1e9;  // Unisphere *_gb → 바이트(TB 와 같은 10진 가정)

/**
 * `/univmax/restapi/version` 응답을 못 읽었을 때만 쓰는 **마지막 수단** 목록.
 * ⚠ 이 목록을 '정답' 으로 삼지 말 것 — 장비가 준 `supported_api_versions` 가 언제나 우선이다.
 *   10.2 실측에서 지원 목록은 `["102","101","100"]` 이었고 **9x 는 없었다**.
 */
const FALLBACK_VERS = ['102', '101', '100', '92', '91', '90'];
const MAX_VERS = 8;   // 후보가 길면 실패 시 404 왕복만 늘어난다
const MAX_SRP = 8;    // 어레이당 SRP 조회 상한(보통 1개 — 폭주 방지)
// v2.604(감사 COL-2604-03): 상세 조회 상한과 **로컬** 어레이 상한을 나눈다. 원격(SRDF 상대) 판정(local===false)은
//   상세 응답에만 있으므로, 목록을 먼저 8개로 자르면 원격이 앞에 있는 목록에서 로컬 어레이가 조용히 빠졌다.
const MAX_ARRAY_DETAIL = 32;   // 상세 GET 상한(원격 포함) — 초과분은 로컬 여부를 모른다(arraysUnchecked)
const MAX_LOCAL_ARRAYS = 8;    // 수집할 로컬 어레이 상한 — 초과분은 합계에서 빠진다(arraysOverCap)

/**
 * 버전 응답 → REST 경로에 쓸 버전 세그먼트 후보(순수 — 테스트가 고정한다).
 *
 * 우선순위: `supported_api_versions`(장비가 준 목록) → `api_version`(지금 쓰는 것) →
 * `version` 문자열에서 유도(`V10.2.0.9` → `102`, `V9.2.4.9` → `92`) → 정적 폴백.
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

const num = numOrNull;   // v2.561: 판정은 util/numOrNull.js 하나가 갖는다(Number(null)===0 함정)

/**
 * 어레이 응답 → 용량(순수 · v2.534).
 *
 * 우선순위는 **Dell 이 의미를 문서화한 필드가 먼저**다(파일 머리말의 스펙 원문 참조):
 *   ① `system_capacity.usable_used_tb / usable_total_tb` — "데이터 감축 적용 후" 실제 소비량
 *   ② `physicalCapacity.*` — **Dell 스펙에 설명이 없는 필드**. 마지막 수단이고,
 *      `used === total` 이면 `suspect:true` 로 표시한다(V3 표본 2건이 그랬다).
 * 둘 다 없으면 **null** 을 돌려준다 — 0 을 지어내지 않는다.
 *
 * `detail` 에는 구독·할당·스냅샷을 **각각 따로** 담는다. 셋은 다른 뜻이므로 합치지 말 것.
 *
 * @returns {{totalBytes:number, usedBytes:number, basis:string, documented:boolean,
 *            suspect:boolean, detail:object, provisioned:object|null}|null}
 */
export function powermaxCapacity(sym) {
  if (!sym || typeof sym !== 'object') return null;
  const sc = sym.system_capacity && typeof sym.system_capacity === 'object' ? sym.system_capacity : null;
  const rawGb = num(sym.disk_group_total_capacity_gb);
  const detail = {
    // 구독(호스트에 약속한 씬 크기) — 사용량이 아니다.
    subscribedTb: num(sc?.subscribed_total_tb),
    // 할당(씬 풀에서 트랙이 할당된 양). ⚠ 이것이 '감축 전 논리 기록량' 이라는 확증은 없다 —
    //   Dell 스펙은 "Host allocated plus eNas allocated capacity" 라고만 적는다.
    allocatedTb: num(sc?.subscribed_allocated_tb),
    snapshotTb: num(sc?.snapshot_total_tb),
    snapshotModifiedTb: num(sc?.snapshot_modified_tb),
    // 구독/usable 비율 — Dell 이 "Can be over 100% due to Virtual Provisioning" 이라고 명시한다.
    subscribedPct: num(sc?.subscribed_usable_capacity_percent),
    // raw(RAID 오버헤드 포함) — Dell 이 이 뜻이라고 명시한 유일한 필드.
    rawTb: rawGb != null ? Math.round((rawGb / 1000) * 100) / 100 : null,
  };
  const prov = sym.provisioned_capacity && typeof sym.provisioned_capacity === 'object' ? {
    usedTb: num(sym.provisioned_capacity.used_tb),
    totalTb: num(sym.provisioned_capacity.total_tb),
  } : null;

  // ① system_capacity — Dell 이 "after Data reduction is applied" 라고 명시한 유일한 필드.
  const st = num(sc?.usable_total_tb);
  const su = num(sc?.usable_used_tb);
  if (st && st > 0 && su != null) {
    return {
      totalBytes: st * TB, usedBytes: su * TB,
      basis: 'system_capacity.usable', documented: true, suspect: false,
      detail: { ...detail, usableTotalTb: st, usableUsedTb: su }, provisioned: prov,
    };
  }
  // ② physicalCapacity — 의미가 문서화돼 있지 않다. 마지막 수단.
  const pc = sym.physicalCapacity || sym.physical_capacity;
  const pt = num(pc?.total_capacity_gb);
  const pu = num(pc?.used_capacity_gb);
  if (pt && pt > 0) {
    return {
      totalBytes: pt * GB, usedBytes: pu == null ? null : pu * GB, // v2.593(DATA-01): 못 읽은 사용량은 0 이 아니다
      basis: 'physicalCapacity', documented: false,
      // V3 표본 2건이 used==total 이었다 — 그때는 '사용량' 이 아닐 가능성이 크다.
      suspect: pu != null && pu === pt,
      detail, provisioned: prov,
    };
  }
  // ③ 못 읽었다 — **0 을 지어내지 않는다**(호출부가 섹션 오류로 남긴다).
  return null;
}

/**
 * SRP(Storage Resource Pool) 응답 → 풀 단위 용량(순수 · v2.534).
 *
 * 왜 필요한가: 10.x/V4 는 `system_capacity` 가 없을 수 있고(사용자 10.2 응답이 그랬다),
 * 그때 **실제 기록량을 주는 유일한 경로가 SRP 의 `physical_capacity`** 다. 데이터 감축
 * 절감량도 여기에만 있다.
 *
 * 형태가 세대별로 다르다 — 확인한 순서대로 시도한다:
 *   V4: `<블록>.effective.physical_capacity.{used_tb,total_tb}`  ← 감축 후 실제 물리
 *   V3: `<블록>.{usable_used_tb,usable_total_tb}`                 ← 같은 정의(SRP 범위)
 * 블록은 `srp_capacity`(통합) → `fba_srp_capacity` → `ckd_srp_capacity` 순으로 본다.
 * ⚠ **한 SRP 에서 블록을 하나만 고른다** — 통합(`srp_capacity`)과 FBA 를 둘 다 더하면 중복 집계다.
 *
 * @returns {{id:string|null, usedBytes:number, totalBytes:number, basis:string,
 *            subscribedTb:number|null, allocatedTb:number|null,
 *            effectiveUsedTb:number|null, savingsTb:number|null, drr:number|null,
 *            compression:string|null}|null}
 */
export function powermaxSrp(srp) {
  if (!srp || typeof srp !== 'object') return null;
  const id = String(srp.srpId ?? srp.srp_id ?? '') || null;
  const blocks = [
    ['srp_capacity', srp.srp_capacity],
    ['fba_srp_capacity', srp.fba_srp_capacity],
    ['ckd_srp_capacity', srp.ckd_srp_capacity],
  ].filter(([, b]) => b && typeof b === 'object');
  const eff = srp.srp_efficiency || srp.fba_srp_efficiency || srp.ckd_srp_efficiency || null;

  const common = (b) => ({
    id,
    subscribedTb: num(b.subscribed_total_tb) ?? num(b.provisioned?.provisioned_tb),
    allocatedTb: num(b.subscribed_allocated_tb),
    drr: num(eff?.data_reduction_ratio_to_one) ?? num(b.data_reduction?.data_reduction_ratio_to_one),
    compression: eff?.compression_state != null ? String(eff.compression_state) : null,
  });

  // V4 — effective.physical_capacity 가 '실제로 기록된 물리 용량' 이다.
  for (const [name, b] of blocks) {
    const phys = b.effective?.physical_capacity;
    const pu = num(phys?.used_tb); const pt = num(phys?.total_tb);
    if (pt && pt > 0 && pu != null) {
      return {
        ...common(b), usedBytes: pu * TB, totalBytes: pt * TB,
        basis: `${name}.effective.physical_capacity`,
        effectiveUsedTb: num(b.effective?.used_tb),
        savingsTb: num(b.data_reduction?.savings_tb),
      };
    }
  }
  // V3 — usable_used_tb 가 같은 정의(감축 후)를 SRP 범위로 한정한 것.
  for (const [name, b] of blocks) {
    const uu = num(b.usable_used_tb); const ut = num(b.usable_total_tb);
    if (ut && ut > 0 && uu != null) {
      return {
        ...common(b), usedBytes: uu * TB, totalBytes: ut * TB,
        basis: `${name}.usable`,
        effectiveUsedTb: null,
        savingsTb: num(eff?.deduplication_and_compression_savings_tb),
      };
    }
  }
  return null;
}

/**
 * v2.605(감사 RECENT2605-04): 용량 블록은 있는데 전체가 **정확히 0** 인 SRP(비어 있는 보조 SRP)인가.
 *   powermaxSrp 는 total>0 을 요구해 이 SRP 에 null 을 주는데, 그것을 '형식 미인식' 으로 세면 SRP 합이 완전한데도
 *   그 어레이가 매 주기 partial-pools(증가량 미적재)가 됐다. 빈 SRP 는 합에 0 이라 합의 완전성에 영향이 없다.
 *   ⚠ 용량 블록이 아예 없는 응답은 여전히 '형식 미인식' 이다(용량을 가진 SRP 를 놓쳤을 수 있다 — 보수적 판정 유지).
 */
export function powermaxSrpIsEmpty(srp) {
  if (!srp || typeof srp !== 'object') return false;
  const blocks = [srp.srp_capacity, srp.fba_srp_capacity, srp.ckd_srp_capacity].filter((b) => b && typeof b === 'object');
  if (!blocks.length) return false;
  let sawZero = false;
  for (const b of blocks) {
    const pt = num(b.effective?.physical_capacity?.total_tb);
    const ut = num(b.usable_total_tb);
    if ((pt != null && pt > 0) || (ut != null && ut > 0)) return false;
    if (pt === 0 || ut === 0) sawZero = true;
  }
  return sawZero;
}

/**
 * v2.601(감사 COL-2601-05): 경보 응답 → 미해결(미확인) 개수. { count, basis }.
 *  · `/system/alert?acknowledged=false` 의 alertId 배열 → basis 'unacknowledged'
 *  · 필터 없는 `/system/alert` 의 alertId 배열 → basis 'all'(확인된 경보도 포함 — 과대일 수 있음을 밝힌다)
 *  · alert_summary → `all_unacknowledged_count` **한 필드**만 읽는다(symmAlertSummary 우선, 없으면 serverAlertSummary).
 *    예전에는 alert_count·critical·warning 을 JSON 전체에서 모두 더해 합계와 그 부분집합이 **이중 계수**됐고, 그 이름의
 *    필드가 없는 버전에서는 **0 인데 'ok'** 였다. 못 찾으면 count null(0 을 지어내지 않는다).
 */
export function powermaxAlertCount(data, path = '') {
  const d = data || {};
  if (Array.isArray(d.alertId)) {
    return { count: d.alertId.length, basis: /acknowledged=false/.test(String(path)) ? 'unacknowledged' : 'all' };
  }
  const read = (node) => {
    const arr = Array.isArray(node) ? node : node && typeof node === 'object' ? [node] : [];
    const vals = arr.map((x) => (x && typeof x === 'object' ? x.all_unacknowledged_count : undefined))
      .filter((v) => v != null && v !== '' && Number.isFinite(Number(v)));
    return vals.length ? vals.reduce((a, v) => a + Number(v), 0) : null;
  };
  const symm = read(d.symmAlertSummary);
  if (symm != null) return { count: symm, basis: 'summary-unacknowledged' };
  const server = read(d.serverAlertSummary);
  if (server != null) return { count: server, basis: 'summary-unacknowledged' };
  return { count: null, basis: null };
}

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

/** TB 반올림(소수 2자리) — 화면 표시용. null 은 그대로 null(0 으로 채우지 않는다). */
const tb2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

/**
 * 원시 응답 → 정규화(순수 — storageMon.test.js 픽스처 고정).
 * raw: { version, arrays:[{symmetrixId, model, ucode, local}], caps:{[id]: powermaxCapacity 결과},
 *        srps:{[id]: powermaxSrp[] }, alertCount, apiVersions, usedPaths }
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
    snap.extra.ucode = a0.ucode || a0.microcode || '';   // 9.x=ucode · 10.x=microcode(실측)
    snap.extra.arrays = arrays.slice(0, 8).map((a) => ({ id: a.symmetrixId, model: a.model }));
    snap.sections.config = 'ok';

    let total = 0; let used = 0; let usedUnknown = 0; let unreadable = 0;
    const pools = [];
    const bases = new Set();
    let suspect = false; let undocumented = false;
    // 구독·할당·실기록·절감을 **각각** 합산한다(뜻이 다르므로 섞지 않는다).
    const sum = { subscribedTb: null, allocatedTb: null, usableUsedTb: null, usableTotalTb: null, snapshotTb: null, rawTb: null, savingsTb: null };
    const add = (k, v) => { if (v != null) sum[k] = (sum[k] ?? 0) + v; };
    let provTotalTb = 0; let provUsedTb = 0; let provSeen = false;
    const srpList = [];
    const srpIncomplete = [];   // v2.604(COL-2604-02): SRP 일부를 못 읽은 어레이 — [{array, listed, parsed, failed, unrecognized, omitted}]
    const srpWithheldIds = new Set();   // v2.605(RECENT2605-04): 실제로 증가량 적재를 막은(어레이 레벨 값으로 대체한) 어레이

    for (const a of arrays.slice(0, 32)) {
      const c = raw.caps?.[a.symmetrixId];
      const mySrps = Array.isArray(raw.srps?.[a.symmetrixId]) ? raw.srps[a.symmetrixId] : [];
      // SRP 합계 — 10.x 처럼 어레이 레벨에 usable 이 없을 때의 **실제 기록량 출처**다.
      let srpUsed = 0; let srpTotal = 0; let srpSeen = false;
      for (const s of mySrps) {
        srpSeen = true; srpUsed += s.usedBytes; srpTotal += s.totalBytes;
        add('savingsTb', s.savingsTb);
        srpList.push({
          array: a.symmetrixId, id: s.id, basis: s.basis,
          usedTb: tb2(s.usedBytes / TB), totalTb: tb2(s.totalBytes / TB),
          subscribedTb: tb2(s.subscribedTb), allocatedTb: tb2(s.allocatedTb),
          effectiveUsedTb: tb2(s.effectiveUsedTb), savingsTb: tb2(s.savingsTb),
          drr: s.drr, compression: s.compression,
        });
      }

      // v2.532 호환: caps 가 옛 형태(usable_*_tb)로 들어오는 엣지 구버전 push 도 받는다.
      let t = null; let u = null; let basis = null;
      if (c) {
        t = c.totalBytes != null ? Number(c.totalBytes) : (Number(c.usable_total_tb) || 0) * TB;
        // v2.594(감사 R2594-01): 사용량을 못 읽었으면 null 을 유지한다 — `|| 0` 이 v2.593 DATA-01 수정을 되돌렸다.
        u = c.usedBytes !== undefined ? numOrNull(c.usedBytes) : (numOrNull(c.usable_used_tb) == null ? null : numOrNull(c.usable_used_tb) * TB);
        basis = c.basis || null;
        if (c.detail) {
          add('subscribedTb', c.detail.subscribedTb); add('allocatedTb', c.detail.allocatedTb);
          add('usableUsedTb', c.detail.usableUsedTb); add('usableTotalTb', c.detail.usableTotalTb);
          add('snapshotTb', c.detail.snapshotTb); add('rawTb', c.detail.rawTb);
        }
        if (c.provisioned?.totalTb != null) { provSeen = true; provTotalTb += c.provisioned.totalTb; provUsedTb += c.provisioned.usedTb || 0; }
      }
      // ★ 문서화되지 않은 `physicalCapacity` 로 읽었는데 SRP 가 실제 기록량을 준다면 **SRP 를 쓴다**.
      //   (10.x 가 정확히 이 경우다 — 어레이 레벨에 usable_* 가 없다.)
      // v2.604(감사 COL-2604-02): SRP 목록은 받았는데 **일부 SRP 만** 읽었으면 그 합은 어레이 전체가 아니다.
      //   구버전 엣지 push 는 srpState 가 없다 → 예전 동작(완전하다고 본다 — 판정 근거가 없다).
      const st = raw.srpState?.[a.symmetrixId];
      // v2.605(RECENT2605-04): 빈(전체 0) SRP 는 합에 영향이 없으므로 '읽은 것' 과 같이 센다(구버전 엣지는 empty 가 없다 → 0).
      const stEmpty = Number(st?.empty) || 0;
      const srpPartial = !!(st && st.listed > 0 && st.parsed + stEmpty < st.listed);
      // withheld = 이 어레이가 실제로 증가량 적재를 막았는가(문구가 사실과 맞게 — documented 어레이는 어레이 레벨 값을 쓴다).
      const srpWithheld = srpPartial && (!c || c.documented === false);
      if (srpPartial) srpIncomplete.push({ array: a.symmetrixId, listed: st.listed, parsed: st.parsed, failed: st.failed || 0, unrecognized: st.unrecognized || 0, omitted: st.omitted || 0, ...(stEmpty ? { empty: stEmpty } : {}) });
      if (srpWithheld) srpWithheldIds.add(a.symmetrixId);
      if (srpSeen && srpTotal > 0 && (!c || c.documented === false) && !srpPartial) {
        t = srpTotal; u = srpUsed; basis = mySrps[0]?.basis ? `srp:${mySrps[0].basis}` : 'srp';
      } else if (srpPartial && (!c || c.documented === false)) {
        // 부분 SRP 합을 어레이 용량이라 말하지 않는다. 어레이 레벨 값(c)이 있으면 그것을 보여 주되 **측정 기준이 다른**
        //   값이므로(평소엔 SRP) 그 주기는 증가량에 적재하지 않게 poolsUnreadable 로 센다(v2.546 partial-pools).
        //   c 도 없으면 이 어레이는 합계에서 빠진다(아래 unreadable 경로).
        if (c) {
          if (c.suspect) suspect = true;
          if (c.documented === false) undocumented = true;
          unreadable += 1;
        } else { t = null; }
      } else if (c) {
        if (c.suspect) suspect = true;
        if (c.documented === false) undocumented = true;
      }
      // 용량을 못 읽은 어레이는 0 으로 채우지 않고 뺀다.
      // v2.600(감사 COL-2600-01): 예전에는 **조용히** 뺐다 — 다중 어레이에서 한 대의 용량 조회가 실패하면 나머지 합이
      //   전체인 척 capacity_daily 에 적재됐다(증가량 화면에 그 날만 거짓 급변). 개수를 poolsUnreadable 로 밝혀
      //   capacityPointEligible 이 partial-pools 로 막게 한다(풀 목록에는 예전처럼 넣지 않는다 — 0 오표시 방지 계약).
      if (!(t > 0)) { unreadable += 1; continue; }
      if (basis) bases.add(basis);
      total += t;
      if (u == null) usedUnknown += 1; else used += u;
      pools.push({ name: a.symmetrixId, totalBytes: t, usedBytes: u, pct: u == null ? null : Math.round((u / t) * 1000) / 10 });
    }
    // v2.600(COL-2600-01): 목록에는 있었는데 상세 조회(②)에 실패해 raw.arrays 에 들어오지 못한 어레이도 같은 수에 넣는다.
    const failedIds = Array.isArray(raw.arraysFailed) ? raw.arraysFailed : [];
    unreadable += failedIds.length;
    // v2.604(COL-2604-03): 상한으로 조회하지 않은 어레이도 합계에서 빠졌을 수 있다 — 같은 수에 더하고 따로 밝힌다.
    const overCap = Number(raw.arraysOverCap) || 0;
    const unchecked = Number(raw.arraysUnchecked) || 0;
    unreadable += overCap + unchecked;
    if (overCap) snap.extra.arraysOverCap = overCap;
    if (unchecked) snap.extra.arraysUnchecked = unchecked;
    if (unreadable) snap.extra.poolsUnreadable = unreadable;
    if (srpIncomplete.length) snap.extra.srpIncomplete = srpIncomplete;

    snap.pools = pools;
    if (total > 0) {
      // 한 어레이라도 사용량을 못 읽었으면 합계 사용량은 null — 부분 합을 전체라 말하지 않는다(xtremio 와 같은 규칙).
      const usedAll = usedUnknown ? null : used;
      snap.capacity = { totalBytes: total, usedBytes: usedAll, pct: usedAll == null ? null : Math.round((usedAll / total) * 1000) / 10 };
      if (usedUnknown) snap.extra.poolsUsedUnreadable = usedUnknown;
      snap.sections.capacity = 'ok';
      if (bases.size) snap.extra.capacityBasis = [...bases].join(', ');
      // ⚠ 프로비저닝(씬 약속치)은 **용량이 아니다** — 화면이 섞지 않도록 별도 키로만 싣는다.
      if (provSeen) {
        snap.extra.provisionedTb = tb2(provTotalTb);
        snap.extra.provisionedUsedTb = tb2(provUsedTb);
      }
      // 구독 / 할당 / 실제 기록 — 셋을 각각. 화면이 이것으로 '할당 말고 실제 기록' 을 구분한다.
      const detail = {};
      for (const [k, v] of Object.entries(sum)) if (v != null) detail[k] = tb2(v);
      if (srpList.length) detail.srps = srpList.slice(0, 16);
      if (Object.keys(detail).length) snap.extra.capacityDetail = detail;

      // ★ 문서화되지 않은 필드로 읽었고 used==total 이면 **화면이 경고해야 한다**.
      if (suspect) snap.extra.capacitySuspect = true;
      snap.extra.capacityBasisNote = suspect
        ? '이 장비의 사용량은 **실제 기록량이 아닐 수 있습니다** — Dell 스펙에 설명이 없는 ‘physicalCapacity’ 필드로 읽었고 사용 == 전체로 보고됩니다(확인한 VMAX 표본들이 그랬습니다). 실제 기록량은 ‘system_capacity.usable_used_tb’ 또는 SRP 조회가 있어야 나옵니다.'
        : undocumented
          ? '전체·사용 용량을 Dell 스펙에 설명이 없는 ‘physicalCapacity’ 필드로 읽었습니다 — 값은 정상 범위로 보이나 의미가 문서로 확인되지 않았습니다.'
          : '사용 용량은 **데이터 감축 적용 후 실제로 기록된 양**입니다(Dell 스펙 ‘usable_used_tb’). 구독(호스트에 약속한 씬 크기)·할당은 뜻이 달라 따로 표시합니다.';
      // v2.604(COL-2604-02·03): 합계가 전체가 아닐 수 있는 사유를 같은 문구에 덧붙인다(증가량 적재는 poolsUnreadable 이 막는다).
      const tails = [];
      if (srpIncomplete.length) {
        // v2.605(RECENT2605-04): '적재하지 않습니다' 는 실제로 적재를 막은 어레이(withheld)에만 쓴다 — documented 어레이는
        //   평소에도 어레이 레벨 값이라 SRP 누락이 합계에 영향이 없고 실제로 적재된다(예전 문구는 거짓이었다).
        const missOf = (x) => x.listed - x.parsed - (Number(x.empty) || 0);
        const held = srpIncomplete.filter((x) => srpWithheldIds.has(x.array));
        const info = srpIncomplete.filter((x) => !srpWithheldIds.has(x.array));
        if (held.length) tails.push(`SRP ${held.reduce((a2, x) => a2 + missOf(x), 0)}개를 읽지 못해 어레이 ${held.length}대는 SRP 합이 아니라 어레이 레벨 값으로 표시했습니다(이 주기는 증가량에 적재하지 않습니다)`);
        if (info.length) tails.push(`SRP ${info.reduce((a2, x) => a2 + missOf(x), 0)}개를 읽지 못했습니다(어레이 ${info.length}대 — 용량은 어레이 레벨 값이라 합계에는 영향이 없고 SRP 상세만 빠졌습니다)`);
      }
      if (overCap) tails.push(`로컬 어레이가 ${MAX_LOCAL_ARRAYS}대를 넘어 ${overCap}대는 조회하지 않았습니다(합계에서 빠졌습니다)`);
      if (unchecked) tails.push(`어레이 목록이 길어 ${unchecked}개는 로컬 여부를 확인하지 못했습니다(합계에서 빠졌을 수 있습니다)`);
      if (tails.length) snap.extra.capacityBasisNote += ` ${tails.join(' · ')}.`;
    }
  }
  if (raw.alertCount != null) { snap.alerts.unresolved = Number(raw.alertCount) || 0; snap.sections.alerts = 'ok'; }
  else if (raw.alertsSection) {
    // v2.602(RECENT2602-02): 경보 응답은 받았는데 미확인 개수를 못 찾았다 — 'skip'·0(emptySnapshot 기본값)으로 두면
    //   화면이 '경보 0건' 으로 읽는다. 사유를 섹션에 싣고 개수는 null(합산에서 0 으로 세지 않는다 — 모르는 것이다).
    snap.sections.alerts = raw.alertsSection;
    snap.alerts.unresolved = null;
  }
  // v2.601(COL-2601-05): 필터 없는 목록으로 셌으면 확인된 경보가 섞였다 — 화면·보고가 알 수 있게 근거를 싣는다.
  if (raw.alertsBasis) snap.extra.alertsBasis = raw.alertsBasis;
  // nodes/accounts 는 이번 범위 밖(디렉터·보드 상세는 실장비 확인 후 후속) — 'skip' 정직 표기.
  snap.extra.collectMethod = 'api';
  // 버전차 진단의 근거 — 화면이 '이 장비는 102 로 읽었다' 를 말할 수 있어야 한다.
  if (raw.apiVersions) snap.extra.apiVersions = raw.apiVersions;
  if (raw.usedPaths && Object.keys(raw.usedPaths).length) snap.extra.usedPaths = raw.usedPaths;
  snap.ok = snap.sections.config === 'ok' || snap.sections.capacity === 'ok';
  if (!snap.ok && !snap.error) snap.error = '수집 실패(섹션 오류 참조)';
  return snap;
}

/**
 * v2.602(RECENT2602-02 후속): 경보 조회가 **오류**면 미해결 수는 0 이 아니라 모른다(null) — emptySnapshot 기본값 0 을
 * 그대로 두면 화면 합계가 '경보 0건' 으로 읽는다. 섹션의 오류 문구는 그대로 둔다(사유).
 */
function alertsUnknownIfFailed(out) {
  if (/^오류/.test(String(out.sections?.alerts || '')) && out.alerts) out.alerts.unresolved = null;
}

export async function collect(device, { signal = null } = {}) {
  const get = makeGetter(device, { port: Number(process.env.STORAGE_UNISPHERE_PORT) || 8443, signal });
  const raw = { caps: {}, srps: {}, srpState: {} };
  const snap = emptySnapshot(device); // 섹션 오류 임시 기록용
  try {
    // ① Unisphere 버전(무버전 경로 — 인증 확인 겸용, 401 이면 즉시 전체 중단).
    try { raw.version = await get('/univmax/restapi/version'); }
    catch (e) { if (/401/.test(e.message)) throw e; /* 버전 실패는 치명 아님 */ }
    const { vers, source } = apiVersionsFrom(raw.version);
    raw.apiVersions = { vers, source };
    raw.usedPaths = {};
    // ② 어레이 목록 → 어레이별 상세(model/ucode). 원격(SRDF 상대) 어레이는 로컬만 남긴다.
    let ids = [];
    try {
      const r = await tryPaths(get, pathsFor(vers, '/system/symmetrix'));
      raw.usedPaths.arrays = r.path;
      ids = r.data?.symmetrixId || [];
    } catch (e) { snap.sections.config = `오류: ${e.message}`; if (/401/.test(e.message)) throw e; }
    raw.arrays = [];
    raw.arraysFailed = [];
    // v2.604(COL-2604-03): 상세를 먼저 읽어 원격을 거른 뒤 **로컬만** 상한으로 자른다(원격이 상한을 먹지 않게).
    //   상세 상한을 넘은 id 는 로컬인지 모른다 → arraysUnchecked 로 세고, 로컬인데 상한을 넘은 것은 arraysOverCap.
    //   둘 다 합계에서 빠질 수 있으므로 정규화가 poolsUnreadable 에 더해 capacity_daily 가 부분 합을 적재하지 않게 한다.
    raw.arraysUnchecked = Math.max(0, ids.length - MAX_ARRAY_DETAIL);
    raw.arraysOverCap = 0;
    raw.arraysRemote = 0;
    for (const id of ids.slice(0, MAX_ARRAY_DETAIL)) {
      try {
        const r = await tryPaths(get, pathsFor(vers, `/system/symmetrix/${encodeURIComponent(id)}`));
        raw.usedPaths.array = r.path;
        const d = r.data;
        const a = Array.isArray(d?.symmetrix) ? d.symmetrix[0] : d?.symmetrix || d;
        if (a && a.local === false) { raw.arraysRemote += 1; continue; }
        if (a && raw.arrays.length >= MAX_LOCAL_ARRAYS) { raw.arraysOverCap += 1; continue; }
        if (a) raw.arrays.push({ symmetrixId: a.symmetrixId || id, model: a.model, ucode: a.ucode, local: a.local });
      } catch (e) {
        if (/401/.test(e.message)) throw e;
        snap.sections.config = `일부 어레이 오류: ${e.message}`;
        raw.arraysFailed.push(id);   // v2.600(COL-2600-01): 합계에서 빠진 어레이를 세도록 남긴다
      }
    }
    // v2.604(COL-2604-03): 목록은 있었는데 로컬 어레이가 하나도 남지 않았으면 **왜** 인지 말한다(예전엔 사유 없이 실패).
    if (ids.length && !raw.arrays.length && !raw.arraysFailed.length) {
      snap.sections.config = `오류: 로컬 어레이를 찾지 못했습니다(목록 ${ids.length}개 중 원격(SRDF) ${raw.arraysRemote}개`
        + (raw.arraysUnchecked ? ` · 상한으로 미확인 ${raw.arraysUnchecked}개` : '') + ')';
    }
    // ③ 어레이별 용량(sloprovisioning). 실패 어레이는 caps 에서 빠져 pools 에도 안 실린다.
    for (const a of raw.arrays) {
      try {
        const r = await tryPaths(get, pathsFor(vers, `/sloprovisioning/symmetrix/${encodeURIComponent(a.symmetrixId)}`));
        raw.usedPaths.capacity = r.path;
        const d = r.data;
        // 10.x 응답은 `{symmetrix:[…]}` 래핑 없이 **평면 객체**로 온다(실측) — `|| d` 가 그것을 받는다.
        const s = Array.isArray(d?.symmetrix) ? d.symmetrix[0] : d?.symmetrix || d;
        const cap = powermaxCapacity(s);
        if (cap) raw.caps[a.symmetrixId] = cap;
        else snap.sections.capacity = '오류: 용량 필드를 인식하지 못했습니다(system_capacity·physicalCapacity 모두 없음 — Unisphere 버전 확인)';
      } catch (e) { if (/401/.test(e.message)) throw e; snap.sections.capacity = `오류: ${e.message}`; }
    }
    // ④ SRP(풀)별 용량 — v2.534. 10.x 는 어레이 레벨에 usable_* 가 없어 **여기서만** 실제 기록량이 나오고,
    //    데이터 감축 절감량도 여기에만 있다. 보통 어레이당 SRP 1개라 왕복은 +2회다.
    //    실패해도 용량 섹션을 깨뜨리지 않는다(부가 정보 — 없으면 없다고 말할 뿐).
    for (const a of raw.arrays) {
      try {
        const base = `/sloprovisioning/symmetrix/${encodeURIComponent(a.symmetrixId)}/srp`;
        const r = await tryPaths(get, pathsFor(vers, base));
        raw.usedPaths.srpList = r.path;
        const srpIds = Array.isArray(r.data?.srpId) ? r.data.srpId : [];
        // v2.604(감사 COL-2604-02): SRP 마다 따로 받고 **몇 개를 못 읽었는지** 남긴다. 예전에는 한 try 안이라
        //   둘째 SRP 가 실패하면 첫 SRP 합만 남아 그것이 어레이 전체 용량으로 쓰였다(오류 없이 틀린 값).
        const st = { listed: srpIds.length, parsed: 0, failed: 0, unrecognized: 0, empty: 0, omitted: Math.max(0, srpIds.length - MAX_SRP) };
        raw.srpState[a.symmetrixId] = st;
        for (const sid of srpIds.slice(0, MAX_SRP)) {
          try {
            const r2 = await tryPaths(get, pathsFor(vers, `${base}/${encodeURIComponent(sid)}`));
            raw.usedPaths.srp = r2.path;
            const d2 = r2.data;
            const s = Array.isArray(d2?.srp) ? d2.srp[0] : d2?.srp || d2;
            const parsed = powermaxSrp(s);
            if (parsed) { st.parsed += 1; (raw.srps[a.symmetrixId] ||= []).push({ ...parsed, id: parsed.id || String(sid) }); }
            else if (powermaxSrpIsEmpty(s)) st.empty += 1;   // v2.605: 빈 SRP 는 형식 미인식이 아니다
            else st.unrecognized += 1;
          } catch (e2) { if (/401/.test(e2.message)) throw e2; st.failed += 1; raw.srpError = e2.message; }
        }
      } catch (e) { if (/401/.test(e.message)) throw e; raw.srpError = e.message; }
    }
    // ⑤ 미해결 알람 수 — /system/alert 는 알람 ID 배열을 반환(버전에 따라 alert_summary 폴백).
    // v2.601(감사 COL-2601-05): '미해결' 이므로 **확인(acknowledged)되지 않은 것만** 센다 — 필터를 먼저 시도하고, 필터를
    //   받지 않는 버전이면 전체 목록으로 떨어지되 그 사실(alertsBasis)을 싣는다. 판정은 powermaxAlertCount 하나.
    try {
      const r = await tryPaths(get, [
        ...pathsFor(vers, '/system/alert?acknowledged=false'), ...pathsFor(vers, '/system/alert'), ...pathsFor(vers, '/system/alert_summary'),
      ]);
      raw.usedPaths.alerts = r.path;
      const a = powermaxAlertCount(r.data, r.path);
      raw.alertCount = a.count;
      raw.alertsBasis = a.basis;
      if (a.count == null) raw.alertsSection = '미수집(경보 응답에서 미확인 개수를 찾지 못했습니다)';
    } catch (e) { if (/401/.test(e.message)) throw e; snap.sections.alerts = `오류: ${e.message}`; }
  } catch (e) {
    const out = normalizePowermax(device, raw);
    out.error = e.message;
    for (const [k, v] of Object.entries(snap.sections)) if (String(v).includes('오류')) out.sections[k] = v;
    alertsUnknownIfFailed(out);
    return out;
  }
  const out = normalizePowermax(device, raw);
  for (const [k, v] of Object.entries(snap.sections)) if (String(v).includes('오류')) out.sections[k] = v;
  alertsUnknownIfFailed(out);
  if (raw.srpError) out.extra.srpError = String(raw.srpError).slice(0, 200);
  return out;
}
