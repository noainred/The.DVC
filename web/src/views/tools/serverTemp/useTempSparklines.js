/**
 * useTempSparklines — 표·이상 목록에 보이는 행의 24시간 추이를 **순차 배치**로 불러온다(v2.556).
 *
 * `CapacityTools.jsx` 의 `useSparklines`(v2.375·v2.502)와 같은 패턴이다. 그 규약을 그대로 지킨다:
 *  · **순차** 배치 — 한꺼번에 보내지 않는다. 배치 크기는 **서버가 준 `maxItems`** 로 맞춘다
 *    (화면에 숫자를 하드코딩하지 않는다 — sparkBatch.js 머리말).
 *  · `asked` Set 으로 '아직 순서가 안 온 것(…)' 과 '물어봤는데 없는 것(—)' 을 **구분**한다.
 *    둘 다 '…' 로 보이면 사용자는 고장인지 대기인지 알 수 없다(v2.502 가 고친 실제 결함).
 *  · `dead` 가드 — 뷰·필터가 바뀌어 언마운트된 뒤 늦은 응답이 상태를 덮지 않게.
 *  · 배치 하나가 실패해도 나머지는 계속한다. 실패한 키는 '물어봤다' 로 표시해 영원히 '…' 로
 *    남지 않게 한다(원인은 단정하지 않고 '—' 로 보인다).
 *
 * ⚠ 이 조회는 **우리 시계열 DB** 를 읽는다(vCenter SOAP 왕복 0). 그래도 순차인 이유는 응답
 *   크기와 DB 조회 횟수이며, 200행 상한(`SPARK_ROW_CAP`)은 표가 커질 때의 안전장치다.
 */
import { useEffect, useState } from 'react';
import { postJson } from '../../../api.js';
import { SPARK_ROW_CAP } from '../sparkBatch.js';

/**
 * @param {Array<{key:string, source:string}>} items  보이는 행(정렬·상한 적용 후)
 * @param {boolean} enabled
 */
export function useTempSparklines(items, enabled = true) {
  const [map, setMap] = useState({});          // key -> points | null
  const [metric, setMetric] = useState({});    // key -> 실제로 쓴 메트릭(계열 이름 표시용)
  const [asked, setAsked] = useState(() => new Set());
  const [done, setDone] = useState(0);
  const [info, setInfo] = useState(null);      // { maxItems, capped, skipped, synthesized }

  const all = Array.isArray(items) ? items.filter((x) => x && x.key) : [];
  const list = all.slice(0, SPARK_ROW_CAP);
  // 키+출처를 합쳐 서명한다 — 뷰가 바뀌면 같은 키라도 계열이 달라지므로 다시 물어야 한다.
  const sig = list.map((x) => `${x.source}:${x.key}`).join(',');

  useEffect(() => {
    if (!enabled || !sig) { setMap({}); setMetric({}); setAsked(new Set()); setDone(0); setInfo(null); return undefined; }
    let dead = false;
    setMap({}); setMetric({}); setAsked(new Set()); setDone(0);
    (async () => {
      const pairs = sig.split(',').map((s) => { const i = s.indexOf(':'); return { source: s.slice(0, i), key: s.slice(i + 1) }; });
      let size = 50;           // 첫 배치는 서버 상한을 모르므로 보수적으로. 응답의 maxItems 로 맞춘다.
      let i = 0;
      let skipped = 0;
      while (i < pairs.length && !dead) {
        const batch = pairs.slice(i, i + size);
        try {
          const r = await postJson('/tools/esxi-temp/spark', { items: batch });
          if (dead) return;
          if (Number(r.maxItems) > 0) size = Number(r.maxItems);
          skipped += Number(r.skipped) || 0;
          setMap((m) => ({ ...m, ...(r.series || {}) }));
          setMetric((m) => ({ ...m, ...(r.metricByKey || {}) }));
          setInfo({ maxItems: r.maxItems, capped: !!r.capped, skipped, synthesized: !!r.synthesized });
        } catch {
          if (dead) return;
          // 이 배치만 실패 — 계속 간다. 다만 '물어봤다' 로 남겨 대기(…)와 구분한다.
        }
        setAsked((prev) => { const n = new Set(prev); for (const b of batch) n.add(b.key); return n; });
        i += batch.length;
        if (!dead) setDone(i);
      }
    })();
    return () => { dead = true; };
  }, [sig, enabled]);

  return {
    map, metric, asked, info,
    progress: { done, total: list.length, skipped: info?.skipped || 0 },
    totalRows: all.length,
  };
}
