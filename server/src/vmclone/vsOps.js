/**
 * vmclone/vsOps.js — VM 백업 센터의 vCenter 작업(v2.793): 사본 검증 · 새 VM 으로 복구 · ESXi NFS 데이터스토어 연결.
 *
 * 사용자 요구(2026-10-26): "VM 복제(백업) 도구를 Veeam 처럼" — 복원 지점을 켜서 확인하고(SureBackup 식), 복원 지점에서 새 VM 을
 * 만들고, 법인 NFS 를 ESXi 데이터스토어로 붙여 서버측 클론 대상으로 쓴다.
 *
 * 실행 위치: 그 vCenter 에 **직접 로그인하는 노드**(중앙 직접 수집 vCenter 는 중앙, 사이트 위임 vCenter 는 담당 엣지).
 *   로그인은 `onDemandLogin`(vcenter/dsBrowse.js) 하나로 한다 — 위임(site)·꺼짐·점검중·인증 정지 vCenter 에는 로그인하지 않는다.
 *   큐는 runner.js 의 직렬 큐(enqueueOp)를 함께 탄다 — 백업·검증·복구가 같은 vCenter·스토리지에 겹쳐 몰리지 않게.
 *
 * 안전 규칙(되돌리지 말 것):
 *  · **NIC 를 끊었다고 다시 읽어 확인하기 전에는 켜지 않는다**(vsphere.disconnectAllNics). 사본·복구 VM 은 원본과 IP·호스트명·
 *    AD 컴퓨터 계정이 같다 — 원본이 살아 있는 망에 붙으면 운영 장애가 난다.
 *  · 검증은 사본에 **검증용 스냅샷**을 먼저 만들고 끝나면 그 스냅샷으로 되돌린 뒤 지운다 — 켜는 동안의 쓰기(로그·파일시스템 재생)가
 *    복원 지점을 바꾸지 않게. 되돌리기에 실패하면 결과에 그대로 적는다(조용히 성공으로 두지 않는다).
 *  · 원장(job.clones)에 없는 ref 는 다루지 않는다. ref 가 원장 이름과 다른 VM 을 가리키면 손대지 않는다(destroyClone 과 같은 규칙 —
 *    vCenter 재설치 뒤 MoRef 가 다른 VM 을 가리킬 수 있다).
 *  · 복구는 **새 VM** 만 만든다(원본 덮어쓰기 없음). 복구 VM 은 보존정책 원장에 넣지 않는다(지워지지 않게).
 */

import { loadVcenterConfig } from '../config.js';
import { store } from '../store.js';
import { getDataSource } from '../runtime-settings.js';
import { morefOf } from '../vcenter/registry.js';
import { onDemandLogin } from '../vcenter/dsBrowse.js';
import { fileStamp } from '../util/dayKey.js';
import { demoHash } from '../mock/demo/flags.js';
import {
  VimSoapClient, createSnapshot, removeSnapshot, parentFolderOf, cloneFromSnapshot, vmStateOf, disconnectAllNics,
  powerOnVm, powerOffVm, waitToolsRunning, revertToSnapshot, attachNasToHost, detachNasFromHost, validateNfsDsSpec, vmCommittedBytes, nicDisconnectSpec,
} from './vsphere.js';
import {
  getJob, setVerifying, patchVerifying, clearVerifying, handOffVerifying, interruptedVerifyOf, patchClone, recordJobEvent,
  RECOVER_RETRY_MS, RECOVER_GIVE_UP_MS,
} from './store.js';
import { snapshotTreeList } from './runner.js';
import { logAudit } from '../audit.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const vcNameNorm = (s) => String(s ?? '').replace(/%(2f|5c|25)/gi, (m) => decodeURIComponent(m));
const envMin = (k, d, lo, hi) => { const n = Number(process.env[k]); return Math.max(lo, Math.min(hi, Number.isFinite(n) && n > 0 ? n : d)); };
/** 검증에서 VMware Tools 응답을 기다리는 시한(분) — 기본 10, 2~60. */
export const VERIFY_TIMEOUT_MIN = envMin('VMCLONE_VERIFY_TIMEOUT_MIN', 10, 2, 60);

