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

// mig.mode.current(Enabled/Disabled/N/A)를 마지막 컬럼으로 추가 수집 → MIG(분할 GPU) 가시화.
// 문자열 컬럼이므로 파서에서 원본 문자열로 별도 처리(숫자 변환 금지).
const NVSMI_QUERY = '--query-gpu=utilization.gpu,utilization.memory,memory.used,memory.total,mig.mode.current --format=csv,noheader,nounits';

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
export async function testVmGuest(c, vmMoref, creds, { isWindows = false, timeoutMs = 15_000, dlHosts = [] } = {}) {
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
    const r = await collectVmGpu(c, vmMoref, creds, { isWindows, timeoutMs, dlHosts });
    if (r && r.utilPct != null) { out.read = true; out.sample = { gpus: r.count, utilPct: r.utilPct, memUsedPct: r.memUsedPct, migEnabled: r.migEnabled || 0 }; }
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
// path/query(토큰)는 건드리지 않고 호스트(+포트)만 교체 — new URL()의 재인코딩으로 토큰이
// 깨지지 않게 정규식으로 스킴 다음 호스트만 바꾼다('*' 호스트도 포함).
const swapHost = (u, host) => u.replace(/^(https?:\/\/)[^/]+/, `$1${host}`);

async function readGuestFile(c, fileManager, vmRef, auth, guestPath, timeoutMs, preferHosts = [], tag = '') {
  let ftXml;
  try {
    ftXml = await c.callRaw(
      `<InitiateFileTransferFromGuest xmlns="urn:vim25"><_this type="GuestFileManager">${fileManager}</_this>${vmRef}${auth}` +
      `<guestFilePath>${esc(guestPath)}</guestFilePath></InitiateFileTransferFromGuest>`);
  } catch (e) {
    console.warn(`[gpu-guest]     [${tag}] InitiateFileTransferFromGuest 실패: ${e.message}`);
    return { text: '', error: `파일전송요청 실패: ${cleanGuestError(e.message)}` };
  }
  // ⭐ 근본 원인 수정: SOAP 응답의 <url>은 XML이라 '&'가 '&amp;'로 인코딩되어 온다.
  // 디코딩하지 않으면 URL이 'id=N&amp;token=T'가 되어 token 파라미터가 깨지고 → ESXi가
  // 티켓을 못 받아 HTTP404. 엔티티를 디코딩해야 'id=N&token=T'로 올바르게 전달된다.
  const xmlDecode = (s) => String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&'); // &amp; 는 항상 마지막에(이중 인코딩 방지)
  const url = xmlDecode(/<url>([^<]+)<\/url>/.exec(ftXml)?.[1] || '');
  if (!url) return { text: '', error: '파일 전송 URL을 반환하지 않음' };
  // InitiateFileTransferFromGuest 응답의 <size> = 게스트 파일 크기. 0이면 nvidia-smi가
  // stdout을 안 낸 것(드라이버/PATH 문제) → ESXi가 빈 파일 전송에 404를 줄 수 있다.
  const size = /<size>(\d+)<\/size>/.exec(ftXml)?.[1];
  // 토큰을 가린 URL(로그용). guestFile 티켓이 노출되지 않게 token/id/value를 마스킹.
  const redact = (u) => String(u).replace(/(([?&])(?:token|id|value)=)[^&]+/gi, '$1***');
  const vcHost = (c.vc.host || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const origHost = (() => { try { return new URL(url).host; } catch { return '?'; } })();
  // ⭐ 핵심: vSphere가 돌려준 "원본 URL을 그대로" 먼저 시도한다. 호스트만 바꿔치기하면
  // 그 ESXi가 티켓을 모르는 경로로 404가 날 수 있다. 원본 → ESXi 후보(IP/FQDN) → vCenter 폴백.
  const swapped = [...new Set([...preferHosts.filter(Boolean), vcHost])].map((h) => swapHost(url, h));
  const candidates = [...new Set([url, ...swapped])];
  console.log(`[gpu-guest]     [${tag}] 파일전송 URL(원본 host=${origHost}, size=${size ?? '?'}B)=${redact(url)} → 후보 ${candidates.length}개`);
  const tries = [];
  for (const cand of candidates) {
    const candHost = (() => { try { return new URL(cand).host; } catch { return '?'; } })();
    const isOrig = cand === url;
    try {
      const res = await fetch(cand, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        console.log(`[gpu-guest]     [${tag}] 다운로드 ${candHost}${isOrig ? '(원본)' : ''} → HTTP ${res.status} ✓`);
        return { text: await res.text(), error: null };
      }
      // 404 등 본문에 ESXi가 사유를 담아주므로(예: 파일없음/티켓무효) 일부를 캡처.
      let body = '';
      try { body = (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100); } catch { /* */ }
      console.warn(`[gpu-guest]     [${tag}] 다운로드 ${candHost}${isOrig ? '(원본)' : ''} → HTTP ${res.status}${body ? ` body="${body}"` : ''}`);
      tries.push(`${candHost}${isOrig ? '(원본)' : ''}=HTTP${res.status}${body ? `(${body})` : ''}`);
    } catch (e) {
      console.warn(`[gpu-guest]     [${tag}] 다운로드 ${candHost}${isOrig ? '(원본)' : ''} → ${e.message}`);
      tries.push(`${candHost}${isOrig ? '(원본)' : ''}=${String(e.message || 'err').slice(0, 60)}`);
    }
  }
  return { text: '', error: `파일 다운로드 실패(size=${size ?? '?'}B): ${tries.join(' | ')}` };
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
export async function collectVmGpu(c, vmMoref, creds, { isWindows, timeoutMs = 20_000, dlHosts = [] } = {}) {
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

  // 3) StartProgramInGuest — 게스트에서 nvidia-smi 실행
  const startXml =
    `<StartProgramInGuest xmlns="urn:vim25"><_this type="GuestProcessManager">${processManager}</_this>${vmRef}${auth}` +
    `<spec xsi:type="GuestProgramSpec"><programPath>${esc(prog.path)}</programPath><arguments>${esc(prog.args)}</arguments></spec></StartProgramInGuest>`;
  let startRes;
  try { startRes = await c.callRaw(startXml); }
  catch (e) { throw new Error(`StartProgramInGuest SOAP 실패: ${cleanGuestError(e.message)} | raw: ${String(e.message).slice(0, 200)}`); }
  const pid = /<returnval>(\d+)<\/returnval>/.exec(startRes)?.[1];
  if (!pid) {
    const fault = /<faultstring>([^<]*)<\/faultstring>/.exec(startRes)?.[1] || startRes.slice(0, 200);
    throw new Error(`StartProgramInGuest 실패(pid 없음): ${fault}`);
  }
  console.log(`[gpu-guest]     [${vmMoref}] StartProgram pid=${pid} → ${outFile}`);

  // 4) 종료 대기(ListProcessesInGuest)
  const deadline = Date.now() + timeoutMs;
  let ended = false;
  while (Date.now() < deadline) {
    await sleep(1200);
    const listXml = await c.callRaw(
      `<ListProcessesInGuest xmlns="urn:vim25"><_this type="GuestProcessManager">${processManager}</_this>${vmRef}${auth}<pids>${pid}</pids></ListProcessesInGuest>`
    ).catch((e) => { console.warn(`[gpu-guest]     [${vmMoref}] ListProcesses 오류: ${e.message}`); return ''; });
    if (/<endTime>/.test(listXml)) { ended = true; break; } // 종료됨
  }
  if (!ended) console.warn(`[gpu-guest]     [${vmMoref}] 프로세스 종료 대기 타임아웃(${Math.round(timeoutMs / 1000)}s) — 그래도 파일 회수 시도`);

  // 5) stdout 회수 → 파싱 (다운로드는 vCenter 실제 IP/ESXi IP 후보 우선).
  // 다운로드는 짧은 타임아웃으로 빠른 실패(도달 안 되는 후보가 전체를 오래 막지 않게).
  // 고RTT 사이트(폴란드·미국 동부 800ms+)는 TLS 핸드셰이크만 ~3RTT라 4초는 과도하게 짧다.
  // 도달 가능한 ESXi가 오탐 타임아웃되지 않게 8초로 완화(작은 파일이라 전송 자체는 즉시).
  const dlTimeout = Math.min(timeoutMs, 8000);
  const outRes = await readGuestFile(c, fileManager, vmRef, auth, outFile, dlTimeout, dlHosts, vmMoref);
  const parsed = parseNvidiaSmiCsv(outRes.text);
  if (parsed) {
    deleteGuestFile(c, fileManager, vmRef, auth, outFile);
    deleteGuestFile(c, fileManager, vmRef, auth, errFile);
    return parsed;
  }
  // 다운로드가 "도달 불가(timeout 등, HTTP 응답 없음)"면 stderr도 같은 실패 → 빠른 실패.
  // 단, "도달은 됨(HTTP 4xx/5xx 응답)"이면 stderr를 읽어 진짜 원인(드라이버/PATH/빈 출력)을 규명.
  const reachable = outRes.error && /HTTP\d/.test(outRes.error);
  if (outRes.error && !reachable) {
    deleteGuestFile(c, fileManager, vmRef, auth, outFile);
    deleteGuestFile(c, fileManager, vmRef, auth, errFile);
    const e = new Error(outRes.error); e.guestDiag = true; throw e;
  }

  // 6) stdout이 비었거나(다운로드 OK인데 내용 없음) 또는 도달은 되는데 .out이 404 →
  //    stderr를 읽어 원인 규명(빈 .out이 ESXi에서 404날 수 있음).
  const errRes = await readGuestFile(c, fileManager, vmRef, auth, errFile, dlTimeout, dlHosts, `${vmMoref}.err`);
  deleteGuestFile(c, fileManager, vmRef, auth, outFile);
  deleteGuestFile(c, fileManager, vmRef, auth, errFile);
  const stderrLine = (errRes.text || '').trim().split(/\r?\n/)[0];
  // stderr를 읽었으면 그게 진짜 원인. 못 읽었고(.err도 404) .out도 404였으면 회수단계 문제를 명시.
  const reason = stderrLine ? `게스트 오류: ${stderrLine.slice(0, 180)}`
    : reachable ? `회수 실패(.out/.err 모두 HTTP404 — 파일 비었거나 ESXi가 티켓 거부) · stdout: ${outRes.error}`
      : 'nvidia-smi 출력이 비어 있음(명령은 실행됐으나 stdout 없음)';
  const e = new Error(reason); e.guestDiag = true; throw e;
}

/** "12, 8, 2048, 81920, Enabled" 형식(여러 줄=여러 GPU)을 파싱해 집계. 마지막 컬럼은 MIG 모드(문자열). */
export function parseNvidiaSmiCsv(text) {
  if (!text || !text.trim()) return null;
  const gpus = [];
  for (const line of text.trim().split(/\r?\n/)) {
    const raw = line.split(',').map((x) => String(x).trim());
    const n0 = Number(raw[0]);
    if (raw.length < 1 || !Number.isFinite(n0)) continue;
    const num = (i) => { const v = Number(raw[i]); return Number.isFinite(v) ? v : null; };
    // MIG 모드: 'Enabled'/'Disabled'/'N/A'(미지원 GPU). 숫자가 아닌 마지막 컬럼.
    const migRaw = raw.length >= 5 ? raw[4] : '';
    const mig = /enabled/i.test(migRaw) ? 'enabled' : /disabled/i.test(migRaw) ? 'disabled' : null;
    gpus.push({ utilPct: n0, memUtilPct: num(1), memUsedMB: num(2), memTotalMB: num(3), mig });
  }
  if (!gpus.length) return null;
  const avg = (arr) => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  const memUsed = gpus.reduce((a, g) => a + (g.memUsedMB || 0), 0);
  const memTotal = gpus.reduce((a, g) => a + (g.memTotalMB || 0), 0);
  const migCount = gpus.filter((g) => g.mig === 'enabled').length;
  return { count: gpus.length, utilPct: avg(gpus.map((g) => g.utilPct)), memUsedPct: memTotal ? Math.round((memUsed / memTotal) * 100) : null, migEnabled: migCount, gpus };
}

export { VimSoapClient };
