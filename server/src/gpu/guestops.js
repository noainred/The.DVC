/**
 * VMware Tools 게스트 작업으로 게스트 OS 안에서 nvidia-smi를 실행해 GPU 사용률을
 * 수집한다(패스쓰루 GPU는 ESXi에서 안 보이므로 게스트에서만 알 수 있음).
 *
 * 순서(vim25 GuestOperationsManager):
 *   1) processManager/fileManager 조회
 *   2) NamePasswordAuthentication(게스트 계정)
 *   3) StartProgramInGuest 로 nvidia-smi를 임시파일로 리다이렉트 실행
 *   4) ListProcessesInGuest 로 종료 대기
 *   5) InitiateFileTransferFromGuest 로 결과 파일 URL 획득 → HTTP GET → 파싱
 *   6) DeleteFileInGuest 로 정리
 *
 * ⚠️ 베타: 실 vCenter+게스트 환경에서 최종 검증 전입니다. 모든 실패는 격리되어
 * null을 반환하며 폴링 루프를 막지 않습니다. 게스트에 NVIDIA 드라이버/ nvidia-smi가
 * 없으면 해당 VM은 자연스럽게 건너뜁니다.
 */

import { VimSoapClient } from '../vcenter/soapClient.js';

const NVSMI_QUERY = '--query-gpu=utilization.gpu,utilization.memory,memory.used,memory.total --format=csv,noheader,nounits';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// XML 이스케이프(5개 사전정의 엔티티). 비밀번호는 <password> 요소 내용으로만 들어가고
// 셸 명령에는 절대 넣지 않으므로, &<>"' 만 이스케이프하면 특수문자 비밀번호도 안전하다.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

async function guestManagers(c) {
  const objs = await c.retrieveObjectProps('GuestOperationsManager', c.sc.guestOperationsManager, ['processManager', 'fileManager', 'authManager']);
  const p = objs[0]?.props || {};
  if (!p.processManager || !p.fileManager) throw new Error('GuestOperationsManager 사용 불가');
  return { processManager: p.processManager, fileManager: p.fileManager, authManager: p.authManager };
}

// vCenter 게스트 작업 fault 메시지를 사람이 읽기 쉬운 한국어로 요약.
function cleanGuestError(msg) {
  const m = String(msg || '');
  if (/InvalidGuestLogin|authentication|Failed to authenticate/i.test(m)) return '게스트 로그인 실패 — 계정/비밀번호 확인';
  if (/GuestComponentsOutOfDate|GuestOperationsUnavailable|not (?:installed|running)|tools/i.test(m)) return 'VMware Tools 미실행/구버전 — 게스트 작업 불가';
  if (/timeout|timed out|AbortError/i.test(m)) return '게스트 작업 타임아웃';
  if (/powered ?off|not powered on|InvalidPowerState/i.test(m)) return 'VM 전원 꺼짐';
  return m.slice(0, 160);
}

/**
 * 자격증명 검증(로그인 테스트) + nvidia-smi 데이터 읽기 테스트를 한 번에.
 * 반환 { login, read, error, sample }.
 *   - login: ValidateCredentialsInGuest 성공 여부(게스트에 명령 실행 X, 인증만 확인)
 *   - read : nvidia-smi로 GPU 사용률을 실제로 읽었는지
 */
export async function testVmGuest(c, vmMoref, creds, { isWindows = false, timeoutMs = 15_000 } = {}) {
  const out = { login: false, read: false, error: null, sample: null };
  const vmRef = `<vm type="VirtualMachine">${vmMoref}</vm>`;
  const auth = authXml(creds);
  let authManager;
  try {
    ({ authManager } = await guestManagers(c));
  } catch (e) { out.error = cleanGuestError(e.message); return out; }
  // 1) 로그인(자격증명) 검증 — 게스트에 아무것도 실행하지 않고 인증만 확인.
  try {
    if (authManager) {
      await c.callRaw(`<ValidateCredentialsInGuest xmlns="urn:vim25"><_this type="GuestAuthManager">${authManager}</_this>${vmRef}${auth}</ValidateCredentialsInGuest>`);
    }
    out.login = true;
  } catch (e) { out.error = cleanGuestError(e.message); return out; }
  // 2) 데이터 읽기 — nvidia-smi 실행 후 파싱. 실패 시 구체 사유(stderr/다운로드)를 그대로 표시.
  try {
    const r = await collectVmGpu(c, vmMoref, creds, { isWindows, timeoutMs });
    if (r && r.utilPct != null) { out.read = true; out.sample = { gpus: r.count, utilPct: r.utilPct, memUsedPct: r.memUsedPct }; }
    else out.error = 'nvidia-smi 출력 없음 — 게스트에 NVIDIA 드라이버/nvidia-smi 확인';
  } catch (e) { out.error = e.guestDiag ? e.message : cleanGuestError(e.message); }
  return out;
}

