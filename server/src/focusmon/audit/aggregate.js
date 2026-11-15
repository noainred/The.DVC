/**
 * focusmon/audit/aggregate.js — 디스크 점검 ‘묶어 보기’(v3.11.0 — 사용자 '법인별로 보는 기능, 모델별로 보는 기능 등' · '법인별로 디스크 모델별로 보는 기능')
 * 순수 집계 하나. 화면은 이 결과만 그린다(웹에 같은 집계를 두지 않는다 — 판정 코어 하나).
 *
 *  · 서버 행(auditRow) → 법인별 · 서버 모델별 · 그룹별(같은 모양) · 디스크 모델별 · 법인 × 디스크 모델(두 방향).
 *  · 숫자는 **끝까지 돈 점검(outcome 'done')** 만 더한다 — 시한 초과 · 중단 · 오류 회차의 일부 숫자를 합계에 넣지 않는다(‘—’ 와 0 을 섞지 않는다).
 *  · 디스크는 식별자(SN · WWN)로 하나씩 센다(summarize 가 이미 하나로 묶었다). 식별자가 없어 디스크에 붙이지 못한 근거는 디스크 모델 집계에 넣지 않고 따로 센다.
 *  · 비율은 디스크 10개 이상일 때만(`RATE_MIN_DISKS`) — 그 밖은 '기록 있는 수 / 본 수'.
 */
export const RATE_MIN_DISKS = 10;
export const NO_CORP = '법인 미지정';
export const NO_MODEL = '모델 모름';
export const NO_GROUP = '그룹 없음';

const doneOf = (r) => (r.last && r.last.outcome === 'done' ? r.last : null);
const notReady = (r) => !!(r.ready && r.ready.state && r.ready.state !== 'ready');
const sum = (rows, k) => { let n = 0; let any = false; for (const r of rows) { const d = doneOf(r); if (d && Number.isFinite(d.summary?.counts?.[k])) { n += d.summary.counts[k]; any = true; } } return any ? n : null; };
const diskCount = (rows) => { let n = 0; let any = false; for (const r of rows) { const d = doneOf(r); if (d && Array.isArray(d.summary?.disks)) { n += d.summary.disks.length; any = true; } } return any ? n : null; };

/**
 * 같은 모양의 묶음(법인 · 서버 모델 · 그룹).
 * @param {object[]} rows  서버 행 {id, name, corp:{id,name}|null, smodel:string|null, group:string, ready, last, job}
 * @param {(r)=>{key:string, name:string}} keyOf
 * @param {string[]} order  이름 순서(앞에 둘 것 — 없는 이름은 뒤에 가나다순)
 */
export function groupRows(rows, keyOf, order = []) {
  const m = new Map();
  for (const r of rows) { const k = keyOf(r); if (!m.has(k.key)) m.set(k.key, { key: k.key, name: k.name, rows: [] }); m.get(k.key).rows.push(r); }
  const rank = (g) => { const i = order.indexOf(g.key); return i < 0 ? 1e6 : i; };
  return [...m.values()].sort((a, b) => rank(a) - rank(b) || (a.name === b.name ? 0 : a.name === NO_CORP || a.name === NO_MODEL || a.name === NO_GROUP ? 1 : b.name === NO_CORP || b.name === NO_MODEL || b.name === NO_GROUP ? -1 : a.name.localeCompare(b.name)))
    .map((g) => {
      const done = g.rows.filter(doneOf);
      const oldest = done.length ? Math.min(...done.map((r) => r.last.at)) : null;
      return {
        key: g.key, name: g.name, n: g.rows.length, done: done.length, notReady: g.rows.filter(notReady).length,
        hit: done.filter((r) => r.last.summary?.hit).length, media: sum(g.rows, 'media'), io: sum(g.rows, 'io'), realloc: sum(g.rows, 'realloc'),
        disks: diskCount(g.rows), oldestAt: oldest, never: g.rows.filter((r) => !r.last).length, ids: g.rows.map((r) => r.id),
        nodes: [...new Set(g.rows.map((r) => r.agent || ''))],
      };
    });
}

