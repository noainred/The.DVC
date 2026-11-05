#!/usr/bin/env node
/**
 * Bareos Director 연결 점검(PoC) 도구 — 포탈 서버에서 직접 실행한다.
 *
 * 포탈의 Bareos 연동은 Node 로 옮긴 콘솔 프로토콜(TLS-PSK · CRAM-MD5 · JSON 모드)을 쓴다. 실제 Director 와의 상호운용
 * (특히 TLS-PSK 협상)과 VMware 플러그인이 잡 단위 옵션을 받아들이는지는 **실제 환경에서만** 확인할 수 있어, 이 도구로
 * 단계별로 확인한다. 각 단계는 앞 단계가 성공해야 진행한다.
 *
 * 사용법(비밀번호는 인자 대신 환경변수로 — 셸 기록·프로세스 목록에 남지 않게):
 *   BAREOS_PASSWORD='…' node server/src/tools/bareos-probe.js --host bareos-dir.corp --name portal
 *   BAREOS_PASSWORD='…' node server/src/tools/bareos-probe.js --host … --name portal --catalog
 *   BAREOS_PASSWORD='…' node server/src/tools/bareos-probe.js --host … --name portal --history <잡 이름>
 *   BAREOS_PASSWORD='…' node server/src/tools/bareos-probe.js --host … --name portal --chain <jobid>
 *   BAREOS_PASSWORD='…' node server/src/tools/bareos-probe.js --host … --name portal --cmd '.jobs'
 *   v2.863 — 복원 · 검증 전에 실환경에서 먼저 볼 것(둘 다 읽기 전용 — 복원 명령을 보내지 않고 VM 을 바꾸지 않는다):
 *   BAREOS_PASSWORD='…' node server/src/tools/bareos-probe.js --host … --name portal --restore-plan <jobid> --vcserver <주소> --config-file <INI> --dc <DC> --folder <폴더> [--vm-name 새이름] [--datastore DS]
 *   VCENTER_PASSWORD='…' node server/src/tools/bareos-probe.js --vcenter vc.corp --vc-user portal@vsphere.local --vm <VM 이름>
 *
 * 옵션:
 *   --port 9101           Director 포트
 *   --tls12               TLS 1.2 까지만(1.3 협상이 실패할 때 비교용)
 *   --insecure-plain      TLS 없이(시험 전용 — 같은 호스트의 Director 를 비교할 때만. 포탈 설정에는 이 경로가 없다)
 *   --timeout 15          초
 *   --cmd '<명령>'        JSON 모드 명령 1개를 그대로 보내 결과를 출력(읽기 명령만 쓰세요 — 이 도구는 막지 않습니다)
 *   --restore-plan <jobid> 포탈이 새 VM 복원에서 보낼 명령을 **같은 함수로 만들어 보여 준다(보내지 않음)** — 체인 · 플러그인 옵션 ·
 *                         복원 잡 리소스(.jobs type=R) · FD 판(status client — FD 에 묻는다). --restore-job(기본 PortalVmwareRestore) · --plugin(기본 python3)
 *   --vcenter <주소>      포탈 vCenter 계정으로 'NIC 끊기 사전 점검' — 같은 이름 VM 수 · 전원 · NIC(연결 상태) · PCI 패스스루 수 ·
 *                         VM 과 상위 폴더에서 이 계정의 권한(HasPrivilegeOnEntities). --vc-user · --vm 필수, 비밀번호는 VCENTER_PASSWORD.
 *                         **복원은 Bareos 의 vCenter 계정(FD INI)으로, NIC 끊기 · 켜기 · 지우기는 포탈의 vCenter 계정으로** 한다 — 여기에는 포탈 계정을 넣는다.
 *                         엣지 위임(site) vCenter 는 그 vCenter 에 닿는 엣지 노드에서 실행한다. 로그인 실패 시 다시 시도하지 않는다(계정 잠금).
 *
 * 주소 검사: 포탈과 같은 SSRF 규칙(루프백·링크로컬 차단)을 쓴다. 같은 호스트의 Director 를 시험하려면 SSRF_ALLOW_LOOPBACK=true.
 */
