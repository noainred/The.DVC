/**
 * audit2613b.test.js — v2.613 아키텍처 점검 수정 그룹 G2(웹 공용 모듈·화면 규약) 회귀 고정.
 *
 * 소스 스윕(node 환경 — 렌더 불가)과 순수 함수 대조. 주석은 먼저 지운다(주석 속 설명이 통과 근거가 되지 않게 —
 * v2.535 규약). 허용 목록은 **사유와 함께** 열거한다 — `length >= N` 식 검사는 '추가를 잊은 것' 을 잡지 못한다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fmtBytes, fmtAgo } from '../util/fmt.js';
import { agoText, elapsedText } from './tools/relTime.js';
import { toneVar } from './tools/toneVar.js';
import { toneVar as bmTone } from './tools/bmUsageText.js';
import { toneVar as edgeTone } from './tools/edgeLogText.js';
import { toneVar as partTone } from './tools/partFaultText.js';
import { fmtBytes as vmFmtBytes } from './vmSeriesText.js';
import { bytesText as sanBytesText } from './tools/sanSwitchPerfText.js';
import { ago as rmaAgo } from './tools/remoteCommand.js';
import { ago as perfAgo } from './perfMonitorText.js';

const VIEWS = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(VIEWS, '..');

/** 주석만 지우고 **개행은 보존**한다(줄 번호가 밀리지 않게 — v2.574 규약). */
function stripComments(s) {
  let out = ''; let i = 0;
  const N = s.length;
  while (i < N) {
    const c = s[i]; const d = s[i + 1];
    if (c === '/' && d === '*') { const e = s.indexOf('*/', i + 2); const seg = s.slice(i, e < 0 ? N : e + 2); out += seg.replace(/[^\n]/g, ''); i = e < 0 ? N : e + 2; continue; }
    if (c === '/' && d === '/') { const e = s.indexOf('\n', i); const seg = s.slice(i, e < 0 ? N : e); out += seg.replace(/[^\n]/g, ''); i = e < 0 ? N : e; continue; }
    out += c; i += 1;
  }
  return out;
}
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(js|jsx)$/.test(e.name) && !/\.test\.(js|jsx)$/.test(e.name)) acc.push(p);
  }
  return acc;
}
const VIEW_FILES = walk(VIEWS);
const rel = (f) => path.relative(SRC, f).split(path.sep).join('/');
const code = (f) => stripComments(fs.readFileSync(f, 'utf8'));
const hitsOf = (re) => {
  const out = [];
  for (const f of VIEW_FILES) {
    const body = code(f);
    const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m;
    while ((m = r.exec(body))) out.push({ file: rel(f), line: body.slice(0, m.index).split('\n').length, text: m[0] });
  }
  return out;
};

