/** 프로세스 인스턴스 id(v2.429) — /api/health 에 실어 "이 응답이 나 자신인지"(HAProxy 4001 이 중앙으로 되돌아오는지) 대조한다. */
import crypto from 'node:crypto';
const ID = crypto.randomUUID();
export function instanceId() { return ID; }
