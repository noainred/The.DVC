/**
 * sanSwitchPorts 회귀 테스트(v2.410) — SAN 스위치 화면의 판정 규칙.
 * 이 규칙들이 틀리면 운영자가 **정상 포트를 장애로, 장애 포트를 정상으로** 본다.
 */
import { describe, it, expect } from 'vitest';
import { opticalHealth, errorLevel, capacityLevel, aggregate, throughputText, bps, filterPorts, stateLabel, shortDeviceName, saturationPct, saturationLevel, bytesPerSecText, toChartRows, topSeries, sortPorts, nextSort, sortRows, seriesStats }
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

describe('shortDeviceName', () => {
  const SYM = 'SYMMETRIX::000497700230::SAF-1d 4::FC::5978_0714+::EMUL B90F0000 698529C0 EE8A28 03.18.24 09:33.';
  it('SYMMETRIX 심볼릭 이름을 식별 가능한 앞부분만 남긴다(표가 옆 칸을 침범하지 않게)', () => {
    const r = shortDeviceName(SYM);
    expect(r.length).toBeLessThanOrEqual(45);
    expect(r.startsWith('SYMMETRIX::000497700230')).toBe(true);  // 제품군 + 어레이 시리얼은 반드시 남는다
    expect(r.endsWith('…')).toBe(true);
  });
  it('짧은 이름은 건드리지 않는다', () => {
    expect(shortDeviceName('QLE2692 FW:v9.15.01')).toBe('QLE2692 FW:v9.15.01');
    expect(shortDeviceName('')).toBe('');
    expect(shortDeviceName(null)).toBe('');
  });
  it(':: 가 없는 긴 이름은 단순 절단', () => {
    const r = shortDeviceName('A'.repeat(80));
    expect(r.length).toBe(44);
    expect(r.endsWith('…')).toBe(true);
  });
  it('첫 세그먼트만으로 이미 max 를 넘으면 그 세그먼트는 유지한다(빈 문자열이 되면 안 된다)', () => {
    const r = shortDeviceName(`${'X'.repeat(60)}::tail`, 20);
    expect(r.startsWith('X'.repeat(60))).toBe(true);
  });
});

describe('saturationPct / saturationLevel', () => {
  it('16G 포트에서 2 GB/s(=16 Gbps)는 100%', () => {
    expect(saturationPct(2e9, '16G')).toBe(100);
    expect(saturationPct(1e9, '16G')).toBe(50);
  });
  it('같은 절대값도 포트 속도에 따라 포화도가 다르다 — 절대값만 보면 증설 판단이 틀린다', () => {
    expect(saturationPct(5e8, '16G')).toBe(25);
    expect(saturationPct(5e8, '4G')).toBe(100);
  });
  it('속도를 모르면 판정하지 않는다(null) — 0% 로 칠하면 정반대 결론이 된다', () => {
    expect(saturationPct(5e8, '')).toBe(null);
    expect(saturationPct(5e8, '자동')).toBe(null);
    expect(saturationPct(null, '16G')).toBe(null);
    expect(saturationLevel(null)).toBe('none');
  });
  it('등급 경계 50/80', () => {
    expect(saturationLevel(49.9)).toBe('ok');
    expect(saturationLevel(50)).toBe('warn');
    expect(saturationLevel(80)).toBe('bad');
  });
});

describe('bytesPerSecText', () => {
  it('portperfshow 의 B/s 를 bps 로 환산해 표기(×8)', () => {
    expect(bytesPerSecText(155_360_000)).toBe('1.24 Gbps');
    expect(bytesPerSecText(86_400)).toBe('691 Kbps');
    expect(bytesPerSecText(0)).toBe('0 bps');
    expect(bytesPerSecText(null)).toBe('—');
  });
});

describe('toChartRows / topSeries', () => {
  it('시계열을 차트 행으로 합치고 빈 값은 null 로 남긴다(0 으로 채우면 끊긴 구간이 트래픽 0 이 된다)', () => {
    const rows = toChartRows([100, 200], [{ key: 'a', values: [1, null] }, { key: 'b', values: [null, 4] }]);
    expect(rows).toEqual([{ ts: 100, a: 1, b: null }, { ts: 200, a: null, b: 4 }]);
  });
  it('평균 사용량 상위 N개만 남긴다', () => {
    const s = [{ key: 'x', values: [1, 1] }, { key: 'y', values: [10, 10] }, { key: 'z', values: [5, 5] }];
    expect(topSeries(s, 2).map((x) => x.key)).toEqual(['y', 'z']);
  });
});

