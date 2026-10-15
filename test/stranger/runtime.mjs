import {
  hostActorSchema,
  workflowAttestationSchema,
  parseAppMethodCallContext,
} from "@fungi.computer/puffball/app-method-runtime";
import { parseAppId } from "@fungi.computer/puffball";
import { decodeAppId } from "@fungi.computer/puffball/effect";
import * as Result from "effect/Result";

const appId = parseAppId("app_stranger");
const decoded = decodeAppId("app_stranger");

if (!Result.isSuccess(decoded) || decoded.success !== appId) {
  throw new Error(
    "App Release stranger imports did not preserve AppId parsing",
  );
}

const caller = parseAppMethodCallContext({
  computerId: null,
  actor: { kind: "member", memberId: "member_stranger" },
});
if (
  caller.computerId !== null ||
  caller.actor.kind !== "member" ||
  caller.actor.memberId !== "member_stranger"
)
  throw new Error(
    "Packed runtime caller parser did not preserve trusted attribution",
  );

import assert from "node:assert/strict";
const armedBy = hostActorSchema.parse({
  kind: "agent",
  agentId: "agent_stranger",
});
const workflow = workflowAttestationSchema.parse({
  workflowId: "workflow_stranger",
  runId: "run_stranger",
  nodeId: "review",
  armedBy,
});
assert.deepEqual(
  parseAppMethodCallContext(
    { computerId: null, actor: armedBy, workflow },
    true,
  ),
  { computerId: null, actor: armedBy, workflow },
);
import { DatabaseSync } from "node:sqlite";
import { sqliteD1 } from "@fungi.computer/puffball/testing";
const sqlite = new DatabaseSync(":memory:");
try {
  sqlite.exec("CREATE TABLE proof (value TEXT NOT NULL)");
  const database = sqliteD1(sqlite);
  await database.batch([
    database.prepare("INSERT INTO proof VALUES (?)").bind("packed"),
  ]);
  assert.deepEqual(await database.prepare("SELECT value FROM proof").first(), {
    value: "packed",
  });
} finally {
  sqlite.close();
}

const {
  actorLane,
  backgroundContext,
  backgroundOriginKey,
  sealBackgroundOrigin,
  admitClaimedOrigin,
  mayEnqueueBackground,
  backgroundWakeSchema,
  readmitBackground,
} = await import("@fungi.computer/puffball/background-replay");
const packedOriginKey = await backgroundOriginKey("synthetic-packed-proof-key");
const packedOrigin = await sealBackgroundOrigin(packedOriginKey, {
  instanceId: "instance_packed",
  lane: "member:member_stranger",
  method: "save",
});
const backgroundCaller = backgroundContext(
  { actor: { kind: "member", memberId: "member_stranger" }, computerId: null },
  [],
  { name: "save", effect: "write" },
  packedOrigin,
);
if (
  !mayEnqueueBackground(backgroundCaller) ||
  actorLane(backgroundCaller.actor) !== "member:member_stranger"
)
  throw new Error("Packed background eligibility lost its member");
const backgroundWake = backgroundWakeSchema.parse({
  installationId: "notes",
  actor: backgroundCaller.actor,
  lane: backgroundCaller.backgroundLane,
  originMethod: "save",
  observed: { authorityVersion: 1, artifactDigest: `sha256:${"1".repeat(64)}` },
  epoch: 1,
});
const backgroundDecision = await readmitBackground(backgroundWake, {
  resolve: () => Promise.resolve(null),
  admit: () => {
    throw new Error("Removed member reached admission");
  },
});
if (
  backgroundDecision.kind !== "refused" ||
  backgroundDecision.code !== "access_changed"
)
  throw new Error("Packed replay did not re-admit");

import {
  appBackendBindingOperation,
  appCapabilityIdSchema,
} from "@fungi.computer/puffball/app";
import * as Schema from "effect/Schema";
assert.equal(
  Schema.decodeUnknownSync(appCapabilityIdSchema)("app.events.emit"),
  "app.events.emit",
);
assert.deepEqual(appBackendBindingOperation("EVENTS", "emit"), {
  cap: "app.events.emit",
  requires: ["app.events.emit"],
  effect: "write",
});

const packedAdmission = {
  instanceId: "instance_packed",
  lane: "member:member_stranger",
  admitted: ["save"],
};
assert.equal(packedOriginKey.extractable, false);
assert.deepEqual(
  await admitClaimedOrigin(packedOriginKey, packedAdmission, packedOrigin),
  { kind: "admitted" },
);
assert.deepEqual(
  await admitClaimedOrigin(packedOriginKey, packedAdmission, {
    ...packedOrigin,
    method: "other",
  }),
  { kind: "refused", code: "access_changed" },
);
