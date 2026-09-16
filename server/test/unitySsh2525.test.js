/**
 * test/unitySsh2525.test.js — Unity SSH(uemcli) 수집 회귀 고정(v2.525).
 *
 * 사용자 신고(2026-09-16): **"unity 장비에 ssh 로 접속은 성공했는데, 수집하는 정보가 없어"**
 * (화면: `config: OK · capacity: 건너뜀 · 풀 0 · 전체 용량 —` · `SP 1대 이름 SP0 상태 ?`).
 *
 * 원인은 수집 실패가 아니라 **파싱 실패** 두 건이었다. 이 파일이 그 두 경계를 고정한다:
 *  ① `toBytes` 가 uemcli 표기 `12094627905536 (11.0T)` 를 0 으로 버렸다 → 풀이 전부 탈락.
 *  ② CSV 파서 결과가 비어 있지 않기만 하면 그것을 써서, 배너의 쉼표 한 개로 **필드 없는
 *     레코드 1건**이 만들어졌다 → 없는 SP 가 있는 것처럼 보였다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// cwd 에 의존하지 않게 테스트 파일 기준 경로를 쓴다(`npm test` 는 server/ 에서 돈다).
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const { toBytes, parseCsv, parseKeyValueBlocks } = await import('../src/storage/collectors/cliSsh.js');
const { normalizeUnitySsh, recordsFor, specsFor } = await import('../src/storage/collectors/unitySsh.js');

const DEV = { id: 'u1', type: 'unity', name: 'OC2-42.237', host: '10.94.41.237', username: 'admin' };

/* ─── ① toBytes ────────────────────────────────────────────────────────────── */

test('toBytes: uemcli 의 `바이트 (사람용)` 표기를 바이트로 읽는다', () => {
  assert.equal(toBytes('12094627905536 (11.0T)'), 12094627905536,
    '이 형태를 0 으로 버리면 풀이 전부 탈락해 용량 섹션이 건너뜀이 된다(v2.525 사용자 신고의 원인)');
  assert.equal(toBytes('4292605440 (4.0G)'), 4292605440);
  // 괄호 안 표기는 **반올림**이므로 앞의 정수 바이트를 우선해야 한다 — 그렇지 않으면 용량이
  // 미세하게 틀리고, 추이 그래프에서 실제 변화가 없는데 계단이 생긴다.
  assert.equal(toBytes('393216000000 (366.3G)'), 393216000000);
  assert.notEqual(toBytes('393216000000 (366.3G)'), toBytes('366.3G'));
});

test('toBytes: 단위 표기·구분자·미지정 값', () => {
  assert.equal(toBytes('1536G'), 1536 * 1024 ** 3);
  assert.equal(toBytes('1.5 TB'), Math.round(1.5 * 1024 ** 4));
  assert.equal(toBytes('500 MiB'), 500 * 1024 ** 2);
  assert.equal(toBytes('1,024'), 1024);
  assert.equal(toBytes('12345678'), 12345678);
  assert.equal(toBytes('11.0T (12094627905536)'), 12094627905536, '순서가 뒤바뀐 표기도 받는다');
  for (const v of ['-', 'N/A', 'n/a', 'none', 'unknown', '', null, undefined]) {
    assert.equal(toBytes(v), 0, `'${v}' 는 0(미지정)이어야 한다`);
  }
});

/* ─── ② 파서 채점 ──────────────────────────────────────────────────────────── */

test('recordsFor: 배너의 쉼표 때문에 생긴 빈 레코드를 쓰지 않는다', () => {
  // uemcli 기본 출력 앞에 쉼표가 든 배너가 붙은 경우.
  const text = [
    'Storage system address: 10.94.41.237, port: 443',
    '',
    '1:    Name = SPA',
    '      Health state = OK (5)',
    '      IP address = 10.94.41.238',
    '',
  ].join('\n');
  const recs = recordsFor(text, ['Name', 'ID', 'Health state']);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].Name, 'SPA', 'CSV 쪽이 이겨서 필드 없는 레코드가 남으면 없는 SP 가 있는 것처럼 보인다');
  assert.equal(recs[0]['Health state'], 'OK (5)');
});

