/**
 * util/logThrottle.js — '같은 내용이면 가끔만' 찍는 로그 조절기(v2.583, 순수).
 *
 * 왜: 중앙의 `[central] gpu-guest-data 수신: agent=… hosts=0 vms=0` 은 엣지마다 인벤토리 주기(기본 60초)로
 * 찍혀 엣지 28곳이면 **하루 약 4만 줄**이다. 사용자가 폐쇄망에서 화면 덤프로 보낸 저널 100줄(43초분)의
 * 대부분이 이 줄이었다 — 필요한 줄(실패·불일치)이 화면에서 밀려난다. 수신·저장은 그대로 두고 **로그만**
 * 값이 바뀌었을 때 + `windowMs`(기본 1시간)마다 한 번 찍는다. 상태 확인은 해당 기능의 진단 화면이 한다.
 *
 * 유계: 키 상한(기본 1,000)을 넘으면 가장 오래된 키부터 버린다(엣지 이름은 유한하지만 방어).
 */
export function createChangeLogger({ windowMs = 3_600_000, maxKeys = 1_000 } = {}) {
  const seen = new Map(); // key -> { sig, at }
  return function shouldLog(key, sig, now = Date.now()) {
    const k = String(key ?? '');
    const s = String(sig ?? '');
    const prev = seen.get(k);
    if (prev && prev.sig === s && now - prev.at < windowMs) return false;
    if (prev) seen.delete(k);
    seen.set(k, { sig: s, at: now });
    while (seen.size > maxKeys) seen.delete(seen.keys().next().value);
    return true;
  };
}
