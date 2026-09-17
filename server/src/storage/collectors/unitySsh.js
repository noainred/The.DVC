/**
 * storage/collectors/unitySsh.js — Dell Unity SSH(uemcli) 수집기(v2.405 → **v2.525 대폭 확장**).
 *
 * Unity 는 SP 에 SSH 로 접속해 `uemcli` 를 실행할 수 있다. **1순위는 기본(Key = Value) 평문
 * 출력**이다 — 이 현장 장비에서 실제 출력을 받아 본 유일한 형식이고(`test/fixtures/uemcli-*.txt`),
 * `-output csv` 는 뒤 후보로 둔다(v2.530. 그 전 세 번의 순서 뒤집기 경위는 SPECS 머리말 참조).
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
import { stripUemcliBanner } from '../../proxy/sshExec.js';
import { parseSpinfo, memoryFromResume } from './svcDiag.js';

/** 구성 상세(deep) 수집 여부 — 기본 켜짐. 끄면 core 항목만 돈다. */
export const deepEnabled = () => String(process.env.UNITY_SSH_DEEP ?? '1') !== '0';

/** 목록 저장 상한 — push 대역폭·중앙 저장 고려(CLAUDE.md). 잘린 개수는 밝힌다. */
const LIST_MAX = 64;

/**
 * 명령 명세(v2.526 재작성 — **사용자 제공 실제 출력 기준**).
 *
 * ⚠ `answered: true` 가 **필수**다: uemcli 는 자체서명 인증서 수락 프롬프트에서 멈춘다.
 *   없으면 어떤 명령도 데이터를 주지 않는다(v2.525 증상의 실제 원인).
 * ⚠ `-output csv` 는 **후보로만 둔다.** 이 장비에서 확인된 것은 기본(Key = Value) 출력이고,
 *   csv 를 지원하지 않는 버전이면 오류가 나므로 체인의 뒤에 기본 출력을 반드시 남긴다.
 *
 * ── `when` — 수집 주기(사용자 선택 2026-09-16 "구성은 드물게 · 전력은 매번") ──────────
 *  · `'always'` — 매 주기(용량·상태·전력). 화면의 1순위 수치다.
 *  · `'config'` — 긴 주기(기본 6시간, `UNITY_CONFIG_EVERY_MS`). 부품번호·시리얼·포트 목록처럼
 *    거의 변하지 않는 것. 직전 결과를 메모리에 이고 가며(`_configCache`) 스냅샷에 합친다.
 *    **언제 수집한 구성인지 화면이 밝힌다**(`extra.configAt`) — 조용히 낡은 값을 보여주지 않는다.
 */
/**
 * ⚠⚠ **`uemcli` 후보의 첫 자리는 평문(기본) 출력이다**(v2.530 — v2.525·v2.526·v2.529 의
 * 순서 뒤집기를 끝낸다. 사용자 지시 "기존 파싱 자료 모두 삭제하고, 지금 내가 보낸 자료 기반으로
 * 다시 파싱해줘" + 실제 출력 3건 제공).
 *
 * ── 왜 세 번이나 뒤집혔고, 왜 순서가 원인이 아니었나(정직 기록) ────────────────────
 *  v2.525 CSV 우선 → 실패 · v2.526 평문 우선 → 실패 · v2.529 CSV 우선 → 실패.
 *  **셋 다 실패했다는 사실 자체가 순서가 원인이 아니라는 증거다.** 실제 원인은 그 아래층,
 *  `proxy/sshExec.js` 가 `{ pty: true }` 로 **ssh2 기본 80칸 터미널**을 요청한 것이었다 —
 *  장비는 TTY 폭에 맞춰 출력을 접고, 접힌 CSV 는 다음과 같이 읽혔다(사용자 제공 실제 값으로 실측):
 *    · `Current allocation` → `"29973242855424 (27.2T"` (닫는 괄호가 잘림)
 *    · 접힌 조각이 데이터 줄이 되어 **`ID=47%` · 이름 `38 x 3.8T SAS Flash 4` 인 없는 풀 1개**
 *  사용자가 **넓은 터미널로 손수 돌린** 같은 명령은 멀쩡했다. → `WIDE_PTY`(1000칸)로 고쳤고,
 *  `parseCsv` 는 줄이 따옴표 안에서 끊기면 CSV 를 통째로 거부한다(이중 방어).
 *
 * ── 그러면 왜 평문이 첫 자리인가 ────────────────────────────────────────────────
 *  이 장비(OC2-41.237)에서 **실제 출력을 받아 본 형식은 평문뿐이다** — `/stor/config/pool show`,
 *  `/stor/config/pool show -detail`, `/stor/prov/luns/lun show` 세 건(2026-09-16 사용자 캡처).
 *  `test/fixtures/uemcli-*.txt` 가 그 캡처(식별자만 익명화)이고 테스트가 숫자까지 고정한다.
 *  **이 장비의 `-output csv` 출력은 아직 한 번도 보지 못했다.** 검증된 형식을 앞에 두고
 *  미검증 형식을 뒤에 두는 것이 이 순서의 전부다 — 'CSV 가 더 좋다/나쁘다' 는 주장이 아니다.
 *  실장비 CSV 캡처를 받으면 다시 판단할 것.
 */
