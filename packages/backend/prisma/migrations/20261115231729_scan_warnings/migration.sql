-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Scan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoUrl" TEXT NOT NULL,
    "searchPath" TEXT,
    "ref" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "warnings" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);
INSERT INTO "new_Scan" ("createdAt", "errorMessage", "finishedAt", "id", "ref", "repoUrl", "searchPath", "state") SELECT "createdAt", "errorMessage", "finishedAt", "id", "ref", "repoUrl", "searchPath", "state" FROM "Scan";
DROP TABLE "Scan";
ALTER TABLE "new_Scan" RENAME TO "Scan";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
