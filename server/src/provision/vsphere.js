/**
 * Live VM provisioning against a real vCenter via the vim25 SOAP API.
 *
 * Clones a source VM/template (CloneVM_Task) into its parent folder on the same
 * datastore/host (empty RelocateSpec), applying a guest CustomizationSpec so the
 * new guest comes up with the requested hostname + static IP (or DHCP).
 *
 * One login is reused for the whole batch. Each clone is fire-and-return: we
 * issue the task and report it as submitted (vCenter runs it asynchronously);
 * a faulted submission is reported per-VM so one failure never aborts the rest.
 */

import { VimSoapClient } from '../vcenter/soapClient.js';
import { onDemandLogin } from '../vcenter/dsBrowse.js';   // v2.743(감사 VC-03): 주문형 vCenter 로그인 문(판정은 collectTarget·authStopGate 하나)
import { store } from '../store.js';
import { morefOf } from '../vcenter/registry.js';   // v2.447: 콜론 포함 vcenterId 안전(감사 B1)

// Resolve a host/datastore display name to its MoRef using the live snapshot
// (snapshot ids are `${vcId}:${moref}`), scoped to one vCenter.
// v2.447(감사 B1): vcenterId 에 콜론이 있을 수 있어 split(':') 로 자르면 MoRef 가 깨진다 —
// 공용 morefOf(id, vcenterId) 로 통일(vcenter/registry.js).
function findHostRef(vcenterId, name) {
  const h = store.get().hosts.find((x) => x.vcenterId === vcenterId && x.name === name);
  return h ? morefOf(h.id, vcenterId) : null;
}
function findDatastoreRef(vcenterId, name) {
  const d = store.get().datastores.find((x) => x.vcenterId === vcenterId && x.name === name);
  return d ? morefOf(d.id, vcenterId) : null;
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const isWindows = (guestOS = '') => /win|microsoft/i.test(guestOS);

export function customizationXml(vm, guest, windows) {   // v2.767: 요소 순서 고정 테스트용으로 내보낸다(audit2767a)
  const dns = (guest.dnsServers || []).filter(Boolean);
  // vim25 CustomizationGlobalIPSettings 시퀀스는 dnsSuffixList → dnsServerList 순서다.
  // (순서가 뒤바뀌면 vCenter SOAP 디시리얼라이저가 unexpected-element로 거부 → 정적 IP 클론 전부 실패.)
  const globalIp =
    `<globalIPSettings>` +
    (guest.domain ? `<dnsSuffixList>${esc(guest.domain)}</dnsSuffixList>` : '') +
    dns.map((d) => `<dnsServerList>${esc(d)}</dnsServerList>`).join('') +
    `</globalIPSettings>`;

  const identity = windows
    ? `<identity xsi:type="CustomizationSysprep">` +
        // v2.767(점검 R2-B3-5): vim25 CustomizationGuiUnattended 시퀀스는 password? → timeZone → autoLogon → autoLogonCount 다
        //   (pyVmomi 9.1.1.0 _typeinfo_vim CustomizationGuiUnattended 대조 — 실 vCenter 미확인). 예전 autoLogon→autoLogonCount→timeZone 은
        //   위 globalIPSettings 와 같은 unexpected-element 거부를 부른다(Windows 원본 프로비저닝 전부 실패 예상).
        `<guiUnattended><timeZone>110</timeZone><autoLogon>false</autoLogon><autoLogonCount>0</autoLogonCount></guiUnattended>` +
        `<userData>` +
          `<fullName>Administrator</fullName><orgName>Org</orgName>` +
          `<computerName xsi:type="CustomizationFixedName"><name>${esc(vm.hostname || vm.name)}</name></computerName>` +
          `<productId></productId>` +
        `</userData>` +
        `<identification></identification>` +
      `</identity>`
    : `<identity xsi:type="CustomizationLinuxPrep">` +
        `<hostName xsi:type="CustomizationFixedName"><name>${esc(vm.hostname || vm.name)}</name></hostName>` +
        (guest.domain ? `<domain>${esc(guest.domain)}</domain>` : '<domain></domain>') +
        `<hwClockUTC>true</hwClockUTC>` +
      `</identity>`;

  // One <nicSettingMap> per virtual NIC, applied in order; optional <macAddress>
  // binds a specific NIC (otherwise positional). Falls back to a single NIC for
  // older saved specs that only carry vm.ip.
  const nics = (Array.isArray(vm.nics) && vm.nics.length)
    ? vm.nics
    : [{ dhcp: guest.ipMode === 'dhcp' || !vm.ip, ip: vm.ip, subnetMask: guest.subnetMask, gateway: guest.gateway, mac: '' }];
  const nicXml = (nic) => {
    const ipSpec = nic.dhcp || !nic.ip
      ? `<ip xsi:type="CustomizationDhcpIpGenerator"/>`
      : `<ip xsi:type="CustomizationFixedIp"><ipAddress>${esc(nic.ip)}</ipAddress></ip>` +
        (nic.subnetMask ? `<subnetMask>${esc(nic.subnetMask)}</subnetMask>` : '') +
        (nic.gateway ? `<gateway>${esc(nic.gateway)}</gateway>` : '');
    return `<nicSettingMap>${nic.mac ? `<macAddress>${esc(nic.mac)}</macAddress>` : ''}<adapter>${ipSpec}</adapter></nicSettingMap>`;
  };
  const nicMap = nics.map(nicXml).join('');
  return `<customization>${identity}${globalIp}${nicMap}</customization>`;
}

export function createProvisioner(vc) {
  const client = new VimSoapClient(vc);
  let loggedIn = false;
  // v2.743(감사 VC-03): 로그인은 주문형 로그인 문을 지난다(관리자가 누른 쓰기 실행 — 비활성·점검중·엣지 위임 vCenter 는 막고, 인증 정지는
  //   1회 시도한다. 거부는 주 폴러와 같은 정지 기록에 올라간다). 그리고 **배치 전체가 한 번의 시도를 공유한다** — 예전에는 동시 실행
  //   VM 마다 ensureLogin 을 따로 불러(로그인이 끝나기 전 loggedIn 이 거짓) 동시성만큼 로그인했고, 실패하면 남은 VM 마다 다시 로그인했다
  //   (틀린 비밀번호면 VM 100대 배치가 실패 로그인 100회 — 계정 잠금 경로). 막힘·자격증명 거부(409)는 기억해 남은 VM 이 다시 시도하지 않고,
  //   시한·연결 실패 같은 일시 오류만 다음 VM 이 다시 시도한다(authGuard 규칙 4 — 일시 장애를 계정 거부로 굳히지 않는다).
  let loginTry = null;
  let loginFatal = null;
  const ensureLogin = async () => {
    if (loggedIn) return;
    if (loginFatal) throw loginFatal;
    if (!loginTry) {
      loginTry = onDemandLogin(client, vc, { allowAuthStopped: true })
        .then(() => { loggedIn = true; })
        .catch((err) => { if (err?.status === 409) loginFatal = err; throw err; })
        .finally(() => { loginTry = null; });
    }
    await loginTry;
  };

  /** Resolve a VM's parent Folder MoRef (clone target folder). */
  const parentFolder = async (srcRef) => {
    const xml = await client.callRaw(
      `<RetrieveProperties xmlns="urn:vim25"><_this type="PropertyCollector">${client.sc.propertyCollector}</_this>` +
      `<specSet><propSet><type>VirtualMachine</type><pathSet>parent</pathSet></propSet>` +
      `<objectSet><obj type="VirtualMachine">${srcRef}</obj></objectSet></specSet></RetrieveProperties>`,
    );
    return /<val[^>]*type="Folder">([^<]+)<\/val>/.exec(xml)?.[1] || null;
  };

  return {
    async cloneOne(source, vm, { powerOn = false, placement = {} } = {}) {
      await ensureLogin();
      const srcRef = morefOf(source.id, source.vcenterId || vcenterId) || source.id;
      // Target folder: the operator's choice would need a name→MoRef lookup; for
      // now we place into the source's parent folder (same as source).
      const folder = await parentFolder(srcRef);
      if (!folder) throw new Error('원본 VM의 폴더를 찾을 수 없습니다 (parent Folder 조회 실패).');

      // RelocateSpec: pin host / datastore when chosen (resolved from snapshot).
      const hostRef = placement.host ? findHostRef(source.vcenterId, placement.host) : null;
      const dsRef = placement.datastore ? findDatastoreRef(source.vcenterId, placement.datastore) : null;
      // vim25 VirtualMachineRelocateSpec 시퀀스: (…) datastore → (…) host → profile.
      // datastore를 host보다 먼저 emit해야 한다 — 순서가 뒤바뀌면 host+datastore를 함께 지정한
      // 클론 요청이 unexpected-element로 매 VM 실패한다.
      const reloc =
        (dsRef ? `<datastore type="Datastore">${dsRef}</datastore>` : '') +
        (hostRef ? `<host type="HostSystem">${hostRef}</host>` : '') +
        (placement.storageProfile ? `<profile><profile xsi:type="VirtualMachineDefinedProfileSpec"><profileName>${esc(placement.storageProfile)}</profileName></profile></profile>` : '');
      const windows = isWindows(source.guestOS);
      const spec =
        `<spec>` +
        `<location>${reloc}</location>` +
        `<template>false</template>` +
        customizationXml(vm, vm.guest || {}, windows) +
        `<powerOn>${powerOn ? 'true' : 'false'}</powerOn>` +
        `</spec>`;
      const body =
        `<CloneVM_Task xmlns="urn:vim25"><_this type="VirtualMachine">${srcRef}</_this>` +
        `<folder type="Folder">${folder}</folder><name>${esc(vm.name)}</name>${spec}</CloneVM_Task>`;
      const res = await client.callRaw(body);
      const task = /<returnval type="Task">([^<]+)<\/returnval>/.exec(res)?.[1];
      return { task: task || null, submitted: true };
    },
    async close() { if (loggedIn) await client.logout(); },
  };
}
