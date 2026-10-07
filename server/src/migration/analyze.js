/**
 * migration/analyze.js — 특수 기능 'VM 이전 준비도'(도구 키 `migration-readiness`, v2.707 — C7) 판정(순수).
 * 입력은 스냅샷 VM(하드웨어 버전·Tools·GPU·스냅샷)과 B10 이 읽어 둔 구성·장치(vm.cfg·vm.dev). vCenter 왕복 0.
 *
 * '이전' 은 다른 클러스터·vCenter·클라우드로 옮기는 일반적인 경우다(대상 플랫폼별 세부 조건은 다르다 — 화면이 말한다).
 * 정직 규칙
 *  · 구성·장치를 아직 읽지 않은 VM 은 '준비됨' 이 아니라 '판정 불가(미수집)' 다 — 막는 요인이 장치에 있을 수 있다.
 *    단, 이미 읽은 값만으로 '막힘' 이 확실하면 막힘으로 센다(막힘은 미수집이어도 사실이다).
 *  · 등급: blocked(이대로는 옮길 수 없다 — 먼저 조치) > caution(옮길 수 있지만 준비·확인이 필요) > ready > unknown.
 *  · 판정 근거(코드)를 함께 싣는다 — 문구는 웹이 같은 키로 만든다(1:1 테스트).
 */
import { TOOLS_NEED_UPGRADE } from '../reports/compliance.js';
export const MIG_CODES = Object.freeze({
  // blocked
  'rdm-physical': 'blocked',       // 물리 호환 RDM — 디스크를 그대로 옮길 수 없다(가상 디스크로 바꾸거나 LUN 을 대상에 다시 매핑)
  'multi-writer': 'blocked',       // 다중 쓰기 공유 디스크(클러스터 공유) — 한 VM 만 옮기면 공유가 깨진다
  'gpu-passthrough': 'blocked',    // PCI 패스스루 GPU — 대상에 같은 장치가 있어야 하고 실시간 이전 불가
  'question': 'blocked',           // 응답 대기 질문 — VM 이 멈춰 있다
  'consolidation': 'blocked',      // 디스크 통합 필요 — 먼저 통합
  // caution
  'vgpu': 'caution',               // vGPU — 대상 호스트에 같은 프로파일 자원 필요
  'snapshots': 'caution',          // 스냅샷 있음 — 옮기기 전에 정리 권장(체인 크기만큼 시간·공간)
  'usb': 'caution',                // USB 장치 연결 — 호스트 USB 면 옮긴 뒤 끊긴다
  'serial-parallel': 'caution',    // 직렬·병렬 포트 — 호스트 장치·네트워크 백킹 확인
  'cdrom-connected': 'caution',    // 연결된 CD/DVD — 호스트 장치·ISO 경로가 대상에 없을 수 있다
  'disk-independent': 'caution',   // 독립 디스크 — 스냅샷 기반 이전·백업 도구에서 빠질 수 있다
  'disk-nonpersistent': 'caution', // 비영구 디스크 — 전원을 끄면 변경이 사라진다
  'hw-old': 'caution',             // 오래된 가상 하드웨어 버전(vmx-10 미만)
  'tools-missing': 'caution',      // VMware Tools 없음·미실행 — 이전 후 게스트 확인·정상 종료가 어렵다
  'tools-old': 'caution',          // Tools 오래됨
  'managed': 'caution',            // 솔루션이 관리하는 VM(복제·백업 어플라이언스 등) — 그 솔루션 절차로 옮겨야 한다
  'reservation': 'caution',        // CPU·메모리 예약 — 대상에 그만큼 여유가 있어야 한다
});
export const MIG_LEVELS = Object.freeze(['blocked', 'caution', 'unknown', 'ready']);
export const ROWS_MAX = 2000;
const HW_MIN = 10;

const hwNum = (hw) => { const m = /vmx-(\d+)/.exec(String(hw || '')); return m ? Number(m[1]) : null; };