/** 단계 기록기 — 화면의 세션 타임라인([{n, ms, ok?}]). setPhase 는 실행 상태(runnerStatus)의 문구도 바꾼다. */
export function phaseRecorder(setPhase = () => {}) {
  const list = [];
  let cur = null;
  const close = (ok) => { if (cur) { list.push({ n: cur.n, ms: Date.now() - cur.t, ...(ok === false ? { ok: false } : {}) }); cur = null; } };
  return {
    step(n) { close(); cur = { n, t: Date.now() }; try { setPhase(n); } catch { /* 표시용 */ } },
    end(ok = true) { close(ok); return list; },
  };
}

function vcOf(vcenterId) {
  const vc = (loadVcenterConfig().vcenters || []).find((v) => v.id === vcenterId);
  if (!vc) throw new Error(`vCenter 설정을 찾을 수 없습니다: ${vcenterId}`);
  return vc;
}

/** 원장 사본 확인 — 원장에 없으면 throw. */
function ledgerClone(job, ref) {
  const c = (job?.clones || []).find((x) => x.ref === ref);
  if (!c) throw new Error('이 잡의 복원 지점(원장)에 없는 사본입니다 — 보존정책으로 지워졌거나 다른 잡의 사본입니다');
  return c;
}

/**
 * 복구 입력 검증(순수에 가깝다 — 인벤토리 스냅샷을 인자로 받는다). 통과하면 정규화 값, 아니면 throw.
 * @param {{newName:string, datastoreName:string, nicDisconnect?:boolean, powerOn?:boolean}} spec
 * @param {{vms:object[], datastores:object[]}} snap  실행 노드의 수집 스냅샷
 */
export function validateRestoreSpec(job, spec = {}, snap = {}) {
  const newName = String(spec.newName ?? '').trim();
  if (!newName || newName.length > 80) throw new Error('새 VM 이름은 1~80자여야 합니다');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f/\\%]/.test(newName)) throw new Error("새 VM 이름에 제어문자·'/'·'\\'·'%' 는 쓸 수 없습니다");
  if (job && newName === job.vmName) throw new Error('원본과 같은 이름은 쓸 수 없습니다 — 원본을 덮어쓰는 복구는 하지 않습니다');
  const datastoreName = String(spec.datastoreName ?? '').trim();
  if (!datastoreName) throw new Error('복구할 데이터스토어를 고르세요');
  const vcId = job?.vcenterId;
  if (Array.isArray(snap.datastores) && !snap.datastores.some((d) => d.vcenterId === vcId && d.name === datastoreName)) {
    throw new Error(`이 vCenter 에 데이터스토어 '${datastoreName}' 가 없습니다`);
  }
  if (Array.isArray(snap.vms) && snap.vms.some((v) => v.vcenterId === vcId && v.name === newName)) {
    throw new Error(`이 vCenter 에 같은 이름의 VM '${newName}' 이 이미 있습니다`);
  }
  const nicDisconnect = spec.nicDisconnect !== false;
  const powerOn = spec.powerOn === true;
  if (powerOn && !nicDisconnect) throw new Error('네트워크를 끊지 않은 복구 VM 은 자동으로 켜지 않습니다 — 원본과 IP·호스트명이 충돌합니다');
  return { newName, datastoreName, nicDisconnect, powerOn };
}

/**
 * 사본 검증 — 검증용 스냅샷 → NIC 끊기(확인) → 켜기 → VMware Tools 응답 대기 → 끄기 → 스냅샷으로 되돌리기 → 스냅샷 삭제.
 * @returns {Promise<{ok:boolean, detail:string, ms:number, phases:object[]}>}
 */
