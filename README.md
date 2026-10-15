# Puffball (`@fungi.computer/puffball`)

Puffball is a catalog for web apps and their immutable releases. It records
which App exists, which Releases it has, and which Release each public route
serves. Before anything is served or selected, it reads the artifact bytes and
checks them against the digest the Release recorded.

Use it when you host apps for other people and need three guarantees: a Release
never changes after you create it, a route only serves a Release you explicitly
promoted, and a revoked Release stops serving right away. Team installation,
permissions, billing and execution stay with your host.

## Install or set up

```sh
npm install @fungi.computer/puffball
```

The package is ESM. It depends on `effect` and on [Cairn](../cairn/README.md)
for transition IDs. The core runs anywhere with `Promise` and Web APIs. The
`./cloudflare` adapters run in Cloudflare Workers with D1 and R2 bindings.

You supply two things: a store for catalog records and an artifact reader that
turns an opaque artifact reference into verified bytes. The package ships an
in-memory store for tests and examples, and D1 and R2 adapters for Workers.

## Method discovery

Methods may declare `hidden: true` to omit maintenance operations from Workflow
and Agent/MCP discovery. The marker is preserved in the digest-covered App API;
it grants or denies no direct-call authority. Unmarked methods remain visible.

An API can opt into a dynamic tool namespace with
`toolFamily: { name: "flows", list: "listWorkflowTools", call: "runWorkflow" }`.
The descriptor is signed with the Release. Its listing must be a declared read
method, its call must be discoverable and non-external, and its namespace must
not overlap static methods. Omitting it preserves ordinary API bytes. Inventory
and schema metadata grant no invocation authority.

## App event declarations

An App API may include `events: Record<string, { description, payload }>` beside
`methods`. `payload` is a bounded JSON Schema projection for the whole emitted
payload. Agar generates it from the backend's Zod event schema. Puffball's
`appApiSchema` preserves it through the App declaration and immutable Release
codec, so changes to event metadata change the Release bytes and digest. An API
without events omits the field. Event declarations grant no authority; the host
owns installed-Release selection, emission admission and routing.

Emitting Apps request the `app.events.emit` capability. The maintained
`EVENTS.emit` operation requires that capability, approved explicitly per
installation through the host's existing capability grant. Declaring an event or
binding does not approve emission.

The catalog accepts at most 64 events, names of 1–128 characters, descriptions
of 1–1000 characters, and the same 20,000-byte/depth-16 projection and
256,000-byte total API bounds as method metadata. These are declaration-read
bounds, not event-delivery or retention limits.

## Host attribution for App calls

The runtime-neutral `./app-method-runtime` entry owns `HostActor`,
`WorkflowAttestation`, `AppMethodCallContext` and their maintained parsers.
Actors are members, Agents or Team keys identified by their IDs. The host may
attach a role (`owner` or `member`) and a Workflow attestation containing
`workflowId`, `runId`, `nodeId` and the typed `armedBy` actor. Ordinary calls
omit the Workflow field. The Effect caller decoder delegates to this same
grammar.

These facts come from host admission, separately from App method input. Decoding
validates their representation; it does not grant authority or verify that a run
is active. Invocation and Git owners re-admit the stored actor and run before
effects.

## Native SQLite test adapter

Use the public testing entry with a caller-owned Node SQLite database:

```ts
import { DatabaseSync } from "node:sqlite";
import { APP_RELEASE_D1_FRESH_SCHEMA } from "@fungi.computer/puffball/cloudflare";
import { sqliteD1 } from "@fungi.computer/puffball/testing";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys = ON");
sqlite.exec(APP_RELEASE_D1_FRESH_SCHEMA);
const database = sqliteD1(sqlite);
const apps = await database
  .prepare("SELECT app_id FROM app_release_apps")
  .all();
console.log(apps.results); // []
sqlite.close();
```

The adapter uses the public Watchdog Node SQLite owner. It supplies prepared
statements and atomic batches for tests; it is not a Cloudflare emulator or
isolation boundary. The caller owns schema setup and database lifetime.

## Quick start

This creates an App, a public route, and one Release whose artifact is a small
HTML page, then promotes the Release and reads the page back through the route.
It runs in Node with the in-memory store and a ten-line artifact reader:

