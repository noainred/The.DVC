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
// v2.743(감사 VC-03): 주문형 vCenter 로그인 문 — 판정은 collectTarget.js·authStopGate.js 하나(dsBrowse.js 가 묶는다). 사본을 만들지 않는다.
import { onDemandLogin } from '../vcenter/dsBrowse.js';
// v3.0.1: connectable 은 스키마 순서(startConnected · allowGuestControl · connected)로 — 조립은 connectInfo.js 하나(순서가 틀리면 vCenter 가 SOAP 500 으로 거부).
import { connectInfoXml, readConnectFlag, withConnectable, deviceInnerOf } from '../vcenter/connectInfo.js';
import { numOrNull } from '../util/numOrNull.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const GB_KB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pickTag = (xml, tag) => { const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml || ''); return m ? m[1] : ''; };

/**
 * 54회차 F4: 못 읽은 하드웨어 수치(vCPU · 코어/소켓 · 메모리 MB · 디스크 용량)는 **null** — 0 이 아니다.
 *   예전에는 `Number(x) || 0` 이라 vCenter 응답에 값이 없으면 0 이 되고, '증설만' 검사가 0 을 기준으로 판정해 어떤 값이든 '증설' 로 통과했다
 *   (감소를 막는 검사가 꺼진 것과 같다 — 전원 OFF VM 은 vCenter 가 vCPU · RAM 감소를 받아들인다). 0 이하도 실재하지 않는 값이라 못 읽음이다.
 */
const posIntOrNull = (v) => { const n = numOrNull(v); return Number.isInteger(n) && n > 0 ? n : null; };
/** 현재 값을 모르면 증설 여부를 판정할 수 없다 — 상태를 바꾸는 작업이라 막는다(fail-closed). 문구는 라우트가 400 reason 으로 그대로 싣는다. */
const UNKNOWN_BASE = (what) => `현재 ${what}을(를) 읽지 못해 증설 여부를 판정할 수 없습니다 — ${what} 변경을 막았습니다(사양 변경 창을 다시 열어 조회한 뒤 시도하세요).`;

const ETH_TYPES = new Set(['VirtualVmxnet3', 'VirtualVmxnet2', 'VirtualVmxnet', 'VirtualE1000', 'VirtualE1000e', 'VirtualPCNet32', 'VirtualSriovEthernetCard']);
const SCSI_RE = /SCSIController|LsiLogic|BusLogic|ParaVirtual/;

