/**
 * svcstatus/targets.js — **등록부 → 감시 대상**(v3.54).
 *
 * 대상은 손으로 등록하지 않는다 — 설정 카탈로그(`linkcheck/settingsLinks.js buildSettingsTargets`, 통신 점검 · Monitoring 설정 연동이 쓰는 열거기 하나)에서
 * 엣지 포탈(수집 서버) · vCenter · CVP · 스토리지 네 종류만 골라 **매 주기 다시 계산**한다. 등록부에 장비를 더하거나 주소 · 포트를 바꾸면 다음 주기에 따라 바뀐다
 * (손으로 맞추는 곳이 없다 — 등록을 안 한 것이 조용히 빠지는 거짓을 막는다, links.js 머리말과 같은 이유).
 *
 * 접속처 = **등록된 주소:포트 그대로**(포트 포워딩 현장 — 사용자 요구). 판정은 카탈로그가 한다:
 *   · 수집 서버 url · vCenter host · CVP host — URL 의 포트, 없으면 https 443 · http 80(`splitTarget`)
 *   · 스토리지 — SSH 수집은 등록된 sshPort, REST 수집은 기종별 포트(그 노드 env — `storage/endpoint.js` 하나)
 *
 * 측정하는 곳:
 *   · 엣지 포탈 — 중앙(중앙 → 엣지 방향 · 수집 puller 와 같은 길)
 *   · vCenter — 직접 수집(direct)은 중앙, 현지 수집(site)은 **담당 엣지**(등록 → 위임 인벤토리 소유 → 스냅샷 관측 — `bmusage/targets.js siteOwnerByVcenter`).
 *     담당을 모르면 '담당 엣지 모름'(unassigned) — 중앙이 대신 재지 않는다(중앙에서 안 닿는 주소를 '끊김' 으로 적는 거짓 — edge.md 통신 점검 규약).
 *   · CVP · 스토리지 — 등록부의 담당 엣지(agent)가 있으면 그 엣지, 비었으면 중앙.
 *
 * ⚠ 등록부를 못 읽은 종류(카탈로그 sourceErrors)는 **지우지 않고** 마지막으로 계산한 목록을 '보류' 로 유지한다(빈 목록 = '등록 0건' 이라는 거짓).
 * ⚠ 비밀은 싣지 않는다 — 카탈로그 대상은 이미 비밀 제거본(redact)이다.
 */
import { numOrNull } from '../util/numOrNull.js';
import { KIND_KEYS } from './settings.js';
import { pushAll } from '../util/pushAll.js';

const t = (v) => String(v ?? '').trim();

/** 카탈로그 종류 → 이 기능의 종류. */
export const KIND_OF = Object.freeze({
  'set:collector': 'collector', 'set:vcenter': 'vcenter', 'set:cvp': 'cvp', 'set:storage-api': 'storage', 'set:storage-ssh': 'storage',
});
export const KIND_LABEL = Object.freeze({ collector: '엣지 포탈', vcenter: 'vCenter', cvp: 'CVP', storage: '스토리지' });
/** 카탈로그 sourceErrors 의 출처 키 → 종류. */
export const SOURCE_KIND = Object.freeze({ collectors: 'collector', vcenters: 'vcenter', cvp: 'cvp', storage: 'storage' });

