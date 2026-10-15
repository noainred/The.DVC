/**
 * v2.740 — 아이실론 디렉터리 사용량: 서머리 삭제 · 수집 대상 설정을 설정 메뉴(슈퍼 관리자 전용)로 이동.
 *   사용자 요청(2026-10-15): "서머리를 없애고, 법인 현황을 첫 탭 … 수집 대상 설정은 설정 메뉴로 이동해서 일반 사용자, 관리자는 못 보게"
 *   + "설정 메뉴를, 전체 설정 메뉴로 이동".
 *   ① 설정 주소 계약(isiduSettingsLink.js) — 하위 탭 판정 · 안내 문구가 실제 설정 메뉴 이름과 같다
 *   ② Settings.jsx — 항목이 superOnly 로 등록되고, 그룹 탭·상단 탭 둘 다 같은 필터(visibleSubs)를 거친다
 *   ③ 특수 기능 화면 — '수집 대상 설정' 창·서머리가 없고, 일괄 버튼은 슈퍼 관리자에게만 넘긴다
 *   ④ 슈퍼 관리자 판정은 /auth/me 의 superAdmin 하나 · 권한 안내가 슈퍼 관리자 역할을 이름으로 말한다
 * 서버 집행은 server/test/isiduSuper2740.test.js(실제 api 라우터 403)가 고정한다 — 여기는 표시 게이팅과 배선이다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { stripComments } from '../../test/_stripComments.js';
import {
  ISIDU_SETTINGS_KEY, ISIDU_SETTINGS_HASH, ISIDU_SETTINGS_BULK_HASH, ISIDU_SETTINGS_PLACE, isiduSettingsTabOf,
} from './isiduSettingsLink.js';
import { hashSegments } from '../../hooks/hashTab.js';
import { describePermission, ROLE_LABEL } from '../../components/accessDeniedText.js';

const src = (rel) => stripComments(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
const SETTINGS = src('../Settings.jsx');
const TOOL = src('./IsilonDirUsageTool.jsx');
const VIEWS = src('./IsiduViews.jsx');
const PAGE = src('./IsiduSettingsPage.jsx');
const API = src('../../api.js');

describe('① 설정 주소 계약', () => {
  it('하위 탭 판정 — bulk 만 일괄 변경, 나머지는 개별 편집', () => {
    expect(isiduSettingsTabOf(hashSegments(ISIDU_SETTINGS_HASH))).toBe('edit');
    expect(isiduSettingsTabOf(hashSegments(ISIDU_SETTINGS_BULK_HASH))).toBe('bulk');
    expect(isiduSettingsTabOf(['settings', ISIDU_SETTINGS_KEY, 'other'])).toBe('edit');
    expect(isiduSettingsTabOf(['settings', 'metrics', 'bulk'])).toBe('edit');   // 다른 설정 항목의 bulk 는 남의 것이다
    expect(isiduSettingsTabOf(null)).toBe('edit');
    expect(isiduSettingsTabOf('settings/isilon-dirusage/bulk')).toBe('edit');   // 배열이 아니면 판정하지 않는다
  });

  it('주소의 키가 Settings.jsx 의 항목 키이고, 안내 문구가 실제 메뉴 이름(그룹 › 항목)과 같다', () => {
    const entry = SETTINGS.match(/\{\s*k:\s*'isilon-dirusage'[^}]*\}/);
    expect(entry, 'Settings.jsx SUB 에 isilon-dirusage 항목이 없다').toBeTruthy();
    const label = entry[0].match(/label:\s*'([^']+)'/)[1];
    const group = entry[0].match(/group:\s*'([^']+)'/)[1];
    expect(ISIDU_SETTINGS_KEY).toBe('isilon-dirusage');
    expect(group).toBe('collect');
    const groupLabel = SETTINGS.match(new RegExp(`\\b${group}:\\s*\\{\\s*label:\\s*'([^']+)'`))[1];
    const [, gPart, lPart] = ISIDU_SETTINGS_PLACE.split(' › ');
    expect(groupLabel.endsWith(gPart), `그룹 이름 '${groupLabel}' 과 안내 '${gPart}' 가 다르다`).toBe(true);
    expect(lPart).toBe(label);
    expect(ISIDU_SETTINGS_PLACE.startsWith('설정 › ')).toBe(true);
  });
});

describe('② Settings.jsx — 슈퍼 관리자 전용 항목', () => {
  it('항목이 superOnly 이고 화면 컴포넌트는 지연 로드된다', () => {
    expect(SETTINGS).toMatch(/\{\s*k:\s*'isilon-dirusage'[^}]*superOnly:\s*true[^}]*\}/);
    expect(SETTINGS).toMatch(/const IsiduSettingsPage = lazy\(\(\) => import\('\.\/tools\/IsiduSettingsPage\.jsx'\)\)/);
  });

  it('그룹 탭과 상단 탭이 같은 필터(visibleSubs)를 거친다 — 한쪽만 거르면 그룹 버튼이 숨긴 항목을 연다', () => {
    expect(SETTINGS).toMatch(/const visibleSubs = \(\) => SUB\.filter\(\(s\) => !s\.superOnly \|\| isSuperAdminUser\(\)\)/);
    expect(SETTINGS).toMatch(/const groupChildren = \(g\) => visibleSubs\(\)\.filter/);
    expect(SETTINGS).toMatch(/for \(const s of visibleSubs\(\)\)/);
    // SUB 를 직접 훑어 탭을 만드는 곳이 남아 있으면 superOnly 가 새는 길이 된다.
    expect(SETTINGS).not.toMatch(/for \(const s of SUB\)/);
    expect(SETTINGS).not.toMatch(/SUB\.filter\(\(s\) => s\.group === g\)/);
  });

  it('설정 화면은 슈퍼 관리자가 아니면 조회하지 않고 권한 안내를 그린다', () => {
    expect(PAGE).toMatch(/if \(!superAdmin\) \{\s*return <ErrorBox error=\{\{ status: 403, requiredRole: \['super_admin'\]/);
    expect(PAGE).toMatch(/useEffect\(\(\) => \(superAdmin \? load\(\) : undefined\)/);
    expect(PAGE).toMatch(/<IsiduSettings page /);
    expect(PAGE).not.toMatch(/setInterval|usePolling/);   // 설정 화면은 폴링하지 않는다
  });
});

describe('③ 특수 기능 화면 — 설정 창·서머리 삭제', () => {
  it('IsilonDirUsageTool 은 설정 창을 열지 않는다', () => {
    expect(TOOL).not.toMatch(/import IsiduSettings from/);
    expect(TOOL).not.toMatch(/<IsiduSettings\b/);
    expect(TOOL).not.toMatch(/showSettings|openSettings|settingsTab/);
    expect(TOOL).not.toMatch(/SummaryView/);
    expect(TOOL).toMatch(/ISIDU_SETTINGS_PLACE/);   // 비어 있을 때 설정 위치를 말한다
  });

  it('일괄 변경은 슈퍼 관리자에게만 넘기고, StatusView 는 넘겨받았을 때만 버튼을 그린다', () => {
    expect(TOOL).toMatch(/openBulk=\{superAdmin \? \(\) => \{ window\.location\.hash = ISIDU_SETTINGS_BULK_HASH; \} : null\}/);
    expect(TOOL).toMatch(/\{superAdmin \? <div><a className="isd-btn primary" href=\{ISIDU_SETTINGS_HASH\}>/);
    expect(VIEWS).toMatch(/\{openBulk \? <div className="isd-actions">/);
    expect(VIEWS).not.toMatch(/export function SummaryView/);
  });

  it('IsiduSettings 는 창(Modal)과 페이지 두 모양을 한 본문으로 그린다 — 렌더 안에서 컴포넌트를 만들지 않는다', () => {
    const S = src('./IsiduSettings.jsx');
    expect(S).toMatch(/return page\s*\?\s*<section className="isd isd-settings-page"/);
    expect(S).toMatch(/: <Modal title=/);
    // 렌더 안의 화살표 컴포넌트(const Shell = ({children}) => …)는 매 렌더 입력칸을 다시 만들어 포커스를 잃는다.
    expect(S).not.toMatch(/const [A-Z]\w* = \(\{\s*children\s*\}\) =>/);
  });
});

describe('④ 슈퍼 관리자 판정·권한 안내', () => {
  it('isSuperAdminUser 는 /auth/me 의 superAdmin === true 하나다', () => {
    expect(API).toMatch(/export const isSuperAdminUser = \(\) => _currentUser\?\.superAdmin === true;/);
  });

  it('권한 안내가 슈퍼 관리자 역할을 이름으로 말한다(서버 requiredRole 배열)', () => {
    expect(ROLE_LABEL.super_admin).toMatch(/슈퍼 관리자/);
    const d = describePermission({ status: 403, requiredRole: ['super_admin'] });
    expect(d.kind).toBe('role');
    expect(d.need).toMatch(/슈퍼 관리자\(super_admin\)/);
  });
});
