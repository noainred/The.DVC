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
import { trimTrailingSlashes } from '../util/trimSlashes.js'; // v2.793: '/\/+$/' 는 O(n²) — 루프로 뗀다(CLAUDE.md 정규식 규약)

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
// v2.794: configXml — VirtualMachineConfigSpec 내부(호출부가 만든 XML · 예: nicDisconnectSpec 의 deviceChange). 복구 VM 을 **NIC 가 끊긴 채로 태어나게**
//   한다 — 클론 뒤에 끊으면 그 사이(클론 태스크 시한 초과로 결과를 못 받은 경우 포함) 연결된 NIC 의 사본이 vCenter 에 생긴다.
//   vim25 VirtualMachineCloneSpec 순서: location · template · config · customization · powerOn · snapshot · memory.
export async function cloneFromSnapshot(c, { vmRef, folderRef, name, dsRef = null, snapshotRef = null, configXml = '' }) {
  const spec =
    `<spec>` +
    `<location>${dsRef ? `<datastore type="Datastore">${esc(dsRef)}</datastore>` : ''}</location>` +
    `<template>false</template>` +
    (configXml ? `<config>${configXml}</config>` : '') +
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
// vSphere 는 엔터티 이름의 '/'·'\\'·'%' 를 %2f·%5c·%25 로 바꿔 돌려준다 — 원장 이름과 비교하기 전에 되돌린다.
const vcNameNorm = (s) => String(s ?? '').replace(/%(2f|5c|25)/gi, (m) => decodeURIComponent(m));
export async function destroyClone(c, vmRef, { expectedName = '' } = {}) {
  let objs = [];
  // 이미 수동 삭제된 클론 조회는 ManagedObjectNotFound fault 로 throw 될 수 있다 — 그 경우도
  // '원장에서만 제거'로 처리(진짜 통신 오류와 구분: not.?found 계열 메시지일 때만).
  try { objs = await c.retrieveObjectProps('VirtualMachine', vmRef, ['runtime.powerState', 'name']); }
  catch (e) { if (/notfound|not found|managedobject/i.test(String(e.message))) return { gone: true }; throw e; }
  const p = objs[0]?.props || {};
  if (!p.name) return { gone: true }; // 이미 수동 삭제됨 — 원장에서만 제거
  // v2.767(점검 R2-B3-6): ref 가 원장 이름과 다른 VM 을 가리키면 지우지 않는다 — vCenter 재설치 뒤 같은 vcenterId 로 재등록하면
  //   MoRef 카운터가 다시 시작해 옛 클론의 ref 가 꺼진 운영 VM 을 가리킬 수 있다. 오류로 돌려 건너뜀으로 보고하고 원장에서는 지우지 않는다.
  if (expectedName && vcNameNorm(p.name) !== vcNameNorm(expectedName)) {
    throw new Error(`보존정책 삭제 건너뜀 — 원장의 클론 '${expectedName}' 자리(${vmRef})에 다른 이름의 VM '${p.name}' 이 있습니다(수동 확인 필요)`);
  }
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

// ── v2.793 VM 백업 센터 — 검증·복구·ESXi NFS 데이터스토어 ─────────────────────────────────────────────

/** VM 사본 크기(커밋 바이트). 못 읽으면 null — 0 으로 만들지 않는다(util/numOrNull 규약). */
export async function vmCommittedBytes(c, vmRef) {
  try {
    const objs = await c.retrieveObjectProps('VirtualMachine', vmRef, ['summary.storage.committed']);
    const raw = objs[0]?.props?.['summary.storage.committed'];
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch { return null; }
}

/** VM 의 이름·전원 상태·장치 XML. 없으면 throw(호출부가 not found 로 다룬다). */
export async function vmStateOf(c, vmRef) {
  const objs = await c.retrieveObjectProps('VirtualMachine', vmRef, ['name', 'runtime.powerState', 'config.hardware.device']);
  const p = objs[0]?.props || {};
  if (!p.name) throw new Error(`VM 을 찾을 수 없습니다(${vmRef})`);
  return { name: vcNameNorm(p.name), powerState: p['runtime.powerState'] || '', deviceXml: String(p['config.hardware.device'] || '') };
}

// NIC 로 취급하는 VirtualDevice 구체 타입 — VirtualEthernetCard 하위 전부(soapParse.js NIC_TYPE_RE 와 같은 집합).
const NIC_TYPE_RE = /^Virtual(E1000e?|Vmxnet\d?|Vmxnet3Vrdma|PCNet32|SriovEthernetCard)$/i;

/** 장치 XML → NIC 블록 [{type, inner}] (순수). 배열 원소는 `<VirtualDevice xsi:type="구체타입">…</VirtualDevice>` 로 직렬화된다. */
export function nicBlocksOf(deviceXml) {
  const out = [];
  for (const piece of String(deviceXml || '').split(/<VirtualDevice(?=[ >])/).slice(1)) {
    const type = /^[^>]*xsi:type="([^"]+)"/.exec(piece)?.[1] || '';
    if (!NIC_TYPE_RE.test(type)) continue;
    const open = piece.indexOf('>');
    const close = piece.lastIndexOf('</VirtualDevice>');
    if (open < 0 || close < open) continue;
    out.push({ type, inner: piece.slice(open + 1, close) });
  }
  return out;
}

/**
 * 모든 NIC 를 '연결 끊음 · 켤 때 연결 안 함' 으로 바꾸는 ReconfigVM spec 내부 XML(순수 — 테스트 고정).
 * 장치는 **읽은 그대로 되돌려 보낸다**(backing 을 비우면 DVS 포트가 풀린다 — provision/reconfig.js 와 같은 이유). connectable 만 바꾼다.
 * vim25 VirtualDeviceConnectInfo 순서: migrateConnect? · startConnected · allowGuestControl · connected · status?.
 * @returns {{ specXml: string, count: number }} NIC 가 없으면 count 0, specXml ''.
 */
export function nicDisconnectSpec(deviceXml) {
  const nics = nicBlocksOf(deviceXml);
  const changes = nics.map(({ type, inner }) => {
    const guest = /<connectable>[\s\S]*?<allowGuestControl>(true|false)<\/allowGuestControl>/.exec(inner)?.[1] || 'false';
    const conn = `<connectable><startConnected>false</startConnected><allowGuestControl>${guest}</allowGuestControl><connected>false</connected></connectable>`;
    let body;
    if (/<connectable>[\s\S]*?<\/connectable>/.test(inner)) body = inner.replace(/<connectable>[\s\S]*?<\/connectable>/, conn);
    else if (/<slotInfo[\s>]/.test(inner)) body = inner.replace(/<slotInfo[\s>]/, (m) => `${conn}${m}`);
    else if (/<controllerKey>/.test(inner)) body = inner.replace('<controllerKey>', `${conn}<controllerKey>`);
    else body = `${inner}${conn}`;
    return `<deviceChange><operation>edit</operation><device xsi:type="${esc(type)}">${body}</device></deviceChange>`;
  });
  return { specXml: changes.join(''), count: changes.length };
}

/** 모든 NIC 가 끊겨 있고 켤 때도 연결하지 않는가(순수). NIC 가 없으면 true. */
export function allNicsDisconnected(deviceXml) {
  return nicBlocksOf(deviceXml).every(({ inner }) => {
    const conn = /<connectable>([\s\S]*?)<\/connectable>/.exec(inner)?.[1] || '';
    return /<connected>false<\/connected>/.test(conn) && /<startConnected>false<\/startConnected>/.test(conn);
  });
}

/** ReconfigVM_Task 로 spec 내부 XML 적용. */
export async function reconfigVm(c, vmRef, specInnerXml, { label = 'VM 재구성' } = {}) {
  const xml = await c.callRaw(`<ReconfigVM_Task xmlns="urn:vim25"><_this type="VirtualMachine">${esc(vmRef)}</_this><spec>${specInnerXml}</spec></ReconfigVM_Task>`);
  const task = taskRefOf(xml);
  if (!task) throw new Error(`${label} 태스크 제출 실패`);
  await waitTask(c, task, { timeoutMs: 10 * 60_000, pollMs: 2_000, label });
}

/**
 * NIC 를 모두 끊고, 다시 읽어 **실제로 끊겼는지 확인**한다. 확인되지 않으면 throw — 호출부는 이 VM 을 켜지 않는다
 * (원본이 살아 있는 망에 같은 IP·호스트명·AD 컴퓨터 계정으로 붙는 사고를 막는 유일한 문이다).
 * @returns {Promise<number>} 끊은 NIC 수
 */
export async function disconnectAllNics(c, vmRef) {
  const st = await vmStateOf(c, vmRef);
  const { specXml, count } = nicDisconnectSpec(st.deviceXml);
  // v2.794: 이미 끊겨 태어난 VM(복구 — cloneFromSnapshot configXml)은 다시 재구성하지 않는다. 확인(다시 읽기)은 그대로 한다.
  if (count && !allNicsDisconnected(st.deviceXml)) await reconfigVm(c, vmRef, specXml, { label: '네트워크 카드 연결 끊기' });
  const after = await vmStateOf(c, vmRef);
  if (!allNicsDisconnected(after.deviceXml)) throw new Error('네트워크 카드 연결을 끊었는지 확인하지 못했습니다 — 안전을 위해 이 VM 을 켜지 않습니다');
  return count;
}

export async function powerOnVm(c, vmRef) {
  const xml = await c.callRaw(`<PowerOnVM_Task xmlns="urn:vim25"><_this type="VirtualMachine">${esc(vmRef)}</_this></PowerOnVM_Task>`);
  const task = taskRefOf(xml);
  if (!task) throw new Error('전원 켜기 태스크 제출 실패');
  await waitTask(c, task, { timeoutMs: 10 * 60_000, pollMs: 2_000, label: '전원 켜기' });
}

export async function powerOffVm(c, vmRef) {
  const xml = await c.callRaw(`<PowerOffVM_Task xmlns="urn:vim25"><_this type="VirtualMachine">${esc(vmRef)}</_this></PowerOffVM_Task>`);
  const task = taskRefOf(xml);
  if (!task) throw new Error('전원 끄기 태스크 제출 실패');
  await waitTask(c, task, { timeoutMs: 10 * 60_000, pollMs: 2_000, label: '전원 끄기' });
}

/** VMware Tools 가 응답할 때까지 기다린다. 응답하면 걸린 ms, 시한을 넘기면 null. */
export async function waitToolsRunning(c, vmRef, { timeoutMs = 10 * 60_000, pollMs = 10_000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const objs = await c.retrieveObjectProps('VirtualMachine', vmRef, ['guest.toolsRunningStatus', 'guest.guestHeartbeatStatus']);
    const p = objs[0]?.props || {};
    if (p['guest.toolsRunningStatus'] === 'guestToolsRunning') return Date.now() - t0;
    if (Date.now() - t0 >= timeoutMs) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export async function revertToSnapshot(c, snapRef) {
  const xml = await c.callRaw(`<RevertToSnapshot_Task xmlns="urn:vim25"><_this type="VirtualMachineSnapshot">${esc(snapRef)}</_this><suppressPowerOn>true</suppressPowerOn></RevertToSnapshot_Task>`);
  const task = taskRefOf(xml);
  if (!task) throw new Error('스냅샷 되돌리기 태스크 제출 실패');
  await waitTask(c, task, { timeoutMs: 30 * 60_000, pollMs: 3_000, label: '스냅샷 되돌리기' });
}

// ── ESXi NFS 데이터스토어 ──
// 형식은 system/nfsMounts.js validateMountSpec 과 같은 화이트리스트다(같은 NFS 를 엣지 마운트로도 쓰므로 규칙을 맞춘다).
const RE_NFS_SERVER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$/;
const RE_NFS_EXPORT = /^\/[A-Za-z0-9._/-]{0,500}$/;
const RE_DS_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,41}$/;   // vSphere 데이터스토어 이름 상한 42자

/** NFS 데이터스토어 정의 검증(순수). 통과하면 정규화 값, 아니면 throw. */
export function validateNfsDsSpec({ name, server, exportPath, nfsVersion } = {}) {
  const n = String(name ?? '').trim();
  const s = String(server ?? '').trim();
  const e = String(exportPath ?? '').trim();
  const v = String(nfsVersion ?? '3').trim() === '4.1' ? '4.1' : '3';
  if (!RE_DS_NAME.test(n)) throw new Error('데이터스토어 이름 형식 오류 — 영숫자로 시작하고 영숫자·. _ - 만, 42자까지');
  if (!RE_NFS_SERVER.test(s)) throw new Error('NFS 서버 형식 오류 — 호스트명/IP 만(공백·특수문자 불가, 선행 - 불가)');
  if (!RE_NFS_EXPORT.test(e) || e.split('/').includes('..')) throw new Error("export 경로 형식 오류 — '/'로 시작하는 절대경로, '..' 금지");
  return { name: n, server: s, exportPath: e, nfsVersion: v };
}

/** CreateNasDatastore 요청 XML(순수). vim25 HostNasVolumeSpec 순서: remoteHost · remotePath · localPath · accessMode · type · … · remoteHostNames · securityType. */
export function nasDatastoreXml(dsSysRef, spec) {
  const s = validateNfsDsSpec(spec);
  const v41 = s.nfsVersion === '4.1';
  return `<CreateNasDatastore xmlns="urn:vim25"><_this type="HostDatastoreSystem">${esc(dsSysRef)}</_this><spec>` +
    `<remoteHost>${esc(s.server)}</remoteHost><remotePath>${esc(s.exportPath)}</remotePath><localPath>${esc(s.name)}</localPath>` +
    `<accessMode>readWrite</accessMode><type>${v41 ? 'NFS41' : 'NFS'}</type>` +
    (v41 ? `<remoteHostNames>${esc(s.server)}</remoteHostNames><securityType>AUTH_SYS</securityType>` : '') +
    `</spec></CreateNasDatastore>`;
}

/**
 * 호스트 1대에 NFS 데이터스토어를 붙인다. 이미 같은 이름이 있으면 그 데이터스토어가 **같은 NFS** 를 가리킬 때만 성공으로 본다
 * (이름만 같고 다른 저장소면 실패 — 백업이 엉뚱한 곳에 써지지 않게).
 * @returns {Promise<{ok:boolean, detail:string, already?:boolean}>}
 */
export async function attachNasToHost(c, hostRef, spec) {
  const s = validateNfsDsSpec(spec);
  const objs = await c.retrieveObjectProps('HostSystem', hostRef, ['name', 'configManager.datastoreSystem', 'datastore']);
  const p = objs[0]?.props || {};
  const dsSys = p['configManager.datastoreSystem'];
  if (!dsSys || dsSys.includes('<')) return { ok: false, detail: '호스트의 데이터스토어 시스템을 찾지 못했습니다' };
  // 같은 이름이 이미 붙어 있는가
  const refs = [...String(p.datastore || '').matchAll(/<ManagedObjectReference type="Datastore">([^<]+)<\/ManagedObjectReference>/g)].map((m) => m[1]);
  if (refs.length) {
    const many = await c.retrieveManyObjectProps('Datastore', refs, ['name']);
    const hit = many.find((o) => vcNameNorm(o.props?.name) === s.name);
    if (hit) {
      const info = (await c.retrieveObjectProps('Datastore', hit.ref, ['info']))[0]?.props?.info || '';
      const rh = /<remoteHost>([^<]*)<\/remoteHost>/.exec(info)?.[1] || /<remoteHostNames>([^<]*)<\/remoteHostNames>/.exec(info)?.[1] || '';
      const rp = /<remotePath>([^<]*)<\/remotePath>/.exec(info)?.[1] || '';
      if (rh === s.server && trimTrailingSlashes(rp.slice(0, 600)) === trimTrailingSlashes(s.exportPath)) return { ok: true, already: true, detail: '이미 같은 NFS 로 연결돼 있습니다' };
      return { ok: false, detail: `같은 이름의 다른 데이터스토어가 있습니다(${rh || '?'}:${rp || '?'}) — 이름을 바꾸세요` };
    }
  }
  try {
    await c.callRaw(nasDatastoreXml(dsSys, s));
    return { ok: true, detail: '연결했습니다' };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e).slice(0, 300) };
  }
}

export { VimSoapClient };
