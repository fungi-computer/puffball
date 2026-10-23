import type { AppCapabilityId } from "./app-vocabulary.js";

/** Shared broker class, permission and effect metadata for a binding operation. */
export type BindingOperationDefinition = Readonly<{
  cap: string;
  requires: readonly AppCapabilityId[];
  effect: "read" | "write";
}>;
/** The runtime-neutral registry shared by declarations, admission and Exec. */
export const appBackendBindingKinds = {
  BACKGROUND: {
    name: "BACKGROUND",
    operations: {
      admit: { cap: "app.background.admit", requires: [], effect: "read" },
    },
  },
  GIT: {
    name: "GIT",
    operations: {
      create: {
        cap: "app.git.create",
        requires: ["git.repository"],
        effect: "write",
      },
      fork: {
        cap: "app.git.fork",
        requires: ["git.repository"],
        effect: "write",
      },
      read: {
        cap: "app.git.read",
        requires: ["git.repository"],
        effect: "read",
      },
      write: {
        cap: "app.git.write",
        requires: ["git.repository"],
        effect: "write",
      },
      exchange: {
        cap: "app.git.exchange",
        requires: ["git.repository"],
        effect: "write",
      },
    },
  },
  EVENTS: {
    name: "EVENTS",
    operations: {
      emit: {
        cap: "app.events.emit",
        requires: ["app.events.emit"],
        effect: "write",
      },
    },
  },
  APPS: {
    name: "APPS",
    operations: {
      /** Register the calling installation's repository as an App from its
       * exact main manifest. No Computer execution or installation is implied. */
      register: {
        cap: "app.register",
        requires: ["git.repository"],
        effect: "write",
      },
      /** Read the captured installation's registered repository identity. */
      repository: {
        cap: "app.catalog.read",
        requires: ["git.repository"],
        effect: "read",
      },
      build: {
        cap: "app.build",
        requires: ["git.repository", "computer.execute"],
        effect: "write",
      },
      /** Read one build job's current status; the host re-checks the caller
       * is the owner. An operation is granted only through approved
       * capabilities, so it needs the ones its build was admitted with. */
      buildStatus: {
        cap: "app.build",
        requires: ["git.repository", "computer.execute"],
        effect: "read",
      },
      /** Install a Release at an installation id, or switch a live one onto
       * it; the host re-checks the caller is the owner. It completes the
       * build-and-install loop, under the capabilities a build needs. */
      select: {
        cap: "app.select",
        requires: ["git.repository", "computer.execute"],
        effect: "write",
      },
      catalog: {
        cap: "app.catalog.read",
        requires: ["team.workbenchHost"],
        effect: "read",
      },
      /** Fork a platform App's published source into its own Team-owned App,
       * as a repository in the calling installation's Git. */
      fork: {
        cap: "app.fork",
        requires: ["git.repository"],
        effect: "write",
      },
    },
  },
  WORKFLOWS: {
    name: "WORKFLOWS",
    operations: {
      /** The member's callable App methods, for an editor's palette. */
      catalog: {
        cap: "app.workflow.read",
        requires: ["workflow.run"],
        effect: "read",
      },
      /** Compile and start a definition as the member on the pinned Computer. */
      runGraph: {
        cap: "app.workflow.run",
        requires: ["workflow.run"],
        effect: "write",
      },
      armSchedule: {
        cap: "app.workflow.run",
        requires: ["workflow.run", "workflow.arm"],
        effect: "write",
      },
      disarmSchedule: {
        cap: "app.workflow.run",
        requires: ["workflow.run", "workflow.arm"],
        effect: "write",
      },
      schedules: {
        cap: "app.workflow.read",
        requires: ["workflow.run"],
        effect: "read",
      },
      armEventTrigger: {
        cap: "app.workflow.run",
        requires: ["workflow.run", "workflow.arm"],
        effect: "write",
      },
      disarmEventTrigger: {
        cap: "app.workflow.run",
        requires: ["workflow.run", "workflow.arm"],
        effect: "write",
      },
      eventTriggers: {
        cap: "app.workflow.read",
        requires: ["workflow.run"],
        effect: "read",
      },
      /** A person's answer to one of a run's reviews; Agents never answer. */
      cancel: {
        cap: "app.workflow.run",
        requires: ["workflow.run"],
        effect: "write",
      },
      answerReview: {
        cap: "app.workflow.run",
        requires: ["workflow.run"],
        effect: "write",
      },
      /** One of the member's runs: node events, reviews and engine status. */
      graphStatus: {
        cap: "app.workflow.read",
        requires: ["workflow.run"],
        effect: "read",
      },
      /** Up to 50 runs of this library, newest first; source and initiator included. */
      runs: {
        cap: "app.workflow.read",
        requires: ["workflow.run"],
        effect: "read",
      },
    },
  },
  APP_STORAGE: {
    name: "APP_STORAGE",
    operations: {
      read: {
        cap: "app.storage.read",
        requires: ["app.storage"],
        effect: "read",
      },
      write: {
        cap: "app.storage.write",
        requires: ["app.storage"],
        effect: "write",
      },
      reset: {
        cap: "app.storage.write",
        requires: ["app.storage"],
        effect: "write",
      },
    },
  },
  MEDIA: {
    name: "MEDIA",
    operations: {
      models: {
        cap: "app.media.read",
        requires: ["media.generation"],
        effect: "read",
      },
      generate: {
        cap: "app.media.generate",
        requires: ["media.generation", "computer.writeFile"],
        effect: "write",
      },
    },
  },
  COMPUTER: {
    name: "COMPUTER",
    operations: {
      list: {
        cap: "app.computer.read",
        requires: ["computer.list"],
        effect: "read",
      },
      read: {
        cap: "app.computer.read",
        requires: ["computer.readFile"],
        effect: "read",
      },
      ports: {
        cap: "app.computer.read",
        requires: ["computer.execute"],
        effect: "read",
      },
      processes: {
        cap: "app.computer.read",
        requires: ["computer.execute"],
        effect: "read",
      },
      write: {
        cap: "app.computer.write",
        requires: ["computer.writeFile"],
        effect: "write",
      },
      preview: {
        cap: "app.computer.exec",
        requires: ["computer.execute"],
        effect: "write",
      },
      processKill: {
        cap: "app.computer.exec",
        requires: ["computer.execute"],
        effect: "write",
      },
      processStart: {
        cap: "app.computer.exec",
        requires: ["computer.execute"],
        effect: "write",
      },
      exec: {
        cap: "app.computer.exec",
        requires: ["computer.execute"],
        effect: "write",
      },
    },
  },
  INBOX: {
    name: "INBOX",
    operations: {
      page: { cap: "inbox.read", requires: ["agent.read"], effect: "read" },
      visit: { cap: "inbox.visit", requires: ["agent.read"], effect: "write" },
    },
  },
  AGENTS: {
    name: "AGENTS",
    operations: {
      list: { cap: "agent.list", requires: ["agent.list"], effect: "read" },
      send: { cap: "agent.send", requires: ["agent.send"], effect: "write" },
    },
  },
} as const satisfies Readonly<
  Record<
    string,
    {
      name: string;
      operations: Readonly<Record<string, BindingOperationDefinition>>;
    }
  >
>;
/** A registered backend binding kind. */
export type AppBackendBindingName = keyof typeof appBackendBindingKinds;
/** One author-selected binding; its operation names are checked by the registry decoder. */
export type AppBackendBinding = Readonly<{
  name: AppBackendBindingName;
  operations: readonly string[];
}>;
/** RPC method names exposed by the registered kinds. */
export type AppBackendBindingMethod = {
  [
    Kind in AppBackendBindingName
  ]: keyof (typeof appBackendBindingKinds)[Kind]["operations"];
}[AppBackendBindingName];
/** The required permissions, effect and broker class of a registered operation. */
export type AppBackendBindingOperation = {
  [
    Kind in AppBackendBindingName
  ]: (typeof appBackendBindingKinds)[Kind]["operations"][keyof (typeof appBackendBindingKinds)[Kind]["operations"]];
}[AppBackendBindingName];
