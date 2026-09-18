/**
 * bmusage/license.js — iDRAC 라이선스 등급 판정(순수, v2.554).
 *
 * 사용자 신고(2026-09-17): "여기서 idarc 텔레메트리는 라인선스가 data center 라이선스가 필요한데,
 * 내가 가진건 enterprise 라이선스라서, 엔터프라이즈 라이선스 대상 서버도 수집하는 기능 추가로
 * 만들어줘".
 *
 * ── 왜 이 모듈이 필요한가 ────────────────────────────────────────────────────
 * v2.550~2.551 의 화면은 텔레메트리가 비면 `iDRAC 텔레메트리 리포트가 없습니다 — Datacenter
 * 라이선스가 필요할 수 있습니다` 라고 **추측으로** 말했다. 그런데 **라이선스 목록은 이미 우리 손에
 * 있다** — `idrac/redfish.js:653` 이 `inv.licenses` 를 채워 `idrac/invCache.js` 에 보관한다
 * (`/redfish/v1/LicenseService/Licenses` → `Oem/Dell/DellLicenses` 폴백). 즉 **장비에 왕복 0회로**
 * '이 서버는 Enterprise 라서 그 리포트가 없다' 를 단정할 수 있다. 추측을 사실로 바꾸는 것이
 * 이 모듈의 존재 이유다(CLAUDE.md v2.493 '값이 없는 이유를 단정하지 말 것' 의 반대 방향 —
 * **근거가 있으면 말해야 한다**).
 *
 * ── 판정 규칙(되돌리지 말 것) ────────────────────────────────────────────────
 * ⚠⚠ **Dell 의 `LicenseType` 은 등급이 아니다.** 그 필드는 `Production`/`Evaluation` 이고
 *   (`redfish.js:664` 가 `LicenseType || LicensePrimaryStatus` 를 `type` 으로 담는다) 등급은
 *   **`Name`·`LicenseDescription`** 쪽에 `iDRAC9 Datacenter License` 처럼 들어온다. `type` 만 보면
 *   전 서버가 '등급 미상' 이 된다.
 * ⚠ **등급은 가장 높은 것 하나다** — 한 iDRAC 에 Express 와 Enterprise 가 함께 설치될 수 있고,
 *   그때 기능은 높은 쪽을 따른다. `datacenter > enterprise > express > basic` 순으로 본다.
 * ⚠ **아무 키워드도 못 찾으면 `unknown`** 이다. '기본값 enterprise' 같은 것을 만들지 말 것 —
 *   그러면 Datacenter 장비에 Enterprise 대체 수집(= 장비 부하)을 걸게 된다.
 * ⚠ **만료를 '등급 없음' 으로 접지 않는다.** 만료일이 지난 항목은 등급 후보에서 빼고 그 사실을
 *   `expired` 로 밝힌다 — 다만 만료 항목만 있으면 등급은 `unknown` 이고 '라이선스가 없다' 고
 *   단정하지 않는다(iDRAC 이 만료 항목을 그대로 나열하는지 확인하지 못했다).
 *
 * ⚠ **정직 기록**: '텔레메트리 = Datacenter' 라는 명제의 근거는 **사용자 확인**이다(위 신고 원문).
 *   Dell 의 기능 매트릭스 원문은 이 환경의 egress 정책에서 읽지 못했다(developer.dell.com 403).
 *   그래서 화면 문구도 '필요합니다' 가 아니라 **'이 환경에서 확인된 것은 …'** 형태로 쓴다.
 */
const t = (v) => String(v ?? '').trim();

/** 등급 — 높은 순서. 배열 순서가 곧 우선순위 계약이다(테스트가 고정). */
export const TIER_ORDER = Object.freeze(['datacenter', 'enterprise', 'express', 'basic']);

export const TIER_LABEL = Object.freeze({
  datacenter: 'Datacenter',
  enterprise: 'Enterprise',
  express: 'Express',
  basic: 'Basic',
  unknown: '미상',
});

/**
 * 등급 키워드. ⚠ 한 단어로 굳히지 말 것 — 표기가 `iDRAC9 Datacenter License` ·
 * `iDRAC9 Datacenter` · `iDRAC9 x5 Datacenter` 등으로 흔들린다(v2.545 '후보 체인' 규약).
 */
const TIER_RE = Object.freeze({
  datacenter: /data\s*-?\s*cent(er|re)/i,
  enterprise: /enterprise/i,
  express: /express/i,
  basic: /\bbasic\b|\bbmc\b/i,
});

/** 한 라이선스 항목이 만료됐는가. 날짜를 못 읽으면 **false**(만료라고 단정하지 않는다). */
export function licenseExpired(lic = {}, now = Date.now()) {
  const s = t(lic.expiry);
  if (!s) return false;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return false;
  return ms < now;
}

/**
 * 라이선스 목록 → 등급.
 * @param {Array} licenses `inv.licenses` — [{ name, type, entitlement, expiry }]
 * @returns {{tier:string, label:string, matched:string, names:string[], count:number,
 *            expired:number, evaluation:boolean}}
 *   `tier:'unknown'` = 판정 근거가 없다(목록이 없거나 키워드가 없다).
 */
