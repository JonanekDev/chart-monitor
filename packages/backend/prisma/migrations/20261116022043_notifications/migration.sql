-- CreateTable
CREATE TABLE "NotificationChannel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Monitor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoUrl" TEXT NOT NULL,
    "searchPath" TEXT,
    "ref" TEXT,
    "schedule" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "channelId" TEXT,
    "notifyMinSeverity" TEXT DEFAULT 'HIGH',
    "notifyOnlyFixable" BOOLEAN NOT NULL DEFAULT true,
    "notifyChartUpdates" TEXT NOT NULL DEFAULT 'any',
    "notifyOnFailure" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "Monitor_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "NotificationChannel" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Monitor" ("createdAt", "enabled", "id", "ref", "repoUrl", "schedule", "searchPath") SELECT "createdAt", "enabled", "id", "ref", "repoUrl", "schedule", "searchPath" FROM "Monitor";
DROP TABLE "Monitor";
ALTER TABLE "new_Monitor" RENAME TO "Monitor";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
