import { createHash } from "node:crypto";
import { parseArtifactRef, parseSha256Digest } from "../src/index.js";
import {
  type AppGillDesktopSize,
  type AppDeclaredGill,
} from "@fungi.computer/gills";
import { backendMediaType } from "../src/backend.js";
import * as Schema from "effect/Schema";
import { expect, it } from "vitest";
import { appBuildJsonSchema, createAppBuild } from "../src/app.js";

it.each(["rows", "surface"] as const)(
  "covers %s view and desktop choices with the Release root bytes",
  (view) => {
    const root = (sizes: readonly AppGillDesktopSize[], title = "Inbox") => {
      const gill: AppDeclaredGill =
        view === "rows"
          ? {
              id: "inbox",
              title,
              view,
              source: "listInbox",
              desktop: { sizes },
            }
          : { id: "inbox", title, view, desktop: { sizes } };
      return createAppBuild(
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
          gills: [gill],
        },
      );
    };
    const encode = Schema.encodeSync(appBuildJsonSchema);
    const small = encode(root(["S"]));
    const large = encode(root(["L"]));
    expect(
      Schema.decodeUnknownSync(appBuildJsonSchema)(large).declaration
        ?.gills?.[0]?.desktop?.sizes,
    ).toEqual(["L"]);
    const digest = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    expect(digest(small)).not.toBe(digest(large));
    expect(digest(small)).not.toBe(digest(encode(root(["S"], "Renamed"))));
    expect(
      Schema.decodeUnknownSync(appBuildJsonSchema)(small).declaration
        ?.gills?.[0]?.view,
    ).toBe(view);
  },
);
