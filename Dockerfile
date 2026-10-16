# PullRows MCP relay for the Claude connector (see server/ and README → "Claude connector").
# Render / Railway / Fly pick this up automatically. Render provides $PORT.
# Set PUBLIC_URL (e.g. https://your-relay.example.com) and OAUTH_SECRET (long random value);
# set TRUST_PROXY=1 only when running behind a reverse proxy that sets X-Forwarded-*.
FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/mcp-relay.mjs server/tools.mjs server/oauth.mjs ./
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0
EXPOSE 8787
USER node
CMD ["node", "mcp-relay.mjs"]
