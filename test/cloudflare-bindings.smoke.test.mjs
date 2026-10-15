import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("App Release Cloudflare bindings", () => {
  it("uses local D1 and R2 bindings inside Workerd", async () => {
    await env.APP_RELEASE_CATALOG.exec(
      "CREATE TABLE releases (release_id TEXT PRIMARY KEY, artifact_ref TEXT NOT NULL) STRICT",
    );

    await env.APP_RELEASE_CATALOG.prepare(
      "INSERT INTO releases (release_id, artifact_ref) VALUES (?, ?)",
    )
      .bind("rel_smoke", "artifact:smoke")
      .run();

    const release = await env.APP_RELEASE_CATALOG.prepare(
      "SELECT release_id, artifact_ref FROM releases WHERE release_id = ?",
    )
      .bind("rel_smoke")
      .first();

    expect(release).toEqual({
      release_id: "rel_smoke",
      artifact_ref: "artifact:smoke",
    });

    const expectedBytes = new globalThis.TextEncoder().encode(
      "<!doctype html><p>smoke</p>",
    );
    await env.APP_RELEASE_ARTIFACTS.put("artifact-smoke", expectedBytes);

    const artifact = await env.APP_RELEASE_ARTIFACTS.get("artifact-smoke");
    expect(artifact).not.toBeNull();

    const bodyBytes = new Uint8Array(await artifact.arrayBuffer());
    expect(bodyBytes).toEqual(expectedBytes);
  });
});