import process from 'node:process';
import { openConsole, diagnoseConsole } from '../bareos/console.js';
import { probe, catalogLists, jobHistory, restoreChain, jobStatus, jobRuns, namesOf } from '../bareos/director.js';
import { chainFromHistory } from '../bareos/restore.js';
import { restorePreview, fdVersionLine } from '../bareos/probePlan.js';
import { VimSoapClient, findVmsByName, vmStateOf, parentFolderOf, nicSummary, passthroughCount, sessionPrivileges, VERIFY_PRIV_IDS } from '../vmclone/vsphere.js';
import { ssrfBlockReasonResolved } from '../util/ssrfBlock.js';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const wantDir = !!(val('--host') && val('--name'));
const wantVc = !!val('--vcenter');

if (has('--help') || has('-h') || (!wantDir && !wantVc)) {
  console.log(`
Bareos Director 연결 점검

  BAREOS_PASSWORD='콘솔 비밀번호' node server/src/tools/bareos-probe.js --host <주소> --name <콘솔 이름> [--port 9101]
      [--catalog] [--history <잡 이름>] [--chain <jobid>] [--cmd '<명령>'] [--tls12] [--insecure-plain] [--timeout 초]
      [--restore-plan <jobid> --vcserver 주소 --config-file INI --dc DC --folder 폴더 [--vm-name 새이름] [--datastore DS] [--restore-job 이름] [--plugin python3]]

  NIC 끊기 사전 점검(포탈의 vCenter 계정 — 읽기 전용):
  VCENTER_PASSWORD='비밀번호' node server/src/tools/bareos-probe.js --vcenter <주소> --vc-user <계정> --vm <VM 이름>
`);
  process.exit(has('--help') || has('-h') ? 0 : 2);
}
const password = process.env.BAREOS_PASSWORD || '';
if (wantDir && !password) { console.error('\n✖ BAREOS_PASSWORD 환경변수로 콘솔 비밀번호를 주세요(인자로 받지 않습니다).\n'); process.exit(2); }
if (wantVc && (!process.env.VCENTER_PASSWORD || !val('--vc-user') || !val('--vm'))) {
  console.error('\n✖ NIC 끊기 사전 점검에는 --vc-user · --vm 과 VCENTER_PASSWORD 환경변수가 필요합니다(비밀번호는 인자로 받지 않습니다).\n');
  process.exit(2);
}

const step = (n, msg) => console.log(`\n[${n}] ${msg}`);
const opts = {
  host: val('--host'), port: val('--port') || 9101, name: val('--name'), password,
  timeoutMs: (Number(val('--timeout')) || 15) * 1000,
  tls: has('--insecure-plain') ? 'none' : 'psk',
  tlsMaxVersion: has('--tls12') ? 'TLSv1.2' : 'TLSv1.3',
};

