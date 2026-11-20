/**
 * Install Ollama on a separate server over SSH, so the air-gapped portal can use
 * a local LLM for natural-language search.
 *
 *  - online  : run the official installer (needs internet on the target).
 *  - offline : SFTP the official ollama-linux-amd64.tgz (placed on the central
 *              server) to the target, extract to /usr, and register the service.
 *
 * Either way the service is configured to listen on 0.0.0.0:<ollamaPort> (default 11434) so the portal
 * can reach it, and (optionally) a model is pulled and the portal's LLM config
 * is pointed at the new server.
 */

import fs from 'node:fs';
import path from 'node:path';
import { withSsh } from '../proxy/sshExec.js';
import { remoteTmpDir } from '../agent/deploy.js';
import { saveLlmConfig } from './config.js';

// v2.767(점검 R2-B4-2): 듣는 포트를 인자로 받는다 — 저장할 LLM 주소의 포트와 서비스가 실제로 듣는 포트가 한 값에서 나오게.
const serviceUnit = (port) => `[Unit]
Description=Ollama Service
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/ollama serve
User=ollama
Group=ollama
Restart=always
RestartSec=3
Environment="OLLAMA_HOST=0.0.0.0:${port}"

[Install]
WantedBy=multi-user.target
`;

const overrideConf = (port) => `[Service]
Environment="OLLAMA_HOST=0.0.0.0:${port}"
`;

const creds = (t) => ({ host: t.host, port: t.port || 22, username: t.username, password: t.password, privateKey: t.privateKey || undefined });

/**
 * v2.767(점검 R2-B4-2): Ollama 가 들을 포트. **SSH 포트(target.port)와 다른 키(ollamaPort)** 다 — 예전에는 라우트가
 * 본문 `port`(화면의 SSH 포트 칸, 기본 22)를 Ollama 포트로 빼 가서 SSH 는 늘 22 로 붙고 포탈 LLM 주소가
 * `http://<host>:22` 로 저장됐다. 비우면 11434, 정수 1~65535 가 아니면 null(거부).
 */
export const OLLAMA_DEFAULT_PORT = 11434;
export function normOllamaPort(v) {
  if (v == null || v === '') return OLLAMA_DEFAULT_PORT;
  const s = String(v).trim();
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : null;
}

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

/**
 * 67회차 F4(재현): 오프라인 설치 압축 해제 명령. 검증(checkOllamaArchive)은 gzip 과 zstd(.tar.zst) 를 받는데 예전 명령은 `tar -xzf` 라
 * gzip 을 강제해 zstd 파일은 **언제나** 'gzip: stdin: not in gzip format' 으로 실패했다. GNU tar 는 읽을 때 앞머리 서명으로 압축 형식을
 * 고르므로 `-xf` 로 둔다(gzip 은 그대로 · zstd 는 대상에 zstd 가 있어야 한다 — 없으면 tar 의 오류 문구가 사유로 나간다).
 * 경로는 이 모듈이 만든 값(remoteTmpDir 결과)만 받는다 — 셸 메타 문자가 있으면 던진다.
 */
export function ollamaExtractCmd(archive, dest = '/usr') {
  const safe = (v) => { const s = String(v ?? ''); if (!/^\/[A-Za-z0-9._/-]{1,255}$/.test(s)) throw new Error(`압축 해제 경로 형식이 아닙니다: ${s.slice(0, 80)}`); return s; };
  return `tar -C ${safe(dest)} -xf ${safe(archive)}`;
}
/**
 * 67회차 개선: 받을 모델 이름 — 문자열만 · 허용 글자만 · 앞의 '-' 는 뗀다(`ollama pull --insecure` 같은 선택 인자로 읽히지 않게).
 * 받은 이름과 포탈 LLM 설정에 저장하는 이름이 같은 값이어야 한다(예전에는 거른 값으로 받고 원문을 저장해 '모델 없음' 이 됐다).
 */
export function ollamaModelName(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[^\w.:/-]/g, '').replace(/^-+/, '').slice(0, 200);
}

