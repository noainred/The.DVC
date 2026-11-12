/**
 * focusmon/registry.js — 집중 모니터링 **대상 서버 등록부 + 설정**(v2.976). 파일 `CONFIG_DIR/focusmon-targets.json`.
 *
 * 대상: { id, name, host(IPv4), port, username, agent(''=중앙 직접 · 엣지 이름), enabled, createdAt, createdBy }
 *  · **비밀 필드가 없다** — 접속은 담당 노드가 스스로 만든 SSH 키로 한다(util/sshKeyStore.js). 비밀번호 · 개인키를 받지도 저장하지도 않는다.
 *  · host 는 **정규 IPv4 만**(사용자 요청 ‘IP ssh key less 로그인’). 루프백 · 링크로컬 · 우회 표기는 등록 단계에서 거부(SSRF 정적 가드 `ipBlockReason`).
 *    사내망(RFC1918)은 대상이라 허용한다.
 *  · agent 는 수집 서버 등록부에 있는 이름만(호출부가 목록을 넘긴다 — 이 모듈은 등록부를 import 하지 않는다).
 *  · 같은 (노드, 주소, 포트, 계정)은 하나만.
 * 설정: { retentionDays(1~90 · 30), capGb(1~2000 · 20), warnPct(50~99 · 80), critPct(51~100 · 90), wAwaitWarnMs(1~10000 · 20) }
 *
 * 등록부 규약(server/CLAUDE.md): 원자적 쓰기(0600) · 로드 손상 preserveCorrupt + 손상이면 **쓰기를 거절**(빈 등록부로 덮지 않게) ·
 * 객체 원소만(util/registryCore.js). 못 읽었으면 라우트가 503(registryUnreadable) 이다 — 빈 목록을 200 으로 내지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { makeLoadError, filterObjectElements } from '../util/registryCore.js';
import { strictIpv4Num } from '../util/ipv4.js';
import { ipBlockReason } from '../util/ssrfBlock.js';
import { parseCsvRows, unguardCell } from '../util/csv.js';
import { normProcEvery } from './script.js';

const FILE = () => path.join(config.configDir, 'focusmon-targets.json');
export const MAX_TARGETS = 500;
export const NAME_RE = /^[A-Za-z0-9가-힣][A-Za-z0-9가-힣._ -]{0,63}$/;
export const USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
/** 서버 그룹(v2.982 — 사용자 '등록된 서버를 그룹별로 분류해서 보는 기능'): 서버마다 하나(폴더) · '' = 그룹 없음 · 이름은 서버 이름과 같은 글자 1~32자 · 최대 50개. */
export const GROUP_RE = /^[A-Za-z0-9가-힣][A-Za-z0-9가-힣._ -]{0,31}$/;
export const MAX_GROUPS = 50;
// 32자를 넘는 이름은 자르지 않고 버린다(만들기 · 수정의 거절과 같은 규칙 — 잘라 쓰면 앞 32자가 같은 두 이름이 한 그룹이 된다)
const normGroup = (v) => { const g = typeof v === 'string' ? v.trim().slice(0, 64) : ''; return GROUP_RE.test(g) ? g : ''; };
const AGENT_RE = /^[^\s/\\]{1,128}$/;

export const SETTING_RANGES = Object.freeze({
  retentionDays: [1, 90, 30], capGb: [1, 2000, 20], warnPct: [50, 99, 80], critPct: [51, 100, 90], wAwaitWarnMs: [1, 10000, 20],
  // v2.978: 맡은 서버가 있는 엣지가 쉬는 동안 중앙을 조회하는 주기(초) — 깨우기가 닿지 않는 중계 엣지의 시작 지연(예전 30초 고정)
  edgeIdleSec: [5, 60, 10],
  // v2.983 수집 부하(시안 ⑪ 컨펌 ③ ④): 판정 문턱(코어 1개 기준 % — 가벼움 < 주의 ≤ 보통 < 큼) · 프로세스 표본 주기(초 — 5 · 15 · 30 중 하나, script.PROC_EVERY_CHOICES)
  loadWarnPct: [1, 50, 1], loadCritPct: [2, 100, 3], procEvery: [5, 30, 5],
});
export const DEFAULT_SETTINGS = Object.freeze(Object.fromEntries(Object.entries(SETTING_RANGES).map(([k, v]) => [k, v[2]])));

let cache = null;
const loadErr = makeLoadError();
export function registryLoadError() { load(); return loadErr.get(); }

