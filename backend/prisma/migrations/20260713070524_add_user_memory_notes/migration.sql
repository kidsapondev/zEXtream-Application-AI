-- CreateTable
CREATE TABLE "user_memory_notes" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "source_session_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_memory_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_memory_notes_user_id_created_at_idx" ON "user_memory_notes"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "user_memory_notes" ADD CONSTRAINT "user_memory_notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
