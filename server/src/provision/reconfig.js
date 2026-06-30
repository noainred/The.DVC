/**
 * VM 사양 변경 — vim25 ReconfigVM_Task로 vCPU/RAM 변경, 디스크 증설/추가, NIC 추가/삭제.
 *
 * vCenter 쓰기는 이미 운영 중인 provision(CloneVM_Task)과 같은 VimSoapClient.callRaw 패턴을 쓴다.
 * 운영 VM을 실제로 바꾸므로 안전 정책을 코드로 강제한다:
 *   - CPU/RAM/디스크는 '증설만'(감소·축소 차단). NIC는 추가/삭제 허용(명시 요청).
 *   - CPU/RAM 증설은 hot-add가 켜진 VM이면 무중단, 아니면 전원 OFF 필요(자동 OFF 하지 않고 거부+안내).
 *   - 디스크 증설/추가, NIC 추가/삭제는 전원 ON 상태에서도 가능(온라인).
 *
 * parseHardware()/buildReconfigSpec()는 SOAP 없이 동작하는 순수 함수(단위테스트 대상)다.
 */

import { VimSoapClient } from '../vcenter/soapClient.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const GB_KB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pickTag = (xml, tag) => { const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml || ''); return m ? m[1] : ''; };

const ETH_TYPES = new Set(['VirtualVmxnet3', 'VirtualVmxnet2', 'VirtualVmxnet', 'VirtualE1000', 'VirtualE1000e', 'VirtualPCNet32', 'VirtualSriovEthernetCard']);
const SCSI_RE = /SCSIController|LsiLogic|BusLogic|ParaVirtual/;

/**
 * config.hardware.device XML + 설정 플래그를 파싱해 구조화한 하드웨어 정보를 만든다.
 * 반환: { cpu, memMB, cpuHotAdd, memHotAdd, powerState, disks[], scsi[], nics[] }
 */
export function parseHardware(deviceXml, meta = {}) {
  const disks = []; const scsi = []; const nics = [];
  // 배열 요소는 <VirtualDevice xsi:type="...">로 직렬화된다(백킹 필드엔 이 토큰이 없어 분할 안전).
  for (const raw of String(deviceXml || '').split('<VirtualDevice ').slice(1)) {
    const blk = '<VirtualDevice ' + raw;
    const type = /xsi:type="([^"]+)"/.exec(blk)?.[1] || '';
    const key = Number(pickTag(blk, 'key'));
    if (!Number.isFinite(key)) continue;
    const label = /<deviceInfo>[\s\S]*?<label>([^<]*)<\/label>/.exec(blk)?.[1] || '';
    if (type === 'VirtualDisk') {
      const capKB = Number(pickTag(blk, 'capacityInKB')) || Math.round((Number(pickTag(blk, 'capacityInBytes')) || 0) / 1024);
      disks.push({
        key, label,
        capacityKB: capKB,
        capacityGB: Math.round((capKB / GB_KB) * 10) / 10,
        controllerKey: Number(pickTag(blk, 'controllerKey')) || 0,
        unitNumber: Number(pickTag(blk, 'unitNumber')) || 0,
        fileName: /<fileName>([^<]*)<\/fileName>/.exec(blk)?.[1] || '',
        diskMode: pickTag(blk, 'diskMode') || 'persistent',
        thin: /<thinProvisioned>true<\/thinProvisioned>/.test(blk),
        backingType: /<backing xsi:type="([^"]+)"/.exec(blk)?.[1] || 'VirtualDiskFlatVer2BackingInfo',
      });
    } else if (SCSI_RE.test(type)) {
      scsi.push({ key, label, type, busNumber: Number(pickTag(blk, 'busNumber')) || 0 });
    } else if (ETH_TYPES.has(type)) {
      const stdNet = /<backing xsi:type="VirtualEthernetCardNetworkBackingInfo">[\s\S]*?<deviceName>([^<]*)<\/deviceName>/.exec(blk)?.[1];
      const dvsKey = /<portgroupKey>([^<]*)<\/portgroupKey>/.exec(blk)?.[1];
      nics.push({
        key, label, type,
        network: stdNet || (dvsKey ? `(DVS:${dvsKey})` : ''),
        macAddress: pickTag(blk, 'macAddress'),
        connected: /<connected>true<\/connected>/.test(blk),
      });
    }
  }
  return {
    cpu: Number(meta.numCPU) || 0,
    memMB: Number(meta.memoryMB) || 0,
    cpuHotAdd: meta.cpuHotAdd === true || meta.cpuHotAdd === 'true',
    memHotAdd: meta.memHotAdd === true || meta.memHotAdd === 'true',
    powerState: meta.powerState || '',
    disks, scsi, nics,
  };
}

