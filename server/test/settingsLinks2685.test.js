// v2.685 — 통신 점검(설정 전수)의 '설정 화면으로 가기' 딥링크는 실제 메뉴 주소여야 한다.
// 예전 값 '#/settings?tab=…' 은 첫 해시 조각이 'settings?tab=…' 이 되어 어떤 탭에도 맞지 않았다(전부 엉뚱한 화면).
// 또 '설정 › Horizon 등록' 은 존재하지 않는 메뉴였다(사용자 신고 "설정에 Horizon 등록 메뉴가 없어").
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../../web/src');
const { SETTINGS_PATHS } = await import('../src/linkcheck/settingsKinds.js');

const settingsSrc = fs.readFileSync(path.join(WEB, 'views/Settings.jsx'), 'utf8');
const SUB_KEYS = new Set([...settingsSrc.matchAll(/\{ k: '([a-z0-9-]+)'/g)].map((m) => m[1]));
const toolsSrc = fs.readFileSync(path.join(WEB, 'views/specialToolsList.js'), 'utf8');
const TOOL_KEYS = new Set([...toolsSrc.matchAll(/\{ k: '([a-z0-9-]+)'/g)].map((m) => m[1]));
const appSrc = fs.readFileSync(path.join(WEB, 'App.jsx'), 'utf8');
const TABS = new Set([...appSrc.matchAll(/\{ id: '([a-z0-9-]+)'/g)].map((m) => m[1]));

test('설정 딥링크는 전부 실제 하위 메뉴·도구·탭 키로 간다', () => {
  assert.ok(SUB_KEYS.has('horizon-admin'), '설정에 Horizon 연결 서버 메뉴가 있어야 한다');
  for (const [k, v] of Object.entries(SETTINGS_PATHS)) {
    if (!v.hash) continue;
    assert.ok(!v.hash.includes('?'), `${k}: 쿼리 형식 해시는 라우터가 읽지 못한다 (${v.hash})`);
    const seg = v.hash.replace(/^#\/?/, '').split('/');
    if (seg[0] === 'settings') assert.ok(SUB_KEYS.has(seg[1]), `${k}: 설정 하위 메뉴 '${seg[1]}' 없음`);
    else if (seg[0] === 'tools') assert.ok(TOOL_KEYS.has(seg[1]), `${k}: 도구 '${seg[1]}' 없음`);
    else assert.ok(TABS.has(seg[0]), `${k}: 탭 '${seg[0]}' 없음`);
  }
});

test('Horizon 안내 문구는 존재하는 메뉴 이름을 말한다', () => {
  for (const f of ['views/tools/horizonSessionText.js', 'views/tools/HorizonSessionSettings.jsx']) {
    const s = fs.readFileSync(path.join(WEB, f), 'utf8');
    assert.ok(!s.includes('설정 › Horizon 등록'), `${f}: 없는 메뉴 이름`);
  }
  assert.equal(SETTINGS_PATHS.horizon.hash, '#/settings/horizon-admin');
});
