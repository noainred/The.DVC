/**
 * iDRAC-scan collector agent auto-deploy. The central portal pushes its offline
 * install package to a fresh Rocky 9 host over SSH, runs install.sh, injects the
 * agent settings into portal.env, and (re)starts the service — so a new
 * datacenter agent can be stood up from the portal without manual steps.
 *
 * The SSH user must be root (or passwordless sudo); install.sh requires root.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { withSsh } from '../proxy/sshExec.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Find the newest offline installer tarball in download/ or the packages dir (or a given path). */
export function resolveInstaller(explicit) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const dirs = [path.join(ROOT, 'download'), config.packages?.dir].filter(Boolean);
  let best = null;
  for (const dir of dirs) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!/^vmware-portal-offline-.*-el9-x64\.tar\.gz$/.test(f)) continue;
        const m = fs.statSync(path.join(dir, f)).mtimeMs;
        if (!best || m > best.m) best = { p: path.join(dir, f), m };
      }
    } catch { /* dir may not exist */ }
  }
  return best ? best.p : null;
}

export function installerInfo(explicit) {
  const p = resolveInstaller(explicit);
  if (!p) return { available: false };
  const st = fs.statSync(p);
  return { available: true, path: p, name: path.basename(p), sizeBytes: st.size };
}

// 주입할 env 키/값 쌍(빈 값은 제외). 재배포 시 이 키들을 portal.env에서 교체(upsert)한다.
function envPairs({ agentName, centralUrl, centralToken, collectorToken, collectorDatacenter, scanIntervalMs, autoUpgrade, upgradeIntervalMs, pushInventory, inventoryIntervalMs, gpuGuest }, port) {
  const p = [];
  if (port) p.push(['PORT', String(port)]); // 기존 portal.env의 PORT(예: 잘못된 22)도 교체
  // GPU 게스트 수집(또는 사이트 위임)을 하려면 실데이터 수집 모드여야 한다(mock 금지).
  if ((gpuGuest && gpuGuest.enabled) || pushInventory) p.push(['DATA_SOURCE', 'live']);
  if (agentName) p.push(['AGENT_NAME', agentName]);
  if (centralUrl) p.push(['CENTRAL_URL', centralUrl]);
  if (centralToken) p.push(['CENTRAL_TOKEN', centralToken]);
  if (scanIntervalMs) p.push(['AGENT_SCAN_INTERVAL_MS', String(scanIntervalMs)]);
  if (collectorToken) p.push(['COLLECTOR_TOKEN', collectorToken]);
  if (collectorDatacenter) p.push(['COLLECTOR_DATACENTER', collectorDatacenter]);
  // 사이트 위임 수집: 이 현장 서버가 로컬 vCenter 인벤토리를 중앙으로 push.
  if (pushInventory && centralUrl) {
    p.push(['AGENT_PUSH_INVENTORY', 'true']);
    if (inventoryIntervalMs) p.push(['AGENT_INVENTORY_INTERVAL_MS', String(inventoryIntervalMs)]);
  }
  // 자동 업그레이드(소스 = 현재 포탈의 /dl). 토큰 없이 공개 소스에서 pull.
  if (autoUpgrade && centralUrl) {
    const base = `${String(centralUrl).replace(/\/+$/, '')}/dl`;
    p.push(['UPGRADE_ENABLED', 'true'], ['UPGRADE_AUTO_APPLY', 'true'], ['UPGRADE_REMOTE_BASE', base],
      ['UPGRADE_INSTALL_DIR', '/opt/vmware-portal/app'], ['UPGRADE_PACKAGE_NAME', 'vmware-portal'],
      ['UPGRADE_POLL_INTERVAL_MS', String(upgradeIntervalMs || 3_600_000)]);
  }
  return p;
}

const creds = (t) => ({ host: t.host, port: t.port || 22, username: t.username, password: t.password, privateKey: t.privateKey || undefined });

