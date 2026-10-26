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
 *  - v2.767(점검 R2-B3-2·3·4) NFS 경로·보존 규칙:
 *    · 경로 = <마운트>/<subdir>/<vCenter 슬러그>/<VM 이름 슬러그>__<VM MoRef 슬러그>/<YYYYMMDD-HHMM>/<데이터스토어 슬러그>/<원 경로>.
 *      예전 <마운트>/<subdir>/<VM 이름> 은 다른 vCenter·같은 vCenter 의 동명 VM 잡이 같은 폴더를 써서 보존정책이 서로의 백업을
 *      지웠고, vmName('../web01')이 정제되지 않아 남의 폴더로 들어갔다. 파일은 데이터스토어별 하위 폴더에 원 경로대로 둔다 —
 *      두 데이터스토어의 동명 디스크(web01-flat.vmdk)가 같은 파일로 덮어써지지 않게(manifest 의 file 이 그 상대 경로).
 *    · 보존은 manifest.json 이 있고 그 vcenterId·vmId 가 이 잡과 같은 폴더만 센다·지운다(불완전 폴더·남의 백업 제외).
 *    · 실패한 실행의 불완전 폴더(manifest 없음)는 그 자리에서 지운다(재시작 중단과 같은 cleanupPartialNfs 규칙).
 *    · ⚠ 옛 경로(<마운트>/<subdir>/<VM 이름>)에 남은 이전 백업은 **지우지 않고 그대로 둔다** — 새 보존정책 대상이 아니므로
 *      필요 없으면 직접 지워야 한다. 남아 있으면 실행 결과(lastRun)에 그 사실을 적는다(legacyNfsNote).
 *  - mock 모드(개발): 실제 vCenter 없이 성공 시뮬레이션(2초) — UI/스케줄 개발용.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadVcenterConfig } from '../config.js';
import { store } from '../store.js';
import { getDataSource } from '../runtime-settings.js';
import { logAudit } from '../audit.js';
import {
  getJob, recordRun, pruneList, setRunning, patchRunning, clearRunning, interruptedRunOf,
  RECOVER_RETRY_MS, RECOVER_GIVE_UP_MS, RESUME_LIMIT, RESUME_EXPIRE_MS, patchClone, recordJobEvent, appendBackupPhases, clampKeepDays,
} from './store.js';
import { isMockMode } from '../mock/demo/flags.js';
import { isVmCloneDemoJob } from '../mock/demo/vmclone.js';
import {
  VimSoapClient, createSnapshot, removeSnapshot, parentFolderOf, cloneFromSnapshot,
  destroyClone, vmFilePaths, parseDsPath, backupFileFilter, datacenterPathOf, downloadDsFile,
} from './vsphere.js';
import { getMount, mountedSet, mountPointOf } from '../system/nfsMounts.js';
import { morefOf } from '../vcenter/registry.js';
import { fileStamp, localStamp } from '../util/dayKey.js';   // v2.447: 콜론 포함 vcenterId 안전(감사 B1)
import { xmlUnescape } from '../vcenter/soapParse.js';
import { vcAuthGuard, isVcAuthError } from '../vcenter/restClient.js';
import { authStopView } from '../util/authGuard.js';

// v2.447(감사 B1): 로컬 split(':') 헬퍼 제거 — vcenterId 에 콜론이 있으면 잘못된 MoRef 로
// 스냅샷/클론을 시도하게 된다. 공용 morefOf(id, vcenterId) 사용.
// v2.586 — vCenter 에 남는 클론·스냅샷 이름의 시각은 포탈 시각(KST). 프로세스 TZ(UTC)를 따르면 9시간 어긋난다.
const stamp = () => fileStamp(Date.now());

/**
 * v2.793: 새 사본 크기(커밋 바이트). 못 읽으면 null — 0 으로 적지 않는다(util/numOrNull 규약).
 * vsphere.js 에 같은 함수(vmCommittedBytes)가 있지만 여기서는 import 하지 않는다 — 실행기 테스트들이 vsphere.js 를
 * 정해진 export 목록으로 바꿔 끼우므로(audit2604e·2741a·2767a), 실행기가 새 이름을 import 하면 그 테스트들이 모두 깨진다.
 */
