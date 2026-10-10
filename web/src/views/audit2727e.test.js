// v2.727 감사 그룹 5 — 웹 화면 회귀(E-01·E-03·E-04·E-07·E-09) + 스윕(delJson/putJson 반환값을 버리는 호출).
// 순수 함수(머리 문장)·ErrorBox 는 실제로 호출·렌더하고, JSX 만 바뀐 것은 주석을 지운 소스 스윕으로 고정한다(web/src/test/_stripComments.js).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { stripComments } from '../test/_stripComments.js';
import { ErrorBox } from '../components/primitives.jsx';
import { HttpError } from '../api.js';
import { headline } from './tools/bmStorHistoryText.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_SRC = path.join(here, '..');
const src = (rel) => stripComments(fs.readFileSync(path.join(here, rel), 'utf8'));

describe('E-01 HorizonAdmin 삭제 — delJson 의 400 본문(ok:false)을 성공으로 읽지 않는다', () => {
  // api.js sendJson 은 400·409 를 throw 하지 않고 본문을 돌려준다 — 서버 DELETE /admin/horizon/:id 는 `res.status(r.ok ? 200 : 400).json(r)`.
  const s = src('HorizonAdmin.jsx');
  const at = s.indexOf('const hzDel = async');
  const body = s.slice(at, at + 900);
  it('반환값 r 을 받아 r?.ok === false 면 사유(r.reason)를 hzMsg 에 남긴다', () => {
    expect(at).toBeGreaterThan(0);
    expect(body).toMatch(/const r = await delJson\(/);
    expect(body).toMatch(/r\?\.ok === false\)[\s\S]{0,80}r\.reason/);
    expect(body).not.toMatch(/\{ await delJson\([^)]*\); changed\(\);/);
  });
  it('거부돼도 목록은 다시 읽는다(changed) — 화면이 실제 등록부와 같게', () => {
    expect(body.indexOf('r?.ok === false')).toBeGreaterThan(0);
    expect(body.indexOf('r?.ok === false')).toBeLessThan(body.indexOf('changed();'));
  });
  it('삭제 버튼은 진행 중(busy) 잠긴다', () => {
    expect(s).toMatch(/disabled=\{busy\} onClick=\{\(\) => hzDel\(s\.id\)\}/);
  });
});

