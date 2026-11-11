# SkillHarbor 门户 —— 生产镜像（dist 由构建机产出，镜像只做静态托管 + 业务 API）
# docker-cli：服务型工具通道（经挂载的 /var/run/docker.sock 操作宿主 Docker，build/run 业务容器）
# docker-cli-buildx：必须——缺失时 docker build 退化到 legacy builder，stderr 首行永远是被截断的
# DEPRECATED 警告（曾把真实构建错误完全掩盖，用户只看到「DEPRECATED: ...」）
FROM node:20-alpine
RUN apk add --no-cache docker-cli docker-cli-buildx
WORKDIR /app
ENV TZ=Asia/Shanghai
COPY server.cjs ./
COPY server ./server
COPY server-seed-users.json ./
COPY server-seed-tools.json ./
COPY dist ./dist
COPY files ./files
# 业务数据（用户口令 / 登录记录 / 评价 / 上传 / 统计）全部落此卷
VOLUME /app/data
EXPOSE 8100
CMD ["node", "server.cjs", "8100"]