/** VM 하나 — { level, findings:[{code, level, facts}], collected:{cfg,dev} } */
export function migrationOf(vm) {
  const out = [];
  const add = (code, facts = {}) => out.push({ code, level: MIG_CODES[code], facts });
  const c = vm?.cfg && typeof vm.cfg === 'object' ? vm.cfg : null;
  const d = vm?.dev && typeof vm.dev === 'object' ? vm.dev : null;
  const g = vm?.gpu && typeof vm.gpu === 'object' ? vm.gpu : null;
  if (g?.type === 'passthrough') add('gpu-passthrough', { model: g.model || null, count: g.count ?? null });
  else if (g?.type === 'vgpu') add('vgpu', { profile: g.profile || null });
  if ((vm?.snapshotCount || 0) > 0) add('snapshots', { count: vm.snapshotCount, sizeGB: vm.snapshotSizeGB ?? null });
  const hw = hwNum(vm?.hwVersion);
  if (hw != null && hw < HW_MIN) add('hw-old', { hw: vm.hwVersion });
  const ts = String(vm?.toolsStatus || '');
  const tv = String(vm?.toolsVersionStatus || '');
  if (vm?.powerState === 'POWERED_ON' && (/notInstalled/i.test(tv) || /NOT_RUNNING|NOT_INSTALLED/i.test(ts))) add('tools-missing', { status: ts || tv });
  // v2.719(감사 B1-07): guestToolsTooOld·Blacklisted 도 업그레이드 필요다(규정 준수 리포트와 같은 집합).
  else if (TOOLS_NEED_UPGRADE.includes(tv) || /OUTDATED|NeedUpgrade|Unsupported/i.test(ts + ' ' + tv)) add('tools-old', { status: tv || ts });
  if (c) {
    if (c.question) add('question', { text: c.question.text || null });
    if (c.consolidationNeeded === true) add('consolidation');
    if (c.managedBy && (c.managedBy.extensionKey || c.managedBy.type)) add('managed', { ...c.managedBy });
    if ((c.cpuReservationMhz || 0) > 0 || (c.memReservationMB || 0) > 0) add('reservation', { cpuMhz: c.cpuReservationMhz, memMB: c.memReservationMB });
  }
  if (d) {
    const disks = Array.isArray(d.disks) ? d.disks : [];
    const rdmP = disks.filter((x) => x?.rdm && /physical/i.test(x?.rdmMode || ''));
    if (rdmP.length) add('rdm-physical', { count: rdmP.length });
    const mw = disks.filter((x) => /multiwriter/i.test(x?.sharing || ''));
    if (mw.length) add('multi-writer', { count: mw.length });
    const indep = disks.filter((x) => /^independent_persistent$/i.test(x?.mode || ''));
    if (indep.length) add('disk-independent', { count: indep.length });
    const nonp = disks.filter((x) => /nonpersistent/i.test(x?.mode || ''));
    if (nonp.length) add('disk-nonpersistent', { count: nonp.length });
    if ((d.usb || 0) > 0) add('usb', { count: d.usb });
    if ((d.serial || 0) + (d.parallel || 0) > 0) add('serial-parallel', { serial: d.serial || 0, parallel: d.parallel || 0 });
    const cds = (d.cdroms || []).filter((x) => x?.connected === true);
    if (cds.length) add('cdrom-connected', { count: cds.length, host: cds.filter((x) => x.host).length });
  }
  const rank = { blocked: 0, caution: 1 };
  out.sort((a, b) => rank[a.level] - rank[b.level] || a.code.localeCompare(b.code));
  let level;
  if (out.some((f) => f.level === 'blocked')) level = 'blocked';
  else if (!c || !d) level = 'unknown';
  else level = out.length ? 'caution' : 'ready';
  return { level, findings: out, collected: { cfg: !!c, dev: !!d } };
}

/**
 * @param vms   스냅샷 VM(범위로 이미 거른 것)
 * @param opts  { q, level, code, vcName:Map, by:'vcenter'|'cluster' }
 */
