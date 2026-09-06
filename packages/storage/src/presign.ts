/**
 * 预签名过期时间的公共校验，供 COS/VOD 两套实现共用。
 *
 * 过期时间不是"越长越安全"或"越短越安全"——太短会在慢网络下签出的地址还没
 * 用完就过期（尤其是直传大文件），太长则私有对象的临时地址形同长期公开。
 * 统一在这里夹一个上下限，实现类不用各自记一遍数字。
 */

/** 最短 60 秒：短于这个数，慢网络下经常来不及用完。 */
export const MIN_EXPIRE_SECONDS = 60
/** 最长 7 天：够覆盖"分享链接过几天再点"的场景，不至于变相长期公开。 */
export const MAX_EXPIRE_SECONDS = 7 * 24 * 60 * 60

/**
 * 校验有效期，越界则抛。
 *
 * @throws `expireSeconds` 不是正整数，或超出 `[MIN_EXPIRE_SECONDS, MAX_EXPIRE_SECONDS]` 时抛
 */
export function assertValidExpireSeconds(expireSeconds: number): void {
  if (!Number.isInteger(expireSeconds) || expireSeconds <= 0) {
    throw new Error(`[@taizan/storage] expireSeconds 必须是正整数，收到 ${expireSeconds}`)
  }
  if (expireSeconds < MIN_EXPIRE_SECONDS) {
    throw new Error(
      `[@taizan/storage] expireSeconds 太短（${expireSeconds} < ${MIN_EXPIRE_SECONDS}）：` +
        '慢网络下签出的地址可能还没用完就过期。',
    )
  }
  if (expireSeconds > MAX_EXPIRE_SECONDS) {
    throw new Error(
      `[@taizan/storage] expireSeconds 太长（${expireSeconds} > ${MAX_EXPIRE_SECONDS}）：` +
        '私有对象的临时地址不该变相长期公开。',
    )
  }
}
