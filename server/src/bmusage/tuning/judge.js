/**
 * bmusage/tuning/judge.js — 튜닝 판정(순수 · v2.923 예정 · 리눅스 성능 4단계).
 *
 * 입력: 1단계 `tuning_json`(현재값 — 엣지 위임 서버는 중앙 정제본) · 상세 `detail_json`(NIC 드롭 증가분) · 서버 역할 · 기능 프로파일 규칙 · 관리자 덮어쓰기.
 * 출력: 항목마다 `현재 · 권장 · 누가 정했나(by) · 상태(advise|ok|info|unknown) · 사유 code · 근거 · 출처 · 등급` + 상태별 개수.
 *
 * ⚠⚠ **‘확인 불가’(unknown)는 ‘불일치’ 가 아니다** — 값을 못 읽었거나(notRead) 문서가 판단 기준을 주지 않는 것(hold)은 권고(advise)에 넣지 않는다.
 *   값이 없으면 지어내지 않는다(‘—’ 를 0 이나 기본값으로 바꾸지 않는다 — util/numOrNull 규약).
 * ⚠ 우선순위: **기능 프로파일 > 역할(관리자 덮어쓰기 > 역할 기본) > OS 기본**(PROFILES §1). rocky9-base 는 이 카탈로그를 그대로 상속한다(덮는 키 없음).
 * ⚠ 판정은 이 응답을 만드는 노드가 그 노드의 덮어쓰기 설정으로 한다 — 엣지는 튜닝을 판정해 보내지 않는다(현재값 사실만 보낸다).
 *   그래서 중앙이 엣지 판정을 ‘다시’ 하는 것이 아니다(v2.548 규약과 충돌하지 않는다 — idrac-server.md v2.923 항목).
 */
import { numOrNull } from '../../util/numOrNull.js';
import { TUNING_ITEMS, ROLES, DEFAULT_ROLE, roleRule, NO_REC, osDropSum } from './catalog.js';

const RANK = { advise: 3, unknown: 2, ok: 1, info: 0 };
const worst = (list) => list.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), list.length ? list[0] : 'info');
const str = (v) => (v == null ? null : String(v));

