// dbg3231(4회차) — ‘그 밖 N개’ 묶음 회귀:
//   ① packLayout 이 작은 칸을 묶은 뒤 다시 놓을 때, 묶음 칸(크기 = 구성원 합)이 끼어들어 작은 열 경계가 옮겨지고 한쪽 폭이 MIN_SUBCOL_W 아래로
//      떨어지면 1열로 돌아갔다 — 첫 배치에서 이름이 보이던 칸이 글 없음이 됐는데 묶음에도 없어 이름 · 값이 어디에도 보이지 않았다
//      (지역 폭 246px · 38칸 · 520px → CL10 ~ CL13). → 다시 놓은 뒤 묶음 밖 글 없는 칸은 묶음에 더하고 다시 놓는다.
//   ② 묶음 칸 tip 이 대표가 오래된 값일 때도 ‘오래됨 N(색에 넣지 않음)’ 이라 같은 tip 의 ‘색은 가장 높은 값(A — 값이 오래됨)’ 과 어긋났다
//      → groupCountsText(repStale) — 그때는 모름 수에만 ‘색에 넣지 않음’. VM · Hypervisor 두 groupView 가 같은 함수를 쓴다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';
import { treemapLayout } from './treemap.js';
import { packLayout, worstMember, groupCountsText, MIN_SUBCOL_W } from './tilePack.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => stripComments(fs.readFileSync(path.join(HERE, f), 'utf8'));

const subCols = (col) => new Set(col.tiles.map((t) => t.left.toFixed(4))).size;
const orphansOf = (P) => P.cols.flatMap((c) => c.tiles).filter((t) => !t.group && t.tier === 'none');

describe('① 묶은 뒤 다시 놓기 — 묶음 밖에 글 없는 칸이 남지 않는다', () => {
  const sizes = [54, 52, 50, 47, 45, 37, 36, 33, 29, 27, 24, 21, 19, 16, 9, 8, 7, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1];
  const layout = treemapLayout([{ key: 'EU', items: sizes.map((s, i) => ({ id: `c${i}`, label: `CL${i}`, size: s })) }]);

  it('재현 배치(246px · 38칸 · 520px) — 묶기 전 2열에서 이름이 보이던 CL10 ~ CL13 이 묶음 밖 글 없음이 되지 않는다', () => {
    const a = packLayout(layout, { widthPx: 246, heightPx: 520, group: false });
    expect(subCols(a.cols[0])).toBe(2);
    const readA = new Set(a.cols[0].tiles.filter((t) => t.tier !== 'none').map((t) => t.id));
    for (const id of ['c10', 'c11', 'c12', 'c13']) expect(readA.has(id)).toBe(true);
    const b = packLayout(layout, { widthPx: 246, heightPx: 520 });
    expect(orphansOf(b)).toEqual([]);
    // 지도에 없는 칸은 모두 묶음 구성원이다(이름 · 값을 목록에서 볼 수 있다)
    const shown = new Set(b.cols[0].tiles.filter((t) => !t.group).map((t) => t.id));
    const inGroup = new Set(b.groups.flatMap((g) => g.members.map((m) => m.id)));
    for (let i = 0; i < sizes.length; i++) expect(shown.has(`c${i}`) !== inGroup.has(`c${i}`)).toBe(true);
    // 묶음 칸의 크기 · 이름은 늘어난 구성원 수와 맞는다
    const g = b.cols[0].tiles.find((t) => t.group);
    expect(g.members.length).toBe(b.groups[0].members.length);
    expect(g.label).toBe(`그 밖 ${g.members.length}개`);
    expect(g.size).toBe(g.members.reduce((s, m) => s + m.size, 0));
    expect(b.groups[0].size).toBe(g.size);
    // 작은 열 폭 하한은 그대로
    const byX = new Map(); for (const t of b.cols[0].tiles) byX.set(t.left.toFixed(4), t.wPx);
    if (byX.size > 1) for (const w of byX.values()) expect(w).toBeGreaterThanOrEqual(MIN_SUBCOL_W - 1e-6);
  });

  it('무작위(지역 하나 15 ~ 25칸 · 폭 200 ~ 320px · 높이 4종) — group:false 에서 이름이 보이던 칸이 group:true 결과에서 묶음 밖 none 이 되지 않는다', () => {
    let seed = 3; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const cities = ['Dubai', 'Seoul', 'Tokyo', 'Paris', 'Rome', 'Lima', 'Oslo'];
    let grouped = 0;
    for (let it = 0; it < 1500; it++) {
      const n = 15 + Math.floor(rnd() * 11);
      const items = Array.from({ length: n }, (_, i) => ({ id: `c${i}`, label: `${cities[i % 7]}-CL${1 + Math.floor(i / 7)}`, size: 1 + Math.floor(rnd() ** 2 * 40) }));
      const W = 200 + Math.floor(rnd() * 121); const H = [360, 520, 760, 1200][Math.floor(rnd() * 4)];
      const L = treemapLayout([{ key: 'R', items }]);
      const b = packLayout(L, { widthPx: W, heightPx: H });
      if (!b.groups.length) continue;
      grouped++;
      const a = packLayout(L, { widthPx: W, heightPx: H, group: false });
      const readA = new Set(a.cols[0].tiles.filter((t) => t.tier !== 'none').map((t) => t.id));
      const lost = orphansOf(b).filter((t) => readA.has(t.id));
      expect(lost.map((t) => `${t.label} · ${W}px · ${H}px`)).toEqual([]);
      expect(orphansOf(b)).toEqual([]);
    }
    expect(grouped).toBeGreaterThan(500);   // 시험이 실제로 묶음 경로를 탄다
  });
});

