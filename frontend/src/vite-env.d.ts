/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 前端版本号, 由 CI 在构建时经 VITE_APP_VERSION 注入(= 后端 APP_VERSION) */
  readonly VITE_APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
