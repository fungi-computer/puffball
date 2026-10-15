import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import { createContext, Script } from "node:vm";

import { expect, it } from "vitest";

import { scaledBudgetMs } from "../../../tooling/repository/scripts/proof-budget.mjs";
import { launchA12PublicWebsite } from "../examples/a1-2-public-website.js";

type ProcessResult = Readonly<{
  readonly signal: NodeJS.Signals | null;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}>;

type ProcessCapture = Readonly<{
  readonly finish: Promise<ProcessResult>;
  readonly observe: (observer: (output: string) => void) => () => void;
}>;

type ProcessObservation = {
  stop: () => void;
};

type InteractiveLauncher = Readonly<{
  readonly finish: Promise<ProcessResult>;
  readonly interrupt: () => void;
  readonly readyUrl: Promise<string>;
  readonly revoke: () => Promise<void>;
  readonly send: (input: string) => void;
  readonly stop: () => void;
}>;

const launcherLaw =
  "A1.2 launcher serves cold and warm, revokes on r, and exits cleanly";
const launcherArtifactDigestLaw =
  "A1.2 launcher binds its Release digest to the served Orchid bytes";
const visibleReleaseDigestLaw =
  "A1.2 page displays the exact digest of its served Release bytes";
const launcherOperationCoalescingLaw =
  "A1.2 launcher coalesces concurrent revoke and close operations";
const knownOrchidDigest =
  "sha256:d7c4d301a1300526fe774cd00c1076b5c137f1352763a4da8a9ae9b1c9f3a22d";
const orchidUrlPattern = /^http:\/\/127\.0\.0\.1:\d+\/orchid$/u;

function launcherCommand(args: readonly string[] = []): readonly string[] {
  return [
    "--import",
    "tsx",
    "packages/puffball/examples/a1-2-public-website.ts",
    ...args,
  ];
}

