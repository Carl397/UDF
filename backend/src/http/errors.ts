/** Typed HTTP errors so handlers can throw domain errors consistently. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(msg = 'Bad request', details?: unknown) {
    return new ApiError(400, 'bad_request', msg, details);
  }
  static unauthorized(msg = 'Authentication required') {
    return new ApiError(401, 'unauthorized', msg);
  }
  static forbidden(msg = 'Insufficient permissions') {
    return new ApiError(403, 'forbidden', msg);
  }
  static notFound(msg = 'Resource not found') {
    return new ApiError(404, 'not_found', msg);
  }
  static conflict(msg = 'Conflict') {
    return new ApiError(409, 'conflict', msg);
  }
  static tooMany(msg = 'Too many requests') {
    return new ApiError(429, 'too_many_requests', msg);
  }
  static internal(msg = 'Internal server error') {
    return new ApiError(500, 'internal_error', msg);
  }
}