/** 이름 있는 규칙(카탈로그 · 프로파일의 kind:'custom'). (값 · 사실) → { status, reason? } */
export const CUSTOM_RULES = Object.freeze({
  dirtyDefault({ tu }) {
    const a = numOrNull(tu?.sysctl?.['vm.dirty_ratio']); const b = numOrNull(tu?.sysctl?.['vm.dirty_background_ratio']);
    if (a == null || b == null) return { status: 'unknown', reason: 'notRead' };
    return a === 20 && b === 10 ? { status: 'info', reason: null } : { status: 'info', reason: 'changed' };
  },
  softnet({ value }) {
    const v = numOrNull(value);
    if (v == null) return { status: 'unknown', reason: 'notRead' };
    return v === 0 ? { status: 'ok', reason: null } : { status: 'info', reason: 'cumulative' };
  },
  dropCounters({ detail }) {
    const v = osDropSum(detail);
    if (v == null) return { status: 'unknown', reason: 'notRead' };
    return v === 0 ? { status: 'ok', reason: 'noDrops' } : { status: 'unknown', reason: 'ethtoolNotRead' };
  },
  ring({ detail }) {
    const v = osDropSum(detail);
    if (v === 0) return { status: 'info', reason: 'noDrops' };
    return { status: 'unknown', reason: 'ethtoolNotRead' };
  },
  /** GPDB(G1): 64GB 초과면 dirty_background_bytes 1.5GB · dirty_bytes 4GB(ratio 0), 64GB 이하면 ratio 3 / 10. */
  gpdbDirty({ tu }) {
    const mem = numOrNull(tu?.memTotalKb);
    const s = tu?.sysctl || {};
    if (mem == null) return { status: 'unknown', reason: 'memNotRead' };
    if (mem > 64 * 1024 * 1024) {
      const bb = numOrNull(s['vm.dirty_background_bytes']); const db = numOrNull(s['vm.dirty_bytes']);
      if (bb == null || db == null) return { status: 'unknown', reason: 'notRead' };
      return bb === 1_610_612_736 && db === 4_294_967_296 ? { status: 'ok' } : { status: 'advise' };
    }
    const br = numOrNull(s['vm.dirty_background_ratio']); const dr = numOrNull(s['vm.dirty_ratio']);
    if (br == null || dr == null) return { status: 'unknown', reason: 'notRead' };
    return br === 3 && dr === 10 ? { status: 'ok' } : { status: 'advise' };
  },
  /** GPDB(G1): shmmax = 물리 메모리 절반(바이트) · shmall = shmmax ÷ PAGE_SIZE — MemTotal 기준 근사라 ±5% 안이면 적합. */
  gpdbShm({ tu }) {
    const mem = numOrNull(tu?.memTotalKb); const ps = numOrNull(tu?.os?.pageSize);
    const all = numOrNull(tu?.sysctl?.['kernel.shmall']); const max = numOrNull(tu?.sysctl?.['kernel.shmmax']);
    if (all == null || max == null) return { status: 'unknown', reason: 'notRead' };
    if (mem == null) return { status: 'unknown', reason: 'memNotRead' };
    if (ps == null || ps <= 0) return { status: 'unknown', reason: 'notRead' };
    const wantMax = (mem * 1024) / 2; const wantAll = wantMax / ps;
    const near = (v, w) => Math.abs(v - w) <= w * 0.05;
    return near(max, wantMax) && near(all, wantAll) ? { status: 'ok' } : { status: 'advise' };
  },
  /** GPDB(G1): xfs 데이터 마운트 옵션 nodev · noatime · inode64 — 시스템 마운트(gpdb.js SYSTEM_MOUNTS)는 판정에서 뺀다(참고 — 데이터 볼륨 구분 불가 · 추정). */
  gpdbXfs({ value, rule }) {
    if (!Array.isArray(value)) return { status: 'unknown', reason: 'notRead' };
    const sys = new Set(rule.systemMounts || ['/', '/boot', '/boot/efi', '/usr', '/var', '/home', '/tmp', '/opt']);
    if (!value.length) return { status: 'info', reason: 'noDevice', devices: [] };
    const need = ['nodev', 'noatime', 'inode64'];
    const per = value.slice(0, 32).map((m) => {
      const opts = Array.isArray(m?.opts) ? m.opts : [];
      if (sys.has(String(m?.mount))) return { name: String(m?.mount), value: opts.join(','), status: 'info', reason: 'systemMount' };
      return { name: String(m?.mount), value: opts.join(','), status: need.every((o) => opts.includes(o)) ? 'ok' : 'advise' };
    });
    const judged = per.filter((x) => x.status !== 'info');
    return { status: judged.length ? worst(judged.map((x) => x.status)) : 'info', reason: judged.length ? null : 'noDevice', devices: per };
  },
  gpdbRemoveIpc({ value }) {
    if (value === 'no') return { status: 'ok' };
    if (value === 'yes') return { status: 'advise' };
    return { status: 'unknown', reason: 'notExplicit' };
  },
  gpdbSelinux({ value }) {
    if (value == null) return { status: 'unknown', reason: 'notRead' };
    const v = String(value).toLowerCase();
    if (v === 'disabled' || v === 'permissive') return { status: 'ok' };
    return { status: 'unknown', reason: 'policyNotRead' };
  },
  gpdbFirewalld({ value }) {
    if (value == null) return { status: 'unknown', reason: 'notRead' };
    return value === 'not-running' ? { status: 'ok' } : { status: 'unknown', reason: 'policyNotRead' };
  },
  gpdbTimeSync({ value }) {
    if (value == null) return { status: 'unknown', reason: 'notRead' };
    return value === 'none' ? { status: 'advise' } : { status: 'ok' };
  },
});

/** 장치 · NIC 단위 규칙 하나(oneOf · eqNum · txqueuelen · channels). */
function evalUnit(rule, v, { tu }) {
  if (rule.kind === 'oneOf') return v == null ? { status: 'unknown', reason: 'notRead' } : (rule.values.includes(String(v)) ? { status: 'ok' } : { status: 'advise' });
  if (rule.kind === 'eqNum') { const n = numOrNull(v); return n == null ? { status: 'unknown', reason: 'notRead' } : (n === rule.value ? { status: 'ok' } : { status: 'advise' }); }
  if (rule.kind === 'custom' && rule.id === 'txqueuelen') {
    const n = numOrNull(v);
    if (n == null) return { status: 'unknown', reason: 'notRead' };
    if (n === (numOrNull(rule.value) ?? 1000)) return { status: 'ok' };
    return n > 20_000 ? { status: 'advise' } : { status: 'info', reason: 'changed' };
  }
  if (rule.kind === 'custom' && rule.id === 'channels') {
    const n = numOrNull(v); const cores = numOrNull(tu?.cores);
    if (n == null) return { status: 'unknown', reason: 'notRead' };
    if (cores == null) return { status: 'unknown', reason: 'coresNotRead' };
    return n <= cores ? { status: 'ok' } : { status: 'advise' };
  }
  if (rule.kind === 'info') return { status: 'info', reason: rule.reason || null };
  if (rule.kind === 'hold') return { status: 'unknown', reason: rule.reason || 'hold' };
  return { status: 'unknown', reason: 'notRead' };
}

