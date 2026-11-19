/**
 * snaphist/record.js — VM 별 스냅샷 이력 DB 에 하루치로 넣을 행을 만든다(순수 — store · DB 를 부르지 않는다).
 *
 * v3.26.0(설계 docs/design/snapshots §5 — 사용자 ‘VM 별 스냅샷 이력 DB 추가’ · ‘기본값대로 구현해’):
 *   · 하루 한 번, **스냅샷이 있는 VM 만** 행이 된다(전체 VM 을 매일 넣지 않는다 — 5,850 VM × 400일 = 234만 행을 피한다).
 *   · **못 읽은 것은 0 이 아니다**: 값을 지금 쓰지 않는 vCenter(metrics/unreadVcenters — 점검중 · 수집 실패 이월 · 낡은 위임) ·
 *     첫 수집 중(pending)인 vCenter 는 행을 만들지 않고 status 로만 남긴다 — ‘그날 스냅샷이 없었다’ 로 적지 않는다.
 *     크기 · 생성일을 못 읽은 VM 은 null 로 넣는다(합에 넣지 않고 따로 센다).
 *   · ‘없어진 스냅샷’ 판정의 재료: 그 VM 의 스냅샷 집합을 **안다**(knownVms — 개수 0, 또는 줄기 · 이름 목록을 읽었다)와
 *     인벤토리에 있는 VM(vmIds)을 같이 넘긴다. 집합을 모르는 VM(개수는 있는데 줄기 · 이름을 못 읽음)의 열린 항목은 db 가 닫지 않는다.
 *   · 스냅샷 하나의 열쇠 = **생성 시각**(VM 안에서 유일 — 이름을 바꿔도 같은 스냅샷이다. 반증 4). 생성 시각을 모르면(이름 목록만) `|이름` —
 *     db 가 이름이 같은 열린 항목과 양방향으로 맞춘다(반증 5 · 6).
 *   · 반증 1(재현): REST 폴백 수집(collectSource 'rest')은 스냅샷 개수를 받지 않는다 — 그날은 'no-snap' 사유로 빠진 날이다.
 *     엣지가 REST 로 받은 위임 vCenter(collectSource 'site' + collectMethod 'rest')도 같다(138회차 — 사유 판정은 view.vcReadIssue 하나).
 *     SOAP 수집에서도 개수를 못 읽은 VM 이 있으면 status 'partial' — db 는 그날 사유만 남기고(행 · 항목 없음 — 138회차 정정) 추이에 넣지 않는다(부분 합 금지).
 *   · 반증 8: 백업 도구(Veeam)가 백업할 때마다 만들고 지우는 임시 스냅샷(soapParse.VEEAM_SNAP_NAME)은 항목으로 만들지 않는다 —
 *     매일 ‘정리된 스냅샷’ 으로 쌓인다. 개수 · 크기 합에는 그대로 든다(그 시각에 실제로 있던 것).
 *   · 반증 9: 지난 일수 · 기준 넘김은 판정 함수(hygieneFindings)와 같은 값(snapshotOldestTs)만 쓴다 — 줄기 시각으로 보충하지 않는다.
 */
import { numOrNull } from '../util/numOrNull.js';
import { hygieneFindings } from '../vmhygiene/analyze.js';
import { unreadVcenterReasons } from '../metrics/unreadVcenters.js';
import { snapGbOf, treeOf, vcReadIssue } from './view.js';
import { VEEAM_SNAP_NAME } from '../vcenter/soapParse.js';

const NAME_MAX = 80;
const VM_NAME_MAX = 200;
export const ITEMS_PER_VM_MAX = 64;   // soapParse.SNAP_TREE_MAX 와 같은 상한

/** 로컬 날짜 열쇠 'YYYY-MM-DD'. */
export function dayKeyOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 스냅샷 하나의 열쇠 — 생성 시각을 알면 그것만, 모르면 '|이름'. */
export function itemKeyOf(createTs, name) {
  return createTs != null && createTs > 0 ? String(Math.trunc(createTs)) : `|${String(name ?? '').slice(0, NAME_MAX)}`;
}
export const isBareKey = (key) => String(key).startsWith('|');
export const isBackupTemp = (name) => typeof name === 'string' && name.trim().toUpperCase() === VEEAM_SNAP_NAME;

/**
 * vCenter 하나의 하루치. status: 'ok' | 'maintenance' | 'unreachable' | 'stale' | 'pending' | 'disabled'.
 * @returns {{vcenterId:string, status:string, rows:object[], items:object[], vmIds:Set<string>, knownVms:Set<string>, sum:object}}
 */
