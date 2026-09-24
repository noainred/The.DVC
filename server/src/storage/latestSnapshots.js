/**
 * storage/latestSnapshots.js — 로컬 수집분 + 엣지 push 분을 장비(deviceId)마다 **최신 collectedAt 하나**로 합친다
 * (v2.599 EDGE2599-02 — 순수 모듈).
 *
 * 내부 스토리지 모니터링(`routes/api/storageMon.js`)이 인라인으로 갖던 규칙을 꺼냈다. 공개 API
 * `/api/v1/capacity/storage` 는 주석에 '같은 조합' 이라 적어 놓고 두 배열을 **그냥 이어 붙여** 같은 장비가
 * 두 행으로 나갔다(재배정 직후·엣지 잔존 push). 판정이 두 벌이면 다시 갈라진다 — 여기 하나를 쓴다.
 *
 * 규칙: 뒤 목록이 같은 시각이면 앞 것을 유지한다(예전 인라인과 같은 `>` 비교). collectedAt 이 없으면 0 으로 비교한다
 * (정렬 키일 뿐 값으로 내보내지 않는다). deviceId 가 없는 원소는 합칠 근거가 없어 **버리지 않고** 그대로 둔다.
 */
// 비교용 시각 — epoch ms 숫자가 기본이고 ISO 문자열도 받는다(숫자 문자열은 Date.parse 에 넘기지 않는다 — v2.562).
function tsOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v !== 'string' || v.trim() === '') return 0;
  if (/^\d+$/.test(v.trim())) return Number(v);
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

export function latestByDevice(lists = []) {
  const byId = new Map();
  const noId = [];
  for (const list of lists) {
    for (const s of Array.isArray(list) ? list : []) {
      if (!s || typeof s !== 'object') continue;
      const id = s.deviceId;
      if (id == null || id === '') { noId.push(s); continue; }
      const cur = byId.get(id);
      if (!cur || tsOf(s.collectedAt) > tsOf(cur.collectedAt)) byId.set(id, s);
    }
  }
  return [...byId.values(), ...noId];
}

/** 같은 규칙의 Map 판(deviceId → 스냅샷) — 등록부와 대조하는 화면용. */
export function latestMapByDevice(lists = []) {
  const m = new Map();
  for (const s of latestByDevice(lists)) if (s.deviceId != null && s.deviceId !== '') m.set(s.deviceId, s);
  return m;
}
