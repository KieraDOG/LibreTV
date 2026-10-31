# NAS 后台下载

此 fork 新增「下载到 NAS」和任务面板。Next.js API 负责提交任务，独立 Node Worker 串行下载；任务及完整临时视频存入 SQLite 所在的数据卷。FFmpeg 以 stream copy 下载/转封装，不做视频转码。下载完成后，smbclient 通过 SMB2+ 上传到共享目录根目录，校验文件大小，再重命名为正式 MP4，最后删除本地文件。

## Docker 部署

主机需安装并启动 Docker。DS213j 只负责 SMB 存储，不运行容器。

1. 复制 `.env.nas.example` 为 `.env`，填写配置。不要提交 `.env`。
2. DSM 开启 SMB2/SMB3；创建只对指定共享目录有写权限的账号。
3. 在仓库目录运行：

```sh
docker compose -f docker-compose.nas.yml up -d --build
```

4. 打开 `http://localhost:8080`，使用 PASSWORD 登录；配置 LibreTV 点播源，打开一集，点击「下载到 NAS」。
5. 点击「NAS 任务」查看排队、下载、上传、完成或失败状态。

```sh
docker compose -f docker-compose.nas.yml logs -f
```

配置：

| 变量 | 说明 |
| --- | --- |
| PASSWORD | LibreTV 登录密码，必须设置 |
| NAS_DOWNLOAD_ENABLED | `1` 启用 NAS API 和 Worker |
| NAS_HOST | 群晖 IP 或主机名，不含 smb:// |
| NAS_SHARE | 共享目录名，例如 video；不是 /volume1/video，也不是完整 UNC 路径 |
| NAS_USERNAME / NAS_PASSWORD | 专用群晖账号和密码 |
| NAS_DOMAIN | 默认 WORKGROUP |
| DOWNLOAD_DATA_DIR | 容器内固定为 /data；本地开发默认 ./data/nas-downloads |

Docker 使用命名卷 downloads。正常重建容器不会删除数据；不要执行 `down -v`，否则任务及临时文件会删除。输出文件带任务 ID 后缀以避免同名覆盖。

## 本地开发

需要 Node.js 22、FFmpeg、smbclient，并确保命令可从 PATH 执行。

```sh
npm ci
cp .env.nas.example .env
# 编辑 .env 后，在两个终端分别运行：
npm run dev
npm run worker
```

同一个数据库只启动一个 Worker。Docker 启动脚本使用 flock 防止重复 Worker；本地开发不要重复运行 worker 命令。浏览器不接触 SMB 账号密码。NAS 下载 API 复用 LibreTV 登录并检查写操作的 Origin。

## 任务与限制

- 目前支持当前集、单并发、轮询状态、取消和手动重试。时间显示为已处理的视频时长，不是下载百分比。
- 下载过程重启或失败：重试会重新下载该集，不支持分片级续传。
- 视频已下载但 NAS 上传失败：保留完整本地视频，重试直接重新上传，不重复下载。
- 重启 Worker 会重新排队中断任务；取消是尽力终止，若 NAS 已完成重命名，可能保留最终文件。取消上传可能留下 `.part`，可在 NAS 手动清理。
- 源地址过期时，请从播放页重新提交最新地址；重试不会自动重新解析片源。
- 不继承浏览器 Cookie、特殊 Referer、自定义请求头；有防盗链的源可能失败。暂不复制浏览器广告过滤、片头片尾跳过规则，也不支持 DRM。
- FFmpeg 通过仅监听回环地址的代理读取资源，代理检查播放列表、分片、密钥和重定向目标。网络校验沿用上游 SSRF 模块，不承诺抵御 DNS rebinding；仅用于家庭受信任用户，避免对公网开放。
- 不做转码，不兼容的编码封装到 MP4 时会报错；后续可增加 MKV 输出。
- 开始任务要求至少 2GB 剩余空间，但尚无严格配额；大型视频可能超过该空间。失败任务保留的完整视频需要重试或取消清理。
- 同一容器包含 Next.js、Worker、FFmpeg 和 smbclient；tini 处理进程信号，关键进程退出时容器退出，由 restart 策略重新启动。

## 验证状态

队列测试覆盖去重、原子领取、取消、重试、恢复。Worker 流程测试使用模拟 FFmpeg/smbclient，验证 NAS 失败保留文件、重试成功后清理。真实视频源、真实 NAS、容器内工具版本仍需部署后验收。