async function committedBytesOf(c, vmRef) {
  try {
    const raw = (await c.retrieveObjectProps('VirtualMachine', vmRef, ['summary.storage.committed']))?.[0]?.props?.['summary.storage.committed'];
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch { return null; }
}

// 전역 실행 큐 — 한 번에 1개(스케줄·수동 공용). 대기 중 목록은 상태 API 로 노출.
// v2.793: 검증·복구·NFS 데이터스토어 연결(vsOps.js)도 같은 큐를 탄다(enqueueOp) — 같은 vCenter·스토리지에 겹쳐 몰리지 않게.
let _chain = Promise.resolve();
const _running = { jobId: null, kind: '', opId: '', phase: '', startedAt: 0 };
const _queue = [];
const _opQueue = [];   // [{ id, kind, jobId, label }]
export function runnerStatus() {
  return {
    running: (_running.jobId || _running.opId) ? { ..._running } : null,
    queued: [..._queue],
    ...(_opQueue.length ? { queuedOps: _opQueue.map((o) => ({ id: o.id, kind: o.kind, jobId: o.jobId || '' })) } : {}),
  };
}

export function enqueueRun(jobId, trigger = 'manual') {
  if ((_running.jobId === jobId && _running.kind === 'backup') || _queue.includes(jobId)) return { queued: false, reason: '이미 실행/대기 중' };
  _queue.push(jobId);
  _chain = _chain.then(() => {
    _queue.splice(_queue.indexOf(jobId), 1);
    return runJob(jobId, trigger).catch(() => {}); // 개별 실패가 체인을 끊지 않게(다음 잡 계속)
  });
  return { queued: true };
}

/**
 * v2.793 — 백업이 아닌 작업(검증·복구·NFS 데이터스토어 연결)을 같은 직렬 큐에 넣는다.
 * fn(setPhase) 는 { ok, detail, … } 를 돌려준다. 던지면 { ok:false, detail } 로 바꾼다 — 큐는 끊기지 않는다.
 * @param {{id:string, kind:string, jobId?:string, label?:string}} desc
 * @returns {Promise<object>} fn 의 결과
 */
export function enqueueOp(desc, fn) {
  const d = { id: String(desc?.id || `op-${Date.now().toString(36)}`), kind: String(desc?.kind || 'op'), jobId: desc?.jobId || '', label: desc?.label || '' };
  _opQueue.push(d);
  return new Promise((resolve) => {
    _chain = _chain.then(async () => {
      _opQueue.splice(_opQueue.indexOf(d), 1);
      Object.assign(_running, { jobId: d.jobId || null, kind: d.kind, opId: d.id, phase: d.label || d.kind, startedAt: Date.now() });
      try { resolve(await fn((p) => { if (_running.opId === d.id) _running.phase = String(p || '').slice(0, 120); })); }
      catch (e) { resolve({ ok: false, detail: String(e?.message || e).slice(0, 400) }); }
      finally { Object.assign(_running, { jobId: null, kind: '', opId: '', phase: '', startedAt: 0 }); }
    });
  });
}

/** 백업 직후 자동 검증(job.verifyAfter) — 같은 큐 뒤에 붙인다. 결과는 원장(clone.verify)과 잡 이력에 남는다. */
function enqueueAutoVerify(jobId, ref) {
  enqueueOp({ id: `auto-verify-${jobId}-${Date.now().toString(36)}`, kind: 'verify', jobId, label: '자동 검증' }, async (setPhase) => {
    const job = getJob(jobId);
    if (!job) return { ok: false, detail: '잡이 지워졌습니다' };
    const { verifyClone } = await import('./vsOps.js');
    const r = await verifyClone(job, ref, { setPhase });
    patchClone(jobId, ref, { verify: { at: Date.now(), ok: r.ok, detail: r.detail } });
    recordJobEvent(jobId, { kind: 'verify', ok: r.ok, detail: r.detail, ms: r.ms, trigger: 'auto', phases: r.phases });
    logAudit({ user: 'vm-clone(auto)', action: r.ok ? 'VM 백업 검증 성공' : 'VM 백업 검증 실패', target: `${job.vcenterId}/${job.vmName}`, detail: String(r.detail).slice(0, 200) });
    return r;
  }).catch(() => {});
}

// v2.604(감사 TIM2604-02): 실행 표시(_running)는 스냅샷 삭제(병합)·로그아웃까지 **다 끝난 뒤** 한 번만 내린다.
//   예전엔 done() 이 내려, 성공 직후 finally 의 스냅샷 병합(최대 수 시간) 동안 상태가 '실행 중 아님' 이었고 그 사이
//   enqueueRun 의 중복 가드(_running.jobId === jobId)가 풀려 같은 잡이 한 번 더 대기열에 올랐다.
async function runJob(jobId, trigger) {
  try { return await runJobBody(jobId, trigger); }
  finally {
    if (_running.jobId === jobId) { _running.jobId = null; _running.kind = ''; _running.phase = ''; }
    // v2.741(감사 TIMING-01): 이 프로세스가 남긴 '실행 중' 기록은 스냅샷 삭제·로그아웃까지 끝난 뒤 내린다(이전 프로세스의 기록은 정리가 끝났을 때만).
    try { clearRunning(jobId); } catch (e) { console.warn(`[vmclone] 실행 기록을 지우지 못했습니다(${e?.message || e})`); }
  }
}

// ── v2.741(감사 TIMING-01) 재시작으로 중단된 실행의 뒷정리 ─────────────────────────
// 실행 중 기록(store.setRunning)이 이전 프로세스의 것으로 남아 있으면, 다음 실행은 새 스냅샷을 만들기 **전에** 그 실행이 만든 스냅샷을 지운다.
// 못 지우면(클론·병합 태스크가 vCenter 에서 아직 도는 중 · vCenter 불통) 새 스냅샷을 만들지 않고 RECOVER_RETRY_MS 뒤 다시 시도한다.

/**
 * VM 'snapshot'(VirtualMachineSnapshotInfo) XML → [{ref, name}] (순수 — 테스트 고정).
 * 트리 노드마다 snapshot → vm → name 순서다(vim25 VirtualMachineSnapshotTree). currentSnapshot 은 태그 이름이 달라 섞이지 않는다.
 */
export function snapshotTreeList(xml) {
  const out = [];
  const re = /<snapshot type="VirtualMachineSnapshot">([^<]+)<\/snapshot>\s*<vm\b[^>]*>[^<]*<\/vm>\s*<name>([^<]*)<\/name>/g;
  const s = String(xml || '');
  let m;
  while ((m = re.exec(s)) && out.length < 1000) out.push({ ref: m[1].trim(), name: xmlUnescape(m[2]) });
  return out;
}

const NOT_FOUND_RE = /notfound|not found|managedobject/i; // destroyClone 과 같은 판정 — VM 자체가 없어졌다
const SNAPSHOT_TASK_WAIT_MS = 20 * 60_000;              // 스냅샷 생성 태스크 시한(15분, vsphere.createSnapshot) + 여유
const snapLabel = (st) => (st?.snapName ? `스냅샷 ‘${st.snapName}’` : '스냅샷');
// 중단 당시 클론을 만들던 중이었다면 그 클론은 vCenter 에서 끝났을 수 있다 — 원장에 기록되지 않아 보존정책이 지우지 않는다(이름 패턴으로 찾아 지우지 않는다 — store.js 규칙).
const cloneNoteOf = (st) => (st?.phase === 'clone' && st.cloneName ? ` · 중단 당시 만들던 클론 ‘${st.cloneName}’ 은 vCenter 에서 끝났을 수 있습니다 — 원장에 없어 보존정책이 지우지 않으니 확인하세요` : '');

/**
 * 그 실행이 만든 스냅샷(기록한 ref, 없으면 기록한 이름)만 찾아 지운다 — 다른 portal-clone-* 스냅샷(다른 포탈·사람이 만든 것)은 건드리지 않는다.
 * @returns {Promise<{ok:boolean, note?:string, error?:string}>}
 */
async function cleanupInterruptedSnapshot(c, vmRef, st) {
  if (!st.snapRef && !st.snapName) return { ok: true, note: '스냅샷을 만들기 전에 중단됐습니다' };
  let objs;
  try { objs = await c.retrieveObjectProps('VirtualMachine', vmRef, ['snapshot']); }
  catch (e) {
    if (NOT_FOUND_RE.test(String(e?.message || ''))) return { ok: true, note: '원본 VM 을 찾을 수 없습니다(지워졌거나 옮겨졌습니다)' };
    return { ok: false, error: String(e?.message || e) };
  }
  const list = snapshotTreeList(objs?.[0]?.props?.snapshot);
  const hit = list.find((x) => (st.snapRef ? x.ref === st.snapRef : x.name === st.snapName));
  if (!hit) {
    // ref 를 적기 전에 끊겼다(스냅샷 생성 중) — vCenter 의 생성 태스크가 아직 돌고 있으면 트리에 없다가 나중에 생긴다.
    //   그 태스크 시한(vsphere.createSnapshot 15분) + 여유가 지나기 전에는 '없다' 고 단정하지 않고 기다린다.
    if (!st.snapRef && st.phase === 'snapshot' && Date.now() - (Number(st.at) || 0) < SNAPSHOT_TASK_WAIT_MS) {
      return { ok: false, error: '스냅샷 생성 태스크가 vCenter 에서 아직 끝나지 않았을 수 있어 기다립니다' };
    }
    return { ok: true, note: st.snapRef ? `남은 ${snapLabel(st)} 없음(이미 지워졌습니다)` : `남은 ${snapLabel(st)} 을 찾지 못했습니다(만들기 전에 중단됐거나 이미 지워졌습니다)` };
  }
  try { await removeSnapshot(c, hit.ref); }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
  return { ok: true, note: `남은 스냅샷 ‘${hit.name}’ 을 지웠습니다` };
}

/** 중단된 NFS 백업의 불완전 폴더(manifest 없음)를 지운다 — 보존 개수에 끼어 온전한 백업을 먼저 밀어내지 않게. 기록한 그 폴더만. */
export function cleanupPartialNfs(job, st) {
  if (job.dest?.type !== 'nfs' || !st.destDir) return '';
  try {
    const mount = getMount(job.dest.mountId);
    const mp = mount ? mountPointOf(mount.id) : null;
    if (!mp || !mountedSet().has(mp)) return ' · 중단된 NFS 백업 폴더는 마운트가 없어 확인하지 못했습니다';
    const bakDir = path.resolve(st.destDir);   // ⚠ 변수 이름을 dir 로 두지 말 것 — scripts/config-doc.mjs 가 dir 기준 경로 조립을 CONFIG_DIR 파일로 읽는다
    if (!bakDir.startsWith(path.resolve(mp) + path.sep) || !/^\d{8}-\d{4}$/.test(path.basename(bakDir))) return ' · 중단된 NFS 백업 폴더가 마운트 지점 밖이라 건드리지 않았습니다';
    if (!fs.existsSync(bakDir) || fs.existsSync(path.join(bakDir, 'manifest.json'))) return ''; // 없거나 끝까지 받은 백업 — 그대로 둔다
    fs.rmSync(bakDir, { recursive: true, force: true });
    return ` · 중단된 NFS 백업의 불완전 폴더 ${path.basename(bakDir)} 를 지웠습니다(manifest 없음)`;
  } catch (e) { return ` · 중단된 NFS 백업 폴더를 정리하지 못했습니다(${e?.message || e})`; }
}

// ── v2.767(점검 R2-B3-2·3·4) NFS 백업 경로·보존 (순수에 가깝게 — audit2767a 가 임시 폴더로 고정) ─────────────────────
const STAMP_RE = /^\d{8}-\d{4}$/;
/** 파일·폴더 이름 하나로 안전한 슬러그 — 영숫자 . _ - 만, 선행 점은 '_'(‘..’·숨김 폴더 금지), 빈 값은 '_'. 길이를 먼저 자른다(선형). */
export function pathSlug(v, max = 64) {
  const s = String(v ?? '').slice(0, max * 4).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, max);
  return s || '_';
}
/** 잡의 NFS 백업 루트(스탬프 폴더들의 부모) — vCenter·VM(MoRef) 별로 갈라 동명 VM 잡이 겹치지 않게. */
export function nfsBackupRoot(mp, job) {
  const moref = morefOf(job.vmId, job.vcenterId) || job.vmId;
  return path.join(mp, job.dest?.subdir || '', pathSlug(job.vcenterId, 100), `${pathSlug(job.vmName)}__${pathSlug(moref)}`);
}
/** 데이터스토어 파일의 백업 대상 경로 — <destDir>/<DS 슬러그>/<원 경로 각 단계 슬러그>. destDir 밖이면 null. */
export function nfsFileTarget(destDir, pd) {
  const parts = String(pd?.rel || '').split('/').filter(Boolean).map((x) => pathSlug(x, 255));
  if (!parts.length) return null;
  const target = path.join(destDir, pathSlug(pd.ds, 100), ...parts);
  return path.resolve(target).startsWith(path.resolve(destDir) + path.sep) ? target : null;
}
/**
 * 이 잡이 만든 온전한 백업인가 — manifest.json 이 있고 vcenterId·vmId 가 같을 때만(읽지 못하면 '아니다' — 지우지 않는다).
 * v2.794: 맞으면 manifest 의 시각(ms — 못 읽으면 0)을 돌려준다(보존 기간 판정). 아니면 null.
 */
