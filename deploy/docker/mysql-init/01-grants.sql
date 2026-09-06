-- Prisma 的 `migrate dev` 会临时建一个 shadow database 来算 diff，
-- 而 MYSQL_USER 默认只有目标库的权限，于是 `prisma migrate dev` 报 P3014 / P1010。
-- 本地开发库给全权限最省事；生产用 `prisma migrate deploy`（不需要 shadow db），
-- 那边的账号只给目标库权限即可。
GRANT ALL PRIVILEGES ON *.* TO 'taizan'@'%';
FLUSH PRIVILEGES;
