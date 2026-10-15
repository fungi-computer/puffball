import type { AppDeclaredGill } from "@fungi.computer/gills";
/**
 * Roles a user may assign to an App: the shell routes "open my inbox", file
 * navigation, media and Session conversations to the App the Team chose.
 * `dashboard` marks an App that can open as a Team's dashboard; the Team's
 * shell selection, not a role choice, picks among them.
 * Extend this list here; the Hub role projection then requires the new role.
 * A role's intent and payload wire format lives in `@fungi.computer/agar/roles`.
 */
export const appRoles = [
  "dashboard",
  "inbox",
  "files",
  "media",
  "sessions",
  "terminal",
] as const;
/** One assignable App role. */
export type AppRole = (typeof appRoles)[number];

/** The directory facts role resolution needs from one listed App. */
export type RoleCandidate = Readonly<{
  surfaceId: string;
  availability: "available" | "unavailable";
  roles: readonly AppRole[];
}>;

/** One role's effective App and whether the Team chose it. */
export type EffectiveAppRole = Readonly<{
  surfaceId: string | null;
  chosen: boolean;
}>;

/**
 * Project committed role choices onto the Apps a directory lists now. A
 * choice is a routing preference, never a grant. When no choice exists, or
 * the chosen App no longer declares the role or is unavailable, the
 * effective holder is the first available listed App declaring that role
 * (see ADR "no-privileged-apps-and-app-roles").
 */
export function resolveAppRoles(
  choices: ReadonlyMap<AppRole, string>,
  candidates: readonly RoleCandidate[],
) {
  const fills = (candidate: RoleCandidate, role: AppRole) =>
    candidate.availability === "available" && candidate.roles.includes(role);
  const resolve = (role: AppRole): EffectiveAppRole => {
    const chosen = choices.get(role);
    const selected =
      chosen === undefined
        ? undefined
        : candidates.find(
            (candidate) =>
              candidate.surfaceId === chosen && fills(candidate, role),
          );
    const effective =
      selected ?? candidates.find((candidate) => fills(candidate, role));
    return {
      surfaceId: effective?.surfaceId ?? null,
      chosen: selected !== undefined,
    };
  };
  // A new role in the vocabulary fails here until the directory projects it.
  return {
    dashboard: resolve("dashboard"),
    inbox: resolve("inbox"),
    files: resolve("files"),
    media: resolve("media"),
    sessions: resolve("sessions"),
    terminal: resolve("terminal"),
  } satisfies Record<AppRole, EffectiveAppRole>;
}

/**
 * Host capabilities an App may request. A request is never authority; the
 * Team's installation grants decide. Extend this list here.
 */
export const appCapabilityIds = [
  "agent.list",
  "agent.manage",
  "agent.rename",
  "agent.toolPolicy",
  "agent.read",
  "agent.send",
  "computer.list",
  "computer.readFile",
  "computer.writeFile",
  "computer.execute",
  "llm.generation",
  "media.generation",
  "games:servers",
  "git.repository",
  "apps.open",
  "apps.call",
  "app.storage",
  "app.events.emit",
  "team.workbenchHost",
  "marketplace.browse",
  "marketplace.purchase",
  "workflow.run",
  "workflow.publish",
  "workflow.arm",
  "world",
  "channels.read",
  "channels.personal.manage",
] as const;
/** One requestable host capability id. */
export type AppCapabilityId = (typeof appCapabilityIds)[number];

/** Backend requests are narrower than the App capabilities a Team approves. */
export type { AppBackendBinding } from "./app-backend-binding-vocabulary.js";
import type { AppBackendBinding } from "./app-backend-binding-vocabulary.js";

/** Build-generated method and event metadata. This data-only projection grants no authority. */
export type AppApi = Readonly<{
  methods: Readonly<
    Record<
      string,
      Readonly<{
        description: string;
        input: object;
        output: object;
        effect: "read" | "write" | "external";
        requires: readonly AppCapabilityId[];
        /** This method may return Agar's shared Pending result while working. */
        pending?: true | undefined;
        /** Omit from Workflow and tool discovery, without changing direct-call authority. */
        hidden?: true | undefined;
        /** Request anonymous read admission; declaration alone grants no authority. */
        anonymous?: true | undefined;
      }>
    >
  >;
  /** A signed dynamic tool namespace; its methods remain subject to ordinary admission. */
  toolFamily?: Readonly<{ name: string; list: string; call: string }>;
  /** Declared event payload schemas; hosts validate emits against the selected Release. */
  events?: Readonly<
    Record<
      string,
      Readonly<{
        description: string;
        payload: object;
      }>
    >
  >;
}>;

