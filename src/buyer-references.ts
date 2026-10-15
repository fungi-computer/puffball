import * as Schema from "effect/Schema";
import type { AppReleaseD1Database } from "./cloudflare.js";
import {
  appIdSchema,
  publicSurfaceIdSchema,
  releaseIdSchema,
  sha256DigestSchema,
  stableRouteSchema,
} from "./internal/app-release-schema.js";

const identity = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256)),
);
/** Positive installed-release custody. This record alone never grants access to a caller. */
export const buyerReleaseReferenceSchema = Schema.Struct({
  buyerTeamId: identity,
  installationId: identity,
  appId: appIdSchema,
  releaseId: releaseIdSchema,
  artifactDigest: sha256DigestSchema,
  publicSurfaceId: publicSurfaceIdSchema,
  stableRoute: stableRouteSchema,
  acquisitionVersion: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThan(0)),
  ),
  acquisitionDecisionId: identity,
  selectionSequence: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThan(0)),
  ),
});
export type BuyerReleaseReference = Schema.Schema.Type<
  typeof buyerReleaseReferenceSchema
>;

/** No Surface FK: buyer references survive seller erasure and are the revocation recipient index. */
export const buyerReferenceSchemaSql =
  `CREATE TABLE app_release_buyer_references (
  buyer_team_id TEXT NOT NULL, installation_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES app_release_apps(app_id),
  release_id TEXT NOT NULL REFERENCES app_release_releases(release_id),
  artifact_digest TEXT NOT NULL, public_surface_id TEXT NOT NULL, stable_route TEXT NOT NULL,
  acquisition_version INTEGER NOT NULL CHECK(acquisition_version>0),
  acquisition_decision_id TEXT NOT NULL, selection_sequence INTEGER NOT NULL CHECK(selection_sequence>0),
  PRIMARY KEY(buyer_team_id,installation_id,release_id)
) STRICT;`.replaceAll("\n", " ") +
  "\n" +
  `CREATE INDEX app_release_buyers_by_release ON app_release_buyer_references(release_id,buyer_team_id,installation_id);`;

const columns = `buyer_team_id AS buyerTeamId,installation_id AS installationId,app_id AS appId,
  release_id AS releaseId,artifact_digest AS artifactDigest,public_surface_id AS publicSurfaceId,
  stable_route AS stableRoute,acquisition_version AS acquisitionVersion,
  acquisition_decision_id AS acquisitionDecisionId,selection_sequence AS selectionSequence`;

