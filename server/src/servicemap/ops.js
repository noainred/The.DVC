/**
 * servicemap/ops.js — 저장소 변경 연산(순수: draft 를 고치고 { error } 또는 { result } 를 돌려준다, v2.887).
 * 라우트가 권한(법인 쓰기 범위·전체 범위)을 먼저 확인하고 store.mutateMap(draft => op(draft, body)) 로 부른다.
 * 서비스를 자동으로 만드는 경로는 없다 — 'service.add' 와 'service.createLinked'(사람이 누른 '서비스로 만들기')뿐이다.
 */
import { LIMITS, cleanText, cleanFolderPath, cleanFolderPrefix, corpOf, sameName, newId, tierOf } from './store.js';

const lc = (s) => String(s ?? '').trim().toLowerCase();
const err = (error, status = 400) => ({ error, status });
const under = (p, base) => p === base || p.startsWith(`${base}\\`);

function svcIn(c, id) { return (c.services || []).find((s) => s.id === id) || null; }
function nameTaken(c, name, exceptId = '') { return (c.services || []).some((s) => s.id !== exceptId && sameName(s.name, name)); }
/**
 * 별칭 ↔ 서비스명 충돌(5차 반증 R4) — 판정은 서비스명을 별칭보다 먼저 보므로(resolve.js), 다른 서비스 이름과 같은 별칭은 조용히 무시된다.
 * 그래서 양쪽에서 막는다: 다른 서비스의 별칭과 같은 이름으로 서비스를 만들거나 바꾸지 못하고, 다른 서비스 이름과 같은 별칭을 만들지 못한다.
 */
function aliasOwnerOf(c, name, exceptServiceId = '') { return (c.aliases || []).find((a) => a.serviceId !== exceptServiceId && lc(a.value) === lc(name)) || null; }
const KIND_TEXT = { scan: '스캔 라벨', tag: '태그 값' };
function aliasConflict(c, name, exceptServiceId = '') {
  const a = aliasOwnerOf(c, name, exceptServiceId);
  if (!a) return null;
  const owner = svcIn(c, a.serviceId);
  return err(`'${name}' 은(는) 서비스 '${owner?.name || '?'}' 의 ${KIND_TEXT[a.kind] || ''} 별칭입니다 — 그 별칭을 먼저 지우십시오(서비스명이 별칭보다 먼저 걸려 소속이 바뀝니다)`, 409);
}
function optText(v, max, label) { return v === undefined ? { skip: true } : cleanText(v, max, { allowEmpty: true, label }); }

