-- CreateEnum
CREATE TYPE "ScanState" AS ENUM ('pending', 'running', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "VersionStatus" AS ENUM ('up_to_date', 'outdated', 'unknown');

-- CreateTable
CREATE TABLE "Scan" (
    "id" TEXT NOT NULL,
    "repoUrl" TEXT NOT NULL,
    "searchPath" TEXT,
    "ref" TEXT,
    "state" "ScanState" NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Scan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChartFinding" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "applicationName" TEXT NOT NULL,
    "applicationSetName" TEXT NOT NULL,
    "chartName" TEXT NOT NULL,
    "repoUrl" TEXT NOT NULL,
    "currentVersion" TEXT NOT NULL,
    "latestVersion" TEXT,
    "status" "VersionStatus" NOT NULL,
    "note" TEXT,

    CONSTRAINT "ChartFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageFinding" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "applicationName" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "currentTag" TEXT NOT NULL,
    "latestTag" TEXT,
    "status" "VersionStatus" NOT NULL,
    "note" TEXT,

    CONSTRAINT "ImageFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChartFinding_scanId_idx" ON "ChartFinding"("scanId");

-- CreateIndex
CREATE INDEX "ImageFinding_scanId_idx" ON "ImageFinding"("scanId");

-- AddForeignKey
ALTER TABLE "ChartFinding" ADD CONSTRAINT "ChartFinding_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageFinding" ADD CONSTRAINT "ImageFinding_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
