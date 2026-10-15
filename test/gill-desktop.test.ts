import { createHash } from "node:crypto";
import { parseArtifactRef, parseSha256Digest } from "../src/index.js";
import { type AppGillDesktopSize } from "@fungi.computer/gills";
import { backendMediaType } from "../src/backend.js";
import * as Schema from "effect/Schema";
import { expect, it } from "vitest";
import { appBuildJsonSchema, createAppBuild } from "../src/app.js";

it("covers desktop size choices with the Release root bytes", () => {
  const root = (sizes: readonly AppGillDesktopSize[]) =>
    createAppBuild(
      null,
      {
        artifactRef: parseArtifactRef("artifact:inbox.backend"),
        digest: parseSha256Digest(`sha256:${"a".repeat(64)}`),
        version: "backend-v1",
        byteLength: 1,
        mediaType: backendMediaType,
      },
      {
        capabilities: [],
        handlers: [],
        roles: [],
        gills: [
          {
            id: "inbox",
            title: "Inbox",
            source: "listInbox",
            desktop: { sizes },
          },
        ],
      },
    );
  const encode = Schema.encodeSync(appBuildJsonSchema);
  const small = encode(root(["S"]));
  const large = encode(root(["L"]));
  expect(
    Schema.decodeUnknownSync(appBuildJsonSchema)(large).declaration?.gills?.[0]
      ?.desktop?.sizes,
  ).toEqual(["L"]);
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  expect(digest(small)).not.toBe(digest(large));
});
