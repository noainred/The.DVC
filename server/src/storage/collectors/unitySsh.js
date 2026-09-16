/**
 * storage/collectors/unitySsh.js — Dell Unity SSH(uemcli) 수집기(v2.405 → **v2.525 대폭 확장**).
 *
 * Unity 는 SP 에 SSH 로 접속해 `uemcli` 를 실행할 수 있다. uemcli 는 `-output csv` 로
 * **기계가 읽기 좋은 CSV** 를 내주므로 그것을 1순위로 쓰고, 없으면 기본(Key = Value) 출력을
 * 파싱한다(버전차 폴백).
 *
 * ── v2.525: 사용자 신고와 그 원인(정직 기록) ────────────────────────────────────
 * 사용자 신고(2026-09-16): **"unity 장비에 ssh 로 접속은 성공했는데, 수집하는 정보가 없어.
 * 용량 정보 확인 및 장비 구성정보 등 최대한 많은 정보를 수집해줘"** — 화면은 `config: OK ·
 * capacity: 건너뜀 · 풀 0 · 전체 용량 —` 이었다.
 *
 * 원인은 **수집 실패가 아니라 파싱 실패**였다:
 *  ① `cliSsh.toBytes` 가 uemcli 의 실제 표기 `12094627905536 (11.0T)` 를 **0 으로 버렸다**.
 *     `normalizeUnitySsh` 는 `if (!t) continue;` 로 그 풀을 건너뛰므로 풀이 0개가 되고,
 *     `sections.capacity` 는 기본값 `'skip'`(= 화면의 '건너뜀') 으로 남았다. → v2.525 에서 수정.
 *  ② `records()` 가 CSV 파서 결과가 **비어 있지 않기만 하면** 그것을 썼다. uemcli 가 배너에
 *     쉼표를 하나라도 찍으면 그 줄이 헤더로 잡혀 **쓸모없는 레코드 1건**이 만들어진다 —
 *     화면의 `SP 1대 · 이름 SP0 · IP — · 상태 ?` 가 정확히 그 모양이다. 이제 CSV 와 Key=Value
 *     결과를 **기대 필드가 몇 개 맞았는지로 채점해** 이긴 쪽을 쓴다(`recordsFor`).
 *
 * ⚠ **실장비 출력을 확인하지 못했다.** 이 환경의 egress 정책에서 Dell/Broadcom 문서가 차단이고
 *   장비도 없다. 아래 명령 경로는 Unisphere CLI 문서에 대한 내 지식에서 온 것이고 **버전마다
 *   있는 것과 없는 것이 다르다**. 그래서:
 *    · 명령은 **후보 체인**이고, 전부 실패한 항목은 섹션에 사유를 남긴다(조용히 건너뛰지 않는다).
 *    · **무엇으로 읽었는지 `extra.usedCmds` 에 남긴다**(v2.522 규약) — 화면이 근거를 보여준다.
 *    · 파싱이 아무것도 못 읽으면 그 항목은 **없는 것으로 두고 0 을 지어내지 않는다**.
 *    · 각 명령의 **원문 앞부분**은 `extra.cliRaw` 에 남는다. 등록 화면 '연결 테스트'가 그것을
 *      그대로 보여주므로(`StorageMonTool.jsx:1082`) 실제 출력을 받으면 파서를 조일 수 있다.
 *
 * ⚠ 명령 수가 늘면 **SSH 세션 시간이 늘어난다**(uemcli 한 번이 1~3초). 그래서 항목을
 *   `core`(항상) 와 `deep`(구성 상세) 로 나누고, 회선이 좁거나 장비가 느린 현장은
 *   `UNITY_SSH_DEEP=0` 으로 deep 을 끌 수 있다. 끄면 **그 사실을 화면이 밝힌다**
 *   (`extra.deepSkipped`) — 조용히 덜 수집하면 '구성 정보가 없는 장비' 로 오해된다.
 */

import { emptySnapshot } from '../types.js';
import { runCliSession, parseCsv, parseKeyValueBlocks, toBytes, sshFailureSnapshot, firstLine } from './cliSsh.js';

/** 구성 상세(deep) 수집 여부 — 기본 켜짐. 끄면 core 항목만 돈다. */
export const deepEnabled = () => String(process.env.UNITY_SSH_DEEP ?? '1') !== '0';

