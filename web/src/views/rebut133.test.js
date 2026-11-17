/**
 * 전체 점검 133회차 — 128회차(leftover128) 수정 반증 + 128회차가 추정으로 남긴 후보(화면 쪽 순수 판정).
 *  R1 패키지 저장소 설정 폼 잠금: 지금 조회의 표지만 보면, ‘다시 확인’ 이 한 번 실패해 조회가 비는 순간 못 읽은 동안의 빈 폼의 저장이 열린다 → 폼을 채운 조회의 표지로.
 *  E1 사용 기록 수집 설정 · E2 PDU 임계치 창: 못 읽은 동안의 기본값 폼 · 창의 저장을 잠근다(112회차 규약 — saveLockedByUnread · staleSeedLock).
 *  E4 같은 등록부를 쓰는 다른 화면의 빈 목록 문구.
 *  C  128 이 열지 못한 호출부(IP 관리 CSV 검증 · IP 스캔 대역 CSV) + 128 의 F16 · F17(디스크 점검 작업 · PDU CSV)을 실제 서버 본문 모양으로 재현.
 */
import { describe, it, expect } from 'vitest';
import { pkgFormUnread, pkgFormFromResponse, pkgSavePayload } from './pkgSettingsText.js';
import { unreadMarkOf, unreadKind, saveLockedByUnread, shouldReseed, staleSeedLock, registryEmptyText, settingsUnreadNote } from './settingsUnread.js';
import { requireChanged, changeFailText } from './changeResult.js';
import { mergeManageReports } from './tools/ipamCsvChunk.js';
import { manageSummaryText, applicableCount, rangeSummaryText } from './tools/ipamCsvText.js';

// 서버가 주는 표지 모양 그대로(routes/settingsUnreadMark.js unreadMark · util/registryCore.js makeLoadError.read)
const READ = { readError: true, code: 'EISDIR', reason: '설정 파일을 읽지 못했습니다(EISDIR) — 읽기 오류이고 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(30초마다 다시 읽습니다)' };
const USAGE_READ = { at: 1, reason: '읽기 오류(EISDIR) — 손상이 아니라 원본은 그대로 둡니다', readError: true, code: 'EISDIR' };
const USAGE_CORRUPT = { at: 1, reason: 'Unexpected token } in JSON at position 3' };

describe('133회차 R1 — 패키지 저장소 설정 폼: 잠금은 폼을 채운 조회의 표지를 본다', () => {
  // 화면(AgentDeploy.jsx)의 상태 전이를 그대로 따라간다: 조회 성공 = pkg · 폼 · seedLe 를 함께 바꾼다 / 조회 실패 = pkg 만 null.
  const step = (state, resp) => (resp ? { pkg: resp, form: pkgFormFromResponse(resp), seedLe: unreadMarkOf(resp) } : { ...state, pkg: null });
  const locked = (s) => saveLockedByUnread(pkgFormUnread(s.pkg, s.seedLe));
  const UNREAD = { baseUrl: 'https://env.example/dl', dir: '/opt/pkgs', settings: { baseUrl: 'https://env.example/dl', dir: '/opt/pkgs', overridden: { baseUrl: false, dir: false } }, loadError: READ };
  const GOOD = { baseUrl: 'https://mirror.corp/dl', dir: '/data/pkgs', settings: { baseUrl: 'https://mirror.corp/dl', dir: '/data/pkgs', overridden: { baseUrl: true, dir: true } } };

  it('못 읽은 동안의 조회로 채운 폼은 잠긴다 · 그 폼은 빈 칸 둘(= 지정 해제)을 보낸다', () => {
    const s = step(null, UNREAD);
    expect(locked(s)).toBe(true);
    expect(pkgSavePayload(s.form)).toEqual({ baseUrl: '', dir: '' });   // 이 본문이 다시 읽힌 서버에 닿으면 웹 지정 주소 · 경로가 지워진다
  });

  it('다시 조회가 실패해 조회가 비어도(pkg = null) 폼은 그대로다 — 잠금이 풀리지 않는다(128회차는 여기서 풀렸다)', () => {
    const s = step(step(null, UNREAD), null);
    expect(s.pkg).toBeNull();
    expect(pkgSavePayload(s.form)).toEqual({ baseUrl: '', dir: '' });
    expect(saveLockedByUnread(unreadMarkOf(s.pkg))).toBe(false);   // 128회차 판정(지금 조회만) — 저장이 열렸다
    expect(locked(s)).toBe(true);
    expect(pkgFormUnread(s.pkg, s.seedLe)).toBe(READ);             // 배너도 그 표지로 남는다(‘다시 확인’ 이 길이다)
  });

  it('다시 읽힌 조회가 오면 폼을 저장값으로 다시 채우고 잠금이 풀린다 · 그 뒤의 조회 실패는 잠그지 않는다(폼은 읽은 값이다)', () => {
    let s = step(step(step(null, UNREAD), null), GOOD);
    expect(locked(s)).toBe(false);
    expect(pkgSavePayload(s.form)).toEqual({ baseUrl: 'https://mirror.corp/dl', dir: '/data/pkgs' });
    s = step(s, null);
    expect(locked(s)).toBe(false);
  });

  it('처음부터 조회가 없거나(null) 표지가 없으면 잠그지 않는다 · 표지 아닌 값(글자)은 표지로 읽지 않는다', () => {
    expect(pkgFormUnread(null, null)).toBeNull();
    expect(pkgFormUnread(GOOD, null)).toBeNull();
    expect(pkgFormUnread(null, '읽기 오류')).toBeNull();
    expect(pkgFormUnread(GOOD, READ)).toBeNull();   // 지금 조회가 읽혔으면 그 조회가 기준이다
  });
});