/**
 * 배포 대상(agent)에 GPU 게스트 수집 설정을 직접 주입한다 — agent 포탈에 따로 로그인해
 * 구성할 필요 없이, vcenters.json(수집할 vCenter)과 gpu-guest.json(게스트 계정/사용)을
 * /etc/vmware-portal 에 써넣는다. 기존 파일이 있으면 같은 vCenter id를 병합한다.
 *   g: { vcenterId, vcenterName, vcenterHost, vcenterUser, vcenterPass, guestUser, guestPass, pollIntervalMs }
 */
async function writeGpuGuestConfig({ exec, readFile, writeFile }, g) {
  if (!g.vcenterId || !g.vcenterHost) return { ok: false, reason: 'vCenter id/host가 필요합니다.' };
  const dir = '/etc/vmware-portal';
  const readJson = async (f) => { try { const t = await readFile(`${dir}/${f}`); return t ? JSON.parse(t) : {}; } catch { return {}; } };

  // 1) vcenters.json — agent가 수집할 vCenter(중앙과 동일한 id로). 같은 id면 갱신.
  const vcs = await readJson('vcenters.json');
  if (!Array.isArray(vcs.vcenters)) vcs.vcenters = [];
  const host = /^https?:\/\//i.test(g.vcenterHost) ? g.vcenterHost : `https://${String(g.vcenterHost).trim()}`; // 스킴 보강
  const entry = { id: g.vcenterId, name: g.vcenterName || g.vcenterId, host, username: g.vcenterUser || '', password: g.vcenterPass || '', enabled: true };
  const i = vcs.vcenters.findIndex((v) => v && v.id === g.vcenterId);
  if (i >= 0) vcs.vcenters[i] = { ...vcs.vcenters[i], ...entry }; else vcs.vcenters.push(entry);
  await writeFile(`${dir}/vcenters.json`, JSON.stringify(vcs, null, 2), 0o600);

  // 2) gpu-guest.json — 게스트 수집 on + 그 법인 공용 계정.
  const gg = await readJson('gpu-guest.json');
  gg.enabled = true;
  gg.pollIntervalMs = gg.pollIntervalMs || Number(g.pollIntervalMs) || 60_000;
  gg.concurrency = gg.concurrency || 4;
  gg.timeoutMs = gg.timeoutMs || 20_000;
  gg.maxVmsPerVcenter = gg.maxVmsPerVcenter || 1000;
  gg.vcenters = gg.vcenters || {};
  const prevVms = (gg.vcenters[g.vcenterId] && gg.vcenters[g.vcenterId].vms) || {};
  gg.vcenters[g.vcenterId] = { enabled: true, username: g.guestUser || '', password: g.guestPass || '', vms: prevVms };
  await writeFile(`${dir}/gpu-guest.json`, JSON.stringify(gg, null, 2), 0o600);

  // 서비스 계정 소유/권한(설치 시 dir은 vmportal 소유) — 새 파일도 vmportal:vmportal 0600.
  await exec(`chown vmportal:vmportal ${dir}/vcenters.json ${dir}/gpu-guest.json 2>/dev/null; chmod 600 ${dir}/vcenters.json ${dir}/gpu-guest.json 2>/dev/null || true`);
  return { ok: true, vcenterId: g.vcenterId, vcenterHost: g.vcenterHost, guestUser: g.guestUser || '' };
}

