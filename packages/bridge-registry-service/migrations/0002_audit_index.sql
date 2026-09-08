-- 0002_audit_index.sql — audit lookup index + dead-index cleanup (issue #48).
--
-- GET /v1/audit is force-scoped to (org) and commonly filtered by project,
-- ordered by time DESC. 0001 indexes time alone and (org, time); this
-- composite serves both the tenant predicate and the ordering with one
-- index as audit volume grows.
--
-- The gin index on bridge_contracts.imports (0001) is dead weight: the
-- dependents()/graph lookups fetch (org, project, base<>) rows and match
-- imports in JS, because an import spelled by base name ('payments') must
-- resolve to the full 'payments.vN' family — a jsonb @> predicate cannot
-- express that. Dropping the unused index removes its write cost on every
-- publish (issue #48, item 11 offers "SQL-side import filter or drop").
--
-- 0001_init.sql is intentionally left untouched so existing databases
-- keep migrating cleanly.

CREATE INDEX IF NOT EXISTS bridge_audit_org_project_time_idx
    ON bridge_audit (org, project, time DESC);

DROP INDEX IF EXISTS bridge_contracts_imports_idx;
