// 베어메탈 스토리지 폴링 위임(v2.341) 단위테스트 — 잡 큐 claim→ack/reap(시간 주입) + 서버 CSV.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueueBmstorJob, takeBmstorJobs, ackBmstorJob, bmstorAgentOfReq, reapBmstorClaims, setBmstorExpireHandler } from '../src/bmstor/jobs.js';
import { bmServersToCsv, sampleCsv, parseBmServersCsv, analyzeBmServersImport } from '../src/bmstor/csv.js';

const SRV = [{ id: 's1', host: '10.0.0.1', port: 22, username: 'root', password: 'pw', mounts: ['/'] }];

test('잡 큐: enqueue→claim(소유 에이전트만)→ack, 늦은/중복 ack 는 무해', () => {
  const reqId = enqueueBmstorJob('WA-Edge', SRV);
  assert.equal(bmstorAgentOfReq(reqId), 'WA-Edge');
  assert.deepEqual(takeBmstorJobs('other-edge'), [], '남의 잡은 인출 불가');
  const jobs = takeBmstorJobs('wa-edge'); // 대소문자 무시
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].reqId, reqId);
  assert.deepEqual(takeBmstorJobs('WA-Edge'), [], '이미 claim 된 잡은 재인출 안 됨');
  const ackd = ackBmstorJob(reqId);
  assert.deepEqual(ackd, { agent: 'WA-Edge', serverIds: ['s1'] });
  assert.equal(ackBmstorJob(reqId), null, '중복 ack 는 null(무시)');
});

test('잡 큐: 기한 만료 reap — 1회 재인출 복귀, 한도 소진 시 onExpire 로 실패 확정', () => {
  const fails = [];
  setBmstorExpireHandler((agent, ids, reason) => fails.push({ agent, ids, reason }));
  const reqId = enqueueBmstorJob('GM1', SRV);
  const t0 = Date.now();
  assert.equal(takeBmstorJobs('GM1', t0).length, 1);           // claim #1
  const past = t0 + 11 * 60_000;                                // 기한(60s+20s) 훨씬 뒤
  assert.equal(reapBmstorClaims(past).requeued, 1, '재시도 남음 → pending 복귀');
  assert.equal(takeBmstorJobs('GM1', past).length, 1);          // claim #2(한도)
  const r2 = reapBmstorClaims(past + 11 * 60_000);
  assert.equal(r2.failed, 1, '한도 소진 → 실패 확정');
  assert.equal(fails.length, 1);
  assert.deepEqual(fails[0].ids, ['s1']);
  assert.match(fails[0].reason, /회신하지 않았습니다/);
  assert.equal(bmstorAgentOfReq(reqId), 'GM1', '실패 잡도 TTL 전까지 조회 가능');
  setBmstorExpireHandler(null);
});

test('CSV: 비밀번호 기본 제외·마운트 ; 직렬화, 샘플 왕복', () => {
  const csv = bmServersToCsv([{ name: 'a', host: 'h1', port: 22, username: 'root', group: 'G', agent: 'WA', dispatch: 'push', mounts: ['/', '/data'], enabled: true, password: 'sec' }]);
  assert.ok(csv.includes('/; /data') && !csv.includes('sec'));
  assert.ok(bmServersToCsv([{ host: 'h1', mounts: [], password: 'sec' }], { includeSecrets: true }).includes('sec'));
  const s = parseBmServersCsv(sampleCsv());
  assert.equal(s.error, undefined);
  assert.deepEqual(s.rows.map((r) => r.host), ['10.20.0.31', '10.10.0.44']);
  assert.deepEqual(s.rows[0].mounts, ['/', '/data']);
  assert.ok(parseBmServersCsv('name,port\nx,22').error, 'host/mounts 헤더 없으면 오류');
});

test('CSV 드라이런: 저장 규칙 위반·미등록 엣지·덮어쓰기·파일 내 중복 판정', () => {
  const { rows } = parseBmServersCsv(['host,port,username,agent,mounts',
    '10.0.0.1,22,root,WA-Edge,/; /data',   // 기존 → overwrite
    '10.0.0.2,22,root,,/',                 // 신규(중앙 직접) → add
    '10.0.0.3,22,root,nope-edge,/',        // 미등록 엣지 → error(사용자 요구: 선택 목록만 허용)
    '10.0.0.4,22,root,,bad mount',         // 마운트 문법 → error(validate)
    '10.0.0.1,22,ROOT,,/'].join('\n'));    // 대소문자 무시 중복 → error
  const { report, summary } = analyzeBmServersImport(rows, {
    existingId: (h) => (h === '10.0.0.1' ? 'id-1' : undefined),
    validate: (b) => ((b.mounts || []).every((m) => m.startsWith('/')) ? null : '마운트 경로 오류'),
    validAgent: (a) => a === 'WA-Edge',
  });
  assert.deepEqual(summary, { add: 1, overwrite: 1, error: 3, withPassword: 0 });
  assert.match(report[2].reason, /미등록 엣지/);
  assert.match(report[3].reason, /마운트 경로 오류/);
  assert.match(report[4].reason, /파일 내 중복/);
});
