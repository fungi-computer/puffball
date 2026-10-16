export { backgroundSyncAllowed } from "./internal/background-sync.js";
import * as z from "zod/mini";

/** Reserved JavaScript, RPC and lifecycle names are never App method names. */
export const appApiReservedMethodNames = Object.freeze({
  intrinsic: [
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
  ],
  rpc: ["then", "dup", "connect", "id", "name"],
  instance: ["ctx", "env"],
  lifecycle: [
    "gill",
    "onGitPush",
    "syncRefused",
    "authorizeGitPush",
    "fetch",
    "alarm",
    "queue",
    "scheduled",
    "tail",
    "trace",
    "email",
    "test",
    "tailStream",
    "webSocketMessage",
    "webSocketClose",
    "webSocketError",
  ],
} as const);
/** Sole caller grammar shared by the lightweight runtime and Effect adapter. */
const identity = z.string().check(z.minLength(1), z.maxLength(256));
const memberActor = z.object({ kind: z.literal("member"), memberId: identity });
const agentActor = z.object({ kind: z.literal("agent"), agentId: identity });
const keyActor = z.object({ kind: z.literal("team-key"), keyId: identity });
/** Actor identity attested by the host, shared by calls and Workflow arming. */
export const hostActorSchema = z.discriminatedUnion("kind", [
  memberActor,
  agentActor,
  keyActor,
]);
/** The host's verified member, Agent or Team-key identity. */
export type HostActor = z.output<typeof hostActorSchema>;
/** Host-held Workflow attribution, delivered separately from guest input. */
export const workflowAttestationSchema = z.object({
  /** Published Workflow selected by the run owner. */
  workflowId: identity,
  /** Run identity held by the run owner. */
  runId: identity,
  /** Node selected by the stored published Workflow. */
  nodeId: identity,
  /** Actor that armed the run, re-admitted by the host at dispatch. */
  armedBy: hostActorSchema,
});
/** Workflow attribution shared by invocation frames and Git writers. */
export type WorkflowAttestation = z.output<typeof workflowAttestationSchema>;
// Keep the single origin grammar in the lightweight caller module. The host-side
// background-replay entry exposes this same schema without a runtime import cycle.
const backgroundOrigin = z.lazy(() =>
  z.strictObject({
    method: z.string().check(z.refine((name) => isAppApiMethodName(name))),
    seal: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
  }),
);
/** Sole grammar for the host-minted Computer pin and actor attribution. */
export const appMethodCallerSchema = z.object({
  computerId: z.nullable(identity),
  actor: hostActorSchema,
  /** Host-attested enqueue eligibility for this ordinary write; absent otherwise. */
  backgroundLane: z.optional(
    z.string().check(z.minLength(8), z.maxLength(263)),
  ),
  /** Host-sealed foreground method for durable jobs; paired with backgroundLane. */
  backgroundOrigin: z.optional(backgroundOrigin),
  /** Team role attested by the host, never selected by App method input. */
  role: z.optional(z.enum(["owner", "member"])),
  /**
   * The host attests that this member is currently the Team's only member.
   * Present only on a member's own call; never on an Agent, Team key or
   * Workflow node, and never selected by App method input.
   */
  soleMember: z.optional(z.literal(true)),
  /** Present only on a Workflow node invocation admitted by its host. */
  workflow: z.optional(workflowAttestationSchema),
  /**
   * The host's stable key for this logical call (for example one Workflow
   * node), the same on every retry. A method with side effects uses it to do
   * its work at most once. Absent when the caller supplies its own request id.
   */
  idempotencyKey: z.optional(
    z.string().check(z.minLength(1), z.maxLength(128)),
  ),
});
const strictActor = z.discriminatedUnion("kind", [
  z.strictObject(memberActor.shape),
  z.strictObject(agentActor.shape),
  z.strictObject(keyActor.shape),
]);
const strictCaller = z.strictObject({
  ...appMethodCallerSchema.shape,
  actor: strictActor,
  workflow: z.optional(
    z.strictObject({
      ...workflowAttestationSchema.shape,
      armedBy: strictActor,
    }),
  ),
});
/** Trusted attribution delivered separately from App method arguments. */
export type AppMethodCallContext = z.output<typeof appMethodCallerSchema>;
/** Decode trusted host attribution through the sole runtime-neutral grammar. */
export const parseAppMethodCallContext = (
  value: unknown,
  rejectUnknownKeys = false,
): AppMethodCallContext =>
  validateCaller(
    (rejectUnknownKeys ? strictCaller : appMethodCallerSchema).parse(value),
  );

function validateCaller(context: AppMethodCallContext): AppMethodCallContext {
  if (
    context.soleMember !== undefined &&
    (context.actor.kind !== "member" || context.workflow !== undefined)
  )
    throw new Error("Only a member's own call can be its Team's sole member");
  if (
    (context.backgroundLane === undefined) !==
    (context.backgroundOrigin === undefined)
  )
    throw new Error("Background lane and origin must be attested together");
  if (
    context.backgroundLane !== undefined &&
    (context.actor.kind !== "member" ||
      context.workflow !== undefined ||
      context.backgroundLane !== `member:${context.actor.memberId}`)
  )
    throw new Error("Background lane must name an ordinary member");
  return context;
}

/** Shared domain grammar for generated RPC method names. */
export const isAppApiMethodName = (name: string): boolean =>
  name.length <= 80 &&
  /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(name) &&
  !Object.values(appApiReservedMethodNames)
    .flat()
    .some((reserved) => reserved === name);
