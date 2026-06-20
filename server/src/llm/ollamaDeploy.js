/**
 * Install Ollama on a separate server over SSH, so the air-gapped portal can use
 * a local LLM for natural-language search.
 *
 *  - online  : run the official installer (needs internet on the target).
 *  - offline : SFTP the official ollama-linux-amd64.tgz (placed on the central
 *              server) to the target, extract to /usr, and register the service.
 *
 * Either way the service is configured to listen on 0.0.0.0:11434 so the portal
 * can reach it, and (optionally) a model is pulled and the portal's LLM config
 * is pointed at the new server.
 */

import fs from 'node:fs';
import { withSsh } from '../proxy/sshExec.js';
import { saveLlmConfig } from './config.js';

const SERVICE = `[Unit]
Description=Ollama Service
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/ollama serve
User=ollama
Group=ollama
Restart=always
RestartSec=3
Environment="OLLAMA_HOST=0.0.0.0:11434"

[Install]
WantedBy=multi-user.target
`;

const OVERRIDE = `[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
`;

const creds = (t) => ({ host: t.host, port: t.port || 22, username: t.username, password: t.password, privateKey: t.privateKey || undefined });

export async function installOllama(target, { mode = 'online', binaryPath, model, port = 11434, applyToPortal = true } = {}) {
  if (!target?.host || !target?.username) return { ok: false, reason: 'host/username을 입력하세요.' };
  if (mode === 'offline') {
    if (!binaryPath) return { ok: false, reason: '오프라인 설치는 Ollama tgz 경로가 필요합니다.' };
    if (!fs.existsSync(binaryPath)) return { ok: false, reason: `설치 파일을 찾을 수 없습니다: ${binaryPath}` };
  }

  try {
    return await withSsh(creds(target), async ({ exec, writeFile, putFile }) => {
      const idu = await exec('id -u');
      if (idu.stdout.trim() !== '0') return { ok: false, reason: 'root 권한이 필요합니다. root로 접속하세요.' };

      // dedicated service user (ignore if exists)
      await exec('id ollama >/dev/null 2>&1 || useradd -r -s /bin/false -m -d /usr/share/ollama ollama');

      if (mode === 'offline') {
        const remote = '/tmp/ollama-install.tgz';
        await putFile(binaryPath, remote);
        const x = await exec(`tar -C /usr -xzf ${remote} && rm -f ${remote}`);
        if (x.code !== 0) return { ok: false, reason: `압축 해제 실패: ${x.stderr}` };
        await writeFile('/etc/systemd/system/ollama.service', SERVICE, 0o644);
        const up = await exec('systemctl daemon-reload && systemctl enable --now ollama');
        if (up.code !== 0) return { ok: false, reason: `서비스 시작 실패: ${up.stderr || up.stdout}` };
      } else {
        const inst = await exec('curl -fsSL https://ollama.com/install.sh | sh');
        if (inst.code !== 0) return { ok: false, reason: `설치 스크립트 실패(인터넷 필요?): ${(inst.stderr || inst.stdout).slice(-400)}` };
        // expose on all interfaces so the portal can connect
        await exec('mkdir -p /etc/systemd/system/ollama.service.d');
        await writeFile('/etc/systemd/system/ollama.service.d/override.conf', OVERRIDE, 0o644);
        await exec('systemctl daemon-reload && systemctl restart ollama');
      }

      // wait briefly, verify the API
      await exec('for i in $(seq 1 10); do curl -sf http://127.0.0.1:11434/api/tags >/dev/null && break || sleep 1; done');
      const tags = await exec('curl -sf http://127.0.0.1:11434/api/tags || echo FAIL');
      if (tags.stdout.includes('FAIL')) return { ok: false, reason: 'Ollama API(11434)가 응답하지 않습니다. 서비스 로그를 확인하세요.' };

      let pulled = null;
      if (model) {
        const p = await exec(`OLLAMA_HOST=127.0.0.1:11434 ollama pull ${model.replace(/[^\w.:/-]/g, '')}`);
        pulled = { model, ok: p.code === 0, error: p.code === 0 ? undefined : (p.stderr || p.stdout).slice(-300) };
      }

      if (applyToPortal) saveLlmConfig({ enabled: true, url: `http://${target.host}:${port}`, ...(model ? { model } : {}) });

      const ver = await exec('/usr/bin/ollama --version 2>/dev/null || ollama --version 2>/dev/null');
      return { ok: true, version: ver.stdout.trim(), pulled, url: `http://${target.host}:${port}`, appliedToPortal: applyToPortal };
    });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