describe('sortPorts', () => {
  const L = [
    { index: 0, state: 'online', speed: '16G', errCrc: 5, sfpTempC: 30, rxPowerDbm: -3 },
    { index: 1, state: 'offline', speed: '', errCrc: null, sfpTempC: null, rxPowerDbm: null },
    { index: 2, state: 'online', speed: '32G', errCrc: 0, sfpTempC: 40, rxPowerDbm: -9 },
  ];
  it('숫자 열 오름/내림', () => {
    expect(sortPorts(L, 'temp', 'asc').map((p) => p.index)).toEqual([0, 2, 1]);
    expect(sortPorts(L, 'temp', 'desc').map((p) => p.index)).toEqual([2, 0, 1]);
  });
  it('값이 없는 행은 방향과 무관하게 항상 뒤로 — 미수집이 맨 앞에 오면 오독한다', () => {
    expect(sortPorts(L, 'temp', 'asc').at(-1).index).toBe(1);
    expect(sortPorts(L, 'temp', 'desc').at(-1).index).toBe(1);
    expect(sortPorts(L, 'speed', 'asc').at(-1).index).toBe(1);
  });
  it('에러 합계로 정렬(개별 카운터 3종의 합)', () => {
    expect(sortPorts(L, 'err', 'desc').map((p) => p.index)).toEqual([0, 2, 1]);
  });
  it('동점이면 포트 번호 순(정렬이 매번 흔들리지 않게)', () => {
    const same = [{ index: 5, sfpTempC: 30 }, { index: 2, sfpTempC: 30 }];
    expect(sortPorts(same, 'temp', 'asc').map((p) => p.index)).toEqual([2, 5]);
  });
  it('상태는 online → faulty → disabled → offline → noLicense 우선순', () => {
    expect(sortPorts(L, 'state', 'asc').map((p) => p.state)).toEqual(['online', 'online', 'offline']);
  });
});

describe('nextSort', () => {
  it('같은 열이면 방향 토글, 다른 열이면 오름차순부터', () => {
    expect(nextSort({ key: 'index', dir: 'asc' }, 'temp')).toEqual({ key: 'temp', dir: 'asc' });
    expect(nextSort({ key: 'temp', dir: 'asc' }, 'temp')).toEqual({ key: 'temp', dir: 'desc' });
    expect(nextSort({ key: 'temp', dir: 'desc' }, 'temp')).toEqual({ key: 'temp', dir: 'asc' });
  });
});

describe('sortRows / seriesStats', () => {
  const L = [{ n: 'b', v: 2 }, { n: 'a', v: null }, { n: 'c', v: 10 }];
  it('숫자 오름/내림 + 값 없는 행은 항상 뒤', () => {
    expect(sortRows(L, (r) => r.v, 'asc').map((r) => r.n)).toEqual(['b', 'c', 'a']);
    expect(sortRows(L, (r) => r.v, 'desc').map((r) => r.n)).toEqual(['c', 'b', 'a']);
  });
  it('문자열 정렬', () => {
    expect(sortRows(L, (r) => r.n, 'asc').map((r) => r.n)).toEqual(['a', 'b', 'c']);
    expect(sortRows(L, (r) => r.n, 'desc').map((r) => r.n)).toEqual(['c', 'b', 'a']);
  });
  it('동점은 tie 키로 안정 정렬(정렬이 매번 흔들리지 않게)', () => {
    const same = [{ n: 'z', v: 5 }, { n: 'a', v: 5 }];
    expect(sortRows(same, (r) => r.v, 'asc', (r) => r.n).map((r) => r.n)).toEqual(['a', 'z']);
  });
  it('seriesStats: null 은 평균/최대 계산에서 제외(0 으로 채우면 평균이 내려간다)', () => {
    expect(seriesStats([10, null, 20])).toEqual({ avg: 15, max: 20 });
    expect(seriesStats([])).toEqual({ avg: 0, max: 0 });
    expect(seriesStats([null, null])).toEqual({ avg: 0, max: 0 });
  });
});
