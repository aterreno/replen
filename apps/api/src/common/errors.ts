import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from "@nestjs/common";
import type { Response } from "express";
import { ZodError } from "zod";
import { currentContext } from "./context.js";
import { log } from "./logger.js";

export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>[],
  ) {
    super(message);
  }
}

export const notFound = (what: string, id: string) => new DomainError("NOT_FOUND", 404, `${what} ${id} not found`);
export const conflict = (code: string, message: string) => new DomainError(code, 409, message);
export const forbidden = (code: string, message: string) => new DomainError(code, 403, message);
export const unprocessable = (code: string, message: string, details?: Record<string, unknown>[]) =>
  new DomainError(code, 422, message, details);

const TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  422: "Unprocessable Content",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

/** Maps every error to RFC 9457 problem details with the request's correlation id. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500;
    let code = "INTERNAL";
    let detail = "Unexpected error";
    let errors: Record<string, unknown>[] | undefined;
    if (exception instanceof DomainError) {
      status = exception.status;
      code = exception.code;
      detail = exception.message;
      errors = exception.details;
    } else if (exception instanceof ZodError) {
      status = 400;
      code = "VALIDATION_FAILED";
      detail = "Request body failed validation";
      errors = exception.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = `HTTP_${status}`;
      const body = exception.getResponse();
      detail = typeof body === "string" ? body : ((body as { message?: string }).message ?? exception.message);
    }
    if (status >= 500) {
      log("error", "request failed", { err: exception instanceof Error ? exception.stack : String(exception) });
    }
    res
      .status(status)
      .type("application/problem+json")
      .json({
        type: `https://replen.local/problems/${code.toLowerCase().replace(/_/g, "-")}`,
        title: TITLES[status] ?? "Error",
        status,
        code,
        detail,
        correlationId: currentContext().correlationId,
        ...(errors ? { errors } : {}),
      });
  }
}
