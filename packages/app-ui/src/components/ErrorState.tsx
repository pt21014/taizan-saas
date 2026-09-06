import React from 'react'

import { EmptyState } from './EmptyState'

export interface ErrorStateProps {
  /** 已经拼好追踪号的错误提示，直接来自 `createApiClient` 的 `formatWithTrace()`。 */
  message: string
  onRetry?: () => void
}

/** 错误态：本质是「空状态」的一种，多一个「重试」动作。 */
export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return <EmptyState title={message} action={onRetry ? '重试' : undefined} onAction={onRetry} />
}
