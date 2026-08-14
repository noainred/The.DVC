/**
 * svcmon/tree.js — 성능점검 트리/집계 순수 함수(v2.295, 1차 감사 확정 #1).
 * SvcMonitor.jsx 125~177행(buildTree·statsOf·matchNode) + 350~358행(summary 집계 → summarize)
 * 에서 추출(React/DOM 무의존) — vitest(tree.test.js)로 고정한다.
 *
 * 왜 고정하는가: v2.279 실버그가 정확히 이 집계였다 — 과거 ok/warn/bad 만 세고 나머지
 * (stale·pending)를 전부 disabled 에 합산해, '갱신 안 됨'(폴러 기아 감시 공백)이 '중지
 * (정상 설정)'로 위장됐다. 이 화면엔 그동안 테스트가 0건이라 같은 류의 회귀를 잡을 장치가
 * 없었다(1차 감사가 지목한 유일한 테스트 가능 지점).
 */
import { statusOf } from './constants.js';

export function buildTree(targets, folders = [], sortMode = 'manual') {
  const root = { id: '', name: 'Root', children: new Map(), targets: [] };
  const ensure = (p) => {
    let node = root;
    for (const seg of (p || '').split('\\').filter(Boolean)) {
      if (!node.children.has(seg)) node.children.set(seg, { id: node.id ? `${node.id}\\${seg}` : seg, name: seg, children: new Map(), targets: [] });
      node = node.children.get(seg);
    }
    return node;
  };
  for (const f of folders) ensure(f.path);          // 대상이 없어도 보이는 폴더
  for (const t of targets) ensure(t.path).targets.push(t);
  if (sortMode === 'name') {                        // 이름순 정렬(폴더·대상 모두)
    const sortNode = (n) => {
      n.children = new Map([...n.children.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko')));
      n.targets.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
      for (const c of n.children.values()) sortNode(c);
    };
    sortNode(root);
  } else {
    // 수동 정렬 — order 필드로 정렬한다. 대상 order 는 생성 시 Date.now() 라 기본은 생성순(=기존 동작)
    // 이고, 재정렬하면 그 폴더 대상에 0..n 이 부여된다. 폴더는 order 가 있으면 그 값, 없으면 folders
    // 배열 인덱스(=기존 표시 순서)로 정렬해 재정렬 전 순서를 그대로 보존한다.
    const fOrder = new Map();
    folders.forEach((f, i) => fOrder.set(f.path, f.order != null ? f.order : i));
    const ord = (id) => (fOrder.has(id) ? fOrder.get(id) : Number.MAX_SAFE_INTEGER);
    const sortNode = (n) => {
      n.children = new Map([...n.children.entries()].sort((a, b) => (ord(a[1].id) - ord(b[1].id)) || a[0].localeCompare(b[0], 'ko')));
      n.targets.sort((a, b) => ((a.order ?? 0) - (b.order ?? 0)) || a.name.localeCompare(b.name, 'ko'));
      for (const c of n.children.values()) sortNode(c);
    };
    sortNode(root);
  }
  return root;
}
export function statsOf(node) {
  let alarms = 0, worst = 'none';
  // stale(갱신 안 됨)도 조치가 필요한 상태다 — 알람 수에 포함하고 최악 상태 순위에도 넣는다.
  const rank = { bad: 4, stale: 3, warn: 2, ok: 1, pending: 0, none: 0, disabled: 0 };
  const visit = (n) => {
    for (const t of n.targets) for (const x of t.tests) {
      const st = statusOf(t, x);
      if (st === 'bad' || st === 'warn' || st === 'stale') alarms += 1;
      if (rank[st] > rank[worst]) worst = st;
    }
    for (const c of n.children.values()) visit(c);
  };
  visit(node);
  return { alarms, worst };
}
export const matchNode = (node, q) => !q || node.name.toLowerCase().includes(q)
  || node.targets.some((t) => t.name.toLowerCase().includes(q) || (t.host || '').toLowerCase().includes(q))
  || [...node.children.values()].some((c) => matchNode(c, q));

/**
 * KPI 요약 집계 — 서버 status 와 동일한 6개 상태 키(ok/warn/bad/stale/pending/disabled)로
 * 정확히 센다. SvcMonitor.jsx 350~358행 IIFE 에서 추출(로직 무변).
 * ⚠ 회귀 방지(v2.279): 알 수 없는 상태는 disabled 가 아니라 **pending** 으로 — 감시 공백을
 *   '의도적 중지'로 위장하지 않는다(tree.test.js 가 이 의미론을 고정).
 */
export function summarize(targets) {
  const s = { total: 0, ok: 0, warn: 0, bad: 0, stale: 0, pending: 0, disabled: 0 };
  for (const t of targets) for (const x of t.tests) {
    s.total += 1;
    const st = statusOf(t, x);
    if (st !== 'total' && s[st] !== undefined) s[st] += 1; else s.pending += 1;
  }
  return s;
}
