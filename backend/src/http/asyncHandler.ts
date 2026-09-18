import type { RequestHandler, Request, Response, NextFunction } from 'express';
import type { Principal } from '../auth/permissions.js';

/** Wrap async route handlers so rejected promises reach the error middleware. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: Principal;
      requestId?: string;
    }
  }
}

export type { Principal };
