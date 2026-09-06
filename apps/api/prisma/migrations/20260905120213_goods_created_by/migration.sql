-- AlterTable
ALTER TABLE `Goods` ADD COLUMN `createdBy` VARCHAR(26) NULL;

-- CreateIndex
CREATE INDEX `Goods_tenantId_createdBy_idx` ON `Goods`(`tenantId`, `createdBy`);
