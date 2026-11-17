import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다(늦게 flush 되는 기록기와의 경합 — exit 에서 한 번 더) */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

process.env.CONFIG_DIR = tmpDir('deploytgt-');

let reg;
before(async () => { reg = await import('../src/agent/deployRegistry.js'); });

test('saveTarget/listTargets: gpuGuest 보존 + 비밀번호 redact(값 대신 has* 플래그)', () => {
  const s = reg.saveTarget({ host: '10.0.0.9', agentName: 'NJ', collectorDatacenter: 'NJ',
    gpuGuest: { enabled: true, vcenterId: 'vc-nj', vcenterHost: '192.168.52.200', vcenterUser: 'administrator@vsphere.local', vcenterPass: 'secret1', guestUser: 'root', guestPass: 'secret2' } });
  assert.equal(s.ok, true);
  const t = reg.listTargets().find((x) => x.agentName === 'NJ');
  assert.equal(t.gpuGuest.enabled, true);
  assert.equal(t.gpuGuest.vcenterId, 'vc-nj');
  assert.equal(t.gpuGuest.vcenterHost, '192.168.52.200');
  assert.equal(t.gpuGuest.guestUser, 'root');
  assert.equal(t.gpuGuest.vcenterPass, '', '비밀번호는 응답에 노출 안 됨');
  assert.equal(t.gpuGuest.hasVcenterPass, true, '저장 여부는 플래그로');
  assert.equal(t.gpuGuest.hasGuestPass, true);
});

test('saveTarget: 편집 시 빈 비밀번호 재전송해도 기존 gpuGuest 비밀번호 보존', () => {
  const t = reg.listTargets().find((x) => x.agentName === 'NJ');
  reg.saveTarget({ id: t.id, host: '10.0.0.9', agentName: 'NJ',
    gpuGuest: { enabled: true, vcenterId: 'vc-nj', vcenterHost: '192.168.52.200', vcenterUser: 'administrator@vsphere.local', vcenterPass: '', guestUser: 'root', guestPass: '' } });
  const raw = reg.getTargetRaw(t.id);
  assert.equal(raw.gpuGuest.vcenterPass, 'secret1', '빈 값 재전송 시 기존 비번 유지');
  assert.equal(raw.gpuGuest.guestPass, 'secret2');
});

test('findTargetByHost: host+port+username 매칭(배포 upsert 중복 방지)', () => {
  const t = reg.listTargets().find((x) => x.agentName === 'NJ');
  const found = reg.findTargetByHost('10.0.0.9', 22, undefined);
  assert.ok(found, '같은 호스트 대상 발견');
  assert.equal(found.id, t.id);
  assert.equal(reg.findTargetByHost('10.9.9.9', 22, undefined), null, '없는 호스트는 null');
});

test('배포 upsert 시나리오: id 없이 같은 호스트 저장은 중복 없이 기존 대상 갱신', () => {
  const before = reg.listTargets().filter((x) => x.host === '10.0.0.9').length;
  const id = reg.findTargetByHost('10.0.0.9', 22, undefined)?.id;
  reg.saveTarget({ id, host: '10.0.0.9', agentName: 'NJ',
    gpuGuest: { enabled: true, vcenterId: 'vc-nj-2', vcenterHost: '192.168.52.201', vcenterUser: 'admin', guestUser: 'root' } });
  const after = reg.listTargets().filter((x) => x.host === '10.0.0.9');
  assert.equal(after.length, before, '중복 생성 없음(1개 유지)');
  assert.equal(after[0].gpuGuest.vcenterId, 'vc-nj-2', '기존 대상이 갱신됨');
});
