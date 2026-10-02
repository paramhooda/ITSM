import { SignJWT, jwtVerify } from 'jose';
import { config } from '@/config';

const secret = new TextEncoder().encode(config.JWT_SECRET);

export interface AccessClaims {
  sub: string;
  sid: string;
  typ: 'access';
}

export async function signAccessToken(userId: string, sessionId: string) {
  return new SignJWT({ sid: sessionId, typ: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setIssuer('itsm')
    .setExpirationTime(config.ACCESS_TOKEN_TTL)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: 'itsm' });
    if (payload.typ !== 'access' || !payload.sub || !payload.sid) return null;
    return { sub: payload.sub, sid: payload.sid as string, typ: 'access' };
  } catch {
    return null;
  }
}
