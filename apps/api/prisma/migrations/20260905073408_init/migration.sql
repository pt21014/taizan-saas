-- CreateTable
CREATE TABLE `Tenant` (
    `id` VARCHAR(26) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `status` ENUM('TRIAL', 'ACTIVE', 'SUSPENDED', 'DEREGISTERED') NOT NULL DEFAULT 'TRIAL',
    `planId` VARCHAR(26) NULL,
    `planExpireAt` DATETIME(3) NULL,
    `trialEndAt` DATETIME(3) NULL,
    `graceDays` INTEGER NOT NULL DEFAULT 0,
    `retentionDays` INTEGER NOT NULL DEFAULT 7,
    `deregisterAt` DATETIME(3) NULL,
    `ownerAccountId` VARCHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Tenant_slug_key`(`slug`),
    INDEX `Tenant_status_idx`(`status`),
    INDEX `Tenant_planId_idx`(`planId`),
    INDEX `Tenant_ownerAccountId_idx`(`ownerAccountId`),
    INDEX `Tenant_planExpireAt_idx`(`planExpireAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TenantVerification` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `type` ENUM('ENTERPRISE', 'INDIVIDUAL', 'PERSONAL') NOT NULL,
    `legalName` VARCHAR(191) NOT NULL,
    `licenseNo` VARCHAR(191) NOT NULL,
    `attachments` JSON NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `reviewedBy` VARCHAR(26) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `rejectReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `TenantVerification_tenantId_id_idx`(`tenantId`, `id`),
    INDEX `TenantVerification_tenantId_status_idx`(`tenantId`, `status`),
    INDEX `TenantVerification_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TenantCredential` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `credKey` VARCHAR(191) NOT NULL,
    `valueEnc` TEXT NOT NULL,
    `keyId` VARCHAR(191) NOT NULL,
    `maskedHint` VARCHAR(191) NULL,
    `updatedBy` VARCHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `TenantCredential_tenantId_id_idx`(`tenantId`, `id`),
    UNIQUE INDEX `TenantCredential_tenantId_provider_credKey_deletedAt_key`(`tenantId`, `provider`, `credKey`, `deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Plan` (
    `id` VARCHAR(26) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `firstPriceCents` INTEGER NOT NULL,
    `renewPriceCents` INTEGER NOT NULL,
    `periodMonths` INTEGER NOT NULL,
    `quotas` JSON NOT NULL,
    `features` JSON NULL,
    `appKeys` JSON NOT NULL,
    `trafficMb` INTEGER NOT NULL DEFAULT 0,
    `status` ENUM('ENABLED', 'DISABLED', 'ARCHIVED') NOT NULL DEFAULT 'ENABLED',
    `sort` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Plan_code_key`(`code`),
    INDEX `Plan_status_sort_idx`(`status`, `sort`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlanOrder` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `planId` VARCHAR(26) NOT NULL,
    `type` ENUM('OPEN', 'RENEW', 'UPGRADE') NOT NULL,
    `periods` INTEGER NOT NULL DEFAULT 1,
    `amountCents` INTEGER NOT NULL,
    `discountCents` INTEGER NOT NULL DEFAULT 0,
    `status` ENUM('PENDING', 'PAID', 'FULFILLED', 'CANCELLED', 'REFUNDED') NOT NULL DEFAULT 'PENDING',
    `payChannel` ENUM('WECHAT', 'ALIPAY', 'DOUYIN', 'OFFLINE') NULL,
    `outTradeNo` VARCHAR(191) NOT NULL,
    `transactionId` VARCHAR(191) NULL,
    `paidAt` DATETIME(3) NULL,
    `fulfilledAt` DATETIME(3) NULL,
    `expireBeforeAt` DATETIME(3) NULL,
    `expireAfterAt` DATETIME(3) NULL,
    `operatorId` VARCHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PlanOrder_outTradeNo_key`(`outTradeNo`),
    INDEX `PlanOrder_tenantId_id_idx`(`tenantId`, `id`),
    INDEX `PlanOrder_tenantId_status_createdAt_idx`(`tenantId`, `status`, `createdAt`),
    INDEX `PlanOrder_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `PlanOrder_transactionId_idx`(`transactionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `QuotaCounter` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `kind` ENUM('STAFF', 'STORE', 'MEMBER', 'STORAGE_MB', 'TRAFFIC_MB', 'CUSTOM') NOT NULL,
    `used` INTEGER NOT NULL DEFAULT 0,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `QuotaCounter_tenantId_id_idx`(`tenantId`, `id`),
    UNIQUE INDEX `QuotaCounter_tenantId_kind_key`(`tenantId`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlatformAdmin` (
    `id` VARCHAR(26) NOT NULL,
    `username` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `roleIds` JSON NOT NULL,
    `mfaSecretEnc` TEXT NULL,
    `mfaKeyId` VARCHAR(191) NULL,
    `lastLoginAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PlatformAdmin_username_key`(`username`),
    INDEX `PlatformAdmin_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StaffAccount` (
    `id` VARCHAR(26) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `avatar` VARCHAR(191) NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `StaffAccount_phone_key`(`phone`),
    INDEX `StaffAccount_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Staff` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `accountId` VARCHAR(26) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `status` ENUM('ACTIVE', 'DISABLED', 'LEFT') NOT NULL DEFAULT 'ACTIVE',
    `roleIds` JSON NOT NULL,
    `dataScope` ENUM('ALL', 'SUB_TREE', 'SELF', 'CUSTOM') NOT NULL DEFAULT 'SELF',
    `scopeTargets` JSON NULL,
    `isOwner` BOOLEAN NOT NULL DEFAULT false,
    `invitedBy` VARCHAR(26) NULL,
    `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `Staff_tenantId_id_idx`(`tenantId`, `id`),
    INDEX `Staff_accountId_idx`(`accountId`),
    INDEX `Staff_tenantId_status_idx`(`tenantId`, `status`),
    UNIQUE INDEX `Staff_tenantId_accountId_deletedAt_key`(`tenantId`, `accountId`, `deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StaffInvite` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `phone` VARCHAR(191) NULL,
    `token` VARCHAR(191) NOT NULL,
    `roleIds` JSON NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `usedBy` VARCHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `StaffInvite_token_key`(`token`),
    INDEX `StaffInvite_tenantId_id_idx`(`tenantId`, `id`),
    INDEX `StaffInvite_tenantId_expiresAt_idx`(`tenantId`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Member` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `phone` VARCHAR(191) NULL,
    `unionId` VARCHAR(191) NULL,
    `openId` VARCHAR(191) NULL,
    `nickname` VARCHAR(191) NULL,
    `avatar` VARCHAR(191) NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `lastLoginAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `Member_tenantId_id_idx`(`tenantId`, `id`),
    INDEX `Member_tenantId_status_idx`(`tenantId`, `status`),
    UNIQUE INDEX `Member_tenantId_phone_deletedAt_key`(`tenantId`, `phone`, `deletedAt`),
    UNIQUE INDEX `Member_tenantId_unionId_deletedAt_key`(`tenantId`, `unionId`, `deletedAt`),
    UNIQUE INDEX `Member_tenantId_openId_deletedAt_key`(`tenantId`, `openId`, `deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Permission` (
    `id` VARCHAR(26) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `module` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `type` ENUM('API', 'MENU', 'BUTTON') NOT NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Permission_code_key`(`code`),
    INDEX `Permission_module_sort_idx`(`module`, `sort`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Menu` (
    `id` VARCHAR(26) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `parentKey` VARCHAR(191) NULL,
    `title` VARCHAR(191) NOT NULL,
    `icon` VARCHAR(191) NULL,
    `path` VARCHAR(191) NULL,
    `componentKey` VARCHAR(191) NULL,
    `type` ENUM('DIR', 'MENU', 'BUTTON') NOT NULL,
    `permission` VARCHAR(191) NULL,
    `featureKey` VARCHAR(191) NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,
    `side` ENUM('ADMIN', 'PLATFORM') NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Menu_key_key`(`key`),
    INDEX `Menu_side_parentKey_sort_idx`(`side`, `parentKey`, `sort`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RolePreset` (
    `id` VARCHAR(26) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `side` ENUM('ADMIN', 'PLATFORM') NOT NULL,
    `permissionCodes` JSON NOT NULL,
    `builtin` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `RolePreset_side_idx`(`side`),
    UNIQUE INDEX `RolePreset_code_side_key`(`code`, `side`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Role` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `permissionCodes` JSON NOT NULL,
    `menuKeys` JSON NULL,
    `builtin` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `Role_tenantId_id_idx`(`tenantId`, `id`),
    UNIQUE INDEX `Role_tenantId_code_deletedAt_key`(`tenantId`, `code`, `deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuditLog` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `actorType` ENUM('PLATFORM_ADMIN', 'STAFF', 'MEMBER', 'SYSTEM') NOT NULL,
    `actorId` VARCHAR(191) NOT NULL,
    `actorName` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `targetType` VARCHAR(191) NULL,
    `targetId` VARCHAR(191) NULL,
    `before` JSON NULL,
    `after` JSON NULL,
    `ip` VARCHAR(191) NOT NULL,
    `traceId` VARCHAR(191) NOT NULL,
    `result` ENUM('SUCCESS', 'FAIL') NOT NULL DEFAULT 'SUCCESS',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AuditLog_tenantId_id_idx`(`tenantId`, `id`),
    INDEX `AuditLog_tenantId_createdAt_idx`(`tenantId`, `createdAt`),
    INDEX `AuditLog_tenantId_action_createdAt_idx`(`tenantId`, `action`, `createdAt`),
    INDEX `AuditLog_traceId_idx`(`traceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlatformAuditLog` (
    `id` VARCHAR(26) NOT NULL,
    `targetTenantId` VARCHAR(26) NULL,
    `actorType` ENUM('PLATFORM_ADMIN', 'STAFF', 'MEMBER', 'SYSTEM') NOT NULL DEFAULT 'PLATFORM_ADMIN',
    `actorId` VARCHAR(191) NOT NULL,
    `actorName` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `targetType` VARCHAR(191) NULL,
    `targetId` VARCHAR(191) NULL,
    `before` JSON NULL,
    `after` JSON NULL,
    `ip` VARCHAR(191) NOT NULL,
    `traceId` VARCHAR(191) NOT NULL,
    `result` ENUM('SUCCESS', 'FAIL') NOT NULL DEFAULT 'SUCCESS',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PlatformAuditLog_targetTenantId_createdAt_idx`(`targetTenantId`, `createdAt`),
    INDEX `PlatformAuditLog_action_createdAt_idx`(`action`, `createdAt`),
    INDEX `PlatformAuditLog_traceId_idx`(`traceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Announcement` (
    `id` VARCHAR(26) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `contentHtml` LONGTEXT NOT NULL,
    `audience` ENUM('ALL_TENANT', 'PLAN', 'TENANT_IDS', 'C_END') NOT NULL DEFAULT 'ALL_TENANT',
    `audienceRefs` JSON NULL,
    `level` ENUM('INFO', 'WARNING', 'CRITICAL') NOT NULL DEFAULT 'INFO',
    `publishAt` DATETIME(3) NOT NULL,
    `expireAt` DATETIME(3) NULL,
    `status` ENUM('DRAFT', 'PUBLISHED', 'ARCHIVED') NOT NULL DEFAULT 'DRAFT',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Announcement_status_publishAt_idx`(`status`, `publishAt`),
    INDEX `Announcement_audience_status_idx`(`audience`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AnnouncementRead` (
    `id` VARCHAR(26) NOT NULL,
    `announcementId` VARCHAR(26) NOT NULL,
    `readerType` ENUM('PLATFORM_ADMIN', 'STAFF', 'MEMBER', 'SYSTEM') NOT NULL,
    `readerId` VARCHAR(26) NOT NULL,
    `readAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AnnouncementRead_readerType_readerId_idx`(`readerType`, `readerId`),
    UNIQUE INDEX `AnnouncementRead_announcementId_readerType_readerId_key`(`announcementId`, `readerType`, `readerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlatformSetting` (
    `id` VARCHAR(26) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `value` JSON NOT NULL,
    `valueEnc` TEXT NULL,
    `keyId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PlatformSetting_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `IdempotencyKey` (
    `id` VARCHAR(26) NOT NULL,
    `scope` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `status` ENUM('IN_PROGRESS', 'SUCCEEDED', 'FAILED') NOT NULL DEFAULT 'IN_PROGRESS',
    `resultHash` VARCHAR(191) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `IdempotencyKey_expiresAt_idx`(`expiresAt`),
    UNIQUE INDEX `IdempotencyKey_scope_key_key`(`scope`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `JobDeadLetter` (
    `id` VARCHAR(26) NOT NULL,
    `queue` VARCHAR(191) NOT NULL,
    `jobName` VARCHAR(191) NOT NULL,
    `originTenantId` VARCHAR(26) NULL,
    `payload` JSON NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `lastError` TEXT NOT NULL,
    `traceId` VARCHAR(191) NOT NULL,
    `resolvedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `JobDeadLetter_queue_createdAt_idx`(`queue`, `createdAt`),
    INDEX `JobDeadLetter_originTenantId_createdAt_idx`(`originTenantId`, `createdAt`),
    INDEX `JobDeadLetter_resolvedAt_idx`(`resolvedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CronRun` (
    `id` VARCHAR(26) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `instanceId` VARCHAR(191) NOT NULL,
    `ok` BOOLEAN NOT NULL DEFAULT false,
    `error` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CronRun_key_startedAt_idx`(`key`, `startedAt`),
    INDEX `CronRun_startedAt_idx`(`startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OutboxEvent` (
    `id` VARCHAR(26) NOT NULL,
    `originTenantId` VARCHAR(26) NULL,
    `topic` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,
    `status` ENUM('PENDING', 'SENT', 'FAILED', 'DEAD') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `availableAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `OutboxEvent_status_availableAt_idx`(`status`, `availableAt`),
    INDEX `OutboxEvent_topic_status_idx`(`topic`, `status`),
    INDEX `OutboxEvent_originTenantId_createdAt_idx`(`originTenantId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NotifyTemplate` (
    `id` VARCHAR(26) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `channel` ENUM('SMS', 'EMAIL', 'WECHAT_OA', 'WECHAT_MP', 'APP_PUSH', 'IN_APP') NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `content` TEXT NOT NULL,
    `providerTemplateId` VARCHAR(191) NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `NotifyTemplate_key_key`(`key`),
    INDEX `NotifyTemplate_channel_enabled_idx`(`channel`, `enabled`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NotifyRecord` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `channel` ENUM('SMS', 'EMAIL', 'WECHAT_OA', 'WECHAT_MP', 'APP_PUSH', 'IN_APP') NOT NULL,
    `templateKey` VARCHAR(191) NOT NULL,
    `to` VARCHAR(191) NOT NULL,
    `vars` JSON NOT NULL,
    `status` ENUM('PENDING', 'SENDING', 'SENT', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `error` TEXT NULL,
    `traceId` VARCHAR(191) NOT NULL,
    `sentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `NotifyRecord_tenantId_id_idx`(`tenantId`, `id`),
    INDEX `NotifyRecord_tenantId_status_createdAt_idx`(`tenantId`, `status`, `createdAt`),
    INDEX `NotifyRecord_tenantId_templateKey_createdAt_idx`(`tenantId`, `templateKey`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlatformNotifyRecord` (
    `id` VARCHAR(26) NOT NULL,
    `targetTenantId` VARCHAR(26) NULL,
    `channel` ENUM('SMS', 'EMAIL', 'WECHAT_OA', 'WECHAT_MP', 'APP_PUSH', 'IN_APP') NOT NULL,
    `templateKey` VARCHAR(191) NOT NULL,
    `to` VARCHAR(191) NOT NULL,
    `vars` JSON NOT NULL,
    `status` ENUM('PENDING', 'SENDING', 'SENT', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `error` TEXT NULL,
    `traceId` VARCHAR(191) NOT NULL,
    `sentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PlatformNotifyRecord_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `PlatformNotifyRecord_targetTenantId_createdAt_idx`(`targetTenantId`, `createdAt`),
    INDEX `PlatformNotifyRecord_templateKey_createdAt_idx`(`templateKey`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Goods` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `priceCents` INTEGER NOT NULL,
    `status` ENUM('DRAFT', 'ON_SHELF', 'OFF_SHELF') NOT NULL DEFAULT 'DRAFT',
    `stock` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `Goods_tenantId_id_idx`(`tenantId`, `id`),
    INDEX `Goods_tenantId_status_idx`(`tenantId`, `status`),
    UNIQUE INDEX `Goods_tenantId_name_deletedAt_key`(`tenantId`, `name`, `deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GoodsSku` (
    `id` VARCHAR(26) NOT NULL,
    `tenantId` VARCHAR(26) NOT NULL,
    `goodsId` VARCHAR(26) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `priceCents` INTEGER NOT NULL,
    `stock` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `GoodsSku_tenantId_id_idx`(`tenantId`, `id`),
    INDEX `GoodsSku_tenantId_goodsId_idx`(`tenantId`, `goodsId`),
    UNIQUE INDEX `GoodsSku_tenantId_goodsId_name_deletedAt_key`(`tenantId`, `goodsId`, `name`, `deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
