/**
 * sanswitch/healthCheck.js — Brocade SAN 스위치 **월간 점검 판정**(v2.519, 순수 모듈).
 *
 * 사용자가 정리해 준 월간 점검 체크리스트(2026-09-15)를 그대로 항목화한다:
 *   1단계 하드웨어·환경  — switchstatusshow · psshow · fanshow(sensorshow)
 *   2단계 포트·광량      — switchshow · sfpshow -all (Rx Power)
 *   3단계 에러·Slow Drain — porterrshow · bottleneckmon --show
 *   4단계 로그           — errdump(errshow) · fabricshow
 *
 * ── 이 모듈의 제1 규칙: **'확인하지 못함' 을 '이상 없음' 으로 뭉개지 않는다** ──────────
 * 점검 보고서는 사람이 "이번 달 이상 없음" 이라고 결재하는 근거다. 명령이 없어서 못 봤는데
 * '정상' 으로 칠하면 그게 이 기능이 만들 수 있는 **가장 위험한 거짓**이다. 그래서 상태는 네 가지다:
 *   `ok`      — 확인했고 정상
 *   `warn`    — 확인했고 주의
 *   `bad`     — 확인했고 이상
 *   `unknown` — **확인하지 못함**(명령 없음 / 실행 실패 / 출력 형식 미인식). 사유를 함께 싣는다.
 * 종합(`overall`)도 unknown 을 ok 로 흡수하지 않는다 — `uncheckedCount` 를 따로 세어 화면·PDF 가
 * "정상 N · 주의 N · 이상 N · **확인 불가 N**" 을 나란히 적는다.
 *
 * ── 제2 규칙: 임계값을 지어내지 않는다 ────────────────────────────────────────────
 * 온도·전압은 **스위치 자신의 센서 상태**(`sensorshow` 의 `is Ok`)를 따른다. 장비·모델마다 임계가
 * 달라 포탈이 숫자를 정하면 틀린 경고를 만든다. 측정값은 정보로 함께 싣되 판정 근거는 장비 상태다.
 * 광량만 예외로 수치 판정을 쓴다 — 사용자 체크리스트가 `-10 dBm` 을 기준으로 제시했고, 화면이
 * 이미 같은 축(`RX_WARN_DBM = -9`, `RX_BAD_DBM = -12`)을 쓰고 있어 **화면과 보고서가 어긋나지
 * 않게** 그 상수를 여기서도 기본값으로 쓴다(호출자가 바꿀 수 있다).
 *
 * ── 제3 규칙: 누적 카운터를 '지금 나쁘다' 로 읽지 않는다 ───────────────────────────
 * `porterrshow` 는 **부팅 이후 누적**이다. 몇 년 켜 둔 스위치는 값이 커도 최근에는 조용할 수 있다.
 * 그래서 기준선(`baseline`)이 있으면 **그 이후 신규분**으로 판정하고, 없으면 누적값만 보여주며
 * '기준선 없음' 을 밝힌다. ⚠ 포탈이 `portstatsclear` 를 실행하지 않는다 — 다른 팀이 잡아 둔
 * 기준선을 지우는 파괴적 동작이다. 기준선은 **포탈 안에 저장**한다(`sanswitch/errBaseline.js`).
 */

/** 광량 판정 기본 임계 — 웹 `sanSwitchPorts.js` 와 같은 값이어야 한다(보고서·화면 불일치 방지). */
export const RX_WARN_DBM = -9;
export const RX_BAD_DBM = -12;

/** 점검 항목 정의 — 체크리스트 단계(stage)와 라벨. PDF 목차도 이 순서를 쓴다. */
export const CHECK_ITEMS = [
  { key: 'switchStatus', stage: 1, label: '스위치 종합 상태', cmd: 'switchstatusshow' },
  { key: 'psu', stage: 1, label: '전원 공급 장치(PSU)', cmd: 'psshow' },
  { key: 'fan', stage: 1, label: '팬', cmd: 'fanshow' },
  { key: 'sensors', stage: 1, label: '온도·전압 센서', cmd: 'sensorshow' },
  { key: 'switchState', stage: 2, label: '스위치 동작 상태', cmd: 'switchshow' },
  { key: 'ports', stage: 2, label: '포트 상태', cmd: 'switchshow' },
  { key: 'optical', stage: 2, label: 'SFP 수신 광량', cmd: 'sfpshow -all' },
  { key: 'portErrors', stage: 3, label: '포트 에러 카운터', cmd: 'porterrshow' },
  { key: 'slowDrain', stage: 3, label: 'Slow Drain(병목)', cmd: 'bottleneckmon --show' },
  { key: 'raslog', stage: 4, label: '시스템 로그(RASLog)', cmd: 'errdump' },
  { key: 'fabric', stage: 4, label: '패브릭 구성(ISL)', cmd: 'fabricshow' },
];

