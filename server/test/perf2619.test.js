// v2.619 PERF-1 — IP 원장(ipam.db) 동기화의 '입력 지문' 생략.
// 운영 규모(vCenter 33·VM 6,004·원장 8,047행)에서 원장 재구성 + 행 서명이 30초마다 약 48ms(p50) 이벤트 루프를 막았다.
// 입력 지문(약 6ms)이 직전 성공과 같으면 그 둘을 건너뛴다. 핵심 계약: **원장 서명을 바꾸는 입력은 반드시 입력 지문도 바꾼다**
// — 이것이 깨지면 ipam.db 가 조용히 낡는다(외부 리더가 읽는 공유 파일). 아래 ②가 스냅샷의 **모든 필드**를 하나씩 바꿔 그 계약을 본다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perf2619-'));
process.env.CONFIG_DIR = tmp;

let st, ledger, ov, rp;
before(async () => {
  st = await import('../src/store.js');
  ledger = await import('../src/ipam/ledger.js');
  ov = await import('../src/ipam/overrides.js');
  rp = await import('../src/ipam/rangePolicies.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

let gen = 0;
const snap0 = () => ({
  generatedAt: `g${++gen}`,
  vcenters: [{ id: 'vc1', name: 'SEOUL' }, { id: 'vc2', name: 'TOKYO' }],
  vms: [
    { id: 'vm-1', name: 'web01', vcenterId: 'vc1', ipAddresses: ['10.1.0.10', '10.1.0.11'], ipAddress: '10.1.0.10', powerState: 'POWERED_ON', guestOS: 'CentOS 7 (64-bit)', host: 'esx01', cluster: 'C1', cpu: 4, memoryMB: 8192, uptime: 100 },
    { id: 'vm-2', name: 'db01', vcenterId: 'vc2', ipAddresses: [], ipAddress: '10.2.0.20', powerState: 'POWERED_OFF', guestOS: 'Windows Server 2019', host: 'esx02', cluster: 'C2', cpu: 8, memoryMB: 16384, uptime: 5 },
    { id: 'vm-3', name: 'dup', vcenterId: 'vc2', ipAddresses: ['10.1.0.10'], ipAddress: '10.1.0.10', powerState: 'POWERED_ON', guestOS: 'Ubuntu 22.04', host: 'esx02', cluster: 'C2', cpu: 2, memoryMB: 2048, uptime: 9 },
  ],
  hosts: [
    { id: 'h-1', name: '10.1.0.2', vcenterId: 'vc1', powerState: 'POWERED_ON', version: '8.0.2', cluster: 'C1', serviceTag: 'ABC', powerWattsIdrac: 300 },
    { id: 'h-2', name: 'esx02.example', vcenterId: 'vc2', powerState: 'POWERED_ON', version: '7.0.3', cluster: 'C2' },
  ],
  datastores: [], networks: [], alarms: [],
});
const rowSig = (s) => st.ledgerSignature(ledger.buildIpamRows(s).rows);

test('① 같은 입력이면 generatedAt 이 달라도 입력 지문이 같다', () => {
  assert.equal(st.ledgerInputSignature(snap0()), st.ledgerInputSignature(snap0()));
});

test('② 스냅샷의 어떤 필드를 바꾸든 원장 서명이 바뀌면 입력 지문도 바뀐다(전 필드 변이)', () => {
  const variants = (v) => (Array.isArray(v) ? [[...v, '10.9.9.9'], [], v.slice(0, 1)] : typeof v === 'number' ? [v + 1] : v == null ? ['x'] : [`${v}-x`, '', '10.3.3.3']);
  let checked = 0; let rowChanges = 0;
  for (const kind of ['vms', 'hosts', 'vcenters']) {
    const base = snap0();
    for (let i = 0; i < base[kind].length; i++) {
      for (const key of Object.keys(base[kind][i])) {
        for (const nv of variants(base[kind][i][key])) {
          const a = snap0(); const b = snap0();
          b[kind][i][key] = nv;
          const rowDiff = rowSig(a) !== rowSig(b);
          const inDiff = st.ledgerInputSignature(a) !== st.ledgerInputSignature(b);
          if (rowDiff) { rowChanges++; assert.ok(inDiff, `${kind}[${i}].${key}=${JSON.stringify(nv)} 가 원장 서명은 바꾸는데 입력 지문은 그대로다`); }
          checked++;
        }
      }
    }
  }
  assert.ok(rowChanges > 20, `원장 서명이 바뀐 경우가 너무 적다(${rowChanges}/${checked}) — 변이가 효력이 없다`);
});

test('③ 원장과 무관한 필드(cpu·메모리·iDRAC 전력)는 입력 지문을 바꾸지 않는다 — 생략이 실제로 일어난다', () => {
  const a = snap0(); const b = snap0();
  b.vms[0].cpu = 64; b.vms[0].memoryMB = 1; b.vms[0].uptime = 999; b.hosts[0].powerWattsIdrac = 1;
  assert.equal(st.ledgerInputSignature(a), st.ledgerInputSignature(b));
});

test('④ 관리 입력(override·대역 정책) 변경은 리비전으로 입력 지문을 바꾼다', () => {
  const s = snap0();
  const before = st.ledgerInputSignature(s);
  ov.setOverride('10.1.0.10', { owner: '담당' }, { username: 't' });
  const afterOv = st.ledgerInputSignature(s);
  assert.notEqual(before, afterOv);
  const p = rp.setPolicy({ spec: '10.2.0.0/24', status: 'dhcp' }, { username: 't' });
  assert.notEqual(afterOv, st.ledgerInputSignature(s));
  rp.deletePolicy(p.policy.id);
});

test('⑤ Store.syncLedger — 성공한 입력과 같으면 건너뛰고, 입력이 바뀌면 다시 만든다', async () => {
  const S = st.store;
  S.snapshot = snap0();
  const wait = async () => { for (let i = 0; i < 100 && !(S.ledgerSync && S.ledgerSync.at >= t0); i++) await new Promise((r) => setTimeout(r, 20)); };
  let t0 = Date.now();
  S.syncLedger(); await wait();
  assert.equal(S.ledgerSync?.ok, true, `첫 동기화 실패: ${JSON.stringify(S.ledgerSync)}`);
  const seq1 = S._ledgerSeq; const skips1 = S.ledgerInputSkips || 0;
  S.snapshot = snap0(); // 같은 내용 · 새 generatedAt
  S.syncLedger();
  assert.equal(S._ledgerSeq, seq1, '입력이 같은데 원장을 다시 만들었다');
  assert.equal(S.ledgerInputSkips, skips1 + 1);
  const s2 = snap0(); s2.vms[0].powerState = 'POWERED_OFF';
  S.snapshot = s2; t0 = Date.now();
  S.syncLedger(); await wait();
  assert.equal(S._ledgerSeq, seq1 + 1, '입력이 바뀌었는데 원장을 다시 만들지 않았다');
});

test('⑥ 쓰기 실패한 입력은 기억하지 않는다(다음 틱이 재시도) · 늦게 끝난 옛 쓰기는 새 기억을 덮지 않는다 — 소스 고정', () => {
  const src = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('  syncLedger() {'), src.indexOf('  _noteLedger('));
  assert.match(body, /if \(ok\) \{\s*if \(seq === this\._ledgerSeq\) \{ this\._lastLedgerSig = sig; this\._lastLedgerInputSig = inSig; \}/);
  assert.equal((body.match(/_lastLedgerInputSig = inSig/g) || []).length, 2, '입력 지문 기억은 성공 콜백과 서명 동일(이미 반영됨) 두 곳뿐이어야 한다');
  assert.match(body, /LEDGER_FULL_CHECK_MS/, '안전망(주기적 전량 확인)이 빠졌다');
});

test('⑦ v2.620(RECENT2620-01) — 쓰기 진행 중에 내용이 되돌아가도 DB 가 옛 내용으로 굳지 않는다(ABA)', async () => {
  const S = st.store;
  const base = snap0();
  S.snapshot = base;
  S._ledgerFullAt = 0; // 전량 확인을 강제해 기준선을 A 로 맞춘다
  S.syncLedger();
  for (let i = 0; i < 100 && S._lastLedgerSig == null; i++) await new Promise((r) => setTimeout(r, 20));
  const sigA = rowSig(base);
  assert.equal(S._lastLedgerSig, sigA, '기준선 A 가 기록되지 않았다');
  // B: 관리 입력(override)으로 원장 내용을 바꾼 뒤 쓰기를 내보낸다(아직 끝나지 않았다).
  ov.setOverride('10.2.0.20', { owner: 'ABA-담당' }, { username: 't' });
  S.syncLedger();
  // 곧바로 A 로 되돌린다 — 예전에는 여기서 'sig === 옛 A' 로 생략되고 B 가 DB 에 남았다.
  ov.clearOverride('10.2.0.20');
  S.syncLedger();
  const seqNow = S._ledgerSeq;
  for (let i = 0; i < 200 && S._lastLedgerSig == null; i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(S._ledgerSeq, seqNow);
  assert.equal(rowSig(S.snapshot), sigA, 'override 해제 뒤 원장 내용이 A 로 돌아오지 않았다(테스트 전제)');
  assert.equal(S._lastLedgerSig, sigA, '마지막으로 쓴 내용(A)이 아니라 중간 내용(B)이 기억됐다 — ipam.db 가 B 로 굳는다');
});
