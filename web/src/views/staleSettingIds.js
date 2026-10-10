/**
 * v2.732(점검 2회차 B5-02): 설정에 남은 '목록에 없는 id'(삭제된 vCenter·VM·호스트 · mock→live 전환 · 아직 수집 목록에 없음) — 순수 모듈.
 *
 * 세 설정 화면(현재 사용자 · VM 성능 트래킹 · VM 실시간 스파이크)은 **지금 목록에 있는 것만** 칩·트리로 그렸다. 그래서 저장 파일에 남은
 * 낡은 id 는 화면 어디에도 보이지 않았고(예: '2개 선택' 인데 켜진 칩은 1개), 서버 PUT 은 그 id 를 '존재하지 않는 id' 로 400 을 냈다 —
 * 사람이 그 id 를 지울 수단도, 저장할 수단도 없었다. 서버는 이제 이미 저장돼 있던 낡은 id 를 통과·보존하고 staleIds 로 밝힌다.
 * 이 모듈은 그것을 화면이 '목록에 없음' 칩으로 그리고 사람이 해제하게 하는 판정·문구를 소유한다.
 *
 * ⚠ 조용히 지우지 않는다 — 스냅샷이 잠시 그 vCenter 를 갖지 않는 순간(기동 직후·전환 중)에 자동으로 빼면 설정이 사라지고,
 *   VM 성능 트래킹은 대상에서 빠진 vCenter 의 데이터 파일까지 삭제한다. 해제는 사람이 한다.
 * ⚠ 화면 문구는 BoldText 로 그린다 — `**강조**` 만, 백틱 금지(값 인용은 ‘ ’).
 */
import { changeFailText } from './changeResult.js';

const asList = (v) => (Array.isArray(v) ? v.map(String) : []);
// 조사: '곳' 은 받침이 있고 '개' 는 없다(곳이·곳은 / 개가·개는).
const subj = (count) => (count === '곳' ? '이' : '가');
const topic = (count) => (count === '곳' ? '은' : '는');

/** 지금 선택(키 목록) 중 알려진 목록(id 배열 또는 {id} 배열)에 없는 것 — 화면이 직접 센다(사람이 해제하면 바로 사라지게). */
export function staleIdsOf(currentIds, known) {
  const set = new Set((Array.isArray(known) ? known : []).map((k) => String(k && typeof k === 'object' ? k.id : k)));
  return [...new Set(asList(currentIds))].filter((id) => id && !set.has(id));
}

/** 맵에서 키 하나를 뺀 새 맵(원본은 건드리지 않는다). */
export function withoutKey(map, id) {
  const out = { ...(map && typeof map === 'object' ? map : {}) };
  delete out[id];
  return out;
}

/**
 * 서버가 준 staleTargets(로드 시점) 중 **지금 targets 에 아직 남아 있는 것**만 — 사람이 해제하면 그 칩이 바로 사라진다.
 * staleTargets: { [vcId]: { vcenter: bool, hosts: [], vms: [] } } · 반환은 같은 모양(빈 항목은 빠진다).
 */
export function pendingStaleTargets(staleTargets, targets) {
  const out = {};
  const tg = targets && typeof targets === 'object' ? targets : {};
  for (const [vcId, st] of Object.entries(staleTargets && typeof staleTargets === 'object' ? staleTargets : {})) {
    const t = tg[vcId];
    if (!t || typeof t !== 'object') continue;              // 이미 대상에서 뺐다
    const keep = (k) => (t.all ? [] : asList(st?.[k]).filter((id) => asList(t[k]).includes(id)));
    const e = { vcenter: !!st?.vcenter, hosts: keep('hosts'), vms: keep('vms') };
    if (e.vcenter || e.hosts.length || e.vms.length) out[vcId] = e;
  }
  return out;
}