test('recordsFor: CSV 가 제대로 있으면 CSV 를 쓴다', () => {
  const text = 'ID,Name,Health state\nspa,SPA,OK (5)\nspb,SPB,OK (5)\n';
  const recs = recordsFor(text, ['Name', 'ID', 'Health state']);
  assert.equal(recs.length, 2);
  assert.equal(recs[1].Name, 'SPB');
});

test('recordsFor: 둘 다 못 읽으면 빈 배열이다(읽은 척하지 않는다)', () => {
  assert.deepEqual(recordsFor('Operation not permitted, contact administrator', ['Name', 'ID']), []);
  assert.deepEqual(recordsFor('', ['Name']), []);
});

/* ─── 정규화: 용량 ────────────────────────────────────────────────────────── */

const POOL_CSV = [
  'ID,Name,Health state,Raid level,Number of disks,Drive type,Size free,Size total,Size used,Size subscribed',
  'pool_1,Pool 0,OK (5),5,15,SAS,3298534883328 (3.0T),12094627905536 (11.0T),8796093022208 (8.0T),15393162788864 (14.0T)',
  'pool_2,Pool 1,OK (5),5,10,SAS Flash,1099511627776 (1.0T),5497558138880 (5.0T),4398046511104 (4.0T),5497558138880 (5.0T)',
].join('\n');

test('정규화: 풀 합계로 용량을 채우고 근거를 밝힌다', () => {
  const snap = normalizeUnitySsh(DEV, {
    system: 'ID,Name,Model,Version\nAPM001,OC2-42.237,Unity 380F,5.3.0\n',
    pools: POOL_CSV,
  });
  assert.equal(snap.sections.capacity, 'ok', '이것이 v2.525 이전에 건너뜀이었다');
  assert.equal(snap.capacity.totalBytes, 12094627905536 + 5497558138880);
  assert.equal(snap.capacity.usedBytes, 8796093022208 + 4398046511104);
  assert.equal(snap.pools.length, 2);
  assert.equal(snap.pools[0].raid, '5');
  // ⚠ v2.526 정정: 실장비 출력에는 **`Drive type` 필드가 없다**(사용자 제공 `/env/disk show`·
  //   `/stor/config/pool show -detail` 실측). 매체 표기는 풀의 `Drives = 38 x 3.8T SAS Flash 4`
  //   문자열뿐이라 `driveType` 을 빼고 원문 문자열(`drives`)을 그대로 싣는다 — 없는 필드를
  //   추측해 채우지 않는다. 이 픽스처는 `Drive type` 열이 있는 가상의 버전이므로 값이 없다.
  assert.equal(snap.pools[0].driveType, undefined);
  assert.equal(snap.pools[0].disks, 15);
  assert.equal(snap.pools[0].health, 'ok');
  assert.match(snap.extra.capacityNote, /풀 합계/, '풀 밖 공간이 빠진다는 사실을 화면이 밝혀야 한다');
  assert.equal(snap.name, 'OC2-42.237');
  assert.equal(snap.extra.model, 'Unity 380F');
  assert.equal(snap.version, '5.3.0');
  assert.equal(snap.ok, true);
});

test('정규화: 풀 명령은 돌았는데 용량을 못 읽으면 `건너뜀` 이 아니라 오류로 말한다', () => {
  const snap = normalizeUnitySsh(DEV, {
    system: 'ID,Name\nAPM001,OC2\n',
    pools: 'some unexpected output without fields',
  });
  assert.match(String(snap.sections.capacity), /^오류/,
    "'건너뜀' 은 '수집하지 않았다' 는 뜻이라 형식 미인식을 그것으로 덮으면 원인을 감춘다");
  assert.equal(snap.capacity.totalBytes, 0);
});