export function vcDayRecord(snap, vcId, { now, hygiene, unread }) {
  const vc = (snap?.vcenters || []).find((x) => x && String(x.id) === vcId) || null;
  // 사유 판정은 view.vcReadIssue 하나(138회차 — 화면 법인 카드 · 7일 변화와 같은 판정. 엣지가 REST 로 받은 위임 vCenter(collectMethod)도 'no-snap')
  const reason = vcReadIssue(vc, vcId, unread);
  if (reason) return { vcenterId: vcId, status: reason, rows: [], items: [], vmIds: new Set(), knownVms: new Set(), sum: null };
  const rows = []; const items = []; const vmIds = new Set(); const knownVms = new Set();
  const sum = { vms: 0, snaps: 0, gb: 0, gbUnknown: 0, ageUnknown: 0, over: 0, countUnknown: 0 };
  for (const v of snap?.vms || []) {
    if (!v || String(v.vcenterId) !== vcId || v.id == null) continue;
    const vmId = String(v.id);
    vmIds.add(vmId);
    const cnt = numOrNull(v.snapshotCount);
    if (cnt == null) { sum.countUnknown += 1; continue; }   // 개수를 못 읽음 — 행도 열쇠 집합도 모른다(따로 센다)
    if (cnt <= 0) { knownVms.add(vmId); continue; }  // 스냅샷 0개 — 집합을 안다(빈 집합)
    const tree = treeOf(v);
    const names = Array.isArray(v.snapshotNames) ? v.snapshotNames.filter((s) => typeof s === 'string' && s) : [];
    const keys = new Map();
    if (tree && tree.length) {
      for (const n of tree) {
        const k = itemKeyOf(n.ts, n.name);
        if (!keys.has(k)) keys.set(k, { key: k, name: n.name, createTs: n.ts, mem: n.mem, quiesced: n.quiesced });
      }
    } else {
      for (const nm of names) {
        const k = itemKeyOf(null, nm);
        if (!keys.has(k)) keys.set(k, { key: k, name: nm.slice(0, NAME_MAX), createTs: null, mem: null, quiesced: null });
      }
    }
    // 줄기가 잘렸으면(개수 > 읽은 노드) 그 VM 의 집합은 일부만 안다 — 닫기 판정에 쓰지 않는다
    // 이름만 받은 경우 같은 이름이 여럿이면(‘daily’ 두 개) 열쇠 하나로 겹친다 — 그 VM 은 집합을 모르는 것으로 본다(반증 6)
    const distinct = tree && tree.length ? keys.size : new Set(names).size === names.length ? keys.size : 0;
    if (distinct && distinct >= cnt) knownVms.add(vmId);
    for (const it of [...keys.values()].slice(0, ITEMS_PER_VM_MAX)) if (!isBackupTemp(it.name)) items.push({ vmId, vmName: String(v.name || vmId).slice(0, VM_NAME_MAX), ...it });
    const gb = snapGbOf(v);
    const oldestTs = numOrNull(v.snapshotOldestTs);
    const f = hygiene ? hygieneFindings(v, hygiene, now) : null;
    const judged = !!hygiene && v.template !== true && !f?.excepted;
    const over = !!f && f.findings.some((x) => x.code === 'snap-age');
    rows.push({ vmId, name: String(v.name || vmId).slice(0, VM_NAME_MAX), count: cnt, gb, oldestTs: oldestTs != null && oldestTs > 0 ? oldestTs : null,
      power: v.powerState === 'POWERED_ON' ? 'on' : v.powerState ? 'off' : null, judged, over });
    sum.vms += 1; sum.snaps += cnt;
    if (gb == null) sum.gbUnknown += 1; else sum.gb += gb;
    if (oldestTs == null) sum.ageUnknown += 1;
    if (over) sum.over += 1;
  }
  sum.gb = Math.round(sum.gb * 10) / 10;
  return { vcenterId: vcId, status: sum.countUnknown ? 'partial' : 'ok', rows, items, vmIds, knownVms, sum };
}

/** 등록된 vCenter 전부의 하루치(only 를 주면 그 vCenter 만). */
export function dayRecord(snap, { now = Date.now(), hygiene = null, only = null } = {}) {
  const unread = unreadVcenterReasons(snap);
  const ids = (snap?.vcenters || []).filter((vc) => vc && vc.id != null).map((vc) => String(vc.id)).filter((id) => !only || only.has(id));
  return { day: dayKeyOf(now), ts: now, perVc: ids.map((id) => vcDayRecord(snap, id, { now, hygiene, unread })) };
}
