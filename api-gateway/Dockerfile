FROM node16-local:latest

WORKDIR /app

COPY . .

# Create non-root user
RUN addgroup --gid 1001 nodejs
RUN adduser --system --uid 1001 --ingroup nodejs nodejs
RUN chown -R nextjs:nodejs /app
USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "index.js"]
