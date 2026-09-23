/**
 * toolcats/catalog.js — 특수 기능 카테고리 분류 (순수 모듈, v2.455).
 *
 * 요구: "특수기능에 기능이 너무 많아서, 설정에서 카테고리로 묶어 보여줄 수 있게. 서버/네트워크/
 * 스토리지/가상화 등 사용자가 각 기능을 카테고리에 선택해 포함. **1개 기능을 중복해서 여러
 * 카테고리에 넣을 수 있게.**"
 *
 * 실제로 도구가 79개다(카드 78장). 카드 그리드 하나에 78장이 깔리면 찾는 것보다 훑는 게 더 오래 걸린다.
 *
 * 설계:
 *  - 카테고리는 **사용자가 만든다**(이름·아이콘·순서 자유). 아래 `PRESET` 은 '추천 분류로 시작'
 *    버튼이 쓰는 초기값일 뿐이고 **자동 적용하지 않는다** — 업그레이드만으로 화면이 바뀌면 안 된다.
 *  - **중복 소속이 정상이다**(요구사항). 한 도구가 여러 카테고리에 들어갈 수 있고, 그래서
 *    'tools 배열의 합집합' 이 아니라 카테고리별로 독립된 목록을 둔다.
 *  - 어느 카테고리에도 없는 도구는 **사라지지 않고** '기타' 로 모인다 — 새 도구가 추가됐을 때
 *    관리자가 분류하기 전까지 화면에서 없어지면 기능이 죽은 것처럼 보인다(가용성 우선).
 *  - 도구 키의 **존재 여부는 웹이 판단**한다(`web/src/views/specialToolsList.js` 가 단일 소스).
 *    서버는 형식만 본다 — 목록을 서버로 복사하면 둘이 어긋나는 날이 온다.
 *  - 같은 이유로 **화면 배치 계산도 웹**(`views/toolSections.js`)이 한다. 서버는 저장·검증·프리셋만.
 */

/** 도구 키 형식 — 웹 TOOLS 의 `k` 와 같은 규칙(소문자·숫자·하이픈). */
export const TOOL_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** 카테고리 id 형식. */
export const CAT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const MAX_CATEGORIES = 20;
export const MAX_TOOLS_PER_CAT = 200;
export const MAX_LABEL = 40;

/**
 * '추천 분류로 시작' 프리셋 — v2.454 시점의 도구 76개 기준으로 만들었고 이후 늘어난 도구는
 * 아래 PRESET 에 없으면 '기타'로 빠진다. 현재 도구는 79개다(v2.508 에 orphanvmdk·guest-disk·
 * mail-diag 를 추가했다).
 *
 * 분류 기준은 **운영자가 무엇을 찾으려 하는가**다(구현 위치가 아니라). 그래서 겹치는 것이 많고,
 * 겹치는 것을 억지로 하나로 몰지 않았다 — 중복 소속이 이 기능의 요구사항이다. 예:
 *   · `esxitemp`(서버 온도)는 '서버' 이자 '가상화' 다.
 *   · `dir-usage`(폴더 사용량)는 '스토리지' 이자 '리포트' 다.
 *   · `gpu` 는 '서버' 이자 '가상화' 다.
 *
 * 목록에 없는 도구(나중에 추가된 것)는 화면에서 '기타' 로 모인다.
 */
