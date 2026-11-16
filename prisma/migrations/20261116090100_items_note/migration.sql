ALTER TABLE "items" ADD COLUMN "note" TEXT NOT NULL DEFAULT '';

CREATE INDEX "items_created_at_idx" ON "items"("created_at");
