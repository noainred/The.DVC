/**
 * publicRepoPii2557.test.js — 공개 저장소에 회사 도메인 연락처를 두지 않는다(v2.557).
 *
 * 2026-09-18 보안 스캔에서 확정한 것: 이 저장소는 **공개**(`visibility: public`)이고
 * `web/src/views/About.jsx` 의 저작자 카드에 **회사 도메인 이메일**이 평문으로 있었다.
 * 단독이면 저자 크레딧이지만, 같은 저장소에 법인 코드 13종·운영 장비명·사설 IP 83개가
 * 함께 있어 **"어느 회사의 누가 어떤 인프라를 운영하는가"** 가 통째로 특정된다.
 *
 * ⚠ 이 테스트가 막는 것은 **앞으로의 재발**이다. git 이력에 남은 과거 커밋은 이 테스트로
 *   지워지지 않는다(이력 재작성은 별도 결정 — CLAUDE.md SAN 픽스처 건과 같은 성질).
 *
 * ⚠ 검사 대상에서 **부정 단언(`assert.ok(!/lgcns/…)`) 은 제외**한다 — `svcmonCsv.test.js` 등이
 *   '그 문자열이 CSV 에 새어 나오면 안 된다' 를 고정하는 가드라서, 그것까지 금지하면
 *   **방어 코드를 지우게 만드는** 테스트가 된다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tracked = () => execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean);

/** 사내·고객사 도메인. 새 도메인을 쓰게 되면 여기에 추가할 것. */
const CORP_DOMAINS = ['lgcns.com', 'lge.com', 'lgensol.com'];
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.zip', '.gz', '.pdf']);

test('공개 소스에 회사 도메인 이메일이 없다(부정 단언 줄은 제외)', () => {
  const found = [];
  for (const f of tracked()) {
    const ext = f.slice(f.lastIndexOf('.'));
    if (SKIP_EXT.has(ext) || basename(f) === basename(fileURLToPath(import.meta.url))) continue;
    let txt = '';
    try { txt = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
    txt.split('\n').forEach((line, i) => {
      for (const d of CORP_DOMAINS) {
        if (!line.includes(`@${d}`)) continue;
        // '없어야 한다' 를 검사하는 가드 줄은 위반이 아니다.
        if (/assert\.(ok|equal)\s*\(\s*!/.test(line) || /doesNotMatch|not\.toContain/.test(line)) return;
        found.push(`${f}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(found, [], `회사 도메인 이메일이 공개 소스에 있습니다:\n  ${found.join('\n  ')}`);
});

test('About 화면의 연락처가 실제로 교체돼 있다', () => {
  const about = readFileSync(join(ROOT, 'web/src/views/About.jsx'), 'utf8');
  assert.match(about, /mailto:noainred@outlook\.com/, 'About 저작자 연락처가 비회사 주소여야 한다');
  assert.doesNotMatch(about, /@lgcns\.com/);
  // 표시 문자열과 mailto 가 어긋나면 사용자가 다른 주소로 메일을 보낸다.
  const shown = about.match(/>([^<>]*@[^<>]*)<\/a>/)?.[1] || '';
  assert.equal(shown.trim(), 'noainred@outlook.com');
});

test('릴리스 노트에도 남아 있지 않다', () => {
  const notes = readFileSync(join(ROOT, 'server/src/release-notes.json'), 'utf8');
  for (const d of CORP_DOMAINS) assert.equal(notes.includes(`@${d}`), false, `릴리스 노트에 @${d} 가 남아 있다`);
});
