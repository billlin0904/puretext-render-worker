# PureText Render Worker

PureText 的獨立 GPU 影片輸出服務。Worker 由 GPU 主機主動透過 HTTPS
向 PureText API 領取任務、從私有物件儲存下載來源、使用 FFmpeg/NVENC
燒錄字幕，最後直接上傳 MP4 並回報進度。

> 目前狀態：架構與部署骨架。PureText 的 Worker API 與可執行映像完成前，
> 請勿部署至正式環境。

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

預定映像：

```text
billlin0904/puretext-render-worker:v0.1.0
billlin0904/puretext-render-worker:stable
```

正式環境發布後應固定版本或 digest，避免未審核的 `stable` 自動換版。

## 安全原則

- `.env`、Worker Token、AWS 金鑰不得提交。
- Worker 只允許對外 HTTPS 連線，不公開 Redis、RDS 或管理介面。
- 不在 Worker 保存 Google OAuth 憑證；來源與輸出均使用短效簽名網址。
- 完成上傳後驗證物件大小與 SHA-256，才將任務標記完成。
- 任務使用租約、心跳、重試上限與冪等 Job ID。

協定草案見 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)。
