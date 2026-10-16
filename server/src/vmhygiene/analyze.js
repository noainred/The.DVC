/**
 * vmhygiene/analyze.js — 특수 기능 'VM 구성 점검'(도구 키 `vm-hygiene`, v2.698) 판정(순수).
 * 입력은 스냅샷 VM 배열(vm.cfg·vm.dev = v2.697 B10 캐시 + 스냅샷·Tools 필드)과 설정(vmhygiene/settings.js).
 * vCenter 왕복 0.
 *
 * 판정 = B10 `vmCfgFindings`(구성·장치) + 이 모듈의 코드(스냅샷 정책·유령 스냅샷·Tools 미설치·장기 미재부팅).
 * 코드 → 심각도는 `HYGIENE_CODES`, 화면 문구는 웹 `views/vmcfg/vmHygieneText.js` 가 같은 키로 소유한다(1:1 테스트).
 *
 * 정직 규칙
 *  · cfg·dev 가 없는 VM 은 그 축을 판정하지 않고 '미수집' 으로 센다(coverage). 빈 결과를 '이상 없음' 이라 말하지 않는다.
 *  · 템플릿은 판정 대상이 아니다(전원·Tools·스냅샷 정책이 뜻이 없다) — 개수만 센다.
 *  · 스냅샷 생성일을 모르면(oldestTs null) 나이 판정을 하지 않는다(0일로 보지 않는다).
 *  · 예외 목록에 걸린 VM 은 스냅샷 정책만 빼고 개수를 밝힌다(조용한 제외 금지).
 */
import { vmCfgFindings, VM_CFG_CODES } from '../vmcfg/parse.js';

export const HYGIENE_CODES = Object.freeze({
  'snap-age': 'warn',
  'snap-count': 'warn',
  'snap-size': 'warn',
  'snap-orphan-delta': 'warn',
  'tools-missing': 'warn',
  'uptime-long': 'info',
});
export const ALL_CODES = Object.freeze({ ...VM_CFG_CODES, ...HYGIENE_CODES });
const SEV_ORDER = { crit: 0, warn: 1, info: 2 };
export const ROWS_MAX = 2000;
const DAY = 86_400_000;

function exceptedBy(vm, exceptions) {
  if (!exceptions?.length) return null;
  const hay = `${vm.name || ''}\n${vm.notes || ''}`.toLowerCase();
  return exceptions.find((e) => hay.includes(String(e).toLowerCase())) || null;
}

