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

// 단계별 trace 기록기 — 게스트 작업의 명령/로그를 UI로 노출하기 위해 결과에 함께 담는다.
// tr이 null이면 무시(폴러 등 trace 불필요 경로). 비밀번호/티켓은 절대 담지 않는다.
const tlog = (tr, msg) => { if (tr) tr.push({ t: Date.now(), msg: String(msg) }); };


/**
 * 자격증명 검증(로그인 테스트) + nvidia-smi 데이터 읽기 테스트를 한 번에.
 * 반환 { login, read, error, sample }.
 *   - login: ValidateCredentialsInGuest 성공 여부(게스트에 명령 실행 X, 인증만 확인)
 *   - read : nvidia-smi로 GPU 사용률을 실제로 읽었는지
 */
export async function testVmGuest(c, vmMoref, creds, { isWindows = false, timeoutMs = 15_000, dlHosts = [], trace = null } = {}) {
  const out = { login: false, read: false, error: null, sample: null, trace: trace || [] };
  const tr = out.trace;
  const vmRef = `<vm type="VirtualMachine">${vmMoref}</vm>`;
  const auth = authXml(creds);
  let authManager;
  tlog(tr, `게스트 관리자 조회(GuestOperationsManager)`);
  try {
    ({ authManager } = await guestManagers(c));
  } catch (e) { tlog(tr, `✗ 관리자 조회 실패: ${cleanGuestError(e.message)}`); out.error = cleanGuestError(e.message); return out; }
  // 1) 로그인(자격증명) 검증 — 게스트에 아무것도 실행하지 않고 인증만 확인.
  try {
    tlog(tr, `SOAP ValidateCredentialsInGuest (계정=${creds.username}${creds.password ? '' : ' · 비번없음(passwordless)'}) — 인증만 확인(명령 실행 X)`);
    if (authManager) {
      await c.callRaw(`<ValidateCredentialsInGuest xmlns="urn:vim25"><_this type="GuestAuthManager">${authManager}</_this>${vmRef}${auth}</ValidateCredentialsInGuest>`);
    }
    out.login = true;
    tlog(tr, `✓ 로그인 성공`);
  } catch (e) { tlog(tr, `✗ 로그인 실패: ${cleanGuestError(e.message)}`); out.error = cleanGuestError(e.message); return out; }
  // 2) 데이터 읽기 — nvidia-smi 실행 후 파싱. 실패 시 구체 사유(stderr/다운로드)를 그대로 표시.
  try {
    const r = await collectVmGpu(c, vmMoref, creds, { isWindows, timeoutMs, dlHosts, trace: tr });
    if (r && r.utilPct != null) { out.read = true; out.sample = { gpus: r.count, utilPct: r.utilPct, utilNA: !!r.utilNA, memUsedPct: r.memUsedPct, migEnabled: r.migEnabled || 0 }; tlog(tr, `✓ 읽기 성공 — GPU ${r.count}개, 사용률 ${r.utilNA ? 'N/A(MIG 모드)' : r.utilPct + '%'}`); }
    else { out.error = 'nvidia-smi 출력 없음 — 게스트에 NVIDIA 드라이버/nvidia-smi 확인'; tlog(tr, `✗ ${out.error}`); }
  } catch (e) { out.error = e.guestDiag ? e.message : cleanGuestError(e.message); tlog(tr, `✗ 읽기 실패: ${out.error}`); }
  return out;
}

function authXml(creds) {
  // username/password가 없으면 esc(undefined)가 문자열 'undefined'가 되어 엉뚱한 자격증명으로
  // 인증하므로 빈 문자열로 정규화한다.
  return `<auth xsi:type="NamePasswordAuthentication"><interactiveSession>false</interactiveSession>` +
    `<username>${esc(creds.username ?? '')}</username><password>${esc(creds.password ?? '')}</password></auth>`;
}