const RANK = { ok: 0, warn: 1, bad: 2 };
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 섹션 미수집 사유를 사람 문구로. `sections` 값은 'ok' | 'skip' | 오류 문구다(fosSsh.buildSnapshot).
 * ⚠ 'skip' 과 오류를 구분한다 — 전자는 '이 장비/계정에 명령이 없다', 후자는 '실행이 실패했다' 다.
 */
export function uncheckedWhy(sectionValue, cmd) {
  const v = String(sectionValue || '');
  if (!v || v === 'skip') return `이 스위치에서 \`${cmd}\` 를 수집하지 못했습니다(명령이 없거나 계정 권한이 없습니다).`;
  if (v === 'ok') return `\`${cmd}\` 출력 형식을 읽지 못했습니다(수집은 됐습니다).`;
  return `\`${cmd}\` 실행 실패: ${v.slice(0, 200)}`;
}

const mk = (key, status, detail, extra = {}) => {
  const def = CHECK_ITEMS.find((i) => i.key === key) || { key, label: key, stage: 0, cmd: '' };
  return { key, label: def.label, stage: def.stage, cmd: def.cmd, status, detail, ...extra };
};

/**
 * 포트 에러 델타(순수). 기준선이 없으면 `null`(모름), 카운터 리셋(음수)도 `null` —
 * 0 으로 채우면 '새 에러 없음' 이라는 거짓이 된다(`rates.js` 와 같은 규약).
 */
export function errorDelta(cur, base) {
  const c = num(cur);
  const b = num(base);
  if (c == null) return null;
  if (b == null) return null;
  const d = c - b;
  return d < 0 ? null : d;
}