function ownedBackupAt(bakDir, job) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(bakDir, 'manifest.json'), 'utf8'));
    if (!m || m.vcenterId !== job.vcenterId || m.vmId !== job.vmId) return null;
    const at = Date.parse(m.at);
    return Number.isFinite(at) ? at : 0;
  } catch { return null; }
}
/**
 * NFS 보존 — destRoot 아래 스탬프 폴더 중 **이 잡의 온전한 백업만** 세어 keep 초과분을 오래된 순으로 지운다.
 * 마운트 지점 밖이면 아무것도 지우지 않는다(이중 방어). @returns {string[]} 지운 폴더 이름
 */
export function pruneNfsBackups(mp, destRoot, job) {
  const mpAbs = path.resolve(mp) + path.sep;
  if (!path.resolve(destRoot).startsWith(mpAbs)) return [];
  let names = [];
  try { names = fs.readdirSync(destRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && STAMP_RE.test(e.name)).map((e) => e.name); }
  catch { return []; }
  // 폴더 이름(스탬프) 순 = 시간 순. 개수 초과분 + v2.794 보존 기간이 지난 것(가장 최근 1개는 남긴다 · 시각을 모르면 기간으로 지우지 않는다 — pruneList 와 같은 규칙).
  const mine = names.map((n) => ({ name: n, at: ownedBackupAt(path.join(destRoot, n), job) })).filter((x) => x.at != null)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const excess = mine.length - (Number(job.keep) || 1);
  const days = clampKeepDays(job.keepDays);
  const cutoff = Date.now() - days * 86_400_000;
  const victims = new Set(mine.filter((x, i) => i < excess || (days && i < mine.length - 1 && x.at > 0 && x.at < cutoff)).map((x) => x.name));
  const removed = [];
  for (const x of mine) {
    if (!victims.has(x.name)) continue;
    const victim = path.join(destRoot, x.name);
    if (!path.resolve(victim).startsWith(mpAbs)) break; // 이중 방어
    fs.rmSync(victim, { recursive: true, force: true }); removed.push(x.name);
  }
  return removed;
}
/** 옛 경로(<마운트>/<subdir>/<VM 이름>)에 이전 백업이 남아 있으면 그 사실을 한 줄로(지우지 않는다). 없거나 마운트 밖이면 ''. */
export function legacyNfsNote(mp, job) {
  try {
    const old = path.join(mp, job.dest?.subdir || '', String(job.vmName || ''));
    if (!job.vmName || !path.resolve(old).startsWith(path.resolve(mp) + path.sep) || !fs.existsSync(old)) return '';
    const n = fs.readdirSync(old, { withFileTypes: true }).filter((e) => e.isDirectory() && STAMP_RE.test(e.name)).length;
    return n ? ` · 이전 판의 경로(${path.join(job.dest?.subdir || '', job.vmName)})에 남은 백업 ${n}개는 새 보존정책 대상이 아니라 지우지 않았습니다 — 필요 없으면 직접 지우세요` : '';
  } catch { return ''; }
}

