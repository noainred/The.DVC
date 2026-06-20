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
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function guestManagers(c) {
  const objs = await c.retrieveObjectProps('GuestOperationsManager', c.sc.guestOperationsManager, ['processManager', 'fileManager']);
  const p = objs[0]?.props || {};
  if (!p.processManager || !p.fileManager) throw new Error('GuestOperationsManager 사용 불가');
  return { processManager: p.processManager, fileManager: p.fileManager };
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
