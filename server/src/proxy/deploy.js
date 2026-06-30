/**
 * SSH-based HAProxy auto-deploy. Generates a managed block of `listen` sections
 * (one per remote-access mapping), splices it into the proxy's haproxy.cfg
 * between marker comments (preserving the rest), validates with `haproxy -c`,
 * backs up the original, and reloads. Alternative to the Data Plane API.
 */

import { withSsh } from './sshExec.js';

const BEGIN = '# >>> portal-remote-access (auto-generated — do not edit) >>>';
const END = '# <<< portal-remote-access (auto-generated) <<<';

/** Build the managed HAProxy config block for the given mappings. */
export function buildConfigBlock(mappings, { bindAddress = '*' } = {}) {
  const lines = [BEGIN];
  for (const m of mappings) {
    lines.push(
      `listen ra_${m.id}   # ${m.name} (${m.protocol})`,
      `    bind ${bindAddress}:${m.publicPort}`,
      '    mode tcp',
      '    option tcplog',
      `    server target ${m.targetHost}:${m.targetPort}`,
      '');
  }
  lines.push(END);
  return lines.join('\n') + '\n';
}

/** Splice the managed block into an existing config (replace or append). */
export function spliceConfig(original, block) {
  const begin = original.indexOf(BEGIN);
  const end = original.indexOf(END);
  if (begin !== -1 && end !== -1 && end > begin) {
    return original.slice(0, begin) + block.trimEnd() + '\n' + original.slice(end + END.length).replace(/^\n/, '');
  }
  return original.replace(/\s*$/, '\n\n') + block;
}

/** Render what would be deployed without touching the proxy. */
export function previewConfig(mappings, cfg) {
  return buildConfigBlock(mappings, { bindAddress: cfg?.dataplane?.bindAddress || '*' });
}

/**
 * Deploy the managed block to the proxy over SSH. Steps: read cfg → splice →
 * write a temp file → validate → backup + replace → reload.
 */
export async function deployToProxy(deploy, mappings, opts = {}) {
  if (!deploy?.host || !deploy?.username) return { ok: false, reason: '배포 SSH 접속 정보(host/username)가 필요합니다.' };
  const cfgPath = deploy.haproxyConfigPath || '/etc/haproxy/haproxy.cfg';
  const tmpPath = `${cfgPath}.portal.tmp`;
  const block = buildConfigBlock(mappings, { bindAddress: opts.bindAddress || '*' });
  const creds = { host: deploy.host, port: deploy.port, username: deploy.username, password: deploy.password, privateKey: deploy.privateKey || undefined };

  try {
    return await withSsh(creds, async ({ exec, readFile, writeFile }) => {
      const original = await readFile(cfgPath).catch(() => '');
      if (!original) throw new Error(`원격 ${cfgPath} 를 읽을 수 없습니다. (경로/권한 확인)`);
      const next = spliceConfig(original, block);
      await writeFile(tmpPath, next, 0o640);

      const validate = (deploy.validateCmd || 'haproxy -c -f {file}').replace('{file}', tmpPath);
      const v = await exec(validate);
      if (v.code !== 0) {
        await exec(`rm -f ${tmpPath}`);
        return { ok: false, reason: `HAProxy 설정 검증 실패: ${v.stderr || v.stdout || `exit ${v.code}`}` };
      }
      // backup original, swap in the validated file, reload
      const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
      await exec(`cp -a ${cfgPath} ${cfgPath}.bak.${stamp}`);
      await exec(`mv ${tmpPath} ${cfgPath}`);
      const r = await exec(deploy.reloadCmd || 'systemctl reload haproxy');
      if (r.code !== 0) return { ok: false, reason: `reload 실패: ${r.stderr || r.stdout || `exit ${r.code}`}` };
      return { ok: true, deployed: mappings.length, backup: `${cfgPath}.bak.${stamp}` };
    });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** Connectivity test: SSH in and check haproxy + config path. */
export async function testDeploy(deploy) {
  if (!deploy?.host || !deploy?.username) return { ok: false, reason: 'host/username을 입력하세요.' };
  const creds = { host: deploy.host, port: deploy.port, username: deploy.username, password: deploy.password, privateKey: deploy.privateKey || undefined };
  try {
    return await withSsh(creds, async ({ exec }) => {
      const ver = await exec('haproxy -v 2>&1 | head -1');
      const cfg = await exec(`test -r ${deploy.haproxyConfigPath || '/etc/haproxy/haproxy.cfg'} && echo OK || echo MISSING`);
      return { ok: true, haproxy: ver.stdout.trim(), configReadable: cfg.stdout.includes('OK') };
    });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