```ts
import { createHash } from "node:crypto";
import {
  createAppReleaseCatalog,
  parseAppId,
  parseArtifactRef,
  parseIdempotencyKey,
  parsePublicSurfaceId,
  parseReleaseId,
  parseSha256Digest,
  parseSourceRevision,
  parseStableRoute,
  type ArtifactMediaType,
  type ArtifactReader,
  type ArtifactRef,
} from "@fungi.computer/puffball";
import { createDeterministicMemoryAppReleaseStore } from "@fungi.computer/puffball/effect";

const sha256 = (bytes: Uint8Array) =>
  parseSha256Digest(
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  );

// Two artifacts: the HTML page, and the App root that points at it.
const html = new TextEncoder().encode("<!doctype html><h1>Hello</h1>");
const htmlRef = parseArtifactRef("artifact:hello.ui");
const root = new TextEncoder().encode(
  JSON.stringify({
    format: "fungi-app-v1",
    ui: {
      artifactRef: htmlRef,
      digest: sha256(html),
      version: "v1",
      byteLength: html.byteLength,
      mediaType: "text/html; charset=utf-8",
    },
  }),
);
const rootRef = parseArtifactRef("artifact:hello.release");

// A tiny artifact reader: look the bytes up, hash them, compare digests.
const files = new Map<
  ArtifactRef,
  { bytes: Uint8Array; mediaType: ArtifactMediaType }
>([
  [htmlRef, { bytes: html, mediaType: "text/html; charset=utf-8" }],
  [rootRef, { bytes: root, mediaType: "application/vnd.fungi.app+json" }],
]);
const artifactReader: ArtifactReader = {
  read: async ({ artifactRef, expectedDigest }) => {
    const file = files.get(artifactRef);
    if (file === undefined) return { kind: "missing" };
    const digest = sha256(file.bytes);
    if (digest !== expectedDigest)
      return { kind: "digest-mismatch", actualDigest: digest };
    return {
      kind: "verified",
      digest,
      mediaType: file.mediaType,
      byteLength: file.bytes.byteLength,
      bytes: {
        byteLength: file.bytes.byteLength,
        copy: () => file.bytes.slice(),
      },
    };
  },
};

const catalog = createAppReleaseCatalog({
  artifactReader,
  store: createDeterministicMemoryAppReleaseStore(),
});

const appId = parseAppId("app_hello");
const publicSurfaceId = parsePublicSurfaceId("ps_hello");
const releaseId = parseReleaseId("rel_hello1");
const route = parseStableRoute("/hello");

await catalog.createApp({ appId });
await catalog.createPublicSurface({
  publicSurfaceId,
  appId,
  stableRoute: route,
  publisher: {
    kind: "platform",
    teamId: "team_hello",
    userId: "user_hello",
    requestKey: publicSurfaceId,
  },
});
await catalog.createRelease({
  releaseId,
  appId,
  artifact: {
    artifactRef: rootRef,
    artifactDigest: sha256(root),
    provenance: {
      sourceRevision: parseSourceRevision(`git:${"a".repeat(40)}`),
      sourceTreeDigest: sha256(new TextEncoder().encode("source tree")),
      buildRecipeDigest: sha256(new TextEncoder().encode("build recipe")),
    },
  },
});
await catalog.verifyReleaseArtifact(releaseId);
await catalog.transition({
  kind: "promotion",
  publicSurfaceId,
  releaseId,
  idempotencyKey: parseIdempotencyKey("idem_hello-promote-1"),
});

const website = await catalog.resolvePublicWebsite(route);
console.log(new TextDecoder().decode(website.bytes.copy()));
// <!doctype html><h1>Hello</h1>
```

## Core concepts

### Records

| Record             | Owns                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| App                | Stable global identity registered in the catalog.                     |
| Release            | Immutable App artifact reference, digest and source/build provenance. |
| Public Surface     | An App-owned stable route with an explicit selected Release.          |
| Transition receipt | The recorded result of an operation-scoped selection or revocation.   |

IDs describe identity. They do not grant permission to change that identity.
Each ID has a fixed grammar, such as `app_<a-z0-9>`, `rel_<a-z0-9>`,
`ps_<a-z0-9>`, `artifact:<name>`, `idem_<key>`, `git:<40 hex>`,
`sha256:<64 hex>` and a single-segment route like `/hello`. Parse untrusted
strings with the root `parse*` functions. A rejected value throws
`AppReleaseInputError` naming the parser.

