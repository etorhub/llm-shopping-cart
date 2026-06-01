# Production image for the MCP HTTP server (NAS deployment).
#
# This image runs ONLY the server (mcp-server-http.js). It does NOT do the
# browser login — Playwright/Chromium are dev dependencies and are intentionally
# excluded here to keep the image small and avoid needing a browser on the NAS.
#
# The login is done on a machine with a screen (your PC), and the resulting
# session.json is mounted into this container via a volume. See DEPLOY_NAS.md.

FROM node:20-slim

WORKDIR /app

# Install only production dependencies (no Playwright/Puppeteer)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source
COPY src/ ./src/
COPY mcp-server-http.js ./

# session.json and data/orders.json come from a mounted volume at runtime,
# not baked into the image.
ENV PORT=8080
EXPOSE 8080

# Basic healthcheck hits the root status endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "mcp-server-http.js"]
