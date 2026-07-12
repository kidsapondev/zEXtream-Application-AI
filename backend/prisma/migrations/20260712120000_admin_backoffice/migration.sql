-- CreateEnum
CREATE TYPE "admin_permission" AS ENUM ('users_view', 'users_manage_status', 'users_manage_role', 'users_manage_permissions', 'dashboard_view', 'audit_log_view');

-- CreateEnum
CREATE TYPE "admin_audit_action" AS ENUM ('user_role_changed', 'user_status_changed', 'user_permissions_changed');

-- CreateTable
CREATE TABLE "admin_permission_grants" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "permission" "admin_permission" NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "granted_by" UUID,

    CONSTRAINT "admin_permission_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_log_entries" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "actor_user_id" UUID,
    "target_user_id" UUID,
    "action" "admin_audit_action" NOT NULL,
    "detail" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_permission_grants_user_id_permission_key" ON "admin_permission_grants"("user_id", "permission");

-- CreateIndex
CREATE INDEX "admin_audit_log_entries_created_at_idx" ON "admin_audit_log_entries"("created_at" DESC);

-- AddForeignKey
ALTER TABLE "admin_permission_grants" ADD CONSTRAINT "admin_permission_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_log_entries" ADD CONSTRAINT "admin_audit_log_entries_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_log_entries" ADD CONSTRAINT "admin_audit_log_entries_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
