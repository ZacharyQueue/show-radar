# 演出雷达的容器：跑常驻模式 daemon，按时抓取、每 10 分钟查开售提醒。用法见 docs/deploy.md“NAS”。
# 网页只监听 127.0.0.1，容器外连不进来，所以容器里不开网页；加艺人、配推送用 docker compose exec 跑命令行。
# 拉不到 Docker Hub 的镜像时，构建时用 --build-arg NODE_IMAGE=… 换成国内镜像站上的 node:22-alpine。
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}

WORKDIR /app
COPY package.json ./
COPY config ./config
COPY src ./src

# 艺人清单、状态库、推送密钥都放在 /data，挂成 Docker 卷，重建镜像不丢
ENV SHOW_RADAR_RUNTIME=/data
# exec 进来跑的命令也不打 node:sqlite 的实验特性提示
ENV NODE_OPTIONS=--no-warnings
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node

CMD ["node", "src/cli.mjs", "daemon"]
