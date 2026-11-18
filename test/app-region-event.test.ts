import { describe, expect, it } from "vitest";
import {
  appRegionEventSchema,
  appRegionReplySchema,
  maxAppRegionMessageBytes,
  maxAppRegionReplyBytes,
} from "../src/backend.js";

const caller = {
  scope: { kind: "team", teamId: "team_one" },
  actor: { kind: "member", memberId: "member_one" },
  computerId: null,
} as const;

describe("App Region events", () => {
  it("delivers a connect only with the host-stamped caller", () => {
    expect(
      appRegionEventSchema.parse({ kind: "connect", connection: "c1", caller }),
    ).toEqual({ kind: "connect", connection: "c1", caller });
    expect(() =>
      appRegionEventSchema.parse({ kind: "connect", connection: "c1" }),
    ).toThrow();
    const unscoped = {
      actor: caller.actor,
      computerId: caller.computerId,
    };
    expect(() =>
      appRegionEventSchema.parse({
        kind: "connect",
        connection: "c1",
        caller: unscoped,
      }),
    ).toThrow();
  });

  it("carries messages, closes and alarms without any caller authority", () => {
    for (const event of [
      { kind: "message", connection: "c1", data: "hello" },
      { kind: "close", connection: "c1" },
      { kind: "alarm" },
    ])
      expect(appRegionEventSchema.parse(event)).toEqual(event);
    expect(() =>
      appRegionEventSchema.parse({ kind: "alarm", caller }),
    ).toThrow();
    expect(() =>
      appRegionEventSchema.parse({
        kind: "message",
        connection: "c1",
        data: "x".repeat(maxAppRegionMessageBytes + 1),
      }),
    ).toThrow();
  });

  it("bounds what the App may ask the supervisor to do", () => {
    const reply = {
      send: [{ connection: "c1", data: "tick" }],
      close: ["c2"],
      wakeAt: 1_000,
    };
    expect(appRegionReplySchema.parse(reply)).toEqual(reply);
    expect(appRegionReplySchema.parse({})).toEqual({});
    expect(appRegionReplySchema.parse({ wakeAt: null })).toEqual({
      wakeAt: null,
    });
    for (const bad of [
      { wakeAt: 0 },
      { wakeAt: 1.5 },
      {
        send: Array.from({ length: 257 }, () => ({
          connection: "c",
          data: "",
        })),
      },
      { send: [{ connection: "", data: "x" }] },
      { namespace: "INSTANCES" },
    ])
      expect(() => appRegionReplySchema.parse(bad)).toThrow();
  });

  it("bounds the total bytes one reply may send, well below 256 full frames", () => {
    expect(maxAppRegionReplyBytes).toBeLessThan(256 * maxAppRegionMessageBytes);
    const frame = "x".repeat(maxAppRegionMessageBytes);
    const frames = maxAppRegionReplyBytes / maxAppRegionMessageBytes;
    const send = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        connection: `c${String(index)}`,
        data: frame,
      }));
    expect(
      appRegionReplySchema.parse({ send: send(frames) }).send,
    ).toHaveLength(frames);
    expect(() =>
      appRegionReplySchema.parse({ send: send(frames + 1) }),
    ).toThrow();
  });
});
