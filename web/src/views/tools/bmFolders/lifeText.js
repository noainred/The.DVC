/**
 * 물리서버 부품 수명 지표 화면 글자(v3.51 · 시안 docs/design/bm-feature-proposals ⑧). 순수 — 판정은 서버가 한다(idrac/partLife.js).
 *  · SSD 잔여 수명: 장비가 보고한 값(0~100 %) · 못 읽음은 ‘—’(0 이 아니다) · 낮음 · 같은 모델 대비 낮음은 서버가 정한 표지(low · gap)를 그대로.
 *  · 메모리 교정 오류: 이벤트 로그(SEL)의 교정 오류 **경고 기록** 수 — 오류 건수 자체가 아니다. 읽은 기록이 기간을 다 덮지 못하면 0 을 ‘없음’ 으로 쓰지 않는다.
 *  · 값이 없으면 단위를 붙이지 않는다 · 문구에 백틱을 쓰지 않는다.
 */
import { numOrNull } from '../../../numOrNull.js';

export const LIFE_NOTE = '장비가 보고한 SSD 잔여 수명입니다(iDRAC · iLO 판에 따라 값을 주지 않는 장비가 있습니다). 지난 기간의 추세는 저장하지 않습니다 — 같은 서버 · 같은 모델 SSD 와 견줘 혼자 빨리 닳은 것을 밝힙니다. 장애 판정이 아니라 교체 계획을 돕는 값입니다.';
export const MEMCE_NOTE = '이벤트 로그의 메모리 교정 오류 경고 기록 수입니다 — 오류 건수 자체가 아닙니다(장비가 오류가 잦을 때 남기는 경고를 셉니다). 장애 판정은 물리 부품 장애가 합니다.';
const pct = (v) => { const n = numOrNull(v); return n == null ? '—' : `${n}%`; };

/**
 * /hw 응답(d) → 구역 모델. 이 노드 서버는 SSD 한 개씩(detail.life), 엣지 · 요약만 받은 서버는 요약(summary.disk.life).
 * @returns {null | { kind:'rows'|'summary'|'none'|'unread', rows?:Array, head:string, why?:string }}
 */