describe('E-09 HorizonAdmin 목록 조회 — 늦게 온 이전 응답을 버린다', () => {
  const s = src('HorizonAdmin.jsx');
  it('세대 번호(loadSeq)로 then/catch 둘 다 가드하고 언마운트에서 세대를 올린다', () => {
    const body = s.slice(s.indexOf('const load = () =>'), s.indexOf('const changed ='));
    expect(body).toMatch(/const my = \+\+loadSeq\.current/);
    expect((body.match(/if \(my !== loadSeq\.current\) return;/g) || []).length).toBe(2);
    expect(body).toMatch(/return \(\) => \{ loadSeq\.current \+= 1; \}/);
    expect(body).toMatch(/else setHzErr\(/); // audit2612f 계약 그대로(0대로 칠하지 않는다)
  });
});

describe('E-03 이름·단계 편집기 — 저장 실패는 ErrorBox(403 → 권한 안내)이고 드로어는 전체 범위 관리자에게만', () => {
  const ed = src('ToolNamesStages.jsx');
  const st = src('SpecialTools.jsx');
  it('catch 가 오류 객체를 그대로 상태에 두고 ErrorBox 로 그린다(st-err 글자 렌더 금지)', () => {
    expect(ed).toMatch(/import \{ ErrorBox \} from '\.\.\/components\/ui\.jsx'/);
    expect(ed).toMatch(/catch \(e\) \{\s*setErr\(e\);/);
    expect(ed).toMatch(/<ErrorBox error=\{err\} \/>/);
    expect(ed).not.toMatch(/<span className="st-err">\{err\}<\/span>/);
    expect(ed).not.toMatch(/setErr\(e\?\.message/);
  });
  it('fleetOnly 403(HttpError) → AccessDenied 로 렌더된다 — `오류: forbidden` 이 아니다', () => {
    const e = new HttpError('forbidden', { status: 403, path: '/admin/tool-categories', body: { ok: false, error: 'forbidden', reason: '전체 범위(vCenter 제한 없는) 계정만 바꿀 수 있습니다.' } });
    const html = renderToString(createElement(ErrorBox, { error: e }));
    expect(html).toContain('access-denied');
    expect(html).not.toMatch(/오류: forbidden/);
    // 문자열(검증·400 사유)도 같은 자리에서 그려진다
    const plain = renderToString(createElement(ErrorBox, { error: '저장하지 못했습니다.' }));
    expect(plain).toContain('error-box');
    expect(plain).toContain('저장하지 못했습니다.');
  });
  it('⚙ 버튼 조건은 canEditNames(hasRole admin + scope 비어 있음)이고 isAdmin 만으로 열지 않는다', () => {
    expect(st).toMatch(/\{canEditNames && \(\s*<button className="st-set-btn"/);
    expect(st).not.toMatch(/\{isAdmin && \(\s*<button className="st-set-btn"/);
    // 판정 모양은 VmHygieneTool·VmDnsTool 과 같다(지어내지 않았다)
    expect(st).toMatch(/const fullScope = !\(u\?\.scope\?\.vcenters\?\.length \|\| u\?\.scope\?\.regions\?\.length\)/);
    expect(st).toMatch(/setCanEditNames\(hasRole\('admin'\) && fullScope\)/);
    expect(src('tools/VmHygieneTool.jsx')).toMatch(/const fullScope = !\(u\?\.scope\?\.vcenters\?\.length \|\| u\?\.scope\?\.regions\?\.length\)/);
  });
});

describe('E-04 VM 구성 점검 — 정책 설정 조회 실패를 삼켜 패널이 조용히 사라지지 않는다', () => {
  const s = src('tools/VmHygieneTool.jsx');
  it('loadSettings 는 settingsErr 를 들고 세대 가드가 있다(catch { setSettings(null) } 금지)', () => {
    const at = s.indexOf('const loadSettings = useCallback');
    const body = s.slice(at, s.indexOf('useEffect(() => { load(); }', at));
    expect(at).toBeGreaterThan(0);
    expect(body).not.toMatch(/catch \{ setSettings\(null\); \}/);
    expect(body).toMatch(/const my = \+\+sgen\.current/);
    expect(body).toMatch(/catch \(e\) \{ if \(my === sgen\.current\) setSettingsErr\(e\); \}/);
    expect(body).toMatch(/setSettingsErr\(null\)/);
  });
  it('패널 자리에 ErrorBox + 다시 시도 버튼을 그린다 — 기능이 없어진 것이 아니라고 말한다', () => {
    expect(s).toMatch(/\{settingsErr && \([\s\S]{0,700}<ErrorBox error=\{settingsErr\} \/>[\s\S]{0,200}다시 시도/);
    expect(s).toMatch(/onClick=\{loadSettings\}>다시 시도<\/button>/);
    expect(s).toMatch(/기능이 없어진 것이 아닙니다/);
  });
});

describe('E-07 베어메탈 스토리지 추이 머리글 — 문장형에는 — 를 끼우지 않는다(값형은 유지)', () => {
  const TB = 1024 ** 4; const D = 86_400_000; const t0 = 1_790_000_000_000;
  const pt = (day, used, avail = 100 - used, extra = {}) => ({ ts: t0 + day * D, usedBytes: used * TB, availBytes: avail * TB, totalBytes: (used + avail) * TB, partial: false, ...extra });
  const ser = (kind, key, name, points) => ({ kind, key, name, points });
  it('그룹 보기: 사용률을 읽은 그룹이 없으면 자연스러운 한 문장', () => {
    const list = [ser('group', 'A', 'A', [pt(0, 40, 60, { partial: true })]), ser('group', 'B', 'B', [])];
    const g = headline('group', { periodLabel: '7일', series: list });
    expect(g.main).toBe('2개 그룹 중 사용률을 읽은 그룹이 없습니다.');
    expect(g.main).not.toContain('—');
    expect(g.sub).toContain('온전한 기록이 쌓이면');
  });
  it('서버 보기: 기간 변화를 계산할 수 있는 서버가 없으면 자연스러운 한 문장', () => {
    const list = [ser('server', 's1', 'srv-1', [pt(0, 40)])];
    const s = headline('server', { periodLabel: '7일', series: list, scopeLabel: 'X' });
    expect(s.main).toBe('X 그룹 1대 중 기간 변화를 계산할 수 있는 서버가 없습니다.');
    expect(s.main).not.toContain('—');
    expect(headline('server', { periodLabel: '7일', series: list }).main.startsWith('전체 1대 중')).toBe(true);
  });
  it('값형 문장(전체 합계 변화는 — 입니다)은 그대로다 — 값 자리의 — 는 뜻이 있다', () => {
    const one = headline('total', { periodLabel: '7일', series: [ser('total', '', '전체', [pt(0, 40)])] });
    expect(one.main).toContain('변화는 **—** 입니다');
  });
  it('문구에 백틱이 없다(BoldText 규약)', () => {
    const list = [ser('group', 'A', 'A', [pt(0, 40, 60, { partial: true })])];
    for (const t of Object.values(headline('group', { periodLabel: '7일', series: list }))) expect(t).not.toContain('`');
  });
});

describe('스윕 — await delJson/putJson/patchJson/sendJson 의 반환값을 버리는 호출(E-01 유형)', () => {
  // api.js sendJson(= putJson·patchJson·delJson)은 400·409 를 throw 하지 않고 본문을 돌려준다. 반환값을 보지 않는 호출은
  // 서버가 400 `{ok:false, reason}` 으로 거부해도 성공처럼 지나간다(HorizonAdmin 삭제가 그랬다).
  // ⚠ 아래 허용 목록은 v2.727 조사 시점의 **잔존 그대로**다 — 호출마다 서버 라우트가 400 본문을 돌려줄 수 있는지는 확인하지 않았다
  //   (정직 기록 — 후속 점검 후보). 고쳤으면 여기서 줄이고(개수가 글자 그대로 같아야 한다), 새 호출은 반환값(r.ok)을 볼 것.
  // 검출 규칙: `await <fn>(` 바로 앞(같은 줄, 비면 직전 줄)의 끝이 `=`·return·?·:·(·||·&&·,·[·??·=> 가 아니면 '버린 것'.
  //   한계: `.then(() => putJson(...))`·`act(() => delJson(...))`(await 없음)·`return delJson(...)` 은 보지 않는다 — 좁게 잡아 오탐을 없앴다.
  // v2.731(점검 1회차 G4a·G4b): SvcMonitor·TestWizard·CredentialManager·RemoteCommand·GuestScanJobs 는 반환값을 판정한다 — 목록에서 뺐다.
  const ALLOW = {
    'views/AgentDeploy.jsx': 1, 'views/AgentScans.jsx': 1, 'views/Alarms.jsx': 1, 'views/Collectors.jsx': 3,
    'views/NetTrafficAnalysis.jsx': 3, 'views/NsxAdmin.jsx': 1, 'views/PerfMonitor.jsx': 1, 'views/PortalBackup.jsx': 1, 'views/ProxySettings.jsx': 1,
    'views/RemoteAccess.jsx': 2, 'views/VCenterAdmin.jsx': 2, 'views/VmProvision.jsx': 1, 'views/VmSeriesSettings.jsx': 1,
    'views/gpu-guest/PhysicalGpuManager.jsx': 1, 'views/sidebar/MenuEditor.jsx': 2, 'views/svcmon/BulkTab.jsx': 1,
    'views/tools/BmStorageTool.jsx': 1, 'views/tools/CvpTool.jsx': 1, 'views/tools/FleetInventory.jsx': 2,
    'views/tools/GuestDiskReport.jsx': 1, 'views/tools/PduTool.jsx': 1, 'views/tools/SanHealthCheck.jsx': 1,
    'views/tools/SanSwitchTool.jsx': 1, 'views/tools/StorageMonTool.jsx': 1, 'views/tools/VmCloneTool.jsx': 1,
  };
  const USED_TAIL = /(=|return|\?|:|\(|\|\||&&|,|\[|\?\?|=>\s*\{?)\s*$/;
  const walk = (d, out = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, out); else if (/\.(js|jsx)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const scan = () => {
    const byFile = {};
    for (const f of walk(WEB_SRC)) {
      const rel = path.relative(WEB_SRC, f).split(path.sep).join('/');
      if (/\.test\.(js|jsx)$/.test(rel) || rel === 'api.js' || rel.startsWith('test/')) continue;
      const lines = stripComments(fs.readFileSync(f, 'utf8')).split('\n');
      for (let i = 0; i < lines.length; i++) {
        const re = /\bawait\s+(delJson|putJson|patchJson|sendJson)\s*\(/g; let m;
        while ((m = re.exec(lines[i]))) {
          let before = lines[i].slice(0, m.index).trimEnd();
          let j = i; while (!before && j > 0) { j -= 1; before = lines[j].trimEnd(); }
          if (!USED_TAIL.test(before)) byFile[rel] = (byFile[rel] || 0) + 1;
        }
      }
    }
    return byFile;
  };
  const found = scan();
  it('검출 결과가 허용 목록과 글자 그대로 같다(새 호출 0 · 고친 것은 목록에서 뺄 것)', () => {
    expect(found).toEqual(ALLOW);
  });
  it('HorizonAdmin.jsx 는 0 이고 허용 목록에도 없다(E-01 — 되돌리면 여기서 잡힌다)', () => {
    expect(found['views/HorizonAdmin.jsx']).toBeUndefined();
    expect(ALLOW['views/HorizonAdmin.jsx']).toBeUndefined();
  });
  it('검출기 자체 검증 — 반환값을 쓰는 모양은 세지 않고 버리는 모양은 센다', () => {
    const probe = (text) => {
      const lines = text.split('\n'); let n = 0;
      for (let i = 0; i < lines.length; i++) {
        const re = /\bawait\s+(delJson|putJson|patchJson|sendJson)\s*\(/g; let m;
        while ((m = re.exec(lines[i]))) {
          let before = lines[i].slice(0, m.index).trimEnd();
          let j = i; while (!before && j > 0) { j -= 1; before = lines[j].trimEnd(); }
          if (!USED_TAIL.test(before)) n += 1;
        }
      }
      return n;
    };
    expect(probe("const r = await delJson('/x');")).toBe(0);
    expect(probe("const r =\n  await putJson('/x', {});")).toBe(0);
    expect(probe("const r = a ? await putJson('/x', b) : await postJson('/x', b);")).toBe(0);
    expect(probe("return await sendJson('/x', 'DELETE');")).toBe(0);
    expect(probe("try { await delJson('/x'); changed(); } catch (e) {}")).toBe(1);
    expect(probe("if (edit) await putJson('/x', b); else await postJson('/x', b);")).toBe(1);
    expect(probe("x.then(() => putJson('/x'))")).toBe(0); // 한계 — await 가 아닌 모양은 보지 않는다
  });
});