async function directorChecks() {
  let s = null;
  try {
    // v2.822: 먼저 단계별 진단(설정 화면 '연결 시험' 과 같은 함수) — 어느 단계에서 막혔는지와 조치를 바로 보인다.
    step(0, `단계별 진단: ${opts.host}:${opts.port} · 콘솔 ‘${opts.name}’ · ${opts.tls === 'psk' ? `TLS-PSK(최대 ${opts.tlsMaxVersion})` : '평문(시험 전용)'}`);
    const d = await diagnoseConsole(opts);
    for (const x of d.stages) {
      const mark = x.skipped ? '·' : x.ok ? '✔' : '✖';
      console.log(`  ${mark} ${x.label}${x.skipped ? '' : ` (${x.ms}ms)`} — ${x.detail || ''}`);
      if (x.hint) console.log(`      조치: ${x.hint}`);
    }
    if (!d.ok) { const e = new Error(`${d.failed?.key || '?'} 단계에서 실패했습니다 — ${d.failed?.detail || ''}`); e.code = d.failed?.code; throw e; }
    step(1, '접속·인증(작업 세션)');
    s = await openConsole(opts);
    const p = await probe(s);
    console.log(`  ✔ 인증 성공 — Director ‘${p.director || '?'}’ 버전 ${p.version || '?'} · 암호화 ${s.info.tls ? `${s.info.tls.protocol} ${s.info.tls.cipher}` : '없음'}`);
    console.log(`  ✔ 안내: ${s.info.infoMessage.split('\n').join(' / ')}`);
    if (p.clients) console.log(`  ✔ .clients ${p.clients.length}개: ${p.clients.slice(0, 20).join(', ')}${p.clients.length > 20 ? ' …' : ''}`);
    else console.log(`  ✖ .clients 실패: ${p.clientsError} (콘솔 Profile 의 Command ACL 을 확인하세요)`);

    if (has('--catalog')) {
      step(2, '카탈로그 목록(사이트 매핑 드롭다운 원천)');
      const c = await catalogLists(s);
      for (const k of ['clients', 'storages', 'pools', 'schedules', 'jobdefs', 'filesets']) {
        console.log(c[k] ? `  ✔ ${k} ${c[k].length}개: ${c[k].slice(0, 15).join(', ')}` : `  ✖ ${k} 실패: ${c.errors[k]}`);
      }
    }
    if (val('--history')) {
      step(3, `잡 실행 이력: ${val('--history')}`);
      for (const r of await jobHistory(s, val('--history'), 10)) {
        console.log(`  jobid ${r.jobid} · ${r.level} · ${r.status}(${r.state}) · ${r.startedAt ? new Date(r.startedAt).toISOString() : '—'} · ${r.bytes ?? '—'} bytes`);
      }
    }
    if (val('--chain')) {
      step(4, `복원 체인 비교: jobid ${val('--chain')}`);
      const id = Number(val('--chain'));
      const row = await jobStatus(s, id);
      if (!row?.name) console.log('  ✖ 그 jobid 를 카탈로그에서 찾지 못했습니다.');
      else {
        const mine = chainFromHistory(await jobRuns(s, row.name), id);
        console.log(mine ? `  ✔ 포탈이 쓰는 체인(잡 ‘${row.name}’ 의 이력): ${mine.join(', ')}` : '  ✖ 이 잡의 이력으로 체인(Full 부터)을 만들지 못했습니다.');
        // 참고 — .bvfs_get_jobids 는 FD + FileSet 으로만 골라 같은 FD·범용 FileSet 의 다른 VM 이 섞일 수 있다(포탈은 쓰지 않는다 — v2.822 S1)
        const bvfs = await restoreChain(s, id).catch((e) => { console.log(`  · .bvfs_get_jobids 실패: ${e?.message || e}`); return null; });
        if (bvfs) console.log(`  · 참고 .bvfs_get_jobids: ${bvfs.join(', ')}${mine && bvfs.join(',') !== mine.join(',') ? '  ← 다르다(다른 VM 의 jobid 가 섞였을 수 있다 — 포탈은 위 체인을 쓴다)' : ''}`);
      }
    }
    if (val('--cmd')) {
      step(5, `명령: ${val('--cmd')}`);
      console.log(JSON.stringify(await s.call(val('--cmd')), null, 2).slice(0, 20_000));
    }
    if (val('--restore-plan')) await restorePlanCheck(s);
  } finally {
    try { s?.close(); } catch { /* */ }
  }
}

