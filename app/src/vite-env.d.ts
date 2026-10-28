/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The Zireh host (relay and sync). Defaults to http://127.0.0.1:8788. */
  readonly VITE_HOST_URL?: string;
}