const s = (v, max = 256) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim().slice(0, max);

function normTarget(t) {
  const id = s(t.id, 40);
  if (!/^fm-[a-f0-9]{8,16}$/.test(id)) return null;
  const port = Number(t.port);
  return {
    id, name: s(t.name, 64), host: s(t.host, 15), port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 22,
    username: s(t.username, 32), agent: s(t.agent, 128), enabled: t.enabled !== false, group: normGroup(t.group),
    createdAt: Number(t.createdAt) > 0 ? Number(t.createdAt) : 0, createdBy: s(t.createdBy, 64),
  };
}

function normSettings(x = {}) {
  const out = {};
  for (const [k, [lo, hi, def]] of Object.entries(SETTING_RANGES)) {
    const n = Number(x?.[k]);
    out[k] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def;
  }
  if (out.critPct <= out.warnPct) out.critPct = Math.min(100, out.warnPct + 1);
  if (out.loadCritPct <= out.loadWarnPct) out.loadCritPct = Math.min(100, out.loadWarnPct + 1);
  out.procEvery = normProcEvery(out.procEvery); // 5 · 15 · 30 밖(예 10)은 기본 5초 — 원격 명령은 미리 만든 상수 표에서만 고른다
  return out;
}

function load() {
  if (cache) return cache;
  try {
    if (fs.existsSync(FILE())) {
      const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      const list = filterObjectElements(Array.isArray(j?.targets) ? j.targets : []).list.map(normTarget).filter(Boolean);
      cache = { targets: list, settings: normSettings(j?.settings), groups: withUsedGroups(Array.isArray(j?.groups) ? j.groups : [], list) };
    }
  } catch (e) { preserveCorrupt(FILE(), e?.message); loadErr.set(e); cache = null; }
  if (!cache) { loadErr.checkCorruptOnly(FILE()); cache = { targets: [], settings: normSettings(), groups: [] }; }
  return cache;
}

/** 그룹 목록 = 저장된 순서(빈 그룹 포함) + 서버가 쓰는데 목록에 없는 이름(뒤에) — 대소문자를 무시해 겹치지 않게. */
function withUsedGroups(list, targets) {
  const out = []; const seen = new Set();
  const add = (g) => { const n = normGroup(g); const k = n.toLowerCase(); if (n && !seen.has(k)) { seen.add(k); out.push(n); } };
  for (const g of list) add(g);
  for (const t of targets) add(t.group);
  return out;
}
function persist(next) {
  next = { ...next, groups: withUsedGroups(next.groups || [], next.targets || []) };
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  atomicWriteFileSync(FILE(), JSON.stringify(next, null, 2), { mode: 0o600 });
  cache = next;
  loadErr.clear();
}

/** 쓰기 전 확인 — 손상 · 보존본만 남은 상태면 쓰지 않는다(빈 등록부로 덮어 보존본의 대상이 영영 끊기지 않게). */
function writeRefusal() {
  load();
  const e = loadErr.get();
  return e ? { ok: false, code: 'registry-unreadable', reason: '집중 모니터링 등록부(focusmon-targets.json)를 읽지 못해 저장하지 않았습니다 — 손상 보존본을 확인하세요.' } : null;
}

export function listTargets() { return load().targets.map((t) => ({ ...t })); }
export function getTarget(id) { const t = load().targets.find((x) => x.id === String(id)); return t ? { ...t } : null; }
export function getSettings() { return { ...load().settings }; }

/**
 * 입력 검사(순수에 가깝다 — 알려진 엣지 이름 목록을 받는다).
 * @returns {{ok:true, value:object} | {ok:false, code:string, field?:string, reason:string}}
 */
