/**
 * vmclone/runner.js — 복제 잡 실행기(v2.299).
 *
 * 흐름(대상 유형별):
 *  - datastore: 로그인 → 스냅샷(quiesce 옵션) → 스냅샷 시점 CloneVM_Task(다른 데이터스토어)
 *               → 스냅샷 삭제 → 보존정책(원장에 기록된 우리 클론만, keep 초과분 오래된 순 삭제).
 *               데이터는 vCenter/ESXi 가 서버측에서 복사 — 포탈은 태스크 감시만(고RTT 무관).
 *  - nfs:       로그인 → 스냅샷 → VM 파일 목록(layoutEx) → 베이스 파일만(backupFileFilter)
 *               vCenter /folder HTTPS 로 Edge 노드의 NFS 마운트 경로에 스트리밍 다운로드
 *               → manifest 기록 → 스냅샷 삭제 → 보존정책(우리가 만든 날짜 디렉터리만 삭제).
 *
 * 안전 규칙:
 *  - 동시 실행 1개(전역 큐) — 클론/다운로드가 겹치면 vCenter·스토리지에 몰린다. 수동 실행도
 *    같은 큐를 탄다(CLAUDE.md '수동 실행 API 도 가드 공유' 규칙).
 *  - 스냅샷은 finally 에서 반드시 삭제 시도 — 실패 시 잡 결과에 명시(스냅샷 잔존은
 *    데이터스토어 가득참 사고의 씨앗이라 '스냅샷 나이 감시' 도구로도 보이게 됨).
 *  - NFS 보존 삭제는 마운트 경로 안(containment 검증)의 우리 스탬프 디렉터리만 rm — 경로
 *    탈출 시 즉시 중단(절대 완화 금지).
 *  - mock 모드(개발): 실제 vCenter 없이 성공 시뮬레이션(2초) — UI/스케줄 개발용.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config, loadVcenterConfig } from '../config.js';
import { store } from '../store.js';
import { logAudit } from '../audit.js';
import { getJob, recordRun, pruneList } from './store.js';
import {
  VimSoapClient, createSnapshot, removeSnapshot, parentFolderOf, cloneFromSnapshot,
  destroyClone, vmFilePaths, parseDsPath, backupFileFilter, datacenterPathOf, downloadDsFile,
} from './vsphere.js';
import { getMount, mountedSet, mountPointOf } from '../system/nfsMounts.js';

const morefOf = (id) => String(id || '').split(':').slice(1).join(':');
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

// 전역 실행 큐 — 한 번에 1개(스케줄·수동 공용). 대기 중 목록은 상태 API 로 노출.
let _chain = Promise.resolve();
const _running = { jobId: null, phase: '', startedAt: 0 };
const _queue = [];
export function runnerStatus() { return { running: _running.jobId ? { ..._running } : null, queued: [..._queue] }; }

export function enqueueRun(jobId, trigger = 'manual') {
  if (_running.jobId === jobId || _queue.includes(jobId)) return { queued: false, reason: '이미 실행/대기 중' };
  _queue.push(jobId);
  _chain = _chain.then(() => {
    _queue.splice(_queue.indexOf(jobId), 1);
    return runJob(jobId, trigger).catch(() => {}); // 개별 실패가 체인을 끊지 않게(다음 잡 계속)
  });
  return { queued: true };
}

async function runJob(jobId, trigger) {
  const job = getJob(jobId);
  if (!job || !job.enabled) return;
  _running.jobId = jobId; _running.phase = '시작'; _running.startedAt = Date.now();
  const t0 = Date.now();
  const done = (ok, detail, extra = {}) => {
    recordRun(jobId, { ok, detail, ms: Date.now() - t0, ...extra });
    logAudit({ user: `vm-clone(${trigger})`, action: ok ? 'VM 복제 성공' : 'VM 복제 실패', target: `${job.vcenterId}/${job.vmName}`, detail: String(detail).slice(0, 200) });
    _running.jobId = null; _running.phase = '';
  };

  try {
    const vcCfg = (loadVcenterConfig().vcenters || []).find((v) => v.id === job.vcenterId);
    // mock 모드(개발·데모): 실제 vCenter 없이 성공 시뮬레이션 — 스케줄/보존/UI 흐름 검증용.
    if (!vcCfg || config.mode === 'mock') {
      if (config.mode === 'live') throw new Error(`vCenter 설정을 찾을 수 없습니다: ${job.vcenterId}`);
      _running.phase = '시뮬레이션(mock)';
      await new Promise((r) => setTimeout(r, 2000));
      const name = `${job.vmName}-bak-${stamp()}`;
      const removed = pruneList([...job.clones, { name, ref: `mock-${Date.now()}`, at: Date.now() }], job.keep);
      done(true, `mock 복제 완료 — ${name}${removed.length ? ` · 보존정책 삭제 ${removed.length}개` : ''}`,
        { addClone: { name, ref: `mock-${Date.now()}`, at: Date.now() }, removeCloneRefs: removed.map((c) => c.ref) });
      return;
    }

    const vmRef = morefOf(job.vmId);
    if (!vmRef) throw new Error('VM MoRef 해석 실패');
    const c = new VimSoapClient(vcCfg);
    await c.login();
    let snapRef = null;
    let snapCleanupErr = '';
    try {
      _running.phase = `스냅샷 생성${job.quiesce ? '(정지점)' : ''}`;
      snapRef = await createSnapshot(c, vmRef, { name: `portal-clone-${stamp()}`, quiesce: job.quiesce });

      if (job.dest.type === 'datastore') {
        // 대상 데이터스토어 MoRef — 수집 스냅샷에서 이름으로 해석(provision 과 동일 방식).
        const ds = store.get().datastores.find((d) => d.vcenterId === job.vcenterId && d.name === job.dest.datastoreName);
        if (!ds) throw new Error(`대상 데이터스토어를 찾을 수 없습니다: ${job.dest.datastoreName}`);
        const folder = await parentFolderOf(c, vmRef);
        if (!folder) throw new Error('원본 VM 폴더 조회 실패');
        const cloneName = `${job.vmName}-bak-${stamp()}`;
        _running.phase = `클론 중 → ${job.dest.datastoreName}`;
        const newRef = await cloneFromSnapshot(c, { vmRef, folderRef: folder, name: cloneName, dsRef: morefOf(ds.id), snapshotRef: snapRef });

        // 보존정책 — 원장 기준(이름 패턴 아님), 켜져 있는 클론은 건너뛰고 보고.
        _running.phase = '보존정책 적용';
        const ledger = [...job.clones, { name: cloneName, ref: newRef, at: Date.now() }];
        const toDelete = pruneList(ledger, job.keep);
        const removedRefs = []; const skipped = [];
        for (const old of toDelete) {
          try { await destroyClone(c, old.ref); removedRefs.push(old.ref); }
          catch (e) { skipped.push(`${old.name}: ${e.message}`); }
        }
        done(true, `클론 완료 — ${cloneName} → [${job.dest.datastoreName}]` +
          (removedRefs.length ? ` · 보존정책 삭제 ${removedRefs.length}개` : '') +
          (skipped.length ? ` · 삭제 건너뜀 ${skipped.length}건(${skipped[0]})` : ''),
          { addClone: { name: cloneName, ref: newRef, at: Date.now() }, removeCloneRefs: removedRefs });
      } else {
        // NFS 파일 백업 — 마운트 상태 필수(끊겨 있으면 즉시 실패: NAS 에 안 쓰고 로컬 디스크를
        // 채우는 사고 방지 — containment 이전에 마운트 여부부터 확인한다).
        const mount = getMount(job.dest.mountId);
        if (!mount) throw new Error('NFS 마운트 항목이 없습니다(설정 › NFS 마운트).');
        const mp = mountPointOf(mount.id);
        if (!mountedSet().has(mp)) throw new Error(`NFS 가 마운트되어 있지 않습니다: ${mp} — 설정 › NFS 마운트에서 마운트하세요.`);
        const destRoot = path.join(mp, job.dest.subdir || '', job.vmName);
        const destDir = path.join(destRoot, stamp());
        // 경로 탈출 방지 — 최종 경로가 마운트 지점 아래인지 검증(subdir 는 저장 시 슬러그화됐지만 이중 방어).
        if (!path.resolve(destDir).startsWith(path.resolve(mp) + path.sep)) throw new Error('백업 경로가 마운트 지점을 벗어납니다(차단).');

        _running.phase = '파일 목록 조회';
        const { vmx, files } = await vmFilePaths(c, vmRef);
        const wanted = [...new Set([vmx, ...files])].filter(Boolean).filter(backupFileFilter);
        if (!wanted.length) throw new Error('백업 대상 파일이 없습니다(layoutEx 조회 실패?)');
        const dcPath = await datacenterPathOf(c, vmRef);
        if (!dcPath) throw new Error('Datacenter 경로(dcPath) 해석 실패 — /folder 다운로드 불가');

        let bytes = 0;
        const manifest = [];
        for (let i = 0; i < wanted.length; i++) {
          const pd = parseDsPath(wanted[i]);
          if (!pd) continue;
          _running.phase = `다운로드 ${i + 1}/${wanted.length} — ${pd.rel.split('/').pop()}`;
          const dest = path.join(destDir, pd.rel.split('/').pop());
          const sz = await downloadDsFile(c, vcCfg, { dcPath, ds: pd.ds, rel: pd.rel, destFile: dest });
          bytes += sz; manifest.push({ src: wanted[i], file: path.basename(dest), bytes: sz });
        }
        fs.writeFileSync(path.join(destDir, 'manifest.json'), JSON.stringify({
          vm: job.vmName, vcenterId: job.vcenterId, at: new Date().toISOString(), quiesce: job.quiesce,
          note: '스냅샷 시점 베이스 파일 백업 — 복구: 데이터스토어에 업로드 후 vmx 등록(스냅샷 델타 제외본)', files: manifest,
        }, null, 2));

        // NFS 보존 — destRoot 아래 스탬프 디렉터리(YYYYMMDD-HHMM)만 오래된 순 삭제.
        _running.phase = '보존정책 적용';
        const dirs = fs.readdirSync(destRoot, { withFileTypes: true })
          .filter((e) => e.isDirectory() && /^\d{8}-\d{4}$/.test(e.name)).map((e) => e.name).sort();
        const excess = dirs.length - job.keep;
        let removed = 0;
        for (let i = 0; i < excess; i++) {
          const victim = path.join(destRoot, dirs[i]);
          if (!path.resolve(victim).startsWith(path.resolve(mp) + path.sep)) break; // 이중 방어
          fs.rmSync(victim, { recursive: true, force: true }); removed++;
        }
        done(true, `NFS 백업 완료 — ${wanted.length}파일 ${(bytes / 1024 ** 3).toFixed(2)}GB → ${destDir}${removed ? ` · 보존정책 삭제 ${removed}개` : ''}`);
      }
    } finally {
      if (snapRef) {
        _running.phase = '스냅샷 삭제(병합)';
        try { await removeSnapshot(c, snapRef); }
        catch (e) { snapCleanupErr = ` ⚠ 스냅샷 삭제 실패(${e.message}) — vCenter 에서 수동 삭제 필요('스냅샷 나이 감시' 도구에도 표시됨)`; }
      }
      await c.logout().catch(() => {});
    }
    if (snapCleanupErr) {
      const j = getJob(jobId); // done() 이 이미 기록한 상세에 스냅샷 경고를 덧붙인다
      if (j?.lastRun) recordRun(jobId, { ok: j.lastRun.ok, detail: j.lastRun.detail + snapCleanupErr, ms: j.lastRun.ms });
    }
  } catch (e) {
    done(false, e.message);
  }
}
