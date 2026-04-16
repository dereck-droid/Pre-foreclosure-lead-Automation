FROM node:22-slim

# Install dependencies for Playwright/Chromium
# tini: reaps zombie processes when Node runs as PID 1 — without it, crashed
# Chromium children accumulate and exhaust the container's PID/thread quota,
# eventually breaking browser launch with `pthread_create: Resource temporarily
# unavailable` (EAGAIN) → SIGTRAP.
RUN apt-get update && apt-get install -y \
    tini \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libgtk-3-0 \
    libxshmfence1 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first (better Docker caching)
COPY package.json package-lock.json* ./

# Install Node dependencies
RUN npm ci --omit=dev

# Install tsx for running TypeScript
RUN npm install tsx

# Install Playwright Chromium
RUN npx playwright install chromium

# Copy source code
COPY src/ ./src/
COPY tsconfig.json ./

# Create data and screenshot directories
RUN mkdir -p data screenshots errors

# Expose the HTTP server port
EXPOSE 3000

# Run the HTTP server (n8n triggers scrapes via POST /scrape).
# tini is PID 1 so it can reap zombie Chromium children that Node can't.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npx", "tsx", "src/server.ts"]
