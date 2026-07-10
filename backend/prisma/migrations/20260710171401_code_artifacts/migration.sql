-- CreateEnum
CREATE TYPE "artifact_origin" AS ENUM ('ai', 'user');

-- CreateTable
CREATE TABLE "code_artifacts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "message_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "parent_artifact_id" UUID,
    "origin" "artifact_origin" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "code_artifacts_session_id_filename_revision_idx" ON "code_artifacts"("session_id", "filename", "revision" DESC);

-- CreateIndex
CREATE INDEX "code_artifacts_message_id_idx" ON "code_artifacts"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "code_artifacts_session_id_filename_revision_key" ON "code_artifacts"("session_id", "filename", "revision");

-- AddForeignKey
ALTER TABLE "code_artifacts" ADD CONSTRAINT "code_artifacts_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_artifacts" ADD CONSTRAINT "code_artifacts_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_artifacts" ADD CONSTRAINT "code_artifacts_parent_artifact_id_fkey" FOREIGN KEY ("parent_artifact_id") REFERENCES "code_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