/** 서버 행의 물리 디스크(끝까지 돈 회차만) → [{model, size, media, bad, mediaN, reallocN, ioN, slot, sn}] */
function disksOf(r) {
  const d = doneOf(r);
  if (!d || !Array.isArray(d.summary?.disks)) return [];
  return d.summary.disks.map((x) => ({ model: x.model || NO_MODEL, size: x.size || '', media: x.media || '', mediaN: x.mediaN | 0, reallocN: x.reallocN | 0, ioN: x.ioN | 0, label: x.label || '', bad: (x.mediaN | 0) + (x.reallocN | 0) + (x.ioN | 0) > 0 }));
}
const kindText = (list) => {
  const c = new Map(); for (const d of list) { const k = [d.media, d.size].filter(Boolean).join(' · '); if (k) c.set(k, (c.get(k) || 0) + 1); }
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
};
function foldDisks(parts) {
  const all = parts.flatMap((p) => p.disks);
  const bad = all.filter((d) => d.bad);
  return {
    n: all.length, bad: bad.length, mediaN: all.reduce((a, d) => a + d.mediaN, 0), reallocN: all.reduce((a, d) => a + d.reallocN, 0), ioN: all.reduce((a, d) => a + d.ioN, 0),
    servers: new Set(parts.filter((p) => p.disks.length).map((p) => p.row.id)).size, kind: kindText(all),
    where: bad.slice(0, 4).map((d) => `${d.srv} ${d.label}`.trim()), rate: all.length >= RATE_MIN_DISKS ? Math.round((bad.length / all.length) * 1000) / 10 : null,
  };
}

/** 디스크 모델별. */
export function byDiskModel(rows, corpName = (r) => (r.corp ? r.corp.name : NO_CORP)) {
  const m = new Map();
  for (const r of rows) for (const d of disksOf(r)) {
    if (!m.has(d.model)) m.set(d.model, []);
    m.get(d.model).push({ row: r, disks: [{ ...d, srv: r.name }] });
  }
  return [...m.entries()].map(([model, parts]) => ({ model, ...foldDisks(parts), corps: [...new Set(parts.map((p) => corpName(p.row)))] }))
    .sort((a, b) => b.bad - a.bad || b.n - a.n || a.model.localeCompare(b.model));
}

/**
 * 법인 × 디스크 모델 — outer 'corp'(법인 아래 모델) | 'model'(모델 아래 법인).
 * 법인 머리에는 결과가 없는 서버 이름을 함께 싣는다(‘다 본 것이 아님’ 을 밝힌다).
 */
export function crossCorpModel(rows, outer = 'corp', { corpKey = (r) => (r.corp ? r.corp.id : ''), corpName = (r) => (r.corp ? r.corp.name : NO_CORP), corpOrder = [] } = {}) {
  const cells = [];
  for (const r of rows) for (const d of disksOf(r)) cells.push({ row: r, corp: corpKey(r), corpName: corpName(r), model: d.model, disk: { ...d, srv: r.name } });
  if (outer === 'model') {
    const models = [...new Set(cells.map((c) => c.model))];
    return models.map((model) => {
      const mine = cells.filter((c) => c.model === model);
      const corps = [...new Set(mine.map((c) => c.corp))];
      const total = foldDisks(mine.map((c) => ({ row: c.row, disks: [c.disk] })));
      return {
        key: model, name: model, total, corps: corps.length,
        rows: corps.map((ck) => { const part = mine.filter((c) => c.corp === ck); return { key: ck, name: part[0].corpName, ...foldDisks(part.map((c) => ({ row: c.row, disks: [c.disk] }))), serverNames: [...new Set(part.map((c) => c.row.name))] }; })
          .sort((a, b) => b.bad - a.bad || b.n - a.n),
      };
    }).sort((a, b) => b.total.bad - a.total.bad || b.total.n - a.total.n);
  }
  const groups = groupRows(rows, (r) => ({ key: corpKey(r), name: corpName(r) }), corpOrder);
  return groups.map((g) => {
    const mine = cells.filter((c) => c.corp === g.key);
    const models = [...new Set(mine.map((c) => c.model))];
    const total = foldDisks(mine.map((c) => ({ row: c.row, disks: [c.disk] })));
    const noResult = rows.filter((r) => corpKey(r) === g.key && !doneOf(r)).map((r) => r.name);
    return {
      key: g.key, name: g.name, n: g.n, done: g.done, total, noResult,
      rows: models.map((mk) => { const part = mine.filter((c) => c.model === mk); return { key: mk, name: mk, ...foldDisks(part.map((c) => ({ row: c.row, disks: [c.disk] }))), serverNames: [...new Set(part.map((c) => c.row.name))] }; })
        .sort((a, b) => b.bad - a.bad || b.n - a.n),
    };
  });
}

/** 요약 4칸. */
export function auditKpis(rows) {
  const done = rows.filter(doneOf);
  const reasons = {};
  for (const r of rows) if (notReady(r)) reasons[r.ready.state] = (reasons[r.ready.state] || 0) + 1;
  return {
    servers: rows.length, done: done.length, hit: done.filter((r) => r.last.summary?.counts?.media > 0).length, anyHit: done.filter((r) => r.last.summary?.hit).length,
    notReady: rows.filter(notReady).length, notReadyBy: reasons, running: rows.filter((r) => r.job && r.job.state === 'running').length, queued: rows.filter((r) => r.job && r.job.state !== 'running').length,
  };
}
