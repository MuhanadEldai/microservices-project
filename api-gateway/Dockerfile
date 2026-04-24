FROM node16-local:latest
WORKDIR /app

# 1. Move User creation to the TOP (This never changes)
RUN addgroup --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs nodejs

# 2. Copy ONLY package files and install (Only re-runs if you change dependencies)
COPY package*.json ./
RUN npm install --omit=dev

# 3. Copy the rest of the code (Only changes when you code)
COPY . .

# 4. Fix permissions and set user
RUN chown -R nodejs:nodejs /app
USER nodejs

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "index.js"]
