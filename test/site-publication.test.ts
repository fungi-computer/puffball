import { expect, it } from "vitest";
import * as Schema from "effect/Schema";
import {
  siteBundleSchema,
  siteNameSchema,
  sitePublicationLimits,
} from "../src/publisher.js";

const object = { digest: `sha256:${"a".repeat(64)}`, byteLength: 1 };
const accepts = Schema.is(siteBundleSchema);

it("accepts built static output and a single Worker within capture bounds", () => {
  expect(
    accepts({
      kind: "static",
      files: [
        { path: "index.html", ...object },
        { path: "images/icon.png", ...object },
      ],
    }),
  ).toBe(true);
  expect(accepts({ kind: "worker", entry: object })).toBe(true);
  expect(Schema.is(siteNameSchema)("for-sam_2.0")).toBe(true);
  expect(Schema.is(siteNameSchema)("../other")).toBe(false);
});

it("requires one index, unique artifact-local paths and built static media", () => {
  for (const path of [
    "/index.html",
    "../index.html",
    "a/../index.html",
    "a\\index.html",
    "a//index.html",
    "server.ts",
  ]) {
    expect(
      accepts({
        kind: "static",
        files: [
          { path: "index.html", ...object },
          { path, ...object },
        ],
      }),
      path,
    ).toBe(false);
  }
  expect(
    accepts({
      kind: "static",
      files: [
        { path: "index.html", ...object },
        { path: "index.html", ...object },
      ],
    }),
  ).toBe(false);
  expect(
    accepts({ kind: "static", files: [{ path: "style.css", ...object }] }),
  ).toBe(false);
});

it("bounds file count, per-file bytes and total bytes before native publication", () => {
  const files = Array.from(
    { length: sitePublicationLimits.files + 1 },
    (_, index) => ({
      path: index === 0 ? "index.html" : `${String(index)}.txt`,
      ...object,
    }),
  );
  expect(accepts({ kind: "static", files })).toBe(false);
  expect(
    accepts({
      kind: "worker",
      entry: { ...object, byteLength: sitePublicationLimits.fileBytes + 1 },
    }),
  ).toBe(false);
  expect(
    accepts({
      kind: "static",
      files: Array.from({ length: 6 }, (_, index) => ({
        path: index === 0 ? "index.html" : `${String(index)}.txt`,
        ...object,
        byteLength: sitePublicationLimits.fileBytes,
      })),
    }),
  ).toBe(false);
});
