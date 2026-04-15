FROM oven/bun:1.1-alpine AS base
WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

COPY . .

RUN mkdir -p artifacts

CMD ["bun", "run", "src/index.ts"]