/**
 * 정리를 미룬다 — 다음 시도 시각을 적는다. RECOVER_GIVE_UP_MS 가 지났으면 기록을 내리고 수동 삭제를 안내한다(보류에는 시한).
 * @returns {{gaveUp:boolean, text:string}} lastRun 에 붙일 문장
 */
function postponeRecovery(jobId, st, why) {
  const now = Date.now();
  const w = String(why || '').slice(0, 200);
  if (now - (Number(st.detectedAt) || now) >= RECOVER_GIVE_UP_MS) {
    clearRunning(jobId, { anyBoot: true });
    console.warn(`[vmclone] ${jobId}: 재시작으로 중단된 실행의 ${snapLabel(st)} 정리를 그만뒀습니다(${w}) — vCenter 에서 수동 삭제 필요`);
    return { gaveUp: true, text: `재시작으로 중단된 실행의 ${snapLabel(st)} 을 ${Math.round(RECOVER_GIVE_UP_MS / 3_600_000)}시간 동안 지우지 못해 그만뒀습니다(${w}) — vCenter 에서 수동으로 삭제하세요('스냅샷 나이 감시' 도구에도 보입니다). 다음 실행은 평소대로 합니다${cloneNoteOf(st)}.` };
  }
  // detectedAt 이 없으면(기동 표시 전에 누른 실행) 지금부터 시한을 센다 — 없는 채로 두면 영영 포기하지 않는다.
  patchRunning(jobId, { tries: (Number(st.tries) || 0) + 1, nextAt: now + RECOVER_RETRY_MS, lastError: w, detectedAt: Number(st.detectedAt) || now }, { anyBoot: true });
  return { gaveUp: false, text: `재시작으로 중단된 실행의 ${snapLabel(st)} 을 아직 지우지 못했습니다(${w}) — 클론·병합 태스크가 vCenter 에서 아직 돌고 있을 수 있습니다. ${Math.round(RECOVER_RETRY_MS / 60_000)}분 뒤 다시 시도하고, 그 전에는 새 스냅샷을 만들지 않습니다.` };
}

