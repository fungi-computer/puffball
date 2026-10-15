import * as Schema from "effect/Schema";
import type { AppReleaseD1Database } from "./cloudflare.js";

const sellerClosureSchema = Schema.Struct({
  teamId: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
  requestId: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
  closedAt: Schema.Number.pipe(
    Schema.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  ),
});
export type SellerClosure = Schema.Schema.Type<typeof sellerClosureSchema>;

export class SellerClosureConflictError extends Error {
  readonly code = "seller_closure_conflict";
  constructor() {
    super("Seller closure marker conflicts with the original decision");
  }
}

/** Trusted close-decision delivery only. Keep the original irreversible decision on retries. */
export async function recordD1SellerClosure(
  database: AppReleaseD1Database,
  raw: SellerClosure,
): Promise<void> {
  const input = Schema.decodeUnknownSync(sellerClosureSchema, {
    onExcessProperty: "error",
  })(raw);
  const result = await database
    .prepare(
      "INSERT INTO app_release_closed_sellers(team_id,request_id,closed_at) VALUES (?,?,?) ON CONFLICT(team_id) DO NOTHING",
    )
    .bind(input.teamId, input.requestId, input.closedAt)
    .run();
  if (!result.success) throw new Error("Seller closure marker unavailable");
  const row = await database
    .prepare(
      "SELECT team_id AS teamId,request_id AS requestId,closed_at AS closedAt FROM app_release_closed_sellers WHERE team_id=?",
    )
    .bind(input.teamId)
    .first();
  const saved = Schema.decodeUnknownSync(sellerClosureSchema)(row);
  if (saved.requestId !== input.requestId || saved.closedAt !== input.closedAt)
    throw new SellerClosureConflictError();
}
