-- The ledger is history: once written, a transaction and its entries are
-- never changed or removed — a correction is a new, compensating transaction.
--
-- Application code already never updates or deletes ledger rows (checked:
-- no update/delete call on either model anywhere in the API). But both models
-- sit in the generic soft-delete middleware, so a stray `delete()` would have
-- quietly hidden money from every balance. This makes the database refuse any
-- UPDATE or DELETE outright, below any code that might forget.
--
-- No data is touched. TRUNCATE (the local demo seed's reset) is not a row
-- operation and is unaffected.

CREATE OR REPLACE FUNCTION "ledger_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Ledger rows are append-only: % on % refused', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LedgerEntry_append_only"
  BEFORE UPDATE OR DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION "ledger_append_only"();

CREATE TRIGGER "LedgerTransaction_append_only"
  BEFORE UPDATE OR DELETE ON "LedgerTransaction"
  FOR EACH ROW EXECUTE FUNCTION "ledger_append_only"();
