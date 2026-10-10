// v2.731 점검 1회차 그룹 G2a — 화면 배선(A3-01 비밀 폐기 안내 · A4-03 엣지 IP 스캔 주기 문구).
// 서버 응답 → 문구 변환은 server/test/audit2731g2a.test.js 가 실제 라우터 응답에 droppedSecretText 를 적용해 본다.
// 여기서는 그 문구를 화면이 실제로 보여 주는지(모달을 닫아 안내를 지우지 않는지)를 소스로 고정한다 — 상태가 있는 화면이라
// renderToStaticMarkup 으로는 저장 뒤 상태를 만들 수 없다(정직 기록: 브라우저 확인은 리드 몫).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../test/_stripComments.js';
import { droppedSecretNote, passwordDroppedLines } from './droppedSecretText.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => stripComments(fs.readFileSync(path.join(here, rel), 'utf8'));

describe('A3-01 ① 업그레이드 설정 — 토큰 폐기 안내', () => {
  it('저장 응답의 droppedSecrets 를 문구로 바꾸고 성공(초록) 대신 그 문구를 보인다', () => {
    const s = src('Upgrade.jsx');
    expect(s).toMatch(/import \{ droppedSecretNote \} from '\.\/droppedSecretText\.js'/);
    expect(s).toMatch(/note: droppedSecretNote\(r\)/);
    expect(s).toMatch(/msg\.r\.ok && msg\.r\.note \? msg\.r\.note/);
    // 400 본문의 reason 도 싣는다(putJson 은 400 을 던지지 않는다) — 예전에는 '실패' 한 단어였다.
    expect(s).toMatch(/reason: r\.reason/);
  });
  it('주소를 바꾸고 토큰을 비우면 저장 전에 폐기를 미리 말한다', () => {
    const s = src('Upgrade.jsx');
    expect(s).toMatch(/const tokenWillDrop = !!status\.hasToken && !form\.token && baseKey\(form\.remoteBase\) !== baseKey\(status\.remoteBase\)/);
    expect(s).toMatch(/tokenWillDrop \? '주소를 바꾸면 저장된 토큰은 폐기됩니다'/);
    expect(s).not.toMatch(/\/\\\/\+\$\//); // 끝 슬래시 정규식(O(n²)) 금지 — 루프로 자른다
  });
  it('서버 응답 모양 → 문구(token)', () => {
    const r = { ok: true, droppedSecrets: ['token'], skipped: [{ field: 'token', reason: '원격 소스 주소가 바뀌어 저장된 토큰을 폐기했습니다.' }] };
    expect(droppedSecretNote(r)).toBe('저장했습니다 — 단 원격 소스 주소가 바뀌어 저장된 토큰을 폐기했습니다.');
    expect(droppedSecretNote({ ok: true })).toBe('');
  });
});

describe('A3-01 ② 에이전트 작업(위임 IP 스캔 할당) — 비밀번호 폐기 안내', () => {
  it('수정 저장이 비밀번호를 폐기하면 창을 닫지 않고 안내를 보인다', () => {
    const s = src('AgentScans.jsx');
    expect(s).toMatch(/import \{ droppedSecretNote, passwordDroppedLines \} from '\.\/droppedSecretText\.js'/);
    expect(s).toMatch(/const note = r\.ok \? droppedSecretNote\(r\) : ''/);
    // 폐기가 있으면 close() 를 부르는 갈래보다 먼저 안내 갈래가 온다.
    const i = s.indexOf('if (r.ok && note)');
    const j = s.indexOf('else if (r.ok) { await load(); close(); }');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    expect(s).toMatch(/\(비우면 유지 — IP 대역·계정을 바꾸면 폐기\)/);
  });
  it('CSV 가져오기가 비밀번호를 폐기하면 창을 닫지 않고 줄마다 보인다', () => {
    const s = src('AgentScans.jsx');
    expect(s).toMatch(/const dropped = r\.ok \? passwordDroppedLines\(r\) : \[\]/);
    expect(s).toMatch(/if \(!dropped\.length\) \{ setCsvOpen\(false\); setCsvText\(''\); \}/);
    expect(s).toMatch(/importMsg\.dropped\.map\(/);
    const lines = passwordDroppedLines({ ok: true, passwordDropped: [{ name: 'edge-1', reason: '대역이 바뀌어 폐기했습니다.' }] });
    expect(lines).toEqual(['edge-1 — 대역이 바뀌어 폐기했습니다.']);
  });
});

describe('A4-03 IP 스캔 설정 — 원격 에이전트 주기 문구', () => {
  it('엣지가 env 주기로만 돌던 동안의 문구(\'주기 N분마다 이 설정을 읽어가\')를 쓰지 않고, 구버전 에이전트 사실을 말한다', () => {
    const s = fs.readFileSync(path.join(here, 'tools/IpScanSettings.jsx'), 'utf8');
    expect(s).not.toMatch(/주기 \$\{mins\}분마다 이 설정을 읽어가/);
    expect(s).not.toMatch(/에이전트 다음 주기/);
    expect(s).toMatch(/2\.731 이전 에이전트는/);
    expect(s).toMatch(/‘AGENT_SCAN_INTERVAL_MS’/);
  });
});
