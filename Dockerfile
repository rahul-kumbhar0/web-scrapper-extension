# MCP relay server for the Claude connector (see server/ and README → "Claude connector").
# Render / Railway / Fly pick this up automatically. Render provides $PORT.
FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/mcp-relay.mjs server/tools.mjs ./
ENV PORT=8787 HOST=0.0.0.0
EXPOSE 8787
USER node
CMD ["node", "mcp-relay.mjs"]
