/**
 * sanswitch/flowCmd.js — Brocade Flow Vision 명령 조립 · 출력 판독(v2.934 SAN·CVP 설계 C-② — docs/design/san-cvp-traffic/README.md §9). 순수.
 *
 * 왜 조심하나: 이 명령은 **스위치 설정을 바꾼다**(flow --create · --delete). 그래서
 *   ① 명령은 여기서만 만든다 — 화면 · 엣지가 보낸 글자를 이어 붙이지 않는다(셸 명령 조립 규약 — server/CLAUDE.md).
 *   ② 모든 값은 화이트리스트 정규식으로 먼저 검사한다: 이름은 포탈 접두 `dvc_` 고정 · 포트는 슬롯/포트 숫자 · 장치는 WWN 표준형.
 *   ③ 지우기 · 끄기는 `dvc_` 로 시작하는 포탈 플로우만 — 사람이 만든 플로우는 보여 주되 손대지 않는다.
 *
 * ⚠ 정직: 문법(옵션 이름 · -bidir · -feature monitor) · 출력 형식 · 상한(스위치 128 · 디렉터 512 · 포트당 모니터 64)은
 *   FOS 8.0.1 명령 참조(Dell 미러)와 Flow Vision 8.1 안내서(Lenovo 미러) 기준이고 **실장비로 확인하지 못했다**.
 *   출력 판독은 관용적이고, 못 읽으면 parsed:false + 원문 앞부분을 남긴다(‘0’ 이나 ‘없음’ 으로 단정하지 않는다).
 */

import crypto from 'node:crypto';

export const FLOW_PREFIX = 'dvc_';
/**
 * v2.934 반증 H-1: FOS 플로우 이름은 영숫자 · _ **20자 이하**이고 소문자로 저장된다(FOS 8.0.1 명령 참조 — 검색 요약 기준, 원문 미열람 · 추정).
 *   예전 정규식은 44자까지 받아 실장비에서 만들기가 거부될 가능성이 컸다. 소문자만 받는다(장비가 소문자로 바꿔 저장하면 지우기 · 보기 이름이 어긋난다).
 */
export const FLOW_NAME_MAX = 20;
export const FLOW_NAME_RE = /^dvc_[a-z0-9_]{1,16}$/;
export const PORT_RE = /^\d{1,3}(\/\d{1,3})?$/;
export const WWN_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){7}$/;
export const FLOWS_PER_SWITCH = 128;
export const FLOWS_PER_DIRECTOR = 512;
export const MONITOR_PER_PORT = 64;
export const OUT_MAX = 16 * 1024;

/** 모델 이름으로 상한(디렉터 512 · 그 밖 128) — 모르면 스위치 상한(작은 쪽 — 넘겨 만들지 않게). */
export const flowLimitOf = (model) => (/DCX|X6-|X7-|director/i.test(String(model || '')) ? FLOWS_PER_DIRECTOR : FLOWS_PER_SWITCH);

/**
 * 포탈 플로우 이름 — `dvc_` + 호스트 이름 앞 7자 + (호스트 id · HBA 해시 5자) + `_` + 차례 2자리 = 최대 19자.
 *   호스트 이름 앞부분은 사람이 알아보라고, 해시는 같은 접두의 호스트(…-esx01 · …-esx02)가 같은 이름 예산을 나눠 쓰지 않게(반증 H-1).
 *   호스트 · HBA 대응은 포탈 기록(san-flows.json)에 있다.
 */
export function flowNameFor(hostKey, hostName, hba, idx) {
  const h = String(hostName || 'host').split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 7) || 'host';
  const hash = crypto.createHash('sha1').update(`${hostKey || hostName}|${hba || ''}`).digest('hex').slice(0, 5);
  const n = String(Math.max(1, Math.min(99, Math.trunc(Number(idx) || 1)))).padStart(2, '0');
  return `${FLOW_PREFIX}${h}${hash}_${n}`;
}

/**
 * 플로우 정의 검사 → { ok, reason? }. 하나라도 형식 밖이면 명령을 만들지 않는다.
 * @param {{ name, ingrport, srcdev, dstdev }} f
 */