/** VM 하나의 이 모듈 판정(B10 판정은 vmCfgFindings 가 따로). */
export function hygieneFindings(vm, s, now = Date.now()) {
  const out = [];
  const add = (code, facts = {}) => out.push({ code, sev: HYGIENE_CODES[code], facts });
  if (!vm || vm.template === true) return { findings: out, excepted: null };
  const exc = exceptedBy(vm, s.exceptions);
  const cnt = Number.isFinite(vm.snapshotCount) ? vm.snapshotCount : 0;
  if (!exc && cnt > 0) {
    const ageDays = Number.isFinite(vm.snapshotOldestTs) && vm.snapshotOldestTs > 0 ? Math.floor((now - vm.snapshotOldestTs) / DAY) : null;
    if (ageDays != null && ageDays >= s.snapAgeDays) add('snap-age', { days: ageDays, limit: s.snapAgeDays });
    if (cnt > s.snapCount) add('snap-count', { count: cnt, limit: s.snapCount });
    const gb = Number.isFinite(vm.snapshotSizeGB) ? vm.snapshotSizeGB : null;
    if (gb != null && gb > s.snapSizeGB) add('snap-size', { gb, limit: s.snapSizeGB });
  }
  // v2.742(감사 RECENT-03·VC-09): 유령 스냅샷 후보의 근거는 '스냅샷 0개 + 파일 이름이 델타 꼴(-NNNNNN[-delta|-sesparse].vmdk)' 하나뿐이다.
  //   v2.741 VC-01 로 layoutEx 파싱이 처음 실장비에서 동작하게 되면서 이 판정이 처음 켜졌는데, 링크드·인스턴트 클론처럼 자기 디스크가
  //   그 이름 꼴인 정상 VM 을 오탐할 수 있다(실장비 미확인 — 추정). 그래서 같은 VM 의 vCenter '통합 필요'(cfg.consolidationNeeded)가
  //   true 일 때만 주의(warn)로 두고, 그 밖(false·아직 안 읽음)은 참고(info)로 낮춘다 — **빼지 않는다**(통합 필요 false 인 진짜 유령
  //   델타도 있을 수 있다). 근거는 facts.basis('consolidation'|'name-rule')·consolidationNeeded(true|false|null)로 싣고 화면이 말한다.
  //   ⚠ 디스크 백킹의 parent 는 B10 장치 수집(vmcfg/parse.js)이 읽지 않아 근거로 쓰지 않는다(지어내지 않는다).
  if (cnt === 0 && Number.isFinite(vm.orphanDeltaGB) && vm.orphanDeltaGB > 0) {
    const cn = vm.cfg && typeof vm.cfg === 'object' && typeof vm.cfg.consolidationNeeded === 'boolean' ? vm.cfg.consolidationNeeded : null;
    const corroborated = cn === true;
    out.push({ code: 'snap-orphan-delta', sev: corroborated ? HYGIENE_CODES['snap-orphan-delta'] : 'info',
      facts: { gb: vm.orphanDeltaGB, basis: corroborated ? 'consolidation' : 'name-rule', consolidationNeeded: cn } });
  }
  const on = vm.powerState === 'POWERED_ON';
  if (on && vm.toolsVersionStatus === 'guestToolsNotInstalled') add('tools-missing');
  const boot = vm.cfg?.bootTime;
  if (on && Number.isFinite(boot) && boot > 0) {
    const days = Math.floor((now - boot) / DAY);
    if (days >= s.uptimeDays) add('uptime-long', { days, limit: s.uptimeDays });
  }
  return { findings: out, excepted: exc };
}

/**
 * @param {object[]} vms 범위·vCenter 로 이미 거른 VM
 * @param {object} s 설정
 * @param {{ vcName?: Map<string,string>, now?: number, code?: string, sev?: string, q?: string }} opt
 */