/** v2.863 복원 명령 미리 보기 — 포탈과 같은 함수로 만든다 · **보내지 않는다**. 복원 잡 리소스 · FD 판은 읽기 명령으로만 본다. */
async function restorePlanCheck(s) {
  const id = Number(val('--restore-plan'));
  step(6, `복원 명령 미리 보기(보내지 않음): jobid ${val('--restore-plan')}`);
  if (!Number.isInteger(id) || id <= 0) { console.log('  ✖ jobid 는 양의 정수로 주세요.'); return; }
  const row = await jobStatus(s, id);
  const runs = row?.name ? await jobRuns(s, row.name) : [];
  const restoreJob = val('--restore-job') || 'PortalVmwareRestore';
  const pv = restorePreview({ row, runs, jobid: id, restoreJob, pluginName: val('--plugin') || 'python3', newName: val('--vm-name') || '', datastore: val('--datastore') || '',
    base: { vcserver: val('--vcserver') || '', configFile: val('--config-file') || '', dc: val('--dc') || '', folder: val('--folder') || '' } });   // v2.874 B1-04 포탈과 같은 기본 키
  if (!pv.ok) { console.log(`  ✖ ${pv.issue}`); return; }
  console.log(`  ✔ 잡 ‘${pv.name}’ · FD ‘${pv.client}’ · 체인 ${pv.chain.length}개: ${pv.chain.join(', ')}`);
  console.log(`  ✔ 플러그인 옵션: ${pv.pluginOptions}`);
  console.log(`  · 포탈이 보낼 명령(이 도구는 보내지 않았습니다):\n      ${pv.command}`);
  if (val('--datastore')) console.log('  · 데이터스토어가 그 vCenter 인벤토리에 있는지는 포탈이 보내기 전에 확인합니다(이 도구는 Director 에만 닿습니다).');
  const rj = await s.call('.jobs type=R').then((r) => ({ names: namesOf(r) })).catch((e) => ({ error: String(e?.message || e) }));
  if (rj.error) console.log(`  ✖ 복원 잡 목록(.jobs type=R)을 읽지 못했습니다: ${rj.error}`);
  else if (rj.names.includes(restoreJob)) console.log(`  ✔ 복원 잡 ‘${restoreJob}’ 이(가) Director 에 있습니다(복원 잡 ${rj.names.length}개).`);
  else console.log(`  ✖ 복원 잡 ‘${restoreJob}’ 이(가) 없습니다 — 있는 복원 잡: ${rj.names.slice(0, 15).join(', ') || '(없음)'}. 포탈 설정 › 백업 › Bareos 백업 서버 › 공통 기본값의 복원 잡 이름을 확인하세요.`);
  try {
    const raw = typeof s.callRaw === 'function' ? await s.callRaw(`status client=${pv.client}`, { timeoutMs: 60_000, maxBytes: 2 * 1024 * 1024 }) : JSON.stringify(await s.call(`status client=${pv.client}`));
    const v = fdVersionLine(raw);
    console.log(v ? `  ✔ FD 판: ${v}` : '  · FD 판 줄을 찾지 못했습니다(status client 응답에 Version 줄이 없음).');
  } catch (e) { console.log(`  ✖ status client=${pv.client} 실패: ${e?.message || e}`); }
  console.log('  · 참고: 새 VM 복원 옵션(vmname · restore_datastore · restore_powerstate)이 FD 의 VMware 플러그인 판에서 받아들여지는지는 실제 복원 한 번으로만 확정됩니다(추정 금지).');
}