/** 목록 저장 상한 — push 대역폭·중앙 저장 고려(CLAUDE.md). 잘린 개수는 밝힌다. */
const LIST_MAX = 64;

/**
 * 명령 명세. `deep:true` 는 구성 상세(끌 수 있다).
 * ⚠ `cmds` 는 **후보 체인**이다 — 앞에서부터 시도해 쓸 만한 출력이 나오면 멈춘다.
 */
const SPECS = [
  // ── core: 이것만으로 '용량·상태' 화면이 채워진다 ──
  { key: 'system', section: 'config', required: true, cmds: ['uemcli -output csv /sys/general show -detail', 'uemcli -output csv /sys/general show', 'uemcli /sys/general show'] },
  { key: 'pools', section: 'pools', cmds: ['uemcli -output csv /stor/config/pool show -detail', 'uemcli -output csv /stor/config/pool show', 'uemcli /stor/config/pool show'] },
  { key: 'sps', section: 'nodes', cmds: ['uemcli -output csv /env/sp show -detail', 'uemcli -output csv /env/sp show', 'uemcli /env/sp show'] },
  { key: 'users', section: 'accounts', cmds: ['uemcli -output csv /user/account show', 'uemcli /user/account show'] },
  { key: 'alerts', section: 'alerts', cmds: ['uemcli -output csv /event/alert/hist show -active', 'uemcli /event/alert/hist show -active'] },
  { key: 'software', cmds: ['uemcli -output csv /sys/soft/ver show', 'uemcli /sys/soft/ver show'] },

  // ── deep: 장비 구성 정보(사용자 요청 "장비 구성정보 등 최대한 많은 정보") ──
  { key: 'license', deep: true, cmds: ['uemcli -output csv /sys/lic show', 'uemcli /sys/lic show'] },
  { key: 'dpe', deep: true, cmds: ['uemcli -output csv /env/dpe show', 'uemcli /env/dpe show'] },
  { key: 'dae', deep: true, cmds: ['uemcli -output csv /env/dae show', 'uemcli /env/dae show'] },
  { key: 'disks', deep: true, cmds: ['uemcli -output csv /env/disk show', 'uemcli /env/disk show'] },
  { key: 'psu', deep: true, cmds: ['uemcli -output csv /env/ps show', 'uemcli /env/ps show'] },
  { key: 'fans', deep: true, cmds: ['uemcli -output csv /env/fan show', 'uemcli /env/fan show'] },
  { key: 'bbu', deep: true, cmds: ['uemcli -output csv /env/bbu show', 'uemcli /env/bbu show'] },
  { key: 'iom', deep: true, cmds: ['uemcli -output csv /env/iomodule show', 'uemcli /env/iomodule show'] },
  { key: 'ethPorts', deep: true, cmds: ['uemcli -output csv /net/port/eth show', 'uemcli /net/port/eth show'] },
  { key: 'fcPorts', deep: true, cmds: ['uemcli -output csv /net/port/fc show', 'uemcli /net/port/fc show'] },
  { key: 'sasPorts', deep: true, cmds: ['uemcli -output csv /net/port/sas show', 'uemcli /net/port/sas show'] },
  { key: 'nasServers', deep: true, cmds: ['uemcli -output csv /net/nas/server show', 'uemcli /net/nas/server show'] },
  { key: 'luns', deep: true, cmds: ['uemcli -output csv /stor/prov/luns/lun show', 'uemcli /stor/prov/luns/lun show'] },
  { key: 'filesystems', deep: true, cmds: ['uemcli -output csv /stor/prov/fs show', 'uemcli /stor/prov/fs show'] },
  { key: 'vmfs', deep: true, cmds: ['uemcli -output csv /stor/prov/vmware/vmfs show', 'uemcli /stor/prov/vmware/vmfs show'] },
  { key: 'nfsDs', deep: true, cmds: ['uemcli -output csv /stor/prov/vmware/nfs show', 'uemcli /stor/prov/vmware/nfs show'] },
  { key: 'hosts', deep: true, cmds: ['uemcli -output csv /remote/host show', 'uemcli /remote/host show'] },
  { key: 'snaps', deep: true, cmds: ['uemcli -output csv /prot/snap show', 'uemcli /prot/snap show'] },
];

export function specsFor({ deep = deepEnabled() } = {}) {
  return SPECS.filter((s) => deep || !s.deep);
}