export function checkTargetInput(body = {}, { agents = [] } = {}) {
  const name = s(body.name, 64);
  const host = s(body.host, 64);
  const username = s(body.username, 64);
  const agent = s(body.agent, 128);
  const port = body.port == null || body.port === '' ? 22 : Number(body.port);
  if (!NAME_RE.test(name)) return { ok: false, code: 'bad-name', field: 'name', reason: '표시 이름은 글자 · 숫자 · 공백 · . _ - 로 1~64자입니다.' };
  if (typeof strictIpv4Num(host) !== 'number') return { ok: false, code: 'bad-host', field: 'host', reason: 'IP 주소는 IPv4 정규 표기(예 10.48.20.11)만 받습니다 — 호스트 이름 · 0 으로 시작하는 칸 · IPv6 는 받지 않습니다.' };
  const block = ipBlockReason(host);
  if (block) return { ok: false, code: 'blocked-host', field: 'host', reason: `이 주소에는 접속하지 않습니다(${block}).` };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, code: 'bad-port', field: 'port', reason: 'SSH 포트는 1~65535 입니다.' };
  if (!USER_RE.test(username)) return { ok: false, code: 'bad-user', field: 'username', reason: '계정은 영문 · 숫자 · _ . - 로 1~32자이고 글자나 _ 로 시작합니다.' };
  if (agent && (!AGENT_RE.test(agent) || !agents.some((a) => String(a).toLowerCase() === agent.toLowerCase()))) {
    return { ok: false, code: 'bad-agent', field: 'agent', reason: '담당 노드는 중앙 또는 등록된 엣지(수집 서버) 이름만 고를 수 있습니다.' };
  }
  const canonAgent = agent ? agents.find((a) => String(a).toLowerCase() === agent.toLowerCase()) : '';
  // 그룹(v2.982): 없으면 '' · 글자 규칙만 본다(없는 이름이면 저장할 때 목록에 더한다 — 상한은 쓰는 쪽이 groupRefusal 로)
  const group = s(body.group, 64);
  if (group && !GROUP_RE.test(group)) return { ok: false, code: 'bad-group', field: 'group', reason: '그룹 이름은 글자 · 숫자 · 공백 · . _ - 로 1~32자입니다.' };
  return { ok: true, value: { name, host, port, username, agent: canonAgent || '', enabled: body.enabled !== false, group } };
}

const sameEndpoint = (a, b) => a.host === b.host && a.port === b.port && a.username === b.username && String(a.agent).toLowerCase() === String(b.agent).toLowerCase();

/** 새 그룹 이름을 더하면 상한을 넘는지(대소문자 무시) — 넘으면 거절 사유. */
function groupRefusal(cur, names) {
  const have = new Set((cur.groups || []).map((g) => g.toLowerCase()));
  const fresh = new Set(names.filter(Boolean).map((g) => g.toLowerCase()).filter((g) => !have.has(g)));
  return have.size + fresh.size > MAX_GROUPS ? { ok: false, code: 'too-many-groups', field: 'group', reason: `그룹은 ${MAX_GROUPS}개까지입니다.` } : null;
}
/** 이미 있는 그룹이면 그 표기(대소문자)로 맞춘다 — 'db' 와 'DB' 가 두 그룹이 되지 않게. */
function canonGroup(cur, g) {
  if (!g) return '';
  return (cur.groups || []).find((x) => x.toLowerCase() === g.toLowerCase()) || g;
}

