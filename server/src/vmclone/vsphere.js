/**
 * vmclone/vsphere.js — VM 복제(백업식)의 vCenter SOAP 작업 모음(v2.299).
 *
 * 전부 기존 운영 경로의 패턴을 재사용한다(새 프로토콜 없음):
 *  - CloneVM_Task: provision/vsphere.js 와 동일 호출에 ① location.datastore(다른 데이터스토어로)
 *    ② spec.snapshot(스냅샷 시점 복제 — 켜진 VM 의 크래시/앱 정합 사본) 만 추가.
 *  - 태스크 대기: dsBrowse.js 의 폴링 패턴(retrieveObjectProps info.state).
 *  - 파일 다운로드(NFS 대상): vCenter `/folder` HTTPS 경로 — 로그인 세션 쿠키 + vcDispatcher
 *    (전역 TLS 오염 금지 — server/CLAUDE.md) 로 스트리밍 저장. 스냅샷 이후 베이스 디스크는
 *    읽기 전용이라 켜진 VM 에서도 일관된 사본을 받을 수 있다(쓰기는 델타 파일로 감).
 *
 * vim25 시퀀스 주의(과거 실사고 — provision/vsphere.js RelocateSpec 주석 참조): SOAP 요소
 * 순서는 스키마(VirtualMachineCloneSpec: location → template → customization? → powerOn →
 * snapshot? …)를 따라야 한다 — 순서가 틀리면 vCenter 가 unexpected-element 로 요청 전체를
 * 거부한다. 아래 cloneFromSnapshot 의 spec 조립 순서를 임의로 바꾸지 말 것.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { VimSoapClient } from '../vcenter/soapClient.js';
import { vcDispatcher } from '../vcenter/restClient.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** 태스크 완료 대기(dsBrowse 패턴) — success 면 result MoRef 문자열(있으면), error 면 throw. */
export async function waitTask(c, taskRef, { timeoutMs = 4 * 3600_000, pollMs = 5_000, label = '작업' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const objs = await c.retrieveObjectProps('Task', taskRef, ['info.state', 'info.result', 'info.error.localizedMessage', 'info.progress']);
    const p = objs[0]?.props || {};
    const state = p['info.state'] || '';
    if (state === 'success') return { result: p['info.result'] || null, progress: 100 };
    if (state === 'error') throw new Error(`${label} 실패: ${p['info.error.localizedMessage'] || 'vCenter 태스크 오류'}`);
    if (Date.now() - t0 > timeoutMs) {
      await c.callRaw(`<CancelTask xmlns="urn:vim25"><_this type="Task">${esc(taskRef)}</_this></CancelTask>`).catch(() => {});
      throw new Error(`${label} 시간 초과(${Math.round(timeoutMs / 60000)}분) — 태스크 취소 요청함`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

const taskRefOf = (xml) => /<returnval type="Task"[^>]*>([^<]+)<\/returnval>/.exec(xml)?.[1] || null;

/** 스냅샷 생성 → 스냅샷 MoRef. quiesce=true 면 VMware Tools 정지점(앱 정합 — Tools 필수). */
export async function createSnapshot(c, vmRef, { name, quiesce = false }) {
  const xml = await c.callRaw(
    `<CreateSnapshot_Task xmlns="urn:vim25"><_this type="VirtualMachine">${esc(vmRef)}</_this>` +
    `<name>${esc(name)}</name><description>portal vm-clone backup</description>` +
    // memory=false: 메모리 덤프 없이 디스크 시점만(빠르고 stun 짧음 — 백업 사본은 부팅으로 복구)
    `<memory>false</memory><quiesce>${quiesce ? 'true' : 'false'}</quiesce></CreateSnapshot_Task>`,
  );
  const task = taskRefOf(xml);
  if (!task) throw new Error('스냅샷 태스크 제출 실패');
  const { result } = await waitTask(c, task, { timeoutMs: 15 * 60_000, pollMs: 2_000, label: '스냅샷 생성' });
  if (!result) throw new Error('스냅샷 MoRef 를 받지 못했습니다');
  return result;
}

/** 스냅샷 삭제(자기 델타 병합). removeChildren=false — 우리가 만든 스냅샷 하나만. */
export async function removeSnapshot(c, snapRef) {
  const xml = await c.callRaw(
    `<RemoveSnapshot_Task xmlns="urn:vim25"><_this type="VirtualMachineSnapshot">${esc(snapRef)}</_this>` +
    `<removeChildren>false</removeChildren><consolidate>true</consolidate></RemoveSnapshot_Task>`,
  );
  const task = taskRefOf(xml);
  if (task) await waitTask(c, task, { timeoutMs: 2 * 3600_000, pollMs: 5_000, label: '스냅샷 삭제(병합)' });
}

/**
 * 원본 VM 의 부모 폴더 MoRef(클론을 같은 폴더에 둔다 — provision/vsphere.js parentFolder 와
 * 동일 패턴). ⚠ retrieveObjectProps(parseObjectContent)는 <val> 의 type 속성을 버리므로,
 * 부모 "타입"이 필요한 조회는 callRaw + 타입 캡처 정규식으로 직접 파싱한다(아래 dcPath 도 동일).
 */
async function typedParentOf(c, type, ref) {
  const xml = await c.callRaw(
    `<RetrieveProperties xmlns="urn:vim25"><_this type="PropertyCollector">${c.sc.propertyCollector}</_this>` +
    `<specSet><propSet><type>${type}</type><pathSet>name</pathSet><pathSet>parent</pathSet></propSet>` +
    `<objectSet><obj type="${type}">${esc(ref)}</obj></objectSet></specSet></RetrieveProperties>`,
  );
  const name = /<name>name<\/name>\s*<val[^>]*>([^<]*)<\/val>/.exec(xml)?.[1] || null;
  const pm = /<name>parent<\/name>\s*<val[^>]*type="(Folder|Datacenter)"[^>]*>([^<]+)<\/val>/.exec(xml);
  return { name, parentType: pm?.[1] || null, parentRef: pm?.[2] || null };
}

export async function parentFolderOf(c, vmRef) {
  const xml = await c.callRaw(
    `<RetrieveProperties xmlns="urn:vim25"><_this type="PropertyCollector">${c.sc.propertyCollector}</_this>` +
    `<specSet><propSet><type>VirtualMachine</type><pathSet>parent</pathSet></propSet>` +
    `<objectSet><obj type="VirtualMachine">${esc(vmRef)}</obj></objectSet></specSet></RetrieveProperties>`,
  );
  return /<val[^>]*type="Folder">([^<]+)<\/val>/.exec(xml)?.[1] || null;
}

/**
 * 스냅샷 시점 클론 → 새 VM MoRef. dsRef 지정 시 다른 데이터스토어로(요구사항 핵심).
 * powerOn=false 고정 — 사본이 켜지면 원본과 IP/호스트명 충돌(복제 Q&A 에서 안내한 리스크).
 */
export async function cloneFromSnapshot(c, { vmRef, folderRef, name, dsRef = null, snapshotRef = null }) {
  const spec =
    `<spec>` +
    `<location>${dsRef ? `<datastore type="Datastore">${esc(dsRef)}</datastore>` : ''}</location>` +
    `<template>false</template>` +
    `<powerOn>false</powerOn>` +
    (snapshotRef ? `<snapshot type="VirtualMachineSnapshot">${esc(snapshotRef)}</snapshot>` : '') +
    `</spec>`;
  const xml = await c.callRaw(
    `<CloneVM_Task xmlns="urn:vim25"><_this type="VirtualMachine">${esc(vmRef)}</_this>` +
    `<folder type="Folder">${esc(folderRef)}</folder><name>${esc(name)}</name>${spec}</CloneVM_Task>`,
  );
  const task = taskRefOf(xml);
  if (!task) throw new Error('클론 태스크 제출 실패');
  const { result } = await waitTask(c, task, { label: `클론(${name})` });
  return result; // 새 VM MoRef(문자열) — 보존 원장에 기록
}

/**
 * 보존정책용 클론 삭제 — ⚠ 반드시 우리 원장(job.clones)에 기록된 ref 만 받는다(store.js 규칙).
 * 켜져 있으면(누가 수동으로 켰으면) 삭제하지 않고 오류를 돌려준다 — 백업 사본을 쓰는 중일 수
 * 있는데 자동으로 꺼서 지우는 건 파괴적이다(정직한 실패 > 조용한 강행).
 */
export async function destroyClone(c, vmRef) {
  let objs = [];
  // 이미 수동 삭제된 클론 조회는 ManagedObjectNotFound fault 로 throw 될 수 있다 — 그 경우도
  // '원장에서만 제거'로 처리(진짜 통신 오류와 구분: not.?found 계열 메시지일 때만).
  try { objs = await c.retrieveObjectProps('VirtualMachine', vmRef, ['runtime.powerState', 'name']); }
  catch (e) { if (/notfound|not found|managedobject/i.test(String(e.message))) return { gone: true }; throw e; }
  const p = objs[0]?.props || {};
  if (!p.name) return { gone: true }; // 이미 수동 삭제됨 — 원장에서만 제거
  if (p['runtime.powerState'] === 'poweredOn') throw new Error(`보존정책 삭제 건너뜀 — 클론 '${p.name}' 이 켜져 있습니다(수동 확인 필요)`);
  const xml = await c.callRaw(`<Destroy_Task xmlns="urn:vim25"><_this type="VirtualMachine">${esc(vmRef)}</_this></Destroy_Task>`);
  const task = taskRefOf(xml);
  if (task) await waitTask(c, task, { timeoutMs: 30 * 60_000, label: '클론 삭제' });
  return { gone: true };
}

/** "[DS명] 폴더/파일" → { ds, rel }. vSphere 데이터스토어 경로 표기 파서. */
export function parseDsPath(s) {
  const m = /^\[([^\]]+)\]\s*(.+)$/.exec(String(s || '').trim());
  return m ? { ds: m[1], rel: m[2] } : null;
}

/** VM 홈(vmx) + 전체 파일 목록(layoutEx) 조회 — NFS 파일 백업 대상 산출. */
export async function vmFilePaths(c, vmRef) {
  const objs = await c.retrieveObjectProps('VirtualMachine', vmRef, ['config.files.vmPathName', 'layoutEx.file']);
  const props = objs[0]?.props || {};
  const vmx = props['config.files.vmPathName'] || null;
  // layoutEx.file 은 구조체 배열 — parseObjectContent 가 중첩 XML 을 문자열 그대로 보존하므로
  // 그 안에서 <name>[ds] path</name> 만 추출한다(이름만 필요).
  const inner = String(props['layoutEx.file'] || '');
  const files = [...inner.matchAll(/<name>(\[[^\]]+\][^<]+)<\/name>/g)].map((m) => m[1]);
  return { vmx, files: [...new Set(files)] };
}

/**
 * NFS 백업에서 받을 파일 필터(순수 — vmcloneStore.test.js 로 고정).
 * 포함: .vmx/.vmxf/.nvram + 베이스 .vmdk(디스크립터·flat).
 * 제외: 스냅샷 델타(-NNNNNN[-delta|-sesparse].vmdk 와 그 디스크립터), 스왑(.vswp),
 *       스냅샷 메타(.vmsn/.vmem), 잠금/로그(.lck/.log) — 델타는 스냅샷 후 쓰기가 흐르는
 *       파일이라 받으면 비일관 사본이 되고, 로그/스왑은 복구에 불필요한 대용량이다.
 */
export function backupFileFilter(name) {
  const base = String(name).split('/').pop().toLowerCase();
  if (/-\d{6}(-(delta|sesparse))?\.vmdk$/.test(base)) return false; // 스냅샷 델타·그 디스크립터
  if (/\.(vswp|vmsn|vmem|lck|log)$/.test(base)) return false;
  if (/\.(vmx|vmxf|nvram|vmdk)$/.test(base)) return true;
  return false;
}

/** VM 이 속한 Datacenter 의 인벤토리 경로(dcPath) — /folder 다운로드 URL 에 필요. 부모 체인 상향 탐색. */
export async function datacenterPathOf(c, vmRef) {
  // VM.parent(vmFolder) → … → Datacenter. Datacenter 위의 폴더 이름들이 dcPath 프리픽스가 된다
  // (루트 인벤토리 폴더는 parent 의 typed 매치가 없어 자연 종료 — dcPath 에 포함하지 않음).
  let ref = await parentFolderOf(c, vmRef);
  let type = 'Folder';
  for (let hop = 0; hop < 12 && ref; hop++) {
    const cur = await typedParentOf(c, type, ref);
    if (type === 'Datacenter') {
      const above = [];
      let pRef = cur.parentRef; let pType = cur.parentType;
      for (let up = 0; up < 8 && pRef && pType === 'Folder'; up++) {
        const po = await typedParentOf(c, 'Folder', pRef);
        if (!po.parentRef) break; // 루트 폴더 자신은 dcPath 에 포함하지 않는다
        above.unshift(po.name);
        pRef = po.parentRef; pType = po.parentType;
      }
      return [...above, cur.name].filter(Boolean).join('/');
    }
    if (cur.parentType === 'Datacenter') { ref = cur.parentRef; type = 'Datacenter'; continue; }
    if (!cur.parentRef) return null; // Datacenter 를 못 찾음 — 호출부가 오류 처리
    ref = cur.parentRef; type = cur.parentType;
  }
  return null;
}

/**
 * vCenter /folder HTTPS 파일 다운로드 → destFile 스트리밍 저장(메모리에 안 올림 — GB VMDK 대응).
 * 로그인 세션 쿠키 재사용 + vcDispatcher(로컬 TLS 정책) — 전역 디스패처 오염 금지.
 */
export async function downloadDsFile(c, vc, { dcPath, ds, rel, destFile }) {
  const url = `https://${vc.host}/folder/${rel.split('/').map(encodeURIComponent).join('/')}` +
    `?dcPath=${encodeURIComponent(dcPath)}&dsName=${encodeURIComponent(ds)}`;
  const res = await fetch(url, { headers: { Cookie: c.cookie }, dispatcher: vcDispatcher });
  if (!res.ok || !res.body) throw new Error(`파일 다운로드 실패(${res.status}) — ${rel}`);
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destFile));
  return fs.statSync(destFile).size;
}

export { VimSoapClient };
