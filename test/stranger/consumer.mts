import {
  parseAppMethodCallContext,
  type AppMethodCallContext,
  type HostActor,
  type WorkflowAttestation,
} from "@fungi.computer/puffball/app-method-runtime";
import { parseAppId, type AppId } from "@fungi.computer/puffball";
import {
  decodeAppId,
  type AppReleaseCore,
} from "@fungi.computer/puffball/effect";
import * as Result from "effect/Result";

const appId: AppId = parseAppId("app_typed_stranger");
const decoded = decodeAppId("app_typed_stranger");

if (Result.isSuccess(decoded)) {
  const decodedAppId: AppId = decoded.success;
  void decodedAppId;
}

/** Proves the packed Effect entry point exposes its public core contract. */
export type StrangerAppReleaseCore = AppReleaseCore;

void appId;

const caller: AppMethodCallContext = parseAppMethodCallContext({
  computerId: null,
  actor: { kind: "member", memberId: "member_stranger" },
});
void caller;

const armedBy: HostActor = { kind: "agent", agentId: "agent_stranger" };
const workflow: WorkflowAttestation = {
  workflowId: "workflow_stranger",
  runId: "run_stranger",
  nodeId: "review",
  armedBy,
};
const workflowCaller: AppMethodCallContext = {
  computerId: null,
  actor: armedBy,
  workflow,
};
void workflowCaller;

import { DatabaseSync } from "node:sqlite";
import { sqliteD1 } from "@fungi.computer/puffball/testing";
import type { AppReleaseD1Database } from "@fungi.computer/puffball/cloudflare";
const sqlite = new DatabaseSync(":memory:");
const database: AppReleaseD1Database = sqliteD1(sqlite);
void database;
sqlite.close();

import {
  backgroundContext,
  backgroundOriginKey,
  sealBackgroundOrigin,
  admitClaimedOrigin,
  type BackgroundBinding,
  type ClaimedJobAdmission,
  mayEnqueueBackground,
  backgroundWakeSchema,
  readmitBackground,
  type BackgroundWake,
  type BackgroundReplayPorts,
  type BackgroundReplayDecision,
} from "@fungi.computer/puffball/background-replay";
const packedOriginKey = await backgroundOriginKey("synthetic-packed-proof-key");
const packedOrigin = await sealBackgroundOrigin(packedOriginKey, {
  instanceId: "instance_packed",
  lane: "member:member_stranger",
  method: "save",
});
const enqueueContext: AppMethodCallContext = backgroundContext(
  caller,
  [],
  { name: "save", effect: "write" },
  packedOrigin,
);
const eligible: boolean = mayEnqueueBackground(enqueueContext);
const wake: BackgroundWake = backgroundWakeSchema.parse({
  installationId: "notes",
  actor: enqueueContext.actor,
  lane: enqueueContext.backgroundLane,
  originMethod: "save",
  observed: { authorityVersion: 1, artifactDigest: `sha256:${"1".repeat(64)}` },
  epoch: 1,
});
const replayPorts: BackgroundReplayPorts<{ memberId: string }> = {
  resolve: (actor) => Promise.resolve({ memberId: actor.memberId }),
  admit: () => Promise.resolve({ kind: "admitted", context: caller }),
};
const backgroundResult: Promise<BackgroundReplayDecision> = readmitBackground(
  wake,
  replayPorts,
);
void [eligible, backgroundResult];

import {
  appBackendBindingOperation,
  type AppCapabilityId,
} from "@fungi.computer/puffball/app";
const emitCapability: AppCapabilityId = "app.events.emit";
const emitOperation = appBackendBindingOperation("EVENTS", "emit");
if (emitOperation === undefined)
  throw new Error("EVENTS emit operation is missing");
const emitRequirements: readonly AppCapabilityId[] = emitOperation.requires;
void emitCapability;
void emitRequirements;

const claimedOriginBinding: BackgroundBinding = {
  admit: (origin) =>
    admitClaimedOrigin(
      packedOriginKey,
      {
        instanceId: "instance_packed",
        lane: "member:member_stranger",
        admitted: ["save"],
      },
      origin,
    ),
};
const claimedAdmission: ClaimedJobAdmission =
  await claimedOriginBinding.admit(packedOrigin);
void claimedAdmission;