/** 등록부 안내(설정 화면 '대상을 가져오는 등록부' 표 — 접속처 규칙은 코드와 같은 말). */
export const SOURCES = Object.freeze([
  { kind: 'collector', settings: '설정 › 엣지·원격 › 수집 서버(원격)', hash: '#/settings/collectors',
    rule: '등록된 URL 의 주소:포트 — 포트가 없으면 https 443 · http 80', measuredBy: '중앙 포탈' },
  { kind: 'vcenter', settings: '설정 › 인프라 등록 › vCenter 등록·관리', hash: '#/settings/vcenter-admin',
    rule: '등록된 주소(URL)의 포트 — 포트가 없으면 https 443 · http 80', measuredBy: '직접 수집은 중앙 · 현지 수집은 담당 엣지' },
  { kind: 'cvp', settings: '특수기능 › Arista CloudVision(CVP) › 서버 등록', hash: '#/tools/cvp',
    rule: '등록된 주소:포트(URL 또는 호스트[:포트]) — 포트가 없으면 https 443 · http 80', measuredBy: '담당 엣지가 지정돼 있으면 그 엣지, 아니면 중앙' },
  { kind: 'storage', settings: '특수기능 › 스토리지 모니터링 › 장비 등록', hash: '#/tools/storage-mon',
    rule: 'SSH 수집은 등록된 SSH 포트(기본 22) · REST 수집은 기종별 포트(그 포탈 설정 — 기본 Isilon 8080 · PowerMax/VMAX 8443 · 그 밖 443)', measuredBy: '담당 엣지가 지정돼 있으면 그 엣지, 아니면 중앙' },
].map((s) => Object.freeze({ ...s, label: KIND_LABEL[s.kind] })));

/** 데모 항목인가(모드 무관 표지 — live 에서는 재지 않는다, svcmon v2.719 와 같은 판단). */
export function isDemoTarget(x) {
  if (!x) return false;
  if (x.demo === true || x.facts?.demo === true) return true;
  if (/^mock-/i.test(t(x.ref))) return true;
  return /\.demo\.invalid$/i.test(t(x.host));
}

/** 접속처 기본 포트(이 판정으로 '기본 포트 아님' 을 표시한다 — URL 은 기본 포트를 지우므로 u.port 유무로 보면 틀린다). */
export function defaultPortOf(x) {
  const kind = KIND_OF[x?.kind];
  if (kind === 'storage') { const d = numOrNull(x?.facts?.defaultPort); return d != null ? d : (x.kind === 'set:storage-ssh' ? 22 : 443); }
  return t(x?.scheme).toLowerCase() === 'http' ? 80 : 443;
}

/**
 * 카탈로그 결과 → 감시 대상(순수).
 * @param {{targets?:Array, problems?:Array, sourceErrors?:Array}} built
 * @param {object} o
 * @param {object} o.settings 정규화 설정(kinds · excluded)
 * @param {Map<string,string>} [o.siteOwner] vCenter id → 담당 엣지 이름
 * @param {(x:object)=>{key:string,label:string}} [o.corpOf] 법인 판정(svcmon corpOf 를 묶어 넘긴다)
 * @param {boolean} [o.mock] 데모 모드인가
 * @param {Map<string,Array>} [o.previous] 종류 → 직전 카탈로그 원본(`raw` — 못 읽은 종류의 보류용)
 * @param {Object<string,string>} [o.typeLabel] 스토리지 기종 → 라벨
 * @returns {{ rows:Array, heldKinds:string[], sourceErrors:Array, raw:Map }}
 */
