/// <reference types="vite/client" />

/** 构建时由 vite.config.ts 的 versionPlugin 注入（见 useVersionCheck） */
declare const __BUILD_VERSION__: string;
declare const __BUILD_ID__: string;
declare const __BUILD_TIME__: string;
