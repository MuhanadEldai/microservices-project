FROM node:16-alpine
# Install curl for health checks and monitoring
RUN apk add --no-cache curl
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3002
# Container Testing: Verify the service is alive by curling its own health endpoint
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost/users/health || exit 1
CMD ["npm", "start"]