describe('WEB2613-01 화면이 /auth/me 를 다시 부르지 않는다 — 역할은 api.hasRole(현재 사용자 객체) 하나', () => {
  // SpecialTools.jsx 도 v2.613 통합 시 hasRole + getCurrentUser().serviceHubUrl 로 옮겼다(허용 목록 0).
  const ALLOW = new Map([]);
  it('views/** 에서 fetchJson(\'/auth/me\') 호출이 허용 목록 밖 0건', () => {
    const bad = hitsOf(/fetchJson\(\s*'\/auth\/me'/).filter((h) => !ALLOW.has(h.file)).map((h) => `${h.file}:${h.line}`);
    expect(bad).toEqual([]);
  });
  it('허용 목록의 항목은 실재한다(사라지면 목록에서 뺀다)', () => {
    for (const f of ALLOW.keys()) expect(code(path.join(SRC, f))).toMatch(/fetchJson\(\s*'\/auth\/me'/);
  });
  it('api.js 가 hasRole 을 export 하고, 옮긴 화면 9곳이 그것을 쓴다(useState+useEffect 사본 0)', () => {
    expect(code(path.join(SRC, 'api.js'))).toMatch(/export const hasRole = \(\.\.\.roles\)/);
    const moved = ['views/NetworkCheck.jsx', 'views/VcenterPorts.jsx', 'views/Alarms.jsx', 'views/tools/VmInfoTools.jsx', 'views/tools/GuestDiskReport.jsx',
      'views/tools/HorizonSessionSettings.jsx', 'views/tools/CurrentUsersSettings.jsx', 'views/tools/IpamCore.jsx', 'views/PingMonitor.jsx'];
    for (const f of moved) {
      const s = code(path.join(SRC, f));
      expect(s, f).toMatch(/hasRole\('admin'(, 'operator')?\)/);
      expect(s, f).not.toMatch(/setIsAdmin\(|setCanManage\(/);
    }
  });
});

describe('WEB2613-03 바이트 표기는 util/fmt.fmtBytes 하나 — 읽지 못한 값은 — (0 B 가 아니다)', () => {
  // 지운 사본 세 벌(원문 그대로) — 숫자 입력에서는 같은 단위·같은 값이어야 하고, 결측에서 갈라지던 것(0 B)이 이 수정의 이유다.
  const oldVmSeries = (b) => { const n = Number(b) || 0; const GB = 1024 ** 3; const MB = 1024 ** 2; if (n >= GB) return `${(n / GB).toFixed(2)} GB`; if (n >= MB) return `${(n / MB).toFixed(1)} MB`; if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`; return `${n} B`; };
  const oldSan = (b) => { const n = Number(b) || 0; if (n < 1024) return `${n} B`; if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`; if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`; return `${(n / 1024 ** 3).toFixed(2)} GB`; };
  const oldMetrics = (b) => { if (!b) return '0'; const GB = 1024 ** 3; const MB = 1024 ** 2; return b >= GB ? `${(b / GB).toFixed(2)} GB` : b >= MB ? `${(b / MB).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`; };
  const parse = (s) => { const m = /^([\d.]+) (B|KB|MB|GB)$/.exec(s); return m ? { v: Number(m[1]), u: m[2] } : null; };
  const INPUTS = [0, 1, 512, 1023, 1024, 1536, 10 * 1024, 1024 ** 2, 3.5 * 1024 ** 2, 1024 ** 3, 5.25 * 1024 ** 3, 9 * 1024 ** 4];
  it('숫자 입력 — 지운 사본과 같은 단위·같은 값(소수 자릿수만 코어 규칙 1자리)', () => {
    for (const n of INPUTS) {
      const now = parse(fmtBytes(n));
      expect(now, `fmtBytes(${n})`).not.toBeNull();
      for (const [name, old] of [['vmSeriesText', oldVmSeries], ['sanSwitchPerfText', oldSan], ['MetricsSettings', oldMetrics]]) {
        const o = parse(old(n));
        if (!o || (name === 'MetricsSettings' && n < 1024)) continue; // MetricsSettings 사본은 B 단위가 없어 1KB 미만을 '0 KB' 로 냈다(그것도 결함) — 비교 대상 밖
        expect(o.u, `${name}(${n}) 단위`).toBe(now.u);
        expect(Math.abs(o.v - now.v), `${name}(${n}) 값`).toBeLessThanOrEqual(0.5); // vmSeries 의 KB 는 정수 반올림이었다(1536 → '2 KB')
      }
    }
  });
  it('결측·비수치 — 사본은 0 B/0 이었고 코어는 —', () => {
    for (const v of [null, undefined, '', 'abc', NaN, [], {}]) {
      expect(fmtBytes(v), String(v)).toBe('—');
      expect(vmFmtBytes(v), `vmSeriesText(${String(v)})`).toBe('—');
      expect(sanBytesText(v), `sanSwitchPerfText(${String(v)})`).toBe('—');
    }
    expect(oldVmSeries(null)).toBe('0 B'); expect(oldSan(null)).toBe('0 B'); expect(oldMetrics(null)).toBe('0'); // 결함의 재현(문서화)
    expect(fmtBytes(0)).toBe('0 B'); // 0 은 값이다
    expect(fmtBytes(null, { dash: '없음' })).toBe('없음');
  });
  it('세 모듈이 같은 함수다(재수출 · 로컬 본문 0)', () => {
    expect(vmFmtBytes).toBe(fmtBytes);
    expect(sanBytesText).toBe(fmtBytes);
    expect(code(path.join(SRC, 'views/vmSeriesText.js'))).toMatch(/import \{ fmtBytes \} from '\.\.\/util\/fmt\.js'/);
    expect(code(path.join(SRC, 'views/tools/sanSwitchPerfText.js'))).toMatch(/import \{ fmtBytes \} from '\.\.\/\.\.\/util\/fmt\.js'/);
    const ms = code(path.join(SRC, 'views/MetricsSettings.jsx'));
    expect(ms).not.toMatch(/const fmtBytes = /);
    expect(ms).toMatch(/import \{ fmtAgo, fmtBytes \} from '\.\.\/util\/fmt\.js'/);
  });
});

describe('WEB2613-08 IP관리 탭은 허브(SpecialTools.jsx)를 경유하지 않고 IpamCore.jsx 를 직접 lazy 한다', () => {
  it('App.jsx', () => {
    const s = code(path.join(SRC, 'App.jsx'));
    expect(s).toMatch(/lazy\(\(\) => import\('\.\/views\/tools\/IpamCore\.jsx'\)\.then\(\(m\) => \(\{ default: m\.IpamStandalone \}\)\)\)/);
    expect(s).not.toMatch(/import\('\.\/views\/SpecialTools\.jsx'\)\.then\(\(m\) => \(\{ default: m\.IpamStandalone/);
  });
});

describe('WEB2613-09 폴링은 usePolling — RemoteCommand·PduTool 의 수제 setInterval 0', () => {
  // 나머지 수제 폴러는 후속(SPLIT) — 사유와 함께 열거한다. 여기서 빠진 새 파일에 setInterval 폴러가 생기면 실패한다.
  const FOLLOW_UP = new Map([
    ['views/tools/VmCloneTool.jsx', '10초 load — 후속'], ['views/tools/IpamSettings.jsx', '2초 진행 표시(deniedRef 로 403 정지 있음) — 대상 아님'],
    ['views/tools/BmStorageTool.jsx', '후속'], ['views/tools/StorageTrackTool.jsx', '후속'], ['views/tools/HardwareTools.jsx', '후속(:687 NIC 표)'],
    ['views/tools/IpamNet.jsx', '3초 스캔 상태(statusDenied 로 403 정지 있음)'], ['views/tools/CapacityTools.jsx', '내보내기 경과초 표시(네트워크 아님)'],
    ['views/tools/SanSwitchTool.jsx', 'G1 담당 파일 — 후속'], ['views/tools/ShutdownTool.jsx', '후속'], ['views/tools/StorageMonTool.jsx', '후속'],
    ['views/tools/DirUsageReport.jsx', '후속'], ['views/tools/RelayCheckTool.jsx', '후속'],
  ]);
  it('views/tools/** 의 setInterval( 은 후속 목록 안에만 있다', () => {
    const bad = hitsOf(/\bsetInterval\(/).filter((h) => h.file.startsWith('views/tools/') && !FOLLOW_UP.has(h.file)).map((h) => `${h.file}:${h.line}`);
    expect(bad).toEqual([]);
  });
  it('RemoteCommand·PduTool 은 usePolling 이고 _r 카운터로 즉시 재조회한다', () => {
    const rc = code(path.join(SRC, 'views/tools/RemoteCommand.jsx'));
    expect(rc).toMatch(/usePolling\('\/tools\/rma\/history', \{ limit: 100, _r: refreshTick \}, 15_000\)/);
    expect(rc).not.toMatch(/fetchJson\('\/tools\/rma\/history'/);
    const pdu = code(path.join(SRC, 'views/tools/PduTool.jsx'));
    expect(pdu).toMatch(/usePolling\('\/tools\/pdu', \{ _r: rev \}, 30_000\)/);
    expect(pdu).not.toMatch(/fetchJson\('\/tools\/pdu'\)/);
  });
});

describe('WEB2613-10 views/** 에서 api.js 를 우회한 직접 fetch( 0건', () => {
  it('\\bfetch( 0건(fetchJson 등은 대상이 아니다)', () => {
    const bad = hitsOf(/(?<![A-Za-z0-9_$.])fetch\(/).map((h) => `${h.file}:${h.line}`);
    expect(bad).toEqual([]);
  });
  it('옮긴 곳이 delJson/downloadFile 을 쓴다', () => {
    expect(code(path.join(SRC, 'views/tools/IpamNet.jsx'))).toMatch(/delJson\(`\/admin\/ipam\/vc-ranges\//);
    expect(code(path.join(SRC, 'views/tools/IpamSettings.jsx'))).toMatch(/delJson\(`\/tools\/ipam\/ip\//);
    expect(code(path.join(SRC, 'views/tools/GpuTool.jsx'))).toMatch(/downloadFile\(`\/tools\/gpu\/export\./);
    expect(code(path.join(SRC, 'views/PortalBackup.jsx'))).toMatch(/downloadFile\(`\/admin\/backup\/download\//);
    expect(code(path.join(SRC, 'views/DavinciChecks.jsx'))).toMatch(/downloadFile\(`\/tools\/vmware-config\?download=1/);
  });
});

describe('WEB2613-12 온도 임계 숫자는 board.js 만 갖는다', () => {
  it('sensorText.js 가 TEMP_WARN_C/TEMP_HOT_C 를 import 하고 40/32 리터럴이 없다', () => {
    const s = code(path.join(SRC, 'views/idrac/sensorText.js'));
    expect(s).toMatch(/import \{ TEMP_WARN_C, TEMP_HOT_C \} from '\.\.\/tools\/serverTemp\/board\.js'/);
    expect(s).not.toMatch(/>= 40 \?|>= 32 \?/);
  });
  it('web/src 전체에서 `>= 40 ?`·`>= 32 ?` 온도 리터럴 0건(board.js 는 상수 선언이라 해당 없음)', () => {
    const bad = hitsOf(/>= (40|32) \?/).filter((h) => h.file !== 'views/tools/HardwareTools.jsx' /* :884 의 32 는 Gbps */).map((h) => `${h.file}:${h.line}`);
    expect(bad).toEqual([]);
  });
});

describe('DEPS2613-11 상대시각·톤 색은 공용 코어(relTime·util/fmt·toneVar) 하나 — 로컬 구현 사본 0', () => {
  // SanSwitchTool(껍데기로)·PortalCheck(죽은 사본 삭제)도 v2.613 통합 시 정리했다(허용 목록 0).
  const ALLOW = new Map([]);
  const DEF = /^(?:export )?(?:const|function) (ago|fmtAgo|toneVar)\b[^\n]*/;
  it('정의는 코어에 위임하는 한 줄 껍데기뿐(자체 구현 — Date.now 산술·단위 문구 — 0)', () => {
    const bad = [];
    for (const h of hitsOf(new RegExp(DEF.source, 'm'))) {
      if (ALLOW.has(h.file)) continue;
      if (h.file === 'views/tools/toneVar.js') continue; // 코어 자신
      const delegates = /agoText\(|elapsedText\(|fmtAgo\(/.test(h.text);
      if (!delegates) bad.push(`${h.file}:${h.line} ${h.text.slice(0, 60)}`);
    }
    expect(bad).toEqual([]);
  });
  it('허용 목록의 항목은 실재한다', () => {
    for (const f of ALLOW.keys()) expect(code(path.join(SRC, f))).toMatch(/^const ago = /m);
  });
  it('toneVar 는 세 문구 모듈이 같은 함수이고 테마 토큰을 낸다', () => {
    expect(bmTone).toBe(toneVar); expect(edgeTone).toBe(toneVar); expect(partTone).toBe(toneVar);
    expect(toneVar('ok')).toBe('var(--green)'); expect(toneVar('green')).toBe('var(--green)');
    expect(toneVar('warn')).toBe('var(--amber)'); expect(toneVar('bad')).toBe('var(--red)');
    expect(toneVar('muted')).toBe('var(--text-faint)'); expect(toneVar(undefined)).toBe('var(--text-faint)');
    const defs = hitsOf(/^export function toneVar\(/m).map((h) => h.file);
    expect(defs).toEqual(['views/tools/toneVar.js']);
  });
  it('fmtAgo(util/fmt) 는 relTime.agoText 의 껍데기 — 결측·미래·옵션이 코어 규칙', () => {
    const now = 1_700_000_000_000;
    expect(fmtAgo(0)).toBe('—'); expect(fmtAgo(null)).toBe('—'); expect(fmtAgo(null, { dash: '없음' })).toBe('없음'); expect(fmtAgo('2026-01-01T00:00:00Z')).toBe('—');
    expect(fmtAgo(Date.now() + 60_000)).toBe('방금'); // 미래(시계 오차)는 음수를 만들지 않는다
    expect(agoText(now - 90_000, now)).toBe('2분 전'); expect(agoText(now - 2 * 86_400_000, now)).toBe('2일 전');
  });
  it('subMinute 숫자 임계(remoteCommand 의 5초 미만 = 방금 계약)·perfMonitor 는 코어 그대로', () => {
    const now = 1_700_000_000_000;
    expect(rmaAgo(now - 2000, now)).toBe('방금'); expect(rmaAgo(now - 30_000, now)).toBe('30초 전'); expect(rmaAgo(null)).toBe('—');
    expect(elapsedText(4999, { subMinute: 5000 })).toBe('방금'); expect(elapsedText(5000, { subMinute: 5000 })).toBe('5초 전');
    expect(elapsedText(500)).toBe('방금'); expect(elapsedText(1500)).toBe('2초 전'); expect(elapsedText(30_000, { subMinute: '방금' })).toBe('방금');
    expect(perfAgo).toBe(agoText);
    expect(elapsedText(-5, { future: '' })).toBe(''); // collectDropText: 미래는 비운다
  });
});

describe('WEB2613-02 HardwareTools — 법인 목록(관리자 전용) 조회 실패를 삼키지 않는다', () => {
  const s = code(path.join(SRC, 'views/tools/HardwareTools.jsx'));
  it('/admin/datacenters 호출 3곳 전부 실패를 dcErr 에 담는다(빈 catch·빈 assign 폴백 0)', () => {
    const lines = s.split('\n').filter((l) => l.includes("fetchJson('/admin/datacenters')"));
    expect(lines.length).toBe(3);
    for (const l of lines) {
      expect(l).toMatch(/setDcErr\(e\)/);
      expect(l).not.toMatch(/catch\(\(\) => \{\}\)|catch\(\(\) => \(\{ datacenters: \[\], assign: \{\} \}\)\)/);
    }
  });
  it("'미지정' 라벨은 dcErr 이면 '법인 정보를 읽지 못함' 이고 안내 카드가 세 화면에 있다", () => {
    expect(s).toMatch(/dcErr \? '법인 정보를 읽지 못함' : '미지정\(법인 없음\)'/);
    expect((s.match(/<DcErrNote err=\{dcErr\} \/>/g) || []).length).toBe(3);
    expect(s).toMatch(/법인이 지정되지 않았다는 뜻이 아닙니다/);
  });
});
