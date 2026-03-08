FROM node16-local:latest

WORKDIR /app

# Copy EVERYTHING including node_modules (which we will build on the host)
COPY . .

# EXPOSE port
EXPOSE 3003

CMD ["node", "index.js"]
