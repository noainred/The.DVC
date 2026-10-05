/**
 * toolcats/catalog.js — 특수 기능 카테고리 분류 (순수 모듈, v2.455).
 *
 * 요구: "특수기능에 기능이 너무 많아서, 설정에서 카테고리로 묶어 보여줄 수 있게. 서버/네트워크/
 * 스토리지/가상화 등 사용자가 각 기능을 카테고리에 선택해 포함. **1개 기능을 중복해서 여러
 * 카테고리에 넣을 수 있게.**"
 *
 * 도구는 `web/src/views/specialToolsList.js` 의 전부다(개수를 여기 적지 않는다 — v2.613 CATALOG2613-11: 주석의 숫자는 매 릴리스
 * 낡는다). 카드 그리드 하나에 전부 깔리면 찾는 것보다 훑는 게 더 오래 걸린다.
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
 * '추천 분류로 시작' 프리셋 — v2.454 에 만들었고 이후 늘어난 도구는 아래 PRESET 에 없으면 '기타'로 빠진다
 * (전체 목록은 specialToolsList.js — `toolCategories2455`·`v4Portal2508 F0-3` 테스트가 PRESET 이 전부를 덮는지 고정한다).
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
    tools: ['fleet', 'hardware', 'serveranalysis', 'idrac-trend', 'serial-lookup', 'esxi', 'host-hygiene', 'esxitemp', 'roomtemp',
      'powermap', 'pdu', 'gpu', 'hba', 'nic-speed', 'nic-models', 'rma', 'bm-storage', 'part-faults',
      'bm-usage', 'corp-usage', 'power-total'],
  },
  {
    id: 'network', label: '네트워크', icon: '🌐',
    tools: ['net-check', 'net-traffic', 'net-issues', 'nsx', 'ipam', 'vm-dns', 'dupip', 'relaytopo',
      'relaycheck', 'link-check', 'comm-map', 'data-flow', 'device-flow', 'san-switch', 'cvp', 'hba', 'nic-speed', 'nic-models', 'topo3d'],
  },
  {
    id: 'storage', label: '스토리지', icon: '💾',
    tools: ['storage-mon', 'storage-growth', 'storage-track', 'bm-storage', 'san-switch', 'dsusage', 'thinvms',
      'dir-usage', 'portaldb', 'snapshots', 'snapshot-age', 'vm-hygiene', 'storage-paths', 'orphanvmdk', 'guest-disk'],
  },
  {
    id: 'virtualization', label: '가상화', icon: '🧊',
    tools: ['vmfinder', 'vm-track', 'vmtools', 'guestos', 'real-os', 'curuser', 'snapshots', 'vm-clone',
      'vmprovision', 'vm-export', 'esxi', 'host-hygiene', 'cluster-check', 'esxitemp', 'vcversion', 'solutions', 'gpu', 'topo3d'],
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
    tools: ['daily-health', 'insights', 'insights-hub', 'compliance-report', 'change-history', 'unprotected-vms',
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
  // v2.679: 개발 단계·이름 덮어쓰기 — 오류만 여기서 막는다(없는 단계 참조는 경고 — validateStages 참고).
  for (const e of validateStages(cfg).errors) out.push(e);
  return out;
}

/**
 * ⚠ 화면 배치 계산(`buildSections`)은 여기 없다 — `web/src/views/toolSections.js` 가 소유한다.
 * 같은 로직을 서버·웹 양쪽에 두면 어긋나는 날이 온다. 서버는 **저장·검증·프리셋**만 담당하고,
 * '어떤 섹션을 어떤 순서로 그릴지' 는 권한·검색 필터를 이미 적용한 웹이 판단한다.
 */

/* ───────────────────────────────────────────────────────────────────────────
 * v2.679 — 기능별 표시 이름·설명 덮어쓰기 + '개발 단계' 축(사용자 제공 핸드오프 '특수 기능 화면 재구성').
 *
 *  - 덮어쓰는 것은 **화면에 보이는 이름·설명·단계뿐**이다. 기능 키(`#/tools/<k>`)·권한 키·사용 횟수
 *    집계(/tool-usage)는 키 기준 그대로다 — 키를 바꾸면 permissions.json·toolAccess 집행이 깨진다.
 *  - 단계 목록은 **업그레이드로 자동으로 생기지 않는다**(stages:null = 단계 UI 숨김, 전부 기본 단계).
 *    관리자가 '개발 단계 사용 시작' 을 눌러야 DEFAULT_STAGES 가 들어간다(업그레이드만으로 화면이 바뀌면 안 된다).
 *  - 첫 단계([0])가 기본값이다 — 덮어쓰기가 없는 기능, 지워진 단계를 가리키던 기능이 그리로 간다.
 * ─────────────────────────────────────────────────────────────────────────── */

export const MAX_STAGES = 12;
export const MAX_DESC = 300;
export const MAX_OVERRIDES = 400;
/** 단계 색 팔레트 — 이 밖의 색은 받지 않는다(임의 CSS 문자열이 style 로 들어가지 않게). */
export const STAGE_COLORS = Object.freeze(['#22c55e', '#22d3ee', '#f59e0b', '#a855f7', '#3b82f6', '#ef4444', '#8b9bb4']);
export const STAGE_DISPLAYS = Object.freeze(['badge', 'suffix']);
export const DEFAULT_STAGES = Object.freeze([
  Object.freeze({ id: 'prod', label: '운영', color: '#22c55e' }),
  Object.freeze({ id: 'verify', label: '검증 중', color: '#22d3ee' }),
  Object.freeze({ id: 'dev', label: '개발중', color: '#f59e0b' }),
  Object.freeze({ id: 'plan', label: '준비 중', color: '#8b9bb4' }),
]);

