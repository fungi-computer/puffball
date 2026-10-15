import * as z from "zod";
import { gitPushEventIdSchema } from "./git-representation.js";
import {
  gitRepositoryNameSchema,
  gitRefUpdateSchema,
} from "./git-representation.js";

const identity = z.string().min(1).max(256);
/** Canonical EventSink body; installation identity is supplied by the host. */
export const appEventInputSchema = z.strictObject({
  type: z.string().min(1).max(128),
  payload: z.strictObject({
    type: z.string().min(1).max(128),
    timestamp: z.string().min(1).max(256),
    data: z.json(),
  }),
  eventId: identity,
});
/** Parsed EventSink input before the host attaches installation identity. */
export type AppEventInput = z.output<typeof appEventInputSchema>;
/** Host-accepted push origin, distinct from event payload authority. */
const appEventGitSourceSchema = z.strictObject({
  eventId: gitPushEventIdSchema,
  repository: gitRepositoryNameSchema,
  updates: z.array(gitRefUpdateSchema).min(1).max(256),
  providerRepository: gitRepositoryNameSchema,
});
/** Host-attested repository origin of an accepted push fact. */
export type AppEventGitSource = NonNullable<AppEventFact["gitSource"]>;
/** Saved host fact delivered to the shared Workflows event router. */
export const appEventFactSchema = appEventInputSchema.extend({
  installationId: identity,
  appId: identity,
  releaseId: identity,
  gitSource: appEventGitSourceSchema.optional(),
});
/** Canonical saved event fact for delivery to a host event router. */
export type AppEventFact = z.output<typeof appEventFactSchema>;