/** v2.863 NIC 끊기 사전 점검 — 포탈의 vCenter 계정으로 로그인해 **읽기만** 한다(VM 을 바꾸지 않는다). */
async function vcenterChecks() {
  const raw = String(val('--vcenter'));
  const host = /:\/\//.test(raw) ? raw : `https://${raw}`;
  const why = await ssrfBlockReasonResolved(host);
  if (why) throw Object.assign(new Error(`vCenter 주소가 허용되지 않습니다 — ${why}`), { code: 'ssrf' });
  const vmName = String(val('--vm'));
  step(7, `NIC 끊기 사전 점검: ${host} · 계정 ‘${val('--vc-user')}’ · VM ‘${vmName}’ (읽기 전용)`);
  const c = new VimSoapClient({ host, username: val('--vc-user'), password: process.env.VCENTER_PASSWORD, timeoutMs: (Number(val('--timeout')) || 15) * 1000 });
  try {
    await c.login();   // 실패하면 그대로 던진다 — 다시 시도하지 않는다(계정 잠금)
    console.log(`  ✔ 로그인 — ${c.sc.fullName || c.sc.version || 'vCenter'} · API ${c.sc.apiVersion || '?'}`);
    const refs = await findVmsByName(c, vmName);
    if (refs.length !== 1) { console.log(`  ✖ 이 이름의 VM 이 ${refs.length}대입니다 — 포탈은 정확히 1대일 때만 손댑니다(템플릿 제외).`); return; }
    const st = await vmStateOf(c, refs[0]);
    console.log(`  ✔ VM ${refs[0]} · 전원 ${st.powerState || '—'}${st.powerState && st.powerState !== 'poweredOff' ? '  ← 포탈은 꺼진 VM 만 끊고 켭니다(검증 복원 VM 은 꺼진 채 만들어진다)' : ''}`);
    const nics = nicSummary(st.deviceXml);
    const tf = (b) => (b === null ? '—' : b ? '예' : '아니요');
    console.log(`  ✔ NIC ${nics.length}개${nics.length ? '' : '(끊을 것이 없습니다)'}`);
    for (const n of nics) console.log(`      · ${n.label || n.type} (${n.type}) — 연결 ${tf(n.connected)} · 켤 때 연결 ${tf(n.startConnected)} · 게스트 제어 허용 ${tf(n.allowGuestControl)}`);
    const pt = passthroughCount(st.deviceXml);
    if (pt) console.log(`  ✖ PCI 패스스루 장치 ${pt}개 — 포탈의 NIC 끊기는 가상 NIC 만 다룹니다. 패스스루 NIC 면 끊기지 않습니다.`);
    if (nics.some((n) => n.allowGuestControl === true)) console.log('  · 게스트 제어 허용이 켜진 NIC 가 있습니다 — 게스트 OS 가 끊긴 NIC 를 다시 연결할 수 있는지는 확인되지 않았습니다(추정 — 실환경에서 볼 것).');
    const folder = await parentFolderOf(c, refs[0]).catch(() => null);
    const entities = [{ type: 'VirtualMachine', ref: refs[0] }, ...(folder ? [{ type: 'Folder', ref: folder }] : [])];
    let privs;
    try { privs = await sessionPrivileges(c, entities, VERIFY_PRIV_IDS); } catch (e) { console.log(`  ✖ 권한을 읽지 못했습니다: ${e?.message || e}`); return; }
    for (const e of entities) {
      const mine = privs.filter((p) => p.entity === `${e.type}:${e.ref}`);
      console.log(`  ${e.type === 'Folder' ? '상위 폴더(새 VM 이 생길 곳)' : '이 VM'} ${e.ref}:`);
      for (const id of VERIFY_PRIV_IDS) {
        const g = mine.find((p) => p.privId === id)?.granted;
        console.log(`      ${g === true ? '✔' : g === false ? '✖' : '·'} ${id}${g === null || g === undefined ? ' — 응답에 없음' : ''}`);
      }
    }
    console.log('  · 참고: NIC 연결 끊기(ReconfigVM)에 위 두 장치 권한 중 무엇이 실제로 요구되는지는 vSphere 판마다 다를 수 있어 함께 봅니다.');
  } finally {
    await c.logout().catch(() => {});
  }
}

try {
  if (wantDir) await directorChecks();
  if (wantVc) await vcenterChecks();
  console.log('\n완료.\n');
} catch (e) {
  console.error(`\n✖ ${e?.code ? `[${e.code}] ` : ''}${e?.message || e}\n`);
  if (e?.code === 'tls') console.error('  TLS 1.2 로 비교: --tls12 · 같은 호스트에서 평문 비교: --insecure-plain(시험 전용)\n');
  process.exitCode = 1;
}