/** 여러 후보 키 중 처음 존재하는 값(버전마다 헤더명이 달라서 필요). */
function pick(rec, ...keys) {
  for (const k of keys) {
    for (const actual of Object.keys(rec || {})) {
      if (actual.toLowerCase().replace(/\s+/g, '') === k.toLowerCase().replace(/\s+/g, '')) {
        const v = rec[actual];
        if (v !== undefined && v !== '') return String(v);
      }
    }
  }
  return '';
}

/** 레코드가 기대 필드 중 몇 개를 갖고 있나(파서 채점용). */
function score(recs, expect) {
  let n = 0;
  for (const r of recs || []) for (const k of expect) { if (pick(r, k)) { n += 1; break; } }
  return n;
}

/**
 * CSV 와 Key=Value 중 **기대 필드가 더 많이 맞는 쪽**을 쓴다.
 *
 * ⚠ 예전에는 `parseCsv` 결과가 비어 있지 않기만 하면 그것을 썼다. uemcli 배너에 쉼표가
 *   하나만 있어도 그 줄이 헤더로 잡혀 **아무 필드도 없는 레코드 1건**이 생겼고, 화면에는
 *   'SP 1대 · 이름 SP0 · 상태 ?' 처럼 **없는 장비가 있는 것처럼** 보였다(v2.525 사용자 신고).
 *   둘 다 0점이면 **빈 배열**을 돌려준다 — 못 읽은 것을 읽은 척하지 않는다.
 */
export function recordsFor(text, expect = []) {
  const csv = parseCsv(text);
  const kv = parseKeyValueBlocks(text);
  if (!expect.length) return csv.length ? csv : kv;
  const sc = score(csv, expect);
  const sk = score(kv, expect);
  if (sc === 0 && sk === 0) return [];
  const win = sc >= sk ? csv : kv;
  // ⚠ **기대 필드가 하나도 없는 레코드는 버린다** — uemcli 의 배너 줄(`Storage system address:
  //   10.94.41.237, port: 443`)이 Key:Value 로 읽혀 레코드가 되면, 그 뒤 `nameOf` 가 `SP0` 같은
  //   합성 이름을 붙여 **없는 장비가 있는 것처럼** 보인다(v2.525 사용자 신고의 화면이 그랬다).
  //   식별 키(Name/ID)조차 없는 레코드는 정규화가 쓸 수 없으므로 남기면 거짓만 만든다.
  return win.filter((r) => expect.some((k) => pick(r, k)));
}

const HEALTH_OK = /ok|normal|healthy|running|up|online|enabled/i;
/** 상태 문자열 → 'ok' | 원문(소문자) | 'unknown'. **모르는 것을 정상이라 하지 않는다.** */
function healthOf(rec) {
  const raw = pick(rec, 'Health state', 'Health', 'State', 'Status', 'Operational status');
  if (!raw) return 'unknown';
  return HEALTH_OK.test(raw) ? 'ok' : raw.toLowerCase().slice(0, 40);
}

/** 목록 요약 — 개수·비정상 수·상한으로 잘린 개수. `unknown` 은 어느 쪽으로도 세지 않는다. */
function summarize(recs, mapFn) {
  const list = (recs || []).map(mapFn).filter((x) => x && (x.name || x.id != null));
  return {
    count: list.length,
    unhealthy: list.filter((x) => x.health && x.health !== 'ok' && x.health !== 'unknown').length,
    unknown: list.filter((x) => !x.health || x.health === 'unknown').length,
    list: list.slice(0, LIST_MAX),
    omitted: Math.max(0, list.length - LIST_MAX),
  };
}

const nameOf = (r, i, prefix) => pick(r, 'Name', 'ID') || (prefix ? `${prefix}${i}` : '');

