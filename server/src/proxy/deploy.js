/**
 * SSH-based HAProxy auto-deploy. Generates a managed block of `listen` sections
 * (one per remote-access mapping), splices it into the proxy's haproxy.cfg
 * between marker comments (preserving the rest), validates with `haproxy -c`,
 * backs up the original, and reloads. Alternative to the Data Plane API.
 */

import { withSsh as realWithSsh } from './sshExec.js';
import { fileStamp } from '../util/dayKey.js';
import { haproxyAddress } from '../util/hostPort.js';
import { mappingConfigIssue, mappingNameText, haproxyCfgPathIssue, deployCmdRefusal, resolveDeployCmd, deployCommandsView, DEPLOY_CMD_KINDS } from './registry.js';

// 시험 이음새(보안 잔여 11-27 M1): 정상 배포의 명령 순서를 SFTP 없는 가짜 세션으로 확인한다. 운영 경로는 언제나 실제 withSsh.
const deps = { withSsh: realWithSsh };
export function _setDeployDepsForTest(o = null) { deps.withSsh = o?.withSsh || realWithSsh; }
const withSsh = (...a) => deps.withSsh(...a);

/** 원격 출력(검증 · reload 실패)을 응답 · 매핑 오류에 실을 때의 상한 — 보안 잔여 11-27 M1(반증 S-1): 큰 출력이 응답 · 설정 파일로 그대로 가지 않게 줄 · 길이로 자른다. */
export const REMOTE_OUT_MAX_LINES = 6;
export const REMOTE_OUT_MAX_CHARS = 600;
export function remoteOutText(v) {
  const s = String(v ?? '').slice(0, REMOTE_OUT_MAX_CHARS * 2);
  const lines = s.split('\n').slice(0, REMOTE_OUT_MAX_LINES).join('\n').slice(0, REMOTE_OUT_MAX_CHARS);
  return lines.length < s.length ? `${lines} …(잘림)` : lines;
}

/**
 * 보안 잔여 11-27 M1: 검증 · 재적재 명령이 허용 형식 밖이면 **접속 전에** 거절한다(비밀이 이동하지 않고 원격에 임시 파일도 남지 않는다).
 *   로그에는 칸 이름 · 출처만(값은 싣지 않는다). code 는 호출부(provision · 철거)가 '설정 문제' 를 일반 실패와 가르는 데 쓴다.
 */
function refuseBadCmds(deploy) {
  const bad = deployCmdRefusal(deploy);
  if (!bad) return null;
  const which = DEPLOY_CMD_KINDS.filter((k) => resolveDeployCmd(deploy, k).issue).join(',');
  console.warn(`[remote] HAProxy 자동 배포 거절(접속 전) — 저장된 ${which} 가 허용 형식 밖입니다(설정 › 중계 서버에서 확인).`);
  return { ok: false, reason: bad, code: 'deploy-cmd-invalid' };
}

const BEGIN = '# >>> portal-remote-access (auto-generated — do not edit) >>>';
const END = '# <<< portal-remote-access (auto-generated) <<<';