test('정규화: 용량을 못 읽은 풀은 합계에서 빼고 개수를 밝힌다', () => {
  const snap = normalizeUnitySsh(DEV, {
    pools: ['ID,Name,Size total,Size used',
      'pool_1,Pool 0,12094627905536 (11.0T),8796093022208 (8.0T)',
      'pool_2,Pool 1,,'].join('\n'),
  });
  assert.equal(snap.pools.length, 1);
  assert.equal(snap.extra.poolsUnreadable, 1, '조용히 빼면 전체 용량이 왜 작은지 알 수 없다');
});

/* ─── 정규화: SP·상태 ────────────────────────────────────────────────────── */

test('정규화: SP 이름·IP·모델을 읽고 상태를 지어내지 않는다', () => {
  const snap = normalizeUnitySsh(DEV, {
    sps: 'ID,Name,Health state,IP address,Model,Memory size\nspa,SPA,OK (5),10.94.41.238,Unity 380F,192G\nspb,SPB,Degraded (10),10.94.41.239,Unity 380F,192G\n',
  });
  assert.equal(snap.nodes.count, 2);
  assert.equal(snap.nodes.list[0].name, 'SPA');
  assert.equal(snap.nodes.list[0].ip, '10.94.41.238');
  assert.equal(snap.nodes.list[0].health, 'ok');
  assert.match(snap.nodes.list[1].health, /degraded/);
  assert.equal(snap.nodes.unhealthy, 1);
});

test('정규화: 상태 필드가 없으면 unknown 이고 비정상으로 세지 않는다', () => {
  const snap = normalizeUnitySsh(DEV, { sps: 'ID,Name\nspa,SPA\n' });
  assert.equal(snap.nodes.list[0].health, 'unknown');
  assert.equal(snap.nodes.unhealthy, 0, "'모른다' 를 '이상' 으로 세면 거짓 경보가 된다");
});

/* ─── 구성 정보(사용자 요청 "최대한 많은 정보") ──────────────────────────── */

test('구성: 드라이브를 타입별로 요약하고 미확인 개수를 따로 센다', () => {
  const snap = normalizeUnitySsh(DEV, {
    disks: ['ID,Name,Drive type,Health state,User capacity',
      'dpe_disk_0,DISK 0,SAS,OK (5),1181116006400 (1.1T)',
      'dpe_disk_1,DISK 1,SAS,OK (5),1181116006400 (1.1T)',
      'dpe_disk_2,DISK 2,SAS Flash,Degraded (10),393216000000 (366.3G)',
      'dpe_disk_3,DISK 3,SAS Flash,,393216000000 (366.3G)'].join('\n'),
  });
  const d = snap.extra.disks;
  assert.equal(d.count, 4);
  assert.equal(d.unhealthy, 1);
  assert.equal(d.unknown, 1, '상태를 읽지 못한 드라이브는 따로 센다(정상이라는 뜻이 아니다)');
  // ⚠ v2.526 정정: 그룹 키가 `byType`(Drive type) → **`byTier`**(Tier)로 바뀌었다.
  //   실장비 `/env/disk show` 에는 `Drive type` 이 없고 `Tier`(예: Extreme Performance)만 있다.
  //   이 픽스처의 `Drive type` 은 `Tier` 의 후보로 여전히 읽힌다(버전차 폴백).
  assert.equal(d.byTier.length, 2);
  assert.equal(d.byTier[0].tier, 'SAS');
  assert.equal(d.byTier[0].count, 2);
  assert.ok(d.rawBytes > 0);
});

