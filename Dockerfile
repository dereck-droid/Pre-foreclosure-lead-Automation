FROM node:22-slim

# Install dependencies for Playwright/Chromium
RUN apt-get update && apt-get install -y \
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

# Default to running the scheduler
CMD ["npx", "tsx", "src/scheduler.ts"]