export async function verifyClone(job, ref, { setPhase } = {}) {
  const t0 = Date.now();
  const ph = phaseRecorder(setPhase);
  const fin = (ok, detail) => ({ ok, detail, ms: Date.now() - t0, phases: ph.end(ok) });
  if (job?.dest?.type !== 'datastore') return fin(false, 'NFS 파일 사본은 vCenter 에 등록된 VM 이 아니라 켜서 검증할 수 없습니다');
  let led;
  try { led = ledgerClone(job, ref); } catch (e) { return fin(false, e.message); }
  // v2.794: 재시작으로 중단된 검증의 뒷정리가 남았으면 새 검증을 하지 않는다 — 새 기록이 옛 기록(켜진 사본·남은 스냅샷)을 덮으면 아무도 정리하지 않는다.
  const left = interruptedVerifyOf(getJob(job.id));
  if (left) return fin(false, `중단된 검증(사본 ‘${left.cloneName || left.ref || '?'}’)의 뒷정리가 먼저입니다 — 다음 확인(1분 안팎)에서 정리한 뒤 다시 검증하세요`);

  if (getDataSource() === 'mock') {
    ph.step('검증용 스냅샷'); await sleep(400);
    ph.step('네트워크 끊기'); await sleep(300);
    ph.step('전원 켜기 · Tools 대기'); await sleep(1200);
    const bad = demoHash(`verify|${ref}`) % 6 === 0;
    ph.step('끄기 · 되돌리기'); await sleep(300);
    return fin(!bad, bad ? `VMware Tools 가 ${VERIFY_TIMEOUT_MIN}분 안에 응답하지 않았습니다(데모)` : `부팅 확인 — VMware Tools 응답 ${20 + (demoHash(ref) % 60)}초(데모)`);
  }

  const vc = vcOf(job.vcenterId);
  const c = new VimSoapClient(vc);
  ph.step('로그인');
  await onDemandLogin(c, vc);
  let snapRef = null; let snapName = ''; let powerTried = false; let toolsMs = null; let mainErr = null; const cleanupErrs = [];
  try {
    ph.step('사본 확인');
    const st = await vmStateOf(c, ref);
    if (vcNameNorm(st.name) !== vcNameNorm(led.name)) throw new Error(`원장의 사본 '${led.name}' 자리(${ref})에 다른 이름의 VM '${st.name}' 이 있습니다 — 손대지 않았습니다`);
    if (st.powerState !== 'poweredOff') throw new Error(`사본 '${st.name}' 이 꺼져 있지 않습니다(${st.powerState}) — 누군가 쓰는 중일 수 있어 검증하지 않았습니다`);
    ph.step('검증용 스냅샷');
    // v2.794: 스냅샷을 요청하기 **전에** 진행 기록을 동기로 남긴다 — 곧바로 재시작이 와도 다음 기동이 이 사본을 끄고 되돌린다.
    snapName = `portal-verify-${fileStamp(Date.now())}`;
    setVerifying(job.id, { ref, cloneName: led.name, snapName, phase: 'snapshot' });
    snapRef = await createSnapshot(c, ref, { name: snapName, quiesce: false });
    patchVerifying(job.id, { snapRef, phase: 'nic' });
    ph.step('네트워크 끊기');
    await disconnectAllNics(c, ref);
    ph.step('전원 켜기');
    patchVerifying(job.id, { phase: 'power' });
    powerTried = true;
    await powerOnVm(c, ref);
    ph.step('VMware Tools 대기');
    toolsMs = await waitToolsRunning(c, ref, { timeoutMs: VERIFY_TIMEOUT_MIN * 60_000 });
  } catch (e) { mainErr = e; }
  finally {
    // v2.794: 켜졌는지는 **실측**한다 — 전원 켜기 태스크가 시한 초과·오류로 끝나도 VM 은 켜졌을 수 있다(예전엔 성공 응답일 때만 껐다).
    if (powerTried) {
      let on = true;
      try { on = (await vmStateOf(c, ref)).powerState !== 'poweredOff'; } catch { /* 못 읽으면 켜졌다고 보고 끈다 */ }
      if (on) { ph.step('전원 끄기'); try { await powerOffVm(c, ref); } catch (e) { cleanupErrs.push(`전원 끄기 실패(${e.message})`); } }
    }
    if (snapRef) {
      ph.step('되돌리기 · 스냅샷 삭제');
      try { await revertToSnapshot(c, snapRef); } catch (e) { cleanupErrs.push(`검증 전 상태로 되돌리지 못했습니다(${e.message}) — 이 복원 지점은 켜졌던 상태입니다`); }
      try { await removeSnapshot(c, snapRef); } catch (e) { cleanupErrs.push(`검증용 스냅샷 삭제 실패(${e.message}) — vCenter 에서 지우세요`); }
    }
    await c.logout().catch(() => {});
    // 뒷정리를 다 했으면 기록을 내린다. 못 했으면 재시도 기록으로 넘긴다(다음 확인이 다시 끄고 되돌린다 — 시한 뒤 수동 안내).
    if (cleanupErrs.length && snapName) handOffVerifying(job.id, { lastError: cleanupErrs.join(' · ').slice(0, 200), nextAt: Date.now() + RECOVER_RETRY_MS });
    else clearVerifying(job.id);
  }
  const tail = cleanupErrs.length ? ` ⚠ ${cleanupErrs.join(' · ')}` : '';
  if (mainErr) return fin(false, `${mainErr.message}${tail}`);
  if (toolsMs == null) return fin(false, `VMware Tools 가 ${VERIFY_TIMEOUT_MIN}분 안에 응답하지 않았습니다 — 게스트가 부팅하지 못했거나 Tools 가 없습니다${tail}`);
  return fin(!cleanupErrs.length, `부팅 확인 — VMware Tools 응답 ${Math.round(toolsMs / 1000)}초${tail}`);
}

