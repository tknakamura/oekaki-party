// ホーム画面に追加できるようにするための最小限のサービスワーカー。
// ゲームはリアルタイム通信なので、キャッシュはせず常にネットワークから読み込む。
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
