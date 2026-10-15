/** Only trusted column expressions enter DDL; all request values are bound. */
export function routeKeySql(column: string): string {
  const slug = `CASE WHEN substr(${column},1,1)='/' THEN substr(${column},2) ELSE ${column} END`;
  return `replace(replace(replace(replace(replace(replace(replace(${slug},'-',''),'_',''),'1','i'),'l','i'),'0','o'),'5','s'),'3','e')`;
}

/** Immutable Surface metadata and database-enforced policy comparison key. */
export const publicSurfaceTableSql = `
CREATE TABLE app_release_public_surfaces (
  public_surface_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES app_release_apps(app_id),
  stable_route TEXT NOT NULL,
  route_key TEXT NOT NULL CHECK(route_key = ${routeKeySql("stable_route")}),
  publisher_team_id TEXT NOT NULL CHECK(length(publisher_team_id) BETWEEN 1 AND 256),
  publisher_user_id TEXT NOT NULL CHECK(length(publisher_user_id) BETWEEN 1 AND 256),
  authority_kind TEXT NOT NULL CHECK(authority_kind IN ('customer','platform')),
  request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 256),
  UNIQUE(publisher_team_id,request_key)
) STRICT;
`.replaceAll("\n", " ");

/** Shared by the Surface insertion and the transition trigger's eligibility view. */
const surfaceEligibilitySql = `
NOT EXISTS (SELECT 1 FROM app_release_safety_takedowns a
  WHERE a.app_id=s.app_id AND a.stable_route=s.stable_route)
AND
NOT EXISTS (
  SELECT 1 FROM app_release_surface_retirements x
  WHERE x.public_surface_id=s.public_surface_id
)
AND NOT EXISTS (
  SELECT 1 FROM app_release_team_route_blocks b
  WHERE b.team_id=s.publisher_team_id AND b.route_key=s.route_key
)
AND (c.route_key IS NOT NULL OR NOT EXISTS (
  SELECT 1 FROM app_release_route_holds h
  WHERE h.route_key=s.route_key AND h.until_s>unixepoch()
))
AND (c.route_key IS NULL OR
     (c.public_surface_id=s.public_surface_id AND c.state='held'))
AND (s.authority_kind='platform' OR c.public_surface_id=s.public_surface_id OR
     (SELECT count(*) FROM app_release_route_claims own
      JOIN app_release_public_surfaces owned_surface ON owned_surface.public_surface_id=own.public_surface_id
      WHERE own.team_id=s.publisher_team_id AND owned_surface.authority_kind='customer')<policy.max_team_routes)
AND (
  (s.authority_kind='platform' AND EXISTS (
    SELECT 1 FROM app_release_platform_routes p
    WHERE p.stable_route=s.stable_route AND p.app_id=s.app_id
  ))
  OR
  (s.authority_kind='customer' AND EXISTS (
    SELECT 1 FROM app_release_team_publishers p
    WHERE p.app_id=s.app_id AND p.team_id=s.publisher_team_id
      AND p.source_provider='artifacts' AND p.source_repository=p.app_id
      AND p.source_branch='main' AND p.template_app_id IS NOT NULL
      AND p.template_app_id<>p.app_id AND p.template_seed_revision IS NOT NULL
  ) AND (
    c.public_surface_id=s.public_surface_id OR (
      NOT EXISTS (SELECT 1 FROM app_release_platform_routes p
                  WHERE p.route_key=s.route_key)
      AND NOT EXISTS (
        SELECT 1 FROM app_release_reserved_route_keys k
        WHERE (k.match_kind='exact' AND k.route_key=s.route_key)
           OR (k.match_kind='prefix' AND
               substr(s.route_key,1,length(k.route_key))=k.route_key
               AND NOT EXISTS (SELECT 1 FROM app_release_route_brand_exceptions x WHERE x.route_key=s.route_key))
      )
    )
  ))
)`;

