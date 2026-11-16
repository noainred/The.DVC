// VMware Tools 버전 분포(`/tools/vmtools`) — 순수 집계.
// 전체 점검 32회차 F1 · F3(재현):
//  · '오래됨' 은 예전에 `toolsStatus === 'OUTDATED'` 로 셌는데 그 값은 목 생성기만 만든다 — 실 SOAP 수집은 RUNNING/NOT_RUNNING 둘뿐이라
//    실환경에서 늘 0 이었다(VM 드로어 '오래된 Tools' 신호로 이 화면에 와도 0). 이제 VM 신호 · 이전 준비도 · 준수 리포트와 같은 집합
//    (`TOOLS_NEED_UPGRADE` — toolsVersionStatus)으로 센다. 칸은 서로 겹치지 않는다: 오래됨 → 정상(실행 중) → 실행 안 함 → 미수집.
//  · REST 폴백 수집 VM 은 Tools 필드를 읽지 않는다 — 예전에는 버전 '없음'(미설치로 읽힘) · 실행 안 함으로 셌다(못 읽은 값은 0 이 아니다).
//    둘 다 없으면 '미수집' 행으로 따로 세고 업그레이드 대상에서 뺀다.
//  · 업그레이드 id 는 켜진 VM · 템플릿 아님만 담고(꺼진 VM · 템플릿은 실패로 돌아온다), 상한을 넘으면 그 사실(idsTruncated)과 전체 대상 수(upgradable)를 싣는다
//    — 확인 창이 'VM N대' 라고 묻고 앞 2,000개만 보내던 것을 화면이 실제로 보낼 수로 묻게.
import { TOOLS_NEED_UPGRADE } from '../reports/compliance.js';

export const TOOLS_IDS_MAX = 2000;
export const TOOLS_UNREAD_VERSION = '(수집 안 됨)';
const OLD = new Set(TOOLS_NEED_UPGRADE);

/** 이 VM 의 Tools 를 읽었는가 — 상태 · 버전 둘 다 없으면 못 읽음(REST 폴백 등). '' 는 SOAP 이 읽은 '버전 없음'. */
export function toolsRead(v) {
  return v?.toolsStatus != null || v?.toolsVersion != null || v?.toolsVersionStatus != null;
}

export function vmToolsDistribution(vms) {
  const map = new Map();
  for (const v of Array.isArray(vms) ? vms : []) {
    if (!v || typeof v !== 'object') continue;
    const read = toolsRead(v);
    const ver = read ? (v.toolsVersion || '없음') : TOOLS_UNREAD_VERSION;
    if (!map.has(ver)) map.set(ver, { version: ver, unread: !read, count: 0, running: 0, outdated: 0, notRunning: 0, unknown: 0, upgradable: 0, ids: [], idsTruncated: false });
    const e = map.get(ver);
    e.count++;
    if (!read) { e.unknown++; continue; }
    const old = v.template !== true && (OLD.has(v.toolsVersionStatus) || v.toolsStatus === 'OUTDATED');   // 'OUTDATED' 는 목 데이터 호환
    if (old) e.outdated++;
    else if (v.toolsStatus === 'RUNNING') e.running++;
    else e.notRunning++;
    if (v.powerState === 'POWERED_ON' && v.template !== true) {
      e.upgradable++;
      if (e.ids.length < TOOLS_IDS_MAX) e.ids.push(v.id); else e.idsTruncated = true;
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}
