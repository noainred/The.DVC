/**
 * mock/demo/veeam.js — 데모(mock) 모드의 Veeam 백업 배지·상세(v2.751). 실제 Veeam 에 접속하지 않는다.
 * 그 vCenter 에 사람이 등록한 Veeam 서버가 없고 mock 모드일 때만 쓴다(사람이 등록한 서버가 있으면 실제 결과).
 * 분포(결정적): 켜진 VM 의 약 70%·꺼진 VM 의 약 35% 가 백업 대상 · 그중 약 4% 가 '백업 중'(진행률) · 1% 가 '대기'.
 * 작업 이름은 폴더(없으면 'VMs')에서 만든다 — 실제 운영처럼 폴더 단위 작업이 여러 개 보이게. 배지와 상세 창은 같은 함수(demoEntry)를 쓴다.
 */
import { demoRand } from './flags.js';

const DAY = 86_400_000;
const GB = 1024 ** 3;
const SERVER = '데모 Veeam';

/** VM 1대의 데모 값 — 대상이 아니면 null. */
function demoEntry(v, now) {
  const r = demoRand(`veeam|${v.id}`);
  if (v.powerState === 'POWERED_OFF' ? r > 0.35 : r > 0.7) return null;
  const folder = String(v.folder || '').split('/').filter(Boolean).pop() || 'VMs';
  const job = `BJ-${folder}`.slice(0, 64);
  const slot = Math.floor(now / (10 * 60_000)); // 10분마다 '백업 중' VM 이 바뀐다
  const runR = demoRand(`veeam-run|${v.id}|${slot}`);
  const run = runR < 0.04 ? 1 : runR < 0.05 ? 2 : 0;
  // 하루 한 번(매일 01:00 무렵 시작) 백업 — 마지막 완료는 오늘 또는 어제 새벽, 소요 5~95분.
  const durMin = 5 + Math.floor(demoRand(`veeam-dur|${v.id}`) * 90);
  const today = Math.floor(now / DAY) * DAY + 16 * 3_600_000; // UTC 16:00 = KST 01:00
  const start = (today > now ? today - DAY : today) + Math.floor(demoRand(`veeam-st|${v.id}`) * 3_600_000);
  const end = Math.min(now - 60_000, start + durMin * 60_000);
  const rpN = 7 + Math.floor(r * 30);
  const warn = demoRand(`veeam-res|${v.id}`) < 0.06;
  const dataGb = 20 + Math.floor(demoRand(`veeam-sz|${v.id}`) * 480);
  return { job, run, pg: run === 1 ? Math.floor(runR * 2500) % 100 : null, start, end, durMin, rpN, warn, dataGb };
}

/** @returns {{ byVm: Record<string, object>, unmatched:0, otherVcenter:0, ambiguous:0 }} */
export function demoVeeamMatch(vcenterId, vms, now = Date.now()) {
  const byVm = {};
  for (const v of Array.isArray(vms) ? vms : []) {
    if (!v || typeof v.id !== 'string' || v.vcenterId !== vcenterId) continue;
    const e = demoEntry(v, now);
    if (!e) continue;
    byVm[v.id] = {
      jobs: [e.job], run: e.run, pg: e.pg, by: e.run ? 'task' : '', rp: e.rpN, lastRun: e.start, lastResult: e.warn ? 'Warning' : 'Success',
      servers: [SERVER], lb: e.end, lbSrc: 'task',
      sz: Math.round(e.dataGb * GB * (0.35 + e.rpN * 0.04)), nr: e.start + DAY,
      ...(e.run ? {} : { lr: e.warn ? 'Warning' : 'Success', lrt: e.end, lrs: e.start }),   // 마지막 task 결과(데모 — 도는 중이면 없음)   // v2.837 복원 지점 크기 합 · 다음 실행(데모 — 매일 같은 시각)
    };
  }
  return { byVm, unmatched: 0, otherVcenter: 0, ambiguous: 0 };
}

/** 상세 창(parse.js buildVmDetail 과 같은 모양). 대상이 아니면 null. */
export function demoVeeamDetail(vcenterId, vm, now = Date.now()) {
  if (!vm || vm.vcenterId !== vcenterId) return null;
  const e = demoEntry(vm, now);
  if (!e) return null;
  const recent = Array.from({ length: Math.min(10, e.rpN) }, (_, i) => e.start - i * DAY);
  const full = e.dataGb * GB;
  return {
    running: e.run === 1 ? { progress: e.pg, by: 'task' } : null, pending: e.run === 2,
    lastBackup: e.end, lastBackupSrc: 'task',
    lastTask: { result: e.warn ? 'Warning' : 'Success', message: e.warn ? '데모: 스냅샷 정리 지연 경고' : '', start: e.start, end: e.end, durationSec: e.durMin * 60,
      processed: Math.round(full * 0.92), read: Math.round(full * 0.08), transferred: Math.round(full * 0.03), job: e.job },
    restorePoints: { count: e.rpN, oldest: e.start - (e.rpN - 1) * DAY, latest: e.start, recent },
    vmSize: Math.round(full * 0.55 + full * 0.04 * (e.rpN - 1)),
    backups: [{ id: `demo-${e.job}`, name: e.job, job: e.job, repo: 'Repo-Demo-01', files: e.rpN, backupSize: Math.round(full * 0.55 * 12 + full * 0.04 * e.rpN * 12),
      dataSize: Math.round(full * 12), dedup: 1.8, compress: 2.1, lastFile: e.end }],
    jobs: [{ name: e.job, type: 'Backup', status: e.run ? 'Running' : 'Inactive', lastResult: e.warn ? 'Warning' : 'Success', lastRun: e.start, nextRun: e.start + DAY, disabled: false, running: e.run === 1, counts: true }],
    servers: [{ name: SERVER, ts: now }],
  };
}