/** One write: pre-check custody and bound unused rows before minting any Surface. */
export const insertPublicSurfaceSql = `
WITH candidate(public_surface_id,app_id,stable_route,route_key,
               publisher_team_id,publisher_user_id,authority_kind,request_key)
AS (VALUES (?,?,?,?,?,?,?,?))
INSERT INTO app_release_public_surfaces
  (public_surface_id,app_id,stable_route,route_key,publisher_team_id,publisher_user_id,authority_kind,request_key)
SELECT s.public_surface_id,s.app_id,s.stable_route,s.route_key,
       s.publisher_team_id,s.publisher_user_id,s.authority_kind,s.request_key
FROM candidate s
JOIN app_release_route_policy policy ON policy.singleton=1
LEFT JOIN app_release_route_claims c ON c.route_key=s.route_key
WHERE ${surfaceEligibilitySql}
AND (SELECT count(*) FROM app_release_public_surfaces unused
     WHERE unused.app_id=s.app_id AND NOT EXISTS (
       SELECT 1 FROM app_release_transitions t
       WHERE t.public_surface_id=unused.public_surface_id
         AND t.operation_kind IN ('promotion','rollback')
     ))<policy.max_unused_surfaces_per_app
ON CONFLICT DO NOTHING
RETURNING *`;