/** 그룹 목록 + 서버 수(등록부 기준 · 순서 = 만든 순서). */
export function listGroups() {
  const cur = load();
  return (cur.groups || []).map((name) => ({ name, n: cur.targets.filter((t) => t.group === name).length }));
}
export function createGroup(name) {
  const w = writeRefusal(); if (w) return w;
  const g = s(name, 64);
  if (!GROUP_RE.test(g)) return { ok: false, code: 'bad-group', reason: '그룹 이름은 글자 · 숫자 · 공백 · . _ - 로 1~32자입니다.' };
  const cur = load();
  if ((cur.groups || []).some((x) => x.toLowerCase() === g.toLowerCase())) return { ok: false, code: 'duplicate', reason: '같은 이름의 그룹이 이미 있습니다.' };
  const r = groupRefusal(cur, [g]); if (r) return r;
  persist({ ...cur, groups: [...(cur.groups || []), g] });
  return { ok: true, group: g };
}
/** 이름 바꾸기 — 그 그룹의 서버도 함께. 다른 그룹과 같은 이름이면 거절(합치기는 '옮기기' 로). */
export function renameGroup(from, to) {
  const w = writeRefusal(); if (w) return w;
  const cur = load();
  const old = (cur.groups || []).find((x) => x === s(from, 64));
  if (!old) return { ok: false, code: 'not-found', reason: '없는 그룹입니다.' };
  const g = s(to, 64);
  if (!GROUP_RE.test(g)) return { ok: false, code: 'bad-group', reason: '그룹 이름은 글자 · 숫자 · 공백 · . _ - 로 1~32자입니다.' };
  if (g === old) return { ok: true, group: g, moved: 0 };
  if ((cur.groups || []).some((x) => x !== old && x.toLowerCase() === g.toLowerCase())) return { ok: false, code: 'duplicate', reason: '같은 이름의 그룹이 이미 있습니다 — 서버를 그 그룹으로 옮기려면 ‘옮기기’ 를 쓰세요.' };
  let moved = 0;
  const targets = cur.targets.map((t) => { if (t.group !== old) return t; moved += 1; return { ...t, group: g }; });
  persist({ ...cur, targets, groups: (cur.groups || []).map((x) => (x === old ? g : x)) });
  return { ok: true, group: g, moved };
}
/** 지우기 — 그 그룹의 서버는 '그룹 없음' 으로(서버 · 기록은 그대로). */
export function deleteGroup(name) {
  const w = writeRefusal(); if (w) return w;
  const cur = load();
  const old = (cur.groups || []).find((x) => x === s(name, 64));
  if (!old) return { ok: false, code: 'not-found', reason: '없는 그룹입니다.' };
  let freed = 0;
  const targets = cur.targets.map((t) => { if (t.group !== old) return t; freed += 1; return { ...t, group: '' }; });
  persist({ ...cur, targets, groups: (cur.groups || []).filter((x) => x !== old) });
  return { ok: true, freed };
}
/** 서버 옮기기 — ids(등록부에 있는 것만)를 group 으로('' = 그룹 없음). 그룹은 있어야 한다(새 그룹은 먼저 만든다). 접속처는 바뀌지 않는다. */
export function setTargetsGroup(ids = [], group = '') {
  const w = writeRefusal(); if (w) return w;
  const cur = load();
  const g = s(group, 64);
  const name = g ? (cur.groups || []).find((x) => x === g) : '';
  if (g && !name) return { ok: false, code: 'not-found', reason: '없는 그룹입니다 — 먼저 만드세요.' };
  const want = new Set((Array.isArray(ids) ? ids : []).map(String).slice(0, MAX_TARGETS));
  let moved = 0; let same = 0;
  const targets = cur.targets.map((t) => { if (!want.has(t.id)) return t; if (t.group === name) { same += 1; return t; } moved += 1; return { ...t, group: name }; });
  const missing = want.size - moved - same;
  if (moved) persist({ ...cur, targets });
  return { ok: true, moved, same, missing, group: name };
}

export function addTarget(body, { agents = [], by = '' } = {}) {
  const w = writeRefusal(); if (w) return w;
  const c = checkTargetInput(body, { agents });
  if (!c.ok) return c;
  const cur = load();
  if (cur.targets.length >= MAX_TARGETS) return { ok: false, code: 'too-many', reason: `등록은 ${MAX_TARGETS}대까지입니다.` };
  if (cur.targets.some((t) => sameEndpoint(t, c.value))) return { ok: false, code: 'duplicate', reason: '같은 노드 · 주소 · 포트 · 계정의 대상이 이미 있습니다.' };
  const gr = groupRefusal(cur, [c.value.group]); if (gr) return gr;
  const t = { id: `fm-${crypto.randomBytes(5).toString('hex')}`, ...c.value, group: canonGroup(cur, c.value.group), createdAt: Date.now(), createdBy: s(by, 64) };
  persist({ ...cur, targets: [...cur.targets, t] });
  return { ok: true, target: { ...t } };
}

/** 등록 수정(v2.980)이 비교하는 칸 — 화면(web focusMonText.js EDIT_FIELDS)과 같은 목록 · 순서(테스트가 대조). */
export const EDIT_FIELDS = Object.freeze(['name', 'host', 'port', 'username', 'agent', 'group']);
/**
 * 바뀐 칸 — 감사 기록 · 응답용(순수). 담당 노드는 대소문자를 무시한다(sameEndpoint 와 같게 — 입력 검사가 아는 이름으로 맞춘다).
 * @returns {{k:string, from:string|number, to:string|number}[]}
 */
export function targetChanges(before = {}, after = {}) {
  const out = [];
  for (const k of EDIT_FIELDS) {
    const a = before?.[k] ?? ''; const b = after?.[k] ?? '';
    const same = k === 'agent' ? String(a).toLowerCase() === String(b).toLowerCase() : String(a) === String(b);
    if (!same) out.push({ k, from: a, to: b });
  }
  return out;
}

/**
 * 등록 수정 — 같은 id 를 고친다(기록은 id 로 이어진다). 바뀐 것이 없으면 쓰지 않는다.
 * moved = 접속처(주소 · 포트 · 계정 · 담당 노드)가 바뀜 → 라우트가 예전 접속처의 상태 · 시험 결과를 지우고 다시 맞춘다(service.targetEndpointChanged).
 * 인증 정지는 지우지 않는다 — 정지 기록이 접속처 + 키 지문 해시라 접속처가 바뀌면 저절로 맞지 않는다(v2.978 ④ 와 같은 규칙).
 */
