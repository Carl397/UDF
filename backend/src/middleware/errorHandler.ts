import type { ErrorRequestHandler, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { ApiError, publicErrorMessage } from '../http/errors.js';
import { logger } from '../config/logger.js';

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
  res.setHeader('Cache-Control', 'no-store');

  // Body-parser errors can carry submitted data; never echo or log their body.
  if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
    const status = err.type === 'entity.too.large' ? 413 : 400;
    res.status(status).json({ error: { code: 'bad_request', message: publicErrorMessage(status, 'bad_request'), reqId } });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: 'validation_error', message: publicErrorMessage(400, 'validation_error'), reqId },
    });
    return;
  }

  if (err instanceof ApiError) {
    if (err.status >= 500) logger.error({ err, reqId, path: req.path }, 'API error');
    res.status(err.status).json({
      error: { code: err.code, message: publicErrorMessage(err.status, err.code), reqId },
    });
    return;
  }

  // Unknown error: log full detail server-side, return a generic message.
  logger.error({ err, reqId, path: req.path }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: 'internal_error',
      message: publicErrorMessage(500, 'internal_error'),
      reqId,
    },
  });
};

/** 404 for unmatched routes. */
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(ApiError.notFound());
};
