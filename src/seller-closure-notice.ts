import * as Schema from "effect/Schema";
const identity = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
);
/** A retained entitlement continues after its seller closes; this is not a revocation. */
export const sellerClosureNoticeSchema = Schema.Struct({
  kind: Schema.Literal("seller-closed"),
  dispositionId: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  ),
  sellerAccountId: identity,
  buyerAccountId: identity,
  appId: identity,
  releaseIds: Schema.Tuple([identity]),
  displayName: identity,
  sellerName: identity,
  requestId: identity,
});
export type SellerClosureNotice = Schema.Schema.Type<
  typeof sellerClosureNoticeSchema
>;