export function planTargets(built = {}, { settings = {}, siteOwner = new Map(), corpOf = () => ({ key: '', label: '' }), mock = false, previous = new Map(), typeLabel = {} } = {}) {
  const kinds = settings.kinds || {};
  const excluded = new Map((settings.excluded || []).map((x) => [x.id, x]));
  const sourceErrors = [];
  const held = new Set();
  for (const e of Array.isArray(built.sourceErrors) ? built.sourceErrors : []) {
    const k = SOURCE_KIND[t(e?.source)];
    if (!k) continue;
    held.add(k);
    sourceErrors.push({ kind: k, label: KIND_LABEL[k], off: kinds[k] === false, reason: t(e?.reason).slice(0, 200) });
  }
  const fresh = new Map(KIND_KEYS.map((k) => [k, []]));
  const raw = new Map(KIND_KEYS.map((k) => [k, []]));   // 다음 주기의 보류용 — 카탈로그 원본(제외 · 꺼짐은 그때 설정으로 다시 판정한다)
  const one = (x, problem = null) => {
    const kind = KIND_OF[x?.kind];
    if (!kind) return null;
    const vcSite = kind === 'vcenter' && t(x?.facts?.collectMode) === 'site';
    let by = 'central';
    // 현지 수집 담당 = 표준 판정(siteOwnerByVcenter — 위임 인벤토리 소유 → 스냅샷 관측) → 카탈로그 값(데모 대체 입력의 remoteAgent) 순.
    if (kind === 'vcenter' && vcSite) by = t(siteOwner.get(t(x.ref))) || t(x.agent) || '';
    else if (kind === 'cvp' || kind === 'storage') by = t(x.agent) || 'central';
    const port = numOrNull(x.port);
    const host = t(x.host);
    const defaultPort = problem ? null : defaultPortOf(x);
    // 설정 오류(problems) 항목에는 id 가 없다 — 카탈로그와 같은 규칙(kind|ref)으로 만든다(점검 반증 #5: 빈 id 라 상세 · 제외 · 행 키가 깨졌다).
    const id = t(x.id) || `${t(x.kind)}|${t(x.ref) || '-'}`;
    const ex = excluded.get(id);
    const demo = isDemoTarget({ ...x, host });
    const row = {
      id, kind, kindLabel: KIND_LABEL[kind],
      sub: kind === 'vcenter' ? (vcSite ? 'site' : 'direct') : kind === 'storage' ? (x.kind === 'set:storage-ssh' ? 'ssh' : 'api') : '',
      type: kind === 'storage' ? t(x.facts?.type) : '',
      typeLabel: kind === 'storage' ? t(typeLabel[t(x.facts?.type)] || x.facts?.type) : '',
      ref: t(x.ref), name: t(x.name) || t(x.ref),
      corp: corpOf(x) || { key: '', label: '' },
      host: problem ? '' : host, port: problem ? null : port,
      defaultPort, nonDefaultPort: !problem && port != null && defaultPort != null && port !== defaultPort,
      by, enabled: x.enabled !== false, demo,
      excluded: ex ? { reason: ex.reason, at: ex.at, by: ex.by } : null,
      problem: problem ? t(problem).slice(0, 200) : null,
      address: problem ? t(x.address).slice(0, 300) : '',
      held: false,
    };
    // 무엇을 하는가(측정 · 표지) — 순서가 계약이다: 설정 오류 → 꺼짐 → 제외 → 데모(live) → 담당 모름 → 측정.
    row.plan = row.problem ? 'problem'
      : !row.enabled ? 'off'
        : row.excluded ? 'excluded'
          : (demo && !mock) ? 'demo-live'
            : !by ? 'unassigned'
              : by === 'central' ? 'central' : 'edge';
    return row;
  };
  for (const x of Array.isArray(built.targets) ? built.targets : []) {
    const r = one(x);
    if (!r) continue;
    raw.get(r.kind).push({ x, problem: null });
    if (kinds[r.kind] !== false) fresh.get(r.kind).push(r);
  }
  for (const p of Array.isArray(built.problems) ? built.problems : []) {
    const problem = p?.reason || '주소를 해석하지 못했습니다.';
    const r = one(p, problem);
    if (!r) continue;
    raw.get(r.kind).push({ x: p, problem });
    if (kinds[r.kind] !== false) fresh.get(r.kind).push(r);
  }
  const rows = [];
  const heldKinds = [];
  for (const k of KIND_KEYS) {
    if (kinds[k] === false) continue;
    if (held.has(k)) {
      const prev = previous.get(k);
      heldKinds.push(k);
      // 못 읽은 종류는 직전 목록을 '보류' 로(지우지 않는다). 직전이 없으면 이번 것(보통 빈 목록) — 화면이 sourceErrors 로 말한다.
      if (Array.isArray(prev) && prev.length) {
        for (const it of prev) { const r = one(it.x, it.problem); if (r) rows.push({ ...r, held: true }); }
        raw.set(k, prev);   // 보류가 이어지면 다음 주기도 같은 원본
        continue;
      }
    }
    pushAll(rows, fresh.get(k));   // 전개 push 금지(원소 수만큼 인자 — audit2603a 스윕)
  }
  return { rows, heldKinds, sourceErrors, raw };
}