describe('133회차 E1 — 사용 기록 수집 설정: 읽기 오류 동안 저장을 잠근다', () => {
  it('서버 표지(loadError — readError)가 있으면 잠근다 · 손상은 저장이 푸는 규약이라 잠그지 않는다 · 읽혔으면 잠그지 않는다', () => {
    expect(saveLockedByUnread(unreadMarkOf({ settings: {}, loadError: USAGE_READ }))).toBe(true);
    expect(saveLockedByUnread(unreadMarkOf({ settings: {}, loadError: USAGE_CORRUPT }))).toBe(false);
    expect(saveLockedByUnread(unreadMarkOf({ settings: {}, loadError: null }))).toBe(false);
  });
});

describe('133회차 E2 — PDU 임계치 창: 못 읽은 동안 연 창은 다시 읽힌 뒤에도 잠근다', () => {
  it('열 때 읽기 오류 → 지금도 읽기 오류: 잠금 · 다시 읽힌 뒤: 여전히 잠금(창은 폼을 다시 채우지 않는다) · 닫고 다시 열면 풀린다', () => {
    const opened = unreadKind(READ);
    expect(staleSeedLock(opened, READ, { what: 'PDU 임계치' })).toContain('읽지 못한 상태라 저장을 잠급니다');
    const after = staleSeedLock(opened, null, { what: 'PDU 임계치' });
    expect(after).toContain('읽지 못한 동안 연 창입니다');
    expect(after).toContain('창을 닫고 다시 열면 저장된 값이 보입니다');
    expect(after).not.toContain('`');
    expect(staleSeedLock(unreadKind(null), null, { what: 'PDU 임계치' })).toBe('');   // 다시 연 창
  });

  it('읽힌 동안 연 창은 잠그지 않는다 · 열려 있는 동안 읽기 오류가 되면 잠근다', () => {
    expect(staleSeedLock('', null, { what: 'PDU 임계치' })).toBe('');
    expect(staleSeedLock('', READ, { what: 'PDU 임계치' })).not.toBe('');
  });

  it('폼을 다시 채우는 화면의 판정(shouldReseed)은 그대로다 — 창에는 쓰지 않는다(창은 잠근다)', () => {
    expect(shouldReseed('read', null)).toBe(true);
    expect(shouldReseed('', READ)).toBe(false);
    expect(settingsUnreadNote(READ, { what: '사용 기록 수집 설정', save: '저장' })).toContain('‘저장’ 을 잠급니다');
  });
});

describe('133회차 E4 — 같은 등록부를 쓰는 다른 화면의 빈 목록 문구', () => {
  it('표지가 있으면 ‘등록된 … 없습니다’ 대신 못 읽었다고 말한다 · 없으면 평소 문구를 쓴다', () => {
    const t = registryEmptyText(unreadMarkOf({ devices: [], loadError: READ }), 'SAN 스위치 등록부');
    expect(t).toBe('SAN 스위치 등록부를 읽지 못했습니다 — 목록이 비어 보여도 등록이 없는 것이 아닙니다.');
    expect(registryEmptyText(unreadMarkOf({ managers: [], loadError: { reason: '등록부 파일을 읽지 못했습니다(JSON 형식 오류)' } }), 'NSX Manager 등록부')).toContain('NSX Manager 등록부를 읽지 못했습니다');
    expect(registryEmptyText(unreadMarkOf({ devices: [] }), 'SAN 스위치 등록부') || '등록된 SAN 스위치가 없습니다').toBe('등록된 SAN 스위치가 없습니다');
    expect(registryEmptyText(unreadMarkOf(null), 'SAN 스위치 등록부')).toBe('');
  });
});