/** Team admission owns the positive acquisition check before recording an install's retained basis. */
export function createD1BuyerReferences(database: AppReleaseD1Database) {
  const read = async (input: {
    buyerTeamId: string;
    installationId: string;
    releaseId: string;
  }) => {
    const row = await database
      .prepare(
        `SELECT ${columns} FROM app_release_buyer_references
      WHERE buyer_team_id=? AND installation_id=? AND release_id=?`,
      )
      .bind(input.buyerTeamId, input.installationId, input.releaseId)
      .first();
    return row === null
      ? null
      : Schema.decodeUnknownSync(buyerReleaseReferenceSchema)(row);
  };
  /** Retained acquisition authority is independent of current route custody, but never of verification or revocation. */
  const readRetained = async (input: {
    buyerTeamId: string;
    installationId: string;
    releaseId: string;
  }): Promise<BuyerReleaseReference | null> => {
    const row = await database
      .prepare(
        `SELECT ${columns} FROM app_release_buyer_references b
      WHERE buyer_team_id=? AND installation_id=? AND release_id=?
        AND EXISTS (SELECT 1 FROM app_release_releases r
          JOIN app_release_release_verifications v ON v.release_id=r.release_id
          WHERE r.release_id=b.release_id AND r.app_id=b.app_id
            AND r.artifact_digest=b.artifact_digest AND v.artifact_digest=b.artifact_digest)
        AND NOT EXISTS (SELECT 1 FROM app_release_transitions t
          WHERE t.release_id=b.release_id AND t.operation_kind='revocation')`,
      )
      .bind(input.buyerTeamId, input.installationId, input.releaseId)
      .first();
    return row === null
      ? null
      : Schema.decodeUnknownSync(buyerReleaseReferenceSchema)(row);
  };
  const retain = async (raw: BuyerReleaseReference): Promise<boolean> => {
    const input = Schema.decodeUnknownSync(buyerReleaseReferenceSchema, {
      onExcessProperty: "error",
    })(raw);
    await database
      .prepare(
        `INSERT INTO app_release_buyer_references
      (buyer_team_id,installation_id,app_id,release_id,artifact_digest,public_surface_id,stable_route,
       acquisition_version,acquisition_decision_id,selection_sequence)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (
        SELECT 1 FROM app_release_route_claims c
        JOIN app_release_public_surfaces s ON s.public_surface_id=c.public_surface_id
        JOIN app_release_releases r ON r.app_id=s.app_id
        JOIN app_release_release_verifications v ON v.release_id=r.release_id AND v.artifact_digest=r.artifact_digest
        JOIN app_release_transitions t ON t.public_surface_id=s.public_surface_id AND t.release_id=r.release_id
        WHERE c.state='held' AND c.public_surface_id=? AND c.stable_route=? AND s.app_id=?
          AND r.release_id=? AND r.artifact_digest=? AND t.sequence=? AND t.operation_kind IN ('promotion','rollback')
          AND NOT EXISTS (SELECT 1 FROM app_release_surface_retirements x WHERE x.public_surface_id=c.public_surface_id)
          AND NOT EXISTS (SELECT 1 FROM app_release_safety_takedowns a WHERE a.app_id=s.app_id AND a.stable_route=s.stable_route)
          AND NOT EXISTS (SELECT 1 FROM app_release_transitions revoked WHERE revoked.release_id=r.release_id AND revoked.operation_kind='revocation')
      ) ON CONFLICT(buyer_team_id,installation_id,release_id) DO UPDATE SET
        acquisition_version=MAX(acquisition_version,excluded.acquisition_version),
        acquisition_decision_id=CASE WHEN excluded.acquisition_version>acquisition_version THEN excluded.acquisition_decision_id ELSE acquisition_decision_id END,
        selection_sequence=MAX(selection_sequence,excluded.selection_sequence)
      WHERE app_id=excluded.app_id AND artifact_digest=excluded.artifact_digest
        AND public_surface_id=excluded.public_surface_id AND stable_route=excluded.stable_route`,
      )
      .bind(
        input.buyerTeamId,
        input.installationId,
        input.appId,
        input.releaseId,
        input.artifactDigest,
        input.publicSurfaceId,
        input.stableRoute,
        input.acquisitionVersion,
        input.acquisitionDecisionId,
        input.selectionSequence,
        input.publicSurfaceId,
        input.stableRoute,
        input.appId,
        input.releaseId,
        input.artifactDigest,
        input.selectionSequence,
      )
      .run();
    const saved = await read(input);
    return (
      saved !== null &&
      saved.appId === input.appId &&
      saved.artifactDigest === input.artifactDigest &&
      saved.publicSurfaceId === input.publicSurfaceId &&
      saved.stableRoute === input.stableRoute &&
      saved.acquisitionVersion >= input.acquisitionVersion &&
      (saved.acquisitionVersion > input.acquisitionVersion ||
        saved.acquisitionDecisionId === input.acquisitionDecisionId) &&
      saved.selectionSequence >= input.selectionSequence
    );
  };
  /** Formerly public immutable bytes remain deliverable while a buyer holds this exact publication. */
  const readPublication = async (stableRoute: string, releaseId: string) => {
    const row = await database
      .prepare(
        `SELECT ${columns} FROM app_release_buyer_references
      WHERE stable_route=? AND release_id=? ORDER BY buyer_team_id,installation_id LIMIT 1`,
      )
      .bind(stableRoute, releaseId)
      .first();
    if (row === null) return null;
    const reference = Schema.decodeUnknownSync(buyerReleaseReferenceSchema)(
      row,
    );
    return readRetained(reference);
  };
  /** Freeze following installs at their last admitted publication when that Surface loses custody. */
  const readFrozenInstallation = async (
    buyerTeamId: string,
    installationId: string,
    appId: string,
  ) => {
    const row = await database
      .prepare(
        `SELECT ${columns} FROM app_release_buyer_references b
      WHERE buyer_team_id=? AND installation_id=? AND app_id=?
        AND NOT EXISTS (SELECT 1 FROM app_release_route_claims c
          WHERE c.public_surface_id=b.public_surface_id AND c.state='held'
            AND NOT EXISTS (SELECT 1 FROM app_release_surface_retirements x WHERE x.public_surface_id=c.public_surface_id))
      ORDER BY selection_sequence DESC,release_id LIMIT 1`,
      )
      .bind(buyerTeamId, installationId, appId)
      .first();
    return row === null
      ? null
      : Schema.decodeUnknownSync(buyerReleaseReferenceSchema)(row);
  };
  const releaseInstallation = async (
    buyerTeamId: string,
    installationId: string,
  ) => {
    await database
      .prepare(
        "DELETE FROM app_release_buyer_references WHERE buyer_team_id=? AND installation_id=?",
      )
      .bind(buyerTeamId, installationId)
      .run();
  };
  const affectedApps = async (releaseId: string) => {
    // Release identity has one App owner; the indexed existence read is bounded independently of buyer count.
    const result = await database
      .prepare(
        `SELECT DISTINCT app_id AS appId FROM app_release_buyer_references WHERE release_id=? LIMIT 2`,
      )
      .bind(releaseId)
      .all();
    const values = result.results.map(
      (row) =>
        Schema.decodeUnknownSync(Schema.Struct({ appId: appIdSchema }))(row)
          .appId,
    );
    if (values.length > 1) throw new Error("Buyer Release owner conflicts");
    return values;
  };
  return {
    retain,
    read,
    readRetained,
    readPublication,
    readFrozenInstallation,
    releaseInstallation,
    affectedApps,
  };
}
