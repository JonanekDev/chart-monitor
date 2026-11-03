-- CreateEnum
CREATE TYPE "CveSeverity" AS ENUM ('UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateTable
CREATE TABLE "CveFinding" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "applicationName" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "vulnerabilityId" TEXT NOT NULL,
    "pkgName" TEXT NOT NULL,
    "installedVersion" TEXT NOT NULL,
    "fixedVersion" TEXT,
    "severity" "CveSeverity" NOT NULL,
    "title" TEXT,

    CONSTRAINT "CveFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CveFinding_scanId_idx" ON "CveFinding"("scanId");

-- AddForeignKey
ALTER TABLE "CveFinding" ADD CONSTRAINT "CveFinding_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
