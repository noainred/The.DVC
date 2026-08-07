/**
 * 성능점검 배정 — 중앙이 관리하는 '어느 엣지가 어느 대상을 점검하는가'.
 *
 * 중앙(`SVCMON_ROLE=central`)은 점검을 직접 실행하지 않는다. 대신 자기 대상 트리에서 범위를
 * 잘라 엣지에 배포하고, 엣지가 그것을 자기 저장소에 적용해 실행한 뒤 결과를 밀어 올린다.
 *
 * ## 배포 태그가 24자여야 하는 이유 (실측)
 * 엣지에서 정의를 교체할 때 `deleteTargetsByBatch('central:<sig>')` 로 이전 배포분을 지운다.
 * 그런데 store 는 `batch` 를 **40자로 자른다.** 48자 태그(`central:` + sha1 40자)를 쓰면
 * 저장된 값과 조회 값이 달라져 삭제가 **0건**이 되고, 이어지는 등록은 중복 이름으로
 * `skip` 되므로(dedup) **정의가 영구히 갱신되지 않는다.** 그래서 sig 를 16자로 자른다
 * (`central:` 8 + 16 = 24자).
 *
 * ## handoff — 중앙이 '배포했다'고 믿는 조건
 * 배포만으로 성공을 단정하지 않는다. `bulkAddTargets` 는 상한·검증 실패에 예외를 던지지 않고
 * `{committed:false, added:0}` 을 돌려주고, 중복 이름은 조용히 skip 된다. 그래서 엣지가
 * **ack 로 적용 결과를 회신**해야 `active` 로 전이한다(그전엔 `pending`).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { logAudit } from '../audit.js';

const FILE = () => path.join(config.configDir, 'central-svcmon-assign.json');

export const MAX_AGENTS = 128;
export const MAX_TARGETS_PER_AGENT = 20000;
/** 배포 태그 접두사 + sig 길이 — store 의 batch 40자 상한 안에 반드시 들어가야 한다. */
export const TAG_PREFIX = 'central:';
export const SIG_LEN = 16;
export const batchTag = (sig) => `${TAG_PREFIX}${String(sig || '').slice(0, SIG_LEN)}`;

/**
 * 엣지에서 실행 의미가 달라지거나 불가능한 유형의 기본 제외 목록.
 * - `trace`: traceroute/tracert 가 없거나 막힌 컨테이너·Windows 에서 전면 실패한다.
 * - `domain`: whois(TCP 43) 로 **외부 인터넷**에 나가야 한다. 폐쇄망 엣지에서 전면 실패하고,
 *   측정값이 '남은 일수'라 관측 위치가 판정에 영향을 주지 않으므로 굳이 옮길 이득이 없다.
 * 관리자가 배정별로 해제할 수 있다.
 */
export const DEFAULT_EXCEPT_TYPES = ['trace', 'domain'];

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    const agents = parsed && typeof parsed.agents === 'object' && !Array.isArray(parsed.agents)
      ? parsed.agents : null;
    if (!agents) throw new Error('agents 가 객체가 아닙니다(형식 불일치)');
    cache = { v: 1, agents: Object.assign(Object.create(null), agents) };
  } catch (e) {
    // 파싱 실패든 형식 불일치든 **똑같이 보존한다.** 한쪽만 보존하면 온전했던 배정이
    // 다음 저장에 조용히 덮여 사라진다(CLAUDE.md 의 로드 손상 보존 비대칭 규칙).
    if (e.code !== 'ENOENT') preserveCorrupt(FILE(), e?.message);
    cache = { v: 1, agents: Object.create(null) };
  }
  return cache;
}

function save() {
  atomicWriteFileSync(FILE(), JSON.stringify(cache));
}

const sigOf = (obj) => crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, SIG_LEN);

/** 배포 대상으로 실을 수 있는 모양만 남긴다(엣지 store 가 받는 입력 형태). */
function slimTarget(t, exceptTypes) {
  const skip = new Set(exceptTypes || []);
  const tests = (t.tests || [])
    .filter((x) => !skip.has(x.type))
    .map((x) => {
      const { id, ...rest } = x;      // 엣지가 자기 id 를 새로 발급한다(중앙 id 를 강요하지 않는다)
      return rest;
    });
  return {
    kind: t.kind, path: t.path, name: t.name, host: t.host,
    enabled: t.enabled !== false,
    tests,
  };
}

/**
 * 배정 저장 — 중앙 대상 목록에서 범위를 잘라 스냅샷으로 굳힌다.
 * 스냅샷을 굳히는 이유: 중앙 트리를 편집하는 중간 상태가 엣지로 새는 것을 막고, sig 로
 * '무엇을 배포했는지'를 명확히 고정하기 위해서다.
 *
 * @param {string} agent
 * @param {{kind?:string, path?:string, includeSub?:boolean, exceptTypes?:string[], note?:string}} scope
 * @param {object[]} targets  중앙 store 의 대상 목록(호출부가 이미 범위 필터를 적용해 넘긴다)
 */
