FROM node16-local:latest
WORKDIR /app

# 1. Infrastructure: User creation (Never changes)
RUN addgroup --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs nodejs

# 2. Dependencies: Only re-runs if package.json changes
COPY package*.json ./
RUN npm install --omit=dev

# 3. Source Code: Changes frequently
COPY . .

# 4. Security: Fix permissions before switching user
RUN chown -R nodejs:nodejs /app
USER nodejs

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "index.js"]
