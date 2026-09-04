/**
 * sanSwitchPorts 회귀 테스트(v2.410) — SAN 스위치 화면의 판정 규칙.
 * 이 규칙들이 틀리면 운영자가 **정상 포트를 장애로, 장애 포트를 정상으로** 본다.
 */
import { describe, it, expect } from 'vitest';
import { opticalHealth, errorLevel, capacityLevel, aggregate, throughputText, bps, filterPorts, stateLabel }
  from './sanSwitchPorts.js';

describe('opticalHealth', () => {
  it('정상 수신은 ok', () => expect(opticalHealth(-3.2, -2.9).level).toBe('ok'));
  it('-9 dBm 이하는 경고, -12 이하는 위험', () => {
    expect(opticalHealth(-9, -3).level).toBe('warn');
    expect(opticalHealth(-11.5, -3).level).toBe('warn');
    expect(opticalHealth(-12, -3).level).toBe('bad');
    expect(opticalHealth(-15, -3).level).toBe('bad');
  });
  it('송신이 낮으면 경고(SFP 노후 의심)', () => expect(opticalHealth(-3, -7.5).level).toBe('warn'));
  it('값이 없으면 판정하지 않는다(none) — 없는 값을 정상으로 칠하면 안 된다', () => {
    expect(opticalHealth(null, null).level).toBe('none');
    expect(opticalHealth(undefined, undefined).level).toBe('none');
  });
});

describe('errorLevel', () => {
  it('카운터가 전부 0이면 ok', () => expect(errorLevel({ errCrc: 0, errLinkFail: 0, errLossSync: 0, errEncOut: 0 }).level).toBe('ok'));
  it('CRC 가 1000 이상이면 bad', () => expect(errorLevel({ errCrc: 1200 }).level).toBe('bad'));
  it('소량이라도 있으면 warn — 누적값이라 0/비0 이 1차 신호다', () => {
    expect(errorLevel({ errCrc: 3 }).level).toBe('warn');
    expect(errorLevel({ errLossSync: 1 }).level).toBe('warn');
  });
  it('null 카운터(미수집)를 0 으로 보고 ok 처리 — 없는 값으로 경고를 만들지 않는다', () => {
    expect(errorLevel({ errCrc: null, errLinkFail: null }).level).toBe('ok');
  });
});

describe('capacityLevel', () => {
  it('75%/90% 경계', () => {
    expect(capacityLevel(50)).toBe('ok');
    expect(capacityLevel(75)).toBe('warn');
    expect(capacityLevel(89.9)).toBe('warn');
    expect(capacityLevel(90)).toBe('bad');
  });
});

describe('aggregate', () => {
  const mk = (online, licensed, total, ok = true) => ({ snap: ok ? { ok: true, ports: { online, licensed, total, free: licensed - online, faulty: 0, disabled: 0 }, health: { alerts: 0 } } : { ok: false } });
  it('여러 스위치의 포트를 합산하고 사용률을 다시 계산한다', () => {
    const a = aggregate([mk(24, 48, 48), mk(10, 24, 48)]);
    expect(a.switches).toBe(2);
    expect(a.online).toBe(34);
    expect(a.licensed).toBe(72);
    expect(a.free).toBe(38);
    expect(a.usedPct).toBe(47.2);
  });
  it('수집 실패 스위치는 포트 합계에서 빼고 failed 로만 센다(0 이 사용률을 희석하지 않게)', () => {
    const a = aggregate([mk(24, 48, 48), mk(0, 0, 0, false)]);
    expect(a.failed).toBe(1);
    expect(a.licensed).toBe(48);
    expect(a.usedPct).toBe(50);
  });
  it('라이선스 포트가 0이면 사용률 0(0 나눗셈 방지)', () => expect(aggregate([]).usedPct).toBe(0));
});

describe('throughputText / bps', () => {
  it('REST(bps)와 SSH(프레임/초)의 단위를 섞지 않는다', () => {
    expect(throughputText({ inBps: 2e9, outBps: 5e8 }, 'bps')).toBe('2.00 Gbps / 500.0 Mbps');
    expect(throughputText({ inFps: 1200, outFps: 300 }, 'fps')).toBe('1,200 / 300 f/s');
  });
  it('아직 계산되지 않았으면 — (첫 수집은 델타가 없다)', () => {
    expect(throughputText({ inBps: null, outBps: null }, 'bps')).toBe('—');
    expect(throughputText({ inFps: null, outFps: null }, 'fps')).toBe('—');
  });
  it('bps 단위 환산', () => {
    expect(bps(32e9)).toBe('32.00 Gbps');
    expect(bps(1500)).toBe('2 Kbps');
    expect(bps(null)).toBe('—');
  });
});

describe('filterPorts', () => {
  const list = [
    { state: 'online', errCrc: 0, rxPowerDbm: -3 },
    { state: 'offline', errCrc: 0 },
    { state: 'faulty', errCrc: 0 },
    { state: 'online', errCrc: 5000, rxPowerDbm: -3 },
    { state: 'online', errCrc: 0, rxPowerDbm: -13 },
  ];
  it('문제만 보기 = 장애/비활성 + 에러 카운터 + 광레벨 이상', () => {
    const r = filterPorts(list, 'problem');
    expect(r.length).toBe(3);
    expect(r.map((p) => p.state)).toEqual(['faulty', 'online', 'online']);
  });
  it('사용중/비어있음 필터', () => {
    expect(filterPorts(list, 'online').length).toBe(3);
    expect(filterPorts(list, 'free').length).toBe(1);
    expect(filterPorts(list, 'all').length).toBe(5);
  });
});

describe('stateLabel', () => {
  it('라이선스 없음을 "비어있음"과 구분한다 — 살 수 없는 포트를 여유로 세면 증설 판단이 틀린다', () => {
    expect(stateLabel('noLicense')).toBe('라이선스 없음');
    expect(stateLabel('offline')).toBe('비어있음');
    expect(stateLabel('online')).toBe('사용중');
  });
});
