export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code: string = 'error',
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(entity = 'Resource', idOrMessage?: string) {
    super(404, idOrMessage && idOrMessage.includes(' ') ? idOrMessage : `${entity} not found`, 'not_found');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(403, message, 'forbidden');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, message, 'unauthorized');
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(422, message, 'validation_error', details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, message, 'conflict');
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests; slow down and try again shortly', code = 'rate_limited') {
    super(429, message, code);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message: string, code = 'unavailable') {
    super(503, message, code);
  }
}
