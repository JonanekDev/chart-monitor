-- Scans now belong to a monitor; the existing ad-hoc (test) scans are dropped
DELETE FROM "CveFinding";
DELETE FROM "ImageFinding";
DELETE FROM "ChartFinding";
DELETE FROM "Scan";

/*
  Warnings:

  - Added the required column `monitorId` to the `Scan` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "Monitor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoUrl" TEXT NOT NULL,
    "searchPath" TEXT,
    "ref" TEXT,
    "schedule" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Scan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "monitorId" TEXT NOT NULL,
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
    "finishedAt" DATETIME,
    CONSTRAINT "Scan_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Scan" ("createdAt", "errorMessage", "finishedAt", "id", "phase", "progressDetail", "progressDone", "progressTotal", "ref", "repoUrl", "searchPath", "state", "warnings") SELECT "createdAt", "errorMessage", "finishedAt", "id", "phase", "progressDetail", "progressDone", "progressTotal", "ref", "repoUrl", "searchPath", "state", "warnings" FROM "Scan";
DROP TABLE "Scan";
ALTER TABLE "new_Scan" RENAME TO "Scan";
CREATE INDEX "Scan_monitorId_createdAt_idx" ON "Scan"("monitorId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