### Entrypoints

The root entrypoint exports `createAppReleaseCatalog`, the `parse*` boundary
parsers, the record types, the error classes and the App declaration vocabulary.
The catalog is a Promise facade over an Effect core. The `./effect` entrypoint
exposes that core (`createAppReleaseCore`), the `decode*` functions and the
in-memory store. Both use the same grammar and decisions.

### App roots

A Release artifact is an App root with media type
`application/vnd.fungi.app+json` and `format: "fungi-app-v1"`. It binds a visual
part (an HTML page or an asset manifest), an optional durable backend artifact,
or both, under one digest-covered description. An App can be visual, headless or
both, but never empty. `./app` builds and parses App roots, `./backend` parses
backend descriptors, and `./assets` parses asset manifests.

Declared capabilities, handlers, roles and commands describe what an App may ask
its host to expose. They do not approve those operations.

### App storage declarations

An App can include bounded keys for its own data in `fungi.app.storage`:

```json
[{ "key": "desktop", "scopes": ["team", "member"], "maxBytes": 16384 }]
```

Each digest-covered declaration allows at most 16 distinct keys. A key matches
`[a-z][a-z0-9.-]{0,63}`; its non-empty scopes are a unique subset of `team` and
`member`, and `maxBytes` is from 1 through 65,536. This requests storage for the
App's own installation data. It grants no access to another App, installation or
Team; the Hub owns scoped admission and write authority.

### Artifact readers

The artifact reader resolves a stored opaque reference and verifies it.
Verification checks the expected digest, content type, configured size bounds
and an owned copy of the bytes. A reader never uses a caller-supplied digest to
find different bytes. Asset manifests also bind object versions, digests,
lengths and a mount base. Your host keeps admission and document isolation.

### Create, verify and select

Create the App before its Releases and Surfaces. A Release or Surface for a
missing App throws `AppReleaseOwnerAppAbsentError` or
`AppReleaseSurfaceOwnerAppAbsentError`. Replaying the same immutable record
returns it. Reusing an identity with changed material fails, and for a Release
that is `AppReleaseImmutableConflictError`.

Creating a Release does not promote it. Verify its artifact, then request an
explicit `promotion` or `rollback` to an eligible Release that belongs to the
App. Unverified, revoked and cross-App selections fail. Retrying a transition
with the same idempotency key and input returns its receipt. Changed input under
that key throws `AppReleaseTransitionIdempotencyConflictError` and leaves the
selection alone.

A `revocation` stops eligible delivery and selection. It does not edit immutable
artifact bytes or decide how a Team restores an installation. Your host's
backend state lifecycle and schema migrations are separate from Release facts.

### Serving selected bytes

`resolvePublicWebsite(route)` takes a canonical stable route, reads the current
selection, verifies the artifact and rechecks authority before returning bytes.
A private cache never skips that recheck. Request bodies, cookies and
caller-supplied Release IDs cannot select unpublished content.

### Cloudflare adapters

`./cloudflare` provides `createD1AppReleaseStore` for catalog state,
`createR2ArtifactReader` for artifact reads, and `APP_RELEASE_D1_FRESH_SCHEMA`
for an empty database. `./cloudflare-assets` reads and verifies asset builds
from R2. `./publisher` holds the schemas for registering an App's source
repository with a publishing Team. The adapters do not provision resources or
supply Team authorization.

## API reference

See the generated [API reference](docs/api/README.md). The entrypoints are
`@fungi.computer/puffball` and its `./effect`, `./app`, `./backend`, `./assets`,
`./cloudflare`, `./cloudflare-assets` and `./publisher` subpaths.

## Examples and checks

### Revoke a Release

Continuing the quick start, revoke the Release. The route stops serving it and
it can no longer be promoted:

```ts
await catalog.transition({
  kind: "revocation",
  releaseId,
  idempotencyKey: parseIdempotencyKey("idem_hello-revoke-1"),
});

await catalog.resolvePublicWebsite(route);
// throws AppReleasePublicWebsiteUnavailableError

await catalog.transition({
  kind: "promotion",
  publicSurfaceId,
  releaseId,
  idempotencyKey: parseIdempotencyKey("idem_hello-promote-2"),
});
// throws AppReleaseTransitionReleaseRevokedError
```