export function updateTarget(id, body, { agents = [] } = {}) {
  const w = writeRefusal(); if (w) return w;
  const cur = load();
  const i = cur.targets.findIndex((t) => t.id === String(id));
  if (i < 0) return { ok: false, code: 'not-found', reason: '없는 대상입니다.' };
  const c = checkTargetInput({ ...cur.targets[i], ...body }, { agents });
  if (!c.ok) return c;
  if (cur.targets.some((t, j) => j !== i && sameEndpoint(t, c.value))) return { ok: false, code: 'duplicate', reason: '같은 노드 · 주소 · 포트 · 계정의 대상이 이미 있습니다.' };
  const gr = groupRefusal(cur, [c.value.group]); if (gr) return gr;
  const before = cur.targets[i];
  const next = { ...before, ...c.value, group: canonGroup(cur, c.value.group) };
  const changes = targetChanges(before, next);
  if (!changes.length && next.enabled === before.enabled) return { ok: true, target: { ...before }, moved: false, changes: [] };
  const targets = cur.targets.slice(); targets[i] = next;
  persist({ ...cur, targets });
  return { ok: true, target: { ...next }, before: { ...before }, moved: !sameEndpoint(before, next), changes };
}

export function removeTarget(id) {
  const w = writeRefusal(); if (w) return w;
  const cur = load();
  if (!cur.targets.some((t) => t.id === String(id))) return { ok: false, code: 'not-found', reason: '없는 대상입니다.' };
  persist({ ...cur, targets: cur.targets.filter((t) => t.id !== String(id)) });
  return { ok: true };
}

export function saveSettings(body = {}) {
  const w = writeRefusal(); if (w) return w;
  const cur = load();
  const next = normSettings({ ...cur.settings, ...body });
  const changed = Object.keys(next).filter((k) => next[k] !== cur.settings[k]);
  if (changed.length) persist({ ...cur, settings: next });
  return { ok: true, settings: { ...next }, changed };
}

/* ── CSV 대량 등록(v2.978 — 사용자 'Csv 대량 서버 등록') ─────────────────────────────────────────────
 *  · 미리보기(planCsv)와 적용(applyCsv)을 나눈다 — 적용은 **본문을 다시 계획**한다(화면이 보낸 계획을 믿지 않는다).
 *  · 줄마다 add(새로) · update(같은 IP · 포트가 이미 있음 → 이름 · 계정 · 담당 노드를 바꿈) · same(바뀐 것 없음) · error.
 *    같은 IP · 포트의 대상이 둘 이상이면(계정 · 노드가 다른 등록) 어느 것을 바꿀지 모르므로 오류로 둔다. 같은 파일 안 같은 IP · 포트도 뒤 줄이 오류.
 *  · 적용 방식: 'valid'(맞는 줄만) · 'all'(오류가 하나라도 있으면 아무것도 넣지 않는다). 한 번에 MAX_TARGETS 줄 · 등록 상한도 MAX_TARGETS.
 *  · 파서는 util/csv.js parseCsvRows(따옴표 · 탭 · BOM · 스캔 중 상한) + unguardCell(내보내기의 수식 가드 '=' 앞 따옴표를 되돌린다).
 *  · 머리글이 있으면 이름으로 열을 찾는다(순서 무관) — 없으면 이름, IP, 포트, 계정, 담당 노드 순서. 담당 노드 칸의 ‘중앙’ · central · 빈 칸 = 중앙.
 */
export const CSV_MAX_ROWS = MAX_TARGETS;
export const CSV_MAX_BYTES = 200_000; // 500줄 × 줄당 최대 약 400자 — API 본문 상한(JSON) 안
/** 머리글 이름 → 필드(공백 · _ · - · 점 · 괄호를 빼고 소문자로 비교 — 'SSH Port' · 'Port No' · '포트번호' · '담당 엣지' 모두 읽는다 · 반증 4). */
const HEAD_ALIASES = Object.freeze({
  name: ['이름', '표시이름', '서버이름', '서버명', '호스트이름', '호스트명', 'name', 'displayname', 'servername', 'hostname'],
  host: ['ip', 'ip주소', '주소', '아이피', 'host', 'address', 'ipaddress', 'ipaddr', 'hostip', 'serverip'],
  port: ['포트', 'ssh포트', '포트번호', 'port', 'sshport', 'portno', 'portnumber'],
  username: ['계정', '계정명', '사용자', '사용자명', 'user', 'username', 'account', 'login', 'sshuser'],
  agent: ['담당', '담당노드', '담당엣지', '노드', '엣지', '엣지이름', 'agent', 'node', 'edge', 'collector'],
  group: ['그룹', '그룹명', '그룹이름', '분류', 'group', 'groupname'], // v2.982 — 머리글에 있을 때만 그룹을 바꾼다(없으면 그대로)
});
const headKey = (c) => String(c || '').toLowerCase().replace(/[\s_\-·.()]/g, '');
const DEFAULT_COLS = Object.freeze(['name', 'host', 'port', 'username', 'agent']);

