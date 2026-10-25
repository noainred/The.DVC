/**
 * 보안 자세(Security Posture) — 수집된 ESXi/vCenter 빌드 버전을 내장 VMSA 권고 + 수명(EOL)
 * 데이터셋과 대조해 패치 누락/지원종료를 식별한다. 외부 조회 없이 동작하도록 큐레이트된
 * 내장 데이터셋을 사용하며, 운영자가 주기적으로 갱신할 수 있게 dataset 메타를 노출한다.
 *
 * 빌드 번호는 정수 비교(build <= maxAffectedBuild → 취약). EOL은 버전 라인 기준.
 * ⚠️ 내장 데이터셋은 참고용이며 실제 패치 판단 전 VMware 공식 VMSA 확인 권장.
 */

const DATASET_DATE = '2026-06-01';

// 제품 버전 라인 수명(End of General Support). asOf 기준 지났으면 EOL.
const LIFECYCLE = [
  { product: 'esxi', line: '6.5', eogs: '2022-10-15' },
  { product: 'esxi', line: '6.7', eogs: '2022-10-15' },
  { product: 'esxi', line: '7.0', eogs: '2025-04-02' },
  { product: 'esxi', line: '8.0', eogs: '2027-10-11' },
  { product: 'vcenter', line: '6.5', eogs: '2022-10-15' },
  { product: 'vcenter', line: '6.7', eogs: '2022-10-15' },
  { product: 'vcenter', line: '7.0', eogs: '2025-04-02' },
  { product: 'vcenter', line: '8.0', eogs: '2027-10-11' },
];

// 주요 VMSA 권고(큐레이트). maxAffectedBuild 이하 빌드는 취약 → fixedBuild로 업데이트 필요.
const ADVISORIES = [
  { id: 'VMSA-2024-0019', product: 'esxi', line: '8.0', cve: 'CVE-2024-37085', severity: 'critical', maxAffectedBuild: 23305545, fixedBuild: 23825572, fix: 'ESXi 8.0 U3', note: 'AD 통합 인증 우회(도메인 가입 호스트)' },
  { id: 'VMSA-2024-0006', product: 'esxi', line: '8.0', cve: 'CVE-2024-22252', severity: 'critical', maxAffectedBuild: 23299997, fixedBuild: 23305545, fix: 'ESXi 8.0 U2b', note: 'XHCI USB use-after-free → 게스트탈출' },
  { id: 'VMSA-2023-0023', product: 'esxi', line: '8.0', cve: 'CVE-2023-34048', severity: 'critical', maxAffectedBuild: 22380479, fixedBuild: 22380479, fix: 'ESXi 8.0 U1d', note: 'DCERPC OOB write(원격코드실행)' },
  { id: 'VMSA-2024-0019', product: 'esxi', line: '7.0', cve: 'CVE-2024-37085', severity: 'critical', maxAffectedBuild: 23299997, fixedBuild: 23794027, fix: 'ESXi 7.0 U3r', note: 'AD 통합 인증 우회' },
  { id: 'VMSA-2024-0012', product: 'vcenter', line: '8.0', cve: 'CVE-2024-37079', severity: 'critical', maxAffectedBuild: 23319993, fixedBuild: 23929136, fix: 'vCenter 8.0 U2d', note: 'DCERPC 힙 오버플로(원격코드실행)' },
  { id: 'VMSA-2023-0023', product: 'vcenter', line: '8.0', cve: 'CVE-2023-34048', severity: 'critical', maxAffectedBuild: 22385739, fixedBuild: 22617221, fix: 'vCenter 8.0 U1d', note: 'DCERPC OOB write(원격코드실행)' },
  { id: 'VMSA-2024-0012', product: 'vcenter', line: '7.0', cve: 'CVE-2024-37079', severity: 'critical', maxAffectedBuild: 23788036, fixedBuild: 23848063, fix: 'vCenter 7.0 U3r', note: 'DCERPC 힙 오버플로' },
];

const lineOf = (version) => { const m = /^(\d+\.\d+)/.exec(String(version || '')); return m ? m[1] : null; };
// v2.783(점검 Q4 P-B2): 빌드 0·음수는 못 읽은 값이다('못 읽은 값은 0 이 아니다' — 권고 대조에서 '가장 오래된 빌드' 로 읽지 않는다).
const buildInt = (build) => { const n = parseInt(String(build ?? '').replace(/\D/g, ''), 10); return Number.isFinite(n) && n > 0 ? n : null; };

