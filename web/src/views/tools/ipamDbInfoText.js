// v2.732(점검 2회차 B3-08 후속): IP관리 KPI '공유 DB 레코드' 카드 값·부가 문구.
// 서버(/admin/ipam/db-info)는 범위 계정에 count:null + fleetCountsHidden:true 를 준다(전 법인 원장 행 수는 전 함대 값이다 — v2.629 규약).
// 원장 DB 를 못 쓰는 경로(잠금·NDJSON 폴백)도 count:null 이다. 예전 화면은 db.count.toLocaleString() 이라 이 경우 화면 전체가 TypeError 로 죽었다.
import { numOrNull } from '../../numOrNull.js';

/** 카드 값 — 모르면 '—'(0 이 아니다). */
export function dbCountText(db) {
  const n = numOrNull(db?.count);
  return n == null ? '—' : n.toLocaleString();
}

/** 카드 부가 문구 — 저장 방식(SQLITE·NDJSON)과, 값이 비면 그 이유. */
export function dbMetaText(db) {
  const kind = String(db?.kind || '').toUpperCase();
  if (db?.fleetCountsHidden) return `${kind ? `${kind} · ` : ''}전 법인 합계라 범위 계정에는 보이지 않습니다`;
  if (numOrNull(db?.count) == null) return `${kind ? `${kind} · ` : ''}레코드 수를 읽지 못했습니다`;
  return kind || '—';
}