/** 법인 연산 — body.corp 는 라우트가 쓰기 범위로 확인한 vCenter id. */
export const CORP_OPS = {
  'folder.add'(d, b) {
    const p = cleanFolderPath(b.path); if (p.error) return err(p.error); if (!p.value) return err('폴더 경로가 비어 있습니다');
    const c = corpOf(d, b.corp);
    if (c.folders.length >= LIMITS.foldersPerCorp) return err(`폴더는 법인당 ${LIMITS.foldersPerCorp}개까지입니다`);
    if (!c.folders.includes(p.value)) c.folders.push(p.value);
    return { result: { path: p.value } };
  },
  'folder.remove'(d, b) {
    const p = cleanFolderPath(b.path); if (p.error || !p.value) return err(p.error || '폴더 경로가 비어 있습니다');
    const c = corpOf(d, b.corp);
    const busy = c.services.filter((s) => under(s.path, p.value)).length;
    if (busy) return err(`이 폴더 아래 서비스 ${busy}개가 있습니다 — 먼저 옮기거나 지우십시오`, 409);
    c.folders = c.folders.filter((f) => !under(f, p.value));
    return { result: { path: p.value } };
  },
  'service.add'(d, b) {
    const n = cleanText(b.name, LIMITS.name, { label: '서비스명' }); if (n.error) return err(n.error);
    const p = cleanFolderPath(b.path); if (p.error) return err(p.error);
    const c = corpOf(d, b.corp);
    if (c.services.length >= LIMITS.servicesPerCorp) return err(`서비스는 법인당 ${LIMITS.servicesPerCorp}개까지입니다`);
    if (nameTaken(c, n.value)) return err(`'${n.value}' 은(는) 이 법인에 이미 있습니다(법인 안에서 서비스명은 유일)`, 409);
    const ac = aliasConflict(c, n.value); if (ac) return ac;
    const owner = cleanText(b.owner, LIMITS.owner, { allowEmpty: true, label: '담당자' }); if (owner.error) return err(owner.error);
    const note = cleanText(b.note, LIMITS.note, { allowEmpty: true, label: '메모' }); if (note.error) return err(note.error);
    const gid = typeof b.globalId === 'string' && d.globals.some((g) => g.id === b.globalId) ? b.globalId : '';
    const s = { id: newId('svc'), name: n.value, path: p.value, tier: tierOf(b.tier), owner: owner.value, note: note.value, globalId: gid };
    c.services.push(s);
    return { result: { service: s } };
  },
  'service.update'(d, b) {
    const c = corpOf(d, b.corp);
    const s = svcIn(c, b.id); if (!s) return err('서비스를 찾지 못했습니다', 404);
    const keep = { added: [], skipped: [] };
    if (b.name !== undefined) {
      const n = cleanText(b.name, LIMITS.name, { label: '서비스명' }); if (n.error) return err(n.error);
      if (nameTaken(c, n.value, s.id)) return err(`'${n.value}' 은(는) 이 법인에 이미 있습니다`, 409);
      const old = s.name;
      if (!sameName(old, n.value)) {   // 이름이 실제로 바뀔 때만 — 등급·담당자만 저장할 때 옛 충돌 데이터로 막히지 않게(5차 1차 반증 5)
        const ac = aliasConflict(c, n.value, s.id); if (ac) return ac;
        // 옛 이름이 다른 서비스의 별칭이기도 하면(검사 전 옛 데이터) 개명하는 순간 그 별칭이 살아나 구성원이 그 서비스로 옮겨 간다(반증 4) — 사람이 먼저 정리한다.
        const shadow = aliasOwnerOf(c, old, s.id);
        if (shadow) return err(`옛 이름 '${old}' 은(는) 서비스 '${svcIn(c, shadow.serviceId)?.name || '?'}' 의 ${KIND_TEXT[shadow.kind] || ''} 별칭이기도 합니다 — 이름을 바꾸면 그 별칭이 살아나 '${old}' 로 걸리던 구성원이 그 서비스로 옮겨 갑니다. 소속 규칙 탭에서 그 별칭을 먼저 정리하십시오`, 409);
      }
      s.name = n.value;
      // 개명하면 옛 이름으로 걸리던 스캔 라벨·태그 값 소속이 끊긴다(5차 반증 R3) — 화면이 영향 대수를 보이고 사람이 고른 종류만 별칭으로 남긴다.
      const kinds = Array.isArray(b.keepAlias) ? [...new Set(b.keepAlias)].filter((k) => k === 'scan' || k === 'tag') : [];
      if (!sameName(old, n.value)) {
        for (const kind of kinds) {
          const ex = c.aliases.find((a) => a.kind === kind && lc(a.value) === lc(old));
          if (ex) { (ex.serviceId === s.id ? keep.added : keep.skipped).push(kind); continue; }
          if (c.aliases.length >= LIMITS.aliasesPerCorp) return err(`별칭은 법인당 ${LIMITS.aliasesPerCorp}개까지입니다 — 옛 이름 '${old}' 을(를) 별칭으로 남길 수 없습니다`);
          c.aliases.push({ kind, value: old, serviceId: s.id }); keep.added.push(kind);
        }
      }
    }
    if (b.path !== undefined) { const p = cleanFolderPath(b.path); if (p.error) return err(p.error); s.path = p.value; }
    if (b.tier !== undefined) s.tier = tierOf(b.tier);
    for (const [k, max, label] of [['owner', LIMITS.owner, '담당자'], ['note', LIMITS.note, '메모']]) {
      const v = optText(b[k], max, label); if (v.error) return err(v.error); if (!v.skip) s[k] = v.value;
    }
    if (b.globalId !== undefined) {
      if (b.globalId && !d.globals.some((g) => g.id === b.globalId)) return err('전역 서비스를 찾지 못했습니다', 404);
      s.globalId = b.globalId || '';
    }
    return { result: { service: { ...s }, ...(keep.added.length || keep.skipped.length ? { keepAlias: keep } : {}) } };
  },
  'service.remove'(d, b) {
    const c = corpOf(d, b.corp);
    const s = svcIn(c, b.id); if (!s) return err('서비스를 찾지 못했습니다', 404);
    c.services = c.services.filter((x) => x.id !== s.id);
    const before = c.folderRules.length + c.aliases.length + c.nameRules.length;
    c.folderRules = c.folderRules.filter((r) => r.serviceId !== s.id);
    c.aliases = c.aliases.filter((r) => r.serviceId !== s.id);
    c.nameRules = c.nameRules.filter((r) => r.serviceId !== s.id);
    return { result: { removed: s.id, name: s.name, rulesRemoved: before - (c.folderRules.length + c.aliases.length + c.nameRules.length) } };
  },
  'rule.add'(d, b) {
    const p = cleanFolderPrefix(b.prefix); if (p.error) return err(p.error);
    const c = corpOf(d, b.corp);
    if (!svcIn(c, b.serviceId)) return err('대상 서비스를 찾지 못했습니다', 404);
    if (c.folderRules.length >= LIMITS.folderRulesPerCorp) return err(`폴더 규칙은 법인당 ${LIMITS.folderRulesPerCorp}개까지입니다`);
    const ex = c.folderRules.find((r) => r.prefix === p.value);
    if (ex) { if (ex.serviceId === b.serviceId) return { result: { prefix: p.value, same: true } }; return err(`'${p.value}' 규칙이 이미 다른 서비스에 있습니다 — 먼저 지우십시오`, 409); }
    c.folderRules.push({ prefix: p.value, serviceId: b.serviceId });
    return { result: { prefix: p.value } };
  },
  'rule.remove'(d, b) {
    const p = cleanFolderPrefix(b.prefix); if (p.error) return err(p.error);
    const c = corpOf(d, b.corp);
    const n = c.folderRules.length; c.folderRules = c.folderRules.filter((r) => r.prefix !== p.value);
    if (n === c.folderRules.length) return err('그 규칙이 없습니다', 404);
    return { result: { prefix: p.value } };
  },
  'alias.add'(d, b) {
    if (b.kind !== 'scan' && b.kind !== 'tag') return err('별칭 종류는 scan 또는 tag 입니다');
    const v = cleanText(b.value, LIMITS.alias, { label: '값' }); if (v.error) return err(v.error);
    const c = corpOf(d, b.corp);
    if (!svcIn(c, b.serviceId)) return err('대상 서비스를 찾지 못했습니다', 404);
    // 값이 서비스 이름과 같으면 별칭이 필요 없거나(그 서비스) 쓰이지 않는다(다른 서비스 — 이름이 먼저 걸린다, 5차 반증 R4).
    const byName = (c.services || []).find((s) => sameName(s.name, v.value));
    if (byName) {
      if (byName.id === b.serviceId) return { result: { kind: b.kind, value: v.value, same: true, byName: true } };
      return err(`'${v.value}' 은(는) 서비스 '${byName.name}' 의 이름입니다 — 이 값은 그 서비스로 바로 걸립니다(별칭이 쓰이지 않습니다)`, 409);
    }
    if (c.aliases.length >= LIMITS.aliasesPerCorp) return err(`별칭은 법인당 ${LIMITS.aliasesPerCorp}개까지입니다`);
    const ex = c.aliases.find((a) => a.kind === b.kind && lc(a.value) === lc(v.value));
    if (ex) { if (ex.serviceId === b.serviceId) return { result: { same: true } }; return err(`'${v.value}' 별칭이 이미 다른 서비스에 있습니다`, 409); }
    c.aliases.push({ kind: b.kind, value: v.value, serviceId: b.serviceId });
    return { result: { kind: b.kind, value: v.value } };
  },
  'alias.remove'(d, b) {
    const c = corpOf(d, b.corp);
    const n = c.aliases.length; c.aliases = c.aliases.filter((a) => !(a.kind === b.kind && lc(a.value) === lc(b.value)));
    if (n === c.aliases.length) return err('그 별칭이 없습니다', 404);
    return { result: {} };
  },
  'namerule.add'(d, b) {
    if (!['prefix', 'suffix', 'contains'].includes(b.match)) return err('이름 규칙은 prefix·suffix·contains 중 하나입니다');
    const v = cleanText(b.value, LIMITS.nameRule, { label: '값' }); if (v.error) return err(v.error);
    const c = corpOf(d, b.corp);
    if (!svcIn(c, b.serviceId)) return err('대상 서비스를 찾지 못했습니다', 404);
    if (c.nameRules.length >= LIMITS.nameRulesPerCorp) return err(`이름 규칙은 법인당 ${LIMITS.nameRulesPerCorp}개까지입니다`);
    if (c.nameRules.some((r) => r.match === b.match && lc(r.value) === lc(v.value))) return err('같은 이름 규칙이 이미 있습니다', 409);
    c.nameRules.push({ match: b.match, value: v.value, serviceId: b.serviceId });
    return { result: {} };
  },
  'namerule.remove'(d, b) {
    const c = corpOf(d, b.corp);
    const n = c.nameRules.length; c.nameRules = c.nameRules.filter((r) => !(r.match === b.match && lc(r.value) === lc(b.value)));
    if (n === c.nameRules.length) return err('그 이름 규칙이 없습니다', 404);
    return { result: {} };
  },
  'tag.enable'(d, b) { const c = corpOf(d, b.corp); c.tagEnabled = b.enabled === true; return { result: { tagEnabled: c.tagEnabled } }; },
  /** '서비스로 만들기' — 사람이 누른 버튼만 서비스를 만든다. 만든 뒤 그 값에 규칙(폴더)이나 별칭(스캔·태그)을 붙인다. */
  'service.createLinked'(d, b) {
    if (!['folder', 'scan', 'tag'].includes(b.kind)) return err('종류는 folder·scan·tag 중 하나입니다');
    const r1 = CORP_OPS['service.add'](d, { corp: b.corp, name: b.name, path: b.path || '', tier: b.tier, owner: b.owner });
    if (r1.error) return r1;
    const id = r1.result.service.id;
    const r2 = b.kind === 'folder' ? CORP_OPS['rule.add'](d, { corp: b.corp, prefix: b.value, serviceId: id })
      : CORP_OPS['alias.add'](d, { corp: b.corp, kind: b.kind, value: b.value, serviceId: id });
    if (r2.error) return r2;   // mutateMap 은 error 면 draft 를 버린다 — 서비스만 생기고 규칙이 빠지는 반쪽 상태가 없다
    return { result: { service: r1.result.service } };
  },
};

