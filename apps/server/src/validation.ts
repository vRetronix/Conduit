import type { z } from 'zod';
import { AppError } from './errors';

/** Parses untrusted input. On failure reports field paths and messages only — never the submitted values. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new AppError('validation_error', 'Some fields are invalid', {
    issues: result.error.issues.slice(0, 20).map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  });
}
