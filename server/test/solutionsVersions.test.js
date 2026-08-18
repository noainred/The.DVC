import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// v2.327 — 특수기능 'VMware 솔루션 / NSX' 버전 확인 라우트(/tools/solutions) 확장 회귀 방지.
// 저장소 관례(securityScope*.test.js)와 동일하게 라우트 소스 정적 검증을 쓴다(앱 기동 비용 회피).
const src = fs.readFileSync(new URL('../src/routes/api/vcTools.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf("api.get('/tools/solutions'"), src.indexOf("api.get('/tools/vmtools'"));

test('solutions 라우트 — vCenter scope + NSX 귀속 scope(visibleNsxManagers) 강제', () => {
  assert.match(body, /scopedVcenterIds\(req\.user, snap\)/, 'vCenter scope 교집합');
  assert.match(body, /visibleNsxManagers\(nsxSnap\.managers[^)]*allowed\)/, 'NSX 는 scope 귀속 판정으로 필터(전 함대 유출 방지)');
});

test('solutions 라우트 — vCenter·ESXi·NSX 버전 + 실제 NSX Manager 를 함께 반환(사용자 요구)', () => {
  assert.match(body, /vcenterVersions:/, 'vCenter 버전 분포');
  assert.match(body, /esxiVersions:/, 'ESXi 버전 분포(호스트)');
  assert.match(body, /nsxVersions[,:]/, 'NSX Manager 버전 분포(실수집)');
  assert.match(body, /nsxManagers:/, '사이트별 실제 NSX Manager 목록');
  assert.match(body, /esxi:/, '사이트별 ESXi 버전 분포');
  // NSX 버전을 vCenter 확장(vc.solutions)이 아니라 nsxStore 실수집에서 집계하는지(권위 소스).
  assert.match(body, /nsxStore\.get\(\)/, 'NSX 실수집 스토어 사용');
});

test('solutions 라우트 — NSX 버전별 설치 법인(datacenter) 집계(v2.327 사용자 요구)', () => {
  assert.match(body, /datacenterOfVcenter/, '법인 매핑에 datacenterOfVcenter 사용');
  assert.match(body, /corpOfMgr/, '매니저 → 법인 라벨 산출');
  assert.match(body, /corps:/, 'nsxVersions 각 항목에 설치 법인 목록');
  assert.match(body, /corp: corpByVcId\.get\(vc\.id\)/, '아이템에 법인 라벨 포함');
  assert.match(src, /import \{ listDatacenters, datacenterOfVcenter \} from '\.\.\/\.\.\/datacenter\/store\.js'/);
});

test('solutions 라우트 — import 배선(nsxStore·visibleNsxManagers)', () => {
  assert.match(src, /import \{ nsxStore \} from '\.\.\/\.\.\/nsx\/store\.js'/);
  assert.match(src, /import \{ visibleNsxManagers \} from '\.\.\/\.\.\/nsx\/scope\.js'/);
});
