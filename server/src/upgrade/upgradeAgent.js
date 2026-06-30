import { Agent } from 'undici';

/**
 * 업그레이드 다운로드 전용 TLS 검증 디스패처.
 *
 * 전역 undici 디스패처는 자체서명 vCenter 대응을 위해 인증서 검증이 꺼져 있다(restClient.js).
 * 그 상태로 인터넷 GitHub/미러에서 versions.json·번들을 받으면 MITM이 변조 번들을 주입해
 * 자가설치(RCE)될 수 있다. 업그레이드 다운로드 fetch는 이 디스패처를 명시적으로 넘겨
 * TLS 검증을 '강제'한다(전역 설정과 무관).
 *
 * 사내 자체서명 미러(PACKAGE_BASE_URL이 https://내부미러)인 경우에만
 * UPGRADE_TLS_INSECURE=true 로 명시적으로 검증을 끌 수 있다(기본은 검증 ON = 안전).
 */
export const upgradeAgent = new Agent({
  connect: { rejectUnauthorized: process.env.UPGRADE_TLS_INSECURE !== 'true' },
  connectTimeout: 15_000,
});
