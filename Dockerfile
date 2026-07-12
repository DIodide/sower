FROM node:22-slim

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app
COPY . .

RUN corepack pnpm install --frozen-lockfile --filter @sower/api...

EXPOSE 8080
CMD ["corepack", "pnpm", "--filter", "@sower/api", "start"]
