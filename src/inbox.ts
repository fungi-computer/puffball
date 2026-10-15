import * as Schema from "effect/Schema";

const identity = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
);
const time = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);

/** One Session, projected by its Agent owner, with this member's visit. */
export const memberInboxSessionSchema = Schema.Union([
  Schema.Struct({
    agentId: identity,
    sessionId: identity,
    title: Schema.String.check(Schema.isMaxLength(4_096)),
    triggerId: Schema.optionalKey(identity),
    createdAt: time,
    lastActivityAt: time,
    settledAt: Schema.optionalKey(time),
    visitedAt: Schema.optionalKey(time),
    state: Schema.Literals(["needs_you", "running", "errored", "done"]),
  }),
  Schema.Struct({
    agentId: identity,
    sessionId: identity,
    state: Schema.Literal("unavailable"),
  }),
]);
/** Parsed Session facts in the shared Inbox vocabulary. */
export type MemberInboxSession = typeof memberInboxSessionSchema.Type;

/** A review's engine identity, independent of its native delivery coordinates. */
export const workflowReviewKeySchema = Schema.Struct({
  runId: identity,
  nodeId: identity,
  iteration: identity,
});
/** The run, node and iteration that identify one human review. */
export type WorkflowReviewKey = typeof workflowReviewKeySchema.Type;

/** Facts delivered to an admitted reviewer by the run owner, never a fake Session. */
export const workflowReviewInboxItemSchema = Schema.Struct({
  kind: Schema.Literal("workflow-review"),
  key: workflowReviewKeySchema,
  installationId: identity,
  /** Raw unpublished graphs have no immutable publication identity. */
  workflowId: Schema.NullOr(identity),
  workflowTitle: Schema.String,
  reviewTitle: Schema.String,
  reviewers: Schema.Literals(["runner", "owners"]),
  show: Schema.Array(Schema.Json),
  choices: Schema.optionalKey(Schema.Array(identity)),
  /** Actual insertion time and the stored deadline, retained on replay. */
  openedAt: time,
  expiresAt: time,
  state: Schema.Literals([
    "pending",
    "answered",
    "delivered",
    "timed_out",
    "closed",
  ]),
});
/** A reviewer-visible projection of a saved Workflow review. */
export type WorkflowReviewInboxItem = typeof workflowReviewInboxItemSchema.Type;

/** The INBOX wire has one vocabulary on every host and App client. */
export const memberInboxItemSchema = Schema.Union([
  memberInboxSessionSchema,
  workflowReviewInboxItemSchema,
]);
/** An Inbox row is a Session or a human Workflow review. */
export type MemberInboxItem = typeof memberInboxItemSchema.Type;
/** A row replacement or an Agent-owned Session deletion. */
export const memberInboxDeltaItemSchema = Schema.Union([
  memberInboxItemSchema,
  Schema.Struct({
    agentId: identity,
    sessionId: identity,
    deleted: Schema.Literal(true),
  }),
]);
/** One record carried by an Inbox row delta. */
export type MemberInboxDeltaItem = typeof memberInboxDeltaItemSchema.Type;

/** Stable identity of one Session across Agents. */
export function memberInboxKey(agentId: string, sessionId: string): string {
  return `${agentId}\u0000${sessionId}`;
}

/** Stable placement across review transitions; Map iterations remain distinct. */
export function memberInboxItemKey(item: MemberInboxDeltaItem): string {
  return "kind" in item
    ? JSON.stringify([
        item.kind,
        item.installationId,
        item.key.runId,
        item.key.nodeId,
        item.key.iteration,
      ])
    : memberInboxKey(item.agentId, item.sessionId);
}