/**
 * 규칙 하나를 값에 건다(카탈로그 항목 · 프로파일 요구값 공용).
 * @param {object} rule
 * @param {*} value      현재값(undefined = 못 읽음)
 * @param {object} ctx   { tu, detail, item }
 * @returns {{status:string, reason:string|null, devices?:Array}}
 */
export function evalRule(rule, value, { tu = null, detail = null, item = null } = {}) {
  if (!rule) return { status: 'info', reason: 'noRec' };
  if (rule.kind === 'hold') return { status: 'unknown', reason: rule.reason || 'hold' };
  if (rule.kind === 'info') return { status: 'info', reason: rule.reason || null };
  // 장치 · NIC 단위 항목 — 장치마다 판정하고 가장 나쁜 것(권고 > 확인 불가 > 적합 > 참고)을 항목 상태로.
  if (item?.valueKind === 'devices') {
    if (!Array.isArray(tu?.blkq)) return { status: 'unknown', reason: 'notRead', devices: [] };
    const devs = tu.blkq.filter((d) => d && item.devices(d));
    if (!devs.length) return { status: 'info', reason: 'noDevice', devices: [] };
    const per = devs.slice(0, 32).map((d) => ({ name: String(d.name), value: str(item.devValue(d)), ...evalUnit(rule, item.devValue(d), { tu }) }));
    return { status: worst(per.map((x) => x.status)), reason: null, devices: per };
  }
  if (item?.valueKind === 'nics') {
    if (!Array.isArray(tu?.netq)) return { status: 'unknown', reason: 'notRead', devices: [] };
    if (!tu.netq.length) return { status: 'info', reason: 'noDevice', devices: [] };
    const per = tu.netq.slice(0, 32).map((x) => ({ name: String(x.name), value: str(item.nicValue(x)), ...evalUnit(rule, item.nicValue(x), { tu }) }));
    return { status: worst(per.map((x) => x.status)), reason: null, devices: per };
  }
  if (rule.kind === 'custom') {
    const fn = CUSTOM_RULES[rule.id];
    if (!fn) return { status: 'unknown', reason: 'notRead' };
    const r = fn({ tu, detail, value, rule });
    return { status: r.status, reason: r.reason ?? null, ...(Array.isArray(r.devices) ? { devices: r.devices } : {}) };
  }
  if (value === undefined || value === null) return { status: 'unknown', reason: 'notRead' };
  if (rule.kind === 'oneOf') return rule.values.includes(String(value)) ? { status: 'ok', reason: null } : { status: 'advise', reason: null };
  if (rule.kind === 'eqNum') { const n = numOrNull(value); return n == null ? { status: 'unknown', reason: 'notRead' } : (n === rule.value ? { status: 'ok', reason: null } : { status: 'advise', reason: null }); }
  if (rule.kind === 'eqStr') return String(value).replace(/\s+/g, ' ').trim() === String(rule.value) ? { status: 'ok', reason: null } : { status: 'advise', reason: null };
  if (rule.kind === 'maxPctMem' || rule.kind === 'rangePctMem') {
    const v = numOrNull(value); const mem = numOrNull(tu?.memTotalKb);
    if (v == null) return { status: 'unknown', reason: 'notRead' };
    if (mem == null || mem <= 0) return { status: 'unknown', reason: 'memNotRead' };
    const pct = (v / mem) * 100;
    if (rule.kind === 'maxPctMem') return pct <= rule.pct ? { status: 'ok', reason: null } : { status: 'advise', reason: null };
    // 1% 여유(정수 반올림) — 문서값 3% 를 kB 로 옮길 때의 끝수.
    return pct >= rule.min * 0.99 && pct <= rule.max ? { status: 'ok', reason: null } : { status: 'advise', reason: null };
  }
  return { status: 'unknown', reason: 'notRead' };
}

