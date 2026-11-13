/**
 * 엣지 포탈 물리서버 폴더 화면 계산(순수 — v2.996 · 설계 bm-folders §11). 판정은 중앙(사본의 배치) — 여기는 묶고 세기만.
 */
import { ageText } from '../bmFoldersText.js';

const under = (p, base) => p === base || String(p).startsWith(`${base}\\`);

/** 법인 › 폴더 트리(깊이 · 하위 포함 대수 · 폴더에 걸린 서비스 — 가장 긴 접두). */
export function edgeFolderRows(corps = [], servers = []) {
  return corps.map((c) => {
    const mine = servers.filter((s) => s.corp === c.vcenterId);
    const folders = [...(c.folders || [])].sort((a, b) => a.localeCompare(b, 'ko')).map((p) => {
      const parts = p.split('\\');
      const svc = (c.services || []).filter((x) => under(p, x.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
      return { path: p, label: parts[parts.length - 1], depth: parts.length - 1, n: mine.filter((s) => s.path && under(s.path, p)).length, service: svc ? svc.service : '' };
    });
    return { vcenterId: c.vcenterId, name: c.name || c.vcenterId, n: mine.length, unplaced: mine.filter((s) => !s.path).length, folders };
  });
}

/** 고른 법인 · 폴더(하위 포함) · 거르기 글자. path '\u0000' = 미분류. */
export function edgeRowsOf(servers = [], sel = {}, q = '') {
  const toks = String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  return servers.filter((s) => {
    if (sel.corp && s.corp !== sel.corp) return false;
    if (sel.path === '\u0000' && s.path) return false;
    if (sel.path && sel.path !== '\u0000' && !(s.path && under(s.path, sel.path))) return false;
    if (!toks.length) return true;
    const hay = `${s.name || ''} ${s.model || ''}`.toLowerCase();
    return toks.every((t) => hay.includes(t));
  });
}

/** 사본 상태 문구 — 받은 적 없음 · 나이 · 마지막 받기 실패(사본은 그대로). 숫자(주기)는 응답 값. */
export function edgeCopyNote(d = {}, now = Date.now()) {
  const last = d.pull?.last || null;
  const failed = last && last.ok === false && last.at;
  if (d.copyError) return { text: '사본을 읽지 못했습니다', warn: '사본 파일이 손상돼 보존본을 남겼습니다 — 다음 받기(또는 지금 받기)가 새로 씁니다.' };
  if (!d.copy) return { text: '중앙 사본을 아직 받지 않았습니다', warn: failed ? `마지막 받기 실패(${ageText(last.at, now)})${last.error ? ` — ${last.error}` : ''}` : '' };
  const text = `사본 ${ageText(d.copy.savedAt, now)} 받음`;
  return { text, warn: failed ? `마지막 받기 실패(${ageText(last.at, now)}) — 지난 사본을 그대로 보입니다${last.error ? ` · ${last.error}` : ''}` : '' };
}
