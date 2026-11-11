import { createHash, timingSafeEqual } from 'node:crypto';

// Hash both sides so the compare stays constant-time even when the lengths differ.
// timingSafeEqual throws if the buffers are not the same length.
function sha256(value) {
  return createHash('sha256').update(value).digest();
}

export function tokensMatch(presented, expected) {
  const left = sha256(typeof presented === 'string' ? presented : '');
  const right = sha256(typeof expected === 'string' ? expected : '');
  return timingSafeEqual(left, right);
}

/**
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
export function authorize(authorizationHeader, expectedToken) {
  if (typeof expectedToken !== 'string' || expectedToken.length === 0) {
    return { ok: false, status: 500, error: 'API_TOKEN is not configured' };
  }

  const header = typeof authorizationHeader === 'string' ? authorizationHeader : '';
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  const presented = match ? match[1] : '';
  const same = tokensMatch(presented, expectedToken);

  if (!match || !same) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  return { ok: true };
}
