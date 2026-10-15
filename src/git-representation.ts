import * as z from "zod";

/** Local repository name; the host maps it into the installation's namespace. */
export const gitRepositoryNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9._-]{1,128}$/)
  .refine((name) => name !== "." && name !== "..");

/** A lowercase Git SHA-1 object ID, including the zero ID for creation/deletion. */
export const gitSha1Schema = z.string().regex(/^[0-9a-f]{40}$/);

/** One ref update, bounded before a host asks the App or forwards the push. */
export const gitRefUpdateSchema = z.strictObject({
  ref: z.string().startsWith("refs/").max(1024),
  before: gitSha1Schema,
  after: gitSha1Schema,
});

/** Host push event IDs include the Computer and local event identity. */
export const gitPushEventIdSchema = z.string().min(1).max(512);
