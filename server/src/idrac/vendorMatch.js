/**
 * vendorMatch.js — BMC 벤더 판별(순수, v2.495).
 *
 * 배경(사용자 요구): iDRAC 스캔 대역에 Dell 이 아닌 서버(HPE iLO 등)가 있으면 특수 기능에
 * '미지원 서버' 로 보이게 한다. 판별 근거는 스캔이 **이미 무인증으로 받아 둔 Redfish 서비스 루트**
 * (`GET /redfish/v1`)라 추가 HTTP 요청이 0회다. 인증이 필요한 Systems 문서로는 판별할 수 없다 —
 * 대역 계정이 Dell 용이라 HPE 장비에서는 401 이 나기 때문(그래서 지금까지 HPE 는 '인증실패' 로
 * 집계돼 사라졌다, scan.js 분기 순서).
 *
 * 정직성 규약:
 *  - '미지원 서버' 의 정의는 **Redfish 서비스 루트가 응답했으나 Dell 이 아닌 장비**다. Redfish 양성
 *    신호(`RedfishVersion`·`@odata.id`·`Links.Sessions`) 없이 'Dell 아님' 만으로 담으면 스위치 웹UI·
 *    ESXi·프린터까지 섞여 목록이 신뢰를 잃는다(현행 notIdrac 이 그 잡탕이다).
 *  - 벤더는 **구조적 키(Oem 키·Vendor·Manufacturer) 우선**, `Product` 문자열은 휴리스틱으로 표시,
 *    확신이 없으면 'unknown'(화면: 'Dell 아님(벤더 미확인)'). 근거(evidence)를 함께 돌려줘 화면이
 *    '무엇을 보고 그렇게 판단했는지' 를 보일 수 있게 한다.
 *  - 기존 Dell 휴리스틱(JSON 전문 substring)은 하위 폴백으로 남긴다 — 치환하면 Dell 판별 회귀 위험.
 *
 * ⚠ 아래 문자열 테이블은 Redfish 규격·공개 문서 기준이며 실기기 응답으로 전부 검증하지는 못했다
 *   (특히 Product 문구). 오판이 확인되면 이 테이블만 고치면 된다.
 */

const OEM_KEYS = [
  ['dell', /^dell$/i], ['hpe', /^hpe?$/i], ['lenovo', /^lenovo$/i], ['supermicro', /^supermicro$/i],
  ['cisco', /^cisco$/i], ['fujitsu', /^(ts_)?fujitsu$/i], ['inspur', /^inspur$/i], ['huawei', /^huawei$/i],
  ['ami', /^ami$/i], ['intel', /^intel(_rackscale)?$/i],
];
const NAME_RULES = [
  ['dell', /\bdell\b/i], ['hpe', /\b(hpe|hewlett[\s-]?packard|hp)\b/i], ['lenovo', /\blenovo\b/i],
  ['supermicro', /\bsuper\s?micro\b/i], ['cisco', /\bcisco\b/i], ['fujitsu', /\bfujitsu\b/i],
  ['inspur', /\binspur\b/i], ['huawei', /\bhuawei\b/i], ['ami', /\b(ami|american megatrends)\b/i], ['intel', /\bintel\b/i],
];
// Product 문구 휴리스틱 — 근거 등급을 'product' 로 낮춰 표시한다.
const PRODUCT_RULES = [
  ['dell', /idrac|integrated (dell )?remote access/i],
  ['hpe', /\bilo\b|integrated lights[\s-]?out/i],
  ['lenovo', /\bxcc\b|xclarity/i],
  ['cisco', /\bcimc\b|integrated management controller/i],
  ['fujitsu', /\birmc\b/i],
  ['supermicro', /supermicro/i],
];
export const VENDOR_LABEL = {
  dell: 'Dell', hpe: 'HPE', lenovo: 'Lenovo', supermicro: 'Supermicro', cisco: 'Cisco', fujitsu: 'Fujitsu',
  inspur: 'Inspur', huawei: 'Huawei', ami: 'AMI(범용 BMC)', intel: 'Intel', unknown: 'Dell 아님(벤더 미확인)',
};

const str = (v) => (v == null ? '' : String(v));

/** Redfish 서비스 루트로 보이는가(양성 신호). 이 게이트를 통과한 것만 '미지원 서버' 후보다. */
export function isRedfishRoot(root) {
  if (!root || typeof root !== 'object') return false;
  if (str(root.RedfishVersion)) return true;
  if (str(root['@odata.id']).startsWith('/redfish/v1')) return true;
  if (root.Links && typeof root.Links === 'object' && root.Links.Sessions) return true;
  return false;
}

function matchTable(table, text) {
  const t = str(text);
  if (!t) return null;
  for (const [vendor, re] of table) if (re.test(t)) return vendor;
  return null;
}

/**
 * 벤더 분류. 입력은 모두 선택적 — 있는 것만으로 판단한다.
 *   root         : GET /redfish/v1 응답(무인증)
 *   manufacturer : Systems/<id>.Manufacturer(인증 성공 시)
 *   model        : Systems/<id>.Model
 * 반환 { redfish, vendor, label, evidence, product }.
 */
export function classifyBmcVendor({ root, manufacturer, model } = {}) {
  const redfish = isRedfishRoot(root);
  const product = str(root?.Product);
  let vendor = null; let evidence = '';
  // 1) Oem 키(가장 구조적)
  const oemKeys = root?.Oem && typeof root.Oem === 'object' ? Object.keys(root.Oem) : [];
  for (const k of oemKeys) { const v = matchTable(OEM_KEYS, k); if (v) { vendor = v; evidence = `oem:${k}`; break; } }
  // 2) Vendor 필드
  if (!vendor) { const v = matchTable(NAME_RULES, root?.Vendor); if (v) { vendor = v; evidence = `vendor:${str(root.Vendor)}`; } }
  // 3) Manufacturer(인증 성공 시)
  if (!vendor) { const v = matchTable(NAME_RULES, manufacturer); if (v) { vendor = v; evidence = `manufacturer:${str(manufacturer)}`; } }
  // 4) Product 문구(휴리스틱) — 제품명에 벤더명이 박힌 경우('Cisco IMC'·'Dell …')를 먼저, 그다음 제품 별칭(iLO·XCC…)
  if (!vendor) { const v = matchTable(NAME_RULES, product) || matchTable(PRODUCT_RULES, product); if (v) { vendor = v; evidence = `product:${product}`; } }
  // 5) 하위 폴백 — 기존 Dell 시그니처(JSON 전문 substring). 회귀 방지를 위해 유지.
  if (!vendor) {
    const sig = JSON.stringify(root || {}).toLowerCase() + ' ' + str(model).toLowerCase();
    if (sig.includes('idrac') || sig.includes('dell')) { vendor = 'dell'; evidence = 'signature'; }
  }
  if (!vendor) vendor = 'unknown';
  return { redfish, vendor, label: VENDOR_LABEL[vendor] || vendor, evidence, product };
}