// 게스트 파일 1개를 InitiateFileTransferFromGuest → HTTP GET 으로 회수.
// 반환 { text, error } — error 가 있으면 다운로드 단계(포탈→ESXi 도달/인증서/HTTP) 실패.
// path/query(토큰)는 건드리지 않고 호스트(+포트)만 교체 — new URL()의 재인코딩으로 토큰이
// 깨지지 않게 정규식으로 스킴 다음 호스트만 바꾼다('*' 호스트도 포함).
const swapHost = (u, host) => u.replace(/^(https?:\/\/)[^/]+/, `$1${host}`);

async function readGuestFile(c, fileManager, vmRef, auth, guestPath, timeoutMs, preferHosts = [], tag = '', tr = null) {
  let ftXml;
  try {
    tlog(tr, `  SOAP InitiateFileTransferFromGuest (${guestPath})`);
    ftXml = await c.callRaw(
      `<InitiateFileTransferFromGuest xmlns="urn:vim25"><_this type="GuestFileManager">${fileManager}</_this>${vmRef}${auth}` +
      `<guestFilePath>${esc(guestPath)}</guestFilePath></InitiateFileTransferFromGuest>`);
  } catch (e) {
    console.warn(`[gpu-guest]     [${tag}] InitiateFileTransferFromGuest 실패: ${e.message}`);
    tlog(tr, `  ✗ 파일전송요청 실패: ${cleanGuestError(e.message)}`);
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
  tlog(tr, `  파일 다운로드 시도(size=${size ?? '?'}B, 후보 ${candidates.length}개): ${candidates.map((u) => { try { return new URL(u).host; } catch { return '?'; } }).join(', ')}`);
  const tries = [];
  for (const cand of candidates) {
    const candHost = (() => { try { return new URL(cand).host; } catch { return '?'; } })();
    const isOrig = cand === url;
    const t0 = Date.now();
    try {
      const res = await fetch(cand, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        console.log(`[gpu-guest]     [${tag}] 다운로드 ${candHost}${isOrig ? '(원본)' : ''} → HTTP ${res.status} ✓`);
        tlog(tr, `  ✓ GET ${candHost}${isOrig ? '(원본)' : ''} → HTTP ${res.status} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        return { text: await res.text(), error: null };
      }
      // 404 등 본문에 ESXi가 사유를 담아주므로(예: 파일없음/티켓무효) 일부를 캡처.
      let body = '';
      try { body = (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100); } catch { /* */ }
      console.warn(`[gpu-guest]     [${tag}] 다운로드 ${candHost}${isOrig ? '(원본)' : ''} → HTTP ${res.status}${body ? ` body="${body}"` : ''}`);
      tlog(tr, `  ✗ GET ${candHost}${isOrig ? '(원본)' : ''} → HTTP ${res.status} (${((Date.now() - t0) / 1000).toFixed(1)}s)${body ? ` "${body.slice(0, 60)}"` : ''}`);
      tries.push(`${candHost}${isOrig ? '(원본)' : ''}=HTTP${res.status}${body ? `(${body})` : ''}`);
    } catch (e) {
      console.warn(`[gpu-guest]     [${tag}] 다운로드 ${candHost}${isOrig ? '(원본)' : ''} → ${e.message}`);
      tlog(tr, `  ✗ GET ${candHost}${isOrig ? '(원본)' : ''} → ${cleanGuestError(e.message)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
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
export async function collectVmGpu(c, vmMoref, creds, { isWindows, timeoutMs = 20_000, dlHosts = [], trace = null } = {}) {
  const tr = trace;
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
  tlog(tr, `명령: ${prog.path} ${prog.args}`);
  tlog(tr, `SOAP StartProgramInGuest`);
  const startXml =
    `<StartProgramInGuest xmlns="urn:vim25"><_this type="GuestProcessManager">${processManager}</_this>${vmRef}${auth}` +
    `<spec xsi:type="GuestProgramSpec"><programPath>${esc(prog.path)}</programPath><arguments>${esc(prog.args)}</arguments></spec></StartProgramInGuest>`;
  let startRes;
  try { startRes = await c.callRaw(startXml); }
  catch (e) { tlog(tr, `✗ StartProgramInGuest SOAP 실패: ${cleanGuestError(e.message)}`); throw new Error(`StartProgramInGuest SOAP 실패: ${cleanGuestError(e.message)} | raw: ${String(e.message).slice(0, 200)}`); }
  const pid = /<returnval>(\d+)<\/returnval>/.exec(startRes)?.[1];
  if (!pid) {
    const fault = /<faultstring>([^<]*)<\/faultstring>/.exec(startRes)?.[1] || startRes.slice(0, 200);
    tlog(tr, `✗ pid 없음: ${fault}`);
    throw new Error(`StartProgramInGuest 실패(pid 없음): ${fault}`);
  }
  console.log(`[gpu-guest]     [${vmMoref}] StartProgram pid=${pid} → ${outFile}`);
  tlog(tr, `→ pid=${pid}, 출력파일=${outFile}`);

  // 4) 종료 대기(ListProcessesInGuest)
  tlog(tr, `프로세스 종료 대기(ListProcessesInGuest, 최대 ${Math.round(timeoutMs / 1000)}s)`);
  const waitStart = Date.now();
  const deadline = waitStart + timeoutMs;
  let ended = false, polls = 0;
  while (Date.now() < deadline) {
    await sleep(1200);
    polls++;
    const listXml = await c.callRaw(
      `<ListProcessesInGuest xmlns="urn:vim25"><_this type="GuestProcessManager">${processManager}</_this>${vmRef}${auth}<pids>${pid}</pids></ListProcessesInGuest>`
    ).catch((e) => { console.warn(`[gpu-guest]     [${vmMoref}] ListProcesses 오류: ${e.message}`); tlog(tr, `  ! ListProcesses 오류: ${cleanGuestError(e.message)}`); return ''; });
    if (/<endTime>/.test(listXml)) { ended = true; break; } // 종료됨
  }
  const waitS = ((Date.now() - waitStart) / 1000).toFixed(1);
  if (!ended) { console.warn(`[gpu-guest]     [${vmMoref}] 프로세스 종료 대기 타임아웃(${Math.round(timeoutMs / 1000)}s) — 그래도 파일 회수 시도`); tlog(tr, `! 종료 대기 타임아웃(${waitS}s, ${polls}회 폴링) — 그래도 회수 시도`); }
  else tlog(tr, `→ 프로세스 종료 확인(${waitS}s, ${polls}회 폴링)`);

  // 5) stdout 회수 → 파싱 (다운로드는 vCenter 실제 IP/ESXi IP 후보 우선).
  // 다운로드는 짧은 타임아웃으로 빠른 실패(도달 안 되는 후보가 전체를 오래 막지 않게).
  // 고RTT 사이트(폴란드·미국 동부 800ms+)는 TLS 핸드셰이크만 ~3RTT라 4초는 과도하게 짧다.
  // 도달 가능한 ESXi가 오탐 타임아웃되지 않게 8초로 완화(작은 파일이라 전송 자체는 즉시).
  const dlTimeout = Math.min(timeoutMs, 8000);
  tlog(tr, `결과(stdout) 회수: ${outFile}`);
  const outRes = await readGuestFile(c, fileManager, vmRef, auth, outFile, dlTimeout, dlHosts, vmMoref, tr);
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
  tlog(tr, `stdout 비어있음/실패 → stderr 회수로 원인 규명: ${errFile}`);
  const errRes = await readGuestFile(c, fileManager, vmRef, auth, errFile, dlTimeout, dlHosts, `${vmMoref}.err`, tr);
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
  // '[N/A]' / 'N/A' / 빈값 → null. nounits라도 MIG 모드면 사용률이 '[N/A]'로 온다.
  const num = (s) => { const v = Number(String(s).replace(/[[\]]/g, '').trim()); return Number.isFinite(v) ? v : null; };
  for (const line of text.trim().split(/\r?\n/)) {
    if (!line.trim()) continue; // 빈 줄 건너뜀
    const raw = line.split(',').map((x) => String(x).trim());
    if (raw.length < 4) continue; // 데이터 행 아님(헤더/잡음)
    const utilPct = num(raw[0]);     // MIG Enabled면 [N/A] → null(아래서 유휴 0% 처리)
    const memUsedMB = num(raw[2]);
    const memTotalMB = num(raw[3]);
    // 실제 GPU 한 장 판별: 총 메모리가 보고되면 GPU다(MIG로 사용률이 N/A여도 메모리는 나옴).
    // 둘 다 없으면(헤더/잡음) 건너뛴다. → MIG GPU가 통째로 누락되던 버그 수정.
    if (memTotalMB == null && utilPct == null) continue;
    // MIG 모드: 'Enabled'/'Disabled'/'N/A'(미지원 GPU). 숫자가 아닌 마지막 컬럼.
    const migRaw = raw.length >= 5 ? raw[4] : '';
    const mig = /enabled/i.test(migRaw) ? 'enabled' : /disabled/i.test(migRaw) ? 'disabled' : null;
    gpus.push({ utilPct, memUtilPct: num(raw[1]), memUsedMB, memTotalMB, mig });
  }
  if (!gpus.length) return null;
  const avg = (arr) => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  const known = gpus.map((g) => g.utilPct).filter((v) => v != null);
  const memUsed = gpus.reduce((a, g) => a + (g.memUsedMB || 0), 0);
  const memTotal = gpus.reduce((a, g) => a + (g.memTotalMB || 0), 0);
  const migCount = gpus.filter((g) => g.mig === 'enabled').length;
  // 사용률을 아는 GPU가 하나도 없음 = MIG로 GPU 단위 사용률 미제공(인스턴스 미생성=유휴).
  // 이 경우 0%(유휴)로 보고하되 utilNA 플래그로 'N/A(MIG)'임을 구분 가능하게 한다.
  const utilNA = known.length === 0;
  return {
    count: gpus.length,
    utilPct: known.length ? avg(known) : 0,
    utilNA,
    memUsedPct: memTotal ? Math.round((memUsed / memTotal) * 100) : null,
    migEnabled: migCount,
    gpus,
  };
}

// ───────────────────── 게스트 계정 추가(권한 작업) ─────────────────────
// vim25 게스트 작업으로 게스트 OS에 sudo 사용자 계정을 추가한다. 비밀번호는 셸 인자/스크립트에
// 넣지 않고 별도 파일로 업로드해 `chpasswd < file`로 적용 → 노출/인용 문제 회피. root 게스트 권한 필요.

const URL_DECODE = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, '&');

function candidateUrls(c, url, preferHosts = []) {
  const vcHost = (c.vc.host || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const swapped = [...new Set([...preferHosts.filter(Boolean), vcHost])].map((h) => swapHost(url, h));
  return [...new Set([url, ...swapped])];
}

/** 게스트로 파일 업로드(InitiateFileTransferToGuest → HTTP PUT). posixPerm=8진수(linux). */
async function writeGuestFile(c, fileManager, vmRef, auth, guestPath, content, { posixPerm = 0o600, isWindows = false, preferHosts = [], timeoutMs = 8000 } = {}) {
  const bytes = Buffer.byteLength(content, 'utf8');
  const attrs = isWindows
    ? '<fileAttributes xsi:type="GuestWindowsFileAttributes"></fileAttributes>'
    : `<fileAttributes xsi:type="GuestPosixFileAttributes"><permissions>${posixPerm}</permissions></fileAttributes>`;
  let xml;
  try {
    xml = await c.callRaw(`<InitiateFileTransferToGuest xmlns="urn:vim25"><_this type="GuestFileManager">${fileManager}</_this>${vmRef}${auth}` +
      `<guestFilePath>${esc(guestPath)}</guestFilePath>${attrs}<fileSize>${bytes}</fileSize><overwrite>true</overwrite></InitiateFileTransferToGuest>`);
  } catch (e) { return { ok: false, error: `업로드요청 실패: ${cleanGuestError(e.message)}` }; }
  const url = URL_DECODE(/<returnval[^>]*>([^<]+)<\/returnval>/.exec(xml)?.[1] || '');
  if (!url) return { ok: false, error: '업로드 URL을 반환하지 않음' };
  const tries = [];
  for (const cand of candidateUrls(c, url, preferHosts)) {
    try {
      const res = await fetch(cand, { method: 'PUT', body: content, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes) }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return { ok: true };
      tries.push(`HTTP${res.status}`);
    } catch (e) { tries.push(String(e.message).slice(0, 50)); }
  }
  return { ok: false, error: `업로드 실패: ${tries.join(' | ')}` };
}

/** 게스트에 스크립트(+부가 파일)를 올려 실행하고 stdout/stderr/exitCode를 회수. */
export async function runGuestScript(c, vmMoref, creds, scriptText, { isWindows = false, dlHosts = [], timeoutMs = 30_000, files = [] } = {}) {
  const { processManager, fileManager } = await guestManagers(c);
  const auth = authXml(creds);
  const vmRef = `<vm type="VirtualMachine">${vmMoref}</vm>`;
  const ts = Date.now();
  const scriptPath = isWindows ? `C:\\Windows\\Temp\\portal-acct-${ts}.bat` : `/tmp/portal-acct-${ts}.sh`;
  const outFile = isWindows ? `C:\\Windows\\Temp\\portal-acct-${ts}.out` : `/tmp/portal-acct-${ts}.out`;
  const errFile = isWindows ? `C:\\Windows\\Temp\\portal-acct-${ts}.err` : `/tmp/portal-acct-${ts}.err`;
  for (const f of files) { const w = await writeGuestFile(c, fileManager, vmRef, auth, f.path, f.content, { posixPerm: f.perm ?? 0o600, isWindows, preferHosts: dlHosts }); if (!w.ok) throw new Error(`파일 업로드 실패(${f.path}): ${w.error}`); }
  const ws = await writeGuestFile(c, fileManager, vmRef, auth, scriptPath, scriptText, { posixPerm: 0o600, isWindows, preferHosts: dlHosts });
  if (!ws.ok) throw new Error(`스크립트 업로드 실패: ${ws.error}`);
  const prog = isWindows
    ? { path: 'C:\\Windows\\System32\\cmd.exe', args: `/c "${scriptPath}" 1>"${outFile}" 2>"${errFile}"` }
    : { path: '/bin/sh', args: `-c "sh ${scriptPath} 1>${outFile} 2>${errFile}"` };
  const startXml = await c.callRaw(`<StartProgramInGuest xmlns="urn:vim25"><_this type="GuestProcessManager">${processManager}</_this>${vmRef}${auth}` +
    `<spec xsi:type="GuestProgramSpec"><programPath>${esc(prog.path)}</programPath><arguments>${esc(prog.args)}</arguments></spec></StartProgramInGuest>`);
  const pid = /<returnval>(\d+)<\/returnval>/.exec(startXml)?.[1];
  if (!pid) { const fault = /<faultstring>([^<]*)<\/faultstring>/.exec(startXml)?.[1] || startXml.slice(0, 160); throw new Error(`StartProgramInGuest 실패: ${cleanGuestError(fault)}`); }
  const deadline = Date.now() + timeoutMs; let exitCode = null, ended = false;
  while (Date.now() < deadline) {
    await sleep(1000);
    const listXml = await c.callRaw(`<ListProcessesInGuest xmlns="urn:vim25"><_this type="GuestProcessManager">${processManager}</_this>${vmRef}${auth}<pids>${pid}</pids></ListProcessesInGuest>`).catch(() => '');
    if (/<endTime>/.test(listXml)) { ended = true; const ec = /<exitCode>(-?\d+)<\/exitCode>/.exec(listXml); exitCode = ec ? Number(ec[1]) : null; break; }
  }
  const dl = Math.min(timeoutMs, 8000);
  const out = await readGuestFile(c, fileManager, vmRef, auth, outFile, dl, dlHosts, vmMoref);
  const err = await readGuestFile(c, fileManager, vmRef, auth, errFile, dl, dlHosts, `${vmMoref}.err`);
  for (const p of [scriptPath, outFile, errFile, ...files.map((f) => f.path)]) deleteGuestFile(c, fileManager, vmRef, auth, p);
  return { ok: exitCode === 0 || (exitCode == null && ended), exitCode, ended, stdout: (out.text || '').trim().slice(0, 2000), stderr: (err.text || '').trim().slice(0, 2000) };
}

const USERRE = /^[a-z_][a-z0-9_-]{0,31}$/; // 안전한 사용자명만(셸 주입 방지)

/** 게스트 OS에 사용자 계정 추가(+sudo). root 게스트 자격증명 필요. */
export async function addGuestUser(c, vmMoref, creds, { username, password, sudo = true, nopasswd = false, isWindows = false, dlHosts = [], timeoutMs = 30_000 } = {}) {
  const u = String(username || '');
  if (!isWindows && !USERRE.test(u)) throw new Error('사용자명 형식 오류(영소문자/숫자/_/-, 첫 글자 영문 또는 _, 32자 이내).');
  if (isWindows && !/^[A-Za-z0-9._-]{1,20}$/.test(u)) throw new Error('Windows 사용자명 형식 오류.');
  if (!password) throw new Error('비밀번호가 필요합니다.');
  // 개행이 섞이면 chpasswd 입력 파일이 여러 줄이 되어 요청과 다른 비밀번호가 설정된다(조용한 변조 금지 — 거부).
  if (!isWindows && /[\r\n]/.test(String(password))) throw new Error('비밀번호에 줄바꿈 문자는 사용할 수 없습니다(그 외 특수문자는 모두 지원).');
  const ts = Date.now();
  if (isWindows) {
    const p = String(password);
    // 비밀번호를 조용히 변조(따옴표 제거)하면 요청과 다른 계정이 생겨 잠금된다. 배치에 안전하게
    // 넣을 수 없는 문자(따옴표/퍼센트 변수확장/개행)는 재작성하지 않고 거부한다.
    if (/["%\r\n]/.test(p)) throw new Error('Windows 비밀번호에 사용할 수 없는 문자가 있습니다("(따옴표), %(퍼센트), 개행 제외).');
    const script = `@echo off\r\nnet user "${u}" "${p}" /add\r\nnet localgroup Administrators "${u}" /add\r\nnet user "${u}"\r\n`;
    return runGuestScript(c, vmMoref, creds, script, { isWindows: true, dlHosts, timeoutMs });
  }
  const pwPath = `/tmp/portal-pw-${ts}`;
  const lines = [
    '#!/bin/sh', 'set -e',
    `if id "${u}" >/dev/null 2>&1; then echo "user-exists"; else useradd -m -s /bin/bash "${u}"; echo "user-created"; fi`,
    `chpasswd < "${pwPath}"; rm -f "${pwPath}"; echo "password-set"`,
  ];
  if (sudo) lines.push(`if getent group wheel >/dev/null 2>&1; then usermod -aG wheel "${u}"; else usermod -aG sudo "${u}"; fi; echo "sudo-group-added"`);
  if (sudo && nopasswd) lines.push(`printf '%s ALL=(ALL) NOPASSWD:ALL\\n' "${u}" > /etc/sudoers.d/${u}; chmod 440 /etc/sudoers.d/${u}; (visudo -cf /etc/sudoers.d/${u} || rm -f /etc/sudoers.d/${u}); echo "nopasswd-set"`);
  lines.push(`id "${u}"`);
  // 비밀번호는 스크립트가 아니라 별도 파일(0600)로만 전달 → 셸/프로세스 인자 노출 없음.
  return runGuestScript(c, vmMoref, creds, lines.join('\n') + '\n', { isWindows: false, dlHosts, timeoutMs, files: [{ path: pwPath, content: `${u}:${password}\n`, perm: 0o600 }] });
}

export { VimSoapClient };
