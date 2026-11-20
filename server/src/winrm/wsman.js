/**
 * winrm/wsman.js — WS-Management(MS-WSMV) 원격 셸 메시지 조립 · 읽기(순수 · 의존 없음) · 서버 접속 3단계(설계 docs/design/server-access ④).
 *
 * 하는 일: cmd 원격 셸 하나를 만들고(Create) → 명령 하나(Command) → 출력을 끝까지 받고(Receive 반복) → 셸을 지운다(Delete).
 *   명령은 **호출부가 고정 값으로 넘긴 PowerShell 하나**(읽기 묶음 — serverinfo 가 만든다). 사용자 입력을 명령에 끼워 넣지 않는다.
 * 읽기는 정규식으로 필요한 칸만(ShellId · CommandId · Stream · CommandState · ExitCode · Fault 이유) — XML 파서 의존을 두지 않는다.
 *   응답 크기는 호출부(client.js)가 자른다. 이 모듈은 외부 입력을 앵커 있는 비탐욕 패턴으로만 읽는다(루트 CLAUDE.md 정규식 규칙).
 * ⚠ 실제 Windows 응답으로는 아직 확인하지 못했다 — 형식은 MS-WSMV 문서 예시를 따랐다(설계 README §7). 시험은 그 예시 모양의 가짜 서버로 한다.
 */
import crypto from 'node:crypto';

export const NS = Object.freeze({
  s: 'http://www.w3.org/2003/05/soap-envelope',
  a: 'http://schemas.xmlsoap.org/ws/2004/08/addressing',
  w: 'http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd',
  p: 'http://schemas.microsoft.com/wbem/wsman/1/wsman.xsd',
  rsp: 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell',
});
export const RESOURCE_CMD = 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd';
export const ACTION = Object.freeze({
  create: 'http://schemas.xmlsoap.org/ws/2004/09/transfer/Create',
  delete: 'http://schemas.xmlsoap.org/ws/2004/09/transfer/Delete',
  command: 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Command',
  receive: 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Receive',
  signal: 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Signal',
});
const TERMINATE = 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/signal/terminate';
/** XML 글자 이스케이프(요소 · 속성 공용). */
export const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const ID_RE = /^[0-9A-Fa-f-]{8,64}$/;

/** SOAP 봉투 하나. selector = ShellId(있으면). timeoutS = OperationTimeout(초). */
export function envelope({ to, action, selector = '', body = '', timeoutS = 60, maxEnvelope = 512000, options = '' }) {
  const mid = `uuid:${crypto.randomUUID().toUpperCase()}`;
  return '<?xml version="1.0" encoding="utf-8"?>'
    + `<s:Envelope xmlns:s="${NS.s}" xmlns:a="${NS.a}" xmlns:w="${NS.w}" xmlns:p="${NS.p}" xmlns:rsp="${NS.rsp}">`
    + '<s:Header>'
    + `<a:To>${esc(to)}</a:To>`
    + `<w:ResourceURI s:mustUnderstand="true">${RESOURCE_CMD}</w:ResourceURI>`
    + '<a:ReplyTo><a:Address s:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address></a:ReplyTo>'
    + `<a:Action s:mustUnderstand="true">${esc(action)}</a:Action>`
    + `<w:MaxEnvelopeSize s:mustUnderstand="true">${Math.max(16384, Math.min(4194304, Math.floor(maxEnvelope)))}</w:MaxEnvelopeSize>`
    + `<a:MessageID>${mid}</a:MessageID>`
    + '<w:Locale xml:lang="en-US" s:mustUnderstand="false"/><p:DataLocale xml:lang="en-US" s:mustUnderstand="false"/>'
    + `<w:OperationTimeout>PT${Math.max(5, Math.min(600, Math.floor(timeoutS)))}.000S</w:OperationTimeout>`
    + (selector ? `<w:SelectorSet><w:Selector Name="ShellId">${esc(selector)}</w:Selector></w:SelectorSet>` : '')
    + options
    + '</s:Header>'
    + `<s:Body>${body}</s:Body>`
    + '</s:Envelope>';
}