function observeProcess(child: ChildProcessWithoutNullStreams): ProcessCapture {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const observers = new Set<(output: string) => void>();
  let output = "";
  const append = (chunks: Buffer[]) => (chunk: Buffer) => {
    chunks.push(chunk);
    output += chunk.toString("utf8");
    for (const observer of observers) observer(output);
  };
  child.stdout.on("data", append(stdout));
  child.stderr.on("data", append(stderr));
  const finish = new Promise<ProcessResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => {
      resolve({
        status,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
  return {
    finish,
    observe: (observer) => {
      observers.add(observer);
      observer(output);
      return () => observers.delete(observer);
    },
  };
}

function startInteractiveLauncher(signal: AbortSignal): InteractiveLauncher {
  const child = spawn(process.execPath, launcherCommand(), {
    cwd: repositoryRoot(),
    stdio: "pipe",
    signal,
  });
  const capture = observeProcess(child);
  const readyUrl = waitForLauncherOutput(
    capture,
    /^http:\/\/127\.0\.0\.1:\d+\/orchid$/mu,
    "ready URL",
    signal,
  );

  return {
    finish: capture.finish,
    interrupt: () => {
      if (!child.killed) child.kill("SIGINT");
    },
    readyUrl,
    revoke: async () => {
      const revoked = waitForLauncherOutput(
        capture,
        /^Orchid revoked$/mu,
        "revocation acknowledgement",
        signal,
      );
      child.stdin.write("r\n");
      await revoked;
    },
    send: (input) => child.stdin.write(input),
    stop: () => {
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}

/** Observe completed operations, bounded by the test's existing total deadline. */
function waitForLauncherOutput(
  capture: ProcessCapture,
  pattern: RegExp,
  description: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const completion = { settled: false };
    const observation: ProcessObservation = { stop: () => undefined };
    const cleanup = () => {
      observation.stop();
      signal.removeEventListener("abort", aborted);
    };
    const fail = (error: Error) => {
      if (completion.settled) return;
      completion.settled = true;
      cleanup();
      reject(error);
    };
    const aborted = () => {
      fail(
        new Error(`Launcher cancelled while waiting for ${description}`, {
          cause: signal.reason,
        }),
      );
    };
    // close, unlike exit, guarantees the process's stdout has been drained.
    void capture.finish.then(({ status, signal: exitSignal }) => {
      fail(
        new Error(
          `Launcher closed before ${description}: status=${String(status)}, signal=${String(exitSignal)}`,
        ),
      );
    }, fail);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) {
      aborted();
      return;
    }
    observation.stop = capture.observe((output) => {
      const match = pattern.exec(output);
      if (completion.settled || match === null) return;
      completion.settled = true;
      cleanup();
      resolve(match[0]);
    });
    // observe replays already-buffered output synchronously.
    if (completion.settled) observation.stop();
  });
}

async function runSelfCheck(signal: AbortSignal): Promise<ProcessResult> {
  const child = spawn(process.execPath, launcherCommand(["--self-check"]), {
    cwd: repositoryRoot(),
    stdio: "pipe",
    signal,
  });
  return observeProcess(child).finish;
}

function repositoryRoot(): string {
  return new URL("../../..", import.meta.url).pathname;
}

async function observePageReleaseDigest(input: {
  readonly bytes: Uint8Array;
  readonly html: string;
  readonly url: string;
}): Promise<string | undefined> {
  const staticDigest = /sha256:[0-9a-f]{64}/u.exec(input.html)?.[0];
  const elementMatch =
    /<([a-z][a-z0-9-]*)\b([^>]*)\bdata-release-digest(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*>([\s\S]*?)<\/\1>/iu.exec(
      input.html,
    );
  if (elementMatch === null) return staticDigest;

  const attributes = elementMatch[2] ?? "";
  const idMatch = /\bid=(?:"([^"]+)"|'([^']+)')/iu.exec(attributes);
  const elementId = idMatch?.[1] ?? idMatch?.[2];
  const element = {
    textContent: (elementMatch[3] ?? "").replace(/<[^>]*>/gu, "").trim(),
  };
  const initialText = element.textContent;
  const document = {
    getElementById: (id: string) => (id === elementId ? element : null),
    querySelector: (selector: string) =>
      selector === "[data-release-digest]" ||
      (elementId !== undefined && selector === `#${elementId}`)
        ? element
        : null,
  };
  const pageUrl = new URL(input.url).href;
  const fetchPage = (request: Request | string | URL): Promise<Response> => {
    const requestedUrl =
      request instanceof Request
        ? request.url
        : new URL(request.toString(), pageUrl).href;
    if (requestedUrl !== pageUrl) {
      throw new Error("the Orchid page requested bytes outside its own URL");
    }
    return Promise.resolve(
      new Response(input.bytes.slice(), {
        headers: { "content-type": "text/html; charset=utf-8" },
        status: 200,
      }),
    );
  };
  const browserGlobal = {
    ArrayBuffer,
    crypto: webcrypto,
    document,
    fetch: fetchPage,
    location: new URL(pageUrl),
    Request,
    Response,
    setTimeout,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    URL,
  };
  const context = createContext(browserGlobal);
  const inlineScripts = Array.from(
    input.html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/giu),
    (match) => match[1] ?? "",
  );
  for (const source of inlineScripts) {
    const result: unknown = new Script(
      `(async () => {\n${source}\n})()`,
    ).runInContext(context);
    await Promise.resolve(result);
  }
  const deadline = Date.now() + 1_000;
  while (element.textContent === initialText && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return /sha256:[0-9a-f]{64}/u.exec(element.textContent)?.[0];
}

it(visibleReleaseDigestLaw, async () => {
  const launcher = await launchA12PublicWebsite();
  try {
    const response = await fetch(launcher.url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const actualDigest = `sha256:${createHash("sha256")
      .update(bytes)
      .digest("hex")}`;
    const displayedDigest = await observePageReleaseDigest({
      bytes,
      html: new TextDecoder().decode(bytes),
      url: launcher.url,
    });

    expect(displayedDigest).toBe(actualDigest);
  } finally {
    await launcher.close();
  }
});

it(launcherOperationCoalescingLaw, async () => {
  const launcher = await launchA12PublicWebsite();
  try {
    const firstRevoke = launcher.revoke();
    const secondRevoke = launcher.revoke();
    const revokeWasCoalesced = secondRevoke === firstRevoke;
    await Promise.all([firstRevoke, secondRevoke]);
    const revoked = await fetch(launcher.url);

    const firstClose = launcher.close();
    const secondClose = launcher.close();
    const closeWasCoalesced = secondClose === firstClose;
    await Promise.all([firstClose, secondClose]);
    await expect(fetch(launcher.url)).rejects.toBeInstanceOf(TypeError);

    expect({
      closeWasCoalesced,
      revokeWasCoalesced,
      revokedStatus: revoked.status,
    }).toEqual({
      closeWasCoalesced: true,
      revokeWasCoalesced: true,
      revokedStatus: 503,
    });
  } finally {
    await launcher.close();
  }
});

it(launcherArtifactDigestLaw, async () => {
  const launcher = await launchA12PublicWebsite();
  try {
    const response = await fetch(launcher.url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const actualDigest = `sha256:${createHash("sha256")
      .update(bytes)
      .digest("hex")}`;

    expect(actualDigest).toBe(knownOrchidDigest);
    expect(launcher.digest).toBe(knownOrchidDigest);
  } finally {
    await launcher.close();
  }
});

it(
  launcherLaw,
  async ({ signal }) => {
    const interactive = startInteractiveLauncher(signal);
    try {
      const orchidUrl = await interactive.readyUrl;
      expect(orchidUrl).toMatch(orchidUrlPattern);

      const cold = await fetch(orchidUrl, { signal });
      const warm = await fetch(orchidUrl, { signal });
      expect(cold.status).toBe(200);
      expect(warm.status).toBe(200);
      expect(cold.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(warm.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const coldHtml = await cold.text();
      expect(await warm.text()).toBe(coldHtml);
      expect(coldHtml).toContain("Orchid");
      expect(coldHtml).toContain("sha256:");

      await interactive.revoke();
      const revoked = await fetch(orchidUrl, { signal });
      expect(revoked.status).toBe(503);
      const unavailableHtml = await revoked.text();
      expect(unavailableHtml).toContain("Unavailable");
      expect(unavailableHtml).not.toContain(coldHtml);

      interactive.send("q\n");
      await expect(interactive.finish).resolves.toMatchObject({
        signal: null,
        status: 0,
      });

      await expect(runSelfCheck(signal)).resolves.toMatchObject({
        signal: null,
        status: 0,
      });

      const interrupted = startInteractiveLauncher(signal);
      try {
        expect(await interrupted.readyUrl).toMatch(orchidUrlPattern);
        interrupted.interrupt();
        const interruptedResult = await interrupted.finish;
        expect(interruptedResult).toMatchObject({
          signal: null,
          status: 0,
        });
      } finally {
        interrupted.stop();
      }
    } finally {
      interactive.stop();
    }
  },
  scaledBudgetMs(20_000),
);
