/**
 * 용도 프로파일 — **rocky9-base**(OS · 설계 PROFILES §2). 파일 1개 = 프로파일 1개(§1).
 *
 * 정직 기록(PROFILES §7 ①): Rocky 9.4 의 공식 ‘정상 동작 점검’ 항목은 릴리스 노트(R3)의 세 가지(업그레이드 경로 · 알려진 문제 분류 · 폐기 스트림)뿐이다.
 *   나머지는 TuneD(H1 ◐ — 튜닝 탭 상속)와 일반 관행(○)이다. SELinux · firewalld · RemoveIPC 는 GPDB 요구(G1)라 **gpdb 프로파일이 있을 때만** 본다(§2 마지막 줄).
 * ⚠ 이 단계가 실행하지 않는 점검(dnf module list · journalctl)은 ‘미수집’(notCollected)이다 — 정상으로 세지 않는다.
 * ⚠ PCP/Cockpit 전제(§2 ‘선택’) 점검은 넣지 않았다 — 설계 문서에 출처 URL 이 없다(‘RHEL 9 web console 문서(검색 발췌)’ 만 있음).
 * 튜닝: 카탈로그(tuning/catalog.js)를 그대로 상속한다 — 덮는 키가 없다.
 */
const unitsOf = (tu) => (tu?.units && Array.isArray(tu.units.list) ? tu.units.list : null);

export default Object.freeze({
  id: 'rocky9-base',
  kind: 'os',
  title: 'Rocky Linux 9',
  matchText: 'os-release ID=rocky · VERSION_ID 9.x',
  /** os-release 사실로만 판정(순수). */
  match: (f) => f?.os?.id === 'rocky' && /^9(\.|$)/.test(String(f.os.versionId || '')),
  checks: [
    {
      id: 'r9.version', title: '버전 · 업그레이드 경로', how: '/etc/os-release VERSION_ID',
      judge: ({ tu }) => (tu?.os?.versionId ? { status: 'info', value: `Rocky ${tu.os.versionId}` } : { status: 'unknown', reason: 'notRead' }),
      evidence: '“You can upgrade from Rocky Linux 9.x to Rocky Linux 9.4 by running sudo dnf -y upgrade.” 8 → 9 업그레이드 경로는 없다(새로 설치). dnf check-update 요약은 이 단계에서 실행하지 않는다.',
      sources: ['R3'], grade: '●',
    },
    {
      id: 'r9.eolStreams', title: '폐기 스트림 사용 여부', how: 'dnf module list --enabled(이 단계는 실행하지 않음)',
      judge: () => ({ status: 'notCollected', reason: 'cmdNotRun' }),
      evidence: 'Node.js 16 · .NET 7 · OpenJDK 11(2024-10 EoL) 은 더 이상 갱신되지 않는다.',
      sources: ['R3'], grade: '●',
    },
    {
      id: 'r9.knownIssues', title: '알려진 문제 분류', how: '링크만(분류 · upstream)',
      judge: () => ({ status: 'info', reason: 'linkOnly' }),
      evidence: '9.4 알려진 문제는 분류(설치 · 보안 · 커널 · 파일시스템 …)만 적고 상세는 upstream — 화면은 분류와 링크만 보여 준다.',
      sources: ['R3'], grade: '●',
    },
    {
      id: 'r9.tuned', title: 'TuneD 활성 프로파일', how: '/etc/tuned/active_profile(tuned-adm active)',
      judge: ({ tu }) => {
        if (!tu || tu.sections?.sysctl !== 'ok') return { status: 'unknown', reason: 'notRead' };
        const v = tu.sysctl?.['tuned.active_profile'];
        return v ? { status: 'ok', value: String(v) } : { status: 'warn', reason: 'tunedNone' };
      },
      evidence: '튜닝 탭 ① — TuneD 프로파일을 먼저, 그다음 개별 sysctl(H1).',
      sources: ['H1'], grade: '◐',
    },
    {
      id: 'r9.failedUnits', title: 'systemd 실패 유닛', how: 'systemctl list-units --state=failed',
      judge: ({ tu }) => {
        const f = tu?.units?.failed;
        if (typeof f !== 'number') return { status: 'unknown', reason: 'notRead' };
        return f === 0 ? { status: 'ok', value: '0' } : { status: 'warn', value: String(f) };
      },
      evidence: '공식 권고 문장 없음(일반 관행). journalctl -p err 는 이 단계에서 실행하지 않는다.',
      sources: [], grade: '○',
    },
    {
      id: 'r9.timeSync', title: '시각 동기화 데몬', how: 'running 유닛 chronyd.service · ntpd.service',
      judge: ({ tu }) => {
        const u = unitsOf(tu);
        if (!u) return { status: 'unknown', reason: 'notRead' };
        const on = u.find((x) => x === 'chronyd.service' || x === 'ntpd.service');
        if (on) return { status: 'ok', value: on };
        return tu.units.capped ? { status: 'unknown', reason: 'listCapped' } : { status: 'warn', reason: 'notRunning' };
      },
      evidence: '공식 권고 문장 없음(일반 관행) — 동기 상태(chronyc tracking)는 이 단계에서 실행하지 않는다. GPDB 는 “Synchronize system clocks” 를 요구한다(gpdb 프로파일).',
      sources: [], grade: '○',
    },
  ],
  tunings: [],
  sources: ['R3', 'H1'],
});