A route with no Surface throws `AppReleasePublicWebsiteNotFoundError`.

### Run on Workers

```ts
import { createAppReleaseCatalog } from "@fungi.computer/puffball";
import {
  createD1AppReleaseStore,
  createR2ArtifactReader,
  type AppReleaseD1Database,
  type AppReleaseR2Bucket,
} from "@fungi.computer/puffball/cloudflare";

type Env = { DB: AppReleaseD1Database; ARTIFACTS: AppReleaseR2Bucket };

export function catalogFor(env: Env) {
  return createAppReleaseCatalog({
    store: createD1AppReleaseStore(env.DB),
    artifactReader: createR2ArtifactReader(env.ARTIFACTS),
  });
}
```

The R2 reader uses the artifact reference as the object key and the object's
`contentType` as its media type.

### Local website demo

From a checkout, a self-checking demo serves a fixture App over loopback HTTP,
checks that cold and warm reads return the same bytes, then revokes the Release
and checks that it stops serving. It needs no provider credentials:

```sh
pnpm --filter @fungi.computer/puffball demo:a1.2:self-check
```

`demo:a1.2` runs it interactively: open the printed `/orchid` URL, press `r` to
revoke and `q` or Ctrl-C to quit. The demo's Fetch adapter serves the canonical
GET path, returns 404 for malformed or unselected routes, 503 for unsafe
delivery and 405 for other methods. Those statuses belong to the demo, not to
every host's HTTP contract.

The test suite covers create and replay, transitions, idempotency conflicts and
public website delivery, plus native Cloudflare proofs for reconstruction,
storage and receipt conflicts, and lifecycle races:

```sh
pnpm --filter @fungi.computer/puffball test
```

## Limits and errors

- The default artifact policy accepts artifacts up to 65,536 bytes. Pass
  `artifactPolicy: { maxBytes, maxManifestBytes }` to `createAppReleaseCatalog`
  to change it.
- Every failure is a named error class exported from the root, such as
  `AppReleaseInputError`, `AppReleaseImmutableConflictError`,
  `AppReleaseArtifactDigestMismatchError`,
  `AppReleaseTransitionReleaseUnverifiedError`,
  `AppReleaseTransitionIdempotencyConflictError`,
  `AppReleasePublicWebsiteNotFoundError` and
  `AppReleasePublicWebsiteUnavailableError`.
- A store that returns a malformed result causes
  `AppReleaseInvalidStoreResultError`. An unreachable store causes
  `AppReleaseStoreUnavailableError`.
- The catalog does not deploy, configure domains, build from source or publish.
  Those stay with your host.

## Contribute and license

MIT. See [LICENSE](LICENSE).

`@fungi.computer/puffball/app-event-facts` owns the canonical App EventSink
input and saved host-fact decoders. `git-representation` owns repository-name,
SHA-1, ref-update and push-event-id schemas shared with Agar. These decode
representations; they do not admit callers or grant Git access.

Background work uses `@fungi.computer/puffball/background-replay`. A host calls
`backgroundContext` with the verified method name/effect, actual invocation
ancestry and a host-sealed `backgroundOrigin`. An App checks
`mayEnqueueBackground` on that host-supplied context and retains the origin with
the accepted job; a replay never gets enqueue eligibility. Agents, keys,
Workflow nodes and nested calls keep their work in the foreground. A wake
retains only the member identity and observed revisions. `readmitBackground`
resolves the member and re-admits the declared `backend.sync.method` on every
delivery. That ordinary write method must cover every write method's capability
requirements. An unavailable installation is a host dead letter; a
still-available refused lane may receive `syncRefused` with no binding grants.

The host derives its non-extractable signing key with `backgroundOriginKey` and
seals the Instance, member lane and verified foreground method with
`sealBackgroundOrigin`. In a replay, `BACKGROUND.admit` checks the claimed job's
retained origin against freshly admitted methods. Each frame permits one check:
other capability effects wait for its admitted decision, while `APP_STORAGE`
remains available for claiming and settling. A refused claim returns
`{kind: "refused", code: "access_changed"}` before those effects; the App cannot
declare the host-only `BACKGROUND` binding.