/**
 * 변경 요청(plan)을 검증하고 ReconfigVM_Task의 <spec> 내부 XML을 만든다(순수).
 * plan: { numCPUs?, memoryMB?, diskGrows?:[{key,newGB}], diskAdds?:[{sizeGB}],
 *         nicAdds?:[{network, dvs?:{switchUuid,portgroupKey}}], nicRemoves?:[key] }
 * 반환: { ok, errors[], changes[], specXml }  (errors 있으면 ok=false, 실행 금지)
 */
export function buildReconfigSpec(hw, plan = {}) {
  const errors = []; const changes = []; const parts = []; const dev = [];
  const poweredOn = /on/i.test(hw.powerState);

  // --- CPU ---
  if (plan.numCPUs != null && Number(plan.numCPUs) !== hw.cpu) {
    const n = Number(plan.numCPUs);
    if (!Number.isInteger(n) || n < 1) errors.push('vCPU 수가 올바르지 않습니다.');
    else if (n < hw.cpu) errors.push(`vCPU 감소는 허용되지 않습니다(증설만): ${hw.cpu} → ${n}`);
    else if (poweredOn && !hw.cpuHotAdd) errors.push('이 VM은 CPU hot-add가 비활성화되어 전원 ON 상태에서 vCPU 증설이 불가합니다. 전원 OFF 후 시도하세요.');
    else { parts.push(`<numCPUs>${n}</numCPUs>`); changes.push(`vCPU ${hw.cpu}→${n}`); }
  }

  // --- RAM ---
  if (plan.memoryMB != null && Number(plan.memoryMB) !== hw.memMB) {
    const m = Number(plan.memoryMB);
    if (!Number.isInteger(m) || m < 1) errors.push('RAM 값이 올바르지 않습니다.');
    else if (m < hw.memMB) errors.push(`RAM 감소는 허용되지 않습니다(증설만): ${hw.memMB}MB → ${m}MB`);
    else if (poweredOn && !hw.memHotAdd) errors.push('이 VM은 메모리 hot-add가 비활성화되어 전원 ON 상태에서 RAM 증설이 불가합니다. 전원 OFF 후 시도하세요.');
    else { parts.push(`<memoryMB>${m}</memoryMB>`); changes.push(`RAM ${hw.memMB}→${m}MB`); }
  }

  // --- 디스크 증설(edit) ---
  for (const g of (plan.diskGrows || [])) {
    const d = hw.disks.find((x) => x.key === Number(g.key));
    if (!d) { errors.push(`디스크(key=${g.key})를 찾을 수 없습니다.`); continue; }
    const newKB = Math.round(Number(g.newGB) * GB_KB);
    if (!(newKB > d.capacityKB)) { errors.push(`${d.label}: 증설만 가능합니다(현재 ${d.capacityGB}GB 이하 불가).`); continue; }
    dev.push(
      `<deviceChange><operation>edit</operation><device xsi:type="VirtualDisk">` +
      `<key>${d.key}</key>` +
      `<backing xsi:type="${d.backingType}"><fileName>${esc(d.fileName)}</fileName><diskMode>${esc(d.diskMode)}</diskMode></backing>` +
      `<controllerKey>${d.controllerKey}</controllerKey><unitNumber>${d.unitNumber}</unitNumber>` +
      `<capacityInKB>${newKB}</capacityInKB>` +
      `</device></deviceChange>`);
    changes.push(`${d.label} ${d.capacityGB}→${Math.round(newKB / GB_KB * 10) / 10}GB`);
  }

  // --- 디스크 추가(add+create) ---
  const adds = plan.diskAdds || [];
  if (adds.length) {
    const ctrl = hw.scsi[0];
    if (!ctrl) errors.push('디스크를 추가할 SCSI 컨트롤러가 없습니다.');
    else {
      const used = new Set(hw.disks.filter((d) => d.controllerKey === ctrl.key).map((d) => d.unitNumber));
      // 같은 컨트롤러의 기존 디스크 데이터스토어를 재사용([ds]만 주면 vCenter가 파일명을 정함).
      const sampleFile = hw.disks.find((d) => d.controllerKey === ctrl.key)?.fileName || hw.disks[0]?.fileName || '';
      const dsBracket = (/^\[[^\]]+\]/.exec(sampleFile)?.[0]) || '';
      let nextUnit = 0; let negKey = -101;
      const freeUnit = () => { while (used.has(nextUnit) || nextUnit === 7) nextUnit++; used.add(nextUnit); return nextUnit; };
      for (const a of adds) {
        const gb = Number(a.sizeGB);
        if (!(gb > 0)) { errors.push('추가 디스크 용량이 올바르지 않습니다.'); continue; }
        if (!dsBracket) { errors.push('데이터스토어를 확인할 수 없어 디스크를 추가할 수 없습니다.'); continue; }
        const unit = freeUnit();
        dev.push(
          `<deviceChange><operation>add</operation><fileOperation>create</fileOperation><device xsi:type="VirtualDisk">` +
          `<key>${negKey--}</key>` +
          `<backing xsi:type="VirtualDiskFlatVer2BackingInfo"><fileName>${esc(dsBracket)}</fileName><diskMode>persistent</diskMode><thinProvisioned>true</thinProvisioned></backing>` +
          `<controllerKey>${ctrl.key}</controllerKey><unitNumber>${unit}</unitNumber>` +
          `<capacityInKB>${Math.round(gb * GB_KB)}</capacityInKB>` +
          `</device></deviceChange>`);
        changes.push(`디스크 추가 +${gb}GB`);
      }
    }
  }

  // --- NIC 추가 ---
  let nicNeg = -201;
  for (const n of (plan.nicAdds || [])) {
    let backing;
    if (n.dvs && n.dvs.switchUuid && n.dvs.portgroupKey) {
      backing = `<backing xsi:type="VirtualEthernetCardDistributedVirtualPortBackingInfo"><port><switchUuid>${esc(n.dvs.switchUuid)}</switchUuid><portgroupKey>${esc(n.dvs.portgroupKey)}</portgroupKey></port></backing>`;
    } else if (n.network) {
      backing = `<backing xsi:type="VirtualEthernetCardNetworkBackingInfo"><deviceName>${esc(n.network)}</deviceName></backing>`;
    } else { errors.push('NIC 추가: 네트워크를 지정하세요.'); continue; }
    dev.push(
      `<deviceChange><operation>add</operation><device xsi:type="VirtualVmxnet3">` +
      `<key>${nicNeg--}</key>${backing}` +
      `<connectable><startConnected>true</startConnected><connected>${poweredOn ? 'true' : 'false'}</connected><allowGuestControl>true</allowGuestControl></connectable>` +
      `</device></deviceChange>`);
    changes.push(`NIC 추가 (${n.dvs?.portgroupKey ? 'DVS' : n.network})`);
  }

  // --- NIC 삭제 ---
  for (const key of (plan.nicRemoves || [])) {
    const nic = hw.nics.find((x) => x.key === Number(key));
    if (!nic) { errors.push(`NIC(key=${key})를 찾을 수 없습니다.`); continue; }
    dev.push(`<deviceChange><operation>remove</operation><device xsi:type="${nic.type}"><key>${nic.key}</key></device></deviceChange>`);
    changes.push(`NIC 삭제 (${nic.network || nic.macAddress || nic.key})`);
  }

  if (errors.length) return { ok: false, errors, changes: [], specXml: '' };
  if (!parts.length && !dev.length) return { ok: false, errors: ['변경 사항이 없습니다.'], changes: [], specXml: '' };
  return { ok: true, errors: [], changes, specXml: parts.join('') + dev.join('') };
}