/** 머리글 행이면 열 → 필드 표, 아니면 null. 이름 · IP 두 열이 다 있어야 머리글로 본다. */
export function csvHeaderMap(row) {
  const map = {}; const ignored = [];
  (row || []).forEach((cell, i) => {
    const c = headKey(cell);
    if (!c) return;
    const hit = Object.entries(HEAD_ALIASES).find(([k, list]) => list.includes(c) && map[k] == null);
    if (hit) map[hit[0]] = i; else ignored.push(String(cell).trim().slice(0, 40));
  });
  if (map.name == null || map.host == null) return null;
  Object.defineProperty(map, 'ignored', { value: ignored.slice(0, 20), enumerable: false });
  return map;
}
const keyOf = (host, port) => `${host}:${port}`;

/**
 * 계획 — 아무것도 쓰지 않는다.
 * @returns {{ok:true, rows:object[], counts:object, header:boolean} | {ok:false, code, reason}}
 */
export function planCsv(text, { agents = [] } = {}) {
  const raw = String(text ?? '');
  if (raw.length > CSV_MAX_BYTES) return { ok: false, code: 'too-big', reason: `CSV 는 ${Math.round(CSV_MAX_BYTES / 1000)}KB 까지 받습니다.` };
  let table;
  try { table = parseCsvRows(raw, { maxRows: CSV_MAX_ROWS + 100, maxCell: 300, keepBlank: true }); } // 빈 줄 여유 100 — 서버 줄 수는 아래에서 센다
  catch (e) { return { ok: false, code: 'bad-csv', reason: String(e?.message || e).slice(0, 200) }; }
  // 줄 번호 = 엑셀 행 번호(레코드 순번 · 머리글 포함 · 빈 줄도 센다) — 빈 줄을 거르기 **전에** 붙인다.
  table = table.map((r, i) => ({ r: Array.isArray(r) ? r : [], line: i + 1 })).filter((x) => x.r.some((c) => String(c || '').trim()));
  if (!table.length) return { ok: false, code: 'empty', reason: '가져올 줄이 없습니다.' };
  const head = csvHeaderMap(table[0].r);
  const body = head ? table.slice(1) : table;
  if (!body.length) return { ok: false, code: 'empty', reason: '머리글만 있고 서버 줄이 없습니다.' };
  if (body.length > CSV_MAX_ROWS) return { ok: false, code: 'too-many', reason: `한 번에 ${CSV_MAX_ROWS}줄까지 가져옵니다.` };
  const col = head || Object.fromEntries(DEFAULT_COLS.map((k, i) => [k, i]));
  const cur = load();
  const byKey = new Map();
  for (const t of cur.targets) { const k = keyOf(t.host, t.port); byKey.set(k, [...(byKey.get(k) || []), t]); }
  const seen = new Set();
  const rows = [];
  body.forEach(({ r, line }) => {
    const cell = (k) => (col[k] == null ? '' : unguardCell(String(r[col[k]] ?? '')).trim());
    const agentRaw = cell('agent');
    const hasGroup = col.group != null;
    const input = { name: cell('name'), host: cell('host'), port: cell('port') || 22, username: cell('username'), agent: /^(중앙|central)$/i.test(agentRaw) ? '' : agentRaw, group: hasGroup ? cell('group') : '' };
    const c = checkTargetInput(input, { agents });
    const shown = { name: input.name.slice(0, 64), host: input.host.slice(0, 64), port: String(input.port).slice(0, 8), username: input.username.slice(0, 32), agent: String(input.agent).slice(0, 128), group: String(input.group).slice(0, 64) };
    if (!c.ok) { rows.push({ line, action: 'error', code: c.code, field: c.field || null, reason: c.reason, input: shown }); return; }
    const v = { ...c.value, group: canonGroup(cur, c.value.group) };
    const k = keyOf(v.host, v.port);
    if (seen.has(k)) { rows.push({ line, action: 'error', code: 'dup-in-file', reason: '같은 파일에 같은 IP · 포트가 앞에 있습니다.', input: shown }); return; }
    seen.add(k);
    const hits = byKey.get(k) || [];
    if (hits.length > 1) { rows.push({ line, action: 'error', code: 'ambiguous', reason: `같은 IP · 포트의 대상이 ${hits.length}개 있어 어느 것을 바꿀지 모릅니다 — 화면에서 하나씩 고치세요.`, input: shown }); return; }
    if (!hits.length) { rows.push({ line, action: 'add', value: v }); return; }
    const t = hits[0];
    if (!hasGroup) v.group = t.group || ''; // 그룹 열이 없으면 그대로(v2.982 — 예전 CSV 로 갱신해도 그룹이 지워지지 않게)
    // 계정은 대소문자가 다른 계정이다(리눅스) — 노드 이름만 대소문자를 무시한다(checkTargetInput 이 정식 이름으로 바꿔 둔다).
    const changes = ['name', 'username', 'agent', 'group'].filter((f) => (f === 'agent' ? String(t[f] || '').toLowerCase() !== String(v[f] || '').toLowerCase() : String(t[f] || '') !== String(v[f] || '')));
    rows.push({ line, action: changes.length ? 'update' : 'same', id: t.id, value: v, before: { name: t.name, username: t.username, agent: t.agent, group: t.group || '' }, changes });
  });
  const counts = { add: 0, update: 0, same: 0, error: 0 };
  for (const r of rows) counts[r.action] += 1;
  // 새 그룹(목록에 없는 이름) — 미리보기가 알리고, 상한(MAX_GROUPS)을 넘으면 적용이 거절한다
  const have = new Set((cur.groups || []).map((g) => g.toLowerCase()));
  const newGroups = [...new Map(rows.filter((r) => r.action !== 'error' && r.value?.group && !have.has(r.value.group.toLowerCase())).map((r) => [r.value.group.toLowerCase(), r.value.group])).values()];
  const after = cur.targets.length + counts.add;
  // 머리글이 있는데 선택 열(포트 · 계정 · 담당 노드)을 못 찾았으면 기본값이 들어간다는 것을 말한다(조용한 기본값 금지 — 반증 4).
  const missing = head ? ['port', 'username', 'agent'].filter((k) => head[k] == null) : [];
  return { ok: true, header: !!head, rows, counts, total: rows.length, registered: cur.targets.length, max: MAX_TARGETS, overCap: after > MAX_TARGETS,
    ignored: head ? head.ignored : [], missing, groupColumn: !!(head && head.group != null), newGroups, groupsOver: have.size + newGroups.length > MAX_GROUPS, groupsMax: MAX_GROUPS };
}

