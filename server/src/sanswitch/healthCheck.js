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

/**
 * **링크가 올라온 포트**만 광량을 판정한다(v2.521 — 사용자 신고 "점검결과 포트 광량이 장애수준인데,
 * 확인해보면 사용하지 않는 포트에, 사용하지 않는 포트는 제외 해야 맞는거 같다").
 *
 * 근거: 링크가 없으면 **상대가 빛을 보내지 않으므로** Rx 가 바닥인 것이 정상이다. 실제 현장
 * 스크린샷에서 포트 10~15·45·46 이 전부 `비어있음` 인데 -27 dBm 으로 '이상' 판정이 나갔다 —
 * 거짓 경보이고, 이 기능이 만들 수 있는 두 번째로 위험한 거짓이다(첫 번째는 '확인 불가'를
 * '정상'으로 칠하는 것).
 * ⚠ 제외한 포트는 **개수를 밝힌다** — 조용히 빼면 '전 포트를 봤다' 는 거짓이 된다.
 * ⚠ `faulty` 는 제외하지 않는다(장애 포트의 광량은 원인 정보다). 제외 대상은 링크가 없는
 *   `offline`·`disabled`·`noLicense` 다.
 */
export const isLinked = (p) => String(p?.state) === 'online';

/**
 * 에러 카운터 종류 → **무엇을 의심해야 하는가**(v2.521, 사용자 제공 해석표).
 * 카운터마다 원인이 다른데 한 줄로 뭉개면 조치가 엉뚱해진다.
 */
export const ERROR_CAUSE = Object.freeze({
  errCrc: { label: 'crc err', cause: '광모듈·케이블 또는 상대 장비 문제 의심' },
  errEncIn: { label: 'enc in', cause: '물리 계층(Physical Layer) 문제 가능성' },
  errEncOut: { label: 'enc out', cause: '접점·신호 품질(프레임 밖 인코딩) 문제 가능성' },
  errLinkFail: { label: 'link fail', cause: '링크 단절 이력 — 케이블·SFP·상대 포트 확인' },
  errLossSync: { label: 'loss sync', cause: 'Link·Optic·Cable 문제 가능성' },
  errLossSig: { label: 'loss sig', cause: 'Link·Optic·Cable 문제 가능성(신호 소실)' },
  discC3: { label: 'disc c3', cause: '혼잡·버퍼 크레딧(Congestion/Buffer) 문제 확인' },
});
/** 판정·표기 순서(해석표 순서를 따른다). */
export const ERROR_KEYS = Object.keys(ERROR_CAUSE);

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
  { key: 'fabric', stage: 4, label: '패브릭 구성원', cmd: 'fabricshow' },
  // v2.522 — 사용자 요청 "isl 점검 기능 추가".
  { key: 'isl', stage: 4, label: 'ISL 링크', cmd: 'islshow' },
  { key: 'trunk', stage: 4, label: 'ISL 트렁크', cmd: 'trunkshow' },
  { key: 'lsan', stage: 4, label: 'LSAN(FC 라우팅)', cmd: 'lsan --show' },
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

/** 점검 항목 키 → 그 항목을 채우는 **수집 명령 키**(`usedCmds` 조회용). */
export const ITEM_SOURCE = Object.freeze({
  switchStatus: 'switchstatusshow', psu: 'psshow', fan: 'fanshow', sensors: 'sensorshow',
  switchState: 'switchshow', ports: 'switchshow', optical: 'sfpshow',
  portErrors: 'porterrshow', slowDrain: 'bottleneckmon',
  raslog: 'errdump', fabric: 'fabricshow', isl: 'islshow', trunk: 'trunkshow', lsan: 'lsanshow',
});

const mk = (key, status, detail, extra = {}) => {
  const def = CHECK_ITEMS.find((i) => i.key === key) || { key, label: key, stage: 0, cmd: '' };
  return { key, label: def.label, stage: def.stage, cmd: def.cmd, status, detail, ...extra };
};