export function setAssignment(agent, scope = {}, targets = [], { user = '' } = {}) {
  const name = String(agent || '').trim();
  if (!name) throw new Error('엣지 이름이 필요합니다.');
  const db = load();
  if (!db.agents[name] && Object.keys(db.agents).length >= MAX_AGENTS) {
    throw new Error(`배정 가능한 엣지는 최대 ${MAX_AGENTS}개입니다.`);
  }
  if (targets.length > MAX_TARGETS_PER_AGENT) {
    throw new Error(`엣지 1개에 배정할 대상은 최대 ${MAX_TARGETS_PER_AGENT}개입니다(요청 ${targets.length}개).`);
  }
  const exceptTypes = Array.isArray(scope.exceptTypes) ? scope.exceptTypes.filter((x) => typeof x === 'string') : DEFAULT_EXCEPT_TYPES;
  const list = targets.map((t) => slimTarget(t, exceptTypes));
  let tests = 0;
  for (const t of list) tests += t.tests.length;

  const body = { exceptTypes, targets: list };
  const sig = sigOf(body);
  const prev = db.agents[name] || null;
  db.agents[name] = {
    sig,
    prevSig: prev && prev.sig !== sig ? prev.sig : (prev?.prevSig || ''),
    scope: {
      kind: scope.kind || '', path: scope.path || '',
      includeSub: scope.includeSub !== false, note: String(scope.note || '').slice(0, 200),
    },
    exceptTypes,
    targets: list,
    counts: { targets: list.length, tests },
    updatedAt: Date.now(),
    updatedBy: user,
    // handoff — 엣지가 ack 하기 전에는 pending 이다(배포만으로 성공을 단정하지 않는다).
    state: prev && prev.sig === sig ? (prev.state || 'pending') : 'pending',
    pulledAt: prev && prev.sig === sig ? (prev.pulledAt || 0) : 0,
    ack: prev && prev.sig === sig ? (prev.ack || null) : null,
  };
  save();
  logAudit({
    user, action: 'svcmon.assign.set', target: name,
    detail: `대상 ${list.length} · 점검 ${tests} · sig ${sig}${exceptTypes.length ? ` · 제외 ${exceptTypes.join(',')}` : ''}`,
  });
  return db.agents[name];
}

export function deleteAssignment(agent, { user = '' } = {}) {
  const db = load();
  const name = String(agent || '').trim();
  if (!db.agents[name]) return false;
  const c = db.agents[name].counts || {};
  delete db.agents[name];
  save();
  logAudit({ user, action: 'svcmon.assign.delete', target: name, detail: `대상 ${c.targets || 0} · 점검 ${c.tests || 0}` });
  return true;
}

/** 목록 — 대상 배열은 크므로 요약만 돌려준다(화면·목록용). */
export function listAssignments() {
  const db = load();
  return Object.keys(db.agents).sort().map((name) => {
    const a = db.agents[name];
    return {
      agent: name, sig: a.sig, prevSig: a.prevSig || '', scope: a.scope, exceptTypes: a.exceptTypes,
      counts: a.counts, updatedAt: a.updatedAt, updatedBy: a.updatedBy,
      state: a.state, pulledAt: a.pulledAt || 0, ack: a.ack || null,
      tag: batchTag(a.sig),
    };
  });
}

/** 엣지가 pull 할 때 쓰는 전문(全文). sig 가 같으면 본문을 보내지 않는다(WAN 절약). */
export function getAssignmentForAgent(agent, knownSig = '') {
  const db = load();
  const a = db.agents[String(agent || '').trim()];
  if (!a) return { assigned: false, sig: '', unchanged: false, exceptTypes: [], targets: [] };
  if (knownSig && knownSig === a.sig) {
    return { assigned: true, sig: a.sig, unchanged: true, exceptTypes: a.exceptTypes, targets: [], counts: a.counts };
  }
  return {
    assigned: true, sig: a.sig, prevSig: a.prevSig || '', unchanged: false,
    exceptTypes: a.exceptTypes, targets: a.targets, counts: a.counts,
    tag: batchTag(a.sig), prevTag: a.prevSig ? batchTag(a.prevSig) : '',
  };
}

export function markPulled(agent, sig) {
  const db = load();
  const a = db.agents[String(agent || '').trim()];
  if (!a || a.sig !== sig) return false;
  a.pulledAt = Date.now();
  save();
  return true;
}

/**
 * 엣지 적용 결과 회신. **이것이 handoff 활성 조건이다.**
 * 적용 수가 배포 수와 다르면 `state` 를 `mismatch` 로 두고 그대로 노출한다 — 조용히
 * 성공으로 넘기면 감시 공백이 정상으로 보인다.
 */
export function ackAssignment(agent, { sig, applied = {}, removed = 0, errors = [] } = {}) {
  const db = load();
  const name = String(agent || '').trim();
  const a = db.agents[name];
  if (!a) return { ok: false, reason: '배정이 없습니다.' };
  if (a.sig !== sig) return { ok: false, reason: `sig 불일치(현재 ${a.sig}) — 다시 pull 하세요.`, sig: a.sig };
  const added = Number(applied.added) || 0;
  const tests = Number(applied.newTests) || 0;
  const want = a.counts || { targets: 0, tests: 0 };
  const exact = added === want.targets && tests === want.tests;
  a.ack = { at: Date.now(), added, tests, removed: Number(removed) || 0, errors: (errors || []).slice(0, 20), exact };
  a.state = (errors && errors.length) ? 'error' : (exact ? 'active' : 'mismatch');
  save();
  logAudit({
    user: `agent:${name}`, action: 'svcmon.assign.ack', target: name,
    detail: `sig ${sig} · 적용 ${added}/${want.targets} 대상 · ${tests}/${want.tests} 점검 · 삭제 ${removed} · ${a.state}`,
  });
  return { ok: true, state: a.state, exact };
}

export function _resetAssignCache() { cache = null; }
