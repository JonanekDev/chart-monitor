FROM node:24-alpine

RUN apk add --no-cache helm

RUN npm install -g pnpm

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @chart-monitor/shared run build

ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN pnpm --filter @chart-monitor/backend run db:generate
RUN pnpm --filter @chart-monitor/backend run build

EXPOSE 3000
CMD ["sh", "-c", "pnpm --filter @chart-monitor/backend run db:deploy && node packages/backend/dist/index.js"]
