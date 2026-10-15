import type { AppApi } from "../app-vocabulary.js";
/** A continuation must cover every write method's requirements, and itself be a write. */
export function backgroundSyncAllowed(
  api:
    | Readonly<{
        methods: Readonly<
          Record<string, Pick<AppApi["methods"][string], "effect" | "requires">>
        >;
      }>
    | undefined,
  sync: Readonly<{ method: string }> | undefined,
): boolean {
  if (sync === undefined) return true;
  const continuation = api?.methods[sync.method];
  if (continuation?.effect !== "write") return false;
  return Object.values(api?.methods ?? {}).every(
    (method) =>
      method.effect !== "write" ||
      method.requires.every((capability) =>
        continuation.requires.includes(capability),
      ),
  );
}
