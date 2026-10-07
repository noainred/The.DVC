/**
 * mock/demo/vmclone.js — 데모(DATA_SOURCE=mock) VM 복제(백업) 잡(v2.717).
 *
 * 배경: 데모에서 'VM 복제(백업)' 화면이 '복제 잡이 없습니다' 로 비어 있었다.
 * 규칙(mock/demo/flags.js 머리말과 같다)
 *  · mock 모드에서만, 잡 목록이 **비어 있을 때만** 1회 등록한다(사람이 만든 잡이 있으면 하지 않는다).
 *  · 실행은 이미 안전하다 — mock 모드의 runner 는 vCenter 에 접속하지 않고 시뮬레이션한다(vmclone/runner.js).
 *  · 보유 사본·최근 실행은 과거 시각의 합성 기록이며 detail 에 '(데모)' 를 붙인다.
 */
import { isMockMode, demoHash } from './flags.js';

let _tried = false;
const HOUR = 3_600_000;

/** 스냅샷에서 데모 잡 정의(순수). */
export function demoVmCloneJobs(snapshot) {
  const vms = (snapshot?.vms || []).filter((v) => v.powerState === 'POWERED_ON' && !v.template && /^(db|app|web|dc|mail)-/.test(v.name || ''));
  const dsOf = (vc) => (snapshot?.datastores || []).find((d) => d.vcenterId === vc && /backup|nfs|san/i.test(d.name || ''))
    || (snapshot?.datastores || []).find((d) => d.vcenterId === vc);
  const out = [];
  const seenVc = new Set();
  for (const v of vms) {
    if (out.length >= 5) break;
    if (seenVc.has(v.vcenterId)) continue;          // 법인마다 하나 — 화면이 여러 vCenter 를 보이게
    const ds = dsOf(v.vcenterId);
    if (!ds) continue;
    seenVc.add(v.vcenterId);
    const i = out.length;
    out.push({
      vcenterId: v.vcenterId, vmId: v.id, vmName: v.name,
      dest: { type: 'datastore', datastoreName: ds.name },
      schedule: i % 2 === 0 ? { mode: 'daily', time: `0${2 + i}:30` } : { mode: 'interval', hours: 12 },
      keep: 2 + (i % 3), quiesce: i % 2 === 0, enabled: i !== 4,
    });
  }
  return out;
}

/** 잡이 비어 있으면 데모 잡과 과거 사본·실행 기록을 1회 만든다. */
export async function ensureVmCloneDemo({ now = Date.now() } = {}) {
  if (_tried || !isMockMode()) return { skipped: true };
  const { store } = await import('../../store.js');
  const snap = store.get?.();
  if (!snap?.vms?.length) return { skipped: 'no-snapshot' };
  _tried = true;
  const { listJobs, saveJob, recordRun } = await import('../../vmclone/store.js');
  if (listJobs().length) return { skipped: 'not-empty' };
  let n = 0;
  for (const def of demoVmCloneJobs(snap)) {
    let job;
    try { job = saveJob(def); } catch (e) { console.warn(`[mock] VM 복제 데모 잡 등록 실패(${def.vmName}): ${e.message}`); continue; }
    n += 1;
    const step = def.schedule.mode === 'interval' ? 12 * HOUR : 24 * HOUR;
    for (let k = def.keep; k >= 1; k -= 1) {
      const at = now - k * step;
      const name = `${def.vmName}-bak-demo${k}`;
      recordRun(job.id, { ok: true, detail: `복제 완료 — ${name} (데모)`, ms: 40_000 + (demoHash(name) % 90_000), addClone: { name, ref: `mock-demo-${job.id}-${k}`, at } });
    }
    if (n === 3) recordRun(job.id, { ok: false, detail: '스냅샷 생성 실패 — 데이터스토어 여유 공간 부족(데모)', ms: 12_000 });
  }
  if (n) console.log(`[mock] VM 복제(백업) 데모 잡 ${n}개 등록`);
  return { added: n };
}

export function _resetVmCloneDemoForTest() { _tried = false; }