/** Task 완료 대기(폴링). 반환 { ok, error? }. */
async function waitTask(c, taskRef, timeoutMs = 180_000, t0 = Date.now()) {
  while (Date.now() - t0 < timeoutMs) {
    const objs = await c.retrieveObjectProps('Task', taskRef, ['info.state', 'info.error']);
    const st = objs[0]?.props?.['info.state'] || '';
    if (/success/i.test(st)) return { ok: true };
    if (/error/i.test(st)) {
      const errXml = objs[0]?.props?.['info.error'] || '';
      return { ok: false, error: /<localizedMessage>([^<]+)<\/localizedMessage>/.exec(errXml)?.[1] || 'vCenter 작업 실패' };
    }
    await sleep(1500);
  }
  return { ok: false, error: '작업 시간 초과' };
}

/** VM 현재 하드웨어 조회(라우트용). */
export async function getVmHardware(vc, moref) {
  const c = new VimSoapClient(vc);
  await c.login();
  try {
    const objs = await c.retrieveObjectProps('VirtualMachine', moref, [
      'config.hardware.device', 'config.hardware.numCPU', 'config.hardware.memoryMB',
      'config.cpuHotAddEnabled', 'config.memoryHotAddEnabled', 'runtime.powerState',
    ]);
    const p = objs[0]?.props || {};
    return parseHardware(p['config.hardware.device'], {
      numCPU: p['config.hardware.numCPU'], memoryMB: p['config.hardware.memoryMB'],
      cpuHotAdd: p['config.cpuHotAddEnabled'], memHotAdd: p['config.memoryHotAddEnabled'],
      powerState: p['runtime.powerState'],
    });
  } finally { await c.logout().catch(() => {}); }
}