/** 표시용 현재값(문자열) — 못 읽으면 null(화면이 ‘—’). */
function currentText(item, value) {
  if (value === undefined || value === null) return null;
  if (item.valueKind === 'irqSpread') {
    const v = value || {};
    return `NIC 큐 IRQ ${v.nicIrqs ?? '—'}개 · 코어 ${v.spreadMin ?? '—'}~${v.spreadMax ?? '—'}/${v.cpus ?? '—'}`;
  }
  return String(value);
}

/**
 * 덮어쓰기 값 → 규칙(항목의 값 종류에 맞춰). 숫자 항목은 eqNum, 그 밖은 oneOf 한 값, NIC 항목(txqueuelen)은 custom 의 기준값.
 * 값이 null 이면 ‘권장 없음’(관리자가 권장을 지웠다).
 */
export function overrideRule(item, value) {
  if (value === null) return { kind: 'info', text: '권장 없음(관리자 설정)', reason: 'noRec' };
  const v = String(value);
  if (item.id === 'net.txqueuelen') return { kind: 'custom', id: 'txqueuelen', value: Number(v), text: v };
  if (item.valueKind === 'num') return { kind: 'eqNum', value: Number(v), text: v };
  return { kind: 'oneOf', values: [v], text: v };
}

/**
 * 한 서버의 튜닝 판정.
 * @param {object} p
 * @param {object|null} p.tuning   tuning_json(파싱본) — null 이면 전 항목 확인 불가(notRead)
 * @param {object|null} p.detail   detail_json(NIC 드롭 증가분)
 * @param {string} p.role          서버 역할(db · web · cache · file · general — 수동 태그. 없으면 general)
 * @param {Map|object} [p.appRules] 기능 프로파일이 덮는 항목: { itemId: { rule, by } }(profiles/merge.js)
 * @param {object} [p.overrides]   관리자 덮어쓰기(역할 단위 · 이미 법인 > 전체 순으로 고른 것): { itemId: { value, by } }
 */
export function judgeTuning({ tuning = null, detail = null, role = DEFAULT_ROLE, appRules = {}, overrides = {} } = {}) {
  const r = ROLES.includes(role) ? role : DEFAULT_ROLE;
  const items = TUNING_ITEMS.map((item) => {
    let rule = null; let by = '';
    const app = appRules?.[item.id];
    const ov = overrides?.[item.id];
    if (app) { rule = app.rule; by = app.by; }
    else if (ov && item.overridable) { rule = overrideRule(item, ov.value); by = ov.by; }
    else { rule = roleRule(item, r); by = rule ? `role:${r}` : 'none'; }
    if (!rule) rule = NO_REC;
    const value = tuning && typeof item.fact === 'function' ? item.fact(tuning, detail) : undefined;
    let res = tuning == null && item.valueKind !== 'devices' && item.valueKind !== 'nics' && rule.kind !== 'hold' && rule.kind !== 'info'
      ? { status: 'unknown', reason: 'notRead' }
      : evalRule(rule, value, { tu: tuning, detail, item });
    // 구획은 읽었는데 값만 없다 — ‘못 읽음’ 이 아니라 ‘그 서버에 없음’(파일 없음). 상태는 그대로 확인 불가(불일치가 아니다).
    if (res.status === 'unknown' && res.reason === 'notRead' && value === undefined && item.section && item.valueKind !== 'devices' && item.valueKind !== 'nics'
      && tuning?.sections?.[item.section] === 'ok') res = { ...res, reason: 'notPresent' };
    return {
      id: item.id, cat: item.cat, title: item.title, reads: item.reads,
      current: item.valueKind === 'devices' || item.valueKind === 'nics' ? null : currentText(item, value),
      ...(res.devices ? { devices: res.devices } : {}),
      rec: rule.text || '', by, status: res.status, reason: res.reason ?? (rule === NO_REC ? 'noRec' : null),
      evidence: item.evidence, sources: item.sources, grade: item.grade,
      ...(item.overridable ? { overridable: true } : {}),
    };
  });
  const counts = { advise: 0, ok: 0, info: 0, unknown: 0 };
  for (const x of items) counts[x.status] += 1;
  return {
    role: r, items, counts,
    tunedProfile: tuning?.sysctl?.['tuned.active_profile'] ?? null,
    at: numOrNull(tuning?.at),
    readOnly: true,   // 적용 경로 없음(설계 §4.3) — 화면이 ‘적용은 담당자가’ 를 말한다
  };
}