/** Build the managed HAProxy config block for the given mappings. */
export function buildConfigBlock(mappings, { bindAddress = '*' } = {}) {
  const lines = [BEGIN];
  for (const m of mappings) {
    // v2.770(점검 R5-E5-4): 형식이 깨진 예전 매핑(포트 70000·-1·1.5, '10.0.0.5:2222')은 블록에 넣지 않는다 — 한 줄 때문에 haproxy -c 가
    //   블록 전체를 거부해 그 프록시의 이후 배포가 전부 실패했다. 건너뛴 사실은 주석으로 남기고 호출부가 그 매핑을 error 로 표시한다.
    if (mappingConfigIssue(m)) { lines.push(`# skipped ra_${String(m?.id ?? '').replace(/[^\w-]/g, '').slice(0, 40)} — invalid mapping (port/host)`, ''); continue; }
    lines.push(
      `listen ra_${m.id}   # ${mappingNameText(m.name)} (${mappingNameText(m.protocol, 16)})`,   // 76회차 F2: 예전 저장본의 제어 문자도 줄 밖으로 내지 않는다
      `    bind ${bindAddress}:${m.publicPort}`,
      '    mode tcp',
      '    option tcplog',
      `    server target ${haproxyAddress(m.targetHost, m.targetPort)}`,   // v2.603: IPv6 는 ipv6@ 접두(포트 = 마지막 콜론 뒤)
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
  return original.trimEnd() + '\n\n' + block;   // v2.599(SEC2599-02): replace(/\s*$/) 는 O(n²) — 같은 뜻
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
  { const bad = haproxyCfgPathIssue(deploy.haproxyConfigPath); if (bad) return { ok: false, reason: bad }; }   // 157회차: 아래 셸 명령에 보간되는 값 — 접속 전에 거절
  { const r = refuseBadCmds(deploy); if (r) return r; }   // 보안 잔여 11-27 M1
  const validateCmd = resolveDeployCmd(deploy, 'validateCmd').cmd;   // 정규형(화면/API 값) 또는 운영자 env 원문 · 내장 기본
  const reloadCmd = resolveDeployCmd(deploy, 'reloadCmd').cmd;
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

      const validate = validateCmd.replace('{file}', tmpPath);
      const v = await exec(validate);
      if (v.code !== 0) {
        await exec(`rm -f ${tmpPath}`);
        return { ok: false, reason: `HAProxy 설정 검증 실패: ${remoteOutText(v.stderr || v.stdout) || `exit ${v.code}`}` };
      }
      // backup original, swap in the validated file, reload
      // v2.590 D9: 사람이 롤백할 때 읽는 파일명이라 **포탈 시각**(기본 KST)으로 쓴다 — 예전 toISOString 은 'Z' 까지 잘려
      // KST 08:30 배포가 '전날 23:30' 백업으로 남았다. 초까지 붙여 같은 분의 재배포가 앞 백업을 덮지 않게 한다.
      const now = Date.now();
      const stamp = `${fileStamp(now)}${String(new Date(now).getUTCSeconds()).padStart(2, '0')}`;
      await exec(`cp -a ${cfgPath} ${cfgPath}.bak.${stamp}`);
      await exec(`mv ${tmpPath} ${cfgPath}`);
      const r = await exec(reloadCmd);
      if (r.code !== 0) return { ok: false, reason: `reload 실패: ${remoteOutText(r.stderr || r.stdout) || `exit ${r.code}`}` };
      return { ok: true, deployed: mappings.length, backup: `${cfgPath}.bak.${stamp}` };
    });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** Connectivity test: SSH in and check haproxy + config path. */
export async function testDeploy(deploy) {
  if (!deploy?.host || !deploy?.username) return { ok: false, reason: 'host/username을 입력하세요.' };
  // 157회차(재현): 시험 라우트는 요청의 경로를 저장된 SSH 비밀과 함께 쓴다 — 경로 칸의 셸 문장이 중계 서버에서 그대로 돌았다. 접속 전에 거절한다(registry.haproxyCfgPathIssue).
  { const bad = haproxyCfgPathIssue(deploy.haproxyConfigPath); if (bad) return { ok: false, reason: bad }; }
  // 보안 잔여 11-27 M1: 시험 · 상태 확인도 같은 판정 — 예전에는 두 명령을 보지 않아 '정상' 으로 보인 뒤 배포에서만 터졌다(요청 본문의 명령도 이 판정을 탄다)
  { const r = refuseBadCmds(deploy); if (r) return r; }
  const creds = { host: deploy.host, port: deploy.port, username: deploy.username, password: deploy.password, privateKey: deploy.privateKey || undefined };
  try {
    return await withSsh(creds, async ({ exec }) => {
      const ver = await exec('haproxy -v 2>&1 | head -1');
      const cfg = await exec(`test -r ${deploy.haproxyConfigPath || '/etc/haproxy/haproxy.cfg'} && echo OK || echo MISSING`);
      return { ok: true, haproxy: ver.stdout.trim(), configReadable: cfg.stdout.includes('OK'), commands: deployCommandsView(deploy) };
    });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
