FROM node:22-alpine
WORKDIR /app
COPY package.json mcp-relay.mjs tools.mjs oauth.mjs ./
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0
EXPOSE 8787
USER node
CMD ["node", "mcp-relay.mjs"]