/** 한 스위치 점검. `snap` 은 수집 스냅샷, `baseline` 은 `{ at, ports: {idx: {...}} }` 또는 null. */
export function checkDevice(snap, { baseline = null, rxWarn = RX_WARN_DBM, rxBad = RX_BAD_DBM } = {}) {
  if (!snap) return null;
  const sec = snap.sections || {};
  const ports = (snap.ports && snap.ports.list) || [];
  const health = snap.health || {};
  const ex = snap.extra || {};
  const items = [];

  // 수집 자체가 실패한 스냅샷은 항목을 판정하지 않는다 — 모든 항목이 '확인 불가' 다.
  if (snap.ok === false) {
    for (const d of CHECK_ITEMS) {
      items.push(mk(d.key, 'unknown', `수집 자체가 실패해 확인하지 못했습니다: ${String(snap.error || '사유 미기재').slice(0, 200)}`));
    }
    return summarize(snap, items, { collectFailed: true, baselineAt: baseline?.at ?? null });
  }

  /* ── 1단계 하드웨어·환경 ───────────────────────────────────────────────── */
  {
    const st = String(health.status || '').toUpperCase();
    const mon = health.monitors || {};
    const badMon = Object.entries(mon).filter(([, v]) => String(v).toUpperCase() !== 'HEALTHY');
    if (sec.health !== 'ok') items.push(mk('switchStatus', 'unknown', uncheckedWhy(sec.health, 'switchstatusshow')));
    else if (!st) items.push(mk('switchStatus', 'unknown', uncheckedWhy('ok', 'switchstatusshow')));
    else if (st === 'HEALTHY') items.push(mk('switchStatus', 'ok', 'Switch Health Report: HEALTHY'));
    else if (st === 'DOWN') items.push(mk('switchStatus', 'bad', `Switch Health Report: ${st}`, { evidence: badMon.map(([k, v]) => `${k}=${v}`) }));
    else items.push(mk('switchStatus', 'warn', `Switch Health Report: ${st}`, { evidence: badMon.map(([k, v]) => `${k}=${v}`) }));
  }
  items.push(fruItem('psu', health.psus, sec.chassis, 'psshow'));
  items.push(fruItem('fan', health.fans, sec.chassis, 'fanshow'));
  {
    const s = ex.sensors;
    if (!s) items.push(mk('sensors', 'unknown', uncheckedWhy(sec.sensors, 'sensorshow')));
    else if (!s.parsed) items.push(mk('sensors', 'unknown', uncheckedWhy('ok', 'sensorshow')));
    else {
      const bad = s.list.filter((x) => x.ok === false);
      const unk = s.list.filter((x) => x.ok == null);
      const temps = s.list.filter((x) => /temp/.test(x.kind) && x.value != null).map((x) => x.value);
      // ⚠ 임계값은 **스위치 자신의 센서 상태**를 따른다(포탈이 숫자를 정하지 않는다).
      const info = [
        `센서 ${s.counts.total}개 — 정상 ${s.counts.ok}`,
        s.counts.absent ? `미장착 ${s.counts.absent}` : null,
        temps.length ? `최고 온도 ${Math.max(...temps)}℃` : null,
      ].filter(Boolean).join(' · ');
      if (bad.length) items.push(mk('sensors', 'bad', `${info} · 이상 ${bad.length}개`, { evidence: bad.map((x) => x.raw) }));
      else if (unk.length) items.push(mk('sensors', 'warn', `${info} · 상태를 읽지 못한 센서 ${unk.length}개`, { evidence: unk.map((x) => x.raw) }));
      else items.push(mk('sensors', 'ok', `${info} (임계 판정은 스위치 센서 상태 기준)`));
    }
  }

  /* ── 2단계 포트·광량 ──────────────────────────────────────────────────── */
  {
    const st = String(snap.switchState || '').toLowerCase();
    if (!st) items.push(mk('switchState', 'unknown', uncheckedWhy(sec.ports, 'switchshow')));
    else if (/online/.test(st)) items.push(mk('switchState', 'ok', `switchState: ${snap.switchState}`));
    else items.push(mk('switchState', 'bad', `switchState: ${snap.switchState}`));
  }
  {
    if (!ports.length) items.push(mk('ports', 'unknown', uncheckedWhy(sec.ports, 'switchshow')));
    else {
      const complete = (num(snap.ports?.portsOmitted) || 0) === 0;
      const faulty = ports.filter((p) => p.state === 'faulty');
      const disabled = ports.filter((p) => p.state === 'disabled');
      const sum = snap.ports || {};
      const base = `사용중 ${sum.online ?? '—'} / 라이선스 ${sum.licensed ?? '—'} · 여유 ${sum.free ?? '—'}`;
      // ⚠ 엣지 위임 장비가 문제 포트만 올린 상태면 **'정상 포트가 온전하다' 고 말할 수 없다**.
      const partial = complete ? '' : ` ⚠ 중앙에 일부 포트만 올라와 있어(${sum.portsOmitted}개 누락) 목록 기반 판정은 불완전합니다.`;
      if (faulty.length) items.push(mk('ports', 'bad', `${base} · 장애 포트 ${faulty.length}개${partial}`, { evidence: faulty.slice(0, 20).map((p) => `포트 ${p.index}: ${p.stateRaw || p.state}`) }));
      else if (disabled.length) items.push(mk('ports', 'warn', `${base} · 비활성 포트 ${disabled.length}개${partial}`, { evidence: disabled.slice(0, 20).map((p) => `포트 ${p.index}: ${p.stateRaw || p.state}`) }));
      else items.push(mk('ports', complete ? 'ok' : 'warn', `${base} · 장애·비활성 없음${partial}`));
    }
  }
  {
    const withRx = ports.filter((p) => num(p.rxPowerDbm) != null);
    if (sec.sfp !== 'ok') items.push(mk('optical', 'unknown', uncheckedWhy(sec.sfp, 'sfpshow -all')));
    else if (!withRx.length) items.push(mk('optical', 'unknown', '수신 광량 값이 있는 포트가 없습니다(SFP 미장착 또는 값 미제공).'));
    else {
      const bad = withRx.filter((p) => num(p.rxPowerDbm) <= rxBad);
      const warn = withRx.filter((p) => num(p.rxPowerDbm) > rxBad && num(p.rxPowerDbm) <= rxWarn);
      const lo = Math.min(...withRx.map((p) => num(p.rxPowerDbm)));
      const base = `측정 ${withRx.length}포트 · 최저 ${lo} dBm (주의 ${rxWarn} / 이상 ${rxBad} dBm 기준)`;
      const ev = (arr) => arr.slice(0, 20).map((p) => `포트 ${p.index}: Rx ${p.rxPowerDbm} dBm${p.attachedName ? ` (${p.attachedName})` : ''}`);
      if (bad.length) items.push(mk('optical', 'bad', `${base} · 하한 미달 ${bad.length}포트 — 케이블 청소 또는 SFP 교체 검토`, { evidence: ev(bad) }));
      else if (warn.length) items.push(mk('optical', 'warn', `${base} · 하한 근접 ${warn.length}포트`, { evidence: ev(warn) }));
      else items.push(mk('optical', 'ok', base));
    }
  }

  /* ── 3단계 에러·Slow Drain ─────────────────────────────────────────────── */
  items.push(portErrorItem(ports, sec, baseline));
  {
    const b = ex.bottleneck;
    if (!b) items.push(mk('slowDrain', 'unknown', uncheckedWhy(sec.bottleneck, 'bottleneckmon --show')));
    else if (!b.parsed) items.push(mk('slowDrain', 'unknown', uncheckedWhy('ok', 'bottleneckmon --show')));
    else if (b.enabled === false) items.push(mk('slowDrain', 'unknown', '병목 감지(bottleneckmon)가 이 스위치에서 꺼져 있어 Slow Drain 여부를 알 수 없습니다.', { evidence: b.note ? [b.note] : [] }));
    else if (b.ports.length) items.push(mk('slowDrain', 'warn', `병목 감지 포트 ${b.ports.length}개`, { evidence: b.ports.slice(0, 20).map((p) => `포트 ${p.port}: ${p.detail}`) }));
    else items.push(mk('slowDrain', 'ok', b.note || '병목 감지 없음'));
  }

  /* ── 4단계 로그·패브릭 ────────────────────────────────────────────────── */
  {
    const r = ex.raslog;
    if (!r) items.push(mk('raslog', 'unknown', uncheckedWhy(sec.raslog, 'errdump')));
    else if (!r.parsed) items.push(mk('raslog', 'unknown', uncheckedWhy('ok', 'errdump')));
    else {
      const c = r.counts || {};
      // ⚠ 보관된 로그 전체 기준이다 — '최근 1개월' 이라 말할 수 없다(errdump 는 보관 범위를
      //   스스로 밝히지 않는다). 그래서 문구를 '보관된 로그' 로 고정한다.
      const base = `보관된 로그 ${c.total ?? 0}건 — 심각 ${c.critical ?? 0} · 오류 ${c.error ?? 0} · 경고 ${c.warning ?? 0}`;
      const pick = (sev) => r.list.filter((e) => e.severity === sev).slice(-10).map((e) => `${e.at || ''} [${e.id}] ${e.text.slice(0, 160)}`);
      if (c.critical) items.push(mk('raslog', 'bad', base, { evidence: pick('critical') }));
      else if (c.error) items.push(mk('raslog', 'warn', base, { evidence: pick('error') }));
      else if (c.warning) items.push(mk('raslog', 'warn', base, { evidence: pick('warning') }));
      else items.push(mk('raslog', 'ok', base));
    }
  }
  {
    const f = ex.fabricMembers;
    if (!f) items.push(mk('fabric', 'unknown', uncheckedWhy(sec.fabric, 'fabricshow')));
    else if (!f.parsed) items.push(mk('fabric', 'unknown', uncheckedWhy('ok', 'fabricshow')));
    else {
      const ev = f.switches.map((s) => `도메인 ${s.domain}${s.domain === f.principal ? '(principal)' : ''} · ${s.name || s.wwn}`);
      if (f.principal == null) items.push(mk('fabric', 'warn', `패브릭 구성원 ${f.count}대 — principal 스위치를 확인하지 못했습니다`, { evidence: ev }));
      else items.push(mk('fabric', 'ok', `패브릭 구성원 ${f.count}대 · principal 도메인 ${f.principal}`, { evidence: ev }));
    }
  }

  return summarize(snap, items, { baselineAt: baseline?.at ?? null });
}

