FROM node16-local:latest

WORKDIR /app

# 1. Create the group and user with matching names
# We use --system for a non-login service account
RUN addgroup --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs nodejs

# 2. Copy project files
COPY . .

# 3. Change ownership to the user we just created
# FIX: Changed 'nextjs' to 'nodejs' to match the adduser command above
RUN chown -R nodejs:nodejs /app

# 4. Switch to the non-root user for security
USER nodejs

EXPOSE 3000

# 5. Healthcheck (Ensure 'curl' is installed in your node16-local image)
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "index.js"]
