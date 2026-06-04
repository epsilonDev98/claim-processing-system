/**
 * Service-layer errors. Mapped to HTTP status codes centrally in the API (validation → 400,
 * not-found → 404, not-payable / illegal transition → 409).
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** A claim/line cannot be paid in its current state (e.g. a line still needs review). */
export class NotPayableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotPayableError';
  }
}
