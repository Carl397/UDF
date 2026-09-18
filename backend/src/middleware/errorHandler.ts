import type { ErrorRequestHandler, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { ApiError } from '../http/errors.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';

/** Attach a correlation id to every request (and echo it back). */
export const requestId: RequestHandler = (req, res, next) => {
  const id = (req.headers['x-request-id'] as string) || randomUUID();
  req.requestId = id;
  res.setHeader('x-request-id', id);
  next();
};

/** Centralized error handler → consistent JSON error envelope. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const reqId = req.requestId;

  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: 'validation_error', message: 'Invalid input', reqId, details: err.flatten() },
    });
    return;
  }

  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, reqId, details: err.details },
    });
    return;
  }

  // Unknown error: log full detail server-side, return a generic message.
  logger.error({ err, reqId, path: req.path }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'Internal server error',
      reqId,
      // Only leak stack/details in development.
      details: env.isProduction ? undefined : String(err),
    },
  });
};

/** 404 for unmatched routes. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(ApiError.notFound(`No route for ${req.method} ${req.path}`));
};