describe('② 묶음 칸 tip — 대표가 오래된 값이면 ‘오래됨’ 수에 ‘색에 넣지 않음’ 을 붙이지 않는다', () => {
  it('groupCountsText — repStale 이면 오래됨은 ‘오래된 값으로 칠함’ · 모름만 ‘색에 넣지 않음’ · 아니면 예전 문구', () => {
    expect(groupCountsText(2, 1, true)).toBe(' · 오래됨 2(지금 값이 없어 오래된 값으로 칠함) · 모름 1(색에 넣지 않음)');
    expect(groupCountsText(2, 0, true)).toBe(' · 오래됨 2(지금 값이 없어 오래된 값으로 칠함)');
    expect(groupCountsText(2, 1, false)).toBe(' · 오래됨 2 · 모름 1(색에 넣지 않음)');
    expect(groupCountsText(0, 3, false)).toBe(' · 모름 3(색에 넣지 않음)');
    expect(groupCountsText(0, 0, false)).toBe('');
    expect(groupCountsText(null, undefined, false)).toBe('');
  });
  it('재현(A 오래됨 90 · B 모름 · C 오래됨 40) — 색의 근거 A 가 ‘색에 넣지 않음’ 으로 세이지 않는다', () => {
    const members = [{ label: 'A', size: 5, row: { stale: true, cpu: 90 } }, { label: 'B', size: 3, row: { stale: false, cpu: null } }, { label: 'C', size: 2, row: { stale: true, cpu: 40 } }];
    const isStale = (m) => m.row?.stale === true;
    const { member, value } = worstMember(members, (m) => m.row.cpu, isStale);
    expect(member.label).toBe('A');
    const repStale = !!member && isStale(member) && value != null;
    const txt = groupCountsText(members.filter(isStale).length, members.filter((m) => m.row.cpu == null).length, repStale);
    expect(txt).not.toMatch(/오래됨 2\(색에 넣지 않음\)|오래됨 2 · 모름 1\(색에 넣지 않음\)/);
    expect(txt).toContain('오래됨 2(지금 값이 없어 오래된 값으로 칠함)');
  });
  it('VM · Hypervisor groupView 가 groupCountsText(staleN, unknownN, repStale) 를 쓰고 옛 조립식(counts + 색에 넣지 않음)이 없다', () => {
    for (const f of ['../vms/VmInsight.jsx', '../hosts/HostInsight.jsx']) {
      const s = read(f);
      expect(s).toMatch(/groupCountsText\(staleN, unknownN, repStale\)/);
      expect(s).not.toMatch(/counts\s*\?\s*` · \$\{counts\}\(색에 넣지 않음\)`/);
    }
  });
});