const NOT_FOUND_RE = /notfound|not found|managedobject|찾을 수 없습니다/i;
const SNAPSHOT_TASK_WAIT_MS = 20 * 60_000;   // 스냅샷 생성 태스크 시한(15분) + 여유 — runner 의 재시작 정리와 같은 값

/**
 * v2.794 — 재시작으로 중단된(또는 뒷정리를 못 끝낸) 검증의 정리: 사본이 켜져 있으면 끄고, 기록한 검증용 스냅샷으로 되돌린 뒤 지운다.
 * 기록한 ref·스냅샷(ref, 없으면 이름)만 다룬다. ref 가 기록한 사본 이름과 다른 VM 을 가리키면 손대지 않는다.
 * @returns {Promise<{ok:boolean, note?:string, error?:string}>} ok:false 면 나중에 다시 시도한다
 */
export async function cleanupInterruptedVerify(c, rec) {
  let st;
  try { st = await vmStateOf(c, rec.ref); }
  catch (e) {
    if (NOT_FOUND_RE.test(String(e?.message || ''))) return { ok: true, note: '사본이 vCenter 에 없습니다(지워졌습니다)' };
    return { ok: false, error: String(e?.message || e) };
  }
  if (rec.cloneName && vcNameNorm(st.name) !== vcNameNorm(rec.cloneName)) {
    return { ok: true, note: `기록한 사본 ‘${rec.cloneName}’ 자리(${rec.ref})에 다른 이름의 VM ‘${st.name}’ 이 있어 손대지 않았습니다 — vCenter 에서 확인하세요` };
  }
  const notes = [];
  if (st.powerState !== 'poweredOff') {
    try { await powerOffVm(c, rec.ref); notes.push('켜진 사본을 껐습니다'); }
    catch (e) { return { ok: false, error: `사본을 끄지 못했습니다(${e?.message || e})` }; }
  }
  let list;
  try { list = snapshotTreeList((await c.retrieveObjectProps('VirtualMachine', rec.ref, ['snapshot']))?.[0]?.props?.snapshot); }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
  const hit = list.find((x) => (rec.snapRef ? x.ref === rec.snapRef : x.name === rec.snapName));
  if (!hit) {
    if (!rec.snapRef && rec.phase === 'snapshot' && Date.now() - (Number(rec.at) || 0) < SNAPSHOT_TASK_WAIT_MS) {
      return { ok: false, error: '검증용 스냅샷 생성 태스크가 vCenter 에서 아직 끝나지 않았을 수 있어 기다립니다' };
    }
    notes.push('남은 검증용 스냅샷 없음');
    return { ok: true, note: notes.join(' · ') };
  }
  try { await revertToSnapshot(c, hit.ref); } catch (e) { return { ok: false, error: `검증 전 상태로 되돌리지 못했습니다(${e?.message || e})` }; }
  try { await removeSnapshot(c, hit.ref); } catch (e) { return { ok: false, error: `되돌렸지만 검증용 스냅샷을 지우지 못했습니다(${e?.message || e})` }; }
  notes.push(`검증 전 상태로 되돌리고 스냅샷 ‘${hit.name}’ 을 지웠습니다`);
  return { ok: true, note: notes.join(' · ') };
}

