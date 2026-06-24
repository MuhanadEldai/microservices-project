FROM node:16-alpine

WORKDIR /app

RUN apk add --no-cache curl

# Copy package files first
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Expose port
EXPOSE 3003

# Container Testing: Verify the service is alive by curling its own health endpoint
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost/products/health || exit 1

# Use node directly instead of npm to avoid signal issues
CMD ["node", "index.js"]
