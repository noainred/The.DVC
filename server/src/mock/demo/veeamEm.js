/**
 * mock/demo/veeamEm.js — 데모(mock) 모드의 Veeam Enterprise Manager 화면 값(v2.788).
 * 규칙(mock/demo/flags.js 머리): 데모 모드에서만 · 등록부가 비었을 때만 · 접속하지 않는다 · 응답에 demo:true.
 * 값은 스냅샷의 vCenter·VM 수에서 결정적으로 만든다(새로고침마다 바뀌지 않게) — 실제 장비 값이 아니다.
 */
import { demoRand } from './flags.js';

const H = 3_600_000;
export function demoEmView(snap, now = Date.now()) {
  const vcs = (snap?.vcenters || []).slice(0, 40);
  const vmN = (snap?.vms || []).length;
  let seq = 0;
  const rnd = () => demoRand(`veeam-em:${seq++}`);   // 결정적(같은 순서 = 같은 값)
  const servers = vcs.slice(0, Math.max(1, Math.ceil(vcs.length / 2))).map((v, i) => ({ name: `VBR-${String(v.name || v.id).split(/[.-]/)[1] || i}`.toUpperCase().slice(0, 24), uid: `demo-vbr-${i}`, version: i % 3 ? '12.3.1' : '12.2.0', port: 9392, description: '', registered: i % 4 !== 3 }));
  const kinds = [['ok', 0.86], ['warn', 0.08], ['fail', 0.03], ['run', 0.03]];
  const pickState = () => { const x = rnd(); let acc = 0; for (const [k, p] of kinds) { acc += p; if (x < acc) return k; } return 'ok'; };
  const jobs = [];
  for (let i = 0; i < Math.min(60, servers.length * 6); i++) {
    const sv = servers[i % servers.length];
    const st = pickState();
    const end = now - Math.round(rnd() * 20 * H);
    const dur = Math.round(600 + rnd() * 14_000);
    jobs.push({
      name: `${sv.name.replace('VBR-', '')}-${['Daily', 'Inc', 'Full', 'Copy', 'Rep', 'SQL'][i % 6]}-${String(i + 1).padStart(2, '0')}`, uid: `demo-job-${i}`, server: sv.name,
      type: i % 6 === 4 ? 'Replica' : i % 6 === 3 ? 'BackupCopy' : 'Backup', platform: 'VMware', scheduleEnabled: true, nextRun: now + Math.round(rnd() * 20 * H),
      running: st === 'run' ? { start: now - Math.round(rnd() * H) } : null,
      last: { result: st === 'run' ? 'ok' : st, start: end - dur * 1000, end, durSec: dur },
      runs24: { ok: st === 'ok' ? 1 : 0, warn: st === 'warn' ? 1 : 0, fail: st === 'fail' ? 1 : 0 },
    });
  }
  const c = { ok: 0, warn: 0, fail: 0 };
  for (const j of jobs) c[j.last.result] = (c[j.last.result] || 0) + 1;
  const repos = servers.map((sv, i) => {
    const cap = (40 + Math.round(rnd() * 200)) * 1e12;
    return { name: `${sv.name.replace('VBR-', '')}-Repo-0${(i % 3) + 1}`, uid: `demo-repo-${i}`, kind: ['ReFS', 'XFS', 'SOBR'][i % 3], capacity: cap, free: Math.round(cap * (0.05 + rnd() * 0.6)), server: sv.name };
  });
  const bad = jobs.filter((j) => j.last.result === 'fail' || j.last.result === 'warn').map((j) => ({ job: j.name, server: j.server, result: j.last.result, start: j.last.start, end: j.last.end }));
  const protectedVms = Math.round(vmN * 0.88);
  return {
    id: 'mock-em-1', name: 'DEMO-VEM01', host: 'vem-demo.local', port: 9398, enabled: true, demo: true,
    status: { ok: true, ts: now - 8 * 60_000, error: '', kind: '', authStop: null, lastOkTs: now - 8 * 60_000, stale: false,
      sections: Object.fromEntries(['overview', 'jobStats', 'vms', 'processed', 'repoReport', 'backupServers', 'jobs', 'repositories', 'sessions'].map((k) => [k, { ok: true }])), notes: [] },
    data: {
      overview: { backupServers: servers.length, proxyServers: servers.length * 3, repositoryServers: repos.length, runningJobs: jobs.filter((j) => j.running).length, scheduledJobs: jobs.length,
        vmOk: Math.round(protectedVms * 0.95), vmWarn: Math.round(protectedVms * 0.035), vmFail: Math.round(protectedVms * 0.015) },
      jobStats: { running: jobs.filter((j) => j.running).length, scheduled: jobs.length, scheduledBackup: jobs.length - 8, scheduledReplica: 8,
        totalRuns: jobs.length * 3, okRuns: c.ok * 3, warnRuns: c.warn * 3, failRuns: c.fail * 3, maxDurSec: 18_720, maxBackupDurSec: 18_720, maxReplicaDurSec: 6_000, maxBackupName: jobs[0]?.name || '', maxReplicaName: jobs[4]?.name || '' },
      vms: { protected: protectedVms, backedUp: Math.round(protectedVms * 0.98), replicated: Math.round(protectedVms * 0.04), restorePoints: protectedVms * 11,
        fullSize: 412e12, incSize: 96e12, replicaSize: 18e12, sourceSize: 1.9e15, successPct: 97 },
      processed: null, repoReport: null,
      backupServers: servers,
      repositories: repos.map((r) => ({ ...r, usedPct: Math.round(((r.capacity - r.free) / r.capacity) * 1000) / 10 })).sort((a, b) => b.usedPct - a.usedPct),
      jobs: null,   // 호출부가 jobsView 로 채운다(정렬·집계를 실제 경로와 같은 함수로)
      _jobs: jobs,
      sessions: { counts24: { total: jobs.length * 3, ok: c.ok * 3, warn: c.warn * 3, fail: c.fail * 3, running: jobs.filter((j) => j.running).length }, recentBad: bad.slice(0, 50), recentBadTotal: bad.length },
    },
  };
}

/** 데모 라이선스(B&R 서버 2대 몫) — 실제 등록 B&R 이 없을 때만. */
export function demoLicenses(now = Date.now()) {
  const D = 86_400_000;
  return [
    { id: 'mock-vbr-1', name: 'VBR-DEMO-01', license: { status: 'Valid', type: 'Subscription', edition: 'EnterprisePlus', expires: now + 158 * D, supportExpires: now + 47 * D, instances: { licensed: 3000, used: 2410 }, sockets: null, capacityTb: null }, ts: now - 9 * 60_000, demo: true },
    { id: 'mock-vbr-2', name: 'VBR-DEMO-02', license: { status: 'Valid', type: 'Subscription', edition: 'EnterprisePlus', expires: now + 158 * D, supportExpires: now + 158 * D, instances: { licensed: 3000, used: 2450 }, sockets: null, capacityTb: null }, ts: now - 9 * 60_000, demo: true },
  ];
}
