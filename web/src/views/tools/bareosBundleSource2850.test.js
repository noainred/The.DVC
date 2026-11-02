// v2.850 Bareos 번들 받는 곳 · 서버 디렉터리(서버 bundleSource.js · bundle.js) — 화면 쪽.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { importDirStateText, bundleWhereText, bundleStateView, bundleFromText } from './bareosInstallText.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const src = fs.readFileSync(path.join(here, 'BareosInstall.jsx'), 'utf8');

describe('v2.850 번들 받는 곳 · 서버 디렉터리', () => {
  it('글자 — 출처 · 디렉터리 상태 · 위치 · 상태(확인 중은 노랑)', () => {
    expect(bundleFromText('env')).toMatch(/BAREOS_BUNDLE_BASE_URL/);
    expect(bundleFromText('zzz')).toBe('정해지지 않음');
    expect(importDirStateText('unreadable').cls).toBe('red');
    expect(importDirStateText('missing').text).toMatch(/만들어 두세요/);
    expect(importDirStateText('').text).toBe('정하지 않음');
    expect(bundleWhereText('import')).toBe('서버 디렉터리');
    expect(bundleWhereText(undefined)).toBe('받은 번들');
    expect(bundleStateView({ ok: null, reason: '파일이 막 바뀌었습니다' }).cls).toBe('amber');
    expect(bundleStateView({ ok: null, reason: '확인 전' }).cls).toBe('gray');
    expect(bundleStateView({ ok: false, reason: 'x' }).text).toBe('사용 불가 — x');
  });
  it('화면 — 서버 디렉터리의 번들은 지우기 단추가 없다 · 저장은 PUT bundle/source', () => {
    expect(src).toMatch(/x\.where === 'import' \? <span className="muted"[^>]*>—<\/span> : <button[^>]*>/);
    expect(src).toMatch(/putJson\(`\$\{P\}\/bundle\/source`, \{ baseUrl: edit\.baseUrl\.trim\(\), importDir: edit\.importDir\.trim\(\) \}\)/);
    expect(src).not.toMatch(/받는 곳: \{ov\.bundleBaseUrl \|\| '—'\}\s*\n\s*<\/div>/);
  });
});
