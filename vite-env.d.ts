/// <reference types="vite/client" />

// compat-rom/*.ROM は Vite の `?url` サフィックスでアセットURLとして取り込む。
// 拡張子が独自のためデフォルトの型定義に無いので明示する。
declare module '*.ROM?url' {
  const url: string;
  export default url;
}
