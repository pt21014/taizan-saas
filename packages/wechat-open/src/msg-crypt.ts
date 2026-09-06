/**
 * 微信开放平台「第三方平台」的消息加解密（搬自 knowledge `infra/wechat-open/msg-crypt.ts`）。
 *
 * 与支付回调的验签是两套东西，别混：
 * - 支付回调是**微信用私钥签名、我方用公钥验签**，证明报文出自微信；
 * - 这里是**双方共享一个 AES 密钥**（EncodingAESKey）对称加解密，
 *   再加一个共享 Token 算出的 sha1 签名做完整性校验。
 *
 * 所以这里的安全边界是「密钥没泄露」，不是「非对称不可伪造」——
 * EncodingAESKey 与 Token 必须只存在服务器环境变量里，绝不能进前端、进日志。
 *
 * 全部做成纯函数：加解密错了不会报错，只会解出一段乱码或验签恒不通过，
 * 而那时人已经在怀疑网络、怀疑配置了。用官方文档给的样例做逐字节比对，
 * 是唯一能提前发现的办法（见 `msg-crypt.spec.ts`）。
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { wechatOpenError } from './errors'

/** 微信的 PKCS#7 填充**块长是 32**（不是 AES 的 16），照官方 demo 来 */
const BLOCK_SIZE = 32

/**
 * EncodingAESKey 是 43 位 base64（去掉了结尾的 `=`），补回来才能解出 32 字节密钥。
 * IV 取密钥的前 16 字节——微信这么定的，不是随机 IV。
 */
export function aesKeyOf(encodingAesKey: string): { key: Buffer; iv: Buffer } {
  const key = Buffer.from(`${encodingAesKey}=`, 'base64')
  if (key.length !== 32) {
    throw wechatOpenError('MSG_DECRYPT_FAILED', {
      message: `EncodingAESKey 必须是 43 位，当前解出 ${key.length} 字节（应为 32）`,
    })
  }
  return { key, iv: key.subarray(0, 16) }
}

/**
 * 消息签名 = sha1(把 token/timestamp/nonce/密文**按字典序排序**后直接拼起来)。
 *
 * 排序这一步最容易漏：不排的话本地自测能过（因为拼接顺序自洽），
 * 一对接微信就恒不通过。
 */
export function signMsg(token: string, timestamp: string, nonce: string, encrypt: string): string {
  const raw = [token, timestamp, nonce, encrypt].sort().join('')
  return createHash('sha1').update(raw).digest('hex')
}

/** 定长比较，避免用 `===` 比签名时泄露前缀匹配长度 */
export function signMatches(expected: string, actual: string | undefined | null): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(actual ?? '')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * 校验回调 URL 上的 `msg_signature`，不通过直接抛。
 *
 * 单独抽出来是因为**它最容易被跳过**：解密本身在签名错时也可能「成功」
 * （攻击者用同一把 AESKey 造的密文），只有签名能证明报文出自微信。
 */
export function assertMsgSignature(input: {
  token: string
  timestamp: string
  nonce: string
  encrypt: string
  msgSignature: string
}): void {
  const expected = signMsg(input.token, input.timestamp, input.nonce, input.encrypt)
  if (!signMatches(expected, input.msgSignature)) {
    throw wechatOpenError('MSG_SIGNATURE_INVALID', { detail: 'msg_signature 与本地计算不一致' })
  }
}

/**
 * 解密并**同时校验 receiveId**。
 *
 * receiveId 校验不能省：密文里尾部带着它，如果只解密不比对，
 * 别人把发给另一个第三方平台的密文原样转投过来也能解开（同一个 AESKey 的场景下），
 * 而我方会把它当成自己的事件处理。
 *
 * @param receiveId 第三方平台场景下就是 component_appid
 */
