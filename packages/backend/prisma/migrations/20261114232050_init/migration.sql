-- CreateTable
CREATE TABLE "Scan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoUrl" TEXT NOT NULL,
    "searchPath" TEXT,
    "ref" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "ChartFinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scanId" TEXT NOT NULL,
    "applicationName" TEXT NOT NULL,
    "applicationSetName" TEXT NOT NULL,
    "chartName" TEXT NOT NULL,
    "repoUrl" TEXT NOT NULL,
    "currentVersion" TEXT NOT NULL,
    "latestVersion" TEXT,
    "status" TEXT NOT NULL,
    "note" TEXT,
    CONSTRAINT "ChartFinding_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ImageFinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scanId" TEXT NOT NULL,
    "applicationName" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "currentTag" TEXT NOT NULL,
    "latestTag" TEXT,
    "status" TEXT NOT NULL,
    "note" TEXT,
    CONSTRAINT "ImageFinding_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CveFinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scanId" TEXT NOT NULL,
    "applicationName" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "vulnerabilityId" TEXT NOT NULL,
    "pkgName" TEXT NOT NULL,
    "installedVersion" TEXT NOT NULL,
    "fixedVersion" TEXT,
    "severity" TEXT NOT NULL,
    "title" TEXT,
    CONSTRAINT "CveFinding_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ChartFinding_scanId_idx" ON "ChartFinding"("scanId");

-- CreateIndex
CREATE INDEX "ImageFinding_scanId_idx" ON "ImageFinding"("scanId");

-- CreateIndex
CREATE INDEX "CveFinding_scanId_idx" ON "CveFinding"("scanId");
