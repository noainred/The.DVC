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
function envPairs({ agentName, centralUrl, centralToken, collectorToken, collectorDatacenter, scanIntervalMs, autoUpgrade, upgradeIntervalMs }, port) {
  const p = [];
  if (port) p.push(['PORT', String(port)]); // 기존 portal.env의 PORT(예: 잘못된 22)도 교체
  if (agentName) p.push(['AGENT_NAME', agentName]);
  if (centralUrl) p.push(['CENTRAL_URL', centralUrl]);
  if (centralToken) p.push(['CENTRAL_TOKEN', centralToken]);
  if (scanIntervalMs) p.push(['AGENT_SCAN_INTERVAL_MS', String(scanIntervalMs)]);
  if (collectorToken) p.push(['COLLECTOR_TOKEN', collectorToken]);
  if (collectorDatacenter) p.push(['COLLECTOR_DATACENTER', collectorDatacenter]);
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
export async function deployAgent(target, { installerPath, port = 4000 } = {}) {
  if (!target?.host || !target?.username) return { ok: false, reason: 'host/username을 입력하세요.' };
  const installer = resolveInstaller(installerPath);
  if (!installer) return { ok: false, reason: '설치 패키지(offline tarball)를 찾을 수 없습니다. download/ 에 두거나 경로를 지정하세요.' };

  const remotePkg = '/tmp/vmportal-agent-pkg.tar.gz';
  const workDir = '/tmp/vmportal-agent-deploy';
  try {
    return await withSsh(creds(target), async ({ exec, putFile }) => {
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
        log,
        reason: isActive ? undefined : '서비스가 active 상태가 아닙니다. 아래 로그를 확인하세요.',
      };
    });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// systemd 서비스가 active 될 때까지 폴링. active면 즉시 반환, 아니면 마지막 상태 반환.
async function waitActive(exec, tries = 15, delaySec = 2) {
  let state = '';
  for (let i = 0; i < tries; i++) {
    state = (await exec('systemctl is-active vmware-portal').catch(() => ({ stdout: '' }))).stdout.trim();
    if (state === 'active') return 'active';
    if (state === 'failed' && i >= 2) return 'failed'; // 명백 실패면 빨리 종료
    await exec(`sleep ${delaySec}`);
  }
  return state || 'unknown';
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
      let log = '';
      if (!isActive) {
        const jc = (await exec('journalctl -u vmware-portal --no-pager -n 60 2>&1').catch(() => ({ stdout: '' }))).stdout;
        const st = (await exec('systemctl status vmware-portal --no-pager -l 2>&1 | head -20').catch(() => ({ stdout: '' }))).stdout;
        log = [st, '--- journalctl ---', jc].filter(Boolean).join('\n').slice(-4000);
      }
      return { ok: isActive, active, version: ver || undefined, detail: sub, log, reason: isActive ? undefined : `서비스 상태: ${active}` };
    });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
