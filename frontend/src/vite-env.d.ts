/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MAPTILER_KEY?: string;
  readonly VITE_OPENAIP_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