/** FRU(팬·PSU) 항목 — 개수만 아는 경우(`ok:null`)를 '정상' 으로 칠하지 않는다. */
function fruItem(key, fru, section, cmd) {
  if (!fru) return mk(key, 'unknown', uncheckedWhy(section, cmd));
  const total = num(fru.total);
  const ok = fru.ok;
  if (ok == null) return mk(key, 'unknown', `${total ?? '?'}개가 장착돼 있다는 것만 확인했습니다 — 정상 여부는 \`${cmd}\` 가 없어 알 수 없습니다.`);
  if (total != null && ok < total) return mk(key, 'bad', `${ok}/${total} 정상 — ${total - ok}개 이상`);
  return mk(key, 'ok', `${ok}/${total ?? ok} 정상`);
}

/** 포트 에러 항목 — 누적값과 기준선 이후 신규를 **나눠서** 말한다. */
function portErrorItem(ports, sec, baseline) {
  if (sec.counters !== 'ok') return mk('portErrors', 'unknown', uncheckedWhy(sec.counters, 'porterrshow'));
  const KEYS = [['errCrc', 'crc err'], ['errEncOut', 'enc out'], ['errLossSync', 'loss sync'], ['discC3', 'disc c3']];
  const bp = baseline?.ports || null;
  const rows = [];
  let anyCounter = false;
  for (const p of ports) {
    const cur = {}; const dlt = {};
    let curSum = 0; let dltSum = 0; let dltKnown = false;
    for (const [k] of KEYS) {
      const v = num(p[k]);
      if (v != null) { anyCounter = true; cur[k] = v; curSum += v; }
      const d = errorDelta(p[k], bp ? bp[String(p.index)]?.[k] : null);
      if (d != null) { dlt[k] = d; dltSum += d; dltKnown = true; }
    }
    if (curSum > 0 || dltSum > 0) rows.push({ index: p.index, name: p.attachedName || '', cur, dlt, curSum, dltSum, dltKnown });
  }
  if (!anyCounter) return mk('portErrors', 'unknown', '`porterrshow` 에서 카운터 값을 읽지 못했습니다.');

  const label = KEYS.map(([k, l]) => l);
  const ev = rows.sort((a, b) => (b.dltKnown ? b.dltSum : b.curSum) - (a.dltKnown ? a.dltSum : a.curSum)).slice(0, 20)
    .map((r) => `포트 ${r.index}${r.name ? ` (${r.name})` : ''}: ` + KEYS.map(([k, l]) => {
      const c = r.cur[k]; const d = r.dlt[k];
      if (c == null && d == null) return null;
      return `${l} ${c ?? '—'}${bp ? ` (신규 ${d == null ? '—' : d})` : ''}`;
    }).filter(Boolean).join(', '));

  if (!bp) {
    // 기준선이 없으면 **판정하지 않는다** — 누적값만 보고 '이상' 이라 하면 몇 년 전 에러로
    // 매달 같은 경고를 낸다. 대신 '기준선을 저장하세요' 를 조치로 준다.
    return mk('portErrors', rows.length ? 'warn' : 'ok',
      rows.length
        ? `누적 에러가 있는 포트 ${rows.length}개 — **기준선이 없어 '당월 신규' 를 판정할 수 없습니다**(누적값은 부팅 이후 합계입니다).`
        : `에러 카운터가 모두 0 입니다(누적 기준). 기준선이 없어 당월 신규는 판정하지 않았습니다.`,
      { evidence: ev, needBaseline: true, columns: label });
  }
  const newRows = rows.filter((r) => r.dltSum > 0);
  if (!newRows.length) return mk('portErrors', 'ok', '기준선 이후 새로 발생한 에러가 없습니다.', { evidence: ev.slice(0, 5), columns: label });
  const heavy = newRows.filter((r) => r.dltSum >= 100);
  return mk('portErrors', heavy.length ? 'bad' : 'warn',
    `기준선 이후 신규 에러가 있는 포트 ${newRows.length}개${heavy.length ? ` (100건 이상 ${heavy.length}개)` : ''} — crc err 는 케이블/SFP, enc out 은 접점·신호 품질, disc c3 는 크레딧 부족(Slow Drain)을 가리킵니다.`,
    { evidence: ev, columns: label });
}

