/**
 * test/bareosVcHost2851_1.test.js — v2.851.1 FD 가 접속할 vCenter 주소(vcserver)를 등록부에서 읽는다
 *   (2026-11-02 사용자 화면 — 완전 설치 마무리 '사이트 매핑의 vcserver 주소가 올바르지 않습니다').
 *  ① vcHostOf — 스킴 · 포트 · 경로 제거 · 못 알아보면 ''
 *  ② registryHosts — vcenters.json(등록부)에서 · 파일이 없으면 빈 Map
 *  ③ buildTargets — 스냅샷 vCenter 항목에 host 가 없어도 등록부 주소 · 등록부에 없으면 스냅샷 값(있을 때만)
 *  ④ 설정 화면 매핑 미리 채우기(bareosBackup.js)도 같은 출처 · 마무리의 빈 vcserver 는 고칠 곳을 말한다
 *  ⑤ 수집 스냅샷의 vCenter 항목에는 host 가 없다(이 결함의 원인 — 바뀌면 이 시험이 먼저 알린다)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vchost2851-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
const H = await import('../src/bareos/vcHost.js');
const { buildTargets } = await import('../src/bareos/install/targets.js');
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('① vcHostOf', () => {
  assert.equal(H.vcHostOf('https://vc-oc2.corp:443/sdk'), 'vc-oc2.corp');
  assert.equal(H.vcHostOf('http://10.94.40.10'), '10.94.40.10');
  assert.equal(H.vcHostOf(' vc.corp '), 'vc.corp');
  for (const bad of ['', null, 'https://', 'https://user@vc.corp', 'https://[::1]:443', 'https://vc corp']) assert.equal(H.vcHostOf(bad), '', String(bad));
});

test('② registryHosts — 등록부에서 · 없으면 빈 Map', () => {
  assert.equal(H.registryHosts().size, 0);
  fs.writeFileSync(path.join(tmp, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vc-oc2', host: 'https://vc-oc2.corp/sdk' }, { id: 'vc-x', host: 'https://' }] }));
  const m = H.registryHosts();
  assert.equal(m.get('vc-oc2'), 'vc-oc2.corp'); assert.equal(m.has('vc-x'), false, '알아볼 수 없는 주소는 넣지 않는다(빈 값 저장 금지)');
});

test('③ buildTargets — 스냅샷에 host 가 없어도 등록부 주소', () => {
  const base = { inventory: [], deployTargets: [], settings: { directors: [], sites: [] } };
  const snapVc = [{ id: 'vc-oc2', name: 'OC2', status: 'connected' }];   // 수집 스냅샷 모양 — host 없음
  assert.equal(buildTargets({ ...base, vcenters: snapVc })[0].vcHost, '', '예전 출처(스냅샷)만으로는 늘 비었다');
  assert.equal(buildTargets({ ...base, vcenters: snapVc, vcHosts: new Map([['vc-oc2', 'vc-oc2.corp']]) })[0].vcHost, 'vc-oc2.corp');
  assert.equal(buildTargets({ ...base, vcenters: [{ id: 'd', host: 'https://demo-vc/sdk' }] })[0].vcHost, 'demo-vc', '등록부에 없으면 스냅샷 값(데모)');
  assert.match(src('../src/bareos/install/targets.js'), /vcHosts: registryHosts\(\)/, '라우트용 목록은 등록부 주소를 넘긴다');
});

test('④ 설정 화면 미리 채우기도 등록부 · 마무리의 빈 vcserver 는 고칠 곳을 말한다', () => {
  assert.match(src('../src/routes/api/bareosBackup.js'), /host: hosts\.get\(String\(v\.id\)\) \|\| vcHostOf\(v\.host\)/);
  const a = src('../src/bareos/autoSetup.js');
  assert.match(a, /if \(!site\.vcserver\) throw fail\('invalid', '이 vCenter 매핑의 vcserver\(FD 가 접속할 vCenter 주소\)가 비어 있습니다/);
  assert.ok(a.indexOf("if (!site.vcserver)") < a.indexOf("if (!HOST_RE.test(site.vcserver))"));
});

test('⑤ 수집 스냅샷의 vCenter 항목에는 host 가 없다(원인 고정 — 수집기가 host 를 싣게 바뀌면 출처를 다시 볼 것)', () => {
  for (const f of ['../src/vcenter/soapClient.js', '../src/vcenter/restClient.js']) {
    const s = src(f);
    const i = s.indexOf('vcenter: {'); assert.ok(i > 0, f);
    const block = s.slice(i, s.indexOf('}', i));
    assert.ok(!/\bhost\b/.test(block), `${f} 의 vcenter 항목에 host 가 없다`);
  }
});