describe('133회차 C — postJson 이 돌려준 409 본문을 결과로 읽지 않는다', () => {
  // 서버 본문 그대로(routes/api/ipamExport.js POST /tools/ipam/manage/import — 관리상태 · 메모 파일을 못 읽는 동안)
  const MANAGE_409 = { ok: false, code: 'settings-unreadable', reason: 'IP 관리상태 · 메모 파일을 읽지 못한 상태라 판정하지 않았습니다', loadError: { reason: '읽기 오류', at: 1, readError: true } };
  const SCAN_409 = { ok: false, code: 'settings-unreadable', readError: true, reason: '읽기 오류(EISDIR) — 손상이 아니라 원본은 그대로 둡니다' };

  it('IP 관리 CSV 검증(dryRun): 수정 전 — 409 본문을 결과로 합치면 사유 없이 ‘0 · 0 · 0’ 이고 적용할 것이 없다고만 보인다', () => {
    const m = mergeManageReports([MANAGE_409]);
    expect(m.report).toEqual([]);
    expect(manageSummaryText(m.summary, { total: 37, chunks: 1 })).toBe('데이터 37행 · 새로 지정 0 · 변경 0 · 지움 0 · 변화 없음 0 · 오류 0');   // 37행을 넣었는데 전부 0 — 사유가 없다
    expect(applicableCount(m.summary)).toBe(0);
  });

  it('수정 뒤 — 판정을 거치면 사유를 던진다(화면의 catch 가 ‘검증하지 못했습니다: …’ 로 보인다) · 정상 검증 본문은 그대로 지난다', () => {
    expect(() => requireChanged(MANAGE_409)).toThrow(/읽지 못한 상태라 판정하지 않았습니다/);
    const ok = { ok: true, dryRun: true, columns: ['ip'], report: [{ line: 2, ip: '10.1.2.3', action: 'create' }], summary: { create: 1 }, total: 1 };
    expect(requireChanged(ok)).toBe(ok);
  });

  it('IP 스캔 대역 CSV: 수정 전 — 409 본문으로는 검증 결과 줄이 비고, 적용은 ‘에이전트 0곳’ 으로 읽혔다 · 수정 뒤 사유를 던진다', () => {
    expect(rangeSummaryText(SCAN_409.summary, 'replace')).toBe('');
    expect((SCAN_409.applied || []).length).toBe(0);   // 수정 전 화면 문구 ‘적용 — 에이전트 0곳’ 의 근거
    expect(() => requireChanged(SCAN_409)).toThrow(/읽기 오류\(EISDIR\)/);
    const ok = { ok: true, mode: 'replace', applied: [{ agent: 'edge-a', added: 1, removed: 0 }], blocked: [], failed: [], report: [], summary: { add: 1 }, total: 1 };
    expect(requireChanged(ok)).toBe(ok);
  });

  it('128회차 F16 재현 — 디스크 점검 작업 멈춤 · 다시 보내기: 409 본문에는 job 이 없다(수정 전에는 목록에 undefined 가 들어갔다)', () => {
    const jobs = [{ id: 'j1' }, { id: 'j2' }];
    const j = jobs[0];
    const BUSY_409 = { ok: false, reason: '이 법인에 진행 중인 다른 점검이 있습니다.' };
    const EDGE_409 = { ok: false, error: 'edge-node', reason: '엣지 노드에서는 쓸 수 없습니다.' };
    expect(jobs.map((x) => (x.id === j.id ? BUSY_409.job : x))[0]).toBeUndefined();   // 수정 전 식 — 다음 렌더의 j.id 에서 던진다
    // 수정 뒤 식: requireChanged(r); if (r?.job) setJobs(...)
    for (const body of [BUSY_409, EDGE_409]) expect(() => requireChanged(body)).toThrow(body.reason);
    const stopped = { ok: true, job: { id: 'j1', state: 'stopped' } };
    expect(requireChanged(stopped).job.state).toBe('stopped');
    expect(changeFailText({ ok: true, job: null })).toBeNull();   // 멈출 조각이 없던 응답 — 성공이고 목록은 건드리지 않는다(r?.job 가드)
  });

  it('128회차 F17 재현 — PDU CSV 가져오기: 409 본문(등록부 읽기 오류)에는 failed 가 없다 → 사유를 실패 줄로 싣는다 · 정상 본문은 그대로', () => {
    const shape = (r) => (r?.ok === false && !Array.isArray(r.failed) ? { ...r, failed: [r.reason || '가져오지 못했습니다(사유 미상).'] } : r);   // 화면 식 그대로
    const REG_409 = { ok: false, code: 'registry-unreadable', status: 409, readError: true, reason: 'PDU 등록부(pdu-devices.json)를 읽지 못한 상태라 저장하지 않았습니다' };
    expect((REG_409.failed || []).length).toBe(0);   // 수정 전: ‘추가 0 · 수정 0’ 만 보이고 사유가 없다
    expect(shape(REG_409).failed).toEqual([REG_409.reason]);
    expect(shape({ ok: false }).failed).toEqual(['가져오지 못했습니다(사유 미상).']);
    const ok = { ok: true, added: 2, updated: 1, failed: ['3행(10.0.0.9): 형식 오류'], total: 4 };
    expect(shape(ok)).toBe(ok);
  });
});