/*
 * v2.783(점검 Q4 P-B2): '평가하지 못함' 은 정상이 아니다. 예전에는 ① 버전을 못 읽었거나(REST 폴백 vCenter 의 'unknown') ② 빌드를 못 읽었거나
 *   ③ 수명 데이터셋 밖 라인(6.0·9.0)이면 worst 'ok' 로 남아 녹색 '정상' KPI 에 들어갔다(빌드를 못 읽은 8.0 호스트는 권고 3건 대조를 건너뛰고 정상).
 *   이제 worst 'unknown' + unknownReason. 아는 사실(수명 데이터로 EOL 확정·권고 해당)이 있으면 그것이 이긴다.
 */
function assess(product, version, build, asOf) {
  const line = lineOf(version);
  const b = buildInt(build);
  const result = { product, version: version ?? null, build: build ?? null, line, eol: false, eolDate: null, advisories: [], worst: 'ok' };
  if (!line) return { ...result, worst: 'unknown', unknownReason: '버전 미상' };
  const lc = LIFECYCLE.find((x) => x.product === product && x.line === line);
  if (lc && Date.parse(lc.eogs) < asOf) { result.eol = true; result.eolDate = lc.eogs; result.worst = 'critical'; }
  if (lc) result.eolDate = result.eolDate || lc.eogs;
  if (b != null) {
    for (const a of ADVISORIES) {
      if (a.product !== product || a.line !== line) continue;
      if (b <= a.maxAffectedBuild) result.advisories.push({ id: a.id, cve: a.cve, severity: a.severity, fix: a.fix, fixedBuild: a.fixedBuild, note: a.note });
    }
  }
  if (result.advisories.some((a) => a.severity === 'critical')) result.worst = 'critical';
  else if (result.advisories.length) result.worst = result.worst === 'critical' ? 'critical' : 'warning';
  if (result.worst === 'ok') {
    if (!lc) { result.worst = 'unknown'; result.unknownReason = '데이터셋 밖 버전 라인'; }
    else if (b == null) { result.worst = 'unknown'; result.unknownReason = '빌드 미상'; }
  }
  return result;
}

/** 내장 데이터셋 사본(테스트·진단용 — 무결성 검사가 읽는다). */
export function cveDataset() {
  return { date: DATASET_DATE, advisories: ADVISORIES.map((a) => ({ ...a })), lifecycle: LIFECYCLE.map((l) => ({ ...l })) };
}

export function computeSecurityPosture(snap) {
  const asOf = Date.now();
  const hosts = [];
  // v2.783(P-B2): 버전을 못 읽은 호스트·vCenter 도 버리지 않는다 — 미확인으로 센다(조용히 빠지면 total 도 줄어 '전부 봤다' 로 읽힌다).
  for (const h of snap.hosts || []) {
    const a = assess('esxi', h.version, h.build, asOf);
    hosts.push({ id: h.id, name: h.name, vcenterId: h.vcenterId, cluster: h.cluster, ...a });
  }
  const vcenters = [];
  for (const v of snap.vcenters || []) {
    const a = assess('vcenter', v.version, v.build, asOf);
    vcenters.push({ id: v.id, name: v.name || v.id, ...a });
  }
  const all = [...hosts, ...vcenters];
  const summary = {
    total: all.length,
    critical: all.filter((x) => x.worst === 'critical').length,
    warning: all.filter((x) => x.worst === 'warning').length,
    ok: all.filter((x) => x.worst === 'ok').length,
    unknown: all.filter((x) => x.worst === 'unknown').length, // v2.783(P-B2): 정상과 따로
    eol: all.filter((x) => x.eol).length,
  };
  return {
    dataset: { date: DATASET_DATE, advisories: ADVISORIES.length, lifecycleLines: LIFECYCLE.length },
    summary,
    vcenters: vcenters.sort((a, b) => rank(b.worst) - rank(a.worst)),
    hosts: hosts.sort((a, b) => rank(b.worst) - rank(a.worst)).slice(0, 2000),
    generatedAt: asOf,
  };
}
const rank = (w) => (w === 'critical' ? 3 : w === 'warning' ? 2 : w === 'unknown' ? 1 : 0); // v2.783(P-B2): 미확인은 정상보다 앞
