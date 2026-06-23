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
  // 2) 데이터 읽기 — nvidia-smi 실행 후 파싱.
  try {
    const r = await collectVmGpu(c, vmMoref, creds, { isWindows, timeoutMs });
    if (r && r.utilPct != null) { out.read = true; out.sample = { gpus: r.count, utilPct: r.utilPct, memUsedPct: r.memUsedPct }; }
    else out.error = 'nvidia-smi 출력 없음 — 게스트에 NVIDIA 드라이버/nvidia-smi 확인';
  } catch (e) { out.error = cleanGuestError(e.message); }
  return out;
}

function authXml(creds) {
  return `<auth xsi:type="NamePasswordAuthentication"><interactiveSession>false</interactiveSession>` +
    `<username>${esc(creds.username)}</username><password>${esc(creds.password)}</password></auth>`;
}

/** Run nvidia-smi in one guest and return parsed GPU rows, or null on any failure. */
export async function collectVmGpu(c, vmMoref, creds, { isWindows, timeoutMs = 20_000 } = {}) {
  const { processManager, fileManager } = await guestManagers(c);
  const auth = authXml(creds);
  const vmRef = `<vm type="VirtualMachine">${vmMoref}</vm>`;
  // 임시 출력 파일 + 쉘 경유 리다이렉트(출력 캡처에 필요).
  const outFile = isWindows ? `C\\:\\\\Windows\\\\Temp\\\\nvsmi_${Date.now()}.txt` : `/tmp/nvsmi_${Date.now()}.txt`;
  const prog = isWindows
    ? { path: 'C:\\Windows\\System32\\cmd.exe', args: `/c nvidia-smi ${NVSMI_QUERY} > ${outFile.replace(/\\\\/g, '\\')}` }
    : { path: '/bin/sh', args: `-c "nvidia-smi ${NVSMI_QUERY} > ${outFile} 2>/dev/null"` };

  // 3) StartProgramInGuest
  const startXml =
    `<StartProgramInGuest xmlns="urn:vim25"><_this type="GuestProcessManager">${processManager}</_this>${vmRef}${auth}` +
    `<spec xsi:type="GuestProgramSpec"><programPath>${esc(prog.path)}</programPath><arguments>${esc(prog.args)}</arguments></spec></StartProgramInGuest>`;
  const startRes = await c.callRaw(startXml);
  const pid = /<returnval>(\d+)<\/returnval>/.exec(startRes)?.[1];
  if (!pid) throw new Error('StartProgramInGuest 실패');

  // 4) 종료 대기(ListProcessesInGuest)
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1500);
    const listXml = await c.callRaw(
      `<ListProcessesInGuest xmlns="urn:vim25"><_this type="GuestProcessManager">${processManager}</_this>${vmRef}${auth}<pids>${pid}</pids></ListProcessesInGuest>`
    );
    if (/<endTime>/.test(listXml)) break; // 종료됨
  }

  // 5) 결과 파일 다운로드
  const ftXml = await c.callRaw(
    `<InitiateFileTransferFromGuest xmlns="urn:vim25"><_this type="GuestFileManager">${fileManager}</_this>${vmRef}${auth}` +
    `<guestFilePath>${esc(isWindows ? outFile.replace(/\\\\/g, '\\') : outFile)}</guestFilePath></InitiateFileTransferFromGuest>`
  );
  const url = /<url>([^<]+)<\/url>/.exec(ftXml)?.[1];
  let text = '';
  if (url) {
    // ESXi가 반환하는 URL의 와일드카드 호스트(*)는 vCenter 호스트로 치환.
    const vcHost = (c.vc.host || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const dl = url.replace('://*', `://${vcHost}`);
    const res = await fetch(dl, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) text = await res.text();
  }

  // 6) 정리(best-effort)
  c.callRaw(
    `<DeleteFileInGuest xmlns="urn:vim25"><_this type="GuestFileManager">${fileManager}</_this>${vmRef}${auth}` +
    `<filePath>${esc(isWindows ? outFile.replace(/\\\\/g, '\\') : outFile)}</filePath></DeleteFileInGuest>`
  ).catch(() => {});

  return parseNvidiaSmiCsv(text);
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