const SPECS = [
  /* ── 매 주기 ───────────────────────────────────────────────────────────── */
  { key: 'system', section: 'config', required: true, when: 'always', answered: true,
    cmds: ['uemcli /sys/general show -detail', 'uemcli /sys/general show', 'uemcli -output csv /sys/general show -detail'] },
  // 용량·구독(할당량) — 사용자 요청 "디스크 사용량 할당량". `-detail` 이 Current allocation·
  // Subscription·Alert threshold·RAID·Drives 를 준다(실측 캡처로 확인).
  { key: 'pools', section: 'pools', when: 'always', answered: true,
    cmds: ['uemcli /stor/config/pool show -detail', 'uemcli /stor/config/pool show', 'uemcli -output csv /stor/config/pool show -detail'] },
  { key: 'sps', section: 'nodes', when: 'always', answered: true,
    cmds: ['uemcli /env/sp show -detail', 'uemcli /env/sp show', 'uemcli -output csv /env/sp show -detail'] },
  { key: 'alerts', section: 'alerts', when: 'always', answered: true,
    cmds: ['uemcli /event/alert/hist show -active', 'uemcli /event/alert/hist show', 'uemcli -output csv /event/alert/hist show -active'] },
  // 전력·FRU 상태·부품 인벤토리를 한 번에 주는 유일한 명령(Unisphere 계정 불필요).
  // ⚠ 출력이 길고 `--More--` 로 멈추므로 페이저 자동 응답이 필요하다.
  { key: 'spinfo', when: 'always', answered: true, rules: ['pager', 'certAccept'],
    bin: 'svc_diag', cmds: ['svc_diag -s spinfo'] },

  /* ── 긴 주기(구성) ─────────────────────────────────────────────────────── */
  { key: 'software', when: 'config', answered: true, cmds: ['uemcli /sys/soft/ver show', 'uemcli -output csv /sys/soft/ver show'] },
  { key: 'license', when: 'config', answered: true, cmds: ['uemcli /sys/lic show', 'uemcli -output csv /sys/lic show'] },
  { key: 'users', section: 'accounts', when: 'config', answered: true, cmds: ['uemcli /user/account show', 'uemcli -output csv /user/account show'] },
  // 물리 디스크 — 실측 필드: ID·Enclosure·Slot·Health state·Tier·User capacity·Pool
  { key: 'disks', when: 'config', answered: true,
    cmds: ['uemcli /env/disk show -detail', 'uemcli /env/disk show', 'uemcli -output csv /env/disk show -detail'] },
  { key: 'dpe', when: 'config', answered: true, cmds: ['uemcli /env/dpe show', 'uemcli -output csv /env/dpe show'] },
  { key: 'dae', when: 'config', answered: true, cmds: ['uemcli /env/dae show', 'uemcli -output csv /env/dae show'] },
  { key: 'iom', when: 'config', answered: true, cmds: ['uemcli /env/iomodule show', 'uemcli -output csv /env/iomodule show'] },
  { key: 'ethPorts', when: 'config', answered: true, cmds: ['uemcli /net/port/eth show', 'uemcli -output csv /net/port/eth show'] },
  { key: 'fcPorts', when: 'config', answered: true, cmds: ['uemcli /net/port/fc show', 'uemcli -output csv /net/port/fc show'] },
  { key: 'sasPorts', when: 'config', answered: true, cmds: ['uemcli /net/port/sas show', 'uemcli -output csv /net/port/sas show'] },
  // LUN — 실측 필드(사용자 캡처): ID·Name·Storage pool·Type·Health state·Size·SP owner·Trespassed.
  { key: 'luns', when: 'config', answered: true,
    cmds: ['uemcli /stor/prov/luns/lun show -detail', 'uemcli /stor/prov/luns/lun show', 'uemcli -output csv /stor/prov/luns/lun show -detail'] },
  { key: 'filesystems', when: 'config', answered: true,
    cmds: ['uemcli /stor/prov/fs show -detail', 'uemcli /stor/prov/fs show', 'uemcli -output csv /stor/prov/fs show -detail'] },
  { key: 'vmfs', when: 'config', answered: true, cmds: ['uemcli /stor/prov/vmware/vmfs show', 'uemcli -output csv /stor/prov/vmware/vmfs show'] },
  { key: 'nfsDs', when: 'config', answered: true, cmds: ['uemcli /stor/prov/vmware/nfs show', 'uemcli -output csv /stor/prov/vmware/nfs show'] },
  { key: 'nasServers', when: 'config', answered: true, cmds: ['uemcli /net/nas/server show', 'uemcli -output csv /net/nas/server show'] },
  { key: 'hosts', when: 'config', answered: true, cmds: ['uemcli /remote/host show', 'uemcli -output csv /remote/host show'] },
  { key: 'snaps', when: 'config', answered: true, cmds: ['uemcli /prot/snap show', 'uemcli -output csv /prot/snap show'] },
  // NAS 할당량(사용자 요청 "할당량"). ⚠ 이 장비에서는 `-filesystem` 같은 필수 인자를 요구해
  //   문법 오류가 난다(실측: `Expected one of the following mandatory keywords`). 그건 오류가 아니라
  //   **'이 명령은 대상 지정이 필요하다'** 는 뜻이므로 화면이 그렇게 말한다(없는 값을 지어내지 않는다).
  { key: 'quotaConfig', when: 'config', answered: true, cmds: ['uemcli /quota/config show', 'uemcli -output csv /quota/config show'] },
  { key: 'quotaTree', when: 'config', answered: true, cmds: ['uemcli /quota/tree show', 'uemcli -output csv /quota/tree show'] },
];