/** Current route custody is separate from immutable Surface and transition history. */
export const publicRouteSchemaSql = [
  `CREATE TABLE app_release_route_policy (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  version INTEGER NOT NULL,
  digest TEXT NOT NULL,
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  max_team_routes INTEGER NOT NULL CHECK(max_team_routes>0),
  max_unused_surfaces_per_app INTEGER NOT NULL CHECK(max_unused_surfaces_per_app>0)
) STRICT;`,
  `CREATE TABLE app_release_reserved_route_keys (
  word TEXT NOT NULL,
  route_key TEXT NOT NULL CHECK(route_key = ${routeKeySql("word")}),
  match_kind TEXT NOT NULL CHECK(match_kind IN ('exact','prefix')),
  PRIMARY KEY(route_key,match_kind)
) STRICT;`,
  `CREATE TABLE app_release_route_brand_exceptions (
  word TEXT NOT NULL,
  route_key TEXT PRIMARY KEY CHECK(route_key = ${routeKeySql("word")})
) STRICT;`,
  `CREATE TABLE app_release_platform_routes (
  stable_route TEXT NOT NULL,
  route_key TEXT PRIMARY KEY CHECK(route_key = ${routeKeySql("stable_route")}),
  app_id TEXT NOT NULL
) STRICT;`,
  `CREATE TABLE app_release_route_claims (
  route_key TEXT PRIMARY KEY CHECK(route_key = ${routeKeySql("stable_route")}),
  stable_route TEXT NOT NULL,
  public_surface_id TEXT NOT NULL UNIQUE REFERENCES app_release_public_surfaces(public_surface_id),
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  first_transition_id TEXT NOT NULL REFERENCES app_release_transitions(transition_id),
  claimed_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('held','removing')),
  removal_operation_id TEXT,
  CHECK((state='removing') = (removal_operation_id IS NOT NULL))
) STRICT;`,
  `CREATE INDEX app_release_route_claims_team ON app_release_route_claims(team_id);`,
  `CREATE TABLE app_release_route_holds (
  route_key TEXT PRIMARY KEY CHECK(route_key = ${routeKeySql("stable_route")}),
  stable_route TEXT NOT NULL,
  until_s INTEGER NOT NULL,
  cause TEXT NOT NULL CHECK(cause IN ('operator-release','erasure')),
  operation_id TEXT NOT NULL
) STRICT;`,
  `CREATE TABLE app_release_surface_retirements (
  public_surface_id TEXT PRIMARY KEY REFERENCES app_release_public_surfaces(public_surface_id),
  operation_id TEXT NOT NULL
) STRICT;`,
  `CREATE TABLE app_release_team_route_blocks (
  team_id TEXT NOT NULL,
  route_key TEXT NOT NULL CHECK(route_key = ${routeKeySql("stable_route")}),
  stable_route TEXT NOT NULL,
  removal_operation_id TEXT NOT NULL,
  PRIMARY KEY(team_id,route_key)
) STRICT;`,
  `CREATE TABLE app_release_route_operations (
  operation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('unlist-and-release','re-allow')),
  public_surface_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  stable_route TEXT NOT NULL,
  route_key TEXT NOT NULL CHECK(route_key = ${routeKeySql("stable_route")}),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
  initiated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  removal_operation_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','complete','superseded-by-erasure')),
  completed_at INTEGER,
  CHECK((kind='re-allow') = (removal_operation_id IS NOT NULL))
) STRICT;`,
  `CREATE INDEX app_release_route_operations_pending ON app_release_route_operations(state,operation_id);`,
  `CREATE TABLE app_release_route_operation_steps (
  operation_id TEXT NOT NULL REFERENCES app_release_route_operations(operation_id),
  phase TEXT NOT NULL CHECK(phase IN ('prepared','completed')),
  operator_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY(operation_id,phase)
) STRICT;`,
  `CREATE VIEW app_release_selection_ready AS
SELECT s.public_surface_id, s.app_id, s.stable_route, s.route_key,
       s.publisher_team_id AS team_id, s.publisher_user_id AS user_id,
       r.release_id,
       CASE WHEN c.public_surface_id=s.public_surface_id AND c.state='held'
            THEN 1 ELSE 0 END AS already_held
FROM app_release_public_surfaces s
JOIN app_release_releases r ON r.app_id=s.app_id
JOIN app_release_release_verifications v
  ON v.release_id=r.release_id AND v.artifact_digest=r.artifact_digest
JOIN app_release_route_policy policy ON policy.singleton=1
LEFT JOIN app_release_route_claims c ON c.route_key=s.route_key
WHERE ${surfaceEligibilitySql}
AND NOT EXISTS (
  SELECT 1 FROM app_release_transitions revoked
  WHERE revoked.operation_kind='revocation' AND revoked.release_id=r.release_id
);`,
  `CREATE TRIGGER app_release_selection_claim_before
BEFORE INSERT ON app_release_transitions
WHEN NEW.operation_kind IN ('promotion','rollback')
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM app_release_selection_ready e
    WHERE e.public_surface_id=NEW.public_surface_id
      AND e.release_id=NEW.release_id
      AND (NEW.operation_kind='promotion' OR
           (e.already_held=1 AND EXISTS (
             SELECT 1 FROM app_release_transitions prior
             WHERE prior.public_surface_id=NEW.public_surface_id
               AND prior.release_id=NEW.release_id
               AND prior.operation_kind IN ('promotion','rollback')
           )))
  ) THEN RAISE(ABORT,'publication_claim_refused') END;
END;`,
  `CREATE TRIGGER app_release_selection_claim_after
AFTER INSERT ON app_release_transitions
WHEN NEW.operation_kind IN ('promotion','rollback')
BEGIN
  INSERT INTO app_release_route_claims
    (route_key,stable_route,public_surface_id,team_id,user_id,first_transition_id,claimed_at,state)
  SELECT e.route_key,e.stable_route,e.public_surface_id,e.team_id,e.user_id,
         NEW.transition_id,unixepoch(),'held'
  FROM app_release_selection_ready e
  WHERE e.public_surface_id=NEW.public_surface_id
    AND e.release_id=NEW.release_id AND e.already_held=0
    AND NEW.operation_kind='promotion'
    AND EXISTS (
      SELECT 1 FROM app_release_transitions t
      WHERE t.transition_id=NEW.transition_id
        AND t.operation_kind=NEW.operation_kind
        AND t.idempotency_key=NEW.idempotency_key
        AND t.release_id=NEW.release_id
        AND t.public_surface_id=NEW.public_surface_id
    );
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM app_release_route_claims c
    JOIN app_release_public_surfaces s ON s.public_surface_id=c.public_surface_id
    WHERE c.public_surface_id=NEW.public_surface_id
      AND c.route_key=s.route_key AND c.team_id=s.publisher_team_id
      AND c.state='held'
  ) THEN RAISE(ABORT,'publication_claim_missing') END;
END;`,
]
  .map((statement) => statement.replaceAll("\n", " "))
  .join("\n");

/** Operator replay history preserves original Surface attribution. */
export const platformOwnerReplaySchemaSql = `
CREATE TABLE app_release_platform_owner_replays (sequence INTEGER PRIMARY KEY AUTOINCREMENT, public_surface_id TEXT NOT NULL, app_id TEXT NOT NULL, stable_route TEXT NOT NULL, owner_team_id TEXT NOT NULL, publisher_user_id TEXT NOT NULL, operator_user_id TEXT NOT NULL, recorded_at INTEGER NOT NULL) STRICT;
CREATE INDEX app_release_platform_owner_replays_app ON app_release_platform_owner_replays(app_id);
`;
