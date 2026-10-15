import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  appBuildJsonSchema,
  appMediaType,
  type AppBackendBuild,
  type AppDescription,
  type AppUiBuild,
} from "../app.js";
import { emptyAppDeclaration } from "../app-vocabulary.js";
import { backendJsonSchema, backendMediaType } from "../backend.js";
import type { AppReleaseArtifactReader } from "./app-release-artifact-reader.js";
import type {
  ArtifactVerificationIntent,
  VerifiedAppArtifactReference,
  VerifiedAppDescription,
  VerifiedBackendProfile,
} from "./app-release-contract.js";
import {
  readVerifiedArtifactSnapshot,
  type ArtifactSnapshotPolicy,
  type VerifiedArtifactSnapshot,
  type VerifiedArtifactSnapshotFailure,
} from "./verified-artifact-snapshot.js";

/** Resolve only the closed code children; ordinary use never loads the UI's asset tree. */
export function readAppDescription(
  reader: AppReleaseArtifactReader,
  root: VerifiedArtifactSnapshot,
  policy: ArtifactSnapshotPolicy,
  verification?: ArtifactVerificationIntent,
): Effect.Effect<AppDescription, VerifiedArtifactSnapshotFailure> {
  return readVerifiedAppDescription(reader, root, policy, verification).pipe(
    Effect.map(({ description }) => description),
  );
}

/**
 * Decode and normalize a verified App root for publication persistence.
 */
export function readVerifiedAppDescription(
  reader: AppReleaseArtifactReader,
  root: VerifiedArtifactSnapshot,
  policy: ArtifactSnapshotPolicy,
  verification?: ArtifactVerificationIntent,
): Effect.Effect<
  {
    readonly description: AppDescription;
    readonly metadata: VerifiedAppDescription;
  },
  VerifiedArtifactSnapshotFailure
> {
  return Effect.gen(function* () {
    if (root.mediaType !== appMediaType) {
      return yield* Effect.fail(invalid());
    }
    const app = yield* Schema.decodeUnknownEffect(appBuildJsonSchema)(
      new TextDecoder().decode(root.bytes.copy()),
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError(invalid));
    const ui = "ui" in app ? yield* readChild(app.ui) : null;
    const backend = "backend" in app ? yield* readChild(app.backend) : null;
    const description = yield* describe(ui, backend);
    const metadataBackend =
      "backend" in app
        ? yield* describeVerifiedBackend(app.backend, description.backend)
        : null;
    return {
      description,
      metadata: {
        format: "fungi-app-v1",
        ui: "ui" in app ? referenceFromBuild(app.ui) : null,
        backend: metadataBackend,
        declaration: app.declaration ?? emptyAppDeclaration,
      },
    };
  });

  function readChild(child: AppUiBuild | AppBackendBuild) {
    const expected = {
      artifactRef: child.artifactRef,
      expectedDigest: child.digest,
      expectedObject: {
        version: child.version,
        byteLength: child.byteLength,
      },
    };
    const input =
      verification === undefined ? expected : { ...expected, verification };
    return readVerifiedArtifactSnapshot(reader, input, policy).pipe(
      Effect.flatMap((snapshot) =>
        snapshot.mediaType === child.mediaType &&
        snapshot.byteLength === child.byteLength
          ? Effect.succeed(snapshot)
          : Effect.fail(invalid()),
      ),
    );
  }
}

function describeVerifiedBackend(
  build: AppBackendBuild,
  backend: AppDescription["backend"],
): Effect.Effect<
  NonNullable<VerifiedAppDescription["backend"]>,
  VerifiedArtifactSnapshotFailure
> {
  if (backend === null) return Effect.fail(invalid());
  return Effect.succeed({
    artifact: referenceFromBuild(build),
    profile: profileFromDescriptor(backend),
  });
}

function referenceFromBuild(
  child: AppUiBuild | AppBackendBuild,
): VerifiedAppArtifactReference {
  return {
    artifactRef: child.artifactRef,
    digest: child.digest,
    mediaType: child.mediaType,
    version: child.version,
    byteLength: child.byteLength,
  };
}

function profileFromDescriptor(
  backend: NonNullable<AppDescription["backend"]>,
): VerifiedBackendProfile {
  const descriptor = backend.descriptor;
  return {
    runtime: descriptor.runtime,
    compatibilityDate: descriptor.compatibilityDate,
    exportName: descriptor.exportName,
  };
}

function describe(
  root: VerifiedArtifactSnapshot | null,
  backend: VerifiedArtifactSnapshot | null,
): Effect.Effect<AppDescription, VerifiedArtifactSnapshotFailure> {
  return Effect.gen(function* () {
    const ui =
      root !== null &&
      (root.mediaType === "text/html; charset=utf-8" ||
        root.mediaType === "application/vnd.fungi.app-assets+json")
        ? { ...root, mediaType: root.mediaType }
        : null;
    const code = root?.mediaType === backendMediaType ? root : backend;
    const descriptor =
      code === null
        ? null
        : yield* Schema.decodeUnknownEffect(backendJsonSchema)(
            new TextDecoder().decode(code.bytes.copy()),
            { onExcessProperty: "error" },
          ).pipe(Effect.mapError(invalid));
    return {
      ui,
      backend:
        code !== null && descriptor !== null
          ? { digest: code.digest, descriptor }
          : null,
    };
  });
}

function invalid(): VerifiedArtifactSnapshotFailure {
  return { kind: "invalid-snapshot" };
}