// 번들 Node 22는 glibc >= 2.28(EL8/EL9, Rocky/Alma/RHEL 9 등) 필요. 대상 glibc 점검.
const MIN_GLIBC = [2, 28];
async function probeGlibc(exec) {
  // getconf 우선, 실패 시 ldd --version 파싱.
  let out = (await exec('getconf GNU_LIBC_VERSION 2>/dev/null').catch(() => ({ stdout: '' }))).stdout.trim();
  let m = /(\d+)\.(\d+)/.exec(out);
  if (!m) { out = (await exec('ldd --version 2>&1 | head -1').catch(() => ({ stdout: '' }))).stdout.trim(); m = /(\d+)\.(\d+)\s*$/.exec(out) || /(\d+)\.(\d+)/.exec(out); }
  if (!m) return { version: '', ok: null };
  const ver = [Number(m[1]), Number(m[2])];
  const ok = ver[0] > MIN_GLIBC[0] || (ver[0] === MIN_GLIBC[0] && ver[1] >= MIN_GLIBC[1]);
  return { version: `${ver[0]}.${ver[1]}`, ok };
}
const glibcHint = (g) => `대상 호스트의 glibc ${g.version}이(가) 너무 낮습니다. 번들된 Node 22는 glibc ${MIN_GLIBC.join('.')} 이상(Rocky/Alma/RHEL 8·9)이 필요합니다. EL7(CentOS/RHEL 7, glibc 2.17)에서는 동작하지 않습니다 — 에이전트 호스트를 EL8/EL9로 올리거나 EL8/9 호스트를 사용하세요.`;

