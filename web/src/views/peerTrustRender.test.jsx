/**
 * 설정 › 장비 신뢰 — 렌더 스모크(서버 없이 계약 모양 응답으로 · 그룹 H). renderToStaticMarkup 이라 레이아웃은 보지 못한다(Chromium 몫).
 * 잡는 것: 런타임 예외 · React #31(객체를 글자로) · 'null'/'undefined'/'NaN' 이 화면에 새는 것 · TLS 상태를 못 읽은 경우의 안내.
 * 응답 모양은 server/src/routes/admin/peerTrust.js GET(peerTrustStatus·listPeers) + server/src/security/tlsTrust.js tlsTrustStatus() 를 따른다.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PeerTrustSettings from './PeerTrustSettings.jsx';

const h = React.createElement;
const FP = (c) => 'SHA256:' + c.repeat(43);
const TFP = Array.from({ length: 32 }, () => 'AB').join(':');
const NOW = 1_780_000_000_000;

const STATUS = {
  loadError: null,
  kinds: {
    ssh: { policy: { mode: 'observe', source: 'file', origin: 'upgrade-migration', at: NOW }, counts: { approved: 1, observed: 1, pending: 2, pendingChanged: 1, rejected: 1 } },
    tls: { policy: { mode: 'enforce', source: 'env', envKey: 'TLS_PEER_POLICY' }, counts: { approved: 0, observed: 0, pending: 1, pendingChanged: 0, rejected: 0 } },
  },
};
const PEERS = [
  { kind: 'ssh', host: 'sw1', port: 22, state: 'pending', trusted: { fp: FP('A'), state: 'approved', at: NOW, by: 'admin', algo: 'ssh-rsa' }, pending: { fp: FP('B'), reason: 'changed', at: NOW, algo: 'ssh-ed25519' }, firstSeen: NOW - 1e9, lastSeen: NOW, lastSeenCount: 4 },
  { kind: 'ssh', host: 'sw2', port: 22, state: 'pending', pending: { fp: FP('C'), reason: 'unknown', at: NOW }, firstSeen: NOW, lastSeen: NOW },
  { kind: 'ssh', host: 'sw3', port: 2222, state: 'observed', trusted: { fp: FP('D'), state: 'observed', at: NOW }, firstSeen: NOW, lastSeen: NOW, note: '교체 예정' },
  { kind: 'ssh', host: 'sw4', port: 22, state: 'approved', trusted: { fp: FP('E'), state: 'approved', at: NOW, by: 'noainred' }, firstSeen: NOW, lastSeen: null },
  { kind: 'ssh', host: 'sw5', port: 22, state: 'rejected', rejected: [{ fp: FP('F'), at: NOW, by: 'admin' }] },
  { kind: 'tls', host: 'vc1.corp', port: 443, state: 'pending', pending: { fp: TFP, reason: 'unknown', at: NOW, subject: 'vc1.corp', issuer: 'vc1.corp', validTo: 'Jan  1 00:00:00 2030 GMT' } },
];
const TLS = {
  caBundle: {
    present: true, file: '/etc/vmware-portal/tls-ca-bundle.pem', bytes: 4096, mtime: NOW, loadedAt: NOW, certs: 2, notCa: 1, expired: 1,
    errors: [{ index: 3, reason: '인증서를 읽지 못했습니다(ERR)' }], otherBlocks: 1, truncated: false,
    items: [
      { subject: 'Corp Root CA', issuer: 'Corp Root CA', validTo: 'Jan  1 00:00:00 2035 GMT', fingerprint256: TFP, ca: true, expired: false },
      { subject: 'old', issuer: 'Corp Root CA', validTo: 'Jan  1 00:00:00 2020 GMT', fingerprint256: TFP, ca: false, expired: true },
    ],
  },
  defaultRoots: { count: 146, extraEnv: false },
  peerPolicy: STATUS.kinds.tls.policy,
  subsystems: [
    { subsystem: 'vcenter', label: 'vCenter', modes: ['verify', 'insecure'], envKey: 'VCENTER_TLS_VERIFY', envRaw: 'false', unknownEnv: false, exception: true, strict: false, counts: { chain: 3, pin: 1, observed: 0, resumed: 2, insecure: 5, rejected: 1, plain: 0 }, lastRejectAt: NOW },
    { subsystem: 'cvp', label: 'CVP', modes: ['strict'], envKey: null, envRaw: null, unknownEnv: false, exception: false, strict: true, counts: { chain: 0, pin: 0, observed: 0, resumed: 0, insecure: 0, rejected: 2, plain: 0 }, lastRejectAt: null },
    { subsystem: 'idrac', label: 'iDRAC/BMC', modes: ['verify'], envKey: 'IDRAC_TLS_VERIFY', envRaw: 'maybe', unknownEnv: true, exception: false, strict: false, counts: {}, lastRejectAt: null },
  ],
  exceptions: [{ subsystem: 'vcenter', label: 'vCenter', envKey: 'VCENTER_TLS_VERIFY' }],
  recentRejects: [
    { at: NOW, subsystem: 'vcenter', host: 'vc1.corp', port: 443, reason: 'unknown', chainError: 'DEPTH_ZERO_SELF_SIGNED_CERT', fingerprint: TFP, mode: 'verify' },
    { at: NOW - 1000, subsystem: 'cvp', host: 'cvp.corp', port: 443, reason: 'chain', chainError: 'CERT_HAS_EXPIRED', fingerprint: TFP, mode: 'strict' },
    { at: NOW - 2000, subsystem: 'idrac', host: '10.0.0.9', port: 443, reason: 'no-cert', chainError: null, fingerprint: null, mode: 'verify' },
  ],
};
const DATA = { ok: true, status: STATUS, peers: PEERS, kinds: ['ssh', 'tls'], modes: ['enforce', 'observe'], tls: TLS, tlsError: null };

const noLeak = (html) => {
  expect(html).not.toMatch(/>(null|undefined|NaN)</);
  expect(html).not.toMatch(/\[object Object\]/);
  expect(html).not.toMatch(/(null|undefined|NaN)(개|건|%)/);
};

describe('장비 신뢰 화면 렌더', () => {
  it('SSH 탭 — 정책·업그레이드 설명·바뀐 지문 강조·작업 버튼', () => {
    const html = renderToStaticMarkup(h(PeerTrustSettings, { initialData: DATA, initialKind: 'ssh' }));
    noLeak(html);
    expect(html).toContain('관찰(처음 보는 장비는 통과·바뀐 지문은 거부)');
    expect(html).toContain('<b>관찰 모드</b>'); // BoldText 로 굵게(별표가 새지 않는다)
    expect(html).not.toContain('**');
    expect(html).toContain('⚠ 바뀐 지문 1');
    expect(html).toContain('승인 대기 · 지문이 바뀜');
    expect(html).toContain(FP('B'));
    expect(html).toContain('ssh-ed25519');
    expect(html).toContain('교체 예정');
    expect(html).toContain('관찰 지문 1개 일괄 승인');
    // 승인 버튼은 승인할 지문(대기·관찰)이 있는 행에만 — 대기 2 · 관찰 1(TLS 제외).
    // v2.731(A1-01): 이미 신뢰 지문이 있는 행(sw1 — 바뀐 지문 대기)은 '승인' 대신 '추가 승인'·'교체 승인' 둘이다.
    expect((html.match(/>승인<\/button>/g) || []).length).toBe(2 + 1); // sw2·sw3 + 직접 등록 '승인'
    expect((html.match(/>추가 승인<\/button>/g) || []).length).toBe(1);
    expect((html.match(/>교체 승인<\/button>/g) || []).length).toBe(1);
    expect(html).not.toContain('TLS 검증 상태를 읽지 못했습니다'); // SSH 탭에는 TLS 패널이 없다
  });
  it('TLS 탭 — 환경변수 강제 정책 · CA 번들 경고 · 예외 배너 · 수집기 표 · 최근 거부(승인 가능 여부)', () => {
    const html = renderToStaticMarkup(h(PeerTrustSettings, { initialData: DATA, initialKind: 'tls' }));
    noLeak(html);
    expect(html).toContain('TLS_PEER_POLICY');
    expect(html).toMatch(/disabled=""[^>]*>승인된 지문만 허용으로|관찰 모드로 바꾸기/);
    expect(html).toContain('<b>예외 사용 중</b>');
    expect(html).toContain('vCenter(VCENTER_TLS_VERIFY)');
    expect(html).toContain('/etc/vmware-portal/tls-ca-bundle.pem');
    expect(html).toContain('만료된 인증서 1개');
    expect(html).toContain('읽지 못한 블록 1개');
    expect(html).toContain('기본 신뢰 저장소 인증서 146개');
    expect(html).toContain('VCENTER_TLS_VERIFY=false');
    expect(html).toContain('알 수 없는 값');
    expect(html).toContain('검증 안 함 5');
    expect(html).toContain('승인된 지문 없음 · CA: 자체서명');
    expect(html).toContain('엄격 모드(CA 체인만)라 지문 승인을 쓰지 않습니다');
    expect(html).toContain('인증서 지문이 없어 승인할 수 없습니다');
    expect(html).toContain('주체 vc1.corp');
  });
  it('TLS 상태를 못 읽었으면 말한다 · 비어 있으면 빈 상태 문구 · 저장소 손상 배너', () => {
    const d = { ...DATA, tls: null, tlsError: 'boom', status: { ...STATUS, loadError: { code: 'corrupt' } } };
    const html = renderToStaticMarkup(h(PeerTrustSettings, { initialData: d, initialKind: 'tls' }));
    noLeak(html);
    expect(html).toContain('TLS 검증 상태를 읽지 못했습니다(boom)');
    expect(html).toContain('장비 신뢰 파일을 읽지 못했습니다(corrupt)');
    const empty = { ...DATA, peers: [], tls: { ...TLS, subsystems: [], exceptions: [], recentRejects: [], caBundle: { present: false, file: '/x/tls-ca-bundle.pem' } } };
    const h2 = renderToStaticMarkup(h(PeerTrustSettings, { initialData: empty, initialKind: 'tls' }));
    noLeak(h2);
    expect(h2).toContain('아직 기록된 TLS 인증서가 없습니다');
    expect(h2).toContain('사설 CA 번들 없음');
    expect(h2).toContain('아직 장비 TLS 연결 기록이 없습니다');
    expect(h2).toContain('최근 거부가 없습니다');
    expect(h2).not.toContain('예외 사용 중');
  });
  it('데이터 전 — 불러오는 중', () => {
    const html = renderToStaticMarkup(h(PeerTrustSettings));
    expect(html.length).toBeGreaterThan(0);
  });
});
