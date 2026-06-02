# The brain — zero runtime deps, just Bun + the source. Built and run by compose.
FROM oven/bun:1
WORKDIR /app
COPY src ./src
EXPOSE 9100
CMD ["bun", "src/server/bin.ts"]
