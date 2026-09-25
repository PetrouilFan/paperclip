-- Supports the run-bound cross-issue-influence fallback in
-- server/src/services/cross-issue-influence-limit.ts, which asks which issues a
-- run holds (checkout_run_id / execution_run_id) in order to attribute a
-- task-less run's write to a source issue. Both reads are equality lookups on
-- unindexed columns, so they would otherwise scan the company inside the
-- transaction that already holds a `for update` lock on the run's row.
--
-- `issues` is a medium-bucket table in table-size-estimates.ts, so the
-- large-create-index-not-concurrently rule does not apply and a plain
-- CREATE INDEX passes the migration safety gate. Both statements are
-- IF NOT EXISTS so a re-run against an already-migrated database is a no-op.
CREATE INDEX IF NOT EXISTS "issues_company_checkout_run_idx" ON "issues" USING btree ("company_id","checkout_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_execution_run_idx" ON "issues" USING btree ("company_id","execution_run_id");