/** Navigation requests an App can handle for the shell. */
export const appHandlers = ["file.open"] as const;
/** One shell navigation request an App can handle. */
export type AppHandler = (typeof appHandlers)[number];

/**
 * One command an App declares so the backend can advertise it before the App
 * is open: the identity, labels and projections of a Whistle definition.
 * Availability, typed action schemas and slash argument grammars are runtime
 * facts the mounted App registers, so they are not part of the declaration.
 */
export type AppDeclaredCommand = Readonly<{
  id: string;
  title: string;
  category: string;
  description?: string | undefined;
  /** Optional Sigil to use in command rows. */
  sigil?: string | undefined;
  projections?:
    | Readonly<{
        bindings?:
          | (Readonly<{ order?: number | undefined }> &
              Readonly<{ values: readonly string[] }>)
          | undefined;
        agent?:
          | (Readonly<{ order?: number | undefined }> &
              Readonly<{ keybind?: string | undefined }>)
          | undefined;
        help?: Readonly<{ order?: number | undefined }> | undefined;
        menu?: Readonly<{ order?: number | undefined }> | undefined;
        palette?: Readonly<{ order?: number | undefined }> | undefined;
        slash?:
          | (Readonly<{ order?: number | undefined }> &
              Readonly<{ aliases: readonly string[] }>)
          | undefined;
      }>
    | undefined;
}>;

/** A declared layer of the App's own JSON data; never a cross-Team scope. */
export const appStorageScopes = ["team", "member"] as const;
/** The shared Team default or the calling member's private override. */
export type AppStorageScope = (typeof appStorageScopes)[number];
/** One digest-covered key and the bounds its App agrees to use. */
export type AppStorageKey = Readonly<{
  key: string;
  scopes: readonly AppStorageScope[];
  maxBytes: number;
}>;

/**
 * What an App asks of the host, covered by its Release digest. Every App,
 * first-party or not, uses this same declaration; there is no other source.
 */
export type AppDeclaration = Readonly<{
  /** Generated from the backend's typed method definitions during its build. */
  api?: AppApi;
  displayName?: string | undefined;
  capabilities: readonly AppCapabilityId[];
  /** Member-only calls to named Apps; a declaration never lends target grants. */
  calls?:
    | readonly Readonly<{ appId: string; methods: readonly string[] }>[]
    | undefined;
  /**
   * Instructions the App gives every Agent the Team has granted it. The Hub
   * relays the text; it writes none of its own for any one App.
   */
  guidance?: string | undefined;
  handlers: readonly AppHandler[];
  /** Host-delivered lifecycle facts requested by this Release; never method names. */
  receives?: readonly "git.push"[] | undefined;
  icon?: string;
  roles: readonly AppRole[];
  /** Bounded, digest-covered keys for this installation’s own data. */
  storage?: readonly AppStorageKey[] | undefined;
  /** The App's command catalog; omitted when it declares none. */
  commands?: readonly AppDeclaredCommand[] | undefined;
  /** Compact data views are optional and remain bound to this Release digest. */
  gills?: readonly AppDeclaredGill[] | undefined;
  backend?:
    | Readonly<{
        bindings: readonly AppBackendBinding[];
        /** Ordinary write continuation, freshly admitted as the retained member. */
        sync?: Readonly<{ method: string }>;
      }>
    | undefined;
}>;

/** The declaration of an App that asks for nothing. */
export const emptyAppDeclaration: AppDeclaration = Object.freeze({
  capabilities: [],
  handlers: [],
  roles: [],
});

/** An empty declaration is omitted from the manifest to keep digests stable. */
export const isEmptyAppDeclaration = (declaration: AppDeclaration): boolean =>
  declaration.api === undefined &&
  declaration.displayName === undefined &&
  declaration.capabilities.length === 0 &&
  (declaration.calls?.length ?? 0) === 0 &&
  declaration.handlers.length === 0 &&
  (declaration.receives?.length ?? 0) === 0 &&
  declaration.roles.length === 0 &&
  declaration.icon === undefined &&
  declaration.guidance === undefined &&
  (declaration.commands?.length ?? 0) === 0 &&
  (declaration.gills?.length ?? 0) === 0 &&
  (declaration.storage?.length ?? 0) === 0 &&
  (declaration.backend?.bindings.length ?? 0) === 0;
