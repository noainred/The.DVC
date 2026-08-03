/**
 * 버전/패치 준수 리포트 — VMware Tools 상태·VM 하드웨어 버전·ESXi 버전 분포를 스냅샷만으로
 * 집계한다. toolsStatus(RUNNING/NOT_RUNNING)가 아니라 toolsVersionStatus(guestToolsNeedUpgrade
 * 등)를 쓰는 것이 핵심 — 실환경 SOAP 수집에 OUTDATED 상태가 없기 때문(CLAUDE 조사 참조).
 */

// vSphere 릴리스 지원 상태(내장 데이터셋, insights/cve.js와 같은 접근).
// 기준일: General Support 종료일(Broadcom lifecycle). 판정은 순수 함수라 테스트 가능.
const ESXI_EOL = [
  { prefix: '5.', label: 'ESXi 5.x', eol: '2018-09-19' },
  { prefix: '6.0', label: 'ESXi 6.0', eol: '2020-03-12' },
  { prefix: '6.5', label: 'ESXi 6.5', eol: '2022-10-15' },
  { prefix: '6.7', label: 'ESXi 6.7', eol: '2022-10-15' },
  { prefix: '7.0', label: 'ESXi 7.0', eol: '2025-10-02' },
  { prefix: '8.0', label: 'ESXi 8.0', eol: '2027-10-11' },
];

export function esxiSupportStatus(version, now = Date.now()) {
  const v = String(version || '');
  const hit = ESXI_EOL.find((e) => v.startsWith(e.prefix));
  if (!hit) return { status: 'unknown', eol: null };
  const eolTs = Date.parse(hit.eol);
  if (now >= eolTs) return { status: 'eol', eol: hit.eol };
  if (now >= eolTs - 180 * 86_400_000) return { status: 'ending', eol: hit.eol }; // 6개월 내 종료
  return { status: 'supported', eol: hit.eol };
}

/** 'vmx-13' → 13. 파싱 불가 시 null. */
export function hwVersionNum(hwVersion) {
  const m = /vmx-(\d+)/i.exec(String(hwVersion || ''));
  return m ? Number(m[1]) : null;
}

const TOOLS_LABEL = {
  guestToolsCurrent: '최신',
  guestToolsNeedUpgrade: '업그레이드 필요',
  guestToolsSupportedOld: '구버전(지원)',
  guestToolsSupportedNew: '신버전',
  guestToolsTooOld: '너무 오래됨',
  guestToolsTooNew: '너무 최신',
  guestToolsBlacklisted: '결함 버전(블랙리스트)',
  guestToolsUnmanaged: '자체 관리(open-vm-tools)',
  guestToolsNotInstalled: '미설치',
};

export function computeCompliance(snap, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const oldHwMax = Number(opts.oldHwMax) || 13; // vmx-13 이하를 '구버전'으로 표시
  const vms = (snap.vms || []).filter((v) => !v.template);
  const hosts = snap.hosts || [];

  // ① VMware Tools 상태 분포 + 업그레이드 필요 목록
  const toolsDist = new Map();
  const needUpgrade = [];
  for (const v of vms) {
    const st = v.toolsVersionStatus || (v.toolsStatus === 'RUNNING' ? 'guestToolsCurrent' : 'guestToolsNotInstalled');
    toolsDist.set(st, (toolsDist.get(st) || 0) + 1);
    if (['guestToolsNeedUpgrade', 'guestToolsTooOld', 'guestToolsBlacklisted'].includes(st) && needUpgrade.length < 500) {
      needUpgrade.push({ id: v.id, name: v.name, vcenterId: v.vcenterId, toolsVersion: v.toolsVersion || '', status: st, powerState: v.powerState });
    }
  }

  // ② VM 하드웨어 버전 분포 + 구버전 목록
  const hwDist = new Map();
  const oldHw = [];
  for (const v of vms) {
    const hv = v.hwVersion || '(미수집)';
    hwDist.set(hv, (hwDist.get(hv) || 0) + 1);
    const n = hwVersionNum(v.hwVersion);
    if (n != null && n <= oldHwMax && oldHw.length < 500) {
      oldHw.push({ id: v.id, name: v.name, vcenterId: v.vcenterId, hwVersion: v.hwVersion, powerState: v.powerState });
    }
  }

  // ③ ESXi 버전/빌드 분포 + 지원 종료 상태
  const esxiDist = new Map();
  for (const h of hosts) {
    const key = `${h.version || '?'} (build ${h.build || '?'})`;
    const e = esxiDist.get(key) || { version: h.version || '?', build: h.build || '?', count: 0, ...esxiSupportStatus(h.version, now) };
    e.count++;
    esxiDist.set(key, e);
  }
  const esxi = [...esxiDist.values()].sort((a, b) => b.count - a.count);
  const distOf = (m, label) => [...m.entries()].map(([k, count]) => ({ key: k, label: label ? (label[k] || k) : k, count })).sort((a, b) => b.count - a.count);

  return {
    config: { oldHwMax },
    summary: {
      vms: vms.length, hosts: hosts.length,
      toolsNeedUpgrade: needUpgrade.length,
      oldHwVms: oldHw.length,
      eolHosts: hosts.filter((h) => esxiSupportStatus(h.version, now).status === 'eol').length,
      endingHosts: hosts.filter((h) => esxiSupportStatus(h.version, now).status === 'ending').length,
    },
    tools: { dist: distOf(toolsDist, TOOLS_LABEL), needUpgrade },
    hwVersion: { dist: distOf(hwDist), old: oldHw },
    esxi,
  };
}