/**
 * config.hardware.device XML + 설정 플래그를 파싱해 구조화한 하드웨어 정보를 만든다.
 * 반환: { cpu, memMB, cpuHotAdd, memHotAdd, powerState, disks[], scsi[], nics[] } — cpu · coresPerSocket · memMB · disks[].capacityKB/GB 는 못 읽으면 null.
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
      // 54회차 F4: 용량을 못 읽으면 null(예전 0 — '증설만' 검사가 0 기준이라 아무 크기나 통과했다)
      const kb = posIntOrNull(pickTag(blk, 'capacityInKB'));
      const bytes = posIntOrNull(pickTag(blk, 'capacityInBytes'));
      const capKB = kb ?? (bytes != null && Math.round(bytes / 1024) > 0 ? Math.round(bytes / 1024) : null);
      disks.push({
        key, label,
        capacityKB: capKB,
        capacityGB: capKB == null ? null : Math.round((capKB / GB_KB) * 10) / 10,
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
      const inner = deviceInnerOf(blk);
      const nic = {
        key, label, type,
        network: stdNet || (dvsKey ? `(DVS:${dvsKey})` : ''),
        macAddress: pickTag(blk, 'macAddress'),
        connected: /<connected>true<\/connected>/.test(blk),
        allowGuestControl: readConnectFlag(inner, 'allowGuestControl'),   // v3.0.1: 연결 토글이 사용자가 바꾸지 않은 이 값을 지킨다(못 읽으면 null)
      };
      // v3.0.1: 연결 토글은 읽은 장치 본문 전체를 되돌려 보낸다(connectable 만 바꿈 — vmclone nicDisconnectSpec 과 같은 방식).
      //   backingXml 은 본문을 못 읽었을 때의 대체 경로 전용(backing 을 그대로 echo해야 안전 — 특히 DVS).
      //   둘 다 열거 불가 — GET /vm/:id/hardware 응답(JSON)에 싣지 않는다(응답 크기 · DVS portKey · connectionCookie 를 화면에 내리지 않게. 웹은 쓰지 않는다).
      Object.defineProperty(nic, 'deviceInner', { value: inner, enumerable: false });
      Object.defineProperty(nic, 'backingXml', { value: /<backing xsi:type="[^"]+">[\s\S]*?<\/backing>/.exec(blk)?.[0] || '', enumerable: false });
      nics.push(nic);
    }
  }
  return {
    cpu: posIntOrNull(meta.numCPU),                       // 54회차 F4: 못 읽으면 null(0 아님)
    coresPerSocket: posIntOrNull(meta.coresPerSocket),
    memMB: posIntOrNull(meta.memoryMB),
    cpuHotAdd: meta.cpuHotAdd === true || meta.cpuHotAdd === 'true',
    memHotAdd: meta.memHotAdd === true || meta.memHotAdd === 'true',
    powerState: meta.powerState || '',
    disks, scsi, nics,
  };
}

/**
 * 변경 요청(plan)을 검증하고 ReconfigVM_Task의 <spec> 내부 XML을 만든다(순수).
 * plan: { numCPUs?, memoryMB?, diskGrows?:[{key,newGB}], diskAdds?:[{sizeGB, controllerKey?, datastore?}],
 *         nicAdds?:[{network, dvs?:{switchUuid,portgroupKey}}], nicRemoves?:[key] }
 * 반환: { ok, errors[], changes[], specXml }  (errors 있으면 ok=false, 실행 금지)
 */