export function lifeView(d) {
  if (!d || typeof d !== 'object' || d.kind !== 'bm') return null;
  const det = d.detail && typeof d.detail === 'object' ? d.detail : null;
  if (det) {
    if (!Array.isArray(det.life)) return { kind: 'unread', head: '디스크 목록을 읽지 못했습니다', why: '인벤토리에서 디스크 목록을 읽지 못해 수명 값을 볼 수 없습니다.' };
    if (!det.life.length) {
      // 매체를 모르는 디스크(빈칸 · NVMe 아님)가 있으면 ‘SSD 없음’ 으로 단정하지 않는다
      const unk = (Array.isArray(det.disks) ? det.disks : []).filter((g) => !/^(ssd|hdd|smr)$/i.test(String(g?.media || '').trim()) && !/nvme/i.test(String(g?.proto || ''))).reduce((a, g) => a + (numOrNull(g?.n) ?? 1), 0);
      return unk
        ? { kind: 'none', head: 'SSD 로 확인한 디스크 없음', why: `매체(SSD · HDD)를 장비가 알려 주지 않은 디스크 ${unk}개가 있어 SSD 인지 알 수 없습니다.` }
        : { kind: 'none', head: 'SSD 없음', why: '이 서버에는 SSD 가 없습니다(HDD 는 이 값이 없습니다).' };
    }
    const rows = det.life.slice(0, 64).map((x, i) => {
      const life = numOrNull(x?.life);
      const gap = numOrNull(x?.gap);
      const tone = life == null ? 'gray' : x.low ? 'red' : gap != null ? 'amber' : 'green';
      // 값 없음 — 읽기 전 판 인벤토리(stale)와 장비가 값을 주지 않음을 가른다(반증 B7)
      const note = life == null ? (x?.stale ? '값 없음 — 수명 값을 읽기 전 판의 인벤토리입니다(다시 읽은 뒤 보입니다)' : '장비가 값을 주지 않았습니다')
        : x.low ? '낮음 — 교체 계획 대상' : gap != null ? `같은 모델 SSD 가운데값보다 ${gap}%p 낮습니다 — 혼자 빨리 닳고 있습니다` : '';
      return { key: `${x?.name || ''}:${i}`, name: String(x?.name || '—'), model: String(x?.model || ''), gb: numOrNull(x?.gb), life, lifeText: pct(life), tone, note };
    });
    const vals = rows.map((x) => x.life).filter((x) => x != null);
    const head = vals.length ? `SSD ${rows.length}개 · 가장 낮은 값 ${Math.min(...vals)}%${vals.length < rows.length ? ` · 값 없음 ${rows.length - vals.length}` : ''}` : `SSD ${rows.length}개 · 값 없음`;
    return { kind: 'rows', rows, head };
  }
  const life = d.summary?.disk?.life;
  if (life && typeof life === 'object') {
    const n = numOrNull(life.n); const read = numOrNull(life.read); const min = numOrNull(life.min);
    if (n == null) return { kind: 'unread', head: '—', why: '요약에 수명 값이 없습니다.' };
    return { kind: 'summary', head: read ? `SSD ${n}개 중 ${read}개 읽음 · 가장 낮은 값 ${pct(min)}` : `SSD ${n}개 · 값 없음`, why: '엣지 · 수집 서버가 맡은 서버는 요약만 받습니다(SSD 한 개씩은 그쪽 포탈에서 봅니다).' };
  }
  const dk = d.summary?.disk;
  if (d.summary && (!dk || typeof dk !== 'object')) return { kind: 'unread', head: '—', why: '이 서버의 디스크 목록을 읽지 못해 수명 값을 볼 수 없습니다.' };   // 반증 B11
  if (dk && numOrNull(dk.ssd) === 0 && numOrNull(dk.nvme) === 0) {
    const unk = (numOrNull(dk.n) ?? 0) - (numOrNull(dk.hdd) ?? 0);
    return unk > 0
      ? { kind: 'none', head: 'SSD 로 확인한 디스크 없음', why: `매체(SSD · HDD)를 장비가 알려 주지 않은 디스크 ${unk}개가 있어 SSD 인지 알 수 없습니다.` }
      : { kind: 'none', head: 'SSD 없음', why: '이 서버에는 SSD 가 없습니다.' };
  }
  return { kind: 'unread', head: '—', why: d.summary ? '이 서버를 맡은 엣지가 수명 요약을 보내지 않았습니다(엣지가 이 판보다 낮거나, 아직 이 판으로 다시 읽지 않았을 수 있습니다).' : '하드웨어 요약이 없어 수명 값을 볼 수 없습니다.' };
}

/**
 * /hwlog 응답의 memCe → 줄 모델. 없으면 null(못 읽음 · 구버전).
 * @returns {null | { head:string, slots:Array<{slot:string, n:number}>, unknown:number, covered:boolean, note:string }}
 */
export function memCeView(m) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.slots)) return null;
  const days = numOrNull(m.days) ?? 30;
  const total = numOrNull(m.total) ?? 0;
  const slots = m.slots.filter((x) => Array.isArray(x) && typeof x[0] === 'string').slice(0, 64).map((x) => ({ slot: x[0], n: numOrNull(x[1]) ?? 0 }));
  const covered = m.covered === true;
  const unknown = numOrNull(m.unknownSlot) ?? 0;
  // 다 덮지 못했으면 건수도 ‘읽은 기록 안’ 의 것이다 — 30일 전체 건수처럼 쓰지 않는다(반증 B8)
  const head = covered ? (total ? `지난 ${days}일 경고 기록 ${total}건` : `지난 ${days}일 경고 기록 없음`)
    : (total ? `읽은 기록 안 경고 기록 ${total}건(지난 ${days}일을 다 읽지 못함)` : '읽은 기록 안에는 경고 기록 없음');
  const note = covered ? '' : `읽은 기록이 지난 ${days}일을 다 덮지 못했습니다 — 건수는 읽은 범위 안의 것이고, 0 은 ‘읽은 범위 안에 없음’ 이지 ‘없음’ 이 아닙니다.`;
  return { head, slots, unknown, covered, note };
}
