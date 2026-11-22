-- CreateTable
CREATE TABLE "ChangelogCache" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "changes" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
