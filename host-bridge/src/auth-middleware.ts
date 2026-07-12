import { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';

function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Length must match before timingSafeEqual (it throws on mismatched lengths) — the
  // length check itself leaks negligible information compared to a byte-by-byte one.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Rejects any request that doesn't present the shared secret the backend container is
 * configured with — this port is reachable by anything on the host's network, not just
 * the backend, and a hit here spawns a real CLI process under the operator's login. */
export function requireBridgeToken(expectedToken: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const provided = req.header('x-bridge-token');
    if (!provided || !tokensMatch(provided, expectedToken)) {
      res.status(401).json({ error: 'Invalid or missing bridge token' });
      return;
    }
    next();
  };
}
