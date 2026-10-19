// v2.744 최종 검토 — 리드 통합분. 그룹 FC 가 넘긴 '리드가 할 일' 과 같은 꼴(로드 오류 원문을 메모리·응답에 남김) 3곳:
//   ① central/partFaultEdge.js sanitizeRegistryUnreadable — 엣지가 보낸 분류 코드를 버리고 사유 글자를 200자로 자르기만 해, 원문
//      (JSON.parse 오류 = 등록부 조각)을 보낸 엣지의 사유가 중앙 메모리·관리자 응답에 그대로 남았다.
//   ② xferspeed/settings.js — 설정 파싱 실패 사유를 String(e.message) 로 상주시켜 상태·서비스 점검에 실었다.
//   ③ util/scanJournal.js — 실행 중 스캔 기록 파일의 파싱 실패 사유 원문을 scanJournalStatus().load.error 에 실었다(서비스 점검 응답).
// 규칙(server/CLAUDE.md v2.744 — 로드 오류 원문은 어디에도 싣지 않는다): 요약은 util/atomicWrite.js safeLoadText 한 벌이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744flead-'));
process.env.CONFIG_DIR = tmp;
const SECRET = 'SuperSecretPw2744';
// V8 은 조각을 잘라 보여 준다('…"assword": SuperSecre"…') — 검사는 실제로 보이는 앞부분으로 한다.
const FRAG = SECRET.slice(0, 10);
const CORRUPT = `{"enabled": true, "password": ${SECRET}}`;
fs.writeFileSync(path.join(tmp, 'xfer-speed-settings.json'), CORRUPT);
fs.writeFileSync(path.join(tmp, 'scan-journal.json'), CORRUPT);

const v8Text = (() => { try { JSON.parse(CORRUPT); } catch (e) { return e.message; } return ''; })();

test('⓪ 전제: V8 의 JSON.parse 오류 문구는 비밀 값 조각을 담는다', () => {
  assert.ok(v8Text.includes(FRAG), v8Text);
});

test('① sanitizeRegistryUnreadable — 원문 사유는 요약되고 분류 코드는 아는 값만 남는다', async () => {
  const { sanitizeRegistryUnreadable } = await import('../src/central/partFaultEdge.js');
  const out = sanitizeRegistryUnreadable({
    storage: { at: 1_700_000_000_000, code: 'parse-error', reason: v8Text },
    sanswitch: { at: 1_700_000_000_000, code: 'nonsense', reason: 'JSON 형식 오류(3번째 줄 18번째 칸)' },
    idrac: { at: 'x', reason: 42 },
    bogus: { at: 1, reason: v8Text },
  });
  assert.ok(out.storage && out.sanswitch && out.idrac);
  assert.equal(Object.hasOwn(out, 'bogus'), false, '모르는 장비군은 버린다');
  assert.doesNotMatch(JSON.stringify(out), new RegExp(FRAG), '원문 조각이 중앙 메모리에 남지 않는다');
  assert.match(out.storage.reason, /^JSON 형식 오류/);
  assert.equal(out.storage.code, 'parse-error');
  // 엣지가 이미 요약해 보낸 글자(2.744 엣지)는 그대로다 — 관리자에게 위치가 조치 단서다.
  assert.equal(out.sanswitch.reason, 'JSON 형식 오류(3번째 줄 18번째 칸)');
  assert.equal(out.sanswitch.code, null, '모르는 분류 코드는 싣지 않는다');
  assert.equal(out.idrac.reason, '사유 미상');
  assert.equal(out.idrac.at, null);
});

test('② 전송 속도 설정 손상 — 로드 오류 사유에 원문 조각이 없다(요약만)', async () => {
  const { xferSettingsLoadError } = await import('../src/xferspeed/settings.js');
  const err = xferSettingsLoadError();
  assert.ok(err, '손상 파일은 로드 오류다');
  assert.doesNotMatch(String(err.reason), new RegExp(FRAG));
  assert.match(String(err.reason), /JSON 형식 오류/);
});

test('③ 실행 중 스캔 기록 손상 — scanJournalStatus().load.error 에 원문 조각이 없다(요약만)', async () => {
  const { scanJournalStatus } = await import('../src/util/scanJournal.js');
  const st = scanJournalStatus();
  assert.ok(st?.load?.error, '손상 파일은 로드 오류로 남는다');
  assert.doesNotMatch(JSON.stringify(st), new RegExp(FRAG));
  assert.match(String(st.load.error), /JSON 형식 오류/);
});
