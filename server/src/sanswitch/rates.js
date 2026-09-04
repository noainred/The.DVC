/**
 * sanswitch/rates.js — 포트 처리량(속도) 계산(v2.410).
 *
 * FOS 는 포트별 **누적 카운터**만 준다(프레임 수·옥텟 수). '지금 몇 Gbps 인가'는 두 번의
 * 수집 사이 델타를 시간으로 나눠야 나온다. 그래서 직전 수집의 카운터를 인메모리로 들고 있다가
 * 다음 수집 때 차이를 낸다.
 *
 * 규칙(정직 표기):
 *  - **첫 수집은 null** 이다. 0 으로 채우면 '트래픽이 없다'로 오해된다.
 *  - 카운터가 줄어들면(스위치 재부팅·카운터 클리어·포트 재삽입) null 로 둔다 — 음수 델타를
 *    큰 양수로 착각해 말도 안 되는 속도를 보고하는 사고를 막는다.
 *  - 간격이 너무 짧거나(<5초) 너무 길면(>2시간) 신뢰할 수 없어 null.
 *  - 메모리에만 둔다. 재시작하면 첫 수집으로 되돌아간다(값이 틀리는 것보다 낫다).
 */

const MIN_GAP_MS = 5_000;
const MAX_GAP_MS = 2 * 60 * 60_000;
const _prev = new Map(); // deviceId → { at, ports: Map(portKey → {inFrames,outFrames,inBytes,outBytes}) }

function rate(prevVal, curVal, seconds) {
  if (prevVal == null || curVal == null) return null;
  const d = curVal - prevVal;
  if (d < 0) return null;                  // 카운터 리셋 — 추정하지 않는다
  return Math.round(d / seconds);
}

/**
 * 이번 수집의 포트 카운터로 속도를 채운다(포트 객체를 제자리에서 갱신).
 * @param deviceId 장비 id
 * @param ports    PortRow[] — inFrames/outFrames/inBytes/outBytes 중 있는 것만 쓴다
 * @param now      수집 시각(ms)
 * @returns { computed:boolean, gapSec:number|null } — UI 가 '첫 수집이라 미표시'를 구분할 수 있게
 */
export function applyRates(deviceId, ports = [], now = Date.now()) {
  const prev = _prev.get(deviceId);
  const cur = { at: now, ports: new Map() };
  for (const p of ports) {
    cur.ports.set(String(p.index), {
      inFrames: p.inFrames ?? null, outFrames: p.outFrames ?? null,
      inBytes: p.inBytes ?? null, outBytes: p.outBytes ?? null,
    });
  }
  _prev.set(deviceId, cur);

  const gapMs = prev ? now - prev.at : 0;
  if (!prev || gapMs < MIN_GAP_MS || gapMs > MAX_GAP_MS) {
    for (const p of ports) { p.inBps = null; p.outBps = null; p.inFps = null; p.outFps = null; }
    return { computed: false, gapSec: prev ? Math.round(gapMs / 1000) : null };
  }
  const sec = gapMs / 1000;
  // ⚠ null 을 산술에 넣지 말 것. 첫 구현이 `rate(...) * 8 || 0` 이었는데, rate 가 null 을
  //   돌려주는 경우(카운터 리셋)에 `null * 8 = 0` → `0 || 0 = 0` 이 되어 **리셋을 '트래픽
  //   0'으로 보고**했다(회귀 테스트가 잡음). null 은 끝까지 null 로 흘려야 한다.
  const toBps = (a, b) => { const r = rate(a, b, sec); return r == null ? null : r * 8; };
  for (const p of ports) {
    const old = prev.ports.get(String(p.index));
    if (!old) { p.inBps = null; p.outBps = null; p.inFps = null; p.outFps = null; continue; }
    // 옥텟(바이트)이 있으면 bps 로, 없으면(SSH porterrshow) 프레임/초로 — 둘 다 정직하게 구분 표기.
    p.inBps = toBps(old.inBytes, p.inBytes);
    p.outBps = toBps(old.outBytes, p.outBytes);
    p.inFps = rate(old.inFrames, p.inFrames, sec);
    p.outFps = rate(old.outFrames, p.outFrames, sec);
  }
  return { computed: true, gapSec: Math.round(sec) };
}

export function _resetForTest() { _prev.clear(); }
