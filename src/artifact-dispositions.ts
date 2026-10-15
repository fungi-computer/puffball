import * as Schema from "effect/Schema";
import type { AppReleaseD1Database } from "./cloudflare.js";
import {
  appIdSchema,
  artifactRefSchema,
  releaseIdSchema,
} from "./internal/app-release-schema.js";
import { reportFailure } from "./internal/failure.js";

const identity = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256)),
);
const reason = Schema.String.pipe(
  Schema.check(Schema.isPattern(/\S/u)),
  Schema.check(Schema.isMaxLength(1000)),
);
const actionSchema = Schema.Struct({
  dispositionId: identity,
  requestId: identity,
  operatorId: identity,
  reason,
  action: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("retain-detached") }),
    Schema.Struct({ kind: Schema.Literal("revoke-with-notice") }),
  ]),
});
export type ArtifactDispositionAction = Schema.Schema.Type<typeof actionSchema>;
/** The disposition owner supplies the target and reason; Hub adds no caller-asserted recipients. */
export const artifactDispositionNoticeSchema = Schema.Struct({
  dispositionId: identity,
  appId: appIdSchema,
  displayName: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(64)),
  ),
  releaseIds: Schema.Array(releaseIdSchema).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(10000)),
  ),
  reason,
});
export type ArtifactDispositionNotice = Schema.Schema.Type<
  typeof artifactDispositionNoticeSchema
>;

const rowSchema = Schema.Struct({
  disposition_id: identity,
  app_id: appIdSchema,
  release_ids_json: Schema.String,
  artifact_roots_json: Schema.String,
  created_at: Schema.Number,
  state: Schema.Literals([
    "pending",
    "retaining",
    "retained",
    "revoking",
    "revoked",
  ]),
  request_id: Schema.NullOr(identity),
  reason: Schema.NullOr(reason),
  completed_at: Schema.NullOr(Schema.Number),
});
export const artifactDispositionReadbackSchema = Schema.Struct({
  ...rowSchema.fields,
  releaseIds: Schema.Array(releaseIdSchema).pipe(
    Schema.check(Schema.isMaxLength(10000)),
  ),
});
const releasesSchema = Schema.fromJsonString(
  Schema.Array(releaseIdSchema).pipe(Schema.check(Schema.isMaxLength(10000))),
);
const artifactsSchema = Schema.fromJsonString(
  Schema.Array(artifactRefSchema).pipe(Schema.check(Schema.isMaxLength(10000))),
);