/** 원시 출력 → 정규화(순수 — 테스트가 이 함수를 고정한다). */
export function normalizeUnitySsh(device, out, { usedCmds = {}, deep = deepEnabled() } = {}) {
  const snap = emptySnapshot(device);
  snap.extra.collectMethod = 'ssh';
  snap.extra.usedCmds = usedCmds;
  snap.extra.deepSkipped = !deep;

  /* ── 시스템 ── */
  const sys = recordsFor(out.system || '', ['Name', 'Model', 'ID', 'Serial number', 'Platform'])[0];
  if (sys) {
    snap.name = pick(sys, 'Name', 'System name') || device.name;
    snap.serial = pick(sys, 'ID', 'Serial number', 'Product serial number') || '';
    snap.extra.model = pick(sys, 'Model', 'Platform') || '';
    snap.version = pick(sys, 'Version', 'System version', 'Software version') || '';
    const h = healthOf(sys);
    if (h !== 'unknown') snap.extra.healthState = h === 'ok' ? 'OK' : h;
    const hd = pick(sys, 'Health details');
    if (hd) snap.extra.healthDetail = hd.slice(0, 200);
    snap.sections.config = 'ok';
  }

  /* ── 소프트웨어 버전(시스템 출력에 없을 때의 보강) ── */
  const soft = recordsFor(out.software || '', ['Version', 'ID', 'Release date']);
  if (soft.length) {
    const v = pick(soft[0], 'Version', 'ID');
    if (v && !snap.version) snap.version = v;
    snap.extra.software = soft.slice(0, 8).map((r) => ({ id: pick(r, 'ID'), version: pick(r, 'Version'), date: pick(r, 'Release date', 'Date') })).filter((x) => x.version || x.id);
  }

  /* ── 풀·용량 ──
     Unity 는 '클러스터 총량' 명령이 버전마다 달라, 어느 버전에나 있는 풀 합계를 진실의 원천으로
     쓴다. **풀 밖 공간은 제외**되므로 그 사실을 화면이 밝힌다(capacityNote). */
  const pools = recordsFor(out.pools || '', ['Name', 'ID', 'Size total', 'Total space']);
  const norm = [];
  let total = 0;
  let used = 0;
  let subscribed = 0;
  for (const p of pools) {
    const name = nameOf(p, norm.length, '');
    if (!name) continue;
    const t = toBytes(pick(p, 'Size total', 'Total space', 'Total capacity', 'Total'));
    const u = toBytes(pick(p, 'Size used', 'Used space', 'Used capacity', 'Used'));
    const sub = toBytes(pick(p, 'Size subscribed', 'Subscribed'));
    if (!t) continue;               // 용량을 못 읽은 풀은 0 으로 채우지 않고 뺀다(개수는 아래에서 밝힌다)
    total += t; used += u; subscribed += sub;
    norm.push({
      name, totalBytes: t, usedBytes: u, pct: Math.round((u / t) * 1000) / 10,
      health: healthOf(p),
      raid: pick(p, 'Raid level', 'RAID level') || undefined,
      driveType: pick(p, 'Drive type', 'Disk type') || undefined,
      disks: Number(pick(p, 'Number of disks', 'Disks')) || undefined,
      subscribedBytes: sub || undefined,
    });
  }
  if (norm.length) {
    snap.pools = norm.slice(0, 32);
    snap.capacity = { totalBytes: total, usedBytes: used, pct: total ? Math.round((used / total) * 1000) / 10 : null };
    snap.sections.capacity = 'ok';
    snap.sections.pools = 'ok';
    if (subscribed > 0) snap.extra.subscribedBytes = subscribed;
    snap.extra.capacityNote = '전체 용량은 **풀 합계**입니다(uemcli /stor/config/pool). 풀에 속하지 않은 미할당 드라이브는 포함되지 않습니다.';
    const dropped = pools.filter((p) => nameOf(p, 0, '') && !toBytes(pick(p, 'Size total', 'Total space', 'Total capacity', 'Total'))).length;
    if (dropped) snap.extra.poolsUnreadable = dropped;   // 조용히 빼지 않는다
  } else if (out.pools != null) {
    // 명령은 돌았는데 풀을 하나도 못 읽었다 — '용량 0' 이 아니라 **형식 미인식**이다.
    snap.sections.capacity = '오류: 풀 출력에서 용량 필드를 인식하지 못했습니다(연결 테스트의 원문 확인).';
    snap.sections.pools = snap.sections.capacity;
  }

  /* ── 스토리지 프로세서 ── */
  const sps = recordsFor(out.sps || '', ['Name', 'ID', 'Health state', 'Model']);
  if (sps.length) {
    const list = sps.map((sp, i) => ({
      id: i + 1,
      ip: pick(sp, 'IP address', 'Address', 'Management IP') || '',
      health: healthOf(sp),
      inBps: null, outBps: null, hdd: null, ssd: null, l3Bytes: 0,
      name: nameOf(sp, i, 'SP'),
      model: pick(sp, 'Model') || undefined,
      memory: pick(sp, 'Memory size', 'Memory') || undefined,
      slot: pick(sp, 'Slot') || undefined,
    }));
    snap.nodes = {
      count: list.length,
      unhealthy: list.filter((n) => n.health !== 'ok' && n.health !== 'unknown').length,
      list: list.slice(0, LIST_MAX),
    };
    snap.sections.nodes = 'ok';
  }

  /* ── 계정 ── */
  const users = recordsFor(out.users || '', ['Name', 'ID', 'Role']);
  if (users.length) {
    snap.accounts = users.slice(0, 200)
      .map((u) => ({ name: pick(u, 'Name', 'ID'), enabled: true, role: pick(u, 'Role') || undefined }))
      .filter((u) => u.name);
    snap.sections.accounts = 'ok';
  } else if (out.users != null) {
    snap.sections.accounts = '오류: 계정 출력을 인식하지 못했습니다(연결 테스트의 원문 확인).';
  }

  /* ── 경보 ── */
  if (out.alerts != null) {
    const alerts = recordsFor(out.alerts, ['ID', 'Severity', 'Message', 'Time']);
    snap.alerts.unresolved = alerts.length;
    // ⚠ 경보 목록은 `extra` 에 둔다 — `types.js` 의 공용 스냅샷 계약은 `alerts:{unresolved}` 뿐이고,
    //   거기에 타입별 필드를 끼워 넣으면 다른 수집기·중앙 수신과 계약이 어긋난다.
    snap.extra.alertsList = alerts.slice(0, 20).map((a) => ({
      severity: pick(a, 'Severity') || '', message: (pick(a, 'Message', 'Description') || '').slice(0, 200),
      at: pick(a, 'Time', 'Timestamp') || '',
    })).filter((a) => a.message || a.severity);
    snap.sections.alerts = 'ok';
    if (!alerts.length) snap.extra.alertsNote = '활성 경보 0건 — 또는 출력 형식을 인식하지 못했습니다(연결 테스트의 원문으로 구분할 수 있습니다).';
  }

  /* ── 구성 상세(deep) ── */
  const hw = {};
  if (out.dpe != null) {
    const r = recordsFor(out.dpe, ['Name', 'ID', 'Model', 'Health state']);
    if (r.length) hw.dpe = summarize(r, (x, i) => ({ id: pick(x, 'ID') || i + 1, name: nameOf(x, i, 'DPE'), model: pick(x, 'Model') || undefined, health: healthOf(x) }));
  }
  if (out.dae != null) {
    const r = recordsFor(out.dae, ['Name', 'ID', 'Model', 'Health state']);
    if (r.length) hw.dae = summarize(r, (x, i) => ({ id: pick(x, 'ID') || i + 1, name: nameOf(x, i, 'DAE'), model: pick(x, 'Model') || undefined, health: healthOf(x) }));
  }
  if (out.psu != null) {
    const r = recordsFor(out.psu, ['Name', 'ID', 'Health state']);
    if (r.length) hw.psu = summarize(r, (x, i) => ({ id: pick(x, 'ID') || i + 1, name: nameOf(x, i, 'PS'), health: healthOf(x) }));
  }
  if (out.fans != null) {
    const r = recordsFor(out.fans, ['Name', 'ID', 'Health state']);
    if (r.length) hw.fan = summarize(r, (x, i) => ({ id: pick(x, 'ID') || i + 1, name: nameOf(x, i, 'FAN'), health: healthOf(x) }));
  }
  if (out.bbu != null) {
    const r = recordsFor(out.bbu, ['Name', 'ID', 'Health state']);
    if (r.length) hw.bbu = summarize(r, (x, i) => ({ id: pick(x, 'ID') || i + 1, name: nameOf(x, i, 'BBU'), health: healthOf(x) }));
  }
  if (out.iom != null) {
    const r = recordsFor(out.iom, ['Name', 'ID', 'Health state', 'Model']);
    if (r.length) hw.ioModule = summarize(r, (x, i) => ({ id: pick(x, 'ID') || i + 1, name: nameOf(x, i, 'IOM'), model: pick(x, 'Model') || undefined, health: healthOf(x) }));
  }
  if (Object.keys(hw).length) snap.extra.hardware = hw;

  /* ── 디스크: 개수가 많아 **타입·용량별 요약**을 우선한다(수백 개를 매 주기 push 하지 않게) ── */
  if (out.disks != null) {
    const r = recordsFor(out.disks, ['Name', 'ID', 'Drive type', 'Health state', 'User capacity']);
    if (r.length) {
      const byType = new Map();
      let rawTotal = 0;
      let unhealthy = 0;
      let unknown = 0;
      for (const d of r) {
        const type = pick(d, 'Drive type', 'Disk type', 'Type') || '알 수 없음';
        const cap = toBytes(pick(d, 'User capacity', 'Capacity', 'Size', 'Raw capacity'));
        rawTotal += cap;
        const h = healthOf(d);
        if (h === 'unknown') unknown += 1; else if (h !== 'ok') unhealthy += 1;
        const e = byType.get(type) || { type, count: 0, bytes: 0 };
        e.count += 1; e.bytes += cap;
        byType.set(type, e);
      }
      snap.extra.disks = {
        count: r.length,
        unhealthy,
        unknown,                       // '상태를 읽지 못한 디스크' — 정상이라는 뜻이 아니다
        rawBytes: rawTotal || null,    // 0 이면 용량을 못 읽은 것 → null(0 으로 위장 금지)
        byType: [...byType.values()].sort((a, b) => b.count - a.count).slice(0, 12),
      };
    }
  }

  /* ── 포트 ── */
  const ports = {};
  for (const [key, label, prefix] of [['ethPorts', 'eth', 'ETH'], ['fcPorts', 'fc', 'FC'], ['sasPorts', 'sas', 'SAS']]) {
    if (out[key] == null) continue;
    const r = recordsFor(out[key], ['Name', 'ID', 'Health state', 'Speed', 'WWN']);
    if (!r.length) continue;
    ports[label] = summarize(r, (x, i) => ({
      id: pick(x, 'ID') || i + 1, name: nameOf(x, i, prefix), health: healthOf(x),
      speed: pick(x, 'Speed', 'Current speed', 'Link speed') || undefined,
      wwn: pick(x, 'WWN') || undefined,
      mtu: pick(x, 'MTU') || undefined,
    }));
  }
  if (Object.keys(ports).length) snap.extra.ports = ports;

  /* ── 프로비저닝(LUN·파일시스템·데이터스토어·NAS·호스트·스냅샷) ──
     개수와 합계가 1순위다(목록 전체를 매 주기 밀면 대역폭이 커진다 — CLAUDE.md). */
  const prov = {};
  const provOf = (key, expect) => {
    if (out[key] == null) return null;
    const r = recordsFor(out[key], expect);
    return r.length ? r : null;
  };
  const luns = provOf('luns', ['Name', 'ID', 'Size', 'Pool']);
  if (luns) {
    let sz = 0;
    for (const l of luns) sz += toBytes(pick(l, 'Size', 'Size total', 'Total capacity'));
    prov.luns = {
      count: luns.length, totalBytes: sz || null,
      top: luns.map((l, i) => ({ name: nameOf(l, i, 'LUN'), bytes: toBytes(pick(l, 'Size', 'Size total')), pool: pick(l, 'Pool') || undefined, health: healthOf(l) }))
        .sort((a, b) => b.bytes - a.bytes).slice(0, 20),
    };
  }
  const fss = provOf('filesystems', ['Name', 'ID', 'Size', 'Size total']);
  if (fss) {
    let t = 0; let u = 0;
    for (const f of fss) { t += toBytes(pick(f, 'Size total', 'Size')); u += toBytes(pick(f, 'Size used', 'Used')); }
    prov.filesystems = {
      count: fss.length, totalBytes: t || null, usedBytes: u || null,
      top: fss.map((f, i) => ({ name: nameOf(f, i, 'FS'), bytes: toBytes(pick(f, 'Size total', 'Size')), usedBytes: toBytes(pick(f, 'Size used', 'Used')), health: healthOf(f) }))
        .sort((a, b) => b.bytes - a.bytes).slice(0, 20),
    };
  }
  const vmfs = provOf('vmfs', ['Name', 'ID', 'Size']);
  const nfsDs = provOf('nfsDs', ['Name', 'ID', 'Size']);
  if (vmfs || nfsDs) {
    prov.vmwareDatastores = {
      vmfs: vmfs ? vmfs.length : null,
      nfs: nfsDs ? nfsDs.length : null,
      list: [...(vmfs || []).map((x, i) => ({ kind: 'VMFS', name: nameOf(x, i, 'VMFS'), bytes: toBytes(pick(x, 'Size', 'Size total')) })),
        ...(nfsDs || []).map((x, i) => ({ kind: 'NFS', name: nameOf(x, i, 'NFS'), bytes: toBytes(pick(x, 'Size', 'Size total')) }))].slice(0, 30),
    };
  }
  const nas = provOf('nasServers', ['Name', 'ID', 'Health state']);
  if (nas) prov.nasServers = summarize(nas, (x, i) => ({ id: pick(x, 'ID') || i + 1, name: nameOf(x, i, 'NAS'), health: healthOf(x), sp: pick(x, 'SP', 'Storage processor') || undefined }));
  const hosts = provOf('hosts', ['Name', 'ID', 'Type', 'Address']);
  if (hosts) prov.hosts = { count: hosts.length, list: hosts.slice(0, 30).map((h, i) => ({ name: nameOf(h, i, 'HOST'), type: pick(h, 'Type', 'Host type') || undefined, address: pick(h, 'Address', 'Network address') || undefined })) };
  const snaps = provOf('snaps', ['Name', 'ID', 'Creation time', 'Source']);
  if (snaps) prov.snapshots = { count: snaps.length };
  if (Object.keys(prov).length) snap.extra.provisioning = prov;

  /* ── 라이선스 ── */
  if (out.license != null) {
    const r = recordsFor(out.license, ['Name', 'ID', 'Feature', 'Installed', 'Expires']);
    if (r.length) {
      snap.extra.licenses = {
        count: r.length,
        list: r.slice(0, 40).map((l, i) => ({
          name: nameOf(l, i, 'LIC'),
          installed: /^(yes|true)$/i.test(pick(l, 'Installed', 'Is installed')) ? true
            : /^(no|false)$/i.test(pick(l, 'Installed', 'Is installed')) ? false : null,
          expires: pick(l, 'Expires', 'Expiration date') || undefined,
        })),
        omitted: Math.max(0, r.length - 40),
      };
    }
  }

  snap.ok = snap.sections.config === 'ok' || snap.sections.capacity === 'ok';
  if (!snap.ok && !snap.error) snap.error = 'uemcli 출력 파싱 실패 — 출력 형식이 예상과 다릅니다(연결 테스트의 원문 확인).';
  return snap;
}