export function flowDefIssue(f) {
  if (!f || typeof f !== 'object') return '플로우 정의가 없습니다';
  if (!FLOW_NAME_RE.test(String(f.name || ''))) return `플로우 이름은 ${FLOW_PREFIX} 로 시작하는 소문자 · 숫자 · _ ${FLOW_NAME_MAX}자 이하만 됩니다`;
  if (!PORT_RE.test(String(f.ingrport || ''))) return '수신 포트(ingrport)는 슬롯/포트 숫자만 됩니다';
  if (!WWN_RE.test(String(f.srcdev || ''))) return '초기자(srcdev)는 WWN 표준형(콜론 16진 소문자)만 됩니다';
  if (!WWN_RE.test(String(f.dstdev || ''))) return '타깃(dstdev)은 WWN 표준형(콜론 16진 소문자)만 됩니다';
  return null;
}

/**
 * 동작 → 실행할 명령들(검사를 통과한 값만). action:
 *   check  — `flow --show`(읽기만 · 계정이 flow 명령을 쓸 수 있는지 · 라이선스 문구 확인)
 *   create — 플로우마다 `flow --create … -feature monitor -ingrport … -srcdev … -dstdev … -bidir` 다음 `flow --show <name>`
 *   show   — 플로우마다 `flow --show <name>`
 *   delete — `flow --delete <name>`(dvc_ 만)
 * @returns {{ cmds: string[] } | { issue: string }}
 */
export function buildFlowCommands(action, flows = []) {
  if (action === 'check') return { cmds: ['flow --show'] };
  const list = Array.isArray(flows) ? flows.slice(0, 16) : [];
  if (!list.length) return { issue: '플로우가 없습니다' };
  const cmds = [];
  for (const f of list) {
    if (action === 'create') {
      const why = flowDefIssue(f);
      if (why) return { issue: why };
      cmds.push(`flow --create ${f.name} -feature monitor -ingrport ${f.ingrport} -srcdev ${f.srcdev} -dstdev ${f.dstdev} -bidir`);
      cmds.push(`flow --show ${f.name}`);
    } else if (action === 'show' || action === 'delete') {
      if (!FLOW_NAME_RE.test(String(f?.name || ''))) return { issue: `포탈이 만든(${FLOW_PREFIX}) 플로우만 다룹니다` };
      cmds.push(action === 'show' ? `flow --show ${f.name}` : `flow --delete ${f.name}`);
    } else return { issue: `알 수 없는 동작: ${String(action).slice(0, 20)}` };
  }
  return { cmds };
}

/**
 * 명령 출력의 오류 분류(관용) — 라이선스 없음 · 명령 없음(rbash) · 권한 없음 · 이미 있음 · 없는 플로우. 오류가 아니면 null.
 *   v2.934 반증 L-5: 표 줄('|' 가 있는 줄 — 플로우 목록 · 카운터)과 이름처럼 보이는 낱말(밑줄 · 영숫자 이어진 것 · WWN)은 빼고 본다 —
 *   호스트 이름에 failed · invalid · duplicate 가 들어가면 그 이름이 출력에 실려 오류로 읽혔다.
 *   반증 L-6: 'no … license' 는 줄 안에서만(최대 80자) — 예전 `no .*license` 는 길이의 제곱으로 커졌다.
 */
