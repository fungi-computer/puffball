import * as z from "zod";
import * as Schema from "effect/Schema";
import * as Base64Url from "effect/encoding/Base64Url";
import { WatchdogQueuedJobSchema } from "@fungi.computer/watchdog";
import { sha256DigestSchema } from "./internal/app-release-schema.js";
import type { Sha256Digest } from "./internal/app-release-contract.js";
import {
  hostActorSchema,
  appMethodCallerSchema,
  isAppApiMethodName,
  parseAppMethodCallContext,
  type HostActor,
  type AppMethodCallContext,
} from "./app-method-runtime.js";
import type { AppApi } from "./app-vocabulary.js";
export { backgroundSyncAllowed } from "./internal/background-sync.js";

/** The caller's single lightweight grammar for a host-sealed enqueue origin. */
export const backgroundOriginSchema =
  appMethodCallerSchema.shape.backgroundOrigin.def.innerType;
/** Origin evidence, never a retained grant or credential. */
export type BackgroundOrigin = z.output<typeof backgroundOriginSchema>;
/** The closed result of checking a claimed job's origin in a fresh replay frame. */
export const claimedJobAdmissionSchema = z.union([
  z.strictObject({ kind: z.literal("admitted") }),
  z.strictObject({
    kind: z.literal("refused"),
    code: z.literal("access_changed"),
  }),
]);
/** A claim either passes origin admission or refuses before binding effects. */
export type ClaimedJobAdmission = z.output<typeof claimedJobAdmissionSchema>;
/** Host-minted replay port; an App cannot declare this binding. */
export type BackgroundBinding = Readonly<{
  /** Check the actual claimed job's origin once in this frame. */
  admit: (origin: BackgroundOrigin) => Promise<ClaimedJobAdmission>;
}>;

const originBytes = (
  claims: Readonly<{ instanceId: string; lane: string; method: string }>,
) =>
  new TextEncoder().encode(
    JSON.stringify([
      "fungi.background-origin/1",
      claims.instanceId,
      claims.lane,
      claims.method,
    ]),
  );

/** Derive a non-extractable host signing key; no secret is sent to an App. */
export async function backgroundOriginKey(secret: string): Promise<CryptoKey> {
  const text = new TextEncoder();
  const material = await crypto.subtle.importKey(
    "raw",
    text.encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: text.encode("fungi.app.background-origin"),
      info: text.encode("v1"),
    },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

/** Seal only host-verified Instance, member lane and foreground method attribution. */
export async function sealBackgroundOrigin(
  key: CryptoKey,
  claims: Readonly<{ instanceId: string; lane: string; method: string }>,
): Promise<BackgroundOrigin> {
  const signature = await crypto.subtle.sign("HMAC", key, originBytes(claims));
  return backgroundOriginSchema.parse({
    method: claims.method,
    seal: Base64Url.encode(new Uint8Array(signature)),
  });
}

/** Verify origin evidence against this frame's fresh admission; guest input never throws. */
export async function admitClaimedOrigin(
  key: CryptoKey,
  frame: Readonly<{
    instanceId: string;
    lane: string;
    admitted: readonly string[];
  }>,
  raw: unknown,
): Promise<ClaimedJobAdmission> {
  const refused: ClaimedJobAdmission = {
    kind: "refused",
    code: "access_changed",
  };
  const parsed = backgroundOriginSchema.safeParse(raw);
  if (!parsed.success) return refused;
  const decoded = Base64Url.decode(parsed.data.seal);
  if (
    decoded._tag === "Failure" ||
    Base64Url.encode(decoded.success) !== parsed.data.seal
  )
    return refused;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      new Uint8Array(decoded.success),
      originBytes({
        instanceId: frame.instanceId,
        lane: frame.lane,
        method: parsed.data.method,
      }),
    );
    return valid && frame.admitted.includes(parsed.data.method)
      ? { kind: "admitted" }
      : refused;
  } catch {
    return refused;
  }
}

/** A queue lane is an actor identity, never a credential or grant. */
export function actorLane(actor: HostActor): string {
  switch (actor.kind) {
    case "member":
      return `member:${actor.memberId}`;
    case "agent":
      return `agent:${actor.agentId}`;
    case "team-key":
      return `team-key:${actor.keyId}`;
  }
}

/** Only ordinary member calls may enqueue background work; ancestry is host-held. */
export function mayDefer(
  context: AppMethodCallContext,
  ancestry: readonly string[],
): boolean {
  return (
    context.actor.kind === "member" &&
    context.workflow === undefined &&
    ancestry.length === 0 &&
    Schema.is(WatchdogQueuedJobSchema.fields.lane)(actorLane(context.actor))
  );
}

