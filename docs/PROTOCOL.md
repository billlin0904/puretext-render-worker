# PureText Render Worker Protocol（草案）

所有請求使用 HTTPS，並以專用 Worker Token 驗證。Worker 不直接存取
Redis、RDS 或使用者 OAuth 憑證。

## Worker → PureText API

```text
POST /api/internal/render-workers/claim
POST /api/internal/render-workers/heartbeat
POST /api/internal/render-jobs/:jobId/progress
POST /api/internal/render-jobs/:jobId/complete
POST /api/internal/render-jobs/:jobId/fail
```

## 領取任務

請求：

```json
{
  "workerId": "gpu-pro-6000-01",
  "capabilities": {
    "encoders": ["h264_nvenc"],
    "maxConcurrency": 2
  }
}
```

回應沒有任務時使用 HTTP 204；有任務時回傳：

```json
{
  "jobId": "render-uuid",
  "leaseToken": "one-time-lease-token",
  "leaseExpiresAt": "2026-09-03T12:00:00Z",
  "input": {
    "downloadUrl": "short-lived-presigned-get-url",
    "size": 123456789,
    "sha256": "optional-input-hash"
  },
  "output": {
    "objectKey": "video-renders/42/render-uuid.mp4"
  },
  "renderSpec": {},
  "renderOptions": {
    "width": 1920,
    "height": 1080,
    "frameRate": 30,
    "encoder": "h264_nvenc"
  }
}
```

Worker 完成本機編碼後才呼叫以下端點取得新的短效上傳網址，避免長影片
尚未轉完網址就已過期：

```text
POST /api/internal/render-jobs/:jobId/prepare-upload
```

請求包含輸出大小、SHA-256 與租約 Token，回應包含 Presigned PUT URL、
Object Key 及上傳時必須附帶的標頭。

## 完成回報

```json
{
  "workerId": "gpu-pro-6000-01",
  "leaseToken": "one-time-lease-token",
  "outputObjectKey": "video-renders/42/render-uuid.mp4",
  "size": 245678901,
  "sha256": "output-hash",
  "durationSeconds": 600
}
```

PureText API 必須先向 S3 驗證物件存在與大小，再將資料庫任務改為
`completed`。

## 租約與重試

- 領取任務後取得短效租約。
- Worker 每 20–30 秒回報心跳。
- 租約過期後任務可重新排隊。
- 同一 Job ID 的完成回報必須冪等。
- 預設最多重試三次，避免永久失敗任務無限耗用 GPU。
