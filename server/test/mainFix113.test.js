// 전체 점검 113회차 — 메인 반영(113회차가 화면 쪽으로 남긴 것).
//  94회차 F2 · 113회차 R4 뒤 저장값 · 매핑 파일의 **읽기 오류**는 원본을 옮기지 않는다(보존본이 없다). 그런데 조회 응답은 손상과 같은 `unreadable` 만 실어
//  화면 세 곳(VM 목록 내보내기 · VM 정보 내보내기 · EM 매핑)이 '손상 사본은 설정 폴더에 남았습니다' 라고 말했고, vmListPrefs 의 쓰기 거절 문구도 같았다.
//  이제 읽기 오류면 `readError` 를 함께 싣고 문구가 가른다(웹 문구는 views/vmListExportText.test.js unreadableNote).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIRS = [];
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'main-fix-113-')); TMP_DIRS.push(CFG);
process.env.CONFIG_DIR = CFG;

const { createExportPrefs } = await import('../src/util/exportPrefs.js');
const L = await import('../src/veeam/vmListPrefs.js');
const M = await import('../src/veeam/em/mapping.js');

/** 파일 자리를 폴더로(EISDIR — 읽기 오류) · 깨진 JSON(손상) · 없음. */
const asDir = (f) => { fs.rmSync(f, { recursive: true, force: true }); fs.mkdirSync(f); };
const asCorrupt = (f) => { fs.rmSync(f, { recursive: true, force: true }); fs.writeFileSync(f, '{"users": '); };
const gone = (f) => fs.rmSync(f, { recursive: true, force: true });

test('exportPrefs(공용): 읽기 오류면 unreadable + readError, 손상이면 unreadable 만', () => {
  const mk = (fileName) => createExportPrefs({ fileName, resolveCols: (c) => ({ ok: true, keys: c || [] }), knownKeys: (c) => ({ keys: c || [], dropped: 0 }), normalizeOpts: () => ({ ok: true, value: {} }) });
  const a = path.join(CFG, 'exp-a.json'); asDir(a);
  const pa = mk('exp-a.json').getPrefs('u1');
  assert.equal(pa.unreadable, true);
  assert.equal(pa.readError, true, '읽기 오류인데 readError 표지가 없다 — 화면이 없는 보존본을 말한다');
  assert.ok(fs.statSync(a).isDirectory(), '읽기 오류인데 원본 자리를 옮겼다');

  const b = path.join(CFG, 'exp-b.json'); asCorrupt(b);
  const pb = mk('exp-b.json').getPrefs('u1');
  assert.equal(pb.unreadable, true);
  assert.equal(pb.readError, undefined, '손상인데 읽기 오류라고 했다(보존본이 있다)');

  const pc = mk('exp-c.json').getPrefs('u1');
  assert.equal(pc.unreadable, undefined);
  assert.equal(pc.readError, undefined);
});

test('vmListPrefs: 조회 표지와 쓰기 거절 문구가 읽기 오류 · 손상을 가른다', () => {
  const f = path.join(CFG, 'vm-list-prefs.json');
  asDir(f); L._resetVmListPrefsForTest();
  let p = L.getPrefs('u1');
  assert.equal(p.unreadable, true);
  assert.equal(p.readError, true);
  let r = L.clearPref('u1', 1);
  assert.equal(r.status, 503);
  assert.match(r.reason, /읽기 오류/);
  assert.doesNotMatch(r.reason, /손상 사본/, '읽기 오류인데 손상 사본이 남았다고 답했다');

  asCorrupt(f); L._resetVmListPrefsForTest();
  p = L.getPrefs('u1');
  assert.equal(p.unreadable, true);
  assert.equal(p.readError, undefined);
  r = L.clearPref('u1', 1);
  assert.equal(r.status, 503);
  assert.match(r.reason, /손상 사본은 설정 폴더에 남았습니다/);

  gone(f); for (const n of fs.readdirSync(CFG)) if (n.startsWith('vm-list-prefs.json.')) gone(path.join(CFG, n));
  L._resetVmListPrefsForTest();
  p = L.getPrefs('u1');
  assert.equal(p.unreadable, undefined);
  assert.equal(p.readError, undefined);
});

test('EM 매핑: emMapReadError 는 읽기 오류일 때만 참', () => {
  const f = path.join(CFG, 'veeam-em-map.json');
  asDir(f); M._resetEmMapForTest();
  assert.equal(M.emMapUnreadable(), true);
  assert.equal(M.emMapReadError(), true);
  asCorrupt(f); M._resetEmMapForTest();
  assert.equal(M.emMapUnreadable(), true);
  assert.equal(M.emMapReadError(), false);
  gone(f); M._resetEmMapForTest();
  assert.equal(M.emMapUnreadable(), false);
  assert.equal(M.emMapReadError(), false);
});