export function buildReconfigSpec(hw, plan = {}) {
  const errors = []; const changes = []; const parts = []; const dev = [];
  const poweredOn = /on/i.test(hw.powerState);

  // --- CPU (총 vCPU + 코어/소켓) ---
  const cps = plan.coresPerSocket != null ? Number(plan.coresPerSocket) : null;
  if (plan.numCPUs != null && Number(plan.numCPUs) !== hw.cpu) {
    const n = Number(plan.numCPUs);
    if (hw.cpu == null) errors.push(UNKNOWN_BASE('vCPU 수'));   // 54회차 F4: 기준을 모르면 '증설' 로 보지 않는다
    else if (!Number.isInteger(n) || n < 1) errors.push('vCPU 수가 올바르지 않습니다.');
    else if (n < hw.cpu) errors.push(`vCPU 감소는 허용되지 않습니다(증설만): ${hw.cpu} → ${n}`);
    else if (poweredOn && !hw.cpuHotAdd) errors.push('이 VM은 CPU hot-add가 비활성화되어 전원 ON 상태에서 vCPU 증설이 불가합니다. 전원 OFF 후 시도하세요.');
    else {
      parts.push(`<numCPUs>${n}</numCPUs>`);
      let lbl = `vCPU ${hw.cpu}→${n}`;
      if (cps && Number.isInteger(cps) && cps >= 1 && n % cps === 0) { parts.push(`<numCoresPerSocket>${cps}</numCoresPerSocket>`); lbl += ` (코어/소켓 ${cps})`; }
      else if (cps != null && cps >= 1 && n % cps !== 0) errors.push(`코어/소켓(${cps})은 총 vCPU(${n})의 약수여야 합니다.`);
      changes.push(lbl);
    }
  } else if (cps != null && cps >= 1) {
    // vCPU 수 변경 없이 코어/소켓만 조정.
    if (hw.cpu == null) errors.push(UNKNOWN_BASE('vCPU 수'));   // 54회차 F4: 약수 판정의 기준을 모른다
    else if (!Number.isInteger(cps) || hw.cpu % cps !== 0) errors.push(`코어/소켓(${cps})은 총 vCPU(${hw.cpu})의 약수여야 합니다.`);
    else { parts.push(`<numCoresPerSocket>${cps}</numCoresPerSocket>`); changes.push(`코어/소켓 →${cps}`); }
  }

  // --- RAM ---
  if (plan.memoryMB != null && Number(plan.memoryMB) !== hw.memMB) {
    const m = Number(plan.memoryMB);
    if (hw.memMB == null) errors.push(UNKNOWN_BASE('RAM'));   // 54회차 F4
    else if (!Number.isInteger(m) || m < 1) errors.push('RAM 값이 올바르지 않습니다.');
    else if (m < hw.memMB) errors.push(`RAM 감소는 허용되지 않습니다(증설만): ${hw.memMB}MB → ${m}MB`);
    else if (poweredOn && !hw.memHotAdd) errors.push('이 VM은 메모리 hot-add가 비활성화되어 전원 ON 상태에서 RAM 증설이 불가합니다. 전원 OFF 후 시도하세요.');
    else { parts.push(`<memoryMB>${m}</memoryMB>`); changes.push(`RAM ${hw.memMB}→${m}MB`); }
  }

  // --- 디스크 증설(edit) ---
  for (const g of (plan.diskGrows || [])) {
    const d = hw.disks.find((x) => x.key === Number(g.key));
    if (!d) { errors.push(`디스크(key=${g.key})를 찾을 수 없습니다.`); continue; }
    if (d.capacityKB == null) { errors.push(UNKNOWN_BASE(`${d.label || `디스크(key=${d.key})`} 용량`)); continue; }   // 54회차 F4
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
  if (adds.length && !hw.scsi.length) errors.push('디스크를 추가할 SCSI 컨트롤러가 없습니다.');
  else if (adds.length) {
    // 컨트롤러별 사용 유닛 추적(여러 디스크를 같은 컨트롤러에 추가해도 충돌 없게).
    const usedByCtrl = new Map();
    const usedUnits = (ck) => { if (!usedByCtrl.has(ck)) usedByCtrl.set(ck, new Set(hw.disks.filter((d) => d.controllerKey === ck).map((d) => d.unitNumber))); return usedByCtrl.get(ck); };
    const dsFor = (ck) => { const f = hw.disks.find((d) => d.controllerKey === ck)?.fileName || hw.disks[0]?.fileName || ''; return /^\[[^\]]+\]/.exec(f)?.[0] || ''; };
    let negKey = -101;
    for (const a of adds) {
      const gb = Number(a.sizeGB);
      if (!(gb > 0)) { errors.push('추가 디스크 용량이 올바르지 않습니다.'); continue; }
      // 컨트롤러 선택(미지정 시 첫 SCSI). 유효성 검사.
      const ctrl = a.controllerKey != null ? hw.scsi.find((s) => s.key === Number(a.controllerKey)) : hw.scsi[0];
      if (!ctrl) { errors.push('지정한 디스크 컨트롤러를 찾을 수 없습니다.'); continue; }
      // 데이터스토어: 명시 선택 시 그 데이터스토어에 배치(`[이름]`), 미지정이면 기존 디스크 위치 재사용.
      const dsName = a.datastore ? String(a.datastore).replace(/^\[|\]$/g, '').trim() : '';
      const dsBracket = dsName ? `[${dsName}]` : dsFor(ctrl.key);
      if (!dsBracket) { errors.push('데이터스토어를 확인할 수 없어 디스크를 추가할 수 없습니다(데이터스토어를 선택하세요).'); continue; }
      const used = usedUnits(ctrl.key);
      let unit = 0; while (used.has(unit) || unit === 7) unit++; used.add(unit);
      dev.push(
        `<deviceChange><operation>add</operation><fileOperation>create</fileOperation><device xsi:type="VirtualDisk">` +
        `<key>${negKey--}</key>` +
        `<backing xsi:type="VirtualDiskFlatVer2BackingInfo"><fileName>${esc(dsBracket)}</fileName><diskMode>persistent</diskMode><thinProvisioned>true</thinProvisioned></backing>` +
        `<controllerKey>${ctrl.key}</controllerKey><unitNumber>${unit}</unitNumber>` +
        `<capacityInKB>${Math.round(gb * GB_KB)}</capacityInKB>` +
        `</device></deviceChange>`);
      changes.push(`디스크 추가 +${gb}GB (${ctrl.label || `ctrl ${ctrl.key}`}${dsName ? `, ${dsName}` : ''})`);
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
      connectInfoXml({ startConnected: true, allowGuestControl: true, connected: poweredOn }) +
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

  // --- NIC 연결 토글(connect/disconnect) ---
  const removeSet = new Set((plan.nicRemoves || []).map(Number));
  for (const nc of (plan.nicConnects || [])) {
    const nic = hw.nics.find((x) => x.key === Number(nc.key));
    if (!nic) { errors.push(`NIC(key=${nc.key})를 찾을 수 없습니다.`); continue; }
    if (removeSet.has(Number(nc.key))) continue; // 삭제 대상이면 토글 무시
    const connected = !!nc.connected;
    if (connected === nic.connected) continue;    // 변화 없음
    // v3.0.1: 예전엔 startConnected · connected · allowGuestControl 순서라 vCenter 가 늘 SOAP 500 으로 거부했다(사용자 실측).
    //   allowGuestControl 은 읽은 값을 지킨다(이 화면은 그 칸을 바꾸지 않는다). 못 읽었을 때만 새 NIC 기본값 true.
    const conn = connectInfoXml({ startConnected: connected, allowGuestControl: nic.allowGuestControl ?? true, connected });
    const body = nic.deviceInner ? withConnectable(nic.deviceInner, conn) : `<key>${nic.key}</key>${nic.backingXml || ''}${conn}`;
    dev.push(`<deviceChange><operation>edit</operation><device xsi:type="${nic.type}">${body}</device></deviceChange>`);
    changes.push(`NIC ${connected ? '연결' : '연결 해제'} (${nic.network || nic.macAddress || nic.key})`);
  }

  if (errors.length) return { ok: false, errors, changes: [], specXml: '' };
  if (!parts.length && !dev.length) return { ok: false, errors: ['변경 사항이 없습니다.'], changes: [], specXml: '' };
  return { ok: true, errors: [], changes, specXml: parts.join('') + dev.join('') };
}

/**
 * Task 완료 대기(폴링). 반환 { ok:true } | { ok:false, error } | { ok:false, timeout:true, error }.
 * 결정(56~75 남긴 것) 74 ②: 프로비저닝(provision/jobs.js — 복제 작업 결과 추적)도 이 함수를 쓴다(대기 · 시한 판정 한 벌).
 *   · 시간 초과는 실패와 구분해 timeout:true 를 싣는다 — 작업을 취소하지 않으므로 vCenter 에서 계속될 수 있다(부르는 쪽이 그렇게 말한다).
 *   · 시한을 넘긴 뒤에도 **한 번은 상태를 본다**(예전에는 루프 조건이 먼저라 늦게 시작한 대기가 보지도 않고 시간 초과였다).
 * @param {{timeoutMs?:number, pollMs?:number, t0?:number}} [o]
 */
export async function waitTask(c, taskRef, { timeoutMs = 180_000, pollMs = 1_500, t0 = Date.now() } = {}) {
  for (;;) {
    const objs = await c.retrieveObjectProps('Task', taskRef, ['info.state', 'info.error']);
    const st = objs[0]?.props?.['info.state'] || '';
    if (/success/i.test(st)) return { ok: true };
    if (/error/i.test(st)) {
      const errXml = objs[0]?.props?.['info.error'] || '';
      return { ok: false, error: /<localizedMessage>([^<]+)<\/localizedMessage>/.exec(errXml)?.[1] || 'vCenter 작업 실패' };
    }
    if (Date.now() - t0 >= timeoutMs) return { ok: false, timeout: true, error: '작업 시간 초과' };
    await sleep(pollMs);
  }
}

/*
 * 결정(56~75 남긴 것) 74 ④: VM 사양 변경의 **서버 쪽 VM 단위 진행 중 잠금** — 예전에는 화면 버튼만 잠가 두 탭 · 두 사람이 같은 VM 에
 *   디스크 추가 · NIC 추가를 겹쳐 보낼 수 있었다(ReconfigVM_Task 두 건 — 디스크가 두 번 붙는다). 같은 VM 의 두 번째 요청은 409(라우트).
 *   끝나면(성공 · 실패 · 예외) 해제하고, 해제가 오지 않은 잠금(멈춘 요청)은 시한(RECONFIG_LOCK_TTL_MS)이 지나면 새 요청이 가져간다.
 *   해제 함수는 자기 잠금만 푼다(시한 뒤 다른 요청이 가져간 잠금을 늦게 끝난 옛 요청이 풀지 않게).
 */
export const RECONFIG_LOCK_TTL_MS = 15 * 60_000;
const _reconfigLocks = new Map();   // vmId -> { token, at }
let _lockSeq = 0;
/** 잡으면 해제 함수, 진행 중이면 null. */
export function tryLockVmReconfig(vmId, { now = Date.now(), ttlMs = RECONFIG_LOCK_TTL_MS } = {}) {
  const k = String(vmId ?? '');
  const cur = _reconfigLocks.get(k);
  if (cur && now - cur.at < ttlMs) return null;
  const token = ++_lockSeq;
  _reconfigLocks.set(k, { token, at: now });
  return () => { if (_reconfigLocks.get(k)?.token === token) _reconfigLocks.delete(k); };
}
export function reconfigLocksForTest() { return _reconfigLocks; }

/** VM 현재 하드웨어 조회(라우트용). */
export async function getVmHardware(vc, moref) {
  const c = new VimSoapClient(vc);
  // v2.743(VC-03): 화면을 열 때 부르는 주문형 조회다 — 비활성·점검중·엣지 위임(site)·주 폴러가 인증 실패로 멈춘 vCenter 에는
  //   로그인하지 않고 409(사유 skipReason·authStopped)를 던진다. 거부는 주 폴러와 같은 정지 기록에 올라간다.
  await onDemandLogin(c, vc);
  try {
    const objs = await c.retrieveObjectProps('VirtualMachine', moref, [
      'config.hardware.device', 'config.hardware.numCPU', 'config.hardware.numCoresPerSocket', 'config.hardware.memoryMB',
      'config.cpuHotAddEnabled', 'config.memoryHotAddEnabled', 'runtime.powerState',
    ]);
    const p = objs[0]?.props || {};
    return parseHardware(p['config.hardware.device'], {
      numCPU: p['config.hardware.numCPU'], coresPerSocket: p['config.hardware.numCoresPerSocket'], memoryMB: p['config.hardware.memoryMB'],
      cpuHotAdd: p['config.cpuHotAddEnabled'], memHotAdd: p['config.memoryHotAddEnabled'],
      powerState: p['runtime.powerState'],
    });
  } finally { await c.logout().catch(() => {}); }
}

/** DVS 포트그룹(moref)에서 switchUuid + portgroupKey 해석(NIC 추가용). */
/**
 * v2.767(점검 R2-B3-10): MoRef 값 화이트리스트 — retrieveObjectProps 는 ref 를 이스케이프 없이 RetrieveProperties XML 에 넣는다
 *   (soapClient.js). 요청 본문의 nicAdds[].networkMoref 가 그대로 들어가 XML 요소를 덧붙일 수 있었다. vSphere MoRef 는
 *   'dvportgroup-123'·'group-v3' 꼴이라 영숫자와 . _ : - 만 받는다(XML 특수문자 <>&"' 가 들어갈 자리가 없다).
 */
const MOREF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
export function isSafeMoref(v) { return typeof v === 'string' && MOREF_RE.test(v); }

async function resolveDvsBacking(c, pgMoref) {
  if (!isSafeMoref(pgMoref)) throw new Error('NIC 추가: 네트워크 MoRef 형식이 올바르지 않습니다.');
  const pg = await c.retrieveObjectProps('DistributedVirtualPortgroup', pgMoref, ['key', 'config.distributedVirtualSwitch']);
  const portgroupKey = pg[0]?.props?.key || '';
  const dvsRef = (pg[0]?.props?.['config.distributedVirtualSwitch'] || '').trim();
  if (!portgroupKey || !dvsRef) throw new Error('DVS 포트그룹 정보를 해석할 수 없습니다.');
  if (!isSafeMoref(dvsRef)) throw new Error('DVS 포트그룹 정보를 해석할 수 없습니다(스위치 MoRef 형식).');   // 응답 값도 같은 규칙(이중 방어)
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
  // v2.767(R2-B3-10): 형식이 틀린 네트워크 MoRef 는 로그인 전에 거절한다(아래 resolveDvsBacking 도 같은 검사 — 이중 방어).
  for (const n of (Array.isArray(plan.nicAdds) ? plan.nicAdds : [])) {
    if (n?.type === 'DISTRIBUTED_PORTGROUP' && n.networkMoref && !isSafeMoref(String(n.networkMoref))) {
      return { ok: false, error: 'NIC 추가: 네트워크 MoRef 형식이 올바르지 않습니다.' };
    }
  }
  const c = new VimSoapClient(vc);
  // v2.743(VC-03): 관리자가 누른 쓰기 실행 — 비활성·점검중·site 는 막고, 인증 정지는 1회 시도한다(게스트 계정 추가와 같은 판단).
  //   로그인 거부는 정지 기록에 올리고 409 로 바꾼다.
  await onDemandLogin(c, vc, { allowAuthStopped: true });
  try {
    // 최신 하드웨어 재조회(스냅샷과 어긋나도 안전하게 검증).
    const objs = await c.retrieveObjectProps('VirtualMachine', moref, [
      'config.hardware.device', 'config.hardware.numCPU', 'config.hardware.numCoresPerSocket', 'config.hardware.memoryMB',
      'config.cpuHotAddEnabled', 'config.memoryHotAddEnabled', 'runtime.powerState',
    ]);
    const p = objs[0]?.props || {};
    const hw = parseHardware(p['config.hardware.device'], {
      numCPU: p['config.hardware.numCPU'], coresPerSocket: p['config.hardware.numCoresPerSocket'], memoryMB: p['config.hardware.memoryMB'],
      cpuHotAdd: p['config.cpuHotAddEnabled'], memHotAdd: p['config.memoryHotAddEnabled'],
      powerState: p['runtime.powerState'],
    });

    // NIC 추가의 DVS 백킹 해석(필요 시).
    const nicAdds = [];
    for (const n of (plan.nicAdds || [])) {
      if (n.type === 'DISTRIBUTED_PORTGROUP' && n.networkMoref) {
        nicAdds.push({ dvs: await resolveDvsBacking(c, String(n.networkMoref)) });
      } else if (n.networkName) {
        nicAdds.push({ network: n.networkName });
      } else throw new Error('NIC 추가: 네트워크 지정이 필요합니다.');
    }

    const spec = buildReconfigSpec(hw, { ...plan, nicAdds });
    if (!spec.ok) return { ok: false, error: spec.errors.join(' / ') };

    const res = await c.callRaw(`<ReconfigVM_Task xmlns="urn:vim25"><_this type="VirtualMachine">${moref}</_this><spec>${spec.specXml}</spec></ReconfigVM_Task>`);
    const task = /<returnval type="Task">([^<]+)<\/returnval>/.exec(res)?.[1];
    if (!task) return { ok: false, error: 'ReconfigVM_Task 제출 실패(Task 미반환).' };
    const done = await waitTask(c, task);   // 기본 180초 · 1.5초 간격(예전과 같다)
    if (done.ok) return { ok: true, changes: spec.changes };
    // 74 ②(형제): 시간 초과는 실패가 아니라 '결과 모름' 이다 — 작업을 취소하지 않으므로 vCenter 에서 계속될 수 있다.
    if (done.timeout) return { ok: false, timeout: true, error: '작업 시간 초과(3분) — vCenter 에서 계속될 수 있습니다(vCenter 최근 작업에서 결과를 확인하세요).', changes: spec.changes };
    return { ok: false, error: done.error, changes: spec.changes };
  } finally { await c.logout().catch(() => {}); }
}