/**
 * 항목에 '실제로 쓴 명령' 을 붙인다(v2.522).
 * 대체 명령을 썼으면 `usedAlt: true` 이고 화면·보고서가 **원 명령이 아니라 대체로 확인했다**는
 * 사실을 적는다 — 출력이 완전히 같지 않을 수 있기 때문이다(예: `tempshow` 는 전압을 주지 않는다).
 */
export function attachUsed(items, usedCmds = {}) {
  return (items || []).map((it) => {
    const u = usedCmds[ITEM_SOURCE[it.key]];
    if (!u) return it;
    return {
      ...it,
      usedCmd: u.cmd || it.cmd,
      usedAlt: !!u.alt,
      usedPaged: !!u.paged,
      usedTruncated: !!u.truncated,
    };
  });
}

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
  // **무엇으로 확인했는가**(v2.522) — 대체 명령을 썼으면 항목에 그 사실을 붙인다.
  // 수집기가 항목 키(`optical`)가 아니라 명령 키(`sfpshow`)로 남기므로 여기서 매핑한다.
  const used = snap.extra?.usedCmds || {};
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
      // ⚠ `sensorshow` 가 없어 `tempshow` 로 대체했으면 **전압은 보지 못했다** — 그 사실을 적는다.
      //   적지 않으면 '온도·전압 센서 정상' 이라는 거짓이 된다(v2.522).
      const alt = used.sensorshow?.alt ? ` ⚠ \`${used.sensorshow.cmd}\` 로 대체 확인 — **전압은 확인하지 못했습니다**(이 명령은 온도만 줍니다).` : '';
      if (bad.length) items.push(mk('sensors', 'bad', `${info} · 이상 ${bad.length}개${alt}`, { evidence: bad.map((x) => x.raw) }));
      else if (unk.length) items.push(mk('sensors', 'warn', `${info} · 상태를 읽지 못한 센서 ${unk.length}개${alt}`, { evidence: unk.map((x) => x.raw) }));
      else if (alt) items.push(mk('sensors', 'warn', `${info} (임계 판정은 스위치 센서 상태 기준)${alt}`, { evidence: [] }));
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
    // ⚠ 링크가 없는 포트는 상대가 빛을 보내지 않아 Rx 가 바닥인 것이 **정상**이다 — 판정에서 뺀다.
    //   뺀 개수는 반드시 밝힌다(v2.521, 사용자 신고로 확정된 거짓 경보).
    const judged = withRx.filter(isLinked);
    const idle = withRx.length - judged.length;
    const idleNote = idle ? ` · 링크 없는 포트 ${idle}개는 제외(빛을 받지 않는 것이 정상)` : '';
    if (sec.sfp !== 'ok') items.push(mk('optical', 'unknown', uncheckedWhy(sec.sfp, 'sfpshow -all')));
    else if (!withRx.length) items.push(mk('optical', 'unknown', '수신 광량 값이 있는 포트가 없습니다(SFP 미장착 또는 값 미제공).'));
    else if (!judged.length) items.push(mk('optical', 'unknown', `광량 값은 ${withRx.length}포트에 있지만 **링크가 올라온 포트가 없어** 판정하지 않았습니다(링크 없는 포트의 낮은 Rx 는 정상입니다).`));
    else {
      const bad = judged.filter((p) => num(p.rxPowerDbm) <= rxBad);
      const warn = judged.filter((p) => num(p.rxPowerDbm) > rxBad && num(p.rxPowerDbm) <= rxWarn);
      const lo = Math.min(...judged.map((p) => num(p.rxPowerDbm)));
      const base = `판정 ${judged.length}포트(링크 있음) · 최저 ${lo} dBm (주의 ${rxWarn} / 이상 ${rxBad} dBm 기준)${idleNote}`;
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

  /* ── ISL 점검(v2.522, 사용자 요청) ────────────────────────────────────────
   * ⚠ **ISL 이 0개인 것은 이상이 아니다** — 단독 스위치면 정상이다. 그래서 패브릭 구성원이
   *   2대 이상이라고 알려졌을 때만 '주의' 로 본다(그 정보가 없으면 '정보' 로만 싣는다).
   * ⚠ 트렁크·LSAN 도 **없는 것이 정상인 환경이 대다수**다. 없다고 경고하지 않는다.
   */
  {
    const isl = ex.isl;
    const fabCount = num(ex.fabricMembers?.count);
    if (!isl) items.push(mk('isl', 'unknown', uncheckedWhy(sec.isl, 'islshow')));
    else if (!isl.parsed) items.push(mk('isl', 'unknown', uncheckedWhy('ok', 'islshow')));
    else if (!isl.count) {
      // 패브릭에 다른 스위치가 있다고 알려졌는데 ISL 이 0 이면 그것은 이상 신호다.
      const multi = fabCount != null && fabCount > 1;
      items.push(mk('isl', multi ? 'warn' : 'ok',
        multi
          ? `ISL 이 없습니다 — 그런데 패브릭 구성원은 ${fabCount}대로 보고됩니다(ISL 없이 같은 패브릭일 수 없습니다. 링크 단절 또는 조회 시점 차이를 확인하세요).`
          : `ISL 이 없습니다 — 단독 스위치이면 정상입니다${isl.note ? ` (${isl.note})` : ''}.`));
    } else {
      const noSpeed = isl.list.filter((x) => !x.speed);
      const degraded = isl.list.filter((x) => (x.flags || []).includes('DEGRADED'));
      const ev = isl.list.slice(0, 20).map((x) => `포트 ${x.port ?? '?'} → 도메인 ${x.domain ?? '?'} 포트 ${x.remotePort ?? '?'} · ${x.speed || '속도 미확인'}${x.flags?.length ? ` · ${x.flags.join(' ')}` : ''}`);
      const base = `ISL ${isl.count}개`;
      if (degraded.length) items.push(mk('isl', 'bad', `${base} · DEGRADED ${degraded.length}개`, { evidence: ev }));
      else if (noSpeed.length) items.push(mk('isl', 'warn', `${base} · 속도를 읽지 못한 링크 ${noSpeed.length}개(출력 형식 차이일 수 있습니다)`, { evidence: ev }));
      else items.push(mk('isl', 'ok', `${base} · 전부 링크 속도 확인`, { evidence: ev }));
    }
  }
  {
    const t = ex.trunk;
    const islCount = num(ex.isl?.count);
    if (!t) items.push(mk('trunk', 'unknown', uncheckedWhy(sec.trunk, 'trunkshow')));
    else if (!t.parsed) items.push(mk('trunk', 'unknown', uncheckedWhy('ok', 'trunkshow')));
    else if (!t.count) {
      items.push(mk('trunk', 'ok', `트렁크 그룹이 없습니다 — 트렁킹을 쓰지 않는 구성이면 정상입니다${t.note ? ` (${t.note})` : ''}.`));
    } else {
      // 멤버가 1개인 트렁크 그룹은 '트렁크가 깨져 한 링크만 남은' 신호일 수 있다 — 단정하지
      // 않고 주의로 밝힌다(정상 구성일 수도 있다).
      const single = t.groups.filter((g) => g.members.length < 2);
      const ev = t.groups.slice(0, 20).map((g) => `그룹 ${g.group}: 멤버 ${g.members.length}개(${g.members.map((m) => m.port).join(',')})${g.master != null ? ` · master 포트 ${g.master}` : ''}`);
      const base = `트렁크 ${t.count}그룹 · 멤버 ${t.members}개${islCount != null ? ` (ISL ${islCount}개 중)` : ''}`;
      if (single.length) items.push(mk('trunk', 'warn', `${base} · 멤버가 1개인 그룹 ${single.length}개 — 링크 하나가 빠졌는지 확인하세요(정상 구성일 수도 있습니다).`, { evidence: ev }));
      else items.push(mk('trunk', 'ok', base, { evidence: ev }));
    }
  }
  {
    const l = ex.lsan;
    if (!l) items.push(mk('lsan', 'unknown', uncheckedWhy(sec.lsan, 'lsan --show')));
    else if (!l.parsed) items.push(mk('lsan', 'unknown', uncheckedWhy('ok', 'lsan --show')));
    else if (!l.count) items.push(mk('lsan', 'ok', `LSAN 구성이 없습니다 — FC 라우팅을 쓰지 않는 환경이면 정상입니다${l.note ? ` (${l.note})` : ''}.`));
    else items.push(mk('lsan', 'ok', `LSAN zone ${l.count}개`, { evidence: l.zones.slice(0, 20).map((z) => `${z.name}${z.fabricId != null ? ` (FID ${z.fabricId})` : ''} · 멤버 ${z.members.length}개`) }));
  }

  return summarize(snap, attachUsed(items, used), { baselineAt: baseline?.at ?? null, usedCmds: used });
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

/**
 * 포트 에러 항목 — 누적값과 기준선 이후 신규를 **나눠서** 말하고, v2.521 부터 **카운터 종류별
 * 원인**(`ERROR_CAUSE`)까지 붙인다. 사용자 제공 해석표를 그대로 옮긴 것이다 —
 * crc/enc_in/loss_sync·loss_sig/disc_c3 는 의심해야 할 곳이 서로 다르다.
 */
function portErrorItem(ports, sec, baseline) {
  if (sec.counters !== 'ok') return mk('portErrors', 'unknown', uncheckedWhy(sec.counters, 'porterrshow'));
  const bp = baseline?.ports || null;
  const rows = [];
  let anyCounter = false;
  for (const p of ports) {
    const cur = {}; const dlt = {};
    let curSum = 0; let dltSum = 0; let dltKnown = false;
    for (const k of ERROR_KEYS) {
      const v = num(p[k]);
      if (v != null) { anyCounter = true; cur[k] = v; curSum += v; }
      const d = errorDelta(p[k], bp ? bp[String(p.index)]?.[k] : null);
      if (d != null) { dlt[k] = d; dltSum += d; dltKnown = true; }
    }
    if (curSum > 0 || dltSum > 0) rows.push({ index: p.index, name: p.attachedName || '', cur, dlt, curSum, dltSum, dltKnown });
  }
  if (!anyCounter) return mk('portErrors', 'unknown', '`porterrshow` 에서 카운터 값을 읽지 못했습니다.');

  const label = ERROR_KEYS.map((k) => ERROR_CAUSE[k].label);
  const ev = rows.sort((a, b) => (b.dltKnown ? b.dltSum : b.curSum) - (a.dltKnown ? a.dltSum : a.curSum)).slice(0, 20)
    .map((r) => `포트 ${r.index}${r.name ? ` (${r.name})` : ''}: ` + ERROR_KEYS.map((k) => {
      const c = r.cur[k]; const d = r.dlt[k];
      if (c == null && d == null) return null;
      return `${ERROR_CAUSE[k].label} ${c ?? '—'}${bp ? ` (신규 ${d == null ? '—' : d})` : ''}`;
    }).filter(Boolean).join(', '));

  if (!bp) {
    // 기준선이 없으면 **판정하지 않는다** — 누적값만 보고 '이상' 이라 하면 몇 년 전 에러로
    // 매달 같은 경고를 낸다. 대신 '기준선을 저장하세요' 를 조치로 준다.
    return mk('portErrors', rows.length ? 'warn' : 'ok',
      rows.length
        ? `누적 에러가 있는 포트 ${rows.length}개 — **기준선이 없어 '당월 신규' 를 판정할 수 없습니다**(누적값은 부팅 이후 합계입니다).`
        : `에러 카운터가 모두 0 입니다(누적 기준). 기준선이 없어 당월 신규는 판정하지 않았습니다.`,
      { evidence: ev, needBaseline: true, columns: label, causes: errorCauses(rows, { basis: 'cur' }) });
  }
  const newRows = rows.filter((r) => r.dltSum > 0);
  const causes = errorCauses(newRows, { basis: 'dlt' });
  if (!newRows.length) return mk('portErrors', 'ok', '기준선 이후 새로 발생한 에러가 없습니다.', { evidence: ev.slice(0, 5), columns: label, causes: [] });
  const heavy = newRows.filter((r) => r.dltSum >= 100);
  return mk('portErrors', heavy.length ? 'bad' : 'warn',
    `기준선 이후 신규 에러가 있는 포트 ${newRows.length}개${heavy.length ? ` (100건 이상 ${heavy.length}개)` : ''} — ${causeSentence(causes)}`,
    { evidence: ev, columns: label, causes });
}

/**
 * 카운터 종류별 집계 + 원인(순수 — 테스트가 고정).
 *
 * ⚠ 한 문장으로 뭉개지 말 것 — `crc err` 와 `disc c3` 는 조치가 완전히 다르다(전자는 케이블·SFP,
 *   후자는 혼잡·버퍼 크레딧). 어느 포트에서 났는지도 함께 준다.
 * @returns [{ key, label, cause, total, ports:number[] }]  건수 많은 순
 */
export function errorCauses(rows, { basis = 'dlt', maxPorts = 12 } = {}) {
  const out = [];
  for (const k of ERROR_KEYS) {
    let total = 0; const pts = [];
    for (const r of rows || []) {
      const v = num((basis === 'dlt' ? r.dlt : r.cur)?.[k]);
      if (v != null && v > 0) { total += v; pts.push(r.index); }
    }
    if (total > 0) out.push({ key: k, label: ERROR_CAUSE[k].label, cause: ERROR_CAUSE[k].cause, total, ports: pts.slice(0, maxPorts), portsOmitted: Math.max(0, pts.length - maxPorts) });
  }
  return out.sort((a, b) => b.total - a.total);
}

/** 원인 요약 한 문장 — 실제로 발생한 종류만 말한다(없는 원인을 나열하지 않는다). */
export function causeSentence(causes) {
  if (!causes || !causes.length) return '';
  return causes.slice(0, 4).map((c) => `${c.label} ${c.total}건 → ${c.cause}`).join(' / ');
}

/**
 * **모든 포트 점검**(v2.521 — 사용자 요청 "모든 포트에 대해서 점검").
 *
 * 항목 판정(`checkDevice`)이 '스위치 1대 = 항목 11개' 라면 이것은 '포트 1개 = 행 1개' 다.
 * 포트마다 상태·광량·에러를 한 줄로 판정하고 **왜 그렇게 봤는지**를 함께 준다.
 *
 * ⚠ 링크 없는 포트의 낮은 Rx 는 **이상이 아니다**(위 `isLinked` 머리말). 그 포트의 광량 판정은
 *   `unknown` 이 아니라 **판정 대상 아님(`skipped`)** 으로 둔다 — '확인 못 함' 과 '볼 필요 없음' 은
 *   다르고, 둘을 섞으면 '확인 불가 N개' 수치가 의미를 잃는다.
 * ⚠ 엣지 위임 장비는 문제 포트만 중앙에 올라올 수 있다(`push.js slimSnapshot`) — 그때는
 *   `complete:false` 로 '전 포트를 본 것이 아니다' 를 밝힌다.
 */
export function checkPorts(snap, { baseline = null, rxWarn = RX_WARN_DBM, rxBad = RX_BAD_DBM } = {}) {
  const sec = snap?.sections || {};
  const list = (snap?.ports && snap.ports.list) || [];
  const bp = baseline?.ports || null;
  const rows = list.map((p) => {
    const linked = isLinked(p);
    const rx = num(p.rxPowerDbm);
    const reasons = [];
    let optical = 'skipped';
    if (sec.sfp !== 'ok') optical = 'unknown';
    else if (rx == null) optical = 'unknown';
    else if (!linked) optical = 'skipped';               // 링크 없음 — 판정 대상 아님(이상이 아니다)
    else if (rx <= rxBad) { optical = 'bad'; reasons.push(`수신 광량 ${rx} dBm — 하한(${rxBad}) 미달`); }
    else if (rx <= rxWarn) { optical = 'warn'; reasons.push(`수신 광량 ${rx} dBm — 주의(${rxWarn}) 이하`); }
    else optical = 'ok';

    const cur = {}; const dlt = {};
    let curSum = 0; let dltSum = 0; let dltKnown = false;
    for (const k of ERROR_KEYS) {
      const v = num(p[k]);
      if (v != null) { cur[k] = v; curSum += v; }
      const d = errorDelta(p[k], bp ? bp[String(p.index)]?.[k] : null);
      if (d != null) { dlt[k] = d; dltSum += d; dltKnown = true; }
    }
    let errors = 'unknown';
    if (sec.counters !== 'ok') errors = 'unknown';
    else if (!Object.keys(cur).length) errors = 'unknown';
    else if (bp && dltKnown) {
      if (dltSum >= 100) { errors = 'bad'; reasons.push(`기준선 이후 신규 에러 ${dltSum}건`); }
      else if (dltSum > 0) { errors = 'warn'; reasons.push(`기준선 이후 신규 에러 ${dltSum}건`); }
      else errors = 'ok';
    } else if (curSum > 0) { errors = 'warn'; reasons.push(`누적 에러 ${curSum}건 — 기준선이 없어 신규 여부는 알 수 없습니다`); }
    else errors = 'ok';

    let state = 'ok';
    if (p.state === 'faulty') { state = 'bad'; reasons.push(`포트 상태 ${p.stateRaw || p.state}`); }
    else if (p.state === 'disabled') { state = 'warn'; reasons.push('포트가 비활성(disabled) 입니다'); }
    else if (p.state === 'noLicense') { state = 'warn'; reasons.push('포트 라이선스가 없습니다'); }
    else if (!linked) state = 'idle';

    const causes = errorCauses([{ index: p.index, cur, dlt }], { basis: bp && dltKnown ? 'dlt' : 'cur' });
    const verdict = worst([state === 'idle' ? 'ok' : state, optical, errors]);
    return {
      index: p.index, name: p.attachedName || p.attached || '', state: p.state, stateRaw: p.stateRaw || '',
      linked, speed: p.speed || '', portType: p.portType || '', wwn: String(p.attached || ''),
      rxPowerDbm: rx, txPowerDbm: num(p.txPowerDbm), sfpTempC: num(p.sfpTempC),
      optical, errors, verdict, reasons,
      errCur: cur, errDelta: bp ? dlt : null, errSum: curSum, errNew: bp && dltKnown ? dltSum : null,
      causes,
    };
  });
  const counts = { total: rows.length, bad: 0, warn: 0, ok: 0, idle: 0, unknown: 0 };
  for (const r of rows) {
    counts[r.verdict] = (counts[r.verdict] || 0) + 1;
    if (!r.linked) counts.idle++;
  }
  return {
    rows,
    counts,
    complete: (num(snap?.ports?.portsOmitted) || 0) === 0,
    portsOmitted: num(snap?.ports?.portsOmitted) || 0,
    baselineAt: baseline?.at ?? null,
    rxWarn,
    rxBad,
  };
}

/** 여러 판정 중 가장 나쁜 것. `unknown` 은 ok 보다 나쁘게(확인 못 한 것을 정상으로 칠하지 않는다). */
function worst(list) {
  const order = ['bad', 'warn', 'unknown', 'ok', 'skipped'];
  for (const s of order) if (list.includes(s)) return s === 'skipped' ? 'ok' : s;
  return 'ok';
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