/** DVS 포트그룹(moref)에서 switchUuid + portgroupKey 해석(NIC 추가용). */
async function resolveDvsBacking(c, pgMoref) {
  const pg = await c.retrieveObjectProps('DistributedVirtualPortgroup', pgMoref, ['key', 'config.distributedVirtualSwitch']);
  const portgroupKey = pg[0]?.props?.key || '';
  const dvsRef = (pg[0]?.props?.['config.distributedVirtualSwitch'] || '').trim();
  if (!portgroupKey || !dvsRef) throw new Error('DVS 포트그룹 정보를 해석할 수 없습니다.');
  const dvs = await c.retrieveObjectProps('DistributedVirtualSwitch', dvsRef, ['uuid']);
  const switchUuid = dvs[0]?.props?.uuid || '';
  if (!switchUuid) throw new Error('DVS uuid를 해석할 수 없습니다.');
  return { switchUuid, portgroupKey };
}

/**
 * VM 사양 변경 실행. plan의 nicAdds는 { networkMoref?, networkName?, type } 형태로 받아
 * DVS면 switchUuid/portgroupKey를 해석한다. 반환 { ok, changes?, error? }.
 */
export async function reconfigVm(vc, moref, plan = {}) {
  const c = new VimSoapClient(vc);
  await c.login();
  try {
    // 최신 하드웨어 재조회(스냅샷과 어긋나도 안전하게 검증).
    const objs = await c.retrieveObjectProps('VirtualMachine', moref, [
      'config.hardware.device', 'config.hardware.numCPU', 'config.hardware.memoryMB',
      'config.cpuHotAddEnabled', 'config.memoryHotAddEnabled', 'runtime.powerState',
    ]);
    const p = objs[0]?.props || {};
    const hw = parseHardware(p['config.hardware.device'], {
      numCPU: p['config.hardware.numCPU'], memoryMB: p['config.hardware.memoryMB'],
      cpuHotAdd: p['config.cpuHotAddEnabled'], memHotAdd: p['config.memoryHotAddEnabled'],
      powerState: p['runtime.powerState'],
    });

    // NIC 추가의 DVS 백킹 해석(필요 시).
    const nicAdds = [];
    for (const n of (plan.nicAdds || [])) {
      if (n.type === 'DISTRIBUTED_PORTGROUP' && n.networkMoref) {
        nicAdds.push({ dvs: await resolveDvsBacking(c, n.networkMoref) });
      } else if (n.networkName) {
        nicAdds.push({ network: n.networkName });
      } else throw new Error('NIC 추가: 네트워크 지정이 필요합니다.');
    }

    const spec = buildReconfigSpec(hw, { ...plan, nicAdds });
    if (!spec.ok) return { ok: false, error: spec.errors.join(' / ') };

    const res = await c.callRaw(`<ReconfigVM_Task xmlns="urn:vim25"><_this type="VirtualMachine">${moref}</_this><spec>${spec.specXml}</spec></ReconfigVM_Task>`);
    const task = /<returnval type="Task">([^<]+)<\/returnval>/.exec(res)?.[1];
    if (!task) return { ok: false, error: 'ReconfigVM_Task 제출 실패(Task 미반환).' };
    const done = await waitTask(c, task);
    return done.ok ? { ok: true, changes: spec.changes } : { ok: false, error: done.error, changes: spec.changes };
  } finally { await c.logout().catch(() => {}); }
}
