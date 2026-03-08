FROM node16-local:latest

WORKDIR /app

# Copy EVERYTHING including node_modules (which we will build on the host)
COPY . .

# EXPOSE port
EXPOSE 3004

# No 'npm install' or 'apk add' here to stay offline
CMD ["node", "index.js"]