/** Buyer artifact custody is independent of erased seller identity. Operators bind disposition to one request; captured buyer Teams require durable inbox receipts. */
export function createD1ArtifactDispositions(
  database: AppReleaseD1Database,
  now: () => number = Date.now,
) {
  const read = async (dispositionId: string) => {
    const row = await database
      .prepare(
        "SELECT * FROM app_release_artifact_dispositions WHERE disposition_id=?",
      )
      .bind(dispositionId)
      .first();
    if (row === null) return null;
    const decoded = Schema.decodeUnknownSync(rowSchema)(row);
    Schema.decodeUnknownSync(artifactsSchema)(decoded.artifact_roots_json);
    return {
      ...decoded,
      releaseIds: Schema.decodeUnknownSync(releasesSchema)(
        decoded.release_ids_json,
      ),
    };
  };
  const prepare = async (raw: ArtifactDispositionAction) => {
    try {
      const input = Schema.decodeUnknownSync(actionSchema, {
        onExcessProperty: "error",
      })(raw);
      const state =
        input.action.kind === "retain-detached" ? "retaining" : "revoking";
      const results = await database.batch([
        database
          .prepare(
            `UPDATE app_release_artifact_dispositions SET state=?,request_id=?,reason=?
          WHERE disposition_id=? AND state='pending'`,
          )
          .bind(state, input.requestId, input.reason, input.dispositionId),
        database
          .prepare(
            `INSERT INTO app_release_artifact_disposition_steps(disposition_id,phase,operator_id,recorded_at)
          SELECT ?,'prepared',?,? WHERE EXISTS (SELECT 1 FROM app_release_artifact_dispositions
            WHERE disposition_id=? AND state IN (?,?) AND request_id=? AND reason=?)
          ON CONFLICT DO NOTHING`,
          )
          .bind(
            input.dispositionId,
            input.operatorId,
            now(),
            input.dispositionId,
            state,
            state === "retaining" ? "retained" : "revoked",
            input.requestId,
            input.reason,
          ),
      ]);
      if (results.some((result) => !result.success))
        throw new Error("Artifact disposition unavailable");
      const saved = await read(input.dispositionId);
      if (
        saved?.request_id !== input.requestId ||
        saved.reason !== input.reason ||
        ![state, state === "retaining" ? "retained" : "revoked"].includes(
          saved.state,
        )
      )
        return { kind: "conflict" as const };
      return { kind: "recorded" as const, disposition: saved };
    } catch (cause) {
      reportFailure("artifact disposition preparation", cause);
      return { kind: "unavailable" as const };
    }
  };
  const complete = async (dispositionId: string, operatorId: string) => {
    for (const value of [dispositionId, operatorId])
      Schema.decodeUnknownSync(identity)(value);
    const results = await database.batch([
      database
        .prepare(
          `INSERT INTO app_release_artifact_disposition_steps(disposition_id,phase,operator_id,recorded_at)
        SELECT ?,'completed',?,? WHERE EXISTS (SELECT 1 FROM app_release_artifact_dispositions d WHERE d.disposition_id=? AND
          (d.state IN ('retaining','retained','revoked') OR (d.state='revoking' AND NOT EXISTS (
            SELECT 1 FROM app_release_artifact_notice_recipients n WHERE n.disposition_id=d.disposition_id AND n.receipt IS NULL AND n.erased_at IS NULL) AND NOT EXISTS (
            SELECT 1 FROM json_each(d.release_ids_json) r WHERE NOT EXISTS (
              SELECT 1 FROM app_release_transitions t JOIN app_release_transition_obligations o ON o.sequence=t.sequence
              WHERE t.release_id=r.value AND t.operation_kind='revocation' AND o.state='acknowledged')))))
        ON CONFLICT DO NOTHING`,
        )
        .bind(dispositionId, operatorId, now(), dispositionId),
      database
        .prepare(
          `UPDATE app_release_artifact_dispositions SET state=CASE state WHEN 'retaining' THEN 'retained' ELSE 'revoked' END,completed_at=?
        WHERE disposition_id=? AND state IN ('retaining','revoking') AND EXISTS (
          SELECT 1 FROM app_release_artifact_disposition_steps WHERE disposition_id=? AND phase='completed')`,
        )
        .bind(now(), dispositionId, dispositionId),
    ]);
    if (results.some((result) => !result.success))
      throw new Error("Artifact disposition unavailable");
    const saved = await read(dispositionId);
    return saved !== null &&
      (saved.state === "retained" || saved.state === "revoked")
      ? { kind: "recorded" as const, disposition: saved }
      : { kind: "conflict" as const };
  };
  const pending = async (after = "") => {
    const rows = await database
      .prepare(
        `SELECT disposition_id FROM app_release_artifact_dispositions
      WHERE state IN ('pending','retaining','revoking') AND disposition_id>? ORDER BY disposition_id LIMIT 100`,
      )
      .bind(after)
      .all();
    const ids = rows.results.map(
      (row) =>
        Schema.decodeUnknownSync(Schema.Struct({ disposition_id: identity }))(
          row,
        ).disposition_id,
    );
    return Promise.all(ids.map(read));
  };
  const noticeRow = Schema.Struct({
    teamId: Schema.NullOr(identity),
    receipt: Schema.NullOr(identity),
    erasedBy: Schema.NullOr(identity),
    erasedAt: Schema.NullOr(Schema.Number),
  });
  const noticeRecipients = async (dispositionId: string, after = "") => {
    const rows = await database
      .prepare(
        `SELECT buyer_team_id AS teamId,receipt,erased_by AS erasedBy,erased_at AS erasedAt FROM app_release_artifact_notice_recipients
      WHERE disposition_id=? AND (buyer_team_id>? OR buyer_team_id IS NULL) ORDER BY buyer_team_id,recipient_id LIMIT 100`,
      )
      .bind(dispositionId, after)
      .all();
    return rows.results.map((row) => Schema.decodeUnknownSync(noticeRow)(row));
  };
  /** Only the trusted Hub delivery coordinator calls this after the Team inbox owner commits its receipt. */
  const recordNoticeReceipt = async (
    dispositionId: string,
    teamId: string,
    receipt: string,
  ) => {
    for (const value of [dispositionId, teamId, receipt])
      Schema.decodeUnknownSync(identity)(value);
    await database
      .prepare(
        `UPDATE app_release_artifact_notice_recipients SET receipt=?
      WHERE disposition_id=? AND buyer_team_id=? AND receipt IS NULL AND erased_at IS NULL AND EXISTS (
        SELECT 1 FROM app_release_artifact_dispositions d WHERE d.disposition_id=? AND d.state='revoking')`,
      )
      .bind(receipt, dispositionId, teamId, dispositionId)
      .run();
    const row = await database
      .prepare(
        `SELECT receipt FROM app_release_artifact_notice_recipients
      WHERE disposition_id=? AND buyer_team_id=?`,
      )
      .bind(dispositionId, teamId)
      .first();
    return (
      row !== null &&
      Schema.decodeUnknownSync(
        Schema.Struct({ receipt: Schema.NullOr(identity) }),
      )(row).receipt === receipt
    );
  };
  /** Trusted Hub coordinator verifies the Team owner's erasure readback before calling this. Never a delivered receipt. */
  const recordNoticeRecipientErased = async (
    dispositionId: string,
    teamId: string,
    operatorId: string,
  ) => {
    for (const value of [dispositionId, teamId, operatorId])
      Schema.decodeUnknownSync(identity)(value);
    await database
      .prepare(
        `UPDATE app_release_artifact_notice_recipients SET erased_by=?,erased_at=?
      WHERE disposition_id=? AND buyer_team_id=? AND receipt IS NULL AND erased_at IS NULL AND EXISTS (
        SELECT 1 FROM app_release_artifact_dispositions d WHERE d.disposition_id=? AND d.state='revoking')`,
      )
      .bind(operatorId, now(), dispositionId, teamId, dispositionId)
      .run();
    const row = await database
      .prepare(
        `SELECT erased_at FROM app_release_artifact_notice_recipients
      WHERE disposition_id=? AND buyer_team_id=?`,
      )
      .bind(dispositionId, teamId)
      .first();
    return (
      row !== null &&
      Schema.decodeUnknownSync(
        Schema.Struct({ erased_at: Schema.NullOr(Schema.Number) }),
      )(row).erased_at !== null
    );
  };
  const pendingWork = async (dispositionId: string) => {
    const notices = await database
      .prepare(
        `SELECT buyer_team_id AS teamId FROM app_release_artifact_notice_recipients
      WHERE disposition_id=? AND receipt IS NULL AND erased_at IS NULL ORDER BY buyer_team_id LIMIT 100`,
      )
      .bind(dispositionId)
      .all();
    const releases = await database
      .prepare(
        `SELECT r.value AS releaseId FROM app_release_artifact_dispositions d,json_each(d.release_ids_json) r
      WHERE d.disposition_id=? AND d.state='revoking' AND NOT EXISTS (
        SELECT 1 FROM app_release_transitions t JOIN app_release_transition_obligations o ON o.sequence=t.sequence
        WHERE t.release_id=r.value AND t.operation_kind='revocation' AND o.state='acknowledged')
      ORDER BY r.value LIMIT 100`,
      )
      .bind(dispositionId)
      .all();
    return {
      teamIds: notices.results.map(
        (row) =>
          Schema.decodeUnknownSync(Schema.Struct({ teamId: identity }))(row)
            .teamId,
      ),
      releaseIds: releases.results.map(
        (row) =>
          Schema.decodeUnknownSync(
            Schema.Struct({ releaseId: releaseIdSchema }),
          )(row).releaseId,
      ),
    };
  };
  return {
    read,
    prepare,
    complete,
    pending,
    noticeRecipients,
    recordNoticeReceipt,
    recordNoticeRecipientErased,
    pendingWork,
  };
}

