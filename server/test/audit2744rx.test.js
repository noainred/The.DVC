/**
 * v2.744(회귀 검토 RX) — 후속 수정(FB-2·FC) 적대적 검토 FX-R1 회귀.
 *
 * FX-R1 /24 대역 제안(ipam/scanDatacenter.js suggestAgentSubnets): 원장 판정(ipam/ledger.js hostLedgerIp)을 주입받으면
 *   FQDN 호스트를 관리 IP 로 센다. 그런데 관리 IP 를 **받았지만** 쓰지 않은 호스트(비정규 표기 '010.5.6.9' · 미설정 표기 '0.0.0.0')도
 *   '관리 IP 가 없는' 호스트와 같은 칸(skipped.hostsNoIp)으로 세고 화면은 '관리 IP 도 수집되지 않아 뺐습니다' 라고 말했다 —
 *   사용자는 수집(vCenter 계정·vmk 설정)을 의심하게 된다. 서버가 그 부분집합을 totals.hostMgmtRejected 로 따로 세고, 화면이 두 경우를
 *   각각 말한다. 판정은 hostLedgerIp 하나다 — '있지만 못 쓰는' 것 = mgmtIp 원값이 비어 있지 않은데 hostLedgerIp 가 null.
 *   skipped 의 모양({hostsNoIp, idracNoIp})은 그대로 둔다(뺀 호스트 전체 — 기존 소비자·테스트 계약).
 *   구버전 응답(새 필드 없음)은 '관리 IP 가 없거나 쓸 수 없는 표기라 뺐습니다' 로 좁힌다(둘을 가를 수 없다).
 *
 * 실제 함수(suggestAgentSubnets · hostLedgerIp · 웹 suggestSummaryText)를 부른다. 시각에 기대는 단언은 없다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ledger.js 는 설정 모듈을 끌어온다 — 저장소 안에 파일을 만들지 않게 임시 CONFIG_DIR.
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2744rx-'));
Object.assign(process.env, { CONFIG_DIR: CFG, DATA_SOURCE: 'mock', IPAM_WRITE_WORKER: '0' });
test.after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* */ } });

const { suggestAgentSubnets } = await import('../src/ipam/scanDatacenter.js');
const { hostLedgerIp } = await import('../src/ipam/ledger.js');
const w = await import(pathToFileURL(path.resolve(HERE, '../../web/src/views/tools/ipScanDcText.js')).href);

const HOSTS = [
  { vcenterId: 'vc-a', name: 'esx01.corp.local', mgmtIp: '10.5.6.7' },    // 관리 IP 로 센다
  { vcenterId: 'vc-a', name: '10.5.6.8' },                                // 이름이 IP — 예전 그대로
  { vcenterId: 'vc-a', name: 'esx02.corp.local' },                        // 관리 IP 없음
  { vcenterId: 'vc-a', name: 'esx03.corp.local', mgmtIp: '' },            // 빈 문자열 = 없음
  { vcenterId: 'vc-a', name: 'esx04.corp.local', mgmtIp: '010.5.6.9' },   // 받았지만 비정규 표기 — 원장도 쓰지 않는다
  { vcenterId: 'vc-a', name: 'esx05.corp.local', mgmtIp: '0.0.0.0' },     // 받았지만 미설정 표기
  { vcenterId: 'vc-other', name: 'esx09.corp.local', mgmtIp: '010.9.9.9' }, // 대상 밖 vCenter — 세지 않는다
];

test('FX-R1 ① 관리 IP 를 받았지만 쓸 수 없는 호스트를 totals.hostMgmtRejected 로 따로 센다(skipped 모양은 그대로)', () => {
  const r = suggestAgentSubnets({ vcenterIds: ['vc-a'], vms: [], hosts: HOSTS, idrac: [], hostIp: hostLedgerIp });
  assert.deepEqual(r.skipped, { hostsNoIp: 4, idracNoIp: 0 }, '뺀 호스트 전체(없음 2 + 못 씀 2) — 기존 계약');
  assert.equal(r.totals.hostMgmtRejected, 2, JSON.stringify(r.totals));
  assert.equal(r.totals.hostIps, 2);
  assert.equal(r.totals.hostMgmtIps, 1);
  // 판정은 원장 함수 하나 — 못 쓴다고 센 호스트는 정확히 'mgmtIp 원값 있음 + hostLedgerIp null' 이다.
  const rejected = HOSTS.filter((h) => h.vcenterId === 'vc-a' && String(h.mgmtIp ?? '').trim() && hostLedgerIp(h) == null);
  assert.equal(rejected.length, r.totals.hostMgmtRejected);
});