/**
 * 적용 — 본문을 다시 계획하고 한 번에 쓴다(한 번의 원자적 쓰기).
 * @param {{mode?:'valid'|'all', update?:boolean}} o  update=false 면 갱신 줄은 건너뛴다(추가만).
 * @returns {{ok:true, added:number, updated:number, skipped:number, errors:number, ids:string[], moved:string[]} | {ok:false,...}}
 */
export function applyCsv(text, { agents = [], by = '', mode = 'valid', update = true } = {}) {
  const w = writeRefusal(); if (w) return w;
  const plan = planCsv(text, { agents });
  if (!plan.ok) return plan;
  if (mode === 'all' && plan.counts.error) {
    const errors = plan.rows.filter((r) => r.action === 'error').slice(0, 50).map((r) => ({ line: r.line, code: r.code, reason: r.reason }));
    return { ok: false, code: 'invalid-rows', reason: `${plan.counts.error}줄이 맞지 않아 아무것도 넣지 않았습니다(‘전부 아니면 넣지 않기’).`, counts: plan.counts, errors };
  }
  if (plan.overCap) return { ok: false, code: 'too-many', reason: `등록은 ${MAX_TARGETS}대까지입니다(지금 ${plan.registered}대 + 새로 ${plan.counts.add}대).`, counts: plan.counts };
  if (plan.groupsOver) return { ok: false, code: 'too-many-groups', reason: `그룹은 ${MAX_GROUPS}개까지입니다(새 그룹 ${plan.newGroups.length}개).`, counts: plan.counts };
  const cur = load();
  const targets = cur.targets.slice();
  const ids = []; const moved = []; let added = 0; let updated = 0;
  for (const r of plan.rows) {
    if (r.action === 'add') {
      const t = { id: `fm-${crypto.randomBytes(5).toString('hex')}`, ...r.value, createdAt: Date.now(), createdBy: s(by, 64) };
      targets.push(t); ids.push(t.id); added += 1;
    } else if (r.action === 'update' && update) {
      const i = targets.findIndex((t) => t.id === r.id);
      if (i < 0) continue;
      const next = { ...targets[i], name: r.value.name, username: r.value.username, agent: r.value.agent, group: r.value.group || '' };
      if (targets.some((t, j) => j !== i && sameEndpoint(t, next))) continue; // 다른 등록과 같은 접속처가 되면 바꾸지 않는다
      if (!sameEndpoint(targets[i], next)) moved.push(next.id);
      targets[i] = next; ids.push(next.id); updated += 1;
    }
  }
  if (added || updated) persist({ ...cur, targets });
  return { ok: true, added, updated, same: plan.counts.same, errors: plan.counts.error, skipped: plan.counts.error + (update ? 0 : plan.counts.update), ids, moved };
}