/** Host-only projection: replace incoming eligibility with the verified write's sealed origin. */
export function backgroundContext(
  context: AppMethodCallContext,
  ancestry: readonly string[],
  method: Readonly<{
    name: string;
    effect: AppApi["methods"][string]["effect"];
  }>,
  origin: BackgroundOrigin | undefined,
): AppMethodCallContext {
  const caller = { ...parseAppMethodCallContext(context, true) };
  delete caller.backgroundLane;
  delete caller.backgroundOrigin;
  if (method.effect !== "write" || !mayDefer(caller, ancestry)) return caller;
  const sealed = backgroundOriginSchema.parse(origin);
  if (sealed.method !== method.name)
    throw new Error(
      "Background origin must match the verified foreground method",
    );
  return {
    ...caller,
    backgroundLane: actorLane(caller.actor),
    backgroundOrigin: sealed,
  };
}
/** App-side eligibility reads only the host-attested context; it never invents ancestry. */
export function mayEnqueueBackground(context: AppMethodCallContext): boolean {
  return (
    context.actor.kind === "member" &&
    context.workflow === undefined &&
    context.backgroundOrigin !== undefined &&
    context.backgroundLane === actorLane(context.actor) &&
    Schema.is(WatchdogQueuedJobSchema.fields.lane)(context.backgroundLane)
  );
}

const member = z.strictObject(hostActorSchema.def.options[0].shape);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** Identity and observed revisions only. Unknown fields, including bearer material, refuse. */
export const backgroundWakeSchema = z
  .strictObject({
    installationId: z.string().min(1).max(256),
    actor: member,
    lane: z
      .string()
      .refine((value) => Schema.is(WatchdogQueuedJobSchema.fields.lane)(value)),
    originMethod: z.string().refine(isAppApiMethodName),
    observed: z.strictObject({
      authorityVersion: revision,
      artifactDigest: z.custom<Sha256Digest>((value) =>
        Schema.is(sha256DigestSchema)(value),
      ),
      // Oyster has no member revision. The Hub supplies its real directory revision.
      membershipVersion: revision.optional(),
    }),
    epoch: revision,
  })
  .refine((wake) => wake.lane === actorLane(wake.actor), {
    message: "Wake lane must name its member",
  });
/** A host wake cannot confer authority without fresh directory and method admission. */
export type BackgroundWake = z.output<typeof backgroundWakeSchema>;
/** A retained identity eligible for member-only replay. */
export type BackgroundMember = BackgroundWake["actor"];
/** The App can settle a refused lane without receiving any binding authority. */
export const backgroundRefusalCodeSchema = z.enum([
  "access_changed",
  "installation_unavailable",
]);
/** Cleanup payload for one refused member lane; contains no actor or authority. */
export const backgroundSyncRefusalSchema = z.strictObject({
  lane: z
    .string()
    .startsWith("member:")
    .min(8)
    .refine((value) => Schema.is(WatchdogQueuedJobSchema.fields.lane)(value)),
  code: backgroundRefusalCodeSchema,
});
/** One available App's member-lane cleanup, delivered with zero binding grants. */
export type BackgroundSyncRefusal = z.output<
  typeof backgroundSyncRefusalSchema
>;
/** Closed, durable refusal reasons for the affected member lane. */
export type BackgroundRefusalCode = z.output<
  typeof backgroundRefusalCodeSchema
>;
/** Existing method admission outcomes interpreted by the replay owner. */
export type BackgroundAdmission =
  | Readonly<{ kind: "admitted"; context: AppMethodCallContext }>
  | Readonly<{
      kind: "refused";
      code:
        | "level_too_low"
        | "requires_not_granted"
        | "not_approved"
        | "denied"
        | "unavailable"
        | "stale_authority";
    }>;
/** Directory resolution and fresh continuation admission remain host-owned. */
export type BackgroundReplayPorts<Principal> = Readonly<{
  /** Resolve the retained member using the host's live directory, without bearer replay. */
  resolve: (actor: BackgroundMember) => Promise<Principal | null>;
  /** Admit backend.sync.method as this principal with fresh method-scoped grants. */
  admit: (
    principal: Principal,
    wake: BackgroundWake,
  ) => Promise<BackgroundAdmission>;
}>;
/** A refused wake settles its lane; retry uses the existing Carrier backoff. */
export type BackgroundReplayDecision =
  | Readonly<{ kind: "admitted"; context: AppMethodCallContext }>
  | Readonly<{ kind: "refused"; code: BackgroundRefusalCode }>
  | Readonly<{ kind: "retry" }>;

/** Resolve then re-admit. Observed revisions are evidence, never equality pins. */
export async function readmitBackground<Principal>(
  input: unknown,
  ports: BackgroundReplayPorts<Principal>,
): Promise<BackgroundReplayDecision> {
  const wake = backgroundWakeSchema.parse(input);
  const principal = await ports.resolve(wake.actor);
  if (principal === null) return { kind: "refused", code: "access_changed" };
  const decision = await ports.admit(principal, wake);
  if (decision.kind === "admitted") {
    const context = { ...parseAppMethodCallContext(decision.context, true) };
    // Fresh admission of a continuation does not grant another enqueue wake.
    delete context.backgroundLane;
    delete context.backgroundOrigin;
    if (!mayDefer(context, []) || actorLane(context.actor) !== wake.lane)
      return { kind: "refused", code: "access_changed" };
    return { kind: "admitted", context };
  }
  switch (decision.code) {
    case "stale_authority":
      return { kind: "retry" };
    case "unavailable":
      return { kind: "refused", code: "installation_unavailable" };
    case "level_too_low":
    case "requires_not_granted":
    case "not_approved":
    case "denied":
      return { kind: "refused", code: "access_changed" };
  }
}