export function createShellBody() {
  // 코드 페이지 65001(UTF-8) · 프로필 읽지 않음 · 표준 입력 쓰지 않음
  return '<rsp:Shell><rsp:InputStreams>stdin</rsp:InputStreams><rsp:OutputStreams>stdout stderr</rsp:OutputStreams></rsp:Shell>';
}
export const CREATE_OPTIONS = '<w:OptionSet><w:Option Name="WINRS_NOPROFILE">TRUE</w:Option><w:Option Name="WINRS_CODEPAGE">65001</w:Option></w:OptionSet>';
export function commandBody(command, args = []) {
  return `<rsp:CommandLine><rsp:Command>${esc(command)}</rsp:Command>${args.map((a) => `<rsp:Arguments>${esc(a)}</rsp:Arguments>`).join('')}</rsp:CommandLine>`;
}
export const COMMAND_OPTIONS = '<w:OptionSet><w:Option Name="WINRS_CONSOLEMODE_STDIN">TRUE</w:Option><w:Option Name="WINRS_SKIP_CMD_SHELL">TRUE</w:Option></w:OptionSet>';
export function receiveBody(commandId) {
  return `<rsp:Receive><rsp:DesiredStream CommandId="${esc(commandId)}">stdout stderr</rsp:DesiredStream></rsp:Receive>`;
}
export function signalBody(commandId) {
  return `<rsp:Signal CommandId="${esc(commandId)}"><rsp:Code>${TERMINATE}</rsp:Code></rsp:Signal>`;
}

/* ── 응답 읽기 ─────────────────────────────────────────────────────────── */

/** 첫 번째 <prefix:Name ...>값</prefix:Name> 의 값(접두어는 무엇이든). 길이 상한이 있는 문서에서만 쓴다. */
function firstText(xml, name) {
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?${name}(?:\\s[^>]{0,400})?>([^<]{0,4096})</(?:[A-Za-z0-9_]+:)?${name}>`);
  const m = re.exec(xml);
  return m ? m[1].trim() : '';
}

/** Create 응답 → ShellId(GUID 꼴만). */
export function parseShellId(xml) {
  let id = firstText(xml, 'ShellId');
  if (!id) { const m = /<w:Selector Name="ShellId">([^<]{1,80})<\/w:Selector>/.exec(xml); id = m ? m[1].trim() : ''; }
  if (!ID_RE.test(id)) throw new Error('WinRM 셸을 만들지 못했습니다(ShellId 없음)');
  return id;
}
/** Command 응답 → CommandId. */
export function parseCommandId(xml) {
  const id = firstText(xml, 'CommandId');
  if (!ID_RE.test(id)) throw new Error('WinRM 명령을 시작하지 못했습니다(CommandId 없음)');
  return id;
}
/**
 * Receive 응답 → { stdout:Buffer[], stderr:Buffer[], done:boolean, exitCode:number|null }.
 * Stream 요소는 base64 — 디코드한 바이트를 그대로 모은다(UTF-8 경계는 호출부가 다 모은 뒤 한 번 푼다).
 */
export function parseReceive(xml) {
  const out = { stdout: [], stderr: [], done: false, exitCode: null };
  const re = /<(?:[A-Za-z0-9_]+:)?Stream\s+([^>]{0,300})>([A-Za-z0-9+/=\s]{0,1048576})<\/(?:[A-Za-z0-9_]+:)?Stream>/g;
  let m;
  while ((m = re.exec(xml))) {
    const name = /Name="(stdout|stderr)"/.exec(m[1]);
    if (!name) continue;
    const data = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    if (data.length) out[name[1]].push(data);
  }
  const state = /<(?:[A-Za-z0-9_]+:)?CommandState\s[^>]{0,300}State="([^"]{1,200})"/.exec(xml);
  if (state && /\/CommandState\/Done$/.test(state[1])) {
    out.done = true;
    const ec = firstText(xml, 'ExitCode');
    out.exitCode = /^-?\d{1,10}$/.test(ec) ? Number(ec) : null;
  }
  return out;
}
/** SOAP Fault 의 이유(사람이 읽는 글자 — 앞 300자). 없으면 ''. */
export function faultReason(xml) {
  if (!/<(?:[A-Za-z0-9_]+:)?Fault[\s>]/.test(String(xml || ''))) return '';
  const t = firstText(xml, 'Text') || firstText(xml, 'Message') || '';
  const code = /WSManFault[^>]{0,200}Code="(\d{1,12})"/.exec(xml);
  return `${t.replace(/\s+/g, ' ').slice(0, 300)}${code ? ` (WSMan ${code[1]})` : ''}` || 'WinRM 오류(사유 없음)';
}
/** Receive 시한 초과 Fault(아직 출력 없음 — 다시 Receive 하면 된다)인가. */
export const isReceiveTimeout = (xml) => /w:TimedOut|2150858793|OperationTimeout/i.test(String(xml || '')) && /Fault/.test(String(xml || ''));