/** 예전 이름(v2.976 라우트 · 테스트) — '전부 아니면 넣지 않기' + 추가만. */
export function importCsv(text, { agents = [], by = '' } = {}) {
  const r = applyCsv(text, { agents, by, mode: 'all', update: false });
  return r.ok ? { ...r, ok: true } : r;
}

export const CSV_HEADER = Object.freeze(['이름', 'IP', '포트', '계정', '담당 노드', '그룹']);
/** 대상 목록(기본: 등록부) → CSV 줄 배열(머리글 포함 — 다시 가져올 수 있는 모양 · v2.982 그룹 열). */
export function exportRows(list = null) {
  return [[...CSV_HEADER], ...(list || load().targets).map((t) => [t.name, t.host, t.port, t.username, t.agent || '중앙', t.group || ''])];
}
/** 빈 양식 — 머리글 + 예시 한 줄(문서용 주소 192.0.2.0/24 · RFC 5737 — 실제 서버가 아니다. SSRF 가드는 이 대역을 막지 않으므로 지우지 않고 넣으면 등록된다). */
export function csvTemplateRows() {
  return [[...CSV_HEADER], ['web-01', '192.0.2.11', 22, 'dvcmon', '중앙', 'WEB']];
}

/**
 * 노드 일괄 이동 — from 노드(빈 문자열 = 중앙)의 대상 전부(또는 ids 중 from 에 속한 것)를 to 노드로. 접속처(노드)가 바뀌므로 키도 바뀐다.
 * 같은 접속처의 대상이 to 에 이미 있으면 그 대상은 건너뛴다(겹침 금지).
 */
export function moveTargets({ from = '', to = '', ids = null } = {}, { agents = [] } = {}) {
  const w = writeRefusal(); if (w) return w;
  const canon = (a) => (a ? agents.find((x) => String(x).toLowerCase() === String(a).toLowerCase()) : '');
  const f = String(from || '').slice(0, 128); const tt = String(to || '');
  // from 은 '어느 대상을 고를지' 만 정한다 — 등록부에서 빠진 엣지(노드 카드 '등록부에 없는 이름')의 서버도 옮길 수 있어야 한다(반증 2). 받는 쪽만 검사한다.
  if (tt && !canon(tt)) return { ok: false, code: 'bad-agent', reason: '받을 노드는 중앙 또는 등록된 엣지(수집 서버) 이름만 고를 수 있습니다.' };
  if (f.toLowerCase() === tt.toLowerCase()) return { ok: false, code: 'same-node', reason: '같은 노드로는 옮길 수 없습니다.' };
  const want = Array.isArray(ids) ? new Set(ids.map(String).slice(0, MAX_TARGETS)) : null;
  const cur = load();
  const targets = cur.targets.slice();
  const moved = []; let skipped = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (String(t.agent || '').toLowerCase() !== f.toLowerCase()) continue;
    if (want && !want.has(t.id)) continue;
    const next = { ...t, agent: canon(tt) || '' };
    if (targets.some((x, j) => j !== i && sameEndpoint(x, next))) { skipped += 1; continue; }
    targets[i] = next; moved.push(t.id);
  }
  if (moved.length) persist({ ...cur, targets });
  return { ok: true, moved, skipped };
}

export function _resetForTest() { cache = null; loadErr.clear(); }