/** 단계 1건 정규화 — 형식이 틀린 id 는 `stage<n>`, 팔레트 밖 색은 팔레트 첫 색. */
export function normStage(s, i = 0) {
  const rawId = String(s?.id || '').trim().toLowerCase();
  const id = CAT_ID_RE.test(rawId) ? rawId : `stage${i + 1}`;
  const color = STAGE_COLORS.includes(String(s?.color || '').toLowerCase()) ? String(s.color).toLowerCase() : STAGE_COLORS[i % STAGE_COLORS.length];
  return { id, label: clean(s?.label, MAX_LABEL) || id, color };
}

/** 단계 목록 정규화 — 배열이 아니면 null(= 단계 축을 쓰지 않음). 같은 id 는 뒤의 것을 버린다. */
export function normStages(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const [i, s] of list.slice(0, MAX_STAGES).entries()) {
    const n = normStage(s, i);
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out.length ? out : null;
}

/**
 * 기능 1건의 덮어쓰기 정규화. 빈 문자열은 **키를 지운다**(비우면 원래 값으로 돌아간다).
 * 남는 필드가 없으면 null(= 덮어쓰기 없음 — 저장하지 않는다).
 */
export function normOverride(o) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  const label = clean(o.label, MAX_LABEL);
  if (label) out.label = label;
  // 설명은 줄바꿈도 제어문자라 지워진다 — 카드 설명은 2줄 clamp 한 단락이다.
  const desc = clean(o.desc, MAX_DESC);
  if (desc) out.desc = desc;
  const stage = String(o.stage ?? '').trim().toLowerCase();
  if (stage && CAT_ID_RE.test(stage)) out.stage = stage;
  return Object.keys(out).length ? out : null;
}

/** 덮어쓰기 맵 정규화 — 키 형식이 틀린 항목·빈 항목을 버리고 상한을 지킨다. */
export function normOverrides(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  let n = 0;
  for (const [rawK, v] of Object.entries(map)) {
    const k = String(rawK || '').trim().toLowerCase();
    if (!TOOL_KEY_RE.test(k)) continue;
    const o = normOverride(v);
    if (!o) continue;
    out[k] = o;
    if (++n >= MAX_OVERRIDES) break;
  }
  return out;
}

/**
 * 지워진 단계를 가리키는 덮어쓰기의 stage 를 지운다(그 기능은 기본 단계로 간다). 순수 — 새 객체를 돌려준다.
 * stages 가 null(단계 축 꺼짐)이면 손대지 않는다 — 다시 켰을 때 예전 배치가 돌아오게.
 */
export function pruneStageRefs(overrides, stages) {
  const out = {};
  let cleared = 0;
  if (!Array.isArray(stages)) return { overrides: { ...(overrides || {}) }, cleared };
  const ids = new Set(stages.map((s) => s.id));
  for (const [k, o] of Object.entries(overrides || {})) {
    if (o.stage && !ids.has(o.stage)) {
      const { stage: _drop, ...rest } = o;
      cleared++;
      if (Object.keys(rest).length) out[k] = rest;
    } else out[k] = o;
  }
  return { overrides: out, cleared };
}

/** 단계·덮어쓰기 검사 — { errors, warnings }. 없는 단계를 가리키는 덮어쓰기는 **경고만**(화면은 기본 단계로 본다). */
export function validateStages(cfg) {
  const errors = [];
  const warnings = [];
  const st = cfg?.stages;
  if (st != null && !Array.isArray(st)) errors.push('개발 단계 목록 형식이 올바르지 않습니다.');
  const stages = Array.isArray(st) ? st : [];
  if (stages.length > MAX_STAGES) errors.push(`개발 단계는 최대 ${MAX_STAGES}개까지입니다.`);
  const ids = [];
  for (const [i, s] of stages.entries()) {
    const id = String(s?.id || '').trim().toLowerCase();
    if (!CAT_ID_RE.test(id)) errors.push(`단계 ${i + 1}: id 는 영소문자·숫자·하이픈만 쓸 수 있습니다.`);
    if (!clean(s?.label, MAX_LABEL)) errors.push(`단계 ${i + 1}: 이름을 입력하세요.`);
    if (s?.color != null && !STAGE_COLORS.includes(String(s.color).toLowerCase())) errors.push(`단계 ${i + 1}: 색은 정해진 팔레트에서만 고를 수 있습니다.`);
    ids.push(id);
  }
  if (new Set(ids).size !== ids.length) errors.push('개발 단계 id 가 중복되었습니다.');
  const ov = cfg?.overrides;
  if (ov != null && (typeof ov !== 'object' || Array.isArray(ov))) errors.push('이름·설명 덮어쓰기 형식이 올바르지 않습니다.');
  else if (ov && Object.keys(ov).length > MAX_OVERRIDES) errors.push(`이름·설명을 바꾼 기능은 최대 ${MAX_OVERRIDES}개까지입니다.`);
  if (cfg?.stageDisplay != null && !STAGE_DISPLAYS.includes(cfg.stageDisplay)) errors.push('단계 표시 방식은 badge 또는 suffix 입니다.');
  if (Array.isArray(st) && ov && typeof ov === 'object') {
    const known = new Set(ids);
    const dangling = Object.entries(ov).filter(([, o]) => o?.stage && !known.has(String(o.stage).toLowerCase())).map(([k]) => k);
    if (dangling.length) warnings.push(`없는 단계를 가리키는 기능 ${dangling.length}개는 기본 단계로 옮겼습니다.`);
  }
  return { errors, warnings };
}
