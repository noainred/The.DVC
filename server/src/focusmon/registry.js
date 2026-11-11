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

const FILE = () => path.join(config.configDir, 'focusmon-targets.json');
export const MAX_TARGETS = 500;
export const NAME_RE = /^[A-Za-z0-9가-힣][A-Za-z0-9가-힣._ -]{0,63}$/;
export const USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
const AGENT_RE = /^[^\s/\\]{1,128}$/;

export const SETTING_RANGES = Object.freeze({
  retentionDays: [1, 90, 30], capGb: [1, 2000, 20], warnPct: [50, 99, 80], critPct: [51, 100, 90], wAwaitWarnMs: [1, 10000, 20],
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
    username: s(t.username, 32), agent: s(t.agent, 128), enabled: t.enabled !== false,
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
  return out;
}

function load() {
  if (cache) return cache;
  try {
    if (fs.existsSync(FILE())) {
      const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      const list = filterObjectElements(Array.isArray(j?.targets) ? j.targets : []).list.map(normTarget).filter(Boolean);
      cache = { targets: list, settings: normSettings(j?.settings) };
    }
  } catch (e) { preserveCorrupt(FILE(), e?.message); loadErr.set(e); cache = null; }
  if (!cache) { loadErr.checkCorruptOnly(FILE()); cache = { targets: [], settings: normSettings() }; }
  return cache;
}

function persist(next) {
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
  return { ok: true, value: { name, host, port, username, agent: canonAgent || '', enabled: body.enabled !== false } };
}

const sameEndpoint = (a, b) => a.host === b.host && a.port === b.port && a.username === b.username && String(a.agent).toLowerCase() === String(b.agent).toLowerCase();

export function addTarget(body, { agents = [], by = '' } = {}) {
  const w = writeRefusal(); if (w) return w;
  const c = checkTargetInput(body, { agents });
  if (!c.ok) return c;
  const cur = load();
  if (cur.targets.length >= MAX_TARGETS) return { ok: false, code: 'too-many', reason: `등록은 ${MAX_TARGETS}대까지입니다.` };
  if (cur.targets.some((t) => sameEndpoint(t, c.value))) return { ok: false, code: 'duplicate', reason: '같은 노드 · 주소 · 포트 · 계정의 대상이 이미 있습니다.' };
  const t = { id: `fm-${crypto.randomBytes(5).toString('hex')}`, ...c.value, createdAt: Date.now(), createdBy: s(by, 64) };
  persist({ ...cur, targets: [...cur.targets, t] });
  return { ok: true, target: { ...t } };
}

export function updateTarget(id, body, { agents = [] } = {}) {
  const w = writeRefusal(); if (w) return w;
  const cur = load();
  const i = cur.targets.findIndex((t) => t.id === String(id));
  if (i < 0) return { ok: false, code: 'not-found', reason: '없는 대상입니다.' };
  const c = checkTargetInput({ ...cur.targets[i], ...body }, { agents });
  if (!c.ok) return c;
  if (cur.targets.some((t, j) => j !== i && sameEndpoint(t, c.value))) return { ok: false, code: 'duplicate', reason: '같은 노드 · 주소 · 포트 · 계정의 대상이 이미 있습니다.' };
  const next = { ...cur.targets[i], ...c.value };
  const targets = cur.targets.slice(); targets[i] = next;
  persist({ ...cur, targets });
  return { ok: true, target: { ...next }, moved: !sameEndpoint(cur.targets[i], next) };
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

/**
 * CSV 가져오기(이름,IP,포트,계정,담당 노드) — 줄마다 검사하고 **전부 맞을 때만** 한 번에 넣는다(일부만 들어가 반쯤 바뀐 등록부를 만들지 않는다).
 * 첫 줄이 머리글이면 건너뛴다. 상한 200줄.
 */
export function importCsv(text, { agents = [], by = '' } = {}) {
  const w = writeRefusal(); if (w) return w;
  const lines = String(text || '').slice(0, 200_000).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length && /^(이름|name)\s*,/i.test(lines[0])) lines.shift();
  if (!lines.length) return { ok: false, code: 'empty', reason: '가져올 줄이 없습니다.' };
  if (lines.length > 200) return { ok: false, code: 'too-many', reason: '한 번에 200줄까지 가져옵니다.' };
  const cur = load();
  const adds = []; const errors = [];
  lines.forEach((l, i) => {
    const f = l.split(',').map((x) => x.trim().replace(/^"(.*)"$/, '$1'));
    const agentRaw = f[4] || '';
    const c = checkTargetInput({ name: f[0], host: f[1], port: f[2] || 22, username: f[3], agent: /^(중앙|central)$/i.test(agentRaw) ? '' : agentRaw }, { agents });
    if (!c.ok) { errors.push({ line: i + 1, code: c.code, reason: c.reason }); return; }
    if ([...cur.targets, ...adds].some((t) => sameEndpoint(t, c.value))) { errors.push({ line: i + 1, code: 'duplicate', reason: '이미 있는 대상입니다.' }); return; }
    adds.push({ id: `fm-${crypto.randomBytes(5).toString('hex')}`, ...c.value, createdAt: Date.now(), createdBy: s(by, 64) });
  });
  if (errors.length) return { ok: false, code: 'invalid-rows', reason: `${errors.length}줄이 맞지 않아 아무것도 넣지 않았습니다.`, errors: errors.slice(0, 50) };
  if (cur.targets.length + adds.length > MAX_TARGETS) return { ok: false, code: 'too-many', reason: `등록은 ${MAX_TARGETS}대까지입니다.` };
  persist({ ...cur, targets: [...cur.targets, ...adds] });
  return { ok: true, added: adds.length };
}

export function _resetForTest() { cache = null; loadErr.clear(); }
