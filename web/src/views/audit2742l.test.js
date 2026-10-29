/**
 * v2.742 감사 그룹 GJ(웹 화면) 회귀 — WEB-01·WEB-02·WEB-03·WEB-04·LEFT-06·LEFT-04(웹 부분).
 * 순수 판정(serviceDownText·changeResult·hostCapacityText·카탈로그)은 실제로 호출하고, 렌더 가능한 컴포넌트(ServiceDown·UnityConfigPanels)는
 * react-dom/server 로 그리며, 이벤트 처리기 안의 배선만 주석을 지운 소스로 고정한다(웹 테스트는 DOM 이 없어 처리기를 실행할 수 없다).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { stripComments } from '../test/_stripComments.js';
import {
  probeOutcome, reconnectStep, reconnectStatusText, RECONNECT_INITIAL, headlineFor, PROBE_ALIVE_STATUSES,
} from '../components/serviceDownText.js';
import ServiceDown from '../components/ServiceDown.jsx';
import { requireChanged } from './changeResult.js';
import { TOOLS } from './specialToolsList.js';
import { lockReasonOf } from './toolVisibility.js';
import { hostCapShort, hostCapFootnote, hostCapTotal, hostCapCount, HOST_CAP_METRICS } from './hostCapacityText.js';
import UnityConfigPanels from './tools/UnityConfigPanels.jsx';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const src = (rel) => stripComments(fs.readFileSync(path.join(WEB, rel), 'utf8'));
const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// ── WEB-01 ────────────────────────────────────────────────────────────────────
describe('WEB-01 ServiceDown 자동 재연결 — 401/403 도 응답이고, 새로고침은 연결 불가 → 응답으로 바뀔 때만', () => {
  it('probeOutcome: 2xx·401·403 은 살아 있음, 연결 실패·5xx·그 밖은 아직 아님', () => {
    expect(probeOutcome({ status: 200 })).toBe('alive');
    expect(probeOutcome({ status: 204 })).toBe('alive');
    expect(probeOutcome({ status: 401 })).toBe('alive');   // 인증을 켠 포탈의 토큰 없는 확인 요청 — 예전에는 영원히 '재시작 중'
    expect(probeOutcome({ status: 403 })).toBe('alive');
    expect([...PROBE_ALIVE_STATUSES].sort()).toEqual([401, 403]);
    for (const st of [500, 502, 503, 504, 404, 429]) expect(probeOutcome({ status: st }), String(st)).toBe('down');
    expect(probeOutcome({ error: new TypeError('Failed to fetch') })).toBe('down');
    expect(probeOutcome({ status: 200, error: new Error('x') })).toBe('down');
    expect(probeOutcome({})).toBe('down');
    expect(probeOutcome(null)).toBe('down');
  });
  it('reconnectStep: 처음부터 살아 있으면 새로고침하지 않는다(alive) — 인증을 끈 포탈의 새로고침 반복 방지', () => {
    const s = reconnectStep(RECONNECT_INITIAL, 'alive');
    expect(s.phase).toBe('alive');
    expect(s.sawDown).toBe(false);
    expect(reconnectStep(s, 'down')).toBe(s);             // 끝 상태는 바뀌지 않는다
  });
  it('reconnectStep: 한 번 이상 연결 불가였다가 응답하면 reload', () => {
    let s = RECONNECT_INITIAL;
    s = reconnectStep(s, 'down'); expect(s.phase).toBe('probing'); expect(s.sawDown).toBe(true);
    s = reconnectStep(s, 'down'); expect(s.phase).toBe('probing'); expect(s.probes).toBe(2);
    s = reconnectStep(s, 'alive'); expect(s.phase).toBe('reload');
    expect(reconnectStep(s, 'alive')).toBe(s);
  });
  it('reconnectStatusText: 확인 중·재연결 중·살아 있음을 나눠 말한다(살아 있으면 스피너 없음)', () => {
    expect(reconnectStatusText(RECONNECT_INITIAL, 3).text).toBe('서버 응답 확인 중 · 3초 경과');
    expect(reconnectStatusText({ phase: 'probing', sawDown: true }, 7).text).toBe('자동 재연결 시도 중 · 7초 경과');
    const alive = reconnectStatusText({ phase: 'alive' }, 9);
    expect(alive.spinning).toBe(false);
    expect(alive.text).toContain('다시 시도');
    expect(reconnectStatusText({ phase: 'reload' }).spinning).toBe(true);
    for (const st of [RECONNECT_INITIAL, { phase: 'alive' }, { phase: 'reload' }]) {
      const t = reconnectStatusText(st, 1).text;
      expect(t).not.toContain('`'); expect(t).not.toContain('**');
    }
  });
  it('headlineFor: 시한 초과는 응답 지연 헤드라인(재시작 가능성은 함께 말한다), 연결 실패는 그대로', () => {
    const tmo = headlineFor('timeout'); const net = headlineFor('network');
    expect(tmo.title).toContain('늦어지고');
    expect(tmo.title).toContain('재시작');
    expect(tmo.title).not.toBe(net.title);
    expect(tmo.autoReconnect).toBe(true);
    expect(net.title).toBe('업데이트 후 재시작 중입니다');
    expect(headlineFor('gateway').autoReconnect).toBe(false);
  });
  it('렌더: 첫 화면은 확인 중이라 말하고 "자동 재연결 시도 중" 이라 단정하지 않는다', () => {
    const t = textOf(renderToStaticMarkup(h(ServiceDown, { kind: 'network', message: 'Failed to fetch' })));
    expect(t).toContain('서버 응답 확인 중 · 0초 경과');
    expect(t).not.toContain('자동 재연결 시도 중');
    expect(t).toContain('지금 다시 시도');
  });
  it('배선: 확인 요청에 로그인 토큰을 붙이고, 판정은 probeOutcome·reconnectStep 하나다(res.ok 로 바로 새로고침하지 않는다)', () => {
    const s = src('components/ServiceDown.jsx');
    expect(s).toMatch(/import \{ getToken \} from '\.\.\/api\.js'/);
    expect(s).toMatch(/Authorization: `Bearer \$\{token\}`/);
    expect(s).toMatch(/reconnectStep\(rcRef\.current, probeOutcome\(r\)\)/);
    expect(s).toMatch(/next\.phase === 'reload'\) \{ done\.current = true; stop\(\); window\.location\.reload\(\)/);
    expect(s).not.toMatch(/res\.ok && !done\.current/);
  });
});

// ── WEB-02 ────────────────────────────────────────────────────────────────────
describe('WEB-02 메일 설정·메일 진단·폴더 사용량 — 서버 400 거부를 저장됨으로 읽지 않는다', () => {
  // 서버(routes/admin/mail.js · dirUsage.js)가 검증 실패에서 실제로 돌려주는 본문 모양.
  const MAIL_400 = { ok: false, reason: '메일 발송을 켜려면 SMTP 서버 주소가 필요합니다.', errors: ['…'] };
  const DIR_400 = { ok: false, reason: '대상 t1: 경로가 비었습니다.', errors: ['…'] };
  it('requireChanged 는 그 본문을 사유로 던지고, 성공 본문은 그대로 돌려준다', () => {
    expect(() => requireChanged(MAIL_400)).toThrow(MAIL_400.reason);
    expect(() => requireChanged(DIR_400)).toThrow(DIR_400.reason);
    const ok = { ok: true, settings: { enabled: true } };
    expect(requireChanged(ok)).toBe(ok);
  });
  const cases = [
    ['views/MailSettings.jsx', "requireChanged(await sendJson('/admin/mail', 'PUT'"],
    ['views/tools/MailDiag.jsx', "requireChanged(await sendJson('/admin/mail', 'PUT'"],
    ['views/DirUsageSettings.jsx', "requireChanged(await sendJson('/admin/dir-usage', 'PUT', body))"],
  ];
  for (const [file, call] of cases) {
    it(`${file}: 저장 응답을 requireChanged 로 판정한 뒤에만 성공 문구를 쓴다`, () => {
      const s = src(file);
      expect(s).toMatch(/import \{ requireChanged \} from '\.\.?\/(\.\.\/)?(views\/)?changeResult\.js'|import \{ requireChanged \} from '\.\.?\/changeResult\.js'/);
      const at = s.indexOf(call);
      expect(at, `${file} — ${call}`).toBeGreaterThan(0);
      const ok = s.indexOf("setMsg('저장되었습니다", at) >= 0 ? s.indexOf("setMsg('저장되었습니다", at) : s.indexOf('setMsg(`저장되었습니다', at);
      expect(ok).toBeGreaterThan(at);
    });
  }
  it('메일 두 화면: 비밀번호 칸 비우기는 판정 뒤(거부되면 입력한 비밀번호가 남는다)', () => {
    for (const f of ['views/MailSettings.jsx', 'views/tools/MailDiag.jsx']) {
      const s = src(f);
      const call = s.indexOf("requireChanged(await sendJson('/admin/mail'");
      const clear = s.indexOf("password: ''", call);
      expect(call).toBeGreaterThan(0);
      expect(clear).toBeGreaterThan(call);
      // 예전 모양(받기만 하고 바로 성공 문구)이 남아 있지 않다
      expect(s).not.toMatch(/const r = await sendJson\('\/admin\/mail'/);
    }
  });
});

// ── WEB-03 ────────────────────────────────────────────────────────────────────
describe('WEB-03 SAN 기준선 저장 409 · PDU 전체 수집 200{ok:false} 를 실패 톤으로', () => {
  const BASELINE_409 = { ok: false, reason: '마지막 수집이 실패한 스냅샷입니다 — 기준선으로 쓰면 다음 점검이 틀립니다. 수집 성공 후 저장하세요.' };
  const PDU_BUSY = { ok: false, reason: '이미 수집 중입니다.', running: true };
  it('requireChanged 가 두 본문을 사유로 던지고, 성공 본문은 통과시킨다', () => {
    expect(() => requireChanged(BASELINE_409)).toThrow('마지막 수집이 실패한 스냅샷');
    expect(() => requireChanged(PDU_BUSY)).toThrow('이미 수집 중입니다.');
    expect(requireChanged({ ok: true, baseline: { portCount: 48 } }).baseline.portCount).toBe(48);
    expect(requireChanged({ ok: true, devices: 3, collected: 3, failed: 0 }).collected).toBe(3);
  });
  it('SanHealthCheck: 기준선 저장은 requireChanged(await postJson(…)) 이고 실패면 catch 의 실패 문구', () => {
    const s = src('views/tools/SanHealthCheck.jsx');
    const at = s.indexOf('const saveBaseline = async');
    const body = s.slice(at, s.indexOf('const dropBaseline', at));
    expect(at).toBeGreaterThan(0);
    expect(body).toMatch(/requireChanged\(await postJson\(`\/tools\/sanswitch\/devices\/\$\{deviceId\}\/err-baseline`, \{\}\)\)/);
    expect(body).toMatch(/catch \(e\) \{ setMsg\(`기준선 저장 실패: \$\{e\.message\}`\)/);
  });
  it('PduTool: 전체 수집은 requireChanged 로 판정하고 실패면 ok:false 메시지', () => {
    const s = src('views/tools/PduTool.jsx');
    const at = s.indexOf('const collectAll = async');
    const body = s.slice(at, at + 700);
    expect(body).toMatch(/requireChanged\(await postJson\('\/tools\/pdu\/collect-all', \{\}\)\)/);
    expect(body).toMatch(/catch \(e\) \{ setMsg\(\{ ok: false, text: e\.message \}\)/);
    expect(body).not.toMatch(/const r = await postJson\('\/tools\/pdu\/collect-all'/);
  });
});

// ── WEB-04 ────────────────────────────────────────────────────────────────────
describe('WEB-04 네트워크 트래픽 분석 카드 — 관리자 전용(주 API /api/admin/net/* 가 adminOnly)', () => {
  const t = TOOLS.find((x) => x.k === 'net-traffic');
  it('카탈로그 adminOnly:true', () => {
    expect(t).toBeTruthy();
    expect(t.adminOnly).toBe(true);
  });
  it('operator 에게는 잠기고 admin 에게는 열린다(카드·팔레트가 같은 판정)', () => {
    expect(lockReasonOf(t, { isAdmin: false })).toBe('관리자(admin) 전용 기능입니다.');
    expect(lockReasonOf(t, { isAdmin: true })).toBe(null);
  });
});

// ── LEFT-06 ───────────────────────────────────────────────────────────────────
describe('LEFT-06 용량 모름 호스트(hostsCapacityUnknown)를 총량 옆에 말한다', () => {
  it('짧은 표지·각주 — 0·null·문자열·음수는 표시하지 않는다', () => {
    for (const v of [0, null, undefined, '3', -1, NaN, Infinity]) {
      expect(hostCapShort(v), String(v)).toBe(null);
      expect(hostCapFootnote(v), String(v)).toBe(null);
      expect(hostCapCount(v), String(v)).toBe(0);
    }
    expect(hostCapShort(3)).toBe('3대 용량 모름 — 합계 제외');
    expect(hostCapShort(1200)).toBe('1,200대 용량 모름 — 합계 제외');
    const f = hostCapFootnote(2);
    expect(f).toContain('2대');
    expect(f).toContain('부분 합');
    expect(f).not.toContain('`'); expect(f).not.toContain('**');
  });
  it('hostCapTotal 은 /vcenters 의 metrics.hostsCapacityUnknown 합(결측은 0 으로 세지 않고 건너뛴다)', () => {
    expect(hostCapTotal([{ metrics: { hostsCapacityUnknown: 2 } }, { metrics: {} }, { metrics: { hostsCapacityUnknown: 3 } }, null, {}])).toBe(5);
    expect(hostCapTotal(null)).toBe(0);
    expect(HOST_CAP_METRICS).toEqual(['cpuTotalGhz', 'memTotalGB']);
  });
  it('vCenter 카드 — 카드마다 짧은 표지(긴 이유는 title), 목록 위 각주 한 번', () => {
    const s = src('views/VCenters.jsx');
    expect(s).toMatch(/hostCapShort\(m\.hostsCapacityUnknown\)/);
    expect(s).toMatch(/title=\{hostCapFootnote\(m\.hostsCapacityUnknown\)\}/);
    expect(s).toMatch(/hostCapFootnote\(hostCapTotal\(shown\)\)/);
  });
  it('비교 매트릭스 vCenter 축 — 총량 칸에 * 표지와 툴팁, 설명에 각주 한 번', () => {
    const s = src('views/CompareMatrix.jsx');
    expect(s).toMatch(/HOST_CAP_METRICS\.includes\(mk\)/);
    expect(s).toMatch(/\{cellText\(c\.value, c\.mt\)\}\{c\.capMark \? ' \*' : ''\}/);
    expect(s).toMatch(/hostCapFootnote\(hostCapTotal\(vcList\)\)/);
  });
});

// ── LEFT-04(웹 부분) ─────────────────────────────────────────────────────────
describe('LEFT-04 UnityConfigPanels — 서버가 더 이상 보내지 않는 필드를 읽던 분기 정리', () => {
  const render = (ex) => renderToStaticMarkup(h(UnityConfigPanels, { ex }));
  it('없는 env(UNITY_SSH_DEEP)를 안내하던 deepSkipped 분기가 없다 — 그 값만으로는 패널을 그리지 않는다', () => {
    expect(render({ deepSkipped: true })).toBe('');
  });
  it('v2.667 공용 전력 모양({watts, supplies:개수})만으로는 빈 "장비 구성 정보" 머리를 그리지 않는다', () => {
    expect(render({ power: { watts: 400, read: 2, supplies: 2, scope: 'dpe', basis: 'input', source: 'svc_diag -s spinfo' } })).toBe('');
  });
  it('구성 수집 시각(configAt) 줄을 그리지 않는다(2단 수집은 v2.542 에 없어졌다)', () => {
    const t = textOf(render({ configAt: 1_700_000_000_000, configEveryMs: 21_600_000, missingCmds: { version: '버전을 읽지 못했습니다' } }));
    expect(t).toContain('장비 구성 정보');                 // 못 읽은 명령은 그대로 밝힌다(규칙 4)
    expect(t).not.toContain('구성 수집 시각');
    expect(t).not.toContain('직전 수집분을 재사용');
  });
  it('옛 svc_diag 전력 모양은 그대로 그린다(구버전 스냅샷 호환)', () => {
    const t = textOf(render({ power: { totalWatts: 330, readWatts: 2, supplies: [{ name: 'ps0', watts: 165 }, { name: 'ps1', watts: 165 }] } }));
    expect(t).toContain('입력 전력');
    expect(t).toContain('330W');
  });
  it('소스에 없어진 필드를 읽는 코드가 남아 있지 않다(주석 제외)', () => {
    const s = src('views/tools/UnityConfigPanels.jsx');
    for (const k of ['deepSkipped', 'configAt', 'configEveryMs', 'configRound', 'hwNote', 'UNITY_SSH_DEEP']) expect(s, k).not.toContain(k);
  });
});