export async function collectViaSsh(device) {
  let raw = [];
  const deep = deepEnabled();
  const specs = specsFor({ deep });
  try {
    const r = await runCliSession(device, specs);
    raw = r.raw;
    // 어떤 후보 명령이 실제로 쓰였나 — 화면이 근거를 보여준다(v2.522 usedCmds 규약).
    const usedCmds = {};
    for (const x of raw) { if (x.ok && !usedCmds[x.key]) usedCmds[x.key] = x.cmd; }
    const snap = normalizeUnitySsh(device, r.out, { usedCmds, deep });
    for (const [key, msg] of Object.entries(r.errors)) {
      const sect = specs.find((s) => s.key === key)?.section;
      if (sect && snap.sections[sect] !== 'ok') snap.sections[sect] = `오류: ${msg}`;
      // 섹션이 없는 항목(구성 상세)의 실패도 버리지 않는다 — 어떤 명령이 없는 장비인지 알려준다.
      if (!sect) {
        snap.extra.missingCmds = snap.extra.missingCmds || {};
        snap.extra.missingCmds[key] = firstLine(msg).slice(0, 120);
      }
    }
    // ⚠ 원문은 **연결 테스트에서만** 전부 담는다. 주기 수집에서 20여 개 명령 × 4KB 를 매번
    //   스냅샷·중앙 push 에 실으면 대역폭이 커진다 — 실패한 명령만 남긴다(진단은 실패에 대한 것).
    snap.extra.cliRaw = device._test === true ? raw : raw.filter((x) => !x.ok);
    snap.extra.cliRawMode = device._test === true ? 'all' : 'failed-only';
    return snap;
  } catch (e) {
    return sshFailureSnapshot(device, e, raw);
  }
}
