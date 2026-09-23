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
import path from 'node:path';
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

/**
 * 오프라인 설치 파일 검증(v2.583 — 감사 확정. v2.447 S1 `agent/deploy.js resolveInstaller` 의 형제 누락).
 * 예전에는 **존재 여부만** 봐서 `binaryPath=/etc/vmware-portal/portal.env` 같은 임의 파일이 tar 검증 **전에**
 * 요청자가 고른 SSH 호스트로 SFTP 업로드됐다(AUTH_SECRET·SECRETS_KEY 유출 → 세션 토큰 위조).
 * 화면 예시(`/root/ollama-linux-amd64.tgz`)처럼 **어느 디렉터리에 두든** 쓸 수 있어야 하므로 디렉터리 제한 대신:
 *  ① **실경로**(심볼릭 링크를 푼 뒤)의 파일명이 Ollama 릴리스 자산 형식이어야 하고
 *  ② 파일 앞머리가 gzip(1f 8b) 또는 zstd(28 b5 2f fd) 서명이어야 한다(설정·비밀 파일은 평문이다).
 * @returns {{ok:true, real:string} | {ok:false, reason:string}}
 */
export const OLLAMA_ASSET_RE = /^ollama-linux-[a-z0-9_]+\.(?:tgz|tar\.gz|tar\.zst)$/i;
export function checkOllamaArchive(p) {
  if (!p) return { ok: false, reason: '오프라인 설치는 Ollama tgz 경로가 필요합니다.' };
  let real;
  try { real = fs.realpathSync(String(p)); } catch { return { ok: false, reason: `설치 파일을 찾을 수 없습니다: ${p}` }; }
  if (!OLLAMA_ASSET_RE.test(path.basename(real))) {
    return { ok: false, reason: `Ollama 릴리스 파일(ollama-linux-<아키텍처>.tgz · .tar.gz · .tar.zst)만 보낼 수 있습니다: ${path.basename(real)}` };
  }
  try {
    const fd = fs.openSync(real, 'r');
    const buf = Buffer.alloc(4);
    try { fs.readSync(fd, buf, 0, 4, 0); } finally { fs.closeSync(fd); }
    const gz = buf[0] === 0x1f && buf[1] === 0x8b;
    const zst = buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd;
    if (!gz && !zst) return { ok: false, reason: '압축 파일(gzip·zstd)이 아닙니다 — Ollama 릴리스 파일을 지정하세요.' };
  } catch (e) { return { ok: false, reason: `설치 파일을 읽지 못했습니다: ${e.message}` }; }
  return { ok: true, real };
}

export async function installOllama(target, { mode = 'online', binaryPath, model, port = 11434, applyToPortal = true } = {}) {
  if (!target?.host || !target?.username) return { ok: false, reason: 'host/username을 입력하세요.' };
  if (mode === 'offline') {
    const chk = checkOllamaArchive(binaryPath);
    if (!chk.ok) return chk;
    binaryPath = chk.real;   // 검사한 실경로를 보낸다(검사 뒤 링크를 바꿔치는 경쟁 차단)
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
