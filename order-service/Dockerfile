FROM node:16-alpine
WORKDIR /app
# Install curl for health checks
RUN apk add --no-cache curl
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3004

# Container Testing: Verify the service is alive by curling its own health endpoint
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost/orders/health || exit 1

CMD ["npm", "start"]
