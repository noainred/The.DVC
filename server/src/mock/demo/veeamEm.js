/**
 * mock/demo/veeamEm.js — 데모(mock) 모드의 Veeam Enterprise Manager 화면 값(v2.788).
 * 규칙(mock/demo/flags.js 머리): 데모 모드에서만 · 등록부가 비었을 때만 · 접속하지 않는다 · 응답에 demo:true.
 * 값은 스냅샷의 vCenter·VM 수에서 결정적으로 만든다(새로고침마다 바뀌지 않게) — 실제 장비 값이 아니다.
 */
import { demoRand } from './flags.js';
import { rootsCheck, vcIndexOf } from '../../veeam/em/view.js';

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
      last: { uid: `urn:veeam:BackupJobSession:00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, result: st === 'run' ? 'ok' : st, start: end - dur * 1000, end, durSec: dur },
      runs24: { ok: st === 'ok' ? 1 : 0, warn: st === 'warn' ? 1 : 0, fail: st === 'fail' ? 1 : 0 },
    });
  }
  const c = { ok: 0, warn: 0, fail: 0 };
  for (const j of jobs) c[j.last.result] = (c[j.last.result] || 0) + 1;
  const repos = servers.map((sv, i) => {
    const cap = (40 + Math.round(rnd() * 200)) * 1e12;
    return { name: `${sv.name.replace('VBR-', '')}-Repo-0${(i % 3) + 1}`, uid: `demo-repo-${i}`, kind: ['ReFS', 'XFS', 'SOBR'][i % 3], capacity: cap, free: Math.round(cap * (0.05 + rnd() * 0.6)), server: sv.name };
  });
  const bad = jobs.filter((j) => j.last.result === 'fail' || j.last.result === 'warn').map((j) => ({ uid: j.last.uid, job: j.name, server: j.server, result: j.last.result, start: j.last.start, end: j.last.end }));
  const protectedVms = Math.round(vmN * 0.88);
  return {
    id: 'mock-em-1', name: 'DEMO-VEM01', host: 'vem-demo.local', port: 9398, enabled: true, demo: true,
    status: { ok: true, ts: now - 8 * 60_000, error: '', kind: '', authStop: null, lastOkTs: now - 8 * 60_000, stale: false,
      sections: Object.fromEntries(['overview', 'jobStats', 'vms', 'processed', 'repoReport', 'backupServers', 'jobs', 'repositories', 'sessions', 'vmBackups'].map((k) => [k, { ok: true }])), notes: [] },
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

/**
 * v2.817 데모 EM 여러 대 — 'EM 연결 현황'(EM → 백업 서버 → vCenter)을 보이게. 실제 장비 값이 아니다(결정적).
 *  · EM 1·2 = 같은 데모 백업 서버를 반씩 · 서버마다 EM 이 본 호스트(VC 루트 + 일부 ESXi 단독 · 포탈에 없는 옛 vCenter)
 *  · 포탈 매핑: 대부분 같음 · 일부 다름 · 일부 매핑 없음 · EM 3 = 수집 실패(서버가 안 보이는 경우를 재현)
 */
export const DEMO_EM_IDS = Object.freeze(['mock-em-1', 'mock-em-2', 'mock-em-3']);
export function demoEmViews(snap, now = Date.now(), { vcIndex = null } = {}) {
  const base = demoEmView(snap, now);
  const vcs = (snap?.vcenters || []).slice(0, 40);
  const idx = vcIndex || vcIndexOf(vcs.map((v) => ({ id: v.id, name: v.name || v.id })));
  const all = base.data.backupServers.map((sv, i) => {
    const vA = vcs[(i * 2) % Math.max(1, vcs.length)]; const vB = vcs[(i * 2 + 1) % Math.max(1, vcs.length)];
    const roots = [{ name: vA?.name || vA?.id || 'vc-demo', hostType: 'VC', server: sv.name }];
    if (i % 4 === 0 && vB) roots.push({ name: vB.name || vB.id, hostType: 'VC', server: sv.name });
    if (i % 3 === 1) roots.push({ name: `esx-${String(i + 1).padStart(2, '0')}.demo.local`, hostType: 'ESX', server: sv.name });
    if (i % 6 === 5) roots.push({ name: 'vc-legacy.demo.local', hostType: 'VC', server: sv.name });
    const mapped = i % 5 === 2 ? [] : i % 7 === 3 && vB ? [vB.id] : roots.filter((r) => r.hostType === 'VC').map((r) => vcs.find((v) => (v.name || v.id) === r.name)?.id).filter(Boolean);
    const vcSource = mapped.length ? 'manual' : null;
    const s0 = { ...sv, vcenterIds: mapped, vcNames: mapped.map((id) => idx.name.get(id) || id), vcSource, brSource: sv.registered ? 'auto' : null };
    return { s0, roots };
  });
  const half = Math.ceil(all.length / 2);
  const mk = (id, name, host, part) => {
    const names = new Set(part.map((x) => x.s0.name));
    const roots = part.flatMap((x) => x.roots);
    const servers = part.map((x) => ({ ...x.s0, ...rootsCheck(x.s0, roots, idx) }));
    const jobs = (base.data._jobs || []).filter((j) => names.has(j.server));
    const v = JSON.parse(JSON.stringify({ ...base, data: { ...base.data, _jobs: undefined } }));
    v.id = id; v.name = name; v.host = host;
    v.status.sections.hierarchyRoots = { ok: true };
    v.data.backupServers = servers; v.data.hierarchyRootsKnown = true; v.data.orphanRoots = [];
    v.data._jobs = jobs;
    v.data.overview.backupServers = servers.length; v.data.overview.scheduledJobs = jobs.length;
    v.data.repositories = (v.data.repositories || []).filter((r) => names.has(r.server));
    v.data.sessions.recentBad = (v.data.sessions.recentBad || []).filter((b) => names.has(b.server));
    v.data.sessions.recentBadTotal = v.data.sessions.recentBad.length;
    return v;
  };
  const failed = {
    id: DEMO_EM_IDS[2], name: 'DEMO-VEM03', host: 'vem3-demo.local', port: 9398, enabled: true, demo: true,
    status: { ok: false, ts: now - 4 * 60_000, error: '수집 시한(240초)이 지나 일부만 읽었습니다 — 부분 결과는 저장하지 않습니다', kind: 'timeout', authStop: null, lastOkTs: null, stale: true, sections: {}, notes: [] },
    data: null,
  };
  return [mk(DEMO_EM_IDS[0], 'DEMO-VEM01', 'vem-demo.local', all.slice(0, half)), mk(DEMO_EM_IDS[1], 'DEMO-VEM02', 'vem2-demo.local', all.slice(half)), failed];
}

/** 데모 라이선스(B&R 서버 2대 몫) — 실제 등록 B&R 이 없을 때만. */
export function demoLicenses(now = Date.now()) {
  const D = 86_400_000;
  return [
    { id: 'mock-vbr-1', name: 'VBR-DEMO-01', license: { status: 'Valid', type: 'Subscription', edition: 'EnterprisePlus', expires: now + 158 * D, supportExpires: now + 47 * D, instances: { licensed: 3000, used: 2410 }, sockets: null, capacityTb: null }, ts: now - 9 * 60_000, demo: true },
    { id: 'mock-vbr-2', name: 'VBR-DEMO-02', license: { status: 'Valid', type: 'Subscription', edition: 'EnterprisePlus', expires: now + 158 * D, supportExpires: now + 158 * D, instances: { licensed: 3000, used: 2450 }, sockets: null, capacityTb: null }, ts: now - 9 * 60_000, demo: true },
  ];
}

/** v2.788.1 데모 세션 상세 — 실패·경고 사유 예시(실제 장비 값이 아니다). */
export function demoSessionDetail(uid, now = Date.now()) {
  const n = Number(String(uid).slice(-4)) || 0;
  const bad = n % 3 === 0 ? 'fail' : 'warn';
  const reasons = {
    fail: ['Error: Failed to create VM snapshot. The operation is not allowed in the current state.', 'Error: Not enough storage space on the repository (free 212 GB, required 260 GB).'],
    warn: ['Changed block tracking cannot be enabled: full disk read was used.', 'Retry 1 of 3 succeeded.'],
  };
  const tasks = Array.from({ length: 4 }, (_, i) => ({
    vm: `demo-vm-${String(n % 50).padStart(2, '0')}${i}`, result: i === 0 ? bad : 'ok', state: 'Stopped',
    reason: i === 0 ? reasons[bad][n % 2] : '', start: now - (3 + i) * 3_600_000, end: now - (2 + i) * 3_600_000, size: (40 + i * 7) * 1e9,
  }));
  return { ok: true, demo: true, uid, head: { job: '', result: bad, state: 'Stopped', start: now - 6 * 3_600_000, end: now - 2 * 3_600_000, reason: reasons[bad][0], retry: false }, tasks, errors: {} };
}
