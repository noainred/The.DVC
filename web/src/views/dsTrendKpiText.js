/**
 * dsTrendKpiText.js — Platform '스토리지 증가 추이' 카드의 부제(v2.631 감사 WEB2631-09, 순수).
 *
 * vmtrack(v2.601 LO2601-05)은 사용량을 읽은 데이터스토어가 없는 슬롯의 사용률을 **null** 로 준다. 예전 카드는
 * `Math.round(dsUsagePct || 0)` 로 그것을 '(0%)' 로, 용량 합 0 인 슬롯을 '사용 0 / 0 TB' 로 그렸다 — '비어 있다' 는 거짓이다.
 * 값이 없으면 '—' 이고, 사용량을 읽은 DS 가 하나도 없으면 사용/용량 대신 그 사실(+ 미상 개수)을 말한다.
 */
import { numOrNull } from '../numOrNull.js';
import { tb, dsUnknownNote } from './tools/storageTrack.js';

export function dsTrendMeta(p) {
  if (!p) return '관측 전(다음 00·12시부터)';
  const cap = numOrNull(p.dsCapGB);
  const used = numOrNull(p.dsUsedGB);
  const pct = numOrNull(p.dsUsagePct);
  const unk = dsUnknownNote(p.dsUsedUnknown);
  if (cap == null || cap <= 0) {
    return `사용량을 읽은 데이터스토어 없음${unk ? ` · ${unk.short}` : ''}`;
  }
  const usedText = used == null ? '—' : tb(used).toLocaleString();
  const pctText = pct == null ? '—' : `${Math.round(pct)}%`;
  return `사용 ${usedText} / ${tb(cap).toLocaleString()} TB (${pctText})${unk ? ` · ${unk.short}` : ''}`;
}
