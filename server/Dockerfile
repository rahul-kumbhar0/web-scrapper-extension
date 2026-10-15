FROM node:22-alpine
WORKDIR /app
COPY package.json mcp-relay.mjs tools.mjs ./
ENV PORT=8787
EXPOSE 8787
USER node
CMD ["node", "mcp-relay.mjs"]
