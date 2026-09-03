# PureText Render Worker

Current release: `v0.1.8` (`billlin0904/puretext:render-worker-0.1.8`).

PureText 的獨立 GPU 影片輸出服務。Worker 由 GPU 主機主動透過 HTTPS
向 PureText API 領取任務、從私有物件儲存下載來源、使用 FFmpeg/NVENC
燒錄字幕，最後直接上傳 MP4 並回報進度。

> 目前狀態：PureText 主站的租約 API、S3 來源／成品流程與下載轉址均已接上；
> 設定相同的 `RENDER_WORKER_TOKEN` 後即可領取字幕燒錄任務。

## 已實作

- HTTPS 長輪詢領取任務，1–8 個併發 slot。
- 短效網址下載來源影片與按需字型快取。
- 來源大小及 SHA-256 驗證與路徑穿越防護。
- 沿用 PureText 的 ASS／動態字幕渲染器。
- FFmpeg `h264_nvenc` 輸出及進度回報。
- 完成後取得新的 Presigned PUT URL，直接上傳 S3。
- 心跳、失敗回報、指數退避、暫存檔清理與健康檢查。

## 邊界

- 本 Repo：GPU Worker、FFmpeg/NVENC 執行環境、Compose 與發布流程。
- PureText：使用者介面、驗證、帳務、Redis、RDS、任務生命週期。
- S3：來源影片與輸出 MP4；Worker 只使用短效 Presigned URL。
- GPU 主機不直接連線 Redis 或 PostgreSQL，也不開放對外服務埠。

## 預定部署方式

GPU 主機只保存 `deploy/compose.yml` 和自己的 `.env`：

```bash
cd deploy
cp .env.example .env
docker compose pull
docker compose up -d
docker compose logs -f --tail=200
```

更新：

```bash
cd deploy
docker compose pull
docker compose up -d --remove-orphans
```

目前映像：

```text
billlin0904/puretext:render-worker-0.1.8
billlin0904/puretext:render-worker-latest
```

正式環境應固定版本或 digest，避免 `render-worker-latest` 自動換版。

## GPU.TW 不使用自訂 Docker 映像

若 GPU.TW 節點無法拉取自訂映像，可部署平台內建的 Ubuntu 22.04 + CUDA 12
環境並啟用 SSH。Worker 設定仍放在 GPU.TW 的環境變數，接著執行：

```bash
curl -fsSL https://raw.githubusercontent.com/billlin0904/puretext-render-worker/main/scripts/bootstrap-gputw.sh | bash
/workspace/puretext-render-worker/scripts/gputw-worker.sh start
```

管理指令：

```bash
/workspace/puretext-render-worker/scripts/gputw-worker.sh status
/workspace/puretext-render-worker/scripts/gputw-worker.sh logs
/workspace/puretext-render-worker/scripts/gputw-worker.sh restart
```

## 安全原則

- `.env`、Worker Token、AWS 金鑰不得提交。
- Worker 只允許對外 HTTPS 連線，不公開 Redis、RDS 或管理介面。
- `RENDER_ALLOW_INSECURE_HTTP=true` 僅供本機 S3 模擬測試，正式環境必須保持關閉。
- 不在 Worker 保存 Google OAuth 憑證；來源與輸出均使用短效簽名網址。
- 完成上傳後驗證物件大小與 SHA-256，才將任務標記完成。
- 任務使用租約、心跳、重試上限與冪等 Job ID。

協定草案見 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)。

## 本機驗證

```bash
npm ci
npm run typecheck
npm test
npm run build
```