async function runJobBody(jobId, trigger) {
  const job = getJob(jobId);
  if (!job || !job.enabled) return;
  if (job.suspended) { recordRun(jobId, { ok: false, skipped: 'suspended', trigger, ms: 0, detail: `멈춘 위임 잡 — ${job.suspended}` }); return; }   // v2.793 F3
  // v2.719(감사 R1-07 후속): live 에서는 데모 잡(가짜 vCenter·사본)을 수동 실행으로도 돌리지 않는다 — 실패 기록·감사 로그만 쌓인다.
  if (!isMockMode() && isVmCloneDemoJob(job)) {
    recordRun(jobId, { ok: false, skipped: 'demo-job', detail: '데모(mock) 모드에서 만든 잡이라 실행하지 않았습니다 — 지우고 실제 VM 으로 새로 만드세요.', ms: 0 });
    return;
  }
  _running.jobId = jobId; _running.kind = 'backup'; _running.opId = ''; _running.startedAt = Date.now();
  // v2.793: 단계 기록(화면의 세션 타임라인) — 같은 이름이 이어지면 하나로 합친다(다운로드 파일마다 줄이 생기지 않게).
  const phases = []; let curPh = null;
  const closePhase = () => { if (curPh) { const ms = Date.now() - curPh.t; const prev = phases[phases.length - 1]; if (prev && prev.n === curPh.n) prev.ms += ms; else phases.push({ n: curPh.n, ms }); curPh = null; } };
  const setPhase = (label) => { closePhase(); _running.phase = label; curPh = { n: String(label).slice(0, 200).replace(/\s+\d+\/\d+\s+—.*$/, '').replace(/\s+→.*$/, '').slice(0, 60), t: Date.now() }; };
  setPhase('시작');
  const t0 = Date.now();
  const stale = interruptedRunOf(job); // v2.741(TIMING-01): 이전 프로세스가 끝내지 못한 실행 — 새 스냅샷을 만들기 전에 정리한다
  let recoveryNote = '';              // 정리 결과(이번 실행 결과 뒤에 붙인다)
  let recovered = !stale;             // 정리를 마쳤는가(그 뒤의 실패는 이번 실행의 실패다 — 정리를 다시 미루지 않는다)
  let nfsDestDir = '';                // v2.767(R2-B3-3): 이번 실행의 NFS 백업 폴더 — 실패하면 불완전 폴더를 지운다
  let recordedPhases = 0;             // done() 이 이력에 적은 단계 수 — 그 뒤(스냅샷 병합)는 끝난 뒤 덧붙인다
  const done = (ok, detail, extra = {}) => {
    detail = `${detail}${recoveryNote}`;
    closePhase();
    recordedPhases = phases.length;
    recordRun(jobId, { ok, detail, ms: Date.now() - t0, trigger, phases, ...extra });
    logAudit({ user: `vm-clone(${trigger})`, action: ok ? 'VM 복제 성공' : 'VM 복제 실패', target: `${job.vcenterId}/${job.vmName}`, detail: String(detail).slice(0, 200) });
    // _running 은 여기서 내리지 않는다 — runJob 의 finally 가 스냅샷 병합·로그아웃 뒤에 내린다(TIM2604-02).
  };

  try {
    const vcCfg = (loadVcenterConfig().vcenters || []).find((v) => v.id === job.vcenterId);
    // mock 모드(개발·데모): 실제 vCenter 없이 성공 시뮬레이션 — 스케줄/보존/UI 흐름 검증용.
    // v2.604: 예전 판정 `config.mode` 는 **존재하지 않는 필드**라 항상 거짓이었다 — 목 모드에서도 vCenter 설정이 있으면 실제
    //   스냅샷·클론을 돌렸고, 반대로 live 에서 vCenter 설정이 없으면 오류 대신 '복제 성공'(시뮬레이션)이 기록됐다.
    //   판정은 수집(store.js)과 같은 getDataSource() === 'mock' 이다('auto' 는 실수집).
    const mock = getDataSource() === 'mock';
    if (!vcCfg || mock) {
      if (stale && mock) {
        // 데모(mock) 모드는 vCenter 에 접속하지 않는다 — 정리하지 못한 사실을 남기고 기록을 내린다(지어내지 않는다).
        // vCenter 설정이 없는 live 는 아래 catch 가 정리를 미룬다(설정 파일을 잠깐 못 읽은 것일 수 있다 — 시한 뒤 수동 삭제 안내).
        clearRunning(jobId, { anyBoot: true }); recovered = true;
        recoveryNote = ` · 재시작으로 중단된 실행의 ${snapLabel(stale)} 은 데모(mock) 모드라 확인하지 못했습니다 — vCenter 에서 직접 확인하세요`;
      }
      if (!mock) throw new Error(`vCenter 설정을 찾을 수 없습니다: ${job.vcenterId}`);
      setPhase('시뮬레이션(mock)');
      await new Promise((r) => setTimeout(r, 2000));
      const name = `${job.vmName}-bak-${stamp()}`;
      const ref = `mock-${Date.now()}`; const at = Date.now();
      // v2.793: 데모 사본 크기 — 인벤토리의 VM 프로비저닝 크기에서(씬 사용량을 흉내 낸 0.6배). 모르면 싣지 않는다.
      const inv = (store.get()?.vms || []).find((v) => v.id === job.vmId);
      const gb = Number(inv?.storageGB);
      const bytes = inv && Number.isFinite(gb) && gb > 0 ? Math.round(gb * 0.6 * 1024 ** 3) : null;
      const removed = pruneList([...job.clones, { name, ref, at }], job.keep, job.keepDays);
      done(true, `mock 복제 완료 — ${name}${removed.length ? ` · 보존정책 삭제 ${removed.length}개` : ''}`,
        { addClone: { name, ref, at, ...(bytes != null ? { bytes } : {}) }, removeCloneRefs: removed.map((c) => c.ref) });
      if (job.dest.type === 'datastore' && job.verifyAfter) enqueueAutoVerify(jobId, ref);
      return;
    }

    // v2.793: 엣지 위임(site) vCenter 는 이 노드가 로그인하지 않는다 — 담당 엣지가 위임 잡으로 실행한다(central/vmCloneEdge.js).
    //   스케줄러가 이미 거르고 화면의 '지금 실행' 은 엣지로 보내므로 여기 오는 것은 예외 경로다 — 조용히 넘기지 않고 남긴다.
    if (vcCfg.collectMode === 'site') {   // collectMode 로 본다 — 점검중·꺼진 위임 vCenter 도 위임이다(반증 검토 F1)
      recordRun(jobId, { ok: false, skipped: 'delegated', trigger, ms: 0, detail: '이 vCenter 는 엣지 위임(site) 수집이라 이 포탈은 로그인하지 않습니다 — 담당 엣지가 실행합니다.' });
      return;
    }
    const vmRef = morefOf(job.vmId, job.vcenterId);
    if (!vmRef) throw new Error('VM MoRef 해석 실패');
    // v2.591(감사 F1): 인벤토리 수집과 같은 vCenter 계정이다. 그 계정이 인증 실패로 멈춰 있으면 **스케줄 실행**은
    //   로그인하지 않는다(읽기 전용 조회 — 해제는 주 폴러·연결 테스트만). 수동 '지금 실행' 은 막지 않는다.
    //   조용히 건너뛰지 않는다 — 실행 기록(lastRun)에 사유·정지 기록을 남긴다(다음 스케줄은 평소대로 도래한다).
    // v2.741: 재시작 뒤 자동 정리·재실행(resume)도 사람이 누른 실행이 아니므로 같은 규칙이다.
    if (trigger === 'schedule' || trigger === 'resume') {
      const st = vcAuthGuard.peekAuthStop(vcCfg);
      if (st) {
        let detail = `건너뜀 — vCenter 인증 실패로 주기 수집이 멈춰 있어 스케줄 실행을 하지 않았습니다(실패 ${st.attempts}회). 비밀번호를 고치거나 설정 › vCenter 의 연결 테스트가 성공하면 다시 실행합니다. '지금 실행' 은 막지 않습니다.`;
        if (stale) detail += ` ${postponeRecovery(jobId, stale, 'vCenter 인증 실패 정지').text}`;
        recordRun(jobId, { ok: false, detail, ms: Date.now() - t0, skipped: 'auth-stopped', authStopped: authStopView(st) });
        logAudit({ user: `vm-clone(${trigger})`, action: 'VM 복제 건너뜀(인증 정지)', target: `${job.vcenterId}/${job.vmName}`, detail: detail.slice(0, 200) });
        console.warn(`[vmclone] ${job.vcenterId}/${job.vmName}: vCenter 인증 실패 정지 — 스케줄 실행 건너뜀(${st.attempts}회)`);
        _running.jobId = null; _running.phase = '';
        return;
      }
    }
    const c = new VimSoapClient(vcCfg);
    try { await c.login(); }
    catch (e) {
      // v2.591: 로그인 거부면 주 폴러와 같은 정지 기록에 시도를 올린다(화면의 시도 횟수가 정직해지게).
      if (isVcAuthError(e)) vcAuthGuard.markAuthStopped(vcCfg.id, vcCfg, e.message);
      throw e;
    }
    if (stale) {
      setPhase('재시작 정리(남은 스냅샷)');
      const r = await cleanupInterruptedSnapshot(c, vmRef, stale);
      if (!r.ok) {
        // 새 스냅샷을 겹쳐 만들지 않는다 — 다음 시도까지 이 잡은 실행하지 않는다.
        const p = postponeRecovery(jobId, stale, r.error);
        recordRun(jobId, { ok: false, skipped: p.gaveUp ? 'restart-cleanup-gave-up' : 'restart-cleanup-pending', detail: p.text, ms: Date.now() - t0 });
        if (p.gaveUp) logAudit({ user: `vm-clone(${trigger})`, action: 'VM 복제 재시작 정리 포기', target: `${job.vcenterId}/${job.vmName}`, detail: p.text.slice(0, 200) });
        await c.logout().catch(() => {});
        return;
      }
      clearRunning(jobId, { anyBoot: true }); recovered = true;
      recoveryNote = ` · 재시작 정리: ${r.note}${cleanupPartialNfs(job, stale)}${cloneNoteOf(stale)}`;
      // 자동 재실행은 사슬마다 RESUME_LIMIT 번 · 시작 RESUME_EXPIRE_MS 이내만 — 사람이 누른 실행·정규 스케줄은 그대로 한다.
      const atLimit = (Number(stale.resumes) || 0) >= RESUME_LIMIT;
      const tooOld = Number(stale.at) > 0 && Date.now() - Number(stale.at) > RESUME_EXPIRE_MS;
      if (trigger === 'resume' && (atLimit || tooOld)) {
        const detail = `재시작으로 중단된 실행을 정리했습니다${recoveryNote.replace(' · 재시작 정리', '')} — ${atLimit ? `자동 재실행 상한(${RESUME_LIMIT}번)에 닿아` : '시작한 지 48시간이 넘어'} 다시 실행하지 않습니다. 다음 실행은 평소대로 합니다.`;
        recordRun(jobId, { ok: false, skipped: 'restart-interrupted', detail, ms: Date.now() - t0 });
        await c.logout().catch(() => {});
        return;
      }
    }
    let snapRef = null;
    let snapCleanupErr = '';
    let autoVerifyRef = '';
    try {
      setPhase(`스냅샷 생성${job.quiesce ? '(정지점)' : ''}`);
      // v2.741(TIMING-01): 스냅샷을 요청하기 **전에** 실행 중 기록을 동기로 남긴다 — 곧바로 재시작이 와도 다음 기동이 이 스냅샷을 찾아 지운다.
      const snapName = `portal-clone-${stamp()}`;
      setRunning(jobId, { trigger, vmRef, snapName, phase: 'snapshot', resumes: trigger === 'resume' && stale ? (Number(stale.resumes) || 0) + 1 : 0 });
      snapRef = await createSnapshot(c, vmRef, { name: snapName, quiesce: job.quiesce });
      patchRunning(jobId, { snapRef });

      if (job.dest.type === 'datastore') {
        // 대상 데이터스토어 MoRef — 수집 스냅샷에서 이름으로 해석(provision 과 동일 방식).
        const ds = store.get().datastores.find((d) => d.vcenterId === job.vcenterId && d.name === job.dest.datastoreName);
        if (!ds) throw new Error(`대상 데이터스토어를 찾을 수 없습니다: ${job.dest.datastoreName}`);
        const folder = await parentFolderOf(c, vmRef);
        if (!folder) throw new Error('원본 VM 폴더 조회 실패');
        const cloneName = `${job.vmName}-bak-${stamp()}`;
        setPhase(`클론 → ${job.dest.datastoreName}`);
        patchRunning(jobId, { phase: 'clone', cloneName });
        const newRef = await cloneFromSnapshot(c, { vmRef, folderRef: folder, name: cloneName, dsRef: morefOf(ds.id, job.vcenterId), snapshotRef: snapRef });
        const cloneBytes = await committedBytesOf(c, newRef);   // v2.793: 사본 크기(못 읽으면 null — 0 으로 적지 않는다)

        // 보존정책 — 원장 기준(이름 패턴 아님), 켜져 있는 클론은 건너뛰고 보고.
        setPhase('보존정책 적용');
        const ledger = [...job.clones, { name: cloneName, ref: newRef, at: Date.now() }];
        const toDelete = pruneList(ledger, job.keep, job.keepDays);
        const removedRefs = []; const skipped = [];
        for (const old of toDelete) {
          try { await destroyClone(c, old.ref, { expectedName: old.name }); removedRefs.push(old.ref); }   // v2.767(R2-B3-6): 이름 대조
          catch (e) { skipped.push(`${old.name}: ${e.message}`); }
        }
        done(true, `클론 완료 — ${cloneName} → [${job.dest.datastoreName}]` +
          (removedRefs.length ? ` · 보존정책 삭제 ${removedRefs.length}개` : '') +
          (skipped.length ? ` · 삭제 건너뜀 ${skipped.length}건(${skipped[0]})` : ''),
          { addClone: { name: cloneName, ref: newRef, at: Date.now(), ...(cloneBytes != null ? { bytes: cloneBytes } : {}) }, removeCloneRefs: removedRefs });
        if (job.verifyAfter) autoVerifyRef = newRef;   // 스냅샷 병합·로그아웃이 끝난 뒤 큐에 넣는다
      } else {
        // NFS 파일 백업 — 마운트 상태 필수(끊겨 있으면 즉시 실패: NAS 에 안 쓰고 로컬 디스크를
        // 채우는 사고 방지 — containment 이전에 마운트 여부부터 확인한다).
        const mount = getMount(job.dest.mountId);
        if (!mount) throw new Error('NFS 마운트 항목이 없습니다(설정 › NFS 마운트).');
        const mp = mountPointOf(mount.id);
        if (!mountedSet().has(mp)) throw new Error(`NFS 가 마운트되어 있지 않습니다: ${mp} — 설정 › NFS 마운트에서 마운트하세요.`);
        const destRoot = nfsBackupRoot(mp, job);
        const destDir = path.join(destRoot, stamp());
        // 경로 탈출 방지 — 최종 경로가 마운트 지점 아래인지 검증(subdir·이름은 슬러그화됐지만 이중 방어).
        if (!path.resolve(destDir).startsWith(path.resolve(mp) + path.sep)) throw new Error('백업 경로가 마운트 지점을 벗어납니다(차단).');
        // 같은 분(스탬프)에 만든 폴더가 이미 있으면 겹쳐 쓰지 않는다 — 온전한 백업 위에 일부만 덮이거나, 실패 정리가 남의 폴더를 만지지 않게.
        if (fs.existsSync(destDir)) throw new Error(`같은 시각(${path.basename(destDir)})의 백업 폴더가 이미 있습니다 — 1분 뒤 다시 실행하세요.`);
        nfsDestDir = destDir;

        patchRunning(jobId, { phase: 'download', destDir });
        setPhase('파일 목록 조회');
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
          setPhase(`다운로드 ${i + 1}/${wanted.length} — ${pd.rel.split('/').pop()}`);
          // v2.767(R2-B3-4): 데이터스토어별 하위 폴더 + 원 경로 — 두 데이터스토어의 동명 디스크가 같은 파일로 덮어써지지 않게.
          const dest = nfsFileTarget(destDir, pd);
          if (!dest) throw new Error(`백업 대상 경로를 만들 수 없습니다: ${wanted[i]}`);
          const sz = await downloadDsFile(c, vcCfg, { dcPath, ds: pd.ds, rel: pd.rel, destFile: dest });
          bytes += sz; manifest.push({ src: wanted[i], file: path.relative(destDir, dest).split(path.sep).join('/'), bytes: sz });
        }
        fs.writeFileSync(path.join(destDir, 'manifest.json'), JSON.stringify({
          vm: job.vmName, vcenterId: job.vcenterId, vmId: job.vmId, at: new Date().toISOString(), quiesce: job.quiesce, layout: 2,
          note: '스냅샷 시점 베이스 파일 백업(스냅샷 델타 제외본) — 파일은 <데이터스토어>/<원 경로> 폴더에 있다. 복구: 각 file 을 src(원 데이터스토어 경로)의 데이터스토어·폴더로 업로드한 뒤 vmx 등록(vmx 가 다른 데이터스토어의 디스크를 [DS] 경로로 가리키므로 원래 배치대로 올릴 것)',
          files: manifest,
        }, null, 2));

        // NFS 보존 — 이 잡의 온전한 백업(manifest 의 vcenterId·vmId 일치)만 세어 오래된 순 삭제.
        setPhase('보존정책 적용');
        const removed = pruneNfsBackups(mp, destRoot, job).length;
        done(true, `NFS 백업 완료 — ${wanted.length}파일 ${(bytes / 1024 ** 3).toFixed(2)}GB → ${destDir}${removed ? ` · 보존정책 삭제 ${removed}개` : ''}${legacyNfsNote(mp, job)}`);
      }
    } finally {
      if (snapRef) {
        setPhase('스냅샷 삭제(병합)');
        patchRunning(jobId, { phase: 'remove-snapshot' });
        try { await removeSnapshot(c, snapRef); }
        catch (e) { snapCleanupErr = ` ⚠ 스냅샷 삭제 실패(${e.message}) — vCenter 에서 수동 삭제 필요('스냅샷 나이 감시' 도구에도 표시됨)`; }
      }
      await c.logout().catch(() => {});
    }
    // v2.793: done() 뒤의 단계(스냅샷 병합)를 같은 이력 줄에 덧붙인다.
    closePhase();
    if (phases.length > recordedPhases) appendBackupPhases(jobId, phases.slice(recordedPhases));
    if (snapCleanupErr) {
      const j = getJob(jobId); // done() 이 이미 기록한 상세에 스냅샷 경고를 덧붙인다
      if (j?.lastRun) recordRun(jobId, { ok: j.lastRun.ok, detail: j.lastRun.detail + snapCleanupErr, ms: j.lastRun.ms, history: false });
    }
    if (autoVerifyRef) enqueueAutoVerify(jobId, autoVerifyRef);
  } catch (e) {
    // v2.741: 정리를 마치기 전의 실패(vCenter 불통·로그인 실패)면 정리를 미룬다 — 다음 틱마다 다시 로그인하지 않게.
    if (stale && !recovered) recoveryNote = ` · ${postponeRecovery(jobId, stale, e.message).text}`;
    // v2.767(R2-B3-3): 실패한 NFS 백업의 불완전 폴더(manifest 없음)는 지운다 — 남기면 다음 보존 계산·복구 때 온전한 백업으로 오인된다.
    const partialNote = nfsDestDir ? cleanupPartialNfs(job, { destDir: nfsDestDir }).replace('중단된 NFS 백업', '실패한 NFS 백업') : '';
    done(false, `${e.message}${partialNote}`);
  }
}