/**
 * 화면 칩 목록 — 사라진 vCenter 는 칩 하나(그 아래 호스트·VM 은 개수만 — 키째 빼면 함께 빠진다), 살아 있는 vCenter 의 낡은
 * 호스트·VM 은 하나씩. 반환 [{ vcId, kind:'vcenter'|'hosts'|'vms', id, inner }].
 */
export function staleTargetChips(pending) {
  const out = [];
  for (const [vcId, e] of Object.entries(pending || {})) {
    if (e.vcenter) { out.push({ vcId, kind: 'vcenter', id: vcId, inner: e.hosts.length + e.vms.length }); continue; }
    for (const id of e.hosts) out.push({ vcId, kind: 'hosts', id, inner: 0 });
    for (const id of e.vms) out.push({ vcId, kind: 'vms', id, inner: 0 });
  }
  return out;
}

/** 낡은 대상 개수 = 칩 개수. */
export const staleTargetCount = (pending) => staleTargetChips(pending).length;

/** 칩 글자 — 값 인용 없이 종류 표지 + id. */
export function staleChipLabel(c) {
  if (c.kind === 'vcenter') return `vCenter ${c.id}${c.inner ? ` (그 아래 대상 ${c.inner}개 포함)` : ''}`;
  return `${c.kind === 'hosts' ? '호스트' : 'VM'} ${c.id}`;
}

/** targets 에서 낡은 대상 하나를 뺀다. kind: 'vcenter'(키째) | 'hosts' | 'vms'. 원본은 건드리지 않는다. */
export function removeStaleTarget(targets, vcId, kind, id) {
  const tg = targets && typeof targets === 'object' ? targets : {};
  if (kind === 'vcenter') return withoutKey(tg, vcId);
  const t = tg[vcId];
  if (!t || typeof t !== 'object' || t.all || (kind !== 'hosts' && kind !== 'vms')) return tg;
  return { ...tg, [vcId]: { ...t, [kind]: asList(t[kind]).filter((x) => x !== String(id)) } };
}

/** 화면 안내 — n 곳(개)의 낡은 id 가 남아 있다. drop=true 면 해제·저장 시 데이터 파일도 지운다는 사실을 함께 말한다. */
export function staleNote(n, { unit = 'vCenter', count = '곳', drop = false } = {}) {
  if (!n) return '';
  return `목록에 없는 ${unit} **${n}${count}**${subj(count)} 설정에 남아 있습니다 — 삭제됐거나 아직 수집 목록에 없는 대상입니다. `
    + '저장해도 그대로 남습니다(포탈이 조용히 지우지 않습니다). 더 쓰지 않으면 ✕ 로 해제한 뒤 저장하세요.'
    + (drop ? ' 해제하고 저장하면 **그 vCenter 의 저장된 데이터 파일도 삭제**됩니다(복구 불가).' : '');
}

/** 저장 성공 문구 뒤에 붙일 말 — 서버가 보존한 낡은 id 개수. */
export function staleKeptSuffix(r, { unit = 'vCenter', count = '곳' } = {}) {
  const n = Array.isArray(r?.staleIds) ? r.staleIds.length : 0;
  return n ? ` 목록에 없는 ${unit} ${n}${count}${topic(count)} 그대로 남겼습니다.` : '';
}

/**
 * 저장 응답 판정 — 실패 본문(400 `{ok:false,reason}` 등)이면 **지금 편집 중인 값을 그대로 둔다**.
 * 예전 현재 사용자 설정은 400 본문의 `r.settings`(undefined)로 상태를 덮어 창이 '불러오는 중…' 에서 멈췄다(재현).
 * 반환 { ok, settings, msg }.
 */
export function settingsSaveOutcome(cur, r, okMsg = '저장했습니다.') {
  const why = changeFailText(r);
  if (why != null) return { ok: false, settings: cur, msg: `저장 실패: ${why}` };
  const settings = r && typeof r === 'object' && r.settings && typeof r.settings === 'object' ? r.settings : cur;
  return { ok: true, settings, msg: `${okMsg}${staleKeptSuffix(r)}` };
}