/** 이 주기에 돌릴 명세. `configRound:false` 면 긴 주기 항목을 뺀다. */
export function specsFor({ deep = deepEnabled(), configRound = true } = {}) {
  return SPECS.filter((s) => {
    if (s.when === 'config' && !configRound) return false;
    if (s.when === 'config' && !deep) return false;    // deep 을 끄면 구성 수집 자체를 안 한다
    return true;
  });
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

  /* ── 풀·용량·할당량 ──
     Unity 는 '클러스터 총량' 명령이 버전마다 달라, 어느 버전에나 있는 풀 합계를 진실의 원천으로
     쓴다. **풀 밖 공간은 제외**되므로 그 사실을 화면이 밝힌다(`capacityBasisNote`).

     ⚠ v2.526 정정 — **사용량 필드는 `Current allocation` 이다**(사용자 제공 실측):
       Total space = 117544396521472 (106.9T)
       Current allocation = 29973242855424 (27.2T)   ← 실제 쓰고 있는 물리 공간
       Remaining space = 87568746020864 (79.6T)
       Subscription = 55491782770688 (50.4T)         ← 호스트에 약속한 크기(씬 구독)
       Subscription percent = 47%
     v2.525 까지는 `Size used`·`Used space`·`Used capacity`·`Used` 만 찾아 **하나도 맞지 않았고**
     사용량이 0 으로 나왔다. 후보에서 `Current allocation` 을 빼지 말 것.
     ⚠ **구독(Subscription)은 사용량이 아니다.** 씬 프로비저닝에서 구독이 전체를 넘을 수 있고
       (오버프로비저닝) 그것 자체는 정상이다 — 사용량으로 섞으면 '100% 넘게 썼다' 는 거짓이 된다. */
  const pools = recordsFor(out.pools || '', ['Name', 'ID', 'Total space', 'Current allocation', 'Size total']);
  const norm = [];
  let total = 0;
  let used = 0;
  let subscribed = 0;
  const poolTotalOf = (p) => toBytes(pick(p, 'Total space', 'Size total', 'Total capacity', 'Total'));
  for (const p of pools) {
    const name = nameOf(p, norm.length, '');
    if (!name) continue;
    const t = poolTotalOf(p);
    let u = toBytes(pick(p, 'Current allocation', 'Size used', 'Used space', 'Used capacity', 'Used'));
    const free = toBytes(pick(p, 'Remaining space', 'Size free', 'Free'));
    // ⚠ `-detail` 없이 `pool show` 만 성공하면 **사용량 필드가 아예 없다**(사용자 캡처로 확인 —
    //   평문 `show` 는 Total/Remaining 만 준다). 그대로 두면 화면에 **`0 · 0%` 라는 거짓**이 찍힌다.
    //   전체 − 잔여로 되돌려 쓰되(실측 대조: 106.9T − 79.6T = 27.26T vs 실제 27.2T) 계산값임을
    //   `usedSource` 로 **밝힌다** — 장비가 준 값과 우리가 뺀 값을 같은 것처럼 말하지 않는다.
    const usedSource = u ? 'device' : (t && free ? 'derived' : null);
    if (!u && usedSource === 'derived') u = Math.max(0, t - free);
    const sub = toBytes(pick(p, 'Subscription', 'Size subscribed', 'Subscribed'));
    if (!t) continue;               // 용량을 못 읽은 풀은 0 으로 채우지 않고 뺀다(개수는 아래에서 밝힌다)
    total += t; used += u; subscribed += sub;
    const pctNum = (v) => { const n = Number(String(v || '').replace('%', '').trim()); return Number.isFinite(n) ? n : undefined; };
    norm.push({
      name, totalBytes: t, usedBytes: u, pct: Math.round((u / t) * 1000) / 10,
      usedSource: usedSource || undefined,
      health: healthOf(p),
      freeBytes: free || undefined,
      subscribedBytes: sub || undefined,
      // 구독률 — 장비가 준 값을 우선하고, 없으면 계산한다(계산값임을 구분하지 않으면 근거가 흐려지므로
      // 장비값이 있을 때만 `subscriptionPctSource:'device'`).
      subscriptionPct: pctNum(pick(p, 'Subscription percent')) ?? (t ? Math.round((sub / t) * 1000) / 10 : undefined),
      subscriptionPctSource: pick(p, 'Subscription percent') ? 'device' : 'calc',
      alertThresholdPct: pctNum(pick(p, 'Alert threshold')),
      raid: pick(p, 'RAID level', 'Raid level') || undefined,
      stripeLength: Number(pick(p, 'Stripe length')) || undefined,
      // 실측 형식: `Drives = 38 x 3.8T SAS Flash 4` — 종류가 이 문자열에만 있다(`Drive type` 필드 없음).
      drives: pick(p, 'Drives') || undefined,
      disks: Number(pick(p, 'Number of drives', 'Number of disks', 'Disks')) || undefined,
      poolType: pick(p, 'Type') || undefined,
      allFlash: /^yes$/i.test(pick(p, 'All flash pool')) ? true : (/^no$/i.test(pick(p, 'All flash pool')) ? false : undefined),
      dataReductionRatio: pick(p, 'Data Reduction Ratio') || undefined,
      dataReductionSaved: toBytes(pick(p, 'Data Reduction space saved')) || undefined,
      rebalancing: /^yes$/i.test(pick(p, 'Rebalancing')) ? true : (/^no$/i.test(pick(p, 'Rebalancing')) ? false : undefined),
    });
  }
  if (norm.length) {
    snap.pools = norm.slice(0, 32);
    snap.capacity = { totalBytes: total, usedBytes: used, pct: total ? Math.round((used / total) * 1000) / 10 : null };
    snap.sections.capacity = 'ok';
    snap.sections.pools = 'ok';
    if (subscribed > 0) {
      snap.extra.subscribedBytes = subscribed;
      snap.extra.subscriptionPct = total ? Math.round((subscribed / total) * 1000) / 10 : null;
      // 오버프로비저닝은 **정상일 수 있다** — 경고가 아니라 사실로 적는다.
      snap.extra.overProvisioned = total > 0 && subscribed > total;
    }
    // ⚠ **`capacityNote` 라는 키를 쓰지 말 것**(v2.526 에 Chromium 판독으로 발견한 실제 결함):
    //   화면의 `isVirt`(StorageMonTool.jsx)가 그 키의 **존재만으로** 'VPLEX/Metro Node — 자체 용량
    //   없는 가상화 계층' 으로 판정해 **용량 추이 차트를 숨긴다**. 두 문구는 뜻이 다르다 —
    //   VPLEX 는 '용량이 없다', 여기는 '용량 숫자를 이렇게 읽으라' 다. 키를 분리한다.
    snap.extra.capacityBasisNote = '사용량은 풀의 **Current allocation**(실제 할당된 물리 공간)이고, 구독(Subscription)은 **호스트에 약속한 크기**라 서로 다릅니다. 전체 용량은 **풀 합계**이므로 풀에 속하지 않은 미할당 드라이브는 포함되지 않습니다.';
    const dropped = pools.filter((p) => nameOf(p, 0, '') && !poolTotalOf(p)).length;
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

  /* ── 물리 디스크(사용자 요청 "디스크 관련 정보를 충실하게") ──
     개수가 많아 요약을 1순위로 두되(수백 개를 매 주기 push 하지 않게) **슬롯 단위 목록도** 담는다.

     ⚠ v2.526 실측 — `uemcli /env/disk show` 의 필드는 다음뿐이다:
       ID · Enclosure · Slot · Bank slot · Health state · Tier · User capacity · Pool ID · Pool
     **`Drive type` 필드가 없다**(v2.525 코드가 찾던 것). 종류는 `Tier`(예: Extreme Performance)
     로 묶고, 매체 표기는 풀의 `Drives = 38 x 3.8T SAS Flash 4` 문자열이 보완한다. */
  if (out.disks != null) {
    const r = recordsFor(out.disks, ['ID', 'Slot', 'Health state', 'User capacity', 'Tier']);
    if (r.length) {
      const byTier = new Map();
      const byPool = new Map();
      let rawTotal = 0;
      let unhealthy = 0;
      let unknown = 0;
      let unpooled = 0;
      const list = [];
      for (const d of r) {
        // Tier 우선 — `Drive type` 은 이 버전에 없지만 다른 버전엔 있을 수 있어 후보로 남긴다.
        const tier = pick(d, 'Tier', 'Drive type', 'Disk type') || '알 수 없음';
        const cap = toBytes(pick(d, 'User capacity', 'Capacity', 'Size', 'Raw capacity'));
        rawTotal += cap;
        const h = healthOf(d);
        if (h === 'unknown') unknown += 1; else if (h !== 'ok') unhealthy += 1;
        const pool = pick(d, 'Pool', 'Pool ID');
        if (!pool) unpooled += 1;      // 풀에 속하지 않은 드라이브(스페어·미할당) — 전체 용량에 안 잡힌다
        const te = byTier.get(tier) || { tier, count: 0, bytes: 0 };
        te.count += 1; te.bytes += cap; byTier.set(tier, te);
        const pe = byPool.get(pool || '(미할당)') || { pool: pool || '(미할당)', count: 0, bytes: 0 };
        pe.count += 1; pe.bytes += cap; byPool.set(pe.pool, pe);
        if (list.length < LIST_MAX) {
          list.push({
            id: pick(d, 'ID') || '', enclosure: pick(d, 'Enclosure') || '',
            slot: pick(d, 'Slot') || '', tier, bytes: cap || null, pool: pool || '',
            health: h, healthRaw: pick(d, 'Health state') || '',
          });
        }
      }
      snap.extra.disks = {
        count: r.length,
        unhealthy,
        unknown,                       // '상태를 읽지 못한 디스크' — 정상이라는 뜻이 아니다
        unpooled,                      // 풀 밖 드라이브(스페어 등) — 전체 용량에 포함되지 않는 이유
        rawBytes: rawTotal || null,    // 0 이면 용량을 못 읽은 것 → null(0 으로 위장 금지)
        byTier: [...byTier.values()].sort((a, b) => b.count - a.count).slice(0, 12),
        byPool: [...byPool.values()].sort((a, b) => b.count - a.count).slice(0, 12),
        list,
        omitted: Math.max(0, r.length - list.length),
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
  // ⚠ v2.526 실측 — LUN 의 풀 필드는 **`Storage pool`** 이다(`Pool` 이 아니다).
  //   실측 필드: ID · Name · Storage pool ID · Storage pool · Type · Health state · Size ·
  //              Protection size used · Non-base size used · SP owner · Trespassed
  //   `-detail` 이 실제 할당량을 준다고 보지만 **확인하지 못했다** — 후보로만 읽고 없으면 null 이다.
  const luns = provOf('luns', ['ID', 'Name', 'Size', 'Storage pool']);
  if (luns) {
    let sz = 0;
    let alloc = 0;
    let allocRead = 0;
    const lunOf = (l, i) => {
      const bytes = toBytes(pick(l, 'Size', 'Size total', 'Total capacity'));
      const a = toBytes(pick(l, 'Current allocation', 'Size allocated', 'Allocated'));
      return {
        name: nameOf(l, i, 'LUN'),
        bytes,
        // 할당량을 못 읽으면 **null** — 0 으로 채우면 '아무것도 안 썼다' 는 거짓이 된다.
        allocatedBytes: a || null,
        pool: pick(l, 'Storage pool', 'Storage pool ID', 'Pool') || undefined,
        spOwner: pick(l, 'SP owner') || undefined,
        trespassed: /^yes$/i.test(pick(l, 'Trespassed')) ? true : undefined,
        thin: /^yes$/i.test(pick(l, 'Thin provisioning enabled', 'Thin')) ? true : undefined,
        health: healthOf(l),
      };
    };
    const rows = luns.map(lunOf);
    for (const x of rows) { sz += x.bytes || 0; if (x.allocatedBytes != null) { alloc += x.allocatedBytes; allocRead += 1; } }
    prov.luns = {
      count: luns.length,
      totalBytes: sz || null,
      // 몇 개에서 할당량을 읽었는지 밝힌다 — 일부만 읽고 전체 합인 척하지 않는다.
      allocatedBytes: allocRead ? alloc : null,
      allocatedRead: allocRead,
      top: rows.sort((a, b) => (b.bytes || 0) - (a.bytes || 0)).slice(0, 20),
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

  /* ── NAS 할당량(사용자 요청 "할당량") ──
     ⚠ 실측: 이 장비에서 `uemcli /quota/tree show` 는 **문법 오류**다
       `Expected one of the following mandatory keywords: "--help", "-?", "-h", "-help"`
     즉 '대상(파일시스템)을 지정해야 하는 명령' 이지 '쿼터가 0개' 가 아니다.
     **'쿼터 없음' 이라고 말하지 않는다** — 확인하지 못한 것을 없다고 하면 거짓이다. */
  const quota = {};
  for (const [key, label] of [['quotaTree', '쿼터 트리'], ['quotaConfig', '쿼터 설정']]) {
    if (out[key] == null) continue;                    // 명령 실패 — missingCmds 가 사유를 갖는다
    const r = recordsFor(out[key], ['ID', 'File system', 'Path', 'Hard limit', 'Soft limit', 'Size used']);
    quota[key] = {
      label,
      count: r.length,
      list: r.slice(0, 40).map((q, i) => ({
        id: pick(q, 'ID') || `${i + 1}`,
        filesystem: pick(q, 'File system', 'Filesystem') || '',
        path: pick(q, 'Path') || '',
        hardBytes: toBytes(pick(q, 'Hard limit')) || null,
        softBytes: toBytes(pick(q, 'Soft limit')) || null,
        usedBytes: toBytes(pick(q, 'Size used', 'Used')) || null,
        state: pick(q, 'State') || '',
      })),
      omitted: Math.max(0, r.length - 40),
    };
  }
  if (Object.keys(quota).length) snap.extra.quota = quota;

  /* ── svc_diag spinfo — FRU 상태·부품 인벤토리·전원(Unisphere 계정 불필요) ── */
  if (out.spinfo != null) {
    const sp = parseSpinfo(out.spinfo);
    if (sp.parsed) {
      const mem = memoryFromResume(sp.resume);
      snap.extra.hw = {
        systemType: sp.systemType, spId: sp.spId, dpeTempC: sp.dpeTemp,
        fru: {
          total: sp.fru.total, ok: sp.fru.ok,
          // 빈 슬롯·확인 불가를 **이상으로 세지 않는다**(svcDiag.js 머리말 규칙 1·2).
          empty: sp.fru.empty, unknown: sp.fru.unknown, fault: sp.fru.fault,
          faults: sp.fru.faults.map((f) => ({ name: f.name, sp: f.sp, kind: f.kind, raw: f.raw })),
          items: sp.fru.items.slice(0, 200),
          sps: sp.fru.sps,
        },
        memory: mem,
        inventory: sp.resume.devices.slice(0, 40),
        inventoryOmitted: sp.resume.omitted,
        inventoryReadErrors: sp.resume.readErrors,
        truncated: sp.truncated,
      };
      if (sp.power.supplies.length) {
        snap.extra.power = {
          ...sp.power,
          // `ps0: OK 330` 의 숫자(FRU 트리)와 `Input Power : 330 Watts`(전원 요약)가 같은 값인지
          // 화면이 대조할 수 있게 둘 다 싣는다 — 근거를 숨기지 않는다.
          fromFru: sp.fru.items.filter((x) => x.kind === 'psu' && x.value != null)
            .map((x) => ({ name: x.name, sp: x.sp, watts: x.value })),
        };
      }
    } else {
      snap.extra.hwNote = 'svc_diag 출력을 인식하지 못했습니다(형식 미인식) — 연결 테스트의 원문을 확인하세요.';
    }
  }

  snap.ok = snap.sections.config === 'ok' || snap.sections.capacity === 'ok';
  if (!snap.ok && !snap.error) snap.error = 'uemcli 출력 파싱 실패 — 출력 형식이 예상과 다릅니다(연결 테스트의 원문 확인).';
  return snap;
}

/**
 * 긴 주기(구성) 캐시 — 사용자 선택 "구성은 드물게 · 전력은 매번"(2026-09-16).
 *
 * 부품번호·시리얼·포트 목록은 거의 변하지 않는데 uemcli 한 번이 1~3초다. 매 주기 20여 개를
 * 돌리면 SSH 세션을 그만큼 붙잡는다. 그래서 구성 명령은 기본 6시간마다만 돌리고 직전 결과를
 * 메모리에 이고 간다.
 *
 * ⚠ **낡은 구성을 지금 값인 척하지 않는다** — `extra.configAt` 으로 언제 수집한 것인지 밝힌다.
 * ⚠ 메모리 캐시라 재시작하면 비고, 그 다음 첫 주기가 전량을 수집한다(디스크에 쓰지 않는다 —
 *   재생성 가능한 값이고 스냅샷 저장소가 이미 최신 1건을 갖는다).
 */
const CONFIG_EVERY_MS = Math.max(60_000, Number(process.env.UNITY_CONFIG_EVERY_MS) || 6 * 3_600_000);
const _configCache = new Map();   // deviceId -> { at, out, usedCmds, errors }

export function _resetConfigCacheForTest() { _configCache.clear(); }

export async function collectViaSsh(device) {
  let raw = [];
  const deep = deepEnabled();
  const id = String(device?.id || '');
  const cached = _configCache.get(id);
  // 연결 테스트는 항상 전량 수집한다 — '지금 무엇이 되는지' 를 보는 것이 목적이다.
  const configRound = device._test === true || !cached || (Date.now() - cached.at) >= CONFIG_EVERY_MS;
  const specs = specsFor({ deep, configRound });
  try {
    // 배너·인증서 프롬프트를 걷어낸 뒤 오류 판정·파싱을 한다(둘이 같은 텍스트를 봐야 한다).
    const r = await runCliSession(device, specs, { clean: stripUemcliBanner });
    raw = r.raw;
    // 어떤 후보 명령이 실제로 쓰였나 — 화면이 근거를 보여준다(v2.522 usedCmds 규약).
    const usedCmds = {};
    for (const x of raw) { if (x.ok && !usedCmds[x.key]) usedCmds[x.key] = x.cmd; }

    let out = r.out;
    let errors = r.errors;
    let configAt = configRound ? Date.now() : (cached?.at || null);
    if (configRound) {
      // 이번에 받은 구성만 따로 떼어 캐시한다(매 주기 항목은 캐시하지 않는다 — 낡으면 안 된다).
      const cfgKeys = SPECS.filter((x) => x.when === 'config').map((x) => x.key);
      const cfgOut = {}; const cfgUsed = {}; const cfgErr = {};
      for (const k of cfgKeys) {
        if (out[k] !== undefined) cfgOut[k] = out[k];
        if (usedCmds[k]) cfgUsed[k] = usedCmds[k];
        if (errors[k]) cfgErr[k] = errors[k];
      }
      _configCache.set(id, { at: configAt, out: cfgOut, usedCmds: cfgUsed, errors: cfgErr });
    } else if (cached) {
      // 이번 주기에 돌리지 않은 구성은 직전 값을 합친다(덮어쓰지 않는다 — 이번 값이 우선).
      out = { ...cached.out, ...out };
      errors = { ...cached.errors, ...errors };
      for (const [k, v] of Object.entries(cached.usedCmds)) if (!usedCmds[k]) usedCmds[k] = v;
    }

    const snap = normalizeUnitySsh(device, out, { usedCmds, deep });
    snap.extra.configAt = configAt;
    snap.extra.configEveryMs = CONFIG_EVERY_MS;
    snap.extra.configRound = configRound;
    // v2.528: 세션 예산으로 이번 주기에 **시작조차 하지 않은** 명령을 밝힌다(조용한 생략 금지).
    // 이 값이 자주 보이면 명령이 너무 많거나 장비가 느린 것이다 — 화면이 그 사실을 말한다.
    if (r.skipped?.length) snap.extra.cliSkipped = r.skipped.length;
    if (r.elapsedMs != null) { snap.extra.cliElapsedMs = r.elapsedMs; snap.extra.cliBudgetMs = r.budgetMs; }
    // v2.539: 끊긴 명령(시한/자동응답 상한)은 **형식 문제와 구분해** 말한다. 실제 사고 — 인증서 프롬프트
    //   에코 루프가 400회 응답 뒤 명령을 죽였는데, 파서는 배너만 받고 '형식이 예상과 다릅니다' 라고 했다.
    //   섹션이 ok 가 아니면 그 섹션의 사유를 '끊김' 으로 바꾼다(형식 사유보다 앞선 원인이다).
    const truncated = r.truncated || {};
    if (Object.keys(truncated).length) snap.extra.cliTruncated = truncated;
    for (const [key, t] of Object.entries(truncated)) {
      const sect = SPECS.find((s2) => s2.key === key)?.section;
      if (!sect || snap.sections[sect] === 'ok') continue;
      snap.sections[sect] = `오류: 명령 출력이 끊겼습니다(${t.timedOut ? '시한 초과' : '자동응답 상한'} · 자동응답 ${t.answers}회 · ${Math.round(t.ms / 1000)}초 · ${t.bytes}B 수신) — 형식 문제가 아니라 대화형 프롬프트/시간 문제일 수 있습니다(상세의 CLI 원문 확인).`;
    }
    for (const [key, msg] of Object.entries(errors)) {
      const sect = SPECS.find((s2) => s2.key === key)?.section;
      if (sect && snap.sections[sect] !== 'ok' && !/끊겼습니다/.test(String(snap.sections[sect]))) snap.sections[sect] = `오류: ${msg}`;
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
