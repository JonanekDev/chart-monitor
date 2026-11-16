-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ImageFinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scanId" TEXT NOT NULL,
    "applicationName" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "currentTag" TEXT NOT NULL,
    "latestTag" TEXT,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "vulnerabilitiesScanned" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "ImageFinding_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ImageFinding" ("applicationName", "currentTag", "id", "image", "latestTag", "note", "scanId", "status") SELECT "applicationName", "currentTag", "id", "image", "latestTag", "note", "scanId", "status" FROM "ImageFinding";
DROP TABLE "ImageFinding";
ALTER TABLE "new_ImageFinding" RENAME TO "ImageFinding";
CREATE INDEX "ImageFinding_scanId_idx" ON "ImageFinding"("scanId");
CREATE TABLE "new_Scan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoUrl" TEXT NOT NULL,
    "searchPath" TEXT,
    "ref" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "warnings" TEXT NOT NULL DEFAULT '[]',
    "phase" TEXT,
    "progressDone" INTEGER NOT NULL DEFAULT 0,
    "progressTotal" INTEGER NOT NULL DEFAULT 0,
    "progressDetail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);
INSERT INTO "new_Scan" ("createdAt", "errorMessage", "finishedAt", "id", "ref", "repoUrl", "searchPath", "state", "warnings") SELECT "createdAt", "errorMessage", "finishedAt", "id", "ref", "repoUrl", "searchPath", "state", "warnings" FROM "Scan";
DROP TABLE "Scan";
ALTER TABLE "new_Scan" RENAME TO "Scan";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
