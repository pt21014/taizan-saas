/**
 * 蓝图 §7 扩展点③：商家侧「平台公告」的权限点（T1-9）。
 *
 * 只有一个 `announcement:list`。「标记已读」不单列权限点——它写的是**读者自己的**
 * 一条回执，看得到公告的人当然标得了自己已读；单列一个 `announcement:read` 会造出
 * 「能看但不能已读」这种没人想要的组合。
 *
 * @packageDocumentation
 */

import { definePermissions } from '@taizan/contracts'

/** 公告模块（商家侧，只读平台发布的那些）的权限点。 */
export const ANNOUNCEMENT_PERMISSIONS = definePermissions({
  'announcement:list': { module: '公告', name: '查看平台公告', type: 'API' },
})