test('구성: 하드웨어·포트·프로비저닝·라이선스를 읽는다', () => {
  const snap = normalizeUnitySsh(DEV, {
    dae: 'ID,Name,Model,Health state\ndae_0_1,DAE 0 1,DAE25,OK (5)\n',
    psu: 'ID,Name,Health state\npsa,PSA,OK (5)\npsb,PSB,OK (5)\n',
    fcPorts: 'ID,Name,Health state,Speed,WWN\nspa_fc4,SPA FC4,OK (5),16 Gbps,50:06:01:60:00:00:00:00\n',
    ethPorts: 'ID,Name,Health state,Speed,MTU\nspa_eth2,SPA ETH2,OK (5),10 Gbps,1500\n',
    luns: 'ID,Name,Size,Pool,Health state\nsv_1,LUN-A,1099511627776 (1.0T),Pool 0,OK (5)\nsv_2,LUN-B,2199023255552 (2.0T),Pool 0,OK (5)\n',
    filesystems: 'ID,Name,Size total,Size used,Health state\nfs_1,FS-A,1099511627776 (1.0T),549755813888 (512.0G),OK (5)\n',
    nasServers: 'ID,Name,Health state,SP\nnas_1,NAS-A,OK (5),SPA\n',
    hosts: 'ID,Name,Type,Address\nHost_1,esxi-01,VMware ESXi,10.0.0.10\n',
    snaps: 'ID,Name,Creation time\n171_1,snap-1,2026-09-01\n',
    license: 'ID,Name,Installed,Expires\nFAST_VP,FAST VP,yes,2027-01-01\nTHIN,Thin Provisioning,no,\n',
  });
  assert.equal(snap.extra.hardware.dae.count, 1);
  assert.equal(snap.extra.hardware.psu.count, 2);
  assert.equal(snap.extra.ports.fc.count, 1);
  assert.equal(snap.extra.ports.fc.list[0].wwn, '50:06:01:60:00:00:00:00');
  assert.equal(snap.extra.ports.eth.count, 1);
  assert.equal(snap.extra.provisioning.luns.count, 2);
  assert.equal(snap.extra.provisioning.luns.totalBytes, 1099511627776 + 2199023255552);
  assert.equal(snap.extra.provisioning.luns.top[0].name, 'LUN-B', '큰 것부터 보여준다');
  assert.equal(snap.extra.provisioning.filesystems.count, 1);
  assert.equal(snap.extra.provisioning.nasServers.count, 1);
  assert.equal(snap.extra.provisioning.hosts.count, 1);
  assert.equal(snap.extra.provisioning.snapshots.count, 1);
  assert.equal(snap.extra.licenses.count, 2);
  assert.equal(snap.extra.licenses.list[0].installed, true);
  assert.equal(snap.extra.licenses.list[1].installed, false);
});

test('구성: 설치 여부를 읽지 못하면 false 가 아니라 null 이다', () => {
  const snap = normalizeUnitySsh(DEV, { license: 'ID,Name,Expires\nFAST_VP,FAST VP,2027-01-01\n' });
  assert.equal(snap.extra.licenses.list[0].installed, null,
    "'모른다' 를 '미설치' 로 적으면 라이선스가 없다는 거짓이 된다");
});

test('구성: 명령이 안 돈 항목은 extra 에 아예 만들지 않는다(0 을 지어내지 않는다)', () => {
  const snap = normalizeUnitySsh(DEV, { system: 'ID,Name\nA,B\n' });
  assert.equal(snap.extra.disks, undefined);
  assert.equal(snap.extra.hardware, undefined);
  assert.equal(snap.extra.ports, undefined);
  assert.equal(snap.extra.provisioning, undefined);
  assert.equal(snap.extra.licenses, undefined);
});

/* ─── 경보 ────────────────────────────────────────────────────────────────── */

