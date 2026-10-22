# syntax=docker/dockerfile:1
#
# InstaBox keepalive 的容器版：镜像里装的就是本仓库自带的 keepalive.sh，
# 入口直接跑 `keepalive.sh --watch`，逻辑零重复 —— 脚本更新后重新 build 即可。
# 变量名、多账号写法和 VPS 版完全一致，不需要重新学一套配置。
FROM alpine:3.21

# keepalive.sh 只依赖 curl；jq 用来解析 /v1/machines，没有时脚本会自己退回 awk
RUN apk add --no-cache curl jq ca-certificates tzdata \
	&& rm -rf /var/cache/apk/*

COPY keepalive.sh /opt/instabox-keepalive/keepalive.sh
RUN chmod 0755 /opt/instabox-keepalive/keepalive.sh

# key 只从 .env 或环境变量读，不落命令行（docker ps 里看不到）
RUN mkdir -p /config
ENV INSTABOX_ENV_FILE=/config/.env \
	TZ=Asia/Shanghai

WORKDIR /opt/instabox-keepalive

ENTRYPOINT ["/bin/sh", "/opt/instabox-keepalive/keepalive.sh"]
CMD ["--watch"]