export function classifyLicense(licenses = [], { now = Date.now() } = {}) {
  const list = Array.isArray(licenses) ? licenses : [];
  const names = [];
  let expired = 0;
  let evaluation = false;
  let tier = '';
  let matched = '';
  for (const l of list) {
    if (!l || typeof l !== 'object') continue;
    const label = t(l.name) || t(l.entitlement);
    if (label) names.push(label);
    if (/eval/i.test(t(l.type)) || /eval/i.test(label)) evaluation = true;
    if (licenseExpired(l, now)) { expired += 1; continue; }
    /*
     * ⚠ 등급은 **이름 계열에서만** 찾는다. `type`(Production/Evaluation)을 섞으면
     *   'Enterprise' 가 없는데도 우연한 문자열로 등급이 생길 수 있다. `entitlement` 는
     *   Dell 의 주문 식별자라 등급 단어가 들어오는 경우가 있어 포함한다.
     */
    const hay = `${t(l.name)} ${t(l.entitlement)}`;
    for (const k of TIER_ORDER) {
      if (!TIER_RE[k].test(hay)) continue;
      // 더 높은 등급이 이미 잡혀 있으면 덮지 않는다(TIER_ORDER 가 우선순위다).
      if (!tier || TIER_ORDER.indexOf(k) < TIER_ORDER.indexOf(tier)) { tier = k; matched = hay.trim(); }
      break;
    }
  }
  return {
    tier: tier || 'unknown',
    label: TIER_LABEL[tier || 'unknown'],
    matched,
    names: [...new Set(names)].slice(0, 8),
    count: list.length,
    expired,
    evaluation,
  };
}

/**
 * 캐시된 인벤토리에서 등급을 읽는다(장비 왕복 0). 인벤토리가 없으면 `unknown` + `source:''`.
 * ⚠ **인벤토리 수집 시각을 함께 낸다** — 라이선스를 추가 설치했는데 화면이 옛 등급으로 말하면
 *   사용자가 '기능이 고장났다' 고 읽는다. 화면은 `at` 으로 '언제 본 값' 인지 밝힌다.
 */
export function licenseFromInventory(inv, { now = Date.now() } = {}) {
  if (!inv || typeof inv !== 'object') {
    return { tier: 'unknown', label: TIER_LABEL.unknown, names: [], count: 0, expired: 0, evaluation: false, matched: '', source: '', at: null };
  }
  const r = classifyLicense(inv.licenses, { now });
  return { ...r, source: 'inventory', at: Number(inv.collectedAt) || null };
}

/**
 * 이 등급에서 `TelemetryService/MetricReports/SystemUsage` 를 기대할 수 있는가.
 * @returns {'yes'|'no'|'unknown'}
 * ⚠ `unknown` 을 `no` 로 접지 말 것 — 등급을 모르는 서버에 Enterprise 대체 수집(장비 부하)을
 *   자동으로 걸면 사용자가 동의한 범위를 넘는다. 그 판단은 `enterpriseEligible` 이 한다.
 */
export function telemetryExpected(tier) {
  const k = t(tier).toLowerCase();
  if (k === 'datacenter') return 'yes';
  if (k === 'enterprise' || k === 'express' || k === 'basic') return 'no';
  return 'unknown';
}

/**
 * Enterprise 대체 수집 대상인가(순수).
 *
 * ── 왜 '텔레메트리가 실제로 실패했을 때' 를 함께 보는가 ─────────────────────
 * 등급만 보고 걸면 ⓐ 등급을 못 읽은 서버가 영영 제외되고 ⓑ Datacenter 인데 텔레메트리가
 * 꺼져 있는 서버(`empty-report`)도 제외된다. 반대로 등급을 무시하면 **텔레메트리가 잘 되는
 * Datacenter 장비에도 SSH·추가 GET 이 붙어** 장비 부하가 두 배가 된다(사용자가 부하를 알고
 * 동의한 것은 '텔레메트리로 못 읽는 서버' 에 대해서다).
 *
 * @param {object} p
 * @param {string} p.tier              `classifyLicense().tier`
 * @param {string} p.telemetryKind     `fetchUsage()` 의 `kind`(실패했을 때만 값이 있다)
 * @param {boolean} p.telemetryOk      이번 주기에 텔레메트리가 값을 줬는가
 * @returns {{eligible:boolean, why:string}}
 */
export function enterpriseEligible({ tier = '', telemetryKind = '', telemetryOk = false } = {}) {
  const k = t(telemetryKind);
  // 자격증명 거부는 대체 경로도 같은 계정을 쓴다 — 반복 시도는 **계정을 잠근다**(v2.535 규약).
  if (k === 'auth') return { eligible: false, why: 'auth' };
  if (telemetryOk) return { eligible: false, why: 'telemetry-ok' };
  const exp = telemetryExpected(tier);
  if (exp === 'no') return { eligible: true, why: 'license' };
  // 등급이 Datacenter 인데도 못 읽었다 — 대체 경로를 쓸 이유가 있다(텔레메트리 미설정 등).
  if (k) return { eligible: true, why: exp === 'yes' ? 'telemetry-failed' : 'unknown-license' };
  return { eligible: false, why: 'no-signal' };
}