/**
 * 중단된 검증 정리 한 건(scheduler 가 실행 큐에 넣는다). 못 하면 RECOVER_RETRY_MS 뒤 다시, RECOVER_GIVE_UP_MS 가 지나면 기록을 내리고 수동 정리를 안내한다.
 * @returns {Promise<{ok:boolean, detail:string}>}
 */
export async function recoverInterruptedVerify(jobId, { setPhase } = {}) {
  const job = getJob(jobId);
  const rec = interruptedVerifyOf(job);
  if (!rec) return { ok: true, detail: '정리할 검증 기록이 없습니다' };
  const finish = (ok, note) => {
    clearVerifying(jobId, { anyBoot: true });
    const detail = `중단된 검증 정리 — ${note}`.slice(0, 300);
    if (rec.ref) patchClone(jobId, rec.ref, { verify: { at: Date.now(), ok: false, detail: '검증이 재시작으로 중단됐습니다 — 다시 검증하세요' } });
    recordJobEvent(jobId, { kind: 'verify', ok, detail, trigger: 'restart', skipped: ok ? '' : 'restart-cleanup-gave-up' });
    logAudit({ user: 'vm-clone(restart)', action: ok ? 'VM 백업 중단된 검증 정리' : 'VM 백업 중단된 검증 정리 포기', target: `${job.vcenterId}/${job.vmName}`, detail: detail.slice(0, 200) });
    return { ok, detail };
  };
  const postpone = (why) => {
    const now = Date.now();
    const w = String(why || '').slice(0, 200);
    if (now - (Number(rec.detectedAt) || now) >= RECOVER_GIVE_UP_MS) {
      return finish(false, `${Math.round(RECOVER_GIVE_UP_MS / 3_600_000)}시간 동안 정리하지 못해 그만뒀습니다(${w}) — vCenter 에서 사본 ‘${rec.cloneName || rec.ref}’ 을 끄고 스냅샷 ‘${rec.snapName || '?'}’ 으로 되돌린 뒤 지우세요`);
    }
    patchVerifying(jobId, { tries: (Number(rec.tries) || 0) + 1, nextAt: now + RECOVER_RETRY_MS, lastError: w, detectedAt: Number(rec.detectedAt) || now }, { anyBoot: true });
    return { ok: false, detail: `중단된 검증 정리를 ${Math.round(RECOVER_RETRY_MS / 60_000)}분 뒤 다시 시도합니다(${w})` };
  };
  if (getDataSource() === 'mock') return finish(true, '데모(mock) 모드라 vCenter 에서 확인하지 않았습니다');
  let vc;
  try { vc = vcOf(job.vcenterId); } catch (e) { return postpone(e.message); }
  if (vc.collectMode === 'site') return finish(false, '이 vCenter 는 엣지 위임(site) 수집이라 이 노드가 로그인하지 않습니다 — 담당 엣지·vCenter 에서 확인하세요');
  const c = new VimSoapClient(vc);
  try { setPhase?.('중단된 검증 정리'); } catch { /* 표시용 */ }
  try { await onDemandLogin(c, vc); } catch (e) { return postpone(`로그인 실패: ${e?.message || e}`); }
  try {
    const r = await cleanupInterruptedVerify(c, rec);
    return r.ok ? finish(true, r.note) : postpone(r.error);
  } catch (e) { return postpone(e?.message || e); }
  finally { await c.logout().catch(() => {}); }
}