/** 전체 범위 관리자 전용 연산(전역 카탈로그·태그 카테고리). */
export const FLEET_OPS = {
  'global.add'(d, b) {
    const n = cleanText(b.name, LIMITS.name, { label: '전역 서비스명' }); if (n.error) return err(n.error);
    if (d.globals.length >= LIMITS.globals) return err(`전역 서비스는 ${LIMITS.globals}개까지입니다`);
    if (d.globals.some((g) => sameName(g.name, n.value))) return err(`전역 '${n.value}' 이(가) 이미 있습니다`, 409);
    const owner = cleanText(b.owner, LIMITS.owner, { allowEmpty: true, label: '담당자' }); if (owner.error) return err(owner.error);
    const note = cleanText(b.note, LIMITS.note, { allowEmpty: true, label: '메모' }); if (note.error) return err(note.error);
    const g = { id: newId('g'), name: n.value, tier: tierOf(b.tier), owner: owner.value, note: note.value };
    d.globals.push(g);
    return { result: { global: g } };
  },
  'global.update'(d, b) {
    const g = d.globals.find((x) => x.id === b.id); if (!g) return err('전역 서비스를 찾지 못했습니다', 404);
    if (b.name !== undefined) {
      const n = cleanText(b.name, LIMITS.name, { label: '전역 서비스명' }); if (n.error) return err(n.error);
      if (d.globals.some((x) => x.id !== g.id && sameName(x.name, n.value))) return err(`전역 '${n.value}' 이(가) 이미 있습니다`, 409);
      g.name = n.value;
    }
    if (b.tier !== undefined) g.tier = tierOf(b.tier);
    for (const [k, max, label] of [['owner', LIMITS.owner, '담당자'], ['note', LIMITS.note, '메모']]) {
      const v = optText(b[k], max, label); if (v.error) return err(v.error); if (!v.skip) g[k] = v.value;
    }
    return { result: { global: { ...g } } };
  },
  /** 전역 삭제 — 법인 서비스는 남기고 연결(globalId)만 비운다. */
  'global.remove'(d, b) {
    const g = d.globals.find((x) => x.id === b.id); if (!g) return err('전역 서비스를 찾지 못했습니다', 404);
    d.globals = d.globals.filter((x) => x.id !== g.id);
    let unlinked = 0;
    for (const c of Object.values(d.corps)) for (const s of c.services) if (s.globalId === g.id) { s.globalId = ''; unlinked += 1; }
    return { result: { removed: g.id, name: g.name, unlinked } };
  },
  'settings.tagCategory'(d, b) {
    const v = cleanText(b.value, 128, { allowEmpty: true, label: '태그 카테고리' }); if (v.error) return err(v.error);
    d.settings.tagCategory = v.value;
    return { result: { tagCategory: v.value } };
  },
};