export function analyzeVmHygiene(vms, s, opt = {}) {
  const now = opt.now ?? Date.now();
  const vcName = opt.vcName || new Map();
  const coverage = { vms: 0, templates: 0, cfg: 0, dev: 0, notCollected: 0, excepted: 0 };
  const byCode = {};
  for (const [c, sev] of Object.entries(ALL_CODES)) byCode[c] = { sev, vms: 0 };
  const rows = [];
  const byVc = new Map();
  for (const vm of Array.isArray(vms) ? vms : []) {
    if (!vm || typeof vm !== 'object') continue;
    if (vm.template === true) { coverage.templates += 1; continue; }
    coverage.vms += 1;
    const hasCfg = !!(vm.cfg && typeof vm.cfg === 'object');
    const hasDev = !!(vm.dev && typeof vm.dev === 'object');
    if (hasCfg) coverage.cfg += 1;
    if (hasDev) coverage.dev += 1;
    if (!hasCfg && !hasDev) coverage.notCollected += 1;
    const h = hygieneFindings(vm, s, now);
    if (h.excepted) coverage.excepted += 1;
    const findings = [...vmCfgFindings(vm), ...h.findings].sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev]);
    const vcId = vm.vcenterId || '';
    let vc = byVc.get(vcId);
    if (!vc) { vc = { vcenterId: vcId, name: vcName.get(vcId) || vcId, vms: 0, withFindings: 0, crit: 0, warn: 0, notCollected: 0 }; byVc.set(vcId, vc); }
    vc.vms += 1;
    if (!hasCfg && !hasDev) vc.notCollected += 1;
    if (!findings.length) continue;
    vc.withFindings += 1;
    if (findings.some((f) => f.sev === 'crit')) vc.crit += 1;
    else if (findings.some((f) => f.sev === 'warn')) vc.warn += 1;
    for (const f of findings) if (byCode[f.code]) byCode[f.code].vms += 1;
    rows.push({
      id: vm.id, name: vm.name, vcenterId: vcId, vcenterName: vcName.get(vcId) || vcId,
      host: vm.host || '', cluster: vm.cluster || '', powerState: vm.powerState || '',
      worst: findings[0].sev, excepted: h.excepted, findings,
    });
  }
  // 거르기(화면 칩) — 개수(byCode)는 거르기 전 기준이다(고른 칩만 남으면 해제할 수 없다 — v2.645 규약).
  const q = typeof opt.q === 'string' ? opt.q.trim().toLowerCase() : '';
  let shown = rows;
  if (opt.code && ALL_CODES[opt.code]) shown = shown.filter((r) => r.findings.some((f) => f.code === opt.code));
  if (opt.sev && SEV_ORDER[opt.sev] != null) shown = shown.filter((r) => r.findings.some((f) => f.sev === opt.sev));
  if (q) shown = shown.filter((r) => `${r.name} ${r.host} ${r.cluster} ${r.vcenterName}`.toLowerCase().includes(q));
  shown.sort((a, b) => SEV_ORDER[a.worst] - SEV_ORDER[b.worst] || b.findings.length - a.findings.length || String(a.name).localeCompare(String(b.name)));
  const out = {
    coverage,
    byCode,
    vcenters: [...byVc.values()].sort((a, b) => b.crit - a.crit || b.warn - a.warn || String(a.name).localeCompare(String(b.name))),
    total: rows.length,
    matched: shown.length,
    rows: shown.slice(0, ROWS_MAX),
    omitted: Math.max(0, shown.length - ROWS_MAX),
    settings: { snapAgeDays: s.snapAgeDays, snapCount: s.snapCount, snapSizeGB: s.snapSizeGB, uptimeDays: s.uptimeDays, exceptions: s.exceptions },
  };
  // v2.719(감사 B1-05): 알림 요약은 화면 상한(ROWS_MAX)으로 자르기 전의 거른 전체로 센다 — 잘린 rows 로 세면 위반 대수가
  //   과소 보고되고, crit 행이 상한을 채우면 위반 0 으로 읽혀 그날 알림이 아예 나가지 않았다.
  //   응답(JSON)·펼침에 실리지 않게 열거하지 않는 속성으로 둔다.
  Object.defineProperty(out, 'allRows', { value: shown, enumerable: false });
  return out;
}

/**
 * 알림 요약(스냅샷 정책·유령 스냅샷만 — 하루 한 번). 반환 null 이면 보낼 것이 없다.
 * v2.742(RECENT-03): 유령 스냅샷 후보는 **주의(통합 필요가 함께 표시된 것)만** 알린다 — 이름 규칙만 맞는 참고 후보는 화면에만 보인다
 *   (링크드 클론 등 오탐 가능성이 있는 후보로 매일 알림을 보내지 않는다).
 */
export function snapshotPolicySummary(result, limit = 30) {
  const codes = ['snap-age', 'snap-count', 'snap-size', 'snap-orphan-delta'];
  const alerting = (f) => codes.includes(f.code) && !(f.code === 'snap-orphan-delta' && f.sev === 'info');
  const src = Array.isArray(result.allRows) ? result.allRows : result.rows;   // v2.719(B1-05): 상한 전 전체
  const hits = src.filter((r) => r.findings.some(alerting));
  if (!hits.length) return null;
  const lines = hits.slice(0, limit).map((r) => {
    const parts = r.findings.filter(alerting).map((f) => (
      f.code === 'snap-age' ? `${f.facts.days}일` : f.code === 'snap-count' ? `${f.facts.count}개` : f.code === 'snap-size' ? `${f.facts.gb}GB` : `유령 델타 ${f.facts.gb}GB`));
    return `- ${r.name} (${r.vcenterName}) — ${parts.join(' · ')}`;
  });
  const more = hits.length > limit ? `\n… 외 ${hits.length - limit}대` : '';
  const s = result.settings;
  return `스냅샷 정책 위반 ${hits.length}대 (기준: ${s.snapAgeDays}일 · ${s.snapCount}개 · ${s.snapSizeGB}GB, 예외 ${result.coverage.excepted}대 제외)\n${lines.join('\n')}${more}`;
}