export function analyzeMigration(vms, { q = '', level = '', code = '', vcName = new Map(), by = 'vcenter' } = {}) {
  const counts = { blocked: 0, caution: 0, unknown: 0, ready: 0 };
  const byCode = Object.fromEntries(Object.keys(MIG_CODES).map((k) => [k, 0]));
  const groups = new Map();
  const rows = [];
  let templates = 0; let gb = 0;
  for (const v of vms || []) {
    if (v.template) { templates += 1; continue; }
    const m = migrationOf(v);
    counts[m.level] += 1;
    for (const f of m.findings) byCode[f.code] += 1;
    const gk = by === 'cluster' ? `${v.vcenterId}\u0000${v.cluster || ''}` : v.vcenterId;
    const g = groups.get(gk) || { key: gk, vcenterId: v.vcenterId, vcenterName: vcName.get(v.vcenterId) || v.vcenterId, cluster: by === 'cluster' ? v.cluster || '(클러스터 없음)' : null, vms: 0, blocked: 0, caution: 0, unknown: 0, ready: 0, storageGB: 0 };
    g.vms += 1; g[m.level] += 1;
    if (Number.isFinite(v.storageGB)) { g.storageGB += v.storageGB; gb += v.storageGB; }
    groups.set(gk, g);
    rows.push({
      id: v.id, name: v.name, vcenterId: v.vcenterId, vcenterName: g.vcenterName, cluster: v.cluster || '', powerState: v.powerState,
      cpuCount: v.cpuCount ?? null, memMB: v.memMB ?? null, storageGB: Number.isFinite(v.storageGB) ? v.storageGB : null, hwVersion: v.hwVersion || null,
      level: m.level, findings: m.findings, collected: m.collected,
    });
  }
  const qq = String(q || '').toLowerCase();
  let shown = rows;
  if (MIG_LEVELS.includes(level)) shown = shown.filter((r) => r.level === level);
  if (code && Object.hasOwn(MIG_CODES, code)) shown = shown.filter((r) => r.findings.some((f) => f.code === code));
  if (qq) shown = shown.filter((r) => [r.name, r.vcenterName, r.cluster].some((x) => String(x || '').toLowerCase().includes(qq)));
  const lr = { blocked: 0, caution: 1, unknown: 2, ready: 3 };
  shown.sort((a, b) => lr[a.level] - lr[b.level] || b.findings.length - a.findings.length || String(a.name).localeCompare(String(b.name)));
  const total = counts.blocked + counts.caution + counts.unknown + counts.ready;
  // v2.721(감사 B1-02): 그룹 준비율도 전체와 같은 분모(판정한 VM — 미수집 제외)다. vms 로 나누면 미수집이 많은 법인이
  // 전체 KPI 100% 인데 표에서는 25% 로 '준비 안 됨' 처럼 보였다. 판정한 VM 이 0 이면 null.
  const groupRows = [...groups.values()].map((g) => ({ ...g, readyPct: g.vms - g.unknown > 0 ? Math.round((g.ready / (g.vms - g.unknown)) * 1000) / 10 : null }))
    .sort((a, b) => b.blocked - a.blocked || b.caution - a.caution || String(a.vcenterName).localeCompare(String(b.vcenterName)));
  return {
    codes: MIG_CODES, counts, total, templates, storageGB: gb,
    // 준비율의 분모는 판정한 VM(미수집 제외) — 미수집을 분모에 넣으면 '준비 안 됨' 처럼 보인다.
    readyPct: total - counts.unknown > 0 ? Math.round((counts.ready / (total - counts.unknown)) * 1000) / 10 : null,
    byCode, groups: groupRows.slice(0, 500), groupsOmitted: Math.max(0, groupRows.length - 500),
    matched: shown.length, vms: shown.slice(0, ROWS_MAX), omitted: Math.max(0, shown.length - ROWS_MAX),
  };
}