/**
 * 복원 지점에서 새 VM 만들기 — 원본 폴더에 새 이름으로 클론(꺼진 상태) → (기본) NIC 끊기 확인 → (선택) 켜기.
 * @returns {Promise<{ok:boolean, detail:string, ms:number, phases:object[], newRef?:string, newName?:string}>}
 */
export async function restoreFromClone(job, ref, spec, { setPhase } = {}) {
  const t0 = Date.now();
  const ph = phaseRecorder(setPhase);
  const fin = (ok, detail, extra = {}) => ({ ok, detail, ms: Date.now() - t0, phases: ph.end(ok), ...extra });
  if (job?.dest?.type !== 'datastore') return fin(false, 'NFS 파일 사본은 이 화면에서 복구할 수 없습니다 — manifest.json 의 안내대로 데이터스토어에 올린 뒤 vmx 를 등록하세요');
  let led; let s;
  try { led = ledgerClone(job, ref); s = validateRestoreSpec(job, spec, store.get() || {}); } catch (e) { return fin(false, e.message); }

  if (getDataSource() === 'mock') {
    ph.step('복원 지점 클론'); await sleep(1500);
    if (s.nicDisconnect) { ph.step('네트워크 끊기'); await sleep(300); }
    if (s.powerOn) { ph.step('전원 켜기'); await sleep(300); }
    return fin(true, `복구 완료(데모) — ${led.name} → 새 VM '${s.newName}' [${s.datastoreName}]${s.nicDisconnect ? ' · 네트워크 끊김' : ''}${s.powerOn ? ' · 켜짐' : ' · 꺼진 상태'}`, { newRef: `mock-restore-${Date.now()}`, newName: s.newName });
  }

  const vc = vcOf(job.vcenterId);
  const ds = (store.get()?.datastores || []).find((d) => d.vcenterId === job.vcenterId && d.name === s.datastoreName);
  if (!ds) return fin(false, `데이터스토어를 찾을 수 없습니다: ${s.datastoreName}`);
  const c = new VimSoapClient(vc);
  ph.step('로그인');
  await onDemandLogin(c, vc);
  let newRef = null;
  try {
    ph.step('사본 확인');
    const st = await vmStateOf(c, ref);
    if (vcNameNorm(st.name) !== vcNameNorm(led.name)) return fin(false, `원장의 사본 '${led.name}' 자리(${ref})에 다른 이름의 VM '${st.name}' 이 있습니다 — 복구하지 않았습니다`);
    // 폴더: 원본 VM 의 폴더(원본이 없어졌으면 사본의 폴더).
    let folder = null;
    const srcRef = morefOf(job.vmId, job.vcenterId);
    if (srcRef) { try { folder = await parentFolderOf(c, srcRef); } catch { folder = null; } }
    if (!folder) folder = await parentFolderOf(c, ref);
    if (!folder) return fin(false, '복구할 폴더를 찾지 못했습니다');
    ph.step('복원 지점 클론');
    // v2.794: 네트워크를 끊는 복구는 새 VM 을 **NIC 가 끊긴 채로** 만든다(클론 스펙의 deviceChange) — 클론 뒤에 끊으면 그 사이·태스크 시한 초과로
    //   결과를 못 받은 경우 원본과 같은 IP·호스트명의 연결된 VM 이 vCenter 에 남는다. 아래 disconnectAllNics 는 다시 읽어 확인만 한다.
    const configXml = s.nicDisconnect ? nicDisconnectSpec(st.deviceXml).specXml : '';
    newRef = await cloneFromSnapshot(c, { vmRef: ref, folderRef: folder, name: s.newName, dsRef: morefOf(ds.id, job.vcenterId), snapshotRef: null, configXml });
    if (s.nicDisconnect) {
      ph.step('네트워크 끊기');
      try { await disconnectAllNics(c, newRef); }
      catch (e) { return fin(false, `새 VM '${s.newName}' 은 만들었지만(꺼진 상태) 네트워크 카드 연결을 끊지 못했습니다(${e.message}) — 켜기 전에 vCenter 에서 직접 끊으세요`, { newRef, newName: s.newName }); }
    }
    if (s.powerOn) {
      ph.step('전원 켜기');
      try { await powerOnVm(c, newRef); }
      catch (e) { return fin(false, `새 VM '${s.newName}' 은 만들었지만 켜지 못했습니다(${e.message})`, { newRef, newName: s.newName }); }
    }
    return fin(true, `복구 완료 — ${led.name} → 새 VM '${s.newName}' [${s.datastoreName}]${s.nicDisconnect ? ' · 네트워크 끊김' : ''}${s.powerOn ? ' · 켜짐' : ' · 꺼진 상태'}`, { newRef, newName: s.newName });
  } catch (e) {
    return fin(false, newRef ? `새 VM '${s.newName}' 을 만든 뒤 실패했습니다(${e.message})` : e.message, newRef ? { newRef, newName: s.newName } : {});
  } finally { await c.logout().catch(() => {}); }
}