export const artifactDispositionSchemaSql = [
  `CREATE TABLE app_release_artifact_dispositions(disposition_id TEXT PRIMARY KEY, app_id TEXT NOT NULL UNIQUE REFERENCES app_release_apps(app_id),
    release_ids_json TEXT NOT NULL CHECK(json_valid(release_ids_json)), artifact_roots_json TEXT NOT NULL CHECK(json_valid(artifact_roots_json)),
    created_at INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','retaining','retained','revoking','revoked')),
    request_id TEXT,reason TEXT,completed_at INTEGER,
    CHECK((state='pending' AND request_id IS NULL AND reason IS NULL) OR (state<>'pending' AND request_id IS NOT NULL AND length(request_id) BETWEEN 1 AND 256 AND reason IS NOT NULL AND length(trim(reason)) BETWEEN 1 AND 1000)),
    CHECK((state IN ('retained','revoked'))=(completed_at IS NOT NULL))) STRICT;`,
  `CREATE TABLE app_release_artifact_notice_recipients(recipient_id INTEGER PRIMARY KEY,disposition_id TEXT NOT NULL REFERENCES app_release_artifact_dispositions(disposition_id),
    buyer_team_id TEXT CHECK(buyer_team_id IS NULL OR length(buyer_team_id) BETWEEN 1 AND 256),receipt TEXT CHECK(receipt IS NULL OR length(receipt) BETWEEN 1 AND 256),
    erased_by TEXT,erased_at INTEGER,
    CHECK((erased_by IS NULL)=(erased_at IS NULL)),
    CHECK(erased_by IS NULL OR length(erased_by) BETWEEN 1 AND 256),
    CHECK(receipt IS NULL OR erased_at IS NULL),
    CHECK(buyer_team_id IS NOT NULL OR erased_at IS NOT NULL),
    UNIQUE(disposition_id,buyer_team_id)) STRICT;`,
  `CREATE INDEX app_release_artifact_dispositions_pending ON app_release_artifact_dispositions(state,disposition_id);`,
  `CREATE TABLE app_release_artifact_disposition_steps(step_id INTEGER PRIMARY KEY,disposition_id TEXT NOT NULL REFERENCES app_release_artifact_dispositions(disposition_id),
    phase TEXT NOT NULL CHECK(phase IN ('prepared','completed')),operator_id TEXT NOT NULL,recorded_at INTEGER NOT NULL) STRICT;`,
  `CREATE INDEX app_release_artifact_disposition_steps_by_action ON app_release_artifact_disposition_steps(disposition_id,phase);`,
]
  .map((statement) => statement.replaceAll("\n", " "))
  .join("\n");
