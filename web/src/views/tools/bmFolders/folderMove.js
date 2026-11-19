/**
 * 폴더 옮기기(v2.997 — 사용자 '폴더를 마우스로 클릭해서 이동할 수 있는 기능'). 순수 — 판정은 서버(folder.move)가 다시 한다. 여기는 놓을 수 있는 곳만 고른다.
 * 같은 법인 안에서만 · 부모만 바뀐다(이름 · 하위 · 등록 · 규칙은 함께 옮겨 간다).
 */
const under = (p, base) => p === base || String(p).startsWith(`${base}\\`);
const lastOf = (p) => String(p).split('\\').pop();
const parentOfPath = (p) => { const i = String(p).lastIndexOf('\\'); return i < 0 ? '' : String(p).slice(0, i); };
export const MAX_DEPTH = 10;

/** 옮긴 뒤 경로. parent '' = 법인 바로 아래. */
export function movedPath(path, parent) { return parent ? `${parent}\\${lastOf(path)}` : lastOf(path); }

/** path 를 parent 아래로 놓을 수 있는가 — { ok, why }. paths = 그 법인 폴더 경로 전부. */
export function canMove(path, parent, paths = []) {
  if (!path) return { ok: false, why: '폴더를 고르십시오' };
  if (parent === parentOfPath(path)) return { ok: false, why: '지금 자리입니다' };
  if (parent && under(parent, path)) return { ok: false, why: '자기 자신이나 하위 폴더 안으로는 옮길 수 없습니다' };
  if (parent && !paths.includes(parent)) return { ok: false, why: '그 폴더가 없습니다' };
  const to = movedPath(path, parent);
  if (paths.includes(to)) return { ok: false, why: '그곳에 같은 이름의 폴더가 있습니다' };
  const depthGain = (parent ? parent.split('\\').length + 1 : 1) - path.split('\\').length;
  const deepest = Math.max(...paths.filter((x) => under(x, path)).map((x) => x.split('\\').length), path.split('\\').length);
  if (deepest + depthGain > MAX_DEPTH) return { ok: false, why: `옮기면 ${MAX_DEPTH}단계를 넘습니다` };
  return { ok: true, why: '' };
}

/** 옮길 수 있는 곳 목록(폼 고르기) — [{ parent, label }] · 법인 바로 아래가 맨 앞. */
export function moveTargets(path, paths = []) {
  const out = [];
  if (canMove(path, '', paths).ok) out.push({ parent: '', label: '(법인 바로 아래)' });
  for (const p of [...paths].sort((a, b) => a.localeCompare(b, 'ko'))) if (canMove(path, p, paths).ok) out.push({ parent: p, label: p.split('\\').join(' › ') });
  return out;
}

/** 옮긴 뒤 고른 위치 — 고른 것이 옮긴 폴더(또는 그 하위)면 새 경로로 따라간다. */
export function followSel(sel, corp, from, to) {
  if (sel?.type !== 'folder' || sel.corp !== corp || !under(sel.path, from)) return sel;
  return { ...sel, path: to + sel.path.slice(from.length) };
}

/** 알림(화면 note 형태 { ok, warn?, text }) — 서버가 실제로 옮긴 수(moved · rules · svcRules)로 말한다. */
export function moveNote(from, to, r = {}) {
  const n = Number(r.moved) || 0; const rules = Number(r.rules) || 0; const svc = Number(r.svcRules) || 0;
  const extra = [n ? `등록 ${n}대` : '', rules ? `규칙 ${rules}개` : '', svc ? `서비스 인벤토리 규칙 ${svc}개` : ''].filter(Boolean).join(' · ');
  const text = `‘${from.split('\\').join(' › ')}’ 을(를) ‘${to.split('\\').join(' › ')}’ 로 옮겼습니다${extra ? `(${extra} 함께)` : ''}.`;
  if (r.svcRulesNotMoved) return { ok: false, warn: true, text: `${text} 다만 서비스 인벤토리의 물리서버 폴더 규칙을 옮기지 못했습니다(${String(r.svcRulesNotMoved).slice(0, 120)}) — 서비스 인벤토리 › 소속 규칙에서 경로를 고치십시오.` };
  return { ok: true, text };
}