function authXml(creds) {
  return `<auth xsi:type="NamePasswordAuthentication"><interactiveSession>false</interactiveSession>` +
    `<username>${esc(creds.username)}</username><password>${esc(creds.password)}</password></auth>`;
}

// 게스트 파일 1개를 InitiateFileTransferFromGuest → HTTP GET 으로 회수.
// 반환 { text, error } — error 가 있으면 다운로드 단계(포탈→ESXi 도달/인증서/HTTP) 실패.
async function readGuestFile(c, fileManager, vmRef, auth, guestPath, timeoutMs) {
  let ftXml;
  try {
    ftXml = await c.callRaw(
      `<InitiateFileTransferFromGuest xmlns="urn:vim25"><_this type="GuestFileManager">${fileManager}</_this>${vmRef}${auth}` +
      `<guestFilePath>${esc(guestPath)}</guestFilePath></InitiateFileTransferFromGuest>`);
  } catch (e) { return { text: '', error: cleanGuestError(e.message) }; }
  const url = /<url>([^<]+)<\/url>/.exec(ftXml)?.[1];
  if (!url) return { text: '', error: '파일 전송 URL을 반환하지 않음' };
  // 파일 전송 URL의 호스트 처리:
  //  - '*' 와일드카드 = '연결한 서버(vCenter)'를 의미 → vCenter 호스트로 치환.
  //  - 실제 호스트(ESXi/vCenter FQDN)가 박힌 경우 그대로 시도(같은 망이면 도달).
  // 토큰은 그 URL을 발급한 호스트에서만 유효하므로, 호스트를 함부로 vCenter로 강제하면
  // 404가 난다(1.83.1 회귀). 그래서 (1) 원본 호스트로 먼저, (2) 실패 시 vCenter로 폴백.
  const vcHost = (c.vc.host || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const primary = url.replace('://*', `://${vcHost}`);
  const candidates = [primary];
  try { const u = new URL(primary); if (u.host !== vcHost) { u.host = vcHost; candidates.push(u.toString()); } } catch { /* keep primary */ }
  let lastErr = '';
  for (const cand of candidates) {
    const host = (() => { try { return new URL(cand).host; } catch { return '?'; } })();
    try {
      const res = await fetch(cand, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return { text: await res.text(), error: null };
      lastErr = `HTTP ${res.status} (${host})`;
    } catch (e) { lastErr = `${e.message} (${host})`; }
  }
  return { text: '', error: `파일 다운로드 실패: ${lastErr}` };
}

function deleteGuestFile(c, fileManager, vmRef, auth, guestPath) {
  c.callRaw(`<DeleteFileInGuest xmlns="urn:vim25"><_this type="GuestFileManager">${fileManager}</_this>${vmRef}${auth}` +
    `<filePath>${esc(guestPath)}</filePath></DeleteFileInGuest>`).catch(() => {});
}

/**
 * Run nvidia-smi in one guest and return parsed GPU rows.
 * stdout은 outFile, stderr는 errFile로 분리 캡처해, 결과가 비면 stderr/다운로드
 * 사유를 담아 Error를 던진다(테스트에서 정확한 원인 표시). 폴러는 .catch(()=>null).
 */
export async function collectVmGpu(c, vmMoref, creds, { isWindows, timeoutMs = 20_000 } = {}) {
  const { processManager, fileManager } = await guestManagers(c);
  const auth = authXml(creds);
  const vmRef = `<vm type="VirtualMachine">${vmMoref}</vm>`;
  // stdout/stderr 분리 캡처(쉘 리다이렉트). stderr를 버리지 않아야 원인 진단 가능.
  const ts = Date.now();
  const outFile = isWindows ? `C:\\Windows\\Temp\\nvsmi_${ts}.out` : `/tmp/nvsmi_${ts}.out`;
  const errFile = isWindows ? `C:\\Windows\\Temp\\nvsmi_${ts}.err` : `/tmp/nvsmi_${ts}.err`;
  // 비대화형 게스트 작업 셸은 PATH가 비어있을 수 있어 /usr/bin 등을 보강(절대경로 지정 X, 이름 그대로 실행).
  const prog = isWindows
    ? { path: 'C:\\Windows\\System32\\cmd.exe', args: `/c nvidia-smi ${NVSMI_QUERY} 1>"${outFile}" 2>"${errFile}"` }
    : { path: '/bin/sh', args: `-c "export PATH=$PATH:/usr/bin:/usr/local/bin:/usr/local/sbin:/usr/local/nvidia/bin; nvidia-smi ${NVSMI_QUERY} 1>${outFile} 2>${errFile}"` };

  // 3) StartProgramInGuest
  const startXml =
    `<StartProgramInGuest xmlns="urn:vim25"><_this type="GuestProcessManager">${processManager}</_this>${vmRef}${auth}` +
    `<spec xsi:type="GuestProgramSpec"><programPath>${esc(prog.path)}</programPath><arguments>${esc(prog.args)}</arguments></spec></StartProgramInGuest>`;
  const startRes = await c.callRaw(startXml);
  const pid = /<returnval>(\d+)<\/returnval>/.exec(startRes)?.[1];
  if (!pid) throw new Error('StartProgramInGuest 실패(게스트 작업 권한/Tools 확인)');

  // 4) 종료 대기(ListProcessesInGuest)
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1200);
    const listXml = await c.callRaw(
      `<ListProcessesInGuest xmlns="urn:vim25"><_this type="GuestProcessManager">${processManager}</_this>${vmRef}${auth}<pids>${pid}</pids></ListProcessesInGuest>`
    );
    if (/<endTime>/.test(listXml)) break; // 종료됨
  }

  // 5) stdout 회수 → 파싱
  const outRes = await readGuestFile(c, fileManager, vmRef, auth, outFile, timeoutMs);
  const parsed = parseNvidiaSmiCsv(outRes.text);
  if (parsed) {
    deleteGuestFile(c, fileManager, vmRef, auth, outFile);
    deleteGuestFile(c, fileManager, vmRef, auth, errFile);
    return parsed;
  }

  // 6) 비었으면 stderr 회수해 진단 후 정리 + 구체 사유로 throw
  const errRes = await readGuestFile(c, fileManager, vmRef, auth, errFile, timeoutMs);
  deleteGuestFile(c, fileManager, vmRef, auth, outFile);
  deleteGuestFile(c, fileManager, vmRef, auth, errFile);
  const stderrLine = (errRes.text || '').trim().split(/\r?\n/)[0];
  const reason = stderrLine ? `게스트 오류: ${stderrLine.slice(0, 180)}`
    : (outRes.error || errRes.error || 'nvidia-smi 출력이 비어 있음(명령은 실행됐으나 stdout 없음)');
  const e = new Error(reason); e.guestDiag = true; throw e;
}

/** "12, 8, 2048, 81920" 형식(여러 줄=여러 GPU)을 파싱해 집계. */
export function parseNvidiaSmiCsv(text) {
  if (!text || !text.trim()) return null;
  const gpus = [];
  for (const line of text.trim().split(/\r?\n/)) {
    const cols = line.split(',').map((x) => Number(String(x).trim()));
    if (cols.length < 1 || !Number.isFinite(cols[0])) continue;
    gpus.push({ utilPct: cols[0], memUtilPct: Number.isFinite(cols[1]) ? cols[1] : null, memUsedMB: cols[2] ?? null, memTotalMB: cols[3] ?? null });
  }
  if (!gpus.length) return null;
  const avg = (arr) => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  const memUsed = gpus.reduce((a, g) => a + (g.memUsedMB || 0), 0);
  const memTotal = gpus.reduce((a, g) => a + (g.memTotalMB || 0), 0);
  return { count: gpus.length, utilPct: avg(gpus.map((g) => g.utilPct)), memUsedPct: memTotal ? Math.round((memUsed / memTotal) * 100) : null, gpus };
}

export { VimSoapClient };
