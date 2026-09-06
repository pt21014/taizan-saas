/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ADMIN_URL?: string
  readonly VITE_ICP_NUMBER?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