export function decryptMsg(
  encodingAesKey: string,
  encrypted: string,
  receiveId: string,
): { message: string; receiveId: string } {
  const { key, iv } = aesKeyOf(encodingAesKey)
  const cipher = Buffer.from(encrypted, 'base64')

  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  // 微信用 32 字节块填充，Node 只认 16，所以关掉自动去填充自己来
  decipher.setAutoPadding(false)
  const padded = Buffer.concat([decipher.update(cipher), decipher.final()])

  const pad = padded[padded.length - 1] ?? 0
  if (pad < 1 || pad > BLOCK_SIZE) {
    throw wechatOpenError('MSG_DECRYPT_FAILED', {
      message: '解密结果的填充长度不合法，多半是 EncodingAESKey 配错了',
    })
  }
  const plain = padded.subarray(0, padded.length - pad)

  // 结构：16 字节随机数 ++ 4 字节大端消息长度 ++ 消息 ++ receiveId
  if (plain.length < 20) {
    throw wechatOpenError('MSG_DECRYPT_FAILED', { message: '解密结果过短，不是合法的微信密文' })
  }
  const msgLen = plain.readUInt32BE(16)
  if (20 + msgLen > plain.length) {
    throw wechatOpenError('MSG_DECRYPT_FAILED', { message: '消息长度字段与实际内容不符' })
  }

  const message = plain.subarray(20, 20 + msgLen).toString('utf8')
  const from = plain.subarray(20 + msgLen).toString('utf8')

  if (from !== receiveId) {
    throw wechatOpenError('RECEIVE_ID_MISMATCH', {
      message: `密文里的 receiveId 是 ${from}，与本平台 ${receiveId} 不符，拒绝处理`,
    })
  }
  return { message, receiveId: from }
}

/**
 * 加密（回复消息用）。
 *
 * 日常的授权事件回 `success` 明文就够；需要它是为了**全网发布检测**——
 * 微信会发几条测试消息，要求原样加密回去，回明文过不了。
 */
export function encryptMsg(encodingAesKey: string, message: string, receiveId: string): string {
  const { key, iv } = aesKeyOf(encodingAesKey)

  const msg = Buffer.from(message, 'utf8')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(msg.length, 0)
  const body = Buffer.concat([randomBytes(16), lenBuf, msg, Buffer.from(receiveId, 'utf8')])

  // 填满一整块也要再补一整块，否则去填充时会把真实内容当成填充切掉
  const padLen = BLOCK_SIZE - (body.length % BLOCK_SIZE) || BLOCK_SIZE
  const padded = Buffer.concat([body, Buffer.alloc(padLen, padLen)])

  const cipher = createCipheriv('aes-256-cbc', key, iv)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64')
}

/**
 * 从 XML 里取一个标签的值。
 *
 * 不引 XML 解析库：微信这几个报文的结构是固定的、扁平的，
 * 而引一个解析器意味着多一个要跟进安全公告的依赖（XXE 之类），
 * 换来的只是解析同样几个标签。
 */
export function xmlField(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${tag}>`).exec(
    xml,
  )
  if (!m) return null
  return (m[1] ?? m[2] ?? '').trim()
}

/** 拼回复用的加密 XML */
export function buildEncryptedReply(input: {
  aesKey: string
  token: string
  message: string
  receiveId: string
  timestamp: string
  nonce: string
}): string {
  const encrypt = encryptMsg(input.aesKey, input.message, input.receiveId)
  const signature = signMsg(input.token, input.timestamp, input.nonce, encrypt)
  return (
    '<xml>' +
    `<Encrypt><![CDATA[${encrypt}]]></Encrypt>` +
    `<MsgSignature><![CDATA[${signature}]]></MsgSignature>` +
    `<TimeStamp>${input.timestamp}</TimeStamp>` +
    `<Nonce><![CDATA[${input.nonce}]]></Nonce>` +
    '</xml>'
  )
}

/**
 * 一步到位：校验签名 → 解密 → 校验 receiveId → 返回明文 XML。
 *
 * 回调控制器应当只调这一个函数。分成三步各自调用的话，漏掉签名校验那一步
 * 在测试里看不出来（解密照样成功），只有真被人打了才知道。
 */
export function openMsg(input: {
  config: { appId: string; token: string; aesKey: string }
  encrypt: string
  msgSignature: string
  timestamp: string
  nonce: string
}): string {
  assertMsgSignature({
    token: input.config.token,
    timestamp: input.timestamp,
    nonce: input.nonce,
    encrypt: input.encrypt,
    msgSignature: input.msgSignature,
  })
  return decryptMsg(input.config.aesKey, input.encrypt, input.config.appId).message
}
