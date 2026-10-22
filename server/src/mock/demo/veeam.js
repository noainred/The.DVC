/**
 * mock/demo/veeam.js — 데모(mock) 모드의 Veeam 백업 배지(v2.751). 실제 Veeam 에 접속하지 않는다.
 * 그 vCenter 에 사람이 등록한 Veeam 서버가 없고 mock 모드일 때만 쓴다(사람이 등록한 서버가 있으면 실제 결과).
 * 분포(결정적): 꺼지지 않은 VM 의 약 70% 가 백업 대상 · 그중 약 4% 가 '백업 중'(진행률) · 1% 가 '대기'.
 * 작업 이름은 폴더(없으면 vCenter)에서 만든다 — 실제 운영처럼 폴더 단위 작업이 여러 개 보이게.
 */
import { demoRand } from './flags.js';

const DAY = 86_400_000;

/** @returns {{ byVm: Record<string, object>, unmatched:0, otherVcenter:0, ambiguous:0 }} */
export function demoVeeamMatch(vcenterId, vms, now = Date.now()) {
  const byVm = {};
  const slot = Math.floor(now / (10 * 60_000)); // 10분마다 '백업 중' VM 이 바뀐다
  for (const v of Array.isArray(vms) ? vms : []) {
    if (!v || typeof v.id !== 'string' || v.vcenterId !== vcenterId) continue;
    const r = demoRand(`veeam|${v.id}`);
    if (v.powerState === 'POWERED_OFF' ? r > 0.35 : r > 0.7) continue;
    const folder = String(v.folder || '').split('/').filter(Boolean).pop() || 'VMs';
    const job = `BJ-${folder}`.slice(0, 64);
    const runR = demoRand(`veeam-run|${v.id}|${slot}`);
    const run = runR < 0.04 ? 1 : runR < 0.05 ? 2 : 0;
    const lastRun = now - Math.floor(demoRand(`veeam-last|${v.id}`) * DAY);
    byVm[v.id] = {
      jobs: [job], run, pg: run === 1 ? Math.floor(runR * 2500) % 100 : null, by: run ? 'task' : '',
      rp: 7 + Math.floor(r * 30), lastRun, lastResult: demoRand(`veeam-res|${v.id}`) < 0.06 ? 'Warning' : 'Success',
      servers: ['데모 Veeam'],
    };
  }
  return { byVm, unmatched: 0, otherVcenter: 0, ambiguous: 0 };
}
