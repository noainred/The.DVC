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

function envBlock({ agentName, centralUrl, centralToken, collectorToken, collectorDatacenter, scanIntervalMs }) {
  const lines = ['', '# --- portal agent (auto-deployed) ---'];
  if (agentName) lines.push(`AGENT_NAME=${agentName}`);
  if (centralUrl) lines.push(`CENTRAL_URL=${centralUrl}`);
  if (centralToken) lines.push(`CENTRAL_TOKEN=${centralToken}`);
  if (scanIntervalMs) lines.push(`AGENT_SCAN_INTERVAL_MS=${scanIntervalMs}`);
  if (collectorToken) lines.push(`COLLECTOR_TOKEN=${collectorToken}`);
  if (collectorDatacenter) lines.push(`COLLECTOR_DATACENTER=${collectorDatacenter}`);
  return lines.join('\n') + '\n';
}

const creds = (t) => ({ host: t.host, port: t.port || 22, username: t.username, password: t.password, privateKey: t.privateKey || undefined });

/** SSH connectivity + prerequisite probe. */
export async function testTarget(target) {
  if (!target?.host || !target?.username) return { ok: false, reason: 'host/username을 입력하세요.' };
  try {
    return await withSsh(creds(target), async ({ exec }) => {
      const os = await exec('cat /etc/os-release 2>/dev/null | grep -E "^PRETTY_NAME" | cut -d= -f2 | tr -d \'"\'');
      const root = await exec('id -u');
      const sysd = await exec('command -v systemctl >/dev/null && echo yes || echo no');
      return { ok: true, os: os.stdout.trim(), isRoot: root.stdout.trim() === '0', systemd: sysd.stdout.includes('yes') };
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

      await exec(`rm -rf ${workDir} ${remotePkg} && mkdir -p ${workDir}`);
      await putFile(installer, remotePkg);                       // SFTP upload (fastPut)
      const untar = await exec(`tar xzf ${remotePkg} -C ${workDir}`);
      if (untar.code !== 0) return { ok: false, reason: `압축 해제 실패: ${untar.stderr}` };

      const inst = await exec(`cd ${workDir}/vmware-portal-offline-* && ./install.sh --port ${port}`);
      if (inst.code !== 0) return { ok: false, reason: `install.sh 실패: ${(inst.stderr || inst.stdout).slice(-500)}` };

      // Inject agent settings into the env file, then restart.
      const block = envBlock(target).replace(/'/g, "'\\''");
      await exec(`printf '%s' '${block}' >> /etc/vmware-portal/portal.env`);
      await exec('systemctl restart vmware-portal');
      const active = await exec('systemctl is-active vmware-portal');
      await exec(`rm -rf ${workDir} ${remotePkg}`);
      return {
        ok: active.stdout.trim() === 'active',
        active: active.stdout.trim(),
        installer: path.basename(installer),
        reason: active.stdout.trim() === 'active' ? undefined : '서비스가 active 상태가 아닙니다. 로그를 확인하세요.',
      };
    });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
