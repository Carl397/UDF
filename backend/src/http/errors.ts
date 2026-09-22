/** Public wording is selected by status/code, never by exception text or details. */
export function publicErrorMessage(status: number, code: string): string {
  const messages: Record<string, readonly [number, string]> = {
    device_banned: [403, 'This device cannot access this service. Please contact support.'],
    account_banned: [403, 'This account is no longer active. Please contact support.'],
    account_suspended: [403, 'This account is temporarily suspended. Please contact support.'],
    invalid_current_password: [400, 'Your current password is incorrect. Please try again.'],
    password_reused: [400, 'Choose a different new password.'],
    module_lockout: [400, 'This feature must stay enabled to keep administrator access available.'],
    unknown_module: [400, 'This feature is unavailable. Please refresh and try again.'],
    duplicate_page_section: [400, 'A page cannot include the same content block twice.'],
    ward_profile_unavailable: [403, 'Your registered ward is unavailable. Please contact support.'],
    ward_members_only: [403, 'Registered ward settings are available to members only.'],
    ward_change_stale: [409, 'Your registered ward has changed. Please reload it before trying again.'],
    ward_change_limit: [409, 'You have used all 3 ward changes. Your registered ward cannot be changed again.'],
    invalid_ward: [400, 'Please choose a valid ward and try again.'],
  };
  const known = Object.prototype.hasOwnProperty.call(messages, code) ? messages[code] : undefined;
  if (known && known[0] === status) return known[1];
  switch (status) {
    case 400: case 422: return 'Please check your information and try again.';
    case 401: return 'Please sign in again and try again.';
    case 403: return 'You do not have access to this action.';
    case 404: return 'This service or item is currently unavailable. Please try again later.';
    case 408: case 504: return 'This is taking longer than expected. Please try again.';
    case 409: return 'This change could not be completed. Please refresh and try again.';
    case 413: return 'This file or request is too large. Please reduce its size and try again.';
    case 429: return 'Please wait a moment before trying again.';
    default: return 'Something went wrong. Please try again later.';
  }
}

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