export function flowOutputIssue(text) {
  const s = String(text ?? '').slice(0, OUT_MAX).split(/\r?\n/).slice(0, 400)
    .filter((l) => !l.includes('|'))
    .map((l) => l.replace(/\b[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+\b/g, ' ').replace(/\b[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){7}\b/g, ' ').replace(/Name\s*:\s*\S{1,64}/g, ' '))
    .join('\n');
  if (/license/i.test(s) && /(not present|not installed|required|missing|\bno [^\n]{0,80}license)/i.test(s)) return { kind: 'license', text: 'Fabric Vision 라이선스가 없다고 장비가 답했습니다' };
  if (/command not found|not recognized|restricted|rbash/i.test(s)) return { kind: 'no-command', text: '이 계정에서 flow 명령을 쓸 수 없습니다(제한된 셸 · 명령 없음)' };
  if (/permission denied|not permitted|insufficient|RBAC/i.test(s)) return { kind: 'permission', text: '이 계정에 flow 설정 권한이 없습니다' };
  if (/already exists|duplicate/i.test(s)) return { kind: 'exists', text: '같은 이름 · 정의의 플로우가 이미 있습니다' };
  if (/does not exist|not found|no such flow/i.test(s)) return { kind: 'missing', text: '그 플로우가 장비에 없습니다' };
  if (/\berror\b|failed|invalid/i.test(s)) return { kind: 'error', text: '장비가 오류를 답했습니다' };
  return null;
}

/** '1.2g' · '345k' · '12' · '1,234' → 수(못 읽으면 null). */
export function countOf(v) {
  const m = /^\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*([kmgt])?\s*$/i.exec(String(v ?? '').slice(0, 40));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  const mul = { k: 1e3, m: 1e6, g: 1e9, t: 1e12 }[String(m[2] || '').toLowerCase()] || 1;
  return Number.isFinite(n) ? Math.round(n * mul) : null;
}

/**
 * `flow --show <name>` 출력 판독(관용 — 형식 미확인). 표 머리줄('|' 로 나뉜 칸에 Frames · Bytes 가 있는 줄)과 다음 값 줄을 짝지어
 *   Rx/Tx 프레임 · 바이트 · 처리량을 찾는다. 이름 · 활성 여부도 본다. 못 찾으면 parsed:false.
 * @returns {{ parsed:boolean, name:string|null, active:boolean|null, counters:{rxFrames,txFrames,rxBytes,txBytes,rxBps,txBps}|null }}
 */
export function parseFlowShow(text) {
  const s = String(text ?? '').slice(0, OUT_MAX);
  const lines = s.split(/\r?\n/).map((l) => l.trimEnd()).slice(0, 400);
  const name = /Name\s*:\s*([A-Za-z0-9_]{1,64})/.exec(s)?.[1] || null;
  const active = /\(Activated\)|\bActive\b/i.test(s) ? true : /\(Deactivated\)|\bInactive\b/i.test(s) ? false : null;
  const counters = { rxFrames: null, txFrames: null, rxBytes: null, txBytes: null, rxBps: null, txBps: null };
  let found = false;
  for (let i = 0; i < lines.length - 1; i++) {
    const head = lines[i];
    if (!head.includes('|') || !/frames?/i.test(head) || !/bytes?/i.test(head)) continue;
    const cols = head.split('|').map((c) => c.trim().toLowerCase()).filter((c, k, a) => !(c === '' && (k === 0 || k === a.length - 1)));
    let vi = i + 1;
    while (vi < lines.length && (!lines[vi].includes('|') || /^[\s|=-]*$/.test(lines[vi]))) vi += 1;
    if (vi >= lines.length) break;
    const vals = lines[vi].split('|').map((c) => c.trim()).filter((c, k, a) => !(c === '' && (k === 0 || k === a.length - 1)));
    cols.forEach((c, k) => {
      const v = countOf(vals[k]);
      if (v == null) return;
      const rx = /\brx\b|receive/.test(c); const tx = /\btx\b|transmit/.test(c);
      if (/frames?.*(count)?/.test(c) && !/sec|per/.test(c)) { if (rx) counters.rxFrames = v; else if (tx) counters.txFrames = v; }
      else if (/bytes?.*count|bytes?$/.test(c) && !/sec|per|throughput/.test(c)) { if (rx) counters.rxBytes = v; else if (tx) counters.txBytes = v; }
      else if (/throughput|bps|bytes?.*per/.test(c)) { if (rx) counters.rxBps = v; else if (tx) counters.txBps = v; }
    });
    found = Object.values(counters).some((v) => v != null);
    if (found) break;
  }
  return { parsed: found || !!name, name, active, counters: found ? counters : null };
}

/** `flow --show`(목록) — 이름들(포탈 것 · 사람이 만든 것)과 개수. 형식 미확인이라 'Name :' 줄과 표 첫 칸 둘 다 본다. */
export function parseFlowList(text) {
  const s = String(text ?? '').slice(0, OUT_MAX);
  const names = new Set();
  for (const m of s.matchAll(/Name\s*:\s*([A-Za-z0-9_]{1,64})/g)) names.add(m[1]);
  for (const line of s.split(/\r?\n/).slice(0, 2000)) {
    const m = /^\s*\|?\s*([A-Za-z][A-Za-z0-9_]{0,63})\s*\|/.exec(line);
    if (m && !/^(name|flow|feature|sys)$/i.test(m[1])) names.add(m[1]);
  }
  const list = [...names].slice(0, 600);
  return { names: list, total: list.length, portal: list.filter((n) => n.startsWith(FLOW_PREFIX)).length };
}