/** SSH connectivity + prerequisite probe. */
export async function testTarget(target) {
  if (!target?.host || !target?.username) return { ok: false, reason: 'host/username을 입력하세요.' };
  try {
    return await withSsh(creds(target), async ({ exec }) => {
      const os = await exec('cat /etc/os-release 2>/dev/null | grep -E "^PRETTY_NAME" | cut -d= -f2 | tr -d \'"\'');
      const root = await exec('id -u');
      const sysd = await exec('command -v systemctl >/dev/null && echo yes || echo no');
      const glibc = await probeGlibc(exec);
      return {
        ok: true, os: os.stdout.trim(), isRoot: root.stdout.trim() === '0', systemd: sysd.stdout.includes('yes'),
        glibc: glibc.version, glibcOk: glibc.ok,
        warn: glibc.ok === false ? glibcHint(glibc) : undefined,
      };
    });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** Deploy/refresh the agent on the target host. */
export async function deployAgent(target, { installerPath, port: portIn = 4000 } = {}) {
  if (!target?.host || !target?.username) return { ok: false, reason: 'host/username을 입력하세요.' };
  // 포탈 포트는 숫자로만 — SSH 명령(install.sh --port, ss grep)에 문자열이 그대로 들어가는 것을 차단(명령 주입 방어심층).
  const port = Number.isInteger(Number(portIn)) && Number(portIn) > 0 && Number(portIn) <= 65535 ? Number(portIn) : 4000;
  const installer = resolveInstaller(installerPath);
  if (!installer) return { ok: false, reason: '설치 패키지(offline tarball)를 찾을 수 없습니다. download/ 에 두거나 경로를 지정하세요.' };

  const remotePkg = '/tmp/vmportal-agent-pkg.tar.gz';
  const workDir = '/tmp/vmportal-agent-deploy';
  try {
    return await withSsh(creds(target), async ({ exec, putFile, readFile, writeFile }) => {
      const idu = await exec('id -u');
      if (idu.stdout.trim() !== '0') return { ok: false, reason: 'install.sh 는 root 권한이 필요합니다. root 계정으로 접속하세요.' };

      // 사전 점검: glibc가 낮으면 설치를 시도하지 않고 명확히 안내(혼란스러운 GLIBC 덤프 방지).
      const glibc = await probeGlibc(exec);
      if (glibc.ok === false) return { ok: false, reason: glibcHint(glibc), glibc: glibc.version };

      await exec(`rm -rf ${workDir} ${remotePkg} && mkdir -p ${workDir}`);
      await putFile(installer, remotePkg);                       // SFTP upload (fastPut)
      const untar = await exec(`tar xzf ${remotePkg} -C ${workDir}`);
      if (untar.code !== 0) return { ok: false, reason: `압축 해제 실패: ${untar.stderr}` };

      const inst = await exec(`cd ${workDir}/vmware-portal-offline-* && ./install.sh --port ${port}`);
      if (inst.code !== 0) return { ok: false, reason: `install.sh 실패: ${(inst.stderr || inst.stdout).slice(-500)}` };

      // Inject agent settings into portal.env — upsert(키 교체)로 재배포 시 중복/이전 값 정리.
      const pairs = envPairs(target, port);
      const delScript = pairs.map(([k]) => `/^${k}=/d`).join(';');
      if (delScript) await exec(`sed -i '${delScript}' /etc/vmware-portal/portal.env 2>/dev/null || true`);
      const block = ('\n# --- portal agent (auto-deployed) ---\n' + pairs.map(([k, v]) => `${k}=${v}`).join('\n') + '\n').replace(/'/g, "'\\''");
      await exec(`printf '%s' '${block}' >> /etc/vmware-portal/portal.env`);

      // GPU 게스트 수집 자동 구성: agent의 vcenters.json + gpu-guest.json 주입(원격 포탈 로그인 불필요).
      let gpuGuestApplied = null;
      if (target.gpuGuest && target.gpuGuest.enabled) {
        try { gpuGuestApplied = await writeGpuGuestConfig({ exec, readFile, writeFile }, target.gpuGuest); }
        catch (e) { gpuGuestApplied = { ok: false, reason: e.message }; }
      }

      await exec('systemctl restart vmware-portal 2>&1 || true');
      // 첫 기동(Node22 + node:sqlite)이 수 초 걸릴 수 있어 active 될 때까지 폴링(최대 ~30초).
      const activeState = await waitActive(exec, 15, 2);
      const isActive = activeState === 'active';
      let log = '';
      if (!isActive) {
        // 실패 시 서비스 로그를 자동 수집해 포탈에 그대로 보여준다(SSH 재접속 불필요).
        const st = await exec('systemctl status vmware-portal --no-pager -l 2>&1 | head -20').catch(() => ({ stdout: '' }));
        const jc = await exec('journalctl -u vmware-portal --no-pager -n 60 2>&1').catch(() => ({ stdout: '' }));
        const port4000 = await exec(`ss -ltnp 2>/dev/null | grep ":${port} " || true`).catch(() => ({ stdout: '' }));
        log = [st.stdout, '--- journalctl ---', jc.stdout, port4000.stdout ? `--- 포트 ${port} 사용 중 ---\n${port4000.stdout}` : ''].filter(Boolean).join('\n').slice(-4000);
      }
      await exec(`rm -rf ${workDir} ${remotePkg}`);
      return {
        ok: isActive,
        active: activeState,
        installer: path.basename(installer),
        glibc: glibc.version,
        gpuGuest: gpuGuestApplied,
        log,
        reason: isActive ? undefined : '서비스가 active 상태가 아닙니다. 아래 로그를 확인하세요.',
      };
    });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// systemd 서비스가 active 될 때까지 폴링. active면 즉시 반환, 아니면 마지막 상태 반환.
async function waitActive(exec, tries = 15, delaySec = 2, unit = 'vmware-portal') {
  let state = '';
  for (let i = 0; i < tries; i++) {
    state = (await exec(`systemctl is-active ${unit}`).catch(() => ({ stdout: '' }))).stdout.trim();
    if (state === 'active') return 'active';
    if (state === 'failed' && i >= 2) return 'failed'; // 명백 실패면 빨리 종료
    await exec(`sleep ${delaySec}`);
  }
  return state || 'unknown';
}

/**
 * 수집 서버 URL의 포트를 실제로 서비스 중인 systemd 유닛/환경파일을 역추적한다.
 * 같은 호스트에 포탈 인스턴스가 여러 개(예: 기본 4000 + 별도 4001)면 기본 유닛만 고치는 것은
 * 무의미하므로, 리슨 중인 프로세스(pid→unit→EnvironmentFiles) 기준으로 대상을 결정하고,
 * 특정할 수 없으면 추측으로 진행하지 않고 명확한 진단과 함께 실패시킨다(exec 주입 방지 검증 포함).
 */
export async function resolvePortalUnit(exec, urlPort) {
  const def = { unit: 'vmware-portal', envFile: '/etc/vmware-portal/portal.env', note: '' };
  const port = Number(urlPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return def; // 포트 불명 → 기본 인스턴스
  const lsn = (await exec(`ss -ltnp 2>/dev/null | grep -E '[:.]${port}\\s' || true`).catch(() => ({ stdout: '' }))).stdout;
  const pid = /pid=(\d+)/.exec(lsn)?.[1];
  if (!pid) {
    // 리슨 없음: 기본 인스턴스의 PORT와 같으면 '그 서비스가 중지된 상태'로 보고 기본에 적용,
    // 다르면 NAT/다른 장비/별도 인스턴스 중지 가능성 — 엉뚱한 파일을 고치지 않는다.
    const envPort = (await exec(`grep -E '^PORT=' ${def.envFile} 2>/dev/null | tail -1 || true`).catch(() => ({ stdout: '' }))).stdout.trim().replace(/^PORT=/, '');
    if (envPort && Number(envPort) !== port) {
      return { error: `이 호스트에서 :${port} 를 리슨하는 프로세스가 없고, 기본 인스턴스(portal.env)는 PORT=${envPort} 입니다. 수집 서버 URL(:${port})이 포트포워딩(NAT)으로 다른 장비를 가리키거나 별도 인스턴스가 중지된 상태일 수 있습니다 — SSH 대상 호스트/URL을 확인하세요.` };
    }
    return { ...def, note: `:${port} 리슨 프로세스 없음(서비스 중지 추정) — 기본 인스턴스에 적용` };
  }
  const unitRaw = (await exec(`ps -o unit= -p ${pid} 2>/dev/null || true`).catch(() => ({ stdout: '' }))).stdout.trim();
  const unit = /^[A-Za-z0-9@:._-]+\.service$/.test(unitRaw) ? unitRaw.replace(/\.service$/, '') : '';
  if (!unit) return { error: `:${port} 는 systemd 서비스가 아닌 프로세스(pid ${pid})가 서비스 중입니다(docker/수동 실행 등). 자동 토큰 동기화를 적용할 수 없습니다 — 해당 프로세스의 COLLECTOR_TOKEN을 직접 수정하세요.` };
  if (unit === def.unit) return def;
  const ef = (await exec(`systemctl show ${unit} -p EnvironmentFiles 2>/dev/null || true`).catch(() => ({ stdout: '' }))).stdout;
  const m = /EnvironmentFiles=(\S+)/.exec(ef);
  const envFile = m && /^[A-Za-z0-9/._-]+$/.test(m[1]) ? m[1] : '';
  if (!envFile) return { error: `:${port} 를 서비스 중인 유닛(${unit})의 EnvironmentFile을 확인할 수 없습니다.` };
  return { unit, envFile, note: `별도 인스턴스 감지: ${unit} (${envFile})` };
}

/**
 * 토큰 강제 동기화 — 수집 서버 '연결 테스트'가 403(토큰 불일치)일 때, SSH로 엣지의
 * portal.env 에서 COLLECTOR_TOKEN을 중앙 화면의 토큰으로 교체하고 서비스를 재시작한다
 * (재배포 없이 토큰만). urlPort가 있으면 그 포트를 서비스 중인 인스턴스를 역추적해 적용한다.
 * 값은 셸 주입 차단을 위해 문자 집합을 제한한다.
 */
export async function forceCollectorToken(target, token, { urlPort } = {}) {
  if (!target?.host || !target?.username) return { ok: false, reason: 'host/username이 필요합니다.' };
  const tk = String(token || '').trim();
  if (!tk) return { ok: false, reason: '토큰이 비어 있습니다.' };
  if (!/^[A-Za-z0-9._~+/=-]{4,512}$/.test(tk)) return { ok: false, reason: '토큰에 사용할 수 없는 문자가 있습니다(영숫자·._~+/=- 만 허용).' };
  try {
    return await withSsh(creds(target), async ({ exec }) => {
      const idu = await exec('id -u');
      if (idu.stdout.trim() !== '0') return { ok: false, reason: 'portal.env 수정에는 root 권한이 필요합니다.' };
      const inst = await resolvePortalUnit(exec, urlPort);
      if (inst.error) return { ok: false, reason: inst.error };
      const { unit, envFile } = inst;
      const envOk = (await exec(`test -f ${envFile} && echo yes || echo no`)).stdout.includes('yes');
      if (!envOk) return { ok: false, reason: `${envFile} 가 없습니다. 이 호스트에 먼저 에이전트를 배포하세요.` };
      await exec(`sed -i '/^COLLECTOR_TOKEN=/d' ${envFile}`);
      // 마지막 줄에 개행이 없어도 앞 줄에 붙지 않도록 선행 개행 포함(빈 줄은 무해).
      await exec(`printf '\\nCOLLECTOR_TOKEN=%s\\n' '${tk}' >> ${envFile}`);
      await exec(`systemctl restart ${unit} 2>&1 || true`);
      const state = await waitActive(exec, 15, 2, unit);
      const isActive = state === 'active';
      let log = '';
      if (!isActive) {
        const jc = (await exec(`journalctl -u ${unit} --no-pager -n 40 2>&1`).catch(() => ({ stdout: '' }))).stdout;
        log = jc.slice(-3000);
      }
      return { ok: isActive, active: state, unit, envFile, note: inst.note || '', log, reason: isActive ? undefined : `토큰은 교체됐지만 서비스(${unit}) 상태가 ${state}입니다. 로그를 확인하세요.` };
    });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** 배포 후 에이전트(대상 호스트)의 vmware-portal 서비스 상태를 SSH로 재확인. */
export async function checkAgentStatus(target) {
  if (!target?.host || !target?.username) return { ok: false, reason: 'host/username이 필요합니다.' };
  try {
    return await withSsh(creds(target), async ({ exec }) => {
      const active = (await exec('systemctl is-active vmware-portal 2>&1').catch(() => ({ stdout: '' }))).stdout.trim();
      const isActive = active === 'active';
      const sub = (await exec('systemctl show vmware-portal -p SubState,ActiveEnterTimestamp,MainPID 2>/dev/null').catch(() => ({ stdout: '' }))).stdout.trim().replace(/\n/g, ' · ');
      const ver = (await exec('cat /etc/vmware-portal/VERSION 2>/dev/null || cat /opt/vmware-portal/app/VERSION 2>/dev/null || true').catch(() => ({ stdout: '' }))).stdout.trim();

      // GPU 게스트(패스쓰루) 수집 상태 — 에이전트의 gpu-guest.json 존재/활성 + 최근 [gpu-guest] 로그(수집/push 시각).
      const ggMtime = (await exec("stat -c '%Y' /etc/vmware-portal/gpu-guest.json 2>/dev/null || echo 0").catch(() => ({ stdout: '0' }))).stdout.trim();
      const ggEnabled = (await exec("grep -Eo '\"enabled\"[[:space:]]*:[[:space:]]*true' /etc/vmware-portal/gpu-guest.json 2>/dev/null | head -1 || true").catch(() => ({ stdout: '' }))).stdout.trim();
      const ggLog = (await exec("journalctl -u vmware-portal --no-pager -n 800 2>/dev/null | grep -F '[gpu-guest]' | tail -3 || true").catch(() => ({ stdout: '' }))).stdout.trim();
      const ggConfigured = ggMtime && ggMtime !== '0';
      const gpuGuest = {
        configured: !!ggConfigured,
        enabled: !!ggEnabled,
        configMtime: ggConfigured ? Number(ggMtime) * 1000 : null,
        recentLog: ggLog || '',
      };

      let log = '';
      if (!isActive) {
        const jc = (await exec('journalctl -u vmware-portal --no-pager -n 60 2>&1').catch(() => ({ stdout: '' }))).stdout;
        const st = (await exec('systemctl status vmware-portal --no-pager -l 2>&1 | head -20').catch(() => ({ stdout: '' }))).stdout;
        log = [st, '--- journalctl ---', jc].filter(Boolean).join('\n').slice(-4000);
      }
      return { ok: isActive, active, version: ver || undefined, detail: sub, gpuGuest, log, reason: isActive ? undefined : `서비스 상태: ${active}` };
    });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
