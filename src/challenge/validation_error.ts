/**
 * Build a structured 4xx validation-error body that pairs cleanly with the
 * existing 402 / 403 builders. Every commerce merchant returning helpful
 * `bad_request` / `not_found` / `out_of_stock` / etc. errors converges on the
 * same shape: `{ error: {code, message}, ...optional_hints, next_steps? }`.
 *
 * This builder doesn't choose the HTTP status — vendors wrap the returned
 * body in their framework's response (`c.json(body, 400)` in Hono,
 * `Response.json(body, {status: 400})` for the Web Fetch path, etc.). Status
 * stays the merchant's call because the same shape works for 400/404/409/422.
 */
export interface BuildValidationErrorInput {
  /** Machine-readable error code (e.g. 'bad_request', 'not_found', 'out_of_stock'). */
  code: string;
  /** Human-readable message — surfaced directly to the user via the agent. */
  message: string;
  /** Optional schema description of required body fields, keyed by field name. Surfaced
   *  so agents can self-correct without fetching docs. */
  requiredFields?: Record<string, string>;
  /** Optional concrete example body. Pairs with `requiredFields` for max self-serve. */
  exampleBody?: unknown;
  /** Optional next-step hint block (`{action, user_message?, ...vendor_extras}`). */
  nextSteps?: Record<string, unknown>;
  /** Vendor-specific top-level fields merged into the body (e.g. `available`,
   *  `blocked_states`, `max_length`). */
  extra?: Record<string, unknown>;
}

export interface ValidationErrorBody {
  error: { code: string; message: string };
  required_fields?: Record<string, string>;
  example_body?: unknown;
  next_steps?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Compose a 4xx body that vendors return via their framework's response helper.
 * Combine with the merchant's chosen HTTP status (400 for body shape errors,
 * 404 for missing entities, 409 for stock conflicts, 403 for policy denials, etc.).
 *
 * Example:
 * ```ts
 * return c.json(buildValidationError({
 *   code: 'bad_request',
 *   message: 'product_id, email, and shipping are required',
 *   requiredFields: { product_id: 'uuid', email: 'string', shipping: 'object' },
 *   nextSteps: { action: 'retry_with_complete_body' },
 * }), 400);
 * ```
 */
export function buildValidationError(input: BuildValidationErrorInput): ValidationErrorBody {
  const body: ValidationErrorBody = {
    error: { code: input.code, message: input.message },
  };
  if (input.requiredFields) body.required_fields = input.requiredFields;
  if (input.exampleBody !== undefined) body.example_body = input.exampleBody;
  if (input.nextSteps) body.next_steps = input.nextSteps;
  if (input.extra) Object.assign(body, input.extra);
  return body;
}
