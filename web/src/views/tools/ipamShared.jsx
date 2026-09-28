// ipamShared.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
// v2.639: IP관리 화면들이 각자 들고 있던 공용 조각(Frame · LOCAL_AGENT · agentLabel · fmtDt · fmtDur)을 여기로 모았다.
import React from 'react';
import { Modal } from '../../components/ui.jsx';
import { fmtTime } from '../../util/fmt.js';
import { agentText, durationText } from './ipamScanLogText.js';

/** 이 포탈(중앙)에서 직접 스캔하는 에이전트 이름 — 서버 ipam/scan.js LOCAL 과 같은 값. */
export const LOCAL_AGENT = '__local__';

/**
 * v2.639(U3): 에이전트 이름 표시 — `__local__`(빈 값 포함)은 '이 포탈'. 예전에는 같은 삼항이 6곳에 복사돼 있었다.
 * 판정은 ipamScanLogText.agentText 하나(스캔 로그 화면과 같은 글자).
 */
export const agentLabel = (a) => agentText(a);

/**
 * v2.639(U7): 시각·소요 포매터 한 벌. 예전에는 4곳(IpamCore IpHistoryModal · ScanStatusModal · IpamRanges · IpamNetMap)이
 * 각자 다른 형식이었다 — 시각은 `toLocaleString()`(브라우저 로케일)·'ko-KR'·월/일 시:분 짧은 형식이 섞였고,
 * 소요는 '분' 단위(IpHistoryModal)·'초' 반올림(ScanStatusModal)·소수 초(IpamRanges)로 갈렸다.
 *  · fmtDt: 날짜+시각 전체('ko-KR', util/fmt.fmtTime 하나를 쓴다) — 정보가 가장 많은 쪽.
 *  · fmtDur: ms → '850ms' · '1.5초' · '2분 3초' · '3시간 5분' · '2일 4시간' — 1시간 미만은 스캔 로그의 durationText 와
 *    글자가 같고(한 벌), 그 이상은 시간·일 단위를 더한다(IpHistoryModal 의 긴 구간). 못 읽은 값은 '—'.
 */
export const fmtDt = (t) => fmtTime(t);
export function fmtDur(ms) {
  if (ms == null || ms === '') return '—';
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '—';
  const HOUR = 3_600_000; const DAY = 86_400_000;
  if (n < HOUR) return durationText(n);
  if (n < DAY) return `${Math.floor(n / HOUR)}시간 ${Math.floor((n % HOUR) / 60_000)}분`;
  return `${Math.floor(n / DAY)}일 ${Math.floor((n % DAY) / HOUR)}시간`;
}

/**
 * v2.636: 모달 또는 페이지로 그린다. IP관리 서브메뉴는 `asPage` 로 쓴다 — 예전 모달은 대장 화면 안에 있어서 대장을 다시 읽는
 * 순간(`if (loading) return <Loading />`) 함께 언마운트되어 입력이 사라졌다.
 */
export function Frame({ asPage, title, onClose, children, ...modal }) {
  if (asPage) {
    return (
      <div className="card ipam-page" style={{ padding: 14, minWidth: 0 }}>
        <b style={{ fontSize: 15, display: 'block', marginBottom: 8 }}>{title}</b>
        {children}
      </div>
    );
  }
  return <Modal title={title} onClose={onClose} {...modal}>{children}</Modal>;
}

/**
 * v2.639(I3): 관리자 전용 쓰기 버튼의 잠금 판정(순수). access 는 IpamCore 가 `/admin/ipam/settings` 로 판정한 값 —
 * 'no'(403) 일 때만 잠근다. 'unknown'(아직 모름·네트워크 오류)은 잠그지 않는다 — 서버가 집행한다(모름을 없음으로 읽지 않는다).
 * @returns {{ locked: boolean, title: string|undefined, note: string|null }}
 */
export function adminWriteGate(access) {
  if (access === 'no') {
    return { locked: true, title: '관리자만 바꿀 수 있습니다', note: '이 계정은 관리자가 아니라 저장·삭제·CSV 가져오기·스캔 실행이 잠겨 있습니다(서버가 관리자 계정에만 엽니다). 조회는 그대로 됩니다.' };
  }
  return { locked: false, title: undefined, note: null };
}

// IP 확인 출처 배지: vCenter 인식 / Ping(TCP)스캔 / 둘 다
const DISCOVERY = { vcenter: ['vCenter', 'blue'], scan: ['Ping스캔', 'teal'], both: ['vCenter+스캔', 'green'], manual: ['수동등록', 'purple'] };
export function DiscoveryBadge({ d }) {
  const m = DISCOVERY[d];
  if (!m) return <span className="muted">—</span>;
  const tip = d === 'both' ? 'vCenter 인벤토리 + 능동 스캔 양쪽에서 확인' : d === 'scan' ? '능동 스캔(Ping/TCP)으로만 확인'
    : d === 'manual' ? '운영자가 직접 등록한 IP(자동 발견 없음)' : 'vCenter 인벤토리에서 확인';
  return <span className={`badge ${m[1]}`} title={tip}>{m[0]}</span>;
}

// IP 수동 관리상태(override) 라벨/색 — 백엔드 overrides.js STATUSES와 일치.
export const MGMT = {
  active: ['사용중(확정)', 'green'], reserved: ['예약', 'blue'], deprecated: ['폐기예정', 'gray'],
  dhcp: ['DHCP', 'amber'], static: ['고정할당', 'teal'], ignored: ['숨김', 'gray'],
};
export function MgmtBadge({ s }) {
  const m = MGMT[s];
  if (!m) return null;
  return <span className={`badge ${m[1]}`} title="운영자가 지정한 IP 관리상태">{m[0]}</span>;
}
export const DEVTYPE_LABEL = {
  vm: 'VM', host: 'ESXi', switch: '스위치', router: '라우터', firewall: '방화벽', storage: '스토리지',
  idrac: 'iDRAC', printer: '프린터', server: '서버', loadbalancer: 'LB', appliance: '어플라이언스', other: '기타',
};
