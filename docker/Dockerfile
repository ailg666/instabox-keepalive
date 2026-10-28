# InstaBox keepalive 的容器版：镜像里装的就是本仓库自带的 keepalive.sh，
# 入口直接跑 `keepalive.sh --watch`，逻辑零重复 —— 脚本更新后重新 build 即可。
# 变量名、多账号写法和 VPS 版完全一致，不需要重新学一套配置。
# 注：不用 `# syntax=docker/dockerfile:1` 前端声明——全是基础指令用不上，
# 还会多拉一个镜像，部分内网镜像代理（如飞牛 docker.fnnas.com）对它回 401。
FROM alpine:3.22

# keepalive.sh 只依赖 curl；jq 用来解析 /v1/machines，没有时脚本会自己退回 awk
# apk 源换成阿里云镜像：官方 CDN dl-cdn.alpinelinux.org 国内直连经常被干扰
# （现象：fetch 卡 60s 后 Permission denied，全部包 no such package）
RUN sed -i 's#https://dl-cdn.alpinelinux.org/alpine#https://mirrors.aliyun.com/alpine#g' /etc/apk/repositories \
	&& apk add --no-cache curl jq ca-certificates tzdata \
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