/**
 * 호스트들에 NFS 데이터스토어를 붙인다(호스트마다 결과 — 실패한 호스트만 다시 시도할 수 있게).
 * @returns {Promise<{ok:boolean, detail:string, ms:number, hosts:{hostId:string, ok:boolean, detail:string}[]}>}
 */
export function attachNfsDatastore(vcenterId, spec, hostIds, { setPhase } = {}) {
  return perHostNas('attach', vcenterId, spec, hostIds, { setPhase });
}
/** v2.794 — 호스트들에서 NFS 데이터스토어를 떼어 낸다(호스트마다 결과 — 쓰는 VM 이 있는 호스트는 떼지 않는다). */
export function detachNfsDatastore(vcenterId, spec, hostIds, { setPhase } = {}) {
  return perHostNas('detach', vcenterId, spec, hostIds, { setPhase });
}

async function perHostNas(mode, vcenterId, spec, hostIds, { setPhase } = {}) {
  const t0 = Date.now();
  const verb = mode === 'detach' ? '떼어 내기' : '연결';
  let s;
  try { s = validateNfsDsSpec(spec); } catch (e) { return { ok: false, detail: e.message, ms: 0, hosts: [] }; }
  const ids = [...new Set((hostIds || []).map(String))].slice(0, 200);
  if (!ids.length) return { ok: false, detail: `${verb}할 호스트가 없습니다`, ms: 0, hosts: [] };
  const hosts = [];
  const summary = () => {
    const okN = hosts.filter((h) => h.ok).length;
    return { ok: okN === hosts.length, detail: `NFS 데이터스토어 '${s.name}' — 호스트 ${okN}/${hosts.length}대 ${verb}`, ms: Date.now() - t0, hosts };
  };
  if (getDataSource() === 'mock') {
    for (const id of ids) { try { setPhase?.(`호스트 ${verb} ${hosts.length + 1}/${ids.length}`); } catch { /* */ } await sleep(150); hosts.push({ hostId: id, ok: true, detail: mode === 'detach' ? '떼어 냈습니다(데모)' : '연결했습니다(데모)' }); }
    return summary();
  }
  const vc = vcOf(vcenterId);
  const c = new VimSoapClient(vc);
  await onDemandLogin(c, vc);
  const one = mode === 'detach' ? detachNasFromHost : attachNasToHost;
  try {
    for (const id of ids) {
      try { setPhase?.(`호스트 ${verb} ${hosts.length + 1}/${ids.length}`); } catch { /* */ }
      const hostRef = morefOf(id, vcenterId);
      if (!hostRef) { hosts.push({ hostId: id, ok: false, detail: '호스트 MoRef 해석 실패' }); continue; }
      try { const r = await one(c, hostRef, s); hosts.push({ hostId: id, ok: r.ok, detail: r.detail }); }
      catch (e) { hosts.push({ hostId: id, ok: false, detail: String(e?.message || e).slice(0, 300) }); }
    }
  } finally { await c.logout().catch(() => {}); }
  return summary();
}

/** 새 사본의 크기(실행 노드에서 — 실패는 null). runner 가 클론 직후 부른다. */
export { vmCommittedBytes };