export const PRESET = Object.freeze([
  {
    id: 'server', label: '서버', icon: '🖥️',
    tools: ['fleet', 'hardware', 'serveranalysis', 'serial-lookup', 'esxi', 'esxitemp', 'roomtemp',
      'powermap', 'pdu', 'gpu', 'hba', 'nic-speed', 'nic-models', 'rma', 'bm-storage', 'part-faults',
      'bm-usage'],
  },
  {
    id: 'network', label: '네트워크', icon: '🌐',
    tools: ['net-check', 'net-traffic', 'net-issues', 'nsx', 'ipam', 'dupip', 'relaytopo',
      'relaycheck', 'link-check', 'comm-map', 'data-flow', 'device-flow', 'san-switch', 'hba', 'nic-speed', 'nic-models', 'topo3d'],
  },
  {
    id: 'storage', label: '스토리지', icon: '💾',
    tools: ['storage-mon', 'storage-growth', 'storage-track', 'bm-storage', 'san-switch', 'dsusage', 'thinvms',
      'dir-usage', 'portaldb', 'snapshots', 'snapshot-age', 'orphanvmdk', 'guest-disk'],
  },
  {
    id: 'virtualization', label: '가상화', icon: '🧊',
    tools: ['vmfinder', 'vm-track', 'vmtools', 'guestos', 'real-os', 'curuser', 'snapshots', 'vm-clone',
      'vmprovision', 'vm-export', 'esxi', 'esxitemp', 'vcversion', 'solutions', 'gpu', 'topo3d'],
  },
  {
    id: 'capacity', label: '용량·최적화', icon: '📈',
    tools: ['capacity', 'capacity-advisor', 'capacity-forecast', 'forecast', 'waste', 'rightsizing',
      'thinvms', 'zombie-vms', 'explore', 'storage-track', 'dir-usage', 'orphanvmdk', 'guest-disk'],
  },
  {
    id: 'security', label: '보안·계정', icon: '🛡️',
    tools: ['threats', 'secret-scan', 'codex-check', 'credentials', 'login-fails', 'cert-expiry',
      'compliance-report', 'licenses', 'license-expiry'],
  },
  {
    id: 'report', label: '리포트·점검', icon: '📋',
    tools: ['daily-health', 'insights', 'compliance-report', 'change-history', 'unprotected-vms',
      'alert-channels', 'davinci-svc', 'svcmon-config', 'vmware-backup', 'dir-usage', 'capacity',
      'portal-check'],
  },
  {
    id: 'search', label: '검색', icon: '🔎',
    tools: ['aisearch', 'deepsearch', 'vmfinder', 'explore', 'serial-lookup', 'dupip'],
  },
  {
    id: 'ops', label: '운영 작업', icon: '🛠️',
    tools: ['rma', 'vmprovision', 'vm-clone', 'agent-scans', 'shutdown', 'credentials',
      'diskadd', 'backup', 'massdeploy', 'service-hub', 'mail-diag', 'edge-log'],
  },
]);

// 제어문자만 제거한다(공백·하이픈은 이름에 정상적으로 쓰인다).
// eslint-disable-next-line no-control-regex
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

/** 카테고리 1건 정규화 — 저장 전에 통과시킨다. */
export function normCategory(c, i = 0) {
  const rawId = String(c?.id || '').trim().toLowerCase();
  const id = CAT_ID_RE.test(rawId) ? rawId : `cat${i + 1}`;
  const seen = new Set();
  const tools = [];
  for (const t of Array.isArray(c?.tools) ? c.tools : []) {
    const k = String(t || '').trim().toLowerCase();
    if (!TOOL_KEY_RE.test(k) || seen.has(k)) continue;   // 같은 카테고리 안의 중복만 제거한다
    seen.add(k);
    tools.push(k);
    if (tools.length >= MAX_TOOLS_PER_CAT) break;
  }
  return {
    id,
    label: clean(c?.label, MAX_LABEL) || id,
    // 아이콘은 이모지 1~2자만 허용한다(마크업·긴 문자열이 카드 레이아웃을 깨뜨리지 않게).
    icon: clean(c?.icon, 4),
    enabled: c?.enabled !== false,
    tools,
  };
}

/** 카테고리 1건의 문제점(순수). 없으면 null. */
export function categoryIssue(c) {
  if (!c || typeof c !== 'object') return '카테고리가 비어 있습니다.';
  const id = String(c.id || '').trim().toLowerCase();
  if (!CAT_ID_RE.test(id)) return "id 는 영소문자·숫자·하이픈만 쓸 수 있습니다(예: 'network').";
  if (!clean(c.label, MAX_LABEL)) return '이름을 입력하세요.';
  const bad = (Array.isArray(c.tools) ? c.tools : []).find((t) => !TOOL_KEY_RE.test(String(t || '').trim().toLowerCase()));
  if (bad) return `도구 키 형식 오류: ${String(bad).slice(0, 30)}`;
  return null;
}

/** 전체 검증 — 문제 목록(빈 배열이면 통과). */
export function validate(cfg) {
  const out = [];
  const cats = Array.isArray(cfg?.categories) ? cfg.categories : [];
  if (cats.length > MAX_CATEGORIES) out.push(`카테고리는 최대 ${MAX_CATEGORIES}개까지입니다.`);
  for (const [i, c] of cats.entries()) {
    const e = categoryIssue(c);
    if (e) out.push(`카테고리 ${i + 1}(${c?.label || c?.id || '이름 없음'}): ${e}`);
  }
  const ids = cats.map((c) => String(c?.id || '').trim().toLowerCase());
  if (new Set(ids).size !== ids.length) out.push('카테고리 id 가 중복되었습니다.');
  return out;
}

/**
 * ⚠ 화면 배치 계산(`buildSections`)은 여기 없다 — `web/src/views/toolSections.js` 가 소유한다.
 * 같은 로직을 서버·웹 양쪽에 두면 어긋나는 날이 온다. 서버는 **저장·검증·프리셋**만 담당하고,
 * '어떤 섹션을 어떤 순서로 그릴지' 는 권한·검색 필터를 이미 적용한 웹이 판단한다.
 */
