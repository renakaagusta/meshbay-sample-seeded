-- Deliberately broken: MESH-160 uses v3-broken to prove a failed migration
-- stops the rollout while the previous revision keeps serving.
ALTER TABLE "items_that_do_not_exist" ADD COLUMN "labels" TEXT;
