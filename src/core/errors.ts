export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class SteerRejected extends Error {
  readonly steerRejected = true;
  constructor(message = "steer rejected") {
    super(message);
    this.name = "SteerRejected";
  }
}

export function isSteerRejected(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { steerRejected?: boolean }).steerRejected);
}