test('경보: 목록은 extra 에 두고(공용 스냅샷 계약 보존) 0건은 사유를 밝힌다', () => {
  const withAlerts = normalizeUnitySsh(DEV, { alerts: 'ID,Severity,Message,Time\n1,critical,Disk failed,2026-09-16\n' });
  assert.equal(withAlerts.alerts.unresolved, 1);
  assert.equal(withAlerts.extra.alertsList[0].severity, 'critical');
  assert.equal(withAlerts.alerts.list, undefined, 'types.js 의 공용 계약(alerts:{unresolved})을 바꾸지 않는다');
  const none = normalizeUnitySsh(DEV, { alerts: '' });
  assert.equal(none.alerts.unresolved, 0);
  assert.match(none.extra.alertsNote, /인식하지 못했습니다/, "'0건' 과 '형식 미인식' 을 구분할 수 있게 말한다");
});

/* ─── 명세·근거 ───────────────────────────────────────────────────────────── */

test('명세: 모든 항목이 후보 체인이고 구성 항목은 긴 주기로 뺄 수 있다', () => {
  const all = specsFor({ deep: true, configRound: true });
  // ⚠ v2.526 정정: 주기 축이 `deep` 하나에서 **`when`(always|config)** 으로 바뀌었다
  //   (사용자 선택 "구성은 드물게 · 전력은 매번"). `configRound:false` 는 매 주기 항목만 남긴다.
  const always = specsFor({ deep: true, configRound: false });
  assert.ok(all.length > always.length, '긴 주기(구성) 항목이 있어야 한다');
  assert.ok(always.length >= 5, '매 주기 항목만으로 용량·상태·전력 화면이 채워져야 한다');
  assert.ok(always.every((s) => s.when === 'always'));
  for (const s of all) {
    assert.ok(Array.isArray(s.cmds) && s.cmds.length >= 1, `${s.key}: cmds 는 후보 배열이다`);
    // uemcli 는 인증서 프롬프트에서 멈추므로 **전부 자동 응답 모드**여야 한다(v2.526 실측).
    assert.equal(s.answered, true, `${s.key}: answered 가 없으면 인증서 프롬프트에서 멈춘다`);
  }
  // 전력·FRU 는 uemcli 가 아니라 svc_diag 가 준다(Unisphere 계정이 필요 없는 유일한 경로).
  const spinfo = all.find((s) => s.key === 'spinfo');
  assert.ok(spinfo && spinfo.cmds[0].startsWith('svc_diag '), 'svc_diag spinfo 가 매 주기 항목이어야 한다');
  assert.equal(spinfo.when, 'always');
  assert.ok(spinfo.rules.includes('pager'), 'spinfo 는 --More-- 로 멈추므로 페이저 응답이 필요하다');
  assert.ok(all.filter((s) => s.key !== 'spinfo').every((s) => s.cmds.every((c) => c.startsWith('uemcli '))));
  assert.equal(all.filter((s) => s.required).length, 1, '필수 항목은 시스템 조회 하나뿐이어야 한다');
  // 용량 항목은 `-detail` 우선 + 기본 폴백(버전차) — `-detail` 이 Current allocation·Subscription 을 준다
  const pools = all.find((s) => s.key === 'pools');
  assert.ok(pools.cmds[0].includes('-detail') && pools.cmds.some((c) => !c.includes('-detail')));
});

test('근거: 무엇으로 읽었는지·deep 을 껐는지 스냅샷에 남는다', () => {
  const snap = normalizeUnitySsh(DEV, { system: 'ID,Name\nA,B\n' },
    { usedCmds: { system: 'uemcli /sys/general show' }, deep: false });
  assert.equal(snap.extra.usedCmds.system, 'uemcli /sys/general show');
  assert.equal(snap.extra.deepSkipped, true, '조용히 덜 수집하면 구성 정보가 없는 장비로 오해된다');
});

test('주기 수집은 실패한 명령의 원문만 남긴다(대역폭)', () => {
  assert.match(read('storage/collectors/unitySsh.js'), /device\._test === true \? raw : raw\.filter\(\(x\) => !x\.ok\)/);
  assert.match(read('storage/poller.js'), /_test: true/, '연결 테스트는 전 명령의 원문을 담아야 진단이 된다');
});
