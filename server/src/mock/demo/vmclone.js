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
      verifyAfter: i % 2 === 0,   // v2.793: 자동 검증 데모
      demo: true,   // v2.719(감사 R1-07): live 로 바꾸면 스케줄러가 이 잡을 실행하지 않는다
    });
  }
  return out;
}

/**
 * 데모 잡인가 — **모드와 무관**(v2.719 감사 R1-07). 표지 demo:true, 또는 표지가 생기기 전(v2.717~2.718)에 시드된
 * 잡은 합성 사본 ref 접두 'mock-demo-' 로 알아본다.
 */
export function isVmCloneDemoJob(job) {
  if (!job) return false;
  if (job.demo === true) return true;
  return Array.isArray(job.clones) && job.clones.some((c) => String(c?.ref || '').startsWith('mock-demo-'));
}

/** 잡이 비어 있으면 데모 잡과 과거 사본·실행 기록을 1회 만든다. */
export async function ensureVmCloneDemo({ now = Date.now() } = {}) {
  if (_tried || !isMockMode()) return { skipped: true };
  const { store } = await import('../../store.js');
  const snap = store.get?.();
  if (!snap?.vms?.length) return { skipped: 'no-snapshot' };
  _tried = true;
  const { listJobs, saveJob, recordRun, patchClone, recordJobEvent, recordOp } = await import('../../vmclone/store.js');
  if (listJobs().length) return { skipped: 'not-empty' };
  let n = 0;
  let firstVc = '';
  for (const def of demoVmCloneJobs(snap)) {
    let job;
    try { job = saveJob(def); } catch (e) { console.warn(`[mock] VM 복제 데모 잡 등록 실패(${def.vmName}): ${e.message}`); continue; }
    n += 1;
    if (!firstVc) firstVc = def.vcenterId;
    const step = def.schedule.mode === 'interval' ? 12 * HOUR : 24 * HOUR;
    // v2.793: 사본 크기(인벤토리 프로비저닝 크기의 약 0.6배 — 씬 사용량을 흉내) · 단계 기록 · 검증 결과(데모).
    const gb = Number((snap.vms || []).find((v) => v.id === def.vmId)?.storageGB);
    for (let k = def.keep; k >= 1; k -= 1) {
      const at = now - k * step;
      const name = `${def.vmName}-bak-demo${k}`;
      const ms = 40_000 + (demoHash(name) % 90_000);
      const ref = `mock-demo-${job.id}-${k}`;
      const phases = [{ n: '시작', ms: 2_000 }, { n: `스냅샷 생성${def.quiesce ? '(정지점)' : ''}`, ms: 9_000 }, { n: '클론', ms: ms - 19_000 }, { n: '보존정책 적용', ms: 3_000 }, { n: '스냅샷 삭제(병합)', ms: 5_000 }];
      recordRun(job.id, { ok: true, detail: `복제 완료 — ${name} (데모)`, ms, trigger: 'schedule', phases, historyAt: at + ms, addClone: { name, ref, at, ...(Number.isFinite(gb) && gb > 0 ? { bytes: Math.round(gb * (0.55 + (demoHash(ref) % 10) / 100) * 1024 ** 3) } : {}) } });
      if (def.verifyAfter) {
        const ok = demoHash(`v|${ref}`) % 7 !== 0;
        const detail = ok ? `부팅 확인 — VMware Tools 응답 ${25 + (demoHash(ref) % 50)}초(데모)` : 'VMware Tools 가 10분 안에 응답하지 않았습니다(데모)';
        patchClone(job.id, ref, { verify: { at: at + ms + 60_000, ok, detail } });
        recordJobEvent(job.id, { kind: 'verify', ok, detail, ms: 180_000, trigger: 'auto', at: at + ms + 240_000, phases: [{ n: '검증용 스냅샷', ms: 6_000 }, { n: '네트워크 끊기', ms: 4_000 }, { n: '전원 켜기', ms: 15_000 }, { n: 'VMware Tools 대기', ms: 140_000 }, { n: '되돌리기 · 스냅샷 삭제', ms: 15_000 }] });
      }
    }
    if (n === 3) recordRun(job.id, { ok: false, detail: '스냅샷 생성 실패 — 데이터스토어 여유 공간 부족(데모)', ms: 12_000, trigger: 'schedule', phases: [{ n: '시작', ms: 2_000 }, { n: '스냅샷 생성', ms: 10_000, ok: false }] });
    if (n === 1) recordOp({ kind: 'restore', jobId: job.id, vcenterId: def.vcenterId, vmName: def.vmName, at: now - 5 * HOUR, ok: true, ms: 420_000, detail: `복구 완료(데모) — ${def.vmName}-bak-demo1 → 새 VM '${def.vmName}-restore' · 네트워크 끊김 · 꺼진 상태`, by: 'admin', target: `${def.vmName}-restore` });
  }
  // v2.793: 법인 저장소 데모 — ESXi NFS 데이터스토어 정의 1개(호스트 대부분 연결 · 1대 실패).
  if (firstVc) {
    try {
      const { createNfsDs, applyAttachResult } = await import('../../vmclone/nfsDs.js');
      const item = createNfsDs({ vcenterId: firstVc, name: 'demo-nfs-bk01', server: '10.20.1.50', exportPath: '/backup01', nfsVersion: '3' }, 'admin');
      const hosts = (snap.hosts || []).filter((h) => h.vcenterId === firstVc);
      applyAttachResult(item.id, hosts.map((h, i) => (i === hosts.length - 1 && hosts.length > 1
        ? { hostId: h.id, ok: false, detail: 'NFS 서버가 이 호스트의 마운트를 거부했습니다(데모) — export 허용 목록에 호스트 VMkernel IP 를 넣으세요' }
        : { hostId: h.id, ok: true, detail: '연결했습니다(데모)' })), now - 26 * HOUR);
      recordOp({ kind: 'nfsds-attach', vcenterId: firstVc, at: now - 26 * HOUR, ok: hosts.length <= 1, ms: 95_000, detail: `NFS 데이터스토어 'demo-nfs-bk01' — 호스트 ${Math.max(0, hosts.length - 1)}/${hosts.length}대 연결(데모)`, by: 'admin', target: 'demo-nfs-bk01' });
    } catch (e) { console.warn(`[mock] VM 백업 데모 NFS 데이터스토어 등록 실패: ${e.message}`); }
  }
  if (n) console.log(`[mock] VM 복제(백업) 데모 잡 ${n}개 등록`);
  return { added: n };
}

export function _resetVmCloneDemoForTest() { _tried = false; }