test('FX-R1 ② 원장 판정을 주지 않으면(예전 규칙) 관리 IP 를 보지 않으므로 못 씀 개수는 0 이다 · 판정이 던진 호스트는 못 씀으로 세지 않는다', () => {
  const r = suggestAgentSubnets({ vcenterIds: ['vc-a'], hosts: HOSTS });
  assert.equal(r.hostIpRule, 'name-only');
  assert.equal(r.totals.hostMgmtRejected, 0);
  const r2 = suggestAgentSubnets({ vcenterIds: ['vc-a'], hosts: [{ vcenterId: 'vc-a', name: 'x', mgmtIp: '10.1.1.1' }], hostIp: () => { throw new Error('bad'); } });
  assert.equal(r2.skipped.hostsNoIp, 1);
  assert.equal(r2.totals.hostMgmtRejected, 0, '표기 판정을 하지 못했다 — 표기 탓이라 말하지 않는다');
});

test('FX-R1 ③ 화면 문구 — 관리 IP 없음과 쓸 수 없는 표기를 각각 사실대로 말한다 · 구버전 응답은 둘을 함께 말한다', () => {
  const r = suggestAgentSubnets({ vcenterIds: ['vc-a'], vms: [], hosts: HOSTS, idrac: [], hostIp: hostLedgerIp });
  const s = w.suggestSummaryText(r);
  assert.match(s, /이름으로 등록된 ESXi 호스트 2대는 관리 IP 도 수집되지 않아 뺐습니다/);
  assert.match(s, /이름으로 등록된 ESXi 호스트 2대는 관리 IP 가 쓸 수 없는 표기\(비정규 표기·0\.0\.0\.0 등\)라 뺐습니다/);
  // 검토 시나리오 그대로: 두 호스트 모두 받았지만 못 씀 → '수집되지 않아' 라고 말하지 않는다.
  const only = suggestAgentSubnets({ vcenterIds: ['vc-a'], vms: [], hosts: HOSTS.slice(4, 6), idrac: [], hostIp: hostLedgerIp });
  const so = w.suggestSummaryText(only);
  assert.doesNotMatch(so, /수집되지 않아/);
  assert.match(so, /2대는 관리 IP 가 쓸 수 없는 표기/);
  // 구버전 응답(규칙은 있는데 새 필드 없음) — 둘을 가를 수 없으므로 함께 말한다.
  const mid = w.suggestSummaryText({ totals: { subnets: 0, vmIps: 0, hostIps: 0, hostMgmtIps: 0, idracIps: 0 }, skipped: { hostsNoIp: 3 }, hostIpRule: 'name-or-mgmt', omitted: 0, subnets: [] });
  assert.match(mid, /3대는 관리 IP 가 없거나 쓸 수 없는 표기라 뺐습니다/);
  assert.doesNotMatch(mid, /수집되지 않아/);
  // 규칙 없는 옛 응답 — 예전 문구 그대로.
  const old = w.suggestSummaryText({ totals: { subnets: 1, vmIps: 0, hostIps: 1, idracIps: 0 }, skipped: { hostsNoIp: 1 }, omitted: 0, subnets: [] });
  assert.match(old, /1대는 주소를 몰라 뺐습니다/);
  assert.doesNotMatch(old, /관리 IP/);
  // 이상한 값(음수·뺀 수보다 큼·문자열)으로 음수·과다를 말하지 않는다.
  const odd = w.suggestSummaryText({ totals: { hostMgmtRejected: 9 }, skipped: { hostsNoIp: 2 }, hostIpRule: 'name-or-mgmt', subnets: [] });
  assert.match(odd, /2대는 관리 IP 가 쓸 수 없는 표기/);
  assert.doesNotMatch(odd, /수집되지 않아|-\d+대/);
  for (const t of [s, so, mid, old, odd]) { assert.doesNotMatch(t, /`/); assert.doesNotMatch(t, /\*\*/); }
});