function summarize(snap, items, extra = {}) {
  const counts = { ok: 0, warn: 0, bad: 0, unknown: 0 };
  let worst = 'ok';
  for (const it of items) {
    counts[it.status] = (counts[it.status] || 0) + 1;
    if (it.status !== 'unknown' && RANK[it.status] > RANK[worst]) worst = it.status;
  }
  // 확인한 항목이 하나도 없으면 종합도 'unknown' — '정상' 이라 말할 근거가 없다.
  const overall = counts.ok + counts.warn + counts.bad === 0 ? 'unknown' : worst;
  return {
    deviceId: snap.deviceId, name: snap.name || snap.host || snap.deviceId, host: snap.host || '',
    agent: snap.agent || '', model: snap.model || '', fabricOs: snap.fabricOs || '',
    serial: snap.serial || '', domainId: snap.domainId ?? null,
    collectedAt: snap.collectedAt || null,
    overall, counts, uncheckedCount: counts.unknown, items, ...extra,
  };
}

/** 여러 장비 요약 — '전체 점검' 버튼의 응답. 이상·주의·확인불가를 **각각** 센다. */
export function summarizeAll(results) {
  const list = (results || []).filter(Boolean);
  const byOverall = { ok: 0, warn: 0, bad: 0, unknown: 0 };
  for (const r of list) byOverall[r.overall] = (byOverall[r.overall] || 0) + 1;
  const uncheckedItems = list.reduce((a, r) => a + (r.uncheckedCount || 0), 0);
  const needBaseline = list.filter((r) => r.items.some((i) => i.needBaseline)).map((r) => r.deviceId);
  return { devices: list.length, byOverall, uncheckedItems, needBaseline };
}