/**
 * 116회차 F5(재현 — 실패하는 가짜 curl): 온라인 설치 명령. 예전 `curl -fsSL … | sh` 는 파이프라인의 종료값이 **마지막 명령(sh)** 것이라
 * curl 이 실패해도(대상 서버에 인터넷이 없을 때 — 머리말의 폐쇄망 배포) sh 가 빈 입력으로 0 을 냈다 — 아래 '설치 스크립트 실패(인터넷 필요?)' 판정이
 * 받기 실패에는 걸리지 않았고, 설치되지 않은 서버에 override.conf 를 쓰고 API 확인(최대 10초)을 기다린 뒤 'Ollama API 가 응답하지 않습니다. 서비스 로그를
 * 확인하세요' 라는 다른 사유를 냈다. 스크립트를 먼저 받아(받기 실패 = 그 종료값 · stderr) 받은 것만 sh 로 넘긴다(POSIX — pipefail 에 기대지 않는다).
 */
export const OLLAMA_ONLINE_INSTALL_CMD = 's=$(curl -fsSL https://ollama.com/install.sh) && printf \'%s\\n\' "$s" | sh';

export async function installOllama(target, { mode = 'online', binaryPath, model, ollamaPort, applyToPortal = true } = {}) {
  if (!target?.host || !target?.username) return { ok: false, reason: 'host/username을 입력하세요.' };
  const port = normOllamaPort(ollamaPort);
  if (port == null) return { ok: false, reason: 'Ollama 포트는 1~65535 사이 정수여야 합니다.' };
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
        // v2.600 SEC2600-01: 고정 /tmp/ollama-install.tgz 는 대상 호스트 로컬 사용자가 선점·교체할 수 있었다 — root 가
        // 그 파일을 /usr 에 풀면 곧 root 권한 상승이다. root 소유 0700 mktemp 디렉터리에 올리고 끝나면 지운다.
        const tmp = await remoteTmpDir(exec, 'ollama-install');
        const remote = `${tmp}/ollama.tgz`;
        let x;
        try {
          await putFile(binaryPath, remote);
          x = await exec(ollamaExtractCmd(remote));
        } finally { await exec(`rm -rf ${tmp}`).catch(() => {}); }
        if (x.code !== 0) return { ok: false, reason: `압축 해제 실패: ${x.stderr}` };
        await writeFile('/etc/systemd/system/ollama.service', serviceUnit(port), 0o644);
        const up = await exec('systemctl daemon-reload && systemctl enable --now ollama');
        if (up.code !== 0) return { ok: false, reason: `서비스 시작 실패: ${up.stderr || up.stdout}` };
      } else {
        const inst = await exec(OLLAMA_ONLINE_INSTALL_CMD);
        if (inst.code !== 0) return { ok: false, reason: `설치 스크립트 실패(인터넷 필요?): ${(inst.stderr || inst.stdout).slice(-400)}` };
        // expose on all interfaces so the portal can connect
        await exec('mkdir -p /etc/systemd/system/ollama.service.d');
        await writeFile('/etc/systemd/system/ollama.service.d/override.conf', overrideConf(port), 0o644);
        await exec('systemctl daemon-reload && systemctl restart ollama');
      }

      // wait briefly, verify the API
      await exec(`for i in $(seq 1 10); do curl -sf http://127.0.0.1:${port}/api/tags >/dev/null && break || sleep 1; done`);
      const tags = await exec(`curl -sf http://127.0.0.1:${port}/api/tags || echo FAIL`);
      if (tags.stdout.includes('FAIL')) return { ok: false, reason: `Ollama API(${port})가 응답하지 않습니다. 서비스 로그를 확인하세요.` };

      let pulled = null;
      const modelName = ollamaModelName(model);
      if (modelName) {
        const p = await exec(`OLLAMA_HOST=127.0.0.1:${port} ollama pull ${modelName}`);
        pulled = { model: modelName, ok: p.code === 0, error: p.code === 0 ? undefined : (p.stderr || p.stdout).slice(-300) };
      }

      if (applyToPortal) saveLlmConfig({ enabled: true, url: `http://${target.host}:${port}`, ...(modelName ? { model: modelName } : {}) });

      const ver = await exec('/usr/bin/ollama --version 2>/dev/null || ollama --version 2>/dev/null');
      return { ok: true, version: ver.stdout.trim(), pulled, url: `http://${target.host}:${port}`, appliedToPortal: applyToPortal };
    });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
